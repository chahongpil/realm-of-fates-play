'use strict';

/* ============================================================
   Realm of Fates — Profile Card Select Modal (2026-05-03)
   ============================================================
   - 목적: 마을 좌상단 프로필 슬롯 = 영웅 카드 default + 보유 카드 중 선택 가능.
   - 트리거: 마을 좌상단 #town-profile 클릭 → Profile.open()
   - 동작:
     - 모달 열기 → 보유 카드 (Game.deck) 그리드 렌더링 → 영웅이 첫 슬롯
     - 카드 클릭 → setProfileCard(uid) → 모달 닫기 → showMenu() 다시 (마을 슬롯 갱신)
   - 데이터: Game.profileCardId (50_game_core.js 의 getProfileCard / setProfileCard)
   - bindings: RoF.Profile 로 등록, 99_bindings.js MODULE_MAP 의 profile 매핑.
   ============================================================ */

(function(){
  const MODAL_ID = 'profile-modal';
  const GRID_ID  = 'profile-grid';
  const FRAME_MODAL_ID = 'profile-frame-modal';
  const FRAME_GRID_ID  = 'profile-frame-grid';
  const POPOVER_ID = 'profile-popover';

  // 2026-05-03 P1: ESC + 백드롭 클릭으로 닫기 (UX 표준).
  let _escHandler = null;
  let _backdropHandler = null;
  // 2026-05-14 — 팝오버 외부 click 닫기 listener
  let _popoverDocClickHandler = null;

  const Profile = {
    /** 2026-05-14 — 얼굴 클릭 진입점. 팝오버 표시 (2 메뉴).
     *  사용자 컨펌 (편집기 _profile_popover_editor.html 출력) — base 1280×720 좌표 고정. */
    open(e){
      const pop = document.getElementById(POPOVER_ID);
      if(!pop) return;
      pop.style.left = '145px';
      pop.style.top  = '64px';
      pop.classList.add('is-open');
      // 외부 click 닫기 (팝오버 안 click 은 무시)
      if(_popoverDocClickHandler) document.removeEventListener('click', _popoverDocClickHandler);
      _popoverDocClickHandler = (ev) => {
        if(ev.target.closest('#' + POPOVER_ID)) return;
        if(ev.target.closest('#town-profile')) return;
        if(trigger && ev.target === trigger) return;
        pop.classList.remove('is-open');
        document.removeEventListener('click', _popoverDocClickHandler);
        _popoverDocClickHandler = null;
      };
      // 다음 tick 에 listener 등록 (지금 click 의 bubble 무시)
      setTimeout(() => document.addEventListener('click', _popoverDocClickHandler), 0);
    },
    /** 팝오버 → "프로필 변경" → 일러스트 모달 */
    openIllust(){
      Profile._closePopover();
      const m = document.getElementById(MODAL_ID);
      const g = document.getElementById(GRID_ID);
      if(!m || !g) return;
      Profile._renderGrid(g);
      m.classList.add('active');
      _escHandler = (e) => { if(e.key === 'Escape') Profile.close(); };
      document.addEventListener('keydown', _escHandler);
      _backdropHandler = (e) => { if(e.target === m) Profile.close(); };
      m.addEventListener('click', _backdropHandler);
    },
    /** 팝오버 → "프레임 변경" → 프레임 모달 */
    openFrame(){
      Profile._closePopover();
      const m = document.getElementById(FRAME_MODAL_ID);
      const g = document.getElementById(FRAME_GRID_ID);
      if(!m || !g) return;
      Profile._renderFrameGrid(g);
      m.classList.add('active');
      _escHandler = (e) => { if(e.key === 'Escape') Profile.closeFrame(); };
      document.addEventListener('keydown', _escHandler);
      _backdropHandler = (e) => { if(e.target === m) Profile.closeFrame(); };
      m.addEventListener('click', _backdropHandler);
    },
    closeFrame(){
      const m = document.getElementById(FRAME_MODAL_ID);
      if(m) m.classList.remove('active');
      if(_escHandler){ document.removeEventListener('keydown', _escHandler); _escHandler = null; }
      if(_backdropHandler && m){ m.removeEventListener('click', _backdropHandler); _backdropHandler = null; }
    },
    selectFrame(frameId){
      if(!window.Game || typeof Game.setProfileFrame !== 'function') return;
      const ok = Game.setProfileFrame(frameId);
      if(!ok) return;
      Profile.closeFrame();
      if(typeof Game.showMenu === 'function'){
        const onMenu = document.getElementById('menu-screen')?.classList.contains('active');
        if(onMenu) Game.showMenu();
      }
      if(window.SFX && SFX.play) SFX.play('click');
    },
    _renderFrameGrid(g){
      g.innerHTML = '';
      const currentFrameId = (Game && Game.profileFrameId) || 'none';
      const currentIllustImg = Profile._currentIllustImg();
      const FRAMES = [
        { uid:'none',   img:null,                           name:'없음' },
        { uid:'silver', img:'img/ui/frames/profile_frame_silver.png', name:'실버' },
      ];
      FRAMES.forEach(f => {
        const isCurrent = (currentFrameId === f.uid);
        const el = document.createElement('div');
        el.className = 'profile-card-mini' + (isCurrent ? ' is-current' : '');
        el.setAttribute('data-action', 'profile.selectFrame');
        el.setAttribute('data-arg', f.uid);
        // 현재 일러스트 + 각 프레임 덮씌움 미리보기
        const overlay = f.img
          ? `<div class="profile-frame-overlay" style="background-image:url('${f.img}');"></div>`
          : '';
        el.innerHTML = `
          <div class="pcm-img" style="background-image:url('${currentIllustImg}');position:relative;">
            ${overlay}
            ${isCurrent ? '<div class="pcm-current-badge">✓</div>' : ''}
          </div>
          <div class="pcm-name">${f.name}</div>
        `;
        g.appendChild(el);
      });
    },
    _currentIllustImg(){
      const PROFILE_SRC = {
        'profile_m_warrior': 'img/heroes/m_warrior/profile.png',
        'profile_f_warrior': 'img/heroes/f_warrior/profile.png',
        'profile_titan':     'img/npcs/profile_titan.png',
      };
      const pid = (window.Game && Game.profileCardId) || 'profile_m_warrior';
      return PROFILE_SRC[pid] || PROFILE_SRC.profile_m_warrior;
    },
    _closePopover(){
      const pop = document.getElementById(POPOVER_ID);
      if(pop) pop.classList.remove('is-open');
      if(_popoverDocClickHandler){
        document.removeEventListener('click', _popoverDocClickHandler);
        _popoverDocClickHandler = null;
      }
    },
    close(){
      const m = document.getElementById(MODAL_ID);
      if(m) m.classList.remove('active');
      if(_escHandler){
        document.removeEventListener('keydown', _escHandler);
        _escHandler = null;
      }
      if(_backdropHandler && m){
        m.removeEventListener('click', _backdropHandler);
        _backdropHandler = null;
      }
    },
    /** 2026-05-14 사용자 — 잠금 카드 클릭 시 해금 방법 안내 toast */
    showUnlockHint(uid){
      const HINTS = {
        'profile_m_warrior': '남자 영웅으로 시즌 진행 시 자동 해금',
        'profile_f_warrior': '여자 영웅으로 시즌 진행 시 자동 해금',
        'profile_titan':     '시즌 1 명예 점수 1000 달성 시 해금 (추후 업데이트)',
      };
      const msg = HINTS[uid] || '🔒 잠금 — 해금 조건은 추후 공개';
      if(window.UI && typeof UI.toast === 'function'){
        UI.toast(msg);
      } else {
        // fallback: 단순 alert
        alert(msg);
      }
      if(window.SFX && SFX.play) SFX.play('click');
    },
    /** 카드 선택 — uid 입력. setProfileCard 호출 후 마을 다시 렌더. */
    select(uid){
      if(!window.Game || typeof Game.setProfileCard !== 'function') return;
      const ok = Game.setProfileCard(uid);
      if(!ok) return;
      Profile.close();
      // 마을 화면이 노출 중이면 즉시 갱신 (다른 화면이면 다음 진입 시 자동 반영)
      if(typeof Game.showMenu === 'function'){
        const onMenu = document.getElementById('menu-screen')?.classList.contains('active');
        if(onMenu) Game.showMenu();
      }
      if(window.SFX && SFX.play) SFX.play('click');
    },

    _renderGrid(g){
      // 2026-05-13 사용자 결정 — 프로필 카드 3종 (m_warrior / f_warrior / titan) 고정.
      // 영웅 성별 매칭만 선택 가능, 그 외 잠금 (회색 + 클릭 X).
      g.innerHTML = '';
      const currentId = (Game && Game.profileCardId) || null;
      const deck = (window.Game && Array.isArray(Game.deck)) ? Game.deck : [];
      const hero = deck.find(c => c && c.isHero);
      // 영웅 성별 추출 (m/f). 영웅 카드의 img = protagonist_<g>_*. titan 은 별도 잠금.
      let heroGender = 'm';
      if(hero && hero.img){
        if(hero.img.indexOf('protagonist_f_') === 0) heroGender = 'f';
        else if(hero.img.indexOf('protagonist_m_') === 0) heroGender = 'm';
      }
      const FIXED_PROFILES = [
        { uid:'profile_m_warrior', img:'img/heroes/m_warrior/profile.png', name:'남자 주인공',  locked: heroGender !== 'm' },
        { uid:'profile_f_warrior', img:'img/heroes/f_warrior/profile.png', name:'여자 주인공',  locked: heroGender !== 'f' },
        { uid:'profile_titan',     img:'img/npcs/profile_titan.png',     name:'타이탄',       locked: true },  // 향후 잠금 해제
      ];
      FIXED_PROFILES.forEach(p => {
        const defaultId = (heroGender === 'f') ? 'profile_f_warrior' : 'profile_m_warrior';
        const isCurrent = (currentId === p.uid) || (!currentId && p.uid === defaultId);
        const el = document.createElement('div');
        el.className = 'profile-card-mini' + (isCurrent ? ' is-current' : '') + (p.locked ? ' is-locked' : '');
        // 2026-05-14 사용자 — 잠금 카드도 클릭 가능 (해금 안내 표시)
        if(p.locked){
          el.setAttribute('data-action', 'profile.showUnlockHint');
          el.setAttribute('data-arg', p.uid);
        } else {
          el.setAttribute('data-action', 'profile.select');
          el.setAttribute('data-arg', p.uid);
        }
        el.innerHTML = `
          <div class="pcm-img" style="background-image:url('${p.img}');">
            ${isCurrent ? '<div class="pcm-current-badge">✓</div>' : ''}
            ${p.locked ? '<div class="pcm-locked-badge">🔒</div>' : ''}
          </div>
          <div class="pcm-name">${p.name}</div>
        `;
        g.appendChild(el);
      });
    },
  };

  if(typeof RoF === 'undefined') window.RoF = {};
  RoF.Profile = Profile;
  window.Profile = Profile;  // 호환성
})();
