/* Headless check: the AI Lord proactively RESERVES iron for the Blacksmith at war (with a stated
   goal), and DENIES a Commander request to USE that reserved iron — while granting an unreserved ask. */
'use strict';
const S = require('../shared/schema.js');
const sim = require('../server/sim.js');
const ai = require('../server/systems/ai.js');
const comms = require('../server/systems/comms.js');
const { makeRng } = require('../server/rng.js');

function assert(cond, msg) { if (!cond) { console.error('FAIL:', msg); process.exit(1); } console.log('ok -', msg); }

const state = S.createInitialState({ roomCode: 'RES', devMode: true, matchSeconds: 720 });
state.status = 'playing';
const B = state.teams.BLUE;
const SYS = sim.SYSTEMS;
const rng = makeRng(7);

// Put the kingdom on a clear war footing so iron is strategically reserved for the Blacksmith.
B.aiPersona = B.aiPersona || {};
B.aiPersona.LORD = 'warmonger';

function pin() { B.pop.soldiers = 6; B.resources.iron = 50; }

// 1) The Lord should reserve iron for the Blacksmith, with a byAI/forRole/reason marker.
let reserved = false;
for (let i = 0; i < 600 && !reserved; i++) {
  pin();
  ai.aiTick(state, B, 1, SYS, rng);
  state.elapsed += 1; B._elapsed = state.elapsed;
  const h = B.holds && B.holds.iron;
  if (h && h.byAI && h.forRole === 'BLACKSMITH' && h.reason) reserved = true;
}
assert(reserved, 'Lord reserved iron for the Blacksmith with a stated goal');
console.log('   reason:', B.holds.iron.reason);

// 2) A Commander request to USE that reserved iron should be DENIED (not the role it was reserved for,
//    no emergency, no surplus).
comms.createRequest(state, B, 'COMMANDER', 'LORD', 'USE', { resource: 'iron', reason: 'want to train' });
let declined = false, vanished = false;
for (let i = 0; i < 600 && !declined; i++) {
  pin();
  ai.aiTick(state, B, 1, SYS, rng);
  state.elapsed += 1; B._elapsed = state.elapsed;
  const r = B.requests.find((q) => q.fromRole === 'COMMANDER' && q.type === 'USE' && q.payload && q.payload.resource === 'iron');
  if (!r) { vanished = true; break; }
  if (r.status === 'declined') declined = true;
  if (r.status === 'accepted') { console.error('FAIL: Lord granted reserved iron to the Commander'); process.exit(1); }
}
assert(declined && !vanished, 'Lord DENIED the Commander use of iron reserved for the Blacksmith');

// 3) Control: a reserved resource the Lord has in genuine SURPLUS should still be granted on request.
const economy = require('../server/systems/economy.js');
economy.setHold(state, B, 'food', 0, []); // reserve food (Lord only) so the Steward's ask isn't auto-withdrawn
comms.createRequest(state, B, 'STEWARD', 'LORD', 'USE', { resource: 'food', reason: 'rations' });
let granted = false;
for (let i = 0; i < 400 && !granted; i++) {
  pin(); B.resources.food = 140; // genuine surplus
  ai.aiTick(state, B, 1, SYS, rng);
  state.elapsed += 1; B._elapsed = state.elapsed;
  const r = B.requests.find((q) => q.fromRole === 'STEWARD' && q.type === 'USE' && q.payload && q.payload.resource === 'food');
  if (!r) break;
  if (r.status === 'accepted') granted = true;
  if (r.status === 'declined') { console.error('FAIL: Lord denied a surplus food request'); process.exit(1); }
}
assert(granted, 'Lord granted use of a reserved resource when in genuine surplus (food)');

// 4) Forge relief: wood reserved for the Steward must NOT freeze the Blacksmith's forge — a Blacksmith
//    USE-wood request is granted, while the same request from the Commander is denied. (Freeze the Lord's
//    own reservation manager so this fixed test hold isn't pruned as a non-current strategic candidate.)
(B.aiState.LORD = B.aiState.LORD || { cd: {} }).cd.reserve = 1e9;
function setWoodHold() { economy.setHold(state, B, 'wood', 0, ['STEWARD']); const w = B.holds.wood; w.byAI = true; w.forRole = 'STEWARD'; w.reason = 'to fund new outposts'; }
setWoodHold();
comms.createRequest(state, B, 'BLACKSMITH', 'LORD', 'USE', { resource: 'wood', reason: 'forge spears' });
comms.createRequest(state, B, 'COMMANDER', 'LORD', 'USE', { resource: 'wood', reason: 'want wood' });
let smithWood = false, cmdWoodDenied = false;
for (let i = 0; i < 600 && !(smithWood && cmdWoodDenied); i++) {
  pin(); B.resources.wood = 40; // keep wood scarce (reserved, not surplus)
  if (!(B.holds.wood && B.holds.wood.byAI)) setWoodHold();
  ai.aiTick(state, B, 1, SYS, rng);
  state.elapsed += 1; B._elapsed = state.elapsed;
  const bs = B.requests.find((q) => q.fromRole === 'BLACKSMITH' && q.type === 'USE' && q.payload && q.payload.resource === 'wood');
  const cm = B.requests.find((q) => q.fromRole === 'COMMANDER' && q.type === 'USE' && q.payload && q.payload.resource === 'wood');
  if (bs && bs.status === 'accepted') smithWood = true;
  if (cm && cm.status === 'declined') cmdWoodDenied = true;
}
assert(smithWood, 'Lord granted the Blacksmith reserved wood (forge never frozen)');
assert(cmdWoodDenied, 'Lord still denied the Commander the same reserved wood');

console.log('LORD-RESERVATIONS OK');
