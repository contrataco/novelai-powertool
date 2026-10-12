// diff.js — Text diffing, patching, and editor annotation utilities

/**
 * Computes a simple character-level edit distance and returns a set of operations.
 */
export function diffText(oldText, newText) {
  // Find common prefix
  let commonPrefixLen = 0;
  while (commonPrefixLen < oldText.length && commonPrefixLen < newText.length &&
         oldText[commonPrefixLen] === newText[commonPrefixLen]) {
    commonPrefixLen++;
  }

  // Find common suffix
  let oldSuffixIndex = oldText.length - 1;
  let newSuffixIndex = newText.length - 1;
  while (oldSuffixIndex >= commonPrefixLen && newSuffixIndex >= commonPrefixLen &&
         oldText[oldSuffixIndex] === newText[newSuffixIndex]) {
    oldSuffixIndex--;
    newSuffixIndex--;
  }

  const commonSuffixLen = oldText.length - 1 - oldSuffixIndex;

  return {
    prefixLen: commonPrefixLen,
    suffixLen: commonSuffixLen,
    removed: oldText.slice(commonPrefixLen, oldText.length - commonSuffixLen),
    added: newText.slice(commonPrefixLen, newText.length - commonSuffixLen)
  };
}

// Words, runs of spaces, and single other characters: the units a
// within-paragraph diff works in, so a replaced word is one small edit.
function tokenize(s) {
  return s.match(/\w+|\s+|[^\w\s]/g) || [];
}

/**
 * Edits [{from, to, insert}] (offsets in oldText, ascending, non-overlapping)
 * that turn oldText into newText while touching as little as possible.
 * Unchanged paragraphs are never inside an edit; changed paragraphs are
 * diffed word by word. This keeps NovelAI's marks on everything between two
 * edits - a single prefix/suffix region would re-mark all of it (Replace All
 * across a story would recolor the whole span).
 */
export function planEdits(oldText, newText) {
  if (oldText === newText) return [];
  const a = oldText.split('\n');
  const b = newText.split('\n');
  const starts = [];
  for (let i = 0, o = 0; i < a.length; i++) { starts.push(o); o += a[i].length + 1; }

  // Unchanged paragraphs at both ends.
  let head = 0;
  while (head < a.length && head < b.length && a[head] === b[head]) head++;
  let tail = 0;
  while (tail < a.length - head && tail < b.length - head && a[a.length - 1 - tail] === b[b.length - 1 - tail]) tail++;

  const edits = [];
  if (a.length - head - tail === b.length - head - tail) {
    // Same paragraph count: diff each changed paragraph on its own.
    for (let i = head; i < a.length - tail; i++) {
      if (a[i] !== b[i]) edits.push(...diffWithin(a[i], b[i], starts[i]));
    }
    return edits;
  }

  // Paragraphs added or removed: one edit over the changed block, from the
  // first changed paragraph's start to the last one's end.
  const from = head < a.length ? starts[head] : oldText.length;
  const oldEnd = a.length - tail;
  const to = oldEnd > head ? starts[oldEnd - 1] + a[oldEnd - 1].length : from;
  const inserted = b.slice(head, b.length - tail).join('\n');
  if (b.length - tail === head) {
    // Paragraphs only removed: take one separator with them.
    if (head > 0) return [{ from: starts[head] - 1, to, insert: '' }];
    return [{ from: 0, to: starts[oldEnd], insert: '' }];
  }
  if (oldEnd > head) return [{ from, to, insert: inserted }];
  // Pure insertion of whole paragraphs between unchanged ones.
  if (head > 0) return [{ from: starts[head - 1] + a[head - 1].length, to: starts[head - 1] + a[head - 1].length, insert: '\n' + inserted }];
  return [{ from: 0, to: 0, insert: inserted + '\n' }];
}

/** Word-level edits turning paragraph x into y, offsets shifted by base. */
function diffWithin(x, y, base) {
  const p = tokenize(x);
  const q = tokenize(y);
  // Trim equal tokens at both ends, then LCS over what is left.
  let s = 0;
  while (s < p.length && s < q.length && p[s] === q[s]) s++;
  let e = 0;
  while (e < p.length - s && e < q.length - s && p[p.length - 1 - e] === q[q.length - 1 - e]) e++;
  const P = p.slice(s, p.length - e);
  const Q = q.slice(s, q.length - e);
  let offset = base;
  for (let i = 0; i < s; i++) offset += p[i].length;

  // Too large for a table: one edit for the changed middle.
  if (P.length * Q.length > 400000) {
    return [{ from: offset, to: offset + P.join('').length, insert: Q.join('') }];
  }
  const L = Array.from({ length: P.length + 1 }, () => new Uint32Array(Q.length + 1));
  for (let i = P.length - 1; i >= 0; i--) {
    for (let j = Q.length - 1; j >= 0; j--) {
      L[i][j] = P[i] === Q[j] ? L[i + 1][j + 1] + 1 : Math.max(L[i + 1][j], L[i][j + 1]);
    }
  }
  const edits = [];
  let i = 0;
  let j = 0;
  let pos = offset;
  let cur = null;
  const flush = () => { if (cur) { edits.push(cur); cur = null; } };
  while (i < P.length || j < Q.length) {
    if (i < P.length && j < Q.length && P[i] === Q[j]) {
      flush();
      pos += P[i].length; i++; j++;
    } else if (j < Q.length && (i >= P.length || L[i][j + 1] >= L[i + 1][j])) {
      if (!cur) cur = { from: pos, to: pos, insert: '' };
      cur.insert += Q[j]; j++;
    } else {
      if (!cur) cur = { from: pos, to: pos, insert: '' };
      pos += P[i].length; cur.to = pos; i++;
    }
  }
  flush();
  return edits;
}

/**
 * Applies a diff to a contenteditable element while preserving cursor position.
 * Returns the diff result so callers can update AI text range tracking.
 */
export function applyDiff(el, newText) {
  const oldText = editorText(el);
  if (oldText === newText) return { prefixLen: oldText.length, added: '', removed: '', suffixLen: 0 };

  const cursorOffset = caretOffset(el);
  const diff = diffText(oldText, newText);

  el.innerText = newText;

  if (cursorOffset !== -1) {
    let newOffset = cursorOffset;

    if (cursorOffset > diff.prefixLen) {
      const removedLen = diff.removed.length;
      const addedLen = diff.added.length;

      if (cursorOffset >= diff.prefixLen + removedLen) {
        newOffset = cursorOffset - removedLen + addedLen;
      } else {
        newOffset = diff.prefixLen + addedLen;
      }
    }

    restoreCursor(el, Math.min(newOffset, newText.length));
  }

  return diff;
}

/**
 * Merges overlapping or adjacent character ranges.
 */
export function mergeRanges(ranges) {
  if (ranges.length <= 1) return ranges;
  const sorted = [...ranges].sort((a, b) => a.start - b.start);
  const merged = [{ ...sorted[0] }];
  for (let i = 1; i < sorted.length; i++) {
    const last = merged[merged.length - 1];
    if (sorted[i].start <= last.end) {
      last.end = Math.max(last.end, sorted[i].end);
    } else {
      merged.push({ ...sorted[i] });
    }
  }
  return merged;
}

/**
 * Shifts AI text ranges after a user edit at a given position.
 * editPos: character offset where the edit happened
 * delta: number of characters added (positive) or removed (negative)
 */
export function shiftRangesAfterEdit(ranges, editPos, delta) {
  return ranges
    .map(({ start, end }) => {
      if (end <= editPos) return { start, end }; // before edit, unchanged
      if (start >= editPos) return { start: start + delta, end: end + delta }; // after edit, shift both
      // Edit is inside this range — expand or contract the end
      return { start, end: Math.max(start, end + delta) };
    })
    .filter(r => r.start < r.end); // remove zero-length ranges
}

// --- Annotation System ---

// Escapes quotes too: the result also goes into attribute values.
function escapeHtml(str) {
  return str.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;').replace(/'/g, '&#39;');
}


// --- NovelAI mark rendering ---

// NovelAI mark -> how the headless editor draws it. Order is nesting order,
// outermost first, so every segment gets the same well-formed structure.
const MARK_RENDER = [
  ['user_text', '<span class="nai-user">', '</span>'],
  ['ai_text', '<span class="nai-ai">', '</span>'],
  ['edit_text', '<span class="nai-edit">', '</span>'],
  ['prompt_text', '<span class="nai-prompt">', '</span>'],
  ['script_text', '<span class="nai-script">', '</span>'],
  ['highlight', '<span class="nai-highlight">', '</span>'],
  ['dialogue', '<span class="nai-dialogue">', '</span>'],
  ['bold', '<strong>', '</strong>'],
  ['italic', '<em>', '</em>'],
  ['underline', '<u>', '</u>'],
  ['strikethrough', '<s>', '</s>'],
  ['inline_code', '<code class="nai-code">', '</code>'],
];

/**
 * Shift mark runs ({s, e, m}) for a local edit that replaced `removed`
 * characters at `pos` with `added` characters. Text typed inside a run
 * stretches it, as NovelAI's own colors will once the edit is synced.
 */
export function shiftRuns(runs, pos, removed, added) {
  const delta = added - removed;
  const cut = pos + removed;
  return runs
    .map((r) => {
      if (r.e <= pos) return r;
      if (r.s >= cut) return { ...r, s: r.s + delta, e: r.e + delta };
      const s = Math.min(r.s, pos);
      const e = r.e <= cut ? pos + added : r.e + delta;
      return { ...r, s, e };
    })
    .filter((r) => r.e > r.s);
}

/**
 * Paragraph HTML from text + NovelAI mark runs + lorebook keywords.
 * runs: [{s, e, m: [markName], link}] in text offsets (paragraphs joined by
 * '\n'), as nai-doc.readRich returns them. Each paragraph is cut into
 * segments at every run and keyword boundary, and each segment is wrapped in
 * its own tags, so overlapping marks can never produce mis-nested HTML.
 */
export function buildRichHtml(text, runs, keywords) {
  if (!text) return '';
  const lowerText = text.toLowerCase();

  // Keyword hits, same matching rules as before: whole words, 3+ chars.
  const hits = [];
  for (const kw of keywords || []) {
    if (!kw.text || kw.text.length < 3) continue;
    const lowerKw = kw.text.toLowerCase();
    let idx = 0;
    while ((idx = lowerText.indexOf(lowerKw, idx)) !== -1) {
      const s = idx;
      const e = idx + lowerKw.length;
      idx = e;
      const before = s > 0 ? lowerText[s - 1] : ' ';
      const after = e < lowerText.length ? lowerText[e] : ' ';
      if (/\w/.test(before) || /\w/.test(after)) continue;
      hits.push({ s, e, kw });
    }
  }

  const lines = text.split('\n');
  let offset = 0;
  const out = lines.map((line, i) => {
    const start = offset;
    const end = start + line.length;
    offset = end + 1;
    const cls = i === lines.length - 1 ? ' class="last-paragraph"' : '';
    if (!line) return `<p${cls}><br></p>`;

    const localRuns = (runs || []).filter((r) => r.e > start && r.s < end);
    const localHits = hits.filter((h) => h.e > start && h.s < end);
    const cuts = new Set([0, line.length]);
    for (const r of localRuns) { cuts.add(Math.max(r.s, start) - start); cuts.add(Math.min(r.e, end) - start); }
    for (const h of localHits) { cuts.add(Math.max(h.s, start) - start); cuts.add(Math.min(h.e, end) - start); }
    const points = [...cuts].sort((a, b) => a - b);

    let inner = '';
    for (let k = 0; k < points.length - 1; k++) {
      const a = points[k];
      const b = points[k + 1];
      if (b <= a) continue;
      const absA = start + a;
      const active = new Set();
      let link = null;
      for (const r of localRuns) {
        if (r.s <= absA && r.e > absA) {
          r.m.forEach((m) => active.add(m));
          if (r.link) link = r.link;
        }
      }
      const hit = localHits.find((h) => h.s <= absA && h.e > absA);
      let open = '';
      let close = '';
      for (const [name, o, c] of MARK_RENDER) {
        if (active.has(name)) { open += o; close = c + close; }
      }
      if (link) {
        open += `<span class="nai-link" data-lore-id="${escapeHtml(String(link))}">`;
        close = '</span>' + close;
      }
      if (hit) {
        open += `<span class="lore-keyword" data-entry-id="${escapeHtml(String(hit.kw.entryId))}" data-display-name="${escapeHtml(String(hit.kw.displayName || hit.kw.text))}">`;
        close = '</span>' + close;
      }
      inner += open + escapeHtml(line.slice(a, b)) + close;
    }
    return `<p${cls}>${inner}</p>`;
  });
  return out.join('');
}

/**
 * Re-renders a contenteditable element from NovelAI mark runs and lore
 * keywords, preserving the cursor position.
 */
export function annotateEditor(el, runs, keywords) {
  const text = editorText(el);
  if (!text) return;
  const cursorOffset = caretOffset(el);
  el.innerHTML = buildRichHtml(text, runs, keywords);
  if (cursorOffset >= 0) restoreCursor(el, cursorOffset);
}

// --- Text <-> DOM position model ---
//
// innerText cannot be used for the editor text: once the editor holds <p>
// paragraphs it reports a blank line between every pair ("a\n\nb"), which
// would push extra empty paragraphs into NovelAI and skew every offset.
// linearize() defines the one text model everything uses: each top-level
// block is one line joined by a single '\n', a <br> is a line break unless it
// is the placeholder that keeps an empty paragraph open, and image embeds
// (non-editable elements) contribute nothing. Scene-break blocks contribute
// their original marker text.

const BLOCK_ELEMENTS = new Set(['P', 'DIV', 'H1', 'H2', 'H3', 'H4', 'H5', 'H6', 'LI', 'BLOCKQUOTE']);

function isSkipped(node) {
  return node.nodeType === 1 && !node.classList.contains('scene-break') &&
    (node.tagName === 'FIGURE' || node.getAttribute('contenteditable') === 'false');
}

function isPlaceholderBr(br) {
  const parent = br.parentNode;
  return !br.nextSibling && parent && parent.nodeType === 1 && BLOCK_ELEMENTS.has(parent.tagName);
}

/** { text, entries: Map(node -> {start, end}) } in document order. */
export function linearize(el) {
  let text = '';
  const entries = new Map();
  const walkInline = (node) => {
    const start = text.length;
    if (node.nodeType === 3) {
      text += node.textContent;
    } else if (node.nodeType === 1 && !isSkipped(node)) {
      if (node.tagName === 'BR') {
        if (!isPlaceholderBr(node)) text += '\n';
      } else {
        if (BLOCK_ELEMENTS.has(node.tagName) && text.length && !text.endsWith('\n')) text += '\n';
        node.childNodes.forEach(walkInline);
      }
    }
    entries.set(node, { start, end: text.length });
  };
  let any = false;
  let prevBlock = false;
  el.childNodes.forEach((n) => {
    if (isSkipped(n)) { entries.set(n, { start: text.length, end: text.length }); return; }
    const isBlock = n.nodeType === 1 && (BLOCK_ELEMENTS.has(n.tagName) || n.classList.contains('scene-break'));
    if (isBlock) {
      if (any) text += '\n';
      const start = text.length;
      if (n.classList.contains('scene-break')) text += n.dataset.original || n.textContent;
      else n.childNodes.forEach(walkInline);
      entries.set(n, { start, end: text.length });
    } else {
      if (prevBlock) text += '\n';
      walkInline(n);
    }
    prevBlock = isBlock;
    any = true;
  });
  return { text, entries };
}

/** The editor's text in the model NovelAI uses: paragraphs joined by '\n'. */
export function editorText(el) {
  return el ? linearize(el).text : '';
}

/** Text offset of a DOM position (container + offset) inside `el`. */
export function offsetOf(el, node, offset) {
  const { text, entries } = linearize(el);
  if (node === el) {
    const child = el.childNodes[offset];
    return child ? (entries.get(child)?.start ?? text.length) : text.length;
  }
  const entry = entries.get(node);
  if (!entry) return -1;
  if (node.nodeType === 3) return entry.start + Math.min(offset, node.textContent.length);
  const child = node.childNodes[offset];
  return child ? (entries.get(child)?.start ?? entry.end) : entry.end;
}

/** Caret offset in `el`, or -1 when the editor is not focused. */
export function caretOffset(el) {
  const sel = window.getSelection();
  if (document.activeElement !== el || !sel.rangeCount) return -1;
  const r = sel.getRangeAt(0);
  return offsetOf(el, r.startContainer, r.startOffset);
}

/** Selection as text offsets {start, end}, or null when not inside `el`. */
export function selectionOffsets(el) {
  const sel = window.getSelection();
  if (!sel.rangeCount) return null;
  const r = sel.getRangeAt(0);
  if (!el.contains(r.startContainer) || !el.contains(r.endContainer)) return null;
  const a = offsetOf(el, r.startContainer, r.startOffset);
  const b = offsetOf(el, r.endContainer, r.endOffset);
  if (a < 0 || b < 0) return null;
  return { start: Math.min(a, b), end: Math.max(a, b) };
}

/** Put the caret at a text offset, using the same model as editorText. */
export function restoreCursor(el, offset) {
  const { entries } = linearize(el);
  const range = document.createRange();
  let placed = false;
  for (const [node, { start, end }] of entries) {
    if (node.nodeType === 3 && offset >= start && offset <= end) {
      range.setStart(node, offset - start);
      placed = true;
      break;
    }
  }
  if (!placed) {
    // An empty paragraph has no text node: put the caret inside the block.
    for (const [node, { start }] of entries) {
      if (node.nodeType === 1 && node.parentNode === el && start === offset) {
        range.setStart(node, 0);
        placed = true;
        break;
      }
    }
  }
  if (!placed) {
    range.selectNodeContents(el);
    range.collapse(false);
  } else {
    range.collapse(true);
  }
  const selection = window.getSelection();
  selection.removeAllRanges();
  selection.addRange(range);
}
