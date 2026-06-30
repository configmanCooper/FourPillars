/* Regression: you cannot raise buildings on SEIZED-but-UNCLAIMED ground (owner set, no outpost). After
 * razing/capturing an enemy outpost the ground is owned but un-claimed — you must re-claim (rebuild the
 * outpost) before building. Reproduces the "Red owns it, has buildings, but Outpost: unclaimed" bug. */
'use strict';
const C = require('../shared/constants.js');
const S = require('../shared/schema.js');
const buildings = require('../server/systems/buildings.js');
const sites = require('../server/systems/sites.js');

let pass = 0, fail = 0;
function check(name, cond) { if (cond) { pass++; console.log('  ok   ' + name); } else { fail++; console.log('  FAIL ' + name); } }

const st = S.createInitialState({ roomCode: 'CB', matchPreset: 'standard' });
st.status = 'playing';
const R = st.teams.RED;
const site = st.areas.south_farmland || Object.values(st.areas).find((a) => a.terrain !== 'base' && a.site);

// Simulate "seized the ground": owned by RED, but NO outpost (claimedBy null), no buildings.
site.owner = 'RED'; site.claimedBy = null; site.buildings = {};
R.resources.wood = 500; R.resources.stone = 500; R.resources.iron = 500;

// 1. Building on seized-but-unclaimed ground must be REFUSED.
const r1 = buildings.queueBuilding(st, R, site.id, 'marketplace');
check('cannot build on owned-but-unclaimed (seized) ground', r1.ok === false);
check('site still has no buildings', S.buildingsAt(site) === 0);

// 2. Keep (base) building still works (base is exempt — it has no claimedBy).
const keep = st.areas[S.homeBase('RED')];
const r2 = buildings.queueBuilding(st, R, keep.id, 'house');
check('can still build at the Keep (base exempt)', r2.ok === true);

// 3. After RE-CLAIMING the outpost, building is allowed again.
site.revealed = site.revealed || {}; site.revealed.RED = true;
site.scouted = site.scouted || {}; site.scouted.RED = true;
site.scoutedUntil = site.scoutedUntil || {}; site.scoutedUntil.RED = 99999;
R._busyJob = null;
const rc = sites.claim(st, R, site.id);   // fully funds (RED has plenty) → starts the build job
const rng = { chance: () => false, pick: (a) => a[0], int: () => 0, range: () => 0, float: () => 0 };
let g = 0; while (site.claimedBy !== 'RED' && g < 60) { sites.tickSites(st, R, 1, rng, () => {}); g++; }
check('re-claim sets the outpost (claimedBy = RED)', site.claimedBy === 'RED');
const r3 = buildings.queueBuilding(st, R, site.id, 'marketplace');
check('can build once the outpost is re-claimed', r3.ok === true);

console.log('\n' + (fail === 0 ? 'ALL PASS' : (fail + ' FAILED')) + '  (' + pass + ' ok, ' + fail + ' fail)');
process.exit(fail === 0 ? 0 : 1);
