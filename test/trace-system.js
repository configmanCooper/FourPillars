/* Pinpoint which system removes army units with no combat-fx. sim.js invokes each system as
   `mod.method(...)` on the required module object, so monkeypatching the module's exported methods
   intercepts the real calls. We snapshot each team's army total before/after every system method per
   tick and report any drop, attributing it to the exact method. */
'use strict';
const C = require('../shared/constants.js');
const S = require('../shared/schema.js');

const army = require('../server/systems/army.js');
const economy = require('../server/systems/economy.js');
const buildings = require('../server/systems/buildings.js');
const production = require('../server/systems/production.js');
const sites = require('../server/systems/sites.js');
const comms = require('../server/systems/comms.js');
const events = require('../server/systems/events.js');
const victory = require('../server/systems/victory.js');
const ai = require('../server/systems/ai.js');
const sim = require('../server/sim.js');

function total(state, tk) { let n = 0; for (const g of state.teams[tk].armies) for (const u of C.UNITS) n += g.units[u] || 0; return n; }

let STATE = null;
const attrib = {};
function wrap(mod, name, label) {
  const orig = mod[name];
  if (typeof orig !== 'function') return;
  mod[name] = function () {
    const before = STATE ? { BLUE: total(STATE, 'BLUE'), RED: total(STATE, 'RED') } : null;
    const r = orig.apply(this, arguments);
    if (STATE && before) {
      for (const tk of ['BLUE', 'RED']) {
        const after = total(STATE, tk);
        const drop = before[tk] - after;
        if (drop > 0.001) {
          const key = label + '|' + tk;
          attrib[key] = attrib[key] || { count: 0, units: 0, samples: [] };
          attrib[key].count++; attrib[key].units += drop;
          if (attrib[key].samples.length < 4) attrib[key].samples.push({ tick: STATE.tick, drop: +drop.toFixed(3) });
        }
      }
    }
    return r;
  };
}
for (const n of ['tickEconomy', 'pruneHolds']) wrap(economy, n, 'economy.' + n);
for (const n of ['tickBuildings']) wrap(buildings, n, 'buildings.' + n);
for (const n of ['tickProduction']) wrap(production, n, 'production.' + n);
for (const n of ['tickSites']) wrap(sites, n, 'sites.' + n);
for (const n of ['tickMovement', 'tickTraining', 'resolveCombat', 'tickRaze', 'enforceCaps']) wrap(army, n, 'army.' + n);
for (const n of ['tickComms']) wrap(comms, n, 'comms.' + n);
for (const n of ['tickEvents']) wrap(events, n, 'events.' + n);
for (const n of ['aiTick']) wrap(ai, n, 'ai.' + n);

const MATCHES = parseInt(process.argv[2], 10) || 20;
for (let m = 0; m < MATCHES; m++) {
  const state = S.createInitialState({ roomCode: 'TR' + m, devMode: true, matchSeconds: 720 });
  state.status = 'playing'; STATE = state;
  let guard = 0;
  while (state.status === 'playing' && guard < 100000) { const res = sim.step(state); guard++; if (res) break; }
}
STATE = null;
console.log(`Matches: ${MATCHES}`);
console.log('Army-unit drops attributed by system (combat is expected in resolveCombat/tickRaze/sites):');
for (const k of Object.keys(attrib).sort((a, b) => attrib[b].units - attrib[a].units)) {
  const a = attrib[k];
  console.log(`  ${k}: ${a.count}x, ${a.units.toFixed(1)} units  e.g. ${JSON.stringify(a.samples)}`);
}
