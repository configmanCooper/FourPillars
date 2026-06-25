/* AI controllers for any slot set to AI. Goal-driven, with per-role personalities,
   the levy/training pipeline, and throttled requests + proactive comms. */
'use strict';
const C = require('../../shared/constants.js');
const B = require('../../shared/balance.js');
const S = require('../../shared/schema.js');
const eco = require('./economy.js');

const PERSONAS = {
  LORD: ['builder', 'warmonger', 'turtler', 'balanced'],
  STEWARD: ['expansionist', 'cautious', 'iron', 'relic'],
  BLACKSMITH: ['quartermaster', 'armorer', 'siege', 'toolsmith'],
  COMMANDER: ['wolf', 'ironwall', 'roadmarshal', 'hammer'],
};
const PERSONA_NAME = {
  builder: 'the Builder', warmonger: 'the Warmonger', turtler: 'the Cautious', balanced: 'the Steady',
  expansionist: 'the Expansionist', cautious: 'the Careful', iron: 'the Ironmonger', relic: 'the Relic-Hunter',
  quartermaster: 'the Quartermaster', armorer: 'the Armorer', siege: 'the Siege-Smith', toolsmith: 'the Toolsmith',
  wolf: 'Wolf Banner', ironwall: 'Iron Wall', roadmarshal: 'Road Marshal', hammer: 'Hammer of Stone',
};

function aiTick(state, team, dt, sys, rng) {
  team.aiState = team.aiState || {};
  team.aiPersona = team.aiPersona || {};
  handleRequests(state, team, sys);
  // AIs withdraw their own permission requests once the resource is no longer held.
  for (const r of team.requests) {
    if (r.status === 'open' && r.type === 'USE') {
      const sl = team.slots[r.fromRole];
      if (sl && sl.controller === C.CONTROLLER.AI && !sys.economy.heldForRole(team, r.payload && r.payload.resource, r.fromRole, team._elapsed || 0)) r.status = 'cancelled';
    }
  }
  for (const role of C.ROLE_ORDER) {
    const slot = team.slots[role];
    if (!slot || slot.controller !== C.CONTROLLER.AI) continue;
    if (!team.aiPersona[role]) {
      team.aiPersona[role] = rng.pick(PERSONAS[role]);
      // Announce identity once so humans know their AI teammates.
      sys.comms.postChat(state, team, role, 'I am ' + C.ROLE_META[role].name + ' ' + PERSONA_NAME[team.aiPersona[role]] + '.', 'chat');
    }
    const st = team.aiState[role] = team.aiState[role] || { t: rng.range(0, B.AI_THINK_INTERVAL), cd: {} };
    st.t -= dt;
    if (st.t > 0) continue;
    // Difficulty sets this AI's action cadence: easy 1/10s, medium 1/5s, hard 1/2s.
    const diff = slot.difficulty || C.AI_DIFFICULTY_DEFAULT;
    st.t = B.AI_DIFFICULTY_INTERVAL[diff] || B.AI_DIFFICULTY_INTERVAL.medium;
    st.acted = false; // one substantive game action per think (communication stays free)
    const persona = team.aiPersona[role];
    try {
      if (role === C.ROLES.LORD) aiLord(state, team, sys, rng, persona, st);
      else if (role === C.ROLES.STEWARD) aiSteward(state, team, sys, rng, persona, st);
      else if (role === C.ROLES.BLACKSMITH) aiBlacksmith(state, team, sys, rng, persona, st);
      else if (role === C.ROLES.COMMANDER) aiCommander(state, team, sys, rng, persona, st);
    } catch (e) { /* AI must never crash the sim */ }
  }
}

// AI answers requests aimed at it (humans included). Grants if feasible. Requests addressed to the
// LORD are weighed deliberately and by priority in lordHandleRequests (called from aiLord), so the
// Lord doesn't reflexively rubber-stamp every resource ask.
function handleRequests(state, team, sys) {
  for (const r of team.requests) {
    if (r.status !== 'open') continue;
    if (r.targetRole === C.ROLES.LORD) continue;
    const slot = team.slots[r.targetRole];
    if (slot && slot.controller === C.CONTROLLER.AI) sys.comms.resolveRequest(state, team, r.id, true, sys);
  }
}

// The AI Lord weighs the council's outstanding asks by strategic value and fulfils the single most
// important one it can each think — keeping the rest OPEN (remembered) to revisit, so even requests
// it can't grant right now are tried over time rather than dropped. USE asks (access to a RESERVED
// resource) are judged strictly: the Lord guards its reservations and only relents for the role it
// reserved for, a genuine emergency, or genuine surplus.
function lordHandleRequests(state, team, sys, st) {
  // 1. Access (USE) requests for held resources — decided NOW, with a stated reason.
  const useReqs = team.requests.filter((r) => r.status === 'open' && r.targetRole === C.ROLES.LORD && r.type === 'USE');
  for (const r of useReqs) {
    const v = evalUseRequest(state, team, r);
    if (v.grant) {
      sys.comms.resolveRequest(state, team, r.id, true, sys);
      say(state, team, sys, st, C.ROLES.LORD, 'Granted — ' + glyphRes(r.payload && r.payload.resource) + ' for ' + roleName(r.fromRole) + (v.why ? ' (' + v.why + ')' : '') + '.', 14);
    } else {
      sys.comms.resolveRequest(state, team, r.id, false, sys);
      say(state, team, sys, st, C.ROLES.LORD, 'No — I am holding the ' + glyphRes(r.payload && r.payload.resource) + (v.reason ? ' ' + v.reason : ' for the realm') + '. Denied.', 14);
    }
  }
  // 2. Everything else by strategic priority — one deliberate fulfilment per think.
  const open = team.requests.filter((r) => r.status === 'open' && r.targetRole === C.ROLES.LORD && r.type !== 'USE');
  if (!open.length) return;
  for (const r of open) r.ttl = Math.max(r.ttl, 30); // keep them alive while we deliberate (memory)
  open.sort((a, b) => reqPriority(state, team, b) - reqPriority(state, team, a));
  for (const r of open) {
    sys.comms.resolveRequest(state, team, r.id, true, sys);
    if (r.status === 'accepted') break;
  }
}
function glyphRes(res) { const m = res && C.RESOURCE_META[res]; return m ? m.glyph + ' ' + res : (res || 'resource'); }
function roleName(role) { return (C.ROLE_META[role] && C.ROLE_META[role].name) || role; }
// Should the Lord grant a USE (access) request for a reserved resource? Strict by design.
function evalUseRequest(state, team, r) {
  const res = r.payload && r.payload.resource;
  if (!res) return { deny: true };
  if (!eco.isHeld(state, team, res)) return { grant: true, why: 'not reserved' };       // nothing to guard
  if (eco.roleAllowed(team, res, r.fromRole, state.elapsed)) return { grant: true, why: 'it is yours to spend' };
  const h = team.holds && team.holds[res];
  const stock = team.resources[res] || 0;
  const keepThreat = team.keep.hp < team.keep.maxHp * 0.5;
  const starving = !!team._starving || (res === 'food' && stock < 12);
  const abundant = stock >= 90;                                                          // genuine surplus — share it
  if (starving) return { grant: true, why: 'famine emergency' };
  if (abundant) return { grant: true, why: 'we have plenty' };
  if (keepThreat && res === 'iron' && (r.fromRole === 'BLACKSMITH' || r.fromRole === 'COMMANDER')) return { grant: true, why: 'the Keep is in danger' };
  // Never freeze the forge: the Blacksmith may draw a working window of reserved raw forge inputs
  // (wood & iron feed spears/tools/siege) so a reservation slows rivals' spending without stalling production.
  if (r.fromRole === 'BLACKSMITH' && (res === 'wood' || res === 'iron')) return { grant: true, why: 'the forge needs it' };
  return { deny: true, reason: (h && h.reason) ? 'for ' + (roleName(h.forRole) || 'the realm') + ' — ' + h.reason : '' };
}
// The Lord proactively RESERVES the most strategically important resources for the role that needs
// them most, with a stated goal — so weapons aren't starved of iron, expansion isn't starved of wood,
// and so on. Reservations are released once their goal lapses; humans' own holds are never touched.
function lordManageReservations(state, team, sys, st, persona) {
  if ((st.cd.reserve || 0) > state.elapsed) return;
  st.cd.reserve = state.elapsed + 12;
  const enemy = state.teams[S.enemyOf(team.team)];
  const atWar = team.pop.soldiers > 2 || enemy.pop.soldiers > 2 || team.keep.hp < team.keep.maxHp * 0.7;
  let owned = 0; for (const id in state.areas) { const a = state.areas[id]; if (a.claimedBy === team.team && a.terrain !== 'base') owned++; }
  const foundation = team.buildings.barracks > 0 && team.buildings.farm > 0 && team.buildings.lumberCamp > 0 && team.buildings.mine > 0;
  const expanding = owned < 3 && state.phase !== 'LATE';
  const fortifying = (team.buildQueue || []).some((b) => b.type === 'walls') || (atWar && !!bestWallArea(state, team));
  const cavalry = team.buildings.stables > 0;
  const R = team.resources;
  const cands = [];
  if (atWar && (R.iron || 0) >= 8) cands.push({ res: 'iron', forRole: 'BLACKSMITH', reason: 'to forge our weapons & armour', w: persona === 'warmonger' ? 100 : 70 });
  if (cavalry && atWar && (R.horses || 0) >= 2) cands.push({ res: 'horses', forRole: 'COMMANDER', reason: 'to muster our cavalry', w: 60 });
  if (fortifying && (R.stone || 0) >= 10) cands.push({ res: 'stone', forRole: 'LORD', reason: 'to fortify the realm with walls', w: persona === 'turtler' ? 90 : 55 });
  if (expanding && foundation && (R.wood || 0) >= 20) cands.push({ res: 'wood', forRole: 'STEWARD', reason: 'to fund new outposts', w: persona === 'builder' ? 80 : 45 });
  cands.sort((a, b) => b.w - a.w);
  const keep = cands.slice(0, 2);                                  // at most two strategic reservations at once
  const keepSet = {}; for (const c of keep) keepSet[c.res] = c;
  // Release our own stale reservations whose goal has lapsed (never touch holds a human Lord set).
  if (team.holds) for (const k in team.holds) { const h = team.holds[k]; if (h && h.byAI && !keepSet[k]) eco.releaseHold(team, k); }
  for (const c of keep) {
    const ex = team.holds && team.holds[c.res];
    if (ex && ex.byAI && ex.forRole === c.forRole) continue;       // already as intended
    if (ex && !ex.byAI) continue;                                  // respect a human-set hold
    eco.setHold(state, team, c.res, 0, c.forRole === 'LORD' ? [] : [c.forRole]);
    const h = team.holds[c.res]; if (h) { h.byAI = true; h.forRole = c.forRole; h.reason = c.reason; }
    say(state, team, sys, st, C.ROLES.LORD, 'Reserving ' + glyphRes(c.res) + ' for ' + roleName(c.forRole) + ' ' + c.reason + '.', 18);
  }
}
// Strategic importance of a Lord-addressed request: who needs the resource most given the war/economy.
function reqPriority(state, team, r) {
  const res = r.payload && r.payload.resource;
  const stock = res ? (team.resources[res] || 0) : 50;
  const enemy = state.teams[S.enemyOf(team.team)];
  const atWar = team.pop.soldiers > 2 || enemy.pop.soldiers > 2 || team.keep.hp < team.keep.maxHp * 0.7;
  let p = { USE: 40, RESERVE: 30, NEED: 35, WORKERS: 25, RECRUITS: atWar ? 45 : 20, BUILD: 20 }[r.type] || 15;
  if (res) p += Math.max(0, 30 - stock) * 0.6;             // scarcer → more urgent
  const f = r.fromRole;
  if (res === 'food') p += 50;                              // food is existential
  if (res === 'iron' && (f === 'BLACKSMITH' || f === 'COMMANDER') && atWar) p += 30;
  if (res === 'wood' && f === 'STEWARD') p += 12;           // expansion
  if (res === 'stone' && f === 'LORD') p += 8;
  p += Math.min(15, (state.elapsed - (r.createdT || 0)) * 0.1); // age boost so nothing starves forever
  return p;
}

// Throttled request: avoid spamming the same ask.
function req(state, team, sys, st, role, target, type, payload, cd) {
  const key = type + ':' + (payload && payload.resource || '');
  if ((st.cd[key] || 0) > state.elapsed) return false;
  st.cd[key] = state.elapsed + (cd || 25);
  sys.comms.createRequest(state, team, role, target, type, payload || {});
  return true;
}
function say(state, team, sys, st, role, text, cd) {
  if ((st.cd['_say'] || 0) > state.elapsed) return;
  st.cd['_say'] = state.elapsed + (cd || 30);
  sys.comms.postChat(state, team, role, text, 'chat');
}
function askIfHeld(state, team, sys, st, role, resource, reason) {
  if (sys.economy.heldForRole(team, resource, role, state.elapsed)) { req(state, team, sys, st, role, C.ROLES.LORD, 'USE', { resource, reason }, 20); return true; }
  return false;
}

// Enemy host sitting on one of our owned areas (threat).
function enemyOnOwned(state, team) {
  const foe = S.enemyOf(team.team);
  for (const g of state.teams[foe].armies) {
    const a = g.moving ? g.moving.route[g.moving.legIndex] : g.area;
    const ar = state.areas[a];
    if (ar && ar.owner === team.team && unitCountG(g) >= 0.5) return ar;
  }
  return null;
}
function unitCountG(g) { let n = 0; for (const u of C.UNITS) n += g.units[u] || 0; return n; }

// ---------------- LORD ----------------
const LORD_CFG = {
  builder:   { policy: 'prosperity', split: { farmers: .34, woodcutters: .24, miners: .16, builders: .14, students: .06, trainers: .06 }, levyPct: .03 },
  warmonger: { policy: 'militarism', split: { farmers: .30, woodcutters: .18, miners: .20, builders: .10, students: .02, trainers: .20 }, levyPct: .12 },
  turtler:   { policy: 'industry',   split: { farmers: .34, woodcutters: .18, miners: .22, builders: .14, students: .04, trainers: .08 }, levyPct: .05 },
  balanced:  { policy: 'prosperity', split: { farmers: .32, woodcutters: .22, miners: .18, builders: .12, students: .05, trainers: .11 }, levyPct: .06 },
};
function aiLord(state, team, sys, rng, persona, st) {
  const eco = sys.economy, p = team.pop, cfg = LORD_CFG[persona] || LORD_CFG.balanced;
  // Same policy rules as the human: setting a policy locks it for 3 minutes (no cooldown bypass).
  if (!team.policy && (team.policyCooldownUntil || 0) <= state.elapsed) { team.policy = cfg.policy; team.policyCooldownUntil = state.elapsed + 180; }
  // Military stance: persona default, adapted to the war. A "Cautious" (turtler) Lord still walls up
  // but doesn't sit permanently defensive — on even footing it lets the Commander operate (balanced),
  // and it presses an advantage rather than hoarding. Same 3-minute cooldown as a human Lord.
  if ((team.militaryPolicyCooldownUntil || 0) <= state.elapsed) {
    const enemy = state.teams[S.enemyOf(team.team)];
    let want = { warmonger: 'aggressive', turtler: 'defensive', builder: 'balanced', balanced: 'balanced' }[persona] || 'balanced';
    const losingKeep = team.keep.hp < team.keep.maxHp * 0.6;
    const behind = losingKeep || (team.pop.soldiers + 4 < enemy.pop.soldiers);
    const ahead = team.pop.soldiers > enemy.pop.soldiers + 3 || enemy.keep.hp < enemy.keep.maxHp * 0.8;
    if (behind) want = 'defensive';
    else if (ahead) want = 'aggressive';
    else if (persona === 'turtler') want = 'balanced';   // even footing — don't smother the Commander
    if (want !== team.militaryPolicy) { team.militaryPolicy = want; team.militaryPolicyCooldownUntil = state.elapsed + 180; }
  }
  const threat = enemyOnOwned(state, team);
  const wf = eco.workforce(team);
  const hasBarracks = team.buildings.barracks > 0;
  const hasSchool = team.buildings.school > 0;
  const lowFood = team.resources.food < 25 || team._starving;
  const lowWood = !lowFood && team.resources.wood < 25; // wood gates almost every building

  // Worker split (scaled to workforce). Specials gated by buildings.
  let s = Object.assign({}, cfg.split);
  if (lowFood) { s = { farmers: .55, woodcutters: .18, miners: .15, builders: .08, students: 0, trainers: .04 }; }
  else if (lowWood) { s = { farmers: .26, woodcutters: .44, miners: .14, builders: .08, students: .02, trainers: .06 }; }
  const builders = team.buildQueue.length ? Math.max(1, Math.round(wf * s.builders)) : 1;
  let trainers = hasBarracks && !lowFood ? Math.min(eco.maxTrainers(team), Math.max(1, Math.round(wf * s.trainers))) : 0;
  let students = hasSchool && !lowFood ? Math.max(0, Math.round(wf * s.students)) : 0;
  let remaining = Math.max(0, wf - builders - trainers - students);
  const farmers = Math.round(remaining * (s.farmers / (s.farmers + s.woodcutters + s.miners)));
  const woodcutters = Math.round(remaining * (s.woodcutters / (s.farmers + s.woodcutters + s.miners)));
  const miners = Math.max(0, remaining - farmers - woodcutters);
  const desired = { farmers, woodcutters, miners, builders, students, trainers };
  // Reallocate on meaningful change, when idle piles up, or when an unlock changes the plan
  // (e.g. a Barracks lets us assign Trainers). Avoid per-tick thrash that traps workers cooling.
  let change = 0; for (const j in desired) change += Math.abs(desired[j] - p[j]);
  const stateKey = (hasBarracks ? 'B' : '') + (hasSchool ? 'S' : '') + (lowFood ? 'F' : '') + (lowWood ? 'W' : '');
  const needRealloc = change >= 2 || p.idle >= 4 || st._allocKey !== stateKey;
  if (!st.acted && needRealloc && (st.allocCd || 0) <= state.elapsed) { eco.setWorkers(state, team, desired); st.allocCd = state.elapsed + 6; st._allocKey = stateKey; st.acted = true; }

  // Levy: commit workers to recruits (one-way). Keep a civilian-workforce floor and cap the
  // army by Barracks capacity, so war never hollows out the economy.
  const recTarget = threat ? 10 : 5;
  const civilianFloor = Math.max(8, Math.floor(team.housing * 0.5));
  const armyCap = (team.buildings.barracks || 0) * 8 + 2;
  const wfNow = eco.workforce(team);
  // Levy when food isn't in crisis. (The old "food > pop*3" gate became unreachable once the
  // storage cap dropped to 100, which starved the whole army pipeline — 40% of teams fielded
  // no soldiers. A flat, cap-reachable threshold plus the civilian floor keeps it safe.)
  const foodHealthy = team.resources.food >= 45 && !lowFood;
  if (!st.acted && p.recruits < recTarget && (p.recruits + p.soldiers) < armyCap && wfNow > civilianFloor && foodHealthy) {
    const maxLevy = Math.min(recTarget - p.recruits, wfNow - civilianFloor, armyCap - (p.recruits + p.soldiers), threat ? 3 : 2);
    if (maxLevy > 0) { const r = eco.levy(team, maxLevy); if (r.ok) { st.acted = true; if (rng.chance(0.4)) say(state, team, sys, st, C.ROLES.LORD, 'Levying recruits for the army.', 35); } }
  } else if (!st.acted && p.idle >= 4 && (p.recruits + p.soldiers) < armyCap && foodHealthy) {
    // Surplus idle labour that gathering can't absorb (worker caps) → put it to military use
    // rather than letting it sit idle. Keep a 2-worker buffer for reassignment flexibility.
    const extra = Math.min(p.idle - 2, armyCap - (p.recruits + p.soldiers));
    if (extra > 0) { const r = eco.levy(team, extra); if (r.ok) st.acted = true; }
  }

  // Build priorities — phase-aware and patient: lay an economic foundation, raise storage caps
  // early, then use the FULL toolkit (school, stables, workshop, walls) in mid/late game. Saves
  // up for a key building instead of greedily draining resources on cheap ones (like a human).
  if (!st.acted && team.buildQueue.length < 1) {
    const planned = (t) => (team.buildings[t] || 0) + team.buildQueue.filter((q) => q.type === t).length;
    const atCap = p.total >= team.housing - 2;
    // Food sits at its cap from turn 1 (it regrows) — only treat wood/stone/iron as "wasting".
    const capHit = ['wood', 'stone', 'iron'].some((k) => (team.resources[k] || 0) >= team.storageCap - 5);
    const wish = [];
    // Foundation.
    if (planned('barracks') < 1) wish.push('barracks');
    if (planned('farm') < 1) wish.push('farm');
    if (planned('lumberCamp') < 1) wish.push('lumberCamp');
    if (planned('mine') < 1) wish.push('mine');
    if (planned('storehouse') < 1) wish.push('storehouse'); // raise caps early so we can stockpile
    if (atCap && planned('house') < 3) wish.push('house');
    if (planned('farm') < 2) wish.push('farm');
    if (planned('lumberCamp') < 2) wish.push('lumberCamp');
    if (planned('mine') < 2) wish.push('mine');
    // Surplus idle labour with capped gatherers → expand gathering so workers aren't wasted.
    if (p.idle >= 4) {
      if (planned('lumberCamp') < 3) wish.push('lumberCamp');
      if (planned('mine') < 3) wish.push('mine');
      if (planned('farm') < 3) wish.push('farm');
    }
    // Mid/late specialization — exercise the full building set.
    if (state.phase !== 'EARLY') {
      if (persona !== 'warmonger' && planned('school') < 1) wish.push('school');
      if (hasBarracks && planned('workshop') < 1) wish.push('workshop');
      if (hasBarracks && planned('stables') < 1) wish.push('stables');
      if (planned('storehouse') < 2) wish.push('storehouse'); // higher cap unlocks Walls (120 stone)
      if (planned('walls') < (persona === 'turtler' ? 2 : 1)) wish.push('walls');
    }
    if ((persona === 'turtler' || threat) && state.phase !== 'EARLY' && planned('walls') < 2) wish.push('walls');
    // Fortify a valuable frontier holding (walls give defenders a big combat edge there).
    if (state.phase !== 'EARLY' && bestWallArea(state, team) && planned('walls') < 3) wish.push('walls');
    if (atCap && planned('house') < 6) wish.push('house');
    if (planned('lumberCamp') < 3) wish.push('lumberCamp'); // wood is the chronic bottleneck
    if (planned('farm') < 3) wish.push('farm');
    if (planned('mine') < 3) wish.push('mine');
    // Urgent: storage capped → stop wasting surplus, build storage now (but never ahead of a
    // first Barracks — training is more important than a little wasted surplus).
    if (capHit && hasBarracks && planned('storehouse') < 3) wish.unshift('storehouse');

    const KEY = { storehouse: 1, school: 1, stables: 1, workshop: 1, walls: 1, barracks: 1 };
    const defaultArea = pickBuildArea(state, team);
    const wallArea = bestWallArea(state, team);
    // Honour the Steward's "conserve wood" request: once the core economy stands, defer optional
    // wood-costing builds while conserve is active so the Steward can fund outposts.
    const conserveWood = eco.conserving(team, 'wood', state.elapsed);
    const hasFoundation = team.buildings.barracks > 0 && team.buildings.farm > 0 && team.buildings.lumberCamp > 0 && team.buildings.mine > 0;
    for (const b of wish) {
      const area = (b === 'walls' && wallArea) ? wallArea : defaultArea; // fortify the frontier, not just the Keep
      if (!area) continue;
      const def = B.BUILDINGS[b]; if (!def) continue;
      if (conserveWood && hasFoundation && (def.cost.wood || 0) > 0) continue;
      if (eco.canAfford(team, def.cost)) { if (sys.buildings.queueBuilding(state, team, area, b).ok) { st.acted = true; break; } }
      else if (KEY[b] && canEventuallyAfford(team, def.cost)) break; // be patient — save for it
    }
  }

  if (threat) { req(state, team, sys, st, C.ROLES.LORD, C.ROLES.COMMANDER, 'DEFEND', { area: threat.id }, 20); say(state, team, sys, st, C.ROLES.LORD, 'Enemy at ' + threat.name + '! Commander, defend it!', 15); }
  else if ((team.resources.iron || 0) < 12 && state.phase !== 'EARLY') req(state, team, sys, st, C.ROLES.LORD, C.ROLES.STEWARD, 'NEED', { resource: 'iron' }, 30);
  else say(state, team, sys, st, C.ROLES.LORD, rng.pick(['Economy steady — building on.', 'The realm grows.', 'Keep the granaries full.']), 45);

  // Set the kingdom's strategic reservations (goal-driven), then weigh and answer the council's asks.
  lordManageReservations(state, team, sys, st, persona);
  lordHandleRequests(state, team, sys, st);
}
function freeSlots(state, team, areaId) { const a = state.areas[areaId]; let n = S.buildingsAt(a); for (const q of team.buildQueue) if (q.areaId === areaId) n++; return a.maxBuildings - n; }
// Patience heuristic: worth saving for a key building only if we can store enough of each
// resource (cap allows it) and we're already at least halfway there (so we never stall from zero).
function canEventuallyAfford(team, cost) {
  for (const k in cost) {
    if (team.storageCap < cost[k]) return false;
    if ((team.resources[k] || 0) < cost[k] * 0.5) return false;
  }
  return true;
}
function pickBuildArea(state, team) {
  const base = S.homeBase(team.team);
  if (freeSlots(state, team, base) > 0) return base;
  for (const id in state.areas) { const a = state.areas[id]; if (a.owner === team.team && a.terrain !== 'base' && freeSlots(state, team, id) > 0) return id; }
  return null;
}

// ---------------- STEWARD ----------------
function aiSteward(state, team, sys, rng, persona, st) {
  const sites = sys.sites;
  const eco = sys.economy;
  // ---- Gathering management (free, like the Lord's worker tuning): equip the Blacksmith's tools to
  //      crews and steer the mines between stone & iron by need, with hysteresis so it doesn't thrash.
  eco.clampGather(team);
  const g = team.gather;
  const stock = Math.floor(team.equipment.tools || 0);
  let spare = stock - (g.desired.food + g.desired.wood + g.desired.mine);
  if (spare > 0) {
    const order = (team.resources.food < 30) ? ['food', 'mine', 'wood'] : ['mine', 'wood', 'food'];
    for (const pool of order) {
      if (spare <= 0) break;
      const room = eco.gatherPoolWorkers(team, pool) - g.desired[pool];
      if (room > 0) { const give = Math.min(room, spare); eco.setGatherTools(state, team, pool, give); spare -= give; }
    }
  }
  // Mine focus: bias stone↔iron by our own scarcity AND by recent council demand (a teammate asking
  // for iron/stone shifts the % toward it, not just adding miners). Hysteresis avoids thrashing.
  const dem = (team._mineDemand && team._mineDemand.until > state.elapsed) ? team._mineDemand.res : null;
  const wantIron = (team.resources.iron || 0) < 40 || dem === 'iron';
  const wantStone = (team.resources.stone || 0) < 40 || dem === 'stone' || (team.buildQueue || []).some((b) => b.type === 'walls');
  let target = B.DEFAULT_MINE_FOCUS;
  if (wantIron && !wantStone) target = B.AI_MINE_FOCUS_MAX;
  else if (wantStone && !wantIron) target = B.AI_MINE_FOCUS_MIN;
  if (Math.abs(target - g.mineIronFocus) > 0.01) { const step = Math.sign(target - g.mineIronFocus) * Math.min(0.1, Math.abs(target - g.mineIronFocus)); eco.setMineFocus(state, team, g.mineIronFocus + step); if (dem && (st.cd.mineSay || 0) <= state.elapsed) { say(state, team, sys, st, C.ROLES.STEWARD, 'Shifting the mines toward ' + dem + ' as asked.', 12); st.cd.mineSay = state.elapsed + 30; } }

  // When wood is scarce and there's land worth claiming, ask the council to conserve wood (throttled).
  if ((team.resources.wood || 0) < 20 && (st.cd.conserve || 0) <= state.elapsed) {
    let claimable = false;
    for (const id in state.areas) { const a = state.areas[id]; if (a.revealed[team.team] && a.site && a.terrain !== 'base' && !a.owner) { claimable = true; break; } }
    if (claimable) {
      team.conserve = team.conserve || {}; team.conserve.wood = state.elapsed + 60;
      sys.comms.postChat(state, team, C.ROLES.STEWARD, '🙏 Wood is short — please conserve 🪵 wood for 60s so I can secure an outpost.', 'request');
      st.cd.conserve = state.elapsed + 120;
    }
  }

  askIfHeld(state, team, sys, st, C.ROLES.STEWARD, 'wood', 'to claim & build outposts');
  // Explore.
  if (!st.acted && !team._busyJob) {
    for (const id in state.areas) { const a = state.areas[id];
      if (!a.revealed[team.team] && a.connections.some((n) => state.areas[n].revealed[team.team])) { if (sites.explore(state, team, id).ok) { st.acted = true; break; } } }
  }
  // Claim — priority by persona + current shortage.
  if (!st.acted && !team._busyJob) {
    const cand = [];
    // Claimable: revealed neutral sites, AND our own ground whose outpost was destroyed when we took
    // it (owner is us but no working outpost yet) — so the Steward rebuilds outposts on captured land.
    for (const id in state.areas) { const a = state.areas[id]; if (a.revealed[team.team] && a.site && a.terrain !== 'base' && (!a.owner || (a.owner === team.team && a.claimedBy !== team.team))) cand.push(a); }
    cand.sort((x, y) => sitePrio(team, persona, y) - sitePrio(team, persona, x));
    for (const a of cand) {
      // Cautious steward won't claim next to an enemy host.
      if (persona === 'cautious' && a.connections.some((n) => enemyAt(state, team, n))) continue;
      if (sites.claim(state, team, a.id).ok) { st.acted = true; say(state, team, sys, st, C.ROLES.STEWARD, 'Claiming ' + a.name + ' for ' + a.resource + '.', 30); break; }
    }
  }
  // Upgrade owned strategic sites.
  if (!st.acted && rng.chance(0.3)) { for (const id in state.areas) { const a = state.areas[id]; if (a.claimedBy === team.team && a.terrain !== 'base' && ['mountain', 'hills'].includes(a.terrain)) { if (sites.upgradeSite(state, team, id).ok) { st.acted = true; break; } } } }
  // Work modes (free): push SAFE rear outposts hard; play it safe at CONTESTED ones (no needless deaths).
  for (const id in state.areas) { const a = state.areas[id];
    if (a.claimedBy !== team.team || a.terrain === 'base' || !a.site) continue;
    const want = sites.areaIsDangerous(state, team, id) ? 'cautious' : 'push';
    if (a.site.workMode !== want) sites.setWorkMode(state, team, id, want);
  }
  // Expeditions: launch one when idle labour is plentiful and we're not in crisis (prefer scarce goods).
  if (!st.acted && !team.expedition && (team.expeditionCooldownUntil || 0) <= state.elapsed && team.pop.idle >= 5 && !team._starving && (st.cd.expedition || 0) <= state.elapsed) {
    const elig = B.EXPEDITIONS.filter((e) => sites.expeditionEligible(state, team, e) && team.pop.idle >= e.workers + 2);
    if (elig.length) {
      elig.sort((x, y) => expeditionValue(team, y) - expeditionValue(team, x));
      if (sites.startExpedition(state, team, elig[0].id).ok) { st.acted = true; st.cd.expedition = state.elapsed + 40; say(state, team, sys, st, C.ROLES.STEWARD, elig[0].name + ' departs — fortune awaits!', 30); }
    }
  }
  // ---- Caravan guards: ask the Commander for guards, then station them where caravans are most
  //      valuable & most exposed (relics first, then iron/horses; weight by how dangerous the route is).
  const home = S.homeBase(team.team);
  const RW = { relics: 5, iron: 3, horses: 2, stone: 1, wood: 1, food: 1 };
  const routeDanger = (a) => { const route = S.findPath(state.areas, a.id, home) || []; let d = 0; for (let i = 1; i < route.length; i++) if (sites.areaIsDangerous(state, team, route[i])) d++; return d; };
  const ownedPosts = [];
  for (const id in state.areas) { const a = state.areas[id]; if (a.claimedBy === team.team && a.terrain !== 'base' && a.site) ownedPosts.push(a); }
  const exposed = ownedPosts.map((a) => ({ a, danger: routeDanger(a), prio: (RW[a.resource] || 1) * (1 + routeDanger(a)) }))
    .filter((o) => o.danger > 0).sort((x, y) => y.prio - x.prio);
  // Ask the Commander for guards when caravans are exposed and our unassigned pool is thin (throttled).
  if (exposed.length && Math.round(team.guards || 0) < 3 && (st.cd.guards || 0) <= state.elapsed) {
    if (req(state, team, sys, st, C.ROLES.STEWARD, C.ROLES.COMMANDER, 'GUARDS', { count: B.GUARD_LEND_DEFAULT }, 30)) {
      st.cd.guards = state.elapsed + 45; say(state, team, sys, st, C.ROLES.STEWARD, 'Our caravans are exposed — Commander, lend us guards!', 15);
    }
  }
  // Station any unassigned guards on the most valuable exposed posts (up to 3 each).
  for (const o of exposed) {
    if (Math.round(team.guards || 0) <= 0) break;
    const want = Math.min(Math.round(team.guards || 0), 3 - Math.round(o.a.site.guards || 0));
    if (want > 0) sites.setGuards(state, team, o.a.id, Math.round(o.a.site.guards || 0) + want);
  }
  // Caravan protection (escort fallback for an in-flight caravan about to hit danger).
  for (const cv of team.caravans) {
    if (!cv.escort && (cv.guards || 0) < 1) { const next = cv.route[cv.legIndex + 1];
      if (next && sites.areaIsDangerous(state, team, next)) { if (req(state, team, sys, st, C.ROLES.STEWARD, C.ROLES.COMMANDER, 'ESCORT', { caravanId: cv.id }, 18)) say(state, team, sys, st, C.ROLES.STEWARD, 'Caravan threatened — escort needed!', 15); break; } }
  }
}
function enemyAt(state, team, areaId) { const foe = S.enemyOf(team.team); return state.teams[foe].armies.some((g) => (g.moving ? g.moving.route[g.moving.legIndex] : g.area) === areaId && unitCountG(g) >= 0.5); }
// Find a nearby enemy caravan a host can intercept: aim at the soonest-reachable point on its remaining
// route. Prefers high-value cargo (relics) and skips caravans that out-gun the host.
function caravanIntercept(state, team, w, maxReach) {
  const foe = state.teams[S.enemyOf(team.team)];
  if (!foe.caravans || !foe.caravans.length) return null;
  const reachCap = maxReach || 4;
  const wa = army.currentArea(w), wn = army.unitCount(w);
  let best = null, bestScore = 0;
  for (const cv of foe.caravans) {
    if ((cv.guards || 0) >= wn) continue;                       // outgunned — don't chase
    const val = cv.resource === 'relics' ? 7 : cv.resource === 'iron' ? 5 : 4;
    for (let li = cv.legIndex + 1; li < cv.route.length; li++) {  // any area still ahead of it
      const tgt = cv.route[li]; const ar = state.areas[tgt];
      if (!ar || ar.terrain === 'base') continue;
      const path = S.findPath(state.areas, wa, tgt); if (!path) continue;
      const reach = path.length - 1; if (reach > reachCap) continue;
      const score = val - reach;
      if (score > bestScore) { bestScore = score; best = tgt; }
    }
  }
  return best;
}
function expeditionValue(team, def) {
  let v = 0;
  for (const k in def.reward) { const short = Math.max(0, 80 - (team.resources[k] || 0)); v += def.reward[k] * (1 + short * 0.02); }
  return v - def.workers * 5 - (def.risk || 0) * 30;
}
function sitePrio(team, persona, a) {
  let base = { mountain: 6, hills: 5, farmland: 4, ruins: 4, forest: 3, plains: 3 }[a.terrain] || 1;
  const short = (k) => (team.resources[k] || 0) < 30;
  if (a.resource && short(a.resource)) base += 3;
  if (persona === 'iron' && (a.terrain === 'mountain' || a.terrain === 'hills')) base += 4;
  if (persona === 'relic' && a.terrain === 'ruins') base += 6;
  if (persona === 'expansionist') base += 1;
  return base;
}

// ---------------- BLACKSMITH ----------------
const SMITH_SPEC = { quartermaster: 'swords', armorer: 'armor', siege: 'siegeParts', toolsmith: 'tools' };
function aiBlacksmith(state, team, sys, rng, persona, st) {
  const prod = sys.production;
  if (!team.blacksmithSpec) team.blacksmithSpec = SMITH_SPEC[persona] || 'swords';
  askIfHeld(state, team, sys, st, C.ROLES.BLACKSMITH, 'iron', 'to forge weapons & armour');
  askIfHeld(state, team, sys, st, C.ROLES.BLACKSMITH, 'wood', 'to forge spears, tools & siege');
  // AI can't play the forging minigame — roll a quality tier from its difficulty distribution.
  const diff = (team.slots.BLACKSMITH && team.slots.BLACKSMITH.difficulty) || 'medium';
  const forge = (item, qty) => { const t = B.rollQuality(diff, rng.float()); return prod.queueProduction(team, item, qty, t.mult, t.id); };
  // Count army composition to read demand.
  const army = countArmy(team);
  const arrowsNeed = army.archer * 8;
  // Arrow crisis.
  if (!st.acted && army.archer > 0 && (team.resources.arrows || 0) < arrowsNeed) {
    if (forge('arrows', 24).ok) { st.acted = true; say(state, team, sys, st, C.ROLES.BLACKSMITH, 'Archers low on arrows — forging a batch.', 20); }
  }
  if (!st.acted && team.production.length < 2) {
    let item;
    if (state.phase === 'EARLY') item = (persona === 'toolsmith' && team.equipment.tools < 10) || team.equipment.tools < 5 ? 'tools' : 'spears';
    else {
      // Forge the gear our army needs against THIS enemy (counter-aware), with persona/diversity flavour.
      const want = pickComposition(team, { comp: ['swordsman', 'spearman', 'archer', 'cavalry'] }, enemyComposition(state, team), army).desired;
      item = GEAR_FOR_UNIT[want] || 'spears';
      if (want === 'archer' && (team.resources.arrows || 0) < 12) item = 'arrows';     // keep archers supplied
      else if (persona === 'siege' && team.buildings.workshop > 0 && rng.chance(0.4)) item = 'siegeParts';
      else if (persona === 'armorer' && (team.resources.iron || 0) > 20 && rng.chance(0.45)) item = 'armor';
      else if (rng.chance(0.25)) item = 'armor';                                       // some armour for the tier bonus
    }
    // Honour the Steward's "conserve wood": defer wood-costing forges (prefer iron-only Swords/Armour).
    if (sys.economy.conserving(team, 'wood', state.elapsed) && B.RECIPES[item] && (B.RECIPES[item].cost.wood || 0) > 0) {
      item = (team.resources.iron || 0) >= ((B.RECIPES.swords && B.RECIPES.swords.cost.iron) || 99) ? 'swords' : null;
    }
    if (item && forge(item, 8).ok) st.acted = true;
  }
  if (!st.acted && !team.contract && team.contractCooldown <= 0 && rng.chance(0.5)) { if (prod.startContract(team, rng.pick(B.CONTRACTS).id).ok) st.acted = true; }
  if ((team.resources.iron || 0) < 12) { if (req(state, team, sys, st, C.ROLES.BLACKSMITH, C.ROLES.STEWARD, 'IRON', {}, 30)) say(state, team, sys, st, C.ROLES.BLACKSMITH, 'Out of iron — Steward, send more!', 25); }
}
function countArmy(team) { const o = { militia: 0, spearman: 0, swordsman: 0, archer: 0, cavalry: 0, catapult: 0 }; for (const g of team.armies) for (const u of C.UNITS) o[u] += g.units[u] || 0; return o; }
function enemyComposition(state, team) { return countArmy(state.teams[S.enemyOf(team.team)]); }
// Smart troop selection: counter the enemy (spears vs cavalry, cavalry vs archers, archers vs slow
// infantry), keep a diverse force, and respect what we can build/afford. Returns the unit we WANT
// (to request gear for) and the best one we can TRAIN right now.
function pickComposition(team, cfg, enemyComp, ownComp) {
  const buildable = (u) => {
    if (u === 'cavalry' && (team.buildings.stables <= 0)) return false;
    if (u === 'catapult' && team.buildings.workshop <= 0) return false;
    return true;
  };
  const totalOwn = C.UNITS.reduce((a, u) => a + (ownComp[u] || 0), 0) || 1;
  const totalFoe = C.UNITS.reduce((a, u) => a + (enemyComp[u] || 0), 0);
  const foeShare = (u) => totalFoe ? (enemyComp[u] || 0) / totalFoe : 0;
  const score = (u) => {
    let s = 1;
    const pi = (cfg && cfg.comp) ? cfg.comp.indexOf(u) : -1;
    if (pi >= 0) s += (cfg.comp.length - pi) * 0.6;          // persona preference
    if (u === 'spearman') s += foeShare('cavalry') * 6;       // anti-cavalry
    if (u === 'cavalry') s += foeShare('archer') * 6;         // run down archers
    if (u === 'archer') s += (foeShare('spearman') + foeShare('swordsman')) * 3 + 1; // soften slow infantry
    if (u === 'swordsman') s += 2;                            // reliable all-rounder
    if (u === 'catapult') s += 0.5;                           // siege utility
    s -= ((ownComp[u] || 0) / totalOwn) * 4;                  // diversity: avoid one-note armies
    if (u === 'militia') s -= 6;                              // last resort only
    return s;
  };
  const cands = C.UNITS.filter(buildable).sort((a, b) => score(b) - score(a));
  return { desired: cands[0] || 'militia', trainable: cands.find((u) => gearAfford(team, u)) || 'militia' };
}
// The gear a Blacksmith must forge to enable a given unit type.
const GEAR_FOR_UNIT = { spearman: 'spears', swordsman: 'swords', archer: 'bows', cavalry: 'swords', catapult: 'siegeParts', militia: 'spears' };

// ---------------- COMMANDER ----------------
const CMD_CFG = {
  wolf:       { doctrine: 'offensive', stance: 'aggressive', winRatio: 1.05, comp: ['swordsman', 'cavalry', 'archer', 'spearman'] },
  ironwall:   { doctrine: 'defensive', stance: 'cautious',   winRatio: 1.4,  comp: ['spearman', 'archer', 'swordsman'] },
  roadmarshal:{ doctrine: 'logistics', stance: 'balanced',   winRatio: 1.15, comp: ['cavalry', 'archer', 'spearman', 'swordsman'] },
  hammer:     { doctrine: 'offensive', stance: 'balanced',   winRatio: 1.25, comp: ['swordsman', 'spearman', 'archer', 'catapult'] },
};
function aiCommander(state, team, sys, rng, persona, st) {
  const army = sys.army, cfg = CMD_CFG[persona] || CMD_CFG.ironwall;
  if (!team.doctrine) team.doctrine = cfg.doctrine;
  const p = team.pop;

  // Need recruits? Ask the Lord.
  if (p.recruits < 2) req(state, team, sys, st, C.ROLES.COMMANDER, C.ROLES.LORD, 'RECRUITS', {}, 25);
  // Need trainers running? (Lord assigns them.) Send an ACTIONABLE request so the Lord sees it.
  if (team.buildings.barracks > 0 && p.trainers <= 0) req(state, team, sys, st, C.ROLES.COMMANDER, C.ROLES.LORD, 'TRAINERS', {}, 30);

  // Prune STALLED training orders: a unit waiting on equipment the Blacksmith can't supply
  // (e.g. swordsman with no swords) parks at progress=1 and clogs the 2-slot queue, so no new
  // (gear-free militia) order can start — the classic "recruits pile up, 0 soldiers" deadlock.
  for (let i = team.training.length - 1; i >= 0; i--) {
    const j = team.training[i];
    if ((j.progress || 0) >= 1 && j.unitType !== 'militia' && !gearAfford(team, j.unitType)) army.cancelTraining(team, j.id);
  }

  // Keep a training order flowing if recruits + trainers available — building a smart, countering mix.
  if (!st.acted && p.recruits >= 1 && p.trainers > 0 && team.training.length < 2) {
    const pick = pickComposition(team, cfg, enemyComposition(state, team), countArmy(team));
    const homeBar = (state.areas[S.homeBase(team.team)].buildings.barracks || 0) > 0 ? S.homeBase(team.team) : army.barracksAreasOf(state, team)[0];
    if (homeBar && army.trainUnits(state, team, homeBar, pick.trainable, Math.min(4, Math.max(1, Math.round(p.recruits)))).ok) st.acted = true;
    // Ask the Blacksmith/Steward for exactly the gear our wanted troops need.
    requestGearFor(state, team, sys, st, pick.desired);
    if (pick.trainable !== pick.desired) requestGearFor(state, team, sys, st, pick.trainable);
  }

  // ---- Strategic command: defend by priority (Keep first, then richest owned site), press a
  //      strong advantage, attack enemy-held land, and siege when it is smart. The Lord's military
  //      stance and our relative strength tilt how aggressive vs cautious the Commander plays. ----
  const g = army.garrison(state, team);
  const home = S.homeBase(team.team);
  const enemyTeam = state.teams[S.enemyOf(team.team)];
  const defensivePersona = persona === 'ironwall';

  // Consolidate: fold any stray idle host sitting at home back into the garrison (no 1-unit spam),
  // but never past the per-location cap — surplus stays as a separate host. Only when the garrison is
  // actually home and stationary (otherwise folding would teleport troops across the map).
  if (army.currentArea(g) === home && !g.moving) {
    for (const h of team.armies) {
      if (h.isGarrison || h.moving || h.harasser) continue;
      const m = h.mission && h.mission.type;
      if (army.currentArea(h) === home && army.unitCount(h) >= 0.5 && (!m || m === 'idle' || m === 'defend')) {
        let room = B.MAX_UNITS_PER_AREA - army.unitCount(g);
        for (const u of C.UNITS) { if (room <= 0) break; const take = Math.min(h.units[u] || 0, Math.floor(room)); room -= army.moveUnits(h, g, u, take); }
      }
    }
  }

  // Aggression bias: Lord's stance (-1..+1) + persona, then tempered by how the war is going.
  const mpol = team.militaryPolicy ? B.MILITARY_POLICIES[team.militaryPolicy] : null;
  let aggr = (mpol ? mpol.aggression : 0) + (persona === 'wolf' ? 1 : 0) + (defensivePersona ? -1 : 0);
  const ourPow = forcePower(army, team), foePow = forcePower(army, enemyTeam);
  const edge = ourPow / Math.max(1, foePow);            // >1 means our army is stronger
  const vulnerable = team.keep.hp < team.keep.maxHp * 0.55 || edge < 0.7;
  if (vulnerable) aggr -= 1;                              // pull in our horns when weak/threatened
  else if (edge > 1.4) aggr += 1;                         // press a clear advantage

  // Defence priorities: the Keep is paramount, then owned sites by building count (most-built first).
  const threats = enemyThreats(state, team);
  const kt = keepThreatInfo(state, team, army);
  // Our real home defence = the garrison PLUS any field host already sitting on the Keep.
  let homeDef = army.unitCount(g);
  for (const h of team.armies) { if (!h.isGarrison && army.unitCount(h) >= 0.5 && army.currentArea(h) === home && !h.moving) homeDef += army.unitCount(h); }
  // The ONLY thing that justifies recalling the WHOLE army is the enemy actually on the Keep, walls
  // already falling, or a force on the doorstep big enough to genuinely storm it (rivalling our home
  // defence). A lone scout — or a single small host poking an adjacent tile — must NOT pin the army:
  // those are met by ONE claimed defender (below) while the rest keep raiding and interdicting caravans.
  // (This was the bug: any enemy adjacent to the Keep force-recalled everything, freezing the offensive.)
  const keepThreat = kt.onKeep >= 0.5 || team.keep.hp < team.keep.maxHp * 0.6 || kt.adj >= Math.max(6, homeDef * 1.1);

  let war = team.armies.find((h) => !h.isGarrison && army.unitCount(h) >= 0.5);
  const garStr = army.unitCount(g);
  const reserve = clampI(3 - aggr, 2, 4);                            // small home guard — commit the rest
  const campaignSize = clampI(7 - aggr, 6, 9);                       // raise only substantial hosts (can break a Keep)
  const maxHosts = clampI(2 + (state.phase === 'LATE' ? 1 : 0), 2, 3); // a strong main host + a raiding party

  // Choose this field host's mission by the priority ladder.
  const decide = (w) => {
    if (army.unitCount(w) < 0.5) return;
    if (keepThreat) { army.command(state, team, w.id, 'defend'); say(state, team, sys, st, C.ROLES.COMMANDER, 'The Keep is threatened — all forces home!', 12); return; }
    // Finish the kill: if the enemy Keep is nearly razed (or this host is already assaulting it) and
    // OUR Keep isn't under threat, COMMIT to the siege regardless of force ratios — abandoning a
    // near-won assault throws the game. Razing needs the position held, so press on to the end.
    const ekArea = state.areas[S.homeBase(S.enemyOf(team.team))];
    const ekBuildings = S.buildingsAt(ekArea);
    const atEnemyKeep = army.currentArea(w) === ekArea.id;
    if ((atEnemyKeep || ekBuildings <= 3) && army.unitCount(w) >= 2) {
      army.command(state, team, w.id, 'siege');
      say(state, team, sys, st, C.ROLES.COMMANDER, ekBuildings <= 1 ? 'Their Keep is all but ours — END THIS!' : 'Press the assault on the enemy Keep!', 16);
      return;
    }
    // Contest an owned site the enemy is physically ON (raiding it) — march in and fight them off.
    // One host per site (claimed). Mere adjacency is answered by counter-attacking below, NOT by
    // parking a host at home (that was the bug: a 20-strong host sat idle vs a 2-unit probe).
    if (threats.length) {
      const claim = (decide._threatClaim = decide._threatClaim || {});
      const t = threats.find((x) => x.here && !claim[x.area]);
      if (t) { claim[t.area] = true; army.command(state, team, w.id, 'garrison', t.area); say(state, team, sys, st, C.ROLES.COMMANDER, 'Driving the enemy off ' + state.areas[t.area].name + '!', 14); return; }
    }
    // Counter-attack: an enemy host or enemy-held post sitting next to OUR land — march out and take it,
    // retaking lost ground and clearing the threat instead of cowering at the Keep.
    if (!vulnerable && army.unitCount(w) >= 2) {
      const claimed = (decide._claimed = decide._claimed || {});
      const ct = counterTarget(state, team, claimed);
      if (ct) { claimed[ct] = true; army.command(state, team, w.id, 'raid', ct); say(state, team, sys, st, C.ROLES.COMMANDER, 'Retaking ' + state.areas[ct].name + '!', 16); return; }
    }
    if (!vulnerable) {
      const cv = team.caravans.find((c) => { const n = c.route[c.legIndex + 1]; return !c.escort && n && sys.sites.areaIsDangerous(state, team, n); });
      if (cv) { army.command(state, team, w.id, 'escort', cv.id); return; }
    }
    // Deny enemy logistics: intercept a reachable enemy caravan — cheap, high-value, especially relics.
    if (!vulnerable) {
      const ic = caravanIntercept(state, team, w);
      if (ic) { army.command(state, team, w.id, 'garrison', ic); say(state, team, sys, st, C.ROLES.COMMANDER, 'Hunting an enemy caravan near ' + state.areas[ic].name + '!', 16); return; }
    }
    // Offence — be opportunistic. SIEGE the enemy Keep when it's weak/exposed (their army is away) or
    // late; otherwise RAID enemy land readily (even near parity — raids deny economy and score points).
    const wn = army.unitCount(w);
    const keepWeak = enemyTeam.keep.hp < enemyTeam.keep.maxHp * 0.6;
    const ekDefenders = enemyTeam.armies.reduce((s, h) => s + (army.currentArea(h) === ekArea.id ? army.unitCount(h) : 0), 0);
    const keepExposed = ekDefenders < wn * 0.7;                       // their Keep is lightly held — strike it
    const canRaid = !vulnerable && edge >= (0.85 - aggr * 0.1);
    const canSiege = !vulnerable && edge >= (1.0 - aggr * 0.12);
    const siegeSize = clampI(5 - aggr, 3, 8);
    if (canSiege && wn >= siegeSize && (state.phase === 'LATE' || keepWeak || keepExposed || edge > 1.25)) {
      army.command(state, team, w.id, 'siege'); say(state, team, sys, st, C.ROLES.COMMANDER, keepExposed ? 'Their Keep lies open — march on it!' : 'The host marches on the enemy Keep!', 18); req(state, team, sys, st, C.ROLES.COMMANDER, C.ROLES.BLACKSMITH, 'EQUIPMENT', {}, 30); return;
    }
    if (canRaid) {
      const tgt = bestAttackTarget(state, team, decide._claimed);
      if (tgt) { (decide._claimed = decide._claimed || {})[tgt] = true; army.command(state, team, w.id, 'raid', tgt); say(state, team, sys, st, C.ROLES.COMMANDER, 'Striking enemy land at ' + state.areas[tgt].name + '!', 22); return; }
    }
    // Nothing to assault right now: hold FORWARD ground near the enemy (project power), never idle at home.
    army.command(state, team, w.id, 'garrison', forwardSite(state, team) || bestSiteToHold(state, team) || home);
  };

  // The harasser's single-minded job: deny enemy logistics. Hold the enemy's busiest Keep-side
  // chokepoint so every caravan home must run our gauntlet; only break off to pounce on a caravan that
  // is RIGHT NEXT to us (one leg away) — chasing a moving caravan just loses the race.
  const harass = (w) => {
    if (keepThreat) { army.command(state, team, w.id, 'defend'); return; }
    const choke = enemySupplyPatrol(state, team);
    let tgt = choke;
    const ic = caravanIntercept(state, team, w, 1);   // only a caravan within ONE leg is worth diverting for
    if (ic) { tgt = ic; say(state, team, sys, st, C.ROLES.COMMANDER, 'Outriders fall on an enemy caravan at ' + state.areas[ic].name + '!', 22); }
    if (!tgt) tgt = forwardSite(state, team) || home;
    if (army.currentArea(w) !== tgt || w.moving) army.command(state, team, w.id, 'garrison', tgt);
  };

  // ---- Orchestrate ALL hosts: keep every field host busy, and raise extra raiding parties from the
  //      garrison surplus so the army is constantly projecting power instead of idling at the Keep. ----
  if (!st.acted) {
    const reinforceHost = (h) => {
      // Top up a home/idle host from the garrison before sending it out (never past the cap, no teleport).
      let room = B.MAX_UNITS_PER_AREA - army.unitCount(h);
      if (army.unitCount(g) > reserve && room > 0 && army.currentArea(h) === home && !h.moving && army.currentArea(g) === home && !g.moving) {
        for (const u of C.UNITS) { if (room <= 0) break; let take = Math.floor((g.units[u] || 0) * ((army.unitCount(g) - reserve) / Math.max(1, army.unitCount(g)))); take = Math.min(take, Math.floor(room)); room -= army.moveUnits(g, h, u, take); }
      }
    };
    const fhs = () => team.armies.filter((h) => !h.isGarrison && army.unitCount(h) >= 0.5);

    if (keepThreat) {
      // Recall the strongest field host to defend (the others keep harassing to relieve pressure).
      const list = fhs().sort((a, b) => army.unitCount(b) - army.unitCount(a));
      if (list.length) { army.command(state, team, list[0].id, 'defend'); say(state, team, sys, st, C.ROLES.COMMANDER, 'Recall! Defend the Keep!', 12); }
    } else {
      // Maintain ONE small, fast caravan-harasser ("Outriders") that roams the enemy's supply lines
      // hunting caravans — exactly the low-soldier roving raider the war effort is otherwise too busy for.
      let har = team.armies.find((h) => h.harasser && army.unitCount(h) >= 0.5);
      if (!har) {
        if ((army.unitCount(g) - reserve) >= 2 && army.currentArea(g) === home && !g.moving) {
          const r = army.rally(state, team, harasserUnits(g), 'Outriders');
          if (r.ok && army.unitCount(r.group) >= 0.5) { r.group.harasser = true; har = r.group; }
        }
        if (!har) { const small = fhs().filter((h) => !h.moving).sort((a, b) => army.unitCount(a) - army.unitCount(b))[0]; if (small && fhs().length > 1) { small.harasser = true; har = small; } }
      }
      // (Re)assign every field host that's idle / sitting at home / just finished a fight. A host that
      // is PINNED fighting guards or already PURSUING a fleeing caravan is left to finish that work.
      for (const h of fhs()) {
        if (h.moving || h.pursue || (h.pinnedUntil && h.pinnedUntil > state.elapsed)) continue;
        const m = h.mission && h.mission.type;
        if (!m || m === 'idle' || m === 'engage' || m === 'defend' || m === 'garrison') {
          if (h.harasser) harass(h);
          else { reinforceHost(h); decide(h); }
        }
      }
      // Raise more main raiding parties from the garrison surplus (the harasser doesn't count toward the cap).
      let guard = 0;
      while (fhs().filter((h) => !h.harasser).length < maxHosts && (army.unitCount(g) - reserve) >= campaignSize && guard++ < 4) {
        const gs = army.unitCount(g);
        const take = Math.min(gs - reserve, B.MAX_UNITS_PER_AREA);
        const r = army.rally(state, team, allUnits(g, Math.min(0.95, take / gs)), fhs().filter((h) => !h.harasser).length === 0 ? (state.phase === 'LATE' ? 'Grand Host' : 'War Host') : 'Raiders');
        if (!r.ok || army.unitCount(r.group) < 0.5) break;
        decide(r.group);
      }
    }
    st.acted = true;
  }

  // Apply the Commander's full toolkit: per-persona stance + a context-appropriate formation
  // (defensive hosts hold a Shield Wall; attackers use a Battle Line). Same actions a human uses.
  for (const h of team.armies) {
    if (army.unitCount(h) < 0.5) continue;
    army.setStance(team, h.id, cfg.stance);
    const m = h.mission && h.mission.type;
    const defensive = h.isGarrison || defensivePersona || m === 'defend' || m === 'garrison';
    army.setFormation(team, h.id, defensive ? 'shieldWall' : 'line');
  }
  // Occasionally re-equip hosts from the armoury so freshly-forged or recovered gear reaches soldiers
  // (and degraded/broken weapons get replaced when better ones exist).
  if ((st.cd.reequip || 0) <= state.elapsed) { for (const h of team.armies) army.reequip(state, team, h.id); st.cd.reequip = state.elapsed + 20; }
}
function bestSiteToHold(state, team) {
  // An owned non-base site closest to the enemy (most likely to be raided) is worth garrisoning —
  // and walls make a site far more defensible, so prefer holding fortified ground.
  let best = null, bestScore = -1;
  for (const id in state.areas) { const a = state.areas[id];
    if (a.owner !== team.team || a.terrain === 'base' || !a.site) continue;
    const score = (a.captureProgress || 0) * 5 + a.site.level + (a.buildings.walls || 0) * 4 + S.buildingsAt(a) + ({ mountain: 3, hills: 2, plains: 2, ruins: 2 }[a.terrain] || 1);
    if (score > bestScore) { bestScore = score; best = id; }
  }
  return best;
}
// Where the AI Lord should raise Walls: the most valuable / most threatened owned site with a free
// slot (so frontier holdings are fortified), falling back to the Keep.
function bestWallArea(state, team) {
  let best = null, bestScore = -1;
  for (const id in state.areas) { const a = state.areas[id];
    if (a.owner !== team.team || a.terrain === 'base') continue;
    if (S.buildingsAt(a) >= a.maxBuildings) continue;        // no free slot
    if ((a.buildings.walls || 0) >= 1) continue;             // already walled
    const nearEnemy = a.connections.some((n) => state.areas[n] && state.areas[n].owner === S.enemyOf(team.team)) ? 4 : 0;
    const score = S.buildingsAt(a) * 2 + (a.site ? a.site.level : 0) + nearEnemy;
    if (score > bestScore) { bestScore = score; best = id; }
  }
  return best;
}
function clampI(v, lo, hi) { return Math.max(lo, Math.min(hi, Math.round(v))); }
// Rough relative army strength (count, with an armoured bonus) for an edge comparison.
function forcePower(army, team) {
  let p = 0;
  for (const g of team.armies) { const n = army.unitCount(g); if (n < 0.5) continue; p += n * (g.hasArmor ? 1.6 : 1); }
  return p;
}
// Enemy strength actually ON our Keep vs merely ADJACENT to it — used to tell a real assault from a
// lone scout probing the doorstep, so a token harasser can't pin the whole army home.
function keepThreatInfo(state, team, army) {
  const foe = S.enemyOf(team.team);
  const kid = S.homeBase(team.team);
  const k = state.areas[kid];
  let onKeep = 0, adj = 0;
  for (const g of state.teams[foe].armies) {
    const n = army.unitCount(g); if (n < 0.5) continue;
    const a = g.moving ? g.moving.route[g.moving.legIndex] : g.area;
    if (a === kid) onKeep += n;
    else if (k.connections.indexOf(a) >= 0) adj += n;
  }
  return { onKeep, adj };
}
// Owned areas under threat (enemy host on them or an adjacent area), sorted Keep-first then by
// building count — exactly the defence priority the Lord asked for.
function enemyThreats(state, team) {
  const foe = S.enemyOf(team.team);
  const enemyAt = {};
  for (const g of state.teams[foe].armies) { if (unitCountG(g) < 0.5) continue; const a = g.moving ? g.moving.route[g.moving.legIndex] : g.area; enemyAt[a] = (enemyAt[a] || 0) + unitCountG(g); }
  const out = [];
  for (const id in state.areas) { const a = state.areas[id];
    if (a.owner !== team.team) continue;
    const here = enemyAt[id] || 0;
    let adj = 0; for (const n of a.connections) adj += (enemyAt[n] || 0);
    // Enemies ON the site are always a threat (they raid it); a force merely NEXT DOOR only counts once
    // it's big enough to actually take the site — a lone scout shouldn't pull a host off the offensive.
    if (!(here >= 0.5 || adj >= 2)) continue;
    out.push({ area: id, isKeep: a.terrain === 'base', buildings: S.buildingsAt(a), here: here >= 0.5, force: here + adj });
  }
  out.sort((x, y) => ((y.isKeep ? 1e6 : 0) + y.buildings + (y.here ? 0.5 : 0)) - ((x.isKeep ? 1e6 : 0) + x.buildings + (x.here ? 0.5 : 0)));
  return out;
}
// An enemy host — or enemy-held post — sitting NEXT TO our territory: the prime counter-attack target,
// so a strong host marches out to clear the threat and retake the ground rather than parking at home.
// Prefers posts with an enemy host on them, bordering our Keep, and richer ground. Skips claimed targets.
function counterTarget(state, team, claimed) {
  const foe = S.enemyOf(team.team);
  const home = S.homeBase(team.team);
  const enemyAt = {};
  for (const g of state.teams[foe].armies) { const n = unitCountG(g); if (n < 0.5) continue; const a = g.moving ? g.moving.route[g.moving.legIndex] : g.area; enemyAt[a] = (enemyAt[a] || 0) + n; }
  let best = null, bestScore = -1;
  for (const id in state.areas) { const a = state.areas[id];
    if (a.terrain === 'base') continue;
    if (claimed && claimed[id]) continue;
    const here = enemyAt[id] || 0;
    const held = a.owner === foe;
    if (here < 0.5 && !held) continue;                                          // only enemy hosts / enemy land
    if (!a.connections.some((n) => state.areas[n] && state.areas[n].owner === team.team)) continue; // must border us
    const score = here * 2 + (held ? 4 : 0) + S.buildingsAt(a) + (a.site ? a.site.level : 0) + (a.connections.indexOf(home) >= 0 ? 5 : 0);
    if (score > bestScore) { bestScore = score; best = id; }
  }
  return best;
}
function bestAttackTarget(state, team, exclude) {
  const foe = S.enemyOf(team.team);
  let best = null, score = -1;
  for (const id in state.areas) { const a = state.areas[id];
    if (a.terrain === 'base') continue;
    if (exclude && exclude[id]) continue;                                                   // another host already claimed it
    let s = -1;
    if (a.owner === foe) s = S.buildingsAt(a) * 3 + (a.site ? a.site.level : 0) + 3;        // enemy-held land
    else if (!a.owner && a.revealed[team.team] && a.site) s = a.site.level + 1;              // neutral site to contest
    if (s > score) { score = s; best = id; }
  }
  return best;
}
// A node on the enemy's supply lines worth holding: the enemy Keep's neighbour that the most in-flight
// caravans must pass (every caravan home runs the Keep gauntlet), else the busiest enemy outpost.
function enemySupplyPatrol(state, team) {
  const foe = S.enemyOf(team.team);
  const ek = state.areas[S.homeBase(foe)];
  const enemyTeam = state.teams[foe];
  const chokes = ek.connections.filter((id) => state.areas[id] && state.areas[id].terrain !== 'base');
  if (!chokes.length) return null;
  const score = {}; chokes.forEach((c) => { score[c] = 0; });
  for (const cv of enemyTeam.caravans) { for (let li = cv.legIndex; li < cv.route.length; li++) { if (score[cv.route[li]] !== undefined) score[cv.route[li]]++; } }
  let best = null, bestS = -1;
  for (const c of chokes) { const s = score[c] * 10 + (state.areas[c].owner === foe ? 2 : 1); if (s > bestS) { bestS = s; best = c; } }
  return best;
}
// A small, fast strike force for the harasser — favour cavalry, then cheap bodies; ~4 units.
function harasserUnits(g) {
  const o = {}; for (const u of C.UNITS) o[u] = 0;
  let need = 4;
  for (const u of ['cavalry', 'militia', 'archer', 'spearman', 'swordsman', 'catapult']) {
    if (need <= 0) break;
    const take = Math.min(g.units[u] || 0, need);
    if (take > 0) { o[u] = take; need -= take; }
  }
  return o;
}
// The most FORWARD staging ground (owned or contestable site closest to the enemy Keep) to hold when
// there's nothing to assault — so hosts press toward the front instead of idling at home.
function forwardSite(state, team) {
  const ekx = state.areas[S.homeBase(S.enemyOf(team.team))].x;
  let best = null, bestD = 1e9;
  for (const id in state.areas) { const a = state.areas[id];
    if (a.terrain === 'base') continue;
    if (a.owner === team.team || (!a.owner && a.revealed[team.team] && a.site)) {
      const d = Math.abs(a.x - ekx);
      if (d < bestD) { bestD = d; best = id; }
    }
  }
  return best;
}
// True if the team can currently afford one unit's equipment/resource needs.
function gearAfford(team, unitType) {
  const needs = C.UNIT_META[unitType].needs || {};
  for (const k in needs) {
    const have = (team.equipment[k] !== undefined) ? team.equipment[k] : (team.resources[k] || 0);
    if (have < needs[k]) return false;
  }
  return true;
}
function chooseUnit(team, cfg) {
  for (const u of cfg.comp) {
    if (u === 'cavalry' && (team.buildings.stables <= 0 || (team.resources.horses || 0) < 1)) continue;
    if (u === 'catapult' && team.buildings.workshop <= 0) continue;
    const needs = C.UNIT_META[u].needs || {};
    let ok = true; for (const k in needs) { const have = (team.equipment[k] !== undefined) ? team.equipment[k] : (team.resources[k] || 0); if (have < 1) ok = false; }
    if (ok) return u;
  }
  return 'militia';
}
function requestGearFor(state, team, sys, st, type) {
  const needs = C.UNIT_META[type].needs || {};
  for (const k in needs) {
    const have = (team.equipment[k] !== undefined) ? team.equipment[k] : (team.resources[k] || 0);
    if (have < 2) {
      if (k === 'horses') req(state, team, sys, st, C.ROLES.COMMANDER, C.ROLES.STEWARD, 'NEED', { resource: 'horses' }, 30);
      else req(state, team, sys, st, C.ROLES.COMMANDER, C.ROLES.BLACKSMITH, 'EQUIPMENT', { item: k }, 30); // specific gear for this troop type
    }
  }
  // Archers also need arrows in the field.
  if (type === 'archer' && (team.resources.arrows || 0) < 10) req(state, team, sys, st, C.ROLES.COMMANDER, C.ROLES.BLACKSMITH, 'NEED', { resource: 'arrows' }, 30);
}
function allUnits(g, frac) { const o = {}; for (const u of C.UNITS) o[u] = Math.floor((g.units[u] || 0) * frac); return o; }
function pickRaidTarget(state, team) {
  const enemy = S.enemyOf(team.team);
  let best = null;
  for (const id in state.areas) { const a = state.areas[id]; if (a.terrain === 'base') continue; if (a.claimedBy === enemy) return id; if (!a.owner && a.revealed[team.team]) best = id; }
  return best;
}

module.exports = { aiTick };
