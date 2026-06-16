'use strict';

// 98_dev_helpers.js — Playwright e2e 가속용 dev helper (2026-05-16)
// 사용처:
//   - Playwright 테스트가 매치 상태 진입 + 상태 dump 를 1줄로 처리
//   - 콘솔에서 디버깅 시 RoF.dev.dumpMatch() 등 직접 호출 가능
//
// 함수:
//   - RoF.dev.startTestMatch(opts)   : 매치 즉시 시작 (로그인 / 마을 / 매칭 건너뛰기)
//   - RoF.dev.dumpMatch()            : 매치 state 핵심 필드 JSON
//   - RoF.dev.dumpHand(sideKey)      : 손패 카드 id 배열
//   - RoF.dev.forcePhase(phase)      : phase 강제 전환 (board/card)
//   - RoF.dev.attack(uid, targetUid) : 한 줄 공격
//   - RoF.dev.endTurn()              : 턴 종료
//
// 모두 RoF.dev 네임스페이스로 격리 → 프로덕션 영향 0.

(function(global){
  const RoF = global.RoF = global.RoF || {};
  const dev = RoF.dev = RoF.dev || {};

  /**
   * 매치 즉시 시작. 로그인/마을/매칭 흐름 모두 건너뛰고 tcg-screen 활성 + Match.start 호출.
   * 사용: RoF.dev.startTestMatch({phase:'board', playerHero, enemyHero, playerDeck, enemyDeck})
   *
   * opts 모두 옵션:
   *   - phase:        'card' (default) | 'board' — 보드 페이즈로 즉시 진입
   *   - playerHero:   영웅 객체 또는 {role, element, gender} (default: warrior/fire/m)
   *   - enemyHero:    영웅 객체 또는 {role, element, gender} (default: ranger/water/f)
   *   - playerDeck:   카드 데이터 배열 (default: 14 apprentice + 8 guard + 4 fireSpirit + 2 spell)
   *   - enemyDeck:    카드 데이터 배열 (default: player 와 동일)
   *   - playerBoard:  매치 시작 직후 player 보드에 깔 unit 배열 (id 또는 데이터)
   *   - enemyBoard:   매치 시작 직후 enemy 보드에 깔 unit 배열
   *
   * 반환: {ok, state, msg?}
   */
  dev.startTestMatch = function(opts){
    opts = opts || {};
    if(!RoF.Data || !RoF.Match || !RoF.Match.UI){
      return {ok:false, msg:'RoF.Data / RoF.Match 미로드'};
    }
    // 1) tcg-screen 활성 (UI.show 가 다른 화면 다 해제)
    if(RoF.UI && RoF.UI.show) RoF.UI.show('tcg-screen');

    // 2) 영웅 객체 정규화
    const _normalizeHero = (input, dflt) => {
      if(!input) input = dflt;
      if(input && input.HP != null && input.ATK != null && input.SOUL != null) return input;
      return RoF.Data.createHero({
        gender:    input?.gender    || dflt.gender,
        role:      input?.role      || dflt.role,
        element:   input?.element   || dflt.element,
        skinIndex: input?.skinIndex || 0,
        name:      input?.name      || dflt.name,   // dev 검수 실게임 일치 (없으면 createHero generic 폴백)
      });
    };
    // dev 검수가 실게임처럼 보이게 default 영웅에 이름 부여 (플레이어=시뮬 입력이름 / 적=봇 이름풀).
    // 조건부: opts.enemyHero 명시되면 enemyName() 미호출 → 회귀(test_run) Math.random 시드 순서 불변.
    const _eName = (!opts.enemyHero && RoF.helpers && RoF.helpers.enemyName) ? RoF.helpers.enemyName() : undefined;
    const pHero = _normalizeHero(opts.playerHero, {gender:'m', role:'warrior', element:'fire', name: opts.playerHero ? undefined : '용사'});
    const eHero = _normalizeHero(opts.enemyHero,  {gender:'f', role:'ranger',  element:'water', name: _eName});

    // 3) 덱 정규화 — 2026-05-17 fix: unit + bundledSkillIds 자동 묶음.
    //    옛 흐름은 random unit/spell 만 → 사용자 환경 (Formation._buildBattleDeck) 과 mismatch.
    //    신 룰: 각 동료 unit + 그 시그니처 스킬 (bundledByUnit 메타) 정합. RoF.Formation 흐름과 동일.
    const _defaultDeck = () => {
      const UNITS = RoF.Data.UNITS || [];
      const SKILLS = RoF.Data.SKILLS || [];
      const companionIds = ['apprentice', 'guard', 'fire_spirit'];
      const deck = [];
      companionIds.forEach(uid => {
        const unit = UNITS.find(u => u.id === uid);
        if(!unit) return;
        deck.push(unit);  // 동료 카드 자체
        (unit.bundledSkillIds || []).forEach(sid => {
          const s = SKILLS.find(sk => sk.id === sid);
          if(s) deck.push(Object.assign({}, s, {bundledByUnit: uid}));
        });
      });
      return deck;
    };
    const playerDeck = (opts.playerDeck && opts.playerDeck.length) ? opts.playerDeck : _defaultDeck();
    const enemyDeck  = (opts.enemyDeck  && opts.enemyDeck.length)  ? opts.enemyDeck  : _defaultDeck();

    // 4) 매치 시작
    RoF.Match.UI.startMatch({
      playerHero: pHero,
      enemyHero:  eHero,
      playerDeck: playerDeck,
      enemyDeck:  enemyDeck,
    });

    // 5) 보드 강제 세팅 (요청 시)
    const _placeBoard = (sideKey, board) => {
      if(!board || !board.length) return;
      const side = RoF.Match.state && RoF.Match.state[sideKey];
      if(!side) return;
      const UNITS = RoF.Data.UNITS || [];
      side.board = [];
      board.forEach(item => {
        const tmpl = (typeof item === 'string')
          ? UNITS.find(u => u.id === item)
          : item;
        if(!tmpl) return;
        // 정식 instantiate 재사용 (2026-06-06) — 옛 수동 부분복사는 attachments/_def/_reflect 등
        // 런타임 필드를 누락해 attach-unit 부착 시 크래시. 단일 진실(Match._instantiate)로 통일.
        const inst = (RoF.Match._instantiate)
          ? RoF.Match._instantiate(tmpl)
          : Object.assign({}, tmpl, {
              uid: 'dev_' + sideKey + '_' + Math.random().toString(36).slice(2, 8),
              curHP: tmpl.HP, curATK: tmpl.ATK, baseATK: tmpl.ATK, maxHP: tmpl.HP,
              attachments: [], isDead: false, exhausted: false, attackedThisTurn: false, _acted: false,
            });
        if(!inst) return;
        side.board.push(inst);
      });
    };
    _placeBoard('player', opts.playerBoard);
    _placeBoard('enemy',  opts.enemyBoard);

    // 6) phase=board 요청 시 강제 전환
    if(opts.phase === 'board' && RoF.Match._beginBoardPhase){
      RoF.Match._beginBoardPhase();
    }

    // 6b) 2026-05-28 4순위 — skipCinematic 옵션 (visual_match_cycle 회귀 안정화).
    //   Match.start 가 events.push 한 coin-flip + match-start-cinematic 제거 → cinematic anim wait 0.
    //   회귀 시간 대폭 단축 + #13/15/16 timing race 해소 (cinematic 후 trigger 흐름).
    //   사용자 매치 영향 0 — RoF.dev.startTestMatch 회귀 전용 옵션.
    if(opts.skipCinematic !== false && RoF.Match.state && Array.isArray(RoF.Match.state.events)){
      RoF.Match.state.events = RoF.Match.state.events.filter(
        ev => ev.type !== 'coin-flip' && ev.type !== 'match-start-cinematic'
      );
    }

    // 7) 렌더
    if(RoF.Match.UI.renderState) RoF.Match.UI.renderState();

    return {ok:true, state: dev.dumpMatch()};
  };

  /**
   * 매치 state 핵심 필드 JSON dump.
   * 사용: const st = RoF.dev.dumpMatch(); console.log(st);
   */
  dev.dumpMatch = function(){
    const st = RoF.Match && RoF.Match.state;
    if(!st) return null;
    const _dumpUnit = u => u && {
      uid: u.uid, id: u.id, name: u.name,
      ATK: u.curATK, HP: u.curHP, maxHP: u.maxHP,
      isDead: u.isDead, exhausted: u.exhausted, attackedThisTurn: u.attackedThisTurn,
      _acted: u._acted,
      matchLevel: u.matchLevel || u._matchLevel,
      matchXP: u.matchXP || u._matchExp,
    };
    const _dumpSide = (sideKey) => {
      const s = st[sideKey];
      if(!s) return null;
      return {
        hero: _dumpUnit(s.hero),
        board: (s.board || []).map(_dumpUnit),
        hand: (s.hand || []).map(c => c && {uid:c.uid, id:c.id, kind:c.kind, NEED_SOUL:c.NEED_SOUL}),
        soulPool: s.soulPool,
        deck: (s.deck || []).length,
        discard: (s.discardPile || []).length,
        grave: (s.gravePile || []).length,
        dormant: (s.dormantPile || []).length,
      };
    };
    return {
      phase: st.phase, side: st.side, round: st.round,
      firstSide: st.firstSide,
      boardTurnQueue: st.boardTurnQueue,
      boardTurnCursor: st.boardTurnCursor,
      winner: st.winner,
      events: (st.events || []).map(e => e && e.type),
      player: _dumpSide('player'),
      enemy:  _dumpSide('enemy'),
    };
  };

  /**
   * 2026-05-17 telemetry — _processEvents 가 처리한 events history 반환.
   * 사용자 보고 시점에 events sequence 추적 → root cause 진단.
   * 사용: RoF.dev.dumpEventsHistory(20)  // 최근 20건
   */
  dev.dumpEventsHistory = function(limit){
    const st = RoF.Match && RoF.Match.state;
    if(!st || !Array.isArray(st._eventsHistory)) return [];
    const arr = st._eventsHistory;
    const n = limit ? Math.min(limit, arr.length) : arr.length;
    return arr.slice(-n);
  };

  dev.dumpHand = function(sideKey){
    sideKey = sideKey || 'player';
    const s = RoF.Match && RoF.Match.state && RoF.Match.state[sideKey];
    return s && (s.hand || []).map(c => c && c.id);
  };

  /** phase 강제 전환. 디버깅용. */
  dev.forcePhase = function(phase){
    const st = RoF.Match && RoF.Match.state;
    if(!st) return {ok:false, msg:'매치 미시작'};
    if(phase === 'board' && RoF.Match._beginBoardPhase){
      RoF.Match._beginBoardPhase();
    } else {
      st.phase = phase;
    }
    if(RoF.Match.UI && RoF.Match.UI.renderState) RoF.Match.UI.renderState();
    return {ok:true, phase: st.phase};
  };

  /** 단축 공격. attacker uid + target uid (또는 '__hero__'). */
  dev.attack = function(attackerUid, targetUid){
    if(!RoF.Match || !RoF.Match.api) return {ok:false, msg:'Match.api 없음'};
    return RoF.Match.api.attack('player', attackerUid, {targetUid: targetUid || '__hero__'});
  };

  /** 카드 페이즈 턴 종료. */
  dev.endTurn = function(){
    if(RoF.Match && RoF.Match.endCardPhase) return RoF.Match.endCardPhase('player');
    return {ok:false, msg:'endCardPhase 없음'};
  };

  /** ev queue 강제 flush (Playwright timing 회피용). _processEvents 완료까지 await. */
  dev.flushEvents = async function(){
    if(RoF.Match && RoF.Match.UI && RoF.Match.UI._processEvents){
      await RoF.Match.UI._processEvents();
    }
    return dev.dumpMatch();
  };

  /** ev queue 처리 트리거만 (fire-and-forget) — cascade 진행 중 element polling 가능.
   *  2026-05-28 D1 — visual_match_cycle 의 measureElementLifecycle 가 cascade 진행 중에 element 잡으려면
   *  trigger 가 cascade 끝까지 기다리면 안 됨 → 트리거 후 즉시 return → polling 시작 → element 등장 캡처.
   *  flushEvents 와 의미 분리: flushEvents = 완료까지 wait / triggerProcessEvents = trigger only.
   */
  dev.triggerProcessEvents = function(){
    if(RoF.Match && RoF.Match.UI && RoF.Match.UI._processEvents){
      RoF.Match.UI._processEvents();  // await X
    }
    return {ok:true, triggered:true};
  };

  /** 매치 시작 events (cinematic ~10초 분량) 완전 처리 대기.
   *  2026-05-28 3순위 — visual_match_cycle 13~16 fail 진단 결과:
   *    cinematic events (coin-flip, match-start-cinematic, round-start, card-phase-start,
   *                      turn-banner, round-hand-draw 등) 각 anim 1~3초 → 총 6~10초 처리.
   *    회귀가 trigger (killHero/levelup 등) 호출 시 cinematic 진행 중이라 큐 stuck.
   *  helper 가 events 큐 빌 때까지 polling + 명시적 trigger.
   *  사용: await RoF.dev.waitForIdleEvents({maxMs: 12000})
   */
  dev.waitForIdleEvents = async function(opts){
    const maxMs = (opts && opts.maxMs) || 12000;
    const pollMs = (opts && opts.pollMs) || 200;
    const start = Date.now();
    while(Date.now() - start < maxMs){
      const st = RoF.Match && RoF.Match.state;
      if(!st) return {ok:false, msg:'state 없음'};
      const queueLen = (st.events || []).length;
      if(queueLen === 0){
        // 큐 비었지만 _processEvents 가 진행 중일 수도 — 추가 200ms wait 후 재확인
        await new Promise(r => setTimeout(r, 200));
        const queueLen2 = (st.events || []).length;
        if(queueLen2 === 0) return {ok:true, elapsedMs: Date.now() - start};
      }
      // 큐 잔여 시 _processEvents 트리거 (fire-and-forget, 재진입 차단으로 안전)
      if(RoF.Match.UI && RoF.Match.UI._processEvents){
        RoF.Match.UI._processEvents();
      }
      await new Promise(r => setTimeout(r, pollMs));
    }
    const queueRemainder = RoF.Match.state.events ? RoF.Match.state.events.length : -1;
    return {ok:false, msg:`maxMs ${maxMs} 초과 — queue 잔여 ${queueRemainder}`, elapsedMs: Date.now() - start};
  };

  /** 특정 unit/hero 즉시 사망 처리 (visual cascade 자동 회귀용).
   *  _damage 사용 → 일반 데미지 cascade path 그대로 진행 (events.push('unit-death') 자연 발생).
   *  사용: RoF.dev.killUnit('player', 'u_42') / RoF.dev.killFirstUnit('enemy') / RoF.dev.killHero('enemy')
   */
  dev.killUnit = function(side, uid){
    if(!RoF.Match || !RoF.Match.state) return {ok:false, msg:'state 없음'};
    if(!RoF.Match._damage)             return {ok:false, msg:'_damage 없음'};
    const st = RoF.Match.state[side];
    if(!st) return {ok:false, msg:'side 없음: ' + side};
    for(const slot of (st.board || [])){
      if(slot && slot.uid === uid){
        const hp = (slot.curHP|0) + (slot.HP|0) + (slot._def|0) + 99;
        RoF.Match._damage(slot, hp, {source:'dev_kill', isSpell:true, _pierceDef:true, _noReflect:true});
        // _damage 는 _checkWinner 자동 호출 안 함 — 명시 호출
        if(RoF.Match._checkWinner) RoF.Match._checkWinner();
        return {ok:true, killed:uid, side};
      }
    }
    return {ok:false, msg:'unit not found uid=' + uid};
  };

  dev.killFirstUnit = function(side){
    if(!RoF.Match || !RoF.Match.state) return {ok:false, msg:'state 없음'};
    const st = RoF.Match.state[side];
    if(!st) return {ok:false, msg:'side 없음: ' + side};
    for(const slot of (st.board || [])){
      if(slot && !slot.isDead){
        return dev.killUnit(side, slot.uid);
      }
    }
    return {ok:false, msg:'no live unit on ' + side + ' board'};
  };

  dev.killHero = function(side){
    if(!RoF.Match || !RoF.Match.state) return {ok:false, msg:'state 없음'};
    if(!RoF.Match._damage)             return {ok:false, msg:'_damage 없음'};
    const st = RoF.Match.state[side];
    if(!st || !st.hero) return {ok:false, msg:'hero 없음: ' + side};
    const heroBefore = {
      uid: st.hero.uid,
      curHP_before: st.hero.curHP,
      HP_field: st.hero.HP,
      isDead_before: !!st.hero.isDead,
      def_before: st.hero._def,
    };
    const eventsLenBefore = (RoF.Match.state.events || []).length;
    // _damage 는 curHP 차감 (line 2152). curHP+HP+def+99 보장.
    const hp = (st.hero.curHP|0) + (st.hero.HP|0) + (st.hero._def|0) + 99;
    RoF.Match._damage(st.hero, hp, {source:'dev_kill', isSpell:true, _pierceDef:true, _noReflect:true});
    // _damage 는 _checkWinner 자동 호출 안 함 — match-end-banner cascade trigger 위해 명시 호출.
    if(RoF.Match._checkWinner) RoF.Match._checkWinner();
    const eventsLenAfter = (RoF.Match.state.events || []).length;
    const newEvents = (RoF.Match.state.events || []).slice(eventsLenBefore).map(e => e && e.type).filter(Boolean);
    return {
      ok: true,
      killedHero: side,
      debug: {
        heroBefore,
        curHP_after: st.hero.curHP,
        isDead_after: !!st.hero.isDead,
        eventsLenBefore,
        eventsLenAfter,
        newEvents,
        winner: RoF.Match.state.winner,
      },
    };
  };

  /** 매치 시나리오 + 즉시 trigger 복합 helper (visual_match_cycle.js checkpoint 13/14 용).
   *  scenario: 'board_basic' 등 (RoF.dev.SCENARIOS 키).
   *  kill: 'firstUnit' / 'hero' / null.
   *  side: kill 대상 진영 ('enemy' default).
   *  매치 진행 중이면 새 매치로 reset → scenario 진입 → 즉시 trigger.
   */
  dev.startScenarioAndKill = function(opts){
    if(!RoF.Match) return {ok:false, msg:'Match 없음'};
    const o = opts || {};
    const scenario = o.scenario || 'board_basic';
    const kill = o.kill || null;
    const side = o.side || 'enemy';
    if(!dev.SCENARIOS[scenario]) return {ok:false, msg:'unknown scenario: ' + scenario};
    // 새 매치 시작 — 옛 state clear
    const startResult = dev.startTestMatch(dev.SCENARIOS[scenario]);
    if(!startResult || startResult.ok === false) return {ok:false, msg:'startTestMatch fail: ' + (startResult && startResult.msg)};
    // trigger
    if(kill === 'firstUnit') return Object.assign({scenario, kill}, dev.killFirstUnit(side));
    if(kill === 'hero')      return Object.assign({scenario, kill}, dev.killHero(side));
    return {ok:true, scenario, kill: null};
  };

  /** 영웅 매치 progression — XP 2 채우고 _autoHeroLevelUpCheck 직접 호출 (visual cascade 자동 trigger).
   *  사용: RoF.dev.triggerHeroLevelup('player')
   *  메모리: project_visual_cascade_standardization.md (cascade lifecycle 자동 회귀)
   */
  dev.triggerHeroLevelup = function(side){
    if(!RoF.Match || !RoF.Match.state) return {ok:false, msg:'state 없음'};
    if(!RoF.Match._autoHeroLevelUpCheck) return {ok:false, msg:'_autoHeroLevelUpCheck 외부 노출 X'};
    const st = RoF.Match.state[side];
    if(!st || !st.hero) return {ok:false, msg:'hero 없음: ' + side};
    const before = { lv: st.hero.matchLevel, xp: st.hero.matchXP };
    st.hero.matchXP = (st.hero.matchXPNext || 2);
    RoF.Match._autoHeroLevelUpCheck(st, st.hero);
    return {ok:true, side, before, after: {lv: st.hero.matchLevel, xp: st.hero.matchXP}};
  };

  /** 동료 unit 매치 progression — 첫 살아있는 unit 의 _matchExp 채우고 _autoUnitLevelUpCheck 호출.
   *  사용: RoF.dev.triggerFirstUnitLevelup('player')
   */
  dev.triggerFirstUnitLevelup = function(side){
    if(!RoF.Match || !RoF.Match.state) return {ok:false, msg:'state 없음'};
    if(!RoF.Match._autoUnitLevelUpCheck) return {ok:false, msg:'_autoUnitLevelUpCheck 외부 노출 X'};
    const st = RoF.Match.state[side];
    if(!st) return {ok:false, msg:'side 없음: ' + side};
    for(const u of (st.board || [])){
      if(u && !u.isDead && u.kind === 'unit'){
        const before = { lv: u._matchLevel, exp: u._matchExp, uid: u.uid };
        u._matchExp = (u._matchXpNext || 2);
        RoF.Match._autoUnitLevelUpCheck(u);
        return {ok:true, side, before, after: {lv: u._matchLevel, exp: u._matchExp, uid: u.uid}};
      }
    }
    return {ok:false, msg:'no live unit on ' + side + ' board'};
  };

  // === 2026-05-17 URL 파라미터 hook — 정본 거울 매치 검증 환경 ===
  // 사용: index.html?test=1&scenario=board_basic[&css=mockup/.../delta.css]
  // 시안 작성 시 mockup 별도 HTML 작성 X → delta CSS 하나만 + 정본 100% 환경
  //
  // 프리셋 시나리오 추가 시 _SCENARIOS 에 entry 추가.
  // 자유 지정: ?test=1&phase=board&pboard=apprentice,guard&eboard=apprentice

  const _SCENARIOS = {
    board_basic:   { phase:'board', playerBoard:['apprentice'],          enemyBoard:['apprentice'] },
    hero_attack:   { phase:'board', playerBoard:[],                      enemyBoard:[] },
    levelup_test:  { phase:'board', playerBoard:['apprentice','guard'],  enemyBoard:['apprentice'] },
    card_phase:    { phase:'card',  playerBoard:[],                      enemyBoard:[] },
    round_start:   {},
  };
  dev.SCENARIOS = _SCENARIOS;

  function _parseTestUrl(){
    if(typeof location === 'undefined') return null;
    try {
      const url = new URL(location.href);
      if(url.searchParams.get('test') !== '1') return null;
      const scName = url.searchParams.get('scenario') || 'board_basic';
      const preset = _SCENARIOS[scName] || _SCENARIOS.board_basic;
      const pb = url.searchParams.get('pboard');
      const eb = url.searchParams.get('eboard');
      return {
        scenario:    scName,
        phase:       url.searchParams.get('phase') || preset.phase,
        playerBoard: pb ? pb.split(',').filter(Boolean) : (preset.playerBoard || []),
        enemyBoard:  eb ? eb.split(',').filter(Boolean) : (preset.enemyBoard  || []),
        deltaCss:    url.searchParams.get('css'),
      };
    } catch(e){ return null; }
  }

  function _injectDeltaCss(href){
    if(!href) return;
    const old = document.getElementById('dev-delta-css');
    if(old) old.remove();
    const link = document.createElement('link');
    link.id = 'dev-delta-css';
    link.rel = 'stylesheet';
    link.href = href + (href.includes('?') ? '&' : '?') + 'v=' + Date.now();
    document.head.appendChild(link);
  }

  function _buildDevToolbar(opts){
    if(document.getElementById('dev-toolbar')) return;
    const bar = document.createElement('div');
    bar.id = 'dev-toolbar';
    bar.style.cssText = 'position:fixed;top:6px;right:6px;z-index:99999;'
      + 'background:rgba(20,15,25,.92);color:#f0d090;padding:6px 10px;'
      + "border:1px solid #6a4a30;border-radius:6px;"
      + "font:12px 'Noto Sans KR','Segoe UI',sans-serif;"
      + 'display:flex;gap:8px;align-items:center;flex-wrap:wrap;max-width:560px;'
      + 'pointer-events:auto;user-select:none;';
    const btnStyle = 'background:#2a1810;color:#f0d090;border:1px solid #6a4a30;'
      + 'border-radius:4px;padding:3px 8px;cursor:pointer;font-size:11px;';
    const selOpts = Object.keys(_SCENARIOS).map(k =>
      '<option value="' + k + '"' + (k===opts.scenario?' selected':'') + '>' + k + '</option>'
    ).join('');
    bar.innerHTML =
      '<span style="color:#ffd060;letter-spacing:1px;font-weight:700;">🛠 DEV</span>'
      + '<select id="dev-sc" style="background:#1a1218;color:#f0d090;border:1px solid #6a4a30;padding:2px 6px;font-size:11px;">' + selOpts + '</select>'
      + '<button id="dev-restart" style="' + btnStyle + '">⟳ 재시작</button>'
      + '<button id="dev-dump" style="' + btnStyle + '">📋 dump</button>'
      + '<button id="dev-css-reload" style="' + btnStyle + '">🎨 CSS 재로드</button>'
      + '<button id="dev-hide" style="' + btnStyle + '">✕</button>'
      + '<span id="dev-status" style="color:#a08060;font-size:10px;margin-left:4px;"></span>';
    document.body.appendChild(bar);

    bar.querySelector('#dev-sc').addEventListener('change', e => {
      const url = new URL(location.href);
      url.searchParams.set('scenario', e.target.value);
      location.href = url.toString();
    });
    bar.querySelector('#dev-restart').addEventListener('click', () => location.reload());
    bar.querySelector('#dev-dump').addEventListener('click', () => {
      const d = dev.dumpMatch();
      console.log('[DEV DUMP]', d);
      document.getElementById('dev-status').textContent =
        'dump → console (phase=' + (d&&d.phase) + ' round=' + (d&&d.round) + ' side=' + (d&&d.side) + ')';
    });
    bar.querySelector('#dev-css-reload').addEventListener('click', () => {
      if(opts.deltaCss){
        _injectDeltaCss(opts.deltaCss);
        document.getElementById('dev-status').textContent = 'delta CSS reload: ' + opts.deltaCss;
      } else {
        document.getElementById('dev-status').textContent = 'no ?css= param';
      }
    });
    bar.querySelector('#dev-hide').addEventListener('click', () => bar.style.display = 'none');
  }

  dev.bootFromUrl = function(){
    const opts = _parseTestUrl();
    if(!opts) return;
    let tries = 0;
    const tryStart = () => {
      if(tries++ > 50){ console.warn('[DEV] RoF.Match 로드 실패 — 50회 재시도 후 포기'); return; }
      if(!RoF.Match || !RoF.Match.UI || !RoF.Data || !RoF.Data.UNITS){
        return setTimeout(tryStart, 100);
      }
      if(opts.deltaCss) _injectDeltaCss(opts.deltaCss);
      _buildDevToolbar(opts);
      dev.startTestMatch({
        phase:       opts.phase,
        playerBoard: opts.playerBoard,
        enemyBoard:  opts.enemyBoard,
      });
      console.log('[DEV] ?test=1 scenario=' + opts.scenario + ' 매치 즉시 시작', opts);
    };
    tryStart();
  };

  // ───── 매치 상황 셋업 헬퍼 (디버그 패널 + 콘솔 공용, 2026-06-03) ─────
  function _inMatch(){ return !!(RoF.Match && RoF.Match.state && RoF.Match.state.player); }
  function _rerender(){ if(RoF.Match.UI && RoF.Match.UI.renderState) RoF.Match.UI.renderState(); }

  // 발화 강화 상태 즉시 셋업 — pyromancer 보드 + 화염 손패(화염구/인페르노) + 발화 충전.
  dev.setupFireUpgrade = function(){
    if(!_inMatch()) return {ok:false, msg:'매치 중에 실행하세요'};
    const D = RoF.Data, s = RoF.Match.state.player;
    if(!s.board.find(u => u && !u.isDead && u.id === 'pyromancer')){
      const p = D.UNITS.find(u => u.id === 'pyromancer');
      if(p) s.board.push(Object.assign(JSON.parse(JSON.stringify(p)),
        {uid:'dbgpyro', kind:'unit', curHP:10, maxHP:10, curATK:2, baseATK:2, isDead:false, exhausted:false, attachments:[], keywords:[]}));
    }
    s.hand[0] = Object.assign(JSON.parse(JSON.stringify(D.SKILLS.find(x => x.id === 'sk_pyromancer_fireball'))), {uid:'dbgfb'});
    s.hand[1] = Object.assign(JSON.parse(JSON.stringify(D.SKILLS.find(x => x.id === 'sk_inferno_blast'))), {uid:'dbginf'});
    s.soulPool = Math.max(s.soulPool || 0, 20);
    s._fireUpgradePending = true;
    // ⚠️ side/phase 는 절대 건드리지 않는다 — 강제 전환은 진행 중 매치 턴 흐름을 깨뜨림
    //    (2026-06-03 사고: side='player' 강제 → 적턴에서 내턴 안 옴). 강화는 player 카드페이즈에 자동 표시.
    _rerender();
    const onMyTurn = (RoF.Match.state.side === 'player');
    return {ok:true, msg: onMyTurn
      ? '발화 강화 셋업 — 손패 1·2번(화염구/인페르노) 호버해보세요'
      : '발화 강화 셋업 완료 — 지금 적턴이라, 내 턴이 오면 손패 1·2번에 표시됩니다'};
  };
  // 반사화상(화염방패) 즉시 검증 셋업 (2026-06-06) — 보호막 두른 화염술사 + 근접 적이 1회 타격한 결과(적 화상)까지 재현.
  //   _damage 직접 호출이라 card-phase(염룡술 등) 개입 0 / 턴 흐름 안 건드림. 적 카드에 🔥 뜨면 성공.
  dev.setupReflectBurnTest = function(){
    if(!_inMatch()) return {ok:false, msg:'매치 중에 실행하세요 (?test=1 로 진입)'};
    const M = RoF.Match, D = RoF.Data, st = M.state;
    if(typeof M._instantiate !== 'function') return {ok:false, msg:'M._instantiate 미노출 — 새로고침(Ctrl+Shift+R)'};
    // 1) 아군 보드 깨끗이 비우고 화염술사 1개만 (시나리오 leftover 죽은 유닛 제거 — 데모 깔끔)
    const ally = M._instantiate(D.UNITS.find(u => u.id === 'pyromancer'));
    ally.curHP = 12; ally.maxHP = 12; ally.isDead = false; ally.exhausted = false;  // 기본 HP 1 약골 → 살아남게 보강
    st.player.board = [ally];
    // 2) 화염방패 부착 (보호막 + 반사화상)
    const fs = JSON.parse(JSON.stringify(D.SKILLS.find(s => s.id === 'sk_pyromancer_flame_shield')));
    ally.attachments.push(fs);
    M._applyAttachBuff(ally, fs);
    // 3) 적 근접(melee) 보병 배치
    const foe = M._instantiate(D.UNITS.find(u => u.id === 'infantry'));
    foe.curHP = 10; foe.maxHP = 10; foe.curATK = 3; foe.baseATK = 3; foe.exhausted = false;
    st.enemy.board = [foe];
    // 4) 적 근접 유닛이 화염술사 1회 타격 → 반사화상 발동 (card-phase 개입 0)
    M._damage(ally, foe.curATK, {sourceUnit: foe});
    _rerender();
    return {ok:true, msg:'반사화상 테스트 — 화염술사 보호막 흡수 / 적 보병 화상 '
      + (foe._burnAmount||0) + ' (' + (foe._burnTurns||0) + '턴). 적 카드에 🔥 확인'};
  };
  // 화염방패 카드를 바로 손패에 (직접 플레이용) — 아군 화염술사 + 영혼까지 보장해 즉시 사용 가능.
  dev.addFlameShieldHand = function(){
    if(!_inMatch()) return {ok:false, msg:'매치 중에 실행하세요 (?test=1)'};
    const M = RoF.Match, D = RoF.Data, st = M.state;
    // 살아있는 화염술사 아군 보장 (드래그 타겟)
    let ally = st.player.board.find(u => u && !u.isDead && u.id === 'pyromancer');
    if(!ally && typeof M._instantiate === 'function'){
      ally = M._instantiate(D.UNITS.find(u => u.id === 'pyromancer'));
      ally.curHP = 12; ally.maxHP = 12; ally.isDead = false; ally.exhausted = false;
      st.player.board = (st.player.board||[]).filter(u => u && !u.isDead);
      st.player.board.push(ally);
    }
    st.player.soulPool = Math.max(st.player.soulPool || 0, 10);
    dev.addCardToHand('sk_pyromancer_flame_shield');
    _rerender();
    return {ok:true, msg:'화염방패 손패 추가 — 카드를 화염술사 위로 드래그(또는 카드 클릭→화염술사 클릭)'};
  };
  dev.giveSoul = function(n){ if(!_inMatch()) return; RoF.Match.state.player.soulPool = (RoF.Match.state.player.soulPool||0) + (n||10); _rerender(); };
  dev.addCardToHand = function(id){
    if(!_inMatch() || !id) return {ok:false};
    const sk = (RoF.Data.SKILLS||[]).find(x => x.id === id) || (RoF.Data.UNITS||[]).find(x => x.id === id);
    if(!sk) return {ok:false, msg:'id 없음: ' + id};
    const s = RoF.Match.state.player, idx = s.hand.findIndex(c => !c);
    const inst = Object.assign(JSON.parse(JSON.stringify(sk)), {uid:'dbg_'+id+'_'+(s.hand.length)});
    if(idx >= 0) s.hand[idx] = inst; else s.hand.push(inst);
    _rerender();
    return {ok:true, msg:'손패 추가: ' + id};
  };

  // ───── 디버그 패널 UI — 백틱(`) 키 토글 (StS dev console 차용, 2026-06-03) ─────
  function _toast(msg, ok){
    let t = document.getElementById('rof-dbg-toast');
    if(!t){ t = document.createElement('div'); t.id = 'rof-dbg-toast';
      t.style.cssText = 'position:fixed;left:50%;bottom:40px;transform:translateX(-50%);z-index:100000;'
        + 'padding:9px 16px;border-radius:8px;font:13px/1.4 sans-serif;color:#fff;pointer-events:none;'
        + 'box-shadow:0 4px 14px rgba(0,0,0,.5);transition:opacity .3s;opacity:0';
      document.body.appendChild(t); }
    t.textContent = msg; t.style.background = (ok === false) ? '#a33' : '#2a6a3a'; t.style.opacity = '1';
    clearTimeout(t._tm); t._tm = setTimeout(() => { t.style.opacity = '0'; }, 2200);
  }
  function _runAction(fn){ try{ const r = fn(); if(r && r.msg) _toast(r.msg, r.ok); else _toast('완료'); }catch(e){ _toast(String(e && e.message || e), false); } }

  let _dbgPanel = null;
  function _buildDebugPanel(){
    if(_dbgPanel) return _dbgPanel;
    const p = document.createElement('div');
    p.id = 'rof-debug-panel';
    p.style.cssText = 'position:fixed;top:14px;right:14px;z-index:99999;display:none;width:212px;'
      + 'background:#12100c;border:1px solid #5a451e;border-radius:10px;padding:12px;'
      + 'font:13px/1.5 "Noto Serif KR",sans-serif;color:#e8dcc8;box-shadow:0 8px 26px rgba(0,0,0,.7)';
    p.innerHTML =
      '<div style="font-weight:900;color:#f3c64b;text-align:center;margin-bottom:8px;font-size:13px">🛠 DEBUG <span style="color:#7d6f58;font-weight:400">( ` 토글 )</span></div>'
      + '<div style="font-size:11px;color:#9d8e72;margin-bottom:8px;text-align:center">매치 중 사용 · 프로덕션 무해</div>'
      + _btn('fshield', '🛡 화염방패 손패에 추가')
      + _btn('refl',  '🔥 반사화상 자동시연')
      + _btn('fire',  '🔥 발화 강화 셋업')
      + _btn('soul',  '💧 영혼 +10')
      + _btn('card',  '➕ 카드 손패 추가…')
      + _btn('dump',  '📋 매치 상태 콘솔 dump')
      + _btn('endt',  '⏭ 턴 종료');
    document.body.appendChild(p);
    p.addEventListener('click', (e) => {
      const b = e.target.closest('[data-act]'); if(!b) return;
      const act = b.dataset.act;
      if(act === 'fshield') _runAction(() => dev.addFlameShieldHand());
      else if(act === 'fire') _runAction(() => dev.setupFireUpgrade());
      else if(act === 'refl') _runAction(() => dev.setupReflectBurnTest());
      else if(act === 'soul') _runAction(() => { dev.giveSoul(10); return {ok:true, msg:'영혼 +10'}; });
      else if(act === 'card'){ const id = prompt('추가할 카드 id (예: sk_execute / sk_invincible)'); if(id) _runAction(() => dev.addCardToHand(id.trim())); }
      else if(act === 'dump'){ console.log('[DEBUG] match state:', dev.dumpMatch && dev.dumpMatch()); _toast('콘솔(F12) 확인'); }
      else if(act === 'endt') _runAction(() => { dev.endTurn(); return {ok:true, msg:'턴 종료'}; });
    });
    _dbgPanel = p; return p;
  }
  function _btn(act, label){
    return '<button data-act="' + act + '" style="display:block;width:100%;margin:4px 0;padding:7px 10px;'
      + 'background:#241a12;color:#f0e2c8;border:1px solid #4a3a1e;border-radius:7px;cursor:pointer;'
      + 'font:13px/1 inherit;text-align:left">' + label + '</button>';
  }
  function _toggleDebugPanel(){
    const p = _buildDebugPanel();
    p.style.display = (p.style.display === 'none') ? 'block' : 'none';
  }
  dev.toggleDebugPanel = _toggleDebugPanel;

  // ── q_wolf_cull 시연 (design/quest_lines_v1.md v3, 2026-06-07) ──
  // 우두머리 늑대를 적 영웅으로 한 매치 즉시 시작. AI 가 시그니처 5(할퀴기/물기/민첩함/자연의선물/우두머리의부름) 사용.
  // 사용: RoF.dev.startWolfMatch()  (백틱 디버그모드 병행 권장)
  dev.startWolfMatch = function(opts){
    opts = opts || {};
    const wolf = RoF.Data.getHeroById && RoF.Data.getHeroById('hero_wolf_alpha');
    if(!wolf){ console.warn('[dev] hero_wolf_alpha 없음'); return {ok:false}; }
    const SK = RoF.Data.SKILLS || [];
    const enemyDeck = [];
    (wolf.bundledSkillIds||[]).forEach(sid => { const s = SK.find(k=>k.id===sid); if(s) enemyDeck.push(Object.assign({},s,{bundledByUnit:'hero_wolf_alpha'})); });
    const wolfUnit = (RoF.Data.UNITS||[]).find(u=>u.id==='wolf');
    if(wolfUnit){ for(let i=0;i<3;i++) enemyDeck.push(Object.assign({},wolfUnit)); while(enemyDeck.length < 30) enemyDeck.push(Object.assign({},wolfUnit)); }
    return dev.startTestMatch(Object.assign({ enemyHero: wolf, enemyDeck }, opts));
  };

  // ── 영입 연출 미리보기 ── RoF.dev.playVision('scene_3'|'fates_thread')
  dev.playVision = function(visionId, cardId){
    visionId = visionId || 'scene_3';
    if(!RoF.QuestUI || !RoF.QuestUI.playRewardVision){ console.warn('[dev] QuestUI.playRewardVision 없음'); return; }
    if(RoF.UI && RoF.UI.show && !document.querySelector('.game-root')){ /* game-root 없으면 skip */ }
    return RoF.QuestUI.playRewardVision(visionId, { cardId: cardId || (visionId === 'fates_thread' ? 'hero_wolf_alpha' : 'wolf') });
  };

  if(typeof document !== 'undefined'){
    if(document.readyState === 'loading'){
      document.addEventListener('DOMContentLoaded', dev.bootFromUrl);
    } else {
      setTimeout(dev.bootFromUrl, 100);
    }
    // 백틱(`) 키 — 입력 필드 포커스 중이 아닐 때만 토글
    document.addEventListener('keydown', (e) => {
      if(e.code !== 'Backquote' && e.key !== '`') return;
      const t = e.target;
      if(t && (t.tagName === 'INPUT' || t.tagName === 'TEXTAREA' || t.isContentEditable)) return;
      e.preventDefault();
      _toggleDebugPanel();
    });
  }

  console.log('[dev] RoF.dev helpers 로드: startTestMatch, dumpMatch, setupFireUpgrade, toggleDebugPanel(`키), addCardToHand, ...');
})(typeof window !== 'undefined' ? window : globalThis);
