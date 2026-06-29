const { io } = require('socket.io-client');
const C = require('../shared/constants.js');
const s = io('http://localhost:3100', { transports: ['websocket'] });
let code = null;
s.on('connect', () => s.emit(C.EV.CREATE_ROOM, { name: 'Tester', matchPreset: 'quick', clientId: 'cid1' }));
s.on(C.EV.ROOM_UPDATE, (r) => { if (!code && r && r.code) { code = r.code; s.emit(C.EV.CLAIM_SLOT, { team: 'BLUE', role: 'LORD' }); setTimeout(() => s.emit(C.EV.START_GAME, { matchPreset: 'quick' }), 300); } });
let ticks = 0;
s.on(C.EV.SNAPSHOT, () => { ticks++; if (ticks === 1) s.emit(C.EV.SUBMIT_ACTION, { action: 'assignWorker', payload: { job: 'farmers', delta: 1 } }); if (ticks === 6) s.emit(C.EV.REQUEST_REPLAY); });
s.on(C.EV.REPLAY_DATA, (d) => {
  console.log('REPLAY: actions=' + d.actions.length + ' snaps=' + d.snapshots.length + ' events=' + d.events.length + ' comms=' + d.comms.length + ' slots=' + Object.keys(d.meta.slots.BLUE).length);
  console.log('humanAction0=', JSON.stringify(d.actions[0]));
  console.log('snap0 BLUE res=', JSON.stringify(d.snapshots[0] && d.snapshots[0].BLUE.res));
  process.exit(d.actions.length >= 1 && d.snapshots.length >= 1 ? 0 : 1);
});
s.on(C.EV.ERROR_MSG, (e) => { console.log('ERR', e); });
setTimeout(() => { console.log('timeout'); process.exit(2); }, 20000);
