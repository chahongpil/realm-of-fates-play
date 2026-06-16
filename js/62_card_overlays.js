'use strict';
/* design-confirmed: 2026-06-07 사유: 사용자 컨펌 (#1 레벨업 v2 + #2 카드보상 v2, "게임 적용하자")
   카드 오버레이 — 통합 레벨업 + 카드 부여 보상(팩오픈).
   시안: mockup/card_levelup/v2 + mockup/card_reward_pack/v2.
   - RoF.UI.showLevelUp(cardInst, {fromLv, toLv, pointsGained})
       어디서 레벨업하든(퀘스트/훈련소/매치) 동일 오버레이. 5의 배수 = 스탯포인트 즉시분배(또는 훈련소 보관).
   - RoF.UI.showCardReward(card, {isNew, tier, onSlot, onClose})
       1장 팩오픈 — 선술집 tav-flipper 공개 효과 재사용. 유닛/스펠 자동 분기.
*/
(function(){
  const RoF = window.RoF;
  if (!RoF || !RoF.UI) { console.warn('[card_overlays] RoF.UI missing'); return; }
  const UI = RoF.UI;

  const RARKO  = { bronze:'일반', silver:'희귀', gold:'고귀한', legendary:'전설', divine:'신' };
  const RARTIER= { bronze:'common', silver:'rare', gold:'noble', legendary:'legendary', divine:'divine' };
  const RARCOL = { common:'#b8b8c0', rare:'#3a7bd5', noble:'#9b59b6', legendary:'#f39c12', divine:'#e8d27a' };
  const ROLEKO = { attack:'공격', defense:'수호', support:'지원', crit:'정밀' };
  const DMGKO  = { melee:'근접', ranged:'원거리', magic:'마법' };
  const STATKO = { atk:'공격력 +2', hp:'생명력 +5', soul:'영혼력 +1' };

  function $(id){ return document.getElementById(id); }
  function mkCard(c){ return (window.mkCardElV4 ? window.mkCardElV4(c, {frameMode:'hand'}) : document.createElement('div')); }
  function isHeroCard(c){ return !!(c && (c.kind === 'hero' || c._isHero === true || c.isHero === true)); }
  function isSpellCard(c){ return !!(c && (c.kind === 'spell-target' || c.kind === 'spell-aoe')); }

  // ════════════════════════ 레벨업 오버레이 ════════════════════════
  UI.showLevelUp = function(cardInst, opts){
    opts = opts || {};
    const ov = $('rof-levelup'); if (!ov || !cardInst) return;
    const fromLv = opts.fromLv != null ? opts.fromLv : ((cardInst.level||2) - 1);
    const toLv   = opts.toLv   != null ? opts.toLv   : (cardInst.level||2);
    const milestone = (opts.pointsGained || 0) > 0 || (toLv % 5 === 0);
    const hero = isHeroCard(cardInst);

    // 카드 마운트
    const wrap = $('lvc-cardwrap');
    [...wrap.querySelectorAll('.card-v4')].forEach(e=>e.remove());
    wrap.appendChild(mkCard(cardInst));

    $('lvc-name').textContent = (cardInst.name || cardInst.id || '') + (hero ? ' · 영웅' : '');
    $('lvc-lv-old').textContent = 'Lv ' + fromLv;
    $('lvc-lv-new').textContent = toLv;

    const xpMax = (RoF.Game && RoF.Game.cardXpNext) ? RoF.Game.cardXpNext(cardInst) : 100;
    const xpCur = cardInst.xp || 0;
    $('lvc-xp-cur').textContent = xpCur;
    $('lvc-xp-max').textContent = xpMax;

    const sp = $('lvc-sp'), plain = $('lvc-plain'), fill = $('lvc-xpfill'), lvNew = $('lvc-lv-new');
    sp.classList.remove('show','done'); plain.classList.remove('show');
    sp.querySelector('.lvc-sp-result').textContent = '';
    sp.style.display = milestone ? '' : 'none';
    plain.style.display = milestone ? 'none' : '';

    // 픽 버튼 (유닛 2 / 영웅 3)
    const picks = [
      {stat:'atk', ic:'⚔', k:'공격력', v:'+2'},
      {stat:'hp',  ic:'♥', k:'생명력', v:'+5'},
    ];
    if (hero) picks.push({stat:'soul', ic:'✦', k:'영혼력', v:'+1'});
    $('lvc-sp-picks').innerHTML = picks.map(p =>
      `<button class="lvc-pick ${p.stat}" data-stat="${p.stat}"><span class="ic">${p.ic}</span><span class="k">${p.k}</span><span class="v">${p.v}</span></button>`).join('');

    // 픽/디퍼 핸들러 (재바인딩)
    $('lvc-sp-picks').onclick = function(e){
      const btn = e.target.closest('.lvc-pick'); if (!btn) return;
      const stat = btn.dataset.stat;
      const ok = (RoF.Game && RoF.Game.allocStatPoint) ? RoF.Game.allocStatPoint(cardInst, stat) : false;
      if (!ok) return;
      // 카드 즉시 반영 (재마운트)
      [...wrap.querySelectorAll('.card-v4')].forEach(el=>el.remove());
      wrap.appendChild(mkCard(cardInst));
      sp.querySelector('.lvc-sp-result').textContent = '✔ ' + STATKO[stat] + ' 적용 — 카드에 반영됨';
      sp.classList.add('done');
      if (window.SFX && SFX.play) SFX.play('upgrade');
      if (RoF.Game && RoF.Game.persist) try { RoF.Game.persist(); } catch(_){}
    };
    $('lvc-sp-defer').onclick = function(){
      sp.querySelector('.lvc-sp-result').textContent = '✦ 훈련소 수련 탭에 스탯 포인트 보관됨';
      sp.classList.add('done');
    };
    $('lvc-close').onclick = function(){ closeLevelUp(); };

    // 표시 + 애니
    ov.classList.remove('is-closing','is-on');
    ov.classList.add('is-open');
    fill.style.width = '15%';
    void ov.offsetWidth;
    ov.classList.add('is-on');
    setTimeout(()=>{ fill.style.width = Math.max(6, Math.min(100, Math.round(xpCur / Math.max(1,xpMax) * 100))) + '%'; }, 380);
    setTimeout(()=>{ lvNew.classList.remove('tick'); void lvNew.offsetWidth; lvNew.classList.add('tick'); }, 1500);
    if (milestone) setTimeout(()=>sp.classList.add('show'), 0); else setTimeout(()=>plain.classList.add('show'), 0);

    if (window.SFX && SFX.play) SFX.play('rarity_up');
  };

  function closeLevelUp(){
    const ov = $('rof-levelup'); if (!ov) return;
    ov.classList.add('is-closing');
    setTimeout(()=>{ ov.classList.remove('is-open','is-on','is-closing'); _runNextJob(); }, 350);
  }

  // ════════════════════════ 통합 오버레이 큐 (레벨업 → 스킬 해금 순차 재생) ════════════════════════
  // job: {t:'levelup', card, opts} | {t:'unlock', skill, character}
  // design-confirmed: 2026-06-08 사유: 갤러리 검수 후 사용자 "적용하자" (해금 연출 v1 초록)
  const _jobs = [];
  function _busy(){
    const lv = $('rof-levelup'), cr = $('rof-cardreward');
    return (lv && lv.classList.contains('is-open')) || (cr && cr.classList.contains('is-open'));
  }
  function _runNextJob(){
    if (_busy()) return;
    const job = _jobs.shift();
    if (!job) return;
    if (job.t === 'levelup') UI.showLevelUp(job.card, job.opts);
    else if (job.t === 'unlock') UI.showSkillUnlock(job.skill, job.character);
  }
  // 옛 API 호환
  UI.queueLevelUp = function(cardInst, opts){ _jobs.push({t:'levelup', card:cardInst, opts:opts}); };
  UI.flushLevelUps = function(){ _runNextJob(); };

  // 단일 진입점 — 레벨업 + 그 레벨업으로 해금된 시그니처 스킬을 순차 재생.
  UI.presentLevelUp = function(card, lvRes){
    if (!card || !lvRes || !lvRes.leveled) return;
    _jobs.push({t:'levelup', card:card, opts:lvRes});
    const unlocked = RoF.skillsUnlockedBetween ? RoF.skillsUnlockedBetween(card, lvRes.fromLv, lvRes.toLv) : [];
    unlocked.forEach(function(s){ _jobs.push({t:'unlock', skill:s, character:card}); });
    _runNextJob();
  };

  // ════════════════════════ 카드 부여 보상 (팩오픈) ════════════════════════
  UI.showCardReward = function(card, opts){
    opts = opts || {};
    const ov = $('rof-cardreward'); if (!ov || !card) return;
    const spell = isSpellCard(card);
    const tier = opts.tier || RARTIER[card.rarity] || 'rare';
    const isNew = opts.isNew !== false;

    // 해금 연출 상태 잔재 청소 (showSkillUnlock 와 DOM 공유)
    ov.removeAttribute('data-mode');
    const _cond = $('crw-cond'); if (_cond) _cond.style.display = 'none';
    const _eb = ov.querySelector('.crw-eyebrow'); if (_eb) _eb.textContent = 'Reward · Pack';
    const _train = $('crw-train'); if (_train) _train.style.display = '';

    // flipper 초기화
    const fl = $('crw-flipper'), front = $('crw-front'), row = $('crw-row');
    fl.dataset.tier = tier;
    fl.querySelector('.tav-reveal-fx').className = 'tav-reveal-fx tier-' + tier;
    fl.classList.remove('is-revealing','is-revealed');
    row.classList.remove('revealed');
    front.innerHTML = '';
    front.appendChild(mkCard(card));

    // 헤더 / 배지
    $('crw-title').textContent = spell ? '운명의 비전을 얻었다' : '운명의 동료를 얻었다';
    const badge = $('crw-badge');
    badge.textContent = isNew ? '✦ 신규 획득' : '✦ 이미 보유';
    badge.classList.toggle('dup', !isNew);

    // 정보
    $('crw-name').textContent = card.name || card.id || '';
    const chips = $('crw-chips');
    let html = `<span class="crw-chip" style="color:${RARCOL[tier]};border-color:${RARCOL[tier]}">${RARKO[card.rarity]||RARKO.bronze}</span>`;
    html += `<span class="crw-chip">${ROLEKO[card.role]||card.role||''}</span>`;
    if (spell){
      html += `<span class="crw-chip">${DMGKO[card.dmgType]||card.dmgType||''}</span>`;
      html += `<span class="crw-chip">${card.kind==='spell-aoe'?'광역':'단일'}</span>`;
    }
    chips.innerHTML = html;

    const unitOnly = ov.querySelector('.crw-unit-only'), spellOnly = ov.querySelector('.crw-spell-only');
    if (unitOnly) unitOnly.style.display = spell ? 'none' : '';
    if (spellOnly) spellOnly.style.display = spell ? '' : 'none';

    const CIMG = (RoF.Data && RoF.Data.CARD_IMG) || {};
    if (spell){
      $('crw-ability').textContent = card.ability || '—';
      $('crw-ns').textContent = card.NEED_SOUL != null ? card.NEED_SOUL : '-';
      $('crw-sdesc').textContent = card.desc || '';
    } else {
      $('crw-owner').textContent = card.name || card.id || '';
      $('crw-desc').textContent = card.desc || '—';
      const sigHost = $('crw-sigs'); sigHost.innerHTML = '';
      (card.bundledSkillIds || []).slice(0,5).forEach(sid=>{
        const img = CIMG[sid]; if (!img) return;
        const d = document.createElement('div'); d.className = 'crw-sig'; d.style.backgroundImage = `url('${img}')`; sigHost.appendChild(d);
      });
    }

    // 액션
    const slotBtn = $('crw-slot');
    slotBtn.classList.remove('on');
    slotBtn.textContent = spell ? '＋ 비전에 넣기' : '＋ 전열에 넣기';
    slotBtn.onclick = function(){
      const on = slotBtn.classList.toggle('on');
      slotBtn.textContent = on ? (spell ? '✔ 비전 장착됨' : '✔ 전열 편성됨') : (spell ? '＋ 비전에 넣기' : '＋ 전열에 넣기');
      if (typeof opts.onSlot === 'function') try { opts.onSlot(on); } catch(_){}
    };
    $('crw-train').onclick = function(){ closeCardReward(); if (RoF.Game && RoF.Game.showTraining) try { RoF.Game.showTraining(); } catch(_){} };
    $('crw-take').onclick = function(){ closeCardReward(); if (typeof opts.onClose === 'function') try { opts.onClose(); } catch(_){} };
    $('crw-reveal').onclick = function(){ revealCardReward(); };

    ov.classList.add('is-open');
  };

  function revealCardReward(){
    const fl = $('crw-flipper'), fx = $('crw-fx'), row = $('crw-row');
    if (!fl || fl.classList.contains('is-revealed')) return;
    const tier = fl.dataset.tier;
    fx.className = 'tav-screen-fx tier-' + tier; void fx.offsetWidth; fx.classList.add('active');
    if (window.SFX && SFX.play) { (tier==='legendary'||tier==='divine') ? SFX.play('rarity_up') : SFX.play('card_reveal'); }
    fl.classList.add('is-revealing');
    setTimeout(()=>fl.classList.add('is-revealed'), 180);
    setTimeout(()=>{ fl.classList.remove('is-revealing'); fx.classList.remove('active'); row.classList.add('revealed'); }, 1900);
  }
  function closeCardReward(){ const ov = $('rof-cardreward'); if (ov) ov.classList.remove('is-open'); }
  UI.closeCardReward = closeCardReward;

  // ════════════════════════ 스킬 해금 연출 (v1 초록 · 카드보상 DOM 재사용) ════════════════════════
  // design-confirmed: 2026-06-08 사유: 갤러리 검수 후 사용자 "적용하자" (skill_unlock_reveal v1)
  UI.showSkillUnlock = function(skill, character, opts){
    opts = opts || {};
    const ov = $('rof-cardreward'); if (!ov || !skill) return;
    const tier = RARTIER[skill.rarity] || 'rare';
    ov.dataset.mode = 'unlock';

    // flipper 초기화 (showCardReward 동일)
    const fl = $('crw-flipper'), front = $('crw-front'), row = $('crw-row');
    fl.dataset.tier = tier;
    fl.querySelector('.tav-reveal-fx').className = 'tav-reveal-fx tier-' + tier;
    fl.classList.remove('is-revealing','is-revealed');
    row.classList.remove('revealed');
    front.innerHTML = '';
    front.appendChild(mkCard(skill));

    // 헤더 / 배지 (초록 = 기본 .crw-badge)
    const eb = ov.querySelector('.crw-eyebrow'); if (eb) eb.textContent = 'Level Up · Skill Unlocked';
    $('crw-title').textContent = '새로운 기술을 깨우쳤다';
    const badge = $('crw-badge'); badge.textContent = '✦ 스킬 해금'; badge.classList.remove('dup');

    // 정보 — 스킬은 spell-only 레이아웃(ability + needsoul + desc) 재사용
    $('crw-name').textContent = skill.name || skill.id || '';
    const col = RARCOL[RARTIER[skill.rarity]] || RARCOL.rare;
    let html = `<span class="crw-chip" style="color:${col};border-color:${col}">${RARKO[skill.rarity]||RARKO.bronze}</span>`;
    html += `<span class="crw-chip">${ROLEKO[skill.role]||skill.role||''}</span>`;
    if (skill.dmgType) html += `<span class="crw-chip">${DMGKO[skill.dmgType]||skill.dmgType}</span>`;
    $('crw-chips').innerHTML = html;

    const cond = $('crw-cond');
    const charName = (character && (character.name || character.id)) || '이 캐릭터';
    const ul = RoF.skillUnlockLevel ? RoF.skillUnlockLevel(skill) : (skill.unlockLevel || 1);
    if (cond){ cond.style.display = ''; cond.innerHTML = `🔓 <b>${charName} Lv ${ul}</b> 도달 — 기술 개방`; }

    const unitOnly = ov.querySelector('.crw-unit-only'), spellOnly = ov.querySelector('.crw-spell-only');
    if (unitOnly) unitOnly.style.display = 'none';
    if (spellOnly) spellOnly.style.display = '';
    $('crw-ability').textContent = skill.ability || '—';
    $('crw-ns').textContent = skill.NEED_SOUL != null ? skill.NEED_SOUL : '-';
    $('crw-sdesc').textContent = skill.desc || '';

    // 액션 — 전열 편성(active 토글) / 받기. 훈련소 버튼은 숨김.
    const slotBtn = $('crw-slot'), trainBtn = $('crw-train'), takeBtn = $('crw-take');
    const fm = RoF.Formation, charUid = character && character.uid;
    const isActive = function(){ return !!(fm && charUid && fm._isActive && fm._isActive(charUid, skill.id)); };
    const syncSlot = function(full){
      const on = isActive();
      slotBtn.classList.toggle('on', on);
      slotBtn.textContent = on ? '✔ 전열 편성됨' : (full ? '전열 가득참 (5)' : '＋ 전열 편성');
    };
    syncSlot(false);
    slotBtn.onclick = function(){
      if (!fm || !charUid || !fm.addActiveSkill) return;
      const res = fm.addActiveSkill(charUid, skill.id, !isActive());
      syncSlot(res && res.full);
      if (typeof opts.onSlot === 'function') try { opts.onSlot(isActive()); } catch(_){}
    };
    if (trainBtn) trainBtn.style.display = 'none';
    takeBtn.textContent = '받기';
    takeBtn.onclick = function(){ closeSkillUnlock(); if (typeof opts.onClose === 'function') try { opts.onClose(); } catch(_){} };
    $('crw-reveal').onclick = function(){ revealCardReward(); };

    if (window.SFX && SFX.play) SFX.play('rarity_up');
    ov.classList.add('is-open');
  };
  function closeSkillUnlock(){ closeCardReward(); _runNextJob(); }
  UI.closeSkillUnlock = closeSkillUnlock;

})();
