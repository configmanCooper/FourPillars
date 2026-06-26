const path = require('path');
const { chromium } = require(path.join('C:', 'Users', 'rocma', 'CLI', 'node_modules', 'playwright'));
(async () => {
  const errors = [];
  const browser = await chromium.launch();
  const page = await browser.newPage({ viewport: { width: 1400, height: 860 } });
  page.on('console', (m) => { if (m.type() === 'error') errors.push(m.text()); });
  page.on('pageerror', (e) => errors.push(e.message));
  await page.goto('http://localhost:3100', { waitUntil: 'networkidle' });
  await page.fill('#nameInput', 'Steward'); await page.click('#createBtn');
  await page.waitForSelector('#lobby-room:not(.hidden)', { timeout: 5000 });
  await page.waitForSelector('.slots[data-team="BLUE"] .slot');
  await page.locator('.slots[data-team="BLUE"] .slot').nth(1).locator('button', { hasText: /Claim/i }).click();
  await page.waitForTimeout(300); await page.click('#startBtn');
  await page.waitForSelector('#game:not(.hidden)', { timeout: 5000 }); await page.waitForTimeout(2500);
  if (await page.isVisible('#modal .modal-card')) { await page.click('#modalClose'); await page.waitForTimeout(300); }
  const r = await page.evaluate(() => {
    const out = {};
    window.FP.UI.modalStewardship();
    let b = document.getElementById('modalBody');
    out.actionsTab = /Fertility Decree/.test(b.textContent) && /Overseers/.test(b.textContent) && /Enact/.test(b.textContent);
    window.FP.UI.stTab('policy'); b = document.getElementById('modalBody');
    out.policyTab = /Mining Decree/.test(b.textContent) && /Caravan Wardens/.test(b.textContent);
    window.FP.UI.stTab('trade'); b = document.getElementById('modalBody');
    out.tradeNeedsMarket = /needs a/i.test(b.textContent) && /Ask Lord to build/.test(b.textContent);
    window.FP.UI.stTab('supervise'); b = document.getElementById('modalBody');
    out.superviseGrid = !!document.getElementById('superviseGrid');
    out.gridCells = document.querySelectorAll('#superviseGrid button').length;
    // simulate a supervise result render (miss)
    window.FP.UI.onSuperviseResult({ hit: false, revealed: 5, resource: 'food' });
    out.afterMiss = /Missed/.test(document.getElementById('modalBody').textContent);
    return out;
  });
  // Real supervise click round-trip (server result -> onSuperviseResult)
  await page.evaluate(() => { window.FP.UI.stTab('supervise'); });
  await page.waitForTimeout(200);
  await page.click('#superviseGrid button:nth-child(1)');
  await page.waitForTimeout(400);
  const afterClick = await page.evaluate(() => /Missed|Caught/.test(document.getElementById('modalBody').textContent));
  console.log(JSON.stringify(r), 'realClick:', afterClick);
  console.log('errors:', errors.length ? errors : 'none');
  await browser.close();
  const ok = errors.length === 0 && r.actionsTab && r.policyTab && r.tradeNeedsMarket && r.superviseGrid && r.gridCells === 16 && r.afterMiss && afterClick;
  console.log(ok ? 'STEWARDSHIP UI OK' : 'STEWARDSHIP UI FAIL');
  process.exit(ok ? 0 : 1);
})().catch((e) => { console.error('FATAL', e); process.exit(1); });
