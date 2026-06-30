/* Simulation: advances game state each tick and applies validated player actions. */
'use strict';
const C = require('../shared/constants.js');
const B = require('../shared/balance.js');
const S = require('../shared/schema.js');
const economy = require('./systems/economy.js');
const buildings = require('./systems/buildings.js');
const production = require('./systems/production.js');
const sites = require('./systems/sites.js');
const army = require('./systems/army.js');
const comms = require('./systems/comms.js');
const events = require('./systems/events.js');
const victory = require('./systems/victory.js');
const ai = require('./systems/ai.js');
const { makeRng } = require('./rng.js');

const SYSTEMS = { economy, buildings, production, sites, army, comms, events, victory };

function makeLog(state) {
  return function log(team, text, kind) {
    state.events.push({ id: S.uid('ev'), t: Math.round(state.elapsed), team, text, kind: kind || 'info' });
    if (state.events.length > 50) state.events.shift();
  };
}

function step(state) {
  if (state.status !== 'playing') return;
  const dt = B.TICK_MS / 1000;
  const rng = makeRng((state.seed + state.tick * 2654435761) >>> 0);
  const log = makeLog(state);
  state.tick += 1;
  state.elapsed = Math.min(state.matchLength, state.elapsed + dt);
  economy.updatePhase(state);

  // Alternate which team is processed first each tick — otherwise the same team always acts first
  // every tick (claiming, attacking, reacting before the other), a systematic edge the aggressive AI
  // amplifies into a lopsided win rate. Alternating keeps the simulation fair between equal AIs.
  const order = (state.tick % 2 === 0) ? [state.teams.BLUE, state.teams.RED] : [state.teams.RED, state.teams.BLUE];

  for (const team of order) {
    S.recomputeBuildings(state, team);
    economy.pruneHolds(state, team);
    economy.tickEconomy(state, team, dt, log);
    buildings.tickBuildings(state, team, dt, log);
    production.tickProduction(team, dt, log);
    sites.tickSites(state, team, dt, rng, log);
    army.tickMovement(state, team, dt);
    army.tickTraining(state, team, dt);
    comms.tickComms(state, team, dt);
  }
  army.resolveCombat(state, dt, rng, log);
  army.tickRaze(state, dt, rng, log);
  events.tickEvents(state, rng, log);

  for (const team of order) {
    try { ai.aiTick(state, team, dt, SYSTEMS, rng); } catch (e) {}
  }
  for (const team of [state.teams.BLUE, state.teams.RED]) {
    army.enforceCaps(state, team);
    economy.reconcileGearInv(team);   // keep forged-item inventory consistent with counts
    army.reconcileGear(team);         // keep each soldier's gear record consistent with unit counts
  }

  victory.update(state);
  const result = victory.checkVictory(state);
  if (result) { log(result.winner, '★ ' + C.TEAM_META[result.winner].name + ' wins — ' + result.reason, 'victory'); }
  return result;
}

// role/team identify the actor; action+payload describe intent. Returns {ok,msg|reason}.
function applyAction(state, team, role, action, payload) {
  payload = payload || {};
  const log = makeLog(state);
  const T = state.teams[team];
  if (!T) return { ok: false, reason: 'No team.' };

  // Cross-role social actions: any role may use.
  switch (action) {
    case 'chat': comms.postChat(state, T, role, String(payload.text || '').slice(0, 160), 'chat'); return { ok: true };
    case 'request': {
      if (!C.REQUEST_TYPES[payload.type]) return { ok: false, reason: 'Unknown request.' };
      const p = payload.payload || {};
      let target = payload.targetRole;
      if (!target) {
        if (payload.type === 'NEED') {
          const list = C.RESOURCE_SUPPLIERS[p.resource] || ['LORD'];
          target = list.find((r) => r !== role) || null;   // never route a resource ask back to yourself
        } else if (payload.type === 'USE' || payload.type === 'RESERVE') {
          target = 'LORD';                                  // access to / reservation of a resource
        } else {
          target = defaultTarget(payload.type);
        }
      }
      // Never create a self-addressed request; broadcast it to the council instead.
      if (!target || target === role) {
        comms.postChat(state, T, role, broadcastText(payload.type, p), 'request');
        return { ok: true, msg: 'Broadcast to your council.' };
      }
      comms.createRequest(state, T, role, target, payload.type, p);
      return { ok: true };
    }
    case 'resolveRequest': return comms.resolveRequest(state, T, payload.id, !!payload.accept, SYSTEMS, role);
    case 'cancelRequest': {
      const r = T.requests.find((x) => x.id === payload.id && x.fromRole === role && x.status === 'open');
      if (!r) return { ok: false, reason: 'No open request to cancel.' };
      r.status = 'cancelled';
      comms.postChat(state, T, role, 'Never mind — cancelling my request.', 'response');
      return { ok: true };
    }
    // A teammate may release a resource reservation THEY own (one the Lord reserved for them via a
    // RESERVE request) once they no longer need it. The Lord uses the Lord-only 'releaseHold' instead.
    case 'releaseOwnHold': {
      const k = payload.resource;
      if (!C.RESOURCES.includes(k)) return { ok: false, reason: 'Unknown resource.' };
      const h = T.holds && T.holds[k];
      if (!h || typeof h !== 'object') return { ok: false, reason: 'That resource is not reserved.' };
      if (h.owner !== role) return { ok: false, reason: 'Only the player who reserved it (or the Lord) can release it.' };
      economy.releaseHold(T, k);
      comms.postChat(state, T, role, '🔓 Releasing my reservation on ' + (C.RESOURCE_META[k] ? C.RESOURCE_META[k].glyph + ' ' : '') + k + ' — spend freely.', 'response');
      return { ok: true, msg: 'Released your reservation on ' + k + '.' };
    }
  }

  // Role-gated actions. Worker allocation is shared: the Lord owns it, but the Steward may help
  // unless the Lord has locked it.
  const need = ACTION_ROLE[action];
  if (!need) return { ok: false, reason: 'Unknown action.' };
  const sharedWorker = (action === 'assignWorker' || action === 'setWorkers') && role === 'STEWARD';
  if (need !== role && !sharedWorker) return { ok: false, reason: 'Only the ' + C.ROLE_META[need].name + ' may do that.' };
  if (sharedWorker && T.workerLock) return { ok: false, reason: 'The Lord has locked worker allocation — ask them to unlock it.' };

  // Lord rationing: GATE a role's spend of a resource the Lord reserved away from it (unless it holds
  // a one-time grant). The grant is CONSUMED by the system that actually performs the spend (so a
  // deferred spend like forging/training doesn't burn the pass at queue time), not here.
  if (role !== 'LORD') {
    const keys = spendKeysFor(action, payload);
    const blocked = keys.filter((k) => economy.blockedFor(T, k, role, state.elapsed));
    if (blocked.length) {
      const k = blocked[0];
      return { ok: false, reason: (C.RESOURCE_META[k] ? C.RESOURCE_META[k].name : k) + ' is reserved by the Lord — ask to access it (or to reserve it for yourself).' };
    }
  }

  switch (action) {
    // Lord
    case 'setWorkers': return economy.setWorkers(state, T, payload);
    case 'assignWorker': return economy.adjustWorker(state, T, payload.job, payload.delta);
    case 'setResearchers': return economy.setResearchers(state, T, payload.delta);
    case 'buyResearch': return economy.buyResearch(state, T, payload.key);
    case 'levy': return economy.levy(T, payload.count);
    case 'build': return buildings.queueBuilding(state, T, payload.areaId, payload.type);
    case 'cancelBuild': return buildings.cancelBuilding(state, T, payload.id);
    case 'demolish': return buildings.demolishBuilding(state, T, payload.areaId, payload.type, log);
    case 'setPolicy': {
      if (!B.POLICIES[payload.policy]) return { ok: false, reason: 'Unknown policy.' };
      if (payload.policy === T.policy) return { ok: false, reason: 'That policy is already active.' };
      if (T.policy && (T.policyCooldownUntil || 0) > state.elapsed) {
        const left = Math.ceil(T.policyCooldownUntil - state.elapsed);
        return { ok: false, reason: 'Policy change on cooldown (' + Math.floor(left / 60) + ':' + String(left % 60).padStart(2, '0') + ' left).' };
      }
      T.policy = payload.policy;
      T.policyCooldownUntil = state.elapsed + 180;   // 3-minute cooldown before the next change
      return { ok: true, msg: 'Policy set: ' + B.POLICIES[payload.policy].name + '.' };
    }
    case 'setMilitaryPolicy': {
      if (!B.MILITARY_POLICIES[payload.policy]) return { ok: false, reason: 'Unknown military stance.' };
      if (payload.policy === T.militaryPolicy) return { ok: false, reason: 'That stance is already active.' };
      if ((T.militaryPolicyCooldownUntil || 0) > state.elapsed) {
        const left = Math.ceil(T.militaryPolicyCooldownUntil - state.elapsed);
        return { ok: false, reason: 'Military stance on cooldown (' + Math.floor(left / 60) + ':' + String(left % 60).padStart(2, '0') + ' left).' };
      }
      T.militaryPolicy = payload.policy;
      T.militaryPolicyCooldownUntil = state.elapsed + 180;   // 3-minute cooldown
      comms.postChat(state, T, 'LORD', '⚔️ Military stance: ' + B.MILITARY_POLICIES[payload.policy].name + ' — ' + B.MILITARY_POLICIES[payload.policy].desc, 'request');
      return { ok: true, msg: 'Military stance set: ' + B.MILITARY_POLICIES[payload.policy].name + '.' };
    }
    case 'setHold': {
      if (!C.RESOURCES.includes(payload.resource)) return { ok: false, reason: 'Unknown resource.' };
      const allow = Array.isArray(payload.allow) ? payload.allow.filter((r) => C.ROLE_ORDER.includes(r) && r !== 'LORD') : [];
      economy.setHold(state, T, payload.resource, payload.duration || 0, allow);
      const who = allow.length ? ' (also: ' + allow.map((r) => C.ROLE_META[r].name).join(', ') + ')' : ' (only me)';
      comms.postChat(state, T, 'LORD', '🔒 Reserving ' + (C.RESOURCE_META[payload.resource].glyph) + ' ' + payload.resource + who + (payload.duration ? ' for ' + payload.duration + 's' : '') + '.', 'request');
      return { ok: true, msg: 'Reserving ' + payload.resource + who + '.' };
    }
    case 'setResourceAccess': {
      if (!C.RESOURCES.includes(payload.resource)) return { ok: false, reason: 'Unknown resource.' };
      const k = payload.resource;
      const role = payload.role;
      if (!['STEWARD', 'BLACKSMITH', 'COMMANDER'].includes(role)) return { ok: false, reason: 'Unknown role.' };
      // Start from the current permission set. With no active reservation, every role is allowed.
      const active = economy.isHeld(state, T, k);
      const cur = economy.holdAllow(T, k);
      let allow = active ? ['STEWARD', 'BLACKSMITH', 'COMMANDER'].filter((r) => cur[r]) : ['STEWARD', 'BLACKSMITH', 'COMMANDER'].slice();
      const idx = allow.indexOf(role);
      if (payload.allowed) { if (idx < 0) allow.push(role); } else { if (idx >= 0) allow.splice(idx, 1); }
      // If every role is allowed there's no restriction left — free it for all.
      if (allow.length >= 3) { economy.releaseHold(T, k); return { ok: true, msg: k + ' is free for all.' }; }
      // Preserve the reservation's remaining duration (indefinite if none).
      const h = T.holds && T.holds[k];
      const remain = (h && typeof h === 'object' && h.until > 0) ? Math.max(1, Math.round(h.until - state.elapsed)) : 0;
      economy.setHold(state, T, k, remain, allow);
      return { ok: true, msg: (payload.allowed ? 'Granted ' : 'Revoked ') + C.ROLE_META[role].name + ' access to ' + k + '.' };
    }
    case 'releaseHold': {
      economy.releaseHold(T, payload.resource);
      comms.postChat(state, T, 'LORD', '🔓 Released ' + (C.RESOURCE_META[payload.resource] ? C.RESOURCE_META[payload.resource].glyph + ' ' : '') + payload.resource + ' — spend freely.', 'response');
      return { ok: true, msg: 'Released ' + payload.resource + '.' };
    }
    case 'setWorkerLock': {
      T.workerLock = !!payload.locked;
      comms.postChat(state, T, 'LORD', T.workerLock ? '🔒 I will manage the workforce myself.' : '🔓 Steward, you may help assign workers.', 'request');
      return { ok: true, msg: T.workerLock ? 'Worker allocation locked to the Lord.' : 'Steward may assign workers.' };
    }
    // Steward
    case 'explore': return sites.explore(state, T, payload.areaId);
    case 'claim': return sites.claim(state, T, payload.areaId);
    case 'upgradeSite': return sites.upgradeSite(state, T, payload.areaId);
    case 'abandon': return sites.abandon(state, T, payload.areaId);
    case 'setGatherTools': return economy.setGatherTools(state, T, payload.pool, payload.delta);
    case 'setMineFocus': return economy.setMineFocus(state, T, payload.value);
    case 'setDangerWork': return economy.setDangerWork(state, T, payload.pool, payload.on);
    case 'setScouts': return economy.setScouts(state, T, payload.delta);
    case 'setWorkMode': return sites.setWorkMode(state, T, payload.areaId, payload.mode);
    case 'setCaravanMode': return sites.setCaravanMode(state, T, payload.areaId, payload.mode);
    case 'dispatchCaravan': return sites.dispatchCaravan(state, T, payload.areaId, log);
    case 'setGuards': return sites.setGuards(state, T, payload.areaId, payload.count);
    case 'startExpedition': return sites.startExpedition(state, T, payload.id, payload.useTools);
    case 'doStewardAction': { const r = economy.doStewardAction(state, T, payload.id); if (r.ok) comms.postChat(state, T, 'STEWARD', r.msg, 'request'); return r; }
    case 'setStewardPolicy': { const r = economy.setStewardPolicy(state, T, payload.key || null); if (r.ok) comms.postChat(state, T, 'STEWARD', r.msg, 'request'); return r; }
    case 'marketTrade': return economy.marketTrade(state, T, payload.from, payload.to);
    case 'supervise': return economy.supervise(state, T, payload.resource, payload.index);
    case 'requestConserve': {
      const res = payload.resource;
      if (!C.RESOURCES.includes(res)) return { ok: false, reason: 'Unknown resource.' };
      const dur = Math.max(15, Math.min(180, Math.round(Number(payload.duration) || 60)));
      T.conserve = T.conserve || {};
      T.conserve[res] = state.elapsed + dur;
      const m = C.RESOURCE_META[res];
      comms.postChat(state, T, 'STEWARD', '🙏 Council, please CONSERVE ' + (m ? m.glyph + ' ' + res : res) + ' for ' + dur + 's — I need it for our outposts.', 'request');
      return { ok: true, msg: 'Asked the council to conserve ' + res + ' for ' + dur + 's.' };
    }
    // Blacksmith
    case 'produce': {
      // Quality from the Blacksmith's forging minigame (qPct = score / perfect score).
      let qMult = 1, qId = 'standard';
      if (typeof payload.qPct === 'number') {
        let qPct = Math.max(0, Math.min(1, payload.qPct));
        // Specialist's touch: a sub-par strike on your SPECIALISED item is lifted +10% (only when the
        // raw score came in under the threshold — it rescues rushed work, doesn't gild great strikes).
        if (T.blacksmithSpec === payload.item && qPct < B.SPEC_QUALITY_THRESHOLD) qPct = Math.min(1, qPct + B.SPEC_QUALITY_BONUS);
        const tier = B.qualityTier(qPct); qMult = tier.mult; qId = tier.id;
      }
      return production.queueProduction(T, payload.item, payload.qty, qMult, qId);
    }
    case 'cancelProduce': return production.cancelProduction(T, payload.id);
    case 'startContract': return production.startContract(T, payload.id);
    case 'setSpec': {
      if (!B.BLACKSMITH_SPECS[payload.spec]) return { ok: false, reason: 'Unknown specialization.' };
      if (payload.spec === T.blacksmithSpec) return { ok: false, reason: 'That forge focus is already active.' };
      if (T.blacksmithSpec && (T.blacksmithSpecCooldownUntil || 0) > state.elapsed) {
        const left = Math.ceil(T.blacksmithSpecCooldownUntil - state.elapsed);
        return { ok: false, reason: 'Forge focus change on cooldown (' + Math.floor(left / 60) + ':' + String(left % 60).padStart(2, '0') + ' left).' };
      }
      const r = production.setSpec(T, payload.spec);
      if (r.ok) T.blacksmithSpecCooldownUntil = state.elapsed + 180;   // 3-minute cooldown before the next change
      return r;
    }
    // Commander
    case 'formUnits': return army.formUnits(state, T, payload.unitType, payload.count);
    case 'trainUnits': return army.trainUnits(state, T, payload.area, payload.unitType, payload.count);
    case 'upgradeUnits': return army.upgradeUnits(state, T, payload.area, payload.unitType, payload.count);
    case 'reequip': return army.reequip(state, T, payload.groupId);
    case 'cancelTraining': return army.cancelTraining(T, payload.id);
    case 'rally': return army.rally(state, T, payload.units || {}, payload.name);
    case 'transferUnits': return army.transferUnits(state, T, payload.fromId, payload.toId, payload.units || {}, payload.name);
    case 'command': return army.command(state, T, payload.groupId, payload.mission, payload.targetArea);
    case 'setFormation': return army.setFormation(T, payload.groupId, payload.formation);
    case 'setStance': return army.setStance(T, payload.groupId, payload.stance);
    case 'setDoctrine': {
      if (!B.DOCTRINES[payload.doctrine]) return { ok: false, reason: 'Unknown doctrine.' };
      if (payload.doctrine === T.doctrine) return { ok: false, reason: 'That doctrine is already active.' };
      if (T.doctrine && (T.doctrineCooldownUntil || 0) > state.elapsed) {
        const left = Math.ceil(T.doctrineCooldownUntil - state.elapsed);
        return { ok: false, reason: 'Doctrine change on cooldown (' + Math.floor(left / 60) + ':' + String(left % 60).padStart(2, '0') + ' left).' };
      }
      T.doctrine = payload.doctrine;
      T.doctrineCooldownUntil = state.elapsed + 180;   // 3-minute cooldown before the next change
      return { ok: true, msg: 'Doctrine set: ' + B.DOCTRINES[payload.doctrine].name + '.' };
    }
    default: return { ok: false, reason: 'Unhandled action.' };
  }
}

const ACTION_ROLE = {
  setWorkers: 'LORD', assignWorker: 'LORD', levy: 'LORD', build: 'LORD', cancelBuild: 'LORD', demolish: 'LORD', setPolicy: 'LORD', setMilitaryPolicy: 'LORD', setHold: 'LORD', setResourceAccess: 'LORD', releaseHold: 'LORD', setWorkerLock: 'LORD', setResearchers: 'LORD', buyResearch: 'LORD',
  explore: 'STEWARD', claim: 'STEWARD', upgradeSite: 'STEWARD', abandon: 'STEWARD', setGatherTools: 'STEWARD', setMineFocus: 'STEWARD', requestConserve: 'STEWARD', setWorkMode: 'STEWARD', setCaravanMode: 'STEWARD', dispatchCaravan: 'STEWARD', setGuards: 'STEWARD', startExpedition: 'STEWARD', setDangerWork: 'STEWARD', setScouts: 'STEWARD', doStewardAction: 'STEWARD', setStewardPolicy: 'STEWARD', marketTrade: 'STEWARD', supervise: 'STEWARD',
  produce: 'BLACKSMITH', cancelProduce: 'BLACKSMITH', startContract: 'BLACKSMITH', setSpec: 'BLACKSMITH',
  formUnits: 'COMMANDER', trainUnits: 'COMMANDER', upgradeUnits: 'COMMANDER', reequip: 'COMMANDER', cancelTraining: 'COMMANDER', rally: 'COMMANDER', transferUnits: 'COMMANDER', command: 'COMMANDER', setFormation: 'COMMANDER', setStance: 'COMMANDER', setDoctrine: 'COMMANDER',
};
// Resource keys a non-Lord action would spend (for rationing enforcement).
function spendKeysFor(action, payload) {
  // Forging is a DEFERRED spend: it self-gates inside produceOne and PAUSES while a required input is
  // reserved, instead of being rejected at queue time (so the Blacksmith's minigame result is never
  // wasted). So 'produce' is intentionally NOT gate-blocked here.
  if (action === 'produce') return [];
  if (action === 'claim') return Object.keys(B.CLAIM_COST);
  if (action === 'upgradeSite') return Object.keys(B.SITE_UPGRADE_COST);
  if (action === 'doStewardAction') { const a = B.STEWARD_ACTIONS_BY_ID[payload && payload.id]; return a ? Object.keys(a.cost || {}) : []; }
  if (action === 'marketTrade') return (payload && payload.from) ? [payload.from] : [];
  if (action === 'formUnits' || action === 'trainUnits') {
    const needs = (C.UNIT_META[payload.unitType] && C.UNIT_META[payload.unitType].needs) || {};
    return Object.keys(needs).filter((k) => C.RESOURCES.includes(k));
  }
  return [];
}
function defaultTarget(type) {
  return ({ ESCORT: 'COMMANDER', GUARDS: 'COMMANDER', WORKERS: 'LORD', IRON: 'STEWARD', EQUIPMENT: 'BLACKSMITH', RECRUITS: 'LORD', TRAINERS: 'LORD', DEFEND: 'COMMANDER', TRAIN: 'COMMANDER', MISSION: 'COMMANDER', SITE: 'STEWARD', BUILD: 'LORD', RESERVE: 'LORD', MINEFOCUS: 'STEWARD', FORGESPEED: 'STEWARD' })[type] || 'LORD';
}
function broadcastText(type, p) {
  if (type === 'NEED' && p && p.resource) { const m = C.RESOURCE_META[p.resource]; return 'We could use more ' + (m ? m.glyph + ' ' + p.resource : p.resource) + '.'; }
  if (type === 'USE' && p && p.resource) { const m = C.RESOURCE_META[p.resource]; return 'Requesting use of ' + (m ? m.glyph + ' ' + p.resource : p.resource) + '.'; }
  if (type === 'BUILD' && p && p.type) { return 'We should build a ' + (B.BUILDINGS[p.type] ? B.BUILDINGS[p.type].name : p.type) + '.'; }
  return ({ ESCORT: 'We need an escort.', GUARDS: 'We need guards for our caravans.', WORKERS: 'We could use more workers.', IRON: 'We need more iron.', EQUIPMENT: 'We need weapons forged.', RECRUITS: 'We need more recruits.', DEFEND: 'We need defenders.', TRAIN: 'We should train more troops.', MISSION: 'Take the fight to the enemy.', SITE: 'We should expand our territory.', BUILD: 'We should build more.', FORGESPEED: 'We should speed up the forge.' })[type] || 'Request to the council.';
}

// Snapshot: strip a few server-only scratch fields to keep payloads tidy.
function snapshot(state) {
  const t = state.teams;
  const clean = (team) => {
    const c = Object.assign({}, team); delete c.aiState; delete c.superviseJob; delete c._superviseWallAt; delete c._superviseWindow;
    // Attach a baseline attack/defence readout to each host (display only).
    c.armies = (team.armies || []).map((g) => Object.assign({}, g, { power: army.hostPower(team, g) }));
    return c;
  };
  return {
    roomCode: state.roomCode, status: state.status, devMode: state.devMode,
    tick: state.tick, elapsed: state.elapsed, matchLength: state.matchLength, phase: state.phase,
    winner: state.winner, winReason: state.winReason,
    areas: state.areas,
    teams: { BLUE: clean(t.BLUE), RED: clean(t.RED) },
    events: state.events,
    combatFx: state._combatFx || [],
    pause: state.pause,
    surrender: state.surrender || null,
  };
}

module.exports = { step, applyAction, snapshot, SYSTEMS };
