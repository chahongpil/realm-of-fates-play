'use strict';

// ─────────────────────────────────────────────────────────────
// 일반 유닛 카드 (PHASE 6 신스키마 — 2026-05-05 마이그레이션)
// 5필드 (HP/ATK/NEED_SOUL/SOUL/keywords) + 메타 (id/name/element/role/rarity/kind/dmgType/ability/desc)
//
// 2026-05-06 추가 (design/phase6_unit_skill_bundle.md — 유닛-스킬 패키지 시스템):
//   (unique 필드 2026-06-12 폐기 — 전열정비 v3 '캐릭터당 1 인스턴스' + tavern id-dedup(52)으로 대체. 등급별 매수 한도 무의미)
//   bundledSkillIds — 종속 고유 스킬 ID 배열. 덱빌딩 시 자동 동반 (덱 슬롯 합산)
//                     11개 패키지 유닛만 채워짐, 나머지는 빈 배열.
//
// 2026-05-17 추가 (design/battle_system_decisions.md PHASE 6 dmgType 섹션):
//   dmgType         — 'melee' | 'ranged' | 'magic'. 게임 영향: 반사 데미지 / DEF 차감 / taunt 우선 분기.
//                     영웅은 createHero 가 role 따라 자동 (warrior→melee/ranger→ranged/support→magic).
//                     unit 은 데이터에 명시 (시그니처 무기 + desc 기준 사용자 결정).
//
// 2026-05-30 부활 (design/race_synergy_2026-05-30.md — 13종 종족 시스템):
//   race            — 종족 13종: human / beast / dragon / avian / undead / demon /
//                     celestial / spirit / titan / abyssal / fae / veinforged / savage
//                     게임 영향: 보드 같은 종족 N+ 시 누적 효과 + 6단계 매치 1회 특수능력.
//                     영웅은 createHero 가 race:'human' 자동 부여 (시즌 1 한정).
//                     unit 은 데이터에 명시. 옛 PHASE 3 race='human'/'beast' 정합 유지.
//
// 폐기 필드 (절대 추가 금지):
//   def, spd, luck, eva, meva, hpReg, nrgReg, maxHp, critBonus, critMult,
//   skill, skillType, skillChance, skillNrg, skillArmor, skillDesc, bonusTrigger,
//   skillIds (구 PHASE 3 — bundledSkillIds 로 부활했지만 옛 필드명은 금지),
//   attackType, targetType, type, range, icon
// ─────────────────────────────────────────────────────────────

RoF.Data.UNITS = Object.freeze([
  {id:'militia', name:'민병', element:'earth', race:'human', role:'attack', rarity:'bronze', kind:'unit', dmgType:'melee', HP:1, ATK:1, NEED_SOUL:1, keywords:[], ability:'', desc:'흙손에도 창은 곧다.', bundledSkillIds:['sk_militia_thrust','sk_militia_harvest','sk_militia_soul_gain','sk_militia_cooking']},
  {id:'hunter', name:'사냥꾼', element:'earth', race:'human', role:'attack', rarity:'bronze', kind:'unit', dmgType:'ranged', HP:2, ATK:2, NEED_SOUL:2, keywords:[], ability:'', desc:'발자국 하나도 허투루 밟지 않는다.', bundledSkillIds:['sk_hunter_basic_attack','sk_hunter_hound_strike','sk_hunter_summon_bear','sk_hunter_summon_wolf','sk_hunter_mark']},
  {id:'apprentice', name:'견습마법사', element:'fire', race:'human', role:'support', rarity:'bronze', kind:'unit', dmgType:'magic', HP:2, ATK:1, NEED_SOUL:1, keywords:[], ability:'', desc:'갓 깨어난 불꽃을 손에 들었다.', bundledSkillIds:['sk_apprentice_fire_attack','sk_apprentice_fireball','sk_apprentice_focus','sk_apprentice_fire_focus','sk_apprentice_fire_shield'], aiHint:'support'},
  {id:'wolf', name:'늑대', element:'earth', race:'beast', role:'attack', rarity:'bronze', kind:'unit', dmgType:'melee', HP:1, ATK:1, NEED_SOUL:1, keywords:[], ability:'', desc:'달빛이 송곳니에 비친다.', bundledSkillIds:['sk_wolf_basic_attack','sk_wolf_summon','sk_wolf_natural_heal']},
  {id:'guard', name:'수비병', element:'water', race:'human', role:'defense', rarity:'bronze', kind:'unit', dmgType:'melee', HP:3, ATK:1, NEED_SOUL:2, keywords:['taunt'], ability:'', desc:'방패 뒤에 한 마을이 잠든다.', bundledSkillIds:['sk_guard_thrust','sk_guard_shield','sk_guard_pierce_javelin','sk_guard_reorganize'], aiHint:'defensive'},
  {id:'rogue', name:'도적', element:'dark', race:'human', role:'attack', rarity:'bronze', kind:'unit', dmgType:'melee', HP:1, ATK:2, NEED_SOUL:1, keywords:[], ability:'', desc:'그림자도 그의 발소리를 못 듣는다.', bundledSkillIds:['sk_rogue_basic_attack','sk_rogue_assassinate','sk_rogue_steal'], aiHint:'control'},
  {id:'herbalist', name:'약초사', element:'earth', race:'human', role:'support', rarity:'bronze', kind:'unit', dmgType:'melee', HP:2, ATK:0, NEED_SOUL:1, keywords:[], ability:'', desc:'대지의 숨결로 상처를 닫는다.', bundledSkillIds:['sk_herbalist_first_aid','sk_herbalist_heal_aura','sk_herbalist_heal_atk_aura','sk_herbalist_sleep_powder'], aiHint:'support'},
  {id:'lancer', name:'창병', element:'lightning', race:'human', role:'attack', rarity:'bronze', kind:'unit', dmgType:'melee', HP:3, ATK:1, NEED_SOUL:2, keywords:[], ability:'', desc:'창끝에 천둥이 머문다.', bundledSkillIds:['sk_lancer_thrust','sk_lancer_anti_cavalry','sk_lancer_shield_block','sk_lancer_javelin']},
  {id:'crossbow', name:'석궁병', element:'fire', race:'human', role:'attack', rarity:'bronze', kind:'unit', dmgType:'ranged', HP:2, ATK:2, NEED_SOUL:2, keywords:[], ability:'', desc:'시위를 떠난 불화살은 되묻지 않는다.', bundledSkillIds:['sk_crossbow_basic_attack','sk_crossbow_rapid_fire','sk_crossbow_double_shot','sk_crossbow_stealth','sk_crossbow_bomb_arrow','sk_crossbow_focus','sk_crossbow_rest']},
  {id:'fire_spirit', name:'불꽃정령', element:'fire', race:'spirit', role:'attack', rarity:'bronze', kind:'unit', dmgType:'magic', HP:1, ATK:1, NEED_SOUL:1, keywords:[], ability:'', desc:'꺼지기 전에 가장 뜨겁게 타오른다.', bundledSkillIds:['sk_firespirit_fireball','sk_firespirit_enchant','sk_firespirit_giant','sk_firespirit_self_destruct'], aiHint:'sac'},  /* 2026-06-17 dmgType melee→magic: 정령이 화염구 스킬 보유한 마법 화염 유닛(사용자 보고 "마법 화염인데 근접공격"). magic=DEF/taunt 무시+반격면제 — ATK1/HP1/NEED1 sac 유닛이라 magic 보강룰 내 과하지 않음 */
  {id:'infantry', name:'보병', element:'earth', race:'human', role:'defense', rarity:'bronze', kind:'unit', dmgType:'melee', HP:3, ATK:1, NEED_SOUL:2, keywords:['taunt'], ability:'', desc:'땅에 발붙인 자는 쉽게 무너지지 않는다.', bundledSkillIds:['sk_infantry_basic_attack','sk_infantry_shield_block','sk_infantry_reorganize','sk_infantry_anti_lancer'], aiHint:'defensive'},
  {id:'archer', name:'궁병', element:'lightning', race:'human', role:'attack', rarity:'bronze', kind:'unit', dmgType:'ranged', HP:2, ATK:2, NEED_SOUL:2, keywords:[], ability:'', desc:'시위 소리가 번개보다 먼저 닿는다.', bundledSkillIds:['sk_archer_basic_attack','sk_archer_basic_attack2','sk_archer_fire_arrow','sk_archer_focus_fire','sk_archer_squad_buff']},
  {id:'monkey', name:'원숭이', element:'earth', race:'beast', role:'attack', rarity:'bronze', kind:'unit', dmgType:'ranged', HP:1, ATK:1, NEED_SOUL:1, keywords:[], ability:'', desc:'돌멩이 하나로 산을 흔든다.', bundledSkillIds:['sk_monkey_scratch','sk_monkey_stone_throw']},
  {id:'knight', name:'기사', element:'holy', race:'human', role:'defense', rarity:'silver', kind:'unit', dmgType:'melee', HP:3, ATK:2, NEED_SOUL:2, keywords:['taunt'], ability:'', desc:'신성의 가호가 갑옷 틈새를 채운다.', bundledSkillIds:[], aiHint:'defensive'},
  {id:'assassin', name:'암살자', element:'dark', race:'human', role:'attack', rarity:'silver', kind:'unit', dmgType:'melee', HP:2, ATK:3, NEED_SOUL:2, keywords:[], ability:'', desc:'어둠의 유산으로 벼려진 칼날.', bundledSkillIds:[], aiHint:'finisher'},
  {id:'pyromancer', name:'화염술사', element:'fire', race:'human', role:'attack', rarity:'silver', kind:'unit', dmgType:'magic', HP:1, ATK:3, NEED_SOUL:2, keywords:[], ability:'', desc:'불꽃 속에서 배운 자는 재를 두려워 않는다.', bundledSkillIds:['sk_pyromancer_fireball','sk_pyromancer_flame_shield','sk_pyromancer_learn','sk_pyromancer_burning_orb','sk_pyromancer_soul_drain','sk_pyromancer_ignite'], aiHint:'control'},
  {id:'cryomancer', name:'빙결술사', element:'water', race:'human', role:'defense', rarity:'silver', kind:'unit', dmgType:'magic', HP:2, ATK:2, NEED_SOUL:2, keywords:[], ability:'', desc:'망각의 샘터가 남긴 냉기의 잔재.', bundledSkillIds:[], aiHint:'control'},
  {id:'cryomancer_f', name:'빙결술사', element:'water', race:'human', role:'support', rarity:'silver', kind:'unit', dmgType:'magic', HP:2, ATK:2, NEED_SOUL:2, keywords:[], ability:'', desc:'얼음은 상처를 덮기도, 지우기도 한다.', bundledSkillIds:[], aiHint:'support'},
  {id:'berserker', name:'광전사', element:'fire', race:'human', role:'attack', rarity:'silver', kind:'unit', dmgType:'melee', HP:2, ATK:3, NEED_SOUL:3, keywords:[], ability:'', desc:'타오를수록 멈추지 못한다.', bundledSkillIds:[], aiHint:'pump'},
  {id:'priest', name:'사제', element:'holy', race:'human', role:'support', rarity:'silver', kind:'unit', dmgType:'melee', HP:3, ATK:0, NEED_SOUL:2, keywords:[], ability:'', desc:'빛의 가호가 손끝에서 흘러내린다.', bundledSkillIds:[], aiHint:'support'},
  {id:'thunderbird', name:'썬더버드', element:'lightning', race:'avian', role:'attack', rarity:'silver', kind:'unit', dmgType:'melee', HP:4, ATK:2, NEED_SOUL:3, keywords:[], ability:'', desc:'천둥 구름을 날개로 헤치며 온다.', bundledSkillIds:[]},
  {id:'griffin', name:'그리핀', element:'lightning', race:'avian', role:'attack', rarity:'silver', kind:'unit', dmgType:'melee', HP:3, ATK:2, NEED_SOUL:2, keywords:[], ability:'', desc:'하늘과 땅 사이, 번개의 잔재가 깃들다.', bundledSkillIds:[]},
  {id:'stormcaller', name:'번개 채들러', element:'lightning', race:'human', role:'attack', rarity:'silver', kind:'unit', dmgType:'magic', HP:3, ATK:3, NEED_SOUL:3, keywords:[], ability:'', desc:'폭풍을 부르는 자는 먼저 맞아야 한다.', bundledSkillIds:[], aiHint:'aoe-priority'},
  {id:'stonemason', name:'석공 전사', element:'earth', race:'human', role:'defense', rarity:'silver', kind:'unit', dmgType:'melee', HP:4, ATK:2, NEED_SOUL:3, keywords:['taunt'], ability:'', desc:'돌을 깎은 손이 벽이 된다.', bundledSkillIds:[], aiHint:'defensive'},
  {id:'pirate', name:'해적', element:'water', race:'human', role:'attack', rarity:'silver', kind:'unit', dmgType:'melee', HP:2, ATK:2, NEED_SOUL:2, keywords:[], ability:'', desc:'파도 위에 맹세 따위는 없다.', bundledSkillIds:[]},
  {id:'tidal_knight', name:'해파의 기사', element:'water', race:'human', role:'attack', rarity:'silver', kind:'unit', dmgType:'melee', HP:3, ATK:3, NEED_SOUL:3, keywords:[], ability:'', desc:'밀려오는 파도처럼 막을 수 없다.', bundledSkillIds:[]},
  {id:'monkey_general', name:'원숭이장군', element:'earth', race:'beast', role:'attack', rarity:'silver', kind:'unit', dmgType:'melee', HP:2, ATK:2, NEED_SOUL:2, keywords:[], ability:'', desc:'화과산을 흔드는 한 발자국.', bundledSkillIds:['sk_general_thrust','sk_general_defend','sk_general_meditation'], aiHint:'pump'},
  {id:'paladin', name:'성기사', element:'holy', race:'human', role:'defense', rarity:'gold', kind:'unit', dmgType:'melee', HP:4, ATK:3, NEED_SOUL:3, keywords:[], ability:'', desc:'신성의 축복이 그 서약을 불멸로 만든다.', bundledSkillIds:[], aiHint:'defensive'},
  {id:'archmage', name:'대마법사', element:'lightning', race:'human', role:'attack', rarity:'gold', kind:'unit', dmgType:'magic', HP:3, ATK:2, NEED_SOUL:3, keywords:[], ability:'', desc:'벼락은 그의 가르침이 곧 마법임을 증명한다.', bundledSkillIds:[], aiHint:'aoe-priority'},
  {id:'death_knight', name:'죽음의기사', element:'dark', race:'undead', role:'attack', rarity:'gold', kind:'unit', dmgType:'melee', HP:3, ATK:4, NEED_SOUL:3, keywords:[], ability:'', desc:'어둠의 가호를 받은 갑옷, 죽음도 못 벗긴다.', bundledSkillIds:[], aiHint:'finisher'},
  {id:'sniper', name:'저격수', element:'lightning', race:'human', role:'attack', rarity:'gold', kind:'unit', dmgType:'ranged', HP:3, ATK:5, NEED_SOUL:4, keywords:[], ability:'', desc:'번개 한 줄기, 그것으로 충분하다.', bundledSkillIds:[], aiHint:'finisher'},
  {id:'phoenix', name:'불사조', element:'fire', race:'avian', role:'support', rarity:'gold', kind:'unit', dmgType:'melee', HP:3, ATK:5, NEED_SOUL:5, keywords:[], ability:'', desc:'재에서 다시 솟는 불꽃의 파편.', bundledSkillIds:[], aiHint:'support'},
  {id:'armored_griffin', name:'중장갑 그리핀', element:'earth', race:'avian', role:'defense', rarity:'gold', kind:'unit', dmgType:'melee', HP:3, ATK:3, NEED_SOUL:3, keywords:['taunt'], ability:'', desc:'대지의 축복을 두른 날개와 발톱.', bundledSkillIds:[], aiHint:'defensive'},
  {id:'genie_noble', name:'고귀한 지니', element:'lightning', race:'spirit', role:'support', rarity:'gold', kind:'unit', dmgType:'melee', HP:2, ATK:4, NEED_SOUL:3, keywords:[], ability:'', desc:'소원 한 마디가 벼락 한 방이 된다.', bundledSkillIds:[], aiHint:'support'},
  {id:'stonemason_noble', name:'고귀한 석공 전사', element:'earth', race:'human', role:'defense', rarity:'gold', kind:'unit', dmgType:'melee', HP:4, ATK:2, NEED_SOUL:3, keywords:['taunt'], ability:'', desc:'깎아도 깎아도 무너지지 않는 돌의 의지.', bundledSkillIds:[], aiHint:'defensive'},
  {id:'dark_shaman', name:'어둠의 주술사', element:'dark', race:'human', role:'support', rarity:'gold', kind:'unit', dmgType:'magic', HP:2, ATK:3, NEED_SOUL:3, keywords:[], ability:'', desc:'어둠과 거래한 자는 그 값을 지불했다.', bundledSkillIds:[], aiHint:'control'},
  {id:'tidal_knight_noble', name:'고귀한 해파의 기사', element:'water', race:'human', role:'attack', rarity:'gold', kind:'unit', dmgType:'melee', HP:4, ATK:2, NEED_SOUL:3, keywords:[], ability:'', desc:'파도의 가호가 갑옷마다 파문을 새겼다.', bundledSkillIds:[]},
  {id:'flame_warrior', name:'화염의 전사', element:'fire', race:'human', role:'attack', rarity:'gold', kind:'unit', dmgType:'melee', HP:4, ATK:2, NEED_SOUL:3, keywords:[], ability:'', desc:'재로 변할지언정 물러서지 않는다.', bundledSkillIds:[], aiHint:'pump'},
  {id:'wukong', name:'오공', element:'earth', race:'beast', role:'attack', rarity:'gold', kind:'unit', dmgType:'melee', HP:3, ATK:4, NEED_SOUL:3, keywords:[], ability:'', desc:'봉이 떨어지면 천계가 갈라진다.', bundledSkillIds:['sk_wukong_basic','sk_wukong_aoe','sk_wukong_clone'], aiHint:'aoe-priority'},
  {id:'dragon', name:'드래곤', element:'fire', race:'dragon', role:'attack', rarity:'legendary', kind:'unit', dmgType:'melee', HP:8, ATK:10, NEED_SOUL:7, keywords:[], ability:'', desc:'그라힘의 파편이 비늘마다 불꽃으로 새겨졌다.', bundledSkillIds:[], aiHint:'finisher'},
  {id:'lich', name:'리치', element:'dark', race:'undead', role:'attack', rarity:'legendary', kind:'unit', dmgType:'magic', HP:4, ATK:5, NEED_SOUL:5, keywords:[], ability:'', desc:'어둠의 파편으로 죽음마저 계약서에 묶었다.', bundledSkillIds:[], aiHint:'control'},
  {id:'archangel', name:'대천사', element:'holy', race:'celestial', role:'defense', rarity:'legendary', kind:'unit', dmgType:'melee', HP:12, ATK:10, NEED_SOUL:9, keywords:[], ability:'', desc:'그대의 신앙에 성검을 내릴지니.', bundledSkillIds:[], aiHint:'defensive'},
  {id:'griffin_knight', name:'심홍의 그리핀 기사', element:'fire', race:'human', role:'attack', rarity:'legendary', kind:'unit', dmgType:'melee', HP:4, ATK:5, NEED_SOUL:4, keywords:[], ability:'', desc:'불꽃 날개로 하늘을 갈라 적진에 내린다.', bundledSkillIds:[], aiHint:'finisher'},
  {id:'griffin_rider', name:'전설의 그리핀 용사', element:'holy', race:'human', role:'attack', rarity:'legendary', kind:'unit', dmgType:'melee', HP:5, ATK:7, NEED_SOUL:5, keywords:[], ability:'', desc:'신성의 파편을 안장 삼아 하늘을 달린다.', bundledSkillIds:[], aiHint:'finisher'},
  {id:'earth_guardian', name:'대지의 수호자', element:'earth', race:'spirit', role:'defense', rarity:'legendary', kind:'unit', dmgType:'melee', HP:9, ATK:1, NEED_SOUL:5, keywords:['taunt'], ability:'', desc:'에이드라의 파편으로 빚어진 침묵의 장벽.', bundledSkillIds:[], aiHint:'defensive'},
  {id:'sea_priest', name:'심해의 대신관', element:'water', race:'human', role:'support', rarity:'legendary', kind:'unit', dmgType:'magic', HP:6, ATK:1, NEED_SOUL:5, keywords:[], ability:'', desc:'모라스의 파편이 기억을 치유로 바꾼다.', bundledSkillIds:[], aiHint:'support'},
  {id:'genie_legendary', name:'전설의 지니', element:'lightning', race:'spirit', role:'attack', rarity:'legendary', kind:'unit', dmgType:'melee', HP:4, ATK:5, NEED_SOUL:6, keywords:[], ability:'', desc:'브론테스의 파편이 소원 속에 번개를 숨겼다.', bundledSkillIds:[], aiHint:'finisher'},
  {id:'mountain_breaker', name:'산악 파괴자', element:'earth', race:'human', role:'attack', rarity:'legendary', kind:'unit', dmgType:'melee', HP:7, ATK:3, NEED_SOUL:4, keywords:[], ability:'', desc:'산을 깨는 주먹, 대지의 파편으로 단련됐다.', bundledSkillIds:[], aiHint:'pump'},
  {id:'sea_paladin', name:'해신 팔라딘', element:'water', race:'human', role:'defense', rarity:'legendary', kind:'unit', dmgType:'melee', HP:5, ATK:4, NEED_SOUL:4, keywords:[], ability:'', desc:'심해의 파편이 방패에 파도를 새겼다.', bundledSkillIds:[], aiHint:'defensive'},
  {id:'flame_guardian', name:'화염의 수호자', element:'fire', race:'human', role:'defense', rarity:'legendary', kind:'unit', dmgType:'melee', HP:5, ATK:4, NEED_SOUL:4, keywords:[], ability:'', desc:'불꽃의 파편으로 굳혀진 불굴의 파수꾼.', bundledSkillIds:[], aiHint:'defensive'},
  {id:'sun_wukong', name:'손오공', element:'earth', race:'beast', role:'attack', rarity:'legendary', kind:'unit', dmgType:'melee', HP:5, ATK:6, NEED_SOUL:5, keywords:[], ability:'', desc:'죽음마저 그를 비껴간다.', bundledSkillIds:['sk_sun_wukong_basic','sk_sun_wukong_revive','sk_sun_wukong_clone'], aiHint:'finisher'},
  {id:'titan', name:'번개 타이탄', element:'lightning', race:'titan', role:'attack', rarity:'divine', kind:'unit', dmgType:'ranged', HP:9, ATK:11, NEED_SOUL:8, keywords:[], ability:'', desc:'폭풍을 두르고 천둥과 함께 강림한다.', bundledSkillIds:[], aiHint:'finisher'},
  {id:'archfiend', name:'대악마', element:'dark', race:'demon', role:'attack', rarity:'divine', kind:'unit', dmgType:'melee', HP:10, ATK:12, NEED_SOUL:9, keywords:[], ability:'', desc:'현 세대 네크리온의 힘이 육신을 입고 걷는다.', bundledSkillIds:[], aiHint:'finisher'},
  {id:'behemoth', name:'땅의 신 베히모스', element:'earth', race:'titan', role:'attack', rarity:'divine', kind:'unit', dmgType:'melee', HP:14, ATK:6, NEED_SOUL:8, keywords:[], ability:'', desc:'에이드라의 침묵이 움직이기 시작했다.', bundledSkillIds:[], aiHint:'aoe-priority'},
  {id:'leviathan', name:'바다의 신 레비아탄', element:'water', race:'abyssal', role:'attack', rarity:'divine', kind:'unit', dmgType:'melee', HP:10, ATK:8, NEED_SOUL:7, keywords:[], ability:'', desc:'모라스가 기억의 심연에서 불러낸 존재.', bundledSkillIds:[], aiHint:'finisher'},
  {id:'great_sage', name:'제천대성', element:'earth', race:'beast', role:'attack', rarity:'divine', kind:'unit', dmgType:'melee', HP:8, ATK:9, NEED_SOUL:7, keywords:[], ability:'', desc:'하늘과 나란히 선 자.', bundledSkillIds:[], aiHint:'finisher'},
]);

// 호환성 레이어 (옛 코드 호환 — STEP 3 옛 엔진 폐기 시 함께 제거)
window.UNITS = RoF.Data.UNITS;

// ─────────────────────────────────────────────────────────────
// 종족·원소 시너지 테이블 (design/race_synergy_2026-05-30.md 정본 / 2026-06-13 구현 R1)
//   tier[N]      — 보드 같은 종족/원소 N명(1~6, UNIT 카운트) 시 unit 누적 효과량 (전체 column)
//   heroTier[N]  — 영웅 누적 효과량 (영웅 column). N 은 'unit 카운트' 기준 — 영웅은 카운트 제외 (인플레/인간편향 방지)
//   2026-06-13 옵션2: N=1→0 (1마리 자기버프 폐기, 2마리+부터 시너지 — 보편 스탯 인플레 방지, 04-balance 정합)
//   race{13}/element{6}: stat = 누적 효과 타입 / special = 6단계 매치1회 특수(R2) / tier3·tier5 = 원소 단계 추가효과(R2)
//   동시발동(옵션B): 종족 풀발동 + 원소 절반(ceil). R1 = persistent stat(ATK/DEF/HP) 오버레이만,
//                    HEAL/SOUL/DRAW(per-turn) + 3/5 extras + 6단계 특수는 R2.
// ─────────────────────────────────────────────────────────────
RoF.Data.SYNERGY = {
  tier:     [0, 0, 1, 2, 2, 3, 3],   // index = N (0 unused). 옵션2: N=1→0 (혼자선 0, 2마리+부터 +1)
  tierSolo: [0, 1, 1, 2, 2, 3, 3],   // solo 종족(천사·악마·거인·용 — 카드 1~2장뿐, 2 모으기 사실상 불가): N=1→+1 (혼자도 버프)
  heroTier: [0, 0, 1, 1, 2, 3, 3],
  race: {
    human:      { stat: 'DEF',  special: 'human_levelup' },
    beast:      { stat: 'ATK',  special: 'beast_rage' },
    dragon:     { stat: 'HP',   special: 'dragon_fury',     solo: true },
    avian:      { stat: 'ATK',  special: 'avian_evade' },
    undead:     { stat: 'HP',   special: 'undead_march' },
    demon:      { stat: 'ATK',  special: 'demon_pact',      solo: true },
    celestial:  { stat: 'HEAL', special: 'celestial_light', solo: true },
    spirit:     { stat: 'SOUL', special: 'spirit_fusion' },
    titan:      { stat: 'HP',   special: 'titan_quake',     solo: true },
    abyssal:    { stat: 'HEAL', special: 'abyssal_oblivion' },
    fae:        { stat: 'DRAW', special: 'fae_call' },
    veinforged: { stat: 'DEF',  special: 'veinforged_wall' },
    savage:     { stat: 'ATK',  special: 'savage_cry' },
  },
  // 2026-06-15 전면 재설계 (race_synergy §4 LOCK): tier "최고 하나만"(중첩 X) + 6단계 burst+지속.
  //   stat:null = 누적 stat 오버레이/자가회복 없음 (water/holy 회복·earth DEF 는 per-turn tier 핸들러로).
  //   displayStat = 인디케이터 표시용(stat null 인 원소의 정체성). per-turn 효과 핸들러: 60_turnbattle_v6 EXTRA.
  //   persist = 6단계 "다음 라운드부터 지속" 오라 코드 (트리거 후 영구, per-turn 에서 tier3/5 대체).
  element: {
    fire:      { stat: 'ATK',  tier3: 'burn_enemy_1', tier5: 'burn_all_1',  special: 'grahim_fury',  persist: 'burn_all_1' },
    water:     { stat: null, displayStat: 'HEAL', tier3: 'heal_rand_1', tier5: 'heal_all_1',  special: 'morath_mercy', persist: 'heal_all_1' },
    earth:     { stat: null, displayStat: 'DEF',  tier3: 'def_rand_1',  tier5: 'def_rand2_2', special: 'eidra_silence', persist: 'def_all_3' },
    lightning: { stat: 'ATK',  tier3: 'stun_sure_1',  tier5: 'stun_sure_2', special: 'brontes_bolt', persist: 'stun_sure_2' },
    holy:      { stat: null, displayStat: 'HEAL', tier3: 'heal_hero_2', tier5: null,          special: 'seraphiel_vow', persist: 'heal_all_1' },
    dark:      { stat: 'ATK',  tier3: 'dmg_enemy_1',  tier5: 'dark_t5',     special: 'necrion_pact', persist: 'dmg_all_1' },
  },
};

// ─────────────────────────────────────────────────────────────
// v2 form swap wrap (2026-05-26 — meta_progression_spec §6 정합)
//
// 옛 flat schema (id, name, rarity, HP, ATK, ...) 를 nested v2 schema
// ({baseForm, evolutions: {form_id: {rarity, name, stat, evolveTo, unlock}}}) 로 wrap.
//
// 진화 후보 (evolveTo[]) 는 빈 배열 시작 — 102 강화 데이터 디자인 batch 후 채움.
// 단일 form (자기 자신) 으로 시작 → 회귀 시 옛 데이터 그대로 복원 정합.
// ─────────────────────────────────────────────────────────────
RoF.Data.UNIT_DEF = (function(){
  const m = {};
  RoF.Data.UNITS.forEach(u => {
    m[u.id] = {
      baseForm: u.id,
      evolutions: {
        [u.id]: {
          rarity: u.rarity,
          name: u.name,
          imgKey: u.id,
          stat: { HP: u.HP, ATK: u.ATK, NEED_SOUL: u.NEED_SOUL, SOUL: u.SOUL || 0 },
          bundledSkillIds: Array.isArray(u.bundledSkillIds) ? [...u.bundledSkillIds] : [],
          evolveTo: [],     // 진화 후보 (별도 batch)
          unlock: null,     // 해금 조건 (별도 batch)
        },
      },
    };
  });
  return m;
})();
