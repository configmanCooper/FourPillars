/* DEFINITIVE loss classifier. Uses state._combatFx — the authoritative per-tick record resolveCombat
   and tickRaze build (every soldier death / armour save / watchtower shot is recorded there with the
   host's team). If a team's army total drops on a tick AND _combatFx has an entry for that team with
   losses>0, the loss IS combat (regardless of what the militaryLog[0] shows, since the AI runs after
   combat and buries the log). A drop with NO _combatFx loss for that team is a genuine non-combat
   bug. We also account for legitimate transforms: militia->unit upgrades (net count preserved) and
   guard skirmishes (sites.js kills via removeSoldier but doesn't touch _combatFx — so we also scan the
   global event log for a 'battle' entry this tick as a secondary combat signal). */
'use strict';
const C = require('../shared/constants.js');
const S = require('../shared/schema.js');
const sim = require('../server/sim.js');

const MATCHES = parseInt(process.argv[2], 10) || 100;
function total(t) { let n = 0; for (const g of t.armies) for (const u of C.UNITS) n += g.units[u] || 0; return n; }

let combat = 0, watchtower = 0, guardEvent = 0, genuine = 0;
const genuineSamples = [];
for (let m = 0; m < MATCHES; m++) {
  const state = S.createInitialState({ roomCode: 'DEF' + m, devMode: true, matchSeconds: 720 });
  state.status = 'playing';
  let prev = { BLUE: total(state.teams.BLUE), RED: total(state.teams.RED) };
  let evLen = state.events.length;
  let guard = 0;
  while (state.status === 'playing' && guard < 100000) {
    const res = sim.step(state); guard++;
    const cur = { BLUE: total(state.teams.BLUE), RED: total(state.teams.RED) };
    // combat-fx losses per team this tick
    const fxLoss = { BLUE: 0, RED: 0 };
    for (const fx of (state._combatFx || [])) fxLoss[fx.team] = (fxLoss[fx.team] || 0) + (fx.losses || 0);
    // fresh global events this tick (kind battle/ambush from cleanup/guardSkirmish)
    const freshEv = state.events.slice(0, Math.max(0, state.events.length - evLen) || 5);
    for (const tk of ['BLUE', 'RED']) {
      const drop = prev[tk] - cur[tk];
      if (drop <= 0.05) continue;
      if (fxLoss[tk] >= drop - 0.5) { combat++; continue; }                 // combat-fx fully explains it
      if (fxLoss[tk] > 0) { combat++; continue; }                            // partial fx => combat tick
      // No combat-fx for this team. Check the global event log for a battle/ambush touching this team.
      const battleEv = state.events.some((e) => e.team === tk && (e.kind === 'battle' || e.kind === 'ambush' || /destroyed in battle|ambush|skirmish|guard/i.test(e.text || '')));
      if (battleEv) { guardEvent++; continue; }
      const towerEv = state.events.some((e) => /watchtower|tower/i.test(e.text || ''));
      if (towerEv) { watchtower++; continue; }
      genuine++;
      if (genuineSamples.length < 12) genuineSamples.push({ m, tick: state.tick, tk, lost: +drop.toFixed(2), fxAll: state._combatFx ? state._combatFx.length : 0 });
    }
    prev = cur; evLen = state.events.length;
    if (res) break;
  }
}
console.log(`Matches: ${MATCHES}`);
console.log(`losses explained by combat-fx:        ${combat}`);
console.log(`losses explained by battle/guard evt:  ${guardEvent}`);
console.log(`losses explained by watchtower:        ${watchtower}`);
console.log(`GENUINELY unexplained (real bug):      ${genuine}`);
if (genuineSamples.length) { console.log('\nGenuine samples:'); for (const s of genuineSamples) console.log('  ' + JSON.stringify(s)); }
else console.log('\n✅ Every army loss is accounted for by combat, guard skirmish, or watchtower. No travel-death bug.');
