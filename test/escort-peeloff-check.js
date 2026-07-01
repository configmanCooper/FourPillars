/* Verifies the escort peel-off: when a GUARDED (escorted) caravan runs into enemy troops, the escort host
   detaches to fight (rearguard), the caravan continues UNGUARDED, and the raiders are pinned to fight it. */
'use strict';
const C = require('../shared/constants.js');
const S = require('../shared/schema.js');
const sites = require('../server/systems/sites.js');
const army = require('../server/systems/army.js');

let fails = 0;
function ok(cond, msg) { if (!cond) { console.log('  FAIL:', msg); fails++; } else { console.log('  ok:', msg); } }

const state = S.createInitialState({ roomCode: 'EC', seed: 3, devMode: true, matchSeconds: 720 });
state.status = 'playing';
state.elapsed = 100;
const team = state.teams.BLUE;
const foe = state.teams.RED;

// Find two connected non-base areas to stage a caravan leg into an enemy-held tile.
let legFrom = null, legTo = null;
for (const id in state.areas) {
  const a = state.areas[id];
  if (a.terrain === 'base') continue;
  const nb = a.connections.find((n) => state.areas[n] && state.areas[n].terrain !== 'base');
  if (nb) { legFrom = id; legTo = nb; break; }
}
ok(legFrom && legTo, 'found a caravan leg ' + legFrom + ' -> ' + legTo);

// Put an enemy host ON the destination tile (the ambush point).
const enemy = { id: S.uid('a'), team: 'RED', name: 'Raiders', units: {}, gear: {}, area: legTo,
  formation: 'line', stance: 'balanced', morale: 'normal', moving: null, mission: { type: 'idle' }, energy: 100 };
for (const u of C.UNITS) enemy.units[u] = 0;
enemy.units.militia = 4; army.ensureGear(enemy);
foe.armies = [enemy];

// Build an escort host for BLUE and an escorted caravan about to enter legTo.
const esc = { id: S.uid('a'), team: 'BLUE', name: 'Escort', units: {}, gear: {}, area: legFrom,
  formation: 'line', stance: 'balanced', morale: 'normal', moving: null, mission: { type: 'escort' }, energy: 100 };
for (const u of C.UNITS) esc.units[u] = 0;
esc.units.spearman = 5; army.ensureGear(esc);
team.armies = [esc];

const fa = state.areas[legFrom], ta = state.areas[legTo];
const cv = { id: S.uid('cv'), resource: 'wood', cargo: { wood: 10 }, route: [legFrom, legTo, legFrom],
  legIndex: 0, t: 0.999, x: fa.x, y: fa.y, escort: true, escortGroupId: esc.id, guards: 0, guardPost: legFrom };
team.caravans = [cv];

// Advance the caravan one tick so it crosses into legTo and meets the enemy.
const rng = { chance: () => false, range: () => 0, pick: (a) => a[0] };
sites.tickSites(state, team, 1, rng, null);

ok(cv.escort === false, 'caravan is now UNGUARDED (escort detached)');
ok(cv.escortGroupId == null, 'caravan escortGroupId cleared');
ok(team.caravans.indexOf(cv) >= 0, 'caravan SURVIVED and rolls on (not destroyed)');
ok(typeof esc.rearguardUntil === 'number' && esc.rearguardUntil > state.elapsed, 'escort flagged as rearguard for the UI');
ok(esc.mission && (esc.moving || army.currentArea(esc) === legTo), 'escort is moving to / standing at the enemy to fight');
ok(enemy.pinnedUntil && enemy.pinnedUntil > state.elapsed, 'raiders pinned to fight the rearguard (caravan not chased through)');

console.log(fails === 0 ? '\nESCORT PEEL-OFF OK' : '\n' + fails + ' FAILURES');
process.exit(fails === 0 ? 0 : 1);
