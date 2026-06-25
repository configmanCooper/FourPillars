/* Browser check: load client, play through lobby->game, capture console errors + screenshot. */
const path = require('path');
const { chromium } = require(path.join('C:', 'Users', 'rocma', 'CLI', 'node_modules', 'playwright'));

(async () => {
  const errors = [];
  const browser = await chromium.launch();
  const page = await browser.newPage({ viewport: { width: 1400, height: 820 } });
  page.on('console', (m) => { if (m.type() === 'error') errors.push('console: ' + m.text()); });
  page.on('pageerror', (e) => errors.push('pageerror: ' + e.message));

  await page.goto('http://localhost:3100', { waitUntil: 'networkidle' });
  await page.fill('#nameInput', 'Browserer');
  await page.click('#createBtn');
  await page.waitForSelector('#lobby-room:not(.hidden)', { timeout: 5000 });
  // Claim the Blue Lord seat (target the Claim button specifically; the host also sees AI-difficulty buttons).
  await page.waitForSelector('.slots[data-team="BLUE"] .slot');
  const claimBtn = page.locator('.slots[data-team="BLUE"] .slot').first().locator('button', { hasText: /Claim/i });
  await claimBtn.click();
  await page.waitForTimeout(400);
  await page.click('#startBtn');
  await page.waitForSelector('#game:not(.hidden)', { timeout: 5000 });
  await page.waitForTimeout(3500);

  // Dismiss the first-run "How to Play" help modal if present (it overlays the action bar).
  if (await page.isVisible('#modal .modal-card')) { await page.click('#modalClose'); await page.waitForTimeout(300); }

  // Interact: open the Build modal.
  await page.waitForSelector('#actionButtons .btn', { timeout: 5000 });
  await page.click('#actionButtons .btn'); // first action button (Build for Lord)
  await page.waitForTimeout(500);
  const modalVisible = await page.isVisible('#modal .modal-card');
  await page.screenshot({ path: path.join(__dirname, 'browser-shot.png') });
  // Close modal, click an area on the map.
  if (modalVisible) await page.click('#modalClose');
  await page.mouse.click(700, 430);
  await page.waitForTimeout(300);
  await page.screenshot({ path: path.join(__dirname, 'browser-shot2.png') });

  const phase = await page.textContent('#phaseLabel');
  const timer = await page.textContent('#timer');
  const resChips = await page.locator('#resourceBar .res-chip').count();
  const teamCards = await page.locator('#teamCards .tc').count();

  console.log('phase:', phase, 'timer:', timer, 'resourceChips:', resChips, 'teamCards:', teamCards, 'modalOpened:', modalVisible);
  console.log('errors:', errors.length ? errors : 'none');
  await browser.close();
  const ok = errors.length === 0 && resChips >= 6 && teamCards >= 8 && modalVisible;
  console.log(ok ? 'BROWSER CHECK OK' : 'BROWSER CHECK FAIL');
  process.exit(ok ? 0 : 1);
})().catch((e) => { console.error('FATAL', e); process.exit(1); });
