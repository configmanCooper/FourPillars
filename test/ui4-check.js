const { chromium } = require('C:/Users/rocma/CLI/node_modules/playwright');
(async () => {
  const errs = [];
  const b = await chromium.launch();
  const p = await b.newPage({ viewport: { width: 1440, height: 880 } });
  p.on('pageerror', (e) => errs.push(e.message));
  await p.goto('http://localhost:3100'); await p.evaluate(() => localStorage.clear());
  await p.reload({ waitUntil: 'networkidle' });
  await p.fill('#nameInput', 'LiveLord'); await p.click('#createBtn');
  await p.waitForSelector('#lobby-room:not(.hidden)');
  await p.locator('.slots[data-team="BLUE"] .slot').first().locator('button', { hasText: /Claim/ }).click();
  await p.waitForTimeout(300); await p.click('#startBtn');
  await p.waitForSelector('#game:not(.hidden)'); await p.waitForTimeout(1000);
  if (await p.isVisible('#modal .modal-card')) await p.click('#modalClose');

  // Open Build modal, queue a House, then watch the countdown drop WITHOUT reopening.
  await p.click('#actionButtons .btn'); // Build
  await p.waitForTimeout(400);
  await p.locator('#modalBody .opt', { hasText: /House/i }).first().locator('button', { hasText: /Build here/i }).click();
  await p.waitForTimeout(1500);
  const t1 = await p.textContent('#modalBody');
  const m1 = (t1.match(/(\d+)s left/) || [])[1];
  await p.waitForTimeout(3000); // modal stays open
  const t2 = await p.textContent('#modalBody');
  const m2 = (t2.match(/(\d+)s left/) || [])[1];
  const liveCountdown = m1 != null && m2 != null && Number(m2) < Number(m1);
  await p.click('#modalClose');

  // Rationing: hold wood, verify modal + chip reflect it live.
  await p.locator('#actionButtons .btn', { hasText: /Rationing/i }).click();
  await p.waitForTimeout(300);
  await p.locator('#modalBody .opt', { hasText: /Wood/i }).first().locator('button', { hasText: /Hold 30s/i }).click();
  await p.waitForTimeout(800);
  const ration = await p.textContent('#modalBody');
  const heldInModal = /held/i.test(ration);
  await p.click('#modalClose');
  await p.waitForTimeout(300);
  const chipHtml = await p.innerHTML('#resourceBar');
  const chipLocked = chipHtml.includes('🔒');

  console.log('queue countdown live:', liveCountdown, '(', m1, '->', m2, ')');
  console.log('rationing shows held:', heldInModal, '| chip shows lock:', chipLocked);
  console.log('errors:', errs.length ? errs : 'none');
  await b.close();
  const ok = errs.length === 0 && liveCountdown && heldInModal && chipLocked;
  console.log(ok ? 'UI4 CHECK OK' : 'UI4 CHECK FAIL');
  process.exit(ok ? 0 : 1);
})().catch((e) => { console.error('FATAL', e); process.exit(1); });
