/* Browser check: Military Overview "Army composition" rows for equipped unit types have an
   expand/collapse toggle that reveals each individual soldier's weapon & armour; militia (no
   weapon) has no toggle. */
const { chromium } = require('C:/Users/rocma/CLI/node_modules/playwright');
(async () => {
  const errs = [];
  const b = await chromium.launch();
  const p = await b.newPage({ viewport: { width: 1440, height: 900 } });
  p.on('pageerror', (e) => errs.push(e.message));
  p.on('console', (m) => { if (m.type() === 'error') errs.push(m.text()); });
  await p.goto('http://localhost:3100'); await p.evaluate(() => localStorage.clear());
  await p.reload({ waitUntil: 'networkidle' });
  await p.fill('#nameInput', 'Roster'); await p.click('#createBtn');
  await p.waitForSelector('#lobby-room:not(.hidden)');
  await p.locator('.slots[data-team="BLUE"] .slot').nth(3).locator('button', { hasText: /Claim/ }).click(); // Commander
  await p.waitForTimeout(300); await p.click('#startBtn');
  await p.waitForSelector('#game:not(.hidden)');
  await p.waitForSelector('#modal .modal-card', { timeout: 5000 }).catch(() => {});
  if (await p.isVisible('#modal .modal-card')) await p.click('#modalClose');

  const out = await p.evaluate(() => {
    const C = window.FP.Constants; const t = window.FP.State.teamState();
    const eu = {}; for (const k of C.UNITS) eu[k] = 0; eu.swordsman = 2; eu.archer = 1; eu.militia = 1;
    const gear = {}; for (const k of C.UNITS) gear[k] = [];
    gear.swordsman = [{ w: 1.25, a: 1.0 }, { w: 1.0, a: 0 }];   // #1 Good sword + Standard armour; #2 Standard sword, no armour
    gear.archer = [{ w: 2.0, a: 0 }];                            // Excellent bow, no armour
    gear.militia = [{ w: 0, a: 0 }];
    t.armies = [{ id: 'g1', name: 'Vanguard', team: t.team, units: eu, gear, power: { atk: 20, def: 10 }, hasArmor: true, formation: 'line', stance: 'balanced', area: 'blue_base', moving: null, mission: { type: 'idle' }, isGarrison: true, x: 0, y: 0 }];
    window.FP.UI.modalMilitary();
    const collapsed = document.getElementById('modalBody').textContent;
    window.FP.UI.milCompToggle('swordsman');
    const expanded = document.getElementById('modalBody').textContent;
    return { collapsed, expanded };
  });

  const hasToggle = /▸\s*⚔️?\s*Swordsman/.test(out.collapsed) || /▸.*Swordsman/.test(out.collapsed);
  const collapsedHidden = !/Swordsman\s*#1/.test(out.collapsed);
  const expandedShows = /Swordsman\s*#1/.test(out.expanded) && /Swordsman\s*#2/.test(out.expanded);
  const showsWeaponQual = /Good/.test(out.expanded) && /Standard/.test(out.expanded);
  const showsArmour = /🛡/.test(out.expanded) && /none/.test(out.expanded);
  // Militia has no weapon → no expand toggle (▸/▾) on its row.
  const militiaNoToggle = !/[▸▾].*Militia/.test(out.expanded);

  console.log('swordsman row has expand toggle:', hasToggle);
  console.log('collapsed hides per-soldier list:', collapsedHidden);
  console.log('expanded shows each soldier (#1,#2):', expandedShows);
  console.log('shows weapon qualities (Good/Standard):', showsWeaponQual);
  console.log('shows armour (🛡 + none):', showsArmour);
  console.log('militia has no toggle:', militiaNoToggle);
  console.log('errors:', errs.length ? errs : 'none');
  await b.close();
  const ok = errs.length === 0 && hasToggle && collapsedHidden && expandedShows && showsWeaponQual && showsArmour && militiaNoToggle;
  console.log(ok ? 'UI21 ROSTER CHECK OK' : 'UI21 ROSTER CHECK FAIL');
  process.exit(ok ? 0 : 1);
})().catch((e) => { console.error('FATAL', e); process.exit(1); });
