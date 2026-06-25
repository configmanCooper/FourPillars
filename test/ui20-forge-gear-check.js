const { chromium } = require('C:/Users/rocma/CLI/node_modules/playwright');
(async () => {
  const errs = [];
  const b = await chromium.launch();
  const p = await b.newPage({ viewport: { width: 1440, height: 900 } });
  p.on('pageerror', (e) => errs.push(e.message));
  await p.goto('http://localhost:3100'); await p.evaluate(() => localStorage.clear());
  await p.reload({ waitUntil: 'networkidle' });
  await p.fill('#nameInput', 'WF2'); await p.click('#createBtn');
  await p.waitForSelector('#lobby-room:not(.hidden)');
  await p.locator('.slots[data-team="BLUE"] .slot').nth(3).locator('button', { hasText: /Claim/ }).click(); // Commander
  await p.waitForTimeout(300); await p.click('#startBtn');
  await p.waitForSelector('#game:not(.hidden)'); await p.waitForTimeout(1200);
  if (await p.isVisible('#modal .modal-card')) await p.click('#modalClose');

  // Army Management: host strength (atk/def), per-soldier roster, re-equip button + action
  const army = await p.evaluate(() => {
    const C = window.FP.Constants; const t = window.FP.State.teamState();
    const eu = {}; for (const k of C.UNITS) eu[k] = 0; eu.spearman = 3;
    const gear = { spearman: [{ w: 3.0, a: 2.0 }, { w: 0.3, a: 0 }, { w: 1.0, a: 0 }] };
    for (const k of C.UNITS) if (!gear[k]) gear[k] = [];
    t.armies = [{ id: 'g1', name: 'Vanguard', team: t.team, units: eu, gear, power: { atk: 42, def: 31 }, hasArmor: true, formation: 'line', stance: 'balanced', area: 'blue_base', moving: null, mission: { type: 'idle' }, isGarrison: true, x: 0, y: 0 }];
    t.gearInv = Object.assign({}, t.gearInv, { spears: [3.0, 2.0] }); t.equipment = Object.assign({}, t.equipment, { spears: 2 });
    window.FP.UI.modalArmyManage(); window.FP.UI.armyExpand('g1');
    const body = document.getElementById('modalBody').textContent;
    let sent = null; const orig = window.FP.Net.action; window.FP.Net.action = (a, pl) => { sent = { a, pl }; return orig(a, pl); };
    window.FP.UI.reequip('g1');
    window.FP.Net.action = orig;
    return { body, sent };
  });
  const strengthOk = /⚔️42/.test(army.body) && /🛡31/.test(army.body);
  const rosterOk = /Each soldier/i.test(army.body) && /Re-equip from armoury/i.test(army.body);
  const reOk = army.sent && army.sent.a === 'reequip' && army.sent.pl.groupId === 'g1';
  console.log('army shows host strength ⚔️/🛡:', strengthOk);
  console.log('army shows per-soldier roster + re-equip button:', rosterOk);
  console.log('reequip action fires:', reOk);

  // Military Overview: per-host strength & gear section (override to LORD)
  const mil = await p.evaluate(() => {
    const savedRole = window.FP.State.myRole; window.FP.State.myRole = 'LORD';
    window.FP.UI.modalMilitary();
    const body = document.getElementById('modalBody').textContent; window.FP.State.myRole = savedRole;
    return body;
  });
  const milOk = /Hosts.*strength/i.test(mil) && /⚔️42/.test(mil);
  console.log('military overview shows host strength & gear:', milOk);

  // Forge: doubled strikes (tools time 8 -> 8 strikes)
  const forge = await p.evaluate(() => { window.FP.UI.modalForge(); return document.getElementById('modalBody').textContent; });
  const forgeOk = /8 strikes/.test(forge);
  console.log('forge shows doubled strikes (8 for tools):', forgeOk);

  console.log('errors:', errs.length ? errs : 'none');
  await b.close();
  const ok = errs.length === 0 && strengthOk && rosterOk && reOk && milOk && forgeOk;
  console.log(ok ? 'UI20 FORGE/GEAR CHECK OK' : 'UI20 FORGE/GEAR CHECK FAIL');
  process.exit(ok ? 0 : 1);
})().catch((e) => { console.error('FATAL', e); process.exit(1); });
