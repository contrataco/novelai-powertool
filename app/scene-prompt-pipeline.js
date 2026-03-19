/**
 * Scene Prompt Pipeline v2 — Multi-stage, context-aware prompt generation.
 *
 * Stage 1a: Scene Analysis (mood, lighting, location, action)
 * Stage 1b: Character Visual Extraction (appearance, clothing, equipment, pose)
 * Stage 2:  Deterministic Assembly (no LLM — template merge)
 *
 * Stages 1a and 1b run in parallel on separate LLM providers when available.
 */

const { retryLLM } = require('./lore-creator');
const { recoverJSON, withTimeout, LLM_TIMEOUT_MS } = require('./shared-utils');

const LOG_PREFIX = '[Pipeline]';

// --- Heuristic Fallbacks ---

const TIME_PATTERNS = [
  { pattern: /\b(dawn|sunrise|early morning)\b/i, value: 'dawn' },
  { pattern: /\b(morning|breakfast)\b/i, value: 'morning' },
  { pattern: /\b(noon|midday|lunch)\b/i, value: 'noon' },
  { pattern: /\b(afternoon)\b/i, value: 'afternoon' },
  { pattern: /\b(dusk|sunset|evening|dinner|supper)\b/i, value: 'evening' },
  { pattern: /\b(night|midnight|moon|stars|dark)\b/i, value: 'night' },
];

const WEATHER_PATTERNS = [
  { pattern: /\b(rain|raining|downpour|drizzle)\b/i, value: 'rain' },
  { pattern: /\b(snow|snowing|blizzard|frost)\b/i, value: 'snow' },
  { pattern: /\b(storm|thunder|lightning)\b/i, value: 'storm' },
  { pattern: /\b(fog|mist|haze)\b/i, value: 'fog' },
  { pattern: /\b(wind|windy|gust)\b/i, value: 'windy' },
  { pattern: /\b(clear|sunny|bright)\b/i, value: 'clear' },
];

const LOCATION_PATTERNS = [
  { pattern: /\b(forest|woods|grove|clearing)\b/i, value: 'forest' },
  { pattern: /\b(cave|cavern|underground|tunnel)\b/i, value: 'cave' },
  { pattern: /\b(castle|palace|throne room|keep)\b/i, value: 'castle' },
  { pattern: /\b(tavern|inn|pub|bar)\b/i, value: 'tavern' },
  { pattern: /\b(city|town|village|market|square)\b/i, value: 'town' },
  { pattern: /\b(battlefield|arena|colosseum)\b/i, value: 'battlefield' },
  { pattern: /\b(ocean|sea|ship|boat|deck)\b/i, value: 'ocean' },
  { pattern: /\b(mountain|cliff|peak|summit)\b/i, value: 'mountain' },
  { pattern: /\b(desert|sand|dune)\b/i, value: 'desert' },
  { pattern: /\b(library|study|archive)\b/i, value: 'library' },
  { pattern: /\b(dungeon|cell|prison)\b/i, value: 'dungeon' },
];

function heuristicSceneAnalysis(text) {
  const result = { mood: '', timeOfDay: '', lighting: '', weather: '', location: '', actionInProgress: '', emotionalTone: '', cameraAngle: '' };
  const lowerText = text.toLowerCase();

  for (const { pattern, value } of TIME_PATTERNS) {
    if (pattern.test(lowerText)) { result.timeOfDay = value; break; }
  }
  for (const { pattern, value } of WEATHER_PATTERNS) {
    if (pattern.test(lowerText)) { result.weather = value; break; }
  }
  for (const { pattern, value } of LOCATION_PATTERNS) {
    if (pattern.test(lowerText)) { result.location = value; break; }
  }

  // Infer lighting from time of day
  if (result.timeOfDay === 'night' || result.timeOfDay === 'midnight') {
    result.lighting = 'moonlight, dark';
  } else if (result.timeOfDay === 'dawn' || result.timeOfDay === 'evening') {
    result.lighting = 'golden hour, warm light';
  } else if (result.location === 'cave' || result.location === 'dungeon') {
    result.lighting = 'dim, torchlight';
  }

  return result;
}

// Regex-based character extraction (v1 fallback)
function regexCharacterExtraction(entries, storyText) {
  const appearancePatterns = [
    /appearance[:\s]+([^.]+(?:\.[^.]+){0,3})/i,
    /physical(?:\s+description)?[:\s]+([^.]+(?:\.[^.]+){0,3})/i,
    /looks?\s+like[:\s]+([^.]+(?:\.[^.]+){0,2})/i,
    /(?:has|with)\s+([\w\s,]+(?:hair|eyes|skin|build|height)[^.]*)/i,
    /description[:\s]+([^.]+(?:\.[^.]+){0,3})/i,
  ];
  const visualKeywords = ['hair', 'eyes', 'tall', 'short', 'wears', 'wearing', 'dressed', 'skin', 'face', 'build'];
  const characters = [];

  for (const entry of (entries || [])) {
    if (entry.enabled === false) continue;
    const text = entry.text || '';
    const displayName = entry.displayName || '';
    const keys = entry.keys || [];
    let appearance = '';

    for (const pattern of appearancePatterns) {
      const match = text.match(pattern);
      if (match && match[1]) {
        appearance = match[1].trim();
        break;
      }
    }

    if (!appearance && text.length < 500) {
      const hasVisual = visualKeywords.some(kw => text.toLowerCase().includes(kw));
      if (hasVisual) appearance = text;
    }

    if (appearance) {
      const name = displayName || (keys.length > 0 ? keys[0] : '');
      if (name) characters.push({ name, appearance: appearance.slice(0, 300) });
    }
  }

  // Filter to characters in recent text
  const recentText = storyText.slice(-3000).toLowerCase();
  return characters.filter(c => recentText.includes(c.name.toLowerCase()));
}

// --- Stage 1a: Scene Analysis ---

async function runSceneAnalysis(generateTextFn, storyText, narrativeContext) {
  const systemPrompt = `You are a scene analysis engine. Extract the visual setting from the story text.

Output ONLY a JSON object:
{"mood": "", "timeOfDay": "", "lighting": "", "weather": "", "location": "", "actionInProgress": "", "emotionalTone": "", "cameraAngle": ""}

Rules:
- mood: overall atmosphere (e.g. "tense", "peaceful", "ominous")
- timeOfDay: dawn/morning/noon/afternoon/evening/night or empty
- lighting: describe light sources and quality
- weather: current weather or empty
- location: specific place description
- actionInProgress: what is happening RIGHT NOW
- emotionalTone: the emotional state of the scene
- cameraAngle: suggested framing (e.g. "close-up", "wide shot", "low angle")
- Extract only what the text explicitly states or strongly implies
- Leave fields empty if not determinable
- Use danbooru/booru-style tags, not natural language (e.g. "night sky, moonlight, outdoors" not "The scene takes place under the night sky with soft moonlight")
- Keep each field to 2-5 comma-separated tags`;

  let userContent = `Analyze this scene:\n\n${storyText.slice(-3000)}`;
  if (narrativeContext) {
    userContent += `\n\nContext:\n${narrativeContext}`;
  }

  const messages = [
    { role: 'system', content: systemPrompt },
    { role: 'user', content: userContent },
  ];

  const result = await retryLLM(async () => {
    const response = await generateTextFn(messages, { max_tokens: 250, temperature: 0.3 });
    const parsed = recoverJSON(response.output);
    if (!parsed) return null;
    return parsed;
  }, { passName: 'scene-analysis', logPrefix: LOG_PREFIX });

  return result;
}

// --- Stage 1b: Character Visual Extraction ---

async function runCharacterExtraction(generateTextFn, storyText, entries, rpgData, visualProfiles) {
  // Build character context from lorebook + RPG data + stored profiles
  const characterContext = [];

  for (const entry of (entries || [])) {
    if (entry.enabled === false) continue;
    const name = entry.displayName || (entry.keys?.length > 0 ? entry.keys[0] : '');
    if (!name) continue;

    // Check if character appears in recent text
    const recentText = storyText.slice(-3000).toLowerCase();
    if (!recentText.includes(name.toLowerCase())) continue;

    const ctx = { name, entryText: (entry.text || '').slice(0, 500) };

    // Add RPG data if available
    if (rpgData?.characters) {
      const rpgChar = Object.values(rpgData.characters).find(c =>
        c.name?.toLowerCase() === name.toLowerCase() ||
        c.aliases?.some(a => a.toLowerCase() === name.toLowerCase())
      );
      if (rpgChar) {
        ctx.rpg = {
          class: rpgChar.class,
          level: rpgChar.level,
          equipment: rpgChar.equipment?.map(e => `${e.name}${e.rarity ? ` (${e.rarity})` : ''}`),
          statusEffects: rpgChar.statusEffects,
        };
      }
    }

    // Add stored visual profile as baseline
    if (visualProfiles?.[name]) {
      ctx.storedProfile = visualProfiles[name];
    }

    characterContext.push(ctx);
  }

  if (characterContext.length === 0) return null;

  const systemPrompt = `You are a character visual extraction engine. Extract the current visual state of each character in the scene.

Output ONLY a JSON object:
{"characters": [{"name": "", "appearance": "", "clothing": "", "equipment": "", "pose": "", "expression": "", "injuries": ""}]}

Rules:
- appearance: physical traits (hair, eyes, build, race, distinguishing features)
- clothing: what they are currently wearing
- equipment: visible weapons, armor, items
- pose: body position / action
- expression: facial expression / emotional state
- injuries: visible wounds or effects
- Only include characters present in the current scene
- For characters with a stored profile, only note DEVIATIONS from baseline
- Use the RPG data for accurate equipment/class descriptions
- Leave fields empty if not mentioned
- Use danbooru/booru-style tags for all visual descriptions (e.g. "long blonde hair, blue eyes, pointy ears" not "She has long blonde hair and blue eyes with pointed ears")
- Describe clothing with tags (e.g. "white dress, armor, gauntlets" not "wearing a white dress with armor and gauntlets")
- Keep each field to 2-6 comma-separated tags`;

  let userContent = `Extract character visuals from this scene:\n\n${storyText.slice(-3000)}`;
  userContent += '\n\nCharacter Data:\n';
  for (const ctx of characterContext) {
    userContent += `\n[${ctx.name}]`;
    if (ctx.entryText) userContent += `\nLorebook: ${ctx.entryText.slice(0, 300)}`;
    if (ctx.rpg) {
      userContent += `\nRPG: ${ctx.rpg.class || ''} Lv.${ctx.rpg.level || '?'}`;
      if (ctx.rpg.equipment?.length) userContent += `, Equipment: ${ctx.rpg.equipment.join(', ')}`;
      if (ctx.rpg.statusEffects?.length) userContent += `, Status: ${ctx.rpg.statusEffects.map(e => e.name || e).join(', ')}`;
    }
    if (ctx.storedProfile) {
      const p = ctx.storedProfile;
      const profileSummary = [p.hair, p.eyes, p.build, p.race, p.distinguishingFeatures].filter(Boolean).join(', ');
      if (profileSummary) userContent += `\nBaseline: ${profileSummary}`;
    }
  }

  const messages = [
    { role: 'system', content: systemPrompt },
    { role: 'user', content: userContent },
  ];

  const result = await retryLLM(async () => {
    const response = await generateTextFn(messages, { max_tokens: 400, temperature: 0.3 });
    const parsed = recoverJSON(response.output);
    if (!parsed?.characters || !Array.isArray(parsed.characters)) return null;
    return parsed;
  }, { passName: 'char-extraction', logPrefix: LOG_PREFIX });

  return result;
}

// --- Stage 2: Deterministic Assembly ---

function assemblePrompt(sceneAnalysis, characterData, visualProfiles) {
  const sceneParts = [];
  const charCaptions = [];

  // --- Character count tag ---
  const chars = characterData?.characters || [];
  if (chars.length > 0) {
    const genderCounts = { girl: 0, boy: 0, other: 0 };
    for (const char of chars) {
      const app = (char.appearance || '').toLowerCase();
      const stored = visualProfiles?.[char.name] || {};
      const storedStr = [stored.hair, stored.eyes, stored.build, stored.race].filter(Boolean).join(' ').toLowerCase();
      const combined = app + ' ' + storedStr;
      if (/\b(female|woman|girl|she|her)\b/.test(combined)) genderCounts.girl++;
      else if (/\b(male|man|boy|he|his)\b/.test(combined)) genderCounts.boy++;
      else genderCounts.other++;
    }
    const countTags = [];
    const numWord = (n) => n === 1 ? '1' : n === 2 ? '2' : n === 3 ? '3' : `${n}`;
    if (genderCounts.girl > 0) countTags.push(genderCounts.girl === 1 ? '1girl' : `${numWord(genderCounts.girl)}girls`);
    if (genderCounts.boy > 0) countTags.push(genderCounts.boy === 1 ? '1boy' : `${numWord(genderCounts.boy)}boys`);
    if (genderCounts.other > 0) countTags.push(genderCounts.other === 1 ? '1other' : `${numWord(genderCounts.other)}others`);
    if (chars.length > 2) countTags.push('multiple characters');
    sceneParts.push(...countTags);
  }

  // --- Per-character captions (for V4 char_captions) ---
  for (let i = 0; i < chars.length; i++) {
    const char = chars[i];
    const charTags = [];
    const stored = visualProfiles?.[char.name] || {};

    // Appearance tags
    const appearance = char.appearance || [stored.hair, stored.eyes, stored.build, stored.race, stored.distinguishingFeatures].filter(Boolean).join(', ');
    if (appearance) charTags.push(appearance);

    // Clothing
    const clothing = char.clothing || stored.currentClothing || '';
    if (clothing) charTags.push(clothing);

    // Equipment
    const equipment = char.equipment || (stored.currentEquipment || []).join(', ');
    if (equipment) charTags.push(equipment);

    // Expression & pose
    if (char.expression) charTags.push(char.expression);
    if (char.pose) charTags.push(char.pose);
    if (char.injuries) charTags.push(char.injuries);

    if (charTags.length > 0) {
      // Compute default center position
      let cx = 0.5;
      if (chars.length === 2) cx = i === 0 ? 0.3 : 0.7;
      else if (chars.length >= 3) cx = (i + 1) / (chars.length + 1);

      charCaptions.push({
        char_caption: charTags.join(', '),
        centers: [{ x: Math.round(cx * 100) / 100, y: 0.5 }],
        _name: char.name, // internal — used for character matching, stripped before API call
      });
    }
  }

  // --- Scene / environment tags ---
  if (sceneAnalysis?.actionInProgress) sceneParts.push(sceneAnalysis.actionInProgress);
  if (sceneAnalysis?.location) sceneParts.push(sceneAnalysis.location);

  const atmosphere = [
    sceneAnalysis?.mood,
    sceneAnalysis?.lighting,
    sceneAnalysis?.weather,
    sceneAnalysis?.timeOfDay,
    sceneAnalysis?.emotionalTone,
  ].filter(Boolean);
  if (atmosphere.length > 0) sceneParts.push(atmosphere.join(', '));
  if (sceneAnalysis?.cameraAngle) sceneParts.push(sceneAnalysis.cameraAngle);

  // --- Build flat prompt (backwards compat / display) ---
  // Flat format: scene tags, then each character's tags separated by pipes for readability
  const baseCaption = sceneParts.join(', ');
  const allCharTags = charCaptions.map(c => c.char_caption);
  const flatParts = [baseCaption, ...allCharTags].filter(Boolean);
  const prompt = flatParts.join(', ');

  return { prompt, baseCaption, charCaptions };
}

// --- Visual Profile Update ---

function updateVisualProfiles(characterData, existingProfiles) {
  if (!characterData?.characters) return {};

  const updated = { ...existingProfiles };

  for (const char of characterData.characters) {
    const existing = updated[char.name] || {};
    const profile = { ...existing };

    // Update fields from extraction — only override if non-empty
    if (char.appearance) {
      // Parse structured appearance fields
      const lower = char.appearance.toLowerCase();
      if (lower.includes('hair')) profile.hair = char.appearance;
      if (lower.includes('eyes') || lower.includes('eye')) profile.eyes = char.appearance;
      // For unstructured text, store as general appearance
      if (!profile.hair && !profile.eyes) {
        profile.hair = char.appearance;
      }
    }
    if (char.clothing) profile.currentClothing = char.clothing;
    if (char.equipment) {
      profile.currentEquipment = typeof char.equipment === 'string'
        ? char.equipment.split(',').map(s => s.trim()).filter(Boolean)
        : char.equipment;
    }
    if (char.injuries) {
      profile.currentInjuries = typeof char.injuries === 'string'
        ? char.injuries.split(',').map(s => s.trim()).filter(Boolean)
        : char.injuries;
    }

    profile.confidence = Math.min(1.0, (existing.confidence || 0.5) + 0.1);
    updated[char.name] = profile;
  }

  return updated;
}

// --- Main Pipeline ---

/**
 * Generate a scene prompt using the v2 multi-stage pipeline.
 *
 * @param {Object} params
 * @param {string} params.storyText - Full story text
 * @param {Array} params.entries - Lorebook entries
 * @param {string} params.storyId - Current story ID
 * @param {Function} params.primaryGenerateTextFn - Primary LLM provider
 * @param {Function|null} params.secondaryGenerateTextFn - Secondary LLM provider (for parallel)
 * @param {string} params.narrativeContext - Comprehension + memory context
 * @param {Object|null} params.rpgData - LitRPG character data
 * @param {Object} params.visualProfiles - Stored visual profiles from DB
 * @param {boolean} params.forceSequential - Force sequential even with 2 providers
 * @returns {Promise<{success: boolean, prompt?: string, negativePrompt?: string, updatedProfiles?: Object, error?: string}>}
 */
async function generateScenePromptV2({
  storyText, entries, storyId,
  primaryGenerateTextFn, secondaryGenerateTextFn,
  narrativeContext, rpgData, visualProfiles,
  forceSequential = false,
}) {
  console.log(`${LOG_PREFIX} Starting v2 pipeline (parallel=${!!secondaryGenerateTextFn && !forceSequential})`);

  let sceneAnalysis = null;
  let characterData = null;

  try {
    // Stage 1: Parallel or sequential LLM calls
    const sceneGenFn = secondaryGenerateTextFn && !forceSequential
      ? secondaryGenerateTextFn
      : primaryGenerateTextFn;

    if (secondaryGenerateTextFn && !forceSequential) {
      // Parallel execution
      console.log(`${LOG_PREFIX} Running Stage 1a + 1b in parallel`);
      const [sceneResult, charResult] = await Promise.all([
        runSceneAnalysis(sceneGenFn, storyText, narrativeContext)
          .catch(err => { console.warn(`${LOG_PREFIX} Stage 1a failed:`, err.message); return null; }),
        runCharacterExtraction(primaryGenerateTextFn, storyText, entries, rpgData, visualProfiles)
          .catch(err => { console.warn(`${LOG_PREFIX} Stage 1b failed:`, err.message); return null; }),
      ]);
      sceneAnalysis = sceneResult;
      characterData = charResult;
    } else {
      // Sequential execution
      console.log(`${LOG_PREFIX} Running Stage 1a + 1b sequentially`);
      sceneAnalysis = await runSceneAnalysis(primaryGenerateTextFn, storyText, narrativeContext)
        .catch(err => { console.warn(`${LOG_PREFIX} Stage 1a failed:`, err.message); return null; });
      characterData = await runCharacterExtraction(primaryGenerateTextFn, storyText, entries, rpgData, visualProfiles)
        .catch(err => { console.warn(`${LOG_PREFIX} Stage 1b failed:`, err.message); return null; });
    }

    // Fallbacks
    if (!sceneAnalysis) {
      console.log(`${LOG_PREFIX} Using heuristic fallback for scene analysis`);
      sceneAnalysis = heuristicSceneAnalysis(storyText.slice(-3000));
    }

    if (!characterData) {
      console.log(`${LOG_PREFIX} Using regex fallback for character extraction`);
      const regexChars = regexCharacterExtraction(entries, storyText);
      if (regexChars.length > 0) {
        characterData = {
          characters: regexChars.map(c => ({
            name: c.name,
            appearance: c.appearance,
            clothing: '', equipment: '', pose: '', expression: '', injuries: '',
          })),
        };
      }
    }

    // Stage 2: Deterministic assembly
    const assembled = assemblePrompt(sceneAnalysis, characterData, visualProfiles);
    const prompt = assembled.prompt;

    if (!assembled.prompt || assembled.prompt.length < 10) {
      console.warn(`${LOG_PREFIX} Assembly produced insufficient prompt, falling back`);
      return { success: false, error: 'Pipeline produced empty prompt' };
    }

    // Update visual profiles
    const updatedProfiles = updateVisualProfiles(characterData, visualProfiles);

    const negativePrompt = '';

    console.log(`${LOG_PREFIX} v2 prompt generated (${prompt.length} chars, ${characterData?.characters?.length || 0} characters)`);

    return {
      success: true,
      prompt,
      negativePrompt,
      updatedProfiles,
      baseCaption: assembled.baseCaption,
      charCaptions: assembled.charCaptions,
    };
  } catch (err) {
    console.error(`${LOG_PREFIX} Pipeline failed:`, err.message);
    return { success: false, error: err.message };
  }
}

module.exports = {
  generateScenePromptV2,
  runSceneAnalysis,
  runCharacterExtraction,
  assemblePrompt,
  updateVisualProfiles,
  heuristicSceneAnalysis,
  regexCharacterExtraction,
};
