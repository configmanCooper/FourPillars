const { chromium } = require('C:/Users/rocma/CLI/node_modules/playwright');
(async () => {
  const b = await chromium.launch();
  const p = await b.newPage({ viewport: { width: 1440, height: 900 } });
  const errs = []; p.on('pageerror', e => errs.push(e.message));
  await p.goto('http://localhost:3100');
  await p.evaluate(() => localStorage.clear());
  await p.reload({ waitUntil: 'networkidle' });
  await p.fill('#nameInput', 'Watcher');
  await p.click('#createBtn');
  await p.waitForSelector('#lobby-room:not(.hidden)');
  // Claim NOTHING, just start → spectator of an all-AI match.
  await p.click('#startBtn');
  await p.waitForSelector('#game:not(.hidden)');
  await p.waitForFunction(() => window.FP.State.snapshot && window.FP.State.snapshot.status === 'playing');
  await p.waitForTimeout(1500);
  if (await p.isVisible('#modal .modal-card')) await p.click('#modalClose');

  const r = await p.evaluate(() => {
    const S = window.FP.State;
    return {
      isSpectator: S.isSpectator,
      myTeam: S.myTeam, myRole: S.myRole,
      roleTitle: document.getElementById('roleTitle').textContent,
      youBadge: document.getElementById('youBadge').textContent,
      actionButtons: document.getElementById('actionButtons').textContent,
      quickReq: document.getElementById('quickReq').innerHTML,
      chatDisabled: document.getElementById('chatInput').disabled,
      pauseHidden: document.getElementById('pauseBtn').style.display === 'none',
      resourceBar: document.getElementById('resourceBar').textContent,
      hasFilterButtons: !!document.querySelector('#actionButtons button'),
    };
  });
  console.log('SPECTATOR STATE:', JSON.stringify(r, null, 1));

  // Switch comms/log to BLUE-only, then check council shows both teams.
  await p.evaluate(() => window.FP.UI.specFilter('BLUE'));
  await p.waitForTimeout(300);
  const council = await p.evaluate(() => {
    const tc = document.getElementById('teamCards').textContent;
    return { hasBlue: /Blue Kingdom/.test(tc), hasRed: /Red Kingdom/.test(tc) };
  });
  // Open the comms + log tabs to confirm content renders for both kingdoms.
  await p.evaluate(() => window.FP.UI.specFilter('ALL'));
  await p.waitForTimeout(1200);
  const feeds = await p.evaluate(() => {
    const comms = document.getElementById('commsList').textContent;
    const log = document.getElementById('logList').textContent;
    const reqCount = document.getElementById('reqCount').textContent;
    return {
      commsHasBlue: /Blue Kingdom/.test(comms), commsHasRed: /Red Kingdom/.test(comms),
      logLen: log.length, reqCount,
    };
  });
  console.log('COUNCIL:', JSON.stringify(council));
  console.log('FEEDS:', JSON.stringify(feeds));

  // Try to act as spectator — actions should be impossible (no buttons; server would reject anyway).
  // Confirm a forge/command action emitted via Net is rejected server-side.
  const actionResult = await p.evaluate(async () => {
    return await new Promise((resolve) => {
      let got = null;
      window.FP.Net.on(window.FP.Constants.EV.ERROR_MSG, (m) => { got = m; });
      window.FP.Net.action('produce', { item: 'spears', qty: 5, qPct: 1 });
      setTimeout(() => resolve(got), 800);
    });
  });
  console.log('SPECTATOR ACTION RESULT (expect rejection or null):', JSON.stringify(actionResult));

  console.log('errors:', errs.length ? errs : 'none');
  await b.close();
})();
