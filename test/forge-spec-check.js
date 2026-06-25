/* Headless check: a Blacksmith specialisation is per-item and forges that one item 10% faster
   (a 10% forge-time reduction), leaving other items unaffected. */
'use strict';
const B = require('../shared/balance.js');
const S = require('../shared/schema.js');
const production = require('../server/systems/production.js');

function assert(cond, msg) { if (!cond) { console.error('FAIL:', msg); process.exit(1); } console.log('ok -', msg); }
function near(a, b) { return Math.abs(a - b) < 1e-9; }

const state = S.createInitialState({ roomCode: 'SPC', devMode: true, matchSeconds: 720 });
const T = state.teams.BLUE;

// All seven forgeable items are valid specialisations.
const items = ['tools', 'spears', 'swords', 'bows', 'arrows', 'armor', 'siegeParts'];
assert(items.every((it) => B.BLACKSMITH_SPECS[it] && B.BLACKSMITH_SPECS[it].item === it), 'every forgeable item is a per-item specialisation');

T.blacksmithSpec = null;
const baseSwords = production.forgeSpeedMult(T, 'swords');
const baseBows = production.forgeSpeedMult(T, 'bows');

T.blacksmithSpec = 'swords';
const specSwords = production.forgeSpeedMult(T, 'swords');
const specBows = production.forgeSpeedMult(T, 'bows');

// Specialised item: speed ×1/(1-0.10) ⇒ forge time ×0.90 (a 10% decrease).
assert(near(specSwords, baseSwords / (1 - B.SPEC_TIME_REDUCTION)), 'specialised item forge SPEED is 1/(1-0.10)× the base');
const timeRatio = (B.RECIPES.swords.time / specSwords) / (B.RECIPES.swords.time / baseSwords);
assert(near(timeRatio, 0.9), 'specialised item takes 10% less time to forge (×0.90)');
assert(near(specBows, baseBows), 'a non-specialised item is unaffected');

// Switching the specialisation moves the bonus.
T.blacksmithSpec = 'bows';
assert(near(production.forgeSpeedMult(T, 'swords'), baseSwords), 'after switching, swords return to base speed');
assert(near(production.forgeSpeedMult(T, 'bows'), baseBows / (1 - B.SPEC_TIME_REDUCTION)), 'after switching, bows now forge 10% faster');

console.log('FORGE-SPEC OK');
