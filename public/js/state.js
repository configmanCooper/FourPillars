/* state.js — holds the latest server snapshot, lobby info, and local identity. */
(function () {
  'use strict';
  const State = {
    snapshot: null,        // latest game snapshot
    lobby: null,           // latest lobby_update
    you: null,             // your clientId
    isHost: false,
    myTeam: null,
    myRole: null,
    isSpectator: false,    // true when this client holds no seat (watch-only)
    focusTeam: 'BLUE',     // which kingdom a spectator focuses detailed panels on
    logFilter: 'ALL',      // spectator comms/requests filter: ALL | BLUE | RED
    selectedArea: null,
    selectedGroupId: null,
    seenComms: 0,          // for badge counting
    revealThoughts: false, // debug reveal (typed "fourpillars"): show AI Lords' inner monologue

    teamState() { return this.snapshot && this.myTeam ? this.snapshot.teams[this.myTeam] : null; },
    enemyTeam() { return this.myTeam === 'BLUE' ? 'RED' : 'BLUE'; },
    // The team whose detailed panels we render: our own when seated, the focused team when spectating.
    viewTeam() { return this.myTeam || this.focusTeam; },

    resolveIdentity() {
      // Resolve seat from the AUTHORITATIVE snapshot slots (fall back to lobby before the first
      // snapshot). Tri-state and atomic: clear first, then a seat match wins; only flag spectator
      // once an authoritative source exists and shows no seat for us. A seat counts even if the
      // controller is AI or the slot is momentarily disconnected (reconnect keeps playerId).
      const src = (this.snapshot && this.snapshot.teams)
        ? { BLUE: this.snapshot.teams.BLUE.slots, RED: this.snapshot.teams.RED.slots }
        : (this.lobby ? this.lobby.slots : null);
      if (!src) return;
      this.myTeam = null; this.myRole = null;
      for (const team of ['BLUE', 'RED']) {
        for (const role in src[team]) {
          if (src[team][role].playerId === this.you) { this.myTeam = team; this.myRole = role; this.isSpectator = false; return; }
        }
      }
      this.isSpectator = true;
    },
  };
  window.FP.State = State;
})();
