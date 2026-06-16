// 70_formation_v6.js — 2026-05-09 PHASE 6 v2 재설계.
// 옛 PHASE 3 진형 배치 (5 슬롯 가로 + 대기석) 폐기 → 좌측 세로 슬롯 5칸 + 우측 메인.
// 데이터: state = { hero, companions:[u1..u4], equipped:{<uid>:[<skId>...]} }
// A: markup 정적 띄우기 (완료)
// B (현재): state 모델 + 슬롯 선택 + 영웅 portrait 매핑
// C/D: 교체 모달 / 스킬 모달
// E~G: 출전 검증 / Match.start / 옛 deckview 폐기 / 회귀

RoF.Formation = {
  _selectedSlot: 0,
  _zoomedSkillId: null,  // 시그니처 스킬 카드 click 확대 toggle
  _activeLoaded: false,  // localStorage 한 번만 load

  // Step 2-1 (2026-05-18): active 0~5 / 10 자유 토글 — 04-balance.md "덱 빌딩 룰 v3"
  MAX_ACTIVE: 5,
  ACTIVE_LS_KEY: 'rof_formation_active_v3',

  // Step 2-2 (2026-05-18): PickerModal 시안 정합 — 원소/등급 필터 + 페이지네이션 + 즉시 swap
  PICKER_PAGE_SIZE: 12,
  _replaceFilter: 'all',           // 등급 필터
  _replaceElementFilter: 'all',    // 원소 필터 (Step 2-2 신규)
  _replacePage: 0,                 // 페이지네이션 (Step 2-2 신규)
  _replacePicked: null,

  // Step 2-4 (2026-05-18): 그룹 저장/불러오기 — 시안 formation_v2.jsx:93~99 정합
  GROUPS_LS_KEY: 'rof_formation_groups_v3',
  _groupsLoaded: false,
  _loadMenuOpen: false,
  _groupName: '리그 도전명단 1',
  _groups: [],

  state: {
    hero: null,
    companions: [null, null, null, null],
    equipped: {},
    // Step 2-1: 캐릭터별 active map — { [character.uid]: [skillId, ...] (0~5장) }
    active: {},
  },

  show(){
    UI.show('formation-screen');
    // 2026-05-18 Step 1 — iframe 폐기 + 시안 외곽 vanilla 마이그레이션 정본.
    // 데이터/카드 그림은 옛 거 (state + mkCardElV4) 그대로. 외곽 markup/css 만 시안 정합.
    this._ensureState();
    this._render();
  },
  showForBattle(/* battleDeck */){ this.show(); },

  // ───── State 초기화 ─────
  _ensureState(){
    // 영웅 — 한 번만 생성 (캐싱)
    if(!this.state.hero){
      let hero = null;
      const userHeroMeta = (RoF.Game && RoF.Game.hero) || null;
      const heroOpts = userHeroMeta || {gender:'m', role:'warrior', element:'fire', skinIndex:0};
      if(RoF.Data && RoF.Data.createHero){
        try { hero = RoF.Data.createHero(heroOpts); } catch(e){ console.warn('[formation] createHero fail', e); }
      }
      if(hero){
        hero.uid = 'hero_' + hero.skinKey;
        hero.bundledSkillIds = hero.bundledSkillIds || [];
      }
      this.state.hero = hero;
    }

    // 동료 — 매 진입마다 deck 동기화. 이미 배치된 카드는 유지, 사라진 카드는 제거, 빈 슬롯에 미배치 동료 자동 채우기.
    const deck = (RoF.Game && RoF.Game.deck) || [];
    const isLocked = (RoF.Match && RoF.Match.api && RoF.Match.api.isLockedUnit) || (() => false);
    const ownedUnits = deck.filter(c =>
      c && c.kind === 'unit' && !c.isHero && !isLocked(c)
    );
    const ownedUidSet = new Set(ownedUnits.map(c => c.uid));
    // 1) 사라진 카드(deck 에서 제거됨) 슬롯에서 정리
    for(let i = 0; i < 4; i++){
      if(this.state.companions[i] && !ownedUidSet.has(this.state.companions[i].uid)){
        this.state.companions[i] = null;
      }
    }
    // 2) 미배치 동료를 빈 슬롯에 자동 채움
    const placedUids = new Set(this.state.companions.filter(Boolean).map(c => c.uid));
    const unplaced = ownedUnits.filter(c => !placedUids.has(c.uid));
    let unplacedIdx = 0;
    /* diagnosis-confirmed: 2026-06-13 사유: feature — 동료 영웅레벨 게이팅 (갤러리 C안 컨펌). 잠긴 슬롯(해금 N 초과)엔 자동채움 안 함. */
    const _unlockedFill = (RoF.Game && RoF.Game.getUnlockedCompanionCount) ? RoF.Game.getUnlockedCompanionCount() : 4;
    for(let i = 0; i < _unlockedFill; i++){
      if(!this.state.companions[i] && unplacedIdx < unplaced.length){
        this.state.companions[i] = unplaced[unplacedIdx++];
      }
    }

    // Step 2-1: localStorage 한 번만 load → 사용자 토글 보존
    if(!this._activeLoaded){
      this._loadActive();
      this._activeLoaded = true;
    }
    // 영웅 + 동료마다 default active 채움 (이미 결정된 캐릭터는 skip → 사용자 토글 우선)
    if(this.state.hero) this._ensureActiveDefault(this.state.hero);
    for(let i = 0; i < 4; i++){
      const c = this.state.companions[i];
      if(c) this._ensureActiveDefault(c);
    }
  },

  // ───── Step 2-1: active map 헬퍼 (2026-05-18) ─────
  // default: 풀 중 처음 5장 자동 활성 (옛 행동 보존 + 초보 친화). 변경하려면 slice(0, X) 수정.
  /* diagnosis-confirmed: 2026-06-08 사유: feature — 스킬 progressive unlock (카드레벨 미달 시 잠금, 사용자 "게임적용" 지시) */
  _charByUid(uid){
    if(this.state.hero && this.state.hero.uid === uid) return this.state.hero;
    return (this.state.companions || []).find(c => c && c.uid === uid) || null;
  },

  _ensureActiveDefault(character){
    if(!character || !character.uid) return;
    if(this.state.active[character.uid]) return;  // 이미 결정됨 (사용자 토글 보존)
    const SKILLS = (RoF.Data && RoF.Data.SKILLS) || [];
    // 카드레벨 해금된 스킬만 default 활성 (잠긴 스킬 제외)
    const pool = (character.bundledSkillIds || []).filter(id => {
      const s = SKILLS.find(x => x.id === id);
      return s && !RoF.isSkillLocked(s, character);
    });
    this.state.active[character.uid] = pool.slice(0, this.MAX_ACTIVE);
  },

  _isActive(charUid, skillId){
    const arr = this.state.active[charUid];
    return !!(arr && arr.indexOf(skillId) !== -1);
  },

  toggleActive(charUid, skillId){
    if(!charUid || !skillId) return;
    // 잠긴 스킬(카드레벨 미달)은 토글 불가
    const SKILLS = (RoF.Data && RoF.Data.SKILLS) || [];
    const sk = SKILLS.find(x => x.id === skillId);
    const character = this._charByUid(charUid);
    if(sk && character && RoF.isSkillLocked(sk, character)){
      console.log('[formation] 잠긴 스킬 — 토글 불가', skillId);
      return;
    }
    if(!this.state.active[charUid]) this.state.active[charUid] = [];
    const arr = this.state.active[charUid];
    const idx = arr.indexOf(skillId);
    if(idx !== -1){
      arr.splice(idx, 1);  // 비활성화
    } else {
      if(arr.length >= this.MAX_ACTIVE){
        // 최대 도달 — 안내 (toast 등은 추후 wire). 일단 log + silent skip.
        console.log('[formation] active 최대 ' + this.MAX_ACTIVE + '장 도달');
        return;
      }
      arr.push(skillId);  // 활성화
    }
    this._persistActive();
    this._renderSpellPool();
    this._renderMiddle();  // EXP 패널 / 능력치 grid 영향 없지만 향후 active 카운터 표시 시 대비
  },

  // 해금 연출 등 오버레이에서 호출 — DOM 재렌더 없이 active 추가/제거. 전열정비 화면 밖에서도 안전.
  // returns {ok, full?, locked?}. on=true 추가 / on=false 제거.
  /* diagnosis-confirmed: 2026-06-08 사유: feature — 스킬 해금 연출 "＋ 전열 편성" 토글 연동 (사용자 컨펌) */
  addActiveSkill(charUid, skillId, on){
    if(!charUid || !skillId) return {ok:false};
    if(!this._activeLoaded){ this._loadActive(); this._activeLoaded = true; }
    const SKILLS = (RoF.Data && RoF.Data.SKILLS) || [];
    const sk = SKILLS.find(x => x.id === skillId);
    const character = this._charByUid(charUid);
    if(sk && character && RoF.isSkillLocked(sk, character)) return {ok:false, locked:true};
    if(!this.state.active[charUid]) this.state.active[charUid] = [];
    const arr = this.state.active[charUid];
    const idx = arr.indexOf(skillId);
    if(on === false){
      if(idx !== -1) arr.splice(idx, 1);
    } else {
      if(idx === -1){
        if(arr.length >= this.MAX_ACTIVE) return {ok:false, full:true};
        arr.push(skillId);
      }
    }
    this._persistActive();
    return {ok:true};
  },

  _persistActive(){
    try { localStorage.setItem(this.ACTIVE_LS_KEY, JSON.stringify(this.state.active)); }
    catch(e){ console.warn('[formation] active persist fail', e); }
  },

  _loadActive(){
    try {
      const raw = localStorage.getItem(this.ACTIVE_LS_KEY);
      if(!raw) return;
      const parsed = JSON.parse(raw);
      if(parsed && typeof parsed === 'object' && !Array.isArray(parsed)){
        this.state.active = parsed;
      }
    } catch(e){ console.warn('[formation] active load fail', e); }
  },

  _slot(idx){
    return idx === 0 ? this.state.hero : this.state.companions[idx - 1];
  },

  _equippedSkills(character){
    if(!character) return [];
    const SKILLS = (RoF.Data && RoF.Data.SKILLS) || [];
    const ids = this.state.equipped[character.uid] || character.bundledSkillIds || [];
    return ids.map(id => SKILLS.find(s => s.id === id)).filter(Boolean);
  },

  _portraitSrc(character){
    if(!character) return '';
    // v2 (2026-05-27) — CARD_IMG 평면 dict 가 모두 helper 호출 결과로 갱신됨.
    if(character.kind === 'hero' || character._isHero){
      if(character.skinKey) return RoF.Data.CARD_IMG[character.skinKey] || '';
    }
    return RoF.Data.CARD_IMG[character.id] || RoF.Data.unitImg(character.id) || '';
  },

  // ───── 렌더 (2026-05-18 시안 외곽 정합) ─────
  _render(){
    this._renderTopBar();
    this._renderPartyRow();
    this._renderMiddle();
    this._renderSpellPool();
  },

  _renderTopBar(){
    // Step 2-4 (2026-05-18): 그룹 저장/불러오기 wire — 시안 formation_v2.jsx:447~512 정합
    if(!this._groupsLoaded){
      this._loadGroups();
      this._groupsLoaded = true;
    }
    // 그룹 이름 input
    const inp = document.getElementById('form-group-name');
    if(inp){
      if(!inp._wired){
        inp._wired = true;
        inp.value = this._groupName;
        inp.addEventListener('input', (e) => { this._groupName = e.target.value; });
      }
    }
    // 저장 버튼
    const saveBtn = document.getElementById('form-group-save-btn');
    if(saveBtn && !saveBtn._wired){
      saveBtn._wired = true;
      saveBtn.onclick = () => this.saveGroup();
    }
    // 불러오기 버튼 (그룹 카운트 표시)
    const loadBtn = document.getElementById('form-load-btn');
    if(loadBtn){
      loadBtn.textContent = `📂 불러오기 (${this._groups.length})▾`;
      if(!loadBtn._wired){
        loadBtn._wired = true;
        loadBtn.onclick = (e) => {
          e.stopPropagation();
          this.toggleLoadMenu();
        };
      }
    }
    // dropdown 외부 클릭 → 닫기
    if(!this._docClickWired){
      this._docClickWired = true;
      document.addEventListener('click', (e) => {
        if(this._loadMenuOpen && !e.target.closest('.form-load-wrap')){
          this._loadMenuOpen = false;
          this._renderLoadMenu();
        }
      });
    }
    this._renderLoadMenu();
  },

  // Step 2-4: 그룹 dropdown 렌더 (시안 line 476~498)
  _renderLoadMenu(){
    const menu = document.getElementById('form-load-menu');
    if(!menu) return;
    menu.style.display = this._loadMenuOpen ? 'block' : 'none';
    if(!this._loadMenuOpen) return;
    if(this._groups.length === 0){
      menu.innerHTML = `<div class="form-load-empty">저장된 그룹이 없습니다.<br>이름을 입력하고 💾 저장 버튼을 눌러주세요.</div>`;
      return;
    }
    menu.innerHTML = this._groups.map((g, idx) =>
      `<div class="form-load-item">` +
        `<button class="form-load-item-name" data-action="formation.loadGroup" data-arg="${g.id}">📂 ${this._escape(g.name)}</button>` +
        `<button class="form-load-item-del" data-action="formation.deleteGroup" data-arg="${g.id}">✕</button>` +
      `</div>`
    ).join('');
  },

  _escape(s){
    if(!s) return '';
    const d = document.createElement('div'); d.textContent = s; return d.innerHTML;
  },

  toggleLoadMenu(){
    this._loadMenuOpen = !this._loadMenuOpen;
    this._renderLoadMenu();
  },

  // Step 2-4: 그룹 저장 (시안 onSaveGroup)
  saveGroup(){
    if(!this._groupName || !this._groupName.trim()){
      this._showToast && this._showToast('그룹 이름을 입력하세요.');
      return;
    }
    const name = this._groupName.trim();
    // compIds = 영입 동료 4명의 uid (영웅 제외)
    const compIds = this.state.companions.filter(Boolean).map(c => c.uid);
    const newGroup = {
      id: 'g' + Date.now(),
      name: name,
      compIds: compIds,
      active: JSON.parse(JSON.stringify(this.state.active)),  // deep clone
    };
    // 같은 이름 덮어쓰기 (시안 패턴)
    this._groups = this._groups.filter(g => g.name !== name);
    this._groups.push(newGroup);
    this._persistGroups();
    this._showToast && this._showToast(`그룹 "${name}" 저장 완료`);
    this._renderTopBar();
  },

  // Step 2-4: 그룹 불러오기 (시안 onLoadGroup)
  loadGroup(groupId){
    const g = this._groups.find(x => x.id === groupId);
    if(!g) return;
    this._groupName = g.name;
    // companions slot 복원 (uid → state.companions)
    const deck = (RoF.Game && RoF.Game.deck) || [];
    const newCompanions = [null, null, null, null];
    (g.compIds || []).forEach((uid, idx) => {
      if(idx >= 4) return;
      const c = deck.find(x => x && x.uid === uid);
      if(c) newCompanions[idx] = c;
    });
    this.state.companions = newCompanions;
    this.state.active = g.active || {};
    this._loadMenuOpen = false;
    const inp = document.getElementById('form-group-name');
    if(inp) inp.value = this._groupName;
    this._persistActive();
    this._render();
    this._showToast && this._showToast(`그룹 "${g.name}" 불러오기 완료`);
  },

  // Step 2-4: 그룹 삭제 (시안 onDeleteGroup)
  deleteGroup(groupId){
    this._groups = this._groups.filter(g => g.id !== groupId);
    this._persistGroups();
    this._renderTopBar();
  },

  _persistGroups(){
    try { localStorage.setItem(this.GROUPS_LS_KEY, JSON.stringify(this._groups)); }
    catch(e){ console.warn('[formation] groups persist fail', e); }
  },

  _loadGroups(){
    try {
      const raw = localStorage.getItem(this.GROUPS_LS_KEY);
      if(!raw) return;
      const parsed = JSON.parse(raw);
      if(Array.isArray(parsed)) this._groups = parsed;
    } catch(e){ console.warn('[formation] groups load fail', e); }
  },

  _renderPartyRow(){
    const row = document.getElementById('form-party-row');
    const lbl = document.getElementById('form-party-label');
    if(!row) return;
    const placedCount = this.state.companions.filter(Boolean).length;
    if(lbl) lbl.textContent = `파티 · 영웅 1 + 동료 ${placedCount} / 4`;

    row.innerHTML = '';
    /* diagnosis-confirmed: 2026-06-13 사유: feature — 동료 영입 영웅레벨 게이팅 잠금 슬롯 렌더 (갤러리 C안 컨펌 "c로 하자"). 버그수정 아님. */
    const _unlockedComp = (RoF.Game && RoF.Game.getUnlockedCompanionCount) ? RoF.Game.getUnlockedCompanionCount() : 4;
    for(let idx = 0; idx < 5; idx++){
      const slot = this._slot(idx);
      const isSel = idx === this._selectedSlot;
      const isHero = idx === 0;
      const isEmpty = !slot;
      const isLocked = !isHero && idx > _unlockedComp;  // 동료 슬롯(idx 1~4) 중 해금 N 초과 → 잠김
      const div = document.createElement('div');
      div.setAttribute('data-slot-idx', idx);

      if(isLocked){
        // 잠금 슬롯 — 골드 자물쇠 + 해금 진행도 게이지 (mockup/companion_lock C안). 클릭 시 toast (배치 차단).
        const tbl = (RoF.Game && RoF.Game.COMPANION_UNLOCK) || [];
        const reqEntry = tbl.find(t => t.n === idx);
        const reqLv = reqEntry ? reqEntry.lv : (idx * 3);
        const curLv = (RoF.Game && RoF.Game.getHeroLevel) ? RoF.Game.getHeroLevel() : 1;
        const pct = Math.max(0, Math.min(100, Math.round(curLv / reqLv * 100)));
        div.className = 'form-party-slot is-locked';
        div.innerHTML =
          `<div class="form-lock-ico">🔒</div>` +
          `<div class="form-lock-req">동료 ${idx} 해금</div>` +
          `<div class="form-lock-prog"><i style="width:${pct}%"></i></div>` +
          `<div class="form-lock-lv">영웅 Lv ${curLv} / ${reqLv}</div>`;
        div.onclick = () => {
          this._showToast && this._showToast(`동료 ${idx} 은(는) 영웅 Lv ${reqLv} 부터 출전할 수 있습니다. (현재 Lv ${curLv})`);
        };
        row.appendChild(div);
        continue;
      }

      div.className = 'form-party-slot' +
        (isSel ? ' is-selected' : '') +
        (isEmpty ? ' is-empty' : '') +
        (isHero ? ' is-hero' : '');

      if(isEmpty){
        div.innerHTML =
          `<div class="form-party-portrait-empty">+</div>` +
          `<div class="form-party-role">동료 추가</div>`;
      } else {
        const portraitSrc = this._portraitSrc(slot);
        const rarityClass = 'rar-' + (slot.rarity || 'bronze');
        const role = isHero ? '⚔ 영웅' : `동료 ${idx}`;
        div.innerHTML =
          `<div class="form-party-portrait ${rarityClass}" style="background-image:url('${portraitSrc}');">` +
            `<div class="form-party-rarity-stripe"></div>` +
          `</div>` +
          `<div class="form-party-role${isHero?' is-hero-role':''}">${role}</div>` +
          /* diagnosis-confirmed: 2026-06-08 사유: feature — 전열정비 파티 카드 영구레벨 인라인 배지 (C안, 사용자 컨펌) */
          `<div class="form-party-name">${slot.name || slot.id}<span class="form-party-lv">· Lv ${slot.level || 1}</span></div>`;
      }
      div.onclick = () => {
        this._selectedSlot = idx;
        if(isEmpty && idx !== 0){
          this._render();
          this.openReplace();
          return;
        }
        this._render();
      };
      row.appendChild(div);
    }
  },

  _renderMiddle(){
    const previewEl = document.getElementById('form-card-preview');
    const previewLbl = document.getElementById('form-card-preview-label');
    const statsEl = document.getElementById('form-stats-grid');
    const expEl = document.getElementById('form-exp-bar');
    const tagsEl = document.getElementById('form-tags-row');
    const replaceBtn = document.getElementById('form-replace-btn');
    if(!previewEl || !statsEl) return;

    const sel = this._slot(this._selectedSlot);
    const isHero = this._selectedSlot === 0;

    // 라벨
    if(previewLbl) previewLbl.textContent = isHero ? '⚔ 영웅 카드' : `동료 ${this._selectedSlot} 카드`;

    // 카드 미리보기 (mkCardElV4 — 시안 BC.UnitCard 사용 X)
    previewEl.innerHTML = '';
    if(sel && typeof mkCardElV4 === 'function'){
      const card = mkCardElV4(sel);
      previewEl.appendChild(card);
      // 블로커 fix #1 (2026-05-18 storyboard-inspector): 카드 클릭 시 zoom 모달 (시안 line 580)
      previewEl.style.cursor = 'zoom-in';
      previewEl.onclick = () => this.zoomCard('unit', sel);
    } else if(!sel){
      previewEl.innerHTML = `<div class="form-card-preview-empty">슬롯이 비어있습니다</div>`;
      previewEl.style.cursor = '';
      previewEl.onclick = null;
    }

    // 능력치 4-col grid (HP / ATK / SOUL / LV)
    const HP   = sel ? (sel.HP ?? sel.hp ?? 0) : 0;
    const ATK  = sel ? (sel.ATK ?? sel.atk ?? 0) : 0;
    const SOUL = sel ? (sel.SOUL ?? sel.cost ?? 0) : 0;
    const LV   = sel ? (sel.level ?? 1) : 1;
    statsEl.innerHTML =
      `<div class="form-stat"><div class="form-stat-label">HP</div><div class="form-stat-value stat-hp">♥ ${HP}</div></div>` +
      `<div class="form-stat"><div class="form-stat-label">ATK</div><div class="form-stat-value stat-atk">⚔ ${ATK}</div></div>` +
      `<div class="form-stat"><div class="form-stat-label">SOUL</div><div class="form-stat-value stat-soul">✦ ${SOUL}</div></div>` +
      `<div class="form-stat"><div class="form-stat-label">LV</div><div class="form-stat-value stat-lv">★ ${LV}</div></div>`;

    // EXP 바
    if(expEl){
      const xpForLevel = (lv) => lv === 1 ? 10 : lv === 2 ? 25 : 50;
      const xpCur = sel ? (sel.xp ?? 0) : 0;
      const xpMax = xpForLevel(LV);
      const pct = Math.min(100, Math.round((xpCur / xpMax) * 100));
      const maxed = LV >= 3 && xpCur >= xpMax;
      expEl.innerHTML =
        `<div class="form-exp-header">` +
          `<span class="form-exp-label">EXP · LV ${LV}${maxed ? ' · MAX' : ` → ${LV+1}`}</span>` +
          `<span class="form-exp-value">${xpCur} <span class="dim">/</span> ${xpMax}</span>` +
        `</div>` +
        `<div class="form-exp-track">` +
          `<div class="form-exp-fill${maxed?' is-maxed':''}" style="width:calc(${pct}% - 2px);"></div>` +
          `<div class="form-exp-tick" style="left:25%;"></div>` +
          `<div class="form-exp-tick" style="left:50%;"></div>` +
          `<div class="form-exp-tick" style="left:75%;"></div>` +
        `</div>`;
    }

    // 원소/역할/등급
    if(tagsEl){
      const elementMap = {fire:'🔥 화염',water:'💧 물',lightning:'⚡ 전기',earth:'🌿 땅',holy:'✨ 신성',light:'✨ 신성',dark:'🌑 암흑'};
      const roleMap = {warrior:'근접',ranger:'원거리',support:'지원',attack:'공격',defense:'방어',melee:'근접',ranged:'원거리',mage:'마법',guardian:'수호'};
      const rarityMap = {bronze:'일반',silver:'희귀',gold:'고귀한',legendary:'전설의',divine:'신',common:'일반',rare:'희귀',epic:'영웅',mythic:'신화'};
      const elV = sel ? (elementMap[sel.element] || sel.element || '—') : '—';
      const roleSrc = isHero ? (sel?._heroRole || sel?.role) : sel?.role;
      const roleV = sel ? (roleMap[roleSrc] || roleSrc || '—') : '—';
      const rarV = sel ? (rarityMap[sel.rarity] || sel.rarity || '—') : '—';
      tagsEl.innerHTML =
        `<div class="form-tag-cell"><div class="form-tag-label">원소</div><div class="form-tag-value">${elV}</div></div>` +
        `<div class="form-tag-cell"><div class="form-tag-label">역할</div><div class="form-tag-value">${roleV}</div></div>` +
        `<div class="form-tag-cell"><div class="form-tag-label">등급</div><div class="form-tag-value">${rarV}</div></div>`;
    }

    // 동료 교체 버튼 (영웅 슬롯 0 일 때 숨김)
    if(replaceBtn){
      replaceBtn.style.display = (isHero || !sel) ? 'none' : '';
    }
  },

  _renderSpellPool(){
    const grid = document.getElementById('form-spell-pool-grid');
    const cntEl = document.getElementById('form-active-count');
    if(!grid) return;
    // 잠긴 슬롯 상세 — 바깥 클릭 시 닫기 (한 번만 바인드)
    if(!this._lockDetailCloserBound){
      document.addEventListener('click', () => {
        const g = document.getElementById('form-spell-pool-grid');
        if(g) g.querySelectorAll('.form-spell-slot.show-detail').forEach(x => x.classList.remove('show-detail'));
      });
      this._lockDetailCloserBound = true;
    }
    const sel = this._slot(this._selectedSlot);
    const skills = this._equippedSkills(sel);  // 풀 전체 (5~10장)
    const charUid = sel && sel.uid;
    const activeArr = charUid ? (this.state.active[charUid] || []) : [];

    // Step 2-1: 활성 카운터 (0~5 가변) — 04-balance.md "active 0~5 / 10 자유 토글"
    if(cntEl) cntEl.textContent = `활성 ${activeArr.length} / ${this.MAX_ACTIVE}장`;

    // 10 슬롯 4×3 grid (시안 정합). 풀 5~10장 채우고 부족분 placeholder.
    grid.innerHTML = '';
    for(let i = 0; i < 10; i++){
      const wrap = document.createElement('div');
      wrap.className = 'form-spell-slot';
      // 마지막 row (idx 8, 9) 는 col 1, 2 명시 (시안 정합)
      if(i === 8) wrap.style.gridColumn = '1 / 2';
      if(i === 9) wrap.style.gridColumn = '2 / 3';
      if(i < skills.length){
        const s = skills[i];
        const locked = RoF.isSkillLocked(s, sel);
        if(locked){
          // ── 잠긴 슬롯 (카드레벨 미달) — 회색조 카드 + 자물쇠 + 클릭 상세 ──
          const ul = RoF.skillUnlockLevel(s);
          const curLv = (sel && sel.level) || 1;
          const need = ul - curLv;
          const cleanName = (s.name || '').replace(/\s*\([^)]*\)/, '');
          const dmgKo = {melee:'근접', ranged:'원거리', magic:'마법'}[s.dmgType] || '';
          const stats = [`✦${s.NEED_SOUL}`];
          if(s.ATK) stats.push(`⚔${s.ATK}`);
          if(s.HP)  stats.push(`❤${s.HP}`);
          const charName = (sel && sel.name) || '이 동료';
          wrap.classList.add('is-locked');
          wrap.innerHTML =
            `<div class="form-spell-card"></div>` +
            `<div class="form-spell-lock"><div class="lock-icon">🔒</div><div class="lock-label">Lv ${ul} 해금</div><div class="lock-hint">눌러서 자세히</div></div>` +
            `<div class="form-spell-lock-detail">` +
              `<div class="ld-title">🔒 아직 익히지 못한 기술</div>` +
              `<div class="ld-skill">${cleanName}</div>` +
              `<div class="ld-stats">${stats.join(' ')}${dmgKo ? ` <span class="dt">· ${dmgKo}</span>` : ''}</div>` +
              `<div class="ld-ability">${s.ability || ''}</div>` +
              `<div class="ld-div"></div>` +
              `<div class="ld-cond">${charName}이(가) <b>카드레벨 ${ul}</b>에 이르면 익힌다.</div>` +
              `<div class="ld-prog">현재 카드레벨 ${curLv} · ${need}레벨 더 필요</div>` +
              `<div class="ld-hint">단련하여 더 성장하라</div>` +
              `<div class="ld-close">다시 누르면 닫힘</div>` +
            `</div>` +
            `<div class="form-spell-toggle is-locked-tog">🔒 Lv ${ul}</div>`;
          const cardEl = wrap.querySelector('.form-spell-card');
          if(cardEl && typeof mkCardElV4 === 'function') cardEl.appendChild(mkCardElV4(s));
          wrap.style.cursor = 'pointer';
          wrap.addEventListener('click', (e) => {
            e.stopPropagation();
            const wasOpen = wrap.classList.contains('show-detail');
            grid.querySelectorAll('.form-spell-slot.show-detail').forEach(x => x.classList.remove('show-detail'));
            if(!wasOpen) wrap.classList.add('show-detail');
          });
        } else {
          const isAct = this._isActive(charUid, s.id);
          const blocked = !isAct && activeArr.length >= this.MAX_ACTIVE;  // 5장 도달 + 비활성 = 추가 불가
          wrap.classList.add(isAct ? 'is-active' : 'is-inactive');
          if(blocked) wrap.classList.add('is-blocked');
          // SWAP / ZOOM 버튼 (Step 2-2/2-3 picker 연결)
          wrap.innerHTML =
            `<button class="form-spell-btn form-spell-zoom" data-action="formation.zoomSkill" data-arg="${s.id}" title="확대해서 보기">🔍</button>` +
            `<button class="form-spell-btn form-spell-swap" data-action="formation.openSkill" title="이 슬롯의 스킬 교체">🔄</button>` +
            `<div class="form-spell-card"></div>` +
            `<div class="form-spell-toggle${isAct?' is-active':''}" data-skill-id="${s.id}">${isAct?'✓ 활성':'비활성'}</div>`;
          const cardEl = wrap.querySelector('.form-spell-card');
          if(cardEl && typeof mkCardElV4 === 'function'){
            cardEl.appendChild(mkCardElV4(s));
          }
          // Step 2-1: 라벨만 클릭으로 토글 (사용자 결정 2026-05-18 — 시안의 카드 자체 클릭 토글은 미채택)
          const togEl = wrap.querySelector('.form-spell-toggle');
          if(togEl){
            togEl.style.cursor = blocked ? 'not-allowed' : 'pointer';
            togEl.style.pointerEvents = 'auto';  // pointer-events 명시
            togEl.style.zIndex = '10';  // 카드 위로
            togEl.style.position = 'relative';
            togEl.addEventListener('click', (e) => {
              e.stopPropagation();
              this.toggleActive(charUid, s.id);
            });
          }
        }
      } else {
        wrap.classList.add('is-empty');
        wrap.innerHTML =
          `<div class="form-spell-empty">+</div>` +
          `<div class="form-spell-empty-label">슬롯 ${i+1}</div>`;
      }
      grid.appendChild(wrap);
    }
  },

  // 2026-05-18 — 스펠 🔍 버튼 클릭 시 modal zoom (유닛과 동일 흐름). 옛 grid 안 toggle 폐기.
  zoomSkill(skillId){
    const skill = (RoF.Data && RoF.Data.SKILLS || []).find(s => s && s.id === skillId);
    if(!skill){ this.toggleSkillZoom(skillId); return; }  // fallback (skill 못 찾으면 옛 toggle)
    this.zoomCard('spell', skill);
  },

  _renderSlots(){
    const el = document.getElementById('form-slots');
    if(!el) return;
    el.innerHTML = '';
    for(let idx = 0; idx < 5; idx++){
      const slot = this._slot(idx);
      const isSel = idx === this._selectedSlot;
      const isHero = idx === 0;
      const isEmpty = !slot;
      const div = document.createElement('div');
      div.className = 'form-slot' + (isSel ? ' is-selected' : '') + (isEmpty ? ' is-empty' : '');
      div.setAttribute('data-slot-idx', idx);
      if(isEmpty){
        div.innerHTML = `<span class="form-empty-msg">출진 동료 지정</span>`;
      } else {
        const portraitSrc = this._portraitSrc(slot);
        const tag = isHero ? '⚔ 영웅' : ('동료 ' + idx);
        const stats = isHero
          ? `<span>HP${slot.HP}</span><span>ATK${slot.ATK}</span><span>SOUL${slot.SOUL}</span>`
          : `<span>HP${slot.HP}</span><span>ATK${slot.ATK}</span>`;
        const action = isHero
          ? `<button class="form-mini-btn" data-action="formation.openSkill">스킬 변경</button>`
          : `<button class="form-mini-btn" data-action="formation.openReplace">교체</button>`;
        div.innerHTML =
          `<div class="form-slot-art"><img src="${portraitSrc}" alt="" onerror="this.style.display='none'"></div>` +
          `<div class="form-slot-info">` +
            `<div>` +
              `<div class="form-slot-tag">${tag}</div>` +
              `<div class="form-slot-name">${slot.name || slot.id}</div>` +
            `</div>` +
            `<div class="form-slot-stats">${stats}</div>` +
            action +
          `</div>`;
      }
      div.onclick = (ev) => {
        if(ev.target.closest('.form-mini-btn')) return;
        this._selectedSlot = idx;
        // 빈 슬롯 클릭 = 동료 영입 의도 → 즉시 교체 모달 열기 (영웅 슬롯 0 은 제외)
        if(isEmpty && idx !== 0){
          this._render();
          this.openReplace();
          return;
        }
        this._render();
      };
      el.appendChild(div);
    }
  },

  _renderMain(){
    const el = document.getElementById('form-main');
    if(!el) return;
    const sel = this._slot(this._selectedSlot);
    if(!sel){
      const isHeroSlot = this._selectedSlot === 0;
      if(isHeroSlot){
        el.innerHTML =
          `<div style="text-align:center;color:#6a5a8e;padding:80px 0;font-size:.95rem;">` +
            `<div style="margin-bottom:18px;">슬롯이 비어있습니다.</div>` +
            `<div style="font-size:.85rem;">영웅은 캐릭터 생성 시 결정됩니다.</div>` +
          `</div>`;
        return;
      }
      // 동료 슬롯 빈 상태 — 보유 동료 후보 그리드 인라인 표시
      const deck = (RoF.Game && RoF.Game.deck) || [];
      const isLocked = (RoF.Match && RoF.Match.api && RoF.Match.api.isLockedUnit) || (() => false);
      const placedUids = new Set(this.state.companions.filter(Boolean).map(c => c.uid));
      const candidates = deck.filter(c =>
        c && c.kind === 'unit' && !c.isHero && !isLocked(c) && !placedUids.has(c.uid)
      );
      const header =
        `<div style="margin-bottom:14px;">` +
          `<h2 class="form-selected-name" style="margin:0 0 6px;">출진 동료 지정 — 슬롯 ${this._selectedSlot}</h2>` +
          `<div style="color:#9a8ec0;font-size:.85rem;">아래 보유 동료 중 하나를 선택해 슬롯에 배치하세요.</div>` +
        `</div>`;
      if(!candidates.length){
        const ownedTotal = deck.filter(c => c && c.kind === 'unit' && !c.isHero && !isLocked(c)).length;
        const placedCount = placedUids.size;
        const msg = ownedTotal === 0
          ? `<div style="margin-bottom:14px;font-size:.95rem;">아직 영입한 동료가 없습니다.</div>` +
            `<button class="btn btn-s" data-action="game.showTavern">🍺 선술집으로 (동료 영입)</button>`
          : (ownedTotal <= placedCount
            ? `<div style="font-size:.95rem;">보유한 동료가 모두 다른 슬롯에 배치되어 있습니다.</div>`
            : `<div style="font-size:.95rem;">배치 가능한 동료가 없습니다.</div>`);
        el.innerHTML = header +
          `<div style="text-align:center;color:#6a5a8e;padding:40px 0;">${msg}</div>`;
        return;
      }
      // V4 프레임 카드로 그리드 구성 (mkCardElV4 재사용)
      el.innerHTML = header + `<div class="form-pick-grid" id="form-pick-grid" style="display:flex;flex-wrap:wrap;gap:12px;"></div>`;
      const pickGridEl = el.querySelector('#form-pick-grid');
      candidates.forEach(c => {
        const wrap = document.createElement('div');
        wrap.style.cssText = 'cursor:pointer;transition:transform .15s;flex-shrink:0;';
        wrap.onmouseenter = () => { wrap.style.transform = 'translateY(-4px)'; };
        wrap.onmouseleave = () => { wrap.style.transform = ''; };
        wrap.onclick = () => this.pickAndPlace(c.uid);
        if(typeof mkCardElV4 === 'function'){
          wrap.appendChild(mkCardElV4(c));
        }
        pickGridEl.appendChild(wrap);
      });
      return;
    }
    const isHero = this._selectedSlot === 0;
    const elementMap = {fire:'🔥 화염',water:'💧 물',lightning:'⚡ 전기',earth:'🌿 땅',holy:'✨ 신성',dark:'🌑 암흑'};
    const elTag = elementMap[sel.element] || sel.element || '';
    const roleTag = isHero
      ? (sel._heroRole === 'warrior' ? '근접' : sel._heroRole === 'ranger' ? '원거리' : '지원')
      : (sel.role === 'attack' ? '공격' : sel.role === 'defense' ? '방어' : sel.role === 'support' ? '지원' : sel.role || '');
    const lvTag = isHero ? `Lv ${sel.level || 1}` : (sel.rarity || 'bronze');

    const skills = this._equippedSkills(sel);
    const namePrefix = isHero ? '⚔ ' : '';
    el.innerHTML =
      `<div style="display:flex;gap:24px;align-items:flex-start;margin-bottom:18px;">` +
        `<div id="form-card-art" style="flex-shrink:0;"></div>` +
        `<div style="flex:1;min-width:0;">` +
          `<h2 class="form-selected-name" style="margin:0 0 8px;">${namePrefix}${sel.name || sel.id}</h2>` +
          `<div class="form-selected-tags" style="margin-bottom:14px;">` +
            `<span class="form-tag">${elTag}</span>` +
            `<span class="form-tag">${roleTag}</span>` +
            `<span class="form-tag">${lvTag}</span>` +
          `</div>` +
          `<div class="form-stats-row">` +
            `<div class="form-stat"><div class="form-stat-label">HP</div><div class="form-stat-value">${sel.HP || 0}</div></div>` +
            `<div class="form-stat"><div class="form-stat-label">ATK</div><div class="form-stat-value">${sel.ATK || 0}</div></div>` +
            `<div class="form-stat"><div class="form-stat-label">SOUL</div><div class="form-stat-value">${sel.SOUL || 0}</div></div>` +
          `</div>` +
        `</div>` +
      `</div>` +
      `<div class="form-skills-section">` +
        `<div class="form-skills-title">` +
          `<h3>시그니처 스킬 카드</h3>` +
          `<span class="form-skills-count">${skills.length} / 7 장착</span>` +
        `</div>` +
        `<div class="form-skills-grid" id="form-sig-grid" style="display:flex;flex-wrap:wrap;gap:12px;"></div>` +
        `<div style="margin-top:14px;text-align:right;">` +
          `<button class="btn btn-s" data-action="formation.openSkill">스킬 변경하기</button>` +
        `</div>` +
      `</div>` +
      `<div class="form-deck-info">` +
        `덱 합계: <strong>${this._calcDeckSize()}</strong>장 / 최대 36장` +
      `</div>`;

    // V4 프레임 카드 mount — 큰 유닛 카드
    const artEl = el.querySelector('#form-card-art');
    if(artEl && typeof mkCardElV4 === 'function'){
      const big = mkCardElV4(sel);
      big.style.transform = 'scale(1.3)';
      big.style.transformOrigin = 'top left';
      big.style.marginRight = '60px';   // scale 보정 — 우측 영역 침범 방지
      big.style.marginBottom = '60px';
      artEl.appendChild(big);
    }

    // V4 프레임 카드 mount — 시그니처 스킬 7장 그리드 (zoom toggle)
    const sigEl = el.querySelector('#form-sig-grid');
    if(sigEl && typeof mkCardElV4 === 'function'){
      for(let i = 0; i < 7; i++){
        const wrap = document.createElement('div');
        wrap.style.cssText = 'position:relative;flex-shrink:0;';
        if(i < skills.length){
          const s = skills[i];
          const isZoomed = this._zoomedSkillId === s.id;
          const zoomOrigin = i === 0 ? 'left center' : (i === 6 ? 'right center' : 'center');
          if(isZoomed){
            wrap.classList.add('is-zoomed');
            wrap.style.transform = 'scale(2)';
            wrap.style.transformOrigin = zoomOrigin;
            wrap.style.zIndex = '100';
            wrap.style.boxShadow = '0 8px 32px rgba(0,0,0,.85)';
          }
          wrap.style.cursor = 'pointer';
          wrap.onclick = () => this.toggleSkillZoom(s.id);
          wrap.appendChild(mkCardElV4(s));
        } else {
          // 빈 슬롯 placeholder
          const empty = document.createElement('div');
          empty.style.cssText = 'width:120px;aspect-ratio:3/4;border:2px dashed #4a3a72;border-radius:8px;display:flex;align-items:center;justify-content:center;color:#6a5a8e;font-size:.85rem;background:rgba(20,14,36,.3);';
          empty.textContent = `+ 슬롯 ${i+1}`;
          wrap.appendChild(empty);
        }
        sigEl.appendChild(wrap);
      }
    }
  },

  _calcDeckSize(){
    let total = 0;
    [this._slot(0), this._slot(1), this._slot(2), this._slot(3), this._slot(4)].forEach(s => {
      if(!s) return;
      total += 1;
      total += this._equippedSkills(s).length;
    });
    return total;
  },

  // ───── 동료 교체 모달 (C 단계) ─────
  _replaceFilter: 'all',     // 'all' | 'bronze' | 'silver' | 'gold' | 'legendary' | 'divine'
  _replacePicked: null,      // 선택된 카드 객체

  openReplace(){
    if(this._selectedSlot === 0){
      this._showToast('영웅은 교체할 수 없습니다.');
      return;
    }
    this._replaceFilter = 'all';
    this._replaceElementFilter = 'all';  // Step 2-2: 원소 필터 리셋
    this._replacePage = 0;               // Step 2-2: 페이지 리셋
    this._replacePicked = null;
    // Step 2-2 cluster A: 시안 정합 헤더 (eyebrow + 큰 제목 + 부제목 동적 갱신)
    const deck = (RoF.Game && RoF.Game.deck) || [];
    const isLocked = (RoF.Match && RoF.Match.api && RoF.Match.api.isLockedUnit) || (() => false);
    const ownedTotal = deck.filter(c => c && c.kind === 'unit' && !c.isHero && !isLocked(c)).length;
    const eb = document.getElementById('form-replace-eyebrow');
    const tt = document.getElementById('form-replace-title');
    const st = document.getElementById('form-replace-subtitle');
    if(eb) eb.textContent = 'COMPANION SWAP';
    if(tt) tt.textContent = `동료 슬롯 ${this._selectedSlot} — 교체`;
    if(st) st.textContent = `보유 동료 ${ownedTotal}명 · 원소·등급별 필터로 빠르게 찾기`;
    this._renderReplaceFilters();
    this._renderReplaceGrid();
    document.getElementById('form-replace-modal').style.display = 'flex';
  },
  setReplaceElementFilter(element){
    this._replaceElementFilter = element || 'all';
    this._replacePage = 0;
    this._renderReplaceFilters();
    this._renderReplaceGrid();
  },
  setReplacePage(delta){
    this._replacePage = Math.max(0, this._replacePage + (delta|0));
    this._renderReplaceGrid();
  },
  closeReplace(){
    document.getElementById('form-replace-modal').style.display = 'none';
    this._replacePicked = null;
  },
  setReplaceFilter(rarity){
    this._replaceFilter = rarity || 'all';
    this._renderReplaceFilters();
    this._renderReplaceGrid();
  },
  pickReplace(uid){
    this._replacePicked = uid;
    this._renderReplaceGrid();
  },
  // 빈 슬롯 메인 영역에서 인라인 후보 클릭 시 즉시 배치 (모달 거치지 않음)
  pickAndPlace(uid){
    if(this._selectedSlot === 0) return;
    const deck = (RoF.Game && RoF.Game.deck) || [];
    const picked = deck.find(c => c && c.uid === uid);
    if(!picked) return;
    this.state.companions[this._selectedSlot - 1] = picked;
    this._render();
  },
  // 시그니처 스킬 카드 click 시 2배 확대 toggle
  toggleSkillZoom(skillId){
    this._zoomedSkillId = (this._zoomedSkillId === skillId) ? null : skillId;
    this._render();
  },
  confirmReplace(){
    if(!this._replacePicked){
      this._showToast('동료를 선택하세요.');
      return;
    }
    const deck = (RoF.Game && RoF.Game.deck) || [];
    const picked = deck.find(c => c && c.uid === this._replacePicked);
    if(!picked) return;
    this.state.companions[this._selectedSlot - 1] = picked;
    this.closeReplace();
    this._render();
  },

  _renderReplaceFilters(){
    const el = document.getElementById('form-replace-filters');
    if(!el) return;
    // Step 2-2: 시안 정합 — 라벨 분리 + 원소(시안 명칭) + 등급(게임 공식 03-terminology.md)
    const elements = [
      {key:'all',        label:'전체'},
      {key:'fire',       label:'불'},
      {key:'water',      label:'물'},
      {key:'lightning',  label:'번개'},
      {key:'earth',      label:'대지'},
      {key:'holy',       label:'신성'},
      {key:'dark',       label:'암흑'},
    ];
    const rarities = [
      {key:'all',       label:'전체'},
      {key:'bronze',    label:'일반'},
      {key:'silver',    label:'희귀'},
      {key:'gold',      label:'고귀한'},
      {key:'legendary', label:'전설의'},
      {key:'divine',    label:'신'},
    ];
    el.innerHTML =
      `<div class="form-filter-row-inline">` +
        `<div class="form-filter-label">원소</div>` +
        `<div class="form-filter-chips">` +
          elements.map(f =>
            `<button class="form-filter-btn${f.key === this._replaceElementFilter ? ' is-active' : ''}" ` +
            `data-action="formation.setReplaceElementFilter" data-arg="${f.key}">${f.label}</button>`
          ).join('') +
        `</div>` +
      `</div>` +
      `<div class="form-filter-row-inline">` +
        `<div class="form-filter-label">등급</div>` +
        `<div class="form-filter-chips">` +
          rarities.map(f =>
            `<button class="form-filter-btn${f.key === this._replaceFilter ? ' is-active' : ''}" ` +
            `data-action="formation.setReplaceFilter" data-arg="${f.key}">${f.label}</button>`
          ).join('') +
        `</div>` +
      `</div>` +
      // 블로커 fix #2 (2026-05-18 storyboard-inspector): 매칭 건수 (시안 line 301~303)
      `<div class="form-filter-count" id="form-replace-count">—</div>`;
  },

  _renderReplaceGrid(){
    const el = document.getElementById('form-replace-grid');
    if(!el) return;
    const deck = (RoF.Game && RoF.Game.deck) || [];
    const isLocked = (RoF.Match && RoF.Match.api && RoF.Match.api.isLockedUnit) || (() => false);
    // 이미 다른 슬롯 (영웅 제외) 에 배치된 카드 uid set
    const placedUids = new Set(this.state.companions.filter(Boolean).map(c => c.uid));
    placedUids.delete((this.state.companions[this._selectedSlot - 1] || {}).uid);  // 자기 자리는 그대로
    // 후보: unit + 비-영웅 + lock 아님 + (원소/등급 필터 일치) + 다른 슬롯 미배치
    const candidates = deck.filter(c =>
      c && c.kind === 'unit' && !c.isHero && !isLocked(c) &&
      !placedUids.has(c.uid) &&
      (this._replaceFilter === 'all' || c.rarity === this._replaceFilter) &&
      (this._replaceElementFilter === 'all' || c.element === this._replaceElementFilter)
    );
    // 블로커 fix #2: 매칭 건수 라벨 갱신 (시안 line 301~303)
    const countEl = document.getElementById('form-replace-count');
    if(countEl) countEl.textContent = `${candidates.length}건 매칭`;
    if(!candidates.length){
      // 후보 0 — owned 자체가 없는지, 필터 때문인지 구분
      const ownedTotal = deck.filter(c => c && c.kind === 'unit' && !c.isHero && !isLocked(c)).length;
      const placedCount = this.state.companions.filter(Boolean).length;
      const filterApplied = this._replaceFilter !== 'all' || this._replaceElementFilter !== 'all';
      const msg = ownedTotal === 0
        ? `<div style="margin-bottom:14px;font-size:.95rem;">아직 영입한 동료가 없습니다.</div>` +
          `<button class="btn btn-s" data-action="game.showTavern">🍺 선술집으로 (동료 영입)</button>`
        : (filterApplied
          ? `<div style="font-size:.95rem;">조건에 맞는 동료가 없습니다. [원소 전체] / [등급 전체] 로 초기화해보세요.</div>`
          : `<div style="font-size:.95rem;">보유한 동료가 모두 다른 슬롯에 배치되어 있습니다.</div>`);
      el.innerHTML = `<div style="grid-column:1/-1;text-align:center;color:#6a5a8e;padding:40px 0;">${msg}</div>`;
      return;
    }
    // Step 2-2: 페이지네이션 (12 per page)
    const pageSize = this.PICKER_PAGE_SIZE;
    const totalPages = Math.max(1, Math.ceil(candidates.length / pageSize));
    if(this._replacePage >= totalPages) this._replacePage = totalPages - 1;
    const slice = candidates.slice(this._replacePage * pageSize, (this._replacePage + 1) * pageSize);
    // V4 프레임 카드로 후보 그리드 구성 (mkCardElV4 재사용) + 시안 4×3 grid + ZOOM 버튼 + 즉시 swap
    el.innerHTML = '';
    el.style.display = 'grid';
    el.style.gridTemplateColumns = 'repeat(4, 1fr)';
    el.style.gap = '14px';
    slice.forEach(c => {
      const wrap = document.createElement('div');
      wrap.className = 'form-picker-cell';
      // 카드 영역 (mkCardElV4 — pointer-events:none 으로 wrap 클릭 흡수)
      const cardBox = document.createElement('div');
      cardBox.className = 'form-picker-card-box';
      if(typeof mkCardElV4 === 'function'){
        cardBox.appendChild(mkCardElV4(c));
      }
      // ZOOM 버튼 (좌상단 🔍 — Step 2-3 CardZoomModal 까지 alert stub)
      const zoomBtn = document.createElement('button');
      zoomBtn.className = 'form-picker-zoom';
      zoomBtn.textContent = '🔍';
      zoomBtn.title = '확대해서 보기';
      zoomBtn.onclick = (e) => {
        e.stopPropagation();
        this.zoomCard('unit', c);
      };
      wrap.appendChild(cardBox);
      wrap.appendChild(zoomBtn);
      // 카드 클릭 → 즉시 swap + 모달 닫기 (시안 패턴)
      wrap.onclick = (e) => {
        if(e.target.closest('.form-picker-zoom')) return;
        this._replacePicked = c.uid;
        this.confirmReplace();
      };
      el.appendChild(wrap);
    });
    // 페이지네이션 footer (slice 끝나면 grid 아래 추가 — 별도 element 사용)
    this._renderReplacePagination(candidates.length, totalPages);
  },

  // Step 2-2: 페이지네이션 footer
  _renderReplacePagination(total, totalPages){
    let foot = document.getElementById('form-replace-pagination');
    const grid = document.getElementById('form-replace-grid');
    if(!grid) return;
    if(!foot){
      foot = document.createElement('div');
      foot.id = 'form-replace-pagination';
      foot.className = 'form-picker-pagination';
      grid.parentNode.insertBefore(foot, grid.nextSibling);
    }
    if(totalPages <= 1){
      foot.innerHTML = `<span class="form-picker-page-info">${total}건</span>`;
      return;
    }
    foot.innerHTML =
      `<button class="form-picker-page-btn" data-action="formation.setReplacePage" data-arg="-1"${this._replacePage <= 0 ? ' disabled' : ''}>◂ 이전</button>` +
      `<span class="form-picker-page-info">${this._replacePage + 1} / ${totalPages} · ${total}건</span>` +
      `<button class="form-picker-page-btn" data-action="formation.setReplacePage" data-arg="1"${this._replacePage >= totalPages - 1 ? ' disabled' : ''}>다음 ▸</button>`;
  },

  // Step 2-3 (2026-05-18): CardZoomModal — 시안 formation_v2.jsx:155 정합
  // 2026-05-18 사용자 컨펌 (mockup/illustration_frame/v3): 확대 전용 일러스트 + 황금 frame overlay.
  //   카드 통째 zoom (mkCardElV4) 폐기 → 일러스트만 frame 으로 둘러쌈. 메타데이터는 info panel 표시.
  zoomCard(kind, data){
    if(!data) return;
    const modal = document.getElementById('form-card-zoom-modal');
    const cardBox = document.getElementById('form-card-zoom-card');
    const infoBox = document.getElementById('form-card-zoom-info');
    if(!modal || !cardBox || !infoBox) return;
    // 일러스트 + frame 마운트 — getCardImg 헬퍼로 영웅(skinKey) / 일반(id) 모두 매핑
    cardBox.innerHTML = '';
    const artUrl = (RoF.getCardImg ? RoF.getCardImg(data) : null)
                || (RoF.Data && RoF.Data.CARD_IMG && RoF.Data.CARD_IMG[data.id])
                || '';
    const wrap = document.createElement('div');
    wrap.className = 'form-zoom-framed-art';
    wrap.innerHTML =
      '<div class="form-zoom-art" style="background-image:url(\'' + artUrl + '\');"></div>' +
      '<div class="form-zoom-frame"></div>';
    cardBox.appendChild(wrap);
    // INFO PANEL 렌더
    infoBox.innerHTML = this._renderCardZoomInfo(kind, data);
    // backdrop 클릭으로 닫기 (카드/info 영역은 stopPropagation)
    modal.onclick = (e) => {
      if(e.target === modal) this.closeCardZoom();
    };
    cardBox.onclick = (e) => e.stopPropagation();
    infoBox.onclick = (e) => e.stopPropagation();
    // ESC 핸들러
    if(!this._cardZoomEscBound){
      this._cardZoomEscHandler = (e) => {
        if(e.key === 'Escape' && document.getElementById('form-card-zoom-modal').style.display === 'flex'){
          this.closeCardZoom();
        }
      };
      document.addEventListener('keydown', this._cardZoomEscHandler);
      this._cardZoomEscBound = true;
    }
    modal.style.display = 'flex';
  },
  closeCardZoom(){
    const modal = document.getElementById('form-card-zoom-modal');
    if(modal) modal.style.display = 'none';
  },
  _renderCardZoomInfo(kind, c){
    const ELEMENT_LABEL = {fire:'불', water:'물', lightning:'번개', earth:'대지', holy:'신성', light:'신성', dark:'암흑'};
    const ROLE_LABEL = {attack:'공격', defense:'방어', support:'지원', warrior:'근접', ranger:'원거리', melee:'근접', ranged:'원거리'};
    const RARITY_LABEL = {bronze:'일반', silver:'희귀', gold:'고귀한', legendary:'전설의', divine:'신'};
    const rarityV = RARITY_LABEL[c.rarity] || c.rarity || '—';
    const elementV = ELEMENT_LABEL[c.element] || c.element || '—';
    const roleV = ROLE_LABEL[c.role] || c.role || '';
    const isUnit = (c.kind === 'unit' || !c.kind);
    const stats = isUnit
      ? [
          {label:'HP',   icon:'♥', val:(c.HP ?? c.hp ?? 0),                  color:'#ffd0d0'},
          {label:'ATK',  icon:'⚔', val:(c.ATK ?? c.atk ?? 0),                color:'#dff0ff'},
          {label:'SOUL', icon:'✦', val:(c.SOUL ?? '—'),                       color:'#e0c8ff'},
          {label:'COST', icon:'◆', val:(c.NEED_SOUL ?? c.cost ?? '—'),       color:'#f3d676'},
        ]
      : [
          {label:'COST', icon:'◆', val:(c.NEED_SOUL ?? c.cost ?? '—'),       color:'#f3d676'},
          {label:'KIND', icon:'✦', val:(c.kind || '—'),                       color:'#dff0ff', small:true},
          {label:'KW',   icon:'★', val:((c.keywords||[]).join(',') || '—'),   color:'#e0c8ff', small:true},
          {label:'TYPE', icon:'◇', val:(c.dmgType || '—'),                    color:'#ffd0d0', small:true},
        ];
    const chips =
      `<span class="form-zoom-chip is-rarity">${rarityV}</span>` +
      `<span class="form-zoom-chip">${elementV}</span>` +
      (roleV ? `<span class="form-zoom-chip">${roleV}</span>` : '');
    const statHtml = stats.map(s =>
      `<div class="form-zoom-stat${s.small ? ' is-small' : ''}">` +
        `<div class="form-zoom-stat-label">${s.label}</div>` +
        `<div class="form-zoom-stat-value" style="color:${s.color};">${s.icon} ${s.val}</div>` +
      `</div>`
    ).join('');
    const descHtml = c.desc
      ? `<div class="form-zoom-desc">${c.desc}</div>`
      : '';
    const abilityHtml = c.ability
      ? `<div class="form-zoom-desc">${c.ability}</div>`
      : '';
    return (
      `<div class="form-zoom-eyebrow">${isUnit ? 'UNIT DETAIL' : 'SPELL DETAIL'}</div>` +
      `<div class="form-zoom-name">${c.name || c.id}</div>` +
      `<div class="form-zoom-chips">${chips}</div>` +
      `<div class="form-zoom-stats">${statHtml}</div>` +
      abilityHtml + descHtml
    );
  },

  // ───── 스킬 변경 모달 — Step 2-2 stub (사용자 결정 2026-05-18 옵션 1) ─────
  // 옛 PHASE 3 식 7장 max 토글은 신 룰 (active 0~5) 과 겹쳐 폐기 후보.
  // 중립 스펠 학습 시스템 (마을 골드 sink) 구현 후 실제 wire 예정.
  // 2026-05-18 사용자 명시 "스킬변경 누르면 팝업 — 준비중입니다"
  openSkill(){
    if(typeof UI !== 'undefined' && typeof UI.modal === 'function'){
      UI.modal('스킬 변경', '<div style="text-align:center;padding:18px 8px;font-size:1.05rem;color:#d8c8a8;">준비중입니다.</div>', null);
    } else {
      alert('준비중입니다.');
    }
  },
  _openSkill_legacy(){  // 옛 함수 보존 (회귀 충돌 우려 — 트리거 X)
    const sel = this._slot(this._selectedSlot);
    if(!sel){
      this._showToast('빈 슬롯의 스킬은 변경할 수 없습니다.');
      return;
    }
    document.getElementById('form-skill-title').textContent = `스킬 변경 — ${sel.name || sel.id}`;
    this._renderSkillModal();
    document.getElementById('form-skill-modal').style.display = 'flex';
  },
  closeSkill(){
    document.getElementById('form-skill-modal').style.display = 'none';
    this._render();  // 메인 영역 시그니처 카드 갱신
  },
  toggleSkill(skillId){
    const sel = this._slot(this._selectedSlot);
    if(!sel) return;
    const equipped = this._equippedSkills(sel).map(s => s.id);
    const wasEquipped = equipped.includes(skillId);
    let next;
    if(wasEquipped){
      next = equipped.filter(id => id !== skillId);
    } else {
      if(equipped.length >= 7){
        this._showToast('장착 슬롯이 가득 찼습니다 (최대 7).');
        return;
      }
      next = [...equipped, skillId];
    }
    this.state.equipped[sel.uid] = next;
    this._renderSkillModal();
  },

  _renderSkillModal(){
    const sel = this._slot(this._selectedSlot);
    if(!sel) return;
    const SKILLS = (RoF.Data && RoF.Data.SKILLS) || [];
    const bundled = sel.bundledSkillIds || [];
    const equipped = this._equippedSkills(sel).map(s => s.id);
    const available = bundled.filter(id => !equipped.includes(id));

    const cellHtml = (skId, isEquipped) => {
      const s = SKILLS.find(x => x.id === skId);
      if(!s) return '';
      return (
        `<div class="form-skill-card" data-action="formation.toggleSkill" data-arg="${skId}" ` +
        `${isEquipped ? 'style="border-color:#ffd34a;"' : ''}>` +
          `<div class="form-skill-cost">${s.NEED_SOUL || 0}</div>` +
          `<div class="form-skill-icon">${s.icon || '✦'}</div>` +
          `<div class="form-skill-name">${s.name || s.id}</div>` +
          (isEquipped ? `<div style="position:absolute;top:4px;right:4px;font-size:.65rem;color:#ffd34a;font-weight:700;">장착</div>` : '') +
        `</div>`
      );
    };

    const equippedHtml = equipped.length
      ? equipped.map(id => cellHtml(id, true)).join('')
      : `<div style="grid-column:1/-1;text-align:center;color:#6a5a8e;padding:24px 0;">장착된 스킬이 없습니다.</div>`;
    const availableHtml = available.length
      ? available.map(id => cellHtml(id, false)).join('')
      : `<div style="grid-column:1/-1;text-align:center;color:#6a5a8e;padding:24px 0;">장착 가능한 시그니처 스킬이 없습니다.</div>`;

    document.getElementById('form-skill-equipped-count').textContent = equipped.length;
    document.getElementById('form-skill-equipped').innerHTML = equippedHtml;
    document.getElementById('form-skill-available').innerHTML = availableHtml;
  },

  // ───── 출전 시작 (E 단계) ─────
  // 2026-05-10 Plan 1 Task 4 — Match.api.start 직접 호출 폐기.
  // 매칭 화면(showMatchmaking) 거쳐 Phase 1 검색 → Phase 2 발견 → 출전 시점에 Match.start.
  //
  // 글로벌 상태 변경 책임:
  //   - RoF.Game.deck     ← playerDeck (showMatchmaking + generateBot + startBattleFromMatch 의존)
  //   - RoF.Game._pendingMatch ← { playerHero, playerDeck } (startBattleFromMatch 가 소비)
  //
  // 정리 책임 (메모리 누수 방지):
  //   - 매치 종료 시 60_turnbattle_v6.js / 80_match_result.js 가 _pendingMatch = null 처리
  //   - cancelMatchmaking 호출 시 50_game_core.js 가 _pendingMatch = null 처리
  //   - 회귀 테스트는 finally 블록에서 직접 정리
  startBattle(){
    this._ensureState();
    const reason = this._validateForBattle();
    if(reason){
      this._showToast(reason);
      return;
    }
    // showMatchmaking 미구현 시 명확히 실패 — 직접 Match.start 호출은 빈 적덱/같은 영웅으로
    // 게임 불가능 상태를 만들기 때문에 폴백 금지.
    if (typeof RoF.Game.showMatchmaking !== 'function') {
      console.error('[formation] RoF.Game.showMatchmaking 미구현 — 매칭 시스템 로딩 실패');
      this._showToast('매칭 시스템을 불러올 수 없습니다. 새로고침 후 다시 시도해주세요.');
      return;
    }
    // 덱 빌드 + Match 시작 정보를 Game.deck + _pendingMatch 에 보존
    const playerHero = this.state.hero;
    const playerDeck = this._buildBattleDeck();
    RoF.Game.deck = playerDeck;
    RoF.Game._pendingMatch = { playerHero, playerDeck };
    // 매칭 화면 진입 (Phase 1 검색 → Phase 2 발견 → 출전 → tcg-screen)
    RoF.Game.showMatchmaking();
  },

  _validateForBattle(){
    if(!this.state.hero) return '영웅이 설정되지 않았습니다.';
    // lock 카드 검증 (state 안에 들어있는데 bundled 0 이 된 카드 — 영입 후 시그니처 빠진 케이스)
    const isLocked = (RoF.Match && RoF.Match.api && RoF.Match.api.isLockedUnit) || (() => false);
    for(let i = 0; i < 4; i++){
      const c = this.state.companions[i];
      if(c && isLocked(c)){
        return `슬롯 ${i+1} 의 ${c.name || c.id} 는 시그니처 스펠이 미정의 상태입니다. 교체하거나 비워두세요.`;
      }
    }
    return null;  // OK
  },

  _buildBattleDeck(){
    const deck = [];
    const SKILLS = (RoF.Data && RoF.Data.SKILLS) || [];
    /* diagnosis-confirmed: 2026-06-13 사유: feature — 동료 영입 영웅레벨 게이팅 (사용자 "적용" 지시, 곡선+게이팅 기획변경). 버그수정 아님. */
    // 동료 영입 영웅레벨 게이팅 — 해금된 N명만 출전 (Game.getUnlockedCompanionCount 단일 진실, changelog/balance-tables).
    //   슬롯엔 최대 4명 배치 가능하나 영웅 레벨 미달 동료는 매치 덱에서 제외(앞 슬롯 우선). 잠금 슬롯 시각 UI 는 갤러리 별도.
    const unlocked = (RoF.Game && typeof RoF.Game.getUnlockedCompanionCount === 'function')
      ? RoF.Game.getUnlockedCompanionCount() : 4;
    const placedCompanions = this.state.companions.filter(Boolean).slice(0, unlocked);
    const slots = [this.state.hero, ...placedCompanions];
    slots.forEach(c => {
      if(!c) return;
      // 캐릭터 카드 자체
      deck.push(c);
      // 시그니처 스킬 — 카드레벨 해금된 것만 (잠긴 스킬 = 아직 못 익힘 → 매치 제외)
      const skills = this._equippedSkills(c).filter(s => !RoF.isSkillLocked(s, c));
      skills.forEach(s => {
        // 카드 인스턴스 — bundledByUnit 메타 부착해서 동료 사망 시 부서짐 시퀀스 발동
        deck.push(Object.assign({}, s, {bundledByUnit: c.id}));
      });
    });
    return deck;
  },

  _buildEnemyHero(){
    if(RoF.Data && RoF.Data.createHero){
      try {
        return RoF.Data.createHero({gender:'f', role:'warrior', element:'water', skinIndex:0});
      } catch(e){}
    }
    return null;
  },

  _buildEnemyDeck(){
    // dummy — apprentice 카드 30장 (적 AI 가 사용)
    const UNITS = (RoF.Data && RoF.Data.UNITS) || [];
    const apprentice = UNITS.find(u => u.id === 'apprentice');
    if(!apprentice) return [];
    const arr = [];
    for(let i = 0; i < 30; i++) arr.push(Object.assign({}, apprentice));
    return arr;
  },

  _showToast(msg){
    const t = document.createElement('div');
    t.className = 'form-toast';
    t.textContent = msg;
    document.body.appendChild(t);
    setTimeout(() => { if(t.parentNode) t.parentNode.removeChild(t); }, 2600);
  },
};
