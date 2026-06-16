// 56_book_of_life.js — Step 6 (2026-05-18)
// 생명의 서 (Book of Life) — 시안 book_of_life.jsx vanilla 마이그레이션.
// 도서관 NPC "생명의 서 확인하기" 진입. 펼친 책 layout (좌 인덱스 + spine + 우 마스터).

(function(){
  if(typeof RoF === 'undefined') return;

  const RARITY = {
    bronze:    {c1:'#8a8278', c2:'#bcb4a4', label:'일반'},
    silver:    {c1:'#3a6b9e', c2:'#7ab4e0', label:'희귀'},
    gold:      {c1:'#7a3bcc', c2:'#c89af0', label:'고귀한'},
    legendary: {c1:'#c89030', c2:'#f3d676', label:'전설의'},
    divine:    {c1:'#c83838', c2:'#ffd8a0', label:'신'},
  };
  const EL_LABEL = {fire:'화염', water:'서리', lightning:'번개', electric:'번개', earth:'대지', light:'광휘', holy:'광휘', dark:'심연'};
  const ROLE_LABEL = {warrior:'근접', ranger:'원거리', support:'지원', attack:'공격', defense:'방어', melee:'근접', ranged:'원거리'};

  RoF.BookOfLife = {
    _filter: 'all',
    _search: '',
    _selectedId: null,
    _zoomId: null,
    _escBound: false,

    show(){
      if(RoF.UI && RoF.UI.show) RoF.UI.show('book-of-life-screen');
      this._buildRoster();
      if(this._roster.length && !this._roster.find(u => u.id === this._selectedId)){
        this._selectedId = this._roster[0].id;
      }
      this._render();
      if(!this._escBound){
        this._escBound = true;
        document.addEventListener('keydown', (e) => {
          if(e.key === 'Escape' && this._zoomId){
            this.closePortraitZoom();
          }
        });
        // 검색 입력 wire
        const inp = document.getElementById('bol-search-input');
        if(inp){
          inp.addEventListener('input', (e) => {
            this._search = e.target.value;
            this._renderList();
          });
        }
        // 필터 chip wire
        document.querySelectorAll('#bol-filter-row .bol-filter').forEach(btn => {
          btn.addEventListener('click', () => {
            this._filter = btn.getAttribute('data-filter');
            document.querySelectorAll('#bol-filter-row .bol-filter').forEach(b => {
              b.classList.toggle('is-active', b === btn);
            });
            this._renderList();
          });
        });
      }
    },

    // RoF.Game.deck → 시안 ROSTER 형식 매핑.
    // 게임에 wounded/buried 시스템 미구현 — 모두 active. 추후 status 필드 추가 시 직접 사용.
    _buildRoster(){
      const deck = (RoF.Game && RoF.Game.deck) || [];
      this._roster = deck
        .filter(c => c && (c.kind === 'unit' || c.kind === 'hero' || c._isHero || c.isHero))
        .map(c => ({
          id: c.uid || c.id,
          dataId: c.id,
          art: c.skinKey || c.id,
          name: c.name || c.id || '?',
          title: this._titleFor(c),
          rarity: c.rarity || 'bronze',
          element: c.element || 'fire',
          role: c._heroRole || c.role || 'attack',
          level: c.level || c.matchLevel || 1,
          hp: c.HP ?? c.hp ?? 0,
          atk: c.ATK ?? c.atk ?? 0,
          def: c.DEF ?? c.def ?? 0,
          spd: c.SPD ?? c.spd ?? c.SOUL ?? 0,
          status: c._status || 'active',  // 추후 부상/매장 시스템 도입 시 직접 사용
          isHero: !!(c._isHero || c.isHero || c.kind === 'hero'),
          record: c._record || {battles:0, wins:0, kills:0, dmgDealt:0, dmgTaken:0, deaths:0},
          skills: (c.bundledSkillIds || []).map(sid => {
            const sk = (RoF.Data && RoF.Data.SKILLS || []).find(s => s.id === sid);
            return sk ? {name: sk.name || sk.id, art: sk.id, el: sk.element || 'holy'} : null;
          }).filter(Boolean),
          lore: c.desc || '',
        }));
    },

    _titleFor(c){
      if(!c) return '';
      const el = c.element;
      const role = c._heroRole || c.role;
      // 영웅: 원소 기반 칭호
      if(c._isHero || c.isHero || c.kind === 'hero'){
        const elTitle = {fire:'불의 대행자', water:'서리의 사도', lightning:'번개의 화신', earth:'대지의 수호자', holy:'여명의 수호자', light:'여명의 수호자', dark:'심연의 사자'};
        return elTitle[el] || '운명의 도전자';
      }
      // 동료: ability 또는 role + element 단순 매핑
      const elT = EL_LABEL[el] || '';
      return elT + ' ' + (ROLE_LABEL[role] || '동료');
    },

    _render(){
      this._renderCounts();
      this._renderList();
      this._renderMaster();
    },

    _renderCounts(){
      const counts = {
        all: this._roster.length,
        active:  this._roster.filter(u => u.status === 'active').length,
        wounded: this._roster.filter(u => u.status === 'wounded').length,
        buried:  this._roster.filter(u => u.status === 'buried').length,
      };
      const setText = (id, val) => { const el = document.getElementById(id); if(el) el.textContent = val; };
      setText('bol-count-active', counts.active);
      setText('bol-count-wounded', counts.wounded);
      setText('bol-count-buried', counts.buried);
      setText('bol-total', counts.all);
      setText('bol-filter-n-all', counts.all);
      setText('bol-filter-n-active', counts.active);
      setText('bol-filter-n-wounded', counts.wounded);
      setText('bol-filter-n-buried', counts.buried);
    },

    _renderList(){
      const list = document.getElementById('bol-unit-list');
      if(!list) return;
      const q = this._search.trim();
      const filtered = this._roster.filter(u => {
        if(this._filter !== 'all' && u.status !== this._filter) return false;
        if(q && !(u.name.indexOf(q) !== -1 || (u.title && u.title.indexOf(q) !== -1))) return false;
        return true;
      });
      if(filtered.length === 0){
        list.innerHTML = '<div style="flex:1;display:flex;align-items:center;justify-content:center;padding:30px;color:#5a4020;font:400 11px/1.5 var(--bol-fb);text-align:center;">조건에 맞는 동료가 없습니다.</div>';
        return;
      }
      list.innerHTML = '';
      filtered.forEach(u => {
        const R = RARITY[u.rarity] || RARITY.bronze;
        const row = document.createElement('div');
        row.className = 'bol-unit-row' +
          (u.id === this._selectedId ? ' is-selected' : '') +
          (u.status === 'buried' ? ' is-buried' : '');
        row.innerHTML =
          '<div class="bol-unit-portrait" style="background-image:url(\'' + (RoF.Data.CARD_IMG[u.art] || '') + '\');">' +
            (u.isHero ? '<div class="bol-unit-hero-badge">HERO</div>' : '') +
            '<div class="bol-unit-stripe" style="background:linear-gradient(90deg,' + R.c1 + ',' + R.c2 + ',' + R.c1 + ');"></div>' +
          '</div>' +
          '<div class="bol-unit-body">' +
            '<div class="bol-unit-line">' +
              '<span class="bol-unit-name">' + this._esc(u.name) + '</span>' +
              '<span class="bol-unit-lv">Lv ' + u.level + '</span>' +
            '</div>' +
            '<div class="bol-unit-title">"' + this._esc(u.title) + '"</div>' +
          '</div>' +
          '<span class="bol-unit-status-dot is-' + u.status + '"></span>';
        row.onclick = () => { this._selectedId = u.id; this._render(); };
        list.appendChild(row);
      });
    },

    _renderMaster(){
      const right = document.getElementById('bol-right-page');
      if(!right) return;
      const u = this._roster.find(x => x.id === this._selectedId);
      if(!u){
        right.innerHTML = '<div class="bol-right-placeholder">좌측에서 동료를 선택하세요.</div>';
        return;
      }
      const R = RARITY[u.rarity] || RARITY.bronze;
      const buried = u.status === 'buried';
      const wounded = u.status === 'wounded';
      const actionsHtml = this._renderActions(u);
      const statusLabel = u.status === 'active' ? '정상'
        : u.status === 'wounded' ? '부상 · 부활 진행 중'
        : '매장';
      right.innerHTML =
        '<div class="bol-master is-' + u.status + '">' +
          '<div class="bol-master-left">' +
            '<div class="bol-master-portrait" id="bol-master-portrait" style="background-image:url(\'' + (RoF.Data.CARD_IMG[u.art] || '') + '\');">' +
              (buried ? '<div class="bol-master-rip">R.I.P.</div>' : '') +
              '<div class="bol-master-portrait-zoom-hint">🔍 확대</div>' +
            '</div>' +
            '<div class="bol-status-pill is-' + u.status + '"><span class="bol-dot" style="background:' +
              (u.status === 'active' ? 'var(--bol-active)' : u.status === 'wounded' ? 'var(--bol-wounded)' : 'var(--bol-buried)') +
              ';box-shadow:0 0 6px currentColor;"></span>' + statusLabel + '</div>' +
          '</div>' +
          '<div class="bol-master-right">' +
            '<div>' +
              '<div class="bol-master-title">"' + this._esc(u.title) + '"</div>' +
              '<div class="bol-master-name-row">' +
                '<div class="bol-master-name">' + this._esc(u.name) + '</div>' +
                '<div class="bol-master-lv">Lv ' + u.level + '</div>' +
              '</div>' +
              '<div class="bol-master-chips">' +
                '<span class="bol-master-chip is-rarity" style="background:linear-gradient(180deg,' + R.c2 + ',' + R.c1 + ');border-color:' + R.c2 + ';">' + R.label + '</span>' +
                '<span class="bol-master-chip">' + (EL_LABEL[u.element] || u.element) + '</span>' +
                '<span class="bol-master-chip">' + (ROLE_LABEL[u.role] || u.role) + '</span>' +
              '</div>' +
            '</div>' +
            '<div class="bol-master-stats">' +
              this._statBox('HP', u.hp, '#ffd0d0', '♥') +
              this._statBox('ATK', u.atk, '#dff0ff', '⚔') +
              this._statBox('DEF', u.def, '#bcd896', '❖') +
              this._statBox('SOUL', u.spd, '#d0baff', '✦') +
            '</div>' +
            this._renderRecord(u) +
            this._renderSkills(u) +
            (u.lore ? '<div class="bol-master-lore">' + this._esc(u.lore) + '</div>' : '') +
            actionsHtml +
          '</div>' +
        '</div>';
      // portrait zoom wire
      const portraitEl = document.getElementById('bol-master-portrait');
      if(portraitEl){
        portraitEl.onclick = () => this.openPortraitZoom(u.id);
      }
    },

    _statBox(label, val, color, icon){
      return '<div class="bol-stat">' +
        '<div class="bol-stat-label">' + label + '</div>' +
        '<div class="bol-stat-value" style="color:' + color + ';text-shadow:0 0 5px ' + color + '55;">' + icon + ' ' + val + '</div>' +
      '</div>';
    },

    _renderRecord(u){
      const r = u.record || {};
      const winRate = r.battles ? Math.round((r.wins / r.battles) * 100) : 0;
      return '<div class="bol-master-record">' +
        '<div class="bol-master-record-label">누적 전적</div>' +
        '<div class="bol-master-record-grid">' +
          '<div class="bol-rec"><div class="bol-rec-label">전투</div><div class="bol-rec-value">' + (r.battles || 0) + '</div></div>' +
          '<div class="bol-rec"><div class="bol-rec-label">승률</div><div class="bol-rec-value">' + winRate + '%</div></div>' +
          '<div class="bol-rec"><div class="bol-rec-label">처치</div><div class="bol-rec-value">' + (r.kills || 0) + '</div></div>' +
          '<div class="bol-rec"><div class="bol-rec-label">가한 피해</div><div class="bol-rec-value">' + (r.dmgDealt || 0) + '</div></div>' +
          '<div class="bol-rec"><div class="bol-rec-label">받은 피해</div><div class="bol-rec-value">' + (r.dmgTaken || 0) + '</div></div>' +
          '<div class="bol-rec"><div class="bol-rec-label">전사</div><div class="bol-rec-value">' + (r.deaths || 0) + '</div></div>' +
        '</div>' +
      '</div>';
    },

    _renderSkills(u){
      if(!u.skills || !u.skills.length) return '';
      const items = u.skills.map(s =>
        '<span class="bol-skill-chip">' +
          '<span class="bol-skill-icon" style="background-image:url(\'' + (RoF.Data.CARD_IMG[s.art] || RoF.Data.skillImg(s.art) || '') + '\');"></span>' +
          this._esc(s.name) +
        '</span>'
      ).join('');
      return '<div class="bol-master-skills">' +
        '<div class="bol-master-skills-label">장착 시그니처</div>' +
        '<div class="bol-master-skills-list">' + items + '</div>' +
      '</div>';
    },

    _renderActions(u){
      // 시안 README §3 — 상태별 액션 분기
      let btns = '';
      if(u.status === 'active'){
        btns +=
          '<button class="bol-action-btn is-primary" data-action="bookOfLife.actionFormation" data-arg="' + u.id + '">⚔ 편성에 추가</button>' +
          '<button class="bol-action-btn" data-action="bookOfLife.actionShowCard" data-arg="' + u.id + '">🃏 카드 보기</button>';
        if(!u.isHero){
          btns += '<button class="bol-action-btn is-danger" data-action="bookOfLife.actionBury" data-arg="' + u.id + '">⚠ 자율 매장</button>';
        }
      } else if(u.status === 'wounded'){
        btns +=
          '<button class="bol-action-btn is-primary" data-action="bookOfLife.actionRevive" data-arg="' + u.id + '">✧ 부활하기 (골드)</button>' +
          '<button class="bol-action-btn" data-action="bookOfLife.actionShowCard" data-arg="' + u.id + '">🃏 카드 보기</button>' +
          '<button class="bol-action-btn is-danger" data-action="bookOfLife.actionBury" data-arg="' + u.id + '">⚰ 장례 치르기</button>';
      } else {  // buried
        btns +=
          '<button class="bol-action-btn" data-action="bookOfLife.actionShowCard" data-arg="' + u.id + '">🃏 생전 카드 보기</button>' +
          '<button class="bol-action-btn" data-action="bookOfLife.actionMemorial" data-arg="' + u.id + '">🕯 추모하기</button>' +
          '<button class="bol-action-btn is-primary" data-action="bookOfLife.actionResurrect" data-arg="' + u.id + '">🔓 부활권 사용 (3 ✦)</button>';
      }
      // 2026-05-18 사용자 명시 "돌아가기 버튼 없음 — 편성에 추가 버튼과 같은 크기/글씨로 추가"
      btns += '<button class="bol-action-btn" data-action="game.showTown">◂ 돌아가기</button>';
      return '<div class="bol-master-actions">' + btns + '</div>';
    },

    // ─── Action stubs (게임 시스템 통합은 추후) ───
    actionFormation(uid){
      const u = this._roster.find(x => x.id === uid);
      if(!u) return;
      if(RoF.Game && RoF.Game.showCastle) RoF.Game.showCastle();  // 도서관 닫고 마을 → 전열정비로
      setTimeout(() => {
        if(RoF.Formation && RoF.Formation.show) RoF.Formation.show();
      }, 100);
    },
    actionShowCard(uid){
      this.openPortraitZoom(uid);
    },
    actionBury(uid){ this._showToast && this._showToast('매장 시스템은 추후 구현됩니다.'); },
    actionRevive(uid){ this._showToast && this._showToast('부활 시스템은 추후 구현됩니다.'); },
    actionMemorial(uid){ this._showToast && this._showToast('추모 시스템은 추후 구현됩니다.'); },
    actionResurrect(uid){ this._showToast && this._showToast('부활권 시스템은 추후 구현됩니다.'); },

    _showToast(msg){
      // 게임의 토스트 시스템 사용. 없으면 console.
      if(RoF.UI && RoF.UI.toast) RoF.UI.toast(msg);
      else console.log('[book-of-life] ' + msg);
    },

    // ─── Portrait Zoom Modal ───
    openPortraitZoom(uid){
      const u = this._roster.find(x => x.id === uid);
      if(!u) return;
      this._zoomId = uid;
      const modal = document.getElementById('bol-portrait-zoom');
      const card = document.getElementById('bol-portrait-zoom-card');
      const info = document.getElementById('bol-portrait-zoom-info');
      if(!modal || !card || !info) return;
      const R = RARITY[u.rarity] || RARITY.bronze;
      const buried = u.status === 'buried';
      card.style.backgroundImage = "url('" + (RoF.Data.CARD_IMG[u.art] || '') + "')";
      card.style.borderColor = R.c1;
      card.style.filter = buried ? 'grayscale(.9) brightness(.45)' : 'none';
      info.innerHTML =
        '<div style="font:400 9px/1 var(--bol-fb);letter-spacing:.42em;color:#7a6c52;font-style:italic;margin-bottom:6px;">"' + this._esc(u.title) + '"</div>' +
        '<div style="display:flex;align-items:baseline;gap:10px;margin-bottom:8px;">' +
          '<div style="font:900 26px/1.1 var(--bol-fd);color:' + (buried ? '#a89478' : 'var(--bol-gold)') + ';letter-spacing:.04em;text-shadow:' + (buried ? 'none' : '0 0 12px rgba(243,214,118,.4)') + ';">' + this._esc(u.name) + '</div>' +
          '<div style="font:900 14px/1 var(--bol-ft);color:#a89478;">Lv ' + u.level + '</div>' +
        '</div>' +
        '<div style="display:flex;gap:5px;flex-wrap:wrap;margin-bottom:14px;">' +
          '<span class="bol-master-chip is-rarity" style="background:linear-gradient(180deg,' + R.c2 + ',' + R.c1 + ');border-color:' + R.c2 + ';">' + R.label + '</span>' +
          '<span class="bol-master-chip">' + (EL_LABEL[u.element] || u.element) + '</span>' +
          '<span class="bol-master-chip">' + (ROLE_LABEL[u.role] || u.role) + '</span>' +
        '</div>' +
        '<div class="bol-master-stats" style="margin-bottom:14px;">' +
          this._statBox('HP', u.hp, '#ffd0d0', '♥') +
          this._statBox('ATK', u.atk, '#dff0ff', '⚔') +
          this._statBox('DEF', u.def, '#bcd896', '❖') +
          this._statBox('SOUL', u.spd, '#d0baff', '✦') +
        '</div>' +
        (u.lore ? '<div class="bol-master-lore" style="margin:0;">' + this._esc(u.lore) + '</div>' : '');
      modal.style.display = 'flex';
      // backdrop 클릭 닫기
      modal.onclick = (e) => { if(e.target === modal) this.closePortraitZoom(); };
    },
    closePortraitZoom(){
      this._zoomId = null;
      const modal = document.getElementById('bol-portrait-zoom');
      if(modal) modal.style.display = 'none';
    },

    _esc(s){
      if(!s) return '';
      const d = document.createElement('div'); d.textContent = s; return d.innerHTML;
    },
  };
})();
