/* Unit test for the surrender/concede + pause-default-accept logic in RoomManager.
 * Drives RoomManager methods directly with mocked io/sockets (no real network). */
'use strict';
const path = require('path');
const C = require('../shared/constants.js');
const S = require('../shared/schema.js');
const RoomManager = require('../server/rooms.js').RoomManager;

const io = { to: () => ({ emit: () => {} }) };
let pass = 0, fail = 0;
function check(name, cond) { if (cond) { pass++; console.log('  ok   ' + name); } else { fail++; console.log('  FAIL ' + name); } }

function mkRoom(rm, code) {
  const state = S.createInitialState({ roomCode: code, matchPreset: 'standard' });
  state.status = 'playing';
  const room = { code, hostId: 'host', state, players: new Map(), interval: null, _pauseCooldownMs: {} };
  rm.rooms.set(code, room);
  return room;
}
// Seat a human on team/role with a connected player.
function seatHuman(room, team, role, pid, name) {
  const sl = room.state.teams[team].slots[role];
  sl.controller = C.CONTROLLER.HUMAN; sl.playerId = pid; sl.connected = true; sl.name = name || pid;
  room.players.set(pid, { pid, name: name || pid, socketId: pid, connected: true });
}
function sock(room, pid) { return { _fp: { code: room.code, pid }, emit: () => {}, join: () => {} }; }
// Make `loser` hopeless vs `winner` (winner must have a human for AI concede to fire).
function makeHopeless(room, loser, winner) {
  const st = room.state;
  st.elapsed = 400;
  st.teams[loser].score = 100; st.teams[winner].score = 400;
  // winner army strength > 0 and >=1.5x (loser has none)
  st.teams[winner].armies = [{ id: 'g1', units: { spearman: 8 }, area: S.homeBase(winner), formation: 'line', stance: 'balanced', gear: {} }];
  st.teams[loser].armies = [];
  // winner holds 3 sites, loser 0
  let n = 0;
  for (const id in st.areas) { const a = st.areas[id]; if (a.terrain !== 'base' && n < 3) { a.claimedBy = winner; a.owner = winner; n++; } }
}

console.log('1) AI concede: all-AI RED, losing badly to BLUE (has human) -> offers, default-accepted, BLUE wins');
{
  const rm = new RoomManager(io);
  const room = mkRoom(rm, 'AIC1');
  seatHuman(room, 'BLUE', 'LORD', 'humanBlue');     // BLUE has a human; RED all AI
  makeHopeless(room, 'RED', 'BLUE');
  rm.maybeAIConcede(room);
  check('surrender offer created from RED', room.state.surrender && room.state.surrender.fromTeam === 'RED');
  check('deciding team is BLUE', room.state.surrender && room.state.surrender.foe === 'BLUE');
  // BLUE human does not vote -> deadline passes -> default accept
  room._surrenderEndsMs = Date.now() - 1;
  rm.resolveSurrender(room);
  check('game over after default-accept', room.state.status === 'over');
  check('winner is BLUE', room.state.winner === 'BLUE');
}

console.log('2) Human offers surrender, enemy ALL-AI -> auto-accepted instantly');
{
  const rm = new RoomManager(io);
  const room = mkRoom(rm, 'HS1');
  seatHuman(room, 'BLUE', 'LORD', 'humanBlue');     // RED all AI
  rm.offerSurrender(sock(room, 'humanBlue'));
  check('game over (RED auto-accepted)', room.state.status === 'over');
  check('winner is RED', room.state.winner === 'RED');
}

console.log('3) Human offers surrender, enemy human DENIES -> war continues');
{
  const rm = new RoomManager(io);
  const room = mkRoom(rm, 'HS2');
  seatHuman(room, 'BLUE', 'LORD', 'humanBlue');
  seatHuman(room, 'RED', 'LORD', 'humanRed');       // RED has a human decider
  rm.offerSurrender(sock(room, 'humanBlue'));
  check('offer pending (RED has a human)', !!room.state.surrender && room.state.status === 'playing');
  rm.voteSurrender(sock(room, 'humanRed'), { accept: false });
  check('surrender refused -> still playing', room.state.status === 'playing');
  check('offer cleared', room.state.surrender === null);
}

console.log('4) Human offers surrender, enemy human ACCEPTS -> ends');
{
  const rm = new RoomManager(io);
  const room = mkRoom(rm, 'HS3');
  seatHuman(room, 'RED', 'COMMANDER', 'humanRed');
  seatHuman(room, 'BLUE', 'LORD', 'humanBlue');
  rm.offerSurrender(sock(room, 'humanRed'));        // RED offers
  rm.voteSurrender(sock(room, 'humanBlue'), { accept: true });
  check('accepted -> over', room.state.status === 'over');
  check('winner BLUE', room.state.winner === 'BLUE');
}

console.log('5) All-AI vs all-AI: NEVER concede');
{
  const rm = new RoomManager(io);
  const room = mkRoom(rm, 'AIAI');                  // no humans seated anywhere
  makeHopeless(room, 'RED', 'BLUE');
  rm.maybeAIConcede(room);
  check('no surrender offered (no human enemy)', room.state.surrender == null);
}

console.log('6) Pause default-accept: 2 humans, initiator yes, other abstains -> PASSES');
{
  const rm = new RoomManager(io);
  const room = mkRoom(rm, 'PV1');
  seatHuman(room, 'BLUE', 'LORD', 'h1');
  seatHuman(room, 'BLUE', 'COMMANDER', 'h2');
  rm.initiatePause(sock(room, 'h1'));               // 2 humans -> a vote starts (h1 auto-yes)
  check('pause vote started', !!room.state.pause.vote);
  room._voteEndsMs = Date.now() - 1;                // h2 never votes
  rm.resolveVote(room);
  check('pause PASSED by default (no opposing majority)', room.state.pause.active === true);
}

console.log('7) Pause majority-deny: 3 humans, 2 vote NO -> FAILS');
{
  const rm = new RoomManager(io);
  const room = mkRoom(rm, 'PV2');
  seatHuman(room, 'BLUE', 'LORD', 'h1');
  seatHuman(room, 'BLUE', 'COMMANDER', 'h2');
  seatHuman(room, 'BLUE', 'STEWARD', 'h3');
  rm.initiatePause(sock(room, 'h1'));
  rm.castVote(sock(room, 'h2'), { vote: false });
  rm.castVote(sock(room, 'h3'), { vote: false });   // all voted -> resolves immediately
  check('pause FAILED (2 of 3 opposed)', room.state.pause.active === false && room.state.pause.vote === null);
}

console.log('\n' + (fail ? ('SURRENDER TEST FAIL (' + fail + ' failed, ' + pass + ' passed)') : ('SURRENDER TEST OK (' + pass + ' passed)')));
process.exit(fail ? 1 : 0);
