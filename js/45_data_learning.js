'use strict';

// ─────────────────────────────────────────────────────────────
// 메타 progression — 백그라운드 학습 (Transfer Learning)
// 정본: design/meta_progression_spec.md §4 (2026-05-24 v1)
//
// 데이터 모델:
//   Inventory.learningInProgress = [{
//     engravingId: 'eng_<ts>_<rand>',
//     targetUnitId: 'apprentice',
//     startAt: <timestamp>,
//     endAt: <timestamp>,
//     goldPaid: 8000,
//   }, ...]
//
// 골드 cost (등급별):
//   bronze 100 / silver 500 / gold 2000 / legendary 8000 / divine 30000
// 시간 cost (등급별, 짧은 곡선):
//   bronze 60s / silver 600s / gold 3600s / legendary 14400s / divine 43200s
//
// stale 학습 (사용자 결정 #4 — 자동 취소 + 골드 환불):
//   대상 유닛 폐기 시 학습 cancel + 골드 refund + engraving used=false 환원
// ─────────────────────────────────────────────────────────────

RoF.Meta = RoF.Meta || {};

RoF.Meta.Learning = (function(){
  // 진행 중 학습 array (단일 instance)
  const inProgress = [];

  // 골드 cost (등급별 — 신규 영입 cost 와 동일, RoF.Meta.Upgrade.RELEARN_COST_GOLD 와 같음)
  const TRANSFER_COST_GOLD = Object.freeze({
    bronze: 100,
    silver: 500,
    gold: 2000,
    legendary: 8000,
    divine: 30000,
  });

  // 시간 cost (등급별, 초 단위)
  const TRANSFER_TIME_SECONDS = Object.freeze({
    bronze: 60,         // 1분
    silver: 600,        // 10분
    gold: 3600,         // 1시간
    legendary: 14400,   // 4시간
    divine: 43200,      // 12시간
  });

  // 등급별 cost 조회 helper
  function getGoldCost(rarity){ return TRANSFER_COST_GOLD[rarity] || 0; }
  function getTimeCost(rarity){ return TRANSFER_TIME_SECONDS[rarity] || 0; }

  // 학습 시작 — Phase 5 UI 가 호출 (engraving used 표시 + 골드 차감은 호출자 책임)
  function startLearning(opts){
    const now = Date.now();
    const entry = {
      engravingId: opts.engravingId,
      targetUnitId: opts.targetUnitId,
      startAt: now,
      endAt: now + (opts.timeSeconds || 0) * 1000,
      goldPaid: opts.goldPaid || 0,
    };
    inProgress.push(entry);
    return entry;
  }

  // 학습 완료 여부 조회
  function isComplete(entry){
    if (!entry) return false;
    return Date.now() >= entry.endAt;
  }

  // 남은 시간 (초)
  function remainingSeconds(entry){
    if (!entry) return 0;
    const ms = entry.endAt - Date.now();
    return Math.max(0, Math.floor(ms / 1000));
  }

  // 완료된 학습 list (호출자가 처리 후 remove 호출)
  function listCompleted(){
    return inProgress.filter(e => isComplete(e));
  }

  // 진행 중 학습 list
  function listInProgress(){
    return inProgress.filter(e => !isComplete(e));
  }

  // 학습 제거 — 완료 처리 또는 stale 환불 시 호출
  function remove(engravingId){
    const idx = inProgress.findIndex(e => e.engravingId === engravingId);
    if (idx < 0) return false;
    inProgress.splice(idx, 1);
    return true;
  }

  // stale 학습 환불 — 대상 유닛 폐기 시 (사용자 결정 #4)
  // 반환: { ok, refundedGold }
  function refundStale(engravingId){
    const entry = inProgress.find(e => e.engravingId === engravingId);
    if (!entry) return { ok: false, refundedGold: 0 };
    const refund = entry.goldPaid;
    remove(engravingId);
    // engraving used=false 환원은 호출자 책임 (RoF.Meta.Engraving.markUnused)
    return { ok: true, refundedGold: refund };
  }

  return {
    inProgress,
    TRANSFER_COST_GOLD,
    TRANSFER_TIME_SECONDS,
    getGoldCost,
    getTimeCost,
    startLearning,
    isComplete,
    remainingSeconds,
    listCompleted,
    listInProgress,
    remove,
    refundStale,
  };
})();
