/* Comms & cross-role requests. Works for any human/AI mix on a team. */
'use strict';
const C = require('../../shared/constants.js');
const B = require('../../shared/balance.js');
const S = require('../../shared/schema.js');

function slotName(team, role) { const s = team.slots[role]; return s ? s.name : role; }
function isAI(team, role) { const s = team.slots[role]; return !s || s.controller === C.CONTROLLER.AI; }

function postChat(state, team, role, text, kind) {
  team.comms.push({
    id: S.uid('msg'), t: Math.round(state.elapsed), fromRole: role,
    fromName: slotName(team, role), isAI: isAI(team, role),
    text, kind: kind || 'chat',
  });
  if (team.comms.length > 60) team.comms.shift();
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
  USE: 'May I spend a reserved resource?',
  RESERVE: 'Lord, please reserve a resource for me.',
};

function reqMessage(type, payload) {
  if (type === 'NEED' && payload && payload.resource) {
    const m = C.RESOURCE_META[payload.resource];
    return 'We need more ' + (m ? m.glyph + ' ' + payload.resource : payload.resource) + '!';
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

function resolveRequest(state, team, id, accept, systems) {
  const req = team.requests.find((r) => r.id === id && r.status === 'open');
  if (!req) return { ok: false, reason: 'Request not found.' };
  const responder = req.targetRole;
  if (accept) {
    const ok = fulfill(state, team, req, systems);
    if (ok) {
      req.status = 'accepted';
      postChat(state, team, responder, 'On it — ' + lowerType(req.type, req) + '.', 'response');
    } else {
      // Can't fulfil it yet — REMEMBER it and keep trying. Refresh its ttl so it persists, and only
      // post the "not yet" note once to avoid spamming the comms.
      req.ttl = Math.max(req.ttl, 30);
      if (!req._pinged) { req._pinged = true; postChat(state, team, responder, 'I cannot do that yet — I will when I can.', 'response'); }
    }
    return { ok };
  }
  req.status = 'declined';
  postChat(state, team, responder, 'Cannot help with that right now.', 'response');
  return { ok: true };
}

function lowerType(t, req) {
  if (t === 'NEED') { const res = req && req.payload && req.payload.resource; return 'boosting ' + (res || 'that resource'); }
  if (t === 'USE') { const res = req && req.payload && req.payload.resource; return 'allowing one spend of ' + (res || 'that resource'); }
  if (t === 'RESERVE') { const res = req && req.payload && req.payload.resource; return 'reserving ' + (res || 'that resource') + ' for you'; }
  return ({ ESCORT: 'escorting the caravan', GUARDS: 'lending caravan guards', WORKERS: 'sending workers', IRON: 'pushing iron through',
    EQUIPMENT: 'forging gear', RECRUITS: 'training recruits', DEFEND: 'sending defenders',
    TRAIN: 'training troops', MISSION: 'taking the offensive', SITE: 'expanding our territory', BUILD: 'raising the building', RECRUITS: 'training recruits', TRAINERS: 'assigning trainers' })[t] || t.toLowerCase();
}

// Quality of gear an AI Blacksmith produces when fulfilling a request (rolled by its difficulty).
function forgeQuality(team) {
  const diff = (team.slots && team.slots.BLACKSMITH && team.slots.BLACKSMITH.difficulty) || 'medium';
  return B.rollQuality(diff, Math.random());
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
      if (garr && (garr.units.militia || 0) > 0) { const take = Math.min(garr.units.militia, want); garr.units.militia -= take; lent += take; }
      if (lent < want && team.pop.recruits >= 1) { const take = Math.min(Math.floor(team.pop.recruits), want - lent); team.pop.recruits -= take; lent += take; }
      if (lent <= 0) return false;
      team.guards = (team.guards || 0) + lent;
      let soldiers = 0; for (const g of team.armies) soldiers += army.unitCount(g); team.pop.soldiers = Math.round(soldiers);
      economy.recomputeDerived(team);
      return true;
    }
    case 'WORKERS': {
      const job = (req.payload && req.payload.job) || 'miners';
      const move = Math.min(3, team.pop.idle);
      if (move <= 0) return false;
      team.pop.idle -= move; team.pop[job] = (team.pop[job] || 0) + move; economy.recomputeDerived(team); return true;
    }
    case 'RECRUITS': {
      const r = economy.levy(team, 3);  // commit idle workers to the recruit pool (one-way)
      return !!(r && r.ok);
    }
    case 'TRAINERS': {
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
    case 'IRON': { const q = forgeQuality(team); production.queueProduction(team, 'spears', 8, q.mult, q.id); return true; }
    case 'TRAIN': {
      const unitType = (req.payload && req.payload.unitType && C.UNIT_META[req.payload.unitType]) ? req.payload.unitType : 'spearman';
      const count = (req.payload && req.payload.count) || 2;
      const area = (req.payload && req.payload.area) || (army.barracksAreasOf(state, team)[0]);
      if (!area) return false;
      // Ensure there are recruits to train (the Lord can levy on the Commander's behalf).
      if (team.pop.recruits < 1) economy.levy(team, Math.max(2, count));
      return !!army.trainUnits(state, team, area, unitType, count).ok;
    }
    case 'MISSION': {
      const mission = (req.payload && req.payload.mission) || 'raid';
      let host = null, best = -1;
      for (const gx of team.armies) { const n = army.unitCount(gx); if (n > best) { best = n; host = gx; } }
      if (!host || best < 0.5) return false;
      if (mission === 'siege') return !!army.command(state, team, host.id, 'siege').ok;
      const tgt = (req.payload && req.payload.targetArea) || S.homeBase(S.enemyOf(team.team));
      return !!army.command(state, team, host.id, mission, tgt).ok;
    }
    case 'SITE': {
      const mode = (req.payload && req.payload.mode) || 'expand';
      if (mode === 'upgrade') {
        for (const id in state.areas) { const a = state.areas[id]; if (a.claimedBy === team.team && a.terrain !== 'base' && a.site) { if (sites.upgradeSite(state, team, id).ok) return true; } }
        return false;
      }
      // expand: claim a revealed neutral site, else explore toward one.
      for (const id in state.areas) { const a = state.areas[id]; if (a.revealed[team.team] && a.site && a.terrain !== 'base' && !a.owner) { if (sites.claim(state, team, id).ok) return true; } }
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
    case 'NEED': {
      const res = req.payload && req.payload.resource;
      const jobFor = { food: 'farmers', wood: 'woodcutters', stone: 'miners', iron: 'miners' };
      if (jobFor[res]) {
        if (res === 'iron' || res === 'stone') team._mineDemand = { res, until: state.elapsed + 30 };  // tell the Steward to bias the mines toward it
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
      economy.setHold(state, team, res, dur, [req.fromRole]);  // reserve it for the requester (and the Lord)
      return true;
    }
    case 'DEFEND': {
      const g = army.garrison(state, team);
      const tgt = (req.payload && req.payload.area) || S.homeBase(team.team);
      army.command(state, team, g.id, tgt === S.homeBase(team.team) ? 'defend' : 'garrison', tgt); return true;
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
