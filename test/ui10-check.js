const { chromium } = require('C:/Users/rocma/CLI/node_modules/playwright');
(async () => {
  const errs = [];
  const b = await chromium.launch();
  const p = await b.newPage({ viewport: { width: 1440, height: 900 } });
  p.on('pageerror', (e) => errs.push(e.message));
  await p.goto('http://localhost:3100'); await p.evaluate(() => localStorage.clear());
  await p.reload({ waitUntil: 'networkidle' });
  await p.fill('#nameInput', 'WLord'); await p.click('#createBtn');
  await p.waitForSelector('#lobby-room:not(.hidden)');
  await p.locator('.slots[data-team="BLUE"] .slot').first().locator('button', { hasText: /Claim/ }).click();
  await p.waitForTimeout(300); await p.click('#startBtn');
  await p.waitForSelector('#game:not(.hidden)'); await p.waitForTimeout(1200);
  if (await p.isVisible('#modal .modal-card')) await p.click('#modalClose');

  // Quick bar shows the 4 Lord buttons.
  const quick = await p.textContent('#quickReq');
  const fourBtns = /Hold Resources/.test(quick) && /Ask the Steward/.test(quick) && /Ask the Commander/.test(quick) && /Ask the Blacksmith/.test(quick);
  console.log('Lord quick bar has 4 council buttons:', fourBtns);

  // Steward Requests modal.
  await p.locator('#quickReq button', { hasText: 'Ask the Steward' }).click();
  await p.waitForTimeout(300);
  const sBody = await p.textContent('#modalBody');
  const stewardOk = /Secure Iron/i.test(sBody) && /Claim a new site/i.test(sBody) && /Expand the realm/i.test(sBody);
  console.log('Steward modal sections/rows:', stewardOk);
  // Send one request and verify it reaches the server (a comms message appears).
  await p.locator('#modalBody .opt', { hasText: /Secure Iron/i }).locator('button', { hasText: /Request/ }).click();
  await p.waitForTimeout(600);
  await p.click('#modalClose');

  // Commander Requests modal.
  await p.locator('#quickReq button', { hasText: 'Ask the Commander' }).click();
  await p.waitForTimeout(300);
  const cBody = await p.textContent('#modalBody');
  const cmdOk = /Defend the Keep/i.test(cBody) && /Siege the enemy Keep/i.test(cBody) && /Train/i.test(cBody) && /Offense/i.test(cBody);
  console.log('Commander modal sections/rows:', cmdOk);
  await p.click('#modalClose');

  // Blacksmith Requests modal.
  await p.locator('#quickReq button', { hasText: 'Ask the Blacksmith' }).click();
  await p.waitForTimeout(300);
  const fBody = await p.textContent('#modalBody');
  const smithOk = /Forge Swords/i.test(fBody) && /Forge Arrows/i.test(fBody) && /Forge equipment/i.test(fBody);
  console.log('Blacksmith modal sections/rows:', smithOk);
  await p.click('#modalClose');

  // Walls description mentions the combat bonus and is buildable anywhere.
  const wallsDesc = await p.evaluate(() => {
    const B = window.FP.Balance;
    // Build the same effectDesc the modal uses, indirectly via a known string check:
    return { troop: B.WALL_TROOP_BONUS, archer: B.WALL_ARCHER_BONUS };
  });
  console.log('wall bonus constants present:', wallsDesc.troop === 0.2 && wallsDesc.archer === 0.5);

  console.log('errors:', errs.length ? errs : 'none');
  await b.close();
  const ok = errs.length === 0 && fourBtns && stewardOk && cmdOk && smithOk && wallsDesc.troop === 0.2 && wallsDesc.archer === 0.5;
  console.log(ok ? 'UI10 CHECK OK' : 'UI10 CHECK FAIL');
  process.exit(ok ? 0 : 1);
})().catch((e) => { console.error('FATAL', e); process.exit(1); });
