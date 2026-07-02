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

// 3. Drain on own outpost: -0.2/s.
g = host(outpost, { militia: 5 }); g.energy = 50; team.armies = [g];
army.tickEnergy(state, team, 1); near(g.energy, 49.8, 'own-outpost drain -0.2/s');

// 4. Drain on open/enemy ground: -0.25/s.
g = host(open, { militia: 5 }); g.energy = 50; team.armies = [g];
army.tickEnergy(state, team, 1); near(g.energy, 49.75, 'open-ground drain -0.25/s');

// 5. Marching triples the drain (open ground -> -0.75/s).
g = host(open, { militia: 5 }); g.energy = 50; g.moving = { route: [open, outpost], legIndex: 0 }; team.armies = [g];
army.tickEnergy(state, team, 1); near(g.energy, 49.25, 'marching triples drain (-0.75/s on open)');

// 5b. Field Supply Train (Steward action) halves the drain.
g = host(open, { militia: 5 }); g.energy = 50; team.armies = [g];
team.stewardEffects = [{ id: 'fieldSupply', until: (state.elapsed || 0) + 90 }];
army.tickEnergy(state, team, 1); near(g.energy, 49.875, 'supply train halves open drain (-0.125/s)');
team.stewardEffects = [];

// 5c. Field Provisioning research (tier 2, -20%) reduces the drain.
g = host(open, { militia: 5 }); g.energy = 50; team.armies = [g];
team.research = Object.assign(team.research || {}, { provisioning: 2 });
army.tickEnergy(state, team, 1); near(g.energy, 49.8, 'provisioning T2 cuts open drain 20% (-0.2/s)');
team.research.provisioning = 0;

// 6. Energy never goes below 0.
g = host(open, { militia: 5 }); g.energy = 0.2; team.armies = [g];
army.tickEnergy(state, team, 1); near(g.energy, 0, 'energy floored at 0');

// 7. Combat-penalty curve (attack & defence multiplier): smooth FLOOR + (1-FLOOR)*(e/100)^EXP.
function mult(e) { const h = host(home, { militia: 1 }); h.energy = e; return army.energyMult(h); }
const B2 = require('../shared/balance.js');
const F = B2.ENERGY_MULT_FLOOR, EX = B2.ENERGY_MULT_EXP;
const curve = (e) => F + (1 - F) * Math.pow(Math.max(0, Math.min(100, e)) / 100, EX);
near(mult(100), 1.0, 'energy 100 -> full strength (x1.0)');
near(mult(0), F, 'energy 0 -> floor (x' + F + ')');
near(mult(50), curve(50), 'energy 50 -> on the curve');
near(mult(20), curve(20), 'energy 20 -> on the curve');
ok(mult(30) < mult(70) && mult(70) < mult(100), 'penalty is monotonic: tireder = weaker');

console.log(fails === 0 ? '\nENERGY MECHANIC OK' : '\n' + fails + ' FAILURES');
process.exit(fails === 0 ? 0 : 1);
