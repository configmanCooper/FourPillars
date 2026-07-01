/* Verifies two AI capture fixes:
   1. STICKY CAPTURE — a host standing on an UNDEFENDED enemy outpost holds there (garrison) until the ground
      flips, instead of wandering off and resetting the ~10s capture clock.
   2. NO SUICIDE SIEGE — a weak host parked at a FULL, well-defended enemy Keep does NOT keep sieging it. */
'use strict';
const C = require('../shared/constants.js');
const S = require('../shared/schema.js');
const army = require('../server/systems/army.js');
const sim = require('../server/sim.js');

let fails = 0;
function ok(cond, msg) { if (!cond) { console.log('  FAIL:', msg); fails++; } else { console.log('  ok:', msg); } }

function freshGame() {
  const st = S.createInitialState({ roomCode: 'CAP', seed: 9, matchPreset: 'standard' });
  st.status = 'playing';
  for (const r of C.ROLE_ORDER) { st.teams.BLUE.slots[r].difficulty = 'hard'; st.teams.RED.slots[r].difficulty = 'hard'; }
  return st;
}
function host(team, area, units) {
  const g = { id: S.uid('a'), team: team.team, name: 'H', units: {}, gear: {}, area,
    formation: 'line', stance: 'balanced', morale: 'normal', moving: null, mission: { type: 'idle' }, energy: 100 };
  for (const u of C.UNITS) g.units[u] = 0; Object.assign(g.units, units); army.ensureGear(g); return g;
}

// ---- Test 1: sticky capture ----
{
  const st = freshGame();
  const red = st.teams.RED, blue = st.teams.BLUE;
  // Find a non-base area, make BLUE own it as a building-less outpost, and drop a RED host on it (no defender).
  let postId = null;
  for (const id in st.areas) { const a = st.areas[id]; if (a.terrain !== 'base' && a.connections.length >= 2) { postId = id; break; } }
  const post = st.areas[postId];
  post.owner = 'BLUE'; post.claimedBy = 'BLUE'; post.buildings = {}; post.site = post.site || { level: 1, cargo: 0 };
  post.captureProgress = 0;
  const raider = host(red, postId, { spearman: 3 });
  red.armies = [raider];
  // Run the RED Commander AI decision directly for this host — it should HOLD (not leave) to capture.
  const before = raider.area;
  // Advance several sim steps; the outpost should flip to RED (captured) rather than the host wandering off.
  let captured = false;
  for (let i = 0; i < 30 && !captured; i++) { sim.step(st); if (st.areas[postId].owner === 'RED') captured = true; }
  ok(captured, 'a RED host on an undefended BLUE outpost HELD and captured it (owner flipped to RED)');
}

// ---- Test 2: no suicide siege on a full, well-defended keep ----
{
  const st = freshGame();
  const red = st.teams.RED, blue = st.teams.BLUE;
  const ekId = S.homeBase('BLUE');
  // Blue keep full + heavily garrisoned.
  blue.keep.hp = blue.keep.maxHp;
  blue.armies = [host(blue, ekId, { spearman: 12 })];
  // A weak RED host sitting AT the enemy keep.
  const weak = host(red, ekId, { spearman: 3 });
  red.armies = [weak];
  // One AI think: the weak host must NOT be ordered to keep sieging the full keep.
  const sys = sim.SYSTEMS;
  const st2 = { acted: false, cd: {} };
  // Drive the commander brain once via a sim step, then inspect the host's mission.
  sim.step(st);
  const m = (red.armies[0] && red.armies[0].mission && red.armies[0].mission.type) || 'idle';
  ok(m !== 'siege', 'weak RED host did NOT commit to sieging the FULL defended keep (mission=' + m + ')');
}

console.log(fails === 0 ? '\nCAPTURE / SIEGE-SANITY OK' : '\n' + fails + ' FAILURES');
process.exit(fails === 0 ? 0 : 1);
