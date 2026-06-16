'use strict';

// ─────────────────────────────────────────────────────────────
// 유물 카드 (PHASE 6 신스키마 — 2026-05-05 마이그레이션)
// ─────────────────────────────────────────────────────────────

RoF.Data.RELICS = Object.freeze([
  {id:'rl_banner', name:'전쟁의깃발', rarity:'bronze', kind:'relic', ability:'전체 공격+2', desc:''},
  {id:'rl_crystal', name:'생명수정', rarity:'bronze', kind:'relic', ability:'전체 HP+8', desc:''},
  {id:'rl_wall', name:'강철성벽', rarity:'bronze', kind:'relic', ability:'전체 방어+2', desc:''},
  {id:'rl_fury', name:'투쟁의부적', rarity:'silver', kind:'relic', ability:'전체 공격+2', desc:''},
  {id:'rl_boots', name:'신속장화', rarity:'silver', kind:'relic', ability:'전체 스피드+3', desc:''},
  {id:'rl_cloak', name:'안개망토', rarity:'silver', kind:'relic', ability:'전체 회피+5', desc:''},
  {id:'rl_doom', name:'파멸의검', rarity:'gold', kind:'relic', ability:'전체 공격+5', desc:''},
  {id:'rl_luck', name:'행운부적', rarity:'gold', kind:'relic', ability:'전체 행운+6', desc:''},
  {id:'rl_guard', name:'수호방패', rarity:'gold', kind:'relic', ability:'전체 방어+5, HP+10', desc:''},
  {id:'rl_wrath', name:'신의분노', rarity:'legendary', kind:'relic', ability:'전체 공격+7', desc:''},
  {id:'rl_eternal', name:'영원의성배', rarity:'legendary', kind:'relic', ability:'전체 전 능력치+3', desc:''},
  {id:'rl_immortal', name:'불멸갑옷', rarity:'legendary', kind:'relic', ability:'전체 방어+7, 회피+6', desc:''},
]);

// 호환성 레이어
window.RELICS_DB = RoF.Data.RELICS;
