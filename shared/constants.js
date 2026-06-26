/* Four Pillars of the Realm — shared constants (UMD: works in Node and browser). */
(function (root, factory) {
  const mod = factory();
  if (typeof module !== 'undefined' && module.exports) module.exports = mod;
  if (typeof window !== 'undefined') window.FP = Object.assign(window.FP || {}, { Constants: mod });
})(this, function () {
  'use strict';

  const ROLES = {
    LORD: 'LORD',
    STEWARD: 'STEWARD',
    BLACKSMITH: 'BLACKSMITH',
    COMMANDER: 'COMMANDER',
  };
  const ROLE_ORDER = [ROLES.LORD, ROLES.STEWARD, ROLES.BLACKSMITH, ROLES.COMMANDER];

  const ROLE_META = {
    LORD:       { name: 'Lord',       glyph: '👑', color: '#c4a35a', blurb: 'Town, workers, buildings, population. Sets the kingdom tempo.', difficulty: 'Easy',   firstRole: true },
    STEWARD:    { name: 'Steward',    glyph: '🧭', color: '#5fa86a', blurb: 'Exploration, resource sites, caravans. Feeds the war machine.', difficulty: 'Medium', firstRole: false },
    BLACKSMITH: { name: 'Blacksmith', glyph: '🔨', color: '#b8702f', blurb: 'Forges weapons, armour, arrows, tools, siege parts.',           difficulty: 'Medium', firstRole: false },
    COMMANDER:  { name: 'Commander',  glyph: '⚔️', color: '#9f3f3f', blurb: 'Army, missions, formations, escorts, sieges.',                  difficulty: 'Hard',   firstRole: false },
  };

  const TEAMS = { BLUE: 'BLUE', RED: 'RED' };
  const TEAM_META = {
    BLUE: { name: 'Blue Kingdom', color: '#2f5f9f', light: '#8fb8e8', dark: '#1d3c66' },
    RED:  { name: 'Red Kingdom',  color: '#8b2500', light: '#d46a5a', dark: '#5c1800' },
  };

  const CONTROLLER = { HUMAN: 'human', AI: 'ai', OPEN: 'open' };
  // AI difficulty controls how often each AI role acts (see balance.AI_DIFFICULTY_INTERVAL).
  const AI_DIFFICULTIES = ['easy', 'medium', 'hard'];
  const AI_DIFFICULTY_DEFAULT = 'medium';

  const RESOURCES = ['food', 'wood', 'stone', 'iron', 'horses', 'arrows', 'relics'];
  const RESOURCE_META = {
    food:   { glyph: '🌾', name: 'Food',   cluster: 'Food',  color: '#c9a227' },
    wood:   { glyph: '🪵', name: 'Wood',   cluster: 'Build', color: '#8b6b3e' },
    stone:  { glyph: '🪨', name: 'Stone',  cluster: 'Build', color: '#9b9b93' },
    iron:   { glyph: '⛓️', name: 'Iron',   cluster: 'War',   color: '#b0b8c4' },
    horses: { glyph: '🐎', name: 'Horses', cluster: 'War',   color: '#a07b54' },
    arrows: { glyph: '🏹', name: 'Arrows', cluster: 'War',   color: '#cdbf8a' },
    relics: { glyph: '🏛️', name: 'Relics', cluster: 'Rare',  color: '#c66bd6' },
  };

  // Equipment made by the Blacksmith.
  const EQUIP = ['tools', 'spears', 'swords', 'bows', 'armor', 'siegeParts'];
  const EQUIP_META = {
    tools:      { glyph: '🛠️', name: 'Tools',       desc: 'Boosts worker productivity.' },
    spears:     { glyph: '🔱', name: 'Spears',      desc: 'Arms Spearmen (anti-cavalry).' },
    swords:     { glyph: '🗡️', name: 'Swords',      desc: 'Arms Swordsmen (balanced).' },
    bows:       { glyph: '🏹', name: 'Bows',        desc: 'Arms Archers (need arrows too).' },
    armor:      { glyph: '🛡️', name: 'Armour',      desc: 'Improves any unit\'s defence.' },
    siegeParts: { glyph: '🪚', name: 'Siege Parts', desc: 'Builds Catapults.' },
  };

  const UNITS = ['militia', 'spearman', 'swordsman', 'archer', 'cavalry', 'catapult'];
  const UNIT_META = {
    militia:   { glyph: '🪧', name: 'Militia',   needs: {} },
    spearman:  { glyph: '🔱', name: 'Spearman',  needs: { spears: 1 } },
    swordsman: { glyph: '🗡️', name: 'Swordsman', needs: { swords: 1 } },
    archer:    { glyph: '🏹', name: 'Archer',    needs: { bows: 1 } },
    cavalry:   { glyph: '🐎', name: 'Cavalry',   needs: { swords: 1, horses: 1 } },
    catapult:  { glyph: '🪨', name: 'Catapult',  needs: { siegeParts: 4 } },
  };

  const BUILDINGS = ['house', 'farm', 'lumberCamp', 'mine', 'storehouse', 'barracks', 'school', 'stables', 'workshop', 'university', 'walls', 'watchtower'];
  const TERRAIN = ['base', 'plains', 'forest', 'hills', 'mountain', 'river', 'farmland', 'ruins'];

  const PHASES = { EARLY: 'EARLY', MID: 'MID', LATE: 'LATE' };

  const REQUEST_TYPES = {
    ESCORT: 'ESCORT',           // Steward -> Commander
    GUARDS: 'GUARDS',           // Steward -> Commander: lend militia/recruits as caravan guards
    WORKERS: 'WORKERS',         // Steward -> Lord
    IRON: 'IRON',               // Blacksmith -> Steward
    EQUIPMENT: 'EQUIPMENT',     // Commander -> Blacksmith
    RECRUITS: 'RECRUITS',       // Commander -> Lord
    TRAINERS: 'TRAINERS',       // Commander -> Lord: assign Trainers at a Barracks
    DEFEND: 'DEFEND',           // anyone -> Commander
    TRAIN: 'TRAIN',             // Lord -> Commander: train a specific unit type
    MISSION: 'MISSION',         // Lord -> Commander: raid/siege/garrison a target
    SITE: 'SITE',               // Lord -> Steward: expand (explore/claim) or upgrade a site
    BUILD: 'BUILD',             // anyone -> Lord: construct a specific building
    NEED: 'NEED',               // anyone -> best role for payload.resource
    MINEFOCUS: 'MINEFOCUS',     // anyone -> Steward: shift the mine split toward stone or iron
    USE: 'USE',                 // anyone -> Lord: permission to spend a reserved resource (one-time)
    RESERVE: 'RESERVE',         // anyone -> Lord: reserve a resource for the requester for a while
  };
  // Which role can best supply a given resource (target of a NEED request).
  const RESOURCE_SUPPLIER = {
    food: 'LORD', wood: 'LORD', stone: 'LORD',
    iron: 'STEWARD', horses: 'STEWARD', arrows: 'BLACKSMITH', relics: 'STEWARD',
  };
  // Ordered list of roles that can supply each resource — used to avoid routing a
  // request back to the requester (pick the first supplier that isn't you).
  const RESOURCE_SUPPLIERS = {
    food: ['LORD', 'STEWARD'], wood: ['LORD', 'STEWARD'], stone: ['LORD', 'STEWARD'],
    iron: ['STEWARD', 'LORD'], horses: ['STEWARD'], arrows: ['BLACKSMITH'], relics: ['STEWARD'],
  };

  // Socket events
  const EV = {
    // client -> server
    CREATE_ROOM: 'create_room',
    JOIN_ROOM: 'join_room',
    SET_SLOT: 'set_slot',
    CLAIM_SLOT: 'claim_slot',
    SET_DIFFICULTY: 'set_difficulty',
    START_GAME: 'start_game',
    SUBMIT_ACTION: 'submit_action',
    CHAT: 'chat',
    REQUEST_SNAPSHOT: 'request_snapshot',
    PAUSE_REQUEST: 'pause_request',
    RESUME_REQUEST: 'resume_request',
    PAUSE_VOTE: 'pause_vote',
    // server -> client
    ROOM_UPDATE: 'room_update',
    LOBBY_UPDATE: 'lobby_update',
    GAME_STARTED: 'game_started',
    SNAPSHOT: 'state_snapshot',
    ACTION_RESULT: 'action_result',
    GAME_EVENT: 'game_event',
    GAME_OVER: 'game_over',
    ERROR_MSG: 'error_message',
  };

  return {
    ROLES, ROLE_ORDER, ROLE_META, TEAMS, TEAM_META, CONTROLLER, AI_DIFFICULTIES, AI_DIFFICULTY_DEFAULT,
    RESOURCES, RESOURCE_META, EQUIP, EQUIP_META, UNITS, UNIT_META,
    BUILDINGS, TERRAIN, PHASES, REQUEST_TYPES, RESOURCE_SUPPLIER, RESOURCE_SUPPLIERS, EV,
  };
});
