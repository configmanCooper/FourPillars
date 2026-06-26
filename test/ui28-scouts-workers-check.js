const path = require('path');
const { chromium } = require(path.join('C:', 'Users', 'rocma', 'CLI', 'node_modules', 'playwright'));
(async () => {
  const errors = [];
  const browser = await chromium.launch();
  const page = await browser.newPage({ viewport: { width: 1400, height: 900 } });
  page.on('console', (m) => { if (m.type() === 'error') errors.push(m.text()); });
  page.on('pageerror', (e) => errors.push(e.message));
  await page.goto('http://localhost:3100', { waitUntil: 'networkidle' });
  await page.fill('#nameInput', 'Steward'); await page.click('#createBtn');
  await page.waitForSelector('#lobby-room:not(.hidden)', { timeout: 5000 });
  await page.waitForSelector('.slots[data-team="BLUE"] .slot');
  await page.locator('.slots[data-team="BLUE"] .slot').nth(1).locator('button', { hasText: /Claim/i }).click();
  await page.waitForTimeout(300); await page.click('#startBtn');
  await page.waitForSelector('#game:not(.hidden)', { timeout: 5000 }); await page.waitForTimeout(2000);
  if (await page.isVisible('#modal .modal-card')) { await page.click('#modalClose'); await page.waitForTimeout(300); }
  const r = await page.evaluate(() => {
    window.FP.UI.modalWorkers();
    const b = document.getElementById('modalBody');
    return { hasScouts: /Scouts/.test(b.textContent) && /full speed/.test(b.textContent), hasFarmers: /Farmers/.test(b.textContent) };
  });
  console.log(JSON.stringify(r), 'errors:', errors.length ? errors : 'none');
  await browser.close();
  const ok = errors.length === 0 && r.hasScouts && r.hasFarmers;
  console.log(ok ? 'SCOUTS-IN-WORKERS OK' : 'SCOUTS-IN-WORKERS FAIL');
  process.exit(ok ? 0 : 1);
})().catch((e) => { console.error('FATAL', e); process.exit(1); });
