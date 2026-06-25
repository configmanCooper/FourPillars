const { chromium } = require('C:/Users/rocma/CLI/node_modules/playwright');
(async () => {
  const errs = [];
  const b = await chromium.launch();
  const p = await b.newPage({ viewport: { width: 1440, height: 840 } });
  p.on('pageerror', (e) => errs.push(e.message));
  await p.goto('http://localhost:3100'); await p.evaluate(() => localStorage.clear());
  await p.reload({ waitUntil: 'networkidle' });
  await p.fill('#nameInput', 'LordUX'); await p.click('#createBtn');
  await p.waitForSelector('#lobby-room:not(.hidden)');
  await p.locator('.slots[data-team="BLUE"] .slot').first().locator('button', { hasText: /Claim/ }).click(); // Lord
  await p.waitForTimeout(300); await p.click('#startBtn');
  await p.waitForSelector('#game:not(.hidden)'); await p.waitForTimeout(1000);
  if (await p.isVisible('#modal .modal-card')) await p.click('#modalClose');
  await p.waitForTimeout(500);

  // Soldiers + recruits chips present
  const topbar = await p.textContent('#resourceBar');
  const hasSoldiers = await p.locator('#resourceBar .res-chip', { hasText: /^$/ }).count(); // not reliable; check glyphs
  const barHTML = await p.innerHTML('#resourceBar');
  const soldiersChip = barHTML.includes('⚔️');
  const recruitsChip = barHTML.includes('🎖️');

  // Lord quick bar: should NOT offer Recruits/Workers; SHOULD offer Iron + Defend
  const quick = await p.textContent('#quickReq');
  const lordNoRecruits = !/recruits/i.test(quick) && !/workers/i.test(quick);
  const lordHasIronDefend = /iron/i.test(quick) && /defend/i.test(quick);

  // Resource tooltip is role-aware (food chip title mentions Farmers for the Lord)
  const foodTitle = await p.locator('#resourceBar .res-chip').first().getAttribute('title');
  const tipRoleAware = /farmer/i.test(foodTitle || '');

  await p.screenshot({ path: 'test/ui3.png' });
  console.log('soldiersChip:', soldiersChip, 'recruitsChip:', recruitsChip);
  console.log('lord quick bar:', JSON.stringify(quick.replace(/\s+/g, ' ').trim()));
  console.log('lordNoRecruits/Workers:', lordNoRecruits, '| lordHasIronDefend:', lordHasIronDefend);
  console.log('food tooltip role-aware:', tipRoleAware, '|', JSON.stringify((foodTitle || '').slice(0, 90)));
  console.log('errors:', errs.length ? errs : 'none');
  await b.close();
  const ok = errs.length === 0 && soldiersChip && recruitsChip && lordNoRecruits && lordHasIronDefend && tipRoleAware;
  console.log(ok ? 'UI3 CHECK OK' : 'UI3 CHECK FAIL');
  process.exit(ok ? 0 : 1);
})().catch((e) => { console.error('FATAL', e); process.exit(1); });
