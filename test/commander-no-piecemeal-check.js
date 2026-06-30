/* Regression: the Commander must NOT feed a LONE unit one-at-a-time into a bigger raiding force on one of our
 * outposts (the reported "sends a guy out one at a time to fight a bigger army" bug). A single unit that can't
 * win should hold at the Keep to mass up; a proper host should still sally to contest the raid. */
'use strict';
const C = require('../shared/constants.js');
const S = require('../shared/schema.js');
const sim = require('../server/sim.js');
const army = require('../server/systems/army.js');

let pass = 0, fail = 0;
function check(name, cond) { if (cond) { pass++; console.log('  ok   ' + name); } else { fail++; console.log('  FAIL ' + name); } }
function units(map) { const o = {}; for (const u of C.UNITS) o[u] = 0; for (const k in map) o[k] = map[k]; return o; }

// Pick a BLUE-owned outpost NOT adjacent to the Keep, raided by a bigger RED stack.
function setup(blueGarrison) {
  const st = S.createInitialState({ roomCode: 'TW' + blueGarrison, devMode: true, matchSeconds: 1800 });
  st.status = 'playing'; st.phase = 'MID';
  const B = st.teams.BLUE, R = st.teams.RED;
  for (const r of C.ROLE_ORDER) { B.slots[r].difficulty = 'hard'; R.slots[r].difficulty = 'hard'; }
  // Human Lord so Lord-AI doesn't levy/train more units mid-test (keeps BLUE army fixed).
  B.slots.LORD.playerId = 'human'; B.slots.LORD.connected = true;
  B.pop.recruits = 0; B.pop.trainers = 0; B.training = [];
  // A BLUE outpost the enemy is physically ON (a "threat"). north_forest exists on the standard map.
  const site = st.areas.north_forest || st.areas.west_quarry;
  site.owner = 'BLUE'; site.claimedBy = 'BLUE'; if (site.site) site.site.worked = true;
  army.garrison(st, B).units = units({ militia: blueGarrison });
  // RED raiding host of 3 sitting ON the outpost.
  R.armies = R.armies.filter((h) => h.isGarrison);
  R.armies.push({ id: S.uid('army'), team: 'RED', name: 'Raiders', units: units({ militia: 3 }), hasArmor: false, formation: 'line', stance: 'balanced', area: site.id, moving: null, mission: { type: 'garrison' }, morale: 'normal', x: site.x, y: site.y });
  army.garrison(st, R).units = units({ militia: 2 });
  return { st, B, siteId: site.id };
}

// ---- 1. LONE unit (1) must not be fed into the 3-stack: no <2-unit BLUE host marches to/sits on the site ----
{
  const { st, B, siteId } = setup(1);
  let fedLone = false;
  for (let i = 0; i < 40; i++) {
    sim.step(st);
    for (const h of B.armies) {
      if (h.isGarrison) continue;
      const at = army.currentArea(h), tgt = h.mission && h.mission.targetArea;
      if (army.unitCount(h) < 2 && (at === siteId || tgt === siteId)) fedLone = true;
    }
  }
  check('lone unit is NOT marched into the bigger raiding stack', fedLone === false);
  // The lone unit should still be alive (held home to mass, not thrown away).
  const blueTroops = B.armies.reduce((s, h) => s + army.unitCount(h), 0);
  check('lone unit survives (held to accumulate, not fed to death)', blueTroops >= 1);
}

// ---- 2. A PROPER host (6) still sallies to contest the raid (we didn't make the AI passive) ----
{
  const { st, B, siteId } = setup(6);
  let contested = false;
  for (let i = 0; i < 60 && !contested; i++) {
    sim.step(st);
    for (const h of B.armies) {
      if (h.isGarrison) continue;
      const at = army.currentArea(h), tgt = h.mission && h.mission.targetArea;
      if (army.unitCount(h) >= 2 && (at === siteId || tgt === siteId)) contested = true;
    }
  }
  check('a strong host DOES sally to contest the raid (not over-passive)', contested === true);
}

console.log('\n' + (fail === 0 ? 'ALL PASS' : (fail + ' FAILED')) + '  (' + pass + ' ok, ' + fail + ' fail)');
process.exit(fail === 0 ? 0 : 1);
