/* Headless check: a LONE enemy scout parked next to our Keep must NOT pin the whole army home.
   The Commander should keep the offensive alive — spin up an Outriders harasser and push it toward the
   enemy's caravan chokepoint — while still recalling for a REAL massed assault on the Keep. */
'use strict';
const C = require('../shared/constants.js');
const S = require('../shared/schema.js');
const sim = require('../server/sim.js');
const ai = require('../server/systems/ai.js');
const army = require('../server/systems/army.js');
const { makeRng } = require('../server/rng.js');

function assert(cond, msg) { if (!cond) { console.error('FAIL:', msg); process.exit(1); } console.log('ok -', msg); }
function units(map) { const o = {}; for (const u of C.UNITS) o[u] = 0; for (const k in map) o[k] = map[k]; return o; }
function host(team, area, u, name) {
  const ar = state.areas[area];
  return { id: S.uid('army'), team, name: name || 'Host', units: units(u), hasArmor: false, formation: 'line', stance: 'balanced', area, moving: null, mission: { type: 'garrison' }, morale: 'normal', x: ar.x, y: ar.y };
}

const state = S.createInitialState({ roomCode: 'CMD', devMode: true, matchSeconds: 720 });
state.status = 'playing';
const BLUE = state.teams.BLUE, RED = state.teams.RED;
const SYS = sim.SYSTEMS;
const rng = makeRng(11);

// Blue: a healthy home garrison and a full Keep. Make the Commander aggressive so we test the THREAT
// gate (not persona timidity).
BLUE.aiPersona = BLUE.aiPersona || {}; BLUE.aiPersona.COMMANDER = 'wolf';
const g = army.garrison(state, BLUE); g.units = units({ militia: 14 });
BLUE.keep.hp = BLUE.keep.maxHp;
// Red: its own garrison so the force ratio is sane, plus some caravans to give a real supply line.
const rg = army.garrison(state, RED); rg.units = units({ militia: 8 });

function reset() { g.units = units({ militia: 14 }); BLUE.keep.hp = BLUE.keep.maxHp; }

// ---- Case A: a LONE Red scout (1 unit) at north_forest (adjacent to Blue Keep). Should NOT lock down.
RED.armies = RED.armies.filter((h) => h.isGarrison);
RED.armies.push(host('RED', 'north_forest', { militia: 1 }, 'Scout'));
let harasser = false, offensive = false;
for (let i = 0; i < 40; i++) {
  reset();
  ai.aiTick(state, BLUE, 1, SYS, rng);
  state.elapsed += 1; BLUE._elapsed = state.elapsed;
  if (BLUE.armies.some((h) => h.harasser && army.unitCount(h) >= 0.5)) harasser = true;
  // A field host COMMANDED off our three home tiles (or onto an offensive mission) = projecting power.
  const homeSide = { blue_base: 1, north_forest: 1, west_quarry: 1, south_forest: 1 };
  if (BLUE.armies.some((h) => {
    if (h.isGarrison || army.unitCount(h) < 0.5) return false;
    const m = h.mission || {};
    if (m.type === 'siege' || m.type === 'raid') return true;
    const dest = m.targetArea || army.currentArea(h);
    return !homeSide[dest];
  })) offensive = true;
}
assert(harasser, 'lone scout: Commander still raised an Outriders harasser (army not pinned home)');
assert(offensive, 'lone scout: at least one field host pushed forward off the home tiles');

// ---- Case B: a REAL massed assault — 6 Red units sitting ON Blue Keep. Should recall to defend.
RED.armies = RED.armies.filter((h) => h.isGarrison);
RED.armies.push(host('RED', 'blue_base', { militia: 6 }, 'War Host'));
let recalled = false;
for (let i = 0; i < 25; i++) {
  reset();
  ai.aiTick(state, BLUE, 1, SYS, rng);
  state.elapsed += 1; BLUE._elapsed = state.elapsed;
  const fhs = BLUE.armies.filter((h) => !h.isGarrison && army.unitCount(h) >= 0.5);
  // Under a real Keep assault every field host should be heading home to defend.
  if (fhs.length && fhs.every((h) => (h.mission && h.mission.type) === 'defend' || army.currentArea(h) === 'blue_base')) recalled = true;
  if (!fhs.length) recalled = true; // folded back into the garrison = also "all home"
}
assert(recalled, 'real assault: Commander recalled the field hosts to defend the Keep');

console.log('COMMANDER-INTERDICT OK');
