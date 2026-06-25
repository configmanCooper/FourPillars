/* Sites & caravans (Steward): explore, claim, upgrade, abandon, caravan logistics. */
'use strict';
const B = require('../../shared/balance.js');
const S = require('../../shared/schema.js');
const C = require('../../shared/constants.js');
const eco = require('./economy.js');

function dist(a, b) { return Math.hypot(a.x - b.x, a.y - b.y); }

function revealedNeighbors(state, team, areaId) {
  return state.areas[areaId].connections;
}

function explore(state, team, areaId) {
  const area = state.areas[areaId];
  if (!area) return { ok: false, reason: 'No such area.' };
  if (area.revealed[team.team]) return { ok: false, reason: 'Already explored.' };
  // Must be adjacent to a revealed area.
  const adjRevealed = area.connections.some((n) => state.areas[n].revealed[team.team]);
  if (!adjRevealed) return { ok: false, reason: 'Too far to explore yet.' };
  if (team._busyJob && team._busyJob.kind === 'explore') return { ok: false, reason: 'Already exploring.' };
  team._busyJob = { kind: 'explore', areaId, remaining: B.EXPLORE_TIME };
  return { ok: true, msg: 'Scouting ' + area.name + '...' };
}

function claim(state, team, areaId) {
  const area = state.areas[areaId];
  if (!area) return { ok: false, reason: 'No such area.' };
  if (!area.revealed[team.team]) return { ok: false, reason: 'Explore it first.' };
  if (!area.site) return { ok: false, reason: 'Nothing to claim here.' };
  if (area.owner && area.owner !== team.team) return { ok: false, reason: 'Enemy-held — take it by force.' };
  if (area.claimedBy === team.team) return { ok: false, reason: 'Already yours.' };
  if (team._busyJob && team._busyJob.kind === 'claim' && team._busyJob.areaId === areaId) return { ok: false, reason: 'Already building here.' };
  // Partial funding: an outpost can be paid for in instalments. A stale fund from the other team is dropped.
  if (area.claimFund && area.claimFund.team !== team.team) area.claimFund = null;
  const need = B.CLAIM_COST.wood;
  let paid = (area.claimFund && area.claimFund.wood) || 0;
  if (paid >= need) {
    // Already fully funded (e.g. while the Steward was busy) — start the build now.
    if (team._busyJob) return { ok: false, reason: 'Finish your current task, then claim to start building.' };
    area.claimFund = null;
    team._busyJob = { kind: 'claim', areaId, remaining: B.CLAIM_TIME };
    return { ok: true, msg: 'Building outpost at ' + area.name + '...' };
  }
  // Hold enforcement happens upstream (applyAction) for the 'claim' action; here we just spend what we have.
  const have = team.resources.wood || 0;
  if (have < 1) return { ok: false, reason: 'No 🪵 wood to put toward the outpost — gather some or ask the council.' };
  const pay = Math.min(have, need - paid);
  eco.spendFor(team, { wood: pay }, 'STEWARD', 'funding outpost at ' + area.name);
  paid += pay;
  if (paid >= need) {
    area.claimFund = null;
    if (!team._busyJob) { team._busyJob = { kind: 'claim', areaId, remaining: B.CLAIM_TIME }; return { ok: true, msg: 'Outpost fully funded (' + need + ' 🪵) — building at ' + area.name + '…' }; }
    return { ok: true, msg: area.name + ' fully funded — finish your current task to start building.' };
  }
  area.claimFund = { team: team.team, wood: paid };
  return { ok: true, msg: 'Put ' + Math.round(pay) + ' 🪵 toward ' + area.name + ' (' + Math.round(paid) + '/' + need + '). Add more wood to finish.' };
}

function upgradeSite(state, team, areaId) {
  const area = state.areas[areaId];
  if (!area || area.claimedBy !== team.team || !area.site) return { ok: false, reason: 'Not your site.' };
  const held = eco.heldCostForRole(team, 'STEWARD', B.SITE_UPGRADE_COST);
  if (held) return { ok: false, reason: held.charAt(0).toUpperCase() + held.slice(1) + ' is reserved by the Lord.' };
  if (!eco.canAfford(team, B.SITE_UPGRADE_COST)) return { ok: false, reason: 'Not enough resources.' };
  eco.spendFor(team, B.SITE_UPGRADE_COST, 'STEWARD', 'upgrading ' + area.name);
  area.site.level += 1;
  return { ok: true, msg: area.name + ' upgraded to level ' + area.site.level + '.' };
}

function abandon(state, team, areaId) {
  const area = state.areas[areaId];
  if (!area || area.claimedBy !== team.team) return { ok: false, reason: 'Not your site.' };
  area.claimedBy = null; area.owner = null; area.site.cargo = 0; area.site.worked = false;
  return { ok: true, msg: 'Abandoned ' + area.name + '.' };
}

function spawnCaravan(state, team, area, log) {
  const home = S.homeBase(team.team);
  const route = S.findPath(state.areas, area.id, home);
  if (!route) return;
  const amt = area.site.cargo;
  const cargo = {}; cargo[area.resource] = amt;
  area.site.cargo = 0;
  const guards = Math.round(area.site.guards || 0);   // the post's stationed guards ride along to protect it
  team.caravans.push({
    id: S.uid('cv'), from: area.id, route, legIndex: 0, t: 0,
    x: area.x, y: area.y, cargo, escort: false, escortGroupId: null,
    resource: area.resource, guards, guardPost: area.id, fleeing: false,
  });
  if (log) log(team.team, 'Caravan of ' + Math.round(amt) + ' ' + area.resource + ' departs ' + area.name + (guards ? ' (🛡 ' + guards + ' guards)' : '') + '.', 'caravan');
}

function areaIsDangerous(state, team, areaId) {
  const area = state.areas[areaId];
  if (area.owner && area.owner !== team.team) return true;
  // Enemy army present?
  const enemy = state.teams[S.enemyOf(team.team)];
  return enemy.armies.some((g) => currentArea(g) === areaId);
}

// Total enemy troops physically standing on an area (what can actually intercept a caravan there).
function enemyTroopsAt(state, team, areaId) {
  const enemy = state.teams[S.enemyOf(team.team)];
  let n = 0;
  for (const g of enemy.armies) { if (currentArea(g) === areaId) { for (const u of C.UNITS) n += g.units[u] || 0; } }
  return n;
}

// Enemy troops that can fall on a caravan entering an area: those ON the area, plus stationary enemy
// hosts one hop away holding the road. Returns the strongest such host so it can be pinned / sent in pursuit.
function enemyTroopsNear(state, team, areaId) {
  const enemy = state.teams[S.enemyOf(team.team)];
  const adj = new Set([areaId].concat(state.areas[areaId].connections));
  let total = 0, bestArea = areaId, best = -1, bestHost = null;
  for (const g of enemy.armies) {
    const ga = currentArea(g);
    if (!adj.has(ga)) continue;
    if (ga !== areaId && g.moving) continue;      // an adjacent threat must be a stationary host holding the road
    let n = 0; for (const u of C.UNITS) n += g.units[u] || 0;
    if (n <= 0) continue;
    total += n;
    if (n > best) { best = n; bestArea = ga; bestHost = g; }
  }
  return { total, area: bestArea, host: bestHost };
}

// Guards skirmish the enemy troops at an area to save a caravan: both sides take losses, the caravan
// lives on. Returns guards lost. Enemy casualties fall on their cheapest units first.
function guardSkirmish(state, team, areaId, guards) {
  const enemyN = enemyTroopsAt(state, team, areaId);
  const gLoss = Math.min(guards, Math.max(1, Math.round(enemyN * B.GUARD_LOSS_PER)));
  let eKill = Math.min(enemyN, Math.max(1, Math.round(guards * B.GUARD_KILL_PER)));
  const enemy = state.teams[S.enemyOf(team.team)];
  for (const u of C.UNITS) {
    if (eKill <= 0) break;
    for (const g of enemy.armies) {
      if (eKill <= 0) break;
      if (currentArea(g) !== areaId) continue;
      const take = Math.min(g.units[u] || 0, eKill);
      if (take > 0) { g.units[u] -= take; eKill -= take; }
    }
  }
  let soldiers = 0; for (const g of enemy.armies) for (const u of C.UNITS) soldiers += g.units[u] || 0;
  enemy.pop.soldiers = Math.round(soldiers);
  return { gLoss, eKill: Math.max(1, Math.round(guards * B.GUARD_KILL_PER)) };
}

// Steward stations guards (from the unassigned pool) at a claimed outpost to protect its caravans.
function setGuards(state, team, areaId, count) {
  const area = state.areas[areaId];
  if (!area || area.claimedBy !== team.team || !area.site) return { ok: false, reason: 'Not your outpost.' };
  count = Math.max(0, Math.floor(count || 0));
  const cur = Math.round(area.site.guards || 0);
  const pool = Math.round(team.guards || 0);
  const delta = count - cur;
  if (delta > 0 && delta > pool) return { ok: false, reason: 'Only ' + pool + ' unassigned guards — ask the Commander to lend more.' };
  area.site.guards = count;
  team.guards = Math.max(0, pool - delta);
  return { ok: true, msg: area.name + ': ' + count + ' guards stationed.' };
}

function currentArea(group) {
  if (group.moving) return group.moving.route[group.moving.legIndex];
  return group.area;
}

function tickSites(state, team, dt, rng, log) {
  // Timed jobs.
  if (team._busyJob) {
    team._busyJob.remaining -= dt;
    if (team._busyJob.remaining <= 0) {
      const job = team._busyJob; const area = state.areas[job.areaId];
      if (job.kind === 'explore') { area.revealed[team.team] = true; if (log) log(team.team, 'Scouted ' + area.name + '.', 'scout'); }
      else if (job.kind === 'claim') { area.claimedBy = team.team; area.owner = team.team; area.site.worked = true; if (log) log(team.team, 'Claimed ' + area.name + '.', 'claim'); }
      team._busyJob = null;
    }
  }

  // Claimed outposts accrue cargo (scaled by their work mode) and dispatch caravans home.
  for (const id in state.areas) {
    const area = state.areas[id];
    if (!area.site || area.claimedBy !== team.team || area.terrain === 'base') continue;
    const y = B.SITE_YIELD[area.terrain];
    if (!y) continue;
    const mode = B.WORK_MODES[area.site.workMode] || B.WORK_MODES.standard;
    const amt = (y[area.resource] || 0) * area.site.level * mode.yield;
    area.site.cargo += amt * dt;
    // PUSH mode at an enemy-contested outpost: rare, capped, pop-floored chance a worker is lost.
    if (mode.lossPerSec > 0 && areaIsDangerous(state, team, id) && rng.chance(mode.lossPerSec * dt)) loseWorker(team, area, log);
    // Dispatch a caravan once cargo reaches this good's threshold AND the min interval has passed.
    // Most goods ship in big loads (60); precious goods like relics ship one at a time.
    const threshold = (B.CARAVAN_DISPATCH_BY_RESOURCE && B.CARAVAN_DISPATCH_BY_RESOURCE[area.resource]) || B.CARAVAN_DISPATCH_CARGO;
    if (area.site.cargo >= threshold && (state.elapsed - (area.site.lastCaravanAt || -999)) >= B.CARAVAN_MIN_INTERVAL) {
      area.site.lastCaravanAt = state.elapsed;
      spawnCaravan(state, team, area, log);
    }
  }
  tickExpedition(state, team, dt, rng, log);

  // Move caravans.
  const foeArmies = state.teams[S.enemyOf(team.team)].armies;
  for (let i = team.caravans.length - 1; i >= 0; i--) {
    const cv = team.caravans[i];
    // Pursuit: a faster enemy host that broke our guards runs the caravan down once it closes the gap.
    if (cv.fleeing) {
      const chaser = foeArmies.find((h) => h.pursue === cv.id);
      if (!chaser) { cv.fleeing = false; }
      else if (Math.hypot(chaser.x - cv.x, chaser.y - cv.y) < B.PURSUIT_CATCH_RADIUS) {
        if (!cv.escort && (cv.guards || 0) < 1) {
          if (log) log(team.team, '💥 Enemy pursuers ran down the fleeing caravan near ' + (state.areas[cv.route[cv.legIndex]] ? state.areas[cv.route[cv.legIndex]].name : '') + ' — cargo lost!', 'ambush');
          chaser.pursue = null; team.caravans.splice(i, 1); continue;
        } else { chaser.pursue = null; cv.fleeing = false; }   // it got re-guarded/escorted and slipped away
      }
    }
    const fromA = state.areas[cv.route[cv.legIndex]];
    const toA = state.areas[cv.route[cv.legIndex + 1]];
    if (!toA) { deliver(state, team, cv, log); team.caravans.splice(i, 1); continue; }
    const legLen = dist(fromA, toA);
    cv.t += (B.CARAVAN_SPEED * dt) / Math.max(1, legLen);
    cv.x = fromA.x + (toA.x - fromA.x) * Math.min(1, cv.t);
    cv.y = fromA.y + (toA.y - fromA.y) * Math.min(1, cv.t);
    if (cv.t >= 1) {
      cv.t = 0; cv.legIndex += 1;
      const enteredId = cv.route[cv.legIndex];
      if (cv.legIndex >= cv.route.length - 1) { deliver(state, team, cv, log); team.caravans.splice(i, 1); continue; }
      // Enemy troops on or beside this leg? Unguarded, unescorted caravans are DESTROYED; guards fight.
      const near = enemyTroopsNear(state, team, enteredId);
      const enemyN = near.total; const hitArea = near.area; const attacker = near.host;
      if (enemyN >= 0.5 && !cv.escort) {
        const here = state.areas[enteredId].name;
        if ((cv.guards || 0) >= 1) {
          const guardsBefore = Math.round(cv.guards);
          const r = guardSkirmish(state, team, hitArea, cv.guards);
          const post = state.areas[cv.guardPost];
          if (post && post.site) post.site.guards = Math.max(0, Math.round((post.site.guards || 0) - r.gLoss));
          cv.guards = Math.max(0, cv.guards - r.gLoss);
          // The attackers STOP to fight the guards (the caravan keeps rolling — guards buy it time).
          if (attacker) attacker.pinnedUntil = state.elapsed + B.GUARD_PIN_SECONDS;
          if (enemyN > guardsBefore) {
            // Guards overrun: they die but the caravan flees with a head start — the (faster) attackers
            // must now give chase and run it down before it reaches home or is re-guarded.
            if (attacker) { attacker.pursue = cv.id; attacker.pursueUntil = state.elapsed + B.GUARD_PIN_SECONDS + B.PURSUIT_TIMEOUT; }
            cv.fleeing = true;
            if (log) log(team.team, '🛡 Guards OVERWHELMED at ' + here + ' (' + Math.round(enemyN) + ' vs ' + guardsBefore + ') — they fall cutting down ' + r.eKill + ', but the caravan flees! Pursuers give chase.', 'ambush');
          } else if (log) {
            log(team.team, '🛡 Guards held the line at ' + here + ' — lost ' + r.gLoss + ' guard' + (r.gLoss === 1 ? '' : 's') + ', cut down ' + r.eKill + ' enemy. The caravan rolls on.', 'ambush');
          }
        } else {
          if (log) log(team.team, '💥 Caravan DESTROYED by enemy at ' + here + ' — it had no guards!', 'ambush');
          team.caravans.splice(i, 1); continue;
        }
      }
    }
  }
}

function deliver(state, team, cv, log) {
  for (const k in cv.cargo) eco.addResource(team, k, cv.cargo[k]);
  if (cv.escortGroupId) freeEscort(team, cv.escortGroupId);
  if (log) log(team.team, 'Caravan delivered ' + Math.round(Object.values(cv.cargo)[0]) + ' ' + Object.keys(cv.cargo)[0] + '.', 'caravan');
}

function freeEscort(team, groupId) {
  const g = team.armies.find((a) => a.id === groupId);
  if (g && g.mission && g.mission.type === 'escort') { g.mission = { type: 'idle' }; }
}

// Steward sets an outpost's work intensity (Cautious / Standard / Push).
function setWorkMode(state, team, areaId, mode) {
  if (!B.WORK_MODES[mode]) return { ok: false, reason: 'Unknown work mode.' };
  const area = state.areas[areaId];
  if (!area || area.claimedBy !== team.team || !area.site) return { ok: false, reason: 'Not your outpost.' };
  area.site.workMode = mode;
  return { ok: true, msg: area.name + ': ' + B.WORK_MODES[mode].name + ' work.' };
}

// Lose one worker (idle first, then the largest pool) — capped by the population floor.
function loseWorker(team, area, log) {
  const p = team.pop;
  if (p.total <= B.POP_FLOOR) return;
  for (const k of ['idle', 'woodcutters', 'miners', 'farmers', 'builders', 'students']) {
    if ((p[k] || 0) >= 1) { p[k] -= 1; eco.recomputeDerived(team); if (log) log(team.team, 'A crew was lost at ' + area.name + ' (working a contested outpost hard).', 'ambush'); return; }
  }
}

// ---- Steward expeditions: commit workers (idle, or preparing if unlocked) for a timed payout. ----
function expeditionEligible(state, team, def) {
  if (def.requires && def.requires.building && (team.buildings[def.requires.building] || 0) <= 0) return false;
  if (def.requires && def.requires.site) {
    const terr = def.requires.site; const ok = (t) => Array.isArray(terr) ? terr.includes(t) : t === terr;
    let has = false; for (const id in state.areas) { const a = state.areas[id]; if (a.claimedBy === team.team && a.site && ok(a.terrain)) { has = true; break; } }
    if (!has) return false;
  }
  return true;
}
// Commit n workers: drain ready idle first, then (if allowed) the preparing/cooling pool.
function commitExpeditionWorkers(team, n, allowCooling) {
  const p = team.pop; let taken = 0;
  const fromIdle = Math.min(p.idle, n); p.idle -= fromIdle; taken += fromIdle;
  if (allowCooling && taken < n && p.cooling) {
    for (let i = p.cooling.length - 1; i >= 0 && taken < n; i--) {
      const b = p.cooling[i]; const t = Math.min(b.n, n - taken); b.n -= t; taken += t;
      if (b.n <= 0) p.cooling.splice(i, 1);
    }
  }
  return taken;
}
function startExpedition(state, team, id) {
  if (team.expedition) return { ok: false, reason: 'An expedition is already underway.' };
  if ((team.expeditionCooldownUntil || 0) > state.elapsed) return { ok: false, reason: 'Expeditions are on cooldown.' };
  const def = B.EXPEDITIONS.find((e) => e.id === id);
  if (!def) return { ok: false, reason: 'Unknown expedition.' };
  if (!expeditionEligible(state, team, def)) return { ok: false, reason: 'Requirements not met.' };
  // The Steward may draw on preparing (re-settling) workers too — unless the Lord has locked worker control.
  const allowCooling = !team.workerLock;
  const available = team.pop.idle + (allowCooling ? eco.coolingCount(team) : 0);
  if (available < def.workers) return { ok: false, reason: 'Needs ' + def.workers + ' free workers (idle' + (allowCooling ? ' or preparing' : '') + ').' };
  commitExpeditionWorkers(team, def.workers, allowCooling); eco.recomputeDerived(team);
  team.expedition = { id, name: def.name, workers: def.workers, endsAt: state.elapsed + def.time, reward: def.reward, risk: def.risk };
  return { ok: true, msg: def.name + ' sets out (' + def.workers + ' workers, ' + def.time + 's).' };
}
function tickExpedition(state, team, dt, rng, log) {
  const ex = team.expedition;
  if (!ex) return;
  if (state.elapsed >= ex.endsAt) {
    for (const k in ex.reward) eco.addResource(team, k, ex.reward[k]);
    let returned = ex.workers;
    if (rng.chance(ex.risk || 0) && (team.pop.total - 1) >= B.POP_FLOOR) returned -= 1; // a crew may not come home
    if (returned > 0) team.pop.idle += returned;
    eco.recomputeDerived(team);
    team.expedition = null;
    team.expeditionCooldownUntil = state.elapsed + B.EXPEDITION_COOLDOWN;
    if (log) log(team.team, ex.name + ' returns! ' + Object.keys(ex.reward).map((k) => '+' + ex.reward[k] + ' ' + k).join(', ') + (returned < ex.workers ? ' (a crew was lost)' : '') + '.', 'caravan');
  }
}

module.exports = { explore, claim, upgradeSite, abandon, tickSites, currentArea, areaIsDangerous, enemyTroopsAt, spawnCaravan, setWorkMode, setGuards, startExpedition, expeditionEligible };
