/**
 * Persona Extractor — multi-pass character persona extraction pipeline.
 *
 * P1: Extract personality data (traits, motivations, fears, flaws, speech style)
 * P2: Classify narrative roles (story function, arc type, allegiances, importance)
 * P3: Extract visual profiles (appearance details — skips characters with cached visuals)
 *
 * Follows the same orchestrator+pass pattern as litrpg-tracker scanForRPGData().
 * Called from the lore:scan IPC handler in main.js after lore scan completes.
 */

'use strict';

const { recoverJSON, fuzzyNameScore, generateId, callLLM, LLM_TIMEOUT_MS } = require('./shared-utils');
const { parseMetadata, getEntryType } = require('./metadata');

const LOG_PREFIX = '[Persona]';

// ============================================================================
// CONSTANTS
// ============================================================================

const NARRATIVE_ROLES = [
  'protagonist', 'deuteragonist', 'antagonist', 'rival', 'mentor',
  'love-interest', 'ally', 'foil', 'comic-relief', 'herald',
  'threshold-guardian', 'trickster', 'shapeshifter', 'shadow',
  'catalyst', 'background',
];

const ARC_TYPES = [
  'growth', 'corruption', 'redemption', 'coming-of-age',
  'disillusionment', 'education', 'revenge', 'sacrifice',
  'transformation', 'static',
];

// Max characters per LLM call to stay within context limits
const P1_BATCH_SIZE = 5;
const P3_BATCH_SIZE = 6;
const MAX_CHARS_P2 = 20;
const STORY_TEXT_WINDOW = 6000;
const ENTRY_EXCERPT_LEN = 200;

// ============================================================================
// HELPERS
// ============================================================================

/**
 * Fuzzy-match an LLM-returned character name to the best entry in characterEntries.
 * Returns the matched entry or null if no match above threshold.
 */
function matchNameToEntry(name, characterEntries) {
  if (!name || !characterEntries.length) return null;
  let bestScore = 0;
  let bestEntry = null;
  for (const entry of characterEntries) {
    const score = fuzzyNameScore(name, entry.displayName || entry.name || '');
    if (score > bestScore) {
      bestScore = score;
      bestEntry = entry;
    }
  }
  return bestScore >= 0.7 ? bestEntry : null;
}

/**
 * Merge non-null/non-empty fields from source into target object in-place.
 * Only overwrites target fields that are null/undefined/empty — never erases data.
 */
function mergeNonNull(target, source) {
  if (!source || typeof source !== 'object') return;
  for (const [key, val] of Object.entries(source)) {
    if (val === null || val === undefined) continue;
    if (Array.isArray(val) && val.length === 0) continue;
    if (typeof val === 'string' && val.trim() === '') continue;
    target[key] = val;
  }
}

// ============================================================================
// P1 — PERSONA EXTRACTION
// ============================================================================

/**
 * Extract personality data from story text for each character entry.
 *
 * @param {string} storyText
 * @param {Array} characterEntries - lorebook entries (all types; filtered internally to characters)
 * @param {Function} generateTextFn - async (messages, opts) => { output: string }
 * @param {object|null} comprehensionCtx - optional formatted comprehension context string
 * @param {Function|null} onProgress
 * @returns {Promise<Array<{name: string, loreEntryName: string, persona: object}>>}
 */
async function extractPersonas(storyText, characterEntries, generateTextFn, comprehensionCtx, onProgress) {
  // Filter to character-type entries only
  const charEntries = characterEntries.filter(e => {
    const type = getEntryType(e.text || '', e.displayName || e.name || '');
    return type === 'character';
  });

  if (!charEntries.length) return [];

  const storyWindow = storyText.slice(-STORY_TEXT_WINDOW);
  const results = [];
  const total = charEntries.length;
  let processed = 0;

  // Process in batches
  for (let i = 0; i < charEntries.length; i += P1_BATCH_SIZE) {
    const batch = charEntries.slice(i, i + P1_BATCH_SIZE);

    const charList = batch.map(e => {
      const name = e.displayName || e.name || 'Unknown';
      const excerpt = (e.text || '').slice(0, ENTRY_EXCERPT_LEN).replace(/\n/g, ' ');
      return `- ${name}: ${excerpt}`;
    }).join('\n');

    const messages = [
      {
        role: 'system',
        content: 'You are a character analyst. Extract personality data from the story text for each named character. Only include facts explicitly stated or clearly demonstrated in the text — no speculation.',
      },
      {
        role: 'user',
        content: `Story text (recent):\n${storyWindow}\n\nCharacters to analyze:\n${charList}\n\nReturn JSON only:\n{"characters": [{"name": "...", "personalityTraits": [...], "motivations": [...], "fears": [...], "flaws": [...], "speechStyle": "...", "emotionalState": "..."}]}`,
      },
    ];

    try {
      const { raw } = await callLLM(generateTextFn, messages, { maxTokens: 800, label: 'P1-persona' });
      const parsed = recoverJSON(raw);
      const chars = parsed?.characters || [];

      for (const charResult of chars) {
        const matchedEntry = matchNameToEntry(charResult.name, batch);
        if (!matchedEntry) {
          console.log(`${LOG_PREFIX} P1: no match for "${charResult.name}" — skipping`);
          continue;
        }
        results.push({
          name: charResult.name,
          loreEntryName: matchedEntry.displayName || matchedEntry.name || '',
          persona: {
            personalityTraits: charResult.personalityTraits || [],
            motivations: charResult.motivations || [],
            fears: charResult.fears || [],
            flaws: charResult.flaws || [],
            speechStyle: charResult.speechStyle || null,
            emotionalState: charResult.emotionalState || null,
          },
        });
      }
    } catch (err) {
      console.error(`${LOG_PREFIX} P1 batch error:`, err.message);
    }

    processed = Math.min(i + P1_BATCH_SIZE, total);
    const lastName = batch[batch.length - 1];
    onProgress?.({
      phase: 'persona-P1',
      current: processed,
      total,
      characterName: lastName?.displayName || lastName?.name || '',
    });
  }

  return results;
}

// ============================================================================
// P2 — NARRATIVE ROLE CLASSIFICATION
// ============================================================================

/**
 * Classify narrative roles for all characters in a single LLM call (up to MAX_CHARS_P2).
 *
 * @param {string} storyText
 * @param {Array} characterEntries
 * @param {Function} generateTextFn
 * @param {string|null} comprehensionCtx - formatted comprehension context string
 * @param {Function|null} onProgress
 * @returns {Promise<Array<{name: string, loreEntryName: string, narrative: object}>>}
 */
async function classifyNarrativeRoles(storyText, characterEntries, generateTextFn, comprehensionCtx, onProgress) {
  const charEntries = characterEntries
    .filter(e => getEntryType(e.text || '', e.displayName || e.name || '') === 'character')
    .slice(0, MAX_CHARS_P2);

  if (!charEntries.length) return [];

  const storyWindow = storyText.slice(-STORY_TEXT_WINDOW);

  // Build character list with any existing metadata to preserve
  const charList = charEntries.map(e => {
    const name = e.displayName || e.name || 'Unknown';
    const meta = parseMetadata(e.text || '');
    const existing = [];
    if (meta.all['narrative-role']) existing.push(`existing narrative-role: ${meta.all['narrative-role']}`);
    if (meta.all['arc']) existing.push(`existing arc: ${meta.all['arc']}`);
    return `- ${name}${existing.length ? ` (${existing.join(', ')})` : ''}`;
  }).join('\n');

  const ctxBlock = comprehensionCtx ? `\nStory context:\n${comprehensionCtx}\n` : '';

  const messages = [
    {
      role: 'system',
      content: `Classify each character's narrative role in the story. Use ONLY these valid roles: ${NARRATIVE_ROLES.join(', ')}. Use ONLY these valid arc types: ${ARC_TYPES.join(', ')}. Base classification on the character's actual function in the story. Preserve existing classifications unless the story clearly contradicts them.`,
    },
    {
      role: 'user',
      content: `Story text (recent):\n${storyWindow}\n${ctxBlock}\nCharacters:\n${charList}\n\nReturn JSON only:\n{"characters": [{"name": "...", "storyFunction": "...", "goals": [...], "conflicts": [...], "allegiances": [...], "arcType": "...", "arcProgression": 0, "importance": "major|supporting|minor|background"}]}`,
    },
  ];

  const results = [];

  try {
    const { raw } = await callLLM(generateTextFn, messages, { maxTokens: 1000, label: 'P2-narrative' });
    const parsed = recoverJSON(raw);
    const chars = parsed?.characters || [];

    for (const charResult of chars) {
      const matchedEntry = matchNameToEntry(charResult.name, charEntries);
      if (!matchedEntry) {
        console.log(`${LOG_PREFIX} P2: no match for "${charResult.name}" — skipping`);
        continue;
      }

      // Validate enum values
      const storyFunction = NARRATIVE_ROLES.includes(charResult.storyFunction) ? charResult.storyFunction : null;
      const arcType = ARC_TYPES.includes(charResult.arcType) ? charResult.arcType : null;
      const validImportance = ['major', 'supporting', 'minor', 'background'];
      const importance = validImportance.includes(charResult.importance) ? charResult.importance : null;

      results.push({
        name: charResult.name,
        loreEntryName: matchedEntry.displayName || matchedEntry.name || '',
        narrative: {
          storyFunction,
          goals: charResult.goals || [],
          conflicts: charResult.conflicts || [],
          allegiances: charResult.allegiances || [],
          arcType,
          arcProgression: typeof charResult.arcProgression === 'number' ? charResult.arcProgression : null,
          importance,
        },
      });
    }
  } catch (err) {
    console.error(`${LOG_PREFIX} P2 error:`, err.message);
  }

  onProgress?.({ phase: 'persona-P2', current: charEntries.length, total: charEntries.length });

  return results;
}

// ============================================================================
// P3 — VISUAL PROFILE EXTRACTION
// ============================================================================

/**
 * Extract visual appearance details for characters, skipping those with cached visuals.
 *
 * @param {string} storyText
 * @param {Array} characterEntries
 * @param {object} existingVisuals - { characterName: { hair, eyes, ... } } from cached pipeline results
 * @param {Function} generateTextFn
 * @param {Function|null} onProgress
 * @returns {Promise<Array<{name: string, loreEntryName: string, visual: object}>>}
 */
async function extractVisualProfiles(storyText, characterEntries, existingVisuals, generateTextFn, onProgress) {
  const charEntries = characterEntries.filter(e =>
    getEntryType(e.text || '', e.displayName || e.name || '') === 'character'
  );

  if (!charEntries.length) return [];

  const cachedVisuals = existingVisuals || {};
  const results = [];

  // Return cached visuals directly without LLM
  const needsExtraction = [];
  for (const entry of charEntries) {
    const name = entry.displayName || entry.name || '';
    // Check for an exact or fuzzy cache hit
    let cached = cachedVisuals[name] || null;
    if (!cached) {
      for (const [cachedName, visual] of Object.entries(cachedVisuals)) {
        if (fuzzyNameScore(name, cachedName) >= 0.7) {
          cached = visual;
          break;
        }
      }
    }

    if (cached) {
      results.push({ name, loreEntryName: name, visual: cached });
    } else {
      needsExtraction.push(entry);
    }
  }

  const storyWindow = storyText.slice(-STORY_TEXT_WINDOW);
  const total = needsExtraction.length;

  // Batch LLM extraction for characters without cached visuals
  for (let i = 0; i < needsExtraction.length; i += P3_BATCH_SIZE) {
    const batch = needsExtraction.slice(i, i + P3_BATCH_SIZE);

    const charList = batch.map(e => {
      const name = e.displayName || e.name || 'Unknown';
      const excerpt = (e.text || '').slice(0, ENTRY_EXCERPT_LEN).replace(/\n/g, ' ');
      return `- ${name}: ${excerpt}`;
    }).join('\n');

    const messages = [
      {
        role: 'system',
        content: 'Extract visual appearance details for each character from the story text. Only include explicitly described features.',
      },
      {
        role: 'user',
        content: `Story text (recent):\n${storyWindow}\n\nCharacters:\n${charList}\n\nReturn JSON only:\n{"characters": [{"name": "...", "hair": "...", "eyes": "...", "build": "...", "race": "...", "distinguishingFeatures": "...", "clothing": "...", "height": "...", "skinTone": "..."}]}`,
      },
    ];

    try {
      const { raw } = await callLLM(generateTextFn, messages, { maxTokens: 700, label: 'P3-visual' });
      const parsed = recoverJSON(raw);
      const chars = parsed?.characters || [];

      for (const charResult of chars) {
        const matchedEntry = matchNameToEntry(charResult.name, batch);
        if (!matchedEntry) {
          console.log(`${LOG_PREFIX} P3: no match for "${charResult.name}" — skipping`);
          continue;
        }
        const name = matchedEntry.displayName || matchedEntry.name || '';
        results.push({
          name: charResult.name,
          loreEntryName: name,
          visual: {
            hair: charResult.hair || null,
            eyes: charResult.eyes || null,
            build: charResult.build || null,
            race: charResult.race || null,
            distinguishingFeatures: charResult.distinguishingFeatures || null,
            clothing: charResult.clothing || null,
            height: charResult.height || null,
            skinTone: charResult.skinTone || null,
          },
        });
      }
    } catch (err) {
      console.error(`${LOG_PREFIX} P3 batch error:`, err.message);
    }

    const processed = Math.min(i + P3_BATCH_SIZE, total);
    const lastName = batch[batch.length - 1];
    onProgress?.({
      phase: 'persona-P3',
      current: processed,
      total,
      characterName: lastName?.displayName || lastName?.name || '',
    });
  }

  return results;
}

// ============================================================================
// ORCHESTRATOR
// ============================================================================

/**
 * Run the full persona extraction pipeline (P1 → P2 → P3) and merge results
 * into the LitRPG character state.
 *
 * @param {object} ctx
 * @param {string} ctx.storyText
 * @param {Array} ctx.characterEntries - lorebook entries array
 * @param {Function} ctx.generateTextFn
 * @param {object} ctx.state - current litrpg state with .characters map
 * @param {string|null} ctx.comprehensionCtx - formatted comprehension context string
 * @param {Function|null} ctx.onProgress
 * @returns {Promise<object>} updated state
 */
async function runPersonaExtraction(ctx) {
  const { storyText, characterEntries, generateTextFn, state, comprehensionCtx, onProgress } = ctx;

  // Lazy-load CHARACTER_PERSONA_DEFAULTS to avoid circular dependency issues
  const { CHARACTER_PERSONA_DEFAULTS } = require('./litrpg-tracker');

  if (!characterEntries?.length || !storyText || !generateTextFn) {
    console.log(`${LOG_PREFIX} Skipping — missing required inputs`);
    return state;
  }

  const characters = state.characters || {};

  /**
   * Find the best matching character in state.characters by display name.
   * Returns [charId, charObj] or [null, null].
   */
  function findCharInState(name) {
    let bestScore = 0;
    let bestId = null;
    for (const [id, char] of Object.entries(characters)) {
      const charName = char.name || char.displayName || '';
      const score = fuzzyNameScore(name, charName);
      if (score > bestScore) {
        bestScore = score;
        bestId = id;
      }
      // Also check aliases
      if (Array.isArray(char.aliases)) {
        for (const alias of char.aliases) {
          const aliasScore = fuzzyNameScore(name, alias);
          if (aliasScore > bestScore) {
            bestScore = aliasScore;
            bestId = id;
          }
        }
      }
    }
    return bestScore >= 0.7 ? [bestId, characters[bestId]] : [null, null];
  }

  // --- P1: Persona extraction ---
  console.log(`${LOG_PREFIX} Starting P1 persona extraction`);
  let p1Results = [];
  try {
    p1Results = await extractPersonas(storyText, characterEntries, generateTextFn, comprehensionCtx, onProgress);
  } catch (err) {
    console.error(`${LOG_PREFIX} P1 failed:`, err.message);
  }

  for (const result of p1Results) {
    const [charId, existingChar] = findCharInState(result.loreEntryName || result.name);
    if (existingChar) {
      existingChar.persona = existingChar.persona || { ...CHARACTER_PERSONA_DEFAULTS.persona };
      mergeNonNull(existingChar.persona, result.persona);
    } else {
      // New character not yet in LitRPG state — create a stub entry
      const newId = generateId('char');
      characters[newId] = {
        ...CHARACTER_PERSONA_DEFAULTS,
        persona: { ...CHARACTER_PERSONA_DEFAULTS.persona },
        narrative: { ...CHARACTER_PERSONA_DEFAULTS.narrative },
        visual: { ...CHARACTER_PERSONA_DEFAULTS.visual },
        id: newId,
        name: result.loreEntryName || result.name,
        displayName: result.loreEntryName || result.name,
        aliases: [],
        _fromPersonaExtractor: true,
      };
      mergeNonNull(characters[newId].persona, result.persona);
    }
  }

  // --- P2: Narrative role classification ---
  console.log(`${LOG_PREFIX} Starting P2 narrative role classification`);
  let p2Results = [];
  try {
    p2Results = await classifyNarrativeRoles(storyText, characterEntries, generateTextFn, comprehensionCtx, onProgress);
  } catch (err) {
    console.error(`${LOG_PREFIX} P2 failed:`, err.message);
  }

  for (const result of p2Results) {
    const [charId, existingChar] = findCharInState(result.loreEntryName || result.name);
    if (existingChar) {
      existingChar.narrative = existingChar.narrative || { ...CHARACTER_PERSONA_DEFAULTS.narrative };
      mergeNonNull(existingChar.narrative, result.narrative);
    }
  }

  // --- P3: Visual profile extraction ---
  console.log(`${LOG_PREFIX} Starting P3 visual profile extraction`);

  // Build existing visuals cache from current state
  const existingVisuals = {};
  for (const char of Object.values(characters)) {
    const name = char.name || char.displayName || '';
    if (name && char.visual && Object.values(char.visual).some(v => v !== null)) {
      existingVisuals[name] = char.visual;
    }
  }

  let p3Results = [];
  try {
    p3Results = await extractVisualProfiles(storyText, characterEntries, existingVisuals, generateTextFn, onProgress);
  } catch (err) {
    console.error(`${LOG_PREFIX} P3 failed:`, err.message);
  }

  for (const result of p3Results) {
    const [charId, existingChar] = findCharInState(result.loreEntryName || result.name);
    if (existingChar) {
      existingChar.visual = existingChar.visual || { ...CHARACTER_PERSONA_DEFAULTS.visual };
      mergeNonNull(existingChar.visual, result.visual);
    }
  }

  console.log(`${LOG_PREFIX} Pipeline complete — P1: ${p1Results.length}, P2: ${p2Results.length}, P3: ${p3Results.length} results`);

  return { ...state, characters };
}

// ============================================================================
// EXPORTS
// ============================================================================

module.exports = {
  NARRATIVE_ROLES,
  ARC_TYPES,
  extractPersonas,
  classifyNarrativeRoles,
  extractVisualProfiles,
  runPersonaExtraction,
};
