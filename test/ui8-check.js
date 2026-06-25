const { chromium } = require('C:/Users/rocma/CLI/node_modules/playwright');
(async () => {
  const errs = [];
  const b = await chromium.launch();
  const p = await b.newPage({ viewport: { width: 1440, height: 900 } });
  p.on('pageerror', (e) => errs.push(e.message));
  await p.goto('http://localhost:3100'); await p.evaluate(() => localStorage.clear());
  await p.reload({ waitUntil: 'networkidle' });
  await p.fill('#nameInput', 'HostP'); await p.click('#createBtn');
  await p.waitForSelector('#lobby-room:not(.hidden)');
  await p.waitForTimeout(400);

  // Difficulty bar visible for host.
  const barVisible = await p.isVisible('#diffBar');
  console.log('diff bar visible for host:', barVisible);

  // Each AI slot shows a difficulty picker (3 buttons).
  const pickers = await p.locator('.slots[data-team="BLUE"] .diff-pick').count();
  console.log('BLUE difficulty pickers:', pickers);

  // Click "All Hard" → every AI slot should highlight Hard.
  await p.locator('#diffBar button', { hasText: 'All Hard' }).click();
  await p.waitForTimeout(400);
  const allHard = await p.evaluate(() => {
    const picks = [...document.querySelectorAll('.diff-pick')];
    return picks.length > 0 && picks.every((dp) => {
      const gold = dp.querySelector('.btn-gold');
      return gold && /hard/i.test(gold.textContent);
    });
  });
  console.log('all slots set to Hard:', allHard);

  // Set one BLUE Lord slot individually to Easy.
  await p.locator('.slots[data-team="BLUE"] .slot').first().locator('.diff-pick button', { hasText: 'Easy' }).click();
  await p.waitForTimeout(400);
  const firstIsEasy = await p.evaluate(() => {
    const dp = document.querySelector('.slots[data-team="BLUE"] .slot .diff-pick');
    const gold = dp && dp.querySelector('.btn-gold');
    return gold ? gold.textContent.trim() : null;
  });
  console.log('first BLUE slot individual difficulty:', firstIsEasy);

  // Verify the server stored the difficulties (lobby data is server-broadcast).
  const serverDiffs = await p.evaluate(() => {
    const s = window.FP.State.lobby.slots.BLUE;
    return { LORD: s.LORD.difficulty, STEWARD: s.STEWARD.difficulty, COMMANDER: s.COMMANDER.difficulty };
  });
  console.log('server-stored difficulties (BLUE):', JSON.stringify(serverDiffs));

  console.log('errors:', errs.length ? errs : 'none');
  await b.close();
  const ok = errs.length === 0 && barVisible && pickers === 4 && allHard && firstIsEasy === 'Easy' &&
    serverDiffs.LORD === 'easy' && serverDiffs.STEWARD === 'hard' && serverDiffs.COMMANDER === 'hard';
  console.log(ok ? 'UI8 CHECK OK' : 'UI8 CHECK FAIL');
  process.exit(ok ? 0 : 1);
})().catch((e) => { console.error('FATAL', e); process.exit(1); });
