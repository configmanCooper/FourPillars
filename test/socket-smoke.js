/* Socket end-to-end smoke: create room, claim a seat, start, act, verify snapshots. */
'use strict';
const { io } = require('socket.io-client');
const C = require('../shared/constants.js');

const URL = 'http://localhost:3100';
const s = io(URL, { transports: ['websocket'] });
let snaps = 0, started = false, lobby = null, acted = false, firstFood = null;

function log(...a) { console.log(...a); }

s.on('connect', () => { log('connected', s.id); s.emit(C.EV.CREATE_ROOM, { name: 'Tester', devMode: true, clientId: 'tester1' }); });
s.on(C.EV.ROOM_UPDATE, (d) => { log('room', d.code, 'host?', d.isHost); s._code = d.code; });
s.on(C.EV.LOBBY_UPDATE, (d) => {
  lobby = d;
  if (!s._claimed) { s._claimed = true; s.emit(C.EV.CLAIM_SLOT, { team: 'BLUE', role: 'LORD' }); setTimeout(() => s.emit(C.EV.START_GAME, { devMode: true }), 150); }
});
s.on(C.EV.GAME_STARTED, () => { started = true; log('game started'); });
s.on(C.EV.SNAPSHOT, (snap) => {
  snaps++;
  if (firstFood === null) firstFood = snap.teams.BLUE.resources.food;
  if (snaps === 3 && !acted) { acted = true; s.emit(C.EV.SUBMIT_ACTION, { action: 'build', payload: { type: 'house' } }); s.emit(C.EV.SUBMIT_ACTION, { action: 'request', payload: { type: 'ESCORT' } }); }
  if (snaps === 6) {
    const B = snap.teams.BLUE;
    log('snapshots:', snaps, 'status:', snap.status, 'elapsed:', Math.round(snap.elapsed));
    log('BLUE food', Math.round(B.resources.food), 'buildQ', B.buildQueue.length, 'comms', B.comms.length, 'requests', B.requests.length);
    log('BLUE lord slot controller:', B.slots.LORD.controller, B.slots.LORD.name);
    log('other slots AI?', ['STEWARD', 'BLACKSMITH', 'COMMANDER'].map((r) => B.slots[r].controller).join(','));
    const ok = started && snaps >= 6 && snap.status === 'playing' && B.slots.LORD.controller === 'human' && B.buildQueue.length >= 1 && B.comms.length >= 1;
    log(ok ? 'SOCKET SMOKE OK' : 'SOCKET SMOKE FAIL');
    s.close(); process.exit(ok ? 0 : 1);
  }
});
s.on(C.EV.ACTION_RESULT, (r) => log('action_result', r.action, r.ok, r.msg || r.reason || ''));
s.on(C.EV.ERROR_MSG, (d) => log('ERROR', d.msg));
setTimeout(() => { log('TIMEOUT - snaps', snaps); process.exit(1); }, 12000);
