// lorebook-optimizer.js — Profile-based lorebook optimization system
// Auto-configures advanced NovelAI lorebook settings (searchRange, forceActivation,
// budgetPriority, prefixes, biases) based on story genre profiles and entity analysis.

const LOG_PREFIX = '[LoreOpt]';

const { parseMetadata, setMetadata, getEntryType, fuzzyNameScore, retryLLM, recoverJSON } = require('./lore-creator');
const { PARTY_SIDE_ROLES } = require('./litrpg-tracker');

// ============================================================================
// STORY PROFILES
// ============================================================================

const PROFILES = {
  general: {
    name: 'General',
    description: 'Conservative defaults — balanced for any genre',
    categoryDefaults: {
      character:  { searchRange: 1000, budgetPriority: 400, contextSize: 2048 },
      location:   { searchRange: 2000, budgetPriority: 400, contextSize: 1024 },
      item:       { searchRange: 1000, budgetPriority: 500, contextSize: 512 },
      faction:    { searchRange: 2000, budgetPriority: 500, contextSize: 1024 },
      concept:    { searchRange: 3000, budgetPriority: 600, contextSize: 512 },
    },
    rules: {
      forceActivateProtagonist: true,
      forceActivateParty: false,
      forceActivateLocation: false,
      prefixInstructions: false,
      biasCharacterSpeech: false,
      biasItemNames: false,
      widenFrequentEntities: true,
      narrowDormantEntities: true,
    },
  },
  litrpg: {
    name: 'LitRPG / GameLit',
    description: 'Party members force-activated, item name biases, wide quest search',
    categoryDefaults: {
      character:  { searchRange: 1200, budgetPriority: 350, contextSize: 2048 },
      location:   { searchRange: 2000, budgetPriority: 400, contextSize: 1024 },
      item:       { searchRange: 1500, budgetPriority: 450, contextSize: 512 },
      faction:    { searchRange: 2000, budgetPriority: 500, contextSize: 1024 },
      concept:    { searchRange: 3000, budgetPriority: 300, contextSize: 1024 },
    },
    rules: {
      forceActivateProtagonist: true,
      forceActivateParty: true,
      forceActivateLocation: true,
      prefixInstructions: true,
      biasCharacterSpeech: false,
      biasItemNames: true,
      widenFrequentEntities: true,
      narrowDormantEntities: true,
    },
  },
  romance: {
    name: 'Romance',
    description: 'Character speech biases, relationship entries high priority',
    categoryDefaults: {
      character:  { searchRange: 1200, budgetPriority: 300, contextSize: 2048 },
      location:   { searchRange: 1500, budgetPriority: 500, contextSize: 768 },
      item:       { searchRange: 800,  budgetPriority: 600, contextSize: 512 },
      faction:    { searchRange: 2000, budgetPriority: 500, contextSize: 768 },
      concept:    { searchRange: 2000, budgetPriority: 600, contextSize: 512 },
    },
    rules: {
      forceActivateProtagonist: true,
      forceActivateParty: false,
      forceActivateLocation: false,
      prefixInstructions: true,
      biasCharacterSpeech: true,
      biasItemNames: false,
      widenFrequentEntities: true,
      narrowDormantEntities: true,
    },
  },
  mystery: {
    name: 'Mystery / Thriller',
    description: 'Clue entries narrow searchRange, suspect biases suppressed',
    categoryDefaults: {
      character:  { searchRange: 800,  budgetPriority: 400, contextSize: 2048 },
      location:   { searchRange: 1500, budgetPriority: 400, contextSize: 1024 },
      item:       { searchRange: 600,  budgetPriority: 500, contextSize: 512 },
      faction:    { searchRange: 1500, budgetPriority: 500, contextSize: 768 },
      concept:    { searchRange: 1000, budgetPriority: 500, contextSize: 512 },
    },
    rules: {
      forceActivateProtagonist: true,
      forceActivateParty: false,
      forceActivateLocation: false,
      prefixInstructions: false,
      biasCharacterSpeech: false,
      biasItemNames: false,
      widenFrequentEntities: false,
      narrowDormantEntities: true,
    },
  },
  'epic-fantasy': {
    name: 'Epic Fantasy',
    description: 'Location/faction force-activated, magic system consistency prefixes',
    categoryDefaults: {
      character:  { searchRange: 1200, budgetPriority: 350, contextSize: 2048 },
      location:   { searchRange: 2500, budgetPriority: 350, contextSize: 1024 },
      item:       { searchRange: 1500, budgetPriority: 450, contextSize: 768 },
      faction:    { searchRange: 2500, budgetPriority: 350, contextSize: 1024 },
      concept:    { searchRange: 3000, budgetPriority: 300, contextSize: 1024 },
    },
    rules: {
      forceActivateProtagonist: true,
      forceActivateParty: true,
      forceActivateLocation: true,
      prefixInstructions: true,
      biasCharacterSpeech: false,
      biasItemNames: false,
      widenFrequentEntities: true,
      narrowDormantEntities: true,
    },
  },
  scifi: {
    name: 'Science Fiction',
    description: 'Technology consistency prefixes, ship/station always activated',
    categoryDefaults: {
      character:  { searchRange: 1000, budgetPriority: 400, contextSize: 2048 },
      location:   { searchRange: 2000, budgetPriority: 350, contextSize: 1024 },
      item:       { searchRange: 1500, budgetPriority: 400, contextSize: 768 },
      faction:    { searchRange: 2000, budgetPriority: 400, contextSize: 1024 },
      concept:    { searchRange: 3000, budgetPriority: 300, contextSize: 1024 },
    },
    rules: {
      forceActivateProtagonist: true,
      forceActivateParty: false,
      forceActivateLocation: true,
      prefixInstructions: true,
      biasCharacterSpeech: false,
      biasItemNames: false,
      widenFrequentEntities: true,
      narrowDormantEntities: true,
    },
  },
  'slice-of-life': {
    name: 'Slice of Life',
    description: 'Minimal everything — light touch, small token budgets',
    categoryDefaults: {
      character:  { searchRange: 800,  budgetPriority: 500, contextSize: 1024 },
      location:   { searchRange: 1000, budgetPriority: 600, contextSize: 512 },
      item:       { searchRange: 600,  budgetPriority: 700, contextSize: 256 },
      faction:    { searchRange: 1000, budgetPriority: 600, contextSize: 512 },
      concept:    { searchRange: 1000, budgetPriority: 700, contextSize: 256 },
    },
    rules: {
      forceActivateProtagonist: true,
      forceActivateParty: false,
      forceActivateLocation: false,
      prefixInstructions: false,
      biasCharacterSpeech: true,
      biasItemNames: false,
      widenFrequentEntities: false,
      narrowDormantEntities: false,
    },
  },
};

function getProfile(profileId) {
  return PROFILES[profileId] || PROFILES.general;
}

// ============================================================================
// ENTITY MATCHING — link lorebook entries to comprehension profiles
// ============================================================================

function matchEntityProfile(entry, entityProfiles) {
  if (!entityProfiles || typeof entityProfiles !== 'object') return null;
  const name = entry.displayName || '';
  let bestMatch = null;
  let bestScore = 0;
  for (const [entityName, profile] of Object.entries(entityProfiles)) {
    const score = fuzzyNameScore(name, entityName);
    if (score > bestScore && score >= 0.7) {
      bestScore = score;
      bestMatch = profile;
    }
  }
  return bestMatch;
}

// ============================================================================
// RULE ENGINE — compute optimized fields for each entry
// ============================================================================

function computeActivation(entry, metadata, profile, entityProfile) {
  const entryType = getEntryType(entry.text, entry.displayName);
  const defaults = profile.categoryDefaults[entryType] || profile.categoryDefaults.character;
  const rules = profile.rules;

  let searchRange = defaults.searchRange;
  let forceActivation = false;
  let keyRelative = false;
  let nonStoryActivatable = false;

  // Protagonist: always force-activate
  if (rules.forceActivateProtagonist && metadata.protagonist) {
    forceActivation = true;
  }

  // Party members
  if (rules.forceActivateParty && metadata.role && PARTY_SIDE_ROLES.has(metadata.role)) {
    forceActivation = true;
  }

  // Location force-activation (current location heuristic: high recent mentions)
  if (rules.forceActivateLocation && entryType === 'location' && entityProfile) {
    if (entityProfile.mentionCount >= 3) {
      forceActivation = true;
    }
  }

  // Widen searchRange for frequently mentioned entities
  if (rules.widenFrequentEntities && entityProfile) {
    if (entityProfile.mentionCount >= 5) {
      searchRange = Math.min(searchRange * 1.5, 5000);
    }
  }

  // Narrow searchRange for dormant entities (not seen in recent chunks)
  if (rules.narrowDormantEntities && entityProfile) {
    if (entityProfile.mentionCount <= 1 && !forceActivation) {
      searchRange = Math.max(Math.floor(searchRange * 0.6), 200);
    }
  }

  return {
    searchRange: Math.round(searchRange),
    forceActivation,
    keyRelative,
    nonStoryActivatable,
  };
}

function computeBudget(entry, metadata, profile, entityProfile, isForceActivated) {
  const entryType = getEntryType(entry.text, entry.displayName);
  const defaults = profile.categoryDefaults[entryType] || profile.categoryDefaults.character;

  let budgetPriority = defaults.budgetPriority;
  let contextSize = defaults.contextSize;

  // Protagonist: highest priority
  if (metadata.protagonist) {
    budgetPriority = Math.min(budgetPriority, 200);
    contextSize = Math.max(contextSize, 2048);
  }
  // Party members: elevated
  else if (metadata.role && PARTY_SIDE_ROLES.has(metadata.role)) {
    budgetPriority = Math.min(budgetPriority, 300);
    contextSize = Math.max(contextSize, 1536);
  }
  // Active NPCs (recent mentions)
  else if (entityProfile && entityProfile.mentionCount >= 3) {
    budgetPriority = Math.min(budgetPriority, defaults.budgetPriority - 50);
  }
  // Dormant: deprioritized
  else if (entityProfile && entityProfile.mentionCount <= 1 && !isForceActivated) {
    budgetPriority += 100;
    contextSize = Math.max(Math.floor(contextSize * 0.7), 256);
  }

  return { budgetPriority, contextSize };
}

function computePrefixSuffix(entry, metadata, profile, entryType) {
  if (!profile.rules.prefixInstructions) return { prefix: '', suffix: '' };

  let prefix = '';
  const suffix = '';

  if (metadata.protagonist) {
    prefix = '[The following describes the story\'s protagonist.]';
  } else if (metadata.role && PARTY_SIDE_ROLES.has(metadata.role)) {
    prefix = '[This character is currently with the protagonist.]';
  } else if (entryType === 'location') {
    // Only for locations that might be "current" — leave to activation rules
    prefix = '';
  } else if (entryType === 'concept') {
    // Check if entry text suggests a system/rule
    const text = (entry.text || '').toLowerCase();
    if (text.includes('magic') || text.includes('system') || text.includes('rule') ||
        text.includes('cultivation') || text.includes('technology') || text.includes('law')) {
      prefix = '[These rules govern this world and must be followed consistently.]';
    }
  }

  return { prefix, suffix };
}

async function computeBiases(entry, metadata, profile, generateTextFn) {
  const biases = [];
  let detectedSpeech = null; // 'distinctive' or 'neutral', null if not checked

  // Speech pattern detection — only for characters with the right profile rules
  if (profile.rules.biasCharacterSpeech) {
    const entryType = getEntryType(entry.text, entry.displayName);
    if (entryType === 'character') {
      // Check if already cached
      const speechMeta = metadata.all?.['opt-speech'];
      if (speechMeta === 'neutral') {
        return { biases, detectedSpeech: 'neutral' };
      }
      if (speechMeta === 'distinctive') {
        return { biases, detectedSpeech: 'distinctive' };
      }

      if (generateTextFn) {
        // Detect speech patterns via LLM (one call per new character)
        try {
          const result = await retryLLM(async () => {
            const resp = await generateTextFn([
              { role: 'system', content: 'You analyze character entries to detect distinctive speech patterns. Respond with JSON only.' },
              { role: 'user', content: `Does this character have distinctive speech patterns (accent, dialect, stutter, specific vocabulary, catchphrases)?

Character entry:
${(entry.text || '').slice(0, 1500)}

Respond with: {"distinctive": true/false, "patterns": ["description of each pattern"]}` },
            ], { temperature: 0.1 });
            if (!resp || !resp.output) return null;
            return recoverJSON(resp.output);
          }, { maxRetries: 0, passName: 'speech-detect' });

          if (result && result.distinctive && Array.isArray(result.patterns) && result.patterns.length > 0) {
            detectedSpeech = 'distinctive';
          } else {
            detectedSpeech = 'neutral';
          }
        } catch (e) {
          console.log(`${LOG_PREFIX} Speech detection failed for ${entry.displayName}: ${e.message}`);
        }
      }
    }
  }

  return { biases, detectedSpeech };
}

// ============================================================================
// ENTRY OPTIMIZER — combines all rule functions
// ============================================================================

async function optimizeEntry(entry, profile, entityProfiles, generateTextFn) {
  const metadata = parseMetadata(entry.text || '');
  const entityProfile = matchEntityProfile(entry, entityProfiles);
  const entryType = getEntryType(entry.text, entry.displayName);

  const activation = computeActivation(entry, metadata, profile, entityProfile);
  const budget = computeBudget(entry, metadata, profile, entityProfile, activation.forceActivation);
  const prefixSuffix = computePrefixSuffix(entry, metadata, profile, entryType);
  const biasResult = await computeBiases(entry, metadata, profile, generateTextFn);

  // Build contextConfig (NovelAI nests prefix/suffix/budgetPriority here)
  const contextConfig = {};
  if (prefixSuffix.prefix) contextConfig.prefix = prefixSuffix.prefix;
  if (prefixSuffix.suffix) contextConfig.suffix = prefixSuffix.suffix;
  contextConfig.budgetPriority = budget.budgetPriority;

  return {
    entryId: entry.id,
    displayName: entry.displayName,
    entryType,
    fields: {
      searchRange: activation.searchRange,
      forceActivation: activation.forceActivation,
      keyRelative: activation.keyRelative,
      nonStoryActivatable: activation.nonStoryActivatable,
      contextConfig,
      contextSize: budget.contextSize,
      loreBias: biasResult.biases,
    },
    // Speech detection result for metadata persistence
    detectedSpeech: biasResult.detectedSpeech,
  };
}

// ============================================================================
// DIFF ENGINE — only return entries that actually changed
// ============================================================================

function diffOptimized(optimized, currentEntry) {
  const delta = {};
  const current = currentEntry || {};

  for (const [key, value] of Object.entries(optimized.fields)) {
    // Skip empty strings/arrays
    if (value === '' || (Array.isArray(value) && value.length === 0)) {
      // Only include if current has a non-empty value we need to clear
      if (current[key] && current[key] !== '' && !(Array.isArray(current[key]) && current[key].length === 0)) {
        delta[key] = value;
      }
      continue;
    }

    // Compare values
    const currentVal = current[key];
    if (JSON.stringify(value) !== JSON.stringify(currentVal)) {
      delta[key] = value;
    }
  }

  return Object.keys(delta).length > 0 ? delta : null;
}

// ============================================================================
// PASS 6 ORCHESTRATOR — runs after lore scan passes
// ============================================================================

async function optimizeLoreEntries(entries, profileId, entityProfiles, getProvidersFn, confirmedFields, onProgress) {
  const profile = getProfile(profileId);

  if (!confirmedFields || confirmedFields.length === 0) {
    console.log(`${LOG_PREFIX} No confirmed writable fields — skipping optimization`);
    return { optimized: 0, skipped: entries.length, details: [] };
  }

  const details = [];
  let optimized = 0;
  let skipped = 0;

  // Process entries in batches using hybrid providers (same pattern as other scan passes)
  for (let i = 0; i < entries.length;) {
    const providers = typeof getProvidersFn === 'function' ? getProvidersFn() : [getProvidersFn];
    const batch = entries.slice(i, i + providers.length);
    i += providers.length;

    if (onProgress) {
      onProgress({
        phase: 'optimizing',
        current: Math.min(i, entries.length),
        total: entries.length,
        characterName: batch.map(e => e.displayName).join(', '),
      });
    }

    const batchResults = await Promise.all(batch.map((entry, idx) =>
      optimizeEntry(entry, profile, entityProfiles, providers[idx] || providers[0])
        .catch(e => {
          console.error(`${LOG_PREFIX} Failed to optimize ${entry.displayName}: ${e.message}`);
          return null;
        })
    ));

    for (let j = 0; j < batch.length; j++) {
      const entry = batch[j];
      const result = batchResults[j];
      if (!result) { skipped++; continue; }

      try {
        // Filter to only confirmed-writable fields
        const filteredFields = {};
        for (const [key, value] of Object.entries(result.fields)) {
          if (confirmedFields.includes(key)) {
            filteredFields[key] = value;
          }
        }

        // Diff against current entry state
        const delta = diffOptimized({ fields: filteredFields }, entry);

        // Build text update with optimization markers + speech cache
        let textUpdate = null;
        const extras = { 'opt-v': '1', 'opt-at': new Date().toISOString().slice(0, 10) };
        if (result.detectedSpeech) {
          extras['opt-speech'] = result.detectedSpeech;
        }
        if (entry.text) {
          textUpdate = setMetadata(entry.text, { extras });
        }

        if (delta || textUpdate) {
          const fullDelta = delta || {};
          if (textUpdate && textUpdate !== entry.text) {
            fullDelta.text = textUpdate;
          }
          details.push({
            entryId: entry.id,
            displayName: entry.displayName,
            entryType: result.entryType,
            delta: fullDelta,
            applied: false,
          });
          optimized++;
        } else {
          skipped++;
        }
      } catch (e) {
        console.error(`${LOG_PREFIX} Failed to optimize ${entry.displayName}: ${e.message}`);
        skipped++;
      }
    }
  }

  return { optimized, skipped, details };
}

// ============================================================================
// CONTINUOUS ADJUSTMENT — lightweight incremental optimization
// ============================================================================

function adjustOnNewText(entries, profileId, entityProfiles) {
  const profile = getProfile(profileId);
  const adjustments = [];

  for (const entry of entries) {
    const metadata = parseMetadata(entry.text || '');
    const entityProfile = matchEntityProfile(entry, entityProfiles);

    // Only recompute activation + prefix (budget stays stable)
    const activation = computeActivation(entry, metadata, profile, entityProfile);
    const entryType = getEntryType(entry.text, entry.displayName);
    const prefixSuffix = computePrefixSuffix(entry, metadata, profile, entryType);

    // Build delta (prefix nested in contextConfig)
    const newFields = {
      searchRange: activation.searchRange,
      forceActivation: activation.forceActivation,
    };
    if (prefixSuffix.prefix) {
      const currentCtx = entry.contextConfig || {};
      if (currentCtx.prefix !== prefixSuffix.prefix) {
        newFields.contextConfig = { ...currentCtx, prefix: prefixSuffix.prefix };
      }
    }

    const delta = {};
    for (const [key, val] of Object.entries(newFields)) {
      if (JSON.stringify(entry[key]) !== JSON.stringify(val)) {
        delta[key] = val;
      }
    }

    if (Object.keys(delta).length > 0) {
      adjustments.push({
        entryId: entry.id,
        displayName: entry.displayName,
        delta,
      });
    }
  }

  return adjustments;
}

// ============================================================================
// FIELD DISCOVERY — parse results from proxy inspectEntry/testAdvancedWrite
// ============================================================================

function parseDiscoveryResults(inspectResult, writeTestResult) {
  const report = {
    readableFields: [],
    writableFields: [],
    fieldDefaults: {},
    unsupported: [],
  };

  if (inspectResult && inspectResult.fields) {
    report.readableFields = inspectResult.fields;
    if (inspectResult.sample) {
      for (const field of inspectResult.fields) {
        report.fieldDefaults[field] = inspectResult.sample[field];
      }
    }
  }

  if (writeTestResult) {
    for (const [field, result] of Object.entries(writeTestResult)) {
      if (result && result.success) {
        report.writableFields.push(field);
      } else {
        report.unsupported.push(field);
      }
    }
  }

  return report;
}

// ============================================================================
// OPTIMIZATION STATE HELPERS
// ============================================================================

function buildOptimizationSummary(details) {
  const summary = {
    total: details.length,
    forceActivated: 0,
    budgetAdjusted: 0,
    searchRangeChanged: 0,
    prefixAdded: 0,
    biased: 0,
  };

  for (const d of details) {
    if (!d.delta) continue;
    if (d.delta.forceActivation !== undefined) summary.forceActivated++;
    if (d.delta.contextConfig?.budgetPriority !== undefined || d.delta.contextSize !== undefined) summary.budgetAdjusted++;
    if (d.delta.searchRange !== undefined) summary.searchRangeChanged++;
    if (d.delta.contextConfig?.prefix) summary.prefixAdded++;
    if (d.delta.loreBias && d.delta.loreBias.length > 0) summary.biased++;
  }

  return summary;
}

// ============================================================================
// UPDATE ENTRY METADATA WITH OPTIMIZATION MARKERS
// ============================================================================

function markEntryOptimized(entryText) {
  const now = new Date().toISOString().slice(0, 10);
  return setMetadata(entryText, {
    extras: {
      'opt-v': '1',
      'opt-at': now,
    },
  });
}

// ============================================================================
// EXPORTS
// ============================================================================

module.exports = {
  // Profiles
  PROFILES,
  getProfile,

  // Core optimization
  optimizeEntry,
  optimizeLoreEntries,
  diffOptimized,
  buildOptimizationSummary,
  markEntryOptimized,

  // Continuous adjustment
  adjustOnNewText,

  // Discovery
  parseDiscoveryResults,

  // Rule engine (for testing)
  computeActivation,
  computeBudget,
  computePrefixSuffix,
  computeBiases,
  matchEntityProfile,
};
