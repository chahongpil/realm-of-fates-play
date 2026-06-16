'use strict';

// ─────────────────────────────────────────────────────────────
// Realm of Fates — Ability 텍스트 파서 (PHASE 6 Phase E-1, 2026-05-06)
// ─────────────────────────────────────────────────────────────
// 입력:  카드의 한국어 ability 산문 ("적 1체에게 2 피해")
// 출력:  { raw, effects:[{op, target, amount, ...}], parsed, warnings }
//
// 목적: 49 PHASE 6 bundle skill 의 데이터 effects 메타와 텍스트 일치 검증.
//      엔진 dispatch 가 effects 만 보면 되도록 — 텍스트는 사람용, 메타는 엔진용.
//
// 스펙: design/ability_dsl_spec_2026-05-06.md §3 (옵션 A)
// op 화이트리스트: damage / heal / shield / attach_buff / attach_debuff / attach_marker
//                 stun / burn / soul_gain / summon / self_destruct / tick_heal / aura
//                 modifier / next_card_discount / next_card_damage_buff
//                 _todo / _redesign  (미구현 마커)
//
// 한계: PHASE 3 잔재 (51 일반 유닛 / 30 옛 attach-hero / 18 영웅셀 / 12 유물) 텍스트는
//      자유 산문이라 매칭 거의 불가. parsed:false 로 fallback.
// ─────────────────────────────────────────────────────────────

(function(){

// ── 공백·전각 정규화 ──
function _norm(s){
  return String(s || '').replace(/\s+/g, ' ').trim();
}

// ── compound segment split — " + " (양쪽 공백 필수, +1 부호 보호) 또는 ", " (콤마+공백) ──
//   괄호 안은 보호 (depth 추적). +1, +2 같은 buff 부호는 split 대상 아님.
function _splitSegments(text){
  const out = [];
  let depth = 0, buf = '';
  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    if (ch === '(') depth++;
    else if (ch === ')') depth = Math.max(0, depth - 1);

    if (depth === 0) {
      // " + " 분리자 — 앞 공백 + '+' + 뒤 공백
      // 단, 다음 토큰이 "수호자" / "반사 N" 이면 shield 본체로 흡수 (split 안 함)
      if (ch === '+' && text[i-1] === ' ' && text[i+1] === ' ') {
        const after = text.slice(i + 2);
        if (/^(?:수호자|반사\s*\d+)/.test(after)) {
          buf += ch;  // '+' 그대로 보존
          continue;
        }
        const t = buf.replace(/\s+$/, '').trim();
        if (t) out.push(t);
        buf = '';
        i++; // 뒤 공백 스킵
        continue;
      }
      // ", " 분리자
      if (ch === ',' && (text[i+1] === ' ' || text[i+1] === undefined)) {
        const t = buf.trim();
        if (t) out.push(t);
        buf = '';
        if (text[i+1] === ' ') i++;
        continue;
      }
    }
    buf += ch;
  }
  const t = buf.trim();
  if (t) out.push(t);
  return out;
}

// ── 단일 segment 파싱 — 1+ Effect 또는 null ──
function _parseSegment(seg, ctx){
  seg = _norm(seg);
  let m;

  // ── self_destruct ── "자신 사망"
  if (/^자신\s*사망$/.test(seg)) return [{op:'self_destruct'}];

  // ── one_time_revive_50pct ── "자신 사망 시 1회 부활 (HP 50%, 이후 소멸)" (sk_sun_wukong_revive)
  if ((m = /^자신\s*사망\s*시\s*1회\s*부활\s*\(\s*HP\s*(\d+)%/.exec(seg))) {
    return [{op:'_todo', _todo:'one_time_revive_50pct', percent:Number(m[1])}];
  }

  // ── steal_random_hand_card ── "적 손패 1장 훔쳐 자신 손패에 추가 (사용 시 소멸)" (sk_rogue_steal)
  if (/^적\s*손패\s*1장\s*훔쳐/.test(seg)) {
    return [{op:'_todo', _todo:'steal_random_hand_card', _redesign:'enemy_hand_random'}];
  }

  // ── damage role_in ── "적 1체에게 N 피해 (지원/원거리 대상은 M 피해)" (sk_rogue_assassinate)
  if ((m = /^적\s*1체에?\s*게?\s*(\d+)\s*피해\s*\(\s*([가-힣\/]+)\s*(?:대상은)?\s*\d+\s*피해\s*\)$/.exec(seg))) {
    return [{op:'damage', target:'enemy_one', amount:Number(m[1]),
             condition:{type:'role_in', value:'support|ranged'},
             _todo:'role_double_dmg'}];
  }

  // ── stealth (은폐) ── "자신 N턴 은폐" — 2026-05-06 사용자 결정 B (회피 → stealth 키워드 시스템)
  if ((m = /^(?:자신\s*)?(\d+)턴\s*은폐$/.exec(seg))) {
    return [{op:'stealth', target:'self', turns:Number(m[1])}];
  }

  // ── _redesign 잔존 fallback (옛 "회피 N%" 표현) — 새 카드는 "은폐" 사용 ──
  if ((m = /^(?:자신\s*)?(\d+)턴\s*회피\s*(\d+)%/.exec(seg))) {
    return [{op:'_redesign', originalStat:'evasion', amount:Number(m[2]), turns:Number(m[1]),
             _note:'회피는 PHASE 6 폐기 — stealth 키워드 사용 권장'}];
  }

  // ── damage 다발 ── "적 1체에게 N 피해 (M발)"
  if ((m = /적\s*1체에?\s*게?\s*(\d+)\s*피해\s*\((\d+)발\)/.exec(seg))) {
    const total = Number(m[1]);
    const hits  = Number(m[2]);
    return [{op:'damage', target:'enemy_one', amount: Math.floor(total / hits), hits}];
  }

  // ── damage N체 (N>=2) ── "적 N체에게 각 M 피해"
  // count=1 은 enemy_one 패턴(아래) 에 양보. "각" 키워드 또는 N>=2 일 때만.
  if ((m = /적\s*(\d+)체에?\s*게?\s*각\s*(\d+)\s*피해/.exec(seg))) {
    const count = Number(m[1]);
    if (count >= 2) return [{op:'damage', target:'enemy_n', amount:Number(m[2]), count}];
  }

  // ── damage 전체 ── "적 전체에게 N 피해"
  if ((m = /적\s*전체에?\s*게?\s*(\d+)\s*피해/.exec(seg))) {
    return [{op:'damage', target:'enemy_all', amount:Number(m[1])}];
  }

  // ── damage 인접 ── "인접 적 N 피해" (compound 우측)
  if ((m = /^인접\s*적(?:에게)?\s*(\d+)\s*피해/.exec(seg))) {
    return [{op:'damage', target:'enemy_adjacent', amount:Number(m[1]), _todo:'adjacent_target_resolution'}];
  }

  // ── damage 계열 (lineage) ── "적 (창병|기병|...) 계열에게 (N배)? 피해 (M)?"
  if ((m = /적\s*([가-힣]+)\s*계열에?\s*게?\s*(?:(\d+)배\s*)?피해(?:\s*\((\d+)\))?/.exec(seg))) {
    const lineage = m[1];
    // 본체 amount: 괄호 안 명시값 우선, 없으면 ctx.cardATK 추정
    let amount = m[3] ? Number(m[3]) : (ctx && ctx.cardATK) || 4;
    return [{op:'damage', target:'enemy_one', amount, condition:{type:'id_contains', value:lineage === '창병' ? 'lancer' : lineage === '기병' ? 'cavalry' : lineage}, _todo:'lineage_2x_dmg'}];
  }

  // ── damage 단일 (관통/원거리/시그니처/사냥개 동행 등 괄호 부가어 무시) ──
  // "적 1체에게 N 피해" / "원거리 적 1체에게 N 피해" / "적 1체에게 N 피해 (불)"
  if ((m = /^(?:원거리\s*)?적\s*1체에?\s*게?\s*(\d+)\s*피해(?:\s*\([^)]*\))?(?:\s*\(방패\s*유닛\s*무시\))?$/.exec(seg))) {
    const e = {op:'damage', target:'enemy_one', amount:Number(m[1])};
    if (/\(방패\s*유닛\s*무시\)/.test(seg)) {
      e.pierce = 'shield';
      e._todo = 'shield_pierce';
    }
    return [e];
  }
  // "적 1체 N 피해" (조사 생략 변형, "+" 우측 segment 에서 자주 발생)
  if ((m = /^적\s*1체\s*(\d+)\s*피해(?:\s*\([^)]*\))?$/.exec(seg))) {
    const e = {op:'damage', target:'enemy_one', amount:Number(m[1])};
    if (/\(방패\s*유닛\s*무시\)/.test(seg)) {
      e.pierce = 'shield';
      e._todo = 'shield_pierce';
    }
    return [e];
  }

  // ── shield ── "자신에게 보호막 +N (M턴)" + "수호자" + "반사 K" 옵션
  if ((m = /^자신에?\s*게?\s*보호막\s*\+(\d+)(?:\s*\+\s*(수호자|반사\s*\d+))?(?:\s*\((\d+)턴\))?$/.exec(seg))) {
    const e = {op:'shield', target:'self', amount:Number(m[1]), turns:m[3] ? Number(m[3]) : 1};
    if (m[2]) {
      if (m[2] === '수호자') e.addKeyword = 'taunt';
      else {
        const r = /반사\s*(\d+)/.exec(m[2]);
        if (r) e.reflect = Number(r[1]);
      }
    }
    return [e];
  }
  // "수호자 (1턴)" / "반사 K (1턴)" — compound 우측 세그먼트로 떨어진 경우
  if (/^수호자(?:\s*\(\d+턴\))?$/.test(seg)) return null; // shield 본체에 흡수되어야 — 단독 등장 금지
  if (/^반사\s*\d+(?:\s*\(\d+턴\))?$/.test(seg)) return null;

  // ── heal ── "아군 (1체|전체) HP +N" / "자신 HP +N"
  if ((m = /^(아군|자신)\s*(전체|1체)?\s*HP\s*\+(\d+)$/.exec(seg))) {
    const who = m[1] === '자신' ? 'self' : (m[2] === '전체' ? 'ally_all' : 'ally_one');
    return [{op:'heal', target:who, amount:Number(m[3])}];
  }

  // ── tick_heal ── "아군 1체 매 턴 HP +N (지속)"
  if ((m = /^아군\s*1체\s*매\s*턴\s*HP\s*\+(\d+)\s*\(지속\)$/.exec(seg))) {
    return [{op:'tick_heal', target:'ally_one', amount:Number(m[1]), perTurn:true}];
  }

  // ── stun ── "적 1체 1턴 스턴" / "1턴 행동 불가" (자기 stun)
  if ((m = /^적\s*1체\s*(\d+)턴\s*스턴$/.exec(seg))) {
    return [{op:'stun', target:'enemy_one', turns:Number(m[1])}];
  }
  if ((m = /^(\d+)턴\s*행동\s*불가$/.exec(seg))) {
    return [{op:'stun', target:'self', turns:Number(m[1])}];
  }

  // ── burn ── "1턴 화상" (단독 또는 compound 우측)
  if ((m = /^(\d+)턴\s*화상$/.exec(seg))) {
    return [{op:'burn', target: ctx && ctx.lastDamageTarget || 'enemy_one', turns:Number(m[1]),
             _todo:'burn_per_turn_dmg_value'}];
  }

  // ── soul_gain ── "즉시 영혼 풀 +N"
  if ((m = /^즉시\s*영혼\s*풀\s*\+(\d+)$/.exec(seg))) {
    return [{op:'soul_gain', amount:Number(m[1])}];
  }

  // ── summon ── "X 1마리(를)? 보드에 소환 (HP A / ATK B [/ 수호자])"
  if ((m = /보드(?:에)?\s*소환\s*\(\s*HP\s*(\d+)\s*\/\s*ATK\s*(\d+)(?:\s*\/\s*(수호자))?\s*\)$/.exec(seg))) {
    const e = {op:'summon', stats:{HP:Number(m[1]), ATK:Number(m[2])}};
    if (m[3]) e.keywords = ['taunt'];
    return [e];
  }

  // ── summon (콤마 구분자 + 부가 텍스트) ── "분신 1마리 보드 소환 (HP 1, ATK 1, 한대 맞으면 소멸)" (sk_wukong_clone)
  if ((m = /보드(?:에)?\s*소환\s*\(\s*HP\s*(\d+)\s*,\s*ATK\s*(\d+)(?:\s*,\s*[^)]*)?\)/.exec(seg))) {
    return [{op:'summon', stats:{HP:Number(m[1]), ATK:Number(m[2])}}];
  }

  // ── summon (mirror_caster_atk) ── "분신 1마리 보드 소환 (HP 1, ATK 손오공과 동일)" (sk_sun_wukong_clone)
  if (/보드(?:에)?\s*소환\s*\(\s*HP\s*\d+\s*,\s*ATK\s*[가-힣]+과?\s*동일\s*\)/.test(seg)) {
    const m2 = /HP\s*(\d+)/.exec(seg);
    const hp = m2 ? Number(m2[1]) : 1;
    return [{op:'summon', stats:{HP:hp, ATK:6}, _todo:'mirror_caster_atk'}];
  }

  // ── target 없는 attach_buff fallback ── "ATK +N" / "HP +N" / "SOUL +N" (compound 우측에서 옴, sk_general_meditation 등)
  if ((m = /^(ATK|HP|SOUL)\s*\+(\d+)$/.exec(seg))) {
    return [{op:'attach_buff', target:'self', stat:m[1], amount:Number(m[2])}];
  }

  // ── attach_marker ── "적 1체에 부착: 1턴간 모든 공격 +N 추가 피해"
  if ((m = /^적\s*1체에?\s*부착[:,]?\s*(\d+)턴간?\s*모든\s*공격\s*\+(\d+)/.exec(seg))) {
    return [{op:'attach_marker', target:'enemy_one', amount:Number(m[2]), turns:Number(m[1]),
             _todo:'all_attacks_bonus_dmg'}];
  }

  // ── aura ── "모든 X ATK +N (지속)"
  if ((m = /^모든\s*([가-힣a-zA-Z_]+)\s*(ATK|HP|SOUL)\s*\+(\d+)\s*\(지속\)$/.exec(seg))) {
    const filterValue = m[1] === '궁수' ? 'archer' : m[1];
    return [{op:'aura', filter:{type:'id_contains', value:filterValue}, stat:m[2], amount:Number(m[3]),
             _todo:'persistent_aura'}];
  }

  // ── modifier ── "1턴간 모든 치료(/회복)? 효과? +N"
  if ((m = /^(\d+)턴간?\s*모든\s*치료(?:\/회복)?\s*효과?\s*\+(\d+)$/.exec(seg))) {
    return [{op:'modifier', stat:'heal', amount:Number(m[2]), turns:Number(m[1]),
             _todo:'global_heal_modifier'}];
  }
  // "1턴간 모든 치료 +N" 단독 (compound 좌측에서 ',' split 후)
  if ((m = /^(\d+)턴간?\s*모든\s*치료\s*\+(\d+)$/.exec(seg))) {
    return [{op:'modifier', stat:'heal', amount:Number(m[2]), turns:Number(m[1]),
             _todo:'global_heal_modifier'}];
  }

  // ── next_card_discount ── "다음 (카드의?|스펠) NEED_SOUL -N"
  if ((m = /^다음\s*(카드의?|스펠|불\s*스펠)?\s*NEED_SOUL\s*-(\d+)$/.exec(seg))) {
    const e = {op:'next_card_discount', amount:Number(m[2]), _todo:'next_card_modifier'};
    if (m[1] && /스펠/.test(m[1])) {
      e.filter = {type:'kind_prefix', value:'spell'};
      e._todo = 'filtered_next_card_modifier';
    }
    return [e];
  }

  // ── next_card_damage_buff ── "다음 (불|사격) (스펠)? 데미지 +N"
  if ((m = /^다음\s*(?:(불|사격)\s*)?(?:스펠\s*)?데미지\s*\+(\d+)$/.exec(seg))) {
    const e = {op:'next_card_damage_buff', amount:Number(m[2])};
    if (m[1] === '불') {
      e.filter = {type:'element_kind', element:'fire', kindPrefix:'spell'};
      e._todo  = 'element_filtered_dmg_buff';
    } else if (m[1] === '사격') {
      e.filter = {type:'id_contains', value:'shot|fire|arrow|crossbow'};
      e._todo  = 'shot_filter';
    } else {
      e._todo = 'next_card_damage_buff';
    }
    return [e];
  }

  // ── attach_buff (target 지정) ── "(아군|자신|적) (1체|전체)? (1턴간)? ATK +N / HP +N" 단일 항목
  // 다중 stat 분리는 caller(_splitSegments) 가 '/' 로 안 자르므로 한 segment 안에서 다중 매칭 처리.
  // 여기선 단일 매칭만 다룸 — 다중은 _parseBuffMultiStat 별도 호출.

  // "아군 1체 ATK +N" / "자신 ATK +N" / "자신 1턴간 ATK +N"
  if ((m = /^(아군|자신)\s*(전체|1체)?\s*(?:(\d+)턴간?\s*)?(ATK|HP|SOUL)\s*\+(\d+)$/.exec(seg))) {
    const target = m[1] === '자신' ? 'self' : (m[2] === '전체' ? 'ally_all' : 'ally_one');
    const e = {op:'attach_buff', target, stat:m[4], amount:Number(m[5])};
    if (m[3]) e.turns = Number(m[3]);
    return [e];
  }
  // "공격력 +N" — compound 우측에서 단독 (sk_herbalist_heal_atk_aura)
  if ((m = /^공격력\s*\+(\d+)$/.exec(seg))) {
    return [{op:'attach_buff', target:'hero', stat:'ATK', amount:Number(m[1]), turns: ctx && ctx.modifierTurns || 1}];
  }

  // ── attach_debuff ── "적 1체 ATK -N (M턴)"
  if ((m = /^적\s*1체\s*ATK\s*-(\d+)\s*\((\d+)턴\)$/.exec(seg))) {
    return [{op:'attach_debuff', target:'enemy_one', stat:'ATK', amount:-Number(m[1]), turns:Number(m[2])}];
  }

  // ── multi-stat segment (slash-separated) ──
  // "ATK +N / HP +M" 두 stat 한 segment 에 — split 안 됨 ('/' 는 split 토큰 아님).
  // caller 에서 별도 처리.

  // ── 1턴 화염 부여 ── _todo flame_imbue
  if ((m = /^(\d+)턴\s*화염\s*부여$/.exec(seg))) {
    /* diagnosis-confirmed: 2026-06-07 사유: refactor — dispatch(_dispatchEffect)는 effect._todo 키로 분기하는데 파서가 name 키로 출력해 불일치(파서 산출물 경로만 silent skip, 런타임은 데이터 직접 사용이라 무해). _todo 로 통일. */
    return [{op:'_todo', _todo:'flame_imbue', turns:Number(m[1])}];
  }

  // ── 미매칭 ──
  return null;
}

// ── multi-stat segment 처리 ── "(아군|자신) (1턴간)? ATK +N / HP +M"
function _parseMultiStat(seg, ctx){
  const m = /^(아군|자신)\s*(전체|1체)?\s*(?:(\d+)턴간?\s*)?(.+)$/.exec(seg);
  if (!m) return null;
  const target = m[1] === '자신' ? 'self' : (m[2] === '전체' ? 'ally_all' : 'ally_one');
  const turns  = m[3] ? Number(m[3]) : null;
  const tail   = m[4]; // "ATK +N / HP +M" 같은 부분

  const stats = [];
  const re = /(ATK|HP|SOUL)\s*\+(\d+)/g;
  let mm;
  while ((mm = re.exec(tail)) !== null) {
    stats.push({stat:mm[1], amount:Number(mm[2])});
  }
  if (stats.length < 2) return null; // multi 가 아니면 기본 단일 매칭으로

  return stats.map(s => {
    const e = {op:'attach_buff', target, stat:s.stat, amount:s.amount};
    if (turns) e.turns = turns;
    return e;
  });
}

// ── 메인 진입점 ──
function parse(text, opts){
  text = _norm(text);
  if (!text) return {raw:'', effects:[], parsed:false, warnings:['empty text']};

  const ctx = opts || {};
  const segments = _splitSegments(text);
  const effects = [];
  const warnings = [];

  for (const seg of segments) {
    // multi-stat 우선 시도 ("ATK +N / HP +M")
    let arr = _parseMultiStat(seg, ctx);
    if (!arr) arr = _parseSegment(seg, ctx);
    if (!arr) {
      warnings.push(`unparsed segment: "${seg}"`);
      continue;
    }
    for (const e of arr) effects.push(e);
    // 다음 segment 의 burn target 결정용 last damage 추적
    const lastDmg = arr.find(e => e.op === 'damage');
    if (lastDmg) ctx.lastDamageTarget = lastDmg.target;
  }

  return {
    raw: text,
    effects,
    parsed: effects.length > 0 && warnings.length === 0,
    warnings,
  };
}

// ── effects 비교 헬퍼 (회귀 골든용) ──
// 두 effects 배열이 의미상 동일한가? _todo / _redesign / _note / _flavor / _consistencyCheck 등
// 메타키는 무시하고 op + 핵심 필드만 비교.
function effectsEqual(a, b){
  if (!Array.isArray(a) || !Array.isArray(b)) return false;
  if (a.length !== b.length) return false;
  for (let i = 0; i < a.length; i++) {
    if (!_effectEqual(a[i], b[i])) return false;
  }
  return true;
}

function _effectEqual(a, b){
  if (!a || !b) return false;
  if (a.op !== b.op) return false;
  // 핵심 필드만 비교
  const keys = ['target','amount','turns','hits','count','stat','reflect','addKeyword','perTurn','originalStat','name'];
  for (const k of keys) {
    if ((k in a || k in b) && a[k] !== b[k]) return false;
  }
  // condition / filter / stats 는 deep
  if (!_deepEqual(a.condition, b.condition)) return false;
  if (!_deepEqual(a.filter, b.filter)) return false;
  if (!_deepEqual(a.stats, b.stats)) return false;
  if (!_deepEqual(a.keywords, b.keywords)) return false;
  return true;
}

function _deepEqual(a, b){
  if (a === b) return true;
  if (a == null || b == null) return a === b;
  if (typeof a !== typeof b) return false;
  if (Array.isArray(a)) {
    if (!Array.isArray(b) || a.length !== b.length) return false;
    return a.every((v, i) => _deepEqual(v, b[i]));
  }
  if (typeof a === 'object') {
    const ka = Object.keys(a).filter(k => !k.startsWith('_'));
    const kb = Object.keys(b).filter(k => !k.startsWith('_'));
    if (ka.length !== kb.length) return false;
    return ka.every(k => _deepEqual(a[k], b[k]));
  }
  return false;
}

window.RoF = window.RoF || {};
window.RoF.AbilityParser = { parse, effectsEqual };

})();
