'use strict';

// Phase 3: Auth → RoF.Auth (+ window.Auth 호환)
// v10 (2026-05-10): 인터랙티브 프롤로그 도입 + 계정 ID(user) 와 영웅 이름(heroName) 분리.
//   기존 hero.name = Auth.user 폐기. heroName 은 프롤로그에서 별도 입력.
//   localStorage 키 마이그레이션 = wipe (사용자 결정 — 기존 유저 전부 삭제).
if(localStorage.getItem('rof8_v')!=='10'){
  localStorage.removeItem('rof8');
  localStorage.removeItem('rof8_last_user');
  localStorage.removeItem('rof8_last_pw');
  localStorage.removeItem('rof8_remember');
  // Supabase 세션 토큰도 함께 정리 (다음 로그인 시 새 흐름)
  try {
    for(let i=localStorage.length-1; i>=0; i--){
      const k = localStorage.key(i);
      if(k && k.indexOf('sb-')===0 && /auth-token/.test(k)) localStorage.removeItem(k);
    }
  } catch(e){}
  localStorage.setItem('rof8_v','10');
}

// ============ AUTH ============
RoF.Auth={
  user:null,            // 계정 ID (signup-screen 에서 입력)
  heroName:null,        // 영웅 카드 이름 (프롤로그에서 입력) — save.heroName 으로 영구 저장
  pendingPw:null,
  _selGender:null,_selRole:null,_selElement:'holy',
  _stage:null,          // 'dream' | 'name' | 'gender' | 'role' | 'cardReveal' | 'meetGoddess' | 'final'
  _prologueUid:null,
  _sceneTimers:[],      // _playScenes 가 등록한 setTimeout id 모음 (skip 시 일괄 clear)

  db(){return JSON.parse(localStorage.getItem('rof8')||'{}');},
  save(db){localStorage.setItem('rof8',JSON.stringify(db));},

  // ────────────────────────────────────────────────────────────
  //  SIGNUP / LOGIN
  // ────────────────────────────────────────────────────────────
  signup(){
    const id=document.getElementById('signup-id').value.trim(),
          pw=document.getElementById('signup-pw').value,
          pw2=document.getElementById('signup-pw2').value,
          m=document.getElementById('signup-msg');
    if(id.length<2||id.length>12){m.className='auth-msg error';m.textContent='계정 ID는 2~12자입니다';return;}
    if(pw.length<4){m.className='auth-msg error';m.textContent='암호는 4자 이상입니다';return;}
    if(pw!==pw2){m.className='auth-msg error';m.textContent='암호가 일치하지 않습니다';return;}
    const db=this.db();if(db[id]){m.className='auth-msg error';m.textContent='이미 존재하는 계정입니다';return;}
    this.user=id;this.pendingPw=pw;this.heroName=null;
    if(Backend && Backend.isReady){
      Backend.signupWithNick(id, pw).then(res => {
        if(res.error) console.warn('[Auth] Supabase signup 실패:', res.error);
      });
    }
    this.showPrologue(id);
  },

  login(){
    const id=document.getElementById('login-id').value.trim(),
          pw=document.getElementById('login-pw').value,
          m=document.getElementById('login-msg');
    if(!id||!pw){m.className='auth-msg error';m.textContent='ID와 암호를 입력하세요';return;}
    const db=this.db();
    if(db[id]){
      if(db[id].pw!==pw){m.className='auth-msg error';m.textContent='암호가 틀렸습니다';return;}
      m.className='auth-msg success';m.textContent=`영웅이여, 돌아오셨군요!`;
      localStorage.setItem('rof8_last_user',id);localStorage.setItem('rof8_last_pw',pw);
      this.user=id;
      // heroName 복원 (구 세이브 fallback — heroName 없으면 ID 와 동일하게)
      this.heroName=(db[id].save && db[id].save.heroName) || db[id].heroName || id;
      SFX.init();
      if(Backend && Backend.isReady){
        Backend.loginWithNick(id, pw).then(res => {
          if(res.error){ console.warn('[Auth] Supabase sync 실패:', res.error); return; }
          if(db[id] && db[id].save && Backend.saveProgress)
            Backend.saveProgress(db[id].save).catch(()=>{});
        });
      }
      setTimeout(()=>Game.load(db[id].save),300);
      return;
    }
    if(!(Backend && Backend.isReady)){
      m.className='auth-msg error';m.textContent='그런 ID는 없습니다';return;
    }
    m.className='auth-msg';m.textContent='확인 중...';
    Backend.loginWithNick(id, pw).then(async res => {
      if(res.error){
        m.className='auth-msg error';m.textContent='그런 ID는 없습니다';return;
      }
      const {save, error:loadErr} = await Backend.loadProgress();
      if(loadErr || !save || !Object.keys(save).length){
        m.className='auth-msg error';m.textContent='세이브가 없습니다';return;
      }
      const localDb = this.db();
      localDb[id] = {pw, save, heroName: save.heroName || id};
      this.save(localDb);
      m.className='auth-msg success';m.textContent='영웅이여, 돌아오셨군요!';
      localStorage.setItem('rof8_last_user',id);localStorage.setItem('rof8_last_pw',pw);
      this.user=id;
      this.heroName=save.heroName || id;
      SFX.init();
      setTimeout(()=>Game.load(save),300);
    });
  },

  // ────────────────────────────────────────────────────────────
  //  PROLOGUE — v10 인터랙티브 6 스테이지
  //  dream → name → gender → role → cardReveal → meetGoddess → final
  // ────────────────────────────────────────────────────────────
  showPrologue(uid){
    UI.show('prologue-screen');
    this._prologueUid=uid;
    this._selGender=null;
    this._selRole=null;
    this.heroName=null;
    this._clearSceneTimers();
    this._hideAllStages();
    this._startDream();
  },

  // ── Stage 1: 꿈 도입 시네마틱 (자동 재생) ──
  _startDream(){
    this._stage='dream';
    const scenes=[
      {cut:0, text:'그대는 꿈을 꾼다...',cls:'pl-normal',hold:2200},
      {cut:1, text:'별빛 어딘가에서,\n운명의 여신이\n그대를 부르려 한다.',cls:'pl-normal',hold:2800},
      {cut:1, text:'— 그러나 그녀의 목소리는\n빈 자리를 어루만질 뿐.',cls:'pl-dim',hold:2800},
      {cut:1, text:'여신이 묻는다 —\n"그대는\n무어라 불리길 원하는가?"',cls:'pl-bright',hold:2800},
    ];
    this._playScenes(scenes,()=>this._startName());
  },

  // ── Stage 2: 이름 입력 ──
  _startName(){
    this._stage='name';
    this._hideAllStages();
    document.getElementById('prologue-text').innerHTML='';
    const stage=document.getElementById('prologue-name-form');
    if(stage) stage.style.display='block';
    const input=document.getElementById('prologue-name');
    const msg=document.getElementById('prologue-name-msg');
    if(input){input.value='';setTimeout(()=>input.focus(),120);}
    if(msg) msg.textContent='';
  },

  submitName(){
    const input=document.getElementById('prologue-name');
    const msg=document.getElementById('prologue-name-msg');
    if(!input) return;
    const name=input.value.trim();
    if(name.length<2||name.length>12){
      if(msg) msg.textContent='이름은 2~12자입니다';
      return;
    }
    if(msg) msg.textContent='';
    this.heroName=name;
    SFX.play('magic');
    this._fadeStageOut('prologue-name-form',()=>this._afterNameInterstitial());
  },

  _afterNameInterstitial(){
    const scenes=[
      {cut:2, text:`${this._escape(this.heroName)}이여 —\n여신의 목소리가\n이제는 그대의\n가슴 깊이 새겨진다.`,cls:'pl-gold',hold:2800},
      {cut:2, text:'"그대의 모습을\n보여다오."',cls:'pl-bright',hold:2400},
    ];
    this._playScenes(scenes,()=>this._startGender());
  },

  // ── Stage 3: 성별 선택 ──
  _startGender(){
    this._stage='gender';
    this._hideAllStages();
    document.getElementById('prologue-text').innerHTML='';
    const stage=document.getElementById('prologue-gender');
    if(stage) stage.style.display='block';
  },

  pickGender(gender){
    if(gender!=='m'&&gender!=='f') return;
    this._selGender=gender;
    SFX.play('click');
    this._fadeStageOut('prologue-gender',()=>this._afterGenderInterstitial());
  },

  // 성별 선택 후 → 직업 안내 시네마틱 1컷 → Stage 4 진입
  _afterGenderInterstitial(){
    // 2026-05-17 사용자 명시 "성별 직후 사용자 이름 호명" — heroName 첫줄 추가
    const heroN = this._escape(this.heroName || '');
    const scenes=[
      {cut:3, text:`${heroN}이여 —\n그대의 손에\n깃들 것은\n무엇이겠는가?`,cls:'pl-bright',hold:2800},
    ];
    this._playScenes(scenes,()=>this._startRole());
  },

  // ── Stage 4: 직업 선택 (4번째 버튼 = 성별 되돌리기, 라벨 동적) ──
  _startRole(){
    this._stage='role';
    this._hideAllStages();
    document.getElementById('prologue-text').innerHTML='';
    const stage=document.getElementById('prologue-role');
    if(stage) stage.style.display='block';
    const backBtn=document.getElementById('prologue-role-back');
    if(backBtn){
      const opp=this._selGender==='m'?'여인':'사내';
      backBtn.textContent=`— 잠깐, 나는 ${opp}이다`;
    }
  },

  pickRole(role){
    if(['warrior','ranger','support'].indexOf(role)<0) return;
    this._selRole=role;
    SFX.play('magic');
    this._fadeStageOut('prologue-role',()=>this._startCardReveal());
  },

  backToGender(){
    SFX.play('click');
    this._fadeStageOut('prologue-role',()=>this._startGender());
  },

  // ── Stage 5: 카드 등장 (빛 번쩍 + 영웅 카드 페이드인) ──
  _startCardReveal(){
    this._stage='cardReveal';
    this._hideAllStages();
    document.getElementById('prologue-text').innerHTML='';
    const stage=document.getElementById('prologue-card-reveal');
    if(stage) stage.style.display='block';
    const flash=document.getElementById('prologue-card-flash');
    const wrap=document.getElementById('prologue-card-wrap');
    if(flash) flash.classList.remove('is-flash');
    if(wrap){wrap.classList.remove('is-show');wrap.innerHTML='';}

    const u=RoF.Data.createHero({
      gender:this._selGender,
      role:this._selRole,
      element:'holy',
      skinIndex:0,
    });
    if(u && wrap){
      u.name=this.heroName||u.name;
      const inst=CardV4Component.create(u,{mode:'select'});
      wrap.appendChild(inst.el);
    }

    SFX.play('magic');
    this._activateCut(4, 2200); // 2026-05-17 트랙 5 spec — B-5 빛 응축 컷
    requestAnimationFrame(()=>{
      if(flash) flash.classList.add('is-flash');
      if(wrap) wrap.classList.add('is-show');
    });

    // skip 분기 + _sceneTimers 에 등록 — skip 누르면 즉시 _startMeetGoddess
    this._nextStartFn = ()=>this._startMeetGoddess();
    this._sceneTimers.push(setTimeout(()=>{
      this._nextStartFn = null;
      this._startMeetGoddess();
    },2200));
  },

  // ── Stage 6: 여신 만남 — 카드 그대로 유지 + 카드 바로 아래에 prompt + 선택지 ──
  // 2026-05-10 사용자 결정: 시네마틱 없이 카드 등장 직후 카드 아래 선택지 즉시 노출.
  _startMeetGoddess(){
    this._stage='meetGoddess';
    document.getElementById('prologue-text').innerHTML='';
    const stage=document.getElementById('prologue-meet');
    if(!stage) return;
    stage.style.display='block';
    stage.style.opacity='0';
    requestAnimationFrame(()=>{
      stage.style.transition='opacity .6s ease-out';
      stage.style.opacity='1';
    });
  },

  acceptGoddess(){
    SFX.play('magic');
    this._fadeStageOut('prologue-meet',()=>{
      const cr=document.getElementById('prologue-card-reveal');
      if(cr) cr.style.display='none';
      this._startFinal();
    });
  },

  backToRole(){
    SFX.play('click');
    this._fadeStageOut('prologue-meet',()=>{
      const cr=document.getElementById('prologue-card-reveal');
      if(cr) cr.style.display='none';
      this._startRole();
    });
  },

  // ── Stage 7: 마무리 시네마틱 + "운명을 받아들인다" 버튼 ──
  _startFinal(){
    this._stage='final';
    this._hideAllStages();
    document.getElementById('prologue-text').innerHTML='';
    const heroN=this._escape(this.heroName||this.user||'');
    const scenes=[
      {cut:5, text:'운명의 실이\n그대의 손에\n감긴다.',cls:'pl-gold',hold:2400},
      {cut:5, text:'성스럽고 신비한 힘이\n그대 안에\n깃드는 듯하다.',cls:'pl-normal',hold:2400},
      {cut:5, text:'여신이 한 번 더\n속삭인다 —',cls:'pl-dim',hold:2200},
      {cut:5, text:`"${heroN}이여 —\n많은 영웅들을 만나라.\n신들의 운명을 넘어,\n그대만의\n위대한 여정을 새겨라."`,cls:'pl-bright',hold:4000},
    ];
    this._playScenes(scenes,()=>{
      const btn=document.getElementById('prologue-btns');
      if(!btn) return;
      btn.style.display='';
      btn.style.opacity='0';
      btn.style.transition='opacity .8s';
      requestAnimationFrame(()=>btn.style.opacity='1');
    });
  },

  // ── 시네마틱 텍스트 재생 ──
  // 2026-05-10 v10: skip 분기용 _nextStartFn 추적 — skip 누르면 진행 중인 시네마틱 즉시 끝내고 다음 stage 호출.
  // 2026-05-17 트랙 5 spec — 시안 3 컷 활성화 헬퍼
  _activateCut(idx, durMs){
    document.querySelectorAll('.pl-cut').forEach(c=>c.classList.remove('active'));
    const cut=document.querySelector(`.pl-cut[data-cut="${idx}"]`);
    if(!cut) return;
    cut.style.setProperty('--pl-cut-dur', durMs+'ms');
    void cut.offsetWidth; // 강제 reflow → animation 재시작
    cut.classList.add('active');
  },

  _playScenes(scenes,onDone){
    const ct=document.getElementById('prologue-text');
    if(!ct){ if(onDone) onDone(); return; }
    ct.innerHTML='';
    this._nextStartFn = onDone || null;
    const fadeIn=800,fadeOut=600,gap=200;
    // 2026-05-19: 같은 cut idx 연속 구간을 묶어 첫 scene 에서 누적 duration 한 번만 활성화 →
    //   라인 바뀔 때마다 reflow 로 cut 애니가 0% 부터 다시 시작되던 문제 fix (사용자 명시).
    const cutAt=new Map(); let curCut=null,curStart=-1,curAccum=0;
    scenes.forEach((s,i)=>{
      const sceneDur=fadeIn+s.hold+fadeOut+(i<scenes.length-1?gap:0);
      if(typeof s.cut==='number'){
        if(s.cut!==curCut){
          if(curStart>=0) cutAt.set(curStart,curAccum);
          curCut=s.cut; curStart=i; curAccum=sceneDur;
        }else{
          curAccum+=sceneDur;
        }
      }else{
        if(curStart>=0) cutAt.set(curStart,curAccum);
        curCut=null; curStart=-1; curAccum=0;
      }
    });
    if(curStart>=0) cutAt.set(curStart,curAccum);

    let t=0;
    scenes.forEach((s,i)=>{
      this._sceneTimers.push(setTimeout(()=>{
        if(cutAt.has(i)) this._activateCut(s.cut, cutAt.get(i));
        const el=document.createElement('div');
        el.className=`pl-line ${s.cls||'pl-normal'}`;
        el.innerHTML=s.text.replace(/\n/g,'<br>');
        ct.appendChild(el);
        requestAnimationFrame(()=>el.classList.add('pl-show'));
        this._sceneTimers.push(setTimeout(()=>{el.classList.remove('pl-show');el.classList.add('pl-hide');},fadeIn+s.hold));
        this._sceneTimers.push(setTimeout(()=>el.remove(),fadeIn+s.hold+fadeOut));
      },t));
      t+=fadeIn+s.hold+fadeOut+gap;
    });
    this._sceneTimers.push(setTimeout(()=>{
      this._nextStartFn = null;
      if(onDone) onDone();
    },t));
  },

  _clearSceneTimers(){
    if(!this._sceneTimers) return;
    this._sceneTimers.forEach(id=>clearTimeout(id));
    this._sceneTimers=[];
  },

  // ── 스테이지 가리기 / 페이드아웃 ──
  _hideAllStages(){
    ['prologue-name-form','prologue-gender','prologue-role','prologue-card-reveal','prologue-meet','prologue-btns']
      .forEach(id=>{const e=document.getElementById(id);if(e){e.style.display='none';e.style.opacity='';}});
  },

  _fadeStageOut(id,cb){
    const el=document.getElementById(id);
    if(!el){ cb && cb(); return; }
    el.style.transition='opacity .35s';
    el.style.opacity='0';
    setTimeout(()=>{
      el.style.display='none';
      el.style.opacity='';
      el.style.transition='';
      if(cb) cb();
    },360);
  },

  _escape(s){
    if(typeof s!=='string') return '';
    return s.replace(/[&<>"']/g, ch => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[ch]));
  },

  // ────────────────────────────────────────────────────────────
  //  SKIP / END / CONFIRM HERO
  // ────────────────────────────────────────────────────────────
  // 2026-05-10 v10: skip = 한 단계만 건너뛰기 (사용자 결정).
  //   ① 시네마틱 진행 중 → 즉시 끝나고 다음 stage 진입 (꿈→이름, 인터스티셜→성별/무기, 카드등장→여신만남)
  //   ② final 시네마틱 진행 중 OR 끝난 후 → confirmHero (마을 진입)
  //   ③ 인터랙션 단계 (name/gender/role/meetGoddess) → 무효 (사용자가 입력/선택해야)
  skipPrologue(){
    // ② final stage — 시네마틱 진행 중이든 끝났든 마을 진입
    if(this._stage==='final'){
      this._clearSceneTimers();
      this._nextStartFn=null;
      SFX.play('magic');
      this.confirmHero();
      return;
    }
    // ① 시네마틱 진행 중 — 다음 stage 진입 함수 즉시 호출
    if(typeof this._nextStartFn==='function'){
      this._clearSceneTimers();
      const ct=document.getElementById('prologue-text');
      if(ct) ct.innerHTML='';
      const fn=this._nextStartFn;
      this._nextStartFn=null;
      fn();
      return;
    }
    // ③ 인터랙션 단계 — 보조 (이름 입력창 focus 정도)
    if(this._stage==='name'){
      const inp=document.getElementById('prologue-name');
      if(inp) inp.focus();
    }
    // 그 외 인터랙션 (gender/role/meetGoddess) 은 효과 없음 — 사용자가 버튼으로 진행
  },

  endPrologue(){
    SFX.play('magic');
    this.confirmHero();
  },

  confirmHero(){
    if(!this._selRole) this._selRole='warrior';
    if(!this._selGender) this._selGender='m';
    if(!this._selElement) this._selElement='holy';
    if(!this.heroName) this.heroName=this.user;
    SFX.init();
    const heroBase=RoF.Data.createHero({
      gender:this._selGender,
      role:this._selRole,
      element:this._selElement,
    });
    const hero=Object.assign(heroBase,{
      uid:uid(),name:this.heroName,heroClass:heroBase.name,isHero:true,
      level:1,equips:[],maxHp:heroBase.hp,xp:0,honor:0,freePoints:0,
      growthPts:{atk:0,hp:0,def:0,spd:0,nrg:0,luck:0,eva:0},
    });
    const sv={
      round:0,hp:3,maxHp:3,gold:20,xp:0,level:1,honor:0,
      deck:[hero],relics:[],
      hero:{gender:hero.gender,role:hero._heroRole,element:hero.element,skinIndex:hero.skinIndex},
      heroName:this.heroName,
      bestRound:0,totalWins:0,totalGames:0,leaguePoints:0,
      buildings:{},tutStep:99,companionName:'',
    };
    const db=this.db();
    db[this.user]={pw:this.pendingPw,save:sv,heroName:this.heroName};
    this.save(db);
    this.pendingPw=null;
    Game.load(sv);
  },

  // ────────────────────────────────────────────────────────────
  //  LEGACY 호환 (test_run.js / 옛 튜토리얼 트리거 / dev navigator)
  //  옛 char-element-screen / char-hero-screen 6 카드 grid 흐름은
  //  2026-05-10 prologue v10 으로 흡수되어 폐기.
  //  옛 함수들은 새 prologue 로 redirect.
  // ────────────────────────────────────────────────────────────
  showCharSel(uid){ this.showPrologue(uid); },
  charBack(){ this.backToPrologue(); },
  backToPrologue(){ UI.show('prologue-screen'); },
  backToElement(){ this._startGender(); },
  _showElementScreen(){ this._startGender(); },
  _showHeroScreen(){ this._startGender(); },
  _showStep1(){ this._startGender(); },
  _showStep2(){ this._startRole(); },
  _showCreateScreen(){ this._startGender(); },
  confirmElement(){ this._startRole(); },
  confirmCreate(){ return this.confirmHero(); },
  confirmChar(){ return this.confirmHero(); },
  _renderGenderToggle(){ /* 폐기 — char-hero-screen 의 옛 토글 */ },
};

// 호환성 레이어
window.Auth = RoF.Auth;
