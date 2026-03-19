// shared-utils.js — Shared constants and utilities used across backend modules

// ============================================================================
// CONSTANTS
// ============================================================================

const FUZZY_MATCH_THRESHOLD = 0.7;
const LLM_TIMEOUT_MS = 90_000;
const SCAN_TIMEOUT_MS = 600_000;
const STATUS_DURATIONS = { success: 2500, warn: 5000, error: 10000 };

// ============================================================================
// JSON RECOVERY
// ============================================================================

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

// ============================================================================
// ASYNC UTILITIES
// ============================================================================

function withTimeout(promise, ms, label = 'Operation') {
  let timer;
  const timeout = new Promise((_, reject) => {
    timer = setTimeout(() => reject(new Error(`${label} timed out after ${Math.round(ms / 1000)}s`)), ms);
  });
  return Promise.race([promise, timeout]).finally(() => clearTimeout(timer));
}

function delay(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

/**
 * Generate a unique ID with an optional prefix.
 * @param {string} [prefix='id'] - Prefix for the generated ID
 */
function generateId(prefix = 'id') {
  return `${prefix}_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`;
}

// ============================================================================
// FUZZY MATCHING
// ============================================================================

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
 * Returns 0–1: 1.0 exact, 0.8 substring, 0.75 word-overlap, 0.7 close edit distance, 0 no match.
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
function fuzzyFindEntry(name, existingEntries, threshold = FUZZY_MATCH_THRESHOLD) {
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
function fuzzyMatchInSet(name, nameSet, threshold = FUZZY_MATCH_THRESHOLD) {
  for (const existing of nameSet) {
    if (fuzzyNameScore(name, existing) >= threshold) return true;
  }
  return false;
}

// ============================================================================
// LLM CALL WRAPPER
// ============================================================================

/**
 * Unified LLM call wrapper with automatic timeout and optional JSON recovery.
 * @param {Function} genFn - generateTextFn(messages, options) → { output: string }
 * @param {Array} messages - [{role, content}] array
 * @param {object} [opts] - { timeout, label, json, maxTokens, temperature }
 * @returns {{ raw: string, parsed: object|null }}
 */
async function callLLM(genFn, messages, opts = {}) {
  const llmOpts = {};
  if (opts.maxTokens) llmOpts.max_tokens = opts.maxTokens;
  if (opts.temperature != null) llmOpts.temperature = opts.temperature;

  const promise = genFn(messages, llmOpts);
  const response = await withTimeout(
    promise,
    opts.timeout || LLM_TIMEOUT_MS,
    opts.label || 'LLM call'
  );
  const raw = response.output || '';
  if (!opts.json) return { raw, parsed: null };
  const parsed = recoverJSON(raw);
  return { raw, parsed };
}

module.exports = {
  // Constants
  FUZZY_MATCH_THRESHOLD,
  LLM_TIMEOUT_MS,
  SCAN_TIMEOUT_MS,
  STATUS_DURATIONS,

  // JSON recovery
  recoverJSON,

  // Async utilities
  withTimeout,
  delay,
  generateId,

  // Fuzzy matching
  levenshteinDistance,
  fuzzyNameScore,
  fuzzyFindEntry,
  fuzzyMatchInSet,

  // LLM wrapper
  callLLM,
};
