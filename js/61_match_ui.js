'use strict';

// ─────────────────────────────────────────────────────────────
// PHASE 6 TCG 매치 UI (2026-05-05 Phase D-1 → D-2)
// 코어: 60_turnbattle_v6.js (RoF.Match)
// 화면: index.html #tcg-screen
// 스타일: css/43_match.css
//
// D-1 (완료):
//  - 정적 placeholder 렌더 + 클릭 인터랙션
//
// D-2 (이번):
//  - 영웅 정중앙 + 보드 좌/우 분할 렌더 (board 배열의 mid 기준 split)
//  - 드래그 인서트: 손패 카드 → 보드 슬롯 사이 드롭 (insertIdx 결정)
//  - 스킬/공격 라인 가이드: SVG line + 마우스 추적
//  - 영혼 풀 카운트 펄스 애니 (변화 시 .is-changed 토글)
//  - 75초 턴 타이머 + 10초 이하 빨강 깜빡 + 만료 시 자동 endTurn
//
// 책임:
//  - RoF.Match.state 를 DOM 으로 렌더 (renderState)
//  - 사용자 입력 (드래그/클릭) → RoF.Match.api 호출로 변환
//  - PHASE 6 5필드 카드 placeholder (mkMatchCard) — A2 단순 div 카드
// ─────────────────────────────────────────────────────────────

(function(global){
  const RoF = global.RoF = global.RoF || {};
  const Match = RoF.Match = RoF.Match || {};
  const UI    = Match.UI = Match.UI || {};

  // ───── 상수 ─────
  const TURN_TIME_MS = 75 * 1000;   // PHASE 6 카드 페이즈
  const BOARD_TURN_TIME_MS = 30 * 1000;  // 2026-05-17 사용자 명시 — 보드 차례 30초 (사용자/AI 둘 다)
  const TIMER_WARN_MS = 10 * 1000;  // 10초 이하 빨강 깜빡

  // ───── 셀렉션 상태 ─────
  // 사용자가 손패 카드를 클릭해 "어디에 쓸까" 결정 중인 단계.
  let _selected = null;
  // {kind:'hand', handIdx:number, card} | {kind:'attacker', uid:string} | null

  // ───── 드래그 상태 ─────
  let _drag = null;
  // {handIdx:number, card, ghost?, dragKind:'unit'|'spell-target'|...} | null

  // ───── 타이머 상태 ─────
  let _timerHandle = null;
  let _timerExpiresAt = 0;

  // ───── 영혼 풀 추적 (변화 감지용) ─────
  let _lastPlayerSoul = -1;
  let _lastEnemySoul = -1;

  // ───── 마우스 좌표 추적 (스킬 라인용) ─────
  let _mouse = {x: 0, y: 0};

  // ───── DOM selector 상수 (2026-05-22 — 카드 사용 통합 흐름 plan B-0-1) ─────
  // 검수관 권고: 하드코딩된 셀렉터를 중앙화 → 보드 markup 변경 시 1곳만 수정.
  const SEL = {
    ALLY_BOARD:    '#tcg-p-board .match-card',
    ALLY_HERO:     '#tcg-p-hero .match-card',
    ENEMY_BOARD:   '#tcg-e-board .match-card',
    ENEMY_HERO:    '#tcg-e-hero .match-card',
    ALLY_TARGETS:  '#tcg-p-board .match-card, #tcg-p-hero .match-card',
    ENEMY_TARGETS: '#tcg-e-board .match-card, #tcg-e-hero .match-card',
  };

  // ───── 스킬 카드 우상단 chip 자동 판정 (단일 dominant op) ─────
  // 우선순위: damage > shield/DEF > heal. 데이터 편집기 computeSkillTopChip 와 동일.
  function _computeSkillTopChip(card){
    if(!card) return null;
    const effs = Array.isArray(card.effects) ? card.effects : [];
    const dmg = effs.find(e => e && e.op === 'damage');
    if(dmg) return {kind:'atk', value: dmg.amount || card.ATK || '?', label:'데미지'};
    const shield = effs.find(e => e && e.op === 'shield');
    if(shield) return {kind:'def', value: shield.amount || card.DEF || '?', label:'보호막'};
    if(card.DEF && card.DEF > 0) return {kind:'def', value: card.DEF, label:'보호막'};
    const heal = effs.find(e => e && (e.op === 'heal' || e.op === 'tick_heal'));
    if(heal) return {kind:'hp', value: heal.amount || card.HP || '?', label:'회복'};
    if(card.ATK && card.ATK > 0) return {kind:'atk', value: card.ATK, label:'ATK'};
    if(card.HP && card.HP > 0) return {kind:'hp', value: card.HP, label:'HP'};
    return null;
  }

  // ───── 카드 생성 — 2026-05-08 T2-A: handoff_0508 frame 정본 라우팅 ─────
  // 옛 .match-card placeholder (mc-need-soul/mc-name/mc-stats 등) 폐기.
  // 새 frame: RoF.dom.mkCardEl 호출 → .card-v4 + frameMode 분기.
  // 호환: .match-card 클래스 + kind-* 클래스 그대로 부착 (매치 css 의 has-def/is-attacker-active/is-target-valid/is-exhausted/is-dead 룰 호환).
  // 매치 progression dot (mc-unit-dots) 만 별도 부착 (frame 외부 메타).
  function mkMatchCard(card, opts){
    opts = opts || {};
    const isHero = !!opts.hero;
    const isBoardUnit = !!opts.boardUnit;
    const kind = card.kind || 'unit';
    const keywords = card.keywords || [];
    // hero 카드는 _buildCardEl 에서 unit 으로 처리 (kind='hero' 면 spell 분기 안 타게)
    const cardForBuilder = isHero ? Object.assign({}, card, { kind: 'unit' }) : card;
    // 시안 정합 frameMode (2026-05-09 — Downloads/카드게임/handoff/ 4종 frame):
    //   영웅 / 일반 보드 유닛   → 'in-play' (frame_board 240×240)
    //   보드 도발(taunt) 유닛   → 'shield'  (frame_shield 240×280, 방패 모양 SVG)
    //   손패 일반 유닛          → 'hand'    (frame_unit 240×336)
    //   손패 도발 유닛          → 'shield'  (자동 — _buildCardEl 호환 분기)
    // 2026-05-16 — opts.frameMode override 지원 (preview 등 외부 강제)
    const frameMode = opts.frameMode || (isHero
      ? 'in-play'
      : (isBoardUnit && keywords.includes('taunt'))
        ? 'shield'
        : isBoardUnit
          ? 'in-play'
          : 'hand');
    // isHero 옵션 — 영웅 카드는 W-crown 옥타곤 frame (frame_hero_board.jsx 정합, 사용자 결정 2026-05-13).
    // isMatchHand — 매치 손패 카드(frameMode 'hand')만 우상단 보드레벨 + 영구카드레벨 코인 표시 (사용자 결정 2026-06-06).
    /* diagnosis-confirmed: 2026-06-06 사유: feature — 매치 손패 카드 레벨 코인 추가 (버그 수정 아님) */
    const cardEl = RoF.dom.mkCardEl(cardForBuilder, { frameMode, isHero, isMatchHand: frameMode === 'hand' });

    // ───── battle_v3.jsx 시안 정합 wrapper 패턴 ─────
    // wrapper(.match-card) 가 layout 사이즈 결정 (시안 W×H = 180×180 / 149×208 등),
    // 안 카드(.card-v4) 가 native 사이즈 (240×240/336) + transform: scale 으로 시각 fit.
    // 매치 css 의 has-def/is-attacker-active/is-target-valid/is-exhausted/is-dead/has-progression 룰은 wrapper 에 부착.
    const wrap = document.createElement('div');
    wrap.className = 'match-card mode-' + frameMode + ' kind-' + kind + ' rar-' + (card.rarity || 'bronze');
    wrap.setAttribute('data-uid', card.uid || card.id);
    wrap.setAttribute('data-id', card.id);
    if(card.element) wrap.setAttribute('data-element', card.element);
    wrap.appendChild(cardEl);

    // 런타임 DEF 표시 — has-def 푸른 오라 (지속). DEF 수치는 .card-v4 안 .def-icon (금색 방패) 으로 단일화.
    // 2026-05-31 — 옛 .mc-def-badge (CSS 없는 고아 element) 폐기. 보드 DEF 표시 = .def-icon 단일 (40_cards.js).
    if(card._def != null && card._def > 0){
      wrap.classList.add('has-def');
    }

    // 2026-05-16 — 옛 mc-unit-dots 흔적 삭제 (사용자 컨펌).
    // 유닛 progression 은 영웅 ring widget 과 동일 패턴 (cost coin 안 ring + Lv) 으로 통일.
    // _renderUnitProgress 가 매 renderState 시 Lv 2+ unit 에 widget 부착.
    // has-progression class (Lv 2+ 외곽 황금 글로우) 는 유지.
    if(kind === 'unit' && card._matchLevel != null && (card._matchLevel || 1) >= 2){
      wrap.classList.add('has-progression');
    }

    return wrap;
  }
  UI.mkMatchCard = mkMatchCard;

  // ───── 메인 렌더 ─────
  // P1-10 fix (2026-05-16): UI renderState 시 round 변화 감지 → side='enemy' 면 AI 호출.
  // 코어 _endRound 가 _beginRound 자동 호출 후 새 라운드 진입 시 firstSide swap.
  // side='enemy' 면 AI 행동 필요. 회귀는 renderState 안 거치므로 baseline 영향 0.
  // 2026-05-24 fix: 초기값 0 → 1 변경. round 1 은 Match.start 의 15~20초 setTimeout 전담 (60:511-517).
  //   옛 0 으로는 round 1 진입 시도 _lastSeenRound trigger 되어 1800ms 만에 AI 행동 → b 안 (15~20초) 무력화.
  //   초기값 1 로 round 1 skip → 의도된 단일 trigger 흐름 (Match.start setTimeout 만 fire).
  let _lastSeenRound = 1;
  UI.renderState = function(){
    const st = Match.state;
    if(!st) return;

    // 2026-05-24 매치 시작 cinematic 진행 중 renderState skip
    //   근본 fix: _renderBoard 가 innerHTML='' 으로 보드 cell 통째 재생성 → cinematic
    //   진행 중 다른 renderState 호출 (AI takeTurn 1.8s setTimeout 등) 시 cinematic
    //   클래스/8 particles 모두 날림. flag 로 차단 → cinematic 끝나면 다음 event 처리 시
    //   renderState 자연 갱신.
    //   battle_system_decisions.md §매치 시작 cinematic 표준 룰 / feature_manifest 3.17.
    if(Match._cinematicActive) return;

    // 새 라운드 감지 + AI 호출 (round 진입 직후 1회만)
    // 2026-05-17 timing fix — AI 가 페이즈 banner (round-start 1.6s + card-phase-start 1.6s) 끝나기 전 행동 → 사용자 인지 못함.
    // 100ms → 1800ms 로 지연 (banner 종료 후 AI 진행).
    if(st.round > _lastSeenRound){
      _lastSeenRound = st.round;
      if(st.side === 'enemy' && !st.winner && Match.AI && Match.AI.takeTurn){
        setTimeout(() => {
          if(Match.state && Match.state.side === 'enemy' && !Match.state.winner){
            Match.AI.takeTurn();
            UI.renderState();
          }
        }, 1800);
      }
    }


    // 2026-05-15 PHASE 6 UX 강화 (사용자 컨펌 mockup/phase6_ux_v1 v3) —
    // #tcg-screen 에 data-phase / data-side 부여 → CSS 가 페이즈 라벨 + ENDTURN 라벨 + glow 분기.
    // 2026-05-17 묶음 1 추가 — phase 전환 감지 시 #tcg-phase-band 펄스 (1.6s fade)
    // 2026-06-09 버그2 fix — 보드 페이즈 재생 중이면 인디케이터를 최종 상태로 점프시키지 않음.
    //   _visualSide 는 _animUnitAttack(공격자 측) / _animTurnSideChange(ev.side) 가 재생 시점에 전진.
    //   카드 페이즈 또는 큐 idle(재생할 이벤트 없음)이면 st.side 로 reconcile (기존 동작 = 즉시 최종).
    const _evPending = Array.isArray(st.events) && st.events.length > 0;
    if(st.phase !== 'board' || !_evPending){
      _visualSide = st.side || 'player';
    }
    const tcg = document.getElementById('tcg-screen');
    if(tcg){
      const newPhase = st.phase || 'card';
      const prevPhase = tcg.getAttribute('data-phase');
      tcg.setAttribute('data-phase', newPhase);
      // 2026-05-28 D UX 강화 2-A — 보드 페이즈 시 st.side 는 cursor.sideKey 와 sync (P0-2 fix).
      //   카드 페이즈 시 st.side 는 진행 측. data-side selector 가 CSS 의 자기/적 시각 분기 트리거.
      // 2026-06-09 — st.side 대신 _visualSide (재생 중 과거 점프 방지).
      tcg.setAttribute('data-side',  _visualSide);
      // 매치 종료 시 자기 차례 glow 해제 (CSS .is-match-end 룰)
      tcg.classList.toggle('is-match-end', !!st.winner);
      // 페이즈 전환 시점 (CARD ↔ BOARD) 만 band 펄스 — 단순 side swap 은 X
      if(prevPhase && prevPhase !== newPhase){
        UI._flashPhaseBand(newPhase);
      }
    }

    // 2026-05-28 D UX 강화 2-A — 보드 페이즈 cursor 활성 unit/영웅에 .is-cursor-active class 부여.
    //   CSS 룰: 자기 측 cursor unit 영웅 -4px 띄움 + 강한 glow. 적 측 +4px (위로).
    //   카드 페이즈 시점에는 cursor 무관 (cursor 진행은 보드 페이즈 전용).
    UI._renderCursorActive(st);

    // HUD 이름
    const pName = document.getElementById('tcg-p-name');
    const eName = document.getElementById('tcg-e-name');
    if(pName) pName.textContent = (global.Auth && (Auth.heroName||Auth.user)) || '나';
    if(eName) eName.textContent = '도전자';

    // 영혼 풀 (애니 트리거 포함)
    UI._renderSoul('player', st.player.soulPool);
    UI._renderSoul('enemy',  st.enemy.soulPool);

    // 턴
    const turnNum  = document.getElementById('tcg-turn-num');
    const turnSide = document.getElementById('tcg-turn-side');
    if(turnNum) turnNum.textContent = st.turn;
    if(turnSide){
      // 2026-06-09 — _visualSide (재생 중 과거 점프 방지). idle 시 위에서 st.side 로 reconcile 됨.
      turnSide.textContent = (_visualSide === 'player') ? '내 턴' : '적 턴';
      turnSide.classList.toggle('is-enemy', _visualSide !== 'player');
    }

    // 사용자 프로필 (좌/우 상하단, 2026-05-10 결정 — 옛 영웅 portrait 자리 재용도)
    UI._renderProfile('player');
    UI._renderProfile('enemy');

    // 보드 — battle_v3 시안 7 슬롯 grid + 가운데 (idx=3) 는 영웅 cell (2026-05-10 결정)
    UI._renderBoard(document.getElementById('tcg-p-board'), st.player.board, 'player', st.player.hero);
    UI._renderBoard(document.getElementById('tcg-e-board'), st.enemy.board, 'enemy',  st.enemy.hero);
    /* diagnosis-confirmed: 2026-06-13 사유: feature — 종족 시너지 N/6 인디케이터 렌더 배선 (갤러리 B+좌측세로 컨펌). */
    if(typeof UI._renderSynergyTray === 'function'){ UI._renderSynergyTray(); }  /* diagnosis-confirmed: 2026-06-15 사유: refactor — 단일 대칭 트레이라 1회 호출(옛 player/enemy 2회). 버그 아님. */

    // 손패
    UI._renderHand();

    // 마나 크리스탈 (좌하단) + TURN 패널 (우 정중앙) + 적 손패 fan
    UI._renderManaCrystal(st);
    UI._renderTurnPanel(st);
    UI._renderOppHand(st);

    // 카드 주머니 (덱 / 운명서) — Phase 1A.1 (2026-05-07)
    UI._renderDeckPouches();

    // 검 인디케이터 V2 (Plan 2.D, 2026-05-12 갤러리 컨펌)
    UI._renderSword(st);

    // 영웅 매치 progression 위젯 (rules/04-balance.md 정본 — 2026-05-13 재구현)
    UI._renderHeroProgress(st);
    UI._renderUnitProgress(st);  // 2026-05-16 — 유닛 progression ring widget (Lv 2+ 만)

    // 턴 종료 버튼 활성화
    const endBtn = document.getElementById('tcg-end-turn-btn');
    if(endBtn) endBtn.disabled = (st.side !== 'player' || !!st.winner);

    // 타이머 — 매치 진행 중이고 winner 없으면 갱신
    UI._refreshTimer();

    // 스킬/공격 라인 — 셀렉션 변화 시 갱신
    UI._renderTargetLine();

    // 2026-05-23 A안 — cast 시각 자동 부착 / cleanup (사용자 명시 "근본 fix").
    //   _selected 있으면 cast 시각 (좌측 cast + 글로우 + casting-mode) 살아있게 유지.
    //   _selected null 이면 모두 cleanup. 어디서 renderState 호출돼도 정합.
    //   → 옛 _applyCastVisual 외부 호출 의존성 폐기 (다른 곳에서 renderState 호출돼도 안전).
    const _tcgScreen = document.getElementById('tcg-screen');
    if(_selected && _selected.kind === 'hand' && _selected.card){
      const _castCard = _selected.card;
      // (a) #tcg-screen .is-casting-mode 유지
      if(_tcgScreen) _tcgScreen.classList.add('is-casting-mode');
      // (b) 손패 .is-casting 부착 (DOM 재생성 후 새 element 대상)
      const _slot = document.querySelector('#tcg-hand .tcg-hand-card[data-hand-idx="' + _selected.handIdx + '"]');
      if(_slot) _slot.classList.add('is-casting');
      // (c) 좌측 cast 카드 — 안 보이면 다시 적재
      const _cc = document.getElementById('tcg-spell-cast-card');
      if(_cc && !_cc.classList.contains('is-showing')){
        UI._showLeftCast(_castCard, {persistent: true});
      }
      // (d) 글로우 — 스펠주인(self-only) 카드는 AoE 하이라이트 대신 소유 유닛 글로우만 (2026-06-07)
      if(_isSelfOnlyCard(_castCard)){
        _showSelfTargetHint(_castCard);
      } else {
        // _applyAoeGlow 가 idempotent (이미 부착되어 있으면 no-op)
        const _h = KIND_CAST_HANDLERS && KIND_CAST_HANDLERS[_castCard.kind];
        if(_h && _h.onCast) _h.onCast(_castCard);
      }
    } else {
      // 셀렉션 없음 / attacker 셀렉션 — cast 시각 모두 cleanup
      if(_tcgScreen) _tcgScreen.classList.remove('is-casting-mode');
      const _cc = document.getElementById('tcg-spell-cast-card');
      if(_cc && _cc.classList.contains('is-showing')){
        _cc.classList.remove('is-showing');
        setTimeout(() => {
          if(!_cc.classList.contains('is-showing')) _cc.innerHTML = '';
        }, 260);
      }
      // 글로우 cleanup (.tcg-aoe-cast-active + .is-target-attack/buff 모두 제거)
      document.querySelectorAll('.is-target-attack-aoe, .is-target-buff-aoe').forEach(el => {
        el.classList.remove('is-target-attack', 'is-target-buff',
                            'is-target-attack-aoe', 'is-target-buff-aoe');
      });
      if(_tcgScreen) _tcgScreen.classList.remove('tcg-aoe-cast-active');
      // 스펠주인(self-only) 소유 유닛 글로우 cleanup (2026-06-07 — 셀렉션 해제 시 잔존 방지)
      _clearSelfTargetHint();
      // 손패 .is-casting cleanup (모두 제거)
      document.querySelectorAll('#tcg-hand .tcg-hand-card.is-casting').forEach(s => s.classList.remove('is-casting'));
      // 2026-05-31 — unit 카드 마우스 ghost + 보드 insert gap cleanup (누락 fix).
      //   배치 중(_selected=unit) 턴 종료/타이머만료/사이드전환 시 endTurnUI 가 _selected=null 만 하고
      //   _cancelSelection 을 안 거쳐 ghost(#tcg-mouse-ghost is-active)가 마우스 따라다니던 버그.
      //   renderState 는 모든 상태변화 경로를 거치므로 여기서 단일 정리 = 근본 fix.
      _hideMouseGhost();
      _hideBoardInsertGap();
    }

    // 레벨업 모달 (player 영웅이 pendingLevelUp 인 동안 표시)
    UI._renderLevelUpModal();

    // 2026-05-28 — 옛 _renderWinner overlay 호출 폐기 (사용자 보고 "메뉴로 클릭 → null classList 에러").
    // 정본 흐름: _endMatch cascade (match-end-banner → reward-preview → continue-button "보상 받기" → showReward).
    // 옛 overlay 가 cascade 위에 중복 표시 + 메뉴로 onclick 의 town-screen 호출이 null element 에러 발생.
    // _renderWinner 함수 자체는 보존 (dev fallback). renderState 호출만 제거.
    // if(st.winner) UI._renderWinner(st.winner);

    // ── Option B (2026-06-13) — pending damage 타겟 HP 를 "공격 전" 값으로 hold ──
    /* diagnosis-confirmed: 2026-06-13 사유: bug-fix repro:player 공격 시 코어 _damage 가 동기로 curHP 차감 →
       renderState 가 보드를 최종(감소)값으로 먼저 그림 → 이후 _processEvents 가 unit-attack(lunge 500ms) →
       damage(_animDamage oldHP 복원+interpolation) 재생. Playwright 타임라인 측정(HP4,ATK2): 31ms "2"(즉시감소)
       → 567ms "4"(되감기) → 700ms "3" → 820ms "2" = "결과 먼저 보이고 모션 나중" 되감기 깜빡임.
       fix: renderState 가 보드를 그린 직후(아직 _processEvents 미실행 = st.events 살아있음) 미재생 damage event 의
       타겟 HP 를 옛 값(hpAfter+amount)으로 되돌려 둠 → lunge 임팩트의 _animDamage 가 단방향 interpolation 감소.
       _processEvents 가 st.events 를 즉시 비우므로(_processEvents line 482-483) 영구 hold 불가 —
       cascade 종료 renderState(st.events 빔)가 최종 curHP 복원 = safety net. kill 케이스는 타겟 DOM 제거로 자연 제외.
       demo:visual_match_cycle hp-no-rewind / Playwright after 타임라인 4→4→3→2 단방향. */
    (st.events || []).forEach(_ev => {
      if(_ev && _ev.type === 'damage' && (_ev.amount | 0) > 0){
        const _tEl = document.querySelector('[data-uid="' + _ev.targetUid + '"]');
        const _hpNum = _tEl && _tEl.querySelector('.hp-icon .num');
        if(_hpNum) _hpNum.textContent = String((_ev.hpAfter | 0) + (_ev.amount | 0));
      }
    });

    /* diagnosis-confirmed: 2026-06-14 사유: feature — 속도 조절 버튼 + 전투 로그 패널 보장 (페이싱·내레이션 2단계, idempotent). */
    _ensureSpeedControl();
    _ensureLogPanel();

    // 이벤트 큐 처리 — Phase 1A.2 (2026-05-07)
    // 코어가 push 한 시각 이벤트 sequence 를 순차 재생. 1A.4 에서 실제 애니 구현 예정.
    UI._processEvents();
  };

  // 2026-05-17 #12 — self-only 스펠 판별 (target='hero' 또는 'self' 만 가진 카드).
  // attach-hero 인데 target='ally_one' 인 카드는 self-only 아님 (다른 아군 unit 선택).
  // 모든 effects 가 self 타겟인 카드만 자기 영웅 hint 표시 대상.
  /* diagnosis-confirmed: 2026-06-07 사유: feature — 스펠주인 명시 selfOnly 플래그 우선 (화염방패 등 "지정 아군" self-vestige attach 카드 오분류 방지) */
  function _isSelfOnlyCard(card){
    if(!card) return false;
    if(card.selfOnly === true) return true;
    if(card.selfOnly === false) return false;  // 명시적 제외 — effects 가 self vestige 라도 실제는 지정 아군 (화염방패)
    /* diagnosis-confirmed: 2026-06-07 사유: feature — attach-self = 정의상 스펠주인 부착 (effect target 무관 self-only). 버그 픽스 아님. */
    if(card.kind === 'attach-self') return true;
    if(!Array.isArray(card.effects) || card.effects.length === 0) return false;
    return card.effects.every(e => e && (e.target === 'hero' || e.target === 'self'));
  }

  /* diagnosis-confirmed: 2026-06-07 사유: feature — 스펠주인(self-only) 글로우 v3 강화 + 대상 영웅→소유 유닛(A안, 사용자 갤러리 컨펌) */
  // 엔진 _resolveEffectTargets case 'self' (ctx.caster 우선, 영웅 fallback) 와 동일 규칙으로 cell 결정 → 시각·효과 1:1.
  function _selfOwnerCell(card){
    const pHero = document.getElementById('tcg-p-hero');
    const st = Match.state;
    const side = st && st.player;
    if(!side || !card) return pHero;
    let owner = null;
    try { if(Match._resolveCaster) owner = Match._resolveCaster(side, card); } catch(_){}
    if(!owner) return pHero;                                   // 엔진 self fallback = 영웅
    if(side.hero && owner.uid === side.hero.uid) return pHero; // 영웅 시그
    const el = document.querySelector('#tcg-p-board .match-card[data-uid="' + owner.uid + '"]');
    if(el) return el.closest('.tcg-board-cell') || el.parentElement;
    return pHero;
  }
  function _showSelfTargetHint(card){
    _clearSelfTargetHint();
    const cell = _selfOwnerCell(card);
    if(cell) cell.classList.add('is-self-target-hint');
  }
  function _clearSelfTargetHint(){
    document.querySelectorAll('.is-self-target-hint').forEach(el => el.classList.remove('is-self-target-hint'));
  }

  // ───── D UX 강화 2-A — cursor 활성 unit highlight (2026-05-28) ─────
  // 보드 페이즈 cursor 활성 unit/영웅의 cell 에 .is-cursor-active class 부여.
  // CSS 룰: 자기 측 cursor unit 영웅 -4px 띄움 + 강한 glow / 적 측 +4px (위로).
  // 카드 페이즈 시점 또는 cursor 없을 때는 모든 cell 에서 class 제거 (cleanup).
  UI._renderCursorActive = function(st){
    // 모든 cell 에서 .is-cursor-active 제거 (cleanup)
    document.querySelectorAll('.tcg-board-cell.is-cursor-active, #tcg-p-hero.is-cursor-active, #tcg-e-hero.is-cursor-active')
      .forEach(el => el.classList.remove('is-cursor-active'));

    if(!st || st.phase !== 'board' || st.winner) return;
    const queue = st.boardTurnQueue || [];
    const cursor = st.boardTurnCursor | 0;
    const entry = queue[cursor];
    if(!entry || !entry.sideKey || !entry.unitUid) return;

    // 영웅 cell 우선 (영웅의 uid 가 entry.unitUid 면 cell 자체 토글)
    const heroEl = document.getElementById(entry.sideKey === 'enemy' ? 'tcg-e-hero' : 'tcg-p-hero');
    if(heroEl){
      const heroCard = heroEl.querySelector('.match-card');
      if(heroCard && heroCard.getAttribute('data-uid') === entry.unitUid){
        heroEl.classList.add('is-cursor-active');
        return;
      }
    }
    // 보드 cell 안 .match-card[data-uid] 매칭 cell 검색
    const boardRowId = entry.sideKey === 'enemy' ? 'tcg-e-board' : 'tcg-p-board';
    const card = document.querySelector('#' + boardRowId + ' .match-card[data-uid="' + entry.unitUid + '"]');
    if(card){
      const cell = card.closest('.tcg-board-cell');
      if(cell) cell.classList.add('is-cursor-active');
    }
  };

  // ───── 페이즈 라벨 가로 띠 펄스 (1.6s fade) — 2026-05-17 묶음 1 ─────
  // design-confirmed: 2026-05-17 사유: mockup/phase6_ux_turn_clarity/v3_final.html 사용자 컨펌
  // CARD ↔ BOARD 페이즈 전환 시점만 호출 (renderState 가 prevPhase 비교 후 트리거).
  // is-flash 클래스 토글로 CSS @keyframes phasePulseFade (1.6s) 재생.
  UI._flashPhaseBand = function(phase){
    const band = document.getElementById('tcg-phase-band');
    if(!band) return;
    const icon = band.querySelector('.pb-icon');
    const text = band.querySelector('.pb-text');
    if(icon) icon.textContent = phase === 'card' ? '📜' : '⚔';
    if(text) text.textContent = phase === 'card' ? 'CARD PHASE' : 'BATTLE PHASE';
    // animation restart 패턴 — 클래스 제거 → reflow → 다시 부여
    band.classList.remove('is-flash');
    void band.offsetWidth;
    band.classList.add('is-flash');
  };

  // ───── 이벤트 큐 인프라 — Phase 1A.2 (2026-05-07) ─────
  // 코어 (60_turnbattle_v6.js) 가 Match.state.events 에 push 한 시각 이벤트를
  // 순차 재생. 실제 애니 분기는 Phase 1A.4 에서 추가 (현재는 default resolve 즉시).
  //
  // 패턴: state 변경 → events.push → renderState → _processEvents 가 큐 소비
  // async/await 로 순서 보장 (fly → projectile → damage → shatter 겹치지 않음).
  let _processingEvents = false;
  /* diagnosis-confirmed: 2026-06-09 repro:라이브 보드매치에서 player 공격이 유닛 kill 시 Match.attack 가 동기로 _cleanupBoard→유닛 보드제거, renderState 가 최종상태로 DOM rebuild(타겟 사라짐) 후 _processEvents 재생 → _animUnitAttack 가 element 못찾아 lunge 스킵(domTargetExists_afterRenderState=false 측정) demo:visual_match_cycle 보드킬 lunge 재생 + 인디케이터 측 검증 */
  // 2026-06-09 보드 페이즈 시각 fix (버그진단 B안):
  //   _lastBoardRects: 보드 wipe 직전 셀 rect 스냅샷 (uid별). 죽은 유닛 lunge 재생 위치 보존 (버그1: 공격 애니 씹힘).
  //   _visualSide: 인디케이터 전용 턴 상태. 보드 재생 중 공격자 측으로 전진 (버그2: 적턴에 내 유닛 공격). 큐 idle 시 st.side reconcile.
  let _lastBoardRects = {};
  let _visualSide = 'player';
  function _setVisualSide(side){
    _visualSide = side || 'player';
    const tcg = document.getElementById('tcg-screen');
    if(tcg) tcg.setAttribute('data-side', _visualSide);
    const turnSide = document.getElementById('tcg-turn-side');
    if(turnSide){
      turnSide.textContent = (_visualSide === 'player') ? '내 턴' : '적 턴';
      turnSide.classList.toggle('is-enemy', _visualSide !== 'player');
    }
  }
  // 2026-05-29 — per-event timeout (사용자 보고 "공격 모션 스킵" 근본 fix).
  //   원인: _playEvent 의 unresolved Promise (예: setTimeout 미발동, animationend 누락) 가
  //   await 영구 pending → outer try/catch 안 잡힘 → _processingEvents=true 영구 stuck →
  //   그 후 모든 events.push 가 처리 안 됨 → 모션/애니 전부 스킵.
  //   해결: 각 _playEvent 호출에 maxMs (default 5000ms) 안전망. timeout 시 console.warn + 다음 ev 진행.
  const _EVENT_MAX_MS = 6000;
  function _playEventWithTimeout(ev, maxMs){
    return new Promise((resolve) => {
      let done = false;
      const timer = setTimeout(() => {
        if(done) return;
        done = true;
        console.warn('[match-ui] _playEvent timeout', ev && ev.type, maxMs + 'ms — 강제 진행');
        resolve();
      }, maxMs);
      Promise.resolve()
        .then(() => UI._playEvent(ev))
        .catch(e => { console.warn('[match-ui] _playEvent err:', ev && ev.type, e); })
        .finally(() => {
          if(done) return;
          done = true;
          clearTimeout(timer);
          resolve();
        });
    });
  }
  UI._processEvents = async function(){
    const st = Match.state;
    if(!st || !Array.isArray(st.events) || !st.events.length) return;
    if(_processingEvents) return;  // 재진입 방지 (renderState 중첩 호출 가드)
    _processingEvents = true;
    // 2026-05-29 try/finally — 어떤 throw / unresolved 도 _processingEvents=true 영구 stuck 차단.
    //   옛 흐름: cleanup hook (line 402-405, 425-428) throw → outer async reject → flag false 도달 X → 영구 stuck.
    //   사용자 보고 "어쩔 때 공격 모션 스킵" 22번째 visual cascade 패턴 재발의 구조적 가드.
    try {
      const queue = st.events.slice();
      st.events = [];
      // 2026-05-17 telemetry: 큐 처리 전 history 에 push (dev.dumpEventsHistory 용)
      if(!st._eventsHistory) st._eventsHistory = [];
      const _ts = Date.now();
      for(const ev of queue){
        st._eventsHistory.push({type: ev.type, ts: _ts, side: ev.side, round: st.round, phase: st.phase});
        // 최대 200건 — 메모리 보호
        if(st._eventsHistory.length > 200) st._eventsHistory.shift();
        // 2026-05-29 — per-event timeout 보호 (위 _playEventWithTimeout 주석 참조).
        await _playEventWithTimeout(ev, _EVENT_MAX_MS);

        // 2026-05-24 §전투 시각 cascade 룰 — unit-death 처리 직후 즉시 cleanup.
        //   사용자 mental model "사망 visual (ghost fade) 끝나면 즉시 보드에서 제거".
        //   옛 cascade 끝부분 cleanup → events 큐 chain 시 cleanup 시점 늦음 (사용자 보고 "턴 종료 후 없어진다").
        //   각 unit-death event 처리 후 즉시 cleanup + renderState (idempotent — 다른 dead unit 영향 0).
        // 2026-05-29 try/catch — cleanup/renderState throw 격리 (단일 ev throw 가 다음 ev 처리 안 막게).
        // 2026-05-30 #36 B Step 3 — unit-death 후 800ms 텀 (여러 unit 동시 사망 시 한 명씩 보이도록).
        //   _animUnitDeath resolve 시점은 1850ms (ghost fade 끝) — 그 후 cleanup → 다음 unit-death 처리.
        //   다음 unit-death 사이 800ms 텀 = 사용자 mental model "한 명씩 순차" 정합.
        if(ev.type === 'unit-death' && Match.state && Match._cleanupBoard){
          try { Match._cleanupBoard(); }
          catch(e){ console.warn('[match-ui] _cleanupBoard err (unit-death):', e); }
          try { UI.renderState(); }
          catch(e){ console.warn('[match-ui] renderState err (unit-death):', e); }
          // 다음 unit-death event 사이 800ms 텀 (queue 의 다음 event 가 unit-death 면 stagger)
          const queueAfter = (st.events || []);
          const nextEv = queue[queue.indexOf(ev) + 1];
          if(nextEv && nextEv.type === 'unit-death'){
            /* diagnosis-confirmed: 2026-06-14 사유: feature — 사망 stagger 텀 속도 배수 (페이싱). */
            await new Promise(r => setTimeout(r, Math.round(800 * _speedMult)));
          }

        }

        // 2026-05-24 복원 — 8348407 (5/17) 의 AI 행동 사이 800ms 텀.
        //   5/18 jsonl 복원 사고 시 누락 손실. 사용자 보고 "AI 자동턴 엄청 빠르게 지나가서 인지 못함" 원래 fix.
        //   AI 가 cast/attack/aoe-burst 시각 발현 직후 800ms 텀 → 사용자 인지 시간 확보.
        //   회귀 영향 0: 회귀는 events 안 보고 state 직접 검사.
        /* diagnosis-confirmed: 2026-06-14 사유: feature — 적 사건 텀 속도 배수 (페이싱, design/battle_narration_design.md). */
        if(ev.side === 'enemy' && (ev.type === 'card-cast-left' || ev.type === 'unit-attack' || ev.type === 'aoe-burst')){
          await new Promise(r => setTimeout(r, Math.round(800 * _speedMult)));
        }

        // 2026-05-30 #37 — 턴 전환 명확 텀 (사용자 보고 "엉성한 느낌").
        //   다른 게임 표준 (HS 1~2s banner, Snap 0.5~1s, LoR 0.3~0.5s) 정합.
        //   turn-side-change 처리 후 추가 1000ms 텀 (banner 1.6s + 1s = 사용자 mental model "다음 턴 진입" 확실).
        //   step-change (보드 ↔ 카드) 처리 후 600ms 텀 (페이즈 전환 인지).
        /* diagnosis-confirmed: 2026-06-14 사유: feature — 턴전환 텀 속도 배수 (페이싱). */
        if(ev.type === 'turn-side-change'){
          await new Promise(r => setTimeout(r, Math.round(1000 * _speedMult)));
        }
        /* diagnosis-confirmed: 2026-06-14 사유: feature — 페이즈 전환 텀 속도 배수 (페이싱). */
        if(ev.type === 'step-change' && (ev.toStep === 'card_play' || ev.toStep === 'board_action' || ev.toStep === 'card_end' || ev.toStep === 'board_begin')){
          await new Promise(r => setTimeout(r, Math.round(600 * _speedMult)));
        }
      }
    } finally {
      // 어떤 경로 (정상 / throw / unresolved timeout) 로 빠져나와도 flag 반드시 풀림 — 영구 stuck 0.
      _processingEvents = false;
    }
    if(Match.state && Array.isArray(Match.state.events) && Match.state.events.length > 0){
      setTimeout(() => UI._processEvents(), 0);
    } else {
      // 2026-05-24 cascade 룰 (battle_system_decisions.md §전투 시각 cascade 표준 룰):
      //   events 큐 비어진 = cascade 종료 시점 (CAST → SPELL → DAMAGE → STAT-FLASH → DEATH 모두 끝).
      //   cleanup + renderState 무조건. 옛 _playSpellAoe setTimeout 1500ms 폐기 후 정본 cleanup hook.
      //   2026-05-24 사용자 보고 fix: renderState 조건부 (afterBoard < beforeBoard) → HP/ATK 변화 visual 누락.
      //     enemy hero attack 시 board 변화 X → renderState skip → "AI 공격 안 한다" 사용자 인지.
      //     무조건 renderState 호출 = HP/ATK/board 변화 모두 시각 반영.
      // 2026-05-29 try/catch — cleanup/renderState throw 격리.
      if(Match.state){
        try { if(Match._cleanupBoard) Match._cleanupBoard(); }
        catch(e){ console.warn('[match-ui] _cleanupBoard err (cascade end):', e); }
        try { UI.renderState(); }
        catch(e){ console.warn('[match-ui] renderState err (cascade end):', e); }
        /* diagnosis-confirmed: 2026-06-13 — Option A 보드 적 AI 디퍼 driver. repro/hypo/demo: UI.startMatch 옵션A override 주석 참조. */
        // 애니 큐가 완전히 비워진(cascade 종료) 보드 페이즈 시점에 cursor 가 적이면 적 AI 1배치 실행 → renderState 재진입으로 적 lunge 재생.
        //   _afterBoardTurn(noop override)로 동기 적턴이 차단됐으므로 여기가 유일 적턴 구동점. AI safety(30)+auto-skip 으로 cursor 진행 보장 → 무한루프 X.
        //   적 배치 후 cursor 가 player 면 driver 멈춤(다음 player 클릭 대기). 보드페이즈 종료 시 round 전환 이벤트는 renderState 가 재생.
        if(Match.state.phase === 'board' && !Match.state.winner
           && Match.AI && typeof Match.AI.takeTurn === 'function' && !Match.AI._inLoop){
          const _aiEntry = (Match.state.boardTurnQueue || [])[Match.state.boardTurnCursor | 0];
          if(_aiEntry && _aiEntry.sideKey === 'enemy'){
            try { Match.AI.takeTurn(); }
            catch(e){ console.warn('[match-ui] board-ai defer driver err:', e); }
            if(Match.state && Array.isArray(Match.state.events) && Match.state.events.length > 0){
              try { UI.renderState(); }
              catch(e){ console.warn('[match-ui] renderState err (board-ai driver):', e); }
            }
          }
        }
      }
    }
  };

  // ───── Phase 1A.4 — 시각 애니 (v3 시네마틱) — 2026-05-07 ─────
  // ghost: 손패 자리 → 보드 중앙 fly → 운명 분기 (재사용/각인) 의 시각 분신.
  // fly-to-center 가 생성, shatter / return-to-deck 가 transform 후 제거.
  let _activeFlyGhost = null;

  function _buildGhostAtCenter(card){
    if(!card) return null;
    const g = mkMatchCard(card);
    g.classList.add('tcg-card-ghost');
    g.style.width  = '120px';
    g.style.height = '160px';
    const cx = window.innerWidth  / 2 - 60;
    const cy = window.innerHeight / 2 - 80;
    g.style.left = cx + 'px';
    g.style.top  = cy + 'px';
    g.style.transform = 'scale(1.5)';
    document.body.appendChild(g);
    return g;
  }

  function _drawFateThread(fromRect, toRect){
    if(!fromRect || !toRect) return;
    const t = document.createElement('div');
    t.className = 'tcg-fate-thread';
    const fx = fromRect.left + fromRect.width  / 2;
    const fy = fromRect.top  + fromRect.height / 2;
    const tx = toRect.left   + toRect.width    / 2;
    const ty = toRect.top    + toRect.height   / 2;
    const dx = tx - fx, dy = ty - fy;
    const len = Math.hypot(dx, dy);
    const angle = Math.atan2(dy, dx) * 180 / Math.PI;
    t.style.left  = fx + 'px';
    t.style.top   = fy + 'px';
    t.style.width = len + 'px';
    t.style.transform = 'rotate(' + angle + 'deg)';
    document.body.appendChild(t);
    setTimeout(() => { if(t.parentNode) t.parentNode.removeChild(t); }, 600);
  }

  function _animFlyToCenter(ev){
    return new Promise(resolve => {
      // 2026-05-17 B5 fix — spell 카드 fly ghost 폐기.
      // 사용자 보고 "불꽃정령 스펠쓰면 좌측에서 스펠이 2번떠 + 검은색 그림자 잔재".
      // #10 fix 가 ghost 목적지를 좌측 cast 위치로 변경 → _showLeftCast 와 중복 (2번 뜸).
      // 정본 = _showLeftCast (사용자 컨펌). fly ghost sequence 폐기 (shatter event 도 자연 skip).
      // 옛 검은 그림자 = ghost 의 box-shadow rgba(155,122,217,.8) — 폐기 와 함께 사라짐.
      resolve();
      return;
      /* eslint-disable no-unreachable */
      if(!ev.card){ resolve(); return; }
      // 출발 위치: player = 손패 슬롯 / enemy = 적 영웅 (적 손패 미노출)
      let startRect;
      if(ev.fromSide === 'player'){
        const slot = document.getElementById('tcg-hand-' + ((ev.fromHandIdx || 0) + 1));
        startRect = slot ? slot.getBoundingClientRect() : null;
      } else {
        const eh = document.getElementById('tcg-e-hero');
        startRect = eh ? eh.getBoundingClientRect() : null;
      }
      if(!startRect || startRect.width === 0){ resolve(); return; }

      // 이전 ghost 잔존 시 정리 (renderState 도중 재진입 방어)
      if(_activeFlyGhost && _activeFlyGhost.parentNode){
        _activeFlyGhost.parentNode.removeChild(_activeFlyGhost);
      }

      const ghost = mkMatchCard(ev.card);
      ghost.classList.add('tcg-card-ghost');
      ghost.style.left   = startRect.left   + 'px';
      ghost.style.top    = startRect.top    + 'px';
      ghost.style.width  = startRect.width  + 'px';
      ghost.style.height = startRect.height + 'px';
      document.body.appendChild(ghost);
      _activeFlyGhost = ghost;

      // 2026-05-17 #10 fix — 사용자 명시 "스킬은 좌측에 생겨나고 진행". ghost 목적지 = 좌측 cast 카드 위치.
      // 정중앙 (window 중앙) → 좌측 #tcg-spell-cast-card 좌표로 변경. 좌측 cast 와 시각 통합.
      // fallback: leftCast element 없으면 옛 정중앙 동작 (회귀/dev 환경 호환).
      const leftCast = document.getElementById('tcg-spell-cast-card');
      const leftRect = leftCast ? leftCast.getBoundingClientRect() : null;

      // 더블 RAF: layout commit 후 transition 트리거
      requestAnimationFrame(() => {
        ghost.classList.add('is-flying');
        requestAnimationFrame(() => {
          let cx, cy;
          if(leftRect && leftRect.width > 0){
            cx = leftRect.left;
            cy = leftRect.top;
          } else {
            cx = window.innerWidth  / 2 - startRect.width  / 2;
            cy = window.innerHeight / 2 - startRect.height / 2;
          }
          ghost.style.left = cx + 'px';
          ghost.style.top  = cy + 'px';
          ghost.style.transform = 'scale(1.5)';
          ghost.style.boxShadow = '0 0 50px rgba(155,122,217,.8)';
        });
      });

      setTimeout(resolve, 340);
    });
  }

  function _animShatter(ev){
    return new Promise(resolve => {
      let ghost = _activeFlyGhost;
      // 2026-05-17 — fly ghost 폐기 (B5 fix) 후 shatter 시 새 ghost 만들기 X.
      // 사용자 보고 "염룡술 가운데 한번 떴다가 사라짐" 의 정체 = _buildGhostAtCenter 잔재.
      // _activeFlyGhost 가 set 된 경우 (fly 진행 중) 만 shatter. 그 외 skip.
      if(!ghost){ resolve(); return; }
      ghost.classList.remove('is-flying');
      ghost.classList.add('is-shattering');
      setTimeout(() => {
        if(ghost && ghost.parentNode) ghost.parentNode.removeChild(ghost);
        _activeFlyGhost = null;
        resolve();
      }, 720);
    });
  }

  function _animReturnToDeck(ev){
    return new Promise(resolve => {
      let ghost = _activeFlyGhost;
      if(!ghost && ev.card){
        ghost = _buildGhostAtCenter(ev.card);
        _activeFlyGhost = ghost;
      }
      if(!ghost){ resolve(); return; }

      const pouchId = 'tcg-deck-' + (ev.fromSide === 'player' ? 'player' : 'enemy');
      const pouch = document.getElementById(pouchId);
      const pr = pouch ? pouch.getBoundingClientRect() : null;

      // 운명의 실 — 내 진영만 (적 운명서 fly 는 시각 노이즈)
      if(pr && ev.fromSide === 'player'){
        _drawFateThread(ghost.getBoundingClientRect(), pr);
      }

      ghost.classList.remove('is-flying');
      ghost.classList.add('is-returning');
      if(pr){
        ghost.style.left = pr.left + 'px';
        ghost.style.top  = pr.top  + 'px';
      }
      ghost.style.transform = 'scale(.3)';
      ghost.style.opacity   = '.5';

      setTimeout(() => {
        if(ghost && ghost.parentNode) ghost.parentNode.removeChild(ghost);
        _activeFlyGhost = null;
        resolve();
      }, 620);
    });
  }

  // ───── Phase 1A.4.5 — 발사체 / 데미지 / 광역 (스펠 시각 완성) — 2026-05-07 ─────
  // fly→projectile→damage→fate 시퀀스 의 가운데 부분.
  // damage 는 _damage() 가 push 하므로 모든 데미지 (스펠/공격/반사/DOT) 가 popup.

  function _animProjectile(ev){
    return new Promise(resolve => {
      const target = document.querySelector('[data-uid="' + ev.targetUid + '"]');
      if(!target){ resolve(); return; }
      const tr = target.getBoundingClientRect();
      if(tr.width === 0){ resolve(); return; }

      const proj = document.createElement('div');
      proj.className = 'tcg-projectile';
      const startX = window.innerWidth  / 2 - 16;
      const startY = window.innerHeight / 2 - 16;
      proj.style.left = startX + 'px';
      proj.style.top  = startY + 'px';
      document.body.appendChild(proj);

      requestAnimationFrame(() => {
        proj.style.left = (tr.left + tr.width  / 2 - 16) + 'px';
        proj.style.top  = (tr.top  + tr.height / 2 - 16) + 'px';
      });

      // 510ms = CSS transition .5s + buffer 10ms
      setTimeout(() => {
        target.classList.add('is-hit');
        const burst = document.createElement('div');
        burst.className = 'tcg-aoe-burst';
        burst.textContent = '✦';
        burst.style.left = (tr.left + tr.width  / 2) + 'px';
        burst.style.top  = (tr.top  + tr.height / 2) + 'px';
        document.body.appendChild(burst);
        if(proj.parentNode) proj.parentNode.removeChild(proj);

        // 자가 정리 (await 안 함 — 다음 이벤트 즉시 진행)
        setTimeout(() => {
          target.classList.remove('is-hit');
          if(burst.parentNode) burst.parentNode.removeChild(burst);
        }, 600);

        resolve();
      }, 510);
    });
  }

  function _animDamage(ev){
    return new Promise(resolve => {
      // 2026-05-24 — rect fallback 추가: cleanup 후 unitEl null 이어도 ev.rect 사용해 popup 발현.
      //   사용자 mental model "피해수치 에니메이션 → 숫자달라짐 → 사망" 흐름 정합.
      let tr = null;
      const target = document.querySelector('[data-uid="' + ev.targetUid + '"]');
      if(target){
        const r = target.getBoundingClientRect();
        if(r.width > 0) tr = r;
      }
      if(!tr && ev.rect && ev.rect.width > 0){
        tr = ev.rect;  // cleanup 후 fallback
      }
      if(!tr){ resolve(); return; }

      /* diagnosis-confirmed: 2026-06-05 사유: feature — 암흑 DOT popup 보라 색 + 카드 프레임 보라 글로우 펄스 (v2 시안 컨펌) */
      const pop = document.createElement('div');
      pop.className = 'tcg-dmg-popup' + (ev.dotElement === 'dark' ? ' tcg-dmg-dark' : '');
      pop.textContent = '-' + (ev.amount || 0);
      pop.style.left = (tr.left + tr.width / 2) + 'px';
      pop.style.top  = (tr.top  + 20) + 'px';
      document.body.appendChild(pop);
      // 암흑 DOT 틱 — 대상 카드 프레임(.card-v4)에 보라 글로우 펄스 1회 (drop-shadow → 프레임 실루엣 따라감, box-shadow 사각형 금지)
      if(ev.dotElement === 'dark' && target){
        const cv4 = target.classList.contains('card-v4') ? target : target.querySelector('.card-v4');
        if(cv4){
          cv4.classList.remove('tcg-dark-dot-pulse'); void cv4.offsetWidth;
          cv4.classList.add('tcg-dark-dot-pulse');
          setTimeout(() => { cv4.classList.remove('tcg-dark-dot-pulse'); }, 1100);
        }
      }

      // 2026-05-24 cascade 룰 (battle_system_decisions.md 표준 cascade): 0.8s → 1.2s visible
      setTimeout(() => { if(pop.parentNode) pop.parentNode.removeChild(pop); }, 1200);

      // 2026-05-30 #36 B Step 2 — HP 숫자 stat-flash interpolation (사용자 mental model "HP 5→4→3 시각화").
      //   target unit 의 .hp-icon .num element 의 옛 HP 값을 잠시 보존 후 새 값으로 interpolation.
      //   코어 _damage 가 이미 curHP 차감했으니 ev.hpAfter + ev.amount 가 옛 값.
      //   stagger 200ms 사이 step-by-step 감소 visual.
      if(target){
        const hpNum = target.querySelector('.hp-icon .num');
        if(hpNum){
          const oldHP = (ev.hpAfter || 0) + (ev.amount || 0);
          const newHP = (ev.hpAfter || 0);
          if(oldHP > newHP){
            hpNum.textContent = String(oldHP);  // 잠시 옛 값 보존
            target.classList.add('is-hp-flashing');  // CSS 펄스 (선택)
            const diff = oldHP - newHP;
            const stepMs = Math.max(40, Math.min(120, 300 / Math.max(1, diff)));
            for(let i = 1; i <= diff; i++){
              setTimeout(() => {
                hpNum.textContent = String(oldHP - i);
              }, i * stepMs);
            }
            setTimeout(() => target.classList.remove('is-hp-flashing'), 600);
          }
        }
      }

      // 2026-05-30 #36 — stagger 200 → 500ms (사용자 mental model "피해수치 → HP 감소 → 사망" 사이 텀 확보).
      setTimeout(resolve, 500);
    });
  }

  function _animAoeBurst(ev){
    // 2026-05-17: sk_dragon_flame 은 전용 시네마틱 이펙트 (mockup/phase6_dragon_flame/v3_user_zone.html 정합)
    if(ev && ev.cardId === 'sk_dragon_flame') return _animDragonFlame(ev);
    return new Promise(resolve => {
      // 보드 중앙 큰 ✦ burst (광역 표현)
      const burst = document.createElement('div');
      burst.className = 'tcg-aoe-burst';
      burst.textContent = '✦';
      burst.style.left = (window.innerWidth  / 2) + 'px';
      burst.style.top  = (window.innerHeight / 2) + 'px';
      burst.style.fontSize = '90px';  // 광역은 더 크게
      document.body.appendChild(burst);

      // 각 타겟에 hit-shake stagger (50ms 간격)
      if(Array.isArray(ev.targetUids)){
        ev.targetUids.forEach((uid, i) => {
          setTimeout(() => {
            const t = document.querySelector('[data-uid="' + uid + '"]');
            if(t){
              t.classList.add('is-hit');
              setTimeout(() => t.classList.remove('is-hit'), 400);
            }
          }, 120 + i * 50);
        });
      }

      setTimeout(() => {
        if(burst.parentNode) burst.parentNode.removeChild(burst);
        resolve();
      }, 600);
    });
  }

  // === sk_dragon_flame 전용 시네마틱 이펙트 — 2026-05-17 사용자 시안 v3_user_zone.html 정합 ===
  // 좌표: zone editor 사용자 결정 (left:4 top:2 w:1275 h:462), enemy 발동 시 top +140
  // 흐름: 인트로 슬라이드 (500ms, frame 01) → sequence (18프레임, 11/12 반복 4장 peak) → 아웃트로 (500ms)
  // 2026-05-17 stuttering fix — background-image url swap 폐기 → 15개 img element 사전 생성 + opacity 토글
  //   (GPU layer 유지, 매 frame paint 비용 최소화)
  const _DF_PATH = 'img/ui/skill_anims/dragon_flame/';
  const _DF_FRAME_SEQUENCE = [2,3,4,5,6,7,8,9,10,11,12,11,12,11,12,13,14,15];
  const _DF_INTRO_MS = 500;
  const _DF_OUTRO_MS = 500;
  const _DF_FRAME_MS = 65;

  // 15장 img element 사전 생성 — 매 발동 시 새 element 생성 X. opacity 토글로 frame 진행.
  // src 가 같은 url 이라 브라우저 cache + GPU decoded layer 유지.
  // decode() 로 첫 발동 전 모두 디코딩 완료 보장.
  const _DF_IMGS = [];
  for(let i = 1; i <= 15; i++){
    const img = new Image();
    img.src = _DF_PATH + 'dragon_flame_' + String(i).padStart(2, '0') + '.webp';
    img.alt = '';
    img.style.cssText = 'position:absolute;left:0;top:0;width:100%;height:100%;object-fit:contain;object-position:right center;opacity:0;will-change:opacity;pointer-events:none;';
    if(img.decode) img.decode().catch(()=>{});  // 첫 발동 끊김 0
    _DF_IMGS.push(img);
  }

  function _animDragonFlame(ev){
    return new Promise(resolve => {
      const screen = document.getElementById('tcg-screen');
      if(!screen){ resolve(); return; }
      const targetSide = ev.targetSide || 'enemy';
      const sourceSide = (targetSide === 'enemy') ? 'player' : 'enemy';
      const sideClass = (sourceSide === 'player') ? 'side-player' : 'side-enemy';

      // overlay = transform 가능한 wrapper. 그 안에 15장 img element 모두 append.
      const overlay = document.createElement('div');
      overlay.className = 'tcg-dragon-flame-overlay ' + sideClass;
      // 15장 img 를 overlay 에 attach (한 발동에 한 set 만, 끝나면 detach)
      _DF_IMGS.forEach(img => {
        img.style.opacity = '0';
        overlay.appendChild(img);
      });
      screen.appendChild(overlay);
      overlay.classList.add('active');

      // 1번 프레임 즉시 보임 (opacity 1) + overlay 전체를 우측 화면 밖으로
      _DF_IMGS[0].style.opacity = '1';
      overlay.style.transition = 'none';
      overlay.style.transform = 'translateX(100%)';
      void overlay.offsetWidth;  // force reflow
      overlay.style.transition = 'transform ' + _DF_INTRO_MS + 'ms ease-out';
      overlay.style.transform = 'translateX(0)';

      // 인트로 끝 → sequence (opacity 토글)
      setTimeout(() => {
        let idx = 0;
        let prevFrameNum = 1;  // 인트로 끝난 시점 = frame 01 보임
        const tick = () => {
          if(idx >= _DF_FRAME_SEQUENCE.length){
            // 아웃트로: 현재 표시된 마지막 프레임 유지하면서 overlay 우측 밖
            overlay.style.transition = 'transform ' + _DF_OUTRO_MS + 'ms ease-in';
            overlay.style.transform = 'translateX(100%)';
            setTimeout(() => {
              // 사용된 img element 들 모두 opacity 0 + detach
              _DF_IMGS.forEach(img => {
                img.style.opacity = '0';
                if(img.parentNode) img.parentNode.removeChild(img);
              });
              if(overlay.parentNode) overlay.parentNode.removeChild(overlay);
              // burn 잔여 — 피격 타겟에 .tcg-df-charred 부여
              if(Array.isArray(ev.targetUids)){
                ev.targetUids.forEach(uid => {
                  const t = document.querySelector('[data-uid="' + uid + '"]');
                  if(t){
                    t.classList.add('tcg-df-charred');
                    setTimeout(() => t.classList.remove('tcg-df-charred'), 2500);
                  }
                });
              }
              resolve();
            }, _DF_OUTRO_MS);
            return;
          }
          const frameNum = _DF_FRAME_SEQUENCE[idx];
          // 8번 프레임 = 화염 최대 분출 시점 → 피격 타겟 hit flash + shake
          // 2026-05-17 — board unit + hero 둘 다 hit flash. ev.targetUids 가 board 만 담아도
          // hero uid 를 state 에서 추가 검색 (sk_dragon_flame 처럼 enemy_all_incl_hero 인 경우 필요).
          if(frameNum === 8){
            const hitUids = (Array.isArray(ev.targetUids) ? ev.targetUids.slice() : []);
            // 시전자 진영의 반대 = 피격 진영. hero uid 추가.
            const targetSideObj = Match.state && Match.state[ev.targetSide || 'enemy'];
            if(targetSideObj && targetSideObj.hero && !targetSideObj.hero.isDead && targetSideObj.hero.uid){
              if(!hitUids.includes(targetSideObj.hero.uid)) hitUids.push(targetSideObj.hero.uid);
            }
            hitUids.forEach((uid, i) => {
              setTimeout(() => {
                const t = document.querySelector('[data-uid="' + uid + '"]');
                if(t){
                  t.classList.add('tcg-df-hit');
                  setTimeout(() => t.classList.remove('tcg-df-hit'), 400);
                }
              }, i * 40);
            });
          }
          // opacity 토글 (url swap X)
          if(prevFrameNum !== frameNum) _DF_IMGS[prevFrameNum - 1].style.opacity = '0';
          _DF_IMGS[frameNum - 1].style.opacity = '1';
          prevFrameNum = frameNum;
          idx++;
          setTimeout(tick, _DF_FRAME_MS);
        };
        tick();
      }, _DF_INTRO_MS);
    });
  }

  // ───── Phase 1A.5 — 동료 사망 → 다음 내턴 시작 부서짐 + 소환/사망 이펙트 — 2026-05-07 ─────

  function _showToast(msg, ms){
    ms = ms || 2600;
    const t = document.createElement('div');
    t.className = 'tcg-toast';
    t.textContent = msg;
    document.body.appendChild(t);
    setTimeout(() => { if(t.parentNode) t.parentNode.removeChild(t); }, ms);
    return t;
  }

  // ───── 전투 내레이션 + 페이싱 (2026-06-14 사용자 컨펌 적용 — design/battle_narration_design.md) ─────
  /* diagnosis-confirmed: 2026-06-14 사유: feature — 전투 가독성. 적 행동(카드 사용/유닛 공격)을 중앙 배너 토스트로
     내레이션 + 속도 조절(_speedMult, _processEvents 텀 배수). 사용자 요구 "게임 너무 빠름, NPC 카드/턴 설명".
     갤러리 mockup/battle_narration 컨펌(토스트 A 중앙배너 + 좌측 cast 카드 공존 + 속도버튼 🐢▶⏩). 1단계(토스트+속도).
     기존 _showToast(중앙 fixed) 패턴 재사용(자작 회피). turn-side 는 기존 banner 유지(중복 회피). 버그픽스 아님. */
  let _speedMult = (function(){ try { const v = parseFloat(localStorage.getItem('rof8_battle_speed')); return (v===0.6||v===1||v===1.7) ? v : 1.7; } catch(e){ return 1.7; } })();
  function _toastDur(){ return Math.round(1500 * _speedMult); }
  function _setSpeed(mult){
    _speedMult = mult;
    try { localStorage.setItem('rof8_battle_speed', String(mult)); } catch(e){}
    const bar = document.getElementById('tcg-speed-ctrl');
    if(bar) bar.querySelectorAll('.tcg-speed-btn').forEach(b => b.classList.toggle('active', parseFloat(b.dataset.mult) === mult));
  }
  // 속도 조절 버튼 (우상단) — renderState 가 1회 생성(idempotent). index.html 안 건드림.
  function _ensureSpeedControl(){
    const screen = document.getElementById('tcg-screen');
    if(!screen || document.getElementById('tcg-speed-ctrl')) return;
    const bar = document.createElement('div');
    bar.id = 'tcg-speed-ctrl'; bar.className = 'tcg-speed-ctrl';
    const opts = [['🐢',1.7,'느리게'],['▶',1,'보통'],['⏩',0.6,'빠르게']];
    bar.innerHTML = opts.map(o =>
      '<button type="button" class="tcg-speed-btn'+(o[1]===_speedMult?' active':'')+'" data-mult="'+o[1]+'" title="'+o[2]+'">'+o[0]+'</button>'
    ).join('');
    bar.addEventListener('click', e => { const b = e.target.closest('.tcg-speed-btn'); if(b) _setSpeed(parseFloat(b.getAttribute('data-mult'))); });
    screen.appendChild(bar);
  }
  // uid → 표시 이름 (양측 보드/영웅 조회)
  function _uidName(uid){
    const st = Match.state; if(!st || !uid) return '유닛';
    for(const sk of ['player','enemy']){
      const s = st[sk]; if(!s) continue;
      if(s.hero && s.hero.uid === uid) return s.hero.name || '영웅';
      const u = (s.board||[]).find(x => x && x.uid === uid);
      if(u) return u.name || '유닛';
    }
    return '유닛';
  }
  // 중앙 배너 내레이션 (싱글톤 — 새 사건이 기존 교체. 갤러리 A 스타일)
  function _showNarration(title, desc){
    const old = document.getElementById('tcg-battle-narration');
    if(old && old.parentNode) old.parentNode.removeChild(old);
    const esc = s => String(s==null?'':s).replace(/[&<>]/g, m=>({'&':'&amp;','<':'&lt;','>':'&gt;'}[m]));
    const t = document.createElement('div');
    t.id = 'tcg-battle-narration'; t.className = 'tcg-battle-narration';
    t.innerHTML = '<div class="bn-band"><div class="bn-ttl">'+esc(title)+'</div>'+(desc?'<div class="bn-desc">'+esc(desc)+'</div>':'')+'</div>';
    /* diagnosis-confirmed: 2026-06-14 사유: feature — 토스트를 #tcg-screen(game-root 안)에 append → position:fixed 가 game-root(transform 조상) 기준이 되어 보드와 동일 좌표계. body append(viewport 기준)면 scale 화면에서 보드 사이 좌표 어긋남(Playwright 실측). 보드 사이 배치(사용자 요청 C) 정합. */
    (document.getElementById('tcg-screen') || document.body).appendChild(t);
    requestAnimationFrame(()=>t.classList.add('show'));
    setTimeout(()=>{ t.classList.remove('show'); setTimeout(()=>{ if(t.parentNode) t.parentNode.removeChild(t); }, 250); }, _toastDur());
    return t;
  }
  // 적 사건 → 내레이션 (카드 사용 / 유닛 공격). turn-side 는 기존 banner 유지.
  function _narrateEvent(ev){
    if(!ev) return;
    if(ev.type === 'card-cast-left' && ev.side === 'enemy'){
      _showNarration('적이 ' + ((ev.card && ev.card.name) || '카드') + ' 발동', '');
    } else if(ev.type === 'unit-attack' && ev.attackerSide === 'enemy'){
      _showNarration('적 ' + _uidName(ev.attackerUid) + '의 공격', '');  /* diagnosis-confirmed: 2026-06-14 사유: feature — 조사 띄어쓰기 폴리시 */
    }
  }

  // ───── 전투 로그 패널 (2026-06-14 내레이션 2단계 — design/battle_narration_design.md) ─────
  /* diagnosis-confirmed: 2026-06-14 사유: feature — 영구 전투 기록 패널. 1단계 토스트는 순간(_showNarration), 로그는 영구.
     _playEvent 와 동일 ev 소스를 hook → 토스트=로그 일관성. 우측 배치(N/6 트레이 좌측 충돌 회피). 평소 한 줄 + 호버 펼침
     (갤러리 mockup/battle_narration 컨펌). card-cast-left/unit-attack/damage/round-start 만 줄로(telemetry 노이즈 제외).
     unit-attack 줄에 직후 damage 의 −N 결합("적 그리핀 → 영웅 −2"). 코어 변경 0. 버그픽스 아님. */
  let _logPendingAtk = null;  // {targetUid, el} — unit-attack 줄에 직후 damage(−N) 결합용
  let _logSuppressDmgUid = null;  // 2026-06-16 — 근접반격 데미지 로그 중복 방지 (melee-reflect-dmgtype 가 전용 라인 출력, 직후 공격자 damage 1회 skip)
  function _sideLabel(side){ return side === 'enemy' ? '적' : '내'; }
  function _logEsc(s){ return String(s==null?'':s).replace(/[&<>]/g, m=>({'&':'&amp;','<':'&lt;','>':'&gt;'}[m])); }
  // 우측 로그 패널 — renderState 가 1회 생성(idempotent). index.html 안 건드림.
  function _ensureLogPanel(){
    const screen = document.getElementById('tcg-screen');
    if(!screen || document.getElementById('tcg-battle-log')) return;
    const box = document.createElement('div');
    box.id = 'tcg-battle-log'; box.className = 'tcg-battle-log';
    box.innerHTML = '<div class="tcg-log-bar">📜 <span class="tcg-log-latest">전투 기록</span><span class="tcg-log-hint">▾ 펼치기</span></div>'
                  + '<div class="tcg-log-drop"><div class="tcg-log-body" id="tcg-log-body"></div></div>';
    screen.appendChild(box);
  }
  function _logResetPanel(){
    const body = document.getElementById('tcg-log-body'); if(body) body.innerHTML = '';
    _logPendingAtk = null;
    const latest = document.querySelector('#tcg-battle-log .tcg-log-latest'); if(latest) latest.textContent = '전투 기록';
  }
  function _logBarLatest(text){ const l = document.querySelector('#tcg-battle-log .tcg-log-latest'); if(l) l.textContent = text; }
  function _logAddLine(html, cls){
    const body = document.getElementById('tcg-log-body'); if(!body) return null;
    const line = document.createElement('div');
    line.className = 'tcg-logline' + (cls ? ' ' + cls : '');
    line.innerHTML = html;
    body.appendChild(line);
    while(body.children.length > 60) body.removeChild(body.firstChild);  // 최근 60줄 유지
    body.scrollTop = body.scrollHeight;
    _logBarLatest(line.textContent);
    return line;
  }
  // ev → 로그 줄 (양측 전부 기록). _playEvent 진입부에서 호출.
  function _logEvent(ev){
    if(!ev || !ev.type) return;
    switch(ev.type){
      case 'round-start':
        if((ev.round | 0) <= 1) _logResetPanel();  // 매치 첫 라운드 = 새 전투 → 초기화
        _logAddLine('⟡ 제 ' + (ev.round | 0) + ' 라운드', 'round');
        _logPendingAtk = null;
        _logSuppressDmgUid = null;
        break;
      case 'card-cast-left': {
        const nm = (ev.card && ev.card.name) || '카드';
        _logAddLine(_sideLabel(ev.side) + ' <b>' + _logEsc(nm) + '</b> 발동', ev.side === 'enemy' ? 'enemy' : 'player');
        _logPendingAtk = null;
        break;
      }
      case 'unit-attack': {
        const line = _logAddLine(_sideLabel(ev.attackerSide) + ' ' + _logEsc(_uidName(ev.attackerUid)) + ' → ' + _logEsc(_uidName(ev.targetUid)),
          ev.attackerSide === 'enemy' ? 'enemy' : 'player');
        _logPendingAtk = line ? {targetUid: ev.targetUid, el: line} : null;
        break;
      }
      case 'damage': {
        const amt = ev.amount | 0; if(amt <= 0) break;
        if(_logSuppressDmgUid && _logSuppressDmgUid === ev.targetUid){ _logSuppressDmgUid = null; break; }  // 반격 데미지 = 전용 라인이 이미 출력 (중복 방지)
        if(_logPendingAtk && _logPendingAtk.targetUid === ev.targetUid && _logPendingAtk.el){
          _logPendingAtk.el.innerHTML += ' <span class="neg">−' + amt + '</span>';  // 직전 공격 줄에 결합
          _logBarLatest(_logPendingAtk.el.textContent);
          _logPendingAtk = null;
        } else {
          _logAddLine(_logEsc(_uidName(ev.targetUid)) + ' <span class="neg">−' + amt + '</span>');  // 스펠/독립 피해
        }
        break;
      }
      case 'melee-reflect-dmgtype': {  // 2026-06-16 — 근접반격 전용 로그 라인 (P0 #2)
        const amt = ev.amount | 0;
        _logAddLine('⚔ 근접 반격 ' + _logEsc(_uidName(ev.fromUid)) + ' → ' + _logEsc(_uidName(ev.toUid)) + ' <span class="neg">−' + amt + '</span>', 'reflect');
        _logSuppressDmgUid = ev.toUid;  // 직후 공격자 damage 로그 1회 skip
        break;
      }
    }
  }

  function _animUnitSummon(ev){
    /* diagnosis-confirmed: 2026-05-31 보드 배치 soft 드롭+글로우 링 (시안 컨펌, bug fix 아님) */
    return new Promise(resolve => {
      const apply = (el) => {
        el.classList.add('is-spawning');
        // 은은한 소환 글로우 링 (CSS tcgSummonRingSoft, 0.6s 후 자동 제거)
        const ring = document.createElement('div');
        ring.className = 'tcg-summon-ring';
        el.appendChild(ring);
        setTimeout(() => {
          el.classList.remove('is-spawning');
          if(ring.parentNode) ring.parentNode.removeChild(ring);
          resolve();
        }, 640);
      };
      const sel = '.match-card[data-uid="' + ev.uid + '"]';
      // 신규 유닛 카드를 renderState 가 DOM 에 추가했는지 — 못 찾으면 다음 프레임 재시도(렌더 순서 보장).
      let el = document.querySelector(sel);
      if(el){ apply(el); return; }
      requestAnimationFrame(() => {
        el = document.querySelector(sel);
        if(el){ apply(el); return; }
        // 한 번 더 (renderState 지연 대비)
        setTimeout(() => { const e2 = document.querySelector(sel); if(e2) apply(e2); else resolve(); }, 50);
      });
    });
  }

  function _animUnitDeath(ev){
    // 2026-05-09 본격 구현 — burst 이펙트 + Cinzel 토스트.
    // Plan 2.A Task A.5 (2026-05-10) 보강 — v1 시안 페이드 ghost 카드 (cloneNode → body fixed + .is-dying).
    // 코어 _cleanupBoard 직후 renderState 가 boardRow innerHTML='' 해도 ghost 는 body 자식이라 살아남음.
    // 동료 사망의 부서짐 시퀀스는 _animPendingDisintegrate 가 별도 처리 (즉시 부서짐 → events 즉시 push).
    return new Promise(resolve => {
      if(!ev || !ev.unitId){ resolve(); return; }

      // 2026-05-24 race condition fix: spell-aoe (_animDragonFlame 3s) > _cleanupBoard (1.5s) 시점에 unit DOM 사라짐.
      //   → unitEl null 시 ev.rect 캐시 + ev.cardData 로 mkMatchCard ghost 재구성 (5/17 의도된 fallback 강화).
      //   진단 흐름: 1) DOM 직접 query (cleanup 전 시도), 2) ev.rect + ev.cardData 으로 mkMatchCard ghost (cleanup 후 fallback).
      const sideKey = ev.side === 'enemy' ? 'enemy' : 'player';
      const boardRow = document.getElementById(sideKey === 'enemy' ? 'tcg-e-board' : 'tcg-p-board');
      let unitEl = null;
      if(ev.targetUid && boardRow){
        unitEl = boardRow.querySelector('[data-uid="' + ev.targetUid + '"]');
      }
      let cx, cy;

      // ghost 부착 — 3 단계 fallback
      let ghostRect = null;
      if(unitEl){
        // (A) DOM 직접 cloneNode (cleanup 전 시점)
        const r = unitEl.getBoundingClientRect();
        ghostRect = { left: r.left, top: r.top, width: r.width, height: r.height };
        cx = r.left + r.width  / 2;
        cy = r.top  + r.height / 2;

        const ghost = unitEl.cloneNode(true);
        ghost.style.position      = 'fixed';
        ghost.style.left          = r.left + 'px';
        ghost.style.top           = r.top  + 'px';
        ghost.style.width         = r.width  + 'px';
        ghost.style.height        = r.height + 'px';
        ghost.style.margin        = '0';
        ghost.style.pointerEvents = 'none';
        ghost.style.zIndex        = '1400';
        ghost.classList.add('is-dying');
        ghost.classList.remove('is-attacker-active', 'is-target-valid', 'is-hover', 'is-casting');
        const innerCard = ghost.classList.contains('match-card') ? ghost : ghost.querySelector('.match-card');
        if(innerCard && innerCard !== ghost) innerCard.classList.add('is-dying');
        // 2026-05-24 V2 — 깨짐 overlay (사용자 갤러리 V2 컨펌 mockup/unit_death_anim_v2/)
        const crack = document.createElement('div');
        crack.className = 'tcg-crack-overlay';
        (innerCard || ghost).appendChild(crack);
        document.body.appendChild(ghost);
        // 2026-05-25 사용자 보고 fix (옵션 A): ghost 부착 직후 보드 unit 자체 visibility hidden →
        //   "보드 unit 먼저 사라지고 사망 visual 뒤늦게" race 해소. cleanup 발생해도 visual 영향 0 (이미 hidden).
        //   ghost 가 보드 자리에 fade — 사용자 인지 "사망 visual 끝나면 자리 비움" 자연.
        unitEl.style.visibility = 'hidden';
        setTimeout(() => { if(ghost.parentNode) ghost.parentNode.removeChild(ghost); }, 1850);
      } else if(ev.rect && ev.cardData && typeof mkMatchCard === 'function'){
        // (B) cleanup 후 fallback — ev.rect + ev.cardData 으로 mkMatchCard ghost 재구성
        const r = ev.rect;
        ghostRect = r;
        cx = r.left + r.width  / 2;
        cy = r.top  + r.height / 2;

        try {
          const ghost = mkMatchCard(ev.cardData, { boardUnit: true });
          ghost.style.position      = 'fixed';
          ghost.style.left          = r.left + 'px';
          ghost.style.top           = r.top  + 'px';
          ghost.style.width         = r.width  + 'px';
          ghost.style.height        = r.height + 'px';
          ghost.style.margin        = '0';
          ghost.style.pointerEvents = 'none';
          ghost.style.zIndex        = '1400';
          ghost.classList.add('is-dying');
          // V2 깨짐 overlay (fallback 도)
          const crack = document.createElement('div');
          crack.className = 'tcg-crack-overlay';
          ghost.appendChild(crack);
          document.body.appendChild(ghost);
          setTimeout(() => { if(ghost.parentNode) ghost.parentNode.removeChild(ghost); }, 1850);
        } catch(e){ console.warn('[unit-death] mkMatchCard ghost fail:', e); }
      } else if(boardRow){
        // (C) 최종 fallback — boardRow 중앙 (rect/cardData 없는 옛 이벤트)
        const rect = boardRow.getBoundingClientRect();
        cx = rect.left + rect.width  / 2;
        cy = rect.top  + rect.height / 2;
      } else {
        cx = (window.innerWidth  || 1280) / 2;
        cy = (window.innerHeight ||  720) / 2;
      }

      // burst spawn
      const burst = document.createElement('div');
      burst.className = 'tcg-death-burst';
      burst.style.left = cx + 'px';
      burst.style.top  = cy + 'px';
      document.body.appendChild(burst);
      setTimeout(() => { if(burst.parentNode) burst.parentNode.removeChild(burst); }, 720);

      // 토스트 narrative — 짧게 (companion 의 부서짐 toast 와 시간 차)
      if(ev.unitName){
        const sideText = sideKey === 'enemy' ? '적의 ' : '';
        _showToast('✧ ' + sideText + ev.unitName + ' 이(가) 쓰러졌다 ✧', 1400);
      }

      // 2026-05-25 사용자 보고 fix — 영웅 사망 시 ghost 페이드 끝 (1850ms) 까지 resolve 미룸.
      //   "보드 영웅 사망 에니메이션 끝 → 패배 banner" 자연 cascade.
      //   옛 600ms = match-end-banner 가 영웅 ghost 페이드 중에 등장 → 사용자 "0 되자마자 패배" 인지.
      const isHeroDeath = !!(ev.cardData && (ev.cardData.kind === 'hero' || ev.cardData._isHero));
      setTimeout(resolve, isHeroDeath ? 1850 : 600);
    });
  }

  function _animPendingDisintegrate(ev){
    return new Promise(resolve => {
      const snapshot = Array.isArray(ev.removedSnapshot) ? ev.removedSnapshot : [];
      const isPlayer = ev.side === 'player';
      const sidePrefix = isPlayer ? '' : '적의 ';
      const cardCount = ev.totalCount || snapshot.length;
      const staggerMs = 160;

      // 손패 카드 (handIdx >= 0) 만 시각 부서짐 — 덱 카드는 안 보이는 자리라 silent
      const handCards = snapshot.filter(s => !s.inDeck && s.card);

      handCards.forEach((info, i) => {
        setTimeout(() => {
          const slot = document.getElementById('tcg-hand-' + ((info.handIdx || 0) + 1));
          if(!slot) return;
          const slotRect = slot.getBoundingClientRect();
          if(slotRect.width === 0) return;

          // viewport boundary clamp — scale(1.5) 시각 영역이 화면 밖으로 잘리지 않도록.
          // transform-origin: center 기준이라 좌우/상하 0.25*size 씩 확장됨.
          const scale = 1.5;
          const dx = slotRect.width  * (scale - 1) / 2;
          const dy = slotRect.height * (scale - 1) / 2;
          const vw = window.innerWidth  || document.documentElement.clientWidth;
          const vh = window.innerHeight || document.documentElement.clientHeight;
          const left = Math.max(dx, Math.min(vw - slotRect.width  - dx, slotRect.left));
          const top  = Math.max(dy, Math.min(vh - slotRect.height - dy, slotRect.top));

          const ghost = mkMatchCard(info.card);
          ghost.classList.add('tcg-card-ghost');
          ghost.style.left      = left + 'px';
          ghost.style.top       = top  + 'px';
          ghost.style.width     = slotRect.width  + 'px';
          ghost.style.height    = slotRect.height + 'px';
          // 초기 scale 인라인 적용 — animation 미발화 시에도 슬롯 카드와 시각 분리
          ghost.style.transform = 'scale(' + scale + ')';
          document.body.appendChild(ghost);

          // RAF 안 함 — 헤드리스 환경에서 RAF 지연으로 클래스 미적용 사고 (1A.5 검수 BLOCKER 1).
          // animation 은 class 적용 즉시 시작 (transition 과 달리 initial state commit 불필요).
          ghost.classList.add('is-shattering');

          setTimeout(() => {
            if(ghost.parentNode) ghost.parentNode.removeChild(ghost);
          }, 720);
        }, i * staggerMs);
      });

      // 토스트 narrative — 부서짐 stagger 중간쯤 등장
      const toastDelay = Math.max(handCards.length, 1) * staggerMs / 2;
      setTimeout(() => {
        _showToast(
          '✦ ' + sidePrefix + (ev.unitName || '동료') + '의 영혼이 흩어진다. ' +
          cardCount + '장의 운명이 사라졌다. ✦',
          3000
        );
      }, toastDelay);

      // 총 진행 시간 = stagger 끝 + shatter 720ms (최소 1000ms)
      const totalMs = Math.max(handCards.length * staggerMs + 720, 1000);
      setTimeout(resolve, totalMs);
    });
  }

  // 단일 이벤트 재생 — Promise resolve 시 다음 이벤트 진행.
  // 1A.4 (카드 운명 3) + 1A.4.5 (발사체/데미지/광역 3) + 1A.5 (소환/사망/부서짐 3) = 9 활성.
  UI._playEvent = function(ev){
    if(!ev || !ev.type) return Promise.resolve();
    /* diagnosis-confirmed: 2026-06-14 사유: feature — 적 사건 내레이션 토스트 + 영구 로그 hook (design/battle_narration_design.md). */
    _narrateEvent(ev);
    _logEvent(ev);
    switch(ev.type){
      case 'card-fly-to-center':         return _animFlyToCenter(ev);
      case 'card-shatter':               return _animShatter(ev);
      case 'card-return-to-deck':        return _animReturnToDeck(ev);
      case 'projectile':                 return _animProjectile(ev);
      case 'unit-attack':                return _animUnitAttack(ev);
      case 'damage':                     return _animDamage(ev);
      case 'melee-reflect-dmgtype':      return _animMeleeReflect(ev);
      case 'card-cast-left':             { UI._showLeftCast(ev.card); return Promise.resolve(); }
      case 'coin-flip':                  return _animCoinFlip(ev);
      case 'round-start':                return _animRoundStart(ev);
      case 'card-phase-start':           return _animPhaseStart('card');
      case 'board-phase-start':          return _animPhaseStart('board');
      case 'turn-side-change':           return _animTurnSideChange(ev);
      case 'aoe-burst':                  return _animAoeBurst(ev);
      case 'unit-summon':                return _animUnitSummon(ev);
      case 'unit-death':                 return _animUnitDeath(ev);
      case 'pending-disintegrate-trigger': return _animPendingDisintegrate(ev);
      case 'round-hand-draw':            return _animRoundHandDraw(ev);
      case 'hero-levelup':               return _animLevelupPopup(ev, 'hero');
      case 'unit-levelup':               return _animLevelupPopup(ev, 'unit');
      case 'stat-flash':                 return _animStatFlash(ev);
      case 'soul-recharge-flash':        return _animSoulRechargeFlash(ev);
      /* diagnosis-confirmed: 2026-06-07 사유: feature — Scry(운명 정찰) 모달 (v4 하이브리드 시안 사용자 컨펌 "이걸로 적용"). scry-prompt 이벤트 → 모달 표시 → 선택 → Match._scry. mockup/scry/v4_hybrid.html */
      case 'scry-prompt':                return UI._renderScryModal(ev);
      // 2026-05-24 §영혼력 visual feedback 룰 — AI 카드 사용 시 enemy mana flash + -N popup
      case 'soul-consume':               return _animSoulConsume(ev);
      // 2026-05-24 §턴 개념 룰 — "내 턴" / "적 턴" Cinzel 한글 banner (HS 패턴)
      case 'turn-banner':                return _animTurnBanner(ev);
      // 2026-05-24 매치 종료 cascade (battle_system_decisions.md §매치 종료 cascade LoR 식 V2)
      case 'match-end-banner':           return _animMatchEndBanner(ev);
      case 'reward-preview':             return _animRewardPreview(ev);
      case 'continue-button':            return _animContinueButton(ev);
      // 2026-05-24 매치 시작 cinematic (V2 갤러리 사용자 컨펌 mockup/match_start_cinematic/)
      //   battle_system_decisions.md §매치 시작 cinematic 표준 룰 / feature_manifest 3.17
      case 'match-start-cinematic':      return _animMatchStartCinematic(ev);
      default:
        return Promise.resolve();
    }
  };

  // ───── 2026-05-24 매치 시작 cinematic (V2 갤러리 사용자 컨펌) ─────
  //   battle_system_decisions.md §매치 시작 cinematic 표준 룰
  //   gallery: mockup/match_start_cinematic/index.html V2
  //   사용자 명시: "아군 먼저 그담에 적영웅 sequential" + "빛 폭발 제대로 구현, 깃허브에서 효과 찾아도 됨"
  //   시퀀스 (합 ~3.3s):
  //     t=0    dim show + #tcg-board-outer 보드 zoom in (scale 1.1→1.65) — 500ms
  //     t=500  아군 영웅 .is-cinematic-spawn (mc-cinematic-spawn 1.2s + burst-core + glow-halo + 8 particles)
  //     t=1100 적 영웅 .is-cinematic-spawn (sequential, +600ms gap)
  //     t=2300 양측 spawn 끝 + 300ms static hold
  //     t=2600 zoom out + dim 해제 — 500ms
  //     t=3100 class cleanup + resolve → _beginRound(1) push event 진입
  function _animMatchStartCinematic(ev){
    return new Promise(resolve => {
      const dim = document.getElementById('tcg-cinematic-dim');
      // 2026-05-24 옵션 D1 fallback — zoom 폐기. .tcg-board-outer / .tcg-board-row 모두
      //   transform stuck (4 시도 진단 한계). 영웅 spawn 의 scale(1.6→1) 효과 + dim + particles
      //   로 V2 시각 핵심 보존.
      const heroP = document.getElementById('tcg-p-hero');
      const heroE = document.getElementById('tcg-e-hero');
      // DOM 없으면 즉시 skip (회귀 환경 / file:// fallback). _beginRound 진행 영향 X.
      if(!heroP || !heroE){ resolve(); return; }

      // 진입 시 cinematic flag ON — renderState 차단 (clear 후 resolve 시 OFF)
      Match._cinematicActive = true;

      // 8 particle wrapper 주입 (없으면 추가, 재진입 idempotent)
      function ensureParticles(cell){
        if(cell.querySelector('.tcg-cinematic-particles')) return;
        const wrap = document.createElement('div');
        wrap.className = 'tcg-cinematic-particles';
        for(let i = 0; i < 8; i++) wrap.appendChild(document.createElement('span'));
        cell.appendChild(wrap);
      }
      ensureParticles(heroP);
      ensureParticles(heroE);

      // class cleanup (이전 매치 잔존 클리어 — idempotent 보장)
      heroP.classList.remove('is-cinematic-spawn');
      heroE.classList.remove('is-cinematic-spawn');
      if(dim) dim.classList.remove('is-show');

      // 1. dim (t=0 ~ 500ms) — zoom 폐기 (옵션 D1), dim 만 발현
      if(dim) dim.classList.add('is-show');

      // 2. 아군 영웅 spawn (t=500ms ~ 1700ms)
      const tP = setTimeout(() => {
        void heroP.offsetWidth;
        heroP.classList.add('is-cinematic-spawn');
      }, 500);

      // 3. 적 영웅 spawn (t=1100ms ~ 2300ms, sequential gap 600ms)
      const tE = setTimeout(() => {
        void heroE.offsetWidth;
        heroE.classList.add('is-cinematic-spawn');
      }, 1100);

      // 4. dim 해제 (t=2600ms) — zoom 폐기 (옵션 D1) 이라 dim 만 cleanup
      const tOut = setTimeout(() => {
        if(dim) dim.classList.remove('is-show');
      }, 2600);

      // 5. cinematic 종료 (t=3100ms) — class cleanup + flag OFF + resolve
      //   spawn 클래스 cleanup 누락 시 라운드 2+ 에서 spawn 키프레임 재발현 가능 (feature_manifest 3.17 의심 패턴)
      setTimeout(() => {
        heroP.classList.remove('is-cinematic-spawn');
        heroE.classList.remove('is-cinematic-spawn');
        // .tcg-cinematic-particles wrapper 는 보존 (다음 매치 재사용, animation 만 restart)
        Match._cinematicActive = false;
        // cinematic 진행 중 차단됐던 renderState 보강 — 1회 정합 갱신
        try { UI.renderState(); } catch(e){}
        resolve();
      }, 3100);
    });
  }

  // 2026-05-24 매치 종료 cascade — LoR 식 V2 (mockup/match_end_cascade/ 사용자 컨펌)
  //   2단계 MATCH-END-BANNER: "승리" / "패배" / "무승부" 2s cinematic
  function _animMatchEndBanner(ev){
    return new Promise(resolve => {
      const banner = document.getElementById('tcg-match-end-banner');
      const fade   = document.getElementById('tcg-screen-fade');
      if(!banner){ resolve(); return; }
      // 화면 회색 fade (V2 강조)
      if(fade) fade.classList.add('is-show');
      // 텍스트 + 색 클래스 (winner 별)
      const winner = ev.winner;
      let text = '무승부', cls = 'is-draw';
      if(winner === 'player'){ text = '승리'; cls = 'is-victory'; }
      else if(winner === 'enemy'){ text = '패배'; cls = 'is-defeat'; }
      banner.textContent = text;
      banner.classList.remove('is-victory', 'is-defeat', 'is-draw', 'is-show');
      void banner.offsetWidth;  // force reflow
      banner.classList.add(cls, 'is-show');
      setTimeout(resolve, 2000);  // banner animation 2s
    });
  }

  //   3단계 REWARD-PREVIEW: 보상 카드 reveal 3s (LoR 핵심)
  function _animRewardPreview(ev){
    return new Promise(resolve => {
      const preview = document.getElementById('tcg-reward-preview');
      if(!preview){ resolve(); return; }
      preview.classList.remove('is-show');
      void preview.offsetWidth;
      preview.classList.add('is-show');
      setTimeout(resolve, 3000);
    });
  }

  //   4단계 CONTINUE-BUTTON: 사용자 클릭 대기 → showReward 진입
  //   continue-button event 자체는 즉시 resolve (UI 가 버튼 활성화만, 진입은 사용자 클릭)
  function _animContinueButton(ev){
    return new Promise(resolve => {
      const btn = document.getElementById('tcg-continue-button');
      if(!btn){ resolve(); return; }
      btn.classList.add('is-active');
      // 클릭 핸들러 (1회) — showReward 진입
      const onClick = () => {
        btn.removeEventListener('click', onClick);
        btn.classList.remove('is-active');
        // 화면 fade + banner + preview cleanup
        const fade = document.getElementById('tcg-screen-fade');
        if(fade) fade.classList.remove('is-show');
        // showReward 진입
        if(typeof RoF !== 'undefined' && RoF.Game && typeof RoF.Game.showReward === 'function'){
          RoF.Game.showReward(ev.winner);
        }
      };
      btn.addEventListener('click', onClick);
      resolve();  // event 처리는 즉시 끝 (버튼 활성화만)
    });
  }

  // 2026-05-24 §턴 개념 룰 — "내 턴" / "적 턴" Cinzel 한글 banner (HS 패턴).
  //   battle_system_decisions.md §턴 개념 + mana 충전 시점 룰 (C Hybrid).
  //   _showBigBanner 활용 — 1.5s 큰 텍스트. player=황금, enemy=빨강 (is-enemy 클래스).
  function _animTurnBanner(ev){
    if(!ev || !ev.side) return Promise.resolve();
    const text = ev.side === 'player' ? '내 턴' : '적 턴';
    const isEnemy = ev.side === 'enemy';
    return _showBigBanner(text, null, isEnemy ? 'enemy' : null);
  }

  // 2026-05-24 §영혼력 visual feedback 룰 — AI 카드 사용 시 enemy mana flash + -N popup.
  //   battle_system_decisions.md §영혼력 visual feedback 룰 4단계.
  function _animSoulConsume(ev){
    return new Promise(resolve => {
      if(!ev || !ev.side || !ev.amount){ resolve(); return; }
      const manaEl = document.getElementById('tcg-mana-' + ev.side);
      if(!manaEl){ resolve(); return; }
      // mana 숫자 빨강 flash (.is-consuming 클래스)
      manaEl.classList.remove('is-consuming');
      void manaEl.offsetWidth;  // force reflow
      manaEl.classList.add('is-consuming');
      setTimeout(() => manaEl.classList.remove('is-consuming'), 500);
      // -N 빨간 popup at mana 위
      const rect = manaEl.getBoundingClientRect();
      const pop = document.createElement('div');
      pop.className = 'tcg-soul-consume-popup';
      pop.textContent = '-' + ev.amount;
      pop.style.left = (rect.left + rect.width / 2) + 'px';
      pop.style.top  = (rect.top - 10) + 'px';
      document.body.appendChild(pop);
      setTimeout(() => { if(pop.parentNode) pop.parentNode.removeChild(pop); }, 1000);
      // 100ms stagger (다음 event 사이 짧은 텀)
      setTimeout(resolve, 100);
    });
  }

  // 2026-05-17 #11 — 영혼력 +N floater (사용자 컨펌 갤러리 v1).
  // 매 라운드 시작 시 마나 크리스탈 위에 +N 텍스트 1.8초 떠올라 fade out.
  // 코어 _beginRound 가 events.push({type:'soul-recharge-flash', side, amount}) → UI 처리.
  function _animSoulRechargeFlash(ev){
    // 2026-05-17 fix — fire-and-forget. 옛 1800ms await 가 양측 합쳐 3.6초 추가 → banner 늦음 (사용자 "3.5초 후 banner").
    // floater visual 은 background 로 1.8s 유지 후 자동 제거. 다음 event (banner / swoop) 는 즉시 진행.
    if(!ev || !ev.side || !ev.amount) return Promise.resolve();
    const manaEl = document.getElementById('tcg-mana-' + ev.side);
    if(!manaEl) return Promise.resolve();
    const floater = document.createElement('div');
    floater.className = 'tcg-soul-floater';
    floater.textContent = '+' + ev.amount;
    manaEl.appendChild(floater);
    setTimeout(() => { if(floater.parentNode) floater.parentNode.removeChild(floater); }, 1800);
    return Promise.resolve();
  }

  // 2026-05-17 #13 — 스킬 buff/nerf 시점 stat num flash (사용자 명시 "+증가 애니메이션 + 색상 변화")
  // 코어 attach_buff/debuff op 후 events.push({type:'stat-flash', targetUid, stat, direction}) 처리.
  // 영구 색은 이미 _buildCardEl 가 cur vs base 비교로 is-buffed/is-nerfed 자동 부여 (40_cards.js:550, 571).
  function _animStatFlash(ev){
    return new Promise(resolve => {
      if(!ev || !ev.targetUid){ resolve(); return; }
      // data-uid 는 wrap (card-v4 outer) 에 박힘 (40_cards.js line 106). 매 unit/hero 카드 동일.
      const cardEl = document.querySelector('.match-card[data-uid="' + ev.targetUid + '"]');
      if(!cardEl){ resolve(); return; }
      const iconSel = ev.stat === 'ATK' ? '.atk-icon .num' : ev.stat === 'HP' ? '.hp-icon .num' : null;
      if(!iconSel){ resolve(); return; }
      const numEl = cardEl.querySelector(iconSel);
      if(!numEl){ resolve(); return; }
      const cls = ev.direction === 'buff' ? 'is-flashing-buff' : 'is-flashing-nerf';
      numEl.classList.remove(cls);
      void numEl.offsetWidth;
      numEl.classList.add(cls);
      setTimeout(() => { numEl.classList.remove(cls); resolve(); }, 800);
    });
  }

  // 2026-05-17 — 매치 알림 banner (시안 v1 정본)
  // 큰 banner / 작은 banner / 동전 stage 의 element 는 index.html 에 static 위치.
  function _showBigBanner(title, sub, theme){
    const el = document.getElementById('tcg-banner-big');
    if(!el) return Promise.resolve();
    el.innerHTML = title + (sub ? '<span class="sub">' + sub + '</span>' : '');
    el.classList.remove('is-show', 'is-long', 'is-enemy');
    void el.offsetWidth;
    if(theme === 'enemy') el.classList.add('is-enemy');
    el.classList.add(sub ? 'is-long' : 'is-show');
    // 2026-05-17 v3 "5초 걸린다" — 또 단축 1100/700 → 600/400
    return new Promise(resolve => setTimeout(resolve, sub ? 600 : 400));
  }
  function _showSmallBanner(text, isEnemy){
    const el = document.getElementById('tcg-banner-small');
    if(!el) return Promise.resolve();
    el.textContent = text;
    el.classList.remove('is-show', 'is-enemy');
    void el.offsetWidth;
    if(isEnemy) el.classList.add('is-enemy');
    el.classList.add('is-show');
    return new Promise(resolve => setTimeout(resolve, 1600));
  }
  // 2026-05-24 운명의 신탁 (coin-flip v3) — 갤러리 mockup/coin_flip_2026-05-24/v3_coin_oracle.html
  // battle_system_decisions.md §운명의 신탁 (coin-flip v3) 표준 룰 / feature_manifest 3.8
  // 옛 단순 rotateY (4500ms) 폐기. v3 = 14회 flip 가속→감속 (Web Animations API)
  //   + 룬 링 회전 + 8 룬 문자 + suspense aura + reveal burst + result panel + flash + particles.
  // 동전 자산: img/ui/coins/coin_holy.png (앞면, holy/선공) + img/ui/coins/coin_dark.png (뒷면, dark/후공).
  // 의심 패턴 (변경 시 manifest 3.8 grep 의무): parity 14회 / lookup map / aura class 정리.
  const COIN_RUNE_CHARS = ['ᚠ','ᚱ','ᚲ','ᚷ','ᛁ','ᛏ','ᚦ','ᛃ'];
  let _coinRunesPlaced = false;
  let _coinParticleTimer = null;
  function _ensureCoinRunes(){
    if(_coinRunesPlaced) return;
    const host = document.getElementById('tcg-coin-runes');
    if(!host) return;
    host.innerHTML = '';
    COIN_RUNE_CHARS.forEach((ch, i) => {
      const angle = (i / COIN_RUNE_CHARS.length) * Math.PI * 2;
      const r = 230;
      const x = Math.cos(angle) * r;
      const y = Math.sin(angle) * r;
      const span = document.createElement('span');
      span.textContent = ch;
      span.style.left = `calc(50% + ${x}px - 8px)`;
      span.style.top  = `calc(50% + ${y}px - 8px)`;
      host.appendChild(span);
    });
    _coinRunesPlaced = true;
  }
  function _spawnCoinParticle(){
    const container = document.getElementById('tcg-coin-particles');
    if(!container) return;
    const p = document.createElement('div');
    p.className = 'p';
    const x = 30 + Math.random() * 1220;
    const y = 720;
    const drift = (Math.random() - .5) * 80;
    const dur = 4500 + Math.random() * 3000;
    const size = 2 + Math.random() * 3;
    p.style.width = p.style.height = size + 'px';
    p.style.left = x + 'px';
    p.style.top  = y + 'px';
    container.appendChild(p);
    p.animate(
      [
        { transform: 'translate(0,0)', opacity: 0 },
        { transform: `translate(${drift*.4}px,-200px)`, opacity: .9, offset: .2 },
        { transform: `translate(${drift}px,-720px)`, opacity: 0 }
      ],
      { duration: dur, easing: 'ease-out' }
    ).onfinish = () => p.remove();
  }
  function _animCoinFlip(ev){
    return new Promise(resolve => {
      // 2026-05-17 — 매치 시작 시점 input lock (사용자 명시 "다 받고 게임동작 가능, 그전엔 lock")
      const screen = document.getElementById('tcg-screen');
      if(screen) screen.classList.add('is-pregame');
      const stage = document.getElementById('tcg-coin-stage');
      const host  = document.getElementById('tcg-coin-host');
      const coin  = document.getElementById('tcg-coin');
      const panel = document.getElementById('tcg-coin-result-panel');
      const rName = document.getElementById('tcg-coin-r-name');
      const rTag  = document.getElementById('tcg-coin-r-tag');
      const flash = document.getElementById('tcg-coin-flash');
      const hint  = document.getElementById('tcg-coin-hint');
      if(!stage || !host || !coin || !panel || !rName || !rTag || !flash || !hint){
        if(screen) screen.classList.remove('is-pregame');
        resolve(); return;
      }

      // reset 옛 잔존 상태
      _ensureCoinRunes();
      host.classList.remove('is-suspense', 'is-revealed', 'dark');
      panel.classList.remove('is-show');
      flash.className = 'tcg-coin-flash';
      hint.classList.remove('is-show');
      coin.style.transition = 'none';
      coin.style.transform = 'rotateX(0deg)';
      void coin.offsetWidth;

      // stage activate
      stage.classList.add('is-active');

      // particles spawn (clear 옛 interval if any)
      if(_coinParticleTimer){ clearInterval(_coinParticleTimer); _coinParticleTimer = null; }
      _coinParticleTimer = setInterval(_spawnCoinParticle, 220);

      // target side: holy = 선공 (앞면) / dark = 후공 (뒷면)
      // ev.firstSide 가 'player' 면 holy (사용자 유리), 'enemy' 면 dark
      const targetSide = ev.firstSide === 'player' ? 'holy' : 'dark';

      // 5회 flip schedule — ease-out cubic^2.4 (60ms → 900ms)
      // 2026-05-27 사용자 단축 요청 — 14→5회 (원본 cubic curve 유지, 마지막 900ms 또르륵 멈춤 인상 유지)
      const N = 5;
      const intervals = [];
      for(let i = 0; i < N; i++){
        const t = i / (N - 1);
        const eased = Math.pow(t, 2.4);
        intervals.push(60 + (900 - 60) * eased);
      }
      const introPause = 200;
      const totalDuration = intervals.reduce((a,b) => a+b, 0) + introPause;

      // parity: holy 면 even totalFlips (180°×짝수 → 0/360°), dark 면 odd
      const totalFlips = (targetSide === 'holy')
        ? (N % 2 === 0 ? N : N + 1)
        : (N % 2 === 1 ? N : N + 1);
      const totalDeg = 180 * totalFlips;

      hint.textContent = '신탁을 기다리는 중…';
      hint.classList.add('is-show');

      coin.animate(
        [
          { transform: 'rotateX(0deg)', offset: 0 },
          { transform: `rotateX(${totalDeg * 0.50}deg)`, offset: 0.35 },
          { transform: `rotateX(${totalDeg * 0.78}deg)`, offset: 0.65 },
          { transform: `rotateX(${totalDeg * 0.92}deg)`, offset: 0.82 },
          { transform: `rotateX(${totalDeg * 0.985}deg)`, offset: 0.94 },
          { transform: `rotateX(${totalDeg}deg)`, offset: 1 }
        ],
        { duration: totalDuration, easing: 'linear', fill: 'forwards' }
      );

      // suspense (55% in)
      setTimeout(() => {
        host.classList.add('is-suspense');
        hint.textContent = '운명이 결정되고 있다…';
      }, totalDuration * 0.55);

      // reveal (settle)
      setTimeout(() => {
        host.classList.remove('is-suspense');
        host.classList.add('is-revealed');
        if(targetSide === 'dark') host.classList.add('dark');
        flash.className = 'tcg-coin-flash flash-' + targetSide;
        hint.classList.remove('is-show');
      }, totalDuration);

      // result panel (250ms after settle)
      setTimeout(() => {
        if(targetSide === 'holy'){
          rName.textContent = '신성 · 선공';
          rName.className = 'r-name holy';
          rTag.textContent = '✦ 당신이 먼저 시작합니다';
        } else {
          rName.textContent = '암흑 · 후공';
          rName.className = 'r-name dark';
          rTag.textContent = '✧ 상대가 먼저 시작합니다';
        }
        panel.classList.add('is-show');
      }, totalDuration + 250);

      // resolve (panel 표시 후 ~550ms 더 보여주고 종료) — 합 ~2.8s (옛 ~6s 에서 단축)
      setTimeout(() => {
        if(_coinParticleTimer){ clearInterval(_coinParticleTimer); _coinParticleTimer = null; }
        stage.classList.remove('is-active');
        // result-panel is-show 는 다음 매치 reset 시 _animCoinFlip 초기에 정리 (위 reset 블록)
        resolve();
      }, totalDuration + 800);
    });
  }
  // 2026-05-17 사용자 명시 "소환페이즈 너무 늦게 떠" — round-start banner 폐기.
  // round 번호는 turn-panel (ROUND N) 표시로 충분. banner 는 phase 시작만.
  function _animRoundStart(ev){
    return Promise.resolve();  // skip — turn-panel 이 round 표시
  }
  function _animPhaseStart(phase){
    // 2026-05-17 v5 — banner 1.5초 (사용자 명시). _showBigBanner 700ms 후 추가 800ms wait = 1500ms.
    if(phase === 'card'){
      return _showBigBanner('동료 출전 페이즈입니다').then(() => new Promise(r => setTimeout(r, 800)));
    } else if(phase === 'board'){
      return _showBigBanner('전투의 페이즈입니다').then(() => new Promise(r => setTimeout(r, 800)));
    }
    return Promise.resolve();
  }
  function _animTurnSideChange(ev){
    // 2026-06-09 버그2 fix — 차례 전환 배너 재생 시 인디케이터도 ev.side 로 전진 (banner 와 glow 일치).
    _setVisualSide(ev.side);
    const isPlayer = ev.side === 'player';
    const isBoard = ev.phase === 'board';
    const text = isPlayer
      ? (isBoard ? '내 차례 — 행동할 유닛을 선택하세요' : '내 차례 — 카드를 사용하세요')
      : '상대 차례...';
    return _showSmallBanner(text, !isPlayer);
  }
  UI._showBigBanner = _showBigBanner;
  UI._showSmallBanner = _showSmallBanner;

  // 2026-05-16 — 공격 모션 (HS 식 대각선 lunge overlap 70%).
  // design-confirmed: mockup/attack_motion/v4_overlap.html 사용자 "정본 적용 70%".
  // 공식: 공격자 중심 도착 = 대상 중심 − 단위벡터 × (1 − 0.7) × 대상 카드 height.
  // 2026-05-16 fix v2: cell 로 복귀. cell 안의 .card-v4 가 transform:scale 라 rect 정확치 못함.
  // cell 은 110×130 고정 layout box → rect 안정.
  function _findUnitElForAttack(side, uid){
    const st = Match.state;
    if(!st || !st[side]) return null;
    if(st[side].hero && st[side].hero.uid === uid){
      return document.getElementById('tcg-' + (side === 'enemy' ? 'e' : 'p') + '-hero');
    }
    const card = document.querySelector('.tcg-board-cell .match-card[data-uid="' + uid + '"]');
    return card ? card.closest('.tcg-board-cell') : null;
  }
  function _animUnitAttack(ev){
    return new Promise(resolve => {
      // 2026-06-09 버그2 fix — 재생 시점 인디케이터를 공격자 측으로 (renderState 가 최종 점프 안 하므로 여기서 구동).
      _setVisualSide(ev.attackerSide);
      const attackerEl = _findUnitElForAttack(ev.attackerSide, ev.attackerUid);
      const targetEl = _findUnitElForAttack(ev.targetSide, ev.targetUid);
      // 2026-06-09 버그1 fix — 공격으로 타겟이 죽어 DOM 에서 사라졌어도 wipe 직전 스냅샷 rect 로 lunge 재생.
      //   공격자 element 는 거의 항상 생존 (반사 사망 등 희귀 케이스만 없음) → 없으면 스킵.
      if(!attackerEl){ resolve(); return; }
      const aRect = attackerEl.getBoundingClientRect();
      const tRect = targetEl ? targetEl.getBoundingClientRect() : _lastBoardRects[ev.targetUid];
      if(!tRect){ resolve(); return; }  // 타겟 위치 정보 전혀 없음 (스냅샷도 없음) → 스킵
      const aCx = aRect.left + aRect.width / 2;
      const aCy = aRect.top + aRect.height / 2;
      const tCx = tRect.left + tRect.width / 2;
      const tCy = tRect.top + tRect.height / 2;

      const dx0 = tCx - aCx;
      const dy0 = tCy - aCy;
      const dist = Math.hypot(dx0, dy0) || 1;
      const ux = dx0 / dist;
      const uy = dy0 / dist;

      const overlap = 0.7;
      const cardDepth = tRect.height;
      const offset = (1 - overlap) * cardDepth;
      const targetCx = tCx - ux * offset;
      const targetCy = tCy - uy * offset;
      // 2026-05-17 사용자 명시 lunge 130% over fix — getBoundingClientRect 는 monitor px (game-root scale 포함).
      // translate 는 element 의 local px (scale 적용 전) 이라 dx/dy 를 scale 로 나눠야 monitor 거리와 일치.
      const rootScale = window.__rofRootScale || 1;
      const dx = (targetCx - aCx) / rootScale;
      const dy = (targetCy - aCy) / rootScale;

      attackerEl.style.setProperty('--lunge-half', 'translate(' + dx + 'px, ' + dy + 'px)');
      attackerEl.classList.remove('is-attacking');
      void attackerEl.offsetWidth;
      attackerEl.classList.add('is-attacking');

      // 충돌 시점 (40% = 220ms) 에 target shake. damage popup 은 다음 'damage' event 가 그림.
      // 2026-06-09 — 타겟이 이미 사망(스냅샷 rect 사용)이면 shake 생략 (element 없음). 돌진 모션은 위에서 정상 재생.
      if(targetEl){
        setTimeout(() => {
          targetEl.classList.remove('is-hit');
          void targetEl.offsetWidth;
          targetEl.classList.add('is-hit');
          // 공격 피격 "팅" — 데미지 밴드(ev.dmg, 코어 동봉). ≤5 는 is-hit 만(그냥피격) / 6~9 묵직+ / 10+ 묵직++.
          const _dmg = ev.dmg|0;
          const _reduce = !!(window.matchMedia && window.matchMedia('(prefers-reduced-motion: reduce)').matches);
          if(_dmg >= 6 && !_reduce){
            const tier = _impactTier(_dmg);
            const r = targetEl.getBoundingClientRect();
            if(r.width){
              _mrSpawnFlash(r, tier.flashPeak);
              _mrSparks(r, '#ffcf6b', tier.sparks);
              _mrShockwave(r, tier.ringScale);
              _mrShockwave2(r, tier);
              _mrScreenKick(tier.kickAmp, tier.kickRot, tier.kickScale);
            }
          }
        }, 220);
      }

      // 충돌 시점에 다음 이벤트 (damage) 진행 — popup 이 동시에 뜨도록 220ms 에 resolve.
      // 2026-05-30 #36 B Step 1 (사용자 보고 cascade 순서) — 240→500ms (lunge 거의 끝나고 damage popup).
      // design-confirmed: 2026-05-30 사유: bug fix — 사용자 mental model "공격 애니 → 피해수치 → HP 감소 → 사망" 정합.
      setTimeout(() => resolve(), 500);

      // animation 끝 정리
      setTimeout(() => {
        attackerEl.classList.remove('is-attacking');
        if(targetEl) targetEl.classList.remove('is-hit');
        attackerEl.style.removeProperty('--lunge-half');
      }, 600);
    });
  }

  // ───── 근접 반격(melee counterattack) 연출 — 2026-06-16 (갤러리 mockup/melee_counter v5 컨펌, P0 #1) ─────
  //   코어 60_turnbattle_v6.js:3492 가 'melee-reflect-dmgtype' 이벤트 push → 여기서 방어자 카운터스러스트 + 공격자 recoil + 묵직(v5).
  //   오버레이(플래시/충격파/스파크)는 document.body 에 viewport px(getBoundingClientRect)로 — game-root scale 무관 (_animDamage 패턴).
  //   카드 transform 은 셀(.tcg-board-cell)에 /rootScale 보정. 숫자/HP 는 이어지는 'damage' 이벤트가 그림.
  /* diagnosis-confirmed: 2026-06-16 사유: feature — 데미지 3단계 "팅" 밴드(≤5 그냥피격 / 6~9 묵직+ / 10+ 묵직++), 사용자 "게임 적용" 컨펌. 버그 아님. */
  // 데미지 → 임팩트 티어. 공격 피격(_animUnitAttack)·반격(_animMeleeReflect) 공용. mockup/arrow_viz 검수 컨펌값.
  const _IMPACT_TIERS = {
    plain:    {kb:13, kickAmp:0,  kickRot:0,   kickScale:1,     flashPeak:.85, sparks:12, ringScale:0,   hitstop:0,   bright:1.9, recoilDur:380, doubleRing:false},
    plus:     {kb:17, kickAmp:14, kickRot:1.6, kickScale:1.028, flashPeak:.95, sparks:20, ringScale:3.5, hitstop:50,  bright:2.5, recoilDur:400, doubleRing:false},
    plusplus: {kb:26, kickAmp:24, kickRot:2.3, kickScale:1.052, flashPeak:1.0, sparks:30, ringScale:4.8, hitstop:130, bright:3.3, recoilDur:470, doubleRing:true},
  };
  function _impactTier(dmg){ dmg = dmg|0; return dmg>=10 ? _IMPACT_TIERS.plusplus : (dmg>=6 ? _IMPACT_TIERS.plus : _IMPACT_TIERS.plain); }

  function _mrSpawnFlash(rect, peak){
    const f = document.createElement('div'); f.className = 'tcg-mr-flash';
    f.style.left = rect.left + 'px'; f.style.top = rect.top + 'px';
    f.style.width = rect.width + 'px'; f.style.height = rect.height + 'px';
    document.body.appendChild(f);
    f.animate([{opacity:0},{opacity:(peak||.92), offset:.3},{opacity:0}], {duration:230, easing:'ease-out'}).onfinish = () => f.remove();
  }
  function _mrShockwave(rect, scale){
    if((scale||0) <= 0) return;
    const w = document.createElement('div'); w.className = 'tcg-mr-shockwave';
    w.style.left = (rect.left + rect.width/2) + 'px'; w.style.top = (rect.top + rect.height/2) + 'px';
    document.body.appendChild(w);
    w.animate([
      {opacity:.9, transform:'translate(-50%,-50%) scale(.2)', borderWidth:'5px'},
      {opacity:0, transform:'translate(-50%,-50%) scale('+scale+')', borderWidth:'1px'}
    ], {duration:380, easing:'cubic-bezier(.1,.7,.3,1)'}).onfinish = () => w.remove();
  }
  function _mrSparks(rect, color, n){
    const cx = rect.left + rect.width/2, cy = rect.top + rect.height/2;
    n = n || 18;
    for(let i=0;i<n;i++){
      const s = document.createElement('div'); s.className = 'tcg-mr-spark';
      const sz = 5 + (i%3)*2;
      s.style.cssText = 'left:'+cx+'px;top:'+cy+'px;width:'+sz+'px;height:'+sz+'px;background:'+color+';box-shadow:0 0 6px '+color+';';
      document.body.appendChild(s);
      const a = (Math.PI*2*i)/n + i*0.3, dist = 34 + (i%4)*8;
      const gx = Math.cos(a)*dist, gy = Math.sin(a)*dist + 22;  // 중력 낙하
      s.animate([
        {opacity:1, transform:'translate(-50%,-50%) translate(0,0) scale(1)'},
        {opacity:0, transform:'translate(-50%,-50%) translate('+gx+'px,'+gy+'px) scale(.3)'}
      ], {duration:430 + (i%3)*60, easing:'cubic-bezier(.2,.6,.4,1)'}).onfinish = () => s.remove();
    }
  }
  function _mrScreenKick(amp, rot, sc){
    if((amp||0) <= 0) return;
    const screen = document.getElementById('tcg-screen'); if(!screen) return;
    // 묵직 — 스크린셰이크(저주파·큰진폭) + 줌펀치(카메라 킥). #tcg-screen 은 game-root(scale) 의 자식이라 안전. 강도는 데미지 밴드별.
    if(rot == null) rot = 1.4; if(sc == null) sc = 1.022;
    const mid = (1 + sc) / 2;
    screen.animate([
      {transform:'translate(0,0) rotate(0deg) scale(1)'},
      {transform:'translate(-'+amp+'px,'+(amp*0.7)+'px) rotate(-'+rot+'deg) scale('+sc+')', offset:.14},
      {transform:'translate('+(amp*0.8)+'px,-'+(amp*0.5)+'px) rotate('+(rot*0.7)+'deg) scale('+mid+')', offset:.34},
      {transform:'translate(-'+(amp*0.5)+'px,'+(amp*0.3)+'px) rotate(-'+(rot*0.4)+'deg) scale(1)', offset:.58},
      {transform:'translate('+(amp*0.25)+'px,0) rotate(0deg) scale(1)', offset:.82},
      {transform:'translate(0,0) rotate(0deg) scale(1)'}
    ], {duration:440, easing:'cubic-bezier(.2,.8,.3,1)'});
  }
  // ++ 2차 충격파(staggered) — 묵직++ 전용
  function _mrShockwave2(rect, tier){
    if(tier && tier.doubleRing && tier.ringScale > 0) setTimeout(() => _mrShockwave(rect, tier.ringScale * 1.3), 95);
  }
  function _animMeleeReflect(ev){
    return new Promise(resolve => {
      const reduce = !!(window.matchMedia && window.matchMedia('(prefers-reduced-motion: reduce)').matches);
      const atkEl = _findUnitElForAttack(ev.toSide, ev.toUid);     // 공격자 (반격 피해 받음)
      const defEl = _findUnitElForAttack(ev.fromSide, ev.fromUid); // 방어자 (반격자)
      if(!atkEl){ resolve(); return; }
      const rootScale = window.__rofRootScale || 1;
      const aRect = atkEl.getBoundingClientRect();
      if(!aRect.width){ resolve(); return; }
      const aCx = aRect.left + aRect.width/2, aCy = aRect.top + aRect.height/2;
      // 방어자→공격자 방향 (카운터스러스트 + 공격자 넉백 방향). 방어자 없으면 세로 fallback.
      let ux = 0, uy = (ev.toSide === 'enemy') ? -1 : 1;
      const dRect = (defEl && defEl.getBoundingClientRect().width) ? defEl.getBoundingClientRect() : null;
      if(dRect){
        const vx = aCx - (dRect.left + dRect.width/2), vy = aCy - (dRect.top + dRect.height/2), d = Math.hypot(vx, vy) || 1;
        ux = vx/d; uy = vy/d;
      }
      // ① 방어자 카운터스러스트 (공격자 쪽으로 짧게 찌르고 복귀)
      if(dRect && !reduce){
        const thrust = 0.42 * dRect.height;
        const tx = (ux*thrust)/rootScale, ty = (uy*thrust)/rootScale;
        defEl.animate([
          {transform:'translate(0,0)'},
          {transform:'translate('+tx+'px,'+ty+'px) scale(1.05)', offset:.45},
          {transform:'translate(0,0)'}
        ], {duration:520, easing:'cubic-bezier(.5,0,.34,1.4)'});
      }
      // ② 임팩트 (카운터스러스트 contact ~200ms) — 반격 데미지(ev.amount) 밴드: ≤5 그냥피격(충격파·킥·hit-stop 없음) / 6~9 묵직+ / 10+ 묵직++
      const tier = _impactTier(ev.amount);
      const impactAt = reduce ? 0 : 200;
      setTimeout(() => {
        _mrSpawnFlash(aRect, tier.flashPeak);
        if(reduce) return;
        const fire = () => {
          const kb = tier.kb/rootScale;  // 넉백(방어자 반대 방향) local px
          atkEl.animate([
            {transform:'translate(0,0) scale(1,1)'},
            {transform:'translate('+(-ux*kb)+'px,'+(-uy*kb)+'px) scale(1.16,.86)', offset:.28},
            {transform:'translate('+(-ux*kb*0.5)+'px,'+(-uy*kb*0.5)+'px) scale(.95,1.06)', offset:.55},
            {transform:'translate(0,0) scale(1,1)'}
          ], {duration:tier.recoilDur, easing:'cubic-bezier(.34,1.56,.64,1)'});
          atkEl.animate([{filter:'brightness(1)'},{filter:'brightness('+tier.bright+')'},{filter:'brightness(1)'}], {duration:260, easing:'ease-out'});
          _mrSparks(aRect, '#ffcf6b', tier.sparks);
          _mrShockwave(aRect, tier.ringScale);   // ringScale 0 이면 내부 skip (≤5 그냥피격)
          _mrShockwave2(aRect, tier);            // 묵직++ 2차 충격파
          _mrScreenKick(tier.kickAmp, tier.kickRot, tier.kickScale);  // kickAmp 0 이면 skip
        };
        if(tier.hitstop > 0) setTimeout(fire, tier.hitstop); else fire();  // 팅(6+) 만 hit-stop freeze 후 "탁"
      }, impactAt);
      // resolve — 임팩트 직후 (이어지는 'damage' 이벤트 숫자가 recoil 중 뜨도록). 잔여 모션은 fire-and-forget.
      setTimeout(resolve, impactAt + (reduce ? 240 : tier.hitstop + 240));
    });
  }

  // 2026-05-16 — 레벨업 popup B (파티클 + LEVEL UP! 텍스트) + 스탯 flash
  // ───── cascade 헬퍼 (2026-05-28 cascade C3) ─────
  // 모듈 level 활성 cascade 카운터 — 1 이상이면 신규 cascade 는 SHORT 모드 (도미노 답답함 ↓)
  let _activeCascadeCount = 0;
  function _cascadeSleep(ms){ return new Promise(r => setTimeout(r, ms)); }

  // stat 카운터 interpolate (5→6→7 변화량 비례 0.15s × diff) + 정본 .is-flashing-buff 펄스 재사용
  async function _interpolateStatCounter(numEl, diff){
    if(!numEl || diff === 0) return;
    const stepMs = 150;
    const startVal = parseInt(numEl.textContent || '0', 10);
    numEl.classList.remove('is-flashing-buff');
    void numEl.offsetWidth;
    numEl.classList.add('is-flashing-buff');
    for(let i = 1; i <= diff; i++){
      await _cascadeSleep(stepMs);
      numEl.textContent = startVal + i;
    }
    await _cascadeSleep(400);
    numEl.classList.remove('is-flashing-buff');
  }

  // 레벨업 cascade — 시안 v3 정본 적용 (2026-05-28)
  // design-confirmed: 2026-05-28 mockup/levelup_cascade/v3.html
  //   사용자 결정: ① 모든 unit 동일 cascade ② 카드 일러스트 정중앙 overlay
  //                ③ 보상 토스트 한 줄씩 순차 (공격력 +N / 영혼력 +N / 체력 +N)
  //                ④ 케이스 분기 — 단일 2.5s / 도미노 1.5s SHORT
  //                ⑤ 파티클 옵션 E (정본 dot 9개 직선 방사) 보존
  // 옛 _animLevelupPopup (2026-05-16 popup B) 폐기 — 사용자 "정본 적용" 컨펌.
  async function _animLevelupPopup(ev, kind){
    // 대상 cell + cardEl 찾기 (옛 흐름 보존)
    let targetCell = null;
    if(kind === 'hero'){
      const sideTag = ev.side === 'enemy' ? 'e' : 'p';
      targetCell = document.getElementById('tcg-' + sideTag + '-hero');
    } else {
      const pCard = document.querySelector('#tcg-p-board .tcg-board-cell .match-card[data-uid="' + ev.uid + '"]');
      const eCard = document.querySelector('#tcg-e-board .tcg-board-cell .match-card[data-uid="' + ev.uid + '"]');
      const card = pCard || eCard;
      targetCell = card ? card.closest('.tcg-board-cell') : null;
    }
    if(!targetCell) return;
    const cardEl = targetCell.querySelector('.match-card') || targetCell;
    const coinEl = cardEl.querySelector('.tcg-hero-progress') || targetCell.querySelector('.tcg-hero-progress');

    // 케이스 분기 — activeCascade > 0 이면 SHORT (도미노)
    const SHORT = _activeCascadeCount > 0;
    _activeCascadeCount += 1;
    const DUR = SHORT ? {
      initialFlash: 250, afterText: 350, toastGap: 250, cleanupHold: 400, fadeOut: 250,
    } : {
      initialFlash: 500, afterText: 700, toastGap: 400, cleanupHold: 800, fadeOut: 400,
    };

    try {
      // [1] cascade overlay — 카드 일러스트 영역 정중앙
      const overlay = document.createElement('div');
      overlay.className = 'tcg-card-cascade-overlay';
      cardEl.appendChild(overlay);
      await _cascadeSleep(20);  // reflow
      overlay.classList.add('is-active');

      // [2] 카드 황금 펄스 + 흔들림 + Lv coin scale (initialFlash)
      cardEl.classList.add('is-cascade-golden', 'is-cascade-shake');
      if(coinEl) coinEl.classList.add('is-cascade-leveling');

      // [3] 옛 popup (LEVEL UP 텍스트 + 파티클 E dot 9개) — 동일 cardEl 안 append
      // 사용자 선택: 옵션 E (정본 보존) — particle dot 9개 직선 방사 유지
      const popup = document.createElement('div');
      popup.className = 'tcg-levelup-popup';
      popup.style.left = '50%';
      popup.style.top = '50%';
      popup.innerHTML =
        '<div class="lvup-label">LEVEL UP!</div>' +
        '<div class="lvup-particle"></div>'.repeat(9);
      cardEl.appendChild(popup);
      requestAnimationFrame(() => popup.classList.add('is-active'));

      await _cascadeSleep(DUR.initialFlash);
      cardEl.classList.remove('is-cascade-shake');
      await _cascadeSleep(DUR.afterText);

      // [4] 보상 토스트 stack — 한 줄씩 순차 + stat 카운터 interpolate (병렬)
      // ev 메타: atkBonus / soulBonus (영웅) / hpBonus (동료)
      const toastSpecs = [];
      if(typeof ev.atkBonus === 'number'  && ev.atkBonus  > 0) toastSpecs.push({text:`공격력 +${ev.atkBonus}`, type:'atk',  statSelector:'.atk-icon .num', delta:ev.atkBonus});
      if(typeof ev.soulBonus === 'number' && ev.soulBonus > 0) toastSpecs.push({text:`영혼력 +${ev.soulBonus}`, type:'soul', statSelector:null, delta:ev.soulBonus});
      if(typeof ev.hpBonus === 'number'   && ev.hpBonus   > 0) toastSpecs.push({text:`체력 +${ev.hpBonus}`,    type:'hp',   statSelector:'.hp-icon .num',  delta:ev.hpBonus});

      const toasts = [];
      for(const spec of toastSpecs){
        const t = document.createElement('div');
        t.className = `tcg-cascade-reward-toast is-${spec.type}`;
        t.textContent = spec.text;
        overlay.appendChild(t);
        await _cascadeSleep(20);
        t.classList.add('show');
        toasts.push(t);

        // stat 카운터 interpolate (비동기 — 다음 토스트와 병렬)
        if(spec.statSelector){
          const numEl = cardEl.querySelector(spec.statSelector);
          if(numEl) _interpolateStatCounter(numEl, spec.delta);  // fire-and-forget
        }
        await _cascadeSleep(DUR.toastGap);
      }

      // [5] cleanup hold
      await _cascadeSleep(DUR.cleanupHold);

      // [6] fade out + 제거
      toasts.forEach(t => t.classList.remove('show'));
      overlay.classList.remove('is-active');
      await _cascadeSleep(DUR.fadeOut);
      toasts.forEach(t => t.remove());
      overlay.remove();
      popup.remove();
      cardEl.classList.remove('is-cascade-golden');
      if(coinEl) coinEl.classList.remove('is-cascade-leveling');
    } finally {
      // 22번째 사고 (visual cascade race) 후속 의무 — 어떤 경로로도 카운터 누적 X
      _activeCascadeCount = Math.max(0, _activeCascadeCount - 1);
    }
  }

  // ───── 카드 주머니 (덱 / 운명서) — Phase 1A.1 (2026-05-07) ─────
  // 양 진영 덱 잔여 카드 수 표시. 변동 시 .is-changed 펄스. 빈 덱은 .is-empty dim.
  let _lastPlayerDeck = -1;
  let _lastEnemyDeck  = -1;
  UI._renderDeckPouches = function(){
    const st = Match.state;
    if(!st) return;
    _renderOneDeckPouch('player', st.player && st.player.deck, '_lastPlayerDeck');
    _renderOneDeckPouch('enemy',  st.enemy  && st.enemy.deck,  '_lastEnemyDeck');
  };
  function _renderOneDeckPouch(sideKey, deck, lastKey){
    const root  = document.getElementById('tcg-deck-' + sideKey);
    const count = document.getElementById('tcg-deck-' + sideKey + '-count');
    if(!root || !count) return;
    const n = Array.isArray(deck) ? deck.length : 0;
    count.textContent = n;
    root.classList.toggle('is-empty', n === 0);
    const last = (sideKey === 'player') ? _lastPlayerDeck : _lastEnemyDeck;
    if(last !== -1 && last !== n){
      root.classList.remove('is-changed');
      // reflow → 애니 재시작
      void root.offsetWidth;
      root.classList.add('is-changed');
      setTimeout(() => root.classList.remove('is-changed'), 600);
    }
    if(sideKey === 'player') _lastPlayerDeck = n; else _lastEnemyDeck = n;
  }

  // ───── 레벨업 모달 (M&M Fates progression — 2026-05-06) ─────
  // player 영웅이 pendingLevelUp 이면 3 선택지 모달 표시. 사용자 클릭 → applyLevelUpChoice 호출.
  // 모달 닫힌 후 코어가 _resumeTurn 자동 진행 (사이드 전환). UI 는 renderState 호출만.
  UI._renderLevelUpModal = function(){
    const st = Match.state;
    let modal = document.getElementById('tcg-levelup-modal');
    const need = st && !st.winner && st.player && st.player.hero && st.player.hero.pendingLevelUp;
    if(!need){
      if(modal) modal.remove();
      return;
    }
    if(modal) return;  // 이미 떠있음 — 중복 생성 방지

    const hero = st.player.hero;
    const nextLevel = (hero.matchLevel || 1) + 1;

    modal = document.createElement('div');
    modal.id = 'tcg-levelup-modal';
    modal.className = 'tcg-levelup-modal';
    modal.innerHTML =
      '<div class="tlm-backdrop"></div>' +
      '<div class="tlm-panel">' +
        '<div class="tlm-title">⚜️ 영혼이 깨어났다! Lv ' + nextLevel + ' 권능을 선택하세요</div>' +
        '<div class="tlm-choices">' +
          '<button class="tlm-btn tlm-btn-atk"  data-choice="atk" type="button">' +
            '<div class="tlm-btn-icon">⚔️</div>' +
            '<div class="tlm-btn-label">전투력</div>' +
            '<div class="tlm-btn-value">공격 +2</div>' +
          '</button>' +
          '<button class="tlm-btn tlm-btn-soul" data-choice="soul" type="button">' +
            '<div class="tlm-btn-icon">✨</div>' +
            '<div class="tlm-btn-label">영혼력</div>' +
            '<div class="tlm-btn-value">매 턴 +1</div>' +
          '</button>' +
          '<button class="tlm-btn tlm-btn-hp"   data-choice="hp" type="button">' +
            '<div class="tlm-btn-icon">❤️</div>' +
            '<div class="tlm-btn-label">생명력</div>' +
            '<div class="tlm-btn-value">체력 +5</div>' +
          '</button>' +
        '</div>' +
      '</div>';
    const screen = document.getElementById('tcg-screen');
    if(!screen){ return; }
    screen.appendChild(modal);

    modal.querySelectorAll('.tlm-btn').forEach(btn => {
      btn.addEventListener('click', () => {
        const choice = btn.getAttribute('data-choice');
        Match.api.applyLevelUpChoice('player', choice);
        if(modal.parentElement) modal.parentElement.removeChild(modal);
        UI.renderState();
        _startTimer();
      });
    });
  };

  // ───── 운명 정찰(Scry) 모달 (v4 하이브리드 시안 — 2026-06-07 사용자 컨펌 "이걸로 적용") ─────
  /* diagnosis-confirmed: 2026-06-07 사유: feature — Scry 모달. scry-prompt 이벤트 → 덱 상단 N장 뒤집어 공개(점술) → 유지(위+금)/맨아래(아래) 선택 → Match._scry. mockup/scry/v4_hybrid.html 정합. */
  UI._renderScryModal = function(ev){
    return new Promise(resolve => {
      const st = Match.state;
      const side = st && st[ev.side || 'player'];
      if(!side || !Array.isArray(side.deck)){ resolve(); return; }
      const count = Math.min(ev.count || 1, side.deck.length);
      const screen = document.getElementById('tcg-screen');
      if(count <= 0 || !screen){ if(count > 0) Match._scry(ev.side, count, null); resolve(); return; }
      const top = side.deck.slice(0, count);
      const EMO = {fire:'🔥',water:'💧',lightning:'⚡',earth:'🌿',holy:'✨',dark:'🌑'};
      const decisions = top.map(() => ({keep:true}));  // 기본 유지
      const esc = s => String(s==null?'':s).replace(/[&<>"]/g, m => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;'}[m]));

      const modal = document.createElement('div');
      modal.id = 'tcg-scry-modal'; modal.className = 'tcg-scry-modal';
      const cardsHtml = top.map((c, i) => {
        const ns = c.NEED_SOUL || 0, nm = esc(c.name || '?');
        const atk = (c.ATK != null) ? c.ATK : (c.curATK || 0), hp = (c.HP != null) ? c.HP : (c.curHP || 0);
        return '<div class="tsc-slot" data-i="' + i + '">'
          + '<div class="tsc-flip"><div class="tsc-face tsc-back"><div class="tsc-glyph">✦</div></div>'
          + '<div class="tsc-face tsc-front"><div class="tsc-ns">' + ns + '</div>'
          + '<div class="tsc-nm">' + (EMO[c.element] || '') + ' ' + nm + '</div>'
          + '<div class="tsc-stat"><b class="tsc-atk">' + atk + '</b><b class="tsc-hp">' + hp + '</b></div></div></div>'
          + '<div class="tsc-toggle"><button class="tsc-keep on" type="button">유지</button><button class="tsc-bot" type="button">맨 아래</button></div></div>';
      }).join('');
      modal.innerHTML = '<div class="tsc-dim"></div><div class="tsc-rune"></div>'
        + '<div class="tsc-panel"><div class="tsc-title">운명 정찰</div>'
        + '<div class="tsc-sub">엎어진 운명을 뒤집어 — 남길 것은 위로, 미룰 것은 아래로.</div>'
        + '<div class="tsc-cards">' + cardsHtml + '</div>'
        + '<button class="tsc-confirm" type="button" disabled>모든 운명을 펼쳐라</button></div>';
      screen.appendChild(modal);

      let revealed = 0;
      const confirmBtn = modal.querySelector('.tsc-confirm');
      modal.querySelectorAll('.tsc-slot').forEach(slot => {
        const i = +slot.getAttribute('data-i');
        const flip = slot.querySelector('.tsc-flip');
        const keepBtn = slot.querySelector('.tsc-keep'), botBtn = slot.querySelector('.tsc-bot');
        flip.addEventListener('click', () => {
          if(slot.classList.contains('open')) return;
          flip.classList.add('revealed'); slot.classList.add('open','keep'); revealed++;
          keepBtn.classList.add('on'); botBtn.classList.remove('on');
          if(revealed === count){ confirmBtn.disabled = false; confirmBtn.textContent = '운명을 정한다'; }
        });
        keepBtn.addEventListener('click', () => { decisions[i].keep = true; slot.classList.add('keep'); keepBtn.classList.add('on'); botBtn.classList.remove('on'); });
        botBtn.addEventListener('click', () => { decisions[i].keep = false; slot.classList.remove('keep'); botBtn.classList.add('on'); keepBtn.classList.remove('on'); });
      });
      confirmBtn.addEventListener('click', () => {
        if(confirmBtn.disabled) return;
        Match._scry(ev.side, count, decisions);
        if(modal.parentElement) modal.parentElement.removeChild(modal);
        UI.renderState();
        resolve();
      });
    });
  };

  // ───── 영혼 풀 렌더 + 변화 시 펄스 ─────
  UI._renderSoul = function(sideKey, value){
    const el = document.getElementById(`tcg-${sideKey === 'player' ? 'p' : 'e'}-soul`);
    if(!el) return;
    const last = (sideKey === 'player') ? _lastPlayerSoul : _lastEnemySoul;
    el.textContent = value;
    if(last !== -1 && last !== value){
      // 부모 .tcg-hud-soul 에 .is-changed 토글
      const hud = el.closest('.tcg-hud-soul');
      if(hud){
        hud.classList.remove('is-changed');
        // 강제 reflow 로 애니 재시작
        void hud.offsetWidth;
        hud.classList.add('is-changed');
        setTimeout(() => hud.classList.remove('is-changed'), 500);
      }
      // 2026-05-23 — 영혼력 +N floater (양수 변화 시만). mockup/hand_cast_block_hover/v3 A 컨펌.
      const diff = value - last;
      if(diff > 0){
        UI._showSoulFloater(sideKey, diff);
      }
    }
    if(sideKey === 'player') _lastPlayerSoul = value;
    else _lastEnemySoul = value;
  };

  // 2026-05-23 — 영혼력 +N floater 생성 (영혼력 구체 옆에 보라 +N 부드러운 등장 → 페이드).
  //   사용자 컨펌: 48px / 2.4s / 영혼력 증가 카드 발동 시 표시.
  //   CSS: .tcg-soul-floater + @keyframes tcg-soul-floater-anim (css/43_match.css).
  UI._showSoulFloater = function(sideKey, diff){
    if(!diff || diff <= 0) return;
    const orbEl = document.getElementById(`tcg-${sideKey === 'player' ? 'p' : 'e'}-soul`);
    if(!orbEl) return;
    const hud = orbEl.closest('.tcg-hud-soul') || orbEl.parentNode;
    if(!hud) return;
    // hud 가 position:static 이면 floater 위치 잡기 위해 relative 부여
    const cs = getComputedStyle(hud);
    if(cs.position === 'static') hud.style.position = 'relative';
    const floater = document.createElement('div');
    floater.className = 'tcg-soul-floater';
    floater.textContent = '+' + diff;
    hud.appendChild(floater);
    setTimeout(() => { if(floater.parentNode) floater.parentNode.removeChild(floater); }, 2400);
  };

  // 사용자 프로필 (좌/우하단, 2026-05-10 — 옛 영웅 portrait 자리 재용도)
  // 2026-05-13 사용자 결정: 프로필 카드 자산 3종만 사용 (구버전 avatar_pyromancer 폐기)
  // - player default = profile_m_warrior (남자 주인공 얼굴)
  // - enemy default = profile_titan (적 봇)
  // - 시즌 영웅 선택 (Auth.profile.heroChoice) 기반 분기 — 추후 확장
  const _DEFAULT_AVATAR_PLAYER = 'img/heroes/m_warrior/profile.png';
  const _DEFAULT_AVATAR_ENEMY  = 'img/npcs/profile_titan.png';
  UI._renderProfile = function(sideKey){
    const sideTag = (sideKey === 'enemy') ? 'e' : 'p';
    const avatarEl = document.getElementById('tcg-' + sideTag + '-pf-avatar');
    const nameEl   = document.getElementById('tcg-' + sideTag + '-pf-name');
    const levelEl  = document.getElementById('tcg-' + sideTag + '-pf-level');
    const titleEl  = document.getElementById('tcg-' + sideTag + '-pf-title');
    if(!avatarEl || !nameEl) return;
    let nick, level, title, avatarUrl;
    if(sideKey === 'player'){
      nick  = (global.Auth && Auth.user) || '나';
      level = (global.Auth && Auth.profile && Auth.profile.seasonLevel) || 1;
      title = (global.Auth && Auth.profile && Auth.profile.title) || '도전자';
      // 2026-05-13 — profileCardId (fixed 3종) 우선, 없으면 영웅 성별 (m/f) 기반 default
      const PROFILE_SRC = {
        'profile_m_warrior': 'img/heroes/m_warrior/profile.png',
        'profile_f_warrior': 'img/heroes/f_warrior/profile.png',
        'profile_titan':     'img/npcs/profile_titan.png',
      };
      const pid = (global.Game && Game.profileCardId) || null;
      let defaultPid = 'profile_m_warrior';
      const heroCard = (global.Game && Array.isArray(Game.deck)) ? Game.deck.find(c => c && c.isHero) : null;
      if(heroCard && heroCard.img){
        if(heroCard.img.indexOf('protagonist_f_') === 0) defaultPid = 'profile_f_warrior';
        else if(heroCard.img.indexOf('protagonist_m_') === 0) defaultPid = 'profile_m_warrior';
      }
      avatarUrl = PROFILE_SRC[pid] || PROFILE_SRC[defaultPid];
    } else {
      /* diagnosis-confirmed: 2026-06-09 사유: feature — 퀘스트 적 영웅 = 도전자 프로필 동일시 (사용자 결정). enemy 프로필 하드코딩('도전자'+titan)을 state.enemy.hero 기반 동적 조회로. read-only 렌더 분기, 코어 전투 무영향. */
      // 2026-06-09 사용자 결정 — 퀘스트(PvE) 전투는 도전자 = 적 영웅 동일시 (이름 + 프로필 사진).
      //   PvP/랭크 등 상대가 실제 유저면 기존 '도전자' + titan default 유지.
      const st = Match.state;
      const eHero = (st && st.enemy && st.enemy.hero) || null;
      const isQuest = !!(st && st.context === 'quest');
      level = 1;
      if(isQuest && eHero && eHero.name){
        nick  = eHero.name;     // 예: '우두머리 늑대'
        title = '도전자';
        // 전용 프로필 우선 → 적 영웅 카드 아트 폴백 → titan default (사용자 선택 2026-06-09)
        const CI = (typeof CARD_IMG !== 'undefined' && CARD_IMG) ? CARD_IMG : null;
        avatarUrl = (CI && CI[eHero.id + '_profile'])
                 || (CI && CI[eHero.id])
                 || _DEFAULT_AVATAR_ENEMY;
      } else {
        nick  = '도전자';
        title = '도전자';
        avatarUrl = _DEFAULT_AVATAR_ENEMY; // 적 봇 default = profile_titan
      }
    }
    nameEl.textContent  = nick;
    if(levelEl) levelEl.textContent = '시즌 Lv ' + level;
    if(titleEl) titleEl.textContent = title;
    // 아바타 — 이미지 또는 글자 placeholder
    avatarEl.innerHTML = '';
    if(avatarUrl){
      const img = document.createElement('img');
      img.src = avatarUrl;
      img.alt = nick;
      avatarEl.classList.add('has-img');
      avatarEl.appendChild(img);
    } else {
      avatarEl.classList.remove('has-img');
      const ch = (nick || '?').trim().charAt(0) || '?';
      avatarEl.textContent = ch;
    }
    // 2026-05-14 사용자 컨펌 — profileFrameId 따라 frame overlay (player 측만, 적은 default frame X)
    if(sideKey === 'player'){
      const frameId = (global.Game && Game.profileFrameId) || 'none';
      if(frameId !== 'none'){
        avatarEl.style.position = 'relative';
        const ov = document.createElement('div');
        ov.className = 'profile-frame-overlay';
        avatarEl.appendChild(ov);
      }
    }
  };

  // 영웅 portrait — battle_v3.jsx 시안 (사이드 130×130 원형 + name + HP 바)
  // 영웅 cell 채움 helper (2026-05-10 — 옛 portrait 폐기, 보드 row 가운데 cell V4 in-play 카드)
  // _renderBoard 가 가운데 cell 만들고 이 helper 가 영웅 카드 + click 타겟 동작 부착.
  function _fillHeroCell(cell, hero, sideKey){
    if(!cell || !hero) return;
    const cardEl = mkMatchCard(hero, {hero: true, boardUnit: true});
    cardEl.setAttribute('data-side', sideKey);
    cardEl.setAttribute('data-target', 'hero');
    // Task A.4 (2026-05-10) — 영웅도 보드턴 행동 후 회색 굳음 적용
    cardEl.classList.toggle('is-acted', !!hero._acted);
    cell.appendChild(cardEl);
    cell.classList.add('is-occupied');
    const isValid = UI._isValidTargetForSelected(sideKey, '__hero__');
    cell.classList.toggle('is-attackable', isValid);
    cell.classList.toggle('is-target-valid', isValid);
    const isAttackerActive = (sideKey === 'player'
      && _selected && _selected.kind === 'attacker'
      && _selected.uid === hero.uid);
    cell.classList.toggle('is-attacker-active', isAttackerActive);
  }

  // 옛 _renderHero 호환 stub — 외부 코드가 호출해도 no-op (영웅은 _renderBoard 가 처리)
  UI._renderHero = function(){ /* noop — _fillHeroCell 로 일원화 (2026-05-10) */ };

  /* diagnosis-confirmed: 2026-06-13 사유: feature — 종족 시너지 N/6 인디케이터 (mockup/race_synergy_indicator/gallery B-compact+좌측세로, 사용자 "b로 하는데 좌측 세로 칩으로" 컨펌). 버그수정 아님. */
  // 종족 시너지 트레이 — 보드 좌측 세로 컴팩트 칩 (아이콘 + N/6). N=영웅포함 같은종족 수. 6/6 = 종족 특수(골드+⭐).
  //   효과값(호버)은 유닛카운트 tier(영웅 제외) 기준 — 표시 N(영웅포함)과 분리해 오도 방지. _countSynergy 데이터 사용.
  /* diagnosis-confirmed: 2026-06-15 사유: feature — 원소 시너지 인디케이터 신규 + v2 갤러리(가로 2줄 compact + 호버 상세) 정본 배선 (사용자 "ㅇㅋ 적용하자"). 옛 종족 전용 세로 칩 → 종족·원소 통합 가로 2줄. 발동 중(효과값>=1 또는 6/6)만 노출. 호버 = 단계별 효과(누적/3·5단계/6단계) on/off 패널. 효과 텍스트는 최종 잠근 설계(race_synergy §4 2026-06-15) 기준. mockup/element_synergy_indicator/v2.html 거울. */
  /* diagnosis-confirmed: 2026-06-15 사유: refactor — 시너지 인디케이터 분리형 2트레이(player bottom/enemy top, 가로 2줄)→전선 중앙 단일 대칭(거울) 컬럼. 버그 아님(UI 구조 변경, mockup v5 사용자 "정본적용" 컨펌). 호출자 1곳(239)+CSS 블록 동시 변경. */
  UI._renderSynergyTray = function(){
    const st = Match.state; if(!st) return;
    const outer = document.querySelector('.tcg-board-outer'); if(!outer) return;
    if(getComputedStyle(outer).position === 'static') outer.style.position = 'relative';
    // 2026-06-15: 옛 분리형 2트레이(player bottom / enemy top) 제거 → 전선 중앙 단일 대칭 컬럼으로 마이그레이션 (mockup v5 컨펌)
    ['tcg-synergy-player','tcg-synergy-enemy'].forEach(id => { const e = document.getElementById(id); if(e && e.parentNode) e.parentNode.removeChild(e); });
    let tray = document.getElementById('tcg-synergy-tray');
    if(!tray){ tray = document.createElement('div'); tray.id = 'tcg-synergy-tray'; outer.appendChild(tray); }
    tray.className = 'tcg-synergy-tray';

    const SYN = (RoF.Data && RoF.Data.SYNERGY) || {race:{}, element:{}, tier:[], tierSolo:[]};
    const TIER = SYN.tier || [0,0,1,2,2,3,3];

    const RACE_KO = {human:'인간',beast:'야수',dragon:'용',avian:'비행족',undead:'언데드',demon:'악마',celestial:'천사',spirit:'정령',titan:'거인',abyssal:'심해족',fae:'요정',veinforged:'광맥족',savage:'야만인'};
    /* 완성 리터럴 아이콘 lookup (garbage-lesson #4: concat 금지 → 정적게이트 broken-asset 회피). 아이콘 존재분만 — 없으면 텍스트 fallback. */
    const RACE_ICON = {
      human:'img/ui/icons/t_race_human.png', beast:'img/ui/icons/t_race_beast.png', dragon:'img/ui/icons/t_race_dragon.png',
      avian:'img/ui/icons/t_race_avian.png', undead:'img/ui/icons/t_race_undead.png', demon:'img/ui/icons/t_race_demon.png',
      celestial:'img/ui/icons/t_race_celestial.png', spirit:'img/ui/icons/t_race_spirit.png', titan:'img/ui/icons/t_race_titan.png',
      abyssal:'img/ui/icons/t_race_abyssal.png',
    };
    const RACE_STAT = {human:'DEF',beast:'ATK',dragon:'HP',avian:'ATK',undead:'HP',demon:'ATK',celestial:'HEAL',spirit:'SOUL',titan:'HP',abyssal:'HEAL',fae:'드로우',veinforged:'DEF',savage:'ATK'};
    const RACE_SPEC = {human:'모든 인간 +레벨 1',beast:'야수의 분노 — 매 턴 야수 +1 ATK',dragon:'용의 격노 — 모든 적 3화상',avian:'하늘의 가호 — 비행족 회피',undead:'죽음의 행진 — 언데드 1 부활',demon:'지옥의 계약 — 영혼 +5',celestial:'구원의 빛 — 영웅 만피',spirit:'정령 융합 — 적 1체 기절',titan:'지각 변동 — 모든 적 −2',abyssal:'망각의 조류 — 적 손패 1 폐기',fae:'환상의 부름 — +2 드로우',veinforged:'강철 방벽 — 아군 DEF+2',savage:'광기의 외침 — 영웅 ATK×2'};

    const ELEM_KO = {fire:'불',water:'물',earth:'땅',lightning:'전기',holy:'신성',dark:'암흑'};
    const ELEM_EMOJI = {fire:'🔥',water:'💧',earth:'⛰️',lightning:'⚡',holy:'✨',dark:'🌑'};
    /* diagnosis-confirmed: 2026-06-15 사유: asset-fix — 옛 elem_icon3 6종 콘텐츠 위치 제각각(불/전기 우+51, 물/신성 중앙, 땅/암흑 좌-52 → 트레이 그림 어긋남). elem_icon_ctr = elem_icon3 크롭+중앙 재배치 신규파일(전부 ±2px, no-overwrite — elem_icon4 는 v2마이그레이션 기존자산이라 건드리지 않음). 버그 아님(asset 경로). */
    const ELEM_ICON = {fire:'img/ui/elements/elem_icon_ctr_fire.png',water:'img/ui/elements/elem_icon_ctr_water.png',earth:'img/ui/elements/elem_icon_ctr_earth.png',lightning:'img/ui/elements/elem_icon_ctr_lightning.png',holy:'img/ui/elements/elem_icon_ctr_holy.png',dark:'img/ui/elements/elem_icon_ctr_dark.png'};
    const ELEM_T3 = {fire:'매 턴 적 1체 화상',water:'매 턴 랜덤 아군 +1 회복',earth:'매 턴 랜덤 아군 1명 +1 DEF',lightning:'매 턴 적 1체 확정 기절',holy:'유닛 사망 시 1회 부활(50%) + 영웅 +2 회복',dark:'매 턴 적 1체 −1 HP'};
    const ELEM_T5 = {fire:'매 턴 전체 적 화상',water:'매 턴 전체 아군 +1 회복',earth:'매 턴 랜덤 아군 2명 +2 DEF',lightning:'매 턴 적 2체 확정 기절',holy:null,dark:'매 턴 전체 적 −1 HP + 랜덤 아군 흡혈'};
    const ELEM_SPEC = {fire:'그라힘의 분노 — 전체 3화상 → 이후 전체 화상',water:'모라스의 자비 — 전체 만피 → 이후 전체 회복',earth:'에이드라 — 매 턴 전체 아군 +3 DEF (지속)',lightning:'브론테스의 벼락 — 전체 기절 → 이후 매 턴 2체 기절',holy:'세라피엘 — 물리 무적 1R → 이후 전체 회복',dark:'네크리온 — 전체 −3 + 전체 흡혈 → 이후 전체 −1'};

    const tierVal = (uN, solo) => (solo ? (SYN.tierSolo || TIER) : TIER)[Math.min(uN, 6)] || 0;
    const tierClass = (dN, val) => dN >= 6 ? 't6' : (val >= 3 ? 't5' : (val >= 2 ? 't34' : 't2'));

    const detailRows = (isElem, key, dN, uN, val) => {
      const row = (stg, tx, on, ex) => `<div class="d-row ${on ? 'on' : 'off'} ${ex || ''}"><span class="d-stage">${stg}</span><span class="d-txt">${tx == null ? '' : tx}</span></div>`;
      if(!isElem){
        const def = SYN.race[key] || {};
        return row('누적', `전원 +${val || 1} ${RACE_STAT[key] || def.stat || ''}`, uN >= 2)
             + row('6단계', RACE_SPEC[key], dN >= 6, 'spec');
      }
      const edef = SYN.element[key] || {};
      let r = '';
      if(edef.stat === 'ATK') r += row('누적', `전원 +${Math.ceil(val / 2) || 1} ATK`, uN >= 2);
      r += row('3단계', ELEM_T3[key], uN >= 3);
      if(ELEM_T5[key]) r += row('5단계', ELEM_T5[key], uN >= 5);
      r += row('6단계', ELEM_SPEC[key], dN >= 6, 'spec');
      return r;
    };

    const miniChip = (isElem, key, dN, uN) => {
      const def = isElem ? SYN.element[key] : SYN.race[key];
      if(!def) return '';
      const solo = !isElem && def.solo;
      const val = tierVal(uN, solo);
      if(!(val >= 1 || dN >= 6)) return '';     // 발동 중(효과값>=1)·6/6 특수만
      const tc = tierClass(dN, val);
      const special6 = dN >= 6;
      const icon = isElem ? ELEM_ICON[key] : RACE_ICON[key];
      const ko = (isElem ? ELEM_KO[key] : RACE_KO[key]) || key;
      const emoji = isElem ? (ELEM_EMOJI[key] || ko[0]) : ko[0];
      const chipIc = icon
        ? `<img class="mini-ic" src="${icon}" alt="" onerror="this.style.display='none'">`
        : `<span class="mini-ic mini-ic-txt">${emoji}</span>`;
      const headIc = icon ? `<img class="d-ic" src="${icon}" alt="" onerror="this.style.display='none'">` : '';
      const detail = `<div class="syn-detail">`
        + `<div class="d-head">${headIc}<span>${ko}</span><span class="d-cnt">${dN}/6</span></div>`
        + `<div class="d-sub">${isElem ? '원소' : '종족'} 시너지 · 유닛 <b>${uN}</b>${dN > uN ? ' + 영웅' : ''}${special6 ? ' · <b style="color:#f3c969">특수 발동</b>' : ''}</div>`
        + detailRows(isElem, key, dN, uN, val)
        + `</div>`;
      /* diagnosis-confirmed: 2026-06-15 사유: refactor — 세로 레이아웃이라 칩에 종족/원소 이름(mini-name) 추가 표시. 버그 아님. */
      return `<div class="syn-mini ${tc}">${chipIc}<span class="mini-name">${ko}</span><span class="mini-cnt">${dN}/6</span>${special6 ? '<span class="mini-star">⭐</span>' : ''}${detail}</div>`;
    };

    /* diagnosis-confirmed: 2026-06-15 사유: refactor — 옛 buildRow(전 진영 전체 나열)→dominant+솔로 필터 + 진영별 half(거울) 조립. 버그 아님(인디케이터 표시 로직, mockup v5 컨펌). */
    // ── 필터: 종족 = dominant 일반(동점 전부) + 솔로 전부 / 원소 = dominant(동점 전부). 6/6 항상 포함. ──
    const mkItems = (countMap, heroKey, isElem) => {
      const keys = new Set(Object.keys(countMap || {})); if(heroKey) keys.add(heroKey);
      return Array.from(keys).map(k => {
        const uN = (countMap && countMap[k]) || 0;
        const dN = uN + (heroKey === k ? 1 : 0);
        const def = isElem ? SYN.element[k] : SYN.race[k];
        const solo = !isElem && !!(def && def.solo);
        return { key:k, uN, dN, solo, isElem, active:(tierVal(uN, solo) >= 1 || dN >= 6) };
      });
    };
    const filterRace = (list) => {
      const act = list.filter(x => x.active), solos = act.filter(x => x.solo), norms = act.filter(x => !x.solo);
      let dom = [];
      if(norms.length){ const mx = Math.max.apply(null, norms.map(n => n.uN)); dom = norms.filter(n => n.uN === mx); }
      const sixes = act.filter(x => x.dN >= 6 && dom.indexOf(x) < 0 && solos.indexOf(x) < 0);
      dom.sort((a,b) => b.uN - a.uN); solos.sort((a,b) => b.uN - a.uN);
      return dom.concat(solos, sixes);    // dominant 먼저(=전선 맞닿음) → 솔로 → 6특수
    };
    const filterElem = (list) => {
      const act = list.filter(x => x.active);
      if(!act.length) return [];
      const mx = Math.max.apply(null, act.map(n => n.uN));
      const dom = act.filter(n => n.uN === mx).sort((a,b) => b.dN - a.dN);
      return dom.concat(act.filter(x => x.dN >= 6 && dom.indexOf(x) < 0));
    };
    const chipFor = (it) => miniChip(it.isElem, it.key, it.dN, it.uN);
    // ── 한 진영 half — 전선(중앙)에서 바깥 방향 [종족 dom→solo, 원소 라벨, 원소 칩]. enemy 는 통째 역순(위아래 거울). ──
    const buildHalf = (sideKey) => {
      const side = st[sideKey];
      if(!side) return { html:'', hasRace:false };
      const cnt = (typeof Match._countSynergy === 'function') ? Match._countSynergy(side) : {raceCount:{}, elemCount:{}, hero:null};
      const heroRace = (cnt.hero && cnt.hero.race) || null;
      const heroElem = (cnt.hero && cnt.hero.element) || null;
      const raceList = filterRace(mkItems(cnt.raceCount, heroRace, false));
      const elemList = filterElem(mkItems(cnt.elemCount, heroElem, true));
      const parts = raceList.map(chipFor);
      if(elemList.length){ parts.push('<div class="vgrp-lbl">원소</div>'); elemList.forEach(it => parts.push(chipFor(it))); }
      const ordered = (sideKey === 'enemy') ? parts.slice().reverse() : parts;
      return { html: ordered.join(''), hasRace: raceList.length > 0 };
    };
    const enemy = buildHalf('enemy'), player = buildHalf('player');
    const center = (enemy.hasRace || player.hasRace) ? '<div class="syn-center-lbl">종족</div>' : '';
    tray.innerHTML = '<div class="syn-half enemy">' + enemy.html + '</div>' + center + '<div class="syn-half player">' + player.html + '</div>';
  };

  // 보드 렌더 — 7 슬롯 grid + 가운데 영웅 cell.
  // 2026-05-16 — 좌우 자유 insert (HS 식): _drag.insertIdx 가 마우스 X 위치 따라 갱신,
  //              cellSpecs 빌드 시 그 자리에 empty 끼움. _renderBoard 가 dragover 마다 호출됨.
  // 2026-05-23 — C+ 안 (mockup/drop_glow/v7_C_both_sides.html 컨펌): drag 폐기 + click cast 통합.
  //              unit cast 진입 시 N+1 황금 dashed slot 동시 표시 (모든 가능한 insert 자리).
  UI._renderBoard = function(rowEl, board, sideKey, hero){
    if(!rowEl) return;
    /* diagnosis-confirmed: 2026-06-11 사유: bug-fix repro — code_audit_2026-06-11.md #6, 재현자+반증자 2중검증 통과. preview 는 #tcg-board-hover-preview 싱글톤이라 cell 재빌드(innerHTML='')와 무관하게 잔존, mouseleave 미발화. */
    // 2026-06-11 fix (code_audit #6) — 보드 재빌드 시 떠있는 호버 미리보기 강제 제거.
    //   cascade(사망/소환)로 호버 중이던 cell 이 사라지면 mouseleave 가 발화 안 돼
    //   #tcg-board-hover-preview 패널이 화면에 박제됨. 재빌드 진입 시 항상 hide (idempotent).
    if(typeof UI._hideBoardHoverPreview === 'function') UI._hideBoardHoverPreview();
    // 2026-06-09 버그1 fix — 보드를 갈아엎기 직전, 현재 화면 셀 rect 를 uid별 스냅샷.
    //   직전 프레임엔 곧 죽을 유닛도 살아서 렌더돼 있으므로 마지막 위치 보존 →
    //   _animUnitAttack 가 죽은 타겟(공격으로 kill)의 lunge 를 스냅샷 좌표로 재생 (씹힘 방지).
    rowEl.querySelectorAll('.tcg-board-cell').forEach(cell => {
      const card = cell.querySelector('.match-card[data-uid]');
      const uid = card && card.getAttribute('data-uid');
      if(uid) _lastBoardRects[uid] = cell.getBoundingClientRect();
    });
    rowEl.innerHTML = '';
    const dragUnitMode  = (_drag && _drag.card && _drag.card.kind === 'unit' && sideKey === 'player');
    const clickUnitMode = (_selected && _selected.kind === 'hand'
                           && _selected.card && _selected.card.kind === 'unit'
                           && sideKey === 'player');
    const unitInsertMode = dragUnitMode || clickUnitMode;
    // P0-12 fix (2026-05-16): 항상-on 토글 제거. is-drop-active 는 dragenter/dragleave 핸들러가 동적 처리.
    // 단 dragend 시 무조건 제거 (옛 잔존 방지).
    if(!unitInsertMode) rowEl.classList.remove('is-drop-active');
    const sideTag = (sideKey === 'enemy') ? 'e' : 'p';

    // P0-5 fix (2026-05-16): _heroLeftCount metadata 기반 cellSpecs build.
    // 옛 자동 중앙 룰 (heroVisualIdx = floor((N+1)/2)) 폐기 — 사용자 의도와 board[] insert mismatch.
    // 신 룰: side._heroLeftCount 가 영웅 왼쪽 board[] 개수. drop 시 마우스 X 따라 갱신.
    // default: floor((N+1)/2) — 옛 자동 중앙과 동일 시각 (회귀 호환).
    const side = Match.state && Match.state[sideKey];
    const defaultLeftCount = Math.floor((board.length + 1) / 2);
    const leftCount = (side && side._heroLeftCount != null)
      ? Math.max(0, Math.min(board.length, side._heroLeftCount))
      : defaultLeftCount;

    const cellSpecs = [];
    for(let i = 0; i < leftCount; i++){
      cellSpecs.push({type:'unit', boardIdx: i});
    }
    cellSpecs.push({type:'hero'});
    for(let i = leftCount; i < board.length; i++){
      cellSpecs.push({type:'unit', boardIdx: i});
    }

    // 2026-05-23 — C+ 안: unit cast 진입 시 N+1 황금 slot 모두 동시 삽입.
    //   cellSpecs (unit + hero) 의 양옆 각각에 empty 끼움 → 총 cellSpecs.length + 1 자리.
    //   각 empty 의 visualIdx = 최종 cellSpecs 배열에서의 index (click handler 에서 boardInsertIdx 계산).
    if(unitInsertMode && board.length < 5){
      const withInserts = [];
      for(let i = 0; i < cellSpecs.length; i++){
        withInserts.push({type:'empty'});
        withInserts.push(cellSpecs[i]);
      }
      withInserts.push({type:'empty'});
      cellSpecs.length = 0;
      cellSpecs.push(...withInserts);
    }

    // 렌더
    for(const spec of cellSpecs){
      const cell = document.createElement('div');
      cell.className = 'tcg-board-cell';
      cell.setAttribute('data-side', sideKey);

      if(spec.type === 'hero'){
        cell.classList.add('is-hero');
        cell.id = 'tcg-' + sideTag + '-hero';
        cell.setAttribute('data-target', 'hero');
        if(hero){
          _fillHeroCell(cell, hero, sideKey);
          const heroCardEl = cell.querySelector('.match-card');
          if(heroCardEl) heroCardEl.setAttribute('data-acted', hero._acted ? 'true' : 'false');
          cell.addEventListener('mouseenter', () => UI._showBoardHoverPreview(hero, true));
          cell.addEventListener('mouseleave', () => UI._hideBoardHoverPreview());
          cell.addEventListener('click', (ev) => {
            ev.stopPropagation();
            UI._onHeroClick(sideKey);
          });
        } else {
          cell.style.visibility = 'hidden';
        }
      } else if(spec.type === 'unit'){
        const boardIdx = spec.boardIdx;
        cell.setAttribute('data-board-idx', boardIdx);
        const u = board[boardIdx];
        if(u){
          const cardEl = _mkBoardUnit(u, boardIdx, sideKey);
          cardEl.setAttribute('data-acted', u._acted ? 'true' : 'false');
          cell.appendChild(cardEl);
          cell.classList.add('is-occupied');
          cell.addEventListener('mouseenter', () => UI._showBoardHoverPreview(u, false));
          cell.addEventListener('mouseleave', () => UI._hideBoardHoverPreview());
        }
      } else if(spec.type === 'empty'){
        // 2026-05-23 — C+ 안: 황금 dashed slot (＋글리프 + pulse + hover 확장).
        //   클릭 시 그 자리에 unit insert + _heroLeftCount 자동 갱신.
        cell.classList.add('is-unit-insert-slot');
        // visualIdx → boardInsertIdx + _heroLeftCount 갱신 공통 로직
        const _insertAtThisSlot = () => {
          const insertVisualIdx = cellSpecs.indexOf(spec);
          const heroVisualIdxInSpecs = cellSpecs.findIndex((s) => s.type === 'hero');
          let boardInsertIdx = 0;
          for(let j = 0; j < insertVisualIdx; j++){
            if(cellSpecs[j].type === 'unit') boardInsertIdx++;
          }
          const isLeftOfHero = insertVisualIdx < heroVisualIdxInSpecs;
          const playerSide = Match.state && Match.state.player;
          if(playerSide){
            const currentLeftCount = (playerSide._heroLeftCount != null)
              ? playerSide._heroLeftCount
              : Math.floor((playerSide.board.length + 1) / 2);
            playerSide._heroLeftCount = isLeftOfHero ? (currentLeftCount + 1) : currentLeftCount;
          }
          return boardInsertIdx;
        };
        // 클릭 = unit cast 발동 (handIdx + slotIdx)
        cell.addEventListener('click', (ev) => {
          ev.stopPropagation();
          if(!_selected || _selected.kind !== 'hand' || !_selected.card || _selected.card.kind !== 'unit') return;
          const boardInsertIdx = _insertAtThisSlot();
          const r = Match.api.playCard('player', _selected.handIdx, {slotIdx: boardInsertIdx});
          if(!r || !r.ok){
            if(r && r.reason) console.log('[match-ui] unit insert fail:', r.reason);
            return;
          }
          UI._cancelSelection();
        });
      }
      rowEl.appendChild(cell);
    }
  };

  // 2026-05-16 — 보드 row dragover 핸들러: 마우스 X 위치 따라 _drag.insertIdx 갱신 + 변경 시 재렌더
  // rAF throttle 로 매 frame 한 번만 처리
  let _dragoverRAF = null;
  function _onBoardRowDragOverUnit(ev, rowEl, sideKey){
    if(!_drag || !_drag.card || _drag.card.kind !== 'unit' || sideKey !== 'player') return;
    ev.preventDefault();
    if(_dragoverRAF) return;
    _dragoverRAF = requestAnimationFrame(() => {
      _dragoverRAF = null;
      // 마우스 X → 카드 사이 insertVisualIdx 계산
      // cells = hero + unit + empty 의 시각 순서. unit cards 와 hero 의 mid 비교.
      const visualCells = rowEl.querySelectorAll('.tcg-board-cell.is-occupied, .tcg-board-cell.is-hero');
      let insertIdx = visualCells.length;  // 끝
      for(let i = 0; i < visualCells.length; i++){
        const r = visualCells[i].getBoundingClientRect();
        if(ev.clientX < r.left + r.width / 2){
          insertIdx = i;
          break;
        }
      }
      // empty 가 hero 자리에 들어가면 hero 가 한 칸 밀려 보임 (헷갈림 방지 룰).
      // empty 가 hero 의 좌측이면 그대로, 우측이면 +1 보정 — 아니 이건 cellSpecs 빌드 시 hero 다음 자리 자동.
      // 단순화: insertIdx 가 visualCells 의 idx 와 일치. cellSpecs.splice 가 처리.
      if(_drag.insertIdx !== insertIdx){
        _drag.insertIdx = insertIdx;
        const board = Match.state && Match.state.player && Match.state.player.board;
        const hero = Match.state && Match.state.player && Match.state.player.hero;
        if(rowEl && board) UI._renderBoard(rowEl, board, 'player', hero);
      }
    });
  }
  UI._onBoardRowDragOverUnit = _onBoardRowDragOverUnit;

  // 2026-05-16 단계 2 — 보드 hover preview (우측 1032,130 에 1.6배 풀상세 카드)
  // 단계 4 의 dragState 도입 후 차단 분기 추가 예정 (TODO: dragState 체크)
  UI._showBoardHoverPreview = function(cardData, isHero){
    if(_drag) return;  // 단계 4 — 드래그 중 hover preview 차단 (사용자 명시 — 타겟 선택 우선)
    const preview = document.getElementById('tcg-board-hover-preview');
    if(!preview || !cardData) return;
    preview.innerHTML = '';
    // 2026-05-16 — preview 는 모든 unit (taunt 포함) hand frame 으로 강제
    // taunt unit 의 shield frame 자동 트리거 차단 (사용자 명시 — 쉴드유닛도 손패 일반 유닛 frame)
    const opts = {frameMode: 'hand'};
    if(isHero) opts.hero = true;
    const cardEl = mkMatchCard(cardData, opts);
    preview.appendChild(cardEl);
    preview.classList.add('is-visible');
  };
  UI._hideBoardHoverPreview = function(){
    const preview = document.getElementById('tcg-board-hover-preview');
    if(preview) preview.classList.remove('is-visible');
  };

  // 2026-05-16 단계 3 — 좌측 cast 카드 (0,130 에 1.6배 카드 등장 + 1.5s 후 사라짐)
  // 다음 카드 사용 시 즉시 cancel (이전 timer clear + 새 카드 등장)
  // 2026-05-23 — opts.persistent:true 면 timeout skip (cast 모드 유지용, mockup/hand_cast_block_hover/v2 컨펌)
  let _leftCastTimer = null;
  // 발화 강화(replace) 카드면 cast 시각용 업화구 카드 반환 (원본은 안 건드림 — 표시 전환만).
  //   표적 선택 미리보기 + cast 좌측 표시 단일 진입점. pending 소비 후엔 그대로(이미 업화구 넘어옴).
  function _castVisualFor(card){
    if(!card || typeof Match._computeFireUpgrade !== 'function') return card;
    const st = Match.state;
    if(!st || st.side !== 'player') return card;
    const up = Match._computeFireUpgrade(st.player, card);
    if(up && up.mode === 'replace' && up.upId){
      const upSkill = (RoF.Data.SKILLS || []).find(s => s.id === up.upId);
      if(upSkill) return Object.assign({}, upSkill, {uid: card.uid});
    }
    return card;
  }
  UI._showLeftCast = function(card, opts){
    card = _castVisualFor(card);  // 발화 replace 면 업화구 시각 (표적 선택 미리보기 포함)
    const castCard = document.getElementById('tcg-spell-cast-card');
    if(!castCard || !card) return;
    // 이전 cast 가 진행 중이면 즉시 cancel
    if(_leftCastTimer){ clearTimeout(_leftCastTimer); _leftCastTimer = null; }
    castCard.classList.remove('is-cancelling', 'is-showing');
    castCard.innerHTML = '';
    const cardEl = mkMatchCard(card);
    castCard.appendChild(cardEl);
    // 다음 frame 에 표시 (transition 발동)
    requestAnimationFrame(() => castCard.classList.add('is-showing'));
    // 2026-05-23 — persistent 모드: timeout 안 설정. _cancelSelection 또는 발동 시 직접 제거.
    if(opts && opts.persistent) return;
    // 1.5s 후 사라짐 (kind 따라 부서짐/페이드)
    _leftCastTimer = setTimeout(() => {
      const inner = castCard.querySelector('.match-card');
      if(card.kind === 'spell-target' || card.kind === 'spell-aoe'){
        // spell 류 — 부서짐 (tcgUnitDeath 0.8s)
        if(inner) inner.classList.add('is-dying');
        setTimeout(() => {
          castCard.innerHTML = '';
          castCard.classList.remove('is-showing');
          _leftCastTimer = null;
        }, 800);
      } else {
        // unit / attach 류 — 단순 페이드 (is-cancelling)
        castCard.classList.add('is-cancelling');
        setTimeout(() => {
          castCard.innerHTML = '';
          castCard.classList.remove('is-showing', 'is-cancelling');
          _leftCastTimer = null;
        }, 200);
      }
    }, 1500);
  };

  // 마나 크리스탈 — battle_v3.jsx 시안 (좌하단 SVG 다이아 + 5칸 orb grid)
  // 2026-05-14 사용자 — 양측 영혼력 + 턴 기반 활성/비활성 (비활성 측 grayscale).
  let _lastRound = -1;
  let _lastChargeSide = null;
  UI._renderManaCrystal = function(st){
    if(!st || !st.player) return;
    // 2026-05-12 fix: 코어 state 필드는 'soulPool' (옛 'soul' / 'soulMax' 박혀있던 UI bug 정정).
    // 2026-05-24 사용자 명시 "기본 5/5 로 해줘" — PHASE 6 영웅.SOUL base=5, soulPool 누적 X (battle_system_decisions 2026-05-10) → max=5 정합.
    const max = 5;
    // player
    const pCur = st.player.soulPool || 0;
    const pCurEl = document.getElementById('tcg-p-soul');
    const pMaxEl = document.getElementById('tcg-mana-max');
    if(pCurEl) pCurEl.textContent = pCur;
    if(pMaxEl) pMaxEl.textContent = max;
    // enemy (2026-05-14 신규)
    const eCur = (st.enemy && st.enemy.soulPool) || 0;
    const eCurEl = document.getElementById('tcg-e-soul');
    const eMaxEl = document.getElementById('tcg-mana-max-enemy');
    if(eCurEl) eCurEl.textContent = eCur;
    if(eMaxEl) eMaxEl.textContent = max;
    // 턴 기반 is-inactive toggle — st.side === 'player' 면 enemy 비활성, 반대도 동일.
    const activeSide = st.side || 'player';
    const pCrystal = document.getElementById('tcg-mana-player');
    const eCrystal = document.getElementById('tcg-mana-enemy');
    if(pCrystal) pCrystal.classList.toggle('is-inactive', activeSide !== 'player');
    if(eCrystal) eCrystal.classList.toggle('is-inactive', activeSide !== 'enemy');
    // 옛 orb grid (단일 구체로 폐기 — 호환 위해 존재 시 클리어)
    const orbs = document.getElementById('tcg-mana-orbs');
    if(orbs) orbs.innerHTML = '';
    // P0-12 fix (2026-05-17): 양쪽 영혼력 충전 애니 — 옛 흐름은 activeSide 만 → player 측 누락 인지.
    // 매 라운드 양측 영혼 0→hero.SOUL 충전이므로 양쪽 다 애니 재생.
    const roundChanged = (st.round !== _lastRound);
    if(roundChanged && st.round >= 1){
      _lastRound = st.round;
      _lastChargeSide = activeSide;
      setTimeout(() => {
        UI._playSoulChargeAnim('player');
        UI._playSoulChargeAnim('enemy');
      }, 100);
    }
  };

  // 영혼력 충전 애니 (V1 파티클 트레일, mockup/soul_charge_anim/v1.html 시안 컨펌 2026-05-14)
  // 활성 측 영웅 cell 위치 → 영혼력 구체로 보라/황금 dot 12개 베지에 곡선 흡수 + 숫자 0→hero.SOUL 카운트업.
  UI._playSoulChargeAnim = function(sideKey){
    const heroId = sideKey === 'player' ? 'tcg-p-hero' : 'tcg-e-hero';
    const orbId  = sideKey === 'player' ? 'tcg-mana-player' : 'tcg-mana-enemy';
    const soulNumId = sideKey === 'player' ? 'tcg-p-soul' : 'tcg-e-soul';
    const heroEl = document.getElementById(heroId);
    const orbEl  = document.getElementById(orbId);
    const numEl  = document.getElementById(soulNumId);
    const stage  = document.getElementById('tcg-screen');
    if(!heroEl || !orbEl || !numEl || !stage) return;
    // stage 기준 상대 좌표 (game-root scale 적용된 화면 좌표 → stage 기준 차감 → base 1280×720 좌표)
    const stageR = stage.getBoundingClientRect();
    const heroR  = heroEl.getBoundingClientRect();
    const orbR   = orbEl.getBoundingClientRect();
    const scale  = stageR.width / 1280;  // game-root scale 역산
    const startX = (heroR.left - stageR.left + heroR.width / 2) / scale;
    const startY = (heroR.top  - stageR.top  + heroR.height / 2) / scale;
    const endX   = (orbR.left  - stageR.left + orbR.width / 2) / scale;
    const endY   = (orbR.top   - stageR.top  + orbR.height / 2) / scale;
    const targetSoul = (sideKey === 'player' ? (Match.state.player.soulPool || 0) : (Match.state.enemy.soulPool || 0));
    if(targetSoul <= 0) return;  // 충전 안 됐으면 애니 X
    // 충전 시작: 숫자 0 으로 리셋 (애니 끝나면서 targetSoul 까지 카운트업)
    numEl.textContent = 0;
    const total = 12;  // 파티클 12개
    let charged = 0;
    for(let i = 0; i < total; i++){
      setTimeout(() => {
        const p = document.createElement('div');
        p.className = 'tcg-soul-particle ' + (i % 2 === 0 ? 'purple' : 'gold');
        const offX = (Math.random() - .5) * 80;
        const offY = (Math.random() - .5) * 80;
        p.style.left = (startX + offX - 7) + 'px';
        p.style.top  = (startY + offY - 7) + 'px';
        stage.appendChild(p);
        const midX = (startX + endX) / 2 + (Math.random() - .5) * 200;
        const midY = (startY + endY) / 2 + (Math.random() - .5) * 100;
        const duration = 700 + Math.random() * 200;
        const start = performance.now();
        function animate(t){
          const elapsed = t - start;
          const u = Math.min(elapsed / duration, 1);
          const x = (1-u)*(1-u)*(startX+offX) + 2*(1-u)*u*midX + u*u*endX;
          const y = (1-u)*(1-u)*(startY+offY) + 2*(1-u)*u*midY + u*u*endY;
          p.style.left = (x - 7) + 'px';
          p.style.top  = (y - 7) + 'px';
          p.style.opacity = u < .1 ? u * 10 : (u > .9 ? (1 - u) * 10 : 1);
          if(u < 1) requestAnimationFrame(animate);
          else {
            p.remove();
            charged++;
            // 파티클 도착마다 누적 진행률로 숫자 갱신 + pulse
            if(charged % Math.ceil(total / targetSoul) === 0 || charged === total){
              const cur = Math.min(targetSoul, Math.ceil((charged / total) * targetSoul));
              numEl.textContent = cur;
              orbEl.classList.add('is-charge-pulse');
              setTimeout(() => orbEl.classList.remove('is-charge-pulse'), 250);
            }
          }
        }
        requestAnimationFrame(animate);
      }, i * 60);
    }
  };

  // TURN 패널 — battle_v3.jsx 시안 (우 정중앙)
  UI._renderTurnPanel = function(st){
    if(!st) return;
    const turnEl = document.getElementById('tcg-turn-num');
    const roundEl = document.getElementById('tcg-round-num');
    if(turnEl) turnEl.textContent = String(st.turn || 1).padStart(2, '0');
    if(roundEl) roundEl.textContent = Math.ceil((st.turn || 1) / 2);

    // 2026-05-15 PHASE 6 UX 강화 — 보드 큐 진행 바 (사용자 컨펌 mockup/phase6_ux_v1 v3).
    // sideKey 만 strict alternate (P→E→P→E 순서). cursor 위치 = 진행 위치.
    // unit 식별 X — 사용자가 자기 차례에 어떤 unit 으로 행동할지 자유 선택.
    UI._renderQueueBar(st);
  };

  // 보드 큐 진행 바 — phase=board 일 때만 표시 (CSS 가 card phase 시 display:none).
  // 2026-05-25 v3 모래시계 통합 — host 가 #tcg-hg-hud 안 정적 #tcg-qb-cells (옛 #tcg-turn-panel 폐기됨).
  UI._renderQueueBar = function(st){
    const cells = document.getElementById('tcg-qb-cells');
    if(!cells) return;
    const queue  = st.boardTurnQueue || [];
    const cursor = st.boardTurnCursor | 0;
    cells.innerHTML = '';
    if(!queue.length) return;
    queue.forEach((entry, idx) => {
      const cell = document.createElement('div');
      cell.className = 'qb-cell qb-' + (entry.sideKey === 'enemy' ? 'e' : 'p');
      if(idx < cursor) cell.classList.add('qb-done');
      if(idx === cursor) cell.classList.add('qb-active');
      cell.title = (entry.sideKey === 'enemy' ? '적' : '아군') + ' #' + (idx + 1) +
                   (entry._groupStart || entry._grouped ? ' (자동 연속)' : '');
      cells.appendChild(cell);
    });
  };

  // design-confirmed: 2026-05-13 영웅 매치 progression 위젯 — rules/04-balance.md 정본
  // custom: 단순 SVG ring 게이지 (36×36), 외부 라이브러리 없음
  // 영웅 cell (보드 idx=3) 좌상단에 원형 게이지 + Lv 텍스트. CSS 룰 (line 655+) 활용.
  // XP / matchXPNext 비율로 stroke-dashoffset 갱신 → CSS transition .35s 자동 차오름.
  // 2026-05-16 — 유닛 progression ring widget (영웅과 동일 패턴, Lv 2+ 만 표시)
  // design-confirmed: 2026-05-16 mockup/unit_progress/v1_compare.html B3 사용자 컨펌
  // custom: 게임 IP — 카드 cost coin 안 ring + Lv (영웅 widget 재사용)
  UI._renderUnitProgress = function(st){
    if(!st) return;
    const CIRC = 94.25;
    ['player', 'enemy'].forEach(sideKey => {
      const side = st[sideKey];
      if(!side || !Array.isArray(side.board)) return;
      const rowId = sideKey === 'player' ? 'tcg-p-board' : 'tcg-e-board';
      const row = document.getElementById(rowId);
      if(!row) return;
      // board unit cell 마다 — _matchLevel, _matchExp 확인 + Lv 2+ 만 widget
      side.board.forEach(unit => {
        if(!unit || !unit.uid) return;
        const cardEl = row.querySelector('.match-card[data-uid="' + unit.uid + '"]');
        if(!cardEl) return;
        const costCoin = cardEl.querySelector('.cost') || cardEl.querySelector('.atk-icon');
        if(!costCoin) return;
        const lv = unit._matchLevel || 1;
        let widget = costCoin.querySelector(':scope > .tcg-hero-progress');
        // P0-13 fix (2026-05-16): Lv 1 의 XP 1점 차는 것도 시각 표시. 옛 룰 "Lv 2+ 만" 폐기.
        // 사용자 명시 "오공의 1exp 차는 게 안 보여" — 모든 unit 에 widget 표시.
        // Lv 2+ — widget 생성/갱신
        if(!widget){
          widget = document.createElement('div');
          widget.className = 'tcg-hero-progress';
          widget.setAttribute('data-side', sideKey);
          widget.innerHTML =
            '<svg class="hpr-svg" viewBox="0 0 36 36">' +
              '<circle class="hpr-bg" cx="18" cy="18" r="15" fill="none"></circle>' +
              '<circle class="hpr-fg" cx="18" cy="18" r="15" fill="none" ' +
                      'stroke-dasharray="' + CIRC + '" ' +
                      'transform="rotate(-90 18 18)"></circle>' +
            '</svg>' +
            '<div class="hpr-lv"></div>';
          costCoin.appendChild(widget);
        }
        const exp = unit._matchExp || 0;
        const xpNext = unit._matchXpNext || 2;
        const ratio = Math.max(0, Math.min(1, exp / xpNext));
        const fg = widget.querySelector('.hpr-fg');
        if(fg) fg.style.strokeDashoffset = (CIRC * (1 - ratio)).toFixed(2);
        const lvEl = widget.querySelector('.hpr-lv');
        if(lvEl) lvEl.textContent = 'Lv' + lv;
      });
    });
  };

  UI._renderHeroProgress = function(st){
    if(!st) return;
    const CIRCUMFERENCE = 94.25;  // 2π × r=15
    ['player', 'enemy'].forEach(sideKey => {
      const hero = st[sideKey] && st[sideKey].hero;
      if(!hero) return;
      const rowId = sideKey === 'player' ? 'tcg-p-board' : 'tcg-e-board';
      // 2026-05-16 fix — cells[3] 하드코딩 → class 'is-hero' 자동 찾기.
      // 옛 cells[3] 은 unit 5장 + 영웅 1 (N=6 → heroIdx=3) 만 정합. board.length 변동 시 잘못된 cell 에 widget 부착 → XP 갱신 표시 안 보이는 버그.
      const heroCell = document.querySelector('#' + rowId + ' .tcg-board-cell.is-hero');
      if(!heroCell) return;
      // custom: 사용자 명시 "센터로" — widget 을 cost coin 자식으로 append → 100% width/height → 자동 정합
      // design-confirmed: 2026-05-13 (mockup/hero_progress/v2.html 컨펌 + "센터로")
      const costCoin = heroCell.querySelector('.cost');
      const parent = costCoin || heroCell;  // cost coin 안에 직접 추가
      let widget = parent.querySelector(':scope > .tcg-hero-progress');
      if(!widget){
        widget = document.createElement('div');
        widget.className = 'tcg-hero-progress';
        widget.setAttribute('data-side', sideKey);
        widget.innerHTML =
          '<svg class="hpr-svg" viewBox="0 0 36 36">' +
            '<circle class="hpr-bg" cx="18" cy="18" r="15" fill="none"></circle>' +
            '<circle class="hpr-fg" cx="18" cy="18" r="15" fill="none" ' +
                    'stroke-dasharray="' + CIRCUMFERENCE + '" ' +
                    'transform="rotate(-90 18 18)"></circle>' +
          '</svg>' +
          '<div class="hpr-lv"></div>';
        parent.appendChild(widget);
      }
      const xp = hero.matchXP || 0;
      const xpNext = hero.matchXPNext || HERO_XP_PER_LEVEL_FALLBACK;
      const ratio = Math.max(0, Math.min(1, xp / xpNext));
      const fg = widget.querySelector('.hpr-fg');
      if(fg) fg.style.strokeDashoffset = (CIRCUMFERENCE * (1 - ratio)).toFixed(2);
      const lvEl = widget.querySelector('.hpr-lv');
      if(lvEl) lvEl.textContent = 'Lv' + (hero.matchLevel || 1);
    });
  };
  const HERO_XP_PER_LEVEL_FALLBACK = 2;

  // 검 인디케이터 V2 (Plan 2.D, 2026-05-12 갤러리 컨펌)
  // - side='player' 면 player 검 active, 'enemy' 면 enemy 검 active
  // - phase='card' 면 #tcg-screen 에 .is-phase-card (펄스 애니), phase='board' 면 .is-phase-board (진동 애니)
  UI._renderSword = function(st){
    if(!st) return;
    const tcg = document.getElementById('tcg-screen');
    if(!tcg) return;
    tcg.classList.toggle('is-phase-card',  st.phase === 'card');
    tcg.classList.toggle('is-phase-board', st.phase === 'board');
    const pSword = document.getElementById('tcg-sword-player');
    const eSword = document.getElementById('tcg-sword-enemy');
    if(pSword) pSword.classList.toggle('is-active', st.side === 'player' && !st.winner);
    if(eSword) eSword.classList.toggle('is-active', st.side === 'enemy'  && !st.winner);
  };

  // 적 손패 fan-down — battle_v3.jsx 시안 (top:-40 CardBack 6장 장식)
  UI._renderOppHand = function(st){
    const oppHand = document.getElementById('tcg-opp-hand');
    if(!oppHand || !st || !st.enemy) return;
    oppHand.innerHTML = '';
    const count = Math.min(6, (st.enemy.hand || []).length || 0);
    for(let i = 0; i < count; i++){
      const cb = document.createElement('div');
      cb.className = 'tcg-opp-card-back';
      const offset = (i - (count - 1) / 2);
      cb.style.transform = 'translateY(' + (-Math.abs(offset) * 4) + 'px) rotate(' + (offset * -4) + 'deg)';
      oppHand.appendChild(cb);
    }
  };

  function _mkBoardUnit(unit, boardIdx, sideKey){
    const el = mkMatchCard(unit, {boardUnit: true});
    el.setAttribute('data-board-idx', boardIdx);
    el.setAttribute('data-side', sideKey);
    el.classList.toggle('is-exhausted', !!unit.exhausted && sideKey === Match.state.side);
    // Task A.4 (2026-05-10) — 보드턴 행동 완료 → 회색 굳음 (v2 강한 석화). _beginRound 에서 reset.
    el.classList.toggle('is-acted', !!unit._acted);
    el.classList.toggle('is-dead', !!unit.isDead);
    if(_selected && _selected.kind === 'attacker' && _selected.uid === unit.uid){
      el.classList.add('is-attacker-active');
    }
    if(UI._isValidTargetForSelected(sideKey, unit.uid)){
      el.classList.add('is-target-valid');
    }
    el.addEventListener('click', (ev) => {
      ev.stopPropagation();
      UI._onUnitClick(sideKey, unit);
    });

    // P0-10 fix (2026-05-17): 보드 유닛 드래그 공격 — board phase 자기 차례 + _acted=false + 살아있음.
    // 옛 룰 `st.side === 'player'` 은 board phase cursor sync 전이라 false → draggable 안 됨.
    // 신 룰: _isPlayerActable (board cursor.sideKey === player) + unit._acted 검사 + 보드 페이즈 한정.
    const st = Match.state;
    const isBoardPhase = st && st.phase === 'board';
    const canAttack = (
      isBoardPhase &&
      sideKey === 'player' && _isPlayerActable(st) && !st.winner &&
      !unit.isDead && !unit.exhausted && !unit.attackedThisTurn && !unit._acted
    );
    if(canAttack){
      el.setAttribute('draggable', 'true');
      el.addEventListener('dragstart', (ev) => _onBoardUnitDragStart(unit, ev));
      el.addEventListener('dragend',   () => _onBoardUnitDragEnd());
    }

    // P1: 모든 유닛이 drop target — drag 종류에 따라 분기 (검사는 _isValidDropOnUnit)
    el.addEventListener('dragover', (ev) => {
      if(!_drag) return;
      if(_isValidDropOnUnit(sideKey, unit)){
        ev.preventDefault();
        el.classList.add('is-drop-hover');
      }
    });
    el.addEventListener('dragleave', () => el.classList.remove('is-drop-hover'));
    el.addEventListener('drop', (ev) => {
      ev.preventDefault();
      el.classList.remove('is-drop-hover');
      if(!_drag || !_isValidDropOnUnit(sideKey, unit)) return;
      _onDropToUnit(sideKey, unit);
    });

    return el;
  }

  // P1: drag 종류 + 타겟 측 + unit 상태 검사
  function _isValidDropOnUnit(targetSideKey, targetUnit){
    if(!_drag) return false;
    if(targetUnit.isDead) return false;
    // 보드→공격 (drag.kind === 'attack')
    if(_drag.kind === 'attack'){
      if(targetSideKey !== 'enemy') return false;
      const taunts = Match.state.enemy.board.filter(u => !u.isDead && (u.keywords||[]).includes('taunt'));
      if(taunts.length > 0) return taunts.some(t => t.uid === targetUnit.uid);
      return true;
    }
    // 손패 카드 드래그
    if(_drag.card){
      const k = _drag.card.kind;
      if(k === 'spell-target'){
        /* diagnosis-confirmed: 2026-06-06 사유: feature — (B) 근접/원거리 스펠 taunt 우선, magic 자유 저격. */
        const dt = _drag.card.dmgType || 'magic';
        // 2026-06-12 — magic 또는 pierce:'taunt'(수호자 무시) 스펠은 taunt 강제 우회 (자유 타겟).
        if(dt === 'magic' || Match._cardPiercesTaunt(_drag.card) || targetSideKey === 'player') return true;
        const taunts = Match.state.enemy.board.filter(u => !u.isDead && (u.keywords||[]).includes('taunt'));
        return taunts.length ? taunts.some(t => t.uid === targetUnit.uid) : true;
      }
      if(k === 'attach-unit')  return targetSideKey === 'player';
    }
    return false;
  }

  function _onBoardUnitDragStart(unit, ev){
    const st = Match.state;
    if(!st || st.winner || st.side !== 'player') return;
    if(unit.isDead || unit.exhausted || unit.attackedThisTurn) return;
    _drag = {kind: 'attack', uid: unit.uid};
    if(ev.dataTransfer){
      ev.dataTransfer.effectAllowed = 'move';
      try { ev.dataTransfer.setData('text/plain', unit.uid); } catch(e){}
    }
    // attacker 셀렉션도 함께 — 스킬 라인 SVG 가 자연 표시
    _selected = {kind: 'attacker', uid: unit.uid};
    UI.renderState();
  }

  function _onBoardUnitDragEnd(){
    _drag = null;
    _selected = null;
    UI.renderState();
  }

  // 영웅 슬롯 drop 검사 (bindStatic 의 영웅 핸들러에서 사용)
  function _isValidDropOnHero(targetSideKey){
    if(!_drag) return false;
    if(_drag.kind === 'attack'){
      if(targetSideKey !== 'enemy') return false;
      const taunts = Match.state.enemy.board.filter(u => !u.isDead && (u.keywords||[]).includes('taunt'));
      return taunts.length === 0;  // taunt 있으면 영웅 공격 불가
    }
    if(_drag.card){
      const k = _drag.card.kind;
      if(k === 'spell-target'){
        /* diagnosis-confirmed: 2026-06-06 사유: feature — (B) 근접/원거리 스펠은 적 taunt 있으면 영웅 직접 공격 불가, magic 은 자유. */
        const dt = _drag.card.dmgType || 'magic';
        // 2026-06-12 — magic 또는 pierce:'taunt'(수호자 무시) 스펠은 taunt 있어도 영웅 직접 타격 가능.
        if(dt === 'magic' || Match._cardPiercesTaunt(_drag.card) || targetSideKey === 'player') return true;
        const taunts = Match.state.enemy.board.filter(u => !u.isDead && (u.keywords||[]).includes('taunt'));
        return taunts.length === 0;
      }
      if(k === 'attach-hero')  return targetSideKey === 'player';  // 자기 영웅에만 부착 (코어 룰)
    }
    return false;
  }

  function _onDropToUnit(targetSideKey, targetUnit){
    if(!_drag) return;
    if(_drag.kind === 'attack'){
      // P0-6 fix (2026-05-16): 카드 페이즈 보드 공격 차단 (UI 단계)
      if(Match.state && Match.state.phase !== 'board') return;
      const r = Match.api.attack('player', _drag.uid, {targetUid: targetUnit.uid});
      if(!r.ok) console.log('[match-ui] drag attack fail:', r.reason);
    } else if(_drag.card){
      const k = _drag.card.kind;
      if(k === 'spell-target' || k === 'attach-unit'){
        const targetSide = (targetSideKey === 'player') ? 'ally' : 'enemy';
        const r = Match.api.playCard('player', _drag.handIdx, {
          targetSide,
          targetUid: targetUnit.uid,
        });
        if(!r.ok) console.log('[match-ui] drag card fail:', r.reason);
      }
    }
    _drag = null;
    _selected = null;
    UI.renderState();
  }

  // _mkDropSlot 통째 trash (2026-05-24) — 호출처 0건. 손패 drag = 클릭 치환 패턴 (_onHandDragStart) 정착으로 drop slot 자체 dead.

  // 손패 카드 호버 unhover 글로벌 트래킹 — 매치 화면 안 손패 외 영역 mouse 이동 시 자동 호버 해제 (2026-05-08).
  // 2026-05-20 update — 손패 컨테이너 자체 (padding 확장 영역 포함) 안이면 호버 유지.
  // 호버 hit area 확장 (.tcg-hand padding-top:480px) 의 빈 영역 위 마우스도 호버 유지.
  let _handHoverGlobalInited = false;
  function _setupHandHoverGlobal(){
    if(_handHoverGlobalInited) return;
    const tcgScreen = document.getElementById('tcg-screen');
    if(!tcgScreen) return;
    _handHoverGlobalInited = true;
    tcgScreen.addEventListener('mouseover', (e) => {
      const handEl = document.getElementById('tcg-hand');
      if(!handEl) return;
      // 손패 컨테이너 자체 또는 자식 안 = 호버 유지 (padding 확장 영역 포함)
      const isInHandContainer = handEl === e.target || handEl.contains(e.target);
      if(!isInHandContainer){
        handEl.querySelectorAll('.tcg-hand-card.is-hover').forEach(c => c.classList.remove('is-hover'));
        // self-only(스펠주인) hint 제거 — 캐스트 모드면 renderState 가 관리하므로 영역 이탈 시 건드리지 않음 (2026-06-07)
        if(!_selected) _clearSelfTargetHint();
        // B 방식 강화 — 호버 영역 떠나면 숫자 원본값 복원.
        if(UI._updateEnhHoverState) UI._updateEnhHoverState();
      }
    });
  }

  // ───── 범용 카드 강화 미리보기 (2026-06-03, B 방식 — 발화 등 강화 스킬 공용) ─────
  // 평상시: ⚡ 마크 + 글로우(CSS). 카드 숫자/이미지는 원본 그대로 (덮어쓰기 금지 — feedback_no_overwrite_card_numbers).
  // 호버 시: _updateEnhHoverState 가 숫자 element 의 textContent 를 강화값으로 교체 + is-buffed/is-nerfed/is-flashing
  //          (보드유닛 레벨업과 동일 애니 재사용). 호버 해제 시 원본값 복원.
  function _firstDmg(c){
    const e = ((c && c.effects) || []).find(x => x && x.op === 'damage');
    return e ? (e.amount || 0) : null;
  }
  function _addSpark(cardWrap){
    if(!cardWrap) return;
    const spark = document.createElement('div');
    spark.className = 'cv4-enh-spark';
    spark.textContent = '⚡';
    cardWrap.appendChild(spark);
  }
  // 강화 카드에 ⚡ 추가 + 호버 전환에 쓸 강화값을 숫자 element 의 data-* 에 저장 (원본은 안 건드림). [x2 모드]
  function _markEnhanceValues(cardWrap, baseCard, up){
    if(!cardWrap) return;
    _addSpark(cardWrap);

    // NEED_SOUL (.cost) — 증가=nerf(핑크) / 감소=buff(초록)
    const cost = cardWrap.querySelector('.card-v4 .cost');
    const baseNS = baseCard.NEED_SOUL || 0;
    if(cost && up.needSoul !== baseNS){
      cost.dataset.enhOrig = cost.textContent.trim();
      cost.dataset.enhVal  = String(up.needSoul);
      cost.dataset.enhDir  = up.needSoul > baseNS ? 'nerf' : 'buff';
    }
    // 피해/ATK (.dmg-icon .num 또는 .atk-icon .num) — 강화 피해는 up.effects 에서
    const dmg = cardWrap.querySelector('.card-v4 .dmg-icon .num, .card-v4 .atk-icon .num');
    const bd = _firstDmg(baseCard), ud = _firstDmg({effects: up.effects});
    if(dmg && bd != null && ud != null && ud !== bd){
      dmg.dataset.enhOrig = dmg.textContent.trim();
      dmg.dataset.enhVal  = String(ud);
      dmg.dataset.enhDir  = ud > bd ? 'buff' : 'nerf';
    }
  }
  // 호버 상태 변화 시 호출 — 강화+호버 카드는 숫자를 강화값으로, 아니면 원본값으로 복원.
  function _updateEnhHoverState(){
    const handEl = document.getElementById('tcg-hand');
    if(!handEl) return;
    handEl.querySelectorAll('.tcg-hand-card.is-enhanced').forEach(slot => {
      const hovered = slot.classList.contains('is-hover');
      slot.querySelectorAll('[data-enh-val]').forEach(el => {
        const dir = el.dataset.enhDir === 'nerf' ? 'nerf' : 'buff';
        if(hovered){
          if(el.textContent.trim() !== el.dataset.enhVal){
            el.textContent = el.dataset.enhVal;
            el.classList.remove('is-buffed', 'is-nerfed');
            el.classList.add(dir === 'nerf' ? 'is-nerfed' : 'is-buffed');
            // flash 재생 — 클래스 제거 + reflow + 재추가 (보드유닛 stat-flash 재사용)
            const fl = dir === 'nerf' ? 'is-flashing-nerf' : 'is-flashing-buff';
            el.classList.remove('is-flashing-buff', 'is-flashing-nerf');
            void el.offsetWidth;
            el.classList.add(fl);
          }
        } else if(el.dataset.enhOrig != null){
          el.textContent = el.dataset.enhOrig;
          el.classList.remove('is-buffed', 'is-nerfed', 'is-flashing-buff', 'is-flashing-nerf');
        }
      });
    });
  }
  UI._updateEnhHoverState = _updateEnhHoverState;

  /* diagnosis-confirmed: 2026-06-03 사유: feature — 범용 카드 강화 미리보기 UI (발화). 버그 픽스 아님. */
  UI._renderHand = function(){
    _setupHandHoverGlobal();
    const st = Match.state;
    const hand = st.player.hand;
    // 2026-05-14 사용자 컨펌 V1 LoR 반응형 — 카드 수 N 에 따라 .tcg-hand 에 n-{N} class 부여.
    // CSS .tcg-hand.n-5~10 가 .tcg-hand-card margin-right 동적 override. transition .25s 자동.
    const handEl = document.getElementById('tcg-hand');
    if(handEl){
      const cnt = hand.filter(c => !!c).length;
      // 옛 n-* class 제거 후 신규 부여
      for(let k = 1; k <= 10; k++) handEl.classList.remove('n-' + k);
      if(cnt >= 1 && cnt <= 10) handEl.classList.add('n-' + cnt);
    }
    for(let i = 0; i < 10; i++){  // 2026-05-13 사용자 결정 (7 → 10)
      const slot = document.getElementById(`tcg-hand-${i+1}`);
      if(!slot) continue;
      slot.innerHTML = '';
      const card = hand[i];
      if(!card){
        slot.classList.add('is-empty');
        slot.classList.remove('is-enhanced', 'cost-up', 'cost-down');
        slot.removeAttribute('draggable');
        slot.onclick = null;
        slot.ondragstart = null;
        slot.ondragend = null;
        continue;
      }
      slot.classList.remove('is-empty');
      // 발화 강화 미리보기 — 강화될 화염 스펠이면 강화본 비주얼로 렌더 + 장식.
      //   replace: 업화구 데이터로 face 렌더 / x2: NEED_SOUL 2배 표시. 실 cast 는 playCard 가 처리.
      // ⚠️ 카드 숫자·이미지 덮어쓰기 금지 (feedback_no_overwrite_card_numbers).
      //   원본 카드 그대로 렌더 — 강화는 색(.cost-up/down + 피해 초록) + ⚡ + 글로우 + 호버 패널로만.
      let _enh = null;
      if(st.side === 'player' && typeof Match._computeFireUpgrade === 'function'){
        const up = Match._computeFireUpgrade(st.player, card);
        if(up) _enh = up;
      }
      const el = mkMatchCard(card);  // 원본 카드 (숫자/이미지 덮어쓰기 X)
      slot.classList.toggle('is-enhanced', !!_enh);
      slot.classList.remove('enh-has-upgrade');
      if(_enh){
        slot.dataset.enhMode = _enh.mode;
        if(_enh.mode === 'replace' && _enh.upId){
          // 호버 시 카드 전체를 상위카드(업화구)로 cross-fade. 평상시 원본 화염구 보존 (호버 시점 표시 전환).
          el.classList.add('enh-base');
          _addSpark(el);
          const upSkill = (RoF.Data.SKILLS || []).find(s => s.id === _enh.upId);
          if(upSkill){
            const elUp = mkMatchCard(Object.assign({}, upSkill, {uid: card.uid + '_up'}));
            elUp.classList.add('enh-upgraded');
            _addSpark(elUp);
            slot.appendChild(elUp);  // base 위에 absolute 겹침 (CSS)
            slot.classList.add('enh-has-upgrade');
          }
        } else {
          // x2 — 호버 시 숫자만 전환 (data 저장). _updateEnhHoverState 가 처리.
          _markEnhanceValues(el, card, _enh);
        }
      } else { delete slot.dataset.enhMode; }
      // 2026-05-16 — backend Match.canPlay 호출 (phase + SOUL + 보드 + kind 통합).
      // C 하이브리드 정본: 보드 페이즈에선 unit 카드 자동 거부 → data-playable=false → CSS dim.
      // 2026-05-29 #23/#31 — events 중 enemy 측 cascade 만 차단 (self cascade 통과).
      const isEnemyCascade = _hasEnemyCascade(st.events);
      const canPlayResult = (st.side === 'player' && !isEnemyCascade)
        ? Match.canPlay(st.player, card)
        : {ok:false, reason: isEnemyCascade ? '적 연출 중' : '적 차례'};
      const canPlay = canPlayResult.ok;
      slot.dataset.playable = canPlay ? 'true' : 'false';
      slot.dataset.reason   = canPlay ? '' : (canPlayResult.reason || '');
      slot.classList.toggle('is-disabled', !canPlay);
      slot.classList.toggle('is-selected', _selected && _selected.kind === 'hand' && _selected.handIdx === i);
      slot.appendChild(el);

      slot.onclick = () => UI._onHandClick(i);

      // 2026-05-16 — mousedown 시점에 호버 transform 즉시 제거 (transition 무효 + reflow 강제)
      // 빠른 드래그 시 transition .22s 가 진행 중이라 dragstart 시점에 카드가 아직 위쪽에 있어 ghost 위치 어긋남.
      // 해결: transition:none 강제 + reflow → transform 즉시 0 → dragstart 시 정상 위치.
      slot.onmousedown = () => {
        document.querySelectorAll('#tcg-hand .tcg-hand-card.is-hover').forEach(s => {
          s.style.transition = 'none';
          s.classList.remove('is-hover');
          // force reflow (transition 무효 + class 제거 즉시 적용)
          void s.offsetWidth;
          // transition 복원 (다음 hover 위해, dragstart 이벤트 발동 후 즉시)
          requestAnimationFrame(() => { s.style.transition = ''; });
        });
        // 자식 .match-card 의 transform 도 강제 reset
        const childCard = slot.querySelector('.match-card');
        if(childCard){
          childCard.style.transition = 'none';
          childCard.style.transform = '';
          void childCard.offsetWidth;
          requestAnimationFrame(() => { childCard.style.transition = ''; childCard.style.transform = ''; });
        }
      };

      // 호버 — mouseenter 시 .is-hover swap. mouseleave 는 컨테이너 단위 처리.
      // 2026-05-20 사용자 컨펌 (mockup/hand_hover_persistence/v5) — slot 단위 mouseleave 제거.
      // 컨테이너 .tcg-hand 의 padding-top:480px 확장 영역 안 호버 유지 + 영역 떠나야 축소.
      // 옆 카드 진입 = mouseenter 자동 swap (slot.onmouseleave 불필요).
      slot.onmouseenter = () => {
        const all = document.querySelectorAll('#tcg-hand .tcg-hand-card.is-hover');
        all.forEach(c => { if(c !== slot) c.classList.remove('is-hover'); });
        slot.classList.add('is-hover');
        // 2026-05-17 #12 / 2026-06-07 — self-only(스펠주인) 호버 시 소유 유닛 cell glow.
        //   캐스트 모드(_selected)면 renderState 가 hint 를 관리하므로 호버는 건드리지 않음.
        if(!_selected){
          _clearSelfTargetHint();
          if(_isSelfOnlyCard(card)) _showSelfTargetHint(card);
        }
        // B 방식 강화 — 호버 카드 숫자 강화값 전환 + 다른 카드 복원.
        _updateEnhHoverState();
      };
      // slot.onmouseleave 제거 — 컨테이너 단위 mouseleave (renderState 또는 한 번만 부착) 가 처리.

      // 드래그 가능 (사용 가능한 카드만)
      if(canPlay){
        slot.setAttribute('draggable', 'true');
        slot.ondragstart = (ev) => _onHandDragStart(i, card, ev);
      } else {
        slot.removeAttribute('draggable');
        slot.ondragstart = null;
      }
    }
  };

  UI._renderWinner = function(winner){
    const msg = winner === 'player' ? '⚔️ 승리!' : winner === 'enemy' ? '💀 패배...' : '⚖️ 무승부';
    // 2026-05-17 fix — 옛 overlay 잔존 (사용자 보고: 패배 화면 다음 매치까지 잔존) → 강제 제거 후 재생성
    const _old = document.getElementById('tcg-winner-overlay');
    if(_old && _old.parentNode) _old.parentNode.removeChild(_old);
    const ov = document.createElement('div');
    ov.id = 'tcg-winner-overlay';
    ov.style.cssText = 'position:absolute;inset:0;background:rgba(0,0,0,.75);display:flex;flex-direction:column;align-items:center;justify-content:center;z-index:200;color:#fff;font-family:Cinzel,serif;';
    ov.innerHTML = `<div style="font-size:3rem;margin-bottom:20px;">${msg}</div>` +
                   `<button class="btn btn-green" id="tcg-winner-back">메뉴로</button>`;
    document.getElementById('tcg-screen').appendChild(ov);
    document.getElementById('tcg-winner-back').onclick = () => {
      ov.remove();
      Match.state = null;
      _selected = null;
      _drag = null;
      _stopTimer();
      if(global.UI && global.UI.show) global.UI.show('town-screen');
    };
  };

  // ───── 입력 핸들러: 손패 클릭 (2026-05-22 통합 흐름 plan B-2 + B-0-3 분할) ─────
  // 새 흐름: 1차 클릭 = 좌측 cast + KIND_CAST_HANDLERS.onCast 시각화 + 셀렉션 셋업.
  // 2차 클릭 = _onUnitClick / _onHeroClick / _onStageClick 에서 발동.
  // 검수관 블로커 #3 채택 — 5책임 분할 (validate / toggle / setup / applyCast / render).

  // 2026-05-29 #31 — events 큐에 enemy 측 cascade events 가 있는지 검사.
  //   side 필드 일관성 X (일부 events 는 fromSide / attackerSide / targetSide 등 사용).
  //   목적: enemy 측 events 만 차단, self events / 글로벌 events 통과.
  function _hasEnemyCascade(events){
    if(!Array.isArray(events) || events.length === 0) return false;
    return events.some(e => {
      if(!e) return false;
      // side 필드 우선 (가장 흔함)
      if(e.side === 'enemy') return true;
      // fromSide (card-shatter 등)
      if(e.fromSide === 'enemy') return true;
      // attackerSide (unit-attack 등)
      if(e.attackerSide === 'enemy') return true;
      return false;
    });
  }

  function _validateHandClick(handIdx){
    const st = Match.state;
    if(!st || st.winner) return false;
    if(st.side !== 'player') return false;
    // 2026-05-29 — 적턴 정의 확장 (#23) + #31 사용자 보고 fix:
    //   옛 룰 (events.length > 0) 은 player 자기 cascade 중에도 차단 → 두 번째 unit cast 시 +칸 호버 안 됨.
    //   새 룰: events 중 **enemy 측 events** 만 차단. self events / 글로벌 events 통과.
    //   본질: endCardPhase 가 st.side 즉시 swap 하지만 enemy cascade 는 비동기 (_processEvents) → race window 차단.
    if(st.events && _hasEnemyCascade(st.events)){
      console.log('[match-ui] 적 cascade 처리 중 — 입력 차단');
      return false;
    }
    // phase=BOARD 시 unit 카드 거부 (18~19 deadlock 교훈 — 검수관 참고 #9)
    const card = st.player.hand[handIdx];
    if(!card) return false;
    if(st.phase === 'board' && card.kind === 'unit'){
      console.log('[match-ui] 보드 페이즈 unit 카드 X');
      return false;
    }
    if(st.player.soulPool < (card.NEED_SOUL || 0)){
      console.log('[match-ui] 영혼 부족');
      return false;
    }
    return true;
  }
  function _isHandSelectionToggle(handIdx){
    return _selected && _selected.kind === 'hand' && _selected.handIdx === handIdx;
  }
  function _setupHandSelection(handIdx, card){
    _selected = {kind:'hand', handIdx, card};
    // 호버 .is-hover 제거 (확대 카드 → 작은 카드 복귀)
    document.querySelectorAll('#tcg-hand .tcg-hand-card.is-hover').forEach(s => s.classList.remove('is-hover'));
    // 옛 .is-casting 모두 제거 (다른 카드 잔존 방지) + 새 카드만 부착
    document.querySelectorAll('#tcg-hand .tcg-hand-card.is-casting').forEach(s => s.classList.remove('is-casting'));
    const slot = document.querySelector('#tcg-hand .tcg-hand-card[data-hand-idx="' + handIdx + '"]');
    if(slot) slot.classList.add('is-casting');
    // 2026-05-23 — #tcg-screen .is-casting-mode 토글 (호버 확대 차단 CSS 룰 trigger)
    const tcg = document.getElementById('tcg-screen');
    if(tcg) tcg.classList.add('is-casting-mode');
  }
  function _applyCastVisual(card){
    // 2026-05-23 — persistent:true (cast 모드 유지용. _cancelSelection 또는 발동 시 직접 제거).
    UI._showLeftCast(card, {persistent: true});
    // 스펠주인(self-only) → AoE 하이라이트 대신 소유 유닛 글로우만 (renderState 캐스트 분기와 동일, 2026-06-07)
    if(_isSelfOnlyCard(card)){
      _showSelfTargetHint(card);
      return;
    }
    const h = KIND_CAST_HANDLERS[card.kind];
    if(h && h.onCast) h.onCast(card);
  }

  UI._onHandClick = function(handIdx){
    if(_isHandSelectionToggle(handIdx)){ UI._cancelSelection(); return; }
    if(!_validateHandClick(handIdx)) return;
    // 2026-05-23 — 다른 카드 클릭 시 이전 cast 자동 cancel + 새 cast 진입 (교체).
    // mockup/hand_cast_block_hover/v2.html 컨펌 룰.
    if(_selected && _selected.kind === 'hand'){
      const h = KIND_CAST_HANDLERS[_selected.card.kind];
      if(h && h.onClear) h.onClear();
    }
    const card = Match.state.player.hand[handIdx];
    _setupHandSelection(handIdx, card);
    // 2026-05-23 fix — renderState 먼저 호출 (DOM 재생성) → 그 다음 _applyCastVisual (is-target-attack 클래스 부착).
    // 옛 순서 (cast → render) 는 renderState 가 DOM 재생성하면서 클래스 날려서 영웅 빨강 안 보임 버그.
    UI.renderState();
    _applyCastVisual(card);
  };

  UI._onUnitClick = function(sideKey, unit){
    const st = Match.state;
    if(!st || st.winner) return;

    // 셀렉션이 손패 카드 (타겟 모드)
    if(_selected && _selected.kind === 'hand'){
      /* diagnosis-confirmed: 2026-06-07 사유: feature — 스펠주인(self-only) owner 셀 클릭 2차 발동 (염룡술 타겟 클릭과 동형). 글로우만 있고 발동 경로 없던 반쪽 상태 완결 */
      const card = _selected.card;
      // 스펠주인(self-only) — 글로우 뜬 owner(소유 유닛) 셀 클릭만 발동, 그 외 클릭 무시.
      //   글로우(_selfOwnerCell) 와 동일 기준(_resolveCaster) 으로 발동 → 시각=발동 1:1. (2026-06-07)
      if(_isSelfOnlyCard(card)){
        const owner = Match._resolveCaster ? Match._resolveCaster(st.player, card) : null;
        const ownerIsHero = !owner || (st.player.hero && owner.uid === st.player.hero.uid);
        if(!ownerIsHero && sideKey === 'player' && unit.uid === owner.uid){
          UI._showLeftCast(card);
          const r = Match.api.playCard('player', _selected.handIdx, {targetSide:'ally', targetUid: unit.uid});
          if(!r.ok) console.log('[match-ui] self-only unit play fail:', r.reason);
          UI._cancelSelection();
        }
        return;  // owner 외 클릭은 전부 무시 (잘못된 타겟 발동 방지)
      }
      const targetSide = (sideKey === 'player') ? 'ally' : 'enemy';
      // 단계 3 — 좌측 cast 카드 등장 (target 선택 후 cast 시점)
      if(_selected.card) UI._showLeftCast(_selected.card);
      const r = Match.api.playCard('player', _selected.handIdx, {
        targetSide,
        targetUid: unit.uid,
      });
      if(!r.ok) console.log('[match-ui] playCard fail:', r.reason);
      UI._cancelSelection();  // 2026-05-22 문제 1 fix — onClear 호출로 ghost/AoE 글로우/gap/is-casting 해제
      return;
    }

    // 셀렉션이 공격자
    if(_selected && _selected.kind === 'attacker'){
      if(sideKey === 'player'){
        if(unit.uid === _selected.uid){
          _selected = null;
        } else if(!unit.exhausted && !unit.attackedThisTurn && !unit.isDead){
          _selected = {kind:'attacker', uid: unit.uid};
        }
        UI.renderState();
        return;
      }
      // P0-6 fix (2026-05-16): 카드 페이즈 보드 공격 차단 (UI 단계)
      if(Match.state && Match.state.phase !== 'board'){
        _selected = null;
        UI.renderState();
        return;
      }
      const r = Match.api.attack('player', _selected.uid, {targetUid: unit.uid});
      if(!r.ok) console.log('[match-ui] attack fail:', r.reason);
      _selected = null;
      UI.renderState();
      return;
    }

    // 셀렉션 없음 — 아군 보드 유닛 클릭 → 공격자 선택
    // Plan 2.D fix (2026-05-12): phase=board 시 큐 cursor 의 sideKey 가 'player' 면 액션 가능 (st.side 무관)
    if(sideKey === 'player' && _isPlayerActable(st)){
      if(unit.exhausted || unit.attackedThisTurn || unit.isDead) return;
      if(unit._acted) return;  // 이미 보드턴 행동함
      // 2026-05-29 #19-3 — cursor.unitUid 강제 폐기 (사용자 의도: 자기 보드 어느 unit 이든 자유 선택).
      //   HS/Snap/LoR/M&M Fates 모두 표준. queue = 양측 turn 카운터 역할 (sword 시스템 정합).
      //   cursor.sideKey 검사는 _isPlayerActable 가 담당 (player 차례 강제).
      _selected = {kind:'attacker', uid: unit.uid};
      UI.renderState();
    }
  };

  // phase 별 player 액션 가능 여부 (2026-05-12 보드 페이즈 attack UI 차단 사고 fix)
  function _isPlayerActable(st){
    if(!st || st.winner) return false;
    if(st.phase === 'board'){
      const entry = (st.boardTurnQueue || [])[st.boardTurnCursor | 0];
      return entry && entry.sideKey === 'player';
    }
    return st.side === 'player';
  }

  UI._onHeroClick = function(sideKey){
    const st = Match.state;
    if(!st || st.winner) return;
    const hero = st[sideKey].hero;
    if(!hero) return;

    // 셀렉션이 손패(타겟형) — 영웅을 타겟으로
    if(_selected && _selected.kind === 'hand'){
      /* diagnosis-confirmed: 2026-06-07 사유: feature — 스펠주인(self-only) owner=영웅 시 자기 영웅 클릭 2차 발동 (attach-hero/중립 self) */
      const selfCard = _selected.card;
      // 스펠주인(self-only) — owner 가 영웅이면 자기 영웅 클릭 = 발동. owner=동료면 영웅 클릭 무시. (2026-06-07)
      if(_isSelfOnlyCard(selfCard)){
        const owner = Match._resolveCaster ? Match._resolveCaster(st.player, selfCard) : null;
        const ownerIsHero = !owner || (st.player.hero && owner.uid === st.player.hero.uid);
        if(ownerIsHero && sideKey === 'player'){
          UI._showLeftCast(selfCard);
          const r = Match.api.playCard('player', _selected.handIdx, {targetSide:'ally', targetUid:'__hero__'});
          if(!r.ok) console.log('[match-ui] self-only hero play fail:', r.reason);
          UI._cancelSelection();
        }
        return;  // owner=동료면 동료 셀 클릭해야 함 (영웅 클릭 무시)
      }
      const k = _selected.card.kind;
      // 2026-05-29 (#24) — spell-aoe 적 영웅 클릭 = 발동 trigger 추가 (HS/StS2/LoR 표준).
      //   targetUid 무관 (effects.target='enemy_all_incl_hero' 자동 전체).
      //   attach-hero 는 자기 영웅만 (적 영웅 클릭 ambiguous → 차단 유지).
      const isAoeFire = (k === 'spell-aoe' && sideKey === 'enemy');
      if(k !== 'spell-target' && k !== 'attach-hero' && !isAoeFire) return;
      if(k === 'attach-hero' && sideKey === 'enemy') return;  // attach-hero 는 자기 영웅 만
      // P1-11 fix (2026-05-16): 영웅 target 스펠/attach-hero 사용 시 좌측 cast 카드 등장.
      // 옛 누락: _onUnitClick / _onCellDrop 에는 _showLeftCast 있는데 _onHeroClick 는 없어 보드 중앙 발동만.
      UI._showLeftCast(_selected.card);
      const targetSide = (sideKey === 'player') ? 'ally' : 'enemy';
      const r = Match.api.playCard('player', _selected.handIdx, {
        targetSide,
        targetUid: '__hero__',  // 코어 _resolveTarget 의 영웅 표지
      });
      if(!r.ok) console.log('[match-ui] hero target fail:', r.reason);
      UI._cancelSelection();  // 2026-05-22 문제 1 fix — onClear 호출로 ghost/AoE 글로우/gap/is-casting 해제
      return;
    }

    // 셀렉션이 attacker
    if(_selected && _selected.kind === 'attacker'){
      if(sideKey === 'player'){
        // 자기 영웅 다시 클릭 — 셀렉션 해제
        if(_selected.uid === hero.uid){
          _selected = null;
          UI.renderState();
        }
        return;
      }
      // P0-6 fix (2026-05-16): 카드 페이즈 공격 차단 (UI 단계)
      if(Match.state && Match.state.phase !== 'board'){
        _selected = null;
        UI.renderState();
        return;
      }
      // 적 영웅 공격 — targetUid 만 '__hero__' 표지
      const r = Match.api.attack('player', _selected.uid, {targetUid: '__hero__'});
      if(!r.ok) console.log('[match-ui] hero attack fail:', r.reason);
      _selected = null;
      UI.renderState();
      return;
    }

    // 셀렉션 없음 + 아군 영웅 — attacker 셀렉션 (코어가 진짜 hero.uid 로 매칭하므로 표지 X)
    // Plan 2.D fix (2026-05-12): phase=board 시 큐 cursor 의 sideKey 가 'player' 면 액션 가능
    if(sideKey === 'player' && _isPlayerActable(st)){
      if(hero.exhausted || hero.attackedThisTurn || hero.isDead) return;
      if(hero._acted) return;  // 이미 보드턴 행동함
      // 2026-05-29 #19-3 — cursor.unitUid 강제 폐기 (자유 선택. _onUnitClick 와 동일 룰).
      _selected = {kind:'attacker', uid: hero.uid};
      UI.renderState();
    }
  };

  UI._isValidTargetForSelected = function(sideKey, uid){
    if(!_selected) return false;
    const st = Match.state;
    if(_selected.kind === 'hand'){
      const card = _selected.card;
      if(card.kind === 'spell-target') return true;
      if(card.kind === 'attach-unit')  return sideKey === 'player' && uid !== '__hero__';
      return false;
    }
    if(_selected.kind === 'attacker'){
      if(sideKey === 'player') return false;
      const taunts = st.enemy.board.filter(u => !u.isDead && (u.keywords||[]).includes('taunt'));
      if(taunts.length > 0) return taunts.some(t => t.uid === uid);
      return true;
    }
    return false;
  };

  // ───── 손패 드래그 → 클릭 치환 (2026-05-22 plan B-3) ─────
  // 드래그 시작 즉시 preventDefault + _onHandClick 호출 → 클릭으로 일원화.
  // 사용자 결정 (mockup/phase6_action_unified/v2): 드래그 = 클릭. 정확 drop 폐기.
  function _onHandDragStart(handIdx, card, ev){
    ev.preventDefault();  // 드래그 자체 cancel
    if(ev.dataTransfer){ try { ev.dataTransfer.effectAllowed = 'none'; } catch(e){} }
    UI._onHandClick(handIdx);  // 클릭으로 치환
  }

  // _onHandDragEnd 함수 trash (2026-05-24) — _onHandDragStart 가 drag 자체 cancel (preventDefault + 클릭 치환) → dragend 실질 트리거 X. 함수+binding 한 cluster 폐기.

  // 2026-05-16 단계 4 — 공격 vs 버프 분류 (dmg 필드 또는 키워드 기반)
  function _isAttackSpell(card){
    if(card.dmg != null && card.dmg > 0) return true;
    // 2026-05-22: effects[].op === 'damage' 이면 공격 (정확도 ↑)
    const effs = Array.isArray(card.effects) ? card.effects : [];
    if(effs.some(e => e && e.op === 'damage')) return true;
    // ability 텍스트 키워드 fallback
    const ab = (card.ability || '').toLowerCase();
    if(/피해|damage|타격|공격/.test(ab)) return true;
    return false;
  }

  // ─────────────────────────────────────────────────────────────
  // 카드 사용 통합 흐름 헬퍼 (2026-05-22 plan B-1)
  // mockup/phase6_action_unified/v2 사용자 컨펌.
  // 드래그 = 클릭 치환 + 1차 좌측 cast + kind 별 시각화 + 2차 클릭 발동.
  // ─────────────────────────────────────────────────────────────

  // (1) AoE 적/아군 판정 — effects[].target 파싱
  function _aoeTargetSide(card){
    const effs = Array.isArray(card.effects) ? card.effects : [];
    for(const e of effs){
      if(!e || !e.target) continue;
      if(/^enemy/.test(e.target)) return 'enemy';
      // 2026-05-23 fix — attach-hero 카드의 effects.target 이 'hero' / 'self_*' / 'ally_*' 모두 ally 매핑.
      // 옛 regex /^ally/ 만 매칭 → 'hero' target 카드는 default 'enemy' 로 잘못 매핑됨 (적 빨강).
      if(/^ally|^self|^hero/.test(e.target))  return 'ally';
    }
    // 2026-05-23 — attach-hero 의 attach_buff 같은 effects (target 없음 or aura) 도 buff 카드면 ally.
    // dmg/damage 효과면 default enemy 유지.
    if(card && (card.kind === 'attach-hero' || card.kind === 'attach-unit')) return 'ally';
    return 'enemy';  // default damage
  }

  // (2) AoE 글로우 부착 — 전체 타겟 자동 highlight + 배경 dim
  function _applyAoeGlow(card){
    const side = _aoeTargetSide(card);
    const glow = _isAttackSpell(card) ? 'is-target-attack' : 'is-target-buff';
    const sel  = side === 'ally' ? SEL.ALLY_TARGETS : SEL.ENEMY_TARGETS;
    document.querySelectorAll(sel).forEach(el => el.classList.add(glow, glow + '-aoe'));
    const screen = document.getElementById('tcg-screen');
    if(screen) screen.classList.add('tcg-aoe-cast-active');
  }
  // (3) attach-hero 자기 영웅 글로우
  function _applyHeroGlow(card){
    const glow = _isAttackSpell(card) ? 'is-target-attack' : 'is-target-buff';
    document.querySelectorAll(SEL.ALLY_HERO).forEach(el => el.classList.add(glow, glow + '-aoe'));
    const screen = document.getElementById('tcg-screen');
    if(screen) screen.classList.add('tcg-aoe-cast-active');
  }
  // (4) 글로우 + dim 모두 해제 (AoE / hero 공용)
  function _clearAoeGlow(){
    document.querySelectorAll('.is-target-attack-aoe, .is-target-buff-aoe').forEach(el => {
      el.classList.remove('is-target-attack', 'is-target-buff',
                          'is-target-attack-aoe', 'is-target-buff-aoe');
    });
    const screen = document.getElementById('tcg-screen');
    if(screen) screen.classList.remove('tcg-aoe-cast-active');
  }

  // (5) 마우스 ghost (unit 카드 따라옴)
  function _showMouseGhost(card){
    let g = document.getElementById('tcg-mouse-ghost');
    if(!g){
      g = document.createElement('div');
      g.id = 'tcg-mouse-ghost';
      g.className = 'tcg-mouse-ghost';
      document.body.appendChild(g);
    }
    g.innerHTML = '<div>' + (card.name || '?') + '<br>' +
                  (card.ATK || 0) + '/' + (card.HP || 0) + '</div>';
    g.classList.add('is-active');
    // 즉시 마지막 마우스 좌표로 sync
    g.style.left = _mouse.x + 'px';
    g.style.top  = _mouse.y + 'px';
  }
  function _hideMouseGhost(){
    const g = document.getElementById('tcg-mouse-ghost');
    if(g) g.classList.remove('is-active');
  }

  // (6) 보드 drop zone — 2026-05-22 사용자 결정: 점선 gap-indicator 폐기 → 보드 자체 녹색 glow.
  // 옛 .tcg-board-row 셀렉터 부재 (DOM 에 클래스 없음) → 정본 #tcg-p-board element 에 클래스 토글만.
  function _showBoardInsertGap(){
    const row = document.getElementById('tcg-p-board');
    if(row) row.classList.add('is-unit-drop');
  }
  function _hideBoardInsertGap(){
    const row = document.getElementById('tcg-p-board');
    if(row) row.classList.remove('is-unit-drop');
  }

  // (7) KIND_CAST_HANDLERS 데이터 레지스트리 (검수관 블로커 #1 채택)
  //     6번째 kind 추가 시 이 객체 entry 1개 추가만으로 끝.
  //     fireOn: 'target' (호버 글로우 후 타겟 클릭), 'anywhere' (어디든 클릭), 'board' (보드 row 빈 영역 클릭).
  const KIND_CAST_HANDLERS = {
    'unit': {
      onCast:  (card) => { _showMouseGhost(card); _showBoardInsertGap(); },
      onClear: ()     => { _hideMouseGhost();    _hideBoardInsertGap(); },
      // 2026-05-23 — C+ 안 적용: stage anywhere 분기 폐기. 각 황금 slot cell 의 click handler 가 책임.
      // _renderBoard 가 unitInsertMode 일 때 N+1 황금 slot 동시 생성 + 각 cell click → playCard(slotIdx).
      fireOn:  'slot',
    },
    'spell-target': {
      // 2026-05-23 fix — 적/아군 타겟 highlight + 타겟 라인 (사용자 명시 "효과 생기는 데 불 들어와야")
      onCast:  (card) => { _applyAoeGlow(card); UI._renderTargetLine(); },
      onClear: ()     => { _clearAoeGlow(); const l = document.getElementById('tcg-target-line'); if(l) l.remove(); },
      fireOn:  'target',
    },
    'attach-unit': {
      // 2026-05-23 fix — 부착 가능 타겟 highlight + 타겟 라인
      onCast:  (card) => { _applyAoeGlow(card); UI._renderTargetLine(); },
      onClear: ()     => { _clearAoeGlow(); const l = document.getElementById('tcg-target-line'); if(l) l.remove(); },
      fireOn:  'target',
    },
    'spell-aoe': {
      onCast:  (card) => _applyAoeGlow(card),
      onClear: ()     => _clearAoeGlow(),
      fireOn:  'anywhere',
    },
    'attach-hero': {
      // 2026-05-23 fix — _applyHeroGlow (영웅만) 폐기 → _applyAoeGlow (영웅 + 아군 유닛 모두).
      // 사용자 명시 "버프스킬 cast 시 아군 유닛 글로우 안 됨" — sk_power 같은 ally_one 카드는 보드 유닛도 highlight.
      onCast:  (card) => _applyAoeGlow(card),
      onClear: ()     => _clearAoeGlow(),
      fireOn:  'anywhere',
    },
  };

  // (8) 셀렉션 취소 — 우클릭 / ESC / 카드 재클릭 / 발동 후 공통
  UI._cancelSelection = function(){
    if(_selected && _selected.kind === 'hand'){
      const h = KIND_CAST_HANDLERS[_selected.card.kind];
      if(h && h.onClear) h.onClear();
    }
    // 손패 카드 .is-casting 클래스 해제
    document.querySelectorAll('#tcg-hand .tcg-hand-card.is-casting').forEach(s => s.classList.remove('is-casting'));
    // 2026-05-23 — 좌측 cast 카드 즉시 제거 + #tcg-screen .is-casting-mode 해제 (호버 확대 복귀)
    const tcg = document.getElementById('tcg-screen');
    if(tcg) tcg.classList.remove('is-casting-mode');
    const castCard = document.getElementById('tcg-spell-cast-card');
    if(castCard && castCard.classList.contains('is-showing')){
      castCard.classList.remove('is-showing');
      // opacity 0 transition 후 innerHTML 비움. 새 _showLeftCast 가 도중에 호출되면
      // is-showing 다시 추가하므로 그 케이스는 비우지 않음.
      setTimeout(() => {
        if(!castCard.classList.contains('is-showing')) castCard.innerHTML = '';
      }, 260);
    }
    _selected = null;
    UI.renderState();
  };
  // 옛 drag/drop dead code 5건 (`_onCellDragOver` / `_onCellDrop` / `_onDropToBoard` / `_bindBoardHalfDrop` + UI alias)
  // → 2026-05-24 cluster trash. plan B-4 2 단계 완료. 손패 drag = 클릭 치환 (_onHandDragStart) 단일 흐름.

  // ───── 스킬/공격 라인 가이드 ─────
  // 셀렉션이 hand(타겟형) 또는 attacker 일 때 마우스 추적 라인.
  UI._renderTargetLine = function(){
    let line = document.getElementById('tcg-target-line');
    if(!_selected){
      if(line) line.remove();
      return;
    }
    const st = Match.state;
    // hand 셀렉션이지만 타겟 불필요 카드는 라인 안 그림
    if(_selected.kind === 'hand'){
      const k = _selected.card.kind;
      if(k !== 'spell-target' && k !== 'attach-unit') return;
    }
    if(!line){
      const screen = document.getElementById('tcg-screen');
      if(!screen) return;
      line = document.createElement('div');
      line.id = 'tcg-target-line';
      line.className = 'tcg-target-line';
      line.innerHTML = '<svg><path class="line-stroke" d=""/><path class="line-head" d=""/></svg>';  // 2026-06-16 V2 — 원형 tip → 접선 회전 삼각 화살촉
      screen.appendChild(line);
    }
    // 2026-05-23 fix — hand 셀렉션도 attack spell (damage 효과) 이면 빨강 화살표. 사용자 명시.
    let mode;
    if(_selected.kind === 'attacker'){
      mode = 'attack';
    } else if(_selected.kind === 'hand' && _isAttackSpell(_selected.card)){
      mode = 'attack';
    } else {
      mode = 'spell';
    }
    line.setAttribute('data-mode', mode);
    line.querySelector('.line-stroke').classList.toggle('line-attack', mode === 'attack');
    const _hd = line.querySelector('.line-head');
    if(_hd) _hd.setAttribute('fill', mode === 'attack' ? '#ff5050' : '#ffd700');  // V2 화살촉 색 (공격 빨강/스펠 금색 — 기존 유지)
    UI._updateTargetLinePos();
  };

  UI._updateTargetLinePos = function(){
    const line = document.getElementById('tcg-target-line');
    if(!line || !_selected) return;
    const screen = document.getElementById('tcg-screen');
    if(!screen) return;
    const sRect = screen.getBoundingClientRect();
    const scaleX = screen.offsetWidth / sRect.width;
    const scaleY = screen.offsetHeight / sRect.height;

    // 시작점: 셀렉션 카드 또는 손패 카드 중심
    // 2026-05-23 fix — hand 셀렉션 카드는 좌측 cast 영역으로 이동했으므로 from 도 그쪽 기준.
    //   (사용자 명시 2026-05-23: "손패에서 화살표가 아니라 cast 영역에 있는 카드에서 화살표")
    let from;
    if(_selected.kind === 'attacker'){
      const el = screen.querySelector(`[data-uid="${_selected.uid}"]`);
      if(!el){ return; }
      const r = el.getBoundingClientRect();
      from = {
        x: (r.left - sRect.left + r.width/2) * scaleX,
        y: (r.top  - sRect.top  + r.height/2) * scaleY,
      };
    } else {
      // hand 셀렉션 — 좌측 cast 카드 (1.6배) 우선 사용. is-showing 일 때만.
      const castEl = document.getElementById('tcg-spell-cast-card');
      let sourceEl = null;
      if(castEl && castEl.classList.contains('is-showing')){
        sourceEl = castEl;
      } else {
        sourceEl = document.getElementById(`tcg-hand-${_selected.handIdx + 1}`);
      }
      if(!sourceEl){ return; }
      const r = sourceEl.getBoundingClientRect();
      from = {
        x: (r.left - sRect.left + r.width/2) * scaleX,
        y: (r.top  - sRect.top  + r.height/2) * scaleY,
      };
    }

    // 끝점: 마우스 좌표 (screen 기준)
    const to = {
      x: (_mouse.x - sRect.left) * scaleX,
      y: (_mouse.y - sRect.top)  * scaleY,
    };

    // SVG path: 곡선 (제어점은 두 점 중간 살짝 위)
    const cx = (from.x + to.x) / 2;
    const cy = (from.y + to.y) / 2 - 40;
    const path = `M ${from.x} ${from.y} Q ${cx} ${cy} ${to.x} ${to.y}`;
    const stroke = line.querySelector('.line-stroke');
    const head = line.querySelector('.line-head');
    if(stroke) stroke.setAttribute('d', path);
    // V2 화살촉 — 베지어 끝점 접선(= to-control 방향)으로 삼각형 회전. 원형 tip 대체.
    if(head){
      const ang = Math.atan2(to.y - cy, to.x - cx);
      const hl = 15, hw = 9;  // 화살촉 길이 / 반폭
      const bcx = to.x - Math.cos(ang) * hl, bcy = to.y - Math.sin(ang) * hl;
      const px = -Math.sin(ang), py = Math.cos(ang);
      head.setAttribute('d', 'M ' + to.x + ' ' + to.y +
        ' L ' + (bcx + px * hw) + ' ' + (bcy + py * hw) +
        ' L ' + (bcx - px * hw) + ' ' + (bcy - py * hw) + ' Z');
    }
  };

  // ───── 75초 턴 타이머 ─────
  let _lastTickTs = 0;  // 2026-06-12 cascade-pause: 직전 tick 벽시계 (enemy cascade 동안 타이머 정지 보정)
  function _startTimer(){
    _stopTimer();
    _lastTickTs = 0;
    // 2026-05-17 사용자 명시 — 보드 차례 30초 / 카드 페이즈 75초 분기.
    const st = Match.state;
    const PHASE = (Match && Match.PHASE) || {CARD:'card', BOARD:'board'};
    const isBoard = st && st.phase === PHASE.BOARD;
    _timerExpiresAt = Date.now() + (isBoard ? BOARD_TURN_TIME_MS : TURN_TIME_MS);
    _timerHandle = setInterval(_tickTimer, 250);
    _tickTimer();
  }

  function _stopTimer(){
    if(_timerHandle){ clearInterval(_timerHandle); _timerHandle = null; }
    _timerExpiresAt = 0;
    _lastTickTs = 0;
    const el = document.getElementById('tcg-timer');
    if(el){ el.textContent = ''; el.classList.remove('is-warn'); }
  }

  // 2026-05-25 v3 mockup 컨펌: 모래시계 HUD 통합 (commit 43985b2 재이식 + v3 1/4 크기).
  // top bulb sand y/height + bottom pile y/height 동적 갱신. neck halo opacity (남은 시간 0 시 사라짐).
  function _updateHourglassSvg(remainMs, totalMs){
    const top = document.getElementById('tcg-hg-top-fill');
    const bot = document.getElementById('tcg-hg-bot-fill');
    const stream = document.getElementById('tcg-hg-stream');
    const halo = document.getElementById('tcg-hg-neck-halo');
    if(!top || !bot) return;
    const ratio = totalMs > 0 ? Math.max(0, Math.min(1, remainMs / totalMs)) : 0;
    const topH = 60 * ratio;
    const topY = 80 - topH;
    const pileH = 50 * (1 - ratio);
    const pileTop = 152 - pileH;
    top.setAttribute('y', topY);
    top.setAttribute('height', topH);
    bot.setAttribute('y', pileTop);
    bot.setAttribute('height', pileH);
    const isOver = remainMs <= 0;
    if(stream) stream.style.opacity = isOver ? '0' : '1';
    if(halo) halo.style.opacity = isOver ? '0' : '';
  }

  function _tickTimer(){
    const st = Match.state;
    const el = document.getElementById('tcg-timer');
    if(!el) return;
    if(!st || st.winner){ _stopTimer(); return; }
    /* diagnosis-confirmed: 2026-06-12 사유: bug-fix — cascade 중 타이머 비대칭. repro:enemy cascade replay(_hasEnemyCascade)가 player 입력차단(3064)과 달리 타이머엔 미배선 → 예산 차감 + 만료 시 입력잠금 상태 자동 skip(edge). hypo배제:_tickTimedAttachments 오타 아님(별개 함수)/cascade 정지가드 부재 확인. demo:match-timer-cascade-guard-v6. */
    // 2026-06-12 — enemy cascade 재생 중엔 player 입력이 차단(_hasEnemyCascade, 3064)되므로 타이머도 대칭 정지.
    //   경과분(delta)을 만료시각에 더해 잔여시간 유지 → 예산 차감/만료-중-skip 방지. player 자기 cascade 는 입력 가능 → 정지 안 함.
    const _now = Date.now();
    const _delta = _lastTickTs ? (_now - _lastTickTs) : 0;
    _lastTickTs = _now;
    if(st.events && _hasEnemyCascade(st.events)) _timerExpiresAt += _delta;
    // P1-9 fix (2026-05-16): 양쪽 카운트다운 표시. 적 턴도 표시 (AI 시각 보조).
    const remain = Math.max(0, _timerExpiresAt - _now);
    const sec = Math.ceil(remain / 1000);
    // v3 시안 정합 (2026-05-25): 0:NN 형식 (zero-padded) + 모래시계 sand 갱신 + is-low 토글.
    el.textContent = '0:' + String(sec).padStart(2, '0');
    el.classList.toggle('is-warn', remain <= TIMER_WARN_MS && remain > 0);
    const tmBox = document.getElementById('tcg-hg-timer-box');
    if(tmBox) tmBox.classList.toggle('is-low', sec <= 10 && sec > 0);
    // phase 따라 totalMs 다름 (card 75s / board 30s) — _startTimer 의 isBoard 분기와 동일 룰
    const PHASE_TICK = (Match && Match.PHASE) || {CARD:'card', BOARD:'board'};
    const totalMs = (st.phase === PHASE_TICK.BOARD) ? BOARD_TURN_TIME_MS : TURN_TIME_MS;
    _updateHourglassSvg(remain, totalMs);
    if(remain <= 0){
      _stopTimer();
      // 만료 → player 만 강제 endTurn. AI 는 자체 endTurn (이미 진행).
      // 2026-05-23 fix — Match.api.endTurn 직접 호출 = endTurnUI 의 phase=BOARD fix 우회 → deadlock.
      //   endTurnUI 가 phase 분기 처리 (card: endCardPhase + endTurn / board: unit skip + advance).
      //   sim_ai_stuck.js 로 board phase player timer 만료 deadlock 재현 + fix 검증.
      if(st.side === 'player' && !st.winner){
        // 2026-05-29 #19 옵션 2 — 만료 자동 skip 시 사용자 인지 알림 (사용자 보고 "그냥 턴 넘어간다" mental model fix).
        //   phase=board: 차례(unit) 자동 skip / phase=card: 턴 자동 종료. toast 1.5s.
        const PHASE_T = (Match.PHASE) || {CARD:'card', BOARD:'board'};
        const expireMsg = (st.phase === PHASE_T.BOARD) ? '⏰ 시간 만료 — 차례 자동 종료' : '⏰ 시간 만료 — 턴 자동 종료';
        _showToast(expireMsg, 1500);
        if(typeof RoF.Match.endTurnUI === 'function'){
          RoF.Match.endTurnUI();
        } else {
          // fallback (옛 흐름)
          const PHASE = (Match.PHASE) || {CARD:'card', BOARD:'board'};
          if(st.phase === PHASE.CARD) Match.endCardPhase('player');
          Match.api.endTurn();
        }
        _selected = null;
        _drag = null;
        // endTurnUI 가 renderState + _refreshTimer 자동 호출하지만 안전 위해 보강
        if(!Match.state.winner && !Match.state.pendingLevelUp){
          _startTimer();
        }
      }
    }
  }

  // P1-9 fix (2026-05-16): 외부 turn 시작 시 timer 재시작 + side 변경 감지.
  let _lastTimerKey = null;
  UI._refreshTimer = function(){
    const st = Match.state;
    if(!st || st.winner){ _stopTimer(); _lastTimerKey = null; return; }
    // 2026-05-29 사용자 보고 #19 — 보드 페이즈 연속 player 차례 (leftover 묶음 P2 → PH) 사이
    //   st.side='player' 동일 → 옛 룰 (`_lastTimerSide !== st.side`) 가 timer reset 안 함 →
    //   이전 차례 남은 시간 계승 → 0초 만료 → 자동 endTurn (skip) → 차례 강제 종료.
    // 근본 fix: 추적 키를 cursor + side 조합으로 확장 (보드 페이즈) — cursor 진행 시 항상 timer reset.
    //   카드 페이즈는 cursor 무관 → side 만 추적 (옛 동작 유지).
    const key = (st.phase === 'board')
      ? ('board:' + (st.boardTurnCursor | 0) + ':' + st.side)
      : ('card:' + st.side);
    if(_lastTimerKey !== key){
      _lastTimerKey = key;
      _startTimer();
      return;
    }
    if(!_timerHandle) _startTimer();
  };

  // ───── 매치 시작 ─────
  UI.startMatch = function(opts){
    // 2026-05-17 fix — 옛 매치의 winner overlay / banner 등 stale element 강제 제거
    // (사용자 보고: 패배 후 재매칭 시 옛 패배 화면 잔존)
    ['tcg-winner-overlay','tcg-banner-big','tcg-banner-small'].forEach(id => {
      const el = document.getElementById(id);
      if(el){ el.classList.remove('is-show','is-long','is-enemy'); if(id === 'tcg-winner-overlay' && el.parentNode) el.parentNode.removeChild(el); }
    });
    // 2026-05-24 — UI 흐름은 AI 사이클 진입 2~3초 random 지연 (C-a 하스스톤 패턴).
    //   회귀는 직접 Match.start 호출 — 영향 0 (default 0).
    opts = opts || {};
    if(opts.aiAutoStartDelayMs == null){
      opts.aiAutoStartDelayMs = 2000 + Math.random() * 1000;
    }
    Match.start(opts);
    /* diagnosis-confirmed: 2026-06-13 repro:Playwright 보드 player공격 직후 euHP=5/puActed=true@renderState(결과·turn-side-change 즉시 적용) 후 lunge 가 큐로 재생 → "적턴 먼저, 공격모션 나중" 순서역전 재현. hypo배제:이벤트 push순서는 정상(unit-attack 먼저) → 원인은 동기 AI cascade + renderState 선페인트. demo:board-attack-anim-order 회귀 + Playwright 타임라인. */
    // Option A (2026-06-13) — 보드 페이즈 적 AI 디퍼: _deferBoardAI 플래그 ON 으로 _defaultAfterBoardTurn 의 동기 AI.takeTurn 차단.
    //   실제 적턴은 _processEvents 완료(player 애니 큐 비움) 후 driver 가 구동 → player lunge→적턴 banner→적 lunge 순서 보장.
    //   Match.start 가 진입 시 플래그를 false 로 reset → 회귀/headless(직접 Match.start 호출)는 동기 AI 유지, 누수·영향 0. (UI.startMatch 만 Match.start 직후 true 로 set.)
    Match._deferBoardAI = true;
    _selected = null;
    _drag = null;
    _lastPlayerSoul = -1;
    _lastEnemySoul = -1;
    if(global.UI && global.UI.show) global.UI.show('tcg-screen');
    /* diagnosis-confirmed: 2026-06-09 사유: bug-fix repro — 손패 이중 노출. 코드 경로 추적으로 확정:
       startMatch 가 Match.start 직후 renderState() 호출(아래) → 손패가 hand 배열에 이미 5장이라 swoop 전에
       즉시 그려짐 → coin-flip/cinematic dim 에 덮여 "투명 손패" 노출 → round-hand-draw swoop 으로 다시 뽑힘.
       기각 가설: is-pregame 이 손패 투명화 (실제 is-pregame 은 pointer-events:none 만, opacity 무관). */
    // 2026-06-09 손패 이중 노출 fix — renderState 전에 is-pregame 부착 → 손패 첫 렌더부터 숨김(opacity:0).
    //   is-pregame 은 옛 흐름상 coin-flip(_animCoinFlip)에서야 부착돼 첫 렌더를 못 가렸음. 여기서 미리 부착
    //   → round-hand-draw(_animRoundHandDraw)가 제거 + swoop 으로 손패 처음 등장.
    const _pregameScreen = document.getElementById('tcg-screen');
    if(_pregameScreen) _pregameScreen.classList.add('is-pregame');
    UI.renderState();
    _startTimer();
    // 손패 분배 애니: Match._beginRound(1) 가 events 큐에 'round-hand-draw' push 함.
    // _processEvents 가 자동 처리 → _animRoundHandDraw 호출.
  };

  // 손패 분배 애니 v1 (Plan 2.D, 2026-05-12 갤러리 컨펌 — mockup/hand_draw_anim/v1.html)
  // 매치 시작 + 매 라운드 시작 시 player 손패 5장이 덱(우하단)에서 휘어 날아옴. 90ms stagger.
  // _beginRound 가 events 큐에 'round-hand-draw' push → _processEvents → _animRoundHandDraw 호출.
  function _animRoundHandDraw(ev){
    return new Promise(resolve => {
      // 2026-05-17 v5 — pregame visual unlock (swoop animation 시점에 손패/영혼력 fade-in)
      const screen = document.getElementById('tcg-screen');
      if(screen) screen.classList.remove('is-pregame');
      // 2026-05-24 §영혼력 visual feedback 룰 — floater 호출 폐기.
      //   soul-recharge-flash event 가 floater 의 단일 source (중복 호출 제거).
      //   _animRoundHandDraw 는 swoop animation + mana spawn animation 만 처리.
      //   사용자 보고 "+5 한 번만" → 옛 양측 forEach floater 호출 = 중복 (event push 와 합쳐 player 2번, enemy 2번).
      ['player', 'enemy'].forEach(sideKey => {
        const mana = document.getElementById('tcg-mana-' + sideKey);
        if(mana){
          mana.classList.remove('is-spawning');
          void mana.offsetWidth;  // force reflow
          mana.classList.add('is-spawning');
          setTimeout(() => mana.classList.remove('is-spawning'), 650);
        }
      });
      const hand = document.getElementById('tcg-hand');
      if(!hand){ resolve(); return; }
      // 현재 손패 채워진 슬롯만 (5장)
      const slots = Array.from(hand.querySelectorAll('.tcg-hand-card')).filter(s => s.querySelector('.match-card'));
      if(!slots.length){ resolve(); return; }
      slots.forEach((slot, i) => {
        const inner = slot.querySelector('.match-card');
        if(!inner) return;
        slot.classList.add('is-drawing');
        inner.style.animationDelay = (i * 70) + 'ms';  /* diagnosis-confirmed: 2026-06-09 사유: feature — swoop v3 stagger 70ms (design-confirmed, animation_principles.md) */
      });
      // 애니 끝나면 정리 (0.58s + 마지막 stagger) — diagnosis-confirmed: 2026-06-09 사유: feature — swoop v3 타이밍
      const total = 640 + (slots.length * 70);
      setTimeout(() => {
        slots.forEach(slot => {
          slot.classList.remove('is-drawing');
          const inner = slot.querySelector('.match-card');
          if(inner) inner.style.animationDelay = '';
        });
        // 2026-05-17 — swoop 끝 = 모든 pregame 완료. 사용자 input unlock.
        const screen = document.getElementById('tcg-screen');
        if(screen) screen.classList.remove('is-pregame');
        resolve();
      }, total);
    });
  }

  // ───── data-action 바인딩 ─────
  // pendingLevelUp 시 endTurn 이 {ok:false, pendingLevelUp:true} 반환 — 모달이 떠 사용자 선택 대기.
  // 이 경우 타이머 멈추고 모달 onClick 에서 _startTimer 재개.
  RoF.Match.endTurnUI = function(){
    if(!Match.state || Match.state.winner) return;

    const PHASE = (Match.PHASE) || {CARD:'card', BOARD:'board'};
    const st = Match.state;

    // 2026-06-02 옵션 B — 상태 전환은 코어 _endTurnFlow('player') 단일 진입점에 위임.
    //   UI 레이어 책임만 잔존: 선택·드래그 리셋 / 렌더 / 타이머 / (pendingLevelUp 시) 타이머 정지.
    //   옛 sideBefore 방어 (endCardPhase swap 시 endTurn skip) + board unit skip 은 _endTurnFlow 안에 내장.
    //   board phase: "자기 cursor unit 행동 skip" (사용자 명시 mental model, design/changelog 2026-05-15).
    if(st.phase === PHASE.BOARD){
      // 자기 cursor 차례일 때만 처리. 적 차례면 무시 (이미 AI 진행) — 옛 동작 유지.
      const cursor = (st.boardTurnQueue || [])[st.boardTurnCursor | 0];
      if(!(cursor && cursor.sideKey === 'player')) return;
    } else {
      // phase=CARD — player 차례 아니면 무시.
      if(st.side !== 'player') return;
    }

    const r = Match._endTurnFlow('player');

    _selected = null;
    _drag = null;
    UI.renderState();
    // 타이머 동작은 옛 endTurnUI 그대로 보존 (이번 리팩터 = side flip 통합만, 타이머 동작 불변).
    //   _endTurnFlow 는 정상 시 {ok:true} → _startTimer. (옛 endTurn 도 항상 ok:true 라 _stopTimer 는 dead 조건이었음)
    if(r && !r.ok && r.pendingLevelUp){
      _stopTimer();
    } else {
      _startTimer();
    }
  };

  // 2026-05-29 — UI 디버그 hook (Playwright 시뮬 / 회귀 환경에서 IIFE 안 내부 함수 호출용).
  //   실 game UI 흐름 정확 재현 위해 _onUnitClick / _onHeroClick / renderState / _selected 외부 노출.
  //   사용자 보고 #19-2 cursor enforce 검증 시 활용. 회귀 환경에선 영향 0 (외부 호출자 없음).
  RoF.Match._uiDebug = {
    onUnitClick: (sideKey, unit) => UI._onUnitClick(sideKey, unit),
    onHeroClick: (sideKey) => UI._onHeroClick(sideKey),
    onHandClick: (handIdx) => UI._onHandClick(handIdx),
    renderState: () => UI.renderState(),
    getSelected: () => _selected,
    cancelSelection: () => UI._cancelSelection(),
  };

  global.Match = global.Match || {};
  global.Match.endTurn = RoF.Match.endTurnUI;

  // 2026-05-14 사용자 컨펌 — 매치 전용 톱니/모달 폐기. 전역 #settings-modal 통합.
  // 매치 active 시 로그아웃/게임 종료 = confirm 경고 + 자동 패배 처리 (js/37_settings.js logout/exitGame).
  // 옛 핸들러 4개 (openSettings/closeSettings/surrenderLogout/surrenderMenu) 삭제 — 사용처 0 확인 후.

  // ───── DOM 정적 바인딩 ─────
  function bindStatic(){
    const ph = document.getElementById('tcg-p-hero');
    const eh = document.getElementById('tcg-e-hero');
    if(ph) ph.addEventListener('click', () => UI._onHeroClick('player'));
    if(eh) eh.addEventListener('click', () => UI._onHeroClick('enemy'));

    // 영웅 슬롯 드롭 — 손패 카드(spell-target/attach-hero) + 보드 attack 드래그
    [ph, eh].forEach((el, idx) => {
      if(!el) return;
      const sideKey = idx === 0 ? 'player' : 'enemy';
      el.addEventListener('dragover', (ev) => {
        if(!_drag) return;
        const ok = _isValidDropOnHero(sideKey);
        if(ok){
          ev.preventDefault();
          el.classList.add('is-drop-hover');
        }
      });
      el.addEventListener('dragleave', () => el.classList.remove('is-drop-hover'));
      el.addEventListener('drop', (ev) => {
        ev.preventDefault();
        el.classList.remove('is-drop-hover');
        if(!_drag || !_isValidDropOnHero(sideKey)) return;

        // 보드→공격 드래그: 적 영웅 공격
        if(_drag.kind === 'attack'){
          // P0-6 fix (2026-05-16): 카드 페이즈 공격 차단 (UI 단계)
          if(Match.state && Match.state.phase !== 'board'){
            _drag = null; _selected = null;
            UI.renderState();
            return;
          }
          const r = Match.api.attack('player', _drag.uid, {targetUid: '__hero__'});
          if(!r.ok) console.log('[match-ui] hero drag attack fail:', r.reason);
          _drag = null; _selected = null;
          UI.renderState();
          return;
        }

        // 손패 카드 드래그
        if(_drag.card){
          const k = _drag.card.kind;
          if(k !== 'spell-target' && k !== 'attach-hero') return;
          const targetSide = sideKey === 'player' ? 'ally' : 'enemy';
          const r = Match.api.playCard('player', _drag.handIdx, {
            targetSide, targetUid: '__hero__',
          });
          if(!r.ok) console.log('[match-ui] hero drop fail:', r.reason);
          _drag = null; _selected = null;
          UI.renderState();
        }
      });
    });

    // 보드 절반 drop 호출 trash (2026-05-24) — _bindBoardHalfDrop 폐기, 손패 drag = 클릭 치환.

    // P0-12 fix (2026-05-16): 보드 row 의 글로우 영역 따라 on/off.
    // dragenter/dragleave 카운터 패턴: row 안 자식 cell 간 이동 시에도 카운터 0 안 됨.
    // 마우스가 row 밖으로 완전히 나갈 때만 카운터 0 → is-drop-active 제거.
    const pBoard = document.getElementById('tcg-p-board');
    if(pBoard){
      let _enterCount = 0;
      pBoard.addEventListener('dragenter', (ev) => {
        if(!_drag || !_drag.card || _drag.card.kind !== 'unit') return;
        _enterCount++;
        pBoard.classList.add('is-drop-active');
      });
      pBoard.addEventListener('dragleave', (ev) => {
        if(!_drag || !_drag.card || _drag.card.kind !== 'unit') return;
        _enterCount--;
        if(_enterCount <= 0){
          _enterCount = 0;
          pBoard.classList.remove('is-drop-active');
        }
      });
      pBoard.addEventListener('dragover', (ev) => {
        if(!_drag || !_drag.card || _drag.card.kind !== 'unit') return;
        ev.preventDefault();
        // P0-5 v6 (2026-05-16): 마우스 X → _drag.insertIdx 갱신 + 재렌더
        _onBoardRowDragOverUnit(ev, pBoard, 'player');
      });
      // dragend 는 hand slot 에 부착됨. 추가 안전: pBoard 의 drop 시도 카운터 reset
      pBoard.addEventListener('drop', () => {
        _enterCount = 0;
        pBoard.classList.remove('is-drop-active');
      });
    }
    // _onHandDragEnd 가 dragend 시 pBoard.is-drop-active 정리 — 핸들러 안에서 추가.

    // 마우스 추적 (스킬 라인 + 2026-05-22 마우스 ghost 동기화)
    const screen = document.getElementById('tcg-screen');
    if(screen){
      screen.addEventListener('mousemove', (ev) => {
        _mouse.x = ev.clientX;
        _mouse.y = ev.clientY;
        if(_selected) UI._updateTargetLinePos();
        // 2026-05-22 plan B-1 — unit 카드 셀렉션 시 ghost 위치 sync
        const ghost = document.getElementById('tcg-mouse-ghost');
        if(ghost && ghost.classList.contains('is-active')){
          ghost.style.left = _mouse.x + 'px';
          ghost.style.top  = _mouse.y + 'px';
        }
      });

      // ───── 2026-05-22 plan B-5 — 우클릭 / ESC 셀렉션 취소 (사용자 결정 4번) ─────
      screen.addEventListener('contextmenu', (ev) => {
        if(_selected){
          ev.preventDefault();
          UI._cancelSelection();
        }
      });

      // ───── 2026-05-22 plan B-6 — Stage click (AoE/attach-hero 어디든 클릭 발동) ─────
      // 2026-05-23 — C+ 안 적용: unit 카드는 각 황금 slot cell click handler 가 책임 (fireOn='slot').
      //              stage 의 anywhere 분기는 spell-aoe / attach-hero 만 처리.
      screen.addEventListener('click', (ev) => {
        if(!_selected || _selected.kind !== 'hand') return;
        const card = _selected.card;
        const handler = KIND_CAST_HANDLERS[card.kind];
        if(!handler) return;
        // 손패 / leftCast / 황금 slot 클릭 = 다른 핸들러 처리 (silent ignore 금지 — 검수관 #8)
        if(ev.target.closest('.tcg-hand')) return;        // _onHandClick 가 받음
        if(ev.target.closest('#tcg-left-cast')) return;   // leftCast 자기 = 무시
        if(ev.target.closest('.is-unit-insert-slot')) return;  // 황금 slot 자체 click handler 가 처리
        // 영웅 cell 위 클릭은 무조건 무시 (unit 카드는 영웅에 부착 X)
        if(ev.target.closest('.is-hero')) return;
        // 타겟 유닛 클릭 = _onUnitClick / _onHeroClick 가 우선 처리.
        if(ev.target.closest('.match-card')) return;
        // phase=BOARD 분기 (검수관 #9 — 18~19 deadlock 교훈)
        if(Match.state && Match.state.phase === 'board' && card.kind === 'unit'){
          return;
        }
        // fireOn === 'anywhere' (spell-aoe, attach-hero) — 어디든 빈 영역 클릭 = 발동
        if(handler.fireOn === 'anywhere'){
          const r = Match.api.playCard('player', _selected.handIdx, {});
          if(!r.ok) console.log('[match-ui] playCard fail:', r.reason);
          UI._cancelSelection();
          return;
        }
        // fireOn === 'slot' (unit) — 황금 slot 외 클릭은 무시 (안내만)
        // slot 자체 click 은 위에서 return 됐음. 여기 도달 = 빈 영역 클릭.
        if(handler.fireOn === 'slot'){
          // silent no-op (사용자가 슬롯 옆 클릭한 것 — 의도 불명, 그냥 무시)
          return;
        }
      });
    }

    // ESC 키 = 셀렉션 취소 (document 전역)
    document.addEventListener('keydown', (ev) => {
      if(ev.key === 'Escape' && _selected){
        UI._cancelSelection();
      }
    });
  }
  if(document.readyState === 'loading'){
    document.addEventListener('DOMContentLoaded', bindStatic);
  } else {
    bindStatic();
  }

  // ───── Game.startBattle 정식화 — 회귀 + dev navigator 진입점 ─────
  // 2026-05-16: 51_game_town.js 의 "리그 도전하기" 는 별도 메서드 startBattleMatching
  // (매칭 화면 → 출전 → tcg-screen) 으로 분리. 이 RoF.Game.startBattle 은 회귀
  // (test_run.js tcg-screen-render) + dev navigator 의 빠른 진입 (D-1 placeholder
  // 덱) 용. 사용자 "리그 도전하기" 흐름과 충돌하지 않음.
  RoF.Game = RoF.Game || {};
  RoF.Game.startBattle = function(){
    if(!RoF.Data || !RoF.Data.createHero){
      console.warn('[Game.startBattle] createHero 없음');
      return;
    }

    let pHero;
    if(global.Game && global.Game.hero){
      // Game.hero 는 {gender, role, element, skinIndex} 정체성 메타 (32_auth.js:247).
      // PHASE 6 5필드 영웅 카드 객체로 변환해야 ATK/HP/SOUL 살아있음.
      const meta = global.Game.hero;
      const isFullHero = meta && (meta.HP != null) && (meta.ATK != null) && (meta.SOUL != null);
      pHero = isFullHero ? meta : RoF.Data.createHero(meta);
    } else {
      pHero = RoF.Data.createHero({gender:'m', role:'warrior', element:'fire', skinIndex:0});
    }

    const elems = ['fire','water','lightning','earth','dark','holy'];
    const roles = ['warrior','ranger','support'];
    const _rnd = (RoF._rand || Math.random);  // 시드 가능 RNG (60_turnbattle_v6.js 정의)
    const e = elems[Math.floor(_rnd()*elems.length)];
    const r = roles[Math.floor(_rnd()*roles.length)];
    const eHero = RoF.Data.createHero({gender:'f', role:r, element:e, skinIndex:0});

    // D-1 placeholder 덱
    const apprentice = RoF.Data.UNITS.find(u => u.id === 'apprentice');
    const guard      = RoF.Data.UNITS.find(u => u.id === 'guard');
    const fireSpirit = RoF.Data.UNITS.find(u => u.id === 'fire_spirit');
    const flameArrow = RoF.Data.SKILLS.find(s => s.id === 'sk_flame_arrow');
    const healLight  = RoF.Data.SKILLS.find(s => s.id === 'sk_healing_light');

    const pDeck = [];
    for(let i=0; i<14; i++) pDeck.push(apprentice);
    for(let i=0; i<8; i++)  pDeck.push(guard);
    for(let i=0; i<4; i++)  pDeck.push(fireSpirit);
    for(let i=0; i<2; i++)  pDeck.push(flameArrow);
    for(let i=0; i<2; i++)  pDeck.push(healLight);

    const eDeck = [];
    for(let i=0; i<10; i++) eDeck.push(apprentice);
    for(let i=0; i<10; i++) eDeck.push(guard);
    for(let i=0; i<10; i++) eDeck.push(fireSpirit);

    UI.startMatch({
      playerHero: pHero,
      enemyHero:  eHero,
      playerDeck: pDeck,
      enemyDeck:  eDeck,
    });
  };

})(typeof window !== 'undefined' ? window : globalThis);
