/**
 * Prompt text for ComfyUI models, built from what the scene pipeline hands
 * over. Pure functions - no store, no network - so they can be checked alone.
 *
 * For ComfyUI the scene pipeline normally writes the prompt in the model's
 * own form (getPromptGuide in comfyui.js), and that text is used as is. Its
 * fallback is NovelAI-style booru tags: count tags (1girl, 2boys), scene
 * tags in baseCaption, and one tag list per character in charCaptions with a
 * horizontal position. Tag-trained checkpoints (Pony) take that as-is.
 * Models whose text encoder was trained on captions (Z-Image's Qwen encoder,
 * Flux's T5, SDXL base, RealVisXL) do better with sentences, so for them
 * 'prose' rewrites that tag fallback without another LLM call.
 */

const NUMBER_WORDS = ['zero', 'one', 'two', 'three', 'four', 'five', 'six', 'seven', 'eight', 'nine'];
const NOUNS = { girl: ['woman', 'women'], boy: ['man', 'men'], other: ['person', 'people'] };
const COUNT_TAG = /^(\d+)(girl|boy|other)s?$/i;
const IMPLIED_COUNT_TAG = /^multiple (characters|girls|boys|others)$/i;
// Bare gender tags left in a character's list once the subject noun says it.
const GENDER_TAG = /^(female|male|woman|man|girl|boy)$/i;

function splitTags(text) {
  return String(text || '').split(',').map((s) => s.trim()).filter(Boolean);
}

function countPhrase(n, kind) {
  const [one, many] = NOUNS[kind];
  return n === 1 ? `a ${one}` : `${NUMBER_WORDS[n] || n} ${many}`;
}

/** Count tags become phrases ("2girls" -> "two women"); everything else is kept. */
function splitCounts(tags) {
  const counts = [];
  const rest = [];
  for (const tag of tags) {
    const m = tag.match(COUNT_TAG);
    if (m) counts.push(countPhrase(parseInt(m[1], 10), m[2].toLowerCase()));
    else if (!IMPLIED_COUNT_TAG.test(tag)) rest.push(tag);
  }
  return { counts, rest };
}

function joinWords(list) {
  if (list.length <= 1) return list[0] || '';
  return `${list.slice(0, -1).join(', ')} and ${list[list.length - 1]}`;
}

function capitalize(s) {
  return s ? s[0].toUpperCase() + s.slice(1) : s;
}

function sentence(s) {
  const t = s.trim();
  if (!t) return '';
  return /[.!?]$/.test(t) ? capitalize(t) : `${capitalize(t)}.`;
}

/** Same gender test the pipeline uses to pick 1girl/1boy, so the two agree. */
function subjectFor(tags) {
  const t = tags.join(' ').toLowerCase();
  if (/\b(female|woman|girl|lady|she|her)\b/.test(t)) return 'a woman';
  if (/\b(male|man|boy|he|his)\b/.test(t)) return 'a man';
  return 'a person';
}

function positionFor(center, total) {
  if (total < 2 || !center || !Number.isFinite(center.x)) return '';
  if (center.x < 0.4) return 'on the left';
  if (center.x > 0.6) return 'on the right';
  return 'in the center';
}

/**
 * Sentences from the pipeline's structured captions. Character names are
 * never included: the model has no idea who they are, and a name only pulls
 * the image toward whatever famous person shares it.
 */
function buildProsePrompt({ baseCaption, charCaptions }) {
  const { counts, rest } = splitCounts(splitTags(baseCaption));
  const parts = [];
  if (counts.length) {
    parts.push(sentence(`A scene of ${joinWords(counts)}${rest.length ? `: ${rest.join(', ')}` : ''}`));
  } else if (rest.length) {
    parts.push(sentence(`A scene: ${rest.join(', ')}`));
  }
  const chars = (charCaptions || []).filter((c) => c && c.char_caption);
  for (const c of chars) {
    const tags = splitTags(c.char_caption);
    let subject = subjectFor(tags);
    // One character and one count tag: the count already says who it is.
    if (subject === 'a person' && chars.length === 1 && counts.length === 1 && counts[0].startsWith('a ')) {
      subject = counts[0];
    }
    const details = tags.filter((t) => !GENDER_TAG.test(t));
    const where = positionFor(c.centers?.[0], chars.length);
    const lead = where ? `${where}, ${subject}` : subject;
    parts.push(sentence(details.length ? `${lead} with ${details.join(', ')}` : lead));
  }
  return parts.join(' ');
}

/**
 * A flat prompt (v1 pipeline, or one the user edited) for a prose model.
 * Only the count tags are rewritten; with none present the text is returned
 * unchanged, since it may already be a sentence the user wrote.
 */
function flatToProse(prompt) {
  const tags = splitTags(prompt);
  const { counts, rest } = splitCounts(tags);
  if (!counts.length) return String(prompt || '').trim();
  return [capitalize(joinWords(counts)), ...rest].join(', ');
}

function roundWeight(w) {
  return Math.round(w * 100) / 100;
}

/**
 * NovelAI emphasis to ComfyUI's (text:weight). NovelAI multiplies by 1.05 per
 * brace level and divides per bracket level, and V4 adds "1.5::text::".
 * ComfyUI's CLIPTextEncode reads braces and brackets as literal characters,
 * so a prompt carried over from NovelAI would otherwise lose its emphasis.
 */
function novelaiToComfyWeights(text) {
  let out = String(text || '');
  out = out.replace(/(\d+(?:\.\d+)?)::([^:]+?)::/g, (_, w, body) => `(${body.trim()}:${roundWeight(Number(w))})`);
  out = out.replace(/(\{+)([^{}[\]]+?)(\}+)/g, (_, open, body, close) =>
    `(${body.trim()}:${roundWeight(1.05 ** Math.min(open.length, close.length))})`);
  out = out.replace(/(\[+)([^{}[\]]+?)(\]+)/g, (_, open, body, close) =>
    `(${body.trim()}:${roundWeight(1 / 1.05 ** Math.min(open.length, close.length))})`);
  return out;
}

/**
 * Join prompt pieces in the form the model expects. Pieces may arrive with a
 * leading ", " (the art style suffixes are written to be appended).
 */
function joinPrompt(pieces, style) {
  const clean = pieces.map((p) => String(p || '').trim().replace(/^,\s*/, '').replace(/,\s*$/, '')).filter(Boolean);
  if (style !== 'prose') return clean.join(', ');
  return clean.map(sentence).join(' ');
}

/**
 * The output-format line for the classic (v1) scene prompt, which asks an
 * LLM for the whole prompt in one call and so carries no structured
 * captions to rewrite later. A prose model has to be asked for prose there.
 */
function sceneFormatGuideline(style) {
  return style === 'prose'
    ? '- Write 2-4 plain descriptive sentences, not a tag list. Describe each character by appearance, clothing and action - never by name'
    : '- Use comma-separated tags/descriptors';
}

module.exports = {
  sceneFormatGuideline,
  splitTags,
  splitCounts,
  buildProsePrompt,
  flatToProse,
  novelaiToComfyWeights,
  joinPrompt,
};
