'use strict';

// ─────────────────────────────────────────────────────────────
// 메타 progression — 카드 영구 Lv + 각성 v2 (form swap)
// 정본: design/meta_progression_spec.md §5~6 (2026-05-26 v2 재작성)
//
// v1 (포인트 분배) 폐기. v2 = 시안 정합 등급 사다리 + form swap.
//
// 핵심 룰:
//   - 등급 사다리: bronze → silver → gold → legendary → divine (한 단계씩)
//   - 각 form 은 독립 progression (formsData[form_id] 분리)
//   - 진화 후보 1~3 (UNIT_DEF[baseId].evolutions[currentForm].evolveTo)
//   - 자원: 골드 + 운명의 인장 (RoF.Game.awakeningSeal)
//   - 비가역: divine = 회귀 불가 (영구 종점)
//   - 회귀: 옛 form 데이터 보존 → 인장 1 + 등급 골드 50%
//   - 옵션 잠금: unlock 필드 (quest / item) — checkUnlock 분기
//
// 폐기 (v1):
//   - axesFor / AXES_HERO / AXES_UNIT / AXES_SKILL / POINT_EFFECT
//   - REBALANCE_COST_GOLD / POINT_INTERVAL (5단계 마다 포인트 분배 모델)
//   - ensureFields / allocate / rebalance / addXp (옛 schema)
//
// 보존 (v2 도 사용):
//   - xpToNextLevel (= 100 × L^1.5)
//   - MAX_LEVEL (= 30)
// ─────────────────────────────────────────────────────────────

RoF.Meta = RoF.Meta || {};

RoF.Meta = RoF.Meta || {};

// ─────────────────────────────────────────────────────────────
// UnlockResolvers Registry (2026-05-27 C3 — 사용자 결정)
//
// 102 batch 의 evolveTo unlock 옵션 (quest/item) 처리 — placeholder
// "return false" 영구 잠금 위험 차단. 시스템 구현 시점에 resolver
// 함수만 갱신 → 데이터/UI 무수정.
//
// 미등록 unlock key → fallback locked + console.warn (개발 안전망).
// __ROF_DEV_UNLOCK_ALL__ === true → 모든 unlock pass (개발 모드 우회).
// ─────────────────────────────────────────────────────────────
RoF.Meta.UnlockResolvers = {
  quest: function(questId) {
    // 추후 quest 시스템 연결 — 현재 placeholder
    return !!(window.RoF && RoF.Player && RoF.Player.quests && RoF.Player.quests[questId] && RoF.Player.quests[questId].completed);
  },
  item: function(itemId) {
    // 추후 inventory 시스템 연결 — 현재 placeholder
    return ((window.RoF && RoF.Game && RoF.Game.inventory && RoF.Game.inventory[itemId]) || 0) > 0;
  },
};

RoF.Meta.Awakening = (function(){
  const MAX_LEVEL = 30;

  // 등급 사다리 (단방향)
  const RARITY_LADDER = Object.freeze(['bronze', 'silver', 'gold', 'legendary', 'divine']);

  // ─────────────────────────────────────────────────────────────
  // 비용 표 (2026-05-27 C2 — index 기반)
  //
  // RARITY_LADDER 의 index 와 1:1 매핑 (i → i+1 진화 비용).
  // 새 등급 추가 시 RARITY_LADDER 에 1 추가 + COST_BY_LEVEL 에 1 추가 → 끝.
  // 옛 인터페이스 (`COST_GOLD['bronze->silver']`) 호환 유지.
  // ─────────────────────────────────────────────────────────────
  const COST_BY_LEVEL = Object.freeze([
    800,    // [0] bronze → silver
    4500,   // [1] silver → gold
    18000,  // [2] gold → legendary
    30000,  // [3] legendary → divine
  ]);

  // 옛 인터페이스 호환 (호출자 변경 X)
  const COST_GOLD = Object.freeze({
    [`${RARITY_LADDER[0]}->${RARITY_LADDER[1]}`]: COST_BY_LEVEL[0],
    [`${RARITY_LADDER[1]}->${RARITY_LADDER[2]}`]: COST_BY_LEVEL[1],
    [`${RARITY_LADDER[2]}->${RARITY_LADDER[3]}`]: COST_BY_LEVEL[2],
    [`${RARITY_LADDER[3]}->${RARITY_LADDER[4]}`]: COST_BY_LEVEL[3],
  });
  const SEAL_COST = 1;

  // index 기반 cost 접근 (102 batch 시 권장 — 새 등급 추가 시 자동 작동)
  function costByLevel(fromRarity) {
    const i = RARITY_LADDER.indexOf(fromRarity);
    if (i < 0 || i >= RARITY_LADDER.length - 1) return 0;
    return COST_BY_LEVEL[i] || 0;
  }

  // ─── 유틸 ─────────────────────────────────────────────────

  // Lv N → N+1 필요 XP = 100 × L^1.5
  function xpToNextLevel(level){
    if (level <= 0) return 0;
    if (level >= MAX_LEVEL) return Infinity;
    return Math.round(100 * Math.pow(level, 1.5));
  }

  function nextRarity(rar){
    const i = RARITY_LADDER.indexOf(rar);
    if (i < 0 || i >= RARITY_LADDER.length - 1) return null;
    return RARITY_LADDER[i + 1];
  }

  function isDivine(rar){ return rar === 'divine'; }

  // UNIT_DEF lookup (옛 flat schema 를 v2 nested 로 wrap — 11_data_units.js 끝부분 RoF.Data.UNIT_DEF)
  function _lookupUnitDef(baseId){
    if (!RoF.Data || !RoF.Data.UNIT_DEF) return null;
    return RoF.Data.UNIT_DEF[baseId] || null;
  }

  // 옵션 잠금 검사 (2026-05-27 C3 — Registry 패턴)
  //
  // RoF.Meta.UnlockResolvers 의 함수가 unlock 조건 평가.
  // 미등록 key → fallback locked + console.warn (개발 안전망).
  // window.__ROF_DEV_UNLOCK_ALL__ === true → 모든 unlock pass (개발 모드).
  function checkUnlock(unlock){
    if (!unlock) return true;
    // 개발 모드 우회
    if (typeof window !== 'undefined' && window.__ROF_DEV_UNLOCK_ALL__ === true) return true;
    const resolvers = (RoF.Meta && RoF.Meta.UnlockResolvers) || {};
    const keys = Object.keys(unlock);
    for (let i = 0; i < keys.length; i++) {
      const k = keys[i];
      const resolver = resolvers[k];
      if (typeof resolver !== 'function') {
        console.warn(`[Awakening] Unknown unlock key '${k}' — fallback locked. Register RoF.Meta.UnlockResolvers.${k} = function(arg){...}`);
        return false;
      }
      if (!resolver(unlock[k])) return false;
    }
    return true;
  }

  // ─── form 분리 데이터 ─────────────────────────────────────

  function ensureFormsData(inst, baseId, baseForm, baseRarity){
    if (!inst) return null;
    if (!inst.baseId) inst.baseId = baseId || inst.id || null;
    if (!inst.activeForm) inst.activeForm = baseForm || inst.id || null;
    if (!inst.formsData) inst.formsData = {};
    const formKey = inst.activeForm;
    if (formKey && !inst.formsData[formKey]) {
      inst.formsData[formKey] = {
        rarity: baseRarity || inst.rarity || 'bronze',
        permanentLv: inst.permanentLv || 1,
        permanentXP: inst.permanentXP || 0,
        bundledSkillIds: Array.isArray(inst.bundledSkillIds) ? [...inst.bundledSkillIds] : [],
        skillMastery: inst.skillMastery || {},
      };
    }
    return inst;
  }

  function getActiveFormData(inst){
    if (!inst || !inst.activeForm || !inst.formsData) return null;
    return inst.formsData[inst.activeForm] || null;
  }

  // ─── 진화 후보 (1~3) ─────────────────────────────────────

  function evolveOptions(inst){
    if (!inst) return [];
    const cur = getActiveFormData(inst);
    if (!cur) return [];
    const def = _lookupUnitDef(inst.baseId);
    if (!def || !def.evolutions) return [];

    const curFormDef = def.evolutions[inst.activeForm];
    if (!curFormDef || !Array.isArray(curFormDef.evolveTo)) return [];

    return curFormDef.evolveTo.map(targetFormId => {
      const targetForm = def.evolutions[targetFormId];
      if (!targetForm) return null;
      const unlock = targetForm.unlock || null;
      const isLocked = !checkUnlock(unlock);
      const key = `${cur.rarity}->${targetForm.rarity}`;
      return {
        formId: targetFormId,
        rarity: targetForm.rarity,
        name: targetForm.name,
        imgKey: targetForm.imgKey || targetFormId,
        stat: targetForm.stat || null,
        unlock, isLocked,
        cost: { gold: COST_GOLD[key] || 0, seal: SEAL_COST },
      };
    }).filter(Boolean);
  }

  function costFor(inst, targetFormId){
    const cur = getActiveFormData(inst);
    if (!cur) return null;
    const def = _lookupUnitDef(inst.baseId);
    if (!def || !def.evolutions) return null;
    const targetForm = def.evolutions[targetFormId];
    if (!targetForm) return null;
    const key = `${cur.rarity}->${targetForm.rarity}`;
    return { gold: COST_GOLD[key] || 0, seal: SEAL_COST };
  }

  // ─── 진화 실행 ────────────────────────────────────────────

  function applyEvolve(inst, targetFormId){
    if (!inst) return { ok: false, reason: 'no inst' };
    const cur = getActiveFormData(inst);
    if (!cur) return { ok: false, reason: 'no active form data' };
    if (isDivine(cur.rarity)) return { ok: false, reason: 'already divine' };

    const opts = evolveOptions(inst);
    const opt = opts.find(o => o.formId === targetFormId);
    if (!opt) return { ok: false, reason: 'invalid target' };
    if (opt.isLocked) return { ok: false, reason: 'option locked' };

    // 자원 확인 (RoF.Game.gold + RoF.Game.awakeningSeal)
    const G = (typeof window !== 'undefined' && window.RoF && window.RoF.Game) ? window.RoF.Game : null;
    if (!G) return { ok: false, reason: 'no game' };
    if ((G.gold || 0) < opt.cost.gold) return { ok: false, reason: 'not enough gold' };
    if ((G.awakeningSeal || 0) < opt.cost.seal) return { ok: false, reason: 'not enough seals' };

    // 차감
    G.gold -= opt.cost.gold;
    G.awakeningSeal -= opt.cost.seal;

    // 신 form 데이터 생성 (이미 있으면 그대로 — 회귀 후 재진화 정합)
    if (!inst.formsData[targetFormId]) {
      const def = _lookupUnitDef(inst.baseId);
      const targetForm = def.evolutions[targetFormId];
      inst.formsData[targetFormId] = {
        rarity: targetForm.rarity,
        permanentLv: 1, permanentXP: 0,
        bundledSkillIds: Array.isArray(targetForm.bundledSkillIds) ? [...targetForm.bundledSkillIds] : [],
        skillMastery: {},
      };
    }

    // activeForm swap (옛 form 데이터는 그대로 보존)
    inst.activeForm = targetFormId;

    return { ok: true, formId: targetFormId };
  }

  // ─── 회귀 의식 ────────────────────────────────────────────

  // 회귀 가능한 옛 form id 찾기 — 현재 activeForm 의 한 단계 위 form (evolveTo 에 현재 form 포함)
  function _findPreviousFormId(inst){
    if (!inst) return null;
    const def = _lookupUnitDef(inst.baseId);
    if (!def || !def.evolutions) return null;
    const cur = inst.activeForm;
    if (!cur) return null;
    const formIds = Object.keys(inst.formsData || {});
    return formIds.find(fid => {
      if (fid === cur) return false;
      const fd = def.evolutions[fid];
      return fd && Array.isArray(fd.evolveTo) && fd.evolveTo.indexOf(cur) >= 0;
    }) || null;
  }

  function canRevert(inst){
    if (!inst) return false;
    const cur = getActiveFormData(inst);
    if (!cur) return false;
    if (isDivine(cur.rarity)) return false;  // 신 = 회귀 불가
    return !!_findPreviousFormId(inst);
  }

  function revertCost(inst){
    const oldFormId = _findPreviousFormId(inst);
    if (!oldFormId) return null;
    const oldData = inst.formsData[oldFormId];
    const cur = getActiveFormData(inst);
    if (!oldData || !cur) return null;
    const evoKey = `${oldData.rarity}->${cur.rarity}`;
    const evoGold = COST_GOLD[evoKey] || 0;
    return { gold: Math.floor(evoGold / 2), seal: SEAL_COST };
  }

  function revert(inst){
    if (!canRevert(inst)) return { ok: false, reason: 'cannot revert' };
    const oldFormId = _findPreviousFormId(inst);
    const cost = revertCost(inst);
    if (!cost) return { ok: false, reason: 'no cost' };

    const G = (typeof window !== 'undefined' && window.RoF && window.RoF.Game) ? window.RoF.Game : null;
    if (!G) return { ok: false, reason: 'no game' };
    if ((G.gold || 0) < cost.gold) return { ok: false, reason: 'not enough gold' };
    if ((G.awakeningSeal || 0) < cost.seal) return { ok: false, reason: 'not enough seals' };

    G.gold -= cost.gold;
    G.awakeningSeal -= cost.seal;

    inst.activeForm = oldFormId;  // 옛 form 데이터 그대로 활성화
    return { ok: true, formId: oldFormId };
  }

  // ─── XP 누적 (v2 — formsData[activeForm] 에 누적) ────────

  function addXp(inst, delta){
    if (!inst) return { leveledUp: false };
    ensureFormsData(inst, inst.baseId, inst.activeForm);
    const cur = getActiveFormData(inst);
    if (!cur) return { leveledUp: false };
    cur.permanentXP = (cur.permanentXP || 0) + (delta || 1);
    const before = cur.permanentLv || 1;
    while (cur.permanentLv < MAX_LEVEL && cur.permanentXP >= xpToNextLevel(cur.permanentLv)) {
      cur.permanentXP -= xpToNextLevel(cur.permanentLv);
      cur.permanentLv += 1;
    }
    return { leveledUp: cur.permanentLv > before, newLevel: cur.permanentLv };
  }

  return {
    // 상수
    MAX_LEVEL,
    RARITY_LADDER,
    COST_BY_LEVEL,   // 2026-05-27 C2 — index 기반 cost source
    COST_GOLD,        // 옛 호환 (derived from COST_BY_LEVEL)
    SEAL_COST,
    // 유틸
    xpToNextLevel,
    nextRarity,
    isDivine,
    checkUnlock,
    costByLevel,      // 2026-05-27 C2 — index 기반 접근
    // form 데이터
    ensureFormsData,
    getActiveFormData,
    // 진화
    evolveOptions,
    costFor,
    applyEvolve,
    // 회귀
    canRevert,
    revertCost,
    revert,
    // XP
    addXp,
  };
})();
