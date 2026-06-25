/* Rationing test: Lord holds wood -> Blacksmith blocked -> USE request -> Lord grants -> unblocked. */
'use strict';
const { io } = require('socket.io-client');
const C = require('../shared/constants.js');
const URL = 'http://localhost:3100';
function wait(ms) { return new Promise((r) => setTimeout(r, ms)); }
function snapOnce(s) { return new Promise((r) => s.once(C.EV.SNAPSHOT, r)); }
function resultOnce(s) { return new Promise((r) => s.once(C.EV.ACTION_RESULT, r)); }

(async () => {
  let fail = false;
  const lord = io(URL, { transports: ['websocket'] });
  await new Promise((r) => lord.on('connect', r));
  lord.emit(C.EV.CREATE_ROOM, { name: 'Lord', clientId: 'L', devMode: true });
  let code; await new Promise((r) => lord.once(C.EV.ROOM_UPDATE, (d) => { code = d.code; r(); }));
  lord.emit(C.EV.CLAIM_SLOT, { team: 'BLUE', role: 'LORD' });

  const smith = io(URL, { transports: ['websocket'] });
  await new Promise((r) => smith.on('connect', r));
  smith.emit(C.EV.JOIN_ROOM, { code, name: 'Smith', clientId: 'S' });
  await new Promise((r) => smith.once(C.EV.LOBBY_UPDATE, r));
  smith.emit(C.EV.CLAIM_SLOT, { team: 'BLUE', role: 'BLACKSMITH' });
  await wait(200);
  lord.emit(C.EV.START_GAME, { devMode: true });
  await new Promise((r) => lord.once(C.EV.GAME_STARTED, r));
  await snapOnce(lord);

  // Lord holds wood (indefinite).
  lord.emit(C.EV.SUBMIT_ACTION, { action: 'setHold', payload: { resource: 'wood', duration: 0 } });
  await wait(300);
  let snap = await snapOnce(lord);
  const held = snap.teams.BLUE.holds && snap.teams.BLUE.holds.wood !== undefined;
  console.log('wood held:', held, '(value', snap.teams.BLUE.holds.wood + ')');

  // Blacksmith tries to forge bows (cost wood) -> should be blocked.
  smith.emit(C.EV.SUBMIT_ACTION, { action: 'produce', payload: { item: 'bows', qty: 2 } });
  const blockRes = await resultOnce(smith);
  console.log('blacksmith produce blocked:', blockRes.ok === false, '|', blockRes.reason);

  // Blacksmith asks permission (USE) -> appears in Lord inbox (open, human Lord).
  smith.emit(C.EV.SUBMIT_ACTION, { action: 'request', payload: { type: 'USE', payload: { resource: 'wood', reason: 'to forge bows' } } });
  await wait(300);
  for (let i = 0; i < 3; i++) snap = await snapOnce(lord);
  const useReq = snap.teams.BLUE.requests.find((r) => r.type === 'USE' && r.targetRole === 'LORD' && r.status === 'open');
  console.log('USE request to Lord open:', !!useReq);

  // Lord grants it. Under the access-window model the hold REMAINS, but the requester gets a spend window.
  if (useReq) lord.emit(C.EV.SUBMIT_ACTION, { action: 'resolveRequest', payload: { id: useReq.id, accept: true } });
  await wait(400);
  for (let i = 0; i < 2; i++) snap = await snapOnce(lord);
  const stillHeld = snap.teams.BLUE.holds && snap.teams.BLUE.holds.wood !== undefined;
  console.log('wood still reserved after grant (access-window model):', stillHeld);

  // Blacksmith can now forge within the granted access window.
  smith.emit(C.EV.SUBMIT_ACTION, { action: 'produce', payload: { item: 'bows', qty: 2 } });
  const okRes = await resultOnce(smith);
  console.log('blacksmith produce after grant:', okRes.ok === true, '|', okRes.msg || okRes.reason);

  if (!(held && blockRes.ok === false && useReq && stillHeld && okRes.ok === true)) fail = true;
  console.log(fail ? 'HOLD TEST FAIL' : 'HOLD TEST OK');
  lord.close(); smith.close(); process.exit(fail ? 1 : 0);
})().catch((e) => { console.error('FATAL', e); process.exit(1); });
setTimeout(() => { console.log('TIMEOUT'); process.exit(1); }, 15000);
