'use strict';

/* ============================================================
   Realm of Fates — Settings Modal (2026-04-23)
   ============================================================
   - 목적: 사운드 패널과 별개로 "저장하고 종료" + 계정 정보 + 확장 옵션을
     한 곳에 모으는 모달. 메뉴 화면 어디서나 접근 가능.
   - 기획: 대표님 요청 (2026-04-23) — 게임 설정에 저장하고 종료 메뉴
   - 동작: settings.open → 모달 표시, settings.exitWithSave → Game.logout
   - bindings: RoF.Settings 로 등록, 99_bindings.js MODULE_MAP 에 settings 매핑.
   ============================================================ */

(function(){
  const MODAL_ID = 'settings-modal';

  // 2026-05-14 사용자 컨펌 — 매치 진행 중 로그아웃/게임종료 = PvP 룰 (봇 매치도 포함) 자동 패배 처리 + 경고.
  function _matchInProgress(){
    const screen = document.getElementById('tcg-screen');
    return !!(screen && screen.classList.contains('active') &&
              window.Match && Match.state && !Match.state.winner);
  }

  const Settings = {
    open(){
      const m = document.getElementById(MODAL_ID);
      if(!m) return;
      // 계정 정보 주입
      const userEl = m.querySelector('.set-user-name');
      if(userEl){
        const u = (window.Auth && Auth.user) ? Auth.user : '(로그인 안 됨)';
        userEl.textContent = u;
      }
      // 클라우드 연결 상태 표시
      Settings._syncCloudStatus();
      // BGM 상태 라벨 동기화
      Settings._syncBgmLabel();
      // 2026-04-27: 볼륨 슬라이더·음소거 아이콘을 현재 SFX 상태로 동기화 (모달 열 때마다 갱신).
      Settings._syncVolume();
      m.classList.add('active');
    },
    close(){
      const m = document.getElementById(MODAL_ID);
      if(m) m.classList.remove('active');
    },
    /** 저장만 — 진행 상태 저장 후 모달 닫고 계속 플레이 */
    saveOnly(){
      if(window.Game && typeof Game.persist === 'function'){
        Game.persist();
      }
      Settings.close();
    },
    /** 로그아웃 — Game.logout (persist + Supabase 세션 종료 + auto-login 정리 + 타이틀 복귀)
     *  매치 진행 중이면 confirm + 자동 패배 처리 (2026-05-14 사용자 컨펌). */
    logout(){
      if(_matchInProgress()){
        if(!window.confirm('⚠ 매치 진행 중입니다.\n로그아웃하면 자동 패배 처리됩니다.\n계속하시겠습니까?')){
          return;  // 취소 — 모달 그대로 유지
        }
        // 2026-05-20 P0-1: _endMatch 로 통일 — events clear + AI stop.
        // showReward 는 skip (logout 은 title 화면으로 전환되므로 보상 화면 미진입).
        Match._endMatch('enemy', {showReward: false});
      }
      Settings.close();
      if(window.Game && typeof Game.logout === 'function'){
        Game.logout();
      } else {
        if(window.UI && UI.show) UI.show('title-screen');
      }
    },
    /** (기존 호환) 저장하고 종료 = 로그아웃과 동일 */
    exitWithSave(){ Settings.logout(); },
    /** 게임 종료 — 진행 저장 후 창 닫기 시도. 일반 탭에서는 window.close() 가 차단되므로 안내 fallback.
     *  매치 진행 중이면 추가 confirm + 자동 패배 처리 (2026-05-14 사용자 컨펌). */
    exitGame(){
      if(_matchInProgress()){
        if(!window.confirm('⚠ 매치 진행 중입니다.\n게임 종료 시 자동 패배 처리됩니다.\n계속하시겠습니까?')){
          return;
        }
        // 2026-05-20 P0-1: _endMatch 로 통일. showReward skip (창 닫음).
        Match._endMatch('enemy', {showReward: false});
      } else {
        if(!confirm('게임을 종료하시겠습니까?\n\n진행 상황은 자동 저장됩니다.')) return;
      }
      if(window.Game && typeof Game.persist === 'function'){
        try { Game.persist(); } catch(e){ console.warn('[Settings.exitGame] persist failed', e); }
      }
      Settings.close();
      // window.close() 는 자기가 연 창에서만 동작. 일반 탭은 차단됨.
      try { window.close(); } catch(e){}
      // 차단되면 안내. 약간 지연 후 페이지가 살아있으면 메시지.
      setTimeout(() => {
        if(document.visibilityState !== 'hidden'){
          alert('게임이 저장되었습니다.\n\n브라우저 탭을 직접 닫아주세요.');
        }
      }, 300);
    },
    /** BGM 토글 — 기존 SFX.toggle 재사용 (상태는 SFX.on 에 저장) */
    toggleBgm(){
      if(window.SFX && typeof SFX.toggle === 'function'){
        SFX.toggle();
        Settings._syncBgmLabel();
      }
    },
    _syncBgmLabel(){
      const btn = document.querySelector('#' + MODAL_ID + ' .set-bgm-btn');
      if(!btn) return;
      const on = !!(window.SFX && SFX.on);
      btn.textContent = on ? '🔊 BGM 끄기' : '🔇 BGM 켜기';
    },
    _syncVolume(){
      const slider = document.getElementById('vol-slider');
      const display = document.getElementById('vol-display');
      const toggle = document.getElementById('sound-toggle');
      const vol01 = (window.SFX && typeof SFX.vol === 'number') ? SFX.vol : 0.4;
      const v = Math.round(vol01 * 100);
      if(slider) slider.value = v;
      if(display) display.textContent = v;
      if(toggle){
        const on = !!(window.SFX && SFX.on);
        toggle.textContent = !on ? '🔇' : v === 0 ? '🔇' : v < 30 ? '🔉' : '🔊';
      }
    },
    _syncCloudStatus(){
      const el = document.querySelector('#' + MODAL_ID + ' .set-cloud-status');
      if(!el) return;
      if(!window.Backend || !Backend.isReady){
        el.textContent = '오프라인'; el.className = 'set-cloud-status is-off'; return;
      }
      // Supabase 세션이 살아있는지 확인 — Backend._user 는 내부 상태이나, 헬퍼가 없으면 버튼 상태 읽기
      const cloudBtn = document.getElementById('btn-cloud-link');
      const linked = cloudBtn && /연결됨/.test(cloudBtn.textContent || '');
      el.textContent = linked ? '연결됨' : '연결 안 됨';
      el.className = 'set-cloud-status ' + (linked ? 'is-on' : 'is-off');
    },
  };

  if(typeof RoF === 'undefined') window.RoF = {};
  RoF.Settings = Settings;
  window.Settings = Settings;  // 호환성
})();
