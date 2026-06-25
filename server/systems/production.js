/* Production (Blacksmith): forge queue, equipment/arrows, contracts, specialization. */
'use strict';
const B = require('../../shared/balance.js');
const S = require('../../shared/schema.js');
const eco = require('./economy.js');

function forgeSpeedMult(team, item) {
  let m = 1 + team.buildings.workshop * B.BUILDINGS.workshop.effect.forgeSpeed;
  const pol = eco.policy(team);
  if (pol && pol.forgeMult) m *= pol.forgeMult;
  const spec = team.blacksmithSpec ? B.BLACKSMITH_SPECS[team.blacksmithSpec] : null;
  if (spec && spec.item === item) m *= 1 / (1 - B.SPEC_TIME_REDUCTION);  // chosen specialty forges 10% faster
  return m;
}

function queueProduction(team, item, qty, qMult, qId) {
  const recipe = B.RECIPES[item];
  if (!recipe) return { ok: false, reason: 'Unknown item.' };
  if (recipe.needs === 'siege' && team.buildings.workshop <= 0) return { ok: false, reason: 'Build a Workshop first.' };
  const held = eco.heldCostForRole(team, 'BLACKSMITH', recipe.cost);
  if (held) return { ok: false, reason: held.charAt(0).toUpperCase() + held.slice(1) + ' is reserved by the Lord. Ask to access it.' };
  qty = Math.max(1, Math.min(99, Math.floor(qty || recipe.batch)));
  team.production.push({ id: S.uid('pq'), item, qtyLeft: qty, remaining: recipe.time, qMult: qMult || 1, qId: qId || 'standard' });
  return { ok: true, msg: 'Forging ' + qty + ' ' + item + '.' };
}

function cancelProduction(team, id) {
  const idx = team.production.findIndex((q) => q.id === id);
  if (idx < 0) return { ok: false, reason: 'Not forging that.' };
  team.production.splice(idx, 1);
  return { ok: true };
}

function startContract(team, id) {
  if (team.contract) return { ok: false, reason: 'Finish the current contract first.' };
  if (team.contractCooldown > 0) return { ok: false, reason: 'Contracts on cooldown.' };
  const def = B.CONTRACTS.find((c) => c.id === id);
  if (!def) return { ok: false, reason: 'Unknown contract.' };
  const goalItem = Object.keys(def.goal)[0];
  team.contract = { id: def.id, name: def.name, goalItem, goalQty: def.goal[goalItem], progress: 0, timeLeft: def.time, reward: def.reward };
  return { ok: true, msg: 'Contract started: ' + def.name + '.' };
}

function setSpec(team, spec) {
  if (!B.BLACKSMITH_SPECS[spec]) return { ok: false, reason: 'Unknown specialization.' };
  team.blacksmithSpec = spec;
  return { ok: true, msg: 'Specialization: ' + B.BLACKSMITH_SPECS[spec].name + '.' };
}

function produceOne(team, item, log, qMult, qId) {
  const recipe = B.RECIPES[item];
  if (eco.heldCostForRole(team, 'BLACKSMITH', recipe.cost)) return false;   // a reserved input pauses the forge
  if (!eco.canAfford(team, recipe.cost)) return false;
  eco.spendFor(team, recipe.cost, 'BLACKSMITH', 'forging ' + item);
  const oldN = recipe.isResource ? (team.resources[item] || 0) : (team.equipment[item] || 0);
  if (recipe.isResource) {
    team.resources[item] = Math.min(team.storageCap, oldN + 1);
  } else {
    eco.addGear(team, item, qMult || 1);   // store the individual forged item with its own quality
  }
  // Blend this item's quality into the stockpile's running-average quality multiplier (for display).
  team.equipQuality = team.equipQuality || {};
  const oldQ = team.equipQuality[item] || 1;
  team.equipQuality[item] = (oldN * oldQ + (qMult || 1)) / (oldN + 1);
  // Contract progress.
  if (team.contract && team.contract.goalItem === item) {
    team.contract.progress += 1;
  }
  return true;
}

function tickProduction(team, dt, log) {
  // Forge queue: advance the first item, pay per unit on completion.
  if (team.production.length) {
    const job = team.production[0];
    const speed = forgeSpeedMult(team, job.item);
    job.remaining -= speed * dt;
    let guard = 0;
    while (job.remaining <= 0 && job.qtyLeft > 0 && guard < 20) {
      guard++;
      if (!produceOne(team, job.item, log, job.qMult, job.qId)) { job.remaining = 0.5; break; } // stalled: cannot afford
      job.qtyLeft -= 1;
      job.remaining += B.RECIPES[job.item].time;
    }
    if (job.qtyLeft <= 0) {
      team.production.shift();
      // Record the finished batch's quality for the Forge UI.
      team.qualityLog = team.qualityLog || [];
      const tier = B.qualityById(job.qId || 'standard');
      team.qualityLog.unshift({ item: job.item, qId: tier.id, name: tier.name, glyph: tier.glyph });
      if (team.qualityLog.length > 6) team.qualityLog.length = 6;
    }
  }
  // Contracts.
  if (team.contract) {
    team.contract.timeLeft -= dt;
    if (team.contract.progress >= team.contract.goalQty) {
      eco.refund(team, team.contract.reward);
      if (log) log(team.team, 'Contract complete: ' + team.contract.name + '!', 'forge');
      team.contract = null;
      team.contractCooldown = 20;
    } else if (team.contract.timeLeft <= 0) {
      if (log) log(team.team, 'Contract failed: ' + team.contract.name + '.', 'forge');
      team.contract = null;
      team.contractCooldown = 25;
    }
  } else if (team.contractCooldown > 0) {
    team.contractCooldown = Math.max(0, team.contractCooldown - dt);
  }
}

module.exports = { queueProduction, cancelProduction, startContract, setSpec, tickProduction, forgeSpeedMult };
