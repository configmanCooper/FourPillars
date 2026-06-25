# Changelog

All notable changes to **Four Pillars of the Realm** are documented here.

The format is loosely based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/).
This project is a prototype and does not (yet) follow semantic versioning; entries are grouped by
development milestone, newest first.

## [Unreleased]

### Added
- **Expandable soldier roster in the Military Overview.** Each equipped unit type (swordsman,
  spearman, archer, cavalry, catapult) in *Army composition* now has an expand/collapse toggle that
  lists **every individual soldier** of that type — across all hosts — with their own weapon and
  armour quality. Militia (no weapon) has no toggle.
- **Per‑soldier individual gear.** Every soldier carries their own weapon, armour, and (for archers)
  bow + arrows, each with an individual **quality tier**. The Military Overview lists each soldier
  with their kit and shows each host's total **strength ⚔️ / defence 🛡**.
- **Per‑worker tools.** Every worker holds an individual tool whose quality boosts that worker's
  output (standard tool ≈ +10%), shown per worker in the UI.
- **Weapon degradation & re‑equip.** Each combat encounter gives a soldier's weapon a small chance
  to degrade or break (broken at the lowest tier); the Commander can **re‑equip** hosts from the
  armoury, and the AI does so automatically when better gear exists.
- **AI Lord strategic reservations.** The AI Lord now pursues goals and proactively **reserves**
  resources for the role that needs them (iron → Blacksmith at war, horses → Commander cavalry,
  stone → Lord walls, wood → Steward expansion), announces the reason in council, and is **strict**
  about granting access — relenting only for the reserved‑for role, a real emergency, genuine
  surplus, or to keep the forge running.
- **Steward logistics depth.** Steward AI auto‑balances the mine split between stone and iron by
  scarcity and responds to teammates' iron/stone requests by shifting focus.
- **GitHub Pages‑friendly client.** Asset paths are relative and Socket.IO falls back to a CDN when
  the page isn't served by the Node server, so the static client also runs on GitHub Pages. A
  lobby **⚙ Server connection** panel (plus a `?server=<url>` link and saved setting) lets the
  Pages client connect to a separately‑hosted server; on `*.github.io` it auto‑prompts for the URL.
- **Deploy configs.** `.github/workflows/pages.yml` publishes the static client (`public/` +
  `shared/`) to GitHub Pages on push; `render.yaml` one‑click‑deploys the whole app (client +
  realtime server) to Render.
- Headless/regression tests: `lord-reservations-check`, `commander-interdict-check`,
  `claim-hold-check`, `outpost-rules-check`, `forge-spec-check`, `forge-minigame-check`,
  `steward-logistics-check`, and `ui16`–`ui20`.

### Changed
- **Blacksmith specialisation is now per‑item.** Pick exactly one forgeable item (tools, spears,
  swords, bows, arrows, armour, or siege parts) to specialise in; it forges **10% faster**. (Replaces
  the three broad "Military / Economic / Siege Forge" focuses.)
- **Forging minigame target moves.** The yellow/green band now jumps to a new random position after
  every strike (both zones keep their size and green stays centred in yellow), so timing can't be
  memorised.
- **Outpost claiming requires a minimum 10‑wood instalment.** The Steward can still pay for an
  outpost in instalments, but must commit at least 10 🪵 at a time (or the remainder) — no dribbling
  one wood at a time.
- **Capturing a location now destroys its outpost.** The captor takes the ground but the working
  outpost (and its upgrades/stored cargo) is razed — they must build a brand‑new outpost (re‑claim,
  pay wood again) to work the site. The AI rebuilds outposts on captured land automatically.
- **Combat model reworked** to a per‑second resolution: each side rolls discrete casualties
  (0/1/2/3 kills, higher counts rarer) weighted by a host **strength comparison**, followed by an
  independent **armour save** per fallen soldier (≈10% standard → 30% legendary). Weapon and arrow
  quality add to power.
- **Caravan interdiction & defence AI.** Soldiers move ~2× caravan speed (all‑cavalry ~3×) and must
  stop to fight; lent **guards** can be overrun but buy the caravan time. The Commander maintains a
  fast **Outriders** harasser that holds the enemy's supply chokepoint and hunts caravans.
- **Forge & economy tuning.** Forge times roughly doubled (with longer Blacksmith contracts and
  mini‑game strikes to match), tool lifetime set to ~300s.

### Fixed
- **Reserved wood leaked to the Steward's outposts.** When the Lord reserved wood away from the
  Steward (e.g. for the Blacksmith), the AI Steward could still pay for outposts in instalments
  because it calls `sites.claim()` directly, bypassing the rationing gate in `applyAction`.
  `claim()` now enforces the hold itself (like forging and site upgrades), so a reservation truly
  blocks outpost funding unless the Steward has an access grant or the resource is reserved for it.
- **Commander "turtling" bug:** a single enemy host merely *adjacent* to the Keep used to
  force‑recall the **entire** army indefinitely, freezing all offence and letting enemy caravans run
  free. A full recall now requires a genuine assault (enemy on the Keep, walls falling, or a force
  large enough to storm it); lesser probes are met by **one** claimed defender while the rest keep
  raiding and interdicting. Across 10 all‑AI matches this raised the trailing side's win rate from
  ~0–1/10 to ~4/10 and shrank the average score gap dramatically.
- Militia‑upgrade double‑decrement during the individual‑gear refactor.
- Self‑healing gear reconciliation each tick so per‑host gear arrays and inventories never drift
  from unit/equipment counts.

## Milestone history

- **AI Lord resource reservations** — goal‑driven reservations + strict use‑access gating.
- **Steward logistics & expeditions** — caravan/guard/escort tension, supply chokepoints.
- **Individual gear refactor** — per‑soldier weapons/armour and per‑worker tools with quality.
- **Worker caps, storage limits, military UI** — population/housing model and army overview.
- **Initial prototype** — authoritative Node + Socket.IO server, 1 Hz sim, vanilla‑JS Canvas
  client, four co‑op roles (Lord / Steward / Blacksmith / Commander), 8 human/AI seats, economy,
  buildings, sites, caravans, army, sieges, dual victory conditions, comms/requests system, and
  full AI for every role on both teams.
