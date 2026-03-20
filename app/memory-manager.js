/**
 * Memory Manager — LLM-based story memory extraction, compression,
 * and formatting for the NovelAI Memory field.
 *
 * Ported from auto-memory-manager.ts (standalone Script API plugin) to run
 * in Electron's main process. Every function that needs LLM takes a
 * `generateTextFn(messages, options)` callback (same pattern as lore-creator.js).
 */

const { recoverJSON, delay, generateId: _sharedGenerateId } = require('./shared-utils');

const LOG_PREFIX = '[MemoryManager]';

// ============================================================================
// CONSTANTS
// ============================================================================

const MAX_TEXT_FOR_EXTRACTION = 8000;
const CHUNK_SIZE = 6000;
const CHUNK_OVERLAP = 1000;
const INTER_CHUNK_DELAY = 1000;

const DEFAULT_SETTINGS = {
  tokenLimit: 1000,
  autoUpdate: true,
  trackedKeywords: [],
  compressionThreshold: 0.8,
};

// ============================================================================
// UTILITIES
// ============================================================================

function generateId() {
  return _sharedGenerateId('evt');
}

function estimateTokens(text) {
  return Math.ceil(text.length / 4);
}

function createEmptyState() {
  return {
    events: [],
    characters: {},
    currentSituation: '',
    lastProcessedLength: 0,
  };
}

// recoverJSON imported from shared-utils.js

// ============================================================================
// FORMATTING
// ============================================================================

function formatMemoryContext(state, budget = 1200) {
  if (!state) return '';
  const parts = [];
  if (state.currentSituation) {
    parts.push(`Current: ${state.currentSituation.slice(0, 200)}`);
  }
  if (state.events && state.events.length > 0) {
    const recent = state.events.slice(-5);
    const lines = recent.map(e => `- ${(e.text || e.summary || '').slice(0, 80)}`);
    parts.push(`Recent:\n${lines.join('\n')}`);
  }
  if (state.characters && Object.keys(state.characters).length > 0) {
    const chars = Object.entries(state.characters)
      .slice(0, 8)
      .map(([name, info]) => `${name} (${(info.state || info.goals || '').slice(0, 40)})`)
      .join(', ');
    parts.push(`Characters: ${chars}`);
  }
  if (parts.length === 0) return '';
  return `MEMORY STATE:\n${parts.join('\n')}`.slice(0, budget);
}

function formatMemoryText(events, characters, situation) {
  const sections = [];

  if (events.length > 0) {
    const timelineItems = events.map(e => `• ${e.text}`).join('\n');
    sections.push(`=== STORY TIMELINE ===\n${timelineItems}`);
  }

  if (situation) {
    sections.push(`=== CURRENT SITUATION ===\n${situation}`);
  }

  const charEntries = Object.entries(characters);
  if (charEntries.length > 0) {
    const charLines = charEntries
      .map(([name, data]) => `${name}: ${data.state}`)
      .join('\n');
    sections.push(`=== KEY CHARACTERS ===\n${charLines}`);
  }

  return sections.join('\n\n');
}

// ============================================================================
// LLM FUNCTIONS
// ============================================================================

async function extractEventsFromText(text, keywords, generateTextFn, comprehensionContext) {
  let processText = text;
  if (text.length > MAX_TEXT_FOR_EXTRACTION) {
    processText = text.slice(-MAX_TEXT_FOR_EXTRACTION);
    console.log(`${LOG_PREFIX} Text truncated from ${text.length} to ${processText.length} chars`);
  }

  const keywordContext = keywords.length > 0
    ? `\nPay special attention to these tracked elements: ${keywords.join(', ')}`
    : '';

  const comprehensionBlock = comprehensionContext
    ? `\nSTORY CONTEXT:\n${comprehensionContext}\n`
    : '';

  const messages = [
    {
      role: 'system',
      content: 'You are an expert story analyst. Extract key information from story text and output ONLY valid JSON.',
    },
    {
      role: 'user',
      content: `Analyze this story segment and extract key events worth remembering for story continuity.${keywordContext}
${comprehensionBlock}
STORY TEXT:
${processText}

Extract:
1. Key events (plot developments, character actions, important revelations, location changes)
2. Character states (current status, goals, relationships for any named characters)
3. Current situation (brief context of what's happening now)

Respond with ONLY this JSON format, no other text:
{"events":["event 1","event 2"],"characters":{"Name":"current state"},"situation":"brief current context"}`,
    },
  ];

  try {
    const response = await generateTextFn(messages, {
      max_tokens: 150,
      temperature: 0.3,
    });

    const content = response.output || '';
    const parsed = recoverJSON(content);

    if (parsed) {
      return {
        events: Array.isArray(parsed.events) ? parsed.events : [],
        characters: typeof parsed.characters === 'object' && parsed.characters !== null ? parsed.characters : {},
        situation: typeof parsed.situation === 'string' ? parsed.situation : '',
      };
    }
  } catch (e) {
    console.error(`${LOG_PREFIX} Error extracting events:`, e.message || e);
  }

  return { events: [], characters: {}, situation: '' };
}

async function compressEvents(events, targetTokens, generateTextFn) {
  if (events.length <= 3) return events;

  const recentCount = Math.min(3, Math.floor(events.length * 0.3));
  const recentEvents = events.slice(-recentCount);
  const olderEvents = events.slice(0, -recentCount);

  if (olderEvents.length === 0) return events;

  const olderTexts = olderEvents.map(e => e.text).join('\n• ');

  const messages = [
    {
      role: 'system',
      content: 'You are a concise summarizer. Compress story events into brief bullet points while preserving essential plot information.',
    },
    {
      role: 'user',
      content: `Condense these story events into a brief timeline. Combine similar events and remove redundancy. Keep the most important plot points.

EVENTS:
• ${olderTexts}

Output ${Math.ceil(olderEvents.length / 3)} brief bullet points maximum. Each bullet should be under 20 words.
Format: Just the bullet points, one per line, starting with •`,
    },
  ];

  try {
    const response = await generateTextFn(messages, {
      max_tokens: 150,
      temperature: 0.3,
    });

    const content = response.output || '';
    const compressedBullets = content
      .split('\n')
      .map(line => line.trim())
      .filter(line => line.startsWith('•') || line.startsWith('-'))
      .map(line => line.replace(/^[•\-]\s*/, ''));

    const compressedEvents = compressedBullets.map((text) => ({
      id: generateId(),
      timestamp: olderEvents[0]?.timestamp || Date.now(),
      text,
      importance: 3,
      compressed: true,
    }));

    return [...compressedEvents, ...recentEvents];
  } catch (e) {
    console.error(`${LOG_PREFIX} Error compressing events:`, e.message || e);
  }

  return events;
}

// ============================================================================
// ORCHESTRATORS
// ============================================================================

/**
 * Compile memory: check compression threshold, compress if needed, format.
 * Returns { memoryText, updatedState }.
 */
async function compileMemory(state, settings, generateTextFn) {
  const { events, characters, currentSituation } = state;

  let processedEvents = events;
  const currentText = formatMemoryText(events, characters, currentSituation);
  const currentTokens = estimateTokens(currentText);

  if (currentTokens > settings.tokenLimit * settings.compressionThreshold) {
    console.log(`${LOG_PREFIX} Token usage ${currentTokens}/${settings.tokenLimit} exceeds threshold, compressing...`);
    processedEvents = await compressEvents(events, settings.tokenLimit, generateTextFn);
  }

  const updatedState = {
    ...state,
    events: processedEvents,
  };

  return {
    memoryText: formatMemoryText(processedEvents, characters, currentSituation),
    updatedState,
  };
}

/**
 * Incremental processing: extract from text beyond lastProcessedLength,
 * merge into state, compile.
 * Returns { memoryText, updatedState }.
 */
async function processNewContent(fullStoryText, state, settings, generateTextFn, comprehensionContext) {
  const safeState = state || createEmptyState();

  if (fullStoryText.length <= safeState.lastProcessedLength) {
    const memoryText = formatMemoryText(safeState.events, safeState.characters, safeState.currentSituation);
    return { memoryText, updatedState: safeState };
  }

  const newText = fullStoryText.slice(Math.max(0, safeState.lastProcessedLength - 200));

  if (newText.trim().length < 50) {
    const memoryText = formatMemoryText(safeState.events, safeState.characters, safeState.currentSituation);
    return { memoryText, updatedState: safeState };
  }

  console.log(`${LOG_PREFIX} Processing ${newText.length} chars of new content`);

  const extracted = await extractEventsFromText(
    newText, settings.trackedKeywords || [], generateTextFn, comprehensionContext
  );

  const updatedState = JSON.parse(JSON.stringify(safeState));

  for (const eventText of extracted.events) {
    updatedState.events.push({
      id: generateId(),
      timestamp: Date.now(),
      text: eventText,
      importance: 3,
      compressed: false,
    });
  }

  for (const [name, stateStr] of Object.entries(extracted.characters)) {
    updatedState.characters[name] = {
      name,
      state: stateStr,
      lastUpdated: Date.now(),
    };
  }

  if (extracted.situation) {
    updatedState.currentSituation = extracted.situation;
  }

  updatedState.lastProcessedLength = fullStoryText.length;

  return compileMemory(updatedState, settings, generateTextFn);
}

/**
 * Full re-analysis with chunking.
 * Returns { memoryText, updatedState }.
 */
async function forceRefresh(fullStoryText, settings, generateTextFn, onProgress, comprehensionContext, secondaryGenerateTextFn) {
  if (fullStoryText.trim().length < 50) {
    return {
      memoryText: '',
      updatedState: createEmptyState(),
    };
  }

  const state = createEmptyState();

  // Split into overlapping chunks
  const chunks = [];
  if (fullStoryText.length > CHUNK_SIZE) {
    for (let i = 0; i < fullStoryText.length; i += CHUNK_SIZE - CHUNK_OVERLAP) {
      chunks.push(fullStoryText.slice(i, i + CHUNK_SIZE));
    }
  } else {
    chunks.push(fullStoryText);
  }

  // Hybrid provider with auto-fallback
  let secondaryAlive = !!secondaryGenerateTextFn;
  let failCount = 0;
  const wrappedSecondary = !secondaryGenerateTextFn ? null : async (messages, options) => {
    if (!secondaryAlive) return generateTextFn(messages, options);
    try {
      return await secondaryGenerateTextFn(messages, options);
    } catch (err) {
      failCount++;
      console.error(`${LOG_PREFIX} Secondary provider failed (${failCount}x): ${err.message}`);
      if (failCount >= 2) {
        secondaryAlive = false;
        console.log(`${LOG_PREFIX} Secondary provider disabled — falling back to primary only`);
      }
      return generateTextFn(messages, options);
    }
  };
  const getProviders = () => secondaryAlive ? [generateTextFn, wrappedSecondary] : [generateTextFn];

  console.log(`${LOG_PREFIX} Force refresh: ${chunks.length} chunks from ${fullStoryText.length} chars${secondaryAlive ? ' (hybrid parallel)' : ''}`);

  for (let i = 0; i < chunks.length;) {
    const activeProviders = getProviders();
    if (onProgress) {
      onProgress({
        phase: 'extracting',
        chunk: Math.min(i + activeProviders.length, chunks.length),
        totalChunks: chunks.length,
      });
    }

    if (i > 0) await delay(INTER_CHUNK_DELAY);

    const batch = chunks.slice(i, i + activeProviders.length);
    const promises = batch.map((chunk, idx) =>
      extractEventsFromText(
        chunk, settings.trackedKeywords || [], activeProviders[idx], comprehensionContext
      ).then(extracted => ({ chunkIndex: i + idx, extracted }))
       .catch(e => {
         console.log(`${LOG_PREFIX} Chunk ${i + idx + 1}/${chunks.length} failed: ${e.message || e}`);
         return null;
       })
    );
    i += activeProviders.length;

    const results = await Promise.all(promises);
    for (const result of results) {
      if (!result) continue;
      const { chunkIndex, extracted } = result;

      const maxEventsPerChunk = Math.ceil(10 / chunks.length) + 2;
      for (const eventText of extracted.events.slice(0, maxEventsPerChunk)) {
        state.events.push({
          id: generateId(),
          timestamp: Date.now() - (chunks.length - chunkIndex) * 1000,
          text: eventText,
          importance: 3,
          compressed: false,
        });
      }

      for (const [name, stateStr] of Object.entries(extracted.characters)) {
        state.characters[name] = {
          name,
          state: stateStr,
          lastUpdated: Date.now(),
        };
      }

      if (chunkIndex === chunks.length - 1 && extracted.situation) {
        state.currentSituation = extracted.situation;
      }
    }
  }

  state.lastProcessedLength = fullStoryText.length;

  if (onProgress) {
    onProgress({ phase: 'compiling' });
  }

  return compileMemory(state, settings, generateTextFn);
}

// ============================================================================
// EXPORTS
// ============================================================================

module.exports = {
  // LLM functions
  extractEventsFromText,
  compressEvents,

  // Orchestrators
  compileMemory,
  processNewContent,
  forceRefresh,

  // Formatting
  formatMemoryText,
  formatMemoryContext,

  // Utilities
  recoverJSON,
  generateId,
  estimateTokens,
  createEmptyState,

  // Constants
  DEFAULT_SETTINGS,
  MAX_TEXT_FOR_EXTRACTION,
  CHUNK_SIZE,
  CHUNK_OVERLAP,
};
