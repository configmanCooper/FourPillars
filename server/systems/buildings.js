/* Buildings: per-location construction with limited build slots per area. */
'use strict';
const B = require('../../shared/balance.js');
const S = require('../../shared/schema.js');
const eco = require('./economy.js');

function slotsUsed(area, team) {
  let n = S.buildingsAt(area);
  for (const q of team.buildQueue) if (q.areaId === area.id) n++;
  return n;
}

function canBuildAt(state, team, areaId) {
  const area = state.areas[areaId];
  if (!area) return { ok: false, reason: 'Unknown location.' };
  if (area.owner !== team.team) return { ok: false, reason: 'You must own this location to build here.' };
  // You may only build on a WORKING outpost (or the Keep). Seizing ground by razing an enemy outpost leaves it
  // owned but UN-claimed (no outpost) — you must re-claim/rebuild the outpost first. Without this, a captor
  // could raise buildings on bare seized ground, producing the "owner, buildings, but no outpost" anomaly.
  if (area.terrain !== 'base' && area.claimedBy !== team.team) return { ok: false, reason: 'Re-claim this outpost (rebuild it) before raising buildings here.' };
  if (slotsUsed(area, team) >= area.maxBuildings) return { ok: false, reason: area.name + ' is full (' + area.maxBuildings + ' build slots).' };
  return { ok: true, area };
}

// Effective construction cost after the Thrifty Builders Stewardship policy (−20% etc.), clamped sane.
function effectiveBuildCost(team, type) {
  const base = (B.BUILDINGS[type] && B.BUILDINGS[type].cost) || {};
  const mult = Math.max(0.1, 1 + eco.stewardStat(team, 'buildCost'));
  const out = {};
  for (const k in base) out[k] = Math.max(0, Math.round(base[k] * mult));
  return out;
}

function queueBuilding(state, team, areaId, type) {
  const def = B.BUILDINGS[type];
  if (!def) return { ok: false, reason: 'Unknown building.' };
  if (def.fixed) return { ok: false, reason: 'The ' + def.name + ' cannot be built or replaced.' };   // e.g. the Watchtower
  // Team-wide per-type cap (built across all owned areas + already queued).
  const cap = B.MAX_PER_BUILDING[type];
  if (cap != null) {
    const built = (team.buildings && team.buildings[type]) || 0;
    let queued = 0; for (const q of team.buildQueue) if (q.type === type) queued++;
    if (built + queued >= cap) return { ok: false, reason: 'At the limit of ' + cap + ' ' + def.name + (cap === 1 ? '' : 's') + '.' };
  }
  // Default to the Keep if no/invalid location given.
  if (!areaId || !state.areas[areaId]) areaId = S.homeBase(team.team);
  const chk = canBuildAt(state, team, areaId);
  if (!chk.ok) return chk;
  const cost = effectiveBuildCost(team, type);
  if (!eco.canAfford(team, cost)) return { ok: false, reason: 'Not enough resources for ' + def.name + '.' };
  eco.spendFor(team, cost, 'LORD', 'building ' + def.name + ' at ' + chk.area.name);
  const pol = eco.policy(team);
  const speed = ((pol && pol.buildMult) ? pol.buildMult : 1) * (1 + eco.stewardStat(team, 'buildSpeed'));   // Industry policy + Corvée Labour
  team.buildQueue.push({ id: S.uid('bq'), type, areaId, remaining: def.buildTime / speed, total: def.buildTime / speed, paidCost: cost });
  return { ok: true, msg: 'Queued ' + def.name + ' at ' + chk.area.name + '.' };
}

function cancelBuilding(state, team, id) {
  const idx = team.buildQueue.findIndex((q) => q.id === id);
  if (idx < 0) return { ok: false, reason: 'Not in queue.' };
  const q = team.buildQueue[idx];
  eco.refund(team, q.paidCost || B.BUILDINGS[q.type].cost);   // refund exactly what was paid (discounts included)
  team.buildQueue.splice(idx, 1);
  return { ok: true };
}

// Lord demolishes a COMPLETED building they own: frees its build slot and refunds DEMOLISH_REFUND (25%) of
// the building's base cost. Used to repurpose a slot in a pinch (e.g. raze a low-value building at the
// Keep — which the Watchtower defends — to drop in a Farm during a famine). The Watchtower can't be razed.
function demolishBuilding(state, team, areaId, type, log) {
  const area = state.areas[areaId];
  if (!area) return { ok: false, reason: 'Unknown location.' };
  if (area.owner !== team.team) return { ok: false, reason: 'You must own this location.' };
  const def = B.BUILDINGS[type];
  if (!def) return { ok: false, reason: 'Unknown building.' };
  if (def.fixed) return { ok: false, reason: 'The ' + def.name + ' cannot be demolished.' };
  if (!area.buildings || (area.buildings[type] || 0) <= 0) return { ok: false, reason: 'No ' + def.name + ' to demolish here.' };
  // Reverse any Keep hardening this building granted (Walls at the Keep raise Keep HP/def).
  const eff = def.effect || {};
  if (area.terrain === 'base') {
    if (eff.keepHp) { team.keep.maxHp = Math.max(1, team.keep.maxHp - eff.keepHp); team.keep.hp = Math.min(team.keep.hp, team.keep.maxHp); }
    if (eff.keepDef) { team.keep.def = Math.max(0, team.keep.def - eff.keepDef); }
  }
  area.buildings[type] -= 1;
  if (area.buildings[type] <= 0) delete area.buildings[type];
  const refund = {}; const cost = def.cost || {};
  for (const k in cost) { const v = Math.floor((cost[k] || 0) * B.DEMOLISH_REFUND); if (v > 0) refund[k] = v; }
  eco.refund(team, refund);
  S.recomputeBuildings(state, team);
  eco.recomputeDerived(team);
  if (log) log(team.team, 'Demolished ' + def.name + ' at ' + area.name + ' (slot freed, +25% resources).', 'build');
  return { ok: true, msg: 'Demolished ' + def.name + ' — slot freed, resources partly refunded.', refund };
}

function applyEffect(state, team, item, log) {
  const type = item.type; const eff = B.BUILDINGS[type].effect || {};
  const area = state.areas[item.areaId] || state.areas[S.homeBase(team.team)];
  area.buildings[type] = (area.buildings[type] || 0) + 1;
  // Walls fortify their location; at the Keep they harden the Keep itself.
  if (area.terrain === 'base' && (eff.keepHp || eff.keepDef)) {
    if (eff.keepHp) { team.keep.maxHp += eff.keepHp; team.keep.hp += eff.keepHp; }
    if (eff.keepDef) { team.keep.def += eff.keepDef; }
  }
  S.recomputeBuildings(state, team);
  eco.recomputeDerived(team);
  if (log) log(team.team, B.BUILDINGS[type].name + ' completed at ' + area.name + '.', 'build');
}

function tickBuildings(state, team, dt, log) {
  if (!team.buildQueue.length) return;
  const builders = Math.max(0, team.pop.builders);
  const rate = 0.4 + builders * 0.5;
  const item = team.buildQueue[0];
  item.remaining -= rate * dt;
  if (item.remaining <= 0) {
    team.buildQueue.shift();
    // Re-validate at COMPLETION: the target may have been captured/lost or its outpost un-claimed while the
    // job was in progress. A completed job must NOT drop a building onto bare seized ground (the "owner, has
    // buildings, but Outpost: unclaimed" bug). If it's no longer a buildable, claimed location we own (or the
    // Keep), refund what was paid and abandon the construction.
    const area = state.areas[item.areaId];
    const def = B.BUILDINGS[item.type];
    const valid = area && def && !def.fixed && area.owner === team.team
      && (area.terrain === 'base' || area.claimedBy === team.team)
      && S.buildingsAt(area) < area.maxBuildings;
    if (!valid) {
      eco.refund(team, item.paidCost || (def && def.cost) || {});
      if (log) log(team.team, 'Construction ' + (def ? 'of the ' + def.name + ' ' : '') + 'at ' + (area ? area.name : 'a lost site') + ' was abandoned — the ground is no longer a working outpost.', 'build');
      return;
    }
    applyEffect(state, team, item, log);
  }
}

module.exports = { queueBuilding, cancelBuilding, demolishBuilding, tickBuildings, applyEffect, canBuildAt, effectiveBuildCost };
