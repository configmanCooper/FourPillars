/* Browser check: type "fourpillars" -> debug panel appears; download triggers a JSON replay. */
const path = require('path');
const { chromium } = require(path.join('C:', 'Users', 'rocma', 'CLI', 'node_modules', 'playwright'));

(async () => {
  const errors = [];
  const browser = await chromium.launch();
  const page = await browser.newPage({ viewport: { width: 1400, height: 820 } });
  page.on('pageerror', (e) => errors.push('pageerror: ' + e.message));
  await page.goto('http://localhost:3100', { waitUntil: 'networkidle' });
  await page.fill('#nameInput', 'Debugger');
  await page.click('#createBtn');
  await page.waitForSelector('#lobby-room:not(.hidden)', { timeout: 5000 });
  await page.locator('.slots[data-team="BLUE"] .slot').first().locator('button', { hasText: /Claim/i }).click();
  await page.waitForTimeout(400);
  await page.click('#startBtn');
  await page.waitForSelector('#game:not(.hidden)', { timeout: 5000 });
  await page.waitForTimeout(2500);
  if (await page.isVisible('#modal .modal-card')) { await page.click('#modalClose'); }
  await page.waitForTimeout(300);
  // Type the secret word.
  for (const ch of 'fourpillars') { await page.keyboard.press(ch); await page.waitForTimeout(30); }
  const panel = await page.isVisible('#fpDebug');
  // Trigger the download.
  let dl = null;
  if (panel) { const [d] = await Promise.all([page.waitForEvent('download', { timeout: 5000 }).catch(() => null), page.click('#fpDlReplay')]); dl = d; }
  const fname = dl ? dl.suggestedFilename() : null;
  console.log('panel:', panel, 'download:', fname, 'errors:', errors.length ? errors : 'none');
  await browser.close();
  const ok = panel && fname && /fourpillars_replay_.*\.json/.test(fname) && errors.length === 0;
  console.log(ok ? 'DEBUG REPLAY UI OK' : 'DEBUG REPLAY UI FAIL');
  process.exit(ok ? 0 : 1);
})().catch((e) => { console.error('FATAL', e); process.exit(1); });
