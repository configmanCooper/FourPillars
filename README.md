# Four Pillars of the Realm ⚔️

A **4-player co-op medieval kingdom strategy game** for the browser. Each player controls
one of four vital roles; the kingdom only thrives if all four cooperate. Play **solo**
(your three teammates + the whole enemy kingdom run as AI), or fill any of the **8 seats
(4 per team)** with humans or AI in any combination.

> Built as a focused, understandable‑in‑5‑minutes prototype — the complexity comes from
> players coordinating, not from menus.

**▶️ Hosted on GitHub Pages:** **https://configmancooper.github.io/FourPillars/**

> ⚠️ **Heads‑up about Pages:** GitHub Pages only serves *static files*. This game uses an
> **authoritative Node + Socket.IO server**, so the Pages site hosts the **client** but a live
> match still needs that server running somewhere (see *Hosting* below). Pages alone can't run a
> multiplayer game.

---

## The Four Pillars (roles)

| Role | Glyph | Responsibility |
|------|-------|----------------|
| **Lord** | 👑 | Town, worker allocation, buildings, population, kingdom **policy** (tempo). |
| **Steward** | 🧭 | Exploration, claiming resource **sites**, **caravans**, logistics. |
| **Blacksmith** | 🔨 | Forges weapons, armour, **bows & arrows**, tools, siege parts; timed **contracts**. |
| **Commander** | ⚔️ | Musters the **army**, missions (defend/raid/escort/siege), formations, **doctrine**. |

**Forced cooperation** (no role can win alone):
- The **Commander** can only field weak Militia without **recruits** (Lord) and **gear** (Blacksmith).
- **Archers** need both **Bows _and_ Arrows** from the Blacksmith.
- Most **stone / iron / horses** arrive via the **Steward's caravans**, which get ambushed
  unless the **Commander** sends an **escort**.
- The **Blacksmith** needs **iron** (caravans) to forge; the **Lord** needs wood/stone/iron to build.
- A live **Requests inbox + comms log** lets any teammate — **human or AI** — ask for and
  answer help (escort, iron, workers, weapons, recruits, defence). AI teammates both *send*
  and *answer* requests, and chatter so the council feels alive.

---

## Run it

Requirements: **Node.js 18+**.

```bash
npm install
npm run dev        # or: npm start
```

Then open **http://localhost:3100** in your browser.

- **Solo:** Create a realm → claim **one** seat → leave the rest as AI → **Begin**.
- **Co‑op / PvP:** Share the 4‑letter code. Friends open the same URL, **Join**, and claim seats.
  Open seats on either team are filled by AI. Multiple tabs on one machine work for testing.
- **Quick match** (≈12 min) is on by default; untick it for a full ≈45‑min match.

### Hosting

Because the simulation is server‑authoritative, **a live game needs the Node server running** — the
browser client (whether served locally or from GitHub Pages) connects back to it over Socket.IO.

- **GitHub Pages** (this repo): Pages publishes the **static client** at
  **https://configmancooper.github.io/FourPillars/**. To make it playable you must run the Node
  server somewhere reachable (any Node host — e.g. Render, Railway, Fly.io, Glitch — or your own
  machine) and point the client's socket at it: in `public/js/net.js`, change `io()` to
  `io('https://your-server-host')`. (The page also loads `/socket.io/socket.io.js` and
  `/shared/*.js`, which that server provides.) Without a reachable server the Pages site loads but
  can't start a match.
- **Single‑host (simplest):** run `npm start` on any Node host and share its URL — that one process
  serves both the client and the realtime server, so no extra configuration is needed.

### Tests / verification

```bash
npm run smoke                 # headless all-AI match must end with a winner
node test/socket-smoke.js     # end-to-end socket flow (server must be running)
node test/two-client.js       # two humans, different roles, same room
node test/pause-test.js       # single-human instant pause + multi-human vote
node test/browser-check.js    # Playwright: loads client, asserts no console errors
node test/ui2-check.js        # Playwright: advisor, guide, help modal, per-location build
```

---

## How a match flows

- **Early (0–20%)** — explore, claim nearby sites, raise farms/lumber/mine and a **Barracks**.
- **Mid (20–62%)** — forge gear, muster an army, run & protect caravans, raid the foe.
- **Late (62–100%)** — build a **Workshop** for siege, mass your **Grand Host**, break the enemy **Keep**.

**Victory:** destroy the enemy **Keep**, or hold the higher **Kingdom Score** when the timer ends.
Score = Keep HP + buildings + army strength + controlled sites + relics (always shown in the top bar).

---

## Architecture

Authoritative **Node + Express + Socket.IO** server simulating an in‑memory world at **1 tick/sec**
and broadcasting full JSON snapshots. A **vanilla‑JS + HTML5 Canvas** client renders the latest
snapshot and sends *intents* only — it never mutates game state. Shared **UMD** modules
(`constants`, `balance`, `schema`) are used by both server (`require`) and browser (`<script>`),
so there is **no build step** and client/server can't drift.

```
FourPillars/
  server.js                 # express + socket.io entry
  shared/                   # UMD modules used by BOTH server & client
    constants.js  balance.js  schema.js
  server/
    rooms.js  sim.js  rng.js
    systems/  economy buildings production sites army comms events ai victory
  public/
    index.html  style.css
    js/  net  state  render  ui  lobby  main
  test/  smoke  socket-smoke  two-client  browser-check
```

All balancing lives in `shared/balance.js` (production rates, costs, unit stats, combat
modifiers, match length, AI cadence, event frequency) — tune the game without touching logic.

### Multiplayer model
- Authoritative server; clients send intents → server validates (role‑gated) → updates → broadcasts.
- 8 seats (`BLUE`/`RED` × `LORD`/`STEWARD`/`BLACKSMITH`/`COMMANDER`), each `human` or `ai`.
- **Reconnect** via a persistent `clientId` in `localStorage`; on disconnect, **AI takes over**
  the seat and the player can reclaim it on return.
- Deterministic seeded RNG drives combat, events and AI for reproducibility.

### Combat (abstracted, no unit pathfinding)
Node/area map with BFS movement. When hostile hosts share an area, a battle round runs **once per
second**: each side rolls discrete casualties (0/1/2/3 kills, with higher counts increasingly rare)
weighted by a **strength comparison** of the two hosts. Strength is the sum of each soldier's
**individual** weapon & armour quality plus formation × stance × doctrine × morale and
anti‑cavalry / anti‑archer bonuses; archers also need **arrows** (whose quality adds power) and
**consume** them. Each soldier's **armour** then gets an independent **save roll** (≈10% standard →
30% legendary) to cheat death. Every combat encounter also gives a soldier's weapon a small chance
to **degrade or break** (replaced from the armoury when better gear exists). A host alone at the
enemy base sieges the **Keep** (catapults excel). Floating damage numbers, clash particles and
threat pulses visualise it.

---

## What's implemented
Lobby with 8 human/AI seats & reconnect • authoritative tick sim • full economy (workers,
food, growth, storage) • **per-location buildings** (each owned location has limited build
slots; effects are kingdom-wide but razed if the location is **captured**) • 9 buildings +
queue + policies • resource sites, exploration, claiming, upgrading, **caravans with ambush +
escort** • Blacksmith queue, equipment, **arrows**, contracts, specialization • army
muster/rally, missions, formations, stances, doctrine, **escorts**, **site capture** •
abstracted combat, sieges, Keep HP • world events • full AI for every role on both teams that
also uses the comms/request system • Kingdom Score + dual victory conditions • heraldic Canvas
rendering (terrain blobs, pennants, fog, units, caravans, particles, **per-node build-slot pips
& "AT RISK" badges**) • requests inbox, comms chat, event log, team council cards, contextual
map actions.

### Pause & voting
A human can **pause**. With one human it pauses instantly; with several it opens a **15-second
vote** (resolves early once everyone votes; majority Yes wins) and the initiator has a
**5-minute cooldown** before calling another pause vote. Resuming works the same way. The
simulation clock freezes while paused.

### Communication & "need a resource"
The Requests inbox + Comms log work across **any human/AI mix** — NPCs both send and answer
requests and chatter so the council feels alive. Each role's quick-ask bar only offers
**requests that make sense for that role** (e.g. the Lord asks the Steward for iron/horses or
the Commander to defend — it never offers to request the workers/recruits it produces itself).
Anyone can also broadcast **"we need more of resource X"**; it is routed to whichever *other*
role can best supply it (never back to you), and the top-bar resource chips have **role-aware
tooltips** explaining what the resource is for, how *you* get more, and whom to ask.

### Reading your kingdom at a glance
The top bar shows **population (cap), soldiers ⚔️, and recruits 🎖️** alongside resources, so any
role can see the army size. The Muster panel lists each unit's requirements and how many you can
currently build (disabled with a reason when you lack the recruits, gear, or buildings). **All
panels live-update while open** — build queue countdowns, affordability, slot counts, forge
progress and hold timers all refresh in place (no need to close and reopen).

### Rationing & strategic reservations (Lord resource control)
The **Lord** controls the treasury and can **reserve** any resource so only chosen roles may spend
it (the Lord's own building is always exempt) — reserved resources show a 🔒 on the top bar for
everyone. A blocked teammate (human or 🤖 AI) can **ask the Lord for permission** with a reason
("may I spend 🪵 wood — to forge bows?"); approving opens a timed **access window** while the
reservation itself stays in place. An **AI Lord** does this *deliberately*: it pursues goals and
proactively reserves the resources its plan depends on (iron for the Blacksmith at war, horses for
the Commander's cavalry, stone for its own walls, wood for the Steward's expansion), announces the
reason in council, and is **strict** about granting access — relenting only for the role it reserved
for, a real emergency (famine, the Keep in danger), genuine surplus, or to keep the forge running.

### In-game guidance (new-player help)
- A **🧙 Advisor** card (top-right) always shows the single most useful next action with a
  one-click button and a "because…" reason.
- A **Guide tab** shows your role mission, a live world-state summary, and 4–5 prioritized,
  clickable tips tailored to the current situation.
- A first-time **"How to Play (your role)"** modal (reopenable via **❔ Help**) teaches the goal,
  your duties, the per-location building model, and your best first action.
- The selection panel shows **"Buildings here — X/Y slots"** for any owned location, plus
  capture risk; the Build flow is **location-first** ("Building at …, N free slots", with a
  location picker and "razed on capture" warning).

### Population, workers, training & education
The **Lord** assigns population to jobs — Farmers, Woodcutters, Miners, Builders, **Students**
(need a School), **Trainers** (need a Barracks, max 2 per Barracks) — and can **Levy Soldiers**
(a *one-way* commitment of workers into the army's recruit pool). Re-idling workers costs a
**30-second reassignment cooldown** (only **5s for Educated** workers graduated from a School).
Population is capped by housing; **when soldiers die in combat the housing frees up** and new
workers grow back for the Lord to reassign.

The **Commander** turns recruits into troops by **Training** them at a Barracks: pick the
location and the unit type (spearman/archer/cavalry/…). Training takes time set by the number of
**Trainers** (the Lord supplies them) and consumes recruits + Blacksmith equipment. Trained units
appear at that Barracks for the Commander to move and deploy. So a strong army needs the Lord
(recruits + trainers + housing), the Blacksmith (gear), and the Commander (training + tactics).

### Smarter, characterful AI
Every AI role plays one of **four personalities** (e.g. Lord *the Builder / Warmonger / Cautious
/ Steady*; Commander *Wolf Banner / Iron Wall / Road Marshal / Hammer of Stone*) that shape its
worker split, build order, specialization, doctrine and risk appetite — shown on the council
cards. AIs pursue short- and medium-term **goals**, and when they can't self-supply they **send
the right request to the right teammate** (human or AI) and **chatter their intent** ("Out of
iron — Steward, send more!", "The Grand Host marches on the enemy Keep!"), so a human player
always sees what the team is doing and what it needs.

### Per‑soldier gear & per‑worker tools
Every **individual** soldier carries their own weapon, armour (and, for archers, bow + arrows),
each with its own **quality tier** (crude → standard → fine → masterwork → legendary); the Military
Overview lists each soldier with their kit, and shows every host's total **strength ⚔️ / defence 🛡**.
Higher‑quality weapons/arrows add power and better armour raises the save chance. Likewise every
**worker** holds an individual **tool** whose quality boosts that worker's output (a standard tool
≈ +10%), shown per worker in the UI. Tools **wear out** with use (~300s) and weapons can degrade in
battle, so the Blacksmith keeps forging and the Commander can **re‑equip** hosts from the armoury
to push the best available gear to the front.

## Placeholder / simplified for the MVP
- Sites auto‑work once claimed (no per‑site worker micro); "Need Workers" is a request/boost.
- Caravan combat is abstracted (ambush chance reduced by escorts / lent guards, who can be overrun).
- AI is heuristic (good enough to make the game playable, not optimal).
- No accounts, matchmaking, database, or persistence — rooms are in‑memory.

## Suggested next improvements
- Per‑site worker assignment & visible supply lines; richer caravan routing/decoys.
- Delta snapshots + client interpolation if player/host counts grow.
- More unit/equipment depth (crossbows, knights, plate tiers) once the core proves fun.
- Spectator UI, replays from the seeded RNG, and a short interactive tutorial per role.
- Balance pass to reduce first‑mover snowballing between evenly‑matched AI kingdoms.

---

*Design note:* this prototype began from a ChatGPT draft (Vite + Phaser + TypeScript) which was
reviewed by independent UI, graphics, gameplay and architecture passes. Their consensus —
adopted here — was to drop the build toolchain in favour of a vanilla‑JS Canvas client matching
the sibling games, tighten cross‑role dependencies, shorten the match, and add a first‑class
comms/requests system so human and AI teammates coordinate visibly.
