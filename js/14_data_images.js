'use strict';

// Card illustration mapping (id → image path)
// game-icons.net SVG icons (CC BY 3.0) — white on transparent
// v2 (2026-05-27): 계층 분류 (heroes/<id>/, units/<rarity>/<id>/skills/, units/neutral/skills/, ui/...).
//   - 마이그레이션 계획: design/asset_folder_v2_plan.md
//   - 헬퍼: RoF.Data.heroImg / unitImg / unitSkillImg / heroSkillImg / neutralSkillImg / relicImg / uiImg
//   - 옛 CARD_IMG / CARD_IMG_V6 평면 사전은 mv 후 path literal 만 새 위치로 갱신해 호환 유지.
(function(){
RoF.Data.GI = 'https://game-icons.net/icons/ffffff/transparent/1x1/';
RoF.Data.IMG = 'img/';

const __GI = RoF.Data.GI;
const __IMG = RoF.Data.IMG;

// ─────────────────────────────────────────────────────────────
// v2 — 카드 ID → rarity 자동 매핑 (데이터 파일에서 동적 추출)
// ─────────────────────────────────────────────────────────────
//   `RoF.Data.UNITS` (11_data_units.js) / `RoF.Data.SKILLS` (12_data_skills.js) 직접 lookup.
//   하드코드 폐기 → 새 unit / 스킬 추가 시 14_data_images.js 갱신 불필요.
//   (effect drift 7회 재발 본질 패턴 — 데이터/매핑 동기 자동화)
//
//   호출 시점 안전: index.html 의 defer script 순서 11 → 12 → 13 → 14 이므로
//   14 가 실행될 때 UNITS / SKILLS 모두 정의됨.
const _UNIT_RARITY = (() => {
  const m = {};
  const arr = (RoF.Data.UNITS) || [];
  for (const u of arr) if (u && u.id && u.rarity) m[u.id] = u.rarity;
  return Object.freeze(m);
})();
RoF.Data.UNIT_RARITY = _UNIT_RARITY;

// 시그니처 스킬 ID → 부모 unit ID 매핑 (12_data_skills.js 의 bundledByUnit 필드 자동 추출)
//   bundledByUnit 없는 sk_* 는 중립 스킬 (units/neutral/skills/).
const _SKILL_OWNER = (() => {
  const m = {};
  const arr = (RoF.Data.SKILLS) || [];
  for (const s of arr) if (s && s.id && s.bundledByUnit) m[s.id] = s.bundledByUnit;
  return Object.freeze(m);
})();
RoF.Data.SKILL_OWNER = _SKILL_OWNER;

// ─────────────────────────────────────────────────────────────
// v2 — path 헬퍼 함수 (단일 진실)
// ─────────────────────────────────────────────────────────────
// 새 코드는 이 헬퍼만 사용. 옛 CARD_IMG 평면 사전은 호환 layer (path literal 은 mv 후 갱신됨).
RoF.Data.heroImg          = (heroId) => __IMG + 'heroes/' + heroId + '/card.png';
RoF.Data.heroBoardImg     = (heroId) => __IMG + 'heroes/' + heroId + '/board.png';  // 2026-05-31 — 영웅 보드 전용 일러스트 (클래스별)
RoF.Data.heroProfileImg   = (heroId) => __IMG + 'heroes/' + heroId + '/profile.png';
RoF.Data.heroSkillImg     = (skId, heroId) => __IMG + 'heroes/' + heroId + '/skills/' + skId + '.png';
RoF.Data.unitImg          = (unitId) => {
  const r = _UNIT_RARITY[unitId];
  if(!r) return null;
  return __IMG + 'units/' + r + '/' + unitId + '/card.png';
};
RoF.Data.unitV6Img        = (unitId) => {
  const r = _UNIT_RARITY[unitId];
  if(!r) return null;
  return __IMG + 'units/' + r + '/' + unitId + '/v6.png';
};
RoF.Data.unitSkillImg     = (skId, unitId) => {
  const r = _UNIT_RARITY[unitId];
  if(!r) return null;
  return __IMG + 'units/' + r + '/' + unitId + '/skills/' + skId + '.png';
};
RoF.Data.neutralSkillImg  = (skId) => __IMG + 'units/neutral/skills/' + skId + '.png';
// 임시 / 비표준 경로 스킬 자산 override (project_temp_dragon_flame_all_heroes 메모리 인지)
// 정식 룰 확정 시 일괄 제거 + 표준 경로로 mv.
const _SKILL_PATH_OVERRIDES = Object.freeze({
  sk_dragon_flame: __IMG + 'ui/skill_anims/dragon_flame/sk_dragon_flame.webp',
});
RoF.Data.skillImg         = (skId) => {
  // 특수 case 우선
  if (_SKILL_PATH_OVERRIDES[skId]) return _SKILL_PATH_OVERRIDES[skId];
  // sk_hero_<g>_<r>_X → heroes/<g>_<r>/skills/
  const heroM = /^sk_hero_([fm]_(?:warrior|ranger|support))_/.exec(skId);
  if (heroM) return RoF.Data.heroSkillImg(skId, heroM[1]);
  // bundledByUnit lookup
  const owner = _SKILL_OWNER[skId];
  if (owner) return RoF.Data.unitSkillImg(skId, owner);
  // 중립
  return RoF.Data.neutralSkillImg(skId);
};
RoF.Data.relicImg         = (relicId) => __IMG + 'relics/' + relicId + '.png';
RoF.Data.npcImg           = (buildingId) => __IMG + 'npcs/npc_' + buildingId + '_1.png';
RoF.Data.uiImg            = (type, name) => __IMG + 'ui/' + type + '/' + name + '.png';
// 자주 쓰는 UI 단축 (concat 금지 룰 준수 — 모든 path 가 완성 리터럴로 마무리)
RoF.Data.uiIconImg        = (name) => __IMG + 'ui/icons/' + name + '.png';
RoF.Data.uiElementImg     = (variant, element) => __IMG + 'ui/elements/elem_' + variant + '_' + element + '.png';
RoF.Data.uiCursorImg      = (name) => __IMG + 'ui/cursors/' + name + '.png';
RoF.Data.uiCardBackImg    = (name) => __IMG + 'ui/card_backs/' + name + '.png';
RoF.Data.uiFrameImg       = (name) => __IMG + 'ui/frames/' + name + '.png';

// ─────────────────────────────────────────────────────────────
// v2 — CARD_IMG 평면 사전 (호환 layer)
// ─────────────────────────────────────────────────────────────
// 모든 entry 가 helper 함수를 호출 → "path literal 단일 진실" 보장.
// 호출처가 MAP[c.id] 패턴인 곳은 그대로 동작. 새 코드는 RoF.Data.skillImg / unitImg 직접 호출 권장.
// 데이터 파일에 unit / 유물 추가하면 _UNIT_RARITY / _SKILL_OWNER 만 갱신하면 자동 반영.
const _CARD_IMG_BUILD = () => {
  const map = {};
  // 영웅 카드 6종 (protagonist_X_v2 키 — 옛 호환)
  const HERO_KEYS = ['m_warrior','m_ranger','m_support','f_warrior','f_ranger','f_support'];
  for (const h of HERO_KEYS) map['protagonist_' + h + '_v2'] = RoF.Data.heroImg(h);
  // 유닛 56종 — _UNIT_RARITY 의 모든 id
  for (const uid of Object.keys(_UNIT_RARITY)) map[uid] = RoF.Data.unitImg(uid);
  // v6 유닛 카드 3종 (u_X_v6 키 — 옛 호환, CARD_IMG_V6 폐기 후 통합)
  map['u_apprentice_v6']  = RoF.Data.unitV6Img('apprentice');
  map['u_crossbow_v6']    = RoF.Data.unitV6Img('crossbow');
  map['u_fire_spirit_v6'] = RoF.Data.unitV6Img('fire_spirit');
  // 유물 12종 — rl_X (rl_cloak 만 SVG fallback, PNG 대기 중)
  const RELIC_KEYS = [
    'rl_banner','rl_crystal','rl_wall','rl_doom','rl_luck','rl_guard',
    'rl_wrath','rl_eternal','rl_immortal','rl_fury','rl_boots',
  ];
  for (const rid of RELIC_KEYS) map[rid] = RoF.Data.relicImg(rid);
  map['rl_cloak'] = __GI + 'lorc/hood.svg'; // TODO: PNG 대기 중
  // 시그니처 스킬 (sk_hero_X_*, bundledByUnit, 중립) — 자동 분기
  // 출처: 옛 CARD_IMG 항목 전부 (스킬 ~143종)
  const SKILL_IDS = [
    // 중립 30종 (sk_power 시리즈 + 전설/신화)
    'sk_power','sk_shield','sk_heal','sk_swift','sk_tough','sk_focus',
    'sk_rage','sk_evasion','sk_energize','sk_cleave','sk_ironwill','sk_prayer','sk_reflex',
    'sk_fortress','sk_revive','sk_bloodlust','sk_mirage','sk_warhorn',
    'sk_execute','sk_aura','sk_handoff','sk_berserk','sk_transcend','sk_invincible',
    'sk_godslayer','sk_resurrection','sk_shadowstep','sk_dragonheart',
    // 신규 bronze 스펠 3종 (2026-04-21)
    'sk_thunder_arrow','sk_hex','sk_ember',
    // 신규 4종 (2026-04-21 저녁)
    'sk_boil','sk_minor_curse','sk_spark_blast','sk_herb_pack',
    // 누락 복구 8종 (2026-04-22)
    'sk_flame_arrow','sk_healing_light','sk_tidal_crash','sk_earth_bulwark',
    'sk_chain_lightning','sk_dark_curse','sk_inferno_blast','sk_blessing_light',
    // PHASE 6 유닛-스킬 패키지 (bundledByUnit 으로 자동 분류 — 약 68종)
    ...Object.keys(_SKILL_OWNER),
    // 영웅 시그니처 30종 (sk_hero_<g>_<r>_* 패턴)
    'sk_hero_m_warrior_attack','sk_hero_m_warrior_shield','sk_hero_m_warrior_train',
    'sk_hero_m_warrior_morale','sk_hero_m_warrior_soul_boost',
    'sk_hero_m_support_attack','sk_hero_m_support_heal','sk_hero_m_support_teach',
    'sk_hero_m_support_divine_army','sk_hero_m_support_soul_boost',
    'sk_hero_m_ranger_attack','sk_hero_m_ranger_volley','sk_hero_m_ranger_hunt',
    'sk_hero_m_ranger_archery','sk_hero_m_ranger_soul_boost',
    'sk_hero_f_warrior_attack','sk_hero_f_warrior_shield','sk_hero_f_warrior_train',
    'sk_hero_f_warrior_morale','sk_hero_f_warrior_soul_boost',
    'sk_hero_f_support_attack','sk_hero_f_support_heal','sk_hero_f_support_teach',
    'sk_hero_f_support_divine_army','sk_hero_f_support_soul_boost',
    'sk_hero_f_ranger_attack','sk_hero_f_ranger_volley','sk_hero_f_ranger_hunt',
    'sk_hero_f_ranger_archery','sk_hero_f_ranger_soul_boost',
  ];
  for (const skId of SKILL_IDS) map[skId] = RoF.Data.skillImg(skId);
  // 특수 case — 임시 dragon_flame (project_temp_dragon_flame_all_heroes 메모리 인지)
  // ui/skill_anims/dragon_flame/ 으로 분류된 시퀀스 자산. CARD_IMG 의 sk_dragon_flame 은 단일 webp.
  map['sk_dragon_flame'] = __IMG + 'ui/skill_anims/dragon_flame/sk_dragon_flame.webp';
  // hero_wolf_alpha (첫 named-hero, q_wolf_cull) — 데이터 id 'hero_wolf_alpha' 이나 자산 폴더는 heroes/wolf_alpha/.
  //   영웅이라 _UNIT_RARITY 에 없어 skillImg 자동 분기가 null → 완성 리터럴 명시 (concat 금지 룰 준수, 파일 수령 확인).
  map['hero_wolf_alpha']            = __IMG + 'heroes/wolf_alpha/card.png';
  // 도전자 프로필 전용 컷 (퀘스트 적 영웅 = 도전자 동일시, 2026-06-09 사용자 결정). 없는 영웅은 card.png 폴백.
  map['hero_wolf_alpha_profile']    = __IMG + 'heroes/wolf_alpha/profile.png';
  map['sk_wolf_alpha_scratch']      = __IMG + 'heroes/wolf_alpha/skills/sk_wolf_alpha_scratch.png';
  map['sk_wolf_alpha_bite']         = __IMG + 'heroes/wolf_alpha/skills/sk_wolf_alpha_bite.png';
  map['sk_wolf_alpha_agile']        = __IMG + 'heroes/wolf_alpha/skills/sk_wolf_alpha_agile.png';
  map['sk_wolf_alpha_natural_gift'] = __IMG + 'heroes/wolf_alpha/skills/sk_wolf_alpha_natural_gift.png';
  map['sk_wolf_alpha_alpha_call']   = __IMG + 'heroes/wolf_alpha/skills/sk_wolf_alpha_alpha_call.png';
  // 촌장 NPC (q_wolf_cull dialogue.portrait / cutscene) — 2026-05-29 수령.
  map['village_elder']              = __IMG + 'npcs/npc_village_elder_portrait.png';
  map['village_elder_full']         = __IMG + 'npcs/npc_village_elder.png';
  return Object.freeze(map);
};
RoF.Data.CARD_IMG = _CARD_IMG_BUILD();

// ─────────────────────────────────────────────────────────────
// PHASE 6 신엔진 키워드 FX (skill_fx/ 폴더, mv 안 됨)
// ─────────────────────────────────────────────────────────────
RoF.Data.KEYWORD_FX_V6 = Object.freeze({
  apprentice_battlecry:    __IMG + 'skill_fx/apprentice_battlecry.png',
  crossbow_battlecry:      __IMG + 'skill_fx/crossbow_battlecry.png',
  firespirit_deathrattle:  __IMG + 'skill_fx/firespirit_deathrattle.png',
});

// 옛 CARD_IMG_V6 폐기 (2026-05-27 v2 마이그레이션)
// 옛 skills/sk_X.png (sk_fireball / sk_volley / sk_engulf 등 10종) 은 데이터 ID 없는 시안 잔재.
// → trash/2026-05-27-img-v2/skills_v6_legacy/ 로 이동, CARD_IMG_V6 는 빈 객체로 호환만.
RoF.Data.CARD_IMG_V6 = Object.freeze({});

// getCardImg 는 순수 함수이므로 RoF 직접 아래에 둠
// 주인공(_isHero) 은 id 대신 skinKey 로 매핑 — 원소는 id 에 들어있지만 이미지는 스킨 단위로 공유.
// 전투 v2 는 unit.id 에 전투용 uid(a_*/e_*)를 덮어쓰므로 imgKey/unitId 로 폴백.
// (원본 id 는 unit 생성 시 imgKey 와 unitId 에 백업됨 — 60_turnbattle_v2.js:1359 참조)
// 2026-04-23: 레거시 영웅(skinKey 유실된 오래된 세이브) 구제 — id 에서 gender/role 파싱해 기본 스킨 매핑.
RoF.getCardImg = function(c){
  if(!c) return null;
  const MAP = RoF.Data.CARD_IMG;
  if((c._isHero || c.isHero) && c.skinKey) return MAP[c.skinKey] || null;
  // 레거시 영웅 fallback: id 가 hero_{gender}_{role}_{element} 패턴이면 기본 스킨 추정.
  // m.warrior 는 _1/_2/_3 세 variant, 나머지(f.warrior, 양성 ranger/support) 는 단일.
  if(c._isHero || c.isHero){
    const src = c.id || c.unitId || c.imgKey || '';
    const m = /^hero_([mf])_(warrior|ranger|support)/.exec(src);
    if(m){
      const g = m[1], r = m[2];
      const tryKeys = [
        'protagonist_' + g + '_' + r + '_v2',  // 2026-05-09 v2 신규 (현재 정본)
        'protagonist_' + g + '_' + r + '_1',   // m.warrior 옛 _1 (이미 trash, fallback 만)
        'protagonist_' + g + '_' + r,          // 단일 스킨 옛 fallback
      ];
      for(const k of tryKeys){ if(MAP[k]) return MAP[k]; }
      return null;
    }
  }
  return MAP[c.id] || MAP[c.imgKey] || MAP[c.unitId] || null;
};

// 영웅 보드 전용 일러스트 (2026-05-31) — 영웅이 보드 카드(is-hero)로 렌더될 때만 사용.
// skinKey(protagonist_<g>_<r>_v2) 또는 id(hero_<g>_<r>_<element>) 에서 heroId(<g>_<r>) 파싱 → board.png.
// 6 클래스: m/f × warrior/ranger/support. 없으면 null → 호출부가 기존 card.png 로 폴백.
RoF.getHeroBoardImg = function(c){
  if(!c) return null;
  if(!(c._isHero || c.isHero)) return null;
  let m = /^protagonist_([mf])_(warrior|ranger|support)/.exec(c.skinKey || '');
  if(!m) m = /^hero_([mf])_(warrior|ranger|support)/.exec(c.id || c.unitId || c.imgKey || '');
  if(!m) return null;
  return RoF.Data.heroBoardImg(m[1] + '_' + m[2]);
};

// 호환성 레이어
window.GI = RoF.Data.GI;
window.IMG = RoF.Data.IMG;
window.CARD_IMG = RoF.Data.CARD_IMG;
window.getCardImg = RoF.getCardImg;
window.getHeroBoardImg = RoF.getHeroBoardImg;
})();
