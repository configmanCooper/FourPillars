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

  // Commander quick bar shows the 3 "Ask the X" buttons.
  const quick = await p.textContent('#quickReq');
  const bar = /Ask the Lord/.test(quick) && /Ask the Steward/.test(quick) && /Ask the Blacksmith/.test(quick) && !/Ask the Commander/.test(quick);
  console.log('Commander quick bar has Ask Lord/Steward/Blacksmith (not self):', bar);

  // Ask the Blacksmith → modal with specific weapons.
  await p.locator('#quickReq button', { hasText: 'Ask the Blacksmith' }).click();
  await p.waitForTimeout(300);
  const smBody = await p.textContent('#modalBody');
  const smithOk = /Forge Spears/i.test(smBody) && /Forge Swords/i.test(smBody) && /Forge Bows/i.test(smBody) && /Forge Armour/i.test(smBody) && /Forge Arrows/i.test(smBody);
  console.log('Ask Blacksmith modal lists specific weapons:', smithOk);
  // Send a specific weapon request and confirm a comms request reaches the server.
  await p.locator('#modalBody .opt', { hasText: /Forge Swords/i }).locator('button', { hasText: /Request/ }).click();
  await p.waitForTimeout(700);
  const reqReached = await p.evaluate(() => {
    const t = window.FP.State.teamState();
    return (t.requests || []).some((r) => r.type === 'EQUIPMENT' && r.payload && r.payload.item === 'swords') ||
           (t.comms || []).some((m) => /swords|Swords/.test(m.text));
  });
  console.log('specific weapon request reached server:', reqReached);
  if (await p.isVisible('#modalClose')) await p.click('#modalClose');

  // Ask the Lord modal opens with manpower options.
  await p.locator('#quickReq button', { hasText: 'Ask the Lord' }).click();
  await p.waitForTimeout(300);
  const lordBody = await p.textContent('#modalBody');
  const lordOk = /Levy recruits/i.test(lordBody) && /More Mining/i.test(lordBody) && /Manpower/i.test(lordBody) && /Construction/i.test(lordBody) && /Build Barracks/i.test(lordBody) && /Build Storehouse/i.test(lordBody);
  console.log('Ask the Lord modal has manpower + construction options:', lordOk);
  if (await p.isVisible('#modalClose')) await p.click('#modalClose');

  // Ask the Steward modal opens.
  await p.locator('#quickReq button', { hasText: 'Ask the Steward' }).click();
  await p.waitForTimeout(300);
  const stBody = await p.textContent('#modalBody');
  const stOk = /Secure/i.test(stBody) && /Claim a new site/i.test(stBody);
  console.log('Ask the Steward modal opens:', stOk);
  if (await p.isVisible('#modalClose')) await p.click('#modalClose');

  console.log('errors:', errs.length ? errs : 'none');
  await b.close();
  const ok = errs.length === 0 && bar && smithOk && reqReached && lordOk && stOk;
  console.log(ok ? 'UI12 CHECK OK' : 'UI12 CHECK FAIL');
  process.exit(ok ? 0 : 1);
})().catch((e) => { console.error('FATAL', e); process.exit(1); });
