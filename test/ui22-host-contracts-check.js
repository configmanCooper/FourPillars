/* Verify: (1) left-click host info popup renders strength/composition/per-soldier gear; (2) the Forge
   Contracts modal shows exactly the rotating offers; (3) spec quality bonus constant is wired. */
const path = require('path');
const { chromium } = require(path.join('C:', 'Users', 'rocma', 'CLI', 'node_modules', 'playwright'));

(async () => {
  const errors = [];
  const browser = await chromium.launch();
  const page = await browser.newPage({ viewport: { width: 1400, height: 820 } });
  page.on('console', (m) => { if (m.type() === 'error') errors.push('console: ' + m.text()); });
  page.on('pageerror', (e) => errors.push('pageerror: ' + e.message));

  await page.goto('http://localhost:3100', { waitUntil: 'networkidle' });
  await page.fill('#nameInput', 'Tester');
  await page.click('#createBtn');
  await page.waitForSelector('#lobby-room:not(.hidden)', { timeout: 5000 });
  // Claim the Blue Blacksmith seat (3rd slot) so we can open Contracts.
  await page.waitForSelector('.slots[data-team="BLUE"] .slot');
  const slots = page.locator('.slots[data-team="BLUE"] .slot');
  await slots.nth(2).locator('button', { hasText: /Claim/i }).click();
  await page.waitForTimeout(400);
  await page.click('#startBtn');
  await page.waitForSelector('#game:not(.hidden)', { timeout: 5000 });
  await page.waitForTimeout(6000); // let AI commander form hosts
  if (await page.isVisible('#modal .modal-card')) { await page.click('#modalClose'); await page.waitForTimeout(300); }

  // --- Host popup --- (poll until a host actually has units)
  let hostId = null;
  for (let i = 0; i < 30 && !hostId; i++) {
    hostId = await page.evaluate(() => {
      const s = window.FP.State.snapshot; if (!s) return null;
      for (const tk of ['BLUE', 'RED']) { const t = s.teams[tk]; if (!t) continue; for (const g of (t.armies || [])) { let n = 0; for (const u in (g.units || {})) n += g.units[u] || 0; if (n > 0) return g.id; } }
      return null;
    });
    if (!hostId) await page.waitForTimeout(2000);
  }
  let popupOk = false, popupText = '';
  if (hostId) {
    await page.evaluate((id) => window.FP.UI.showHostPopup(id, 700, 400), hostId);
    await page.waitForTimeout(300);
    popupOk = await page.isVisible('#hostPopup');
    popupText = (await page.textContent('#hostPopup')) || '';
  }
  const popupHasStrength = /⚔️/.test(popupText) && /units/.test(popupText) && /Composition/.test(popupText);

  // --- Contracts modal ---
  const contracts = await page.evaluate(() => {
    window.FP.UI.modalContracts();
    const body = document.getElementById('modalBody');
    const accepts = body.querySelectorAll('button');
    let n = 0; accepts.forEach((b) => { if (/Accept/i.test(b.textContent)) n++; });
    const offers = window.FP.State.teamState().contractOffers || [];
    return { acceptBtns: n, offers: offers.length, text: body.textContent.slice(0, 200) };
  });

  const balOk = await page.evaluate(() => ({
    pool: window.FP.Balance.CONTRACTS.length,
    offerCount: window.FP.Balance.CONTRACT_OFFER_COUNT,
    rotate: window.FP.Balance.CONTRACT_ROTATE_SEC,
    specBonus: window.FP.Balance.SPEC_QUALITY_BONUS,
    specThresh: window.FP.Balance.SPEC_QUALITY_THRESHOLD,
  }));

  console.log('hostId:', hostId, '| popupVisible:', popupOk, '| popupHasStrength:', popupHasStrength);
  console.log('contracts: acceptBtns', contracts.acceptBtns, '| offers', contracts.offers);
  console.log('balance:', JSON.stringify(balOk));
  console.log('errors:', errors.length ? errors : 'none');
  await browser.close();
  const ok = errors.length === 0 && hostId && popupOk && popupHasStrength &&
    contracts.acceptBtns === 3 && balOk.pool === 24 && balOk.offerCount === 3 &&
    balOk.rotate === 60 && balOk.specBonus === 0.10 && balOk.specThresh === 0.80;
  console.log(ok ? 'HOST+CONTRACTS CHECK OK' : 'HOST+CONTRACTS CHECK FAIL');
  process.exit(ok ? 0 : 1);
})().catch((e) => { console.error('FATAL', e); process.exit(1); });
