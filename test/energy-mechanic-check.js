/* Regression test for the soldier deployment-energy mechanic (army.js).
   Verifies: regen at the Keep, drain on own outpost / open ground, doubled drain while moving,
   the 0 floor, and the combat-penalty tiers. */
'use strict';
const C = require('../shared/constants.js');
const S = require('../shared/schema.js');
const army = require('../server/systems/army.js');

let fails = 0;
function ok(cond, msg) { if (!cond) { console.log('  FAIL:', msg); fails++; } else { console.log('  ok:', msg); } }
function near(a, b, msg, eps) { ok(Math.abs(a - b) <= (eps || 0.0001), msg + ' (got ' + a + ', want ~' + b + ')'); }

const state = S.createInitialState({ roomCode: 'EN', seed: 7, devMode: true, matchSeconds: 720 });
state.status = 'playing';
const team = state.teams.BLUE;
const home = S.homeBase('BLUE');
ok(state.areas[home] && state.areas[home].terrain === 'base', 'homeBase("BLUE") resolves to a base area: ' + home);

// Pick an own outpost and a piece of open ground.
let outpost = null, open = null;
for (const id in state.areas) {
  const a = state.areas[id];
  if (a.terrain === 'base') continue;
  if (!outpost) { outpost = id; a.claimedBy = 'BLUE'; a.owner = 'BLUE'; }
  else if (!open) { open = id; }
  if (outpost && open) break;
}

function host(areaId, units) {
  const g = { id: S.uid('a'), team: 'BLUE', name: 'Test', units: {}, gear: {}, area: areaId,
    formation: 'line', stance: 'balanced', morale: 'normal', moving: null, mission: { type: 'idle' }, energy: 100 };
  for (const u of C.UNITS) g.units[u] = 0;
  Object.assign(g.units, units);
  army.ensureGear(g);
  return g;
}

// 1. Fresh host starts at energy 100.
let g = host(home, { militia: 5 });
near(army.hostEnergy(g), 100, 'fresh host energy = 100');

// 2. Regen at the Keep: +1/s, capped at 100.
g.energy = 95; team.armies = [g];
army.tickEnergy(state, team, 1); near(g.energy, 96, 'keep regen +1/s');
g.energy = 99.8; army.tickEnergy(state, team, 1); near(g.energy, 100, 'keep regen caps at 100');

// 3. Drain on own outpost: -0.4/s.
g = host(outpost, { militia: 5 }); g.energy = 50; team.armies = [g];
army.tickEnergy(state, team, 1); near(g.energy, 49.6, 'own-outpost drain -0.4/s');

// 4. Drain on open/enemy ground: -0.5/s.
g = host(open, { militia: 5 }); g.energy = 50; team.armies = [g];
army.tickEnergy(state, team, 1); near(g.energy, 49.5, 'open-ground drain -0.5/s');

// 5. Moving doubles the drain (open ground -> -1.0/s).
g = host(open, { militia: 5 }); g.energy = 50; g.moving = { route: [open, outpost], legIndex: 0 }; team.armies = [g];
army.tickEnergy(state, team, 1); near(g.energy, 49.0, 'moving doubles drain (-1.0/s on open)');

// 6. Energy never goes below 0.
g = host(open, { militia: 5 }); g.energy = 0.2; team.armies = [g];
army.tickEnergy(state, team, 1); near(g.energy, 0, 'energy floored at 0');

// 7. Combat-penalty tiers (attack & defence multiplier).
function mult(e) { const h = host(home, { militia: 1 }); h.energy = e; return army.energyMult(h); }
near(mult(45), 1.0, 'energy 45 -> no penalty (x1.0)');
near(mult(29), 0.9, 'energy 29 -> x0.9');
near(mult(19), 0.75, 'energy 19 -> x0.75');
near(mult(9), 0.5, 'energy 9 -> x0.5');

console.log(fails === 0 ? '\nENERGY MECHANIC OK' : '\n' + fails + ' FAILURES');
process.exit(fails === 0 ? 0 : 1);
