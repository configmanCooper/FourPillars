/* Comms & cross-role requests. Works for any human/AI mix on a team. */
'use strict';
const C = require('../../shared/constants.js');
const B = require('../../shared/balance.js');
const S = require('../../shared/schema.js');

function slotName(team, role) { const s = team.slots[role]; return s ? s.name : role; }
function isAI(team, role) { const s = team.slots[role]; return !s || s.controller === C.CONTROLLER.AI; }

function postChat(state, team, role, text, kind) {
  kind = kind || 'chat';
  // Anti-spam safety floor: an AI seat's FLAVOUR lines ('chat') are capped at one per 4s per seat, so the
  // added cohesion/thought/reaction chatter can never machine-gun the log. Human chat and request/response/
  // system lines are NEVER throttled (they carry gameplay-critical information). say() already spaces most
  // AI chat by ~30s; this catches the direct postChat() cohesion lines too.
  if (kind === 'chat' && isAI(team, role)) {
    team._chatGap = team._chatGap || {};
    if (state.elapsed - (team._chatGap[role] != null ? team._chatGap[role] : -999) < 4) return false;
    team._chatGap[role] = state.elapsed;
  }
  team.comms.push({
    id: S.uid('msg'), t: Math.round(state.elapsed), fromRole: role,
    fromName: slotName(team, role), isAI: isAI(team, role),
    text, kind,
  });
  if (team.comms.length > 60) team.comms.shift();
  return true;
}

const REQ_TEXT = {
  ESCORT: 'Requesting an escort for my caravan!',
  GUARDS: 'Commander, lend me some guards for my caravans!',
  WORKERS: 'Could the Lord spare some workers?',
  IRON: 'Need more iron coming in from the mines.',
  EQUIPMENT: 'Blacksmith, we need weapons forged!',
  RECRUITS: 'Lord, train more recruits for the army.',
  TRAINERS: 'Lord, assign Trainers at a Barracks so I can train troops.',
  DEFEND: 'Send a host to defend!',
  TRAIN: 'Commander, train more troops!',
  MISSION: 'Commander, take the offensive!',
  SITE: 'Steward, expand our territory!',
  BUILD: 'Lord, we should raise a new building!',
  NEED: 'We need more of this resource!',
  MINEFOCUS: 'Steward, shift the miners!',
  USE: 'May I spend a reserved resource?',
  RESERVE: 'Lord, please reserve a resource for me.',
  FORGESPEED: 'Could we speed up the forge?',
};

function reqMessage(type, payload) {
  if (type === 'NEED' && payload && payload.resource) {
    const m = C.RESOURCE_META[payload.resource];
    return 'We need more ' + (m ? m.glyph + ' ' + payload.resource : payload.resource) + '!';
  }
  if (type === 'MINEFOCUS' && payload && payload.res) {
    const m = C.RESOURCE_META[payload.res];
    return 'Steward, mine more ' + (m ? m.glyph + ' ' + payload.res : payload.res) + ' (shift miners off the other ore).';
  }
  if (type === 'USE' && payload && payload.resource) {
    const m = C.RESOURCE_META[payload.resource];
    return 'May I spend ' + (m ? m.glyph + ' ' + payload.resource : payload.resource) + '?' + (payload.reason ? ' (' + payload.reason + ')' : '');
  }
  if (type === 'RESERVE' && payload && payload.resource) {
    const m = C.RESOURCE_META[payload.resource];
    return 'Lord, reserve ' + (m ? m.glyph + ' ' + payload.resource : payload.resource) + ' for me' + (payload.reason ? ' (' + payload.reason + ')' : '') + '.';
  }
  if (type === 'EQUIPMENT' && payload && payload.item) { const m = C.EQUIP_META[payload.item]; return 'Blacksmith, forge ' + (m ? m.glyph + ' ' + m.name : payload.item) + '!'; }
  if (type === 'TRAIN' && payload && payload.unitType) { const m = C.UNIT_META[payload.unitType]; return 'Commander, train ' + (m ? m.glyph + ' ' + m.name : payload.unitType) + '!'; }
  if (type === 'MISSION' && payload && payload.mission) { return 'Commander, ' + ({ raid: 'raid the enemy', siege: 'siege their Keep', garrison: 'hold the frontier' }[payload.mission] || payload.mission) + '!'; }
  if (type === 'SITE' && payload) { return payload.mode === 'upgrade' ? 'Steward, upgrade our best site!' : 'Steward, expand our territory!'; }
  if (type === 'BUILD' && payload && payload.type) { return 'Lord, build a ' + (B.BUILDINGS[payload.type] ? B.BUILDINGS[payload.type].name : payload.type) + '!'; }
  if (type === 'FORGESPEED') return (payload && payload.target === 'LORD') ? 'Lord, research Foundry Mastery to speed our forge!' : 'Steward, crank the Forge Bellows to speed our forge!';
  return REQ_TEXT[type] || 'Request: ' + type;
}

function createRequest(state, team, fromRole, targetRole, type, payload) {
  if (!targetRole || targetRole === fromRole) return null; // never address a request to yourself
  // De-dup: don't stack identical open requests (NEED/USE keyed by resource too).
  const sameRes = (r) => (type !== 'NEED' && type !== 'USE') || (r.payload && r.payload.resource) === (payload && payload.resource);
  if (team.requests.some((r) => r.status === 'open' && r.type === type && r.fromRole === fromRole && sameRes(r))) return null;
  const req = {
    id: S.uid('req'), fromRole, targetRole, type, payload: payload || {},
    status: 'open', ttl: 45, createdT: Math.round(state.elapsed),
    fromName: slotName(team, fromRole), targetName: slotName(team, targetRole),
  };
  team.requests.push(req);
  postChat(state, team, fromRole, reqMessage(type, payload) + ' (@' + C.ROLE_META[targetRole].name + ')', 'request');
  return req;
}

function resolveRequest(state, team, id, accept, systems, actorRole) {
  const req = team.requests.find((r) => r.id === id && r.status === 'open');
  if (!req) return { ok: false, reason: 'Request not found.' };
  // Role-gating: a human may only resolve a request addressed to the role they occupy (the AI passes
  // no actorRole and is trusted to act for the role it controls). Prevents e.g. the Commander accepting
  // a LORD-only RESERVE/USE request and granting resource holds.
  if (actorRole && actorRole !== req.targetRole) return { ok: false, reason: 'That request is for the ' + (C.ROLE_META[req.targetRole] ? C.ROLE_META[req.targetRole].name : req.targetRole) + '.' };
  const responder = req.targetRole;
  const byHuman = !!actorRole;   // a human pressed accept/decline (the AI calls with no actorRole)
  if (byHuman) {
    // For humans, requests are purely a COMMUNICATION tool — accepting does NOT auto-perform the action
    // (forging needs the minigame, a spend needs the player's own click, …). It just acknowledges in the
    // comms; the human then does it themselves. The requester gets a popup (client reads req.resolution).
    req.status = accept ? 'accepted' : 'declined';
    req.resolution = accept ? 'accepted' : 'declined';
    req.resolvedBy = responder; req.resolvedByName = slotName(team, responder);
    postChat(state, team, responder, accept ? ('👍 Accepted — I will ' + lowerType(req.type, req) + '.') : '👎 Sorry — declining that for now.', 'response');
    // Human-deed reaction (G8): the AI that ASKED notices a human agreeing to help, and thanks them in
    // character. Capped to one thanks per asking-seat per 60s so gratitude never becomes spam.
    if (accept) {
      const asker = req.fromRole;
      if (asker && asker !== responder && isAI(team, asker)) {
        team._thankGap = team._thankGap || {};
        if (state.elapsed - (team._thankGap[asker] != null ? team._thankGap[asker] : -999) >= 60) {
          team._thankGap[asker] = state.elapsed;
          postChat(state, team, asker, thankLine(team, asker), 'chat');
        }
      }
    }
    return { ok: true };
  }
  // AI responder: actually fulfil the request automatically.
  if (accept) {
    const ok = fulfill(state, team, req, systems);
    if (ok) {
      req.status = 'accepted'; req.resolution = 'accepted'; req.resolvedBy = responder; req.resolvedByName = slotName(team, responder);
      postChat(state, team, responder, 'On it — ' + lowerType(req.type, req) + '.', 'response');
    } else {
      // Can't fulfil it yet — REMEMBER it and keep trying. Refresh its ttl so it persists, and only
      // post the "not yet" note once to avoid spamming the comms.
      req.ttl = Math.max(req.ttl, 30);
      if (!req._pinged) { req._pinged = true; postChat(state, team, responder, 'I cannot do that yet — I will when I can.', 'response'); }
    }
    return { ok };
  }
  req.status = 'declined'; req.resolution = 'declined'; req.resolvedBy = responder; req.resolvedByName = slotName(team, responder);
  postChat(state, team, responder, 'Cannot help with that right now.', 'response');
  return { ok: true };
}

// A persona-flavoured thanks from an AI seat to a human who just agreed to help.
function thankLine(team, role) {
  const persona = (team.aiPersona && team.aiPersona[role]) || '';
  const blunt = ['wolf', 'hammer', 'warmonger'].includes(persona);
  const wry = ['iron', 'relic', 'quartermaster', 'toolsmith'].includes(persona);
  const pool = blunt
    ? ['Good. I won\'t forget it.', 'That\'s the spirit — my thanks.', 'Aye. That helps more than you know.']
    : wry
      ? ['Much obliged — I\'ll remember who came through.', 'Now THAT is teamwork. My thanks.', 'You have my gratitude, and that\'s worth more than coin.']
      : ['Thank you — truly, that helps.', 'Bless you for that. The realm is stronger for it.', 'My thanks — I knew I could count on you.'];
  return pool[Math.floor(Math.random() * pool.length)];
}

function lowerType(t, req) {
  if (t === 'NEED') { const res = req && req.payload && req.payload.resource; return 'boosting ' + (res || 'that resource'); }
  if (t === 'MINEFOCUS') { const res = req && req.payload && req.payload.res; return 'shifting the mines toward ' + (res || 'that ore'); }
  if (t === 'USE') { const res = req && req.payload && req.payload.resource; return 'allowing one spend of ' + (res || 'that resource'); }
  if (t === 'RESERVE') { const res = req && req.payload && req.payload.resource; return 'reserving ' + (res || 'that resource') + ' for you'; }
  if (t === 'FORGESPEED') return (req && req.targetRole === 'LORD') ? 'research Foundry Mastery to speed the forge' : 'crank the Forge Bellows to speed the forge';
  return ({ ESCORT: 'escorting the caravan', GUARDS: 'lending caravan guards', WORKERS: 'sending workers', IRON: 'pushing iron through',
    EQUIPMENT: 'forging gear', RECRUITS: 'training recruits', DEFEND: 'sending defenders',
    TRAIN: 'training troops', MISSION: 'taking the offensive', SITE: 'expanding our territory', BUILD: 'raising the building', RECRUITS: 'training recruits', TRAINERS: 'assigning trainers' })[t] || t.toLowerCase();
}

// Quality of gear an AI Blacksmith produces when fulfilling a request (rolled by its difficulty).
function forgeQuality(team) {
  const diff = (team.slots && team.slots.BLACKSMITH && team.slots.BLACKSMITH.difficulty) || 'medium';
  return B.rollQuality(diff, Math.random());
}

// Best enemy LAND target to raid (an enemy-held outpost, or a neutral/contested site) — used when the Lord
// orders a raid without naming a target. NEVER returns the enemy Keep (assaulting the Keep is a 'siege').
function bestRaidTarget(state, team) {
  const foe = S.enemyOf(team.team);
  const ekId = S.homeBase(foe);
  let best = null, bestScore = -1;
  for (const id in state.areas) {
    const a = state.areas[id];
    if (a.terrain === 'base' || id === ekId) continue;          // never the Keep
    let score = -1;
    if (a.owner === foe) score = 10 + S.buildingsAt(a) * 2 + (a.site ? a.site.level : 0);   // enemy-held land = prime raid
    else if (!a.owner && a.site) score = 1;                     // a neutral site we could contest
    if (score > bestScore) { bestScore = score; best = id; }
  }
  return best;
}

// Best-effort concrete effect so a request matters no matter who accepts it.
function fulfill(state, team, req, systems) {
  const { army, economy, production, sites, buildings } = systems;
  switch (req.type) {
    case 'ESCORT': {
      let cv = req.payload && req.payload.caravanId && team.caravans.find((c) => c.id === req.payload.caravanId);
      if (!cv) cv = team.caravans.find((c) => !c.escort) || team.caravans[0];
      if (!cv) return false;
      const host = team.armies.find((g) => army.unitCount(g) >= 0.5);
      if (host) { army.command(state, team, host.id, 'escort', cv.id); return true; }
      cv.escort = true; return true;
    }
    case 'GUARDS': {
      const want = Math.max(1, Math.round((req.payload && req.payload.count) || B.GUARD_LEND_DEFAULT));
      let lent = 0;
      // Lend spare militia from the garrison first (cheap caravan fodder), then dip into the recruit pool.
      const garr = army.garrison(state, team);
      if (garr && (garr.units.militia || 0) > 0) { const take = Math.min(Math.round(garr.units.militia), want); for (let k = 0; k < take; k++) army.removeSoldier(garr, 'militia'); lent += take; }
      if (lent < want && team.pop.recruits >= 1) { const take = Math.min(Math.floor(team.pop.recruits), want - lent); team.pop.recruits -= take; lent += take; }
      if (lent <= 0) return false;
      team.guards = (team.guards || 0) + lent;
      let soldiers = 0; for (const g of team.armies) soldiers += army.unitCount(g); team.pop.soldiers = Math.round(soldiers);
      economy.recomputeDerived(team);
      return true;
    }
    case 'WORKERS': {
      if (team.workerLock) return false;   // the Lord has locked worker allocation — don't move their workers
      const job = (req.payload && req.payload.job) || 'miners';
      const move = Math.min(3, team.pop.idle);
      if (move <= 0) return false;
      team.pop.idle -= move; team.pop[job] = (team.pop[job] || 0) + move; economy.recomputeDerived(team); return true;
    }
    case 'RECRUITS': {
      if (team.workerLock) return false;   // levying moves workers out of the pool — the Lord controls that when locked
      const r = economy.levy(team, 3);  // commit idle workers to the recruit pool (one-way)
      return !!(r && r.ok);
    }
    case 'TRAINERS': {
      if (team.workerLock) return false;   // assigning trainers reallocates workers — respect the Lord's lock
      const cap = economy.maxTrainers(team);           // Barracks * 2
      const room = cap - team.pop.trainers;
      if (room <= 0) return false;                      // no Barracks capacity (or already maxed)
      let move = Math.min(room, 2), got = 0;
      const fromIdle = Math.min(move, team.pop.idle); team.pop.idle -= fromIdle; got += fromIdle;
      if (got < move) { for (const pl of ['woodcutters', 'miners', 'farmers'].sort((a, b) => team.pop[b] - team.pop[a])) { if (got >= move) break; const t = Math.min(move - got, team.pop[pl]); team.pop[pl] -= t; got += t; } }
      if (got <= 0) return false;
      team.pop.trainers += got; economy.recomputeDerived(team); return true;
    }
    case 'EQUIPMENT': {
      const item = (req.payload && req.payload.item && B.RECIPES[req.payload.item]) ? req.payload.item : 'spears';
      const qty = (req.payload && req.payload.qty) || B.RECIPES[item].batch || 8;
      const q = forgeQuality(team);
      return !!production.queueProduction(team, item, qty, q.mult, q.id).ok;
    }
    case 'IRON': {
      // Blacksmith→Steward: "send more iron from the mines." Bias the mines toward iron and shift idle
      // hands to mining — NOT forge spears (which would CONSUME the iron we're short of). The worker shift
      // is skipped when the Lord has locked allocation (the mine-focus bias still applies).
      team._mineDemand = { res: 'iron', until: state.elapsed + 30 };
      if (!team.workerLock) { const move = Math.min(3, team.pop.idle); if (move > 0) { team.pop.idle -= move; team.pop.miners = (team.pop.miners || 0) + move; economy.recomputeDerived(team); } }
      return true;
    }
    case 'TRAIN': {
      const unitType = (req.payload && req.payload.unitType && C.UNIT_META[req.payload.unitType]) ? req.payload.unitType : 'spearman';
      const count = (req.payload && req.payload.count) || 2;
      const area = (req.payload && req.payload.area) || (army.barracksAreasOf(state, team)[0]);
      if (!area) return false;
      // Ensure there are recruits to train (the Lord can levy on the Commander's behalf) — but never levy
      // the Lord's workers when allocation is locked.
      if (team.pop.recruits < 1) { if (team.workerLock) return false; economy.levy(team, Math.max(2, count)); }
      return !!army.trainUnits(state, team, area, unitType, count).ok;
    }
    case 'MISSION': {
      const mission = (req.payload && req.payload.mission) || 'raid';
      let host = null, best = -1;
      for (const gx of team.armies) { const n = army.unitCount(gx); if (n > best) { best = n; host = gx; } }
      if (!host || best < 0.5) return false;
      if (mission === 'siege') return !!army.command(state, team, host.id, 'siege', S.homeBase(S.enemyOf(team.team))).ok;
      // A RAID hits enemy LAND, not the Keep (the Keep is a 'siege', a separate order). If no specific target
      // was given, pick the best enemy-held outpost / contested site to raid — never default to the enemy Keep.
      let tgt = req.payload && req.payload.targetArea;
      if (!tgt) tgt = bestRaidTarget(state, team);
      if (!tgt) return false;   // nothing worth raiding right now (don't fall back to attacking the Keep)
      return !!army.command(state, team, host.id, mission, tgt).ok;
    }
    case 'SITE': {
      const mode = (req.payload && req.payload.mode) || 'expand';
      const fromLord = req.fromRole === 'LORD';   // the Lord authorising expansion waives their own resource hold
      if (mode === 'upgrade') {
        for (const id in state.areas) { const a = state.areas[id]; if (a.claimedBy === team.team && a.terrain !== 'base' && a.site) { if (sites.upgradeSite(state, team, id).ok) return true; } }
        return false;
      }
      // expand: claim the best revealed neutral site we can, else explore toward one.
      const wantRes = req.payload && req.payload.resource;   // optional: a specific resource the Lord asked to secure
      const home = state.areas[S.homeBase(team.team)];
      const distOf = (a) => home ? Math.hypot((a.x || 0) - home.x, (a.y || 0) - home.y) : 0;
      const richOf = (a) => S.buildingsAt(a) + (a.site ? a.site.level : 0);
      let neutral = [];
      for (const id in state.areas) { const a = state.areas[id]; if (a.revealed[team.team] && a.site && a.terrain !== 'base' && !a.owner) neutral.push(a); }
      if (wantRes) { const m = neutral.filter((a) => a.resource === wantRes); if (m.length) neutral = m; }   // honor a specific resource ask
      // Prefer the CLOSEST site (shorter supply route + the Commander can defend it sooner); richness breaks ties.
      neutral.sort((x, y) => (distOf(x) - distOf(y)) || (richOf(y) - richOf(x)));
      for (const a of neutral) { if (sites.claim(state, team, a.id, { bypassHold: fromLord }).ok) return true; }
      for (const id in state.areas) { const a = state.areas[id]; if (!a.revealed[team.team] && a.connections.some((n) => state.areas[n].revealed[team.team])) { if (sites.explore(state, team, id).ok) return true; } }
      return false;
    }
    case 'BUILD': {
      const type = req.payload && req.payload.type;
      if (!B.BUILDINGS[type] || !buildings) return false;
      // Build at an owned location with a free slot — the Keep first, then claimed sites.
      const order = [S.homeBase(team.team)];
      for (const id in state.areas) { const a = state.areas[id]; if (a.owner === team.team && a.terrain !== 'base') order.push(id); }
      for (const areaId of order) { if (buildings.queueBuilding(state, team, areaId, type).ok) return true; }
      return false;
    }
    case 'MINEFOCUS': {
      // Shift the stone↔iron mining split toward the asked-for ore. mineIronFocus: 0 = all stone,
      // 1 = all iron. We set a longer demand window (the AI Steward holds the focus) AND nudge it now.
      const res = req.payload && req.payload.res;
      if (res !== 'iron' && res !== 'stone') return false;
      const mf = !(team._abOff && team._abOff.minefocus);
      const cur = team._mineDemand;
      // The Lord's standing focus outranks a CONFLICTING ask from another role within its window.
      if (mf && cur && cur.until > state.elapsed && cur.role === 'LORD' && req.fromRole !== 'LORD' && cur.res !== res) return true;
      const win = (mf && req.fromRole === 'LORD') ? 90 : 75;   // ≥30s; the Lord's hold lasts longer
      team._mineDemand = { res: res, until: state.elapsed + win, role: mf ? req.fromRole : undefined };
      const g = team.gather; if (g) { const target = res === 'iron' ? B.AI_MINE_FOCUS_MAX : B.AI_MINE_FOCUS_MIN; const cur2 = (typeof g.mineIronFocus === 'number') ? g.mineIronFocus : B.DEFAULT_MINE_FOCUS; const step = Math.sign(target - cur2) * Math.min(0.34, Math.abs(target - cur2)); economy.setMineFocus(state, team, cur2 + step); }
      return true;
    }
    case 'NEED': {
      const res = req.payload && req.payload.resource;
      const jobFor = { food: 'farmers', wood: 'woodcutters', stone: 'miners', iron: 'miners' };
      if (jobFor[res]) {
        if (res === 'iron' || res === 'stone') {  // tell the Steward to bias the mines toward it (Lord's outranks)
          const mf = !(team._abOff && team._abOff.minefocus);
          const cur = team._mineDemand;
          if (!(mf && cur && cur.until > state.elapsed && cur.role === 'LORD' && req.fromRole !== 'LORD' && cur.res !== res)) {
            team._mineDemand = { res, until: state.elapsed + (mf && req.fromRole === 'LORD' ? 45 : 30), role: mf ? req.fromRole : undefined };
          }
        }
        // Shift idle workers into the matching job — but NOT when the Lord has locked allocation. The
        // mine-focus bias above still applies; we just don't move the Lord's workers. (Return true so the
        // request is acknowledged rather than retried forever.)
        if (team.workerLock) return true;
        const move = Math.min(3, team.pop.idle);
        if (move <= 0) return false;
        team.pop.idle -= move; team.pop[jobFor[res]] = (team.pop[jobFor[res]] || 0) + move; economy.recomputeDerived(team); return true;
      }
      if (res === 'arrows') { const q = forgeQuality(team); production.queueProduction(team, 'arrows', 24, q.mult, q.id); return true; }
      return true; // horses/relics: acknowledged (Steward prioritises sites)
    }
    case 'USE': {
      const res = req.payload && req.payload.resource;
      if (res) economy.grantHold(team, res, req.fromRole, state.elapsed + 30);  // 30s access window; reservation stays
      return true;
    }
    case 'RESERVE': {
      const res = req.payload && req.payload.resource;
      if (!res) return false;
      const dur = Math.max(30, Math.min(180, Math.round((req.payload && req.payload.duration) || 90)));
      economy.setHold(state, team, res, dur, [req.fromRole], req.fromRole);  // reserve it for the requester (who may later release it)
      return true;
    }
    case 'DEFEND': {
      const g = army.garrison(state, team);
      const tgt = (req.payload && req.payload.area) || S.homeBase(team.team);
      army.command(state, team, g.id, tgt === S.homeBase(team.team) ? 'defend' : 'garrison', tgt); return true;
    }
    case 'FORGESPEED': {
      // Blacksmith asks for a faster forge. The Steward can crank the bellows now (a timed +30%); the
      // Lord can research Foundry Mastery (a permanent boost). Route by whoever the ask was addressed to.
      if (req.targetRole === 'LORD') return !!economy.buyResearch(state, team, 'foundry').ok;
      if (req.targetRole === 'STEWARD') return !!economy.doStewardAction(state, team, 'forgeBellows').ok;
      // Fallback (broadcast/unknown): try the instant bellows first, then the research.
      return !!(economy.doStewardAction(state, team, 'forgeBellows').ok || economy.buyResearch(state, team, 'foundry').ok);
    }
    default: return false;
  }
}

function tickComms(state, team, dt) {
  for (let i = team.requests.length - 1; i >= 0; i--) {
    const r = team.requests[i];
    if (r.status === 'open') { r.ttl -= dt; if (r.ttl <= 0) r.status = 'expired'; }
    // Drop very old resolved requests from the active list.
    if (r.status !== 'open' && (state.elapsed - r.createdT) > 60) team.requests.splice(i, 1);
  }
}

module.exports = { postChat, createRequest, resolveRequest, tickComms, isAI, slotName };
