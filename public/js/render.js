/* render.js — top-down heraldic map renderer (canvas, primitives only). */
(function () {
  'use strict';
  const C = window.FP.Constants;
  const WORLD_W = 1600, WORLD_H = 1000;

  const PALETTE = {
    bgTop: '#241c14', bgBot: '#15110b',
    blue: '#2f5f9f', blueLight: '#8fb8e8', blueDark: '#1d3c66',
    red: '#8b2500', redLight: '#d46a5a', redDark: '#5c1800',
    gold: '#c4a35a', ink: '#1a1208',
    terrain: {
      base: '#5a4a36', plains: '#7a9a52', forest: '#2f5a35', hills: '#6f7f56',
      mountain: '#6b5b4f', river: '#3f7fa6', farmland: '#b99a45', ruins: '#8a7a64',
    },
    road: '#8b7355',
  };
  const TERRAIN_GLYPH = { base: '♜', forest: '🌲', hills: '⛰️', mountain: '⛏️', farmland: '🌾', plains: '🐎', ruins: '🏛️', river: '🌉' };

  let canvas, ctx, dpr = 1;
  let scale = 1, offX = 0, offY = 0;
  let hostHits = [], allHostHits = [], selHostId = null, myTeamR = null;
  let staticLayer = null;
  const blobCache = {};
  let particles = [];
  let floats = [];
  const prevKeep = { BLUE: null, RED: null };
  const hostSmooth = {};       // host id -> eased screen-world position for marching interpolation
  let lastSnapTick = -1;
  let curElapsed = 0;          // latest snapshot's sim clock (seconds) — for expiring transient host markers

  function hash(s) { let h = 2166136261; for (let i = 0; i < s.length; i++) { h ^= s.charCodeAt(i); h = Math.imul(h, 16777619); } return (h >>> 0); }

  function init(cv) {
    canvas = cv; ctx = cv.getContext('2d');
    resize();
    window.addEventListener('resize', () => { resize(); staticLayer = null; });
  }

  function resize() {
    const r = canvas.getBoundingClientRect();
    dpr = window.devicePixelRatio || 1;
    canvas.width = Math.max(1, Math.floor(r.width * dpr));
    canvas.height = Math.max(1, Math.floor(r.height * dpr));
    const sx = canvas.width / WORLD_W, sy = canvas.height / WORLD_H;
    scale = Math.min(sx, sy);
    offX = (canvas.width - WORLD_W * scale) / 2;
    offY = (canvas.height - WORLD_H * scale) / 2;
  }
  function w2s(x, y) { return [offX + x * scale, offY + y * scale]; }
  function s2w(px, py) { return [(px * dpr - offX) / scale, (py * dpr - offY) / scale]; }

  function blob(area) {
    if (blobCache[area.id]) return blobCache[area.id];
    const rng = hash(area.id);
    const pts = []; const n = 12; const base = area.terrain === 'base' ? 92 : 74;
    for (let i = 0; i < n; i++) {
      const a = (i / n) * Math.PI * 2;
      const wob = 0.78 + 0.34 * Math.abs(Math.sin(a * 3 + (rng % 17)) + Math.cos(a * 2 + (rng % 7))) / 2;
      pts.push([Math.cos(a) * base * wob, Math.sin(a) * base * (wob * 0.82)]);
    }
    blobCache[area.id] = pts; return pts;
  }

  function buildStatic(areas) {
    const off = document.createElement('canvas');
    off.width = canvas.width; off.height = canvas.height;
    const g = off.getContext('2d');
    // Parchment background.
    const bg = g.createRadialGradient(canvas.width / 2, canvas.height * 0.35, 100, canvas.width / 2, canvas.height / 2, canvas.width);
    bg.addColorStop(0, PALETTE.bgTop); bg.addColorStop(1, PALETTE.bgBot);
    g.fillStyle = bg; g.fillRect(0, 0, off.width, off.height);

    // Connections (layered: shadow, road, dashes; bridges over rivers).
    const drawn = new Set();
    for (const id in areas) {
      const a = areas[id];
      for (const nid of a.connections) {
        const key = [id, nid].sort().join('|'); if (drawn.has(key)) continue; drawn.add(key);
        const b = areas[nid];
        const [x1, y1] = w2s(a.x, a.y), [x2, y2] = w2s(b.x, b.y);
        g.lineCap = 'round';
        g.strokeStyle = 'rgba(0,0,0,0.4)'; g.lineWidth = 11 * scale + 4; line(g, x1, y1 + 3, x2, y2 + 3);
        g.strokeStyle = PALETTE.road; g.lineWidth = 7 * scale + 1; line(g, x1, y1, x2, y2);
        g.strokeStyle = 'rgba(210,190,150,0.35)'; g.lineWidth = 2; g.setLineDash([6, 10]); line(g, x1, y1, x2, y2); g.setLineDash([]);
      }
    }
    // Terrain blobs + icon plates + labels.
    for (const id in areas) {
      const a = areas[id];
      const [cx, cy] = w2s(a.x, a.y);
      const pts = blob(a);
      g.save(); g.translate(cx, cy); g.scale(scale, scale);
      // shadow
      g.beginPath(); poly(g, pts, 6, 10); g.fillStyle = 'rgba(0,0,0,0.35)'; g.fill();
      // body
      g.beginPath(); poly(g, pts, 0, 0);
      const tcol = PALETTE.terrain[a.terrain] || '#6a5a40';
      const grd = g.createRadialGradient(-20, -25, 10, 0, 0, 95);
      grd.addColorStop(0, lighten(tcol, 28)); grd.addColorStop(1, tcol);
      g.fillStyle = grd; g.fill();
      g.lineWidth = 2.4; g.strokeStyle = PALETTE.ink; g.stroke();
      terrainPattern(g, a, pts);
      g.restore();
      // icon plate
      g.font = (a.terrain === 'base' ? 30 : 24) + 'px serif'; g.textAlign = 'center'; g.textBaseline = 'middle';
      g.fillText(TERRAIN_GLYPH[a.terrain] || '◆', cx, cy - 6 * scale);
      // label plaque
      const label = a.name;
      g.font = '600 ' + Math.max(11, 13 * scale) + 'px Cinzel'; g.textBaseline = 'middle';
      const tw = g.measureText(label).width;
      const ly = cy + 30 * scale;
      g.fillStyle = 'rgba(20,14,8,0.78)'; roundRect(g, cx - tw / 2 - 7, ly - 9, tw + 14, 18, 5); g.fill();
      g.fillStyle = '#e7d8b4'; g.fillText(label, cx, ly);
    }
    staticLayer = off;
  }

  function terrainPattern(g, a, pts) {
    g.save(); g.beginPath(); poly(g, pts, 0, 0); g.clip();
    if (a.terrain === 'forest') {
      g.fillStyle = 'rgba(20,50,25,0.55)';
      for (let i = 0; i < 7; i++) { const x = -50 + (i * 17 % 100); const y = -10 + ((i * 31) % 60); tri(g, x, y, 9); }
    } else if (a.terrain === 'farmland') {
      g.strokeStyle = 'rgba(120,95,30,0.5)'; g.lineWidth = 4;
      for (let x = -70; x < 70; x += 16) line(g, x, -60, x, 60);
    } else if (a.terrain === 'mountain' || a.terrain === 'hills') {
      g.fillStyle = 'rgba(40,32,26,0.5)';
      for (let i = 0; i < 4; i++) { const x = -45 + i * 28; tri(g, x, 12, 18); }
    } else if (a.terrain === 'ruins') {
      g.fillStyle = 'rgba(40,34,26,0.55)';
      for (let i = 0; i < 4; i++) { g.fillRect(-44 + i * 24, -8, 7, 26); }
    } else if (a.terrain === 'plains') {
      g.strokeStyle = 'rgba(60,80,40,0.4)'; g.lineWidth = 2;
      for (let i = 0; i < 6; i++) { const x = -50 + i * 18; line(g, x, 10, x - 4, 24); }
    }
    g.restore();
  }
  function tri(g, x, y, s) { g.beginPath(); g.moveTo(x, y - s); g.lineTo(x - s * 0.7, y + s * 0.6); g.lineTo(x + s * 0.7, y + s * 0.6); g.closePath(); g.fill(); }
  function poly(g, pts, dx, dy) { g.moveTo(pts[0][0] + dx, pts[0][1] + dy); for (let i = 1; i < pts.length; i++) g.lineTo(pts[i][0] + dx, pts[i][1] + dy); g.closePath(); }
  function line(g, a, b, c, d) { g.beginPath(); g.moveTo(a, b); g.lineTo(c, d); g.stroke(); }
  function roundRect(g, x, y, w, h, r) { g.beginPath(); g.moveTo(x + r, y); g.arcTo(x + w, y, x + w, y + h, r); g.arcTo(x + w, y + h, x, y + h, r); g.arcTo(x, y + h, x, y, r); g.arcTo(x, y, x + w, y, r); g.closePath(); }
  function lighten(hex, amt) { const n = parseInt(hex.slice(1), 16); let r = (n >> 16) + amt, gg = ((n >> 8) & 255) + amt, b = (n & 255) + amt; r = Math.min(255, r); gg = Math.min(255, gg); b = Math.min(255, b); return 'rgb(' + r + ',' + gg + ',' + b + ')'; }
  function teamCol(team, light) { return team === 'BLUE' ? (light ? PALETTE.blueLight : PALETTE.blue) : team === 'RED' ? (light ? PALETTE.redLight : PALETTE.red) : '#9b8a66'; }

  function draw(snap, st) {
    if (!snap) return;
    curElapsed = snap.elapsed || 0;
    if (!staticLayer) buildStatic(snap.areas);
    selHostId = st && st.selectedGroupId; myTeamR = st && st.myTeam;
    hostHits = []; allHostHits = [];
    ctx.clearRect(0, 0, canvas.width, canvas.height);
    ctx.drawImage(staticLayer, 0, 0);

    const areas = snap.areas;
    // Ownership rings, claimed pennants, threat, fog for your team.
    for (const id in areas) {
      const a = areas[id];
      const [cx, cy] = w2s(a.x, a.y);
      const owner = a.owner;
      // A coloured ring marks a CONTROLLED location: the Keep (home base) always, or a built OUTPOST
      // (claimedBy). Ground that is merely owned but has no outpost — e.g. just captured — shows no
      // ring until an outpost is actually built there.
      const ringOwner = a.terrain === 'base' ? owner : (a.claimedBy || null);
      if (ringOwner) {
        ctx.beginPath(); ctx.arc(cx, cy, 70 * scale, 0, Math.PI * 2);
        ctx.strokeStyle = teamCol(ringOwner, true); ctx.lineWidth = 4; ctx.globalAlpha = 0.85; ctx.stroke(); ctx.globalAlpha = 1;
        // pennant
        ctx.fillStyle = teamCol(ringOwner, false);
        const px = cx + 46 * scale, py = cy - 50 * scale;
        ctx.fillRect(px, py, 3, 22); ctx.beginPath(); ctx.moveTo(px + 3, py); ctx.lineTo(px + 20, py + 6); ctx.lineTo(px + 3, py + 12); ctx.closePath(); ctx.fill();
      }
      // Fog: dim areas not revealed for your team.
      if (st.myTeam && a.revealed && !a.revealed[st.myTeam]) {
        ctx.save(); ctx.globalAlpha = 0.62; ctx.fillStyle = '#0c0905';
        ctx.beginPath(); ctx.arc(cx, cy, 80 * scale, 0, Math.PI * 2); ctx.fill(); ctx.restore();
      } else if (st.myTeam && a.revealed && a.revealed[st.myTeam] && a.scouted && !a.scouted[st.myTeam]) {
        // Discovered but currently UNSCOUTED (lapsed into fog): a lighter haze + a 🌫 mark.
        ctx.save(); ctx.globalAlpha = 0.30; ctx.fillStyle = '#1a2230';
        ctx.beginPath(); ctx.arc(cx, cy, 80 * scale, 0, Math.PI * 2); ctx.fill(); ctx.restore();
        ctx.font = (14 * scale + 6) + 'px serif'; ctx.textAlign = 'center'; ctx.textBaseline = 'middle';
        ctx.globalAlpha = 0.7; ctx.fillText('🌫', cx + 34 * scale, cy - 34 * scale); ctx.globalAlpha = 1;
      }
      // Scouting progress bar: the area our scouts are currently working on.
      const sj = st.myTeam && snap.teams && snap.teams[st.myTeam] && snap.teams[st.myTeam].scoutJob;
      if (sj && sj.areaId === id) {
        const pct = Math.max(0, Math.min(1, sj.progress || 0));
        const bw = 70 * scale, bx = cx - bw / 2, by = cy + 60 * scale;
        ctx.fillStyle = 'rgba(20,14,8,0.85)'; roundRect(ctx, bx - 2, by - 2, bw + 4, 8, 3); ctx.fill();
        ctx.fillStyle = '#8fb8e8'; ctx.fillRect(bx, by, bw * pct, 4);
        ctx.font = '700 9px Cinzel'; ctx.textAlign = 'center'; ctx.textBaseline = 'bottom';
        ctx.fillStyle = '#bcd2ee'; ctx.fillText('🔭 ' + Math.round(pct * 100) + '%', cx, by - 3);
      }
      // Outpost BUILD progress bar: the site MY team's Steward is currently claiming / raising.
      const bj = st.myTeam && snap.teams && snap.teams[st.myTeam] && snap.teams[st.myTeam]._busyJob;
      if (bj && bj.kind === 'claim' && bj.areaId === id) {
        const CT = (window.FP.Balance && window.FP.Balance.CLAIM_TIME) || 1;
        const pct = Math.max(0, Math.min(1, 1 - (bj.remaining || 0) / CT));
        const bw = 70 * scale, bx = cx - bw / 2, by = cy + 60 * scale;
        ctx.fillStyle = 'rgba(20,14,8,0.85)'; roundRect(ctx, bx - 2, by - 2, bw + 4, 8, 3); ctx.fill();
        ctx.fillStyle = '#caa24a'; ctx.fillRect(bx, by, bw * pct, 4);
        ctx.font = '700 9px Cinzel'; ctx.textAlign = 'center'; ctx.textBaseline = 'bottom';
        ctx.fillStyle = '#e7d8b4'; ctx.fillText('🏗 Raising ' + Math.round(pct * 100) + '%', cx, by - 3);
      }
      // Selection ring.
      if (st.selectedArea === id) {
        ctx.beginPath(); ctx.arc(cx, cy, 82 * scale, 0, Math.PI * 2);
        ctx.strokeStyle = PALETTE.gold; ctx.lineWidth = 3; ctx.setLineDash([6, 6]); ctx.stroke(); ctx.setLineDash([]);
      }
      // Owned-location building slots: pips ring + count badge + capture risk.
      if (owner && a.buildings) {
        let used = 0; for (const t in a.buildings) used += a.buildings[t];
        const max = a.maxBuildings || 5;
        // pip ring
        const rr = 60 * scale;
        for (let i = 0; i < max; i++) {
          const ang = -Math.PI / 2 + (i / max) * Math.PI * 2;
          const px = cx + Math.cos(ang) * rr, py = cy + Math.sin(ang) * rr;
          ctx.beginPath(); ctx.arc(px, py, 3.2, 0, Math.PI * 2);
          ctx.fillStyle = i < used ? teamCol(owner, true) : 'rgba(0,0,0,0.35)';
          ctx.strokeStyle = 'rgba(0,0,0,0.6)'; ctx.lineWidth = 1; ctx.fill(); ctx.stroke();
        }
        // count badge bottom-right of node
        const bx = cx + 30 * scale, by = cy + 30 * scale;
        ctx.font = '700 10px Cinzel'; ctx.textAlign = 'center'; ctx.textBaseline = 'middle';
        const label = used + '/' + max + (used >= max ? ' FULL' : '');
        const w = ctx.measureText(label).width + 8;
        ctx.fillStyle = 'rgba(20,14,8,0.82)'; roundRect(ctx, bx - w / 2, by - 7, w, 14, 4); ctx.fill();
        ctx.fillStyle = used >= max ? '#d9a441' : '#e7d8b4'; ctx.fillText(label, bx, by);
        // capture risk — an EMPTY outpost being seized: pulsing alert + a CAPTURE progress bar (fills red as
        // the enemy holds the bare ground toward seizing it). captureProgress runs 0 → CAPTURE_AFTER_RAZE.
        if (a.captureProgress > 0) {
          const pulse = 0.5 + 0.5 * Math.sin(Date.now() / 140);
          ctx.textAlign = 'center'; ctx.textBaseline = 'middle';
          ctx.font = '700 11px Cinzel'; ctx.fillStyle = 'rgba(220,70,50,' + (0.6 + pulse * 0.4) + ')';
          ctx.strokeStyle = '#000'; ctx.lineWidth = 3;
          ctx.strokeText('⚠ BEING CAPTURED', cx, cy - 46 * scale); ctx.fillText('⚠ BEING CAPTURED', cx, cy - 46 * scale);
          const CAR = (window.FP.Balance && window.FP.Balance.CAPTURE_AFTER_RAZE) || 10;
          const cp = Math.max(0, Math.min(1, a.captureProgress / CAR));
          const bw = 70 * scale, bx = cx - bw / 2, by = cy - 36 * scale;
          ctx.fillStyle = 'rgba(20,14,8,0.85)'; roundRect(ctx, bx - 2, by - 2, bw + 4, 8, 3); ctx.fill();
          ctx.fillStyle = '#d65050'; ctx.fillRect(bx, by, bw * cp, 4);
          ctx.font = '700 9px Cinzel'; ctx.textAlign = 'center'; ctx.textBaseline = 'bottom';
          ctx.fillStyle = '#f0cfc7'; ctx.fillText('🚩 ' + Math.round(cp * 100) + '%', cx, by - 3);
        }
        // UNDER RAID: the outpost is actively being razed right now — pulsing alert + a remaining-health bar
        // (the building currently being torn down). Green→red as it's battered toward destruction.
        const beingRazed = a.terrain !== 'base' && a._razeHp != null && a._razeHpMax && (snap.tick - (a._razeActiveTick || -999)) <= 2;
        if (beingRazed && !(a.captureProgress > 0)) {
          const pulse = 0.5 + 0.5 * Math.sin(Date.now() / 120);
          ctx.textAlign = 'center'; ctx.textBaseline = 'middle';
          ctx.font = '700 11px Cinzel'; ctx.fillStyle = 'rgba(230,80,60,' + (0.6 + pulse * 0.4) + ')';
          ctx.strokeStyle = '#000'; ctx.lineWidth = 3;
          ctx.strokeText('⚔ UNDER RAID', cx, cy - 46 * scale); ctx.fillText('⚔ UNDER RAID', cx, cy - 46 * scale);
          const hp = Math.max(0, Math.min(1, a._razeHp / a._razeHpMax));
          const bw = 70 * scale, bx = cx - bw / 2, by = cy - 36 * scale;
          ctx.fillStyle = 'rgba(20,14,8,0.85)'; roundRect(ctx, bx - 2, by - 2, bw + 4, 8, 3); ctx.fill();
          ctx.fillStyle = hp > 0.4 ? '#6bbf5f' : '#d65050'; ctx.fillRect(bx, by, bw * hp, 4);
          ctx.font = '700 9px Cinzel'; ctx.textAlign = 'center'; ctx.textBaseline = 'bottom';
          ctx.fillStyle = '#f0cfc7'; ctx.fillText('🛡 ' + Math.round(hp * 100) + '%', cx, by - 3);
        }
      }
      // Your own outposts: flag ~5s before a caravan departs, and show stationed guards.
      if (owner === st.myTeam && a.site && a.terrain !== 'base') {
        const B = window.FP.Balance;
        const rate = ((B.SITE_YIELD[a.terrain] || {})[a.resource] || 0) * (a.site.level || 1) * ((B.WORK_MODES[a.site.workMode] || B.WORK_MODES.standard).production || 1);
        const thr = (B.CARAVAN_DISPATCH_BY_RESOURCE && B.CARAVAN_DISPATCH_BY_RESOURCE[a.resource]) || B.CARAVAN_DISPATCH_CARGO;
        const eta = rate > 0 ? (thr - a.site.cargo) / rate : Infinity;
        if (eta > 0 && eta <= (B.CARAVAN_WARN_SECONDS || 5)) {
          const pulse = 0.5 + 0.5 * Math.sin(Date.now() / 150);
          ctx.font = '700 12px Cinzel'; ctx.textAlign = 'center'; ctx.textBaseline = 'middle';
          const txt = '🐎 ' + Math.ceil(eta) + 's'; const ty = cy - 58 * scale;
          const w = ctx.measureText(txt).width + 10;
          ctx.fillStyle = 'rgba(20,14,8,' + (0.7 + pulse * 0.25) + ')'; roundRect(ctx, cx - w / 2, ty - 8, w, 16, 4); ctx.fill();
          ctx.fillStyle = '#e3c578'; ctx.fillText(txt, cx, ty);
        }
        const guards = Math.round(a.site.guards || 0);
        if (guards > 0) {
          ctx.font = '700 10px Cinzel'; ctx.textAlign = 'center'; ctx.textBaseline = 'middle';
          const gtxt = '🛡' + guards; const gx = cx - 30 * scale, gy = cy + 30 * scale;
          const w = ctx.measureText(gtxt).width + 8;
          ctx.fillStyle = 'rgba(20,14,8,0.82)'; roundRect(ctx, gx - w / 2, gy - 7, w, 14, 4); ctx.fill();
          ctx.fillStyle = '#bcd3a0'; ctx.fillText(gtxt, gx, gy);
        }
      }
    }

    // Threat: pulse where opposing forces are present.
    const occ = occupancy(snap);
    for (const id in occ) {
      if (occ[id].BLUE && occ[id].RED) {
        const [cx, cy] = w2s(areas[id].x, areas[id].y);
        const pulse = 0.5 + 0.5 * Math.sin(Date.now() / 180);
        ctx.beginPath(); ctx.arc(cx, cy, (84 + pulse * 8) * scale, 0, Math.PI * 2);
        ctx.strokeStyle = 'rgba(220,70,50,' + (0.4 + pulse * 0.4) + ')'; ctx.lineWidth = 3; ctx.setLineDash([4, 7]); ctx.stroke(); ctx.setLineDash([]);
        if (Math.random() < 0.3) spawnClash(cx, cy);
      }
    }

    // Caravans.
    for (const team of ['BLUE', 'RED']) {
      for (const cv of snap.teams[team].caravans) {
        const [cx, cy] = w2s(cv.x, cv.y);
        ctx.save();
        // dust
        ctx.fillStyle = 'rgba(150,130,90,0.3)'; ctx.beginPath(); ctx.arc(cx - 8, cy + 6, 5, 0, Math.PI * 2); ctx.fill();
        ctx.fillStyle = '#caa06a'; ctx.strokeStyle = PALETTE.ink; ctx.lineWidth = 1.5;
        roundRect(ctx, cx - 8, cy - 6, 16, 12, 2); ctx.fill(); ctx.stroke();
        ctx.fillStyle = (C.RESOURCE_META[cv.resource] || {}).color || '#fff';
        ctx.beginPath(); ctx.arc(cx, cy, 3, 0, Math.PI * 2); ctx.fill();
        // Status badge centred ABOVE the caravan so a guarded/escorted convoy reads at a glance.
        ctx.textAlign = 'center'; ctx.textBaseline = 'middle';
        if (cv.escort) { ctx.font = '14px serif'; ctx.fillStyle = teamCol(team, true); ctx.fillText('🛡', cx, cy - 14); }
        else if (cv.fleeing) { const pulse = 0.5 + 0.5 * Math.sin(Date.now() / 120); ctx.fillStyle = 'rgba(217,164,65,' + (0.6 + pulse * 0.4) + ')'; ctx.font = '13px serif'; ctx.fillText('🏃', cx, cy - 14); }
        else if (cv.guards > 0) {
          ctx.font = '14px serif'; ctx.fillStyle = '#cfe6b0'; ctx.fillText('🛡', cx, cy - 14);
          ctx.font = '700 8px Cinzel'; ctx.fillStyle = '#13301a'; ctx.fillText(Math.round(cv.guards), cx, cy - 13);  // guard count on the shield
        }
        ctx.restore();
      }
    }

    // Army groups. Server simulates at ~1 Hz, so we ease each host's drawn position toward its
    // latest snapshot position to make marches glide smoothly instead of jumping a leg per tick.
    const now = (typeof performance !== 'undefined' ? performance.now() : Date.now());
    const snapMs = (window.FP.Balance && window.FP.Balance.TICK_MS) || 1000;
    const tickChanged = snap.tick !== lastSnapTick;
    const seenHosts = {};
    for (const team of ['BLUE', 'RED']) {
      const groups = snap.teams[team].armies;
      const perArea = {};
      for (const g of groups) {
        const count = unitCount(g); if (count < 0.5) continue;
        const aId = g.moving ? null : g.area;
        let tx = g.x, ty = g.y;
        if (aId) { const k = aId; perArea[k] = (perArea[k] || 0); const o = perArea[k]++; tx += (o % 3) * 22 - 22; ty += Math.floor(o / 3) * 20 - 36; }
        seenHosts[g.id] = true;
        let sp = hostSmooth[g.id];
        if (!sp) { sp = hostSmooth[g.id] = { x: tx, y: ty, px: tx, py: ty, tx: tx, ty: ty, t0: now }; }
        if (tickChanged) { sp.px = sp.x; sp.py = sp.y; sp.tx = tx; sp.ty = ty; sp.t0 = now; }
        else { sp.tx = tx; sp.ty = ty; }   // keep target current if offset/selection shifts mid-tick
        const frac = Math.min(1, (now - sp.t0) / snapMs);
        sp.x = sp.px + (sp.tx - sp.px) * frac;
        sp.y = sp.py + (sp.ty - sp.py) * frac;
        const gx = sp.x, gy = sp.y;
        const [hcx, hcy] = w2s(gx, gy);
        if (team === myTeamR) hostHits.push({ id: g.id, cx: hcx, cy: hcy });
        else allHostHits.push({ id: g.id, cx: hcx, cy: hcy });
        drawHost(team, g, gx, gy, count);
      }
    }
    for (const id in hostSmooth) { if (!seenHosts[id]) delete hostSmooth[id]; }
    lastSnapTick = snap.tick;

    // Keep damage floats.
    for (const team of ['BLUE', 'RED']) {
      const hp = snap.teams[team].keep.hp;
      if (prevKeep[team] != null && hp < prevKeep[team] - 0.5) {
        const base = team === 'BLUE' ? areas.blue_base : areas.red_base;
        const [cx, cy] = w2s(base.x, base.y);
        floats.push({ x: cx, y: cy - 40, vy: -0.6, life: 1, text: '-' + Math.round(prevKeep[team] - hp), col: '#ff6a4a' });
      }
      prevKeep[team] = hp;
    }

    // Combat floaters: red "-N" over a host that lost N soldiers this round, and a "🛡 Saved!" badge
    // when someone's armour turned a killing blow. Sent per-tick by the server in snap.combatFx.
    if (tickChanged && snap.combatFx) {
      for (const e of snap.combatFx) {
        const [cx, cy] = w2s(e.x, e.y);
        if (e.losses > 0) floats.push({ x: cx, y: cy - 30, vy: -0.75, life: 1.15, text: '-' + e.losses, col: '#ff5a4a' });
        if (e.saves > 0) floats.push({ x: cx + 16, y: cy - 46, vy: -0.5, life: 1.5, text: '🛡 Saved!' + (e.saves > 1 ? ' ×' + e.saves : ''), col: '#8fd6ff' });
      }
    }

    drawParticles();
    drawFloats();
  }

  function drawHost(team, g, gx, gy, count) {
    const [cx, cy] = w2s(gx, gy);
    ctx.save();
    if (g.id === selHostId) { ctx.beginPath(); ctx.arc(cx, cy, 20 * scale + 6, 0, Math.PI * 2); ctx.strokeStyle = PALETTE.gold; ctx.lineWidth = 3; ctx.setLineDash([5, 4]); ctx.stroke(); ctx.setLineDash([]); }
    ctx.fillStyle = 'rgba(0,0,0,0.3)'; ctx.beginPath(); ctx.ellipse(cx, cy + 13, 15, 6, 0, 0, Math.PI * 2); ctx.fill();
    // banner shield
    ctx.fillStyle = teamCol(team, false); ctx.strokeStyle = PALETTE.ink; ctx.lineWidth = 2;
    ctx.beginPath(); ctx.moveTo(cx - 13, cy - 13); ctx.lineTo(cx + 13, cy - 13); ctx.lineTo(cx + 13, cy + 4); ctx.lineTo(cx, cy + 15); ctx.lineTo(cx - 13, cy + 4); ctx.closePath(); ctx.fill(); ctx.stroke();
    // dominant unit glyph
    const glyph = dominantGlyph(g);
    ctx.font = '13px serif'; ctx.textAlign = 'center'; ctx.textBaseline = 'middle'; ctx.fillStyle = '#fff'; ctx.fillText(glyph, cx, cy - 3);
    // count
    ctx.font = '700 11px Cinzel'; ctx.fillStyle = teamCol(team, true); ctx.strokeStyle = '#000'; ctx.lineWidth = 3;
    ctx.strokeText(Math.round(count), cx, cy + 22); ctx.fillText(Math.round(count), cx, cy + 22);
    // Deployment-energy bar under the host (host AVERAGE): green = fresh, yellow = tiring, red ≤30 (combat
    // penalty). Hidden at full so rested/garrison hosts don't clutter the map.
    const en = (typeof g.energy === 'number') ? g.energy : 100;
    if (en < 99) {
      const bw = 22 * scale, bx = cx - bw / 2, by = cy + 28;
      ctx.fillStyle = 'rgba(0,0,0,0.65)'; ctx.fillRect(bx - 1, by - 1, bw + 2, 5);
      ctx.fillStyle = en <= 30 ? '#d65050' : (en <= 55 ? '#d9a441' : '#6bbf5f');
      ctx.fillRect(bx, by, bw * Math.max(0, Math.min(1, en / 100)), 3);
    }
    if (g.mission && (g.mission.type === 'siege' || g.mission.type === 'raid')) { ctx.font = '11px serif'; ctx.fillText(g.mission.type === 'siege' ? '⚔️' : '🔥', cx + 13, cy - 12); }
    // Rearguard: an escort that peeled off its caravan to hold the enemy — flash a shield-and-swords badge so
    // the player sees the guard staying back to fight while the (now unguarded) caravan rolls on.
    if (g.rearguardUntil && g.rearguardUntil > curElapsed) {
      const pulse = 0.55 + 0.45 * Math.sin(Date.now() / 140);
      ctx.font = '12px serif'; ctx.globalAlpha = pulse; ctx.fillText('🛡', cx - 14, cy - 12); ctx.globalAlpha = 1;
    }
    ctx.restore();
  }

  function dominantGlyph(g) {
    let best = 'militia', bv = -1;
    for (const u of C.UNITS) { if ((g.units[u] || 0) > bv) { bv = g.units[u] || 0; best = u; } }
    return (C.UNIT_META[best] || {}).glyph || '⚔';
  }
  function unitCount(g) { let n = 0; for (const u of C.UNITS) n += g.units[u] || 0; return n; }

  function occupancy(snap) {
    const occ = {};
    for (const team of ['BLUE', 'RED']) for (const g of snap.teams[team].armies) {
      if (unitCount(g) < 0.5 || g.moving) continue;
      (occ[g.area] = occ[g.area] || {})[team] = true;
    }
    return occ;
  }

  function spawnClash(x, y) {
    for (let i = 0; i < 5; i++) { const a = Math.random() * Math.PI * 2, s = 1 + Math.random() * 2.5;
      particles.push({ x, y, vx: Math.cos(a) * s, vy: Math.sin(a) * s, life: 1, col: Math.random() < 0.5 ? '#ffcf6a' : '#ff7a4a', r: 2 + Math.random() * 2 }); }
    if (particles.length > 200) particles = particles.slice(-160);
  }
  function drawParticles() {
    for (let i = particles.length - 1; i >= 0; i--) { const p = particles[i]; p.x += p.vx; p.y += p.vy; p.life -= 0.04;
      if (p.life <= 0) { particles.splice(i, 1); continue; }
      ctx.globalAlpha = p.life; ctx.fillStyle = p.col; ctx.beginPath(); ctx.arc(p.x, p.y, p.r, 0, Math.PI * 2); ctx.fill(); }
    ctx.globalAlpha = 1;
  }
  function drawFloats() {
    for (let i = floats.length - 1; i >= 0; i--) { const f = floats[i]; f.y += f.vy; f.life -= 0.012;
      if (f.life <= 0) { floats.splice(i, 1); continue; }
      ctx.globalAlpha = Math.min(1, f.life * 1.5); ctx.font = '700 16px Cinzel'; ctx.textAlign = 'center';
      ctx.strokeStyle = '#000'; ctx.lineWidth = 3; ctx.strokeText(f.text, f.x, f.y); ctx.fillStyle = f.col; ctx.fillText(f.text, f.x, f.y); }
    ctx.globalAlpha = 1;
  }

  function areaAt(px, py, snap) {
    if (!snap) return null;
    const [wx, wy] = s2w(px, py);
    let best = null, bd = 1e9;
    for (const id in snap.areas) { const a = snap.areas[id]; const d = Math.hypot(a.x - wx, a.y - wy); if (d < bd && d < 90) { bd = d; best = id; } }
    return best;
  }
  // Hit-test the player's own host markers (px,py in CSS pixels). Returns host id or null.
  function hostAt(px, py) {
    const dx = px * dpr, dy = py * dpr; let best = null, bd = 1e9; const r = 20 * scale + 8;
    for (const h of hostHits) { const d = Math.hypot(h.cx - dx, h.cy - dy); if (d < bd && d < r) { bd = d; best = h.id; } }
    return best;
  }
  // Hit-test ANY host marker (either team) — for the click-to-inspect popup.
  function anyHostAt(px, py) {
    const dx = px * dpr, dy = py * dpr; let best = null, bd = 1e9; const r = 20 * scale + 8;
    for (const h of hostHits.concat(allHostHits)) { const d = Math.hypot(h.cx - dx, h.cy - dy); if (d < bd && d < r) { bd = d; best = h.id; } }
    return best;
  }

  window.FP.Render = { init, draw, areaAt, hostAt, anyHostAt, resize: () => { resize(); staticLayer = null; } };
})();
