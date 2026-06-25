/* Request-routing test: a Lord asking for a Lord-supplied resource must NOT self-target,
   and the AI supplier must auto-accept. */
'use strict';
const { io } = require('socket.io-client');
const C = require('../shared/constants.js');
const URL = 'http://localhost:3100';
const s = io(URL, { transports: ['websocket'] });
function wait(ms) { return new Promise((r) => setTimeout(r, ms)); }
function nextSnap() { return new Promise((r) => s.once(C.EV.SNAPSHOT, r)); }

(async () => {
  await new Promise((r) => s.on('connect', r));
  s.emit(C.EV.CREATE_ROOM, { name: 'Lord', clientId: 'lord1', devMode: true });
  await new Promise((r) => s.once(C.EV.ROOM_UPDATE, r));
  s.emit(C.EV.CLAIM_SLOT, { team: 'BLUE', role: 'LORD' });
  await wait(150); s.emit(C.EV.START_GAME, { devMode: true });
  await new Promise((r) => s.once(C.EV.GAME_STARTED, r));
  await nextSnap();
  // Lord (primary wood supplier) asks for wood -> must route to STEWARD (AI), not self.
  s.emit(C.EV.SUBMIT_ACTION, { action: 'request', payload: { type: 'NEED', payload: { resource: 'wood' } } });
  await wait(150);
  // Lord asks for iron -> STEWARD too.
  s.emit(C.EV.SUBMIT_ACTION, { action: 'request', payload: { type: 'NEED', payload: { resource: 'iron' } } });
  let snap; for (let i = 0; i < 6; i++) snap = await nextSnap();
  const reqs = snap.teams.BLUE.requests;
  const selfTargeted = reqs.filter((r) => r.targetRole === 'LORD');
  const toSteward = reqs.filter((r) => r.fromRole === 'LORD' && r.targetRole === 'STEWARD');
  const accepted = toSteward.filter((r) => r.status === 'accepted');
  console.log('requests:', reqs.map((r) => r.fromRole + '->' + r.targetRole + ':' + (r.payload && r.payload.resource) + ':' + r.status));
  console.log('self-targeted (should be 0):', selfTargeted.length);
  console.log('Lord->Steward NEED:', toSteward.length, '| accepted by AI:', accepted.length);
  const ok = selfTargeted.length === 0 && toSteward.length >= 1 && accepted.length >= 1;
  console.log(ok ? 'REQUEST ROUTING OK' : 'REQUEST ROUTING FAIL');
  s.close(); process.exit(ok ? 0 : 1);
})().catch((e) => { console.error('FATAL', e); process.exit(1); });
setTimeout(() => { console.log('TIMEOUT'); process.exit(1); }, 12000);
