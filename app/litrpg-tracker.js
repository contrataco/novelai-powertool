/**
 * LitRPG Tracker — detection, RPG data extraction, scan orchestration, lorebook sync.
 *
 * Detects LitRPG stories via regex + LLM, then extracts structured RPG data
 * (classes, levels, stats, abilities, quests, party, NPCs) from story text.
 * Data stored as structured JSON in SQLite, synced to lorebook text entries.
 */

const { extractField, getTemplateForType, retryLLM } = require('./lore-creator');
const { parseMetadata, setMetadata, getEntryType, METADATA_VERSION } = require('./metadata');
const { FUZZY_MATCH_THRESHOLD, fuzzyNameScore, recoverJSON, isNarratorPlaceholder } = require('./shared-utils');
const reader = require('./litrpg-story-reader');

const LOG_PREFIX = '[LitRPG]';

// --- Constants ---

const INTER_CALL_DELAY = 1000;
const MAX_STORY_CONTEXT = 4000;
const RECENT_CONTEXT = 6000;

// Character fields a hand edit protects from being overwritten by scans.
const MANUAL_TRACKED_FIELDS = ['name', ...reader.SHEET_FIELDS];
const DETECTION_THRESHOLD = 8;
const CONFIDENCE_GATE = 2;

const VALID_EQUIPMENT_SLOTS = new Set([
  'weapon', 'off-hand', 'shield', 'helmet', 'head', 'armor', 'chest',
  'legs', 'leggings', 'boots', 'feet', 'gloves', 'hands', 'gauntlets',
  'ring', 'ring1', 'ring2', 'amulet', 'necklace', 'cloak', 'cape',
  'belt', 'waist', 'bracers', 'wrists', 'earring', 'trinket', 'back',
  'accessory', 'other',
]);

const VALID_ABILITY_TYPES = new Set(['active', 'passive']);
const VALID_STATUS_TYPES = new Set(['buff', 'debuff', 'condition']);
const VALID_RARITY = new Set(['common', 'uncommon', 'rare', 'epic', 'legendary', 'unknown']);
const VALID_DISPOSITIONS = new Set(['friendly', 'neutral', 'hostile', 'unknown']);
const VALID_ROLES = new Set(['party-member', 'companion', 'summon', 'pet', 'mount', 'npc']);
const PARTY_SIDE_ROLES = new Set(['party-member', 'companion', 'summon', 'pet', 'mount']);

// R4: Lore Element Extraction
const MAX_R4_ELEMENTS = 10;
const R4_RARE_RARITIES = new Set(['rare', 'epic', 'legendary']);
const VALID_R4_CATEGORIES = new Set(['concept', 'item', 'faction']);

const VALID_ABILITY_CATEGORIES = new Set(['combat', 'magic', 'crafting', 'social', 'utility', 'other']);

const LITRPG_STATE_DEFAULTS = {
  enabled: false,
  detected: null,
  systemType: 'generic',
  dismissedDetection: false,
  characters: {},
  quests: {},
  party: { members: [], lastUpdated: null },
  pendingUpdates: [],
  lastProcessedLength: 0,
  lastScanAt: null,
  charsSinceLastScan: 0,
  autoScan: true,
  autoSync: false,
  globalInventory: [],
  globalCurrency: {},
  factions: {},   // { id, name, description, members:[], disposition, territory, lastUpdated }
  classes: {},    // { id, name, description, type:'class'|'subclass', parentClass, practitioners:[], lastUpdated }
  races: {},      // { id, name, description, traits, knownMembers:[], lastUpdated }
};

const CHARACTER_PERSONA_DEFAULTS = {
  persona: {
    age: null, gender: null, personalityTraits: [], motivations: [],
    fears: [], flaws: [], secrets: [], backstory: null,
    speechStyle: null, values: [], emotionalState: null,
  },
  narrative: {
    storyFunction: null, goals: [], conflicts: [], allegiances: [],
    arcType: null, arcProgression: null, importance: null,
    firstAppearance: null, lastMentioned: null,
  },
  visual: {
    hair: null, eyes: null, build: null, race: null,
    distinguishingFeatures: null, clothing: null, height: null, skinTone: null,
  },
};

// --- Tracked Fields Registry (Phase 7.3) ---

const TRACKED_FIELDS = [
  { key: 'class', label: 'Class', compare: 'scalar' },
  { key: 'subclass', label: 'Subclass', compare: 'scalar' },
  { key: 'level', label: 'Level', compare: 'scalar' },
  { key: 'race', label: 'Race', compare: 'scalar' },
  { key: 'cultivationRealm', label: 'Cultivation Realm', compare: 'scalar' },
  { key: 'cultivationStage', label: 'Cultivation Stage', compare: 'scalar' },
  { key: 'role', label: 'Role', compare: 'scalar' },
  { key: 'stats', label: null, compare: 'statMap' }, // label null = per-stat entries
  { key: 'abilities', label: 'Abilities', compare: 'namedArray' },
  { key: 'equipment', label: 'Equipment', compare: 'namedArray' },
  { key: 'xp', label: 'XP', compare: 'xpObject' },
  { key: 'currency', label: 'Currency', compare: 'keyValueMap' },
  { key: 'statusEffects', label: 'Status Effects', compare: 'namedArray' },
  { key: 'inventory', label: 'Inventory', compare: 'namedArray' },
  { key: 'persona.personalityTraits', label: 'Personality', compare: 'stringArray' },
  { key: 'persona.motivations', label: 'Motivations', compare: 'stringArray' },
  { key: 'persona.fears', label: 'Fears', compare: 'stringArray' },
  { key: 'persona.flaws', label: 'Flaws', compare: 'stringArray' },
  { key: 'persona.emotionalState', label: 'Emotional State', compare: 'scalar' },
  { key: 'persona.speechStyle', label: 'Speech Style', compare: 'scalar' },
  { key: 'narrative.storyFunction', label: 'Story Role', compare: 'scalar' },
  { key: 'narrative.arcType', label: 'Arc Type', compare: 'scalar' },
  { key: 'narrative.arcProgression', label: 'Arc Progress', compare: 'scalar' },
  { key: 'narrative.importance', label: 'Importance', compare: 'scalar' },
];

// --- System-Type Prompt Config (Phase 3A) ---

const SYSTEM_TYPE_PROMPTS = {
  generic: {
    expectedStats: 'HP, MP, STR, DEX, CON, INT, WIS, CHA, VIT, AGI, LCK, ATK, DEF',
    equipmentSlots: 'weapon, off-hand, helmet, armor, legs, boots, gloves, ring, amulet, cloak, belt, accessory',
    classExamples: 'Warrior, Mage, Rogue, Cleric, Ranger, Paladin, Necromancer',
    contextHint: 'Track levels, stats, classes, and equipment. Use standard RPG conventions.',
    questHint: 'Standard RPG quests — main storyline, side quests, personal objectives.',
  },
  dnd: {
    expectedStats: 'STR, DEX, CON, INT, WIS, CHA (core six D&D ability scores)',
    equipmentSlots: 'weapon, off-hand, shield, helmet, armor, legs, boots, gloves, ring, ring2, amulet, cloak, belt, bracers',
    classExamples: 'Fighter, Wizard, Rogue, Cleric, Ranger, Paladin, Barbarian, Bard, Druid, Monk, Sorcerer, Warlock',
    contextHint: 'D&D-style system. Track the six ability scores (STR/DEX/CON/INT/WIS/CHA) and modifiers. Track spell slots if applicable.',
    questHint: 'D&D-style quests — dungeon delves, monster hunts, patron missions, guild contracts.',
  },
  cultivation: {
    expectedStats: 'Qi, Body, Spirit, Soul, Perception, Willpower',
    equipmentSlots: 'weapon, artifact, talisman, ring, storage_ring, armor, accessory',
    classExamples: 'Sword Cultivator, Body Cultivator, Pill Master, Formation Master, Beast Tamer',
    contextHint: 'Cultivation/Xianxia system. Track cultivation realm (e.g. Qi Condensation, Foundation Establishment, Core Formation, Nascent Soul) and stage as the level equivalent. Track spirit stones as currency. Track qi techniques as abilities.',
    questHint: 'Cultivation-style objectives — tribulations, sect missions, resource gathering, breakthrough challenges, tournament arcs.',
  },
  gamelit: {
    expectedStats: 'HP, MP, STR, DEX, CON, INT, WIS, CHA, LCK, plus any game-specific stats',
    equipmentSlots: 'weapon, off-hand, helmet, armor, legs, boots, gloves, ring, amulet, cloak, belt, trinket',
    classExamples: 'Any class the system presents. GameLit often has unique or hybrid classes.',
    contextHint: 'GameLit system — game-like mechanics in a fantasy world. Track system messages, notifications, and UI windows as data sources.',
    questHint: 'System-assigned quests, hidden quests, chain quests, daily/weekly objectives.',
  },
  mmorpg: {
    expectedStats: 'HP, MP, STR, DEX, CON, INT, WIS, CHA, plus MMO-specific (Aggro, DPS, Crit Rate)',
    equipmentSlots: 'weapon, off-hand, shield, helmet, armor, legs, boots, gloves, ring, ring2, amulet, cloak, belt, trinket, earring',
    classExamples: 'Tank, Healer, DPS, Support, plus specific classes like Berserker, Priest, Assassin, Summoner',
    contextHint: 'MMORPG system. Track party roles (tank/healer/DPS/support), raid mechanics, guild affiliations. Equipment may have rarity tiers.',
    questHint: 'MMO quests — raid objectives, dungeon clears, PvP rankings, guild missions, world events.',
  },
  survival: {
    expectedStats: 'HP, Stamina, Hunger, Thirst, Sanity, plus survival-specific stats',
    equipmentSlots: 'weapon, off-hand, helmet, armor, legs, boots, gloves, backpack, belt, accessory',
    classExamples: 'Survivor, Scout, Builder, Hunter, Medic, Engineer',
    contextHint: 'Survival system. Track hunger, thirst, sanity, and crafting materials alongside combat stats. Inventory management is important.',
    questHint: 'Survival objectives — base defense, resource runs, exploration milestones, rescue missions.',
  },
};

// --- Utility ---

function delay(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

function generateRpgId(prefix) {
  return `${prefix}_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`;
}

// --- Fuzzy Matching Helpers (Phase 1A) ---

function fuzzyMatchCharacter(name, characters) {
  let bestId = null;
  let bestScore = 0;
  for (const [id, char] of Object.entries(characters)) {
    const nameScore = fuzzyNameScore(name, char.name);
    if (nameScore > bestScore) { bestScore = nameScore; bestId = id; }
    const loreScore = char.loreEntryName ? fuzzyNameScore(name, char.loreEntryName) : 0;
    if (loreScore > bestScore) { bestScore = loreScore; bestId = id; }
    for (const alias of (char.aliases || [])) {
      const aliasScore = fuzzyNameScore(name, alias);
      if (aliasScore > bestScore) { bestScore = aliasScore; bestId = id; }
    }
  }
  return bestScore >= FUZZY_MATCH_THRESHOLD ? bestId : null;
}

function fuzzyMatchQuest(title, quests, threshold = 0.8) {
  let bestQuest = null;
  let bestScore = 0;
  for (const q of quests) {
    const score = fuzzyNameScore(title, q.title);
    if (score > bestScore) { bestScore = score; bestQuest = q; }
  }
  return bestScore >= threshold ? bestQuest : null;
}

function fuzzyMatchInSet(name, nameSet, threshold = 0.7) {
  for (const existing of nameSet) {
    if (fuzzyNameScore(name, existing) >= threshold) return true;
  }
  return false;
}

/**
 * Check if a character (by name or aliases) appears in the given text.
 * For multi-word names, checks individual words (≥3 chars) to catch partial matches.
 */
function characterAppearsInText(name, aliases, text) {
  const textLower = text.toLowerCase();
  const names = [name, ...(aliases || [])];
  for (const n of names) {
    if (!n) continue;
    const words = n.split(/\s+/).filter(w => w.length >= 3);
    for (const word of words) {
      if (textLower.includes(word.toLowerCase())) return true;
    }
  }
  return false;
}

// --- Schema Validation (Phase 1B) ---

function validateClassification(data) {
  if (!data || typeof data !== 'object') return null;
  const cleaned = { partyMembers: [], npcs: [] };

  if (Array.isArray(data.partyMembers)) {
    for (const pm of data.partyMembers) {
      // Support both old format (string) and new format (object with name+role)
      if (typeof pm === 'string') {
        cleaned.partyMembers.push({ name: pm, role: 'party-member' });
      } else if (pm && pm.name) {
        const role = PARTY_SIDE_ROLES.has(pm.role) ? pm.role : 'party-member';
        cleaned.partyMembers.push({ name: String(pm.name), role });
      }
    }
  }

  if (Array.isArray(data.npcs)) {
    for (const npc of data.npcs) {
      if (!npc || !npc.name) continue;
      cleaned.npcs.push({
        name: String(npc.name),
        faction: typeof npc.faction === 'string' ? npc.faction : null,
        disposition: VALID_DISPOSITIONS.has(npc.disposition) ? npc.disposition : 'unknown',
        npcRole: typeof npc.npcRole === 'string' ? npc.npcRole : (typeof npc.role === 'string' && npc.role !== 'npc' ? npc.role : null),
        relationship: typeof npc.relationship === 'string' ? npc.relationship : null,
        isRealPerson: typeof npc.isRealPerson === 'boolean' ? npc.isRealPerson : true,
      });
    }
  }

  return cleaned;
}

// --- Retry Logic (Phase 1C) — imported from lore-creator.js ---

// --- Hybrid LLM Fallback ---

async function callWithFallback(providers, index, asyncFn) {
  const primary = providers[index % providers.length];
  try {
    return await asyncFn(primary);
  } catch (err) {
    if (providers.length <= 1) throw err;
    const fallback = providers[(index + 1) % providers.length];
    console.warn(`${LOG_PREFIX} callWithFallback: primary failed (${err.message}), trying fallback`);
    return await asyncFn(fallback);
  }
}

// ============================================================================
// DETECTION
// ============================================================================

/** The opening and the latest part of the story: game mechanics often show up in either. */
function storySample(storyText, size = MAX_STORY_CONTEXT) {
  if (storyText.length <= size) return storyText;
  const half = Math.floor(size / 2);
  return storyText.slice(0, half) + '\n...\n' + storyText.slice(-half);
}

function detectLitRPGSignals(storyText) {
  // Whole story: regex is cheap, and the system may only appear early on.
  const text = storyText;
  const patterns = [
    { name: 'stat_blocks', re: /\b(HP|MP|SP|STR|DEX|CON|INT|WIS|CHA|VIT|AGI|LCK|END|PER|ATK|DEF|MAG|RES)\s*[:=]\s*\d+/gi, weight: 3 },
    { name: 'level_mentions', re: /\b(level|lv|lvl)\.?\s*\d+/gi, weight: 3 },
    { name: 'system_messages', re: /\[(System|Notification|Quest|Achievement|Level Up|Skill|Class|Status|Warning|Alert)\]/gi, weight: 4 },
    { name: 'class_references', re: /\b(Level\s+\d+\s+\w+|[Cc]lass:\s*\w+|advanced to\s+\w+|evolved into\s+\w+)/gi, weight: 3 },
    { name: 'xp_mentions', re: /\b(experience\s+points?|XP|EXP)\s*[+:=]/gi, weight: 2 },
    { name: 'skill_mechanics', re: /\b(cooldown|mana\s+cost|skill\s+level|passive\s+skill|active\s+skill|skill\s+tree|ability\s+unlocked)\b/gi, weight: 2 },
    { name: 'rpg_vocabulary', re: /\b(buff|debuff|dungeon\s+boss|party\s+member|inventory|quest\s+log|hit\s+points|mana\s+pool|stamina|aggro)\b/gi, weight: 1 },
    { name: 'status_window', re: /\b(status\s+window|status\s+screen|character\s+sheet|stat\s+screen|skill\s+list)\b/gi, weight: 3 },
    { name: 'cultivation', re: /\b(qi|cultivation|realm|foundation\s+establishment|core\s+formation|nascent\s+soul|spirit\s+stones?)\b/gi, weight: 3 },
  ];

  let score = 0;
  const signals = [];
  for (const { name, re, weight } of patterns) {
    const matches = text.match(re);
    if (matches && matches.length > 0) {
      const contribution = Math.min(matches.length, 3) * weight;
      score += contribution;
      signals.push({ name, count: matches.length, contribution });
    }
  }

  return { score, signals, meetsThreshold: score >= DETECTION_THRESHOLD };
}

async function confirmLitRPG(storyText, generateTextFn) {
  const text = storySample(storyText);
  const messages = [
    {
      role: 'system',
      content: 'You classify story genres. Answer with ONLY valid JSON, no other text.'
    },
    {
      role: 'user',
      content: `Does this story contain LitRPG or GameLit game mechanics (stat systems, level progression, skills, quests, etc.)?

STORY TEXT:
${text}

Output: {"isLitRPG": true/false, "systemType": "generic|dnd|cultivation|gamelit|mmorpg|survival", "confidence": 1-5}`
    }
  ];

  try {
    const result = await generateTextFn(messages, { max_tokens: 100, temperature: 0.2 });
    const parsed = recoverJSON(result.output);
    if (!parsed) return null;
    return {
      isLitRPG: !!parsed.isLitRPG,
      systemType: parsed.systemType || 'generic',
      confidence: parsed.confidence || 1,
    };
  } catch (err) {
    console.error(`${LOG_PREFIX} confirmLitRPG error:`, err.message);
    return null;
  }
}

async function detectLitRPG(storyText, generateTextFn) {
  const signals = detectLitRPGSignals(storyText);
  console.log(`${LOG_PREFIX} Detection score: ${signals.score} (threshold: ${DETECTION_THRESHOLD})`);

  if (!signals.meetsThreshold) {
    return { detected: false, systemType: null, signals };
  }

  const confirmation = await confirmLitRPG(storyText, generateTextFn);
  if (!confirmation) {
    return { detected: false, systemType: null, signals };
  }

  console.log(`${LOG_PREFIX} LLM confirmation: isLitRPG=${confirmation.isLitRPG}, type=${confirmation.systemType}, confidence=${confirmation.confidence}`);
  return {
    detected: confirmation.isLitRPG && confirmation.confidence >= CONFIDENCE_GATE,
    systemType: confirmation.systemType,
    signals,
  };
}

// ============================================================================
// RPG SCAN PASSES (Phase 3B — System-Type-Aware Prompts)
// ============================================================================

async function classifyPartyAndNPCs(characters, storyText, generateTextFn, comprehensionContext, systemType, protagonistName = null) {
  if (characters.length === 0) return { partyMembers: [], npcs: [] };

  const typeConfig = SYSTEM_TYPE_PROMPTS[systemType] || SYSTEM_TYPE_PROMPTS.generic;
  const recentText = storyText.slice(-6000);
  const contextBlock = comprehensionContext ? `${comprehensionContext}\n` : '';

  // Build enriched character context lines with class/level/role metadata
  const charLines = characters.map(c => {
    const parts = [c.name];
    if (c.level) parts.push(`Lv.${c.level}`);
    if (c.class) parts.push(c.class);
    if (c.role) parts.push(c.role); // combat role (tank/healer/dps)
    const detail = parts.length > 1 ? ` (${parts.slice(1).join(', ')})` : '';
    const anchor = c.currentRole
      ? `, currently: ${c.currentRole}`
      : ', no prior classification';
    return `- ${c.name}${detail}${anchor}`;
  }).join('\n');

  const messages = [
    {
      role: 'system',
      content: `You classify characters in LitRPG stories. ${typeConfig.contextHint} Output ONLY valid JSON. Base classification on explicit story evidence only.`
    },
    {
      role: 'user',
      content: `Classify these characters based on the story context.

Roles:
- "party-member": travels with or fights alongside the protagonist
- "companion": allied NPC who regularly accompanies the party
- "summon": summoned creature or spirit bound to a party member
- "pet": tamed animal or creature following a party member
- "mount": rideable creature belonging to the party
- "npc": other characters in the story world

${protagonistName ? `The protagonist is ${protagonistName}; they lead the party.

` : ''}Characters with an existing classification should KEEP it unless the story EXPLICITLY contradicts it (e.g. a companion betrays the party, or an NPC joins).

${contextBlock}CHARACTERS:
${charLines}

RECENT STORY TEXT:
${recentText}

Output JSON — every character MUST appear in exactly one list:
{"partyMembers":[{"name":"Name1","role":"party-member|companion|summon|pet|mount"}],"npcs":[{"name":"Name3","role":"npc","faction":"faction name or null","disposition":"friendly|neutral|hostile|unknown","npcRole":"mentor|rival|shopkeeper|quest_giver|boss|ally|other|null","relationship":"relationship description or null","isRealPerson":true/false}]}`
    }
  ];

  return retryLLM(async () => {
    const result = await generateTextFn(messages, { max_tokens: 500, temperature: 0.3 });
    const parsed = recoverJSON(result.output);
    return validateClassification(parsed);
  });
}

// ============================================================================
// MERGE HELPERS (Phase 4D)
// ============================================================================

function mergeEquipment(existing, incoming) {
  const merged = [...(existing || [])];
  for (const newItem of (incoming || [])) {
    const matchIdx = merged.findIndex(e => fuzzyNameScore(e.name, newItem.name) >= 0.8);
    if (matchIdx >= 0) {
      merged[matchIdx] = { ...merged[matchIdx], ...newItem };
    } else {
      merged.push(newItem);
    }
  }
  return merged;
}

function mergeAbilities(existing, incoming) {
  const merged = [...(existing || [])];
  for (const newAbility of (incoming || [])) {
    const matchIdx = merged.findIndex(a => fuzzyNameScore(a.name, newAbility.name) >= 0.8);
    if (matchIdx >= 0) {
      merged[matchIdx] = { ...merged[matchIdx], ...newAbility };
    } else {
      merged.push(newAbility);
    }
  }
  return merged;
}

function mergeInventory(existing, incoming) {
  const merged = [...(existing || [])];
  for (const newItem of (incoming || [])) {
    const matchIdx = merged.findIndex(i => fuzzyNameScore(i.name, newItem.name) >= 0.8);
    if (matchIdx >= 0) {
      merged[matchIdx].quantity = (merged[matchIdx].quantity || 1) + (newItem.quantity || 1);
    } else {
      merged.push(newItem);
    }
  }
  return merged;
}

function mergeCurrency(existing, incoming) {
  const merged = { ...(existing || {}) };
  for (const [unit, amount] of Object.entries(incoming || {})) {
    merged[unit] = (merged[unit] || 0) + amount;
  }
  return merged;
}

// ============================================================================
// CHANGE DETECTION (Phase 4E)
// ============================================================================

function getNestedField(obj, path) {
  return path.split('.').reduce((o, k) => o?.[k], obj);
}

function hasCharacterChanged(before, after) {
  for (const field of TRACKED_FIELDS) {
    const bv = getNestedField(before, field.key);
    const av = getNestedField(after, field.key);
    switch (field.compare) {
      case 'scalar':
        if (bv !== av) return true;
        break;
      case 'stringArray': {
        const a = (bv || []).slice().sort().join(',');
        const b = (av || []).slice().sort().join(',');
        if (a !== b) return true;
        break;
      }
      case 'statMap': {
        const bs = bv || {};
        const as = av || {};
        const allKeys = new Set([...Object.keys(bs), ...Object.keys(as)]);
        for (const k of allKeys) {
          if (bs[k]?.value !== as[k]?.value) return true;
          if (bs[k]?.modifier !== as[k]?.modifier) return true;
        }
        break;
      }
      case 'namedArray': {
        const bArr = (bv || []).map(x => x.name).sort();
        const aArr = (av || []).map(x => x.name).sort();
        if (bArr.length !== aArr.length) return true;
        for (let i = 0; i < bArr.length; i++) {
          if (fuzzyNameScore(bArr[i], aArr[i]) < 0.8) return true;
        }
        break;
      }
      case 'xpObject': {
        const bx = bv || {};
        const ax = av || {};
        if (bx.current !== ax.current || bx.needed !== ax.needed) return true;
        break;
      }
      case 'keyValueMap': {
        const bm = bv || {};
        const am = av || {};
        const allKeys = new Set([...Object.keys(bm), ...Object.keys(am)]);
        for (const k of allKeys) {
          if (bm[k] !== am[k]) return true;
        }
        break;
      }
    }
  }
  return false;
}

function describeChanges(before, after) {
  const changes = [];
  for (const field of TRACKED_FIELDS) {
    const bv = getNestedField(before, field.key);
    const av = getNestedField(after, field.key);
    switch (field.compare) {
      case 'scalar':
        if (bv !== av) {
          changes.push({ field: field.label, before: bv || 'none', after: av || 'none' });
        }
        break;
      case 'stringArray': {
        const a = (bv || []).slice().sort().join(',');
        const b = (av || []).slice().sort().join(',');
        if (a !== b) {
          changes.push({ field: field.label, before: (bv || []).join(', ') || 'none', after: (av || []).join(', ') || 'none' });
        }
        break;
      }
      case 'statMap': {
        const bs = bv || {};
        const as = av || {};
        const allKeys = new Set([...Object.keys(bs), ...Object.keys(as)]);
        const fmtStat = (v, m) => v != null ? `${v}${m != null ? ` (${m >= 0 ? '+' : ''}${m})` : ''}` : 'none';
        for (const k of allKeys) {
          if (bs[k]?.value !== as[k]?.value || bs[k]?.modifier !== as[k]?.modifier) {
            changes.push({ field: k, before: fmtStat(bs[k]?.value, bs[k]?.modifier), after: fmtStat(as[k]?.value, as[k]?.modifier) || 'removed' });
          }
        }
        break;
      }
      case 'namedArray': {
        const bNames = new Set((bv || []).map(x => x.name.toLowerCase()));
        const newItems = (av || []).filter(x => !bNames.has(x.name.toLowerCase()));
        if (newItems.length > 0) {
          changes.push({ field: field.label, before: `${(bv || []).length}`, after: `+${newItems.length} new (${newItems.map(x => x.name).join(', ')})` });
        }
        break;
      }
      case 'xpObject': {
        const bx = bv || {};
        const ax = av || {};
        if (bx.current !== ax.current) {
          changes.push({ field: 'XP', before: bx.current != null ? String(bx.current) : 'none', after: ax.current != null ? String(ax.current) : 'none' });
        }
        if (bx.needed !== ax.needed) {
          changes.push({ field: 'XP Needed', before: bx.needed != null ? String(bx.needed) : 'none', after: ax.needed != null ? String(ax.needed) : 'none' });
        }
        break;
      }
      case 'keyValueMap': {
        const bm = bv || {};
        const am = av || {};
        const allKeys = new Set([...Object.keys(bm), ...Object.keys(am)]);
        const changed = [];
        for (const k of allKeys) {
          if (bm[k] !== am[k]) changed.push(k);
        }
        if (changed.length > 0) {
          changes.push({ field: field.label, before: changed.map(k => `${k}: ${bm[k] || 0}`).join(', '), after: changed.map(k => `${k}: ${am[k] || 0}`).join(', ') });
        }
        break;
      }
    }
  }
  return changes;
}

// ============================================================================
// R4: LORE ELEMENT EXTRACTION
// ============================================================================

/**
 * Collect non-character RPG elements from state, deduplicated against existing lorebook.
 * Returns { elements: [], skipped: number }
 */
function collectR4Elements(rpgState, loreEntries) {
  const elements = [];
  const seen = new Set(); // track names we've already collected
  const loreNames = (loreEntries || []).map(e => (e.displayName || '').toLowerCase());

  function isDuplicateOfLore(name) {
    const lower = name.toLowerCase();
    return loreNames.some(ln => fuzzyNameScore(lower, ln) >= FUZZY_MATCH_THRESHOLD);
  }

  function addElement(name, sourceType, category, context) {
    const key = `${sourceType}:${name.toLowerCase()}`;
    if (seen.has(key)) return;
    if (isDuplicateOfLore(name)) return;
    seen.add(key);
    elements.push({ name, sourceType, category, context });
  }

  const chars = Object.values(rpgState.characters || {});

  // Classes/subclasses from first-class collections → concept (richer context)
  for (const cls of Object.values(rpgState.classes || {})) {
    addElement(cls.name, 'class', 'concept', {
      practitioners: cls.practitioners || [],
      parentClass: cls.parentClass || null,
      type: cls.type || 'class',
      description: cls.description || null,
    });
  }

  // Rare+ equipment → item
  for (const c of chars) {
    for (const eq of (c.equipment || [])) {
      if (eq.name && eq.rarity && R4_RARE_RARITIES.has(eq.rarity)) {
        addElement(eq.name, 'equipment', 'item', { owner: c.name, slot: eq.slot, rarity: eq.rarity, description: eq.description, bonuses: eq.bonuses });
      }
    }
  }

  // Factions from first-class collections (richer context: members, disposition)
  for (const fac of Object.values(rpgState.factions || {})) {
    addElement(fac.name, 'faction', 'faction', {
      members: fac.members || [],
      disposition: fac.disposition || 'unknown',
      description: fac.description || null,
    });
  }

  // Races from first-class collections → concept
  for (const race of Object.values(rpgState.races || {})) {
    if ((race.knownMembers || []).length > 0) {
      addElement(race.name, 'race', 'concept', {
        knownMembers: race.knownMembers || [],
        traits: race.traits || null,
        description: race.description || null,
      });
    }
  }

  // Quests → concept
  for (const q of Object.values(rpgState.quests || {})) {
    if (q.title) addElement(q.title, 'quest', 'concept', { description: q.description, type: q.type, giver: q.giver, status: q.status });
  }

  // Priority cap: equipment first, then factions, classes, races, quests
  const priorityOrder = ['equipment', 'faction', 'class', 'race', 'quest'];
  elements.sort((a, b) => priorityOrder.indexOf(a.sourceType) - priorityOrder.indexOf(b.sourceType));

  const skipped = Math.max(0, elements.length - MAX_R4_ELEMENTS);
  return { elements: elements.slice(0, MAX_R4_ELEMENTS), skipped };
}

/**
 * Format a single R4 element into a description line for the LLM prompt.
 */
function formatR4ElementContext(element, index) {
  const { name, sourceType, context } = element;
  switch (sourceType) {
    case 'class':
      return `${index + 1}. [CLASS] "${name}" (${context.type || 'class'}) — practitioners: ${(context.practitioners || []).join(', ') || 'unknown'}${context.parentClass ? `, subclass of ${context.parentClass}` : ''}`;
    case 'equipment':
      return `${index + 1}. [ITEM] "${name}" (${context.rarity} ${context.slot || 'equipment'}) — owned by ${context.owner}${context.bonuses ? ` {${context.bonuses}}` : ''}${context.description ? `: ${context.description}` : ''}`;
    case 'faction':
      return `${index + 1}. [FACTION] "${name}" (${context.disposition || 'unknown'}) — members: ${(context.members || []).join(', ') || 'unknown'}`;
    case 'race':
      return `${index + 1}. [RACE] "${name}" — known members: ${(context.knownMembers || []).join(', ') || 'unknown'}${context.traits ? `, traits: ${context.traits}` : ''}`;
    case 'quest':
      return `${index + 1}. [QUEST] "${name}"${context.type ? ` (${context.type})` : ''}${context.giver ? ` from ${context.giver}` : ''}${context.description ? `: ${context.description}` : ''}`;
    default:
      return `${index + 1}. "${name}"`;
  }
}

/**
 * Generate lorebook entries for R4 elements via a single batched LLM call.
 */
async function generateLoreElementEntries(elements, storyText, generateTextFn, comprehensionContext, systemType) {
  if (!elements || elements.length === 0) return [];

  const typeConfig = SYSTEM_TYPE_PROMPTS[systemType] || SYSTEM_TYPE_PROMPTS.generic;
  const elementDescriptions = elements.map((el, i) => formatR4ElementContext(el, i)).join('\n');

  // Build template instructions for each category present
  const categoriesPresent = [...new Set(elements.map(e => e.category))];
  const templateInstructions = categoriesPresent.map(cat => {
    const tmpl = getTemplateForType(cat);
    return tmpl ? `\nFor ${cat.toUpperCase()} entries, use this structured format:\n${tmpl}` : '';
  }).join('\n');

  const recentStory = storyText.slice(-2000);

  const systemPrompt = `You are a lorebook entry writer for a ${typeConfig.contextHint || 'fantasy RPG'} story. Create concise lorebook entries for RPG game elements discovered in the story. Each entry should be factual and based only on what is known from the story context. Use second person ("you") for protagonist references where applicable.`;

  const userPrompt = `Create lorebook entries for these RPG elements found in the story:

${elementDescriptions}

${templateInstructions}

Recent story context:
---
${recentStory}
---
${comprehensionContext ? `\nStory comprehension:\n${comprehensionContext}\n` : ''}
Return a JSON object with this exact schema:
{"entries":[{"name":"element name","category":"concept|item|faction","keys":["key1","key2"],"text":"entry text using the template format above","confidence":1-5}]}

Rules:
- Only include information confirmed by the story — no speculation
- Keys should be aliases or related terms for lorebook matching
- Confidence: 1=uncertain, 5=well-established in story
- Omit template fields that have no information
- Keep entries concise (under 300 words each)`;

  const messages = [
    { role: 'system', content: systemPrompt },
    { role: 'user', content: userPrompt },
  ];
  const result = await retryLLM(async () => {
    const raw = await generateTextFn(messages, { max_tokens: 1200, temperature: 0.3 });
    if (!raw) return null;
    const parsed = recoverJSON(raw.output);
    if (!parsed || !parsed.entries) return null;
    return parsed;
  });

  if (!result || !result.entries) return [];
  return validateR4Entries(result.entries, elements);
}

/**
 * Validate and format R4 LLM output into pending lore entry objects.
 */
function validateR4Entries(entries, sourceElements) {
  if (!Array.isArray(entries)) return [];
  const today = new Date().toISOString().split('T')[0];
  const validated = [];

  for (const entry of entries) {
    if (!entry.name || !entry.text || !entry.category) continue;
    if (!VALID_R4_CATEGORIES.has(entry.category)) continue;
    if (entry.confidence != null && entry.confidence < CONFIDENCE_GATE) continue;

    // Determine source tag from matching source element
    const sourceEl = sourceElements.find(se => fuzzyNameScore(se.name, entry.name) >= FUZZY_MATCH_THRESHOLD);
    const sourceTag = sourceEl ? `litrpg-r4-${sourceEl.sourceType}` : 'litrpg-r4';

    const text = setMetadata(entry.text, {
      type: entry.category,
      version: METADATA_VERSION,
      updated: today,
      source: sourceTag,
    });

    validated.push({
      id: `lore_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`,
      category: entry.category,
      displayName: entry.name,
      keys: Array.isArray(entry.keys) ? entry.keys : [entry.name.toLowerCase()],
      text,
      confidence: entry.confidence || 3,
      createdAt: Date.now(),
    });
  }

  return validated;
}

// ============================================================================
// STATE MIGRATION
// ============================================================================

/**
 * Migrate existing LitRPG state to include new collections and enriched sub-model fields.
 * Safe to call on already-migrated state (idempotent).
 */
function migrateLitrpgState(state) {
  // Initialize new collections if missing
  if (!state.factions) state.factions = {};
  if (!state.classes) state.classes = {};
  if (!state.races) state.races = {};

  // Migrate existing character sub-models to include new nullable fields
  for (const char of Object.values(state.characters || {})) {
    // Abilities: add category, cooldown, proficiency
    for (const a of (char.abilities || [])) {
      if (a.category === undefined) a.category = null;
      if (a.cooldown === undefined) a.cooldown = null;
      if (a.proficiency === undefined) a.proficiency = null;
    }
    // Equipment: add bonuses, setName
    for (const e of (char.equipment || [])) {
      if (e.bonuses === undefined) e.bonuses = null;
      if (e.setName === undefined) e.setName = null;
    }
    // Inventory: add rarity
    for (const i of (char.inventory || [])) {
      if (i.rarity === undefined) i.rarity = null;
    }
    // Relationships: structured inter-character edges
    if (!Array.isArray(char.relationships)) char.relationships = [];
  }
}

// ============================================================================
// CONSOLIDATION FUNCTIONS — Zero LLM Calls
// ============================================================================

/**
 * Aggregate unique classes/subclasses from character data into state.classes.
 * Updates practitioner lists without replacing existing descriptions.
 */
function consolidateClasses(state) {
  // Include both committed characters and pending updates (which haven't been accepted yet)
  const chars = Object.values(state.characters || {});
  const pendingChars = (state.pendingUpdates || [])
    .filter(u => u.type === 'character' && u.after)
    .map(u => u.after);
  const allChars = [...chars, ...pendingChars];
  const seen = new Map(); // lowercase name → { name, type, parentClass }

  for (const c of allChars) {
    if (c.class) {
      const key = c.class.toLowerCase();
      if (!seen.has(key)) seen.set(key, { name: c.class, type: 'class', parentClass: null });
    }
    if (c.subclass) {
      const key = c.subclass.toLowerCase();
      if (!seen.has(key)) seen.set(key, { name: c.subclass, type: 'subclass', parentClass: c.class || null });
    }
  }

  for (const [key, info] of seen) {
    // Find existing entry by fuzzy match
    let existingId = null;
    for (const [id, cls] of Object.entries(state.classes)) {
      if (fuzzyNameScore(cls.name, info.name) >= 0.8) { existingId = id; break; }
    }

    if (existingId) {
      const cls = state.classes[existingId];
      const currentPractitioners = allChars.filter(c =>
        (c.class && c.class.toLowerCase() === key) || (c.subclass && c.subclass.toLowerCase() === key)
      ).map(c => c.name);
      if (cls._manuallyEdited) {
        // Only add new practitioners, don't touch other fields
        const newPractitioners = currentPractitioners.filter(p => !(cls.practitioners || []).includes(p));
        if (newPractitioners.length > 0) {
          cls.practitioners = [...(cls.practitioners || []), ...newPractitioners];
          cls.lastUpdated = Date.now();
        }
      } else {
        cls.practitioners = currentPractitioners;
        cls.lastUpdated = Date.now();
        if (info.parentClass && !cls.parentClass) cls.parentClass = info.parentClass;
      }
    } else {
      const id = generateRpgId('class');
      state.classes[id] = {
        id,
        name: info.name,
        description: null,
        type: info.type,
        parentClass: info.parentClass,
        practitioners: allChars.filter(c =>
          (c.class && c.class.toLowerCase() === key) || (c.subclass && c.subclass.toLowerCase() === key)
        ).map(c => c.name),
        lastUpdated: Date.now(),
      };
    }
  }
}

/**
 * Aggregate unique races from character data into state.races.
 */
function consolidateRaces(state) {
  const chars = Object.values(state.characters || {});
  const pendingChars = (state.pendingUpdates || [])
    .filter(u => u.type === 'character' && u.after)
    .map(u => u.after);
  const allChars = [...chars, ...pendingChars];
  const seen = new Map(); // lowercase name → { name }

  for (const c of allChars) {
    if (c.race) {
      const key = c.race.toLowerCase();
      if (!seen.has(key)) seen.set(key, { name: c.race });
    }
  }

  for (const [key, info] of seen) {
    let existingId = null;
    for (const [id, race] of Object.entries(state.races)) {
      if (fuzzyNameScore(race.name, info.name) >= 0.8) { existingId = id; break; }
    }

    if (existingId) {
      const race = state.races[existingId];
      const currentMembers = allChars.filter(c => c.race && c.race.toLowerCase() === key).map(c => c.name);
      if (race._manuallyEdited) {
        // Only add new members, don't touch other fields
        const newMembers = currentMembers.filter(m => !(race.knownMembers || []).includes(m));
        if (newMembers.length > 0) {
          race.knownMembers = [...(race.knownMembers || []), ...newMembers];
          race.lastUpdated = Date.now();
        }
      } else {
        race.knownMembers = currentMembers;
        race.lastUpdated = Date.now();
      }
    } else {
      const id = generateRpgId('race');
      state.races[id] = {
        id,
        name: info.name,
        description: null,
        traits: null,
        knownMembers: allChars.filter(c => c.race && c.race.toLowerCase() === key).map(c => c.name),
        lastUpdated: Date.now(),
      };
    }
  }
}

/**
 * Aggregate factions from character data into state.factions.
 */
function consolidateFactions(state) {
  const chars = Object.values(state.characters || {});
  const pendingChars = (state.pendingUpdates || [])
    .filter(u => u.type === 'character' && u.after)
    .map(u => u.after);
  const allChars = [...chars, ...pendingChars];
  const factionMap = new Map(); // lowercase name → { name, members, disposition }

  for (const c of allChars) {
    if (c.faction) {
      const key = c.faction.toLowerCase();
      if (!factionMap.has(key)) {
        factionMap.set(key, { name: c.faction, members: [], disposition: c.disposition || null });
      }
      factionMap.get(key).members.push(c.name);
    }
  }

  for (const [key, info] of factionMap) {
    let existingId = null;
    for (const [id, fac] of Object.entries(state.factions)) {
      if (fuzzyNameScore(fac.name, info.name) >= 0.8) { existingId = id; break; }
    }

    if (existingId) {
      const fac = state.factions[existingId];
      if (fac._manuallyEdited) {
        // Only add new members, don't touch other fields
        const newMembers = info.members.filter(m => !(fac.members || []).includes(m));
        if (newMembers.length > 0) {
          fac.members = [...(fac.members || []), ...newMembers];
          fac.lastUpdated = Date.now();
        }
      } else {
        fac.members = info.members;
        fac.lastUpdated = Date.now();
        if (info.disposition && !fac.disposition) fac.disposition = info.disposition;
      }
    } else {
      const id = generateRpgId('faction');
      state.factions[id] = {
        id,
        name: info.name,
        description: null,
        members: info.members,
        disposition: info.disposition || 'unknown',
        territory: null,
        lastUpdated: Date.now(),
      };
    }
  }
}

/**
 * Detect orphan entities — classes, races, factions with 0 members.
 * Returns ids for UI display; does not auto-delete.
 */
function detectOrphanEntities(state) {
  const orphanClasses = Object.entries(state.classes || {})
    .filter(([, cls]) => (cls.practitioners || []).length === 0)
    .map(([id]) => id);
  const orphanRaces = Object.entries(state.races || {})
    .filter(([, race]) => (race.knownMembers || []).length === 0)
    .map(([id]) => id);
  const orphanFactions = Object.entries(state.factions || {})
    .filter(([, fac]) => (fac.members || []).length === 0)
    .map(([id]) => id);
  return { orphanClasses, orphanRaces, orphanFactions };
}

// ============================================================================
// R5: ENTITY ENRICHMENT PASS
// ============================================================================

/**
 * Single batched LLM call to enrich factions/classes/races lacking descriptions.
 * Skips if all entities already have descriptions (unless forceReEnrich is true).
 */
async function enrichEntityDescriptions(state, storyText, generateTextFn, comprehensionContext, systemType, forceReEnrich = false) {
  const typeConfig = SYSTEM_TYPE_PROMPTS[systemType] || SYSTEM_TYPE_PROMPTS.generic;
  const toEnrich = [];

  for (const fac of Object.values(state.factions || {})) {
    if (forceReEnrich || !fac.description) toEnrich.push({ type: 'faction', name: fac.name, context: `Members: ${(fac.members || []).join(', ')}`, disposition: fac.disposition });
  }
  for (const cls of Object.values(state.classes || {})) {
    if (forceReEnrich || !cls.description) toEnrich.push({ type: 'class', name: cls.name, context: `Practitioners: ${(cls.practitioners || []).join(', ')}${cls.parentClass ? `, subclass of ${cls.parentClass}` : ''}` });
  }
  for (const race of Object.values(state.races || {})) {
    if (forceReEnrich || !race.description) toEnrich.push({ type: 'race', name: race.name, context: `Known members: ${(race.knownMembers || []).join(', ')}` });
  }

  if (toEnrich.length === 0) {
    console.log(`${LOG_PREFIX} R5: All entities already have descriptions — skipping`);
    return;
  }

  console.log(`${LOG_PREFIX} R5: Enriching ${toEnrich.length} entities (${toEnrich.filter(e => e.type === 'faction').length} factions, ${toEnrich.filter(e => e.type === 'class').length} classes, ${toEnrich.filter(e => e.type === 'race').length} races)`);

  const entityList = toEnrich.map((e, i) => `${i + 1}. [${e.type.toUpperCase()}] "${e.name}" — ${e.context}`).join('\n');
  const recentStory = storyText.slice(-3000);
  const contextBlock = comprehensionContext ? `\nStory comprehension:\n${comprehensionContext}\n` : '';

  const messages = [
    {
      role: 'system',
      content: `You enrich RPG world-building entities with concise narrative descriptions. ${typeConfig.contextHint} Output ONLY valid JSON. Base descriptions only on story context — no speculation.`
    },
    {
      role: 'user',
      content: `Write brief descriptions for these RPG entities found in the story:

${entityList}
${contextBlock}
Recent story context:
---
${recentStory}
---

Output JSON:
{"factions":[{"name":"...","description":"1-2 sentence description","disposition":"ally|neutral|hostile|unknown","territory":"territory or null"}],"classes":[{"name":"...","description":"1-2 sentence description","requirements":"requirements or null"}],"races":[{"name":"...","description":"1-2 sentence description","traits":"notable traits or null"}]}

Only include entities from the list above. Keep descriptions concise (1-2 sentences each).`
    }
  ];

  const result = await retryLLM(async () => {
    const raw = await generateTextFn(messages, { max_tokens: 800, temperature: 0.3 });
    if (!raw) return null;
    return recoverJSON(raw.output);
  }, { maxRetries: 1, passName: 'R5-enrichment' });

  if (!result) return;

  // Apply faction descriptions
  if (Array.isArray(result.factions)) {
    for (const enriched of result.factions) {
      if (!enriched.name || !enriched.description) continue;
      for (const fac of Object.values(state.factions)) {
        if (fuzzyNameScore(fac.name, enriched.name) >= 0.8) {
          fac.description = enriched.description;
          if (enriched.disposition && VALID_DISPOSITIONS.has(enriched.disposition)) fac.disposition = enriched.disposition;
          if (enriched.territory) fac.territory = enriched.territory;
          fac.lastUpdated = Date.now();
          break;
        }
      }
    }
  }

  // Apply class descriptions
  if (Array.isArray(result.classes)) {
    for (const enriched of result.classes) {
      if (!enriched.name || !enriched.description) continue;
      for (const cls of Object.values(state.classes)) {
        if (fuzzyNameScore(cls.name, enriched.name) >= 0.8) {
          cls.description = enriched.description;
          if (enriched.requirements) cls.requirements = enriched.requirements;
          cls.lastUpdated = Date.now();
          break;
        }
      }
    }
  }

  // Apply race descriptions
  if (Array.isArray(result.races)) {
    for (const enriched of result.races) {
      if (!enriched.name || !enriched.description) continue;
      for (const race of Object.values(state.races)) {
        if (fuzzyNameScore(race.name, enriched.name) >= 0.8) {
          race.description = enriched.description;
          if (enriched.traits) race.traits = enriched.traits;
          race.lastUpdated = Date.now();
          break;
        }
      }
    }
  }

  console.log(`${LOG_PREFIX} R5: Enrichment complete`);
}

// ============================================================================
// R-PASS FUNCTIONS (internal — called by scanForRPGData orchestrator)
// ============================================================================

/** Lorebook entries that describe a character: declared, or guessed for untyped entries. */
function isCharacterLoreEntry(e) {
  const entryType = getEntryType(e.text, e.displayName);
  if (entryType === 'character') return true;
  // Any other type, built-in or custom @type ("class", "class tier"), is not a character.
  if (entryType !== 'unknown') return false;
  const text = (e.text || '').toLowerCase();
  return text.includes('name:') || text.includes('appearance') || text.includes('class:');
}

function povPromptLine(pov, protagonistName) {
  const who = protagonistName || 'the narrator (write "narrator" when no name is given)';
  const sys = ` Game system messages that say "you" are for ${protagonistName || 'the narrator'} unless they name someone else.`;
  if (pov === 'first') return `POINT OF VIEW: first person. "I", "me" and "my" in the narration are ${who}.${sys}`;
  if (pov === 'second') return `POINT OF VIEW: second person. "You" in the narration is ${who}.`;
  return `POINT OF VIEW: third person.${protagonistName ? ` The protagonist is ${protagonistName}.` : ''}`;
}

/** Fold `other` into `keeper` (same person tracked twice). Keeper keeps its id. */
function mergeCharacterInto(keeper, other) {
  for (const k of ['persona', 'narrative', 'visual']) {
    if (!other[k]) continue;
    keeper[k] = { ...(keeper[k] || {}) };
    for (const [f, v] of Object.entries(other[k])) {
      const cur = keeper[k][f];
      if (cur == null || (Array.isArray(cur) && cur.length === 0)) keeper[k][f] = v;
    }
  }
  keeper.aliases = [...new Set([...(keeper.aliases || []), other.name, ...(other.aliases || [])])].filter(a => a && a !== keeper.name);
  const seen = new Set((keeper.relationships || []).map(r => (r.targetName || '').toLowerCase()));
  keeper.relationships = [...(keeper.relationships || []), ...(other.relationships || []).filter(r => !seen.has((r.targetName || '').toLowerCase()))];
  for (const f of other._manualFields || []) {
    if ((keeper._manualFields || []).includes(f)) continue;
    keeper._manualFields = [...(keeper._manualFields || []), f];
    if (f === 'storyFunction') keeper.narrative = { ...(keeper.narrative || {}), storyFunction: other.narrative?.storyFunction ?? null };
    else keeper[f] = other[f];
  }
  if (!keeper.loreEntryName && other.loreEntryName) keeper.loreEntryName = other.loreEntryName;
  for (const f of ['faction', 'disposition', 'npcRole', 'npcRelationship']) if (keeper[f] == null && other[f] != null) keeper[f] = other[f];
}

/**
 * Pass R1: read the whole story and rebuild the cast and every character sheet.
 *
 * The story is read in chunks (cached by text hash, so only changed chunks cost
 * a call). The cast is everyone the story names as a person, plus lorebook
 * characters already tracked; duplicates are merged, and classes, items and
 * non-character lorebook entries are dropped. Sheets come only from facts the
 * story states, so values that were wrong before are cleared. Fields the user
 * edited by hand are left alone.
 */
async function r1_readWholeStory(ctx) {
  const { state, storyText, loreEntries, characterEntries, providers, systemType, onProgress, report, options = {} } = ctx;
  const start = Date.now();
  const typeConfig = SYSTEM_TYPE_PROMPTS[systemType] || SYSTEM_TYPE_PROMPTS.generic;
  if (options.fullRescan) state.storyReaderCache = null;

  const pov = reader.detectPov(storyText);
  const loreProt = characterEntries.find(e => parseMetadata(e.text).protagonist);
  const protHint = (loreProt && loreProt.displayName) || (pov !== 'third' && reader.findSelfName(storyText)) || state.protagonist?.name || null;
  const knownNames = [...new Set([
    ...characterEntries.map(e => e.displayName),
    ...Object.values(state.storyReaderCache?.chunks || {}).flatMap(r => (r.people || []).map(p => p.name)),
  ])].filter(n => n && !isNarratorPlaceholder(n)).slice(0, 40);

  const read = await reader.readStoryChunks(storyText, state.storyReaderCache, providers, {
    povLine: povPromptLine(pov, protHint),
    knownNames,
    contextHint: typeConfig.contextHint,
    onCheckpoint: options.onCheckpoint,
    onProgress: (p) => onProgress && onProgress({ phase: 'characters', current: p.current, total: p.total, subPhase: 'R1-reading', passStartedAt: start, errorCount: report.errors.length }),
  });
  state.storyReaderCache = read.cache;
  if (read.failed > 0) {
    report.errors.push({ pass: 'R1', category: 'other', message: `${read.failed} of ${read.total} story chunks could not be read; they are retried next scan`, timestamp: Date.now() });
  }
  const allRead = read.chunks.every(c => c.result);

  const roster = reader.buildRoster({ loreEntries: characterEntries, stateChars: state.characters, chunks: read.chunks });
  const prot = reader.resolveProtagonist({ storyText, loreEntries: characterEntries, stateChars: state.characters, chunks: read.chunks, roster });
  if (!prot.person && prot.name) prot.person = roster.add(prot.name, { source: 'story' });
  const fold = reader.foldChunks(read.chunks, roster, (i) => prot.at(i), prot.pov);

  // Names that are classes, skills or items in this story are not people.
  const classKeys = new Set([...fold.classes.values()].map(c => reader.nameKey(c.name)));
  const thingKeys = new Set();
  for (const sh of fold.sheets.values()) {
    for (const x of [...sh.abilities, ...sh.inventory, ...sh.equipment]) thingKeys.add(reader.nameKey(x.name));
  }
  const loreTypeOf = (name) => {
    const e = name && loreEntries.find(x => x.displayName === name);
    return e ? getEntryType(e.text, e.displayName) : null;
  };
  const removedKeys = new Set((state.removedCharacterNames || []).map(n => reader.nameKey(n)));
  // A name written in the story's prose counts even if the reader missed it
  // (one-word names only when capitalized). Menu and list lines don't count:
  // "Divine Seed" there is a skill.
  const proseLines = storyText.split('\n').filter(l => !/^\s*[─\-•*>|]/.test(l) && !/^\s*\d{1,2}[.)]\s/.test(l)).join('\n');
  const namedInStory = (p) => [p.name, ...p.aliases].some(n => {
    if (!n || isNarratorPlaceholder(n)) return false;
    const words = n.trim().split(/\s+/);
    const esc = n.trim().replace(/[.*+?^${}()|[\]\\]/g, '\\$&').replace(/\s+/g, '\\s+');
    return words.length >= 2 ? new RegExp(`\\b${esc}\\b`, 'i').test(proseLines) : /^[A-Z]/.test(n) && new RegExp(`\\b${esc}\\b`).test(proseLines);
  });

  const removed = [];
  const dropIds = new Set();
  const kept = [];
  for (const p of roster.people) {
    const chars = p.stateIds.map(id => state.characters[id]).filter(Boolean);
    const manual = chars.some(c => (c._manualFields || []).length > 0);
    const loreDeclared = p.loreEntry && (parseMetadata(p.loreEntry.text).type || '').trim().toLowerCase() === 'character';
    const linkedType = loreTypeOf(p.loreEntry?.displayName) || chars.map(c => loreTypeOf(c.loreEntryName)).find(Boolean) || null;
    const key = reader.nameKey(p.name);
    let reason = null;
    if (removedKeys.has(key)) reason = 'deleted by you';
    else if (manual) reason = null;
    else if (!loreDeclared && classKeys.has(key)) reason = 'a class';
    else if (!p.loreEntry && p.ambiguous) reason = 'a surname several people share';
    else if (!loreDeclared && !p.sources.has('story') && thingKeys.has(key)) reason = 'a skill or item';
    else if (linkedType && linkedType !== 'character' && linkedType !== 'unknown') reason = `lorebook @type ${linkedType}`;
    else if (!p.sources.has('story') && !namedInStory(p)) {
      // The tracker follows the story: a lorebook or old tracker name the story
      // never uses is not tracked (the lorebook itself is left alone). While
      // some chunks are unread, keep what is already tracked.
      if (!chars.length) reason = 'skip';
      else if (allRead) reason = 'not named in the story';
    }
    if (reason) {
      if (reason !== 'skip') for (const id of p.stateIds) if (state.characters[id]) { removed.push({ name: state.characters[id].name, reason }); dropIds.add(id); }
      continue;
    }
    kept.push(p);
  }

  // Apply: one tracked character per person.
  const idMap = new Map();      // dropped or merged id -> keeper id (or null)
  const personIds = new Map();  // roster person -> tracked character id
  const merged = [];
  let added = 0, changedFields = 0;
  const now = Date.now();
  for (const p of kept) {
    const ids = p.stateIds.filter(id => state.characters[id]);
    let keeperId = ids.find(id => state.characters[id].portraitPath)
      || ids.find(id => p.loreEntry && state.characters[id].loreEntryName === p.loreEntry.displayName)
      || ids[0];
    if (!keeperId) {
      keeperId = generateRpgId('char');
      state.characters[keeperId] = {
        id: keeperId, name: p.name, loreEntryName: null, aliases: [],
        isPartyMember: false, isNPC: true, partyRole: null, relationships: [], lastUpdated: now,
      };
      added++;
    }
    const char = state.characters[keeperId];
    personIds.set(p, keeperId);
    for (const id of ids) {
      if (id === keeperId) continue;
      mergeCharacterInto(char, state.characters[id]);
      merged.push({ into: p.loreEntry?.displayName || p.name, from: state.characters[id].name });
      idMap.set(id, keeperId);
      delete state.characters[id];
    }
    const manualFields = new Set(char._manualFields || []);
    if (!manualFields.has('name')) char.name = p.loreEntry?.displayName || p.name;
    if (p.loreEntry) char.loreEntryName = p.loreEntry.displayName;
    char.id = keeperId;
    char.aliases = [...new Set([...(char.aliases || []), ...p.aliases])].filter(a => a && a !== char.name && !isNarratorPlaceholder(a));
    if (p.kinds.has('voice') && !p.kinds.has('person')) char.isVoice = true;

    const sheet = fold.sheets.get(p) || reader.emptySheet();
    const prevLevel = char.level;
    for (const f of reader.SHEET_FIELDS) {
      if (manualFields.has(f)) continue;
      let v = sheet[f];
      if (f === 'xp' && !v) v = { current: null, needed: null };
      if (JSON.stringify(char[f] ?? null) !== JSON.stringify(v ?? null)) changedFields++;
      char[f] = v;
    }
    if (!manualFields.has('level') && char.level != null && char.level !== prevLevel) {
      char.levelHistory = [...(char.levelHistory || []), { level: char.level, timestamp: now }];
    }
    char.rpgEvidence = sheet.evidence;

    // Protagonist and team membership the story states
    const sfManual = manualFields.has('storyFunction');
    if (p === prot.person) {
      char.isProtagonist = true;
      char.isPartyMember = true;
      char.isNPC = false;
      if (!PARTY_SIDE_ROLES.has(char.partyRole)) char.partyRole = 'party-member';
      if (!sfManual) char.narrative = { ...CHARACTER_PERSONA_DEFAULTS.narrative, ...(char.narrative || {}), storyFunction: 'protagonist' };
    } else {
      char.isProtagonist = false;
      if (prot.person && !sfManual && char.narrative?.storyFunction === 'protagonist') char.narrative = { ...char.narrative, storyFunction: null };
      if (p.team && p.team.value === true) {
        char.isPartyMember = true;
        char.isNPC = false;
        if (!PARTY_SIDE_ROLES.has(char.partyRole)) char.partyRole = p.kinds.has('creature') && !p.kinds.has('person') ? 'pet' : 'party-member';
      }
    }
    char.lastUpdated = now;
  }

  // Drop characters that are not people, and remap references to merged ids.
  for (const [id, c] of Object.entries(state.characters)) {
    if (isNarratorPlaceholder(c.name) && !(c._manualFields || []).length) { removed.push({ name: c.name, reason: 'the narrator, not a name' }); dropIds.add(id); }
  }
  for (const id of dropIds) {
    idMap.set(id, null);
    delete state.characters[id];
  }
  const mapId = (id) => (idMap.has(id) ? idMap.get(id) : id);
  state.party.members = [...new Set((state.party.members || []).map(mapId).filter(id => id && state.characters[id]))];
  for (const c of Object.values(state.characters)) {
    for (const r of c.relationships || []) if (r.targetId && idMap.has(r.targetId)) r.targetId = idMap.get(r.targetId);
  }
  // Character review cards from earlier scans would undo these corrections.
  state.pendingUpdates = (state.pendingUpdates || []).filter(u => u.type !== 'character');

  // Classes: everything the story names as a class, plus ones edited by hand.
  const oldClasses = Object.values(state.classes || {});
  const usedClassIds = new Set();
  const classes = {};
  for (const c of fold.classes.values()) {
    const ex = oldClasses.find(o => !usedClassIds.has(o.id) && fuzzyNameScore(o.name, c.name) >= 0.8);
    const id = ex?.id || generateRpgId('class');
    usedClassIds.add(id);
    classes[id] = {
      ...(ex || {}),
      id,
      name: ex?._manuallyEdited ? ex.name : c.name,
      description: ex?._manuallyEdited ? ex.description : (c.description || ex?.description || null),
      requirements: c.requirements || ex?.requirements || null,
      type: ex?.type || 'class',
      parentClass: ex?.parentClass || null,
      lastUpdated: now,
    };
  }
  for (const o of oldClasses) if (o._manuallyEdited && !usedClassIds.has(o.id)) classes[o.id] = o;
  for (const cls of Object.values(classes)) {
    cls.practitioners = Object.values(state.characters)
      .filter(ch => [ch.class, ch.subclass].some(n => n && fuzzyNameScore(n, cls.name) >= 0.8))
      .map(ch => ch.name);
  }
  state.classes = classes;

  // Races: drop ones nobody has any more (unless edited by hand), then add new ones.
  for (const [id, race] of Object.entries(state.races || {})) {
    const members = Object.values(state.characters).filter(ch => ch.race && fuzzyNameScore(ch.race, race.name) >= 0.8).map(ch => ch.name);
    if (!members.length && !race._manuallyEdited) delete state.races[id];
    else race.knownMembers = members;
  }
  consolidateRaces(state);

  // Quests stated by the story.
  let questsAdded = 0;
  for (const q of fold.quests) {
    const ex = Object.values(state.quests).find(o => reader.sameQuest(o.title, q.title));
    // Whose quest it is: the character it was given to, normally the player.
    const ownerId = (q.owner && personIds.get(q.owner)) || null;
    if (ex) {
      if (!ex._ownerManual) ex.ownerId = ownerId;
      if (q.status !== 'active' && ex.status === 'active') { ex.status = q.status; ex.completedAt = now; }
      for (const o of q.objectives) {
        const eo = ex.objectives.find(x => fuzzyNameScore(x.text, o.text) >= 0.8);
        if (!eo) ex.objectives.push(o);
        else if (o.completed) eo.completed = true;
      }
      ex.lastUpdated = now;
    } else {
      const id = generateRpgId('quest');
      state.quests[id] = {
        id, title: q.title, description: '', status: q.status, type: 'side', ownerId,
        objectives: q.objectives, rewards: null, giver: q.giver || null, location: null,
        discoveredAt: now, completedAt: q.status === 'active' ? null : now, lastUpdated: now,
      };
      questsAdded++;
    }
  }

  const protChar = prot.person ? Object.values(state.characters).find(c => c.isProtagonist) : null;
  state.protagonist = {
    characterId: protChar?.id || null,
    name: protChar?.name || null,
    pov: prot.pov,
    source: protChar ? prot.source : null,
    // Where the story hands the player role to someone new (part = chunk + 1).
    history: (prot.history || []).map(h => {
      const id = personIds.get(h.person);
      return { characterId: id || null, name: (id && state.characters[id]?.name) || h.person.name, part: h.chunk == null ? null : h.chunk + 1, source: h.source };
    }),
  };

  const summary = {
    startedAt: start,
    duration: Date.now() - start,
    chunks: read.total,
    read: read.read,
    cached: read.total - read.read - read.failed,
    failed: read.failed,
    droppedUnsupported: read.dropped,
    unattributedEvents: fold.unattributed,
    characters: Object.keys(state.characters).length,
    added,
    merged,
    removed,
    changedFields,
    classes: Object.keys(state.classes).length,
    questsAdded,
    protagonist: state.protagonist,
    attempted: read.read + read.failed,
    succeeded: read.read,
    skipped: read.total - read.read - read.failed,
  };
  report.passes.R1 = summary;
  report.counts.attempted += summary.attempted;
  report.counts.succeeded += summary.succeeded;
  report.counts.failed += read.failed;
  report.counts.skipped += summary.skipped;

  console.log(`${LOG_PREFIX} R1: ${read.total} chunks (${read.read} read, ${summary.cached} cached, ${read.failed} failed); ${summary.characters} characters (+${added}), ${merged.length} merged, ${removed.length} removed, ${changedFields} fields corrected; protagonist ${state.protagonist.name || 'unknown'} (${prot.pov} person, ${state.protagonist.source || '-'})`);
  for (const m of merged) console.log(`${LOG_PREFIX} R1: merged "${m.from}" into "${m.into}"`);
  for (const r of removed) console.log(`${LOG_PREFIX} R1: removed "${r.name}" (${r.reason})`);
  return summary;
}

/**
 * Pass R3: Party & NPC Classification (with metadata anchoring)
 */
async function r3_classifyParty(ctx) {
  const { state, scanText, loreEntries, providers, comprehensionContext, systemType, onProgress, report } = ctx;
  const r3Start = Date.now();
  let r3Succeeded = 0, r3Failed = 0, r3Skipped = 0;
  const allChars = Object.values(state.characters);
  // Only classify characters who appear in the story text
  const charsInStory = allChars.filter(c => {
    const names = [c.name, c.loreEntryName, ...(c.aliases || [])];
    return characterAppearsInText(c.name, names, scanText);
  });
  const charsNotInStory = allChars.filter(c => {
    const names = [c.name, c.loreEntryName, ...(c.aliases || [])];
    return !characterAppearsInText(c.name, names, scanText);
  });
  r3Skipped = charsNotInStory.length;

  if (charsNotInStory.length > 0) {
    console.log(`${LOG_PREFIX} R3: Skipping ${charsNotInStory.length} characters not in story text: ${charsNotInStory.map(c => c.name).join(', ')}`);
  }

  if (charsInStory.length > 0) {
    if (onProgress) onProgress({ phase: 'party', current: 0, total: 1, subPhase: 'R3-classification', passStartedAt: r3Start, errorCount: report.errors.length });
    console.log(`${LOG_PREFIX} R3: Classifying party/NPCs for ${charsInStory.length} characters (${charsNotInStory.length} skipped)`);

    // Build enriched character data with @role metadata from lorebook entries
    const enrichedChars = charsInStory.map(c => {
      // Find matching lorebook entry and read @role metadata
      let currentRole = null;
      if (c.loreEntryName) {
        const loreEntry = loreEntries.find(e =>
          e.displayName === c.loreEntryName || fuzzyNameScore(e.displayName, c.name) >= 0.8
        );
        if (loreEntry) {
          const meta = parseMetadata(loreEntry.text);
          if (meta.role && VALID_ROLES.has(meta.role)) currentRole = meta.role;
        }
      }
      // Fall back to existing state flags
      if (!currentRole) {
        if (c.isPartyMember) currentRole = c.partyRole || 'party-member';
        else if (c.isNPC) currentRole = 'npc';
      }
      return {
        name: c.name,
        level: c.level,
        class: c.class,
        role: c.role, // combat role (tank/healer/dps)
        currentRole,  // @role metadata or state-derived
      };
    });

    const classification = await retryLLM(
      () => callWithFallback(providers, 0, (p) =>
        classifyPartyAndNPCs(enrichedChars, scanText, p, comprehensionContext, systemType, state.protagonist?.name || null)
      ),
      { maxRetries: 1, passName: 'R3-classification', onRetry: (attempt, category, message) => {
        report.errors.push({ pass: 'R3', category, message, timestamp: Date.now() });
      }}
    );

    // Track which characters were classified (for default-to-NPC)
    const classifiedIds = new Set();
    const roleUpdates = []; // {charName, loreEntryName, role} — for lorebook sync

    if (classification) {
      r3Succeeded = 1;
      // Apply party-side classifications
      for (const pm of (classification.partyMembers || [])) {
        const matchId = fuzzyMatchCharacter(pm.name, state.characters);
        if (matchId) {
          classifiedIds.add(matchId);
          const char = state.characters[matchId];
          char.isPartyMember = true;
          char.isNPC = false;
          char.partyRole = pm.role || 'party-member';
          if (char.loreEntryName) {
            roleUpdates.push({ charName: char.name, loreEntryName: char.loreEntryName, role: char.partyRole });
          }
        }
      }

      // Apply NPC classifications
      for (const npc of (classification.npcs || [])) {
        if (!npc.name) continue;
        const matchId = fuzzyMatchCharacter(npc.name, state.characters);
        if (matchId && matchId === state.protagonist?.characterId) { classifiedIds.add(matchId); continue; }
        if (matchId) {
          classifiedIds.add(matchId);
          const char = state.characters[matchId];
          char.isPartyMember = false;
          char.isNPC = true;
          char.partyRole = null;
          char.faction = npc.faction || char.faction;
          char.disposition = npc.disposition || char.disposition;
          if (npc.npcRole) char.npcRole = npc.npcRole;
          if (npc.relationship) char.npcRelationship = npc.relationship;
          if (char.loreEntryName) {
            roleUpdates.push({ charName: char.name, loreEntryName: char.loreEntryName, role: 'npc' });
          }
        }
      }

      // Default unclassified characters to NPC, but remove non-character entries that slipped through
      for (const [id, char] of Object.entries(state.characters)) {
        if (!classifiedIds.has(id) && !char.isPartyMember && !char.isNPC) {
          // If we have a lorebook entry with a non-character @type, remove from tracking
          if (char.loreEntryName) {
            const loreEntry = loreEntries.find(e => e.displayName === char.loreEntryName);
            if (loreEntry) {
              const entryType = getEntryType(loreEntry.text, loreEntry.displayName);
              // Any @type other than character, built-in or custom ("class"), is not a person.
              if (entryType !== 'character' && entryType !== 'unknown') {
                console.log(`${LOG_PREFIX} R3: Removing non-character "${char.name}" (@type: ${entryType}) from tracking`);
                delete state.characters[id];
                continue;
              }
            }
          }
          char.isNPC = true;
          char.partyRole = null;
          console.log(`${LOG_PREFIX} R3: Defaulting unclassified "${char.name}" to NPC`);
        }
      }

      // Update party members list
      // The protagonist is always on their own side.
      const prot = state.protagonist?.characterId && state.characters[state.protagonist.characterId];
      if (prot) { prot.isPartyMember = true; prot.isNPC = false; if (!PARTY_SIDE_ROLES.has(prot.partyRole)) prot.partyRole = 'party-member'; }

      state.party.members = Object.entries(state.characters)
        .filter(([, c]) => c.isPartyMember)
        .map(([id]) => id);
      state.party.lastUpdated = Date.now();
    } else {
      r3Failed = 1;
    }

    // Store role updates for renderer to apply to lorebook
    state._pendingRoleUpdates = roleUpdates;

    if (onProgress) onProgress({ phase: 'party', current: 1, total: 1, subPhase: 'R3-classification', passStartedAt: r3Start, errorCount: report.errors.length });
  }

  report.passes.R3 = {
    startedAt: r3Start,
    duration: Date.now() - r3Start,
    attempted: charsInStory.length > 0 ? 1 : 0,
    succeeded: r3Succeeded,
    failed: r3Failed,
    skipped: r3Skipped,
  };
  report.counts.attempted += (charsInStory.length > 0 ? 1 : 0);
  report.counts.succeeded += r3Succeeded;
  report.counts.failed += r3Failed;
  report.counts.skipped += r3Skipped;

  // Consolidate factions after R3 classification (zero LLM calls)
  consolidateFactions(state);
}

// --- Relationship type classification keywords ---
const REL_FAMILY_KEYWORDS = new Set([
  'sister', 'brother', 'father', 'mother', 'daughter', 'son', 'wife', 'husband',
  'parent', 'child', 'sibling', 'cousin', 'uncle', 'aunt', 'nephew', 'niece',
  'grandfather', 'grandmother', 'grandson', 'granddaughter', 'spouse', 'fiancé',
  'fiancée', 'twin', 'half-brother', 'half-sister', 'stepfather', 'stepmother',
]);
const REL_RIVAL_KEYWORDS = new Set([
  'rival', 'enemy', 'nemesis', 'antagonist', 'adversary', 'opponent', 'foe',
]);
const REL_ALLY_KEYWORDS = new Set([
  'ally', 'friend', 'companion', 'partner', 'comrade', 'confidant',
]);
const REL_MENTOR_KEYWORDS = new Set([
  'mentor', 'student', 'teacher', 'apprentice', 'master', 'disciple', 'pupil',
]);

function classifyRelationshipType(label) {
  const lower = label.toLowerCase();
  const words = lower.split(/[\s,\-/]+/);
  for (const w of words) {
    if (REL_FAMILY_KEYWORDS.has(w)) return 'family';
    if (REL_RIVAL_KEYWORDS.has(w)) return 'rival';
    if (REL_ALLY_KEYWORDS.has(w)) return 'ally';
    if (REL_MENTOR_KEYWORDS.has(w)) return 'mentor';
  }
  return 'other';
}

/**
 * Pass R3c: Extract structured inter-character relationships from lorebook entry text.
 * Zero LLM calls — pure text parsing of Relationships/Family fields.
 */
function r3c_extractInterCharRelationships(ctx) {
  const { state, characterEntries } = ctx;
  const LINE_RE = /^-\s+(.+?):\s+(.+)$/;
  let totalEdges = 0;

  for (const entry of characterEntries) {
    const charId = fuzzyMatchCharacter(entry.displayName, state.characters);
    if (!charId) continue;
    const char = state.characters[charId];

    const relText = extractField(entry.text, 'Relationships') || '';
    const famText = extractField(entry.text, 'Family') || '';

    const edges = [];
    const seenTargets = new Set();

    for (const [fieldText, fieldSource] of [[relText, 'relationship'], [famText, 'family']]) {
      for (const line of fieldText.split('\n')) {
        const m = line.trim().match(LINE_RE);
        if (!m) continue;
        const targetName = m[1].trim();
        const label = m[2].trim();
        if (!targetName || !label) continue;

        const targetKey = targetName.toLowerCase();
        if (seenTargets.has(targetKey)) continue;
        seenTargets.add(targetKey);

        const targetId = fuzzyMatchCharacter(targetName, state.characters);
        // Skip self-references
        if (targetId === charId) continue;

        const type = fieldSource === 'family' ? 'family' : classifyRelationshipType(label);
        edges.push({ targetName, targetId, type, label });
      }
    }

    char.relationships = edges;
    totalEdges += edges.length;
  }

  if (totalEdges > 0) {
    console.log(`${LOG_PREFIX} R3c: Extracted ${totalEdges} inter-character relationships`);
  }
}

/**
 * Pass R4: Lore Element Extraction (classes, equipment, factions, quests -> lore entries)
 */
async function r4_extractLoreElements(ctx) {
  const { state, scanText, generateTextFn, loreEntries, comprehensionContext, systemType, onProgress, report } = ctx;
  const r4Start = Date.now();
  let r4Succeeded = 0, r4Failed = 0;
  const r4Collection = collectR4Elements(state, loreEntries);
  if (r4Collection.elements.length > 0) {
    if (onProgress) onProgress({ phase: 'lore-elements', current: 0, total: r4Collection.elements.length, subPhase: 'R4-lore-elements', passStartedAt: r4Start, errorCount: report.errors.length });
    console.log(`${LOG_PREFIX} R4: Generating lore entries for ${r4Collection.elements.length} RPG elements${r4Collection.skipped > 0 ? ` (${r4Collection.skipped} skipped)` : ''}`);
    await delay(INTER_CALL_DELAY);
    const r4Entries = await generateLoreElementEntries(
      r4Collection.elements, scanText, generateTextFn, comprehensionContext, systemType
    );
    if (r4Entries && r4Entries.length > 0) {
      state._pendingLoreEntries = r4Entries;
      r4Succeeded = r4Entries.length;
      console.log(`${LOG_PREFIX} R4: Generated ${r4Entries.length} lore entries`);
    } else {
      r4Failed = 1;
    }
    if (onProgress) onProgress({ phase: 'lore-elements', current: r4Collection.elements.length, total: r4Collection.elements.length, subPhase: 'R4-lore-elements', passStartedAt: r4Start, errorCount: report.errors.length });
  }
  if (r4Collection.skipped > 0) {
    state._r4Skipped = r4Collection.skipped;
  }

  report.passes.R4 = {
    startedAt: r4Start,
    duration: Date.now() - r4Start,
    attempted: r4Collection.elements.length,
    succeeded: r4Succeeded,
    failed: r4Failed,
    skipped: r4Collection.skipped,
  };
  report.counts.attempted += r4Collection.elements.length;
  report.counts.succeeded += r4Succeeded;
  report.counts.failed += r4Failed;
  report.counts.skipped += r4Collection.skipped;
}

/**
 * Pass R5: Entity Enrichment (factions, classes, races descriptions)
 */
async function r5_enrichDescriptions(ctx) {
  const { state, scanText, generateTextFn, comprehensionContext, systemType, forceReEnrich, onProgress, report } = ctx;
  const r5Start = Date.now();
  if (onProgress) onProgress({ phase: 'enrichment', current: 0, total: 1, subPhase: 'R5-enrichment', passStartedAt: r5Start, errorCount: report.errors.length });
  await delay(INTER_CALL_DELAY);
  await enrichEntityDescriptions(state, scanText, generateTextFn, comprehensionContext, systemType, forceReEnrich);
  if (onProgress) onProgress({ phase: 'enrichment', current: 1, total: 1, subPhase: 'R5-enrichment', passStartedAt: r5Start, errorCount: report.errors.length });

  report.passes.R5 = {
    startedAt: r5Start,
    duration: Date.now() - r5Start,
    attempted: 1,
    succeeded: 1,
    failed: 0,
    skipped: 0,
  };
  report.counts.attempted += 1;
  report.counts.succeeded += 1;
}

// ============================================================================
// SCAN ORCHESTRATOR (Phase 2 — Incremental Scanning)
// ============================================================================

async function scanForRPGData(storyText, rpgState, loreEntries, generateTextFn, onProgress, comprehensionContext, secondaryGenerateTextFn, options = {}) {
  const { forceReEnrich = false } = options;
  // options.manual: the user pressed Scan. options.fullRescan: forget cached reads and reread everything.
  const state = { ...LITRPG_STATE_DEFAULTS, ...rpgState };
  migrateLitrpgState(state);
  const systemType = state.systemType || 'generic';
  const preR1CharIds = new Set(Object.keys(state.characters || {}));

  // --- Scan Report (Phase 6.1) ---
  const report = {
    startedAt: Date.now(),
    completedAt: null,
    duration: null,
    passes: {},
    counts: { attempted: 0, succeeded: 0, failed: 0, skipped: 0 },
    errors: [],
    summary: '',
  };

  const characterEntries = loreEntries.filter(isCharacterLoreEntry);

  const providers = secondaryGenerateTextFn
    ? [generateTextFn, secondaryGenerateTextFn]
    : [generateTextFn];

  // R3-R5 work from the recent part of the story; R1 reads all of it.
  const scanText = storyText.slice(-RECENT_CONTEXT);

  // Shared context for all R-passes
  const ctx = {
    state, storyText, scanText, loreEntries, characterEntries,
    generateTextFn, providers, comprehensionContext, systemType,
    onProgress, report, forceReEnrich, options,
  };

  // --- R1: read the whole story (cached per chunk), rebuild cast and sheets ---
  const r1 = await r1_readWholeStory(ctx);
  const newCharacterIds = Object.keys(state.characters || {}).filter(id => !preR1CharIds.has(id));

  // Nothing changed in the story since the last scan: the sheets are already
  // rebuilt from the cache, and the LLM passes below would repeat themselves.
  const nothingNew = r1.read === 0 && r1.failed === 0 && !options.manual && !options.fullRescan && state.lastScanAt;
  if (!nothingNew) {
    // --- R3: Party & NPC Classification ---
    await delay(INTER_CALL_DELAY);
    await r3_classifyParty(ctx);

    // --- R3c: Extract structured inter-character relationships (no LLM) ---
    r3c_extractInterCharRelationships(ctx);

    // --- R4: Lore Element Extraction ---
    await r4_extractLoreElements(ctx);

    // --- R5: Entity Enrichment ---
    await r5_enrichDescriptions(ctx);
  } else {
    console.log(`${LOG_PREFIX} No story text changed since the last scan - skipping R3-R5`);
  }

  // --- Finalize ---
  state.lastProcessedLength = storyText.length;
  state.lastScanAt = Date.now();
  state.charsSinceLastScan = 0;

  // --- Finalize report (Phase 6.1) ---
  report.completedAt = Date.now();
  report.duration = report.completedAt - report.startedAt;
  report.summary = `Scan completed in ${Math.round(report.duration / 1000)}s: ${Object.keys(state.characters).length} characters, ${Object.keys(state.quests).length} quests, ${state.pendingUpdates.length} pending updates`;

  // --- Scan History (Phase 6.5) ---
  if (!state.scanHistory) state.scanHistory = [];
  state.scanHistory.unshift({
    timestamp: report.startedAt,
    duration: report.duration,
    summary: report.summary,
    passes: Object.fromEntries(
      Object.entries(report.passes).map(([k, v]) => [k, { duration: v.duration, attempted: v.attempted, succeeded: v.succeeded }])
    ),
    errorCount: report.errors.length,
  });
  // Cap at 20
  if (state.scanHistory.length > 20) state.scanHistory.length = 20;

  if (onProgress) onProgress({ phase: 'complete' });
  console.log(`${LOG_PREFIX} ${report.summary}`);

  return { state, report, newCharacterIds };
}

// ============================================================================
// PENDING UPDATE ACTIONS
// ============================================================================

function acceptPendingUpdate(rpgState, updateId) {
  const state = { ...rpgState };
  const updateIdx = state.pendingUpdates.findIndex(u => u.id === updateId);
  if (updateIdx < 0) return state;

  const update = state.pendingUpdates[updateIdx];

  if (update.type === 'character') {
    state.characters[update.characterId] = update.after;
  } else if (update.type === 'quest_status') {
    const quest = state.quests[update.questId];
    if (quest) {
      quest.status = update.newStatus;
      quest.lastUpdated = Date.now();
      if (update.newStatus === 'completed') quest.completedAt = Date.now();
    }
  } else if (update.type === 'quest_objective') {
    const quest = state.quests[update.questId];
    if (quest) {
      const obj = quest.objectives.find(o => o.text === update.objectiveText);
      if (obj) obj.completed = true;
      quest.lastUpdated = Date.now();
    }
  }

  state.pendingUpdates.splice(updateIdx, 1);
  return state;
}

function rejectPendingUpdate(rpgState, updateId) {
  const state = { ...rpgState };
  state.pendingUpdates = state.pendingUpdates.filter(u => u.id !== updateId);
  return state;
}

function acceptAllPendingUpdates(rpgState) {
  let state = { ...rpgState };
  const updates = [...(state.pendingUpdates || [])];
  for (const update of updates) {
    state = acceptPendingUpdate(state, update.id);
  }
  return state;
}

function rejectAllPendingUpdates(rpgState) {
  const state = { ...rpgState };
  state.pendingUpdates = [];
  return state;
}

// ============================================================================
// LOREBOOK TEXT BUILDER (Phase 6A)
// ============================================================================

const LITRPG_CHARACTER_TEMPLATE = `Name: [Full name, including last name]
Race: [Race, if applicable]
Class: [Class and subclass]
Level: [Current level]
XP: [Current XP / XP needed for next level]
Cultivation Realm: [Cultivation realm and stage, if applicable]
Age: [Age or approximate age]
Gender: [Gender identity]
Physical Appearance: [Detailed physical description]
Sexuality: [Sexual orientation and interests, if relevant]
Description: [Personality, role, and key traits]
Self-Image: [How they see themselves; self-perception vs reality]
Motivations/Goals: [What drives them; what they want]
Secrets: [Hidden knowledge, lies, concealed truths]
Stats: [Key stats, e.g. STR 18, DEX 14, INT 20]
Abilities:
- [Ability Name]: [Brief description]
Equipment:
- [Item Name]: [Slot, key properties]
Inventory:
- [Item Name]: [Quantity, type]
Currency: [Currency amounts, e.g. 1500 gold, 200 silver]
Status Effects: [Active buffs/debuffs]
Relationships:
- [Name]: [relationship type and dynamic]
Family:
- [Name]: [family role, e.g. sister, father]
Background: [History and backstory]
Additional notes: [Any other relevant details]`;

function spliceField(text, fieldName, value) {
  if (value === null || value === undefined || value === '') return text;
  const fieldPattern = new RegExp(`^${fieldName}:.*$`, 'm');
  const replacement = `${fieldName}: ${value}`;

  if (fieldPattern.test(text)) {
    return text.replace(fieldPattern, replacement);
  }

  const templateOrder = [
    'Name', 'Race', 'Class', 'Level', 'XP', 'Cultivation Realm',
    'Age', 'Gender', 'Physical Appearance', 'Sexuality', 'Description', 'Self-Image',
    'Motivations/Goals', 'Secrets', 'Stats', 'Abilities', 'Equipment',
    'Inventory', 'Currency', 'Status Effects',
    'Relationships', 'Family', 'Background', 'Additional notes',
  ];

  const targetIdx = templateOrder.indexOf(fieldName);
  if (targetIdx < 0) {
    return text.trimEnd() + `\n${replacement}`;
  }

  for (let i = targetIdx + 1; i < templateOrder.length; i++) {
    const nextField = templateOrder[i];
    const nextPattern = new RegExp(`^${nextField.replace('/', '\\/')}:`, 'm');
    const match = text.match(nextPattern);
    if (match) {
      const insertPos = text.indexOf(match[0]);
      return text.slice(0, insertPos) + replacement + '\n' + text.slice(insertPos);
    }
  }

  return text.trimEnd() + `\n${replacement}`;
}

function spliceSection(text, sectionName, content) {
  if (!content) return text;
  const sectionPattern = new RegExp(`^${sectionName}:.*(?:\\n(?:\\s*-\\s+.*|\\s*))*$`, 'm');

  if (sectionPattern.test(text)) {
    return text.replace(sectionPattern, `${sectionName}:\n${content}`);
  }

  const templateOrder = [
    'Name', 'Race', 'Class', 'Level', 'XP', 'Cultivation Realm',
    'Age', 'Gender', 'Physical Appearance', 'Sexuality', 'Description', 'Self-Image',
    'Motivations/Goals', 'Secrets', 'Stats', 'Abilities', 'Equipment',
    'Inventory', 'Currency', 'Status Effects',
    'Relationships', 'Family', 'Background', 'Additional notes',
  ];

  const targetIdx = templateOrder.indexOf(sectionName);
  for (let i = targetIdx + 1; i < templateOrder.length; i++) {
    const nextField = templateOrder[i];
    const nextPattern = new RegExp(`^${nextField.replace('/', '\\/')}:`, 'm');
    const match = text.match(nextPattern);
    if (match) {
      const insertPos = text.indexOf(match[0]);
      return text.slice(0, insertPos) + `${sectionName}:\n${content}\n` + text.slice(insertPos);
    }
  }

  return text.trimEnd() + `\n${sectionName}:\n${content}`;
}

function buildLitRPGCharacterText(entryText, rpgData) {
  let text = entryText;

  text = spliceField(text, 'Race', rpgData.race);
  text = spliceField(text, 'Class', [rpgData.class, rpgData.subclass].filter(Boolean).join(' / ') || null);
  text = spliceField(text, 'Level', rpgData.level != null ? String(rpgData.level) : null);

  // XP
  if (rpgData.xp && (rpgData.xp.current != null || rpgData.xp.needed != null)) {
    const xpStr = [
      rpgData.xp.current != null ? String(rpgData.xp.current) : '?',
      rpgData.xp.needed != null ? String(rpgData.xp.needed) : '?',
    ].join(' / ');
    text = spliceField(text, 'XP', xpStr);
  }

  // Cultivation
  if (rpgData.cultivationRealm) {
    const cultStr = [rpgData.cultivationRealm, rpgData.cultivationStage].filter(Boolean).join(', ');
    text = spliceField(text, 'Cultivation Realm', cultStr);
  }

  // Stats
  if (rpgData.stats && Object.keys(rpgData.stats).length > 0) {
    const statsStr = Object.entries(rpgData.stats)
      .map(([k, v]) => `${k} ${v.value}`)
      .join(', ');
    text = spliceField(text, 'Stats', statsStr);
  }

  // Abilities
  if (rpgData.abilities && rpgData.abilities.length > 0) {
    const abilitiesStr = rpgData.abilities
      .map(a => {
        let line = `- ${a.name}: ${a.description}`;
        const tags = [];
        if (a.category) tags.push(a.category);
        if (a.cost) tags.push(a.cost);
        if (a.cooldown) tags.push(`CD: ${a.cooldown}`);
        if (a.proficiency) tags.push(a.proficiency);
        if (tags.length > 0) line += ` [${tags.join(', ')}]`;
        return line;
      })
      .join('\n');
    text = spliceSection(text, 'Abilities', abilitiesStr);
  }

  // Equipment
  if (rpgData.equipment && rpgData.equipment.length > 0) {
    const equipStr = rpgData.equipment
      .map(e => {
        let line = `- ${e.name}: ${e.slot}`;
        if (e.rarity && e.rarity !== 'unknown') line += ` (${e.rarity})`;
        if (e.bonuses) line += ` {${e.bonuses}}`;
        if (e.setName) line += ` [Set: ${e.setName}]`;
        line += `, ${e.description}`;
        return line;
      })
      .join('\n');
    text = spliceSection(text, 'Equipment', equipStr);
  }

  // Inventory
  if (rpgData.inventory && rpgData.inventory.length > 0) {
    const invStr = rpgData.inventory
      .map(i => {
        let line = `- ${i.name}: ${i.quantity}x (${i.type})`;
        if (i.rarity) line += ` [${i.rarity}]`;
        return line;
      })
      .join('\n');
    text = spliceSection(text, 'Inventory', invStr);
  }

  // Currency
  if (rpgData.currency && Object.keys(rpgData.currency).length > 0) {
    const currStr = Object.entries(rpgData.currency)
      .map(([unit, amount]) => `${amount} ${unit}`)
      .join(', ');
    text = spliceField(text, 'Currency', currStr);
  }

  // Status Effects
  if (rpgData.statusEffects && rpgData.statusEffects.length > 0) {
    const statusStr = rpgData.statusEffects
      .map(s => `${s.name} (${s.type})${s.duration ? ` [${s.duration}]` : ''}`)
      .join(', ');
    text = spliceField(text, 'Status Effects', statusStr);
  }

  return text;
}

/**
 * Parse RPG data from a structured lorebook entry text.
 * Inverse of buildLitRPGCharacterText() — reads fields back into an RPG data object.
 */
function parseRPGFromEntryText(text) {
  if (!text) return null;

  // Strip metadata header if present
  const { rest } = parseMetadata(text);
  const src = rest || text;

  const rpg = {};

  // Class / Subclass
  const classField = extractField(src, 'Class');
  if (classField) {
    const parts = classField.split('/').map(s => s.trim());
    rpg.class = parts[0] || null;
    rpg.subclass = parts[1] || null;
  }

  // Level
  const levelField = extractField(src, 'Level');
  if (levelField) {
    const num = parseInt(levelField, 10);
    if (!isNaN(num)) rpg.level = num;
  }

  // Race
  const raceField = extractField(src, 'Race');
  if (raceField) rpg.race = raceField;

  // XP
  const xpField = extractField(src, 'XP');
  if (xpField) {
    const xpParts = xpField.split('/').map(s => s.trim());
    rpg.xp = {};
    const cur = parseInt(xpParts[0], 10);
    if (!isNaN(cur)) rpg.xp.current = cur;
    if (xpParts[1]) {
      const needed = parseInt(xpParts[1], 10);
      if (!isNaN(needed)) rpg.xp.needed = needed;
    }
  }

  // Cultivation
  const cultField = extractField(src, 'Cultivation Realm');
  if (cultField) {
    const cultParts = cultField.split(',').map(s => s.trim());
    rpg.cultivationRealm = cultParts[0] || null;
    rpg.cultivationStage = cultParts[1] || null;
  }

  // Stats — "STR 18, DEX 14, CON 16"
  const statsField = extractField(src, 'Stats');
  if (statsField) {
    rpg.stats = {};
    const statPairs = statsField.split(',').map(s => s.trim());
    for (const pair of statPairs) {
      const m = pair.match(/^(\S+)\s+(\d+)/);
      if (m) rpg.stats[m[1]] = { value: parseInt(m[2], 10) };
    }
  }

  // Abilities — multi-line "- Name: description [category, cost, CD: cooldown, proficiency]"
  const abilitiesField = extractField(src, 'Abilities');
  if (abilitiesField) {
    rpg.abilities = [];
    const lines = abilitiesField.split('\n');
    for (const line of lines) {
      const m = line.match(/^-\s*([^:]+):\s*(.+?)(?:\s*\[([^\]]+)\])?$/);
      if (m) {
        const ability = { name: m[1].trim(), description: m[2].trim(), cost: null, category: null, cooldown: null, proficiency: null };
        if (m[3]) {
          const tags = m[3].split(',').map(t => t.trim());
          for (const tag of tags) {
            if (VALID_ABILITY_CATEGORIES.has(tag)) { ability.category = tag; continue; }
            if (tag.startsWith('CD:')) { ability.cooldown = tag.slice(3).trim(); continue; }
            // Remaining tag treated as cost if no cost yet, else proficiency
            if (!ability.cost) ability.cost = tag;
            else ability.proficiency = tag;
          }
        }
        rpg.abilities.push(ability);
      }
    }
  }

  // Equipment — multi-line "- Name: slot (rarity) {bonuses} [Set: setName], description"
  const equipField = extractField(src, 'Equipment');
  if (equipField) {
    rpg.equipment = [];
    const lines = equipField.split('\n');
    for (const line of lines) {
      const m = line.match(/^-\s*([^:]+):\s*(\S+?)(?:\s*\(([^)]+)\))?(?:\s*\{([^}]+)\})?(?:\s*\[Set:\s*([^\]]+)\])?,\s*(.+)$/);
      if (m) {
        rpg.equipment.push({
          name: m[1].trim(), slot: m[2].trim(),
          rarity: m[3] ? m[3].trim() : 'unknown',
          bonuses: m[4] ? m[4].trim() : null,
          setName: m[5] ? m[5].trim() : null,
          description: m[6].trim(),
        });
      }
    }
  }

  // Inventory — multi-line "- Name: Nx (type) [rarity]"
  const invField = extractField(src, 'Inventory');
  if (invField) {
    rpg.inventory = [];
    const lines = invField.split('\n');
    for (const line of lines) {
      const m = line.match(/^-\s*([^:]+):\s*(\d+)x\s*\(([^)]+)\)(?:\s*\[([^\]]+)\])?/);
      if (m) {
        rpg.inventory.push({
          name: m[1].trim(), quantity: parseInt(m[2], 10), type: m[3].trim(),
          rarity: m[4] ? m[4].trim() : null,
        });
      }
    }
  }

  // Currency — "100 gold, 50 silver"
  const currField = extractField(src, 'Currency');
  if (currField) {
    rpg.currency = {};
    const pairs = currField.split(',').map(s => s.trim());
    for (const pair of pairs) {
      const m = pair.match(/^(\d+)\s+(.+)$/);
      if (m) rpg.currency[m[2].trim()] = parseInt(m[1], 10);
    }
  }

  // Status Effects — "Poisoned (debuff) [5 turns], Blessed (buff)"
  const statusField = extractField(src, 'Status Effects');
  if (statusField) {
    rpg.statusEffects = [];
    const effects = statusField.split(',').map(s => s.trim());
    for (const eff of effects) {
      const m = eff.match(/^([^(]+)\s*\(([^)]+)\)(?:\s*\[([^\]]+)\])?/);
      if (m) {
        rpg.statusEffects.push({ name: m[1].trim(), type: m[2].trim(), duration: m[3] || null });
      }
    }
  }

  return rpg;
}

/**
 * Reverse sync: parse RPG data from a lorebook entry and match to existing RPG character.
 * Returns { changed, isNew, parsed, charId, changes }.
 */
function reverseSyncCharacter(entryText, entryName, rpgState) {
  const parsed = parseRPGFromEntryText(entryText);
  if (!parsed || Object.keys(parsed).length === 0) {
    return { changed: false, isNew: false, parsed: null, charId: null, changes: [] };
  }

  const characters = rpgState.characters || {};
  const charId = fuzzyMatchCharacter(entryName, characters);

  if (!charId) {
    return { changed: false, isNew: true, parsed, charId: null, changes: [] };
  }

  const existing = characters[charId];
  const changes = [];

  // Compare top-level scalar fields
  for (const field of ['class', 'subclass', 'level', 'race', 'cultivationRealm', 'cultivationStage']) {
    if (parsed[field] != null && parsed[field] !== existing[field]) {
      changes.push({ field, before: existing[field], after: parsed[field] });
    }
  }

  // Compare XP
  if (parsed.xp) {
    if (parsed.xp.current != null && (!existing.xp || parsed.xp.current !== existing.xp.current)) {
      changes.push({ field: 'xp.current', before: existing.xp?.current, after: parsed.xp.current });
    }
    if (parsed.xp.needed != null && (!existing.xp || parsed.xp.needed !== existing.xp.needed)) {
      changes.push({ field: 'xp.needed', before: existing.xp?.needed, after: parsed.xp.needed });
    }
  }

  // Compare stats
  if (parsed.stats) {
    for (const [stat, val] of Object.entries(parsed.stats)) {
      const existingVal = existing.stats?.[stat]?.value;
      if (val.value !== existingVal) {
        changes.push({ field: `stats.${stat}`, before: existingVal, after: val.value });
      }
    }
  }

  // Compare currency
  if (parsed.currency) {
    for (const [unit, amount] of Object.entries(parsed.currency)) {
      const existingAmount = existing.currency?.[unit];
      if (amount !== existingAmount) {
        changes.push({ field: `currency.${unit}`, before: existingAmount, after: amount });
      }
    }
  }

  // Compare abilities
  if (parsed.abilities && parsed.abilities.length > 0) {
    for (const ability of parsed.abilities) {
      const match = (existing.abilities || []).find(a => fuzzyNameScore(a.name, ability.name) >= 0.8);
      if (!match) {
        changes.push({ field: 'abilities', before: null, after: ability.name, detail: 'new ability' });
      } else {
        if (ability.level != null && ability.level !== match.level) {
          changes.push({ field: `ability.${ability.name}.level`, before: match.level, after: ability.level });
        }
        if (ability.description && ability.description !== match.description) {
          changes.push({ field: `ability.${ability.name}.description`, before: match.description, after: ability.description });
        }
      }
    }
  }

  // Compare equipment
  if (parsed.equipment && parsed.equipment.length > 0) {
    for (const equip of parsed.equipment) {
      const match = (existing.equipment || []).find(e => fuzzyNameScore(e.name, equip.name) >= 0.8);
      if (!match) {
        changes.push({ field: 'equipment', before: null, after: equip.name, detail: `new ${equip.slot || 'equipment'}` });
      } else {
        if (equip.slot && equip.slot !== match.slot) {
          changes.push({ field: `equipment.${equip.name}.slot`, before: match.slot, after: equip.slot });
        }
        if (equip.rarity && equip.rarity !== 'unknown' && equip.rarity !== match.rarity) {
          changes.push({ field: `equipment.${equip.name}.rarity`, before: match.rarity, after: equip.rarity });
        }
      }
    }
  }

  // Compare inventory
  if (parsed.inventory && parsed.inventory.length > 0) {
    for (const item of parsed.inventory) {
      const match = (existing.inventory || []).find(i => fuzzyNameScore(i.name, item.name) >= 0.8);
      if (!match) {
        changes.push({ field: 'inventory', before: null, after: `${item.name} x${item.quantity || 1}`, detail: 'new item' });
      } else if (item.quantity != null && item.quantity !== match.quantity) {
        changes.push({ field: `inventory.${item.name}.quantity`, before: match.quantity, after: item.quantity });
      }
    }
  }

  // Compare status effects
  if (parsed.statusEffects && parsed.statusEffects.length > 0) {
    for (const effect of parsed.statusEffects) {
      const match = (existing.statusEffects || []).find(s => fuzzyNameScore(s.name, effect.name) >= 0.8);
      if (!match) {
        changes.push({ field: 'statusEffects', before: null, after: effect.name, detail: `new ${effect.type || 'effect'}` });
      }
    }
  }

  return { changed: changes.length > 0, isNew: false, parsed, charId, changes };
}

/**
 * Deterministic portrait prompt from visual + RPG data. No LLM call.
 * Returns null if insufficient visual data (< 3 fields populated).
 */
function assemblePortraitPrompt(rpgData) {
  const v = rpgData?.visual || {};
  const race = v.race || rpgData?.race; // visual race preferred, RPG race as fallback
  const fields = [v.hair, v.eyes, v.build, race, v.distinguishingFeatures, v.skinTone, v.clothing];
  const populated = fields.filter(Boolean);
  if (populated.length < 3) return null;

  const parts = ['portrait', 'upper body', 'solo'];
  if (race) parts.push(race);
  if (v.build) parts.push(v.build);
  if (v.hair) parts.push(v.hair);
  if (v.eyes) parts.push(v.eyes);
  if (v.skinTone) parts.push(v.skinTone);

  // Class-appropriate attire from RPG data
  const cls = rpgData?.class;
  if (cls) parts.push(`${cls}-appropriate attire`);

  // Key equipment (max 2 items)
  const equipment = (rpgData?.equipment || []).slice(0, 2).map(e => e.name).filter(Boolean);
  if (equipment.length) parts.push(equipment.join(', '));

  if (v.distinguishingFeatures) parts.push(v.distinguishingFeatures);
  if (v.clothing && !cls) parts.push(v.clothing);

  parts.push('detailed face', 'character art', 'white background');
  return parts.join(', ');
}

async function generatePortraitPrompt(characterEntryText, rpgData, generateTextFn) {
  // Try deterministic assembly first (no LLM cost)
  const deterministic = assemblePortraitPrompt(rpgData);
  if (deterministic) return deterministic;

  // LLM fallback when visual data is sparse
  const equipmentStr = (rpgData?.equipment || []).map(e => e.name).join(', ') || 'none specified';
  const visualHints = rpgData?.visual || {};
  const visualStr = Object.entries(visualHints)
    .filter(([, v]) => v)
    .map(([k, v]) => `${k}: ${v}`)
    .join(', ') || 'no visual data';

  const messages = [
    {
      role: 'system',
      content: 'You create concise character portrait descriptions for AI image generation. Output ONLY the prompt text, no JSON, no quotes.'
    },
    {
      role: 'user',
      content: `Create an AI image generation prompt for a character portrait.

CHARACTER:
${characterEntryText}

VISUAL DATA:
${visualStr}

RPG DATA:
Class: ${rpgData?.class || 'unknown'}
Race: ${rpgData?.race || 'unknown'}
Equipment: ${equipmentStr}

Write a single-line prompt for a fantasy character portrait. Format: "portrait, upper body, solo, [race], [physical descriptors], [class attire], [equipment], detailed face, character art, white background"`
    }
  ];

  try {
    const result = await generateTextFn(messages, { max_tokens: 100, temperature: 0.5 });
    return result.output.replace(/^["']|["']$/g, '').trim();
  } catch (err) {
    console.error(`${LOG_PREFIX} generatePortraitPrompt error:`, err.message);
    return null;
  }
}

// ============================================================================
// ROLE METADATA SYNC
// ============================================================================

/**
 * Build updated entry text with @role metadata set.
 * Returns null if the role is already correct (no update needed).
 */
function buildRoleUpdatePayload(entryText, newRole) {
  if (!VALID_ROLES.has(newRole)) return null;
  const meta = parseMetadata(entryText);
  if (meta.role === newRole) return null; // already correct
  return setMetadata(entryText, { role: newRole });
}

// ============================================================================
// TRANSIENT FIELD HELPERS
// ============================================================================

/**
 * Extract all _-prefixed transient fields from state, removing them from the
 * state object and returning them in a separate object. Used before persisting
 * state to SQLite so transient renderer-only data is not saved.
 */
function extractTransientFields(state) {
  const transient = {};
  for (const key of Object.keys(state)) {
    if (key.startsWith('_')) {
      transient[key] = state[key];
      delete state[key];
    }
  }
  return transient;
}

// =========================================================================
// SMART REVERSE SYNC — confidence scoring & categorization
// =========================================================================

/**
 * Score a single reverse-sync change with confidence level.
 * @param {{ field: string, before: any, after: any }} change
 * @param {object} existingChar - current RPG character data
 * @param {object} parsed - freshly parsed data from lorebook entry
 * @returns {{ ...change, confidence: string, reason: string }}
 */
function scoreReverseSyncChange(change, existingChar, parsed) {
  const { field, before, after } = change;

  // Level increases are almost always story progression
  if (field === 'Level') {
    const oldLevel = typeof before === 'number' ? before : parseInt(before) || 0;
    const newLevel = typeof after === 'number' ? after : parseInt(after) || 0;
    if (newLevel > oldLevel) return { ...change, confidence: 'high', reason: 'Level increase (story progression)' };
    if (newLevel < oldLevel) return { ...change, confidence: 'low', reason: 'Level decrease (likely stale lorebook data)' };
    return { ...change, confidence: 'medium', reason: 'Level unchanged but format differs' };
  }

  // Stat changes
  if (field.startsWith('Stat:')) {
    const oldVal = typeof before === 'object' ? (before?.value || 0) : (parseInt(before) || 0);
    const newVal = typeof after === 'object' ? (after?.value || 0) : (parseInt(after) || 0);
    if (newVal > oldVal) return { ...change, confidence: 'high', reason: 'Stat increase' };
    if (newVal < oldVal) return { ...change, confidence: 'low', reason: 'Stat decrease (likely stale data)' };
    return { ...change, confidence: 'medium', reason: 'Stat modifier change' };
  }

  // New abilities/equipment/inventory added
  if ((field === 'Abilities' || field === 'Equipment' || field === 'Inventory' || field === 'Status Effects') && !before && after) {
    return { ...change, confidence: 'high', reason: `New ${field.toLowerCase()} added` };
  }
  // Abilities/equipment removed
  if ((field === 'Abilities' || field === 'Equipment' || field === 'Inventory') && before && !after) {
    return { ...change, confidence: 'low', reason: `${field} removed (lorebook may be incomplete)` };
  }

  // Currency changes are almost always valid
  if (field === 'Currency' || field.startsWith('Currency:')) {
    return { ...change, confidence: 'high', reason: 'Currency update' };
  }

  // XP changes
  if (field === 'XP') {
    return { ...change, confidence: 'high', reason: 'XP update (story progression)' };
  }

  // Class/race changes are ambiguous
  if (field === 'Class' || field === 'Subclass' || field === 'Race') {
    return { ...change, confidence: 'medium', reason: `${field} change (may be valid evolution or parse variance)` };
  }

  // Cultivation changes
  if (field === 'Cultivation Realm' || field === 'Cultivation Stage') {
    return { ...change, confidence: 'high', reason: 'Cultivation progression' };
  }

  // Role (combat) changes
  if (field === 'Role') {
    return { ...change, confidence: 'medium', reason: 'Combat role change' };
  }

  // Default: medium confidence
  return { ...change, confidence: 'medium', reason: 'Field update' };
}

/**
 * Categorize scored changes into progression/updates/regressions/neutral.
 */
function categorizeChanges(scoredChanges) {
  const result = { progression: [], updates: [], regressions: [], neutral: [] };
  for (const sc of scoredChanges) {
    if (sc.confidence === 'high') {
      // High confidence: progression or neutral based on field
      if (sc.field === 'Currency' || sc.field.startsWith('Currency:') || sc.field === 'Status Effects') {
        result.neutral.push(sc);
      } else {
        result.progression.push(sc);
      }
    } else if (sc.confidence === 'low') {
      result.regressions.push(sc);
    } else {
      result.updates.push(sc);
    }
  }
  return result;
}

/**
 * Make one character "you, the player". The choice is recorded as a hand edit
 * (storyFunction in _manualFields), so later scans keep it over anything the
 * story or lorebook says. Quests the old player held, or nobody held, move
 * with the role. Mutates and returns state, or null when the id is unknown.
 */
function setPlayer(state, characterId) {
  const player = state?.characters?.[characterId];
  if (!player) return null;
  const oldId = state.protagonist?.characterId || null;
  for (const [id, c] of Object.entries(state.characters)) {
    const manual = new Set(c._manualFields || []);
    if (id === characterId) {
      c.narrative = { ...(c.narrative || {}), storyFunction: 'protagonist' };
      c.isProtagonist = true;
      c.isPartyMember = true;
      c.isNPC = false;
      if (!PARTY_SIDE_ROLES.has(c.partyRole)) c.partyRole = 'party-member';
      manual.add('storyFunction');
    } else if (c.isProtagonist || c.narrative?.storyFunction === 'protagonist') {
      c.isProtagonist = false;
      c.narrative = { ...(c.narrative || {}), storyFunction: null };
      manual.add('storyFunction');
    } else {
      continue;
    }
    c._manualFields = [...manual];
  }
  for (const q of Object.values(state.quests || {})) {
    if (!q._ownerManual && (q.ownerId === oldId || !q.ownerId)) q.ownerId = characterId;
  }
  state.party = state.party || {};
  state.party.members = Object.entries(state.characters).filter(([, c]) => c.isPartyMember).map(([id]) => id);
  state.protagonist = { characterId, name: player.name, pov: state.protagonist?.pov || null, source: 'manual', history: [] };
  return state;
}

/**
 * Undo setPlayer: let the story decide who the player is again. The current
 * player stays until the next scan works it out from the story.
 */
function clearPlayerPin(state) {
  for (const c of Object.values(state?.characters || {})) {
    if ((c._manualFields || []).includes('storyFunction')) c._manualFields = c._manualFields.filter(f => f !== 'storyFunction');
  }
  if (state?.protagonist) state.protagonist = { ...state.protagonist, source: 'auto-pending' };
  return state;
}

// ============================================================================
// EXPORTS
// ============================================================================

module.exports = {
  r3c_extractInterCharRelationships,
  setPlayer,
  clearPlayerPin,
  // Detection
  detectLitRPGSignals,
  confirmLitRPG,
  detectLitRPG,

  // Scan
  scanForRPGData,
  isCharacterLoreEntry,
  classifyPartyAndNPCs,
  collectR4Elements,
  generateLoreElementEntries,

  // Consolidation & Enrichment
  consolidateClasses,
  consolidateRaces,
  consolidateFactions,
  enrichEntityDescriptions,
  detectOrphanEntities,

  // Migration
  migrateLitrpgState,

  // Pending update actions
  acceptPendingUpdate,
  rejectPendingUpdate,
  acceptAllPendingUpdates,
  rejectAllPendingUpdates,

  // Lorebook sync
  buildLitRPGCharacterText,
  spliceField,
  spliceSection,
  assemblePortraitPrompt,
  generatePortraitPrompt,
  parseRPGFromEntryText,
  reverseSyncCharacter,
  buildRoleUpdatePayload,
  scoreReverseSyncChange,
  categorizeChanges,

  // Helpers
  fuzzyMatchCharacter,
  fuzzyMatchQuest,
  describeChanges,
  validateClassification,

  // Constants
  TRACKED_FIELDS,
  MANUAL_TRACKED_FIELDS,
  LITRPG_STATE_DEFAULTS,
  CHARACTER_PERSONA_DEFAULTS,
  LITRPG_CHARACTER_TEMPLATE,
  DETECTION_THRESHOLD,
  VALID_EQUIPMENT_SLOTS,
  VALID_ROLES,
  PARTY_SIDE_ROLES,
  SYSTEM_TYPE_PROMPTS,
  VALID_ABILITY_CATEGORIES,

  // Transient field helpers
  extractTransientFields,
};
