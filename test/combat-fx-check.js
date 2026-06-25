/* Headless check: the server publishes per-host combat floaters (snap.combatFx) — red "-N" losses and
   "🛡 Saved!" armour saves — so the client can show what's happening during a battle. */
'use strict';
const C = require('../shared/constants.js');
const S = require('../shared/schema.js');
const sim = require('../server/sim.js');
const army = require('../server/systems/army.js');

function assert(cond, msg) { if (!cond) { console.error('FAIL:', msg); process.exit(1); } console.log('ok -', msg); }
function units(map) { const o = {}; for (const u of C.UNITS) o[u] = 0; for (const k in map) o[k] = map[k]; return o; }
function gear(map) { const o = {}; for (const u of C.UNITS) o[u] = []; for (const k in map) o[k] = map[k]; return o; }
function host(st, team, area, u, g, extra) { const ar = st.areas[area]; return Object.assign({ id: S.uid('army'), team, name: team[0], units: units(u), gear: gear(g || {}), hasArmor: !!(g && Object.keys(g).length), formation: 'line', stance: 'balanced', area, moving: null, mission: { type: 'engage' }, morale: 'normal', x: ar.x, y: ar.y }, extra || {}); }

// A weak, heavily-armoured BLUE host vs an overwhelming unarmoured RED host at one area: BLUE takes
// many losses (red "-N") and its armour turns a good share of them ("🛡 Saved!").
let losses = 0, saves = 0, hadCoords = true;
for (let trial = 0; trial < 6; trial++) {
  const st = S.createInitialState({ roomCode: 'FX' + trial, devMode: true, matchSeconds: 720 });
  st.status = 'playing';
  army.garrison(st, st.teams.BLUE).units = units({}); army.garrison(st, st.teams.RED).units = units({});
  const bGear = []; for (let i = 0; i < 10; i++) bGear.push({ w: 1, a: 3.0 });   // legendary armour → ~30% save
  st.teams.BLUE.armies.push(host(st, 'BLUE', 'central_mine', { swordsman: 10 }, { swordsman: bGear }));
  st.teams.RED.armies.push(host(st, 'RED', 'central_mine', { swordsman: 30 }, {}));
  for (let i = 0; i < 30; i++) {
    sim.step(st);
    const snap = sim.snapshot(st);
    assert(Array.isArray(snap.combatFx), '_'); // combatFx present every tick
    for (const e of (snap.combatFx || [])) {
      if (typeof e.x !== 'number' || typeof e.y !== 'number' || !e.team) hadCoords = false;
      losses += e.losses || 0; saves += e.saves || 0;
    }
    if (army.unitCount(st.teams.BLUE.armies.find((h) => !h.isGarrison) || { units: {} }) < 0.5) break;
  }
}
assert(losses > 0, 'combatFx reports soldier losses (the red "-N" floaters): ' + losses);
assert(saves > 0, 'combatFx reports armour saves (the "🛡 Saved!" floaters): ' + saves);
assert(hadCoords, 'every combatFx entry carries x/y/team for on-screen placement');
// Sanity: with 30% armour, saves should be a meaningful fraction of attempts (not a fluke).
assert(saves / (losses + saves) > 0.12, 'save rate is in a sane range (~30% expected): ' + (saves / (losses + saves)).toFixed(2));

console.log('COMBAT-FX OK (losses ' + losses + ', saves ' + saves + ')');
