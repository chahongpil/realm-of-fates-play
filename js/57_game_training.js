// Game Training (훈련소 — Mastery / Awakening / Learning / Engraving / Upgrade)
// 2026-05-25 신규: 시안 통째 ABC 정본 적용 (0.claulde.design/20260525/훈련소시안_0525/)
// Meta progression spec v1.1 (game/design/meta_progression_spec.md) 5 모듈 1:1 매핑.
// 파일명 53 → 57 로 rename (js/53_game_deck.js 와 충돌 회피).
//
// 시안 5 탭 → 정본 모듈:
//   수련(mastery)   → RoF.Meta.Mastery (Lv 10 unlock 트리거 + 진행 시각화)
//   각성(awakening) → RoF.Meta.Awakening (등급 진화)
//   학습(learning)  → RoF.Meta.Learning + 봉인=Mastery.forgetSkill (잊기 통합)
//   각인(engraving) → RoF.Meta.Engraving (Lv 10 인벤토리 등록)
//   강화(upgrade)   → RoF.Meta.Upgrade (영구 진화 + 재학습)
//
// 옛 함수 (54_game_castle.js:46~367 의 showTraining 흐름) 폐기 — 같은 cluster 에서 제거.
// __gameKeys 갱신: 옛 키 (showTrainingSkillEntry / _trainingSelectCard / _renderTrainingDetail / _trainCard / _allocStat / _levelUpEffect) 제거 + 신 키 추가.

RoF.__gameKeys = RoF.__gameKeys || new Set();
(function(keys){
  for (const k of keys) {
    if (RoF.__gameKeys.has(k)) {
      console.error('[Game] 중복 키 감지:', k);
      RoF.__gameKeyError = true;
    }
    RoF.__gameKeys.add(k);
  }
})([
  // state
  '_trainingActiveTab', '_trainingActiveUid', '_trainingLnSelectedSlot', '_trainingEgSelectedSkill', '_trainingUpSelectedSkill',
  // entry + tabs
  'showTrainingMasteryTab', 'showTrainingAwakeningTab', 'showTrainingLearningTab', 'showTrainingEngravingTab',
  // unit / tab dispatch
  '_trainingSelectUnit', '_trainingApplyFilter', '_trainingSetTab',
  // panel renderers
  '_renderTrainingMastery', '_renderTrainingAwakening', '_renderTrainingLearning', '_renderTrainingEngraving', '_renderTrainingUpgrade',
  '_renderTrainingPartyRail',
  // actions
  '_doTrainXP', '_doEngraveSkill', '_doUpgradeSkill', '_doSealSkill', '_doAwakenUnit', '_doRelearnSkill',
  // helper
  '_trainingUnitList', '_trainingActiveUnit', '_trainingUnitArt', '_trainingHelpOpen',
  // zoom popups (2026-05-25 시안 정합)
  '_openTrainingProfileZoom', '_openTrainingSkillZoom', '_closeTrainingZoom',
  // 11 popup 정본화 (2026-05-25 시안 통째 ABC 완성)
  '_openTrainingPopup', '_closeTrainingPopup', '_closeAllTrainingPopups',
  '_openTrainingStatPop', '_doStatAlloc', '_doStatReset',
  '_triggerTrainingLvupBurst',
  '_openTrainingAwakenChoice',
  '_openTrainingUpgradeChoice', '_openTrainingUpgradeConfirm', '_openTrainingStatUpgrade',
  '_openTrainingLibrary', '_openTrainingLearningAction', '_openTrainingLearningConfirm',
  '_doLearnSkill', '_openTrainingLsZoom', '_openTrainingRevert',
  '_trainingLibPicked',
]);

Object.assign(RoF.Game, {
  // ─── state ────────────────────────────────────────────────────────
  _trainingActiveTab: 'mastery',      // 'mastery' | 'awakening' | 'learning' | 'engraving' | 'upgrade'
  _trainingActiveUid: null,           // 선택된 unit uid (영웅이면 'hero', deck card 면 c.uid)
  _trainingLnSelectedSlot: null,      // learning 탭에서 선택된 슬롯 index (0~9) 또는 null
  _trainingEgSelectedSkill: null,     // engraving 탭에서 선택된 skill id 또는 null
  _trainingUpSelectedSkill: null,     // upgrade 탭에서 선택된 skill id 또는 null

  // ─── entry (replaces 54_game_castle.js:46 옛 showTraining) ────────
  showTraining(){
    UI.show('training-screen');
    if(!this._trainingActiveUid){
      // 영웅 default 선택
      this._trainingActiveUid = this._hero?.uid || (this.deck?.[0]?.uid) || null;
    }
    this._trainingActiveTab = 'mastery';
    this._renderTrainingPartyRail();
    this._renderTrainingMastery();
    this._trainingApplyFilter();
  },

  // wrapper for legacy npc-choice "스킬 교체" entry (마을 NPC choice)
  showTrainingSkillEntry(){
    this.showTraining();
    this.showTrainingLearningTab();
  },

  // ─── tab switching ───────────────────────────────────────────────
  _trainingSetTab(tab){
    this._trainingActiveTab = tab;
    document.querySelectorAll('#training-screen .tr-tab').forEach(t=>{
      t.classList.toggle('is-active', t.dataset.tab === tab);
    });
    document.querySelectorAll('#training-screen .tr-panel').forEach(p=>{
      p.classList.toggle('is-active', p.dataset.panel === tab);
    });
  },
  showTrainingMasteryTab(){ this._trainingSetTab('mastery'); this._renderTrainingMastery(); },
  showTrainingAwakeningTab(){ this._trainingSetTab('awakening'); this._renderTrainingAwakening(); },
  showTrainingLearningTab(){ this._trainingSetTab('learning'); this._renderTrainingLearning(); },
  showTrainingEngravingTab(){ this._trainingSetTab('engraving'); this._renderTrainingEngraving(); },
  showTrainingUpgradeTab(){ this._trainingSetTab('upgrade'); this._renderTrainingUpgrade(); },

  // ─── party rail (left column) ────────────────────────────────────
  _trainingUnitList(){
    // 영웅 + 동료 unit deck 반환. 영웅은 첫 자리 + isHero:true.
    const list = [];
    const hero = this._hero;
    if(hero){
      list.push(Object.assign({}, hero, {_isHero:true, uid:'hero'}));
    }
    if(Array.isArray(this.deck)){
      this.deck.forEach(c=>{
        if(c && c.uid && c.uid !== 'hero') list.push(c);
      });
    }
    return list;
  },

  _trainingActiveUnit(){
    const uid = this._trainingActiveUid;
    if(!uid) return null;
    const list = this._trainingUnitList();
    return list.find(u => u.uid === uid) || list[0] || null;
  },

  _renderTrainingPartyRail(){
    const list = this._trainingUnitList();
    const railListEl = document.querySelector('#training-screen .tr-pm-list');
    if(!railListEl) return;
    railListEl.innerHTML = '';
    list.forEach(u=>{
      const lv = (u.skillMastery && u._heroLevel) || u.level || 1;
      const xp = u.xp || 0;
      const xpNext = this.cardXpNext ? Math.max(1, this.cardXpNext(u)) : 100;
      const xpPct = Math.min(100, Math.floor((xp / xpNext) * 100));
      const rarity = u.rarity || u.tier || 'bronze';
      const rarMap = { bronze:'common', silver:'rare', gold:'noble', legendary:'legendary', divine:'divine' };
      const rarSlug = rarMap[rarity] || 'common';
      const rarLabel = { common:'일반', rare:'희귀', noble:'고귀한', legendary:'전설', divine:'신' }[rarSlug];
      const imgSrc = (RoF.Data && RoF.Data.CARD_IMG && RoF.Data.CARD_IMG[u.id]) || 'img/units/bronze/militia/card.png';
      const isSel = u.uid === this._trainingActiveUid;
      const isHero = u._isHero;
      const elem = u.element || 'fire';

      const div = document.createElement('div');
      div.className = 'tr-pm' + (isSel ? ' is-sel' : '') + (isHero ? ' is-hero' : '');
      div.dataset.uid = u.uid;
      div.dataset.el = elem;
      div.dataset.rar = rarSlug;
      div.innerHTML = `
        <div class="tr-pm-portrait"><img src="${imgSrc}" alt=""></div>
        <div class="tr-pm-info">
          <div class="tr-pm-name">${isHero ? '⚔ ' : ''}${u.name || u.id}</div>
          <div class="tr-pm-meta"><span class="tr-pm-lv">Lv ${lv}</span><span class="tr-pm-rar r-${rarSlug}">${rarLabel}</span></div>
        </div>
        <div class="tr-pm-exp"><i style="width:${xpPct}%"></i></div>
      `;
      div.addEventListener('click', ()=>this._trainingSelectUnit(u.uid));
      railListEl.appendChild(div);
    });
  },

  _trainingSelectUnit(uid){
    this._trainingActiveUid = uid;
    document.querySelectorAll('#training-screen .tr-pm').forEach(p=>{
      p.classList.toggle('is-sel', p.dataset.uid === String(uid));
    });
    // 현재 탭 재렌더
    const tab = this._trainingActiveTab;
    if(tab === 'mastery') this._renderTrainingMastery();
    else if(tab === 'awakening') this._renderTrainingAwakening();
    else if(tab === 'learning') this._renderTrainingLearning();
    else if(tab === 'engraving') this._renderTrainingEngraving();
    else if(tab === 'upgrade') this._renderTrainingUpgrade();
  },

  _trainingApplyFilter(){
    // formation / all-units toggle 시 호출. 현재 단계 placeholder (필터 미적용).
    const rail = document.querySelector('#training-screen .tr-rail');
    if(!rail) return;
    const all = rail.classList.contains('show-all');
    const count = document.querySelector('#training-screen .tr-rail-head .tr-sub');
    const total = rail.querySelectorAll('.tr-pm').length;
    if(count) count.textContent = total + ' / ' + total;
  },

  // ─── 1. MASTERY (수련) ───────────────────────────────────────────
  _renderTrainingMastery(){
    const panel = document.querySelector('#training-screen .tr-panel[data-panel="mastery"]');
    if(!panel) return;
    const u = this._trainingActiveUnit();
    if(!u){
      panel.innerHTML = '<div class="tr-info-line">유닛을 선택해 주세요.</div>';
      return;
    }
    const lv = u.level || 1;
    const xp = u.xp || 0;
    const xpNext = this.cardXpNext ? Math.max(1, this.cardXpNext(u)) : 100;
    const xpPct = Math.min(100, Math.floor((xp / xpNext) * 100));
    const rarity = u.rarity || u.tier || 'bronze';
    const rarSlug = { bronze:'일반', silver:'희귀', gold:'고귀한', legendary:'전설', divine:'신' }[rarity];
    const elemMap = { fire:'🔥 화염', water:'💧 물', earth:'🌿 대지', lightning:'⚡ 번개', holy:'✨ 신성', dark:'🌑 암흑' };
    const elem = elemMap[u.element || 'fire'] || u.element;
    const imgSrc = (RoF.Data && RoF.Data.CARD_IMG && RoF.Data.CARD_IMG[u.id]) || 'img/units/bronze/militia/card.png';
    const oneLevelCost = this.cardXpNext ? Math.max(1, xpNext - xp) : 100;
    const trainCost = Math.min(this.gold || 0, oneLevelCost);
    const trainDisabled = (lv >= (this.CARD_LEVEL_CAP || 30)) || (this.gold || 0) < 1;

    panel.innerHTML = `
      <div class="tr-detail">
        <div class="tr-detail-card">
          <div class="tr-dc-art"><img src="${imgSrc}" alt=""></div>
          <button class="tr-dc-name-btn">${u.name || u.id}</button>
          <div class="tr-dc-tags-row"><span class="tr-dc-tag">${elem}</span><span class="tr-dc-tag">${rarSlug}</span></div>
        </div>
        <div class="tr-detail-side">
          <div class="tr-ds-head"><span class="lbl">— 수련 진행</span><span class="line"></span></div>
          <div class="tr-lv-strip">
            <div class="tr-lv-now">${lv}</div>
            <div class="tr-lv-arrow">→</div>
            <div class="tr-lv-next">${lv + 1}</div>
            <div class="tr-lv-meta">
              <div style="font:700 10px/1 'Noto Sans KR';letter-spacing:.2em;color:var(--tr-text-2);text-transform:uppercase;">경험치 · EXP</div>
              <div class="tr-lv-bar"><i style="width:${xpPct}%"></i><span class="pct">${xp} / ${xpNext}</span></div>
            </div>
          </div>
          <div class="tr-act">
            <button class="tr-btn" id="tr-btn-train"${trainDisabled ? ' disabled' : ''}>수 련 ▶</button>
            <span class="tr-act-hint">EXP 누적 후 Lv 10 도달 시 각인/강화 해금</span>
            <div class="tr-cost-tag"><span class="tr-coin-sm">G</span><b>${trainCost}</b> 골드</div>
          </div>
          <div class="tr-act">
            <button class="tr-btn secondary" id="tr-btn-stat-open">✦ 스탯 분배</button>
            <button class="tr-btn danger" id="tr-btn-stat-reset">↻ 초기화</button>
            <span class="tr-act-hint">남은 스탯 · <b style="color:var(--tr-gilt-pale);font-size:13px;">${u.freePoints || 0}</b></span>
          </div>
          <div class="tr-info-line">수련 시 골드를 EXP 로 환산한다. Lv 10 에 도달하면 각인 또는 강화 길이 열린다.</div>
        </div>
      </div>
    `;
    const btn = panel.querySelector('#tr-btn-train');
    if(btn) btn.addEventListener('click', ()=>this._doTrainXP(u));
    panel.querySelector('#tr-btn-stat-open')?.addEventListener('click', ()=>this._openTrainingStatPop(u));
    panel.querySelector('#tr-btn-stat-reset')?.addEventListener('click', ()=>this._doStatReset(u));
  },

  _doTrainXP(u){
    if(!u || (this.gold || 0) < 1) return;
    const lv = u.level || 1;
    if(lv >= (this.CARD_LEVEL_CAP || 30)){ return; }
    const xp = u.xp || 0;
    const xpNext = this.cardXpNext ? Math.max(1, this.cardXpNext(u)) : 100;
    const exp = Math.min(this.gold, xpNext - xp);
    if(exp < 1) return;
    this.gold -= exp;
    let lvRes = null;
    if(typeof this.giveCardXp === 'function'){
      lvRes = this.giveCardXp(u, exp);
    } else {
      u.xp = (u.xp || 0) + exp;
    }
    if(typeof SFX !== 'undefined' && SFX.play) SFX.play('upgrade');
    this.persist && this.persist();
    this._renderTrainingMastery();
    this._renderTrainingPartyRail();
    // 레벨업 → 통합 오버레이 + 해금된 시그니처 스킬 순차 연출 (2026-06-08 게임적용, 사용자 컨펌).
    /* diagnosis-confirmed: 2026-06-08 사유: feature — 스킬 해금 연출 체이닝 (presentLevelUp) */
    if(lvRes && lvRes.leveled && RoF.UI){
      if(RoF.UI.presentLevelUp) RoF.UI.presentLevelUp(u, lvRes);
      else if(RoF.UI.showLevelUp) RoF.UI.showLevelUp(u, lvRes);
    }
  },

  // ─── 2. AWAKENING (각성) ─────────────────────────────────────────
  _renderTrainingAwakening(){
    const panel = document.querySelector('#training-screen .tr-panel[data-panel="awakening"]');
    if(!panel) return;
    const u = this._trainingActiveUnit();
    if(!u){
      panel.innerHTML = '<div class="tr-info-line">유닛을 선택해 주세요.</div>';
      return;
    }
    const imgSrc = (RoF.Data && RoF.Data.CARD_IMG && RoF.Data.CARD_IMG[u.id]) || 'img/units/bronze/militia/card.png';
    const rarity = u.rarity || u.tier || 'bronze';
    const order = ['bronze','silver','gold','legendary','divine'];
    const rarLabel = { bronze:'일반', silver:'희귀', gold:'고귀한', legendary:'전설', divine:'신' };
    const rarMark = { bronze:'◯', silver:'◇', gold:'★', legendary:'✧', divine:'✦' };
    const curIdx = order.indexOf(rarity);
    const targetIdx = curIdx + 1 < order.length ? curIdx + 1 : -1;
    const isMax = targetIdx < 0;

    const ladder = order.map((r, i)=>{
      let cls = 'tr-rl';
      if(i === curIdx) cls += ' is-now';
      else if(i === targetIdx) cls += ' is-target';
      const suffix = i === curIdx ? ' · 현재' : (i === targetIdx ? ' · 목표' : '');
      return `<div class="${cls}"><span class="tr-rl-mark">${rarMark[r]}</span>${rarLabel[r]}${suffix}</div>`;
    }).join('');

    const elemMap = { fire:'🔥 화염', water:'💧 물', earth:'🌿 대지', lightning:'⚡ 번개', holy:'✨ 신성', dark:'🌑 암흑' };
    const elem = elemMap[u.element || 'fire'] || u.element;
    const targetRar = isMax ? null : order[targetIdx];
    const targetLabel = isMax ? null : rarLabel[targetRar];
    const cost = { silver: 800, gold: 4500, legendary: 18000, divine: 30000 }[targetRar] || 0;
    // 2026-06-11 fix — 각성 미리보기 스탯: 폐기 소문자 u.hp/u.atk(현행 스키마엔 없음 → 항상 0) +
    //   실재하지 않는 ×1.3 진화 계수 제거. 실데이터 소스 = Awakening.evolveOptions(u)[].stat
    //   (line 829 _openTrainingAwakenChoice 와 동일 패턴). evolveTo 미정의 시 [] → "데이터 준비 중" 안내.
    const _aw = (RoF.Meta && RoF.Meta.Awakening) ? RoF.Meta.Awakening : null;
    const awOpts = (!isMax && _aw && typeof _aw.evolveOptions === 'function') ? (_aw.evolveOptions(u) || []) : [];
    const curHP = (u.HP != null) ? u.HP : 0;
    const curATK = (u.ATK != null) ? u.ATK : 0;
    let awChangeHtml;
    if(awOpts.length === 0){
      awChangeHtml = '<div class="tr-info-line">각성 후보 데이터가 아직 준비되지 않았습니다 <span style="font-size:10px;letter-spacing:.15em;opacity:.7;">(진화 데이터 batch 대기)</span></div>';
    } else {
      const s = awOpts[0].stat || {};
      const dHP = s.HP || 0, dATK = s.ATK || 0;
      const more = awOpts.length > 1 ? `<div class="tr-info-line" style="font-size:11px;opacity:.75;">외 ${awOpts.length - 1}개 각성 경로 — 의식 진행 시 선택</div>` : '';
      awChangeHtml =
          `<div class="tr-ds-row"><span class="k">HP</span><span class="v">${curHP} → <span class="diff up">${curHP + dHP}</span></span></div>`
        + `<div class="tr-ds-row"><span class="k">ATK</span><span class="v">${curATK} → <span class="diff up">${curATK + dATK}</span></span></div>`
        + more;
    }

    panel.innerHTML = `
      <div class="tr-detail">
        <div class="tr-detail-card">
          <div class="tr-dc-art"><img src="${imgSrc}" alt=""></div>
          <button class="tr-dc-name-btn">${u.name || u.id}</button>
          <div class="tr-dc-tags-row"><span class="tr-dc-tag">${elem}</span><span class="tr-dc-tag">${rarLabel[rarity]}</span></div>
        </div>
        <div class="tr-detail-side">
          <div class="tr-ds-head"><span class="lbl">— 등급 사다리</span><span class="line"></span></div>
          <div class="tr-rar-ladder">${ladder}</div>
          ${isMax ? `
            <div class="tr-info-line">이 유닛은 이미 최고 등급(신)이다. 각성의 길은 여기서 멈춘다.</div>
          ` : `
            <div class="tr-ds-head"><span class="lbl">— ${targetLabel} 각성 시 변화</span><span class="line"></span></div>
            ${awChangeHtml}
            <div class="tr-act">
              <button class="tr-btn" id="tr-btn-awaken">각성 의식 ▶</button>
              <button class="tr-btn danger" id="tr-btn-awaken-revert">↺ 회귀 의식</button>
              <span class="tr-act-hint">선택 후 신탁이 3 길을 보임</span>
              <div class="tr-cost-tag"><span class="tr-coin-sm">G</span><b>${cost.toLocaleString()}</b> 골드</div>
            </div>
            <div class="tr-info-line">각성은 되돌릴 수 없다 — 회귀 의식으로만 풀린다.</div>
          `}
        </div>
      </div>
    `;
    const btn = panel.querySelector('#tr-btn-awaken');
    if(btn) btn.addEventListener('click', ()=>this._openTrainingAwakenChoice(u));
    panel.querySelector('#tr-btn-awaken-revert')?.addEventListener('click', ()=>this._openTrainingRevert('회귀 의식'));
  },

  _doAwakenUnit(u, choiceIdx){
    if(!u || !RoF.Meta || !RoF.Meta.Awakening) return;
    const A = RoF.Meta.Awakening;
    // v2 (2026-05-26): form swap — choiceIdx 는 evolveOptions 배열 index, 또는 formId 문자열
    A.ensureFormsData(u, u.baseId || u.id, u.activeForm || u.id, u.rarity);
    const opts = A.evolveOptions(u);
    if(!opts || opts.length === 0){
      // 진화 후보 없음 (evolveTo 데이터 미정의 — 102 강화 batch 후 채움)
      console.log('[Training] 각성 후보 없음 — UNIT_DEF.evolutions[*].evolveTo 빈 배열');
      return;
    }
    const opt = (typeof choiceIdx === 'string')
      ? opts.find(o => o.formId === choiceIdx)
      : opts[choiceIdx];
    if(!opt){ console.warn('[Training] 각성 옵션 invalid', choiceIdx); return; }
    const r = A.applyEvolve(u, opt.formId);
    if(!r.ok){
      console.warn('[Training] 각성 실패:', r.reason);
      return;
    }
    if(typeof SFX !== 'undefined' && SFX.play) SFX.play('rarity_up');
    // UI 재렌더 + party rail 갱신
    if(typeof this._renderTrainingAwakening === 'function') this._renderTrainingAwakening();
    if(typeof this._renderTrainingPartyRail === 'function') this._renderTrainingPartyRail();
  },

  // ─── 3. LEARNING (학습 + 봉인=잊기) ──────────────────────────────
  _renderTrainingLearning(){
    const panel = document.querySelector('#training-screen .tr-panel[data-panel="learning"]');
    if(!panel) return;
    const u = this._trainingActiveUnit();
    if(!u){
      panel.innerHTML = '<div class="tr-info-line">유닛을 선택해 주세요.</div>';
      return;
    }
    const unitImgSrc = (RoF.Data && RoF.Data.CARD_IMG && RoF.Data.CARD_IMG[u.id]) || 'img/units/bronze/militia/card.png';
    const bundled = Array.isArray(u.bundledSkillIds) ? u.bundledSkillIds : [];
    const SLOT_COUNT = 10;
    const slots = [];
    for(let i = 0; i < SLOT_COUNT; i++){
      const skillId = bundled[i] || null;
      slots.push({ idx: i, skillId });
    }
    const learned = slots.filter(s=>s.skillId).length;

    const slotsHTML = slots.map(s=>{
      if(!s.skillId){
        return `<div class="tr-eg-card tr-ln-slot is-empty" data-slot="${s.idx}"><div class="tr-ln-plus">＋</div><div class="tr-ln-empty-msg">빈 학습 슬롯</div></div>`;
      }
      const sk = (typeof SKILLS_DB !== 'undefined' && Array.isArray(SKILLS_DB) ? SKILLS_DB : ((RoF.Data && RoF.Data.SKILLS) || [])).find(x => x && x.id === s.skillId);
      const name = sk?.name || s.skillId;
      const desc = sk?.desc || sk?.ability || '';
      const imgSrc = (RoF.Data && RoF.Data.CARD_IMG && RoF.Data.CARD_IMG[s.skillId]) || 'img/units/bronze/militia/card.png';
      // 카드레벨 미달 = 잠금 (아직 못 익힌 시그니처) — 클릭 시 해금조건 상세
      if(sk && RoF.isSkillLocked && RoF.isSkillLocked(sk, u)){
        const ul = RoF.skillUnlockLevel(sk);
        const curLv = u.level || 1;
        const need = ul - curLv;
        const cleanName = (sk.name || '').replace(/\s*\([^)]*\)/, '');
        const dmgKo = {melee:'근접', ranged:'원거리', magic:'마법'}[sk.dmgType] || '';
        const stats = [`✦${sk.NEED_SOUL}`];
        if(sk.ATK) stats.push(`⚔${sk.ATK}`);
        if(sk.HP)  stats.push(`❤${sk.HP}`);
        return `<div class="tr-eg-card tr-ln-slot is-locked" data-slot="${s.idx}" data-skill="${s.skillId}">
        <div class="tr-eg-art" style="background-image:url('${imgSrc}')"></div>
        <div class="tr-ln-lock"><div class="tr-ln-lock-icon">🔒</div><div class="tr-ln-lock-lv">Lv ${ul} 해금</div><div class="tr-ln-lock-hint">눌러서 자세히</div></div>
        <div class="tr-ln-lock-detail">
          <div class="ld-title">🔒 아직 익히지 못한 기술</div>
          <div class="ld-skill">${cleanName}</div>
          <div class="ld-stats">${stats.join(' ')}${dmgKo ? ` <span class="dt">· ${dmgKo}</span>` : ''}</div>
          <div class="ld-ability">${sk.ability || ''}</div>
          <div class="ld-div"></div>
          <div class="ld-cond">${u.name || '이 동료'}이(가) <b>카드레벨 ${ul}</b>에 이르면 익힌다.</div>
          <div class="ld-prog">현재 카드레벨 ${curLv} · ${need}레벨 더 필요</div>
          <div class="ld-hint">단련하여 더 성장하라</div>
        </div>
      </div>`;
      }
      return `<div class="tr-eg-card tr-ln-slot is-learned" data-slot="${s.idx}" data-skill="${s.skillId}">
        <div class="tr-eg-art" style="background-image:url('${imgSrc}')"></div>
        <div class="tr-eg-lv">활성</div>
        <div class="tr-eg-name">${name}</div>
        <div class="tr-eg-desc">${desc.slice(0, 24)}</div>
      </div>`;
    }).join('');

    panel.innerHTML = `
      <div class="tr-act" style="margin-bottom:14px;">
        <button class="tr-btn danger" id="tr-btn-seal">⊘ 봉 인</button>
        <button class="tr-btn" id="tr-btn-learn">학 습 ▶</button>
        <span class="tr-act-hint">슬롯 선택 후 클릭</span>
        <div class="tr-cost-tag"><span class="tr-coin-sm">G</span><b>800</b> 골드</div>
      </div>
      <div class="tr-ds-head" style="margin-bottom:10px;"><span class="lbl">— 학습 슬롯 · ${SLOT_COUNT}</span><span class="line"></span><span style="font:400 9px/1 'Noto Sans KR';letter-spacing:.25em;color:var(--tr-text-3);">활성 ${learned} · 빈 ${SLOT_COUNT - learned}</span></div>
      <div class="tr-skill-layout">
        <div class="tr-skill-prof">
          <div class="tr-sp-art"><img src="${unitImgSrc}" alt=""></div>
          <button class="tr-sp-name-btn">${u.name || u.id}<span class="lv">Lv ${u.level || 1}</span></button>
        </div>
        <div class="tr-eg-row" id="tr-ln-slots" style="margin:0;">${slotsHTML}</div>
      </div>
      <div class="tr-info-line" style="margin-top:14px;">슬롯(빈칸 또는 활성 스킬)을 선택한 뒤 <b style="color:var(--tr-gilt-pale);font-style:normal;">학습 ▶</b>을 누르면 보유한 스킬 풀에서 다시 익힐 수 있다. <b style="color:var(--tr-gilt-pale);font-style:normal;">봉인 ⊘</b>은 활성 스킬을 슬롯에서 비운다(잊기).</div>
    `;
    this._trainingMountV4Cards();
    // slot select
    panel.querySelectorAll('.tr-ln-slot').forEach(slot=>{
      slot.addEventListener('click', (e)=>{
        // 잠긴 슬롯 — 선택 대신 해금조건 상세 토글
        if(slot.classList.contains('is-locked')){
          e.stopPropagation();
          const wasOpen = slot.classList.contains('show-detail');
          panel.querySelectorAll('.tr-ln-slot.show-detail').forEach(x=>x.classList.remove('show-detail'));
          if(!wasOpen) slot.classList.add('show-detail');
          return;
        }
        panel.querySelectorAll('.tr-ln-slot').forEach(x=>x.classList.remove('is-sel'));
        slot.classList.add('is-sel');
        this._trainingLnSelectedSlot = parseInt(slot.dataset.slot, 10);
      });
    });
    // 잠긴 슬롯 상세 — 바깥 클릭 닫기 (한 번만 바인드)
    if(!this._trLockCloserBound){
      document.addEventListener('click', ()=>{
        document.querySelectorAll('#training-screen .tr-ln-slot.show-detail').forEach(x=>x.classList.remove('show-detail'));
      });
      this._trLockCloserBound = true;
    }
    // seal action
    panel.querySelector('#tr-btn-seal')?.addEventListener('click', ()=>{
      const slotIdx = this._trainingLnSelectedSlot;
      if(slotIdx == null) return;
      const slot = panel.querySelector(`.tr-ln-slot[data-slot="${slotIdx}"]`);
      if(!slot || !slot.classList.contains('is-learned')) return;
      this._doSealSkill(u, slot.dataset.skill);
    });
    // learn action — 라이브러리 popup
    panel.querySelector('#tr-btn-learn')?.addEventListener('click', ()=>{
      const slotIdx = this._trainingLnSelectedSlot ?? 0;
      this._openTrainingLibrary(u, slotIdx);
    });
  },

  _doSealSkill(u, skillId){
    if(!u || !skillId) return;
    if(RoF.Meta && RoF.Meta.Mastery && typeof RoF.Meta.Mastery.forgetSkill === 'function'){
      RoF.Meta.Mastery.forgetSkill(u, skillId);
    }
    if(Array.isArray(u.bundledSkillIds)){
      u.bundledSkillIds = u.bundledSkillIds.filter(id => id !== skillId);
    }
    if(typeof SFX !== 'undefined' && SFX.play) SFX.play('upgrade');
    this.persist && this.persist();
    this._renderTrainingLearning();
  },

  // ─── 4. ENGRAVING (각인) ─────────────────────────────────────────
  _renderTrainingEngraving(){
    const panel = document.querySelector('#training-screen .tr-panel[data-panel="engraving"]');
    if(!panel) return;
    const u = this._trainingActiveUnit();
    if(!u){
      panel.innerHTML = '<div class="tr-info-line">유닛을 선택해 주세요.</div>';
      return;
    }
    const unitImgSrc = (RoF.Data && RoF.Data.CARD_IMG && RoF.Data.CARD_IMG[u.id]) || 'img/units/bronze/militia/card.png';
    const bundled = Array.isArray(u.bundledSkillIds) ? u.bundledSkillIds : [];
    const mastery = u.skillMastery || {};
    const eligibleHTML = bundled.map(skillId=>{
      const sk = (typeof SKILLS_DB !== 'undefined' && Array.isArray(SKILLS_DB) ? SKILLS_DB : ((RoF.Data && RoF.Data.SKILLS) || [])).find(s => s && s.id === skillId);
      const name = sk?.name || skillId;
      const desc = (sk?.desc || sk?.ability || '').slice(0, 24);
      const imgSrc = (RoF.Data && RoF.Data.CARD_IMG && RoF.Data.CARD_IMG[skillId]) || 'img/units/bronze/militia/card.png';
      const m = mastery[skillId] || { level: 0 };
      const isReady = m.level >= 10;
      const isEngraved = m.engraved === true;
      const cls = 'tr-eg-card' + (isEngraved ? ' is-engraved' : '') + (!isReady && !isEngraved ? ' tr-eg-locked' : '');
      const lvLabel = isReady ? 'Lv 10' : `Lv ${m.level}`;
      const mark = isEngraved ? `<div class="tr-eg-mark">✔ 각인됨</div>` : '';
      return `<div class="${cls}" data-skill="${skillId}">
        <div class="tr-eg-art" style="background-image:url('${imgSrc}')"></div>
        <div class="tr-eg-lv">${lvLabel}</div>
        <div class="tr-eg-name">${name}</div>
        <div class="tr-eg-desc">${desc}</div>
        ${mark}
      </div>`;
    }).join('');

    panel.innerHTML = `
      <div class="tr-act" style="margin-bottom:14px;">
        <button class="tr-btn" id="tr-btn-engrave">각 인 ▶</button>
        <span class="tr-act-hint">Lv 10 스킬 선택 후 클릭</span>
        <div class="tr-cost-tag"><span class="tr-coin-sm">G</span><b>1,200</b> 골드</div>
      </div>
      <div class="tr-ds-head" style="margin-bottom:10px;"><span class="lbl">— Lv 10 스킬 카드 · 각인 가능</span><span class="line"></span><span style="font:400 9px/1 'Noto Sans KR';letter-spacing:.25em;color:var(--tr-text-3);">각인된 스킬은 학습으로 공유된다</span></div>
      <div class="tr-skill-layout">
        <div class="tr-skill-prof">
          <div class="tr-sp-art"><img src="${unitImgSrc}" alt=""></div>
          <button class="tr-sp-name-btn">${u.name || u.id}<span class="lv">Lv ${u.level || 1}</span></button>
        </div>
        <div class="tr-eg-row" id="tr-eg-grid" style="margin:0;">${eligibleHTML || '<div class="tr-info-line" style="grid-column:1/-1;">이 유닛의 시그니처 풀이 비어있다.</div>'}</div>
      </div>
      <div class="tr-info-line" style="margin-top:14px;">Lv 10 에 도달한 스킬만 각인할 수 있다. 각인된 스킬은 <b style="color:var(--tr-gilt-pale);font-style:normal;">학습 탭</b>의 라이브러리에 등록되어 어떤 유닛도 익혀 쓸 수 있게 된다.</div>
    `;
    this._trainingMountV4Cards();
    // card select
    panel.querySelectorAll('#tr-eg-grid .tr-eg-card').forEach(c=>{
      c.addEventListener('click', ()=>{
        if(c.classList.contains('is-engraved') || c.classList.contains('tr-eg-locked')) return;
        panel.querySelectorAll('#tr-eg-grid .tr-eg-card').forEach(x=>x.classList.remove('is-sel'));
        c.classList.add('is-sel');
        this._trainingEgSelectedSkill = c.dataset.skill;
      });
    });
    panel.querySelector('#tr-btn-engrave')?.addEventListener('click', ()=>{
      if(!this._trainingEgSelectedSkill) return;
      this._doEngraveSkill(u, this._trainingEgSelectedSkill);
    });
  },

  _doEngraveSkill(u, skillId){
    if(!u || !skillId) return;
    if(RoF.Meta && RoF.Meta.Engraving && typeof RoF.Meta.Engraving.createEngraving === 'function'){
      const eng = RoF.Meta.Engraving.createEngraving(u, skillId);
      if(eng && typeof RoF.Meta.Engraving.add === 'function'){
        RoF.Meta.Engraving.add(this, eng);
      }
    }
    if(u.skillMastery && u.skillMastery[skillId]){
      u.skillMastery[skillId].engraved = true;
      u.skillMastery[skillId].locked = true;
    }
    if(typeof SFX !== 'undefined' && SFX.play) SFX.play('rarity_up');
    this.persist && this.persist();
    this._renderTrainingEngraving();
  },

  // ─── 5. UPGRADE (강화) ───────────────────────────────────────────
  _renderTrainingUpgrade(){
    const panel = document.querySelector('#training-screen .tr-panel[data-panel="upgrade"]');
    if(!panel) return;
    const u = this._trainingActiveUnit();
    if(!u){
      panel.innerHTML = '<div class="tr-info-line">유닛을 선택해 주세요.</div>';
      return;
    }
    const unitImgSrc = (RoF.Data && RoF.Data.CARD_IMG && RoF.Data.CARD_IMG[u.id]) || 'img/units/bronze/militia/card.png';
    const bundled = Array.isArray(u.bundledSkillIds) ? u.bundledSkillIds : [];
    const mastery = u.skillMastery || {};
    const eligibleHTML = bundled.map(skillId=>{
      const sk = (typeof SKILLS_DB !== 'undefined' && Array.isArray(SKILLS_DB) ? SKILLS_DB : ((RoF.Data && RoF.Data.SKILLS) || [])).find(s => s && s.id === skillId);
      const name = sk?.name || skillId;
      const desc = (sk?.desc || sk?.ability || '').slice(0, 24);
      const imgSrc = (RoF.Data && RoF.Data.CARD_IMG && RoF.Data.CARD_IMG[skillId]) || 'img/units/bronze/militia/card.png';
      const m = mastery[skillId] || { level: 0 };
      const isReady = m.level >= 10;
      const isUpgraded = !!m.upgradedTo;
      const cls = 'tr-eg-card' + (isUpgraded ? ' is-engraved' : '') + (!isReady && !isUpgraded ? ' tr-eg-locked' : '');
      const lvLabel = isReady ? 'Lv 10' : `Lv ${m.level}`;
      const mark = isUpgraded ? `<div class="tr-eg-mark">✔ 강화됨</div>` : '';
      return `<div class="${cls}" data-skill="${skillId}">
        <div class="tr-eg-art" style="background-image:url('${imgSrc}')"></div>
        <div class="tr-eg-lv">${lvLabel}</div>
        <div class="tr-eg-name">${name}</div>
        <div class="tr-eg-desc">${desc}</div>
        ${mark}
      </div>`;
    }).join('');

    panel.innerHTML = `
      <div class="tr-act" style="margin-bottom:14px;">
        <button class="tr-btn secondary" id="tr-btn-stat-upgrade">✦ 스탯 강화</button>
        <button class="tr-btn" id="tr-btn-upgrade">영 구 강 화 ▶</button>
        <button class="tr-btn danger" id="tr-btn-upgrade-revert">↺ 영구 회귀</button>
        <span class="tr-act-hint">Lv 10 스킬 선택 후 클릭</span>
        <div class="tr-cost-tag"><span class="tr-coin-sm">G</span><b>1,800</b> 골드</div>
      </div>
      <div class="tr-ds-head" style="margin-bottom:10px;"><span class="lbl">— Lv 10 스킬 카드 · 강화 가능</span><span class="line"></span><span style="font:400 9px/1 'Noto Sans KR';letter-spacing:.25em;color:var(--tr-text-3);">강화 시 2 가지 진화 중 하나 선택 (영구)</span></div>
      <div class="tr-skill-layout">
        <div class="tr-skill-prof">
          <div class="tr-sp-art"><img src="${unitImgSrc}" alt=""></div>
          <button class="tr-sp-name-btn">${u.name || u.id}<span class="lv">Lv ${u.level || 1}</span></button>
        </div>
        <div class="tr-eg-row" id="tr-up-grid" style="margin:0;">${eligibleHTML || '<div class="tr-info-line" style="grid-column:1/-1;">이 유닛의 시그니처 풀이 비어있다.</div>'}</div>
      </div>
      <div class="tr-info-line" style="margin-top:14px;">강화하면 2 가지 진화 중 하나를 영구 선택한다. 강화된 카드는 시그니처 풀에서 base 와 swap 된다. 재학습 시 base 는 Lv 1 부터 다시.</div>
    `;
    this._trainingMountV4Cards();
    // card select
    panel.querySelectorAll('#tr-up-grid .tr-eg-card').forEach(c=>{
      c.addEventListener('click', ()=>{
        if(c.classList.contains('is-engraved') || c.classList.contains('tr-eg-locked')) return;
        panel.querySelectorAll('#tr-up-grid .tr-eg-card').forEach(x=>x.classList.remove('is-sel'));
        c.classList.add('is-sel');
        this._trainingUpSelectedSkill = c.dataset.skill;
      });
    });
    panel.querySelector('#tr-btn-upgrade')?.addEventListener('click', ()=>{
      if(!this._trainingUpSelectedSkill) return;
      this._openTrainingUpgradeConfirm(u, this._trainingUpSelectedSkill);
    });
    panel.querySelector('#tr-btn-stat-upgrade')?.addEventListener('click', ()=>{
      if(!this._trainingUpSelectedSkill) return;
      this._openTrainingStatUpgrade(u, this._trainingUpSelectedSkill);
    });
    panel.querySelector('#tr-btn-upgrade-revert')?.addEventListener('click', ()=>this._openTrainingRevert('영구 회귀'));
  },

  _doUpgradeSkill(u, skillId, choiceIdx){
    if(!u || !skillId) return;
    let choices = null;
    if(RoF.Meta && RoF.Meta.Upgrade && typeof RoF.Meta.Upgrade.availableChoices === 'function'){
      choices = RoF.Meta.Upgrade.availableChoices(u, skillId);
    }
    const choice = (choices && choices[choiceIdx]) || null;
    if(u.skillMastery && u.skillMastery[skillId]){
      u.skillMastery[skillId].upgradedTo = choice?.id || null;
    }
    if(typeof SFX !== 'undefined' && SFX.play) SFX.play('rarity_up');
    this.persist && this.persist();
    this._renderTrainingUpgrade();
  },

  _doRelearnSkill(u, baseSkillId){
    if(!u || !baseSkillId) return;
    if(RoF.Meta && RoF.Meta.Upgrade && typeof RoF.Meta.Upgrade.RELEARN_COST_GOLD === 'object'){
      const rarity = (RoF.Data?.SKILLS_DB?.[baseSkillId]?.rarity) || 'bronze';
      const cost = RoF.Meta.Upgrade.RELEARN_COST_GOLD[rarity] || 100;
      if(this.gold < cost) return;
      this.gold -= cost;
    }
    if(u.skillMastery && u.skillMastery[baseSkillId]){
      u.skillMastery[baseSkillId].level = 1;
      u.skillMastery[baseSkillId].xp = 0;
      u.skillMastery[baseSkillId].upgradedTo = null;
    }
    this.persist && this.persist();
  },

  // ─── helper: V4 카드 mount ────────────────────────────────────────
  _trainingMountV4Cards(){
    document.querySelectorAll('#training-screen [data-tr-mount="card-v4"]').forEach(host=>{
      const uid = host.dataset.uid;
      if(!uid) return;
      const list = this._trainingUnitList();
      const u = list.find(x => x.uid === uid);
      if(!u) return;
      host.innerHTML = '';
      if(typeof mkCardElV4 === 'function'){
        const card = mkCardElV4(u, { frameMode: 'hand' });
        if(card) host.appendChild(card);
      }
    });
  },

  // ─── 확대 popup: 캐릭터 프로필 zoom (좌측 사이드 클릭 시) ──────────
  _openTrainingProfileZoom(u){
    if(!u) return;
    const overlay = document.querySelector('#training-screen .tr-tz-overlay');
    if(!overlay) return;
    const imgSrc = (RoF.Data && RoF.Data.CARD_IMG && RoF.Data.CARD_IMG[u.id]) || 'img/units/bronze/militia/card.png';
    const img = overlay.querySelector('.tr-tz-img');
    if(img) img.src = imgSrc;
    // info panel populate
    const rarity = u.rarity || u.tier || 'bronze';
    const rarLabel = { bronze:'일반', silver:'희귀', gold:'고귀한', legendary:'전설의', divine:'신' }[rarity];
    const elemMap = { fire:'🔥 화염', water:'💧 물', earth:'🌿 대지', lightning:'⚡ 번개', holy:'✨ 신성', dark:'🌑 암흑' };
    const elem = elemMap[u.element || 'fire'] || u.element;
    const role = u._heroRole || u.role || '—';
    const isHero = u._isHero === true;
    const nameEl = overlay.querySelector('.tr-tz-title .nm');
    const lvEl = overlay.querySelector('.tr-tz-title .lv');
    if(nameEl) nameEl.textContent = (isHero ? '⚔ ' : '') + (u.name || u.id);
    if(lvEl) lvEl.textContent = 'Lv ' + (u.level || 1);
    // flavor / desc (캐릭터 lore — placeholder)
    const flavorEl = overlay.querySelector('.tr-tz-flavor');
    if(flavorEl) flavorEl.textContent = isHero ? '여명의 길을 걷는 자' : (rarLabel + ' 동료');
    const descEl = overlay.querySelector('.tr-tz-desc');
    if(descEl) descEl.textContent = u.desc || u.flavor || '운명의 실타래가 그를 이곳에 데려왔다.';
    // chips
    const chipsEl = overlay.querySelector('.tr-tz-chips');
    if(chipsEl){
      chipsEl.innerHTML = `
        <span class="tr-tz-chip tone-el">${elem}</span>
        <span class="tr-tz-chip tone-rar">${rarLabel}</span>
        <span class="tr-tz-chip tone-role">${role}</span>
      `;
    }
    // stats (HP/ATK/DEF/SOUL 4-col)
    const statsEl = overlay.querySelector('.tr-tz-stats');
    if(statsEl){
      statsEl.innerHTML = `
        <div class="tr-tz-stat hp"><div class="k">HP</div><div class="v">${u.hp || 0}</div></div>
        <div class="tr-tz-stat atk"><div class="k">ATK</div><div class="v">${u.atk || 0}</div></div>
        <div class="tr-tz-stat def"><div class="k">DEF</div><div class="v">${u.def || 0}</div></div>
        <div class="tr-tz-stat soul"><div class="k">SOUL</div><div class="v">${u.SOUL || u.soul || 0}</div></div>
      `;
    }
    overlay.classList.add('is-active');
  },

  // ─── 확대 popup: 스킬 카드 zoom (eg-card 클릭 시 V4 카드 mount) ─────
  _openTrainingSkillZoom(skillId){
    if(!skillId) return;
    const overlay = document.querySelector('#training-screen .tr-sk-zoom');
    if(!overlay) return;
    const host = overlay.querySelector('[data-tr-mount="sk-card-v4"]');
    if(!host) return;
    host.innerHTML = '';
    // 정본 SKILLS_DB lookup — RoF.Data.SKILLS 배열 (Object.freeze) 또는 window.SKILLS_DB (alias)
    const SKILLS = (typeof SKILLS_DB !== 'undefined' && Array.isArray(SKILLS_DB)) ? SKILLS_DB
                 : ((RoF.Data && RoF.Data.SKILLS) || []);
    const sk = SKILLS.find(s => s && s.id === skillId);
    if(sk && typeof mkCardElV4 === 'function'){
      const card = mkCardElV4(sk, { frameMode: 'hand' });
      if(card) host.appendChild(card);
    }
    overlay.classList.add('is-active');
  },

  _closeTrainingZoom(){
    document.querySelectorAll('#training-screen .tr-tz-overlay, #training-screen .tr-sk-zoom, #training-screen .tr-ls-pop').forEach(el=>{
      el.classList.remove('is-active');
    });
  },

  // ─── ALL popup 헬퍼 (2026-05-25 시안 정합 11 popup 정본화) ────────
  _openTrainingPopup(selector){
    const pop = document.querySelector('#training-screen ' + selector);
    if(pop) pop.classList.add('is-active');
    return pop;
  },
  _closeTrainingPopup(selector){
    const pop = document.querySelector('#training-screen ' + selector);
    if(pop) pop.classList.remove('is-active');
  },
  _closeAllTrainingPopups(){
    document.querySelectorAll('#training-screen .tr-stat-pop, #training-screen .tr-lvup-overlay, #training-screen .tr-aw-pop, #training-screen .tr-su-pop, #training-screen .tr-uc-pop, #training-screen .tr-lib-pop, #training-screen .tr-la-pop, #training-screen .tr-confirm-pop, #training-screen .tr-ls-pop, #training-screen .tr-sk-zoom, #training-screen .tr-tz-overlay, #training-screen .tr-eg-pop, #training-screen .tr-help-pop').forEach(el=>{
      el.classList.remove('is-active');
    });
  },

  // ─── 수련 — STAT 분배 popup ──────────────────────────────────────
  _openTrainingStatPop(u){
    if(!u) return;
    const pop = document.querySelector('#training-screen .tr-stat-pop');
    if(!pop) return;
    const isHero = u._isHero === true;
    // SOUL 픽은 영웅만
    const soulPick = pop.querySelector('.tr-stat-pick[data-stat="soul"]');
    if(soulPick) soulPick.style.display = isHero ? '' : 'none';
    const remain = u.freePoints || 0;
    const remainEl = pop.querySelector('.tr-stat-remain');
    if(remainEl) remainEl.textContent = remain;
    pop.classList.add('is-active');
  },
  _doStatAlloc(u, stat){
    if(!u || !stat) return;
    // 정본 헬퍼로 위임 (대문자 ATK/HP/SOUL + 미러 → V4 카드 즉시 반영, 레벨업 오버레이와 동일 경로)
    const ok = (RoF.Game && RoF.Game.allocStatPoint) ? RoF.Game.allocStatPoint(u, stat) : false;
    if(!ok) return;
    if(typeof SFX !== 'undefined' && SFX.play) SFX.play('upgrade');
    this.persist && this.persist();
    this._openTrainingStatPop(u); // refresh
    if(this._trainingActiveTab === 'mastery') this._renderTrainingMastery();
  },
  _doStatReset(u){
    if(!u) return;
    // 모든 growthPts 환불 → freePoints 로 복원 (allocStatPoint 와 동일 대문자 필드)
    if(u.growthPts){
      const total = (u.growthPts.atk || 0) + (u.growthPts.hp || 0) + (u.growthPts.soul || 0);
      u.freePoints = (u.freePoints || 0) + total;
      u.ATK = (u.ATK || 0) - (u.growthPts.atk || 0) * 2; u.baseATK = u.ATK; u.curATK = u.ATK;
      u.HP = (u.HP || 0) - (u.growthPts.hp || 0) * 5; u.maxHP = u.HP; u.curHP = u.HP; u.maxHp = u.HP;
      u.SOUL = (u.SOUL || 0) - (u.growthPts.soul || 0);
      u.growthPts = { atk: 0, hp: 0, soul: 0 };
    }
    this.persist && this.persist();
    if(this._trainingActiveTab === 'mastery') this._renderTrainingMastery();
  },

  // ─── 수련 — LVUP burst (시안 line 2195~2233 패턴) ────────────────
  _triggerTrainingLvupBurst(){
    const overlay = document.querySelector('#training-screen .tr-lvup-overlay');
    if(!overlay) return;
    overlay.classList.add('is-active');
    setTimeout(()=>overlay.classList.remove('is-active'), 1300);
  },

  // ─── 각성 — 1~3 form swap 선택 popup (v2 2026-05-26) ────────────
  _openTrainingAwakenChoice(u){
    if(!u) return;
    const pop = document.querySelector('#training-screen .tr-aw-pop:not(.tr-up-choice-pop)');
    if(!pop) return;
    const grid = pop.querySelector('.tr-aw-grid');
    if(!grid) return;
    const A = RoF.Meta && RoF.Meta.Awakening;
    if(!A){ console.warn('[Training] Awakening module missing'); return; }
    // v2: form 데이터 보장 + 진화 후보 (1~3) 로드
    A.ensureFormsData(u, u.baseId || u.id, u.activeForm || u.id, u.rarity);
    const opts = A.evolveOptions(u);
    const rarLabel = { bronze:'일반', silver:'희귀', gold:'고귀한', legendary:'전설', divine:'신' };
    const elemMap = { fire:'화염', water:'물', earth:'대지', lightning:'번개', holy:'신성', dark:'암흑' };

    if(!opts || opts.length === 0){
      // 진화 후보 미정의 (102 강화 데이터 batch 후 채움)
      grid.innerHTML = '<div class="tr-info-line" style="grid-column:1/-1;text-align:center;padding:40px;color:var(--tr-text-3);">진화 후보가 아직 준비되지 않았습니다.<br><span style="font-size:10px;letter-spacing:.2em;">(데이터 디자인 batch 대기 중)</span></div>';
      pop.classList.add('is-active');
      return;
    }

    grid.innerHTML = opts.map((opt, i)=>{
      const isLocked = opt.isLocked;
      const lockMsg = isLocked
        ? `<div class="tr-aw-lock-msg" style="display:block;">✦ ${opt.unlock?.quest ? '운명의 인장이 필요합니다' : opt.unlock?.item ? '아이템이 필요합니다' : '잠금됨'}</div>`
        : '';
      const imgSrc = (RoF.Data && RoF.Data.CARD_IMG && RoF.Data.CARD_IMG[opt.imgKey]) || 'img/units/bronze/militia/card.png';
      const tags = [rarLabel[opt.rarity] || opt.rarity, elemMap[u.element] || ''].filter(Boolean);
      const stat = opt.stat || {};
      const pills = [];
      if(stat.HP != null) pills.push(`<div class="pill hp"><span class="k">HP</span><span class="v">+${stat.HP}</span></div>`);
      if(stat.ATK != null) pills.push(`<div class="pill atk"><span class="k">ATK</span><span class="v">+${stat.ATK}</span></div>`);
      pills.push(`<div class="pill def"><span class="k">골드</span><span class="v">${opt.cost.gold.toLocaleString()}</span></div>`);
      return `<div class="tr-aw-card ${isLocked ? 'is-locked' : ''}" data-aw="${opt.formId}">
        <div class="tr-aw-art" style="background-image:url('${imgSrc}')"></div>
        ${lockMsg}
        <div class="tr-aw-name">${opt.name}</div>
        <div class="tr-aw-tags">${tags.map(t=>`<span class="tr-aw-tag">${t}</span>`).join('')}</div>
        <div class="tr-aw-stats">${pills.join('')}</div>
        <button class="tr-aw-pick-btn">${isLocked ? '🔒 잠금됨' : '이 길을 택한다'}</button>
      </div>`;
    }).join('');

    grid.querySelectorAll('.tr-aw-card').forEach((c)=>{
      const pickBtn = c.querySelector('.tr-aw-pick-btn');
      const formId = c.dataset.aw;
      if(pickBtn && formId){
        pickBtn.addEventListener('click', (e)=>{
          e.stopPropagation();
          if(c.classList.contains('is-locked')) return;
          this._doAwakenUnit(u, formId);
          pop.classList.remove('is-active');
        });
      }
    });
    pop.classList.add('is-active');
  },

  // ─── 강화 — 3 선택 popup ────────────────────────────────────────
  _openTrainingUpgradeChoice(u, skillId){
    if(!u || !skillId) return;
    const pop = document.querySelector('#training-screen .tr-up-choice-pop');
    if(!pop) return;
    const grid = pop.querySelector('.tr-aw-grid');
    if(!grid) return;
    // RoF.Meta.Upgrade.availableChoices(u, skillId) → 2 강화 후보
    let choices = null;
    if(RoF.Meta && RoF.Meta.Upgrade && typeof RoF.Meta.Upgrade.availableChoices === 'function'){
      choices = RoF.Meta.Upgrade.availableChoices(u, skillId);
    }
    // placeholder 2 옵션 + 1 잠금 (시안 패턴)
    if(!choices || choices.length === 0){
      choices = [
        { id: skillId + '_a', name: '광휘의 진화', desc: '강화 데미지 +50%' },
        { id: skillId + '_b', name: '지속의 진화', desc: '지속 1턴 추가' },
      ];
    }
    const imgSrc = (RoF.Data && RoF.Data.CARD_IMG && RoF.Data.CARD_IMG[skillId]) || 'img/units/bronze/militia/card.png';
    const lockChoice = { name: '심판의 빛', locked: true, lockMsg: '✦ 광휘의 인장이 필요합니다', tags: ['신','신성'], stats: { 피해:'+200%' } };
    const all = [...choices.slice(0, 2).map(c => ({...c, locked: false})), lockChoice];
    grid.innerHTML = all.map((c, i)=>{
      const isLocked = c.locked;
      const lockMsg = isLocked ? `<div class="tr-aw-lock-msg" style="display:block;">${c.lockMsg}</div>` : '';
      const tags = c.tags || ['전설','신성'];
      const stats = c.stats || { 버프:'+18', 지속:'+1턴', 대상:'전체' };
      return `<div class="tr-aw-card ${isLocked ? 'is-locked' : ''}" data-up="${i}">
        <div class="tr-aw-art" style="background-image:url('${imgSrc}')"></div>
        ${lockMsg}
        <div class="tr-aw-name">${c.name}</div>
        <div class="tr-aw-tags">${tags.map(t=>`<span class="tr-aw-tag">${t}</span>`).join('')}</div>
        <div class="tr-aw-stats">${Object.entries(stats).map(([k,v])=>`<div class="pill ${k}"><span class="k">${k}</span><span class="v">${v}</span></div>`).join('')}</div>
        <button class="tr-aw-pick-btn">${isLocked ? '🔒 잠금됨' : '이 길을 택한다'}</button>
      </div>`;
    }).join('');
    grid.querySelectorAll('.tr-aw-card').forEach((c, i)=>{
      const pickBtn = c.querySelector('.tr-aw-pick-btn');
      if(pickBtn){
        pickBtn.addEventListener('click', (e)=>{
          e.stopPropagation();
          if(c.classList.contains('is-locked')) return;
          this._doUpgradeSkill(u, skillId, i);
          pop.classList.remove('is-active');
        });
      }
    });
    pop.classList.add('is-active');
  },

  // ─── 강화 — 확인 popup ──────────────────────────────────────────
  _openTrainingUpgradeConfirm(u, skillId){
    const pop = document.querySelector('#training-screen .tr-uc-pop');
    if(!pop) return;
    pop.classList.add('is-active');
    const confirmBtn = pop.querySelector('.tr-uc-confirm');
    const cancelBtn = pop.querySelector('.tr-uc-cancel');
    const close = ()=>pop.classList.remove('is-active');
    if(confirmBtn){
      confirmBtn.onclick = (e)=>{
        e.stopPropagation();
        close();
        setTimeout(()=>this._openTrainingUpgradeChoice(u, skillId), 200);
      };
    }
    if(cancelBtn){
      cancelBtn.onclick = (e)=>{ e.stopPropagation(); close(); };
    }
  },

  // ─── 강화 — STAT UPGRADE popup ──────────────────────────────────
  _openTrainingStatUpgrade(u, skillId){
    if(!u || !skillId) return;
    // 임시: skillMastery[skillId].statPoints || 0
    const mastery = (u.skillMastery && u.skillMastery[skillId]) || {};
    const points = mastery.statPoints || 0;
    if(points <= 0){
      this._openTrainingPopup('.tr-su-warn-pop');
      return;
    }
    const pop = document.querySelector('#training-screen .tr-su-pop:not(.tr-su-warn-pop)');
    if(!pop) return;
    const orb = pop.querySelector('.tr-su-remain-orb');
    const num = pop.querySelector('.tr-su-remain-num');
    if(orb) orb.textContent = points;
    if(num) num.textContent = points;
    pop.classList.add('is-active');
  },

  // ─── 학습 — 라이브러리 popup ────────────────────────────────────
  _openTrainingLibrary(u, slotIdx){
    if(!u) return;
    const pop = document.querySelector('#training-screen .tr-lib-pop');
    if(!pop) return;
    const grid = pop.querySelector('.tr-lib-grid');
    if(!grid) return;
    // 정본 SKILLS_DB 에서 학습 가능 스킬 (시그니처 풀 외) 필터 + 등급/원소 표시
    const SKILLS = (typeof SKILLS_DB !== 'undefined' && Array.isArray(SKILLS_DB)) ? SKILLS_DB
                 : ((RoF.Data && RoF.Data.SKILLS) || []);
    // 시안 패턴: 모든 스킬 표시. 향후 각인된 스킬만 필터 가능.
    const skills = SKILLS.slice(0, 24); // 첫 24 placeholder
    const rarMap = { bronze:'common', silver:'rare', gold:'noble', legendary:'legendary', divine:'divine' };
    grid.innerHTML = skills.map(sk=>{
      const imgSrc = (RoF.Data && RoF.Data.CARD_IMG && RoF.Data.CARD_IMG[sk.id]) || 'img/units/bronze/militia/card.png';
      const rarSlug = rarMap[sk.rarity] || 'common';
      return `<div class="tr-eg-card" data-skill="${sk.id}" data-el="${sk.element || 'fire'}" data-rar="${rarSlug}">
        <div class="tr-eg-art" style="background-image:url('${imgSrc}')"></div>
        <div class="tr-eg-lv">${({bronze:'일반', silver:'희귀', gold:'고귀한', legendary:'전설', divine:'신'})[sk.rarity] || '일반'}</div>
        <div class="tr-eg-name">${sk.name || sk.id}</div>
        <div class="tr-eg-desc">${(sk.desc || sk.ability || '').slice(0,20)}</div>
      </div>`;
    }).join('');
    this._trainingLnSelectedSlot = slotIdx;
    // pick handler
    grid.querySelectorAll('.tr-eg-card').forEach(c=>{
      c.addEventListener('click', (e)=>{
        e.stopPropagation();
        this._trainingLibPicked = c.dataset.skill;
        this._openTrainingLearningAction(c.dataset.skill);
      });
    });
    // filter chips
    let libEl = 'all', libRar = 'all';
    const applyFilter = ()=>{
      grid.querySelectorAll('.tr-eg-card').forEach(c=>{
        const okEl = libEl === 'all' || c.dataset.el === libEl;
        const okRar = libRar === 'all' || c.dataset.rar === libRar;
        c.style.display = okEl && okRar ? '' : 'none';
      });
    };
    pop.querySelectorAll('.tr-lib-chip[data-el]').forEach(b=>{
      b.onclick = ()=>{
        pop.querySelectorAll('.tr-lib-chip[data-el]').forEach(x=>x.classList.remove('is-active'));
        b.classList.add('is-active');
        libEl = b.dataset.el;
        applyFilter();
      };
    });
    pop.querySelectorAll('.tr-lib-chip[data-rar]').forEach(b=>{
      b.onclick = ()=>{
        pop.querySelectorAll('.tr-lib-chip[data-rar]').forEach(x=>x.classList.remove('is-active'));
        b.classList.add('is-active');
        libRar = b.dataset.rar;
        applyFilter();
      };
    });
    pop.classList.add('is-active');
  },

  // ─── 학습 — 액션 선택 popup (학습/줌) ──────────────────────────
  _openTrainingLearningAction(skillId){
    if(!skillId) return;
    const pop = document.querySelector('#training-screen .tr-la-pop');
    if(!pop) return;
    const SKILLS = (typeof SKILLS_DB !== 'undefined' && Array.isArray(SKILLS_DB)) ? SKILLS_DB
                 : ((RoF.Data && RoF.Data.SKILLS) || []);
    const sk = SKILLS.find(s => s && s.id === skillId);
    const titleEl = pop.querySelector('.tr-la-title');
    if(titleEl) titleEl.textContent = sk?.name || skillId;
    const learnBtn = pop.querySelector('.tr-la-act-learn');
    const zoomBtn = pop.querySelector('.tr-la-act-zoom');
    if(learnBtn){
      learnBtn.onclick = (e)=>{
        e.stopPropagation();
        pop.classList.remove('is-active');
        this._openTrainingLearningConfirm(skillId);
      };
    }
    if(zoomBtn){
      zoomBtn.onclick = (e)=>{
        e.stopPropagation();
        pop.classList.remove('is-active');
        this._openTrainingLsZoom(skillId);
      };
    }
    pop.classList.add('is-active');
  },

  // ─── 학습 — 확인 popup ──────────────────────────────────────────
  _openTrainingLearningConfirm(skillId){
    if(!skillId) return;
    const pop = document.querySelector('#training-screen .tr-lc-pop');
    if(!pop) return;
    const SKILLS = (typeof SKILLS_DB !== 'undefined' && Array.isArray(SKILLS_DB)) ? SKILLS_DB
                 : ((RoF.Data && RoF.Data.SKILLS) || []);
    const sk = SKILLS.find(s => s && s.id === skillId);
    const nameEl = pop.querySelector('.tr-lc-skill-name');
    const costEl = pop.querySelector('.tr-lc-cost');
    const warnEl = pop.querySelector('.tr-confirm-warn');
    const oldEl = pop.querySelector('.tr-lc-old-skill');
    if(nameEl) nameEl.textContent = sk?.name || skillId;
    if(costEl) costEl.textContent = '800';
    // 슬롯에 기존 스킬 있으면 warn 표시
    const u = this._trainingActiveUnit();
    const slotIdx = this._trainingLnSelectedSlot;
    if(u && Array.isArray(u.bundledSkillIds) && u.bundledSkillIds[slotIdx]){
      const oldSk = SKILLS.find(s => s && s.id === u.bundledSkillIds[slotIdx]);
      if(oldEl) oldEl.textContent = oldSk?.name || u.bundledSkillIds[slotIdx];
      if(warnEl) warnEl.classList.add('is-show');
    } else if(warnEl) {
      warnEl.classList.remove('is-show');
    }
    const yes = pop.querySelector('.tr-lc-yes');
    const no = pop.querySelector('.tr-lc-no');
    if(yes){
      yes.onclick = (e)=>{
        e.stopPropagation();
        pop.classList.remove('is-active');
        this._doLearnSkill(u, slotIdx, skillId);
        this._closeTrainingPopup('.tr-lib-pop');
      };
    }
    if(no){
      no.onclick = (e)=>{ e.stopPropagation(); pop.classList.remove('is-active'); };
    }
    pop.classList.add('is-active');
  },
  _doLearnSkill(u, slotIdx, skillId){
    if(!u || slotIdx == null || !skillId) return;
    if(!Array.isArray(u.bundledSkillIds)) u.bundledSkillIds = [];
    u.bundledSkillIds[slotIdx] = skillId;
    if(typeof SFX !== 'undefined' && SFX.play) SFX.play('upgrade');
    this.persist && this.persist();
    if(this._trainingActiveTab === 'learning') this._renderTrainingLearning();
  },

  // ─── 학습 — 스킬 줌 popup ──────────────────────────────────────
  _openTrainingLsZoom(skillId){
    if(!skillId) return;
    const pop = document.querySelector('#training-screen .tr-ls-pop');
    if(!pop) return;
    const SKILLS = (typeof SKILLS_DB !== 'undefined' && Array.isArray(SKILLS_DB)) ? SKILLS_DB
                 : ((RoF.Data && RoF.Data.SKILLS) || []);
    const sk = SKILLS.find(s => s && s.id === skillId);
    const imgSrc = (RoF.Data && RoF.Data.CARD_IMG && RoF.Data.CARD_IMG[skillId]) || 'img/units/bronze/militia/card.png';
    const img = pop.querySelector('.tr-ls-img');
    if(img) img.src = imgSrc;
    const nameEl = pop.querySelector('.tr-ls-info .nm');
    if(nameEl) nameEl.textContent = sk?.name || skillId;
    const descEl = pop.querySelector('.tr-ls-info .desc');
    if(descEl) descEl.textContent = sk?.desc || sk?.ability || '—';
    const elMap = { fire:'🔥 화염', water:'💧 물', earth:'🌿 대지', lightning:'⚡ 번개', holy:'✨ 신성', dark:'🌑 암흑' };
    const rarLabel = { bronze:'일반', silver:'희귀', gold:'고귀한', legendary:'전설', divine:'신' };
    const elTag = pop.querySelector('.tr-ls-tag-el');
    const rarTag = pop.querySelector('.tr-ls-tag-rar');
    if(elTag) elTag.textContent = elMap[sk?.element || 'fire'] || '화';
    if(rarTag) rarTag.textContent = rarLabel[sk?.rarity || 'bronze'] || '일반';
    pop.classList.add('is-active');
  },

  // ─── 회귀 의식 (v2 2026-05-26) — RoF.Meta.Awakening.revert 호출 ─
  _openTrainingRevert(label){
    const pop = document.querySelector('#training-screen .tr-revert-pop');
    if(!pop) return;
    const u = this._trainingActiveUnit && this._trainingActiveUnit();
    const A = RoF.Meta && RoF.Meta.Awakening;
    const titleEl = pop.querySelector('.tr-revert-title');
    if(titleEl) titleEl.textContent = label || '회귀 의식';
    const yes = pop.querySelector('.tr-revert-yes');
    const no = pop.querySelector('.tr-revert-no');
    const close = ()=>pop.classList.remove('is-active');

    // v2: 신(divine) form 회귀 불가 + 인장/골드 부족 시 disable
    const canRevert = u && A && A.canRevert(u);
    if(yes){
      yes.disabled = !canRevert;
      yes.style.opacity = canRevert ? '' : '0.4';
      yes.onclick = (e)=>{
        e.stopPropagation();
        if(!canRevert){ console.warn('[Training] 회귀 불가:', u ? (A.getActiveFormData(u)?.rarity === 'divine' ? '신 form 영구' : '옛 form 데이터 없음') : 'no unit'); close(); return; }
        const r = A.revert(u);
        if(!r.ok){ console.warn('[Training] 회귀 실패:', r.reason); close(); return; }
        if(typeof SFX !== 'undefined' && SFX.play) SFX.play('rarity_up');
        close();
        if(typeof this._renderTrainingAwakening === 'function') this._renderTrainingAwakening();
        if(typeof this._renderTrainingPartyRail === 'function') this._renderTrainingPartyRail();
      };
    }
    if(no) no.onclick = (e)=>{ e.stopPropagation(); close(); };
    pop.classList.add('is-active');
  },

  // ─── help popup ──────────────────────────────────────────────────
  _trainingHelpOpen(){
    const HELP = {
      mastery: {
        tag: '수련 · MASTERY',
        title: '레벨을 올려 스킬을 단련한다',
        body: '<p>유닛 카드 자체가 아니라 <b>시그니처 스킬</b>이 Lv 1~10 으로 단련된다. 매치 중 스킬을 사용하면 자동으로 XP 가 누적된다.</p><p>Lv 10 에 도달한 스킬은 <b>각인</b> 또는 <b>강화</b>의 길이 열린다.</p>',
      },
      awakening: {
        tag: '각성 · AWAKENING',
        title: '유닛의 등급을 진화시킨다',
        body: '<p>각성은 유닛의 <b>등급</b>을 한 단계 끌어올린다. 일반 → 희귀 → 고귀한 → 전설 → 신 순서.</p><p>각성 의식 시작 시 신탁이 <b>3 가지 진화 형태</b>를 제시한다. 그 중 하나만 영구 선택된다.</p>',
      },
      learning: {
        tag: '학습 · LEARNING',
        title: '스킬을 익혀 슬롯에 새긴다',
        body: '<p>각 유닛은 <b>10개의 학습 슬롯</b>을 가진다. 슬롯 선택 → 학습 ▶ 으로 라이브러리에서 익힐 수 있다.</p><p><b>봉인</b>은 활성 스킬을 슬롯에서 비운다(잊기). 비운 슬롯에는 다시 학습 가능.</p>',
      },
      engraving: {
        tag: '각인 · ENGRAVING',
        title: 'Lv 10 스킬을 영혼의 서고에 새긴다',
        body: '<p>스킬을 <b>Lv 10</b> 까지 단련하면 각인할 수 있다. 각인된 스킬은 <b>학습 풀</b>에 등록되어 어떤 유닛도 익혀 쓸 수 있게 된다.</p><p>각인은 유닛을 넘어 부대 전체의 자산이 된다.</p>',
      },
      upgrade: {
        tag: '강화 · UPGRADE',
        title: '스킬을 영구히 진화시킨다',
        body: '<p>Lv 10 도달 시 <b>영구 강화</b> 가능. 신탁이 <b>2 가지 진화 형태</b>를 제시하며, 그 중 하나로 영구 변환된다.</p><p>강화된 카드는 base 와 시그니처 풀에서 swap 된다. 재학습 시 base 는 Lv 1 부터.</p>',
      },
    };
    const tab = this._trainingActiveTab;
    const data = HELP[tab] || HELP.mastery;
    const pop = document.querySelector('#training-screen .tr-help-pop');
    if(!pop) return;
    pop.querySelector('.tr-help-tag').textContent = data.tag;
    pop.querySelector('.tr-help-title').textContent = data.title;
    pop.querySelector('.tr-help-body').innerHTML = data.body;
    pop.classList.add('is-active');
  },
});

// ─── DOMContentLoaded 시점 1회 이벤트 바인딩 (tabs / help button / source toggle) ───
(function bindTraining(){
  function bind(){
    const screen = document.getElementById('training-screen');
    if(!screen) return;
    // tab 클릭
    screen.querySelectorAll('.tr-tab').forEach(t=>{
      t.addEventListener('click', ()=>{
        const tab = t.dataset.tab;
        if(!RoF.Game) return;
        if(tab === 'mastery') RoF.Game.showTrainingMasteryTab();
        else if(tab === 'awakening') RoF.Game.showTrainingAwakeningTab();
        else if(tab === 'learning') RoF.Game.showTrainingLearningTab();
        else if(tab === 'engraving') RoF.Game.showTrainingEngravingTab();
        else if(tab === 'upgrade') RoF.Game.showTrainingUpgradeTab();
      });
    });
    // help button
    const helpBtn = screen.querySelector('.tr-help-btn');
    if(helpBtn) helpBtn.addEventListener('click', ()=>RoF.Game._trainingHelpOpen());
    const helpPop = screen.querySelector('.tr-help-pop');
    if(helpPop) helpPop.addEventListener('click', ()=>helpPop.classList.remove('is-active'));
    // source toggle (전열 / 전체 유닛)
    screen.querySelectorAll('.tr-src-btn').forEach(b=>{
      b.addEventListener('click', ()=>{
        screen.querySelectorAll('.tr-src-btn').forEach(x=>x.classList.remove('is-active'));
        b.classList.add('is-active');
        const rail = screen.querySelector('.tr-rail');
        if(rail) rail.classList.toggle('show-all', b.dataset.src === 'all');
        if(RoF.Game) RoF.Game._trainingApplyFilter();
      });
    });

    // ── 확대 popup 클릭 핸들러 (2026-05-25 시안 정합, 사용자 명시 단일 클릭 = zoom) ────
    // 좌측 프로필 자리 (.tr-dc-art / .tr-sp-art) 클릭 → 캐릭터 프로필 zoom
    screen.addEventListener('click', (e)=>{
      const dcArt = e.target.closest('.tr-dc-art, .tr-sp-art');
      if(dcArt && RoF.Game){
        const u = RoF.Game._trainingActiveUnit();
        if(u) RoF.Game._openTrainingProfileZoom(u);
        return;
      }
      // 그리드 스킬 카드 (.tr-eg-card) 클릭 → V4 카드 zoom (단일 클릭, 사용자 명시)
      // is-engraved / locked / is-empty / ln-slot 제외
      const egCard = e.target.closest('.tr-eg-card[data-skill]');
      if(egCard && !egCard.classList.contains('is-engraved') && !egCard.classList.contains('tr-eg-locked') && RoF.Game){
        const skillId = egCard.dataset.skill;
        RoF.Game._openTrainingSkillZoom(skillId);
        // select 도 동시 (액션 버튼 외부 act-strip 에서 사용)
      }
    });
    // 닫기 — overlay 바깥 클릭 / 닫기 버튼 / ESC
    const tzOverlay = screen.querySelector('.tr-tz-overlay');
    const skZoom = screen.querySelector('.tr-sk-zoom');
    if(tzOverlay){
      tzOverlay.addEventListener('click', (e)=>{
        if(e.target === tzOverlay || e.target.classList.contains('tr-tz-close') || e.target.closest('.tr-tz-close')){
          tzOverlay.classList.remove('is-active');
        }
      });
    }
    if(skZoom){
      skZoom.addEventListener('click', (e)=>{
        if(e.target === skZoom) skZoom.classList.remove('is-active');
      });
    }
    window.addEventListener('keydown', (e)=>{
      if(e.key === 'Escape' && RoF.Game) RoF.Game._closeAllTrainingPopups();
    });
    // 모든 추가 popup 외부 클릭 시 닫기 (자체 onclick=event.stopPropagation 으로 내부 보호)
    const closeOnOutsideClick = (selector)=>{
      const pop = screen.querySelector(selector);
      if(!pop) return;
      pop.addEventListener('click', (e)=>{
        if(e.target === pop) pop.classList.remove('is-active');
      });
    };
    ['.tr-stat-pop', '.tr-aw-pop', '.tr-su-pop', '.tr-uc-pop',
     '.tr-lib-pop', '.tr-la-pop', '.tr-ls-pop', '.tr-eg-pop'].forEach(sel=>{
      screen.querySelectorAll(sel).forEach(pop=>{
        pop.addEventListener('click', (e)=>{
          if(e.target === pop) pop.classList.remove('is-active');
        });
      });
    });
    // stat-pick 클릭 (수련 stat-pop 안)
    screen.querySelectorAll('.tr-stat-pop .tr-stat-pick').forEach(pick=>{
      pick.addEventListener('click', (e)=>{
        e.stopPropagation();
        if(!RoF.Game) return;
        const u = RoF.Game._trainingActiveUnit();
        if(u) RoF.Game._doStatAlloc(u, pick.dataset.stat);
      });
    });
  }
  if(document.readyState === 'loading'){
    document.addEventListener('DOMContentLoaded', bind);
  } else {
    bind();
  }
})();
