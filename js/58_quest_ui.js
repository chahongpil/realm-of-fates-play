// 퀘스트 게시판 UI (RoF.QuestUI) — 다운로드 시안(성_퀘스트/quest_board.html) 적용.
// CSS: css/55_quest_board.css (시안 그대로). 로직: RoF.Quest (56_game_quests.js).
// 원칙: 외곽 디자인은 시안, 데이터/인터랙션은 RoF.Quest 와이어링, 카드/초상 = CARD_IMG 재사용.
// 호출: RoF.Game.showCastleQuestTab() → QuestUI.render(#castle-quest-area).
// custom: 인라인 SVG 는 사용자 컨펌 시안의 back chevron 아이콘 — 차용 시각효과 아님 (디자인 세션 산출물).
// v1.1 분리(미구현): 완료 VN 시네마틱, 3-카드 보상 pick, 생명의서 czoom, 적 5-미리보기 팝업.
(function (global) {
  const RoF = global.RoF = global.RoF || {};
  const QuestUI = RoF.QuestUI = RoF.QuestUI || {};

  const Q = () => RoF.Quest;
  const G = () => RoF.Game;
  const D = () => RoF.Data;
  const esc = s => String(s == null ? '' : s).replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
  function cardImg(id) { const m = D() && D().CARD_IMG; return (m && m[id]) || ''; }

  // 의뢰자 → 시안 req 클래스 + 한글명
  const GIVER = {
    village:    { cls: 'rq-village', ko: '마을' },
    guild_ash:  { cls: 'rq-ash',     ko: '잿더미 상회' },
    guild_spring:{cls: 'rq-spring',  ko: '망각의 샘터' },
    guild_vein: { cls: 'rq-vein',    ko: '지하 광맥 조합' },
    guild_storm:{ cls: 'rq-storm',   ko: '폭풍 카라반' },
    guild_choir:{ cls: 'rq-choir',   ko: '잿빛 성가단' },
    guild_wraith:{cls:'rq-wraith',   ko: '망령 상회' },
  };
  const RAR_VAR = { bronze: 'var(--r-bronze)', silver: 'var(--r-silver)', gold: 'var(--r-gold)', legendary: 'var(--r-legendary)', divine: 'var(--r-divine)' };
  const NPC_NAME = { village: '촌장', guild_ash: '상회장 카르옌', guild_spring: '샘터지기', guild_storm: '카라반장 비크', guild_choir: '성가단주', guild_wraith: '망령 중개인', guild_vein: '광맥 조합장' };

  let _selId = null, _partyUids = [], _cdTimer = null;

  function rosterCompanions() {
    const isHero = c => !!(c && (c._isHero || c.isHero || c.kind === 'hero'));
    return (G().deck || []).filter(c => c && !isHero(c) && (c.kind === 'unit' || c.kind === undefined) && c.id);
  }
  function fmtCountdown(ms) {
    if (ms <= 0) return '완료';
    const s = Math.floor(ms / 1000), h = Math.floor(s / 3600), m = Math.floor((s % 3600) / 60), ss = s % 60;
    const p = n => String(n).padStart(2, '0');
    return p(h) + ':' + p(m) + ':' + p(ss);
  }

  QuestUI.render = function (container) {
    if (!container) return;
    if (Q() && Q().checkDailyReset) Q().checkDailyReset();
    const board = (Q() && Q().board) ? Q().board() : [];
    const allShown = board.slice();
    ((G().quests && G().quests.active) || []).forEach(a => {
      if (a.type === 'timed' && !allShown.some(q => q.id === a.id)) { const def = D().getQuest(a.id); if (def) allShown.push(def); }
    });
    if (!_selId || !allShown.some(q => q.id === _selId)) _selId = allShown[0] ? allShown[0].id : null;

    container.innerHTML = headerHtml() + '<div class="qb-body">' + boardHtml(allShown) + detailHtml(_selId) + '</div>' + overlaysHtml();
    bindHeader(container); bindBoard(container); bindDetail(container); startCountdowns(container);
  };

  function headerHtml() {
    const lv = (Q() && Q().challengeLevel) ? Q().challengeLevel() : 1;
    const xp = (G().challengeXP || 0), xpNext = D().challengeXpForLevel(lv) || 1;
    const pct = Math.max(0, Math.min(100, Math.round(xp / xpNext * 100)));
    const timedCnt = (Q() && Q().activeTimedCount) ? Q().activeTimedCount() : 0;
    const cap = D().QUEST_MAX_ACTIVE_TIMED || 2;
    return `<div class="qb-head">
      <button class="qb-back" data-qb="back" title="왕성으로"><svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" stroke-width="1.6"><path d="M15 6l-6 6 6 6"/></svg></button>
      <div class="qb-title"><span class="ko">퀘스트 게시판</span><span class="en">Quest Board · 왕성</span></div>
      <div class="sep"></div>
      <div class="chal"><span class="lv">도전 Lv ${lv}</span><div class="xp"><div class="bar"><i style="width:${pct}%"></i></div><div class="n">${xp} / ${xpNext}</div></div></div>
      <div class="pill-stat">⏳ 파견 <b>${timedCnt}</b>/${cap}</div>
    </div>`;
  }

  function boardHtml(list) {
    const items = list.map(qiHtml).join('') || '<div style="color:var(--t3);text-align:center;padding:40px 0;font:400 11px/1.6 \'Noto Sans KR\';">지금은 받을 수 있는 의뢰가 없습니다.<br>잠시 후 새 의뢰가 게시됩니다.</div>';
    return `<div class="board"><div class="board-head"><span class="lbl">Quests</span><span class="ko">의뢰 목록</span><span class="line"></span><span class="rot">3 / 6 로테이션</span></div>${items}</div>`;
  }

  function qiHtml(def) {
    const giver = GIVER[def.giver] || { cls: '', ko: def.giver || '의뢰' };
    const sel = (def.id === _selId) ? ' sel' : '';
    const active = (Q().getActive && Q().getActive(def.id));
    const ready = active && Q().timedReady && Q().timedReady(def.id);
    const typeCls = def.type === 'battle' ? 't-battle' : 't-timed';
    const typeIc = def.type === 'battle' ? '⚔' : '⏳';
    const band = `Lv ${def.levelMin || 1}~${def.levelMax || 5}`;
    let stateHtml;
    if (def.type === 'battle') {
      stateHtml = `<span style="font:700 9px/1 'Noto Sans KR';letter-spacing:.14em;color:var(--battle);">⚔ 실시간 전투</span><button class="qi-btn go" data-qb="select" data-id="${def.id}">전투</button>`;
    } else if (active) {
      const minis = (active.party || []).slice(0, 4).map(u => { const c = (G().deck || []).find(x => x.uid === u); return `<div class="mini"><img src="${esc(cardImg(c && c.id))}" alt=""></div>`; }).join('');
      const more = (active.party || []).length > 4 ? `<span class="more">+${active.party.length - 4}</span>` : '';
      if (ready) stateHtml = `<div class="dispatched">${minis}${more}</div><div class="countdown" style="color:var(--good)">완료</div><button class="qi-btn done" data-qb="complete" data-id="${def.id}">완료</button>`;
      else stateHtml = `<div class="dispatched">${minis}${more}</div><div class="countdown" data-cd="${def.id}"><span class="ic">⏳</span><span class="t">--:--:--</span></div><button class="qi-btn recall" data-qb="recall" data-id="${def.id}">회수</button>`;
    } else {
      stateHtml = `<span style="font:700 9px/1 'Noto Sans KR';letter-spacing:.14em;color:var(--timed);">⏳ 파견 ${def.durationMin || 0}분</span><button class="qi-btn" data-qb="select" data-id="${def.id}">파견</button>`;
    }
    const readyCls = ready ? ' ready' : '';
    const readyBadge = ready ? '<span class="ready-badge">완료 가능</span>' : '';
    const rewardLine = (!active) ? `<div class="qi-reward"><span class="g">💰 ${def.reward.gold || 0}</span><span class="c">🎴 카드</span><span class="x">✦ XP</span></div>` : '';
    return `<div class="qi ${typeCls}${sel}${readyCls}" data-qb="select" data-id="${def.id}">${readyBadge}
      <div class="qi-top"><div class="qi-type">${typeIc}</div><div class="qi-title">${esc(def.title)}</div><div class="qi-band">${band}</div></div>
      <div class="qi-mid"><span class="req ${giver.cls}"><span class="dot"></span>${esc(giver.ko)}</span></div>
      ${rewardLine}<div class="qi-state">${stateHtml}</div></div>`;
  }

  function detailHtml(id) {
    const def = id && D().getQuest(id);
    if (!def) return `<div class="detail"><div style="margin:auto;color:var(--t3);font:400 12px/1.6 'Noto Serif KR';text-align:center;">의뢰를 선택하세요.</div></div>`;
    const active = Q().getActive && Q().getActive(id);
    const dlg = def.dialogue || {};
    const giver = GIVER[def.giver] || { ko: def.giver || '' };
    const lines = (dlg.accept || []).map(l => `<div class="npc-line">"${esc(l)}"</div>`).join('');
    const portrait = cardImg(dlg.portrait) || '';

    if (active && def.type === 'timed') {
      return `<div class="detail" data-detail="${id}">${npcHtml(portrait, giver.ko, def.giver, lines)}
        <div class="hero-note"><span class="ic">⏳</span><span><b>파견 진행 중</b> — 동료가 ${def.durationMin}분 임무 수행 중. 완료되면 보상을 수령하세요.</span></div>
        <div class="sec-label"><span class="lbl">Dispatched · 파견 동료</span><span class="line"></span></div>
        <div class="party">${partySlotsHtml(active.party || [], true)}</div>${rewardBoxHtml(def)}
        <div class="perform"><span class="cost">파견 중</span><button class="btn-perform" data-qb="recall" data-id="${id}" style="background:linear-gradient(180deg,#7a2a1e,#3a120a);">파견 회수</button></div></div>`;
    }

    _partyUids = [];
    const isBattle = def.type === 'battle';
    const heroNote = isBattle
      ? `<div class="hero-note"><span class="ic">⚔</span><span><b>영웅은 자동 참여</b> — 승패는 영웅 생존으로 판정. 아래는 <b>동료 편성</b>입니다.</span></div>`
      : `<div class="hero-note"><span class="ic">⏳</span><span><b>동료를 파견</b> — 파견 동료는 완료까지 다른 곳에 쓸 수 없습니다 (파견 중).</span></div>`;
    const rsRow = isBattle ? rewardBoxHtml(def) : `<div class="rs-row">${rewardBoxInnerHtml(def)}${succBoxHtml(def, [])}</div>`;
    return `<div class="detail" data-detail="${id}">
      <span class="npc-skip" data-qb="skip">대사 건너뛰기 ▸</span>
      ${npcHtml(portrait, giver.ko, def.giver, lines)}${heroNote}
      <div class="sec-label"><span class="lbl">Party · 동료 편성</span><span class="line"></span><button class="auto-fill" data-qb="autofill">⚡ 자동 편성</button><span class="hint">1~5 · 클릭 배치</span></div>
      <div class="party">${partySlotsHtml(_partyUids, false)}</div>${rsRow}
      <div class="perform"><span class="cost">편성 <b class="party-n">0</b>/5${isBattle ? ' · 영웅 자동' : ''}</span><button class="btn-perform${isBattle ? '' : ' timed'}" data-qb="perform" data-id="${id}">${isBattle ? '⚔ 전투 개시' : '⏳ 파견 보내기'}</button></div></div>`;
  }

  function npcHtml(portrait, role, giverKey, lines) {
    const name = NPC_NAME[giverKey] || '의뢰자';
    return `<div class="npc"><div class="npc-portrait">${portrait ? `<img src="${esc(portrait)}" alt="">` : ''}<span class="frame-corner fc-tl"></span><span class="frame-corner fc-br"></span></div>
      <div class="npc-text"><div class="npc-name">${esc(name)}<span class="role">${esc(role)}</span></div>${lines}</div></div>`;
  }

  function partySlotsHtml(uids, locked) {
    const max = D().QUEST_PARTY_MAX || 5; let html = '';
    for (let i = 0; i < max; i++) {
      const u = uids[i];
      if (u) {
        const c = (G().deck || []).find(x => x.uid === u);
        const rc = RAR_VAR[c && c.rarity] || 'var(--bd-3)';
        const cp = Math.round((Q().cardPower && c) ? Q().cardPower(c) : 0);
        html += `<div class="pslot filled${locked ? ' busy' : ''}" style="--rc:${rc}" data-slot="${i}">${locked ? '' : '<span class="rm" data-rm="' + i + '">✕</span>'}<span class="cp">${cp}</span><img src="${esc(cardImg(c && c.id))}" alt=""><span class="nm">${esc(c && c.name || '')}</span>${locked ? '<span class="busy-tag">파견 중</span>' : ''}</div>`;
      } else html += `<div class="pslot" data-slot="${i}"><span class="plus">＋</span><span class="ph">빈 슬롯</span></div>`;
    }
    return html;
  }

  function rewardBoxInnerHtml(def) {
    const r = def.reward || {};
    let cardLine;
    if (def.previewMode === 'masked_first') {
      // 마스킹 모드 — 첫 도전 전 카드 풀 ??? / 격파 후 공개 (design/quest_lines_v1.md §1.6, jackpot 은 영입 시점에만 공개).
      const beaten = !!(Q() && Q().isBeaten && Q().isBeaten(def.id));
      if (!beaten) {
        cardLine = `<div class="reward-line" style="margin-top:6px;"><span class="c">🎴 카드 풀</span><span class="drop">· ??? (격파 후 공개)</span></div>`;
      } else {
        const units = ((def.battle && def.battle.enemyUnits) || []);
        const uniq = units.filter((v, i) => units.indexOf(v) === i);
        const names = uniq.map(uid => { const u = D() && D().UNITS && D().UNITS.find(x => x.id === uid); return esc(u ? u.name : uid); }).join(', ');
        const jackpotLine = r.jackpot
          ? `<div class="reward-line" style="margin-top:4px;"><span class="x">✨ 우두머리 영입</span><span class="drop">· ??? (${(r.jackpot.chance * 100).toFixed(1)}%)</span></div>` : '';
        cardLine = `<div class="reward-line" style="margin-top:6px;"><span class="c">🎴 카드 풀</span><span class="drop">· ${Math.round((r.cardDropChance || 0) * 100)}% 드롭${names ? ' (' + names + ')' : ''}</span></div>${jackpotLine}`;
      }
    } else {
      cardLine = `<div class="reward-line" style="margin-top:6px;"><span class="c">🎴 카드</span><span class="drop">· ${Math.round((r.cardDropChance || 0) * 100)}% 확률 드롭</span></div>`;
    }
    return `<div class="reward-box"><div class="rh">Reward · 보상</div>
      <div class="reward-line"><span class="g">💰 ${r.gold || 0} 골드</span></div>
      ${cardLine}
      <div class="reward-line" style="margin-top:6px;"><span class="x">✦ 도전 XP</span></div></div>`;
  }
  function rewardBoxHtml(def) { return `<div class="rs-row">${rewardBoxInnerHtml(def)}</div>`; }

  function succBoxHtml(def, uids) {
    const rate = (Q().computeSuccessRate) ? Q().computeSuccessRate(def, uids) : 0;
    const cap = (D().QUEST_REWARD_CAP || 2) * 100, mult = Math.min(rate, cap) / 100;
    return `<div class="succ-box"><div class="rh">성공률</div><div class="succ-pct${rate < 100 ? ' under' : ''}" data-succ>${rate}%</div>
      <div class="succ-meta">요구 전투력 <b>${def.requiredPower || 0}</b></div><div class="succ-mult" data-mult>${rate >= 100 ? '보상 ×' + mult.toFixed(1) : rate + '% 확률 성공'}</div></div>`;
  }

  function overlaysHtml() {
    return `<div class="pick" data-qb="pick-bg"><div class="pick-box" data-qb="pick-box">
      <span class="fc tl"></span><span class="fc tr"></span><span class="fc bl"></span><span class="fc br"></span>
      <div class="pick-head"><span class="ttl">동료 선택</span><input class="pick-search" data-qb="pick-search" placeholder="이름 검색..." autocomplete="off"></div>
      <div class="pick-filterbar">
        <div class="pf-group" data-pf="el"><span class="pf-l">원소</span><span class="pf on" data-el="all">전체</span><span class="pf" data-el="fire">🔥</span><span class="pf" data-el="water">💧</span><span class="pf" data-el="earth">🌿</span><span class="pf" data-el="lightning">⚡</span><span class="pf" data-el="holy">✨</span><span class="pf" data-el="dark">🌑</span></div>
        <div class="pf-group" data-pf="rar"><span class="pf-l">등급</span><span class="pf on" data-rar="all">전체</span><span class="pf rc-silver" data-rar="silver">희귀</span><span class="pf rc-gold" data-rar="gold">고귀</span><span class="pf rc-legendary" data-rar="legendary">전설</span><span class="pf rc-divine" data-rar="divine">신</span></div>
      </div>
      <div class="pick-grid" data-qb="pick-grid"></div><div class="pick-hint">바깥 클릭 · 닫기</div></div></div>`;
  }

  function bindHeader(c) {
    const back = c.querySelector('[data-qb="back"]');
    if (back) back.onclick = () => { if (G().showMenu) G().showMenu(); else if (RoF.UI && RoF.UI.show) RoF.UI.show('menu-screen'); };
  }
  function bindBoard(c) {
    c.querySelectorAll('[data-qb="select"]').forEach(el => el.addEventListener('click', e => { e.stopPropagation(); _selId = el.getAttribute('data-id'); QuestUI.render(c); }));
    c.querySelectorAll('[data-qb="complete"]').forEach(el => el.addEventListener('click', e => {
      e.stopPropagation();
      const r = Q().completeTimed(el.getAttribute('data-id'));
      if (r && r.ok) {
        const g = r.gained || {};
        const msg = r.success ? `의뢰 완료!\n\n💰 +${g.gold} 골드` + (g.cardId ? `\n🎴 카드 획득: ${g.cardId}` : '') + `\n✦ 도전 +${g.challengeXP} XP` : `의뢰 실패...\n\n위로금 💰 +${g.gold} 골드`;
        if (RoF.UI && RoF.UI.modal) RoF.UI.modal(r.success ? '✨ 의뢰 완료' : '💀 의뢰 실패', msg, null);
      }
      QuestUI.render(c);
    }));
    c.querySelectorAll('[data-qb="recall"]').forEach(el => el.addEventListener('click', e => {
      e.stopPropagation();
      const id = el.getAttribute('data-id');
      const doRecall = () => { Q().recall(id); QuestUI.render(c); };
      if (RoF.UI && RoF.UI.modal) RoF.UI.modal('파견 회수', '지금 회수하면 보상을 받을 수 없습니다.\n동료가 즉시 복귀합니다.\n\n회수하시겠습니까?', doRecall);
      else doRecall();
    }));
  }
  function bindDetail(c) {
    const detail = c.querySelector('.detail[data-detail]'); if (!detail) return;
    const id = detail.getAttribute('data-detail'); const def = D().getQuest(id);
    const skip = detail.querySelector('[data-qb="skip"]');
    if (skip) skip.onclick = () => detail.querySelectorAll('.npc-line').forEach(l => { l.style.transition = 'opacity .3s'; l.style.opacity = '0'; });
    detail.querySelectorAll('.party .pslot').forEach(slot => {
      if (slot.classList.contains('busy')) return;
      const rm = slot.querySelector('.rm');
      if (rm) rm.addEventListener('click', e => { e.stopPropagation(); _partyUids.splice(+rm.getAttribute('data-rm'), 1); refreshParty(c, detail, def); });
      slot.addEventListener('click', () => openPicker(c, detail, def, +slot.getAttribute('data-slot')));
    });
    const af = detail.querySelector('[data-qb="autofill"]');
    if (af) af.onclick = () => {
      const busy = new Set(Q().busyCompanionUids ? Q().busyCompanionUids() : []);
      const pool = rosterCompanions().filter(c2 => !busy.has(c2.uid) && !_partyUids.includes(c2.uid)).sort((a, b) => Q().cardPower(b) - Q().cardPower(a));
      const max = D().QUEST_PARTY_MAX || 5;
      for (const card of pool) { if (_partyUids.length >= max) break; _partyUids.push(card.uid); }
      refreshParty(c, detail, def);
    };
    const perform = detail.querySelector('[data-qb="perform"]');
    if (perform && perform.getAttribute('data-qb') === 'perform') perform.onclick = () => {
      if (!_partyUids.length) { if (RoF.UI && RoF.UI.toast) RoF.UI.toast('동료를 1명 이상 편성하세요'); return; }
      if (def.type === 'battle') { const r = Q().startQuestBattle(id, _partyUids.slice()); if (!r.ok && RoF.UI && RoF.UI.toast) RoF.UI.toast('전투 시작 실패: ' + r.reason); }
      else { const r = Q().accept(id, _partyUids.slice()); if (!r.ok) { if (RoF.UI && RoF.UI.toast) RoF.UI.toast(r.reason); return; } _selId = id; QuestUI.render(c); }
    };
    // 진행중 회수 버튼 (상세)
    const recallBtn = detail.querySelector('[data-qb="recall"]');
    if (recallBtn) recallBtn.onclick = () => { const doR = () => { Q().recall(id); QuestUI.render(c); }; if (RoF.UI && RoF.UI.modal) RoF.UI.modal('파견 회수', '보상을 포기하고 회수하시겠습니까?', doR); else doR(); };
  }
  function refreshParty(c, detail, def) {
    const partyEl = detail.querySelector('.party');
    if (partyEl) { partyEl.innerHTML = partySlotsHtml(_partyUids, false); bindDetail(c); }
    const nEl = detail.querySelector('.party-n'); if (nEl) nEl.textContent = _partyUids.length;
    if (def && def.type === 'timed') {
      const rate = Q().computeSuccessRate(def, _partyUids);
      const pctEl = detail.querySelector('[data-succ]'); if (pctEl) { pctEl.textContent = rate + '%'; pctEl.classList.toggle('under', rate < 100); }
      const cap = (D().QUEST_REWARD_CAP || 2) * 100, mult = Math.min(rate, cap) / 100;
      const mEl = detail.querySelector('[data-mult]'); if (mEl) mEl.textContent = rate >= 100 ? `보상 ×${mult.toFixed(1)}` : `${rate}% 확률 성공`;
    }
  }
  let _pickSlot = null, _fEl = 'all', _fRar = 'all', _fQ = '';
  function openPicker(c, detail, def, slotIdx) {
    _pickSlot = slotIdx; const pick = c.querySelector('.pick'); if (!pick) return;
    pick.classList.add('on'); renderPickGrid(c, detail, def);
    pick.querySelectorAll('[data-pf="el"] .pf').forEach(b => b.onclick = () => { pick.querySelectorAll('[data-pf="el"] .pf').forEach(x => x.classList.remove('on')); b.classList.add('on'); _fEl = b.getAttribute('data-el'); renderPickGrid(c, detail, def); });
    pick.querySelectorAll('[data-pf="rar"] .pf').forEach(b => b.onclick = () => { pick.querySelectorAll('[data-pf="rar"] .pf').forEach(x => x.classList.remove('on')); b.classList.add('on'); _fRar = b.getAttribute('data-rar'); renderPickGrid(c, detail, def); });
    const search = pick.querySelector('[data-qb="pick-search"]'); if (search) search.oninput = e => { _fQ = e.target.value.trim(); renderPickGrid(c, detail, def); };
    pick.onclick = () => pick.classList.remove('on');
    const box = pick.querySelector('[data-qb="pick-box"]'); if (box) box.onclick = e => e.stopPropagation();
  }
  function renderPickGrid(c, detail, def) {
    const pick = c.querySelector('.pick'); const grid = pick.querySelector('[data-qb="pick-grid"]');
    const busy = new Set(Q().busyCompanionUids ? Q().busyCompanionUids() : []);
    const list = rosterCompanions().filter(card => (_fEl === 'all' || card.element === _fEl) && (_fRar === 'all' || card.rarity === _fRar) && (!_fQ || (card.name || '').includes(_fQ)) && !_partyUids.includes(card.uid));
    grid.innerHTML = list.length ? list.map(card => {
      const rc = RAR_VAR[card.rarity] || 'var(--bd-3)'; const isBusy = busy.has(card.uid); const cp = Math.round(Q().cardPower(card));
      return `<div class="pc ${isBusy ? 'busy' : ''}" style="--rc:${rc}" data-uid="${card.uid}"><img src="${esc(cardImg(card.id))}" alt=""><span class="lv">L${card.level || 1}</span><span class="cp">${cp}</span><span class="nm">${esc(card.name)}</span>${isBusy ? '<span class="bt">파견 중</span>' : ''}</div>`;
    }).join('') : '<div style="grid-column:1/-1;text-align:center;color:var(--t3);padding:40px 0;font:400 11px/1 sans-serif;">조건에 맞는 동료가 없습니다.</div>';
    grid.querySelectorAll('.pc').forEach(pc => {
      if (pc.classList.contains('busy')) return;
      pc.onclick = () => { const uid = pc.getAttribute('data-uid'); if (_pickSlot != null) { _partyUids[_pickSlot] = uid; _partyUids = _partyUids.filter(Boolean); } else _partyUids.push(uid); pick.classList.remove('on'); refreshParty(c, detail, def); };
    });
  }
  function startCountdowns(c) {
    if (_cdTimer) clearInterval(_cdTimer);
    const tick = () => {
      const els = c.querySelectorAll('[data-cd]'); if (!els.length) return;
      els.forEach(el => { const id = el.getAttribute('data-cd'); const ms = Q().remainingMs ? Q().remainingMs(id) : 0; const t = el.querySelector('.t'); if (t) t.textContent = fmtCountdown(ms); if (ms <= 0) QuestUI.render(c); });
    };
    tick(); _cdTimer = setInterval(tick, 1000);
  }

  // ── 카드 영입 연출 (mockup/quest_reward_visions 확정 시안). CSS: css/45_reward.css .rw-vision-overlay. ──
  // visionId: 'scene_3' (일반, 5초) | 'fates_thread' (jackpot, 7초). opts.cardId = 영입 카드 (이미지용).
  // 자동 제거 + 클릭 skip. Promise resolve = 연출 종료.
  QuestUI.playRewardVision = function (visionId, opts) {
    opts = opts || {};
    return new Promise(resolve => {
      const root = document.querySelector('.game-root') || document.body;
      if (!root) { resolve(); return; }
      const overlay = document.createElement('div');
      overlay.className = 'rw-vision-overlay';
      let dur;
      if (visionId === 'fates_thread') {
        const img = cardImg(opts.cardId || 'hero_wolf_alpha');
        overlay.innerHTML =
          '<div class="rwv-stage rwv-jackpot playing">' +
          '<div class="rwv-glow"></div>' +
          '<div class="rwv-thread"></div>' +
          '<div class="rwv-card" style="background-image:url(\'' + esc(img) + '\')"></div>' +
          '<div class="rwv-veil"></div>' +
          '<div class="rwv-bigtext">FATE\'S THREAD BINDS YOU<span class="ko">그대는 무리의 일부가 되었다<br>우두머리가 그대의 운명에 따른다</span></div>' +
          '</div>';
        dur = 7200;
      } else {
        const img = cardImg(opts.cardId || 'wolf');
        overlay.innerHTML =
          '<div class="rwv-stage rwv-normal playing">' +
          '<div class="rwv-scene">' +
          '<div class="rwv-eyes">● ●</div>' +
          '<div class="rwv-narration">두 눈이 어둠 속에서 그대를 본다.<br>두려움도 적의도 아니다. 그저, 결정.</div>' +
          '<div class="rwv-card" style="background-image:url(\'' + esc(img) + '\')"></div>' +
          '</div>' +
          '<div class="rwv-label">동행자가 늘었다</div>' +
          '</div>';
        dur = 5200;
      }
      let done = false;
      const cleanup = () => { if (done) return; done = true; try { overlay.remove(); } catch (e) {} resolve(); };
      overlay.addEventListener('click', cleanup);
      root.appendChild(overlay);
      setTimeout(cleanup, dur);
    });
  };
})(typeof window !== 'undefined' ? window : globalThis);
