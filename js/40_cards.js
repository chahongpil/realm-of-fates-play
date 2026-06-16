'use strict';

/* ============================================================
   Realm of Fates — Card V4 Frame Builder (2026-05-08)
   ============================================================
   교체: 2026-05-08 — 핸드오프 0508 frame 시스템 (M&M Fates 레퍼런스 차용)
   CSS:   css/32_card_v4.css (.card-v4 + .in-play / .shield modifier)
   자산:  img/handoff_0508/

   매핑:
     unit (보드 위)         → .card-v4.in-play (frame_2)
     unit + taunt (수호자)  → .card-v4.shield (frame_shield)
     unit (손패) / spell / attach → .card-v4 (frame_c_v2 default)

   PHASE 6 5필드:
     NEED_SOUL → 좌상단 코스트
     ATK       → 좌하단 검 아이콘
     HP        → 우하단 방패 아이콘
     SOUL      → (시각 표시 없음, 영웅만 사용)
     keywords  → 키워드 알약 (taunt/aura/battlecry/deathrattle 등)
     ability   → 설명 텍스트
     element   → 좌측 원소 아이콘
   ============================================================ */

RoF.dom = RoF.dom || {};

// ───── 토큰 ─────
const _ELEM_ICON = {
  fire:      'img/ui/icons/t_el_fire.png',
  water:     'img/ui/icons/t_el_water.png',
  earth:     'img/ui/icons/t_el_earth.png',
  lightning: 'img/ui/icons/t_el_lightning.png',
  holy:      'img/ui/icons/t_el_light.png',
  dark:      'img/ui/icons/t_el_dark.png',
};

// 종족 아이콘 (원소 아이콘 바로 아래 좌측 가장자리). race 필드 → 아이콘.
const _RACE_ICON = {
  human:     'img/ui/icons/t_race_human.png',
  beast:     'img/ui/icons/t_race_beast.png',
  spirit:    'img/ui/icons/t_race_spirit.png',
  avian:     'img/ui/icons/t_race_avian.png',
  undead:    'img/ui/icons/t_race_undead.png',
  dragon:    'img/ui/icons/t_race_dragon.png',
  celestial: 'img/ui/icons/t_race_celestial.png',
  titan:     'img/ui/icons/t_race_titan.png',
  demon:     'img/ui/icons/t_race_demon.png',
  abyssal:   'img/ui/icons/t_race_abyssal.png',
};

const _ROLE_ICON = {
  warrior:  'img/ui/icons/t_attack.png',
  attack:   'img/ui/icons/t_attack.png',
  ranger:   'img/ui/icons/t_ranged.png',
  ranged:   'img/ui/icons/t_ranged.png',
  // battle_v3 시안 정합 (2026-05-08): mage/support → t_mage_v2 (보라 책+지팡이, 시안 자산 동일).
  // 옛 t_mage.png 는 황금 지팡이 단독으로 시안과 다른 그림이었음. _v2 로 분리해 캐시 회피.
  support:  'img/ui/icons/t_mage_v2.png',
  defense:  'img/ui/icons/t_sword_shield.png',
  guardian: 'img/ui/icons/t_guardian.png',
  mage:     'img/ui/icons/t_mage_v2.png',
  giant:    'img/ui/icons/t_giant.png',
};

const _HP_ICON   = 'img/ui/icons/t_hp.png';
const _ATK_ICON_DEFAULT = 'img/ui/icons/t_attack.png';

// Spell DMG 아이콘 (frame_spell.jsx) — 정적 lookup (concat 금지: 08-garbage-lessons 2026-04-21 교훈)
const _DMG_ICON = {
  melee:  'img/ui/icons/t_dmg_melee.png',
  ranged: 'img/ui/icons/t_dmg_ranged.png',
  magic:  'img/ui/icons/t_dmg_magic.png',
};

// 2026-06-16 — 유닛 공격 아이콘을 dmgType 기준으로 (기존 유닛 아이콘 에셋 재사용). defense+근접만 검+방패 유지(탱커 정체성).
//   목적: role 기반이라 견습마법사(support·melee)가 책+지팡이 아이콘이라 "근접반격 받는데 마법사처럼 보임" 혼란 제거.
//   갤러리 mockup/attack_icon 컨펌. dmgType 데이터는 안 건드림(밸런스 0), 표시만.
const _DMGTYPE_TO_ICON = {
  melee:  'img/ui/icons/t_attack.png',
  ranged: 'img/ui/icons/t_ranged.png',
  magic:  'img/ui/icons/t_mage_v2.png',
};

// Spell owner 자동 매핑 — bundledSkillIds 역매핑 캐시 (skillId → 부모 unit name).
// 같은 skill 이 여러 unit 의 bundle 에 있을 경우 첫 번째만. 사용자가 unit.owner 직접 지정하면 그게 우선.
let _spellOwnerCache = null;
function _ensureSpellOwnerMap(){
  if (_spellOwnerCache) return _spellOwnerCache;
  _spellOwnerCache = {};
  const units = (typeof window !== 'undefined' && window.RoF && RoF.Data && RoF.Data.UNITS) || [];
  units.forEach(u => {
    if (Array.isArray(u.bundledSkillIds)) {
      u.bundledSkillIds.forEach(skId => {
        if (!_spellOwnerCache[skId]) _spellOwnerCache[skId] = u.name;
      });
    }
  });
  return _spellOwnerCache;
}

const STATUS_GLYPHS = {
  burn:       '🔥',
  poison:     '☠️',
  frozen:     '❄️',
  invincible: '🛡️'
};

// ───── 헬퍼 ─────
function _stripTokens(desc){
  return String(desc || '').trim();
}

function _getCardImg(unit){
  if(typeof getCardImg === 'function') return getCardImg(unit);
  if(typeof CARD_IMG !== 'undefined' && CARD_IMG) return CARD_IMG[unit.id] || null;
  return null;
}

// #28 임시 버프 배지 — 출처 카드 id → 이름 매핑 (SKILLS + UNITS 캐시)
let _cardNameCache = null;
function _cardNameById(id){
  if(!id) return '';
  if(!_cardNameCache){
    _cardNameCache = {};
    const D = (typeof window !== 'undefined' && window.RoF && RoF.Data) || {};
    [].concat(D.SKILLS || [], D.UNITS || []).forEach(c => {
      if(c && c.id && !_cardNameCache[c.id]) _cardNameCache[c.id] = c.name;
    });
  }
  return _cardNameCache[id] || '';
}

// #28 임시 스탯 버프 배지 빌더 (in-play 보드 카드) — 🔥 + 호 게이지(남은/총 라운드) + "NR" + 호버 툴팁.
// design-confirmed: 2026-06-06 사용자 갤러리 컨펌 (mockup/temp_buff_icon v4 — ATK 아이콘 바로 위 좌측정렬).
function _buildTempBuffBadge(buffs, statKind){
  const svgNS = 'http://www.w3.org/2000/svg';
  const maxRounds = buffs.reduce((m, b) => Math.max(m, b.roundsLeft || 0), 0);
  const maxTotal  = buffs.reduce((m, b) => Math.max(m, b.turnsTotal || b.roundsLeft || 1), 1);
  const ratio = Math.max(0, Math.min(1, maxRounds / maxTotal));
  const C = 2 * Math.PI * 20;

  const badge = document.createElement('div');
  badge.className = 'tbuff-badge tbuff-' + statKind;

  const svg = document.createElementNS(svgNS, 'svg');
  svg.setAttribute('class', 'tbuff-arc');
  svg.setAttribute('viewBox', '0 0 46 46');
  const bg = document.createElementNS(svgNS, 'circle');
  bg.setAttribute('cx', '23'); bg.setAttribute('cy', '23'); bg.setAttribute('r', '20');
  bg.setAttribute('class', 'tbuff-arc-bg');
  svg.appendChild(bg);
  const fg = document.createElementNS(svgNS, 'circle');
  fg.setAttribute('cx', '23'); fg.setAttribute('cy', '23'); fg.setAttribute('r', '20');
  fg.setAttribute('class', 'tbuff-arc-fg');
  fg.setAttribute('stroke-dasharray', C.toFixed(1));
  fg.setAttribute('stroke-dashoffset', (C * (1 - ratio)).toFixed(1));
  svg.appendChild(fg);
  badge.appendChild(svg);

  const core = document.createElement('div');
  core.className = 'tbuff-core';
  core.textContent = '🔥';
  badge.appendChild(core);

  const rlabel = document.createElement('div');
  rlabel.className = 'tbuff-rlabel';
  rlabel.textContent = maxRounds + 'R';
  badge.appendChild(rlabel);

  const tip = document.createElement('div');
  tip.className = 'tbuff-tip';
  const statLabel = statKind === 'atk' ? '공격력' : (statKind === 'hp' ? '체력' : '능력치');
  let html = '';
  buffs.forEach(b => {
    const nm = _cardNameById(b.by) || '임시 버프';
    const sign = (b.amount >= 0) ? '+' : '';
    html += '<div class="tbuff-tip-row">'
      + '<div class="tbuff-tip-title">🔥 ' + _escapeHtml(nm) + '</div>'
      + '<div class="tbuff-tip-eff">' + statLabel + ' <b>' + sign + b.amount + '</b></div>'
      + '<div class="tbuff-tip-dur">이번 라운드 종료 시 만료 · <b>' + (b.roundsLeft || 0) + 'R 남음</b></div>'
      + '</div>';
  });
  tip.innerHTML = html;
  badge.appendChild(tip);

  return badge;
}

// ───── 메인 빌더 ─────
function _buildCardEl(unit, opts){
  opts = opts || {};
  const rarity = unit.rarity || 'bronze';
  const element = unit.element || 'dark';
  const kind = unit.kind || opts.kind || 'unit';
  const keywords = unit.keywords || [];

  // frame mode 결정
  // 호출자가 frameMode 명시 (mkMatchCard 가 보드 taunt 시 'shield' 명시)
  // 명시 없음 (default 'hand') + taunt unit → 자동 shield (덱뷰/주점/성당/편성/채팅 호환)
  const frameMode = opts.frameMode || 'hand';  // 'hand' | 'in-play' | 'shield'
  const isInPlay = frameMode === 'in-play';
  // 사용자 결정 2026-05-10 — 모든 스킬카드(spell-* + attach-*) 는 스펠 프레임으로 통일.
  const isSpell = (kind === 'spell-target' || kind === 'spell-aoe' || kind === 'attach-hero' || kind === 'attach-unit');
  const isShield = !isSpell && (frameMode === 'shield' || (kind === 'unit' && keywords.includes('taunt') && opts.frameMode == null));
  // 사용자 결정 2026-05-13 — 영웅 보드 카드는 W-crown 옥타곤 + 플뢰론 + 보석 (frame_hero_board.jsx 정합).
  // mkMatchCard 가 영웅 카드 렌더 시 opts.isHero:true 전달. _renderHero 에서 호출.
  const isHeroBoard = isInPlay && opts.isHero === true;

  const W = 240;
  const H = isInPlay ? 240 : (isShield ? 280 : 336);

  const el = document.createElement('div');
  el.className = `card-v4 rar-${rarity}`;
  if (isInPlay) el.classList.add('in-play');
  else if (isShield) el.classList.add('shield');
  else if (isSpell) el.classList.add('spell');
  if (isHeroBoard) el.classList.add('is-hero');
  // 2026-05-17 #5 — kind 시각 분기용 클래스 부여 (사용자 컨펌 갤러리 v1)
  // kind: unit / spell-target / spell-aoe / attach-hero / attach-unit
  el.classList.add('kind-' + kind);
  el.setAttribute('data-uid', unit.uid || unit.id || '');
  el.setAttribute('data-id', unit.id || '');
  el.setAttribute('data-element', element);
  if (unit.role) el.setAttribute('data-role', unit.role);
  el.setAttribute('data-kind', kind);

  // ───── 1) Art Clip + Stone Bevel SVG ─────
  // shield/spell: SVG 안에 image clipPath 로 일러스트 가둠 (시안 frame_shield/frame_spell.jsx 정합)
  // hand/in-play: div.art-clip + img.art + .stone-bevel SVG 분리 (기존 폴리곤 8각형 OK)
  const svgNS = 'http://www.w3.org/2000/svg';
  // 2026-05-31 — 영웅 보드 카드(is-hero)는 클래스별 board.png 전용 일러스트 우선. 없으면 기존 card.png 폴백.
  let imgSrc = _getCardImg(unit);
  if (isHeroBoard && typeof getHeroBoardImg === 'function') {
    const boardImg = getHeroBoardImg(unit);
    if (boardImg) imgSrc = boardImg;
  }

  if (!isShield) {
    // hand / in-play / spell: div.art-clip 사용 (CSS clip-path 폴리곤)
    const artClip = document.createElement('div');
    artClip.className = 'art-clip';
    const artImg = document.createElement('img');
    artImg.className = 'art';
    artImg.alt = '';
    if (imgSrc) {
      artImg.src = imgSrc;
      artImg.onerror = function(){ this.style.display = 'none'; el.classList.add('cv-art-fallback'); };
    } else {
      artImg.style.display = 'none';
      el.classList.add('cv-art-fallback');
      el.setAttribute('data-fallback-icon', unit.icon || '⚔️');
    }
    artClip.appendChild(artImg);
    el.appendChild(artClip);
  } else if (!imgSrc) {
    // shield 인데 이미지 없음 → fallback 아이콘 마커
    el.classList.add('cv-art-fallback');
    el.setAttribute('data-fallback-icon', unit.icon || '🛡️');
  }

  // ───── 2) Stone Bevel SVG ─────
  const svg = document.createElementNS(svgNS, 'svg');
  svg.classList.add('stone-bevel');
  svg.setAttribute('viewBox', `0 0 ${W} ${H}`);
  svg.setAttribute('preserveAspectRatio', 'none');

  if (isSpell) {
    // 다이아몬드 컷 — frame_spell.jsx 시안 (3-layer stroke + 측면 원 + inner accent + top gem)
    const dPath = `M ${W/2} 0 L ${W-18} 18 L ${W} 60 L ${W} ${H-60} L ${W-18} ${H-18} L ${W/2} ${H} L 18 ${H-18} L 0 ${H-60} L 0 60 L 18 18 Z`;
    // 3-layer stroke (검정 5px / c1 2.6px / c2 1.2px)
    const strokeDark = document.createElementNS(svgNS, 'path');
    strokeDark.classList.add('spell-stroke-dark');
    strokeDark.setAttribute('d', dPath);
    svg.appendChild(strokeDark);

    const strokeC1 = document.createElementNS(svgNS, 'path');
    strokeC1.classList.add('spell-stroke-c1');
    strokeC1.setAttribute('d', dPath);
    svg.appendChild(strokeC1);

    const strokeC2 = document.createElementNS(svgNS, 'path');
    strokeC2.classList.add('spell-stroke-c2');
    strokeC2.setAttribute('d', dPath);
    svg.appendChild(strokeC2);

    // Inner accent (scale 0.93)
    const innerAccent = document.createElementNS(svgNS, 'path');
    innerAccent.classList.add('spell-inner-accent');
    innerAccent.setAttribute('d', dPath);
    innerAccent.setAttribute('transform', `translate(${W/2} ${H/2}) scale(0.93) translate(-${W/2} -${H/2})`);
    svg.appendChild(innerAccent);

    // Top center gem
    const gem = document.createElementNS(svgNS, 'path');
    gem.classList.add('spell-gem');
    gem.setAttribute('d', `M ${W/2} 6 L ${W/2+7} 14 L ${W/2} 22 L ${W/2-7} 14 Z`);
    svg.appendChild(gem);

    // 측면 원 데코 (좌우 r=3)
    const sideL = document.createElementNS(svgNS, 'circle');
    sideL.classList.add('spell-side-gem');
    sideL.setAttribute('cx', '6');
    sideL.setAttribute('cy', String(H/2));
    sideL.setAttribute('r', '3');
    svg.appendChild(sideL);

    const sideR = document.createElementNS(svgNS, 'circle');
    sideR.classList.add('spell-side-gem');
    sideR.setAttribute('cx', String(W-6));
    sideR.setAttribute('cy', String(H/2));
    sideR.setAttribute('r', '3');
    svg.appendChild(sideR);
  } else if (!isShield) {
    // 2026-05-30 — HERO 새 v2 시안 (frame_board_premium.html / shield_hero.html 정합)
    // 위로 -48 튀어나오는 큰 crown SVG path. viewBox 도 -48 확장 + stone-bevel overflow visible.
    const outerPath = isHeroBoard
      ? `M 0 14 L 0 0 Q 28 -6 42 -34 Q 56 -6 82 -4 Q 102 -10 120 -46 Q 138 -10 158 -4 Q 184 -6 198 -34 Q 212 -6 240 0 L 240 226 Q 240 240 226 240 L 14 240 Q 0 240 0 226 Z`
      : `M 12 0 L ${W-12} 0 L ${W} 12 L ${W} ${H-12} L ${W-12} ${H} L 12 ${H} L 0 ${H-12} L 0 12 Z`;
    const innerPath = isHeroBoard
      ? `M 4 18 L 4 4 Q 30 -2 44 -30 Q 58 -2 80 0 Q 100 -6 120 -40 Q 140 -6 160 0 Q 182 -2 196 -30 Q 210 -2 236 4 L 236 222 Q 236 236 222 236 L 18 236 Q 4 236 4 222 Z`
      : `M 16 4 L ${W-16} 4 L ${W-4} 16 L ${W-4} ${H-16} L ${W-16} ${H-4} L 16 ${H-4} L 4 ${H-16} L 4 16 Z`;
    if (isHeroBoard) {
      // HERO 큰 crown 위로 튀어나옴 → svg viewBox 확장 (0 -48 240 288)
      svg.setAttribute('viewBox', `0 -48 ${W} ${H + 48}`);
    }

    const outer = document.createElementNS(svgNS, 'path');
    outer.classList.add('outer');
    outer.setAttribute('d', outerPath);
    svg.appendChild(outer);

    const inner = document.createElementNS(svgNS, 'path');
    inner.classList.add('inner');
    inner.setAttribute('d', innerPath);
    svg.appendChild(inner);

    if (isHeroBoard) {
      // 2026-05-30 — 새 v2 시안 (mockup/board_frame_upgrade/shield_hero.html) outward gold ring × 3
      // outerPath 폴리곤 그대로 scale 1.022 / 1.045 / 1.07 outward ring (등급 색 c89030 골드)
      const ringConfigs = [
        {scale: 1.07,  color: '#1a1108', width: 3},
        {scale: 1.045, color: '#7a5814', width: 3.4},
        {scale: 1.022, color: '#c89030', width: 2.8},
      ];
      ringConfigs.forEach(r => {
        const ring = document.createElementNS(svgNS, 'path');
        ring.setAttribute('d', outerPath);
        ring.setAttribute('fill', 'none');
        ring.setAttribute('stroke', r.color);
        ring.setAttribute('stroke-width', String(r.width));
        ring.setAttribute('stroke-linejoin', 'round');
        ring.setAttribute('transform', `translate(${W/2} ${H/2}) scale(${r.scale}) translate(-${W/2} -${H/2})`);
        // 2026-05-30 hotfix — appendChild (svg 끝, 위에 그려짐) 으로 변경.
        // insertBefore(svg.firstChild) 는 뒤에 그려져 outer/inner path 에 가려짐.
        svg.appendChild(ring);
      });
      // W-crown 보석 — 좌/우 작은 다이아 (90/12, 150/12)
      const gemL = document.createElementNS(svgNS, 'path');
      gemL.classList.add('gem');
      gemL.setAttribute('d', `M 90 12 L 94 8 L 90 4 L 86 8 Z`);
      svg.appendChild(gemL);
      const gemR = document.createElementNS(svgNS, 'path');
      gemR.classList.add('gem');
      gemR.setAttribute('d', `M 150 12 L 154 8 L 150 4 L 146 8 Z`);
      svg.appendChild(gemR);
      // 중앙 빨간 보석 (cy=-2, 카드 위로 살짝 튀어나옴)
      const gemC = document.createElementNS(svgNS, 'circle');
      gemC.classList.add('crown-jewel');
      gemC.setAttribute('cx', String(W/2));
      gemC.setAttribute('cy', '-2');
      gemC.setAttribute('r', '3');
      svg.appendChild(gemC);
      // 하단 중앙 다이아 (W/2, H-7)
      const gemBottom = document.createElementNS(svgNS, 'path');
      gemBottom.classList.add('gem');
      gemBottom.setAttribute('d', `M ${W/2} ${H-12} L ${W/2+5} ${H-7} L ${W/2} ${H-2} L ${W/2-5} ${H-7} Z`);
      svg.appendChild(gemBottom);
      // 플뢰론 6개 (좌/우 변 × 상/중/하 위치)
      const fleurPositions = [
        {x:6,    y:12,    rot:90},
        {x:W-6,  y:12,    rot:270},
        {x:6,    y:H-12,  rot:90},
        {x:W-6,  y:H-12,  rot:270},
        {x:12,   y:H-6,   rot:0},
        {x:W-12, y:H-6,   rot:180},
      ];
      fleurPositions.forEach(p => {
        const g = document.createElementNS(svgNS, 'g');
        g.classList.add('fleuron');
        g.setAttribute('transform', `translate(${p.x} ${p.y}) rotate(${p.rot})`);
        const tip = document.createElementNS(svgNS, 'path');
        tip.setAttribute('d', 'M 0 -3.5 L 2.6 0 L 0 3.5 L -2.6 0 Z');
        g.appendChild(tip);
        const curve = document.createElementNS(svgNS, 'path');
        curve.setAttribute('d', 'M 0 0 Q 6 -2.5 9 0 Q 6 2.5 0 0');
        curve.setAttribute('opacity', '.75');
        g.appendChild(curve);
        const dot = document.createElementNS(svgNS, 'circle');
        dot.setAttribute('cx', '9.6');
        dot.setAttribute('cy', '0');
        dot.setAttribute('r', '1.1');
        g.appendChild(dot);
        svg.appendChild(g);
      });
    } else {
      const gem = document.createElementNS(svgNS, 'path');
      gem.classList.add('gem');
      gem.setAttribute('d', `M ${W/2} 2 L ${W/2+5} 7 L ${W/2} 12 L ${W/2-5} 7 Z`);
      svg.appendChild(gem);
    }
  } else {
    // ───── Shield (frame_shield.jsx) — 시안 100% 정합 SVG inline ─────
    // viewBox 0 0 240 280, heater shield silhouette (8 Q-curve), clipPath 로 일러스트 가둠
    const shieldPath = 'M 12 8 L 228 8 Q 232 8 232 14 L 232 60 Q 232 78 228 96 ' +
                       'Q 220 140 200 188 Q 175 240 130 270 Q 122 274 118 274 Q 114 274 106 270 ' +
                       'Q 65 240 40 188 Q 20 140 12 96 Q 8 78 8 60 L 8 14 Q 8 8 12 8 Z';
    const uid = unit.uid || unit.id || ('s' + Math.random().toString(36).slice(2,6));
    const clipId = 'sh-clip-' + uid;
    const bgGradId = 'sh-bg-' + uid;
    const vigGradId = 'sh-vig-' + uid;

    // <defs>
    const defs = document.createElementNS(svgNS, 'defs');

    const clipPath = document.createElementNS(svgNS, 'clipPath');
    clipPath.setAttribute('id', clipId);
    const clipShape = document.createElementNS(svgNS, 'path');
    clipShape.setAttribute('d', shieldPath);
    clipPath.appendChild(clipShape);
    defs.appendChild(clipPath);

    const bgGrad = document.createElementNS(svgNS, 'linearGradient');
    bgGrad.setAttribute('id', bgGradId);
    bgGrad.setAttribute('x1', '0'); bgGrad.setAttribute('y1', '0');
    bgGrad.setAttribute('x2', '0'); bgGrad.setAttribute('y2', '1');
    const bgStop1 = document.createElementNS(svgNS, 'stop');
    bgStop1.setAttribute('offset', '0');
    bgStop1.setAttribute('stop-color', 'var(--c3)');
    bgGrad.appendChild(bgStop1);
    const bgStop2 = document.createElementNS(svgNS, 'stop');
    bgStop2.setAttribute('offset', '1');
    bgStop2.setAttribute('stop-color', '#000');
    bgGrad.appendChild(bgStop2);
    defs.appendChild(bgGrad);

    const vigGrad = document.createElementNS(svgNS, 'radialGradient');
    vigGrad.setAttribute('id', vigGradId);
    vigGrad.setAttribute('cx', '.5'); vigGrad.setAttribute('cy', '.35'); vigGrad.setAttribute('r', '.75');
    const vigStop1 = document.createElementNS(svgNS, 'stop');
    vigStop1.setAttribute('offset', '0');
    vigStop1.setAttribute('stop-color', 'rgba(0,0,0,0)');
    vigGrad.appendChild(vigStop1);
    const vigStop2 = document.createElementNS(svgNS, 'stop');
    vigStop2.setAttribute('offset', '1');
    vigStop2.setAttribute('stop-color', 'var(--c3)');
    vigStop2.setAttribute('stop-opacity', '.95');
    vigGrad.appendChild(vigStop2);
    defs.appendChild(vigGrad);
    svg.appendChild(defs);

    // 1. 배경 fill
    const bgFill = document.createElementNS(svgNS, 'path');
    bgFill.setAttribute('d', shieldPath);
    bgFill.setAttribute('fill', `url(#${bgGradId})`);
    svg.appendChild(bgFill);

    // 2. 일러스트 (clipPath 적용 → 방패 모양 안에 갇힘)
    const artGroup = document.createElementNS(svgNS, 'g');
    artGroup.setAttribute('clip-path', `url(#${clipId})`);
    if (imgSrc) {
      const artImage = document.createElementNS(svgNS, 'image');
      artImage.setAttribute('href', imgSrc);
      artImage.setAttribute('x', '0'); artImage.setAttribute('y', '0');
      artImage.setAttribute('width', String(W));
      artImage.setAttribute('height', '336');  // 일러스트 원본 비율
      artImage.setAttribute('preserveAspectRatio', 'xMidYMin slice');
      artGroup.appendChild(artImage);
    }
    // vignette
    const vigRect = document.createElementNS(svgNS, 'rect');
    vigRect.setAttribute('x', '0'); vigRect.setAttribute('y', '0');
    vigRect.setAttribute('width', String(W)); vigRect.setAttribute('height', String(H));
    vigRect.setAttribute('fill', `url(#${vigGradId})`);
    artGroup.appendChild(vigRect);
    // 하단 어두움 (스탯 가독성)
    const darkRect = document.createElementNS(svgNS, 'rect');
    darkRect.setAttribute('x', '0'); darkRect.setAttribute('y', String(H - 90));
    darkRect.setAttribute('width', String(W)); darkRect.setAttribute('height', '90');
    darkRect.setAttribute('fill', 'var(--c3)'); darkRect.setAttribute('opacity', '.55');
    artGroup.appendChild(darkRect);
    svg.appendChild(artGroup);

    // 2026-05-30 — 새 v2 시안 (mockup/board_frame_upgrade/shield_hero.html) outward stacked stroke (등급별)
    // rarity 별 4~6 ring (scale 1.025 ~ 1.075 누적, 안→밖)
    const rarity = unit.rarity || 'bronze';
    const rings = (rarity === 'bronze') ? [
      {scale:1.05,  color:'#1a1108', width:2.6},
      {scale:1.025, color:'#6a7078', width:2.2},
    ] : (rarity === 'silver') ? [
      {scale:1.075, color:'#1a1108', width:3},
      {scale:1.05,  color:'#0c0f14', width:2.8},
      {scale:1.025, color:'#5a9bdc', width:2.4},
    ] : (rarity === 'gold') ? [
      {scale:1.09,  color:'#1a1108', width:3.2},
      {scale:1.07,  color:'#0a0610', width:2.8},
      {scale:1.045, color:'#5a2d8a', width:2.6},
      {scale:1.022, color:'#b06ad6', width:2.4},
    ] : (rarity === 'legendary') ? [
      {scale:1.1,   color:'#0c0a04', width:3.4},
      {scale:1.075, color:'#3a2808', width:3},
      {scale:1.05,  color:'#7a5814', width:2.8},
      {scale:1.025, color:'#c89030', width:2.6},
      {scale:1.005, color:'#f3d676', width:2.2},
    ] : [
      {scale:1.115, color:'#0c0a04', width:3.6},
      {scale:1.09,  color:'#3a2808', width:3.2},
      {scale:1.065, color:'#8a6a1a', width:3},
      {scale:1.04,  color:'#d4a84a', width:2.8},
      {scale:1.02,  color:'#f3d676', width:2.6},
      {scale:1.005, color:'#fff4c8', width:2.2},
    ];
    rings.forEach(r => {
      const ring = document.createElementNS(svgNS, 'path');
      ring.setAttribute('d', shieldPath);
      ring.setAttribute('fill', 'none');
      ring.setAttribute('stroke', r.color);
      ring.setAttribute('stroke-width', String(r.width));
      ring.setAttribute('stroke-linejoin', 'round');
      ring.setAttribute('transform', `translate(120 140) scale(${r.scale}) translate(-120 -140)`);
      svg.appendChild(ring);
    });

    // 3. 4겹 stroke (#1a1108 6px / c1 3.2 / c2 1.6 / inner accent .35 scale 0.93)
    const strokeDark = document.createElementNS(svgNS, 'path');
    strokeDark.setAttribute('d', shieldPath);
    strokeDark.setAttribute('fill', 'none');
    strokeDark.setAttribute('stroke', '#1a1108');
    strokeDark.setAttribute('stroke-width', '6');
    strokeDark.setAttribute('stroke-linejoin', 'round');
    svg.appendChild(strokeDark);

    const strokeC1 = document.createElementNS(svgNS, 'path');
    strokeC1.setAttribute('d', shieldPath);
    strokeC1.setAttribute('fill', 'none');
    strokeC1.setAttribute('stroke', 'var(--c1)');
    strokeC1.setAttribute('stroke-width', '3.2');
    strokeC1.setAttribute('stroke-linejoin', 'round');
    svg.appendChild(strokeC1);

    const strokeC2 = document.createElementNS(svgNS, 'path');
    strokeC2.setAttribute('d', shieldPath);
    strokeC2.setAttribute('fill', 'none');
    strokeC2.setAttribute('stroke', 'var(--c2)');
    strokeC2.setAttribute('stroke-width', '1.6');
    strokeC2.setAttribute('stroke-linejoin', 'round');
    svg.appendChild(strokeC2);

    const innerAccent = document.createElementNS(svgNS, 'path');
    innerAccent.setAttribute('d', shieldPath);
    innerAccent.setAttribute('fill', 'none');
    innerAccent.setAttribute('stroke', 'var(--c2)');
    innerAccent.setAttribute('stroke-opacity', '.35');
    innerAccent.setAttribute('stroke-width', '.8');
    innerAccent.setAttribute('transform', 'translate(120 140) scale(0.93) translate(-120 -140)');
    innerAccent.setAttribute('stroke-linejoin', 'round');
    svg.appendChild(innerAccent);

    // 4. Top center boss (방패 머리 못)
    const bossOuter = document.createElementNS(svgNS, 'circle');
    bossOuter.setAttribute('cx', String(W/2)); bossOuter.setAttribute('cy', '14');
    bossOuter.setAttribute('r', '5');
    bossOuter.setAttribute('fill', 'var(--c2)');
    bossOuter.setAttribute('stroke', 'var(--c1)'); bossOuter.setAttribute('stroke-width', '1');
    svg.appendChild(bossOuter);
    const bossInner = document.createElementNS(svgNS, 'circle');
    bossInner.setAttribute('cx', String(W/2)); bossInner.setAttribute('cy', '14');
    bossInner.setAttribute('r', '2');
    bossInner.setAttribute('fill', 'var(--c3)');
    svg.appendChild(bossInner);

    // 5. Corner rivets (좌우 어깨)
    const rivetL = document.createElementNS(svgNS, 'circle');
    rivetL.setAttribute('cx', '20'); rivetL.setAttribute('cy', '20');
    rivetL.setAttribute('r', '3.5');
    rivetL.setAttribute('fill', 'var(--c2)');
    rivetL.setAttribute('stroke', 'var(--c1)'); rivetL.setAttribute('stroke-width', '.8');
    svg.appendChild(rivetL);
    const rivetR = document.createElementNS(svgNS, 'circle');
    rivetR.setAttribute('cx', String(W - 20)); rivetR.setAttribute('cy', '20');
    rivetR.setAttribute('r', '3.5');
    rivetR.setAttribute('fill', 'var(--c2)');
    rivetR.setAttribute('stroke', 'var(--c1)'); rivetR.setAttribute('stroke-width', '.8');
    svg.appendChild(rivetR);

    // 6. Cross-line (heraldic 중앙 세로선)
    const crossLine = document.createElementNS(svgNS, 'line');
    crossLine.setAttribute('x1', String(W/2)); crossLine.setAttribute('y1', '40');
    crossLine.setAttribute('x2', String(W/2)); crossLine.setAttribute('y2', String(H - 60));
    crossLine.setAttribute('stroke', 'var(--c2)');
    crossLine.setAttribute('stroke-opacity', '.18');
    crossLine.setAttribute('stroke-width', '1.2');
    svg.appendChild(crossLine);
  }
  el.appendChild(svg);

  // ───── 3) Cost / Level 코인 (좌상단) ─────
  // battle_v3 시안 정합 (battle_v3_card.jsx UnitCard line 79-85): compact?level:cost
  //   - 손패 (default mode) → NEED_SOUL (cost)
  //   - 보드 (in-play / compact) → 매치 progression Lv (또는 unit.level fallback 1)
  // 옛 동작 (보드 = 역할 아이콘) 폐기 (2026-05-08).
  if (isInPlay) {
    const coin = document.createElement('div');
    coin.className = 'cost';
    // 2026-05-17 B6 fix — 영웅 (matchLevel) + unit (_matchLevel) 둘 다 검사.
    // 사용자 보고 "아군/적군 영웅 레벨업 숫자 안 바뀜". 영웅은 inst.matchLevel (underscore 없음, line 121).
    const lv = unit._matchLevel != null ? unit._matchLevel
            : (unit.matchLevel != null ? unit.matchLevel
            : (unit.level != null ? unit.level : 1));
    coin.textContent = lv;
    // Lv 2+ 시 숫자 노랑 (ATK/HP buff 와 동일 영구 색 변화 패턴, 사용자 정정)
    if (lv > 1) coin.classList.add('is-leveled-up');
    el.appendChild(coin);
  } else {
    const cost = document.createElement('div');
    cost.className = 'cost';
    // design-confirmed: 2026-06-07 사유: 사용자 명시 — 영웅은 출진 cost 불필요 → 좌상단 슬롯에 SOUL 표시 (NEED_SOUL 대체)
    const _isHeroC = (kind === 'hero' || unit._isHero === true || unit.isHero === true);
    if (_isHeroC) {
      cost.classList.add('is-soul');
      cost.textContent = unit.SOUL != null ? unit.SOUL : 0;
    } else {
      cost.textContent = unit.NEED_SOUL != null ? unit.NEED_SOUL : (unit.cost != null ? unit.cost : 0);
    }
    el.appendChild(cost);
  }

  // ───── 4) Element Icon ─────
  if (element && _ELEM_ICON[element]) {
    const elem = document.createElement('div');
    elem.className = 'elem';
    const elemImg = document.createElement('img');
    elemImg.src = _ELEM_ICON[element];
    elemImg.alt = '';
    elemImg.onerror = function(){ elem.style.display = 'none'; };
    elem.appendChild(elemImg);
    el.appendChild(elem);
  }

  // 종족 아이콘 (원소 아이콘 바로 아래, 좌측 가장자리 세로 컬럼)
  // 매치 밖 / 손패 full 카드만. 보드 카드(in-play / 보드 도발 shield)는 레이아웃이 빡빡해 제외. (사용자 결정 2026-06-06)
  // race 는 유닛 고유 속성 → id 로 도출. owned 카드(race 시스템 2026-05-30 도입 전 영입)는 race 필드가 없어 UNITS 에서 보강.
  let race = unit.race;
  if (!race && unit.id && RoF.Data && Array.isArray(RoF.Data.UNITS)) {
    const _baseUnit = RoF.Data.UNITS.find(u => u && u.id === unit.id);
    if (_baseUnit) race = _baseUnit.race;
  }
  const _isBoardCard = isInPlay || opts.frameMode === 'shield';
  if (race && _RACE_ICON[race] && !_isBoardCard) {
    const raceEl = document.createElement('div');
    raceEl.className = 'race';
    const raceImg = document.createElement('img');
    raceImg.src = _RACE_ICON[race];
    raceImg.alt = '';
    raceImg.onerror = function(){ raceEl.style.display = 'none'; };
    raceEl.appendChild(raceImg);
    el.appendChild(raceEl);
  }

  // 매치 손패 카드: 우상단 보드레벨(_matchLevel) 코인 + 그 아래 영구카드레벨(level) 코인 (사용자 결정 2026-06-06)
  // 2026-06-09 — 유닛 카드만 표시. 스펠/부착 카드는 즉발 소멸이라 매치 progression 미적용(매치레벨 항상 1) → 코인 시각 잡음. (사용자 결정)
  if (opts.isMatchHand && kind === 'unit') {
    const boardLvCoin = document.createElement('div');
    boardLvCoin.className = 'board-lv';
    boardLvCoin.textContent = unit._matchLevel || unit.matchLevel || 1;
    el.appendChild(boardLvCoin);

    const cardLvCoin = document.createElement('div');
    cardLvCoin.className = 'card-lv';
    cardLvCoin.textContent = unit.level || 1;
    el.appendChild(cardLvCoin);
  }

  // ───── 5) Keyword 알약 (첫 키워드만) ─────
  if (keywords.length > 0) {
    const kw = document.createElement('div');
    kw.className = 'keyword';
    kw.textContent = keywords[0];
    el.appendChild(kw);
  }

  // 2026-05-17 #5 — kind 시각 배지 (사용자 컨펌 갤러리 v1).
  // 손패 모드만 표시. 보드 (in-play) 는 카드 형태로 unit/spell 구분 자명.
  // 영웅 카드 (kind:'hero') 도 제외 — 영웅은 한 종류라 배지 불필요.
  if (!isInPlay && kind !== 'hero') {
    const kindTag = document.createElement('div');
    kindTag.className = 'kind-tag';
    let label = 'UNIT';
    if (kind === 'spell-target' || kind === 'spell-aoe') label = 'SPELL';
    else if (kind === 'attach-hero' || kind === 'attach-unit') label = 'BUFF';
    kindTag.textContent = label;
    el.appendChild(kindTag);
  }

  // ───── 6) Name + Gold Rule + Desc (in-play 제외) ─────
  if (!isInPlay) {
    const name = document.createElement('div');
    name.className = 'name';
    name.textContent = (unit.isHero ? '⭐ ' : '') + (unit.name || '');
    el.appendChild(name);

    const goldRule = document.createElement('div');
    goldRule.className = 'gold-rule';
    el.appendChild(goldRule);

    const desc = document.createElement('div');
    desc.className = 'desc';
    desc.textContent = _stripTokens(unit.ability || unit.skillDesc || unit.desc || '');
    el.appendChild(desc);
  }

  let atkNum = null;
  let hpNum = null;

  if (isSpell) {
    // ───── Spell DMG 아이콘 (우하단) — frame_spell.jsx ─────
    // 데이터 ATK 필드 → dmg, role → dmgType (attack=magic, ranged-flag=ranged, melee-flag=melee)
    // 우리 데이터엔 dmgType 명시 필드 없으니 element/role 기반 추론.
    const dmgVal = unit.ATK != null ? unit.ATK : (unit.atk != null ? unit.atk : null);
    if (dmgVal != null && dmgVal > 0) {
      const dmgType = unit.dmgType || _inferDmgType(unit);
      const dmgIcon = document.createElement('div');
      dmgIcon.className = 'dmg-icon dmg-' + dmgType;
      const dmgImg = document.createElement('img');
      dmgImg.src = _DMG_ICON[dmgType] || _DMG_ICON.magic;
      dmgImg.alt = '';
      dmgImg.onerror = function(){ this.style.display = 'none'; };
      dmgIcon.appendChild(dmgImg);
      const dmgNumEl = document.createElement('span');
      dmgNumEl.className = 'num';
      dmgNumEl.textContent = dmgVal;
      dmgIcon.appendChild(dmgNumEl);
      el.appendChild(dmgIcon);
      atkNum = dmgNumEl;  // 호환 (CardV4Component setStatModifier 가 atkNum 참조)
    }

    // ───── SPELL 라벨 (하단 중앙) — frame_spell.jsx ─────
    // owner 우선순위: unit.owner (명시) > bundledSkillIds 역매핑 > 'SPELL' fallback.
    const spellLabel = document.createElement('div');
    spellLabel.className = 'spell-label';
    const ownerAuto = unit.owner || _ensureSpellOwnerMap()[unit.id] || null;
    const labelText = ownerAuto || 'SPELL';
    spellLabel.innerHTML =
      '<span class="spell-label-line"></span>' +
      '<span class="spell-label-text">' + _escapeHtml(labelText) + '</span>' +
      '<span class="spell-label-line"></span>';
    if (ownerAuto) spellLabel.classList.add('has-owner');
    el.appendChild(spellLabel);
  } else {
    // ───── 7) ATK 아이콘 (좌하단 검) ─────
    // 영웅 카드는 _heroRole (warrior/ranger/support) 우선 — role 은 PHASE 6 'attack'/'support' 라 ranger 구분 안 됨.
    const atkIcon = document.createElement('div');
    atkIcon.className = 'atk-icon';
    const atkImg = document.createElement('img');
    // 2026-06-16 — 공격 아이콘 = dmgType 기준 (혼란 제거). 단 defense+근접만 검+방패 유지(탱커). 갤러리 mockup/attack_icon 컨펌.
    const _dt = unit.dmgType || ({warrior:'melee',ranger:'ranged',support:'magic'}[unit._heroRole]) || _inferDmgType(unit);
    atkImg.src = (unit.role === 'defense' && _dt === 'melee')
      ? _ROLE_ICON.defense
      : (_DMGTYPE_TO_ICON[_dt] || _ROLE_ICON[unit.role] || _ATK_ICON_DEFAULT);
    atkImg.alt = '';
    atkImg.onerror = function(){ this.style.display = 'none'; };
    atkIcon.appendChild(atkImg);
    const atkNumEl = document.createElement('span');
    atkNumEl.className = 'num';
    // 2026-05-12 fix: 매치 인스턴스의 curATK 우선 (효과/레벨업 반영). 원본 ATK 는 폴백.
    const curATK = (unit.curATK != null) ? unit.curATK : (unit.ATK != null ? unit.ATK : (unit.atk != null ? unit.atk : 0));
    const baseATK = (unit.baseATK != null) ? unit.baseATK : (unit.ATK != null ? unit.ATK : 0);
    atkNumEl.textContent = curATK;
    // 2026-05-16 — 영구 색 분기 (buff 녹색 / nerf 자홍, 사용자 컨펌 v4 시안)
    if(curATK > baseATK) atkNumEl.classList.add('is-buffed');
    else if(curATK < baseATK) atkNumEl.classList.add('is-nerfed');
    atkIcon.appendChild(atkNumEl);
    el.appendChild(atkIcon);
    atkNum = atkNumEl;

    // ───── 8) HP 아이콘 (우하단 방패) ─────
    const hpIcon = document.createElement('div');
    hpIcon.className = 'hp-icon';
    const hpImg = document.createElement('img');
    hpImg.src = _HP_ICON;
    hpImg.alt = '';
    hpImg.onerror = function(){ this.style.display = 'none'; };
    hpIcon.appendChild(hpImg);
    const hpNumEl = document.createElement('span');
    hpNumEl.className = 'num';
    // 2026-05-12 fix: 매치 인스턴스의 curHP 우선 (데미지/회복 반영). 원본 HP 는 폴백.
    const curHP = (unit.curHP != null) ? unit.curHP : (unit.HP != null ? unit.HP : (unit.hp != null ? unit.hp : 0));
    const baseHP = (unit.maxHP != null) ? unit.maxHP : (unit.HP != null ? unit.HP : 0);
    hpNumEl.textContent = curHP;
    // 2026-05-16 — 영구 색 분기 (buff 녹색 / nerf 자홍)
    if(curHP > baseHP) hpNumEl.classList.add('is-buffed');
    else if(curHP < baseHP) hpNumEl.classList.add('is-nerfed');
    hpIcon.appendChild(hpNumEl);
    el.appendChild(hpIcon);
    hpNum = hpNumEl;

    // #28 임시 스탯 버프 배지 — in-play 보드 카드에서 stat 별로 영향 아이콘 위에 표시.
    if (isInPlay && Array.isArray(unit._tempStatBuffs) && unit._tempStatBuffs.length) {
      const atkBuffs = unit._tempStatBuffs.filter(b => b && b.stat === 'ATK');
      const hpBuffs  = unit._tempStatBuffs.filter(b => b && b.stat === 'HP');
      if (atkBuffs.length) el.appendChild(_buildTempBuffBadge(atkBuffs, 'atk'));
      if (hpBuffs.length)  el.appendChild(_buildTempBuffBadge(hpBuffs, 'hp'));
    }

    // ───── 9) DEF 아이콘 (중앙 하단, in-play/shield 보드 _def>0 시 표시) ─────
    // 2026-05-30 — design/race_synergy + DEF 시스템 (04-balance.md). 사용자 결정 v_final4.html 골드 A 채택.
    // 위치: top:178 left:85 (translateY:2, HP 숫자와 가로선 정합 — 2026-05-31 v2). 크기/font ATK/HP 정합 (90×90, 45px Cinzel).
    // 색: #ffd700 골드 (HS Armor 표준). _def=0 미렌더 (잡음 0, 04-balance.md 표시 룰 정합).
    // 2026-05-31 v3 — 보드 DEF 표시 .def-icon 단일화 (옛 mc-def-badge 폐기). 쉴드(taunt) 보드 카드도 렌더.
    const curDef = (unit._def != null) ? unit._def : 0;
    if ((isInPlay || isShield) && curDef > 0) {
      const defIcon = document.createElement('div');
      defIcon.className = 'def-icon';
      const defImg = document.createElement('img');
      defImg.src = 'img/ui/icons/t_def.png';
      defImg.alt = '';
      defImg.onerror = function(){ this.style.display = 'none'; };
      defIcon.appendChild(defImg);
      const defNumEl = document.createElement('span');
      defNumEl.className = 'num';
      defNumEl.textContent = curDef;
      defIcon.appendChild(defNumEl);
      el.appendChild(defIcon);
    }
  }

  return { el, atkNum, hpNum };
}

// dmgType 추론 — frame_spell.jsx 의 melee/ranged/magic 분류
// 우리 데이터엔 명시 필드 없으니 element + role 기반 추정
function _inferDmgType(unit){
  const role = unit.role || 'attack';
  const element = unit.element || 'dark';
  // physical 원소 (earth) + attack/defense 역할 = melee
  if (element === 'earth' && role !== 'support') return 'melee';
  // ranged 명시 또는 ranged role
  if (role === 'ranged') return 'ranged';
  // 그 외 (magical 원소 fire/water/lightning/holy/dark) = magic
  return 'magic';
}

function _escapeHtml(s){
  return String(s == null ? '' : s)
    .replace(/&/g, '&amp;').replace(/</g, '&lt;')
    .replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

// ───── 외부 API: mkCardEl (호환 래퍼) ─────
RoF.dom.mkCardEl = function(c, opts){
  return _buildCardEl(c, opts).el;
};

RoF.dom.mkRelicEl = function(r){
  return _buildCardEl(r, { frameMode: 'hand', kind: 'relic' }).el;
};

// ───── CardV4Component (setter API 보존) ─────
RoF.CardV4Component = (function(){

  function create(unit, opts){
    opts = opts || {};
    const built = _buildCardEl(unit, opts);
    const el = built.el;
    const state = {
      currentHP: unit.HP != null ? unit.HP : (unit.hp != null ? unit.hp : 0),
      maxHP:     unit.HP != null ? unit.HP : (unit.maxHp || unit.hp || 1),
      statMods:  { atk: 0 },
      statuses:  {},
      selected:  false,
      _unit:     unit,
      _opts:     opts,
    };

    const inst = {
      el,
      _opts: opts,

      setHP(n){
        state.currentHP = Math.max(0, Math.min(state.maxHP, n|0));
        if (built.hpNum) built.hpNum.textContent = state.currentHP;
        if (state.currentHP <= 0) el.classList.add('is-dead');
        return inst;
      },

      setNRG(n){
        // PHASE 6: NRG 폐기 — no-op (호환만 유지)
        return inst;
      },

      setShield(n){
        // DEF 시스템 — 추후 확장
        return inst;
      },

      setStatModifier(stat, delta){
        if (stat === 'atk') {
          state.statMods.atk = (state.statMods.atk || 0) + (delta|0);
          const newAtk = (unit.ATK || unit.atk || 0) + state.statMods.atk;
          if (built.atkNum) built.atkNum.textContent = newAtk;
        }
        return inst;
      },

      setStatus(effect, turns){
        if (turns > 0) state.statuses[effect] = turns;
        else delete state.statuses[effect];
        return inst;
      },

      setSelected(bool){
        state.selected = !!bool;
        el.classList.toggle('is-active', state.selected);
        return inst;
      },

      animateHP(toN, duration){
        const fromN = state.currentHP;
        const toC = Math.max(0, Math.min(state.maxHP, toN|0));
        const d = duration || 250;
        const t0 = performance.now();
        const tick = (now) => {
          const t = Math.min(1, (now - t0) / d);
          const eased = t < 0.5 ? 2 * t * t : 1 - Math.pow(-2 * t + 2, 2) / 2;
          const cur = Math.round(fromN + (toC - fromN) * eased);
          inst.setHP(cur);
          if (t < 1) requestAnimationFrame(tick);
        };
        requestAnimationFrame(tick);
        return inst;
      },

      destroy(){
        if (el.parentElement) el.parentElement.removeChild(el);
      },

      _snapshot(){
        return {
          currentHP: state.currentHP,
          statMods:  Object.assign({}, state.statMods),
          statuses:  Object.assign({}, state.statuses),
          selected:  state.selected,
        };
      },
    };

    return inst;
  }

  function rebuild(oldInstance, newUnit){
    const parent = oldInstance.el.parentElement;
    const next = parent ? oldInstance.el.nextSibling : null;
    const snap = oldInstance._snapshot();
    const opts = oldInstance._opts;
    oldInstance.destroy();
    const fresh = create(newUnit, opts);
    fresh.setHP(Math.min(snap.currentHP, newUnit.HP || newUnit.hp || 0));
    if (snap.statMods && snap.statMods.atk) fresh.setStatModifier('atk', snap.statMods.atk);
    Object.keys(snap.statuses).forEach(k => fresh.setStatus(k, snap.statuses[k]));
    fresh.setSelected(snap.selected);
    if (parent) parent.insertBefore(fresh.el, next);
    return fresh;
  }

  return { create, rebuild, stripTokens: _stripTokens, STATUS_GLYPHS };
})();

window.CardV4Component = RoF.CardV4Component;

// 호환 레이어
RoF.dom.mkCardElV4 = function(c, opts){ return _buildCardEl(c, opts).el; };
window.mkCardEl = RoF.dom.mkCardEl;
window.mkCardElV4 = RoF.dom.mkCardElV4;
window.mkRelicEl = RoF.dom.mkRelicEl;

// 스킬 progressive unlock 판정 (단일 진실, 2026-06-08)
//   skill.unlockLevel 가 캐릭터 카드레벨(character.level) 초과면 잠김.
//   둘째 인자는 unit/hero 인스턴스 또는 숫자(카드레벨) 모두 허용.
RoF.skillUnlockLevel = function(skill){ return (skill && skill.unlockLevel) || 1; };
RoF.isSkillLocked = function(skill, characterOrLevel){
  const lv = (typeof characterOrLevel === 'number')
    ? characterOrLevel
    : ((characterOrLevel && characterOrLevel.level) || 1);
  return RoF.skillUnlockLevel(skill) > lv;
};
// 카드가 fromLv → toLv 로 레벨업할 때 (fromLv, toLv] 구간에서 새로 해금되는 시그니처 스킬 목록.
//   해금 연출(presentLevelUp) 큐잉 + 회귀 검증의 단일 진실.
RoF.skillsUnlockedBetween = function(card, fromLv, toLv){
  if(!card || toLv <= fromLv) return [];
  const SKILLS = (RoF.Data && RoF.Data.SKILLS) || [];
  return (card.bundledSkillIds || []).reduce(function(acc, id){
    const s = SKILLS.find(function(x){ return x.id === id; });
    if(!s) return acc;
    const ul = RoF.skillUnlockLevel(s);
    if(ul > fromLv && ul <= toLv) acc.push(s);
    return acc;
  }, []);
};
