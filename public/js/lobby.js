/* lobby.js — lobby screen: create/join, slot grid, claim seats, start. */
(function () {
  'use strict';
  const C = window.FP.Constants, Net = window.FP.Net, State = window.FP.State;
  const $ = (id) => document.getElementById(id);

  function name() { return ($('nameInput').value || '').trim() || 'Player ' + Math.floor(Math.random() * 90 + 10); }

  $('createBtn').onclick = () => Net.createRoom(name(), $('devToggle') ? true : true);
  $('joinBtn').onclick = () => { const code = ($('codeInput').value || '').trim().toUpperCase(); if (code.length === 4) Net.joinRoom(code, name()); };
  $('codeInput').addEventListener('keydown', (e) => { if (e.key === 'Enter') $('joinBtn').click(); });
  $('startBtn').onclick = () => Net.start($('devToggle').checked);

  // ---- Server connection control (lets a static / GitHub Pages client point at a hosted server) ----
  (function serverConfig() {
    const input = $('serverInput'), status = $('serverStatus'), det = $('serverConfig');
    if (!input) return;
    input.value = Net.serverUrl || '';
    input.addEventListener('keydown', (e) => { if (e.key === 'Enter') Net.setServer(input.value); });
    if ($('serverSaveBtn')) $('serverSaveBtn').onclick = () => Net.setServer(input.value);
    if ($('serverClearBtn')) $('serverClearBtn').onclick = () => Net.setServer('');
    const here = Net.serverUrl ? Net.serverUrl : 'this site';
    Net.onStatus((s) => {
      if (!status) return;
      if (s === 'connected') status.textContent = '🟢 Connected to ' + here + '.';
      else if (s === 'error') { status.textContent = '🔴 Can’t reach ' + here + '. Enter your Four Pillars server URL below, then Connect.'; if (det) det.open = true; }
      else if (s === 'disconnected') status.textContent = '🟡 Lost connection to ' + here + ' — reconnecting…';
    });
    // Static host (e.g. github.io) with no server configured: prompt up front.
    if (/\.github\.io$/i.test(location.hostname) && !Net.serverUrl) {
      if (det) det.open = true;
      if (status) status.textContent = 'This is a static (GitHub Pages) site — enter the URL of your Four Pillars server to play.';
    }
  })();

  Net.on(C.EV.ROOM_UPDATE, (d) => {
    State.you = d.you; State.isHost = d.isHost;
    $('lobby-entry').classList.add('hidden'); $('lobby-room').classList.remove('hidden');
    $('roomCode').textContent = d.code;
  });

  Net.on(C.EV.LOBBY_UPDATE, (d) => {
    State.lobby = d; State.resolveIdentity();
    $('roomCode').textContent = d.code;
    if (d.status === 'lobby') renderSlots(d);
    $('startBtn').disabled = !State.isHost;
    const diffBar = $('diffBar');
    if (diffBar) diffBar.classList.toggle('hidden', !(State.isHost && d.status === 'lobby'));
    $('lobbyHint').textContent = State.isHost
      ? 'You are the host. Empty seats are filled by AI. Claim no seat to spectate. Press Begin when ready.'
      : 'Waiting for the host to begin. Claim a seat to control a role, or claim none to spectate both kingdoms.';
  });

  Net.on(C.EV.ERROR_MSG, (d) => { if (window.FP.UI) window.FP.UI.toast(d.msg, true); else alert(d.msg); });

  const DIFFS = ['easy', 'medium', 'hard'];
  function diffControl(team, role, sl) {
    const isAI = sl.controller !== 'human';
    const cur = sl.difficulty || 'medium';
    if (!isAI) return '';
    if (!State.isHost) return '<div class="sdiff sdiff-ro">🤖 ' + cap(cur) + '</div>';
    return '<div class="diff-pick">' + DIFFS.map((dv) =>
      '<button class="btn btn-xs' + (dv === cur ? ' btn-gold' : '') + '" onclick="FP.Lobby.setDiff(\'' + team + '\',\'' + role + '\',\'' + dv + '\')">' + cap(dv) + '</button>').join('') + '</div>';
  }
  function cap(s) { return s.charAt(0).toUpperCase() + s.slice(1); }

  function renderSlots(d) {
    for (const team of ['BLUE', 'RED']) {
      const container = document.querySelector('.slots[data-team="' + team + '"]');
      container.innerHTML = '';
      for (const role of C.ROLE_ORDER) {
        const sl = d.slots[team][role]; const meta = C.ROLE_META[role];
        const mine = sl.playerId === State.you;
        const isHuman = sl.controller === 'human';
        const ctrlLabel = isHuman ? '<span class="ctrl-human">👤 ' + esc(sl.name) + '</span>' : '<span class="ctrl-ai">🤖 AI</span>';
        let btn = '';
        if (mine) btn = '<button class="btn btn-sm" onclick="FP.Lobby.release(\'' + team + '\',\'' + role + '\')">Leave</button>';
        else if (!isHuman) btn = '<button class="btn btn-sm" onclick="FP.Lobby.claim(\'' + team + '\',\'' + role + '\')">Claim</button>';
        else btn = '<span class="muted">taken</span>';
        const div = document.createElement('div');
        div.className = 'slot' + (mine ? ' mine' : '');
        div.innerHTML = '<span class="glyph">' + meta.glyph + '</span>' +
          '<div class="sinfo"><div class="srole">' + meta.name + (meta.firstRole ? ' <span class="sdiff">★ good first role</span>' : '') + '</div>' +
          '<div class="sctrl">' + ctrlLabel + ' · <span class="sdiff">' + meta.difficulty + '</span></div>' +
          '<div class="sdiff">' + meta.blurb + '</div>' + diffControl(team, role, sl) + '</div>' + btn;
        container.appendChild(div);
      }
    }
  }
  function esc(s) { return String(s).replace(/[&<>]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;' }[c])); }

  window.FP.Lobby = {
    claim(team, role) { Net.claimSlot(team, role); },
    release(team, role) { Net.setSlot(team, role, 'ai'); },
    setDiff(team, role, difficulty) { Net.setDifficulty(team, role, difficulty); },
    allDiff(difficulty) { Net.setAllDifficulty(difficulty); },
  };
})();
