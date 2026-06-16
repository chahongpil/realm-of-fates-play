// 퀘스트 상태/로직 (RoF.Quest) — 정본: design/quest_system_v1.md + design/quest_ux_spec_v1.md
// 데이터: js/15_data_quests.js (RoF.Data.QUESTS_DB). UI: 성 게시판 (디자인 세션).
// 의존: RoF.Game (50_game_core), RoF.Data (15_data_quests), RoF.Match.UI (61, startQuestBattle).
// 로드 순서: 50_game_core.js 뒤 (index.html).
(function (global) {
  const RoF = global.RoF = global.RoF || {};
  const Quest = RoF.Quest = RoF.Quest || {};

  function now() { return Date.now(); }
  function rand() { return (typeof RoF._rand === 'function') ? RoF._rand() : Math.random(); }
  function G() { return RoF.Game; }
  function clamp(v, lo, hi) { return Math.max(lo, Math.min(hi, v)); }

  function state() {
    const g = G();
    if (!g.quests) g.quests = { active: [], completed: [], respawn: {}, lastDailyReset: 0 };
    const q = g.quests;
    if (!Array.isArray(q.active)) q.active = [];
    if (!Array.isArray(q.completed)) q.completed = [];
    if (!q.respawn) q.respawn = {};
    if (q.lastDailyReset == null) q.lastDailyReset = 0;
    if (!Array.isArray(g.ownedQuestCards)) g.ownedQuestCards = [];
    if (g.challengeLevel == null) g.challengeLevel = 1;
    if (g.challengeXP == null) g.challengeXP = 0;
    return q;
  }
  function persist() { try { if (G() && G().persist) G().persist(); } catch (e) {} }

  // ── 도전 레벨 ──
  Quest.challengeLevel = function () { state(); return G().challengeLevel || 1; };
  Quest.addChallengeXP = function (n) {
    const g = G(); state();
    g.challengeXP = (g.challengeXP || 0) + (n || 0);
    let next = RoF.Data.challengeXpForLevel(g.challengeLevel);
    while (g.challengeXP >= next) { g.challengeXP -= next; g.challengeLevel += 1; next = RoF.Data.challengeXpForLevel(g.challengeLevel); }
    persist();
    return { level: g.challengeLevel, xp: g.challengeXP, xpNext: next };
  };

  // ── 카드 전투력 (등급/레벨 — 성공률 계산) ──
  Quest.cardPower = function (card) {
    if (!card) return 0;
    const atk = card.ATK || card.atk || 0;
    const hp = card.HP || card.hp || 0;
    const mult = (RoF.Data.QUEST_RARITY_POWER && RoF.Data.QUEST_RARITY_POWER[card.rarity]) || 1.0;
    const lv = card.level || 1;
    return (atk + hp) * mult * (1 + 0.08 * (lv - 1));
  };
  // uid 배열 → Game.deck 카드 객체 배열
  function partyCards(uids) {
    const deck = (G() && G().deck) || [];
    return (uids || []).map(u => deck.find(c => c && c.uid === u)).filter(Boolean);
  }

  // ── busy (파견 커밋) ──
  Quest.busyCompanionUids = function () {
    const set = new Set();
    state().active.forEach(a => { if (a.type === 'timed' && Array.isArray(a.party)) a.party.forEach(u => set.add(u)); });
    return [...set];
  };
  Quest.isCompanionBusy = function (uid) { return Quest.busyCompanionUids().indexOf(uid) >= 0; };

  // ── 상태 질의 ──
  Quest.isActive = function (id) { return state().active.some(a => a.id === id); };
  Quest.getActive = function (id) { return state().active.find(a => a.id === id) || null; };
  Quest.onCooldown = function (id) { const r = state().respawn[id]; return !!(r && r > now()); };
  Quest.activeTimedCount = function () { return state().active.filter(a => a.type === 'timed').length; };

  // 게시판 — battle/timed 교차, 레벨밴드 상한 + 쿨다운 + active 필터. 최대 N슬롯.
  Quest.board = function () {
    state();
    const lv = G().challengeLevel || 1;
    const slots = RoF.Data.QUEST_BOARD_SLOTS || 3;
    const eligible = (RoF.Data.QUESTS_DB || []).filter(def =>
      lv <= def.levelMax && !Quest.isActive(def.id) && !Quest.onCooldown(def.id));
    const battle = eligible.filter(d => d.type === 'battle');
    const timed = eligible.filter(d => d.type !== 'battle');
    const out = []; let bi = 0, ti = 0;
    while (out.length < slots && (bi < battle.length || ti < timed.length)) {
      if (bi < battle.length) out.push(battle[bi++]);
      if (out.length >= slots) break;
      if (ti < timed.length) out.push(timed[ti++]);
    }
    return out;
  };

  // timed 진행 정보
  Quest.remainingMs = function (id) {
    const a = Quest.getActive(id); if (!a || a.type !== 'timed') return 0;
    const def = RoF.Data.getQuest(id); if (!def) return 0;
    return Math.max(0, a.acceptedAt + (def.durationMin || 0) * 60000 - now());
  };
  Quest.timedReady = function (id) {
    const a = Quest.getActive(id);
    return !!(a && a.type === 'timed' && Quest.remainingMs(id) <= 0);
  };

  // ── 성공률 (timed) ──
  // 성공률(%) = round(파티전투력/요구전투력 ×100) + prefer 매칭 보너스(카드당·속성당 +N%)
  Quest.computeSuccessRate = function (def, uids) {
    if (!def || def.type !== 'timed') return 100;
    const cards = partyCards(uids);
    const power = cards.reduce((s, c) => s + Quest.cardPower(c), 0);
    const req = def.requiredPower || 1;
    let rate = Math.round((power / req) * 100);
    const pref = def.prefer || {};
    const bonusPer = RoF.Data.QUEST_MATCH_BONUS || 5;
    cards.forEach(c => {
      if (pref.element && c.element === pref.element) rate += bonusPer;
      if (pref.race && c.race === pref.race) rate += bonusPer;
      if (pref.dmgType && c.dmgType === pref.dmgType) rate += bonusPer;
    });
    return Math.max(0, rate);
  };

  // ── 수락 ──
  Quest.accept = function (id, party) {
    const def = RoF.Data.getQuest(id);
    if (!def) return { ok: false, reason: 'unknown quest' };
    if ((G().challengeLevel || 1) > def.levelMax) return { ok: false, reason: '레벨 초과' };
    if (Quest.isActive(id)) return { ok: false, reason: '이미 진행 중' };
    if (Quest.onCooldown(id)) return { ok: false, reason: '쿨다운 중' };
    party = Array.isArray(party) ? party.slice(0, RoF.Data.QUEST_PARTY_MAX || 5) : [];
    const q = state();
    if (def.type === 'timed') {
      const cap = RoF.Data.QUEST_MAX_ACTIVE_TIMED || 2;
      if (Quest.activeTimedCount() >= cap) return { ok: false, reason: '동시 진행 한도(' + cap + ')' };
      if (!party.length) return { ok: false, reason: '동료 1명 이상 편성 필요' };
      // busy 충돌 검사 (이미 다른 파견에 묶인 동료)
      const busy = new Set(Quest.busyCompanionUids());
      if (party.some(u => busy.has(u))) return { ok: false, reason: '파견 중인 동료 포함' };
      q.active.push({ id, type: 'timed', acceptedAt: now(), party });
      persist();
      return { ok: true, type: 'timed', successRate: Quest.computeSuccessRate(def, party) };
    }
    // battle — party 저장 후 launch 신호
    q.pendingBattle = id; q.pendingParty = party;
    persist();
    return { ok: true, type: 'battle', launch: true, battle: def.battle };
  };

  // ── 보상 ──
  function pickCard(def, appearedCardIds) {
    let pool = (def.reward && def.reward.cardPool && def.reward.cardPool.length)
      ? def.reward.cardPool : (Array.isArray(appearedCardIds) ? appearedCardIds : []);
    // 영웅 카드 제외 — 영웅 영입은 jackpot 전용 roll (적 영웅이 등장 풀에 섞여 일반 드롭되는 것 방지).
    pool = pool.filter(id => !(D.isHeroId && D.isHeroId(id)));
    if (!pool.length) return null;
    return pool[Math.floor(rand() * pool.length)];
  }
  // 보상 지급. multiplier: 골드·XP 배율(확정). 카드는 확률 드롭(base × multiplier, cap 1.0).
  function grantReward(def, multiplier, appearedCardIds) {
    const g = G(); state();
    const r = def.reward || {};
    const m = multiplier || 1;
    const gained = { gold: 0, cardId: null, challengeXP: 0, cardChance: 0, cardRolled: false, jackpot: false, jackpotCardId: null, visionId: null };
    if (r.gold) { const amt = Math.round(r.gold * m); g.gold = (g.gold || 0) + amt; gained.gold = amt; }
    // 카드 확률 드롭
    const baseChance = (r.cardDropChance != null) ? r.cardDropChance : 0.3;
    const chance = clamp(baseChance * m, 0, 1);
    gained.cardChance = chance;
    if (rand() < chance) {
      const cardId = pickCard(def, appearedCardIds);
      if (cardId) {
        g.ownedQuestCards.push({ id: cardId, at: now() });
        gained.cardId = cardId; gained.cardRolled = true;
        gained.visionId = (r.rewardVision && r.rewardVision.normal) || null;  // 일반 영입 연출
      }
    }
    // jackpot — 별도 독립 roll (영웅 영입). 고정 확률 (multiplier 미적용). 메인 풀에서 영웅 제외됨.
    if (r.jackpot && r.jackpot.cardId && rand() < (r.jackpot.chance || 0)) {
      g.ownedQuestCards.push({ id: r.jackpot.cardId, at: now(), jackpot: true });
      gained.jackpot = true;
      gained.jackpotCardId = r.jackpot.cardId;
      gained.visionId = (r.rewardVision && r.rewardVision.jackpot) || gained.visionId;  // jackpot 연출 우선
    }
    // 도전 XP (배율 적용)
    const baseXp = def.type === 'battle' ? 20 : 10;
    const xp = Math.round(baseXp * m);
    gained.challengeXP = xp;
    persist();
    Quest.addChallengeXP(xp);
    return gained;
  }

  function markDoneAndCooldown(id) {
    const def = RoF.Data.getQuest(id); const q = state();
    q.active = q.active.filter(a => a.id !== id);
    if (q.pendingBattle === id) { q.pendingBattle = null; q.pendingParty = null; }
    q.completed.push({ id, at: now() });
    q.respawn[id] = now() + ((def && def.cooldownHours) || 4) * 3600000;
    persist();
  }

  // 격파 이력 (previewMode 'masked_first' 마스킹용). completed 에 한 번이라도 있으면 true (respawn 무관).
  Quest.isBeaten = function (id) {
    const q = state();
    return !!(q && Array.isArray(q.completed) && q.completed.some(c => c && c.id === id));
  };

  // timed 완료 — 성공률 판정 + 배율 보상.
  Quest.completeTimed = function (id) {
    if (!Quest.timedReady(id)) return { ok: false, reason: '아직 진행 중' };
    const def = RoF.Data.getQuest(id);
    const a = Quest.getActive(id);
    const rate = Quest.computeSuccessRate(def, a && a.party);
    const cap = (RoF.Data.QUEST_REWARD_CAP || 2.0) * 100;
    let result;
    if (rate >= 100) {
      // 확정 성공 + 배율 (cap)
      const mult = Math.min(rate, cap) / 100;
      result = { ok: true, success: true, rate, gained: grantReward(def, mult) };
    } else {
      // RNG 성공 확률
      if (rand() * 100 < rate) {
        result = { ok: true, success: true, rate, gained: grantReward(def, 1.0) };
      } else {
        // 실패 — 위로금 (소액 골드, 카드·XP 0)
        const g = G(); const solace = Math.max(1, Math.round((def.reward.gold || 0) * 0.2));
        g.gold = (g.gold || 0) + solace; persist();
        result = { ok: true, success: false, rate, gained: { gold: solace, cardId: null, challengeXP: 0 } };
      }
    }
    markDoneAndCooldown(id);
    return result;
  };

  // 회수 — 파견 취소 (보상 포기 + busy 해제, 쿨다운 없음 → 재파견 가능)
  Quest.recall = function (id) {
    const q = state();
    const a = q.active.find(x => x.id === id && x.type === 'timed');
    if (!a) return { ok: false, reason: '진행 중 아님' };
    q.active = q.active.filter(x => x.id !== id);
    persist();
    return { ok: true };
  };

  // battle 결과 — 라우팅(전투 종료)에서 호출. win → 골드(×1) + 카드 확률드롭. lose → 0.
  Quest.resolveBattle = function (id, won, appearedCardIds) {
    const def = RoF.Data.getQuest(id);
    if (!def) return { ok: false, reason: 'unknown' };
    if (won) {
      const gained = grantReward(def, 1.0, appearedCardIds);
      markDoneAndCooldown(id);
      return { ok: true, won: true, gained };
    }
    markDoneAndCooldown(id);
    return { ok: true, won: false };
  };

  // 보석 즉시완료 (timed)
  Quest.rushTimed = function (id) {
    const a = Quest.getActive(id);
    if (!a || a.type !== 'timed') return { ok: false, reason: 'not timed active' };
    a.acceptedAt = 0; persist();
    return { ok: true };
  };

  // 일일 리셋
  Quest.checkDailyReset = function () {
    const q = state();
    const d = new Date(); d.setHours(0, 0, 0, 0);
    const midnight = d.getTime();
    if (q.lastDailyReset >= midnight) return false;
    q.lastDailyReset = midnight; q.respawn = {}; persist();
    return true;
  };

  Quest.pendingBattleId = function () { return state().pendingBattle || null; };

  // ── battle 퀘 launch — 영웅 자동 필수 + 편성 동료만 (party uid). ──
  Quest.startQuestBattle = function (id, party) {
    const def = RoF.Data.getQuest(id);
    if (!def || def.type !== 'battle' || !def.battle) return { ok: false, reason: 'not a battle quest' };
    if (!(RoF.Match && RoF.Match.UI && RoF.Match.UI.startMatch)) return { ok: false, reason: 'Match UI 없음' };
    const D = RoF.Data, g = G();
    const isHero = (c) => (typeof isHeroCard === 'function') ? isHeroCard(c) : !!(c && (c._isHero || c.isHero || c.kind === 'hero'));
    const playerHero = (g.deck || []).find(isHero);
    if (!playerHero) return { ok: false, reason: 'player hero 없음' };

    // 편성 동료 (uid) — 없으면 영웅 단독. 선택 동료 + 그 시그니처만 덱에.
    party = Array.isArray(party) ? party : ((state().pendingParty) || []);
    const UNITS = D.UNITS || [], SKILLS = D.SKILLS || [];
    const SK = (g.deck || []).filter(c => c && !isHero(c));
    const playerDeck = [];
    // 2026-06-13: 동료 영입 영웅레벨 게이팅 (formation _buildBattleDeck 와 동일 룰) — 해금 N명만 출전.
    const _unlockedComp = (g.getUnlockedCompanionCount ? g.getUnlockedCompanionCount() : 4);
    party.slice(0, _unlockedComp).forEach(u => {
      const card = SK.find(c => c.uid === u);
      if (!card) return;
      playerDeck.push(card);
      (card.bundledSkillIds || []).forEach(sid => {
        const sk = (g.deck || []).find(c => c.id === sid) || SKILLS.find(s => s.id === sid);
        if (sk) playerDeck.push(sk);
      });
    });

    // 적 영웅 — named-hero id (hero_wolf_alpha 등) 우선 조회. 없으면 템플릿 createHero (gender/role/element).
    const spec = def.battle;
    let enemyHero;
    const namedHero = (spec.enemyHero && spec.enemyHero.id && typeof D.getHeroById === 'function')
      ? D.getHeroById(spec.enemyHero.id) : null;
    if (namedHero) {
      enemyHero = Object.assign(namedHero, { _enemy: true });
    } else {
      enemyHero = D.createHero({
        gender: (spec.enemyHero && spec.enemyHero.gender) || 'm',
        role: (spec.enemyHero && spec.enemyHero.role) || 'warrior',
        element: (spec.enemyHero && spec.enemyHero.element) || 'fire', skinIndex: 0,
      });
    }
    const enemyDeck = [];
    // 적 영웅 시그니처 (bundledByUnit === enemyHero.id) → enemyDeck. Match.start 가 영웅 시그로 분류 → 활성 drawPile.
    (enemyHero.bundledSkillIds || []).forEach(sid => {
      const s = SKILLS.find(k => k.id === sid);
      if (s) enemyDeck.push(Object.assign({}, s, { _enemy: true, bundledByUnit: enemyHero.id }));
    });
    (spec.enemyUnits || []).forEach(uid => {
      const u = UNITS.find(x => x.id === uid); if (!u) return;
      enemyDeck.push(Object.assign({}, u, { _enemy: true }));
      (u.bundledSkillIds || []).forEach(sid => {
        const s = SKILLS.find(k => k.id === sid);
        if (s) enemyDeck.push(Object.assign({}, s, { _enemy: true, bundledByUnit: uid }));
      });
    });

    g._questBattleId = id;
    try {
      RoF.Match.UI.startMatch({ playerHero, enemyHero, playerDeck, enemyDeck, context: 'quest', questId: id });
    } catch (e) { g._questBattleId = null; return { ok: false, reason: 'startMatch throw: ' + e.message }; }
    return { ok: true };
  };

  // 전투 등장 카드 id 집합 (보상 fallback)
  Quest.collectAppearedCardIds = function (st) {
    const ids = new Set(); if (!st) return [];
    ['player', 'enemy'].forEach(side => {
      const s = st[side]; if (!s) return;
      ['board', 'hand', 'deck', 'discardPile', 'gravePile'].forEach(pile => {
        (s[pile] || []).forEach(c => { if (c && c.id) ids.add(c.id); });
      });
    });
    return [...ids];
  };

})(typeof window !== 'undefined' ? window : globalThis);
