/* ui.js — HUD panels, role action bars, requests, comms, modals, selection. */
(function () {
  'use strict';
  const C = window.FP.Constants, B = window.FP.Balance, Net = window.FP.Net, State = window.FP.State;
  const $ = (id) => document.getElementById(id);
  let lastResources = {};
  const PERSONA_LABEL = {
    builder: 'the Builder', warmonger: 'the Warmonger', turtler: 'the Cautious', balanced: 'the Steady',
    expansionist: 'the Expansionist', cautious: 'the Careful', iron: 'the Ironmonger', relic: 'the Relic-Hunter',
    quartermaster: 'the Quartermaster', armorer: 'the Armorer', siege: 'the Siege-Smith', toolsmith: 'the Toolsmith',
    wolf: 'Wolf Banner', ironwall: 'Iron Wall', roadmarshal: 'Road Marshal', hammer: 'Hammer of Stone',
  };

  function toast(msg, bad) {
    const t = $('toast'); t.textContent = msg; t.style.borderColor = bad ? '#c8553d' : '#c4a35a';
    t.style.color = bad ? '#d46a5a' : '#e3c578'; t.classList.remove('hidden'); t.style.opacity = '1';
    clearTimeout(t._h); t._h = setTimeout(() => { t.style.opacity = '0'; setTimeout(() => t.classList.add('hidden'), 300); }, 2600);
  }

  // ---------- modal ----------
  let modalRefresh = null;     // re-render fn for the open modal (live updates), or null
  let buildTarget = null;      // remembered location for the Build modal across refreshes
  let trainTarget = null;      // remembered Barracks for the Train modal across refreshes
  function openModal(title, html, refreshFn) {
    $('modalTitle').textContent = title; $('modalBody').innerHTML = html; $('modal').classList.remove('hidden');
    modalRefresh = refreshFn || null;
  }
  function closeModal() { $('modal').classList.add('hidden'); modalRefresh = null; }
  function refreshOpenModal() {
    if (!modalRefresh || $('modal').classList.contains('hidden')) return;
    const body = $('modalBody'); const st = body.scrollTop; modalRefresh(); body.scrollTop = st;
  }

  function optRow(name, desc, cost, btnLabel, onClick, disabled, disabledReason) {
    const id = 'opt_' + Math.random().toString(36).slice(2, 8);
    setTimeout(() => { const el = $(id); if (el) el.onclick = () => { onClick(); }; }, 0);
    const reason = (disabled && disabledReason) ? disabledReason : '';
    return '<div class="opt"><div class="opt-info"><div class="opt-name">' + name + '</div>' +
      (desc ? '<div class="opt-desc">' + desc + '</div>' : '') +
      (cost ? '<div class="opt-cost">' + cost + '</div>' : '') +
      (reason ? '<div class="opt-reason">⚠ ' + reason + '</div>' : '') + '</div>' +
      '<button id="' + id + '" class="btn btn-sm" ' + (disabled ? 'disabled' : '') + (reason ? ' title="' + esc(reason) + '"' : '') + '>' + btnLabel + '</button></div>';
  }
  // Small section header for grouped modals.
  function modalSection(title) { return '<div class="rp-h">' + title + '</div>'; }
  function costStr(cost) { return Object.keys(cost).map((k) => (C.RESOURCE_META[k] ? C.RESOURCE_META[k].glyph : '') + Math.round(cost[k]) + ' ' + k).join('  '); }
  function canAfford(team, cost) { for (const k in cost) if ((team.resources[k] || 0) < cost[k]) return false; return true; }
  function armyCount(g) { let n = 0; for (const u of C.UNITS) n += g.units[u] || 0; return n; }
  function holdInfo(snap, team, key) {
    const h = team.holds && team.holds[key];
    if (!h) return null;
    const until = (typeof h === 'number') ? h : h.until;
    const active = until < 0 || until > snap.elapsed;
    if (!active) return null;
    const allow = (typeof h === 'object' && h.allow) ? h.allow : {};
    const left = until < 0 ? null : Math.ceil(until - snap.elapsed);
    const myRole = State.myRole;
    const lockedForMe = !!(myRole && myRole !== 'LORD' && !allow[myRole]);
    const owner = (typeof h === 'object' && h.owner) ? h.owner : 'LORD';
    const iOwn = !!(myRole && myRole !== 'LORD' && owner === myRole);
    return { left, allow, lockedForMe, owner, iOwn };
  }
  function grantLeft(snap, team, key, role) {
    const u = team.holdGrants && team.holdGrants[key] && team.holdGrants[key][role];
    return (typeof u === 'number' && u > snap.elapsed) ? Math.ceil(u - snap.elapsed) : 0;
  }

  // Role-aware resource tooltip: what it's for, how YOU get more, who to ask, and your use of it.
  function resourceTip(key, team, snap) {
    const role = State.myRole;
    const base = {
      food: 'FOOD — feeds your population; at 0, growth stops and army morale drops.',
      wood: 'WOOD — used for most buildings, Steward outposts, bows and arrows.',
      stone: 'STONE — used for buildings, walls and defences.',
      iron: 'IRON — used for weapons, armour and advanced buildings.',
      horses: 'HORSES — required to muster Cavalry.',
      arrows: 'ARROWS — Archers need them or they fight at half strength.',
      relics: 'RELICS — boost your Kingdom Score (the timeout tiebreaker).',
    }[key];
    const how = {
      food: { LORD: 'Get more: assign Farmers (Workers) or build a Farm.', STEWARD: 'Get more: claim Farmland and ship it home.', _: 'Get more: ask the Lord to add Farmers, or the Steward to claim Farmland.' },
      wood: { LORD: 'Get more: assign Woodcutters or build a Lumber Camp.', STEWARD: 'Get more: claim a Forest site.', _: 'Get more: ask the Lord (Woodcutters) or Steward (Forest).' },
      stone: { LORD: 'Get more: assign Miners or build a Mine.', STEWARD: 'Get more: claim a Quarry/Hills site.', _: 'Get more: ask the Lord (Miners) or Steward (Quarry).' },
      iron: { LORD: 'Get more: assign Miners, or ask the Steward to claim the Central Mine.', STEWARD: 'Get more: claim the Central Mine and ship it home.', BLACKSMITH: 'Get more: ask the Steward to claim mines — you forge gear from iron.', COMMANDER: 'Get more: ask the Steward (mines).', _: 'Get more: ask the Steward (mines).' },
      horses: { STEWARD: 'Get more: claim Horse Plains.', COMMANDER: 'Get more: ask the Steward to claim Horse Plains.', _: 'Get more: ask the Steward to claim Horse Plains.' },
      arrows: { BLACKSMITH: 'Get more: forge Arrows at the Forge.', COMMANDER: 'Get more: ask the Blacksmith to forge Arrows.', _: 'Get more: ask the Blacksmith to forge Arrows.' },
      relics: { STEWARD: 'Get more: search the Ancient Ruins.', _: 'Get more: ask the Steward to search the Ruins.' },
    }[key];
    const use = {
      LORD: { wood: 'You spend it on buildings.', stone: 'You spend it on buildings & walls.', iron: 'You spend it on advanced buildings.', food: 'Feeds your population.' },
      STEWARD: { wood: 'You spend it claiming & upgrading sites.' },
      BLACKSMITH: { iron: 'You forge weapons & armour from it.', wood: 'You forge bows & arrows from it.' },
      COMMANDER: { horses: 'Your Cavalry need horses.', arrows: 'Your Archers consume arrows in battle.' },
    }[role] || {};
    let t = base + '\n' + ((how && (how[role] || how._)) || '');
    if (use[key]) t += '\nFor you: ' + use[key];
    const hold = snap ? holdInfo(snap, team, key) : null;
    if (team) {
      const v = Math.round(team.resources[key] || 0);
      if (v >= team.storageCap) t += '\n📦 STORAGE FULL (' + v + '/' + team.storageCap + ') — surplus wasted. Build a Storehouse (+' + B.STORAGE_PER_STOREHOUSE + ' to every cap).';
    }
    if (hold && (role === 'LORD' || hold.lockedForMe)) {
      t += '\n🔒 ' + (role === 'LORD' ? 'Reserved' : 'Reserved away from you') + (hold.left == null ? '' : ' (' + hold.left + 's left)') + '.';
      t += role === 'LORD' ? '\n(Click to manage who may spend it.)' : '\n(Click to ask for access or to reserve it for yourself.)';
    } else {
      t += role === 'LORD' ? '\n(Click to ration — choose who may spend it.)' : '\n(Click to ask for more or to reserve it.)';
    }
    return t;
  }

  // ---------- top bar ----------
  function updateTop(snap) {
    const team = State.teamState(); if (!team) return;
    // Resource chips grouped by cluster.
    const bar = $('resourceBar');
    const order = ['food', 'wood', 'stone', 'iron', 'horses', 'arrows', 'relics'];
    const cap = team.storageCap;
    bar.innerHTML = order.map((k) => {
      const m = C.RESOURCE_META[k]; const v = Math.round(team.resources[k] || 0);
      const prev = lastResources[k] != null ? lastResources[k] : v;
      const trend = v > prev + 0.5 ? '▲' : v < prev - 0.5 ? '▼' : '';
      const short = (k === 'food' && v < 30) || ((k === 'wood' || k === 'iron' || k === 'stone') && v < 10);
      const hold = holdInfo(snap, team, k);
      const showLock = hold && (State.myRole === 'LORD' || hold.lockedForMe);
      const lock = showLock ? '<span class="lock">🔒' + (hold.left == null ? '' : hold.left + 's') + '</span>' : '';
      const full = v >= cap;
      const fullIcon = full ? '<span class="cap-full" title="Storage full (' + v + '/' + cap + ') — surplus is being wasted. Build a Storehouse (Lord) to raise every resource cap by ' + B.STORAGE_PER_STOREHOUSE + '.">📦⚠</span>' : '';
      return '<div class="res-chip ' + (short ? 'short' : '') + (showLock ? ' held' : '') + (full ? ' capped' : '') + '" title="' + esc(resourceTip(k, team, snap)) + '" onclick="FP.UI.chipClick(\'' + k + '\')"><span class="rg">' + m.glyph + '</span>' +
        '<span>' + v + '</span>' + fullIcon + lock + '<span class="trend">' + trend + '</span></div>';
    }).join('') +
      '<div class="res-chip" title="Population: people in your kingdom vs housing cap. Build Houses (Lord) to raise it. Soldiers &amp; recruits count toward it." style="cursor:default"><span class="rg">👤</span><span>' + team.pop.total + '/' + team.housing + '</span></div>' +
      '<div class="res-chip mil-chip" title="' + esc('Soldiers: total fighting troops across all your hosts (' + team.armies.filter((g)=>armyCount(g)>=0.5).length + ' hosts). Click for the Military Overview.') + '" onclick="FP.UI.modalMilitary()"><span class="rg">⚔️</span><span>' + team.pop.soldiers + '</span></div>' +
      '<div class="res-chip" title="' + esc('Recruits: trained citizens waiting to become soldiers. The Lord trains them via Trainers + a Barracks; the Commander musters them into units.') + '" style="cursor:default"><span class="rg">🎖️</span><span>' + Math.round(team.pop.recruits) + '</span></div>';
    lastResources = {}; for (const k of order) lastResources[k] = Math.round(team.resources[k] || 0);

    $('scoreBlue').textContent = snap.teams.BLUE.score;
    $('scoreRed').textContent = snap.teams.RED.score;
    $('phaseLabel').textContent = snap.phase;
    const left = Math.max(0, snap.matchLength - snap.elapsed);
    $('timer').textContent = Math.floor(left / 60) + ':' + String(Math.floor(left % 60)).padStart(2, '0');

    // Objective + threat.
    const enemy = snap.teams[State.enemyTeam()];
    const obj = snap.phase === 'EARLY' ? 'Early game: explore, claim sites, raise your economy & a Barracks.'
      : snap.phase === 'MID' ? 'Mid game: forge gear, muster an army, protect caravans, raid the foe.'
        : 'Late game: build siege, mass your host, and break the enemy Keep!';
    $('objText').textContent = obj;
    const myKeep = team.keep.hp, enemyKeep = enemy.keep.hp;
    let threat = '';
    const occ = enemyNear(snap);
    if (occ) threat = '⚠ Enemy forces at ' + snap.areas[occ].name + '!';
    else if (myKeep < team.keep.maxHp * 0.6) threat = '⚠ Your Keep is under threat (' + Math.round(myKeep) + ' HP)';
    $('threatText').textContent = threat;
  }

  function enemyNear(snap) {
    const me = State.myTeam, foe = State.enemyTeam();
    for (const g of snap.teams[foe].armies) {
      const a = g.moving ? g.moving.route[g.moving.legIndex] : g.area;
      if (snap.areas[a] && snap.areas[a].owner === me) return a;
    }
    return null;
  }

  // ---------- left: requests / comms / log ----------
  function updateLeft(snap) {
    const team = State.teamState(); if (!team) return;
    // Requests addressed to my role + my outgoing.
    const incoming = team.requests.filter((r) => r.status === 'open' && r.targetRole === State.myRole);
    const mine = team.requests.filter((r) => r.fromRole === State.myRole).slice(-4).reverse();
    $('reqCount').textContent = incoming.length;
    let html = '';
    for (const r of incoming) {
      html += '<div class="req-card incoming"><div><span class="rq-from">' + esc(r.fromName) + '</span> asks: ' +
        reqText(r) + '</div><div class="rq-btns">' +
        '<button class="btn btn-sm" onclick="FP.UI.resolveReq(\'' + r.id + '\',true)">Accept</button>' +
        '<button class="btn btn-sm" onclick="FP.UI.resolveReq(\'' + r.id + '\',false)">Decline</button></div></div>';
    }
    if (!incoming.length) html += '<div class="muted" style="padding:10px">No requests need your attention right now.</div>';
    if (mine.length) { html += '<div class="rp-h">Your asks</div>'; for (const r of mine) html += '<div class="req-card"><span class="rq-from">→ ' + C.ROLE_META[r.targetRole].name + '</span>: ' + reqText(r) + ' <span class="muted">(' + r.status + ')</span>' + (r.status === 'open' ? ' <button class="btn btn-sm" onclick="FP.UI.cancelReq(\'' + r.id + '\')">Cancel</button>' : '') + '</div>'; }
    $('tab-requests').innerHTML = html;

    // Comms.
    const cl = $('commsList');
    cl.innerHTML = team.comms.slice(-40).map((m) => {
      const badge = m.isAI ? '<span class="badge badge-ai">🤖</span>' : '<span class="badge badge-h">👤</span>';
      return '<div class="comms-msg ' + (m.kind || '') + '">' + badge + ' <span class="cm-name">' + m.fromName + '</span>: ' + esc(m.text) + '</div>';
    }).join('');
    cl.scrollTop = cl.scrollHeight;

    // Log.
    const ll = $('logList');
    ll.innerHTML = snap.events.slice(-40).reverse().map((e) =>
      '<div class="log-line ' + (e.kind || '') + '"><span style="color:' + (e.team === 'BLUE' ? '#8fb8e8' : e.team === 'RED' ? '#d46a5a' : '#a3936f') + '">●</span> ' + esc(e.text) + '</div>').join('');
  }
  function useReason(k) {
    const role = State.myRole;
    const map = {
      BLACKSMITH: { iron: 'to forge weapons & armour', wood: 'to forge bows & arrows', stone: '' },
      STEWARD: { wood: 'to claim & build outposts' },
      COMMANDER: { horses: 'to muster cavalry', arrows: 'to arm archers' },
    };
    return (map[role] && map[role][k]) || 'I need it for my work';
  }
  function reqText(r) {
    const t = typeof r === 'string' ? r : r.type;
    const pl = (typeof r === 'object' && r.payload) || {};
    const resG = (k) => { const m = C.RESOURCE_META[k]; return m ? m.glyph + ' ' + k : k; };
    if (t === 'NEED') { const res = pl.resource || 'resources'; return 'send more ' + resG(res); }
    if (t === 'USE') { const res = pl.resource || 'a resource'; return 'access to spend ' + resG(res) + (pl.reason ? ' — ' + pl.reason : ''); }
    if (t === 'RESERVE') { const res = pl.resource || 'a resource'; return 'reserve ' + resG(res) + ' for them' + (pl.reason ? ' — ' + pl.reason : ''); }
    if (t === 'BUILD') { const def = pl.type && B.BUILDINGS[pl.type]; return 'build ' + (def ? buildGlyph(pl.type) + ' ' + def.name : 'a building'); }
    if (t === 'WORKERS') { return pl.job ? 'shift workers to ' + cap(pl.job) : 'send workers'; }
    if (t === 'EQUIPMENT') { const m = pl.item && C.EQUIP_META[pl.item]; return 'forge ' + (m ? m.glyph + ' ' + m.name : 'equipment'); }
    if (t === 'TRAIN') { const m = pl.unitType && C.UNIT_META[pl.unitType]; return 'train ' + (pl.count ? pl.count + ' ' : '') + (m ? m.glyph + ' ' + m.name : 'troops'); }
    if (t === 'MISSION') { return ({ raid: '⚔️ raid the enemy', siege: '🏰 siege the enemy Keep' })[pl.mission] || 'take the offensive'; }
    if (t === 'DEFEND') { const a = pl.area && State.snapshot && State.snapshot.areas[pl.area]; return 'defend ' + (a ? a.name : 'our land'); }
    if (t === 'SITE') { return pl.mode === 'upgrade' ? 'upgrade our best site' : 'claim a new site'; }
    return ({ ESCORT: 'escort a caravan', GUARDS: 'lend caravan guards', IRON: 'push iron to the forge', RECRUITS: 'levy recruits', TRAINERS: 'assign Trainers at a Barracks' })[t] || t;
  }
  // Combat-effect summaries for formation/stance multipliers (for the Commander's clarity).
  function fxPct(m) { return (m >= 1 ? '+' : '') + Math.round((m - 1) * 100) + '%'; }
  function formationFx(f) { const x = B.FORMATIONS[f]; if (!x) return ''; const p = []; if (x.atkMult && x.atkMult !== 1) p.push('atk ' + fxPct(x.atkMult)); if (x.defMult && x.defMult !== 1) p.push('def ' + fxPct(x.defMult)); if (x.speedMult && x.speedMult !== 1) p.push('spd ' + fxPct(x.speedMult)); return p.join(', ') || 'no modifiers'; }
  function stanceFx(s) { const x = B.STANCES[s]; if (!x) return ''; const p = []; if (x.atkMult && x.atkMult !== 1) p.push('atk ' + fxPct(x.atkMult)); if (x.defMult && x.defMult !== 1) p.push('def ' + fxPct(x.defMult)); if (x.lossMult && x.lossMult !== 1) p.push('losses ' + fxPct(x.lossMult)); return p.join(', ') || 'no modifiers'; }
  // Short tactical role/counter hint per unit type (for the Train screen).
  const UNIT_HINT = { militia: 'cheap fodder — fills ranks fast', spearman: 'counters 🐎 cavalry', swordsman: 'durable frontline melee', archer: 'ranged — needs 🏹 arrows to fight full strength', cavalry: 'fast flanker — counters 🏹 archers', catapult: 'wrecks 🏰 Keeps & walls (needs Workshop)' };

  // ---------- pause / vote overlay ----------
  function updatePause(snap) {
    const pause = snap.pause || { active: false, vote: null, cooldownSec: {} };
    const ov = $('pauseOverlay'); const card = $('pauseCard');
    const me = State.you;
    const iVoted = pause.vote && pause.vote.votes && pause.vote.votes[me] !== undefined;
    // Pause button state (top bar) — spectators can't pause/resume/vote, so hide their controls.
    const btn = $('pauseBtn');
    if (btn) {
      if (State.isSpectator) { btn.style.display = 'none'; }
      else {
        const cd = pause.cooldownSec && pause.cooldownSec[me];
        if (pause.active) { btn.textContent = '▶ Resume'; btn.disabled = false; }
        else if (cd) { btn.textContent = '⏸ ' + cd + 's'; btn.disabled = true; }
        else { btn.textContent = '⏸ Pause'; btn.disabled = !!pause.vote; }
      }
    }
    if (pause.vote) {
      const v = pause.vote;
      ov.classList.remove('hidden');
      let html = '<div class="pause-h">🗳 Vote to ' + (v.kind === 'pause' ? 'Pause' : 'Resume') + '</div>' +
        '<div class="pause-sub">' + esc(v.initiatorName) + ' called the vote · <b>' + v.endsInSec + 's</b> left</div>' +
        '<div class="pause-tally"><span class="yes">👍 ' + (v.yes || 0) + '</span> <span class="no">👎 ' + (v.no || 0) + '</span> <span class="muted">of ' + v.humansCount + '</span></div>';
      if (State.isSpectator) html += '<div class="muted">👁 The council is voting…</div>';
      else if (iVoted) html += '<div class="muted">You voted. Waiting for others…</div>';
      else html += '<div class="pause-btns"><button class="btn btn-gold" onclick="FP.UI.vote(true)">Vote Yes</button><button class="btn" onclick="FP.UI.vote(false)">Vote No</button></div>';
      card.innerHTML = html;
    } else if (pause.active) {
      ov.classList.remove('hidden');
      const solo = (pause.humansCount || 1) <= 1;
      card.innerHTML = '<div class="pause-h">⏸ Paused</div>' +
        '<div class="pause-sub">The realm holds its breath.</div>' +
        (State.isSpectator ? '' : '<div class="pause-btns"><button class="btn btn-gold" onclick="FP.UI.resume()">' + (solo ? '▶ Resume' : '▶ Call Resume Vote') + '</button></div>');
    } else {
      ov.classList.add('hidden');
    }
  }

  // ---------- guide / advisor ----------
  function updateGuide(snap) {
    if (!window.FP.Tips || !State.myRole) return;
    const g = window.FP.Tips.compute(snap, State);
    // Proactive advisor card (always visible, top of right panel) = the single most useful action.
    const adv = $('advisor');
    const primary = g.tips[0];
    if (primary) {
      adv.innerHTML = '<div class="adv-h">🧙 Advisor</div>' +
        '<div class="adv-tip">' + esc(primary.text) + '</div>' +
        '<div class="adv-why">' + esc(primary.because) + '</div>' +
        (primary.call ? '<button class="btn btn-gold btn-sm" onclick="' + primary.call + '">' + esc(primary.label) + '</button>' : '') +
        ' <button class="btn btn-sm" onclick="FP.UI.showTab(\'guide\')">More tips</button>';
    }
    // Full Guide tab.
    let html = '<div class="guide-mission">' + esc(g.mission) + '</div>';
    html += '<div class="guide-summary">' + g.summary.map((s) =>
      '<div class="gs-row"><span class="gs-l">' + s.label + '</span><span class="gs-v ' + (s.tone || '') + '">' + esc(s.value) + '</span></div>').join('') + '</div>';
    html += '<div class="guide-h">What you can do now</div>';
    html += g.tips.map((t, i) => '<div class="guide-tip' + (i === 0 ? ' primary' : '') + '">' +
      '<div class="gt-text">' + (i === 0 ? '⭐ ' : '') + esc(t.text) + '</div>' +
      '<div class="gt-why">' + esc(t.because) + '</div>' +
      (t.call ? '<button class="btn btn-sm" onclick="' + t.call + '">' + esc(t.label) + '</button>' : '') + '</div>').join('');
    $('guideContent').innerHTML = html;
  }

  function updateRight(snap) {
    const team = State.teamState();
    renderSelection(snap);
    // Team council cards (both teams shown, your team first; spectators see both equally).
    let html = '';
    const teams = State.isSpectator ? ['BLUE', 'RED'] : [State.myTeam, State.enemyTeam()];
    for (const tm of teams) {
      const slots = snap.teams[tm].slots;
      html += '<div class="muted" style="padding:2px 2px 4px">' + C.TEAM_META[tm].name + '</div>';
      for (const role of C.ROLE_ORDER) {
        const sl = slots[role]; const meta = C.ROLE_META[role];
        const persona = sl.controller === 'ai' && snap.teams[tm].aiPersona && snap.teams[tm].aiPersona[role];
        const badge = sl.controller === 'human' ? '<span class="badge-h">👤</span>' : '<span class="badge-ai">🤖</span>';
        const isMe = tm === State.myTeam && role === State.myRole;
        const pname = persona ? ' <span class="muted" style="font-size:10px">' + (PERSONA_LABEL[persona] || persona) + '</span>' : '';
        const asks = (snap.teams[tm].requests || []).filter((r) => r.status === 'open' && r.targetRole === role).length;
        const askBadge = asks ? ' <span class="tc-asks" title="' + asks + ' open request' + (asks > 1 ? 's' : '') + ' awaiting this role">✉ ' + asks + '</span>' : '';
        html += '<div class="tc ' + tm.toLowerCase() + '"><span class="tc-glyph">' + meta.glyph + '</span>' +
          '<div class="tc-info"><div>' + badge + ' ' + meta.name + (isMe ? ' <b style="color:#e3c578">(you)</b>' : '') + pname + askBadge + '</div>' +
          '<div class="tc-task">' + roleTask(snap.teams[tm], role) + '</div></div></div>';
      }
    }
    $('teamCards').innerHTML = html;
  }

  function roleTask(team, role) {
    if (role === 'LORD') return 'Pop ' + team.pop.total + ' · ' + (team.buildQueue.length ? 'building…' : 'managing') + (team.policy ? ' · ' + B.POLICIES[team.policy].name : '');
    if (role === 'STEWARD') {
      const g = team.gather; const tools = g ? (g.effective.food + g.effective.wood + g.effective.mine) : 0;
      const focus = g ? Math.round(g.mineIronFocus * 100) : 40;
      return team._busyJob ? (team._busyJob.kind === 'explore' ? 'scouting…' : 'claiming…') : ('⛏️ 🛠️' + tools + ' tooled · iron ' + focus + '% · ' + team.caravans.length + ' caravans');
    }
    if (role === 'BLACKSMITH') return team.production.length ? 'forging ' + team.production[0].item : (team.contract ? team.contract.name : 'idle forge');
    if (role === 'COMMANDER') return team.pop.soldiers + ' soldiers · ' + team.armies.length + ' hosts';
    return '';
  }

  function renderSelection(snap) {
    const el = $('selDetails');
    const id = State.selectedArea;
    if (!id || !snap.areas[id]) { el.innerHTML = '<div class="muted">Click a map area to inspect it. Owned areas show their buildings here.</div>'; return; }
    const a = snap.areas[id];
    const mine = a.owner === State.myTeam;
    const revealed = !State.myTeam || (a.revealed && a.revealed[State.myTeam]);
    const ownerLabel = a.owner ? (mine ? '<b style="color:' + (State.myTeam === 'RED' ? '#d46a5a' : '#8fb8e8') + '">Yours</b>' : C.TEAM_META[a.owner].name) : 'Neutral';
    let html = '<div class="sel-title">' + (a.terrain === 'base' ? '♜ ' : '') + a.name + '</div>';
    html += '<div class="sel-row"><span>Owner</span><span>' + ownerLabel + '</span></div>';
    html += '<div class="sel-row"><span>Terrain</span><span>' + a.terrain + '</span></div>';
    if (!revealed) { html += '<div class="muted" style="margin-top:6px">Unexplored — scout it to reveal what is here.</div>'; el.innerHTML = html + selActions(snap, a, revealed); return; }
    if (a.resource) html += '<div class="sel-row"><span>Resource</span><span>' + (C.RESOURCE_META[a.resource] ? C.RESOURCE_META[a.resource].glyph + ' ' + a.resource : a.resource) + '</span></div>';
    if (a.site) html += '<div class="sel-row"><span>Outpost</span><span>' + (a.claimedBy ? 'Lv ' + a.site.level + ' · cargo ' + Math.round(a.site.cargo) : 'unclaimed') + '</span></div>';
    // Capture risk.
    if (a.captureProgress > 0 && a.terrain !== 'base') {
      const need = (B.CAPTURE_TIME_BASE + (a.buildings.walls || 0) * B.SITE_WALL_RESIST);
      html += '<div class="sel-row"><span style="color:#d46a5a">⚠ Being captured</span><span style="color:#d46a5a">' + Math.round(a.captureProgress) + '/' + need + 's</span></div>';
    }
    // Buildings HERE (per-location) — the key clarity fix.
    const used = slotsAt(a);
    if (a.owner) {
      html += '<div class="sel-buildings"><div class="sb-head">🏛️ Buildings here — <b>' + used + '/' + a.maxBuildings + ' slots</b>' + (used >= a.maxBuildings ? ' <span style="color:#d9a441">FULL</span>' : '') + '</div>';
      const list = Object.keys(a.buildings).filter((t) => a.buildings[t] > 0);
      html += list.length ? '<div class="sb-list">' + list.map((t) => '<span class="sb-pip">' + B.BUILDINGS[t].name + (a.buildings[t] > 1 ? ' ×' + a.buildings[t] : '') + '</span>').join('') + '</div>' : '<div class="muted" style="font-size:11px">No buildings yet.</div>';
      html += '<div class="muted" style="font-size:10px;margin-top:3px">Effects help the whole kingdom, but these are razed if this place is captured.</div></div>';
    }
    // Forces present.
    const hosts = [];
    for (const tm of ['BLUE', 'RED']) for (const g of snap.teams[tm].armies) { const ga = g.moving ? null : g.area; if (ga === id) { let n = 0; for (const u of C.UNITS) n += g.units[u] || 0; if (n >= 0.5) hosts.push((tm === 'BLUE' ? '🟦' : '🟥') + ' ' + g.name + ' (' + Math.round(n) + ')'); } }
    if (hosts.length) html += '<div class="sel-row"><span>Forces</span><span>' + hosts.join(', ') + '</span></div>';
    el.innerHTML = html + selActions(snap, a, revealed);
  }
  function slotsAt(a) { let n = 0; for (const t in a.buildings) n += a.buildings[t]; return n; }

  // Role-contextual buttons for the selected area.
  function selActions(snap, a, revealed) {
    if (State.isSpectator || !State.myRole) return '';   // spectators inspect only — no actions
    const role = State.myRole; const team = State.teamState(); let btns = '';
    const btn = (label, fn, dis) => '<button class="btn btn-sm" ' + (dis ? 'disabled' : '') + ' onclick="' + fn + '">' + label + '</button>';
    if (role === 'STEWARD') {
      const adj = a.connections.some((n) => snap.areas[n].revealed && snap.areas[n].revealed[State.myTeam]);
      if (!revealed) btns += btn('Scout', "FP.UI.act('explore',{areaId:'" + a.id + "'})", !adj);
      else {
        if (a.site && (!a.owner || (a.owner === State.myTeam && a.claimedBy !== State.myTeam))) btns += btn(claimLabel(a), "FP.UI.act('claim',{areaId:'" + a.id + "'})");
        if (a.site && a.claimedBy === State.myTeam) { btns += btn('Upgrade', "FP.UI.act('upgradeSite',{areaId:'" + a.id + "'})"); btns += btn('Abandon', "FP.UI.act('abandon',{areaId:'" + a.id + "'})"); }
      }
    }
    if (role === 'LORD' && a.owner === State.myTeam) {
      const full = slotsAt(a) >= a.maxBuildings;
      btns += btn(full ? 'Location full' : '🏗️ Build here', "FP.UI.modalBuild('" + a.id + "')", full);
    }
    if (role === 'COMMANDER' && revealed) {
      const gid = State.selectedGroupId || garrisonId(team);
      const gg = team.armies.find((x) => x.id === gid);
      const who = gg ? gg.name : 'Home Garrison';
      btns += btn('March ' + who + ' here', "FP.UI.commandSel('garrison','" + a.id + "')");
      if (a.owner === State.enemyTeam() || (!a.owner && a.site)) btns += btn('Raid with ' + who, "FP.UI.commandSel('raid','" + a.id + "')");
    }
    // Anyone can ping/request defense at an owned area.
    if (revealed && a.owner === State.myTeam) btns += btn('Ask defend', "FP.UI.requestDefend('" + a.id + "')");
    if (role === 'COMMANDER') {
      btns += '<div style="width:100%;margin-top:6px" class="muted">Your hosts (click to select target):</div>';
      for (const g of team.armies) { let n = 0; for (const u of C.UNITS) n += g.units[u] || 0; if (n < 0.5) continue;
        const sel = State.selectedGroupId === g.id ? 'border-color:#c4a35a;' : '';
        btns += '<button class="btn btn-sm" style="' + sel + '" onclick="FP.UI.selectGroup(\'' + g.id + '\')">' + g.name + ' (' + Math.round(n) + ')</button>'; }
    }
    return btns ? '<div class="sel-actions">' + btns + '</div>' : '';
  }
  function garrisonId(team) { const g = team.armies.find((a) => a.isGarrison); return g ? g.id : null; }

  // ---------- action bar (per role) ----------
  function buildActionBar() {
    const role = State.myRole; $('roleTitle').textContent = C.ROLE_META[role].glyph + ' ' + C.ROLE_META[role].name;
    const ab = $('actionButtons'); const mk = (ico, label, sub, fn) =>
      '<button class="btn" onclick="' + fn + '"><span class="ab-ico">' + ico + '</span><span>' + label + '</span><span class="ab-sub">' + sub + '</span></button>';
    let html = '';
    if (role === 'LORD') html = mk('🏗️', 'Build', 'structures', 'FP.UI.modalBuild()') + mk('👷', 'Workers', 'assign jobs', 'FP.UI.modalWorkers()') + mk('📜', 'Policy', 'kingdom tempo', 'FP.UI.modalPolicy()') + mk('⚔️', 'Stance', 'military posture', 'FP.UI.modalMilitaryPolicy()') + mk('🔒', 'Rationing', 'hold resources', 'FP.UI.modalRationing()');
    else if (role === 'STEWARD') html = mk('⛏️', 'Labor', 'crews & tools', 'FP.UI.modalGather()') + mk('🧭', 'Sites', 'outposts', 'FP.UI.modalSites()') + mk('🐎', 'Caravans', 'shipments', 'FP.UI.modalCaravans()') + mk('🗺️', 'Expeditions', 'big ventures', 'FP.UI.modalExpeditions()') + mk('👷', 'Workers', 'assign jobs', 'FP.UI.modalWorkers()') + mk('🛡️', 'Ask Escort', 'from Commander', "FP.UI.request('ESCORT')");
    else if (role === 'BLACKSMITH') html = mk('🔨', 'Forge', 'gear & arrows', 'FP.UI.modalForge()') + mk('📋', 'Contracts', 'timed bonus', 'FP.UI.modalContracts()') + mk('⚙️', 'Specialize', 'forge path', 'FP.UI.modalSpec()');
    else if (role === 'COMMANDER') html = mk('🪖', 'Train', 'recruits→troops', 'FP.UI.modalMuster()') + mk('🚩', 'Army', 'manage & orders', 'FP.UI.modalArmyManage()') + mk('🎖️', 'Doctrine', 'army & form', 'FP.UI.modalDoctrine()');
    ab.innerHTML = html;

    // Quick-ask bar — only requests that make sense FOR THIS ROLE (things other roles provide).
    const ask = (ico, label, fn) => '<button class="btn" onclick="' + fn + '">' + ico + ' ' + label + '</button>';
    let q = '';
    const lordG = C.ROLE_META.LORD.glyph, stG = C.ROLE_META.STEWARD.glyph, smG = C.ROLE_META.BLACKSMITH.glyph, cmG = C.ROLE_META.COMMANDER.glyph;
    if (role === 'LORD') {
      q = ask('🔒', 'Hold Resources', 'FP.UI.modalRationing()') +
          ask(stG, 'Ask the Steward', 'FP.UI.modalStewardRequests()') +
          ask(cmG, 'Ask the Commander', 'FP.UI.modalCommanderRequests()') +
          ask(smG, 'Ask the Blacksmith', 'FP.UI.modalBlacksmithRequests()');
    } else if (role === 'STEWARD') {
      q = ask(lordG, 'Ask the Lord', 'FP.UI.modalLordRequests()') +
          ask(cmG, 'Ask the Commander', 'FP.UI.modalCommanderRequests()') +
          ask(smG, 'Ask the Blacksmith', 'FP.UI.modalBlacksmithRequests()');
    } else if (role === 'BLACKSMITH') {
      q = ask(lordG, 'Ask the Lord', 'FP.UI.modalLordRequests()') +
          ask(stG, 'Ask the Steward', 'FP.UI.modalStewardRequests()') +
          ask(cmG, 'Ask the Commander', 'FP.UI.modalCommanderRequests()');
    } else if (role === 'COMMANDER') {
      q = ask(lordG, 'Ask the Lord', 'FP.UI.modalLordRequests()') +
          ask(stG, 'Ask the Steward', 'FP.UI.modalStewardRequests()') +
          ask(smG, 'Ask the Blacksmith', 'FP.UI.modalBlacksmithRequests()');
    }
    $('quickReq').innerHTML = q;
  }

  // Request more of any single resource (routed to whichever OTHER role can best supply it).
  function modalNeed() {
    const team = State.teamState(); const role = State.myRole;
    let html = '<div class="muted">Ask a teammate (human or 🤖 AI) to prioritise a resource. NPCs answer automatically.</div>';
    const list = ['food', 'wood', 'stone', 'iron', 'horses', 'arrows', 'relics'];
    for (const k of list) {
      const m = C.RESOURCE_META[k];
      const suppliers = (C.RESOURCE_SUPPLIERS && C.RESOURCE_SUPPLIERS[k]) || ['LORD'];
      const target = suppliers.find((r) => r !== role);
      const targetLabel = target ? 'goes to the ' + C.ROLE_META[target].name : 'broadcast to your council';
      const youMake = suppliers[0] === role;
      html += optRow(m.glyph + ' ' + m.name + ' <span class="muted">(have ' + Math.round(team.resources[k] || 0) + ')</span>',
        youMake ? 'You are the main supplier of this — ' + targetLabel : targetLabel, '', youMake ? 'Broadcast' : 'Request more',
        () => { Net.action('request', { type: 'NEED', payload: { resource: k } }); toast('Asked for more ' + k + '.'); closeModal(); });
    }
    openModal('Need a Resource', html, modalNeed);
  }

  // ---- Lord "council request" modals: capability-relevant asks for each teammate role. ----
  function sendReq(type, payload, msg) { Net.action('request', { type, payload: payload || {} }); toast(msg || 'Request sent to your council.'); }
  function ownedThreatList() {
    const snap = State.snapshot, foe = State.enemyTeam(); const out = [];
    const enemyAt = {};
    for (const gx of snap.teams[foe].armies) { const a = gx.moving ? gx.moving.route[gx.moving.legIndex] : gx.area; if (armyCount(gx) >= 0.5) enemyAt[a] = true; }
    for (const id in snap.areas) { const a = snap.areas[id]; if (a.owner !== State.myTeam || a.terrain === 'base') continue;
      const threatened = enemyAt[id] || a.connections.some((n) => enemyAt[n]);
      if (threatened) out.push(a); }
    return out;
  }
  function modalStewardRequests() {
    const team = State.teamState();
    let html = '<div class="muted">Ask your ' + C.ROLE_META.STEWARD.glyph + ' Steward (human or 🤖 AI). They answer automatically.</div>';
    html += modalSection('Secure resources');
    const secure = [['iron', 'mines & the central deposit'], ['horses', 'Horse Plains for cavalry'], ['stone', 'hills & quarries'], ['food', 'farmland'], ['wood', 'forests']];
    for (const [k, why] of secure) { const m = C.RESOURCE_META[k];
      html += optRow(m.glyph + ' Secure ' + m.name + ' <span class="muted">(have ' + Math.round(team.resources[k] || 0) + ')</span>', 'Steward prioritises ' + why, '', 'Request',
        () => sendReq('NEED', { resource: k }, 'Asked the Steward to secure ' + k + '.')); }
    html += modalSection('Expand the realm');
    const ownsSite = Object.values(State.snapshot.areas).some((a) => a.claimedBy === State.myTeam && a.terrain !== 'base');
    html += optRow('🧭 Claim a new site', 'Steward scouts & claims the best available site (income + build slots)', '', 'Request',
      () => sendReq('SITE', { mode: 'expand' }, 'Asked the Steward to expand.'));
    html += optRow('⬆️ Upgrade our best site', 'Higher-level sites ship more resources home', '', 'Request',
      () => sendReq('SITE', { mode: 'upgrade' }, 'Asked the Steward to upgrade a site.'), !ownsSite, ownsSite ? '' : 'No claimed sites yet');
    html += optRow('🏛️ Search the Ruins (relics)', 'Relics raise your Kingdom Score', '', 'Request',
      () => sendReq('NEED', { resource: 'relics' }, 'Asked the Steward to seek relics.'));
    openModal(C.ROLE_META.STEWARD.glyph + ' Ask the Steward', html, modalStewardRequests);
  }
  function modalCommanderRequests() {
    const team = State.teamState(); const snap = State.snapshot;
    const hasArmy = team.armies.some((g) => armyCount(g) >= 0.5);
    const home = State.myTeam === 'BLUE' ? 'blue_base' : 'red_base';
    let html = '<div class="muted">Ask your ' + C.ROLE_META.COMMANDER.glyph + ' Commander (human or 🤖 AI). They answer automatically.</div>';
    html += modalSection('Defense');
    html += optRow('🏰 Defend the Keep', 'Bring the host home to guard the Keep', '', 'Request',
      () => sendReq('DEFEND', { area: home }, 'Asked the Commander to defend the Keep.'));
    for (const a of ownedThreatList()) html += optRow('🛡️ Defend ' + a.name, 'An enemy host threatens this owned location', '', 'Request',
      () => sendReq('DEFEND', { area: a.id }, 'Asked the Commander to defend ' + a.name + '.'));
    html += optRow('🐎 Escort our caravans', 'Protect Steward shipments from ambush', '', 'Request',
      () => sendReq('ESCORT', {}, 'Asked the Commander to escort caravans.'));
    html += optRow('🛡 Lend caravan guards', 'Spare militia/recruits the Steward stations at posts to defend caravans', '', 'Request',
      () => sendReq('GUARDS', { count: B.GUARD_LEND_DEFAULT }, 'Asked the Commander to lend guards.'));
    html += modalSection('Offense');
    html += optRow('⚔️ Raid enemy land', 'Strike the enemy\'s claimed sites to weaken them', '', 'Request',
      () => sendReq('MISSION', { mission: 'raid' }, 'Asked the Commander to raid.'), !hasArmy, hasArmy ? '' : 'No army yet');
    html += optRow('🏰 Siege the enemy Keep', 'Send the strongest host to break their Keep', '', 'Request',
      () => sendReq('MISSION', { mission: 'siege' }, 'Asked the Commander to siege.'), !hasArmy, hasArmy ? '' : 'No army yet');
    html += modalSection('Build the army');
    const units = [['spearman', {}], ['swordsman', {}], ['archer', {}], ['cavalry', { stables: 1 }], ['catapult', { workshop: 1 }]];
    for (const [u, reqB] of units) { const m = C.UNIT_META[u];
      let reason = '';
      if (reqB.stables && (team.buildings.stables || 0) <= 0) reason = 'Needs Stables';
      if (reqB.workshop && (team.buildings.workshop || 0) <= 0) reason = 'Needs Workshop';
      if (!reason && (team.buildings.barracks || 0) <= 0) reason = 'Needs a Barracks';
      html += optRow(m.glyph + ' Train ' + m.name, 'Commander trains these at a Barracks (Lord supplies recruits + gear)', '', 'Request',
        () => sendReq('TRAIN', { unitType: u, count: 3 }, 'Asked the Commander to train ' + m.name + '.'), !!reason, reason); }
    openModal(C.ROLE_META.COMMANDER.glyph + ' Ask the Commander', html, modalCommanderRequests);
  }
  function modalBlacksmithRequests() {
    const team = State.teamState();
    let html = '<div class="muted">Ask your ' + C.ROLE_META.BLACKSMITH.glyph + ' Blacksmith (human or 🤖 AI). They answer automatically.</div>';
    html += modalSection('Forge equipment');
    const gear = ['tools', 'spears', 'swords', 'bows', 'armor', 'siegeParts'];
    for (const item of gear) { const m = C.EQUIP_META[item];
      const reason = (item === 'siegeParts' && (team.buildings.workshop || 0) <= 0) ? 'Needs a Workshop' : '';
      html += optRow(m.glyph + ' Forge ' + m.name + ' <span class="muted">(have ' + Math.round((team.equipment && team.equipment[item]) || 0) + ')</span>', m.desc, '', 'Request',
        () => sendReq('EQUIPMENT', { item }, 'Asked the Blacksmith to forge ' + m.name + '.'), !!reason, reason); }
    html += modalSection('Supply');
    html += optRow('🏹 Forge Arrows <span class="muted">(have ' + Math.round(team.resources.arrows || 0) + ')</span>', 'Archers fight at half strength without arrows', '', 'Request',
      () => sendReq('NEED', { resource: 'arrows' }, 'Asked the Blacksmith for arrows.'));
    openModal(C.ROLE_META.BLACKSMITH.glyph + ' Ask the Blacksmith', html, modalBlacksmithRequests);
  }
  function modalLordRequests() {
    const team = State.teamState(), snap = State.snapshot;
    let html = '<div class="muted">Ask your ' + C.ROLE_META.LORD.glyph + ' Lord (human or 🤖 AI). They answer automatically.</div>';
    html += modalSection('Manpower');
    html += optRow('🎖️ Levy recruits', 'Lord commits idle workers to the army as recruits', '', 'Request',
      () => sendReq('RECRUITS', {}, 'Asked the Lord to levy recruits.'));
    html += optRow('🪖 Assign Trainers <span class="muted">(have ' + (team.pop.trainers || 0) + ')</span>', 'Lord assigns workers as Trainers at a Barracks so you can train troops faster', '', 'Request',
      () => sendReq('TRAINERS', {}, 'Asked the Lord to assign Trainers.'));
    const jobs = [['miners', 'Mining (stone & iron)'], ['farmers', 'Farming (food)'], ['woodcutters', 'Woodcutting (wood)']];
    for (const [job, label] of jobs) html += optRow('👷 More ' + label, 'Lord shifts idle workers to ' + label, '', 'Request',
      () => sendReq('WORKERS', { job }, 'Asked the Lord for more ' + job + '.'));
    html += modalSection('Resources the Lord supplies');
    for (const k of ['food', 'wood', 'stone']) { const m = C.RESOURCE_META[k];
      html += optRow(m.glyph + ' Need ' + m.name + ' <span class="muted">(have ' + Math.round(team.resources[k] || 0) + ')</span>', 'Lord assigns workers to produce more ' + k, '', 'Request',
        () => sendReq('NEED', { resource: k }, 'Asked the Lord for more ' + k + '.')); }
    html += modalSection('Construction');
    const buildAsk = ['barracks', 'storehouse', 'school', 'stables', 'workshop', 'walls', 'house', 'farm', 'lumberCamp', 'mine'];
    for (const type of buildAsk) { const def = B.BUILDINGS[type]; if (!def) continue;
      const have = (team.buildings && team.buildings[type]) || 0;
      html += optRow(buildGlyph(type) + ' Build ' + def.name + ' <span class="muted">(have ' + have + ')</span>', effectDesc(type) + ' · ' + costStr(def.cost), '', 'Request',
        () => sendReq('BUILD', { type }, 'Asked the Lord to build a ' + def.name + '.')); }
    const held = ['food', 'wood', 'stone', 'iron', 'horses', 'arrows'].filter((k) => holdInfo(snap, team, k));
    if (held.length) {
      html += modalSection('Held resources (ask permission)');
      for (const k of held) { const m = C.RESOURCE_META[k];
        html += optRow('🔒 Spend ' + m.name, 'Ask the Lord for a one-time pass to spend held ' + k, '', 'Ask',
          () => sendReq('USE', { resource: k, reason: useReason(k) }, 'Asked the Lord to allow ' + k + '.')); }
    }
    openModal(C.ROLE_META.LORD.glyph + ' Ask the Lord', html, modalLordRequests);
  }

  // Lord-only: per-player rationing. Choose which roles may spend each resource (you're always allowed).
  function modalRationing() {
    const snap = State.snapshot, team = State.teamState();
    let html = '<div class="muted">As Lord you control the treasury. <b>Reserve</b> a resource and pick exactly which of your council may spend it — you are always allowed. Blocked teammates can ask you for access or to reserve it for themselves.</div>';
    const list = ['food', 'wood', 'stone', 'iron', 'horses', 'arrows'];
    const ROLES = [['STEWARD', '🧭'], ['BLACKSMITH', '🔨'], ['COMMANDER', '⚔️']];
    for (const k of list) {
      const m = C.RESOURCE_META[k]; const hold = holdInfo(snap, team, k);
      const allow = hold ? hold.allow : null;
      const status = hold ? '<span style="color:#d9a441">🔒 reserved' + (hold.left == null ? '' : ' (' + hold.left + 's)') + '</span>' : '<span class="muted">free for all</span>';
      // Per-role access chips (highlighted = allowed). With no reservation everyone is allowed.
      let chips = ROLES.map(([r, g]) => {
        const allowed = !hold || (allow && allow[r]);
        return '<button class="btn btn-sm" style="' + (allowed ? 'border-color:#6fae5f;color:#bfe6a8;' : 'border-color:#c8553d;color:#e0998a;') + '" title="' + (allowed ? 'Allowed — click to block' : 'Blocked — click to allow') + '" onclick="FP.UI.setAccess(\'' + k + '\',\'' + r + '\',' + (allowed ? 'false' : 'true') + ')">' + g + ' ' + C.ROLE_META[r].name + (allowed ? ' ✓' : ' ✕') + '</button>';
      }).join('');
      const right = (hold ? '<button class="btn btn-sm btn-gold" onclick="FP.UI.act(\'releaseHold\',{resource:\'' + k + '\'});FP.UI.modalRationing()">🔓 Free for all</button>' : '<button class="btn btn-sm" onclick="FP.UI.reserveOnlyMe(\'' + k + '\')">🔒 Reserve (only me)</button>');
      html += '<div class="opt"><div class="opt-info"><div class="opt-name">' + m.glyph + ' ' + m.name + ' <span class="muted">(have ' + Math.round(team.resources[k] || 0) + ')</span> ' + status + '</div><div style="display:flex;gap:4px;flex-wrap:wrap;margin-top:4px">' + chips + '</div></div><div style="display:flex;gap:4px;flex-wrap:wrap;align-items:flex-start">' + right + '</div></div>';
    }
    openModal('🔒 Rationing — who may spend what', html, modalRationing);
  }

  // Per-resource view: sources & rate, usage log, and rationing (Lord) or access requests (others).
  function modalResource(key) {
    const snap = State.snapshot, team = State.teamState(); const role = State.myRole;
    const m = C.RESOURCE_META[key];
    const stats = (team.resourceStats && team.resourceStats[key]) || { rate: 0, sources: [] };
    const log = (team.resourceLog && team.resourceLog[key]) || [];
    const hold = holdInfo(snap, team, key);
    const have = Math.round(team.resources[key] || 0);
    const rateCol = stats.rate >= 0 ? '#6fae5f' : '#c8553d';
    const allowList = hold ? ['STEWARD', 'BLACKSMITH', 'COMMANDER'].filter((r) => hold.allow[r]) : [];
    const whoLabel = hold ? ('Lord' + (allowList.length ? ' + ' + allowList.map((r) => C.ROLE_META[r].name).join(', ') : ' only')) : 'everyone';
    let html = '<div class="muted">You have <b>' + m.glyph + ' ' + have + '</b> · net <b style="color:' + rateCol + '">' + (stats.rate >= 0 ? '+' : '') + (stats.rate || 0).toFixed(2) + '/s</b>' +
      (hold ? ' · <span style="color:#d9a441">🔒 reserved for ' + whoLabel + (hold.left == null ? '' : ' (' + hold.left + 's)') + '</span>' : '') + '</div>';
    html += '<div class="rp-h">Contributing (per second)</div>';
    html += stats.sources.length ? stats.sources.map((s) => '<div class="sel-row"><span>' + esc(s.label) + '</span><span style="color:' + (s.v >= 0 ? '#6fae5f' : '#c8553d') + '">' + (s.v >= 0 ? '+' : '') + s.v + '/s</span></div>').join('') : '<div class="muted">Nothing is producing this right now.</div>';
    html += '<div class="rp-h">Recent usage (last 5)</div>';
    html += log.length ? log.slice().reverse().map((u) => '<div class="sel-row"><span>' + (u.ai ? '🤖' : '👤') + ' ' + esc(u.name) + ' <span class="muted">' + esc(u.purpose) + '</span></span><span style="color:#c8553d">−' + u.amount + '</span></div>').join('') : '<div class="muted">No recent spends of this resource.</div>';
    if (role === 'LORD') {
      const ROLES = [['STEWARD', '🧭'], ['BLACKSMITH', '🔨'], ['COMMANDER', '⚔️']];
      html += '<div class="rp-h">🔒 Who may spend ' + m.name + '</div>';
      html += '<div style="display:flex;gap:4px;flex-wrap:wrap;margin:4px 0">' + ROLES.map(([r, g]) => {
        const allowed = !hold || hold.allow[r];
        return '<button class="btn btn-sm" style="' + (allowed ? 'border-color:#6fae5f;color:#bfe6a8;' : 'border-color:#c8553d;color:#e0998a;') + '" onclick="FP.UI.setAccess(\'' + key + '\',\'' + r + '\',' + (allowed ? 'false' : 'true') + ')">' + g + ' ' + C.ROLE_META[r].name + (allowed ? ' ✓' : ' ✕') + '</button>';
      }).join('') + '</div>';
      html += hold ? '<div style="margin-top:4px"><button class="btn btn-gold btn-sm" onclick="FP.UI.act(\'releaseHold\',{resource:\'' + key + '\'})">🔓 Free for all</button></div>'
        : '<div style="margin-top:4px"><button class="btn btn-sm" onclick="FP.UI.reserveOnlyMe(\'' + key + '\')">🔒 Reserve (only me)</button></div>';
      const pend = team.requests.filter((r) => r.status === 'open' && (r.type === 'USE' || r.type === 'RESERVE') && r.targetRole === 'LORD' && r.payload && r.payload.resource === key);
      html += '<div class="rp-h">Access requests' + (pend.length ? ' <span class="pill">' + pend.length + '</span>' : '') + '</div>';
      if (pend.length) for (const r of pend) html += '<div class="req-card incoming"><div><span class="rq-from">' + esc(r.fromName) + '</span> ' + (r.type === 'RESERVE' ? 'asks to reserve ' : 'asks to spend ') + m.glyph + ' ' + key + (r.payload.reason ? ' — ' + esc(r.payload.reason) : '') + '</div><div class="rq-btns"><button class="btn btn-sm" onclick="FP.UI.resolveReq(\'' + r.id + '\',true)">Approve</button><button class="btn btn-sm" onclick="FP.UI.resolveReq(\'' + r.id + '\',false)">Deny</button></div></div>';
      else html += '<div class="muted" style="font-size:11px">No pending access requests.</div>';
    } else {
      const myGrant = grantLeft(snap, team, key, role);
      if (myGrant > 0) html += '<div class="muted" style="margin-top:6px">✅ You have access for ' + myGrant + 's.</div>';
      if (hold && hold.iOwn) html += '<div class="muted" style="margin-top:6px;color:#bfe6a8">🔒 You reserved this. Release it below when you no longer need it held.</div>';
      html += '<div style="display:flex;gap:5px;flex-wrap:wrap;margin-top:8px">';
      if (hold && hold.iOwn) {
        // The player who reserved it can free it themselves, and can still pull more in.
        html += '<button class="btn btn-gold btn-sm" onclick="FP.UI.act(\'releaseOwnHold\',{resource:\'' + key + '\'});FP.UI.modalResource(\'' + key + '\')">🔓 Release my reservation</button>';
        html += '<button class="btn btn-sm" onclick="FP.UI.needResource(\'' + key + '\')">Ask for more</button>';
      } else if (hold && hold.lockedForMe) {
        html += '<button class="btn btn-gold btn-sm" onclick="FP.UI.requestUse(\'' + key + '\')">🙏 Ask for access</button>';
        html += '<button class="btn btn-sm" onclick="FP.UI.requestReserve(\'' + key + '\')">🔒 Ask to reserve for me</button>';
      } else {
        html += '<button class="btn btn-sm" onclick="FP.UI.needResource(\'' + key + '\')">Ask for more</button>';
        html += '<button class="btn btn-sm" onclick="FP.UI.requestReserve(\'' + key + '\')">🔒 Ask to reserve for me</button>';
      }
      html += '</div>';
    }
    openModal(m.glyph + ' ' + m.name, html, () => modalResource(key));
  }

  // ---------- modals content ----------
  function ownedAreasList(snap, team) {
    const out = [];
    const base = snap.areas[State.myTeam === 'BLUE' ? 'blue_base' : 'red_base'];
    out.push(base);
    for (const id in snap.areas) { const a = snap.areas[id]; if (a.terrain !== 'base' && a.owner === State.myTeam) out.push(a); }
    return out;
  }
  function modalBuild(areaId) {
    const snap = State.snapshot, team = State.teamState();
    const areas = ownedAreasList(snap, team);
    // Remember the chosen location across live refreshes; default to selected/Keep.
    if (areaId !== undefined && snap.areas[areaId] && snap.areas[areaId].owner === State.myTeam) buildTarget = areaId;
    let target = (buildTarget && snap.areas[buildTarget] && snap.areas[buildTarget].owner === State.myTeam) ? buildTarget
      : (State.selectedArea && snap.areas[State.selectedArea] && snap.areas[State.selectedArea].owner === State.myTeam ? State.selectedArea : areas[0].id);
    const area = snap.areas[target];
    const used = slotsAt(area), free = area.maxBuildings - used;
    // Location picker.
    let html = '<div class="build-loc">📍 Building at: <b>' + area.name + '</b> — <span class="' + (free <= 0 ? 'gs-v bad' : 'gs-v good') + '">' + used + '/' + area.maxBuildings + ' slots used</span></div>';
    html += '<div class="loc-picker">' + areas.map((a) => {
      const u = slotsAt(a);
      return '<button class="btn btn-sm ' + (a.id === target ? 'btn-gold' : '') + '" onclick="FP.UI.modalBuild(\'' + a.id + '\')">' + (a.terrain === 'base' ? '♜ ' : '') + a.name + ' (' + u + '/' + a.maxBuildings + ')</button>';
    }).join('') + '</div>';
    html += '<div class="muted" style="margin:4px 0 8px;font-size:11px">Effects boost the whole kingdom. ⚠ Buildings are destroyed if this location is captured.</div>';
    if (free <= 0) html += '<div class="opt" style="border-color:#7a4a2c"><div class="opt-info"><div class="opt-name" style="color:#d9a441">This location is full</div><div class="opt-desc">Pick another location above, or claim a new site to expand.</div></div></div>';
    for (const type of C.BUILDINGS) { const def = B.BUILDINGS[type];
      if (def.fixed) continue;   // the Watchtower is the permanent Keep core — not buildable
      const kingdomTotal = team.buildings[type] || 0;
      const cap = B.MAX_PER_BUILDING ? B.MAX_PER_BUILDING[type] : null;
      let queuedOfType = 0; for (const q of team.buildQueue) if (q.type === type) queuedOfType++;
      const atCap = cap != null && (kingdomTotal + queuedOfType) >= cap;
      const aff = canAfford(team, def.cost);
      const why = atCap ? ' — at the limit of ' + cap : (free <= 0 ? ' — location full' : (!aff ? ' — need ' + missingCost(team, def.cost) : ''));
      const capLabel = cap != null ? '/' + cap : '';
      html += optRow(def.name + ' <span class="muted">(kingdom total: ' + kingdomTotal + capLabel + ')</span>', effectDesc(type), costStr(def.cost) + (why ? '<span style="color:#c8553d">' + why + '</span>' : ''), 'Build here',
        () => { Net.action('build', { type, areaId: target }); }, !aff || free <= 0 || atCap); }
    if (team.buildQueue.length) html += '<div class="rp-h">Construction queue</div>' + team.buildQueue.map((q, i) => '<div class="opt"><div class="opt-info"><div class="opt-name">' + B.BUILDINGS[q.type].name + ' <span class="muted">@ ' + (snap.areas[q.areaId] ? snap.areas[q.areaId].name : '?') + (i === 0 ? '' : ' · queued') + '</span></div><div class="opt-desc">' + (i === 0 ? Math.ceil(q.remaining) + 's left' + (team.pop.builders <= 0 ? ' (no builders assigned!)' : '') : 'waiting') + '</div></div><button class="btn btn-sm" onclick="FP.UI.act(\'cancelBuild\',{id:\'' + q.id + '\'})">Cancel</button></div>').join('');
    openModal('Build — choose location, then structure', html, modalBuild);
  }
  function missingCost(team, cost) { return Object.keys(cost).filter((k) => (team.resources[k] || 0) < cost[k]).map((k) => Math.ceil(cost[k] - (team.resources[k] || 0)) + ' more ' + k).join(', '); }
  const BUILDING_GLYPH = { house: '🏠', farm: '🌾', lumberCamp: '🪵', mine: '⛏️', storehouse: '📦', barracks: '🏛️', school: '🎓', stables: '🐎', workshop: '🪚', walls: '🧱', watchtower: '🗼' };
  function buildGlyph(type) { return BUILDING_GLYPH[type] || '🏗️'; }
  function effectDesc(type) {
    const e = B.BUILDINGS[type].effect; const m = [];
    if (e.housing) m.push('+' + e.housing + ' housing (kingdom-wide)'); if (e.foodMult) m.push('+food output'); if (e.woodMult) m.push('+wood output');
    if (e.mineMult) m.push('+stone & iron output'); if (e.storage) m.push('+storage cap'); if (e.unlock) m.push('unlocks ' + e.unlock + ' (kingdom-wide)');
    if (type === 'walls') m.push('🧱 defenders here fight +' + Math.round(B.WALL_TROOP_BONUS * 100) + '% (archers +' + Math.round(B.WALL_ARCHER_BONUS * 100) + '%); must be razed first & take 2× longer to destroy; at the Keep also +Keep HP/defence');
    else if (e.keepHp) m.push('+Keep HP & defence (only at the Keep)');
    if (e.forgeSpeed) m.push('+Blacksmith speed'); return m.join(' · ');
  }

  function modalWorkers() {
    const team = State.teamState(); const p = team.pop; const role = State.myRole;
    const locked = !!team.workerLock && role !== 'LORD';
    const coolBatches = p.cooling || [];
    const cooling = coolBatches.reduce((a, b) => a + b.n, 0);
    const wf = p.farmers + p.woodcutters + p.miners + p.builders + p.students + p.trainers + p.idle + cooling;
    const jobs = [
      { k: 'farmers', d: 'produce Food', bld: 'farm', bn: 'Farm' },
      { k: 'woodcutters', d: 'produce Wood', bld: 'lumberCamp', bn: 'Lumber Camp' },
      { k: 'miners', d: 'produce Stone & Iron', bld: 'mine', bn: 'Mine' },
      { k: 'builders', d: 'speed construction' },
      { k: 'students', d: team.buildings.school > 0 ? 'educated in 30s (each School trains 1 at a time · ' + team.buildings.school + ' school' + (team.buildings.school > 1 ? 's' : '') + ')' : 'needs a School' },
      { k: 'trainers', d: team.buildings.barracks > 0 ? 'train recruits → troops (max ' + (team.buildings.barracks * B.TRAINERS_PER_BARRACKS) + ', 15s each)' : 'needs a Barracks' },
    ];
    let html = '<div class="muted">Workforce <b>' + wf + '</b> · 🎖️ recruits <b>' + Math.round(p.recruits) + '</b> · ⚔️ soldiers <b>' + p.soldiers + '</b> · 🎓 educated ' + p.educated +
      '<br>Click − to send a worker to <b>Idle (preparing)</b> for 30s (educated 5s); click + to assign from Idle (ready).</div>';
    // Worker-allocation control. The Lord can lock the Steward out; the Steward sees the lock state.
    if (role === 'LORD') {
      html += '<div class="opt"><div class="opt-info"><div class="opt-name">🔓 Worker control</div><div class="opt-desc">' + (team.workerLock ? 'Locked — only you assign workers.' : 'Shared — the Steward may also assign workers.') + '</div></div><button class="btn btn-sm" onclick="FP.UI.act(\'setWorkerLock\',{locked:' + (team.workerLock ? 'false' : 'true') + '})">' + (team.workerLock ? '🔓 Allow Steward' : '🔒 Lock to me') + '</button></div>';
    } else if (locked) {
      html += '<div class="mil-alert yellow">🔒 The Lord has locked worker allocation. Ask them to unlock it, or request workers via Ask the Lord.</div>';
    } else if (role === 'STEWARD') {
      html += '<div class="muted" style="font-size:11px">The Lord has let you help assign workers. Coordinate so you don\'t undo each other.</div>';
    }
    for (const j of jobs) {
      const dis = (j.k === 'trainers' && team.buildings.barracks <= 0) || (j.k === 'students' && team.buildings.school <= 0);
      const wcap = j.bld ? (team.buildings[j.bld] || 0) * B.WORKERS_PER_BUILDING : Infinity;
      const atCap = Number.isFinite(wcap) && p[j.k] >= wcap;
      const disPlus = locked || dis || atCap || p.idle <= 0 || (j.k === 'trainers' && p.trainers >= team.buildings.barracks * B.TRAINERS_PER_BARRACKS);
      const capLabel = j.bld ? ' <span class="muted" style="font-size:10px"' + (atCap ? ' title="Max reached — build another ' + j.bn + ' (' + B.WORKERS_PER_BUILDING + ' per building)."' : '') + '>' + (atCap ? '⚠ ' : '') + p[j.k] + '/' + wcap + '</span>' : '';
      const desc = j.bld ? j.d + ' · max ' + B.WORKERS_PER_BUILDING + ' per ' + j.bn : j.d;
      html += '<div class="opt"><div class="opt-info"><div class="opt-name">' + cap(j.k) + capLabel + '</div><div class="opt-desc">' + desc + '</div></div>' +
        '<div><button class="btn btn-sm" ' + (locked || dis || p[j.k] <= 0 ? 'disabled' : '') + ' onclick="FP.UI.wAdj(\'' + j.k + '\',-1)">−</button> <b>' + p[j.k] + '</b> ' +
        '<button class="btn btn-sm" ' + (disPlus ? 'disabled' : '') + ' onclick="FP.UI.wAdj(\'' + j.k + '\',1)">+</button></div></div>';
    }
    html += '<div class="opt"><div class="opt-info"><div class="opt-name">Idle (ready)</div><div class="opt-desc">available to assign now</div></div><b>' + p.idle + '</b></div>';
    if (cooling > 0) {
      const soonest = Math.max(0, Math.ceil(Math.min.apply(null, coolBatches.map((b) => b.until)) - State.snapshot.elapsed));
      html += '<div class="opt" style="border-color:#7a5e2c"><div class="opt-info"><div class="opt-name" style="color:#d9a441">Idle (preparing) ⏳</div><div class="opt-desc">re-settling after reassignment · next ready in ~' + soonest + 's</div></div><b style="color:#d9a441">' + cooling + '</b></div>';
    }
    // One-way levy (Lord only): commit workers to the army's recruit pool.
    if (role === 'LORD') {
      html += '<div class="rp-h">⚔️ Levy soldiers (one-way)</div><div class="muted" style="font-size:11px">Commit workers to the army as 🎖️ <b>recruits</b> (shown above) — the Commander trains them into ⚔️ troops at a Barracks. <b>You cannot turn soldiers back into workers.</b> Dead soldiers free housing for new workers to grow.</div>';
      html += '<div class="opt"><div class="opt-info"><div class="opt-name">Levy from idle/workers → recruits</div></div><div style="display:flex;gap:4px">' +
        '<button class="btn btn-sm" onclick="FP.UI.levy(1)">+1</button>' +
        '<button class="btn btn-sm" onclick="FP.UI.levy(3)">+3</button>' +
        '<button class="btn btn-sm" onclick="FP.UI.levy(5)">+5</button></div></div>';
    }
    openModal('Assign Workers', html, modalWorkers);  // fully live: +/- and levy apply instantly
  }

  function modalPolicy() {
    const snap = State.snapshot, team = State.teamState();
    const cd = Math.max(0, Math.ceil((team.policyCooldownUntil || 0) - snap.elapsed));
    const onCd = team.policy && cd > 0;
    let html = '<div class="muted">Pick one kingdom policy. Current: <b>' + (team.policy ? B.POLICIES[team.policy].name : 'none') + '</b>.' +
      (onCd ? ' <span style="color:#d9a441">Change available in ' + Math.floor(cd / 60) + ':' + String(cd % 60).padStart(2, '0') + '.</span>' : ' Changing locks the policy for 3 minutes.') + '</div>';
    for (const k in B.POLICIES) { const pol = B.POLICIES[k];
      html += optRow(pol.name, pol.desc, '', team.policy === k ? 'Active' : 'Adopt', () => Net.action('setPolicy', { policy: k }), team.policy === k || onCd); }
    openModal('Kingdom Policy', html, modalPolicy);
  }

  // Lord sets the kingdom's military stance (aggressive/balanced/defensive) — combat tilt + a
  // directive that steers the Commander (AI or human). 3-minute cooldown like kingdom policy.
  function modalMilitaryPolicy() {
    const snap = State.snapshot, team = State.teamState();
    const cur = team.militaryPolicy || 'balanced';
    const cd = Math.max(0, Math.ceil((team.militaryPolicyCooldownUntil || 0) - snap.elapsed));
    const onCd = cd > 0;
    let html = '<div class="muted">Set the realm\'s <b>military stance</b>. Current: <b>' + (B.MILITARY_POLICIES[cur] ? B.MILITARY_POLICIES[cur].name : cur) + '</b>.' +
      (onCd ? ' <span style="color:#d9a441">Change available in ' + Math.floor(cd / 60) + ':' + String(cd % 60).padStart(2, '0') + '.</span>' : ' Changing locks the stance for 3 minutes.') +
      '<br>This both tilts combat slightly <b>and</b> directs your Commander (AI or human) to play more aggressively or defensively.</div>';
    for (const k in B.MILITARY_POLICIES) { const pol = B.MILITARY_POLICIES[k];
      html += optRow('⚔️ ' + pol.name, pol.desc, '', cur === k ? 'Active' : 'Adopt', () => Net.action('setMilitaryPolicy', { policy: k }), cur === k || onCd); }
    openModal('Military Stance', html, modalMilitaryPolicy);
  }

  // Client-side mirror of the server's gather yield math, for live previews in the Steward UI.
  function gatherCalc(team) {
    const g = team.gather || { desired: { food: 0, wood: 0, mine: 0 }, effective: { food: 0, wood: 0, mine: 0 }, mineIronFocus: B.DEFAULT_MINE_FOCUS };
    const tp = (team.blacksmithSpec && B.BLACKSMITH_SPECS[team.blacksmithSpec] && B.BLACKSMITH_SPECS[team.blacksmithSpec].toolPower) || 1;
    const tools = ((team.gearInv && team.gearInv.tools) ? team.gearInv.tools.slice() : []).sort((a, b) => b - a);
    let ti = 0, boostSumAll = 0, tooledAll = 0;
    const usedQ = { food: [], wood: [], mine: [] };
    const eff = (w, tooledCount, pool) => { if (w <= 0) return 0; let units = 0, used = 0; const want = Math.min(Math.round(tooledCount), w); for (let i = 0; i < want && ti < tools.length; i++) { const q = tools[ti]; const bonus = 1 + B.TOOLS_BONUS * q * tp; units += bonus; boostSumAll += bonus; tooledAll++; if (pool) usedQ[pool].push(q); ti++; used++; } return units + (w - used); };
    const p = team.pop;
    const foodBuild = 1 + team.buildings.farm * B.BUILDINGS.farm.effect.foodMult;
    const woodBuild = 1 + team.buildings.lumberCamp * B.BUILDINGS.lumberCamp.effect.woodMult;
    const mineBuild = 1 + team.buildings.mine * B.BUILDINGS.mine.effect.mineMult;
    const focus = g.mineIronFocus;
    const food = eff(p.farmers, g.effective.food, 'food') * B.WORKER_YIELD.farmer.food * foodBuild;
    const wood = eff(p.woodcutters, g.effective.wood, 'wood') * B.WORKER_YIELD.woodcutter.wood * woodBuild;
    const mineUnits = eff(p.miners, g.effective.mine, 'mine');
    const stone = mineUnits * (1 - focus) * B.MINER_STONE_YIELD * mineBuild;
    const iron = mineUnits * focus * B.MINER_IRON_YIELD * mineBuild;
    const q = (team.equipQuality && team.equipQuality.tools) || 1;
    const boost = tooledAll > 0 ? boostSumAll / tooledAll : (1 + B.TOOLS_BONUS * 1 * tp);
    return { g, q, boost, food, wood, stone, iron, focus, usedQ };
  }

  // ⛏️ Steward's labor screen: equip crews with the Blacksmith's tools and steer the mines.
  function modalGather() {
    const team = State.teamState(); if (!team) return;
    const c = gatherCalc(team);
    const stock = Math.floor((team.equipment.tools || 0));
    const committed = c.g.desired.food + c.g.desired.wood + c.g.desired.mine;
    const free = Math.max(0, stock - committed);
    const qline = stock > 0 ? qualBadge(c.q) : '<span class="muted">none forged yet</span>';
    let html = '<div class="muted">The Lord provides workers &amp; buildings — <b>you equip crews with the Blacksmith\'s 🛠️ Tools and direct the mines.</b> Each tooled worker gathers <b>×' + c.boost.toFixed(2) + '</b>.</div>';
    html += '<div class="opt"><div class="opt-info"><div class="opt-name">🛠️ Tool stock: ' + stock + ' &nbsp;' + qline + '</div><div class="opt-desc">Committed ' + committed + ' · Free ' + free + (stock === 0 ? ' — none in store' : '') + '</div></div>' + '<button class="btn btn-sm" onclick="FP.UI.askToolsFromSmith()">Ask Blacksmith for Tools</button></div>';
    const card = (pool, glyph, name, workers, bldName, bldCount, perRow, extra) => {
      const des = c.g.desired[pool], eff = c.g.effective[pool], miss = des - eff;
      const minus = '<button class="btn btn-sm" ' + (des <= 0 ? 'disabled' : '') + ' onclick="FP.UI.gatherTools(\'' + pool + '\',-1)">−</button>';
      const plus = '<button class="btn btn-sm" ' + (des >= workers || free <= 0 && des >= eff ? 'disabled' : '') + ' onclick="FP.UI.gatherTools(\'' + pool + '\',1)">＋</button>';
      let h = '<div class="rp-h">' + glyph + ' ' + name + '</div>';
      h += '<div class="sel-row"><span>👷 Workers (Lord)</span><span>' + workers + ' / ' + (bldCount * 4) + ' <span class="muted">(' + bldCount + ' ' + bldName + ')</span>' + (workers === 0 ? ' <span style="color:#d9a441">⚠ ask the Lord</span>' : '') + '</span></div>';
      h += '<div class="sel-row"><span>🛠️ Tools equipped</span><span>' + minus + ' <b>' + des + '</b>' + (miss > 0 ? ' <span style="color:#d9a441">(' + eff + ' active · ' + miss + ' awaiting tools)</span>' : '') + ' ' + plus + '</span></div>';
      if (eff > 0) { const mix = qualMix((c.usedQ && c.usedQ[pool]) || []); h += '<div class="sel-row"><span class="muted" style="font-size:10px">↳ each worker\'s tool</span><span style="font-size:10px">' + (mix || qualBadge(c.q)) + ' → <b>×' + c.boost.toFixed(2) + '</b> avg</span></div>'; }
      h += perRow;
      if (extra) h += extra;
      return h;
    };
    html += card('food', '🌾', 'Farmers → Food', team.pop.farmers, 'Farm', team.buildings.farm, '<div class="sel-row"><span>🌾 Food / sec</span><span><b>' + c.food.toFixed(2) + '</b></span></div>');
    html += card('wood', '🪵', 'Woodcutters → Wood', team.pop.woodcutters, 'Lumber Camp', team.buildings.lumberCamp, '<div class="sel-row"><span>🪵 Wood / sec</span><span><b>' + c.wood.toFixed(2) + '</b></span></div>');
    const fpct = Math.round(c.focus * 100);
    const fb = (v, label) => '<button class="btn btn-sm" style="' + (Math.abs(c.focus - v) < 0.01 ? 'border-color:#c4a35a;color:#e3c578;' : '') + '" onclick="FP.UI.mineFocus(' + v + ')">' + label + '</button>';
    let mineExtra = '<div class="sel-row"><span>⚒️ Focus</span><span>' + (100 - fpct) + '% 🪨 stone / ' + fpct + '% ⛓️ iron</span></div>';
    mineExtra += '<div style="display:flex;gap:4px;flex-wrap:wrap;margin:4px 0">' + fb(0, 'All Stone') + fb(0.25, 'Stone+') + fb(0.5, 'Even') + fb(0.75, 'Iron+') + fb(1, 'All Iron') + '<button class="btn btn-sm" onclick="FP.UI.mineFocusStep(-0.1)">−10%</button><button class="btn btn-sm" onclick="FP.UI.mineFocusStep(0.1)">+10%</button></div>';
    mineExtra += '<div class="sel-row"><span>🪨 Stone / sec</span><span><b>' + c.stone.toFixed(2) + '</b></span></div><div class="sel-row"><span>⛓️ Iron / sec</span><span><b>' + c.iron.toFixed(2) + '</b></span></div>';
    if (c.focus <= 0.01 || c.focus >= 0.99) mineExtra += '<div class="mil-alert yellow">⚠ Extreme focus — the other resource is fully starved.</div>';
    html += card('mine', '⛏️', 'Miners → Stone &amp; Iron', team.pop.miners, 'Mine', team.buildings.mine, '', mineExtra);
    // Conserve: ask the whole council to lay off a resource for a while (so you can fund outposts).
    html += '<div class="rp-h">🙏 Ask the council to conserve</div>';
    const snap = State.snapshot;
    const active = (res) => { const u = team.conserve && team.conserve[res]; return (typeof u === 'number' && u > snap.elapsed) ? Math.ceil(u - snap.elapsed) : 0; };
    let crow = '<div class="muted" style="font-size:11px;margin-bottom:4px">Asks all teammates (human &amp; 🤖) to stop spending it for a while — AI complies; you can still spend it.</div><div style="display:flex;gap:5px;flex-wrap:wrap">';
    for (const res of ['wood', 'stone', 'iron']) {
      const m = C.RESOURCE_META[res]; const left = active(res);
      crow += '<button class="btn btn-sm" onclick="FP.UI.askConserve(\'' + res + '\',60)">' + m.glyph + ' Conserve ' + res + (left ? ' (' + left + 's)' : '') + '</button>';
    }
    crow += '</div>';
    html += crow;
    openModal('⛏️ Labor &amp; Gathering', html, modalGather);
  }

  // Label for a claim/fund button that reflects partial wood funding toward an outpost.
  function claimLabel(a) {
    const need = B.CLAIM_COST.wood;
    const paid = (a.claimFund && a.claimFund.team === State.myTeam) ? Math.round(a.claimFund.wood) : 0;
    return paid > 0 ? 'Fund (' + paid + '/' + need + ' 🪵)' : 'Claim (' + need + ' 🪵)';
  }

  // Contested = enemy owns this area or an enemy host is on it (mirrors server areaIsDangerous).
  function areaContested(snap, id) {
    const a = snap.areas[id]; if (a.owner && a.owner !== State.myTeam) return true;
    const foe = State.enemyTeam();
    return snap.teams[foe].armies.some((g) => (g.moving ? g.moving.route[g.moving.legIndex] : g.area) === id);
  }
  function siteYieldPerSec(a) {
    const y = B.SITE_YIELD[a.terrain]; if (!y || !a.site) return 0;
    const mode = B.WORK_MODES[a.site.workMode || 'standard'] || B.WORK_MODES.standard;
    return (y[a.resource] || 0) * a.site.level * mode.yield;
  }
  function modalSites() {
    const snap = State.snapshot, team = State.teamState();
    const pool = Math.round(team.guards || 0);
    let html = '<div class="muted">🏚️ <b>Outposts</b> turn claimed sites into income — each ships its goods home by 🐎 <b>caravan</b>. Claim costs <b>' + B.CLAIM_COST.wood + ' 🪵</b> (instalments); upgrade <b>' + B.SITE_UPGRADE_COST.wood + ' 🪵 + ' + B.SITE_UPGRADE_COST.stone + ' 🪨</b>. <b>Push</b> earns more but risks crews at contested sites.</div>' +
      '<div class="muted" style="font-size:11px;margin-top:2px">🛡 <b>Guards</b> protect a post\'s caravans: an <u>unguarded</u> caravan that meets enemy troops is <b style="color:#d46a5a">destroyed</b>. Guards stop the attackers and fight (and can <b>die</b>); if overwhelmed they still buy the caravan time to flee — but faster soldiers may run it down. <b>Guards are a one-way commitment</b> — once lent they never return to the army.</div>';
    // Guard pool + ask the Commander for more.
    html += '<div class="opt"><div class="opt-info"><div class="opt-name">🛡 Guard pool: <b>' + pool + '</b> unassigned</div><div class="opt-desc">militia/recruits the Commander lent you (permanently)</div></div><button class="btn btn-sm" onclick="FP.UI.askGuards()">Ask Commander for guards</button></div>';
    const owned = [], others = [];
    for (const id in snap.areas) { const a = snap.areas[id]; if (a.terrain === 'base') continue; if (a.claimedBy === State.myTeam) owned.push([id, a]); else others.push([id, a]); }
    if (owned.length) {
      html += '<div class="rp-h">Your outposts (' + owned.length + ')</div>';
      for (const [id, a] of owned) {
        const m = C.RESOURCE_META[a.resource]; const yld = siteYieldPerSec(a); const danger = areaContested(snap, id);
        const mode = (a.site && a.site.workMode) || 'standard';
        const modeBtns = ['cautious', 'standard', 'push'].map((k) => { const wm = B.WORK_MODES[k]; const yl = '×' + wm.yield.toFixed(1); const risk = wm.lossPerSec > 0 ? ' ⚠' : ''; return '<button class="btn btn-sm" title="' + esc(wm.desc) + '" style="' + (mode === k ? 'border-color:#c4a35a;color:#e3c578;' : '') + '" onclick="FP.UI.setWorkModeSafe(\'' + id + '\',\'' + k + '\',' + (danger ? 'true' : 'false') + ')">' + wm.name + ' <span style="font-size:9px">' + yl + risk + '</span></button>'; }).join('');
        const riskNote = (mode === 'push' && danger) ? '<div style="color:#d46a5a;font-size:10px;margin-top:2px">⚠ Push at a contested outpost risks losing a crew (~' + Math.round(B.WORK_MODES.push.lossPerSec * 100) + '%/s).</div>' : '';
        const thr = (B.CARAVAN_DISPATCH_BY_RESOURCE && B.CARAVAN_DISPATCH_BY_RESOURCE[a.resource]) || B.CARAVAN_DISPATCH_CARGO;
        // Caravan ETA: warn ~5s before a caravan departs this post.
        const remain = thr - a.site.cargo; const eta = yld > 0 ? remain / yld : Infinity;
        const warn = (B.CARAVAN_WARN_SECONDS || 5);
        const cargoStr = (eta <= warn && eta > 0) ? '<b style="color:#e3c578">🐎 caravan departs in ~' + Math.ceil(eta) + 's</b>' : (thr <= 1 ? a.site.cargo.toFixed(2) + '/' + thr + ' · ships 1 at a time' : Math.round(a.site.cargo) + '/' + thr + ' cargo');
        const guards = Math.round(a.site.guards || 0);
        const guardRow = '<div style="display:flex;align-items:center;gap:4px;margin-top:3px;font-size:11px">🛡 guards <button class="btn btn-sm" ' + (guards <= 0 ? 'disabled' : '') + ' onclick="FP.UI.setGuards(\'' + id + '\',' + (guards - 1) + ')">−</button> <b>' + guards + '</b> <button class="btn btn-sm" ' + (pool <= 0 ? 'disabled' : '') + ' onclick="FP.UI.setGuards(\'' + id + '\',' + (guards + 1) + ')">+</button>' + (danger && guards <= 0 ? ' <span style="color:#d46a5a">⚠ caravans exposed</span>' : '') + '</div>';
        html += '<div class="opt"><div class="opt-info"><div class="opt-name">' + (m ? m.glyph + ' ' : '') + a.name + ' <span class="muted">Lv' + a.site.level + '</span>' + (danger ? ' <span style="color:#d46a5a">⚠ contested</span>' : '') + '</div>' +
          '<div class="opt-desc">' + yld.toFixed(2) + ' ' + a.resource + '/s · ' + cargoStr + '</div>' +
          '<div style="display:flex;gap:4px;flex-wrap:wrap;margin-top:3px">' + modeBtns + '</div>' + guardRow + riskNote + '</div>' +
          '<button class="btn btn-sm" onclick="FP.UI.act(\'upgradeSite\',{areaId:\'' + id + '\'})">⬆ Upgrade<br><span style="font-size:9px">' + B.SITE_UPGRADE_COST.wood + '🪵 ' + B.SITE_UPGRADE_COST.stone + '🪨</span></button></div>';
      }
    }
    html += '<div class="rp-h">Expand</div>';
    let any = false;
    for (const [id, a] of others) {
      const rev = a.revealed[State.myTeam];
      let act = '', fn = '', keepOpen = false, desc = '';
      if (!rev && a.connections.some((n) => snap.areas[n].revealed[State.myTeam])) { act = 'Scout'; fn = "FP.UI.act('explore',{areaId:'" + id + "'})"; desc = 'unexplored — scout to reveal'; }
      else if (rev && a.site && (!a.owner || (a.owner === State.myTeam && a.claimedBy !== State.myTeam))) { act = claimLabel(a); fn = "FP.UI.act('claim',{areaId:'" + id + "'})"; keepOpen = true; const m = C.RESOURCE_META[a.resource]; const yld = (B.SITE_YIELD[a.terrain] || {})[a.resource] || 0; desc = (a.owner === State.myTeam ? 'your ground · outpost destroyed — rebuild · ' : 'neutral · ') + (m ? m.glyph + ' ' + a.resource : a.resource) + ' (~' + yld.toFixed(2) + '/s at Lv1)'; }
      else if (rev && a.owner && a.owner !== State.myTeam) { desc = 'enemy-held'; }
      else continue;
      if (act) any = true;
      html += '<div class="opt"><div class="opt-info"><div class="opt-name">' + a.name + ' <span class="muted">' + (a.resource || '') + '</span></div><div class="opt-desc">' + desc + '</div></div>' + (act ? '<button class="btn btn-sm" onclick="' + fn + (keepOpen ? '' : ';FP.UI.closeModal()') + '">' + act + '</button>' : '') + '</div>';
    }
    if (!any && !owned.length) html += '<div class="muted">Scout neighbouring areas (click them on the map), then claim their sites.</div>';
    openModal('🏚️ Outposts & Sites', html, modalSites);
  }
  function modalCaravans() {
    const snap = State.snapshot, team = State.teamState();
    let html = '<div class="muted">🐎 Caravans carry your outposts\' goods home. If a caravan meets <b>enemy troops</b> with <b>no guards</b> it is <b style="color:#d46a5a">destroyed</b>. 🛡 <b>Guards</b> stop the attackers and fight; if overwhelmed they buy time and the caravan <b>flees</b> — but faster enemy soldiers may run it down. An <b>escort</b> host shields it fully.</div>';
    if (!team.caravans.length) html += '<div class="muted" style="padding:8px">No caravans en route. Outposts dispatch one once they reach ' + B.CARAVAN_DISPATCH_CARGO + ' cargo (relics ship 1 at a time).</div>';
    for (const cv of team.caravans) {
      const m = C.RESOURCE_META[cv.resource]; const amt = Math.round(Object.values(cv.cargo).reduce((s, v) => s + v, 0));
      const legsLeft = cv.route.length - 1 - cv.legIndex;
      let danger = false; for (let i = cv.legIndex + 1; i < cv.route.length; i++) { if (areaContested(snap, cv.route[i])) { danger = true; break; } }
      const from = snap.areas[cv.from] ? snap.areas[cv.from].name : '?';
      const guards = Math.round(cv.guards || 0);
      const protect = cv.fleeing ? '<b style="color:#d9a441">🏃 fleeing — pursuers chasing!</b>' : (cv.escort ? '🛡 escorted' : (guards > 0 ? '🛡 ' + guards + ' guards' : '<span style="color:#d46a5a">unguarded</span>'));
      const exposed = danger && !cv.escort && guards <= 0 && !cv.fleeing;
      html += '<div class="opt"><div class="opt-info"><div class="opt-name">' + (m ? m.glyph : '') + ' ' + amt + ' ' + cv.resource + ' <span class="muted">from ' + esc(from) + '</span></div>' +
        '<div class="opt-desc">' + protect + ' · ' + (danger ? '<span style="color:#d46a5a">⚠ contested route</span>' : '<span style="color:#6fae5f">safe route</span>') + ' · ~' + legsLeft + ' leg' + (legsLeft === 1 ? '' : 's') + ' to home' + (exposed ? ' <b style="color:#d46a5a">— at risk!</b>' : '') + '</div></div>' +
        (!cv.escort ? '<button class="btn btn-sm" onclick="FP.UI.askEscort(\'' + cv.id + '\')">Ask Escort</button>' : '') + '</div>';
    }
    openModal('🐎 Caravans', html, modalCaravans);
  }
  function expeditionEligibleClient(snap, team, e) {
    if (e.requires.building && (team.buildings[e.requires.building] || 0) <= 0) return false;
    if (e.requires.site) { const terr = e.requires.site; const ok = (t) => Array.isArray(terr) ? terr.includes(t) : t === terr; let has = false; for (const id in snap.areas) { const a = snap.areas[id]; if (a.claimedBy === State.myTeam && a.site && ok(a.terrain)) { has = true; break; } } if (!has) return false; }
    return true;
  }
  function coolingCountClient(team) { let n = 0; for (const b of ((team.pop && team.pop.cooling) || [])) n += b.n; return n; }
  function modalExpeditions() {
    const snap = State.snapshot, team = State.teamState();
    const allowCooling = !team.workerLock;
    const prep = coolingCountClient(team);
    const avail = team.pop.idle + (allowCooling ? prep : 0);
    let html = '<div class="muted">🧭 <b>Expeditions</b> commit workers for a timed venture, then pay a big resource reward — but a crew may not return. One at a time.' +
      (allowCooling && prep > 0 ? ' You can draw on <b>preparing</b> workers too (' + prep + ' re-settling).' : (!allowCooling ? ' <span style="color:#d9a441">The Lord locked worker control, so only ready idle workers can go.</span>' : '')) + '</div>';
    const cd = Math.max(0, Math.ceil((team.expeditionCooldownUntil || 0) - snap.elapsed));
    if (team.expedition) {
      const left = Math.max(0, Math.ceil(team.expedition.endsAt - snap.elapsed));
      html += '<div class="opt"><div class="opt-info"><div class="opt-name">⏳ ' + esc(team.expedition.name) + ' — underway</div><div class="opt-desc">' + team.expedition.workers + ' workers away · ' + left + 's left · reward ' + Object.keys(team.expedition.reward).map((k) => (C.RESOURCE_META[k] ? C.RESOURCE_META[k].glyph : '') + team.expedition.reward[k]).join(' ') + '</div></div></div>';
    } else {
      if (cd > 0) html += '<div class="muted">On cooldown — ' + cd + 's until the next venture.</div>';
      for (const e of B.EXPEDITIONS) {
        const elig = expeditionEligibleClient(snap, team, e);
        const workersOk = avail >= e.workers;
        const siteTxt = e.requires.site ? (Array.isArray(e.requires.site) ? e.requires.site.join(' or ') : e.requires.site) : '';
        const reqTxt = e.requires.building ? ('needs a ' + (B.BUILDINGS[e.requires.building] ? B.BUILDINGS[e.requires.building].name : e.requires.building)) : siteTxt ? ('needs a claimed ' + siteTxt + ' outpost') : '';
        const haveTxt = team.pop.idle + ' idle' + (allowCooling && prep > 0 ? ' + ' + prep + ' preparing' : '');
        const why = !elig ? reqTxt : (!workersOk ? ('needs ' + e.workers + ' workers (have ' + haveTxt + ')') : (cd > 0 ? 'on cooldown' : ''));
        const reward = Object.keys(e.reward).map((k) => (C.RESOURCE_META[k] ? C.RESOURCE_META[k].glyph : '') + e.reward[k]).join(' ');
        html += optRow('🧭 ' + e.name, e.desc + ' · ⚠ ' + Math.round(e.risk * 100) + '% a crew is lost', e.workers + ' workers · ' + e.time + 's · reward ' + reward, 'Launch',
          () => Net.action('startExpedition', { id: e.id }), !elig || !workersOk || cd > 0, why);
      }
    }
    openModal('🧭 Expeditions', html, modalExpeditions);
  }

  function modalForge() {
    const team = State.teamState(); let html = '<div class="muted">Stockpile: ' + C.EQUIP.map((e) => { const v = Math.round(team.equipment[e] || 0); const q = (team.equipQuality && team.equipQuality[e]) || 1; return C.EQUIP_META[e].glyph + v + (v > 0 ? '<span style="color:' + qualColor(q) + ';font-size:9px"> ' + qualName(q).split(' ')[0] + '×' + q.toFixed(1) + '</span>' : ''); }).join('  ') + ' · 🏹' + Math.round(team.resources.arrows || 0) + ' arrows' +
      '<br><span style="font-size:11px">⚒️ Play the forging minigame — strike in the green for higher <b>quality</b>. Each soldier is issued <b>their own</b> weapon (and armour, if stocked) when trained, keeping that item\'s quality for life.</span></div>';
    const inv = team.gearInv || {};
    const invRows = C.EQUIP.filter((e) => (inv[e] && inv[e].length)).map((e) => '<div class="sel-row" style="font-size:11px"><span>' + C.EQUIP_META[e].glyph + ' ' + cap(e) + ' <b>' + inv[e].length + '</b></span><span>' + qualMix(inv[e]) + '</span></div>').join('');
    if (invRows) html += '<div class="rp-h">🗃️ Armoury — individual items in stock</div><div class="muted" style="font-size:10px;margin-bottom:2px">A trained soldier draws the BEST item of their type from here.</div>' + invRows;
    for (const item in B.RECIPES) { const r = B.RECIPES[item]; const meta = C.EQUIP_META[item] || { glyph: '🏹', name: 'Arrows' };
      const dis = r.needs === 'siege' && team.buildings.workshop <= 0;
      const strikes = Math.max(1, Math.round(r.time));
      const totalCost = {}; for (const k in r.cost) totalCost[k] = r.cost[k] * r.batch;
      html += optRow((C.EQUIP_META[item] ? C.EQUIP_META[item].glyph : '🏹') + ' ' + cap(item) + ' <span class="muted">×' + r.batch + '</span>', (C.EQUIP_META[item] || {}).desc || 'Ammunition for archers.', costStr(totalCost) + ' for ×' + r.batch + ' · ' + strikes + ' strikes', 'Forge', () => forgeMinigame(item, r.batch), dis, dis ? 'Needs a Workshop' : '');
    }
    if (team.qualityLog && team.qualityLog.length) html += '<div class="rp-h">Recently forged</div>' + team.qualityLog.map((q) => '<div class="sel-row"><span>' + (C.EQUIP_META[q.item] ? C.EQUIP_META[q.item].glyph : '🏹') + ' ' + cap(q.item) + '</span><span>' + q.glyph + ' ' + q.name + '</span></div>').join('');
    if (team.production.length) html += '<div class="rp-h">Forging</div>' + team.production.map((q, i) => {
      const rt = (B.RECIPES[q.item] && B.RECIPES[q.item].time) || 1;
      const active = i === 0 && !q.waitingOn;
      const prog = active ? Math.max(0, Math.min(1, (rt - (q.remaining || 0)) / rt)) : 0;
      const wait = q.waitingOn ? ' <span style="color:#d9a441">⏸ paused — ' + (C.RESOURCE_META[q.waitingOn] ? C.RESOURCE_META[q.waitingOn].glyph + ' ' : '') + q.waitingOn + ' reserved</span>' : (i === 0 && q.short ? ' <span style="color:#c8553d">⏸ short on resources</span>' : (i === 0 ? '' : ' <span class="muted">· queued</span>'));
      const barColor = q.waitingOn ? '#7a5a2c' : '#c4a35a';
      const bar = '<div style="height:6px;background:#2a241a;border-radius:3px;overflow:hidden;margin-top:5px"><div style="height:100%;width:' + Math.round(prog * 100) + '%;background:' + barColor + ';transition:width .2s linear"></div></div>';
      return '<div class="opt"><div class="opt-info"><div class="opt-name">' + cap(q.item) + ' ×' + Math.ceil(q.qtyLeft) + wait + '</div>' + bar + (q.waitingOn ? '<div class="opt-desc">Kept ready — it will forge as soon as ' + q.waitingOn + ' is released.</div>' : '') + '</div><button class="btn btn-sm" onclick="FP.UI.act(\'cancelProduce\',{id:\'' + q.id + '\'})">Cancel</button></div>';
    }).join('');
    openModal('The Forge', html, modalForge);
  }
  function qualColor(q) { return q >= 2.5 ? '#ffd54a' : q >= 1.6 ? '#a99bff' : q >= 1.1 ? '#6fae5f' : q >= 0.9 ? '#cfc3a6' : q >= 0.7 ? '#d9a441' : '#c8553d'; }
  function qualPct(q) { return '×' + q.toFixed(2); }
  function qualName(q) { return q >= 2.5 ? '🌟 Legendary' : q >= 1.6 ? '✨ Excellent' : q >= 1.1 ? '🔵 Good' : q >= 0.9 ? '⚪ Standard' : q >= 0.7 ? '🟠 Poor' : '🔴 Awful'; }
  function qualBadge(q) { return '<span style="color:' + qualColor(q) + '">' + qualName(q) + ' ×' + q.toFixed(2) + '</span>'; }
  function qualGlyph(q) { return q >= 2.5 ? '🌟' : q >= 1.6 ? '✨' : q >= 1.1 ? '🔵' : q >= 0.9 ? '⚪' : q >= 0.7 ? '🟠' : '🔴'; }
  // Summarise an array of individual quality numbers into "🌟×2 ⚪×3" (best→worst), coloured.
  function qualMix(arr) {
    if (!arr || !arr.length) return '';
    const order = ['🌟', '✨', '🔵', '⚪', '🟠', '🔴']; const cnt = {};
    for (const q of arr) { const g = qualGlyph(q); cnt[g] = (cnt[g] || 0) + 1; }
    return order.filter((g) => cnt[g]).map((g) => '<span style="font-size:11px">' + g + '×' + cnt[g] + '</span>').join(' ');
  }
  // Quality badge for the equipment a unit type relies on (for the Commander's view).
  function weaponQualityBadge(team, unitType) {
    const w = B.UNIT_WEAPON[unitType]; if (!w) return '';
    const have = Math.round((team.equipment && team.equipment[w]) || 0);
    if (have <= 0) return '';
    const q = (team.equipQuality && team.equipQuality[w]) || 1;
    return ' · ' + (C.EQUIP_META[w] ? C.EQUIP_META[w].glyph : '') + ' ' + qualBadge(q);
  }

  // ---- Blacksmith forging minigame ----
  let mg = null;
  // A random horizontal centre for the yellow/green target band, kept fully on the bar (and off the
  // extreme edges where the ball starts) — the band is repositioned after every strike.
  function randomForgeCenter() {
    const half = B.FORGE_ZONES.yellowFrac / 2;
    const lo = Math.max(half, 0.15), hi = Math.min(1 - half, 0.85);
    return lo + Math.random() * (hi - lo);
  }
  function forgeMinigame(item, qty) {
    const recipe = B.RECIPES[item]; if (!recipe) return;
    const clicks = Math.max(1, Math.round(recipe.time));
    if (mg && mg.raf) cancelAnimationFrame(mg.raf);
    mg = { item, qty, clicks, left: clicks, score: 0, pos: 0, dir: 1, last: 0, speed: 92, raf: null, done: false, center: randomForgeCenter() };
    renderMinigame();
  }
  function renderMinigame() {
    const Z = B.FORGE_ZONES; const meta = C.EQUIP_META[mg.item] || { glyph: '🏹', name: 'Arrows' };
    const c = mg.center;
    const yL = (c - Z.yellowFrac / 2) * 100, yW = Z.yellowFrac * 100;
    const gL = (c - Z.greenFrac / 2) * 100, gW = Z.greenFrac * 100;
    const maxScore = mg.clicks * Z.scoreGreen;
    const html = '<div class="muted">Strike when the ⚪ ball is in the <b style="color:#6fae5f">green</b> (+' + Z.scoreGreen + '), <b style="color:#d9a441">yellow</b> (+' + Z.scoreYellow + '), or red (+' + Z.scoreRed + '). The target <b>moves after each strike</b>. ' + mg.clicks + ' strikes. Click fast and quality suffers!</div>' +
      '<div class="forge-bar" id="forgeBar"><div class="fz-yellow" id="forgeYellow" style="left:' + yL + '%;width:' + yW + '%"></div><div class="fz-green" id="forgeGreen" style="left:' + gL + '%;width:' + gW + '%"></div><div class="fz-hit" id="forgeHit"></div><div class="fz-ball" id="forgeBall"></div></div>' +
      '<div class="forge-flash" id="forgeFlash">&nbsp;</div>' +
      '<div class="forge-stat">Strikes left: <b id="fgLeft">' + mg.left + '</b> · Score: <b id="fgScore">' + mg.score + '</b> / ' + maxScore + '</div>' +
      '<button class="btn btn-gold" id="forgeStrike" style="width:100%;font-size:16px;padding:10px">⚒️ Strike ' + meta.glyph + '</button>' +
      '<div class="muted" style="font-size:11px;margin-top:6px">Close this window to cancel the forge.</div>';
    openModal('⚒️ Forge ' + meta.name, html, null);
    setTimeout(() => { const btn = $('forgeStrike'); if (btn) btn.onclick = forgeStrike; const bar = $('forgeBar'); if (bar) bar.onclick = forgeStrike; }, 0);
    mg.last = performance.now();
    const loop = (t) => {
      if (!mg || mg.done || $('modal').classList.contains('hidden')) { if (mg && $('modal').classList.contains('hidden') && !mg.done) mg = null; return; }
      const dt = Math.min(0.05, (t - mg.last) / 1000); mg.last = t;
      mg.pos += mg.dir * mg.speed * dt;
      if (mg.pos >= 100) { mg.pos = 100; mg.dir = -1; } else if (mg.pos <= 0) { mg.pos = 0; mg.dir = 1; }
      const ball = $('forgeBall'); if (ball) ball.style.left = mg.pos + '%';
      mg.raf = requestAnimationFrame(loop);
    };
    mg.raf = requestAnimationFrame(loop);
  }
  function forgeStrike() {
    if (!mg || mg.done) return;
    const Z = B.FORGE_ZONES;
    const c = mg.center;
    const gL = (c - Z.greenFrac / 2) * 100, gR = (c + Z.greenFrac / 2) * 100;
    const yL = (c - Z.yellowFrac / 2) * 100, yR = (c + Z.yellowFrac / 2) * 100;
    const p = mg.pos;
    const inGreen = p >= gL && p <= gR, inYellow = p >= yL && p <= yR;
    const pts = inGreen ? Z.scoreGreen : inYellow ? Z.scoreYellow : Z.scoreRed;
    mg.score += pts;
    // Show exactly where the strike landed + what it scored, so timing is learnable.
    const hit = $('forgeHit'); if (hit) { hit.style.left = p + '%'; hit.style.opacity = '1'; setTimeout(() => { if (hit) hit.style.opacity = '0'; }, 400); }
    const flash = $('forgeFlash');
    if (flash) { flash.textContent = (inGreen ? '+' + pts + ' GREEN!' : inYellow ? '+' + pts + ' yellow' : '+' + pts + ' red'); flash.style.color = inGreen ? '#6fae5f' : inYellow ? '#d9a441' : '#c8553d'; flash.classList.remove('pop'); void flash.offsetWidth; flash.classList.add('pop'); }
    mg.left -= 1; mg.pos = 0; mg.dir = 1; // reset ball to the left
    // Relocate the target band for the next strike (same sizes, green stays centred in yellow).
    mg.center = randomForgeCenter();
    const yEl = $('forgeYellow'), gEl = $('forgeGreen');
    if (yEl) yEl.style.left = ((mg.center - Z.yellowFrac / 2) * 100) + '%';
    if (gEl) gEl.style.left = ((mg.center - Z.greenFrac / 2) * 100) + '%';
    if ($('fgLeft')) $('fgLeft').textContent = mg.left;
    if ($('fgScore')) $('fgScore').textContent = mg.score;
    if (mg.left <= 0) finishMinigame();
  }
  function finishMinigame() {
    mg.done = true; if (mg.raf) cancelAnimationFrame(mg.raf);
    const team = State.teamState();
    const maxScore = mg.clicks * B.FORGE_ZONES.scoreGreen;
    const rawPct = maxScore > 0 ? mg.score / maxScore : 0;
    // Mirror the server's specialist bonus so the toast shows the quality the player will actually get.
    let pct = rawPct, specced = false;
    if (team && team.blacksmithSpec === mg.item && rawPct < B.SPEC_QUALITY_THRESHOLD) { pct = Math.min(1, rawPct + B.SPEC_QUALITY_BONUS); specced = true; }
    const tier = B.qualityTier(pct);
    Net.action('produce', { item: mg.item, qty: mg.qty, qPct: rawPct });
    toast(tier.glyph + ' ' + tier.name + ' ' + (C.EQUIP_META[mg.item] ? C.EQUIP_META[mg.item].name : mg.item) + '! (×' + tier.mult + ' effect)' + (specced ? ' · +10% specialist bonus' : ''));
    const item = mg.item; mg = null;
    modalForge();
  }
  function contractGoalStr(goal) { return Object.keys(goal).map((k) => goal[k] + ' ' + (C.EQUIP_META[k] ? C.EQUIP_META[k].name : k)).join(' + '); }
  function modalContracts() {
    const team = State.teamState(); let html = '';
    if (team.contract) {
      const goals = team.contract.goals || (team.contract.goalItem ? { [team.contract.goalItem]: team.contract.goalQty } : {});
      const prog = team.contract.progress || {};
      const rows = Object.keys(goals).map((k) => { const have = typeof prog === 'object' ? (prog[k] || 0) : prog; const need = goals[k]; const done = have >= need; return '<span style="color:' + (done ? '#6fae5f' : '#d9a441') + '">' + (C.EQUIP_META[k] ? C.EQUIP_META[k].glyph + ' ' : '') + Math.min(have, need) + '/' + need + ' ' + (C.EQUIP_META[k] ? C.EQUIP_META[k].name : k) + (done ? ' ✓' : '') + '</span>'; }).join(' · ');
      html += '<div class="opt" style="border-color:#c4a35a"><div class="opt-info"><div class="opt-name">📋 ' + esc(team.contract.name) + '</div><div class="opt-desc">' + rows + ' · ⏳ ' + Math.ceil(team.contract.timeLeft) + 's left · reward ' + costStr(team.contract.reward) + '</div></div></div>';
      html += '<div class="muted" style="font-size:11px;margin-top:4px">Finish the current contract before taking another. Focus the forge on its goal items.</div>';
    } else {
      html += '<div class="muted" style="font-size:11px;margin-bottom:4px">Three contracts are on offer; the set rotates in <b>' + (team.contractOffersIn || 0) + 's</b>. They want a LOT — focus the forge (and have the inputs) to finish in time.</div>';
      const offers = (team.contractOffers && team.contractOffers.length) ? team.contractOffers : B.CONTRACTS.slice(0, 3).map((c) => c.id);
      for (const id of offers) { const c = B.CONTRACTS.find((x) => x.id === id); if (!c) continue;
        const mixed = Object.keys(c.goal).length > 1;
        html += optRow((mixed ? '🎯 ' : '') + c.name + (mixed ? ' <span class="muted">(mixed)</span>' : ''), 'Forge ' + contractGoalStr(c.goal) + ' in ' + c.time + 's', 'Reward: ' + costStr(c.reward), 'Accept', () => Net.action('startContract', { id: c.id }), team.contractCooldown > 0); }
    }
    if (team.contractCooldown > 0) html += '<div class="muted">Contracts on cooldown (' + Math.ceil(team.contractCooldown) + 's).</div>';
    const hist = (team.contractHistory || []).slice(0, 3);
    if (hist.length) {
      html += '<div class="rp-h">Recent contracts</div>';
      html += hist.map((h) => '<div class="sel-row" style="font-size:11px"><span>' + esc(h.name) + '</span><span style="color:' + (h.result === 'success' ? '#6fae5f' : '#c8553d') + '">' + (h.result === 'success' ? '✓ Fulfilled' : '✗ Failed') + '</span></div>').join('');
    }
    openModal('Forge Contracts', html, modalContracts);
  }
  function modalSpec() {
    const snap = State.snapshot, team = State.teamState();
    const cd = Math.max(0, Math.ceil((team.blacksmithSpecCooldownUntil || 0) - snap.elapsed));
    const onCd = team.blacksmithSpec && cd > 0;
    let html = '<div class="muted">Pick <b>one item</b> to specialise in — your forge makes it <b>10% faster</b>. Current: <b>' + (team.blacksmithSpec ? B.BLACKSMITH_SPECS[team.blacksmithSpec].name : 'none') + '</b>.' +
      (onCd ? ' <span style="color:#d9a441">Change available in ' + Math.floor(cd / 60) + ':' + String(cd % 60).padStart(2, '0') + '.</span>' : ' Changing locks the focus for 3 minutes.') + '</div>';
    for (const k in B.BLACKSMITH_SPECS) { const s = B.BLACKSMITH_SPECS[k]; html += optRow((s.glyph ? s.glyph + ' ' : '') + s.name, s.desc, '', team.blacksmithSpec === k ? 'Active' : 'Focus', () => Net.action('setSpec', { spec: k }), team.blacksmithSpec === k || onCd, onCd ? 'On cooldown' : ''); }
    openModal('Forge Specialization', html, modalSpec);
  }

  function modalMuster() {
    const snap = State.snapshot, team = State.teamState();
    const recruits = Math.round(team.pop.recruits);
    const barracks = []; for (const id in snap.areas) { const a = snap.areas[id]; if (a.owner === State.myTeam && (a.buildings.barracks || 0) > 0) barracks.push(a); }
    if (!trainTarget || !snap.areas[trainTarget] || (snap.areas[trainTarget].buildings.barracks || 0) <= 0) trainTarget = barracks[0] ? barracks[0].id : null;
    let html = enemyIntelLine() + '<div class="muted">🎖️ Recruits: <b>' + recruits + '</b> (the Lord levies these) · 👷 Trainers: <b>' + team.pop.trainers + '</b> (the Lord assigns them at a Barracks)<br>Each Trainer trains one recruit into a soldier in <b>~15s</b> (max 2 per Barracks, concurrent). Pick a Barracks, then a unit type — <b>new troops muster at that Barracks</b>.</div>';
    if (!barracks.length) { html += '<div class="opt"><div class="opt-info muted">No Barracks yet — ask the Lord to build one.</div></div>'; openModal('Train Troops', html, modalMuster); return; }
    if (team.pop.trainers <= 0) html += '<div class="opt" style="border-color:#7a4a2c"><div class="opt-info"><div class="opt-name" style="color:#d9a441">No Trainers assigned</div><div class="opt-desc">Ask the Lord to assign Trainers at a Barracks, or training will not progress.</div></div></div>';
    // Barracks picker.
    html += '<div class="loc-picker">' + barracks.map((a) => '<button class="btn btn-sm ' + (a.id === trainTarget ? 'btn-gold' : '') + '" onclick="FP.UI.trainAt(\'' + a.id + '\')">' + (a.terrain === 'base' ? '♜ ' : '') + a.name + ' (' + a.buildings.barracks + '⚒)</button>').join('') + '</div>';
    for (const u of C.UNITS) {
      const meta = C.UNIT_META[u]; const needs = meta.needs || {};
      let max = recruits; const reasons = [];
      if (u === 'cavalry' && team.buildings.stables <= 0) { max = 0; reasons.push('needs Stables'); }
      if (u === 'catapult' && team.buildings.workshop <= 0) { max = 0; reasons.push('needs Workshop'); }
      for (const k in needs) { const have = (team.equipment[k] !== undefined) ? team.equipment[k] : (team.resources[k] || 0); max = Math.min(max, Math.floor(have / needs[k])); }
      const needList = Object.keys(needs).length ? Object.keys(needs).map((k) => (C.RESOURCE_META[k] ? C.RESOURCE_META[k].glyph : (C.EQUIP_META[k] ? C.EQUIP_META[k].glyph : '')) + k).join(' + ') : 'no gear';
      const desc = 'Needs 1 recruit' + (Object.keys(needs).length ? ' + ' + needList : '') + ' each · ' + (UNIT_HINT[u] || '') + '. ' + (reasons.length ? reasons.join(', ') + '.' : 'You can train ' + max + ' now.') + weaponQualityBadge(team, u);
      const n = Math.min(4, Math.max(1, max || 1));
      html += optRow(meta.glyph + ' ' + meta.name + (max > 0 ? ' <span class="muted">(can train ' + max + ')</span>' : ''), desc, '',
        max > 0 ? 'Train ×' + n : 'Train', () => Net.action('trainUnits', { area: trainTarget, unitType: u, count: n }), max < 1 || team.pop.trainers <= 0);
    }
    // Upgrade existing militia into better troops (uses gear + Trainers, just like training a recruit).
    const militiaHere = (() => { let n = 0; for (const g of team.armies) { const at = g.moving ? null : g.area; if (at === trainTarget) n += g.units.militia || 0; } return n; })();
    html += '<div class="rp-h">⬆️ Upgrade militia</div>';
    if (militiaHere <= 0) html += '<div class="muted" style="font-size:11px">No 🪧 militia at ' + (snap.areas[trainTarget] ? snap.areas[trainTarget].name : 'this Barracks') + '. Move militia here (Army → reorganise) to re-forge them into better troops.</div>';
    else {
      html += '<div class="muted" style="font-size:11px">🪧 <b>' + militiaHere + '</b> militia here can be re-forged into better troops if you have the gear (Trainers do the work).</div>';
      for (const u of C.UNITS) {
        if (u === 'militia') continue;
        const meta = C.UNIT_META[u]; const needs = meta.needs || {};
        let max = militiaHere; const reasons = [];
        if (u === 'cavalry' && team.buildings.stables <= 0) { max = 0; reasons.push('needs Stables'); }
        if (u === 'catapult' && team.buildings.workshop <= 0) { max = 0; reasons.push('needs Workshop'); }
        for (const k in needs) { const have = (team.equipment[k] !== undefined) ? team.equipment[k] : (team.resources[k] || 0); max = Math.min(max, Math.floor(have / needs[k])); }
        const needList = Object.keys(needs).length ? Object.keys(needs).map((k) => (C.RESOURCE_META[k] ? C.RESOURCE_META[k].glyph : (C.EQUIP_META[k] ? C.EQUIP_META[k].glyph : '')) + k).join(' + ') : 'no gear';
        const n = Math.min(4, Math.max(1, max || 1));
        html += optRow('🪧 → ' + meta.glyph + ' ' + meta.name + (max > 0 ? ' <span class="muted">(up to ' + max + ')</span>' : ''), 'Spend ' + needList + ' per militia. ' + (reasons.length ? reasons.join(', ') + '.' : ''), '',
          max > 0 ? 'Upgrade ×' + n : 'Upgrade', () => Net.action('upgradeUnits', { area: trainTarget, unitType: u, count: n }), max < 1 || team.pop.trainers <= 0, reasons[0] || (team.pop.trainers <= 0 ? 'Need Trainers' : ''));
      }
    }
    // Training in progress.
    if (team.training && team.training.length) {
      html += '<div class="rp-h">In training</div>';
      for (const t of team.training) html += '<div class="opt"><div class="opt-info"><div class="opt-name">' + C.UNIT_META[t.unitType].glyph + ' ' + C.UNIT_META[t.unitType].name + ' ×' + t.count + ' <span class="muted">@ ' + (snap.areas[t.area] ? snap.areas[t.area].name : '?') + '</span></div><div class="opt-desc">' + Math.round((t.progress || 0) * 100) + '% to next</div></div><button class="btn btn-sm" onclick="FP.UI.act(\'cancelTraining\',{id:\'' + t.id + '\'})">Cancel</button></div>';
    }
    openModal('Train Troops', html, modalMuster);
  }
  // Compact enemy composition + counter hint (for the Commander's order screen).
  function enemyIntelLine() {
    const snap = State.snapshot, enemy = snap.teams[State.enemyTeam()];
    const comp = {}; let total = 0;
    for (const u of C.UNITS) { comp[u] = 0; for (const g of enemy.armies) comp[u] += g.units[u] || 0; total += comp[u]; }
    if (total < 0.5) return '<div class="muted" style="font-size:11px">🔎 No enemy troops sighted yet.</div>';
    const parts = C.UNITS.filter((u) => Math.round(comp[u])).map((u) => C.UNIT_META[u].glyph + Math.round(comp[u]));
    const share = (u) => comp[u] / total;
    let hint = 'mixed force';
    if (share('cavalry') >= 0.25) hint = 'cavalry-heavy → train 🔱 Spearmen';
    else if (share('archer') >= 0.25) hint = 'archer-heavy → train 🐎 Cavalry';
    else if (share('spearman') + share('swordsman') >= 0.5) hint = 'infantry-heavy → train 🏹 Archers';
    return '<div class="mil-alert yellow" style="font-size:11px">🔎 Enemy: ' + parts.join(' ') + ' · <b>' + hint + '</b></div>';
  }
  function modalOrders() {
    const team = State.teamState(); let html = enemyIntelLine() + '<div class="muted">Select a host, then give an order. Or click the map + use the right panel.</div>';
    for (const g of team.armies) { let n = 0; for (const x of C.UNITS) n += g.units[x] || 0; if (n < 0.5) continue;
      html += '<div class="opt"><div class="opt-info"><div class="opt-name">' + g.name + ' (' + Math.round(n) + ') <span class="muted">' + (g.mission ? g.mission.type : '') + '</span></div>' +
        '<div class="opt-desc">' + B.FORMATIONS[g.formation].name + ' <span class="muted">(' + formationFx(g.formation) + ')</span> · ' + B.STANCES[g.stance].name + ' <span class="muted">(' + stanceFx(g.stance) + ')</span></div></div>' +
        '<div style="display:flex;flex-direction:column;gap:4px">' +
        '<button class="btn btn-sm" onclick="FP.UI.cmd(\'' + g.id + '\',\'defend\')">Defend Keep</button>' +
        '<button class="btn btn-sm" onclick="FP.UI.cmd(\'' + g.id + '\',\'siege\')">Siege Enemy</button>' +
        '<button class="btn btn-sm" onclick="FP.UI.cmd(\'' + g.id + '\',\'escort\')">Escort Caravan</button></div></div>';
      html += '<div class="opt"><div class="opt-info muted">Formation / Stance for ' + g.name + '</div><div style="display:flex;gap:4px;flex-wrap:wrap">' +
        Object.keys(B.FORMATIONS).map((f) => '<button class="btn btn-sm" title="' + esc(B.FORMATIONS[f].name + ': ' + formationFx(f)) + '" onclick="FP.UI.act(\'setFormation\',{groupId:\'' + g.id + '\',formation:\'' + f + '\'})">' + B.FORMATIONS[f].name + '</button>').join('') +
        Object.keys(B.STANCES).map((s) => '<button class="btn btn-sm" title="' + esc(B.STANCES[s].name + ': ' + stanceFx(s)) + '" onclick="FP.UI.act(\'setStance\',{groupId:\'' + g.id + '\',stance:\'' + s + '\'})">' + B.STANCES[s].name + '</button>').join('') + '</div></div>';
    }
    openModal('Army Orders', html, modalOrders);
  }
  function modalDoctrine() {
    const snap = State.snapshot, team = State.teamState();
    const cd = Math.max(0, Math.ceil((team.doctrineCooldownUntil || 0) - snap.elapsed));
    const onCd = team.doctrine && cd > 0;
    let html = '<div class="muted">Pick one doctrine. Current: <b>' + (team.doctrine ? B.DOCTRINES[team.doctrine].name : 'none') + '</b>.' +
      (onCd ? ' <span style="color:#d9a441">Change available in ' + Math.floor(cd / 60) + ':' + String(cd % 60).padStart(2, '0') + '.</span>' : ' Changing locks the doctrine for 3 minutes.') + '</div>';
    for (const k in B.DOCTRINES) { const d = B.DOCTRINES[k]; html += optRow(d.name, d.desc, '', team.doctrine === k ? 'Active' : 'Adopt', () => Net.action('setDoctrine', { doctrine: k }), team.doctrine === k || onCd); }
    openModal('Commander Doctrine', html, modalDoctrine);
  }

  // ---- Commander Army Management hub ----
  let armyUI = { expanded: null, src: null, dst: 'new', amt: {} };
  function dominantGlyphC(g) { let best = 'militia', bv = -1; for (const u of C.UNITS) { if ((g.units[u] || 0) > bv) { bv = g.units[u] || 0; best = u; } } return (C.UNIT_META[best] || {}).glyph || '⚔'; }
  function hostArea(snap, g) { const id = g.moving ? g.moving.route[g.moving.legIndex] : g.area; return id; }
  function modalArmyManage() {
    const team = State.teamState(), snap = State.snapshot;
    const hosts = team.armies.filter((g) => armyCount(g) >= 0.5);
    if (!hosts.find((h) => h.id === armyUI.src)) { armyUI.src = hosts[0] ? hosts[0].id : null; armyUI.amt = {}; }
    if (State.selectedGroupId && !hosts.find((h) => h.id === State.selectedGroupId)) State.selectedGroupId = null;
    const total = {}; let totalN = 0, armored = 0;
    for (const u of C.UNITS) total[u] = 0;
    for (const g of hosts) { let hn = 0; for (const u of C.UNITS) { total[u] += g.units[u] || 0; hn += g.units[u] || 0; } if (g.hasArmor) armored += hn; }
    for (const u of C.UNITS) totalN += total[u];

    let html = '<div class="mil-summary">⚔️ <b>' + Math.round(totalN) + '</b> soldiers across <b>' + hosts.length + '</b> host' + (hosts.length === 1 ? '' : 's') + (armored ? ' · 🛡️ ' + Math.round(armored) + ' armoured' : '') +
      '<br><span style="font-size:11px">Tip: left-click a host on the map, then right-click a location to march/attack there. Max 20 effective units per location.</span></div>';

    html += modalSection('Total composition');
    if (totalN > 0) { for (const u of C.UNITS) { if (!Math.round(total[u])) continue; const m = C.UNIT_META[u]; const pct = Math.round(total[u] / totalN * 100);
      html += '<div class="mil-bar-row"><span class="mil-bar-lab">' + m.glyph + ' ' + m.name + '</span><span class="mil-bar"><span class="mil-bar-fill" style="width:' + pct + '%"></span></span><b>' + Math.round(total[u]) + '</b>' + weaponQualityBadge(team, u) + '</div>'; }
      const aq = (team.equipQuality && team.equipQuality.armor) || 1; const aSave = Math.min(B.ARMOR_SAVE_MAX, B.ARMOR_SAVE_BASE * aq);
      html += '<div class="mil-bar-row" style="border-top:1px solid #3a2f1e;margin-top:3px;padding-top:3px"><span class="mil-bar-lab">🛡️ Armour</span><span class="muted" style="font-size:10px">' + Math.round(armored) + '/' + Math.round(totalN) + ' troops armoured</span>' + (armored > 0 ? ' ' + qualBadge(aq) + ' <span class="muted" style="font-size:10px">(' + Math.round(aSave * 100) + '% save)</span>' : '') + '</div>';
      html += '<div class="muted" style="font-size:10px">Quality is forged by the Blacksmith and shared by every soldier of that type — better weapons add attack, better armour adds defence + a chance to shrug off a killing blow.</div>';
    } else html += '<div class="muted" style="font-size:11px">No standing troops yet — train some at a Barracks.</div>';

    html += modalSection('Hosts (' + hosts.length + ')');
    const sorted = hosts.slice().sort((a, b) => (a.isGarrison ? 1 : 0) - (b.isGarrison ? 1 : 0));
    for (const g of sorted) {
      const n = armyCount(g); const loc = snap.areas[hostArea(snap, g)] ? snap.areas[hostArea(snap, g)].name : '?'; const exp = armyUI.expanded === g.id;
      const pw = g.power || { atk: 0, def: 0 };
      html += '<div class="opt"><div class="opt-info" style="cursor:pointer" onclick="FP.UI.armyExpand(\'' + g.id + '\')">' +
        '<div class="opt-name">' + (exp ? '▾ ' : '▸ ') + dominantGlyphC(g) + ' ' + esc(g.name) + (g.isGarrison ? ' <span class="muted">(Home Garrison)</span>' : '') + '</div>' +
        '<div class="opt-desc">' + Math.round(n) + ' units · <b title="total attack">⚔️' + pw.atk + '</b> / <b title="total defence">🛡' + pw.def + '</b> · 📍' + esc(loc) + ' · ' + missionLabel(g) + ' · 💪' + (g.morale || 'normal') + '</div></div>' +
        '<button class="btn btn-sm ' + (State.selectedGroupId === g.id ? 'btn-gold' : '') + '" onclick="FP.UI.selectHost(\'' + g.id + '\')">' + (State.selectedGroupId === g.id ? '✓ Selected' : 'Select') + '</button></div>';
      if (exp) {
        html += '<div class="host-detail">';
        const gear = g.gear || {};
        for (const u of C.UNITS) { const cn = Math.round(g.units[u] || 0); if (!cn) continue; const m = C.UNIT_META[u]; const w = B.UNIT_WEAPON[u];
          const recs = gear[u] || []; const wmix = w ? qualMix(recs.map((r) => r.w)) : '';
          html += '<div class="sel-row" style="font-size:11px"><span>' + m.glyph + ' ' + m.name + ' <b>' + cn + '</b></span><span>' + (w ? '<span class="muted" style="font-size:9px">' + (C.EQUIP_META[w] ? C.EQUIP_META[w].name : w) + ':</span> ' + (wmix || '—') : '<span class="muted" style="font-size:9px">no weapon</span>') + '</span></div>'; }
        html += '</div>';
        // Per-soldier armour summary.
        const allRecs = []; for (const u of C.UNITS) for (const r of (gear[u] || [])) allRecs.push(r);
        const armRecs = allRecs.filter((r) => r.a > 0); const amix = qualMix(armRecs.map((r) => r.a));
        html += '<div class="muted" style="font-size:10px;margin:2px 0">🛡️ Armour: ' + (armRecs.length ? '<b>' + armRecs.length + '/' + allRecs.length + '</b> armoured · ' + amix : 'none — ask the Blacksmith to forge Armour') + ' <span class="muted">(saves ' + Math.round(B.ARMOR_SAVE_BASE * 100) + '–' + Math.round(B.ARMOR_SAVE_MAX * 100) + '% by quality)</span></div>';
        // Each individual soldier with their own weapon & armour.
        let roster = '';
        for (const u of C.UNITS) { const m = C.UNIT_META[u]; const w = B.UNIT_WEAPON[u]; for (const rec of (gear[u] || [])) {
          const broken = w && rec.w < 0.5;
          const wpart = w ? (broken ? '<span style="color:#c8553d" title="weapon broken — re-equip!">✖</span>' : '<span title="' + (C.EQUIP_META[w] ? C.EQUIP_META[w].name : w) + ' ×' + rec.w.toFixed(2) + '">' + qualGlyph(rec.w) + '</span>') : '';
          const apart = rec.a > 0 ? ' <span title="armour ×' + rec.a.toFixed(2) + '">🛡' + qualGlyph(rec.a) + '</span>' : '';
          roster += '<span class="ucip" style="font-size:11px">' + m.glyph + (wpart ? ' ' + wpart : '') + apart + '</span>';
        } }
        html += '<div class="muted" style="font-size:10px;margin-top:3px">Each soldier (weapon · 🛡 armour):</div><div class="host-detail" style="max-height:120px;overflow:auto">' + (roster || '<span class="muted">—</span>') + '</div>';
        html += '<div class="host-ctrl"><button class="btn btn-sm btn-gold" onclick="FP.UI.reequip(\'' + g.id + '\')">🛠️ Re-equip from armoury</button> <span class="muted" style="font-size:10px">give the best stocked weapons/armour to the worst-equipped</span></div>';
        html += '<div class="host-ctrl">Formation: ' + Object.keys(B.FORMATIONS).map((f) => '<button class="btn btn-xs ' + (g.formation === f ? 'btn-gold' : '') + '" onclick="FP.UI.armyForm(\'' + g.id + '\',\'' + f + '\')">' + B.FORMATIONS[f].name + '</button>').join(' ') + '</div>';
        html += '<div class="host-ctrl">Stance: ' + Object.keys(B.STANCES).map((s) => '<button class="btn btn-xs ' + (g.stance === s ? 'btn-gold' : '') + '" onclick="FP.UI.armyStance(\'' + g.id + '\',\'' + s + '\')">' + B.STANCES[s].name + '</button>').join(' ') + '</div>';
        html += '<div class="host-ctrl">Orders: <button class="btn btn-xs" onclick="FP.UI.cmdMng(\'' + g.id + '\',\'defend\')">Defend Keep</button> <button class="btn btn-xs" onclick="FP.UI.cmdMng(\'' + g.id + '\',\'siege\')">Siege Enemy</button> <button class="btn btn-xs" onclick="FP.UI.cmdMng(\'' + g.id + '\',\'escort\')">Escort</button></div>';
      }
    }

    html += modalSection('Reorganise forces');
    if (!hosts.length) html += '<div class="muted" style="font-size:11px">No hosts to reorganise.</div>';
    else {
      const src = hosts.find((h) => h.id === armyUI.src) || hosts[0];
      html += '<div class="host-ctrl">From: ' + hosts.map((h) => '<button class="btn btn-xs ' + (src.id === h.id ? 'btn-gold' : '') + '" onclick="FP.UI.armySrc(\'' + h.id + '\')">' + esc(h.name) + ' (' + Math.round(armyCount(h)) + ')</button>').join(' ') + '</div>';
      const dests = hosts.filter((h) => h.id !== src.id && !h.moving && !src.moving && hostArea(snap, h) === hostArea(snap, src));
      if (armyUI.dst !== 'new' && !dests.find((h) => h.id === armyUI.dst)) armyUI.dst = 'new';
      html += '<div class="host-ctrl">To: <button class="btn btn-xs ' + (armyUI.dst === 'new' ? 'btn-gold' : '') + '" onclick="FP.UI.armyDst(\'new\')">＋ New host here</button> ' + dests.map((h) => '<button class="btn btn-xs ' + (armyUI.dst === h.id ? 'btn-gold' : '') + '" onclick="FP.UI.armyDst(\'' + h.id + '\')">' + esc(h.name) + '</button>').join(' ') + (dests.length ? '' : ' <span class="muted" style="font-size:10px">(no co-located host — move one here first to merge)</span>') + '</div>';
      let any = false;
      for (const u of C.UNITS) { const have = Math.round(src.units[u] || 0); if (!have) continue; any = true; const m = C.UNIT_META[u]; const a = Math.min(armyUI.amt[u] || 0, have);
        html += '<div class="sel-row"><span>' + m.glyph + ' ' + m.name + ' <span class="muted">(' + have + ')</span></span><span>' +
          '<button class="btn btn-xs" onclick="FP.UI.armyAmt(\'' + u + '\',-1)">−</button> <b style="min-width:18px;display:inline-block;text-align:center">' + a + '</b> <button class="btn btn-xs" onclick="FP.UI.armyAmt(\'' + u + '\',1)">＋</button> ' +
          '<button class="btn btn-xs" onclick="FP.UI.armyAmtSet(\'' + u + '\',-2)">½</button> <button class="btn btn-xs" onclick="FP.UI.armyAmtSet(\'' + u + '\',-1)">All</button></span></div>'; }
      if (!any) html += '<div class="muted" style="font-size:11px">Selected host is empty.</div>';
      const willDisband = src && !src.isGarrison && C.UNITS.every((u) => Math.round(src.units[u] || 0) <= Math.min(armyUI.amt[u] || 0, Math.round(src.units[u] || 0)));
      const dstName = armyUI.dst === 'new' ? 'a new host' : (hosts.find((h) => h.id === armyUI.dst) ? esc(hosts.find((h) => h.id === armyUI.dst).name) : '?');
      html += '<div style="margin-top:6px"><button class="btn btn-gold btn-sm" onclick="FP.UI.armyTransfer()">Move units → ' + dstName + '</button>' +
        (src && src.isGarrison ? '' : (willDisband ? ' <span style="color:#d9a441;font-size:10px">⚠ source host will disband</span>' : '')) + '</div>';
    }
    openModal('⚔️ Army Management', html, modalArmyManage);
  }
  function armySrcHost() { const team = State.teamState(); return team.armies.find((h) => h.id === armyUI.src); }
  function reMng() { refreshOpenModal(); }

  function cap(s) { return s.charAt(0).toUpperCase() + s.slice(1); }
  function esc(s) { return String(s).replace(/[&<>]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;' }[c])); }

  // ---------- Military Overview (any role, read-only; reviewed by mil-review agent) ----------
  const milExpand = {};   // which composition rows (by unit type) are expanded to show each soldier
  // Every individual soldier of one type, across all hosts, with their own weapon & armour quality.
  function compRoster(u, hosts) {
    const w = B.UNIT_WEAPON[u]; const m = C.UNIT_META[u];
    let html = '<div class="host-detail" style="margin:2px 0 6px;max-height:220px;overflow:auto">';
    let any = false;
    for (const g of hosts) {
      const recs = (g.gear && g.gear[u]) || [];
      if (!recs.length) continue;
      any = true;
      const loc = hostAreaName(State.snapshot, g);
      html += '<div class="muted" style="font-size:10px;margin-top:3px">📍 ' + esc(g.name) + ' <span class="muted">(' + esc(loc) + ')</span></div>';
      let i = 0;
      for (const rec of recs) { i++;
        const broken = w && rec.w < 0.5;
        const wlabel = w
          ? (C.EQUIP_META[w] ? C.EQUIP_META[w].glyph + ' ' : '') + (broken ? '<span style="color:#c8553d">✖ broken — re-equip</span>' : qualBadge(rec.w))
          : '<span class="muted">—</span>';
        const alabel = rec.a > 0 ? '🛡 ' + qualBadge(rec.a) : '🛡 <span class="muted">none</span>';
        html += '<div class="sel-row" style="font-size:11px"><span>' + m.glyph + ' ' + m.name + ' <span class="muted">#' + i + '</span></span><span>' + wlabel + ' · ' + alabel + '</span></div>';
      }
    }
    html += '</div>';
    return any ? html : '<div class="muted" style="font-size:11px;margin-bottom:6px">No individual gear records for this type yet.</div>';
  }
  function hostAreaId(g) { return g.moving ? g.moving.route[g.moving.legIndex] : g.area; }
  function hostAreaName(snap, g) { const a = snap.areas[hostAreaId(g)]; return a ? a.name : '?'; }
  function missionLabel(g) {
    const t = (g.mission && g.mission.type) || 'idle';
    const map = { idle: '🛡️ Holding', defend: '🛡️ Defending Keep', garrison: '🚩 Garrisoning', raid: '⚔️ Raiding', attack: '⚔️ Attacking', siege: '🏰 Sieging Keep', escort: '🐎 Escorting caravan' };
    return (map[t] || cap(t)) + (g.moving ? ' (marching)' : '');
  }
  function modalMilitary() {
    const snap = State.snapshot, team = State.teamState(); if (!team) return;
    const enemy = snap.teams[State.enemyTeam()]; const p = team.pop;
    const role = State.myRole;
    const hosts = team.armies.filter((g) => armyCount(g) >= 0.5);
    const comp = {}; for (const u of C.UNITS) comp[u] = 0;
    let totalUnits = 0, armored = 0;
    for (const g of hosts) { let hn = 0; for (const u of C.UNITS) { comp[u] += g.units[u] || 0; hn += g.units[u] || 0; } if (g.hasArmor) armored += hn; }
    for (const u of C.UNITS) totalUnits += comp[u];
    const equip = team.equipment || {};
    const arrows = Math.round(team.resources.arrows || 0);
    const weapons = (equip.spears || 0) + (equip.swords || 0) + (equip.bows || 0);
    const cmSlot = team.slots && team.slots.COMMANDER;
    const cmIsAI = !cmSlot || cmSlot.controller === C.CONTROLLER.AI;
    const persona = team.aiPersona && team.aiPersona.COMMANDER;
    const cmLabel = (cmIsAI ? '🤖 ' : '👤 ') + (cmSlot ? cmSlot.name : 'Commander') + (cmIsAI && persona ? ' (' + (PERSONA_LABEL[persona] || persona) + ')' : '');
    const keepPct = Math.round(team.keep.hp / team.keep.maxHp * 100);
    const enemyKeepPct = Math.round(enemy.keep.hp / enemy.keep.maxHp * 100);
    const scoreDelta = team.score - enemy.score;
    // Posture.
    const miss = hosts.map((g) => (g.mission && g.mission.type) || 'idle');
    let posture = 'No army in the field';
    if (miss.includes('siege')) posture = 'Sieging the enemy Keep';
    else if (miss.some((m) => m === 'raid' || m === 'attack')) posture = 'On the offensive';
    else if (miss.includes('defend')) posture = 'Defending the realm';
    else if (miss.includes('escort')) posture = 'Escorting caravans';
    else if (hosts.length) posture = 'Holding position';
    const arrowRounds = comp.archer > 0 ? Math.floor(arrows / Math.max(1, comp.archer * B.ARCHER_ARROW_USE)) : null;

    // --- Summary ---
    let html = '<div class="mil-summary">Our Keep <b>' + keepPct + '%</b> · Enemy Keep <b>' + enemyKeepPct + '%</b> · Score <b style="color:' + (scoreDelta >= 0 ? '#6fae5f' : '#c8553d') + '">' + (scoreDelta >= 0 ? '+' : '') + scoreDelta + '</b><br>' +
      '⚔️ <b>' + totalUnits + '</b> soldiers · 🎖️ <b>' + Math.round(p.recruits) + '</b> recruits · <b>' + hosts.length + '</b> host' + (hosts.length === 1 ? '' : 's') + ' · Posture: <b>' + posture + '</b><br>' +
      'Commander: ' + esc(cmLabel) + (comp.archer > 0 ? ' · 🏹 arrows for ~' + (arrowRounds != null ? arrowRounds + ' rounds' : '—') : '') + '</div>';

    // --- Alerts (economy-framed, actionable for the Lord) ---
    const alerts = [];
    const occ = enemyNear(snap);
    const defending = hosts.some((g) => (g.mission && g.mission.type) === 'defend' || hostAreaId(g) === (State.myTeam === 'BLUE' ? 'blue_base' : 'red_base'));
    if ((occ || keepPct < 60) && !defending) alerts.push({ c: 'red', t: 'Keep threatened with no host defending — Commander should pull back.' });
    if (enemyKeepPct <= 35) alerts.push({ c: 'green', t: 'Siege opportunity: enemy Keep at ' + enemyKeepPct + '% — mass a host.' });
    if ((team.buildings.barracks || 0) <= 0) alerts.push({ c: 'yellow', t: 'No Barracks — build one (Lord) to train troops.' });
    else if (p.recruits >= 1 && p.trainers <= 0) alerts.push({ c: 'yellow', t: Math.round(p.recruits) + ' recruits idle: assign Trainers at a Barracks (Lord).' });
    if (comp.archer > 0 && arrows < comp.archer) alerts.push({ c: 'yellow', t: 'Archers low on arrows (' + arrows + ' for ' + comp.archer + ') — Blacksmith should forge more.' });
    if ((team.buildings.stables || 0) <= 0 && (team.buildings.barracks || 0) > 0) alerts.push({ c: 'yellow', t: 'No Stables — cavalry unavailable (Lord can build one).' });
    if (state_late(snap) && (team.buildings.workshop || 0) <= 0) alerts.push({ c: 'yellow', t: 'No Workshop — siege Catapults unavailable.' });
    if (p.recruits > weapons + comp.militia && (team.buildings.barracks || 0) > 0) alerts.push({ c: 'yellow', t: 'Army under-equipped: only ' + weapons + ' weapons for ' + Math.round(p.recruits) + ' recruits — Blacksmith should forge gear.' });
    html += '<div class="rp-h">Alerts</div>';
    html += alerts.length ? alerts.map((a) => '<div class="mil-alert ' + a.c + '">' + esc(a.t) + '</div>').join('') : '<div class="muted" style="font-size:11px">No pressing military concerns.</div>';

    // --- Composition ---
    html += '<div class="rp-h">Army composition' + (armored > 0 ? ' <span class="muted">(🛡️ ' + armored + ' armoured)</span>' : '') + '</div>';
    if (totalUnits > 0) {
      for (const u of C.UNITS) { if (!comp[u]) continue; const m = C.UNIT_META[u];
        const pct = Math.round(comp[u] / totalUnits * 100);
        const hasGear = !!B.UNIT_WEAPON[u];              // only equipped types (not militia) expand
        const exp = hasGear && milExpand[u];
        const lab = (hasGear ? (exp ? '▾ ' : '▸ ') : '') + m.glyph + ' ' + m.name;
        const labSpan = hasGear
          ? '<span class="mil-bar-lab" style="cursor:pointer" title="Show each soldier\'s weapon &amp; armour" onclick="FP.UI.milCompToggle(\'' + u + '\')">' + lab + '</span>'
          : '<span class="mil-bar-lab">' + lab + '</span>';
        html += '<div class="mil-bar-row">' + labSpan + '<span class="mil-bar"><span class="mil-bar-fill" style="width:' + pct + '%"></span></span><b>' + comp[u] + '</b></div>';
        if (exp) html += compRoster(u, hosts);
      }
    } else html += '<div class="muted" style="font-size:11px">No standing troops yet.</div>';

    // --- Per-host breakdown: strength + the gear each host's soldiers carry ---
    if (hosts.length) {
      html += '<div class="rp-h">Hosts — strength &amp; gear</div>';
      for (const g of hosts) {
        const pw = g.power || { atk: 0, def: 0 }; const gear = g.gear || {};
        const loc = snap.areas[hostAreaId(g)] ? snap.areas[hostAreaId(g)].name : '?';
        let wbits = [];
        for (const u of C.UNITS) { const cn = Math.round(g.units[u] || 0); if (!cn) continue; const m = C.UNIT_META[u]; const w = B.UNIT_WEAPON[u]; const wmix = w ? qualMix((gear[u] || []).map((r) => r.w)) : ''; wbits.push(m.glyph + cn + (wmix ? ' ' + wmix : '')); }
        const allR = []; for (const u of C.UNITS) for (const r of (gear[u] || [])) allR.push(r); const armN = allR.filter((r) => r.a > 0).length;
        html += '<div class="opt"><div class="opt-info"><div class="opt-name" style="font-size:12px">' + dominantGlyphC(g) + ' ' + esc(g.name) + ' <span class="muted">📍' + esc(loc) + '</span></div>' +
          '<div class="opt-desc"><b title="attack">⚔️' + pw.atk + '</b> / <b title="defence">🛡' + pw.def + '</b> · ' + wbits.join(' · ') + ' · 🛡️' + armN + '/' + allR.length + ' armoured</div></div></div>';
      }
      html += '<div class="muted" style="font-size:10px">Tap a unit type under <b>Army composition</b> above to see each individual soldier\'s weapon &amp; armour, or open the Commander\'s Army screen to re-equip them.</div>';
    }

    // --- Enemy forces (intel) — what they field and how to counter it. ---
    const enemyComp = {}; let enemyTotal = 0;
    for (const u of C.UNITS) enemyComp[u] = 0;
    for (const g of enemy.armies) { for (const u of C.UNITS) { enemyComp[u] += g.units[u] || 0; enemyTotal += g.units[u] || 0; } }
    html += '<div class="rp-h">⚔️ Enemy forces (intel)</div>';
    if (enemyTotal >= 0.5) {
      for (const u of C.UNITS) { if (!Math.round(enemyComp[u])) continue; const m = C.UNIT_META[u];
        const pct = Math.round(enemyComp[u] / enemyTotal * 100);
        html += '<div class="mil-bar-row"><span class="mil-bar-lab">' + m.glyph + ' ' + m.name + '</span><span class="mil-bar"><span class="mil-bar-fill enemy" style="width:' + pct + '%"></span></span><b>' + Math.round(enemyComp[u]) + '</b></div>';
      }
      const share = (u) => enemyComp[u] / enemyTotal;
      let counter = '';
      if (share('cavalry') >= 0.25) counter = 'They lean on 🐎 Cavalry — build 🔱 Spearmen to break the charge.';
      else if (share('archer') >= 0.25) counter = 'They lean on 🏹 Archers — 🐎 Cavalry (or armour) close the distance fast.';
      else if (share('spearman') + share('swordsman') >= 0.5) counter = 'Heavy infantry — 🏹 Archers soften them before they close.';
      else counter = 'A mixed force — keep a balanced, countering army of your own.';
      html += '<div class="mil-alert yellow" style="margin-top:4px">' + counter + '</div>';
    } else html += '<div class="muted" style="font-size:11px">No enemy troops sighted yet.</div>';

    // --- Active hosts ---
    html += '<div class="rp-h">Active hosts (' + hosts.length + ')</div>';
    if (hosts.length) for (const g of hosts) {
      const n = armyCount(g);
      html += '<div class="sel-row"><span>' + esc(g.name) + ' <span class="muted">' + Math.round(n) + ' · 📍' + esc(hostAreaName(snap, g)) + '</span></span><span class="muted" style="font-size:11px">' + missionLabel(g) + ' · 💪 ' + (g.morale || 'normal') + '</span></div>';
    } else html += '<div class="muted" style="font-size:11px">No hosts deployed.</div>';

    // --- Training & manpower ---
    html += '<div class="rp-h">Training &amp; manpower</div>';
    const maxTr = (team.buildings.barracks || 0) * B.TRAINERS_PER_BARRACKS;
    html += '<div class="sel-row"><span>👷 Trainers</span><span>' + p.trainers + ' / ' + maxTr + ' (' + (team.buildings.barracks || 0) + ' Barracks)</span></div>';
    html += '<div class="sel-row"><span>🎖️ Recruit pool</span><span>' + Math.round(p.recruits) + '</span></div>';
    html += '<div class="sel-row"><span>👤 Housing</span><span>' + p.total + ' / ' + team.housing + (p.total >= team.housing ? ' ⚠ full' : '') + '</span></div>';
    if (team.training && team.training.length) for (const t of team.training) html += '<div class="sel-row"><span>' + C.UNIT_META[t.unitType].glyph + ' ' + C.UNIT_META[t.unitType].name + ' ×' + t.count + ' <span class="muted">@ ' + (snap.areas[t.area] ? snap.areas[t.area].name : '?') + '</span></span><span>' + Math.round((t.progress || 0) * 100) + '%</span></div>';
    else html += '<div class="muted" style="font-size:11px">Nothing in training.</div>';

    // --- Equipment stockpile ---
    html += '<div class="rp-h">Equipment stockpile</div>';
    html += '<div class="mil-equip">' + C.EQUIP.map((e) => { const m = C.EQUIP_META[e]; const v = Math.round(equip[e] || 0); const q = (team.equipQuality && team.equipQuality[e]) || 1; const qb = v > 0 ? ' <span style="color:' + qualColor(q) + ';font-size:9px">' + qualName(q).split(' ')[0] + '×' + q.toFixed(1) + '</span>' : ''; return '<span title="' + esc(m.desc + ' — quality ' + qualName(q) + ' (×' + q.toFixed(2) + ' effect)') + '">' + m.glyph + ' ' + (v) + qb + '</span>'; }).join('') + '<span title="Archers consume arrows in battle">🏹arrows ' + arrows + '</span></div>';

    // --- Commander action log ---
    html += '<div class="rp-h">Recent Commander actions</div>';
    const log = team.militaryLog || [];
    html += log.length ? log.map((e) => '<div class="mil-log ' + (e.kind || 'order') + '">' + esc(e.text) + '</div>').join('') : '<div class="muted" style="font-size:11px">No orders issued yet.</div>';

    // --- Requests (nudges, role-separated) ---
    if (role !== 'COMMANDER') {
      html += '<div class="rp-h">Ask the Commander</div><div style="display:flex;gap:5px;flex-wrap:wrap">' +
        '<button class="btn btn-sm" onclick="FP.UI.requestDefend(\'' + (State.myTeam === 'BLUE' ? 'blue_base' : 'red_base') + '\')">Defend the Keep</button>' +
        '<button class="btn btn-sm" onclick="FP.UI.request(\'ESCORT\')">Escort a caravan</button>' +
        '<button class="btn btn-sm" onclick="FP.UI.request(\'EQUIPMENT\')">Arm the troops</button></div>';
    } else {
      html += '<div style="margin-top:8px"><button class="btn btn-gold btn-sm" onclick="FP.UI.modalMuster()">Train troops</button> <button class="btn btn-sm" onclick="FP.UI.modalOrders()">Give orders</button></div>';
    }
    openModal('⚔️ Military Overview', html, modalMilitary);
  }
  function state_late(snap) { return snap.phase === 'LATE'; }

  // ---------- onboarding "How to Play (your role)" ----------
  const ROLE_HELP = {
    LORD: { first: 'Open <b>Workers</b> and assign idle people to Farms, Wood and Mining → <b>Build</b> a Barracks → assign <b>Trainers</b> → <b>Levy</b> a few Soldiers so the Commander can train an army.',
      duties: ['Assign workers (food/wood/mining/builders/students/trainers)', 'Build at locations you own; build Houses to raise the population cap', 'Levy Soldiers (one-way) — committed workers the Commander trains; dead soldiers free housing for new workers', 'Trainers (max 2 per Barracks) set training speed; a School makes Educated workers (reassign in 5s vs 30s)', 'Ration resources & pick a Policy'] },
    STEWARD: { first: 'Click a neighbouring area and <b>Scout</b> it, then <b>Claim</b> a resource site. Sites ship goods home by caravan.',
      duties: ['Explore & claim resource sites', 'Run caravans (ask the Commander to escort them)', 'Upgrade sites for more output', 'Tell teammates which resources are short'] },
    BLACKSMITH: { first: 'Open the <b>Forge</b> and make Tools first, then weapons. Archers also need Arrows!',
      duties: ['Forge tools, weapons, armour & arrows', 'Choose a forge Specialization', 'Take timed Contracts for bonus resources', 'Ask the Steward for iron when low'] },
    COMMANDER: { first: 'Pick a <b>Doctrine</b>, then <b>Train</b> recruits into troops at a Barracks (the Lord supplies recruits + Trainers; the Blacksmith supplies gear). Training takes time.',
      duties: ['Train recruits into troops at a Barracks (speed = Trainers)', 'Choose each unit type (spearman/archer/cavalry…)', 'Move, deploy, escort, defend, raid', 'Mass a host and siege the enemy Keep'] },
  };
  function showHelp() {
    const role = State.myRole || 'LORD'; const h = ROLE_HELP[role]; const meta = C.ROLE_META[role];
    const html =
      '<div class="help-panel"><h3>🎯 The goal</h3><p>Two kingdoms. Win by <b>destroying the enemy Keep</b> ♜ or holding the <b>higher Kingdom Score</b> when the timer ends. To take a location, defeat its defenders, then your army <b>razes its buildings</b> (Walls first, +2× time) — siege engines are far faster, archers slow. Each building razed is worth points (double at a Keep); raze everything at the enemy Keep to win. You and your 3 teammates (human or 🤖 AI) each run one role — coordinate or fall.</p></div>' +
      '<div class="help-panel"><h3>' + meta.glyph + ' You are the ' + meta.name + '</h3><p>' + meta.blurb + '</p><ul>' + h.duties.map((d) => '<li>' + d + '</li>').join('') + '</ul></div>' +
      '<div class="help-panel"><h3>🏛️ Buildings are per-location</h3><p>Every place you own (your <b>Keep</b> = 7 slots, claimed <b>sites</b> = 5) holds a few buildings. Their effects help the <b>whole kingdom</b>, but they are <b>razed if the enemy captures that location</b>. Fill your Keep, then <b>expand</b> to build more.</p></div>' +
      '<div class="help-panel highlight"><h3>▶ Do this first</h3><p>' + h.first + '</p></div>' +
      '<div class="muted">Stuck? The 🧙 <b>Advisor</b> (top-right) and the <b>Guide</b> tab always tell you what to do next. Click resource chips to ask teammates for more of that resource.</div>';
    openModal('How to Play — ' + meta.name, html);
  }
  function maybeFirstRun() {
    if (localStorage.getItem('fp_seen_help_' + (State.myRole || ''))) return;
    localStorage.setItem('fp_seen_help_' + (State.myRole || ''), '1');
    setTimeout(showHelp, 600);
  }

  // ---------- spectator views (watch-only; both kingdoms visible) ----------
  function specResChips(snap, tm) {
    const team = snap.teams[tm];
    const order = ['food', 'wood', 'stone', 'iron', 'horses', 'arrows', 'relics'];
    const col = tm === 'BLUE' ? '#2f5f9f' : '#8b2500';
    const lab = '<div class="res-chip" style="cursor:default;border-color:' + col + '"><span class="rg">' + (tm === 'BLUE' ? '🟦' : '🟥') + '</span><span>' + esc(C.TEAM_META[tm].name.split(' ')[0]) + '</span></div>';
    const chips = order.map((k) => { const m = C.RESOURCE_META[k]; const v = Math.round(team.resources[k] || 0); return '<div class="res-chip" style="cursor:default" title="' + k + '"><span class="rg">' + m.glyph + '</span><span>' + v + '</span></div>'; }).join('');
    const pop = '<div class="res-chip" style="cursor:default" title="Population / housing"><span class="rg">👤</span><span>' + team.pop.total + '/' + team.housing + '</span></div>';
    const army = '<div class="res-chip" title="Soldiers — click for both armies" onclick="FP.UI.modalSpectatorMilitary()"><span class="rg">⚔️</span><span>' + team.pop.soldiers + '</span></div>';
    return lab + chips + pop + army;
  }
  function updateTopSpectator(snap) {
    $('resourceBar').innerHTML = specResChips(snap, 'BLUE') + '<div style="width:14px"></div>' + specResChips(snap, 'RED');
    $('scoreBlue').textContent = snap.teams.BLUE.score;
    $('scoreRed').textContent = snap.teams.RED.score;
    $('phaseLabel').textContent = snap.phase;
    const left = Math.max(0, snap.matchLength - snap.elapsed);
    $('timer').textContent = Math.floor(left / 60) + ':' + String(Math.floor(left % 60)).padStart(2, '0');
    $('objText').textContent = '👁 Spectating — watching both kingdoms.';
    $('threatText').textContent = '';
  }
  function updateLeftSpectator(snap) {
    const teams = State.logFilter === 'ALL' ? ['BLUE', 'RED'] : [State.logFilter];
    // Requests (read-only) for the chosen kingdom(s).
    let openCount = 0, rhtml = '';
    for (const tm of teams) {
      const reqs = snap.teams[tm].requests.filter((r) => r.status === 'open');
      openCount += reqs.length;
      if (reqs.length) {
        rhtml += '<div class="rp-h" style="color:' + (tm === 'BLUE' ? '#8fb8e8' : '#d46a5a') + '">' + esc(C.TEAM_META[tm].name) + '</div>';
        for (const r of reqs) rhtml += '<div class="req-card"><span class="rq-from">' + esc(r.fromName) + '</span> → ' + esc(C.ROLE_META[r.targetRole].name) + ': ' + reqText(r) + '</div>';
      }
    }
    $('reqCount').textContent = openCount;
    $('tab-requests').innerHTML = rhtml || '<div class="muted" style="padding:10px">No open requests right now.</div>';
    // Comms for the chosen kingdom(s) — every player & AI message.
    let chtml = '';
    for (const tm of teams) {
      chtml += '<div class="comms-msg"><b style="color:' + (tm === 'BLUE' ? '#8fb8e8' : '#d46a5a') + '">— ' + esc(C.TEAM_META[tm].name) + ' —</b></div>';
      chtml += snap.teams[tm].comms.slice(-25).map((m) => {
        const badge = m.isAI ? '<span class="badge badge-ai">🤖</span>' : '<span class="badge badge-h">👤</span>';
        return '<div class="comms-msg ' + (m.kind || '') + '">' + badge + ' <span class="cm-name">' + esc(m.fromName) + '</span>: ' + esc(m.text) + '</div>';
      }).join('');
    }
    const cl = $('commsList'); cl.innerHTML = chtml; cl.scrollTop = cl.scrollHeight;
    // Global event log already carries both kingdoms.
    $('logList').innerHTML = snap.events.slice(-50).reverse().map((e) =>
      '<div class="log-line ' + (e.kind || '') + '"><span style="color:' + (e.team === 'BLUE' ? '#8fb8e8' : e.team === 'RED' ? '#d46a5a' : '#a3936f') + '">●</span> ' + esc(e.text) + '</div>').join('');
  }
  function buildSpectatorBar() {
    $('roleTitle').textContent = '👁 Spectator';
    const f = State.logFilter;
    const fb = (val, label) => '<button class="btn" style="' + (f === val ? 'border-color:#c4a35a;color:#e3c578;' : '') + '" onclick="FP.UI.specFilter(\'' + val + '\')">' + label + '</button>';
    $('actionButtons').innerHTML =
      '<div class="muted" style="align-self:center;padding:0 10px">👁 Watching both kingdoms — you cannot take actions.</div>' +
      '<button class="btn" onclick="FP.UI.modalSpectatorMilitary()"><span class="ab-ico">⚔️</span><span>Both Armies</span><span class="ab-sub">composition &amp; gear</span></button>' +
      '<div class="muted" style="align-self:center;padding:0 6px">Feed:</div>' + fb('ALL', 'Both') + fb('BLUE', '🟦 Blue') + fb('RED', '🟥 Red');
    $('quickReq').innerHTML = '';
    const ci = $('chatInput'); if (ci) { ci.disabled = true; ci.value = ''; ci.placeholder = '👁 Spectators watch only — chat disabled'; }
    const cs = $('chatSend'); if (cs) cs.disabled = true;
  }

  // Read-only side-by-side composition + gear + quality of BOTH kingdoms, for spectators.
  function modalSpectatorMilitary() {
    const snap = State.snapshot; if (!snap) return;
    const col = (tm) => {
      const team = snap.teams[tm];
      const hosts = team.armies.filter((g) => armyCount(g) >= 0.5);
      const comp = {}; for (const u of C.UNITS) comp[u] = 0;
      let total = 0, armored = 0;
      for (const g of hosts) { let hn = 0; for (const u of C.UNITS) { comp[u] += g.units[u] || 0; hn += g.units[u] || 0; } if (g.hasArmor) armored += hn; }
      for (const u of C.UNITS) total += comp[u];
      let h = '<div class="rp-h" style="color:' + (tm === 'BLUE' ? '#8fb8e8' : '#d46a5a') + '">' + esc(C.TEAM_META[tm].name) + ' — ⚔️ ' + Math.round(total) + (armored ? ' <span class="muted">(🛡️ ' + armored + ' armoured)</span>' : '') + '</div>';
      if (total > 0) { for (const u of C.UNITS) { if (!Math.round(comp[u])) continue; const m = C.UNIT_META[u]; const pct = Math.round(comp[u] / total * 100); h += '<div class="mil-bar-row"><span class="mil-bar-lab">' + m.glyph + ' ' + m.name + '</span><span class="mil-bar"><span class="mil-bar-fill' + (tm === 'RED' ? ' enemy' : '') + '" style="width:' + pct + '%"></span></span><b>' + Math.round(comp[u]) + '</b></div>'; } }
      else h += '<div class="muted" style="font-size:11px">No standing troops.</div>';
      h += '<div class="rp-h">Hosts (' + hosts.length + ')</div>';
      if (hosts.length) for (const g of hosts) h += '<div class="sel-row"><span>' + esc(g.name) + ' <span class="muted">' + Math.round(armyCount(g)) + (g.hasArmor ? ' 🛡️' : '') + '</span></span><span class="muted" style="font-size:11px">📍' + esc(hostAreaName(snap, g)) + ' · ' + missionLabel(g) + '</span></div>';
      else h += '<div class="muted" style="font-size:11px">No hosts deployed.</div>';
      const equip = team.equipment || {}; const arrows = Math.round(team.resources.arrows || 0);
      h += '<div class="rp-h">Gear &amp; quality</div><div class="mil-equip">' + C.EQUIP.map((e) => { const m = C.EQUIP_META[e]; const v = Math.round(equip[e] || 0); const q = (team.equipQuality && team.equipQuality[e]) || 1; const qb = v > 0 ? ' <span style="color:' + qualColor(q) + ';font-size:9px">' + qualName(q).split(' ')[0] + '×' + q.toFixed(1) + '</span>' : ''; return '<span title="' + esc(m.desc) + '">' + m.glyph + ' ' + v + qb + '</span>'; }).join('') + '<span title="Archer ammunition">🏹arrows ' + arrows + '</span></div>';
      return '<div style="flex:1;min-width:240px">' + h + '</div>';
    };
    openModal('⚔️ Both Armies — Composition &amp; Gear', '<div style="display:flex;gap:18px;flex-wrap:wrap">' + col('BLUE') + col('RED') + '</div>', modalSpectatorMilitary);
  }

  // ---------- host info popup (left-click any host) ----------
  let hostPopupId = null;
  function findHostAny(snap, id) {
    for (const tk of ['BLUE', 'RED']) { const t = snap.teams[tk]; if (!t) continue; for (const g of (t.armies || [])) if (g.id === id) return { g: g, team: tk }; }
    return null;
  }
  function hostPopupHtml(snap, g, team) {
    const meta = C.TEAM_META ? C.TEAM_META[team] : null;
    const color = team === 'BLUE' ? '#8fb8e8' : '#d46a5a';
    const mine = team === State.myTeam;
    const pw = g.power || { atk: 0, def: 0 };
    const n = armyCount(g);
    const loc = snap.areas[hostAreaId(g)] ? snap.areas[hostAreaId(g)].name : '?';
    const gear = g.gear || {};
    let comp = '';
    for (const u of C.UNITS) { const cn = Math.round(g.units[u] || 0); if (!cn) continue; const m = C.UNIT_META[u]; const w = B.UNIT_WEAPON[u]; const wmix = w ? qualMix((gear[u] || []).map((r) => r.w)) : '';
      comp += '<div class="sel-row" style="font-size:11px"><span>' + m.glyph + ' ' + m.name + ' <b>' + cn + '</b></span><span>' + (w ? (wmix || '—') : '<span class="muted" style="font-size:9px">no weapon</span>') + '</span></div>'; }
    const allRecs = []; for (const u of C.UNITS) for (const r of (gear[u] || [])) allRecs.push(r);
    const armRecs = allRecs.filter((r) => r.a > 0); const amix = qualMix(armRecs.map((r) => r.a));
    let roster = '';
    for (const u of C.UNITS) { const m = C.UNIT_META[u]; const w = B.UNIT_WEAPON[u]; for (const rec of (gear[u] || [])) {
      const broken = w && rec.w < 0.5;
      const wpart = w ? (broken ? '<span style="color:#c8553d" title="weapon broken">✖</span>' : '<span title="' + (C.EQUIP_META[w] ? C.EQUIP_META[w].name : w) + ' ×' + rec.w.toFixed(2) + '">' + qualGlyph(rec.w) + '</span>') : '';
      const apart = rec.a > 0 ? ' <span title="armour ×' + rec.a.toFixed(2) + '">🛡' + qualGlyph(rec.a) + '</span>' : '';
      roster += '<span class="ucip" style="font-size:11px">' + m.glyph + (wpart ? ' ' + wpart : '') + apart + '</span>';
    } }
    let h = '<div style="font-weight:bold;color:' + color + ';padding-right:16px">' + dominantGlyphC(g) + ' ' + esc(g.name) + (g.isGarrison ? ' <span class="muted" style="font-weight:normal">(Garrison)</span>' : '') + '</div>';
    h += '<div class="opt-desc" style="margin:2px 0">' + (meta ? meta.name : team) + (mine ? '' : ' <span class="muted">(enemy)</span>') + ' · 📍' + esc(loc) + ' · ' + missionLabel(g) + ' · 💪' + (g.morale || 'normal') + '</div>';
    h += '<div style="margin:4px 0;font-size:13px"><b>' + Math.round(n) + '</b> units · <b title="total attack">⚔️ ' + pw.atk + '</b> / <b title="total defence">🛡 ' + pw.def + '</b></div>';
    h += '<div class="rp-h" style="margin:4px 0 2px">Composition</div>' + (comp || '<div class="muted">No units.</div>');
    h += '<div class="muted" style="font-size:10px;margin:3px 0">🛡️ Armour: ' + (armRecs.length ? '<b>' + armRecs.length + '/' + allRecs.length + '</b> armoured · ' + amix : 'none') + '</div>';
    h += '<div class="muted" style="font-size:10px">Each soldier (weapon · 🛡 armour):</div><div style="max-height:96px;overflow:auto;display:flex;flex-wrap:wrap;gap:2px;margin-top:2px">' + (roster || '<span class="muted">—</span>') + '</div>';
    if (mine && State.myRole === 'COMMANDER' && !g.isGarrison) h += '<div class="muted" style="font-size:10px;margin-top:4px">✓ Selected for orders — right-click the map to march it.</div>';
    return h;
  }
  function ensureHostPopupEl() {
    let el = document.getElementById('hostPopup');
    if (!el) {
      el = document.createElement('div'); el.id = 'hostPopup';
      el.style.cssText = 'position:fixed;z-index:60;display:none;width:248px;max-width:90vw;background:#1c1812;border:1px solid #c4a35a;border-radius:8px;padding:9px 11px;color:#e8dcc0;box-shadow:0 6px 22px rgba(0,0,0,.6);font-size:12px;pointer-events:auto';
      document.body.appendChild(el);
    }
    return el;
  }
  function showHostPopup(hostId, sx, sy) {
    const snap = State.snapshot; if (!snap) return;
    const found = findHostAny(snap, hostId); if (!found) { hideHostPopup(); return; }
    hostPopupId = hostId;
    const el = ensureHostPopupEl();
    el.innerHTML = '<button onclick="FP.UI.hideHostPopup()" style="position:absolute;top:4px;right:6px;background:none;border:none;color:#c4a35a;font-size:14px;cursor:pointer">✕</button>' + hostPopupHtml(snap, found.g, found.team);
    el.style.display = 'block';
    const pad = 10, w = el.offsetWidth || 248;
    let left = (sx != null ? sx : window.innerWidth / 2) + 14, top = (sy != null ? sy : window.innerHeight / 2) + 8;
    if (left + w + pad > window.innerWidth) left = (sx || 0) - w - 14;
    if (left < pad) left = pad;
    const hh = el.offsetHeight || 220; if (top + hh + pad > window.innerHeight) top = Math.max(pad, window.innerHeight - hh - pad);
    el.style.left = left + 'px'; el.style.top = top + 'px';
  }
  function hideHostPopup() { const el = document.getElementById('hostPopup'); if (el) el.style.display = 'none'; hostPopupId = null; }
  function refreshHostPopup() {
    if (!hostPopupId) return;
    const snap = State.snapshot; if (!snap) return;
    const found = findHostAny(snap, hostPopupId);
    if (!found) { hideHostPopup(); return; }   // host destroyed — close
    const el = document.getElementById('hostPopup'); if (!el || el.style.display === 'none') return;
    el.innerHTML = '<button onclick="FP.UI.hideHostPopup()" style="position:absolute;top:4px;right:6px;background:none;border:none;color:#c4a35a;font-size:14px;cursor:pointer">✕</button>' + hostPopupHtml(snap, found.g, found.team);
  }

  // ---------- request-resolution notices (popup below the top bar when YOUR request is accepted/denied) ----------
  const notifiedReqs = new Set();
  function showReqNotice(html, good) {
    let el = document.getElementById('reqNotice');
    if (!el) {
      el = document.createElement('div'); el.id = 'reqNotice';
      el.style.cssText = 'position:fixed;top:54px;left:50%;transform:translateX(-50%);z-index:55;max-width:520px;padding:8px 16px;border-radius:8px;font-size:13px;text-align:center;box-shadow:0 4px 16px rgba(0,0,0,.5);pointer-events:none;transition:opacity .3s';
      document.body.appendChild(el);
    }
    el.style.background = good ? '#1d2a18' : '#2a1818';
    el.style.border = '1px solid ' + (good ? '#6fae5f' : '#c8553d');
    el.style.color = good ? '#bfe6a8' : '#e0998a';
    el.innerHTML = html; el.style.display = 'block'; el.style.opacity = '1';
    clearTimeout(el._h); el._h = setTimeout(() => { el.style.opacity = '0'; setTimeout(() => { el.style.display = 'none'; }, 320); }, 5200);
  }
  function checkRequestNotices(snap) {
    if (!snap || State.isSpectator || !State.myRole) return;
    const team = snap.teams[State.myTeam]; if (!team || !team.requests) return;
    for (const r of team.requests) {
      if (r.fromRole !== State.myRole || !r.resolution) continue;
      if (notifiedReqs.has(r.id)) continue;
      notifiedReqs.add(r.id);
      const who = r.resolvedByName || (C.ROLE_META[r.resolvedBy] ? C.ROLE_META[r.resolvedBy].name : r.resolvedBy) || 'A teammate';
      const accepted = r.resolution === 'accepted';
      showReqNotice((accepted ? '✅ ' : '❌ ') + '<b>' + esc(who) + '</b> ' + (accepted ? 'accepted' : 'declined') + ' your request to ' + esc(reqText(r)) + '.', accepted);
    }
  }

  // ---------- public API ----------
  const UI = {
    _w: null,
    toast, closeModal, buildActionBar, buildSpectatorBar, showHelp, maybeFirstRun,
    specFilter(v) { State.logFilter = v; buildSpectatorBar(); if (State.snapshot) UI.update(State.snapshot); },
    update(snap) {
      if (State.isSpectator) { updateTopSpectator(snap); updateLeftSpectator(snap); updateRight(snap); updatePause(snap); refreshOpenModal(); refreshHostPopup(); return; }
      updateTop(snap); updateLeft(snap); updateRight(snap); updateGuide(snap); updatePause(snap); refreshOpenModal(); refreshHostPopup(); checkRequestNotices(snap);
    },
    showHostPopup, hideHostPopup,
    showTab(name) {
      document.querySelectorAll('.tab').forEach((x) => x.classList.toggle('active', x.dataset.tab === name));
      document.querySelectorAll('.tabpane').forEach((x) => x.classList.remove('active'));
      const pane = $('tab-' + name); if (pane) pane.classList.add('active');
    },
    act(action, payload) { Net.action(action, payload); },
    setWorkModeSafe(areaId, mode, contested) {
      if (mode === 'push' && contested && typeof confirm === 'function' &&
        !confirm('Push mode at a CONTESTED outpost risks losing a crew (~' + Math.round((B.WORK_MODES.push.lossPerSec || 0) * 100) + '%/sec). Continue?')) return;
      Net.action('setWorkMode', { areaId, mode });
    },
    askEscort(caravanId) { Net.action('request', { type: 'ESCORT', payload: caravanId ? { caravanId } : {} }); toast('Asked the Commander to escort this caravan.'); },
    askGuards() { Net.action('request', { type: 'GUARDS', payload: { count: B.GUARD_LEND_DEFAULT } }); toast('Asked the Commander to lend caravan guards.'); },
    setGuards(areaId, count) { Net.action('setGuards', { areaId, count: Math.max(0, count) }); },
    resolveReq(id, accept) { Net.action('resolveRequest', { id, accept }); },
    request(type) { Net.action('request', { type }); toast('Request sent to your council.'); },
    needResource(resource) { Net.action('request', { type: 'NEED', payload: { resource } }); toast('Asked your council for more ' + resource + '.'); },
    modalRationing, modalResource,
    hold(resource, duration) { Net.action('setHold', { resource, duration, allow: [] }); toast('Reserving ' + resource + (duration ? ' for ' + duration + 's' : '') + '.'); },
    reserveOnlyMe(resource) { Net.action('setHold', { resource, duration: 0, allow: [] }); toast('Reserved ' + resource + ' (only you).'); },
    setAccess(resource, role, allowed) { Net.action('setResourceAccess', { resource, role, allowed }); },
    requestUse(resource) { Net.action('request', { type: 'USE', payload: { resource, reason: useReason(resource) } }); toast('Asked the Lord for access to ' + resource + '.'); },
    requestReserve(resource) { Net.action('request', { type: 'RESERVE', payload: { resource, reason: useReason(resource) } }); toast('Asked the Lord to reserve ' + resource + ' for you.'); },
    cancelReq(id) { Net.action('cancelRequest', { id }); toast('Request cancelled.'); },
    // Click a resource chip: open the per-resource view (rationing for the Lord; access/asks for others).
    chipClick(k) { return modalResource(k); },
    pauseToggle() { const snap = State.snapshot; if (snap && snap.pause && snap.pause.active) Net.resume(); else Net.pause(); },
    resume() { Net.resume(); },
    vote(v) { Net.vote(v); },
    requestDefend(area) { Net.action('request', { type: 'DEFEND', payload: { area } }); toast('Asked Commander to defend.'); },
    selectGroup(id) { State.selectedGroupId = id; updateRight(State.snapshot); },
    selectHost(id) { State.selectedGroupId = (State.selectedGroupId === id ? null : id); updateRight(State.snapshot); reMng(); },
    moveHostTo(gid, areaId) {
      const snap = State.snapshot; const a = snap.areas[areaId]; if (!a) return;
      const enemy = State.enemyTeam(); const home = State.myTeam === 'BLUE' ? 'blue_base' : 'red_base';
      const enemyHere = snap.teams[enemy].armies.some((g) => (g.moving ? g.moving.route[g.moving.legIndex] : g.area) === areaId && armyCount(g) >= 0.5);
      let mission, verb;
      if (a.terrain === 'base' && a.owner === enemy) { mission = 'siege'; verb = '🏰 Sieging'; }
      else if (a.owner === enemy || enemyHere) { mission = 'raid'; verb = '⚔️ Attacking'; }
      else if (areaId === home) { mission = 'defend'; verb = '🛡️ Defending'; }
      else { mission = 'garrison'; verb = '🚩 Marching to'; }
      Net.action('command', { groupId: gid, mission, targetArea: areaId });
      toast(verb + ' ' + a.name + '.');
    },
    armyExpand(id) { armyUI.expanded = (armyUI.expanded === id ? null : id); reMng(); },
    milCompToggle(u) { milExpand[u] = !milExpand[u]; refreshOpenModal(); },
    armySrc(id) { armyUI.src = id; armyUI.amt = {}; reMng(); },
    armyDst(id) { armyUI.dst = id; reMng(); },
    armyAmt(u, d) { const s = armySrcHost(); if (!s) return; const have = Math.round(s.units[u] || 0); armyUI.amt[u] = Math.max(0, Math.min(have, (armyUI.amt[u] || 0) + d)); reMng(); },
    armyAmtSet(u, mode) { const s = armySrcHost(); if (!s) return; const have = Math.round(s.units[u] || 0); armyUI.amt[u] = mode === -1 ? have : mode === -2 ? Math.floor(have / 2) : Math.max(0, Math.min(have, mode)); reMng(); },
    armyTransfer() { if (!armyUI.src) return; Net.action('transferUnits', { fromId: armyUI.src, toId: armyUI.dst, units: Object.assign({}, armyUI.amt) }); armyUI.amt = {}; toast('Reorganising forces…'); },
    armyForm(gid, f) { Net.action('setFormation', { groupId: gid, formation: f }); },
    armyStance(gid, s) { Net.action('setStance', { groupId: gid, stance: s }); },
    cmdMng(gid, mission) { Net.action('command', { groupId: gid, mission }); toast('Order issued.'); },
    reequip(gid) { Net.action('reequip', { groupId: gid }); },
    commandSel(mission, area) { const team = State.teamState(); const gid = State.selectedGroupId || garrisonId(team); if (!gid) return toast('No host to command.', true); Net.action('command', { groupId: gid, mission, targetArea: area }); },
    cmd(gid, mission) { Net.action('command', { groupId: gid, mission }); closeModal(); },
    modalBuild, modalWorkers, modalPolicy, modalMilitaryPolicy, modalSites, modalCaravans, modalExpeditions, modalForge, modalContracts, modalSpec, modalMuster, modalOrders, modalArmyManage, modalDoctrine, modalNeed, modalMilitary, modalGather, modalSpectatorMilitary,
    gatherTools(pool, delta) { Net.action('setGatherTools', { pool, delta }); },
    mineFocus(v) { Net.action('setMineFocus', { value: v }); },
    mineFocusStep(d) { const t = State.teamState(); const cur = (t && t.gather && typeof t.gather.mineIronFocus === 'number') ? t.gather.mineIronFocus : B.DEFAULT_MINE_FOCUS; Net.action('setMineFocus', { value: Math.max(0, Math.min(1, cur + d)) }); },
    askToolsFromSmith() { Net.action('request', { type: 'EQUIPMENT', payload: { item: 'tools' } }); toast('Asked the Blacksmith to forge Tools.'); },
    askConserve(resource, duration) { Net.action('requestConserve', { resource: resource || 'wood', duration: duration || 60 }); toast('Asked the council to conserve ' + (resource || 'wood') + '.'); },
    modalStewardRequests, modalCommanderRequests, modalBlacksmithRequests, modalLordRequests,
    levy(n) { Net.action('levy', { count: n }); toast('Levied workers → recruits.'); },
    trainAt(area) { trainTarget = area; modalMuster(); },
    wAdj(job, d) { Net.action('assignWorker', { job, delta: d }); },
  };
  window.FP.UI = UI;
})();
