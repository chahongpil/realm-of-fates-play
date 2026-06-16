'use strict';

// ============================================================
// Realm of Fates — Backend (S1: Auth + Cloud Save)
// Supabase 래퍼. RoF.Backend 네임스페이스.
// Backend 가 없어도 게임은 localStorage 폴백으로 작동한다.
// ============================================================

(function(){

  // ── 설정 ──────────────────────────────────────────────
  // index.html 에서 <meta> 또는 전역 변수로 주입, 없으면 오프라인
  const SUPABASE_URL  = window.__ROF_SUPABASE_URL  || '';
  const SUPABASE_KEY  = window.__ROF_SUPABASE_KEY  || '';

  let _sb = null;   // supabase client
  let _user = null;  // auth.users row

  // 외부 모듈이 구독하는 auth 이벤트 리스너 목록
  const _authListeners = [];

  const B = {
    isReady: false,
    isOffline: true,

    /**
     * Auth 상태 변화 구독 — 로그인/로그아웃 이벤트를 받고 싶은 모듈이 호출.
     * @param {(event: string, user: object|null) => void} cb
     *   event: 'SIGNED_IN' | 'SIGNED_OUT' | 'TOKEN_REFRESHED' | 'USER_UPDATED' 등
     * @returns {() => void} 구독 해제 함수
     */
    onAuthChange(cb){
      if(typeof cb !== 'function') return () => {};
      _authListeners.push(cb);
      // 이미 로그인 상태면 즉시 통지 (구독 타이밍이 로그인 이후여도 초기 상태 반영)
      if(_user) {
        try { cb('SIGNED_IN', _user); } catch(e){ console.error('[Backend] auth listener error', e); }
      }
      return () => {
        const i = _authListeners.indexOf(cb);
        if(i >= 0) _authListeners.splice(i, 1);
      };
    },

    // ── 초기화 ──────────────────────────────────────────
    async init(){
      if(!SUPABASE_URL || !SUPABASE_KEY){
        console.warn('[Backend] Supabase 설정 없음 → 오프라인 모드');
        return;
      }
      if(typeof supabase === 'undefined' || !supabase.createClient){
        console.warn('[Backend] supabase-js SDK 미로드 → 오프라인 모드');
        return;
      }
      try {
        _sb = supabase.createClient(SUPABASE_URL, SUPABASE_KEY);
        // 기존 세션 복원
        const {data:{session}} = await _sb.auth.getSession();
        if(session) _user = session.user;
        B.isReady = true;
        B.isOffline = false;
        console.log('[Backend] 연결 완료', _user ? `(유저: ${_user.id.slice(0,8)})` : '(비로그인)');

        // Auth 상태 변화 감시 — 내부 _user 동기화 + 외부 리스너 통지
        _sb.auth.onAuthStateChange((event, session)=>{
          _user = session?.user || null;
          _authListeners.forEach(cb => {
            try { cb(event, _user); } catch(e){ console.error('[Backend] auth listener error', e); }
          });
        });
      } catch(e){
        console.error('[Backend] 초기화 실패 →', e.message);
      }
    },

    // ── 인증 ────────────────────────────────────────────

    /** 회원가입 */
    async signup(email, password, nickname){
      if(!B.isReady) return {user:null, error:'offline'};
      const {data, error} = await _sb.auth.signUp({
        email, password,
        options: { data: { nickname } }
      });
      if(error) return {user:null, error: error.message};
      _user = data.user;
      return {user: data.user, error: null};
    },

    /** 로그인 */
    async login(email, password){
      if(!B.isReady) return {user:null, error:'offline'};
      const {data, error} = await _sb.auth.signInWithPassword({email, password});
      if(error) return {user:null, error: error.message};
      _user = data.user;
      return {user: data.user, error: null};
    },

    /** Google OAuth (S1 후반) */
    async loginWithGoogle(){
      if(!B.isReady) return {user:null, error:'offline'};
      const {data, error} = await _sb.auth.signInWithOAuth({provider:'google'});
      if(error) return {user:null, error: error.message};
      return {user: data.user||null, error: null};
    },

    /** 로그아웃 */
    async logout(){
      if(!B.isReady) return {error:'offline'};
      const {error} = await _sb.auth.signOut();
      _user = null;
      return {error: error ? error.message : null};
    },

    /** 현재 유저 */
    getCurrentUser(){
      return _user || null;
    },

    // ── 프로필 ──────────────────────────────────────────

    /** 프로필 조회 */
    async getProfile(){
      if(!B.isReady || !_user) return {profile:null, error:'offline'};
      const {data, error} = await _sb.from('profiles')
        .select('*').eq('id', _user.id).single();
      if(error) return {profile:null, error: error.message};
      return {profile: data, error: null};
    },

    /** 프로필 부분 갱신 */
    async updateProfile(patch){
      if(!B.isReady || !_user) return {error:'offline'};
      const {error} = await _sb.from('profiles')
        .update(patch).eq('id', _user.id);
      return {error: error ? error.message : null};
    },

    // ── 세이브 데이터 ───────────────────────────────────

    /** 진행도 저장 (Game.persist 호출 시) */
    async saveProgress(save){
      if(!B.isReady || !_user) return {error:'offline'};
      const patch = {
        save_data: save,
        total_wins:    save.totalWins    || 0,
        total_games:   save.totalGames   || 0,
        league_points: save.leaguePoints || 0,
        best_round:    save.bestRound    || 0,
      };
      const {error} = await _sb.from('profiles')
        .update(patch).eq('id', _user.id);
      return {error: error ? error.message : null};
    },

    /** 진행도 로드 */
    async loadProgress(){
      if(!B.isReady || !_user) return {save:null, error:'offline'};
      const {data, error} = await _sb.from('profiles')
        .select('save_data').eq('id', _user.id).single();
      if(error) return {save:null, error: error.message};
      return {save: data.save_data, error: null};
    },

    // ── localStorage → Supabase 마이그레이션 ────────────

    /**
     * 첫 Supabase 로그인 시 1회 실행.
     * 기존 localStorage 데이터가 있으면 Supabase 로 이관.
     * @param {string} localNickname - localStorage 의 rof8 키에서 쓰던 닉네임
     */
    async migrateFromLocal(localNickname){
      if(!B.isReady || !_user) return {error:'offline'};
      try {
        const raw = localStorage.getItem('rof8');
        if(!raw) return {error:null}; // 이관할 데이터 없음
        const db = JSON.parse(raw);
        const entry = db[localNickname];
        if(!entry || !entry.save) return {error:null};

        // Supabase 에 이미 save_data 가 있으면 덮어쓰지 않음
        const {profile} = await B.getProfile();
        if(profile && profile.save_data && Object.keys(profile.save_data).length > 0){
          console.log('[Backend] 이미 클라우드 세이브 존재 → 마이그레이션 스킵');
          return {error:null};
        }

        // 이관
        const res = await B.saveProgress(entry.save);
        if(!res.error){
          console.log('[Backend] localStorage → Supabase 마이그레이션 완료');
          // 이관 성공 후 로컬 평문 비밀번호 삭제 (보안)
          delete entry.pw;
          db[localNickname] = entry;
          localStorage.setItem('rof8', JSON.stringify(db));
        }
        return res;
      } catch(e){
        return {error: e.message};
      }
    },
  };

  // ── UI: 클라우드 연결 모달 ──────────────────────────────

  function _$(id){ return document.getElementById(id); }

  /** 클라우드 버튼 상태 갱신 */
  function _updateCloudBtn(){
    const btn = _$('btn-cloud-link');
    if(!btn) return;
    if(!B.isReady){ btn.textContent = '☁️ 오프라인'; btn.disabled = true; return; }
    if(_user){ btn.textContent = '☁️ 연결됨'; btn.style.borderColor = 'var(--success)'; }
    else { btn.textContent = '☁️ 클라우드'; btn.style.borderColor = ''; }
    btn.disabled = false;
  }

  B.showLinkModal = function(){
    const modal = _$('cloud-modal');
    if(!modal) return;
    modal.classList.add('active');
    const form = _$('cloud-form');
    const status = _$('cloud-status');
    const msg = _$('cloud-msg');
    if(msg) msg.textContent = '';

    if(!B.isReady){
      if(status) status.innerHTML = '<span style="color:var(--danger);">서버 연결 안 됨. 오프라인 모드입니다.</span>';
      if(form) form.style.display = 'none';
      return;
    }
    if(_user){
      if(status) status.innerHTML = '<span style="color:var(--success);">✅ 클라우드 연결됨</span><br><span style="color:var(--text-2);font-size:.8rem;">이메일: ' + (_user.email||'') + '</span>';
      if(form) form.style.display = 'none';
    } else {
      if(status) status.innerHTML = '<span style="color:var(--text-2);">이메일을 등록하면 다른 기기에서도<br>진행 상황을 이어갈 수 있습니다.</span>';
      if(form) form.style.display = '';
    }
  };

  B.closeModal = function(){
    const modal = _$('cloud-modal');
    if(modal) modal.classList.remove('active');
  };

  /** 새 이메일 등록 → Supabase Auth 가입 → 로컬 데이터 마이그레이션 */
  B.register = async function(){
    const email = (_$('cloud-email')||{}).value||'';
    const pw = (_$('cloud-pw')||{}).value||'';
    const msg = _$('cloud-msg');
    if(!email || !email.includes('@')){ if(msg){msg.className='auth-msg error';msg.textContent='유효한 이메일을 입력하세요';} return; }
    if(pw.length < 6){ if(msg){msg.className='auth-msg error';msg.textContent='비밀번호는 6자 이상입니다';} return; }

    if(msg){msg.className='auth-msg';msg.textContent='등록 중...';}
    const nickname = (typeof Auth!=='undefined' && Auth.user) ? Auth.user : 'hero';
    const res = await B.signup(email, pw, nickname);
    if(res.error){
      if(msg){msg.className='auth-msg error';msg.textContent=res.error;}
      return;
    }
    // 마이그레이션
    if(Auth && Auth.user) await B.migrateFromLocal(Auth.user);
    _updateCloudBtn();
    if(msg){msg.className='auth-msg success';msg.textContent='클라우드 연결 완료!';}
    setTimeout(()=>B.showLinkModal(), 1000); // 상태 갱신 후 모달 리프레시
  };

  /** 기존 Supabase 계정 로그인 → 클라우드 세이브 로드 */
  B.linkLogin = async function(){
    const email = (_$('cloud-email')||{}).value||'';
    const pw = (_$('cloud-pw')||{}).value||'';
    const msg = _$('cloud-msg');
    if(!email || !pw){ if(msg){msg.className='auth-msg error';msg.textContent='이메일과 비밀번호를 입력하세요';} return; }

    if(msg){msg.className='auth-msg';msg.textContent='연결 중...';}
    const res = await B.login(email, pw);
    if(res.error){
      if(msg){msg.className='auth-msg error';msg.textContent=res.error;}
      return;
    }
    _updateCloudBtn();
    if(msg){msg.className='auth-msg success';msg.textContent='클라우드 연결 완료!';}
    // 클라우드에 세이브가 있으면 로드할지 물어볼 수 있음 (S1에서는 로컬 우선)
    if(Auth && Auth.user) await B.migrateFromLocal(Auth.user);
    setTimeout(()=>B.showLinkModal(), 1000);
  };

  // init 완료 후 버튼 상태 갱신
  const _origInit = B.init;
  B.init = async function(){
    await _origInit.call(B);
    _updateCloudBtn();
  };

  // ── S2: 고스트 PvP (비동기 대전) ──────────────────────

  /** 덱 스냅샷 업로드 (전투 승리 시 자동 호출) */
  B.uploadDeckSnapshot = async function(deckData, skillsData, relicsData, heroData){
    if(!B.isReady || !_user) return {error:'offline'};
    const {profile} = await B.getProfile();
    if(!profile) return {error:'프로필 없음'};

    const row = {
      user_id:       _user.id,
      nickname:      profile.nickname || 'hero',
      league_points: profile.league_points || 0,
      total_wins:    profile.total_wins || 0,
      deck_data:     deckData   || [],
      skills_data:   skillsData || [],
      relics_data:   relicsData || [],
      hero_data:     heroData   || {},
    };

    const {error} = await _sb.from('deck_snapshots')
      .upsert(row, {onConflict:'user_id'});
    if(error) return {error: error.message};
    console.log('[Ghost PvP] 덱 스냅샷 업로드 완료');
    return {error: null};
  };

  /**
   * 랜덤 상대 매칭 — 비슷한 리그 포인트 범위에서 자기 자신 제외.
   * @param {number} [range=100] LP 허용 범위 (±)
   * @returns {{opponent: object|null, error: string|null}}
   */
  B.findGhostOpponent = async function(range){
    if(!B.isReady || !_user) return {opponent:null, error:'offline'};
    const {profile} = await B.getProfile();
    if(!profile) return {opponent:null, error:'프로필 없음'};
    const myLP = profile.league_points || 0;
    const r = range || 100;

    // 1차: ±range 범위에서 랜덤 1명
    let {data, error} = await _sb.from('deck_snapshots')
      .select('*')
      .neq('user_id', _user.id)
      .gte('league_points', myLP - r)
      .lte('league_points', myLP + r)
      .limit(10);

    if(error) return {opponent:null, error: error.message};

    // 범위 내 없으면 범위 2배로 확장 재시도
    if(!data || data.length === 0){
      const res2 = await _sb.from('deck_snapshots')
        .select('*')
        .neq('user_id', _user.id)
        .gte('league_points', myLP - r * 2)
        .lte('league_points', myLP + r * 2)
        .limit(10);
      if(res2.error) return {opponent:null, error: res2.error.message};
      data = res2.data;
    }

    // 그래도 없으면 아무나
    if(!data || data.length === 0){
      const res3 = await _sb.from('deck_snapshots')
        .select('*')
        .neq('user_id', _user.id)
        .limit(5);
      if(res3.error) return {opponent:null, error: res3.error.message};
      data = res3.data;
    }

    if(!data || data.length === 0){
      return {opponent:null, error:'상대를 찾을 수 없습니다. 다른 플레이어가 아직 덱을 등록하지 않았습니다.'};
    }

    // 랜덤 선택
    const pick = data[Math.floor(Math.random() * data.length)];
    return {opponent: pick, error: null};
  };

  /** PvP 결과 기록 */
  B.recordPvpMatch = async function(defenderId, defenderLP, result, lpChange, goldReward, rounds){
    if(!B.isReady || !_user) return {error:'offline'};
    const {profile} = await B.getProfile();
    const row = {
      attacker_id:   _user.id,
      defender_id:   defenderId,
      attacker_lp:   (profile && profile.league_points) || 0,
      defender_lp:   defenderLP || 0,
      result:        result,
      lp_change:     lpChange || 0,
      gold_reward:   goldReward || 0,
      rounds_played: rounds || 1,
    };
    const {error} = await _sb.from('pvp_matches').insert(row);
    if(error) return {error: error.message};
    return {error: null};
  };

  /** 최근 PvP 전적 조회 */
  B.getPvpHistory = async function(limit){
    if(!B.isReady || !_user) return {matches:[], error:'offline'};
    const {data, error} = await _sb.from('pvp_matches')
      .select('*')
      .eq('attacker_id', _user.id)
      .order('created_at', {ascending: false})
      .limit(limit || 10);
    if(error) return {matches:[], error: error.message};
    return {matches: data || [], error: null};
  };

  // ── S4: Auth 래퍼 (게임 닉네임 ↔ Supabase Auth 통합) ──
  // 게임은 한국어 닉네임·4자 이상 비번. Supabase 는 이메일·6자 이상.
  //   닉 → URL-safe base64 로 email 로컬파트 생성. domain 은 fake TLD `@rof.local`.
  //   비번 → 6자 미만이면 내부 패딩.

  function _nickToEmail(nick){
    // 한글·특수문자도 안전하게 인코드 (base64 → URL-safe 변환)
    const utf8 = unescape(encodeURIComponent(String(nick || '')));
    const b64 = btoa(utf8).replace(/\+/g,'-').replace(/\//g,'_').replace(/=+$/,'');
    return `rof_${b64}@rof.local`;
  }
  function _padPw(pw){
    const s = String(pw || '');
    return s.length >= 6 ? s : s + '__rof_pad';
  }

  /**
   * 게임 닉네임·비번으로 Supabase 가입.
   * 이미 가입된 닉이면 error 반환.
   */
  B.signupWithNick = async function(nick, pw){
    if(!B.isReady) return {user:null, error:'offline'};
    const email = _nickToEmail(nick);
    const pwd = _padPw(pw);
    const {data, error} = await _sb.auth.signUp({
      email, password: pwd,
      options: { data: { nickname: nick } }
    });
    if(error) return {user:null, error: error.message};
    _user = data.user;
    return {user: data.user, error: null};
  };

  /**
   * 게임 닉네임·비번으로 Supabase 로그인.
   * 미가입이면 자동 signup 시도 (로컬 유저 자동 migration).
   */
  B.loginWithNick = async function(nick, pw){
    if(!B.isReady) return {user:null, error:'offline'};
    const email = _nickToEmail(nick);
    const pwd = _padPw(pw);
    const first = await _sb.auth.signInWithPassword({email, password: pwd});
    if(!first.error){
      _user = first.data.user;
      return {user: first.data.user, error: null};
    }
    // 미가입 or 비번 틀림. "invalid_credentials" 이면 자동 signup 한 번 시도.
    if(first.error && /invalid|not.found|credential/i.test(first.error.message)){
      const sign = await _sb.auth.signUp({
        email, password: pwd,
        options: { data: { nickname: nick } }
      });
      if(!sign.error){
        _user = sign.data.user;
        return {user: sign.data.user, error: null};
      }
      return {user:null, error: sign.error.message};
    }
    return {user:null, error: first.error.message};
  };

  /** 로그아웃 (Supabase 세션 종료) */
  B.logoutAuth = async function(){
    if(!B.isReady) return;
    try { await _sb.auth.signOut(); } catch(e){}
    _user = null;
  };

  // ── S3: 채팅 (PHASE 5) ────────────────────────────────
  // 스키마: supabase/migrations/003_s3_chat.sql
  // RLS 가 채널 접근·뮤트를 DB 레벨에서 차단하므로 클라측은 UX 보조만.

  /** 채널 최근 메시지 N개 로드 (초기 진입 / gap 복구용) */
  B.chatLoadHistory = async function(channel, limit){
    if(!B.isReady) return {messages:[], error:'offline'};
    const {data, error} = await _sb.from('chat_messages')
      .select('*')
      .eq('channel', channel)
      .order('created_at', {ascending: false})
      .limit(limit || 50);
    if(error) return {messages:[], error: error.message};
    return {messages: (data || []).reverse(), error: null};  // 화면엔 오래된→최신 순
  };

  /** 특정 시각 이후 메시지 (realtime 재연결 후 gap 복구) */
  B.chatLoadSince = async function(channel, sinceIso){
    if(!B.isReady) return {messages:[], error:'offline'};
    const {data, error} = await _sb.from('chat_messages')
      .select('*')
      .eq('channel', channel)
      .gt('created_at', sinceIso)
      .order('created_at', {ascending: true})
      .limit(200);
    if(error) return {messages:[], error: error.message};
    return {messages: data || [], error: null};
  };

  /** 메시지 전송. 성공 시 방금 insert 된 row 를 반환(optimistic append 용). */
  B.chatSend = async function(channel, text, attachedCard){
    if(!B.isReady || !_user) return {error:'offline', message:null};
    const {profile} = await B.getProfile();
    if(!profile) return {error:'프로필 없음', message:null};
    const save = profile.save_data || {};
    const row = {
      channel,
      user_id:       _user.id,
      user_name:     profile.nickname || 'hero',
      user_level:    save.heroLevel || (save.deck && save.deck.find(c=>c.isHero)?.level) || 1,
      user_league:   save.league || 'bronze',
      user_guild_id: save.guild_id || null,
      text,
      attached_card: attachedCard || null,
    };
    // .select().single() 로 insert 된 row 즉시 받음 → realtime 실패해도 본인 메시지 optimistic 렌더 가능
    const {data, error} = await _sb.from('chat_messages').insert(row).select().single();
    return {error: error ? error.message : null, message: data || null};
  };

  /**
   * Realtime 구독 — 채널에 INSERT 되는 새 메시지 수신.
   * @param {string} channel 'ch_world' / 'ch_league_gold' / 'ch_guild_abc'
   * @param {(msg) => void} onInsert 콜백
   * @returns {{unsubscribe: () => void}} 구독 객체
   */
  B.chatSubscribe = function(channel, onInsert){
    if(!B.isReady) return {unsubscribe(){}};
    const sub = _sb.channel('chat:' + channel)
      .on('postgres_changes',
          {event:'INSERT', schema:'public', table:'chat_messages',
           filter:`channel=eq.${channel}`},
          (payload) => onInsert(payload.new))
      .subscribe();
    return {
      unsubscribe: () => { try{ _sb.removeChannel(sub); }catch(e){} }
    };
  };

  /** 현재 유저의 뮤트 상태 (UI "뮤트 해제까지 N분" 표시용) */
  B.chatGetMuteStatus = async function(){
    if(!B.isReady || !_user) return {muted:false, secondsRemaining:0, reason:null};
    const {data, error} = await _sb.from('chat_active_mutes')
      .select('*').eq('user_id', _user.id).maybeSingle();
    if(error || !data) return {muted:false, secondsRemaining:0, reason:null};
    return {muted:true, secondsRemaining: data.seconds_remaining, reason: data.reason};
  };

  /** 메시지 신고 */
  B.chatReport = async function(messageId, reason){
    if(!B.isReady || !_user) return {error:'offline'};
    const {error} = await _sb.from('chat_reports').insert({
      message_id: messageId,
      reporter_id: _user.id,
      reason: reason || '',
    });
    return {error: error ? error.message : null};
  };

  // ── 네임스페이스 등록 ─────────────────────────────────
  if(typeof RoF === 'undefined') window.RoF = {};
  RoF.Backend = B;
  window.Backend = B; // 호환성 레이어

})();
