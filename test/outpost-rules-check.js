/* Headless check for two outpost rules:
   (1) the Steward must commit at least CLAIM_MIN_INSTALMENT (10) wood per outpost instalment;
   (2) capturing a location DESTROYS its outpost — the captor owns the ground but must build anew. */
'use strict';
const C = require('../shared/constants.js');
const B = require('../shared/balance.js');
const S = require('../shared/schema.js');
const sites = require('../server/systems/sites.js');
const army = require('../server/systems/army.js');

function assert(cond, msg) { if (!cond) { console.error('FAIL:', msg); process.exit(1); } console.log('ok -', msg); }
function units(map) { const o = {}; for (const u of C.UNITS) o[u] = 0; for (const k in map) o[k] = map[k]; return o; }

// ---- (1) Minimum instalment ----
{
  const state = S.createInitialState({ roomCode: 'OR1', devMode: true, matchSeconds: 720 });
  state.status = 'playing';
  const T = state.teams.BLUE; T._elapsed = 0;
  let areaId = null;
  for (const id in state.areas) { const a = state.areas[id]; if (a.revealed.BLUE && a.site && !a.owner && a.claimedBy !== 'BLUE') { areaId = id; break; } }

  T.resources.wood = 5;                       // below the 10-wood minimum
  let r = sites.claim(state, T, areaId);
  assert(!r.ok && /at least 10/.test(r.reason || ''), 'claim rejected with < 10 wood (' + (r.reason || '') + ')');
  assert(!state.areas[areaId].claimFund, 'no partial fund created when under the minimum');

  T.resources.wood = 15;                       // a valid instalment
  r = sites.claim(state, T, areaId);
  assert(r.ok && state.areas[areaId].claimFund && state.areas[areaId].claimFund.wood === 15, 'committed a 15-wood instalment (15/40)');

  T.resources.wood = 8;                         // 25 left to pay, 8 < 10 minimum → rejected
  r = sites.claim(state, T, areaId);
  assert(!r.ok && /at least 10/.test(r.reason || ''), 'further instalment under 10 wood rejected while 25 remains');

  T.resources.wood = 25;                        // finishes it
  r = sites.claim(state, T, areaId);
  assert(r.ok && /fully funded/i.test(r.msg || ''), 'outpost fully funded once 40 wood committed');
}

// ---- (2) Capturing a location destroys its outpost ----
{
  const state = S.createInitialState({ roomCode: 'OR2', devMode: true, matchSeconds: 720 });
  state.status = 'playing';
  const RED = state.teams.RED;
  // Pick a non-base area, make it a developed BLUE outpost with no buildings left (all razed).
  let id = null;
  for (const k in state.areas) { const a = state.areas[k]; if (a.terrain !== 'base' && a.site) { id = k; break; } }
  const area = state.areas[id];
  area.owner = 'BLUE'; area.claimedBy = 'BLUE'; area.buildings = {};
  area.site.level = 3; area.site.cargo = 50; area.site.worked = true;
  area.captureProgress = B.CAPTURE_AFTER_RAZE;   // on the brink of being seized
  // A RED host sits on it with no BLUE defender.
  const ar = state.areas[id];
  RED.armies.push({ id: S.uid('army'), team: 'RED', name: 'Raiders', units: units({ militia: 5 }), hasArmor: false, formation: 'line', stance: 'balanced', area: id, moving: null, mission: { type: 'raid' }, morale: 'normal', x: ar.x, y: ar.y });

  army.tickRaze(state, 1, { chance: () => false, range: () => 0 }, () => {});

  assert(area.owner === 'RED', 'captor (RED) now owns the ground');
  assert(area.claimedBy === null, 'the outpost was DESTROYED on capture (claimedBy reset)');
  assert(area.site.worked === false && area.site.cargo === 0 && area.site.level === 1, 'site reset: not worked, no cargo, level back to 1');
  // RED must now be able to (re)claim its own outpost-less ground.
  RED._elapsed = 0; RED.resources.wood = 100;
  const rc = sites.claim(state, RED, id);
  assert(rc.ok, 'RED can build a NEW outpost on the captured ground (' + (rc.msg || '') + ')');
}

console.log('OUTPOST-RULES OK');
