/* Victory & scoring. */
'use strict';
const C = require('../../shared/constants.js');
const B = require('../../shared/balance.js');
const S = require('../../shared/schema.js');

function buildingCount(team) { let n = 0; for (const k in team.buildings) n += team.buildings[k]; return n; }
function armyStrength(team) {
  let p = 0;
  for (const g of team.armies) for (const u of C.UNITS) p += (g.units[u] || 0) * (B.UNIT_STATS[u].atk + B.UNIT_STATS[u].def);
  return p;
}
function sitesControlled(state, team) {
  let n = 0; for (const id in state.areas) { const a = state.areas[id]; if (a.terrain !== 'base' && a.claimedBy === team.team) n++; }
  return n;
}

function computeScore(state, team) {
  const w = B.SCORE_WEIGHTS;
  return Math.round(
    team.keep.hp * w.keepHp +
    buildingCount(team) * w.buildings +
    armyStrength(team) * w.army +
    sitesControlled(state, team) * w.sites +
    (team.resources.relics || 0) * w.relics +
    (team.razeScore || 0)
  );
}

function update(state) {
  state.teams.BLUE.score = computeScore(state, state.teams.BLUE);
  state.teams.RED.score = computeScore(state, state.teams.RED);
}

function checkVictory(state) {
  if (state.status === 'over') return null;
  const blue = state.teams.BLUE, red = state.teams.RED;
  if (red.keep.hp <= 0) return finish(state, 'BLUE', 'Red Keep destroyed!');
  if (blue.keep.hp <= 0) return finish(state, 'RED', 'Blue Keep destroyed!');
  if (state.elapsed >= state.matchLength) {
    const winner = blue.score >= red.score ? 'BLUE' : 'RED';
    return finish(state, winner, 'Time! Highest Kingdom Score wins.');
  }
  return null;
}

function finish(state, winner, reason) {
  state.status = 'over'; state.winner = winner; state.winReason = reason;
  return { winner, reason };
}

module.exports = { computeScore, update, checkVictory, finish, buildingCount, armyStrength, sitesControlled };
