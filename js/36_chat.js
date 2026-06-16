'use strict';

/* ============================================================
   Realm of Fates — PHASE 5 Chat (Step 2: world 단일 채널 MVP)
   ============================================================
   - 기획서: game/PHASE5_CHAT_PLAN.md
   - Backend API: RoF.Backend.chat* (js/35_backend.js S3 섹션)
   - Step 2 범위: world 채널 1개 + 기본 전송·수신·뮤트 안내
   - Step 3 에서 3채널 탭 확장, Step 4 에서 카드 공유, Step 5 에서 발언 제한 세부
   ============================================================ */

(function(){

  const PANEL_ID   = 'chat-panel';
  const TOGGLE_ID  = 'chat-toggle';
  const DEFAULT_KIND = 'world';

  // 리그 한국어명 (Game.LEAGUES 에서 id 로 매칭)
  const LEAGUE_NAMES = {
    bronze:'브론즈', silver:'실버', gold:'골드', platinum:'플래티넘',
    diamond:'다이아', master:'마스터', divine:'신의 영역'
  };

  const COOLDOWN_MS = 5000;
  const MAX_LEN = 200;
  const HISTORY_LIMIT = 50;

  // PHASE 5 Step 5a: 채널별 최소 레벨 — Lv5 미만은 world 채널 차단(저레벨 신규 어그로 방지).
  // league/guild 는 자체 진입 조건이 있으므로 1.
  const MIN_LEVEL = { world: 5, league: 1, guild: 1 };

  // PHASE 5 Step 5b: 도배 감지 — sliding window 60초에 8개 도달 시 사전 경고 banner.
  // 서버 trigger(004 migration trg_auto_mute_on_flood) 가 10개 도달 시 30분 자동 뮤트.
  const FLOOD_WINDOW_MS = 60000;
  const FLOOD_WARN_AT   = 8;
  const FLOOD_HARD_LIMIT = 10;

  // PHASE 5 Step 4 v2 / 2단계: @ 자동완성 dropdown 표시용 라벨.
  const ELEM_BADGE = {
    fire:'🔥', water:'💧', lightning:'⚡', earth:'🌿', holy:'✨', dark:'🌙'
  };
  const RARITY_LABEL = {
    bronze:'일반', silver:'희귀', gold:'고귀한', legendary:'전설의', divine:'신'
  };

  const Chat = {
    _activeKind: DEFAULT_KIND,   // 'world' | 'league' | 'guild'
    _activeChannel: 'ch_world',  // 실제 channel id — _resolveChannel() 로 갱신
    _sub: null,                  // realtime subscription
    _lastSent: 0,                // 쿨다운 체크용 timestamp
    _sentTimestamps: [],         // PHASE 5 Step 5b: 도배 감지 sliding window
    _lastMsgTime: null,          // gap 복구용 마지막 수신 시각
    _unreadCount: 0,
    _muteCheckInterval: null,

    /** kind → 실제 channel id 해석. save.league / save.guild_id 참조. */
    _resolveChannel(kind){
      const save = (window.Game && Game.leaguePoints != null) ? Game : null;
      const leagueId = (save && save.getLeague) ? (save.getLeague().id || 'bronze') : 'bronze';
      const guildId = (save && save.guild_id) || null;
      if(kind === 'league') return 'ch_league_' + leagueId;
      if(kind === 'guild')  return guildId ? ('ch_guild_' + guildId) : null;
      return 'ch_world';
    },

    /** PHASE 5 Step 5a: 내 영웅 레벨. backend.chatSend 와 동일 계산식 (단일 source).
     *  save.heroLevel 우선, 없으면 영웅 카드의 .level, 그것도 없으면 1. */
    _getMyLevel(){
      const save = (typeof RoF !== 'undefined' && RoF.Game) ? RoF.Game : (window.Game || null);
      if(!save) return 1;
      if(save.heroLevel != null) return Math.max(1, save.heroLevel|0);
      if(Array.isArray(save.deck)){
        const hero = save.deck.find(c => c && c.isHero);
        if(hero && hero.level) return Math.max(1, hero.level|0);
      }
      return 1;
    },

    /** kind 채널의 최소 진입 레벨 */
    _minLevelFor(kind){
      return MIN_LEVEL[kind] || 1;
    },

    /** kind → 헤더 제목 */
    _channelTitle(kind){
      if(kind === 'world')  return '🌍 운명의 광장';
      if(kind === 'league') {
        const lg = (window.Game && Game.getLeague) ? Game.getLeague() : null;
        const name = lg ? (LEAGUE_NAMES[lg.id] || lg.name) : '리그';
        return `🏛 ${name} 모임`;
      }
      if(kind === 'guild')  return '🛡 길드 전당';
      return '채팅';
    },

    /** 초기화 — 게임 로드 시 1회 호출 */
    async init(){
      this._bindDOM();
      if(!window.Backend || !Backend.isReady){
        this._showBanner('오프라인 모드 — 채팅 불가', 'error');
        this._setInputDisabled(true);
        return;
      }
      // Auth 세션 없으면 로그인 대기 상태로. 로그인 완료 시 onAuthChange 가 _loadAndSubscribe 호출.
      const user = Backend.getCurrentUser();
      if(!user){
        this._showBanner('로그인 후 이용 가능', 'info');
        this._setInputDisabled(true);
      } else {
        await this._loadAndSubscribe(this._activeChannel);
      }

      // Auth 변화 구독 — SIGNED_IN: 채팅 활성, SIGNED_OUT: 비활성
      Backend.onAuthChange((event, u) => {
        if(event === 'SIGNED_IN' || (event === 'INITIAL_SESSION' && u)){
          this._hideBanner();
          this._setInputDisabled(false);
          this._loadAndSubscribe(this._activeChannel);
          this._refreshMuteStatus();
        } else if(event === 'SIGNED_OUT'){
          if(this._sub){ this._sub.unsubscribe(); this._sub = null; }
          this._showBanner('로그인 후 이용 가능', 'info');
          this._setInputDisabled(true);
        }
      });

      // 뮤트 상태 5초마다 점검 (자동 해제 감지)
      this._muteCheckInterval = setInterval(()=> this._refreshMuteStatus(), 5000);
      if(user) this._refreshMuteStatus();
    },

    /** 패널 토글 */
    open(){
      const p = document.getElementById(PANEL_ID);
      if(!p) return;
      p.classList.add('active');
      this._unreadCount = 0;
      this._updateBadge();
      // 열릴 때 맨 아래로 스크롤
      const msgs = p.querySelector('.cp-messages');
      if(msgs) msgs.scrollTop = msgs.scrollHeight;
    },
    close(){
      const p = document.getElementById(PANEL_ID);
      if(p) p.classList.remove('active');
    },
    toggle(){
      const p = document.getElementById(PANEL_ID);
      if(!p) return;
      if(p.classList.contains('active')) this.close(); else this.open();
    },

    // ── 내부: DOM 바인딩 ───────────────────────────────
    _bindDOM(){
      const panel = document.getElementById(PANEL_ID);
      const toggle = document.getElementById(TOGGLE_ID);
      if(!panel || !toggle) return;

      toggle.onclick = () => this.toggle();
      panel.querySelector('.cp-close').onclick = () => this.close();

      const input = panel.querySelector('.cp-input');
      const send = panel.querySelector('.cp-send');
      const counter = panel.querySelector('.cp-counter');

      const updateCounter = () => {
        const len = input.value.length;
        counter.textContent = `${len}/${MAX_LEN}`;
        counter.classList.toggle('over', len > MAX_LEN);
        counter.classList.toggle('warn', len > MAX_LEN * 0.9 && len <= MAX_LEN);
        // 2026-05-02: share 폐기 → 텍스트만으로 send 활성화 판정
        send.disabled = len === 0 || len > MAX_LEN;
      };
      input.addEventListener('input', () => {
        updateCounter();
        // 2026-05-02 Step 4 v2 / 2단계: @ 자동완성 — input 마다 prefix 재평가
        this._handleMentionInput(input);
      });
      updateCounter();

      send.onclick = () => this._sendMessage();
      input.addEventListener('keydown', (e) => {
        // 2026-05-02 Step 4 v2 / 4단계: mention dropdown 키보드 navigation
        if(this._mentionOpen){
          if(e.key === 'Escape'){
            e.preventDefault();
            this._hideMentionDropdown();
            return;
          }
          if(e.key === 'ArrowDown'){
            e.preventDefault();
            this._moveMentionSelection(+1);
            return;
          }
          if(e.key === 'ArrowUp'){
            e.preventDefault();
            this._moveMentionSelection(-1);
            return;
          }
          if(e.key === 'Enter' && !e.shiftKey){
            e.preventDefault();
            this._confirmMentionSelection();
            return;
          }
          if(e.key === 'Tab'){
            // Tab 도 확정 (slack/discord 패턴)
            e.preventDefault();
            this._confirmMentionSelection();
            return;
          }
        }
        if(e.key === 'Enter' && !e.shiftKey){
          e.preventDefault();
          this._sendMessage();
        }
      });
      // 2026-05-02 Step 4 v2 / 5단계: cursor 이동·focus 시 mention 재평가
      //   사용자가 textarea 외부 클릭 후 다시 들어와 cursor 가 `@xxx` 안에 있으면 dropdown 다시 표시.
      input.addEventListener('click', () => this._handleMentionInput(input));
      input.addEventListener('keyup', (e) => {
        // 화살표·홈·엔드 등 cursor 이동 키만 재평가 (텍스트 입력은 input 이벤트가 처리)
        if(['ArrowLeft','ArrowRight','Home','End'].includes(e.key)){
          this._handleMentionInput(input);
        }
      });
      input.addEventListener('focus', () => {
        // focus 복귀 시점 — cursor 위치 기반 재평가
        this._handleMentionInput(input);
      });
      // dropdown 외부 클릭 시 닫기 — mousedown 이 먼저 잡혀야 selection 보호
      input.addEventListener('blur', () => {
        setTimeout(() => this._hideMentionDropdown(), 150);
      });

      // 2026-05-02: PHASE 5 Step 4 카드 share 시스템 폐기 — + 버튼 숨김.
      //   향후 채팅에서는 텍스트 내 카드 이름 링크 → default 모달 (별도 phase) 로 대체.
      const attach = panel.querySelector('.cp-attach');
      if(attach){
        attach.style.display = 'none';
      }

      // 채널 제목 초기화
      panel.querySelector('.cp-title').textContent = this._channelTitle(this._activeKind);

      // 탭 클릭 → 채널 전환
      panel.querySelectorAll('.cp-tab').forEach(tab => {
        tab.onclick = () => this._switchKind(tab.dataset.kind);
      });
    },

    /** 탭 전환 (world/league/guild) */
    async _switchKind(kind){
      if(kind === this._activeKind) return;
      this._activeKind = kind;
      const panel = document.getElementById(PANEL_ID);
      panel.querySelectorAll('.cp-tab').forEach(t => {
        t.classList.toggle('active', t.dataset.kind === kind);
      });
      panel.querySelector('.cp-title').textContent = this._channelTitle(kind);

      const channel = this._resolveChannel(kind);
      if(!channel){
        // guild 채널인데 guild_id 없는 경우 — placeholder
        if(this._sub){ this._sub.unsubscribe(); this._sub = null; }
        panel.querySelector('.cp-messages').innerHTML =
          '<div class="cp-msg system">아직 길드에 속해 있지 않습니다.<br>광장이나 리그에서 대화하세요.</div>';
        this._setInputDisabled(true);
        this._hideBanner();
        return;
      }
      this._activeChannel = channel;
      const user = Backend && Backend.getCurrentUser && Backend.getCurrentUser();
      if(user){
        this._setInputDisabled(false);
        await this._loadAndSubscribe(channel);
        // PHASE 5 Step 5a: 채널 진입 후 레벨 체크 — 미달 시 입력 잠금 + 안내
        this._applyChannelLevelGate();
      } else {
        this._showBanner('로그인 후 이용 가능', 'info');
      }
    },

    /** PHASE 5 Step 5a: 현재 채널의 최소 레벨 미달 시 input 잠그고 안내 banner. */
    _applyChannelLevelGate(){
      const minLv = this._minLevelFor(this._activeKind);
      const myLv = this._getMyLevel();
      if(myLv < minLv){
        this._setInputDisabled(true);
        this._showBanner(`Lv${minLv} 부터 발언 가능 (현재 Lv${myLv}) — 메시지는 읽을 수 있습니다`, 'info');
      }
    },

    // ── 내부: 채널 로드 + 구독 ─────────────────────────
    async _loadAndSubscribe(channel){
      // 기존 구독 해제
      if(this._sub) { this._sub.unsubscribe(); this._sub = null; }

      const panel = document.getElementById(PANEL_ID);
      const msgs = panel.querySelector('.cp-messages');
      msgs.innerHTML = '';
      this._showBanner('불러오는 중...', 'info');

      // 최근 N개 로드
      const {messages, error} = await Backend.chatLoadHistory(channel, HISTORY_LIMIT);
      if(error){
        // DB 테이블 없거나 네트워크 문제 — 입력도 잠가 오해 방지 (ui-inspector 지적)
        this._showBanner(`채팅 불가: ${error}`, 'error');
        this._setInputDisabled(true);
        return;
      }
      this._hideBanner();
      // PHASE 5 Step 5a: 로드 후 즉시 level gate 재평가 (history 실패 후 성공 케이스 대응)
      this._applyChannelLevelGate();
      messages.forEach(m => this._renderMessage(m, {skipUnread:true}));
      if(messages.length){
        this._lastMsgTime = messages[messages.length-1].created_at;
      }
      msgs.scrollTop = msgs.scrollHeight;

      // Realtime 구독
      this._sub = Backend.chatSubscribe(channel, (msg) => {
        this._renderMessage(msg);
        this._lastMsgTime = msg.created_at;
      });
    },

    // ── 내부: 메시지 렌더 (id 기반 중복 제거) ─────────
    _renderMessage(msg, opts){
      opts = opts || {};
      const panel = document.getElementById(PANEL_ID);
      const msgs = panel.querySelector('.cp-messages');

      // Dedup: 같은 id 가 이미 DOM 에 있으면 스킵 (optimistic append + realtime 중복 방지)
      if(msg.id && msgs.querySelector(`[data-message-id="${msg.id}"]`)) return;

      const curUser = (window.Backend && Backend.getCurrentUser) ? Backend.getCurrentUser() : null;
      const isSelf = curUser && msg.user_id === curUser.id;

      const el = document.createElement('div');
      el.className = 'cp-msg' + (isSelf ? ' self' : '');
      el.dataset.messageId = msg.id;

      const head = document.createElement('div');
      head.className = 'cp-msg-head';
      const u = document.createElement('span');
      u.className = 'cp-msg-user';
      u.textContent = msg.user_name || '?';
      const lv = document.createElement('span');
      lv.className = 'cp-msg-lv';
      lv.textContent = `Lv${msg.user_level || 1}`;
      const t = document.createElement('span');
      t.className = 'cp-msg-time';
      t.textContent = this._formatTime(msg.created_at);
      head.appendChild(u); head.appendChild(lv); head.appendChild(t);

      const text = document.createElement('div');
      text.className = 'cp-msg-text';
      // 2026-05-02: PHASE 5 Step 4 v2 — 카드 이름 자동 링크화.
      //   메시지 텍스트 안 카드 이름 (UNITS / 영웅 prototype) 매칭 → 파란 링크 element.
      //   클릭 시 _showCardDetailModal 호출 (default 카드 모달).
      this._renderTextWithCardLinks(text, msg.text || '');

      el.appendChild(head);
      // 텍스트 비어있으면 (첨부 단독 전송) 텍스트 div 생략
      if(msg.text) el.appendChild(text);

      // 2026-05-02: PHASE 5 Step 4 share 폐기 — 과거 메시지의 attached_card 는 텍스트 라벨로 표시.
      //   기존 데이터 호환 유지 (DB 에 남아있을 수 있음). 신규 메시지에는 attached_card 안 붙음.
      if(msg.attached_card && typeof msg.attached_card === 'object'){
        const ac = msg.attached_card;
        const fallback = document.createElement('span');
        fallback.className = 'cp-msg-card-fallback';
        fallback.style.cssText = 'display:inline-block;padding:2px 8px;background:rgba(232,189,74,.12);color:#e8bd4a;border-radius:3px;font-size:11px;margin-left:6px;cursor:default';
        fallback.textContent = '🃏 ' + (ac.name || '카드');
        fallback.title = '과거 share 카드 (시스템 폐기됨)';
        el.appendChild(fallback);
      }

      // 스크롤이 맨 아래 근처일 때만 auto-scroll (과거 메시지 보는 중엔 유지)
      const nearBottom = msgs.scrollHeight - msgs.scrollTop - msgs.clientHeight < 60;
      msgs.appendChild(el);
      if(nearBottom) msgs.scrollTop = msgs.scrollHeight;

      // 패널 닫힘 + 본인 X → unread 카운터 증가
      if(!opts.skipUnread && !panel.classList.contains('active') && !isSelf){
        this._unreadCount++;
        this._updateBadge();
      }
    },

    // ── 내부: 메시지 전송 ─────────────────────────────
    async _sendMessage(){
      const panel = document.getElementById(PANEL_ID);
      const input = panel.querySelector('.cp-input');
      const text = input.value.trim();
      // 2026-04-27 Step 4b: 텍스트 OR 첨부 카드 둘 중 하나라도 있으면 전송 가능 (자랑용 단독 전송)
      // 2026-05-02: share 폐기 → 텍스트 없으면 전송 안 함 (이전엔 첨부카드 단독 전송 가능했음)
      if(!text) return;
      if(text.length > MAX_LEN){
        this._showBanner(`메시지 길이 초과 (${text.length}/${MAX_LEN})`, 'error');
        return;
      }
      // PHASE 5 Step 5a: 채널 최소 레벨 검증 (UX 1차, RLS 가 서버측 백업)
      const minLv = this._minLevelFor(this._activeKind);
      const myLv = this._getMyLevel();
      if(myLv < minLv){
        this._showBanner(`Lv${minLv} 부터 ${this._channelTitle(this._activeKind)} 채널에서 발언할 수 있습니다 (현재 Lv${myLv})`, 'error');
        return;
      }
      // PHASE 5 Step 5c/5d: 금칙어 마스킹 + URL 차단 (text 가 비어있으면 첨부카드 단독 전송이라 skip)
      let cleanText = text;
      if(text && window.RoF && RoF.ChatFilters){
        const result = RoF.ChatFilters.censor(text);
        if(result.blocked && result.reason === 'url'){
          this._showBanner('URL 은 채팅에 보낼 수 없습니다', 'error');
          return;
        }
        if(result.reason === 'profanity'){
          this._showBanner('일부 단어가 마스킹되었습니다', 'info');
        }
        cleanText = result.cleaned;
      }
      // 클라측 쿨다운 (DB RLS 에도 뮤트 체크 있지만 UX 보조)
      const now = Date.now();
      if(now - this._lastSent < COOLDOWN_MS){
        const remaining = Math.ceil((COOLDOWN_MS - (now - this._lastSent))/1000);
        this._showBanner(`${remaining}초 후 다시 전송 가능`, 'info');
        return;
      }

      input.disabled = true;
      // 2026-05-02: share 폐기 — attached_card 항상 null (backend API 호환 유지).
      // 2026-04-28 Step 5c: 금칙어 마스킹된 cleanText 전송 (원문 text 아님)
      const {error, message} = await Backend.chatSend(this._activeChannel, cleanText, null);
      input.disabled = false;
      if(error){
        if(error.includes('mute') || error.includes('not-muted')) {
          this._showBanner('뮤트 상태입니다', 'error');
        } else {
          this._showBanner(`전송 실패: ${error}`, 'error');
        }
        return;
      }
      // Optimistic append — realtime 지연·실패에 관계없이 본인 메시지 즉시 렌더.
      // _renderMessage 내부 dedup 으로 realtime 중복 수신 시 안전.
      if(message) this._renderMessage(message);
      this._lastSent = now;
      // PHASE 5 Step 5b: 도배 sliding window 갱신 + 임계 도달 시 사전 경고
      this._sentTimestamps.push(now);
      this._sentTimestamps = this._sentTimestamps.filter(t => now - t < FLOOD_WINDOW_MS);
      if(this._sentTimestamps.length === FLOOD_WARN_AT){
        const remaining = FLOOD_HARD_LIMIT - FLOOD_WARN_AT;
        this._showBanner(`⚠️ 도배 감지 — ${remaining}개 더 보내면 30분 자동 뮤트`, 'info');
      } else if(this._sentTimestamps.length >= FLOOD_HARD_LIMIT){
        this._showBanner('🔇 30분 자동 뮤트 — 잠시 후 자동 해제', 'error');
      }
      input.value = '';
      input.dispatchEvent(new Event('input'));  // counter 갱신
      input.focus();
    },

    // 2026-05-02: PHASE 5 Step 4 카드 share 시스템 폐기.
    //   _showCardPicker / _setAttachedCard / _clearAttachedCard / _refreshSendButton / _renderAttachedPreview 5 함수 제거.
    //   향후 채팅 카드 링크는 텍스트 내 카드 이름 인식 → _showCardDetailModal 재사용 (별도 phase).

    // ── 2026-05-02 Step 4 v2 / 2단계: @ 자동완성 (입력 측) ──────────
    //   1단계 텍스트 자동 링크는 _renderTextWithCardLinks 가 처리.
    //   여기서는 입력 시 `@` 다음 prefix 를 매칭해 dropdown 표시.
    //   본 단계에서는 마우스 클릭 선택만 — 키보드 navigation 은 4단계.
    _mentionOpen: false,
    _mentionAnchor: -1,   // textarea 내 `@` 위치 (start)
    _mentionPrefix: '',   // `@` 뒤 사용자가 입력한 부분
    _mentionSelectedIndex: -1,   // 4단계: 키보드 nav 선택 인덱스 (-1 = 미선택)
    _mentionItems: [],           // 현재 dropdown 에 렌더된 unit 배열 (Enter 확정용)
    _mentionLastPrefix: null,    // 마지막 렌더 시 prefix — 같은 prefix 재호출 시 selectedIndex 보존

    /** input 변경 시 호출 — cursor 직전 텍스트에서 @ 패턴 추출, dropdown 갱신/숨김. */
    _handleMentionInput(input){
      const value = input.value;
      const cursor = input.selectionStart || 0;
      // cursor 앞으로 거슬러 올라가며 @ 찾기, 공백/줄바꿈/특수문자 만나면 중단.
      let at = -1;
      for(let i = cursor - 1; i >= 0; i--){
        const ch = value[i];
        if(ch === '@'){ at = i; break; }
        if(/[\s\n\r\t]/.test(ch)) break;
        // 너무 길면 중단 (10글자 이상이면 mention 아닐 가능성 높음)
        if(cursor - i > 12) break;
      }
      if(at < 0){
        this._hideMentionDropdown();
        return;
      }
      // @ 바로 앞이 글자면 이메일·URL 패턴이라 무시 (예: foo@bar)
      if(at > 0 && /[\w가-힣]/.test(value[at - 1])){
        this._hideMentionDropdown();
        return;
      }
      const prefix = value.substring(at + 1, cursor);
      this._mentionAnchor = at;
      this._mentionPrefix = prefix;
      this._showMentionDropdown(prefix);
    },

    /** dropdown 표시 — prefix 로 필터한 카드 list 렌더. */
    _showMentionDropdown(prefix){
      const panel = document.getElementById(PANEL_ID);
      if(!panel) return;
      const inputRow = panel.querySelector('.cp-input-row');
      if(!inputRow) return;

      let dd = panel.querySelector('.cp-mention-dropdown');
      if(!dd){
        dd = document.createElement('div');
        dd.className = 'cp-mention-dropdown';
        // input-row 의 형제로 삽입 (input-row 위에 띄움 — 절대좌표 + bottom)
        inputRow.parentNode.insertBefore(dd, inputRow);
      }
      const matches = this._filterMentions(prefix);
      dd.innerHTML = '';
      if(matches.length === 0){
        // 매칭 없으면 dropdown 닫음 (시각 노이즈 방지)
        this._hideMentionDropdown();
        return;
      }
      // 4단계: items 캐싱 + 선택 인덱스 초기화 (prefix 변경/항목 축소 시에만 0 reset)
      const prefixChanged = this._mentionLastPrefix !== prefix;
      this._mentionLastPrefix = prefix;
      this._mentionItems = matches;
      if(prefixChanged || this._mentionSelectedIndex < 0 || this._mentionSelectedIndex >= matches.length){
        this._mentionSelectedIndex = 0;
      }
      const selIdx = this._mentionSelectedIndex;
      matches.forEach((u, idx) => {
        const item = document.createElement('div');
        item.className = 'cp-mention-item' + (idx === selIdx ? ' selected' : '');
        item.dataset.unitId = u.id;
        item.dataset.idx = String(idx);

        const elem = document.createElement('span');
        elem.className = 'cp-mention-elem';
        elem.style.color = `var(--el-${u.element || 'water'})`;
        elem.textContent = ELEM_BADGE[u.element] || '◆';

        const name = document.createElement('span');
        name.className = 'cp-mention-name';
        name.textContent = u.name;

        const rar = document.createElement('span');
        rar.className = 'cp-mention-rar';
        rar.textContent = RARITY_LABEL[u.rarity] || u.rarity || '';
        rar.style.color = `var(--rar-${u.rarity || 'bronze'})`;

        item.appendChild(elem);
        item.appendChild(name);
        item.appendChild(rar);
        // mousedown — blur 이벤트보다 먼저 잡혀 dropdown 닫힘 회피
        item.addEventListener('mousedown', e => {
          e.preventDefault();
          this._selectMention(u);
        });
        // 4단계: hover 시 selected index 동기화 (마우스/키보드 일관)
        item.addEventListener('mouseenter', () => {
          this._mentionSelectedIndex = idx;
          this._renderMentionSelection();
        });
        dd.appendChild(item);
      });
      dd.hidden = false;
      this._mentionOpen = true;
    },

    /** 4단계: 선택 인덱스 ±1 이동, dropdown 시각 갱신 + 스크롤 가시화. */
    _moveMentionSelection(delta){
      if(!this._mentionItems.length) return;
      const len = this._mentionItems.length;
      let i = this._mentionSelectedIndex + delta;
      // wrap-around (slack 방식 — 위쪽 끝에서 ↑ 누르면 마지막으로)
      if(i < 0) i = len - 1;
      if(i >= len) i = 0;
      this._mentionSelectedIndex = i;
      this._renderMentionSelection();
    },

    /** 4단계: selected 클래스 갱신 + 보이지 않으면 스크롤. */
    _renderMentionSelection(){
      const panel = document.getElementById(PANEL_ID);
      if(!panel) return;
      const dd = panel.querySelector('.cp-mention-dropdown');
      if(!dd) return;
      const items = dd.querySelectorAll('.cp-mention-item');
      items.forEach((el, idx) => {
        el.classList.toggle('selected', idx === this._mentionSelectedIndex);
      });
      // 선택 항목이 가시 영역 밖이면 scrollIntoView
      const sel = items[this._mentionSelectedIndex];
      if(sel){
        const ddRect = dd.getBoundingClientRect();
        const itemRect = sel.getBoundingClientRect();
        if(itemRect.top < ddRect.top){
          dd.scrollTop -= (ddRect.top - itemRect.top);
        } else if(itemRect.bottom > ddRect.bottom){
          dd.scrollTop += (itemRect.bottom - ddRect.bottom);
        }
      }
    },

    /** 4단계: Enter/Tab 으로 현재 선택 항목 확정. 미선택(-1) 이거나 항목 0개면 first 항목. */
    _confirmMentionSelection(){
      if(!this._mentionItems.length) return;
      let i = this._mentionSelectedIndex;
      if(i < 0 || i >= this._mentionItems.length) i = 0;
      this._selectMention(this._mentionItems[i]);
    },

    /** prefix 기반 매칭 — 한글 startsWith 우선 → includes. 최대 8개. */
    _filterMentions(prefix){
      const units = (window.RoF && RoF.Data && RoF.Data.UNITS) ? RoF.Data.UNITS : [];
      const pool = units.filter(u => !u.id.startsWith('h_') && u.name && u.name.length >= 2);
      const p = (prefix || '').trim();
      if(!p){
        // 빈 prefix — 인기 카드 8개 반환 (rarity 높은 순)
        const RARITY_ORDER = { divine:5, legendary:4, gold:3, silver:2, bronze:1 };
        return pool
          .slice()
          .sort((a,b) => (RARITY_ORDER[b.rarity]||0) - (RARITY_ORDER[a.rarity]||0))
          .slice(0, 8);
      }
      const lower = p.toLowerCase();
      const startsWith = [];
      const includes = [];
      pool.forEach(u => {
        const n = u.name.toLowerCase();
        if(n.startsWith(lower)) startsWith.push(u);
        else if(n.includes(lower)) includes.push(u);
      });
      // startsWith 우선, 그 다음 includes — 합쳐서 8개 cap
      return [...startsWith, ...includes].slice(0, 8);
    },

    /** dropdown 닫기 — open/anchor/prefix/items 만 reset.
     *  selectedIndex 와 lastPrefix 는 보존 (blur 후 refocus 시 같은 prefix 면 idx 유지). */
    _hideMentionDropdown(){
      const panel = document.getElementById(PANEL_ID);
      if(!panel) return;
      const dd = panel.querySelector('.cp-mention-dropdown');
      if(dd){
        dd.hidden = true;
        dd.innerHTML = '';
      }
      this._mentionOpen = false;
      this._mentionAnchor = -1;
      this._mentionPrefix = '';
      this._mentionItems = [];
      // selectedIndex 와 lastPrefix 는 의도적으로 보존
    },

    /** 명시적 reset — 선택 완료/패널 닫기 등 "한 번의 mention 흐름 종료" 시 호출. */
    _resetMentionState(){
      this._hideMentionDropdown();
      this._mentionSelectedIndex = -1;
      this._mentionLastPrefix = null;
    },

    /** mention 선택 — textarea 의 @prefix 부분을 카드 이름으로 치환.
     *  자동 링크는 _renderTextWithCardLinks 가 메시지 표시 시 처리하므로
     *  textarea 에 들어가는 건 plain 카드 이름. */
    _selectMention(unit){
      const panel = document.getElementById(PANEL_ID);
      if(!panel) return;
      const input = panel.querySelector('.cp-input');
      if(!input || this._mentionAnchor < 0) return;
      const value = input.value;
      const cursor = input.selectionStart || 0;
      const before = value.substring(0, this._mentionAnchor);
      const after = value.substring(cursor);
      // @prefix → 카드이름 + 공백 (다음 입력이 자연스럽게 이어지도록)
      const newValue = before + unit.name + ' ' + after;
      input.value = newValue;
      const newCursor = (before + unit.name + ' ').length;
      input.setSelectionRange(newCursor, newCursor);
      input.dispatchEvent(new Event('input'));  // counter 갱신 + 다음 mention 재평가
      input.focus();
      this._resetMentionState();   // 한 mention 흐름 종료 — selectedIndex/lastPrefix 도 reset
    },

    /** 2026-05-02 Step 4 v2: 텍스트 안 카드 이름 자동 링크화.
     *  UNITS 의 name 매칭 — 일반 유닛만 (영웅 이름은 사용자 닉네임이라 제외).
     *  매칭된 부분 → <a class="cp-card-link"> + 클릭 시 default 카드 모달.
     *  textContent 기반 이라 XSS 방지 (innerHTML 사용 X). */
    _renderTextWithCardLinks(container, raw){
      if(!raw){ return; }
      const units = (window.RoF && RoF.Data && RoF.Data.UNITS) ? RoF.Data.UNITS : [];
      // 영웅 prototype (h_*) 제외, 이름 길이 긴 순 정렬 (긴 이름 우선 매칭으로 부분 일치 회피)
      const candidates = units
        .filter(u => !u.id.startsWith('h_') && u.name && u.name.length >= 2)
        .slice()
        .sort((a,b) => b.name.length - a.name.length);
      // 정규식 escape 헬퍼
      const escRe = s => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
      // 단순 알고리즘 — 한 번에 한 카드 이름씩 split. 긴 이름 우선.
      // 2026-05-02: lookbehind/lookahead 한국어 단어 경계 처리 시도 후 회귀 (play-director #C5 결과).
      //   조사(가/이/을/는/의/를/와) 가 가-힣 범위라 "그리핀이/지니가/도적의" 90% 케이스 매칭 실패 부작용.
      //   합성어("기사단" 안의 "기사") 회피 효과보다 조사 차단 손실이 큼.
      //   대안: 긴 이름 우선 정렬(이미 적용) 으로 합성어 일부 완화. 향후 형태소 분석 기반 분리 검토.
      let segments = [{type:'text', value: raw}];
      candidates.forEach(u => {
        const re = new RegExp(escRe(u.name), 'g');
        const next = [];
        segments.forEach(seg => {
          if(seg.type !== 'text'){ next.push(seg); return; }
          const parts = seg.value.split(re);
          for(let i=0; i<parts.length; i++){
            if(parts[i]) next.push({type:'text', value:parts[i]});
            if(i < parts.length - 1) next.push({type:'card', unit:u});
          }
        });
        segments = next;
      });
      // DOM 구성
      segments.forEach(seg => {
        if(seg.type === 'text'){
          if(seg.value) container.appendChild(document.createTextNode(seg.value));
        } else {
          const a = document.createElement('a');
          a.className = 'cp-card-link';
          a.textContent = seg.unit.name;
          a.title = `${seg.unit.name} — 클릭하여 상세보기`;
          a.onclick = e => { e.preventDefault(); this._showCardDetailModal(seg.unit); };
          container.appendChild(a);
        }
      });
    },

    /** Step 4d: 카드 디테일 모달 — share 폐기 후에도 유지 (향후 링크 시스템에서 재사용). */
    _showCardDetailModal(card){
      // 중복 방지
      if(document.getElementById('cp-card-detail')) return;
      const overlay = document.createElement('div');
      overlay.id = 'cp-card-detail';
      overlay.className = 'cp-card-detail';
      const close = document.createElement('button');
      close.type = 'button';
      close.className = 'cp-cd-close';
      close.title = '닫기';
      close.textContent = '✕';
      close.onclick = () => overlay.remove();
      overlay.appendChild(close);
      if(RoF.CardV4Component && RoF.CardV4Component.create){
        const inst = RoF.CardV4Component.create(card, {});
        overlay.appendChild(inst.el);
      }
      overlay.addEventListener('click', (e) => {
        if(e.target === overlay) overlay.remove();
      });
      document.body.appendChild(overlay);
    },

    // ── 내부: 뮤트 상태 ────────────────────────────────
    async _refreshMuteStatus(){
      if(!window.Backend || !Backend.isReady) return;
      const {muted, secondsRemaining, reason} = await Backend.chatGetMuteStatus();
      const panel = document.getElementById(PANEL_ID);
      const input = panel.querySelector('.cp-input');
      const send = panel.querySelector('.cp-send');
      if(muted){
        const mins = Math.ceil(secondsRemaining / 60);
        const reasonText = reason === 'reports' ? '신고 누적' : (reason === 'flood' ? '도배' : '관리자');
        this._showBanner(`🔇 뮤트 상태 (${reasonText}) — 해제까지 약 ${mins}분`, 'error');
        input.disabled = true;
        send.disabled = true;
      } else {
        // 뮤트 아닌데 banner 가 뮤트 때문이었다면 숨김 — 간단히 info 배너는 유지
        const banner = panel.querySelector('.cp-banner');
        if(banner && !banner.hidden && banner.textContent.includes('뮤트')){
          this._hideBanner();
        }
        if(input.disabled && input.dataset.offline !== '1'){
          input.disabled = false;
        }
      }
    },

    // ── 내부: UI 헬퍼 ─────────────────────────────────
    _showBanner(text, kind){
      const panel = document.getElementById(PANEL_ID);
      if(!panel) return;
      const b = panel.querySelector('.cp-banner');
      b.textContent = text;
      b.className = 'cp-banner' + (kind === 'error' ? ' error' : '');
      b.hidden = false;
    },
    _hideBanner(){
      const panel = document.getElementById(PANEL_ID);
      if(!panel) return;
      const b = panel.querySelector('.cp-banner');
      b.hidden = true;
    },
    _setInputDisabled(disabled){
      const panel = document.getElementById(PANEL_ID);
      if(!panel) return;
      const input = panel.querySelector('.cp-input');
      const send = panel.querySelector('.cp-send');
      input.disabled = disabled;
      send.disabled = disabled;
      if(disabled) input.dataset.offline = '1';
      else delete input.dataset.offline;
    },
    _updateBadge(){
      const toggle = document.getElementById(TOGGLE_ID);
      if(!toggle) return;
      const badge = toggle.querySelector('.cp-badge');
      if(this._unreadCount > 0){
        badge.textContent = this._unreadCount > 99 ? '99+' : String(this._unreadCount);
        badge.hidden = false;
      } else {
        badge.hidden = true;
      }
    },
    _formatTime(iso){
      try {
        const d = new Date(iso);
        const hh = String(d.getHours()).padStart(2,'0');
        const mm = String(d.getMinutes()).padStart(2,'0');
        return `${hh}:${mm}`;
      } catch(e){ return ''; }
    },
  };

  if(typeof RoF === 'undefined') window.RoF = {};
  RoF.Chat = Chat;

  // Backend init 은 비동기. DOMContentLoaded 후 약간 대기 후 init.
  document.addEventListener('DOMContentLoaded', () => {
    setTimeout(() => Chat.init(), 800);
  });

})();
