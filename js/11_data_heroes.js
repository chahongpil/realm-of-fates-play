'use strict';

// ─────────────────────────────────────────────────────────────
// 주인공(영웅) 시스템 (PHASE 6 — 2026-05-05 마이그레이션)
// ─────────────────────────────────────────────────────────────
// 성별(m/f) × 역할(warrior/ranger/support) = 6 템플릿
// 원소(6종)는 런타임 주입 — 스탯 보너스 + 시그니처 ability/keywords 만 원소별 다름
// 스킨(외형)은 생성 시 랜덤 선택 후 고정 (user.hero.skinIndex)
//
// 영웅은 보드에 미리 배치 + 손패 카드 발동 시 부착 대상.
// 손패에 안 들어가므로 NEED_SOUL 없음. 카드 종류는 'hero'.
//
// PHASE 6 5필드 (2026-05-06 영혼력 시스템 단순화 — `.claude/rules/04-balance.md`):
//   모든 영웅 SOUL 5 고정 (역할별 차등 폐기). 매치 내 레벨업 시 'soul' 선택 시 +1.
//   warrior (전사 / melee): SOUL 5 / HP 25~35 / ATK 3~5
//   ranger  (원거리)        : SOUL 5 / HP 18~25 / ATK 5~7
//   support (지원)          : SOUL 5 / HP 18~22 / ATK 2~4
//
// 원소 보너스에서 SOUL 키 제거 — 영웅 SOUL 은 기본 5 + 매치 progression 만 변동.
// ─────────────────────────────────────────────────────────────

(function(){

// ── 역할별 베이스 5필드 (성별·원소 무관) — 템플릿 영웅 1레벨 base SOUL 1 (2026-06-07 사용자 결정) ──
//   매 라운드 영혼 회복 = hero.SOUL. base 1 → 초반 페이스 ↓ + 영혼력 증가 카드/매치 레벨업 가치 ↑.
//   named 영웅(wolf_alpha 등)은 개별 SOUL 값 유지 (이 표 미적용).
const HERO_BASE = Object.freeze({
  warrior: {role:'attack',  ATK:3, HP:30, SOUL:1, kind:'hero', kindLabel:'근접 전사', icon:'⚔️'},
  ranger:  {role:'attack',  ATK:5, HP:22, SOUL:1, kind:'hero', kindLabel:'원거리 궁수', icon:'🏹'},
  support: {role:'support', ATK:3, HP:20, SOUL:1, kind:'hero', kindLabel:'지원 마법사', icon:'🔮'},
});

// 2026-05-10 ELEMENT_BONUS 폐기 (사용자 결정) — 원소별 ATK/HP 가산 제거. 영웅 스탯 = HERO_BASE 그대로.
// 향후 재도입 시 createHero 의 HP/ATK 계산에 다시 가산하면 됨.

// ── 스킨 (성별 × 역할) → 이미지 파일명 배열. 2026-05-09: 옛 PNG trash, _v2 신규 6장. ──
const HERO_SKINS = Object.freeze({
  m: {
    warrior: ['protagonist_m_warrior_v2'],
    ranger:  ['protagonist_m_ranger_v2'],
    support: ['protagonist_m_support_v2'],
  },
  f: {
    warrior: ['protagonist_f_warrior_v2'],
    ranger:  ['protagonist_f_ranger_v2'],
    support: ['protagonist_f_support_v2'],
  },
});

// ── 역할별 한국어 이름 ──
const HERO_NAMES = Object.freeze({
  warrior: '근접 전사',
  ranger:  '원거리 궁수',
  support: '지원 마법사',
});

// ── 시그니처 keywords + ability (역할 × 원소) ──
// 옛 skill/skillType/bonusTrigger → PHASE 6 keywords + ability 텍스트
// 폐기 메커닉(DEF 차감/eva/luck/속도) 텍스트는 ability 에 임시 남음 — STEP 별도 batch 에서 정리
const HERO_ABILITY = Object.freeze({
  warrior: {
    fire:      {keywords:[],        ability:'HP 50% 이하 시 ATK 2배. 공격 시 20% 확률로 인접 적에게 50% 추가 피해.'},
    water:     {keywords:['taunt'], ability:'피격 시 20% 확률로 공격자에게 ATK 의 50% 반격.'},
    lightning: {keywords:[],        ability:'항상 먼저 공격. 공격 시 25% 확률로 2회 타격.'},
    earth:     {keywords:['taunt'], ability:'피격 시 20% 확률로 공격자에게 3 피해.'},
    dark:      {keywords:[],        ability:'50% 확률로 피해의 100% 를 HP 로 회복. 처치 시 40% 확률로 ATK +3 영구.'},
    holy:      {keywords:[],        ability:'턴 시작 시 90% 확률로 HP +4. 발동 시 20% 확률로 다음 피해 1회 무효.'},
  },
  ranger: {
    fire:      {keywords:[],        ability:'턴마다 60% 확률로 적 전체 3 피해. 발동 시 25% 확률로 대상 2턴 화상(턴당 3).'},
    water:     {keywords:[],        ability:'50% 확률로 적 1체 1턴 행동불가. 공격 시 15% 확률로 대상 약화.'},
    lightning: {keywords:[],        ability:'관통 사격. 공격 시 20% 확률로 대상 HP 10% 즉사.'},
    earth:     {keywords:['taunt'], ability:'피격 시 20% 확률로 공격자에게 3 피해.'},
    dark:      {keywords:[],        ability:'30% 확률로 3배 피해. 처치 시 40% 확률로 다음 턴 회피.'},
    holy:      {keywords:[],        ability:'항상 먼저 공격. 공격 시 20% 확률로 2회 타격.'},
  },
  support: {
    fire:      {keywords:[],        ability:'턴마다 70% 확률로 적 전체 3 피해. 발동 시 25% 확률로 대상 2턴 화상(턴당 3).'},
    water:     {keywords:[],        ability:'턴마다 80% 확률로 아군 1체 HP +5. 발동 시 30% 확률로 아군 전체 HP +2.'},
    lightning: {keywords:[],        ability:'턴마다 70% 확률로 아군 전체 ATK +2. 발동 시 25% 확률로 적 전체 2 피해.'},
    earth:     {keywords:[],        ability:'턴마다 80% 확률로 아군 전체 HP +3. 발동 시 20% 확률로 랜덤 아군 보호막 +3.'},
    dark:      {keywords:[],        ability:'70% 확률로 피해 50% 회복. 처치 시 35% 확률로 ATK +3 영구.'},
    holy:      {keywords:[],        ability:'턴마다 90% 확률로 아군 1체 HP +6. 발동 시 25% 확률로 아군 전체 HP +3.'},
  },
});

// ── 옵션 리스트 (UI 렌더용). 2026-05-09: 영웅 원소 holy 고정 (사용자 결정). ──
RoF.Data.HERO_OPTIONS = Object.freeze({
  genders:  ['m','f'],
  roles:    ['warrior','ranger','support'],
  elements: ['holy'],
});

RoF.Data.HERO_LABELS = Object.freeze({
  genders:  {m:'남성', f:'여성'},
  roles:    {warrior:'근접 전사', ranger:'원거리 궁수', support:'지원 마법사'},
  elements: {fire:'불', water:'물', lightning:'전기', earth:'땅', dark:'암흑', holy:'신성'},
});

// ── 스킨 개수 조회 ──
RoF.Data.getHeroSkinCount = function(gender, role) {
  return (HERO_SKINS[gender] && HERO_SKINS[gender][role] || []).length;
};

// ── 스킨 파일명 조회 ──
RoF.Data.getHeroSkinKey = function(gender, role, skinIndex) {
  const list = HERO_SKINS[gender] && HERO_SKINS[gender][role];
  if (!list || !list.length) return null;
  const i = Math.max(0, Math.min(skinIndex|0, list.length - 1));
  return list[i];
};

// ── Legacy role alias (구 auth 'melee'|'ranged' → warrior/ranger) ──
const ROLE_ALIAS = Object.freeze({melee:'warrior', ranged:'ranger'});

// ── 영웅 카드 객체 생성 (PHASE 6 5필드) ──
// opts = {gender:'m'|'f', role:'warrior'|'ranger'|'support'|'melee'|'ranged', element:'fire'|..., skinIndex?:int}
RoF.Data.createHero = function(opts) {
  const gender  = opts && opts.gender;
  const rawRole = opts && opts.role;
  const role    = ROLE_ALIAS[rawRole] || rawRole;
  const element = opts && opts.element;
  const base    = HERO_BASE[role];
  if (!base) throw new Error('createHero: unknown role ' + role);
  if (!HERO_SKINS[gender] || !HERO_SKINS[gender][role]) {
    throw new Error('createHero: unknown gender/role ' + gender + '/' + role);
  }
  if (!element) {
    throw new Error('createHero: missing element');
  }

  const skinList  = HERO_SKINS[gender][role];
  const skinIndex = (opts.skinIndex != null)
    ? Math.max(0, Math.min(opts.skinIndex|0, skinList.length - 1))
    : Math.floor(Math.random() * skinList.length);
  const skinKey   = skinList[skinIndex];
  // 2026-05-10 ELEMENT_BONUS / HERO_ABILITY 폐기 (사용자 결정).
  // 영웅 스탯 = HERO_BASE 그대로. keywords/ability 빈 값.

  // ── 영웅 desc (gender × role × holy 고정) ──
  const HERO_DESCS = Object.freeze({
    'hero_m_warrior_holy': '맹세한 자는 쓰러지지 않는다.',
    'hero_m_ranger_holy':  '화살 하나로 운명의 실을 끊는다.',
    'hero_m_support_holy': '빛이 닿는 곳마다 상처가 닫힌다.',
    'hero_f_warrior_holy': '방패는 신성의 약속으로 만들어졌다.',
    'hero_f_ranger_holy':  '시위를 놓기 전, 이미 끝나 있다.',
    'hero_f_support_holy': '손 한 번에 전장의 숨결이 되돌아온다.',
  });

  // 2026-05-09: 영웅 시그니처 스킬 5장 자동 부여 (gender × role 매핑, holy 고정).
  const heroId = `hero_${gender}_${role}_${element}`;
  const HERO_SIG = {
    'hero_m_warrior_holy': ['sk_hero_m_warrior_attack','sk_hero_m_warrior_shield','sk_hero_m_warrior_train','sk_hero_m_warrior_morale','sk_hero_m_warrior_soul_boost'],
    'hero_m_support_holy': ['sk_hero_m_support_attack','sk_hero_m_support_heal','sk_hero_m_support_teach','sk_hero_m_support_divine_army','sk_hero_m_support_soul_boost'],
    'hero_m_ranger_holy':  ['sk_hero_m_ranger_attack','sk_hero_m_ranger_volley','sk_hero_m_ranger_hunt','sk_hero_m_ranger_archery','sk_hero_m_ranger_soul_boost'],
    'hero_f_warrior_holy': ['sk_hero_f_warrior_attack','sk_hero_f_warrior_shield','sk_hero_f_warrior_train','sk_hero_f_warrior_morale','sk_hero_f_warrior_soul_boost'],
    'hero_f_support_holy': ['sk_hero_f_support_attack','sk_hero_f_support_heal','sk_hero_f_support_teach','sk_hero_f_support_divine_army','sk_hero_f_support_soul_boost'],
    'hero_f_ranger_holy':  ['sk_hero_f_ranger_attack','sk_hero_f_ranger_volley','sk_hero_f_ranger_hunt','sk_hero_f_ranger_archery','sk_hero_f_ranger_soul_boost'],
  };

  return {
    id:        heroId,
    name:      (opts && opts.name) || HERO_NAMES[role],   // opts.name 우선 (봇/dev 고유 이름 주입) → 없으면 역할 generic
    element:   element,
    race:      'human',             // 2026-05-30 race 시스템 부활 — 시즌 1 영웅 모두 인간 (design/race_synergy_2026-05-30.md)
    role:      base.role,           // attack | support
    rarity:    'bronze',
    kind:      'hero',              // PHASE 6 — 손패에 안 들어가는 카드
    // 2026-05-10 ATK 아이콘 분기 — warrior=칼, ranger=활/화살, support=마법
    dmgType:   role === 'ranger' ? 'ranged' : (role === 'warrior' ? 'melee' : 'magic'),
    HP:        base.HP,
    ATK:       base.ATK,
    SOUL:      base.SOUL,                      // 모든 영웅 5 고정 (2026-05-06)
    keywords:  [],
    ability:   '',
    desc:      HERO_DESCS[heroId] || '',
    bundledSkillIds: HERO_SIG[heroId] || [],   // 영웅 시그니처 5장 자동 부여
    // 영웅 전용 메타
    _isHero:   true,
    _heroRole: role,                // 템플릿 role (warrior/ranger/support)
    gender:    gender,
    skinIndex: skinIndex,
    skinKey:   skinKey,
  };
};

// ── 영웅 ID 판별 (레거시 h_* / 신 hero_* 모두 인식) ──
RoF.Data.isHeroId = function(id) {
  if (!id || typeof id !== 'string') return false;
  return id.startsWith('hero_') || id.startsWith('h_m_') || id.startsWith('h_r_') || id.startsWith('h_s_');
};

// ─────────────────────────────────────────────────────────────
// Named heroes — 개별 영웅 카드 (템플릿 createHero 와 별개. 적 영웅 / NPC 영웅 등)
// ─────────────────────────────────────────────────────────────
// 2026-06-07 q_wolf_cull (design/quest_lines_v1.md v3): hero_wolf_alpha = 첫 named-hero.
//   SoT §1.2 는 11_data_units.js 라 했으나 거긴 unit 풀 → 오염 방지 위해 영웅 파일에 별도 레지스트리로 둠.
//   스탯/속성은 영웅 카드 데이터가 정본 (04-balance 'SOUL 5' 는 권고). wolf_alpha SOUL 3 개별 매핑.
const NAMED_HEROES = Object.freeze({
  hero_wolf_alpha: Object.freeze({
    id: 'hero_wolf_alpha',
    name: '우두머리 늑대',
    element: 'earth',
    race: 'beast',          // ⚠️ 시즌 1 영웅 최초 비-human (lore-bible §16.1 정정 인계)
    role: 'attack',         // HERO_BASE.warrior.role 정합
    rarity: 'silver',
    kind: 'hero',
    dmgType: 'melee',
    HP: 15, ATK: 2, SOUL: 3,
    keywords: [],
    ability: '',            // 자체 패시브 없음 — 시그니처 5 스킬이 풀
    desc: '굶주린 무리의 으뜸. 두 눈에 결정이 있다.',
    bundledSkillIds: ['sk_wolf_alpha_scratch','sk_wolf_alpha_bite','sk_wolf_alpha_agile','sk_wolf_alpha_natural_gift','sk_wolf_alpha_alpha_call'],
    _isHero: true,
    _heroRole: 'warrior',
    gender: 'm',
  }),
});
RoF.Data.NAMED_HEROES = NAMED_HEROES;
// 영웅 카드 조회 (named 우선). 매치/퀘스트 빌더가 적 영웅 lookup 에 사용. 항상 shallow copy 반환.
RoF.Data.getHeroById = function(id){
  const h = NAMED_HEROES[id];
  return h ? Object.assign({}, h) : null;
};

})();
