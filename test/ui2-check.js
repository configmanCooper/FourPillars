const path = require('path');
const { chromium } = require(path.join('C:', 'Users', 'rocma', 'CLI', 'node_modules', 'playwright'));
(async () => {
  const errors = [];
  const b = await chromium.launch();
  const p = await b.newPage({ viewport: { width: 1440, height: 840 } });
  p.on('console', (m) => { if (m.type() === 'error') errors.push('console: ' + m.text()); });
  p.on('pageerror', (e) => errors.push('pageerror: ' + e.message));
  // fresh localStorage so the first-run help shows
  await p.goto('http://localhost:3100');
  await p.evaluate(() => localStorage.clear());
  await p.reload({ waitUntil: 'networkidle' });

  await p.fill('#nameInput', 'LordTester');
  await p.click('#createBtn');
  await p.waitForSelector('#lobby-room:not(.hidden)');
  await p.locator('.slots[data-team="BLUE"] .slot').first().locator('button', { hasText: /Claim/ }).click(); // claim Lord
  await p.waitForTimeout(300);
  await p.click('#startBtn');
  await p.waitForSelector('#game:not(.hidden)');
  // first-run help modal should appear (~600ms)
  await p.waitForTimeout(1200);
  const helpShown = await p.isVisible('#modal .modal-card');
  const helpHasLocation = (await p.textContent('#modalBody')).toLowerCase().includes('per-location');
  if (helpShown) await p.click('#modalClose');

  await p.waitForTimeout(2500);
  const advisor = (await p.textContent('#advisor')).trim();
  const guide = (await p.textContent('#guideContent')).trim();

  // Select the Keep programmatically (map-pixel math is brittle in headless) to verify the panel.
  await p.evaluate(() => { window.FP.State.selectedArea = 'blue_base'; window.FP.UI.update(window.FP.State.snapshot); });
  await p.waitForTimeout(200);
  const sel = await p.textContent('#selDetails');
  // Open build modal via bottom action bar (Lord first button = Build)
  await p.click('#actionButtons .btn');
  await p.waitForTimeout(400);
  const buildBody = await p.textContent('#modalBody');
  const hasLocPicker = buildBody.toLowerCase().includes('building at');
  await p.screenshot({ path: 'test/ui2.png' });
  if (await p.isVisible('#modal .modal-card')) await p.click('#modalClose');

  // Click a resource chip (need broadcast) - should not error
  await p.click('#resourceBar .res-chip');
  await p.waitForTimeout(300);

  console.log('helpShown:', helpShown, '| helpHasPerLocation:', helpHasLocation);
  console.log('advisorLen:', advisor.length, '| guideLen:', guide.length);
  console.log('selectionMentionsSlots:', /slots/i.test(sel));
  console.log('buildHasLocationPicker:', hasLocPicker);
  console.log('errors:', errors.length ? errors : 'none');
  await b.close();
  const ok = errors.length === 0 && helpShown && helpHasLocation && advisor.length > 10 && guide.length > 30 && /slots/i.test(sel) && hasLocPicker;
  console.log(ok ? 'UI2 CHECK OK' : 'UI2 CHECK FAIL');
  process.exit(ok ? 0 : 1);
})().catch((e) => { console.error('FATAL', e); process.exit(1); });
