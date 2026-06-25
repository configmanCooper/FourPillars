/* Confirm the 89 "genuine" losses are guard-skirmish casualties. guardSkirmish kills enemy host
   soldiers via removeSoldier and logs to the VICTIM's militaryLog (kind 'combat', text mentions
   "ambushing an enemy caravan's guards"), but records NO _combatFx and writes nothing to the global
   event log. We watch each team's militaryLog for a FRESH 'combat' entry whose text matches the
   guard-skirmish wording on the same tick a loss with no _combatFx occurs. */
'use strict';
const C = require('../shared/constants.js');
const S = require('../shared/schema.js');
const sim = require('../server/sim.js');

const MATCHES = parseInt(process.argv[2], 10) || 100;
function total(t) { let n = 0; for (const g of t.armies) for (const u of C.UNITS) n += g.units[u] || 0; return n; }

let combatFx = 0, guardSkirmish = 0, stillUnknown = 0;
const unknownSamples = [];
for (let m = 0; m < MATCHES; m++) {
  const state = S.createInitialState({ roomCode: 'GS' + m, devMode: true, matchSeconds: 720 });
  state.status = 'playing';
  let prev = { BLUE: total(state.teams.BLUE), RED: total(state.teams.RED) };
  // remember each team's militaryLog head to detect fresh entries
  let logHead = { BLUE: state.teams.BLUE.militaryLog[0], RED: state.teams.RED.militaryLog[0] };
  let guard = 0;
  while (state.status === 'playing' && guard < 100000) {
    const res = sim.step(state); guard++;
    const cur = { BLUE: total(state.teams.BLUE), RED: total(state.teams.RED) };
    const fxLoss = { BLUE: 0, RED: 0 };
    for (const fx of (state._combatFx || [])) fxLoss[fx.team] = (fxLoss[fx.team] || 0) + (fx.losses || 0);
    // collect fresh militaryLog entries (everything above the previous head) per team
    const fresh = {};
    for (const tk of ['BLUE', 'RED']) {
      const ml = state.teams[tk].militaryLog; fresh[tk] = [];
      for (const e of ml) { if (e === logHead[tk]) break; fresh[tk].push(e); }
    }
    for (const tk of ['BLUE', 'RED']) {
      const drop = prev[tk] - cur[tk];
      if (drop <= 0.05) continue;
      if (fxLoss[tk] > 0) { combatFx++; continue; }
      const skirmish = fresh[tk].some((e) => e.kind === 'combat' && /ambush|caravan|guard|fell/i.test(e.text || ''));
      if (skirmish) { guardSkirmish++; continue; }
      // any fresh combat-kind entry at all?
      const anyCombat = fresh[tk].some((e) => e.kind === 'combat' || e.kind === 'battle' || e.kind === 'ambush');
      if (anyCombat) { guardSkirmish++; continue; }
      stillUnknown++;
      if (unknownSamples.length < 12) unknownSamples.push({ m, tick: state.tick, tk, lost: +drop.toFixed(2), freshKinds: fresh[tk].map((e) => e.kind), freshTxt: fresh[tk].slice(0, 3).map((e) => (e.text || '').slice(0, 40)) });
    }
    prev = cur; logHead = { BLUE: state.teams.BLUE.militaryLog[0], RED: state.teams.RED.militaryLog[0] };
    if (res) break;
  }
}
console.log(`Matches: ${MATCHES}`);
console.log(`losses w/ combat-fx:                 ${combatFx}`);
console.log(`losses w/ guard-skirmish/combat log: ${guardSkirmish}`);
console.log(`STILL UNKNOWN (real travel bug):     ${stillUnknown}`);
if (unknownSamples.length) { console.log('\nStill-unknown samples:'); for (const s of unknownSamples) console.log('  ' + JSON.stringify(s)); }
else console.log('\n✅ All non-fx losses are guard-skirmish/combat-log casualties. No travel-death bug.');
