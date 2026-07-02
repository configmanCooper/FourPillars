/* Regression for the AI grace-takeover of a disconnected seat + escort/guards/sanitizer bug fixes. */
'use strict';
const C = require('../shared/constants.js');
const S = require('../shared/schema.js');
const { RoomManager } = require('../server/rooms.js');
const sim = require('../server/sim.js');
const comms = require('../server/systems/comms.js');
const army = require('../server/systems/army.js');
const eco = require('../server/systems/economy.js');

let fails = 0;
function ok(cond, msg) { if (!cond) { console.log('  FAIL:', msg); fails++; } else { console.log('  ok:', msg); } }

// ---- AI grace-takeover ----
{
  const io = { to: () => ({ emit: () => {} }) };
  const mgr = new RoomManager(io);
  const host = { id: 'h', rooms: new Set(), join() {}, emit() {} };
  const room = mgr.createRoom(host, { name: 'Host', clientId: 'h' });
  room.state.status = 'playing';
  // Seat a human at BLUE Lord.
  const sl = room.state.teams.BLUE.slots.LORD;
  sl.controller = C.CONTROLLER.HUMAN; sl.playerId = 'p1'; sl.connected = true; sl.name = 'Human';
  room.players.set('p1', { pid: 'p1', name: 'Human', connected: true, lastActivity: Date.now() });

  // Simulate disconnect.
  const p = room.players.get('p1'); p.connected = false; p.disconnectedAt = Date.now(); sl.connected = false;

  // Immediately: no takeover (grace not elapsed).
  mgr.checkAiTakeover(room);
  ok(sl.controller === C.CONTROLLER.HUMAN && !sl._aiGrace, 'seat NOT taken over immediately on disconnect');

  // 20s gone / 20s idle: still no takeover.
  p.disconnectedAt = Date.now() - 20000; p.lastActivity = Date.now() - 20000;
  mgr.checkAiTakeover(room);
  ok(sl.controller === C.CONTROLLER.HUMAN && !sl._aiGrace, 'seat NOT taken over before 30s grace');

  // 31s gone AND 31s idle: AI takes over (keeps playerId).
  p.disconnectedAt = Date.now() - 31000; p.lastActivity = Date.now() - 31000;
  mgr.checkAiTakeover(room);
  ok(sl.controller === C.CONTROLLER.AI && sl._aiGrace && sl.playerId === 'p1', 'AI takes the seat after 30s gone + 30s idle (playerId kept for reclaim)');

  // Human input (activity) reclaims the seat instantly.
  mgr.markActivity(room, 'p1');
  ok(sl.controller === C.CONTROLLER.HUMAN && !sl._aiGrace && sl.connected, 'any human input immediately reclaims the seat from the AI');

  // Fresh activity blocks takeover even if long disconnected (an actively-playing human whose socket blipped).
  p.disconnectedAt = Date.now() - 60000; p.lastActivity = Date.now(); sl.connected = false;
  mgr.checkAiTakeover(room);
  ok(sl.controller === C.CONTROLLER.HUMAN && !sl._aiGrace, 'recent activity blocks takeover despite a long disconnect');
}

// ---- Escort never picks the Home Garrison (#7) + no phantom escort (#8) ----
{
  const st = S.createInitialState({ roomCode: 'ES', seed: 4, matchPreset: 'standard' });
  st.status = 'playing';
  const team = st.teams.BLUE;
  const home = S.homeBase('BLUE');
  const garr = army.garrison(st, team);   // the home garrison
  for (const u of C.UNITS) garr.units[u] = 0; garr.units.spearman = 6; army.ensureGear(garr);
  team.armies = [garr];
  // A caravan exists.
  team.caravans = [{ id: 'cv1', resource: 'wood', cargo: { wood: 5 }, route: [home, home], legIndex: 0, escort: false }];
  comms.createRequest(st, team, 'STEWARD', 'COMMANDER', 'ESCORT', { caravanId: 'cv1' });
  const r = team.requests.find((x) => x.type === 'ESCORT');
  const before = garr.mission && garr.mission.type;
  comms.resolveRequest(st, team, r.id, true, sim.SYSTEMS);   // AI Commander answers
  ok(!(garr.mission && garr.mission.type === 'escort'), 'ESCORT did NOT send the Home Garrison off escorting');
  ok(!team.caravans[0].escort || team.caravans[0].escortGroupId, 'no phantom escort flag without a real escort host');
}

// ---- Lent guards are counted in population (#5) ----
{
  const st = S.createInitialState({ roomCode: 'GD', seed: 5, matchPreset: 'standard' });
  const team = st.teams.BLUE;
  eco.recomputeDerived(team);
  const before = team.pop.total;
  team.guards = 4;
  eco.recomputeDerived(team);
  ok(team.pop.total === before + 4, 'lent caravan guards count toward pop.total (mouths to feed, not ghosts)');
}

// ---- Input sanitizer rejects a bogus WORKERS job + NaN counts (#32) ----
{
  const st = S.createInitialState({ roomCode: 'SN', seed: 6, matchPreset: 'standard' });
  st.status = 'playing';
  const team = st.teams.BLUE;
  team.slots.LORD.controller = 'human'; team.slots.LORD.playerId = 'p'; 
  // WORKERS with a bogus job string must NOT create a phantom pop pool.
  sim.applyAction(st, 'BLUE', 'STEWARD', 'request', { type: 'WORKERS', targetRole: 'LORD', payload: { job: 'HACKERS' } });
  const req = team.requests.find((r) => r.type === 'WORKERS');
  ok(req && req.payload.job !== 'HACKERS' && ['farmers','woodcutters','miners','builders','students','trainers','scouts'].includes(req.payload.job), 'bogus WORKERS job sanitized to a real pool');
  // NaN GUARDS count clamps to a finite number.
  sim.applyAction(st, 'BLUE', 'STEWARD', 'request', { type: 'GUARDS', targetRole: 'COMMANDER', payload: { count: 'NaN' } });
  const gr = team.requests.find((r) => r.type === 'GUARDS');
  ok(gr && Number.isFinite(gr.payload.count), 'NaN GUARDS count sanitized to a finite value');
}

console.log(fails === 0 ? '\nAI-TAKEOVER & BUGFIX BATCH OK' : '\n' + fails + ' FAILURES');
process.exit(fails === 0 ? 0 : 1);
