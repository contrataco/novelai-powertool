// metadata.js — Client-side synchronous metadata parser (mirrors lore-creator.js parseMetadata)

/**
 * Parse @-prefixed metadata header from entry text.
 * Returns { type, version, updated, source, role, protagonist, rest, all }
 * where `all` is a Record<string, string> of every @key: value pair,
 * and `rest` is the text without the header.
 *
 * This is a synchronous port of the backend parseMetadata() in lore-creator.js.
 * Keep both implementations in sync when modifying.
 */
export function parseMetadataClient(text) {
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
