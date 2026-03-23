/**
 * Metadata — @-prefixed metadata header parsing, setting, and entry type classification.
 *
 * Extracted from lore-creator.js to allow other modules (litrpg-tracker,
 * lorebook-optimizer) to import metadata utilities without pulling in the
 * full lore-creator dependency tree.
 */

// ============================================================================
// CONSTANTS
// ============================================================================

const METADATA_VERSION = 2;

const VALID_ENTRY_TYPES = ['character', 'location', 'item', 'faction', 'concept'];

// ============================================================================
// METADATA PARSING
// ============================================================================

/**
 * Parse @-prefixed metadata header from entry text.
 * Returns { type, version, updated, source, role, protagonist, rest, all }
 * where `all` is a Record<string, string> of every @key: value pair found,
 * and `rest` is the text without the header.
 */
function parseMetadata(text) {
  const empty = { type: null, version: null, updated: null, source: null, role: null, protagonist: false, narrativeRole: null, arc: null, rest: '', all: {} };
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

  return { ...meta, narrativeRole: all['narrative-role'] || null, arc: all['arc'] || null, rest: lines.slice(headerEnd).join('\n'), all };
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

// ============================================================================
// ENTRY TYPE CLASSIFICATION
// ============================================================================

/**
 * Get entry type from metadata header (authoritative), falling back to heuristic.
 */
function getEntryType(text, displayName) {
  const meta = parseMetadata(text);
  if (meta.type && VALID_ENTRY_TYPES.includes(meta.type)) {
    return meta.type;
  }
  return classifyEntryType(text, displayName);
}

// --- Internal character-detection helpers (used only by classifyEntryType) ---

function _looksLikeCharacterEntry(text) {
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

function _isCharacterEntryFormatted(text) {
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
 * Heuristic classifier: determines entry type based on text patterns.
 * Returns 'character'|'location'|'item'|'faction'|'concept'|'unknown'.
 */
function classifyEntryType(text, displayName) {
  if (!text || text.length < 10) return 'unknown';

  // Check metadata header first (authoritative)
  const meta = parseMetadata(text);
  if (meta.type && VALID_ENTRY_TYPES.includes(meta.type)) {
    return meta.type;
  }

  const scores = { character: 0, location: 0, item: 0, faction: 0, concept: 0 };

  // Character patterns — reuse existing heuristics
  if (_looksLikeCharacterEntry(text)) scores.character += 3;
  if (_isCharacterEntryFormatted(text)) scores.character += 3;
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

// ============================================================================
// EXPORTS
// ============================================================================

module.exports = {
  METADATA_VERSION,
  parseMetadata,
  setMetadata,
  hasMetadata,
  getEntryType,
  classifyEntryType,
};
