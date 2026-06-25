/* Pause tests: single-human instant pause/resume; multi-human vote to pause. */
'use strict';
const { io } = require('socket.io-client');
const C = require('../shared/constants.js');
const URL = 'http://localhost:3100';
function client() { return io(URL, { transports: ['websocket'] }); }
function wait(ms) { return new Promise((r) => setTimeout(r, ms)); }
function nextSnap(s) { return new Promise((r) => s.once(C.EV.SNAPSHOT, r)); }

(async () => {
  let fail = false;
  // ---- Single human ----
  const a = client();
  await new Promise((r) => a.on('connect', r));
  a.emit(C.EV.CREATE_ROOM, { name: 'Solo', clientId: 'solo', devMode: true });
  await new Promise((r) => a.once(C.EV.ROOM_UPDATE, r));
  a.emit(C.EV.CLAIM_SLOT, { team: 'BLUE', role: 'LORD' });
  await wait(150);
  a.emit(C.EV.START_GAME, { devMode: true });
  await new Promise((r) => a.once(C.EV.GAME_STARTED, r));
  await nextSnap(a);
  a.emit(C.EV.PAUSE_REQUEST);
  await wait(300);
  let snap = await nextSnap(a);
  const pausedSolo = snap.pause.active === true && !snap.pause.vote;
  console.log('solo pause active:', snap.pause.active, 'vote:', !!snap.pause.vote);
  // verify time is frozen while paused
  const t1 = snap.elapsed; await wait(1500); snap = await nextSnap(a);
  const frozen = Math.abs(snap.elapsed - t1) < 0.001;
  console.log('elapsed frozen while paused:', frozen, '(', t1, '->', snap.elapsed, ')');
  a.emit(C.EV.RESUME_REQUEST); await wait(300); snap = await nextSnap(a);
  const resumed = snap.pause.active === false;
  console.log('solo resumed:', resumed);
  a.close();
  if (!(pausedSolo && frozen && resumed)) fail = true;

  // ---- Two humans, vote ----
  const h = client(); await new Promise((r) => h.on('connect', r));
  h.emit(C.EV.CREATE_ROOM, { name: 'H1', clientId: 'h1', devMode: true });
  let code = null; await new Promise((r) => h.once(C.EV.ROOM_UPDATE, (d) => { code = d.code; r(); }));
  h.emit(C.EV.CLAIM_SLOT, { team: 'BLUE', role: 'LORD' });
  const g = client(); await new Promise((r) => g.on('connect', r));
  g.emit(C.EV.JOIN_ROOM, { code, name: 'H2', clientId: 'h2' });
  await new Promise((r) => g.once(C.EV.LOBBY_UPDATE, r));
  g.emit(C.EV.CLAIM_SLOT, { team: 'BLUE', role: 'COMMANDER' });
  await wait(200);
  h.emit(C.EV.START_GAME, { devMode: true });
  await new Promise((r) => h.once(C.EV.GAME_STARTED, r));
  await nextSnap(h);
  h.emit(C.EV.PAUSE_REQUEST);
  await wait(300);
  let s2 = await nextSnap(h);
  const voteStarted = !!s2.pause.vote && s2.pause.active === false && s2.pause.vote.kind === 'pause';
  console.log('vote started (not yet paused):', voteStarted, 'yes:', s2.pause.vote && s2.pause.vote.yes, 'humans:', s2.pause.vote && s2.pause.vote.humansCount);
  // second human votes yes -> all voted -> pause
  g.emit(C.EV.PAUSE_VOTE, { vote: true });
  await wait(400);
  s2 = await nextSnap(h);
  const votePassed = s2.pause.active === true && !s2.pause.vote;
  console.log('after both yes -> paused:', s2.pause.active, 'vote cleared:', !s2.pause.vote);
  // cooldown should be present for h1
  const cd = s2.pause.cooldownSec && s2.pause.cooldownSec.h1;
  console.log('h1 pause cooldown sec:', cd);
  h.close(); g.close();
  if (!(voteStarted && votePassed && cd > 0)) fail = true;

  console.log(fail ? 'PAUSE TEST FAIL' : 'PAUSE TEST OK');
  process.exit(fail ? 1 : 0);
})().catch((e) => { console.error('FATAL', e); process.exit(1); });
