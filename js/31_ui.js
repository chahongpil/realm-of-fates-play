'use strict';

// Phase 3: UI → RoF.UI (+ window.UI 호환)
// ============ UI ============
RoF.UI={
  show(id){document.querySelectorAll('.screen').forEach(s=>s.classList.remove('active'));document.getElementById(id).classList.add('active');SFX.play('click');},
  modal(t,m,fn){
    document.getElementById('modal-title').textContent=t;
    document.getElementById('modal-msg').textContent=m;
    // Restore default buttons (in case askFormation replaced them)
    const mb=document.querySelector('#modal-overlay .modal-buttons');
    mb.innerHTML='<button class="btn btn-s" id="modal-confirm">확인</button><button class="btn btn-s btn-red" onclick="UI.closeModal()">취소</button>';
    document.getElementById('modal-confirm').onclick=()=>{UI.closeModal();if(fn)fn();};
    if(!fn){
      // No callback = just OK button, no cancel
      mb.innerHTML='<button class="btn btn-s" id="modal-confirm">확인</button>';
      document.getElementById('modal-confirm').onclick=()=>{UI.closeModal();};
    }
    document.getElementById('modal-overlay').classList.add('active');
  },
  closeModal(){document.getElementById('modal-overlay').classList.remove('active');},

  // 2026-04-27: 가벼운 토스트 — 자원 부족·간단 안내. 자동 1.6초 후 사라짐.
  // 동시 다발 호출 시 큐 안 쓰고 위로 쌓임 (Stack) — 최근 5개까지만 보존.
  toast(msg, opts){
    let stage=document.getElementById('toast-stage');
    if(!stage){
      stage=document.createElement('div');
      stage.id='toast-stage';
      document.body.appendChild(stage);
    }
    const t=document.createElement('div');
    t.className='ui-toast';
    if(opts && opts.kind) t.classList.add('toast-'+opts.kind);
    t.textContent=msg;
    stage.appendChild(t);
    while(stage.children.length>5) stage.removeChild(stage.firstChild);
    setTimeout(()=>{ t.classList.add('fade-out'); }, 1300);
    setTimeout(()=>{ if(t.parentElement) t.parentElement.removeChild(t); }, 1700);
  },

  // 2026-04-21: 전체화면 토글 (F 키 또는 ⛶ 버튼)
  // Fullscreen API — 진입 시 주소창/탭바 사라지고 창 꽉 사용 → fitViewport 가 자동 재계산.
  toggleFullscreen(){
    try {
      if (!document.fullscreenElement) {
        (document.documentElement.requestFullscreen || document.documentElement.webkitRequestFullscreen)
          .call(document.documentElement).catch(()=>{});
      } else {
        (document.exitFullscreen || document.webkitExitFullscreen).call(document).catch(()=>{});
      }
    } catch(e){}
  },
};

// 전체화면 상태 → 버튼 아이콘 반영 + F 키 단축키 (에디터/iframe 에서는 비활성)
document.addEventListener('fullscreenchange', () => {
  const btn = document.getElementById('fullscreen-toggle');
  if (btn) btn.textContent = document.fullscreenElement ? '⛷' : '⛶';
});
document.addEventListener('keydown', (e) => {
  if (e.key !== 'f' && e.key !== 'F') return;
  const t = e.target; if (t && /INPUT|TEXTAREA|SELECT/.test(t.tagName)) return;
  if (e.ctrlKey || e.altKey || e.metaKey) return;
  e.preventDefault();
  RoF.UI.toggleFullscreen();
});

// 호환성 레이어
window.UI = RoF.UI;
