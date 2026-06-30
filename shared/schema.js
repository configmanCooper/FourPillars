/* Four Pillars of the Realm — world map + game-state factory (UMD). */
(function (root, factory) {
  const C = (typeof require !== 'undefined') ? require('./constants.js') : window.FP.Constants;
  const B = (typeof require !== 'undefined') ? require('./balance.js') : window.FP.Balance;
  const mod = factory(C, B);
  if (typeof module !== 'undefined' && module.exports) module.exports = mod;
  if (typeof window !== 'undefined') window.FP = Object.assign(window.FP || {}, { Schema: mod });
})(this, function (C, B) {
  'use strict';

  // World is 1600 x 1000. Blue base left, Red base right. Sites in between.
  const MAP_AREAS = [
    { id: 'blue_base',   name: 'Blue Keep',     terrain: 'base',     x: 140,  y: 500, resource: null,    owner: 'BLUE' },
    { id: 'north_forest',name: 'North Forest',  terrain: 'forest',   x: 420,  y: 235, resource: 'wood' },
    { id: 'south_forest',name: 'South Farmland', terrain: 'farmland', x: 420,  y: 765, resource: 'food' },
    { id: 'west_quarry', name: 'West Quarry',   terrain: 'hills',    x: 430,  y: 500, resource: 'stone' },
    { id: 'east_quarry', name: 'East Quarry',   terrain: 'hills',    x: 1170, y: 500, resource: 'stone' },
    { id: 'central_mine',name: 'Central Mine',  terrain: 'mountain', x: 800,  y: 500, resource: 'iron' },
    { id: 'horse_plains',name: 'Horse Plains',  terrain: 'plains',   x: 800,  y: 770, resource: 'horses' },
    { id: 'east_woods',  name: 'East Woods',    terrain: 'forest',   x: 1180, y: 235, resource: 'wood' },
    { id: 'ancient_ruins',name:'Ancient Ruins', terrain: 'ruins',    x: 800,  y: 230, resource: 'relics' },
    { id: 'east_fields', name: 'East Farmland', terrain: 'farmland', x: 1180, y: 765, resource: 'food' },
    { id: 'red_base',    name: 'Red Keep',      terrain: 'base',     x: 1460, y: 500, resource: null,    owner: 'RED' },
  ];

  const CONNECTIONS = {
    blue_base:   ['north_forest', 'west_quarry', 'south_forest'],
    north_forest:['blue_base', 'west_quarry', 'ancient_ruins', 'south_forest'],
    south_forest:['blue_base', 'west_quarry', 'horse_plains', 'north_forest'],
    west_quarry: ['blue_base', 'north_forest', 'south_forest', 'central_mine', 'ancient_ruins', 'horse_plains'],
    ancient_ruins:['north_forest', 'central_mine', 'east_woods', 'east_quarry', 'west_quarry'],
    central_mine:['west_quarry', 'east_quarry', 'horse_plains', 'ancient_ruins'],
    horse_plains:['south_forest', 'central_mine', 'east_fields', 'east_quarry', 'west_quarry'],
    east_woods:  ['ancient_ruins', 'east_quarry', 'east_fields', 'red_base'],
    east_quarry: ['central_mine', 'ancient_ruins', 'horse_plains', 'east_woods', 'east_fields', 'red_base'],
    east_fields: ['horse_plains', 'east_quarry', 'east_woods', 'red_base'],
    red_base:    ['east_quarry', 'east_woods', 'east_fields'],
  };

  function uid(prefix) { return (prefix || 'id') + '_' + Math.random().toString(36).slice(2, 9); }

  function buildAreas() {
    const areas = {};
    for (const a of MAP_AREAS) {
      areas[a.id] = {
        id: a.id, name: a.name, terrain: a.terrain, x: a.x, y: a.y,
        resource: a.resource || null,
        owner: a.owner || null,           // team that controls it, or null neutral
        connections: CONNECTIONS[a.id].slice(),
        revealed: { BLUE: !!a.owner, RED: !!a.owner },     // ever discovered (map visibility + adjacency)
        scouted: { BLUE: !!a.owner, RED: !!a.owner },      // CURRENTLY scouted (combat: unscouted = penalty)
        scoutedUntil: { BLUE: B.SCOUT_DECAY_SEC, RED: B.SCOUT_DECAY_SEC }, // elapsed time a non-owned scout lapses
        claimedBy: a.owner || null,       // team that has built a site here
        site: a.resource ? { level: 1, cargo: 0, worked: false, workMode: 'standard', caravanMode: 'standard', workModeUntil: 0, caravanModeUntil: 0, lastCaravanAt: -999, guards: 0 } : null,
        threat: 0,
        buildings: {},                    // per-location buildings: { type: count }
        maxBuildings: a.terrain === 'base' ? B.BUILD_SLOTS_BASE : B.BUILD_SLOTS_SITE,
        captureProgress: 0,               // seconds an enemy has held this undefended site
      };
    }
    // Each base reveals & scouts its immediate neighbours from the start.
    areas.blue_base.connections.forEach((n) => { areas[n].revealed.BLUE = true; areas[n].scouted.BLUE = true; });
    areas.red_base.connections.forEach((n) => { areas[n].revealed.RED = true; areas[n].scouted.RED = true; });
    return areas;
  }

  function emptyResources(extra) {
    const r = {};
    for (const k of C.RESOURCES) r[k] = 0;
    return Object.assign(r, extra || {});
  }
  function emptyEquipment() {
    const e = {};
    for (const k of C.EQUIP) e[k] = 0;
    e._tier = { /* per item advanced count, optional */ };
    return e;
  }

  function createTeam(team) {
    const t = {
      team,
      resources: emptyResources(B.START_RESOURCES),
      equipment: emptyEquipment(),
      gearInv: {},               // item -> array of forged QUALITIES not yet equipped (individual items)
      equipQuality: (function () { const q = {}; for (const k of C.EQUIP) q[k] = 1; return q; })(), // avg quality multiplier per item
      qualityLog: [],            // last few forged items with their quality (for the Forge UI)
      storageCap: B.STORAGE_BASE,
      pop: {
        total: B.START_POP, idle: 0,
        farmers: 4, woodcutters: 4, miners: 2, builders: 2, students: 0, trainers: 0,
        researchers: 0,      // educated workers assigned to a University (generate Research Points)
        scouts: 0,           // Steward-assigned scouts (scouting speed scales with their number)
        recruits: B.START_RECRUITS, soldiers: 0,
        away: 0,              // workers committed to an expedition (still housed; rejoin on return)
        educated: 0,          // educated workers (faster reassignment; required to research)
        cooling: [],          // re-idled workers waiting out a reassignment cooldown: [{n, until, edu}]
        eduProgress: 0,       // accumulates toward the next educated graduate
      },
      housing: B.START_HOUSING,
      research: {},            // research key -> tier owned (1..3). Team-wide permanent upgrades.
      researchPoints: 0,       // banked Research Points
      researchProgress: 0,     // accrues toward the next RP from researchers
      dangerWork: { food: false, wood: false, mine: false },  // Steward: which gather pools work dangerously
      // Steward's gathering management: how many tool-sets are committed to each gatherer pool
      // (desired = what the Steward asked for; effective = what the tool stock can currently equip),
      // and how miner labour is split between iron (mineIronFocus) and stone (the remainder).
      gather: { desired: { food: 0, wood: 0, mine: 0 }, effective: { food: 0, wood: 0, mine: 0 }, mineIronFocus: B.DEFAULT_MINE_FOCUS },
      buildings: { house: 0, farm: 0, lumberCamp: 0, mine: 0, storehouse: 0, barracks: 0, school: 0, stables: 0, workshop: 0, university: 0, marketplace: 0, walls: 0 }, // aggregate cache (recomputed from owned areas)
      buildQueue: [],
      training: [],           // Commander training jobs: [{id, area, unitType, count, progress}]
      policy: null,
      policyCooldownUntil: 0,    // elapsed time until the Lord may change policy again (3-min cooldown)
      blacksmithSpec: null,
      blacksmithSpecCooldownUntil: 0,  // elapsed time until the Blacksmith may change forge focus again (3-min cooldown)
      doctrine: null,
      doctrineCooldownUntil: 0,  // elapsed time until the Commander may change army doctrine again (3-min cooldown)
      production: [],            // blacksmith queue items {id,item,remaining,qtyLeft,tier}
      productionMode: 'basic',   // basic | advanced
      contract: null,
      contractCooldown: 0,
      contractHistory: [],       // last few resolved contracts {name, result:'success'|'failed'}
      contractRotation: [],      // stable shuffle of contract ids (filled at init); offers rotate through it
      contractOffers: [],        // the ids currently offered (CONTRACT_OFFER_COUNT of them)
      contractOffersIn: 0,       // seconds until the offer set rotates
      caravans: [],
      guards: 0,                 // unassigned caravan-guard pool (militia-grade, lent by the Commander)
      armies: [],
      keep: { hp: B.KEEP_HP, maxHp: B.KEEP_HP, def: B.KEEP_DEF },
      requests: [],
      comms: [],
      holds: {},                 // resource -> untilElapsed (-1 = indefinite). Lord rationing.
      holdGrants: {},            // resource -> count of one-time spend passes the Lord approved
      conserve: {},              // resource -> untilElapsed: Steward's soft "please conserve" request (advisory; AI complies)
      workerLock: false,         // Lord can lock home-worker allocation so only the Lord assigns workers
      expedition: null,          // active Steward expedition {id,name,workers,endsAt,reward,risk}
      expeditionCooldownUntil: 0,
      expeditionRotation: [],    // stable shuffle of expedition ids; offers rotate through it
      expeditionOffers: [],      // expedition ids currently on offer (EXPEDITION_OFFER_COUNT)
      expeditionOffersIn: 0,     // seconds until the offer set rotates
      scoutJob: null,            // active scouting target { areaId, progress } (Steward-driven)
      // Stewardship: standing policy, timed action effects, and their cooldowns.
      stewardPolicy: null,                 // active standing policy key (B.STEWARD_POLICIES) or null
      stewardPolicyCooldownUntil: 0,       // elapsed time until the policy may be swapped again
      stewardEffects: [],                  // active timed action effects: [{ id, until, workers }]
      stewardActionCooldownUntil: 0,       // global gate: elapsed time until ANY next action
      stewardActionCD: {},                 // per-action id -> elapsed time until that action may repeat
      marketTradeUntil: 0,                 // elapsed time until the next market barter is allowed
      superviseJob: null,                  // SERVER-ONLY secret: { resource, pos } (stripped from snapshots)
      militaryLog: [],           // last-5 Commander actions, for the Lord's Military Overview
      razeScore: 0,              // persistent score from razing enemy buildings (3 each, 6 at Keep)
      militaryPolicy: B.MILITARY_POLICY_DEFAULT, // Lord-set stance: aggressive/balanced/defensive
      militaryPolicyCooldownUntil: 0,
      score: 0,
      slots: {},                 // role -> { controller, name, playerId, connected }
      aiState: {},               // per-role AI scratch timers
    };
    for (const role of C.ROLE_ORDER) {
      t.slots[role] = { controller: C.CONTROLLER.AI, name: C.ROLE_META[role].name + ' (AI)', playerId: null, connected: false, difficulty: C.AI_DIFFICULTY_DEFAULT };
    }
    // idle = total - assigned workers
    const assigned = t.pop.farmers + t.pop.woodcutters + t.pop.miners + t.pop.builders + t.pop.trainers;
    t.pop.idle = Math.max(0, t.pop.total - assigned);
    return t;
  }

  function createInitialState(opts) {
    opts = opts || {};
    const presets = B.MATCH_PRESETS || { quick: 900, standard: 2700, extended: 5400 };
    const preset = presets[opts.matchPreset] ? opts.matchPreset : (B.DEFAULT_MATCH_PRESET || 'standard');
    const matchLength = opts.matchSeconds || presets[preset] ||
      (opts.devMode ? B.DEV_MATCH_SECONDS : B.FULL_MATCH_SECONDS);
    const devMode = opts.devMode !== undefined ? opts.devMode : (preset === 'quick');
    const state = {
      roomCode: opts.roomCode || null,
      mode: opts.mode || 'coop',
      devMode,
      matchPreset: preset,
      status: 'lobby',
      seed: opts.seed || (Math.floor(Math.random() * 1e9) >>> 0),
      tick: 0,
      elapsed: 0,
      matchLength,
      phase: C.PHASES.EARLY,
      winner: null,
      winReason: null,
      areas: buildAreas(),
      teams: { BLUE: createTeam('BLUE'), RED: createTeam('RED') },
      events: [],
      nextEventAt: 30,
      pause: { active: false, vote: null, cooldownSec: {}, initiator: null },
      surrender: null,
    };
    // Starting town buildings sit at each Keep (the base location).
    state.areas.blue_base.buildings = { house: 1, farm: 1, lumberCamp: 1, mine: 1, watchtower: 1 };
    state.areas.red_base.buildings = { house: 1, farm: 1, lumberCamp: 1, mine: 1, watchtower: 1 };
    recomputeBuildings(state, state.teams.BLUE);
    recomputeBuildings(state, state.teams.RED);
    // Seed each team's forge-contract rotation (a stable shuffle of the whole pool); the Forge offers
    // CONTRACT_OFFER_COUNT of these at a time, advancing through the shuffle every CONTRACT_ROTATE_SEC.
    state.teams.BLUE.contractRotation = shuffledContractIds(state.seed ^ 0x9e3779b1);
    state.teams.RED.contractRotation = shuffledContractIds(state.seed ^ 0x85ebca77);
    state.teams.BLUE.expeditionRotation = shuffledIds(B.EXPEDITIONS.map((e) => e.id), state.seed ^ 0xc2b2ae35);
    state.teams.RED.expeditionRotation = shuffledIds(B.EXPEDITIONS.map((e) => e.id), state.seed ^ 0x27d4eb2f);
    return state;
  }

  // Deterministic Fisher-Yates shuffle of an id list from a 32-bit seed (mulberry32).
  function shuffledIds(ids, seed) {
    ids = ids.slice();
    let s = (seed >>> 0) || 1;
    const rnd = () => { s |= 0; s = (s + 0x6D2B79F5) | 0; let t = Math.imul(s ^ (s >>> 15), 1 | s); t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t; return ((t ^ (t >>> 14)) >>> 0) / 4294967296; };
    for (let i = ids.length - 1; i > 0; i--) { const j = Math.floor(rnd() * (i + 1)); const tmp = ids[i]; ids[i] = ids[j]; ids[j] = tmp; }
    return ids;
  }

  // Deterministic shuffle of the contract id pool from a 32-bit seed (mulberry32).
  function shuffledContractIds(seed) {
    const ids = B.CONTRACTS.map((c) => c.id);
    let s = (seed >>> 0) || 1;
    const rnd = () => { s |= 0; s = (s + 0x6D2B79F5) | 0; let t = Math.imul(s ^ (s >>> 15), 1 | s); t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t; return ((t ^ (t >>> 14)) >>> 0) / 4294967296; };
    for (let i = ids.length - 1; i > 0; i--) { const j = Math.floor(rnd() * (i + 1)); const tmp = ids[i]; ids[i] = ids[j]; ids[j] = tmp; }
    return ids;
  }

  // Aggregate per-area buildings (owned areas only) into team.buildings cache.
  function recomputeBuildings(state, team) {
    const agg = {};
    for (const k of C.BUILDINGS) agg[k] = 0;
    for (const id in state.areas) {
      const a = state.areas[id];
      if (a.owner !== team.team || !a.buildings) continue;
      for (const t in a.buildings) agg[t] = (agg[t] || 0) + a.buildings[t];
    }
    team.buildings = agg;
    return agg;
  }
  function buildingsAt(area) { let n = 0; for (const t in area.buildings) n += area.buildings[t]; return n; }

  // Breadth-first path between two area ids (inclusive), or null.
  function findPath(areas, fromId, toId) {
    if (fromId === toId) return [fromId];
    const q = [[fromId]];
    const seen = new Set([fromId]);
    while (q.length) {
      const path = q.shift();
      const last = path[path.length - 1];
      for (const n of areas[last].connections) {
        if (seen.has(n)) continue;
        const np = path.concat(n);
        if (n === toId) return np;
        seen.add(n);
        q.push(np);
      }
    }
    return null;
  }

  function enemyOf(team) { return team === 'BLUE' ? 'RED' : 'BLUE'; }
  function homeBase(team) { return team === 'BLUE' ? 'blue_base' : 'red_base'; }

  return {
    MAP_AREAS, CONNECTIONS, createInitialState, createTeam, buildAreas,
    findPath, enemyOf, homeBase, uid, emptyResources, recomputeBuildings, buildingsAt,
  };
});
