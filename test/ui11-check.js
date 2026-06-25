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
  // Claim the COMMANDER seat (4th slot).
  await p.locator('.slots[data-team="BLUE"] .slot').nth(3).locator('button', { hasText: /Claim/ }).click();
  await p.waitForTimeout(300); await p.click('#startBtn');
  await p.waitForSelector('#game:not(.hidden)'); await p.waitForTimeout(1500);
  if (await p.isVisible('#modal .modal-card')) await p.click('#modalClose');

  // Inject an enemy army and open each modal synchronously (so the next snapshot can't overwrite it first).
  const read = async (openCall) => p.evaluate((call) => {
    const e = window.FP.State.snapshot.teams[window.FP.State.enemyTeam()];
    e.armies = [{ id: 'ex', team: window.FP.State.enemyTeam(), units: { militia: 0, spearman: 0, swordsman: 0, archer: 0, cavalry: 10, catapult: 0 }, hasArmor: false, formation: 'line', stance: 'balanced', area: 'red_base', moving: null, mission: { type: 'idle' }, morale: 'normal' }];
    window.FP.UI[call]();
    return document.getElementById('modalBody').textContent;
  }, openCall);

  const milBody = await read('modalMilitary');
  const enemyIntel = /Enemy forces \(intel\)/i.test(milBody) && /Cavalry/i.test(milBody) && /Spearmen/i.test(milBody);
  console.log('Military Overview shows enemy intel + counter:', enemyIntel);

  const ordBody = await read('modalOrders');
  const ordIntel = /Enemy:/i.test(ordBody) && /cavalry-heavy/i.test(ordBody);
  console.log('Orders modal shows enemy intel line:', ordIntel);

  const musBody = await read('modalMuster');
  const musIntel = /Enemy:/i.test(musBody);
  console.log('Train modal shows enemy intel line:', musIntel);
  if (await p.isVisible('#modalClose')) await p.click('#modalClose');

  console.log('errors:', errs.length ? errs : 'none');
  await b.close();
  const ok = errs.length === 0 && enemyIntel && ordIntel && musIntel;
  console.log(ok ? 'UI11 CHECK OK' : 'UI11 CHECK FAIL');
  process.exit(ok ? 0 : 1);
})().catch((e) => { console.error('FATAL', e); process.exit(1); });
