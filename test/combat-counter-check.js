/* Verify the composition counters: cavalry beat soft (non-spear/non-cav) foes harder, and spearmen
   beat cavalry harder, than an even base-stat fight would suggest. Runs many 1-area battles and
   reports who wins. */
'use strict';
const C = require('../shared/constants.js');
const B = require('../shared/balance.js');
const S = require('../shared/schema.js');
const army = require('../server/systems/army.js');
const { makeRng } = require('../server/rng.js');

function host(team, type, n) {
  const g = { id: S.uid('a'), team: team, name: type, units: {}, gear: {}, area: 'mid', formation: 'line', stance: 'balanced', morale: 'normal' };
  for (const u of C.UNITS) g.units[u] = 0;
  g.units[type] = n; army.ensureGear(g); return g;
}
function battle(blueType, blueN, redType, redN, seed) {
  const state = S.createInitialState({ roomCode: 'CC', seed: 7, devMode: true, matchSeconds: 720 });
  state.status = 'playing';
  // Put both at a neutral mid node.
  let mid = null; for (const id in state.areas) { if (state.areas[id].terrain !== 'base') { mid = id; break; } }
  state.areas[mid].owner = null; state.areas[mid].buildings = {};
  state.teams.BLUE.armies = [host('BLUE', blueType, blueN)];
  state.teams.RED.armies = [host('RED', redType, redN)];
  state.teams.BLUE.armies[0].area = mid; state.teams.RED.armies[0].area = mid;
  state.teams.BLUE.resources.arrows = 999; state.teams.RED.resources.arrows = 999;
  let guard = 0;
  while (guard < 300) { guard++; const rng = makeRng((seed + guard * 2654435761) >>> 0); state.tick++;
    army.resolveCombat(state, 1, rng, null);
    const bn = state.teams.BLUE.armies.reduce((s, g) => s + army.unitCount(g), 0);
    const rn = state.teams.RED.armies.reduce((s, g) => s + army.unitCount(g), 0);
    if (bn < 0.5 || rn < 0.5) break;
  }
  const bn = state.teams.BLUE.armies.reduce((s, g) => s + army.unitCount(g), 0);
  const rn = state.teams.RED.armies.reduce((s, g) => s + army.unitCount(g), 0);
  return bn > rn ? 'BLUE' : (rn > bn ? 'RED' : 'DRAW');
}
function winRate(blueType, blueN, redType, redN, trials) {
  let bw = 0; for (let i = 0; i < trials; i++) { if (battle(blueType, blueN, redType, redN, 100 + i * 6779) === 'BLUE') bw++; } return bw / trials;
}
// 5 cavalry vs 6 archers (soft) — cavalry get +50% from 6 soft (capped). Cavalry should usually win.
const cavVsArchers = winRate('cavalry', 5, 'archer', 6, 60);
// 6 spearmen vs 5 cavalry — spearmen get +50% from 5 cav. Spearmen should usually win.
const spearVsCav = winRate('spearman', 6, 'cavalry', 5, 60);
// control: 5 cavalry vs 5 cavalry (no counter either way) ~ 50%.
const mirror = winRate('cavalry', 5, 'cavalry', 5, 60);
console.log('cavalry(5) vs archers(6) — cavalry win rate:', (cavVsArchers * 100).toFixed(0) + '%', cavVsArchers >= 0.6 ? '✅' : '⚠');
console.log('spearmen(6) vs cavalry(5) — spearman win rate:', (spearVsCav * 100).toFixed(0) + '%', spearVsCav >= 0.6 ? '✅' : '⚠');
console.log('cavalry(5) vs cavalry(5) — mirror win rate:', (mirror * 100).toFixed(0) + '% (≈50%)');
const ok = cavVsArchers >= 0.6 && spearVsCav >= 0.6 && mirror > 0.3 && mirror < 0.7;
console.log(ok ? 'COUNTER CHECK OK' : 'COUNTER CHECK FAIL');
process.exit(ok ? 0 : 1);
