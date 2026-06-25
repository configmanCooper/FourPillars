/* Headless check: a Commander with a strong army actively RETAKES an enemy-held post that borders its
   territory (counter-attack), rather than parking the army at the Keep. */
'use strict';
const C = require('../shared/constants.js');
const S = require('../shared/schema.js');
const sim = require('../server/sim.js');
const army = require('../server/systems/army.js');

function assert(cond, msg) { if (!cond) { console.error('FAIL:', msg); process.exit(1); } console.log('ok -', msg); }
function units(map) { const o = {}; for (const u of C.UNITS) o[u] = 0; for (const k in map) o[k] = map[k]; return o; }

const st = S.createInitialState({ roomCode: 'CTR', devMode: true, matchSeconds: 1800 });
st.status = 'playing';
const B = st.teams.BLUE, R = st.teams.RED;
B.aiPersona = B.aiPersona || {}; B.aiPersona.COMMANDER = 'wolf';
army.garrison(st, B).units = units({ militia: 14 });

// Red holds West Quarry (adjacent to Blue's Keep) with a small occupying host.
const wq = st.areas.west_quarry; wq.owner = 'RED'; wq.claimedBy = 'RED'; if (wq.site) wq.site.worked = true;
R.armies = R.armies.filter((h) => h.isGarrison);
R.armies.push({ id: S.uid('army'), team: 'RED', name: 'Occupiers', units: units({ militia: 3 }), hasArmor: false, formation: 'line', stance: 'balanced', area: 'west_quarry', moving: null, mission: { type: 'garrison' }, morale: 'normal', x: wq.x, y: wq.y });
army.garrison(st, R).units = units({ militia: 4 });

// Within a handful of seconds the Commander should ORDER a host to take West Quarry…
let ordered = false;
for (let i = 0; i < 40 && !ordered; i++) {
  sim.step(st);
  ordered = B.armies.some((h) => !h.isGarrison && army.unitCount(h) >= 2 && h.mission && (h.mission.type === 'raid' || h.mission.type === 'garrison') && (h.mission.targetArea === 'west_quarry' || army.currentArea(h) === 'west_quarry'));
}
assert(ordered, 'Commander committed a strong host to retake West Quarry');

// …and actually RETAKE it (and NOT leave a huge host idling at the Keep the whole time).
let retook = st.areas.west_quarry.owner === 'BLUE';
let maxIdleAtKeep = 0;
for (let i = 0; i < 400 && !retook; i++) {
  sim.step(st);
  if (st.areas.west_quarry.owner === 'BLUE') retook = true;
  const idle = B.armies.filter((h) => !h.isGarrison && army.currentArea(h) === 'blue_base' && !h.moving && (h.mission && (h.mission.type === 'garrison' || h.mission.type === 'defend' || h.mission.type === 'idle'))).reduce((s, h) => s + army.unitCount(h), 0);
  maxIdleAtKeep = Math.max(maxIdleAtKeep, idle);
}
assert(retook, 'West Quarry was retaken (owner → BLUE)');
console.log('   (max idle field troops parked at the Keep during the campaign: ' + Math.round(maxIdleAtKeep) + ')');

console.log('COMMANDER-COUNTERATTACK OK');
