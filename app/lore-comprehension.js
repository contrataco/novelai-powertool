/**
 * Lore Comprehension — Full-story understanding via hierarchical chunk
 * summaries, entity profile tracking, and master rolling summaries.
 *
 * Processes story text in ~2500-char chunks, summarizing each and extracting
 * entity profiles. Provides a comprehension context string that can be
 * injected into lore scan prompts for full-story awareness.
 *
 * Supports hybrid parallelism (primary + secondary LLM provider) for chunk
 * processing, and category-aware entity extraction using the lorebook's
 * category registry.
 */

const { recoverJSON, delay } = require('./shared-utils');

const LOG_PREFIX = '[LoreComprehension]';

// ============================================================================
// CONSTANTS
// ============================================================================

const CHUNK_SIZE = 2500;
const CHUNK_OVERLAP = 200;
const CONSOLIDATION_INTERVAL = 5;
const MAX_SUMMARY_LENGTH = 800;
const MAX_MASTER_SUMMARY = 2000;
const MAX_ENTITY_PROFILE = 500;
const MAX_ENTITIES_IN_CONTEXT = 30;
const SCHEMA_VERSION = 2;
const INTER_CALL_DELAY = 500;

// ============================================================================
// UTILITIES
// ============================================================================

/**
 * Simple string hash for change detection.
 */
function hashString(str) {
  let hash = 0;
  for (let i = 0; i < str.length; i++) {
    const ch = str.charCodeAt(i);
    hash = ((hash << 5) - hash) + ch;
    hash |= 0;
  }
  return hash.toString(36);
}

// recoverJSON, delay imported from shared-utils.js

// ============================================================================
// CHUNKING
// ============================================================================

/**
 * Split story text into ~CHUNK_SIZE segments at paragraph boundaries.
 * Returns [{index, text, hash}].
 */
function chunkStory(storyText) {
  if (!storyText || storyText.length === 0) return [];

  const chunks = [];
  let pos = 0;
  let index = 0;

  while (pos < storyText.length) {
    let end = Math.min(pos + CHUNK_SIZE, storyText.length);

    // Try to break at paragraph boundary (double newline)
    if (end < storyText.length) {
      const searchStart = Math.max(end - 300, pos);
      const searchRegion = storyText.slice(searchStart, end + 200);
      const targetOffset = end - searchStart;

      // Look for nearest paragraph break to our target end point
      let bestBreak = -1;
      let bestDist = Infinity;

      const breakPattern = /\n\s*\n/g;
      let match;
      while ((match = breakPattern.exec(searchRegion)) !== null) {
        const breakPos = match.index + match[0].length;
        const dist = Math.abs(breakPos - targetOffset);
        if (dist < bestDist) {
          bestDist = dist;
          bestBreak = searchStart + breakPos;
        }
      }

      if (bestBreak > pos && bestBreak <= end + 200) {
        end = bestBreak;
      }
    }

    const text = storyText.slice(pos, end);
    chunks.push({
      index,
      text,
      hash: hashString(text),
    });

    // Advance with overlap
    pos = end - (end < storyText.length ? CHUNK_OVERLAP : 0);
    index++;
  }

  return chunks;
}

// ============================================================================
// HYBRID PROVIDER MANAGEMENT
// ============================================================================

/**
 * Wraps a secondary LLM provider with auto-fallback.
 * Same pattern as lore-creator.js createHybridProviders.
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
      return primaryFn(messages, options);
    }
  };

  return {
    getProviders: () => secondaryAlive ? [primaryFn, wrappedSecondary] : [primaryFn],
    isHybrid: () => secondaryAlive,
  };
}

// ============================================================================
// LLM FUNCTIONS
// ============================================================================

/**
 * Build the category list string for the LLM prompt.
 * Uses actual category registry when available, falls back to builtins.
 */
function buildCategoryList(categories, knownEntries) {
  const catNames = categories && categories.length > 0
    ? categories.map(c => c.singularName || c.id).join(', ').toLowerCase()
    : 'character, location, faction, item, concept';

  const catIds = categories && categories.length > 0
    ? categories.map(c => c.id)
    : ['character', 'location', 'item', 'faction', 'concept'];

  return { catNames, catIds };
}

/**
 * Process a single chunk: summarize and extract entity information.
 * Combined into one LLM call for efficiency.
 *
 * Enhanced: category-aware extraction with richer entity profiles.
 */
async function processChunk(chunkText, previousSummary, entityProfiles, generateTextFn, options = {}) {
  const { categories, knownEntries } = options;
  const { catNames, catIds } = buildCategoryList(categories, knownEntries);

  const entityKeys = Object.keys(entityProfiles);
  const entityContext = entityKeys.length > 0
    ? `\nKNOWN ENTITIES (track updates to these): ${entityKeys.slice(0, 20).join(', ')}`
    : '';

  const previousContext = previousSummary
    ? `\nSTORY SO FAR: ${previousSummary.slice(0, 600)}`
    : '';

  // Build lorebook hints if we have known entries
  let lorebookHint = '';
  if (knownEntries && knownEntries.length > 0) {
    const entryNames = knownEntries.slice(0, 30).map(e =>
      `${e.displayName} (${e.category || 'unknown'})`
    ).join(', ');
    lorebookHint = `\nLOREBOOK ENTRIES (existing tracked entities): ${entryNames}`;
  }

  const validCatsLine = `Valid categories: ${catIds.join(', ')}`;

  const messages = [
    {
      role: 'system',
      content: `You analyze story segments. Summarize the segment AND extract entity information. Categorize entities using ONLY these categories: ${catNames}. Output ONLY valid JSON.`,
    },
    {
      role: 'user',
      content: `Analyze this story segment:
${previousContext}${entityContext}${lorebookHint}

SEGMENT TEXT:
${chunkText}

Provide:
1. A concise summary of events/developments in this segment (2-4 sentences, max ${MAX_SUMMARY_LENGTH} chars)
2. A list of entities (${catNames}) mentioned, with current traits/status
3. For characters: include role (protagonist/antagonist/ally/neutral/minor), party membership if applicable, and any RPG-relevant stats mentioned (class, level, abilities)
4. For all entities: track how they relate to other entities in this segment

${validCatsLine}

Output ONLY this JSON:
{"summary":"Segment summary here.","entities":[{"name":"Entity Name","category":"character","traits":"Brief current traits/description","relationships":"Key relationships to other entities","status":"Current status/state/condition","role":"protagonist/antagonist/ally/neutral/minor (characters only)","partyMember":false,"rpgData":"class/level/abilities if mentioned (characters only)"}]}`,
    },
  ];

  try {
    const response = await generateTextFn(messages, {
      max_tokens: 600,
      temperature: 0.3,
    });

    const content = response.output || '';
    const parsed = recoverJSON(content);

    if (parsed && typeof parsed.summary === 'string') {
      const summary = parsed.summary.slice(0, MAX_SUMMARY_LENGTH);
      const entities = Array.isArray(parsed.entities)
        ? parsed.entities
            .filter(e => typeof e.name === 'string' && e.name.length > 0)
            .map(e => ({
              name: e.name,
              category: catIds.includes(e.category) ? e.category : 'concept',
              traits: typeof e.traits === 'string' ? e.traits : '',
              relationships: typeof e.relationships === 'string' ? e.relationships : '',
              status: typeof e.status === 'string' ? e.status : '',
              role: typeof e.role === 'string' ? e.role : '',
              partyMember: !!e.partyMember,
              rpgData: typeof e.rpgData === 'string' ? e.rpgData : '',
            }))
        : [];
      return { summary, entities };
    }
  } catch (e) {
    console.error(`${LOG_PREFIX} Error processing chunk:`, e.message || e);
  }

  return { summary: '', entities: [] };
}

/**
 * Consolidate chunk summaries using hierarchical approach.
 * Groups summaries in batches, consolidates each batch, then consolidates the results.
 */
async function consolidateSummaries(chunkSummaries, generateTextFn, options = {}) {
  if (chunkSummaries.length === 0) return '';
  if (chunkSummaries.length === 1) return chunkSummaries[0];

  const { hybrid } = options;
  const BATCH_SIZE = 8;

  // If small enough, do single consolidation
  if (chunkSummaries.length <= BATCH_SIZE) {
    return _consolidateBatch(chunkSummaries, generateTextFn);
  }

  // Hierarchical: consolidate in groups, then consolidate the group summaries
  const groupSummaries = [];
  for (let i = 0; i < chunkSummaries.length; i += BATCH_SIZE) {
    const batch = chunkSummaries.slice(i, i + BATCH_SIZE);

    if (hybrid) {
      // Use hybrid providers for parallel batch consolidation
      const providers = hybrid.getProviders();
      if (providers.length > 1 && i + BATCH_SIZE < chunkSummaries.length) {
        const batch2 = chunkSummaries.slice(i + BATCH_SIZE, i + BATCH_SIZE * 2);
        if (batch2.length > 0) {
          const [r1, r2] = await Promise.all([
            _consolidateBatch(batch, providers[0]),
            _consolidateBatch(batch2, providers[1]),
          ]);
          groupSummaries.push(r1, r2);
          i += BATCH_SIZE; // skip extra batch (loop will add another BATCH_SIZE)
          continue;
        }
      }
    }

    const result = await _consolidateBatch(batch, generateTextFn);
    groupSummaries.push(result);
    if (groupSummaries.length > 1) await delay(INTER_CALL_DELAY);
  }

  // If we got multiple group summaries, consolidate them too
  if (groupSummaries.length > 1) {
    return _consolidateBatch(groupSummaries, generateTextFn);
  }
  return groupSummaries[0] || '';
}

/**
 * Consolidate a single batch of summaries into one.
 */
async function _consolidateBatch(summaries, generateTextFn) {
  if (summaries.length === 0) return '';
  if (summaries.length === 1) return summaries[0];

  const combined = summaries
    .map((s, i) => `[Part ${i + 1}] ${s}`)
    .join('\n');

  const messages = [
    {
      role: 'system',
      content: 'You consolidate story summaries into a single cohesive overview. Output ONLY the consolidated summary text, no JSON.',
    },
    {
      role: 'user',
      content: `Combine these story segment summaries into one cohesive summary (max ${MAX_MASTER_SUMMARY} chars). Preserve key plot points, character developments, and important events. Write in present tense.

${combined}

Write ONLY the consolidated summary:`,
    },
  ];

  try {
    const response = await generateTextFn(messages, {
      max_tokens: 500,
      temperature: 0.2,
    });

    const text = (response.output || '').trim();
    if (text.length > 0) return text.slice(0, MAX_MASTER_SUMMARY);
  } catch (e) {
    console.error(`${LOG_PREFIX} Error consolidating summaries:`, e.message || e);
  }

  // Fallback: concatenate and truncate
  return summaries.join(' ').slice(0, MAX_MASTER_SUMMARY);
}

// ============================================================================
// ENTITY PROFILE MANAGEMENT
// ============================================================================

/**
 * Merge extracted entity data into existing profile.
 * Enhanced: preserves structured fields (role, rpgData, partyMember).
 */
function mergeEntityProfile(existing, extracted, chunkIndex) {
  if (!existing) {
    return {
      category: extracted.category || 'concept',
      traits: (extracted.traits || '').slice(0, MAX_ENTITY_PROFILE),
      relationships: (extracted.relationships || '').slice(0, MAX_ENTITY_PROFILE),
      status: (extracted.status || '').slice(0, MAX_ENTITY_PROFILE),
      role: extracted.role || '',
      partyMember: !!extracted.partyMember,
      rpgData: (extracted.rpgData || '').slice(0, MAX_ENTITY_PROFILE),
      lastChunkIndex: chunkIndex,
      firstSeen: chunkIndex,
      mentionCount: 1,
    };
  }

  return {
    category: extracted.category || existing.category,
    traits: extracted.traits
      ? mergeProfileField(existing.traits, extracted.traits)
      : existing.traits,
    relationships: extracted.relationships
      ? mergeProfileField(existing.relationships, extracted.relationships)
      : existing.relationships,
    // Status: newer always wins (it's the current state)
    status: extracted.status || existing.status,
    // Role: update only if newly extracted (don't clear)
    role: extracted.role || existing.role,
    // Party membership: sticky true (once in party, stays unless explicitly removed)
    partyMember: extracted.partyMember || existing.partyMember,
    // RPG data: merge (keep old stats, update with new)
    rpgData: extracted.rpgData
      ? mergeProfileField(existing.rpgData, extracted.rpgData)
      : existing.rpgData || '',
    lastChunkIndex: chunkIndex,
    firstSeen: existing.firstSeen ?? chunkIndex,
    mentionCount: (existing.mentionCount || 1) + 1,
  };
}

/**
 * Merge two profile field strings, preferring newer info but keeping unique older info.
 */
function mergeProfileField(oldVal, newVal) {
  if (!oldVal) return newVal.slice(0, MAX_ENTITY_PROFILE);
  if (!newVal) return oldVal;

  // If new value is substantially different, prefer it but append unique old info
  if (newVal.length > oldVal.length * 0.7) {
    return newVal.slice(0, MAX_ENTITY_PROFILE);
  }

  const combined = `${newVal}; ${oldVal}`;
  return combined.slice(0, MAX_ENTITY_PROFILE);
}

// ============================================================================
// CONTEXT FORMATTING
// ============================================================================

/**
 * Build the comprehension context string for injection into scan prompts.
 * Enhanced: richer entity output with role, RPG data, mention frequency.
 * Caps total output at ~3000 chars.
 */
function formatComprehensionContext(masterSummary, entityProfiles) {
  if (!masterSummary && (!entityProfiles || Object.keys(entityProfiles).length === 0)) {
    return '';
  }

  let context = '';

  if (masterSummary) {
    context += `STORY OVERVIEW (full story summary):\n${masterSummary}\n\n`;
  }

  if (entityProfiles && Object.keys(entityProfiles).length > 0) {
    context += 'KEY ENTITIES:\n';

    // Sort by mention count (descending), then by recency
    const entries = Object.entries(entityProfiles)
      .sort((a, b) => {
        const countDiff = (b[1].mentionCount || 1) - (a[1].mentionCount || 1);
        if (countDiff !== 0) return countDiff;
        return (b[1].lastChunkIndex || 0) - (a[1].lastChunkIndex || 0);
      })
      .slice(0, MAX_ENTITIES_IN_CONTEXT);

    for (const [name, profile] of entries) {
      const parts = [];

      if (profile.traits) parts.push(profile.traits);
      if (profile.role) parts.push(`role: ${profile.role}`);
      if (profile.partyMember) parts.push('party member');
      if (profile.rpgData) parts.push(profile.rpgData);
      if (profile.relationships) parts.push(`relationships: ${profile.relationships}`);
      if (profile.status) parts.push(`status: ${profile.status}`);

      const detail = parts.join('; ').slice(0, 280);
      context += `- ${name} (${profile.category}): ${detail}\n`;
    }
    context += '\n';
  }

  return context.slice(0, 4000);
}

// ============================================================================
// PROGRESSIVE SCAN
// ============================================================================

/**
 * Create a fresh comprehension state object.
 */
function createEmptyState() {
  return {
    chunks: [],
    masterSummary: '',
    entityProfiles: {},
    lastProcessedLength: 0,
    totalStoryLength: 0,
    version: SCHEMA_VERSION,
  };
}

/**
 * Migrate v1 state to v2 (add new entity profile fields).
 */
function migrateState(state) {
  if (!state || state.version === SCHEMA_VERSION) return state;
  if (!state.entityProfiles) return state;

  // Add new fields with defaults to existing profiles
  for (const [, profile] of Object.entries(state.entityProfiles)) {
    if (profile.role === undefined) profile.role = '';
    if (profile.partyMember === undefined) profile.partyMember = false;
    if (profile.rpgData === undefined) profile.rpgData = '';
    if (profile.firstSeen === undefined) profile.firstSeen = profile.lastChunkIndex || 0;
    if (profile.mentionCount === undefined) profile.mentionCount = 1;
  }

  state.version = SCHEMA_VERSION;
  return state;
}

/**
 * Process unprocessed chunks with hybrid parallelism and cancel/pause support.
 *
 * @param {string} storyText - Full story text
 * @param {object|null} existingState - Previous comprehension state (or null)
 * @param {function} generateTextFn - Primary LLM call function
 * @param {function} [onProgress] - Progress callback
 * @param {function} [shouldCancel] - Return true to stop processing
 * @param {object} [options] - { secondaryGenerateTextFn, categories, knownEntries }
 * @returns {object} Updated comprehension state
 */
async function runProgressiveScan(storyText, existingState, generateTextFn, onProgress, shouldCancel, options = {}) {
  const { secondaryGenerateTextFn, categories, knownEntries } = options;

  const state = existingState
    ? migrateState(JSON.parse(JSON.stringify(existingState)))
    : createEmptyState();
  state.totalStoryLength = storyText.length;

  const allChunks = chunkStory(storyText);
  const totalChunks = allChunks.length;

  if (totalChunks === 0) return state;

  // Set up hybrid providers
  const hybrid = createHybridProviders(generateTextFn, secondaryGenerateTextFn);

  // Determine which chunks are already processed (by hash match)
  const processedHashes = new Set(state.chunks.map(c => c.hash));
  const unprocessed = allChunks.filter(c => !processedHashes.has(c.hash));

  console.log(`${LOG_PREFIX} Progressive scan: ${totalChunks} total chunks, ${unprocessed.length} to process${hybrid.isHybrid() ? ' (hybrid parallel)' : ''}`);

  if (unprocessed.length === 0) {
    if (onProgress) onProgress({ phase: 'complete', chunksProcessed: totalChunks, chunksTotal: totalChunks });
    return state;
  }

  let processed = totalChunks - unprocessed.length;
  let chunksThisRound = 0;
  const chunkOptions = { categories, knownEntries };

  for (let i = 0; i < unprocessed.length;) {
    // Check cancellation
    if (shouldCancel && shouldCancel()) {
      console.log(`${LOG_PREFIX} Progressive scan cancelled at chunk ${processed}/${totalChunks}`);
      break;
    }

    if (onProgress) {
      onProgress({
        phase: 'processing',
        chunksProcessed: processed,
        chunksTotal: totalChunks,
      });
    }

    // Get previous context for continuity
    const previousSummary = state.masterSummary || (state.chunks.length > 0
      ? state.chunks[state.chunks.length - 1].summary
      : '');

    // Batch chunks using hybrid providers
    const providers = hybrid.getProviders();
    const batch = unprocessed.slice(i, i + providers.length);
    const promises = batch.map((chunk, idx) =>
      processChunk(chunk.text, previousSummary, state.entityProfiles, providers[idx], chunkOptions)
        .then(result => ({ chunk, result }))
        .catch(err => {
          console.error(`${LOG_PREFIX} Chunk ${chunk.index} failed:`, err.message);
          return { chunk, result: { summary: '', entities: [] } };
        })
    );
    i += providers.length;

    const results = await Promise.all(promises);

    // Process results in order (important for sequential chunk indices)
    for (const { chunk, result } of results) {
      // Store chunk summary
      state.chunks.push({
        index: chunk.index,
        hash: chunk.hash,
        summary: result.summary,
      });

      // Update entity profiles
      for (const entity of result.entities) {
        const key = entity.name;
        state.entityProfiles[key] = mergeEntityProfile(
          state.entityProfiles[key],
          entity,
          chunk.index
        );
      }

      processed++;
      chunksThisRound++;
    }

    // Consolidate summaries periodically (hierarchical)
    if (chunksThisRound % CONSOLIDATION_INTERVAL === 0 || processed === totalChunks) {
      if (onProgress) {
        onProgress({
          phase: 'consolidating',
          chunksProcessed: processed,
          chunksTotal: totalChunks,
        });
      }

      const summaries = state.chunks.map(c => c.summary).filter(s => s.length > 0);
      state.masterSummary = await consolidateSummaries(summaries, generateTextFn, { hybrid });
    }

    // Brief delay between batches to avoid rate limiting
    if (i < unprocessed.length) {
      await delay(INTER_CALL_DELAY);
    }
  }

  state.lastProcessedLength = storyText.length;

  if (onProgress) {
    onProgress({
      phase: 'complete',
      chunksProcessed: processed,
      chunksTotal: totalChunks,
      currentChunkSummary: state.masterSummary,
    });
  }

  console.log(`${LOG_PREFIX} Progressive scan complete: ${processed}/${totalChunks} chunks, ${Object.keys(state.entityProfiles).length} entities`);

  return state;
}

/**
 * Process only new text since lastProcessedLength.
 * Quick path for ongoing story writing (typically 1-2 new chunks).
 * Supports hybrid parallelism for multiple new chunks.
 */
async function incrementalUpdate(storyText, existingState, generateTextFn, options = {}) {
  if (!existingState || !existingState.lastProcessedLength) {
    return runProgressiveScan(storyText, null, generateTextFn, null, null, options);
  }

  const { secondaryGenerateTextFn, categories, knownEntries } = options;

  const state = migrateState(JSON.parse(JSON.stringify(existingState)));
  const oldLength = state.lastProcessedLength;

  if (storyText.length <= oldLength) {
    return state; // No new text
  }

  const newText = storyText.slice(Math.max(0, oldLength - CHUNK_OVERLAP));
  const newChunks = chunkStory(newText);

  if (newChunks.length === 0) return state;

  console.log(`${LOG_PREFIX} Incremental update: ${newChunks.length} new chunks from ${storyText.length - oldLength} new chars`);

  const processedHashes = new Set(state.chunks.map(c => c.hash));
  const toProcess = newChunks.filter(c => !processedHashes.has(c.hash));

  if (toProcess.length === 0) return state;

  // Set up hybrid for incremental too
  const hybrid = createHybridProviders(generateTextFn, secondaryGenerateTextFn);
  const chunkOptions = { categories, knownEntries };

  for (let i = 0; i < toProcess.length;) {
    const previousSummary = state.masterSummary || '';
    const providers = hybrid.getProviders();
    const batch = toProcess.slice(i, i + providers.length);

    const promises = batch.map((chunk, idx) =>
      processChunk(chunk.text, previousSummary, state.entityProfiles, providers[idx], chunkOptions)
        .then(result => ({ chunk, result }))
        .catch(err => {
          console.error(`${LOG_PREFIX} Incremental chunk failed:`, err.message);
          return { chunk, result: { summary: '', entities: [] } };
        })
    );
    i += providers.length;

    const results = await Promise.all(promises);

    for (const { chunk, result } of results) {
      const newIndex = state.chunks.length;
      state.chunks.push({
        index: newIndex,
        hash: chunk.hash,
        summary: result.summary,
      });

      for (const entity of result.entities) {
        state.entityProfiles[entity.name] = mergeEntityProfile(
          state.entityProfiles[entity.name],
          entity,
          newIndex
        );
      }
    }

    if (i < toProcess.length) await delay(INTER_CALL_DELAY);
  }

  // Consolidate after incremental update (hierarchical)
  const summaries = state.chunks.map(c => c.summary).filter(s => s.length > 0);
  state.masterSummary = await consolidateSummaries(summaries, generateTextFn, { hybrid });

  state.lastProcessedLength = storyText.length;
  state.totalStoryLength = storyText.length;

  console.log(`${LOG_PREFIX} Incremental update complete: ${state.chunks.length} total chunks`);

  return state;
}

// ============================================================================
// EXPORTS
// ============================================================================

module.exports = {
  // Chunking
  chunkStory,
  hashString,

  // LLM functions
  processChunk,
  consolidateSummaries,

  // Entity management
  mergeEntityProfile,

  // Context
  formatComprehensionContext,

  // Scan operations
  runProgressiveScan,
  incrementalUpdate,
  createEmptyState,
  migrateState,

  // Hybrid
  createHybridProviders,

  // Constants
  CHUNK_SIZE,
  CHUNK_OVERLAP,
  CONSOLIDATION_INTERVAL,
  MAX_SUMMARY_LENGTH,
  MAX_MASTER_SUMMARY,
  MAX_ENTITY_PROFILE,
  MAX_ENTITIES_IN_CONTEXT,
  SCHEMA_VERSION,
  INTER_CALL_DELAY,
};
