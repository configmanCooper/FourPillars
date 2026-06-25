/* Browser check: the forging minigame's yellow/green target band MOVES to a new position after each
   strike, keeps both sizes, and keeps green centred within yellow. */
const { chromium } = require('C:/Users/rocma/CLI/node_modules/playwright');
(async () => {
  const errs = [];
  const b = await chromium.launch();
  const p = await b.newPage({ viewport: { width: 1440, height: 900 } });
  p.on('pageerror', (e) => errs.push(e.message));
  p.on('console', (m) => { if (m.type() === 'error') errs.push(m.text()); });
  await p.goto('http://localhost:3100'); await p.evaluate(() => localStorage.clear());
  await p.reload({ waitUntil: 'networkidle' });
  await p.fill('#nameInput', 'Smithy'); await p.click('#createBtn');
  await p.waitForSelector('#lobby-room:not(.hidden)');
  await p.locator('.slots[data-team="BLUE"] .slot').nth(2).locator('button', { hasText: /Claim/ }).click(); // Blacksmith
  await p.waitForTimeout(300); await p.click('#startBtn');
  await p.waitForSelector('#game:not(.hidden)');
  await p.waitForSelector('#modal .modal-card', { timeout: 5000 }).catch(() => {});
  if (await p.isVisible('#modal .modal-card')) await p.click('#modalClose');

  // Give resources and open the forge, then start the minigame on the first item.
  await p.evaluate(() => { const t = window.FP.State.teamState(); t.resources.wood = 999; t.resources.iron = 999; window.FP.UI.modalForge(); });
  await p.locator('#modalBody button', { hasText: /^Forge$/ }).first().click();
  await p.waitForSelector('#forgeYellow');

  const read = () => p.evaluate(() => {
    const y = document.getElementById('forgeYellow'), g = document.getElementById('forgeGreen');
    const f = (el, prop) => parseFloat(el.style[prop]);
    return { yL: f(y, 'left'), yW: f(y, 'width'), gL: f(g, 'left'), gW: f(g, 'width') };
  });

  const samples = [await read()];
  for (let i = 0; i < 4; i++) { await p.click('#forgeStrike'); await p.waitForTimeout(120); samples.push(await read()); }

  // Green centred within yellow in every sample (centres coincide).
  const centredOk = samples.every((s) => Math.abs((s.gL + s.gW / 2) - (s.yL + s.yW / 2)) < 0.5);
  // Sizes constant across strikes.
  const sizeOk = samples.every((s) => Math.abs(s.yW - samples[0].yW) < 0.001 && Math.abs(s.gW - samples[0].gW) < 0.001);
  // The band actually moved — at least 3 distinct yellow-left positions across the 5 samples.
  const distinct = new Set(samples.map((s) => Math.round(s.yL * 100))).size;
  const movedOk = distinct >= 3;

  console.log('green centred in yellow every strike:', centredOk);
  console.log('zone sizes constant:', sizeOk, '(yW=' + samples[0].yW.toFixed(2) + ', gW=' + samples[0].gW.toFixed(2) + ')');
  console.log('band moved (distinct positions):', distinct, '→', movedOk);
  console.log('errors:', errs.length ? errs : 'none');
  await b.close();
  const ok = errs.length === 0 && centredOk && sizeOk && movedOk;
  console.log(ok ? 'FORGE-MINIGAME OK' : 'FORGE-MINIGAME FAIL');
  process.exit(ok ? 0 : 1);
})().catch((e) => { console.error('FATAL', e); process.exit(1); });
