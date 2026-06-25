const { chromium } = require('C:/Users/rocma/CLI/node_modules/playwright');
(async () => {
  const errs = [];
  const b = await chromium.launch();
  const p = await b.newPage({ viewport: { width: 1440, height: 900 } });
  p.on('pageerror', (e) => errs.push(e.message));
  await p.goto('http://localhost:3100'); await p.evaluate(() => localStorage.clear());
  await p.reload({ waitUntil: 'networkidle' });
  await p.fill('#nameInput', 'WGear'); await p.click('#createBtn');
  await p.waitForSelector('#lobby-room:not(.hidden)');
  await p.locator('.slots[data-team="BLUE"] .slot').nth(1).locator('button', { hasText: /Claim/ }).click(); // Steward
  await p.waitForTimeout(300); await p.click('#startBtn');
  await p.waitForSelector('#game:not(.hidden)'); await p.waitForTimeout(1200);
  if (await p.isVisible('#modal .modal-card')) await p.click('#modalClose');

  // Army composition: per-soldier weapon + armour quality mix from host.gear
  const army = await p.evaluate(() => {
    const C = window.FP.Constants; const t = window.FP.State.teamState();
    const eu = {}; for (const k of C.UNITS) eu[k] = 0; eu.spearman = 4; eu.archer = 2;
    const gear = { spearman: [{ w: 3.0, a: 3.0 }, { w: 2.0, a: 0 }, { w: 1.0, a: 0 }, { w: 0.5, a: 1.0 }], archer: [{ w: 1.25, a: 0 }, { w: 2.0, a: 0 }] };
    for (const k of C.UNITS) if (!gear[k]) gear[k] = [];
    t.armies = [{ id: 'g1', name: 'Vanguard', team: t.team, units: eu, gear, hasArmor: true, formation: 'line', stance: 'balanced', area: 'blue_base', moving: null, mission: { type: 'idle' }, isGarrison: true, x: 0, y: 0 }];
    const savedRole = window.FP.State.myRole; window.FP.State.myRole = 'COMMANDER';
    window.FP.UI.modalArmyManage(); window.FP.UI.armyExpand('g1');
    const body = document.getElementById('modalBody').textContent; window.FP.State.myRole = savedRole;
    return body;
  });
  // expect mixed weapon glyphs (🌟 from 3.0, ✨ from 2.0) and an armour line with a count like 2/6
  const armyOk = /Spearman/i.test(army) && /🌟/.test(army) && /Armour/i.test(army) && /2\/6/.test(army);
  console.log('army UI shows per-soldier weapon + armour mix:', armyOk);

  // Gather: per-worker individual tool qualities from gearInv.tools
  const gather = await p.evaluate(() => {
    const t = window.FP.State.teamState();
    t.gearInv = Object.assign({}, t.gearInv, { tools: [3.0, 1.0, 0.5] });
    t.equipment = Object.assign({}, t.equipment, { tools: 3 });
    t.pop.farmers = 3; t.buildings.farm = 1;
    t.gather = { desired: { food: 3, wood: 0, mine: 0 }, effective: { food: 3, wood: 0, mine: 0 }, mineIronFocus: 0.4 };
    window.FP.UI.modalGather();
    return document.getElementById('modalBody').textContent;
  });
  const gatherOk = /each worker's tool/i.test(gather) && /🌟/.test(gather);
  console.log('gather UI shows individual tool qualities:', gatherOk);

  // Forge: individual armoury inventory with quality mix
  const forge = await p.evaluate(() => {
    const t = window.FP.State.teamState();
    t.gearInv = Object.assign({}, t.gearInv, { spears: [3.0, 1.0, 1.0], armor: [2.0] });
    t.equipment = Object.assign({}, t.equipment, { spears: 3, armor: 1 });
    window.FP.UI.modalForge();
    return document.getElementById('modalBody').textContent;
  });
  const forgeOk = /Armoury/i.test(forge) && /individual/i.test(forge);
  console.log('forge UI shows individual armoury inventory:', forgeOk);

  console.log('errors:', errs.length ? errs : 'none');
  await b.close();
  const ok = errs.length === 0 && armyOk && gatherOk && forgeOk;
  console.log(ok ? 'UI19 INDIVIDUAL GEAR CHECK OK' : 'UI19 INDIVIDUAL GEAR CHECK FAIL');
  process.exit(ok ? 0 : 1);
})().catch((e) => { console.error('FATAL', e); process.exit(1); });
