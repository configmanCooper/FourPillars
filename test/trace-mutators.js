/* Wrap individual army mutators to find which one nets an army-unit drop (these are called by the AI
   and by direct actions). Reports any call where the team's army total decreased. */
'use strict';
const C = require('../shared/constants.js');
const S = require('../shared/schema.js');
const army = require('../server/systems/army.js');
const sim = require('../server/sim.js');

function total(state, tk) { let n = 0; for (const g of state.teams[tk].armies) for (const u of C.UNITS) n += g.units[u] || 0; return n; }
let STATE = null;
const attrib = {};
function wrap(name) {
  const orig = army[name]; if (typeof orig !== 'function') return;
  army[name] = function () {
    const before = STATE ? { BLUE: total(STATE, 'BLUE'), RED: total(STATE, 'RED') } : null;
    const r = orig.apply(this, arguments);
    if (STATE && before) for (const tk of ['BLUE', 'RED']) {
      const drop = before[tk] - total(STATE, tk);
      if (drop > 0.001) {
        const k = name + '|' + tk; attrib[k] = attrib[k] || { count: 0, units: 0, s: [] };
        attrib[k].count++; attrib[k].units += drop;
        if (attrib[k].s.length < 5) attrib[k].s.push({ tick: STATE.tick, drop: +drop.toFixed(2), args: Array.from(arguments).slice(2).map((a) => (a && a.id) ? a.id : a).filter((a) => typeof a !== 'object') });
      }
    }
    return r;
  };
}
// resolveCombat/tickRaze/tickMovement/tickTraining/tickSites are the expected combat/transform paths;
// we focus on the discrete mutators the AI and actions call.
['command', 'rally', 'transferUnits', 'upgradeUnits', 'formUnits', 'garrison', 'moveUnits', 'cancelTraining', 'setFormation', 'setStance', 'reequip'].forEach(wrap);

const MATCHES = parseInt(process.argv[2], 10) || 30;
for (let m = 0; m < MATCHES; m++) {
  const state = S.createInitialState({ roomCode: 'MUT' + m, devMode: true, matchSeconds: 720 });
  state.status = 'playing'; STATE = state;
  let guard = 0;
  while (state.status === 'playing' && guard < 100000) { const res = sim.step(state); guard++; if (res) break; }
}
STATE = null;
console.log(`Matches: ${MATCHES}`);
console.log('Army-unit drops attributed to discrete army mutators:');
const keys = Object.keys(attrib).sort((a, b) => attrib[b].units - attrib[a].units);
if (!keys.length) console.log('  (none — no mutator drops units)');
for (const k of keys) { const a = attrib[k]; console.log(`  ${k}: ${a.count}x, ${a.units.toFixed(1)} units  e.g. ${JSON.stringify(a.s)}`); }
