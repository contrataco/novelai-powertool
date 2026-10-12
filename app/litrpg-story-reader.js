/**
 * LitRPG story reader - reads the WHOLE story in chunks and turns it into
 * character sheets, the cast, the protagonist, classes and quests.
 *
 * Each chunk gets one LLM call that lists the people in it and the game facts
 * it states (class chosen, level reached, item gained...), each backed by a
 * quote that must be found in the chunk. Results are cached by chunk hash, so
 * a rescan only reads chunks whose text changed. Everything else is a
 * deterministic fold of the cached results in story order: the latest stated
 * value wins, and a value the story never states is cleared.
 */

const { chunkStory } = require('./lore-comprehension');
const { recoverJSON, callLLM, NARRATOR_RULE, isNarratorPlaceholder, fuzzyNameScore } = require('./shared-utils');
const { parseMetadata, getEntryType } = require('./metadata');

const LOG_PREFIX = '[LitRPG]';
const READER_VERSION = 2;
const CHUNK_MAX_TOKENS = 2000;
const MAX_KNOWN_NAMES = 40;
// Same budget the NovelAI provider allows a reply of this size, so the chunk
// call is not cut off before the provider's own limit.
const CHUNK_TIMEOUT_MS = Math.max(90000, 30000 + CHUNK_MAX_TOKENS * 60);

const EVENT_TYPES = new Set([
  'class', 'subclass', 'level', 'xp', 'stat', 'skill', 'item', 'currency',
  'status', 'race', 'cultivation',
]);
const EVENT_CHANGES = new Set(['gain', 'lose', 'set', 'equip']);
const QUEST_STATUSES = new Set(['new', 'updated', 'completed', 'failed']);
const PERSON_KINDS = new Set(['person', 'creature', 'voice']);

// Fields the reader owns on a character sheet. A field the user edited by hand
// (listed in char._manualFields) is never overwritten.
const SHEET_FIELDS = [
  'class', 'subclass', 'level', 'race', 'xp', 'stats', 'abilities', 'equipment',
  'inventory', 'currency', 'statusEffects', 'cultivationRealm', 'cultivationStage',
];

const HONORIFICS = new Set(['mr', 'mrs', 'ms', 'miss', 'sir', 'lady', 'lord', 'dr', 'master', 'madam', 'mister']);

// ============================================================================
// TEXT HELPERS
// ============================================================================

/** Story text with quoted dialogue blanked out, for narration-only checks. */
function narrationOnly(text) {
  return String(text || '').replace(/"[^"\n]*"|“[^”\n]*”/g, ' ');
}

/** 'first' | 'second' | 'third', from pronouns in the narration. */
function detectPov(text) {
  const n = narrationOnly(text);
  const words = n.split(/\s+/).filter(Boolean).length || 1;
  const first = (n.match(/\b(?:I|[Mm]e|[Mm]y|[Mm]yself|I'm|I'd|I've|I'll)\b/g) || []).length;
  const second = (n.match(/\b[Yy]ou(?:r|rs|rself)?\b/g) || []).length;
  if (first / words >= 0.008 && first >= second) return 'first';
  if (second / words >= 0.008) return 'second';
  return 'third';
}

const SELF_NAME_RE = /\b(?:[Mm]y name(?:'s|\s+is|\s+was)|[Cc]all me|[Tt]hey call me|[Ee]veryone calls me)\s+([A-Z][\w'-]+(?:\s+[A-Z][\w'-]+)?)/;
const SELF_NAME_STOP = new Set(['Not', 'None', 'Nothing', 'Unimportant']);

/** The narrator's own name when the narration states it ("My name is Carl"). */
function findSelfName(text) {
  const m = narrationOnly(text).match(SELF_NAME_RE);
  if (!m) return null;
  const name = m[1].trim();
  return SELF_NAME_STOP.has(name.split(/\s+/)[0]) ? null : name;
}

function normText(s) {
  return String(s || '').toLowerCase().replace(/[‘’]/g, "'").replace(/[“”]/g, '"')
    .replace(/[^a-z0-9'%+/ ]+/g, ' ').replace(/\s+/g, ' ').trim();
}

/** True when `quote` is in `text`, allowing small differences in punctuation and wording. */
function quoteFound(quote, text) {
  const q = normText(quote);
  if (q.length < 4) return false;
  const t = normText(text);
  if (t.includes(q)) return true;
  const words = q.split(' ').filter(w => w.length >= 3);
  if (words.length < 3) return false;
  const tWords = new Set(t.split(' '));
  return words.filter(w => tWords.has(w)).length / words.length >= 0.85;
}

/** True when at least one significant word of `name` appears in `text`. */
function nameWordFound(name, text) {
  const t = ' ' + normText(text) + ' ';
  return normText(name).split(' ').some(w => w.length >= 3 && t.includes(' ' + w));
}

/** The source line holding the quote, used to spot menu and requirement lines. */
function lineOfQuote(quote, text) {
  const q = normText(quote).split(' ').slice(0, 4).join(' ');
  if (!q) return '';
  return String(text).split('\n').find(l => normText(l).includes(q)) || '';
}

const MENU_LINE_RE = /^\s*[─\-•*>|]*\s*\(?\d{1,2}[.)]\s+\S/;
const REQUIREMENT_RE = /\b(?:requires?|required|requirement|unlocks? at|available (?:at|to)|must (?:be|reach))\b/i;
const LEVEL_WORD_RE = /\b(?:level|lvl|lv|rank|tier)\b/i;
const XP_WORD_RE = /\b(?:xp|exp|experience)\b/i;
const ITEM_GAIN_RE = /\b(?:obtain(?:ed|s)?|receiv(?:ed|es?)|loot(?:ed|s)?|pick(?:ed|s)? up|acquir(?:ed|es?)|gain(?:ed|s)?|got|gets|take[sn]?|took|grab(?:bed|s)?|bought|buys?|purchas(?:ed|es?)|earn(?:ed|s)?|reward(?:ed|s)?|award(?:ed|s)?|equip(?:ped|s)?|wield(?:ed|s)?|added to|inventory|craft(?:ed|s)?|found|finds?|stole|steals?|given|gave|hand(?:ed|s) (?:me|him|her|them|over))\b/i;
const STATUS_WORD_RE = /\b(?:buff|debuff|status|effect|condition|afflict(?:ed)?|inflict(?:ed)?|applied|poison(?:ed)?|stun(?:ned)?|curse[ds]?|bless(?:ed|ing)|aura)\b|\[/i;
const NAMED_TYPES = new Set(['class', 'subclass', 'skill', 'item', 'race', 'status', 'cultivation']);

// Words that describe someone rather than name them ("the dad", "old guy").
const ROLE_WORDS = new Set([
  'dad', 'mom', 'mum', 'mother', 'father', 'brother', 'sister', 'son', 'daughter', 'wife', 'husband',
  'guy', 'guys', 'girl', 'boy', 'man', 'woman', 'men', 'women', 'kid', 'kids', 'teen', 'teenager',
  'old', 'young', 'other', 'others', 'survivor', 'survivors', 'stranger', 'everyone', 'people', 'person',
  'banker', 'manager', 'bank', 'branch', 'punk', 'rocker', 'voice', 'announcer', 'family', 'team',
  'friend', 'friends', 'neighbor', 'neighbour', 'player', 'players', 'contestant', 'contestants',
  'older', 'younger', 'little', 'big', 'boss', 'guard', 'soldier', 'cat', 'dog',
]);

/** True when `name` is written as a proper name in `text` and is not only role words. */
function isProperName(name, text) {
  const words = String(name).replace(/[^\w'\- ]/g, ' ').split(/\s+/).filter(Boolean)
    .filter((w, i) => !(i === 0 && /^the$/i.test(w)) && !HONORIFICS.has(w.toLowerCase().replace(/\.$/, '')));
  if (!words.length || words.every(w => ROLE_WORDS.has(w.toLowerCase()))) return false;
  return words.every(w => {
    if (w.length < 2) return true;
    const esc = w.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    const cap = esc[0].toUpperCase() + esc.slice(1).toLowerCase();
    return (/^[A-Z]/.test(w) && new RegExp(`\\b${esc}\\b`).test(text))
      || new RegExp(`\\b${cap}\\b`).test(text)
      || new RegExp(`\\b${esc.toUpperCase()}\\b`).test(text);
  });
}

// ============================================================================
// NAMES
// ============================================================================

function nameTokens(name) {
  const toks = normText(name).replace(/'s\b/g, '').split(' ').filter(Boolean);
  const out = toks.filter((t, i) => !(i === 0 && t === 'the') && !HONORIFICS.has(t));
  return out.length ? out : toks;
}

function nameKey(name) {
  return nameTokens(name).join(' ');
}

function isSubset(small, big) {
  return small.length > 0 && small.length < big.length && small.every(t => big.includes(t));
}

// ============================================================================
// CHUNK READING
// ============================================================================

function buildChunkMessages(chunk, total, { povLine, knownNames, contextHint }) {
  const known = knownNames.length ? `KNOWN CHARACTERS (use these exact names): ${knownNames.join(', ')}\n` : '';
  return [
    {
      role: 'system',
      content: `You extract LitRPG game facts from one passage of a story. ${contextHint || ''} Output ONLY valid JSON.`,
    },
    {
      role: 'user',
      content: `${povLine}
${known}
PASSAGE ${chunk.index + 1} of ${total}:
"""
${chunk.text}
"""

List:
1. "people": every named person or creature who appears or is named in this passage. Give the fullest name used, other names used for the same one here (e.g. "Donut" for "Princess Donut"), and whether they are on the protagonist's team or party. A nameless voice that speaks (an announcer, the System) counts, with kind "voice". ${NARRATOR_RULE} Classes, items, skills, places, teams and companies are NOT people.
2. "events": game facts this passage states for a specific character: class or subclass chosen or given, level reached, XP, a stat value, skill learned, item gained, lost or equipped, currency, buff or debuff, race, cultivation realm.
3. "classes": every game class this passage names or describes, including ones only offered, with a one-sentence description and its requirements.
4. "quests": quests or missions given, updated, completed or failed, and who they are for ("for": the character who received it).

STRICT RULES:
- A choice on a menu, an option in a list, a description, or a requirement ("Tier 2 requires Level 5") is NOT anyone's class, level, skill or item. "You have 10 minutes to choose a class" means nobody has a class yet. Record a class only when a character picks it, is given it, or the text says they have it.
- Never guess race from a class name or from words in a description. Record race only when the text states it for that character.
- "who" is the character's name. Facts about "I" or "me" in first-person narration: use the narrator's name if known, otherwise "narrator".
- "quote": copy the exact words from the passage that state the fact, under 25 words. No quote, no event.
- Empty lists when nothing applies.

JSON:
{"narrator":"the first-person narrator's name if this passage gives it, else null","people":[{"name":"","aliases":[],"kind":"person|creature|voice","onTeam":true}],"events":[{"who":"","type":"class|subclass|level|xp|stat|skill|item|currency|status|race|cultivation","name":"the class, skill, item, stat, status, race or currency name","amount":null,"change":"gain|lose|set|equip","detail":"short description or null","quote":""}],"classes":[{"name":"","description":"","requirements":null}],"quests":[{"title":"","status":"new|updated|completed|failed","for":"who received it","objectives":[],"giver":null,"quote":""}]}`,
    },
  ];
}

function str(v, max = 200) {
  return typeof v === 'string' && v.trim() ? v.trim().slice(0, max) : null;
}

function num(v) {
  if (typeof v === 'number' && isFinite(v)) return v;
  if (typeof v === 'string') {
    const n = Number(v.replace(/[,+\s]/g, ''));
    if (v.trim() && isFinite(n)) return n;
  }
  return null;
}

/**
 * Clean one chunk reply. Every event and quest must quote the chunk; menu
 * lines and requirements never count as a character's class, level or skill.
 * Returns { result, dropped } or null when the reply is unreadable.
 */
function validateChunkResult(parsed, chunkText) {
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return null;
  const dropped = [];
  const result = { narrator: null, people: [], events: [], classes: [], quests: [] };

  const narrator = str(parsed.narrator, 80);
  if (narrator && !isNarratorPlaceholder(narrator) && nameWordFound(narrator, chunkText)) result.narrator = narrator;

  const people = Array.isArray(parsed.people) ? parsed.people : [];
  const peopleKeys = people.map(p => nameKey(str(p && p.name, 80) || ''));
  for (const p of people) {
    let name = str(p && p.name, 80);
    if (!name || isNarratorPlaceholder(name)) continue;
    const kind = PERSON_KINDS.has(p.kind) ? p.kind : 'person';
    const rawAliases = (Array.isArray(p.aliases) ? p.aliases : []).map(a => str(a, 80)).filter(Boolean);
    if (kind === 'voice') {
      // Nameless voices get one stable name, so "voice", "announcer" and
      // "The Almost-Human Voice" are one character.
      const all = [name, ...rawAliases].join(' ');
      if (/\bannouncer\b/i.test(all)) name = 'The Announcer';
      else if (/\bsystem\b/i.test(all)) name = 'The System';
      else if (!isProperName(name, chunkText)) { dropped.push(`voice "${name}" has no name`); continue; }
      result.people.push({ name, aliases: [], kind, onTeam: false });
      continue;
    }
    // A person is someone the passage names, written as a name: "the dad" or
    // "Bank Branch Manager" (written lowercase in the story) is a description.
    if (!isProperName(name, chunkText)) {
      // The model often writes a known full name ("Dave Swift") where the
      // passage only says "Dave". Keep the words the passage writes; the cast
      // merge links "Dave" to the one full name it belongs to.
      // The first name must survive: "Hot Bitch" is not trimmed to "Bitch".
      const words = name.split(/\s+/);
      const written = words.filter(w => isProperName(w, chunkText)).join(' ');
      const keepsFirst = written && nameTokens(written)[0] === nameTokens(name)[0];
      if (!keepsFirst || !isProperName(written, chunkText) || isNarratorPlaceholder(written)) { dropped.push(`person "${name}" is not a name in the passage`); continue; }
      name = written;
    }
    const tokens = nameTokens(name);
    const aliases = rawAliases.filter(a => {
      if (isNarratorPlaceholder(a) || nameKey(a) === nameKey(name) || !isProperName(a, chunkText)) return false;
      const at = nameTokens(a);
      // A nickname, or a shorter form of the name; never another full name ("Dawn Kelly" is not "Swift").
      if (!(at.some(t => tokens.includes(t)) || at.length === 1)) return false;
      return !peopleKeys.some(k => k && k !== nameKey(name) && isSubset(at, k.split(' ')));
    });
    result.people.push({ name, aliases, kind, onTeam: typeof p.onTeam === 'boolean' ? p.onTeam : null });
  }
  const personKeys = new Set(result.people.flatMap(p => [p.name, ...p.aliases].map(nameKey)));

  for (const e of Array.isArray(parsed.events) ? parsed.events : []) {
    if (!e || typeof e !== 'object') continue;
    const type = String(e.type || '').toLowerCase();
    const who = str(e.who, 80);
    const name = str(e.name, 120);
    const quote = str(e.quote, 300);
    if (!EVENT_TYPES.has(type) || !who) continue;
    if (!quote || !quoteFound(quote, chunkText)) { dropped.push(`${type} for ${who}: quote not in passage`); continue; }
    if (type !== 'level' && type !== 'xp' && !name) continue;
    const amount = num(e.amount);
    if ((type === 'level' || type === 'xp' || type === 'stat') && amount == null) continue;
    // The thing itself must be in the quote that states it: a line naming no
    // class cannot give anyone a class.
    if (NAMED_TYPES.has(type) && !nameWordFound(name, quote)) { dropped.push(`${type} "${name}" for ${who}: not in its quote`); continue; }
    if (type === 'level' && !(LEVEL_WORD_RE.test(quote) && new RegExp(`\\b${amount}\\b`).test(quote))) { dropped.push(`level ${amount} for ${who}: quote is not about a level`); continue; }
    if (type === 'xp' && !XP_WORD_RE.test(quote)) { dropped.push(`xp for ${who}: quote is not about XP`); continue; }
    if (type === 'stat' && !(nameWordFound(name, quote) || quote.toUpperCase().includes(String(name).toUpperCase())) ) { dropped.push(`stat "${name}" for ${who}: not in its quote`); continue; }
    if (type === 'item' && e.change !== 'lose' && !ITEM_GAIN_RE.test(quote)) { dropped.push(`item "${name}" for ${who}: nothing gained in the quote`); continue; }
    if (type === 'item' && personKeys.has(nameKey(name))) { dropped.push(`item "${name}" is a person`); continue; }
    if (type === 'status' && !STATUS_WORD_RE.test(quote)) { dropped.push(`status "${name}" for ${who}: not a game effect`); continue; }
    const line = lineOfQuote(quote, chunkText);
    if (['class', 'subclass', 'level', 'skill', 'race'].includes(type) && (MENU_LINE_RE.test(line) || REQUIREMENT_RE.test(quote))) {
      dropped.push(`${type} "${name || amount}" for ${who}: menu or requirement line`);
      continue;
    }
    result.events.push({
      who, type, name, amount,
      change: EVENT_CHANGES.has(e.change) ? e.change : 'set',
      detail: str(e.detail, 200),
      quote,
    });
  }

  for (const c of Array.isArray(parsed.classes) ? parsed.classes : []) {
    const name = str(c && c.name, 80);
    if (!name || !nameWordFound(name, chunkText)) continue;
    result.classes.push({ name, description: str(c.description, 300), requirements: str(c.requirements, 200) });
  }

  for (const q of Array.isArray(parsed.quests) ? parsed.quests : []) {
    const title = str(q && q.title, 120);
    if (!title) continue;
    if (!(nameWordFound(title, chunkText) || (q.quote && quoteFound(q.quote, chunkText)))) { dropped.push(`quest "${title}" not in passage`); continue; }
    result.quests.push({
      title,
      status: QUEST_STATUSES.has(q.status) ? q.status : 'new',
      objectives: (Array.isArray(q.objectives) ? q.objectives : []).map(o => str(typeof o === 'string' ? o : o && o.text, 200)).filter(Boolean),
      giver: str(q.giver, 80),
      forWho: str(q.for, 80),
    });
  }

  return { result, dropped };
}

function buildCache(chunks, out) {
  const cache = { version: READER_VERSION, chunks: {} };
  for (const c of chunks) if (out.get(c.hash)) cache.chunks[c.hash] = out.get(c.hash);
  return cache;
}

/**
 * Read every chunk whose text is not already in the cache.
 * cache: { version, chunks: { [hash]: result } }. Returns the per-chunk list in
 * story order and counts. A chunk that could not be read has result null and
 * is retried on the next scan.
 */
async function readStoryChunks(storyText, cache, providers, opts = {}) {
  const { onProgress, onCheckpoint, povLine, knownNames, contextHint, label = 'RPG-read' } = opts;
  const chunks = chunkStory(storyText);
  const cached = (cache && cache.version === READER_VERSION && cache.chunks) || {};
  const todo = chunks.filter(c => !cached[c.hash]);
  const out = new Map(chunks.map(c => [c.hash, cached[c.hash] || null]));
  let read = 0, failed = 0, droppedTotal = 0;

  console.log(`${LOG_PREFIX} Reader: ${chunks.length} chunks, ${chunks.length - todo.length} cached, ${todo.length} to read`);
  if (onProgress) onProgress({ current: 0, total: todo.length });

  const step = Math.max(1, providers.length);
  for (let i = 0; i < todo.length; i += step) {
    const batch = todo.slice(i, i + step);
    await Promise.all(batch.map(async (chunk, j) => {
      const gen = providers[j % providers.length];
      const messages = buildChunkMessages(chunk, chunks.length, { povLine, knownNames, contextHint });
      for (let attempt = 0; attempt < 2; attempt++) {
        try {
          const { raw } = await callLLM(gen, messages, { maxTokens: CHUNK_MAX_TOKENS, temperature: 0.2, timeout: CHUNK_TIMEOUT_MS, label: `${label} ${chunk.index + 1}/${chunks.length}` });
          const parsed = recoverJSON(raw);
          if (validateChunkResult(parsed, chunk.text)) {
            out.set(chunk.hash, parsed);
            read++;
            return;
          }
          console.log(`${LOG_PREFIX} Reader chunk ${chunk.index + 1}: unreadable reply (attempt ${attempt + 1})`);
        } catch (err) {
          console.warn(`${LOG_PREFIX} Reader chunk ${chunk.index + 1}: ${err.message} (attempt ${attempt + 1})`);
        }
      }
      failed++;
    }));
    if (onProgress) onProgress({ current: Math.min(i + step, todo.length), total: todo.length });
    // Save reads as they finish: a scan that times out on a long story keeps
    // its progress, and the next scan continues from there.
    if (onCheckpoint) {
      try { await onCheckpoint(buildCache(chunks, out)); } catch (err) { console.warn(`${LOG_PREFIX} Reader checkpoint failed: ${err.message}`); }
    }
  }

  // The cache keeps the model's replies; checking them against the text runs
  // on every scan, so a stricter rule takes effect without rereading.
  const newCache = buildCache(chunks, out);
  const validated = chunks.map(c => {
    const v = out.get(c.hash) ? validateChunkResult(out.get(c.hash), c.text) : null;
    if (v) {
      droppedTotal += v.dropped.length;
      if (v.dropped.length) console.log(`${LOG_PREFIX} Reader chunk ${c.index + 1}: dropped ${v.dropped.length} unsupported (${v.dropped.slice(0, 5).join('; ')})`);
    }
    return { index: c.index, hash: c.hash, text: c.text, result: v ? v.result : null };
  });
  return {
    chunks: validated,
    cache: newCache,
    read, failed, dropped: droppedTotal, total: chunks.length,
  };
}

// ============================================================================
// CAST (ROSTER)
// ============================================================================

/**
 * Collect everyone the story or lorebook names into one list of people, merging
 * name variants: exact matches, aliases the reader saw, and a shorter name whose
 * words all belong to exactly one longer name ("Dave" -> "Dave Swift",
 * "The Announcer" -> "Game Show Announcer"). A short name that fits several
 * people ("Swift") stays separate.
 */
function buildRoster({ loreEntries, stateChars, chunks }) {
  const people = [];
  const byKey = new Map();

  const add = (name, { aliases = [], source, loreEntry = null, stateId = null, kind = null, onTeam = null, chunkIndex = null } = {}) => {
    if (!name || isNarratorPlaceholder(name)) return null;
    const key = nameKey(name);
    if (!key) return null;
    let p = byKey.get(key);
    if (!p) {
      for (const a of aliases) { p = byKey.get(nameKey(a)); if (p) break; }
    }
    if (!p) {
      p = { name, keys: new Set(), storyKeys: new Set(), aliases: new Set(), sources: new Set(), loreEntry: null, stateIds: [], kinds: new Set(), team: null, chunksSeen: new Set() };
      people.push(p);
    }
    const link = (n) => { const k = nameKey(n); if (!k) return; p.keys.add(k); if (!byKey.has(k)) byKey.set(k, p); if (n !== p.name) p.aliases.add(n); };
    link(name);
    for (const a of aliases) link(a);
    if (nameTokens(name).length > nameTokens(p.name).length && source !== 'state') { p.aliases.add(p.name); p.name = name; p.aliases.delete(name); }
    p.sources.add(source);
    if (source === 'story') p.storyKeys.add(key);
    if (loreEntry && !p.loreEntry) p.loreEntry = loreEntry;
    if (stateId && !p.stateIds.includes(stateId)) p.stateIds.push(stateId);
    if (kind) p.kinds.add(kind);
    if (onTeam !== null && chunkIndex !== null && (!p.team || chunkIndex >= p.team.chunk)) p.team = { value: onTeam, chunk: chunkIndex };
    if (chunkIndex !== null) p.chunksSeen.add(chunkIndex);
    return p;
  };

  for (const e of loreEntries) add(e.displayName, { source: 'lore', loreEntry: e });

  // An alias the reader gave for two different people is ambiguous; ignore it.
  const aliasOwners = new Map();
  for (const c of chunks) for (const p of (c.result ? c.result.people : [])) {
    for (const a of p.aliases) {
      const k = nameKey(a);
      if (!aliasOwners.has(k)) aliasOwners.set(k, new Set());
      aliasOwners.get(k).add(nameKey(p.name));
    }
  }
  for (const c of chunks) for (const p of (c.result ? c.result.people : [])) {
    const aliases = p.aliases.filter(a => aliasOwners.get(nameKey(a)).size === 1);
    add(p.name, { aliases, source: 'story', kind: p.kind, onTeam: p.onTeam, chunkIndex: c.index });
  }

  for (const [id, ch] of Object.entries(stateChars)) {
    const p = add(ch.name, { aliases: ch.aliases || [], source: 'state', stateId: id });
    if (p && ch.loreEntryName && nameKey(ch.loreEntryName) !== nameKey(ch.name)) {
      p.keys.add(nameKey(ch.loreEntryName));
    }
  }

  // Fold a short name into the one longer name that contains all of its words.
  let merged = true;
  while (merged) {
    merged = false;
    for (const small of people) {
      const sTok = nameTokens(small.name);
      const host = pickHost(people.filter(b => b !== small && isSubset(sTok, nameTokens(b.name))));
      if (!host) continue;
      // Two separate lorebook entries are two people, whatever their names.
      if (small.loreEntry && host.loreEntry && small.loreEntry !== host.loreEntry) continue;
      mergePeople(host, small, byKey);
      people.splice(people.indexOf(small), 1);
      merged = true;
      break;
    }
  }

  // A name that fits several people and none in particular ("Swift" in a family
  // of Swifts) is not a person of its own.
  for (const p of people) {
    const tok = nameTokens(p.name);
    p.ambiguous = people.filter(b => b !== p && isSubset(tok, nameTokens(b.name))).length >= 2;
  }

  const find = (name) => {
    if (!name) return null;
    const k = nameKey(name);
    if (byKey.has(k)) return byKey.get(k);
    const tok = nameTokens(name);
    return pickHost(people.filter(p => isSubset(tok, nameTokens(p.name))));
  };

  return { people, find, add };
}

/**
 * The one longer name a short name belongs to. When several fit ("Carl": an old
 * tracker entry "Carl Doe" and the story's "Carl Wilson"), the one whose full
 * name the story itself writes wins; still tied means ambiguous.
 */
function pickHost(hosts) {
  if (hosts.length === 1) return hosts[0];
  const inStory = hosts.filter(h => h.storyKeys.has(nameKey(h.name)));
  return inStory.length === 1 ? inStory[0] : null;
}

function mergePeople(host, small, byKey) {
  host.aliases.add(small.name);
  for (const a of small.aliases) host.aliases.add(a);
  for (const k of small.keys) { host.keys.add(k); byKey.set(k, host); }
  for (const k of small.storyKeys) host.storyKeys.add(k);
  for (const s of small.sources) host.sources.add(s);
  for (const id of small.stateIds) if (!host.stateIds.includes(id)) host.stateIds.push(id);
  for (const k of small.kinds) host.kinds.add(k);
  for (const c of small.chunksSeen) host.chunksSeen.add(c);
  if (!host.loreEntry) host.loreEntry = small.loreEntry;
  if (small.team && (!host.team || small.team.chunk > host.team.chunk)) host.team = small.team;
  host.aliases.delete(host.name);
}

// ============================================================================
// FOLD
// ============================================================================

const QUEST_SYNONYMS = { select: 'choose', pick: 'choose', chose: 'choose', selecting: 'choose', choosing: 'choose', kill: 'defeat', slay: 'defeat', beat: 'defeat' };
const QUEST_STOP = new Set(['a', 'an', 'the', 'your', 'my', 'of', 'to', 'for', 'and', 'quest', 'mission']);

/** True when two quest titles name the same task ("Choose a Class" / "Select Your Class"). */
function sameQuest(a, b) {
  if (fuzzyNameScore(a, b) >= 0.8) return true;
  const words = (s) => new Set(normText(s).split(' ').map(w => QUEST_SYNONYMS[w] || w).filter(w => w && !QUEST_STOP.has(w)));
  const A = words(a), B = words(b);
  if (!A.size || !B.size) return false;
  const shared = [...A].filter(w => B.has(w)).length;
  return shared / Math.min(A.size, B.size) >= 1 || shared / new Set([...A, ...B]).size >= 0.5;
}

function emptySheet() {
  return {
    class: null, subclass: null, level: null, race: null, xp: null, stats: {},
    abilities: [], equipment: [], inventory: [], currency: {}, statusEffects: [],
    cultivationRealm: null, cultivationStage: null, levelHistory: [], evidence: [],
  };
}

function findByName(list, name) {
  const k = normText(name);
  return list.find(x => normText(x.name) === k);
}

function applyEvent(sheet, e, chunkIndex) {
  const amt = e.amount;
  switch (e.type) {
    case 'class':
      if (e.change === 'lose') { if (sheet.class && normText(sheet.class) === normText(e.name)) sheet.class = null; }
      else sheet.class = e.name;
      break;
    case 'subclass':
      if (e.change === 'lose') sheet.subclass = null; else sheet.subclass = e.name;
      break;
    case 'level':
      if (sheet.level !== amt) sheet.levelHistory.push({ level: amt, chunk: chunkIndex });
      sheet.level = amt;
      break;
    case 'xp': {
      const cur = sheet.xp ? sheet.xp.current : null;
      sheet.xp = { current: e.change === 'gain' ? (cur || 0) + amt : e.change === 'lose' ? Math.max(0, (cur || 0) - amt) : amt, needed: sheet.xp ? sheet.xp.needed : null };
      break;
    }
    case 'stat': {
      if (amt == null) break;
      const key = String(e.name).toUpperCase().trim();
      const prev = sheet.stats[key] ? sheet.stats[key].value : 0;
      sheet.stats[key] = { value: e.change === 'gain' ? prev + amt : e.change === 'lose' ? prev - amt : amt, modifier: null };
      break;
    }
    case 'skill': {
      const ex = findByName(sheet.abilities, e.name);
      if (e.change === 'lose') { if (ex) sheet.abilities.splice(sheet.abilities.indexOf(ex), 1); break; }
      if (ex) { if (e.detail) ex.description = e.detail; if (amt != null) ex.level = amt; break; }
      sheet.abilities.push({ name: e.name, description: e.detail || '', level: amt, type: 'active', cost: null, category: null, cooldown: null, proficiency: null });
      break;
    }
    case 'item': {
      const qty = amt != null && amt > 0 ? amt : 1;
      if (e.change === 'equip') {
        const inv = findByName(sheet.inventory, e.name);
        if (inv) sheet.inventory.splice(sheet.inventory.indexOf(inv), 1);
        if (!findByName(sheet.equipment, e.name)) sheet.equipment.push({ name: e.name, slot: 'other', description: e.detail || '', rarity: 'unknown', bonuses: null, setName: null });
        break;
      }
      if (e.change === 'lose') {
        const inv = findByName(sheet.inventory, e.name);
        if (inv) { inv.quantity -= qty; if (inv.quantity <= 0) sheet.inventory.splice(sheet.inventory.indexOf(inv), 1); }
        const eq = findByName(sheet.equipment, e.name);
        if (!inv && eq) sheet.equipment.splice(sheet.equipment.indexOf(eq), 1);
        break;
      }
      const inv = findByName(sheet.inventory, e.name);
      if (inv) inv.quantity += qty;
      else sheet.inventory.push({ name: e.name, quantity: qty, type: 'other', rarity: null });
      break;
    }
    case 'currency': {
      if (amt == null) break;
      const unit = normText(e.name || 'gold').replace(/ /g, '_');
      const prev = sheet.currency[unit] || 0;
      sheet.currency[unit] = e.change === 'gain' ? prev + amt : e.change === 'lose' ? Math.max(0, prev - amt) : amt;
      break;
    }
    case 'status': {
      const ex = findByName(sheet.statusEffects, e.name);
      if (e.change === 'lose') { if (ex) sheet.statusEffects.splice(sheet.statusEffects.indexOf(ex), 1); break; }
      if (!ex) sheet.statusEffects.push({ name: e.name, type: /debuff|poison|curse|stun|slow|weak/i.test(`${e.name} ${e.detail || ''}`) ? 'debuff' : 'buff', duration: null });
      break;
    }
    case 'race':
      sheet.race = e.name;
      break;
    case 'cultivation':
      sheet.cultivationRealm = e.name;
      if (e.detail) sheet.cultivationStage = e.detail;
      break;
    default:
      break;
  }
  if (sheet.evidence.length < 30) sheet.evidence.push({ chunk: chunkIndex, type: e.type, quote: e.quote });
}

/**
 * Decide the protagonist (the player), part by part. A player the user picked
 * holds for the whole story. Otherwise the lorebook's @protagonist starts it,
 * and in first-person narration the player is whoever narrates each part: a
 * narrator who names themself takes over at once, one only the reader names
 * must narrate the next part too (one misread part does not flip the player).
 * Returns { person (the player now), at(chunkIndex), history, pov, source }.
 */
function resolveProtagonist({ storyText, loreEntries, stateChars, chunks, roster }) {
  const pov = detectPov(storyText);
  const res = { person: null, pov, source: null, history: [] };
  const perChunk = new Map();
  res.at = (i) => perChunk.get(i) || res.person;

  // The player the user picked wins over everything the story or lorebook says.
  for (const ch of Object.values(stateChars)) {
    if (ch.narrative?.storyFunction === 'protagonist' && (ch._manualFields || []).includes('storyFunction')) {
      res.person = roster.find(ch.name);
      res.source = 'manual';
      return res;
    }
  }
  for (const e of loreEntries) {
    if (parseMetadata(e.text).protagonist) {
      res.person = roster.find(e.displayName);
      if (res.person) { res.source = 'lorebook'; res.history.push({ chunk: null, person: res.person, source: 'lorebook' }); }
      break;
    }
  }
  if (pov !== 'first') return res;

  const narratorOf = (c) => {
    const self = findSelfName(c.text || '');
    const p = self && roster.find(self);
    if (p) return { person: p, source: 'self-named' };
    const n = c.result && c.result.narrator;
    const q = n && roster.find(n);
    return q ? { person: q, source: 'reader' } : null;
  };
  const ordered = chunks.slice().sort((a, b) => a.index - b.index);
  ordered.forEach((c, k) => {
    const here = narratorOf(c);
    if (here && here.person !== res.person) {
      const next = ordered[k + 1] && narratorOf(ordered[k + 1]);
      const confirmed = !res.person || here.source === 'self-named' || (next && next.person === here.person);
      if (confirmed) {
        res.person = here.person;
        res.source = here.source;
        res.history.push({ chunk: c.index, person: here.person, source: here.source });
      }
    }
    if (res.person) perChunk.set(c.index, res.person);
  });
  // Parts before the first named narrator belong to the first player found.
  const first = ordered.find(c => perChunk.has(c.index));
  if (first) for (const c of ordered) { if (c === first) break; perChunk.set(c.index, perChunk.get(first.index)); }

  // A self-name the cast does not hold yet: the caller adds that person.
  if (!res.person) {
    const self = findSelfName(storyText);
    if (self) { res.name = self; res.source = 'self-named'; }
  }
  return res;
}

/**
 * Fold every chunk's events, in story order, into one sheet per person.
 * `player` is the player person, or a function giving the player for a chunk
 * index (the player can change during the story).
 * Returns { sheets: Map(person -> sheet), classes, quests, unattributed }.
 */
function foldChunks(chunks, roster, player, pov) {
  const playerAt = typeof player === 'function' ? player : () => player;
  const sheets = new Map();
  const classes = new Map();
  const quests = [];
  let unattributed = 0;

  for (const c of chunks) {
    if (!c.result) continue;
    const narratorHere = c.result.narrator ? roster.find(c.result.narrator) : null;
    for (const e of c.result.events) {
      let p = null;
      if (isNarratorPlaceholder(e.who) || /^(?:the )?narrator$/i.test(e.who)) {
        p = narratorHere || (pov === 'first' ? playerAt(c.index) : null);
      } else {
        p = roster.find(e.who);
      }
      if (!p) { unattributed++; continue; }
      if (!sheets.has(p)) sheets.set(p, emptySheet());
      applyEvent(sheets.get(p), e, c.index);
    }
    for (const cl of c.result.classes) {
      const k = normText(cl.name);
      const prev = classes.get(k);
      classes.set(k, {
        name: prev ? prev.name : cl.name,
        description: cl.description || (prev && prev.description) || null,
        requirements: cl.requirements || (prev && prev.requirements) || null,
      });
    }
    for (const q of c.result.quests) {
      let ex = quests.find(x => sameQuest(x.title, q.title));
      if (!ex) { ex = { title: q.title, status: 'active', objectives: [], giver: q.giver, owner: null, chunk: c.index }; quests.push(ex); }
      if (!ex.owner) {
        const to = q.forWho && !/^(?:you|player|the player|narrator|the narrator|everyone|all|the team|team|party|the party)$/i.test(q.forWho) && !isNarratorPlaceholder(q.forWho)
          ? roster.find(q.forWho) : null;
        ex.owner = to || playerAt(c.index) || null;
      }
      if (q.status === 'completed' || q.status === 'failed') ex.status = q.status;
      for (const o of q.objectives) if (!ex.objectives.some(x => fuzzyNameScore(x.text, o) >= 0.8)) ex.objectives.push({ text: o, completed: q.status === 'completed' });
      if (q.status === 'completed') for (const o of ex.objectives) o.completed = true;
      if (!ex.giver && q.giver) ex.giver = q.giver;
    }
  }
  // Classes a character took count as classes even when no chunk described them.
  for (const sheet of sheets.values()) {
    for (const n of [sheet.class, sheet.subclass]) {
      if (n && !classes.has(normText(n))) classes.set(normText(n), { name: n, description: null, requirements: null });
    }
  }
  return { sheets, classes, quests, unattributed };
}

module.exports = {
  READER_VERSION,
  SHEET_FIELDS,
  detectPov,
  findSelfName,
  quoteFound,
  nameKey,
  nameTokens,
  buildChunkMessages,
  validateChunkResult,
  readStoryChunks,
  buildRoster,
  resolveProtagonist,
  foldChunks,
  sameQuest,
  emptySheet,
  // re-exported for callers deciding what is a character
  getEntryType,
};
