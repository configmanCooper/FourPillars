/* Headless check: the Commander engages on strength comparisons — an OUTMATCHED forward host pulls
   back (consolidates) instead of attacking, and the Commander keeps a standing GARRISON on a
   frontier outpost. (Attacking-when-winning is covered by commander-counterattack-check.) */
'use strict';
const C = require('../shared/constants.js');
const S = require('../shared/schema.js');
const ai = require('../server/systems/ai.js');
const army = require('../server/systems/army.js');
const sim = require('../server/sim.js');
const { makeRng } = require('../server/rng.js');

function assert(cond, msg) { if (!cond) { console.error('FAIL:', msg); process.exit(1); } console.log('ok -', msg); }
function units(map) { const o = {}; for (const u of C.UNITS) o[u] = 0; for (const k in map) o[k] = map[k]; return o; }
function host(state, team, area, u, name, extra) { const ar = state.areas[area]; return Object.assign({ id: S.uid('army'), team, name, units: units(u), hasArmor: false, formation: 'line', stance: 'balanced', area, moving: null, mission: { type: 'idle' }, morale: 'normal', x: ar.x, y: ar.y }, extra || {}); }

// ---- A) Outmatched forward host retreats / consolidates instead of attacking ----
{
  const st = S.createInitialState({ roomCode: 'STR', devMode: true, matchSeconds: 1800 });
  st.status = 'playing'; const B = st.teams.BLUE, R = st.teams.RED; B._elapsed = 0;
  B.aiPersona = B.aiPersona || {}; B.aiPersona.COMMANDER = 'wolf';   // even the aggressive persona should bail when badly outmatched
  army.garrison(st, B).units = units({ militia: 8 });
  const scout = host(st, 'BLUE', 'central_mine', { militia: 2 }, 'Scout'); B.armies.push(scout);
  R.armies = R.armies.filter((h) => h.isGarrison);
  R.armies.push(host(st, 'RED', 'north_farm', { militia: 16 }, 'Horde'));   // huge force one tile from the Scout
  army.garrison(st, R).units = units({ militia: 4 });
  const rng = makeRng(3); const SYS = sim.SYSTEMS;
  let retreated = false, attacked = false;
  for (let i = 0; i < 20; i++) {
    ai.aiTick(st, B, 1, SYS, rng); st.elapsed += 1; B._elapsed = st.elapsed;
    const s = B.armies.find((h) => h.id === scout.id);
    if (!s) break;
    const m = s.mission && s.mission.type;
    if (m === 'raid' || m === 'siege') attacked = true;
    // Retreating = ordered home (defend) or to a friendly area that is NOT the enemy's tile.
    if (m === 'defend' || (m === 'garrison' && s.mission.targetArea !== 'north_farm')) retreated = true;
  }
  assert(!attacked, 'outmatched Scout never threw itself at the enemy (no raid/siege)');
  assert(retreated, 'outmatched Scout pulled back to regroup');
}

// ---- B) The Commander keeps a garrison on a frontier outpost ----
{
  const st = S.createInitialState({ roomCode: 'GAR', devMode: true, matchSeconds: 1800 });
  st.status = 'playing'; const B = st.teams.BLUE, R = st.teams.RED; B._elapsed = 0;
  B.aiPersona = B.aiPersona || {}; B.aiPersona.COMMANDER = 'roadmarshal';
  army.garrison(st, B).units = units({ militia: 16 });
  // Blue owns West Quarry (an outpost); RED holds the bordering Ancient Ruins → West Quarry is frontier.
  const wq = st.areas.west_quarry; wq.owner = 'BLUE'; wq.claimedBy = 'BLUE'; if (wq.site) wq.site.worked = true;
  const ar = st.areas.ancient_ruins; ar.owner = 'RED'; ar.claimedBy = 'RED';
  army.garrison(st, R).units = units({ militia: 4 });
  const rng = makeRng(9); const SYS = sim.SYSTEMS;
  let garrisoned = false;
  for (let i = 0; i < 30 && !garrisoned; i++) {
    function pin() { const gg = army.garrison(st, B); if (army.unitCount(gg) < 10) gg.units = units({ militia: 16 }); }
    pin();
    ai.aiTick(st, B, 1, SYS, rng); st.elapsed += 1; B._elapsed = st.elapsed;
    if (B.armies.some((h) => h.postGuard === 'west_quarry' && army.unitCount(h) >= 0.5)) garrisoned = true;
  }
  assert(garrisoned, 'Commander stationed a post-guard on the frontier outpost (West Quarry)');
}

console.log('COMMANDER-STRENGTH OK');
