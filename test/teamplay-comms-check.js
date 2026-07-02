/* Verifies the teamplay comms additions:
   1. Chat governor: an AI seat's flavour ('chat') lines are throttled to ~1 per 4s; human chat and
      'response'/'system' lines are never throttled.
   2. Human-deed reaction: when a human accepts an AI seat's request, that AI thanks them ONCE (60s cap). */
'use strict';
const S = require('../shared/schema.js');
const C = require('../shared/constants.js');
const comms = require('../server/systems/comms.js');
const sim = require('../server/sim.js');

let fails = 0;
function ok(cond, msg) { if (!cond) { console.log('  FAIL:', msg); fails++; } else { console.log('  ok:', msg); } }

const st = S.createInitialState({ roomCode: 'TC', seed: 1, matchPreset: 'standard' });
st.status = 'playing';
const team = st.teams.BLUE;

// --- 1. Chat governor ---
st.elapsed = 100;
const base = team.comms.length;
comms.postChat(st, team, 'COMMANDER', 'flavour one', 'chat');   // AI 'chat' → passes (first)
comms.postChat(st, team, 'COMMANDER', 'flavour two', 'chat');   // AI 'chat' 0s later → throttled
ok(team.comms.length === base + 1, 'second AI flavour line within 4s is throttled');
comms.postChat(st, team, 'COMMANDER', 'a response', 'response'); // 'response' → never throttled
ok(team.comms.length === base + 2, "'response' lines are never throttled");
st.elapsed = 105;                                               // >4s later
comms.postChat(st, team, 'COMMANDER', 'flavour three', 'chat'); // AI 'chat' after the gap → passes
ok(team.comms.length === base + 3, 'AI flavour passes again after the 4s gap');
// Human seat chat is never throttled.
team.slots.STEWARD.controller = 'human'; team.slots.STEWARD.playerId = 'h1';
const b2 = team.comms.length;
comms.postChat(st, team, 'STEWARD', 'human line 1', 'chat');
comms.postChat(st, team, 'STEWARD', 'human line 2', 'chat');
ok(team.comms.length === b2 + 2, 'human chat is never throttled');

// --- 2. Human-deed reaction ---
const st2 = S.createInitialState({ roomCode: 'TC2', seed: 2, matchPreset: 'standard' });
st2.status = 'playing'; st2.elapsed = 50;
const tm = st2.teams.BLUE;
tm.slots.LORD.controller = 'human'; tm.slots.LORD.playerId = 'p1'; tm.slots.LORD.name = 'Human';
tm.aiPersona = { COMMANDER: 'wolf' };
comms.createRequest(st2, tm, 'COMMANDER', 'LORD', 'RECRUITS', {});
let r = tm.requests.find((x) => x.type === 'RECRUITS');
comms.resolveRequest(st2, tm, r.id, true, sim.SYSTEMS, 'LORD');   // human Lord accepts the AI Commander's ask
const thanks1 = tm.comms.filter((m) => m.fromRole === 'COMMANDER' && m.kind === 'chat');
ok(thanks1.length === 1, 'AI Commander thanks the human once for accepting its request');
// A second accept within 60s does NOT thank again (cap).
comms.createRequest(st2, tm, 'COMMANDER', 'LORD', 'TRAINERS', {});
r = tm.requests.find((x) => x.type === 'TRAINERS');
comms.resolveRequest(st2, tm, r.id, true, sim.SYSTEMS, 'LORD');
const thanks2 = tm.comms.filter((m) => m.fromRole === 'COMMANDER' && m.kind === 'chat');
ok(thanks2.length === 1, 'no repeat thanks within the 60s cooldown');

console.log(fails === 0 ? '\nTEAMPLAY COMMS OK' : '\n' + fails + ' FAILURES');
process.exit(fails === 0 ? 0 : 1);
