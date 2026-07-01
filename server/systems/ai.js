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
// Order in which the AI Lord buys research, by Lord persona. It walks the list and takes the next
// affordable tier (each upgrade is a 3-tier line). Every line is reachable; this just sets emphasis.
const RESEARCH_PRIORITY = {
  builder:   ['agriculture', 'logging', 'quarrying', 'mining', 'growth', 'architecture', 'granaries', 'foundry', 'scholarship', 'weapons', 'armour', 'provisioning', 'tower', 'siege'],
  warmonger: ['weapons', 'armour', 'foundry', 'provisioning', 'siege', 'mining', 'logging', 'tower', 'agriculture', 'quarrying', 'growth', 'architecture', 'granaries', 'scholarship'],
  turtler:   ['armour', 'tower', 'architecture', 'agriculture', 'granaries', 'quarrying', 'logging', 'weapons', 'foundry', 'mining', 'growth', 'provisioning', 'scholarship', 'siege'],
  balanced:  ['agriculture', 'weapons', 'logging', 'mining', 'foundry', 'armour', 'provisioning', 'growth', 'quarrying', 'architecture', 'tower', 'granaries', 'siege', 'scholarship'],
  default:   ['agriculture', 'logging', 'mining', 'weapons', 'foundry', 'armour', 'provisioning', 'growth', 'quarrying', 'architecture', 'granaries', 'tower', 'siege', 'scholarship'],
};

function isHard(team, role) { const s = team.slots && team.slots[role]; return !!(s && s.difficulty === 'hard'); }
function smartHard(team, role) { return isHard(team, role) && team._hardVariant !== 'old'; }
// Per-feature A/B gate: ships difficulty-agnostic brain upgrades for BOTH medium and hard, and lets the
// harness isolate ONE improvement by disabling just that feature on the baseline side (team._abOff[feat])
// while keeping all previously-accepted fixes on. In production neither flag is set, so every feature is live.
function ab(team, feat) { return team._hardVariant !== 'old' && !(team._abOff && team._abOff[feat]); }
function mfOn(team) { return ab(team, 'minefocus'); }

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
    // NEVER let the AI act for a seat a human has CLAIMED (playerId set) — not even during a brief
    // disconnect/reload when the seat momentarily reverts to AI control. Otherwise the AI Lord would re-run
    // its worker allocation (setWorkers bypasses the lock, since the AI Lord IS the allocator) and stomp a
    // human Lord's LOCKED workforce on every connection blip — the persistent "AI keeps changing my workers
    // even when locked" complaint. (An intentional lobby switch to AI clears playerId, so real AI seats run.)
    if (slot.playerId) continue;
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
    // Only a genuine AI seat answers automatically — never one a HUMAN has claimed (playerId set), even
    // during a brief disconnect when the seat momentarily reverts to AI control.
    if (slot && slot.controller === C.CONTROLLER.AI && !slot.playerId) sys.comms.resolveRequest(state, team, r.id, true, sys);
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
// The Lord's own building GOAL: the next important structure it WANTS but can't yet afford. While it has
// such a goal, the Lord reserves the resource it's short on FOR ITSELF — so the Steward doesn't sink that
// wood/stone into outposts before the Lord can build its Barracks or tech. With no blocking goal (it can
// afford what it wants, or wants nothing pressing), the Lord stays flexible and lets the resource flow.
function lordBuildGoal(state, team) {
  const planned = (t) => (team.buildings[t] || 0) + (team.buildQueue || []).filter((q) => q.type === t).length;
  const want = [];
  if (planned('lumberCamp') < 2) want.push('lumberCamp');   // wood economy underpins everything — protect it first
  if (planned('barracks') < 1) want.push('barracks');
  if (state.phase !== 'EARLY') {
    if (planned('lumberCamp') < 3) want.push('lumberCamp');
    if (planned('workshop') < 1) want.push('workshop');     // unlocks catapults
    if (planned('school') < 1) want.push('school');         // unlocks education → research
    if (planned('school') >= 1 && planned('university') < 1) want.push('university');
    if (planned('stables') < 1) want.push('stables');       // unlocks cavalry
  }
  for (const b of want) {
    const def = B.BUILDINGS[b]; if (!def) continue;
    if (eco.canAfford(team, def.cost)) continue;            // can build it right now — not a blocking goal
    let res = null, worst = 0;
    for (const k in def.cost) { const short = def.cost[k] - (team.resources[k] || 0); if (short > worst) { worst = short; res = k; } }
    if (res) return { building: b, res };
  }
  return null;
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
  // The Lord's OWN building goal comes first: lock the resource it's short on for itself so the Steward
  // can't drain it on outposts before the Lord builds its Barracks/tech. (No goal ⇒ no self-lock.)
  const goal = lordBuildGoal(state, team);
  if (goal && (R[goal.res] || 0) >= 6) cands.push({ res: goal.res, forRole: 'LORD', reason: 'to build a ' + (B.BUILDINGS[goal.building] ? B.BUILDINGS[goal.building].name : goal.building), w: 95 });
  // "I have a plan — hands off the wood." While saving for a wood/stone building the team can't yet
  // afford, the Lord asks the council to CONSERVE that good so it actually ACCUMULATES (the Blacksmith
  // eases off wood gear, the Steward defers outposts) instead of being nibbled away to a stuck
  // equilibrium. With no such goal the Lord is flexible — no conserve, everyone spends freely.
  if (goal && (goal.res === 'wood' || goal.res === 'stone')) {
    team.conserve = team.conserve || {};
    team.conserve[goal.res] = Math.max(team.conserve[goal.res] || 0, state.elapsed + 20);
  }
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
// When starving and slot-constrained, the least-valuable Keep buildings to raze for a Farm (most expendable
// first). Never sacrifices food/wood/ore production, the Barracks, walls, the last Storehouse, or housing in use.
const DEMOLISH_PRIORITY = ['marketplace', 'university', 'school', 'stables', 'workshop', 'storehouse', 'house'];
function pickDemolishForFarm(team, area) {
  const here = area.buildings || {};
  for (const t of DEMOLISH_PRIORITY) {
    if ((here[t] || 0) <= 0) continue;
    if (t === 'storehouse' && (team.buildings.storehouse || 0) <= 1) continue;       // keep at least one Storehouse
    if (t === 'house' && team.pop.total >= team.housing - 4) continue;               // don't raze housing we're living in
    return t;
  }
  return null;
}
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
  // Food SUSTAINABILITY: the net food rate (production − upkeep). Reacting only when the stockpile is already
  // empty is too late — by then the army's upkeep is locked in and outruns farming, and the realm starves.
  // So treat a draining/flat trend as "strain" and farm proactively + stop growing an army we can't feed.
  const foodRate = (team.resourceStats && team.resourceStats.food) ? team.resourceStats.food.rate : 0;
  const foodSafe = ab(team, 'foodsafe');
  // Enemy-reactive posture: only spend workers/wood SHORING UP FOOD when we're not under military pressure.
  // If the enemy is out-massing us (or on our land / battering the Keep), those resources are better spent on
  // the army — investing in food while losing the war just loses faster. When safe, we fix sustainability
  // (build Farms, add Farmers) so we never starve mid-snowball.
  const _enemy = state.teams[S.enemyOf(team.team)];
  const econSafe = foodSafe && !threat && (_enemy.pop.soldiers <= team.pop.soldiers + 4) && team.keep.hp > team.keep.maxHp * 0.7;
  const foodStrain = econSafe && !lowFood && foodRate < 0.25;

  // Worker split (scaled to workforce). Specials gated by buildings.
  let s = Object.assign({}, cfg.split);
  if (lowFood) { s = { farmers: .55, woodcutters: .18, miners: .15, builders: .08, students: 0, trainers: .04 }; }
  else if (foodStrain) { s = { farmers: .38, woodcutters: .30, miners: .16, builders: .08, students: .02, trainers: .06 }; }   // safe to bolster farming before the stockpile crashes
  else if (lowWood) { s = { farmers: .26, woodcutters: .44, miners: .14, builders: .08, students: .02, trainers: .06 }; }
  // woodopen (opening-tempo test — wood is the universal bottleneck: every building, outpost claim and most
  // gear needs it, so getting wood income up FIRST compounds across the whole game): in a healthy early game
  // bias the split toward woodcutters so the economy/build engine spins up faster.
  else if (ab(team, 'woodopen') && state.phase === 'EARLY') { s = { farmers: .30, woodcutters: .34, miners: .14, builders: .12, students: .04, trainers: .06 }; }
  // fastbuild (opening-tempo follow-up to woodopen — more wood early is only useful if it becomes BUILDINGS
  // fast): while we have a build queue early, commit more hands to construction so the economy spins up sooner.
  if (ab(team, 'fastbuild') && state.phase === 'EARLY' && team.buildQueue.length && !lowFood) s.builders = Math.max(s.builders, 0.20);
  const builders = team.buildQueue.length ? Math.max(1, Math.round(wf * s.builders)) : 1;
  let trainers = hasBarracks && !lowFood ? Math.min(eco.maxTrainers(team), Math.max(1, Math.round(wf * s.trainers))) : 0;
  // maxtrainers (MID instrumentation — 40% of the time trainers sit below the Barracks cap while recruits
  // WAIT, so the army trains slower than it could): when recruits are queued and food is fine, fill the
  // trainer slots to the Barracks cap so recruits convert to soldiers at full throughput.
  if (ab(team, 'maxtrainers') && hasBarracks && !lowFood && (p.recruits || 0) > 0) trainers = eco.maxTrainers(team);
  let students = hasSchool && !lowFood ? Math.max(0, Math.round(wf * s.students)) : 0;
  let remaining = Math.max(0, wf - builders - trainers - students);
  const farmers = Math.round(remaining * (s.farmers / (s.farmers + s.woodcutters + s.miners)));
  const woodcutters = Math.round(remaining * (s.woodcutters / (s.farmers + s.woodcutters + s.miners)));
  const miners = Math.max(0, remaining - farmers - woodcutters);
  const desired = { farmers, woodcutters, miners, builders, students, trainers };
  // Reallocate on meaningful change, when idle piles up, or when an unlock changes the plan
  // (e.g. a Barracks lets us assign Trainers). Avoid per-tick thrash that traps workers cooling.
  let change = 0; for (const j in desired) change += Math.abs(desired[j] - p[j]);
  const stateKey = (hasBarracks ? 'B' : '') + (hasSchool ? 'S' : '') + (lowFood ? 'F' : '') + (lowWood ? 'W' : '') + (foodStrain ? 'f' : '');
  const needRealloc = change >= 2 || p.idle >= 4 || st._allocKey !== stateKey;
  if (!st.acted && needRealloc && (st.allocCd || 0) <= state.elapsed) { eco.setWorkers(state, team, desired); st.allocCd = state.elapsed + 6; st._allocKey = stateKey; st.acted = true; }

  // Levy: commit workers to recruits (one-way). Keep a civilian-workforce floor and cap the
  // army by Barracks capacity, so war never hollows out the economy.
  const recTarget = threat ? 10 : 5;
  const civilianFloor = Math.max(8, Math.floor(team.housing * 0.5));
  const armyCap = (team.buildings.barracks || 0) * 8 + 2;
  const wfNow = eco.workforce(team);
  // Levy when food isn't in crisis. (Food sustainability is handled by SCALING FARMS up to feed the army,
  // not by shrinking the army — capping army growth on the food trend just makes the team militarily weak.)
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
    // EMERGENCY: our army pipeline was DESTROYED — we once had a Barracks, now have none (it was razed) and
    // can't train the recruits we're holding. Rebuilding it is the most urgent build (the analysed loss: Red
    // sat with 10 recruits and 0 Barracks for 7 minutes). Jump it to the very front. (We track _hadBarracks
    // so this only fires on a genuine LOSS, not a team that simply hasn't built its first Barracks yet.)
    if ((team.buildings.barracks || 0) > 0) team._hadBarracks = true;
    const armyPipelineLost = ab(team, 'rebuildmil') && team._hadBarracks && (team.buildings.barracks || 0) === 0
      && team.buildQueue.every((q) => q.type !== 'barracks');
    if (armyPipelineLost) wish.push('barracks');
    // Enemy-reactive RUSH: if the enemy already fields soldiers and we have no Barracks yet, pull the Barracks
    // to the FRONT so we can answer the threat — economy can wait when a hostile army is already on the map.
    // (The build loop saves for the first unaffordable KEY building it hits, so fronting it rushes it.)
    const rushBarracks = ab(team, 'barracksslot') && (team.buildings.barracks || 0) === 0
        && team.buildQueue.every((q) => q.type !== 'barracks') && state.teams[S.enemyOf(team.team)].pop.soldiers >= 3;
    // Under food strain, a Farm comes FIRST — sustaining the population/army outranks every other build.
    if (foodStrain && planned('farm') < 4) wish.push('farm');
    // Foundation. WOOD underpins everything (every building, every outpost, most gear), so establish a
    // real wood income FIRST — two lumber camps before the Barracks — or the team crashes its wood and
    // can never afford the Barracks, tech buildings (Workshop/School/University) or outposts.
    if (planned('lumberCamp') < 1) wish.push('lumberCamp');
    if (planned('farm') < 1) wish.push('farm');
    // FIRST BARRACKS, EARLY & IN THE KEEP (earlybarracks): the army is the backbone — heavily prefer raising a
    // Barracks right after the minimal food+wood foundation (one Farm + one Lumber Camp), placed behind the
    // Watchtower at the Keep (milkeep/safeMilArea). Delaying it until the economy is fully built leaves us with
    // zero soldiers when the enemy pushes; with the Keep's extra build slot there's room to spare for it.
    if (ab(team, 'earlybarracks') && planned('barracks') < 1) wish.push('barracks');
    // A 2nd Farm EARLY (while wood is still available) — one Farm caps farmers at 4 (~1.2 food/s), which
    // can't feed a growing army under the higher food demand; the team then starves because by the time the
    // 2nd Farm reaches the build list, wood has crashed and it can never afford the 60 wood. Build it now.
    if (econSafe && planned('farm') < 2) wish.push('farm');
    if (planned('lumberCamp') < 2) wish.push('lumberCamp');   // 2nd camp BEFORE the Barracks — wood income must scale early
    if (planned('barracks') < 1) wish.push('barracks');
    if (planned('mine') < 1) wish.push('mine');
    // GROWTH (lesson from strong human play — they fielded ~2x our population): population growth is gated by
    // housing, and a House sits low in this list, so a Prosperity realm can idle at its housing cap instead of
    // growing into more workers/soldiers. When food is plentiful and the gathering base exists to employ the new
    // hands, raise a House proactively (right after the economic foundation) so the population keeps compounding.
    if (ab(team, 'growthhousing') && atCap && (team.resources.food || 0) >= 50 && (team.buildings.lumberCamp || 0) >= 2 && planned('house') < 4) wish.push('house');
    if (planned('lumberCamp') < 3) wish.push('lumberCamp');   // 3rd camp — chronic wood demand (outposts + tech + gear)
    if (planned('storehouse') < 1) wish.push('storehouse'); // raise caps early so we can stockpile
    if (atCap && planned('house') < 3) wish.push('house');
    if (planned('farm') < 2) wish.push('farm');
    if (planned('mine') < 2) wish.push('mine');
    // Surplus idle labour with capped gatherers → expand gathering so workers aren't wasted.
    if (p.idle >= 4) {
      if (planned('lumberCamp') < 4) wish.push('lumberCamp');
      if (planned('mine') < 3) wish.push('mine');
      if (planned('farm') < 3) wish.push('farm');
    }
    // Mid/late specialization — exercise the full building set.
    if (state.phase !== 'EARLY') {
      if (persona !== 'warmonger' && planned('school') < 1) wish.push('school');
      if (planned('school') >= 1 && planned('university') < 1) wish.push('university');  // unlocks Research
      if (hasBarracks && planned('workshop') < 1) wish.push('workshop');
      if (hasBarracks && planned('stables') < 1) wish.push('stables');
      // Marketplace: lets the Steward barter a glut into a shortage. Build it when we have a real
      // imbalance to trade away (a tradable good near its cap while another runs dry), or to round out
      // the tech tree once the University stands.
      const tradeGlut = ['food', 'wood', 'stone', 'iron', 'horses'].some((k) => (team.resources[k] || 0) >= team.storageCap * 0.85);
      const tradeDef = ['wood', 'stone', 'iron', 'horses'].some((k) => (team.resources[k] || 0) <= team.storageCap * 0.15);
      if (hasBarracks && planned('marketplace') < 1 && ((tradeGlut && tradeDef) || planned('university') >= 1)) wish.push('marketplace');
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

    const KEY = { lumberCamp: 1, storehouse: 1, school: 1, stables: 1, workshop: 1, university: 1, walls: 1, barracks: 1, marketplace: 1 };
    // Apply the enemy-reactive Barracks rush: front the wish so the Lord saves for it ahead of economy.
    if (rushBarracks) wish.unshift('barracks');
    const defaultArea = pickBuildArea(state, team);
    const wallArea = bestWallArea(state, team);
    // Critical MILITARY buildings (Barracks/Workshop/Stables) belong behind the Watchtower at the Keep — a
    // Barracks at an exposed outpost is deleted by a single raid, killing the whole army pipeline (the loss
    // in the analysed game). Place them at the Keep; only if it's full, the SAFEST rear site (never a frontier).
    const MIL = ab(team, 'milkeep') ? { barracks: 1, workshop: 1, stables: 1 } : {};
    const safeMilArea = (b) => {
      const base = S.homeBase(team.team);
      if (freeSlots(state, team, base) > 0) return base;
      // Keep full → safest owned site: farthest from the enemy, prefer walled, with a free slot.
      const foe = S.enemyOf(team.team); const ek = S.homeBase(foe);
      let best = null, bestScore = -1e9;
      for (const id in state.areas) { const a = state.areas[id];
        if (a.owner !== team.team || a.claimedBy !== team.team || a.terrain === 'base' || freeSlots(state, team, id) <= 0) continue;
        const bordersEnemy = a.connections.some((n) => state.areas[n] && (state.areas[n].owner === foe || n === ek));
        const sc = (a.buildings && a.buildings.walls ? 5 : 0) - (bordersEnemy ? 10 : 0) - (a.connections.indexOf(ek) >= 0 ? 5 : 0);
        if (sc > bestScore) { bestScore = sc; best = id; }
      }
      return best;
    };
    // Honour the Steward's "conserve wood" request: once the core economy stands, defer optional
    // wood-costing builds while conserve is active so the Steward can fund outposts.
    const conserveWood = eco.conserving(team, 'wood', state.elapsed);
    const hasFoundation = team.buildings.barracks > 0 && team.buildings.farm > 0 && team.buildings.lumberCamp > 0 && team.buildings.mine > 0;
    // RESERVE A KEEP SLOT FOR THE BARRACKS: the Keep has only ~6 buildable slots; if economy (farms, lumber
    // camps, houses, storehouse) greedily fills them first, the Barracks gets shoved to an exposed outpost —
    // or, when rushed by a human, never gets built and we field ZERO soldiers (the live-vs-human loss). So
    // once the Keep is down to its last free slot and no Barracks exists yet, don't let a non-military build
    // take that slot — hold it (and save) for the Barracks.
    const keepBase = S.homeBase(team.team);
    const noBarracksYet = (team.buildings.barracks || 0) === 0 && team.buildQueue.every((q) => q.type !== 'barracks');
    // Only reserve the slot / rush when the enemy ACTUALLY fields an army — otherwise (the normal symmetric
    // econ-vs-econ opening) reserving a slot just delays our economy for no reason. This makes the fix neutral
    // in AI-vs-AI but decisive against a human who rushes military early (which AI-vs-AI testing can't model).
    const enemyArmy = (state.teams[S.enemyOf(team.team)].pop.soldiers || 0) >= 3;
    const reserveBarracksSlot = ab(team, 'barracksslot') && noBarracksYet && enemyArmy;
    for (const b of wish) {
      const area = MIL[b] ? safeMilArea(b) : ((b === 'walls' && wallArea) ? wallArea : defaultArea); // military to the Keep; walls fortify the frontier
      if (!area) continue;
      // Don't let a non-military Keep build consume the last slot the Barracks needs.
      if (reserveBarracksSlot && b !== 'barracks' && area === keepBase && freeSlots(state, team, keepBase) <= 1) continue;
      const def = B.BUILDINGS[b]; if (!def) continue;
      if (conserveWood && hasFoundation && (def.cost.wood || 0) > 0) continue;
      if (eco.canAfford(team, def.cost)) { if (sys.buildings.queueBuilding(state, team, area, b).ok) { st.acted = true; break; } }
      else if (KEY[b] && canEventuallyAfford(team, def.cost)) break; // be patient — save for it
    }
  }

  // EMERGENCY repurpose: when the realm is genuinely STARVING and we can't simply build a Farm because the
  // Keep's build slots are full, raze the least-valuable building at the Keep (the Watchtower defends it) to
  // make room for a Farm. An extreme, rate-limited measure — only when food is actually failing.
  if (ab(team, 'demolishai') && !st.acted && (st.cd.demo || 0) <= state.elapsed &&
      (team._starving || (lowFood && foodRate < 0))) {
    const keep = state.areas[S.homeBase(team.team)];
    const farmsPlanned = (team.buildings.farm || 0) + team.buildQueue.filter((q) => q.type === 'farm').length;
    const keepSlots = S.buildingsAt(keep) + team.buildQueue.filter((q) => q.areaId === keep.id).length;
    if (farmsPlanned < (B.MAX_PER_BUILDING.farm || 4) && keepSlots >= keep.maxBuildings) {
      const sacrifice = pickDemolishForFarm(team, keep);
      if (sacrifice) {
        const r = sys.buildings.demolishBuilding(state, team, keep.id, sacrifice, null);
        if (r.ok) {
          st.acted = true; st.cd.demo = state.elapsed + 30;
          say(state, team, sys, st, C.ROLES.LORD, 'Razing our ' + B.BUILDINGS[sacrifice].name + ' to raise a Farm — the realm is starving!', 18);
          if (eco.canAfford(team, B.BUILDINGS.farm.cost)) sys.buildings.queueBuilding(state, team, keep.id, 'farm');
        }
      }
    }
  }

  else if ((team.resources.iron || 0) < 12 && state.phase !== 'EARLY') req(state, team, sys, st, C.ROLES.LORD, C.ROLES.STEWARD, 'NEED', { resource: 'iron' }, 30);
  else say(state, team, sys, st, C.ROLES.LORD, rng.pick(['Economy steady — building on.', 'The realm grows.', 'Keep the granaries full.']), 45);

  // EMERGENCY military catch-up (your rule): the enemy out-militaries us and we have NO Barracks, but the
  // Keep is FULL (no slot for one). Raze a DUPLICATE Keep building — highly preferring economy dupes (a 2nd
  // farm / 2nd lumber camp / spare house) — to free a slot and raise a Barracks. Without an army we just lose.
  if (ab(team, 'barracksrescue') && !st.acted && (st.cd.demo || 0) <= state.elapsed) {
    const keep = state.areas[S.homeBase(team.team)];
    const enemy = state.teams[S.enemyOf(team.team)];
    const noBar = (team.buildings.barracks || 0) === 0 && team.buildQueue.every((q) => q.type !== 'barracks');
    const behindMil = (enemy.pop.soldiers || 0) > (team.pop.soldiers || 0);
    const keepFull = (S.buildingsAt(keep) + team.buildQueue.filter((q) => q.areaId === keep.id).length) >= keep.maxBuildings;
    if (noBar && behindMil && keepFull) {
      // Sacrifice a DUPLICATE (count ≥ 2), least-critical first — never the last of any building, never fixed.
      const PREF = ['house', 'storehouse', 'marketplace', 'farm', 'lumberCamp', 'mine', 'school', 'stables', 'workshop', 'university'];
      let sac = null; for (const tname of PREF) { if ((keep.buildings[tname] || 0) >= 2) { sac = tname; break; } }
      if (sac && sys.buildings.demolishBuilding(state, team, keep.id, sac, null).ok) {
        st.acted = true; st.cd.demo = state.elapsed + 30;
        say(state, team, sys, st, C.ROLES.LORD, 'Razing a spare ' + B.BUILDINGS[sac].name + ' to raise a Barracks — we need an army!', 18);
        if (eco.canAfford(team, B.BUILDINGS.barracks.cost)) sys.buildings.queueBuilding(state, team, keep.id, 'barracks');
      }
    }
  }

  // The Lord steers the mines: if its next building is blocked on iron/stone (or the realm is short), ask the
  // Steward to bias the stone↔iron split toward it. The Steward weights the Lord's request highest & holds it.
  if (mfOn(team) && state.phase !== 'EARLY') {
    const bgoal = lordBuildGoal(state, team);
    let mineRes = null;
    if (bgoal && (bgoal.res === 'iron' || bgoal.res === 'stone')) mineRes = bgoal.res;
    else if ((team.resources.iron || 0) < 25) mineRes = 'iron';
    else if ((team.resources.stone || 0) < 25 || (team.buildQueue || []).some((q) => q.type === 'walls')) mineRes = 'stone';
    if (mineRes) req(state, team, sys, st, C.ROLES.LORD, C.ROLES.STEWARD, 'MINEFOCUS', { res: mineRes }, 40);
  }

  // Smart expansion: when the Keep's build slots are (nearly) full and we hold a defensible position with a
  // real army, have the Steward claim a new outpost — more build slots + a fresh resource. Only when we can
  // plausibly hold it (we have soldiers and aren't being overrun), and only if there's neutral ground to take.
  if (ab(team, 'expandsmart') && state.phase !== 'EARLY' && !threat && (st.cd.expand || 0) <= state.elapsed) {
    const home = state.areas[S.homeBase(team.team)];
    const homeNearFull = S.buildingsAt(home) >= home.maxBuildings - 1;
    const adequateMil = team.pop.soldiers >= 4 && team.keep.hp > team.keep.maxHp * 0.6;
    let hasNeutral = false;
    for (const id in state.areas) { const a = state.areas[id]; if (a.revealed[team.team] && a.site && a.terrain !== 'base' && !a.owner) { hasNeutral = true; break; } }
    if (homeNearFull && adequateMil && hasNeutral) {
      if (req(state, team, sys, st, C.ROLES.LORD, C.ROLES.STEWARD, 'SITE', { mode: 'expand' }, 60)) say(state, team, sys, st, C.ROLES.LORD, 'Our Keep is full — Steward, claim us new ground!', 30);
      st.cd.expand = state.elapsed + 50;
    }
  }

  // Research: staff the University with educated workers and spend RP on prioritised upgrades.
  aiManageResearch(state, team, sys, rng, persona, st);

  // Set the kingdom's strategic reservations (goal-driven), then weigh and answer the council's asks.
  lordManageReservations(state, team, sys, st, persona);
  lordHandleRequests(state, team, sys, st);
}

// AI research brain: ensure there are educated workers + researchers at a University, then buy the
// next affordable upgrade by a persona-weighted priority. (No-op until a University is built.)
function aiManageResearch(state, team, sys, rng, persona, st) {
  if ((team.buildings.university || 0) <= 0) return;
  const p = team.pop;
  // 1. Make sure some workers are being educated (researchers must be educated).
  if (team.buildings.school > 0 && p.educated < 5 && p.students < 3 && p.idle > 1) {
    sys.economy.adjustWorker(state, team, 'students', Math.min(2, p.idle - 1));
  }
  // 2. Staff the University from educated idle workers (keep a small civilian buffer).
  const rcap = Math.min(eco.maxResearchers(team), p.educated);
  if (p.researchers < rcap && p.idle > 1) {
    const add = Math.min(rcap - p.researchers, p.idle - 1);
    if (add > 0) sys.economy.setResearchers(state, team, add);
  }
  // 3. Spend Research Points on the next tier of a prioritised line we can afford.
  // 3a. Keep Expansion (REACTIVE & RARE — a turtling play only): pack the safe, defensible Keep with even more
  // buildings, but only when there's genuinely nowhere else to build and materials are plentiful. Gate hard:
  //  • a turtling posture (turtler persona or a defensive military policy);
  //  • the Keep is full AND owned outposts have at most 2 free slots total (no real cheaper room to expand);
  //  • we have a comfortable surplus of wood/stone beyond the cost, and a relic to spare (relics are also score).
  if (state.phase !== 'EARLY' && (persona === 'turtler' || team.militaryPolicy === 'defensive')) {
    const home = S.homeBase(team.team);
    const khCur = (team.research && team.research.keephall) || 0;
    const khDef = B.RESEARCH.keephall;
    if (khCur < khDef.tiers.length && freeSlots(state, team, home) <= 0) {
      let outpostRoom = 0;
      for (const id in state.areas) { const a = state.areas[id]; if (a.owner === team.team && a.terrain !== 'base' && a.site) outpostRoom += Math.max(0, freeSlots(state, team, id)); }
      const tier = khDef.tiers[khCur];
      const plentyMaterials = (team.resources.wood || 0) >= (tier.cost.wood || 0) + 100 && (team.resources.stone || 0) >= (tier.cost.stone || 0) + 80;
      const relicReserve = (team.resources.relics || 0) >= (tier.cost.relics || 0) + 1;
      if (outpostRoom <= 2 && plentyMaterials && relicReserve && (team.researchPoints || 0) >= tier.rp && eco.canAfford(team, tier.cost)) {
        if (sys.economy.buyResearch(state, team, 'keephall').ok) { st.acted = true; say(state, team, sys, st, C.ROLES.LORD, '🏯 Expanded the Keep — another build slot (T' + (khCur + 1) + ').', 25); return; }
      }
    }
  }
  const order = RESEARCH_PRIORITY[persona] || RESEARCH_PRIORITY.default;
  for (const key of order) {
    const def = B.RESEARCH[key]; if (!def) continue;
    const cur = (team.research && team.research[key]) || 0;
    if (cur >= def.tiers.length) continue;
    const tier = def.tiers[cur];
    if ((team.researchPoints || 0) < tier.rp) continue;
    if (!eco.canAfford(team, tier.cost)) continue;
    if (sys.economy.buyResearch(state, team, key).ok) { st.acted = true; say(state, team, sys, st, C.ROLES.LORD, '📚 Researched ' + def.name + ' (T' + (cur + 1) + ').', 25); break; }
  }
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
  // Only CLAIMED outposts are buildable — seized-but-unclaimed ground (owner set, no outpost) must be
  // re-claimed by the Steward first, so don't route Lord builds there (they'd just fail).
  for (const id in state.areas) { const a = state.areas[id]; if (a.owner === team.team && a.claimedBy === team.team && a.terrain !== 'base' && freeSlots(state, team, id) > 0) return id; }
  return null;
}

// ---------------- STEWARD ----------------
function aiSteward(state, team, sys, rng, persona, st) {
  // If a human has CLAIMED this seat (playerId set), the AI must never act for it — not even during a
  // brief disconnect/reload when the seat momentarily reverts to AI control. The Steward's caravan/work
  // modes, guards, policy and actions are the player's alone; the AI hijacking them is exactly the
  // "things keep getting set for me" complaint. (An intentional lobby switch to AI clears playerId.)
  const seat = team.slots[C.ROLES.STEWARD];
  if (seat && seat.playerId) return;
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
  const demObj = (team._mineDemand && team._mineDemand.until > state.elapsed) ? team._mineDemand : null;
  const dem = demObj ? demObj.res : null;
  const wantIron = (team.resources.iron || 0) < 40 || dem === 'iron';
  const wantStone = (team.resources.stone || 0) < 40 || dem === 'stone' || (team.buildQueue || []).some((b) => b.type === 'walls');
  let target = B.DEFAULT_MINE_FOCUS;
  if (mfOn(team) && demObj) {
    // An accepted request (or our own committed shift) HOLDS the focus firmly on the asked ore for the whole
    // demand window — a competing shortage no longer cancels what the council asked for (≥30s, longer for the Lord).
    target = dem === 'iron' ? B.AI_MINE_FOCUS_MAX : B.AI_MINE_FOCUS_MIN;
  } else if (wantIron && !wantStone) {
    target = B.AI_MINE_FOCUS_MAX;
    if (mfOn(team)) team._mineDemand = { res: 'iron', until: state.elapsed + 30, role: 'STEWARD', self: true };   // commit our own shift ≥30s (don't thrash)
  } else if (wantStone && !wantIron) {
    target = B.AI_MINE_FOCUS_MIN;
    if (mfOn(team)) team._mineDemand = { res: 'stone', until: state.elapsed + 30, role: 'STEWARD', self: true };
  }
  if (Math.abs(target - g.mineIronFocus) > 0.01) { const step = Math.sign(target - g.mineIronFocus) * Math.min(0.1, Math.abs(target - g.mineIronFocus)); eco.setMineFocus(state, team, g.mineIronFocus + step); if (dem && !(demObj && demObj.self) && (st.cd.mineSay || 0) <= state.elapsed) { say(state, team, sys, st, C.ROLES.STEWARD, 'Shifting the mines toward ' + dem + ' as asked.', 12); st.cd.mineSay = state.elapsed + 30; } }

  // Dangerous home labour: when a good is critically short AND we have population to spare (comfortably
  // above the floor and not in a famine), push that crew hard for +50% output at the risk of losing a
  // worker. Stand them down the moment the shortage eases or the population thins — never gamble lives
  // in a famine. This is free (like the Lord's worker tuning), so it isn't gated by st.acted.
  {
    const dres = team.resources, dcap = team.storageCap || 100, dp = team.pop;
    // Stricter safety for smart AI: only gamble lives with a comfortable population buffer, never while
    // starving, never while shrinking (deaths outran births since last check), and never while an enemy is
    // raiding our land (we can't afford to bleed workers AND ground at once). Constant dangerous-work deaths
    // with no buffer were a real drag in the analysed game.
    let dwSafe = !team._starving && (dp.total || 0) > B.POP_FLOOR + 6;
    if (ab(team, 'dangerwork')) {
      const shrinking = (team._dwLastPop != null) && (dp.total || 0) < team._dwLastPop;
      const underRaid = stewardUnderRaid(state, team);
      dwSafe = !team._starving && (dp.total || 0) > B.POP_FLOOR + 10 && !shrinking && !underRaid;
    }
    // Respect the Lord's worker LOCK: dangerous work KILLS home workers (farmers/woodcutters/miners), so when
    // the Lord has locked the workforce, the AI Steward must never gamble their lives — and must STAND DOWN any
    // crew that's already on dangerous work (so a pre-lock toggle stops bleeding the Lord's locked workers).
    if (team.workerLock) dwSafe = false;
    team._dwLastPop = dp.total || 0;
    const dw = team.dangerWork || {};
    team._dwOn = team._dwOn || {};   // pool -> elapsed when dangerous work was switched ON (for the time cap)
    // Dangerous work is a brief, last-resort burst: only START a crew when its good is CRITICALLY low
    // (<12% of cap) and we're safe; keep it on only while still short AND for at most 30s; then stand down.
    const DW_CRIT = 0.12, DW_RELIEF = 0.22, DW_MAX_SEC = 30;
    const dwWantPool = (pool, keys) => {
      if (!dwSafe) return false;
      const v = Math.min.apply(null, keys.map((k) => (dres[k] || 0) / dcap));
      if (dw[pool]) {
        // Already on: stop as soon as it's no longer critically short, OR the 30s burst is up.
        if ((state.elapsed - (team._dwOn[pool] || state.elapsed)) >= DW_MAX_SEC) return false;
        return v < DW_RELIEF;
      }
      return v < DW_CRIT;   // only start when truly critical
    };
    const dwWant = { food: dwWantPool('food', ['food']), wood: dwWantPool('wood', ['wood']), mine: dwWantPool('mine', ['iron', 'stone']) };
    for (const pool of ['food', 'wood', 'mine']) {
      if (!!dw[pool] !== !!dwWant[pool]) {
        eco.setDangerWork(state, team, pool, dwWant[pool]);
        if (dwWant[pool]) team._dwOn[pool] = state.elapsed;   // stamp the moment we turned it on
      }
    }
  }

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
  askIfHeld(state, team, sys, st, C.ROLES.STEWARD, 'stone', 'to claim outposts');   // claiming costs wood AND stone
  // ---- Scouting: keep a few Scouts and reveal/maintain the frontier so our soldiers never fight blind
  //      (unscouted areas cost us 20% attack & defence). Owned outposts stay scouted automatically.
  const unscoutedAdj = [];
  for (const id in state.areas) {
    const a = state.areas[id];
    if (a.scouted[team.team]) continue;
    if (a.connections.some((n) => state.areas[n].scouted[team.team] || state.areas[n].owner === team.team)) unscoutedAdj.push(a);
  }
  const wantScouts = unscoutedAdj.length > 0 || !!team.scoutJob;
  // Respect the Lord's worker lock: assigning/removing Scouts moves people in & out of the idle pool, which
  // is worker allocation — when the Lord has locked it, the Steward must not touch the worker counts.
  if (!team.workerLock) {
    if (wantScouts && (team.pop.scouts || 0) < 3 && team.pop.idle > 2) eco.setScouts(state, team, Math.min(3 - (team.pop.scouts || 0), team.pop.idle - 2));
    else if (!wantScouts && (team.pop.scouts || 0) > 0 && !team.scoutJob) eco.setScouts(state, team, -(team.pop.scouts));
  }
  if (!team.scoutJob && (team.pop.scouts || 0) > 0 && unscoutedAdj.length) {
    unscoutedAdj.sort((x, y) => scoutPrio(state, team, y) - scoutPrio(state, team, x));
    sites.explore(state, team, unscoutedAdj[0].id);
  }
  // Claim — priority by persona + current shortage.
  // Don't starve the Lord's FOUNDATION: while we still lack a Barracks (the army's home), reserve enough
  // wood & stone for it before sinking resources into outposts. Beyond that, the Lord's own resource
  // RESERVATIONS (it locks wood/stone for its tech goals) gate our spending — so here we only guard the
  // very first Barracks; the Lord decides when wood is free for expansion.
  const noBarracks = (team.buildings.barracks || 0) < 1 && team.buildQueue.every((q) => q.type !== 'barracks');
  const bWood = (B.BUILDINGS.barracks.cost.wood || 0), bStone = (B.BUILDINGS.barracks.cost.stone || 0);
  // barracksfirst (your rules): tie EXPANSION to military progress so the Steward can't sprawl into outposts
  // while the realm has no army. Cap owned outposts at:
  //   • 1  — while we have no Barracks AND no soldier (build the Barracks + first troops before more land);
  //   • 2  — once we have a Barracks and at least 1 soldier;
  //   • 3+ — only when our military actually EXCEEDS the enemy's (and we have a Barracks).
  let ownedSites = 0; for (const id in state.areas) { const a = state.areas[id]; if (a.claimedBy === team.team && a.terrain !== 'base') ownedSites++; }
  const _hasBarracks = (team.buildings.barracks || 0) >= 1;
  const _hasMilitary = (team.pop.soldiers || 0) >= 1;
  const _enemy = state.teams[S.enemyOf(team.team)];
  const _milEdge = (team.pop.soldiers || 0) > (_enemy.pop.soldiers || 0);
  const siteCap = (_hasBarracks && _milEdge) ? Infinity : (_hasBarracks && _hasMilitary) ? 2 : 1;
  const overCap = ab(team, 'barracksfirst') && ownedSites >= siteCap;
  const reserveForCore = overCap || (noBarracks && ((team.resources.wood || 0) < bWood + 20 || (team.resources.stone || 0) < bStone + 10));
  if (!st.acted && !team._busyJob && !reserveForCore) {
    const cand = [];
    // Claimable: SCOUTED neutral sites, AND our own ground whose outpost was destroyed when we took
    // it (owner is us but no working outpost yet) — so the Steward rebuilds outposts on captured land.
    // (You can only build on SCOUTED ground now, so don't bother trying unscouted sites.)
    for (const id in state.areas) { const a = state.areas[id]; if (a.scouted[team.team] && a.site && a.terrain !== 'base' && (!a.owner || (a.owner === team.team && a.claimedBy !== team.team))) cand.push(a); }
    cand.sort((x, y) => sitePrio(state, team, persona, y) - sitePrio(state, team, persona, x));
    for (const a of cand) {
      // Cautious steward won't claim next to an enemy host.
      if (persona === 'cautious' && a.connections.some((n) => enemyAt(state, team, n))) continue;
      if (sites.claim(state, team, a.id).ok) { st.acted = true; say(state, team, sys, st, C.ROLES.STEWARD, 'Claiming ' + a.name + ' for ' + a.resource + '.', 30); if (ab(team, 'outpostguard')) say(state, team, sys, st, C.ROLES.STEWARD, 'Raising an outpost at ' + a.name + ' — Commander, cover it!', 12); break; }
    }
  }
  // Upgrade owned strategic sites.
  if (!st.acted && rng.chance(0.3)) { for (const id in state.areas) { const a = state.areas[id]; if (a.claimedBy === team.team && a.terrain !== 'base' && ['mountain', 'hills'].includes(a.terrain)) { if (sites.upgradeSite(state, team, id).ok) { st.acted = true; break; } } } }
  // Work & caravan modes (free, but on a 3-min cooldown each and locked while under attack): a SAFE rear
  // outpost runs Maximum Production with Push caravans; a CONTESTED one digs in Defensive with Cautious
  // caravans. setWorkMode/setCaravanMode self-reject if on cooldown or under attack — harmless.
  for (const id in state.areas) { const a = state.areas[id];
    if (a.claimedBy !== team.team || a.terrain === 'base' || !a.site) continue;
    if (sites.areaUnderAttack(state, team, id)) continue;
    const danger = sites.areaIsDangerous(state, team, id);
    const wantWork = danger ? 'defensive' : 'maxProduction';
    const wantCaravan = danger ? 'cautious' : 'fast';
    if (a.site.workMode !== wantWork && (a.site.workModeUntil || 0) <= state.elapsed) sites.setWorkMode(state, team, id, wantWork);
    if (a.site.caravanMode !== wantCaravan && (a.site.caravanModeUntil || 0) <= state.elapsed) sites.setCaravanMode(state, team, id, wantCaravan);
  }
  // Expeditions: launch one from the CURRENT OFFERS when idle labour is plentiful and we're not in
  // crisis (prefer scarce goods). Bring tools along (if any) to lower the crew-loss risk.
  if (!st.acted && !team.workerLock && !team.expedition && (team.expeditionCooldownUntil || 0) <= state.elapsed && team.pop.idle >= 5 && !team._starving && (st.cd.expedition || 0) <= state.elapsed) {
    const offers = (team.expeditionOffers && team.expeditionOffers.length) ? team.expeditionOffers : B.EXPEDITIONS.map((e) => e.id);
    const elig = offers.map((eid) => B.EXPEDITIONS.find((e) => e.id === eid)).filter((e) => e && sites.expeditionEligible(state, team, e) && team.pop.idle >= e.workers + 2);
    if (elig.length) {
      elig.sort((x, y) => expeditionValue(team, y) - expeditionValue(team, x));
      if (sites.startExpedition(state, team, elig[0].id, true).ok) { st.acted = true; st.cd.expedition = state.elapsed + 40; say(state, team, sys, st, C.ROLES.STEWARD, elig[0].name + ' departs — fortune awaits!', 30); }
    }
  }
  // ---- Stewardship: adopt a standing policy matching our greatest need, and occasionally enact a
  //      beneficial timed action when goods can be spared. (AI ignores the human-only supervise game.)
  if ((team.stewardPolicyCooldownUntil || 0) <= state.elapsed) {
    const res = team.resources;
    const scarce = ['food', 'wood', 'stone', 'iron'].sort((a, b) => (res[a] || 0) - (res[b] || 0))[0];
    const minRes = Math.min(res.food || 0, res.wood || 0, res.stone || 0, res.iron || 0);
    const heavyBuild = (team.buildQueue || []).length >= 2;
    // Logistics-bound? Owned posts whose haul-route runs through danger benefit from faster caravans.
    const logisticsBound = (function () { let n = 0; for (const id in state.areas) { const a = state.areas[id]; if (a.claimedBy === team.team && a.terrain !== 'base' && a.site) { const route = S.findPath(state.areas, id, S.homeBase(team.team)) || []; for (let i = 1; i < route.length; i++) if (sites.areaIsDangerous(state, team, route[i])) { n++; break; } } } return n >= 2; })();
    let wantPol = 'pol_' + scarce;                                  // default: shore up our scarcest good
    if (minRes > team.storageCap * 0.5) {
      // Comfortably supplied — spend the slot on a force multiplier instead of another resource trickle.
      wantPol = heavyBuild ? 'pol_buildcost' : (logisticsBound ? 'pol_caravan' : 'pol_growth');
    } else if (heavyBuild && minRes > team.storageCap * 0.3) {
      wantPol = 'pol_buildcost';                                    // mid-supply but building hard: cheaper builds win
    }
    if (team.stewardPolicy !== wantPol) eco.setStewardPolicy(state, team, wantPol);
  }
  if (!st.acted && (team.stewardActionCooldownUntil || 0) <= state.elapsed && (st.cd.stewardAction || 0) <= state.elapsed) {
    const res = team.resources, cap = team.storageCap || 100;
    const cand = [];
    // ---- Crisis responders first ----
    // Larder thinning with many mouths under arms → cut soldier upkeep before a famine bites.
    if ((res.food || 0) < cap * 0.35 && (team.pop.soldiers || 0) >= 4) cand.push('rationing');
    // A storehouse brimming on any good → raise every cap so the surplus isn't wasted (the late-game stall).
    if (['food', 'wood', 'stone', 'iron'].some((k) => (res[k] || 0) >= cap - 8)) cand.push('emergencyStores');
    // An enemy host on or beside our ground → stiffen every troop's defence for the coming fight.
    if (homeUnderThreat(state, team)) cand.push('musterLevy');
    // A host marching to strike → speed the columns so the blow lands before the foe can ready.
    if (team.armies.some((h) => h.moving && h.mission && ['attack', 'raid', 'siege'].includes(h.mission.type))) cand.push('rally');
    // Soldiers worn down on forward deployment → run a supply train so they tire half as fast. Only worth it
    // when a few troops are actually posted AWAY from the Keep (idle garrison regenerates for free) and only
    // once they've begun to tire — so the 90s buff isn't wasted on a fresh or home-bound army.
    {
      const homeId = S.homeBase(team.team);
      let fwdUnits = 0, fwdEnergy = 0;
      for (const h of team.armies) {
        if (h.isGarrison) continue;
        const n = unitCountG(h);
        if (n >= 0.5 && areaOf(h) !== homeId) { fwdUnits += n; fwdEnergy += (typeof h.energy === 'number' ? h.energy : 100) * n; }
      }
      if (fwdUnits >= 3 && (fwdEnergy / Math.max(1, fwdUnits)) < 80) cand.push('fieldSupply');
    }
    // ---- Steady-state boosters ----
    if (!team._starving && team.pop.total < team.housing) cand.push('fertility');
    if (team.production && team.production.length) cand.push('forgeBellows');     // forge busy → speed it
    if (team.training && team.training.length) cand.push('warDrills');            // training troops → speed it
    if (team.buildQueue && team.buildQueue.length) cand.push('corvee');           // building → speed it
    if (team.scoutJob || unscoutedAdj.length >= 2) cand.push('pathfinders');      // frontier to map → scout faster
    if (team.pop.idle >= 5) cand.push('overseers');
    if ((team.buildings.university || 0) > 0) cand.push('scholars');
    // ---- Instant conversions / relic learning (only when the inputs can truly be spared) ----
    if ((res.food || 0) > cap * 0.6 && ['wood', 'stone', 'iron'].some((k) => (res[k] || 0) < 25)) cand.push('grainLevy');
    if ((res.relics || 0) >= 1 && !team._starving) cand.push('learnRelics');
    cand.push('postRoads');
    const _foodRate = (team.resourceStats && team.resourceStats.food) ? team.resourceStats.food.rate : 0;
    const foodTight = ab(team, 'stewardfood') && (team._starving || _foodRate < 0.1 || (team.resources.food || 0) < (team.storageCap || 100) * 0.3);
    for (const id of cand) {
      const a = B.STEWARD_ACTIONS_BY_ID[id];
      if (!a) continue;
      if (((team.stewardActionCD && team.stewardActionCD[id]) || 0) > state.elapsed) continue;
      // Food-aware: when our net food production is low/negative (or the larder is thin), don't spend FOOD on
      // discretionary stewardship buffs — except grainLevy (which RELIEVES a shortage by converting surplus).
      if (foodTight && (a.cost && (a.cost.food || 0) > 0) && id !== 'grainLevy') continue;
      if (!eco.canAfford(team, a.cost)) continue;
      if (a.workers && (team.workerLock || team.pop.idle < a.workers + 2)) continue;  // respect the Lord's worker lock; otherwise keep a couple of idle workers in reserve
      // Don't bleed a good down into scarcity for an ordinary buff — but the instant conversions
      // (grainLevy/learnRelics) ARE the point, so they ride on affordability + their own trigger above.
      if (!a.instant) { let tooPoor = false; for (const k in a.cost) if ((team.resources[k] || 0) - a.cost[k] < team.storageCap * 0.15) tooPoor = true; if (tooPoor) continue; }
      if (eco.doStewardAction(state, team, id).ok) { st.acted = true; st.cd.stewardAction = state.elapsed + 60; say(state, team, sys, st, C.ROLES.STEWARD, a.glyph + ' ' + a.name + ' — for the realm!', 25); break; }
    }
  }
  // ---- Market barter: with a Marketplace, convert a commodity glutted at the cap (being wasted) into
  //      one we're critically short of. marketTrade self-rejects on the Lord's reserved goods. ----
  if ((team.buildings.marketplace || 0) > 0 && (team.marketTradeUntil || 0) <= state.elapsed) {
    const res = team.resources, cap = team.storageCap || 100, goods = B.MARKET_TRADE_RESOURCES;
    const glut = goods.filter((k) => (res[k] || 0) >= cap - 5).sort((a, b) => (res[b] || 0) - (res[a] || 0))[0];
    const need = goods.filter((k) => (res[k] || 0) < B.MARKET_TRADE_IN).sort((a, b) => (res[a] || 0) - (res[b] || 0))[0];
    if (glut && need && glut !== need && eco.marketTrade(state, team, glut, need).ok) say(state, team, sys, st, C.ROLES.STEWARD, '⚖️ Bartering surplus ' + glut + ' for ' + need + '.', 25);
  }
  // ---- No Marketplace yet but we clearly need one (a tradable good wasting at the cap while another
  //      we rely on runs dry)? Ask the Lord to raise one so we CAN barter the imbalance away. ----
  if ((team.buildings.marketplace || 0) <= 0 && !team.buildQueue.some((q) => q.type === 'marketplace')) {
    const res = team.resources, cap = team.storageCap || 100;
    const glut = ['food', 'wood', 'stone', 'iron', 'horses'].some((k) => (res[k] || 0) >= cap * 0.85);
    const need = ['wood', 'stone', 'iron', 'horses'].some((k) => (res[k] || 0) <= cap * 0.15);
    if (glut && need && req(state, team, sys, st, C.ROLES.STEWARD, C.ROLES.LORD, 'BUILD', { type: 'marketplace' }, 150)) {
      say(state, team, sys, st, C.ROLES.STEWARD, 'Our stores are lopsided — Lord, a Marketplace would let us trade the surplus.', 20);
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
// True when an enemy host is ON or NEXT TO any of our owned outposts (or Keep) — we're being raided and
// shouldn't also be bleeding workers to dangerous labour.
function stewardUnderRaid(state, team) {
  for (const id in state.areas) { const a = state.areas[id];
    if (a.owner !== team.team) continue;
    if (enemyAt(state, team, id)) return true;
    for (const n of a.connections) if (enemyAt(state, team, n)) return true;
  }
  return false;
}
// Scout-target priority: prefer unscouted neutral SITES (expansion), then ground near the enemy / our
// frontier (so our hosts don't fight blind there), then anything adjacent.
function scoutPrio(state, team, a) {
  let s = 1;
  if (a.site && !a.owner) s += 5;                              // an unclaimed site we might expand to
  if (a.owner === team.team && a.claimedBy !== team.team) s += 4; // our ground whose outpost fell — re-take it
  const foe = S.enemyOf(team.team);
  if (a.connections.some((n) => state.areas[n] && state.areas[n].owner === foe)) s += 3; // borders the enemy
  if (enemyAt(state, team, a.id)) s += 2;                      // an enemy host is here — see what we face
  return s;
}
// True if an enemy host sits on, or directly adjacent to, our base or any owned outpost — i.e. a fight is
// imminent on home soil. Used to trigger the Steward's Muster the Levy (a defensive buff for all troops).
function homeUnderThreat(state, team) {
  const home = S.homeBase(team.team);
  const ours = [home];
  for (const id in state.areas) { const a = state.areas[id]; if (a.claimedBy === team.team && a.terrain !== 'base' && a.site) ours.push(id); }
  for (const id of ours) {
    if (enemyAt(state, team, id)) return true;
    const a = state.areas[id]; if (a && a.connections.some((n) => enemyAt(state, team, n))) return true;
  }
  return false;
}
// Find a nearby enemy caravan a host can intercept: aim at the soonest-reachable point on its remaining
// route. Prefers high-value cargo (relics) and skips caravans that out-gun the host.
function caravanIntercept(state, army, team, w, maxReach) {
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
function sitePrio(state, team, persona, a) {
  let base = { mountain: 6, hills: 5, farmland: 4, ruins: 4, forest: 3, plains: 3 }[a.terrain] || 1;
  const short = (k) => (team.resources[k] || 0) < 30;
  if (a.resource && short(a.resource)) base += 3;
  if (persona === 'iron' && (a.terrain === 'mountain' || a.terrain === 'hills')) base += 4;
  if (persona === 'relic' && a.terrain === 'ruins') base += 6;
  if (persona === 'expansionist') base += 1;
  // Smart Hard prizes a WOOD (forest) outpost while wood is the bottleneck — same claim cost as any
  // other site, but it ships home the exact resource that gates the whole economy.
  if (smartHard(team, 'STEWARD') && a.terrain === 'forest' && (team.resources.wood || 0) < 40) base += 6;
  // Prefer CLOSER sites: a nearer outpost ships resources home over a shorter (safer) route and the Commander
  // can defend it far quicker — distant claims get raided before help arrives. (Was the "secured the furthest
  // food site instead of the closest" complaint.) Straight-line distance, scaled so it meaningfully ranks
  // same-resource sites by nearness without entirely overriding a richer/needed resource.
  const _home = state.areas[S.homeBase(team.team)];
  if (_home) base -= Math.hypot((a.x || 0) - _home.x, (a.y || 0) - _home.y) / 300;
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
  // Planned Blacksmith: build a short forge PLAN (what the army needs next), keep the queue stocked a couple
  // deep from it, set the forge focus to whatever the plan makes most of, and only take a contract that
  // ALIGNS with the plan (else wait). One cohesive brain instead of one-off picks.
  if (ab(team, 'bsmithplan')) { aiBlacksmithPlan(state, team, sys, rng, persona, st, { prod, forge, army }); return; }
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
      else if (team.buildings.workshop > 0 && (team.equipment.siegeParts || 0) < 6 && state.phase !== 'EARLY' && rng.chance(persona === 'siege' ? 0.55 : 0.3)) item = 'siegeParts';   // keep ~2 catapults' worth (3 parts each) stocked so the Commander can field catapults for assaults
      else if (persona === 'armorer' && (team.resources.iron || 0) > 20 && rng.chance(0.45)) item = 'armor';
      else if (rng.chance(0.25)) item = 'armor';                                       // some armour for the tier bonus
    }
    // Honour the Steward's "conserve wood": defer wood-costing forges (prefer iron-only Swords/Armour).
    if (sys.economy.conserving(team, 'wood', state.elapsed) && B.RECIPES[item] && (B.RECIPES[item].cost.wood || 0) > 0) {
      item = (team.resources.iron || 0) >= ((B.RECIPES.swords && B.RECIPES.swords.cost.iron) || 99) ? 'swords' : null;
    }
    // Smart Hard never burns the BOTTLENECK wood on gear while wood is scarce — it forges iron-only
    // Swords/Armour (or waits), leaving the wood for the Lord's buildings. This is the single biggest
    // wood-trap leak (tools 8w, spears 6w, bows 10w, arrows 4w, siegeParts 20w all drain wood).
    if (smartHard(team, 'BLACKSMITH') && (team.resources.wood || 0) < 60 && B.RECIPES[item] && (B.RECIPES[item].cost.wood || 0) > 0) {
      if ((team.resources.iron || 0) >= (B.RECIPES.swords.cost.iron || 8)) item = 'swords';
      else if ((team.resources.iron || 0) >= (B.RECIPES.armor.cost.iron || 12)) item = 'armor';
      else item = null;
    }
    if (item && forge(item, 8).ok) st.acted = true;
  }
  if (!st.acted && !team.contract && team.contractCooldown <= 0 && rng.chance(0.5)) { const offers = (team.contractOffers && team.contractOffers.length) ? team.contractOffers : B.CONTRACTS.map((c) => c.id); if (prod.startContract(team, rng.pick(offers)).ok) st.acted = true; }
  if ((team.resources.iron || 0) < 12) { if (req(state, team, sys, st, C.ROLES.BLACKSMITH, C.ROLES.STEWARD, 'IRON', {}, 30)) say(state, team, sys, st, C.ROLES.BLACKSMITH, 'Out of iron — Steward, send more!', 25); }
}
// ---- Planned Blacksmith brain (gated ab('bsmithplan')) ----
const CONTRACT_BY_ID = {}; for (const c of B.CONTRACTS) CONTRACT_BY_ID[c.id] = c;
// Build a weighted forge plan: what the army needs next, biased to iron-only staples when wood is scarce.
// Returns an ordered item list, the per-item weights, and the focus (the item we'll make most of).
function forgePlan(state, team, sys, rng, persona, army) {
  const iron = team.resources.iron || 0;
  const woodScarce = (smartHard(team, 'BLACKSMITH') && (team.resources.wood || 0) < 60) || sys.economy.conserving(team, 'wood', state.elapsed);
  const w = {};
  const bump = (it, n) => { if (it && n > 0) w[it] = (w[it] || 0) + n; };
  if (army.archer > 0 && (team.resources.arrows || 0) < army.archer * 8) bump('arrows', 3);
  if (state.phase === 'EARLY') {
    const toolFloor = persona === 'toolsmith' ? 10 : 5;
    if (team.equipment.tools < toolFloor) bump('tools', 2);
    bump('spears', 3);          // arm a starting force early so we're not defenceless mid-game
    bump('armor', 2);           // start banking the decisive tier bonus
  } else {
    const want = pickComposition(team, { comp: ['swordsman', 'spearman', 'archer', 'cavalry'] }, enemyComposition(state, team), army).desired;
    bump(GEAR_FOR_UNIT[want] || 'spears', 4);   // the gear our desired troops need most
    bump('swords', 1);                          // swords are a reliable iron-only staple
    bump('armor', 3);                           // armour's tier bonus is a big battle edge
    if (army.archer > 0) bump('arrows', 2);
    const siegeWanted = (team.buildings.workshop || 0) > 0 && (state.phase === 'LATE' || (team.equipment.siegeParts || 0) < 2 && state.phase !== 'EARLY');
    if (siegeWanted && (team.equipment.siegeParts || 0) < 6) bump('siegeParts', persona === 'siege' ? 3 : 1);
    if (persona === 'armorer') bump('armor', 2);
  }
  if (woodScarce) {
    for (const it of Object.keys(w)) {
      if (B.RECIPES[it] && (B.RECIPES[it].cost.wood || 0) > 0) {
        const repl = iron >= (B.RECIPES.swords.cost.iron || 8) ? 'swords' : (iron >= (B.RECIPES.armor.cost.iron || 12) ? 'armor' : null);
        const n = w[it]; delete w[it]; bump(repl, n);
      }
    }
  }
  const order = Object.keys(w).sort((a, b) => w[b] - w[a]);
  let focus = null; for (const it of order) { if (B.BLACKSMITH_SPECS[it]) { focus = it; break; } }
  return { order, counts: w, focus };
}
// How well an offered contract fits our plan: every goal item must be something we're already planning to
// make (and forgeable now); score by how heavily we plan it plus the reward, minus a penalty for big/mixed
// orders. 0 means "off-plan — don't take it".
function contractAlignsPlan(team, id, plan) {
  const c = CONTRACT_BY_ID[id]; if (!c) return 0;
  let score = 0, qty = 0;
  for (const item in c.goal) {
    const rc = B.RECIPES[item]; if (!rc) return 0;
    if (rc.needs === 'siege' && (team.buildings.workshop || 0) <= 0) return 0;
    if (!plan.counts[item]) return 0;                 // we are NOT planning this — skip it
    score += plan.counts[item];
    qty += c.goal[item];
  }
  const r = c.reward || {};
  score += (r.relics || 0) * 3 + (r.iron || 0) * 0.06 + (r.wood || 0) * 0.04 + (r.horses || 0) * 0.2 + (r.stone || 0) * 0.03 + (r.food || 0) * 0.02;
  score -= Object.keys(c.goal).length * 0.5;          // single-item orders finish more reliably
  score -= qty * 0.05;                                // smaller quotas are safer
  return score;
}
function aiBlacksmithPlan(state, team, sys, rng, persona, st, ctx) {
  const { prod, forge, army } = ctx;
  const plan = forgePlan(state, team, sys, rng, persona, army);
  // Forge focus: specialise in the item the plan makes the most of (+10% speed on it).
  if (plan.focus && B.BLACKSMITH_SPECS[plan.focus] && team.blacksmithSpec !== plan.focus) team.blacksmithSpec = plan.focus;
  // Keep the forge queue a couple deep, following the plan (one job per distinct item for a balanced spread),
  // so the forge never idles between thinks and the next needed gear is always lined up.
  if (!st.acted && team.production.length < 3) {
    const queued = {}; for (const j of team.production) queued[j.item] = (queued[j.item] || 0) + 1;
    for (const it of plan.order) {
      if (!B.RECIPES[it] || (queued[it] || 0) >= 1) continue;
      if (forge(it, it === 'arrows' ? 24 : 8).ok) { st.acted = true; break; }
    }
  }
  // Contracts: take one that ALIGNS with the plan (finishing it = making what we'd make anyway). If nothing
  // on offer aligns, WAIT for the offers to rotate instead of committing the forge to off-plan busywork.
  if (!team.contract && team.contractCooldown <= 0) {
    const offers = (team.contractOffers && team.contractOffers.length) ? team.contractOffers : [];
    let best = null, bestS = 0;
    for (const id of offers) { const s = contractAlignsPlan(team, id, plan); if (s > bestS) { bestS = s; best = id; } }
    if (best && prod.startContract(team, best).ok) say(state, team, sys, st, C.ROLES.BLACKSMITH, 'Taking a forge contract that fits our plan.', 40);
  }
  // Stuck? The active job can't afford its inputs — ask the Steward for exactly what it needs.
  const job = team.production[0];
  if (job && job.short) {
    const rc = B.RECIPES[job.item] || { cost: {} };
    if ((rc.cost.iron || 0) > (team.resources.iron || 0)) { if (req(state, team, sys, st, C.ROLES.BLACKSMITH, C.ROLES.STEWARD, 'IRON', {}, 30)) say(state, team, sys, st, C.ROLES.BLACKSMITH, 'Forge stalled — Steward, I need iron!', 25); }
    else if ((rc.cost.wood || 0) > (team.resources.wood || 0)) req(state, team, sys, st, C.ROLES.BLACKSMITH, C.ROLES.STEWARD, 'NEED', { resource: 'wood' }, 30);
    else if ((rc.cost.stone || 0) > (team.resources.stone || 0)) req(state, team, sys, st, C.ROLES.BLACKSMITH, C.ROLES.STEWARD, 'NEED', { resource: 'stone' }, 30);
  } else if ((team.resources.iron || 0) < 12) {
    if (req(state, team, sys, st, C.ROLES.BLACKSMITH, C.ROLES.STEWARD, 'IRON', {}, 30)) say(state, team, sys, st, C.ROLES.BLACKSMITH, 'Out of iron — Steward, send more!', 25);
  }
  // Bias the mines toward iron while iron (our forge's lifeblood) is short — the Steward holds the focus.
  if (mfOn(team) && (team.resources.iron || 0) < 30) req(state, team, sys, st, C.ROLES.BLACKSMITH, C.ROLES.STEWARD, 'MINEFOCUS', { res: 'iron' }, 45);
}
function countArmy(team) { const o = { militia: 0, spearman: 0, swordsman: 0, archer: 0, cavalry: 0, catapult: 0 }; for (const g of team.armies) for (const u of C.UNITS) o[u] += g.units[u] || 0; return o; }
function enemyComposition(state, team) { return countArmy(state.teams[S.enemyOf(team.team)]); }
// Smart troop selection: counter the enemy (spears vs cavalry, cavalry vs archers, archers vs slow
// infantry), keep a diverse force, and respect what we can build/afford. Returns the unit we WANT
// (to request gear for) and the best one we can TRAIN right now.
function pickComposition(team, cfg, enemyComp, ownComp, siegeWanted) {
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
    if (u === 'catapult') { s += 0.5;                         // siege utility
      // When a siege is on the table (we have a Workshop and the enemy Keep is walled / it's late game),
      // PRIZE a couple of catapults — they shred walls & buildings far faster than any other unit. A few
      // suffice (they're fragile, so we don't want a one-note siege stack).
      if (siegeWanted && (ownComp.catapult || 0) < 3) s += 6;
    }
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

  // Need recruits? Ask the Lord. Smart Hard won't grow the army while food is tight (now that food
  // demand is higher and famine kills people) — over-levying just starves the realm.
  const foodOkForArmy = !smartHard(team, 'COMMANDER') || team.resources.food >= 40;
  if (p.recruits < 2 && foodOkForArmy) req(state, team, sys, st, C.ROLES.COMMANDER, C.ROLES.LORD, 'RECRUITS', {}, 25);
  // Need trainers running? (Lord assigns them.) Send an ACTIONABLE request so the Lord sees it.
  if (team.buildings.barracks > 0 && p.trainers <= 0 && foodOkForArmy) req(state, team, sys, st, C.ROLES.COMMANDER, C.ROLES.LORD, 'TRAINERS', {}, 30);

  // Prune STALLED training orders: a unit waiting on equipment the Blacksmith can't supply
  // (e.g. swordsman with no swords) parks at progress=1 and clogs the 2-slot queue, so no new
  // (gear-free militia) order can start — the classic "recruits pile up, 0 soldiers" deadlock.
  for (let i = team.training.length - 1; i >= 0; i--) {
    const j = team.training[i];
    if ((j.progress || 0) >= 1 && j.unitType !== 'militia' && !gearAfford(team, j.unitType)) army.cancelTraining(team, j.id);
  }

  // Keep a training order flowing if recruits + trainers available — building a smart, countering mix.
  if (!st.acted && p.recruits >= 1 && p.trainers > 0 && team.training.length < 2) {
    // A siege is "wanted" once we have a Workshop and either it's late game or the enemy Keep is walled —
    // that's when catapults earn their keep (they raze walls 50% faster and buildings far quicker).
    const enemyKeep = state.areas[S.homeBase(S.enemyOf(team.team))];
    const siegeWanted = (team.buildings.workshop || 0) > 0 && (state.phase === 'LATE' || (enemyKeep.buildings.walls || 0) > 0 || (enemyKeep.buildings.watchtower || 0) > 0 && state.phase !== 'EARLY');
    const pick = pickComposition(team, cfg, enemyComposition(state, team), countArmy(team), siegeWanted);
    const homeBar = (state.areas[S.homeBase(team.team)].buildings.barracks || 0) > 0 ? S.homeBase(team.team) : army.barracksAreasOf(state, team)[0];
    if (homeBar && army.trainUnits(state, team, homeBar, pick.trainable, Math.min(4, Math.max(1, Math.round(p.recruits)))).ok) st.acted = true;
    // Ask the Blacksmith/Steward for exactly the gear our wanted troops need.
    requestGearFor(state, team, sys, st, pick.desired);
    if (pick.trainable !== pick.desired) requestGearFor(state, team, sys, st, pick.trainable);
    // If we want catapults but lack the siege parts to train them, nudge the Blacksmith to forge some.
    if (siegeWanted && (countArmy(team).catapult || 0) < 2 && !gearAfford(team, 'catapult')) requestGearFor(state, team, sys, st, 'catapult');
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
      if (h.isGarrison || h.moving || h.harasser || h.swarm || h.postGuard) continue;
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
  // Strength-aware engagement: commit to a fight only with a winning matchup, and pull back when
  // outmatched. Aggressive personas/advantage accept worse odds; cautious ones want a clear edge.
  // Smart AI refuses near-coin-flip-LOSING fights (the "1 soldier charges 3" stupidity): it needs a real
  // edge to attack (≥46%) and retreats from any fight it's likely to lose (<40%) instead of feeding troops in.
  const seng = ab(team, 'smartengage');
  const winBar = Math.max(0.40, Math.min(0.62, 0.52 - aggr * 0.04));   // engage if local win-chance ≥ this
  const retreatBar = Math.max(seng ? 0.32 : 0.26, winBar - 0.16);                     // fall back / consolidate if below this (smart AI won't sit in a clearly-losing fight)
  const holdBar = Math.max(0.58, winBar + 0.10);                       // only KEEP a captured post if we can clearly hold it

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
  // outpostguard: how readily we recall to the Keep follows the LORD'S STANCE — Offensive cares LESS about
  // the Keep (recall only to a bigger doorstep force), Defensive cares MORE (recall sooner), Balanced between.
  const keepCare = (ab(team, 'outpostguard') && mpol) ? (mpol.aggression > 0 ? 1.4 : (mpol.aggression < 0 ? 0.7 : 1.0)) : 1.0;
  const keepThreat = kt.onKeep >= 0.5 || team.keep.hp < team.keep.maxHp * 0.6 || kt.adj >= Math.max(6, homeDef * 1.1) * keepCare;

  let war = team.armies.find((h) => !h.isGarrison && army.unitCount(h) >= 0.5);
  const garStr = army.unitCount(g);
  // Home guard scales with the threat on our doorstep: hold more back when the enemy masses near the
  // Keep (so we don't strip defenders to go harassing), commit nearly everything when the rear is safe.
  let reserve = clampI(3 - aggr + Math.min(7, kt.adj * 0.7), 2, 10);
  // Early-game outpost defence: the Keep has its Watchtower, so we needn't hoard troops there early. When we
  // own outposts and the enemy isn't VASTLY stronger (and isn't on the Keep), keep only a token home reserve
  // and push the rest out to hold our outposts. We only turtle at the Keep early if the foe massively
  // out-armies us AND we hold no outposts.
  const earlyDefend = ab(team, 'earlydefend') && state.phase === 'EARLY';
  if (earlyDefend) {
    const ownPosts = ownedOutpostList(state, team).length;
    const vastlyOutmatched = edge < 0.5;
    // Early game the Keep's Watchtower covers home and threats there are minimal, so keep only a TOKEN reserve
    // (2-3) and push everything else out to defend the vulnerable outposts. Stance tunes it: a Defensive Lord
    // keeps 3 at home, Offensive/Balanced keep 2. (outpostguard)
    if (ownPosts > 0 && !vastlyOutmatched && kt.onKeep < 0.5 && team.keep.hp > team.keep.maxHp * 0.7) {
      reserve = (ab(team, 'outpostguard') && mpol && mpol.aggression < 0) ? 3 : 2;
    }
  }
  // F5 — mid/late forward defence: when an enemy raider is loose IN or NEXT TO our territory and we aren't
  // outmatched, garrison ALL owned outposts (not just frontier ones) so they aren't snatched while the main
  // host is away. Reuses the broad hold-list; only kicks in when a raider is actually detected near us.
  const raiderNear = ab(team, 'midguard') && state.phase !== 'EARLY' && edge >= 0.7 && raiderNearOurLand(state, team);
  const broadGuard = earlyDefend || raiderNear;
  const campaignSize = clampI(7 - aggr, 6, 9);                       // raise only substantial hosts (can break a Keep)
  let maxHosts = clampI(2 + (state.phase === 'LATE' ? 1 : 0), 2, 3); // a strong main host + a raiding party
  // F4 — CONSOLIDATE when behind: if the enemy clearly out-armies us, stop splitting into small hosts that
  // get beaten one at a time; mass everything into a single stack so we fight with weight behind us. (Only
  // when we're not already pressing a near-won assault, which keepThreat/decide handle separately.)
  const behind = ab(team, 'consolidate') && edge < 0.8 && foePow >= 5;
  if (behind) maxHosts = 1;
  // F6 — ANTI-SNOWBALL: when we've been reduced to ~just our Keep, don't roll over. The Watchtower lets the
  // main force turtle home, so we peel ONE small fast raider to snatch UNDEFENDED enemy outposts — chipping
  // the enemy's economy back the way ours was chipped. Allowed even while 'behind' (overrides consolidate),
  // because passively turtling to death is how a reduced team loses; opportunistic raids are the comeback.
  const ownPostCount = ownedOutpostList(state, team).length;
  const desperate = ab(team, 'antisnowball') && state.phase !== 'EARLY' && ownPostCount <= 1 && edge < 0.9;
  if (desperate) maxHosts = Math.max(maxHosts, 2);   // main turtle host + one opportunistic raider
  // swarmharass: when we've been snowballed (desperate) AND the enemy holds a SPRAWLING empire (≥3
  // outposts), don't just turtle to death — fan SEVERAL tiny (1-2 unit) fast raiders out across the enemy's
  // many posts. The pinpricks force their army to run all over chasing us (tiring them — see energy) and
  // snatch undefended posts, buying our main force a window to consolidate and rebuild an outpost.
  const enemyPostCount = countEnemyOutposts(state, enemyTeam);
  const swarm = ab(team, 'swarmharass') && desperate && enemyPostCount >= 3;
  if (swarm) maxHosts = Math.max(maxHosts, clampI(enemyPostCount, 3, 5));
  // When snowballed, sitting our WHOLE garrison at home guarantees a slow loss — the Watchtower covers the
  // Keep, so free the reserve down to a token guard so we can actually PEEL the swarm raiders (otherwise an
  // enemy camped on our doorstep inflates the reserve to the whole garrison and we harass with nothing). Only
  // while the Keep isn't genuinely being stormed (keepThreat still recalls everyone in that case).
  if (swarm && !keepThreat) reserve = Math.min(reserve, defensivePersona ? 3 : 2);
  // When we're no longer being snowballed, retire any swarm raiders back into the normal command ladder.
  if (!swarm) { for (const h of team.armies) if (h.swarm) h.swarm = false; }

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
    const ekDefNow = enemyTeam.armies.reduce((s, h) => s + (army.currentArea(h) === ekArea.id ? army.unitCount(h) : 0), 0);
    const ekWeak = enemyTeam.keep.hp < enemyTeam.keep.maxHp * 0.6;
    // Only COMMIT to the Keep assault when it can actually make progress: it's nearly razed, its Watchtower is
    // already battered, or we out-muscle its defenders. Hurling a weak host at a FULL, well-garrisoned Keep just
    // feeds it to the defenders (the reported "very dumb — keeps attacking Blue's full Keep") — so if we're
    // parked at a Keep we can't crack, DON'T siege; fall through to capturing undefended ground instead.
    const siegeViable = ekBuildings <= 3 || ekWeak || army.unitCount(w) > ekDefNow * 1.1;
    if (((atEnemyKeep && siegeViable) || ekBuildings <= 3) && army.unitCount(w) >= 2) {
      army.command(state, team, w.id, 'siege');
      say(state, team, sys, st, C.ROLES.COMMANDER, ekBuildings <= 1 ? 'Their Keep is all but ours — END THIS!' : 'Press the assault on the enemy Keep!', 16);
      return;
    }
    // Outmatched in the open field (not at home, no near-won siege)? Fall back and CONSOLIDATE with a
    // stronger friendly host (or the Keep) rather than feeding a losing fight piecemeal.
    const myArea = army.currentArea(w);
    if (myArea !== home && winChanceAt(state, army, team, w, myArea) < retreatBar) {
      const dest = consolidateTarget(state, army, team, w);
      if (dest === home) { army.command(state, team, w.id, 'defend'); }
      else { army.command(state, team, w.id, 'garrison', dest); }
      say(state, team, sys, st, C.ROLES.COMMANDER, 'Outmatched — pulling back to regroup.', 16);
      return;
    }
    // STICKY CAPTURE: if we're already standing on an enemy outpost with NO defender, we're mid-capture — HOLD
    // here until the ground flips to us. Seizing an outpost needs unbroken occupation (~10s); wandering off to
    // the next post resets that clock, so the host would raze-and-run forever and never actually TAKE anything
    // (the reported "kept leaving places before capturing them"). A real threat here already triggered the
    // retreat check just above, so holding is safe.
    if (ab(team, 'stickycapture') && !w.moving) {
      const ha = state.areas[myArea];
      if (ha && ha.terrain !== 'base' && ha.owner === S.enemyOf(team.team) && enemyUnitsOn(state, team, myArea) < 0.5) {
        w.postGuard = null; army.command(state, team, w.id, 'garrison', myArea);
        say(state, team, sys, st, C.ROLES.COMMANDER, 'Holding ' + ha.name + ' until it falls to us — take it!', 22);
        return;
      }
    }
    // Contest an owned site the enemy is physically ON (raiding it) — march in and fight them off.
    // One host per site (claimed). Mere adjacency is answered by counter-attacking below, NOT by
    // parking a host at home (that was the bug: a 20-strong host sat idle vs a 2-unit probe).
    if (threats.length) {
      const claim = (decide._threatClaim = decide._threatClaim || {});
      const t = threats.find((x) => x.here && !claim[x.area]);
      if (t) {
        // threatwin: a multi-unit host always contests a raid on our ground (trading/disrupting the raze pays,
        // even at rough odds). But a LONE unit (<2) thrown at a bigger raiding stack just dies one-at-a-time
        // without disrupting much — the reported "sends a guy out one at a time vs a bigger army" bug. So a lone
        // host only commits if it has a real fighting chance; otherwise it holds at the Keep to ACCUMULATE into
        // a proper host, then sallies once it's strong enough to win.
        const canWin = !ab(team, 'threatwin') || army.unitCount(w) >= 2 || winChanceAt(state, army, team, w, t.area) >= retreatBar;
        if (canWin) { claim[t.area] = true; army.command(state, team, w.id, 'garrison', t.area); say(state, team, sys, st, C.ROLES.COMMANDER, 'Driving the enemy off ' + state.areas[t.area].name + '!', 14); return; }
        // Too weak to drive them off alone — fall back to the Keep and mass up instead of dying piecemeal.
        army.command(state, team, w.id, 'defend');
        say(state, team, sys, st, C.ROLES.COMMANDER, 'Not enough to drive them off ' + state.areas[t.area].name + ' yet — massing at the Keep.', 20);
        return;
      }
    }
    // F3 — HUNT loose enemy raiders: an enemy host roaming IN or NEXT TO our territory (e.g. one that just
    // razed an outpost and is moving to the next) that we can BEAT. The Commander watches every enemy host's
    // position & size and sends this host to intercept the nearest winnable one — denying free raids is high
    // value and these are winnable fights. Sits just below "drive them off an owned site".
    if (ab(team, 'huntraiders') && !vulnerable && army.unitCount(w) >= 1.5) {
      const hclaim = (decide._huntClaim = decide._huntClaim || {});
      const tgt = raiderHuntTarget(state, army, team, w, winBar, hclaim);
      if (tgt) { hclaim[tgt] = true; army.command(state, team, w.id, 'garrison', tgt); say(state, team, sys, st, C.ROLES.COMMANDER, 'Enemy raiders near ' + state.areas[tgt].name + ' — run them down!', 14); return; }
    }
    // Counter-attack: an enemy host or enemy-held post sitting next to OUR land — march out and take it
    // if we can win there. Hold it (garrison) when we can also defend it; otherwise hit-and-run.
    if (!vulnerable && army.unitCount(w) >= 2) {
      const claimed = (decide._claimed = decide._claimed || {});
      const ct = counterTarget(state, team, claimed);
      if (ct && winChanceAt(state, army, team, w, ct) >= winBar) {
        claimed[ct] = true;
        if (holdChanceAt(state, army, team, w, ct) >= holdBar && army.unitCount(w) >= 3) {
          w.postGuard = ct; army.command(state, team, w.id, 'garrison', ct); say(state, team, sys, st, C.ROLES.COMMANDER, 'Retaking &amp; holding ' + state.areas[ct].name + '!', 16);
        } else {
          w.postGuard = null; army.command(state, team, w.id, 'raid', ct); say(state, team, sys, st, C.ROLES.COMMANDER, 'Retaking ' + state.areas[ct].name + '!', 16);
        }
        return;
      }
    }
    // Seize an UNDEFENDED enemy outpost even when we are NOT globally dominant: it's a near-free capture
    // that strips the enemy's economy and wins us territory/score. Gated only by a decisive LOCAL win and
    // the Keep being safe (keepThreat already recalls us above) — NOT by the overall force ratio (which
    // was the bug: a strong enemy main army elsewhere made us ignore their wide-open rear outposts).
    if (army.unitCount(w) >= 2) {
      const claimedU = (decide._claimed = decide._claimed || {});
      const freebie = undefendedCaptureTarget(state, army, team, w, claimedU);
      if (freebie) {
        claimedU[freebie] = true;
        const canHold = holdChanceAt(state, army, team, w, freebie) >= holdBar && army.unitCount(w) >= 3;
        w.postGuard = canHold ? freebie : null;
        army.command(state, team, w.id, canHold ? 'garrison' : 'raid', freebie);
        say(state, team, sys, st, C.ROLES.COMMANDER, 'Seizing the undefended ' + state.areas[freebie].name + '!', 16);
        return;
      }
    }
    if (!vulnerable) {
      const cv = team.caravans.find((c) => { const n = c.route[c.legIndex + 1]; return !c.escort && n && sys.sites.areaIsDangerous(state, team, n); });
      if (cv) { army.command(state, team, w.id, 'escort', cv.id); return; }
    }
    // Deny enemy logistics: intercept a reachable enemy caravan — cheap, high-value, especially relics.
    if (!vulnerable) {
      const ic = caravanIntercept(state, army, team, w);
      if (ic) { army.command(state, team, w.id, 'garrison', ic); say(state, team, sys, st, C.ROLES.COMMANDER, 'Hunting an enemy caravan near ' + state.areas[ic].name + '!', 16); return; }
    }
    // Offence — be opportunistic but pick fights we can WIN (local strength comparison). SIEGE the enemy
    // Keep when it's weak/exposed and we out-muscle its defenders; otherwise RAID winnable enemy land.
    const wn = army.unitCount(w);
    const keepWeak = enemyTeam.keep.hp < enemyTeam.keep.maxHp * 0.6;
    const ekDefenders = enemyTeam.armies.reduce((s, h) => s + (army.currentArea(h) === ekArea.id ? army.unitCount(h) : 0), 0);
    const keepExposed = ekDefenders < wn * 0.7;                       // their Keep is lightly held — strike it
    const canRaid = !vulnerable && edge >= (0.85 - aggr * 0.1);
    const canSiege = !vulnerable && edge >= (1.0 - aggr * 0.12);
    const siegeSize = clampI(5 - aggr, 3, 8);
    // Smart siege (your design): assaulting the Keep needs a BIG consolidated force, and is only worth it when
    // we're FAR ahead militarily AND the enemy has no other outposts left to raid (take their land first) — or
    // the Keep is already weak and we're finishing the kill. Leaves the home garrison behind for defence.
    if (ab(team, 'smartsiege')) {
      const enemyOutposts = countEnemyOutposts(state, enemyTeam);
      const consolidated = wn >= Math.max(siegeSize, 6);
      const farAhead = edge >= 1.4;
      const lastTarget = enemyOutposts === 0;     // their Keep is the only land left to take
      const finishing = keepWeak || keepExposed;  // already weak/lightly held — press the kill
      const siegeWorth = !vulnerable && consolidated && winChanceAt(state, army, team, w, ekArea.id) >= winBar
        && (finishing || (farAhead && lastTarget));
      if (siegeWorth) {
        army.command(state, team, w.id, 'siege');
        say(state, team, sys, st, C.ROLES.COMMANDER, finishing ? 'Their Keep is exposed — END THIS!' : 'No enemy land left and we dominate — march on the Keep!', 18);
        req(state, team, sys, st, C.ROLES.COMMANDER, C.ROLES.BLACKSMITH, 'EQUIPMENT', {}, 30);
        return;
      }
      // Not worth sieging yet — fall through to RAID their outposts (handled below).
    } else if (canSiege && wn >= siegeSize && winChanceAt(state, army, team, w, ekArea.id) >= winBar && (state.phase === 'LATE' || keepWeak || keepExposed || edge > 1.25)) {
      army.command(state, team, w.id, 'siege'); say(state, team, sys, st, C.ROLES.COMMANDER, keepExposed ? 'Their Keep lies open — march on it!' : 'The host marches on the enemy Keep!', 18); req(state, team, sys, st, C.ROLES.COMMANDER, C.ROLES.BLACKSMITH, 'EQUIPMENT', {}, 30); return;
    }
    if (canRaid && army.unitCount(w) >= 2) {
      // Opportunistic capture: snap up an enemy/undefended post we can WIN at. If we can also HOLD it,
      // take it and leave this host to garrison (take-and-hold when dominant); otherwise hit-and-run —
      // raze/deny the post and stay mobile (take it, then move on / pull back).
      const claimed2 = (decide._claimed = decide._claimed || {});
      const opp = captureOpportunity(state, army, team, w, winBar, holdBar, claimed2);
      if (opp) {
        claimed2[opp.area] = true;
        if (opp.hold && army.unitCount(w) >= 3) {
          w.postGuard = opp.area; army.command(state, team, w.id, 'garrison', opp.area);
          say(state, team, sys, st, C.ROLES.COMMANDER, 'Taking and holding ' + state.areas[opp.area].name + '!', 16);
        } else {
          w.postGuard = null; army.command(state, team, w.id, 'raid', opp.area);
          say(state, team, sys, st, C.ROLES.COMMANDER, 'Raiding ' + state.areas[opp.area].name + ' — hit and run!', 16);
        }
        return;
      }
    }
    // Nothing winnable to assault right now. A TIRED host (low energy → combat penalty) should fall back to the
    // Keep to RECOVER rather than loiter on draining forward ground; a fresh host holds forward to project power.
    if (ab(team, 'energyrest') && army.hostEnergy(w) < 40 && army.currentArea(w) !== home) {
      army.command(state, team, w.id, 'defend');
      say(state, team, sys, st, C.ROLES.COMMANDER, 'Spent — falling back to the Keep to rest and recover.', 22);
      return;
    }
    // Nothing winnable to assault right now: hold FORWARD ground near the enemy (project power), never idle at home.
    army.command(state, team, w.id, 'garrison', forwardSite(state, team) || bestSiteToHold(state, team) || home);
  };

  // The harasser's single-minded job: deny enemy logistics. Hold the enemy's busiest Keep-side
  // chokepoint so every caravan home must run our gauntlet; only break off to pounce on a caravan that
  // is RIGHT NEXT to us (one leg away) — chasing a moving caravan just loses the race.
  const harass = (w) => {
    if (keepThreat) { army.command(state, team, w.id, 'defend'); return; }
    // Don't throw the outriders away: if a SUPERIOR enemy force is already on us, slip back home rather
    // than trade a lone raider into a doomed fight (the "1 troop charges 5" silliness).
    const myA = army.currentArea(w);
    if (!w.moving && winChanceAt(state, army, team, w, myA) < retreatBar) { army.command(state, team, w.id, 'defend'); return; }
    const choke = enemySupplyPatrol(state, team);
    let tgt = choke;
    const ic = caravanIntercept(state, army, team, w, 1);   // only a caravan within ONE leg is worth diverting for
    if (ic) { tgt = ic; say(state, team, sys, st, C.ROLES.COMMANDER, 'Outriders fall on an enemy caravan at ' + state.areas[ic].name + '!', 22); }
    // Never garrison a chokepoint we'd lose at — pick safer forward ground instead of a death-trap.
    if (tgt && winChanceAt(state, army, team, w, tgt) < retreatBar) tgt = null;
    if (!tgt) tgt = forwardSite(state, team) || home;
    if (army.currentArea(w) !== tgt || w.moving) army.command(state, team, w.id, 'garrison', tgt);
  };

  // A swarm raider: a tiny (1-2 unit) fast host whose job is to ANNOY a sprawling enemy — fan out to a
  // different enemy outpost than its siblings, snatch it if (near-)undefended, and otherwise pick at the
  // least-defended post we won't be annihilated at. The point is to spread the enemy thin and make their
  // army give chase (tiring it), NOT to win a stand-up fight — so it never dives a death-trap, and slips
  // home to rejoin the rebuild when there's nothing safe left to harry.
  const swarmRaid = (w) => {
    if (keepThreat) { w.swarm = false; army.command(state, team, w.id, 'defend'); return; }
    const foe = S.enemyOf(team.team);
    const hereId = army.currentArea(w); const hereA = state.areas[hereId];
    // STICKY CAPTURE: already sitting on an enemy outpost with no defender and a winning position → STAY and
    // finish TAKING it. Don't re-target and reset the ~10s capture clock (the "leaves before capturing" bug).
    if (!w.moving && hereA && hereA.terrain !== 'base' && hereA.owner === foe &&
        ab(team, 'stickycapture') && enemyUnitsOn(state, team, hereId) < 0.5 && winChanceAt(state, army, team, w, hereId) >= retreatBar) {
      army.command(state, team, w.id, 'garrison', hereId);
      say(state, team, sys, st, C.ROLES.COMMANDER, 'Taking ' + hereA.name + ' — hold it until it falls!', 20);
      return;
    }
    const sc = (decide._swarmClaim = decide._swarmClaim || {});
    const tgt = swarmTarget(state, army, team, w, sc);
    if (tgt) {
      sc[tgt] = true;
      // An UNDEFENDED post → GARRISON it (march in and HOLD to capture the ground). A defended-but-weak post →
      // raid it hit-and-run (deny/annoy, keep them chasing). Capturing free enemy ground is the real prize.
      const defended = enemyUnitsOn(state, team, tgt) >= 0.5;
      const takeIt = ab(team, 'stickycapture') && !defended;
      army.command(state, team, w.id, takeIt ? 'garrison' : 'raid', tgt);
      say(state, team, sys, st, C.ROLES.COMMANDER, (takeIt ? 'Seizing ' : 'Harrying ') + state.areas[tgt].name + (takeIt ? ' — take it!' : ' — keep them chasing!'), 18);
      return;
    }
    // Nothing safe to harry — fall back home to rebuild with the main force.
    army.command(state, team, w.id, 'defend');
  };


  // is lost or it becomes badly outmatched there, it stops guarding and falls back to consolidate.
  const guardPost = (w) => {
    const post = w.postGuard;
    if (keepThreat) { w.postGuard = null; army.command(state, team, w.id, 'defend'); return; }
    if (!post || !state.areas[post] || state.areas[post].owner !== team.team) { w.postGuard = null; decide(w); return; }
    if (winChanceAt(state, army, team, w, post) < retreatBar) {
      w.postGuard = null; const dest = consolidateTarget(state, army, team, w);
      if (dest === home) army.command(state, team, w.id, 'defend'); else army.command(state, team, w.id, 'garrison', dest);
      say(state, team, sys, st, C.ROLES.COMMANDER, 'Falling back from ' + state.areas[post].name + ' — outmatched.', 18); return;
    }
    if (army.currentArea(w) !== post || w.moving) army.command(state, team, w.id, 'garrison', post);
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
      // When we're behind (consolidate) we forgo the harasser and keep every soldier in the main stack.
      let har = team.armies.find((h) => h.harasser && army.unitCount(h) >= 0.5);
      if (!har && !behind) {
        if ((army.unitCount(g) - reserve) >= 2 && army.currentArea(g) === home && !g.moving) {
          const r = army.rally(state, team, harasserUnits(g, ab(team, 'catapultguard')), 'Outriders');
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
          else if (h.swarm) swarmRaid(h);
          else if (h.postGuard) guardPost(h);
          else { reinforceHost(h); decide(h); }
        }
      }
      // Relieve owned outposts under active RAID: rush a relief host from the home reserve to drive the
      // enemy off any of OUR posts they're razing where we have a decent chance to win — prioritised ABOVE
      // offence and frontier-garrisoning, and weighted toward posts with the most buildings to save.
      if (!keepThreat) {
        for (const rid of ownedRaidedPosts(state, team)) {
          if (team.armies.some((h) => !h.isGarrison && army.unitCount(h) >= 1 && (areaOf(h) === rid || (h.mission && h.mission.targetArea === rid)))) continue; // already answering
          if (army.currentArea(g) !== home || g.moving || army.unitCount(g) < 3) break;
          if (winChanceAt(state, army, team, g, rid) < retreatBar) continue;   // no decent chance — don't feed troops in
          const keepGuard = clampI(2 + Math.round(kt.adj * 0.5), 2, 6);        // leave a little to hold the Keep
          const take = Math.min(army.unitCount(g) - keepGuard, B.MAX_UNITS_PER_AREA);
          if (take < 2) break;
          const det = army.rally(state, team, allUnits(g, Math.min(0.95, take / army.unitCount(g))), 'Relief');
          if (!det.ok || army.unitCount(det.group) < 0.5) break;
          det.group.postGuard = rid; army.command(state, team, det.group.id, 'garrison', rid);
          say(state, team, sys, st, C.ROLES.COMMANDER, 'Relieving ' + state.areas[rid].name + ' — drive them off!', 14);
        }
      }
      // swarmharass: peel SEVERAL tiny (1-2 unit) fast raiders and fan them across the enemy's sprawling
      // empire (each swarmRaid aims at a DIFFERENT post). Runs before the single-raider/grand-host peels so
      // these count toward maxHosts and the main force stays home to consolidate. Keeps a Keep reserve.
      if (!keepThreat && swarm) {
        let made = 0;
        while (fhs().filter((h) => !h.harasser && !h.postGuard).length < maxHosts &&
               army.currentArea(g) === home && !g.moving && (army.unitCount(g) - reserve) >= 2 &&
               made++ < enemyPostCount) {
          const det = army.rally(state, team, swarmUnits(g), 'Outriders');
          if (!det.ok || army.unitCount(det.group) < 0.5) break;
          det.group.swarm = true;
          swarmRaid(det.group);
          const m = det.group.mission && det.group.mission.type;
          if (!m || m === 'idle' || m === 'defend') { det.group.swarm = false; break; }  // nothing safe to harry — stop
        }
      }
      // Snatch UNDEFENDED enemy outposts: when the enemy leaves posts wide open, peel a small raiding
      // party off the home reserve and go take them NOW — don't wait for a grand host (that passivity is
      // exactly why open enemy posts sat un-taken). Prioritised ABOVE garrisoning our own frontier.
      if (!keepThreat && (!behind || desperate) && hasUndefendedEnemyPost(state, team)) {
        let grabs = 0;
        const grabCap = desperate ? 1 : 2;   // when desperate, peel only ONE small raider — the rest turtles home
        while (fhs().filter((h) => !h.harasser && !h.postGuard).length < maxHosts &&
               army.currentArea(g) === home && !g.moving && (army.unitCount(g) - reserve) >= 3 && grabs++ < grabCap) {
          const det = army.rally(state, team, smallGarrisonUnits(g, clampI(desperate ? 3 : 5 + aggr, desperate ? 2 : 4, desperate ? 4 : 7), ab(team, 'catapultguard')), 'Raiders');
          if (!det.ok || army.unitCount(det.group) < 0.5) break;
          decide(det.group);                                  // routes it to the best undefended capture
          const m = det.group.mission && det.group.mission.type;
          if (!m || m === 'idle' || m === 'defend') { break; } // nothing worth taking — stop peeling troops
        }
      }
      // Keep a small standing garrison on each FRONTIER outpost (owned post bordering the enemy) so it
      // isn't snatched the moment the field army is elsewhere — drawn from spare home strength. In the early
      // game (earlyDefend) we hold ALL owned outposts, not just frontier ones — even building-less ground is
      // worth denying the enemy and is cheap to hold while the Keep's Watchtower covers home.
      let gpGuard = 0;
      // outpostguard: COORDINATE with the Steward — a site they're CLAIMING right now (team._busyJob) is about
      // to become a fresh, building-less, super-vulnerable outpost. Pre-position a defender there before it's
      // even finished so it isn't snatched the instant it's raised. Front it ahead of the standing-garrison list.
      let preDefend = [];
      if (ab(team, 'outpostguard') && team._busyJob && team._busyJob.kind === 'claim' && team._busyJob.areaId && state.areas[team._busyJob.areaId]) preDefend.push(team._busyJob.areaId);
      const postsToHold = preDefend.concat(broadGuard ? ownedOutpostList(state, team) : ownedFrontierPosts(state, team));
      for (const pid of postsToHold) {
        if (team.armies.some((h) => (h.postGuard === pid || (!h.isGarrison && army.currentArea(h) === pid && (!h.moving || (h.mission && h.mission.targetArea === pid)))) && army.unitCount(h) >= 1.5)) continue; // already held / en route
        if (army.currentArea(g) !== home || g.moving || (army.unitCount(g) - reserve) < (broadGuard ? 2 : 3)) break;     // no spare troops
        if (gpGuard++ >= (broadGuard ? 3 : 2)) break;                                                                     // a couple per think (more when defending broadly)
        const det = army.rally(state, team, smallGarrisonUnits(g, clampI(3 + aggr, 2, 4), ab(team, 'catapultguard')), 'Garrison');
        if (det.ok && army.unitCount(det.group) >= 0.5) { det.group.postGuard = pid; army.command(state, team, det.group.id, 'garrison', pid); say(state, team, sys, st, C.ROLES.COMMANDER, 'Garrisoning ' + state.areas[pid].name + '.', 20); }
      }
      // Raise more main raiding parties from the garrison surplus (harasser & post-guards don't count toward the cap).
      let guard = 0;
      while (fhs().filter((h) => !h.harasser && !h.postGuard).length < maxHosts && (army.unitCount(g) - reserve) >= campaignSize && guard++ < 4) {
        const gs = army.unitCount(g);
        const take = Math.min(gs - reserve, B.MAX_UNITS_PER_AREA);
        const r = army.rally(state, team, allUnits(g, Math.min(0.95, take / gs)), fhs().filter((h) => !h.harasser && !h.postGuard).length === 0 ? (state.phase === 'LATE' ? 'Grand Host' : 'War Host') : 'Raiders');
        if (!r.ok || army.unitCount(r.group) < 0.5) break;
        decide(r.group);
      }
    }
    st.acted = true;
  }

  // Apply the Commander's full toolkit: per-persona stance + a context-appropriate formation
  // (defensive hosts hold a Shield Wall; attackers use a Battle Line). Same actions a human uses.
  const smartStance = ab(team, 'smartstance');
  for (const h of team.armies) {
    if (army.unitCount(h) < 0.5) continue;
    const m = h.mission && h.mission.type;
    const defensive = h.isGarrison || defensivePersona || m === 'defend' || m === 'garrison';
    // smartstance (A/B): stance is otherwise FIXED per persona and never adapts. A human reads the fight —
    // press hard (Aggressive: +25% atk / +30% losses) only when winning DECISIVELY so the enemy dies in fewer
    // rounds and we take fewer net hits; hold ground or pull punches (Cautious: −15% atk / −30% losses) when
    // defending or in a coin-flip/losing fight so we bleed less. Otherwise Balanced.
    let stance = cfg.stance;
    if (smartStance) {
      const wc = winChanceAt(state, army, team, h, army.currentArea(h));
      const attacking = m === 'siege' || m === 'raid' || m === 'attack' || m === 'engage';
      if (h.isGarrison || m === 'defend' || m === 'garrison') stance = wc >= 0.75 ? 'balanced' : 'cautious';
      else if (attacking) stance = wc >= 0.72 ? 'aggressive' : (wc < 0.5 ? 'cautious' : 'balanced');
      else stance = cfg.stance;
    }
    army.setStance(team, h.id, stance);
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
  // Weight each host by bodies, armour AND deployment energy — a tired, far-flung army really is weaker, so the
  // strategic posture (edge → vulnerable / behind / desperate) should judge it as such, matching the tactical
  // win-chance maths (which already folds energyMult into strength()).
  for (const g of team.armies) { const n = army.unitCount(g); if (n < 0.5) continue; p += n * (g.hasArmor ? 1.6 : 1) * army.energyMult(g); }
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
// True if any enemy host stands ON or NEXT TO our owned ground — a raider is loose near us (used to switch
// on broad mid-game outpost garrisoning).
function raiderNearOurLand(state, team) {
  const foe = S.enemyOf(team.team);
  for (const g of state.teams[foe].armies) { if (unitCountG(g) < 0.5) continue;
    const a = g.moving ? g.moving.route[g.moving.legIndex] : g.area; const ar = state.areas[a]; if (!ar || ar.terrain === 'base') continue;
    if (ar.owner === team.team) return true;
    if (ar.connections.some((n) => state.areas[n] && state.areas[n].owner === team.team)) return true;
  }
  return false;
}
// F3 — find the nearest WINNABLE enemy raider near our territory for host w to intercept. A "raider near us"
// is an enemy host standing ON our owned ground, or one tile from it, that we can beat at that spot. Prefers
// raiders actually on our land (razing now) and the smaller/closer ones. Skips already-claimed targets.
function raiderHuntTarget(state, army, team, w, winBar, claimed) {
  const foe = S.enemyOf(team.team);
  const enemyAt = {};
  for (const g of state.teams[foe].armies) { const n = unitCountG(g); if (n < 0.5) continue; const a = g.moving ? g.moving.route[g.moving.legIndex] : g.area; enemyAt[a] = (enemyAt[a] || 0) + n; }
  let best = null, bestScore = -1e9;
  for (const aid in enemyAt) {
    if (claimed && claimed[aid]) continue;
    const ar = state.areas[aid]; if (!ar || ar.terrain === 'base') continue;       // their own Keep is a siege, not a hunt
    const onOurLand = ar.owner === team.team;
    const nextToOurLand = ar.connections.some((n) => state.areas[n] && state.areas[n].owner === team.team);
    if (!onOurLand && !nextToOurLand) continue;                                     // only raiders in/at our territory
    if (winChanceAt(state, army, team, w, aid) < winBar) continue;                  // only fights we can win
    const score = (onOurLand ? 50 : 0) - enemyAt[aid] * 3 + (S.buildingsAt(ar) + (ar.site ? ar.site.level : 0));
    if (score > bestScore) { bestScore = score; best = aid; }
  }
  return best;
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
    out.push({ area: id, isKeep: a.terrain === 'base', buildings: S.buildingsAt(a), farms: (a.buildings && a.buildings.farm) || 0, here: here >= 0.5, force: here + adj });
  }
  // Defend the Keep first, then the richest holdings — counting FARMS double (losing a Farm to a raid is a
  // food crisis), so the Commander prioritises saving the buildings that keep the realm fed & equipped.
  const dval = (z) => (z.isKeep ? 1e6 : 0) + z.buildings + z.farms * 2 + (z.here ? 0.5 : 0);
  out.sort((x, y) => dval(y) - dval(x));
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
// ---- Strength-aware engagement helpers (compare host vs enemy strength to decide stay/chase/retreat) ----
function hostStr(army, team, g) { const p = army.hostPower(team, g); return p.atk + p.def; }
function areaOf(h) { return h.moving ? h.moving.route[h.moving.legIndex] : h.area; }
// Enemy strength a host would face at an area: hosts ON it count fully, ADJACENT ones half (they can
// reinforce). Lets the AI judge whether a fight there is winnable.
function enemyStrAt(state, army, team, areaId) {
  const foe = state.teams[S.enemyOf(team.team)]; const ar = state.areas[areaId]; let s = 0;
  for (const h of foe.armies) { if (unitCountG(h) < 0.5) continue; const at = areaOf(h);
    if (at === areaId) s += hostStr(army, foe, h);
    else if (ar && ar.connections.indexOf(at) >= 0) s += hostStr(army, foe, h) * 0.5; }
  return s;
}
function friendStrAt(state, army, team, areaId, exceptId) {
  let s = 0; for (const h of team.armies) { if (h.id === exceptId || unitCountG(h) < 0.5) continue; if (areaOf(h) === areaId) s += hostStr(army, team, h); } return s;
}
// Win probability (share of combined strength) for host w to take/hold areaId. 1 = uncontested.
// If WE haven't scouted the area, our soldiers fight there at the unscouted penalty — fold that into
// the estimate so the AI is wary of attacking blind (and the Steward is nudged to scout ahead).
function scoutFactor(state, team, areaId) { const a = state.areas[areaId]; return (a && a.scouted && a.scouted[team.team]) ? 1 : (1 - B.UNSCOUTED_COMBAT_PENALTY); }
function winChanceAt(state, army, team, w, areaId) {
  const ours = (hostStr(army, team, w) + friendStrAt(state, army, team, areaId, w.id)) * scoutFactor(state, team, areaId);
  const theirs = enemyStrAt(state, army, team, areaId);
  if (theirs <= 0.01) return 1;
  return ours / (ours + theirs);
}
// Stricter "can we HOLD this once taken?" — counts ALL enemy strength on it or one tile away at FULL
// weight (they can converge), so we only commit to keeping posts we can actually defend.
function holdChanceAt(state, army, team, w, areaId) {
  const foe = state.teams[S.enemyOf(team.team)]; const ar = state.areas[areaId];
  const ours = (hostStr(army, team, w) + friendStrAt(state, army, team, areaId, w.id)) * scoutFactor(state, team, areaId);
  let theirs = 0;
  for (const h of foe.armies) { if (unitCountG(h) < 0.5) continue; const at = areaOf(h);
    if (at === areaId || (ar && ar.connections.indexOf(at) >= 0)) theirs += hostStr(army, foe, h); }
  if (theirs <= 0.01) return 1;
  return ours / (ours + theirs);
}
// The juiciest enemy-held (or grabbable neutral) post host w can TAKE right now — and whether we could
// also HOLD it. Lets the AI snap up UNDEFENDED posts: keep the rich/defensible ones (garrison) and
// hit-and-run the rest. Prefers high value, an easy fight, and ground we can hold; skips claimed posts.
function captureOpportunity(state, army, team, w, winBar, holdBar, claimed) {
  const foe = S.enemyOf(team.team); const ekId = S.homeBase(foe);
  let best = null;
  for (const id in state.areas) { const a = state.areas[id];
    if (a.terrain === 'base' || id === ekId) continue;                  // the enemy Keep is a siege, handled apart
    if (a.owner !== foe) continue;                                      // ENEMY-held posts only (neutrals are the Steward's job)
    if (claimed && claimed[id]) continue;
    const take = winChanceAt(state, army, team, w, id);
    if (take < winBar) continue;                                        // can't win the fight there → not an opportunity
    const hold = holdChanceAt(state, army, team, w, id) >= holdBar;
    const value = S.buildingsAt(a) * 3 + 4 + (a.site ? a.site.level + 1 : 0);
    const score = value + take * 5 + (hold ? 4 : 0);
    if (!best || score > best.score) best = { area: id, hold, enemyOwned: true, score, take };
  }
  return best;
}
// Enemy units physically standing on an area (for spotting UNDEFENDED posts).
function enemyUnitsOn(state, team, areaId) {
  const foe = S.enemyOf(team.team); let n = 0;
  for (const h of state.teams[foe].armies) { if (areaOf(h) === areaId) n += unitCountG(h); }
  return n;
}
// An enemy-held outpost that is (near) UNDEFENDED and this host can decisively take — the free-capture
// target the strength-gated branch would skip when our overall army is the weaker one.
function undefendedCaptureTarget(state, army, team, w, claimed) {
  const foe = S.enemyOf(team.team); const ekId = S.homeBase(foe);
  let best = null, bestScore = -1;
  for (const id in state.areas) { const a = state.areas[id];
    if (a.terrain === 'base' || id === ekId) continue;
    if (a.owner !== foe) continue;
    if (claimed && claimed[id]) continue;
    if (enemyUnitsOn(state, team, id) > 1.0) continue;            // only (near-)undefended posts
    if (winChanceAt(state, army, team, w, id) < 0.7) continue;    // must be a near-certain win for us
    const value = S.buildingsAt(a) * 3 + 4 + (a.site ? a.site.level + 1 : 0);
    if (value > bestScore) { bestScore = value; best = id; }
  }
  return best;
}
// Does the enemy hold ANY (near-)undefended outpost worth peeling a small raiding party to go take?
function hasUndefendedEnemyPost(state, team) {
  const foe = S.enemyOf(team.team); const ekId = S.homeBase(foe);
  for (const id in state.areas) { const a = state.areas[id];
    if (a.terrain === 'base' || id === ekId || a.owner !== foe) continue;
    if (enemyUnitsOn(state, team, id) <= 1.0) return true;
  }
  return false;
}
// OUR non-base outposts the enemy is physically ON (actively raiding) and that are worth saving (have
// buildings or a working site). Sorted by building count — the most-built posts are defended first.
function ownedRaidedPosts(state, team) {
  const out = [];
  for (const id in state.areas) { const a = state.areas[id];
    if (a.owner !== team.team || a.terrain === 'base') continue;
    const buildings = S.buildingsAt(a);
    if (buildings <= 0 && !a.site) continue;
    if (enemyUnitsOn(state, team, id) < 0.5) continue;   // enemy actually on it (raiding)
    out.push({ id, buildings });
  }
  out.sort((x, y) => y.buildings - x.buildings);
  return out.map((o) => o.id);
}
// Where a losing host should fall back to: a STRONGER friendly host at/adjacent to it (to combine
// strength), else the Keep. Returns an areaId.
function consolidateTarget(state, army, team, w) {
  const myArea = areaOf(w); const ar = state.areas[myArea]; const home = S.homeBase(team.team);
  let bestArea = home, bestStr = hostStr(army, team, w);
  for (const h of team.armies) { if (h.id === w.id || unitCountG(h) < 0.5) continue; const at = areaOf(h);
    if (at === myArea || (ar && ar.connections.indexOf(at) >= 0)) { const s = hostStr(army, team, h); if (s > bestStr) { bestStr = s; bestArea = at; } } }
  return bestArea;
}
// Owned posts on the FRONTIER (ground we hold — built outpost OR captured — bordering enemy land):
// the posts worth keeping a standing garrison on.
function ownedFrontierPosts(state, team) {
  const foe = S.enemyOf(team.team); const out = [];
  for (const id in state.areas) { const a = state.areas[id];
    if (a.owner !== team.team || a.terrain === 'base') continue;
    if (a.connections.some((n) => state.areas[n] && state.areas[n].owner === foe)) out.push(id);
  }
  return out;
}
// Every owned outpost (non-base), nearest-to-the-enemy first — what to garrison when defending broadly early.
function ownedOutpostList(state, team) {
  const out = [];
  for (const id in state.areas) { const a = state.areas[id]; if (a.owner === team.team && a.terrain !== 'base' && a.site) out.push(id); }
  const ek = S.homeBase(S.enemyOf(team.team));
  out.sort((x, y) => (state.areas[x].connections.indexOf(ek) >= 0 ? -1 : 0) - (state.areas[y].connections.indexOf(ek) >= 0 ? -1 : 0));
  return out;
}
// Count of non-base outposts a (foe) team owns — used to gate sieging: take their LAND before their Keep.
function countEnemyOutposts(state, foeTeam) {
  let n = 0; for (const id in state.areas) { const a = state.areas[id]; if (a.owner === foeTeam.team && a.terrain !== 'base' && a.site) n++; }
  return n;
}
// A small standing garrison drawn from the home reserve — favour spearmen (cheap, hold ground, anti-cav).
function smallGarrisonUnits(g, n, excludeCata) {
  const o = {}; for (const u of C.UNITS) o[u] = 0; let need = n;
  const order = excludeCata ? ['spearman', 'militia', 'archer', 'swordsman', 'cavalry'] : ['spearman', 'militia', 'archer', 'swordsman', 'cavalry', 'catapult'];
  for (const u of order) { if (need <= 0) break; const take = Math.min(Math.floor(g.units[u] || 0), need); if (take > 0) { o[u] = take; need -= take; } }
  return o;
}
// A spread target for a tiny SWARM raider when we're being snowballed: an enemy outpost not already
// claimed by a sibling swarm host. Prefer (near-)undefended posts we can snatch; otherwise the least-
// defended enemy post we won't be annihilated at — the goal is to SPREAD the enemy thin and make their
// army give chase, not to win a stand-up fight. Returns an areaId or null.
function swarmTarget(state, army, team, w, claimed) {
  const foe = S.enemyOf(team.team); const ekId = S.homeBase(foe);
  let best = null, bestScore = -1e9;
  for (const id in state.areas) { const a = state.areas[id];
    if (a.terrain === 'base' || id === ekId || a.owner !== foe) continue;
    if (claimed && claimed[id]) continue;
    const def = enemyUnitsOn(state, team, id);
    const wc = winChanceAt(state, army, team, w, id);
    if (wc < 0.3 && def > 1.5) continue;                      // never dive a death-trap with a 1-2 unit host
    const undef = def <= 1.0 ? 100 : 0;                       // free captures first
    const score = undef + S.buildingsAt(a) * 3 + wc * 20 - def * 4;
    if (score > bestScore) { bestScore = score; best = id; }
  }
  return best;
}
// A tiny (1-2 unit) fast strike body for a swarm raider — cavalry first for speed, then cheap bodies.
function swarmUnits(g) {
  const o = {}; for (const u of C.UNITS) o[u] = 0; let need = 2;
  for (const u of ['cavalry', 'militia', 'archer', 'spearman', 'swordsman']) {
    if (need <= 0) break; const take = Math.min(Math.floor(g.units[u] || 0), need);
    if (take > 0) { o[u] = take; need -= take; }
  }
  return o;
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
// A small, fast strike force for the harasser — favour cavalry, then cheap bodies; ~4 units. Never includes
// catapults (excludeCata): a lone/escortless catapult in a fast raiding party is fragile and ill-defended —
// catapults belong in the big diverse main host.
function harasserUnits(g, excludeCata) {
  const o = {}; for (const u of C.UNITS) o[u] = 0;
  let need = 4;
  const order = excludeCata ? ['cavalry', 'militia', 'archer', 'spearman', 'swordsman'] : ['cavalry', 'militia', 'archer', 'spearman', 'swordsman', 'catapult'];
  for (const u of order) {
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
