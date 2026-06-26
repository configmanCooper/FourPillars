/* net.js — Socket.IO client wrapper with a persistent clientId for reconnects.
   The server URL is configurable so a statically-hosted client (e.g. GitHub Pages) can reach a
   Node server hosted elsewhere: priority is ?server=<url> (also saved), then localStorage,
   then same-origin (the normal local / single-host case). */
(function () {
  'use strict';
  const C = window.FP.Constants;
  let clientId = localStorage.getItem('fp_clientId');
  if (!clientId) { clientId = 'c_' + Math.random().toString(36).slice(2, 11); localStorage.setItem('fp_clientId', clientId); }

  function pickServer() {
    let url = '';
    try { const qp = new URLSearchParams(location.search).get('server'); if (qp) { url = qp.trim(); localStorage.setItem('fp_server', url); } } catch (e) {}
    if (!url) { try { url = (localStorage.getItem('fp_server') || '').trim(); } catch (e) {} }
    return url;
  }
  const SERVER = pickServer();
  const socket = SERVER ? io(SERVER, { transports: ['websocket', 'polling'] }) : io();

  const statusCbs = [];
  function emitStatus(s, msg) { for (const cb of statusCbs) { try { cb(s, msg); } catch (e) {} } }
  socket.on('connect', () => emitStatus('connected'));
  socket.on('connect_error', (e) => emitStatus('error', e && e.message));
  socket.on('disconnect', (r) => emitStatus('disconnected', r));

  const handlers = {};
  function on(ev, cb) { (handlers[ev] = handlers[ev] || []).push(cb); socket.on(ev, (d) => cb(d)); }

  const Net = {
    clientId,
    socket,
    serverUrl: SERVER,
    on,
    onStatus(cb) { statusCbs.push(cb); if (socket.connected) { try { cb('connected'); } catch (e) {} } },
    setServer(url) {
      try { url = (url || '').trim(); if (url) localStorage.setItem('fp_server', url); else localStorage.removeItem('fp_server'); } catch (e) {}
      // Drop any ?server= override so the saved value (or same-origin) is used after reload.
      try { const u = new URL(location.href); u.searchParams.delete('server'); location.replace(u.toString()); return; } catch (e) {}
      location.reload();
    },
    createRoom(name, matchPreset) { socket.emit(C.EV.CREATE_ROOM, { name, matchPreset, clientId }); },
    joinRoom(code, name) { socket.emit(C.EV.JOIN_ROOM, { code, name, clientId }); },
    claimSlot(team, role) { socket.emit(C.EV.CLAIM_SLOT, { team, role }); },
    setSlot(team, role, controller) { socket.emit(C.EV.SET_SLOT, { team, role, controller }); },
    setDifficulty(team, role, difficulty) { socket.emit(C.EV.SET_DIFFICULTY, { team, role, difficulty }); },
    setAllDifficulty(difficulty) { socket.emit(C.EV.SET_DIFFICULTY, { all: true, difficulty }); },
    start(matchPreset) { socket.emit(C.EV.START_GAME, { matchPreset }); },
    action(action, payload) { socket.emit(C.EV.SUBMIT_ACTION, { action, payload: payload || {} }); },
    chat(text) { socket.emit(C.EV.CHAT, { text }); },
    pause() { socket.emit(C.EV.PAUSE_REQUEST); },
    resume() { socket.emit(C.EV.RESUME_REQUEST); },
    vote(v) { socket.emit(C.EV.PAUSE_VOTE, { vote: v }); },
  };
  window.FP.Net = Net;
})();
