'use strict';

// Realm of Fates — 글로벌 네임스페이스 (Phase 2 refactor)
// 이 파일은 반드시 가장 먼저 로드되어야 한다.
window.RoF = window.RoF || {
  version: '1.0.0',
  Data: {},
  debug: {},
};

// 전역 에러 태깅 (디버깅 편의)
window.addEventListener('error', (e) => {
  const file = (e.filename || '').split('/').pop();
  console.error(`[RoF][${file}:${e.lineno}]`, e.message);
});
