/* Four Pillars of the Realm — balance data (UMD). All tunable numbers live here. */
(function (root, factory) {
  const mod = factory();
  if (typeof module !== 'undefined' && module.exports) module.exports = mod;
  if (typeof window !== 'undefined') window.FP = Object.assign(window.FP || {}, { Balance: mod });
})(this, function () {
  'use strict';

  const TICK_MS = 1000;                 // server simulation step (1 Hz)
  const FULL_MATCH_SECONDS = 45 * 60;   // 45 min full match
  const DEV_MATCH_SECONDS = 12 * 60;    // 12 min dev match
  const DEV_MODE_DEFAULT = true;        // prototype defaults to short matches

  // Phase boundaries as fraction of match elapsed.
  const PHASE_BOUNDS = { MID: 0.20, LATE: 0.62 };

  // Starting shared resources per team.
  const START_RESOURCES = { food: 100, wood: 100, stone: 60, iron: 30, horses: 8, arrows: 0, relics: 0 };
  const STORAGE_BASE = 100;             // base storage cap per resource (build Storehouses to raise it)
  const STORAGE_PER_STOREHOUSE = 50;    // each Storehouse adds +50 to every resource's max
  const WORKERS_PER_BUILDING = 4;       // max 4 farmers/farm, woodcutters/lumber camp, miners/mine

  // Population.
  const START_POP = 16;
  const START_HOUSING = 20;
  const HOUSING_PER_HOUSE = 8;
  const POP_GROWTH_PER_SEC = 0.10;      // base, scaled by food surplus & policy (~1 person / 10s at full surplus)
  const FOOD_PER_POP = 0.04;            // food eaten per person per sec
  const FOOD_PER_SOLDIER = 0.03;        // upkeep per soldier per sec

  // Per-worker production per second (before tools/policy/building multipliers).
  const WORKER_YIELD = {
    farmer:     { food: 0.30 },
    woodcutter: { wood: 0.22 },
    miner:      { stone: 0.10, iron: 0.07 },
  };
  const TOOLS_BONUS = 0.10;             // a TOOLED worker yields +10% at Standard tool quality, scaling with quality (×equipQuality.tools): Good +12.5%, Excellent +20%, Legendary +30%
  // Miners are directed by the Steward between stone and iron. Per-resource yields are calibrated so
  // the default 40% iron focus reproduces the old simultaneous totals (0.6·0.1667≈0.10 stone, 0.4·0.175≈0.07 iron).
  const MINER_STONE_YIELD = 0.1667;
  const MINER_IRON_YIELD = 0.175;
  const DEFAULT_MINE_FOCUS = 0.4;       // fraction of miner labour on iron (rest on stone) by default
  const AI_MINE_FOCUS_MIN = 0.2;        // AI Steward keeps the split sane (never fully starves a resource)
  const AI_MINE_FOCUS_MAX = 0.8;
  const TOOL_LIFETIME_SEC = 300;        // an equipped tool-set wears out after ~300s (5 min) of use

  // Training (Commander-directed, at a Barracks; Lord supplies trainer labour).
  const TRAINERS_PER_BARRACKS = 2;      // each Barracks can host at most 2 trainers
  const TRAIN_SECONDS_PER_UNIT = 15;    // each trainer trains one recruit into a soldier in 15s (concurrent)
  // Education (Lord: assign Students at a School to create educated workers).
  const EDU_SECONDS = 30;               // each School educates one student at a time, 30s each
  const COOLDOWN_ORDINARY = 30;         // seconds a re-idled ordinary worker must wait before reassignment
  const COOLDOWN_EDUCATED = 5;          // educated workers reassign far faster

  // Building costs and effects. effect keys are read by systems.
  const BUILDINGS = {
    house:      { name: 'House',       cost: { wood: 50 },             buildTime: 12, effect: { housing: HOUSING_PER_HOUSE } },
    farm:       { name: 'Farm',        cost: { wood: 60 },             buildTime: 14, effect: { foodMult: 0.25 } },
    lumberCamp: { name: 'Lumber Camp', cost: { wood: 50, stone: 20 },  buildTime: 14, effect: { woodMult: 0.30 } },
    mine:       { name: 'Mine',        cost: { wood: 60, stone: 40 },  buildTime: 18, effect: { mineMult: 0.40 } },
    storehouse: { name: 'Storehouse',  cost: { wood: 70, stone: 50 },  buildTime: 18, effect: { storage: STORAGE_PER_STOREHOUSE } },
    barracks:   { name: 'Barracks',    cost: { wood: 70, stone: 30 },  buildTime: 20, effect: { unlock: 'train' } },
    school:     { name: 'School',      cost: { wood: 70, stone: 40 },  buildTime: 20, effect: { unlock: 'educate' } },
    stables:    { name: 'Stables',     cost: { wood: 90, stone: 50, iron: 20 }, buildTime: 24, effect: { unlock: 'cavalry' } },
    workshop:   { name: 'Workshop',    cost: { wood: 90, iron: 40 },   buildTime: 24, effect: { forgeSpeed: 0.35, unlock: 'siege' } },
    walls:      { name: 'Walls',       cost: { stone: 120 },           buildTime: 26, effect: { keepDef: 60, keepHp: 120 } },
    // The Keep's core. Always present, occupies a build slot, can't be built or demolished. It is the
    // LAST thing razed in a siege (only after every other building falls) and its fall = total defeat.
    // It looses arrows like a lone militia at besiegers.
    watchtower: { name: 'Watchtower',   cost: {}, buildTime: 0, fixed: true, effect: {} },
  };
  const MAX_PER_BUILDING = { house: 6, farm: 4, lumberCamp: 3, mine: 3, storehouse: 3, barracks: 2, school: 2, stables: 2, workshop: 2, walls: 3, watchtower: 1 };

  // Per-location build slots: your Keep is roomy; outposts are small, so expansion matters.
  const BUILD_SLOTS_BASE = 7;
  const BUILD_SLOTS_SITE = 5;
  const SITE_WALL_RESIST = 7;     // seconds added to capture time per Wall at a site
  const CAPTURE_TIME_BASE = 7;    // seconds an undefended owned site must be held by the enemy to fall
  const CAPTURE_DECAY = 2;        // how fast capture progress decays when no enemy present (per sec)

  // Lord policies (pick one). Multipliers applied in economy/production.
  const POLICIES = {
    prosperity: { name: 'Prosperity', popMult: 1.6, trainMult: 0.7, foodUse: 1.0, desc: 'Faster growth, slower army training.' },
    industry:   { name: 'Industry',   buildMult: 1.5, forgeMult: 1.3, foodUse: 1.25, popMult: 1.0, desc: 'Faster building & forging, hungrier.' },
    militarism: { name: 'Militarism', trainMult: 1.6, popMult: 0.7, foodUse: 1.0, desc: 'Faster training, slower growth.' },
  };

  // Resource sites (claimed by Steward). yield is added to caravan cargo per sec while claimed+worked.
  const SITE_YIELD = {
    forest:   { wood: 0.85 },
    hills:    { stone: 0.7 },
    mountain: { iron: 0.6 },
    farmland: { food: 1.0 },
    plains:   { horses: 0.2 },
    ruins:    { relics: 0.02 },
  };
  const SITE_UPGRADE_COST = { wood: 60, stone: 40 };
  const SITE_UPGRADE_MULT = 1.6;
  const EXPLORE_TIME = 6;               // seconds to reveal an area
  const CLAIM_TIME = 8;                 // seconds to claim a revealed neutral site
  const CLAIM_COST = { wood: 40 };
  const CLAIM_MIN_INSTALMENT = 10;      // the Steward must commit at least this much wood per instalment

  // Outpost work modes (Steward): trade safety for output. Worker loss only ever happens on PUSH at a
  // genuinely enemy-contested site, and is rare + capped + floored (see sites.js).
  const WORK_MODES = {
    cautious: { name: 'Cautious', yield: 0.7, lossPerSec: 0,     desc: 'Crews stay safe — 30% less cargo.' },
    standard: { name: 'Standard', yield: 1.0, lossPerSec: 0,     desc: 'Balanced output.' },
    push:     { name: 'Push',     yield: 1.7, lossPerSec: 0.012, desc: '+70% cargo, but crews at a CONTESTED outpost risk death.' },
  };
  const POP_FLOOR = 6;                  // never let worker-loss drop a team below this population

  // Caravans: carry accumulated cargo from a site to home base.
  const CARAVAN_DISPATCH_CARGO = 30;    // cargo threshold that auto-dispatches a caravan
  // Some goods ship in small, precious loads rather than waiting for a big pile — relics go one at a time.
  const CARAVAN_DISPATCH_BY_RESOURCE = { relics: 1 };
  const CARAVAN_WARN_SECONDS = 5;       // UI: flag a post this many seconds before its caravan departs
  const CARAVAN_MIN_INTERVAL = 12;      // min seconds between caravans from one site (no spam)
  const CARAVAN_SPEED = 45;             // world units per second along route (slow — easier to intercept)
  const ESCORT_PROTECT = 0.8;           // a Commander escort host fully shields a caravan from raiders

  // Caravan guards (Steward stations militia/recruits lent by the Commander at posts to protect their
  // caravans). Unguarded caravans that meet enemy troops are DESTROYED; guards fight to save them.
  // Guards are a ONE-WAY commitment — once lent they never return to the Commander's army.
  const GUARD_LEND_DEFAULT = 4;         // guards the Commander lends per GUARDS request
  const GUARD_KILL_PER = 0.5;           // enemy units a committed guard can cut down (militia-grade)
  const GUARD_LOSS_PER = 0.7;           // guards lost per enemy unit faced in a caravan skirmish
  const GUARD_PIN_SECONDS = 4;          // attackers must STOP this long to fight a caravan's guards (buys the caravan time)
  // Hosts march at a multiple of caravan speed, so they can run down a fleeing caravan after breaking its
  // guards — infantry ~2x, an all-cavalry host ~3x.
  const HOST_SPEED_MULT = 2;
  const CAVALRY_SPEED_MULT = 3;
  const PURSUIT_CATCH_RADIUS = 30;      // world-units: a pursuer this close runs the caravan down
  const PURSUIT_TIMEOUT = 22;           // seconds before pursuers give up the chase

  // Steward expeditions: timed ventures that commit workers for a big, targeted payout (with risk).
  const EXPEDITIONS = [
    { id: 'timberRun', name: 'Great Timber Run', requires: { building: 'lumberCamp' }, workers: 3, time: 80, reward: { wood: 140 }, risk: 0.12, desc: 'Fell a distant forest for a wood windfall.' },
    { id: 'oreSurvey', name: 'Deep Ore Survey', requires: { site: ['mountain', 'hills'] }, workers: 3, time: 105, reward: { iron: 90, stone: 45 }, risk: 0.2, desc: 'Mine a rich vein — needs a claimed Mountain or Quarry outpost.' },
    { id: 'grandHunt', name: 'Grand Hunt', requires: { site: 'plains' }, workers: 2, time: 75, reward: { food: 130, horses: 8 }, risk: 0.1, desc: 'A great hunt across the plains.' },
    { id: 'relicDig', name: 'Relic Excavation', requires: { site: 'ruins' }, workers: 4, time: 125, reward: { relics: 4, iron: 40 }, risk: 0.25, desc: 'Excavate ancient ruins for relics.' },
    { id: 'merchantRun', name: 'Merchant Venture', requires: { building: 'storehouse' }, workers: 2, time: 95, reward: { wood: 70, stone: 70, iron: 45 }, risk: 0.1, desc: 'Trade abroad — needs a Storehouse.' },
  ];
  const EXPEDITION_COOLDOWN = 45;       // seconds after one finishes before the next may launch

  // Blacksmith production. cost per unit; time seconds per unit (before forge speed). Forging is slow —
  // every item takes a real investment (the minigame strikes scale with this time).
  const RECIPES = {
    tools:      { cost: { wood: 8, iron: 4 },  time: 8,  batch: 5 },
    spears:     { cost: { wood: 6, iron: 3 },  time: 6,  batch: 5 },
    swords:     { cost: { iron: 8 },           time: 10, batch: 4 },
    bows:       { cost: { wood: 10 },          time: 8,  batch: 5 },
    arrows:     { cost: { wood: 4 },           time: 4,  batch: 12, isResource: true },
    armor:      { cost: { iron: 12 },          time: 14, batch: 3 },
    siegeParts: { cost: { wood: 30, iron: 20 },time: 24, batch: 1, needs: 'siege' },
  };
  // The Blacksmith specialises in ONE forgeable item — that item forges SPEC_TIME_REDUCTION (10%)
  // faster, AND a sub-par strike on it is lifted by SPEC_QUALITY_BONUS (the specialist's hands save a
  // rushed job): if the minigame score is under SPEC_QUALITY_THRESHOLD, quality is bumped +10%.
  // (Keyed by the item so blacksmithSpec stores the item name directly.)
  const SPEC_TIME_REDUCTION = 0.10;
  const SPEC_QUALITY_BONUS = 0.10;        // added to the score% on the specialised item …
  const SPEC_QUALITY_THRESHOLD = 0.80;    // … only when that score came in under 80%
  const BLACKSMITH_SPECS = {
    tools:      { name: 'Toolsmith',   item: 'tools',      glyph: '🛠️', desc: '🛠️ Tools forge 10% faster · +10% quality on sub-80% strikes.' },
    spears:     { name: 'Spearwright', item: 'spears',     glyph: '🔱', desc: '🔱 Spears forge 10% faster · +10% quality on sub-80% strikes.' },
    swords:     { name: 'Swordsmith',  item: 'swords',     glyph: '⚔️', desc: '⚔️ Swords forge 10% faster · +10% quality on sub-80% strikes.' },
    bows:       { name: 'Bowyer',      item: 'bows',       glyph: '🏹', desc: '🏹 Bows forge 10% faster · +10% quality on sub-80% strikes.' },
    arrows:     { name: 'Fletcher',    item: 'arrows',     glyph: '➷',  desc: '➷ Arrows forge 10% faster · +10% quality on sub-80% strikes.' },
    armor:      { name: 'Armourer',    item: 'armor',      glyph: '🛡️', desc: '🛡️ Armour forges 10% faster · +10% quality on sub-80% strikes.' },
    siegeParts: { name: 'Siegewright', item: 'siegeParts', glyph: '🏰', desc: '🏰 Siege parts forge 10% faster · +10% quality on sub-80% strikes.' },
  };
  // Forge contracts: timed bonus objectives that keep the Blacksmith active (times allow for slow
  // forging). Only CONTRACT_OFFER_COUNT are offered at once; the offer set rotates every
  // CONTRACT_ROTATE_SEC seconds through the whole pool. Goals are deliberately large — you must focus
  // the forge (and have the inputs) to finish one in time. Some are "mixed" (several items at once).
  const CONTRACT_OFFER_COUNT = 3;
  const CONTRACT_ROTATE_SEC = 60;
  const CONTRACTS = [
    // --- single-item drives (a lot of one thing) ---
    { id: 'armRaiders',   name: 'Arm the Raiders',    goal: { spears: 14 },             time: 200, reward: { iron: 45 } },
    { id: 'toolRush',     name: 'Tool Rush',          goal: { tools: 18 },              time: 220, reward: { wood: 70 } },
    { id: 'fillQuivers',  name: 'Fill the Quivers',   goal: { arrows: 72 },             time: 210, reward: { horses: 7 } },
    { id: 'plateOrder',   name: 'Plate Order',        goal: { armor: 10 },              time: 280, reward: { relics: 1, iron: 35 } },
    { id: 'swordOrder',   name: 'Sword Commission',   goal: { swords: 12 },             time: 230, reward: { iron: 50 } },
    { id: 'bowOrder',     name: 'Bowyer’s Bulk',      goal: { bows: 16 },               time: 220, reward: { wood: 65, horses: 4 } },
    { id: 'siegeComm',    name: 'Siege Commission',   goal: { siegeParts: 4 },          time: 300, reward: { relics: 2, stone: 60 } },
    { id: 'spearLevy',    name: 'Spear Levy',         goal: { spears: 22 },             time: 280, reward: { iron: 60, food: 40 } },
    { id: 'arrowStock',   name: 'Arrow Stockpile',    goal: { arrows: 120 },            time: 300, reward: { horses: 10, wood: 50 } },
    { id: 'toolColumns',  name: 'Tooling the Realm',  goal: { tools: 26 },              time: 300, reward: { wood: 100, stone: 40 } },
    { id: 'swordGuard',   name: 'Guard’s Swords',     goal: { swords: 18 },             time: 290, reward: { iron: 70, relics: 1 } },
    { id: 'heavyPlate',   name: 'Heavy Plate Run',    goal: { armor: 16 },              time: 320, reward: { relics: 2, iron: 50 } },
    // --- mixed orders (several items — harder, bigger rewards) ---
    { id: 'fullKit',      name: 'Full Kit',           goal: { swords: 8, armor: 6 },              time: 300, reward: { iron: 70, relics: 1 } },
    { id: 'skirmishKit',  name: 'Skirmisher’s Kit',   goal: { bows: 10, arrows: 60 },             time: 280, reward: { horses: 8, wood: 60 } },
    { id: 'frontline',    name: 'Frontline Order',    goal: { spears: 12, armor: 6 },             time: 300, reward: { iron: 65, food: 50 } },
    { id: 'raidPackage',  name: 'Raiding Package',    goal: { swords: 8, bows: 8 },               time: 280, reward: { iron: 55, wood: 55 } },
    { id: 'siegeTrain',   name: 'Siege Train',        goal: { siegeParts: 3, armor: 6 },          time: 330, reward: { relics: 2, stone: 70 } },
    { id: 'quartermast',  name: 'Quartermaster’s Run',goal: { tools: 12, spears: 10 },            time: 290, reward: { wood: 80, iron: 40 } },
    { id: 'armoryRun',    name: 'Armoury Resupply',   goal: { swords: 6, spears: 8, armor: 4 },   time: 320, reward: { iron: 80, relics: 1 } },
    { id: 'archersDream', name: 'Archer’s Dream',     goal: { bows: 12, arrows: 96 },             time: 320, reward: { horses: 12, wood: 70 } },
    { id: 'warForge',     name: 'War Forge',          goal: { spears: 10, swords: 8, bows: 8 },   time: 340, reward: { iron: 90, food: 60 } },
    { id: 'grandArsenal', name: 'Grand Arsenal',      goal: { swords: 10, armor: 8, arrows: 60 }, time: 360, reward: { relics: 2, iron: 60 } },
    { id: 'campaignKit',  name: 'Campaign Kit',       goal: { tools: 10, bows: 8, arrows: 48 },   time: 320, reward: { wood: 90, horses: 6 } },
    { id: 'ironLegion',   name: 'Iron Legion',        goal: { swords: 12, armor: 10 },            time: 360, reward: { relics: 3, iron: 70 } },
  ];
  // Weapon wear: each combat encounter a soldier has a small chance to degrade one quality tier (a
  // weapon already at the lowest tier is destroyed). The Commander can re-equip from the armoury.
  const WEAPON_DEGRADE_CHANCE = 0.15;   // per soldier, once per combat encounter
  const QUALITY_LADDER = [0.5, 0.75, 1.0, 1.25, 2.0, 3.0];  // awful → legendary (degrade = step down)

  // Combat: base attack/defence per unit. Multiplied by equipment/formation/morale/doctrine.
  const UNIT_STATS = {
    militia:   { atk: 1, def: 1, speed: 70, vsKeep: 0.3, upkeep: 0.5 },
    spearman:  { atk: 2, def: 3, speed: 70, vsKeep: 0.5, upkeep: 1 },
    swordsman: { atk: 3, def: 3, speed: 70, vsKeep: 0.8, upkeep: 1 },
    archer:    { atk: 3, def: 1, speed: 75, vsKeep: 0.5, ranged: true, upkeep: 1 },
    cavalry:   { atk: 4, def: 2, speed: 120, vsKeep: 0.6, isCav: true, upkeep: 1.5 },
    catapult:  { atk: 1, def: 1, speed: 45, vsKeep: 8,   upkeep: 2 },
  };
  // Composition counters: per matching enemy soldier, a counter unit gains COUNTER_BONUS_PER strength,
  // capped at COUNTER_BONUS_MAX. Cavalry count enemy non-spear/non-cav units; spearmen count enemy cavalry.
  const COUNTER_BONUS_PER = 0.10;
  const COUNTER_BONUS_MAX = 0.50;
  const EQUIP_TIER_MULT = { basic: 1.0, advanced: 1.35 };
  const ARMOR_DEF_BONUS = 0.5;          // +50% def to units that have armour assigned
  const FORMATIONS = {
    line:      { name: 'Battle Line', atkMult: 1.0, defMult: 1.0, speedMult: 1.0 },
    shieldWall:{ name: 'Shield Wall', atkMult: 0.9, defMult: 1.3, speedMult: 0.8 },
  };
  const STANCES = {
    balanced:  { name: 'Balanced',  atkMult: 1.0, lossMult: 1.0 },
    aggressive:{ name: 'Aggressive',atkMult: 1.25, lossMult: 1.3 },
    cautious:  { name: 'Cautious',  atkMult: 0.85, lossMult: 0.7, retreat: true },
  };
  const DOCTRINES = {
    offensive: { name: 'Offensive Doctrine', atkMult: 1.2, desc: 'Stronger attacks & raids.' },
    defensive: { name: 'Defensive Doctrine', defMult: 1.25, keepDefMult: 1.3, desc: 'Tougher garrisons & walls.' },
    logistics: { name: 'Logistics Doctrine', speedMult: 1.3, escortMult: 1.4, desc: 'Faster troops, better escorts.' },
  };
  // Lord-set military stance (3-min cooldown). Slight, relevant combat tilts + an aggression bias
  // (-1 defensive … +1 aggressive) that nudges the Commander (AI or human via the Guide).
  const MILITARY_POLICIES = {
    aggressive: { name: 'Aggressive Stance', atkMult: 1.10, keepDefMult: 0.90, aggression: 1, desc: 'Troops attack +10%, but the Keep defends −10%. Press the enemy — raid, capture, and siege.' },
    balanced:   { name: 'Balanced Stance',   aggression: 0, desc: 'No combat modifiers. React to the battlefield — defend when threatened, strike when strong.' },
    defensive:  { name: 'Defensive Stance',  defMult: 1.12, keepDefMult: 1.20, atkMult: 0.93, aggression: -1, desc: 'Defence +12% and Keep +20%, but attacks −7%. Hold ground and protect your territory.' },
  };
  const MILITARY_POLICY_DEFAULT = 'balanced';
  // Walls fortify their location: defenders fight much harder, archers most of all (per wall, max 2).
  const WALL_TROOP_BONUS = 0.20;        // +20% combat effectiveness to all troops per wall
  const WALL_ARCHER_BONUS = 0.50;       // +50% combat effectiveness to archers per wall
  // Building razing: an unopposed enemy force destroys a location's buildings, walls first.
  const BUILDING_RAZE_HP = 60;          // base HP per building (≈ 1 archer in 60s)
  const RAZE_STAT = { catapult: 10, cavalry: 3, militia: 2, spearman: 2, swordsman: 2, archer: 1 }; // raze HP/sec each
  const WALL_RAZE_MULT = 2;             // walls take twice as long and must fall first
  const KEEP_RAZE_MULT = 2;             // buildings at the Keep take 100% longer
  const KEEP_DEFENDER_BONUS = 1.5;      // +50% combat effectiveness for defenders at their own Keep
  const MAX_UNITS_PER_AREA = 20;        // a team's effective force cap at any one location
  const RAZE_POINTS = 3;                // score per building razed (doubled at an enemy Keep)
  const KEEP_RAZE_POINTS = 6;
  const CAPTURE_AFTER_RAZE = 5;         // seconds to seize a non-Keep site once all its buildings are razed
  const ARCHER_ARROW_USE = 0.5;         // arrows consumed per archer per battle round
  const COMBAT_ROUND_LOSS = 0.12;       // (legacy) fraction of losing-side power converted to casualties per round
  // Per-second discrete combat: each engaged side rolls 0/1/2/3 kills/sec based on the strength share.
  const COMBAT_INTENSITY = 1.1;         // scales kill chance; even fight (~0.5 share) ≈ 0.8 kills/sec
  const ARMOR_SAVE_BASE = 0.10;         // armoured host saves a soldier 10% of the time at standard quality…
  const ARMOR_SAVE_MAX = 0.4;           // …scaling with armour quality (Legendary ×3 ≈ 30%), capped here
  const MORALE = { high: 1.1, normal: 1.0, low: 0.85 };

  // ---- Blacksmith forging quality (minigame for humans; rolled for AI). ----
  // Quality tier from the minigame score as a fraction of the perfect score. Ordered best→worst;
  // a tier applies when pct >= its `min`. Perfect (1.0) is Legendary. `mult` scales the item effect.
  const QUALITY_TIERS = [
    { id: 'legendary', name: 'Legendary', glyph: '🌟', mult: 3.0,  min: 1.0 },
    { id: 'excellent', name: 'Excellent', glyph: '✨', mult: 2.0,  min: 0.85 },
    { id: 'good',      name: 'Good',      glyph: '🔵', mult: 1.25, min: 0.65 },
    { id: 'standard',  name: 'Standard',  glyph: '⚪', mult: 1.0,  min: 0.40 },
    { id: 'poor',      name: 'Poor',      glyph: '🟠', mult: 0.75, min: 0.20 },
    { id: 'awful',     name: 'Awful',     glyph: '🔴', mult: 0.5,  min: 0.0 },
  ];
  // Minigame zones (fractions of the bar) and per-click scores.
  const FORGE_ZONES = { greenFrac: 1 / 16, yellowFrac: 1 / 6, scoreGreen: 5, scoreYellow: 2, scoreRed: 1 };
  // AI quality distribution by difficulty (per item forged; each column sums to 1).
  const AI_QUALITY_DIST = {
    hard:   { legendary: 0.02, excellent: 0.20, good: 0.40, standard: 0.20, poor: 0.10, awful: 0.08 },
    medium: { legendary: 0.01, excellent: 0.12, good: 0.32, standard: 0.25, poor: 0.16, awful: 0.14 },
    easy:   { legendary: 0.00, excellent: 0.04, good: 0.18, standard: 0.28, poor: 0.26, awful: 0.24 },
  };
  // The equipment item each unit type relies on (for applying weapon quality in combat).
  const UNIT_WEAPON = { spearman: 'spears', swordsman: 'swords', archer: 'bows', cavalry: 'swords', catapult: 'siegeParts' };
  function qualityTier(pct) { for (const t of QUALITY_TIERS) if (pct >= t.min) return t; return QUALITY_TIERS[QUALITY_TIERS.length - 1]; }
  function qualityById(id) { return QUALITY_TIERS.find((t) => t.id === id) || QUALITY_TIERS[3]; }
  function rollQuality(difficulty, r) { // r in [0,1)
    const dist = AI_QUALITY_DIST[difficulty] || AI_QUALITY_DIST.medium;
    let acc = 0; for (const t of QUALITY_TIERS) { acc += dist[t.id] || 0; if (r < acc) return t; }
    return QUALITY_TIERS[3];
  }

  // Keep / victory.
  const KEEP_HP = 1000;
  const KEEP_DEF = 80;                  // flat defence the attacker must overcome each round
  const SCORE_WEIGHTS = { keepHp: 1, buildings: 25, army: 1.5, sites: 60, relics: 50 };

  // Recruit -> soldier conversion when Commander forms a unit (uses recruits pool).
  const RECRUITS_PER_UNIT = 1;
  const START_RECRUITS = 3;

  // World events.
  const EVENT_INTERVAL = [35, 70];      // random seconds between events [min,max]

  // AI cadence (seconds between AI "think" passes per role).
  const AI_THINK_INTERVAL = 4;
  // Per-slot difficulty → seconds between that AI's actions. Default is 'medium'.
  const AI_DIFFICULTY_INTERVAL = { easy: 10, medium: 5, hard: 2 };

  return {
    TICK_MS, FULL_MATCH_SECONDS, DEV_MATCH_SECONDS, DEV_MODE_DEFAULT, PHASE_BOUNDS,
    START_RESOURCES, STORAGE_BASE, STORAGE_PER_STOREHOUSE, WORKERS_PER_BUILDING,
    START_POP, START_HOUSING, HOUSING_PER_HOUSE, POP_GROWTH_PER_SEC, FOOD_PER_POP, FOOD_PER_SOLDIER,
    WORKER_YIELD, TOOLS_BONUS, MINER_STONE_YIELD, MINER_IRON_YIELD, DEFAULT_MINE_FOCUS, AI_MINE_FOCUS_MIN, AI_MINE_FOCUS_MAX, TOOL_LIFETIME_SEC,
    TRAINERS_PER_BARRACKS, TRAIN_SECONDS_PER_UNIT, EDU_SECONDS, COOLDOWN_ORDINARY, COOLDOWN_EDUCATED,
    BUILDINGS, MAX_PER_BUILDING, POLICIES,
    BUILD_SLOTS_BASE, BUILD_SLOTS_SITE, SITE_WALL_RESIST, CAPTURE_TIME_BASE, CAPTURE_DECAY,
    SITE_YIELD, SITE_UPGRADE_COST, SITE_UPGRADE_MULT, EXPLORE_TIME, CLAIM_TIME, CLAIM_COST, CLAIM_MIN_INSTALMENT,
    WORK_MODES, POP_FLOOR, EXPEDITIONS, EXPEDITION_COOLDOWN,
    CARAVAN_DISPATCH_CARGO, CARAVAN_DISPATCH_BY_RESOURCE, CARAVAN_WARN_SECONDS, CARAVAN_MIN_INTERVAL, CARAVAN_SPEED, ESCORT_PROTECT,
    GUARD_LEND_DEFAULT, GUARD_KILL_PER, GUARD_LOSS_PER, GUARD_PIN_SECONDS,
    HOST_SPEED_MULT, CAVALRY_SPEED_MULT, PURSUIT_CATCH_RADIUS, PURSUIT_TIMEOUT,
    RECIPES, BLACKSMITH_SPECS, SPEC_TIME_REDUCTION, SPEC_QUALITY_BONUS, SPEC_QUALITY_THRESHOLD, CONTRACTS, CONTRACT_OFFER_COUNT, CONTRACT_ROTATE_SEC, WEAPON_DEGRADE_CHANCE, QUALITY_LADDER,
    UNIT_STATS, EQUIP_TIER_MULT, ARMOR_DEF_BONUS, COUNTER_BONUS_PER, COUNTER_BONUS_MAX, FORMATIONS, STANCES, DOCTRINES, MILITARY_POLICIES, MILITARY_POLICY_DEFAULT, WALL_TROOP_BONUS, WALL_ARCHER_BONUS,
    BUILDING_RAZE_HP, RAZE_STAT, WALL_RAZE_MULT, KEEP_RAZE_MULT, KEEP_DEFENDER_BONUS, MAX_UNITS_PER_AREA, RAZE_POINTS, KEEP_RAZE_POINTS, CAPTURE_AFTER_RAZE,
    QUALITY_TIERS, FORGE_ZONES, AI_QUALITY_DIST, UNIT_WEAPON, qualityTier, qualityById, rollQuality,
    ARCHER_ARROW_USE, COMBAT_ROUND_LOSS, COMBAT_INTENSITY, ARMOR_SAVE_BASE, ARMOR_SAVE_MAX, MORALE,
    KEEP_HP, KEEP_DEF, SCORE_WEIGHTS, RECRUITS_PER_UNIT, START_RECRUITS,
    EVENT_INTERVAL, AI_THINK_INTERVAL, AI_DIFFICULTY_INTERVAL,
  };
});
