/* Verifies the AI's relative-strength maths (winChanceAt, used for the capture/flee decision) accounts for
   deployment energy on BOTH sides — so a host flees a FRESH strong army but holds against a TIRED one, and a
   tired attacker is correctly judged weaker. Mirrors how decide()/guardPost decide to run away. */
'use strict';
const C = require('../shared/constants.js');
const S = require('../shared/schema.js');
const army = require('../server/systems/army.js');

// winChanceAt isn't exported, so reproduce the AI's exact strength comparison via the public helpers it uses.
function hostStr(team, g) { const p = army.hostPower(team, g); return p.atk + p.def; }

let fails = 0;
function ok(cond, msg) { if (!cond) { console.log('  FAIL:', msg); fails++; } else { console.log('  ok:', msg); } }

const state = S.createInitialState({ roomCode: 'HR', seed: 4, devMode: true, matchSeconds: 720 });
const blue = state.teams.BLUE, red = state.teams.RED;
function mk(team, units, energy) {
  const g = { id: S.uid('a'), team: team.team, name: 'H', units: {}, gear: {}, area: 'x',
    formation: 'line', stance: 'balanced', morale: 'normal', moving: null, mission: { type: 'idle' }, energy };
  for (const u of C.UNITS) g.units[u] = 0; Object.assign(g.units, units); army.ensureGear(g); return g;
}

// Our small raiding host (fresh) vs an enemy army twice its size.
const ours = mk(blue, { spearman: 6 }, 100);
const foeFresh = mk(red, { spearman: 12 }, 100);
const foeTired = mk(red, { spearman: 12 }, 5);   // energy 5 → x0.5 combat penalty

const oursStr = hostStr(blue, ours);
const vsFresh = oursStr / (oursStr + hostStr(red, foeFresh));
const vsTired = oursStr / (oursStr + hostStr(red, foeTired));

console.log('  win-share vs FRESH 12-stack: ' + vsFresh.toFixed(3) + ' | vs TIRED 12-stack: ' + vsTired.toFixed(3));
ok(vsFresh < 0.4, 'vs a FRESH double-size army our win-share is low (would FLEE)');
ok(vsTired > vsFresh + 0.08, 'a TIRED enemy is judged materially weaker (energy folded into the comparison)');
ok(vsTired > 0.45, 'vs the same army when EXHAUSTED we would hold/fight instead of fleeing');

// Our own energy also matters: the same host, exhausted, is judged weaker.
const oursTired = mk(blue, { spearman: 6 }, 5);
ok(hostStr(blue, oursTired) < oursStr * 0.75, 'our OWN low energy lowers our assessed strength too');

console.log(fails === 0 ? '\nHIT-RUN ENERGY-AWARE OK' : '\n' + fails + ' FAILURES');
process.exit(fails === 0 ? 0 : 1);
