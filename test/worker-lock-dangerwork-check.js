/* Regression test: the Lord's worker LOCK must stop the Steward's DANGEROUS WORK from killing the Lord's
 * home workers (farmers/woodcutters/miners). Covers the engine guard, the lock-toggle stand-down, and the
 * AI Steward respecting the lock — plus a control case proving danger work still works when UNLOCKED. */
'use strict';
const path = require('path');
const C = require('../shared/constants.js');
const S = require('../shared/schema.js');
const B = require('../shared/balance.js');
const sim = require('../server/sim.js');

let pass = 0, fail = 0;
function check(name, cond) { if (cond) { pass++; console.log('  ok   ' + name); } else { fail++; console.log('  FAIL ' + name); } }

function newState(code) {
  const st = S.createInitialState({ roomCode: code, matchPreset: 'standard' });
  st.status = 'playing';
  return st;
}
// Put BLUE in a state where dangerous WOOD work is "critically wanted": wood near zero, comfortable pop,
// well fed, woodcutters assigned. RED left as-is (no enemy pressure on BLUE).
function setupBlue(st, opts) {
  opts = opts || {};
  const t = st.teams.BLUE;
  for (const r of C.ROLE_ORDER) t.slots[r].difficulty = 'hard';
  // Human Lord seat (so Lord-AI is skipped); Steward stays AI.
  t.slots.LORD.playerId = 'human-lord'; t.slots.LORD.connected = true;
  // Enough gathering buildings that the assigned crews fit capacity (WORKERS_PER_BUILDING = 4), so the only
  // thing that could shrink a crew is danger-work death — exactly what we're testing.
  t.buildings.lumberCamp = 3; t.buildings.farm = 3; t.buildings.mine = 2;
  t.resources.food = 200; t.resources.wood = 1; t.resources.stone = 80; t.resources.iron = 80;
  t.pop.total = 40; t.pop.woodcutters = 10; t.pop.farmers = 10; t.pop.miners = 6; t.pop.idle = 14;
  t._starving = false;
  if (opts.lock) t.workerLock = true;
  return t;
}

// ---- 1. Engine guard: setDangerWork(on) refused while locked, off/unlocked allowed ----
{
  const st = newState('WL1'); const t = setupBlue(st, { lock: true });
  const rOn = sim.applyAction(st, 'BLUE', 'STEWARD', 'setDangerWork', { pool: 'wood', on: true });
  check('engine: enabling danger work is REFUSED while workerLock is on', rOn.ok === false && !(t.dangerWork && t.dangerWork.wood));
  const rOff = sim.applyAction(st, 'BLUE', 'STEWARD', 'setDangerWork', { pool: 'wood', on: false });
  check('engine: standing danger work DOWN is allowed while locked', rOff.ok === true);
  t.workerLock = false;
  const rOn2 = sim.applyAction(st, 'BLUE', 'STEWARD', 'setDangerWork', { pool: 'wood', on: true });
  check('engine: enabling danger work IS allowed once unlocked', rOn2.ok === true && t.dangerWork.wood === true);
}

// ---- 2. Locking the workforce immediately stands down active danger work ----
{
  const st = newState('WL2'); const t = setupBlue(st, { lock: false });
  t.dangerWork = { food: false, wood: true, mine: true };
  const r = sim.applyAction(st, 'BLUE', 'LORD', 'setWorkerLock', { locked: true });
  check('lock toggle: returns ok', r.ok === true && t.workerLock === true);
  check('lock toggle: stands down ALL active danger work (wood)', t.dangerWork.wood === false);
  check('lock toggle: stands down ALL active danger work (mine)', t.dangerWork.mine === false);
}

// ---- 3. AI Steward respects the lock: never enables danger work (so locked workers can't be danger-killed) ----
{
  const st = newState('WL3'); const t = setupBlue(st, { lock: true });
  for (let i = 0; i < 120; i++) { t.resources.wood = 1; t.resources.food = 200; sim.step(st); }   // keep wood critical
  const dw = t.dangerWork || {};
  check('AI Steward: never enables danger work while locked', !dw.food && !dw.wood && !dw.mine);
}

// ---- 4. Control: UNLOCKED, the AI Steward still uses danger work when a good is critical ----
// (proves the lock — not some other change — is what gates it; mechanism still functions when unlocked.)
{
  const st = newState('WL4'); const t = setupBlue(st, { lock: false });
  let everOn = false;
  for (let i = 0; i < 120 && !everOn; i++) { t.resources.wood = 1; t.resources.food = 200; sim.step(st); if (t.dangerWork && t.dangerWork.wood) everOn = true; }
  check('control: UNLOCKED AI Steward does enable danger work on a critical good', everOn === true);
}

// ---- 5. Direct mechanism: danger work DOES kill home workers (the thing the lock protects against), and
//         OFF leaves them untouched. (Drives economy.tickEconomy directly with ample building capacity so the
//         capacity-clamp can't confound the worker counts.) ----
{
  const eco = require('../server/systems/economy.js');
  const dt = 1;
  const mk = (dangerWood) => {
    const st = newState('WL5' + (dangerWood ? 'on' : 'off')); const t = st.teams.BLUE;
    t.buildings.lumberCamp = 5;                 // cap 20 woodcutters → no clamp at 20
    t.resources.food = 500; t._starving = false;
    t.pop.total = 30; t.pop.woodcutters = 20; t.pop.farmers = 0; t.pop.miners = 0; t.pop.idle = 10;
    t.dangerWork = { food: false, wood: dangerWood, mine: false };
    const wc0 = t.pop.woodcutters;
    for (let i = 0; i < 200; i++) { t.resources.food = 500; eco.tickEconomy(st, t, dt, () => {}); }
    return { wc0, wc1: t.pop.woodcutters };
  };
  const on = mk(true), off = mk(false);
  check('mechanism: danger work ON kills woodcutters over time', on.wc1 < on.wc0);
  check('mechanism: danger work OFF leaves woodcutters intact', off.wc1 >= off.wc0);
}

console.log('\n' + (fail === 0 ? 'ALL PASS' : (fail + ' FAILED')) + '  (' + pass + ' ok, ' + fail + ' fail)');
process.exit(fail === 0 ? 0 : 1);
