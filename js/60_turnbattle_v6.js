'use strict';

// ─────────────────────────────────────────────────────────────
// PHASE 6 TCG 턴제 전투 엔진 (2026-05-05)
// 기획서: game/PHASE6_BATTLE_TCG.md
// 정본:   .claude/rules/04-balance.md (5필드), 03-terminology.md (kind 5종)
//
// 코어 책임:
//  - 매치 setup (덱 30장, 손패 5장, 영웅 보드 배치, 선/후공)
//  - 턴 흐름 (영혼 회복 → 1장 드로우 → 행동 → 턴 종료)
//  - 카드 사용 (kind 5종: unit/spell-target/spell-aoe/attach-hero/attach-unit)
//  - 공격 (단순 ATK 데미지, taunt 강제, 1턴 1유닛)
//  - 키워드 (battlecry / aura / deathrattle / taunt)
//  - 적 AI (가장 비싼 카드 우선, 공격은 taunt → 영웅)
//
// UI 시각화는 Phase D 에서 별도. 이 파일은 순수 상태 머신.
// 모든 외부 트리거는 `RoF.Match.api.*` 메서드 호출.
// ─────────────────────────────────────────────────────────────

(function(global){
  const RoF = global.RoF = global.RoF || {};

  // ───────── 시드 가능 RNG ─────────
  // 회귀(tools/test_run.js) 가 page.addInitScript 로 window.__ROF_SEED__ 주입 시 결정적 PRNG 사용.
  // 프로덕션은 Math.random 그대로 — flaky 0, 분포 영향 0.
  // 12~17번째 교훈 (회귀 setup random 데이터 손실) 의 근본 해결.
  const _rand = (function(){
    const seed = (typeof global.__ROF_SEED__ === 'number') ? (global.__ROF_SEED__ | 0) : null;
    if (seed === null) return Math.random;
    let s = seed || 1;  // 0 시드 회피
    return function mulberry32(){
      s |= 0; s = s + 0x6D2B79F5 | 0;
      let t = Math.imul(s ^ s >>> 15, 1 | s);
      t = t + Math.imul(t ^ t >>> 7, 61 | t) ^ t;
      return ((t ^ t >>> 14) >>> 0) / 4294967296;
    };
  })();
  RoF._rand = _rand;  // 다른 모듈 (61_match_ui 등) 도 공유

  // ───────── 상수 ─────────
  const DECK_SIZE        = 30;
  const HAND_START       = 5;
  const HAND_BONUS_2ND   = 0;       // 2026-05-16 사용자 결정 — 후공 +1 카드 룰 폐기 (양측 5장 시작)
  const HAND_MAX         = 10;  // 2026-05-13 사용자 결정 (7 → 10, 하스스톤/STS 표준)
  const BOARD_MAX        = 5;       // 2026-05-13 사용자 결정 (6 → 5, 보드 6칸 = 영웅 1 + 유닛 5)
  const TURN_TIME_MS     = 75 * 1000;
  /* diagnosis-confirmed: 2026-06-07 사유: feature — attach-self kind 신설 (스펠주인 부착, q_wolf_cull 시그니처). 버그 픽스 아님. */
  const VALID_KINDS      = ['unit','spell-target','spell-aoe','attach-hero','attach-unit','attach-self'];

  // ───────── 헬퍼 ─────────
  let _uidSeq = 0;
  function nextUid(prefix){ return (prefix||'i') + '_' + (++_uidSeq); }

  // 매치 내 영웅 progression 상수 (M&M Fates 차용)
  const HERO_XP_PER_LEVEL = 2;       // 2턴마다 1 레벨업 (턴 종료 시 +1 XP)
  // J (2026-05-25) — 영웅 매치 레벨 cap. 옛 unlimited → 5 (UNIT_MAX_LEVEL 과 정합, M&M Fates Lv 4 보다 약간 길게).
  // 출처: design/comparison_mm_fates_2026-05-24.md P0 #1 (M&M Lv cap 4) + 사용자 결정 Lv 5 (동료 cap 일관).
  const HERO_MAX_LEVEL = 5;
  const LEVELUP_BONUS = Object.freeze({
    atk:  {ATK:  2},
    soul: {SOUL: 1},
    hp:   {HP:   5},
  });

  // Plan 2.C Phase J+K (2026-05-12, design/battle_system_decisions.md:172):
  // 영웅 레벨업 등급별 차등 보상. SOUL +1 고정 (인플레이션 방지), ATK 만 차등.
  const HERO_LEVELUP_BY_RARITY = Object.freeze({
    bronze:    {ATK: 1, SOUL: 1},
    silver:    {ATK: 2, SOUL: 1},
    gold:      {ATK: 2, SOUL: 1},
    legendary: {ATK: 3, SOUL: 1},
    divine:    {ATK: 3, SOUL: 1},
  });

  // Plan 2.C Phase J+K (2026-05-12, design/battle_system_decisions.md:159):
  // 동료 unit 레벨업 등급별 차등 보상. ATK + HP 합 N, 랜덤 분배 (randInt(0, N), HP = N - ATK).
  const UNIT_LEVELUP_SUM_BY_RARITY = Object.freeze({
    bronze:    1,
    silver:    2,
    gold:      3,
    legendary: 4,
    divine:    5,
  });

  // 매치 내 유닛 progression (사용자 결정 2026-05-07 → 2026-05-12 등급별 차등으로 갱신)
  //  - bundle skill 사용 시 그 unit (card.bundledByUnit 일치하는 board unit) _matchExp +1
  //  - 보드 행동 시 공격자 _matchExp +1 (Phase I-3)
  //  - 2 EXP 도달 시 자동 레벨업 — ATK + HP 합 = 등급별 N 랜덤 분배, _matchExp -= 2, _matchLevel +1
  //  - max Lv 5 (cap 도달 후 EXP 누적 X)
  //  - 매치 종료 시 자동 리셋 (영웅과 동일 — 새 인스턴스)
  const UNIT_XP_PER_LEVEL = 2;
  const UNIT_MAX_LEVEL    = 5;
  // 2026-05-24 — UNIT_LEVELUP_BONUS_AMT (Phase J+K DEPRECATED) trash. UNIT_LEVELUP_SUM_BY_RARITY 가 정본, 사용처 0건 확인 후 폐기.

  // Plan 2.A — phase enum (UI 통합 cluster, 2026-05-11). 'card' | 'board' 리터럴 sweep.
  // value 는 string 그대로 — 옛 회귀(`st.phase === 'card'`) 와 직접 비교 호환.
  // 외부 노출: Match.PHASE (= 같은 freeze 객체). 새 phase 추가 시 여기 + _phaseHandlers 한 곳만 갱신.
  const PHASE = Object.freeze({ CARD: 'card', BOARD: 'board' });

  // 2026-05-29 B 진행 (HS step machine 7단계) — Phase 1: STEP enum 도입.
  //   옛 PHASE.CARD/BOARD 2-step + endTurn flip + cursor + events 큐 4개 state model 중첩 →
  //   7-step 단일 state 로 정합. 18·19번째 deadlock 교훈 코드 구조 자동 강제.
  //
  //   step 진입/종료 hook 으로 cleanup / 입력 차단 / 글로우 분기 통일.
  //   PHASE alias 유지 (옛 회귀 36건 + 코드 호환층 — 7번째 교훈 정합).
  //
  //   단계 의미:
  //     ROUND_BEGIN  — 라운드 시작 (영혼 충전 / 손패 draw / banner)
  //     CARD_DRAW    — 사용자 카드 draw 단계 (현재는 ROUND_BEGIN 안 포함)
  //     CARD_PLAY    — 사용자 카드 사용 (= 옛 PHASE.CARD)
  //     CARD_END     — 카드 페이즈 종료 (양측 endCardPhase 후)
  //     BOARD_BEGIN  — 보드 페이즈 진입 (queue 생성 / exhausted reset)
  //     BOARD_ACTION — 사용자 보드 행동 (= 옛 PHASE.BOARD, cursor 진행)
  //     ROUND_END    — 라운드 종료 (cleanup / discard / 다음 round 진입)
  const STEP = Object.freeze({
    ROUND_BEGIN:  'round_begin',
    CARD_DRAW:    'card_draw',
    CARD_PLAY:    'card_play',
    CARD_END:     'card_end',
    BOARD_BEGIN:  'board_begin',
    BOARD_ACTION: 'board_action',
    ROUND_END:    'round_end',
  });

  // PHASE ↔ STEP alias (옛 회귀 호환). state.phase 와 state.step 양립 운영.
  //   phaseToStep: 옛 phase 검사 → 새 step 매핑 (CARD → CARD_PLAY, BOARD → BOARD_ACTION).
  //   stepToPhase: 새 step → 옛 phase 환원 (CARD_PLAY/CARD_DRAW/CARD_END → 'card', 나머지 → 'board').
  function phaseToStep(phase){
    return phase === PHASE.BOARD ? STEP.BOARD_ACTION : STEP.CARD_PLAY;
  }
  function stepToPhase(step){
    // 2026-05-29 B Phase 1 fix — ROUND_BEGIN 도 PHASE.CARD 매핑 (카드 페이즈 진입 직전).
    if(step === STEP.ROUND_BEGIN || step === STEP.CARD_DRAW || step === STEP.CARD_PLAY || step === STEP.CARD_END) return PHASE.CARD;
    if(step === STEP.BOARD_BEGIN || step === STEP.BOARD_ACTION || step === STEP.ROUND_END) return PHASE.BOARD;
    return PHASE.CARD;  // fallback
  }

  /* diagnosis-confirmed: 2026-06-08 사유: feature — 카드 영구 XP 기여포인트+순위 보상 시스템 신규 (사용자 결정). 버그 픽스 아님. */
  // ───────── 카드 영구 XP — 기여포인트 + 순위 보상 (2026-06-08 사용자 결정) ─────────
  // 매치/퀘스트 종료 시 출전 카드(_permanentUid)에 기여 순위별 영구 XP 부여 → 레벨업 시 해금 연출.
  // 정본: .claude/rules/04-balance.md §카드 영구 XP. 기여 가중치 / 순위 배율 / base XP.
  const CONTRIB = { dmg: 1.0, tank: 0.5, kill: 5, heal: 0.7 };
  // 순위 배율: [0]=1위, [1]=2위, [2]=3위 이하(전원). winBase=승리, loseBase=패배/무승부.
  const CARD_XP = { winBase: 60, loseBase: 20, rank: [1.0, 0.6, 0.35] };
  function _addContrib(inst, amt){
    if(inst && amt > 0) inst._contrib = (inst._contrib || 0) + amt;
  }

  // 카드 데이터 → 매치 인스턴스 (얕은 카피 + 전투 상태)
  function instantiate(card){
    if(!card) return null;
    const inst = {
      ...card,
      uid:        nextUid(card.kind === 'hero' ? 'h' : 'c'),
      // v1.1 mastery (2026-05-25) — 영구 uid alias 보존. Game.deck 영구 카드는 card.uid 가 영구 uid.
      // 매치 inst.uid 는 매치 전용 새 uid (위 nextUid). 매치 종료 시 _permanentUid 기준으로 영구 저장 commit.
      // card.uid 없으면 (template 직접 instantiate) null — 매치 종료 commit 시 skip.
      _permanentUid: card.uid || null,
      _contrib:   0,   // 매치 기여포인트 (딜+탱+처치+힐 가중) — 종료 시 순위별 영구 XP 환산
      curHP:      card.HP,
      maxHP:      card.HP,
      curATK:     card.ATK,
      baseATK:    card.ATK,
      attachments: [],            // attach-unit / attach-hero 누적
      exhausted:  card.kind === 'unit',  // 소환 멀미 (영웅·스펠은 false)
      attackedThisTurn: false,
      isDead:     false,
      // DEF (보호막) 시스템 — default 0, attach-unit/shield op 으로 부여받음. 만료 시 회수.
      /* diagnosis-confirmed: 2026-06-11 사유: feature — 유닛 기본 DEF(card.DEF) 매핑. 현재 DEF 보유 유닛 0개라 무영향, 미래 대비. ⚠️ 흡수형(_damage 소모) 동작 — unit_data_guide '강인=감산' 메커니즘은 유닛 DEF 카드 추가 시 _baseDef 로 별도 결정. */
      _def:        card.DEF || 0,
      _defTurns:   0,
      _reflect:    0,
      _reflectTurns: 0,
      /* diagnosis-confirmed: 2026-06-06 사유: feature — 반사 화상(reflect_burn) 런타임 필드. 근접 공격자에게 burn DOT 부여 (화염방패). */
      _reflectBurn:  0,
      _reflectBurnTurns: 0,
      /* diagnosis-confirmed: 2026-06-07 사유: feature — evade_once(민첩함) 1회 공격 회피 런타임 필드. 버그 픽스 아님. */
      _evadeOnce:    0,
      // 키워드 만료 시 base 와 diff 하기 위해 원본 보존
      _baseKeywords: Array.isArray(card.keywords) ? [...card.keywords] : [],
    };
    // 영웅 전용 — 매치 내 progression (시즌 레벨업과 분리, 매치 종료 시 사라짐)
    if(card.kind === 'hero'){
      inst.matchXP        = 0;
      inst.matchLevel     = 1;
      inst.matchXPNext    = HERO_XP_PER_LEVEL;
      inst.pendingLevelUp = false;
    }
    // 일반 유닛 — 매치 내 progression (bundle skill 사용 시 EXP 누적, 2 도달 시 ATK/HP 랜덤 +1)
    if(card.kind === 'unit'){
      inst._matchExp      = 0;
      inst._matchLevel    = 1;
      inst._matchXpNext   = UNIT_XP_PER_LEVEL;
      inst._matchMaxLevel = UNIT_MAX_LEVEL;
    }
    /* diagnosis-confirmed: 2026-06-07 사유: feature — 카드 lifecycle 키워드 매핑. retain → _persistent 하위호환(exhaust 와 모순 시 exhaust 우선). soulSiphon → _soulSiphon 런타임 필드 (메커니즘 7). battle_system_decisions.md 2026-06-07. */
    if(Array.isArray(card.keywords)){
      const kw = card.keywords;
      if(kw.indexOf('retain') >= 0 && kw.indexOf('exhaust') < 0){ inst._persistent = true; }
    }
    if(card.soulSiphon){ inst._soulSiphon = card.soulSiphon; }
    /* instantiate 노출은 Match 정의 이후로 이동 (여기선 Match TDZ) */
    return inst;
  }

  // 보드의 같은 id unit 들에 매치 내 EXP +1. Lv 5 cap 도달 시 누적 X.
  // 2 EXP 모이면 자동 ATK or HP +1 랜덤. _matchExp = 0 reset, _matchLevel +1.
  // Plan 2.C Phase J+K (2026-05-12, design/battle_system_decisions.md:151-186):
  // 영웅 XP 도달 시 자동 레벨업 (모달 폐기) + 등급별 차등 보상.
  function _autoHeroLevelUpCheck(side, hero){
    if(!hero || hero.isDead) return;
    // J (2026-05-25) — Lv 5 cap. cap 도달 시 XP 더 누적되어도 levelup 무시 (XP 는 잔존 — 다음 매치는 새 inst 라 reset).
    while((hero.matchXP || 0) >= (hero.matchXPNext || HERO_XP_PER_LEVEL)
          && (hero.matchLevel || 1) < HERO_MAX_LEVEL){
      const rarity = hero.rarity || 'bronze';
      const bonus = HERO_LEVELUP_BY_RARITY[rarity] || HERO_LEVELUP_BY_RARITY.bronze;
      hero.matchXP -= (hero.matchXPNext || HERO_XP_PER_LEVEL);
      hero.matchLevel = (hero.matchLevel || 1) + 1;
      // P0-14 / P0-8 fix (2026-05-16): hero.baseATK 갱신 안 함 → curATK > baseATK 차이로 is-buffed (노란색) 트리거.
      // 옛 코드: ATK + baseATK + curATK 모두 동시 +bonus → 비교 동일 → 색 변화 없음.
      // 신 룰: curATK 만 +bonus. baseATK 는 인스턴스 시작 시점 값 보존 → UI 색 변화 가능.
      hero.curATK = (hero.curATK || 0) + bonus.ATK;
      // SOUL 가산 (영웅 SOUL 직접 +1 → 매 라운드 영혼력 충전도 +1)
      hero.SOUL = (hero.SOUL || 0) + bonus.SOUL;
      const sideKey = (Match.state && Match.state.player === side) ? 'player' : 'enemy';
      logEvent('hero-levelup', {side: sideKey, level: hero.matchLevel, rarity, atk: bonus.ATK, soul: bonus.SOUL});
      // 2026-05-16 — UI popup 트리거 (events 큐 push)
      // 2026-05-28 cascade C1 — soulBonus + rarity 메타 보강 (영웅 보상 토스트 "공격력 +N / 영혼력 +N" 한 줄씩 표시용)
      if(Match.state && Array.isArray(Match.state.events)){
        Match.state.events.push({type: 'hero-levelup', side: sideKey, uid: hero.uid, level: hero.matchLevel, rarity, atkBonus: bonus.ATK, soulBonus: bonus.SOUL});
      }
    }
  }

  // Plan 2.C Phase J+K (2026-05-12): 동료 unit XP 도달 시 자동 레벨업 + 등급별 합 N 랜덤 분배.
  function _autoUnitLevelUpCheck(unit){
    if(!unit || unit.isDead) return;
    while((unit._matchExp || 0) >= (unit._matchXpNext || UNIT_XP_PER_LEVEL)
          && (unit._matchLevel || 1) < (unit._matchMaxLevel || UNIT_MAX_LEVEL)){
      unit._matchExp -= (unit._matchXpNext || UNIT_XP_PER_LEVEL);
      unit._matchLevel = (unit._matchLevel || 1) + 1;
      const rarity = unit.rarity || 'bronze';
      const sumN = UNIT_LEVELUP_SUM_BY_RARITY[rarity] || 1;
      // ATK + HP 합 N. ATK = randInt(0, N), HP = N - ATK.
      const atkBonus = Math.floor(_rand() * (sumN + 1));
      const hpBonus = sumN - atkBonus;
      // P0-14 / P0-8 fix (2026-05-16): baseATK 갱신 안 함 (UI 노란색 트리거).
      if(atkBonus > 0){
        unit.curATK = (unit.curATK || 0) + atkBonus;
      }
      if(hpBonus > 0){
        unit.maxHP = (unit.maxHP || unit.HP || 0) + hpBonus;
        unit.curHP = (unit.curHP || 0) + hpBonus;
      }
      logEvent('unit-levelup', {uid: unit.uid, id: unit.id, level: unit._matchLevel, rarity, sumN, atk: atkBonus, hp: hpBonus});
      // 2026-05-16 — UI popup 트리거 (events 큐 push)
      if(Match.state && Array.isArray(Match.state.events)){
        Match.state.events.push({type: 'unit-levelup', uid: unit.uid, level: unit._matchLevel, atkBonus, hpBonus});
      }
    }
  }

  function _grantUnitExp(side, unitId){
    if(!side || !unitId) return;

    // Plan 2.C Phase I-2/J+K (2026-05-12, design/battle_system_decisions.md:147):
    // 영웅 시그 사용 시 영웅 XP +1 + 자동 레벨업.
    if(side.hero && side.hero.id === unitId && !side.hero.isDead){
      const hero = side.hero;
      hero.matchXP = (hero.matchXP || 0) + 1;
      const sideKey = (Match.state && Match.state.player === side) ? 'player' : 'enemy';
      logEvent('hero-xp-gain', {side: sideKey, source: 'signature-use', xp: hero.matchXP});
      _autoHeroLevelUpCheck(side, hero);
      return;
    }

    const matched = (side.board || []).filter(u => u && !u.isDead && u.id === unitId && u.kind === 'unit');
    matched.forEach(u => {
      if((u._matchLevel || 1) >= (u._matchMaxLevel || UNIT_MAX_LEVEL)) return;  // cap
      u._matchExp = (u._matchExp || 0) + 1;
      logEvent('unit-exp', {uid: u.uid, id: u.id, exp: u._matchExp, level: u._matchLevel, source: 'signature-use'});
      _autoUnitLevelUpCheck(u);
    });
  }

  // Plan 2.C Phase I-3/J+K (2026-05-12 attack 트리거) → K (2026-05-25) cursor 진행 단일 트리거로 통합.
  // 사용자 의도: "보드유닛/영웅 행동 끝난 후 (공격이든 턴 종료든) XP +1" — cursor 차례 종료 시점.
  // 호출 위치: _advanceBoardTurn 안 cursor 이동 직전 (방금 차례 끝낸 unit 대상).
  // 옛 호출 위치 (Match.attack 안 2곳) 제거 — attack 과 skip 둘 다 동일 진입점.
  function _grantBoardCursorExp(side, unit){
    if(!side || !unit || unit.isDead) return;
    // 2026-05-17 B3 fix — 영웅 판별 강화 (_isHero fallback).
    // 사용자 보고 "보드영웅이 보드유닛공격시 양쪽 영웅 경험치 안 참".
    // createHero 는 kind:'hero' + _isHero:true 모두 부여 (11_data_heroes.js:165,176).
    // 단 어떤 경로로 _isHero 만 살아남는 경우 대비 fallback.
    const isHero = unit.kind === 'hero' || unit._isHero === true;
    if(isHero){
      unit.matchXP = (unit.matchXP || 0) + 1;
      const sideKey = (Match.state && Match.state.player === side) ? 'player' : 'enemy';
      logEvent('hero-xp-gain', {side: sideKey, source: 'board-action', xp: unit.matchXP});
      _autoHeroLevelUpCheck(side, unit);
      return;
    }
    // 동료 unit
    if((unit._matchLevel || 1) >= UNIT_MAX_LEVEL) return;
    unit._matchExp = (unit._matchExp || 0) + 1;
    logEvent('unit-exp', {uid: unit.uid, id: unit.id, exp: unit._matchExp, level: unit._matchLevel, source: 'board-action'});
    _autoUnitLevelUpCheck(unit);
  }

  // 덱 생성 — Fisher-Yates 셔플
  function shuffle(arr){
    const a = arr.slice();
    for(let i=a.length-1; i>0; i--){
      const j = Math.floor(_rand() * (i+1));
      [a[i], a[j]] = [a[j], a[i]];
    }
    return a;
  }

  // 영혼 회복 = 영웅.SOUL 만 (2026-05-06 단순화 — 보드/손패 SOUL 합산 폐기)
  // 영웅 SOUL 은 base 5 고정. 매치 레벨업 시 사용자가 'soul' 선택하면 +1.
  function calcSoulIncome(side){
    return (side.hero && side.hero.SOUL) || 0;
  }

  // taunt 활성 보드
  function tauntsOf(side){
    return side.board.filter(u => !u.isDead && (u.keywords || []).includes('taunt'));
  }

  /* diagnosis-confirmed: 2026-06-12 bug-fix — pierce:'taunt' 헬퍼 중복정의 제거 (Match TDZ: 정의(426) 전 참조 → 모듈 throw → M.start 미정의. 정의는 426 이후로 이동). */
  // ───── Phase 1A.2 헬퍼 — 카드 분류 + 부서짐 (2026-05-07) ─────
  // 사용자 결정: ability 텍스트 기반 판정. "각인" = 1회용 스펠, "동료" = 1회용 유닛.
  // 마킹 안 된 카드는 default = 재사용 스펠 / 일반 유닛.
  function _isReusable(card){
    if(!card || !card.ability) return false;
    if(card.kind !== 'spell-target' && card.kind !== 'spell-aoe') return false;
    return !/각인/.test(card.ability);
  }
  function _isCompanion(card){
    if(!card) return false;
    if(card.kind !== 'unit') return false;
    if(card._isSummoned) return false;
    return true;
  }
  // 2026-05-09 — 시그니처 스펠 카드 (bundledSkillIds) 없는 unit 은 자동 lock.
  // 매치 시작 / 덱 빌딩 / canPlay 모두에서 거부. bundled 1장 이상 추가되면 자동 unlock.
  // escape hatch: card._unlock === true 면 강제 unlock (단순 mob 등 의도적 bundled 0 카드용).
  function _isLockedUnit(card){
    if(!card) return false;
    if(card.kind !== 'unit') return false;
    if(card._unlock === true) return false;
    if(card._isSummoned) return false;
    const ids = card.bundledSkillIds;
    return !Array.isArray(ids) || ids.length === 0;
  }
  // bundledByUnit 매칭 카드 uid 수집 (손패 / 덱 분리 반환)
  function _collectBundledCards(side, unitId){
    if(!side || !unitId) return {hand: [], deck: []};
    const handMatched = (side.hand || []).filter(c => c && c.bundledByUnit === unitId).map(c => c.uid);
    const deckMatched = (side.deck || []).filter(c => c && c.bundledByUnit === unitId).map(c => c.uid);
    return {hand: handMatched, deck: deckMatched};
  }
  // hand/deck 에서 uid 매칭 카드 제거. _disintegrated 배열에 보존 (PHASE 7 부활용).
  function _disintegrateCards(side, uids){
    if(!side || !Array.isArray(uids) || !uids.length) return [];
    const removed = [];
    // Plan 2.B Phase F (2026-05-12): 사망 동료 시그 → dormantPile 재봉인 (정본 룰).
    // 검색 범위: hand / deck / discardPile (어디 있든). dormantPile 에는 이미 있을 수도 — 잔존.
    uids.forEach(uid => {
      const piles = ['hand', 'deck', 'discardPile'];
      for(const p of piles){
        const idx = (side[p] || []).findIndex(c => c && c.uid === uid);
        if(idx >= 0){ removed.push(side[p].splice(idx, 1)[0]); return; }
      }
    });
    // dormantPile 재봉인 (5-pile 정본). _disintegrated 도 PHASE 7 부활 source 보존.
    side.dormantPile = side.dormantPile || [];
    side.dormantPile.push(...removed);
    side._disintegrated = side._disintegrated || [];
    /* diagnosis-confirmed: 2026-06-07 사유: refactor — 옛 코드는 dormantPile 과 _disintegrated 가 같은 객체 참조 공유. mastery commit(_commitMasteryToProfile)은 seen Set 으로 _permanentUid 중복을 이미 막아 실제 중복 카운트는 없었음. 단 PHASE 7 부활 source(_disintegrated)가 동료 재등장 시 dormantPile filter/mutation 에 끌려가는 오염 위험 예방 — deep-clone 스냅샷으로 참조 분리. */
    side._disintegrated.push(...removed.map(c => { try { return JSON.parse(JSON.stringify(c)); } catch(e){ return c; } }));
    return removed;
  }

  // Phase 1A.5 — 유닛/영웅 uid 로 owner side 찾기 (companion death 시 어느 진영의 카드 흩어질지)
  function _findOwnerSide(uid){
    const st = Match.state;
    if(!st || !uid) return null;
    if(st.player && st.player.hero && st.player.hero.uid === uid) return 'player';
    if(st.enemy  && st.enemy.hero  && st.enemy.hero.uid  === uid) return 'enemy';
    if(((st.player && st.player.board) || []).some(u => u && u.uid === uid)) return 'player';
    if(((st.enemy  && st.enemy.board)  || []).some(u => u && u.uid === uid)) return 'enemy';
    return null;
  }

  // 카드 사용 가능 여부 (phase + SOUL + 보드 한도). _nextDiscount 매칭 시 cost 차감 후 비교.
  // 2026-05-16 C 하이브리드 정본 — 보드 페이즈에선 unit 카드 X (스펠/부착만 가능)
  function canPlay(side, card){
    if(!card) return {ok:false, reason:'카드 없음'};
    if(_isLockedUnit(card)) return {ok:false, reason:'시그니처 스펠 미정의'};
    const phase = (Match.state && Match.state.phase) || PHASE.CARD;
    if(phase === PHASE.BOARD && card.kind === 'unit'){
      return {ok:false, reason:'보드 페이즈에선 유닛 카드 사용 불가'};
    }
    let cost = card.NEED_SOUL|0;
    if(side._nextDiscount && _nextCardFilterMatch(side._nextDiscount.filter, card)){
      cost = Math.max(0, cost - (side._nextDiscount.amount|0));
    }
    if((side.soulPool|0) < cost) return {ok:false, reason:'영혼 부족'};
    if(card.kind === 'unit' && side.board.length >= BOARD_MAX){
      return {ok:false, reason:'보드 가득'};
    }
    return {ok:true};
  }

  // ───────── Match (네임스페이스) ─────────
  const Match = RoF.Match = {};

  /* diagnosis-confirmed: 2026-06-12 사유: bug-fix — pierce:'taunt' silent-fail. repro:sk_flame_arrow(ranged, ability "수호자 무시")가 taunt 강제 게이트(dmgType만 검사)에 걸려 후열/영웅 저격 불가. hypo배제:MOOT(스펠 자유타겟) 기각=ranged/melee 스펠 taunt 강제됨/WIRED 기각=pierce==='taunt' 리더 0건. demo:match-pierce-taunt-v6. */
  // pierce:'taunt' — 카드 effects 에 taunt 관통이 있으면 magic 처럼 taunt 강제 우회 (수호자 무시 키워드).
  //   엔진 taunt 우회는 본래 dmgType==='magic' 로만 결정 → ranged/melee 스펠의 pierce:'taunt' 는 리더 부재로 silent-fail 이었음.
  //   pierce:'shield'(DEF 우회, 2051)와 짝 형제 키워드. 3 타게팅 게이트(_isValidDropOnUnit/_isValidDropOnHero/_chooseTarget)에서 공통 사용.
  Match._cardPiercesTaunt = function(card){
    return !!(card && Array.isArray(card.effects) && card.effects.some(e => e && e.pierce === 'taunt'));
  };

  /* diagnosis-confirmed: 2026-06-13 사유: feature — 종족·원소 시너지 R1 (race_synergy_2026-05-30.md, 옵션2 + solo 예외). N=보드 UNIT 카운트(영웅 제외 — "보드 1마리=0" 보장). 일반 종족 N=1→0/N=2→+1(보편 인플레 방지), solo 종족(천사·악마·거인·용 — 카드 1~2장뿐 2모으기 불가) N=1→+1. _synergyBuff delta 멱등 오버레이(옛 race_bond 1회계산 한계 해소). HEAL/SOUL/DRAW + 3/5 extras + 6단계 특수 = R2. */
  // 동시발동 옵션B: 종족 full(solo=tierSolo) + 원소 절반(ceil, 항상 일반). unit→TIER/STIER, hero→HTIER(영웅 column).
  //   ⚠️ R1 한계: DEF 는 흡수형(_damage 소모)이라 보드변동 재계산이 소모분과 느슨하게 상호작용 (clamp 로 음수 방지). HP 는 증가분만 heal.
  Match._recomputeSynergy = function(side){
    if(!side) return;
    const SYN = (typeof RoF !== 'undefined' && RoF.Data && RoF.Data.SYNERGY);
    if(!SYN) return;
    const TIER = SYN.tier, HTIER = SYN.heroTier, STIER = SYN.tierSolo || SYN.tier;
    const OVERLAY = { ATK: 1, DEF: 1, HP: 1 };  // R1 = persistent stat 3종만 (HEAL/SOUL/DRAW = R2 per-turn)
    /* diagnosis-confirmed: 2026-06-13 사유: refactor — 카운트 로직을 _countSynergy 단일 출처로 추출 (R2 per-turn 공용, 중복 제거). 동작 불변 (match-synergy-r1-v6 회귀 검증). */
    // 종족/원소 카운트 = 보드 UNIT 만 (영웅 제외 — heroTier 로 별도 수혜, 카운트 인플레/인간편향 방지)
    const { hero, units, raceCount, elemCount } = Match._countSynergy(side);
    const idx = n => Math.min(Math.max(n | 0, 0), TIER.length - 1);  /* diagnosis-confirmed: 2026-06-13 refactor — clamp 상한 하드코딩 6 → tier 배열 길이 파생 (확장성 리뷰: tier 길이 변경 시 silent clamp 버그 방지) */
    /* diagnosis-confirmed: 2026-06-13 사유: feature — Cluster 3a 원소 지속 extras (race_synergy §4 tier3/tier5 persistent). earth def_all_1(>=3 모든아군 DEF+1)/def_hero_2(>=5 영웅 +2)는 _synergyBuff.DEF 오버레이 합산(델타 자동조정, count 하락 시 회수). 데이터 기반(tier 코드 매핑). 카운트 R1 일관 영웅 제외(유닛만). */
    let teamDef = 0, heroExtraDef = 0;
    Object.keys(SYN.element).forEach(el => {
      const c = elemCount[el] || 0;
      const e = SYN.element[el];
      if(c >= 3 && e.tier3 === 'def_all_1')  teamDef += 1;       // 모든 아군 DEF +1
      if(c >= 5 && e.tier5 === 'def_hero_2') heroExtraDef += 2;  // 영웅 DEF +2 추가
    });
    const applyBuff = (u, isHero) => {
      const baseTier = isHero ? HTIER : TIER;
      const nb = { ATK: 0, DEF: 0, HP: 0 };
      const rdef = u.race && SYN.race[u.race];
      if(rdef && OVERLAY[rdef.stat]){
        // solo 종족(천사·악마·거인·용)은 1마리부터 버프. 단 영웅(시즌1 항상 human)은 일반 HTIER.
        const rtier = (!isHero && rdef.solo) ? STIER : baseTier;
        nb[rdef.stat] += (rtier[idx(raceCount[u.race] || 0)] || 0);
      }
      const edef = u.element && SYN.element[u.element];
      if(edef && OVERLAY[edef.stat]){
        // 원소는 카드 많아 항상 일반 tier (solo 없음).
        nb[edef.stat] += Math.ceil((baseTier[idx(elemCount[u.element] || 0)] || 0) / 2);
      }
      // Cluster 3a: 원소 지속 DEF extras (def_all 모든아군 + def_hero 영웅) — 오버레이 합산 → 델타 자동 회수
      nb.DEF += teamDef + (isHero ? heroExtraDef : 0);
      const prev = u._synergyBuff || { ATK: 0, DEF: 0, HP: 0 };
      const dATK = nb.ATK - (prev.ATK || 0);
      const dDEF = nb.DEF - (prev.DEF || 0);
      const dHP  = nb.HP  - (prev.HP  || 0);
      if(dATK) u.curATK = (u.curATK || 0) + dATK;          // baseATK 미변경 (오버레이 = 제거 가능)
      if(dDEF) u._def   = Math.max(0, (u._def || 0) + dDEF);
      if(dHP){
        u.maxHP = Math.max(1, (u.maxHP || u.HP || 1) + dHP);
        if(dHP > 0) u.curHP = (u.curHP || 0) + dHP;        // 증가분만 heal
        else u.curHP = Math.min(u.curHP || 0, u.maxHP);    // 감소 시 cap clamp (사망 방지)
      }
      u._synergyBuff = nb;
    };
    units.forEach(u => applyBuff(u, false));
    if(hero) applyBuff(hero, true);
    /* diagnosis-confirmed: 2026-06-13 사유: feature — Cluster 3a holy revive_hero / dark lifesteal 지속 flag (data-driven tier5 코드). _damage 가 flag 읽어 처리(부활/흡혈). count 하락 시 0 으로 자동 lapse. */
    Object.keys(SYN.element).forEach(el => {
      const c = elemCount[el] || 0;
      const e = SYN.element[el];
      if(e.tier5 === 'revive_hero' && hero){
        // 죽음 시 1회 부활 (>=5 지속, 소비하면 _synReviveUsed 로 재-grant 차단)
        hero._synReviveOnce = (c >= 5 && !hero._synReviveUsed) ? 1 : 0;
      }
      if(e.tier5 === 'lifesteal'){
        // 해당 원소 유닛 흡혈 flag (피해 시 자기 영웅 +1 HEAL — _damage 가 처리)
        const on = (c >= 5);
        units.forEach(u => { if(u.element === el) u._synLifesteal = on ? 1 : 0; });
      }
    });
  };

  Match.state = null;
  Match.log   = [];
  // 2026-05-16 — UI 가 손패 렌더 시 사용 가능 여부 평가용 (phase + SOUL + 보드 + kind 검사 통합)
  Match.canPlay = canPlay;

  // 2026-05-29 P0 #4 — 영혼력 충전 hook (StS2 PostEnergyRecharge 패턴 정합).
  //   _beginRound 가 firstSide 충전 시 호출. 향후 aura / relic effect 가산 진입점.
  //   - refund (전 라운드 누적, effect 'refund' 가 push) → 새 base 위에 가산 후 reset
  //   - base = hero.SOUL (모든 영웅 5 — 04-balance)
  //   - soul-recharge event push (player 시 visual floater)
  Match._onSoulRecharge = function(side, sideKey, roundN){
    if(!side || !side.hero) return;
    const base = (side.hero.SOUL | 0) || 0;
    const refund = (side._refund | 0) || 0;
    /* diagnosis-confirmed: 2026-06-07 사유: feature — 메커니즘 Overload(영혼 과부하). _overload 만큼 다음 라운드 영혼 회복 차감(1회 소비). battle_system_decisions.md 2026-06-07 B-1. */
    const overload = (side._overload | 0) || 0;
    side.soulPool = Math.max(0, base + refund - overload);
    side._refund = 0;  // 1회성 — 다음 라운드는 새 refund 누적
    side._overload = 0;  // 1회 소비 (과부하 해소)
    logEvent('soul-recharge', {side: sideKey, pool: side.soulPool, round: roundN, base, refund});
    // §영혼력 visual feedback 룰 — player 만 floater (enemy 는 AI.takeTurn 진입 시 push)
    const st = Match.state;
    if(side.soulPool > 0 && sideKey === 'player' && st && Array.isArray(st.events)){
      st.events.push({type: 'soul-recharge-flash', side: sideKey, amount: side.soulPool});
    }
  };

  /* diagnosis-confirmed: 2026-06-13 사유: bug-fix — "매 턴 시작" 처리(_tickStatusEffects 화상/지속회복/기절, _tickTimedAttachments 보호막·반사·임시키워드 만료, _modifiers 만료)가 라이브에서 0회 발동(선재 P0). 근본 원인: 라운드 리팩터 때 _beginTurn 이 회귀-호환 alias 로 강등됐는데 이 처리들이 신 플로우(_beginRound→endCardPhase)에 재배선 안 됨. 회귀(match-status-v6 등)는 _tickStatusEffects 직접 호출이라 green 이었음 (회귀=코어만 검증 갭). probe 실증: burn 라이브 0틱 / 직접호출 정상. 사용자 결정 옵션1(통합 turn-begin hook + R2 같이). race_synergy R2 per-turn hook 도 여기로 통합. */
  // _onTurnBegin — "각 진영 턴 시작" 단일 진입점. _onSoulRecharge 호출하던 두 지점
  //   (_beginRound 의 firstSide / endCardPhase 의 secondSide = 라이브가 반드시 거치는 turn-begin)을 이걸로 교체.
  //   round 당 side 1회 보장(_turnBeginRound 가드 — 이중 호출 시 만료 2배·중복 tick 차단). 영혼 충전은 항상(set 이라 멱등).
  Match._onTurnBegin = function(side, sideKey, roundN){
    if(!side) return;
    // 1) 영혼 충전 (기존 _onSoulRecharge — 항상 수행: soulPool = set 연산이라 멱등)
    Match._onSoulRecharge(side, sideKey, roundN);
    // 2) round 당 side 1회 가드 — 만료/tick 류는 정확히 1회만 (이중 호출 방어)
    if(side._turnBeginRound === roundN) return;
    side._turnBeginRound = roundN;
    // 3) 시간제 부착 만료 (DEF 보호막 / reflect / 임시 키워드 _remainingTurns -=1)
    if(typeof Match._tickTimedAttachments === 'function') Match._tickTimedAttachments(side);
    // 4) 상태 효과 (화상 DOT / 지속회복 tick_heal / 기절 해제 / marker 만료)
    if(typeof Match._tickStatusEffects === 'function') Match._tickStatusEffects(side);
    // 5) 진영 전역 modifier 만료 (heal 등 turnsLeft -=1, 0 도달 시 제거) — 옛 _beginTurn(765-772) 이전
    if(Array.isArray(side._modifiers) && side._modifiers.length){
      side._modifiers.forEach(m => { if(m && typeof m.turnsLeft === 'number') m.turnsLeft -= 1; });
      const before = side._modifiers.length;
      side._modifiers = side._modifiers.filter(m => m && (typeof m.turnsLeft !== 'number' || m.turnsLeft > 0));
      if(side._modifiers.length < before){
        logEvent('modifier-expire', {side: sideKey, removed: before - side._modifiers.length});
      }
    }
    // 6) R2 종족·원소 시너지 per-turn 효과 (HEAL/SOUL/DRAW + 원소 3/5 extras).
    if(typeof Match._applySynergyPerTurn === 'function') Match._applySynergyPerTurn(side, sideKey, roundN);
    /* diagnosis-confirmed: 2026-06-13 사유: feature — 6단계 특수 dispatcher 배선 (정의+호출 한 cluster, garbage-lessons 호출자/정의 동시). count 영웅포함 >=6 매치 1회. */
    // 6.5) R2 6단계 특수 (count 영웅포함 >=6, 매치 1회). per-turn 직후(보드 count 확정) 체크.
    if(typeof Match._applySynergySpecial === 'function') Match._applySynergySpecial(side, sideKey);
    // 7) 보드 변동(화상 사망 등) 반영 — 시너지 멱등 재계산 (양측)
    if(typeof Match._recomputeSynergy === 'function' && Match.state){
      Match._recomputeSynergy(Match.state.player);
      Match._recomputeSynergy(Match.state.enemy);
    }
    /* diagnosis-confirmed: 2026-06-13 사유: bug-fix — turn-begin status tick(burn/dmg DOT)이 영웅을 죽일 수 있는데 _damage 는 _checkWinner 를 호출 안 함(호출자 책임). 옛 _beginTurn 경로엔 winner 체크 없었으나 그땐 라이브 미발동이라 무해. 이제 라이브 발동되므로 '죽은 영웅이 턴 진행' 방지 위해 명시 호출. (correctness-verifier blocker #1). */
    if(typeof Match._checkWinner === 'function') Match._checkWinner();
  };

  /* diagnosis-confirmed: 2026-06-13 사유: refactor — 보드 race/element 카운트 단일 출처 (R1 _recomputeSynergy + R2 _applySynergyPerTurn 공용). 중복 제거 + 카운트 룰 한 곳. */
  // _countSynergy — 보드 UNIT 만 카운트 (영웅 제외, heroTier 별도). {units, hero, raceCount, elemCount}.
  Match._countSynergy = function(side){
    const units = ((side && side.board) || []).filter(u => u && !u.isDead);
    const raceCount = {}, elemCount = {};
    units.forEach(u => {
      if(u.race)    raceCount[u.race]    = (raceCount[u.race]    || 0) + 1;
      if(u.element) elemCount[u.element] = (elemCount[u.element] || 0) + 1;
    });
    const hero = (side && side.hero && !side.hero.isDead) ? side.hero : null;
    return { units, hero, raceCount, elemCount };
  };

  /* diagnosis-confirmed: 2026-06-13 사유: refactor — 시너지 효과 프리미티브 공유 toolkit (R2 per-turn + 6단계 특수 + 지속형 공용). 중복 제거(확장성 리뷰) + 기존 엔진 메커니즘 재사용(burn/heal/_damage/_drawCards/_evadeOnce/_refund/shield marker). def 는 _tickTimedAttachments 가 reap 하는 _shieldMarker attachments 패턴(04-balance DEF 2경로) 정확 복제. */
  // _synergyFx(side, sideKey) → {foeTargets, allyTargets, pickRand, burn, heal, fullHeal, stun, dmg, def, evade, draw, soul, refund, pushEv}
  Match._synergyFx = function(side, sideKey){
    const st = Match.state;
    const foe = st && st[sideKey === 'player' ? 'enemy' : 'player'];
    const pushEv = ev => { if(st && Array.isArray(st.events)) st.events.push(ev); };
    const live = arr => (arr || []).filter(t => t && !t.isDead);
    return {
      st, foe, pushEv,
      foeTargets:  () => foe ? live([foe.hero, ...(foe.board || [])]) : [],
      allyTargets: () => live([side.hero, ...(side.board || [])]),
      pickRand:    arr => (arr && arr.length) ? arr[Math.floor(Math.random() * arr.length)] : null,
      // 화상 DOT (_tickStatusEffects 가 매 턴 적용). Math.max 누적방지.
      burn: (targets, amt, turns) => (targets || []).forEach(t => {
        if(!t || t.isDead) return;
        t._burnTurns = Math.max(t._burnTurns || 0, turns);
        t._burnAmount = Math.max(t._burnAmount || 0, amt);
        t._burnElement = t._burnElement || 'fire';
        pushEv({type:'synergy-extra', side:sideKey, kind:'burn', targetUid:t.uid, amount:amt});
      }),
      heal: (targets, amt) => (targets || []).forEach(t => {
        if(!t || t.isDead) return;
        const cap = t.maxHP || t.HP || ((t.curHP || 0) + amt);
        const before = t.curHP || 0;
        t.curHP = Math.min(cap, before + amt);
        if(t.curHP > before) pushEv({type:'synergy-heal-tick', side:sideKey, targetUid:t.uid, amount:t.curHP - before});
      }),
      fullHeal: (targets) => (targets || []).forEach(t => {
        if(!t || t.isDead) return;
        const cap = t.maxHP || t.HP || t.curHP || 0;
        const before = t.curHP || 0;
        t.curHP = cap;
        if(cap > before) pushEv({type:'synergy-heal-tick', side:sideKey, targetUid:t.uid, amount:cap - before});
      }),
      // stun — _stunTurns 세팅 (마법방어막 ward 1회 무효 체크). enforcement = _beginBoardPhase 큐 제외.
      /* diagnosis-confirmed: 2026-06-15 사유: feature — 시너지 stun(전기)도 마법방어막 ward 1회 무효 적용 (전기 카운터 일관) */
      stun: (targets) => (targets || []).forEach(t => {
        if(!t || t.isDead) return;
        if(Match._debuffWarded(t)) return;
        t._stunTurns = Math.max(t._stunTurns || 0, 1);
        pushEv({type:'synergy-extra', side:sideKey, kind:'stun', targetUid:t.uid});
      }),
      // 직접 피해 — 시너지 피해는 DEF 무시(_pierceDef) + 반사 면제(_noReflect). dotElement 연출 분기.
      dmg: (targets, amt, dotElement) => (targets || []).forEach(t => {
        if(!t || t.isDead || typeof Match._damage !== 'function') return;
        Match._damage(t, amt, {_pierceDef:true, _noReflect:true, dotElement: dotElement || null});
        pushEv({type:'synergy-extra', side:sideKey, kind:'dmg', targetUid:t.uid, amount:amt});
      }),
      // DEF 보호막 (turns 만료) — case 'shield'(_dispatchEffect) 의 _shieldMarker attachments 패턴 정확 복제.
      def: (targets, amt, turns) => (targets || []).forEach(t => {
        if(!t || t.isDead) return;
        t._def = (t._def || 0) + amt;
        t._defTurns = Math.max(t._defTurns || 0, turns);
        if(!Array.isArray(t.attachments)) t.attachments = [];
        t.attachments.push({id:'_shield_synergy', _shieldMarker:true, DEF:amt, defTurns:turns, _remainingTurns:turns, keywords:[]});
        pushEv({type:'synergy-extra', side:sideKey, kind:'def', targetUid:t.uid, amount:amt});
      }),
      evade: (targets) => (targets || []).forEach(t => {
        if(!t || t.isDead) return;
        t._evadeOnce = (t._evadeOnce || 0) + 1;
        pushEv({type:'synergy-extra', side:sideKey, kind:'evade', targetUid:t.uid});
      }),
      draw: (n) => (typeof Match._drawCards === 'function') ? Match._drawCards(side, sideKey, n) : 0,
      soul: (n) => { side.soulPool = (side.soulPool || 0) + n; pushEv({type:'synergy-soul-tick', side:sideKey, amount:n}); },
      refund: (n) => { side._refund = (side._refund || 0) + n; },
    };
  };

  /* diagnosis-confirmed: 2026-06-13 사유: feature — race_synergy R2 per-turn base (race_synergy_2026-05-30.md §2/§3/§4). _onTurnBegin 이 round 당 side 1회 호출 보장 → transient(매 턴 새로 적용, 카운트 하락 시 자연 lapse). HEAL=자기 stat HEAL 인 unit/hero 자가재생(R1 per-unit 모델 일관, 원소 ceil/2 옵션B) / SOUL=spirit 등 side-level soulPool +tier / DRAW=fae 등 side-level. 데이터 기반(stat 분기)이라 새 종족 자동 확장. 원소 tier3/5 extras + 6단계 특수 = 후속 cluster. */
  Match._applySynergyPerTurn = function(side, sideKey, roundN){
    if(!side) return;
    const SYN = (typeof RoF !== 'undefined' && RoF.Data && RoF.Data.SYNERGY);
    if(!SYN) return;
    const TIER = SYN.tier, HTIER = SYN.heroTier, STIER = SYN.tierSolo || SYN.tier;
    const cnt = Match._countSynergy(side);
    const idx = n => Math.min(Math.max(n | 0, 0), TIER.length - 1);  /* diagnosis-confirmed: 2026-06-13 refactor — clamp 상한 하드코딩 6 → tier 배열 길이 파생 (확장성 리뷰: tier 길이 변경 시 silent clamp 버그 방지) */
    const st = Match.state;
    const pushEv = ev => { if(st && Array.isArray(st.events)) st.events.push(ev); };

    // ── base per-turn HEAL — 자기 race/element stat 이 HEAL 인 unit/hero 자가재생 (R1 per-unit 모델 일관) ──
    const healOne = (u, isHero) => {
      if(!u || u.isDead) return;
      const baseTier = isHero ? HTIER : TIER;
      let heal = 0;
      const rdef = u.race && SYN.race[u.race];
      if(rdef && rdef.stat === 'HEAL'){
        const rt = (!isHero && rdef.solo) ? STIER : baseTier;
        heal += (rt[idx(cnt.raceCount[u.race] || 0)] || 0);
      }
      const edef = u.element && SYN.element[u.element];
      if(edef && edef.stat === 'HEAL'){
        heal += Math.ceil((baseTier[idx(cnt.elemCount[u.element] || 0)] || 0) / 2);  // 원소 절반(옵션B)
      }
      if(heal > 0){
        const cap = u.maxHP || u.HP || ((u.curHP || 0) + heal);
        const before = u.curHP || 0;
        u.curHP = Math.min(cap, before + heal);
        if(u.curHP > before) pushEv({type:'synergy-heal-tick', side:sideKey, targetUid:u.uid, amount:u.curHP - before});
      }
    };
    cnt.units.forEach(u => healOne(u, false));
    if(cnt.hero) healOne(cnt.hero, true);

    // ── base per-turn SOUL / DRAW — side-level (stat 이 SOUL/DRAW 인 race/element 카운트 tier, 원소 ceil/2) ──
    const allDefs = []
      .concat(Object.keys(SYN.race).map(k    => ({def: SYN.race[k],    count: cnt.raceCount[k], isElem:false})))
      .concat(Object.keys(SYN.element).map(k => ({def: SYN.element[k], count: cnt.elemCount[k], isElem:true})));
    allDefs.forEach(({def, count, isElem}) => {
      if(!count) return;
      const arr = (def.solo && !isElem) ? STIER : TIER;
      let amt = arr[idx(count)] || 0;
      if(isElem) amt = Math.ceil(amt / 2);
      if(amt <= 0) return;
      if(def.stat === 'SOUL'){
        side.soulPool = (side.soulPool || 0) + amt;
        pushEv({type:'synergy-soul-tick', side:sideKey, amount:amt});
      } else if(def.stat === 'DRAW' && typeof Match._drawCards === 'function'){
        const drawn = Match._drawCards(side, sideKey, amt);
        if(drawn > 0) pushEv({type:'synergy-draw-tick', side:sideKey, amount:drawn});
      }
    });

    /* diagnosis-confirmed: 2026-06-13 사유: feature — 원소 tier3(count>=3)/tier5(count>=5) transient extras (race_synergy_2026-05-30.md §4). 누적(>=5 면 tier3+tier5 둘 다). 공유 _synergyFx toolkit 재사용(중복 제거). lookup 테이블(if-체인 회피). ⚠️ persistent flag 류(earth def_all/def_hero, holy revive_hero, dark lifesteal)는 _recomputeSynergy/_damage 훅(Cluster 3a)에서 처리 — 여기선 transient 만. */
    /* diagnosis-confirmed: 2026-06-15 사유: feature — 원소 시너지 전면 재설계 (race_synergy §4 LOCK). per-turn tier3/tier5 를 "최고 하나만"(중첩 X) 으로 변경 + 신규 핸들러(확정 기절 stun_sure_1/2, 랜덤 회복 heal_rand_1, 랜덤 DEF 부여 def_rand_1/def_rand2_2, 전체 피해 dmg_all_1). 옛 stun_25/50(확률)·heal_hero_1·def_all/hero(오버레이) 폐기. */
    const fx = Match._synergyFx(side, sideKey);
    // N명 무작위 distinct 추출 (확정 stun/heal/def 다중 타겟용)
    const pickN = (arr, n) => { const a = (arr || []).slice(); const out = []; while(out.length < n && a.length){ out.push(a.splice(Math.floor(Math.random() * a.length), 1)[0]); } return out; };
    // tier3/tier5 코드 → 핸들러 (per-turn transient). 새 코드 추가 = 여기 한 줄.
    const EXTRA = {
      // 불 — 화상
      burn_enemy_1: () => { const t = fx.pickRand(fx.foeTargets()); if(t) fx.burn([t], 1, 1); },
      burn_all_1:   () => fx.burn(fx.foeTargets(), 1, 1),
      // 물 — 회복 (랜덤 1명 / 전체) · 신성 t3 영웅 +2
      heal_rand_1:  () => { const t = fx.pickRand(fx.allyTargets()); if(t) fx.heal([t], 1); },
      heal_all_1:   () => fx.heal(fx.allyTargets(), 1),
      heal_hero_2:  () => { if(cnt.hero) fx.heal([cnt.hero], 2); },
      // 땅 — DEF 매 턴 부여 (turns=1 → 매 턴 재부여 topup; _tickTimedAttachments 가 직전 것 만료 → 누적X)
      def_rand_1:   () => { const t = fx.pickRand(fx.allyTargets()); if(t) fx.def([t], 1, 1); },
      def_rand2_2:  () => { pickN(fx.allyTargets(), 2).forEach(t => fx.def([t], 2, 1)); },
      def_all_3:    () => fx.def(fx.allyTargets(), 3, 1),   /* diagnosis-confirmed: 2026-06-15 사유: feature — 땅 6단계 지속 (전체 아군 +3 DEF/턴 topup) */
      // 전기 — 확정 기절 (1체 / 2체)
      stun_sure_1:  () => { const t = fx.pickRand(fx.foeTargets()); if(t) fx.stun([t]); },
      stun_sure_2:  () => fx.stun(pickN(fx.foeTargets(), 2)),
      // 암흑 — 직접 피해 (1체 / 전체)
      dmg_enemy_1:  () => { const t = fx.pickRand(fx.foeTargets()); if(t) fx.dmg([t], 1, 'dark'); },
      dmg_all_1:    () => fx.dmg(fx.foeTargets(), 1, 'dark'),
      dark_t5:      () => { fx.dmg(fx.foeTargets(), 1, 'dark'); const t = fx.pickRand(fx.allyTargets()); if(t){ t._synLifesteal = 1; t._synLifestealTurns = Math.max(t._synLifestealTurns || 0, 1); fx.pushEv({type:'synergy-extra', side:sideKey, kind:'lifesteal-grant', targetUid:t.uid}); } },   /* diagnosis-confirmed: 2026-06-15 사유: feature — 암흑 t5 = 전체 적 −1 + 랜덤 아군 1명 1R 흡혈 부여 */
      // revive_hero / lifesteal (옛 코드) — Phase 3 에서 게임1회 부활/유닛 흡혈부여로 재설계 예정
    };
    /* diagnosis-confirmed: 2026-06-15 사유: feature — 6단계 지속 오라 layer (race_synergy §4). _synergy6Triggered.element[el](6/6 시 special 이 set) 재사용 = persist 신호. special 이 per-turn 뒤(_onTurnBegin 6.5)라 자연히 "다음 라운드부터". 영구(flag 비초기화) — count 드롭에도 지속. 같은 종류면 persist 가 tier3/5 대체(highest). */
    const persistFlags = (side._synergy6Triggered && side._synergy6Triggered.element) || null;
    Object.keys(SYN.element).forEach(el => {
      const edef = SYN.element[el];
      // 6단계 지속 활성 → 최고 tier → tier3/5 대신 persist 적용
      if(persistFlags && persistFlags[el] && edef.persist && EXTRA[edef.persist]){ EXTRA[edef.persist](); return; }
      const c = cnt.elemCount[el] || 0;
      // 최고 하나만 (중첩 X, 2026-06-15): tier5 도달 시 tier5 만, 아니면 tier3.
      if(c >= 5 && edef.tier5 && EXTRA[edef.tier5]) EXTRA[edef.tier5]();
      else if(c >= 3 && edef.tier3 && EXTRA[edef.tier3]) EXTRA[edef.tier3]();
    });

    // ── 6단계 beast_rage 발동 후 지속 — 매 턴 자기 진영 야수 +1 ATK 누적 (special 이 _beastRageActive set) ──
    if(side._beastRageActive){
      cnt.units.forEach(u => { if(u && !u.isDead && u.race === 'beast'){ u.curATK = (u.curATK || 0) + 1; fx.pushEv({type:'synergy-extra', side:sideKey, kind:'rage', targetUid:u.uid, amount:1}); } });
    }
  };

  /* diagnosis-confirmed: 2026-06-13 사유: feature — race_synergy R2 Cluster 3 6단계 특수 19종 (race_synergy_2026-05-30.md §3/§4/§5). 매치 1회 발동(_synergy6Triggered flag, 5명→6명 재도달 재발동 X). 카운트=영웅 포함(유닛+매칭영웅) — BOARD_MAX 5라 영웅 포함해야 count 6 도달 (사용자 결정 2026-06-13). R1 stat 티어는 영웅 제외 유지(이원화 의도적). _synergyFx + 기존 메커니즘 재사용 + 신규 5(human_levelup/beast_rage/savage_cry/abyssal_oblivion/undead_march). 데이터 기반(SPECIAL[def.special]). ⚠️ S1 도달 가능 = 인간(영웅=인간)·영웅원소만(타 종족 영웅 불일치+카드 부족). spirit_fusion/brontes_bolt stun 은 선재 dead mechanic(연출만). */
  Match._applySynergySpecial = function(side, sideKey){
    if(!side) return;
    const SYN = (typeof RoF !== 'undefined' && RoF.Data && RoF.Data.SYNERGY);
    if(!SYN) return;
    const flags = side._synergy6Triggered;
    if(!flags || !flags.race || !flags.element) return;
    const cnt = Match._countSynergy(side);
    const hero = cnt.hero;
    const fx = Match._synergyFx(side, sideKey);
    const foe = fx.foe;

    // ── 신규 메커니즘 (인라인 closure) ──
    const reviveFromGrave = (race) => {
      if((side.board || []).length >= BOARD_MAX) return;
      const grave = side.gravePile || [];
      const i = grave.findIndex(c => c && c.race === race);
      if(i < 0) return;
      const c = grave.splice(i, 1)[0];
      // 전투 상태 reset (gravePile 재활용 패턴, _drawCards 와 동일)
      c.isDead = false; c.curHP = c.maxHP || c.HP || 1; c.curATK = c.baseATK || c.ATK || 0;
      c.exhausted = true; c._acted = false; c.attackedThisTurn = false; c._def = 0; c._defTurns = 0; c.attachments = [];
      side.board.push(c);
      fx.pushEv({type:'synergy-special', side:sideKey, kind:'revive', targetUid:c.uid});
    };
    const discardFoeHand = () => {
      if(!foe || !Array.isArray(foe.hand) || foe.hand.length === 0) return;
      const i = Math.floor(Math.random() * foe.hand.length);
      const c = foe.hand.splice(i, 1)[0];
      (foe.discardPile = foe.discardPile || []).push(c);
      fx.pushEv({type:'synergy-special', side:sideKey, kind:'discard', cardId: (c && c.id) || null});
    };
    const heroAtkMult = () => {
      if(!hero || hero.isDead) return;
      const cur = hero.curATK || 0; if(cur <= 0) return;
      hero.curATK = cur * 2;  // ×2 (1턴, _tickTempStatBuffs 가 -cur 로 원복)
      hero._tempStatBuffs = hero._tempStatBuffs || [];
      hero._tempStatBuffs.push({stat:'ATK', amount: cur, roundsLeft: 1, turnsTotal: 1, by:'savage_cry'});
      fx.pushEv({type:'synergy-special', side:sideKey, kind:'atk-mult', targetUid:hero.uid});
    };
    const humanLevelUp = () => {
      // 모든 인간 +레벨 1 (XP 임계만큼 부여 → _autoLevelUpCheck 가 보너스 적용 + cap 유지)
      cnt.units.forEach(u => { if(u.race === 'human'){ u._matchExp = (u._matchExp || 0) + (u._matchXpNext || UNIT_XP_PER_LEVEL); _autoUnitLevelUpCheck(u); } });
      if(hero && hero.race === 'human'){ hero.matchXP = (hero.matchXP || 0) + (hero.matchXPNext || HERO_XP_PER_LEVEL); _autoHeroLevelUpCheck(side, hero); }
    };

    // ── 19 특수 (code → effect). 새 special 추가 = SYNERGY 데이터 + 여기 한 줄. ──
    const SPECIAL = {
      // 종족 13
      human_levelup:    humanLevelUp,
      beast_rage:       () => { side._beastRageActive = true; },           // 매 턴 야수 +1 ATK (per-turn 적용)
      dragon_fury:      () => fx.burn(fx.foeTargets(), 3, 1),              // 모든 적 3 burn 1턴
      avian_evade:      () => fx.evade(cnt.units.filter(u => u.race === 'avian').concat((hero && hero.race === 'avian') ? [hero] : [])),
      undead_march:     () => reviveFromGrave('undead'),                  // 죽은 언데드 1 부활
      demon_pact:       () => fx.refund(5),                               // 영혼 +5 (다음 턴)
      celestial_light:  () => { if(hero) fx.fullHeal([hero]); },          // 영웅 만피
      spirit_fusion:    () => { const t = fx.pickRand(fx.foeTargets()); if(t) fx.stun([t]); },  // 적 1체 stun(dead)
      titan_quake:      () => fx.dmg(fx.foeTargets(), 2, 'earth'),        // 모든 적 -2 HP
      abyssal_oblivion: discardFoeHand,                                   // 적 손패 1장 폐기
      fae_call:         () => fx.draw(2),                                 // +2 드로우
      veinforged_wall:  () => fx.def(fx.allyTargets(), 2, 2),             // 모든 아군 DEF +2 (2턴)
      savage_cry:       heroAtkMult,                                      // 영웅 ATK ×2 (1턴)
      // 원소 6
      grahim_fury:      () => fx.burn(fx.foeTargets(), 3, 3),             // 모든 적 3 burn 3턴
      morath_mercy:     () => fx.fullHeal(fx.allyTargets()),             // 모든 아군 만피
      eidra_silence:    () => {},   /* diagnosis-confirmed: 2026-06-15 사유: feature — 땅 6단계 = burst 없음(지속 오라 def_all_3 가 per-turn). flag set 만으로 persist 활성 */
      brontes_bolt:     () => fx.stun(fx.foeTargets()),                  // 모든 적 stun(dead)
      /* diagnosis-confirmed: 2026-06-13 사유: bug-fix — seraphiel_vow 가 _reviveOnce(손오공 카드 sk_sun_wukong_revive 와 공유 필드)를 set 하면 부활 소비 추적 깨짐(balance-auditor blocker). _synReviveOnce(시너지 전용, holy tier5 와 공용 — 카드와 독립)로 분리. 카드 부활 + 시너지 부활 = 독립 2회. */
      seraphiel_vow:    () => { fx.allyTargets().forEach(t => { t._physImmuneTurns = Math.max(t._physImmuneTurns || 0, 1); }); fx.pushEv({type:'synergy-special', side:sideKey, kind:'phys-immune'}); },  /* diagnosis-confirmed: 2026-06-15 사유: feature — 신성 6단계 burst = 즉시 물리피해 무적 1라운드(전체 아군). 옛 영웅부활 burst 교체(부활은 holy t3 유닛부활로 이전 — Phase 3c). _damage 가 _physImmuneTurns 차단. */
      necrion_pact:     () => { fx.dmg(fx.foeTargets(), 3, 'dark'); fx.allyTargets().forEach(t => { t._synLifesteal = 1; t._synLifestealTurns = Math.max(t._synLifestealTurns || 0, 1); }); },  /* diagnosis-confirmed: 2026-06-15 사유: feature — 암흑 6단계 burst = 모든 적 −3 + 전체 아군(영웅 포함) 1R 흡혈 부여 (옛 영웅 +3 heal 교체) */
    };

    // 발동: count(영웅 포함) >= 6 && flag false → flag set + 발동. (count 도달은 5유닛+매칭영웅)
    const checkGroup = (defs, counts, heroKey, flagMap, evKind) => {
      Object.keys(defs).forEach(k => {
        const def = defs[k];
        if(!def.special || flagMap[k]) return;
        const c = (counts[k] || 0) + (hero && hero[heroKey] === k ? 1 : 0);
        if(c < 6) return;
        flagMap[k] = true;  // 1회 — 재도달 재발동 차단 (핸들러 예외 시에도 소비 → 무한 재시도 방지)
        /* diagnosis-confirmed: 2026-06-13 사유: feature/robustness — 미구현 핸들러 silent skip 방지(coverage 회귀가 unimplemented 잡음) + 핸들러 try-catch (correctness-verifier major: 한 특수 예외가 _onTurnBegin 턴 전체를 깨지 않도록 격리). */
        if(SPECIAL[def.special]){
          try { SPECIAL[def.special](); }
          catch(e){ logEvent('synergy-special-error', {code: def.special, error: (e && e.message) || String(e)}); }
        } else {
          fx.pushEv({type:'synergy-unimplemented', side:sideKey, code:def.special});
        }
        fx.pushEv({type:'synergy-special', side:sideKey, special:def.special, [evKind]:k});
      });
    };
    checkGroup(SYN.race,    cnt.raceCount, 'race',    flags.race,    'race');
    checkGroup(SYN.element, cnt.elemCount, 'element', flags.element, 'element');
  };

  /* diagnosis-confirmed: 2026-06-13 사유: feature — 6단계 특수 1회 발동 flag 초기화 (race_synergy_2026-05-30.md §5). SYNERGY 데이터에서 동적 생성(하드코딩 19키 회피 — 새 종족/원소 추가 시 자동 포함). */
  // _initSynergyFlags — {race:{...all false}, element:{...all false}}. Match.start 가 player/enemy 각각 호출.
  Match._initSynergyFlags = function(){
    const SYN = (typeof RoF !== 'undefined' && RoF.Data && RoF.Data.SYNERGY) || {race:{}, element:{}};
    const mk = obj => Object.keys(obj || {}).reduce((acc, k) => { acc[k] = false; return acc; }, {});
    return { race: mk(SYN.race), element: mk(SYN.element) };
  };

  // 디버그 로그 (콘솔 노출 + state.log)
  function logEvent(type, data){
    const entry = {t: Date.now(), type, ...data};
    Match.log.push(entry);
    if(Match.state) Match.state.log.push(entry);
    if(global.__MATCH_VERBOSE__) console.log('[match]', type, data);
  }

  // ───────── 매치 시작 ─────────
  // opts = {
  //   playerHero: 영웅 카드 객체 (RoF.Data.createHero 산출),
  //   enemyHero:  영웅 카드 객체,
  //   playerDeck: 카드 배열 (length === 30, 데이터 객체 그대로 — 인스턴스 변환은 내부),
  //   enemyDeck:  카드 배열,
  //   playerFirst: bool (선공 여부, 미지정 시 랜덤),
  // }
  Match.start = function(opts){
    if(!opts) throw new Error('Match.start: opts 필요');
    if(!opts.playerHero) throw new Error('Match.start: playerHero 필요');
    if(!opts.enemyHero)  throw new Error('Match.start: enemyHero 필요');
    if(!Array.isArray(opts.playerDeck)) throw new Error('Match.start: playerDeck 필요');
    if(!Array.isArray(opts.enemyDeck))  throw new Error('Match.start: enemyDeck 필요');

    const _validateHero = (h, label) => {
      if(h.HP == null || h.ATK == null || h.SOUL == null){
        throw new Error('Match.start: ' + label + ' PHASE 6 5필드 (HP/ATK/SOUL) 누락 — meta {gender,role,element,skinIndex} 객체 받았나? RoF.Data.createHero(meta) 로 변환 필요.');
      }
    };
    _validateHero(opts.playerHero, 'playerHero');
    _validateHero(opts.enemyHero,  'enemyHero');

    /* diagnosis-confirmed: 2026-06-07 사유: feature — retain 키워드 데이터 정규화. draw 경로 카드는 raw(instantiate 안 됨)라 _persistent 사용처 7곳이 keywords 를 못 봄 → deck 카드에서 keywords 'retain'(exhaust 와 모순 아닐 때) → _persistent=true 박아 전 경로 커버. exhaust 와 모순 시 exhaust 우선(skip). battle_system_decisions.md 2026-06-07 A. */
    [opts.playerDeck, opts.enemyDeck].forEach(deck => deck.forEach(c => {
      if(c && Array.isArray(c.keywords) && c.keywords.indexOf('retain') >= 0
         && c.keywords.indexOf('exhaust') < 0 && c._persistent !== true){
        c._persistent = true;
      }
    }));

    _uidSeq = 0;
    Match.log = [];

    // 2026-05-17 #14 fix — Match.start 시 AI stale 상태 reset (이전 매치 winner=enemy 등으로 _stopRequested set 됐을 수 있음)
    if(Match.AI){
      Match.AI._stopRequested = false;
      Match.AI._inLoop = false;
    }
    /* diagnosis-confirmed: 2026-06-13 — Option A 보드 적 AI 디퍼 플래그 reset. 직접 Match.start(회귀/headless)는 false → 동기 AI(_defaultAfterBoardTurn) 유지. UI.startMatch 만 이 직후 true set. repro/hypo/demo: 61_match_ui UI.startMatch 옵션A 주석. */
    Match._deferBoardAI = false;

    const playerFirst = (opts.playerFirst != null) ? !!opts.playerFirst : (_rand() < 0.5);

    // 영웅 인스턴스화 + 보드 미리 배치
    const pHero = instantiate(opts.playerHero);
    const eHero = instantiate(opts.enemyHero);
    pHero.exhausted = false;  // 영웅은 소환 멀미 없음
    eHero.exhausted = false;

    // 덱 인스턴스화 + 셔플 (5-pile 분배 input)
    const pAllDeck = shuffle(opts.playerDeck.map(instantiate));
    const eAllDeck = shuffle(opts.enemyDeck.map(instantiate));

    // PHASE 6 5-pile 분배 (design/battle_system_decisions.md 2026-05-12 정본)
    // - initialUnitPile: 영웅 제외 동료 unit (최대 4장, formation 4명 영입 전제)
    // - drawPile (= state.deck): 영웅 시그니처 + 분류 미지정 카드 + 4초과 unit (회귀 호환 fallback)
    // - dormantPile: 동료 시그니처 (bundledByUnit 가 동료 id) — 보드 등장 시 drawPile 합류 예정
    // - gravePile: 빈 (사망 unit 보관, Phase F)
    // 첫 손패 = initialUnitPile 모두 + drawPile 에서 (HAND_START 채울 때까지)
    function dispense5Pile(allCards, heroId) {
      const units = [], heroSigs = [], companionSigs = [];
      allCards.forEach(c => {
        if (c.kind === 'unit') units.push(c);
        else if (c.bundledByUnit && c.bundledByUnit !== heroId) companionSigs.push(c);
        else heroSigs.push(c);  // 미지정 또는 영웅 시그 → drawPile default
      });
      const initialUnitPile = units.slice(0, 4);
      const remainingUnits = units.slice(4);  // 5장 이상이면 drawPile 합류 (회귀 호환)
      const drawPile = shuffle([].concat(heroSigs, remainingUnits));
      return { initialUnitPile, drawPile, dormantPile: companionSigs };
    }
    const pPiles = dispense5Pile(pAllDeck, pHero.id);
    const ePiles = dispense5Pile(eAllDeck, eHero.id);

    // 시작 손패 = initialUnitPile 모두 + drawPile 에서 채움 (HAND_START 또는 +1 후공)
    const pHandSize = HAND_START + (playerFirst ? 0 : HAND_BONUS_2ND);
    const eHandSize = HAND_START + (playerFirst ? HAND_BONUS_2ND : 0);
    function fillInitialHand(piles, target) {
      const hand = piles.initialUnitPile.splice(0);  // 모두 손패로 — initialUnitPile 비워짐
      while (hand.length < target && piles.drawPile.length > 0) {
        hand.push(piles.drawPile.shift());
      }
      return hand;
    }
    const pHand = fillInitialHand(pPiles, pHandSize);
    const eHand = fillInitialHand(ePiles, eHandSize);

    // 🚨 보존 카드 (_persistent:true) 강제 hand 추가 — 영웅 종류 무관, 매치 시작 시 player + enemy 양측
    //    "쓸 때까지 영구 보존" (project_temp_dragon_flame_all_heroes.md, 2026-05-17 사용자 명시)
    //    HERO_SIG 와 무관 (deck 셔플 결과 의존 X). _endRound cleanup 에서도 제외.
    const _persistentTemplates = (RoF.Data.SKILLS || []).filter(s => s && s._persistent === true);
    _persistentTemplates.forEach(tpl => {
      pHand.push(instantiate(tpl));
      eHand.push(instantiate(tpl));
    });
    /* diagnosis-confirmed: 2026-06-07 사유: feature — lifecycle innate(숙명): drawPile 에 있는 innate 카드를 첫 손패에 강제 (매치 시작만, 이후 일반 순환). battle_system_decisions.md 2026-06-07 A. */
    function _pullInnate(piles, hand){
      const innates = (piles.drawPile || []).filter(c => c && Array.isArray(c.keywords) && c.keywords.indexOf('innate') >= 0);
      innates.forEach(c => {
        const i = piles.drawPile.indexOf(c);
        if(i >= 0) piles.drawPile.splice(i, 1);
        if(hand.length < 10) hand.push(instantiate(c));
      });
    }
    _pullInnate(pPiles, pHand);
    _pullInnate(ePiles, eHand);
    // 기존 코드 호환: pDeck/eDeck 변수 alias (= drawPile)
    const pDeck = pPiles.drawPile;
    const eDeck = ePiles.drawPile;

    Match.state = {
      turn: 1,
      round: 1,                  // Plan 2.A: 라운드 번호 (M&M Fates 패턴 — 카드 페이즈 + 보드 페이즈 = 1라운드)
      phase: PHASE.CARD,         // Plan 2.A: PHASE.CARD | PHASE.BOARD — UI 통합 cluster 에서 enum 화 (2026-05-11)
      step:  STEP.CARD_PLAY,     // 2026-05-29 B Phase 1: HS step machine 7단계 — phase 와 양립 운영. stepToPhase alias 로 호환.
      firstSide: playerFirst ? 'player' : 'enemy',  // Task A.3: 50/50 선공 결정 — 보드 페이즈 첫 보드턴 측
      side: playerFirst ? 'player' : 'enemy',
      cardPhaseEnded: {player: false, enemy: false},  // Task A.3: 카드 페이즈 종료 표지 (양측 true → 보드 페이즈 전환)
      boardTurnQueue: [],        // Task A.3 stub: 보드 페이즈 진행 큐 ({sideKey, unitUid} 배열). Task A.4 본격 알고리즘.
      boardTurnCursor: 0,        // Task A.3 stub: 큐 커서 (Task A.4 에서 _advanceBoardTurn 본격 활용).
      player: {
        hero:      pHero,
        deck:      pDeck,        // Plan 2.A: drawPile 역할. 호환성 유지로 이름 보존 (Task A.2~ 에서 drawPile 의미로 사용).
        initialUnitPile: pPiles.initialUnitPile,  // Plan 2.B Phase A (2026-05-12): 매치 시작 후 비어있음 (첫 손패 분배됨)
        gravePile: [],           // Plan 2.B Phase F: 사망 unit (XP/Level 보존, 부활 source). 현재 빈.
        discardPile: [],         // Plan 2.A: 사용했거나 라운드 종료 시 손패에서 버려진 카드. drawPile 비면 셔플 → drawPile 환원.
        dormantPile: pPiles.dormantPile,  // Plan 2.B Phase A: 동료 시그니처 봉인 (bundledByUnit 가 동료 id). 보드 등장 시 → drawPile.
        hand:      pHand,
        board:     [],
        soulPool:  0,
        _modifiers: [],          // {stat:'heal'|'damage_dealt'|..., amount, turnsLeft} 진영 전역 버프
        _nextDiscount: null,     // {amount, filter} — 다음 카드 NEED_SOUL -N (1회성)
        _nextDmgBuff: null,      // {amount, filter} — 다음 (필터매칭) 카드 damage +N (1회성)
        _refund: 0,              // 2026-05-29 P0 #4 (StS2 패턴) — 라운드 시작 시 추가 영혼 환급 (effect refund 누적, _onSoulRecharge 가 차감)
        _disintegrated: [],      // Phase 1A.2: 부서진 카드 보존 (PHASE 7 부활 source)
        _pendingDisintegrate: [],// Phase 1A.2: 동료 사망 → 다음 턴 시작 시 부서질 큐 (Plan 2.A Task A.5 에서 즉시 부서짐으로 폐기 예정)
        /* diagnosis-confirmed: 2026-06-07 사유: feature — 카드 lifecycle 5종 + 메커니즘 7종 (battle_system_decisions.md 2026-06-07). state 신규 필드 양쪽 대칭 초기화. */
        exhaustPile: [],         // 2026-06-07 lifecycle — exhaust/first_only 카드 영구 제외 (drawPile 환원 셔플 대상 아님)
        _redrawPending: [],      // 2026-06-07 lifecycle — redraw 카드: 사용 후 다음 라운드 우선 손패 재등장
        _overload: 0,            // 2026-06-07 메커니즘 — 다음 _onSoulRecharge 영혼 -N (1회 소비)
        _cardsPlayedThisRound: 0,// 2026-06-07 메커니즘 — combo order 카운터 (_beginRound reset)
        /* diagnosis-confirmed: 2026-06-13 사유: feature — R2 시너지 state 신규 필드 (player). _turnBeginRound=_onTurnBegin 가드 / _synergy6Triggered=6단계 1회 flag. enemy 대칭 초기화. */
        _turnBeginRound: 0,      // 2026-06-13 — _onTurnBegin round-당-1회 가드 (이중 호출 시 만료 2배 차단)
        _synergy6Triggered: Match._initSynergyFlags(),  // 2026-06-13 R2 — 6단계 특수 1회 발동 flag (race/element)
      },
      enemy: {
        hero:      eHero,
        deck:      eDeck,        // Plan 2.A: drawPile (위 player 와 동일)
        discardPile: [],
        dormantPile: [],
        hand:      eHand,
        board:     [],
        soulPool:  0,
        _modifiers: [],
        _nextDiscount: null,
        _nextDmgBuff: null,
        _refund: 0,
        _disintegrated: [],
        _pendingDisintegrate: [],
        /* diagnosis-confirmed: 2026-06-07 사유: feature — lifecycle/메커니즘 state 필드 enemy 대칭 초기화 (player 와 동일). */
        exhaustPile: [],         // 2026-06-07 lifecycle (enemy 대칭)
        _redrawPending: [],
        _overload: 0,
        _cardsPlayedThisRound: 0,
        /* diagnosis-confirmed: 2026-06-13 사유: feature — R2 시너지 state 신규 필드 (enemy 대칭). player_enemy_symmetry 룰. */
        _turnBeginRound: 0,      // 2026-06-13 — _onTurnBegin round-당-1회 가드 (enemy 대칭)
        _synergy6Triggered: Match._initSynergyFlags(),  // 2026-06-13 R2 — 6단계 특수 1회 발동 flag (enemy 대칭)
      },
      log: [],
      events: [],                // Phase 1A.2: UI 이벤트 큐 (코어→UI 시각 시퀀스)
      winner: null,
      turnStartedAt: Date.now(),
      /* diagnosis-confirmed: 2026-06-09 사유: feature — 도전자 프로필을 퀘스트 적 영웅과 동일시 (사용자 결정). opts.context/questId 를 state 에 보존해 _renderProfile 이 퀘스트/PvP 분기. 코어 전투 로직 무영향 (신규 read-only 필드). */
      // 2026-06-09 — 매치 맥락 ('quest' | 'pvp' | null). 도전자 프로필 분기에 사용 (퀘스트면 적 영웅 = 도전자 동일시).
      context: (opts && opts.context) || null,
      questId: (opts && opts.questId) || null,
      // 2026-05-24 — 매 AI 사이클 진입 시 setTimeout 지연 (ms). 회귀 호환 default = 0 (즉시).
      //   UI 흐름: UI.startMatch (61_match_ui.js:2635) 가 opts.aiAutoStartDelayMs = 2000+random*1000 명시 전달.
      //   _resumeTurn 의 AI 호출에서 사용.
      aiTurnDelayMs: (opts && typeof opts.aiAutoStartDelayMs === 'number') ? opts.aiAutoStartDelayMs : 0,
    };

    logEvent('match-start', {playerFirst, pHand: pHandSize, eHand: eHandSize});

    // 2026-05-17 매치 알림 정본 — 동전 뒤집기 시네마틱 (시안 v1 컨펌)
    if(Array.isArray(Match.state.events)){
      Match.state.events.push({type: 'coin-flip', firstSide: playerFirst ? 'player' : 'enemy'});
    }

    // 2026-05-24 매치 시작 cinematic (V2 갤러리 사용자 컨펌 mockup/match_start_cinematic/)
    //   battle_system_decisions.md §매치 시작 cinematic 표준 룰 / feature_manifest 3.17
    //   순서: coin-flip → match-start-cinematic (~3.3s 보드 zoom + 영웅 sequential spawn) → _beginRound(1)
    if(Array.isArray(Match.state.events)){
      Match.state.events.push({type: 'match-start-cinematic'});
    }

    // Task A.3: 첫 라운드 카드 페이즈 진입.
    // _beginRound(1) 가 phase='card' / 보드 활성 / 영혼력 충전. 첫 라운드는 손패 reset skip (이미 분배됨).
    // 옛 _beginTurn(true) 호환 항목 (보드 활성·영혼 충전) 모두 _beginRound 가 처리.
    // 옛 _beginTurn 자체는 alias 로 보존 — 회귀(`match-companion-death-v6` 등) 가 직접 호출.
    Match._beginRound(1);

    // 매치 시작 시 적 선공이면 AI 가 첫 턴 진행.
    // 2026-05-17 v3 — 사용자 명시 "7초 unlock 후 5~10초 random 후 AI 첫 행동".
    // pregame 7초 (동전 4.5 + banner 1.5 + swoop 1) + 5~10초 random = 12000~17000ms.
    // 회귀: opts.aiAutoStartDelayMs:0 전달 → 즉시.
    if(Match.state.side === 'enemy' && Match.AI){
      // 2026-05-17 v4 — 첫 라운드 (Match.start) AI random 지연.
      // 2026-05-24 fine-tune v4 (C-a 하스스톤 패턴): 매 사이클 진입 2~3초 random.
      //   - 회귀 호환: default 0 (회귀가 M.start 직접 호출 시 즉시 AI 행동).
      //   - UI 흐름: UI.startMatch (61_match_ui.js:2635) 가 opts.aiAutoStartDelayMs = 2000+random*1000 명시 전달.
      //   - state.aiTurnDelayMs 에 저장 → _resumeTurn 가 동일 값 재사용.
      // 라운드 2+ AI 는 renderState 의 _lastSeenRound setTimeout (1800ms) 그대로.
      const defaultDelay = 0;  // 회귀 호환. UI 는 명시 전달.
      const delayMs = (opts && typeof opts.aiAutoStartDelayMs === 'number') ? opts.aiAutoStartDelayMs : defaultDelay;
      if(delayMs > 0 && typeof setTimeout === 'function'){
        setTimeout(() => {
          if(Match.state && Match.state.side === 'enemy' && !Match.state.winner) Match.AI.takeTurn();
        }, delayMs);
      } else {
        Match.AI.takeTurn();
      }
    }

    return Match.state;
  };

  // ───────── 턴 시작 ─────────
  // skipDraw: 첫 턴은 시작 분배(5/6장)가 이미 완료되어 있으므로 드로우 skip.
  Match._beginTurn = function(skipDraw){
    const st = Match.state;
    if(!st || st.winner) return;
    const side = st[st.side];

    // 1. ~~영혼 풀 회복~~ — Plan 2.B Phase H (2026-05-12) 폐기.
    // 5-pile 정본: 영혼력은 매 라운드 시작 시 영웅.SOUL 새 충전 (_beginRound 에서 처리).
    // 매 턴 추가 income 없음 (누적 X 룰). 옛 calcSoulIncome 매 턴 호출 룰 폐기.

    // 2. ~~1장 드로우~~ — Plan 2.B Phase H (2026-05-12) 폐기.
    // design/battle_system_decisions.md:88 "매 턴 1장 드로우 룰 폐기" 정합.
    // 5-pile 정본: 매 라운드 5장 새로 draw (matched by _beginRound), 매 턴 추가 draw 없음.

    // 3. 보드 유닛 행동 가능 상태 회복
    side.board.forEach(u => {
      u.exhausted = false;
      u.attackedThisTurn = false;
    });
    if(side.hero){
      side.hero.exhausted = false;
      side.hero.attackedThisTurn = false;
    }

    // 4. 시간제 attach 만료 (DEF/reflect/임시 키워드) — 첫 턴 skipDraw 라도 만료는 적용 안 함 (공정성)
    if(!skipDraw) Match._tickTimedAttachments(side);

    // 5. 상태 효과 처리 (burn 데미지 / tick_heal 회복 / stun 해제) — Phase E-2.6
    if(!skipDraw) Match._tickStatusEffects(side);

    // 6. 진영 전역 modifier 만료 (heal 등 turnsLeft -=1, 0 도달 시 제거)
    if(!skipDraw && Array.isArray(side._modifiers) && side._modifiers.length){
      side._modifiers.forEach(m => { if(m && typeof m.turnsLeft === 'number') m.turnsLeft -= 1; });
      const before = side._modifiers.length;
      side._modifiers = side._modifiers.filter(m => m && (typeof m.turnsLeft !== 'number' || m.turnsLeft > 0));
      if(side._modifiers.length < before){
        logEvent('modifier-expire', {side: st.side, removed: before - side._modifiers.length});
      }
    }

    // 7. Phase 1A.5 — pending disintegrate 처리 (동료 사망 → 다음 자기 턴 시작 시 시그니처 카드 흩어짐).
    //    사전 스냅샷 (uid + handIdx + card 데이터) 캡처 후 splice — UI ghost 가 원래 위치에서 부서짐.
    if(!skipDraw && Array.isArray(side._pendingDisintegrate) && side._pendingDisintegrate.length){
      side._pendingDisintegrate.forEach(p => {
        const cardUids = p.cardUids || [];
        const snapshot = cardUids.map(uid => {
          const handIdx = (side.hand || []).findIndex(c => c && c.uid === uid);
          const inDeck = handIdx < 0;
          const card = handIdx >= 0
            ? side.hand[handIdx]
            : (side.deck || []).find(c => c && c.uid === uid);
          return {uid, handIdx, inDeck, card};
        }).filter(s => s.card);

        const removed = _disintegrateCards(side, cardUids);
        if(removed.length){
          st.events.push({
            type: 'pending-disintegrate-trigger',
            side: st.side,
            unitId: p.unitId,
            unitName: p.unitName,
            removedSnapshot: snapshot,
            totalCount: removed.length,
          });
          logEvent('pending-disintegrate', {side: st.side, unitName: p.unitName, count: removed.length});
        }
      });
      side._pendingDisintegrate = [];
    }

    st.turnStartedAt = Date.now();
    logEvent('turn-begin', {side: st.side, turn: st.turn});
  };

  // ───────── 라운드 흐름 (Plan 2.A — M&M Fates 패턴, 2026-05-10) ─────────
  // 1 라운드 = 카드 페이즈 + 보드 페이즈. _beginRound 가 양측 손패/영혼력/_acted 일괄 갱신.
  // 첫 라운드는 Match.start 가 손패 직접 분배 → roundN===1 분기로 손패 reset skip (Plan 2.B 통합 시 정리 예정).
  // 호출자 (Match.start, _endTurn 폐기 흐름) 는 Task A.3 phase 룰 cluster 에서 추가.
  // 정본: design/battle_system_decisions.md 2026-05-10 라운드 구조 섹션.
  // 2026-05-17 B7 fix — 손패 draw 분리 (사용자 명시 "내턴 시작 시 손패 5장 뽑아야").
  // 옛: _beginRound 가 양측 동시 draw → AI 턴인데 player 카드 바뀜 (이중 보임)
  // 신: firstSide 만 _beginRound 시점 draw, 후행 측은 endCardPhase(firstSide) 호출 시 draw
  // 2026-05-17 R3 — StS 식 retain. 차례 진입 시 hand 모두 cleanup (보존 카드 제외) + 5장 새 draw.
  // 보존 (_persistent=true) = retain 키워드. hand 영구 유지.
  // hand cap 10 (사용자 명시). draw 수 = min(5, 10 - 보존카드수).
  Match._drawHandForSide = function(side, sideKey){
    if(!side) return;
    // 1. cleanup — 보존 유지, 일반 카드 unit→deck/시그→discard
    const surviving = [];
    while(side.hand.length > 0){
      const c = side.hand.shift();
      if(!c) continue;
      /* diagnosis-confirmed: 2026-06-07 사유: feature — 메커니즘 Ethereal(휘발). 라운드 넘길 때 손패 잔존이면 소멸(exhaust). battle_system_decisions.md 2026-06-07 B-5. */
      if(Array.isArray(c.keywords) && c.keywords.indexOf('ethereal') >= 0){
        side.exhaustPile = side.exhaustPile || [];
        side.exhaustPile.push(c);
        continue;
      }
      if(c._persistent === true){
        surviving.push(c);
      } else if(c.kind === 'unit'){
        side.deck.push(c);
      } else {
        side.discardPile.push(c);
      }
    }
    side.hand = surviving;
    /* diagnosis-confirmed: 2026-06-07 사유: feature — lifecycle redraw. 사용된 redraw 카드(_redrawPending)를 다음 라운드 손패에 우선 재등장 후, 나머지를 draw 로 채움(총 손패 한도 유지). battle_system_decisions.md 2026-06-07 A. */
    if(Array.isArray(side._redrawPending) && side._redrawPending.length > 0){
      while(side._redrawPending.length > 0 && side.hand.length < 10){
        side.hand.push(side._redrawPending.shift());
      }
    }
    /* _todo op draw 헬퍼 + extra_draw counter */
    // 2. draw — hand cap 10. extra draw 누적분 반영 (_extraDraw=지속 / _nextTurnExtraDraw=1회).
    const HAND_PER_ROUND = HAND_START;
    const HAND_MAX = 10;
    const extra = (side._extraDraw || 0) + (side._nextTurnExtraDraw || 0);
    side._nextTurnExtraDraw = 0;  // 1회성 — 이번 라운드 draw 에 소비
    const want = Math.max(0, Math.min(HAND_PER_ROUND + extra, HAND_MAX - side.hand.length));
    Match._drawCards(side, sideKey, want);
  };

  // 즉시 draw n장 — 라운드 draw / draw_1·draw_2 스펠 공용. drawPile 부족 시 discard+grave 셔플 환원.
  // 반환: 실제 draw 한 장수. hand cap 10 / 환원 후에도 0 이면 중단.
  // 회귀 match-revive-by-shuffle-v6 정합 — baseATK 보존 의무.
  Match._drawCards = function(side, sideKey, n){
    if(!side || n <= 0) return 0;
    const HAND_MAX = 10;
    let drawn = 0;
    for(let i=0; i<n; i++){
      if(side.hand.length >= HAND_MAX) break;
      if(side.deck.length === 0){
        const reshuffleSrc = [].concat(side.discardPile || [], side.gravePile || []);
        if(reshuffleSrc.length > 0){
          // 2026-05-29 #35 fix — gravePile (죽은 unit) 카드 instance 재 활용 시 전투 상태 reset.
          //   원인: 죽은 instance 의 isDead=true / curHP=0 / attachments 잔존 → 보드 놓자마자 _cleanupBoard 즉시 제거.
          //   Fix: cur* / 부착 상태만 reset. base* / HP / ATK / _baseKeywords 보존 (진화/buff 매치 영향).
          reshuffleSrc.forEach(c => {
            if(!c) return;
            c.isDead = false;
            c.curHP = c.maxHP || c.HP || 0;
            c.curATK = c.baseATK || c.ATK || 0;
            c.exhausted = (c.kind === 'unit');  // unit 만 소환 멀미 default
            c.attackedThisTurn = false;
            c._acted = false;
            c._def = 0;
            c._defTurns = 0;
            c._reflect = 0;
            c._reflectTurns = 0;
            c._reflectBurn = 0;        /* diagnosis-confirmed: 2026-06-06 사유: feature — 재활용 카드 반사화상 상태 reset */
            c._reflectBurnTurns = 0;
            c._reflectAll = false;
            c._reviveOnce = 0;
            c._imbueAtkBonus = 0;
            c._imbueBurn = 0;
            c._imbueBurnTurns = 0;
            c._tempStatBuffs = [];  /* diagnosis-confirmed: 2026-06-06 사유: feature — #28 재활용 카드의 임시 버프 잔존 제거 (cur* reset 정합). */
            c.attachments = [];
          });
          side.deck = shuffle(reshuffleSrc);
          side.discardPile = [];
          side.gravePile = [];
          logEvent('draw-pile-reshuffle', {side: sideKey, size: side.deck.length, sources: 'discard+grave'});
        }
      }
      if(side.deck.length === 0) break;
      side.hand.push(side.deck.shift());
      drawn++;
      logEvent('draw', {side: sideKey, cardId: side.hand[side.hand.length-1].id});
    }
    return drawn;
  };

  Match._beginRound = function(roundN){
    const st = Match.state;
    if(!st || st.winner) return;

    st.round = roundN;
    /* diagnosis-confirmed: 2026-06-07 사유: feature — lifecycle first_only(일순) + combo 카운터 reset. 라운드 2 진입 시 모든 pile 의 first_only 카드 → exhaust(1라운드만 등장). _cardsPlayedThisRound 매 라운드 0 reset(메커니즘 Combo order). battle_system_decisions.md 2026-06-07. */
    if(roundN === 2){
      ['player','enemy'].forEach(sk => {
        const side = st[sk]; if(!side) return;
        side.exhaustPile = side.exhaustPile || [];
        ['deck','discardPile','dormantPile','hand','gravePile'].forEach(p => {
          if(!Array.isArray(side[p])) return;
          const keep = [];
          side[p].forEach(c => {
            if(c && Array.isArray(c.keywords) && c.keywords.indexOf('first_only') >= 0) side.exhaustPile.push(c);
            else keep.push(c);
          });
          side[p] = keep;
        });
      });
    }
    ['player','enemy'].forEach(sk => { if(st[sk]) st[sk]._cardsPlayedThisRound = 0; });
    // Plan 2.B Phase B (2026-05-12, design/battle_system_decisions.md 라운드 선공 swap 룰):
    // - roundN === 1: Match.start 의 random firstSide 그대로 유지
    // - roundN >= 2: 직전 firstSide 의 반대 (alternate)
    // - 선공권 override 효과로 직전 라운드가 강제 변경됐어도 자연스럽게 흡수 (flip 기반)
    // - side = firstSide 갱신 (카드 페이즈 시작 시 선공이 active side)
    if (roundN > 1) {
      st.firstSide = (st.firstSide === 'player') ? 'enemy' : 'player';
    }
    st.side = st.firstSide;
    st.phase = PHASE.CARD;
    // 2026-05-29 B Phase 3 — step machine ROUND_BEGIN 진입 (logEvent + future hook).
    //   ROUND_BEGIN.onEnter 가 noop (현재) — Phase 4 에서 영혼 충전 / draw 흡수 검토.
    //   호출 시점: st.side / st.phase 세팅 직후, draw/충전 직전.
    if(typeof Match._enterStep === 'function') Match._enterStep(STEP.ROUND_BEGIN, {round: roundN});
    // Task A.3: 카드 페이즈 종료 표지 reset (양측 false → 새 라운드 카드 페이즈 시작)
    if(!st.cardPhaseEnded) st.cardPhaseEnded = {player:false, enemy:false};
    st.cardPhaseEnded.player = false;
    st.cardPhaseEnded.enemy  = false;
    // 2026-05-24 §영혼력 visual feedback 룰 — 매 라운드 enemy floater push 플래그 reset
    st._aiTurnCascadePushed = false;
    // 보드 페이즈 큐도 reset (전 라운드 잔존 큐 제거)
    st.boardTurnQueue  = [];
    st.boardTurnCursor = 0;

    ['player', 'enemy'].forEach(sideKey => {
      const side = st[sideKey];
      if(!side) return;

      if(roundN > 1){
        // 1. 손패 cleanup — 2026-05-17 R3: 보존 (_persistent) 카드는 hand 유지 (StS retain 키워드).
        //    일반 카드: unit → deck (셔플 X 환원), 시그 → discard
        const persistentSurvived = [];
        while(side.hand.length > 0){
          const card = side.hand.shift();
          if(!card) continue;
          if(card._persistent === true){
            persistentSurvived.push(card);  // 영구 유지
          } else if(card.kind === 'unit'){
            side.deck.push(card);
          } else {
            side.discardPile.push(card);
          }
        }
        side.hand = persistentSurvived;

        // 2. 손패 draw (firstSide 만)
        if(sideKey === st.firstSide){
          Match._drawHandForSide(side, sideKey);
        }
      }

      // 3. 영혼력 = 영웅.SOUL 새 충전 — 2026-05-24 §턴 개념 룰 (C Hybrid):
      //    firstSide 만 충전 (turn-based mana 충전 — HS 식). 후행 측 충전은 endCardPhase 후 swap 시.
      //    옛 양측 동시 충전 → 사용자 mental model "상대도 같이 차" 인지 → 옛 룰 폐기.
      // 2026-05-29 P0 #4 — _onSoulRecharge hook 명문화 (StS2 PostEnergyRecharge 패턴).
      //   refund (전 라운드 누적) + base (hero.SOUL) → soulPool. 향후 aura / relic effect 가산 진입점.
      if(sideKey === st.firstSide){
        /* diagnosis-confirmed: 2026-06-13 사유: bug-fix — firstSide turn-begin 에서 status-tick/만료 누락 P0 fix. repro: _probe_status_tick.js 로 burn 라이브 0틱 재현 / 직접호출 정상 대조. 가설검토: (A)_tickStatusEffects 자체 버그 → 배제(직접호출 정상) (B)호출 누락 → 확정(grep+probe). 검증: status-tick-live 회귀 + probe 재실행. _onSoulRecharge → _onTurnBegin 통합. */
        Match._onTurnBegin(side, sideKey, roundN);
      }

      // 4. 보드 유닛 활성 복귀 (회색 → 색상). _acted 는 Task A.4 회색 굳음 룰에서 활용.
      side.board.forEach(u => {
        if(u && !u.isDead){
          u.exhausted = false;
          u._acted = false;
          u.attackedThisTurn = false;
        }
      });
      if(side.hero && !side.hero.isDead){
        side.hero.exhausted = false;
        side.hero._acted = false;
        side.hero.attackedThisTurn = false;
      }
    });

    logEvent('round-begin', {round: roundN, phase: PHASE.CARD});

    // 2026-05-17 매치 알림 — 라운드 시작 banner + 카드 페이즈 banner (시안 v1 정본)
    if(Array.isArray(st.events)){
      st.events.push({type: 'round-start', round: roundN, firstSide: st.firstSide});
      st.events.push({type: 'card-phase-start'});
    }

    // 2026-05-24 §턴 개념 룰 — firstSide turn banner ("내 턴" / "적 턴") push.
    //   사용자 mental model HS 식 turn-based 인지 + mana 충전 시점과 동시 발현.
    if(Array.isArray(st.events)){
      st.events.push({type: 'turn-banner', side: st.firstSide, round: roundN});
    }

    // Plan 2.D (2026-05-12) — 손패 분배 시각 swoop 트리거. UI._playEvent 가 처리.
    if(Array.isArray(st.events)){
      st.events.push({type: 'round-hand-draw', round: roundN, isFirstRound: roundN === 1});
    }
  };

  Match._endRound = function(){
    const st = Match.state;
    if(!st || st.winner) return;
    // 2026-05-29 B Phase 3 — step machine ROUND_END 진입.
    //   ROUND_END.onEnter 가 자동 _cleanupBoard 호출 (옛 보드 페이즈 잔존 dead unit 안전망).
    if(typeof Match._enterStep === 'function') Match._enterStep(STEP.ROUND_END, {round: st.round});

    // 양측 손패 → discardPile + 영혼력 0 (다음 _beginRound 가 새로 충전)
    // 🚨 _persistent:true 카드는 hand 에 보존 (사용할 때까지 영구) — 2026-05-17 사용자 명시
    ['player', 'enemy'].forEach(sideKey => {
      const side = st[sideKey];
      if(!side) return;
      const persistentSurvived = [];
      while(side.hand.length > 0){
        const c = side.hand.shift();
        /* diagnosis-confirmed: 2026-06-07 사유: feature — Ethereal(휘발) _beginRound cleanup 경로에도 적용 (라운드 잔존 손패 소멸). */
        if(c && Array.isArray(c.keywords) && c.keywords.indexOf('ethereal') >= 0){
          side.exhaustPile = side.exhaustPile || [];
          side.exhaustPile.push(c);
        } else if(c && (c._persistent === true || (c._proto && c._proto._persistent === true))){
          persistentSurvived.push(c);  // 보존
        } else if(c){
          side.discardPile.push(c);
        }
      }
      side.hand = persistentSurvived;  // 보존 카드만 hand 에 남김
      side.soulPool = 0;
    });

    /* diagnosis-confirmed: 2026-06-06 사유: feature — #28 라운드 종료 시 임시 스탯 버프 만료 (불타는 여의봉 등). 적·내 무관 전역 (사용자 명시). */
    Match._tickTempStatBuffs();

    logEvent('round-end', {round: st.round || 1});

    /* diagnosis-confirmed: 2026-06-14 사유: bug-fix — 기절(stun) 소비를 라운드 끝으로 (enforcement, project_stun_dead_mechanic, Workflow 진단 wauace4zn).
       board phase 동안 _stunTurns>0 유지(시각 표시)하고, 막힌 라운드가 끝나는 이 시점에 1 감소.
       _tickStatusEffects 의 옛 turn-begin 감소를 대체 — turns=1 = board phase 1회 차단, turns=2 = 2라운드. */
    ['player', 'enemy'].forEach(sideKey => {
      const side = st[sideKey];
      if(!side) return;
      [side.hero, ...(side.board || [])].forEach(u => {
        if(u && !u.isDead && u._stunTurns && u._stunTurns > 0){
          u._stunTurns -= 1;
          if(u._stunTurns <= 0){ u._stunTurns = 0; logEvent('stun-end', {targetUid: u.uid}); }
        }
      });
    });

    // 다음 라운드 자동 시작
    Match._beginRound((st.round || 1) + 1);

    // 2026-05-23 fix (sim_ai_stuck) — round 전환 후 UI 알림 필요 (AI 자동 호출 setTimeout 트리거).
    // 2026-05-28 cascade C7 정정 — 옛 UI.renderState() 직접 호출은 마지막 cursor cascade events
    //   (hero-levelup / unit-levelup) 처리 전 DOM 재구성 → 사용자 인지 "다음 라운드 visual 후 cascade".
    //   해결: events 큐 처리만 트리거 (renderState X) → cascade events 가 cardEl 옛 DOM 에 정상 attach
    //   → _processEvents 끝 (61_match_ui.js:380-383) 의 자동 _cleanupBoard + renderState 가 다음 라운드 visual 처리.
    //   _processEvents 가 _processingEvents=true 면 즉시 return (재진입 차단) — 안전.
    //   회귀 환경 (vm) 은 Match.UI._processEvents 정의 X → typeof guard 로 안전 skip.
    if(Match.UI && typeof Match.UI._processEvents === 'function'){
      try { Match.UI._processEvents(); } catch(e){}
    }
  };

  // ───────── Task A.3 — 카드 페이즈 / 보드 페이즈 분리 (B 점진 마이그레이션, 2026-05-10) ─────────
  // 옛 endTurn / _resumeTurn / _beginTurn 은 alias 로 보존 — 회귀 호환.
  // UI 가 신규 메서드 채택 시 phase 룰 작동. Task C.6 cleanup 시점에 옛 흐름 폐기 검토.
  // 정본: design/battle_system_decisions.md 2026-05-10 라운드 구조 섹션.

  // 자기 진영 카드 페이즈 종료. 양측 종료 시 보드 페이즈로 자동 전환.
  Match.endCardPhase = function(sideKey){
    const st = Match.state;
    if(!st || st.winner) return {ok:false, reason:'매치 종료'};
    if(sideKey !== 'player' && sideKey !== 'enemy') return {ok:false, reason:'unknown side: ' + sideKey};
    if(st.phase !== PHASE.CARD) return {ok:false, reason:'카드 페이즈 아님 (현재: ' + st.phase + ')'};
    if(!st.cardPhaseEnded) st.cardPhaseEnded = {player:false, enemy:false};
    st.cardPhaseEnded[sideKey] = true;
    logEvent('card-phase-end', {side: sideKey});
    // 2026-05-17 B7 fix — 후행 측 draw 트리거 (사용자 명시 "내턴 시작 시 손패 5장")
    // firstSide 가 endCardPhase 호출하면 → 후행 측 (반대 side) 손패 draw + soul-recharge-flash
    // 회귀가 endCardPhase 양측 차례로 호출하는 패턴이라 자연스럽게 양측 손패 draw 됨.
    if(!st.cardPhaseEnded.player || !st.cardPhaseEnded.enemy){
      const nextSide = sideKey === 'player' ? 'enemy' : 'player';
      const nextSideObj = st[nextSide];
      // 2026-05-17 R3 — 보존 카드 제외한 정상 카드 0장일 때만 draw (보존 카드 도입 fix).
      // 옛 조건 `length === 0` 은 보존 카드 1장 있으면 false → 후행측 draw skip → 사용자 "손패 1장만" 보고.
      const normalCount = nextSideObj
        ? (nextSideObj.hand || []).filter(c => !(c && c._persistent === true)).length
        : 0;
      if(nextSideObj){
        // 2026-05-24 §턴 개념 + mana 충전 룰 (C Hybrid):
        //   후행 측 turn 시작 = endCardPhase 후 swap 시점 (사용자 mental model "내 턴 시 내가 차").
        //   draw 는 손패 비어있을 때만 (옛 R3 fix 유지) — 일반 R2+ 흐름.
        //   side swap + 충전은 항상 (R1 의 hand 5 잔존 케이스도 정합 — 옛 normalCount === 0 분기 안 swap 일어났던 버그 fix).
        if(normalCount === 0){
          Match._drawHandForSide(nextSideObj, nextSide);
        }
        st.side = nextSide;
        // 2026-05-29 P0 #4 — 후행 측 충전도 _onSoulRecharge hook 사용 (정합).
        //   옛 직접 대입 폐기. refund 처리 + visual flash 통합.
        /* diagnosis-confirmed: 2026-06-13 사유: bug-fix — secondSide turn-begin 에서 status-tick/만료 누락 P0 fix (firstSide 와 대칭). _onSoulRecharge → _onTurnBegin 통합. repro/검증 동일(_probe_status_tick.js). */
        Match._onTurnBegin(nextSideObj, nextSide, st.round);
        // 2026-05-24 §턴 개념 룰 — 후행 측 turn banner push ("내 턴" / "적 턴")
        if(Array.isArray(st.events)){
          st.events.push({type: 'turn-banner', side: nextSide});
        }
      }
    }
    if(st.cardPhaseEnded.player && st.cardPhaseEnded.enemy){
      // 2026-05-29 B Phase 4 — step machine CARD_END 진입 → 곧 _beginBoardPhase 가 BOARD_BEGIN 진입.
      if(typeof Match._enterStep === 'function') Match._enterStep(STEP.CARD_END, {});
      Match._beginBoardPhase();
      return {ok:true, transitioned:true};
    }
    return {ok:true, transitioned:false};
  };

  // 보드 페이즈 진입 — 양측 보드 유닛 + 영웅을 boardTurnQueue 에 적재 (선공 측 우선 번갈아).
  // Task A.4 가 본격 알고리즘 (회색 굳음 + 행동 후 _acted=true). 이번엔 stub.
  Match._beginBoardPhase = function(){
    const st = Match.state;
    if(!st || st.winner) return;
    st.phase = PHASE.BOARD;
    // 2026-05-29 B Phase 3 — step machine BOARD_BEGIN 진입.
    //   BOARD_ACTION 은 cursor 첫 진입 시점 (line 940 부근 boardTurnCursor 세팅 후) 별도 _enterStep.
    if(typeof Match._enterStep === 'function') Match._enterStep(STEP.BOARD_BEGIN, {});

    // 2026-05-15 Fix — 보드 페이즈 진입 시 양측 모든 unit + hero 의 소환 멀미(exhausted) reset.
    // 옛 흐름: _beginTurn 이 자기 side 보드만 reset → 보드 페이즈는 큐 cursor 가 양측 alternate 라
    //   exhausted=true 인 unit 의 attack 시 Match.attack 실패 → _takeBoardTurn break → 진행 X.
    // 사용자 mental model: "라운드페이즈 때만 보드유닛 깔수 있어 → 이후 보드턴 진입 보드 유닛 1개 행동"
    //   즉 보드 페이즈에 깐 모든 unit 은 행동 가능해야 함.
    // 정본: design/changelog.md 2026-05-15 board phase exhausted reset.
    ['player', 'enemy'].forEach(sideKey => {
      const side = st[sideKey];
      if(!side) return;
      (side.board || []).forEach(u => {
        if(u && !u.isDead){
          u.exhausted = false;
          u.attackedThisTurn = false;
        }
      });
      if(side.hero && !side.hero.isDead){
        side.hero.exhausted = false;
        side.hero.attackedThisTurn = false;
      }
    });

    const first  = st.firstSide || (st.side === 'player' ? 'player' : 'enemy');
    const second = first === 'player' ? 'enemy' : 'player';
    /* diagnosis-confirmed: 2026-06-14 사유: bug-fix — 기절(stun) enforcement (project_stun_dead_mechanic).
       repro: stun op/synergy 가 _stunTurns 세팅만 하고 board 에서 안 읽혀 연출만(dead mechanic, line 609 자인).
       hypo: (A)Match.attack 단독 enforcement → 배제(타이밍 결함: endCardPhase→_onTurnBegin 의 _tickStatusEffects 가
       board phase 前에 _stunTurns 1→0 감소 → 도달 시 항상 0). (B)board 큐 빌드 시 제외+_acted=true → 채택.
       이 방식은 stun 유닛 차례 자체가 안 와서 첫차례/AI deadlock/wrap 무한루프 엣지를 전부 회피하고,
       XP 자동 0(_advanceBoardTurn 의 actedUnit/cursor entry 가 아님) + UI 자동 차단(canAttack/onUnitClick 의 _acted 검사 재사용).
       _stunTurns 소비는 _endRound (board phase 동안 _stunTurns>0 유지 = 시각 표시), tick 감소는 제거(double-decrement 방지).
       demo: match-stun-* 회귀 + Playwright board 큐 제외/XP0/무한루프0 측정. */
    const collect = sideKey => {
      const side = st[sideKey];
      if(!side) return [];
      const candidates = (side.board || []).filter(u => u && !u.isDead && !u._acted);
      if(side.hero && !side.hero.isDead && !side.hero._acted) candidates.push(side.hero);
      const acting = [];
      candidates.forEach(u => {
        if(u._stunTurns && u._stunTurns > 0){
          // 기절 — 이번 보드 페이즈 행동 차단(큐 제외). _acted=true 로 cursor 루프·UI 입력 자동 제외, XP 없음.
          u._acted = true;
          logEvent('stun-skip', {targetUid: u.uid, remaining: u._stunTurns, side: sideKey});
          if(Array.isArray(st.events)) st.events.push({type:'stun-skip', side: sideKey, targetUid: u.uid});
          return;
        }
        acting.push(u);
      });
      return acting.map(u => ({sideKey, unitUid: u.uid}));
    };
    const fQueue = collect(first);
    const sQueue = collect(second);
    st.boardTurnQueue = [];

    // Plan 2.D (2026-05-12, 사용자 명시 보드 턴 분배 공식):
    // - minN 번 alternate (F1, S1, F2, S2, ..., F_minN, S_minN) — 선공 측 우선
    // - 남은 측 (maxN - minN) entry 가 마지막에 묶음 (한 turn 에 시각 표현 grouped 마커)
    // 예 P=3, E=5: alternate F1,S1,F2,S2,F3,S3 → 남은 E [S4,S5] 묶음 (마지막 1 turn 에 2 명)
    const minN = Math.min(fQueue.length, sQueue.length);
    for(let i=0; i<minN; i++){
      st.boardTurnQueue.push(fQueue[i]);
      st.boardTurnQueue.push(sQueue[i]);
    }
    // 남은 측 — 첫 entry 부터 _grouped 마커 (마지막 묶음 시각 표지)
    const leftover = fQueue.length > minN ? fQueue.slice(minN) : sQueue.slice(minN);
    leftover.forEach((entry, idx) => {
      const e = Object.assign({}, entry);
      if(idx === 0) e._groupStart = true;  // 묶음 시작 마커
      if(leftover.length > 1) e._grouped = true;  // 2명 이상이면 묶음
      st.boardTurnQueue.push(e);
    });

    st.boardTurnCursor = 0;
    // 2026-05-23 fix — board phase 진입 시 side 를 cursor[0].sideKey 로 sync.
    //   sim_ai_stuck.js 재현: card phase 끝 시점 side 가 큐 첫 entry 와 mismatch 가능 →
    //   사용자 차례 인지 못함 (data-side 가 wrong → glow 안 보임) + 시뮬 가속 endTurnUI 트리거 X → stuck.
    //   기존 P0-2 fix (_advanceBoardTurn) 는 cursor++ 진행 시만 sync — 첫 cursor 진입은 누락이었음.
    if(st.boardTurnQueue[0] && st.boardTurnQueue[0].sideKey){
      st.side = st.boardTurnQueue[0].sideKey;
    }
    logEvent('board-phase-begin', {firstSide: first, queueSize: st.boardTurnQueue.length, minN, leftover: leftover.length});

    // 2026-05-17 매치 알림 — 보드 페이즈 banner (시안 v1 정본)
    if(Array.isArray(st.events)){
      st.events.push({type: 'board-phase-start'});
    }

    // 양측 보드 비어있으면 즉시 라운드 종료
    if(st.boardTurnQueue.length === 0){
      Match._endRound();
      return;
    }

    // 2026-05-29 B Phase 4 — step machine BOARD_ACTION 진입 (cursor 첫 entry 행동 시작).
    //   BOARD_BEGIN → BOARD_ACTION 자동 진행 (queue 정합 + cursor 세팅 완료 후).
    if(typeof Match._enterStep === 'function') Match._enterStep(STEP.BOARD_ACTION, {cursor: 0});

    // UI 통합 cluster (2026-05-11) — 첫 entry 가 enemy 차례면 자동 AI takeTurn.
    // 회귀가 manual control 원하면 setup 에서 `M._afterBoardTurn = ()=>{};` override.
    if(st.boardTurnQueue[0] && st.boardTurnQueue[0].sideKey === 'enemy'){
      Match._afterBoardTurn(st.boardTurnQueue[0]);
    }
  };

  // Task A.4 (2026-05-10) — 보드턴 1개 진행 (본격).
  // cursor++ 진행, 사망/이미 _acted unit 자동 skip. queue 끝 도달 시 _endRound.
  // UI/AI/회귀가 unit 행동 후 호출. 행동 자체는 Match.attack 가 _acted=true 세팅.
  Match._advanceBoardTurn = function(actedUnit, actedSideKey){
    const st = Match.state;
    if(!st || st.winner) return {ok:false, reason:'매치 종료'};
    if(st.phase !== PHASE.BOARD) return {ok:false, reason:'보드 페이즈 아님'};
    if(!Array.isArray(st.boardTurnQueue)) st.boardTurnQueue = [];

    /* diagnosis-confirmed: 2026-06-07 사유: bug-fix — "보드유닛이 공격했는데 영웅이 레벨업" (사용자 보고). 옛 코드는 XP 를 "현재 cursor 가 가리키는 entry 의 unit" 에 부여했는데, Match.attack(2557~) 이 cursor 와 무관한 자유 클릭 공격을 허용(#19-3)하므로 행동 주체(attacker)와 cursor unit 이 어긋나면 XP 가 엉뚱한 unit 에 감. 시뮬 _sim_levelbug.js 로 2회 재현. fix(옵션1): XP 를 행동 발생 지점에 귀속 — attack 경유는 actedUnit(attacker) 인자로 직접 부여, 인자 없는 호출(_endTurnFlow skip / 타이머 / AI 안전망 / 회귀)은 cursor entry unit = 차례 넘기는 주체에 부여. 회귀 match-board-cursor-xp-v6(skip) 유지 + match-board-freeclick-xp-v6(자유클릭) 신규. */
    let xpUnit = null, xpSide = null;
    if(actedUnit && !actedUnit.isDead){
      // attack 경유 — 실제로 행동한 유닛에게 (자유 클릭으로 cursor 와 달라도 정확)
      xpUnit = actedUnit;
      xpSide = (actedSideKey && st[actedSideKey]) || st[_findOwnerSide(actedUnit.uid)] || null;
    } else {
      // skip / 타이머 / 안전망 — cursor entry 의 unit (= 차례를 넘기는 주체)
      const prevCursor = (st.boardTurnCursor || 0);
      const prevEntry  = st.boardTurnQueue[prevCursor];
      if(prevEntry){
        const prevSide = st[prevEntry.sideKey];
        const prevUnit = (prevSide && prevSide.hero && prevSide.hero.uid === prevEntry.unitUid)
          ? prevSide.hero
          : (prevSide && (prevSide.board || []).find(u => u && u.uid === prevEntry.unitUid));
        if(prevUnit && !prevUnit.isDead){ xpUnit = prevUnit; xpSide = prevSide; }
      }
    }
    if(xpUnit && xpSide && !xpUnit.isDead){
      try { _grantBoardCursorExp(xpSide, xpUnit); }
      catch(e){ logEvent('grant-xp-error', {error: String(e && e.message), unitUid: xpUnit.uid}); }
    }

    // cursor++ + 사망/이미 행동 unit 자동 skip
    let cursor = (st.boardTurnCursor || 0) + 1;
    while(cursor < st.boardTurnQueue.length){
      const entry = st.boardTurnQueue[cursor];
      const side = entry && st[entry.sideKey];
      if(!side){ cursor += 1; continue; }
      const unit = (side.hero && side.hero.uid === entry.unitUid)
        ? side.hero
        : (side.board || []).find(u => u && u.uid === entry.unitUid);
      if(unit && !unit.isDead && !unit._acted) break;  // 다음 차례 unit 발견
      cursor += 1;
    }
    // 2026-05-30 #19-4 (사용자 보고 "내턴 1개 남았는데 강제 종료") — wrap-around.
    //   원인: 사용자 cursor 외 unit 자유 attack (#19-3) 후 옛 cursor 자리 unit 의 _acted=false 인데
    //   cursor 가 그 자리 지나감 → 영원히 차례 X.
    //   Fix: cursor queue.length 도달 시 처음부터 prevCursor 까지 다시 검색.
    //   진짜 _acted=false unit 없으면 _endRound.
    //   회귀 호환: 모든 unit 이 _acted=false 인 경우 (회귀 _advanceBoardTurn 만 호출 케이스) 는
    //   cursor++ 로 자연 진행 → queue.length 도달 시 wrap 검색 → prevCursor 이전 _acted=false 있으면 이동.
    //   회귀 시뮬은 prevCursor 가 queue.length-1 까지 도달 → cursor=queue.length → wrap → 0..prevCursor (queue 전체) 모두 _acted=false →
    //   결국 wrap 도 _acted=false 발견 → 무한 루프 가능 → 회귀에서 safety break.
    //   해결: wrap 안 함. 옛 룰 그대로 _endRound. 실 game 에서는 Match.attack 호출 후 자동 cursor 진행 (옛 cursor++) → wrap 불필요.
    //   사용자 보고 진짜 원인: 사용자가 cursor 외 unit attack 후 옛 cursor 가 진행 = 그 자리 unit 영원히 차례 X.
    //   진짜 fix는 별도 — Match.attack 의 phase=board 분기에서 attacker 의 entry 자리로 cursor 이동 후 진행.
    st.boardTurnCursor = cursor;

    if(cursor >= st.boardTurnQueue.length){
      // wrap-around 검색 (옛 cursor 이전 entry 중 _acted=false unit 있으면 그 자리 이동)
      let wrapCursor = -1;
      for(let i = 0; i < (st.boardTurnCursor || 0); i++){
        const entry = st.boardTurnQueue[i];
        const side = entry && st[entry.sideKey];
        if(!side) continue;
        const unit = (side.hero && side.hero.uid === entry.unitUid)
          ? side.hero
          : (side.board || []).find(u => u && u.uid === entry.unitUid);
        if(unit && !unit.isDead && !unit._acted){
          wrapCursor = i;
          break;
        }
      }
      if(wrapCursor >= 0){
        cursor = wrapCursor;
        st.boardTurnCursor = cursor;
        // wrap 발견 — 진행 (다음 if block 의 _endRound 안 함)
      } else {
        Match._endRound();
        return {ok:true, ended:true};
      }
    }
    const next = st.boardTurnQueue[cursor];
    // P0-2 fix (2026-05-16): board phase 큐 cursor 진행 시 st.side 도 cursor.sideKey 로 동기화.
    // 옛 흐름: st.side 가 endTurn flip 만 갱신 → board phase cursor 가 player 인데 st.side='enemy' 잔존 →
    //   UI data-side 가 wrong → 자기 차례 unit glow 안 보임 → 사용자 "1유닛 후 멈춤" 인지.
    const sideChanged = (next.sideKey && next.sideKey !== st.side);
    if(sideChanged){
      st.side = next.sideKey;
      // 2026-05-17 매치 알림 — 보드 페이즈 차례 변경 banner
      if(Array.isArray(st.events)){
        st.events.push({type: 'turn-side-change', side: next.sideKey, phase: 'board'});
      }
    }
    logEvent('board-turn-advance', {cursor, side: next.sideKey, unitUid: next.unitUid});

    // UI 통합 cluster (2026-05-11) — 보드턴 1개 진행 후 hook 호출.
    // default 행동: 다음 차례가 enemy 면 자동 AI takeTurn (사용자 매치 진행 시 visible).
    // 회귀가 manual control 원하면 setup 에서 `M._afterBoardTurn = ()=>{};` override.
    Match._afterBoardTurn(next);
    return {ok:true, ended:false, current: next};
  };

  // UI 통합 cluster (2026-05-11) — 보드턴 진행 후 외부 hook (override 가능).
  // default: 다음 차례가 enemy 측이면 Match.AI.takeTurn 자동 호출 (사용자 매치 시각 컨펌).
  // _takeBoardTurn 의 while 루프 내부 호출은 `Match.AI._inLoop` 플래그로 무한 재귀 차단.
  // 회귀가 noop override 시 default 잃지 않도록 _defaultAfterBoardTurn 별도 노출.
  Match._defaultAfterBoardTurn = function(currentEntry){
    const st = Match.state;
    if(!st || st.winner) return;
    if(st.phase !== PHASE.BOARD) return;
    if(Match.AI && Match.AI._inLoop) return;  // _takeBoardTurn while 내부 재진입 차단
    /* diagnosis-confirmed: 2026-06-13 — Option A: UI 디퍼 모드(_deferBoardAI)면 동기 적턴 skip → UI._processEvents 끝 driver 가 player 애니 완료 후 구동(순서역전 fix). 직접 Match.start(회귀)는 플래그 false → 동기 유지, 영향 0. */
    if(Match._deferBoardAI) return;
    const entry = currentEntry || (st.boardTurnQueue || [])[st.boardTurnCursor | 0];
    if(entry && entry.sideKey === 'enemy' && Match.AI && Match.AI.takeTurn){
      Match.AI.takeTurn();
    }
  };
  Match._afterBoardTurn = Match._defaultAfterBoardTurn;

  // 매 턴 시작 시 자기 진영 unit/hero 의 상태 효과 처리 (Phase E-2.6, 2026-05-06)
  /* diagnosis-confirmed: 2026-06-15 사유: feature — 전기 카운터 메커니즘 (race_synergy §4). _debuffWarded = 마법방어막(_wardCharges) 다음 디버프 1회 무효(stun/burn 적용 전 체크) / _dispelDebuffs = 마법해제(아군 stun·burn 제거). 카운터 스킬 카드(추후 아트)가 ward/dispel op 으로 호출. */
  Match._debuffWarded = function(target){
    if(target && target._wardCharges && target._wardCharges > 0){
      target._wardCharges -= 1;
      logEvent('ward-block', {targetUid: target.uid, wardLeft: target._wardCharges});
      return true;  // 무효됨
    }
    return false;
  };
  Match._dispelDebuffs = function(target){
    if(!target) return [];
    const cleared = [];
    if(target._stunTurns && target._stunTurns > 0){ target._stunTurns = 0; cleared.push('stun'); }
    if(target._burnTurns && target._burnTurns > 0){ target._burnTurns = 0; target._burnAmount = 0; target._burnElement = null; cleared.push('burn'); }
    if(cleared.length) logEvent('dispel', {targetUid: target.uid, cleared});
    return cleared;
  };

  Match._tickStatusEffects = function(side){
    if(!side) return;
    const targets = [side.hero, ...(side.board || [])].filter(t => t && !t.isDead);
    targets.forEach(t => {
      // burn — 매 턴 _burnAmount 데미지 + _burnTurns -= 1
      if(t._burnTurns && t._burnTurns > 0 && t._burnAmount && t._burnAmount > 0){
        const burnDmg = t._burnAmount;
        /* diagnosis-confirmed: 2026-06-04 사유: feature — DOT tick 에 element 전파 (암흑저주 연출 분기용) */
        Match._damage(t, burnDmg, {_pierceDef: true, dotElement: t._burnElement});  // 지속 DOT 은 DEF 우회 (화상/암흑 잠식 공통)
        logEvent('burn-tick', {targetUid: t.uid, dmg: burnDmg, turnsLeft: t._burnTurns - 1, element: t._burnElement || 'fire'});
        t._burnTurns -= 1;
        if(t._burnTurns <= 0){ t._burnTurns = 0; t._burnAmount = 0; t._burnElement = null; }
      }
      // tick_heal — 매 턴 _tickHealAmount 회복 (지속, 부착 만료 시 회수는 _tickTimedAttachments)
      if(t._tickHealAmount && t._tickHealAmount > 0){
        const healAmt = t._tickHealAmount;
        const cap = t.maxHP || t.HP || (t.curHP + healAmt);
        const before = t.curHP;
        t.curHP = Math.min(cap, t.curHP + healAmt);
        if(t.curHP > before) logEvent('tick-heal', {targetUid: t.uid, amount: t.curHP - before, hp: t.curHP});
      }
      /* diagnosis-confirmed: 2026-06-15 사유: feature — 신성 6단계 물리무적 / 암흑 흡혈부여 지속 turn 감소 (소유 진영 턴마다 -1 → 상대 턴 동안 유지 = "1라운드"). */
      if(t._physImmuneTurns && t._physImmuneTurns > 0){
        t._physImmuneTurns -= 1;
        if(t._physImmuneTurns <= 0){ t._physImmuneTurns = 0; logEvent('phys-immune-end', {targetUid: t.uid}); }
      }
      if(t._synLifestealTurns && t._synLifestealTurns > 0){
        t._synLifestealTurns -= 1;
        if(t._synLifestealTurns <= 0){ t._synLifestealTurns = 0; t._synLifesteal = 0; logEvent('lifesteal-grant-end', {targetUid: t.uid}); }
      }
      /* diagnosis-confirmed: 2026-06-14 사유: bug-fix — stun 감소 위치 이전 (project_stun_dead_mechanic, Workflow 진단 wauace4zn 확정). */
      // stun 감소는 여기서 안 함 (2026-06-14 enforcement).
      //   옛 turn-begin 감소는 endCardPhase→_onTurnBegin 이 board phase 前에 _stunTurns 1→0 시켜
      //   enforcement 를 무효화하던 타이밍 결함 → 제거. 차단은 _beginBoardPhase 큐 제외(+_acted),
      //   소비(-=1)는 _endRound 가 단일 처리 (double-decrement 방지).
      // stealth — 2026-05-18 사용자 결정 1회 회피 일원화. 라운드 N턴 만료 룰 폐기.
      // (Match.attack 의 stealth 분기가 회피 발동 시 즉시 keywords 제거 + _stealthTurns=0 처리)
      // attach_marker (대상에 부착된 추가 피해 마커) — _markerTurns -=1, 0 도달 시 제거
      if(t._markerTurns && t._markerTurns > 0){
        t._markerTurns -= 1;
        if(t._markerTurns <= 0){
          t._markerTurns = 0;
          t._markerBonusDmg = 0;
          logEvent('marker-end', {targetUid: t.uid});
        }
      }
    });
  };

  // 카드 드로우 — 손패 한도 초과는 소각
  Match._draw = function(sideKey, n){
    const st = Match.state;
    const side = st[sideKey];
    for(let i=0; i<n; i++){
      if(side.deck.length === 0){
        logEvent('deck-empty', {side: sideKey});
        // 덱 소진 페널티는 추후 — 지금은 그냥 패스
        continue;
      }
      const card = side.deck.shift();
      if(side.hand.length >= HAND_MAX){
        logEvent('hand-burn', {side: sideKey, cardId: card.id});
        continue;
      }
      side.hand.push(card);
      logEvent('draw', {side: sideKey, cardId: card.id});
    }
  };

  // ───────── 턴 종료 ─────────
  // Plan 2.C Phase I (2026-05-12, design/battle_system_decisions.md):
  // 옛 PHASE 6 "endTurn → +1 XP" 룰 폐기. 신 트리거:
  //  - 카드 페이즈 시그니처 사용 → owner XP +1 (Phase I-2, playCard 내부)
  //  - 보드 페이즈 행동 (공격/스킬) → 공격자 XP +1 (Phase I-3, attack/_damage 내부)
  // pendingLevelUp 모달 흐름도 폐기 (Phase J 자동 적용).
  Match.endTurn = function(){
    const st = Match.state;
    if(!st || st.winner) return {ok:false, reason:'매치 종료'};

    Match._resumeTurn();
    return {ok:true};
  };

  // 사이드 전환 + 다음 턴 시작 (endTurn 또는 applyLevelUpChoice 에서 호출)
  Match._resumeTurn = function(){
    const st = Match.state;
    if(!st || st.winner) return;

    logEvent('turn-end', {side: st.side, turn: st.turn});

    // 사이드 전환
    if(st.side === 'player'){
      st.side = 'enemy';
    } else {
      st.side = 'player';
      st.turn += 1;
    }

    // 2026-05-15 안전망 — phase=BOARD 면 side 를 cursor.sideKey 로 강제 sync.
    // 옛 endTurn flip (player ↔ enemy) 과 새 phase 룰 (cursor 기반) 양립으로
    // side ≠ cursor.sideKey deadlock 발생 가능 (endTurnUI fix 외 다른 경로 보호).
    if(st.phase === PHASE.BOARD && Array.isArray(st.boardTurnQueue)){
      const cursorEntry = st.boardTurnQueue[st.boardTurnCursor | 0];
      if(cursorEntry && cursorEntry.sideKey && cursorEntry.sideKey !== st.side){
        st.side = cursorEntry.sideKey;
      }
    }

    Match._beginTurn();

    // 적 턴이면 AI 호출. 2026-05-24 — state.aiTurnDelayMs > 0 면 setTimeout 지연 (UI 하스스톤 패턴 2~3초).
    //   회귀 = 0 전달 시 즉시 호출 (동기 state 검증 보장).
    //   보드 페이즈 _afterBoardTurn 의 AI 자동 호출은 별도 경로 — 즉시 유지 (cursor 빠른 진행).
    if(st.side === 'enemy' && !st.winner && Match.AI){
      const d = (st.aiTurnDelayMs | 0);
      if(d > 0 && typeof setTimeout === 'function'){
        setTimeout(() => {
          if(Match.state && Match.state.side === 'enemy' && !Match.state.winner) Match.AI.takeTurn();
        }, d);
      } else {
        Match.AI.takeTurn();
      }
    }
  };

  /* diagnosis-confirmed: 2026-06-02 사유: refactor (이중 flip 책임 통합 — trace 재현 + 가설 A/B 확정 + plan 승인 완료) */
  // 2026-06-02 — 턴 종료 단일 진입점 (옵션 B 리팩터, plan linear-purring-sunset).
  //   문제: endCardPhase(swap) + endTurn(_resumeTurn flip) 둘 다 st.side 를 만져서
  //     card phase 에서 연달아 부르면 player→enemy→player 상쇄 → 정체.
  //     그래서 호출자가 sideBefore 방어를 3곳(enemy AI / endTurnUI / sim)에 복붙 → drift 버그.
  //   해결: side 전환 책임을 이 한 함수에 통합. 호출자는 이것만 부름.
  //   순수 코어 — UI 렌더/타이머/레벨업 모달은 절대 여기 넣지 않음 (호출자 레이어가 반환값 보고 처리).
  //   저수준 endCardPhase / endTurn(_resumeTurn) 은 빌딩블록으로 보존 (회귀 호환).
  // 반환: {ok, swapped?, pendingLevelUp?, skipped?, noop?}
  Match._endTurnFlow = function(sideKey){
    const st = Match.state;
    if(!st || st.winner) return {ok:false, reason:'매치 종료'};
    if(sideKey !== 'player' && sideKey !== 'enemy') return {ok:false, reason:'unknown side: ' + sideKey};

    // ── CARD phase: endCardPhase + (swap 안 했으면만) _resumeTurn ──
    if(st.phase === PHASE.CARD){
      const sideBefore = st.side;
      Match.endCardPhase(sideKey);
      if(st.phase === PHASE.CARD && st.side === sideBefore && !st.winner){
        // endCardPhase 가 swap 안 함 → 옛 flip (회귀 호환). _resumeTurn 끝에서 enemy면 AI 자동호출(1262-1271).
        Match._resumeTurn();
      } else if(st.phase === PHASE.CARD && st.side === 'enemy' && !st.winner && Match.AI && Match.AI.takeTurn){
        // endCardPhase 가 player→enemy swap 함 → AI 직접 호출 (옛 flip 중복 X). 현 endTurnUI 3462-3464 미러.
        Match.AI.takeTurn();
      }
      // swap 으로 player 가 된 경우(enemy 가 호출): AI 호출 안 함 (player 차례 — 메인 루프/UI 입력 대기).
      return {ok:true, swapped:(st.side !== sideBefore), pendingLevelUp: !!st.pendingLevelUp};
    }

    // ── BOARD phase: 내 cursor 차례 unit skip (_acted=true + cursor 진행). 아니면 no-op. ──
    if(st.phase === PHASE.BOARD){
      const cursor = (st.boardTurnQueue || [])[st.boardTurnCursor | 0];
      if(cursor && cursor.sideKey === sideKey){
        const side = st[sideKey];
        const unit = (side.hero && side.hero.uid === cursor.unitUid)
          ? side.hero
          : (side.board || []).find(u => u && u.uid === cursor.unitUid);
        if(unit && !unit.isDead){
          unit._acted = true;
          unit.attackedThisTurn = true;
        }
        Match._advanceBoardTurn();
        return {ok:true, skipped:true};
      }
      return {ok:true, noop:true};  // 내 cursor 차례 아님 (적 차례 — AI 진행 중)
    }

    return {ok:false, reason:'unknown phase: ' + st.phase};
  };

  // ⚠️ DEPRECATED (Plan 2.C Phase J, 2026-05-12, design/battle_system_decisions.md:154):
  // 옛 3선택지 모달 흐름 폐기 (atk/soul/hp). 신 룰: 2 XP 도달 시 자동 레벨업 + 등급별 차등 보상.
  // 호환 noop — UI/AI 의 옛 호출은 무력화 (fail/return 영향 없음).
  Match.applyLevelUpChoice = function(sideKey, choice){
    return {ok:true, deprecated:true, info:'Phase J 자동 적용으로 폐기 — _autoHeroLevelUpCheck 가 처리'};
  };

  // ───────── 카드 사용 ─────────
  // sideKey: 'player' | 'enemy'
  // handIdx: 손패 인덱스
  // opts: {targetSide?, targetUid?, slotIdx?}
  Match.playCard = function(sideKey, handIdx, opts){
    const st = Match.state;
    if(!st || st.winner) return {ok:false, reason:'매치 종료'};
    if(st.side !== sideKey) return {ok:false, reason:'내 턴 아님'};
    // 2026-05-29 — 적턴 정의 확장 (#23): events 큐 처리 중 race window 차단은 UI _validateHandClick 단독 책임.
    // 코어 안전망 시도 → 회귀 환경 (UI 미사용) 에서 events 큐 안 비워져 무한 차단 → 회귀 10건 fail.
    // 실 게임 경로는 UI 만 통과 → 코어 안전망 불필요.
    const side = st[sideKey];
    const card = side.hand[handIdx];
    if(!card) return {ok:false, reason:'손패 인덱스 잘못됨'};

    const check = canPlay(side, card);
    if(!check.ok) return check;

    if(VALID_KINDS.indexOf(card.kind) < 0){
      return {ok:false, reason:'알 수 없는 kind: ' + card.kind};
    }

    // 발화 강화 — 다음 화염 스펠 1개 강화 (상위 교체 or x2). 이번 cast 1회만 effects/NEED_SOUL 임시 swap.
    //   덱에 남는 원본 카드 보존 위해 _fireUpBackup 보관 → dispatch 후 복원 (단일 return 직전).
    const _fireUp = Match._computeFireUpgrade(side, card);
    // cast 시각용 카드 — replace 모드면 좌측 cast / 중앙 fly 시각을 업화구로 (효과는 아래 swap, 원본 hand 카드는 보존).
    let _castVisualCard = card;
    if(_fireUp){
      side._fireUpgradePending = false;  // 1회 소비 (감당 가능 확인 후)
      card._fireUpBackup = {NEED_SOUL: card.NEED_SOUL, effects: card.effects};
      card.NEED_SOUL = _fireUp.needSoul;
      card.effects = _fireUp.effects;
      if(_fireUp.mode === 'replace' && _fireUp.upId){
        const upSkill = (RoF.Data.SKILLS || []).find(s => s.id === _fireUp.upId);
        if(upSkill) _castVisualCard = Object.assign({}, upSkill, {uid: card.uid});
      }
      logEvent('fire-upgrade-cast', {side: sideKey, base: card.id, mode: _fireUp.mode, upId: _fireUp.upId, needSoul: _fireUp.needSoul});
    }

    // 영혼 차감 + 손패 제거 (next_card_discount 우선 소모)
    let needCost = card.NEED_SOUL || 0;
    if(side._nextDiscount && _nextCardFilterMatch(side._nextDiscount.filter, card)){
      const disc = Math.min(side._nextDiscount.amount, needCost);
      needCost -= disc;
      logEvent('discount-apply', {side: sideKey, cardId: card.id, discount: disc, finalCost: needCost});
      side._nextDiscount = null;  // 1회성
    }
    side.soulPool -= needCost;
    side.hand.splice(handIdx, 1);
    logEvent('play-card', {side: sideKey, cardId: card.id, kind: card.kind, soulRemain: side.soulPool});

    /* diagnosis-confirmed: 2026-06-07 사유: feature — 메커니즘 Combo(연계). 라운드 N번째로 낸 카드면 combo.bonus effects 추가 발동. _cardsPlayedThisRound 는 _beginRound 에서 0 reset. battle_system_decisions.md 2026-06-07 B-3. */
    side._cardsPlayedThisRound = (side._cardsPlayedThisRound || 0) + 1;
    if(card.combo && card.combo.order && side._cardsPlayedThisRound === card.combo.order && Array.isArray(card.combo.bonus) && card.combo.bonus.length){
      Match._applyEffects({effects: card.combo.bonus, kind: card.kind, keywords: []}, {side, opts, sourceSideKey: sideKey});
      logEvent('combo-trigger', {side: sideKey, cardId: card.id, order: card.combo.order, count: side._cardsPlayedThisRound});
    }

    // 2026-05-24 §영혼력 visual feedback 룰 — AI 카드 사용 시 enemy mana flash + -N popup.
    //   player 측은 cast 카드 자체로 인지 (popup 생략 — 중복 방지).
    if(sideKey === 'enemy' && needCost > 0 && Array.isArray(st.events)){
      st.events.push({type: 'soul-consume', side: sideKey, amount: needCost});
    }

    // P1-12 fix (2026-05-16): 좌측 cast 카드 표시 — player + enemy 양쪽 (AI 가 카드 쓸 때도 보임).
    // UI 가 'card-cast-left' event 처리 → _showLeftCast 자동 호출.
    if(Array.isArray(st.events)){
      st.events.push({type: 'card-cast-left', card: _castVisualCard, side: sideKey});
    }

    // Phase 1A.3 — 카드 사용 시각 시퀀스 시작 (1A.4 에서 실제 애니 연결).
    // card 객체 자체 포함 — UI ghost 재구성용 (renderState 가 hand DOM 비우기 전에
    // 시각 데이터 캡처하기 위함).
    // 2026-05-07 fix: spell 카드만 fly-to-center. unit/attach 는 보드 인서트(_playUnit)
    // 또는 부착(_playAttach*)으로 끝나며 _resolveCardFate(shatter/return-to-deck) 호출 안 됨
    // → ghost 가 중앙에 영구 stuck + target line 의 source 로 잡혀 우하단으로 잘못 뻗음.
    const isSpell = (card.kind === 'spell-target' || card.kind === 'spell-aoe');
    if(isSpell){
      st.events.push({
        type: 'card-fly-to-center',
        card: _castVisualCard,
        cardId: _castVisualCard.id,
        fromSide: sideKey,
        fromHandIdx: handIdx,
        kind: card.kind,
      });
    }

    // bundle skill 사용 시 그 unit (card.bundledByUnit 와 같은 id 의 board unit) 에 EXP +1
    // 2 도달 시 자동 ATK/HP 랜덤 +1, max Lv 5 cap (사용자 결정 2026-05-07)
    if(card.bundledByUnit){
      _grantUnitExp(side, card.bundledByUnit);
    }

    // v1.1 mastery xp trigger (2026-05-25, spec §1.5) — 시전자의 그 스킬 mastery xp +1.
    // bundledByUnit 기반 시전자 lookup: 영웅이면 side.hero, 동료면 side.board 에서 같은 id 찾기.
    // 영구 저장은 매치 종료 시 _commitMasteryToProfile 에서 _permanentUid 기준 commit.
    if(card.bundledByUnit && typeof RoF !== 'undefined' && RoF.Meta && RoF.Meta.Mastery){
      let caster = null;
      if(side.hero && side.hero.id === card.bundledByUnit) caster = side.hero;
      else if(Array.isArray(side.board)){
        caster = side.board.find(u => u && !u.isDead && u.id === card.bundledByUnit) || null;
      }
      if(caster){
        const r = RoF.Meta.Mastery.addXp(caster, card.id, 1);
        if(r && r.leveledUp && r.newLevel === 10){
          // Lv 10 도달 — UI 트리거 (수련장 unlock 알림 용). 매치 중 모달 X (spec §17).
          logEvent('mastery-lv10-unlock', {side: sideKey, casterId: caster.id, skillId: card.id});
        }
      }
    }

    // kind 5종 분기
    let result;
    switch(card.kind){
      case 'unit':         result = Match._playUnit(sideKey, card, opts);        break;
      case 'spell-target': result = Match._playSpellTarget(sideKey, card, opts); break;
      case 'spell-aoe':    result = Match._playSpellAoe(sideKey, card, opts);    break;
      case 'attach-hero':  result = Match._playAttachHero(sideKey, card, opts);  break;
      case 'attach-unit':  result = Match._playAttachUnit(sideKey, card, opts);  break;
      /* diagnosis-confirmed: 2026-06-07 사유: feature — attach-self kind dispatch (스펠주인 부착). 버그 픽스 아님. */
      case 'attach-self':  result = Match._playAttachSelf(sideKey, card, opts);  break;
    }

    // 2026-05-24 cascade 룰 (battle_system_decisions.md §전투 시각 cascade 표준 룰):
    //   spell 사용 시 cleanup 시점 = cascade 종료 후 (DEATH visual 끝난 시점, UI 측 _processEvents 끝에서 호출).
    //   회귀: opts._syncCleanup 또는 window 없으면 즉시 (동기 state 검증 호환).
    //   옛 setTimeout 1500ms 강제 timing 폐기 — sk_dragon_flame 3s 같은 가변 spell visual 끝 전에 cleanup 일어나는 race condition 해소.
    // 2026-05-29 #32 fix — unit / attach 카드 사용 시 cleanup 호출 폐기 (사용자 보고 "두 번째 보드유닛 사라짐").
    //   원인: 옛 round 의 보드 페이즈 attack 사망 unit 이 어떤 이유로 isDead=true 채 잔존 →
    //   새 unit 카드 사용 시 cleanup → 옛 dead unit 제거 + 시각 충돌 → 사용자 입장 "내 보드유닛 사라짐"
    //   본질: unit / attach 카드 자체는 사망 발생 X → cleanup 의미 X.
    //   spell 카드만 데미지 발생 → cleanup 필요 (UI cascade 끝에서 자동 처리).
    //   attack 후 cleanup (line 2089) 은 매 attack 후 호출되어 dead unit 즉시 제거 — 안전망 유지.
    const isSpellKind = (card.kind === 'spell-target' || card.kind === 'spell-aoe');
    if(isSpellKind && typeof window !== 'undefined' && !(opts && opts._syncCleanup)){
      // UI cascade callback 의존 — _processEvents 끝에서 자동 cleanup. 여기서는 _checkWinner 만 (winner 판정은 즉시).
      Match._checkWinner();
    } else if(isSpellKind){
      // spell + 회귀 환경 (window 없거나 _syncCleanup) — 즉시 cleanup
      Match._cleanupBoard();
      Match._checkWinner();
    } else {
      // unit / attach-hero / attach-unit — cleanup 폐기 (사망 발생 X). _checkWinner 만.
      Match._checkWinner();
    }

    // 발화 강화 복원 — 덱에 남는 원본 카드(같은 객체)를 pristine 으로 (fate 는 이미 id/kind 기준 처리됨).
    if(card._fireUpBackup){
      card.NEED_SOUL = card._fireUpBackup.NEED_SOUL;
      card.effects = card._fireUpBackup.effects;
      delete card._fireUpBackup;
    }

    return result || {ok:true};
  };

  // unit: 보드에 소환 (slotIdx 없으면 끝에 push, 있으면 insert)
  Match._playUnit = function(sideKey, card, opts){
    const side = Match.state[sideKey];
    const slot = (opts && typeof opts.slotIdx === 'number')
      ? Math.max(0, Math.min(opts.slotIdx, side.board.length))
      : side.board.length;
    side.board.splice(slot, 0, card);
    card.exhausted = true;  // 소환 멀미
    logEvent('summon', {side: sideKey, cardId: card.id, slot});

    // Phase 1A.5 — 시각 소환 이벤트 (1A.4 의 tcgMinionSpawn 키프레임 활용)
    if(Match.state && Array.isArray(Match.state.events)){
      Match.state.events.push({
        type: 'unit-summon',
        uid: card.uid,
        side: sideKey,
        cardId: card.id,
        isCompanion: _isCompanion(card),
      });
    }

    // Plan 2.B Phase E (2026-05-12): 동료 보드 등장 → 그 동료 시그 활성화 (dormantPile → drawPile).
    // bundledByUnit === card.id 의 시그를 dormantPile 에서 빼내 drawPile 합류 + 셔플.
    if(Array.isArray(side.dormantPile) && side.dormantPile.length > 0){
      const activated = side.dormantPile.filter(c => c && c.bundledByUnit === card.id);
      if(activated.length > 0){
        side.dormantPile = side.dormantPile.filter(c => !(c && c.bundledByUnit === card.id));
        for(const c of activated) side.deck.push(c);
        side.deck = shuffle(side.deck);
        logEvent('dormant-activate', {side: sideKey, unitId: card.id, count: activated.length, drawSize: side.deck.length});
      }
    }

    Match._triggerKeyword(card, 'battlecry', sideKey, opts);
    /* diagnosis-confirmed: 2026-06-11 사유: feature — onPlay(battlecry) 트리거 배선. 미배선 기능 구현. */
    // 능력 트리거 — onPlay(battlecry) effects 발동. caster = 방금 소환된 보드 인스턴스(card).
    Match._fireTriggerEffects(card, 'onPlay', sideKey);
    /* diagnosis-confirmed: 2026-06-13 사유: feature — 종족 시너지 R1 보드변동 hook. 소환으로 N 변동 → 양측 재계산(멱등). */
    if(Match._recomputeSynergy){ Match._recomputeSynergy(Match.state.player); Match._recomputeSynergy(Match.state.enemy); }
    return {ok:true, summoned:card};
  };

  // spell-target: 단일 타겟. opts.targetSide + opts.targetUid 필수
  // 2026-05-06 Phase E-2: effects 메타 우선 dispatch, 없으면 legacy(card.ATK 데미지)
  Match._playSpellTarget = function(sideKey, card, opts){
    const target = Match._resolveTarget(opts);
    if(!target){
      logEvent('spell-no-target', {cardId: card.id});
      // Phase 1A.3 — no-target 도 카드 운명은 결정 (영혼 차감 후라 카드 자체는 사용됨)
      Match._resolveCardFate(sideKey, card);
      return {ok:true, missed:true};
    }
    const st = Match.state;
    const side = st[sideKey];
    // Phase 1A.4.5 — 시각 발사체 이벤트 (fly→projectile→damage→fate sequence).
    // 효과 적용 전에 push 해서 "발사체 발사 → 타겟 적중 → 데미지 popup" 순서 보장.
    if(st && Array.isArray(st.events)){
      st.events.push({
        type: 'projectile',
        targetUid: target.uid,
        element: card.element || 'holy',
        cardId: card.id,
      });
    }
    const hasEffects = Array.isArray(card.effects) && card.effects.length > 0;
    if(hasEffects){
      /* diagnosis-confirmed: 2026-06-06 사유: feature — #28 caster 전달 (self-target 효과가 시전자 참조: 불타는 여의봉 self ATK 버프). _playSpellAoe 와 정합. */
      Match._applyEffects(card, {side, opts, sourceSideKey: sideKey, caster: Match._resolveCaster(side, card)});
    } else {
      Match._applySpellEffect(card, [target], sideKey, Match._resolveCaster(side, card));
    }
    // Phase 1A.3 — 효과 발동 후 카드 운명 (재사용 vs 각인)
    Match._resolveCardFate(sideKey, card);
    return {ok:true, target};
  };

  // spell-aoe: 광역
  Match._playSpellAoe = function(sideKey, card, opts){
    const st = Match.state;
    const side = st[sideKey];
    const targetSideKey = (opts && opts.targetSide === 'ally') ? sideKey : (sideKey === 'player' ? 'enemy' : 'player');
    const targets = st[targetSideKey].board.filter(u => !u.isDead);
    // Phase 1A.4.5 — 시각 광역 충격파 이벤트 (보드 중앙 ✦ burst + 타겟 stagger hit-shake).
    // 효과 적용 전 push. 개별 데미지 popup 은 _damage 가 push 한 damage event 가 처리.
    if(st && Array.isArray(st.events)){
      st.events.push({
        type: 'aoe-burst',
        targetSide: targetSideKey,
        targetUids: targets.map(t => t.uid),
        cardId: card.id,
        element: card.element || 'holy',
      });
    }
    const hasEffects = Array.isArray(card.effects) && card.effects.length > 0;
    if(hasEffects){
      /* diagnosis-confirmed: 2026-06-05 사유: feature — self_destruct 시전자(bundled 유닛) 참조 위해 caster 전달 (#22 자폭) */
      Match._applyEffects(card, {side, opts, sourceSideKey: sideKey, caster: Match._resolveCaster(side, card)});
    } else {
      Match._applySpellEffect(card, targets, sideKey, Match._resolveCaster(side, card));
    }
    // Phase 1A.3 — 효과 발동 후 카드 운명 (재사용 vs 각인)
    Match._resolveCardFate(sideKey, card);
    return {ok:true, targets};
  };

  /* diagnosis-confirmed: 2026-06-05 사유: feature — 스펠 시전자 resolve 헬퍼 신설 (#22 self_destruct / 향후 시전자 자기버프) */
  // 영웅 시그 → side.hero / 동료 시그 → board 에서 같은 id 첫 생존 유닛. 없으면 null.
  Match._resolveCaster = function(side, card){
    if(!side || !card || !card.bundledByUnit) return null;
    if(side.hero && side.hero.id === card.bundledByUnit) return side.hero;
    if(Array.isArray(side.board)){
      return side.board.find(u => u && !u.isDead && u.id === card.bundledByUnit) || null;
    }
    return null;
  };

  // Phase 1A.3 — 카드 운명 결정 (재사용 vs 각인). 스펠 카드만 호출됨.
  // 재사용: deck 뒤에 push (다음 드로우에 곧 안 뽑힘) + card-return-to-deck 이벤트
  // 각인:   폐기 (단순 사라짐) + card-shatter 이벤트
  // 1A.4 에서 _playEvent 가 시각 애니로 재생.
  Match._resolveCardFate = function(sideKey, card){
    const st = Match.state;
    if(!st || !card) return;
    const side = st[sideKey];
    if(!side) return;
    /* diagnosis-confirmed: 2026-06-07 사유: feature — lifecycle exhaust/redraw 분기 (battle_system_decisions.md 2026-06-07 A). 키워드 우선 — _isReusable 무관. exhaust=매치 끝까지 exhaustPile / redraw=다음 라운드 우선 손패(_beginRound 가 _redrawPending 처리). */
    const _kw = Array.isArray(card.keywords) ? card.keywords : [];
    if(_kw.indexOf('exhaust') >= 0){
      side.exhaustPile = side.exhaustPile || [];
      side.exhaustPile.push(card);
      st.events.push({type:'card-exhaust', card:card, cardId:card.id, fromSide:sideKey});
      logEvent('card-fate-exhaust', {side: sideKey, cardId: card.id, exhaustLen: side.exhaustPile.length});
      return;
    }
    if(_kw.indexOf('redraw') >= 0){
      side._redrawPending = side._redrawPending || [];
      side._redrawPending.push(card);
      st.events.push({type:'card-redraw-pending', card:card, cardId:card.id, fromSide:sideKey});
      logEvent('card-fate-redraw', {side: sideKey, cardId: card.id, redrawLen: side._redrawPending.length});
      return;
    }
    if(_isReusable(card)){
      // 2026-05-17 — 보존 카드 (_persistent) 는 사용 후 discardPile 로 (drawPile 셔플 환원 후에야 deck 진입).
      // 사용자 명시: "한번 쓰면 다시 카드덱에 가는거지" + "가끔만 등장" — deck 맨 아래 push 보다 더 깊게.
      if(card._persistent === true){
        side.discardPile.push(card);
        st.events.push({type:'card-shatter', card:card, cardId:card.id, fromSide:sideKey});
        logEvent('card-fate-persistent-discard', {side: sideKey, cardId: card.id, discardLen: side.discardPile.length, deckLen: side.deck.length, handLen: side.hand.length});
        // 2026-05-17 — 사용자 "2턴째 또 써" 보고 debug
        if(typeof console !== 'undefined' && console.log){
          console.log('[DRAGON] ' + sideKey + ' 보존카드 사용 → discardPile (len=' + side.discardPile.length + '). hand 에 동일 카드 잔존?:', side.hand.filter(c => c && c.id === card.id).length);
        }
      } else {
        side.deck.push(card);
        st.events.push({type:'card-return-to-deck', card:card, cardId:card.id, fromSide:sideKey});
        logEvent('card-fate-reusable', {side: sideKey, cardId: card.id, deckLen: side.deck.length});
      }
    } else {
      st.events.push({type:'card-shatter', card:card, cardId:card.id, fromSide:sideKey});
      logEvent('card-fate-engraved', {side: sideKey, cardId: card.id});
    }
  };

  /* diagnosis-confirmed: 2026-06-07 사유: feature — 메커니즘 Scry(운명 정찰) 코어. drawPile(deck) 상단 count 장을 decisions 에 따라 유지(상단 순서)/맨아래로 재배치. decisions[i].keep===false 면 맨아래. UI 모달은 ④-b(갤러리 검수). battle_system_decisions.md 2026-06-07 B-2. */
  Match._scry = function(sideKey, count, decisions){
    const st = Match.state;
    const side = st && st[sideKey];
    if(!side || !Array.isArray(side.deck) || count <= 0) return {ok:false};
    const n = Math.min(count, side.deck.length);
    const top = side.deck.slice(0, n);
    const rest = side.deck.slice(n);
    const keep = [], bottom = [];
    top.forEach((c, i) => {
      if(decisions && decisions[i] && decisions[i].keep === false) bottom.push(c);
      else keep.push(c);
    });
    side.deck = keep.concat(rest, bottom);
    logEvent('scry', {side: sideKey, count: n, kept: keep.length, bottomed: bottom.length});
    return {ok:true, kept: keep.length, bottomed: bottom.length};
  };

  // attach-hero: 영웅에 부착
  Match._playAttachHero = function(sideKey, card, opts){
    const st = Match.state;
    const targetSideKey = (opts && opts.targetSide === 'enemy') ? (sideKey === 'player' ? 'enemy' : 'player') : sideKey;
    const hero = st[targetSideKey].hero;
    if(!hero) return {ok:true, missed:true};
    hero.attachments.push(card);
    Match._applyAttachBuff(hero, card);
    // effects 메타 dispatch (attach_buff/debuff 등)
    if(Array.isArray(card.effects) && card.effects.length){
      Match._applyEffects(card, {side: st[sideKey], opts, sourceSideKey: sideKey, attachTarget: hero});
    }
    logEvent('attach-hero', {side: sideKey, target: targetSideKey, cardId: card.id});
    return {ok:true, target: hero};
  };

  // attach-unit: 보드 유닛에 부착
  Match._playAttachUnit = function(sideKey, card, opts){
    const target = Match._resolveTarget(opts);
    if(!target || target.kind === 'hero') return {ok:true, missed:true};
    target.attachments.push(card);
    Match._applyAttachBuff(target, card);
    if(Array.isArray(card.effects) && card.effects.length){
      Match._applyEffects(card, {side: Match.state[sideKey], opts, sourceSideKey: sideKey, attachTarget: target});
    }
    logEvent('attach-unit', {side: sideKey, cardId: card.id, targetUid: target.uid});
    return {ok:true, target};
  };

  /* diagnosis-confirmed: 2026-06-07 사유: feature — attach-self: 스펠주인(시전자) 자신에게 부착. 버그 픽스 아님. */
  // 소유 = _resolveCaster (영웅 시그 → 영웅 / 동료 시그 → board 의 같은 id 유닛 / 없으면 영웅 fallback).
  // _playAttachHero/Unit 와 동형 — attachTarget=owner 로 _applyAttachBuff + _applyEffects (self target 자동 해석).
  Match._playAttachSelf = function(sideKey, card, opts){
    const side = Match.state[sideKey];
    if(!side) return {ok:true, missed:true};
    const owner = Match._resolveCaster(side, card) || side.hero;
    if(!owner || owner.isDead) return {ok:true, missed:true};
    owner.attachments.push(card);
    Match._applyAttachBuff(owner, card);
    if(Array.isArray(card.effects) && card.effects.length){
      Match._applyEffects(card, {side, opts, sourceSideKey: sideKey, attachTarget: owner, caster: owner});
    }
    logEvent('attach-self', {side: sideKey, cardId: card.id, ownerUid: owner.uid});
    return {ok:true, target: owner};
  };

  // ───────── 타겟 해석 ─────────
  // opts = {targetSide:'ally'|'enemy', targetUid:string}
  // targetUid === '__hero__' 으로 영웅 직접 지정도 허용.
  Match._resolveTarget = function(opts){
    if(!opts) return null;
    const st = Match.state;
    const callerSide = st.side;
    const targetSideKey = (opts.targetSide === 'enemy')
      ? (callerSide === 'player' ? 'enemy' : 'player')
      : callerSide;
    const side = st[targetSideKey];
    if(!side) return null;
    if(opts.targetUid === '__hero__') return side.hero;
    return side.board.find(u => u.uid === opts.targetUid) || null;
  };

  // ───────── 스펠 효과 적용 (단순화 — ATK 그대로 데미지) ─────────
  // PHASE 6 단순 룰: 스펠 카드의 ATK = 가하는 데미지, HP = 회복량 (ability 텍스트는 미적용 — Phase E 텍스트 파서 별도).
  // role 로 데미지/힐 분기:
  //  - role 'attack'      → ATK 만큼 데미지
  //  - role 'support'     → ATK > 0 면 ATK 데미지, 아니면 HP 회복
  //  - role 'defense'     → ATK 가 디버프(임시 ATK -1) — 추후 정교화
  Match._applySpellEffect = function(card, targets, sourceSideKey, caster){
    const dmg  = card.ATK  || 0;
    const heal = card.HP   || 0;
    const isHeal = (card.role === 'support' && dmg === 0 && heal > 0);
    // 기여포인트 귀속 — caster 를 state 에 노출 (_damage 가 읽음). 중첩 안전 위해 prev 복원.
    const _prevCaster = Match.state ? Match.state._currentCaster : undefined;
    if(Match.state && caster) Match.state._currentCaster = caster;
    try {
      targets.forEach(t => {
        if(t.isDead) return;
        if(isHeal){
          const before = t.curHP;
          t.curHP = Math.min(t.maxHP || t.HP || t.curHP + heal, t.curHP + heal);
          if(caster) _addContrib(caster, (t.curHP - before) * CONTRIB.heal);  // 기여 — 실제 회복량 ×0.7
          logEvent('heal', {targetUid: t.uid, by: card.id, amount: heal, hp: t.curHP});
        } else if(dmg > 0){
          Match._damage(t, dmg, {sourceCard: card});
        }
      });
    } finally {
      if(Match.state) Match.state._currentCaster = _prevCaster;
    }
  };

  // 부착 카드 효과 = 단순 stat 합산 (ATK/HP/DEF/reflect).
  // 2026-05-06 Phase E-2: effects 메타가 있으면 ATK/HP 는 effects.attach_buff 가 진실원천 → legacy 합산 skip.
  // DEF/reflect/keywords 는 5필드 기반으로 그대로 (effects.shield 는 dispatch 에서 skip).
  Match._applyAttachBuff = function(target, attachCard){
    const hasEffects = Array.isArray(attachCard.effects) && attachCard.effects.length > 0;
    if(!hasEffects){
      // legacy — 5필드 ATK/HP 직접 합산 (옛 카드 호환)
      if(attachCard.ATK){
        target.curATK += attachCard.ATK;
        target.baseATK = target.curATK;
      }
      if(attachCard.HP){
        target.maxHP = (target.maxHP || target.HP || 0) + attachCard.HP;
        target.curHP += attachCard.HP;
      }
    }
    /* diagnosis-confirmed: 2026-06-11 사유: bug-fix — DEF 이중 적용 (non-self shield 카드가 attachBuff DEF필드 + effects.shield dispatch 둘 다 적용 → 부착대상 _def 2배, 예 hero_warrior_shield +4). 코드 직접 확인 + 가설(이중/만료 2개) + 회귀 match-def-v6 D 검증. */
    // DEF (보호막) 부여 — 데이터 default 0, 1+일 때만 적용.
    //   ⚠️ non-self target shield op 이 effects 에 있으면 _dispatchEffect 가 DEF 부여 → 여기서 DEF필드 skip (이중 방지).
    //   self/미명시 shield 는 _applyEffects 에서 dispatch skip 되므로 여기 attachBuff 가 처리 (기존 경로 유지).
    const shieldViaDispatch = hasEffects && attachCard.effects.some(e => e && e.op === 'shield' && e.target && e.target !== 'self');
    if(!shieldViaDispatch && attachCard.DEF && attachCard.DEF > 0){
      target._def = (target._def || 0) + attachCard.DEF;
      target._defTurns = Math.max(target._defTurns || 0, attachCard.defTurns || 1);
      attachCard._remainingTurns = attachCard.defTurns || 1;
      logEvent('def-grant', {targetUid: target.uid, by: attachCard.id, amount: attachCard.DEF, turns: attachCard.defTurns || 1});
    }
    // 반사 (reflect) 부여 — fire_shield 등
    if(attachCard.reflectAmt && attachCard.reflectAmt > 0){
      target._reflect = (target._reflect || 0) + attachCard.reflectAmt;
      target._reflectTurns = Math.max(target._reflectTurns || 0, attachCard.reflectTurns || 1);
      attachCard._remainingTurns = Math.max(attachCard._remainingTurns || 0, attachCard.reflectTurns || 1);
    }
    /* diagnosis-confirmed: 2026-06-06 사유: feature — 반사 화상(reflectBurnAmt) 부여. reflectAmt 경로 복제. 화염방패. */
    if(attachCard.reflectBurnAmt && attachCard.reflectBurnAmt > 0){
      target._reflectBurn = (target._reflectBurn || 0) + attachCard.reflectBurnAmt;
      target._reflectBurnTurns = Math.max(target._reflectBurnTurns || 0, attachCard.reflectBurnTurns || 1);
      attachCard._remainingTurns = Math.max(attachCard._remainingTurns || 0, attachCard.reflectBurnTurns || 1);
    }
    if(Array.isArray(attachCard.keywords) && attachCard.keywords.length){
      const kws = target.keywords || [];
      attachCard.keywords.forEach(k => { if(kws.indexOf(k) < 0) kws.push(k); });
      target.keywords = kws;
    }
  };

  // ───────── effects 메타 dispatch (Phase E-2.1 — 2026-05-06) ─────────
  // 카드의 effects 배열을 op 별로 분기 실행. 미구현 op (_todo/_redesign/attach_marker/aura/modifier/next_*) 는 skip + log.
  // 스펙: design/ability_dsl_spec_2026-05-06.md §3
  /* diagnosis-confirmed: 2026-06-07 사유: feature — 스킬 강화 v3 단계① chosenUpgrade effects override (meta_progression_spec §3.4). 버그 픽스 아님. */
  // chosenUpgrade (단계① 단순 A/B 강화) — card._chosenUpgrade 있으면 upgradeChoices 의 그 옵션 effects 사용.
  //   없으면 base effects (없을 때 기존 동작 불변).
  Match._resolveSkillEffects = function(card){
    const ch = card && card._chosenUpgrade;
    if(ch && Array.isArray(card.upgradeChoices)){
      const opt = card.upgradeChoices.find(o => o && o.id === ch);
      if(opt && Array.isArray(opt.effects)) return opt.effects;
    }
    return Array.isArray(card.effects) ? card.effects : [];
  };
  Match._applyEffects = function(card, ctx){
    const effects = Match._resolveSkillEffects(card);
    if(effects.length === 0) return {applied:0, skipped:0};
    // 기여포인트 귀속 — 이 카드 효과 적용 동안 시전자를 state 에 노출 (_damage/heal 이 읽음).
    //   중첩(combo bonus 재귀) 안전 위해 이전 값 저장 → finally 복원.
    const _prevCaster = Match.state ? Match.state._currentCaster : undefined;
    if(Match.state && ctx && ctx.caster) Match.state._currentCaster = ctx.caster;
    try {
    let applied = 0, skipped = 0;
    effects.forEach(e => {
      if(!e || !e.op) return;
      // _redesign 만 skip (재설계 필요한 항목). op:'_todo' 는 _todo 값으로 dispatch 시도.
      if(e.op === '_redesign'){
        skipped++;
        logEvent('effect-skipped', {cardId: card.id, op: e.op, reason: e._todo || 'redesign'});
        return;
      }
      // shield 는 target='self' (또는 미명시) 면 _applyAttachBuff 5필드(DEF/defTurns/reflectAmt) 가 처리 → skip
      // target='ally_all'/'ally_one'/etc 명시 시 dispatch 의 shield case 로 multi-target 처리 (구조 이슈 A fix 2026-05-30)
      if(e.op === 'shield' && (!e.target || e.target === 'self')){ skipped++; return; }
      // (2026-05-06 Phase E-2.6 후속): attach_marker / modifier / next_card_* 모두 dispatch 에서 처리.
      // e._todo 메타 플래그가 있어도 op 가 알려진 거면 dispatch 시도 (메타는 "추가 정교화 노트" 역할).
      const dispatched = Match._dispatchEffect(e, card, ctx);
      if(dispatched){
        applied++;
        if(e._todo) logEvent('effect-applied-with-todo', {cardId: card.id, op: e.op, todoNote: e._todo});
      } else {
        skipped++;
        if(e._todo) logEvent('effect-skipped', {cardId: card.id, op: e.op, reason: e._todo});
      }
    });
    return {applied, skipped};
    } finally {
      if(Match.state) Match.state._currentCaster = _prevCaster;
    }
  };

  // rarity 가 limit 미만인가? (처형/부활 가드용). limit 없으면 항상 true (조건 없음).
  // 예: rarity='gold', limit='legendary' → gold < legendary → true (처형 가능)
  const _RARITY_ORDER = ['bronze', 'silver', 'gold', 'legendary', 'divine'];
  function _rarityBelow(rarity, limit){
    if(!limit) return true;
    const r = _RARITY_ORDER.indexOf(rarity || 'bronze');
    const l = _RARITY_ORDER.indexOf(limit);
    if(r < 0 || l < 0) return true;  // 알 수 없는 등급 — 가드 통과
    return r < l;
  }

  // ── 발화 (sk_pyromancer_ignite) — 다음 화염 스펠 1개 강화 (사용자 결정 2026-06-03 A안) ──
  //   상위 교체 쌍이 있으면 그 상위 스펠 effects/NEED_SOUL 로, 없으면 amount/hits + NEED_SOUL x2.
  //   1회 충전 (턴 무관 보존). 화염술사(pyromancer) 보드 생존 시에만 적용 — 사망 시 효과 소멸.
  const _FIRE_UPGRADE_MAP = Object.freeze({
    sk_pyromancer_fireball: 'sk_pyromancer_burning_orb',  // 화염구 → 업화구 (현재 유일한 상위 쌍)
  });
  function _isFireSpell(card){
    return !!(card && card.element === 'fire' && (card.kind === 'spell-target' || card.kind === 'spell-aoe'));
  }
  function _pyromancerAlive(side){
    return !!(side && Array.isArray(side.board) && side.board.find(u => u && !u.isDead && u.id === 'pyromancer'));
  }
  // 강화 결과 계산 (mutation 없음). 강화 cost 감당 불가 시 null (보류 — 통상 cast, pending 유지).
  Match._computeFireUpgrade = function(side, card){
    if(!side || !side._fireUpgradePending) return null;
    if(!_isFireSpell(card)) return null;
    if(!_pyromancerAlive(side)) return null;  // 화염술사 사망 → 효과 소멸
    let needSoul, effects, mode;
    const upId = _FIRE_UPGRADE_MAP[card.id];
    const up = upId && (RoF.Data.SKILLS || []).find(s => s.id === upId);
    if(up){
      mode = 'replace';
      needSoul = up.NEED_SOUL || 0;
      effects = JSON.parse(JSON.stringify(up.effects || []));
    } else {
      mode = 'x2';
      needSoul = (card.NEED_SOUL || 0) * 2;
      effects = (card.effects || []).map(e => {
        const c = Object.assign({}, e);
        if(typeof c.amount === 'number') c.amount *= 2;
        if(typeof c.hits === 'number')  c.hits  *= 2;
        if(typeof c.count === 'number') c.count *= 2;
        return c;
      });
    }
    if((side.soulPool | 0) < needSoul) return null;  // 강화 cost 감당 불가 → 보류
    return {mode, needSoul, effects, upId: upId || null};
  };

  Match._dispatchEffect = function(effect, card, ctx){
    const targets = Match._resolveEffectTargets(effect, ctx);
    if(targets.length === 0) return false;

    switch(effect.op){
      case 'damage': {
        let amt = (effect.amount || 0) * (effect.hits || 1);
        if(amt <= 0) return false;
        // _nextDmgBuff (필터매칭 시 +amount, 1회성 — 카드 단위 소모)
        const side = ctx.side;
        if(side && side._nextDmgBuff && _nextCardFilterMatch(side._nextDmgBuff.filter, card)){
          const buff = side._nextDmgBuff.amount;
          amt += buff;
          logEvent('dmg-buff-apply', {side: ctx.sourceSideKey, cardId: card.id, bonus: buff, totalDmg: amt});
          side._nextDmgBuff = null;
        }
        // condition 처리 (lineage_2x_dmg / role_in 등) — 만족 시 amount, 불만족 시 amount/2 (정수 floor)
        const dmgCtx = {sourceCard: card};
        if(effect.pierce === 'shield') dmgCtx._pierceDef = true;
        targets.forEach(t => {
          if(t.isDead) return;
          let actualDmg = amt;
          if(effect.condition){
            const cond = effect.condition;
            let match = false;
            if(cond.type === 'id_contains' && t.id && typeof t.id === 'string'){
              match = t.id.toLowerCase().includes(cond.value.toLowerCase());
            } else if(cond.type === 'role_in' && t.role && typeof t.role === 'string'){
              const roles = String(cond.value).split('|').map(s => s.trim());
              match = roles.includes(t.role);
            }
            // role_in 만족 시 doubled (sk_rogue_assassinate "지원/원거리에 2배")
            if(cond.type === 'role_in') {
              actualDmg = match ? amt * 2 : amt;
            } else {
              if(!match) actualDmg = Math.floor(amt / 2);
            }
            logEvent('condition-check', {targetUid: t.uid, cond: cond.value, match, dmg: actualDmg});
          }
          if(actualDmg > 0) Match._damage(t, actualDmg, dmgCtx);
        });
        return true;
      }
      case 'heal': {
        let amt = effect.amount || 0;
        if(amt <= 0) return false;
        // _modifiers 진영 전역 buff (stat:'heal') 합산
        const side = ctx.side;
        if(side && Array.isArray(side._modifiers) && side._modifiers.length){
          const bonus = side._modifiers.filter(m => m && m.stat === 'heal').reduce((s, m) => s + (m.amount || 0), 0);
          if(bonus > 0){
            amt += bonus;
            logEvent('modifier-heal', {side: ctx.sourceSideKey, bonus, totalAmt: amt});
          }
        }
        const _healer = (ctx && ctx.caster) || (Match.state && Match.state._currentCaster) || null;
        targets.forEach(t => {
          if(t.isDead) return;
          const cap = t.maxHP || t.HP || (t.curHP + amt);
          const before = t.curHP;
          t.curHP = Math.min(cap, t.curHP + amt);
          if(_healer) _addContrib(_healer, (t.curHP - before) * CONTRIB.heal);  // 기여 — 실제 회복량 ×0.7
          logEvent('heal', {targetUid: t.uid, by: card.id, amount: amt, hp: t.curHP});
        });
        return true;
      }
      case 'attach_buff':
      case 'attach_debuff': {
        /* diagnosis-confirmed: 2026-06-06 사유: feature — #28 임시 버프(turns>0) 지원. turns 있으면 base 불변 + _tempStatBuffs 등록 → 라운드 종료 시 _tickTempStatBuffs 가 회수. turns 없으면 기존 영구 동작. */
        const sign = effect.op === 'attach_debuff' ? -1 : 1;
        const stat = effect.stat;
        const amt  = sign * (effect.amount || 0);
        if(amt === 0) return false;
        const tempTurns = effect.turns || 0;  // >0 = 임시 (라운드 종료 시 만료), 0 = 영구
        targets.forEach(t => {
          if(t.isDead) return;
          if(stat === 'ATK'){
            t.curATK = Math.max(0, (t.curATK || 0) + amt);
            if(amt > 0 && !tempTurns) t.baseATK = t.curATK;  // 영구 buff 만 base 갱신. 임시는 base 보존 (만료 시 회수 위해).
          } else if(stat === 'HP'){
            if(amt > 0){
              t.maxHP = (t.maxHP || t.HP || 0) + amt;
              t.curHP += amt;
            } else {
              t.curHP = Math.max(0, (t.curHP || 0) + amt);
              if(t.curHP === 0) Match._damage(t, 0, {sourceCard: card}); // dead 검사 트리거
            }
          }
          if(tempTurns > 0){
            /* diagnosis-confirmed: 2026-06-06 사유: feature — #28 임시버프 배지 호 게이지 비율용 turnsTotal 저장. */
            t._tempStatBuffs = t._tempStatBuffs || [];
            t._tempStatBuffs.push({stat, amount: amt, roundsLeft: tempTurns, turnsTotal: tempTurns, by: card.id});
          }
          logEvent('attach-stat', {targetUid: t.uid, by: card.id, stat, amount: amt, turns: tempTurns});
          // 2026-05-17 #13 — 스킬 buff/nerf 시각 flash 이벤트 (사용자 명시 "+증가 애니메이션 + 색상 변화")
          // UI._playEvent 가 case 'stat-flash' 처리 → 해당 unit num element 에 is-flashing-buff/nerf 토글.
          if(Match.state && Array.isArray(Match.state.events)){
            Match.state.events.push({
              type: 'stat-flash',
              targetUid: t.uid,
              stat: stat,
              direction: amt > 0 ? 'buff' : 'nerf',
              amount: amt
            });
          }
        });
        return true;
      }
      case 'stun': {
        const turns = effect.turns || 1;
        targets.forEach(t => {
          if(t.isDead) return;
          if(Match._debuffWarded(t)) return;   /* diagnosis-confirmed: 2026-06-15 사유: feature — 마법방어막 1회 디버프 무효 (전기 카운터) */
          t._stunTurns = Math.max(t._stunTurns || 0, turns);
          logEvent('stun', {targetUid: t.uid, by: card.id, turns});
        });
        return true;
      }
      case 'ward': {   /* diagnosis-confirmed: 2026-06-15 사유: feature — 마법방어막 op: 다음 디버프 N회 무효 charge 부여 (전기 6단계 영구 기절 카운터) */
        const charges = effect.amount || 1;
        targets.forEach(t => { if(t.isDead) return; t._wardCharges = (t._wardCharges || 0) + charges; logEvent('ward-grant', {targetUid: t.uid, by: card.id, charges}); });
        return true;
      }
      case 'dispel': {   /* diagnosis-confirmed: 2026-06-15 사유: feature — 마법해제 op: 아군 디버프(stun/burn) 제거 */
        targets.forEach(t => { if(t.isDead) return; Match._dispelDebuffs(t); });
        return true;
      }
      case 'burn': {
        /* diagnosis-confirmed: 2026-06-04 사유: feature — 지속피해에 element 태그 추가 (암흑저주 암흑 DOT 재설계, 원소별 DOT 확장 기반) */
        const turns = effect.turns || 1;
        // 2026-05-30 구조 이슈 C fix — effect.amount 반영. 옛 default 1 강제 폐기.
        // 영향 카드: sk_dragon_flame(fire,2) / sk_dark_curse(dark,1) / sk_minor_curse(1) / sk_archer_fire_arrow(1 default)
        // 2026-06-04 — element 태그 추가. 지속피해 메커니즘은 공통, 원소만 분기 (fire 화상 / dark 암흑 잠식 등). UI 연출 분기용.
        const burnAmt = effect.amount || 1;
        const burnElem = effect.element || 'fire';
        targets.forEach(t => {
          if(t.isDead) return;
          if(Match._debuffWarded(t)) return;   /* diagnosis-confirmed: 2026-06-15 사유: feature — 마법방어막 1회 디버프 무효 (burn 도 디버프) */
          t._burnTurns = Math.max(t._burnTurns || 0, turns);
          t._burnAmount = Math.max(t._burnAmount || 0, burnAmt);
          t._burnElement = burnElem;
          logEvent('burn', {targetUid: t.uid, by: card.id, turns, amount: burnAmt, element: burnElem});
        });
        return true;
      }
      case 'shield': {
        /* diagnosis-confirmed: 2026-06-11 사유: bug-fix — dispatch shield(ally_one/ally_all/hero) DEF 만료 누락 (attachments 미기록 → _tickTimedAttachments 회수 못함 → DEF 영구 누적). 대상별 만료 marker 로 fix. 회귀 match-def-v6 D 검증. */
        // 2026-05-30 구조 이슈 A fix — target='ally_all'/'ally_one'/etc 명시 시 dispatch 처리.
        // target='self' 카드는 _applyEffects 의 skip 분기에서 attachBuff(DEF/defTurns) path 로 처리됨.
        // 영향 카드: sk_aura (ally_all) / sk_shield·sk_reflex (ally_one) / sk_hero_*_shield (hero) 등.
        const turns = effect.turns || 1;
        const amount = effect.amount || 0;
        if(amount <= 0) return false;
        targets.forEach(t => {
          if(t.isDead) return;
          t._def = (t._def || 0) + amount;
          t._defTurns = Math.max(t._defTurns || 0, turns);
          // 만료 추적 marker — 부착카드(card)는 부착대상에만 있고 effects target 은 다를 수 있어,
          //   대상별 marker 를 attachments 에 넣어 _tickTimedAttachments 가 c.DEF/_remainingTurns 로 회수.
          //   UI 는 attachments 를 안 봄(렌더 무영향). _shieldMarker 로 식별.
          if(!Array.isArray(t.attachments)) t.attachments = [];
          const marker = {id:'_shield_'+(card.id||'fx'), _shieldMarker:true, DEF:amount, defTurns:turns, _remainingTurns:turns, keywords:[]};
          if(effect.addKeyword){
            const kws = t.keywords || [];
            if(kws.indexOf(effect.addKeyword) < 0) kws.push(effect.addKeyword);
            t.keywords = kws;
            marker.keywords = [effect.addKeyword];  // 만료 시 base+attach 재계산으로 제거
          }
          if(effect.reflect && effect.reflect > 0){
            t._reflect = (t._reflect || 0) + effect.reflect;
            t._reflectTurns = Math.max(t._reflectTurns || 0, turns);
            marker.reflectAmt = effect.reflect;
          }
          t.attachments.push(marker);
          logEvent('def-grant', {targetUid: t.uid, by: card.id, amount, turns, viaDispatch: true});
        });
        return true;
      }
      case 'soul_gain': {
        /* diagnosis-confirmed: 2026-06-07 사유: bug-fix — persistent_soul_boost(영혼력 증가 6장)가 soulPool만 1회 올려 "지속"이 미구현이던 버그. 코드 trace로 _onSoulRecharge base=hero.SOUL 확인. 회귀 match-soul-boost-persistent-v6 로 검증. */
        const side = ctx.side;
        if(!side) return false;
        // 2026-06-07 — persistent_soul_boost (영혼력 증가 attach-hero 6장): hero.SOUL 자체를 영구 +amount.
        //   매 라운드 회복 = hero.SOUL (_onSoulRecharge base) 이므로 충전 최대치가 영구히 오름.
        //   ability "다음 턴부터 영혼력 +1 (지속)" 과 일치 — 현재 풀은 안 건드리고 다음 _onSoulRecharge 부터 반영.
        if(effect._todo === 'persistent_soul_boost'){
          if(side.hero){ side.hero.SOUL = (side.hero.SOUL || 0) + (effect.amount || 0); }
          logEvent('soul-boost-persistent', {side: ctx.sourceSideKey, amount: effect.amount, heroSoul: side.hero && side.hero.SOUL});
          return true;
        }
        side.soulPool = (side.soulPool || 0) + (effect.amount || 0);
        logEvent('soul-gain', {side: ctx.sourceSideKey, amount: effect.amount, pool: side.soulPool});
        return true;
      }
      case 'overload': {
        /* diagnosis-confirmed: 2026-06-07 사유: feature — 메커니즘 Overload(영혼 과부하). _overload 누적 → 다음 _onSoulRecharge 영혼 회복 -N (1회 소비). battle_system_decisions.md 2026-06-07 B-1. */
        const side = ctx.side;
        if(!side) return false;
        side._overload = (side._overload || 0) + (effect.amount || 0);
        logEvent('overload', {side: ctx.sourceSideKey, amount: effect.amount, overload: side._overload});
        return true;
      }
      case 'refund': {
        // 2026-05-29 P0 #4 (StS2 패턴) — 다음 라운드 시작 시 _onSoulRecharge 가 base + refund 충전.
        //   effect.amount 만큼 누적 (effect.amount 미지정 시 1). 1회성 — _onSoulRecharge 가 reset.
        const side = ctx.side;
        if(!side) return false;
        side._refund = ((side._refund | 0) || 0) + (effect.amount || 1);
        logEvent('soul-refund', {side: ctx.sourceSideKey, amount: effect.amount || 1, refundTotal: side._refund});
        return true;
      }
      case 'tick_heal': {
        // 부착 효과 — 매 턴 자기 진영 시작에 _tickStatusEffects 가 적용 (Phase E-2.2)
        targets.forEach(t => {
          if(t.isDead) return;
          t._tickHealAmount = (t._tickHealAmount || 0) + (effect.amount || 0);
          logEvent('tick-heal-grant', {targetUid: t.uid, by: card.id, amount: effect.amount});
        });
        return true;
      }
      case 'self_destruct': {
        /* diagnosis-confirmed: 2026-06-05 사유: feature — 시전자(불꽃정령) 소멸 배선 (#22 자폭) */
        // attach-unit: 부착 대상(ctx.attachTarget) 소멸. spell-aoe(자폭): 시전자(ctx.caster=불꽃정령) 소멸.
        const victim = ctx.attachTarget || ctx.caster;
        if(victim && !victim.isDead){
          Match._damage(victim, victim.curHP || 0, {sourceCard: card, _noReflect: true});
          return true;
        }
        return false;
      }
      case 'stealth': {
        // 부착 대상에 stealth 키워드 + _stealthTurns 부여 — 적 공격 selection 에서 제외 (taunt 의 반대)
        const turns = effect.turns || 1;
        const target = ctx.attachTarget || ctx.side.hero;
        if(!target || target.isDead) return false;
        const kws = target.keywords || [];
        if(kws.indexOf('stealth') < 0) kws.push('stealth');
        target.keywords = kws;
        target._stealthTurns = Math.max(target._stealthTurns || 0, turns);
        logEvent('stealth-grant', {targetUid: target.uid, by: card.id, turns});
        return true;
      }
      case 'aura': {
        // 보드 매칭 unit 에 stat 부여 (간단 구현 V1: 부착 즉시 현재 보드만, 새 unit 영향 없음)
        if(!effect.filter || !effect.stat) return false;
        const filter = effect.filter;
        const stat = effect.stat;
        const amt = effect.amount || 0;
        if(amt === 0) return false;
        const matched = (ctx.side.board || []).filter(u => {
          if(u.isDead) return false;
          if(filter.type === 'id_contains' && u.id && typeof u.id === 'string'){
            return u.id.toLowerCase().includes(String(filter.value).toLowerCase());
          }
          // 2026-05-30 구조 이슈 B fix — role_eq filter 분기 (sk_tough/sk_rage/sk_hero_*_ranger_archery 4장 효과 0 → 정상화)
          // 주의: 데이터의 filter.value 는 'ranged'/'melee'/'magic' (= dmgType) 인데 unit.role 은 attack/defense/support 뿐.
          // role 또는 dmgType 둘 중 하나라도 매칭하면 통과 (ability "원거리 유닛" → dmgType:'ranged' 의도).
          if(filter.type === 'role_eq'){
            if(u.role && u.role === filter.value) return true;
            if(u.dmgType && u.dmgType === filter.value) return true;
            return false;
          }
          /* diagnosis-confirmed: 2026-06-04 사유: feature — taunt_or_role_eq 필터 추가 (sk_rage 광전사: 수호자거나 근접) */
          // taunt 키워드 OR role/dmgType 매칭 (합집합). value 로 role 분기 재사용.
          if(filter.type === 'taunt_or_role_eq'){
            if((u.keywords || []).includes('taunt')) return true;
            if(u.role && u.role === filter.value) return true;
            if(u.dmgType && u.dmgType === filter.value) return true;
            return false;
          }
          return false;
        });
        if(matched.length === 0) return false;
        matched.forEach(u => {
          if(stat === 'ATK'){
            u.curATK = (u.curATK || 0) + amt;
            u.baseATK = u.curATK;
          } else if(stat === 'HP'){
            u.maxHP = (u.maxHP || u.HP || 0) + amt;
            u.curHP += amt;
          }
          logEvent('aura-grant', {targetUid: u.uid, by: card.id, stat, amount: amt});
        });
        return true;
      }
      case 'race_bond': {
        /* diagnosis-confirmed: 2026-06-07 사유: feature — 메커니즘 Race Bond(종족 결속). 보드에 같은 race 가 threshold 마리 이상이면 그 race unit 전체 stat +amount. V1: 적용 시점 1회 계산(aura 와 동일 한계, 실시간 재계산 V2). battle_system_decisions.md 2026-06-07 B-4. */
        const _race = effect.race;
        const _threshold = effect.threshold || 2;
        const _rstat = effect.stat;
        const _ramt = effect.amount || 0;
        if(!_race || !_rstat || _ramt === 0) return false;
        const _sameRace = (ctx.side.board || []).filter(u => u && !u.isDead && u.race === _race);
        if(_sameRace.length >= _threshold){
          _sameRace.forEach(u => {
            if(_rstat === 'ATK'){ u.curATK = (u.curATK || 0) + _ramt; u.baseATK = u.curATK; }
            else if(_rstat === 'HP'){ u.maxHP = (u.maxHP || u.HP || 0) + _ramt; u.curHP = (u.curHP || 0) + _ramt; }
            logEvent('race-bond-grant', {targetUid: u.uid, by: card.id, race: _race, stat: _rstat, amount: _ramt});
          });
        }
        return true;
      }
      case 'scry': {
        /* diagnosis-confirmed: 2026-06-07 사유: feature — 메커니즘 Scry(운명 정찰) dispatch. enemy(AI)는 자동 _scry(V1 다 유지), player 는 scry-prompt 이벤트 push → UI 모달(④-b)이 선택 후 Match._scry 호출. battle_system_decisions.md 2026-06-07 B-2. */
        const _sk = ctx.sourceSideKey;
        const _count = effect.count || 1;
        if(_sk === 'enemy'){
          Match._scry('enemy', _count, null);
        } else if(Array.isArray(Match.state.events)){
          Match.state.events.push({type:'scry-prompt', count: _count, side: _sk});
        }
        logEvent('scry-op', {side: _sk, count: _count});
        return true;
      }
      case 'summon': {
        /* diagnosis-confirmed: 2026-06-07 사유: feature — summonId/amount/boardCap 확장 (alpha_call 늑대 소환). 기존 호출자(stats 명시)는 동작 불변. 버그 픽스 아님. */
        // base 유닛 = effect.summonId 우선 (없으면 bundledByUnit). effect.stats 로 HP/ATK 명시, 없으면 baseUnit 스탯 계승.
        const baseId = effect.summonId || card.bundledByUnit;
        const baseUnit = baseId && window.UNITS ? window.UNITS.find(u => u.id === baseId) : null;
        // cap: boardCap 명시 우선 / summonId 신규 경로는 BOARD_MAX / 레거시(stats만)는 무제한(옛 동작 보존).
        const cap = (typeof effect.boardCap === 'number') ? effect.boardCap
                  : (effect.summonId ? BOARD_MAX : Infinity);
        const n = Math.max(1, effect.amount || 1);
        let count = 0;
        for(let i = 0; i < n; i++){
          if(ctx.side.board.length >= cap) break;
          let atk = (effect.stats && effect.stats.ATK != null) ? effect.stats.ATK
                  : (baseUnit ? (baseUnit.ATK || 0) : 0);
          // mirror_caster_atk: 시전자 (bundledByUnit 의 board unit, 없으면 hero) ATK 동기화 (sk_sun_wukong_clone)
          if(effect._todo === 'mirror_caster_atk'){
            const caller = (baseId && ctx.side.board.find(u => u.id === baseId && !u.isDead))
                         || ctx.side.hero;
            if(caller && caller.curATK != null) atk = caller.curATK;
          }
          const hp = (effect.stats && effect.stats.HP != null) ? effect.stats.HP
                   : (baseUnit ? (baseUnit.HP || 1) : 1);
          const spec = {
            id:        baseUnit ? baseUnit.id : (card.id + '_summon'),
            name:      baseUnit ? baseUnit.name : '소환수',
            element:   card.element || 'earth',
            role:      'attack',
            rarity:    'bronze',
            kind:      'unit',
            HP:        hp,
            ATK:       atk,
            NEED_SOUL: 0,
            SOUL:      0,
            keywords:  Array.isArray(effect.keywords) ? effect.keywords.slice() : [],
            ability:   '',
            desc:      '',
          };
          // summonId 신규 경로: baseUnit 전투 속성(dmgType/role/rarity/element) 계승 → 소환수가 원본처럼 행동.
          if(effect.summonId && baseUnit){
            spec.dmgType = baseUnit.dmgType || 'melee';
            spec.role    = baseUnit.role || 'attack';
            spec.rarity  = baseUnit.rarity || 'bronze';
            spec.element = baseUnit.element || spec.element;
          }
          const summoned = instantiate(spec);
          summoned.exhausted = true; // 소환 멀미
          ctx.side.board.push(summoned);
          logEvent('summon', {byCard: card.id, uid: summoned.uid, sideKey: ctx.sourceSideKey, atk});
          count++;
        }
        return count > 0;
      }
      case '_todo': {
        // op 자체가 _todo 인 경우 — _todo 값별 분기
        switch(effect._todo){
          case 'one_time_revive_50pct': {
            // attach-unit/hero 카드 — 부착 대상에 _reviveOnce 부여 (사망 시 1회 부활)
            const target = ctx.attachTarget || ctx.side.hero;
            if(!target || target.isDead) return false;
            target._reviveOnce = effect.percent || 50;  // HP 회복 비율
            logEvent('revive-grant', {targetUid: target.uid, by: card.id, percent: target._reviveOnce});
            return true;
          }
          case 'steal_random_hand_card': {
            // sk_rogue_steal: 적 손패 1장 무작위 가져오기 (사용 시 일반 처리로 소멸)
            const sourceSide = ctx.side;
            const enemySideKey = ctx.sourceSideKey === 'player' ? 'enemy' : 'player';
            const enemySide = Match.state[enemySideKey];
            if(!sourceSide || !enemySide) return false;
            if(enemySide.hand.length === 0){
              logEvent('steal-empty', {by: card.id});
              return true;  // 시도는 했지만 손패 비어있음
            }
            if(sourceSide.hand.length >= HAND_MAX){
              logEvent('steal-burn', {by: card.id, reason:'hand-full'});
              return true;
            }
            const idx = Math.floor(_rand() * enemySide.hand.length);
            const stolen = enemySide.hand.splice(idx, 1)[0];
            sourceSide.hand.push(stolen);
            logEvent('steal-card', {by: card.id, fromSide: enemySideKey, cardId: stolen.id});
            return true;
          }
          /* diagnosis-confirmed: 2026-06-03 사유: feature — _todo op 16종 구현 (티어 1+2). 버그 픽스 아님. */
          // ── 드로우 계열 (즉시 / 지속 / 다음턴) ──
          case 'draw_1':
          case 'draw_2': {
            const n = effect._todo === 'draw_2' ? 2 : 1;
            const drawn = Match._drawCards(ctx.side, ctx.sourceSideKey, n);
            logEvent('draw-spell', {by: card.id, side: ctx.sourceSideKey, requested: n, drawn});
            return true;
          }
          case 'persistent_extra_draw_per_turn': {
            // 매 라운드 +1 드로우 (지속). _drawHandForSide 가 _extraDraw 합산.
            ctx.side._extraDraw = (ctx.side._extraDraw || 0) + 1;
            logEvent('extra-draw-grant', {by: card.id, side: ctx.sourceSideKey, persistent: true, total: ctx.side._extraDraw});
            return true;
          }
          case 'next_turn_extra_draw_1': {
            // 다음 라운드 1회 +1 드로우. _drawHandForSide 가 소비 후 0 reset.
            ctx.side._nextTurnExtraDraw = (ctx.side._nextTurnExtraDraw || 0) + 1;
            logEvent('extra-draw-grant', {by: card.id, side: ctx.sourceSideKey, persistent: false, total: ctx.side._nextTurnExtraDraw});
            return true;
          }
          // ── 처형 (rarity_below 미만 적 즉살) ──
          case 'instant_kill': {
            // spell-target (sk_execute/godslayer) 은 attachTarget 미설정 → opts 로 해석.
            const t = ctx.attachTarget || (ctx.opts && Match._resolveTarget(ctx.opts));
            if(!t || t.isDead) return false;
            if(!_rarityBelow(t.rarity, effect.condition && effect.condition.rarity_below)){
              logEvent('execute-immune', {targetUid: t.uid, rarity: t.rarity, by: card.id});
              return true;  // 시도는 함 (코스트 소모 정당) — 등급 높아 면역
            }
            // DEF 무시 + 반사 면제로 확실히 처형. _reviveOnce 있으면 그게 부활 처리 (의도).
            Match._damage(t, (t.curHP || 0) + (t._def || 0), {sourceCard: card, _pierceDef: true, _noReflect: true});
            logEvent('instant-kill', {targetUid: t.uid, by: card.id});
            return true;
          }
          // ── 부활 부여 (지정 아군 사망 시 1회 full 부활, rarity_below 가드) ──
          case 'revive_on_death': {
            const target = ctx.attachTarget || (ctx.opts && Match._resolveTarget(ctx.opts)) || ctx.side.hero;
            if(!target || target.isDead) return false;
            if(!_rarityBelow(target.rarity, effect.condition && effect.condition.rarity_below)){
              logEvent('revive-immune', {targetUid: target.uid, rarity: target.rarity, by: card.id});
              return true;
            }
            target._reviveOnce = 100;  // 즉시 부활 = full HP (사망 직전 _damage 2391 분기가 소비)
            logEvent('revive-grant', {targetUid: target.uid, by: card.id, percent: 100});
            return true;
          }
          // ── 무적 (지정 아군: 공격/반격 그대로 반사 + 무피해, 보드 유지) ──
          case 'reflect_all_damage': {
            const target = ctx.attachTarget || (ctx.opts && Match._resolveTarget(ctx.opts)) || ctx.side.hero;
            if(!target || target.isDead) return false;
            target._reflectAll = true;
            logEvent('reflect-all-grant', {targetUid: target.uid, by: card.id});
            return true;
          }
          // ── 아군 경험치 부여 (matchXP — 시그니처 사용과 동일 자동 레벨업 흐름) ──
          // teach/learn 은 spell-target → attachTarget 미설정 → opts 로 해석.
          case 'grant_ally_exp_1':
          case 'grant_ally_exp_2': {
            const t = ctx.attachTarget || (ctx.opts && Match._resolveTarget(ctx.opts));
            if(!t || t.isDead) return false;
            const amt = effect._todo === 'grant_ally_exp_2' ? 2 : 1;
            const isHero = t.kind === 'hero' || t._isHero === true;
            if(isHero){
              t.matchXP = (t.matchXP || 0) + amt;
              _autoHeroLevelUpCheck(ctx.side, t);
            } else {
              if((t._matchLevel || 1) < (t._matchMaxLevel || UNIT_MAX_LEVEL)){
                t._matchExp = (t._matchExp || 0) + amt;
                _autoUnitLevelUpCheck(t);
              }
            }
            logEvent('grant-exp', {targetUid: t.uid, by: card.id, amount: amt, isHero});
            return true;
          }
          // ── 영혼 흡수 (지정 아군 잔여 HP 1:1 영혼력 치환 + 그 아군 제물 사망) ──
          case 'convert_ally_hp_to_soul': {
            const t = ctx.attachTarget || (ctx.opts && Match._resolveTarget(ctx.opts));
            if(!t || t.isDead) return false;
            // 자기 영웅 제물 금지 (매치 종료 방지)
            if(t === ctx.side.hero || t.kind === 'hero' || t._isHero){
              logEvent('soul-drain-invalid', {by: card.id, reason: 'hero'});
              return true;
            }
            const gained = Math.max(0, t.curHP || 0);
            ctx.side.soulPool = (ctx.side.soulPool || 0) + gained;  // 1:1 치환
            // 제물 사망 — DEF 무시 + 반사 면제로 확실히 처리
            Match._damage(t, (t.curHP || 0) + (t._def || 0), {sourceCard: card, _pierceDef: true, _noReflect: true});
            logEvent('soul-drain', {targetUid: t.uid, by: card.id, soulGained: gained, pool: ctx.side.soulPool});
            return true;
          }
          // ── 화염 각인 (지정 보드 유닛 다음 공격 1회: ATK +1 + 화상 부여) — Match.attack 가 소비 ──
          case 'flame_imbue': {
            const t = ctx.attachTarget || (ctx.opts && Match._resolveTarget(ctx.opts));
            if(!t || t.isDead || t.kind === 'hero' || t._isHero) return false;
            t._imbueAtkBonus = (t._imbueAtkBonus || 0) + (effect.atkBonus || 1);
            t._imbueBurn = Math.max(t._imbueBurn || 0, effect.burnAmount || 1);
            t._imbueBurnTurns = Math.max(t._imbueBurnTurns || 0, effect.turns || 1);
            logEvent('flame-imbue-grant', {targetUid: t.uid, by: card.id, atkBonus: t._imbueAtkBonus, burn: t._imbueBurn});
            return true;
          }
          // ── 발화 (다음 화염 스펠 1개 강화 충전 — playCard 가 _computeFireUpgrade 로 소비) ──
          case 'upgrade_fire_spells_next_turn': {
            ctx.side._fireUpgradePending = true;
            logEvent('fire-upgrade-pending', {side: ctx.sourceSideKey, by: card.id});
            return true;
          }
          /* diagnosis-confirmed: 2026-06-07 사유: feature — evade_once(민첩함): 부착 대상(스펠주인)에 1회 회피 부여. 버그 픽스 아님. */
          case 'evade_once': {
            const t = ctx.attachTarget || ctx.caster || ctx.side.hero;
            if(!t || t.isDead) return false;
            t._evadeOnce = (t._evadeOnce | 0) + 1;
            logEvent('evade-grant', {targetUid: t.uid, by: card.id, total: t._evadeOnce});
            return true;
          }
          default:
            // 알 수 없는 _todo — silent skip
            return false;
        }
      }
      case 'attach_marker': {
        // 대상(주로 적 1체) 에 _markerBonusDmg 부착. 그 대상이 받는 모든 데미지에 +amount.
        // _markerTurns 만료 시 자동 회수 (_tickStatusEffects).
        const amt = effect.amount || 0;
        const turns = effect.turns || 1;
        if(amt <= 0) return false;
        targets.forEach(t => {
          if(t.isDead) return;
          t._markerBonusDmg = (t._markerBonusDmg || 0) + amt;
          t._markerTurns = Math.max(t._markerTurns || 0, turns);
          logEvent('marker-grant', {targetUid: t.uid, by: card.id, amount: amt, turns});
        });
        return true;
      }
      case 'modifier': {
        // 진영 전역 buff. 매 턴 _modifiers turnsLeft -=1. 현재 stat='heal' 만 사용.
        const amt = effect.amount || 0;
        const turns = effect.turns || 1;
        const stat = effect.stat || 'heal';
        if(amt === 0) return false;
        const side = ctx.side;
        if(!side) return false;
        side._modifiers = side._modifiers || [];
        side._modifiers.push({stat, amount: amt, turnsLeft: turns});
        logEvent('modifier-grant', {side: ctx.sourceSideKey, stat, amount: amt, turns});
        return true;
      }
      case 'next_card_discount': {
        // 다음 카드의 NEED_SOUL -amount (filter 매칭 시). 1회성 — playCard 에서 소모.
        const amt = effect.amount || 0;
        if(amt === 0) return false;
        const side = ctx.side;
        if(!side) return false;
        side._nextDiscount = {amount: amt, filter: effect.filter || null};
        logEvent('discount-set', {side: ctx.sourceSideKey, amount: amt, filter: effect.filter});
        return true;
      }
      case 'next_card_damage_buff': {
        // 다음 카드의 damage +amount (filter 매칭 시). 1회성 — _dispatchEffect 'damage' 에서 소모.
        const amt = effect.amount || 0;
        if(amt === 0) return false;
        const side = ctx.side;
        if(!side) return false;
        side._nextDmgBuff = {amount: amt, filter: effect.filter || null};
        logEvent('dmg-buff-set', {side: ctx.sourceSideKey, amount: amt, filter: effect.filter});
        return true;
      }
    }
    return false;
  };

  // _nextDiscount / _nextDmgBuff 의 filter 매칭 헬퍼.
  // filter 객체:
  //  - {type:'kind_prefix', value:'spell'}            — kind 가 'spell-' 로 시작
  //  - {type:'element_kind', element:'fire', kindPrefix:'spell'} — element + kind 동시
  //  - {type:'id_contains', value:'shot|fire|arrow'}  — id 에 |-구분 키워드 포함
  //  - null/undefined                                  — 모든 카드 매칭
  function _nextCardFilterMatch(filter, card){
    if(!filter) return true;
    if(!card) return false;
    if(filter.type === 'kind_prefix'){
      return card.kind && String(card.kind).startsWith(filter.value);
    }
    if(filter.type === 'element_kind'){
      const elemOk = !filter.element || card.element === filter.element;
      const kindOk = !filter.kindPrefix || (card.kind && String(card.kind).startsWith(filter.kindPrefix));
      return elemOk && kindOk;
    }
    if(filter.type === 'id_contains'){
      if(!card.id) return false;
      const id = String(card.id).toLowerCase();
      return String(filter.value).toLowerCase().split('|').some(tok => tok && id.includes(tok));
    }
    return false;
  }
  Match._nextCardFilterMatch = _nextCardFilterMatch;  // export (테스트 편의)

  // target 해석 — effect.target 문자열 enum 을 실제 unit 배열로
  Match._resolveEffectTargets = function(effect, ctx){
    const st = Match.state;
    if(!st || !ctx) return [];
    const callerSide = ctx.side;
    if(!callerSide) return [];
    const enemySide  = (ctx.sourceSideKey === 'player') ? st.enemy : st.player;

    // target 없는 op (caller-side global 또는 self-driven) — 진입 가드 통과용 placeholder
    /* diagnosis-confirmed: 2026-06-07 사유: feature — 메커니즘 overload/race_bond 글로벌 op 등록 (target 없음, [null] placeholder). battle_system_decisions.md 2026-06-07 B. */
    if(effect.op === 'soul_gain' || effect.op === 'summon' || effect.op === 'self_destruct' || effect.op === 'aura' || effect.op === 'stealth'
       || effect.op === 'modifier' || effect.op === 'next_card_discount' || effect.op === 'next_card_damage_buff'
       || effect.op === 'refund'
       || effect.op === 'overload' || effect.op === 'race_bond' || effect.op === 'scry' /* diagnosis-confirmed: 2026-06-07 사유: feature — scry 글로벌 op 등록 (target 없음). */
       || effect.op === '_todo'){
      return [null];
    }

    // attach 카드의 self/ally_one/enemy_one 은 attachTarget 우선
    if(ctx.attachTarget){
      if(effect.target === 'self' || effect.target === 'ally_one' || effect.target === 'enemy_one'){
        return ctx.attachTarget.isDead ? [] : [ctx.attachTarget];
      }
    }

    switch(effect.target){
      case 'self':
        /* diagnosis-confirmed: 2026-06-06 사유: feature — #28 self 는 시전자(ctx.caster) 우선. 동료 시그(불타는 여의봉)는 board 의 오공에 붙어야 함. caster 없으면 hero fallback (영웅 스펠 호환). */
        if(ctx.caster && !ctx.caster.isDead) return [ctx.caster];
        return callerSide.hero ? [callerSide.hero] : [];
      case 'enemy_one': {
        const t = ctx.opts && Match._resolveTarget(ctx.opts);
        return t ? [t] : [];
      }
      case 'enemy_all':
        return enemySide.board.filter(u => !u.isDead);
      case 'enemy_all_incl_hero': {
        // 2026-05-17 — 광역 + hero 포함 (sk_dragon_flame "모든 적군" mental model)
        const arr = enemySide.board.filter(u => !u.isDead);
        if(enemySide.hero && !enemySide.hero.isDead) arr.push(enemySide.hero);
        return arr;
      }
      case 'enemy_n': {
        const all = enemySide.board.filter(u => !u.isDead);
        return all.slice(0, effect.count || 1);
      }
      case 'enemy_adjacent': {
        const t0 = ctx.opts && Match._resolveTarget(ctx.opts);
        if(!t0) return [];
        const idx = enemySide.board.indexOf(t0);
        if(idx < 0) return [];
        const adj = [enemySide.board[idx-1], enemySide.board[idx+1]].filter(u => u && !u.isDead);
        return adj;
      }
      case 'ally_one': {
        const at = ctx.opts && Match._resolveTarget(ctx.opts);
        return at ? [at] : [];
      }
      case 'ally_all':
        return callerSide.board.filter(u => !u.isDead);
      case 'hero':
        return callerSide.hero ? [callerSide.hero] : [];
      case 'random_ally': {
        const all = callerSide.board.filter(u => !u.isDead);
        return all.length ? [all[Math.floor(_rand() * all.length)]] : [];
      }
      default:
        return [];
    }
  };

  // 시간제 attach 만료 처리 — 매 턴 시작 시 자기 진영 unit/hero 의 _remainingTurns 감소.
  // 0 이 되면 DEF/reflect 회수 + 임시 키워드 제거 + attachments 에서 제거.
  Match._tickTimedAttachments = function(side){
    if(!side) return;
    const targets = [side.hero, ...(side.board || [])].filter(t => t && !t.isDead);
    targets.forEach(t => {
      if(!t.attachments || t.attachments.length === 0) return;
      const expiring = [];
      t.attachments.forEach(c => {
        if(typeof c._remainingTurns !== 'number') return;  // 영구 attach (defTurns 없음)
        c._remainingTurns -= 1;
        if(c._remainingTurns <= 0) expiring.push(c);
      });
      if(expiring.length === 0) return;
      // 만료 attach 효과 회수
      expiring.forEach(c => {
        if(c.DEF) t._def = Math.max(0, (t._def || 0) - c.DEF);
        if(c.reflectAmt) t._reflect = Math.max(0, (t._reflect || 0) - c.reflectAmt);
        /* diagnosis-confirmed: 2026-06-06 사유: feature — 반사화상 만료 회수 (reflectAmt 경로 복제) */
        if(c.reflectBurnAmt) t._reflectBurn = Math.max(0, (t._reflectBurn || 0) - c.reflectBurnAmt);
      });
      // attachments 정리
      t.attachments = t.attachments.filter(c => !expiring.includes(c));
      // 키워드 재계산 — base + 살아있는 attach
      const remainingKws = new Set([...(t._baseKeywords || [])]);
      (t.attachments || []).forEach(c => (c.keywords || []).forEach(k => remainingKws.add(k)));
      t.keywords = [...remainingKws];
      // turns 동기화 (남은 attach 의 max)
      /* diagnosis-confirmed: 2026-06-06 사유: feature — 반사화상 turns 동기화 (reflectAmt 경로 복제) */
      let maxDefT = 0, maxRefT = 0, maxRefBurnT = 0;
      (t.attachments || []).forEach(c => {
        if(typeof c._remainingTurns === 'number'){
          if(c.DEF)             maxDefT = Math.max(maxDefT, c._remainingTurns);
          if(c.reflectAmt)      maxRefT = Math.max(maxRefT, c._remainingTurns);
          if(c.reflectBurnAmt)  maxRefBurnT = Math.max(maxRefBurnT, c._remainingTurns);
        }
      });
      t._defTurns     = (t._def     > 0) ? maxDefT : 0;
      t._reflectTurns = (t._reflect > 0) ? maxRefT : 0;
      t._reflectBurnTurns = (t._reflectBurn > 0) ? maxRefBurnT : 0;
      logEvent('attach-expire', {targetUid: t.uid, count: expiring.length});
    });
  };

  /* diagnosis-confirmed: 2026-06-06 사유: feature — #28 임시 스탯 버프 만료. 라운드 종료 시 양측 unit/hero 의 _tempStatBuffs roundsLeft 감소, 0 도달 시 stat 회수.
     사용자 명시 (2026-06-06): "라운드 종료 시 만료" + "적턴이던 내턴이던 효과들은 사라지는걸로" → 라운드 경계 전역 만료 (대칭). 보드유닛턴마다 깎지 않음 (1라운드 = 4~6 보드턴 전체 지속). */
  Match._tickTempStatBuffs = function(){
    const st = Match.state;
    if(!st) return;
    ['player', 'enemy'].forEach(sideKey => {
      const side = st[sideKey];
      if(!side) return;
      const units = [side.hero, ...(side.board || [])].filter(u => u);
      units.forEach(t => {
        if(!Array.isArray(t._tempStatBuffs) || t._tempStatBuffs.length === 0) return;
        const expiring = [];
        t._tempStatBuffs.forEach(b => {
          b.roundsLeft -= 1;
          if(b.roundsLeft <= 0) expiring.push(b);
        });
        if(expiring.length === 0) return;
        expiring.forEach(b => {
          if(b.stat === 'ATK'){
            t.curATK = Math.max(0, (t.curATK || 0) - b.amount);
          } else if(b.stat === 'HP' && b.amount > 0){
            t.maxHP = Math.max(1, (t.maxHP || 0) - b.amount);
            t.curHP = Math.min(t.curHP, t.maxHP);
          }
          logEvent('temp-buff-expire', {targetUid: t.uid, stat: b.stat, amount: b.amount, by: b.by});
        });
        t._tempStatBuffs = t._tempStatBuffs.filter(b => b.roundsLeft > 0);
      });
    });
  };

  // ───────── 키워드 트리거 ─────────
  // 자동 합성된 ability 텍스트는 Phase E 의 파서에서 처리. 여기는 keywords 배열 기반만.
  // battlecry: 소환 시 — 데이터의 keywords 에 'battlecry' 표기된 경우만. 효과 자체는 ability 텍스트 → 추후 파서.
  // aura: 보드 동안 — 매 turn-begin 에 재계산 hook (현재는 placeholder)
  // deathrattle: 사망 시
  // taunt: targeting 단계에서 강제 — Match._validAttackTargets 에서 사용
  Match._triggerKeyword = function(unit, when, sideKey, opts){
    const kws = unit.keywords || [];
    if(kws.indexOf(when) < 0) return;
    logEvent('keyword', {when, unitId: unit.id, sideKey});
    // 키워드 알약/UI 연출용 로그. 실제 효과 발동은 _fireTriggerEffects (effects[].trigger 기반).
  };

  /* diagnosis-confirmed: 2026-06-11 사유: feature — 능력 트리거(battlecry/deathrattle) effects dispatch 배선. 옛 placeholder(_triggerKeyword 로그 전용) 가 미배선 상태였던 기능 구현. unit_data_guide §능력 트리거 정본. */
  // ───────── 능력 트리거 effects dispatch (2026-06-11 배선 — unit_data_guide §능력 트리거 정본) ─────────
  // 유닛 effects[] 중 trigger 가 when 인 것만 _applyEffects 로 dispatch.
  //   when='onPlay'  (battlecry)   : trigger 미지정(기본 onPlay) 도 포함 → 소환 시 1회.
  //   when='onDeath' (deathrattle) : trigger='onDeath' 명시만 → 사망 시 1회 (_cleanupBoard 에서 호출, 반사/사망 재귀 회피).
  //   when='passive' (aura)        : 별도 cluster (보드 변동 실시간 재계산) — 이 헬퍼는 발동 안 함.
  // caster = unit (방금 소환/사망한 그 인스턴스) → self/ally 타겟 해석 정확. sourceSideKey = unit 진영.
  Match._fireTriggerEffects = function(unit, when, sideKey){
    if(!unit || !Array.isArray(unit.effects) || unit.effects.length === 0) return {applied:0, skipped:0};
    const fx = unit.effects.filter(e => {
      const t = (e && e.trigger) ? e.trigger : 'onPlay';
      return t === when;
    });
    if(fx.length === 0) return {applied:0, skipped:0};
    /* diagnosis-confirmed: 2026-06-11 사유: feature — 트리거 effects 에 caster dmgType 전파 (magic 자폭 = DEF 무시 정합, 04-balance 데미지 공식). */
    return Match._applyEffects(
      {effects: fx, kind: unit.kind, dmgType: unit.dmgType, keywords: []},
      {side: Match.state[sideKey], sourceSideKey: sideKey, caster: unit}
    );
  };

  // ───────── 공격 ─────────
  // sideKey: 행동자 진영 (= state.side 여야 함)
  // attackerUid: 보드 유닛 또는 영웅 uid
  // targetSpec: {targetSide, targetUid}
  Match.attack = function(sideKey, attackerUid, targetSpec){
    const st = Match.state;
    if(!st || st.winner) return {ok:false, reason:'매치 종료'};
    // UI 통합 cluster (2026-05-11) — phase 룰 분기.
    //  PHASE.BOARD: 큐 cursor 의 entry.sideKey 가 행동 권한 (st.side 무관 — 보드 페이즈 양측 번갈아).
    //  PHASE.CARD : 옛 흐름 그대로 (st.side === sideKey 검사). UI 단계에서 phase=card 시 차단 (61_match_ui.js).
    if(st.phase === PHASE.BOARD){
      const entry = (st.boardTurnQueue || [])[st.boardTurnCursor | 0];
      if(!entry || entry.sideKey !== sideKey) return {ok:false, reason:'내 보드턴 아님'};
      // 2026-05-29 #19-3 — cursor.unitUid 강제 폐기 (사용자 의도: 자기 보드 어느 unit 이든 자유 선택).
      //   HS/Snap/LoR/M&M Fates 모두 표준. queue.entry 는 양측 turn 카운터 역할 (sword 시스템 정합).
      //   side 검사만 유지 (player 차례 / enemy 차례 강제).
    } else {
      if(st.side !== sideKey) return {ok:false, reason:'내 턴 아님'};
    }

    const side = st[sideKey];
    const attacker = (side.hero && side.hero.uid === attackerUid)
      ? side.hero
      : side.board.find(u => u.uid === attackerUid);
    if(!attacker) return {ok:false, reason:'공격자 없음'};
    if(attacker.isDead) return {ok:false, reason:'공격자 사망'};
    if(attacker.exhausted) return {ok:false, reason:'소환 멀미'};
    if(attacker.attackedThisTurn) return {ok:false, reason:'이미 공격함'};
    /* diagnosis-confirmed: 2026-06-14 사유: bug-fix — 기절(stun) 코어 안전망 (project_stun_dead_mechanic, Workflow 진단 wauace4zn).
       정상 흐름은 _beginBoardPhase 큐 제외 + _acted=true 로 차단되나, 자유클릭(#19-3)은 cursor 무관 attack 을
       허용하고 Match.attack 가 _acted 를 검사 안 하므로, stun 유닛 자유클릭 우회를 여기서 이중 차단. */
    if(attacker._stunTurns && attacker._stunTurns > 0) return {ok:false, reason:'기절 중'};

    const enemySideKey = sideKey === 'player' ? 'enemy' : 'player';
    const enemySide = st[enemySideKey];
    const target = Match._resolveAttackTarget(enemySide, targetSpec);
    if(!target) return {ok:false, reason:'타겟 없음'};

    // taunt 강제 — 적 보드에 taunt 살아있으면 taunt 만 타겟 허용
    // 2026-05-17 PHASE 6 dmgType: magic 공격자는 taunt 무시 (침투 마법 — hero/후열 직접 가능)
    const taunts = tauntsOf(enemySide);
    const attackerIsMagic = attacker && attacker.dmgType === 'magic';
    if(!attackerIsMagic && taunts.length > 0 && taunts.indexOf(target) < 0 && target !== enemySide.hero){
      return {ok:false, reason:'수호자 우선'};
    }
    if(!attackerIsMagic && taunts.length > 0 && target === enemySide.hero){
      return {ok:false, reason:'수호자가 영웅을 보호 중'};
    }

    // stealth (은폐) — 1회 회피 룰 (2026-05-18 사용자 결정 — 옛 N턴 공격 차단 룰 폐기)
    // 사용자 명시: "은폐 = 1회 회피". 적 attack 시도 → stealth 소멸 + 데미지 0 + attacker 정상 행동 처리.
    // 이전 룰 (N턴 stealth + 공격 차단) 은 board phase deadlock 위험 (sim_battle 100매치 12% 재현). 폐기.
    if(target && (target.keywords || []).indexOf('stealth') >= 0){
      // stealth 회피 발동 — keywords 제거 + _stealthTurns=0 + 회피 이벤트 push
      target.keywords = (target.keywords || []).filter(k => k !== 'stealth');
      target._stealthTurns = 0;
      logEvent('stealth-dodge', {targetUid: target.uid, attackerUid: attacker.uid});
      if(Array.isArray(st.events)){
        st.events.push({type:'stealth-dodge', targetUid: target.uid, attackerUid: attacker.uid, targetSide: enemySideKey});
      }
      // attacker 정상 행동 처리 — board phase 면 _acted=true + cursor 진행
      attacker.attackedThisTurn = true;
      if(st.phase === PHASE.BOARD && !st.winner){
        attacker._acted = true;
        /* diagnosis-confirmed: 2026-06-07 사유: bug-fix — XP 행동주체 귀속(옵션1). attacker+sideKey 전달 → 자유 클릭 공격도 행동한 unit 이 XP. */
        try { Match._advanceBoardTurn(attacker, sideKey); } catch(e){}
      }
      return {ok:true, dodged:true};
    }

    /* diagnosis-confirmed: 2026-06-07 사유: feature — evade_once(민첩함) 1회 회피 소비. stealth dodge 와 동형. 버그 픽스 아님. */
    // 부여된 _evadeOnce 1 소비 → 데미지 0 + attacker 정상 행동 처리 (stealth 와 동일 흐름).
    if(target && (target._evadeOnce | 0) > 0){
      target._evadeOnce -= 1;
      logEvent('evade-dodge', {targetUid: target.uid, attackerUid: attacker.uid, remaining: target._evadeOnce});
      if(Array.isArray(st.events)){
        st.events.push({type:'evade-dodge', targetUid: target.uid, attackerUid: attacker.uid, targetSide: enemySideKey});
      }
      attacker.attackedThisTurn = true;
      if(st.phase === PHASE.BOARD && !st.winner){
        attacker._acted = true;
        /* diagnosis-confirmed: 2026-06-07 사유: bug-fix — XP 행동주체 귀속(옵션1). attacker+sideKey 전달. */
        try { Match._advanceBoardTurn(attacker, sideKey); } catch(e){}
      }
      return {ok:true, dodged:true};
    }

    /* diagnosis-confirmed: 2026-06-16 사유: feature — 공격 피격 "팅" 밴드(데미지 3단계) 시스템, 사용자 "게임 적용" 컨펌. 버그 아님. */
    // 데미지 (단순 ATK) + flame_imbue 소비 (sk_pyromancer_flame_imbue — 다음 공격 1회 ATK+1 + 화상)
    // 2026-06-16 — _atkDmg 를 unit-attack push 보다 먼저 산출: 공격 피격 "팅" 밴드(≤5/6~9/10+) 판정용으로 이벤트에 dmg 동봉.
    let _atkDmg = attacker.curATK || 0;
    const _hasImbue = !!(attacker._imbueAtkBonus || attacker._imbueBurn);
    if(attacker._imbueAtkBonus) _atkDmg += attacker._imbueAtkBonus;

    // 2026-05-16 — 공격 모션 (HS 식 대각선 lunge overlap 70%). _damage 이전에 push.
    // design-confirmed: mockup/attack_motion/v4_overlap.html 사용자 "정본 적용 70%".
    if(Match.state && Array.isArray(Match.state.events)){
      Match.state.events.push({
        type: 'unit-attack',
        attackerUid: attacker.uid,
        attackerSide: sideKey,
        targetUid: target.uid,
        targetSide: enemySideKey,
        dmg: _atkDmg,   // 팅 밴드 판정용 (2026-06-16)
      });
    }

    Match._damage(target, _atkDmg, {sourceUnit: attacker});
    if(attacker._imbueBurn && target && !target.isDead){
      target._burnAmount = Math.max(target._burnAmount || 0, attacker._imbueBurn);
      target._burnTurns  = Math.max(target._burnTurns || 0, attacker._imbueBurnTurns || 1);
      logEvent('flame-imbue-burn', {targetUid: target.uid, amount: attacker._imbueBurn, turns: attacker._imbueBurnTurns || 1});
    }
    if(_hasImbue){ attacker._imbueAtkBonus = 0; attacker._imbueBurn = 0; attacker._imbueBurnTurns = 0; }  // 1회 소비

    attacker.attackedThisTurn = true;
    logEvent('attack', {by: attacker.uid, target: target.uid, dmg: _atkDmg});

    Match._cleanupBoard();
    Match._checkWinner();

    // Task A.4 (2026-05-10) — phase===BOARD 시 행동 완료 → _acted=true + 다음 보드턴 자동 cursor
    // K (2026-05-25) — _grantBoardActionExp 호출 폐기. _advanceBoardTurn 안 cursor 진행 직전 단일 트리거 (attack/skip 무관).
    if(st.phase === PHASE.BOARD && !st.winner){
      attacker._acted = true;
      /* diagnosis-confirmed: 2026-06-07 사유: bug-fix — XP 행동주체 귀속(옵션1). attacker+sideKey 전달 → 자유 클릭 공격도 행동한 unit 이 XP (cursor unit 아님). */
      try { Match._advanceBoardTurn(attacker, sideKey); }
      catch(e){ logEvent('advance-board-error', {error: String(e && e.message)}); }
    }

    return {ok:true, dmg: attacker.curATK, target};
  };

  Match._resolveAttackTarget = function(enemySide, spec){
    if(!spec) return null;
    if(spec.targetUid === '__hero__') return enemySide.hero;
    return enemySide.board.find(u => u.uid === spec.targetUid) || null;
  };

  // 데미지 적용 (HP 차감, 사망 마킹).
  // 2026-05-17 PHASE 6 dmgType 시스템 (design/battle_system_decisions.md):
  //   - sourceUnit.dmgType === 'magic'  → DEF 무시 + taunt 무시 (타겟 검증 단)
  //   - melee vs melee (스펠 X)        → 양쪽 반사 (target.curATK 만큼 attacker.HP 감소, M&M Fates 패턴)
  //   - ranged → 모든 타겟              → 반사 면제 (일방)
  Match._damage = function(target, amount, ctx){
    if(!target || target.isDead) return;
    let dmg = Math.max(0, amount|0);
    if(dmg === 0) return;

    // attach_marker — 대상에 부착된 _markerBonusDmg 추가 피해 (sk_hunter_mark 등)
    if(target._markerBonusDmg && target._markerBonusDmg > 0){
      const bonus = target._markerBonusDmg;
      dmg += bonus;
      logEvent('marker-add', {targetUid: target.uid, bonus, totalDmg: dmg});
    }

    // PHASE 6 dmgType 분석 (2026-05-17 / 2026-06-06 스펠 포함)
    /* diagnosis-confirmed: 2026-06-06 사유: feature — 스펠도 dmgType 데미지 계산 적용 (sourceCard.dmgType). magic 스펠 DEF 무시. 옛 코드는 sourceUnit 만 봐서 스펠 dmgType 무시됐음. */
    const attackerDmgType = (ctx && ctx.sourceUnit && ctx.sourceUnit.dmgType)
                          || (ctx && ctx.sourceCard && ctx.sourceCard.dmgType)
                          || null;
    const isSpell = !!(ctx && ctx.sourceCard);
    const isMagicAttack = attackerDmgType === 'magic';
    // magic 공격은 _pierceDef 동일 효과 (DEF 무시) — sk_guard_pierce_javelin 와 동일 분기 재사용
    const pierceDef = (ctx && ctx._pierceDef) || isMagicAttack;

    /* diagnosis-confirmed: 2026-06-15 사유: feature — 신성 6단계 물리피해 무적 (race_synergy §4). _physImmuneTurns>0 인 대상은 melee/ranged 공격 무피해 (magic·DOT 통과 — "물리" 한정). reflect/DEF 앞에서 차단(완전 무효). _tickStatusEffects 가 소유 진영 턴마다 -1. */
    if(target._physImmuneTurns > 0 && (attackerDmgType === 'melee' || attackerDmgType === 'ranged')){
      logEvent('phys-immune', {targetUid: target.uid, by: attackerDmgType});
      return;  // 물리 무피해
    }

    // DEF (보호막) 흡수 먼저 — pierceDef (마법 공격 또는 _pierceDef 플래그) 이면 우회
    if(target._def && target._def > 0 && !pierceDef){
      const absorbed = Math.min(target._def, dmg);
      target._def -= absorbed;
      dmg -= absorbed;
      logEvent('def-absorb', {targetUid: target.uid, absorbed, defLeft: target._def});
      if(target._def <= 0){ target._def = 0; target._defTurns = 0; }
    } else if(target._def && target._def > 0 && pierceDef){
      logEvent('def-pierce', {targetUid: target.uid, defBypass: target._def, by: (ctx && ctx.sourceCard && ctx.sourceCard.id) || (isMagicAttack ? 'magic-attack' : 'unknown')});
    }

    /* diagnosis-confirmed: 2026-06-15 사유: bug-fix repro (사용자 명시) — 암흑 흡혈 = 가해 유닛이 입힌 피해(dmg)만큼 자기 회복. ① 반격(_noReflect)일 때도 흡혈 ② 반사/반격 *앞*에서 회복 → 공격 유닛이 반격으로 죽기 전 흡혈로 생존(ATK3/HP2 가 HP3 유닛 치면 +3, 반격 -3 → HP2 생존) ③ overheal 허용(maxHP 초과 = 피의 보호막, 사용자 "HP 5"). dmg=DEF 흡수 후 실피해. */
    if(ctx && ctx.sourceUnit && ctx.sourceUnit._synLifesteal && dmg > 0 && !ctx.sourceUnit.isDead){
      const _src = ctx.sourceUnit;
      const _b = _src.curHP || 0;
      _src.curHP = _b + dmg;   // overheal 허용 (maxHP cap X — 사용자 명시 "HP 5")
      logEvent('synergy-lifesteal', {by: _src.uid, amount: dmg, hp: _src.curHP});
    }

    // 반사 (기존 attach 카드 _reflect 효과 — reflectAmt + reflectTurns)
    if(target._reflect && target._reflect > 0 && ctx && ctx.sourceUnit && !ctx._noReflect){
      const reflectDmg = target._reflect;
      logEvent('reflect', {fromUid: target.uid, toUid: ctx.sourceUnit.uid, amount: reflectDmg});
      Match._damage(ctx.sourceUnit, reflectDmg, {sourceUnit: target, _noReflect: true});
    }

    /* diagnosis-confirmed: 2026-06-06 사유: feature — 반사 화상(reflect_burn). 근접(melee) 공격자에만 화상 DOT 부여. 화염방패. */
    if(target._reflectBurn && target._reflectBurn > 0 && ctx && ctx.sourceUnit && !ctx._noReflect
       && ctx.sourceUnit.dmgType === 'melee' && !ctx.sourceUnit.isDead){
      const atk = ctx.sourceUnit;
      atk._burnAmount  = Math.max(atk._burnAmount || 0, target._reflectBurn);
      atk._burnTurns   = Math.max(atk._burnTurns  || 0, target._reflectBurnTurns || 1);
      atk._burnElement = atk._burnElement || 'fire';
      logEvent('reflect-burn', {fromUid: target.uid, toUid: atk.uid, amount: target._reflectBurn, turns: target._reflectBurnTurns || 1});
    }

    // _reflectAll (sk_invincible "무적") — 공격/반격을 그대로 반사 + 대상 무피해.
    // sourceUnit 있을 때만 (스펠/DOT 처럼 반사 대상 없으면 통상 피해). _noReflect 재귀 방지.
    if(target._reflectAll && ctx && ctx.sourceUnit && !ctx._noReflect){
      if(dmg > 0){
        logEvent('reflect-all', {fromUid: target.uid, toUid: ctx.sourceUnit.uid, amount: dmg});
        Match._damage(ctx.sourceUnit, dmg, {sourceUnit: target, _noReflect: true});
      }
      return;  // 대상 무피해 (무적)
    }

    // PHASE 6 melee vs melee 양쪽 반사 (2026-05-17 사용자 결정)
    // 공격자 melee 가 melee 방어자 칠 때, 방어자 ATK 만큼 공격자 HP 감소. 스펠/마법/원거리 면제.
    /* diagnosis-confirmed: 2026-06-07 사유: bug-fix — 옛 코드는 이 블록이 `if(dmg<=0) return`(보호막 완전 흡수) 뒤라, DEF 로 데미지가 0 이 되면 근접 반사가 silent fail 했음 (attach _reflect / reflect_burn 은 흡수 앞이라 발동 → 비대칭). 회귀 match-melee-reflect-def-absorb-v6 로 재현/검증. 흡수 체크 앞으로 이동해 근접 충돌 반사를 DEF 흡수와 독립으로 보장. */
    if(attackerDmgType === 'melee' && target.dmgType === 'melee' &&
       !isSpell && !(ctx && ctx._noReflect) && ctx && ctx.sourceUnit && !ctx.sourceUnit.isDead){
      const reflectMeleeDmg = target.curATK || 0;
      if(reflectMeleeDmg > 0){
        logEvent('melee-reflect-dmgtype', {fromUid: target.uid, toUid: ctx.sourceUnit.uid, amount: reflectMeleeDmg});
        /* diagnosis-confirmed: 2026-06-16 사유: feature — 근접반격 시각 이벤트(melee-reflect-dmgtype) 큐 push. 갤러리 mockup/melee_counter v5 컨펌. 코어 데미지 로직 무변경(아래 재귀 _damage 그대로) — 시각 큐에 연출 이벤트만 추가. 버그픽스 아님. */
        // UI _animMeleeReflect: 방어자 카운터스러스트 + 공격자 recoil + 묵직(셰이크/줌펀치/충격파). 숫자/HP는 재귀 _damage 의 'damage' 이벤트가 그림. unknown 환경(이벤트 미소비)에선 no-op.
        if(Match.state && Array.isArray(Match.state.events)){
          Match.state.events.push({
            type: 'melee-reflect-dmgtype',
            fromUid: target.uid,       fromSide: _findOwnerSide(target.uid),
            toUid: ctx.sourceUnit.uid, toSide: _findOwnerSide(ctx.sourceUnit.uid),
            amount: reflectMeleeDmg,
          });
        }
        Match._damage(ctx.sourceUnit, reflectMeleeDmg, {sourceUnit: target, _noReflect: true});
      }
    }

    if(dmg <= 0) return;  // 보호막에 완전 흡수
    target.curHP -= dmg;
    // 기여포인트 — 가해자(평타 sourceUnit / 스킬·스펠 _currentCaster) 입힌딜 ×1.0, 피격자 탱킹 ×0.5.
    //   반사 데미지(_noReflect)는 가해자 귀속 skip (이중계산 방지), 탱킹은 인정.
    {
      const _dealer = (ctx && ctx.sourceUnit) || (Match.state && Match.state._currentCaster) || null;
      if(_dealer && _dealer !== target && !(ctx && ctx._noReflect)) _addContrib(_dealer, dmg * CONTRIB.dmg);
      _addContrib(target, dmg * CONTRIB.tank);
    }
    /* diagnosis-confirmed: 2026-06-05 사유: feature — damage 이벤트에 dotElement 전파 (암흑 DOT 보라 연출 분기용) */
    logEvent('damage', {targetUid: target.uid, amount: dmg, hpAfter: target.curHP, dotElement: (ctx && ctx.dotElement) || null});
    /* diagnosis-confirmed: 2026-06-07 사유: feature — 메커니즘 Soul Siphon(영혼 흡수). 공격 unit 이 _soulSiphon 보유 시 실제 입힌 피해 × R 만큼 자기 영혼 회복. 반사 데미지(_noReflect)는 제외. battle_system_decisions.md 2026-06-07 B-7. */
    if(ctx && ctx.sourceUnit && ctx.sourceUnit._soulSiphon && !ctx._noReflect && dmg > 0){
      const _owner = _findOwnerSide(ctx.sourceUnit.uid);
      const _sside = _owner && Match.state && Match.state[_owner];
      if(_sside){
        const _gain = Math.floor(dmg * ctx.sourceUnit._soulSiphon);
        if(_gain > 0){
          _sside.soulPool = (_sside.soulPool || 0) + _gain;
          logEvent('soul-siphon', {by: ctx.sourceUnit.uid, dmg, gain: _gain, pool: _sside.soulPool});
        }
      }
    }
    /* diagnosis-confirmed: 2026-06-13 사유: feature — Cluster 3a dark lifesteal (원소 tier5 흡혈). _soulSiphon 패턴 미러 — _synLifesteal(dark, _recomputeSynergy 가 darkCount>=5 시 set) unit 이 피해 입히면 자기 영웅 +1 HEAL. 반사(_noReflect) 제외 (이중 방지). */
    /* diagnosis-confirmed: 2026-06-15 사유: bug-fix repro (사용자 시나리오 ATK3/HP2 vs HP3) — 암흑 흡혈을 위쪽(DEF 흡수 직후, 반사/반격 앞)으로 이동. 옛 위치(반격 뒤·+1·_noReflect 제외)는 공격 유닛이 반격으로 먼저 죽어 흡혈 skip. */
    // Phase 1A.4.5 — 시각 데미지 popup 이벤트 (모든 데미지 적용 — 스펠/공격/반사/DOT)
    // 2026-05-24 — rect 캐시 추가 (cleanup 후 popup fallback). unit-death 와 동일 패턴.
    let _dmgRect = null;
    if(typeof document !== 'undefined'){
      try {
        const _el = document.querySelector('[data-uid="' + target.uid + '"]');
        if(_el){
          const _r = _el.getBoundingClientRect();
          if(_r && _r.width > 0){
            _dmgRect = {left:_r.left, top:_r.top, width:_r.width, height:_r.height};
          }
        }
      } catch(e){}
    }
    if(Match.state && Array.isArray(Match.state.events)){
      Match.state.events.push({
        type: 'damage',
        targetUid: target.uid,
        amount: dmg,
        hpAfter: target.curHP,
        rect: _dmgRect,  // 2026-05-24 — cleanup 전 DOM rect 캐시 (fallback)
      });
    }
    if(target.curHP <= 0 && !target.isDead){
      // one_time_revive_50pct: 사망 직전 1회 부활 (sk_sun_wukong_revive)
      if(target._reviveOnce && target._reviveOnce > 0){
        const pct = target._reviveOnce;
        const cap = target.maxHP || target.HP || 1;
        target.curHP = Math.max(1, Math.floor(cap * pct / 100));
        target._reviveOnce = 0;  // 1회만 — 소멸
        logEvent('revive', {targetUid: target.uid, hp: target.curHP, percent: pct});
        return;  // 사망 처리 skip
      }
      /* diagnosis-confirmed: 2026-06-13 사유: feature — Cluster 3a holy revive_hero (원소 tier5). _recomputeSynergy 가 holyCount>=5 시 hero._synReviveOnce=1 set. 죽음 시 50% 부활 + _synReviveUsed 로 재-grant 차단 (holy 여전히 5+여도). _reviveOnce(손오공 카드) 와 별도 필드. */
      if(target._synReviveOnce && target._synReviveOnce > 0){
        const _rcap = target.maxHP || target.HP || 1;
        target.curHP = Math.max(1, Math.floor(_rcap * 0.5));
        target._synReviveOnce = 0;
        target._synReviveUsed = true;
        logEvent('synergy-revive', {targetUid: target.uid, hp: target.curHP});
        return;  // 사망 처리 skip
      }
      /* diagnosis-confirmed: 2026-06-15 사유: feature — 신성 t3 "유닛 사망 시 1회 즉시 부활(게임 내 1번)" (race_synergy §4). holy 시너지 ≥3(유닛) 활성 + side._holyReviveUsed 미사용 + 영웅 제외 유닛 → 50% HP 부활. _synReviveOnce(영웅 부활, Phase1 폐기)와 별개 side-level 1회 charge. */
      if(typeof RoF !== 'undefined' && RoF.Data && !RoF.Data.isHeroId(target.id) && !target._isHero){
        const _hoSide = _findOwnerSide(target.uid);
        const _hoS = _hoSide && Match.state && Match.state[_hoSide];
        if(_hoS && !_hoS._holyReviveUsed && typeof Match._countSynergy === 'function'){
          const _hc = Match._countSynergy(_hoS);
          if(((_hc.elemCount && _hc.elemCount.holy) || 0) >= 3){
            const _hcap = target.maxHP || target.HP || 1;
            target.curHP = Math.max(1, Math.floor(_hcap * 0.5));
            _hoS._holyReviveUsed = true;
            logEvent('holy-unit-revive', {targetUid: target.uid, hp: target.curHP});
            return;  // 사망 처리 skip
          }
        }
      }
      target.isDead = true;
      // 기여포인트 — 막타(처치) 보너스 +5 (가해자)
      {
        const _killer = (ctx && ctx.sourceUnit) || (Match.state && Match.state._currentCaster) || null;
        if(_killer && _killer !== target) _addContrib(_killer, CONTRIB.kill);
      }

      // Phase 1A.5 — unit-death 이벤트 + companion 사망 시 _pendingDisintegrate 큐
      const ownerSideKey = _findOwnerSide(target.uid);
      const isCompanion = _isCompanion(target);
      // 2026-05-17 사망 애니 fix — _cleanupBoard 가 즉시 호출되어 DOM 정리 → _animUnitDeath cloneNode 실패.
      // event push 시점 (cleanup 전, DOM 살아있음) 에 unit rect 캐시 → UI 가 fallback ghost 생성.
      let _deathRect = null;
      if(typeof document !== 'undefined'){
        try {
          const _el = document.querySelector('[data-uid="' + target.uid + '"]');
          if(_el){
            const _r = _el.getBoundingClientRect();
            if(_r && _r.width > 0){
              _deathRect = {left:_r.left, top:_r.top, width:_r.width, height:_r.height};
            }
          }
        } catch(e){}
      }
      if(Match.state && Array.isArray(Match.state.events)){
        Match.state.events.push({
          type: 'unit-death',
          targetUid: target.uid,
          unitId: target.id,
          unitName: target.name || target.id,
          isCompanion,
          side: ownerSideKey,
          rect: _deathRect,  // 2026-05-17 — cleanup 전 DOM rect 캐시
          cardData: target,  // 2026-05-24 — UI 가 mkMatchCard 으로 ghost 재구성 (race condition: spell-aoe 3s vs _cleanupBoard 1.5s)
        });
      }
      if(isCompanion && ownerSideKey){
        // Plan 2.A Task A.5 (2026-05-10) — 즉시 부서짐 (PHASE 6 pending push 룰 폐기).
        // 옛 _pendingDisintegrate 큐 흐름 폐기 — 사망 시점에 즉시 _disintegrateCards 호출 + events 큐 푸시.
        // _beginTurn 의 pending 처리 분기는 alias 로 보존 (큐가 비어있어 no-op, 회귀 호환).
        const ownerSide = Match.state[ownerSideKey];
        const matched = _collectBundledCards(ownerSide, target.id);
        const allUids = [...matched.hand, ...matched.deck];
        if(allUids.length){
          // 사전 스냅샷 (UI ghost 가 원래 위치에서 부서짐 — Phase 1A.5 패턴 보존)
          const snapshot = allUids.map(uid => {
            const handIdx = (ownerSide.hand || []).findIndex(c => c && c.uid === uid);
            const inDeck = handIdx < 0;
            const card = handIdx >= 0
              ? ownerSide.hand[handIdx]
              : (ownerSide.deck || []).find(c => c && c.uid === uid);
            return {uid, handIdx, inDeck, card};
          }).filter(s => s.card);
          const removed = _disintegrateCards(ownerSide, allUids);
          if(removed.length){
            Match.state.events.push({
              type: 'pending-disintegrate-trigger',  // 옛 이벤트명 보존 (UI 호환)
              side: ownerSideKey,
              unitId: target.id,
              unitName: target.name || target.id,
              removedSnapshot: snapshot,
              totalCount: removed.length,
            });
            logEvent('companion-death-disintegrate', {side: ownerSideKey, unitId: target.id, count: removed.length});
          }
        }
      }

      Match._triggerKeyword(target, 'deathrattle', null, ctx);
    }
  };

  // 사망 보드 청소 (영웅은 보드에서 제거 안 함 — 영웅 사망은 _checkWinner 에서)
  // Plan 2.B Phase F (2026-05-12): 사망 unit (companion) → gravePile push (XP/Level 보존, 부활 source).
  // Phase C 의 drawPile 셔플 환원 시 gravePile 도 합류 → 손패 draw → 보드 다시 깔기 = 부활.
  Match._cleanupBoard = function(){
    const st = Match.state;
    if(!st) return;
    ['player','enemy'].forEach(k => {
      const side = st[k];
      const before = side.board.length;
      const dead = side.board.filter(u => u.isDead);
      side.board = side.board.filter(u => !u.isDead);
      const after = side.board.length;
      if(after < before){
        // companion 만 gravePile (영웅은 _checkWinner 처리 — 보드 잔존, 매치 종료 트리거)
        side.gravePile = side.gravePile || [];
        dead.forEach(u => {
          if(_isCompanion(u)) side.gravePile.push(u);
          /* diagnosis-confirmed: 2026-06-07 사유: feature — 메커니즘 Deathwish(유언). 이 unit 사망 시 deathEffects 발동(_deathwishFired 1회 방지). _damage 밖(_cleanupBoard)에서 발동해 반사/사망 재귀 회피. battle_system_decisions.md 2026-06-07 B-6. */
          if(!u._deathwishFired && Array.isArray(u.keywords) && u.keywords.indexOf('deathwish') >= 0
             && Array.isArray(u.deathEffects) && u.deathEffects.length){
            u._deathwishFired = true;
            Match._applyEffects({effects: u.deathEffects, kind: u.kind, keywords: []}, {side: side, sourceSideKey: k});
          }
          /* diagnosis-confirmed: 2026-06-11 사유: feature — onDeath(deathrattle) 트리거 배선. effects[].trigger='onDeath' 경로 (unit_data_guide 정본). deathwish(deathEffects 필드)와 별개 표현. _damage 밖(_cleanupBoard)이라 반사/사망 재귀 회피 + 1회 방지. */
          if(!u._deathTriggerFired && Array.isArray(u.effects) && u.effects.some(e => e && e.trigger === 'onDeath')){
            u._deathTriggerFired = true;
            Match._fireTriggerEffects(u, 'onDeath', k);
          }
        });
        logEvent('board-cleanup', {side: k, removed: before - after, gravePushed: dead.filter(u => _isCompanion(u)).length});
      }
    });
    /* diagnosis-confirmed: 2026-06-13 사유: feature — 종족 시너지 R1 보드변동 hook. 사망 제거로 N 감소 → 양측 재계산(멱등 오버레이). */
    if(Match._recomputeSynergy){ Match._recomputeSynergy(st.player); Match._recomputeSynergy(st.enemy); }
  };

  /**
   * 매치 종료 단일 진입점 (2026-05-20 P0-1).
   *
   * 모든 winner 결정 경로 (HP0 / draw / 항복 / 로그아웃 / 게임 종료) 가
   * 이 함수만 호출하도록 통일. 4가지 공통 처리 (events clear / AI stop /
   * winner 세팅 / showReward) 를 한 곳에 모아 누락 방지.
   *
   * 기존 사고:
   *   - surrenderMatch / Settings.logout / exitGame 이 winner 만 세팅하고
   *     events·AI 차단 누락 → AI 계속 행동 (P0 #14) / 보상 미진입 (P0 #7)
   *
   * @param {'player'|'enemy'|'draw'} winner
   * @param {object} [opts]
   * @param {boolean} [opts.showReward=true] — false 면 보상 화면 미진입
   *   (logout/exitGame 처럼 화면 자체가 전환되는 경우 보상 화면 skip).
   */
  // v1.1 mastery 영구 저장 commit (2026-05-25, spec §11 영구 보관 정합)
  // _endMatch 안에서 매치 inst.skillMastery → Game.deck 영구 카드 (_permanentUid 매칭) 로 commit.
  // 사용자 결정 B (uid 분리): 같은 card.id 여러 장이면 uid 별로 독립 mastery 보존.
  function _commitMasteryToProfile(state){
    if(typeof RoF === 'undefined' || !RoF.Game || !Array.isArray(RoF.Game.deck)) return 0;
    const playerSide = state && state.player;
    if(!playerSide) return 0;
    const buckets = [];
    if(playerSide.hero) buckets.push(playerSide.hero);
    /* diagnosis-confirmed: 2026-06-07 사유: feature — mastery commit 순회에 exhaustPile(신규 lifecycle pile) + deck(drawPile 실제 키 — 'drawPile' 키는 state 에 없고 deck 이 alias라 기존 누락 보완) 추가. seen Set 이 _permanentUid 중복 방지하므로 중복 순회 무해. */
    ['board','gravePile','dormantPile','drawPile','deck','discardPile','hand','exhaustPile'].forEach(k => {
      const arr = playerSide[k];
      if(Array.isArray(arr)) arr.forEach(u => { if(u && u._permanentUid) buckets.push(u); });
    });
    let committed = 0;
    const seen = new Set();
    buckets.forEach(inst => {
      if(!inst._permanentUid || !inst.skillMastery) return;
      if(seen.has(inst._permanentUid)) return;  // 같은 영구 uid 중복 commit 방지
      seen.add(inst._permanentUid);
      const persistent = RoF.Game.deck.find(c => c && c.uid === inst._permanentUid);
      if(!persistent) return;
      // skillMastery 전체 swap — 매치 누적 = 영구 누적 (deep clone 으로 reference 분리)
      try { persistent.skillMastery = JSON.parse(JSON.stringify(inst.skillMastery)); committed++; }
      catch(e){ /* JSON 실패 시 skip */ }
    });
    if(committed > 0 && typeof RoF.Game.persist === 'function'){
      try { RoF.Game.persist(); } catch(e){}
    }
    return committed;
  }

  // 카드 영구 XP commit (2026-06-08) — 출전 카드 기여 순위별 XP → 영구 카드 (_permanentUid).
  //   _commitMasteryToProfile 패턴 복제: player 진영 전 pile 순회 → _permanentUid 별 기여 합산
  //   → 내림차순 순위 → base × rank 배율 giveCardXp → 레벨업 결과 배열 반환 (UI 연출용).
  //   winner==='player' → winBase, 그 외(enemy/draw) → loseBase.
  function _commitCardXpToProfile(state, winner){
    if(typeof RoF === 'undefined' || !RoF.Game || !Array.isArray(RoF.Game.deck)) return [];
    if(typeof RoF.Game.giveCardXp !== 'function') return [];
    const playerSide = state && state.player;
    if(!playerSide) return [];
    const buckets = [];
    if(playerSide.hero) buckets.push(playerSide.hero);
    ['board','gravePile','dormantPile','drawPile','deck','discardPile','hand','exhaustPile'].forEach(k => {
      const arr = playerSide[k];
      if(Array.isArray(arr)) arr.forEach(u => { if(u && u._permanentUid) buckets.push(u); });
    });
    // _permanentUid 별 기여 합산 (같은 영구카드 여러 inst — 분해/부활 — 합산)
    const byUid = new Map();
    buckets.forEach(inst => {
      if(!inst._permanentUid) return;
      byUid.set(inst._permanentUid, (byUid.get(inst._permanentUid) || 0) + (inst._contrib || 0));
    });
    if(byUid.size === 0) return [];
    // 기여 내림차순 → 순위 (3위 이하 전부 rank[2])
    const ranked = [...byUid.entries()].sort((a, b) => b[1] - a[1]);
    const base = (winner === 'player') ? CARD_XP.winBase : CARD_XP.loseBase;
    const levelUps = [];
    ranked.forEach((entry, idx) => {
      const uid = entry[0], contrib = entry[1];
      const persistent = RoF.Game.deck.find(c => c && c.uid === uid);
      if(!persistent) return;
      const rankMult = CARD_XP.rank[Math.min(idx, CARD_XP.rank.length - 1)];
      const xp = Math.round(base * rankMult);
      if(xp <= 0) return;
      const lvRes = RoF.Game.giveCardXp(persistent, xp);
      if(lvRes && lvRes.leveled){
        levelUps.push({ uid: uid, card: persistent, lvRes: lvRes, rank: idx + 1, xp: xp, contrib: contrib });
      }
    });
    if(typeof RoF.Game.persist === 'function'){ try { RoF.Game.persist(); } catch(e){} }
    return levelUps;
  }

  Match._endMatch = function(winner, opts){
    const st = Match.state;
    if(!st) return;
    // idempotent — 이미 종료된 매치 중복 호출 차단
    if(st._endMatchCalled) return;
    st._endMatchCalled = true;
    st.winner = winner;

    const showReward = !opts || opts.showReward !== false;

    // v1.1 mastery 영구 저장 commit — 매치 종료 시 player 진영 모든 inst 의 skillMastery → Game.deck
    try { _commitMasteryToProfile(st); } catch(e){ /* commit 실패 매치 진행 영향 X */ }

    logEvent('match-end', {winner});

    // 2026-05-24 cascade 룰 (battle_system_decisions.md §매치 종료 cascade 표준 룰 LoR 식 V2):
    //   AI 차단은 즉시 (영웅 사망 후 stale AI 호출 차단 — 사용자 명시 2026-05-17 "즉시 모든것 중단")
    //   events 큐 clear 폐기 — 영웅 unit-death event 가 cascade 의 1단계. clear 시 visual 누락.
    //   showReward 자동 진입 폐기 → UI continue-button 클릭 후 사용자 의도로 진입.
    if(Match.AI){
      Match.AI._stopRequested = true;
      Match.AI._inLoop = false;
    }

    // 카드 영구 XP commit (2026-06-08) — 보상 진입 케이스만 (logout/exitGame 중단은 XP 미부여).
    //   레벨업 결과를 st._cardLevelUps 에 저장 → showReward UI 가 presentLevelUp 큐 재생.
    if(showReward){
      try { st._cardLevelUps = _commitCardXpToProfile(st, winner); }
      catch(e){ st._cardLevelUps = []; }
    }

    if(showReward){
      // cascade events push — UI 가 처리:
      //   1단계 HERO-DEATH = 이미 _damage 가 unit-death event push (영웅 HP 0 시 자동)
      //   2단계 MATCH-END-BANNER + 3단계 REWARD-PREVIEW + 4단계 CONTINUE-BUTTON 추가
      if(Array.isArray(st.events)){
        st.events.push({type: 'match-end-banner', winner});
        st.events.push({type: 'reward-preview', winner});
        st.events.push({type: 'continue-button', winner});
      }
    } else {
      // logout / exitGame 등 화면 자체 전환 → cascade skip + events clear + 즉시 showReward (또는 skip)
      // 회귀 호환: showReward:false 일 때 옛 events 큐 비움 (사용자 명시 2026-05-17 "즉시 모든 것 중단")
      if(Array.isArray(st.events)) st.events.length = 0;
      if(typeof setTimeout !== 'undefined' && typeof RoF !== 'undefined' && RoF.Game && typeof RoF.Game.showReward === 'function'){
        setTimeout(() => {
          if(Match.state && Match.state.winner) RoF.Game.showReward(Match.state.winner);
        }, 200);
      }
    }
  };

  // 승패 판정 — 영웅 HP 0 이면 즉시 종료
  Match._checkWinner = function(){
    const st = Match.state;
    if(!st || st.winner) return;
    const pDead = !st.player.hero || st.player.hero.curHP <= 0;
    const eDead = !st.enemy.hero  || st.enemy.hero.curHP  <= 0;
    let winner = null;
    if(pDead && eDead) winner = 'draw';
    else if(pDead) winner = 'enemy';
    else if(eDead) winner = 'player';
    if(winner) Match._endMatch(winner);
  };

  // ───────── 적 AI (간단 휴리스틱, Plan 2.A Task A.6 phase 라우팅) ─────────
  // phase='board' → 자기 차례 큐 entry 마다 attack (Match.attack 의 phase==='board' 분기가 _acted + _advanceBoardTurn 자동)
  // phase='card' (또는 미정의) → 옛 흐름 (카드 + 공격 + endTurn) + endCardPhase('enemy') 표지
  //   (옛 endTurn 흐름과 새 phase 룰 양립 — UI 통합 cluster 시점에 옛 공격/endTurn 폐기 검토)
  // 정본: design/battle_system_decisions.md 2026-05-10 (phase 라우팅 + 양 진영 동일 룰)
  Match.AI = {
    _inLoop: false,  // UI 통합 cluster (2026-05-11) — _afterBoardTurn 자동 호출의 무한 재귀 차단

    // UI 통합 cluster (2026-05-11) — phase 별 행동 핸들러 레지스트리.
    // 새 phase 추가 시 PHASE 객체 + 이 레지스트리 한 곳만 갱신 (열린 확장점).
    _phaseHandlers: {
      'card':  function(st){ Match.AI._takeCardPhase();  },
      'board': function(st){ Match.AI._takeBoardTurn();  },
    },

    takeTurn(){
      const st = Match.state;
      if(!st || st.winner) return;
      // 2026-05-17 #14 fix — 매치 종료 후 stale AI 콜백 차단 (showReward 가 set 함)
      if(Match.AI._stopRequested) return;

      // UI 통합 cluster (2026-05-11) — phase=BOARD 시 큐의 enemy 차례면 자기 차례 인지 (st.side 무관).
      // phase=CARD 시 옛 흐름 호환 위해 st.side === 'enemy' 검사.
      if(st.phase === PHASE.BOARD){
        const entry = (st.boardTurnQueue || [])[st.boardTurnCursor | 0];
        if(!entry || entry.sideKey !== 'enemy') return;  // player 차례면 UI 입력 대기
      } else {
        if(st.side !== 'enemy') return;
      }

      if(Match.AI._inLoop) return;
      Match.AI._inLoop = true;

      // 2026-05-24 §영혼력 visual feedback 룰 — AI 자기 사이클 진입 시 enemy +N floater push (sequential 인지).
      //   카드 페이즈 첫 진입 만 (boardTurn 진입 시는 매번 push 안 — 보드 페이즈는 cursor 별 attack 별개).
      //   _aiTurnCascadePushed 플래그 — 라운드당 1번만 push (재진입 차단).
      if(st.phase === PHASE.CARD && !st._aiTurnCascadePushed && st.enemy && (st.enemy.soulPool|0) > 0 && Array.isArray(st.events)){
        st.events.push({type:'soul-recharge-flash', side:'enemy', amount: st.enemy.soulPool});
        st._aiTurnCascadePushed = true;
      }
      try {
        // phase 별 핸들러 dispatch (미정의 phase 는 _takeCardPhase fallback — 옛 흐름).
        const handler = Match.AI._phaseHandlers[st.phase] || Match.AI._phaseHandlers[PHASE.CARD];
        handler(st);
      } finally {
        Match.AI._inLoop = false;
      }
    },

    /**
     * @deprecated UI 통합 cluster (2026-05-11) — 옛 endTurn flip 흐름과 phase 룰 양립용 임시 코드.
     *   EOL 후보: Plan 2.B 또는 옛 endTurn 회귀 3건 (engine/taunt/hero-progression) 폐기 시점.
     *   향후 _takeBoardTurn 처럼 phase 룰 단독 흐름으로 분리 예정 (옛 endTurn 호출 + 단계 2 보드 공격 제거).
     */
    // 카드 페이즈 (또는 phase 미정의 옛 흐름): 카드 사용 + 공격 + endCardPhase('enemy') 표지 + endTurn flip
    _takeCardPhase(){
      const st = Match.state;

      // 1. 카드 사용 루프
      // 2026-05-17 사용자 명시 "AI 가 endCardPhase 안 함, 영혼력 모자르면 즉시 종료" — playCard 결과 검사 + 실패 즉시 break.
      let safety = 20;
      while(safety-- > 0 && !st.winner){
        const enemy = st.enemy;
        const playable = enemy.hand
          .map((c, i) => ({card: c, idx: i, check: canPlay(enemy, c)}))
          .filter(x => x.check.ok)
          // G-1 (2026-05-25): aiHint 점수 우선 (미정의 시 NEED_SOUL fallback).
          .sort((a, b) => Match.AI._aiPriorityScore(b.card, st) - Match.AI._aiPriorityScore(a.card, st));
        if(playable.length === 0) break;
        const top = playable[0];
        const opts = Match.AI._chooseTarget(top.card);
        const result = Match.playCard('enemy', top.idx, opts);
        if(!result || result.ok === false) break;  // 사용 실패 → 즉시 endCardPhase (무한 시도 차단)
      }
      if(st.winner) return;

      // 2. ~~보드 유닛 + 영웅 공격~~ — Plan 2.D 페이즈 분리 (2026-05-13) 폐기.
      // 5-pile 정본: 카드 페이즈 = 카드 사용만, attack 은 보드 페이즈 (_takeBoardTurn).
      // 사용자 호소 "AI 턴 버그" — AI 가 카드 페이즈에 영웅 attack 하는 게 부자연 → 폐기.

      // 3-4. 턴 종료 — 2026-06-02 옵션 B: _endTurnFlow 단일 진입점 위임.
      //   옛 sideBefore 방어 (endCardPhase swap 시 endTurn skip) 는 _endTurnFlow 안에 내장됨.
      //   AI 레이어 책임 = pendingLevelUp 처리 (_chooseLevelUpChoice). UI 렌더/타이머는 없음 (코어).
      const r = Match._endTurnFlow('enemy');
      if(r && r.pendingLevelUp){
        Match.applyLevelUpChoice('enemy', Match.AI._chooseLevelUpChoice(st.enemy.hero));
      }
    },

    // 보드 페이즈: 큐의 enemy 차례 entry 마다 attack. player 차례 또는 큐 끝이면 break.
    // _inLoop 플래그: _advanceBoardTurn 의 _afterBoardTurn hook 재진입 차단 — 무한 재귀 방지.
    _takeBoardTurn(){
      const st = Match.state;
      Match.AI._inLoop = true;
      try {
        let safety = 30;
        while(safety-- > 0 && !st.winner && st.phase === PHASE.BOARD){
          const queue  = st.boardTurnQueue || [];
          const cursor = st.boardTurnCursor | 0;
          const entry  = queue[cursor];
          if(!entry) break;
          if(entry.sideKey !== 'enemy') break;  // player 차례면 UI 입력 대기
          const side = st[entry.sideKey];
          if(!side) break;
          const unit = (side.hero && side.hero.uid === entry.unitUid)
            ? side.hero
            : (side.board || []).find(u => u && u.uid === entry.unitUid);
          if(!unit || unit.isDead || unit._acted){
            Match._advanceBoardTurn();  // 안전망 — _advanceBoardTurn 가 자동 skip
            continue;
          }
          const playerTaunts = tauntsOf(st.player);
          const targetSpec = playerTaunts.length > 0
            ? {targetUid: playerTaunts[0].uid}
            : {targetUid: '__hero__'};
          const ar = Match.attack('enemy', entry.unitUid, targetSpec);
          if(!ar || !ar.ok) break;  // 공격 실패 시 무한 루프 방지
          // Match.attack 의 phase==='board' 분기가 _acted=true + _advanceBoardTurn 자동 호출
        }
      } finally {
        Match.AI._inLoop = false;
      }
    },
    // 영웅 카드 컨셉별 레벨업 선택 (사용자 결정 2026-05-06):
    //  - warrior (근접 전사): 'hp'   — 탱킹 안정성 강화
    //  - ranger  (원거리)   : 'atk'  — DPS 강화
    //  - support (지원)     : 'soul' — 영혼 자원 확보로 더 많은 부착/스펠
    // _heroRole 미지정 (legacy/unknown) 영웅은 'atk' fallback (가장 안전).
    _chooseLevelUpChoice(hero){
      const role = hero && hero._heroRole;
      if(role === 'warrior') return 'hp';
      if(role === 'ranger')  return 'atk';
      if(role === 'support') return 'soul';
      return 'atk';
    },
    // G-1 (2026-05-25) — 카드 데이터 `aiHint` 필드 기반 AI 우선순위 점수.
    //   출처: Forge MTG `SVar:AILogic:<hint>` 패턴 (design/comparison_forge_mtg_2026-05-24.md P0 #4).
    //   data 카드별 optional `aiHint: 'pump'|'defensive'|'aoe-priority'|'finisher'|'sac'|'control'|'support'`.
    //   미정의 시 base (NEED_SOUL) greedy fallback — 옛 동작 보존.
    //   회귀: tools/test_run.js #69 match-ai-hint-aoe-priority-v6
    _aiPriorityScore(card, st){
      if(!card) return 0;
      const base  = (card.NEED_SOUL || 0);
      const hint  = card.aiHint;
      if(!hint) return base;

      const enemy   = st && st.enemy;
      const player  = st && st.player;
      const myBoard       = (enemy && enemy.board) || [];
      const opBoard       = (player && player.board) || [];
      const myHero        = enemy && enemy.hero;
      const opHero        = player && player.hero;
      const myHeroHP      = (myHero && myHero.curHP) | 0;
      const myHeroMaxHP   = (myHero && (myHero.maxHP || myHero.HP)) | 0;
      const opHeroHP      = (opHero && opHero.curHP) | 0;
      const opBoardThreat = opBoard.reduce((s, u) => s + ((u && !u.isDead) ? (u.curATK || 0) : 0), 0);
      const opBoardLive   = opBoard.filter(u => u && !u.isDead).length;
      const myBoardLive   = myBoard.filter(u => u && !u.isDead).length;

      let bonus = 0;
      switch(hint){
        case 'pump': {
          // 자기 보드 unit ≥ 1 이면 우선. 없으면 효과 0 (강하게 후순위).
          bonus = myBoardLive >= 1 ? +20 : -100;
          break;
        }
        case 'defensive': {
          // 적 위협 (보드 총 ATK) ≥ 내 hero HP × 0.5 이면 우선.
          bonus = (opBoardThreat >= myHeroHP * 0.5) ? +30 : 0;
          break;
        }
        case 'aoe-priority': {
          // 적 보드 ≥ 2 unit 이면 우선. 비었거나 1마리면 강하게 후순위 (낭비 방지).
          bonus = opBoardLive >= 2 ? +25 : -50;
          break;
        }
        case 'finisher': {
          // 적 hero HP ≤ 카드 ATK + damage effect 합산 이면 우선 (마무리 가능).
          const cardEffects = Array.isArray(card.effects) ? card.effects : [];
          const dmgTotal = (card.ATK || 0) + cardEffects.reduce(
            (s, e) => s + ((e && e.op === 'damage') ? ((e.amount || 0) * (e.hits || 1)) : 0), 0);
          bonus = (opHeroHP > 0 && opHeroHP <= dmgTotal) ? +50 : -20;
          break;
        }
        case 'sac':
          // 희생/소모 카드 — priority 낮음 (마지막에 사용).
          bonus = -15;
          break;
        case 'control': {
          // 적 보드에 위협 unit (ATK ≥ 3) 있으면 우선.
          const hasThreat = opBoard.some(u => u && !u.isDead && (u.curATK || 0) >= 3);
          bonus = hasThreat ? +20 : 0;
          break;
        }
        case 'support': {
          // 자기 hero HP 50% 미만 또는 자기 보드 ≥ 3 unit 이면 우선.
          const hpRatio = myHeroMaxHP > 0 ? myHeroHP / myHeroMaxHP : 1;
          bonus = (hpRatio < 0.5 || myBoardLive >= 3) ? +20 : 0;
          break;
        }
        default:
          // 미지정 hint 는 base greedy 와 동일 (안전).
          bonus = 0;
      }
      return base + bonus;
    },

    _chooseTarget(card){
      const st = Match.state;
      switch(card.kind){
        case 'unit':         return {slotIdx: st.enemy.board.length};
        case 'spell-target': {
          /* diagnosis-confirmed: 2026-06-06 사유: feature — (B) AI 도 dmgType 분기. magic 스펠 taunt 무시 자유 저격 / 근접·원거리 taunt 우선 (player 대칭). */
          const dt = card.dmgType || 'magic';
          // 2026-06-12 — magic 또는 pierce:'taunt'(수호자 무시) 카드는 taunt 무시 자유 저격 (player 게이트 대칭).
          if(dt === 'magic' || Match._cardPiercesTaunt(card)){
            const target = st.player.board[0];  // taunt 무시 — 첫 unit, 없으면 영웅
            return target
              ? {targetSide: 'enemy', targetUid: target.uid}
              : {targetSide: 'enemy', targetUid: '__hero__'};
          }
          // 근접/원거리 = taunt 우선
          const tList = tauntsOf(st.player);
          const target = (tList[0]) || st.player.board[0];
          return target
            ? {targetSide: 'enemy', targetUid: target.uid}
            : {targetSide: 'enemy', targetUid: '__hero__'};
        }
        case 'spell-aoe':    return {targetSide: 'enemy'};
        case 'attach-hero':  return {targetSide: 'ally'};
        case 'attach-unit':  {
          const ally = st.enemy.board[0];
          return ally
            ? {targetSide: 'ally', targetUid: ally.uid}
            : {targetSide: 'ally', targetUid: '__hero__'};
        }
        /* diagnosis-confirmed: 2026-06-07 사유: feature — attach-self AI 타겟 = 없음 (시전자 자동 해석). 버그 픽스 아님. */
        case 'attach-self':  return {};
      }
      return {};
    },
  };

  // ───────── 외부 노출 / 디버그 ─────────
  // 회귀 helper — 영웅 cap 검증 (J 2026-05-25) 같은 회귀에서 직접 호출 가능하도록 노출.
  Match._autoHeroLevelUpCheck = _autoHeroLevelUpCheck;
  // 2026-05-28 cascade C4 — 동료 unit 도 외부 노출 (visual_match_cycle.js dev helper trigger 용).
  Match._autoUnitLevelUpCheck = _autoUnitLevelUpCheck;

  Match.PHASE = PHASE;  // Plan 2.A — UI / 회귀 / 외부 모듈에서 Match.PHASE.CARD/BOARD 참조 (2026-05-11 enum 화)
  Match.STEP  = STEP;   // 2026-05-29 B Phase 1 — HS step machine 7단계. PHASE 와 양립 alias.
  Match.phaseToStep = phaseToStep;
  Match.stepToPhase = stepToPhase;

  // ─────────────────────────────────────────────────────────────
  // 2026-05-29 B Phase 2 — STEP_HANDLERS 디스패처 (진입/종료 hook).
  //   step 전환 시 단일 진입점 _enterStep(newStep) 호출. handler 의 onEnter / onExit 자동 호출.
  //   state.step + state.phase 동시 갱신 (옛 PHASE 검사 코드 호환).
  //   events.push 'step-change' (UI 시각 분기 + 로그 추적).
  //
  //   향후 Phase 3~ 에서 입력 차단 / cleanup / 글로우 룰을 step 진입/종료 hook 으로 옮김.
  // ─────────────────────────────────────────────────────────────
  /* diagnosis-confirmed: 2026-06-06 사유: feature — 정식 instantiate 노출 (dev.startTestMatch _placeBoard 수동 부분복사가 attachments/_def 등 런타임 필드 누락 → attach-unit 크래시. 단일 진실 재사용으로 드리프트 방지) */
  Match._instantiate = instantiate;

  Match._stepHandlers = {
    [STEP.ROUND_BEGIN]: {
      onEnter: (st, ctx) => logEvent('step-enter', {step: STEP.ROUND_BEGIN, round: ctx.round || st.round}),
      onExit:  (st, ctx) => {},
    },
    [STEP.CARD_DRAW]: {
      onEnter: (st, ctx) => logEvent('step-enter', {step: STEP.CARD_DRAW}),
      onExit:  (st, ctx) => {},
    },
    [STEP.CARD_PLAY]: {
      onEnter: (st, ctx) => logEvent('step-enter', {step: STEP.CARD_PLAY, side: st.side}),
      onExit:  (st, ctx) => {},
    },
    [STEP.CARD_END]: {
      onEnter: (st, ctx) => logEvent('step-enter', {step: STEP.CARD_END}),
      onExit:  (st, ctx) => {},
    },
    [STEP.BOARD_BEGIN]: {
      onEnter: (st, ctx) => logEvent('step-enter', {step: STEP.BOARD_BEGIN, queueSize: (st.boardTurnQueue || []).length}),
      onExit:  (st, ctx) => {},
    },
    [STEP.BOARD_ACTION]: {
      onEnter: (st, ctx) => logEvent('step-enter', {step: STEP.BOARD_ACTION, cursor: st.boardTurnCursor | 0}),
      onExit:  (st, ctx) => {},
    },
    [STEP.ROUND_END]: {
      onEnter: (st, ctx) => {
        logEvent('step-enter', {step: STEP.ROUND_END, round: st.round});
        // ROUND_END 진입 시 cleanup 자동 — 18~19번째 deadlock 교훈 정합 (옛 보드 페이즈 잔존 dead unit 자동 제거).
        Match._cleanupBoard();
      },
      onExit:  (st, ctx) => {},
    },
  };

  // step 전환 단일 진입점. 옛 phase 검사 코드 호환 위해 state.phase 도 동시 갱신.
  //   호출자: Phase 3~ 에서 _beginRound / endCardPhase / _beginBoardPhase / _endRound 안에서 호출.
  //   ctx: {round?, prevStep?, reason?} 같은 부수 정보 (handler 가 활용).
  Match._enterStep = function(newStep, ctx){
    const st = Match.state;
    if(!st) return;
    if(!STEP[newStep.toUpperCase()] && Object.values(STEP).indexOf(newStep) < 0){
      console.warn('[match] _enterStep: invalid step', newStep);
      return;
    }
    const prevStep = st.step;
    if(prevStep === newStep) return;  // 같은 step 재진입 방지
    // 옛 step onExit
    const prevHandler = Match._stepHandlers[prevStep];
    if(prevHandler && prevHandler.onExit){
      try { prevHandler.onExit(st, ctx || {}); }
      catch(e){ console.warn('[match] step onExit err:', e); }
    }
    // step 전환
    st.step = newStep;
    st.phase = stepToPhase(newStep);  // 옛 phase 검사 호환
    // 새 step onEnter
    const newHandler = Match._stepHandlers[newStep];
    if(newHandler && newHandler.onEnter){
      try { newHandler.onEnter(st, ctx || {}); }
      catch(e){ console.warn('[match] step onEnter err:', e); }
    }
    // events.push step-change (UI 시각 분기)
    if(Array.isArray(st.events)){
      st.events.push({type: 'step-change', fromStep: prevStep, toStep: newStep, phase: st.phase, side: st.side});
    }
    logEvent('step-change', {from: prevStep, to: newStep, phase: st.phase, side: st.side});
  };
  Match.api = {
    start:               Match.start,
    endTurn:             Match.endTurn,             // 옛 흐름 alias (B 점진 마이그레이션)
    endCardPhase:        Match.endCardPhase,        // Task A.3 신규 phase 룰
    endTurnFlow:         Match._endTurnFlow,        // 2026-06-02 턴종료 단일 진입점 (옵션 B)
    playCard:            Match.playCard,
    attack:              Match.attack,
    applyLevelUpChoice:  Match.applyLevelUpChoice,
    getState:            () => Match.state,
    getLog:              () => Match.log.slice(),
    isLockedUnit:        _isLockedUnit,
    PHASE:               PHASE,                     // api 통해서도 접근 — Match.api.PHASE.CARD
  };

  // 호환 — 옛 RoF.Battle 호출자(있다면) 가 깨지지 않도록 noop 표지만 남김.
  // RoF.Battle.startFromLegacyBS stub 제거 (2026-05-16 P0 #4 단계 1).
  // 외부 호출처 grep 0 — dead. PHASE 6 진입점은 RoF.Match.start (또는 61_match_ui.js 의 startBattle).
  // 55_game_battle.js 는 보상 화면 (showReward) + 매치메이킹 담당 (PHASE 6 매치 자체 X). 살아있음.

  // ───────── Game.startBattle 진입점 ─────────
  // 정식 구현은 js/61_match_ui.js:1900 — Phase D 덱 빌딩 화면 정식화 시점에 이관됨 (2026-05).
  // 이 파일에서 RoF.Game.startBattle 정의 안 함 — 61 의 정식 구현이 진입점.
  // 중복 정의 제거 (2026-05-16 분석 P0 #3).

  if(typeof module !== 'undefined' && module.exports){
    module.exports = {Match, RoF};
  }
})(typeof window !== 'undefined' ? window : globalThis);
