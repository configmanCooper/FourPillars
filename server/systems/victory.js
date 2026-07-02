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
  // Simultaneous keep destruction (both fell the same tick) is a genuine mutual defeat — break it fairly
  // rather than always awarding BLUE (checked first).
  if (blue.keep.hp <= 0 && red.keep.hp <= 0) { const w = tieBreak(state, blue, red); return finish(state, w, (w === 'BLUE' ? 'Red' : 'Blue') + ' Keep destroyed! (both fell — tiebreak)'); }
  if (red.keep.hp <= 0) return finish(state, 'BLUE', 'Red Keep destroyed!');
  if (blue.keep.hp <= 0) return finish(state, 'RED', 'Blue Keep destroyed!');
  if (state.elapsed >= state.matchLength) {
    // Highest score wins; an EXACT tie is broken fairly (army, then a seed-deterministic coin) — not always BLUE.
    const winner = (Math.abs(blue.score - red.score) < 0.5) ? tieBreak(state, blue, red) : (blue.score > red.score ? 'BLUE' : 'RED');
    return finish(state, winner, 'Time! Highest Kingdom Score wins.');
  }
  return null;
}
// Fair, DETERMINISTIC tiebreaker (reproducible from the seed, but not biased to BLUE): more army, else a
// coin derived from the room code + elapsed time.
function tieBreak(state, blue, red) {
  const ba = blue.pop.soldiers || 0, ra = red.pop.soldiers || 0;
  if (Math.abs(ba - ra) >= 1) return ba > ra ? 'BLUE' : 'RED';
  let h = 2166136261; const s = (state.roomCode || '') + '|' + Math.round(state.elapsed);
  for (let i = 0; i < s.length; i++) { h ^= s.charCodeAt(i); h = Math.imul(h, 16777619); }
  return ((h >>> 0) % 2 === 0) ? 'BLUE' : 'RED';
}

function finish(state, winner, reason) {
  state.status = 'over'; state.winner = winner; state.winReason = reason;
  return { winner, reason };
}

module.exports = { computeScore, update, checkVictory, finish, buildingCount, armyStrength, sitesControlled };
