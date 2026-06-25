const { chromium } = require('C:/Users/rocma/CLI/node_modules/playwright');
(async () => {
  const errs = [];
  const b = await chromium.launch();
  const p = await b.newPage({ viewport: { width: 1440, height: 900 } });
  p.on('pageerror', (e) => errs.push(e.message));
  await p.goto('http://localhost:3100'); await p.evaluate(() => localStorage.clear());
  await p.reload({ waitUntil: 'networkidle' });
  await p.fill('#nameInput', 'WLord'); await p.click('#createBtn');
  await p.waitForSelector('#lobby-room:not(.hidden)');
  await p.locator('.slots[data-team="BLUE"] .slot').first().locator('button', { hasText: /Claim/ }).click();
  await p.waitForTimeout(300); await p.click('#startBtn');
  await p.waitForSelector('#game:not(.hidden)'); await p.waitForTimeout(1200);
  if (await p.isVisible('#modal .modal-card')) await p.click('#modalClose');

  await p.locator('#actionButtons .btn', { hasText: /Workers/i }).click();
  await p.waitForTimeout(400);
  // Recruits before (from header bold)
  const recBefore = parseInt((await p.textContent('#modalBody')).match(/recruits\s*(\d+)/i)[1], 10);

  // Click Farmers minus.
  await p.locator('#modalBody .opt', { hasText: /^Farmers/i }).first().locator('button', { hasText: '−' }).click();
  await p.waitForTimeout(900);
  const bodyAfterMinus = await p.textContent('#modalBody');
  const hasPreparing = /Idle \(preparing\)/i.test(bodyAfterMinus);

  // Levy +3
  await p.locator('#modalBody .opt', { hasText: /Levy from idle/i }).locator('button', { hasText: /\+3/ }).click();
  await p.waitForTimeout(900);
  const recAfter = parseInt((await p.textContent('#modalBody')).match(/recruits\s*(\d+)/i)[1], 10);

  console.log('preparing row appeared after minus:', hasPreparing);
  console.log('recruits before/after levy:', recBefore, '->', recAfter, '| increased:', recAfter > recBefore);
  console.log('errors:', errs.length ? errs : 'none');
  await b.close();
  const ok = errs.length === 0 && hasPreparing && recAfter > recBefore;
  console.log(ok ? 'UI6 CHECK OK' : 'UI6 CHECK FAIL');
  process.exit(ok ? 0 : 1);
})().catch((e) => { console.error('FATAL', e); process.exit(1); });
