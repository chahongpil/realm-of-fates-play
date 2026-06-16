// Game Battle (PHASE 6 매치/배틀 헬퍼)
// 2026-05-10: Plan 1 Task 1 — generateBot 적 봇 자동 구성.
// PHASE 6 영웅 6 풀 (m/f × warrior/ranger/support × holy 고정) +
// bundled 동료 17 풀 (시그니처 보유 일반 유닛) 에서 N 명 랜덤 추출.

RoF.__gameKeys = RoF.__gameKeys || new Set();
(function(keys){
  for (const k of keys) {
    if (RoF.__gameKeys.has(k)) {
      console.error('[Game] 중복 키 감지:', k);
      RoF.__gameKeyError = true;
    }
    RoF.__gameKeys.add(k);
  }
})(["generateBot", "showMatchmaking", "cancelMatchmaking", "startBattleFromMatch", "showReward", "afterBattle"]);

(function(){
  // bundled 동료 17 풀 — js/12_data_skills.js 의 bundledByUnit 필드로 정의된
  // 시그니처 카드를 가진 일반 유닛 ID. PHASE 6 적 봇 자동 구성에 사용.
  const BUNDLED_UNITS = [
    'wolf', 'hunter', 'herbalist', 'apprentice', 'archer', 'crossbow',
    'fire_spirit', 'guard', 'infantry', 'lancer', 'militia', 'monkey',
    'monkey_general', 'pyromancer', 'rogue', 'sun_wukong', 'wukong'
  ];

  // 영웅 카드 판별 — 두 컨벤션 (createHero 의 _isHero / Auth 의 isHero) 모두 인식.
  // js/14_data_images.js 의 동일 패턴 (`c._isHero || c.isHero`) 과 정합.
  const isHeroCard = (c) => !!(c && (c._isHero || c.isHero));

  Object.assign(RoF.Game, {
    /**
     * 적 봇 자동 구성 — PHASE 6 매치 시작 시 호출.
     *
     * 영웅: m/f × warrior/ranger/support × holy 6 변종 중 랜덤 1.
     * 동료 N: 플레이어 동료 수(formationSlot > 0)와 동일. 미설정 시 default 2.
     *         player N=3 일 때 50% 확률로 +1 (3 또는 4).
     * 동료 풀: BUNDLED_UNITS 17 풀에서 N 명 랜덤 추출 (중복 X).
     *
     * @returns {{name, hero, heroSigs, companions: Array<{unit, signatures}>}}
     */
    generateBot(){
      const Data = RoF.Data;
      if (!Data || !Data.createHero) return null;

      // 1. 영웅 풀 6 변종 중 1 랜덤
      const genders = ['m', 'f'];
      const roles = ['warrior', 'ranger', 'support'];
      const gender = genders[Math.floor(Math.random() * genders.length)];
      const role = roles[Math.floor(Math.random() * roles.length)];
      const hero = Data.createHero({ gender, role, element: 'holy' });

      // 2. 영웅 시그니처 (bundledByUnit === hero.id)
      // W-2: createHero 가 ID 생성의 단일 진실 소스. 패턴 변경되어도 generateBot 영향 0.
      const SKILLS = (Data.SKILLS || []);
      const heroSigs = SKILLS.filter(s => s && s.bundledByUnit === hero.id);

      // 3. 동료 N 결정 — 2026-06-13: 플레이어 영웅레벨 동료 해금 수와 대칭 (feedback_player_enemy_symmetry).
      //    옛 formationSlot(2026-05-12 폐기) 기반은 항상 0 → default 2 로 고정되던 버그성 동작 → getUnlockedCompanionCount 로 교체.
      //    Lv1→봇1 / Lv3→봇2 / Lv6→봇3 / Lv10→봇4 (플레이어와 같은 파티 규모로 공정).
      /* diagnosis-confirmed: 2026-06-13 사유: feature — 동료 게이팅 대칭 (봇 party 크기 = 플레이어 해금 수). 버그수정 아님. */
      const companionN = (RoF.Game.getUnlockedCompanionCount ? RoF.Game.getUnlockedCompanionCount() : 2);

      // 4. bundled 17 풀에서 N 명 랜덤 추출 (중복 X)
      const shuffled = BUNDLED_UNITS.slice().sort(() => Math.random() - 0.5);
      const companionIds = shuffled.slice(0, companionN);

      // 5. 동료 카드 + 시그니처 자동 빌드
      const UNITS = (Data.UNITS || []);
      const companions = companionIds.map(uid => {
        const unit = UNITS.find(u => u && u.id === uid);
        if (!unit) return null;
        const sigs = SKILLS.filter(s => s && s.bundledByUnit === uid);
        return { unit, signatures: sigs };
      }).filter(Boolean);

      // 6. 봇 이름 (옛 ENEMY_NAMES 풀)
      const name = (typeof window !== 'undefined' && typeof window.enemyName === 'function')
        ? window.enemyName()
        : ((RoF.helpers && RoF.helpers.enemyName) ? RoF.helpers.enemyName() : 'Challenger');

      /* diagnosis-confirmed: 2026-06-14 사유: feature — 봇 영웅 카드 이름 = 봇 프로필 이름(ENEMY_NAMES 판타지 풀 재사용).
         기존 hero.name 은 createHero generic('원거리 궁수') → 로그/내레이션에 generic 노출. 매칭 화면 봇 이름과도 통일.
         enemyName() 은 위에서 이미 호출 → Math.random 추가 0 (시드 순서 불변, 회귀 안전). 사용자 컨펌 "적 봇 영웅 고유 이름". */
      hero.name = name;

      return {
        name: name,
        hero: hero,
        heroSigs: heroSigs,
        companions: companions, // [{unit, signatures}]
      };
    },

    /**
     * 매칭 화면 표시 — Phase 1 (검색 중) → Phase 2 (적 봇 발견 + 15초 카운트다운).
     * Plan 1 Task 2 (2026-05-10) — 옛 PHASE 3 매칭 화면을 PHASE 6 데이터로 복원.
     *
     * Phase 1: 1.5~3초 랜덤 delay 동안 "도전자를 찾는 중..." + player 영웅 V4 카드.
     * Phase 2: generateBot() 으로 적 영웅 + V4 카드 양쪽 + 15초 카운트다운 + 출전/포기 버튼.
     */
    showMatchmaking(){
      RoF.UI.show('match-screen');
      if (window.SFX && SFX.bgm) SFX.bgm('match');

      // Step 3-A/B (2026-05-18): iframe 폐기. 시안 matchmaking.jsx vanilla 마이그레이션.
      // 데이터 매핑: player = RoF.Game.deck / opponent = generateBot()
      // 카드 일러스트: img/{id}.png (시안 CompPortrait 와 동일 패턴, mkCardElV4 X — portrait only)

      const stage = document.getElementById('mm-stage');
      if (!stage) {
        console.error('[match] #mm-stage 없음 — 시안 정합 markup 누락');
        return;
      }
      // 옛 iframe / 호환 stub 비우기
      const oldBox = document.getElementById('match-box');
      if (oldBox) oldBox.innerHTML = '';

      // ─── player 데이터 ───
      const deck = RoF.Game.deck || [];
      const playerHero = deck.find(c => c._isHero || c.isHero);
      const playerComps = deck.filter(c => c && c.kind === 'unit' && !c.isHero).slice(0, 4);
      const playerData = {
        side: 'player',
        sideLabel: '당신',
        name: (playerHero && (playerHero.name || playerHero.id)) || '영웅',
        title: this._heroTitle(playerHero),
        level: (playerHero && (playerHero.level || playerHero.matchLevel || 1)) || 1,
        rarity: (playerHero && playerHero.rarity) || 'silver',
        element: (playerHero && playerHero.element) || 'fire',
        tendency: this._heroTendency(playerHero),
        hero: playerHero,
        comps: playerComps,
        // 시너지 / 전적 — 게임 데이터 없음 → placeholder (Step 3-C 에서 추후 연결)
        synergies: this._calcSynergies(playerHero, playerComps),
        record: this._loadRecord('player'),
      };
      // ─── bot 데이터 (generateBot 결과) ───
      const bot = RoF.Game.generateBot();
      RoF.Game._currentBot = bot;
      const enemyData = bot ? {
        side: 'enemy',
        sideLabel: '상대',
        name: bot.name || '?',
        title: this._heroTitle(bot.hero),
        level: (bot.hero && (bot.hero.level || bot.level || 1)) || 1,
        rarity: (bot.hero && bot.hero.rarity) || 'silver',
        element: (bot.hero && bot.hero.element) || 'fire',
        tendency: this._heroTendency(bot.hero),
        hero: bot.hero,
        comps: (bot.companions || []).slice(0, 4).map(x => x.unit).filter(Boolean),
        synergies: this._calcSynergies(bot.hero, (bot.companions || []).map(x => x.unit)),
        record: this._loadRecord('enemy'),
      } : null;

      // ─── 모드 전환 (searching → found 3.2초 / found → countdown 10초) ───
      this._mmRenderSide('player', playerData, 'found');     // 좌측 player 는 처음부터 full
      this._mmRenderSide('enemy', enemyData, 'searching');   // 우측 opponent 는 searching mode
      this._mmRenderCenter('searching', 10);

      // 3.2초 후 found 모드 (시안 정합)
      RoF.Game._matchCDClear = () => {
        if (RoF.Game._mmFoundTimer) { clearTimeout(RoF.Game._mmFoundTimer); RoF.Game._mmFoundTimer = null; }
        if (RoF.Game._matchCDTimer) { clearInterval(RoF.Game._matchCDTimer); RoF.Game._matchCDTimer = null; }
      };
      RoF.Game._mmFoundTimer = setTimeout(() => {
        const ms = document.getElementById('match-screen');
        if (!ms || !ms.classList.contains('active')) return;
        if (window.SFX && SFX.play) SFX.play('magic');
        this._mmRenderSide('enemy', enemyData, 'found');
        let cdLeft = 10;
        this._mmRenderCenter('found', cdLeft);
        RoF.Game._matchCDTimer = setInterval(() => {
          cdLeft--;
          this._mmUpdateCountdown(cdLeft, 10);
          if (cdLeft <= 0) {
            RoF.Game._matchCDClear();
            const m2 = document.getElementById('match-screen');
            if (m2 && m2.classList.contains('active') && RoF.Game.startBattleFromMatch) {
              RoF.Game.startBattleFromMatch();
            }
          }
        }, 1000);
      }, 3200);
      return;  // 옛 Phase 1 markup 차단

      // ─── 아래는 옛 흐름 (Step 2 정합 시 제거 또는 vanilla 마이그레이션) ───
      box.innerHTML = `
        <div class="match-search">⚔️ 도전자를 찾는 중<span class="dots">...</span></div>
        <div class="match-row">
          <div class="match-side match-enemy">
            <div class="match-placeholder">❓</div>
            <div class="match-cap-label">검색중...</div>
          </div>
          <div class="match-vs match-vs-dim">VS</div>
          <div class="match-side match-player" id="match-player-side"></div>
        </div>`;
      // player 영웅 V4 카드 (Phase 1)
      if (hero && typeof mkCardElV4 === 'function') {
        const myCard = mkCardElV4(hero);
        myCard.classList.add('match-card');
        document.getElementById('match-player-side').appendChild(myCard);
      }

      // Phase 2: Found (1.5~3초 랜덤 delay)
      const delay = 1500 + Math.random() * 1500;
      setTimeout(() => {
        const ms = document.getElementById('match-screen');
        if (!ms || !ms.classList.contains('active')) return;
        const bot = RoF.Game.generateBot();
        RoF.Game._currentBot = bot;
        if (window.SFX && SFX.play) SFX.play('magic');

        box.innerHTML = `
          <div class="match-found">도전자가 나타났다!</div>
          <div class="match-row match-row-found">
            <div class="match-side match-enemy" id="match-enemy-side"></div>
            <div class="match-vs">VS</div>
            <div class="match-side match-player" id="match-player-side"></div>
          </div>
          <div class="match-countdown" id="match-countdown">⏳ <span id="match-cd-num">15</span>초 후 자동 출전</div>
          <div class="match-actions">
            <button class="btn match-btn-fight" data-action="game.startBattleFromMatch">⚔️ 출전!</button>
            <button class="btn btn-s btn-red match-btn-back" data-action="game.cancelMatchmaking">대전 포기</button>
          </div>`;

        // 적 영웅 V4 카드
        const enemySide = document.getElementById('match-enemy-side');
        if (bot && bot.hero && typeof mkCardElV4 === 'function') {
          const botCard = mkCardElV4(bot.hero);
          botCard.classList.add('match-card');
          enemySide.appendChild(botCard);
          const ecap = document.createElement('div');
          ecap.className = 'match-cap';
          ecap.innerHTML = `<div class="match-cap-name">${bot.name}</div><div class="match-cap-meta">${bot.hero._heroRole || bot.hero.role} · ✨</div>`;
          enemySide.appendChild(ecap);
        }
        // player 영웅 V4 카드 + cap (적과 동일 패턴 — 위치 정렬 위해)
        const mySide = document.getElementById('match-player-side');
        if (hero && typeof mkCardElV4 === 'function') {
          const myCard = mkCardElV4(hero);
          myCard.classList.add('match-card');
          mySide.appendChild(myCard);
          const pcap = document.createElement('div');
          pcap.className = 'match-cap';
          const playerName = (typeof Auth !== 'undefined' && Auth.user) || (RoF.Auth && RoF.Auth.user) || '나';
          pcap.innerHTML = `<div class="match-cap-name">${playerName}</div><div class="match-cap-meta">${hero._heroRole || hero.role || 'warrior'} · ✨</div>`;
          mySide.appendChild(pcap);
        }

        // 15초 카운트다운
        let cdLeft = 15;
        RoF.Game._matchCDClear = () => {
          if (RoF.Game._matchCDTimer) {
            clearInterval(RoF.Game._matchCDTimer);
            RoF.Game._matchCDTimer = null;
          }
        };
        RoF.Game._matchCDTimer = setInterval(() => {
          cdLeft--;
          const el = document.getElementById('match-cd-num');
          if (el) el.textContent = cdLeft;
          if (cdLeft <= 0) {
            RoF.Game._matchCDClear();
            const m2 = document.getElementById('match-screen');
            if (m2 && m2.classList.contains('active') && RoF.Game.startBattleFromMatch) {
              RoF.Game.startBattleFromMatch();
            }
          }
        }, 1000);
      }, delay);
    },

    /**
     * 매칭 포기 — 카운트다운 정리 + 메뉴 복귀.
     */
    cancelMatchmaking(){
      if (RoF.Game._matchCDClear) RoF.Game._matchCDClear();
      RoF.Game._currentBot = null;
      if (RoF.Game.showMenu) RoF.Game.showMenu();
    },

    // ─────────────────────────────────────────────────────────
    // Step 3-A/B (2026-05-18): 매칭 시안 vanilla 마이그레이션 헬퍼
    // ─────────────────────────────────────────────────────────
    _heroTitle(hero){
      if(!hero) return '"이름 없는 자"';
      // 영웅 role + element 조합으로 시안 풍 칭호 생성
      const elTitle = {fire:'불의 대행자', water:'서리의 사도', lightning:'번개의 화신', earth:'대지의 수호자', holy:'여명의 수호자', light:'여명의 수호자', dark:'심연의 사자'};
      return '"' + (elTitle[hero.element] || '운명의 도전자') + '"';
    },
    _heroTendency(hero){
      if(!hero) return '균형형';
      const roleTend = {warrior:'균형형', ranger:'공격형', support:'방어형', attack:'공격형', defense:'방어형'};
      return roleTend[hero._heroRole || hero.role] || '균형형';
    },
    _calcSynergies(hero, comps){
      // 시너지 placeholder — 게임 데이터 없음. element/role 카운트로 단순 계산.
      const all = [hero].concat(comps || []).filter(Boolean);
      const byEl = {};
      const byRole = {};
      all.forEach(c => {
        if(!c) return;
        const el = c.element;
        const role = c._heroRole || c.role;
        if(el) byEl[el] = (byEl[el]||0) + 1;
        if(role) byRole[role] = (byRole[role]||0) + 1;
      });
      const elLabel = {fire:'화염', water:'서리', lightning:'번개', earth:'대지', holy:'광휘', light:'광휘', dark:'심연'};
      const elGlyph = {fire:'🔥', water:'💧', lightning:'⚡', earth:'🌿', holy:'✨', light:'✨', dark:'🌑'};
      const result = [];
      Object.keys(byEl).forEach(k => {
        if(byEl[k] >= 2) result.push({key:k, count:byEl[k], kind:'element', label:elLabel[k]||k, glyph:elGlyph[k]||'✦'});
      });
      return result.slice(0, 3);
    },
    _loadRecord(side){
      // 전적 placeholder — 게임 데이터 없음. localStorage 에서 시즌 전적 가능 (추후).
      try {
        if(side === 'player'){
          const wins = (RoF.Game && RoF.Game.seasonWins) || 0;
          const losses = (RoF.Game && RoF.Game.seasonLosses) || 0;
          return {wins, losses, streak:0, recent:['W','W','L','W','W'].slice(0, Math.min(5, wins+losses))};
        }
      } catch(e) {}
      return {wins:0, losses:0, streak:0, recent:[]};
    },

    _mmRenderSide(side, data, mode){
      const root = document.getElementById('mm-side-' + side);
      if(!root) return;
      root.setAttribute('data-mode', mode);
      const bg = document.getElementById('mm-side-' + side + '-bg');
      if(bg){
        // 영웅 portrait — skinKey (영웅 카드) 또는 art / id
        if(data && data.hero){
          const h = data.hero;
          const src = RoF.Data.CARD_IMG[h.skinKey] || RoF.Data.CARD_IMG[h.id] || RoF.Data.CARD_IMG[h.art] || '';
          bg.style.backgroundImage = "url('" + src + "')";
        }
        if(mode === 'searching') bg.classList.add('mm-side-bg-blur');
        else bg.classList.remove('mm-side-bg-blur');
      }
      const info = document.getElementById('mm-side-' + side + '-info');
      if(info) info.style.display = (mode === 'searching') ? 'none' : '';
      const tendency = document.getElementById('mm-' + side + '-tendency');
      if(tendency){
        if(mode === 'searching' || !data){ tendency.style.display = 'none'; }
        else {
          tendency.style.display = '';
          const elLabel = {fire:'화염', water:'서리', lightning:'번개', earth:'대지', holy:'광휘', light:'광휘', dark:'심연'};
          tendency.textContent = (elLabel[data.element] || data.element) + ' · ' + (data.tendency || '균형형');
        }
      }
      if(mode === 'searching' || !data) return;

      // info 채우기
      const setText = (id, text) => { const el = document.getElementById(id); if(el) el.textContent = text; };
      setText('mm-' + side + '-title', data.title || '"운명의 도전자"');
      setText('mm-' + side + '-name', data.name || '?');
      setText('mm-' + side + '-lv', 'Lv ' + (data.level || 1));
      setText('mm-' + side + '-comps-label', '보유 유닛 (' + ((data.comps||[]).length + 1) + '/5)');

      // companion portraits
      const compsEl = document.getElementById('mm-' + side + '-comps');
      if(compsEl){
        compsEl.innerHTML = '';
        (data.comps || []).forEach(c => {
          const wrap = document.createElement('div');
          wrap.className = 'mm-comp-portrait';
          const rarityGrad = {bronze:'linear-gradient(90deg, #8a8278, #bcb4a4, #8a8278)',
                              silver:'linear-gradient(90deg, #3a6b9e, #7ab4e0, #3a6b9e)',
                              gold:'linear-gradient(90deg, #7a3bcc, #c89af0, #7a3bcc)',
                              legendary:'linear-gradient(90deg, #c89030, #f3d676, #c89030)',
                              divine:'linear-gradient(90deg, #c83838, #ffd8a0, #c83838)'};
          const rarityBorder = {bronze:'#8a8278', silver:'#3a6b9e', gold:'#7a3bcc', legendary:'#c89030', divine:'#c83838'};
          const stripeGrad = rarityGrad[c.rarity] || rarityGrad.bronze;
          const borderC = rarityBorder[c.rarity] || rarityBorder.bronze;
          wrap.innerHTML =
            '<div class="mm-comp-img" style="background-image:url(\'' + (RoF.Data.CARD_IMG[c.id] || RoF.Data.CARD_IMG[c.art] || '') + '\'); border:2px solid ' + borderC + ';">' +
              '<div class="mm-comp-lvl">' + (c.level || c.matchLevel || 1) + '</div>' +
              '<div class="mm-comp-stripe" style="background:' + stripeGrad + ';"></div>' +
            '</div>' +
            '<div class="mm-comp-name">' + (c.name || c.id || '?') + '</div>';
          compsEl.appendChild(wrap);
        });
      }

      // synergies
      const synEl = document.getElementById('mm-' + side + '-syn');
      if(synEl){
        synEl.innerHTML = '';
        if(!(data.synergies && data.synergies.length)){
          synEl.innerHTML = '<div style="color:#5a4020;font:400 10px/1 var(--mm-fb);letter-spacing:.1em;">시너지 없음</div>';
        } else {
          data.synergies.forEach(s => {
            const c = document.createElement('div');
            const active = s.count >= 2;
            c.className = 'mm-syn-chip' + (active ? ' is-active' : '');
            c.innerHTML =
              '<div class="mm-syn-glyph">' + (s.glyph || '✦') + '</div>' +
              '<div class="mm-syn-text">' +
                '<div class="mm-syn-label">' + s.label + '</div>' +
                '<div class="mm-syn-count">×' + s.count + (active ? '<span class="mm-syn-active-tag">발동</span>' : '') + '</div>' +
              '</div>';
            synEl.appendChild(c);
          });
        }
      }

      // record
      const recEl = document.getElementById('mm-' + side + '-record');
      if(recEl){
        const r = data.record || {wins:0, losses:0, streak:0, recent:[]};
        const recentHtml = (r.recent || []).slice(-5).map(x =>
          '<div class="mm-rec-recent-box' + (x === 'W' ? ' is-win' : '') + '"></div>'
        ).join('');
        const streakHtml = r.streak >= 3
          ? '<span class="mm-rec-streak is-danger">🔥 ' + r.streak + '연승 ⚠ 주의</span>'
          : r.streak >= 2 ? '<span class="mm-rec-streak">' + r.streak + '연승</span>' : '';
        recEl.innerHTML =
          '<div class="mm-rec-wl">' + r.wins + '<span class="mm-rec-letter">W</span><span class="mm-rec-slash">/</span>' + r.losses + '<span class="mm-rec-letter">L</span></div>' +
          '<div class="mm-rec-recent">' + recentHtml + '</div>' +
          streakHtml;
      }
    },

    _mmRenderCenter(mode, countdown){
      const center = document.querySelector('#match-screen .mm-center');
      if(center) center.setAttribute('data-mode', mode);
      const setText = (id, text) => { const el = document.getElementById(id); if(el) el.textContent = text; };
      setText('mm-status-text', mode === 'searching' ? 'SCANNING FATE…' : 'MATCH FOUND');
      setText('mm-status-sub', mode === 'searching' ? '운명의 실타래를 추적하는 중...' : '상대와 곧 만납니다');
      // 카운트다운 ring + 숫자
      this._mmUpdateCountdown(countdown, 10);
      // action button: searching → disabled / found → 활성
      const actBtn = document.getElementById('mm-action-btn');
      if(actBtn){
        if(mode === 'searching'){
          actBtn.disabled = true;
          actBtn.classList.add('mm-action-disabled');
          actBtn.innerHTML = '<span class="mm-dots"><span></span><span></span><span></span></span>상대를 찾고 있습니다';
          actBtn.onclick = null;
        } else {
          actBtn.disabled = false;
          actBtn.classList.remove('mm-action-disabled');
          actBtn.textContent = '⚔ 전 투 시 작 ▸';
          actBtn.onclick = () => { if(RoF.Game.startBattleFromMatch) RoF.Game.startBattleFromMatch(); };
        }
      }
    },

    // Step 4 (2026-05-18): 보상 화면 시안 vanilla 렌더 (result_victory.jsx / result_defeat.jsx 정합)
    _rwRender(winner, rewards){
      const stage = document.getElementById('rw-stage');
      if(!stage) return;
      const result = winner === 'player' ? 'victory' : winner === 'enemy' ? 'defeat' : 'draw';
      stage.setAttribute('data-result', result);

      const Game = RoF.Game || {};
      const deck = Game.deck || [];
      const playerHero = deck.find(c => c && (c._isHero || c.isHero));
      const bot = Game._currentBot;
      const round = (RoF.Match && RoF.Match.state && RoF.Match.state.round) || 1;
      const setText = (id, text) => { const el = document.getElementById(id); if(el) el.textContent = text; };
      const setStyle = (id, prop, val) => { const el = document.getElementById(id); if(el) el.style[prop] = val; };

      // ─── TopBar (마이너 fix: 상대 title + status dot + ✕ 닫기) ───
      setText('rw-topbar-title', winner === 'player' ? '승리' : winner === 'enemy' ? '패배' : '무승부');
      const oppTitle = this._heroTitle(bot && bot.hero);
      setText('rw-opp-title', (oppTitle || '"운명의 도전자"').replace(/^"|"$/g, ''));
      setText('rw-opp-name', (bot && bot.name) || '도전자');
      setText('rw-opp-lv', 'Lv ' + ((bot && bot.hero && (bot.hero.level || bot.level)) || 1));
      setText('rw-rounds', round);
      const scoreEl = document.getElementById('rw-topbar-score');
      if(scoreEl) scoreEl.textContent = (rewards.scoreDelta > 0 ? '+' : '') + rewards.scoreDelta + '점';

      // ─── Dialog (동료 portrait + 말풍선) ───
      // 무작위 동료 1명 선택 (placeholder)
      const companions = deck.filter(c => c && c.kind === 'unit' && !c.isHero);
      const speaker = companions.length ? companions[Math.floor(Math.random() * companions.length)] : null;
      const speakerName = speaker ? (speaker.name || speaker.id) : '동료';
      const speakerArt = speaker ? (RoF.Data.CARD_IMG[speaker.id] || '') : '';
      const DIALOG_TEXT = {
        victory: '훌륭한 전투였습니다, 주군! 운명의 실타래가 우리 손에 떨어졌습니다. 이 기세 그대로 다음 신좌까지 단숨에 진격합시다.',
        defeat: '아직 끝나지 않았습니다, 주군. 운명은 한 번의 실패로 결정되지 않습니다. 호흡을 가다듬고 다시 도전합시다.',
        draw: '치열했지만 결판이 나지 않았습니다. 한 번 더 정비하고 도전하면 다음엔 우리 손에 떨어질 것입니다.',
      };
      setText('rw-dialog-speaker-name', speakerName);
      setText('rw-dialog-role', '동료');
      setText('rw-dialog-text', DIALOG_TEXT[result] || DIALOG_TEXT.draw);
      setStyle('rw-dialog-portrait', 'backgroundImage', speakerArt ? "url('" + speakerArt + "')" : '');

      // ─── HeroXP ───
      const heroName = (playerHero && (playerHero.name || playerHero.id)) || '영웅';
      const heroLv = (playerHero && (playerHero.level || playerHero.matchLevel)) || 1;
      const heroArt = playerHero
        ? (RoF.Data.CARD_IMG[playerHero.skinKey] || RoF.Data.CARD_IMG[playerHero.id] || '')
        : '';
      setText('rw-hero-name', heroName);
      setText('rw-hero-lv', heroLv);
      setStyle('rw-hero-portrait', 'backgroundImage', heroArt ? "url('" + heroArt + "')" : '');
      // xp before/gain (게임 매치 xp 추적 없음 — placeholder)
      const xpBefore = Math.max(0, ((Game.xp || 0) - rewards.xpAdd));
      const xpGained = rewards.xpAdd || 0;
      const xpMax = Math.max(10, xpBefore + xpGained + 20);
      const pctBefore = Math.min(100, (xpBefore / xpMax) * 100);
      const pctGain = Math.min(100, (xpGained / xpMax) * 100);
      setStyle('rw-hero-bar-before', 'width', 'calc(' + pctBefore + '% - 2px)');
      setStyle('rw-hero-bar-gain', 'width', pctGain + '%');
      setStyle('rw-hero-bar-gain', 'left', 'calc(' + pctBefore + '% + 1px)');
      setStyle('rw-hero-bar-shimmer', 'left', 'calc(' + pctBefore + '% + 1px)');
      setStyle('rw-hero-bar-shimmer', 'width', pctGain + '%');
      setText('rw-hero-xp-before', xpBefore);
      setText('rw-hero-xp-gain', '+' + xpGained);
      setText('rw-hero-xp-max', xpMax);

      // ─── SpellXP list ───
      const spellList = document.getElementById('rw-spell-xp-list');
      if(spellList){
        spellList.innerHTML = '';
        // 매치 통계 없음 — 영웅 + 동료의 bundledSkillIds 일부 placeholder 표시
        const sigPool = [];
        if(playerHero) (playerHero.bundledSkillIds || []).slice(0, 2).forEach(sid => sigPool.push({id:sid, src: speaker}));
        companions.slice(0, 2).forEach(c => (c.bundledSkillIds || []).slice(0, 1).forEach(sid => sigPool.push({id:sid, src: c})));
        const SKILLS = (RoF.Data && RoF.Data.SKILLS) || [];
        sigPool.slice(0, 4).forEach((entry, idx) => {
          const sk = SKILLS.find(s => s.id === entry.id);
          if(!sk) return;
          const xp = winner === 'player' ? (15 + idx * 4) : (3 + idx);
          const row = document.createElement('div');
          row.className = 'rw-spell-xp-item';
          row.innerHTML =
            '<div class="rw-spell-xp-portrait" style="background-image:url(\'' + (RoF.Data.CARD_IMG[sk.id] || RoF.Data.skillImg(sk.id) || '') + '\');"></div>' +
            '<div class="rw-spell-xp-info">' +
              '<div class="rw-spell-xp-name">' + (sk.name || sk.id) + '</div>' +
              '<div class="rw-spell-xp-meta">' + (sk.element || '—') + ' · ' + (winner === 'player' ? Math.floor(Math.random()*3+1)+'회 시전' : '미시전') + '</div>' +
            '</div>' +
            '<div class="rw-spell-xp-gain">+' + xp + ' XP</div>';
          spellList.appendChild(row);
        });
        if(!spellList.children.length){
          spellList.innerHTML = '<div style="color:#5a4020;text-align:center;padding:20px 0;font:400 11px/1.5 var(--rw-fb);">이번 전투에서 사용한 스펠이 없습니다.</div>';
        }
      }

      // ─── Damage ranking ───
      const dealt = (RoF.Match && RoF.Match.state && RoF.Match.state._stat && RoF.Match.state._stat.dmgDealt) || (winner === 'player' ? 1480 : 620);
      const taken = (RoF.Match && RoF.Match.state && RoF.Match.state._stat && RoF.Match.state._stat.dmgTaken) || (winner === 'player' ? 620 : 1480);
      setText('rw-dmg-dealt', dealt);
      setText('rw-dmg-taken', taken);
      // 매치 통계 없음 — 영웅 + 동료 portrait 기반 placeholder 대미지 분배 (outer scope, TopRank 분리 렌더에서도 사용)
      const contributors = [];
      if(playerHero) contributors.push({kind:'unit', name: heroName, art: playerHero.skinKey || playerHero.id, weight: 1.2});
      companions.slice(0, 4).forEach(c => contributors.push({kind:'unit', name: c.name || c.id, art: c.id, weight: 0.6 + Math.random()*0.6}));
      const SKILLS = (RoF.Data && RoF.Data.SKILLS) || [];
      const sigs = ((playerHero && playerHero.bundledSkillIds) || []).slice(0, 2);
      sigs.forEach(sid => {
        const sk = SKILLS.find(s => s.id === sid);
        if(sk) contributors.push({kind:'spell', name: sk.name || sk.id, art: sk.id, weight: 0.7 + Math.random()*0.4});
      });
      const totalWeight = contributors.reduce((a,c) => a + c.weight, 0);
      contributors.forEach(c => { c.dmg = Math.round(dealt * (c.weight / totalWeight)); });
      contributors.sort((a, b) => b.dmg - a.dmg);
      const maxDmg = contributors[0] ? contributors[0].dmg : 1;

      const dmgList = document.getElementById('rw-damage-list');
      if(dmgList){
        dmgList.innerHTML = '';
        contributors.slice(0, 6).forEach((d, i) => {
          const rank = i + 1;
          const row = document.createElement('div');
          row.className = 'rw-damage-row' + (rank <= 3 ? ' is-top' : '');
          const pct = (d.dmg / maxDmg) * 100;
          row.innerHTML =
            '<div class="rw-damage-rank is-' + rank + '">' + rank + '</div>' +
            '<div class="rw-damage-portrait" style="background-image:url(\'' + (RoF.Data.CARD_IMG[d.art] || '') + '\');"></div>' +
            '<div class="rw-damage-kind is-' + d.kind + '">' + (d.kind === 'spell' ? '스펠' : '유닛') + '</div>' +
            '<div class="rw-damage-name-row">' +
              '<div class="rw-damage-name">' + d.name + '</div>' +
              '<div class="rw-damage-count">' + (d.kind === 'spell' ? Math.floor(Math.random()*3+1)+'회 시전' : Math.floor(Math.random()*4+2)+'회 공격') + '</div>' +
            '</div>' +
            '<div class="rw-damage-bar"><div class="rw-damage-bar-fill" style="width:calc(' + pct + '% - 2px);"></div></div>' +
            '<div class="rw-damage-value">' + d.dmg + '</div>';
          dmgList.appendChild(row);
        });
      }
      // ─── ✦ 보상 탭 (RewardsView 데이터 — 블로커 #1 fix) ───
      // Step 5: 시안 정합 — 자원 grid 4-col (result_victory/defeat.jsx REWARDS 수치)
      setText('rw-rsrc-gold', '+' + rewards.goldAdd);
      setText('rw-rsrc-gem', winner === 'player' ? '+3' : winner === 'enemy' ? '+1' : '+0');
      setText('rw-rsrc-honor', '+' + rewards.honorAdd);
      setText('rw-rsrc-exp', '+' + rewards.xpAdd);
      const relicAmt = winner === 'player' ? 1 : 0;
      setText('rw-relic-amount', '+' + relicAmt);
      const relicEl = document.getElementById('rw-rewards-relic');
      if(relicEl) relicEl.style.display = relicAmt > 0 ? '' : 'none';
      // League progress (placeholder — 게임 시즌 시스템 미구현)
      const leagueBefore = 425;
      const leagueGain = rewards.scoreDelta;
      const leagueAfter = leagueBefore + leagueGain;
      const leagueNext = 600;
      setText('rw-league-rank', 'III');
      setText('rw-league-name', '신들의 리그 · 골드');
      setText('rw-league-score-before', leagueBefore);
      setText('rw-league-score-gain', (leagueGain >= 0 ? '+' : '') + leagueGain);
      setText('rw-league-score-after', leagueAfter);
      setText('rw-league-score-next', leagueNext);
      const lPctBefore = Math.min(100, (leagueBefore / leagueNext) * 100);
      const lPctGain = Math.min(100, Math.abs(leagueGain) / leagueNext * 100);
      setStyle('rw-league-bar-fill', 'width', 'calc(' + lPctBefore + '% - 2px)');
      setStyle('rw-league-bar-gain', 'left', 'calc(' + lPctBefore + '% + 1px)');
      setStyle('rw-league-bar-gain', 'width', lPctGain + '%');
      // Season pass progress (시안 정합 — victory:60 / defeat:25 / draw:30)
      const seasonLv = 14;
      const seasonBefore = 240;
      const seasonGain = winner === 'player' ? 60 : winner === 'enemy' ? 25 : 30;
      const seasonMax = 500;
      setText('rw-season-lv', seasonLv);
      setText('rw-season-xp-before', seasonBefore);
      setText('rw-season-xp-gain', '+' + seasonGain);
      setText('rw-season-xp-max', seasonMax);
      const sPctBefore = Math.min(100, (seasonBefore / seasonMax) * 100);
      const sPctGain = Math.min(100, (seasonGain / seasonMax) * 100);
      setStyle('rw-season-bar-before', 'width', 'calc(' + sPctBefore + '% - 2px)');
      setStyle('rw-season-bar-gain', 'left', 'calc(' + sPctBefore + '% + 1px)');
      setStyle('rw-season-bar-gain', 'width', sPctGain + '%');
      setStyle('rw-season-bar-shimmer', 'left', 'calc(' + sPctBefore + '% + 1px)');
      setStyle('rw-season-bar-shimmer', 'width', sPctGain + '%');

      // ─── 1~3위 탭 (TopRank 큰 카드 — 블로커 #2 fix) ───
      const top3List = document.getElementById('rw-top3-list');
      if(top3List){
        top3List.innerHTML = '';
        const top3 = contributors.slice(0, 3);
        top3.forEach((d, i) => {
          const rank = i + 1;
          const pct = (d.dmg / maxDmg) * 100;
          const card = document.createElement('div');
          card.className = 'rw-top3-card is-' + rank;
          card.innerHTML =
            '<div class="rw-top3-medal">' + rank + '</div>' +
            '<div class="rw-top3-portrait" style="background-image:url(\'' + (RoF.Data.CARD_IMG[d.art] || '') + '\');"></div>' +
            '<div class="rw-top3-body">' +
              '<div class="rw-top3-name-row">' +
                '<span class="rw-top3-name">' + d.name + '</span>' +
                '<span class="rw-top3-kind is-' + d.kind + '">' + (d.kind === 'spell' ? '스펠' : '유닛') + '</span>' +
                '<span class="rw-top3-count">' + (d.kind === 'spell' ? Math.floor(Math.random()*3+1)+'회 시전' : Math.floor(Math.random()*4+2)+'회 공격') + '</span>' +
              '</div>' +
              '<div class="rw-top3-bar"><div class="rw-top3-bar-fill" style="width:calc(' + pct + '% - 2px);"></div></div>' +
            '</div>' +
            '<div class="rw-top3-value">' +
              '<div class="rw-top3-dmg">' + d.dmg + '</div>' +
              '<div class="rw-top3-dmg-label">DMG</div>' +
            '</div>';
          top3List.appendChild(card);
        });
      }

      // 탭 wire — 3 탭 (rewards / top3 / all)
      const tabs = document.querySelectorAll('.rw-rpanel-tab');
      const showBody = (which) => {
        ['rewards','top3','all'].forEach(k => {
          const el = document.getElementById('rw-' + k + '-body');
          if(el) el.style.display = (k === which) ? '' : 'none';
        });
      };
      tabs.forEach(t => {
        t.onclick = () => {
          tabs.forEach(x => x.classList.toggle('is-active', x === t));
          showBody(t.getAttribute('data-tab'));
        };
      });
      // default: rewards 탭 표시
      showBody('rewards');

      // ─── ActionBar summary ───
      const scoreText = (rewards.scoreDelta > 0 ? '+' : '') + rewards.scoreDelta + '점';
      const scoreLabel = winner === 'player' ? '승리 보상' : winner === 'enemy' ? '패배 페널티' : '무승부';
      const summary = document.getElementById('rw-actionbar-summary');
      if(summary){
        summary.innerHTML =
          '<span class="dim">' + scoreLabel + '</span>' +
          '<b class="gold">' + scoreText + '</b>' +
          '<span class="dim">· 골드</span> <span>+' + rewards.goldAdd + '</span>' +
          (rewards.xpAdd ? '<span class="dim">· 경험치</span> <span>+' + rewards.xpAdd + '</span>' : '') +
          (rewards.honorAdd ? '<span class="dim">· 명예</span> <span>+' + rewards.honorAdd + '</span>' : '');
      }
      const btnNext = document.getElementById('rw-btn-next');
      if(btnNext){
        btnNext.textContent = winner === 'player' ? '⚔ 다음 도전 ▸' : winner === 'enemy' ? '⚔ 다시 도전 ▸' : '⚔ 다음 도전 ▸';
      }
    },

    _mmUpdateCountdown(left, total){
      const num = document.getElementById('mm-cd-num');
      if(num) num.textContent = (left > 0 ? left : '0');
      const arc = document.getElementById('mm-cd-arc');
      if(arc){
        const C = 2 * Math.PI * 38;
        const offset = C * (1 - left / total);
        arc.setAttribute('stroke-dashoffset', offset);
      }
    },

    /**
     * 매칭 화면 출전 클릭 → Match.api.start 호출 + tcg-screen 진입.
     * Plan 1 Task 3 (2026-05-10) — bot 데이터(hero/heroSigs/companions) 를
     * Match 엔진의 enemyHero + enemyDeck 형식으로 변환.
     *
     * playerHero: deck 안의 _isHero/isHero 카드.
     * playerDeck: deck 안의 formationSlot != null 카드 모두 (영웅 + 동료).
     * enemyHero:  bot.hero
     * enemyDeck:  bot.heroSigs + (각 companion.unit + companion.signatures), 모두 _enemy:true 마킹.
     *
     * 에러 처리: bot 없음 / hero 없음 / Match.start 실패 → showMenu 복귀.
     */
    startBattleFromMatch(){
      if (RoF.Game._matchCDClear) RoF.Game._matchCDClear();
      const bot = RoF.Game._currentBot;
      if (!bot) {
        console.error('[match] no bot — cannot start battle');
        if (RoF.Game.showMenu) RoF.Game.showMenu();
        return;
      }
      // playerHero + playerDeck 가져오기
      const playerHero = (RoF.Game.deck || []).find(c => isHeroCard(c));
      if (!playerHero) {
        console.error('[match] no player hero');
        if (RoF.Game.showMenu) RoF.Game.showMenu();
        return;
      }
      // PHASE 6 자동 덱 빌드 (rules/04-balance.md) — 영웅 + 시그니처 + 동료 + 시그니처가 모두 deck 에.
      // playerHero 는 hero 로 분리 추출되므로 deck 에선 영웅만 제외하고 나머지 모두 매치 덱으로.
      // (Plan 1 Task 3 시점의 formationSlot 필터는 PHASE 6 자동 빌드 도입으로 폐기 — 2026-05-12)
      const playerDeck = (RoF.Game.deck || []).filter(c => c && !isHeroCard(c));

      // enemyHero + enemyDeck 빌드 (bot 데이터 → Match 형식)
      const enemyHero = bot.hero;
      const enemyDeck = [];
      // 적 영웅 시그니처
      (bot.heroSigs || []).forEach(s => enemyDeck.push(Object.assign({}, s, { _enemy: true })));
      // 적 동료 카드 + 시그니처
      (bot.companions || []).forEach(({ unit, signatures }) => {
        if (unit) enemyDeck.push(Object.assign({}, unit, { _enemy: true }));
        (signatures || []).forEach(s => enemyDeck.push(Object.assign({}, s, { _enemy: true })));
      });

      try {
        // 2026-05-12 fix: RoF.UI.renderState 는 미정의 (show/modal/toast 만 노출됨).
        // 정본 entry RoF.Match.UI.startMatch 사용 — Match.start + show + renderState + _startTimer 통합 처리.
        // 검 인디케이터 / 손패 / 영혼력 UI 갱신이 누락되던 사고 fix.
        RoF.Match.UI.startMatch({ playerHero, enemyHero, playerDeck, enemyDeck });
      } catch (e) {
        console.error('[match] start failed', e);
        if (RoF.Game.showMenu) RoF.Game.showMenu();
      }
    },

    /**
     * 매치 화면 ← 돌아가기 클릭 → 항복 (패배 처리) (2026-05-12).
     * 매치 진행 중: 확인 후 winner='enemy' 세팅 + 보상(패배) 화면 진입.
     * 매치 외 상태 (winner 결정됨 / state 없음): 단순 메뉴 복귀.
     */
    surrenderMatch(){
      const st = RoF.Match && RoF.Match.state;
      if (st && !st.winner) {
        // 실수 클릭 방지 — 확인 다이얼로그
        const ok = window.confirm('정말 항복하시겠습니까?\n현재 매치를 패배로 처리하고 보상 화면으로 이동합니다.');
        if (!ok) return;
        // 2026-05-20 P0-1: _endMatch 단일 진입점 — events clear + AI stop + showReward 자동 처리.
        // 옛 winner 직접 세팅 + showReward 직접 호출은 AI/events 차단 누락으로 P0 #14 (AI 계속 행동) 원인.
        RoF.Match._endMatch('enemy');
      } else {
        if (RoF.Game.showMenu) RoF.Game.showMenu();
      }
    },

    /**
     * 매치 종료 → 보상 화면 진입 (Plan 1 Task 6, 2026-05-10).
     * 단순 placeholder — 실제 보상 계산 (골드/XP/카드 드롭) 은 별도 phase.
     *
     * @param {'player'|'enemy'|'draw'} winner
     */
    showReward(winner){
      // 카드 영구 XP 레벨업 연출 (2026-06-08) — _endMatch 가 채운 _cardLevelUps 순차 재생.
      //   보상 화면 위에 레벨업+해금 모달 큐 (presentLevelUp 이 _jobs 순차 처리). setTimeout 으로
      //   퀘스트/일반 두 경로 공통 + 보상 화면이 먼저 보이도록 지연.
      const _cardLvUps = (RoF.Match && RoF.Match.state && RoF.Match.state._cardLevelUps) || [];
      if (_cardLvUps.length && RoF.UI && typeof RoF.UI.presentLevelUp === 'function') {
        setTimeout(function(){
          _cardLvUps.forEach(function(item){
            try { RoF.UI.presentLevelUp(item.card, item.lvRes); } catch(e){}
          });
        }, 700);
      }
      /* diagnosis-confirmed: 2026-05-31 quest feature 라우팅 (design/quest_system_v1.md) — bug fix 아님 */
      // 2026-05-31 퀘스트 battle 종료 라우팅 — _questBattleId 마커 있으면 퀘 보상 흐름 (PvP 랭크 스킵).
      const _qid = RoF.Game && RoF.Game._questBattleId;
      if (_qid && RoF.Quest) {
        RoF.Game._questBattleId = null;
        const appeared = RoF.Quest.collectAppearedCardIds(RoF.Match && RoF.Match.state);
        const qres = RoF.Quest.resolveBattle(_qid, winner === 'player', appeared);
        const qdef = (RoF.Data.getQuest && RoF.Data.getQuest(_qid)) || {};
        const gained = (qres && qres.gained) || {};
        const qwon = winner === 'player';
        if (RoF.UI && typeof RoF.UI.show === 'function') RoF.UI.show('reward-screen');
        const _t = document.getElementById('rew-title'), _s = document.getElementById('rew-sub'), _st = document.getElementById('rew-stats');
        if (_t) { _t.textContent = qwon ? '✨ 퀘스트 완료!' : '💀 퀘스트 실패'; _t.className = 'reward-title ' + (qwon ? 'victory' : 'defeat'); }
        if (_s) _s.textContent = qdef.title || '';
        if (_st) {
          let html = qwon ? ('💰 +' + (gained.gold || 0) + ' 골드') : '보상 없음 — 다시 도전하세요';
          if (qwon && gained.cardId) html += '<br>🎴 카드 획득: ' + gained.cardId;
          if (qwon && gained.challengeXP) html += '<br>⭐ 도전 +' + gained.challengeXP + ' XP';
          _st.innerHTML = html;
        }
        // _rwRender 는 순수 시각 (상태 변이 X) — 재사용. scoreDelta 0 (퀘는 랭크 무관). 골드는 resolveBattle 가 이미 적립.
        if (this._rwRender) { try { this._rwRender(winner, { goldAdd: gained.gold || 0, xpAdd: 0, honorAdd: 0, scoreDelta: 0 }); } catch (e) {} }
        /* diagnosis-confirmed: 2026-06-07 사유: feature — 카드 영입 연출(scene_3/fates_thread) 트리거. q_wolf_cull. 버그 픽스 아님. */
        if (qwon && gained.visionId && RoF.QuestUI && RoF.QuestUI.playRewardVision) {
          try { RoF.QuestUI.playRewardVision(gained.visionId, { cardId: gained.jackpotCardId || gained.cardId }); } catch (e) {}
        }
        return;
      }

      if (RoF.UI && typeof RoF.UI.show === 'function') RoF.UI.show('reward-screen');

      // Step 4 (2026-05-18): iframe 폐기. 시안 result_victory/defeat.jsx vanilla 마이그레이션.
      // 카드 일러스트: portrait img/{id}.png (시안 BC X).
      // 데이터: player hero / bot / Match.state 매핑 + placeholder.

      const Game = RoF.Game;
      let goldAdd = 0, xpAdd = 0, honorAdd = 0, scoreDelta = 0;

      // Step 5 (2026-05-18): 시안 정합 — REWARDS 수치 (result_victory.jsx:51~58 / result_defeat.jsx:51~58)
      if (winner === 'player') {
        // 시안 result_victory.jsx:51~58 — gold:12, gem:3, honor:10, exp:20, relic:1, seasonPassXp:60
        // 게임 부착 (player 보상은 더 후함): gold:50 유지, 나머지 시안 정합
        goldAdd = 50; xpAdd = 3; honorAdd = 10; scoreDelta = +15;
      } else if (winner === 'enemy') {
        // 시안 result_defeat.jsx:51~58 — gold:5, gem:1, honor:1, exp:10, relic:0, seasonPassXp:25 (위로금)
        goldAdd = 5; xpAdd = 10; honorAdd = 1; scoreDelta = -5;
      } else {
        goldAdd = 20; xpAdd = 0; honorAdd = 0; scoreDelta = 0;
      }

      // 옛 markup 호환 — 호환 stub 채움 (테스트/잔존 코드 보호)
      const title = document.getElementById('rew-title');
      const sub   = document.getElementById('rew-sub');
      const stats = document.getElementById('rew-stats');
      if (title) {
        title.textContent = winner === 'player' ? '✨ 승리!' : winner === 'enemy' ? '💀 패배' : '⚖ 무승부';
        title.className = 'reward-title ' + (winner === 'player' ? 'victory' : winner === 'enemy' ? 'defeat' : '');
      }
      if (sub) sub.textContent = winner === 'player' ? '도전자를 격파했습니다' : winner === 'enemy' ? '다음에 다시 도전하세요' : '치열한 대전이었습니다';
      if (stats) stats.innerHTML = `💰 +${goldAdd} 골드` + (xpAdd ? `<br>⭐ +${xpAdd} 경험치` : '');

      // 시안 정합 vanilla 렌더 (Step 4-A markup 사용)
      this._rwRender(winner, {goldAdd, xpAdd, honorAdd, scoreDelta});

      // 실 골드/XP 적용 + save (Game.save 또는 Auth.save 자동 분기)
      if (Game) {
        if (typeof Game.gold === 'number') Game.gold += goldAdd;
        if (typeof Game.xp   === 'number' && xpAdd) Game.xp   += xpAdd;
        // save persist — Game.save / Auth.save / Auth.persistCloud 등 가용 함수 사용
        if (typeof Game.save === 'function') {
          try { Game.save(); } catch(e){ console.warn('[showReward] Game.save failed', e); }
        } else if (window.Auth && typeof Auth.save === 'function' && Auth.user && Auth.db) {
          try {
            const db = Auth.db();
            if (db && db[Auth.user] && db[Auth.user].save) {
              db[Auth.user].save.gold = Game.gold;
              db[Auth.user].save.xp   = Game.xp;
              Auth.save(db);
            }
          } catch(e){ console.warn('[showReward] Auth persist failed', e); }
        }
      }

      // AI 무한 루프 차단 안전망 — winner set 됐어도 stale AI 콜백이 _inLoop 풀고 다시 진행 위험.
      // Match.AI._inLoop = false + Match.AI._stopRequested = true 표지로 다음 콜백 즉시 return.
      if (RoF.Match && RoF.Match.AI) {
        try {
          RoF.Match.AI._inLoop = false;
          RoF.Match.AI._stopRequested = true;
        } catch(e){}
      }
    },

    /**
     * 보상 화면 → 메뉴 복귀 (Plan 1 Task 6, 2026-05-10).
     * index.html `data-action="game.afterBattle"` 확인 버튼이 호출.
     */
    afterBattle(){
      if (RoF.Game.showMenu) {
        RoF.Game.showMenu();
      } else if (RoF.UI && typeof RoF.UI.show === 'function') {
        RoF.UI.show('menu-screen');
      }
    },
  });
})();
