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

/**
 * Applies a diff to a contenteditable element while preserving cursor position.
 * Returns the diff result so callers can update AI text range tracking.
 */
export function applyDiff(el, newText) {
  const oldText = el.innerText;
  if (oldText === newText) return { prefixLen: oldText.length, added: '', removed: '', suffixLen: 0 };

  const selection = window.getSelection();
  let cursorOffset = -1;
  let isFocused = document.activeElement === el;

  if (isFocused && selection.rangeCount > 0) {
    const range = selection.getRangeAt(0);
    const preCursorRange = range.cloneRange();
    preCursorRange.selectNodeContents(el);
    preCursorRange.setEnd(range.endContainer, range.endOffset);
    cursorOffset = preCursorRange.toString().length;
  }

  const diff = diffText(oldText, newText);

  el.innerText = newText;

  if (isFocused && cursorOffset !== -1) {
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

function escapeHtml(str) {
  return str.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

function findLastParagraphStart(text) {
  const trimmed = text.trimEnd();
  if (!trimmed) return 0;
  const lastDoubleNl = trimmed.lastIndexOf('\n\n');
  if (lastDoubleNl !== -1) return lastDoubleNl + 2;
  const lastNl = trimmed.lastIndexOf('\n');
  if (lastNl !== -1) return lastNl + 1;
  return 0;
}

/**
 * Builds an annotated HTML string from plain text + annotation data.
 * aiRanges: [{start, end}] — character offsets of AI-generated text
 * keywords: [{text, entryId, displayName}] — lorebook keywords to underline
 */
export function buildAnnotatedHtml(text, aiRanges, keywords) {
  if (!text) return '';

  // Split into paragraphs; track each paragraph's absolute start offset
  const paragraphs = [];
  let offset = 0;
  for (const line of text.split('\n')) {
    paragraphs.push({ text: line, start: offset });
    offset += line.length + 1; // +1 for the '\n' separator
  }

  // Collect annotation spans (last-paragraph is now a <p> class, not a span)
  const allSpans = [];

  // AI text ranges (priority 1)
  for (const { start, end } of aiRanges) {
    if (start >= 0 && end <= text.length && start < end) {
      allSpans.push({
        start, end,
        openTag: '<span class="ai-text">',
        closeTag: '</span>',
        priority: 1,
      });
    }
  }

  // Lorebook keyword matches (priority 2, innermost)
  const lowerText = text.toLowerCase();
  for (const kw of keywords) {
    if (!kw.text || kw.text.length < 3) continue;
    const lowerKw = kw.text.toLowerCase();
    let idx = 0;
    while ((idx = lowerText.indexOf(lowerKw, idx)) !== -1) {
      const kwStart = idx;
      const kwEnd = idx + lowerKw.length;
      idx = kwEnd;
      const charBefore = kwStart > 0 ? lowerText[kwStart - 1] : ' ';
      const charAfter = kwEnd < lowerText.length ? lowerText[kwEnd] : ' ';
      if (/\w/.test(charBefore) || /\w/.test(charAfter)) continue;
      const hasPartialOverlap = aiRanges.some(ar =>
        kwStart < ar.end && kwEnd > ar.start &&
        !(kwStart >= ar.start && kwEnd <= ar.end)
      );
      if (hasPartialOverlap) continue;
      allSpans.push({
        start: kwStart,
        end: kwEnd,
        openTag: `<span class="lore-keyword" data-entry-id="${escapeHtml(String(kw.entryId))}" data-display-name="${escapeHtml(String(kw.displayName || kw.text))}">`,
        closeTag: '</span>',
        priority: 2,
      });
    }
  }

  const lastParaIndex = paragraphs.length - 1;

  const parts = paragraphs.map((para, i) => {
    const { text: paraText, start: paraStart } = para;
    const paraEnd = paraStart + paraText.length;
    const isLast = i === lastParaIndex;

    // Empty paragraph — <br> placeholder prevents height collapse in contenteditable
    if (!paraText) {
      return isLast ? '<p class="last-paragraph"><br></p>' : '<p><br></p>';
    }

    // Collect spans that overlap this paragraph, clamped to paragraph-local offsets
    const localSpans = [];
    for (const span of allSpans) {
      if (span.end <= paraStart || span.start >= paraEnd) continue;
      localSpans.push({
        ...span,
        start: Math.max(span.start, paraStart) - paraStart,
        end: Math.min(span.end, paraEnd) - paraStart,
      });
    }

    // Build open/close events for this paragraph
    const events = [];
    for (const span of localSpans) {
      events.push({ pos: span.start, type: 'open',  tag: span.openTag,  priority: span.priority });
      events.push({ pos: span.end,   type: 'close', tag: span.closeTag, priority: span.priority });
    }
    events.sort((a, b) => {
      if (a.pos !== b.pos) return a.pos - b.pos;
      if (a.type !== b.type) return a.type === 'close' ? -1 : 1;
      if (a.type === 'open') return a.priority - b.priority;
      return b.priority - a.priority;
    });

    let inner = '';
    let textPos = 0;
    for (const ev of events) {
      if (ev.pos > textPos) {
        inner += escapeHtml(paraText.slice(textPos, ev.pos));
        textPos = ev.pos;
      }
      inner += ev.tag;
    }
    if (textPos < paraText.length) {
      inner += escapeHtml(paraText.slice(textPos));
    }

    return isLast
      ? `<p class="last-paragraph">${inner}</p>`
      : `<p>${inner}</p>`;
  });

  return parts.join('');
}

/**
 * Re-annotates a contenteditable element with AI text highlighting and lore keywords,
 * preserving the cursor position.
 */
export function annotateEditor(el, aiRanges, keywords) {
  const text = el.innerText;
  if (!text) return;

  // If nothing to annotate (including no last-paragraph to mark), clear any existing spans and bail
  const hasLastParagraph = findLastParagraphStart(text) < text.length;
  const hasAnnotations = aiRanges.length > 0 || keywords.length > 0 || hasLastParagraph;
  if (!hasAnnotations) {
    if (el.querySelector('.ai-text, .lore-keyword, .last-paragraph')) {
      el.innerText = text;
    }
    return;
  }

  const selection = window.getSelection();
  let cursorOffset = -1;
  const isFocused = document.activeElement === el;

  if (isFocused && selection.rangeCount > 0) {
    const range = selection.getRangeAt(0);
    const pre = range.cloneRange();
    pre.selectNodeContents(el);
    pre.setEnd(range.startContainer, range.startOffset);
    cursorOffset = pre.toString().length;
  }

  el.innerHTML = buildAnnotatedHtml(text, aiRanges, keywords);

  if (isFocused && cursorOffset >= 0) {
    restoreCursor(el, cursorOffset);
  }
}

function restoreCursor(el, offset) {
  const selection = window.getSelection();
  const range = document.createRange();

  let currentOffset = 0;
  let found = false;

  function traverse(node) {
    if (found) return;

    if (node.nodeType === Node.TEXT_NODE) {
      const len = node.textContent.length;
      if (currentOffset + len >= offset) {
        range.setStart(node, offset - currentOffset);
        range.setEnd(node, offset - currentOffset);
        found = true;
      } else {
        currentOffset += len;
      }
    } else {
      for (let i = 0; i < node.childNodes.length; i++) {
        traverse(node.childNodes[i]);
      }
    }
  }

  traverse(el);

  if (!found) {
    range.selectNodeContents(el);
    range.collapse(false);
  }

  selection.removeAllRanges();
  selection.addRange(range);
}
