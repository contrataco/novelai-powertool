'use strict';

const { generateId, recoverJSON, fuzzyNameScore, callLLM } = require('./shared-utils');

const EXPLICIT_BREAK_REGEX = /\n\s*(\*\s*\*\s*\*|\*{3,}|-{3,}|={3,})\s*\n/g;
const CHAPTER_HEADER_REGEX = /\n\s*(Chapter\s+\d+|CHAPTER\s+\d+|Part\s+\d+|Act\s+\d+)[^\n]*/gi;
const TIME_SKIP_REGEX = /(?:^|\n\n)\s*((?:The next|That|Three|Two|Several|A few|Many|Some)\s+(?:morning|evening|night|day|days|weeks|months|hours|years)\s+later|(?:Hours|Days|Weeks|Months|Years)\s+(?:later|passed|went by)|When\s+(?:they|she|he|we|I)\s+(?:arrived|returned|woke|came))/gi;

const TIMELINE_STATE_DEFAULTS = {
  version: 1,
  scenes: [],
  chapters: [],
  lastProcessedLength: 0,
  lastProcessedHash: '',
  scanHistory: [],
  settings: {
    autoDetect: true,
    minSceneLength: 500,
    chapterGrouping: true,
  },
};

const BOUNDARY_TYPES = [
  'location-change', 'time-skip', 'pov-shift',
  'dramatic-shift', 'chapter-break', 'explicit-break',
];

const MAX_SCAN_HISTORY = 10;

function simpleHash(str) {
  return str.split('').reduce((h, c) => ((h << 5) - h + c.charCodeAt(0)) | 0, 0).toString(36);
}

function detectBoundariesHeuristic(storyText) {
  const boundaries = [];

  // Explicit break markers (*** / --- / ===)
  let match;
  EXPLICIT_BREAK_REGEX.lastIndex = 0;
  while ((match = EXPLICIT_BREAK_REGEX.exec(storyText)) !== null) {
    boundaries.push({
      offset: match.index,
      type: 'explicit-break',
      confidence: 0.95,
      source: 'heuristic',
    });
  }

  // Chapter / part / act headers
  CHAPTER_HEADER_REGEX.lastIndex = 0;
  while ((match = CHAPTER_HEADER_REGEX.exec(storyText)) !== null) {
    boundaries.push({
      offset: match.index,
      type: 'chapter-break',
      confidence: 0.95,
      source: 'heuristic',
      chapterTitle: match[1].trim(),
    });
  }

  // Time-skip phrases
  TIME_SKIP_REGEX.lastIndex = 0;
  while ((match = TIME_SKIP_REGEX.exec(storyText)) !== null) {
    boundaries.push({
      offset: match.index,
      type: 'time-skip',
      confidence: 0.7,
      source: 'heuristic',
    });
  }

  // Sort by offset
  boundaries.sort((a, b) => a.offset - b.offset);

  // Deduplicate: boundaries within 200 chars of each other → keep highest confidence
  const deduped = [];
  for (const b of boundaries) {
    const prev = deduped[deduped.length - 1];
    if (prev && b.offset - prev.offset < 200) {
      if (b.confidence > prev.confidence) {
        deduped[deduped.length - 1] = b;
      }
      // else discard b
    } else {
      deduped.push(b);
    }
  }

  return deduped;
}

function segmentIntoScenes(storyText, boundaries) {
  const minLength = TIMELINE_STATE_DEFAULTS.settings.minSceneLength;

  // Build segment start/end pairs
  // Each boundary marks the start of a new segment
  const segmentStarts = [0, ...boundaries.map(b => b.offset)];

  const rawSegments = segmentStarts.map((start, i) => {
    const end = i + 1 < segmentStarts.length ? segmentStarts[i + 1] : storyText.length;
    const boundary = i > 0 ? boundaries[i - 1] : null;
    return { start, end, boundary };
  });

  // Merge short segments into the previous one
  const merged = [];
  for (const seg of rawSegments) {
    const length = seg.end - seg.start;
    if (length < minLength && merged.length > 0) {
      // Extend previous segment's end
      merged[merged.length - 1].end = seg.end;
    } else {
      merged.push({ ...seg });
    }
  }

  return merged.map((seg, index) => ({
    id: generateId('scene'),
    order: index,
    chapterId: null,
    textStart: seg.start,
    textEnd: seg.end,
    textHash: simpleHash(storyText.slice(seg.start, seg.start + 100)),
    excerpt: storyText.slice(seg.start, seg.start + 200).trim(),
    boundaryExcerpt: storyText.slice(seg.start, seg.start + 50).trim(),
    description: null,
    location: null,
    timeOfDay: null,
    mood: null,
    tone: null,
    weather: null,
    keyEvents: [],
    characters: [],
    boundaryType: seg.boundary ? seg.boundary.type : 'explicit-break',
    boundaryConfidence: seg.boundary ? seg.boundary.confidence : 0.5,
    status: 'tentative',
    imageId: null,
    promptData: null,
    detectedAt: Date.now(),
    updatedAt: Date.now(),
  }));
}

async function analyzeScenesBatch(provisionalScenes, storyText, generateTextFn, onProgress) {
  const BATCH_SIZE = 4;
  const MAX_BATCH_CHARS = 8000;
  const scenes = provisionalScenes.map(s => ({ ...s }));

  // Group into batches of up to BATCH_SIZE scenes, keeping total text under MAX_BATCH_CHARS
  const batches = [];
  let current = [];
  let currentChars = 0;

  for (const scene of scenes) {
    const segLen = scene.textEnd - scene.textStart;
    if (current.length > 0 && (current.length >= BATCH_SIZE || currentChars + segLen > MAX_BATCH_CHARS)) {
      batches.push(current);
      current = [];
      currentChars = 0;
    }
    current.push(scene);
    currentChars += segLen;
  }
  if (current.length > 0) batches.push(current);

  const totalBatches = batches.length;

  for (let batchIndex = 0; batchIndex < batches.length; batchIndex++) {
    const batch = batches[batchIndex];
    onProgress?.({ phase: 'scene-analysis', current: batchIndex, total: totalBatches });

    const batchStart = batch[0].textStart;
    const batchEnd = batch[batch.length - 1].textEnd;
    const textChunk = storyText.slice(batchStart, batchEnd);

    const candidateList = batch.map((s, i) =>
      `Scene ${i + 1}: offset=${s.textStart}, type=${s.boundaryType}, confidence=${s.boundaryConfidence}`
    ).join('\n');

    const messages = [
      {
        role: 'system',
        content: 'You are a scene boundary analyzer for fiction. Analyze the story segment and identify distinct scenes.',
      },
      {
        role: 'user',
        content: `Story segment (offsets ${batchStart}–${batchEnd}):\n\n${textChunk}\n\nHeuristic candidate boundaries:\n${candidateList}\n\nFor each confirmed scene in this segment, extract:\n- description (2-3 sentences, past tense)\n- location (place name or description)\n- timeOfDay (morning/afternoon/evening/night/unknown)\n- mood (1-2 words)\n- tone (genre/atmosphere descriptor)\n- weather (if mentioned, else null)\n- keyEvents (1-3 short bullet points)\n- characters (array of character names present)\n- boundaryType (location-change|time-skip|pov-shift|dramatic-shift)\n\nOutput JSON: {"scenes": [{ all fields above }]}`,
      },
    ];

    try {
      const result = await callLLM(generateTextFn, messages, { max_tokens: 1000 });
      const parsed = recoverJSON(result.output);
      const llmScenes = parsed?.scenes;

      if (Array.isArray(llmScenes)) {
        for (let i = 0; i < batch.length; i++) {
          const llm = llmScenes[i];
          if (!llm) continue;
          const scene = scenes.find(s => s.id === batch[i].id);
          if (!scene) continue;
          if (llm.description != null) scene.description = llm.description;
          if (llm.location != null) scene.location = llm.location;
          if (llm.timeOfDay != null) scene.timeOfDay = llm.timeOfDay;
          if (llm.mood != null) scene.mood = llm.mood;
          if (llm.tone != null) scene.tone = llm.tone;
          if (llm.weather !== undefined) scene.weather = llm.weather;
          if (Array.isArray(llm.keyEvents)) scene.keyEvents = llm.keyEvents;
          if (Array.isArray(llm.characters)) scene.characters = llm.characters;
          if (llm.boundaryType != null) scene.boundaryType = llm.boundaryType;
          scene.status = 'confirmed';
          scene.updatedAt = Date.now();
        }
      }
    } catch (err) {
      // Leave batch scenes as tentative on error; don't abort entire analysis
    }
  }

  onProgress?.({ phase: 'scene-analysis', current: totalBatches, total: totalBatches });
  return scenes;
}

function resolveSceneCharacters(scenes, lorebookEntries) {
  const THRESHOLD = 0.7;

  // Pre-build alias list from lorebook entries
  const entryProfiles = (lorebookEntries || []).map(entry => {
    const aliases = [];
    // Extract parenthetical aliases like "Name (Alias, Alt)"
    const aliasMatch = entry.text && entry.text.match(/^@?aliases?:\s*(.+)/mi);
    if (aliasMatch) {
      aliasMatch[1].split(',').forEach(a => {
        const trimmed = a.trim();
        if (trimmed) aliases.push(trimmed);
      });
    }
    return { displayName: entry.displayName, aliases };
  });

  function findLoreMatch(name) {
    let bestScore = 0;
    let bestEntry = null;
    for (const ep of entryProfiles) {
      const candidates = [ep.displayName, ...ep.aliases].filter(Boolean);
      for (const candidate of candidates) {
        const score = fuzzyNameScore(name, candidate);
        if (score > bestScore) {
          bestScore = score;
          bestEntry = ep;
        }
      }
    }
    return bestScore >= THRESHOLD ? bestEntry : null;
  }

  // Resolve character strings to objects
  const resolved = scenes.map(scene => {
    const characters = (scene.characters || []).map(c => {
      if (typeof c === 'object' && c !== null) return c; // already resolved
      const name = String(c);
      const match = findLoreMatch(name);
      return {
        name,
        loreEntryName: match ? match.displayName : null,
        entering: false,
        exiting: false,
      };
    });
    return { ...scene, characters };
  });

  // Set entering/exiting flags by comparing consecutive scenes
  for (let i = 1; i < resolved.length; i++) {
    const prev = new Set(resolved[i - 1].characters.map(c => c.loreEntryName || c.name));
    const curr = new Set(resolved[i].characters.map(c => c.loreEntryName || c.name));

    resolved[i].characters = resolved[i].characters.map(c => {
      const key = c.loreEntryName || c.name;
      return { ...c, entering: !prev.has(key) };
    });

    resolved[i - 1].characters = resolved[i - 1].characters.map(c => {
      const key = c.loreEntryName || c.name;
      return { ...c, exiting: !curr.has(key) };
    });
  }

  return resolved;
}

module.exports = {
  TIMELINE_STATE_DEFAULTS,
  BOUNDARY_TYPES,
  MAX_SCAN_HISTORY,
  detectBoundariesHeuristic,
  segmentIntoScenes,
  analyzeScenesBatch,
  resolveSceneCharacters,
};
