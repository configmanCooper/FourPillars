/* Army & combat (Commander): muster units, missions, movement, battle resolution, sieges. */
'use strict';
const C = require('../../shared/constants.js');
const B = require('../../shared/balance.js');
const S = require('../../shared/schema.js');
const eco = require('./economy.js');

const BROKEN_Q = 0.3;   // weapon-quality multiplier of a soldier whose forged weapon was destroyed (fights with improvised arms)

function unitCount(g) { let n = 0; for (const u of C.UNITS) n += g.units[u] || 0; return n; }
function emptyUnits() { const u = {}; for (const k of C.UNITS) u[k] = 0; return u; }
function currentArea(g) { return g.moving ? g.moving.route[g.moving.legIndex] : g.area; }

// ---- Per-individual gear layer ----------------------------------------------------------------
// Each host carries g.gear[type] = an array of soldier records { w, a } (w = the soldier's WEAPON
// quality multiplier, a = ARMOUR quality multiplier; a===0 means no armour). g.units[type] stays the
// authoritative COUNT; g.gear[type].length is kept equal to it (reconcileGear self-heals any drift, so
// the game can never desync). Soldiers are created/moved/killed through these helpers so each fighter
// keeps the specific weapon & armour forged for them.
function ensureGear(g) { if (!g.gear) g.gear = {}; for (const u of C.UNITS) if (!g.gear[u]) g.gear[u] = []; return g.gear; }
function reconcileHostGear(g) {
  ensureGear(g);
  for (const u of C.UNITS) {
    const want = Math.max(0, Math.round(g.units[u] || 0));
    const arr = g.gear[u];
    if (arr.length > want) arr.length = want;
    while (arr.length < want) arr.push({ w: 1, a: 0 });
  }
}
function reconcileGear(team) { for (const g of team.armies) reconcileHostGear(g); }
// Move n soldiers of a type between hosts, carrying their individual gear records along.
function moveUnits(from, to, type, n) {
  n = Math.min(Math.round(n), Math.round(from.units[type] || 0));
  if (n <= 0) return 0;
  ensureGear(from); ensureGear(to);
  if (from.gear[type].length < Math.round(from.units[type] || 0)) reconcileHostGear(from);
  from.units[type] -= n; to.units[type] = (to.units[type] || 0) + n;
  const moved = from.gear[type].splice(0, n);
  while (moved.length < n) moved.push({ w: 1, a: 0 });
  for (const r of moved) to.gear[type].push(r);
  return n;
}
// Add one soldier of a type to a host with a specific gear record.
function addSoldier(g, type, rec) { ensureGear(g); g.units[type] = (g.units[type] || 0) + 1; g.gear[type].push(rec || { w: 1, a: 0 }); }
// Remove one soldier of a type, returning its gear record (caller decides which — random by default).
function removeSoldier(g, type, idx) {
  ensureGear(g); const arr = g.gear[type];
  if ((g.units[type] || 0) <= 0) return null;
  g.units[type] -= 1;
  if (arr.length) { const i = (typeof idx === 'number') ? idx : (arr.length - 1); return arr.splice(Math.min(i, arr.length - 1), 1)[0] || { w: 1, a: 0 }; }
  return { w: 1, a: 0 };
}

// Last-5 Commander action log (for the Lord's Military Overview). kind ∈ order|train|combat|warn.
function logMil(team, text, kind) {
  if (!team.militaryLog) team.militaryLog = [];
  team.militaryLog.unshift({ t: Math.round(team._elapsed || 0), text, kind: kind || 'order' });
  if (team.militaryLog.length > 5) team.militaryLog.length = 5;
}

function garrison(state, team) {
  let g = team.armies.find((a) => a.isGarrison);
  if (!g) {
    g = newGroup(state, team, S.homeBase(team.team), 'Home Garrison');
    g.isGarrison = true;
    g.mission = { type: 'defend' };
    team.armies.push(g);
  }
  return g;
}

function newGroup(state, team, area, name) {
  const ar = state && state.areas[area];
  return {
    id: S.uid('army'), team: team.team, name: name || 'Host', units: emptyUnits(),
    hasArmor: false, formation: 'line', stance: 'balanced', area,
    moving: null, mission: { type: 'idle' }, morale: 'normal', x: ar ? ar.x : 0, y: ar ? ar.y : 0,
  };
}

// Find/create a stationary host at an area to receive newly trained units.
function hostAt(state, team, area) {
  let g = team.armies.find((a) => currentArea(a) === area && !a.moving);
  if (!g) { g = newGroup(state, team, area, 'Host'); team.armies.push(g); }
  return g;
}
function barracksAreasOf(state, team) {
  const out = [];
  for (const id in state.areas) { const a = state.areas[id]; if (a.owner === team.team && (a.buildings.barracks || 0) > 0) out.push(id); }
  return out;
}

// Commander queues a training order at a specific Barracks location. Trainers (Lord-supplied)
// determine the speed; each Barracks runs up to 2 trainers of throughput.
function trainUnits(state, team, area, unitType, count) {
  if (!C.UNIT_META[unitType]) return { ok: false, reason: 'Unknown unit.' };
  count = Math.max(1, Math.floor(count || 1));
  if (!area || !state.areas[area]) { const list = barracksAreasOf(state, team); area = list[0]; }
  const ar = state.areas[area];
  if (!ar || ar.owner !== team.team || (ar.buildings.barracks || 0) <= 0) return { ok: false, reason: 'Train at a Barracks you own (build one first).' };
  if (unitsAtArea(team, area) >= B.MAX_UNITS_PER_AREA) return { ok: false, reason: 'That Barracks location already holds 20 soldiers (the cap) — move troops out before training more here.' };
  if (team.pop.trainers <= 0) return { ok: false, reason: 'Assign Trainers (the Lord does this at a Barracks) to train.' };
  if (unitType === 'cavalry' && team.buildings.stables <= 0) return { ok: false, reason: 'Build Stables for cavalry.' };
  if (unitType === 'catapult' && team.buildings.workshop <= 0) return { ok: false, reason: 'Build a Workshop for siege.' };
  if (team.pop.recruits < 1) return { ok: false, reason: 'No recruits — ask the Lord to levy population into recruits.' };
  team.training.push({ id: S.uid('tr'), area, unitType, count, progress: 0 });
  logMil(team, 'Training ' + count + ' ' + C.UNIT_META[unitType].name + ' at ' + ar.name + '.', 'train');
  return { ok: true, msg: 'Training ' + count + ' ' + C.UNIT_META[unitType].name + ' at ' + ar.name + '.' };
}
function cancelTraining(team, id) {
  const i = team.training.findIndex((t) => t.id === id);
  if (i < 0) return { ok: false, reason: 'No such order.' };
  team.training.splice(i, 1); return { ok: true };
}

// Count militia standing at a barracks area, and find a host there holding some.
function militiaAtArea(team, areaId) { let n = 0; for (const g of team.armies) if (currentArea(g) === areaId && !g.moving) n += g.units.militia || 0; return n; }
function hostWithUnitAt(team, areaId, type) { return team.armies.find((g) => currentArea(g) === areaId && !g.moving && (g.units[type] || 0) >= 1); }

// Commander upgrades existing militia into a better unit type (consuming the gear that unit needs),
// just like training a recruit — but the body is an already-mustered militiaman, not a fresh recruit.
function upgradeUnits(state, team, area, toType, count) {
  if (!C.UNIT_META[toType] || toType === 'militia') return { ok: false, reason: 'Pick a unit type to upgrade militia into.' };
  if (!area || !state.areas[area]) { const list = barracksAreasOf(state, team); area = list[0]; }
  const ar = state.areas[area];
  if (!ar || ar.owner !== team.team || (ar.buildings.barracks || 0) <= 0) return { ok: false, reason: 'Upgrade at a Barracks you own.' };
  if (team.pop.trainers <= 0) return { ok: false, reason: 'Assign Trainers (the Lord does this) to upgrade.' };
  if (toType === 'cavalry' && team.buildings.stables <= 0) return { ok: false, reason: 'Build Stables for cavalry.' };
  if (toType === 'catapult' && team.buildings.workshop <= 0) return { ok: false, reason: 'Build a Workshop for siege.' };
  const have = militiaAtArea(team, area);
  if (have < 1) return { ok: false, reason: 'No militia at this Barracks to upgrade — move some here first.' };
  count = Math.max(1, Math.min(Math.floor(count || 1), have));
  team.training.push({ id: S.uid('up'), area, unitType: toType, count, progress: 0, source: 'militia' });
  logMil(team, 'Upgrading ' + count + ' militia → ' + C.UNIT_META[toType].name + ' at ' + ar.name + '.', 'train');
  return { ok: true, msg: 'Upgrading ' + count + ' militia → ' + C.UNIT_META[toType].name + '.' };
}

// Back-compat helper: train at the best owned Barracks (home base preferred).
function formUnits(state, team, unitType, count) {
  const home = S.homeBase(team.team);
  let area = (state.areas[home].owner === team.team && (state.areas[home].buildings.barracks || 0) > 0) ? home : barracksAreasOf(state, team)[0];
  return trainUnits(state, team, area, unitType, count);
}

// Advance training each tick: trainer throughput converts recruits + equipment into units at the barracks.
function tickTraining(state, team, dt) {
  if (!team.training || !team.training.length) return;
  let trainersLeft = team.pop.trainers;
  for (const job of team.training) {
    const area = state.areas[job.area];
    if (!area || area.owner !== team.team || (area.buildings.barracks || 0) <= 0) { job.dead = true; continue; }
    const cap = Math.min(B.TRAINERS_PER_BARRACKS * area.buildings.barracks, trainersLeft);
    if (cap <= 0) continue;
    trainersLeft -= cap;
    job.progress += (cap / B.TRAIN_SECONDS_PER_UNIT) * (1 + eco.stewardStat(team, 'trainSpeed')) * dt;
    let guard = 0;
    while (job.progress >= 1 && job.count > 0 && guard < 20) {
      guard++;
      const fromMilitia = job.source === 'militia';
      if (!fromMilitia && team.pop.recruits < 1) { job.progress = 1; break; }
      const src = fromMilitia ? hostWithUnitAt(team, job.area, 'militia') : null;
      if (fromMilitia && !src) { job.progress = 1; break; }   // militia moved away — pause the upgrade
      // A recruit upgrade adds a body (cap-limited); a militia upgrade is net-zero (swap in place).
      if (!fromMilitia && unitsAtArea(team, job.area) + 1 > B.MAX_UNITS_PER_AREA + 0.001) { job.progress = 1; break; }
      const needs = C.UNIT_META[job.unitType].needs || {};
      let afford = true;
      for (const k in needs) {
        const isResource = team.equipment[k] === undefined;
        if (isResource && eco.blockedFor(team, k, 'COMMANDER', team._elapsed || 0)) { afford = false; break; } // reserved away from the Commander (no pass)
        const have = isResource ? (team.resources[k] || 0) : team.equipment[k];
        if (have < needs[k]) afford = false;
      }
      if (!afford) { job.progress = 1; break; } // stall until gear/permission arrives
      if (!fromMilitia) team.pop.recruits -= 1;   // militia upgrades consume their body via removeSoldier below (no double-decrement)
      // Consume the needed gear, drawing the BEST quality forged item for each need; the soldier keeps
      // the quality of their own weapon. Resources (horses, etc.) are spent from the stockpile.
      let weaponQ = 1; const wItem = B.UNIT_WEAPON[job.unitType];
      const isCatapult = job.unitType === 'catapult';
      let cataSum = 0, cataN = 0;   // a catapult's build quality = AVERAGE of the siege parts used to build it
      for (const k in needs) {
        if (team.equipment[k] !== undefined) {
          for (let z = 0; z < needs[k]; z++) { const q = eco.takeBestGear(team, k); if (k === wItem && q != null) weaponQ = q; if (isCatapult && k === 'siegeParts' && q != null) { cataSum += q; cataN++; } }
        } else { team.resources[k] -= needs[k]; eco.logSpend(team, k, 'COMMANDER', needs[k], (fromMilitia ? 'upgrading to ' : 'training ') + C.UNIT_META[job.unitType].name); }
      }
      if (isCatapult && cataN > 0) weaponQ = cataSum / cataN;   // stored in rec.w; scales the catapult's attack & siege power
      // Issue this soldier their own armour if any is stockpiled (each soldier carries individual armour).
      let armorQ = 0;
      if ((team.equipment.armor || 0) >= 1) { const aq = eco.takeBestGear(team, 'armor'); if (aq != null) armorQ = aq; }
      const g = fromMilitia ? src : hostAt(state, team, job.area);
      if (fromMilitia) removeSoldier(src, 'militia');
      addSoldier(g, job.unitType, { w: weaponQ, a: armorQ });
      if (armorQ > 0) g.hasArmor = true;
      job.progress -= 1; job.count -= 1;
    }
  }
  team.training = team.training.filter((j) => !j.dead && j.count > 0);
  recountSoldiers(team);
}
function recountSoldiers(team) { let n = 0; for (const g of team.armies) n += unitCount(g); team.pop.soldiers = Math.round(n); eco.recomputeDerived(team); }


// Split a new host out of the garrison and (optionally) give it a mission.
function rally(state, team, unitsWanted, name) {
  const g = garrison(state, team);
  const grp = newGroup(state, team, currentArea(g), name || (team.armies.length + 'th Host'));
  let moved = 0;
  let cap = B.MAX_UNITS_PER_AREA;   // a rallied host can never exceed the per-location cap
  for (const u of C.UNITS) {
    let take = Math.min(g.units[u] || 0, Math.floor(unitsWanted[u] || 0));
    take = Math.min(take, Math.max(0, Math.floor(cap - moved)));
    moved += moveUnits(g, grp, u, take);
  }
  if (moved <= 0) return { ok: false, reason: 'No units selected.' };
  grp.hasArmor = g.hasArmor;
  team.armies.push(grp);
  logMil(team, 'Rallied a new host of ' + moved + ' units.', 'order');
  return { ok: true, group: grp, msg: 'Rallied a new host of ' + moved + '.' };
}

// Move units between two of the team's hosts (split into a new host if toId==='new'); used by the
// Commander's army-management UI. Co-location required for two existing hosts (no teleporting troops).
function transferUnits(state, team, fromId, toId, units, name) {
  const from = team.armies.find((a) => a.id === fromId);
  if (!from) return { ok: false, reason: 'No such host.' };
  let to, created = false;
  if (toId === 'new') {
    to = newGroup(state, team, currentArea(from), name || 'Detachment'); to.x = from.x; to.y = from.y; to.hasArmor = from.hasArmor; created = true;
  } else {
    to = team.armies.find((a) => a.id === toId);
    if (!to) return { ok: false, reason: 'No destination host.' };
    if (to === from) return { ok: false, reason: 'Same host.' };
    if (from.moving || to.moving || currentArea(from) !== currentArea(to)) return { ok: false, reason: 'Both hosts must be at the same location (and not marching) to transfer.' };
  }
  let moved = 0;
  let toCount = unitCount(to);   // no host may exceed the per-location cap
  for (const u of C.UNITS) {
    let take = Math.min(from.units[u] || 0, Math.max(0, Math.floor((units && units[u]) || 0)));
    take = Math.min(take, Math.max(0, Math.floor(B.MAX_UNITS_PER_AREA - toCount)));
    const m = moveUnits(from, to, u, take); moved += m; toCount += m;
  }
  if (moved <= 0) return { ok: false, reason: created ? 'Pick some units to move.' : 'That host is already at the 20-unit cap.' };
  if (from.hasArmor) to.hasArmor = true;
  if (created) team.armies.push(to);
  if (unitCount(from) < 0.5 && !from.isGarrison) { team.armies = team.armies.filter((a) => a !== from); }
  logMil(team, 'Reorganised forces (' + moved + ' moved' + (created ? ' → new host' : '') + ').', 'order');
  recountSoldiers(team);
  return { ok: true, msg: 'Moved ' + moved + ' units.' };
}

function setFormation(team, groupId, f) {
  const g = team.armies.find((a) => a.id === groupId); if (!g) return { ok: false, reason: 'No host.' };
  if (!B.FORMATIONS[f]) return { ok: false, reason: 'Unknown formation.' };
  g.formation = f; return { ok: true };
}
function setStance(team, groupId, s) {
  const g = team.armies.find((a) => a.id === groupId); if (!g) return { ok: false, reason: 'No host.' };
  if (!B.STANCES[s]) return { ok: false, reason: 'Unknown stance.' };
  g.stance = s; return { ok: true };
}

function moveGroupTo(state, g, destId, missionType) {
  // Per-location cap: a host may only enter a NEW location if its whole strength fits under the
  // 20-troop cap there (existing friendly troops + this host ≤ 20). Otherwise it holds where it is.
  if (destId !== currentArea(g)) {
    const team = state.teams[g.team];
    if (team && unitsAtAreaExcept(team, destId, g.id) + unitCount(g) > B.MAX_UNITS_PER_AREA + 0.001) {
      g.mission = { type: missionType, targetArea: destId, held: true };
      return false;
    }
  }
  const route = S.findPath(state.areas, currentArea(g), destId);
  if (!route || route.length < 2) { g.area = destId; g.moving = null; g.mission = { type: missionType, targetArea: destId }; return true; }
  g.moving = { route, legIndex: 0, t: 0 };
  g.mission = { type: missionType, targetArea: destId };
  return true;
}

function command(state, team, groupId, missionType, targetArea) {
  const g = team.armies.find((a) => a.id === groupId);
  if (!g) return { ok: false, reason: 'No such host.' };
  if (unitCount(g) < 0.5) return { ok: false, reason: 'That host is empty.' };
  const capMsg = (areaId) => 'That location already holds 20 soldiers (the cap) — it cannot take more.';
  switch (missionType) {
    case 'defend': {
      const dest = S.homeBase(team.team);
      if (!moveGroupTo(state, g, dest, 'defend')) return { ok: false, reason: capMsg(dest) };
      logMil(team, g.name + ' ordered to defend the Keep.', 'order'); return { ok: true, msg: g.name + ' returns to defend.' };
    }
    case 'garrison': case 'raid': case 'attack': {
      if (!state.areas[targetArea]) return { ok: false, reason: 'Unknown target.' };
      if (!moveGroupTo(state, g, targetArea, missionType)) return { ok: false, reason: capMsg(targetArea) };
      logMil(team, g.name + ' ' + (missionType === 'raid' ? 'raids' : missionType === 'attack' ? 'attacks' : 'garrisons') + ' ' + state.areas[targetArea].name + '.', missionType === 'garrison' ? 'order' : 'combat'); return { ok: true, msg: g.name + ' marches to ' + state.areas[targetArea].name + '.' };
    }
    case 'siege': {
      const enemyBase = S.homeBase(S.enemyOf(team.team));
      if (!moveGroupTo(state, g, enemyBase, 'siege')) return { ok: false, reason: 'Up to 20 soldiers may assault one location — the enemy Keep is already at that cap.' };
      logMil(team, g.name + ' marches to siege the enemy Keep!', 'combat'); return { ok: true, msg: g.name + ' marches to siege the enemy Keep!' };
    }
    case 'escort': {
      const cv = team.caravans.find((c) => c.id === targetArea) || team.caravans[0];
      if (!cv) return { ok: false, reason: 'No caravan to escort.' };
      cv.escort = true; cv.escortGroupId = g.id; g.mission = { type: 'escort', caravanId: cv.id };
      moveGroupTo(state, g, cv.route[cv.legIndex + 1] || cv.route[cv.legIndex], 'escort');
      logMil(team, g.name + ' escorts a caravan.', 'order');
      return { ok: true, msg: g.name + ' escorts the caravan.' };
    }
    default: return { ok: false, reason: 'Unknown order.' };
  }
}

// Host march speed: infantry ~2x caravan speed, an all-cavalry host ~3x, then formation/doctrine mods.
function hostSpeed(team, g) {
  const tot = unitCount(g);
  const allCav = tot >= 0.5 && (g.units.cavalry || 0) >= tot - 0.001;
  let speed = (allCav ? B.CAVALRY_SPEED_MULT : B.HOST_SPEED_MULT) * B.CARAVAN_SPEED;
  if (g.formation === 'shieldWall') speed *= B.FORMATIONS.shieldWall.speedMult;
  const doc = team.doctrine ? B.DOCTRINES[team.doctrine] : null;
  if (doc && doc.speedMult) speed *= doc.speedMult;
  speed *= (1 + eco.stewardStat(team, 'armySpeed'));   // Rally the Banners
  return speed;
}
function tickMovement(state, team, dt) {
  // Prune emptied non-garrison hosts (e.g. after consolidation) so the map stays clean.
  team.armies = team.armies.filter((a) => a.isGarrison || unitCount(a) >= 0.5);
  const foe = state.teams[S.enemyOf(team.team)];
  for (const g of team.armies) {
    const a = currentArea(g); const ar = state.areas[a]; g.x = ar.x; g.y = ar.y;
    // Pinned: the host has stopped to fight a caravan's guards — it holds in place.
    if (g.pinnedUntil && g.pinnedUntil > state.elapsed) continue;
    // Pursuit: chase a fleeing caravan whose guards we broke. Faster hosts overtake and run it down.
    if (g.pursue) {
      const cv = foe.caravans.find((c) => c.id === g.pursue);
      if (!cv || (g.pursueUntil || 0) <= state.elapsed) { g.pursue = null; g.pursueUntil = 0; }
      else {
        const tgtArea = cv.route[Math.min(cv.legIndex + 1, cv.route.length - 1)];
        if (!g.moving || g.moving.route[g.moving.route.length - 1] !== tgtArea) {
          const route = S.findPath(state.areas, currentArea(g), tgtArea);
          g.moving = (route && route.length >= 2) ? { route, legIndex: 0, t: 0 } : null;
          if (!g.moving) { g.area = currentArea(g); }
        }
      }
    }
    if (!g.moving) continue;
    const fromA = state.areas[g.moving.route[g.moving.legIndex]];
    const toA = state.areas[g.moving.route[g.moving.legIndex + 1]];
    if (!toA) { g.area = g.moving.route[g.moving.legIndex]; g.moving = null; continue; }
    const speed = hostSpeed(team, g);
    const legLen = Math.hypot(toA.x - fromA.x, toA.y - fromA.y);
    g.moving.t += (speed * dt) / Math.max(1, legLen);
    g.x = fromA.x + (toA.x - fromA.x) * Math.min(1, g.moving.t);
    g.y = fromA.y + (toA.y - fromA.y) * Math.min(1, g.moving.t);
    if (g.moving.t >= 1) {
      const nextIdx = g.moving.legIndex + 1;
      const arrivingAt = g.moving.route[nextIdx];
      const isFinal = nextIdx >= g.moving.route.length - 1;
      // Arrival cap: if entering the final destination would push our troops there past 20, hold this
      // host one node back as a reserve instead of over-stacking the location.
      if (!g.pursue && isFinal && arrivingAt !== currentArea(g) && unitsAtAreaExcept(team, arrivingAt, g.id) + unitCount(g) > B.MAX_UNITS_PER_AREA + 0.001) {
        const holdNode = g.moving.route[g.moving.legIndex];
        g.area = holdNode; g.moving = null;
        const ha = state.areas[holdNode]; g.x = ha.x; g.y = ha.y;
        g.mission = { type: (g.mission && g.mission.type) || 'idle', targetArea: arrivingAt, held: true };
      } else {
        g.moving.legIndex += 1; g.moving.t = 0;
        if (g.moving.legIndex >= g.moving.route.length - 1) {
          g.area = g.moving.route[g.moving.legIndex]; g.moving = null;
        }
      }
    }
  }
}

function strength(team, g, enemyComp, wallMult, onOwnOutpost, unscouted) {
  let atk = 0, def = 0;
  const eq = team.equipQuality || {};
  ensureGear(g);
  const archerN = g.units.archer || 0;
  const arrowsHave = team.resources.arrows || 0;
  // Better arrows last longer (lower consumption).
  let arrowNeed = archerN * B.ARCHER_ARROW_USE / (eq.arrows || 1);
  const arrowOk = arrowsHave >= arrowNeed;
  // Composition counters (count of enemy SOLDIERS, capped so the bonus tops out at +50%):
  //  • cavalry get +10% per enemy unit that is neither a spearman nor cavalry (archers, swordsmen, …);
  //  • spearmen get +10% per enemy cavalry. Both cap at +50% and lift attack AND defence.
  const cavBonus = enemyComp ? 1 + Math.min(B.COUNTER_BONUS_MAX, B.COUNTER_BONUS_PER * (enemyComp.softVsCav || 0)) : 1;
  const spearBonus = enemyComp ? 1 + Math.min(B.COUNTER_BONUS_MAX, B.COUNTER_BONUS_PER * (enemyComp.cav || 0)) : 1;
  // Research: Weaponsmithing lifts every soldier's attack; Plate Armour boosts armour's defence effect.
  const resAtk = 1 + eco.researchStat(team, 'attack');
  const armorDefMult = 1 + eco.researchStat(team, 'armorDef');
  // Archer formation cover: archers are fragile alone but deadly behind a line. Each non-archer, non-catapult
  // unit sharing their host shields them for +10% DEFENCE, capped at +100% (i.e. once 10+ frontline units screen
  // them). Encourages mixing archers into a proper combined-arms host rather than fielding glass-cannon stacks.
  let frontline = 0; for (const u of C.UNITS) { if (u !== 'archer' && u !== 'catapult') frontline += Math.round(g.units[u] || 0); }
  const archerCoverDef = 1 + Math.min(1.0, 0.10 * frontline);
  for (const u of C.UNITS) {
    const n = Math.round(g.units[u] || 0); if (n <= 0) continue;
    const st = B.UNIT_STATS[u]; const wep = B.UNIT_WEAPON[u]; const recs = g.gear[u] || [];
    for (let i = 0; i < n; i++) {
      const rec = recs[i] || { w: 1, a: 0 };
      let ua = st.atk, ud = st.def;
      if (u === 'archer' && !arrowOk) ua = 1;                                  // out of arrows -> fight poorly
      if (u === 'archer' && onOwnOutpost) ud *= B.ARCHER_OUTPOST_BONUS;        // archers dig in on our own outpost — DEFENCE only
      if (u === 'archer') ud *= archerCoverDef;                                // +10% DEF per shielding frontline hostmate (cap +100%)
      if (u === 'cavalry') { ua *= cavBonus; ud *= cavBonus; }                 // strong vs soft (non-spear/non-cav) foes
      if (u === 'spearman') { ua *= spearBonus; ud *= spearBonus; }            // strong vs cavalry
      if (wep) ua *= (rec.w || 1);                                             // this soldier's OWN weapon quality
      if (u === 'catapult') ua *= (rec.w || 1);                                // catapult build quality (avg of its siege parts) scales its attack
      ua *= resAtk;                                                            // Weaponsmithing research
      // Walls fortify the DEFENCE of the side that OWNS this location only (battleRound passes wallMult
      // only to the owner): +40% def for troops at 2 walls, +100% def for archers. Never boosts attack.
      if (wallMult) ud *= (u === 'archer') ? wallMult.archer : wallMult.troop;
      if (rec.a > 0) { ua *= B.EQUIP_TIER_MULT.advanced; ud *= B.EQUIP_TIER_MULT.advanced * (1 + B.ARMOR_DEF_BONUS * armorDefMult * rec.a); }  // this soldier's OWN armour (+ Plate Armour research)
      atk += ua; def += ud;
    }
  }
  const F = B.FORMATIONS[g.formation]; atk *= F.atkMult; def *= F.defMult;
  const St = B.STANCES[g.stance]; atk *= St.atkMult;
  const doc = team.doctrine ? B.DOCTRINES[team.doctrine] : null;
  if (doc) { if (doc.atkMult) atk *= doc.atkMult; if (doc.defMult) def *= doc.defMult; }
  const mp = team.militaryPolicy ? B.MILITARY_POLICIES[team.militaryPolicy] : null;
  if (mp) { if (mp.atkMult) atk *= mp.atkMult; if (mp.defMult) def *= mp.defMult; }
  def *= (1 + eco.stewardStat(team, 'troopDef'));   // Muster the Levy — DEFENCE only
  atk *= B.MORALE[g.morale] || 1; def *= B.MORALE[g.morale] || 1;
  // Fighting blind: in an area this team hasn't scouted, soldiers fight at a penalty to attack AND defence.
  if (unscouted) { const m = 1 - B.UNSCOUTED_COMBAT_PENALTY; atk *= m; def *= m; }
  return { atk, def, arrowNeed: arrowOk ? arrowNeed : 0 };
}

function composition(g) {
  // softVsCav = enemy soldiers that are neither spearman nor cavalry (what cavalry feast on).
  let soft = 0;
  for (const u of C.UNITS) { if (u === 'spearman' || u === 'cavalry') continue; soft += g.units[u] || 0; }
  return {
    cav: g.units.cavalry || 0,
    softVsCav: soft,
    ranged: (g.units.archer || 0),
    total: unitCount(g),
  };
}

function applyLosses(g, frac) {
  frac = Math.max(0, Math.min(0.6, frac));
  for (const u of C.UNITS) g.units[u] = Math.max(0, (g.units[u] || 0) * (1 - frac));
}

// Resolve battles in every area where both teams have a host present (moving or not). A host caught
// in a battle STOPS to fight it out — no marching away mid-engagement — and BOTH sides take losses.
function resolveCombat(state, dt, rng, log) {
  state._combatFx = [];
  const fx = new Map();   // host -> {losses, saves} this tick, for on-screen floaters
  const byArea = {};
  for (const team of [state.teams.BLUE, state.teams.RED]) {
    for (const g of team.armies) {
      if (unitCount(g) < 0.5) continue;
      const a = currentArea(g);
      (byArea[a] = byArea[a] || { BLUE: [], RED: [] })[team.team].push(g);
    }
  }
  const fightingNow = {};
  for (const areaId in byArea) {
    const blue = byArea[areaId].BLUE, red = byArea[areaId].RED;
    if (blue.length && red.length) {
      // Engaged hosts halt and commit — a marching army can't drive past defenders untouched.
      const ar = state.areas[areaId];
      for (const g of blue.concat(red)) {
        if (g.moving) { g.moving = null; g.area = areaId; if (ar) { g.x = ar.x; g.y = ar.y; } g.mission = { type: 'engage', targetArea: areaId }; }
        fightingNow[g.id] = true;
        if (!g._fighting) rollWeaponDegrade(g, rng, log, g.team === 'BLUE' ? state.teams.BLUE : state.teams.RED);   // new encounter: weapons may wear
      }
      battleRound(state, areaId, mergeGroups(blue), mergeGroups(red), state.teams.BLUE, state.teams.RED, dt, rng, log, blue, red, fx);
    }
  }
  // Mark who is (still) fighting so each engagement only rolls weapon wear once.
  for (const team of [state.teams.BLUE, state.teams.RED]) for (const g of team.armies) g._fighting = !!fightingNow[g.id];
  // Publish per-host combat floaters (losses & armour saves) at each host's position.
  for (const [host, e] of fx) { if ((e.losses || 0) + (e.saves || 0) > 0) state._combatFx.push({ x: host.x, y: host.y, team: host.team, losses: e.losses || 0, saves: e.saves || 0 }); }
}
function recordFx(fx, host, key) { if (!fx) return; let e = fx.get(host); if (!e) { e = { losses: 0, saves: 0 }; fx.set(host, e); } e[key]++; }

// One combat encounter: each soldier with a weapon may degrade it a tier; a lowest-tier weapon breaks.
function rollWeaponDegrade(g, rng, log, team) {
  ensureGear(g);
  const L = B.QUALITY_LADDER; let degraded = 0, broken = 0;
  for (const u of C.UNITS) {
    if (!B.UNIT_WEAPON[u]) continue;                       // militia carry no forged weapon
    for (const rec of (g.gear[u] || [])) {
      if (!rng.chance(B.WEAPON_DEGRADE_CHANCE)) continue;
      if (rec.w <= L[0] + 0.001) { rec.w = BROKEN_Q; broken++; }   // already lowest tier -> destroyed
      else { let lower = L[0]; for (const v of L) { if (v < rec.w - 0.001) lower = v; else break; } rec.w = lower; degraded++; }
    }
  }
  if (log && (degraded || broken) && team) logMil(team, '⚔️ Battle wear: ' + (degraded ? degraded + ' weapon' + (degraded === 1 ? '' : 's') + ' dulled' : '') + (degraded && broken ? ', ' : '') + (broken ? broken + ' weapon' + (broken === 1 ? '' : 's') + ' shattered' : '') + ' in ' + g.name + '.', 'combat');
}

// Re-equip a host from the armoury: give each soldier the best available weapon (and armour) that beats
// what they carry; the gear they drop returns to the stockpile for someone worse-equipped.
function reequip(state, team, groupId) {
  const g = team.armies.find((a) => a.id === groupId);
  if (!g) return { ok: false, reason: 'No such host.' };
  ensureGear(g); team.gearInv = team.gearInv || {};
  let upg = 0;
  for (const u of C.UNITS) {
    const wItem = B.UNIT_WEAPON[u]; if (!wItem) continue;
    const recs = g.gear[u].slice().sort((a, b) => a.w - b.w);   // worst-equipped first
    for (const rec of recs) {
      const inv = team.gearInv[wItem] || [];
      if (!inv.length) break;
      const best = Math.max.apply(null, inv);
      if (best > rec.w + 0.001) { const newQ = eco.takeBestGear(team, wItem); if (rec.w >= 0.5) eco.addGear(team, wItem, rec.w); rec.w = newQ; upg++; }
    }
    for (const rec of g.gear[u]) {
      const inv = team.gearInv.armor || [];
      if (!inv.length) break;
      const best = Math.max.apply(null, inv);
      if (best > rec.a + 0.001) { const newA = eco.takeBestGear(team, 'armor'); if (rec.a > 0) eco.addGear(team, 'armor', rec.a); rec.a = newA; if (rec.a > 0) g.hasArmor = true; upg++; }
    }
  }
  if (upg <= 0) return { ok: false, reason: 'No better gear in the armoury for ' + g.name + '.' };
  logMil(team, '🛠️ Re-equipped ' + upg + ' soldier' + (upg === 1 ? '' : 's') + ' in ' + g.name + ' from the armoury.', 'order');
  return { ok: true, msg: 'Re-equipped ' + upg + ' soldiers in ' + g.name + '.' };
}

// Baseline host attack/defence (no enemy/wall situational bonuses) — for the UI's strength readout.
function hostPower(team, g) { const s = strength(team, g, null, null); return { atk: Math.round(s.atk), def: Math.round(s.def) }; }

// Treat all co-located friendly hosts as one combined force for the round.
function mergeGroups(list) {
  const m = { units: emptyUnits(), hasArmor: false, formation: list[0].formation, stance: list[0].stance, morale: list[0].morale };
  for (const g of list) { for (const u of C.UNITS) m.units[u] += g.units[u] || 0; if (g.hasArmor) m.hasArmor = true; }
  return m;
}

function battleRound(state, areaId, blueM, redM, blueT, redT, dt, rng, log, blueList, redList, fx) {
  const bComp = composition(blueM), rComp = composition(redM);
  // Walls fortify the DEFENCE of whoever OWNS this location: +20% def to all troops, +50% def to
  // archers (per wall, capped at 2). Attack is never boosted by walls.
  const area = state.areas[areaId];
  const walls = (area && area.buildings) ? (area.buildings.walls || 0) : 0;
  const wallMult = walls > 0 ? { troop: 1 + Math.min(walls, 2) * B.WALL_TROOP_BONUS, archer: 1 + Math.min(walls, 2) * B.WALL_ARCHER_BONUS } : null;
  const blueWall = (wallMult && area.owner === 'BLUE') ? wallMult : null;
  const redWall = (wallMult && area.owner === 'RED') ? wallMult : null;
  // Archers get a bonus when fighting on their team's OWN outpost (a claimed, non-base site).
  const isOutpost = area && area.terrain !== 'base' && !!area.site;
  const blueOutpost = isOutpost && area.owner === 'BLUE';
  const redOutpost = isOutpost && area.owner === 'RED';
  // Fighting in an area you haven't scouted is a penalty (each side checks its OWN scouting).
  const blueUnscouted = !(area && area.scouted && area.scouted.BLUE);
  const redUnscouted = !(area && area.scouted && area.scouted.RED);
  const bS = strength(blueT, blueM, rComp, blueWall, blueOutpost, blueUnscouted), rS = strength(redT, redM, bComp, redWall, redOutpost, redUnscouted);
  // Consume arrows.
  blueT.resources.arrows = Math.max(0, (blueT.resources.arrows || 0) - bS.arrowNeed * dt);
  redT.resources.arrows = Math.max(0, (redT.resources.arrows || 0) - rS.arrowNeed * dt);
  // Effective force is capped at 20 per side (no benefit to doom-stacking a single location).
  const bTot = unitCount(blueM), rTot = unitCount(redM);
  const bCap = bTot > B.MAX_UNITS_PER_AREA ? B.MAX_UNITS_PER_AREA / bTot : 1;
  const rCap = rTot > B.MAX_UNITS_PER_AREA ? B.MAX_UNITS_PER_AREA / rTot : 1;
  // Defenders fight +50% better at their own Keep (on top of walls/doctrine/stance/policy).
  const isBase = area && area.terrain === 'base';
  const bKeep = (isBase && area.owner === 'BLUE') ? B.KEEP_DEFENDER_BONUS : 1;
  const rKeep = (isBase && area.owner === 'RED') ? B.KEEP_DEFENDER_BONUS : 1;
  // Speed → attack cadence: a host's average unit speed scales how OFTEN it lands blows (its attack
  // contribution). Fast hosts (cavalry) strike more; slow ones (catapults) less. Bounded so it tilts,
  // not dominates. Defence is unaffected.
  const spMult = (m) => { let tot = 0, sp = 0; for (const u of C.UNITS) { const n = m.units[u] || 0; if (n > 0) { tot += n; sp += (B.UNIT_STATS[u].speed || B.SPEED_COMBAT_REF) * n; } } const avg = tot > 0 ? sp / tot : B.SPEED_COMBAT_REF; return Math.max(B.SPEED_COMBAT_MIN, Math.min(B.SPEED_COMBAT_MAX, avg / B.SPEED_COMBAT_REF)); };
  const bSpd = spMult(blueM), rSpd = spMult(redM);
  // Combat model: your ATTACK (× speed cadence) drives how many of the enemy you kill; the enemy's
  // DEFENCE (× their Keep bonus) blunts it. So defence directly LESSENS your chance of being killed,
  // while attack drives your killing — they no longer blur into one "power" number.
  const bOff = bS.atk * bSpd * bCap;          // blue's offensive output
  const rOff = rS.atk * rSpd * rCap;          // red's offensive output
  const bDefr = bS.def * bCap * bKeep + 1;    // blue's defensive resilience (Keep bonus aids defenders)
  const rDefr = rS.def * rCap * rKeep + 1;    // red's defensive resilience
  // Per-second discrete combat: each side rolls 0/1/2/3 kills. A stance's lossMult makes the TARGET more
  // or less vulnerable; then the target soldier's own ARMOUR may still save them.
  const bVuln = B.STANCES[blueM.stance].lossMult || 1;
  const rVuln = B.STANCES[redM.stance].lossMult || 1;
  // Kills BLUE lands on RED = blue offence vs red defence (and red's stance vulnerability); vice-versa.
  const blueShare = (bOff * rVuln) / (bOff * rVuln + rDefr);
  const redShare = (rOff * bVuln) / (rOff * bVuln + bDefr);
  const killsVsRed = rollKills(blueShare, rng);
  const killsVsBlue = rollKills(redShare, rng);
  applyKills(redT, redList, killsVsRed, rng, fx);
  applyKills(blueT, blueList, killsVsBlue, rng, fx);
  for (const g of blueList) g.morale = killsVsBlue >= 2 ? 'low' : (g.morale === 'low' && killsVsBlue === 0 ? 'normal' : g.morale);
  for (const g of redList) g.morale = killsVsRed >= 2 ? 'low' : (g.morale === 'low' && killsVsRed === 0 ? 'normal' : g.morale);
  // Cautious stance retreats home when badly outnumbered (total-strength proxy = offence + resilience).
  const bPow = bOff + bDefr, rPow = rOff + rDefr;
  retreatCheck(state, blueList, bPow, rPow);
  retreatCheck(state, redList, rPow, bPow);
  // Cleanup destroyed; log decisive results.
  cleanup(state, blueT, areaId, log); cleanup(state, redT, areaId, log);
}

// Roll this second's kills from a strength share (even = 0.5). P(1) > P(2) > P(3), rest is stalemate.
function rollKills(share, rng) {
  const k = B.COMBAT_INTENSITY * share;
  let p1 = Math.min(0.6, k * 0.6), p2 = Math.min(0.35, k * 0.25), p3 = Math.min(0.25, k * 0.12);
  const s = p1 + p2 + p3; if (s > 0.95) { const f = 0.95 / s; p1 *= f; p2 *= f; p3 *= f; }
  const r = rng.range(0, 1);
  if (r < p1) return 1;
  if (r < p1 + p2) return 2;
  if (r < p1 + p2 + p3) return 3;
  return 0;
}
// Pick one of a side's hosts to take a casualty, weighted by host size.
function pickWeightedHost(list, rng) {
  let tot = 0; for (const g of list) tot += unitCount(g);
  if (tot <= 0) return null;
  let r = rng.range(0, tot);
  for (const g of list) { r -= unitCount(g); if (r <= 0) return g; }
  return list[list.length - 1];
}
// Remove one soldier from a host (its individual gear record too), type chosen weighted by counts.
function killOneUnit(g, rng) {
  ensureGear(g);
  const tot = unitCount(g); if (tot <= 0) return;
  let r = rng.range(0, tot);
  for (const u of C.UNITS) { const n = g.units[u] || 0; if (n <= 0) continue; if (r < n) { removeSoldier(g, u, Math.floor(r)); return; } r -= n; }
  for (const u of C.UNITS) if ((g.units[u] || 0) > 0) { removeSoldier(g, u); return; }
}
// Apply this second's kills to a side: spread across hosts; each chosen soldier's OWN armour may save them.
function applyKills(team, list, kills, rng, fx) {
  if (kills <= 0) return;
  for (let k = 0; k < kills; k++) {
    const target = pickWeightedHost(list, rng); if (!target) break;
    ensureGear(target);
    const tot = unitCount(target); if (tot <= 0) continue;
    let r = rng.range(0, tot), chosenType = null, chosenIdx = 0;
    for (const u of C.UNITS) { const n = target.units[u] || 0; if (n <= 0) continue; if (r < n) { chosenType = u; chosenIdx = Math.floor(r); break; } r -= n; }
    if (!chosenType) continue;
    const rec = (target.gear[chosenType] || [])[chosenIdx] || { w: 1, a: 0 };
    if (rec.a > 0 && rng.chance(Math.min(B.ARMOR_SAVE_MAX, B.ARMOR_SAVE_BASE * rec.a))) { recordFx(fx, target, 'saves'); continue; }   // their armour turned the blow
    removeSoldier(target, chosenType, chosenIdx);
    recordFx(fx, target, 'losses');
  }
}

function retreatCheck(state, list, myPow, foePow) {
  if (foePow > myPow * 1.6) {
    for (const g of list) {
      if (g.stance === 'cautious' && !g.isGarrison) { moveGroupTo(state, g, S.homeBase(g.team), 'defend'); }
    }
  }
}

function cleanup(state, team, areaId, log) {
  for (let i = team.armies.length - 1; i >= 0; i--) {
    const g = team.armies[i];
    const n = unitCount(g);
    team.pop.soldiers = 0; // recomputed below
    if (n < 0.5 && !g.isGarrison) {
      if (log) log(team.team, g.name + ' was destroyed in battle.', 'battle');
      team.armies.splice(i, 1);
    } else if (n < 0.5 && g.isGarrison) {
      for (const u of C.UNITS) g.units[u] = 0;
    }
  }
  // Recount soldiers across surviving groups.
  let soldiers = 0; for (const g of team.armies) soldiers += unitCount(g);
  team.pop.soldiers = Math.round(soldiers);
}

// Total units a team currently has at one area (for the per-location cap).
// Stationed (non-moving) units a team has at an area. Hosts merely marching THROUGH a node are in
// transit and don't count toward the location cap — only troops actually stopped there do.
function unitsAtArea(team, areaId) { let n = 0; for (const g of team.armies) if (!g.moving && g.area === areaId && unitCount(g) >= 0.5) n += unitCount(g); return n; }
// Same, ignoring one host (used for cap checks before a merge/move).
function unitsAtAreaExcept(team, areaId, exceptId) { let n = 0; for (const g of team.armies) { if (g.id === exceptId) continue; if (!g.moving && g.area === areaId && unitCount(g) >= 0.5) n += unitCount(g); } return n; }
// Free troop slots a team still has at an area before hitting the per-location cap (20).
function roomAt(team, areaId, exceptId) { return Math.max(0, B.MAX_UNITS_PER_AREA - unitsAtAreaExcept(team, areaId, exceptId)); }

// Safety net: guarantee the per-location cap (20 stationed troops per team). Runs at end of tick so
// it catches every entry path and movement race. Non-destructive — no troops are ever deleted.
// Merge co-located, stationary hosts that share the same orders into as few hosts as possible (each
// still capped at MAX_UNITS_PER_AREA). Turns a swarm of tiny redundant hosts into one clean stack.
function mergeCoLocated(team) {
  const byKey = {};
  for (const g of team.armies) {
    if (g.moving || g.isGarrison || g.harasser || g.pursue || unitCount(g) < 0.5) continue;
    const m = g.mission || {};
    const key = g.area + '|' + (m.type || 'idle') + '|' + (m.targetArea || '');
    (byKey[key] = byKey[key] || []).push(g);
  }
  for (const key in byKey) {
    const hosts = byKey[key]; if (hosts.length < 2) continue;
    hosts.sort((a, b) => unitCount(b) - unitCount(a));   // pour smaller hosts into the largest
    for (let i = 1; i < hosts.length; i++) {
      const src = hosts[i];
      for (let a = 0; a < i && unitCount(src) >= 0.5; a++) {
        const dst = hosts[a]; let room = B.MAX_UNITS_PER_AREA - unitCount(dst);
        if (room <= 0) continue;
        for (const u of C.UNITS) {
          if (room <= 0) break;
          const take = Math.min(src.units[u] || 0, Math.floor(room));
          if (take > 0) { dst.hasArmor = dst.hasArmor || src.hasArmor; room -= moveUnits(src, dst, u, take); }
        }
      }
    }
  }
  team.armies = team.armies.filter((g) => g.isGarrison || unitCount(g) >= 0.5);
}

function enforceCaps(state, team) {
  // AI armies fold redundant co-located hosts (same area, same orders, stationary) together first, so the
  // Commander AI never ends up with a swarm of 1-unit hosts. Humans may split on purpose, so skip them.
  if (team.slots && team.slots.COMMANDER && team.slots.COMMANDER.controller === C.CONTROLLER.AI) mergeCoLocated(team);
  // 1. No single host exceeds the cap — excess spills into a co-located sibling host.
  const spills = [];
  for (const g of team.armies) {
    let over = unitCount(g) - B.MAX_UNITS_PER_AREA;
    if (over <= 0.001) continue;
    const spill = newGroup(state, team, currentArea(g), g.name + ' (Rear)');
    spill.x = g.x; spill.y = g.y; spill.hasArmor = g.hasArmor;
    if (g.moving) spill.moving = { route: g.moving.route.slice(), legIndex: g.moving.legIndex, t: g.moving.t };
    if (g.mission) spill.mission = { type: (g.mission.type || 'idle'), targetArea: g.mission.targetArea };
    for (const u of C.UNITS) {
      if (over <= 0.001) break;
      const take = Math.min(g.units[u] || 0, Math.ceil(over - 0.001));
      if (take > 0) over -= moveUnits(g, spill, u, take);
    }
    if (unitCount(spill) >= 0.5) spills.push(spill);
  }
  for (const s of spills) team.armies.push(s);

  // 2. No location holds more than 20 STATIONED troops: redeploy the smallest overflow hosts off the
  //    over-full node to a SAFE friendly/neutral neighbour (they march out — never destroyed). The
  //    Home Garrison is never relocated (it must hold the Keep), and we never march overflow into
  //    enemy-held ground or the enemy base. Resolves movement races that briefly over-stack a node.
  const home = S.homeBase(team.team);
  const foe = S.enemyOf(team.team);
  const byArea = {};
  for (const g of team.armies) { if (g.moving) continue; (byArea[g.area] = byArea[g.area] || []).push(g); }
  for (const aid in byArea) {
    const hosts = byArea[aid].slice().sort((a, b) => unitCount(a) - unitCount(b));
    let total = hosts.reduce((s, h) => s + unitCount(h), 0);
    if (total <= B.MAX_UNITS_PER_AREA + 0.001) continue;
    const conns = (state.areas[aid] && state.areas[aid].connections) || [];
    // Safe destinations: our own or neutral nodes (never enemy-owned, never an enemy base), preferring
    // our own land, then the emptiest. Home is a valid fallback when it isn't the over-full node.
    const safe = conns.filter((n) => { const ar = state.areas[n]; return ar && ar.owner !== foe; })
      .sort((x, y) => {
        const ox = state.areas[x].owner === team.team ? 0 : 1, oy = state.areas[y].owner === team.team ? 0 : 1;
        if (ox !== oy) return ox - oy;
        return unitsAtArea(team, x) - unitsAtArea(team, y);
      });
    let dest = safe[0] || (aid !== home ? home : null);
    if (!dest) continue;
    for (const h of hosts) {
      if (total <= B.MAX_UNITS_PER_AREA + 0.001) break;
      if (h.isGarrison) continue;   // the Home Garrison holds the Keep — never displace it
      const route = S.findPath(state.areas, aid, dest);
      if (route && route.length >= 2) { h.moving = { route, legIndex: 0, t: 0 }; h.mission = { type: 'defend', targetArea: dest, displaced: true }; total -= unitCount(h); }
    }
  }
}
// Next thing to raze at a location: walls first, then any other building, then (at a base) the
// Watchtower (the Keep core) LAST — only once everything else has fallen.
function nextRazeTarget(area, isBase) {
  if ((area.buildings.walls || 0) > 0) return 'walls';
  for (const t of C.BUILDINGS) { if (t === 'walls' || t === 'watchtower') continue; if ((area.buildings[t] || 0) > 0) return t; }
  if (isBase && (area.buildings.watchtower || 0) > 0) return 'watchtower';
  return null;
}

// Razing: an enemy force at an owned location with NO defenders present slowly destroys its
// buildings (walls first, each worth points), then captures the site — or, at the Keep, breaks the
// Keep core to win. Siege units excel; archers are poor at it. Effective force is capped at 20.
function tickRaze(state, dt, rng, log) {
  for (const id in state.areas) {
    const area = state.areas[id];
    if (!area.owner) continue;
    const owner = area.owner, foe = S.enemyOf(owner);
    const isBase = area.terrain === 'base';
    const enemyHosts = state.teams[foe].armies.filter((g) => currentArea(g) === id && unitCount(g) >= 0.5);
    const defenderHere = state.teams[owner].armies.some((g) => currentArea(g) === id && unitCount(g) >= 0.5);
    if (!enemyHosts.length || defenderHere) {
      // Siege lifted — progress on a non-Keep capture decays; an in-progress building stays damaged.
      if (!isBase && (area.captureProgress || 0) > 0) area.captureProgress = Math.max(0, area.captureProgress - B.CAPTURE_DECAY * dt);
      continue;
    }
    // Razing power (siege >> cavalry > infantry > archers), effective force capped at 20. A catapult's
    // siege power scales with its OWN build quality (the average of the siege parts it was built from)
    // and the attacker's Siege Engineering research.
    let power = 0, total = 0;
    const siegeRes = 1 + eco.researchStat(state.teams[foe], 'siege');
    const razeTarget = nextRazeTarget(area, isBase);   // what's being razed now (walls first) — needed for the catapult wall bonus
    for (const g of enemyHosts) for (const u of C.UNITS) {
      const n = g.units[u] || 0; if (!n) continue;
      let rp = (B.RAZE_STAT[u] || 0);
      if (u === 'catapult') {
        const recs = (g.gear && g.gear[u]) || []; let q = 0, cnt = 0; for (const r of recs) { q += (r.w || 1); cnt++; } rp *= (cnt > 0 ? q / cnt : 1) * siegeRes;
        if (razeTarget === 'walls') rp *= B.CATAPULT_WALL_RAZE_BONUS;   // siege engines tear through fortifications
      }
      power += n * rp; total += n;
    }
    if (total > B.MAX_UNITS_PER_AREA) power *= B.MAX_UNITS_PER_AREA / total;
    if (power <= 0) continue;

    // While it still stands, the Watchtower (Keep core) looses arrows at besiegers — as a lone militia,
    // or harder with the defender's Fortified Tower research (fires as 2 / 3 / 5 militia).
    if (isBase && (area.buildings.watchtower || 0) > 0) {
      const towerPow = B.UNIT_STATS.militia.atk * (eco.researchStat(state.teams[owner], 'towerAtk') || 1);
      const kills = rollKills(towerPow / (towerPow + Math.max(1, total)), rng);
      if (kills > 0) {
        const tfx = new Map();
        applyKills(state.teams[foe], enemyHosts, kills, rng, tfx);
        let felled = 0; state._combatFx = state._combatFx || [];
        for (const [host, e] of tfx) { if ((e.losses || 0) + (e.saves || 0) > 0) state._combatFx.push({ x: host.x, y: host.y, team: foe, losses: e.losses || 0, saves: e.saves || 0 }); felled += e.losses || 0; }
        if (felled > 0 && log) logMil(state.teams[foe], 'The Watchtower at ' + area.name + ' felled ' + felled + ' besieger' + (felled === 1 ? '' : 's') + '.', 'combat');
      }
    }

    const target = razeTarget;
    if (!target) {
      // Non-base: all buildings razed → seize the site after a short hold.
      area.captureProgress = (area.captureProgress || 0) + dt;
      if (area.captureProgress >= B.CAPTURE_AFTER_RAZE) {
        // Taking the ground DESTROYS the outpost: the captor owns the territory but must build a brand
        // new outpost (re-claim, pay wood again) to work the site — upgrades and stored cargo are lost.
        area.owner = foe; area.claimedBy = null; area.captureProgress = 0; area._razeHp = null; area._razeTarget = null;
        area.claimFund = null; area.revealed[foe] = true;
        // Taking raw ground does NOT scout it — scouting follows outposts & scout parties, not occupation.
        // The captor must rebuild an outpost here (or scout it) to gain vision; until then it fights blind.
        area.scouted[foe] = false; area.scoutedUntil[foe] = 0;
        if (area.site) { area.site.cargo = 0; area.site.worked = false; area.site.level = 1; }
        S.recomputeBuildings(state, state.teams[owner]); S.recomputeBuildings(state, state.teams[foe]);
        log(foe, C.TEAM_META[foe].name + ' razed the outpost at ' + area.name + ' and seized the ground!', 'capture');
      }
      continue;
    }
    if (target === 'keepcore') {
      // Spec: once every building at the enemy Keep has been razed (no walls, no structures left),
      // the besieging attacker immediately wins — there are attackers here and no defenders.
      const def = state.teams[owner];
      def.keep.hp = 0;
      log(foe, C.TEAM_META[foe].name + ' has razed every building at the ' + C.TEAM_META[owner].name + ' Keep — total victory!', 'siege');
      continue;
    }
    // Damage the current target building; walls (×2) and Keep buildings (×2) take longer. An outpost's
    // WORK MODE also scales its raze HP (Defensive ×1.5 = longer, Maximum Production ×0.67 = faster).
    const wmRaze = (!isBase && area.site && B.WORK_MODES[area.site.workMode]) ? B.WORK_MODES[area.site.workMode].razeMult : 1;
    const targetHp = B.BUILDING_RAZE_HP * (target === 'walls' ? B.WALL_RAZE_MULT : 1) * (isBase ? B.KEEP_RAZE_MULT : B.OUTPOST_RAZE_MULT) * wmRaze;
    if (area._razeTarget !== target) { area._razeTarget = target; area._razeHp = targetHp; }
    area._razeHp -= power * dt;
    // The Keep's health bar reflects the Watchtower being battered down (full → 0 as it's razed).
    if (target === 'watchtower' && isBase) state.teams[owner].keep.hp = Math.max(0, state.teams[owner].keep.maxHp * (area._razeHp / targetHp));
    if (area._razeHp <= 0) {
      area.buildings[target] = Math.max(0, (area.buildings[target] || 0) - 1);
      area._razeHp = null; area._razeTarget = null;
      if (target === 'watchtower' && isBase) {
        // The Watchtower has fallen — the Keep core is destroyed: total victory.
        state.teams[owner].keep.hp = 0;
        S.recomputeBuildings(state, state.teams[owner]);
        log(foe, C.TEAM_META[foe].name + ' has razed the ' + C.TEAM_META[owner].name + ' Watchtower — total victory!', 'siege');
        continue;
      }
      const pts = isBase ? B.KEEP_RAZE_POINTS : B.RAZE_POINTS;
      state.teams[foe].razeScore = (state.teams[foe].razeScore || 0) + pts;
      S.recomputeBuildings(state, state.teams[owner]);
      const bn = B.BUILDINGS[target] ? B.BUILDINGS[target].name : target;
      log(foe, C.TEAM_META[foe].name + ' destroyed a ' + bn + ' at ' + area.name + ' (+' + pts + ' pts)', isBase ? 'siege' : 'capture');
    }
  }
}

module.exports = {
  formUnits, trainUnits, upgradeUnits, cancelTraining, tickTraining, rally, command, setFormation, setStance, tickMovement, resolveCombat, tickRaze, transferUnits,
  garrison, unitCount, currentArea, barracksAreasOf, unitsAtArea, enforceCaps, roomAt,
  moveUnits, reconcileGear, ensureGear, reequip, hostPower, removeSoldier, logMil,
};
