/* Final confirmation: account for EVERY army-unit drop by one of three legitimate causes:
   (1) combat-fx (resolveCombat/tickRaze recorded a death/save for the team this tick),
   (2) guard-skirmish (sites.js killed via removeSoldier and logged kind 'combat' to the victim),
   (3) militia->guards lending (team.guards rose the same tick the army fell — a conversion, not a loss).
   Anything left over is a genuine unexplained loss (a real bug). */
'use strict';
const C = require('../shared/constants.js');
const S = require('../shared/schema.js');
const sim = require('../server/sim.js');

const MATCHES = parseInt(process.argv[2], 10) || 100;
function total(t) { let n = 0; for (const g of t.armies) for (const u of C.UNITS) n += g.units[u] || 0; return n; }

let combat = 0, skirmish = 0, lending = 0, genuine = 0;
const samples = [];
for (let m = 0; m < MATCHES; m++) {
  const state = S.createInitialState({ roomCode: 'FIN' + m, devMode: true, matchSeconds: 720 });
  state.status = 'playing';
  let prevTot = { BLUE: total(state.teams.BLUE), RED: total(state.teams.RED) };
  let prevGuards = { BLUE: Math.round(state.teams.BLUE.guards || 0), RED: Math.round(state.teams.RED.guards || 0) };
  let head = { BLUE: state.teams.BLUE.militaryLog[0], RED: state.teams.RED.militaryLog[0] };
  let guard = 0;
  while (state.status === 'playing' && guard < 100000) {
    const res = sim.step(state); guard++;
    const curTot = { BLUE: total(state.teams.BLUE), RED: total(state.teams.RED) };
    const curGuards = { BLUE: Math.round(state.teams.BLUE.guards || 0), RED: Math.round(state.teams.RED.guards || 0) };
    const fxLoss = { BLUE: 0, RED: 0 };
    for (const fx of (state._combatFx || [])) fxLoss[fx.team] = (fxLoss[fx.team] || 0) + (fx.losses || 0);
    const fresh = {};
    for (const tk of ['BLUE', 'RED']) { const ml = state.teams[tk].militaryLog; fresh[tk] = []; for (const e of ml) { if (e === head[tk]) break; fresh[tk].push(e); } }
    for (const tk of ['BLUE', 'RED']) {
      const drop = prevTot[tk] - curTot[tk];
      if (drop <= 0.05) continue;
      const guardGain = curGuards[tk] - prevGuards[tk];
      if (fxLoss[tk] > 0) { combat++; continue; }
      if (fresh[tk].some((e) => (e.kind === 'combat' || e.kind === 'battle' || e.kind === 'ambush'))) { skirmish++; continue; }
      if (guardGain >= drop - 0.5) { lending++; continue; }    // militia became guards
      genuine++;
      if (samples.length < 12) samples.push({ m, tick: state.tick, tk, lost: +drop.toFixed(2), guardGain });
    }
    prevTot = curTot; prevGuards = curGuards; head = { BLUE: state.teams.BLUE.militaryLog[0], RED: state.teams.RED.militaryLog[0] };
    if (res) break;
  }
}
console.log(`Matches: ${MATCHES}`);
console.log(`combat-fx:            ${combat}`);
console.log(`guard-skirmish/battle:${skirmish}`);
console.log(`militia->guards lend: ${lending}`);
console.log(`GENUINE (real bug):   ${genuine}`);
if (samples.length) { console.log('\nGenuine samples:'); for (const s of samples) console.log('  ' + JSON.stringify(s)); }
else console.log('\n✅ Every army-unit drop is combat, guard-skirmish, or a militia->guards conversion. No travel-death bug.');
