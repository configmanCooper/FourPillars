/* net.js — Socket.IO client wrapper with a persistent clientId for reconnects. */
(function () {
  'use strict';
  const C = window.FP.Constants;
  let clientId = localStorage.getItem('fp_clientId');
  if (!clientId) { clientId = 'c_' + Math.random().toString(36).slice(2, 11); localStorage.setItem('fp_clientId', clientId); }

  const socket = io();
  const handlers = {};
  function on(ev, cb) { (handlers[ev] = handlers[ev] || []).push(cb); socket.on(ev, (d) => cb(d)); }

  const Net = {
    clientId,
    socket,
    on,
    createRoom(name, devMode) { socket.emit(C.EV.CREATE_ROOM, { name, devMode, clientId }); },
    joinRoom(code, name) { socket.emit(C.EV.JOIN_ROOM, { code, name, clientId }); },
    claimSlot(team, role) { socket.emit(C.EV.CLAIM_SLOT, { team, role }); },
    setSlot(team, role, controller) { socket.emit(C.EV.SET_SLOT, { team, role, controller }); },
    setDifficulty(team, role, difficulty) { socket.emit(C.EV.SET_DIFFICULTY, { team, role, difficulty }); },
    setAllDifficulty(difficulty) { socket.emit(C.EV.SET_DIFFICULTY, { all: true, difficulty }); },
    start(devMode) { socket.emit(C.EV.START_GAME, { devMode }); },
    action(action, payload) { socket.emit(C.EV.SUBMIT_ACTION, { action, payload: payload || {} }); },
    chat(text) { socket.emit(C.EV.CHAT, { text }); },
    pause() { socket.emit(C.EV.PAUSE_REQUEST); },
    resume() { socket.emit(C.EV.RESUME_REQUEST); },
    vote(v) { socket.emit(C.EV.PAUSE_VOTE, { vote: v }); },
  };
  window.FP.Net = Net;
})();
