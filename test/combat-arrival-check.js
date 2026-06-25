/* Combat symmetry probe: does a host ARRIVING at a node fight at a disadvantage vs a host already
   STATIONED there, all else equal (neutral ground, identical forces)? Runs many trials of an
   arriving BLUE host vs a stationary RED host (equal militia) at a neutral node and reports average
   survivors on each side. Symmetric (~equal) => no arrival disadvantage / first-strike. */
'use strict';
const C = require('../shared/constants.js');
const B = require('../shared/balance.js');
const S = require('../shared/schema.js');
const army = require('../server/systems/army.js');
const { makeRng } = require('../server/rng.js');

function mkHost(team, area, n, opts) {
  opts = opts || {};
  const g = { id: S.uid('army'), team: team, name: 'H', units: {}, gear: {}, area: area, moving: opts.moving || null, formation: 'line', stance: 'balanced', morale: 'normal' };
  for (const u of C.UNITS) g.units[u] = 0;
  g.units[opts.type || 'militia'] = n;
  army.ensureGear(g);
  return g;
}

// Find two connected neutral (non-base) nodes.
function neutralPair(state) {
  for (const id in state.areas) { const a = state.areas[id]; if (a.terrain === 'base') continue;
    for (const nid of a.connections) { const b = state.areas[nid]; if (b && b.terrain !== 'base') return [id, nid]; } }
  return null;
}

let blueSurv = 0, redSurv = 0, blueWins = 0, redWins = 0, trials = 0;
for (let t = 0; t < 400; t++) {
  const state = S.createInitialState({ roomCode: 'SYM' + t, seed: 1000 + t, devMode: true, matchSeconds: 720 });
  state.status = 'playing';
  const pair = neutralPair(state); if (!pair) { console.log('no neutral pair'); process.exit(1); }
  const [stayNode, fromNode] = pair;
  // RED stationed at stayNode; BLUE marching from fromNode -> stayNode (will arrive and fight).
  state.teams.RED.armies = [mkHost('RED', stayNode, 5)];
  const route = [fromNode, stayNode];
  state.teams.BLUE.armies = [mkHost('BLUE', fromNode, 5, { moving: { route: route, legIndex: 0, t: 0 } })];
  // Neutralise the nodes (no owner walls) so only arrival-vs-stationary is tested.
  state.areas[stayNode].owner = null; if (state.areas[stayNode].buildings) state.areas[stayNode].buildings = {};
  state.areas[fromNode].owner = null;
  // Step until one side is gone or 200 ticks.
  let guard = 0;
  while (guard < 200) {
    guard++;
    const rng = makeRng((state.seed + state.tick * 2654435761) >>> 0);
    state.tick++;
    army.tickMovement(state, state.teams.BLUE, 1);
    army.tickMovement(state, state.teams.RED, 1);
    army.resolveCombat(state, 1, rng, null);
    const bn = state.teams.BLUE.armies.reduce((s, g) => s + army.unitCount(g), 0);
    const rn = state.teams.RED.armies.reduce((s, g) => s + army.unitCount(g), 0);
    if (bn < 0.5 || rn < 0.5) break;
  }
  const bn = state.teams.BLUE.armies.reduce((s, g) => s + army.unitCount(g), 0);
  const rn = state.teams.RED.armies.reduce((s, g) => s + army.unitCount(g), 0);
  blueSurv += bn; redSurv += rn; trials++;
  if (bn > rn) blueWins++; else if (rn > bn) redWins++;
}
console.log('Trials:', trials);
console.log('Avg survivors — BLUE (arriving):', (blueSurv / trials).toFixed(2), '| RED (stationary):', (redSurv / trials).toFixed(2));
console.log('Wins — BLUE (arriving):', blueWins, '| RED (stationary):', redWins);
const ratio = redSurv > 0 ? blueSurv / redSurv : 99;
console.log('arriving/stationary survivor ratio:', ratio.toFixed(2), ratio > 0.8 && ratio < 1.25 ? '(SYMMETRIC ✅)' : '(ASYMMETRIC ⚠ — arriving is disadvantaged)');
