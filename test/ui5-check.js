const { chromium } = require('C:/Users/rocma/CLI/node_modules/playwright');
(async () => {
  const errs = [];
  const b = await chromium.launch();
  const p = await b.newPage({ viewport: { width: 1440, height: 880 } });
  p.on('pageerror', (e) => errs.push(e.message));
  await p.goto('http://localhost:3100'); await p.evaluate(() => localStorage.clear());
  await p.reload({ waitUntil: 'networkidle' });
  await p.fill('#nameInput', 'WorkerLord'); await p.click('#createBtn');
  await p.waitForSelector('#lobby-room:not(.hidden)');
  await p.locator('.slots[data-team="BLUE"] .slot').first().locator('button', { hasText: /Claim/ }).click(); // Lord
  await p.waitForTimeout(300); await p.click('#startBtn');
  await p.waitForSelector('#game:not(.hidden)'); await p.waitForTimeout(1500);
  if (await p.isVisible('#modal .modal-card')) await p.click('#modalClose');

  // Open Workers modal -> should show Students, Trainers, Levy section.
  await p.locator('#actionButtons .btn', { hasText: /Workers/i }).click();
  await p.waitForTimeout(300);
  const wbody = await p.textContent('#modalBody');
  const hasStudents = /students/i.test(wbody);
  const hasLevy = /Levy soldiers/i.test(wbody);
  const hasEducated = /educated/i.test(wbody);
  // Click Levy +3
  const recBefore = await p.locator('#resourceBar .res-chip', { hasText: /\d/ }).count();
  await p.locator('#modalBody .btn', { hasText: /\+3/ }).first().click();
  await p.waitForTimeout(600);
  await p.click('#modalClose');

  // Council shows AI personas (e.g., "the" or a banner name)
  await p.waitForTimeout(500);
  const council = await p.innerHTML('#teamCards');
  const hasPersona = /the (Builder|Warmonger|Cautious|Steady|Expansionist|Careful|Ironmonger|Relic|Quartermaster|Armorer|Siege|Toolsmith)|Wolf Banner|Iron Wall|Road Marshal|Hammer of Stone/i.test(council);

  console.log('Workers: students', hasStudents, 'levy', hasLevy, 'educated', hasEducated);
  console.log('council shows AI persona:', hasPersona);
  console.log('errors:', errs.length ? errs : 'none');
  await b.close();
  const ok = errs.length === 0 && hasStudents && hasLevy && hasEducated && hasPersona;
  console.log(ok ? 'UI5 CHECK OK' : 'UI5 CHECK FAIL');
  process.exit(ok ? 0 : 1);
})().catch((e) => { console.error('FATAL', e); process.exit(1); });
