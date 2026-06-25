const { chromium } = require('C:/Users/rocma/CLI/node_modules/playwright');
(async () => {
  const errs = [];
  const b = await chromium.launch();
  const p = await b.newPage({ viewport: { width: 1440, height: 900 } });
  p.on('pageerror', (e) => errs.push(e.message));
  await p.goto('http://localhost:3100'); await p.evaluate(() => localStorage.clear());
  await p.reload({ waitUntil: 'networkidle' });
  await p.fill('#nameInput', 'WUx'); await p.click('#createBtn');
  await p.waitForSelector('#lobby-room:not(.hidden)');
  await p.locator('.slots[data-team="BLUE"] .slot').nth(1).locator('button', { hasText: /Claim/ }).click(); // Steward
  await p.waitForTimeout(300); await p.click('#startBtn');
  await p.waitForSelector('#game:not(.hidden)'); await p.waitForTimeout(1200);
  if (await p.isVisible('#modal .modal-card')) await p.click('#modalClose');

  // Badge shows role name + team
  const badge = await p.textContent('#youBadge');
  const badgeOk = /Steward/i.test(badge) && /Blue/i.test(badge);
  console.log('badge shows role+team:', badgeOk, JSON.stringify(badge));

  // reqText payload specificity + council asks badge
  const reqRes = await p.evaluate(() => {
    const t = window.FP.State.teamState();
    t.requests = [
      { id: 'r1', type: 'BUILD', payload: { type: 'barracks' }, status: 'open', targetRole: 'STEWARD', fromRole: 'LORD', fromName: 'AI Lord' },
      { id: 'r2', type: 'WORKERS', payload: { job: 'miners' }, status: 'open', targetRole: 'STEWARD', fromRole: 'LORD', fromName: 'AI Lord' },
      { id: 'r3', type: 'EQUIPMENT', payload: { item: 'tools' }, status: 'open', targetRole: 'STEWARD', fromRole: 'BLACKSMITH', fromName: 'AI Smith' },
    ];
    window.FP.UI.update(window.FP.State.snapshot);
    return { req: document.getElementById('tab-requests').textContent, council: document.getElementById('teamCards').textContent };
  });
  const reqOk = /build .*Barracks/i.test(reqRes.req) && /shift workers to Miners/i.test(reqRes.req) && /forge .*Tools/i.test(reqRes.req);
  const askBadgeOk = /✉/.test(reqRes.council);
  console.log('reqText payload-specific:', reqOk);
  console.log('council asks badge:', askBadgeOk);

  // askEscort sends caravanId
  const esc = await p.evaluate(() => {
    const t = window.FP.State.teamState();
    t.caravans = [{ id: 'cv9', from: Object.keys(window.FP.State.snapshot.areas)[1], route: [Object.keys(window.FP.State.snapshot.areas)[1], 'blue_base'], legIndex: 0, cargo: { wood: 61 }, resource: 'wood', escort: false }];
    window.FP.UI.modalCaravans();
    let sent = null; const orig = window.FP.Net.action; window.FP.Net.action = (a, pl) => { sent = { a, pl }; return orig(a, pl); };
    window.FP.UI.askEscort('cv9');
    window.FP.Net.action = orig;
    return sent;
  });
  const escOk = esc && esc.a === 'request' && esc.pl.type === 'ESCORT' && esc.pl.payload.caravanId === 'cv9';
  console.log('askEscort sends caravanId:', escOk, JSON.stringify(esc && esc.pl));

  // setWorkModeSafe (non-push, no confirm) fires setWorkMode
  const wm = await p.evaluate(() => {
    let sent = null; const orig = window.FP.Net.action; window.FP.Net.action = (a, pl) => { sent = { a, pl }; return orig(a, pl); };
    window.FP.UI.setWorkModeSafe('north_forest', 'standard', false);
    window.FP.Net.action = orig;
    return sent;
  });
  const wmOk = wm && wm.a === 'setWorkMode' && wm.pl.mode === 'standard';
  console.log('setWorkModeSafe fires:', wmOk);

  // modalOrders shows formation/stance effect %
  const orders = await p.evaluate(() => {
    const t = window.FP.State.teamState();
    t.armies = [{ id: 'g1', name: 'Home Garrison', team: t.team, units: { spearman: 6, archer: 2, militia: 0, swordsman: 0, cavalry: 0, catapult: 0 }, formation: 'line', stance: 'aggressive', area: 'blue_base', moving: null, mission: { type: 'idle' }, isGarrison: true }];
    window.FP.UI.modalOrders();
    return document.getElementById('modalBody').textContent;
  });
  const ordersOk = /%/.test(orders) && /(atk|def|losses)/i.test(orders);
  console.log('modalOrders shows formation/stance effects:', ordersOk);

  // modalMuster shows unit counter hints
  const muster = await p.evaluate(() => {
    const t = window.FP.State.teamState(); const snap = window.FP.State.snapshot;
    snap.areas.blue_base.buildings.barracks = 1; t.pop.recruits = 6; t.pop.trainers = 2;
    window.FP.UI.modalMuster();
    return document.getElementById('modalBody').textContent;
  });
  const musterOk = /counters/i.test(muster) && /arrows/i.test(muster);
  console.log('modalMuster shows counter hints:', musterOk);

  // modalForge shows batch total cost
  const forge = await p.evaluate(() => { window.FP.UI.modalForge(); return document.getElementById('modalBody').textContent; });
  const forgeOk = /for ×/i.test(forge);
  console.log('modalForge shows batch total:', forgeOk);

  // ESC closes modal
  const escClose = await p.evaluate(() => !document.getElementById('modal').classList.contains('hidden'));
  await p.keyboard.press('Escape'); await p.waitForTimeout(100);
  const closed = await p.evaluate(() => document.getElementById('modal').classList.contains('hidden'));
  console.log('ESC closes modal:', escClose && closed);

  console.log('errors:', errs.length ? errs : 'none');
  await b.close();
  const ok = errs.length === 0 && badgeOk && reqOk && askBadgeOk && escOk && wmOk && ordersOk && musterOk && forgeOk && (escClose && closed);
  console.log(ok ? 'UI16 UX POLISH CHECK OK' : 'UI16 UX POLISH CHECK FAIL');
  process.exit(ok ? 0 : 1);
})().catch((e) => { console.error('FATAL', e); process.exit(1); });
