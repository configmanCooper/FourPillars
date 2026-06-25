const { chromium } = require('C:/Users/rocma/CLI/node_modules/playwright');
(async () => {
  const errs = [];
  const b = await chromium.launch();
  const p = await b.newPage({ viewport: { width: 1440, height: 900 } });
  p.on('pageerror', (e) => errs.push(e.message));
  await p.goto('http://localhost:3100'); await p.evaluate(() => localStorage.clear());
  await p.reload({ waitUntil: 'networkidle' });
  await p.fill('#nameInput', 'ResLord'); await p.click('#createBtn');
  await p.waitForSelector('#lobby-room:not(.hidden)');
  await p.locator('.slots[data-team="BLUE"] .slot').first().locator('button', { hasText: /Claim/ }).click(); // Lord
  await p.waitForTimeout(300); await p.click('#startBtn');
  await p.waitForSelector('#game:not(.hidden)'); await p.waitForTimeout(4000); // let AI spend some resources
  if (await p.isVisible('#modal .modal-card')) await p.click('#modalClose');

  // Lord quick bar should show "Hold Resources" not "Ask for Resource"
  const quick = await p.textContent('#quickReq');
  const hasHoldBtn = /Hold Resources/i.test(quick) && !/Ask for Resource/i.test(quick);

  // Click the WOOD resource chip -> per-resource modal
  await p.evaluate(() => window.FP.UI.chipClick('wood'));
  await p.waitForTimeout(400);
  const body = await p.textContent('#modalBody');
  const hasContributing = /Contributing/i.test(body);
  const hasUsage = /Recent usage/i.test(body);
  const hasRation = /Who may spend/i.test(body);
  // Reserve wood (only me) from this modal
  await p.locator('#modalBody .btn', { hasText: /Reserve \(only me\)/i }).first().click();
  await p.waitForTimeout(700);
  const afterHold = await p.textContent('#modalBody');
  const nowHeld = /reserved for/i.test(afterHold);

  await p.screenshot({ path: 'test/res.png' });
  console.log('quick bar Hold Resources (no Ask for Resource):', hasHoldBtn);
  console.log('modal has Contributing:', hasContributing, '| Recent usage:', hasUsage, '| Who may spend:', hasRation);
  console.log('wood reserved after click:', nowHeld);
  console.log('errors:', errs.length ? errs : 'none');
  await b.close();
  const ok = errs.length === 0 && hasHoldBtn && hasContributing && hasUsage && hasRation && nowHeld;
  console.log(ok ? 'RES CHECK OK' : 'RES CHECK FAIL');
  process.exit(ok ? 0 : 1);
})().catch((e) => { console.error('FATAL', e); process.exit(1); });
