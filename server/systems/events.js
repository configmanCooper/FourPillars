/* World events: periodic pressure. Few, readable, decision-provoking. */
'use strict';
const B = require('../../shared/balance.js');
const S = require('../../shared/schema.js');
const eco = require('./economy.js');

const EVENTS = [
  { id: 'goodHarvest', text: 'Good harvest! +60 food.', apply: (s, t) => eco.addResource(t, 'food', 60) },
  { id: 'refugees',    text: 'Refugees arrive — population grows but food strains.', apply: (s, t) => { t.pop.idle += Math.max(0, Math.min(3, t.housing - t.pop.total)); t.resources.food = Math.max(0, t.resources.food - 20); eco.recomputeDerived(t); } },
  { id: 'mineCollapse',text: 'A mine partially collapsed — iron stocks shaken.', apply: (s, t) => { if (!eco.isHeldNow(t, 'iron')) t.resources.iron = Math.max(0, t.resources.iron - 25); } },
  { id: 'forestFire',  text: 'Forest fire! Wood reserves scorched.', apply: (s, t) => { if (!eco.isHeldNow(t, 'wood')) t.resources.wood = Math.max(0, t.resources.wood - 30); } },
  { id: 'merchant',    text: 'A merchant trades 40 wood for 20 iron.', apply: (s, t) => { if (!eco.isHeldNow(t, 'wood') && t.resources.wood >= 40) { t.resources.wood -= 40; eco.addResource(t, 'iron', 20); } } },
  { id: 'harshWeather',text: 'Harsh weather slows the realm.', apply: (s, t) => { if (!eco.isHeldNow(t, 'food')) t.resources.food = Math.max(0, t.resources.food - 10); } },
  { id: 'banditRaid',  text: 'Bandits raid an outpost!', apply: (s, t) => { for (const id in s.areas) { const a = s.areas[id]; if (a.claimedBy === t.team && a.site) { a.site.cargo = 0; break; } } } },
  { id: 'relicOmen',   text: 'Whispers of relics in the ruins…', apply: (s, t) => { const r = s.areas.ancient_ruins; if (r) r.revealed[t.team] = true; } },
];

function tickEvents(state, rng, log) {
  if (state.elapsed < state.nextEventAt) return;
  const ev = rng.pick(EVENTS);
  const team = rng.chance(0.5) ? state.teams.BLUE : state.teams.RED;
  ev.apply(state, team);
  log(team.team, 'Event — ' + ev.text, 'event');
  state.nextEventAt = state.elapsed + rng.int(B.EVENT_INTERVAL[0], B.EVENT_INTERVAL[1]);
}

module.exports = { tickEvents };
