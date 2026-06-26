const path = require('path');
const { chromium } = require(path.join('C:', 'Users', 'rocma', 'CLI', 'node_modules', 'playwright'));
(async () => {
  const errors = [];
  const browser = await chromium.launch();
  const page = await browser.newPage({ viewport: { width: 1400, height: 860 } });
  page.on('console', (m) => { if (m.type() === 'error') errors.push(m.text()); });
  page.on('pageerror', (e) => errors.push(e.message));
  await page.goto('http://localhost:3100', { waitUntil: 'networkidle' });
  await page.fill('#nameInput', 'Steward'); await page.click('#createBtn');
  await page.waitForSelector('#lobby-room:not(.hidden)', { timeout: 5000 });
  await page.waitForSelector('.slots[data-team="BLUE"] .slot');
  await page.locator('.slots[data-team="BLUE"] .slot').nth(1).locator('button', { hasText: /Claim/i }).click();
  await page.waitForTimeout(300); await page.click('#startBtn');
  await page.waitForSelector('#game:not(.hidden)', { timeout: 5000 }); await page.waitForTimeout(2500);
  if (await page.isVisible('#modal .modal-card')) { await page.click('#modalClose'); await page.waitForTimeout(300); }
  // Freeze the sim so the AI can't change miner counts between readings.
  await page.evaluate(() => window.FP.Net.pause());
  await page.waitForTimeout(500);
  const setup = await page.evaluate(() => { const t = window.FP.State.teamState(); return { danger: !!(t.dangerWork && t.dangerWork.mine) }; });
  if (setup.danger) { await page.evaluate(() => window.FP.UI.toggleDanger('mine')); await page.waitForTimeout(400); }
  const ironFrom = (txt) => { const m = /IRON\s*\/\s*SEC[\s\S]{0,40}?([0-9]+\.[0-9]+)/i.exec(txt); return m ? parseFloat(m[1]) : null; };
  const stoneFrom = (txt) => { const m = /STONE\s*\/\s*SEC[\s\S]{0,40}?([0-9]+\.[0-9]+)/i.exec(txt); return m ? parseFloat(m[1]) : null; };
  await page.evaluate(() => window.FP.UI.modalGather()); await page.waitForTimeout(150);
  const t0 = await page.evaluate(() => document.getElementById('modalBody').textContent);
  const iron0 = ironFrom(t0), stone0 = stoneFrom(t0);
  const miners0 = await page.evaluate(() => window.FP.State.teamState().pop.miners);
  await page.evaluate(() => window.FP.UI.toggleDanger('mine')); await page.waitForTimeout(500);
  await page.evaluate(() => window.FP.UI.modalGather()); await page.waitForTimeout(150);
  const t1 = await page.evaluate(() => document.getElementById('modalBody').textContent);
  const iron1 = ironFrom(t1), stone1 = stoneFrom(t1);
  const miners1 = await page.evaluate(() => window.FP.State.teamState().pop.miners);
  console.log('miners', miners0, '->', miners1, '| iron', iron0, '->', iron1, '| stone', stone0, '->', stone1);
  await browser.close();
  const ir = iron0 ? iron1 / iron0 : 0, sr = stone0 ? stone1 / stone0 : 0;
  const ok = errors.length === 0 && miners0 === miners1 && iron0 > 0 && stone0 > 0 &&
    Math.abs(ir - 1.5) < 0.08 && Math.abs(sr - 1.5) < 0.08;
  console.log('errors:', errors.length ? errors : 'none');
  console.log(ok ? 'DANGER GATHER PREVIEW OK (iron x' + ir.toFixed(2) + ', stone x' + sr.toFixed(2) + ')' : 'DANGER GATHER PREVIEW FAIL (iron x' + ir.toFixed(2) + ', stone x' + sr.toFixed(2) + ')');
  process.exit(ok ? 0 : 1);
})().catch((e) => { console.error('FATAL', e); process.exit(1); });
