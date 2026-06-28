/* Economy: worker yields, resources, storage, population, training, phase. */
'use strict';
const C = require('../../shared/constants.js');
const B = require('../../shared/balance.js');

function clamp(v, lo, hi) { return Math.max(lo, Math.min(hi, v)); }

// ---- Research (University) -------------------------------------------------------------------
// team.research[key] = tier owned (0..3). Returns the cumulative effect value for a research STAT
// (matched by B.RESEARCH[*].stat), or 0 if untouched.
function researchTier(team, key) { return (team.research && team.research[key]) || 0; }
function researchStat(team, stat) {
  for (const key in B.RESEARCH) {
    if (B.RESEARCH[key].stat !== stat) continue;
    const t = researchTier(team, key);
    return t > 0 ? B.RESEARCH[key].tiers[t - 1].val : 0;
  }
  return 0;
}
// Max researchers a team can field (4 per University) and whether they have a University at all.
function maxResearchers(team) { return (team.buildings.university || 0) * B.RESEARCHERS_PER_UNIVERSITY; }

// ---- Stewardship: aggregate the additive bonus a stat gets from the standing policy + active actions. ----
// Consumers apply it as `rate *= (1 + stewardStat(team, stat))`. Expired effects contribute nothing
// (they are pruned in tickEconomy, but we also skip them here so a late prune never over-credits).
function stewardStat(team, stat, elapsed) {
  if (elapsed == null) elapsed = (team._elapsed || 0);
  let v = 0;
  const pol = team.stewardPolicy && B.STEWARD_POLICIES[team.stewardPolicy];
  if (pol && pol.effect && pol.effect[stat] != null) v += pol.effect[stat];
  const fx = team.stewardEffects || [];
  for (const e of fx) {
    if (!e || e.until <= elapsed) continue;
    const a = B.STEWARD_ACTIONS_BY_ID[e.id];
    if (a && a.effect && a.effect[stat] != null) v += a.effect[stat];
  }
  return v;
}
// Flat storage bonus from active Emergency Stores effects (not a multiplier).
function stewardStorageFlat(team, elapsed) {
  if (elapsed == null) elapsed = (team._elapsed || 0);
  let v = 0;
  for (const e of (team.stewardEffects || [])) {
    if (!e || e.until <= elapsed) continue;
    const a = B.STEWARD_ACTIONS_BY_ID[e.id];
    if (a && a.effect && a.effect.storage) v += a.effect.storage;
  }
  return v;
}
// Combined gather multiplier (1 + per-resource policy + global gatherAll) for one resource.
function stewardGatherMult(team, res, elapsed) {
  return 1 + stewardStat(team, B.gatherStatKey(res), elapsed) + stewardStat(team, 'gatherAll', elapsed);
}
// Return any committed workers and drop effects whose timer has elapsed.
function pruneStewardEffects(state, team) {
  const fx = team.stewardEffects;
  if (!fx || !fx.length) return;
  let changed = false;
  for (let i = fx.length - 1; i >= 0; i--) {
    if (fx[i].until <= state.elapsed) {
      const w = fx[i].workers || 0;
      if (w > 0) { const back = Math.min(w, team.pop.away || 0); team.pop.away -= back; team.pop.idle += back; }
      fx.splice(i, 1); changed = true;
    }
  }
  if (changed) recomputeDerived(team);
}


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
function refund(team, cost) { for (const k in cost) addResource(team, k, cost[k]); }

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
  return p.farmers + p.woodcutters + p.miners + p.builders + p.students + p.trainers + (p.researchers || 0) + (p.scouts || 0) + p.idle + coolingCount(team);
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
  for (const k of ['farmers', 'woodcutters', 'miners', 'builders', 'students', 'trainers', 'researchers', 'scouts', 'idle', 'recruits', 'soldiers', 'educated']) {
    p[k] = Math.max(0, Math.round(p[k] || 0));
  }
  // Enforce building-based gatherer caps; excess workers fall back to idle (e.g. a Farm was lost).
  for (const job of ['farmers', 'woodcutters', 'miners']) {
    const cap = maxWorkers(team, job);
    if (p[job] > cap) { p.idle += p[job] - cap; p[job] = cap; }
  }
  // Researchers are capped by Universities (4 each) AND can't exceed the educated headcount.
  const rcap = Math.min(maxResearchers(team), p.educated);
  if (p.researchers > rcap) { p.idle += p.researchers - rcap; p.researchers = Math.max(0, rcap); }
  p.educated = Math.min(p.educated, workforce(team));
  p.total = workforce(team) + p.recruits + p.soldiers + (p.away || 0);
  team.storageCap = B.STORAGE_BASE + team.buildings.storehouse * B.STORAGE_PER_STOREHOUSE + researchStat(team, 'storage') + stewardStorageFlat(team);
  team.housing = B.START_HOUSING + team.buildings.house * (B.HOUSING_PER_HOUSE + researchStat(team, 'housing'));
}

function policy(team) { return team.policy ? B.POLICIES[team.policy] : null; }

// Famine death: remove one random person — a civilian worker, a recruit, or a soldier — weighted by how
// many of each the team currently has. A soldier is pulled from a host (its gear record goes too; the
// next reconcile keeps gear/counts consistent). Sets _starveSoldierTick so the sim-audit knows an army
// drop this tick was famine, not a bug.
function starvePerson(state, team, log) {
  const p = team.pop;
  const pools = ['idle', 'farmers', 'woodcutters', 'miners', 'builders', 'students', 'trainers', 'researchers', 'scouts'];
  let workers = 0; for (const k of pools) workers += Math.max(0, Math.round(p[k] || 0));
  const recruits = Math.max(0, Math.round(p.recruits || 0));
  let soldiers = 0; for (const g of team.armies) for (const u of C.UNITS) soldiers += Math.max(0, Math.round(g.units[u] || 0));
  const total = workers + recruits + soldiers;
  if (total < 1) return;
  let pick = Math.floor(Math.random() * total), kind = 'worker';
  if (pick < workers) {
    let acc = 0; for (const k of pools) { acc += Math.max(0, Math.round(p[k] || 0)); if (pick < acc) { p[k] = Math.max(0, Math.round(p[k] || 0) - 1); break; } }
  } else if (pick < workers + recruits) {
    p.recruits = Math.max(0, recruits - 1); kind = 'recruit';
  } else {
    kind = 'soldier';
    let s = pick - workers - recruits;
    let done = false;
    for (const g of team.armies) { if (done) break; for (const u of C.UNITS) { const n = Math.max(0, Math.round(g.units[u] || 0)); if (s < n) { g.units[u] = Math.max(0, (g.units[u] || 0) - 1); if (g.gear && g.gear[u] && g.gear[u].length) g.gear[u].pop(); done = true; break; } s -= n; } }
    let cnt = 0; for (const g of team.armies) for (const u of C.UNITS) cnt += g.units[u] || 0;
    p.soldiers = Math.round(cnt);
    team._starveSoldierTick = state.tick;
  }
  recomputeDerived(team);
  if (log) log(team.team, 'Famine! A ' + kind + ' starved to death.', 'starve');
}

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
  const tp = (team.blacksmithSpec && B.BLACKSMITH_SPECS[team.blacksmithSpec] && B.BLACKSMITH_SPECS[team.blacksmithSpec].toolPower) || 1; // (reserved: per-item specs give a forge-speed bonus, not tool power)
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
  // Research productivity bonuses (Crop Rotation / Logging / Quarrying / Deep-Vein Mining) and the
  // Steward's DANGEROUS-work toggle (+50% output on that pool, paid for in worker lives elsewhere).
  const dw = team.dangerWork || {};
  const foodRes = (1 + researchStat(team, 'food')) * (dw.food ? (1 + B.DANGER_YIELD_BONUS) : 1) * stewardGatherMult(team, 'food');
  const woodRes = (1 + researchStat(team, 'wood')) * (dw.wood ? (1 + B.DANGER_YIELD_BONUS) : 1) * stewardGatherMult(team, 'wood');
  const stoneRes = (1 + researchStat(team, 'stone')) * (dw.mine ? (1 + B.DANGER_YIELD_BONUS) : 1) * stewardGatherMult(team, 'stone');
  const ironRes = (1 + researchStat(team, 'iron')) * (dw.mine ? (1 + B.DANGER_YIELD_BONUS) : 1) * stewardGatherMult(team, 'iron');
  const food = eff(p.farmers, g.effective.food) * B.WORKER_YIELD.farmer.food * foodBuild * foodRes;
  const wood = eff(p.woodcutters, g.effective.wood) * B.WORKER_YIELD.woodcutter.wood * woodBuild * woodRes;
  const focus = g.mineIronFocus;
  const mineUnits = eff(p.miners, g.effective.mine);   // boosted effective miner-units
  const stone = mineUnits * (1 - focus) * B.MINER_STONE_YIELD * mineBuild * stoneRes;
  const iron = mineUnits * focus * B.MINER_IRON_YIELD * mineBuild * ironRes;
  const boost = tooledAll > 0 ? boostSumAll / tooledAll : (1 + B.TOOLS_BONUS * 1 * tp);  // avg tooled-worker multiplier (display)
  return { food, wood, stone, iron, boost, focus, foodBuild, woodBuild, mineBuild };
}

function tickEconomy(state, team, dt, log) {
  const p = team.pop;
  team._elapsed = state.elapsed; // timestamp for system-level hold checks (AI paths)
  const pol = policy(team);

  // Gather income — driven by Lord's workers/buildings AND the Steward's tool distribution + mine focus.
  const r = gatherRates(team);
  addResource(team, 'food', r.food * dt);
  addResource(team, 'wood', r.wood * dt);
  addResource(team, 'stone', r.stone * dt);
  addResource(team, 'iron', r.iron * dt);

  // Equipped tools wear with USE (only the tools the Steward committed): a worn tool eventually breaks
  // and is removed from the armoury. DANGEROUS-work pools chew through tools twice as fast.
  const eff0 = team.gather.effective;
  const dw = team.dangerWork || {};
  const dangerTools = (dw.food ? eff0.food : 0) + (dw.wood ? eff0.wood : 0) + (dw.mine ? eff0.mine : 0);
  const toolsInUse = eff0.food + eff0.wood + eff0.mine + dangerTools * (B.DANGER_TOOL_WEAR_MULT - 1);
  team.gearInv = team.gearInv || {};
  const toolArr = team.gearInv.tools;
  if (toolsInUse > 0 && toolArr && toolArr.length > 0) {
    team._toolWear = (team._toolWear || 0) + (toolsInUse / B.TOOL_LIFETIME_SEC) * dt;
    while (team._toolWear >= 1 && toolArr.length > 0) {
      toolArr.sort((a, b) => a - b); toolArr.shift();   // the most worn tool breaks
      team.equipment.tools = toolArr.length;
      team._toolWear -= 1;
    }
  }

  // Dangerous home labour: each worker in a dangerous pool risks death each second. A tool mitigates it
  // (Standard ≈1%/s, Legendary ≈0.3%/s; untooled = the full base). Never drops below POP_FLOOR.
  tickDangerDeaths(state, team, dt, log);

  // Research: each Researcher at a University yields 1 RP per RESEARCH_INTERVAL seconds (Scholarship speeds it).
  if ((p.researchers || 0) > 0 && (team.buildings.university || 0) > 0) {
    const rate = (p.researchers / B.RESEARCH_INTERVAL) * (1 + researchStat(team, 'research')) * (1 + stewardStat(team, 'researchRate'));
    team.researchProgress = (team.researchProgress || 0) + rate * dt;
    while (team.researchProgress >= 1) { team.researchProgress -= 1; team.researchPoints = (team.researchPoints || 0) + 1; }
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
  // Expire finished Stewardship action effects (returning any workers they tied up).
  pruneStewardEffects(state, team);
  recomputeDerived(team);

  // Food consumption & population growth.
  const foodUse = (pol && pol.foodUse ? pol.foodUse : 1);
  const upkeepMult = Math.max(0.1, 1 + stewardStat(team, 'soldierUpkeep'));
  const foodPerSec = (p.total * B.FOOD_PER_POP + p.soldiers * B.FOOD_PER_SOLDIER * upkeepMult) * foodUse;
  team.resources.food -= foodPerSec * dt;
  if (team.resources.food < 0) team.resources.food = 0;
  // A team is STARVING the moment its larder can't even cover one second of consumption — not only when
  // it hits zero. While starving, population growth halts AND, every STARVE_DEATH_INTERVAL seconds of
  // sustained famine, one random person (worker, recruit, or soldier) dies.
  const starving = foodPerSec > 0 && team.resources.food < foodPerSec;
  if (starving) {
    team._starveAccum = (team._starveAccum || 0) + dt;
    while (team._starveAccum >= B.STARVE_DEATH_INTERVAL) { team._starveAccum -= B.STARVE_DEATH_INTERVAL; starvePerson(state, team, log); }
  } else {
    team._starveAccum = 0;
  }

  // Population growth. Accumulate in an unrounded field, then add whole people — otherwise
  // recomputeDerived rounds the fractional growth in `idle` to 0 every tick (it never grew).
  if (!starving && p.total < team.housing) {
    const surplus = clamp(team.resources.food / Math.max(1, p.total * 6), 0, 1);
    const popMult = ((pol && pol.popMult) ? pol.popMult : 1) * (1 + researchStat(team, 'popGrowth')) * (1 + stewardStat(team, 'popGrowth'));
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
// Dangerous-work toggle per gather pool (food/wood/mine): +50% output, but workers risk death.
function setDangerWork(state, team, pool, on) {
  if (!['food', 'wood', 'mine'].includes(pool)) return { ok: false, reason: 'Unknown work crew.' };
  team.dangerWork = team.dangerWork || { food: false, wood: false, mine: false };
  team.dangerWork[pool] = !!on;
  const lab = { food: 'Farmers', wood: 'Woodcutters', mine: 'Miners' }[pool];
  return { ok: true, msg: lab + (on ? ' now work DANGEROUSLY (+50% output, but risk death).' : ' return to safe work.') };
}
// Each second, roll worker deaths for any dangerous pool. Tool quality mitigates; POP_FLOOR protects.
function tickDangerDeaths(state, team, dt, log) {
  const dw = team.dangerWork; if (!dw) return;
  const p = team.pop;
  const Q = (team.equipQuality && team.equipQuality.tools) || 1;
  const tooledChance = Math.min(B.DANGER_DEATH_BASE, B.DANGER_DEATH_TOOLED / Math.max(0.1, Q));
  const POOLS = [['food', 'farmers'], ['wood', 'woodcutters'], ['mine', 'miners']];
  for (const [pool, jobField] of POOLS) {
    if (!dw[pool]) continue;
    const W = Math.round(p[jobField] || 0); if (W <= 0) continue;
    const E = Math.min(Math.round((team.gather.effective || {})[pool] || 0), W);  // tooled workers in this pool
    const expected = (E * tooledChance + (W - E) * B.DANGER_DEATH_BASE) * dt;
    team._dangerAcc = team._dangerAcc || {};
    team._dangerAcc[pool] = (team._dangerAcc[pool] || 0) + expected;
    while (team._dangerAcc[pool] >= 1) {
      team._dangerAcc[pool] -= 1;
      if (p.total <= B.POP_FLOOR || (p[jobField] || 0) <= 0) { team._dangerAcc[pool] = 0; break; }
      p[jobField] -= 1;
      if (log) log(team.team, '☠️ A ' + ({ farmers: 'farmer', woodcutters: 'woodcutter', miners: 'miner' }[jobField]) + ' died working dangerously.', 'info');
      recomputeDerived(team);
    }
  }
}
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

// ---- Steward scout assignment ----
function setScouts(state, team, delta) {
  const p = team.pop;
  delta = Math.sign(delta) * Math.min(20, Math.abs(Math.floor(delta || 0)));
  if (delta > 0) {
    if (p.scouts >= B.SCOUT_MAX) return { ok: false, reason: 'Max ' + B.SCOUT_MAX + ' scouts.' };
    const take = Math.min(delta, p.idle, B.SCOUT_MAX - p.scouts);
    if (take <= 0) return { ok: false, reason: p.idle <= 0 ? 'No idle workers ready to scout.' : 'Max scouts reached.' };
    p.idle -= take; p.scouts += take;
  } else if (delta < 0) {
    const give = Math.min(-delta, p.scouts);
    if (give <= 0) return { ok: false, reason: 'No scouts to recall.' };
    p.scouts -= give;
    p.cooling.push({ n: give, until: state.elapsed + B.COOLDOWN_ORDINARY, edu: false });
  }
  recomputeDerived(team);
  return { ok: true };
}

// ---- Research actions (Lord) ----
function setResearchers(state, team, delta) {
  const p = team.pop;
  if ((team.buildings.university || 0) <= 0) return { ok: false, reason: 'Build a University first.' };
  delta = Math.sign(delta) * Math.min(20, Math.abs(Math.floor(delta || 0)));
  if (delta > 0) {
    const cap = Math.min(maxResearchers(team), p.educated);
    if (p.researchers >= cap) return { ok: false, reason: p.educated <= p.researchers ? 'Need more EDUCATED workers (assign Students at a School first).' : 'University full (4 researchers each).' };
    const take = Math.min(delta, p.idle, cap - p.researchers);
    if (take <= 0) return { ok: false, reason: p.idle <= 0 ? 'No idle workers ready.' : 'Need educated workers / University capacity.' };
    p.idle -= take; p.researchers += take;
  } else if (delta < 0) {
    const give = Math.min(-delta, p.researchers);
    if (give <= 0) return { ok: false, reason: 'No researchers to remove.' };
    p.researchers -= give;
    p.cooling.push({ n: give, until: state.elapsed + B.COOLDOWN_EDUCATED, edu: true });   // researchers are educated
  }
  recomputeDerived(team);
  return { ok: true };
}
function buyResearch(state, team, key) {
  const def = B.RESEARCH[key];
  if (!def) return { ok: false, reason: 'Unknown research.' };
  if ((team.buildings.university || 0) <= 0) return { ok: false, reason: 'Build a University first.' };
  const cur = researchTier(team, key);
  if (cur >= def.tiers.length) return { ok: false, reason: def.name + ' is fully researched.' };
  const tier = def.tiers[cur];   // the NEXT tier (each requires the previous, enforced by `cur`)
  if ((team.researchPoints || 0) < tier.rp) return { ok: false, reason: 'Need ' + tier.rp + ' Research Points (have ' + Math.floor(team.researchPoints || 0) + ').' };
  if (!canAfford(team, tier.cost)) return { ok: false, reason: 'Not enough resources for ' + def.name + ' Tier ' + (cur + 1) + '.' };
  team.researchPoints -= tier.rp;
  spendFor(team, tier.cost, 'LORD', 'researching ' + def.name + ' T' + (cur + 1));
  team.research = team.research || {};
  team.research[key] = cur + 1;
  recomputeDerived(team);
  return { ok: true, msg: def.name + ' Tier ' + (cur + 1) + ' researched!' };
}

module.exports = {
  clamp, canAfford, spend, refund, addResource, workforce, recomputeDerived,
  tickEconomy, setWorkers, adjustWorker, levy, maxTrainers, maxWorkers, coolingCount, updatePhase, policy,
  isHeld, heldKeys, isHeldNow, heldCostForRole, heldForRole, blockedFor, roleAllowed, holdAllow, setHold, releaseHold, pruneHolds, spendFor, logSpend,
  grantHold, hasGrant, grantLeft,
  gatherRates, clampGather, gatherPoolWorkers, setGatherTools, setMineFocus, conserving,
  setDangerWork, setResearchers, buyResearch, maxResearchers, researchStat, researchTier, setScouts,
  stewardStat, stewardStorageFlat, stewardGatherMult, pruneStewardEffects,
  doStewardAction, setStewardPolicy, marketTrade, supervise,
  addGear, takeBestGear, reconcileGearInv,
};

// ---------- Stewardship: actions / standing policy / market barter / supervise minigame ----------
function doStewardAction(state, team, id) {
  const a = B.STEWARD_ACTIONS_BY_ID[id];
  if (!a) return { ok: false, reason: 'Unknown stewardship action.' };
  const e = state.elapsed;
  if ((team.stewardActionCooldownUntil || 0) > e) return { ok: false, reason: 'The council just acted — wait ' + Math.ceil(team.stewardActionCooldownUntil - e) + 's before another action.' };
  if (((team.stewardActionCD && team.stewardActionCD[id]) || 0) > e) return { ok: false, reason: a.name + ' is on cooldown (' + Math.ceil(team.stewardActionCD[id] - e) + 's).' };
  const heldKey = heldCostForRole(team, 'STEWARD', a.cost);
  if (heldKey) return { ok: false, reason: 'The Lord has reserved ' + heldKey + '.' };
  if (!canAfford(team, a.cost)) return { ok: false, reason: 'Not enough resources for ' + a.name + '.' };
  const workers = a.workers || 0;
  if (workers > 0 && team.pop.idle < workers) return { ok: false, reason: a.name + ' needs ' + workers + ' idle workers (have ' + team.pop.idle + ').' };
  spendFor(team, a.cost, 'STEWARD', a.name);
  if (a.instant) {
    for (const k in a.instant) {
      if (k === 'rp') team.researchPoints = (team.researchPoints || 0) + a.instant.rp;
      else addResource(team, k, a.instant[k]);
    }
  }
  if (workers > 0) { team.pop.idle -= workers; team.pop.away = (team.pop.away || 0) + workers; recomputeDerived(team); }
  if (workers > 0 || (a.effect && a.durationSec > 0)) {
    team.stewardEffects = team.stewardEffects || [];
    team.stewardEffects.push({ id: a.id, until: e + (a.durationSec || 0), workers });
  }
  team.stewardActionCooldownUntil = e + B.STEWARD_ACTION_GLOBAL_CD;
  team.stewardActionCD = team.stewardActionCD || {};
  team.stewardActionCD[id] = e + a.cooldownSec;
  return { ok: true, msg: a.glyph + ' ' + a.name + (a.durationSec > 0 ? ' enacted (' + a.durationSec + 's).' : ' done.') };
}

function setStewardPolicy(state, team, key) {
  if (key != null && !B.STEWARD_POLICIES[key]) return { ok: false, reason: 'Unknown policy.' };
  const e = state.elapsed;
  if (team.stewardPolicy === (key || null)) return { ok: false, reason: 'That policy is already in force.' };
  if ((team.stewardPolicyCooldownUntil || 0) > e) return { ok: false, reason: 'Policy was just changed — wait ' + Math.ceil(team.stewardPolicyCooldownUntil - e) + 's.' };
  team.stewardPolicy = key || null;
  team.stewardPolicyCooldownUntil = e + B.STEWARD_POLICY_CD;
  const p = key ? B.STEWARD_POLICIES[key] : null;
  return { ok: true, msg: p ? (p.glyph + ' Policy: ' + p.name + ' — ' + p.desc) : 'Stewardship policy cleared.' };
}

function marketTrade(state, team, from, to) {
  if ((team.buildings.marketplace || 0) <= 0) return { ok: false, reason: 'Build a Marketplace first (ask the Lord).' };
  if (!B.MARKET_TRADE_RESOURCES.includes(from) || !B.MARKET_TRADE_RESOURCES.includes(to)) return { ok: false, reason: 'You can only barter common goods.' };
  if (from === to) return { ok: false, reason: 'Pick two different goods.' };
  const e = state.elapsed;
  if ((team.marketTradeUntil || 0) > e) return { ok: false, reason: 'The market is resting — ' + Math.ceil(team.marketTradeUntil - e) + 's.' };
  if (heldCostForRole(team, 'STEWARD', { [from]: B.MARKET_TRADE_IN })) return { ok: false, reason: 'The Lord has reserved ' + from + '.' };
  if ((team.resources[from] || 0) < B.MARKET_TRADE_IN) return { ok: false, reason: 'Need ' + B.MARKET_TRADE_IN + ' ' + from + ' to trade.' };
  const out = team.stewardPolicy === 'pol_trade' ? B.MARKET_TRADE_OUT_POLICY : B.MARKET_TRADE_OUT;
  spendFor(team, { [from]: B.MARKET_TRADE_IN }, 'STEWARD', 'market trade');
  addResource(team, to, out);
  team.marketTradeUntil = e + B.MARKET_TRADE_COOLDOWN;
  return { ok: true, msg: '⚖️ Traded ' + B.MARKET_TRADE_IN + ' ' + from + ' → ' + out + ' ' + to + '.' };
}

// Human-only supervise minigame. The token's grid position is kept SERVER-SIDE secret (stripped from
// snapshots) so the client can't read it; only the per-click {hit/revealed} result is returned.
function supervise(state, team, resource, index) {
  if (!B.SUPERVISE_RESOURCES.includes(resource)) return { ok: false, reason: 'Cannot supervise that.' };
  const G = B.SUPERVISE_GRID, N = G * G;
  const now = Date.now();
  if (team._superviseWallAt && now - team._superviseWallAt < B.SUPERVISE_MIN_INTERVAL_MS) return { ok: false, reason: 'Slow down.' };
  team._superviseWallAt = now;
  let job = team.superviseJob;
  if (!job || job.resource !== resource) job = team.superviseJob = { resource, pos: Math.floor(Math.random() * N) };
  const idx = Math.floor(Number(index));
  if (!(idx >= 0 && idx < N)) return { ok: false, reason: 'Bad cell.' };
  if (idx === job.pos) {
    const w = team._superviseWindow && (now - team._superviseWindow.start) < B.SUPERVISE_WINDOW_MS ? team._superviseWindow : (team._superviseWindow = { start: now, count: 0 });
    job.pos = Math.floor(Math.random() * N);          // re-hide regardless of cap
    if (w.count >= B.SUPERVISE_MAX_PER_WINDOW) return { ok: true, data: { hit: true, resource: resource, reward: 0, capped: true } };
    w.count++;
    addResource(team, resource, B.SUPERVISE_REWARD);
    return { ok: true, data: { hit: true, resource: resource, reward: B.SUPERVISE_REWARD } };
  }
  const was = job.pos, r = Math.floor(was / G), c = was % G, dirs = [];
  for (let dr = -1; dr <= 1; dr++) for (let dc = -1; dc <= 1; dc++) {
    if (dr === 0 && dc === 0) continue;
    const nr = r + dr, nc = c + dc;
    if (nr >= 0 && nr < G && nc >= 0 && nc < G) dirs.push(nr * G + nc);
  }
  job.pos = dirs.length ? dirs[Math.floor(Math.random() * dirs.length)] : was;
  return { ok: true, data: { hit: false, resource: resource, revealed: was } };
}

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
function setHold(state, team, key, durationSec, allow, owner) {
  team.holds = team.holds || {};
  const until = (!durationSec || durationSec <= 0) ? -1 : state.elapsed + durationSec;
  const a = {};
  if (Array.isArray(allow)) { for (const r of allow) if (r !== 'LORD') a[r] = true; }
  else if (allow && typeof allow === 'object') { for (const r of ['STEWARD', 'BLACKSMITH', 'COMMANDER']) if (allow[r]) a[r] = true; }
  // owner = the role that may release it (besides the Lord). RESERVE requests set this to the requester;
  // the Lord's own reservations default to LORD. Preserve an existing owner if the caller passes none.
  const prevOwner = (team.holds[key] && typeof team.holds[key] === 'object') ? team.holds[key].owner : null;
  team.holds[key] = { until, allow: a, owner: owner || prevOwner || 'LORD' };
}
function releaseHold(team, key) { if (team.holds) delete team.holds[key]; if (team.holdGrants) delete team.holdGrants[key]; }
function pruneHolds(state, team) {
  if (!team.holds) return;
  for (const k in team.holds) { const h = team.holds[k]; const until = (typeof h === 'number') ? h : (h && h.until); if (until >= 0 && until <= state.elapsed) delete team.holds[k]; }
}
