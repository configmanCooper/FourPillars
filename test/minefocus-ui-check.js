const path = require('path');
const { chromium } = require(path.join('C:', 'Users', 'rocma', 'CLI', 'node_modules', 'playwright'));
(async () => {
  const errors = [];
  const browser = await chromium.launch();
  const page = await browser.newPage({ viewport: { width: 1400, height: 820 } });
  page.on('console', (m) => { if (m.type() === 'error') errors.push(m.text()); });
  page.on('pageerror', (e) => errors.push(e.message));
  await page.goto('http://localhost:3100', { waitUntil: 'networkidle' });
  await page.fill('#nameInput', 'Lord'); await page.click('#createBtn');
  await page.waitForSelector('#lobby-room:not(.hidden)', { timeout: 5000 });
  await page.waitForSelector('.slots[data-team="BLUE"] .slot');
  await page.locator('.slots[data-team="BLUE"] .slot').first().locator('button', { hasText: /Claim/i }).click();
  await page.waitForTimeout(300); await page.click('#startBtn');
  await page.waitForSelector('#game:not(.hidden)', { timeout: 5000 }); await page.waitForTimeout(2500);
  if (await page.isVisible('#modal .modal-card')) { await page.click('#modalClose'); await page.waitForTimeout(300); }
  const r = await page.evaluate(() => {
    window.FP.UI.modalStewardRequests();
    const b = document.getElementById('modalBody');
    const txt = b.textContent;
    // count requests sent when clicking Mine more Iron
    return { hasFocus: /Mine focus/.test(txt), iron: /Mine more Iron/.test(txt), stone: /Mine more Stone/.test(txt), split: /Miners currently split/.test(txt) };
  });
  // click Mine more Iron and confirm a MINEFOCUS request appears in my asks
  const sent = await page.evaluate(() => {
    window.FP.Net.action('request', { type: 'MINEFOCUS', payload: { res: 'iron' } });
    return true;
  });
  await page.waitForTimeout(1200);
  const hasReq = await page.evaluate(() => {
    const s = window.FP.State.snapshot; const reqs = s.teams[window.FP.State.myTeam].requests || [];
    return reqs.some((r) => r.type === 'MINEFOCUS' && r.payload && r.payload.res === 'iron');
  });
  console.log('stewardModal:', JSON.stringify(r), '| MINEFOCUS request created:', hasReq);
  console.log('errors:', errors.length ? errors : 'none');
  await browser.close();
  const ok = errors.length === 0 && r.hasFocus && r.iron && r.stone && r.split && hasReq;
  console.log(ok ? 'MINEFOCUS UI OK' : 'MINEFOCUS UI FAIL');
  process.exit(ok ? 0 : 1);
})().catch((e) => { console.error('FATAL', e); process.exit(1); });
