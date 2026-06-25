/* Headless check: the Commander seizes UNDEFENDED enemy posts and decides smartly whether to HOLD
   them (garrison, when it can defend) or HIT-AND-RUN (raid, when it can't). */
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
const SYS = sim.SYSTEMS;

// ---- A) DOMINANT: take an undefended enemy post AND hold it (garrison / post-guard) ----
{
  const st = S.createInitialState({ roomCode: 'OPP1', devMode: true, matchSeconds: 1800 });
  st.status = 'playing'; const B = st.teams.BLUE, R = st.teams.RED; B._elapsed = 0;
  B.aiPersona = B.aiPersona || {}; B.aiPersona.COMMANDER = 'roadmarshal';
  const striker = host(st, 'BLUE', 'central_mine', { militia: 14 }, 'Striker'); B.armies.push(striker);
  const wq = st.areas.west_quarry; wq.owner = 'RED'; wq.claimedBy = 'RED'; if (wq.site) wq.site.worked = true; // undefended enemy post bordering our Keep
  R.armies = R.armies.filter((h) => h.isGarrison);
  army.garrison(st, R).units = units({ militia: 16 });   // a strong enemy Keep garrison → no easy siege
  const rng = makeRng(2);
  let held = false;
  for (let i = 0; i < 8 && !held; i++) { ai.aiTick(st, B, 1, SYS, rng); st.elapsed += 1; B._elapsed = st.elapsed;
    const s = B.armies.find((h) => h.id === striker.id);
    if (s && s.postGuard === 'west_quarry') held = true;
  }
  assert(held, 'dominant Commander takes the undefended post AND garrisons it to hold (post-guard set)');
}

// ---- B) CAN'T HOLD: take an undefended enemy post but hit-and-run (raid, no post-guard) ----
{
  const st = S.createInitialState({ roomCode: 'OPP2', devMode: true, matchSeconds: 1800 });
  st.status = 'playing'; const B = st.teams.BLUE, R = st.teams.RED; B._elapsed = 0;
  B.aiPersona = B.aiPersona || {}; B.aiPersona.COMMANDER = 'wolf';
  army.garrison(st, B).units = units({ militia: 14 });   // globally strong (not vulnerable)
  const raider = host(st, 'BLUE', 'west_quarry', { militia: 6 }, 'Raider'); B.armies.push(raider);
  const cm = st.areas.central_mine; cm.owner = 'RED'; cm.claimedBy = 'RED'; if (cm.site) cm.site.worked = true; // undefended enemy post
  R.armies = R.armies.filter((h) => h.isGarrison);
  R.armies.push(host(st, 'RED', 'ancient_ruins', { militia: 8 }, 'Reserve'));   // a force one tile from the post → can't HOLD it
  army.garrison(st, R).units = units({ militia: 12 });                          // keep garrison (no easy siege)
  const rng = makeRng(4);
  let raidedCm = false, garrisonedCm = false;
  for (let i = 0; i < 10; i++) { ai.aiTick(st, B, 1, SYS, rng); st.elapsed += 1; B._elapsed = st.elapsed;
    for (const s of B.armies) {
      const m = s.mission && s.mission.type;
      if (m === 'raid' && (s.mission.targetArea === 'central_mine' || army.currentArea(s) === 'central_mine')) raidedCm = true;
      if (s.postGuard === 'central_mine') garrisonedCm = true;
    }
  }
  assert(raidedCm, 'a host takes the post it can win at (raid central_mine)');
  assert(!garrisonedCm, 'but does NOT try to hold a post it cannot defend (hit-and-run, no post-guard)');
}

// ---- C) full sim: a dominant Blue actually CAPTURES an undefended enemy post and keeps a host on it ----
{
  const st = S.createInitialState({ roomCode: 'OPP3', devMode: true, matchSeconds: 1800 });
  st.status = 'playing'; const B = st.teams.BLUE, R = st.teams.RED;
  B.aiPersona = B.aiPersona || {}; B.aiPersona.COMMANDER = 'roadmarshal';
  army.garrison(st, B).units = units({ militia: 16 });
  const wq = st.areas.west_quarry; wq.owner = 'RED'; wq.claimedBy = 'RED'; wq.buildings = {}; if (wq.site) wq.site.worked = true;
  R.armies = R.armies.filter((h) => h.isGarrison); army.garrison(st, R).units = units({ militia: 16 });
  let captured = false, stillBlue = false;
  for (let i = 0; i < 400 && !captured; i++) { sim.step(st); if (st.areas.west_quarry.owner === 'BLUE') captured = true; }
  // hold for a bit and confirm a Blue host remains there
  for (let i = 0; i < 30; i++) { sim.step(st); if (st.areas.west_quarry.owner === 'BLUE' && B.armies.some((h) => army.currentArea(h) === 'west_quarry' && army.unitCount(h) >= 0.5)) stillBlue = true; }
  assert(captured, 'full sim: Blue captured the undefended enemy post (West Quarry → BLUE)');
  assert(stillBlue, 'full sim: Blue keeps a host garrisoning the captured post');
}

console.log('COMMANDER-OPPORTUNISM OK');
