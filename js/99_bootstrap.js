'use strict';

// 99_bootstrap.js — 초기화 통합 (Phase 5 / Section 06, updated Section 07)
//
// 원래 index.html 에 분산되어 있던 초기화 코드를 한 파일로 통합:
//   - 자동 로그인 복원 (rof8_last_user, rof8_last_pw)
//   - 볼륨 복원 (rof8_vol → SFX.vol, UI)
//   - UI.show 몽키패칭 (title-screen 진입 시 FX.initTitle)
//   - 초기 FX 시작 setTimeout
//   - Sanity check: 모든 핵심 모듈 로드 검증
//   - 세로 뷰포트 래핑 + 스케일 (PHASE2_PORTRAIT_VIEWPORT_PLAN)
//
// 참고: Enter 키 바인딩 → 99_bindings.js 의 data-action-enter 로 이관됨
//
// 이 파일은 반드시 defer 체인의 **마지막**에 로드되어야 한다.

// ═══════════════════════════════════════════════════════════════
// 세로 뷰포트 통일 — Marvel Snap 방식 (2026-04-12 Phase 2)
// index.html 수정 없이 body 직계 자식을 .game-root 로 런타임 래핑.
// 이후 창 크기 변화에 따라 균등 스케일 적용.
// ═══════════════════════════════════════════════════════════════
(function viewportBoot(){
  // 2026-04-12: 가로 1280×720 (HD 16:9) 로 전환. 세로 390×844 폐기.
  // 맵(848×1264)은 세로로 유지 → 좌측에 배치, 우측은 사이드 패널용 여백.
  const BASE_W = 1280;
  const BASE_H = 720;

  function wrapGameRoot(){
    if (document.querySelector('.game-root')) return;
    document.body.classList.add('game-mode');  // CSS 활성화 트리거
    const root = document.createElement('div');
    root.className = 'game-root';
    // body 의 모든 자식을 root 로 이동 (script 노드 포함 — 이미 실행됨)
    while (document.body.firstChild) {
      root.appendChild(document.body.firstChild);
    }
    document.body.appendChild(root);

    // 2026-04-27: 타이틀 배경 영상은 game-root 의 transform:scale 영향 받지 않게
    // body 직계로 끌어올림. 100vw/100vh fixed cover 로 letterbox 영역까지 채움.
    const titleVideo = root.querySelector('#title-bg-video');
    if (titleVideo) document.body.insertBefore(titleVideo, root);

    // 2026-05-02: title-fire 그라디언트도 body 직계로 끌어올림 — game-root 안에 있으면
    //   transform:scale 영향 받아 ultra-wide letterbox 영역(좌우)에 그라디언트 안 그려지고
    //   game-root 영역만 어두운 띠 → 우측 경계선처럼 보임. fixed + 100vw 로 letterbox 까지 cover.
    const titleFire = root.querySelector('.title-fire');
    if (titleFire) document.body.insertBefore(titleFire, root);
  }

  function fitViewport(){
    const root = document.querySelector('.game-root');
    if (!root) return;
    const sx = window.innerWidth  / BASE_W;
    const sy = window.innerHeight / BASE_H;
    const scale = Math.min(sx, sy);
    root.style.transform = 'scale(' + scale + ')';
    // 2026-05-17 — scale 값 외부 노출 (lunge 등 getBoundingClientRect 기반 px 계산 시 보정용)
    window.__rofRootScale = scale;
  }

  // DOM 이 파싱되면 즉시 래핑 (DOMContentLoaded 보다 이른 시점 권장이나
  // defer 순서상 여기서 실행돼도 충분히 이름)
  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', () => {
      wrapGameRoot();
      fitViewport();
    });
  } else {
    wrapGameRoot();
    fitViewport();
  }

  window.addEventListener('resize', fitViewport);
  window.addEventListener('orientationchange', fitViewport);

  // 외부 노출 (디버깅/수동 재계산용)
  window.__rofFitViewport = fitViewport;
})();

document.addEventListener('DOMContentLoaded', () => {
  // Enter 키 바인딩 → 99_bindings.js 의 data-action-enter 로 이관됨

  // ── 0. Backend 초기화 (S1: Supabase, 실패해도 로컬 폴백) ──
  // 자동 로그인 정책 (2026-04-27 완전 폐기, 사용자 결정):
  //   - **매번 로그인 화면**. opt-in 플래그(rof8_remember)도 폐기.
  //   - 부팅 시 Supabase 잔존 세션이 있으면 즉시 signOut (어차피 사용 안 함, refresh-token 자동 재로그인 방지).
  //   - login() 호출 시에만 Supabase signIn → 세션 발급 → 게임 진입. onAuthChange 자동 진입 로직 폐기.
  if(typeof Backend !== 'undefined' && Backend.init){
    Backend.init().then(() => {
      if(!Backend.isReady) return;
      // 부팅 직후 잔존 세션 청소 — Supabase refresh token 으로 인한 자동 재로그인 차단.
      if(Backend.logoutAuth){
        Backend.logoutAuth().catch(()=>{});
      }
      // localStorage 잔존 remember 플래그 정리 (이전 버전 흔적).
      try { localStorage.removeItem('rof8_remember'); } catch(e){}
    }).catch(()=>{});
  }

  // ── 1. 마지막 로그인 정보 자동 입력 (Supabase 자동 로그인 실패 시 폴백) ──
  const u = localStorage.getItem('rof8_last_user');
  const p = localStorage.getItem('rof8_last_pw');
  if (u) {
    const el = document.getElementById('login-id');
    if (el) el.value = u;
  }
  if (p) {
    const el = document.getElementById('login-pw');
    if (el) el.value = p;
  }

  // ── 1.5. NPC seen 플래그 일괄 정리 (2026-04-24, 영구 1회성) ──
  // NPC 다이얼로그가 매 진입 시 선택지 메뉴로 재설계되면서 seen 플래그 시스템 자체 폐기.
  // localStorage / sessionStorage 양쪽의 누적 키 정리.
  try {
    for (let i = localStorage.length - 1; i >= 0; i--) {
      const k = localStorage.key(i);
      if (k && k.indexOf('rof8_npc_seen_') === 0) localStorage.removeItem(k);
    }
    for (let i = sessionStorage.length - 1; i >= 0; i--) {
      const k = sessionStorage.key(i);
      if (k && k.indexOf('rof8_npc_seen_') === 0) sessionStorage.removeItem(k);
    }
  } catch (e) {}

  // ── 2. 볼륨 복원 ──
  const sv = localStorage.getItem('rof8_vol');
  if (sv != null) {
    const v = parseInt(sv, 10);
    if (Number.isFinite(v) && v >= 0 && v <= 100) {
      const slider = document.getElementById('vol-slider');
      const display = document.getElementById('vol-display');
      const toggle = document.getElementById('sound-toggle');
      if (slider) slider.value = v;
      if (display) display.textContent = v;
      RoF.SFX.vol = v / 100;
      if (toggle) toggle.textContent = v === 0 ? '🔇' : v < 30 ? '🔉' : '🔊';
    }
  }

  // ── 2.5. mute 상태 복원 (localStorage rof8_user_muted) ──
  // toggle() 로 사용자가 끈 음소거가 화면 전환·트랙 전환에도 유지되도록 영구 보존.
  if (localStorage.getItem('rof8_user_muted') === '1') {
    RoF.SFX.on = false;
    const toggle = document.getElementById('sound-toggle');
    if (toggle) toggle.textContent = '🔇';
  }

  // ── 3. UI.show 몽키패칭 (title-screen 진입 시 FX.initTitle) ──
  const _origShow = RoF.UI.show;
  RoF.UI.show = function(id) {
    _origShow.call(this, id);
    if (id === 'title-screen') setTimeout(() => RoF.FX.initTitle(), 200);
    else RoF.FX.destroy();
  };

  // ── 3.5. 타이틀 배경 랜덤 (angel/demon) — 페이지 로드 1회만 ──
  (function randomizeTitleBg(){
    const ts = document.getElementById('title-screen');
    if(!ts) return;
    // test 환경(?mute=1 + webdriver/iframe)이 아닌 경우만 랜덤. 테스트 결정론 유지.
    const isTest = navigator.webdriver || window !== window.top;
    if(isTest){ ts.classList.add('bg-angel'); return; }
    ts.classList.add(Math.random() < 0.5 ? 'bg-angel' : 'bg-demon');
  })();

  // ── 4. 초기 FX 시작 ──
  setTimeout(() => RoF.FX.initTitle(), 500);

  // ── 4.5 편집기 라이브 프리뷰: ?autonav=X (또는 ?preview=X) 시 화면 자동 이동 ──
  (function setupPreviewMode(){
    const qs = new URLSearchParams(location.search);
    const preview = qs.get('autonav') || qs.get('preview');
    if(!preview) return;
    setTimeout(() => {
      try {
        const UNITS = RoF.Data.UNITS || [];
        const hero = RoF.Data.createHero({gender:'m', role:'warrior', element:'holy'});
        if(!hero){ console.warn('[preview] createHero failed'); return; }
        // PHASE 3 폐기 필드 (maxHp/growthPts) 제거 (2026-05-16 P0 #5)
        const mk = (base, uid, name) => ({
          ...base, uid, name,
          level:1, equips:[], xp:0, honor:0, freePoints:0,
        });
        const heroInst = { ...mk(hero, '_h', '미리보기'), isHero:true, heroClass:hero.name };
        const comps = [];
        ['herbalist','guard','militia','archer','apprentice','berserker']
          .forEach((id,i) => {
            const b = UNITS.find(u => u.id === id) || UNITS[i+3];
            if(b) comps.push(mk(b, '_c'+i, '동료'+(i+1)));
          });
        const sv = {
          round:0, hp:3, maxHp:3, gold:500, xp:0, level:1, honor:10,
          deck:[heroInst, ...comps], relics:[], hero:{gender:hero.gender,role:hero._heroRole,element:hero.element,skinIndex:hero.skinIndex},
          bestRound:0, totalWins:0, totalGames:0, leaguePoints:0,
          buildings:{castle:1,gate:1,forge:1,shop:1,tavern:1,training:1,library:1,church:1},
          tutStep:99, companionName:'동료1'
        };
        RoF.Auth.user = '_preview_';
        RoF.Auth.pendingPw = null;
        RoF.Game.load(sv);
        const navs = {
          title:       () => RoF.UI.show('title-screen'),
          login:       () => RoF.UI.show('login-screen'),
          signup:      () => RoF.UI.show('signup-screen'),
          prologue:    () => {
            // 에디터 미리보기: 시네마틱 스킵, 버튼만 즉시 표시
            RoF.UI.show('prologue-screen');
            const txt = document.getElementById('prologue-text');
            if(txt) txt.innerHTML = '<div class="pl-line pl-gold pl-show">에디터 미리보기 — 프롤로그 텍스트</div>';
            const btns = document.getElementById('prologue-btns');
            if(btns){ btns.style.display = ''; btns.style.opacity = '1'; }
          },
          // 2026-04-13: char-select 분리 → element + hero (Cockpit 시도 후 롤백 2026-04-21)
          'char-element':() => {
            RoF.Auth._prologueUid = RoF.Auth._prologueUid || RoF.Auth.user || '_preview';
            RoF.Auth._selElement = null; RoF.Auth._selRole = null;
            if(RoF.Auth._showElementScreen) RoF.Auth._showElementScreen();
          },
          'char-hero': () => {
            RoF.Auth._prologueUid = RoF.Auth._prologueUid || RoF.Auth.user || '_preview';
            if(!RoF.Auth._selElement) RoF.Auth._selElement = 'fire';
            if(RoF.Auth._showHeroScreen) RoF.Auth._showHeroScreen();
          },
          // Legacy aliases
          charselect:  () => {
            RoF.Auth._prologueUid = RoF.Auth._prologueUid || RoF.Auth.user || '_preview';
            if(RoF.Auth._showElementScreen) RoF.Auth._showElementScreen();
          },
          'char-select':()=> {
            RoF.Auth._prologueUid = RoF.Auth._prologueUid || RoF.Auth.user || '_preview';
            if(RoF.Auth._showElementScreen) RoF.Auth._showElementScreen();
          },
          menu:        () => RoF.Game.showMenu && RoF.Game.showMenu(),
          tavern:      () => RoF.Game.showTavern && RoF.Game.showTavern(),
          deckview:    () => RoF.Game.showDeckView && RoF.Game.showDeckView(),
          castle:      () => RoF.Game.showCastle && RoF.Game.showCastle(),
          church:      () => RoF.Game.showChurch && RoF.Game.showChurch(),
          forge:       () => RoF.Game.showForge && RoF.Game.showForge(),
          shop:        () => RoF.Game.showShop && RoF.Game.showShop(),
          training:    () => RoF.Game.showTraining && RoF.Game.showTraining(),
          cardselect:  () => RoF.Game._startBattleInner && RoF.Game._startBattleInner(),
          reward:      () => {
            RoF.UI.show('reward-screen');
            const t=document.getElementById('rew-title'); if(t){t.textContent='✨ 승리!';t.className='reward-title victory';}
            const s=document.getElementById('rew-sub'); if(s)s.textContent='리그 점수 +12';
            const st=document.getElementById('rew-stats'); if(st)st.innerHTML='💰 +50 골드<br>⭐ +3 경험치';
          },
          formation:   () => RoF.Formation && RoF.Formation.show ? RoF.Formation.show() : RoF.UI.show('formation-screen'),
          pick:        () => {
            RoF.UI.show('pick-screen');
            const title=document.getElementById('pick-title'); if(title)title.textContent='🃏 동료 선택 (이번 전투)';
            const sub=document.getElementById('pick-sub'); if(sub)sub.textContent='중복 시 합성하여 등급 상승!';
            const grid=document.getElementById('pick-grid');
            if(grid && !grid.children.length && typeof mkCardElV4==='function'){
              const UNITS=RoF.Data.UNITS||[];
              for(let i=0;i<3;i++){
                const u=UNITS.filter(x=>!x.id.startsWith('h_'))[i];
                if(u) grid.appendChild(mkCardElV4({...u,uid:'_p'+i}));
              }
            }
          },
          choice:      () => {
            RoF.UI.show('choice-screen');
            const t=document.getElementById('ch-title'); if(t)t.textContent='라운드 3 선택';
            const s=document.getElementById('ch-sub'); if(s)s.textContent='다음 행동을 고르시오';
            const o=document.getElementById('ch-options');
            if(o && !o.children.length){
              ['🃏 동료 추가','⚡ 비전 획득','🏺 유물 획득'].forEach(label=>{
                const d=document.createElement('div'); d.className='choice-box';
                d.innerHTML=`<div class="cb-icon">${label.split(' ')[0]}</div><div class="cb-title">${label.substring(2)}</div>`;
                o.appendChild(d);
              });
            }
          },
          upgrade:     () => RoF.UI.show('upgrade-screen'),
          gameover:    () => {
            RoF.UI.show('gameover-screen');
            const st=document.getElementById('final-stats');
            if(st)st.innerHTML='라운드 12 도달<br>승리 8회 · 패배 1회<br>최종 골드 234 · 명예 56';
          },
          match:       () => {
            RoF.UI.show('match-screen');
            if(RoF.Game.showMatchmaking) RoF.Game.showMatchmaking();
          },
          // 2026-05-10: 매치 화면(#tcg-screen) 직접 진입 + placeholder 카드 (위치 픽커 용)
          tcg:         () => {
            RoF.UI.show('tcg-screen');
            if(document.getElementById('_ph_card')) return;

            // 1. 손패 슬롯 visible (빨간 dashed)
            document.querySelectorAll('#tcg-hand .tcg-hand-card').forEach((el, i) => {
              el.style.border = '2px dashed rgba(255,80,80,.55)';
              el.style.background = 'rgba(255,80,80,.08)';
              el.style.display = 'flex';
              el.style.alignItems = 'center';
              el.style.justifyContent = 'center';
              el.style.color = '#ff8888';
              el.style.fontSize = '.7rem';
              el.style.fontWeight = '700';
              el.textContent = '손패' + (i + 1);
            });

            // 2. 보드 row visible (파란 dashed) — 정적 markup 에 cell 없으면 5개 추가
            ['tcg-e-board', 'tcg-p-board'].forEach((id) => {
              const row = document.getElementById(id);
              if (!row) return;
              if (!row.children.length) {
                for (let i = 0; i < 5; i++) {
                  const cell = document.createElement('div');
                  cell.style.cssText = 'width:140px;height:200px;border:2px dashed rgba(80,150,255,.55);background:rgba(80,150,255,.08);display:flex;align-items:center;justify-content:center;color:#aac8ff;font-size:.78rem;font-weight:700;border-radius:6px;';
                  cell.textContent = (id === 'tcg-e-board' ? '적' : '아군') + ' 보드' + (i + 1);
                  row.appendChild(cell);
                }
              }
            });

            // 3. 적 손패 영역 visible (회색 dashed)
            const oppHand = document.getElementById('tcg-opp-hand');
            if (oppHand) {
              oppHand.style.border = '2px dashed rgba(180,180,180,.55)';
              oppHand.style.background = 'rgba(180,180,180,.08)';
              oppHand.style.minHeight = '80px';
              if (!oppHand.children.length) oppHand.textContent = '적 손패 (장식)';
            }

            // 4. 카드 확대 placeholder (드래그) — 손패 호버 크기 447×624
            const ph = document.createElement('div');
            ph.id = '_ph_card';
            ph.style.cssText = 'position:fixed;left:200px;top:50px;width:447px;height:624px;background:linear-gradient(135deg,rgba(255,200,100,.3),rgba(255,150,50,.2));border:3px dashed #ffcc44;border-radius:12px;display:flex;align-items:center;justify-content:center;color:#ffcc44;font-weight:700;font-size:1.4rem;cursor:move;z-index:9999;text-shadow:0 0 4px #000;user-select:none;';
            ph.innerHTML = '카드 확대<br>447×624<br><small style="font-size:.85rem;">드래그하세요</small>';
            document.body.appendChild(ph);

            // 5. 영혼력 placeholder (드래그 + 리사이즈) — 보라 dashed
            const soul = document.createElement('div');
            soul.id = '_ph_soul';
            soul.style.cssText = 'position:fixed;left:60px;top:80%;width:140px;height:160px;background:linear-gradient(135deg,rgba(168,108,255,.3),rgba(80,40,150,.25));border:3px dashed #c8a8ff;border-radius:14px;display:flex;flex-direction:column;align-items:center;justify-content:center;color:#c8a8ff;font-weight:700;font-size:1rem;cursor:move;z-index:9998;text-shadow:0 0 4px #000;user-select:none;resize:both;overflow:hidden;';
            soul.innerHTML = '<div style="font-size:1.5rem;">💜 영혼력</div><div id="_soul_size" style="font-size:.78rem;margin-top:6px;">140×160</div><div style="font-size:.7rem;color:#aaa;margin-top:8px;">드래그 / 우하단 리사이즈</div>';
            document.body.appendChild(soul);

            // 6. 좌표 표시 panel
            const panel = document.createElement('div');
            panel.id = '_ph_panel';
            panel.style.cssText = 'position:fixed;top:8px;right:8px;background:rgba(20,20,32,.92);border:1px solid #5a4820;border-radius:6px;padding:10px 14px;z-index:10000;font-family:Consolas,monospace;font-size:.85rem;color:#7aff7a;line-height:1.6;pointer-events:none;min-width:240px;';
            panel.innerHTML = '<b style="color:#e6b85a;">카드 확대 (주황)</b><br>left: <span id="_phx">200</span>px / top: <span id="_phy">50</span>px<br>w: 447 × h: 624<br><br><b style="color:#c8a8ff;">영혼력 (보라)</b><br>left: <span id="_sx">60</span>px / top: <span id="_sy">576</span>px<br>w: <span id="_sw">140</span> × h: <span id="_sh">160</span><br><br><b style="color:#ffd700;">viewport</b><br><span id="_vw"></span>×<span id="_vh"></span>';
            document.body.appendChild(panel);
            const setText = (id, v) => { const el = document.getElementById(id); if (el) el.textContent = v; };
            setText('_vw', window.innerWidth);
            setText('_vh', window.innerHeight);

            // 7. 드래그 처리 (양쪽)
            const makeDraggable = (el, prefix) => {
              let dragging=false, dx=0, dy=0;
              el.addEventListener('mousedown', (e) => {
                // 우하단 리사이즈 영역은 무시 (16x16 corner)
                const rect = el.getBoundingClientRect();
                if (e.clientX > rect.right - 16 && e.clientY > rect.bottom - 16) return;
                dragging = true;
                dx = e.clientX - rect.left;
                dy = e.clientY - rect.top;
                el.style.cursor = 'grabbing';
                e.preventDefault();
              });
              document.addEventListener('mousemove', (e) => {
                if (!dragging) return;
                const x = e.clientX - dx;
                const y = e.clientY - dy;
                el.style.left = x + 'px';
                el.style.top = y + 'px';
                setText(prefix + 'x', Math.round(x));
                setText(prefix + 'y', Math.round(y));
              });
              document.addEventListener('mouseup', () => {
                if (dragging) {
                  dragging = false;
                  el.style.cursor = 'move';
                }
              });
            };
            makeDraggable(ph, '_ph');
            makeDraggable(soul, '_s');

            // 8. 영혼력 리사이즈 추적
            const ro = new ResizeObserver(entries => {
              for (const e of entries) {
                setText('_sw', Math.round(e.contentRect.width));
                setText('_sh', Math.round(e.contentRect.height));
                const sz = document.getElementById('_soul_size');
                if (sz) sz.textContent = Math.round(e.contentRect.width) + '×' + Math.round(e.contentRect.height);
              }
            });
            ro.observe(soul);
          },
        };
        const fn = navs[preview] || navs.menu;
        fn();
        console.log('[preview] navigated to', preview);
      } catch(e) {
        console.error('[preview] failed:', e);
      }
    }, 400);
  })();

  // ── 4.5. ?preview=screenId 쿼리 지원 (편집기 iframe 용 자동 네비게이션) ──
  // 사용: index.html?preview=cardselect → 테스트 유저 자동 생성/로그인 + 해당 화면 이동
  const previewMatch = location.search.match(/[?&]preview=(\w[-\w]*)/);
  if (previewMatch) {
    const targetScreen = previewMatch[1] + '-screen';
    setTimeout(() => {
      try {
        // 테스트 유저 (이미 존재하면 로그인)
        const TEST_USER = '__preview__';
        const TEST_PW = 'preview';
        const db = RoF.Auth.db();
        if (!db[TEST_USER]) {
          // 회원가입 플로우 우회 — 직접 저장 데이터 생성
          const u = RoF.Data.createHero({gender:'m', role:'warrior', element:'holy'});
          // PHASE 3 폐기 필드 (maxHp/growthPts) 제거 (2026-05-16 P0 #5)
          const hero = Object.assign(u, {uid: Date.now(), name: TEST_USER, heroClass: u.name, isHero: true, level: 1, equips: [], xp: 0, honor: 0, freePoints: 0});
          const comp = RoF.Data.UNITS.find(x => x.id === 'herbalist') || RoF.Data.UNITS[1];
          const companion = {...comp, uid: Date.now()+1, name: '릴리아', isCompanion: true, level: 1, equips: [], xp: 0, honor: 0, freePoints: 0};
          const titanBase = RoF.Data.UNITS.find(x => x.id === 'titan');
          const titan = {...titanBase, uid: Date.now()+2, isCompanion: true, isTitan: true, level: 1, equips: [], xp: 0, honor: 0, freePoints: 0};
          const sv = {round: 0, hp: 3, maxHp: 3, gold: 100, xp: 0, level: 1, honor: 0, deck: [hero, companion, titan], relics: [], hero: {gender:hero.gender,role:hero._heroRole,element:hero.element,skinIndex:hero.skinIndex}, bestRound: 0, totalWins: 0, totalGames: 0, leaguePoints: 0, buildings: {castle: 2, gate: 1, forge: 1, shop: 1, tavern: 1, training: 1, library: 1, church: 1}, tutStep: 99, companionName: '릴리아'};
          db[TEST_USER] = {pw: TEST_PW, save: sv};
          RoF.Auth.save(db);
        }
        RoF.Auth.user = TEST_USER;
        RoF.Game.load(db[TEST_USER].save);
        // 화면 이동
        if (document.getElementById(targetScreen)) {
          RoF.UI.show(targetScreen);
          // cardselect 는 Game.showCardSelect 호출 필요
          if (targetScreen === 'cardselect-screen' && RoF.Game.renderCardSelect) {
            RoF.Game.renderCardSelect();
          }
        }
        // 편집기 iframe 내부 감지용 플래그
        document.body.setAttribute('data-preview-mode', previewMatch[1]);
      } catch(e) {
        console.error('[preview] fail:', e);
      }
    }, 300);
  }

  // ── 4a. 주요 결정 버튼 자동 배너화 (2026-04-12 FATES 레퍼런스) ──
  //   index.html 수정 금지 규칙 하에서, 특정 ID 의 버튼에 `.btn-banner` 클래스를 동적 부착.
  try {
    const BANNER_IDS = ['cs-go-btn', 'pick-confirm-btn'];
    BANNER_IDS.forEach(id => {
      const el = document.getElementById(id);
      if (el) el.classList.add('btn-banner');
    });
  } catch (e) { console.warn('[banner-btn] setup error:', e); }

  // ── 4b. 에디터 iframe 전용 자동 네비게이션 (?autonav=SCREEN) ──
  //   편집기(tools/screen_editor_zones.html)가 iframe 으로 게임을 임베드할 때
  //   URL 파라미터로 특정 화면까지 자동 진입. 테스트 유저 생성 + 프롤로그 스킵.
  try {
    const params = new URLSearchParams(location.search);
    const autonav = params.get('autonav');
    if (autonav) {
      document.body.setAttribute('data-autonav', autonav);
      setTimeout(() => {
        try {
          // 테스트 유저 자동 생성/로그인
          const TEST_ID = '__editor__';
          const TEST_PW = '__editor__';
          const db = RoF.Auth.db();
          if (!db[TEST_ID]) {
            // 임시 유저 생성 — 덱 2개 (영웅 + 동료), 골드 충분
            const heroBase = RoF.Data.createHero({gender:'m', role:'warrior', element:'holy'});
            // PHASE 3 폐기 필드 (maxHp/growthPts) 제거 (2026-05-16 P0 #5)
            const hero = Object.assign(heroBase, {
              uid: 'editor_hero', name: TEST_ID, heroClass: heroBase.name, isHero: true,
              level: 1, equips: [], xp: 0, honor: 0, freePoints: 0
            });
            const comp = Object.assign({}, RoF.Data.UNITS.find(x => x.id === 'militia') || RoF.Data.UNITS[1], {
              uid: 'editor_comp', name: '에디터', isCompanion: true, level: 1, equips: [],
              xp: 0, honor: 0, freePoints: 0
            });
            const titanBase2 = RoF.Data.UNITS.find(x => x.id === 'titan');
            const titan2 = Object.assign({}, titanBase2, {
              uid: 'editor_titan', isCompanion: true, isTitan: true, level: 1, equips: [],
              xp: 0, honor: 0, freePoints: 0
            });
            db[TEST_ID] = {
              pw: TEST_PW,
              save: {
                round: 0, hp: 3, maxHp: 3, gold: 999, xp: 0, level: 1, honor: 0,
                deck: [hero, comp, titan2], relics: [], hero: {gender:hero.gender, role:hero._heroRole, element:hero.element, skinIndex:hero.skinIndex},
                bestRound: 0, totalWins: 0, totalGames: 0, leaguePoints: 0,
                buildings: {castle:1, gate:1, forge:1, shop:1, tavern:1, training:1, library:1, church:1},
                tutStep: 99, companionName: '에디터'
              }
            };
            RoF.Auth.save(db);
          }
          RoF.Auth.user = TEST_ID;
          RoF.Game.load(db[TEST_ID].save);
          // 화면 매핑 — 각 화면별 진입 동작
          const nav = {
            'title':      () => RoF.UI.show('title-screen'),
            'login':      () => RoF.UI.show('login-screen'),
            'signup':     () => RoF.UI.show('signup-screen'),
            'prologue':   () => RoF.UI.show('prologue-screen'),
            'char-element': () => {
              RoF.Auth._prologueUid = RoF.Auth._prologueUid || TEST_ID;
              RoF.Auth._selElement = null; RoF.Auth._selRole = null;
              RoF.Auth._showElementScreen && RoF.Auth._showElementScreen();
            },
            'char-hero': () => {
              RoF.Auth._prologueUid = RoF.Auth._prologueUid || TEST_ID;
              RoF.Auth._selElement = RoF.Auth._selElement || 'fire';
              RoF.Auth._showHeroScreen && RoF.Auth._showHeroScreen();
            },
            'charselect': () => {
              // Legacy alias → 기본 element 화면
              RoF.Auth._prologueUid = RoF.Auth._prologueUid || TEST_ID;
              RoF.Auth._selElement = null; RoF.Auth._selRole = null;
              RoF.Auth._showElementScreen && RoF.Auth._showElementScreen();
            },
            'menu':       () => RoF.Game.showMenu(),
            'tavern':     () => RoF.Game.showTavern(),
            'deckview':   () => RoF.Game.showDeckView(),
            'castle':     () => RoF.Game.showCastle(),
            'church':     () => RoF.Game.showChurch(),
            'forge':      () => RoF.Game.showForge && RoF.Game.showForge(),
            'shop':       () => RoF.Game.showShop && RoF.Game.showShop(),
            'training':   () => RoF.Game.showTraining && RoF.Game.showTraining(),
            'cardselect': () => { RoF.Game.showMenu(); setTimeout(() => RoF.Game.startBattle && RoF.Game.startBattle(), 50); },
            'formation':  () => { RoF.Game.showMenu(); setTimeout(() => RoF.Game.startBattle && RoF.Game.startBattle(), 50); },
            'reward':     () => RoF.UI.show('reward-screen'),
            'upgrade':    () => RoF.UI.show('upgrade-screen'),
          };
          const fn = nav[autonav];
          if (fn) fn();
          else console.warn('[autonav] unknown screen:', autonav);
          console.log('[autonav] navigated to', autonav);
        } catch (e) {
          console.error('[autonav] error:', e);
        }
      }, 300);
    }
  } catch (e) { console.error('[autonav] setup error:', e); }

  // ── 5. Sanity check: 모든 핵심 모듈이 로드되었는지 검증 ──
  // (2026-05-07) RoF.TurnBattle 폐기 (PHASE 6 통합 — RoF.Match 가 신엔진).
  // (2026-05-27) #battle-screen 컨테이너 + #btn-fight/#btn-back trash 완료.
  const EXPECTED = [
    'RoF.Data.UNITS', 'RoF.Data.SKILLS', 'RoF.Data.RELICS',
    'RoF.SFX', 'RoF.UI', 'RoF.Auth', 'RoF.Game',
    'RoF.Match', 'RoF.Formation', 'RoF.FX',
  ];
  const missing = EXPECTED.filter(path =>
    !path.split('.').reduce((o, k) => (o == null ? undefined : o[k]), window)
  );
  if (missing.length > 0) {
    console.error('[RoF] 로드 누락:', missing);
  } else if (RoF.__gameKeyError) {
    console.error('[RoF] Game 객체 중복 키 감지됨 — 콘솔 위 로그 확인');
  } else {
    console.log('[RoF] 모든 모듈 로드 완료 (Game keys:', Object.keys(RoF.Game).length + ')');
  }
});

// ═══════════════════════════════════════════════════════════════
// Text overrides — zone 편집기 "📝 텍스트" 필드가 저장한 값을 DOM 에 적용
// index.html 을 수정하지 않고 런타임에 textContent 를 덮어씀.
// 저장 파일: css/text_overrides.json  ({ "selector": "새 텍스트" })
// ═══════════════════════════════════════════════════════════════
(function textOverridesBoot(){
  let overrides = {};
  function apply(){
    for (const sel in overrides) {
      try {
        const nodes = document.querySelectorAll(sel);
        const text = overrides[sel];
        nodes.forEach(el => { if (el.textContent !== text) el.textContent = text; });
      } catch (e) { /* 잘못된 셀렉터 무시 */ }
    }
  }
  window.applyTextOverrides = apply;

  function load(){
    fetch('css/text_overrides.json?_=' + Date.now(), { cache: 'no-store' })
      .then(r => r.ok ? r.json() : {})
      .then(m => { overrides = m || {}; apply(); })
      .catch(() => {});
  }
  window.reloadTextOverrides = load;
  load();

  // UI.show 훅 — 화면 전환 후 새로 렌더된 요소에도 덮어쓰기
  let hookAttempts = 0;
  (function tryHook(){
    if (window.RoF && RoF.UI && RoF.UI.show && !RoF.UI._textOverrideHooked) {
      const orig = RoF.UI.show.bind(RoF.UI);
      RoF.UI.show = function(){ const r = orig.apply(this, arguments); setTimeout(apply, 30); return r; };
      RoF.UI._textOverrideHooked = true;
      return;
    }
    if (++hookAttempts < 50) setTimeout(tryHook, 100);
  })();
})();

// ═══════════════════════════════════════════════════════════════
// Runtime DOM tagging — index.html 을 수정하지 않고 요소에 class 를 부여
// 편집기가 안정적 셀렉터로 잡을 수 있게 하기 위함.
// ═══════════════════════════════════════════════════════════════
(function runtimeTagBoot(){
  function apply(){
    // title 화면의 "LEAGUE OF THE GODS" 장식 div 에 .title-league 부여
    const title = document.getElementById('title-screen');
    if (title) {
      title.querySelectorAll('div').forEach(d => {
        if (d.classList.contains('title-league')) return;
        const t = (d.textContent || '').trim();
        if (t === 'LEAGUE OF THE GODS') d.classList.add('title-league');
      });
    }
  }
  apply();
  document.addEventListener('DOMContentLoaded', apply);
  setTimeout(apply, 300);
  window.applyRuntimeTags = apply;
})();

// ═══════════════════════════════════════════════════════════════
// Hidden elements — zone 편집기 🗑️ 숨김 토글이 저장한 셀렉터를 display:none 처리
// 저장 파일: css/hidden_elements.json  (배열 of selector)
// ═══════════════════════════════════════════════════════════════
(function hiddenElementsBoot(){
  let hiddenList = [];
  const STYLE_ID = 'rof-hidden-elements-style';
  function apply(){
    let styleEl = document.getElementById(STYLE_ID);
    if (!styleEl) {
      styleEl = document.createElement('style');
      styleEl.id = STYLE_ID;
      document.head.appendChild(styleEl);
    }
    const rules = hiddenList
      .filter(sel => typeof sel === 'string' && sel.trim())
      .map(sel => `${sel}{display:none !important;}`)
      .join('\n');
    styleEl.textContent = rules;
  }
  window.applyHiddenElements = apply;

  function load(){
    fetch('css/hidden_elements.json?_=' + Date.now(), { cache: 'no-store' })
      .then(r => r.ok ? r.json() : [])
      .then(arr => { hiddenList = Array.isArray(arr) ? arr : []; apply(); })
      .catch(() => {});
  }
  window.reloadHiddenElements = load;
  load();
})();
