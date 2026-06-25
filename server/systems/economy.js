/* Economy: worker yields, resources, storage, population, training, phase. */
'use strict';
const C = require('../../shared/constants.js');
const B = require('../../shared/balance.js');

function clamp(v, lo, hi) { return Math.max(lo, Math.min(hi, v)); }

// ---- Individual forged-gear inventory --------------------------------------------------------
// team.gearInv[item] = array of forged item QUALITIES not yet equipped to a soldier/worker. The legacy
// team.equipment[item] COUNT is kept equal to the array length so every existing reader still works.
function addGear(team, item, q) {
  team.gearInv = team.gearInv || {};
  (team.gearInv[item] = team.gearInv[item] || []).push(q || 1);
  team.equipment[item] = team.gearInv[item].length;
}
// Take the highest-quality forged item of a type (returns its quality, or null if none).
function takeBestGear(team, item) {
  team.gearInv = team.gearInv || {};
  const arr = team.gearInv[item];
  if (!arr || !arr.length) {
    if ((team.equipment[item] || 0) >= 1) { team.equipment[item] -= 1; return 1; }  // legacy stock w/o records
    return null;
  }
  let bi = 0; for (let i = 1; i < arr.length; i++) if (arr[i] > arr[bi]) bi = i;
  const q = arr.splice(bi, 1)[0];
  team.equipment[item] = arr.length;
  return q;
}
// Self-heal: keep each gearInv array's length equal to the equipment count (pad Standard, drop worst).
function reconcileGearInv(team) {
  team.gearInv = team.gearInv || {};
  for (const k in team.equipment) {
    if (k === '_tier') continue;
    const cnt = Math.max(0, Math.round(team.equipment[k] || 0));
    const arr = team.gearInv[k] = team.gearInv[k] || [];
    if (arr.length > cnt) { arr.sort((a, b) => a - b); arr.splice(0, arr.length - cnt); }
    while (arr.length < cnt) arr.push(1);
    team.equipment[k] = arr.length;
  }
}

function canAfford(team, cost) {
  for (const k in cost) if ((team.resources[k] || 0) < cost[k]) return false;
  return true;
}
function spend(team, cost) { for (const k in cost) team.resources[k] -= cost[k]; }
function refund(team, cost) { for (const k in cost) team.resources[k] = (team.resources[k] || 0) + cost[k]; }

// Spend AND log who used each resource and what for (for the Lord's per-resource usage log).
function spendFor(team, cost, role, purpose) {
  for (const k in cost) { team.resources[k] -= cost[k]; logSpend(team, k, role, cost[k], purpose); }
}
function logSpend(team, key, role, amount, purpose) {
  if (!amount || amount <= 0) return;
  team.resourceLog = team.resourceLog || {};
  const arr = team.resourceLog[key] = team.resourceLog[key] || [];
  const slot = team.slots && team.slots[role];
  arr.push({ role, name: (slot && slot.name) || role, ai: !slot || slot.controller !== 'human', amount: Math.round(amount * 10) / 10, purpose: purpose || '', t: Math.round(team._elapsed || 0) });
  if (arr.length > 5) arr.shift();
}

function addResource(team, key, amt) {
  team.resources[key] = clamp((team.resources[key] || 0) + amt, 0, team.storageCap);
}

// workforce = people available for jobs (excludes recruits and soldiers). Includes cooling.
function coolingCount(team) { let n = 0; for (const b of (team.pop.cooling || [])) n += b.n; return n; }
function workforce(team) {
  const p = team.pop;
  return p.farmers + p.woodcutters + p.miners + p.builders + p.students + p.trainers + p.idle + coolingCount(team);
}
function maxTrainers(team) { return (team.buildings.barracks || 0) * B.TRAINERS_PER_BARRACKS; }
// Max gatherers a building type supports (4 per Farm / Lumber Camp / Mine).
function maxWorkers(team, job) {
  const per = B.WORKERS_PER_BUILDING;
  if (job === 'farmers') return (team.buildings.farm || 0) * per;
  if (job === 'woodcutters') return (team.buildings.lumberCamp || 0) * per;
  if (job === 'miners') return (team.buildings.mine || 0) * per;
  return Infinity;
}

function recomputeDerived(team) {
  const p = team.pop;
  for (const k of ['farmers', 'woodcutters', 'miners', 'builders', 'students', 'trainers', 'idle', 'recruits', 'soldiers', 'educated']) {
    p[k] = Math.max(0, Math.round(p[k]));
  }
  // Enforce building-based gatherer caps; excess workers fall back to idle (e.g. a Farm was lost).
  for (const job of ['farmers', 'woodcutters', 'miners']) {
    const cap = maxWorkers(team, job);
    if (p[job] > cap) { p.idle += p[job] - cap; p[job] = cap; }
  }
  p.educated = Math.min(p.educated, workforce(team));
  p.total = workforce(team) + p.recruits + p.soldiers;
  team.storageCap = B.STORAGE_BASE + team.buildings.storehouse * B.STORAGE_PER_STOREHOUSE;
  team.housing = B.START_HOUSING + team.buildings.house * B.HOUSING_PER_HOUSE;
}

function policy(team) { return team.policy ? B.POLICIES[team.policy] : null; }

// ---- Steward gathering: tool distribution + mine focus ----
function gatherPoolWorkers(team, pool) {
  if (pool === 'food') return team.pop.farmers;
  if (pool === 'wood') return team.pop.woodcutters;
  if (pool === 'mine') return team.pop.miners;
  return 0;
}
// Normalise team.gather: lazily create it, clamp desired tools to the workers present in each pool,
// then compute `effective` = the integer tools the current stock can actually equip (proportional to
// desired when stock is short). Desired is never silently lowered by stock — only effective is.
function clampGather(team) {
  let g = team.gather;
  if (!g) g = team.gather = { desired: { food: 0, wood: 0, mine: 0 }, effective: { food: 0, wood: 0, mine: 0 }, mineIronFocus: B.DEFAULT_MINE_FOCUS };
  if (!g.desired) g.desired = { food: 0, wood: 0, mine: 0 };
  if (!g.effective) g.effective = { food: 0, wood: 0, mine: 0 };
  if (typeof g.mineIronFocus !== 'number' || !isFinite(g.mineIronFocus)) g.mineIronFocus = B.DEFAULT_MINE_FOCUS;
  g.mineIronFocus = clamp(g.mineIronFocus, 0, 1);
  const want = {};
  for (const p of ['food', 'wood', 'mine']) {
    const d = Math.round(g.desired[p] || 0);
    g.desired[p] = clamp(isFinite(d) ? d : 0, 0, gatherPoolWorkers(team, p));
    want[p] = g.desired[p];
  }
  const stock = Math.floor(team.equipment.tools || 0);
  const sum = want.food + want.wood + want.mine;
  if (sum <= stock) { g.effective = { food: want.food, wood: want.wood, mine: want.mine }; return g; }
  if (sum === 0) { g.effective = { food: 0, wood: 0, mine: 0 }; return g; }
  const scale = stock / sum;
  const alloc = { food: Math.floor(want.food * scale), wood: Math.floor(want.wood * scale), mine: Math.floor(want.mine * scale) };
  let rem = stock - (alloc.food + alloc.wood + alloc.mine);
  const fr = ['food', 'wood', 'mine'].map((p) => ({ p, f: want[p] * scale - Math.floor(want[p] * scale) })).sort((a, b) => b.f - a.f);
  for (let i = 0; i < fr.length && rem > 0; i++) { if (want[fr[i].p] > alloc[fr[i].p]) { alloc[fr[i].p]++; rem--; } }
  g.effective = alloc;
  return g;
}
// Per-second gather rates AND the contributing source breakdown, driven by Lord's workers/buildings
// and the Steward's tool distribution + mine focus. Only TOOLED workers get the quality-scaled boost.
function gatherRates(team) {
  clampGather(team);
  const g = team.gather, p = team.pop;
  const tp = (team.blacksmithSpec && B.BLACKSMITH_SPECS[team.blacksmithSpec] && B.BLACKSMITH_SPECS[team.blacksmithSpec].toolPower) || 1; // Economic Forge makes tools stronger
  // Each tooled worker carries an INDIVIDUAL tool; assign the best tools first across the pools.
  const tools = (team.gearInv && team.gearInv.tools ? team.gearInv.tools.slice() : []).sort((a, b) => b - a);
  let ti = 0, boostSumAll = 0, tooledAll = 0;
  const eff = (workers, tooledCount) => {
    if (workers <= 0) return 0;
    let units = 0, used = 0; const want = Math.min(Math.round(tooledCount), workers);
    for (let i = 0; i < want && ti < tools.length; i++) { const bonus = 1 + B.TOOLS_BONUS * tools[ti] * tp; units += bonus; boostSumAll += bonus; tooledAll++; ti++; used++; }
    return units + (workers - used);   // tooled workers (quality-scaled) + untooled workers (×1)
  };
  const foodBuild = 1 + team.buildings.farm * B.BUILDINGS.farm.effect.foodMult;
  const woodBuild = 1 + team.buildings.lumberCamp * B.BUILDINGS.lumberCamp.effect.woodMult;
  const mineBuild = 1 + team.buildings.mine * B.BUILDINGS.mine.effect.mineMult;
  const food = eff(p.farmers, g.effective.food) * B.WORKER_YIELD.farmer.food * foodBuild;
  const wood = eff(p.woodcutters, g.effective.wood) * B.WORKER_YIELD.woodcutter.wood * woodBuild;
  const focus = g.mineIronFocus;
  const mineUnits = eff(p.miners, g.effective.mine);   // boosted effective miner-units
  const stone = mineUnits * (1 - focus) * B.MINER_STONE_YIELD * mineBuild;
  const iron = mineUnits * focus * B.MINER_IRON_YIELD * mineBuild;
  const boost = tooledAll > 0 ? boostSumAll / tooledAll : (1 + B.TOOLS_BONUS * 1 * tp);  // avg tooled-worker multiplier (display)
  return { food, wood, stone, iron, boost, focus, foodBuild, woodBuild, mineBuild };
}

function tickEconomy(state, team, dt) {
  const p = team.pop;
  team._elapsed = state.elapsed; // timestamp for system-level hold checks (AI paths)
  const pol = policy(team);

  // Gather income — driven by Lord's workers/buildings AND the Steward's tool distribution + mine focus.
  const r = gatherRates(team);
  addResource(team, 'food', r.food * dt);
  addResource(team, 'wood', r.wood * dt);
  addResource(team, 'stone', r.stone * dt);
  addResource(team, 'iron', r.iron * dt);

  // Equipped tools wear with USE (only the tools the Steward committed): ~15 min lifetime each.
  const toolsInUse = team.gather.effective.food + team.gather.effective.wood + team.gather.effective.mine;
  if (toolsInUse > 0 && team.equipment.tools > 0) {
    team.equipment.tools = Math.max(0, team.equipment.tools - (toolsInUse / B.TOOL_LIFETIME_SEC) * dt);
  }

  // Education: each School educates one Student at a time (30s each). With 3 Schools, 3 students
  // graduate concurrently; with 1 School and 8 students, they queue one after another.
  if (team.buildings.school > 0 && p.students > 0) {
    const concurrent = Math.min(p.students, team.buildings.school);
    p.eduProgress = (p.eduProgress || 0) + (concurrent / B.EDU_SECONDS) * dt;
    while (p.eduProgress >= 1 && p.students > 0) {
      p.eduProgress -= 1; p.students -= 1; p.idle += 1; p.educated += 1;
    }
  }
  // Reassignment cooldowns: re-idled workers return to the assignable idle pool when ready.
  if (p.cooling && p.cooling.length) {
    for (let i = p.cooling.length - 1; i >= 0; i--) {
      if (p.cooling[i].until <= state.elapsed) { p.idle += p.cooling[i].n; p.cooling.splice(i, 1); }
    }
  }
  recomputeDerived(team);

  // Food consumption & population growth.
  const foodUse = (pol && pol.foodUse ? pol.foodUse : 1);
  const eat = (p.total * B.FOOD_PER_POP + p.soldiers * B.FOOD_PER_SOLDIER) * foodUse * dt;
  team.resources.food -= eat;
  let starving = false;
  if (team.resources.food < 0) { team.resources.food = 0; starving = true; }

  // Population growth. Accumulate in an unrounded field, then add whole people — otherwise
  // recomputeDerived rounds the fractional growth in `idle` to 0 every tick (it never grew).
  if (!starving && p.total < team.housing) {
    const surplus = clamp(team.resources.food / Math.max(1, p.total * 6), 0, 1);
    const popMult = (pol && pol.popMult) ? pol.popMult : 1;
    p.growthProgress = (p.growthProgress || 0) + B.POP_GROWTH_PER_SEC * surplus * popMult * dt;
    while (p.growthProgress >= 1 && p.total < team.housing) {
      p.growthProgress -= 1; p.idle += 1; recomputeDerived(team);
    }
  } else if (p.total >= team.housing) {
    p.growthProgress = 0; // at cap — don't bank growth
  }
  team._starving = starving;

  computeResourceStats(state, team);
  recomputeDerived(team);
}

// Per-resource generation rate (/sec) and the sources contributing — for the Lord's resource view.
function computeResourceStats(state, team) {
  const p = team.pop;
  const pol = policy(team);
  const g = team.gather;
  const r = gatherRates(team);
  const stats = {};
  for (const k of C.RESOURCES) stats[k] = { rate: 0, sources: [] };
  const add = (k, label, v) => { if (Math.abs(v) < 0.001) return; stats[k].rate += v; stats[k].sources.push({ label, v: +v.toFixed(2) }); };
  const tlab = (pool, workers) => { const t = Math.min(g.effective[pool], workers); return t > 0 ? ' · 🛠️' + t + '/' + workers + ' tooled' : ''; };

  add('food', p.farmers + ' Farmers' + (team.buildings.farm ? ' +' + team.buildings.farm + ' Farm' : '') + tlab('food', p.farmers), r.food);
  add('wood', p.woodcutters + ' Woodcutters' + (team.buildings.lumberCamp ? ' +Lumber' : '') + tlab('wood', p.woodcutters), r.wood);
  add('stone', Math.round(p.miners * (1 - r.focus) * 10) / 10 + ' Miners on stone' + tlab('mine', p.miners), r.stone);
  add('iron', Math.round(p.miners * r.focus * 10) / 10 + ' Miners on iron' + tlab('mine', p.miners), r.iron);
  // Food upkeep.
  const foodUse = (pol && pol.foodUse ? pol.foodUse : 1);
  add('food', 'Upkeep (' + p.total + ' people, ' + p.soldiers + ' soldiers)', -(p.total * B.FOOD_PER_POP + p.soldiers * B.FOOD_PER_SOLDIER) * foodUse);
  // Claimed resource sites (delivered home via caravans).
  if (state && state.areas) {
    for (const id in state.areas) { const a = state.areas[id];
      if (a.claimedBy !== team.team || !a.site || a.terrain === 'base') continue;
      const y = B.SITE_YIELD[a.terrain]; if (!y) continue;
      const amt = (y[a.resource] || 0) * a.site.level;
      add(a.resource, a.name + ' (site, via caravan)', amt);
    }
  }
  team.resourceStats = stats;
}

// Lord reassigns workers (AI batch path). Mirrors adjustWorker exactly so the AI is bound by
// the same friction as a human: every worker pulled OUT of a job enters the reassignment
// cooldown (5s educated / 30s ordinary) before it can be re-assigned; increases draw only from
// the ready idle pool. No instant job->job transfers (that was an AI-only advantage).
function setWorkers(state, team, payload) {
  const p = team.pop;
  const now = state.elapsed;
  const jobs = ['farmers', 'woodcutters', 'miners', 'builders', 'students', 'trainers'];
  const desired = {};
  for (const j of jobs) desired[j] = Math.max(0, Math.floor(payload[j] || 0));
  if (team.buildings.barracks <= 0) desired.trainers = 0;
  else desired.trainers = Math.min(desired.trainers, maxTrainers(team));
  if (team.buildings.school <= 0) desired.students = 0;
  else desired.students = Math.min(desired.students, workforce(team) - p.educated); // only uneducated attend School
  for (const j of ['farmers', 'woodcutters', 'miners']) desired[j] = Math.min(desired[j], maxWorkers(team, j));

  // Reductions -> reassignment cooldown (same as a human clicking "−").
  const eduShare = p.educated / Math.max(1, workforce(team));
  let coolEdu = 0, coolOrd = 0;
  for (const j of jobs) {
    const give = p[j] - desired[j];
    if (give <= 0) continue;
    p[j] -= give;
    const edu = Math.min(p.educated, Math.round(give * eduShare));
    coolEdu += edu; coolOrd += give - edu;
  }
  if (coolEdu > 0) p.cooling.push({ n: coolEdu, until: now + B.COOLDOWN_EDUCATED, edu: true });
  if (coolOrd > 0) p.cooling.push({ n: coolOrd, until: now + B.COOLDOWN_ORDINARY, edu: false });
  // Increases -> draw only from ready idle (cooling workers are NOT yet available).
  for (const j of jobs) {
    let need = desired[j] - p[j]; if (need <= 0) continue;
    const fromIdle = Math.min(need, p.idle); p[j] += fromIdle; p.idle -= fromIdle;
  }
  recomputeDerived(team);
  return { ok: true };
}

// One-way levy: commit workers to the military recruit pool (cannot be reversed). Pulls from
// idle first, then from jobs — but never below a civilian-workforce floor, so no caller
// (AI Lord, granted RECRUITS request, or human) can ever gut the economy.
function levy(team, count) {
  const p = team.pop;
  let need = Math.max(0, Math.floor(count || 0));
  if (need <= 0) return { ok: false, reason: 'Nothing to levy.' };
  let got = Math.min(need, p.idle); p.idle -= got; need -= got;
  const floor = Math.max(6, Math.floor(team.housing * 0.4));
  for (const j of ['woodcutters', 'miners', 'farmers', 'students', 'builders']) {
    if (need <= 0) break;
    const canPull = workforce(team) - floor; if (canPull <= 0) break;
    const take = Math.min(need, Math.max(0, p[j] - (j === 'farmers' ? 1 : 0)), canPull);
    if (take > 0) { p[j] -= take; need -= take; got += take; }
  }
  if (got <= 0) return { ok: false, reason: 'No spare workers to levy (economy protected).' };
  p.recruits += got;
  recomputeDerived(team);
  return { ok: true, msg: 'Levied ' + got + ' recruits.' };
}

function updatePhase(state) {
  const frac = state.elapsed / state.matchLength;
  state.phase = frac >= B.PHASE_BOUNDS.LATE ? C.PHASES.LATE
    : frac >= B.PHASE_BOUNDS.MID ? C.PHASES.MID : C.PHASES.EARLY;
}

// Incremental worker change (live +/- control). +delta pulls from ready idle; -delta sends
// workers straight into the reassignment cooldown ("preparing": 30s, or 5s if educated).
function adjustWorker(state, team, job, delta) {
  const p = team.pop;
  const jobs = ['farmers', 'woodcutters', 'miners', 'builders', 'students', 'trainers'];
  if (!jobs.includes(job)) return { ok: false, reason: 'Unknown job.' };
  delta = Math.sign(delta) * Math.min(20, Math.abs(Math.floor(delta || 0)));
  if (job === 'trainers' && team.buildings.barracks <= 0) return { ok: false, reason: 'Trainers need a Barracks.' };
  if (job === 'students' && team.buildings.school <= 0) return { ok: false, reason: 'Students need a School.' };
  if (delta > 0) {
    if (job === 'trainers' && p.trainers >= maxTrainers(team)) return { ok: false, reason: 'Max Trainers (2 per Barracks).' };
    if (job === 'students' && p.students >= (workforce(team) - p.educated)) return { ok: false, reason: 'Only uneducated workers can attend School.' };
    const cap = maxWorkers(team, job);
    if (p[job] >= cap) return { ok: false, reason: 'Max ' + job + ' reached — build another ' + ({ farmers: 'Farm', woodcutters: 'Lumber Camp', miners: 'Mine' }[job]) + ' (4 per building).' };
    let take = Math.min(delta, p.idle);
    if (job === 'trainers') take = Math.min(take, maxTrainers(team) - p.trainers);
    if (job === 'students') take = Math.min(take, (workforce(team) - p.educated) - p.students);
    if (Number.isFinite(cap)) take = Math.min(take, cap - p[job]);
    if (take <= 0) return { ok: false, reason: job === 'students' ? 'Only uneducated workers can attend School.' : 'No idle workers ready to assign.' };
    p.idle -= take; p[job] += take;
  } else if (delta < 0) {
    const give = Math.min(-delta, p[job]);
    if (give <= 0) return { ok: false, reason: 'None to remove.' };
    p[job] -= give;
    const eduShare = p.educated / Math.max(1, workforce(team));
    const edu = Math.min(p.educated, Math.round(give * eduShare));
    if (edu > 0) p.cooling.push({ n: edu, until: state.elapsed + B.COOLDOWN_EDUCATED, edu: true });
    if (give - edu > 0) p.cooling.push({ n: give - edu, until: state.elapsed + B.COOLDOWN_ORDINARY, edu: false });
  }
  recomputeDerived(team);
  return { ok: true };
}

// ---- Steward gathering actions ----
function setGatherTools(state, team, pool, delta) {
  if (!['food', 'wood', 'mine'].includes(pool)) return { ok: false, reason: 'Unknown work crew.' };
  const d = Number(delta);
  if (!isFinite(d)) return { ok: false, reason: 'Bad amount.' };
  clampGather(team);
  const workers = gatherPoolWorkers(team, pool);
  team.gather.desired[pool] = clamp(Math.round((team.gather.desired[pool] || 0) + d), 0, workers);
  clampGather(team);
  const lab = { food: 'Farmers', wood: 'Woodcutters', mine: 'Miners' }[pool];
  return { ok: true, msg: '🛠️ ' + team.gather.desired[pool] + ' tool-sets assigned to ' + lab + '.' };
}
function setMineFocus(state, team, value) {
  const v = Number(value);
  if (!isFinite(v)) return { ok: false, reason: 'Bad value.' };
  clampGather(team);
  team.gather.mineIronFocus = clamp(v, 0, 1);
  return { ok: true, msg: 'Mine focus: ' + Math.round((1 - team.gather.mineIronFocus) * 100) + '% stone / ' + Math.round(team.gather.mineIronFocus * 100) + '% iron.' };
}
// Soft, advisory conserve flag the Steward sets (a request to the whole council). AI roles honour it
// by deferring NON-essential spending of that resource; humans simply see the broadcast.
function conserving(team, resource, elapsed) {
  const u = team.conserve && team.conserve[resource];
  return typeof u === 'number' && u > elapsed;
}

module.exports = {
  clamp, canAfford, spend, refund, addResource, workforce, recomputeDerived,
  tickEconomy, setWorkers, adjustWorker, levy, maxTrainers, maxWorkers, coolingCount, updatePhase, policy,
  isHeld, heldKeys, isHeldNow, heldCostForRole, heldForRole, blockedFor, roleAllowed, holdAllow, setHold, releaseHold, pruneHolds, spendFor, logSpend,
  grantHold, hasGrant, grantLeft,
  gatherRates, clampGather, gatherPoolWorkers, setGatherTools, setMineFocus, conserving,
  addGear, takeBestGear, reconcileGearInv,
};

// ---------- Lord resource rationing (per-player holds) ----------
// team.holds[key] = { until:number(-1=indefinite), allow:{STEWARD,BLACKSMITH,COMMANDER:bool} }
// A non-Lord role may spend a held resource only if it is in `allow` (the Lord is always allowed),
// or it holds a one-time grant. No hold at all = everyone may spend freely.
function holdRec(team, key, elapsed) {
  let h = team.holds && team.holds[key];
  if (h === undefined || h === null) return null;
  if (typeof h === 'number') h = { until: h, allow: {} }; // tolerate legacy shape
  return (h.until < 0 || h.until > elapsed) ? h : null;
}
function isHeld(state, team, key) { return !!holdRec(team, key, state.elapsed); }
function isHeldNow(team, key) { return !!holdRec(team, key, team._elapsed || 0); }
function roleAllowed(team, key, role, elapsed) {
  if (role === 'LORD') return true;
  const h = holdRec(team, key, elapsed);
  if (!h) return true;
  return !!(h.allow && h.allow[role]);
}
// True if the resource is reserved away from this role (ignoring one-time grants) — for "should I ask".
function heldForRole(team, key, role, elapsed) {
  if (role === 'LORD') return false;
  return !roleAllowed(team, key, role, elapsed);
}
// True if this role is blocked from spending now (reserved AND no active access pass) — for enforcement.
function blockedFor(team, key, role, elapsed) {
  if (role === 'LORD') return false;
  if (roleAllowed(team, key, role, elapsed)) return false;
  return !hasGrant(team, key, role, elapsed);
}
function heldCostForRole(team, role, cost) { for (const k in cost) if (blockedFor(team, k, role, team._elapsed || 0)) return k; return null; }
function heldKeys(state, team) {
  const out = []; if (!team.holds) return out;
  for (const k in team.holds) if (isHeld(state, team, k)) out.push(k);
  return out;
}
// Roles permitted on a held resource (for the Lord's UI / display).
function holdAllow(team, key) { const h = team.holds && team.holds[key]; if (!h || typeof h === 'number') return {}; return h.allow || {}; }
// Access passes are a per-(resource,role) TIME WINDOW: when the Lord approves a USE request, the
// requester may spend that reserved resource freely until the window closes (the reservation stays).
function grantHold(team, key, role, untilElapsed) { team.holdGrants = team.holdGrants || {}; team.holdGrants[key] = team.holdGrants[key] || {}; team.holdGrants[key][role] = Math.max(team.holdGrants[key][role] || 0, untilElapsed); }
function hasGrant(team, key, role, elapsed) { const u = team.holdGrants && team.holdGrants[key] && team.holdGrants[key][role]; return typeof u === 'number' && u > (elapsed != null ? elapsed : (team._elapsed || 0)); }
function grantLeft(team, key, role, elapsed) { const u = team.holdGrants && team.holdGrants[key] && team.holdGrants[key][role]; const e = (elapsed != null ? elapsed : (team._elapsed || 0)); return (typeof u === 'number' && u > e) ? Math.ceil(u - e) : 0; }
function setHold(state, team, key, durationSec, allow) {
  team.holds = team.holds || {};
  const until = (!durationSec || durationSec <= 0) ? -1 : state.elapsed + durationSec;
  const a = {};
  if (Array.isArray(allow)) { for (const r of allow) if (r !== 'LORD') a[r] = true; }
  else if (allow && typeof allow === 'object') { for (const r of ['STEWARD', 'BLACKSMITH', 'COMMANDER']) if (allow[r]) a[r] = true; }
  team.holds[key] = { until, allow: a };
}
function releaseHold(team, key) { if (team.holds) delete team.holds[key]; if (team.holdGrants) delete team.holdGrants[key]; }
function pruneHolds(state, team) {
  if (!team.holds) return;
  for (const k in team.holds) { const h = team.holds[k]; const until = (typeof h === 'number') ? h : (h && h.until); if (until >= 0 && until <= state.elapsed) delete team.holds[k]; }
}
