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

  // Inject quality + stockpile, then open each role's modal synchronously and read it.
  const read = (call) => p.evaluate((c) => {
    const t = window.FP.State.teamState();
    t.equipment.swords = 8; t.equipment.tools = 6; t.equipment.spears = 5; t.equipment.armor = 3;
    t.equipQuality = { tools: 2.0, spears: 1.25, swords: 3.0, bows: 1, armor: 0.5, siegeParts: 1, arrows: 1 };
    t.qualityLog = [{ item: 'swords', qId: 'legendary', name: 'Legendary', glyph: '🌟' }];
    const home = window.FP.State.myTeam === 'BLUE' ? 'blue_base' : 'red_base';
    window.FP.State.snapshot.areas[home].buildings.barracks = 1; t.pop.trainers = 2; t.pop.recruits = 5;
    window.FP.UI[c]();
    return document.getElementById('modalBody').textContent;
  }, call);

  const forge = await read('modalForge');
  const forgeOk = /Legendary/i.test(forge) && /Recently forged/i.test(forge);
  console.log('Blacksmith Forge shows quality + recent log:', forgeOk);

  const muster = await read('modalMuster');
  const musterOk = /Swordsman/i.test(muster) && /Legendary/i.test(muster); // swords quality 3.0 → Legendary badge on swordsman/cavalry
  console.log('Commander Train shows weapon quality:', musterOk);

  const mil = await read('modalMilitary');
  const milOk = /Equipment stockpile/i.test(mil) && (/Legendary|Excellent|×3/i.test(mil));
  console.log('Military Overview equipment shows quality:', milOk);

  const sites = await read('modalSites');
  const sitesOk = /Tools quality/i.test(sites) && /Excellent/i.test(sites); // tools 2.0 → Excellent
  console.log('Steward Sites shows tools quality:', sitesOk);

  console.log('errors:', errs.length ? errs : 'none');
  await b.close();
  const ok = errs.length === 0 && forgeOk && musterOk && milOk && sitesOk;
  console.log(ok ? 'UI14 CHECK OK' : 'UI14 CHECK FAIL');
  process.exit(ok ? 0 : 1);
})().catch((e) => { console.error('FATAL', e); process.exit(1); });
