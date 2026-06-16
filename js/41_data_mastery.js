'use strict';

// ─────────────────────────────────────────────────────────────
// 메타 progression — 숙련도 (Mastery) 1~10 단계
// 정본: design/meta_progression_spec.md §1 (2026-05-25 v1.1)
//
// 데이터 모델:
//   unit.skillMastery = {
//     '<skillId>': { level: 0..10, xp: 0..N, engraved: bool, upgradedTo: string|null, locked: bool }
//   };
//
// Lv 곡선: Lv N → Lv N+1 = N × 5 시전
// v1.1 정정 (2026-05-25): 자동 amount 보너스 폐기. mastery 의 역할 = "Lv 10 도달 시
//   각인/업그레이드 액션 unlock 트리거" + "그 유닛 × 그 스킬의 진행도 시각화".
//   스킬 데미지/힐 강화는 §5 영구 Lv 각성 (스킬 axes amount 분배) 로 분리.
// NEED_SOUL 은 mastery 영향 X.
// ─────────────────────────────────────────────────────────────

RoF.Meta = RoF.Meta || {};

RoF.Meta.Mastery = (function(){
  const MAX_LEVEL = 10;
  // Lv lv → lv+1 까지 필요 시전 횟수
  // spec 표: Lv 0→1 = 5 / Lv 1→2 = 10 / Lv 4→5 = 25 / Lv 9→10 = 50 / 누적 275
  const XP_PER_LEVEL = (lv) => (lv + 1) * 5;

  // v1.1 폐기 (2026-05-25): 자동 amount 보너스 폐기. 스킬 데미지/힐 강화는
  // §5 영구 Lv 각성 (스킬 axes amount 분배) 로 분리. mastery 는 Lv 10 unlock 트리거만.
  // (옛 amountBonus 함수 완전 제거)

  // 인스턴스 mastery default 생성
  function createMasteryEntry(){
    return { level: 0, xp: 0, engraved: false, upgradedTo: null, locked: false };
  }

  // unit 인스턴스에 skillMastery matrix default 주입 (이미 있으면 그대로)
  function ensureMatrix(unitInst){
    if (!unitInst) return null;
    if (!unitInst.skillMastery) unitInst.skillMastery = {};
    return unitInst.skillMastery;
  }

  // 특정 스킬의 mastery entry 조회 (없으면 default 생성)
  function getEntry(unitInst, skillId){
    const matrix = ensureMatrix(unitInst);
    if (!matrix) return null;
    if (!matrix[skillId]) matrix[skillId] = createMasteryEntry();
    return matrix[skillId];
  }

  // Lv 곡선 — Lv N 도달까지 누적 시전 (N=0 → 0, N=1 → 5, N=2 → 15, ...)
  function totalXpForLevel(targetLv){
    if (targetLv <= 0) return 0;
    let total = 0;
    for (let lv = 0; lv < targetLv && lv < MAX_LEVEL; lv++) total += XP_PER_LEVEL(lv);
    return total;
  }

  // xp +1 누적 trigger — Phase 2 에서 Match.playCard 안 호출
  // 반환: { leveledUp: bool, newLevel: int, milestoneReached: 'lv5'|'lv10'|null }
  function addXp(unitInst, skillId, delta){
    const entry = getEntry(unitInst, skillId);
    if (!entry || entry.locked) return { leveledUp: false, newLevel: entry?.level || 0, milestoneReached: null };
    entry.xp += (delta || 1);
    const before = entry.level;
    while (entry.level < MAX_LEVEL && entry.xp >= XP_PER_LEVEL(entry.level)) {
      entry.xp -= XP_PER_LEVEL(entry.level);
      entry.level += 1;
    }
    let milestone = null;
    if (before < 5 && entry.level >= 5) milestone = 'lv5';
    if (before < 10 && entry.level >= 10) milestone = 'lv10';
    return { leveledUp: entry.level > before, newLevel: entry.level, milestoneReached: milestone };
  }

  // 각인 lock 표시 (사용자 액션 후 Phase 3 UI 가 호출)
  function lockEngraved(unitInst, skillId){
    const entry = getEntry(unitInst, skillId);
    if (!entry) return false;
    entry.engraved = true;
    entry.locked = true;
    return true;
  }

  // 잊기 — 시그니처 풀에서 스킬 제거 시 mastery entry 도 delete
  // v1.1 spec §4 ⑥ (2026-05-25): 다시 학습 시 Lv 1 부터 정합 (재학습 §3.2 와 동일)
  // 호출자: Phase 5 UI (수련장 잊기 액션) — 시그니처 풀 제거 + 본 API 호출
  function forgetSkill(unitInst, skillId){
    if (!unitInst || !unitInst.skillMastery) return false;
    if (!unitInst.skillMastery[skillId]) return false;
    delete unitInst.skillMastery[skillId];
    return true;
  }

  // Lv 10 도달 시 unlock 액션 가능 여부 (v1.1) — UI 가 수련장 진입 시 grep
  function isUnlockReady(unitInst, skillId){
    const entry = unitInst && unitInst.skillMastery && unitInst.skillMastery[skillId];
    return !!(entry && entry.level >= 10);
  }

  return {
    MAX_LEVEL,
    XP_PER_LEVEL,
    createMasteryEntry,
    ensureMatrix,
    getEntry,
    totalXpForLevel,
    addXp,
    lockEngraved,
    forgetSkill,
    isUnlockReady,
  };
})();
