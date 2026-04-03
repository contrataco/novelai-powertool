# Headless Story Text — Paragraph Rendering Fix

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make story text in the headless editor visually separate paragraphs with proper inter-paragraph spacing, matching NovelAI's own editor.

**Architecture:** `buildAnnotatedHtml` in `diff.js` currently produces flat HTML with `<span>` elements only — no `<p>` elements — so the CSS `pre-wrap` rule renders `\n` as a bare line break with no margin. We refactor `buildAnnotatedHtml` to wrap each `\n`-separated paragraph in a `<p>` element, fix `restoreCursor` to account for the implicit `\n` that block element boundaries contribute to `innerText`, and add a base CSS rule to give `<p>` elements default margin. Sync logic (`headless-editor.js`, `webview-polling.js`) is untouched.

**Tech Stack:** Vanilla JS (ES modules), CSS, Electron renderer process.

---

## File Map

- **Modify:** `app/renderer/modules/diff.js`
  - `buildAnnotatedHtml` (lines 132–228): replace entirely with paragraph-aware version
  - `restoreCursor` (lines 267–302): add block-boundary `\n` accounting; add `BLOCK_ELEMENTS` constant before function
  - `findLastParagraphStart` (lines 117–125): **keep unchanged** — still used by `annotateEditor`'s `hasAnnotations` guard

- **Modify:** `app/renderer/styles/main.css`
  - After line 324 (`.story-editor .last-paragraph` block): add base `.story-editor p` margin rule

---

## Task 1: Add base `.story-editor p` CSS rule

**Files:**
- Modify: `app/renderer/styles/main.css` after line 324

The theme-specific `p` margin rules already exist (editorial `0.6em`, graphic-novel `0.5em`, manuscript `margin: 0` with text-indent) but only fire when `<p>` elements exist. We add a default so the base theme (no theme class on `<body>`) also gets paragraph spacing.

Note: the CSS file uses 4-space indentation throughout its first section (lines 1–~5000); match that style.

- [ ] **Step 1: Add paragraph margin rule after `.story-editor .last-paragraph`**

Open `app/renderer/styles/main.css`. Find line 324 which ends the `.story-editor .last-paragraph` block:

```css
    .story-editor .last-paragraph {
      background: rgba(233, 69, 96, 0.08);
      border-radius: 2px;
    }
```

Insert immediately after it:

```css

    /* Base paragraph spacing — themes override below */
    .story-editor p {
      margin: 0 0 1em;
    }
    .story-editor p:last-child {
      margin-bottom: 0;
    }
```

- [ ] **Step 2: Commit**

```bash
cd app && git add renderer/styles/main.css
git commit -m "style: add base paragraph margin for headless editor <p> elements"
```

---

## Task 2: Refactor `buildAnnotatedHtml` for paragraph-element output

**Files:**
- Modify: `app/renderer/modules/diff.js` lines 132–228

**What changes:**
- Split `text` on `\n` to get paragraphs with their absolute start offsets
- Collect AI-text spans and lore-keyword spans as before, but skip building the `last-paragraph` span (it becomes a CSS class on the last `<p>` element instead)
- For each paragraph, clamp any overlapping spans to paragraph-local character offsets, run the event-based HTML builder within that paragraph, and emit `<p>...</p>`
- Empty paragraphs use `<p><br></p>` — a bare `<p></p>` collapses to zero height in Chromium contenteditable
- The last `<p>` gets `class="last-paragraph"`; the existing CSS already styles this selector

**Why this is safe for sync:** `syncToWebview` reads `storyEditor.innerText`. Chromium's `innerText` on a `<p>a</p><p>b</p>` structure returns `"a\nb"` (single `\n` per block boundary, trailing required-breaks stripped) — identical to what the flat `pre-wrap` text produced before.

- [ ] **Step 1: Replace `buildAnnotatedHtml` in `diff.js`**

Find and replace lines 132–228 (the entire `buildAnnotatedHtml` function) with:

```javascript
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
      if (a.type !== b.type) return a.type === 'open' ? -1 : 1;
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
```

- [ ] **Step 2: Syntax-check the file**

```bash
node --check --input-type=module < app/renderer/modules/diff.js
```

Expected: no output (clean).

- [ ] **Step 3: Commit**

```bash
git add app/renderer/modules/diff.js
git commit -m "feat: buildAnnotatedHtml emits <p> elements for paragraph spacing"
```

---

## Task 3: Fix `restoreCursor` for block-boundary character accounting

**Files:**
- Modify: `app/renderer/modules/diff.js` lines 267–302

**The problem:** `annotateEditor` saves the cursor offset using `preCursorRange.toString().length`, which follows `innerText` rules and counts one `\n` character for each block-element boundary (`</p><p>`). But `restoreCursor` traverses text nodes only — it never encounters these virtual `\n` characters. After `innerHTML` is set with `<p>` elements, the offset is off by 1 for each paragraph boundary crossed.

**Example:** text `"para1\npara2"`, cursor at position 6 (start of "para2").
- Save: `preCursorRange.toString()` = `"para1\n"` → length 6 ✓
- After `innerHTML` sets `<p>para1</p><p>para2</p>`:
  - Without fix: traverses text "para1" (5 chars), then text "para2" → places cursor at "para2"[1] = "a" (off by 1)
  - With fix: entering `<p>para2</p>` (which has a prior `<p>` sibling) adds 1 to `currentOffset` → places cursor at "para2"[0] = "p" ✓

**Fix:** Add a `BLOCK_ELEMENTS` constant at module scope. In `traverse`, when entering a block-level element that has a preceding block-level sibling, increment `currentOffset` by 1 before recursing into its children.

- [ ] **Step 1: Add `BLOCK_ELEMENTS` constant and replace `restoreCursor`**

Find lines 267–302 (the entire `restoreCursor` function) and the line immediately before it (line 266, which is blank or the closing brace of `annotateEditor`). Add the constant and replace the function:

```javascript
const BLOCK_ELEMENTS = new Set(['P', 'DIV', 'H1', 'H2', 'H3', 'H4', 'H5', 'H6', 'LI', 'BLOCKQUOTE']);

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
    } else if (node.nodeType === Node.ELEMENT_NODE) {
      // Block elements following another block sibling contribute an implicit '\n'
      // to innerText / Range.toString() — account for it in the offset count.
      if (BLOCK_ELEMENTS.has(node.tagName) &&
          node.previousElementSibling &&
          BLOCK_ELEMENTS.has(node.previousElementSibling.tagName)) {
        if (currentOffset + 1 > offset) {
          // Cursor sits exactly at the block boundary — place at start of this element
          const target = node.firstChild || node;
          range.setStart(target, 0);
          range.setEnd(target, 0);
          found = true;
          return;
        }
        currentOffset += 1;
      }
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
```

The `BLOCK_ELEMENTS` constant goes on the line immediately before `function restoreCursor(el, offset) {`.

- [ ] **Step 2: Syntax-check**

```bash
node --check --input-type=module < app/renderer/modules/diff.js
```

Expected: no output.

- [ ] **Step 3: Commit**

```bash
git add app/renderer/modules/diff.js
git commit -m "fix: restoreCursor accounts for block-element boundary newlines"
```

---

---

> **Note — `annotateEditor` fallback (spec §4):** The spec called for changing the `el.innerText = text` fallback in `annotateEditor` to use `buildAnnotatedHtml`. Analysis shows this branch is dead code: `hasAnnotations` is always `true` for non-empty text because `findLastParagraphStart(text) < text.length` is unconditionally true (the function always returns a value within `[0, text.length)`). No change to `annotateEditor` is needed.

---

## Task 4: Manual verification

Run the app and verify all scenarios:

```bash
cd app && npm start
```

- [ ] **Step 1: Paragraph spacing — default theme**

Open a story with multiple paragraphs (at least 4–5 paragraphs of varying length). The headless editor should display paragraphs separated by a visible gap (~1em ≈ 19px), not just a bare line break. Previously they appeared as a continuous wall of text.

- [ ] **Step 2: Paragraph spacing — editorial and graphic novel themes**

Open Settings → Appearance → switch to Editorial theme. Paragraph gap should be slightly smaller (0.6em). Switch to Graphic Novel — slightly smaller still (0.5em). Switch to Manuscript — paragraphs should be touching (no vertical gap) with first-line indent on each paragraph.

- [ ] **Step 3: `last-paragraph` highlight**

The last paragraph should have a faint pinkish background highlight. Confirm it is applied to the whole paragraph block, not just the text span.

- [ ] **Step 4: Cursor preservation after annotation**

Click inside the middle of a paragraph to place the cursor. Wait ~1 second for the annotation debounce (300ms) to fire. The cursor should not jump. Type a character — it should appear at the clicked position.

- [ ] **Step 5: AI text highlighting across paragraph boundary**

Trigger an AI generation that produces output spanning two paragraphs (let it complete a paragraph and start a new one). The blue AI-text highlight should appear in both paragraphs (each paragraph's portion is highlighted separately).

- [ ] **Step 6: Lore keyword highlighting**

With lore keywords set up, verify dotted-underline lore keywords still appear correctly within paragraphs.

- [ ] **Step 7: Sync round-trip**

With the headless editor open, make a text edit (add or delete a word), wait for sync, then check that the NovelAI story text in the webview matches the headless editor content exactly — no doubled blank lines, no missing paragraphs.

- [ ] **Step 8: Commit (if any small fixes were needed)**

```bash
git add -p
git commit -m "fix: <describe any fix>"
```
