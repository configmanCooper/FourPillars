/* Comprehensive simulation audit. Runs many AI-vs-AI matches and, every tick, checks a battery of
   invariants — flagging anything that "doesn't make sense": unexplained army losses (soldiers lost
   with no combat and no starvation), negative/over-cap resources & population, out-of-range Keep HP,
   NaN coords, gear/inventory desync, broken caravans, score anomalies, malformed holds.
   Usage: node test/sim-audit.js [matches]  (default 100) */
'use strict';
const C = require('../shared/constants.js');
const S = require('../shared/schema.js');
const sim = require('../server/sim.js');

const MATCHES = parseInt(process.argv[2], 10) || 100;
const anomalies = {};
function flag(kind, detail) { const a = anomalies[kind] = anomalies[kind] || { count: 0, samples: [] }; a.count++; if (a.samples.length < 5) a.samples.push(detail); }

function unitCount(g) { let n = 0; for (const u of C.UNITS) n += g.units[u] || 0; return n; }
function snapshot(state) {
  // Per team: total army units, areas occupied, food, housing, storage cap, a resource copy, and the
  // leg-areas of its GUARDED caravans (those can skirmish enemy hosts on the road).
  const out = {};
  for (const tk of ['BLUE', 'RED']) {
    const t = state.teams[tk]; const areas = {}; let total = 0;
    for (const g of t.armies) { const n = unitCount(g); if (n < 0.0001) continue; total += n; const a = g.moving ? g.moving.route[g.moving.legIndex] : g.area; areas[a] = (areas[a] || 0) + n; }
    const cvAreas = {}; for (const cv of t.caravans) { if ((cv.guards || 0) >= 1) { const a = cv.route[cv.legIndex]; cvAreas[a] = true; } }
    const res = {}; for (const k of C.RESOURCES) res[k] = t.resources[k];
    out[tk] = { total, areas, food: t.resources.food, housing: t.housing, cap: t.storageCap, res, cvAreas, popTotal: t.pop.total, fighting: t.armies.some((g) => g._fighting) };
  }
  return out;
}
function contestedAreas(prev, cur) {
  const set = {};
  for (const snap of [prev, cur]) { for (const a in snap.BLUE.areas) if (snap.RED.areas[a]) set[a] = true; }
  return set;
}
// Is an enemy host OR a guarded enemy caravan ON or ADJACENT to any area this team occupies (either
// snapshot)? If so a loss is plausibly combat or a caravan guard-skirmish — not "for no reason".
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

function checkInvariants(state, m, tick) {
  for (const tk of ['BLUE', 'RED']) {
    const t = state.teams[tk];
    for (const k of C.RESOURCES) { const v = t.resources[k]; if (typeof v !== 'number' || isNaN(v)) flag('resource_NaN', { m, tick, tk, k, v }); else if (v < -0.01) flag('resource_negative', { m, tick, tk, k, v: +v.toFixed(2) }); }
    const p = t.pop;
    for (const f of ['total', 'idle', 'farmers', 'woodcutters', 'miners', 'builders', 'students', 'trainers', 'recruits', 'soldiers']) { const v = p[f]; if (typeof v === 'number' && v < -0.01) flag('pop_negative', { m, tick, tk, f, v: +v.toFixed(2) }); if (typeof v === 'number' && isNaN(v)) flag('pop_NaN', { m, tick, tk, f }); }
    if (t.keep.hp < -0.01) flag('keep_hp_negative', { m, tick, tk, hp: +t.keep.hp.toFixed(1) });
    if (t.keep.hp > t.keep.maxHp + 0.01) flag('keep_hp_over_max', { m, tick, tk, hp: +t.keep.hp.toFixed(1), max: t.keep.maxHp });
    if (typeof t.score === 'number' && (isNaN(t.score) || t.score < 0)) flag('score_bad', { m, tick, tk, score: t.score });
    // Gear vs unit-count desync (sim reconciles each tick → should always hold post-step).
    for (const g of t.armies) {
      if (isNaN(g.x) || isNaN(g.y)) flag('host_NaN_coord', { m, tick, tk, host: g.name });
      for (const u of C.UNITS) { const n = Math.round(g.units[u] || 0); const gl = (g.gear && g.gear[u]) ? g.gear[u].length : 0; if (gl !== n) flag('gear_count_desync', { m, tick, tk, host: g.name, u, units: +(g.units[u] || 0).toFixed(2), gear: gl }); }
      if (g.moving) { const r = g.moving.route; if (!Array.isArray(r) || g.moving.legIndex < 0 || g.moving.legIndex >= r.length) flag('host_bad_route', { m, tick, tk, host: g.name, legIndex: g.moving.legIndex, len: r && r.length }); }
    }
    for (const item in (t.gearInv || {})) { const inv = t.gearInv[item].length; const eq = Math.round(t.equipment[item] || 0); if (inv !== eq) flag('gearInv_desync', { m, tick, tk, item, inv, equip: eq }); }
    for (const cv of t.caravans) { if (cv.legIndex < 0 || cv.legIndex >= cv.route.length) flag('caravan_bad_leg', { m, tick, tk, legIndex: cv.legIndex, len: cv.route.length }); }
    for (const key in (t.holds || {})) { const h = t.holds[key]; if (h && typeof h === 'object' && !('until' in h)) flag('hold_malformed', { m, tick, tk, key }); }
  }
}

const start = Date.now();
for (let m = 0; m < MATCHES; m++) {
  const state = S.createInitialState({ roomCode: 'AUD' + m, devMode: true, matchSeconds: 720 });
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
      // Combat this tick (a host was destroyed/vanished, so co-location can't be seen afterwards) is
      // signalled by the _fighting flag resolveCombat leaves on the surviving combatants of either side.
      const anyFighting = after.BLUE.fighting || after.RED.fighting;
      if (drop > 0.05 && !enemyNear(state, tk, before, after) && !anyFighting && before[tk].food > 0.5 && !freshCombatLog) flag('unexplained_army_loss', { m, tick: state.tick, tk, lost: +drop.toFixed(2), from: +before[tk].total.toFixed(1), to: +after[tk].total.toFixed(1) });
      // Population over housing is only a BUG if pop rose past the cap — not when housing itself dropped
      // (a House razed in a siege legitimately leaves you temporarily overcrowded).
      const t = state.teams[tk];
      if (t.pop.total > t.housing + 0.5 && after[tk].housing >= before[tk].housing - 0.001 && after[tk].popTotal > before[tk].popTotal + 0.001) flag('pop_over_housing', { m, tick: state.tick, tk, total: +t.pop.total.toFixed(1), housing: t.housing });
      // Resource over cap is only a BUG if the resource ROSE past the cap (not when storage cap dropped
      // because a Storehouse was razed/captured).
      for (const k of C.RESOURCES) { if (k === 'relics') continue; const v = after[tk].res[k]; if (v > after[tk].cap + 0.5 && after[tk].cap >= before[tk].cap - 0.001 && v > before[tk].res[k] + 0.001) flag('resource_over_cap', { m, tick: state.tick, tk, k, v: +v.toFixed(1), cap: after[tk].cap }); }
    }
    checkInvariants(state, m, state.tick);
    prev = after;
    if (res) break;
  }
}
const ms = Date.now() - start;
console.log('Ran ' + MATCHES + ' matches in ' + (ms / 1000).toFixed(1) + 's');
const kinds = Object.keys(anomalies);
if (!kinds.length) { console.log('NO ANOMALIES DETECTED ✅'); process.exit(0); }
console.log('\nANOMALIES:');
for (const k of kinds.sort((a, b) => anomalies[b].count - anomalies[a].count)) {
  console.log('\n● ' + k + ' ×' + anomalies[k].count);
  for (const s of anomalies[k].samples) console.log('   ' + JSON.stringify(s));
}
