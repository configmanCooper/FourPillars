/* Verifies spectators may pause/resume ONLY in an all-AI game (no seated humans):
   - a spectator CAN pause & resume a room where every seat is AI;
   - a spectator CANNOT pause a room that has a seated human;
   - a seated human still pauses normally. */
'use strict';
const C = require('../shared/constants.js');
const { RoomManager } = require('../server/rooms.js');

let fails = 0;
function ok(cond, msg) { if (!cond) { console.log('  FAIL:', msg); fails++; } else { console.log('  ok:', msg); } }

// Minimal io/socket mocks.
const io = { to: () => ({ emit: () => {} }) };
function mkSocket(pid) {
  return { id: pid, rooms: new Set(), _emits: [],
    join() {}, emit(ev, payload) { this._emits.push({ ev, payload }); } };
}
function mgrWithRoom() {
  const mgr = new RoomManager(io);
  const host = mkSocket('host');
  const room = mgr.createRoom(host, { name: 'Host', clientId: 'host' });
  room.state.status = 'playing';
  return { mgr, room };
}
function seat(room, team, role, pid) {
  const sl = room.state.teams[team].slots[role];
  sl.controller = C.CONTROLLER.HUMAN; sl.playerId = pid; sl.connected = true;
  room.players.set(pid, { pid, name: pid, socketId: pid, connected: true });
}
function specSocket(mgr, room, pid) {
  const s = mkSocket(pid); s._fp = { code: room.code, pid, name: pid };
  room.players.set(pid, { pid, name: pid, socketId: pid, connected: true });
  return s;
}

// ---- Case 1: all-AI room, a spectator pauses & resumes ----
{
  const { mgr, room } = mgrWithRoom();
  // Ensure NO seat is a connected human (createInitialState seats all AI by default).
  const spec = specSocket(mgr, room, 'watcher');
  mgr.initiatePause(spec);
  ok(room.state.pause.active === true, 'spectator PAUSED an all-AI game');
  ok(room.state.pause.initiator === 'watcher', 'pause initiator recorded as the spectator');
  const errored = spec._emits.some((e) => e.ev === C.EV.ERROR_MSG);
  ok(!errored, 'no "only seated players" error was sent to the spectator');
  mgr.requestResume(spec);
  ok(room.state.pause.active === false, 'spectator RESUMED the all-AI game');
}

// ---- Case 2: room with a seated human — a spectator may NOT pause ----
{
  const { mgr, room } = mgrWithRoom();
  seat(room, 'BLUE', 'LORD', 'human1');
  const spec = specSocket(mgr, room, 'watcher');
  mgr.initiatePause(spec);
  ok(room.state.pause.active !== true, 'spectator could NOT pause a game with a seated human');
  const errored = spec._emits.some((e) => e.ev === C.EV.ERROR_MSG);
  ok(errored, 'spectator got the "only seated players can pause" error');
}

// ---- Case 3: the seated human still pauses normally ----
{
  const { mgr, room } = mgrWithRoom();
  seat(room, 'BLUE', 'LORD', 'human1');
  const h = mkSocket('human1'); h._fp = { code: room.code, pid: 'human1', name: 'human1' };
  mgr.initiatePause(h);
  ok(room.state.pause.active === true, 'a seated solo human pauses directly (unchanged)');
}

console.log(fails === 0 ? '\nSPECTATOR-PAUSE OK' : '\n' + fails + ' FAILURES');
process.exit(fails === 0 ? 0 : 1);
