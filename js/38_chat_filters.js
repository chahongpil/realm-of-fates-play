'use strict';

/* ============================================================
   Realm of Fates — PHASE 5 Step 5c/5d: Chat Filters
   ============================================================
   - 36_chat.js 의 _sendMessage 진입부에서 호출 (text 검열)
   - 클라 단 1차 처리. 우회는 Step 6 신고/모더레이션에서 흡수.
   - 금칙어: 명백한 욕설·혐오·광고 매크로 키워드만. 감탄·관용 표현은 false positive 방지로 제외.
   - URL: http(s):// + www. + 주요 TLD(.com .net .org .kr .io .co .me .gg .app .tv) 매칭.
   ============================================================ */

(function(){
  if (window.RoF && window.RoF.ChatFilters) return;
  if (!window.RoF) window.RoF = {};

  // ── 금칙어 리스트 (한국 게임 커뮤니티 기본) ────────────
  // 정렬 원칙: 변형(자모 분리/숫자 치환) 은 별도 정규식이 없어도 마스킹되도록
  // 가장 짧은 어근 위주. 너무 광범위하지 않게 — false positive 감수보다 자연스러운 대화 보호 우선.
  // 보강은 신고 누적 데이터 기반으로 향후 추가.
  const PROFANITY = [
    // 욕설/비속어 (어근)
    '씨발', '시발', '씨바', '시바', '씨팔', '시팔', 'ㅅㅂ', 'ㅆㅂ',
    '좆', '좇', '졷', '존나', '졸라',
    '개새끼', '개새', '새끼', '쌔끼',
    '병신', 'ㅂㅅ', '븅신',
    '닥쳐', '꺼져', '죽어라', '뒤져',
    '미친놈', '미친년',
    // 성적 비하
    '보지', '자지', '자위', '딸딸이', '걸레', '창녀',
    // 차별·혐오
    '틀딱', '한남', '김치녀', '짱깨', '쪽바리', '게이새', '트젠',
    // 광고/매크로 키워드
    '템장사', '현금거래', '현거래', '작업장', '매크로팜',
    // 추가 변형
    '꼴값', '븅이', '븅아', '미친새', '뒤질래'
  ];

  // 정규식 — escape 후 OR 결합. 단어 경계 \b 는 한국어에 안 먹어서 그냥 substring 매칭.
  function escapeRe(s){ return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'); }
  const PROFANITY_RE = new RegExp('(' + PROFANITY.map(escapeRe).join('|') + ')', 'g');

  // ── URL 패턴 ─────────────────────────────────────────
  // 1) http://, https:// 시작
  // 2) www. 시작
  // 3) bare domain — 글자.글자.(주요 TLD)
  const URL_RE = /(https?:\/\/\S+|www\.[a-zA-Z0-9][a-zA-Z0-9.-]*\.[a-zA-Z]{2,}|[a-zA-Z0-9][a-zA-Z0-9-]*\.(?:com|net|org|kr|io|co|me|app|gg|tv|dev|xyz|info|biz)(?:\/\S*)?)/gi;

  /** 욕설 마스킹: '씨발 죽어라' → '씨** 뒤**' (첫 글자만 보존). 매치 없으면 원문 그대로. */
  function maskProfanity(text){
    if(!text) return text;
    return text.replace(PROFANITY_RE, (match) => {
      if(match.length <= 1) return '*';
      return match[0] + '*'.repeat(match.length - 1);
    });
  }

  /** URL 포함 여부 */
  function containsURL(text){
    if(!text) return false;
    URL_RE.lastIndex = 0;
    return URL_RE.test(text);
  }

  /** 종합 검열. 결과:
   *  - blocked: URL 발견 시 true (메시지 자체 거부)
   *  - cleaned: 욕설 마스킹된 텍스트 (URL blocked 면 원본)
   *  - reason: 'url' | 'profanity' | null
   */
  function censor(text){
    if(!text) return { blocked:false, cleaned:text, reason:null };
    if(containsURL(text)){
      return { blocked:true, cleaned:text, reason:'url' };
    }
    const masked = maskProfanity(text);
    if(masked !== text){
      return { blocked:false, cleaned:masked, reason:'profanity' };
    }
    return { blocked:false, cleaned:text, reason:null };
  }

  RoF.ChatFilters = {
    censor,
    maskProfanity,
    containsURL,
    // 디버깅·테스트용 노출 (production 에선 안 써도 됨)
    _PROFANITY: PROFANITY,
    _URL_RE: URL_RE,
  };
})();
