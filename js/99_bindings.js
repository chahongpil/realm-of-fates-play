(function () {
  'use strict';

  // 99_bindings.js — 이벤트 위임 바인딩 (Phase 6 / Section 07)
  //
  // HTML 인라인 onclick/oninput 을 data-action 속성 기반 이벤트 위임으로 교체.
  // 로드 순서: index.html 내 script 태그 순서 = 99_bindings.js → 99_bootstrap.js
  // (defer 스크립트는 HTML 순서대로 실행됨)
  //
  // 지원 속성:
  //   data-action="module.method"          클릭 → RoF.Module.method()
  //   data-action="module.method" data-arg="x"  클릭 → RoF.Module.method('x')
  //   data-action-input="module.method"    input → RoF.Module.method(el.value)
  //   data-action-enter="module.method"    Enter 키 → RoF.Module.method()
  //   data-dismiss="modal-id"              클릭 → classList.remove('active')

  const MODULE_MAP = {
    auth:       'Auth',
    ui:         'UI',
    sfx:        'SFX',
    game:       'Game',
    turnBattle: 'TurnBattle',
    formation:  'Formation',
    fx:         'FX',
    backend:    'Backend',
    settings:   'Settings',
    profile:    'Profile',
    formationSlots: 'FormationSlots',
    match:      'Match',     // PHASE 6 TCG 매치 (60_turnbattle_v6.js + 61_match_ui.js)
    bookOfLife: 'BookOfLife', // Step 6 (2026-05-18) 서고 — 생명의 서 (56_book_of_life.js)
  };

  function resolveAction(actionStr) {
    const dot = actionStr.indexOf('.');
    if (dot < 0) {
      console.error('[bindings] 잘못된 action 형식 (점 없음):', actionStr);
      return null;
    }
    const moduleName = actionStr.slice(0, dot);
    const methodName = actionStr.slice(dot + 1);
    // v2.* 는 Battle._installDelegatedListeners (60_turnbattle_v2.js) 가 자체 처리.
    // 99_bindings 는 resolveAction 에서 조용히 무시 (Step 5C 후속, 2026-04-21).
    if (moduleName === 'v2') return null;
    const moduleKey  = MODULE_MAP[moduleName];
    if (!moduleKey) {
      console.error('[bindings] 알 수 없는 모듈:', moduleName);
      return null;
    }
    const mod = window.RoF && window.RoF[moduleKey];
    if (!mod) {
      console.error('[bindings] 모듈 로드 안됨:', moduleKey);
      return null;
    }
    const fn = mod[methodName];
    if (typeof fn !== 'function') {
      console.error('[bindings] 메서드 없음:', moduleKey + '.' + methodName);
      return null;
    }
    return fn.bind(mod);
  }

  // ── 클릭 이벤트 위임 (data-action, data-dismiss) ──────────────────────────
  document.addEventListener('click', function (e) {
    // data-dismiss: classList.remove('active')
    const dismissEl = e.target.closest('[data-dismiss]');
    if (dismissEl) {
      const target = document.getElementById(dismissEl.dataset.dismiss);
      if (target) target.classList.remove('active');
      return;
    }

    // data-action: 모듈 메서드 호출
    const el = e.target.closest('[data-action]');
    if (!el) return;

    const handler = resolveAction(el.dataset.action);
    if (!handler) return;

    try {
      const arg = el.dataset.arg;
      if (arg !== undefined) handler(arg);
      else handler();
    } catch (err) {
      console.error('[bindings] 실행 오류 ' + el.dataset.action + ':', err);
    }
  });

  // ── input 이벤트 위임 (볼륨 슬라이더 등) ─────────────────────────────────
  document.addEventListener('input', function (e) {
    const el = e.target.closest('[data-action-input]');
    if (!el) return;

    const handler = resolveAction(el.dataset.actionInput);
    if (!handler) return;

    try {
      handler(el.value);
    } catch (err) {
      console.error('[bindings] input 오류 ' + el.dataset.actionInput + ':', err);
    }
  });

  // ── Enter 키 바인딩 (data-action-enter) ───────────────────────────────────
  document.addEventListener('keydown', function (e) {
    if (e.key !== 'Enter') return;
    const el = e.target.closest('[data-action-enter]');
    if (!el) return;

    e.preventDefault(); // 폼 submit 기본 동작 차단

    const handler = resolveAction(el.dataset.actionEnter);
    if (!handler) return;

    try {
      handler();
    } catch (err) {
      console.error('[bindings] Enter 오류 ' + el.dataset.actionEnter + ':', err);
    }
  });

})();
