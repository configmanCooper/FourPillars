const { chromium } = require('C:/Users/rocma/CLI/node_modules/playwright');
(async () => {
  const errs = [];
  const b = await chromium.launch();
  const p = await b.newPage({ viewport: { width: 1440, height: 900 } });
  p.on('pageerror', (e) => errs.push(e.message));
  await p.goto('http://localhost:3100'); await p.evaluate(() => localStorage.clear());
  await p.reload({ waitUntil: 'networkidle' });
  await p.fill('#nameInput', 'WQ'); await p.click('#createBtn');
  await p.waitForSelector('#lobby-room:not(.hidden)');
  await p.locator('.slots[data-team="BLUE"] .slot').nth(1).locator('button', { hasText: /Claim/ }).click();
  await p.waitForTimeout(300); await p.click('#startBtn');
  await p.waitForSelector('#game:not(.hidden)'); await p.waitForTimeout(1200);
  if (await p.isVisible('#modal .modal-card')) await p.click('#modalClose');

  // Army composition: armor quality + per-host
  const army = await p.evaluate(() => {
    const C = window.FP.Constants; const t = window.FP.State.teamState();
    t.equipQuality = Object.assign({}, t.equipQuality, { armor: 3.0, spears: 2.0, swords: 1.0, bows: 1, arrows: 1, tools: 1 });
    const eu = {}; for (const k of C.UNITS) eu[k] = 0; eu.spearman = 6; eu.archer = 3;
    t.armies = [{ id: 'g1', name: 'Vanguard', team: t.team, units: eu, hasArmor: true, formation: 'line', stance: 'balanced', area: 'blue_base', moving: null, mission: { type: 'idle' }, isGarrison: true, x: 0, y: 0 }];
    window.FP.UI.modalArmyManage();
    window.FP.UI.armyExpand('g1');
    return document.getElementById('modalBody').textContent;
  });
  const armyOk = /Armour/i.test(army) && /save/i.test(army) && /30%/.test(army);
  console.log('army UI shows armour quality + save %:', armyOk);

  // Gather: per-pool tool quality + boost
  const gather = await p.evaluate(() => {
    const t = window.FP.State.teamState();
    t.equipment = Object.assign({}, t.equipment, { tools: 6 });
    t.equipQuality = Object.assign({}, t.equipQuality, { tools: 1.0 });
    t.pop.farmers = 3; t.buildings.farm = 1;
    t.gather = { desired: { food: 3, wood: 0, mine: 0 }, effective: { food: 3, wood: 0, mine: 0 }, mineIronFocus: 0.4 };
    window.FP.UI.modalGather();
    return document.getElementById('modalBody').textContent;
  });
  const gatherOk = /each tooled worker/i.test(gather) && /×1\.10/.test(gather);
  console.log('gather UI shows per-tool quality + x1.10 boost:', gatherOk, /×1\.10/.test(gather));

  console.log('errors:', errs.length ? errs : 'none');
  await b.close();
  const ok = errs.length === 0 && armyOk && gatherOk;
  console.log(ok ? 'UI18 QUALITY CHECK OK' : 'UI18 QUALITY CHECK FAIL');
  process.exit(ok ? 0 : 1);
})().catch((e) => { console.error('FATAL', e); process.exit(1); });
