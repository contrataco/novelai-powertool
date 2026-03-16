/**
 * Lore Creator — LLM prompt templates and scan orchestration.
 *
 * Ported from lore-creator.ts (standalone Script API plugin) to run in
 * Electron's main process using direct NovelAI text API (or Ollama).
 *
 * Every function that needs LLM takes a `generateTextFn(messages, options)`
 * callback for testability and provider swapping.
 */

const LOG_PREFIX = '[LoreCreator]';

// ============================================================================
// CONSTANTS
// ============================================================================

const MAX_INPUT_TEXT = 6000;
const MAX_ELEMENTS_PER_SCAN = 12;
const INTER_CALL_DELAY = 1000;
const MAX_UPDATES_PER_SCAN = 3;

const BUILTIN_CATEGORIES = [
  { id: 'character', displayName: 'Characters', singularName: 'Character', color: '#4d96ff', isBuiltin: true, template: 'character' },
  { id: 'location',  displayName: 'Locations',  singularName: 'Location',  color: '#6bcb77', isBuiltin: true, template: 'location' },
  { id: 'item',      displayName: 'Items',       singularName: 'Item',      color: '#ffd93d', isBuiltin: true, template: 'item' },
  { id: 'faction',   displayName: 'Factions',    singularName: 'Faction',   color: '#ff6b6b', isBuiltin: true, template: 'faction' },
  { id: 'concept',   displayName: 'Concepts',    singularName: 'Concept',   color: '#a855f7', isBuiltin: true, template: 'concept' },
];

function buildCategoryRegistry(customCategories) {
  const registry = BUILTIN_CATEGORIES.map(c => ({ ...c }));
  if (Array.isArray(customCategories)) {
    for (const cc of customCategories) {
      if (cc && cc.id && !registry.find(r => r.id === cc.id)) {
        registry.push({ ...cc, isBuiltin: false, template: cc.template || null });
      }
    }
  }
  return registry;
}

function getCategoryIds(registry) {
  return registry.map(c => c.id);
}

// Backward-compat: flat array of builtin IDs
const ALL_CATEGORIES = BUILTIN_CATEGORIES.map(c => c.id);

const DEFAULT_SETTINGS = {
  autoScan: true,
  autoDetectUpdates: true,
  hybridEnabled: true,
  minNewCharsForScan: 500,
  temperature: 0.4,
  detailLevel: 'standard', // 'brief' | 'standard' | 'detailed'
  enabledCategories: {
    character: true,
    location: true,
    item: true,
    faction: true,
    concept: true,
  },
};

// ============================================================================
// JSON RECOVERY
// ============================================================================

/**
 * Attempts to recover valid JSON from a potentially truncated LLM response.
 */
function recoverJSON(raw) {
  const jsonMatch = raw.match(/\{[\s\S]*\}/);
  if (!jsonMatch) return null;

  let jsonStr = jsonMatch[0];

  try {
    return JSON.parse(jsonStr);
  } catch (_) {
    // Continue with recovery
  }

  const openBraces = (jsonStr.match(/\{/g) || []).length;
  const closeBraces = (jsonStr.match(/\}/g) || []).length;
  const openBrackets = (jsonStr.match(/\[/g) || []).length;
  const closeBrackets = (jsonStr.match(/\]/g) || []).length;

  const quoteCount = (jsonStr.match(/"/g) || []).length;
  if (quoteCount % 2 !== 0) {
    jsonStr += '"';
  }

  for (let i = 0; i < openBrackets - closeBrackets; i++) {
    jsonStr += ']';
  }
  for (let i = 0; i < openBraces - closeBraces; i++) {
    jsonStr += '}';
  }

  try {
    return JSON.parse(jsonStr);
  } catch (_) {
    return null;
  }
}

function generateId() {
  return `lore_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`;
}

function delay(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

// ============================================================================
// LLM FUNCTIONS
// ============================================================================

/**
 * Pass 1: Identify lore-worthy elements in story text.
 */
async function identifyLoreElements(storyText, settings, existingEntries, generateTextFn, comprehensionContext) {
  const registry = buildCategoryRegistry(settings.customCategories);
  const allCatIds = getCategoryIds(registry);
  const enabledCats = allCatIds.filter(c => settings.enabledCategories[c]);
  if (enabledCats.length === 0) return [];

  // Build existing entries block — rich detail for top 20, compact names for the rest
  let existingLine = '';
  if (existingEntries.length > 0) {
    const richLines = existingEntries.slice(0, 30).map(e => {
      const aliases = (e.keys || []).filter(k => k.toLowerCase() !== (e.displayName || '').toLowerCase());
      const aliasStr = aliases.length > 0 ? ` (aliases: ${aliases.slice(0, 3).join(', ')})` : '';
      const snippet = (e.text || '').slice(0, 200).replace(/\n/g, ' ');
      const typeTag = getEntryType(e.text, e.displayName) || 'unknown';
      return `- ${e.displayName} [${typeTag}]${aliasStr}: ${snippet}`;
    });
    // Compact format for entries 31+ — just name, category, and aliases, no text snippet
    const compactLines = existingEntries.slice(30).map(e => {
      const aliases = (e.keys || []).filter(k => k.toLowerCase() !== (e.displayName || '').toLowerCase());
      const aliasStr = aliases.length > 0 ? ` (aliases: ${aliases.slice(0, 3).join(', ')})` : '';
      const typeTag = getEntryType(e.text, e.displayName) || 'unknown';
      return `- ${e.displayName} [${typeTag}]${aliasStr}`;
    });
    const allLines = [...richLines, ...compactLines];
    existingLine = `\nEXISTING ENTRIES (${existingEntries.length} total):\n${allLines.join('\n')}\n`;
  }

  const contextOverhead = (comprehensionContext ? comprehensionContext.length : 0) + existingLine.length;
  const textBudget = MAX_INPUT_TEXT - contextOverhead;
  let processText = storyText;
  if (storyText.length > textBudget) {
    processText = storyText.slice(-textBudget);
    console.log(`${LOG_PREFIX} Text truncated to ${textBudget} chars for identification`);
  }

  const mergeInstruction = existingEntries.length > 0
    ? `\nIf an element is the same entity as an existing entry (e.g., a real name revealed for a described character, or a nickname/alias for an existing character), set "mergesWith" to that existing entry name. Otherwise set "mergesWith" to null.`
    : '';

  const mergeField = existingEntries.length > 0
    ? ',"mergesWith":"existing entry name or null"'
    : '';

  const comprehensionBlock = comprehensionContext
    ? `${comprehensionContext}\n`
    : '';

  const messages = [
    {
      role: 'system',
      content: 'You are an expert story analyst. Identify important lore-worthy elements from story text. IMPORTANT: Do not identify elements that are clearly the same entity as an existing entry, even under a different name or alias. Aim for diversity across categories — if the story has both characters and locations/items/factions, include a mix rather than only characters. Output ONLY valid JSON.',
    },
    {
      role: 'user',
      content: `Analyze this story text and identify the most important elements that should be tracked in a lorebook.

Categories to look for: ${enabledCats.join(', ')}
${existingLine}
${comprehensionBlock}RECENT STORY TEXT:
${processText}

List up to ${MAX_ELEMENTS_PER_SCAN} elements. For each, provide the name and category.${mergeInstruction}
Output ONLY this JSON format, no other text:
{"elements":[{"name":"Element Name","category":"character"${mergeField}}]}`,
    },
  ];

  try {
    const response = await generateTextFn(messages, {
      max_tokens: 450,
      temperature: settings.temperature,
    });

    const content = response.output || '';
    const parsed = recoverJSON(content);

    if (parsed && Array.isArray(parsed.elements)) {
      return parsed.elements
        .filter(el =>
          typeof el.name === 'string' &&
          el.name.length > 0 &&
          enabledCats.includes(el.category)
        )
        .slice(0, MAX_ELEMENTS_PER_SCAN)
        .map(el => ({
          name: el.name,
          category: el.category,
          mergesWith: (typeof el.mergesWith === 'string' && el.mergesWith !== 'null' && el.mergesWith.length > 0)
            ? el.mergesWith
            : undefined,
        }));
    }
  } catch (e) {
    console.error(`${LOG_PREFIX} Error identifying elements:`, e.message || e);
  }

  return [];
}

/**
 * Pass 2: Generate a full lorebook entry for a single element.
 */
async function generateLoreEntryFromElement(name, category, storyText, settings, existingEntryNames, generateTextFn, comprehensionContext) {
  const contextBudget = comprehensionContext ? MAX_INPUT_TEXT - comprehensionContext.length : MAX_INPUT_TEXT;
  let contextText = storyText;
  if (storyText.length > contextBudget) {
    contextText = storyText.slice(-contextBudget);
  }

  const template = getTemplateForType(category);

  let detailInstructions = '';
  if (template) {
    detailInstructions = `Use this structured format for the text field:\n${template}\n\nInclude information that is explicitly stated or clearly supported by the text. Leave fields blank if the story provides no basis for them. Do not speculate beyond what the text reasonably supports.`;
    if (category === 'character') {
      detailInstructions += '\n- Relationships/Family: use "- Name: detail" format, one per line';
    }
    detailInstructions += '\nOmit fields that have no explicit support in the story. Keep each field concise.';
  } else {
    switch (settings.detailLevel) {
      case 'brief':
        detailInstructions = 'Write 1-2 concise sentences.';
        break;
      case 'standard':
        detailInstructions = 'Write 2-4 informative sentences.';
        break;
      case 'detailed':
        detailInstructions = 'Write 4-6 comprehensive sentences.';
        break;
    }
  }

  const otherEntriesLine = existingEntryNames.length > 0
    ? `\nOther tracked entries: ${existingEntryNames.slice(0, 20).join(', ')}\n`
    : '';

  const relationshipInstruction = existingEntryNames.length > 0
    ? ' If this element has clear relationships to other tracked entries, include them in the Relationships field (for characters) or add a brief "Related:" line at the end.'
    : '';

  const comprehensionBlock = comprehensionContext
    ? `${comprehensionContext}\n`
    : '';

  const maxTokens = template ? 600 : 200;

  const messages = [
    {
      role: 'system',
      content: 'You are a lorebook entry writer for interactive fiction. Create accurate, well-structured lorebook entries based on what is explicitly stated or clearly supported by the story. Do not speculate beyond what the text reasonably supports. Output ONLY valid JSON.',
    },
    {
      role: 'user',
      content: `Create a lorebook entry for this ${category}: "${name}"
${otherEntriesLine}
${comprehensionBlock}Based on this recent story context:
${contextText}

${detailInstructions} Include only what is clearly supported by the story text. Provide 2-4 short keywords or aliases that would trigger this entry.${relationshipInstruction}

Output ONLY this JSON format, no other text:
{"displayName":"Full Name","keys":["key1","key2"],"text":"Entry text here.","confidence":3}`,
    },
  ];

  try {
    const response = await generateTextFn(messages, {
      max_tokens: maxTokens,
      temperature: settings.temperature,
    });

    const content = response.output || '';
    const parsed = recoverJSON(content);

    if (parsed && typeof parsed.displayName === 'string') {
      const confidence = typeof parsed.confidence === 'number' ? Math.min(5, Math.max(1, parsed.confidence)) : 3;
      if (confidence < 2) {
        console.log(`${LOG_PREFIX} Rejecting low-confidence entry "${parsed.displayName}" (confidence=${confidence})`);
        return null;
      }
      const keys = Array.isArray(parsed.keys)
        ? parsed.keys.filter(k => typeof k === 'string').slice(0, 6)
        : [name];
      const rawText = typeof parsed.text === 'string' ? parsed.text : '';
      const today = new Date().toISOString().slice(0, 10);
      const entryText = setMetadata(rawText, { type: category, version: METADATA_VERSION, updated: today, source: 'lore-scan' });
      return {
        id: generateId(),
        category,
        displayName: parsed.displayName || name,
        keys,
        text: entryText,
        confidence,
        createdAt: Date.now(),
      };
    }
  } catch (e) {
    console.error(`${LOG_PREFIX} Error generating entry for ${name}:`, e.message || e);
  }

  return null;
}

/**
 * Detect if story text contains new information about an existing lorebook entry.
 */
async function detectEntryUpdate(displayName, currentText, storyText, settings, generateTextFn, comprehensionContext) {
  const safeCurrentText = currentText || '';
  const comprehensionBlock = comprehensionContext
    ? `\n${comprehensionContext}\n`
    : '';
  const maxStoryChars = 6000 - safeCurrentText.length - comprehensionBlock.length - 600;
  const contextText = storyText.length > maxStoryChars
    ? storyText.slice(-maxStoryChars)
    : storyText;

  const messages = [
    {
      role: 'system',
      content: 'You analyze story text to detect new information about existing lorebook entries. Consider information that is explicitly stated or clearly supported by character behavior and narrative context. Output ONLY valid JSON.',
    },
    {
      role: 'user',
      content: `Does this story text reveal new information about "${displayName}" that is NOT already in the current entry?

Current entry:
${safeCurrentText}
${comprehensionBlock}
Story text:
${contextText}

If the story reveals new details (stated or clearly supported) not in the entry, return updated entry text that incorporates the new info while keeping existing info.
If NO new information is found, return noUpdate.

Output ONLY one of these JSON formats:
{"updatedText":"Complete updated entry text here."}
{"noUpdate":true}`,
    },
  ];

  try {
    const response = await generateTextFn(messages, {
      max_tokens: 600,
      temperature: settings.temperature,
    });

    const content = response.output || '';
    const parsed = recoverJSON(content);

    if (parsed) {
      if (parsed.noUpdate === true) return null;
      if (typeof parsed.updatedText === 'string' && parsed.updatedText.length > 0) {
        return parsed.updatedText;
      }
    }
  } catch (e) {
    console.error(`${LOG_PREFIX} Error detecting update for ${displayName}:`, e.message || e);
  }

  return null;
}

/**
 * Identify which lorebook entry matches a user's enrich prompt.
 */
async function identifyTargetEntry(prompt, entries, generateTextFn) {
  if (entries.length === 0) return null;

  // Pre-filter by prompt words
  const promptWords = prompt.toLowerCase().split(/\s+/).filter(w => w.length > 2);
  const scored = entries.map(entry => {
    const name = (entry.displayName || '').toLowerCase();
    const keys = (entry.keys || []).map(k => k.toLowerCase());
    let score = 0;
    for (const word of promptWords) {
      if (name.includes(word)) score += 2;
      for (const key of keys) {
        if (key.includes(word)) score += 1;
      }
    }
    return { entry, score };
  });

  scored.sort((a, b) => b.score - a.score);
  const candidates = scored.slice(0, 20);

  const entryList = candidates.map(({ entry }, i) => {
    const name = entry.displayName || '(unnamed)';
    const keys = (entry.keys || []).slice(0, 3).join(', ');
    return `${i}: ${name} [${keys}]`;
  }).join('\n');

  const messages = [
    {
      role: 'system',
      content: 'You match user requests to lorebook entries. Output ONLY valid JSON.',
    },
    {
      role: 'user',
      content: `The user wants to update a lorebook entry. Which entry matches their request?

User request: "${prompt}"

Entries:
${entryList}

Output ONLY this JSON: {"index":0,"confidence":4}
- index: the entry number from the list above
- confidence: 1-5 how sure you are this is the right entry`,
    },
  ];

  try {
    const response = await generateTextFn(messages, {
      max_tokens: 100,
      temperature: 0.2,
    });

    const content = response.output || '';
    const parsed = recoverJSON(content);

    if (parsed && typeof parsed.index === 'number') {
      const idx = parsed.index;
      const confidence = typeof parsed.confidence === 'number'
        ? Math.min(5, Math.max(1, parsed.confidence))
        : 3;

      if (idx >= 0 && idx < candidates.length) {
        return { entry: candidates[idx].entry, confidence };
      }
    }
  } catch (e) {
    console.error(`${LOG_PREFIX} Error identifying target entry:`, e.message || e);
  }

  return null;
}

/**
 * Generate updated entry text based on user prompt.
 */
async function generateEnrichedText(prompt, currentText, displayName, generateTextFn) {
  const messages = [
    {
      role: 'system',
      content: 'You update lorebook entries for interactive fiction. Return ONLY the updated entry text, no JSON or extra formatting.',
    },
    {
      role: 'user',
      content: `Update this lorebook entry for "${displayName}" based on the user's instruction.

Current entry text:
${currentText}

User instruction: "${prompt}"

Write the complete updated entry text. Keep existing information and incorporate the requested changes. Return ONLY the updated text, nothing else.`,
    },
  ];

  try {
    const response = await generateTextFn(messages, {
      max_tokens: 350,
      temperature: 0.3,
    });

    const text = (response.output || '').trim();
    if (text.length > 0) return text;
  } catch (e) {
    console.error(`${LOG_PREFIX} Error generating enriched text:`, e.message || e);
  }

  return null;
}

/**
 * Character entry structured template.
 */
const CHARACTER_TEMPLATE = `Name: [Full name, including last name]
Age: [Age or approximate age]
Gender: [Gender identity]
Physical Appearance: [Detailed physical description]
Sexuality: [Sexual orientation and interests, if relevant]
Description: [Personality, role, and key traits]
Self-Image: [How they see themselves; self-perception vs reality]
Motivations/Goals: [What drives them; what they want]
Secrets: [Hidden knowledge, lies, concealed truths]
Relationships:
- [Name]: [relationship type and dynamic]
Family:
- [Name]: [family role, e.g. sister, father]
Background: [History and backstory]
Additional notes: [Any other relevant details]`;

const LOCATION_TEMPLATE = `Name: [Full name of the location]
Region: [Broader region or area it belongs to]
Type: [City/town/forest/cave/realm/etc.]
Climate/Terrain: [Weather and geographical features]
Description: [Physical description and atmosphere]
Notable Features: [Landmarks, architecture, unique elements]
History: [Key historical events or founding]
Inhabitants: [Who lives here; races, factions, notable residents]
Dangers: [Threats, monsters, environmental hazards]
Connected Locations: [Nearby or linked places]
Additional notes: [Any other relevant details]`;

const ITEM_TEMPLATE = `Name: [Full name of the item]
Type: [Weapon/armor/potion/artifact/tool/etc.]
Rarity: [Common/uncommon/rare/epic/legendary/unique]
Description: [Physical appearance and notable features]
Properties: [Magical or special properties, bonuses, effects]
Origin: [Where it was made, by whom, how it was created]
Current Owner: [Who currently possesses it]
Lore: [History, legends, or significance]
Additional notes: [Any other relevant details]`;

const FACTION_TEMPLATE = `Name: [Full name of the faction/organization]
Type: [Guild/order/clan/government/cult/etc.]
Alignment: [General moral alignment or philosophy]
Description: [Purpose, reputation, and key traits]
Leadership: [Leader(s) and command structure]
Territory: [Area of influence or headquarters]
Members: [Notable members or typical membership]
Relations: [Allies, enemies, and diplomatic standing]
Goals: [Current objectives and long-term aims]
History: [Founding, key events, evolution]
Additional notes: [Any other relevant details]`;

const CONCEPT_TEMPLATE = `Name: [Name of the concept/system/magic]
Type: [Magic system/political system/religion/technology/etc.]
Description: [How it works, core principles]
Rules: [Governing laws, limitations, costs]
Practitioners: [Who uses it, requirements to use it]
Significance: [Impact on the world and story]
Related Concepts: [Connected systems, prerequisite knowledge]
Additional notes: [Any other relevant details]`;

/**
 * Map of type -> template string.
 */
const TEMPLATES = {
  character: CHARACTER_TEMPLATE,
  location: LOCATION_TEMPLATE,
  item: ITEM_TEMPLATE,
  faction: FACTION_TEMPLATE,
  concept: CONCEPT_TEMPLATE,
};

function getTemplateForType(type) {
  return TEMPLATES[type] || null;
}

/**
 * Per-type regex arrays for format detection.
 */
const TEMPLATE_FIELDS = {
  character: [
    /^Name:/m, /^Age:/m, /^Relationships:/m, /^Physical Appearance:/m,
    /^Sexuality:/m, /^Gender:/m, /^Description:/m, /^Self-Image:/m,
    /^Motivations\/Goals:/m, /^Secrets:/m, /^Background:/m, /^Family:/m,
    /^Additional notes:/m,
  ],
  location: [
    /^Name:/m, /^Region:/m, /^Type:/m, /^Climate\/Terrain:/m,
    /^Description:/m, /^Notable Features:/m, /^History:/m,
    /^Inhabitants:/m, /^Dangers:/m, /^Connected Locations:/m,
    /^Additional notes:/m,
  ],
  item: [
    /^Name:/m, /^Type:/m, /^Rarity:/m, /^Description:/m,
    /^Properties:/m, /^Origin:/m, /^Current Owner:/m,
    /^Lore:/m, /^Additional notes:/m,
  ],
  faction: [
    /^Name:/m, /^Type:/m, /^Alignment:/m, /^Description:/m,
    /^Leadership:/m, /^Territory:/m, /^Members:/m,
    /^Relations:/m, /^Goals:/m, /^History:/m, /^Additional notes:/m,
  ],
  concept: [
    /^Name:/m, /^Type:/m, /^Description:/m, /^Rules:/m,
    /^Practitioners:/m, /^Significance:/m, /^Related Concepts:/m,
    /^Additional notes:/m,
  ],
};

/**
 * Check if an entry follows the structured template format for a given type.
 * Returns true if the entry has at least 3 of the template field labels.
 */
function isEntryFormatted(text, type) {
  if (!text) return true; // empty entries don't need reformatting
  const fields = TEMPLATE_FIELDS[type];
  if (!fields) return true; // no template = no reformatting needed
  const matches = fields.filter(re => re.test(text)).length;
  return matches >= 3;
}

/**
 * Heuristic: does this lorebook entry look like it describes a character?
 * Checks for person-describing patterns in text content (appearance, personality,
 * pronouns, physical descriptors). Requires ≥2 matches to qualify.
 */
function looksLikeCharacterEntry(text) {
  if (!text || text.length < 30) return false;
  const characterPatterns = [
    /\b(he|she|they)\s+(is|are|was|were|has|have|had)\b/i,
    /\b(his|her|their)\s+(hair|eyes|skin|face|body|height|build|appearance)\b/i,
    /\b(tall|short|slender|muscular|petite|stocky|lean)\b/i,
    /\b(hair|eyes|skin)\b.*\b(color|colou?red|black|brown|blonde|red|blue|green|white|grey|gray|silver|dark|light)\b/i,
    /\b(appearance|physical|looks like|described as)\b/i,
    /\b(personality|temperament|demeanor|disposition)\b/i,
    /\b(wears|wearing|dressed|outfit|clothing|armor|robes)\b/i,
    /\b(years? old|\d+\s*yo\b|age[ds]?\s*\d+)\b/i,
    /\b(male|female|man|woman|boy|girl|person)\b/i,
  ];
  const matches = characterPatterns.filter(re => re.test(text)).length;
  return matches >= 2;
}

/**
 * Check if a character entry follows the structured template format.
 * Returns true if the entry has at least 3 of the template field labels.
 */
function isCharacterEntryFormatted(text) {
  if (!text) return true; // empty entries don't need reformatting
  const templateFields = [
    /^Name:/m,
    /^Age:/m,
    /^Relationships:/m,
    /^Physical Appearance:/m,
    /^Sexuality:/m,
    /^Gender:/m,
    /^Description:/m,
    /^Self-Image:/m,
    /^Motivations\/Goals:/m,
    /^Secrets:/m,
    /^Background:/m,
    /^Family:/m,
    /^Additional notes:/m,
  ];
  const matches = templateFields.filter(re => re.test(text)).length;
  return matches >= 3;
}

/**
 * Create lorebook entries from a freeform user prompt.
 * Returns an array of entry objects (may be 1 or many depending on prompt).
 */
async function generateEntriesFromPrompt(prompt, category, storyText, settings, existingEntryNames, generateTextFn, comprehensionContext) {
  const contextBudget = comprehensionContext ? MAX_INPUT_TEXT - comprehensionContext.length : MAX_INPUT_TEXT;
  let contextText = storyText || '';
  if (contextText.length > contextBudget) {
    contextText = contextText.slice(-contextBudget);
  }

  const comprehensionBlock = comprehensionContext
    ? `${comprehensionContext}\n`
    : '';

  const existingLine = existingEntryNames.length > 0
    ? `\nEXISTING ENTRIES: ${existingEntryNames.slice(0, 30).join(', ')}\n`
    : '';

  const registry = buildCategoryRegistry(settings.customCategories);
  const allCatIds = getCategoryIds(registry);

  const categoryInstruction = category === 'auto'
    ? `Determine the most appropriate category for each entry from: ${allCatIds.join(', ')}.`
    : `All entries should use category "${category}".`;

  // Build template instructions for all types that have templates
  let templateInstructions = '';
  if (category !== 'auto') {
    const tmpl = getTemplateForType(category);
    if (tmpl) {
      templateInstructions = `\nFor ${category.toUpperCase()} entries, use this structured format for the text field:\n${tmpl}\n\nOmit fields that have no information. Keep each field concise.`;
    }
  } else {
    // Auto mode: provide all templates
    const templateLines = Object.entries(TEMPLATES)
      .map(([type, tmpl]) => `For ${type.toUpperCase()} entries:\n${tmpl}`)
      .join('\n\n');
    templateInstructions = `\nUse the appropriate structured format for the text field based on the entry's category:\n${templateLines}\n\nOmit fields that have no information. Keep each field concise.`;
  }

  const messages = [
    {
      role: 'system',
      content: `You are a lorebook entry creator for interactive fiction. Create well-structured lorebook entries based on user descriptions. Output ONLY valid JSON.${templateInstructions}`,
    },
    {
      role: 'user',
      content: `Create lorebook entries based on this description:
"${prompt}"

${categoryInstruction}${existingLine}
${comprehensionBlock}${contextText ? `STORY CONTEXT:\n${contextText}\n` : ''}
Create one or more entries as appropriate for the description. Each entry needs a display name, category, search keys, and descriptive text.

Output ONLY this JSON format, no other text:
{"entries":[{"displayName":"Full Name","category":"character","keys":["key1","key2"],"text":"Entry text here."}]}`,
    },
  ];

  try {
    const response = await generateTextFn(messages, {
      max_tokens: 800,
      temperature: settings.temperature,
    });

    const content = response.output || '';
    const parsed = recoverJSON(content);

    if (parsed && Array.isArray(parsed.entries)) {
      return parsed.entries
        .filter(e =>
          typeof e.displayName === 'string' &&
          e.displayName.length > 0 &&
          typeof e.text === 'string' &&
          e.text.length > 0
        )
        .map(e => ({
          id: generateId(),
          displayName: e.displayName,
          category: allCatIds.includes(e.category) ? e.category : (category !== 'auto' ? category : 'concept'),
          keys: Array.isArray(e.keys) ? e.keys.filter(k => typeof k === 'string').slice(0, 6) : [e.displayName],
          text: e.text,
          createdAt: Date.now(),
        }));
    }
  } catch (e) {
    console.error(`${LOG_PREFIX} Error generating entries from prompt:`, e.message || e);
  }

  return [];
}

/**
 * Enrich and reformat an existing entry to match the structured template.
 * Preserves all existing information and fills in missing fields only when
 * explicitly stated or clearly demonstrated in the story.
 * @param {string} entryType - 'character'|'location'|'item'|'faction'|'concept' (default: 'character')
 */
async function enrichAndReformatEntry(displayName, currentText, generateTextFn, comprehensionContext, storyText, entryType) {
  const type = entryType || 'character';
  const template = getTemplateForType(type) || CHARACTER_TEMPLATE;

  // Strip existing metadata so LLM doesn't see it
  const { rest: textWithoutMeta } = parseMetadata(currentText || '');

  const comprehensionBlock = comprehensionContext
    ? `\nSTORY COMPREHENSION:\n${comprehensionContext}\n`
    : '';

  const storyBlock = storyText
    ? `\nRECENT STORY TEXT:\n${storyText.slice(-3000)}\n`
    : '';

  const messages = [
    {
      role: 'system',
      content: `You enrich and reformat lorebook ${type} entries. Fill in fields only if the information is explicitly stated or clearly demonstrated in the story. Leave fields blank rather than speculate. Return ONLY the reformatted text, no JSON or extra formatting.`,
    },
    {
      role: 'user',
      content: `Enrich and reformat this ${type} lorebook entry into the structured template below. Preserve ALL existing information. Fill in fields only if the information is explicitly stated or clearly demonstrated in the story. Leave fields blank rather than speculate.

Current entry for "${displayName}":
${textWithoutMeta}
${comprehensionBlock}${storyBlock}
Required format:
${template}

Omit fields that have no explicit support in the story. Keep each field concise. Return ONLY the reformatted text.`,
    },
  ];

  try {
    const response = await generateTextFn(messages, {
      max_tokens: 600,
      temperature: 0.35,
    });

    let text = (response.output || '').trim();
    if (text.length > 0) {
      // Preserve/update metadata header
      const today = new Date().toISOString().slice(0, 10);
      const existingMeta = parseMetadata(currentText || '');
      text = setMetadata(text, {
        type: existingMeta.type || type,
        version: METADATA_VERSION,
        updated: today,
        source: 'enrichment',
      });
      return text;
    }
  } catch (e) {
    console.error(`${LOG_PREFIX} Error enriching entry:`, e.message || e);
  }

  return null;
}

// Backward-compatible alias
const reformatEntryToTemplate = enrichAndReformatEntry;

/**
 * Extract a specific field value from template-formatted text.
 * For multi-line fields (Relationships, Family), returns all indented lines.
 */
function extractField(text, fieldName) {
  if (!text) return '';
  // Match "FieldName:" followed by content until next field or end
  const pattern = new RegExp(`^${fieldName.replace(/[/]/g, '\\/')}:\\s*(.*)`, 'm');
  const match = text.match(pattern);
  if (!match) return '';

  const firstLine = match[1].trim();

  // For multi-line fields (Relationships, Family), collect "- " continuation lines
  const lines = text.split('\n');
  const fieldIdx = lines.findIndex(l => pattern.test(l));
  if (fieldIdx === -1) return firstLine;

  const continuationLines = [];
  for (let i = fieldIdx + 1; i < lines.length; i++) {
    const line = lines[i];
    if (/^\s*-\s+/.test(line)) {
      continuationLines.push(line.trim());
    } else if (/^\S/.test(line)) {
      break; // Next field
    }
  }

  if (continuationLines.length > 0) {
    return (firstLine ? firstLine + '\n' : '') + continuationLines.join('\n');
  }
  return firstLine;
}

// ============================================================================
// METADATA HEADER
// ============================================================================

const METADATA_VERSION = 2;

/**
 * Parse @-prefixed metadata header from entry text.
 * Returns { type, version, updated, source, role, protagonist, rest, all }
 * where `all` is a Record<string, string> of every @key: value pair found,
 * and `rest` is the text without the header.
 */
function parseMetadata(text) {
  const empty = { type: null, version: null, updated: null, source: null, role: null, protagonist: false, rest: '', all: {} };
  if (!text) return empty;
  const lines = text.split('\n');
  const meta = { type: null, version: null, updated: null, source: null, role: null, protagonist: false };
  const all = {};
  let headerEnd = 0;

  for (let i = 0; i < lines.length; i++) {
    const m = lines[i].match(/^@([\w-]+):\s*(.+)$/);
    if (m) {
      const key = m[1].toLowerCase();
      const val = m[2].trim();
      all[key] = val;
      if (key === 'type') meta.type = val;
      else if (key === 'v') meta.version = parseInt(val, 10) || null;
      else if (key === 'updated') meta.updated = val;
      else if (key === 'source') meta.source = val;
      else if (key === 'role') meta.role = val;
      else if (key === 'protagonist') meta.protagonist = val === 'true';
      headerEnd = i + 1;
    } else {
      break;
    }
  }

  // Skip one blank line after header
  if (headerEnd > 0 && headerEnd < lines.length && lines[headerEnd].trim() === '') {
    headerEnd++;
  }

  return { ...meta, rest: lines.slice(headerEnd).join('\n'), all };
}

/**
 * Set/replace metadata header on entry text.
 * opts: { type, version, updated, source, role, protagonist, extras }
 * Named fields are handled individually. `extras` is a Record<string, string|null>
 * for arbitrary keys — null removes a key. Unknown existing keys are preserved by default.
 */
function setMetadata(text, opts) {
  const existing = parseMetadata(text);
  const type = opts.type || existing.type;
  const version = opts.version || existing.version || METADATA_VERSION;
  const updated = opts.updated || existing.updated;
  const source = opts.source || existing.source;
  // role: use explicit null to clear, undefined to preserve existing
  const role = opts.role !== undefined ? opts.role : existing.role;
  const protagonist = opts.protagonist !== undefined ? opts.protagonist : existing.protagonist;

  // Build known keys first (in canonical order)
  const headerLines = [];
  if (type) headerLines.push(`@type: ${type}`);
  if (version) headerLines.push(`@v: ${version}`);
  if (updated) headerLines.push(`@updated: ${updated}`);
  if (source) headerLines.push(`@source: ${source}`);
  if (role) headerLines.push(`@role: ${role}`);
  if (protagonist) headerLines.push(`@protagonist: true`);

  // Preserve unknown existing keys and apply extras
  const knownKeys = new Set(['type', 'v', 'updated', 'source', 'role', 'protagonist']);
  const extras = opts.extras || {};
  // Merge: existing unknowns + explicit extras (extras override existing)
  const extraKeys = {};
  for (const [k, v] of Object.entries(existing.all)) {
    if (!knownKeys.has(k)) extraKeys[k] = v;
  }
  for (const [k, v] of Object.entries(extras)) {
    if (knownKeys.has(k)) continue; // known keys handled above
    if (v === null) { delete extraKeys[k]; continue; }
    extraKeys[k] = v;
  }
  for (const [k, v] of Object.entries(extraKeys)) {
    headerLines.push(`@${k}: ${v}`);
  }

  if (headerLines.length === 0) return existing.rest;
  return headerLines.join('\n') + '\n\n' + existing.rest;
}

/**
 * Quick check: does text have a metadata header?
 */
function hasMetadata(text) {
  return !!text && /^@type:\s*\S/m.test(text);
}

/**
 * Get entry type from metadata header (authoritative), falling back to heuristic.
 */
function getEntryType(text, displayName) {
  const meta = parseMetadata(text);
  if (meta.type && ['character', 'location', 'item', 'faction', 'concept'].includes(meta.type)) {
    return meta.type;
  }
  return classifyEntryType(text, displayName);
}

/**
 * Pass 5: Propagate family names across related characters.
 * Takes all character entries, identifies missing last names, and proposes
 * consistent naming based on family relationships and story setting.
 */
async function propagateFamilyNames(characterEntries, generateTextFn, comprehensionContext) {
  if (characterEntries.length < 2) return [];

  // Separate characters into those needing names and those that already have them
  const needsLastName = [];
  const hasLastName = [];
  for (const e of characterEntries) {
    const name = (extractField(e.text, 'Name') || e.displayName || '').trim();
    if (name.split(/\s+/).length < 2) {
      needsLastName.push(e);
    } else {
      hasLastName.push(e);
    }
  }

  if (needsLastName.length === 0) return [];

  // Only include characters that are relevant: those needing names + those connected to them
  const needsNames = new Set(needsLastName.map(e =>
    (extractField(e.text, 'Name') || e.displayName || '').trim().toLowerCase()
  ));

  // Find which named characters are connected to nameless ones
  const relevantNamed = hasLastName.filter(e => {
    const family = (extractField(e.text, 'Family') || '').toLowerCase();
    const relationships = (extractField(e.text, 'Relationships') || '').toLowerCase();
    const combined = family + ' ' + relationships;
    for (const nameless of needsNames) {
      if (combined.includes(nameless.split(/\s+/)[0])) return true;
    }
    return false;
  });

  // Build compact prompt with only relevant characters
  const relevantEntries = [...needsLastName, ...relevantNamed];
  const charSummaries = relevantEntries.map(e => {
    const name = extractField(e.text, 'Name') || e.displayName;
    const family = extractField(e.text, 'Family');
    const relationships = extractField(e.text, 'Relationships');
    return `- ${name}${family ? ` | Family: ${family}` : ''}${relationships ? ` | Relationships: ${relationships}` : ''}`;
  }).join('\n');

  // Build connection graph (only between relevant characters)
  const relevantNames = relevantEntries.map(e =>
    (extractField(e.text, 'Name') || e.displayName).trim()
  );
  const connections = [];
  for (const e of relevantEntries) {
    const name = (extractField(e.text, 'Name') || e.displayName).trim();
    const combined = (extractField(e.text, 'Family') || '') + '\n' + (extractField(e.text, 'Relationships') || '');
    for (const other of relevantNames) {
      if (other !== name && combined.toLowerCase().includes(other.toLowerCase().split(/\s+/)[0].toLowerCase())) {
        connections.push(`${name} <-> ${other}`);
      }
    }
  }
  const uniqueConnections = [...new Set(connections)];
  const graphBlock = uniqueConnections.length > 0
    ? `\nCONNECTIONS:\n${uniqueConnections.join('\n')}\n`
    : '';

  const needingList = needsLastName.map(e =>
    (extractField(e.text, 'Name') || e.displayName).trim()
  ).join(', ');

  const comprehensionBlock = comprehensionContext
    ? `\nSTORY CONTEXT:\n${comprehensionContext}\n`
    : '';

  const messages = [
    {
      role: 'system',
      content: 'You assign last names to characters based on family connections. Output ONLY valid JSON.',
    },
    {
      role: 'user',
      content: `These characters need last names: ${needingList}
${comprehensionBlock}
CHARACTERS:
${charSummaries}
${graphBlock}
RULES:
1. PROPAGATE an existing last name to characters explicitly listed in that character's Family/Relationships (e.g., if "Alex Copeland" lists "Lily" as daughter, Lily becomes "Lily Copeland").
2. Characters with NO family connection to a named character get a UNIQUE NEW last name fitting the story setting.
3. NEVER assign a character's last name to someone not in their Family/Relationships.

Output: {"proposals":[{"currentName":"First","proposedName":"First Last","reason":"brief"}]}
If none needed: {"proposals":[]}`,
    },
  ];

  try {
    const response = await generateTextFn(messages, {
      max_tokens: 300,
      temperature: 0.3,
    });

    const content = response.output || '';
    const parsed = recoverJSON(content);

    if (parsed && Array.isArray(parsed.proposals)) {
      return parsed.proposals.filter(p => {
        if (typeof p.currentName !== 'string' || typeof p.proposedName !== 'string') return false;
        if (p.currentName === p.proposedName) return false;

        const currentParts = p.currentName.trim().split(/\s+/);
        const proposedParts = p.proposedName.trim().split(/\s+/);

        // Reject if character already has a last name (2+ name parts)
        if (currentParts.length > 1) return false;

        // Reject if proposed name has fewer or equal parts (stripping, not adding)
        if (proposedParts.length <= currentParts.length) return false;

        // Reject if proposed name doesn't preserve the existing first name
        if (!p.proposedName.trim().toLowerCase().startsWith(p.currentName.trim().toLowerCase())) return false;

        return true;
      });
    }
  } catch (e) {
    console.error(`${LOG_PREFIX} Error propagating family names:`, e.message || e);
  }

  return [];
}

// ============================================================================
// ENTRY TYPE CLASSIFICATION
// ============================================================================

/**
 * Heuristic classifier: determines entry type based on text patterns.
 * Returns 'character'|'location'|'item'|'faction'|'concept'|'unknown'.
 */
function classifyEntryType(text, displayName) {
  if (!text || text.length < 10) return 'unknown';

  // Check metadata header first (authoritative)
  const meta = parseMetadata(text);
  if (meta.type && ['character', 'location', 'item', 'faction', 'concept'].includes(meta.type)) {
    return meta.type;
  }

  const scores = { character: 0, location: 0, item: 0, faction: 0, concept: 0 };

  // Character patterns — reuse existing heuristics
  if (looksLikeCharacterEntry(text)) scores.character += 3;
  if (isCharacterEntryFormatted(text)) scores.character += 3;
  const charPatterns = [
    /\b(he|she|they)\s+(is|are|was|were|has|have|had)\b/i,
    /\b(personality|temperament|demeanor)\b/i,
    /\b(wears|wearing|dressed|outfit|clothing)\b/i,
    /\b(years? old|\d+\s*yo\b|age[ds]?\s*\d+)\b/i,
    /^Name:/m, /^Age:/m, /^Gender:/m, /^Relationships:/m,
  ];
  for (const p of charPatterns) if (p.test(text)) scores.character++;

  // Location patterns
  const locationPatterns = [
    /\b(city|town|village|hamlet|settlement|capital)\b/i,
    /\b(forest|mountain|valley|river|lake|ocean|sea|desert|plains|swamp|cave)\b/i,
    /\b(kingdom|realm|empire|province|region|territory|continent)\b/i,
    /\b(located|situated|lies|found in|surrounded by)\b/i,
    /\b(north|south|east|west|central) of\b/i,
    /\b(building|castle|tower|temple|church|palace|fortress|inn|tavern)\b/i,
    /\b(terrain|climate|landscape|geography)\b/i,
  ];
  for (const p of locationPatterns) if (p.test(text)) scores.location++;

  // Item patterns
  const itemPatterns = [
    /\b(weapon|sword|blade|axe|bow|staff|wand|dagger|spear)\b/i,
    /\b(armor|shield|helm|gauntlet|ring|amulet|pendant|necklace)\b/i,
    /\b(artifact|relic|enchanted|magical|cursed|blessed|forged)\b/i,
    /\b(potion|elixir|scroll|tome|book|map|key)\b/i,
    /\b(crafted|forged|created|made|wielded|worn|carried)\b/i,
  ];
  for (const p of itemPatterns) if (p.test(text)) scores.item++;

  // Faction patterns
  const factionPatterns = [
    /\b(guild|order|clan|tribe|brotherhood|sisterhood|alliance|coalition)\b/i,
    /\b(members|leader|hierarchy|ranks|founded|established)\b/i,
    /\b(organization|group|faction|sect|cult|society|council)\b/i,
    /\b(joined|recruited|member of|belongs to)\b/i,
  ];
  for (const p of factionPatterns) if (p.test(text)) scores.faction++;

  // Concept patterns
  const conceptPatterns = [
    /\b(magic|mana|power|energy|force|element)\b/i,
    /\b(system|rule|law|principle|practice|tradition)\b/i,
    /\b(ritual|ceremony|spell|incantation|enchantment)\b/i,
    /\b(theory|concept|philosophy|belief|doctrine)\b/i,
  ];
  for (const p of conceptPatterns) if (p.test(text)) scores.concept++;

  // Find winner
  const sorted = Object.entries(scores).sort((a, b) => b[1] - a[1]);
  const [bestType, bestScore] = sorted[0];
  const [, secondScore] = sorted[1];

  if (bestScore < 2) return 'unknown';
  if (secondScore > 0 && bestScore < secondScore * 1.5) return 'unknown';

  return bestType;
}

/**
 * Levenshtein edit distance between two strings.
 */
function levenshteinDistance(a, b) {
  const m = a.length, n = b.length;
  const dp = Array.from({ length: m + 1 }, () => new Array(n + 1).fill(0));
  for (let i = 0; i <= m; i++) dp[i][0] = i;
  for (let j = 0; j <= n; j++) dp[0][j] = j;
  for (let i = 1; i <= m; i++) {
    for (let j = 1; j <= n; j++) {
      dp[i][j] = a[i - 1] === b[j - 1]
        ? dp[i - 1][j - 1]
        : 1 + Math.min(dp[i - 1][j], dp[i][j - 1], dp[i - 1][j - 1]);
    }
  }
  return dp[m][n];
}

/**
 * Reusable similarity scorer for two names.
 * Returns 0–1: 1.0 exact, 0.8 substring, 0.7 close edit distance, 0 no match.
 */
function fuzzyNameScore(a, b) {
  const al = a.toLowerCase().trim();
  const bl = b.toLowerCase().trim();
  if (!al || !bl) return 0;
  if (al === bl) return 1.0;
  if (al.includes(bl) || bl.includes(al)) return 0.8;
  // Word-overlap check (Jaccard similarity on word sets)
  const wordsA = new Set(al.split(/\s+/).filter(w => w.length > 0));
  const wordsB = new Set(bl.split(/\s+/).filter(w => w.length > 0));
  if (wordsA.size > 0 && wordsB.size > 0) {
    const intersection = [...wordsA].filter(w => wordsB.has(w));
    const union = new Set([...wordsA, ...wordsB]);
    const jaccard = intersection.length / union.size;
    if (jaccard >= 0.5 && intersection.some(w => w.length >= 3)) return 0.75;
  }
  if (al.length <= 20 && bl.length <= 20) {
    const dist = levenshteinDistance(al, bl);
    if (dist <= 2) return 0.7;
  }
  return 0;
}

/**
 * Find the best matching entry for `name` among `existingEntries`.
 * Checks each entry's displayName and keys.
 * Returns { entry, score, matchedOn } or null if below threshold (default 0.7).
 */
function fuzzyFindEntry(name, existingEntries, threshold = 0.7) {
  let best = null;
  for (const entry of existingEntries) {
    const dn = entry.displayName || '';
    const dnScore = fuzzyNameScore(name, dn);
    if (dnScore >= threshold && (!best || dnScore > best.score)) {
      best = { entry, score: dnScore, matchedOn: 'displayName' };
    }
    for (const key of (entry.keys || [])) {
      const kScore = fuzzyNameScore(name, key);
      if (kScore >= threshold && (!best || kScore > best.score)) {
        best = { entry, score: kScore, matchedOn: 'key' };
      }
    }
  }
  return best;
}

/**
 * Check if `name` fuzzy-matches any string in a Set.
 * Returns true if score >= threshold (default 0.7).
 */
function fuzzyMatchInSet(name, nameSet, threshold = 0.7) {
  for (const existing of nameSet) {
    if (fuzzyNameScore(name, existing) >= threshold) return true;
  }
  return false;
}

/**
 * Find duplicate candidate pairs among lorebook entries using heuristics.
 * Returns [{entryA, entryB, similarity, reason}] sorted by similarity desc.
 */
function findDuplicateCandidates(entries) {
  const candidates = [];

  for (let i = 0; i < entries.length; i++) {
    for (let j = i + 1; j < entries.length; j++) {
      const a = entries[i], b = entries[j];
      const nameA = (a.displayName || '').toLowerCase().trim();
      const nameB = (b.displayName || '').toLowerCase().trim();
      if (!nameA || !nameB) continue;

      let similarity = 0;
      let reason = '';

      // Exact name match
      if (nameA === nameB) {
        similarity = 1.0;
        reason = 'Exact name match';
      }
      // Substring containment
      else if (nameA.includes(nameB) || nameB.includes(nameA)) {
        similarity = Math.max(similarity, 0.8);
        reason = reason || 'Name substring match';
      }
      // Levenshtein distance for short names
      else if (nameA.length <= 20 && nameB.length <= 20) {
        const dist = levenshteinDistance(nameA, nameB);
        if (dist <= 2) {
          similarity = Math.max(similarity, 0.7);
          reason = reason || `Similar names (edit distance ${dist})`;
        }
      }

      // Key overlap (Jaccard similarity)
      const keysA = new Set((a.keys || []).map(k => k.toLowerCase()));
      const keysB = new Set((b.keys || []).map(k => k.toLowerCase()));
      if (keysA.size > 0 && keysB.size > 0) {
        const intersection = [...keysA].filter(k => keysB.has(k)).length;
        const union = new Set([...keysA, ...keysB]).size;
        const jaccard = intersection / union;
        if (jaccard > 0.4) {
          similarity = Math.max(similarity, 0.5 + jaccard * 0.3);
          reason = reason || `Key overlap (${Math.round(jaccard * 100)}%)`;
        }
      }

      if (similarity > 0) {
        candidates.push({ entryA: a, entryB: b, similarity, reason });
      }
    }
  }

  candidates.sort((a, b) => b.similarity - a.similarity);
  return candidates;
}

/**
 * Group pairwise duplicate candidates into N-way clusters via union-find.
 * Returns [{entries: [...], bestEntry, similarity}] where bestEntry = longest text.
 */
function findDuplicateGroups(entries) {
  const candidates = findDuplicateCandidates(entries);
  if (candidates.length === 0) return [];

  // Union-find by entry id
  const parent = new Map();
  function find(id) {
    if (!parent.has(id)) parent.set(id, id);
    if (parent.get(id) !== id) parent.set(id, find(parent.get(id)));
    return parent.get(id);
  }
  function union(a, b) {
    const ra = find(a), rb = find(b);
    if (ra !== rb) parent.set(ra, rb);
  }

  const entryById = new Map();
  for (const c of candidates) {
    entryById.set(c.entryA.id || c.entryA.displayName, c.entryA);
    entryById.set(c.entryB.id || c.entryB.displayName, c.entryB);
    union(c.entryA.id || c.entryA.displayName, c.entryB.id || c.entryB.displayName);
  }

  // Group entries by root
  const groups = new Map();
  for (const [id, entry] of entryById) {
    const root = find(id);
    if (!groups.has(root)) groups.set(root, []);
    groups.get(root).push(entry);
  }

  // Build result — only groups with 2+ entries
  const result = [];
  for (const members of groups.values()) {
    if (members.length < 2) continue;
    // Deduplicate by id (union-find may add same entry via different pairs)
    const seen = new Set();
    const unique = members.filter(e => {
      const key = e.id || e.displayName;
      if (seen.has(key)) return false;
      seen.add(key);
      return true;
    });
    if (unique.length < 2) continue;

    // Best entry = longest text
    const bestEntry = unique.reduce((best, e) =>
      (e.text || '').length > (best.text || '').length ? e : best
    , unique[0]);

    // Average similarity from relevant pairs
    const relevantIds = new Set(unique.map(e => e.id || e.displayName));
    const pairSims = candidates.filter(c =>
      relevantIds.has(c.entryA.id || c.entryA.displayName) &&
      relevantIds.has(c.entryB.id || c.entryB.displayName)
    ).map(c => c.similarity);
    const avgSimilarity = pairSims.length > 0
      ? pairSims.reduce((s, v) => s + v, 0) / pairSims.length
      : 0;

    result.push({ entries: unique, bestEntry, similarity: avgSimilarity });
  }

  result.sort((a, b) => b.similarity - a.similarity);
  return result;
}

/**
 * LLM-confirm and merge an N-way duplicate group.
 * Single LLM call: pick best entry, produce merged text/keys.
 * Returns {keepEntry, removeEntries[], mergedText, mergedKeys, reason} or null.
 */
async function confirmAndMergeDuplicateGroup(group, storyText, generateTextFn, comprehensionContext) {
  const { entries } = group;
  if (entries.length < 2) return null;

  const entryDescriptions = entries.map((e, idx) => {
    return `Entry ${idx + 1}: "${e.displayName}" [keys: ${(e.keys || []).join(', ')}]\n  ${(e.text || '').slice(0, 300)}`;
  }).join('\n\n');

  const comprehensionBlock = comprehensionContext
    ? `\nSTORY CONTEXT:\n${comprehensionContext}\n`
    : '';

  const messages = [
    {
      role: 'system',
      content: 'You analyze lorebook entries for duplicates. Output ONLY valid JSON.',
    },
    {
      role: 'user',
      content: `These ${entries.length} lorebook entries may all refer to the same entity. Analyze them and determine:
1. Are they all duplicates of the same entity? (yes/no)
2. If yes, which entry number should be kept (the most complete one)?
3. Provide merged text combining all unique information, and merged keys.
${comprehensionBlock}
${entryDescriptions}

Output ONLY this JSON:
{"isDuplicate":true,"keepIndex":1,"mergedText":"...","mergedKeys":["key1","key2"],"reason":"explanation"}
If NOT duplicates: {"isDuplicate":false,"reason":"why not"}`,
    },
  ];

  try {
    const response = await generateTextFn(messages, {
      max_tokens: 800,
      temperature: 0.3,
    });

    const parsed = recoverJSON(response.output || '');
    if (!parsed || !parsed.isDuplicate) return null;

    const keepIdx = Math.max(0, Math.min((parsed.keepIndex || 1) - 1, entries.length - 1));
    const keepEntry = entries[keepIdx];
    const removeEntries = entries.filter((_, i) => i !== keepIdx);

    return {
      keepEntry,
      removeEntries,
      mergedText: parsed.mergedText || keepEntry.text || '',
      mergedKeys: Array.isArray(parsed.mergedKeys) ? parsed.mergedKeys : (keepEntry.keys || []),
      reason: parsed.reason || `Merged ${entries.length} duplicate entries`,
    };
  } catch (err) {
    console.error(`${LOG_PREFIX} confirmAndMergeDuplicateGroup failed:`, err.message);
    return null;
  }
}

// ============================================================================
// LLM-BASED ORGANIZE FUNCTIONS
// ============================================================================

/**
 * Confirm heuristic duplicate candidates via LLM. Batches of 5.
 * Returns confirmed merges: [{keepEntry, removeEntry, mergedText, mergedKeys, reason}]
 */
async function confirmAndMergeDuplicates(candidates, entries, storyText, generateTextFn, comprehensionContext) {
  if (candidates.length === 0) return [];

  const confirmed = [];
  const batchSize = 5;

  for (let i = 0; i < candidates.length; i += batchSize) {
    if (i > 0) await delay(INTER_CALL_DELAY);

    const batch = candidates.slice(i, i + batchSize);
    const pairDescriptions = batch.map((c, idx) => {
      const a = c.entryA, b = c.entryB;
      return `Pair ${idx + 1}:
  A: "${a.displayName}" [keys: ${(a.keys || []).join(', ')}]
     ${(a.text || '').slice(0, 200)}
  B: "${b.displayName}" [keys: ${(b.keys || []).join(', ')}]
     ${(b.text || '').slice(0, 200)}`;
    }).join('\n\n');

    const comprehensionBlock = comprehensionContext
      ? `\nSTORY CONTEXT:\n${comprehensionContext}\n`
      : '';

    const messages = [
      {
        role: 'system',
        content: 'You analyze lorebook entries for duplicates. Output ONLY valid JSON.',
      },
      {
        role: 'user',
        content: `Are these pairs of lorebook entries duplicates (same entity described twice)?
${comprehensionBlock}
${pairDescriptions}

For each pair, determine if they describe the same entity. If duplicate, merge their information and pick the better entry to keep (longer, more detailed). If NOT duplicates, mark as keep_both.

Output ONLY this JSON:
{"results":[{"pair":1,"isDuplicate":true,"keepIndex":"A","mergedText":"combined entry text","mergedKeys":["key1","key2"],"reason":"why duplicate"}]}
Use keepIndex "A" or "B". For non-duplicates: {"pair":1,"isDuplicate":false}`,
      },
    ];

    try {
      const response = await generateTextFn(messages, {
        max_tokens: 600,
        temperature: 0.3,
      });

      const parsed = recoverJSON(response.output || '');
      if (parsed && Array.isArray(parsed.results)) {
        for (const r of parsed.results) {
          if (!r.isDuplicate) continue;
          const pairIdx = (r.pair || 1) - 1;
          if (pairIdx < 0 || pairIdx >= batch.length) continue;

          const candidate = batch[pairIdx];
          const keep = r.keepIndex === 'B' ? candidate.entryB : candidate.entryA;
          const remove = r.keepIndex === 'B' ? candidate.entryA : candidate.entryB;

          confirmed.push({
            keepEntry: keep,
            removeEntry: remove,
            mergedText: typeof r.mergedText === 'string' ? r.mergedText : keep.text,
            mergedKeys: Array.isArray(r.mergedKeys) ? r.mergedKeys.filter(k => typeof k === 'string') : keep.keys,
            reason: r.reason || candidate.reason,
          });
        }
      }
    } catch (e) {
      console.error(`${LOG_PREFIX} Error confirming duplicates:`, e.message || e);
    }
  }

  return confirmed;
}

/**
 * Classify entries that heuristics couldn't categorize, using LLM. Groups of 12.
 * Returns [{entryId, displayName, suggestedType, confidence}]
 */
async function classifyUnknownEntries(unknownEntries, generateTextFn, customCategories) {
  if (unknownEntries.length === 0) return [];

  const registry = buildCategoryRegistry(customCategories);
  const allCatIds = getCategoryIds(registry);

  const results = [];
  const batchSize = 12;

  for (let i = 0; i < unknownEntries.length; i += batchSize) {
    if (i > 0) await delay(INTER_CALL_DELAY);

    const batch = unknownEntries.slice(i, i + batchSize);
    const entryList = batch.map((e, idx) =>
      `${idx + 1}. "${e.displayName}": ${(e.text || '').slice(0, 150)}`
    ).join('\n');

    const messages = [
      {
        role: 'system',
        content: 'You classify lorebook entries into categories. Output ONLY valid JSON.',
      },
      {
        role: 'user',
        content: `Classify each entry into one of: ${allCatIds.join(', ')}.

${entryList}

Output ONLY this JSON:
{"classifications":[{"index":1,"type":"character","confidence":4}]}
- confidence: 1-5 how sure you are`,
      },
    ];

    try {
      const response = await generateTextFn(messages, {
        max_tokens: 300,
        temperature: 0.2,
      });

      const parsed = recoverJSON(response.output || '');
      if (parsed && Array.isArray(parsed.classifications)) {
        for (const c of parsed.classifications) {
          const idx = (c.index || 1) - 1;
          if (idx < 0 || idx >= batch.length) continue;
          if (!allCatIds.includes(c.type)) continue;
          if (typeof c.confidence !== 'number' || c.confidence < 3) continue;

          results.push({
            entryId: batch[idx].id,
            displayName: batch[idx].displayName,
            suggestedType: c.type,
            confidence: c.confidence,
          });
        }
      }
    } catch (e) {
      console.error(`${LOG_PREFIX} Error classifying entries:`, e.message || e);
    }
  }

  return results;
}

/**
 * Update Family/Relationships fields in already-formatted character entries.
 * Returns {family, relationships} with updated sections, or {noUpdate: true}.
 */
async function updateRelationshipFields(displayName, currentText, storyText, generateTextFn, comprehensionContext) {
  const currentFamily = extractField(currentText, 'Family');
  const currentRelationships = extractField(currentText, 'Relationships');

  const comprehensionBlock = comprehensionContext
    ? `\nSTORY COMPREHENSION:\n${comprehensionContext}\n`
    : '';

  const maxStoryChars = 6000 - (currentFamily.length + currentRelationships.length + comprehensionBlock.length + 800);
  const contextText = storyText.length > maxStoryChars
    ? storyText.slice(-maxStoryChars)
    : storyText;

  const messages = [
    {
      role: 'system',
      content: 'You analyze story text to detect new relationship and family information for existing character entries. Output ONLY valid JSON.',
    },
    {
      role: 'user',
      content: `Does the story reveal new family or relationship info about "${displayName}" not already recorded?

Current Family field:
${currentFamily || '(empty)'}

Current Relationships field:
${currentRelationships || '(empty)'}
${comprehensionBlock}
Recent story text:
${contextText}

Look for:
- New family members mentioned or implied
- New relationships (rivals, mentors, allies, lovers, etc.)
- Changed relationship dynamics (e.g. friendship becoming rivalry)

If new info found, return the COMPLETE updated field content (keep existing + add new).
If no new info, return noUpdate.

Output ONLY one of these JSON formats:
{"family":"- Name: role\\n- Name: role","relationships":"- Name: relationship type and dynamic\\n- Name: detail"}
{"noUpdate":true}

Include ALL existing entries plus new ones. Use "- Name: detail" format, one per line.`,
    },
  ];

  try {
    const response = await generateTextFn(messages, {
      max_tokens: 400,
      temperature: 0.35,
    });

    const parsed = recoverJSON(response.output || '');
    if (!parsed) return { noUpdate: true };
    if (parsed.noUpdate === true) return { noUpdate: true };

    const result = {};
    if (typeof parsed.family === 'string' && parsed.family.length > 0) {
      result.family = parsed.family;
    }
    if (typeof parsed.relationships === 'string' && parsed.relationships.length > 0) {
      result.relationships = parsed.relationships;
    }

    if (Object.keys(result).length === 0) return { noUpdate: true };
    return result;
  } catch (e) {
    console.error(`${LOG_PREFIX} Error updating relationships for ${displayName}:`, e.message || e);
    return { noUpdate: true };
  }
}

/**
 * Splice updated family/relationships fields into existing template-formatted text.
 */
function spliceRelationshipFields(currentText, updates) {
  let text = currentText;

  if (updates.relationships) {
    const relLines = updates.relationships.split('\n').map(l => l.trim()).filter(Boolean);
    const relBlock = relLines.map(l => l.startsWith('-') ? l : `- ${l}`).join('\n');
    const relPattern = /^Relationships:.*(?:\n(?:\s*-\s+.*|\s*))*$/m;
    if (relPattern.test(text)) {
      text = text.replace(relPattern, `Relationships:\n${relBlock}`);
    } else {
      // Append before Family:, Background:, Additional notes:, or at end
      const insertPoint = text.search(/^(Family|Background|Additional notes):/m);
      if (insertPoint >= 0) {
        text = text.slice(0, insertPoint) + `Relationships:\n${relBlock}\n\n` + text.slice(insertPoint);
      } else {
        text = text.trimEnd() + `\n\nRelationships:\n${relBlock}`;
      }
    }
  }

  if (updates.family) {
    const familyLines = updates.family.split('\n').map(l => l.trim()).filter(Boolean);
    const familyBlock = familyLines.map(l => l.startsWith('-') ? l : `- ${l}`).join('\n');
    const familyPattern = /^Family:.*(?:\n(?:\s*-\s+.*|\s*))*$/m;
    if (familyPattern.test(text)) {
      text = text.replace(familyPattern, `Family:\n${familyBlock}`);
    } else {
      // Append before Background:, Additional notes:, or at end
      const insertPoint = text.search(/^(Background|Additional notes):/m);
      if (insertPoint >= 0) {
        text = text.slice(0, insertPoint) + `Family:\n${familyBlock}\n\n` + text.slice(insertPoint);
      } else {
        text = text.trimEnd() + `\n\nFamily:\n${familyBlock}`;
      }
    }
  }

  return text;
}

// ============================================================================
// ORGANIZE ORCHESTRATOR
// ============================================================================

/**
 * Organize lorebook: classify, deduplicate, recategorize.
 *
 * @param {object[]} entries - Current lorebook entries
 * @param {string} storyText - Full story text
 * @param {object} settings - Lore settings
 * @param {function} generateTextFn - LLM function
 * @param {function} onProgress - Progress callback
 * @param {string} comprehensionContext - Story comprehension
 * @param {object} categoryMap - {categoryId: typeName} reverse map
 * @param {string[]} dismissedCleanupIds - Previously dismissed cleanup IDs
 * @returns {{cleanups: object[]}}
 */
async function organizeLorebook(entries, storyText, settings, generateTextFn, onProgress, comprehensionContext, categoryMap, dismissedCleanupIds) {
  const cleanups = [];
  const dismissedSet = new Set(dismissedCleanupIds || []);

  // Phase 1: Classify all entries
  if (onProgress) onProgress({ phase: 'classifying' });
  console.log(`${LOG_PREFIX} Organize: classifying ${entries.length} entries`);

  const classifications = new Map(); // entryId -> type
  const unknowns = [];

  for (const entry of entries) {
    const type = classifyEntryType(entry.text, entry.displayName);
    if (type === 'unknown') {
      unknowns.push(entry);
    } else {
      classifications.set(entry.id, type);
    }
  }

  console.log(`${LOG_PREFIX} Heuristic: ${classifications.size} classified, ${unknowns.length} unknown`);

  // LLM fallback for unknowns
  if (unknowns.length > 0) {
    if (onProgress) onProgress({ phase: 'classifying-llm' });
    const llmClassified = await classifyUnknownEntries(unknowns, generateTextFn, settings.customCategories);
    for (const c of llmClassified) {
      classifications.set(c.entryId, c.suggestedType);
    }
    console.log(`${LOG_PREFIX} LLM classified ${llmClassified.length} additional entries`);
  }

  // Phase 2: Detect duplicates
  if (onProgress) onProgress({ phase: 'deduplicating' });
  console.log(`${LOG_PREFIX} Organize: finding duplicates`);

  const dupCandidates = findDuplicateCandidates(entries);
  console.log(`${LOG_PREFIX} Found ${dupCandidates.length} duplicate candidates`);

  if (dupCandidates.length > 0) {
    if (onProgress) onProgress({ phase: 'confirming-duplicates' });
    const confirmed = await confirmAndMergeDuplicates(
      dupCandidates.slice(0, 15), entries, storyText, generateTextFn, comprehensionContext
    );

    for (const merge of confirmed) {
      const cleanupId = `dup_${merge.keepEntry.id}_${merge.removeEntry.id}`;
      if (dismissedSet.has(cleanupId)) continue;

      cleanups.push({
        id: cleanupId,
        type: 'duplicate',
        keepEntry: {
          id: merge.keepEntry.id,
          displayName: merge.keepEntry.displayName,
          keys: merge.keepEntry.keys,
          text: merge.keepEntry.text,
        },
        removeEntry: {
          id: merge.removeEntry.id,
          displayName: merge.removeEntry.displayName,
          keys: merge.removeEntry.keys,
          text: merge.removeEntry.text,
        },
        mergedText: merge.mergedText,
        mergedKeys: merge.mergedKeys,
        reason: merge.reason,
      });
    }
  }

  // Phase 3: Identify misplaced/legacy entries
  if (onProgress) onProgress({ phase: 'recategorizing' });
  console.log(`${LOG_PREFIX} Organize: checking categories`);

  // Build typeToExpectedCatName from registry (includes custom categories)
  const registry = buildCategoryRegistry(settings.customCategories);
  const typeToExpectedCatName = {};
  for (const cat of registry) {
    typeToExpectedCatName[cat.id] = cat.displayName;
  }

  // categoryMap is {catId: catName}
  const catNameToId = {};
  for (const [catId, catName] of Object.entries(categoryMap || {})) {
    catNameToId[catName.toLowerCase()] = catId;
  }

  const loreCreatorCatId = catNameToId['lore creator'] || null;

  for (const entry of entries) {
    const classifiedType = classifications.get(entry.id);
    if (!classifiedType) continue;

    const currentCatId = entry.category;
    const currentCatName = currentCatId ? (categoryMap[currentCatId] || '') : '';
    const expectedCatName = typeToExpectedCatName[classifiedType];
    const expectedCatId = catNameToId[expectedCatName.toLowerCase()];

    // Skip if already in the correct category
    if (currentCatId && currentCatId === expectedCatId) continue;

    // Determine cleanup type
    const isLegacy = !currentCatId || currentCatId === loreCreatorCatId;
    const cleanupType = isLegacy ? 'legacy-move' : 'recategorize';

    const cleanupId = `${cleanupType}_${entry.id}_${classifiedType}`;
    if (dismissedSet.has(cleanupId)) continue;

    cleanups.push({
      id: cleanupId,
      type: cleanupType,
      entryId: entry.id,
      displayName: entry.displayName,
      currentCategory: currentCatName || '(uncategorized)',
      currentCategoryId: currentCatId,
      proposedCategory: expectedCatName,
      proposedType: classifiedType,
      proposedCategoryId: expectedCatId || null,
    });
  }

  // Phase 4: Suggest metadata headers for entries missing @type
  for (const entry of entries) {
    if (hasMetadata(entry.text)) continue;
    const classifiedType = classifications.get(entry.id);
    if (!classifiedType || classifiedType === 'unknown') continue;

    const cleanupId = `add-metadata_${entry.id}`;
    if (dismissedSet.has(cleanupId)) continue;

    cleanups.push({
      id: cleanupId,
      type: 'add-metadata',
      entryId: entry.id,
      displayName: entry.displayName,
      proposedType: classifiedType,
      currentText: entry.text,
    });
  }

  console.log(`${LOG_PREFIX} Organize complete: ${cleanups.length} cleanups proposed`);
  return { cleanups };
}

// ============================================================================
// DEDUPLICATION
// ============================================================================

/**
 * Partitions identified elements into new, existing (match lorebook), and merge
 * (LLM-detected same entity). Filters out pending/rejected/dismissed.
 */
function partitionElements(elements, existingEntries, state) {
  const excludeNames = new Set();
  const pendingMergeTargets = new Set();

  for (const pending of (state.pendingEntries || [])) {
    excludeNames.add(pending.displayName.toLowerCase());
    for (const key of (pending.keys || [])) {
      excludeNames.add(key.toLowerCase());
    }
  }

  for (const update of (state.pendingUpdates || [])) {
    excludeNames.add(update.displayName.toLowerCase());
    for (const key of (update.keys || [])) {
      excludeNames.add(key.toLowerCase());
    }
  }

  for (const merge of (state.pendingMerges || [])) {
    excludeNames.add(merge.newName.toLowerCase());
    pendingMergeTargets.add(merge.existingDisplayName.toLowerCase());
  }

  for (const rejected of (state.rejectedNames || [])) {
    excludeNames.add(rejected.toLowerCase());
  }

  for (const dismissed of (state.dismissedUpdateNames || [])) {
    excludeNames.add(dismissed.toLowerCase());
  }

  const rejectedMergePairs = new Set(
    (state.rejectedMergeNames || []).map(p => p.toLowerCase())
  );

  // Build name→entry map
  const entryByName = new Map();
  for (const entry of existingEntries) {
    if (entry.displayName) {
      entryByName.set(entry.displayName.toLowerCase(), entry);
    }
    for (const key of (entry.keys || [])) {
      if (!entryByName.has(key.toLowerCase())) {
        entryByName.set(key.toLowerCase(), entry);
      }
    }
  }

  const newElements = [];
  const existingElements = [];
  const mergeElements = [];

  for (const el of elements) {
    const nameLower = el.name.toLowerCase();
    if (excludeNames.has(nameLower) || fuzzyMatchInSet(el.name, excludeNames)) continue;

    if (el.mergesWith) {
      const mergePairKey = `${nameLower}->${el.mergesWith.toLowerCase()}`;
      if (rejectedMergePairs.has(mergePairKey)) {
        newElements.push({ name: el.name, category: el.category });
        continue;
      }
      let mergeTarget = entryByName.get(el.mergesWith.toLowerCase());
      if (!mergeTarget) {
        const fuzzyResult = fuzzyFindEntry(el.mergesWith, existingEntries);
        if (fuzzyResult) mergeTarget = fuzzyResult.entry;
      }
      if (mergeTarget) {
        const targetName = (mergeTarget.displayName || el.mergesWith).toLowerCase();
        if (pendingMergeTargets.has(targetName)) {
          newElements.push({ name: el.name, category: el.category });
          continue;
        }
        mergeElements.push({
          name: el.name,
          category: el.category,
          mergeTarget: mergeTarget.displayName || el.mergesWith,
          entry: mergeTarget,
        });
        continue;
      }
    }

    let matchedEntry = entryByName.get(nameLower);
    if (!matchedEntry) {
      const fuzzyResult = fuzzyFindEntry(el.name, existingEntries);
      if (fuzzyResult) matchedEntry = fuzzyResult.entry;
    }
    if (matchedEntry) {
      existingElements.push({ name: el.name, category: el.category, entry: matchedEntry });
    } else {
      newElements.push({ name: el.name, category: el.category });
    }
  }

  return { newElements, existingElements, mergeElements };
}

// ============================================================================
// HYBRID PROVIDER WRAPPER
// ============================================================================

/**
 * Wraps a secondary LLM provider with auto-fallback: if the secondary fails,
 * retries with the primary and disables the secondary for remaining calls.
 * Returns { providers, getProviders } where getProviders() returns the current
 * active provider array (may shrink to [primary] if secondary dies).
 */
function createHybridProviders(primaryFn, secondaryFn) {
  let secondaryAlive = !!secondaryFn;
  let failCount = 0;

  const wrappedSecondary = async (messages, options) => {
    if (!secondaryAlive) return primaryFn(messages, options);
    try {
      return await secondaryFn(messages, options);
    } catch (err) {
      failCount++;
      console.error(`${LOG_PREFIX} Secondary provider failed (${failCount}x): ${err.message}`);
      if (failCount >= 2) {
        secondaryAlive = false;
        console.log(`${LOG_PREFIX} Secondary provider disabled — falling back to primary only`);
      }
      // Retry this call with primary
      return primaryFn(messages, options);
    }
  };

  return {
    getProviders: () => secondaryAlive ? [primaryFn, wrappedSecondary] : [primaryFn],
    isHybrid: () => secondaryAlive,
  };
}

// ============================================================================
// SCAN ORCHESTRATOR
// ============================================================================

/**
 * Full scan pipeline: identify → partition → generate entries → process merges → detect updates.
 *
 * @param {string} storyText - Full story text
 * @param {object} settings - Lore settings
 * @param {object[]} existingEntries - Current lorebook entries [{displayName, keys, text}]
 * @param {object} state - Current lore state (pendingEntries, rejectedNames, etc.)
 * @param {function} generateTextFn - LLM call function(messages, options) => {output}
 * @param {function} [onProgress] - Optional progress callback({phase, pendingEntries, pendingMerges, pendingUpdates})
 * @returns {object} Updated state + scan results
 */
async function scanForLore(storyText, settings, existingEntries, state, generateTextFn, onProgress, comprehensionContext, secondaryGenerateTextFn) {
  if (storyText.trim().length < 100) {
    return { state, error: 'Not enough story content to analyze' };
  }

  // Relationships-only mode: skip passes 1-5, only run Pass 3b
  if (settings._relationshipsOnly) {
    const updatedState = JSON.parse(JSON.stringify(state));
    let relationshipUpdatesFound = 0;

    const formattedChars = existingEntries.filter(e =>
      e.text && e.text.length > 30 &&
      isCharacterEntryFormatted(e.text)
    );

    if (formattedChars.length === 0) {
      return { state, noResults: true };
    }

    if (onProgress) onProgress({ phase: 'updating-relationships' });
    console.log(`${LOG_PREFIX} Relationships scan: checking ${formattedChars.length} formatted characters`);

    const pendingNames = new Set(
      (updatedState.pendingUpdates || []).map(u => u.displayName.toLowerCase())
    );

    for (const entry of formattedChars) {
      if (pendingNames.has((entry.displayName || '').toLowerCase())) continue;
      await delay(INTER_CALL_DELAY);

      try {
        const relUpdate = await updateRelationshipFields(
          entry.displayName, entry.text, storyText, generateTextFn, comprehensionContext
        );

        if (!relUpdate.noUpdate) {
          const updatedText = spliceRelationshipFields(entry.text, relUpdate);
          if (updatedText !== entry.text) {
            updatedState.pendingUpdates.push({
              id: generateId(),
              displayName: entry.displayName,
              keys: entry.keys || [],
              category: 'character',
              originalText: entry.text,
              updatedText,
              isRelationshipUpdate: true,
              createdAt: Date.now(),
            });
            relationshipUpdatesFound++;
            if (onProgress) onProgress({ phase: 'updating-relationships', pendingUpdates: updatedState.pendingUpdates });
          }
        }
      } catch (err) {
        console.error(`${LOG_PREFIX} Relationship update failed for ${entry.displayName}:`, err.message);
      }
    }

    updatedState.charsSinceLastScan = 0;
    const summary = { generated: 0, mergesFound: 0, updatesFound: 0, relationshipUpdatesFound, reformatsFound: 0, nameProposals: 0 };
    console.log(`${LOG_PREFIX} Relationships scan complete:`, summary);
    return { state: updatedState, summary, noResults: relationshipUpdatesFound === 0 };
  }

  // Work on a copy of state (moved before Pass 0 so dedup cleanups can be added)
  const updatedState = JSON.parse(JSON.stringify(state));

  // Pass 0: Proactive deduplication — find and group existing duplicates
  if (existingEntries.length >= 4) {
    if (onProgress) onProgress({ phase: 'deduplicating' });
    console.log(`${LOG_PREFIX} Pass 0: Checking ${existingEntries.length} entries for duplicates`);

    const dupGroups = findDuplicateGroups(existingEntries);
    const dismissedSet = new Set(updatedState.dismissedCleanupIds || []);
    const existingCleanupKeys = new Set(
      (updatedState.pendingCleanups || []).map(c => c.id)
    );

    if (dupGroups.length > 0) {
      if (onProgress) onProgress({ phase: 'confirming-duplicates' });
      console.log(`${LOG_PREFIX} Found ${dupGroups.length} duplicate groups, confirming via LLM...`);

      for (const group of dupGroups.slice(0, 5)) {
        const groupKey = `dupgrp_${group.entries.map(e => e.id || e.displayName).sort().join('_')}`;
        if (dismissedSet.has(groupKey) || existingCleanupKeys.has(groupKey)) continue;

        await delay(INTER_CALL_DELAY);
        const result = await confirmAndMergeDuplicateGroup(group, storyText, generateTextFn, comprehensionContext);
        if (result) {
          if (!updatedState.pendingCleanups) updatedState.pendingCleanups = [];
          updatedState.pendingCleanups.push({
            id: groupKey,
            type: 'duplicate-group',
            keepEntry: {
              id: result.keepEntry.id,
              displayName: result.keepEntry.displayName,
              keys: result.keepEntry.keys,
              text: result.keepEntry.text,
            },
            removeEntries: result.removeEntries.map(e => ({
              id: e.id,
              displayName: e.displayName,
              keys: e.keys,
              text: e.text,
            })),
            mergedText: result.mergedText,
            mergedKeys: result.mergedKeys,
            reason: result.reason,
          });
          console.log(`${LOG_PREFIX} Confirmed duplicate group: ${result.keepEntry.displayName} + ${result.removeEntries.length} others`);
        }
      }
    }
  }

  const existingEntryNames = existingEntries
    .map(e => e.displayName)
    .filter(n => n.length > 0);

  // Pass 1: Identify elements
  if (onProgress) onProgress({ phase: 'identifying' });
  console.log(`${LOG_PREFIX} Scanning ${storyText.length} chars for lore elements...`);

  const elements = await identifyLoreElements(storyText, settings, existingEntries, generateTextFn, comprehensionContext);

  if (elements.length === 0) {
    console.log(`${LOG_PREFIX} No elements identified`);
    return { state, noResults: true };
  }

  console.log(`${LOG_PREFIX} Identified ${elements.length} elements, partitioning...`);

  // Partition
  const { newElements, existingElements, mergeElements } = partitionElements(elements, existingEntries, state);

  if (newElements.length === 0 && existingElements.length === 0 && mergeElements.length === 0) {
    console.log(`${LOG_PREFIX} All elements already known or excluded`);
    // Return updatedState (not original) — Pass 0 may have added dedup cleanups
    const hasDedup = (updatedState.pendingCleanups || []).length > (state.pendingCleanups || []).length;
    return { state: hasDedup ? updatedState : state, noResults: !hasDedup };
  }

  // Set up hybrid providers with auto-fallback
  const hybrid = createHybridProviders(generateTextFn, secondaryGenerateTextFn);

  // Pass 2: Generate entries for new elements (hybrid parallel when secondary available)
  let generated = 0;
  if (newElements.length > 0) {
    if (onProgress) onProgress({ phase: 'generating' });
    console.log(`${LOG_PREFIX} Generating entries for ${newElements.length} new elements${hybrid.isHybrid() ? ' (hybrid parallel)' : ''}...`);

    for (let i = 0; i < newElements.length;) {
      if (i > 0) await delay(INTER_CALL_DELAY);
      const activeProviders = hybrid.getProviders();

      const batch = newElements.slice(i, i + activeProviders.length);
      const promises = batch.map((elem, idx) =>
        generateLoreEntryFromElement(
          elem.name, elem.category, storyText, settings,
          existingEntryNames, activeProviders[idx], comprehensionContext
        ).catch(err => {
          console.error(`${LOG_PREFIX} Provider ${idx} failed for ${elem.name}:`, err.message);
          return null;
        })
      );
      i += activeProviders.length;

      const results = await Promise.all(promises);
      for (const entry of results) {
        if (entry && entry.text.length > 0) {
          updatedState.pendingEntries.push(entry);
          generated++;
          if (onProgress) onProgress({ phase: 'generating', pendingEntries: updatedState.pendingEntries });
        }
      }
    }
  }

  // Post-Pass-2: deduplicate newly generated entries against each other
  if (updatedState.pendingEntries.length > 1) {
    const seen = new Map();
    const toRemove = new Set();
    for (let j = 0; j < updatedState.pendingEntries.length; j++) {
      const entry = updatedState.pendingEntries[j];
      const name = (entry.displayName || '').toLowerCase();
      let isDup = false;
      for (const [seenName, seenIdx] of seen) {
        if (fuzzyNameScore(name, seenName) >= 0.7) {
          const seenEntry = updatedState.pendingEntries[seenIdx];
          if ((entry.text || '').length > (seenEntry.text || '').length) {
            toRemove.add(seenIdx);
            seen.set(name, j);
          } else {
            toRemove.add(j);
          }
          isDup = true;
          break;
        }
      }
      if (!isDup) seen.set(name, j);
    }
    if (toRemove.size > 0) {
      console.log(`${LOG_PREFIX} Post-Pass-2 dedup: removing ${toRemove.size} duplicate pending entries`);
      updatedState.pendingEntries = updatedState.pendingEntries.filter((_, idx) => !toRemove.has(idx));
      generated = updatedState.pendingEntries.length;
    }
  }

  // Merge phase (hybrid parallel when secondary available)
  let mergesFound = 0;
  const mergeCount = Math.min(mergeElements.length, MAX_UPDATES_PER_SCAN);
  if (mergeCount > 0) {
    if (onProgress) onProgress({ phase: 'processing-merges' });
    console.log(`${LOG_PREFIX} Processing ${mergeCount} identity merges...`);

    const toMerge = mergeElements.slice(0, mergeCount);
    for (let i = 0; i < toMerge.length;) {
      await delay(INTER_CALL_DELAY);
      const mergeProviders = hybrid.getProviders();

      const batch = toMerge.slice(i, i + mergeProviders.length);
      const promises = batch.map((elem, idx) => {
        const { name, category, mergeTarget, entry } = elem;
        return detectEntryUpdate(
          entry.displayName || mergeTarget, entry.text, storyText, settings,
          mergeProviders[idx], comprehensionContext
        ).then(updatedText => ({ name, category, mergeTarget, entry, updatedText }))
         .catch(err => {
           console.error(`${LOG_PREFIX} Merge provider ${idx} failed for ${name}:`, err.message);
           return { name, category, mergeTarget, entry, updatedText: null };
         });
      });
      i += mergeProviders.length;

      const results = await Promise.all(promises);
      for (const { name, category, mergeTarget, entry, updatedText } of results) {
        const mergedKeysSet = new Set((entry.keys || []).map(k => k.toLowerCase()));
        if (entry.displayName) mergedKeysSet.add(entry.displayName.toLowerCase());
        mergedKeysSet.add(name.toLowerCase());
        const mergedKeys = Array.from(mergedKeysSet).map(k => {
          const original = (entry.keys || []).find(ek => ek.toLowerCase() === k);
          if (k === name.toLowerCase()) return name;
          return original || (k === (entry.displayName || '').toLowerCase() ? entry.displayName : k);
        }).slice(0, 6);

        updatedState.pendingMerges.push({
          id: generateId(),
          newName: name,
          newCategory: category,
          existingDisplayName: entry.displayName || mergeTarget,
          existingKeys: entry.keys || [],
          existingText: entry.text || '',
          proposedDisplayName: name,
          proposedKeys: mergedKeys,
          proposedText: updatedText || entry.text || '',
          createdAt: Date.now(),
        });
        mergesFound++;
        if (onProgress) onProgress({ phase: 'processing-merges', pendingMerges: updatedState.pendingMerges });
      }
    }
  }

  // Pass 3: Detect updates for existing entries (hybrid parallel when secondary available)
  let updatesFound = 0;
  const updateBudget = Math.max(0, MAX_UPDATES_PER_SCAN - mergeCount);
  if (existingElements.length > 0 && settings.autoDetectUpdates && updateBudget > 0) {
    if (onProgress) onProgress({ phase: 'checking-updates' });
    console.log(`${LOG_PREFIX} Checking ${Math.min(existingElements.length, updateBudget)} entries for updates...`);

    const toCheck = existingElements.slice(0, updateBudget);
    for (let i = 0; i < toCheck.length;) {
      await delay(INTER_CALL_DELAY);
      const updateProviders = hybrid.getProviders();

      const batch = toCheck.slice(i, i + updateProviders.length);
      const promises = batch.map((elem, idx) => {
        const { name, category, entry } = elem;
        return detectEntryUpdate(
          entry.displayName || name, entry.text, storyText, settings,
          updateProviders[idx], comprehensionContext
        ).then(updatedText => ({ name, category, entry, updatedText }))
         .catch(err => {
           console.error(`${LOG_PREFIX} Update provider ${idx} failed for ${name}:`, err.message);
           return { name, category, entry, updatedText: null };
         });
      });
      i += updateProviders.length;

      const results = await Promise.all(promises);
      for (const { name, category, entry, updatedText } of results) {
        if (updatedText) {
          updatedState.pendingUpdates.push({
            id: generateId(),
            displayName: entry.displayName || name,
            keys: entry.keys || [],
            category,
            originalText: entry.text || '',
            updatedText,
            createdAt: Date.now(),
          });
          updatesFound++;
          if (onProgress) onProgress({ phase: 'checking-updates', pendingUpdates: updatedState.pendingUpdates });
        }
      }
    }
  }

  // Pass 3b: Update Family/Relationships in already-formatted character entries
  const MAX_RELATIONSHIP_UPDATES = 5;
  let relationshipUpdatesFound = 0;
  const pendingUpdateNames = new Set(
    updatedState.pendingUpdates.map(u => u.displayName.toLowerCase())
  );
  const formattedChars = existingEntries.filter(e =>
    e.text && e.text.length > 30 &&
    (getEntryType(e.text, e.displayName) === 'character' || looksLikeCharacterEntry(e.text)) &&
    !pendingUpdateNames.has((e.displayName || '').toLowerCase())
  );

  if (formattedChars.length > 0 && settings.autoDetectUpdates) {
    if (onProgress) onProgress({ phase: 'updating-relationships' });
    console.log(`${LOG_PREFIX} Pass 3b: Checking ${formattedChars.length} formatted characters for relationship updates${hybrid.isHybrid() ? ' (hybrid parallel)' : ''}`);

    const relBudget = Math.min(formattedChars.length, MAX_RELATIONSHIP_UPDATES);
    for (let i = 0; i < relBudget;) {
      await delay(INTER_CALL_DELAY);
      const relProviders = hybrid.getProviders();

      const batch = formattedChars.slice(i, Math.min(i + relProviders.length, relBudget));
      const promises = batch.map((entry, idx) =>
        updateRelationshipFields(
          entry.displayName, entry.text, storyText, relProviders[idx], comprehensionContext
        ).then(relUpdate => ({ entry, relUpdate }))
         .catch(err => {
           console.error(`${LOG_PREFIX} Relationship update failed for ${entry.displayName}:`, err.message);
           return { entry, relUpdate: null };
         })
      );
      i += relProviders.length;

      const results = await Promise.all(promises);
      for (const { entry, relUpdate } of results) {
        if (relUpdate && !relUpdate.noUpdate) {
          const updatedText = spliceRelationshipFields(entry.text, relUpdate);
          if (updatedText !== entry.text) {
            updatedState.pendingUpdates.push({
              id: generateId(),
              displayName: entry.displayName,
              keys: entry.keys || [],
              category: 'character',
              originalText: entry.text,
              updatedText,
              isRelationshipUpdate: true,
              createdAt: Date.now(),
            });
            relationshipUpdatesFound++;
            if (onProgress) onProgress({ phase: 'updating-relationships', pendingUpdates: updatedState.pendingUpdates });
          }
        }
      }
    }

    if (relationshipUpdatesFound > 0) {
      console.log(`${LOG_PREFIX} Found ${relationshipUpdatesFound} relationship updates`);
    }
  }

  // Pass 4: Detect unformatted entries (all types with templates)
  let reformatsFound = 0;
  const alreadyPendingNames = new Set([
    ...updatedState.pendingUpdates.map(u => u.displayName.toLowerCase()),
    ...updatedState.pendingMerges.map(m => m.existingDisplayName.toLowerCase()),
    ...(updatedState.dismissedReformatNames || []).map(n => n.toLowerCase()),
  ]);

  // Find entries that have a template for their type but aren't formatted
  const entriesToReformat = existingEntries.filter(e => {
    if (!e.text || e.text.length < 30) return false;
    if (alreadyPendingNames.has((e.displayName || '').toLowerCase())) return false;
    const entryType = getEntryType(e.text, e.displayName);
    if (entryType === 'unknown') {
      // Fallback: character heuristic for entries without metadata
      return looksLikeCharacterEntry(e.text) && !isCharacterEntryFormatted(e.text);
    }
    const tmpl = getTemplateForType(entryType);
    return tmpl && !isEntryFormatted(e.text, entryType);
  });

  console.log(`${LOG_PREFIX} Pass 4: Found ${entriesToReformat.length} unformatted entries out of ${existingEntries.length}`);

  if (entriesToReformat.length > 0) {
    if (onProgress) onProgress({ phase: 'enriching' });

    const formatBudget = Math.min(entriesToReformat.length, MAX_UPDATES_PER_SCAN);
    for (let i = 0; i < formatBudget;) {
      await delay(INTER_CALL_DELAY);
      const formatProviders = hybrid.getProviders();

      const batch = entriesToReformat.slice(i, Math.min(i + formatProviders.length, formatBudget));
      const promises = batch.map((entry, idx) => {
        const entryType = getEntryType(entry.text, entry.displayName);
        const type = (entryType !== 'unknown') ? entryType : 'character';
        return enrichAndReformatEntry(entry.displayName, entry.text, formatProviders[idx], comprehensionContext, storyText, type)
          .then(reformatted => ({ entry, reformatted, type }))
          .catch(err => {
            console.error(`${LOG_PREFIX} Reformat failed for ${entry.displayName}:`, err.message);
            return { entry, reformatted: null, type };
          });
      });
      i += formatProviders.length;

      const results = await Promise.all(promises);
      for (const { entry, reformatted, type } of results) {
        if (reformatted && reformatted !== entry.text) {
          updatedState.pendingUpdates.push({
            id: generateId(),
            displayName: entry.displayName,
            keys: entry.keys || [],
            category: type,
            originalText: entry.text,
            updatedText: reformatted,
            isReformat: true,
            createdAt: Date.now(),
          });
          reformatsFound++;
          if (onProgress) onProgress({ phase: 'enriching', pendingUpdates: updatedState.pendingUpdates });
        }
      }
    }
  }

  // Pass 5: Propagate family names across characters
  let nameProposals = 0;
  const allCharEntries = [
    ...existingEntries.filter(e => e.text && (e.category === 'character' || looksLikeCharacterEntry(e.text))),
    ...(updatedState.pendingEntries || []).filter(e => e.category === 'character'),
  ];

  // Early-exit: skip Pass 5 if all characters already have multi-word names
  const charsNeedingLastName = allCharEntries.filter(e => {
    const name = (extractField(e.text, 'Name') || e.displayName || '').trim();
    return name.split(/\s+/).length < 2;
  });

  if (allCharEntries.length >= 2 && charsNeedingLastName.length > 0) {
    if (onProgress) onProgress({ phase: 'propagating-names' });
    console.log(`${LOG_PREFIX} Pass 5: Propagating family names across ${allCharEntries.length} characters (${charsNeedingLastName.length} need last names)`);

    await delay(INTER_CALL_DELAY);
    const proposals = await propagateFamilyNames(allCharEntries, generateTextFn, comprehensionContext);

    for (const proposal of proposals) {
      // Find matching entry
      const matchEntry = allCharEntries.find(e => {
        const entryName = extractField(e.text, 'Name') || e.displayName;
        return entryName.toLowerCase() === proposal.currentName.toLowerCase()
          || (e.displayName || '').toLowerCase() === proposal.currentName.toLowerCase();
      });

      if (matchEntry) {
        // Create name update
        const updatedText = matchEntry.text.replace(
          /^Name:\s*.*/m,
          `Name: ${proposal.proposedName}`
        );

        updatedState.pendingUpdates.push({
          id: generateId(),
          displayName: matchEntry.displayName,
          keys: matchEntry.keys || [],
          category: 'character',
          originalText: matchEntry.text,
          updatedText,
          isNameUpdate: true,
          proposedDisplayName: proposal.proposedName,
          nameReason: proposal.reason,
          createdAt: Date.now(),
        });
        nameProposals++;
        if (onProgress) onProgress({ phase: 'propagating-names', pendingUpdates: updatedState.pendingUpdates });
      }
    }

    if (nameProposals > 0) {
      console.log(`${LOG_PREFIX} Proposed ${nameProposals} name updates`);
    }
  }

  // Pass 6: Lorebook optimization (if profile configured)
  let optimized = 0;
  if (settings._lorebookProfile && settings._confirmedFields && settings._confirmedFields.length > 0) {
    if (onProgress) onProgress({ phase: 'optimizing' });
    console.log(`${LOG_PREFIX} Pass 6: Optimizing lorebook entries with profile "${settings._lorebookProfile}"`);

    try {
      const lorebookOptimizer = require('./lorebook-optimizer');
      const optResult = await lorebookOptimizer.optimizeLoreEntries(
        existingEntries, settings._lorebookProfile, settings._entityProfiles || {},
        hybrid.getProviders, settings._confirmedFields,
        (p) => { if (onProgress) onProgress({ ...p, phase: 'optimizing' }); }
      );
      optimized = optResult.optimized;
      updatedState._pendingOptimizations = optResult.details;

      if (optimized > 0) {
        console.log(`${LOG_PREFIX} Optimization computed for ${optimized} entries`);
      }
    } catch (e) {
      console.error(`${LOG_PREFIX} Pass 6 optimization failed: ${e.message}`);
    }
  }

  // Reset scan tracking
  updatedState.charsSinceLastScan = 0;

  const summary = { generated, mergesFound, updatesFound, relationshipUpdatesFound, reformatsFound, nameProposals, optimized };
  console.log(`${LOG_PREFIX} Scan complete:`, summary);

  return { state: updatedState, summary };
}

// ============================================================================
// Shared LLM Retry Logic
// ============================================================================

function categorizeError(err) {
  const msg = (err.message || '').toLowerCase();
  const status = err.status || err.statusCode;
  if (status === 429 || msg.includes('429') || msg.includes('rate limit') || msg.includes('too many requests')) {
    return 'rate-limit';
  }
  if (msg.includes('timeout') || msg.includes('timed out') || msg.includes('econnreset') || msg.includes('socket hang up')) {
    return 'timeout';
  }
  return 'other';
}

async function retryLLM(fn, { maxRetries = 1, passName = 'unknown', logPrefix = LOG_PREFIX, onRetry } = {}) {
  let lastError = null;
  for (let attempt = 0; attempt <= maxRetries; attempt++) {
    try {
      const result = await fn();
      if (result !== null && result !== undefined) return result;
      console.log(`${logPrefix} retryLLM(${passName}): null result on attempt ${attempt + 1}`);
      if (onRetry && attempt < maxRetries) onRetry(attempt + 1, 'null-result', `null result on attempt ${attempt + 1}`);
    } catch (err) {
      lastError = err;
      const category = categorizeError(err);
      console.warn(`${logPrefix} retryLLM(${passName}): ${category} on attempt ${attempt + 1}: ${err.message}`);
      if (onRetry) onRetry(attempt + 1, category, err.message, attempt >= maxRetries);
      if (category === 'rate-limit' && attempt < maxRetries) {
        const backoff = INTER_CALL_DELAY * 3 * (attempt + 1);
        console.log(`${logPrefix} retryLLM(${passName}): rate-limit backoff ${backoff}ms`);
        await delay(backoff);
        continue;
      }
    }
    if (attempt < maxRetries) await delay(INTER_CALL_DELAY);
  }
  if (lastError) console.error(`${logPrefix} retryLLM(${passName}): all attempts failed:`, lastError.message);
  return null;
}

// ============================================================================
// EXPORTS
// ============================================================================

module.exports = {
  // LLM functions (take generateTextFn)
  identifyLoreElements,
  generateLoreEntryFromElement,
  detectEntryUpdate,
  identifyTargetEntry,
  generateEnrichedText,
  generateEntriesFromPrompt,
  enrichAndReformatEntry,
  reformatEntryToTemplate, // backward-compatible alias
  updateRelationshipFields,
  confirmAndMergeDuplicates,
  classifyUnknownEntries,

  // Orchestrators
  scanForLore,
  organizeLorebook,

  // Utilities
  recoverJSON,
  generateId,
  partitionElements,
  extractField,
  propagateFamilyNames,
  classifyEntryType,
  findDuplicateCandidates,
  findDuplicateGroups,
  confirmAndMergeDuplicateGroup,
  levenshteinDistance,
  fuzzyNameScore,
  fuzzyFindEntry,
  spliceRelationshipFields,
  looksLikeCharacterEntry,
  isCharacterEntryFormatted,
  isEntryFormatted,

  // Metadata
  parseMetadata,
  setMetadata,
  hasMetadata,
  getEntryType,
  METADATA_VERSION,

  // Templates
  TEMPLATES,
  getTemplateForType,
  LOCATION_TEMPLATE,
  ITEM_TEMPLATE,
  FACTION_TEMPLATE,
  CONCEPT_TEMPLATE,

  // LLM retry
  retryLLM,
  categorizeError,
  createHybridProviders,

  // Constants
  DEFAULT_SETTINGS,
  ALL_CATEGORIES,
  BUILTIN_CATEGORIES,
  MAX_INPUT_TEXT,
  MAX_ELEMENTS_PER_SCAN,
  INTER_CALL_DELAY,
  MAX_UPDATES_PER_SCAN,

  // Category registry
  buildCategoryRegistry,
  getCategoryIds,
};
