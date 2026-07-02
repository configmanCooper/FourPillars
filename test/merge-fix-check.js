/* Proves the merge-fix: energy and gear quality now BITE in real battle resolution (previously the merged
   host passed to strength() carried neither, so energyMult was always x1 and gear always {w:1,a:0}).
   Runs the real resolveCombat loop many times and checks outcomes. */
'use strict';
const C = require('../shared/constants.js');
const S = require('../shared/schema.js');
const army = require('../server/systems/army.js');
const { makeRng } = require('../server/rng.js');

let fails = 0;
function ok(cond, msg) { if (!cond) { console.log('  FAIL:', msg); fails++; } else { console.log('  ok:', msg); } }

function host(team, type, n, opts) {
  opts = opts || {};
  const g = { id: S.uid('a'), team, name: type, units: {}, gear: {}, area: 'mid',
    formation: 'line', stance: 'balanced', morale: 'normal', energy: opts.energy != null ? opts.energy : 100 };
  for (const u of C.UNITS) g.units[u] = 0;
  g.units[type] = n; army.ensureGear(g);
  // Give each soldier a weapon/armour quality record if requested (w = weapon quality mult, a = armour).
  if (opts.w != null || opts.a != null) {
    const recs = [];
    for (let i = 0; i < n; i++) recs.push({ w: opts.w != null ? opts.w : 1, a: opts.a != null ? opts.a : 0 });
    g.gear[type] = recs;
    if (opts.a) g.hasArmor = true;
  }
  return g;
}
// One battle to the death: BLUE spec vs RED spec. Returns 'BLUE' | 'RED' | 'DRAW'.
function battle(blue, red, seed) {
  const state = S.createInitialState({ roomCode: 'MF', seed: 7, devMode: true, matchSeconds: 720 });
  state.status = 'playing';
  let mid = null; for (const id in state.areas) { if (state.areas[id].terrain !== 'base') { mid = id; break; } }
  state.areas[mid].owner = null; state.areas[mid].buildings = {}; state.areas[mid].site = null;
  state.areas[mid].scouted = { BLUE: true, RED: true };
  blue.area = mid; red.area = mid;
  state.teams.BLUE.armies = [blue]; state.teams.RED.armies = [red];
  state.teams.BLUE.resources.arrows = 999; state.teams.RED.resources.arrows = 999;
  let guard = 0;
  while (guard < 400) {
    guard++; const rng = makeRng((seed + guard * 2654435761) >>> 0); state.tick++;
    army.resolveCombat(state, 1, rng, null);
    const bn = state.teams.BLUE.armies.reduce((s, g) => s + army.unitCount(g), 0);
    const rn = state.teams.RED.armies.reduce((s, g) => s + army.unitCount(g), 0);
    if (bn < 0.5 || rn < 0.5) break;
  }
  const bn = state.teams.BLUE.armies.reduce((s, g) => s + army.unitCount(g), 0);
  const rn = state.teams.RED.armies.reduce((s, g) => s + army.unitCount(g), 0);
  return bn > rn ? 'BLUE' : (rn > bn ? 'RED' : 'DRAW');
}
function rate(mkBlue, mkRed, trials) {
  let bw = 0; for (let i = 0; i < trials; i++) { if (battle(mkBlue(), mkRed(), 100 + i * 6779) === 'BLUE') bw++; } return bw / trials;
}

const N = 200;
// 1. ENERGY BITES: equal count & gear, BLUE fully rested vs RED exhausted → rested BLUE should dominate.
const eng = rate(() => host('BLUE', 'swordsman', 5, { energy: 100 }), () => host('RED', 'swordsman', 5, { energy: 0 }), N);
console.log('  rested-5 vs exhausted-5 → BLUE win rate: ' + (eng * 100).toFixed(0) + '%');
ok(eng > 0.75, 'fully-rested side beats an equal exhausted side decisively (energy now applies)');

// 2. GEAR BITES: equal count & energy, BLUE high-quality weapons+armour vs RED basic → quality should win.
const gr = rate(() => host('BLUE', 'swordsman', 5, { w: 1.5, a: 1.0 }), () => host('RED', 'swordsman', 5, { w: 1, a: 0 }), N);
console.log('  quality-5 vs basic-5 → BLUE win rate: ' + (gr * 100).toFixed(0) + '%');
ok(gr > 0.75, 'high-quality gear beats equal-count basic gear (weapon/armour quality now applies)');

// 3. CONTROL: equal count, energy AND gear → near coin-flip (no phantom advantage).
const ctl = rate(() => host('BLUE', 'swordsman', 5, { energy: 90 }), () => host('RED', 'swordsman', 5, { energy: 90 }), N);
console.log('  even-5 vs even-5 → BLUE win rate: ' + (ctl * 100).toFixed(0) + '%');
ok(ctl > 0.35 && ctl < 0.65, 'equal sides remain a coin-flip (fix introduces no bias)');

console.log(fails === 0 ? '\nMERGE-FIX (energy+gear apply in battle) OK' : '\n' + fails + ' FAILURES');
process.exit(fails === 0 ? 0 : 1);
