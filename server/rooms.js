/* Room & lobby management: 8 slots (4 per team), human/AI, start, tick loop, broadcast. */
'use strict';
const C = require('../shared/constants.js');
const B = require('../shared/balance.js');
const S = require('../shared/schema.js');
const sim = require('./sim.js');

function code4() {
  const A = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
  let s = ''; for (let i = 0; i < 4; i++) s += A[Math.floor(Math.random() * A.length)];
  return s;
}

class RoomManager {
  constructor(io) { this.io = io; this.rooms = new Map(); }

  getRoom(code) { return this.rooms.get(code); }

  createRoom(socket, payload) {
    let code; do { code = code4(); } while (this.rooms.has(code));
    const state = S.createInitialState({ roomCode: code, matchPreset: payload.matchPreset });
    const room = { code, hostId: payload.clientId || socket.id, state, players: new Map(), interval: null };
    this.rooms.set(code, room);
    this.joinRoom(socket, { code, name: payload.name, clientId: payload.clientId });
    return room;
  }

  joinRoom(socket, payload) {
    const room = this.rooms.get(payload.code);
    if (!room) { socket.emit(C.EV.ERROR_MSG, { msg: 'Room not found.' }); return null; }
    const pid = payload.clientId || socket.id;
    socket.join(room.code);
    socket._fp = { code: room.code, pid, name: payload.name || 'Player' };
    room.players.set(pid, { pid, name: payload.name || 'Player', socketId: socket.id, connected: true });
    // Reconnect: if this pid already owns a slot, mark connected again.
    for (const team of ['BLUE', 'RED']) for (const role of C.ROLE_ORDER) {
      const sl = room.state.teams[team].slots[role];
      if (sl.playerId === pid) { sl.connected = true; sl.controller = C.CONTROLLER.HUMAN; }
    }
    socket.emit(C.EV.ROOM_UPDATE, { code: room.code, you: pid, isHost: room.hostId === pid });
    this.broadcastLobby(room);
    if (room.state.status === 'playing' || room.state.status === 'over') {
      socket.emit(C.EV.GAME_STARTED, {});
      socket.emit(C.EV.SNAPSHOT, sim.snapshot(room.state));
    }
    return room;
  }

  claimSlot(socket, payload) {
    const room = this.rooms.get(socket._fp && socket._fp.code); if (!room) return;
    if (room.state.status !== 'lobby') return;
    const pid = socket._fp.pid;
    const { team, role } = payload;
    if (!room.state.teams[team] || !room.state.teams[team].slots[role]) return;
    const target = room.state.teams[team].slots[role];
    if (target.controller === C.CONTROLLER.HUMAN && target.playerId && target.playerId !== pid) {
      socket.emit(C.EV.ERROR_MSG, { msg: 'That seat is taken.' }); return;
    }
    // Release any slot this player already holds.
    this.releasePlayerSlots(room, pid);
    target.controller = C.CONTROLLER.HUMAN;
    target.playerId = pid;
    target.name = (socket._fp.name || 'Player');
    target.connected = true;
    this.broadcastLobby(room);
  }

  setSlot(socket, payload) {
    // Host (or the seat's owner) sets a slot back to AI.
    const room = this.rooms.get(socket._fp && socket._fp.code); if (!room) return;
    if (room.state.status !== 'lobby') return;
    const pid = socket._fp.pid;
    const { team, role, controller } = payload;
    const sl = room.state.teams[team] && room.state.teams[team].slots[role]; if (!sl) return;
    const isHost = room.hostId === pid;
    if (controller === C.CONTROLLER.AI) {
      if (!isHost && sl.playerId !== pid) return;
      sl.controller = C.CONTROLLER.AI; sl.playerId = null; sl.connected = false; sl.name = C.ROLE_META[role].name + ' (AI)';
    }
    this.broadcastLobby(room);
  }

  // Host sets AI action-cadence difficulty: one slot {team, role, difficulty}, or all at once {all:true, difficulty}.
  setDifficulty(socket, payload) {
    const room = this.rooms.get(socket._fp && socket._fp.code); if (!room) return;
    if (room.state.status !== 'lobby') return;
    if (room.hostId !== socket._fp.pid) return; // host controls game setup
    const { team, role, difficulty, all } = payload || {};
    if (!C.AI_DIFFICULTIES.includes(difficulty)) return;
    if (all) {
      for (const tm of ['BLUE', 'RED']) for (const r of C.ROLE_ORDER) room.state.teams[tm].slots[r].difficulty = difficulty;
    } else {
      const sl = room.state.teams[team] && room.state.teams[team].slots[role]; if (!sl) return;
      sl.difficulty = difficulty;
    }
    this.broadcastLobby(room);
  }

  releasePlayerSlots(room, pid) {
    for (const team of ['BLUE', 'RED']) for (const role of C.ROLE_ORDER) {
      const sl = room.state.teams[team].slots[role];
      if (sl.playerId === pid) { sl.controller = C.CONTROLLER.AI; sl.playerId = null; sl.connected = false; sl.name = C.ROLE_META[role].name + ' (AI)'; }
    }
  }

  startGame(socket, payload) {
    const room = this.rooms.get(socket._fp && socket._fp.code); if (!room) return;
    if (room.hostId !== socket._fp.pid) { socket.emit(C.EV.ERROR_MSG, { msg: 'Only the host can start.' }); return; }
    if (room.state.status !== 'lobby') return;
    if (payload && payload.matchPreset && B.MATCH_PRESETS && B.MATCH_PRESETS[payload.matchPreset]) {
      room.state.matchPreset = payload.matchPreset;
      room.state.matchLength = B.MATCH_PRESETS[payload.matchPreset];
      room.state.devMode = payload.matchPreset === 'quick';
    }
    // Any unclaimed slot is already AI by default. Begin.
    room.state.status = 'playing';
    this.initReplay(room);
    this.io.to(room.code).emit(C.EV.GAME_STARTED, {});
    this.broadcastLobby(room);
    this.startLoop(room);
  }

  startLoop(room) {
    if (room.interval) return;
    room._pauseCooldownMs = room._pauseCooldownMs || {}; // pid -> ms timestamp until which they can't start a pause vote
    room.interval = setInterval(() => {
      const state = room.state;
      // Resolve any pause vote whose deadline has passed.
      if (state.pause.vote && Date.now() >= room._voteEndsMs) this.resolveVote(room);
      this.refreshPause(room);
      let result = null;
      if (!state.pause.active) result = sim.step(state);
      this.captureReplay(room);
      this.io.to(room.code).emit(C.EV.SNAPSHOT, sim.snapshot(state));
      if (result) {
        this.finishReplay(room, result);
        this.io.to(room.code).emit(C.EV.GAME_OVER, { winner: result.winner, reason: result.reason });
        clearInterval(room.interval); room.interval = null;
        // If everyone has already left (AI finished the match alone), free the room.
        if (![...room.players.values()].some((x) => x.connected)) this.rooms.delete(room.code);
      }
    }, B.TICK_MS);
  }

  // ---------- replay / debug export ----------
  initReplay(room) {
    const st = room.state;
    const slots = {};
    for (const team of ['BLUE', 'RED']) {
      slots[team] = {};
      for (const role of C.ROLE_ORDER) {
        const sl = st.teams[team].slots[role];
        slots[team][role] = { controller: sl.controller, name: sl.name, difficulty: sl.difficulty, persona: (st.teams[team].aiPersona || {})[role] || null };
      }
    }
    room.replay = {
      version: 1,
      meta: { code: room.code, devMode: st.devMode, matchPreset: st.matchPreset || null, matchLength: st.matchLength, startedAt: Date.now(), slots },
      actions: [],          // human actions {t, team, role, action, payload, ok}
      snapshots: [],        // periodic compact per-team state
      events: [],           // full game event log (built up; deduped by id)
      comms: [],            // all team comms/requests (both teams), deduped by id
      outcome: null,
    };
    room._evIds = new Set(); room._commIds = new Set();
  }
  recordAction(room, team, role, action, payload, ok) {
    if (!room.replay) return;
    room.replay.actions.push({ t: Math.round(room.state.elapsed), team, role, action, payload, ok });
    if (room.replay.actions.length > 20000) room.replay.actions.shift();
  }
  captureReplay(room) {
    const rp = room.replay; if (!rp) return; const st = room.state;
    // Pull any new events / comms by id so the log is complete even though clean snapshots trim them.
    for (const e of (st.events || [])) { if (e && e.id && !room._evIds.has(e.id)) { room._evIds.add(e.id); rp.events.push(e); } }
    for (const team of ['BLUE', 'RED']) for (const c of (st.teams[team].comms || [])) { if (c && c.id && !room._commIds.has(c.id)) { room._commIds.add(c.id); rp.comms.push(Object.assign({ team }, c)); } }
    // Capture COMBAT engagements (force sizes on each side) so losing/winning fights — e.g. a lone host
    // charging a larger one — are visible. Any area where both teams have troops present is a fight.
    rp.combats = rp.combats || [];
    const hostCount = (g) => { let n = 0; for (const u of (g.units ? Object.keys(g.units) : [])) n += g.units[u] || 0; return n; };
    const areaOf = (g) => (g.moving ? g.moving.route[g.moving.legIndex] : g.area);
    const force = {};
    for (const team of ['BLUE', 'RED']) for (const g of (st.teams[team].armies || [])) { const n = hostCount(g); if (n < 0.5) continue; const a = areaOf(g); force[a] = force[a] || { BLUE: 0, RED: 0 }; force[a][team] += n; }
    for (const a in force) { if (force[a].BLUE >= 0.5 && force[a].RED >= 0.5) {
      const key = a + ':' + Math.floor(st.elapsed / 5);
      if (!room._combatKeys || !room._combatKeys.has(key)) { (room._combatKeys = room._combatKeys || new Set()).add(key);
        rp.combats.push({ t: Math.round(st.elapsed), area: a, areaName: (st.areas[a] || {}).name, BLUE: Math.round(force[a].BLUE), RED: Math.round(force[a].RED) }); }
    } }
    // Compact per-team snapshot every ~10s — now with food/resource RATES, Keep HP, building counts and a
    // per-host breakdown (size · location · mission) so starvation and bad engagements can be diagnosed.
    if (rp.snapshots.length === 0 || st.elapsed - rp.snapshots[rp.snapshots.length - 1].t >= 10) {
      const rate = (tm, k) => (tm.resourceStats && tm.resourceStats[k]) ? +(tm.resourceStats[k].rate || 0).toFixed(2) : 0;
      const sn = (team) => { const tm = st.teams[team]; return {
        res: Object.assign({}, tm.resources),
        rates: { food: rate(tm, 'food'), wood: rate(tm, 'wood'), stone: rate(tm, 'stone'), iron: rate(tm, 'iron') },
        pop: Object.assign({}, tm.pop), score: Math.round(tm.score || 0),
        soldiers: tm.pop.soldiers, sites: Object.values(st.areas || {}).filter(a => a.owner === team).length,
        buildings: Object.assign({}, tm.buildings), keepHp: Math.round(tm.keep ? tm.keep.hp : 0), keepMaxHp: Math.round(tm.keep ? tm.keep.maxHp : 0),
        starving: !!tm._starving,
        hosts: (tm.armies || []).map((g) => ({ n: Math.round(hostCount(g)), area: areaOf(g), mission: (g.mission && g.mission.type) || 'idle', moving: !!g.moving, armor: !!g.hasArmor })).filter((h) => h.n >= 1),
        research: Object.assign({}, tm.research), researchPoints: Math.round(tm.researchPoints || 0), stewardPolicy: tm.stewardPolicy };
      };
      rp.snapshots.push({ t: Math.round(st.elapsed), phase: st.phase, BLUE: sn('BLUE'), RED: sn('RED') });
    }
  }
  finishReplay(room, result) {
    const rp = room.replay; if (!rp) return;
    this.captureReplay(room);
    rp.outcome = { winner: result.winner, reason: result.reason, elapsed: Math.round(room.state.elapsed), score: { BLUE: Math.round(room.state.teams.BLUE.score), RED: Math.round(room.state.teams.RED.score) } };
  }
  sendReplay(socket) {
    const room = this.rooms.get(socket._fp && socket._fp.code);
    if (!room || !room.replay) { socket.emit(C.EV.ERROR_MSG, { msg: 'No replay available.' }); return; }
    socket.emit(C.EV.REPLAY_DATA, room.replay);
  }


  // ---------- pause / vote ----------
  humansInRoom(room) {
    const pids = new Set();
    for (const team of ['BLUE', 'RED']) for (const role of C.ROLE_ORDER) {
      const sl = room.state.teams[team].slots[role];
      if (sl.controller === C.CONTROLLER.HUMAN && sl.playerId) {
        const p = room.players.get(sl.playerId);
        if (p && p.connected) pids.add(sl.playerId);
      }
    }
    return [...pids];
  }
  controlsHuman(room, pid) {
    for (const team of ['BLUE', 'RED']) for (const role of C.ROLE_ORDER) {
      const sl = room.state.teams[team].slots[role];
      if (sl.controller === C.CONTROLLER.HUMAN && sl.playerId === pid) return true;
    }
    return false;
  }
  playerName(room, pid) { const p = room.players.get(pid); return p ? p.name : 'Player'; }

  initiatePause(socket) {
    const room = this.rooms.get(socket._fp && socket._fp.code); if (!room) return;
    const state = room.state; if (state.status !== 'playing' || state.pause.active || state.pause.vote) return;
    const pid = socket._fp.pid;
    if (!this.controlsHuman(room, pid)) { socket.emit(C.EV.ERROR_MSG, { msg: 'Only seated players can pause.' }); return; }
    const humans = this.humansInRoom(room);
    if (humans.length <= 1) {
      state.pause.active = true;
      this.logPause(room, this.playerName(room, pid) + ' paused the game.');
      this.refreshPause(room); this.broadcastSnapshot(room); return;
    }
    const cd = (room._pauseCooldownMs[pid] || 0) - Date.now();
    if (cd > 0) { socket.emit(C.EV.ERROR_MSG, { msg: 'Pause vote on cooldown (' + Math.ceil(cd / 1000) + 's).' }); return; }
    room._pauseCooldownMs[pid] = Date.now() + 5 * 60 * 1000; // 5-minute per-initiator cooldown
    room._voteEndsMs = Date.now() + 15000;                   // 15-second vote
    state.pause.vote = { kind: 'pause', initiator: pid, initiatorName: this.playerName(room, pid), votes: { [pid]: true } };
    this.logPause(room, this.playerName(room, pid) + ' called a vote to PAUSE (15s).');
    this.maybeResolveAllVoted(room);
    this.refreshPause(room); this.broadcastSnapshot(room);
  }

  requestResume(socket) {
    const room = this.rooms.get(socket._fp && socket._fp.code); if (!room) return;
    const state = room.state; if (!state.pause.active || state.pause.vote) return;
    const pid = socket._fp.pid;
    if (!this.controlsHuman(room, pid)) return;
    const humans = this.humansInRoom(room);
    if (humans.length <= 1) {
      state.pause.active = false;
      this.logPause(room, this.playerName(room, pid) + ' resumed the game.');
      this.refreshPause(room); this.broadcastSnapshot(room); return;
    }
    room._voteEndsMs = Date.now() + 15000;
    state.pause.vote = { kind: 'resume', initiator: pid, initiatorName: this.playerName(room, pid), votes: { [pid]: true } };
    this.logPause(room, this.playerName(room, pid) + ' called a vote to RESUME (15s).');
    this.maybeResolveAllVoted(room);
    this.refreshPause(room); this.broadcastSnapshot(room);
  }

  castVote(socket, payload) {
    const room = this.rooms.get(socket._fp && socket._fp.code); if (!room) return;
    const state = room.state; if (!state.pause.vote) return;
    const pid = socket._fp.pid;
    if (!this.controlsHuman(room, pid)) return;
    state.pause.vote.votes[pid] = !!payload.vote;
    if (!this.maybeResolveAllVoted(room)) { this.refreshPause(room); this.broadcastSnapshot(room); }
  }

  maybeResolveAllVoted(room) {
    const humans = this.humansInRoom(room);
    const v = room.state.pause.vote; if (!v) return false;
    if (humans.every((pid) => v.votes[pid] !== undefined)) { this.resolveVote(room); return true; }
    return false;
  }

  resolveVote(room) {
    const state = room.state; const v = state.pause.vote; if (!v) return;
    const humans = this.humansInRoom(room);
    let yes = 0, no = 0;
    for (const pid of humans) { if (v.votes[pid] === true) yes++; else if (v.votes[pid] === false) no++; }
    const passed = yes > humans.length / 2;
    if (passed) {
      state.pause.active = (v.kind === 'pause');
      this.logPause(room, 'Vote passed (' + yes + '/' + humans.length + ') — game ' + (state.pause.active ? 'PAUSED' : 'RESUMED') + '.');
    } else {
      this.logPause(room, 'Vote failed (' + yes + ' yes / ' + no + ' no).');
    }
    state.pause.vote = null; room._voteEndsMs = 0;
    this.refreshPause(room); this.broadcastSnapshot(room);
  }

  // Keep client-facing pause fields (countdown, tallies, cooldowns) fresh.
  refreshPause(room) {
    const state = room.state; const humans = this.humansInRoom(room);
    if (state.pause.vote) {
      const v = state.pause.vote;
      let yes = 0, no = 0;
      for (const pid of humans) { if (v.votes[pid] === true) yes++; else if (v.votes[pid] === false) no++; }
      v.yes = yes; v.no = no; v.humansCount = humans.length;
      v.endsInSec = Math.max(0, Math.ceil((room._voteEndsMs - Date.now()) / 1000));
    }
    const cd = {};
    for (const pid in (room._pauseCooldownMs || {})) { const s = Math.ceil((room._pauseCooldownMs[pid] - Date.now()) / 1000); if (s > 0) cd[pid] = s; }
    state.pause.cooldownSec = cd;
    state.pause.humansCount = humans.length;
  }

  logPause(room, text) {
    room.state.events.push({ id: S.uid('ev'), t: Math.round(room.state.elapsed), team: null, text: '⏸ ' + text, kind: 'pause' });
    if (room.state.events.length > 50) room.state.events.shift();
  }
  broadcastSnapshot(room) { this.io.to(room.code).emit(C.EV.SNAPSHOT, sim.snapshot(room.state)); }


  submitAction(socket, payload) {
    const room = this.rooms.get(socket._fp && socket._fp.code); if (!room) return;
    if (room.state.status !== 'playing') return;
    const pid = socket._fp.pid;
    // Find which slot this player owns.
    let team = null, role = null;
    for (const tm of ['BLUE', 'RED']) for (const r of C.ROLE_ORDER) {
      if (room.state.teams[tm].slots[r].playerId === pid) { team = tm; role = r; }
    }
    if (!team) { socket.emit(C.EV.ERROR_MSG, { msg: 'You do not control a role.' }); return; }
    const res = sim.applyAction(room.state, team, role, payload.action, payload.payload);
    this.recordAction(room, team, role, payload.action, payload.payload, res.ok);
    socket.emit(C.EV.ACTION_RESULT, { action: payload.action, ok: res.ok, msg: res.msg, reason: res.reason, data: res.data });
    // Push a fresh snapshot to everyone so the action's effect appears immediately (not next tick).
    if (res.ok) this.io.to(room.code).emit(C.EV.SNAPSHOT, sim.snapshot(room.state));
  }

  chat(socket, payload) {
    const room = this.rooms.get(socket._fp && socket._fp.code); if (!room || room.state.status !== 'playing') return;
    const pid = socket._fp.pid;
    for (const tm of ['BLUE', 'RED']) for (const r of C.ROLE_ORDER) {
      if (room.state.teams[tm].slots[r].playerId === pid) {
        sim.applyAction(room.state, tm, r, 'chat', { text: payload.text });
      }
    }
  }

  handleDisconnect(socket) {
    const fp = socket._fp; if (!fp) return;
    const room = this.rooms.get(fp.code); if (!room) return;
    const p = room.players.get(fp.pid); if (p) p.connected = false;
    // AI takes over the disconnected player's seat (keeps playerId for reconnect).
    for (const team of ['BLUE', 'RED']) for (const role of C.ROLE_ORDER) {
      const sl = room.state.teams[team].slots[role];
      if (sl.playerId === fp.pid) { sl.controller = C.CONTROLLER.AI; sl.connected = false; }
    }
    this.broadcastLobby(room);
    // If the host left, hand the host role to any still-connected player so the lobby isn't stuck
    // (only the host can start/configure). Skip once the match is already running.
    if (room.hostId === fp.pid && room.state.status !== 'playing') {
      const next = [...room.players.values()].find((x) => x.connected && x.pid !== fp.pid);
      if (next) { room.hostId = next.pid; this.broadcastLobby(room); }
    }
    // Clean up empty idle rooms.
    if (![...room.players.values()].some((x) => x.connected) && room.state.status !== 'playing') {
      if (room.interval) clearInterval(room.interval);
      this.rooms.delete(room.code);
    }
  }

  broadcastLobby(room) {
    const slots = {};
    for (const team of ['BLUE', 'RED']) {
      slots[team] = {};
      for (const role of C.ROLE_ORDER) {
        const sl = room.state.teams[team].slots[role];
        slots[team][role] = { controller: sl.controller, name: sl.name, connected: sl.connected, playerId: sl.playerId, difficulty: sl.difficulty || C.AI_DIFFICULTY_DEFAULT };
      }
    }
    this.io.to(room.code).emit(C.EV.LOBBY_UPDATE, {
      code: room.code, hostId: room.hostId, status: room.state.status,
      devMode: room.state.devMode, matchPreset: room.state.matchPreset, slots,
    });
  }
}

module.exports = { RoomManager };
