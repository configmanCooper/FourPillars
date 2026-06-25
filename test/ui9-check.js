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
  await p.locator('.slots[data-team="BLUE"] .slot').first().locator('button', { hasText: /Claim/ }).click(); // claim LORD
  await p.waitForTimeout(300); await p.click('#startBtn');
  await p.waitForSelector('#game:not(.hidden)'); await p.waitForTimeout(1200);
  if (await p.isVisible('#modal .modal-card')) await p.click('#modalClose');

  // Open the Lord's Stance modal.
  await p.locator('#actionButtons .btn', { hasText: /Stance/i }).click();
  await p.waitForTimeout(400);
  const body = await p.textContent('#modalBody');
  const hasThree = /Aggressive Stance/i.test(body) && /Balanced Stance/i.test(body) && /Defensive Stance/i.test(body);
  console.log('stance modal shows all 3 stances:', hasThree);

  // Adopt Aggressive.
  await p.locator('#modalBody .opt', { hasText: /Aggressive Stance/i }).locator('button', { hasText: /Adopt/i }).click();
  await p.waitForTimeout(900);
  const serverStance = await p.evaluate(() => window.FP.State.teamState().militaryPolicy);
  console.log('server stance after adopt:', serverStance);

  // The modal live-refreshes: it should now show cooldown + an "Active" marker on Aggressive.
  const body2 = await p.textContent('#modalBody');
  const onCd = /Change available in/i.test(body2);
  const activeShown = /Active/i.test(body2);
  console.log('cooldown shown after change:', onCd, '· active marker:', activeShown);
  await p.click('#modalClose');

  // Guide shows the stance note.
  const guideHasStance = await p.evaluate(() => {
    const t = window.FP.Tips.compute(window.FP.State.snapshot, window.FP.State);
    const inSummary = t.summary.some((s) => /stance/i.test(s.label));
    const inTips = t.tips.some((x) => /stance/i.test(x.text));
    return inSummary && inTips;
  });
  console.log('guide shows stance (summary + tip):', guideHasStance);

  console.log('errors:', errs.length ? errs : 'none');
  await b.close();
  const ok = errs.length === 0 && hasThree && serverStance === 'aggressive' && onCd && activeShown && guideHasStance;
  console.log(ok ? 'UI9 CHECK OK' : 'UI9 CHECK FAIL');
  process.exit(ok ? 0 : 1);
})().catch((e) => { console.error('FATAL', e); process.exit(1); });
