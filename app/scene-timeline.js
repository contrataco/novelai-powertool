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
      const result = await callLLM(generateTextFn, messages, { maxTokens: 1000 });
      const parsed = recoverJSON(result.raw);
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

async function groupIntoChapters(scenes, generateTextFn) {
  if (scenes.length < 10) {
    // Single chapter containing all scenes
    const chapter = {
      id: generateId('ch'),
      order: 0,
      title: 'Chapter 1',
      titleSource: 'llm',
      sceneIds: scenes.map(s => s.id),
      summary: '',
      thematicArc: null,
      textStart: scenes.length > 0 ? scenes[0].textStart : 0,
      textEnd: scenes.length > 0 ? scenes[scenes.length - 1].textEnd : 0,
      detectedAt: Date.now(),
    };
    for (const scene of scenes) {
      scene.chapterId = chapter.id;
    }
    return [chapter];
  }

  // Check for explicit chapter-break boundaries — split on those first
  const chapterBreakIndices = scenes
    .map((s, i) => ({ scene: s, i }))
    .filter(({ scene }) => scene.boundaryType === 'chapter-break');

  if (chapterBreakIndices.length > 0) {
    // Build chapters from explicit markers
    const breakPoints = [0, ...chapterBreakIndices.map(({ i }) => i)];
    const chapters = breakPoints.map((startIdx, ci) => {
      const endIdx = ci + 1 < breakPoints.length ? breakPoints[ci + 1] : scenes.length;
      const chapterScenes = scenes.slice(startIdx, endIdx);
      const firstScene = chapterScenes[0];
      const lastScene = chapterScenes[chapterScenes.length - 1];
      // Use the chapter-break boundary's chapterTitle if available
      const explicitTitle = firstScene.boundaryType === 'chapter-break'
        ? (firstScene.boundaryExcerpt || `Chapter ${ci + 1}`)
        : `Chapter ${ci + 1}`;
      const chapter = {
        id: generateId('ch'),
        order: ci,
        title: explicitTitle,
        titleSource: 'explicit',
        sceneIds: chapterScenes.map(s => s.id),
        summary: '',
        thematicArc: null,
        textStart: firstScene.textStart,
        textEnd: lastScene.textEnd,
        detectedAt: Date.now(),
      };
      for (const scene of chapterScenes) {
        scene.chapterId = chapter.id;
      }
      return chapter;
    });
    return chapters;
  }

  // No explicit markers — use LLM to group ungrouped scenes
  const sceneList = scenes
    .map((s, i) => {
      const desc = (s.description || s.excerpt || '').slice(0, 50);
      const loc = s.location || 'unknown';
      const mood = s.mood || '';
      return `${i}: ${desc} [${loc}] (${mood})`;
    })
    .join('\n');

  const messages = [
    {
      role: 'system',
      content: 'Group these scenes into narrative chapters/arcs.',
    },
    {
      role: 'user',
      content: `Scenes:\n${sceneList}\n\nOutput JSON: {"chapters": [{"title": "...", "sceneIndices": [0,1,2], "thematicArc": "discovery|conflict|resolution|transition", "summary": "..."}]}`,
    },
  ];

  let llmChapters = null;
  try {
    const result = await callLLM(generateTextFn, messages, { maxTokens: 800 });
    const parsed = recoverJSON(result.raw);
    llmChapters = parsed?.chapters;
  } catch (_) {
    // Fall through to fallback
  }

  if (!Array.isArray(llmChapters) || llmChapters.length === 0) {
    // Fallback: single chapter
    const chapter = {
      id: generateId('ch'),
      order: 0,
      title: 'Chapter 1',
      titleSource: 'llm',
      sceneIds: scenes.map(s => s.id),
      summary: '',
      thematicArc: null,
      textStart: scenes[0].textStart,
      textEnd: scenes[scenes.length - 1].textEnd,
      detectedAt: Date.now(),
    };
    for (const scene of scenes) {
      scene.chapterId = chapter.id;
    }
    return [chapter];
  }

  const chapters = llmChapters.map((llmCh, ci) => {
    const indices = Array.isArray(llmCh.sceneIndices) ? llmCh.sceneIndices : [];
    const chapterScenes = indices
      .filter(i => i >= 0 && i < scenes.length)
      .map(i => scenes[i]);
    const firstScene = chapterScenes[0] || scenes[0];
    const lastScene = chapterScenes[chapterScenes.length - 1] || scenes[scenes.length - 1];
    const chapter = {
      id: generateId('ch'),
      order: ci,
      title: llmCh.title || `Chapter ${ci + 1}`,
      titleSource: 'llm',
      sceneIds: chapterScenes.map(s => s.id),
      summary: llmCh.summary || '',
      thematicArc: llmCh.thematicArc || null,
      textStart: firstScene.textStart,
      textEnd: lastScene.textEnd,
      detectedAt: Date.now(),
    };
    for (const scene of chapterScenes) {
      scene.chapterId = chapter.id;
    }
    return chapter;
  });

  // Assign any scenes not covered by LLM output to the last chapter
  const assignedIds = new Set(chapters.flatMap(ch => ch.sceneIds));
  const unassigned = scenes.filter(s => !assignedIds.has(s.id));
  if (unassigned.length > 0 && chapters.length > 0) {
    const last = chapters[chapters.length - 1];
    for (const scene of unassigned) {
      scene.chapterId = last.id;
      last.sceneIds.push(scene.id);
      last.textEnd = scene.textEnd;
    }
  }

  return chapters;
}

async function polishCurrentSceneDescription(scene, storyText, generateTextFn) {
  const sceneText = storyText.slice(scene.textStart, scene.textEnd);

  const messages = [
    {
      role: 'system',
      content: 'Rewrite this scene description in present tense, as if it is happening right now. Keep it to 2-3 sentences.',
    },
    {
      role: 'user',
      content: sceneText.slice(0, 2000),
    },
  ];

  try {
    const result = await callLLM(generateTextFn, messages, { maxTokens: 200 });
    const polished = result.raw && result.raw.trim();
    if (polished) {
      scene.description = polished;
      scene.updatedAt = Date.now();
    }
  } catch (_) {
    // Leave existing description unchanged on error
  }

  return scene;
}

async function scanForScenes(storyText, lorebookEntries, generateTextFn, existingState, onProgress) {
  const startedAt = Date.now();
  const state = { ...TIMELINE_STATE_DEFAULTS, ...(existingState || {}) };

  // Preserve user-edited chapter titles
  const userChapters = (state.chapters || []).filter(ch => ch.titleSource === 'user');

  // S1: Heuristic boundary detection
  onProgress?.({ phase: 'heuristic-detection', current: 0, total: 5 });
  const boundaries = detectBoundariesHeuristic(storyText);
  let scenes = segmentIntoScenes(storyText, boundaries);

  // S2: LLM scene analysis
  onProgress?.({ phase: 'scene-analysis', current: 1, total: 5 });
  scenes = await analyzeScenesBatch(scenes, storyText, generateTextFn, onProgress);

  // S3: Character resolution
  onProgress?.({ phase: 'character-resolution', current: 2, total: 5 });
  scenes = resolveSceneCharacters(scenes, lorebookEntries);

  // S4: Chapter grouping
  onProgress?.({ phase: 'chapter-grouping', current: 3, total: 5 });
  const chapters = await groupIntoChapters(scenes, generateTextFn);

  // Restore user-edited chapter titles
  for (const uc of userChapters) {
    const match = chapters.find(ch =>
      ch.sceneIds.some(id => uc.sceneIds && uc.sceneIds.includes(id)) ||
      (ch.textStart <= uc.textEnd && ch.textEnd >= uc.textStart)
    );
    if (match) {
      match.title = uc.title;
      match.titleSource = 'user';
    }
  }

  // S5: Polish current scene description
  onProgress?.({ phase: 'description-polish', current: 4, total: 5 });
  if (scenes.length > 0) {
    const lastScene = scenes[scenes.length - 1];
    await polishCurrentSceneDescription(lastScene, storyText, generateTextFn);
  }

  // Update state
  state.scenes = scenes;
  state.chapters = chapters;
  state.lastProcessedLength = storyText.length;
  state.lastProcessedHash = simpleHash(storyText.slice(-200));

  // Append to scan history (capped)
  const completedAt = Date.now();
  state.scanHistory = [
    { startedAt, completedAt, sceneCount: scenes.length, chapterCount: chapters.length },
    ...(state.scanHistory || []),
  ].slice(0, MAX_SCAN_HISTORY);

  return {
    state,
    report: {
      startedAt,
      completedAt,
      duration: completedAt - startedAt,
      sceneCount: scenes.length,
      chapterCount: chapters.length,
    },
  };
}

async function detectNewScenes(storyText, existingState, generateTextFn) {
  const delta = storyText.length - (existingState.lastProcessedLength || 0);
  if (delta < 500) return null;

  const overlapStart = Math.max(0, existingState.lastProcessedLength - 500);
  const newRegion = storyText.slice(overlapStart);

  const rawBoundaries = detectBoundariesHeuristic(newRegion);
  // Adjust offsets to be relative to the full storyText
  const boundaries = rawBoundaries.map(b => ({
    ...b,
    offset: b.offset + overlapStart,
  }));

  if (boundaries.length === 0) return null;

  // Build new scenes only in the new region
  const newRegionText = storyText;
  let newScenes = segmentIntoScenes(newRegionText, boundaries).filter(
    s => s.textStart >= overlapStart
  );

  if (newScenes.length === 0) return null;

  const highConfidence = boundaries.every(b => b.confidence >= 0.8);

  if (!highConfidence) {
    // Low confidence: run LLM analysis on the new scenes
    try {
      newScenes = await analyzeScenesBatch(newScenes, storyText, generateTextFn, null);
    } catch (_) {
      // Leave as tentative
    }
  } else {
    // High confidence: mark as tentative (no LLM needed)
    newScenes = newScenes.map(s => ({ ...s, status: 'tentative' }));
  }

  const updatedState = {
    ...existingState,
    scenes: [...(existingState.scenes || []), ...newScenes],
    lastProcessedLength: storyText.length,
    lastProcessedHash: simpleHash(storyText.slice(-200)),
  };

  return { state: updatedState, newScenes };
}

module.exports = {
  TIMELINE_STATE_DEFAULTS,
  BOUNDARY_TYPES,
  MAX_SCAN_HISTORY,
  detectBoundariesHeuristic,
  segmentIntoScenes,
  analyzeScenesBatch,
  resolveSceneCharacters,
  groupIntoChapters,
  polishCurrentSceneDescription,
  scanForScenes,
  detectNewScenes,
};
