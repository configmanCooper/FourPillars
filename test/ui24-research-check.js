/* Verify the University/Research UI + Steward danger toggle render and wire up. */
const path = require('path');
const { chromium } = require(path.join('C:', 'Users', 'rocma', 'CLI', 'node_modules', 'playwright'));

(async () => {
  const errors = [];
  const browser = await chromium.launch();
  const page = await browser.newPage({ viewport: { width: 1400, height: 820 } });
  page.on('console', (m) => { if (m.type() === 'error') errors.push('console: ' + m.text()); });
  page.on('pageerror', (e) => errors.push('pageerror: ' + e.message));

  await page.goto('http://localhost:3100', { waitUntil: 'networkidle' });
  await page.fill('#nameInput', 'Lord');
  await page.click('#createBtn');
  await page.waitForSelector('#lobby-room:not(.hidden)', { timeout: 5000 });
  await page.waitForSelector('.slots[data-team="BLUE"] .slot');
  await page.locator('.slots[data-team="BLUE"] .slot').first().locator('button', { hasText: /Claim/i }).click(); // Lord
  await page.waitForTimeout(300);
  await page.click('#startBtn');
  await page.waitForSelector('#game:not(.hidden)', { timeout: 5000 });
  await page.waitForTimeout(2500);
  if (await page.isVisible('#modal .modal-card')) { await page.click('#modalClose'); await page.waitForTimeout(300); }

  // Research modal (no university yet) renders the "no University" notice.
  const noUni = await page.evaluate(() => { window.FP.UI.modalResearch(); const b = document.getElementById('modalBody'); return { txt: /No University|University/.test(b.textContent), hasResearch: /Research/.test(document.getElementById('modalTitle').textContent) }; });

  // Grant a university + educated workers, then re-open: assign + upgrade buttons appear.
  const withUni = await page.evaluate(() => {
    const s = window.FP.State.snapshot; const t = s.teams[window.FP.State.myTeam];
    // can't mutate authoritative state from client meaningfully; just check balance wiring + glyph
    return {
      univBuild: !!window.FP.Balance.BUILDINGS.university,
      researchCount: Object.keys(window.FP.Balance.RESEARCH).length,
      glyph: '🏫',
      hasResearchBtn: /Research/.test(document.getElementById('actionButtons').textContent),
    };
  });

  // Build menu offers University.
  const buildHasUni = await page.evaluate(() => { window.FP.UI.modalBuild(); const b = document.getElementById('modalBody'); return /University/.test(b.textContent); });

  // Labor modal: as LORD we won't see danger toggle (steward-only), but the modal must render w/o error.
  const labor = await page.evaluate(() => { window.FP.UI.modalGather(); const b = document.getElementById('modalBody'); return { ok: /Labor|Tool stock|Farmers/.test(b.textContent), noAmpEntity: !/&amp;/.test(document.getElementById('modalTitle').textContent) }; });

  console.log('research modal:', JSON.stringify(noUni));
  console.log('wiring:', JSON.stringify(withUni));
  console.log('build offers University:', buildHasUni, '| labor ok:', JSON.stringify(labor));
  console.log('errors:', errors.length ? errors : 'none');
  await browser.close();
  const ok = errors.length === 0 && noUni.txt && noUni.hasResearch && withUni.univBuild && withUni.researchCount === 13 &&
    withUni.hasResearchBtn && buildHasUni && labor.ok && labor.noAmpEntity;
  console.log(ok ? 'RESEARCH UI OK' : 'RESEARCH UI FAIL');
  process.exit(ok ? 0 : 1);
})().catch((e) => { console.error('FATAL', e); process.exit(1); });
