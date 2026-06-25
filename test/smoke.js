/* Headless simulation smoke test: all-AI both teams, fast match, must end with a winner. */
'use strict';
const S = require('../shared/schema.js');
const sim = require('../server/sim.js');

const state = S.createInitialState({ roomCode: 'TEST', devMode: true, matchSeconds: 720 });
state.status = 'playing';
let guard = 0;
const start = Date.now();
let result = null;
while (state.status === 'playing' && guard < 100000) {
  result = sim.step(state);
  guard++;
  if (result) break;
}
const B = state.teams.BLUE, R = state.teams.RED;
console.log('ticks:', state.tick, 'elapsed:', Math.round(state.elapsed), 'phase:', state.phase);
console.log('BLUE  food', Math.round(B.resources.food), 'wood', Math.round(B.resources.wood), 'iron', Math.round(B.resources.iron), 'pop', B.pop.total, 'soldiers', B.pop.soldiers, 'armies', B.armies.length, 'keep', Math.round(B.keep.hp), 'score', B.score);
console.log('RED   food', Math.round(R.resources.food), 'wood', Math.round(R.resources.wood), 'iron', Math.round(R.resources.iron), 'pop', R.pop.total, 'soldiers', R.pop.soldiers, 'armies', R.armies.length, 'keep', Math.round(R.keep.hp), 'score', R.score);
console.log('events sample:', state.events.slice(-5).map((e) => e.text));
console.log('BLUE buildings', JSON.stringify(B.buildings));
console.log('BLUE comms sample:', B.comms.slice(-4).map((m) => m.fromName + ': ' + m.text));
console.log('winner:', state.winner, state.winReason);
console.log('wallclock ms:', Date.now() - start);
if (!state.winner) { console.error('FAIL: no winner declared'); process.exit(1); }
console.log('SMOKE OK');
