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
  if (slotsUsed(area, team) >= area.maxBuildings) return { ok: false, reason: area.name + ' is full (' + area.maxBuildings + ' build slots).' };
  return { ok: true, area };
}

function queueBuilding(state, team, areaId, type) {
  const def = B.BUILDINGS[type];
  if (!def) return { ok: false, reason: 'Unknown building.' };
  if (def.fixed) return { ok: false, reason: 'The ' + def.name + ' cannot be built or replaced.' };   // e.g. the Watchtower
  // Default to the Keep if no/invalid location given.
  if (!areaId || !state.areas[areaId]) areaId = S.homeBase(team.team);
  const chk = canBuildAt(state, team, areaId);
  if (!chk.ok) return chk;
  if (!eco.canAfford(team, def.cost)) return { ok: false, reason: 'Not enough resources for ' + def.name + '.' };
  eco.spendFor(team, def.cost, 'LORD', 'building ' + def.name + ' at ' + chk.area.name);
  const pol = eco.policy(team);
  const speed = (pol && pol.buildMult) ? pol.buildMult : 1;
  team.buildQueue.push({ id: S.uid('bq'), type, areaId, remaining: def.buildTime / speed, total: def.buildTime / speed });
  return { ok: true, msg: 'Queued ' + def.name + ' at ' + chk.area.name + '.' };
}

function cancelBuilding(state, team, id) {
  const idx = team.buildQueue.findIndex((q) => q.id === id);
  if (idx < 0) return { ok: false, reason: 'Not in queue.' };
  const q = team.buildQueue[idx];
  eco.refund(team, B.BUILDINGS[q.type].cost);
  team.buildQueue.splice(idx, 1);
  return { ok: true };
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
    applyEffect(state, team, item, log);
  }
}

module.exports = { queueBuilding, cancelBuilding, tickBuildings, applyEffect, canBuildAt };
