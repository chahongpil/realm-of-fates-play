// 퀘스트 데이터 — 정본 spec: design/quest_system_v1.md + design/quest_ux_spec_v1.md
// QUESTS_DB = 순수 데이터 + 풀 6개 (battle 3 + timed 3, Lv1~5 밴드).
// 상태/저장/respawn/보상/전투력·성공률 로직은 js/56_game_quests.js (이 파일은 데이터만).
// 적 덱/보상은 "id 스펙"으로만 보관 — 실제 카드 해석은 라우팅/보상 레이어에서.
//
// 필드:
//  공통: id, title, desc, type, giver, levelMin/Max, cooldownHours, reward{gold, cardPool, cardDropChance}, dialogue{portrait, accept[3], complete[3]}
//  battle: battle{enemyHero, enemyUnits, scenario}
//  timed:  durationMin, requiredPower, prefer{element, race, dmgType}  (성공률 계산용)
(function (global) {
  const RoF = global.RoF = global.RoF || {};
  RoF.Data = RoF.Data || {};

  const QUESTS_DB = [
    // ───────── battle 3 ─────────
    {
      id: 'q_wolf_cull',
      title: '굶주린 늑대 무리',
      desc: '변경 마을 외곽에 늑대 떼가 출몰했다. 두목 격 늑대가 무리를 부린다는 소문도 있다.',
      type: 'battle', giver: 'village',
      levelMin: 1, levelMax: 5, cooldownHours: 3,
      // 우두머리 늑대 = 신규 named-hero (hero_wolf_alpha). 일반 늑대 3 (신규 카드 0).
      battle: { enemyHero: { id: 'hero_wolf_alpha' }, enemyUnits: ['wolf', 'wolf', 'wolf'], scenario: 'quest_basic' },
      // cardPool 미지정 → 등장 카드 풀 (C안 분포는 Cluster B). jackpot 은 별도 roll (영웅 영입).
      reward: {
        gold: 8,
        cardDropChance: 0.3,
        jackpot: { cardId: 'hero_wolf_alpha', chance: 0.001 },
        rewardVision: { normal: 'scene_3', jackpot: 'fates_thread' },
      },
      previewMode: 'masked_first',   // 첫 도전 ??? / 격파 후 풀 공개
      dialogue: { portrait: 'village_elder', cutscene: 'village_elder_full',
        accept: ['촌장의 지팡이가 흙바닥을 두드린다.', '"늑대 떼가 밤마다 울타리를 넘는다. 마을의 잠이 짧아진다."', '"두목 격이 있다 들었다. 그 놈의 두 눈이 결정을 품었더라 하더군."'],
        complete: ['"두목까지 잡아냈군. 잘 했다."', '"이 늙은 손이 줄 것은 약소하다. 받아 두어라."', '"또 부를 일이 있으면 게시판에 글을 두마."'] },
    },
    {
      id: 'q_flame_spirit_cull',
      title: '화염정령 토벌',
      desc: '잿더미 상회의 의뢰 — 화산 어귀에서 날뛰는 정령을 잠재워라.',
      type: 'battle', giver: 'guild_ash',
      levelMin: 2, levelMax: 5, cooldownHours: 4,
      battle: { enemyHero: { role: 'ranger', element: 'fire', gender: 'f' }, enemyUnits: ['fire_spirit', 'pyromancer', 'fire_spirit'], scenario: 'quest_basic' },
      reward: { gold: 12, cardPool: ['sk_boil', 'sk_rage'], cardDropChance: 0.45 },
      dialogue: { portrait: 'pyromancer',
        accept: ['잿더미 상회의 중개인이 장부를 덮는다.', '"화염정령이 광맥을 막고 있소. 거래엔 늘 대가가 따르지."', '"놈을 꺼뜨려 오면, 값은 후하게 쳐주겠소."'],
        complete: ['"불씨가 잦아들었군. 역시 거래 상대를 잘 골랐어."', '"약속한 값이오. 잿더미 상회는 빚을 남기지 않지."', '"또 태울 것이 생기면 찾아오시오."'] },
    },
    {
      id: 'q_bandit_raid',
      title: '산적단 소탕',
      desc: '교역로를 막은 산적들. 두목을 쓰러뜨려 길을 열어라.',
      type: 'battle', giver: 'village',
      levelMin: 3, levelMax: 5, cooldownHours: 5,
      battle: { enemyHero: { role: 'warrior', element: 'dark', gender: 'm' }, enemyUnits: ['rogue', 'assassin', 'crossbow'], scenario: 'quest_basic' },
      reward: { gold: 16, cardPool: ['sk_execute', 'sk_cleave'], cardDropChance: 0.5 },
      dialogue: { portrait: 'rogue',
        accept: ['상인 조합장이 이를 간다.', '"산적 놈들이 교역로를 틀어막았소. 장사를 못 하겠단 말이오!"', '"두목의 목을 가져오면 조합이 사례하리다."'],
        complete: ['"길이 뚫렸다! 이제 마차가 다닐 수 있겠어."', '"조합을 대표해 감사드리오. 받아주시오."', '"교역로는 그대 덕에 안전해졌소."'] },
    },

    // ───────── timed 3 (방치 파견) ─────────
    {
      id: 'q_farm_help',
      title: '마을 농장 도와주기',
      desc: '추수철 일손이 모자란다. 동료를 보내 농장 일을 거들게 하라.',
      type: 'timed', giver: 'village',
      levelMin: 1, levelMax: 5, cooldownHours: 2,
      durationMin: 50,
      requiredPower: 18, prefer: { element: 'earth', race: 'beast', dmgType: 'melee' },
      reward: { gold: 10, cardPool: ['sk_tough', 'sk_shield'], cardDropChance: 0.3 },
      dialogue: { portrait: 'herbalist',
        accept: ['농부 아낙이 땀을 닦는다.', '"추수철인데 일손이 없어요. 든든한 동료 몇 분만 보내주세요."', '"품삯은 넉넉히 드릴게요!"'],
        complete: ['"덕분에 추수를 무사히 마쳤어요!"', '"여기 약속한 품삯이에요. 정말 고마워요."', '"동료분들 솜씨가 좋던데요?"'] },
    },
    {
      id: 'q_herb_gather',
      title: '약초밭 채집',
      desc: '강가 약초장수가 일손을 청한다. 마른 약초를 거둬 오라.',
      type: 'timed', giver: 'village',
      levelMin: 1, levelMax: 5, cooldownHours: 2,
      durationMin: 30,
      requiredPower: 12, prefer: { element: 'water', race: 'spirit', dmgType: 'magic' },
      reward: { gold: 6, cardPool: ['sk_heal', 'sk_prayer'], cardDropChance: 0.25 },
      dialogue: { portrait: 'herbalist',
        accept: ['약초장수가 마른 잎을 만지작거린다.', '"강가 약초가 다 말랐어요. 거둬 올 손이 필요해요."', '"섬세한 동료라면 더 좋겠네요."'],
        complete: ['"이렇게 깨끗하게 거둬 오다니!"', '"약값에 보태 쓰세요. 고마워요."', '"다음에도 부탁드릴게요."'] },
    },
    {
      id: 'q_border_scout',
      title: '변경 정찰',
      desc: '국경 너머 기척이 수상하다. 척후를 보내 동태를 살펴라.',
      type: 'timed', giver: 'guild_ash',
      levelMin: 2, levelMax: 5, cooldownHours: 3,
      durationMin: 60,
      requiredPower: 28, prefer: { element: 'lightning', race: 'avian', dmgType: 'ranged' },
      reward: { gold: 12, cardPool: ['sk_reflex', 'sk_swift'], cardDropChance: 0.35 },
      dialogue: { portrait: 'crossbow',
        accept: ['상회의 척후장이 지도를 편다.', '"국경 너머가 수상하오. 발 빠른 자들을 보내 살펴주시오."', '"멀리 보는 눈이 있으면 더 좋겠소."'],
        complete: ['"정찰 보고가 정확하군. 큰 도움이 됐소."', '"수고비요. 상회는 정보값을 아끼지 않지."', '"다음 정찰도 부탁하겠소."'] },
    },
  ];

  // ── 순수 헬퍼 ──
  RoF.Data.QUESTS_DB = QUESTS_DB;
  RoF.Data.getQuest = function (id) { return QUESTS_DB.find(q => q.id === id) || null; };

  // 도전 레벨 XP 곡선 (04-balance: 100 × L^1.5)
  RoF.Data.challengeXpForLevel = function (level) { return Math.round(100 * Math.pow(level, 1.5)); };

  // 카드 등급별 전투력 배수 (전투력 공식 — 56_game_quests cardPower 사용)
  RoF.Data.QUEST_RARITY_POWER = { bronze: 1.0, silver: 1.5, gold: 2.2, legendary: 3.2, divine: 4.5 };

  // 게시판/풀 상수
  RoF.Data.QUEST_BOARD_SLOTS = 3;        // 게시판 최대 동시 노출
  RoF.Data.QUEST_MAX_ACTIVE_TIMED = 2;   // 동시 진행 가능한 timed 슬롯
  RoF.Data.QUEST_PARTY_MAX = 5;          // 편성 동료 최대
  RoF.Data.QUEST_REWARD_CAP = 2.0;       // 보상 배율 상한 (200%)
  RoF.Data.QUEST_MATCH_BONUS = 5;        // prefer 매칭 카드당·속성당 +5% 성공률

})(typeof window !== 'undefined' ? window : globalThis);
