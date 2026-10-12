/**
 * NovelAI special symbols - the notation NovelAI's story models understand.
 * Source: https://docs.novelai.net/en/text/specialsymbols
 *
 * One catalog drives three things:
 *  - the editor's Insert Symbol picker and command palette entries (renderer
 *    fetches it over IPC `nai-symbols:list`),
 *  - a short notation guide added to LLM prompts whose text contains these
 *    marks, so scans read them as structure rather than prose,
 *  - a writing guide for prompts that write story text, so edits keep the
 *    marks and may use them where they fit.
 */

'use strict';

// insert: text placed at the cursor; "|" marks where the caret goes (first
// occurrence, removed). block: true = goes on its own line.
const SYMBOLS = [
  { id: 'dinkus', name: 'Scene break', syntax: '***', block: true, insert: '***',
    use: 'A line by itself marks a scene or chapter break.', where: 'Story', models: 'All' },
  { id: 'asterism', name: 'New story', syntax: '⁂', block: true, insert: '⁂',
    use: 'A line by itself starts an entirely new story (new characters and plot).', where: 'Story', models: 'All' },
  { id: 'scene-change', name: 'Scene change note', syntax: '[ Five Minutes Later ]', block: true, insert: '[ | ]',
    use: 'Spaced brackets announce a change of place or time.', where: 'Story, Author\'s Note', models: 'All' },
  { id: 'chapter-title', name: 'Chapter title', syntax: '***\n[ Chapter 1: Title ]', block: true, insert: '***\n[ Chapter |: ]',
    use: 'Chapter heading in spaced brackets, best right after a dinkus. [ Prologue ] and [ Epilogue ] work most consistently.', where: 'Story', models: 'All' },
  { id: 'viewpoint', name: 'Viewpoint switch', syntax: '[ Character Name ]', block: true, insert: '[ | ]',
    use: 'Switches point of view to the named character (the model must recognise it as a name).', where: 'Story, Memory', models: 'All' },
  { id: 'attg', name: 'Story header (ATTG)', syntax: '[ Author: ; Title: ; Tags: ; Genre: ]', block: true,
    insert: '[ Author: |; Title: ; Tags: ; Genre: ]',
    use: 'Optional story initializer: author, title, tags, genre. Keep it at the top of Memory.', where: 'Memory (top)', models: 'All' },
  { id: 'rating', name: 'Quality rating', syntax: '[ S: 4 ]', block: true, insert: '[ S: | ]',
    use: 'Star rating 1-5 that steers prose quality.', where: 'Memory (with ATTG)', models: 'Erato, Xialong' },
  { id: 'style', name: 'Style tag', syntax: '[ Style: verbose ]', block: true, insert: '[ Style: | ]',
    use: 'Steers writing style (e.g. verbose, terse, poetic).', where: 'Author\'s Note', models: 'Krake, Clio, Kayra, Erato' },
  { id: 'knowledge', name: 'Knowledge tag', syntax: '[ Knowledge: paradoxes ]', block: true, insert: '[ Knowledge: | ]',
    use: 'Points the model at a subject it should draw on. Can be combined with Style.', where: 'Author\'s Note, Memory', models: 'Clio, Kayra, Erato, Xialong' },
  { id: 'instruction', name: 'Instruction', syntax: '{ Make the next scene tense }', block: true, insert: '{ | }',
    use: 'Curly braces padded with spaces give the model a direct instruction.', where: 'Story', models: 'Not Sigurd, Euterpe, Krake, Genji, Snek' },
  { id: 'comment', name: 'Hidden comment', syntax: '## note to self', block: true, insert: '## |',
    use: 'A line starting with ## is hidden from the AI. Each line needs its own ##.', where: 'Anywhere', models: 'All' },
  { id: 'command', name: 'Command / message', syntax: '> look around', block: true, insert: '> |',
    use: 'Text-adventure command, email quote, or computer output.', where: 'Story', models: 'All' },
  { id: 'sfx', name: 'Sound / emphasis', syntax: '*bang*', block: false, insert: '*|*',
    use: 'Asterisks mark sound effects (*bang*), vocal noises (*sigh*), or emphasis in speech.', where: 'Story', models: 'All' },
  { id: 'telepathy', name: 'Telepathic / written speech', syntax: '<Can you hear me?>', block: false, insert: '<|>',
    use: 'Chevrons replace quotes for telepathy, sign language, non-verbal or written dialogue.', where: 'Story', models: 'All' },
  { id: 'info-block', name: 'Info block', syntax: '----\nCategory\ntext\n***', block: true, insert: '----\n|\n\n***',
    use: 'Informational (non-prose) text. A category name may follow ----. End with *** to return to the story. Overuse can leak ---- into outputs.', where: 'Story, Lorebook', models: 'All' },
  { id: 'litrpg', name: 'LitRPG stat line', syntax: '─ Strength: 12', block: true, insert: '─ |',
    use: 'Starts lines of stats, attributes and possessions.', where: 'Story, Lorebook', models: 'All' },
  { id: 'forum', name: 'Forum / email post', syntax: '======\nusername', block: true, insert: '======\n|',
    use: 'Separates forum posts or emails; username below, optional thread name above.', where: 'Story', models: '==== Erato, Xialong; ====== Clio, Kayra, Erato, Xialong' },
  { id: 'en-space', name: 'En space (quotes, signs)', syntax: ' text', block: false, insert: ' |',
    use: 'Wide space for quoted letters, signs and notes.', where: 'Story', models: 'All' },
  { id: 'em-space', name: 'Em space (poetry, lyrics)', syntax: ' text', block: false, insert: ' |',
    use: 'Wide space for poetry and song lyrics.', where: 'Story', models: 'All' },
];

// Any of these in a text means it uses NovelAI notation.
const NOTATION_TEST = /(^|\n)\s*(\*\*\*|⁂|##|----|={4,}|>\s|─|\[ .+ \]|\{ .+ \})|<[^<>\n]{1,200}>|\*[^*\n]{1,40}\*/;

/** For prompts that READ story text (scans, memory, prompts for images). */
const NOTATION_GUIDE = [
  'The story uses NovelAI notation. Read it as structure, not prose:',
  '- "***" alone on a line = scene or chapter break; "⁂" = a new, separate story begins.',
  '- Lines in spaced brackets "[ ... ]" are headers or notes (chapter titles, scene/time changes like "[ Five Minutes Later ]", a viewpoint character\'s name, or story metadata such as "[ Author: ...; Title: ...; Tags: ...; Genre: ... ]", "[ Style: ... ]", "[ Knowledge: ... ]"). They are not events or characters.',
  '- "{ ... }" is an instruction to the AI, not story content.',
  '- "----" starts an informational block (not narration) that ends at "***".',
  '- "> text" is a player command, quoted message or computer output.',
  '- "*word*" is a sound effect or emphasis; "<text>" is telepathic, signed or written speech by a character.',
  '- "─" lines are LitRPG stats or inventory.',
].join('\n');

/** For prompts that WRITE story text (rewrites, expansions, suggestions). */
const WRITING_GUIDE = [
  'NovelAI notation: keep every special mark already in the text exactly as written ("***", "[ ... ]", "{ ... }", "*sound*", "<telepathy>", "> command", "─ stat line", "----" blocks).',
  'Where it clearly fits the story\'s existing style you may use: "***" on its own line for a scene break, "*word*" for a sound effect, "<words>" for telepathic or written speech, "> text" for a command or computer message, "─" for a LitRPG stat line.',
  'Never add "[ ... ]" headers, "{ ... }" instructions or "##" comments unless asked.',
].join(' ');

/** True if the text appears to use NovelAI notation. */
function usesNotation(text) {
  return typeof text === 'string' && NOTATION_TEST.test(text);
}

/** Remove "##" comment lines: NovelAI hides them from its AI, so ours should not see them either. */
function stripComments(text) {
  if (typeof text !== 'string' || !text.includes('##')) return text;
  return text.split('\n').filter((l) => !/^\s*##/.test(l)).join('\n');
}

/**
 * Text for narration: drop comments, scene-break and header lines, info-block
 * rulers and LitRPG line marks; read *sfx* and <telepathy> as their words.
 */
function forNarration(text) {
  if (typeof text !== 'string') return text;
  return stripComments(text).split('\n')
    .filter((l) => !/^\s*(\*\*\*|⁂|-{4,}|={4,}|\[ .* \]|\{ .* \})\s*$/.test(l))
    .map((l) => l.replace(/^\s*─\s*/, '').replace(/^\s*>\s?/, '')
      .replace(/\*([^*\n]{1,40})\*/g, '$1').replace(/<([^<>\n]{1,200})>/g, '"$1"')
      .replace(/[  ]/g, ' '))
    .join('\n');
}

/**
 * Prepare LLM messages: strip "##" comment lines from user content, and when
 * that content uses NovelAI notation add the reading guide to the system
 * prompt (or as one if there is none).
 */
function prepareMessages(messages) {
  if (!Array.isArray(messages)) return messages;
  const out = messages.map((m) => (m && m.role === 'user' && typeof m.content === 'string')
    ? { ...m, content: stripComments(m.content) } : m);
  const userText = out.filter((m) => m && m.role === 'user').map((m) => m.content).join('\n');
  if (!usesNotation(userText)) return out;
  const sys = out.findIndex((m) => m && m.role === 'system');
  if (sys >= 0) {
    if (!String(out[sys].content).includes('NovelAI notation')) {
      out[sys] = { ...out[sys], content: `${out[sys].content}\n\n${NOTATION_GUIDE}` };
    }
    return out;
  }
  return [{ role: 'system', content: NOTATION_GUIDE }, ...out];
}

module.exports = { SYMBOLS, NOTATION_GUIDE, WRITING_GUIDE, usesNotation, stripComments, forNarration, prepareMessages };
