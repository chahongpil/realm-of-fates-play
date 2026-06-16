'use strict';

/* ============================================================
   Realm of Fates — Formation Slots Modal (2026-05-03)
   ============================================================
   - 목적: 편성 화면(card-select) 의 "편성 기억/소환" 단일 버튼을 폐기하고
     3 고정 슬롯 + 이름 편집 가능한 모달로 대체.
   - 트리거: cs-actions 의 "📜 편성 슬롯" 버튼 → FormationSlots.open()
   - 데이터: Game.savedFormations [{name, units, relics}] × 3 (50_game_core.js load 에서 정규화).
   - 동작:
     - open: 모달 열기, 3 슬롯 렌더링
     - save(idx): 현재 selectedForBattle/selectedRelics 를 슬롯 idx 에 저장
     - load(idx): 슬롯 idx → selectedForBattle/selectedRelics 적용
     - rename(idx): inline 텍스트 편집 → name 갱신
     - close: 모달 닫기 + ESC + 백드롭
   ============================================================ */

(function(){
  const MODAL_ID = 'formation-slots-modal';
  const GRID_ID  = 'fs-grid';

  let _escHandler = null;
  let _backdropHandler = null;

  const FormationSlots = {
    open(){
      const m = document.getElementById(MODAL_ID);
      const g = document.getElementById(GRID_ID);
      if(!m || !g) return;
      FormationSlots._render();
      m.classList.add('active');
      _escHandler = (e) => { if(e.key === 'Escape') FormationSlots.close(); };
      document.addEventListener('keydown', _escHandler);
      _backdropHandler = (e) => { if(e.target === m) FormationSlots.close(); };
      m.addEventListener('click', _backdropHandler);
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

    /** 슬롯 idx 에 현재 편성 저장 (덮어쓰기). */
    save(arg){
      const idx = parseInt(arg, 10);
      if(!FormationSlots._validIdx(idx)) return;
      if(!window.Game) return;
      const slot = Game.savedFormations[idx];
      const hasExisting = slot && slot.units && slot.units.length > 0;
      if(hasExisting){
        const ok = (typeof confirm === 'function')
          ? confirm(slot.name + '\n\n이미 저장된 편성이 있습니다. 덮어쓸까요?')
          : true;
        if(!ok) return;
      }
      const units  = Array.isArray(Game.selectedForBattle) ? Game.selectedForBattle.slice() : [];
      const relics = Array.isArray(Game.selectedRelics)    ? Game.selectedRelics.slice()    : [];
      if(units.length === 0){
        if(window.UI && UI.toast) UI.toast('⚠️ 출전 동료가 없습니다. 먼저 편성하세요.', {kind:'warn'});
        return;
      }
      Game.savedFormations[idx] = {
        name:   slot.name || ((idx+1) + '번 편성'),
        units:  units,
        relics: relics,
      };
      Game.persist();
      if(window.SFX && SFX.play) SFX.play('upgrade');
      FormationSlots._render();
      if(window.UI && UI.toast) UI.toast('📜 ' + Game.savedFormations[idx].name + ' 저장 완료', {kind:'info'});
    },

    /** 슬롯 idx 의 편성을 현재 편성에 적용. */
    load(arg){
      const idx = parseInt(arg, 10);
      if(!FormationSlots._validIdx(idx)) return;
      if(!window.Game) return;
      const f = Game.savedFormations[idx];
      if(!f || !f.units || f.units.length === 0){
        if(window.UI && UI.toast) UI.toast('⚠️ 빈 슬롯입니다. 먼저 저장하세요.', {kind:'warn'});
        return;
      }
      // 카드 변경/부상으로 stale 한 uid 는 자동 필터.
      const validUnits = f.units.filter(uid =>
        Game.deck.some(c => c.uid === uid && !c.injured)
      );
      const validRelics = f.relics.filter(uid =>
        (Game.ownedRelics || []).some(r => r.uid === uid)
      );
      Game.selectedForBattle = validUnits;
      Game.selectedRelics    = validRelics;
      if(window.SFX && SFX.play) SFX.play('card_reveal');
      // 편성 화면 재렌더 — Game.renderCardSelect 호출
      if(typeof Game.renderCardSelect === 'function') Game.renderCardSelect();
      FormationSlots.close();
      if(window.UI && UI.toast){
        UI.toast('📜 ' + f.name + ' 소환 (동료 ' + validUnits.length + ')', {kind:'info'});
      }
    },

    /** 슬롯 idx 이름 편집 — inline prompt. */
    rename(arg){
      const idx = parseInt(arg, 10);
      if(!FormationSlots._validIdx(idx)) return;
      if(!window.Game) return;
      const slot = Game.savedFormations[idx];
      const current = (slot && slot.name) || ((idx+1) + '번 편성');
      const next = (typeof prompt === 'function')
        ? prompt('편성 이름 (1~16자)', current)
        : null;
      if(next == null) return;
      const trimmed = String(next).trim().slice(0, 16);
      if(!trimmed) return;
      Game.savedFormations[idx].name = trimmed;
      Game.persist();
      FormationSlots._render();
      if(window.SFX && SFX.play) SFX.play('click');
    },

    /** 슬롯 idx 비우기 (저장된 편성 삭제). */
    clear(arg){
      const idx = parseInt(arg, 10);
      if(!FormationSlots._validIdx(idx)) return;
      if(!window.Game) return;
      const slot = Game.savedFormations[idx];
      if(!slot || !slot.units || slot.units.length === 0) return;
      const ok = (typeof confirm === 'function')
        ? confirm(slot.name + '\n\n저장된 편성을 삭제할까요?')
        : true;
      if(!ok) return;
      Game.savedFormations[idx] = {
        name:   (idx+1) + '번 편성',
        units:  [],
        relics: [],
      };
      Game.persist();
      FormationSlots._render();
      if(window.SFX && SFX.play) SFX.play('click');
    },

    _validIdx(idx){
      return Number.isInteger(idx) && idx >= 0 && idx <= 2;
    },

    _render(){
      const g = document.getElementById(GRID_ID);
      if(!g || !window.Game) return;
      const slots = Array.isArray(Game.savedFormations) ? Game.savedFormations : [];
      g.innerHTML = '';
      [0, 1, 2].forEach(function(i){
        const f = slots[i] || { name: (i+1) + '번 편성', units: [], relics: [] };
        const isEmpty = !f.units || f.units.length === 0;
        const el = document.createElement('div');
        el.className = 'fs-slot' + (isEmpty ? ' is-empty' : '');
        // 2026-05-03 P0 픽스: 🗑️ 삭제를 헤더로 이동 (slot 폭 221px 안에 3 액션 버튼 안 들어감).
        // 저장 버튼 색을 green 으로 (불러오기 blue 와 시각 차등 명확화).
        el.innerHTML = `
          <div class="fs-slot-head">
            <div class="fs-slot-num">${i+1}</div>
            <div class="fs-slot-name" title="이름 편집">${escapeHtml(f.name || ((i+1)+'번 편성'))}</div>
            <button class="fs-slot-rename" data-action="formationSlots.rename" data-arg="${i}" title="이름 편집">✏️</button>
            ${isEmpty
              ? ''
              : '<button class="fs-slot-clear" data-action="formationSlots.clear" data-arg="'+i+'" title="이 슬롯 삭제">🗑️</button>'}
          </div>
          <div class="fs-slot-info">
            ${isEmpty
              ? '<div class="fs-slot-empty-hint">비어있음</div>'
              : '<div class="fs-slot-meta">동료 <b>'+f.units.length+'</b> · 유물 <b>'+(f.relics?f.relics.length:0)+'</b></div>'}
          </div>
          <div class="fs-slot-actions">
            <button class="btn btn-s btn-green" data-action="formationSlots.save" data-arg="${i}">💾 저장</button>
            <button class="btn btn-s btn-blue" data-action="formationSlots.load" data-arg="${i}" ${isEmpty?'disabled':''}>📜 불러오기</button>
          </div>
        `;
        g.appendChild(el);
      });
    },
  };

  function escapeHtml(s){
    return String(s == null ? '' : s)
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;');
  }

  if(typeof RoF === 'undefined') window.RoF = {};
  RoF.FormationSlots = FormationSlots;
  window.FormationSlots = FormationSlots;
})();
