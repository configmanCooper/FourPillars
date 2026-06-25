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
  await p.waitForSelector('#game:not(.hidden)'); await p.waitForTimeout(1500);
  if (await p.isVisible('#modal .modal-card')) await p.click('#modalClose');

  // 1. Military Overview opens via soldiers chip.
  await p.locator('.res-chip.mil-chip').click();
  await p.waitForTimeout(500);
  const milTitle = await p.textContent('#modal .modal-card h2, #modalTitle').catch(() => '');
  const milBody = await p.textContent('#modalBody');
  const milOk = /Military Overview/i.test(milTitle || milBody) &&
    /Army composition/i.test(milBody) && /Recent Commander actions/i.test(milBody) &&
    /Training/i.test(milBody) && /Equipment stockpile/i.test(milBody) && /Alerts/i.test(milBody);
  console.log('military modal sections present:', milOk);
  await p.click('#modalClose');

  // 2. Worker caps shown in Workers modal (x/cap for gatherers).
  await p.locator('#actionButtons .btn', { hasText: /Workers/i }).click();
  await p.waitForTimeout(400);
  const wBody = await p.textContent('#modalBody');
  const capShown = /max 4 per Farm/i.test(wBody) && /\d+\/\d+/.test(wBody);
  console.log('worker caps shown:', capShown);
  // Try to exceed farmer cap by clicking + many times; should disable at cap.
  const plus = p.locator('#modalBody .opt', { hasText: /^Farmers/i }).first().locator('button', { hasText: '+' });
  for (let i = 0; i < 12; i++) { if (await plus.isDisabled()) break; await plus.click(); await p.waitForTimeout(120); }
  const farmersText = (await p.textContent('#modalBody')).match(/Farmers[\s\S]*?(\d+)\/(\d+)/);
  const atCap = farmersText && parseInt(farmersText[1], 10) <= parseInt(farmersText[2], 10);
  console.log('farmers within cap:', atCap, farmersText ? farmersText[1] + '/' + farmersText[2] : '?');
  await p.click('#modalClose');

  // 3. Storage-full indicator: force a resource to cap via console and re-render.
  const capIndicator = await p.evaluate(() => {
    const snap = window.FP.State.snapshot; const team = window.FP.State.teamState();
    team.resources.wood = team.storageCap; // simulate full
    window.FP.UI.update(snap);
    const chip = [...document.querySelectorAll('.res-chip')].find((c) => c.querySelector('.cap-full'));
    return chip ? chip.querySelector('.cap-full').title : null;
  });
  console.log('storage-full indicator title:', capIndicator ? capIndicator.slice(0, 40) + '...' : 'NONE');

  console.log('errors:', errs.length ? errs : 'none');
  await b.close();
  const ok = errs.length === 0 && milOk && capShown && atCap && !!capIndicator;
  console.log(ok ? 'UI7 CHECK OK' : 'UI7 CHECK FAIL');
  process.exit(ok ? 0 : 1);
})().catch((e) => { console.error('FATAL', e); process.exit(1); });
