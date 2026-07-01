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

  // Selectable match lengths offered in the lobby dropdown.
  const MATCH_PRESETS = { quick: 15 * 60, standard: 45 * 60, extended: 90 * 60 };
  const DEFAULT_MATCH_PRESET = 'standard';


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
  const FOOD_PER_POP = 0.048;           // food eaten per person per sec (demand raised 20% — food matters)
  const FOOD_PER_SOLDIER = 0.036;       // upkeep per soldier per sec (demand raised 20%)
  const STARVE_DEATH_INTERVAL = 15;     // seconds of sustained starvation per famine death (1 random person)

  // Per-worker production per second (before tools/policy/building multipliers).
  const WORKER_YIELD = {
    farmer:     { food: 0.30 },
    woodcutter: { wood: 0.28 },
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

  // ---- Research (University) ----
  // The Lord assigns EDUCATED workers as Researchers at a University (max RESEARCHERS_PER_UNIVERSITY
  // each). Every RESEARCH_INTERVAL seconds each researcher yields 1 Research Point (RP). RP buy 3-tier
  // upgrades (each tier needs the previous). Effects are team-wide and permanent.
  const RESEARCHERS_PER_UNIVERSITY = 4;
  const RESEARCH_INTERVAL = 5;          // seconds per Research Point, per researcher (1 RP / 5s = 0.2/s)
  const RESEARCH_COOLDOWN = 30;         // seconds the Lord must wait after unlocking an upgrade before buying the next
  // Each upgrade: stat key + 3 tiers. tier.val is the CUMULATIVE effect at that tier; tier.rp + tier.cost
  // is what it takes to unlock it. (RP costs are the halved ladder 20 / 45 / 90.)
  const RESEARCH = {
    foundry:      { name: 'Foundry Mastery', glyph: '🔥', stat: 'forgeSpeed', unit: 'pct', desc: 'Forge faster',
      tiers: [{ rp: 20, cost: { iron: 20 }, val: 0.10 }, { rp: 45, cost: { iron: 40 }, val: 0.25 }, { rp: 90, cost: { iron: 70 }, val: 0.35 }] },
    logging:      { name: 'Logging Techniques', glyph: '🪵', stat: 'wood', unit: 'pct', desc: 'Woodcutters gather more',
      tiers: [{ rp: 20, cost: { wood: 30 }, val: 0.10 }, { rp: 45, cost: { wood: 60 }, val: 0.25 }, { rp: 90, cost: { wood: 100 }, val: 0.45 }] },
    mining:       { name: 'Deep-Vein Mining', glyph: '⛏️', stat: 'iron', unit: 'pct', desc: 'Miners produce more iron',
      tiers: [{ rp: 20, cost: { iron: 20 }, val: 0.10 }, { rp: 45, cost: { iron: 40 }, val: 0.25 }, { rp: 90, cost: { iron: 70 }, val: 0.45 }] },
    quarrying:    { name: 'Quarrying', glyph: '🪨', stat: 'stone', unit: 'pct', desc: 'Miners produce more stone',
      tiers: [{ rp: 20, cost: { stone: 30 }, val: 0.10 }, { rp: 45, cost: { stone: 60 }, val: 0.25 }, { rp: 90, cost: { stone: 100 }, val: 0.45 }] },
    agriculture:  { name: 'Crop Rotation', glyph: '🌾', stat: 'food', unit: 'pct', desc: 'Farmers grow more food',
      tiers: [{ rp: 20, cost: { food: 30 }, val: 0.10 }, { rp: 45, cost: { food: 60 }, val: 0.25 }, { rp: 90, cost: { food: 100 }, val: 0.45 }] },
    growth:       { name: 'Prosperity', glyph: '👶', stat: 'popGrowth', unit: 'pct', desc: 'Population grows faster',
      tiers: [{ rp: 20, cost: { food: 40 }, val: 0.25 }, { rp: 45, cost: { food: 80 }, val: 0.60 }, { rp: 90, cost: { food: 140 }, val: 1.00 }] },
    weapons:      { name: 'Weaponsmithing', glyph: '⚔️', stat: 'attack', unit: 'pct', desc: 'All soldiers hit harder',
      tiers: [{ rp: 20, cost: { iron: 25 }, val: 0.05 }, { rp: 45, cost: { iron: 50 }, val: 0.12 }, { rp: 90, cost: { iron: 90 }, val: 0.20 }] },
    armour:       { name: 'Plate Armour', glyph: '🛡️', stat: 'armorDef', unit: 'pct', desc: 'Armour protects better',
      tiers: [{ rp: 20, cost: { iron: 25 }, val: 0.10 }, { rp: 45, cost: { iron: 50 }, val: 0.25 }, { rp: 90, cost: { iron: 90 }, val: 0.35 }] },
    architecture: { name: 'Architecture', glyph: '🏠', stat: 'housing', unit: 'flat', desc: 'Each House holds more',
      tiers: [{ rp: 20, cost: { wood: 30, stone: 20 }, val: 2 }, { rp: 45, cost: { wood: 60, stone: 40 }, val: 4 }, { rp: 90, cost: { wood: 100, stone: 70 }, val: 6 }] },
    tower:        { name: 'Fortified Tower', glyph: '🗼', stat: 'towerAtk', unit: 'mult', desc: 'Watchtower fires harder',
      tiers: [{ rp: 45, cost: { stone: 70 }, val: 2 }, { rp: 90, cost: { stone: 120 }, val: 3 }] },
    siege:        { name: 'Siege Engineering', glyph: '🪨', stat: 'siege', unit: 'pct', desc: 'Catapults raze faster',
      tiers: [{ rp: 20, cost: { wood: 30, iron: 30 }, val: 0.15 }, { rp: 45, cost: { wood: 60, iron: 60 }, val: 0.35 }, { rp: 90, cost: { wood: 100, iron: 100 }, val: 0.50 }] },
    granaries:    { name: 'Granaries & Vaults', glyph: '📦', stat: 'storage', unit: 'flat', desc: 'Raise every storage cap',
      tiers: [{ rp: 20, cost: { stone: 30, wood: 30 }, val: 60 }, { rp: 45, cost: { stone: 60, wood: 60 }, val: 140 }, { rp: 90, cost: { stone: 100, wood: 100 }, val: 260 }] },
    scholarship:  { name: 'Scholarship', glyph: '🎓', stat: 'research', unit: 'pct', desc: 'Researchers work faster',
      tiers: [{ rp: 20, cost: { relics: 1 }, val: 0.25 }, { rp: 45, cost: { relics: 2 }, val: 0.60 }, { rp: 90, cost: { relics: 3 }, val: 1.20 }] },
    keephall:     { name: 'Keep Expansion', glyph: '🏯', stat: 'keepSlots', unit: 'flat', desc: 'Each tier adds a build slot to your Keep',
      // Each tier costs DOUBLE an outpost upgrade (wood 120 / stone 80) + Research Points + 1 Relic (artifact).
      tiers: [{ rp: 20, cost: { wood: 120, stone: 80, relics: 1 }, val: 1 }, { rp: 45, cost: { wood: 120, stone: 80, relics: 1 }, val: 2 }, { rp: 90, cost: { wood: 120, stone: 80, relics: 1 }, val: 3 }] },
    provisioning: { name: 'Field Provisioning', glyph: '🎒', stat: 'energyDrain', unit: 'pctreduce', desc: 'Soldiers tire more slowly on deployment',
      // A logistics lever (rations + supply wagons): permanently cuts deployment-energy DRAIN by 10/20/30%.
      // Priced like the mid economy lines — food (rations) + wood (wagons/roads); standard 20/45/90 RP curve.
      tiers: [{ rp: 20, cost: { food: 30, wood: 20 }, val: 0.10 }, { rp: 45, cost: { food: 60, wood: 40 }, val: 0.20 }, { rp: 90, cost: { food: 100, wood: 70 }, val: 0.30 }] },
  };

  // Building costs and effects. effect keys are read by systems.
  const BUILDINGS = {
    house:      { name: 'House',       cost: { wood: 50 },             buildTime: 18, effect: { housing: HOUSING_PER_HOUSE } },
    farm:       { name: 'Farm',        cost: { wood: 60 },             buildTime: 21, effect: { foodMult: 0.25 } },
    lumberCamp: { name: 'Lumber Camp', cost: { wood: 50, stone: 20 },  buildTime: 21, effect: { woodMult: 0.40 } },
    mine:       { name: 'Mine',        cost: { wood: 60, stone: 40 },  buildTime: 27, effect: { mineMult: 0.40 } },
    storehouse: { name: 'Storehouse',  cost: { wood: 70, stone: 50 },  buildTime: 27, effect: { storage: STORAGE_PER_STOREHOUSE } },
    barracks:   { name: 'Barracks',    cost: { wood: 70, stone: 30 },  buildTime: 30, effect: { unlock: 'train' } },
    school:     { name: 'School',      cost: { wood: 70, stone: 40 },  buildTime: 30, effect: { unlock: 'educate' } },
    stables:    { name: 'Stables',     cost: { wood: 90, stone: 50, iron: 20 }, buildTime: 36, effect: { unlock: 'cavalry' } },
    workshop:   { name: 'Workshop',    cost: { wood: 90, iron: 40 },   buildTime: 36, effect: { unlock: 'siege' } },
    university: { name: 'University',   cost: { wood: 30, stone: 90, iron: 30 }, buildTime: 39, effect: { unlock: 'research' } },
    marketplace:{ name: 'Marketplace',  cost: { wood: 80, stone: 60 },  buildTime: 33, effect: { unlock: 'trade' } },
    walls:      { name: 'Walls',       cost: { stone: 120 },           buildTime: 39, effect: { keepDef: 60, keepHp: 120 } },
    // The Keep's core. Always present, occupies a build slot, can't be built or demolished. It is the
    // LAST thing razed in a siege (only after every other building falls) and its fall = total defeat.
    // It looses arrows like a lone militia at besiegers.
    watchtower: { name: 'Watchtower',   cost: {}, buildTime: 0, fixed: true, effect: {} },
  };
  const MAX_PER_BUILDING = { house: 6, farm: 4, lumberCamp: 4, mine: 3, storehouse: 3, barracks: 2, school: 2, stables: 2, workshop: 2, university: 1, marketplace: 1, walls: 3, watchtower: 1 };
  // Demolishing a building you own refunds this fraction of its base cost and frees its build slot.
  const DEMOLISH_REFUND = 0.25;

  // Per-location build slots: your Keep is roomy; outposts are small, so expansion matters.
  const BUILD_SLOTS_BASE = 7;
  const BUILD_SLOTS_SITE = 5;
  const MAX_SITE_LEVEL = 3;        // outposts upgrade at most to level 3 (so build slots cap at BUILD_SLOTS_SITE + 2)
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
  const EXPLORE_TIME = 6;               // seconds to fully scout an area at FULL scout strength (8 scouts)
  // Scouting (Steward-assigned Scout workers). Speed scales with the number of scouts: SCOUT_FULL
  // scouts = EXPLORE_TIME; 1 scout takes SCOUT_FULL× as long. Scouted areas without an outpost lapse
  // back to unscouted after SCOUT_DECAY_SEC. Soldiers fighting in an UNSCOUTED area fight worse.
  const SCOUT_MAX = 8;                  // most scouts the Steward can field
  const SCOUT_FULL = 8;                 // scouts that scout at EXPLORE_TIME speed (the old single-scout speed)
  const SCOUT_DECAY_SEC = 300;          // an unowned scouted area lapses to unscouted after this long
  const UNSCOUTED_COMBAT_PENALTY = 0.2; // -20% attack AND defence for soldiers fighting in an unscouted area
  const CLAIM_TIME = 8;                 // seconds to claim a SCOUTED neutral site (you must scout it first)
  const CLAIM_COST = { wood: 60, stone: 40 };
  const CLAIM_MIN_INSTALMENT = 10;      // the Steward must commit at least this much of each resource per instalment

  // CARAVAN MODES (Steward, per outpost): govern caravans LEAVING this outpost.
  //  • Standard — balanced.
  //  • Fast — +50% speed, but ~20%/s chance to spill 1 cargo on the road (only 5%/s for precious relics).
  //  • Cautious — −50% speed, but a 25% chance to slip past enemy soldiers that catch it.
  const CARAVAN_MODES = {
    standard: { name: 'Standard', speedMult: 1.0,                                          desc: 'Balanced caravans.' },
    fast:     { name: 'Fast',     speedMult: 1.5, dropChance: 0.2, relicDropChance: 0.05,  desc: '+50% speed, but ~20%/s chance to spill 1 cargo on the road (5%/s for relics).' },
    cautious: { name: 'Cautious', speedMult: 0.5, sneak: 0.25,                             desc: '−50% speed, but a 25% chance to slip past enemy soldiers that catch it.' },
  };
  // WORK MODES (Steward, per outpost): trade the location's production against how fast its buildings
  // can be razed by a besieger.
  //  • Standard — balanced.
  //  • Defensive — −25% production, but buildings & the outpost here take 50% LONGER to raze.
  //  • Maximum Production — +25% production, but buildings here are razed 50% FASTER.
  const WORK_MODES = {
    standard:      { name: 'Standard',           production: 1.0,  razeMult: 1.0,  desc: 'Balanced output and defences.' },
    defensive:     { name: 'Defensive',          production: 0.75, razeMult: 1.5,  desc: '−25% production; buildings here take 50% longer to raze.' },
    maxProduction: { name: 'Maximum Production',  production: 1.25, razeMult: 0.67, desc: '+25% production; buildings here are razed 50% faster.' },
  };
  const MODE_CHANGE_COOLDOWN = 180;     // seconds before an outpost's work/caravan mode may change again

  // ===== STEWARDSHIP =====
  // The Steward governs the realm through three levers: timed ACTIONS (spend goods/workers for a
  // temporary realm-wide bonus), a single standing POLICY (one permanent stance, swapped on a cooldown),
  // and — once the Lord builds a Marketplace — bartering goods. All bonuses stack ADDITIVELY into the
  // same multiplier pipeline as research: a consumer applies `rate *= (1 + stewardStat(team, stat))`.
  const STEWARD_ACTION_GLOBAL_CD = 60;  // after ANY action, this long before the Steward may take another
  const STEWARD_POLICY_CD = 180;        // seconds before the standing Stewardship policy may be swapped
  // Market barter (needs a Marketplace): every MARKET_TRADE_COOLDOWN seconds, swap IN of one commodity
  // for OUT of another (OUT_POLICY with the Merchant Charter policy). Commodities only — no relics/arrows.
  const MARKET_TRADE_COOLDOWN = 30;
  const MARKET_TRADE_IN = 20;
  const MARKET_TRADE_OUT = 10;
  const MARKET_TRADE_OUT_POLICY = 15;
  const MARKET_TRADE_RESOURCES = ['food', 'wood', 'stone', 'iron', 'horses'];
  // Supervise minigame (human Steward): a hidden token sits in a 4×4 grid; a correct click yields a small
  // bounty and re-hides it; a miss reveals it, then it shifts exactly one cell (any direction) and hides.
  const SUPERVISE_RESOURCES = ['food', 'wood', 'stone', 'iron'];
  const SUPERVISE_GRID = 4;
  const SUPERVISE_REWARD = 2;
  const SUPERVISE_MIN_INTERVAL_MS = 150; // wall-clock anti-spam (this minigame is human-only, off the sim clock)
  // Soft anti-farm cap: at most SUPERVISE_MAX_PER_WINDOW correct catches pay out per rolling window, so an
  // autoclicker can't turn the yard into an endless faucet — a human still earns a steady trickle.
  const SUPERVISE_WINDOW_MS = 60000;
  const SUPERVISE_MAX_PER_WINDOW = 20;

  const STEWARD_ACTIONS = [
    { id: 'fertility',       name: 'Fertility Decree',     glyph: '👶', cost: { food: 50 },           workers: 0, durationSec: 90,  cooldownSec: 240, effect: { popGrowth: 0.25 },                 desc: 'Population grows +25% faster.' },
    { id: 'postRoads',       name: 'Post Roads',           glyph: '🐎', cost: { wood: 40 },           workers: 0, durationSec: 210, cooldownSec: 360, effect: { caravanSpeed: 0.35 },             desc: 'All caravans move +35% faster.' },
    { id: 'forgeBellows',    name: 'Forge Bellows',        glyph: '🔥', cost: { iron: 25 },           workers: 0, durationSec: 120, cooldownSec: 300, effect: { forgeSpeed: 0.30 },               desc: 'The forge works +30% faster.' },
    { id: 'overseers',       name: "Overseers' Push",      glyph: '⛏️', cost: { food: 30 },           workers: 3, durationSec: 150, cooldownSec: 360, effect: { gatherAll: 0.25 },                desc: 'All gathering +25% (ties up 3 workers).' },
    { id: 'warDrills',       name: 'War Drills',           glyph: '⚔️', cost: { iron: 35 },           workers: 0, durationSec: 120, cooldownSec: 360, effect: { trainSpeed: 0.40 },               desc: 'Unit training markedly faster.' },
    { id: 'scholars',        name: "Scholars' Stipend",    glyph: '📜', cost: { food: 20, stone: 15 },workers: 0, durationSec: 150, cooldownSec: 360, effect: { researchRate: 0.50 },             desc: 'Research Points +50%.' },
    { id: 'pathfinders',     name: 'Pathfinders',          glyph: '🔭', cost: { wood: 25 },           workers: 2, durationSec: 120, cooldownSec: 300, effect: { scoutSpeed: 1.0 },                desc: 'Scouting twice as fast (ties up 2 workers).' },
    { id: 'musterLevy',      name: 'Muster the Levy',      glyph: '🛡️', cost: { food: 30, iron: 20 }, workers: 0, durationSec: 120, cooldownSec: 480, effect: { troopDef: 0.15 },                 desc: 'All troops +15% defence.' },
    { id: 'emergencyStores', name: 'Emergency Stores',     glyph: '📦', cost: { wood: 40, stone: 40 },workers: 0, durationSec: 200, cooldownSec: 400, effect: { storage: 75 },                    desc: 'Every storage cap +75.' },
    { id: 'rationing',       name: 'Rationing Edict',      glyph: '🍞', cost: { wood: 30 },           workers: 0, durationSec: 180, cooldownSec: 360, effect: { soldierUpkeep: -0.40 },           desc: 'Soldier food upkeep −40%.' },
    { id: 'rally',           name: 'Rally the Banners',    glyph: '🎺', cost: { food: 25, iron: 15 }, workers: 0, durationSec: 90,  cooldownSec: 400, effect: { armySpeed: 0.25 },                desc: 'Armies march +25% faster.' },
    { id: 'corvee',          name: 'Corvée Labour',        glyph: '🏗️', cost: { stone: 35 },          workers: 2, durationSec: 150, cooldownSec: 360, effect: { buildSpeed: 1.0 },                desc: 'Construction ~50% faster (ties up 2 workers).' },
    { id: 'grainLevy',       name: 'Grain Levy',           glyph: '🔄', cost: { food: 60 },           workers: 0, durationSec: 0,   cooldownSec: 480, instant: { wood: 30, stone: 30, iron: 20 }, desc: 'Trade 60 food for 30 wood + 30 stone + 20 iron, now.' },
    { id: 'learnRelics',     name: 'Learn from the Relics',glyph: '✨', cost: { relics: 1 },          workers: 0, durationSec: 180, cooldownSec: 600, instant: { rp: 50 }, effect: { popGrowth: 0.20, gatherAll: 0.20 }, desc: 'Gain 50 Research Points now, plus +20% growth & gathering.' },
    { id: 'fieldSupply',     name: 'Field Supply Train',   glyph: '🎒', cost: { food: 30 },           workers: 0, durationSec: 90,  cooldownSec: 300, effect: { energyDrain: 0.50 },              desc: 'Deployed soldiers tire half as fast for 90s.' },
  ];
  const STEWARD_ACTIONS_BY_ID = {};
  for (const a of STEWARD_ACTIONS) STEWARD_ACTIONS_BY_ID[a.id] = a;

  const STEWARD_POLICIES = {
    pol_food:     { name: 'Bountiful Fields', glyph: '🌾', effect: { gatherFood: 0.20 },   desc: '+20% food gathering & production.' },
    pol_wood:     { name: 'Forestry Charter', glyph: '🌲', effect: { gatherWood: 0.20 },   desc: '+20% wood gathering & production.' },
    pol_stone:    { name: 'Quarry Rights',    glyph: '⛰️', effect: { gatherStone: 0.20 },  desc: '+20% stone gathering & production.' },
    pol_iron:     { name: 'Mining Decree',    glyph: '⚒️', effect: { gatherIron: 0.20 },   desc: '+20% iron gathering & production.' },
    pol_horses:   { name: 'Horse Breeding',   glyph: '🐴', effect: { gatherHorses: 0.20 }, desc: '+20% horse production.' },
    pol_guard:    { name: 'Caravan Wardens',  glyph: '🛡️', effect: { guardStrength: 1.0 },  desc: 'Caravan guards fight twice as hard.' },
    pol_caravan:  { name: 'Swift Roads',      glyph: '💨', effect: { caravanSpeed: 0.50 },  desc: '+50% caravan speed.' },
    pol_growth:   { name: 'Welfare Doctrine', glyph: '👶', effect: { popGrowth: 0.25 },     desc: '+25% population growth.' },
    pol_buildcost:{ name: 'Thrifty Builders', glyph: '🏚️', effect: { buildCost: -0.20 },    desc: '−20% building resource costs.' },
    pol_trade:    { name: 'Merchant Charter', glyph: '⚖️', effect: { marketBonus: 1 },      desc: 'Market trades return 15 instead of 10.' },
  };
  // Map a resource name to its per-resource gather stat key (e.g. 'food' -> 'gatherFood').
  function gatherStatKey(res) { return 'gather' + res.charAt(0).toUpperCase() + res.slice(1); }
  // ===== /STEWARDSHIP =====

  // Dangerous home labour (Steward): a gather pool may be worked dangerously for +50% output, but each
  // such worker has a per-second chance to die. A tool mitigates it (Standard ≈1%, Legendary ≈0.3%,
  // untooled/awful = the full base) and tools used by dangerous crews wear out twice as fast.
  const DANGER_YIELD_BONUS = 0.5;       // +50% output for a dangerous pool
  const DANGER_DEATH_BASE = 0.02;       // per worker per second, untooled
  const DANGER_DEATH_TOOLED = 0.01;     // per worker per second at Standard tool, scaled by /toolQuality (capped at BASE)
  const DANGER_TOOL_WEAR_MULT = 2;      // dangerous crews chew through tools twice as fast
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
  const GUARD_KILL_PER = 0.25;          // enemy units a committed guard can cut down (militia-grade; deliberately weak)
  const GUARD_LOSS_PER = 0.7;           // guards lost per enemy unit faced in a caravan skirmish
  const GUARD_PIN_SECONDS = 4;          // attackers must STOP this long to fight a caravan's guards (buys the caravan time)
  // Hosts march at a multiple of caravan speed, so they can run down a fleeing caravan after breaking its
  // guards — infantry ~2x, an all-cavalry host ~3x.
  const HOST_SPEED_MULT = 2;
  const CAVALRY_SPEED_MULT = 3;
  const PURSUIT_CATCH_RADIUS = 30;      // world-units: a pursuer this close runs the caravan down
  const PURSUIT_TIMEOUT = 22;           // seconds before pursuers give up the chase

  // Steward expeditions: timed ventures that commit workers for a big, targeted payout (with risk).
  // Expeditions: timed ventures that pay a big reward but a crew may not return. Only
  // EXPEDITION_OFFER_COUNT are offered at once; the offer set rotates through the pool every
  // EXPEDITION_ROTATE_SEC seconds. Committing tools (1/worker) lowers the crew-loss risk.
  const EXPEDITION_OFFER_COUNT = 5;
  const EXPEDITION_ROTATE_SEC = 120;
  const EXPEDITIONS = [
    { id: 'timberRun',   name: 'Great Timber Run',   requires: { building: 'lumberCamp' }, workers: 3, time: 80,  reward: { wood: 140 },           risk: 0.12, desc: 'Fell a distant forest for a wood windfall.' },
    { id: 'oreSurvey',   name: 'Deep Ore Survey',    requires: { site: ['mountain', 'hills'] }, workers: 3, time: 105, reward: { iron: 90, stone: 45 }, risk: 0.20, desc: 'Mine a rich vein — needs a claimed Mountain or Quarry outpost.' },
    { id: 'grandHunt',   name: 'Grand Hunt',         requires: { site: 'plains' },  workers: 2, time: 75,  reward: { food: 130, horses: 8 }, risk: 0.10, desc: 'A great hunt across the plains.' },
    { id: 'relicDig',    name: 'Relic Excavation',   requires: { site: 'ruins' },   workers: 4, time: 125, reward: { relics: 4, iron: 40 },  risk: 0.25, desc: 'Excavate ancient ruins for relics.' },
    { id: 'merchantRun', name: 'Merchant Venture',   requires: { building: 'storehouse' }, workers: 2, time: 95,  reward: { wood: 70, stone: 70, iron: 45 }, risk: 0.10, desc: 'Trade abroad — needs a Storehouse.' },
    { id: 'loggingCamp', name: 'Logging Expedition', requires: { building: 'lumberCamp' }, workers: 4, time: 110, reward: { wood: 200 },           risk: 0.15, desc: 'A long haul into deep timberland.' },
    { id: 'quarryDig',   name: 'Quarry Dig',         requires: { site: ['hills', 'mountain'] }, workers: 3, time: 90,  reward: { stone: 150 },          risk: 0.14, desc: 'Open a fresh quarry face for stone.' },
    { id: 'ironVein',    name: 'Iron Vein',          requires: { building: 'mine' }, workers: 3, time: 100, reward: { iron: 120 },           risk: 0.18, desc: 'Chase a rich iron seam underground.' },
    { id: 'harvestRun',  name: 'Bountiful Harvest',  requires: { building: 'farm' }, workers: 2, time: 70,  reward: { food: 160 },           risk: 0.08, desc: 'Bring in a record harvest from afar.' },
    { id: 'wildHorses',  name: 'Wild Horse Drive',   requires: { site: 'plains' },  workers: 3, time: 95,  reward: { horses: 18 },          risk: 0.16, desc: 'Round up a herd of wild horses.' },
    { id: 'forageRun',   name: 'Forager\'s Trek',     requires: {},                  workers: 2, time: 65,  reward: { food: 90, wood: 50 },  risk: 0.10, desc: 'Send foragers into the wilds for food & wood.' },
    { id: 'prospect',    name: 'Prospecting Party',  requires: {},                  workers: 3, time: 100, reward: { stone: 80, iron: 60 }, risk: 0.18, desc: 'Prospect unclaimed land for ore.' },
    { id: 'ruinRaid',    name: 'Ruin Raid',          requires: { site: 'ruins' },   workers: 3, time: 110, reward: { relics: 3, stone: 50 }, risk: 0.22, desc: 'Raid crumbling ruins for relics.' },
    { id: 'oldVault',    name: 'The Old Vault',      requires: { site: 'ruins' },   workers: 5, time: 150, reward: { relics: 6, iron: 60 },  risk: 0.30, desc: 'Crack a sealed vault — high risk, high relics.' },
    { id: 'tradeCaravan', name: 'Trade Caravan',     requires: { building: 'storehouse' }, workers: 3, time: 105, reward: { wood: 90, stone: 90, food: 60 }, risk: 0.12, desc: 'A laden caravan to distant markets.' },
    { id: 'saltRoute',   name: 'Salt Route',         requires: { building: 'storehouse' }, workers: 2, time: 85,  reward: { food: 120, stone: 40 }, risk: 0.10, desc: 'Run the old salt road for food & stone.' },
    { id: 'mountainPass', name: 'Mountain Pass',     requires: { site: 'mountain' }, workers: 4, time: 130, reward: { iron: 140, stone: 70 }, risk: 0.24, desc: 'Brave the high pass for mountain ore.' },
    { id: 'deepForest',  name: 'Deep Forest March',  requires: { site: 'forest' },  workers: 3, time: 95,  reward: { wood: 160, food: 40 },  risk: 0.14, desc: 'March into old-growth forest.' },
    { id: 'fenHarvest',  name: 'Fenland Harvest',    requires: { site: 'farmland' }, workers: 2, time: 70,  reward: { food: 150, horses: 4 }, risk: 0.09, desc: 'Work the rich fenland soil.' },
    { id: 'gemCache',    name: 'Hidden Gem Cache',   requires: { site: ['mountain', 'hills'] }, workers: 4, time: 135, reward: { relics: 3, iron: 70 }, risk: 0.26, desc: 'Dig out a rumoured gem cache.' },
    { id: 'longHunt',    name: 'The Long Hunt',      requires: { site: ['plains', 'forest'] }, workers: 3, time: 100, reward: { food: 180, horses: 6 }, risk: 0.15, desc: 'A long hunt across plains and wood.' },
    { id: 'frontierFarm', name: 'Frontier Farmstead', requires: { building: 'farm' }, workers: 4, time: 120, reward: { food: 220 },           risk: 0.13, desc: 'Settle a frontier farmstead for a huge yield.' },
    { id: 'oreCaravan',  name: 'Ore Caravan',        requires: { building: 'mine' }, workers: 4, time: 125, reward: { iron: 110, stone: 90 }, risk: 0.20, desc: 'Haul a heavy ore caravan home.' },
    { id: 'horseFair',   name: 'Horse Fair',         requires: { building: 'stables' }, workers: 2, time: 80,  reward: { horses: 22 },          risk: 0.12, desc: 'Trade at a distant horse fair.' },
    { id: 'warSupplies', name: 'War Supplies Run',   requires: { building: 'barracks' }, workers: 3, time: 100, reward: { iron: 90, wood: 70 },  risk: 0.16, desc: 'Gather raw materials for the war effort.' },
    { id: 'scholarTrek', name: 'Scholar\'s Trek',     requires: { building: 'school' }, workers: 2, time: 90,  reward: { relics: 2, food: 60 },  risk: 0.14, desc: 'Send scholars to recover lost knowledge.' },
    { id: 'siegeTimber', name: 'Siege Timber Haul',  requires: { building: 'workshop' }, workers: 4, time: 120, reward: { wood: 180, iron: 50 }, risk: 0.18, desc: 'Haul heavy timber for the war machines.' },
    { id: 'riverTrade',  name: 'River Trade',        requires: {},                  workers: 2, time: 75,  reward: { wood: 60, food: 70, stone: 40 }, risk: 0.10, desc: 'Trade down the river for mixed goods.' },
    { id: 'lostMine',    name: 'The Lost Mine',      requires: { site: 'mountain' }, workers: 5, time: 155, reward: { iron: 180, relics: 2 }, risk: 0.30, desc: 'Reopen a legendary lost mine.' },
    { id: 'pilgrimage',  name: 'Relic Pilgrimage',   requires: { site: 'ruins' },   workers: 3, time: 115, reward: { relics: 5 },            risk: 0.24, desc: 'A pilgrimage to gather sacred relics.' },
    { id: 'greatMarket', name: 'The Great Market',   requires: { building: 'storehouse' }, workers: 4, time: 140, reward: { wood: 100, stone: 100, iron: 80, food: 80 }, risk: 0.15, desc: 'A grand trading venture for everything.' },
  ];
  const EXPEDITION_COOLDOWN = 45;       // seconds after one finishes before the next may launch
  const EXPEDITION_TOOL_RISK_REDUCTION = 0.5;   // full tooling (1/worker) at Standard quality halves crew-loss risk
  const EXPEDITION_TOOL_REDUCTION_MAX = 0.8;    // cap on total risk reduction (legendary tools)


  // Blacksmith production. cost per unit; time seconds per unit (before forge speed). Forging is slow —
  // every item takes a real investment (the minigame strikes scale with this time).
  const RECIPES = {
    tools:      { cost: { wood: 8, iron: 4 },  time: 8,  batch: 5 },
    spears:     { cost: { wood: 6, iron: 3 },  time: 6,  batch: 5 },
    swords:     { cost: { iron: 8 },           time: 10, batch: 4 },
    bows:       { cost: { wood: 10 },          time: 8,  batch: 5 },
    arrows:     { cost: { wood: 4 },           time: 4,  batch: 12, isResource: true },
    armor:      { cost: { iron: 12 },          time: 14, batch: 3 },
    siegeParts: { cost: { wood: 20, stone: 5, iron: 10 }, time: 11, batch: 1, needs: 'siege' },
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
    cavalry:   { atk: 6, def: 4, speed: 120, vsKeep: 0.6, isCav: true, upkeep: 1.5 },
    catapult:  { atk: 12, def: 1, speed: 45, vsKeep: 8,   upkeep: 2 },
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
  const ARCHER_OUTPOST_BONUS = 1.25;    // archers fight +25% when stationed on their team's own outpost
  // Building razing: an unopposed enemy force destroys a location's buildings, walls first.
  const BUILDING_RAZE_HP = 60;          // base HP per building (≈ 1 archer in 60s)
  const RAZE_STAT = { catapult: 20, cavalry: 6, militia: 2.5, spearman: 2.5, swordsman: 2.5, archer: 1.25 }; // raze HP/sec each
  const WALL_RAZE_MULT = 2;             // walls take twice as long and must fall first
  const CATAPULT_WALL_RAZE_BONUS = 1.5; // catapults raze WALLS 50% faster (siege engines shine vs fortifications)
  const KEEP_RAZE_MULT = 2;             // buildings at the Keep take 100% longer
  const KEEP_DEFENDER_BONUS = 1.5;      // +50% combat effectiveness for defenders at their own Keep
  const MAX_UNITS_PER_AREA = 20;        // a team's effective force cap at any one location
  const RAZE_POINTS = 3;                // score per building razed (doubled at an enemy Keep)
  const KEEP_RAZE_POINTS = 6;
  const CAPTURE_AFTER_RAZE = 10;        // seconds to seize a non-Keep site once empty (no buildings) — doubled
                                        // from 5 so a bare/empty outpost is twice as durable (time to defend it)
  const ARCHER_ARROW_USE = 0.5;         // arrows consumed per archer per battle round
  const COMBAT_ROUND_LOSS = 0.12;       // (legacy) fraction of losing-side power converted to casualties per round
  // Per-second discrete combat: each engaged side rolls 0/1/2/3 kills/sec based on the strength share.
  const COMBAT_INTENSITY = 1.1;         // scales kill chance; even fight (~0.5 share) ≈ 0.8 kills/sec
  // Speed → attack cadence: a host's AVERAGE unit speed scales how often it lands blows. Faster troops
  // (cavalry, speed 120) strike more often; slow ones (catapults, speed 45) less. Bounded so it tilts a
  // fight without dominating it. The factor multiplies a side's ATTACK contribution (not its defence).
  const SPEED_COMBAT_REF = 70;          // reference speed (infantry) = no change
  const SPEED_COMBAT_MIN = 0.8;         // slowest hosts attack at 80% cadence
  const SPEED_COMBAT_MAX = 1.3;         // fastest hosts attack at 130% cadence
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
  // A catapult is BUILT from siege parts (it carries no forgeable weapon of its own); the others wield
  // a forged weapon whose individual quality scales their attack.
  const UNIT_WEAPON = { spearman: 'spears', swordsman: 'swords', archer: 'bows', cavalry: 'swords' };
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
    TICK_MS, FULL_MATCH_SECONDS, DEV_MATCH_SECONDS, DEV_MODE_DEFAULT, MATCH_PRESETS, DEFAULT_MATCH_PRESET, PHASE_BOUNDS,
    START_RESOURCES, STORAGE_BASE, STORAGE_PER_STOREHOUSE, WORKERS_PER_BUILDING,
    START_POP, START_HOUSING, HOUSING_PER_HOUSE, POP_GROWTH_PER_SEC, FOOD_PER_POP, FOOD_PER_SOLDIER, STARVE_DEATH_INTERVAL,
    WORKER_YIELD, TOOLS_BONUS, MINER_STONE_YIELD, MINER_IRON_YIELD, DEFAULT_MINE_FOCUS, AI_MINE_FOCUS_MIN, AI_MINE_FOCUS_MAX, TOOL_LIFETIME_SEC,
    TRAINERS_PER_BARRACKS, TRAIN_SECONDS_PER_UNIT, EDU_SECONDS, COOLDOWN_ORDINARY, COOLDOWN_EDUCATED,
    RESEARCHERS_PER_UNIVERSITY, RESEARCH_INTERVAL, RESEARCH_COOLDOWN, RESEARCH,
    DANGER_YIELD_BONUS, DANGER_DEATH_BASE, DANGER_DEATH_TOOLED, DANGER_TOOL_WEAR_MULT,
    BUILDINGS, MAX_PER_BUILDING, DEMOLISH_REFUND, POLICIES,
    BUILD_SLOTS_BASE, BUILD_SLOTS_SITE, MAX_SITE_LEVEL, SITE_WALL_RESIST, CAPTURE_TIME_BASE, CAPTURE_DECAY,
    SITE_YIELD, SITE_UPGRADE_COST, SITE_UPGRADE_MULT, EXPLORE_TIME, CLAIM_TIME, CLAIM_COST, CLAIM_MIN_INSTALMENT,
    SCOUT_MAX, SCOUT_FULL, SCOUT_DECAY_SEC, UNSCOUTED_COMBAT_PENALTY,
    WORK_MODES, CARAVAN_MODES, MODE_CHANGE_COOLDOWN, POP_FLOOR, EXPEDITIONS, EXPEDITION_COOLDOWN, EXPEDITION_OFFER_COUNT, EXPEDITION_ROTATE_SEC, EXPEDITION_TOOL_RISK_REDUCTION, EXPEDITION_TOOL_REDUCTION_MAX,
    STEWARD_ACTION_GLOBAL_CD, STEWARD_POLICY_CD, MARKET_TRADE_COOLDOWN, MARKET_TRADE_IN, MARKET_TRADE_OUT, MARKET_TRADE_OUT_POLICY, MARKET_TRADE_RESOURCES,
    SUPERVISE_RESOURCES, SUPERVISE_GRID, SUPERVISE_REWARD, SUPERVISE_MIN_INTERVAL_MS, SUPERVISE_WINDOW_MS, SUPERVISE_MAX_PER_WINDOW,
    STEWARD_ACTIONS, STEWARD_ACTIONS_BY_ID, STEWARD_POLICIES, gatherStatKey,
    CARAVAN_DISPATCH_CARGO, CARAVAN_DISPATCH_BY_RESOURCE, CARAVAN_WARN_SECONDS, CARAVAN_MIN_INTERVAL, CARAVAN_SPEED, ESCORT_PROTECT,
    GUARD_LEND_DEFAULT, GUARD_KILL_PER, GUARD_LOSS_PER, GUARD_PIN_SECONDS,
    HOST_SPEED_MULT, CAVALRY_SPEED_MULT, PURSUIT_CATCH_RADIUS, PURSUIT_TIMEOUT,
    RECIPES, BLACKSMITH_SPECS, SPEC_TIME_REDUCTION, SPEC_QUALITY_BONUS, SPEC_QUALITY_THRESHOLD, CONTRACTS, CONTRACT_OFFER_COUNT, CONTRACT_ROTATE_SEC, WEAPON_DEGRADE_CHANCE, QUALITY_LADDER,
    UNIT_STATS, EQUIP_TIER_MULT, ARMOR_DEF_BONUS, COUNTER_BONUS_PER, COUNTER_BONUS_MAX, ARCHER_OUTPOST_BONUS, FORMATIONS, STANCES, DOCTRINES, MILITARY_POLICIES, MILITARY_POLICY_DEFAULT, WALL_TROOP_BONUS, WALL_ARCHER_BONUS,
    BUILDING_RAZE_HP, RAZE_STAT, WALL_RAZE_MULT, CATAPULT_WALL_RAZE_BONUS, KEEP_RAZE_MULT, KEEP_DEFENDER_BONUS, MAX_UNITS_PER_AREA, RAZE_POINTS, KEEP_RAZE_POINTS, CAPTURE_AFTER_RAZE,
    QUALITY_TIERS, FORGE_ZONES, AI_QUALITY_DIST, UNIT_WEAPON, qualityTier, qualityById, rollQuality,
    ARCHER_ARROW_USE, COMBAT_ROUND_LOSS, COMBAT_INTENSITY, SPEED_COMBAT_REF, SPEED_COMBAT_MIN, SPEED_COMBAT_MAX, ARMOR_SAVE_BASE, ARMOR_SAVE_MAX, MORALE,
    KEEP_HP, KEEP_DEF, SCORE_WEIGHTS, RECRUITS_PER_UNIT, START_RECRUITS,
    EVENT_INTERVAL, AI_THINK_INTERVAL, AI_DIFFICULTY_INTERVAL,
  };
});
