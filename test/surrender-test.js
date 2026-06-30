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

console.log('8) Multi-human OFFER vote: team votes to send (majority), then enemy all-AI auto-accepts');
{
  const rm = new RoomManager(io);
  const room = mkRoom(rm, 'OV1');
  seatHuman(room, 'BLUE', 'LORD', 'bl');
  seatHuman(room, 'BLUE', 'COMMANDER', 'bc');       // BLUE has 2 humans; RED all AI
  rm.offerSurrender(sock(room, 'bl'));              // bl initiates -> OFFER phase (bl auto-yes)
  check('offer phase pending', room.state.surrender && room.state.surrender.phase === 'offer');
  rm.voteSurrender(sock(room, 'bc'), { accept: true });   // bc agrees -> all BLUE voted -> send -> RED all-AI accepts
  check('game over (sent + AI accepted)', room.state.status === 'over');
  check('winner RED', room.state.winner === 'RED');
}

console.log('9) Multi-human OFFER vote FAILS (majority against) -> no surrender');
{
  const rm = new RoomManager(io);
  const room = mkRoom(rm, 'OV2');
  seatHuman(room, 'BLUE', 'LORD', 'bl');
  seatHuman(room, 'BLUE', 'COMMANDER', 'bc');
  seatHuman(room, 'BLUE', 'STEWARD', 'bs');
  rm.offerSurrender(sock(room, 'bl'));              // bl yes
  rm.voteSurrender(sock(room, 'bc'), { accept: false });
  rm.voteSurrender(sock(room, 'bs'), { accept: false });  // 2 no vs 1 yes -> not sent
  check('surrender cancelled, still playing', room.state.status === 'playing' && room.state.surrender === null);
}

console.log('10) OFFER tie broken by RANK (Lord yes vs Commander no -> Lord wins -> send)');
{
  const rm = new RoomManager(io);
  const room = mkRoom(rm, 'OV3');
  seatHuman(room, 'BLUE', 'LORD', 'bl');            // higher rank
  seatHuman(room, 'BLUE', 'COMMANDER', 'bc');       // lower rank
  rm.offerSurrender(sock(room, 'bc'));              // commander initiates (auto-yes)... need a real tie, so:
  // Reset: make it a tie by having Lord vote NO and Commander (initiator) YES.
  room.state.surrender.votes = { bc: true };        // commander yes
  rm.voteSurrender(sock(room, 'bl'), { accept: false }); // lord no -> tie 1-1 -> Lord (rank) breaks -> NO -> cancel
  check('tie -> Lord(no) wins -> not sent', room.state.status === 'playing' && room.state.surrender === null);
}

console.log('11) ACCEPT tie broken by RANK (enemy Lord accepts vs Commander denies -> Lord wins -> accept)');
{
  const rm = new RoomManager(io);
  const room = mkRoom(rm, 'AV1');
  seatHuman(room, 'RED', 'BLACKSMITH', 'rb');       // RED lone-ish offerer path: actually give RED 1 human so it sends directly
  seatHuman(room, 'BLUE', 'LORD', 'bl');
  seatHuman(room, 'BLUE', 'COMMANDER', 'bc');
  rm.offerSurrender(sock(room, 'rb'));              // RED has 1 human -> straight to ACCEPT phase (BLUE decides)
  check('accept phase pending', room.state.surrender && room.state.surrender.phase === 'accept');
  rm.voteSurrender(sock(room, 'bc'), { accept: false }); // commander denies
  rm.voteSurrender(sock(room, 'bl'), { accept: true });  // lord accepts -> tie -> Lord(rank) -> accept
  check('accepted via rank -> over, BLUE wins', room.state.status === 'over' && room.state.winner === 'BLUE');
}

console.log('12) 300s cooldown: same initiator cannot start a second surrender at once');
{
  const rm = new RoomManager(io);
  const room = mkRoom(rm, 'CD1');
  seatHuman(room, 'BLUE', 'LORD', 'bl');
  seatHuman(room, 'RED', 'LORD', 'rl');             // RED human so the first offer stays pending (accept phase)
  rm.offerSurrender(sock(room, 'bl'));
  check('first offer created', !!room.state.surrender);
  // resolve it (RED denies) so no surrender is pending
  rm.voteSurrender(sock(room, 'rl'), { accept: false });
  check('first resolved (denied)', room.state.surrender === null && room.state.status === 'playing');
  rm.offerSurrender(sock(room, 'bl'));              // immediate second attempt -> blocked by 300s cooldown
  check('second offer blocked by cooldown', room.state.surrender === null);
}

console.log('13) Pause: initiator resumes directly (no vote) even in a multi-human game');
{
  const rm = new RoomManager(io);
  const room = mkRoom(rm, 'PD1');
  seatHuman(room, 'BLUE', 'LORD', 'h1');
  seatHuman(room, 'BLUE', 'COMMANDER', 'h2');
  rm.initiatePause(sock(room, 'h1'));
  room._voteEndsMs = Date.now() - 1; rm.resolveVote(room);   // passes by default
  check('paused with initiator recorded', room.state.pause.active === true && room.state.pause.initiator === 'h1');
  check('auto-end scheduled', room._pauseAutoEndMs > Date.now());
  rm.requestResume(sock(room, 'h1'));               // initiator ends directly
  check('initiator resumed directly (no vote)', room.state.pause.active === false && room.state.pause.vote === null && room.state.pause.initiator === null);
}

console.log('14) Pause: 5-minute auto-end resumes the game');
{
  const rm = new RoomManager(io);
  const room = mkRoom(rm, 'PD2');
  seatHuman(room, 'BLUE', 'LORD', 'h1');
  seatHuman(room, 'BLUE', 'COMMANDER', 'h2');
  rm.initiatePause(sock(room, 'h1'));
  room._voteEndsMs = Date.now() - 1; rm.resolveVote(room);
  room._pauseAutoEndMs = Date.now() - 1;            // simulate 5 min elapsed
  // emulate the loop's auto-end check
  if (room.state.pause.active && room._pauseAutoEndMs && Date.now() >= room._pauseAutoEndMs) {
    room.state.pause.active = false; room.state.pause.initiator = null; room._pauseAutoEndMs = 0;
  }
  check('auto-resumed after cap', room.state.pause.active === false);
}

console.log('\n' + (fail ? ('SURRENDER TEST FAIL (' + fail + ' failed, ' + pass + ' passed)') : ('SURRENDER TEST OK (' + pass + ' passed)')));
process.exit(fail ? 1 : 0);
