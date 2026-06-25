const { chromium } = require('C:/Users/rocma/CLI/node_modules/playwright');
(async () => {
  const errs = [];
  const b = await chromium.launch();
  const p = await b.newPage({ viewport: { width: 1440, height: 900 } });
  p.on('pageerror', (e) => errs.push(e.message));
  await p.goto('http://localhost:3100'); await p.evaluate(() => localStorage.clear());
  await p.reload({ waitUntil: 'networkidle' });
  await p.fill('#nameInput', 'WStew'); await p.click('#createBtn');
  await p.waitForSelector('#lobby-room:not(.hidden)');
  await p.locator('.slots[data-team="BLUE"] .slot').nth(1).locator('button', { hasText: /Claim/ }).click(); // Steward
  await p.waitForTimeout(300); await p.click('#startBtn');
  await p.waitForSelector('#game:not(.hidden)'); await p.waitForTimeout(1200);
  if (await p.isVisible('#modal .modal-card')) await p.click('#modalClose');

  // ---- modalSites: inject an owned forest outpost, verify costs + yields + work-mode buttons + setWorkMode action ----
  const sites = await p.evaluate(() => {
    const t = window.FP.State.teamState(); const snap = window.FP.State.snapshot;
    // find a forest area and make it ours
    let aid = null; for (const id in snap.areas) { const a = snap.areas[id]; if (a.terrain === 'forest' && a.site) { aid = id; break; } }
    const a = snap.areas[aid]; a.claimedBy = window.FP.State.myTeam; a.owner = window.FP.State.myTeam;
    a.revealed[window.FP.State.myTeam] = true; a.site.level = 2; a.site.cargo = 30; a.site.workMode = 'standard';
    window.FP.UI.modalSites();
    const body = document.getElementById('modalBody').textContent;
    // capture setWorkMode action when clicking Push
    let sent = null; const orig = window.FP.Net.action; window.FP.Net.action = (act, pl) => { sent = { act, pl }; return orig(act, pl); };
    window.FP.UI.act('setWorkMode', { areaId: aid, mode: 'push' });
    window.FP.Net.action = orig;
    return { aid, body, sent };
  });
  const sitesOk = /Outposts/i.test(sites.body) && /Claim costs/i.test(sites.body) && /Your outposts/i.test(sites.body) && /Lv2/i.test(sites.body) && /\/s/i.test(sites.body) && /Cautious|Push/i.test(sites.body);
  const workModeOk = sites.sent && sites.sent.act === 'setWorkMode' && sites.sent.pl.mode === 'push' && sites.sent.pl.areaId === sites.aid;
  console.log('modalSites renders costs/yields/work-modes:', sitesOk);
  console.log('setWorkMode action fires:', workModeOk, JSON.stringify(sites.sent && sites.sent.pl));

  // ---- modalCaravans: inject a caravan, verify cargo/danger/escort + explainer ----
  const car = await p.evaluate(() => {
    const t = window.FP.State.teamState();
    t.caravans = [{ id: 'cv1', from: Object.keys(window.FP.State.snapshot.areas)[1], route: [Object.keys(window.FP.State.snapshot.areas)[1], window.FP.State.myTeam === 'BLUE' ? 'blue_base' : 'red_base'], legIndex: 0, cargo: { wood: 61 }, resource: 'wood', escort: false }];
    window.FP.UI.modalCaravans();
    return document.getElementById('modalBody').textContent;
  });
  const carOk = /Caravans carry/i.test(car) && /61 wood/i.test(car) && /Ask Escort/i.test(car) && /leg/i.test(car);
  console.log('modalCaravans renders cargo/route/escort:', carOk);

  // ---- modalExpeditions: verify list + startExpedition action ----
  const exp = await p.evaluate(() => {
    window.FP.UI.modalExpeditions();
    const body = document.getElementById('modalBody').textContent;
    const B = window.FP.Balance; const first = B.EXPEDITIONS[0];
    let sent = null; const orig = window.FP.Net.action; window.FP.Net.action = (act, pl) => { sent = { act, pl }; return orig(act, pl); };
    window.FP.UI.act('startExpedition', { id: first.id });
    window.FP.Net.action = orig;
    return { body, sent, firstId: first.id };
  });
  const expOk = /Expeditions/i.test(exp.body) && /reward/i.test(exp.body) && /crew is lost/i.test(exp.body);
  const startOk = exp.sent && exp.sent.act === 'startExpedition' && exp.sent.pl.id === exp.firstId;
  console.log('modalExpeditions renders ventures:', expOk);
  console.log('startExpedition action fires:', startOk, JSON.stringify(exp.sent && exp.sent.pl));

  // ---- modalWorkers (Steward): unlocked → enabled; locked → banner + disabled ----
  const wk = await p.evaluate(() => {
    const t = window.FP.State.teamState();
    t.workerLock = false; window.FP.UI.modalWorkers();
    const unlocked = document.getElementById('modalBody').textContent;
    const unlockedDisabled = document.querySelectorAll('#modalBody button[disabled]').length;
    t.workerLock = true; window.FP.UI.modalWorkers();
    const locked = document.getElementById('modalBody').textContent;
    return { unlocked, locked, hadEnabledPlus: unlocked.includes('Farmers') };
  });
  const workersOk = /Workforce/i.test(wk.unlocked) && /locked worker allocation/i.test(wk.locked);
  console.log('modalWorkers Steward unlocked/locked states:', workersOk);

  // ---- Lord lock toggle renders + setWorkerLock action (override role to LORD for render) ----
  const lord = await p.evaluate(() => {
    const savedRole = window.FP.State.myRole; window.FP.State.myRole = 'LORD';
    const t = window.FP.State.teamState(); t.workerLock = false;
    window.FP.UI.modalWorkers();
    const body = document.getElementById('modalBody').textContent;
    let sent = null; const orig = window.FP.Net.action; window.FP.Net.action = (act, pl) => { sent = { act, pl }; return orig(act, pl); };
    window.FP.UI.act('setWorkerLock', { locked: true });
    window.FP.Net.action = orig;
    window.FP.State.myRole = savedRole;
    return { body, sent, hasLevy: /Levy soldiers/i.test(body) };
  });
  const lordLockOk = /Worker control/i.test(lord.body) && /Lock to me|Allow Steward/i.test(lord.body) && lord.hasLevy;
  const setLockOk = lord.sent && lord.sent.act === 'setWorkerLock' && lord.sent.pl.locked === true;
  console.log('Lord lock toggle + levy render:', lordLockOk);
  console.log('setWorkerLock action fires:', setLockOk, JSON.stringify(lord.sent && lord.sent.pl));

  console.log('errors:', errs.length ? errs : 'none');
  await b.close();
  const ok = errs.length === 0 && sitesOk && workModeOk && carOk && expOk && startOk && workersOk && lordLockOk && setLockOk;
  console.log(ok ? 'STEWARD LOGISTICS CHECK OK' : 'STEWARD LOGISTICS CHECK FAIL');
  process.exit(ok ? 0 : 1);
})().catch((e) => { console.error('FATAL', e); process.exit(1); });
