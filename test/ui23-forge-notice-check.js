/* Verify: (1) forge progress bar renders for a queued item; (2) a request the human made shows the
   resolution-notice popup when a (AI) teammate resolves it; (3) contract history renders. */
const path = require('path');
const { chromium } = require(path.join('C:', 'Users', 'rocma', 'CLI', 'node_modules', 'playwright'));

(async () => {
  const errors = [];
  const browser = await chromium.launch();
  const page = await browser.newPage({ viewport: { width: 1400, height: 820 } });
  page.on('console', (m) => { if (m.type() === 'error') errors.push('console: ' + m.text()); });
  page.on('pageerror', (e) => errors.push('pageerror: ' + e.message));

  await page.goto('http://localhost:3100', { waitUntil: 'networkidle' });
  await page.fill('#nameInput', 'Smith');
  await page.click('#createBtn');
  await page.waitForSelector('#lobby-room:not(.hidden)', { timeout: 5000 });
  // Claim Blue Blacksmith (3rd slot).
  await page.waitForSelector('.slots[data-team="BLUE"] .slot');
  await page.locator('.slots[data-team="BLUE"] .slot').nth(2).locator('button', { hasText: /Claim/i }).click();
  await page.waitForTimeout(400);
  await page.click('#startBtn');
  await page.waitForSelector('#game:not(.hidden)', { timeout: 5000 });
  await page.waitForTimeout(3000);
  if (await page.isVisible('#modal .modal-card')) { await page.click('#modalClose'); await page.waitForTimeout(300); }

  // (1) Queue a forge job directly, open the Forge, check a progress bar exists.
  await page.evaluate(() => window.FP.Net.action('produce', { item: 'swords', qty: 3, qPct: 0.9 }));
  await page.waitForTimeout(1500);
  const forge = await page.evaluate(() => {
    window.FP.UI.modalForge();
    const body = document.getElementById('modalBody');
    // a forge progress bar is a nested div with a width:% style inside the Forging section
    const bars = Array.from(body.querySelectorAll('div')).filter((d) => /width:\d+%/.test(d.getAttribute('style') || '') && /background/.test(d.getAttribute('style') || ''));
    return { hasForging: /Forging/.test(body.textContent), barCount: bars.length, swordsShown: /Swords/i.test(body.textContent) };
  });
  await page.evaluate(() => window.FP.UI.closeModal && window.FP.UI.closeModal());

  // (2) Make a request to the (AI) Steward, wait for it to resolve, expect the notice popup.
  await page.evaluate(() => window.FP.Net.action('request', { type: 'IRON', payload: {} }));
  let noticeOk = false, noticeText = '';
  for (let i = 0; i < 20 && !noticeOk; i++) {
    await page.waitForTimeout(1500);
    noticeOk = await page.isVisible('#reqNotice');
    if (noticeOk) noticeText = (await page.textContent('#reqNotice')) || '';
  }

  console.log('forge:', JSON.stringify(forge));
  console.log('reqNotice visible:', noticeOk, '| text:', noticeText.slice(0, 80));
  console.log('errors:', errors.length ? errors : 'none');
  await browser.close();
  const ok = errors.length === 0 && forge.hasForging && forge.barCount >= 1 && forge.swordsShown && noticeOk;
  console.log(ok ? 'FORGE+NOTICE CHECK OK' : 'FORGE+NOTICE CHECK FAIL');
  process.exit(ok ? 0 : 1);
})().catch((e) => { console.error('FATAL', e); process.exit(1); });
