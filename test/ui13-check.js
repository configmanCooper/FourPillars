const { chromium } = require('C:/Users/rocma/CLI/node_modules/playwright');
(async () => {
  const errs = [];
  const b = await chromium.launch();
  const p = await b.newPage({ viewport: { width: 1440, height: 900 } });
  p.on('pageerror', (e) => errs.push(e.message));
  await p.goto('http://localhost:3100'); await p.evaluate(() => localStorage.clear());
  await p.reload({ waitUntil: 'networkidle' });
  await p.fill('#nameInput', 'WSmith'); await p.click('#createBtn');
  await p.waitForSelector('#lobby-room:not(.hidden)');
  await p.locator('.slots[data-team="BLUE"] .slot').nth(2).locator('button', { hasText: /Claim/ }).click(); // Blacksmith
  await p.waitForTimeout(300); await p.click('#startBtn');
  await p.waitForSelector('#game:not(.hidden)'); await p.waitForTimeout(1200);
  if (await p.isVisible('#modal .modal-card')) await p.click('#modalClose');

  // Open the Forge.
  await p.locator('#actionButtons .btn', { hasText: 'gear & arrows' }).click();
  await p.waitForTimeout(300);
  const forgeBody = await p.textContent('#modalBody');
  const hasMinigameHint = /forging minigame|quality/i.test(forgeBody) && /strikes/i.test(forgeBody);
  console.log('Forge modal mentions minigame + quality:', hasMinigameHint);

  // Click Forge on Spears → minigame should appear with a bar + strike button.
  await p.locator('#modalBody .opt', { hasText: /Spears/i }).locator('button', { hasText: /^Forge$/ }).click();
  await p.waitForTimeout(400);
  const barVisible = await p.isVisible('#forgeBar');
  const strikeVisible = await p.isVisible('#forgeStrike');
  const zonesOk = await p.evaluate(() => !!document.querySelector('.fz-green') && !!document.querySelector('.fz-yellow') && !!document.querySelector('#forgeBall'));
  console.log('minigame bar + zones + ball + strike button:', barVisible && strikeVisible && zonesOk);

  // Determine strikes needed (spears time=3 → 3 strikes) and strike to completion.
  const before = await p.evaluate(() => { const t = window.FP.State.teamState(); return (t.production || []).length; });
  let strikes = 0;
  for (let i = 0; i < 12; i++) {
    if (!(await p.isVisible('#forgeStrike'))) break;
    await p.click('#forgeStrike'); strikes++; await p.waitForTimeout(120);
    // when strikes are exhausted, the minigame finishes and the Forge modal reappears (no #forgeStrike)
    if (!(await p.isVisible('#forgeStrike'))) break;
  }
  console.log('strikes performed before completion:', strikes);
  await p.waitForTimeout(600);

  // After completion a produce job should be queued on the server with the chosen quality.
  const produced = await p.evaluate(() => {
    const t = window.FP.State.teamState();
    return (t.production || []).some((q) => q.item === 'spears') || (t.qualityLog || []).some((q) => q.item === 'spears');
  });
  console.log('forge produced spears (queued or completed):', produced);

  console.log('errors:', errs.length ? errs : 'none');
  await b.close();
  const ok = errs.length === 0 && hasMinigameHint && barVisible && strikeVisible && zonesOk && strikes >= 1 && produced;
  console.log(ok ? 'UI13 CHECK OK' : 'UI13 CHECK FAIL');
  process.exit(ok ? 0 : 1);
})().catch((e) => { console.error('FATAL', e); process.exit(1); });
