const path = require('path');
const { chromium } = require(path.join('C:', 'Users', 'rocma', 'CLI', 'node_modules', 'playwright'));
(async () => {
  const errors = [];
  const browser = await chromium.launch();
  const page = await browser.newPage({ viewport: { width: 1400, height: 820 } });
  page.on('pageerror', (e) => errors.push('pageerror: ' + e.message));
  await page.goto('http://localhost:3100', { waitUntil: 'networkidle' });
  await page.fill('#nameInput', 'Watcher'); await page.click('#createBtn');
  await page.waitForSelector('#lobby-room:not(.hidden)', { timeout: 5000 });
  // Do NOT claim a seat -> host is a spectator. Start.
  await page.click('#startBtn');
  await page.waitForSelector('#game:not(.hidden)', { timeout: 5000 });
  await page.waitForTimeout(2500);
  if (await page.isVisible('#modal .modal-card')) { await page.click('#modalClose'); }
  await page.waitForTimeout(300);
  // Click a resource (wood) chip -> real per-resource income/spend modal, read-only.
  await page.locator('#resourceBar .res-chip').nth(2).click();
  await page.waitForTimeout(300);
  const ttl = await page.textContent('#modalTitle').catch(()=>'');
  const econOpen = await page.isVisible('#modal .modal-card');
  const hasContrib = (await page.textContent('#modal .modal-card')).includes('Contributing (per second)');
  const askBtns = await page.locator('#modal button', { hasText: /Ask|Reserve|Approve|Deny/ }).count();
  await page.click('#modalClose');
  // Military chip.
  await page.locator('#resourceBar .res-chip.mil-chip, #resourceBar .res-chip').last().click();
  await page.waitForTimeout(300);
  const milOpen = await page.isVisible('#modal .modal-card');
  console.log('econTitle:', ttl, 'econOpen:', econOpen, 'contrib:', hasContrib, 'askBtns:', askBtns, 'milOpen:', milOpen, 'errors:', errors.length?errors:'none');
  await browser.close();
  const ok = econOpen && hasContrib && askBtns === 0 && milOpen && errors.length === 0;
  console.log(ok ? 'SPEC INFO OK' : 'SPEC INFO FAIL'); process.exit(ok?0:1);
})().catch(e=>{console.error('FATAL',e);process.exit(1);});
