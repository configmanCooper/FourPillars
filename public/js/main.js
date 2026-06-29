/* main.js — bootstrap: screen switching, render loop, input, event wiring. */
(function () {
  'use strict';
  const C = window.FP.Constants, Net = window.FP.Net, State = window.FP.State, Render = window.FP.Render, UI = window.FP.UI;
  const $ = (id) => document.getElementById(id);
  let started = false;

  function show(screen) { for (const s of ['lobby', 'game', 'gameover']) $(s).classList.toggle('hidden', s !== screen); }

  Net.on(C.EV.GAME_STARTED, () => {
    if (started) return; started = true;
    State.resolveIdentity();
    show('game');
    Render.init($('map'));
    requestAnimationFrame(loop);
    // The action/spectator bar + onboarding are built on the first snapshot, once the authoritative
    // slots have resolved our identity (avoids a race where slots aren't known yet at game_started).
  });

  let barBuilt = false;
  function ensureBar() {
    if (barBuilt) return;
    if (!State.myRole && !State.isSpectator) return;   // identity not resolved yet
    barBuilt = true;
    const yb = $('youBadge');
    if (State.isSpectator) {
      if (yb) yb.textContent = '👁 Spectator';
      UI.buildSpectatorBar();
    } else {
      if (yb) yb.textContent = (C.ROLE_META[State.myRole] ? C.ROLE_META[State.myRole].glyph + ' ' : '') + (State.myTeam === 'BLUE' ? 'Blue' : 'Red') + ' ' + (C.ROLE_META[State.myRole] ? C.ROLE_META[State.myRole].name : '');
      UI.buildActionBar();
      UI.maybeFirstRun();
    }
  }

  Net.on(C.EV.SNAPSHOT, (snap) => {
    State.snapshot = snap;
    if (started && snap.status !== 'lobby') {
      State.resolveIdentity();
      ensureBar();
      UI.update(snap);
    }
  });

  Net.on(C.EV.ACTION_RESULT, (r) => {
    if (r.action === 'supervise') { if (r.ok && r.data && window.FP.UI && UI.onSuperviseResult) UI.onSuperviseResult(r.data); else if (!r.ok && r.reason) { /* swallow supervise spam rejections */ } return; }
    if (!r.ok && r.reason) UI.toast(r.reason, true);
    else if (r.msg) UI.toast(r.msg, false);
  });

  Net.on(C.EV.GAME_OVER, (d) => {
    if (State.isSpectator) {
      $('overTitle').textContent = (C.TEAM_META[d.winner] ? C.TEAM_META[d.winner].name : d.winner) + ' Wins';
      $('overTitle').style.color = d.winner === 'BLUE' ? '#8fb8e8' : '#d46a5a';
    } else {
      const won = d.winner === State.myTeam;
      $('overTitle').textContent = won ? 'Victory!' : 'Defeat';
      $('overTitle').style.color = won ? '#e3c578' : '#d46a5a';
    }
    $('overReason').textContent = d.reason;
    const snap = State.snapshot;
    if (snap) $('overScores').innerHTML =
      '<div style="color:#8fb8e8">Blue Kingdom<br><b>' + snap.teams.BLUE.score + '</b></div>' +
      '<div style="color:#d46a5a">Red Kingdom<br><b>' + snap.teams.RED.score + '</b></div>';
    setTimeout(() => show('gameover'), 1600);
  });

  function loop() {
    if (State.snapshot && State.snapshot.status !== 'lobby') Render.draw(State.snapshot, State);
    requestAnimationFrame(loop);
  }

  // ---- input ----
  $('map').addEventListener('click', (e) => {
    const rect = $('map').getBoundingClientRect();
    const px = e.clientX - rect.left, py = e.clientY - rect.top;
    // Left-click ANY host (either team) to pop up its strength, composition & per-soldier gear.
    const anyHost = Render.anyHostAt(px, py);
    if (anyHost) {
      // The Commander also (de)selects their OWN host for orders, so the right-click-to-move flow still works.
      if (State.myRole === 'COMMANDER' && Render.hostAt(px, py)) State.selectedGroupId = (State.selectedGroupId === anyHost ? null : anyHost);
      UI.showHostPopup(anyHost, e.clientX, e.clientY);
    } else {
      State.selectedArea = Render.areaAt(px, py, State.snapshot);
      UI.hideHostPopup();
    }
    if (State.snapshot) UI.update(State.snapshot);
  });
  // Right-click a location to march the selected host there (auto-attacks an enemy location).
  $('map').addEventListener('contextmenu', (e) => {
    e.preventDefault();
    if (State.isSpectator) return;            // spectators watch only
    if (State.myRole !== 'COMMANDER') return;
    if (!State.selectedGroupId) { UI.toast('Left-click one of your hosts first, then right-click a destination.', true); return; }
    const rect = $('map').getBoundingClientRect();
    const id = Render.areaAt(e.clientX - rect.left, e.clientY - rect.top, State.snapshot);
    if (!id) return;
    UI.moveHostTo(State.selectedGroupId, id);
  });

  // Tabs.
  document.querySelectorAll('.tab').forEach((t) => t.onclick = () => {
    document.querySelectorAll('.tab').forEach((x) => x.classList.remove('active'));
    document.querySelectorAll('.tabpane').forEach((x) => x.classList.remove('active'));
    t.classList.add('active'); $('tab-' + t.dataset.tab).classList.add('active');
  });

  // Chat (spectators watch only — they cannot post to either kingdom).
  $('chatSend').onclick = () => { if (State.isSpectator) return; const v = $('chatInput').value.trim(); if (v) { Net.chat(v); $('chatInput').value = ''; } };
  $('chatInput').addEventListener('keydown', (e) => { if (e.key === 'Enter') $('chatSend').click(); });

  // Modal close.
  $('modalClose').onclick = () => UI.closeModal();
  $('modal').querySelector('.modal-bg').onclick = () => UI.closeModal();
  document.addEventListener('keydown', (e) => { if (e.key === 'Escape' && !$('modal').classList.contains('hidden')) UI.closeModal(); });

  // Pause button.
  $('pauseBtn').onclick = () => UI.pauseToggle();
  // Help / onboarding.
  $('helpBtn').onclick = () => UI.showHelp();

  // ---- Debug / replay export: type "fourpillars" to toggle a debug panel (works even after game over). ----
  let typed = '';
  document.addEventListener('keydown', (e) => {
    if (e.target && (e.target.tagName === 'INPUT' || e.target.tagName === 'TEXTAREA')) return;
    if (!e.key || e.key.length !== 1) return;
    typed = (typed + e.key.toLowerCase()).slice(-12);
    if (typed.indexOf('fourpillars') !== -1) { typed = ''; UI.toggleDebug(); }
  });
  Net.on(C.EV.REPLAY_DATA, (data) => UI.onReplayData(data));
})();
