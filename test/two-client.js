/* Two-client test: both join same room, claim different roles, start, both get snapshots. */
'use strict';
const { io } = require('socket.io-client');
const C = require('../shared/constants.js');
const URL = 'http://localhost:3100';

const host = io(URL, { transports: ['websocket'] });
let code = null, guest = null, hostSnaps = 0, guestSnaps = 0, guestRole = null;

host.on('connect', () => host.emit(C.EV.CREATE_ROOM, { name: 'Host', clientId: 'h1', devMode: true }));
host.on(C.EV.ROOM_UPDATE, (d) => { code = d.code; host.emit(C.EV.CLAIM_SLOT, { team: 'BLUE', role: 'LORD' }); connectGuest(); });
host.on(C.EV.SNAPSHOT, () => { hostSnaps++; });

function connectGuest() {
  if (guest) return;
  guest = io(URL, { transports: ['websocket'] });
  guest.on('connect', () => guest.emit(C.EV.JOIN_ROOM, { code, name: 'Guest', clientId: 'g1' }));
  guest.on(C.EV.LOBBY_UPDATE, (d) => {
    if (!guest._claimed) { guest._claimed = true; guest.emit(C.EV.CLAIM_SLOT, { team: 'BLUE', role: 'COMMANDER' }); setTimeout(() => host.emit(C.EV.START_GAME, { devMode: true }), 200); }
    const cmd = d.slots.BLUE.COMMANDER; if (cmd.playerId === 'g1') guestRole = 'COMMANDER';
  });
  guest.on(C.EV.SNAPSHOT, (snap) => {
    guestSnaps++;
    if (guestSnaps === 4) {
      const B = snap.teams.BLUE;
      const ok = B.slots.LORD.controller === 'human' && B.slots.COMMANDER.controller === 'human' &&
        B.slots.LORD.name === 'Host' && B.slots.COMMANDER.name === 'Guest' &&
        B.slots.STEWARD.controller === 'ai' && hostSnaps > 0 && guestSnaps >= 4;
      console.log('LORD:', B.slots.LORD.controller, B.slots.LORD.name, '| COMMANDER:', B.slots.COMMANDER.controller, B.slots.COMMANDER.name, '| STEWARD:', B.slots.STEWARD.controller);
      console.log('hostSnaps', hostSnaps, 'guestSnaps', guestSnaps);
      console.log(ok ? 'TWO-CLIENT OK' : 'TWO-CLIENT FAIL');
      host.close(); guest.close(); process.exit(ok ? 0 : 1);
    }
  });
}
setTimeout(() => { console.log('TIMEOUT'); process.exit(1); }, 12000);
