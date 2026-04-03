# Headless Story Text — Paragraph Rendering Fix

**Created**: 2026-04-03
**Status**: In Progress

## Overview

Story text in the headless editor displays as a wall of text with no visual paragraph separation. NovelAI's own editor uses ProseMirror's `<p>` elements with CSS margins, giving proper inter-paragraph spacing. The headless editor receives text with `\n` between paragraphs but displays it in a flat contenteditable div with `white-space: pre-wrap`, making each `\n` a single line break with no margin — indistinguishable from line breaks within a paragraph.

The fix renders each paragraph as a `<p>` element in the annotation output, activating the already-existing theme CSS rules and adding a base default margin.

## Root Cause

**Text flow:**
1. `readStoryTextFromDOM()` → ProseMirror's `doc.textBetween(0, size, '\n')` → plain text with single `\n` between paragraphs
2. `applyDiff(storyEditor, text)` → `el.innerText = text` → flat text nodes, no block structure
3. `annotateEditor()` → `buildAnnotatedHtml(text, ...)` → flat HTML with `<span>` elements only
4. `el.innerHTML = annotatedHtml` → still no `<p>` elements
5. CSS `white-space: pre-wrap` renders `\n` as a single line break — no visual gap

**Dormant CSS:** `main.css` already has `.theme-editorial .story-editor p { margin-bottom: 0.6em }` and `.theme-graphic-novel .story-editor p { margin-bottom: 0.5em }`. These rules never fire because `<p>` elements are never created.

## Design

### 1. `buildAnnotatedHtml` — paragraph-aware output

Split `text` on `\n` before building the HTML. For each paragraph:
- Compute which annotation spans intersect with that paragraph (clipping ranges to paragraph-local character offsets)
- Run the existing event-based HTML builder on the paragraph's text and local spans
- Emit the paragraph as a `<p>` element

Join paragraphs with `</p><p>`. Wrap the whole result in `<p>...</p>`.

**Cross-paragraph spans (AI text):** An AI text range that spans multiple paragraphs is split at each `\n` boundary. Each paragraph gets its own clamped `<span class="ai-text">` covering its portion of the range. This preserves correct visual highlighting across multi-paragraph AI completions.

**`last-paragraph` highlight:** Instead of a character-range span (which would conflict with `<p>` boundaries), add `class="last-paragraph"` directly to the final `<p>` element. The existing CSS `.story-editor .last-paragraph` still applies (CSS class on a block element rather than a span).

**Empty paragraphs:** A `\n\n` in the source (consecutive empty lines) produces an empty paragraph. Use `<p><br></p>` (with a `<br>` placeholder) rather than `<p></p>` — Chromium collapses truly empty block elements to zero height in contenteditable contexts. The `<br>` keeps the paragraph visually present as a blank line.

### 2. `restoreCursor` — block boundary accounting

`annotateEditor` saves the cursor offset using `preCursorRange.toString().length`, which follows `innerText` rules and counts `\n` for each block element boundary. After `innerHTML` is set with `<p>` elements, `restoreCursor` traverses text nodes only — it does not see the implicit `\n` that each `<p>` boundary contributes to `innerText`.

**Fix:** When entering a block-level element (`P`, `DIV`, etc.) that has a preceding block-level sibling, increment `currentOffset` by 1 before traversing the element's children. This accounts for the virtual `\n` separator.

`applyDiff` is unaffected: it saves, writes, and restores cursor entirely on flat `innerText` text (before annotation rebuilds `<p>` structure). No changes needed there.

### 3. CSS — base paragraph margin

Add a base-level rule so the default theme (no theme class) gets inter-paragraph spacing:

```css
.story-editor p {
  margin: 0 0 1em;
}
.story-editor p:last-child {
  margin-bottom: 0;
}
```

The existing theme-specific overrides (editorial `0.6em`, graphic-novel `0.5em`, manuscript `text-indent 2em; margin: 0`) remain unchanged and now actually fire.

Keep `white-space: pre-wrap` on `.story-editor`. During the 300ms annotation debounce window (between `applyDiff` setting flat `innerText` and `annotateEditor` rebuilding `<p>` HTML), `pre-wrap` keeps `\n` characters visible as line breaks. Once annotation fires, paragraphs render with proper `<p>` margins.

### 4. `annotateEditor` — always use `innerHTML` path

Currently, when there are no annotations to apply, `annotateEditor` short-circuits with `el.innerText = text` — which destroys any `<p>` structure. Change the fallback path to also emit paragraphed HTML via `buildAnnotatedHtml`. This ensures `<p>` structure is always maintained after annotation runs.

## Files to Modify

- `app/renderer/modules/diff.js` — `buildAnnotatedHtml` (paragraph split + `<p>` emission), `restoreCursor` (block boundary offset), `annotateEditor` (remove `innerText` fallback path)
- `app/renderer/styles/main.css` — add `.story-editor p` base margin rule

## Verification

1. Open the headless editor with a multi-paragraph story
2. Paragraphs should be visually separated by a blank-line-height gap (default theme)
3. Switch themes (editorial, graphic novel, manuscript) — each should apply its own paragraph style
4. Type in the editor — cursor should stay in the correct position after annotation fires (300ms after typing stops)
5. Trigger AI generation — `last-paragraph` pink highlight should apply to the final `<p>`; AI text blue highlight should span across paragraph boundaries correctly
6. Sync should be unchanged — `syncToWebview` reads `innerText` from the `<p>` structure and gets the same `\n`-separated text as before

## Non-Goals

- No changes to sync logic (`headless-editor.js`, `webview-polling.js`)
- No changes to the ProseMirror-to-text extraction
- No changes to AI text range tracking in `headless-editor.js`
- Intra-paragraph hard breaks (rare in NovelAI fiction) not specially handled — treated as new paragraphs (acceptable edge case)
