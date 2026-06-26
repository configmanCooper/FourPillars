const path = require('path');
const { chromium } = require(path.join('C:', 'Users', 'rocma', 'CLI', 'node_modules', 'playwright'));
(async () => {
  const errors = [];
  const browser = await chromium.launch();
  const page = await browser.newPage({ viewport: { width: 1400, height: 820 } });
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
    // Inject a fake owned outpost into the client snapshot to exercise the per-outpost UI.
    const s = window.FP.State.snapshot; const team = window.FP.State.myTeam;
    let aid = null; for (const id in s.areas) { const a = s.areas[id]; if (a.terrain !== 'base' && a.resource) { a.claimedBy = team; a.owner = team; a.site = { level: 1, cargo: 25, workMode: 'standard', caravanMode: 'standard', workModeUntil: 0, caravanModeUntil: 0, guards: 0 }; aid = id; break; } }
    const out = {};
    window.FP.UI.modalSites(); let b = document.getElementById('modalBody');
    out.sitesWork = /Work mode/.test(b.textContent); out.sitesCaravan = /Caravan mode/.test(b.textContent); out.sitesSlot = /\+1 slot/.test(b.textContent);
    window.FP.UI.modalCaravans(); b = document.getElementById('modalBody');
    out.carSendNow = /Send now/.test(b.textContent); out.carOutposts = /Your outposts/.test(b.textContent);
    return out;
  });
  console.log(JSON.stringify(r));
  console.log('errors:', errors.length ? errors : 'none');
  await browser.close();
  const ok = errors.length === 0 && r.sitesWork && r.sitesCaravan && r.sitesSlot && r.carSendNow && r.carOutposts;
  console.log(ok ? 'MODES+CARAVANS UI OK' : 'MODES+CARAVANS UI FAIL');
  process.exit(ok ? 0 : 1);
})().catch((e) => { console.error('FATAL', e); process.exit(1); });
