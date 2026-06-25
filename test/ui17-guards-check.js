const { chromium } = require('C:/Users/rocma/CLI/node_modules/playwright');
(async () => {
  const errs = [];
  const b = await chromium.launch();
  const p = await b.newPage({ viewport: { width: 1440, height: 900 } });
  p.on('pageerror', (e) => errs.push(e.message));
  await p.goto('http://localhost:3100'); await p.evaluate(() => localStorage.clear());
  await p.reload({ waitUntil: 'networkidle' });
  await p.fill('#nameInput', 'WGuard'); await p.click('#createBtn');
  await p.waitForSelector('#lobby-room:not(.hidden)');
  await p.locator('.slots[data-team="BLUE"] .slot').nth(1).locator('button', { hasText: /Claim/ }).click(); // Steward
  await p.waitForTimeout(300); await p.click('#startBtn');
  await p.waitForSelector('#game:not(.hidden)'); await p.waitForTimeout(1200);
  if (await p.isVisible('#modal .modal-card')) await p.click('#modalClose');

  // modalSites: guard pool + per-post guard control + ask guards
  const sites = await p.evaluate(() => {
    const snap = window.FP.State.snapshot, t = window.FP.State.teamState();
    let aid = null; for (const id in snap.areas) { const a = snap.areas[id]; if (a.terrain === 'forest' && a.site) { aid = id; break; } }
    const a = snap.areas[aid]; a.claimedBy = window.FP.State.myTeam; a.owner = window.FP.State.myTeam; a.revealed[window.FP.State.myTeam] = true; a.site.guards = 1;
    t.guards = 5;
    window.FP.UI.modalSites();
    const body = document.getElementById('modalBody').textContent;
    let sent = null; const orig = window.FP.Net.action; window.FP.Net.action = (act, pl) => { sent = { act, pl }; return orig(act, pl); };
    window.FP.UI.setGuards(aid, 3);
    let askSent = null; window.FP.Net.action = (act, pl) => { askSent = { act, pl }; return orig(act, pl); };
    window.FP.UI.askGuards();
    window.FP.Net.action = orig;
    return { body, sent, askSent };
  });
  const sitesOk = /Guard pool/i.test(sites.body) && /guards/i.test(sites.body) && /unguarded.*destroyed|destroyed/i.test(sites.body);
  const setGuardsOk = sites.sent && sites.sent.act === 'setGuards' && sites.sent.pl.count === 3;
  const askGuardsOk = sites.askSent && sites.askSent.act === 'request' && sites.askSent.pl.type === 'GUARDS';
  console.log('modalSites shows guard pool + destruction warning:', sitesOk);
  console.log('setGuards action fires:', setGuardsOk, JSON.stringify(sites.sent && sites.sent.pl));
  console.log('askGuards request fires:', askGuardsOk);

  // modalCaravans: guard display + destruction wording
  const car = await p.evaluate(() => {
    const t = window.FP.State.teamState();
    t.caravans = [{ id: 'cvg', from: Object.keys(window.FP.State.snapshot.areas)[1], route: [Object.keys(window.FP.State.snapshot.areas)[1], 'blue_base'], legIndex: 0, cargo: { wood: 30 }, resource: 'wood', escort: false, guards: 2 }];
    window.FP.UI.modalCaravans();
    return document.getElementById('modalBody').textContent;
  });
  const carOk = /destroyed/i.test(car) && /2 guards/i.test(car);
  console.log('modalCaravans shows guards + destruction:', carOk);

  // modalMuster: militia upgrade section + upgradeUnits action (override role to COMMANDER for render)
  const mus = await p.evaluate(() => {
    const C = window.FP.Constants;
    const snap = window.FP.State.snapshot, t = window.FP.State.teamState();
    snap.areas.blue_base.buildings.barracks = 1; t.pop.trainers = 2; t.equipment.spears = 5;
    const eu = {}; for (const k of C.UNITS) eu[k] = 0; eu.militia = 4;
    t.armies = [{ id: 'g1', name: 'Garrison', team: t.team, units: eu, hasArmor: false, formation: 'line', stance: 'balanced', area: 'blue_base', moving: null, mission: { type: 'idle' }, isGarrison: true, x: 0, y: 0 }];
    const savedRole = window.FP.State.myRole; window.FP.State.myRole = 'COMMANDER';
    window.FP.UI.modalMuster();
    const body = document.getElementById('modalBody').textContent;
    let sent = null; const orig = window.FP.Net.action; window.FP.Net.action = (act, pl) => { sent = { act, pl }; return orig(act, pl); };
    // click the upgrade-to-spearman button by simulating the call
    window.FP.UI.act('upgradeUnits', { area: 'blue_base', unitType: 'spearman', count: 3 });
    window.FP.Net.action = orig; window.FP.State.myRole = savedRole;
    return { body, sent };
  });
  const musOk = /Upgrade militia/i.test(mus.body) && /4 militia/i.test(mus.body);
  const upOk = mus.sent && mus.sent.act === 'upgradeUnits' && mus.sent.pl.unitType === 'spearman';
  console.log('modalMuster shows militia upgrade:', musOk);
  console.log('upgradeUnits action fires:', upOk, JSON.stringify(mus.sent && mus.sent.pl));

  // Commander-requests modal includes "Lend caravan guards"
  const reqHas = await p.evaluate(() => { window.FP.UI.modalCommanderRequests(); return document.getElementById('modalBody').textContent; });
  const reqOk = /Lend caravan guards/i.test(reqHas);
  console.log('Commander-requests has Lend guards:', reqOk);

  console.log('errors:', errs.length ? errs : 'none');
  await b.close();
  const ok = errs.length === 0 && sitesOk && setGuardsOk && askGuardsOk && carOk && musOk && upOk && reqOk;
  console.log(ok ? 'UI17 GUARDS CHECK OK' : 'UI17 GUARDS CHECK FAIL');
  process.exit(ok ? 0 : 1);
})().catch((e) => { console.error('FATAL', e); process.exit(1); });
