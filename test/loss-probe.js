/* Classify residual "unexplained_army_loss" flags: for every tick where a team's army total drops
   with no detected cause, record whether the ENEMY also dropped the same tick (paired = combat
   exchange), whether a combat/ambush log entry appeared on EITHER team within +/-2 ticks, and the
   host count delta. A genuine "soldiers die while travelling" bug would be a SOLO drop with no enemy
   drop and no combat log anywhere near it. */
'use strict';
const C = require('../shared/constants.js');
const S = require('../shared/schema.js');
const sim = require('../server/sim.js');

const MATCHES = parseInt(process.argv[2], 10) || 100;
function total(t) { let n = 0; for (const g of t.armies) for (const u of C.UNITS) n += g.units[u] || 0; return n; }
function logKey(t) { const ml = t.militaryLog; return ml && ml[0] ? ml[0] : null; }

let paired = 0, soloWithNearbyCombat = 0, soloNoCombat = 0;
const soloSamples = [];

for (let m = 0; m < MATCHES; m++) {
  const state = S.createInitialState({ roomCode: 'LP' + m, devMode: true, matchSeconds: 720 });
  state.status = 'playing';
  // recent combat-log markers per team, ring of last 5 ticks
  const recentCombat = { BLUE: [], RED: [] };
  let prevTotal = { BLUE: total(state.teams.BLUE), RED: total(state.teams.RED) };
  let prevLog = { BLUE: logKey(state.teams.BLUE), RED: logKey(state.teams.RED) };
  let guard = 0;
  const pendingSolos = []; // {tk, tick, lost} awaiting +/-2 tick combat check
  while (state.status === 'playing' && guard < 100000) {
    const res = sim.step(state); guard++;
    const tick = state.tick;
    const curTotal = { BLUE: total(state.teams.BLUE), RED: total(state.teams.RED) };
    const curLog = { BLUE: logKey(state.teams.BLUE), RED: logKey(state.teams.RED) };
    const drop = { BLUE: prevTotal.BLUE - curTotal.BLUE, RED: prevTotal.RED - curTotal.RED };
    for (const tk of ['BLUE', 'RED']) {
      const fresh = curLog[tk] && curLog[tk] !== prevLog[tk] && (curLog[tk].kind === 'combat' || curLog[tk].kind === 'ambush');
      recentCombat[tk].push(fresh ? tick : -999); if (recentCombat[tk].length > 6) recentCombat[tk].shift();
    }
    for (const tk of ['BLUE', 'RED']) {
      if (drop[tk] > 0.05) {
        const foe = tk === 'BLUE' ? 'RED' : 'BLUE';
        if (drop[foe] > 0.05) { paired++; continue; }
        // solo drop — was there a fresh combat log on either team within +/-2 ticks?
        const nearCombat = [...recentCombat[tk], ...recentCombat[foe]].some((tt) => Math.abs(tt - tick) <= 2);
        pendingSolos.push({ tk, tick, lost: +drop[tk].toFixed(2), nearCombat });
      }
    }
    prevTotal = curTotal; prevLog = curLog;
    if (res) break;
  }
  for (const s of pendingSolos) {
    if (s.nearCombat) soloWithNearbyCombat++;
    else { soloNoCombat++; if (soloSamples.length < 12) soloSamples.push({ m, ...s }); }
  }
}
console.log(`Matches: ${MATCHES}`);
console.log(`paired drops (combat exchange):     ${paired}`);
console.log(`solo drops WITH nearby combat log:  ${soloWithNearbyCombat}`);
console.log(`solo drops with NO combat anywhere: ${soloNoCombat}  <-- suspicious`);
if (soloSamples.length) { console.log('\nSuspicious solo-loss samples:'); for (const s of soloSamples) console.log('  ' + JSON.stringify(s)); }
