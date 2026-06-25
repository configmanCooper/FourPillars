/* tips.js — reads the live snapshot and produces role-aware "what should I do now" guidance. */
(function () {
  'use strict';
  const C = window.FP.Constants, B = window.FP.Balance, State = window.FP.State;

  function ownedSites(snap, team) {
    let n = 0; for (const id in snap.areas) { const a = snap.areas[id]; if (a.terrain !== 'base' && a.owner === team) n++; }
    return n;
  }
  function keepArea(snap, team) { return snap.areas[team === 'BLUE' ? 'blue_base' : 'red_base']; }
  function slotsAt(area) { let n = 0; for (const t in area.buildings) n += area.buildings[t]; return n; }
  function enemyNearOwned(snap, me, foe) {
    for (const g of snap.teams[foe].armies) { const a = g.moving ? g.moving.route[g.moving.legIndex] : g.area; const ar = snap.areas[a]; if (ar && ar.owner === me) return ar; }
    return null;
  }
  function freeKeepSlots(snap, team) { const k = keepArea(snap, team); return k.maxBuildings - slotsAt(k); }

  // Returns { mission, summary:[{label,value,tone}], tips:[{text,because,call,label}] } — first tip is the primary.
  function compute(snap, State) {
    const team = snap.teams[State.myTeam]; const role = State.myRole; const foe = State.myTeam === 'BLUE' ? 'RED' : 'BLUE';
    const tips = [];
    const add = (text, because, label, call) => tips.push({ text, because, label, call });

    // Shared: unanswered requests for me.
    const incoming = team.requests.filter((r) => r.status === 'open' && r.targetRole === role).length;

    const mission = {
      LORD: 'Grow the kingdom: assign workers, place buildings, keep food positive. Buildings sit at a location but help the whole realm.',
      STEWARD: 'Expand the realm: scout, claim resource sites, and run caravans home (guard them!).',
      BLACKSMITH: 'Arm the realm: forge tools, weapons, armour and arrows; take timed contracts.',
      COMMANDER: 'Win the war: muster soldiers, protect caravans, raid the foe, and siege their Keep.',
    }[role];

    if (role === 'LORD') {
      const idle = team.pop.idle;
      if (idle > 0) add('Assign your ' + idle + ' idle workers', 'idle workers produce nothing', 'Workers', 'FP.UI.modalWorkers()');
      if (team.resources.food < 40) add('Boost food now', 'low food halts population growth', 'Workers', 'FP.UI.modalWorkers()');
      if (!team.policy) add('Choose a kingdom Policy', 'a policy speeds growth, building or training', 'Policy', 'FP.UI.modalPolicy()');
      if (team.buildings.barracks < 1) add('Build a Barracks', 'needed before you can assign Trainers and the Commander can train troops', 'Build', 'FP.UI.modalBuild()');
      if (team.buildings.barracks >= 1 && team.pop.trainers === 0) add('Assign Trainers (Workers)', 'Trainers at a Barracks are what turn recruits into troops — without them the army cannot grow', 'Workers', 'FP.UI.modalWorkers()');
      if (team.buildings.barracks >= 1 && team.pop.recruits < 3 && team.pop.soldiers < 6) add('Levy a few Soldiers (Workers)', 'commit workers to the army as recruits (one-way) so the Commander has bodies to train', 'Workers', 'FP.UI.modalWorkers()');
      if (team.pop.total >= team.housing - 1) add('Build a House', 'you are at the population cap (' + team.pop.total + '/' + team.housing + ') — more housing lets workers and soldiers grow', 'Build', 'FP.UI.modalBuild()');
      if (freeKeepSlots(snap, State.myTeam) <= 0 && ownedSites(snap, State.myTeam) === 0) add('Expand! Your Keep is full (7/7)', 'claimed sites add build slots — ask the Steward to claim one', 'Ask', "FP.UI.needResource('iron')");
      if (team.buildings.school < 1 && snap.phase !== 'EARLY') add('Build a School (mid-game)', 'lets you train Educated workers who reassign in 5s instead of 30s', 'Build', 'FP.UI.modalBuild()');
      if (team.buildings.stables < 1 && snap.phase !== 'EARLY') add('Build Stables (mid-game)', 'unlocks cavalry for the Commander', 'Build', 'FP.UI.modalBuild()');
    } else if (role === 'STEWARD') {
      let canExplore = null, canClaim = null;
      for (const id in snap.areas) { const a = snap.areas[id];
        if (!a.revealed[State.myTeam] && a.connections.some((n) => snap.areas[n].revealed[State.myTeam])) canExplore = canExplore || a;
        if (a.revealed[State.myTeam] && a.site && a.terrain !== 'base' && !a.owner) canClaim = canClaim || a; }
      if (canClaim) add('Claim ' + canClaim.name, 'claimed sites ship resources home and give build slots', 'Sites', 'FP.UI.modalSites()');
      if (canExplore) add('Scout ' + canExplore.name, 'exploring reveals new sites to claim', 'Sites', 'FP.UI.modalSites()');
      const danger = team.caravans.find((cv) => !cv.escort);
      if (danger) add('Ask the Commander for an escort', 'unescorted caravans can be ambushed', 'Ask Escort', "FP.UI.request('ESCORT')");
      const mySites = []; for (const id in snap.areas) { const a = snap.areas[id]; if (a.claimedBy === State.myTeam && a.terrain !== 'base') mySites.push(a); }
      if (mySites.length) add('Upgrade a site for more output', 'higher-level sites fill caravans faster', 'Sites', 'FP.UI.modalSites()');
    } else if (role === 'BLACKSMITH') {
      if (!team.blacksmithSpec) add('Pick a forge focus', 'it speeds part of your output (switchable later)', 'Specialize', 'FP.UI.modalSpec()');
      if (team.equipment.tools < 4 && snap.phase === 'EARLY') add('Forge Tools first', 'Tools raise every worker\'s output', 'Forge', 'FP.UI.modalForge()');
      if (team.equipment.bows > 0 && (team.resources.arrows || 0) < 10) add('Forge Arrows', 'Archers need arrows or they fight at half strength', 'Forge', 'FP.UI.modalForge()');
      if (!team.production.length) add('Queue something in the Forge', 'an idle forge wastes the war effort', 'Forge', 'FP.UI.modalForge()');
      if (!team.contract && team.contractCooldown <= 0) add('Take a Forge Contract', 'contracts give bonus resources for hitting a quota', 'Contracts', 'FP.UI.modalContracts()');
      if ((team.resources.iron || 0) < 12) add('Ask the Steward for iron', 'weapons and armour need iron from the mines', 'Need Iron', "FP.UI.request('IRON')");
    } else if (role === 'COMMANDER') {
      if (!team.doctrine) add('Choose a Doctrine', 'it boosts your attacks, defence or logistics', 'Doctrine', 'FP.UI.modalDoctrine()');
      if (team.buildings.barracks < 1) add('Ask the Lord for a Barracks', 'you train troops at a Barracks — none exists yet', 'Need', "FP.UI.request('RECRUITS')");
      else if (team.pop.trainers < 1) add('Ask the Lord to assign Trainers', 'training only progresses with Trainers at a Barracks', 'Need', "FP.UI.request('RECRUITS')");
      else if (team.pop.recruits >= 1) add('Train ' + Math.round(team.pop.recruits) + ' recruits into troops', 'pick a Barracks and a unit type — training takes time based on Trainers', 'Train', 'FP.UI.modalMuster()');
      else add('Ask the Lord to levy recruits', 'you need recruits (the Lord commits workers to the army) before you can train', 'Need Recruits', "FP.UI.request('RECRUITS')");
      const danger = team.caravans.find((cv) => !cv.escort);
      if (danger) add('Escort a caravan', 'protecting trade keeps resources flowing', 'Orders', 'FP.UI.modalOrders()');
      const threat = enemyNearOwned(snap, State.myTeam, foe);
      if (threat) add('Defend ' + threat.name + '!', 'an enemy host is there — undefended sites get captured', 'Orders', 'FP.UI.modalOrders()');
      if (snap.phase === 'LATE' && team.pop.soldiers >= 10) add('Siege the enemy Keep', 'destroying it wins the game', 'Orders', 'FP.UI.modalOrders()');
      if ((team.equipment.spears + team.equipment.swords + team.equipment.bows) < 3) add('Ask the Blacksmith for weapons', 'unarmed recruits can only become weak militia', 'Need Weapons', "FP.UI.request('EQUIPMENT')");
        // Follow the Lord's military stance directive.
        const mp = B.MILITARY_POLICIES[team.militaryPolicy || 'balanced'];
        if (mp && (team.militaryPolicy === 'aggressive')) add('Stance: ' + mp.name + ' — press the attack', 'the Lord wants you raiding enemy land and sieging when strong', 'Orders', 'FP.UI.modalOrders()');
        else if (mp && (team.militaryPolicy === 'defensive')) add('Stance: ' + mp.name + ' — hold your ground', 'the Lord wants you defending the Keep and your richest sites first', 'Orders', 'FP.UI.modalOrders()');
      }
      if (role === 'LORD') {
        const mp = B.MILITARY_POLICIES[team.militaryPolicy || 'balanced'];
        if (mp) add('Military stance: ' + mp.name, mp.desc + ' Set it via the ⚔️ Stance button.', 'Stance', 'FP.UI.modalMilitaryPolicy()');
      }

    if (incoming > 0) tips.unshift({ text: 'Answer ' + incoming + ' teammate request' + (incoming > 1 ? 's' : ''), because: 'your council needs your help', label: 'Requests', call: "FP.UI.showTab('requests')" });
    if (!tips.length) add('You are in good shape — watch the map and help teammates', 'no urgent action right now', 'Comms', "FP.UI.showTab('comms')");

    // World-state summary.
    const threat = enemyNearOwned(snap, State.myTeam, foe);
    const summary = [
      { label: 'Phase', value: snap.phase + ' · ' + fmtTime(snap.matchLength - snap.elapsed) + ' left', tone: '' },
      { label: 'Score', value: 'You ' + team.score + ' vs ' + snap.teams[foe].score, tone: team.score >= snap.teams[foe].score ? 'good' : 'warn' },
      { label: 'Food', value: Math.round(team.resources.food) + (team._starving ? ' (STARVING)' : ''), tone: team.resources.food < 30 ? 'bad' : 'good' },
      { label: 'Population', value: team.pop.total + '/' + team.housing + ' · ' + team.pop.idle + ' idle', tone: team.pop.idle > 0 ? 'warn' : '' },
      { label: 'Army', value: team.pop.soldiers + ' soldiers · ' + team.armies.filter((g) => count(g) >= 0.5).length + ' hosts', tone: '' },
      { label: 'Stance', value: (B.MILITARY_POLICIES[team.militaryPolicy || 'balanced'] || {}).name || 'Balanced', tone: team.militaryPolicy === 'aggressive' ? 'warn' : '' },
      { label: 'Territory', value: (ownedSites(snap, State.myTeam)) + ' sites + Keep', tone: '' },
    ];
    if (threat) summary.push({ label: 'Threat', value: 'Enemy at ' + threat.name + '!', tone: 'bad' });

    return { mission, summary, tips };
  }
  function count(g) { let n = 0; for (const u of C.UNITS) n += g.units[u] || 0; return n; }
  function fmtTime(s) { s = Math.max(0, s); return Math.floor(s / 60) + ':' + String(Math.floor(s % 60)).padStart(2, '0'); }

  window.FP.Tips = { compute };
})();
