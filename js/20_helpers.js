'use strict';

// Phase 3: helpers → RoF.helpers (window compat 유지)
RoF.helpers = RoF.helpers || {};

// ── 등급/카드 합성 ──
RoF.helpers.upgradeRarity = function(r){const i=R_ORDER.indexOf(r);return i<R_ORDER.length-1?R_ORDER[i+1]:r;};

// 진화 계수 — rules/04-balance.md PHASE 6 정본 (2026-05-06 SOUL 폐기).
// PHASE 6: 카드 SOUL 필드 폐기 (영웅만 SOUL 보유). 진화 대상은 ATK/HP 2스탯.
// NEED_SOUL 은 변경 없음 (등급 상승 자체가 비용 비례). spd/luck/eva/def/maxHp 는 PHASE 6 폐기.
RoF.helpers.EVOLVE_COEF = Object.freeze({
  ATK: 1.5, HP: 1.5,   // 주 능력치
});
RoF.helpers.fuseCard = function(card){
  card.rarity=upgradeRarity(card.rarity);
  for(const stat in RoF.helpers.EVOLVE_COEF){
    card[stat] = Math.round((card[stat]||0) * RoF.helpers.EVOLVE_COEF[stat]);
  }
};
// ── 적/ID ──
RoF.helpers.enemyName = function(){return ENEMY_NAMES[Math.floor(Math.random()*ENEMY_NAMES.length)];};
RoF.helpers.uid = function(){return Math.random().toString(36).substr(2,9);};
// DEPRECATED (2026-04-21): 기존 18종 h_* 영웅 시스템 폐기. createHero() 사용.
// 남아있는 이유: 레거시 호출부 방어 (null 이 아닌 값 반환). 신규 호출 금지.
RoF.helpers.getHeroId = function(element,roleId){return `hero_m_${roleId==='melee'?'warrior':roleId==='ranged'?'ranger':'support'}_${element}`;};
// ── 비동기/픽 ──
RoF.helpers.wait = function(ms){return new Promise(r=>setTimeout(r,ms));};
// Rarity pick: mode='tavern'|'battle'|'reward', bonus=scaling factor
RoF.helpers.pickRar = function(bonus=0,mode='battle'){
  const r=Math.random()*100;const b=Math.min(bonus,20);
  if(mode==='tavern'){
    // Conservative — permanent units
    const divine=0.2+b*.09;const legend=1.8+b*.16;const gold=8+b*.5;const silver=30+b*.25;
    if(r<divine)return'divine';if(r<divine+legend)return'legendary';if(r<divine+legend+gold)return'gold';if(r<divine+legend+gold+silver)return'silver';return'bronze';
  } else if(mode==='reward'){
    // Medium — post-battle rewards
    const divine=0.2+b*.34;const legend=1.8+b*.81;const gold=10+b*1;const silver=33+b*.15;
    if(r<divine)return'divine';if(r<divine+legend)return'legendary';if(r<divine+legend+gold)return'gold';if(r<divine+legend+gold+silver)return'silver';return'bronze';
  } else {
    // Battle — generous (roguelike reset)
    const divine=0.1+b*.29;const legend=0.9+b*1.11;const gold=6+b*1.9;const silver=28+b*.7;
    if(r<divine)return'divine';if(r<divine+legend)return'legendary';if(r<divine+legend+gold)return'gold';if(r<divine+legend+gold+silver)return'silver';return'bronze';
  }
};

// ── 스킬/유물 적용 (PHASE 6 — 2026-05-05 폐기, noop 유지) ──
// 옛 effect 마커 파서 (atk+1, proc_double_cast, hp_mult, grant_rebirth, invincibleN, berserk, g_all+N 등) 폐기.
// PHASE 6 는 keywords (battlecry/aura/deathrattle/taunt) + ability 텍스트로 효과 표현 — 신엔진(Phase C) 에서 처리.
// 호환층: 함수 자체는 노출 유지 — 호출처 없으면 noop, 있으면 안전 무시.
RoF.helpers.applySkillToUnit = function(sk, unit){ /* noop — PHASE 6 신엔진 keywords 처리 */ };
RoF.helpers.applyRelic = function(rl, deck){ /* noop — PHASE 6 신엔진 유물 처리 */ };
RoF.helpers.applyRelicBattle = function(rl, cards){ /* noop */ };

// ── 호환성 레이어 ──
window.upgradeRarity = RoF.helpers.upgradeRarity;
window.fuseCard = RoF.helpers.fuseCard;
window.enemyName = RoF.helpers.enemyName;
window.uid = RoF.helpers.uid;
window.getHeroId = RoF.helpers.getHeroId;
window.wait = RoF.helpers.wait;
window.pickRar = RoF.helpers.pickRar;
window.applySkillToUnit = RoF.helpers.applySkillToUnit;
window.applyRelic = RoF.helpers.applyRelic;
window.applyRelicBattle = RoF.helpers.applyRelicBattle;
