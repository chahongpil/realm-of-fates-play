// Game Tavern (술집)
// 2026-05-24 — 선술집 용병모집 v3 정본 적용 (시안 통째 ABC)
//   시안: 0.claulde.design/20260524/선술집_용병모집_디자인_0524/tavern_recruit.html
//   battle_system_decisions.md §선술집 용병 영입 표준 룰 / feature_manifest 3.18
//
// 옛 흐름 보존 (feedback_CRITICAL_design_internal_confirm):
//   - tavernSlots / _generateTavernSlots / _ensureTavernSlots / refreshTavern / persist 무변경
//   - V4 카드 프레임 mkCardElV4(unit, {frameMode:'hand'}) 그대로
//   - 영입 후 옛 로직: this.gold -= cost / this.deck.push / this.tavernSlots[idx]=null / this.persist() / this.showTavernUnit()
//   - 2026-04-29 영웅 영입 폐기 룰 유지 / 2026-05-10 bundled lock 유지

RoF.__gameKeys = RoF.__gameKeys || new Set();
(function(keys){
  for (const k of keys) {
    if (RoF.__gameKeys.has(k)) {
      console.error('[Game] 중복 키 감지:', k);
      RoF.__gameKeyError = true;
    }
    RoF.__gameKeys.add(k);
  }
})(["showTavern", "showTavernUnit", "_generateTavernSlots", "_ensureTavernSlots", "genTavernCards", "refreshTavern",
   "_openTavernZoom", "_closeTavernZoom", "_openTavernHire", "_closeTavernHire", "_tavernRoleLabel", "_tavernTier"]);

// rarity → 시안 tier 매핑 (battle_system_decisions §선술집 데이터 매핑)
const _TAV_TIER = {
  bronze:    'common',
  silver:    'rare',
  gold:      'noble',
  legendary: 'legendary',
  divine:    'divine',
};

// role → 한국어 라벨 + 아이콘 (시안 .role-chip 정합)
const _TAV_ROLE_LABEL = {
  attack:  { icon: '⚔', ko: '근거리' },
  defense: { icon: '⛨', ko: '수호자' },
  support: { icon: '✦', ko: '지원' },
  ranged:  { icon: '🏹', ko: '원거리' },
  magic:   { icon: '✨', ko: '마법사' },
};
function _resolveRoleLabel(u){
  // dmgType / role / 둘 다 활용
  if (u.dmgType === 'magic') return _TAV_ROLE_LABEL.magic;
  if (u.dmgType === 'ranged') return _TAV_ROLE_LABEL.ranged;
  if (u.role && _TAV_ROLE_LABEL[u.role]) return _TAV_ROLE_LABEL[u.role];
  return _TAV_ROLE_LABEL.attack;
}

Object.assign(RoF.Game, {
  _tavernTier(rarity){ return _TAV_TIER[rarity] || 'common'; },
  _tavernRoleLabel(u){ return _resolveRoleLabel(u); },

  showTavern(){
    UI.show('tavern-screen');
    // topbar 골드/보석 갱신
    const goldEl = document.getElementById('tav-gold');
    const gemsEl = document.getElementById('tav-gems');
    if (goldEl) goldEl.textContent = (this.gold || 0).toLocaleString();
    if (gemsEl) gemsEl.textContent = (this.gems || 0).toLocaleString();
    // 덱 pill / 하단 deck-info
    const deckLen = (this.deck && this.deck.length) || 0;
    const deckMax = this.maxDeck || 36;
    const deckEl = document.getElementById('tav-deck');
    const deckLimitEl = document.getElementById('tav-deck-limit');
    if (deckEl) deckEl.textContent = deckLen;
    if (deckLimitEl) deckLimitEl.textContent = deckLen + ' / ' + deckMax;
    // NPC 인사말 (옛 흐름 보존: getNpc('tavern').greet, 골드 부족 시 분기)
    const npc = this.getNpc('tavern');
    const msg = (this.gold || 0) < 5 ? '돈 없으면 물이라도 마시고 가게.' : npc.greet;
    const lineEl = document.getElementById('tav-npc-line');
    if (lineEl) lineEl.textContent = msg;
    // tav-name (호환 hidden)
    const nameEl = document.getElementById('tav-name');
    if (nameEl) nameEl.textContent = `👤 ${Auth.heroName || Auth.user || ''}`;
    this.showTavernUnit();
  },

  showTavernUnit(){
    // 옛 호환: tav-info 텍스트 (hidden 이지만 유지)
    const info = document.getElementById('tav-info');
    if (info) info.textContent = '골드를 지불하고 동료를 영입하세요';
    this.genTavernCards();
  },

  // Generate tavern slots (saved to persist) — 옛 흐름 그대로
  // 2026-04-24: 건물 Lv 시스템 폐기 — slot count 4 고정
  // 2026-05-10: PHASE 6 bundled lock — 시그니처 0 유닛 영입 차단
  _generateTavernSlots(){
    const count = 4;
    const slots = [];
    const usedIds = new Set();
    const isUnlocked = u => (u.bundledSkillIds && u.bundledSkillIds.length > 0) || u._unlock === true;
    // 2026-06-12 — 이미 보유한 캐릭터(id)는 로스터에서 제외 (전열정비 v3 '캐릭터당 1 인스턴스').
    //   옛 로스터는 usedIds(아래)로 슬롯 내부만 dedup → refresh/날짜로 보유 캐릭터 재출현 → 중복 영입 가능했음 (audit #5).
    const ownedId = id => (this.deck || []).some(d => d && d.id === id);
    for (let i = 0; i < count; i++) {
      const r = pickRar(this.getHeroLevel(), 'tavern');
      let pool = UNITS.filter(u => u.rarity === r && !u.id.startsWith('h_') && !usedIds.has(u.id) && isUnlocked(u) && !ownedId(u.id));
      if (!pool.length) pool = UNITS.filter(u => !u.id.startsWith('h_') && !usedIds.has(u.id) && isUnlocked(u) && !ownedId(u.id));
      if (!pool.length) pool = UNITS.filter(u => !u.id.startsWith('h_') && isUnlocked(u) && !ownedId(u.id));
      if (!pool.length) continue;  // 영입할 새 동료가 없으면 슬롯 비움 (중복 제공 방지)
      const b = pool[Math.floor(Math.random() * pool.length)];
      usedIds.add(b.id);
      const cost = ({bronze:5, silver:8, gold:12, legendary:18, divine:25})[b.rarity] || 5;
      slots.push({...b, uid: uid(), level: 1, equips: [], maxHp: b.hp, cost});
    }
    return slots;
  },

  _ensureTavernSlots(){
    const today = new Date().toDateString();
    if (this.tavernDate !== today || !this.tavernSlots) {
      this.tavernSlots = this._generateTavernSlots();
      this.tavernDate = today;
      this.persist();
    }
  },

  genTavernCards(){
    this._ensureTavernSlots();
    const grid = document.getElementById('tav-grid');
    if (!grid) return;
    grid.innerHTML = '';

    this.tavernSlots.forEach((c, idx) => {
      const slot = document.createElement('div');
      slot.className = 'tav-slot';

      if (!c) {
        // 빈 자리 (영입 완료)
        slot.classList.add('is-hired');
        slot.innerHTML = `<div class="tav-empty-msg"><span class="ko">영입됨</span>다음 갱신에 새 인연</div>`;
        grid.appendChild(slot);
        return;
      }

      const tier = this._tavernTier(c.rarity);
      const roleLabel = this._tavernRoleLabel(c);
      const cost = c.cost || 5;
      const canHire = (this.gold || 0) >= cost && ((this.deck && this.deck.length) || 0) < (this.maxDeck || 36);

      // role chip + daily (top-left / top-right)
      const chip = document.createElement('span');
      chip.className = 'tav-role-chip';
      chip.innerHTML = `<span class="icon">${roleLabel.icon}</span>${roleLabel.ko}`;
      slot.appendChild(chip);

      const daily = document.createElement('span');
      daily.className = 'tav-daily';
      daily.innerHTML = `갱신 <b>0/1</b>`;
      slot.appendChild(daily);

      // card wrap + flipper
      const wrap = document.createElement('div');
      wrap.className = 'tav-card-wrap';

      const flipper = document.createElement('div');
      flipper.className = 'tav-flipper';
      flipper.dataset.slot = idx;
      flipper.dataset.tier = tier;

      const fx = document.createElement('div');
      fx.className = 'tav-reveal-fx tier-' + tier;
      flipper.appendChild(fx);

      const flipInner = document.createElement('div');
      flipInner.className = 'tav-flip-inner';

      // back (sigil + amber glow)
      const back = document.createElement('div');
      back.className = 'tav-flip-face tav-flip-back';
      back.innerHTML = `<div class="tav-card-back-art has-glow"></div>`;
      flipInner.appendChild(back);

      // front (V4 카드 — 옛 mkCardElV4 그대로)
      const front = document.createElement('div');
      front.className = 'tav-flip-face tav-flip-front';
      const cardEl = mkCardElV4(c, {frameMode: 'hand'});
      front.appendChild(cardEl);
      flipInner.appendChild(front);

      flipper.appendChild(flipInner);
      wrap.appendChild(flipper);
      slot.appendChild(wrap);

      // price strip + buttons
      const strip = document.createElement('div');
      strip.className = 'tav-price-strip';

      const priceTag = document.createElement('div');
      priceTag.className = 'tav-price-tag';
      priceTag.innerHTML = `<span class="coin-sm">G</span><b>${cost}</b> 골드`;
      strip.appendChild(priceTag);

      const btnReveal = document.createElement('button');
      btnReveal.className = 'tav-btn-reveal';
      btnReveal.textContent = `확인하기 · ${cost}💰`;
      btnReveal.disabled = !canHire;
      btnReveal.addEventListener('click', () => this._tavernReveal(flipper, btnReveal, btnHire, c, tier));
      strip.appendChild(btnReveal);

      const btnHire = document.createElement('button');
      btnHire.className = 'tav-btn-hire';
      btnHire.textContent = '영입한다';
      btnHire.style.display = 'none';
      btnHire.addEventListener('click', () => this._openTavernHire(c, idx));
      strip.appendChild(btnHire);

      slot.appendChild(strip);
      grid.appendChild(slot);
    });
  },

  // 확인하기 클릭 → 등급별 fx + flip + 1900ms 후 영입한다 노출
  _tavernReveal(flipper, btnReveal, btnHire, unit, tier){
    if (!flipper || flipper.classList.contains('is-revealed')) return;

    const inner = document.getElementById('tav-screen-inner');
    const dim = document.getElementById('tav-screen-dim');
    const fx = document.getElementById('tav-screen-fx');

    if (fx) {
      fx.className = 'tav-screen-fx tier-' + tier;
      void fx.offsetWidth;
      fx.classList.add('active');
    }
    if (dim && (tier === 'noble' || tier === 'legendary' || tier === 'divine')) {
      dim.classList.add('active');
      setTimeout(() => dim.classList.remove('active'), 1800);
    }
    if (inner) {
      if (tier === 'legendary') {
        inner.classList.add('shake-l');
        setTimeout(() => inner.classList.remove('shake-l'), 650);
      }
      if (tier === 'divine') {
        inner.classList.add('shake-d');
        setTimeout(() => inner.classList.remove('shake-d'), 950);
      }
    }

    flipper.classList.add('is-revealing');
    setTimeout(() => flipper.classList.add('is-revealed'), 180);

    btnReveal.disabled = true;
    btnReveal.style.opacity = '.5';

    // SFX 발동 (옛 흐름 보존)
    if (unit.rarity === 'legendary' || unit.rarity === 'divine') SFX.play('rarity_up');
    else SFX.play('card_reveal');

    setTimeout(() => {
      btnReveal.style.display = 'none';
      if (btnHire) btnHire.style.display = '';
      flipper.classList.remove('is-revealing');
      if (fx) fx.classList.remove('active');

      // 카드 zoom on click (revealed 후만)
      const front = flipper.querySelector('.tav-flip-front .card-v4');
      if (front && !front.dataset.zoomable) {
        front.dataset.zoomable = '1';
        front.addEventListener('click', e => {
          e.stopPropagation();
          this._openTavernZoom(unit);
        });
      }
    }, 1900);
  },

  // 카드 줌 (도감 패턴) — 좌:V4 1.5배 + 우:3×2 스킬 그리드
  _openTavernZoom(unit){
    const zoomEl = document.getElementById('tav-card-zoom');
    const cardHost = document.getElementById('tav-zoom-card-host');
    const skillHost = document.getElementById('tav-zoom-skill-host');
    if (!zoomEl || !cardHost || !skillHost) return;

    // 좌: V4 카드 clone (mkCardElV4 신규 생성, transform 충돌 회피)
    cardHost.innerHTML = '';
    const cardClone = mkCardElV4(unit, {frameMode: 'hand'});
    cardClone.style.cursor = 'default';
    cardHost.appendChild(cardClone);

    // 우: 시그니처 스킬 5개 (bundledSkillIds) + 1개 미개방
    skillHost.innerHTML = '';
    const skillIds = unit.bundledSkillIds || [];
    const skills = skillIds.slice(0, 5).map(sid => (typeof SKILLS_DB === 'object' && SKILLS_DB[sid]) || null).filter(Boolean);

    skills.forEach(sk => {
      const cell = document.createElement('div');
      cell.className = 'tav-zoom-sk';
      const artSrc = (typeof CARD_IMG === 'object' && CARD_IMG[sk.id]) || ('img/sk_' + (sk.id || 'unknown') + '.png');
      cell.innerHTML = `
        <div class="sk-art" style="background-image:url('${artSrc}');"></div>
        <div class="sk-cost">${sk.cost ?? sk.NEED_SOUL ?? '?'}</div>
        <div class="sk-name">${sk.name || '—'}</div>
        <div class="sk-desc">${sk.desc || ''}</div>`;
      skillHost.appendChild(cell);
    });

    // 빈 슬롯 채우기 (5개 미달) + 1개 미개방
    const lockedCount = Math.max(0, 5 - skills.length) + 1;
    for (let i = 0; i < lockedCount; i++) {
      const cell = document.createElement('div');
      cell.className = 'tav-zoom-sk locked';
      cell.innerHTML = `
        <div class="lock-q">?</div>
        <div class="sk-name">미개방</div>
        <div class="sk-desc">성장 시 습득</div>`;
      skillHost.appendChild(cell);
    }

    zoomEl.classList.add('active');

    // 닫기 핸들러 (1회성)
    const close = e => {
      if (e.target && e.target.closest('.tav-zoom-layout') && !e.target.closest('.tav-zoom-close')) return;
      this._closeTavernZoom();
    };
    const escClose = e => { if (e.key === 'Escape') this._closeTavernZoom(); };
    zoomEl._closeHandler = close;
    zoomEl._escHandler = escClose;
    zoomEl.addEventListener('click', close, { once: false });
    window.addEventListener('keydown', escClose, { once: false });
  },

  _closeTavernZoom(){
    const zoomEl = document.getElementById('tav-card-zoom');
    if (!zoomEl) return;
    zoomEl.classList.remove('active');
    if (zoomEl._closeHandler) zoomEl.removeEventListener('click', zoomEl._closeHandler);
    if (zoomEl._escHandler) window.removeEventListener('keydown', zoomEl._escHandler);
    zoomEl._closeHandler = null;
    zoomEl._escHandler = null;
  },

  // 영입 대화창 — 380ms slide-up + 3줄 대사 stagger fade
  _openTavernHire(unit, slotIdx){
    const dialog = document.getElementById('tav-hire-dialog');
    if (!dialog) return;

    const portrait = document.getElementById('tav-hire-portrait-img');
    const nameEl = document.getElementById('tav-hire-name');
    const roleEl = document.getElementById('tav-hire-role');
    const l1 = document.getElementById('tav-hire-l1');
    const l2 = document.getElementById('tav-hire-l2');
    const l3 = document.getElementById('tav-hire-l3');

    // 대사 lookup (47_data_hire_lines.js — RoF.HireLines.get)
    let lines = ['—', '—', '—'];
    if (window.RoF && RoF.HireLines && typeof RoF.HireLines.get === 'function') {
      const got = RoF.HireLines.get(unit.id);
      if (got && got.length >= 3) lines = got;
    }
    // fallback: desc 한 줄 + element/role 자동 보충
    if (lines[0] === '—') {
      lines = [
        unit.desc || `“${unit.name}, 이름을 적어주십시오.”`,
        '“제 검은 당신의 길에 함께 오를 것입니다.”',
        '“가시지요. 운명이 우리를 기다립니다.”',
      ];
    }

    // portrait 이미지 (CARD_IMG 매핑 → v2 helper fallback)
    const portraitSrc = (typeof CARD_IMG === 'object' && CARD_IMG[unit.id]) || (RoF.Data.unitImg(unit.id) || '');
    if (portrait) {
      portrait.src = portraitSrc;
      // v2 mv (2026-05-27) 후 옛 handoff_0508/ fallback 폐기 — portraitSrc 가 이미 unitImg helper 결과
    }
    const roleLabel = this._tavernRoleLabel(unit);
    if (nameEl) nameEl.textContent = unit.name || '—';
    if (roleEl) roleEl.textContent = roleLabel.ko;
    if (l1) l1.textContent = lines[0];
    if (l2) l2.textContent = lines[1];
    if (l3) l3.textContent = lines[2];

    // restart line animations
    [l1, l2, l3].forEach(el => {
      if (!el) return;
      el.style.animation = 'none';
      void el.offsetWidth;
      el.style.animation = '';
    });

    dialog.classList.add('active');

    // 클릭 시 영입 완료 + 닫기 (옛 영입 로직 실행)
    const finish = () => {
      this._closeTavernHire();
      this._finishHire(unit, slotIdx);
    };
    dialog._finishHandler = finish;
    dialog.addEventListener('click', finish, { once: true });
  },

  _closeTavernHire(){
    const dialog = document.getElementById('tav-hire-dialog');
    if (!dialog) return;
    dialog.classList.remove('active');
    if (dialog._finishHandler) {
      dialog.removeEventListener('click', dialog._finishHandler);
      dialog._finishHandler = null;
    }
  },

  // 영입 완료 — 옛 로직 (gold 차감 + deck push + slot null + persist)
  _finishHire(unit, slotIdx){
    if (slotIdx == null) return;
    const cost = unit.cost || 5;
    if ((this.gold || 0) < cost) return;
    if (((this.deck && this.deck.length) || 0) >= (this.maxDeck || 36)) return;
    // 2026-06-12 — 같은 캐릭터(id) 중복 영입 차단 (방어적; 보통 _generateTavernSlots 가 보유분 제외하나 stale 슬롯 대비).
    //   titan 지급(50_game_core.js:73)과 동일 id-dedup. unique 필드 폐기 → "캐릭터당 1 인스턴스" 로 04-balance 등급 중복 한도 대체.
    if (this.deck && this.deck.some(d => d && d.id === unit.id)) {
      const line = document.getElementById('tav-npc-line');
      if (line) line.textContent = '⚠️ 그 동료는 이미 자네 곁에 있다네. 같은 자를 둘 들일 순 없지.';
      this.tavernSlots[slotIdx] = null;
      this.persist();
      this.showTavern();
      return;
    }

    this.gold -= cost;
    const hired = {...unit};
    delete hired.cost;
    this.deck.push(hired);
    this.checkTutorial && this.checkTutorial('first_recruit');

    this.tavernSlots[slotIdx] = null;
    this.persist();
    this.showTavern();  // 재렌더 (topbar gold + grid + npc 인사말 모두)
  },

  refreshTavern(){
    if ((this.gold || 0) < 2) {
      const line = document.getElementById('tav-npc-line');
      if (line) line.textContent = '⚠️ 골드가 부족하군. 일이라도 좀 하다 오게.';
      return;
    }
    this.gold -= 2;
    this.tavernSlots = this._generateTavernSlots();
    SFX.play('click');
    this.persist();
    this.showTavern();
  },

  // ---- BATTLE ----
  // One battle = roguelike. Pick cards (by command slots) → fight rounds → all temp stuff resets after.
});
