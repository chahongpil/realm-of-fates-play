'use strict';

// ─────────────────────────────────────────────────────────────
// 메타 progression — 스킬 업그레이드 + 원본 재학습 (신규)
// 정본: design/meta_progression_spec.md §3 (2026-05-24 v1)
//
// 메커니즘:
//   - 스킬 데이터 (12_data_skills.js) 에 upgradeChoices: [{id,name,effects}] 사전 정의 2개
//   - Lv 10 도달 + 사용자 액션 → 2개 중 1 선택
//   - 영구 강화 / 그 유닛 한정 / 전수 불가
//   - base 카드는 시그니처 풀에서 swap (Lv 1 재학습으로만 복귀)
//
// 재학습 cost (사용자 결정 #12 — 영입 등급별 골드):
//   bronze 100 / silver 500 / gold 2000 / legendary 8000 / divine 30000
//
// 트리 깊이 = 2 단계 cap (사용자 결정 #16) — 업그레이드 카드 Lv 10 시 각인만 가능
// ─────────────────────────────────────────────────────────────

RoF.Meta = RoF.Meta || {};

RoF.Meta.Upgrade = (function(){
  // ─────────────────────────────────────────────────────────────
  // 재학습 (v1 유지) — D1 E+C 결정 2026-05-27
  //
  // 재학습 = base skill Lv 1 부터 새 인스턴스 추가 (base + 강화 공존).
  // 회귀 의식 (v2 revertSkill) 과 의미 다름 — spec §3.6 참고.
  // ─────────────────────────────────────────────────────────────
  const RELEARN_COST_GOLD = Object.freeze({
    bronze: 100,
    silver: 500,
    gold: 2000,
    legendary: 8000,
    divine: 30000,
  });

  // 스킬 데이터 조회 — 12_data_skills.js 의 RoF.Data.SKILLS 에서
  function _findSkill(skillId){
    const skills = (RoF.Data && RoF.Data.SKILLS) || [];
    return skills.find(s => s.id === skillId) || null;
  }

  // 원본 재학습 cost 조회
  function getRelearnCost(skillId){
    const skill = _findSkill(skillId);
    if (!skill) return null;
    return RELEARN_COST_GOLD[skill.rarity] || 0;
  }

  // 원본 재학습 적용 — Phase 3 UI 가 호출 (골드 차감은 호출자 책임)
  //   1. signaturePool 에 base 추가
  //   2. skillMastery[baseSkillId] Lv 1 부터 (mastery entry 초기화)
  function applyRelearn(unitInst, baseSkillId){
    if (!unitInst) return { ok: false, reason: 'unit missing' };
    if (!unitInst.signaturePool) unitInst.signaturePool = [];
    if (unitInst.signaturePool.indexOf(baseSkillId) >= 0) {
      return { ok: false, reason: 'already in pool' };
    }
    // 풀 cap 11장 — 호출자가 사용자 교체 모달 처리 후 호출
    unitInst.signaturePool.push(baseSkillId);
    if (!unitInst.skillMastery) unitInst.skillMastery = {};
    unitInst.skillMastery[baseSkillId] = RoF.Meta.Mastery.createMasteryEntry();
    return { ok: true };
  }

  // ─────────────────────────────────────────────────────────────
  // v2 스킬 강화 (2026-05-26) — form swap 모델
  //
  // 각성 (RoF.Meta.Awakening) 과 동일 모델. 골드 50% 할인.
  // 자원: 운명의 인장 통합 (RoF.Game.awakeningSeal — 광휘의 인장 폐기).
  //
  // 정본: design/meta_progression_spec.md §3 (v2)
  // ─────────────────────────────────────────────────────────────

  // 비용 표 (2026-05-27 C1 — derived from Awakening.COST_GOLD × SKILL_DISCOUNT)
  //
  // Single Source of Truth: 각성 비용 변경 시 강화 비용 자동 갱신.
  // drift 위험 차단 (교훈집 6·10번째 본질 재발 방지).
  const SKILL_DISCOUNT = 0.5;
  const _awakeningCost = (RoF.Meta.Awakening && RoF.Meta.Awakening.COST_GOLD) || {};
  const SKILL_EVOLVE_COST_GOLD = Object.freeze(
    Object.fromEntries(
      Object.entries(_awakeningCost).map(function(kv){
        return [kv[0], Math.floor(kv[1] * SKILL_DISCOUNT)];
      })
    )
  );

  // SKILL_DEF lookup (12_data_skills.js 끝부분 RoF.Data.SKILL_DEF)
  function _lookupSkillDef(baseId){
    if (!RoF.Data || !RoF.Data.SKILL_DEF) return null;
    return RoF.Data.SKILL_DEF[baseId] || null;
  }

  function _activeSkillForm(unitInst, baseSkillId){
    if (!unitInst || !unitInst.skillMastery) return null;
    const entry = unitInst.skillMastery[baseSkillId];
    if (!entry) return null;
    // v2 entry = {baseId, activeForm, formsData}
    if (entry.activeForm && entry.formsData) {
      return entry.formsData[entry.activeForm] || null;
    }
    return null;
  }

  // v2 진화 후보 (1~3)
  function evolveSkillOptions(unitInst, baseSkillId){
    const cur = _activeSkillForm(unitInst, baseSkillId);
    if (!cur) return [];
    const def = _lookupSkillDef(baseSkillId);
    if (!def || !def.evolutions) return [];

    const entry = unitInst.skillMastery[baseSkillId];
    const curFormDef = def.evolutions[entry.activeForm];
    if (!curFormDef || !Array.isArray(curFormDef.evolveTo)) return [];

    const A = RoF.Meta && RoF.Meta.Awakening;
    return curFormDef.evolveTo.map(targetFormId => {
      const targetForm = def.evolutions[targetFormId];
      if (!targetForm) return null;
      const unlock = targetForm.unlock || null;
      const isLocked = A ? !A.checkUnlock(unlock) : (unlock != null);
      const key = `${cur.rarity}->${targetForm.rarity}`;
      return {
        formId: targetFormId,
        rarity: targetForm.rarity,
        name: targetForm.name,
        imgKey: targetForm.imgKey || targetFormId,
        stat: targetForm.stat || null,
        unlock, isLocked,
        cost: { gold: SKILL_EVOLVE_COST_GOLD[key] || 0, seal: 1 },
      };
    }).filter(Boolean);
  }

  // v2 강화 실행 — form swap
  function applySkillEvolve(unitInst, baseSkillId, targetFormId){
    if (!unitInst) return { ok: false, reason: 'no unit' };
    const A = RoF.Meta && RoF.Meta.Awakening;
    if (!A) return { ok: false, reason: 'no awakening module' };

    const entry = unitInst.skillMastery && unitInst.skillMastery[baseSkillId];
    if (!entry || !entry.activeForm || !entry.formsData) {
      return { ok: false, reason: 'skill not v2 form' };
    }
    const cur = entry.formsData[entry.activeForm];
    if (!cur) return { ok: false, reason: 'no active form data' };
    if (A.isDivine(cur.rarity)) return { ok: false, reason: 'already divine' };

    const opts = evolveSkillOptions(unitInst, baseSkillId);
    const opt = opts.find(o => o.formId === targetFormId);
    if (!opt) return { ok: false, reason: 'invalid target' };
    if (opt.isLocked) return { ok: false, reason: 'option locked' };

    // 자원 확인 (gold + awakeningSeal)
    const G = (typeof window !== 'undefined' && window.RoF && window.RoF.Game) ? window.RoF.Game : null;
    if (!G) return { ok: false, reason: 'no game' };
    if ((G.gold || 0) < opt.cost.gold) return { ok: false, reason: 'not enough gold' };
    if ((G.awakeningSeal || 0) < opt.cost.seal) return { ok: false, reason: 'not enough seals' };

    G.gold -= opt.cost.gold;
    G.awakeningSeal -= opt.cost.seal;

    // 신 form 데이터 생성 (없을 때만)
    if (!entry.formsData[targetFormId]) {
      const def = _lookupSkillDef(baseSkillId);
      const targetForm = def.evolutions[targetFormId];
      entry.formsData[targetFormId] = {
        rarity: targetForm.rarity,
        lv: 1, xp: 0,
        engraved: false,
      };
    }

    entry.activeForm = targetFormId;
    return { ok: true, formId: targetFormId };
  }

  // 회귀 (스킬)
  function canRevertSkill(unitInst, baseSkillId){
    const entry = unitInst && unitInst.skillMastery && unitInst.skillMastery[baseSkillId];
    if (!entry || !entry.activeForm || !entry.formsData) return false;
    const cur = entry.formsData[entry.activeForm];
    if (!cur) return false;
    const A = RoF.Meta && RoF.Meta.Awakening;
    if (!A || A.isDivine(cur.rarity)) return false;
    // 옛 form 존재 확인
    const def = _lookupSkillDef(baseSkillId);
    if (!def || !def.evolutions) return false;
    const formIds = Object.keys(entry.formsData);
    return formIds.some(fid => {
      if (fid === entry.activeForm) return false;
      const fd = def.evolutions[fid];
      return fd && Array.isArray(fd.evolveTo) && fd.evolveTo.indexOf(entry.activeForm) >= 0;
    });
  }

  function revertSkill(unitInst, baseSkillId){
    if (!canRevertSkill(unitInst, baseSkillId)) return { ok: false, reason: 'cannot revert' };
    const entry = unitInst.skillMastery[baseSkillId];
    const def = _lookupSkillDef(baseSkillId);
    const cur = entry.formsData[entry.activeForm];

    const formIds = Object.keys(entry.formsData);
    const oldFormId = formIds.find(fid => {
      if (fid === entry.activeForm) return false;
      const fd = def.evolutions[fid];
      return fd && Array.isArray(fd.evolveTo) && fd.evolveTo.indexOf(entry.activeForm) >= 0;
    });
    if (!oldFormId) return { ok: false, reason: 'no previous form' };

    const oldRarity = entry.formsData[oldFormId].rarity;
    const evoKey = `${oldRarity}->${cur.rarity}`;
    const evoGold = SKILL_EVOLVE_COST_GOLD[evoKey] || 0;
    const revertGold = Math.floor(evoGold / 2);

    const G = (typeof window !== 'undefined' && window.RoF && window.RoF.Game) ? window.RoF.Game : null;
    if (!G) return { ok: false, reason: 'no game' };
    if ((G.gold || 0) < revertGold) return { ok: false, reason: 'not enough gold' };
    if ((G.awakeningSeal || 0) < 1) return { ok: false, reason: 'not enough seals' };

    G.gold -= revertGold;
    G.awakeningSeal -= 1;

    entry.activeForm = oldFormId;
    return { ok: true, formId: oldFormId };
  }

  return {
    // 재학습 (v1 유지 — D1 E+C 결정 2026-05-27, spec §3.6)
    RELEARN_COST_GOLD,
    getRelearnCost,
    applyRelearn,

    // v2 form swap (2026-05-26 신규)
    SKILL_DISCOUNT,                  // 2026-05-27 C1
    SKILL_EVOLVE_COST_GOLD,           // derived from Awakening.COST_GOLD × SKILL_DISCOUNT
    evolveSkillOptions,
    applySkillEvolve,
    canRevertSkill,
    revertSkill,

    // 옛 v1 폐기 (2026-05-27 D1):
    //   - TREE_DEPTH_CAP / getChoices / availableChoices / applyUpgrade / swapUpgrade
    //   - 의미 중복: v2 evolveSkillOptions / applySkillEvolve / revertSkill 로 대체
    //   - 호출처 마이그레이션 일정: 2026-06-15 까지 (57_game_training.js _openTrainingUpgradeChoice)
  };
})();
