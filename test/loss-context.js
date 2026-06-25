/* Reproduce the sim-audit's EXACT unexplained-loss detection (adjacency + _fighting + fresh combat
   log suppression), then for each residual flag, capture rich context to pin the cause: the dropping
   team's last 3 military-log entries, the enemy's last 3, whether a siege/raze was in progress at an
   area the team occupies, and whether any guarded caravan / watchtower event is in the recent log. */
'use strict';
const C = require('../shared/constants.js');
const S = require('../shared/schema.js');
const sim = require('../server/sim.js');

const MATCHES = parseInt(process.argv[2], 10) || 100;
function unitCount(g) { let n = 0; for (const u of C.UNITS) n += g.units[u] || 0; return n; }
function snapshot(state) {
  const out = {};
  for (const tk of ['BLUE', 'RED']) {
    const t = state.teams[tk]; const areas = {}; let total = 0;
    for (const g of t.armies) { const n = unitCount(g); if (n < 0.0001) continue; total += n; const a = g.moving ? g.moving.route[g.moving.legIndex] : g.area; areas[a] = (areas[a] || 0) + n; }
    const cvAreas = {}; for (const cv of t.caravans) { if ((cv.guards || 0) >= 1) { const a = cv.route[cv.legIndex]; cvAreas[a] = true; } }
    out[tk] = { total, areas, food: t.resources.food, fighting: t.armies.some((g) => g._fighting) };
  }
  return out;
}
function enemyNear(state, tk, prev, cur) {
  const foe = tk === 'BLUE' ? 'RED' : 'BLUE';
  const myAreas = {}; for (const s of [prev, cur]) for (const a in s[tk].areas) myAreas[a] = true;
  const foeAreas = {}; for (const s of [prev, cur]) { for (const a in s[foe].areas) foeAreas[a] = true; for (const a in s[foe].cvAreas) foeAreas[a] = true; }
  for (const a in myAreas) {
    if (foeAreas[a]) return true;
    const conns = (state.areas[a] && state.areas[a].connections) || [];
    for (const n of conns) if (foeAreas[n]) return true;
  }
  return false;
}
function logTail(t, n) { const ml = t.militaryLog || []; return ml.slice(0, n).map((e) => ({ k: e.kind, m: (e.msg || e.text || '').slice(0, 50), t: e.tick })); }

const kinds = {};
const samples = [];
for (let m = 0; m < MATCHES; m++) {
  const state = S.createInitialState({ roomCode: 'CTX' + m, devMode: true, matchSeconds: 720 });
  state.status = 'playing';
  let prev = snapshot(state); let guard = 0;
  const log0 = { BLUE: null, RED: null };
  while (state.status === 'playing' && guard < 100000) {
    const before = prev;
    for (const tk of ['BLUE', 'RED']) { const ml = state.teams[tk].militaryLog; log0[tk] = ml && ml[0]; }
    const res = sim.step(state); guard++;
    const after = snapshot(state);
    for (const tk of ['BLUE', 'RED']) {
      const drop = before[tk].total - after[tk].total;
      const ml = state.teams[tk].militaryLog; const cur0 = ml && ml[0];
      const freshCombatLog = cur0 && cur0 !== log0[tk] && (cur0.kind === 'combat' || cur0.kind === 'ambush');
      const anyFighting = after.BLUE.fighting || after.RED.fighting;
      if (drop > 0.05 && !enemyNear(state, tk, before, after) && !anyFighting && before[tk].food > 0.5 && !freshCombatLog) {
        const foe = tk === 'BLUE' ? 'RED' : 'BLUE';
        // Classify by what the recent log says.
        const myTail = logTail(state.teams[tk], 3);
        const foeTail = logTail(state.teams[foe], 3);
        const allTxt = JSON.stringify([myTail, foeTail]).toLowerCase();
        let cause = 'UNKNOWN';
        if (/watchtower|tower/.test(allTxt)) cause = 'watchtower';
        else if (/caravan|guard|ambush|escort|raid/.test(allTxt)) cause = 'caravan/guard';
        else if (/siege|raze|destroyed|razed/.test(allTxt)) cause = 'siege/raze';
        else if (/combat|battle|slain|fell|lost|casualt/.test(allTxt)) cause = 'combat(stale-log)';
        kinds[cause] = (kinds[cause] || 0) + 1;
        if (cause === 'UNKNOWN' && samples.length < 15) samples.push({ m, tick: state.tick, tk, lost: +drop.toFixed(2), myTail, foeTail });
      }
    }
    prev = after;
    if (res) break;
  }
}
console.log(`Matches: ${MATCHES}`);
console.log('Residual unexplained-loss causes:');
for (const k of Object.keys(kinds).sort((a, b) => kinds[b] - kinds[a])) console.log(`  ${k}: ${kinds[k]}`);
if (samples.length) { console.log('\nTRUE UNKNOWN samples (potential real bug):'); for (const s of samples) console.log('  ' + JSON.stringify(s)); }
else console.log('\nNo true-unknown residuals — all explained by watchtower/caravan/siege/stale-combat-log.');
