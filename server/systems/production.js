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
  qty = Math.max(1, Math.min(99, Math.floor(qty || recipe.batch)));
  // A reserved input no longer CANCELS the forge (which would waste the Blacksmith's minigame result):
  // the job is queued and simply PAUSES until the resource is released. waitingOn drives the UI badge.
  const heldKey = eco.heldCostForRole(team, 'BLACKSMITH', recipe.cost);
  team.production.push({ id: S.uid('pq'), item, qtyLeft: qty, remaining: recipe.time, qMult: qMult || 1, qId: qId || 'standard', waitingOn: heldKey || null });
  if (heldKey) return { ok: true, msg: 'Queued ' + qty + ' ' + item + ' — forging PAUSES until ' + heldKey + ' is released.' };
  return { ok: true, msg: 'Forging ' + qty + ' ' + item + '.' };
}

function cancelProduction(team, id) {
  const idx = team.production.findIndex((q) => q.id === id);
  if (idx < 0) return { ok: false, reason: 'Not forging that.' };
  team.production.splice(idx, 1);
  return { ok: true };
}

// Refresh which contracts are on offer. Only CONTRACT_OFFER_COUNT show at once; the window advances
// through the team's shuffled pool every CONTRACT_ROTATE_SEC seconds (driven by team._elapsed, which
// economy.tickEconomy stamps each tick before production runs).
function refreshContractOffers(team) {
  const rot = (team.contractRotation && team.contractRotation.length) ? team.contractRotation : B.CONTRACTS.map((c) => c.id);
  const count = Math.min(B.CONTRACT_OFFER_COUNT, rot.length);
  const sec = B.CONTRACT_ROTATE_SEC;
  const t = team._elapsed || 0;
  const window = Math.floor(t / sec);
  const start = (window * count) % rot.length;
  const ids = []; for (let i = 0; i < count; i++) ids.push(rot[(start + i) % rot.length]);
  team.contractOffers = ids;
  team.contractOffersIn = Math.max(0, Math.ceil(sec - (t % sec)));
}

function startContract(team, id) {
  if (team.contract) return { ok: false, reason: 'Finish the current contract first.' };
  if (team.contractCooldown > 0) return { ok: false, reason: 'Contracts on cooldown.' };
  const def = B.CONTRACTS.find((c) => c.id === id);
  if (!def) return { ok: false, reason: 'Unknown contract.' };
  // Only a currently-offered contract may be taken (offers rotate every minute).
  refreshContractOffers(team);
  if (!(team.contractOffers || []).includes(id)) return { ok: false, reason: 'That contract is no longer on offer.' };
  const goals = {}; const progress = {};
  for (const k in def.goal) { goals[k] = def.goal[k]; progress[k] = 0; }
  // Keep goalItem/goalQty for back-compat (single-goal display); goals/progress drive multi-item ones.
  const firstItem = Object.keys(def.goal)[0];
  team.contract = { id: def.id, name: def.name, goals, progress, goalItem: firstItem, goalQty: def.goal[firstItem], timeLeft: def.time, reward: def.reward };
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
  // Contract progress (supports multi-item "mixed" contracts).
  if (team.contract && team.contract.goals && team.contract.goals[item] != null) {
    team.contract.progress[item] = (team.contract.progress[item] || 0) + 1;
  }
  return true;
}

function tickProduction(team, dt, log) {
  refreshContractOffers(team);
  // Forge queue: advance the first item, pay per unit on completion.
  if (team.production.length) {
    const job = team.production[0];
    // If a required input is reserved away from the Blacksmith, the job PAUSES (timer frozen) and shows
    // why, instead of being cancelled — it resumes automatically the moment the resource is released.
    const recipe = B.RECIPES[job.item];
    const heldKey = recipe ? eco.heldCostForRole(team, 'BLACKSMITH', recipe.cost) : null;
    job.waitingOn = heldKey || null;
    if (!heldKey) {
      const speed = forgeSpeedMult(team, job.item);
      job.remaining -= speed * dt;
      let guard = 0;
      while (job.remaining <= 0 && job.qtyLeft > 0 && guard < 20) {
        guard++;
        if (!produceOne(team, job.item, log, job.qMult, job.qId)) { job.remaining = 0.5; job.short = true; break; } // stalled: cannot afford
        job.short = false;
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
  }
  // Contracts.
  if (team.contract) {
    team.contract.timeLeft -= dt;
    const goals = team.contract.goals || {};
    const done = Object.keys(goals).every((k) => (team.contract.progress[k] || 0) >= goals[k]);
    if (done) {
      eco.refund(team, team.contract.reward);
      if (log) log(team.team, 'Contract complete: ' + team.contract.name + '!', 'forge');
      recordContract(team, team.contract.name, 'success');
      team.contract = null;
      team.contractCooldown = 20;
    } else if (team.contract.timeLeft <= 0) {
      if (log) log(team.team, 'Contract failed: ' + team.contract.name + '.', 'forge');
      recordContract(team, team.contract.name, 'failed');
      team.contract = null;
      team.contractCooldown = 25;
    }
  } else if (team.contractCooldown > 0) {
    team.contractCooldown = Math.max(0, team.contractCooldown - dt);
  }
}
function recordContract(team, name, result) {
  team.contractHistory = team.contractHistory || [];
  team.contractHistory.unshift({ name: name, result: result });
  if (team.contractHistory.length > 6) team.contractHistory.length = 6;
}

module.exports = { queueProduction, cancelProduction, startContract, setSpec, tickProduction, forgeSpeedMult };
