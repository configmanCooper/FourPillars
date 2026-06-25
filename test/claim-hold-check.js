/* Headless check: wood reserved AWAY from the Steward (e.g. for the Blacksmith) must block the
   Steward from funding an outpost — including the AI's direct sites.claim() path that bypasses the
   applyAction gate. A one-time access grant, or reserving it FOR the Steward, lets it through. */
'use strict';
const S = require('../shared/schema.js');
const economy = require('../server/systems/economy.js');
const sites = require('../server/systems/sites.js');

function assert(cond, msg) { if (!cond) { console.error('FAIL:', msg); process.exit(1); } console.log('ok -', msg); }

const state = S.createInitialState({ roomCode: 'CLM', devMode: true, matchSeconds: 720 });
state.status = 'playing';
const T = state.teams.BLUE;
T._elapsed = state.elapsed;

// Find a claimable site revealed to BLUE.
let areaId = null;
for (const id in state.areas) { const a = state.areas[id]; if (a.revealed.BLUE && a.site && !a.owner && a.claimedBy !== 'BLUE') { areaId = id; break; } }
assert(areaId, 'found a claimable site for BLUE: ' + areaId);

T.resources.wood = 100;

// 1) Reserve wood for the BLACKSMITH (Steward not allowed) → Steward claim must be blocked, no spend.
economy.setHold(state, T, 'wood', 0, ['BLACKSMITH']);
let before = T.resources.wood;
let r = sites.claim(state, T, areaId);
assert(!r.ok && /reserved/i.test(r.reason || ''), 'Steward claim DENIED while wood reserved for the Blacksmith (' + (r.reason || '') + ')');
assert(T.resources.wood === before, 'no wood was spent on the outpost while reserved');
assert(!state.areas[areaId].claimFund, 'no partial claim fund was created while reserved');

// 2) A one-time access grant to the Steward lets it fund the outpost.
economy.grantHold(T, 'wood', 'STEWARD', state.elapsed + 30);
before = T.resources.wood;
r = sites.claim(state, T, areaId);
assert(r.ok, 'Steward claim ALLOWED after a one-time access grant (' + (r.msg || '') + ')');
assert(T.resources.wood < before, 'wood was spent toward the outpost after the grant');

// 3) Reserving wood FOR the Steward also allows it.
const state2 = S.createInitialState({ roomCode: 'CLM2', devMode: true, matchSeconds: 720 });
state2.status = 'playing'; const T2 = state2.teams.BLUE; T2._elapsed = 0; T2.resources.wood = 100;
let a2 = null; for (const id in state2.areas) { const a = state2.areas[id]; if (a.revealed.BLUE && a.site && !a.owner && a.claimedBy !== 'BLUE') { a2 = id; break; } }
economy.setHold(state2, T2, 'wood', 0, ['STEWARD']);
const b2 = T2.resources.wood;
const r2 = sites.claim(state2, T2, a2);
assert(r2.ok && T2.resources.wood < b2, 'Steward claim ALLOWED when wood is reserved FOR the Steward');

console.log('CLAIM-HOLD OK');
