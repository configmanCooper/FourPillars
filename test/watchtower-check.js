/* Headless check: the Watchtower is the Keep core — present from the start, occupies a slot, can't be
   built, is razed LAST (only after every other Keep building), shoots besiegers like a militia, and
   its fall = total victory for the attacker. */
'use strict';
const C = require('../shared/constants.js');
const B = require('../shared/balance.js');
const S = require('../shared/schema.js');
const army = require('../server/systems/army.js');
const buildings = require('../server/systems/buildings.js');

function assert(cond, msg) { if (!cond) { console.error('FAIL:', msg); process.exit(1); } console.log('ok -', msg); }
function units(map) { const o = {}; for (const u of C.UNITS) o[u] = 0; for (const k in map) o[k] = map[k]; return o; }

const st = S.createInitialState({ roomCode: 'WT', devMode: true, matchSeconds: 720 });
st.status = 'playing';
const BLUE = st.teams.BLUE, RED = st.teams.RED;

// Every Keep starts with a Watchtower occupying a slot.
assert((st.areas.blue_base.buildings.watchtower || 0) === 1, 'each Keep starts with a Watchtower');
assert(B.BUILDINGS.watchtower && B.BUILDINGS.watchtower.fixed, 'the Watchtower is a fixed (unbuildable) building');

// It cannot be built.
const r = buildings.queueBuilding(st, BLUE, 'blue_base', 'watchtower');
assert(!r.ok, 'players cannot build a Watchtower (' + (r.reason || '') + ')');

// Siege blue_base with a strong RED host. Build the Keep up fully first so the siege is long enough
// for the (deliberately weak, 1-militia) Watchtower to reliably chip the besiegers.
BLUE.armies = [];   // no defenders
st.areas.blue_base.buildings = { walls: 3, house: 6, farm: 4, lumberCamp: 3, mine: 3, storehouse: 3, barracks: 2, watchtower: 1 };
const ar = st.areas.blue_base;
RED.armies = RED.armies.filter((h) => h.isGarrison);
RED.armies.push({ id: S.uid('army'), team: 'RED', name: 'Siege', units: units({ militia: 20 }), gear: (function () { const g = {}; for (const u of C.UNITS) g[u] = []; return g; })(), hasArmor: false, formation: 'line', stance: 'balanced', area: 'blue_base', moving: null, mission: { type: 'siege' }, morale: 'normal', x: ar.x, y: ar.y });
army.ensureGear(RED.armies[RED.armies.length - 1]);
const rng = require('../server/rng.js').makeRng(5);

const redStart = army.unitCount(RED.armies.find((h) => !h.isGarrison));
let watchtowerStillUpWhenOthersGone = true, won = false, otherBuildingsGoneBeforeWT = false;
for (let i = 0; i < 3000 && !won; i++) {
  army.tickRaze(st, 1, rng, () => {});
  const bld = st.areas.blue_base.buildings;
  const others = (bld.house || 0) + (bld.farm || 0) + (bld.lumberCamp || 0) + (bld.mine || 0) + (bld.walls || 0) + (bld.storehouse || 0) + (bld.barracks || 0);
  const wt = bld.watchtower || 0;
  // While other buildings remain, the watchtower must still stand (razed last).
  if (others > 0 && wt < 1) watchtowerStillUpWhenOthersGone = false;
  if (others === 0 && wt === 1) otherBuildingsGoneBeforeWT = true;   // reached the state where only the WT is left
  if (BLUE.keep.hp <= 0) won = true;
}
assert(watchtowerStillUpWhenOthersGone, 'the Watchtower is never razed before the other Keep buildings');
assert(otherBuildingsGoneBeforeWT, 'the siege razes all other buildings, leaving only the Watchtower');
assert(won && (st.areas.blue_base.buildings.watchtower || 0) === 0, 'razing the Watchtower destroys the Keep (hp→0) = victory');
const redEnd = army.unitCount(RED.armies.find((h) => !h.isGarrison) || { units: {} });
assert(redEnd < redStart, 'the Watchtower shot besiegers during the siege (RED lost ' + Math.round(redStart - redEnd) + ' attacking it)');

console.log('WATCHTOWER OK');
