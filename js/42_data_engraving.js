'use strict';

// ─────────────────────────────────────────────────────────────
// 메타 progression — 각인 (Engraving)
// 정본: design/meta_progression_spec.md §2 (2026-05-24 v1)
//
// 데이터 모델:
//   Inventory.engravings = [{
//     id: 'eng_<ts>_<rand>',
//     skillId: 'sk_dragon_flame',          // base 스킬 (업그레이드 전 원본)
//     sourceUnitId: 'apprentice',
//     sourceMasterLv: 10,
//     createdAt: <timestamp>,
//     used: false,                          // 학습 사용 여부
//     transferConstraint: 'none',           // 스킬 데이터의 transferConstraint 복사
//   }, ...]
//
// 트리거: mastery Lv 10 도달 + 사용자 "각인하기" 액션
// 각인 ↔ 업그레이드 mutual exclusive 아님 (공존, 사용자 결정 2026-05-24)
// 1 유닛 × 1 스킬 = 1번만 각인 가능 (Mastery.lockEngraved)
// ─────────────────────────────────────────────────────────────

RoF.Meta = RoF.Meta || {};

RoF.Meta.Engraving = (function(){
  // 인벤토리 array (단일 instance, 영구 보관 — 시즌 reset 안 됨)
  const inventory = [];

  // 각인 아이템 생성 — Phase 3 UI 가 호출
  function createEngraving(opts){
    const id = 'eng_' + Date.now() + '_' + Math.random().toString(36).slice(2, 8);
    return {
      id,
      skillId: opts.skillId,
      sourceUnitId: opts.sourceUnitId,
      sourceMasterLv: opts.sourceMasterLv || 10,
      createdAt: Date.now(),
      used: false,
      transferConstraint: opts.transferConstraint || 'none',
    };
  }

  // 인벤토리에 추가
  function add(engraving){
    if (!engraving || !engraving.id) return false;
    inventory.push(engraving);
    return true;
  }

  // 인벤토리 조회
  function listAll(){ return inventory.slice(); }
  function findById(id){ return inventory.find(e => e.id === id) || null; }
  function listUnused(){ return inventory.filter(e => !e.used); }

  // 사용 표시 — 전수 학습 완료 시 호출
  function markUsed(id){
    const e = findById(id);
    if (!e) return false;
    e.used = true;
    return true;
  }

  // 학습 권리 환원 (stale 학습 환불 시 — Phase 5)
  function markUnused(id){
    const e = findById(id);
    if (!e) return false;
    e.used = false;
    return true;
  }

  return {
    inventory,
    createEngraving,
    add,
    listAll,
    findById,
    listUnused,
    markUsed,
    markUnused,
  };
})();
