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

function isScouted(area, teamName) { return !!(area.scouted && area.scouted[teamName]); }

// Order the Steward's scouts onto a target area. Scouts advance it over time (speed scales with their
// number); when done the area is revealed & scouted. Re-scouting a lapsed (foggy) area is allowed.
function explore(state, team, areaId) {
  const area = state.areas[areaId];
  if (!area) return { ok: false, reason: 'No such area.' };
  if (isScouted(area, team.team)) return { ok: false, reason: 'Already scouted.' };
  // Must be adjacent to ground we currently scout/own (or be a known area that lapsed into fog).
  const adj = area.connections.some((n) => state.areas[n].scouted[team.team] || state.areas[n].owner === team.team);
  if (!adj && !area.revealed[team.team]) return { ok: false, reason: 'Too far to scout yet.' };
  if (team.scoutJob && team.scoutJob.areaId === areaId) return { ok: false, reason: 'Already scouting there.' };
  if ((team.pop.scouts || 0) <= 0) return { ok: false, reason: 'Assign Scouts first (Labor screen).' };
  team.scoutJob = { areaId, progress: 0 };
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
  // Enforce the Lord's rationing HERE too (not only upstream in applyAction): the AI Steward calls
  // claim() directly, so without this check it would fund outposts with wood the Lord reserved away
  // from the Steward (e.g. reserved for the Blacksmith). A one-time access grant lifts the block.
  const held = eco.heldCostForRole(team, 'STEWARD', B.CLAIM_COST);
  if (held) return { ok: false, reason: (C.RESOURCE_META[held] ? C.RESOURCE_META[held].name : held) + ' is reserved by the Lord — ask to access it.' };
  const have = team.resources.wood || 0;
  // Minimum commitment: the Steward must put at least CLAIM_MIN_INSTALMENT wood toward an outpost at a
  // time (or the remainder, if less than that is left to pay) — no dribbling 1 wood at a time.
  const remaining = need - paid;
  const minPay = Math.min(B.CLAIM_MIN_INSTALMENT, remaining);
  if (have < minPay) return { ok: false, reason: 'You must commit at least ' + minPay + ' 🪵 wood toward the outpost — gather more first.' };
  const pay = Math.min(have, remaining);
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
  area.maxBuildings = (area.maxBuildings || B.BUILD_SLOTS_SITE) + 1;   // each upgrade grants +1 build slot
  S.recomputeBuildings(state, team);
  return { ok: true, msg: area.name + ' upgraded to level ' + area.site.level + ' (+1 build slot).' };
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
  const mode = B.CARAVAN_MODES[area.site.caravanMode] || B.CARAVAN_MODES.standard;
  team.caravans.push({
    id: S.uid('cv'), from: area.id, route, legIndex: 0, t: 0,
    x: area.x, y: area.y, cargo, escort: false, escortGroupId: null,
    resource: area.resource, guards, guardPost: area.id, fleeing: false,
    speedMult: mode.speedMult || 1,   // Push caravans roll at half speed
    sneak: mode.sneak || 0,           // Cautious caravans may slip past enemy troops
    mode: area.site.caravanMode || 'standard',
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
  const army = require('./army.js');
  const enemyN = enemyTroopsAt(state, team, areaId);
  const gLoss = Math.min(guards, Math.max(1, Math.round(enemyN * B.GUARD_LOSS_PER)));
  let eKill = Math.min(enemyN, Math.max(1, Math.round(guards * B.GUARD_KILL_PER * (1 + eco.stewardStat(team, 'guardStrength', state.elapsed)))));
  const totalKill = eKill;
  const enemy = state.teams[S.enemyOf(team.team)];
  for (const u of C.UNITS) {
    if (eKill <= 0) break;
    for (const g of enemy.armies) {
      if (eKill <= 0) break;
      if (currentArea(g) !== areaId) continue;
      const take = Math.min(Math.round(g.units[u] || 0), eKill);
      for (let k = 0; k < take; k++) army.removeSoldier(g, u);   // remove the soldier AND their gear record (stay consistent)
      eKill -= take;
    }
  }
  let soldiers = 0; for (const g of enemy.armies) for (const u of C.UNITS) soldiers += g.units[u] || 0;
  enemy.pop.soldiers = Math.round(soldiers);
  // Tell the VICTIM why their soldiers fell — otherwise troops seem to "die for no reason" on the road.
  const killed = totalKill - Math.max(0, eKill);
  if (killed > 0) army.logMil(enemy, '⚔️ ' + killed + ' of our soldiers fell ambushing an enemy caravan\'s guards at ' + (state.areas[areaId] ? state.areas[areaId].name : 'the road') + '.', 'combat');
  return { gLoss, eKill: killed };
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
  refreshExpeditionOffers(team);
  // Timed jobs (claiming an outpost).
  if (team._busyJob) {
    team._busyJob.remaining -= dt;
    if (team._busyJob.remaining <= 0) {
      const job = team._busyJob; const area = state.areas[job.areaId];
      if (job.kind === 'claim') { area.claimedBy = team.team; area.owner = team.team; area.site.worked = true; if (!area.site.workMode) area.site.workMode = 'standard'; area.revealed[team.team] = true; area.scouted[team.team] = true; area.scoutedUntil[team.team] = state.elapsed + B.SCOUT_DECAY_SEC; if (log) log(team.team, 'Claimed ' + area.name + '.', 'claim'); }
      team._busyJob = null;
    }
  }
  // Scouting: the Steward's scouts advance the current target; speed scales with their number
  // (SCOUT_FULL scouts = EXPLORE_TIME). With no scouts assigned the job simply pauses.
  if (team.scoutJob) {
    const area = state.areas[team.scoutJob.areaId];
    const scouts = Math.max(0, Math.round(team.pop.scouts || 0));
    if (!area) team.scoutJob = null;
    else if (scouts > 0) {
      team.scoutJob.progress += ((scouts / B.SCOUT_FULL) / B.EXPLORE_TIME) * (1 + eco.stewardStat(team, 'scoutSpeed', state.elapsed)) * dt;
      if (team.scoutJob.progress >= 1) {
        area.revealed[team.team] = true; area.scouted[team.team] = true;
        area.scoutedUntil[team.team] = state.elapsed + B.SCOUT_DECAY_SEC;
        if (log) log(team.team, 'Scouted ' + area.name + '.', 'scout');
        team.scoutJob = null;
      }
    }
  }
  // Scout decay: an owned area stays scouted (refreshed each tick); an unowned scouted area lapses back
  // into the fog SCOUT_DECAY_SEC after the last refresh (≈300s after it's scouted or after it's lost).
  for (const id in state.areas) {
    const a = state.areas[id];
    if (!a.scouted[team.team]) continue;
    if (a.claimedBy === team.team) a.scoutedUntil[team.team] = state.elapsed + B.SCOUT_DECAY_SEC;
    else if ((a.scoutedUntil[team.team] || 0) <= state.elapsed) { a.scouted[team.team] = false; if (log) log(team.team, a.name + ' has slipped back into the fog — re-scout it.', 'scout'); }
  }

  // Claimed outposts accrue cargo (scaled by work mode + caravan mode) and dispatch caravans home.
  for (const id in state.areas) {
    const area = state.areas[id];
    if (!area.site || area.claimedBy !== team.team || area.terrain === 'base') continue;
    const y = B.SITE_YIELD[area.terrain];
    if (!y) continue;
    const wm = B.WORK_MODES[area.site.workMode] || B.WORK_MODES.standard;
    const cm = B.CARAVAN_MODES[area.site.caravanMode] || B.CARAVAN_MODES.standard;
    const amt = (y[area.resource] || 0) * area.site.level * wm.production * cm.yield * eco.stewardGatherMult(team, area.resource);
    area.site.cargo += amt * dt;
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
    cv.t += (B.CARAVAN_SPEED * (cv.speedMult || 1) * (1 + eco.stewardStat(team, 'caravanSpeed', state.elapsed)) * dt) / Math.max(1, legLen);
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
        // Cautious caravans may slip past the enemy entirely (50% by default).
        if ((cv.sneak || 0) > 0 && rng.chance(cv.sneak)) {
          if (log) log(team.team, '🌙 Cautious caravan slipped past enemy troops at ' + here + ' unseen.', 'caravan');
        } else {
        const post = state.areas[cv.guardPost];
        // Guards are stationed at the post and shared across its caravans — a caravan can field no more
        // than the post STILL holds (fixes two concurrent caravans both spending the same guards).
        const liveGuards = Math.min(Math.round(cv.guards || 0), (post && post.site) ? Math.round(post.site.guards || 0) : 0);
        if (liveGuards >= 1) {
          const guardsBefore = liveGuards;
          const r = guardSkirmish(state, team, hitArea, liveGuards);
          if (post && post.site) post.site.guards = Math.max(0, Math.round((post.site.guards || 0) - r.gLoss));
          cv.guards = Math.min(Math.max(0, Math.round((cv.guards || 0) - r.gLoss)), (post && post.site) ? Math.round(post.site.guards || 0) : 0);
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
        }   // end sneak-else
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
// Is an enemy host present ON this area (the outpost is under attack)?
function areaUnderAttack(state, team, areaId) {
  const foe = state.teams[S.enemyOf(team.team)];
  return foe.armies.some((g) => currentArea(g) === areaId && (function () { let n = 0; for (const u of C.UNITS) n += g.units[u] || 0; return n >= 0.5; })());
}
function setWorkMode(state, team, areaId, mode) {
  if (!B.WORK_MODES[mode]) return { ok: false, reason: 'Unknown work mode.' };
  const area = state.areas[areaId];
  if (!area || area.claimedBy !== team.team || !area.site) return { ok: false, reason: 'Not your outpost.' };
  if (area.site.workMode === mode) return { ok: false, reason: 'Already on that work mode.' };
  if (areaUnderAttack(state, team, areaId)) return { ok: false, reason: 'Cannot change work mode while ' + area.name + ' is under attack.' };
  if ((area.site.workModeUntil || 0) > state.elapsed) return { ok: false, reason: 'Work mode on cooldown (' + Math.ceil(area.site.workModeUntil - state.elapsed) + 's).' };
  area.site.workMode = mode;
  area.site.workModeUntil = state.elapsed + B.MODE_CHANGE_COOLDOWN;
  return { ok: true, msg: area.name + ': ' + B.WORK_MODES[mode].name + ' work mode.' };
}
function setCaravanMode(state, team, areaId, mode) {
  if (!B.CARAVAN_MODES[mode]) return { ok: false, reason: 'Unknown caravan mode.' };
  const area = state.areas[areaId];
  if (!area || area.claimedBy !== team.team || !area.site) return { ok: false, reason: 'Not your outpost.' };
  if (area.site.caravanMode === mode) return { ok: false, reason: 'Already on that caravan mode.' };
  if (areaUnderAttack(state, team, areaId)) return { ok: false, reason: 'Cannot change caravan mode while ' + area.name + ' is under attack.' };
  if ((area.site.caravanModeUntil || 0) > state.elapsed) return { ok: false, reason: 'Caravan mode on cooldown (' + Math.ceil(area.site.caravanModeUntil - state.elapsed) + 's).' };
  area.site.caravanMode = mode;
  area.site.caravanModeUntil = state.elapsed + B.MODE_CHANGE_COOLDOWN;
  return { ok: true, msg: area.name + ': ' + B.CARAVAN_MODES[mode].name + ' caravans.' };
}
// Dispatch a caravan from an outpost RIGHT NOW (load up whatever cargo it has and send it).
function dispatchCaravan(state, team, areaId, log) {
  const area = state.areas[areaId];
  if (!area || area.claimedBy !== team.team || !area.site) return { ok: false, reason: 'Not your outpost.' };
  if ((area.site.cargo || 0) < 1) return { ok: false, reason: 'Nothing to ship yet.' };
  if ((state.elapsed - (area.site.lastCaravanAt || -999)) < 2) return { ok: false, reason: 'A caravan just left — give it a moment.' };
  area.site.lastCaravanAt = state.elapsed;
  spawnCaravan(state, team, area, log);
  return { ok: true, msg: 'Caravan dispatched from ' + area.name + '.' };
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
  // Workers on expedition still count toward the population/housing (they're away, not gone) — otherwise
  // their freed housing is refilled by growth and they overflow the cap when they return.
  p.away = (p.away || 0) + taken;
  return taken;
}
// Refresh which expeditions are on offer (EXPEDITION_OFFER_COUNT of them; the window advances through
// the team's shuffled pool every EXPEDITION_ROTATE_SEC seconds, driven by team._elapsed).
function refreshExpeditionOffers(team) {
  const rot = (team.expeditionRotation && team.expeditionRotation.length) ? team.expeditionRotation : B.EXPEDITIONS.map((e) => e.id);
  const count = Math.min(B.EXPEDITION_OFFER_COUNT, rot.length);
  const sec = B.EXPEDITION_ROTATE_SEC;
  const t = team._elapsed || 0;
  const start = (Math.floor(t / sec) * count) % rot.length;
  const ids = []; for (let i = 0; i < count; i++) ids.push(rot[(start + i) % rot.length]);
  team.expeditionOffers = ids;
  team.expeditionOffersIn = Math.max(0, Math.ceil(sec - (t % sec)));
}
function startExpedition(state, team, id, useTools) {
  if (team.expedition) return { ok: false, reason: 'An expedition is already underway.' };
  if ((team.expeditionCooldownUntil || 0) > state.elapsed) return { ok: false, reason: 'Expeditions are on cooldown.' };
  const def = B.EXPEDITIONS.find((e) => e.id === id);
  if (!def) return { ok: false, reason: 'Unknown expedition.' };
  refreshExpeditionOffers(team);
  if (!(team.expeditionOffers || []).includes(id)) return { ok: false, reason: 'That expedition is no longer on offer.' };
  if (!expeditionEligible(state, team, def)) return { ok: false, reason: 'Requirements not met.' };
  // The Steward may draw on preparing (re-settling) workers too — unless the Lord has locked worker control.
  const allowCooling = !team.workerLock;
  const available = team.pop.idle + (allowCooling ? eco.coolingCount(team) : 0);
  if (available < def.workers) return { ok: false, reason: 'Needs ' + def.workers + ' free workers (idle' + (allowCooling ? ' or preparing' : '') + ').' };
  commitExpeditionWorkers(team, def.workers, allowCooling); eco.recomputeDerived(team);
  // Optionally equip the crew with tools (1/worker, consumed) to lower the crew-loss risk. Better tools
  // help more, worse less (Standard full tooling ≈ halves it; Legendary up to the cap).
  let risk = def.risk || 0, toolsUsed = 0;
  if (useTools !== false) {
    const arr = (team.gearInv && team.gearInv.tools) || [];
    const n = Math.min(def.workers, arr.length);
    if (n > 0) {
      arr.sort((a, b) => b - a);
      const used = arr.splice(0, n); toolsUsed = n; team.equipment.tools = arr.length;
      const avgQ = used.reduce((s, q) => s + q, 0) / used.length;
      const reduction = Math.min(B.EXPEDITION_TOOL_REDUCTION_MAX, B.EXPEDITION_TOOL_RISK_REDUCTION * (toolsUsed / def.workers) * avgQ);
      risk = risk * (1 - reduction);
    }
  }
  team.expedition = { id, name: def.name, workers: def.workers, endsAt: state.elapsed + def.time, reward: def.reward, risk, toolsUsed };
  return { ok: true, msg: def.name + ' sets out (' + def.workers + ' workers' + (toolsUsed ? ', ' + toolsUsed + ' tools' : '') + ', ' + def.time + 's).' };
}
function tickExpedition(state, team, dt, rng, log) {
  const ex = team.expedition;
  if (!ex) return;
  if (state.elapsed >= ex.endsAt) {
    for (const k in ex.reward) eco.addResource(team, k, ex.reward[k]);
    let returned = ex.workers;
    if (rng.chance(ex.risk || 0) && (team.pop.total - 1) >= B.POP_FLOOR) returned -= 1; // a crew may not come home
    team.pop.away = Math.max(0, (team.pop.away || 0) - ex.workers);   // they're no longer away…
    if (returned > 0) team.pop.idle += returned;                       // …survivors rejoin the idle pool
    eco.recomputeDerived(team);
    team.expedition = null;
    team.expeditionCooldownUntil = state.elapsed + B.EXPEDITION_COOLDOWN;
    if (log) log(team.team, ex.name + ' returns! ' + Object.keys(ex.reward).map((k) => '+' + ex.reward[k] + ' ' + k).join(', ') + (returned < ex.workers ? ' (a crew was lost)' : '') + '.', 'caravan');
  }
}

module.exports = { explore, claim, upgradeSite, abandon, tickSites, currentArea, areaIsDangerous, areaUnderAttack, enemyTroopsAt, spawnCaravan, setWorkMode, setCaravanMode, dispatchCaravan, setGuards, startExpedition, expeditionEligible, isScouted, refreshExpeditionOffers };
