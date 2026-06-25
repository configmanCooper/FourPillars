const { chromium } = require('C:/Users/rocma/CLI/node_modules/playwright');
(async () => {
  const errs = [];
  const b = await chromium.launch();
  const p = await b.newPage({ viewport: { width: 1440, height: 900 } });
  p.on('pageerror', (e) => errs.push(e.message));
  await p.goto('http://localhost:3100'); await p.evaluate(() => localStorage.clear());
  await p.reload({ waitUntil: 'networkidle' });
  await p.fill('#nameInput', 'WCmd'); await p.click('#createBtn');
  await p.waitForSelector('#lobby-room:not(.hidden)');
  await p.locator('.slots[data-team="BLUE"] .slot').nth(3).locator('button', { hasText: /Claim/ }).click(); // Commander
  await p.waitForTimeout(300); await p.click('#startBtn');
  await p.waitForSelector('#game:not(.hidden)'); await p.waitForTimeout(1200);
  if (await p.isVisible('#modal .modal-card')) await p.click('#modalClose');

  // Inject two co-located hosts with units, then open Army Management.
  const body = await p.evaluate(() => {
    const t = window.FP.State.teamState();
    const mk = (id, name, u, garr) => ({ id, name, team: t.team, units: Object.assign({ militia: 0, spearman: 0, swordsman: 0, archer: 0, cavalry: 0, catapult: 0 }, u), hasArmor: false, formation: 'line', stance: 'balanced', area: t.team === 'BLUE' ? 'blue_base' : 'red_base', moving: null, mission: { type: 'idle' }, morale: 'normal', isGarrison: !!garr, x: 140, y: 500 });
    t.armies = [mk('g1', 'Home Garrison', { spearman: 8, archer: 4 }, true), mk('h2', 'Vanguard', { swordsman: 6 }, false)];
    t.equipQuality = { spears: 2.0, swords: 3.0, bows: 1, armor: 1, siegeParts: 1, tools: 1, arrows: 1 };
    window.FP.UI.modalArmyManage();
    return document.getElementById('modalBody').textContent;
  });
  const hasSections = /Total composition/i.test(body) && /Hosts \(2\)/i.test(body) && /Reorganise forces/i.test(body) && /Home Garrison/i.test(body) && /Vanguard/i.test(body);
  console.log('army modal sections + hosts:', hasSections);

  // Expand the garrison card and verify details (formation/stance/orders) show.
  await p.evaluate(() => window.FP.UI.armyExpand('g1'));
  await p.waitForTimeout(150);
  const exp = await p.textContent('#modalBody');
  const detailOk = /Formation/i.test(exp) && /Stance/i.test(exp) && /Shield Wall|Battle Line/i.test(exp);
  console.log('expanded host shows formation/stance/orders:', detailOk);

  // Reorganize: set source=garrison, dest=Vanguard, move 3 spearmen.
  const transferred = await p.evaluate(() => {
    window.FP.UI.armySrc('g1'); window.FP.UI.armyDst('h2');
    window.FP.UI.armyAmt('spearman', 3);
    // capture the action sent
    let sent = null; const orig = window.FP.Net.action; window.FP.Net.action = (a, pl) => { sent = { a, pl }; return orig(a, pl); };
    window.FP.UI.armyTransfer();
    window.FP.Net.action = orig;
    return sent;
  });
  const transferOk = transferred && transferred.a === 'transferUnits' && transferred.pl.fromId === 'g1' && transferred.pl.toId === 'h2' && transferred.pl.units.spearman === 3;
  console.log('transfer action sent correctly:', transferOk, JSON.stringify(transferred && transferred.pl));

  // Click-to-move: select a host, then moveHostTo an enemy base → siege.
  const moveCmd = await p.evaluate(() => {
    let sent = null; const orig = window.FP.Net.action; window.FP.Net.action = (a, pl) => { sent = { a, pl }; return orig(a, pl); };
    window.FP.UI.moveHostTo('h2', window.FP.State.myTeam === 'BLUE' ? 'red_base' : 'blue_base');
    window.FP.Net.action = orig;
    return sent;
  });
  const moveOk = moveCmd && moveCmd.a === 'command' && moveCmd.pl.mission === 'siege';
  console.log('right-click enemy base → siege:', moveOk, JSON.stringify(moveCmd && moveCmd.pl));

  // Render.hostAt exists and is wired.
  const hostAtExists = await p.evaluate(() => typeof window.FP.Render.hostAt === 'function');
  console.log('Render.hostAt wired:', hostAtExists);

  console.log('errors:', errs.length ? errs : 'none');
  await b.close();
  const ok = errs.length === 0 && hasSections && detailOk && transferOk && moveOk && hostAtExists;
  console.log(ok ? 'UI15 CHECK OK' : 'UI15 CHECK FAIL');
  process.exit(ok ? 0 : 1);
})().catch((e) => { console.error('FATAL', e); process.exit(1); });
