/* Four Pillars of the Realm — HTTP + Socket.IO server (authoritative). */
'use strict';
const path = require('path');
const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const C = require('./shared/constants.js');
const { RoomManager } = require('./server/rooms.js');

const PORT = process.env.PORT || 3100;
const app = express();
const server = http.createServer(app);
const io = new Server(server, { cors: { origin: '*' } });

// Serve client + shared modules.
app.use(express.static(path.join(__dirname, 'public')));
app.use('/shared', express.static(path.join(__dirname, 'shared')));
app.get('/health', (_req, res) => res.json({ ok: true, rooms: rooms.rooms.size }));

const rooms = new RoomManager(io);

io.on('connection', (socket) => {
  socket.on(C.EV.CREATE_ROOM, (p) => rooms.createRoom(socket, p || {}));
  socket.on(C.EV.JOIN_ROOM, (p) => rooms.joinRoom(socket, p || {}));
  socket.on(C.EV.CLAIM_SLOT, (p) => rooms.claimSlot(socket, p || {}));
  socket.on(C.EV.SET_SLOT, (p) => rooms.setSlot(socket, p || {}));
  socket.on(C.EV.SET_DIFFICULTY, (p) => rooms.setDifficulty(socket, p || {}));
  socket.on(C.EV.START_GAME, (p) => rooms.startGame(socket, p || {}));
  socket.on(C.EV.SUBMIT_ACTION, (p) => rooms.submitAction(socket, p || {}));
  socket.on(C.EV.CHAT, (p) => rooms.chat(socket, p || {}));
  socket.on(C.EV.PAUSE_REQUEST, () => rooms.initiatePause(socket));
  socket.on(C.EV.RESUME_REQUEST, () => rooms.requestResume(socket));
  socket.on(C.EV.PAUSE_VOTE, (p) => rooms.castVote(socket, p || {}));
  socket.on(C.EV.REQUEST_REPLAY, () => rooms.sendReplay(socket));
  socket.on(C.EV.REQUEST_SNAPSHOT, () => {
    const room = rooms.getRoom(socket._fp && socket._fp.code);
    if (room) socket.emit(C.EV.SNAPSHOT, require('./server/sim.js').snapshot(room.state));
  });
  socket.on('disconnect', () => rooms.handleDisconnect(socket));
});

server.listen(PORT, () => {
  console.log('  ⚔  Four Pillars of the Realm — server on http://localhost:' + PORT);
});
