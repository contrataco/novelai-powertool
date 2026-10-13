// headless-editor.js - Core text sync, editor modes, metrics, customization

import { state, bus } from './state.js';
import * as refs from './dom-refs.js';
import { readStoryTextFromDOM } from './webview-polling.js';
import { loreCall, switchPanelTab, refreshLoreKeywords } from './lore-creator.js';
import { updateVisibility as updateStorySelectorVisibility } from './story-selector.js';
import { applyDiff, annotateEditor, diffText, planEdits, shiftRuns, editorText, setEditorText, selectionOffsets, restoreCursor } from './diff.js';
import { injected, readRich, applyTextEdit, applyMarkEdit } from './nai-doc.js';
import { showToast } from './utils.js';
import * as imageEmbed from './headless-image-embed.js';
import { getNovelaiStyle } from './headless-theme.js';

const { webview, storyEditor } = refs;

let isSyncingToWebview = false;
let isSyncingFromWebview = false;
// NovelAI's text as of the last read or successful write. Every write is
// checked against it, so a stale headless copy can never overwrite NovelAI.
let lastKnownWebviewText = '';
let annotationTimeout = null;
let lastEditorTextForAnnotation = '';
let noViewWarned = false;
// True once the font or line-spacing slider is moved for this story.
let typographyCustomized = false;

function scheduleAnnotation() {
  if (annotationTimeout) clearTimeout(annotationTimeout);
  annotationTimeout = setTimeout(() => {
    annotationTimeout = null;
    if (!storyEditor) return;
    const figures = imageEmbed.detachFigures();
    annotateEditor(storyEditor, state.naiRuns || [], state.loreKeywords || []);
    imageEmbed.reattachFigures(figures);
  }, 300);
}

// --- Story text cache ---
let cacheWriteTimeout = null;

function debouncedCacheWrite(text, source) {
  if (!state.currentStoryId) return;
  if (cacheWriteTimeout) clearTimeout(cacheWriteTimeout);
  cacheWriteTimeout = setTimeout(() => {
    window.powertool.storyTextSet(state.currentStoryId, text, source || 'editor');
    cacheWriteTimeout = null;
  }, 5000);
}

function flushCacheWrite() {
  if (cacheWriteTimeout && state.currentStoryId && storyEditor) {
    clearTimeout(cacheWriteTimeout);
    cacheWriteTimeout = null;
    window.powertool.storyTextSet(state.currentStoryId, editorText(storyEditor), 'editor');
  }
}

function showLoadingBar(text) {
  if (refs.editorLoadingBar) refs.editorLoadingBar.classList.remove('u-hidden');
  if (refs.editorLoadingText) refs.editorLoadingText.textContent = text || 'Loading story...';
  if (refs.editorLoadingFill) refs.editorLoadingFill.style.setProperty('--progress', '0%');
}

function updateLoadingBar(percent, text) {
  if (refs.editorLoadingFill) refs.editorLoadingFill.style.setProperty('--progress', `${Math.min(100, percent)}%`);
  if (text && refs.editorLoadingText) refs.editorLoadingText.textContent = text;
}

function hideLoadingBar() {
  if (refs.editorLoadingBar) refs.editorLoadingBar.classList.add('u-hidden');
}

function setSyncStatus(text, cls) {
  if (refs.editorSyncStatus) refs.editorSyncStatus.textContent = text;
  if (refs.editorSyncIndicator) refs.editorSyncIndicator.className = `status-indicator ${cls}`;
}

// --- NovelAI document access ---

/** NovelAI's story as { text, runs, paraIds }, or null if the editor is unreachable. */
async function readRichFromWebview() {
  try {
    const r = await webview.executeJavaScript(injected(readRich));
    if (r && !r.noView && typeof r.text === 'string') return r;
  } catch (e) {
    console.warn('[HeadlessSync] Rich read failed:', e.message);
  }
  return null;
}

function reportNoView() {
  setSyncStatus('Not synced', 'error');
  if (noViewWarned) return;
  noViewWarned = true;
  showToast("Couldn't reach NovelAI's editor, so headless edits are not being saved to NovelAI. " +
    'Switch to webview mode to keep writing safely.', null, 'error');
}

/**
 * Keep headless text that is about to be replaced by NovelAI's newer copy:
 * in localStorage (powertool.recovery.<storyId>) and on the clipboard, with a
 * toast saying so. Used whenever both sides changed - NovelAI's version wins,
 * but nothing typed in the headless editor disappears silently.
 */
async function saveRecovery(localText) {
  // Keep the last 5 copies (newest first) rather than overwriting the previous one.
  const key = `powertool.recovery.${state.currentStoryId}`;
  try {
    let list = [];
    try {
      const prev = JSON.parse(localStorage.getItem(key));
      list = Array.isArray(prev) ? prev : prev ? [prev] : [];
    } catch { /* unreadable old copy */ }
    if (list[0]?.text === localText) return; // this exact text is already kept and was announced
    list.unshift({ at: Date.now(), text: localText });
    localStorage.setItem(key, JSON.stringify(list.slice(0, 5)));
  } catch { /* the clipboard copy below is the user-facing one */ }
  let copied = false;
  try { await navigator.clipboard.writeText(localText); copied = true; } catch { /* window not focused */ }
  showToast("NovelAI's copy of this story changed while the headless editor had unsaved changes, so NovelAI's version was kept. " +
    (copied ? 'Your headless text was copied to the clipboard' : 'Your headless text was saved for recovery') +
    ' (the app keeps the last 5 copies).',
    null, 'warn', { persistent: true });
}

/**
 * Both sides changed since `base`. The headless editor is the source of
 * truth: when NovelAI's change and the local one touch different parts of the
 * text (the AI appended at the end while the user edited earlier), the result
 * keeps both. Returns null only when they overlap - a real clash.
 */
export function mergeEdits(base, local, nai) {
  if (local === nai) return local;
  if (local === base) return nai;
  if (nai === base) return local;
  const a = diffText(base, local), b = diffText(base, nai);
  const aEnd = a.prefixLen + a.removed.length, bEnd = b.prefixLen + b.removed.length;
  if (aEnd < b.prefixLen || (aEnd === b.prefixLen && a.removed.length + b.removed.length > 0 && a.prefixLen < b.prefixLen)) {
    return base.slice(0, a.prefixLen) + a.added + base.slice(aEnd, b.prefixLen) + b.added + base.slice(bEnd);
  }
  if (bEnd < a.prefixLen || (bEnd === a.prefixLen && a.removed.length + b.removed.length > 0 && b.prefixLen < a.prefixLen)) {
    return base.slice(0, b.prefixLen) + b.added + base.slice(bEnd, a.prefixLen) + a.added + base.slice(aEnd);
  }
  return null;
}

/** A write was refused as stale: merge if the changes don't clash, else keep a copy and take NovelAI's. */
async function handleSyncConflict(localText, base) {
  const rich = await readRichFromWebview();
  const merged = rich && typeof base === 'string' ? mergeEdits(base, localText, rich.text) : null;
  if (merged !== null && merged !== undefined) {
    console.log('[HeadlessSync] NovelAI changed elsewhere in the text; keeping both changes');
    state.naiRuns = rich.runs;
    lastKnownWebviewText = rich.text;
    if (editorText(storyEditor) !== merged) applyDiff(storyEditor, merged);
    lastEditorTextForAnnotation = merged;
    await syncToWebview();
    return;
  }
  console.warn('[HeadlessSync] NovelAI changed the same text that was edited here; keeping NovelAI\'s copy and saving the local one');
  await saveRecovery(localText);
  await syncFromWebview(true, { recovered: true });
}

/** Refresh colors and formatting from NovelAI without touching the text. */
async function refreshMarks() {
  const rich = await readRichFromWebview();
  if (rich && rich.text === editorText(storyEditor)) {
    state.naiRuns = rich.runs;
    lastKnownWebviewText = rich.text;
    lastEditorTextForAnnotation = rich.text;
    scheduleAnnotation();
  }
}

// --- Sync Functions ---

/**
 * Fetch the story (text and marks) from NovelAI and update the native editor.
 * @param {boolean} force - If true, replaces entire content without diffing.
 */
export async function syncFromWebview(force = false, { recovered = false } = {}) {
  if (isSyncingToWebview) return;
  isSyncingFromWebview = true;
  let pushInstead = false;

  try {
    const rich = await readRichFromWebview();
    const text = rich ? rich.text : await readStoryTextFromDOM();
    if (text === null || text === undefined) return;

    // Headless edits not yet pushed (a read landed inside the typing
    // debounce, or a push failed). If NovelAI has not changed, push them
    // instead of reading over them. If both changed, keep a copy first.
    const local = editorText(storyEditor);
    const unsent = lastKnownWebviewText !== null && local !== lastKnownWebviewText;
    if (unsent && text === lastKnownWebviewText) { pushInstead = true; return; }
    if (unsent && text !== local && !recovered) {
      // The headless editor is the source of truth: keep both changes when
      // they don't clash, then push the local one on top of NovelAI's.
      const merged = mergeEdits(lastKnownWebviewText, local, text);
      if (merged !== null) {
        console.log('[HeadlessSync] NovelAI changed elsewhere in the text; keeping both changes');
        if (rich) state.naiRuns = rich.runs;
        noteExternalChange(local);
        if (merged !== local) applyDiff(storyEditor, merged);
        lastKnownWebviewText = text;
        lastEditorTextForAnnotation = merged;
        state.lastKnownStoryLength = text.length;
        scheduleAnnotation();
        pushInstead = true;
        return;
      }
      console.warn('[HeadlessSync] NovelAI changed the same text that was edited here; keeping NovelAI\'s copy and saving the local one');
      await saveRecovery(local);
    }

    if (rich) state.naiRuns = rich.runs;
    const changed = text !== local;

    if (changed) {
      console.log('[HeadlessSync] Syncing text from webview');
      if (state.storyTextLoaded) noteExternalChange(local);
      if (force) setEditorText(storyEditor, text);
      else applyDiff(storyEditor, text);
      if (refs.editorAiStatus) refs.editorAiStatus.textContent = 'Ready';
      if (refs.editorAiIndicator) refs.editorAiIndicator.className = 'status-indicator';
      updateStatusMetrics();
      debouncedCacheWrite(text, rich ? 'doc-model' : (state._lastTextReadSource || 'webview'));
    }

    lastKnownWebviewText = text;
    lastEditorTextForAnnotation = text;
    state.lastKnownStoryLength = text.length;
    setSyncStatus('In Sync', 'active');

    scheduleAnnotation();
    if (changed) {
      await imageEmbed.restoreFigures();
      bus.emit('headless:synced-from-webview');
    }
  } catch (e) {
    console.error('[HeadlessSync] Error syncing from webview:', e);
  } finally {
    isSyncingFromWebview = false;
  }
  if (pushInstead) await syncToWebview();
}

/**
 * Push the native editor's changes into NovelAI as one minimal ProseMirror
 * edit, marked the way NovelAI marks typing (user_text, or edit_text inside AI
 * text). Never rewrites the whole document and never falls back to the DOM.
 */
let resyncWanted = false;
export async function syncToWebview() {
  // A push while another sync runs was dropped, and nothing retried it, so
  // fast typing could sit unsent until the next keystroke. Retry afterwards.
  if (isSyncingFromWebview || isSyncingToWebview) { resyncWanted = true; return; }
  resyncWanted = false;
  // No confirmed read of NovelAI's text yet (story still loading, or only
  // cached text shown): there is no safe baseline to diff against.
  if (lastKnownWebviewText === null) { setSyncStatus('Waiting for NovelAI', 'busy'); return; }
  const text = editorText(storyEditor);
  if (text === lastKnownWebviewText) return;
  isSyncingToWebview = true;
  let conflict = false;

  try {
    console.log('[HeadlessSync] Syncing text to webview');
    setSyncStatus('Syncing...', 'busy');

    const base = lastKnownWebviewText;
    const res = await webview.executeJavaScript(injected(applyTextEdit, {
      expected: base,
      edits: planEdits(base, text),
    }));

    if (!res || res.noView) { reportNoView(); return; }
    if (res.stale) { conflict = true; return; }
    if (res.error) {
      // NovelAI rejected the edit; its document is unchanged, so the edit
      // stays in the headless editor and is retried with the next change.
      console.error('[HeadlessSync] NovelAI rejected the edit:', res.error);
      setSyncStatus('Not synced', 'error');
      return;
    }

    lastKnownWebviewText = res.text;
    if (res.text !== text) console.warn('[HeadlessSync] NovelAI text differs from the editor after the write');
    setSyncStatus('In Sync', 'active');
  } catch (e) {
    console.error('[HeadlessSync] Error syncing to webview:', e);
    setSyncStatus('Not synced', 'error');
  } finally {
    isSyncingToWebview = false;
  }

  if (conflict) await handleSyncConflict(text, base);
  else await refreshMarks();
  if (resyncWanted) {
    resyncWanted = false;
    setTimeout(() => { syncToWebview(); }, 50);
  }
}

/** Every text position in [start, end) is covered by a run carrying `mark`. */
function markCovers(text, runs, start, end, mark) {
  for (let i = start; i < end; i++) {
    if (text[i] === '\n') continue;
    if (!runs.some((r) => r.s <= i && r.e > i && r.m.includes(mark))) return false;
  }
  return true;
}

/**
 * Bold/italic/underline/strikethrough over the selection, as NovelAI marks:
 * on when any part of the selection lacks it, off when all of it has it.
 */
export async function toggleFormat(mark) {
  const sel = selectionOffsets(storyEditor);
  if (!sel || sel.start === sel.end) { showToast('Select some text to format'); return; }
  await syncToWebview();
  const text = editorText(storyEditor);
  if (text !== lastKnownWebviewText) { showToast('Still syncing with NovelAI - try again in a moment', null, 'warn'); return; }
  const add = !markCovers(text, state.naiRuns || [], sel.start, sel.end, mark);
  let res;
  try {
    res = await webview.executeJavaScript(injected(applyMarkEdit, {
      expected: lastKnownWebviewText, from: sel.start, to: sel.end, mark, add,
    }));
  } catch (e) {
    console.error('[HeadlessSync] Format failed:', e);
    return;
  }
  if (!res || res.noView) { reportNoView(); return; }
  if (res.stale) { await handleSyncConflict(text); return; }
  if (res.error) { console.warn('[HeadlessSync]', res.error); return; }
  await refreshMarks();
  setTimeout(() => restoreCursor(storyEditor, sel.end), 320);
}

// --- Scroll-to-load: force NovelAI to load all story chunks ---

/**
 * NovelAI virtualizes ProseMirror — only renders visible text.
 * Scroll through the editor in the hidden webview to force all chunks to load,
 * then do a final sync to get the complete story text.
 */
async function scrollToLoadAll() {
  if (!webview) return;

  // Temporarily give the webview real dimensions — in headless mode it has
  // display:none / 0px viewport, so ProseMirror's lazy loader never triggers.
  const wvContainer = document.querySelector('.webview-container');
  const wasHidden = wvContainer && getComputedStyle(wvContainer).display === 'none';
  if (wasHidden && wvContainer) {
    // Make webview visible ON-SCREEN (behind our overlay at z-index 9000)
    // so Chromium actually renders it and NovelAI's scroll handlers trigger.
    // Off-screen rendering doesn't trigger intersection observers.
    wvContainer.style.display = 'block';
    wvContainer.style.position = 'fixed';
    wvContainer.style.top = '38px';
    wvContainer.style.left = '0';
    wvContainer.style.right = '0';
    wvContainer.style.bottom = '0';
    wvContainer.style.zIndex = '1'; // Behind overlay (z-index 9000)
    wvContainer.style.pointerEvents = 'none';
    // Wait for layout
    await new Promise(r => setTimeout(r, 1000));
  }

  try {
    if (refs.editorSyncStatus) refs.editorSyncStatus.textContent = 'Loading full story...';
    if (refs.editorSyncIndicator) refs.editorSyncIndicator.className = 'status-indicator busy';

    // Renderer-driven scroll loop — enables real-time progress reporting.
    // Each iteration scrolls one step, reads text length, updates UI.
    const scrollInfo = await webview.executeJavaScript(`
      (function() {
        var pm = document.querySelector('.ProseMirror');
        if (!pm) return null;
        var scrollEl = document.querySelector('.conversation-main') || pm.closest('[class*="conversation"]');
        if (!scrollEl) {
          scrollEl = pm;
          while (scrollEl && scrollEl !== document.body) {
            if (scrollEl.scrollHeight > scrollEl.clientHeight + 10) break;
            scrollEl = scrollEl.parentElement;
          }
        }
        if (!scrollEl || scrollEl === document.body) scrollEl = pm;
        return {
          viewportHeight: scrollEl.clientHeight || 600,
          scrollHeight: scrollEl.scrollHeight,
          scrollTop: scrollEl.scrollTop,
          textLength: pm.textContent.length,
          scrollSelector: '.' + (scrollEl.className || '').split(' ')[0]
        };
      })()
    `);

    if (!scrollInfo) {
      console.log('[HeadlessSync] Scroll-to-load: no ProseMirror found');
    } else {
      console.log('[ScrollLoad] start: ' + JSON.stringify(scrollInfo) + ' container was hidden: ' + wasHidden);
      const step = Math.max(scrollInfo.viewportHeight * 0.7, 200);
      let pos = scrollInfo.scrollTop;
      let prevLength = scrollInfo.textLength;
      let stableCount = 0;
      let stepCount = 0;
      let chunksLoaded = 0;
      let totalChars = prevLength;
      let phase = 'up';
      const stableThreshold = 6;
      const maxSteps = 300;
      const sel = scrollInfo.scrollSelector;

      while (stepCount < maxSteps) {
        stepCount++;

        // Execute one scroll step
        const stepResult = await webview.executeJavaScript(`
          (function() {
            var scrollEl = document.querySelector('${sel}') || document.querySelector('.ProseMirror');
            var pm = document.querySelector('.ProseMirror');
            if (!scrollEl || !pm) return null;
            scrollEl.scrollTop = ${phase === 'up' ? Math.max(0, pos - step) : pos + step};
            return {
              textLength: pm.textContent.length,
              scrollTop: scrollEl.scrollTop,
              scrollHeight: scrollEl.scrollHeight
            };
          })()
        `).catch(() => null);

        if (!stepResult) break;

        if (phase === 'up') pos = Math.max(0, pos - step);
        else pos += step;

        if (stepResult.textLength !== prevLength) {
          chunksLoaded++;
          totalChars = stepResult.textLength;
          stableCount = 0;
          console.log(`[ScrollLoad] ${phase.toUpperCase()} chunk #${chunksLoaded}: ${totalChars} chars (+${stepResult.textLength - prevLength})`);
          bus.emit('story:loading-phase', 'parsing',
            `Retrieving story text... ${chunksLoaded} chunk${chunksLoaded > 1 ? 's' : ''} loaded (${totalChars.toLocaleString()} chars)`);
          prevLength = stepResult.textLength;
        } else {
          stableCount++;
        }

        // Phase transitions
        if (phase === 'up' && stepResult.scrollTop <= 0 && stableCount >= stableThreshold) {
          console.log(`[ScrollLoad] Reached top after ${chunksLoaded} chunks. Scrolling down...`);
          phase = 'down';
          pos = 0;
          stableCount = 0;
          prevLength = stepResult.textLength;
        } else if (phase === 'down') {
          const atBottom = pos >= stepResult.scrollHeight - scrollInfo.viewportHeight;
          if (atBottom && stableCount >= stableThreshold) break;
          if (atBottom) pos = stepResult.scrollHeight - scrollInfo.viewportHeight;
        }

        await new Promise(r => setTimeout(r, 400));
      }

      console.log(`[ScrollLoad] Done. ${chunksLoaded} chunks, ${totalChars} chars, ${stepCount} steps`);
    }

    const result = { success: true };

    console.log('[HeadlessSync] Scroll-to-load result:', JSON.stringify(result));

    if (result && result.success) {
      // Final sync with the now-complete text
      await syncFromWebview(true);
      console.log('[HeadlessSync] Full story loaded:', editorText(storyEditor).length, 'chars');
    }

    if (refs.editorSyncStatus) refs.editorSyncStatus.textContent = 'In Sync';
    if (refs.editorSyncIndicator) refs.editorSyncIndicator.className = 'status-indicator active';
  } catch (e) {
    console.error('[HeadlessSync] Scroll-to-load error:', e);
    if (refs.editorSyncStatus) refs.editorSyncStatus.textContent = 'Partial Load';
  } finally {
    // Clear all inline styles so CSS classes control visibility again.
    // NEVER set inline display:none — it overrides the CSS sibling rule
    // .main-container.webview-active ~ .webview-container { display: block }
    if (wasHidden && wvContainer) {
      wvContainer.style.cssText = '';
    }
  }
}

// --- Status Metrics ---

export function updateStatusMetrics() {
  if (!storyEditor) return;
  const text = editorText(storyEditor);
  const wordCount = text.trim() ? text.trim().split(/\s+/).length : 0;
  const charCount = text.length;

  if (refs.editorWordCount) refs.editorWordCount.textContent = `${wordCount} words`;
  if (refs.editorCharCount) refs.editorCharCount.textContent = `${charCount} chars`;

  const tokenCount = Math.ceil(charCount / 4);
  if (refs.editorTokensEstimate) refs.editorTokensEstimate.textContent = `${tokenCount} tokens`;

  const readingTime = Math.max(1, Math.ceil(wordCount / 200));
  if (refs.editorReadingTime) refs.editorReadingTime.textContent = `${readingTime} min read`;
}

// --- Editor Customization ---

export function updateEditorStyles() {
  if (!storyEditor) return;

  // In the NovelAI theme, NovelAI's own size and spacing apply until the
  // sliders are moved for this story; the sliders then show those values.
  const followNovelai = !typographyCustomized && refs.editorContainer?.classList.contains('theme-novelai');
  if (followNovelai) {
    const nai = getNovelaiStyle();
    if (nai?.fontSize && refs.headlessFontSizeSlider) refs.headlessFontSizeSlider.value = Math.round(nai.fontSize);
    if (nai?.lineHeight && refs.headlessLineHeightSlider) refs.headlessLineHeightSlider.value = Math.round(nai.lineHeight * 10) / 10;
  }

  const fontSize = refs.headlessFontSizeSlider?.value || 16;
  const lineHeight = refs.headlessLineHeightSlider?.value || 1.8;
  const maxWidth = refs.headlessWidthSlider?.value || 1100;

  storyEditor.style.fontSize = followNovelai ? '' : `${fontSize}px`;
  storyEditor.style.lineHeight = followNovelai ? '' : lineHeight;
  storyEditor.style.maxWidth = `${maxWidth}px`;

  if (refs.headlessFontSizeValue) refs.headlessFontSizeValue.textContent = `${fontSize}px`;
  if (refs.headlessLineHeightValue) refs.headlessLineHeightValue.textContent = lineHeight;
  if (refs.headlessWidthValue) refs.headlessWidthValue.textContent = `${maxWidth}px`;
}

export async function saveCustomizationToStore() {
  const settings = {
    fontSize: refs.headlessFontSizeSlider?.value,
    lineHeight: refs.headlessLineHeightSlider?.value,
    editorWidth: refs.headlessWidthSlider?.value,
    // Only a moved font or spacing slider overrides the NovelAI theme.
    typography: typographyCustomized,
  };

  try {
    const current = await window.powertool.storySettingsGet(state.currentStoryId) || {};
    await window.powertool.storySettingsSet(state.currentStoryId, {
      ...current,
      editorCustomization: settings
    });
  } catch (e) {
    console.error('[HeadlessSync] Failed to save customization:', e);
  }
}

export async function loadCustomizationFromStore() {
  try {
    const storySettings = await window.powertool.storySettingsGet(state.currentStoryId);
    const settings = storySettings?.editorCustomization || {
      fontSize: 16,
      lineHeight: 1.8,
      editorWidth: 1100
    };

    typographyCustomized = !!storySettings?.editorCustomization?.typography;
    if (refs.headlessFontSizeSlider) refs.headlessFontSizeSlider.value = settings.fontSize;
    if (refs.headlessLineHeightSlider) refs.headlessLineHeightSlider.value = settings.lineHeight;
    if (refs.headlessWidthSlider) refs.headlessWidthSlider.value = settings.editorWidth;
    if (refs.editorWidthLabel) refs.editorWidthLabel.textContent = settings.editorWidth;

    updateEditorStyles();
  } catch (e) {
    console.error('[HeadlessSync] Failed to load customization:', e);
    updateEditorStyles();
  }
}

// --- Editor Modes ---

export function toggleFocusMode() {
  if (!refs.editorContainer) return;
  const isOn = refs.editorContainer.classList.toggle('focus-mode');
  showToast(`Focus Mode ${isOn ? 'Enabled' : 'Disabled'}`);
}

export function toggleTypewriterMode() {
  if (!refs.editorContainer) return;
  const isOn = refs.editorContainer.classList.toggle('typewriter-mode');
  showToast(`Typewriter Mode ${isOn ? 'Enabled' : 'Disabled'}`);

  if (isOn) {
    scrollToSelection();
  }
}

export function scrollToSelection() {
  if (!storyEditor || !refs.editorContainer?.classList.contains('typewriter-mode')) return;

  const selection = window.getSelection();
  if (selection.rangeCount > 0) {
    const range = selection.getRangeAt(0);
    const rect = range.getBoundingClientRect();
    const containerRect = refs.editorContainer.getBoundingClientRect();
    const targetY = containerRect.height / 2;
    const currentY = rect.top - containerRect.top;
    const scrollAdjust = currentY - targetY;

    refs.editorContainer.scrollBy({
      top: scrollAdjust,
      behavior: 'smooth'
    });
  }
}

export function flattenEditorText() {
  if (!storyEditor) return;
  const text = editorText(storyEditor);
  setEditorText(storyEditor, text);
  syncToWebview();
  showToast('Editor text flattened');
}

export function toggleReadOnlyMode() {
  if (!storyEditor) return;
  const isReadOnly = storyEditor.contentEditable === 'false';
  storyEditor.contentEditable = isReadOnly ? 'true' : 'false';
  showToast(`Editor ${isReadOnly ? 'Unlocked' : 'Locked'}`);
  if (refs.editorLockBtn) {
    refs.editorLockBtn.classList.toggle('active', !isReadOnly);
  }
}

// --- Streaming Listener ---

let streamUndoNoted = false;
export function handleStreamingText(text) {
  if (!storyEditor || isSyncingToWebview) return;
  isSyncingFromWebview = true;
  try {
    const local = editorText(storyEditor);
    // One undo step takes back the whole generation.
    if (!streamUndoNoted) { noteExternalChange(local); streamUndoNoted = true; }
    // Typing during generation is kept when it doesn't touch the AI's text;
    // it is pushed after the generation.
    let shown = text;
    if (lastKnownWebviewText !== null && local !== lastKnownWebviewText && text !== local) {
      const merged = mergeEdits(lastKnownWebviewText, local, text);
      if (merged !== null) shown = merged;
      else saveRecovery(local);
    }
    // New text stays uncolored until the post-generation read brings its marks.
    const d = diffText(lastEditorTextForAnnotation || local, shown);
    state.naiRuns = shiftRuns(state.naiRuns || [], d.prefixLen, d.removed.length, d.added.length);
    applyDiff(storyEditor, shown);
    lastKnownWebviewText = text;
    lastEditorTextForAnnotation = shown;
    updateStatusMetrics();
    // Keep last-paragraph indicator current during streaming
    scheduleAnnotation();
  } finally {
    isSyncingFromWebview = false;
  }
}

// --- Undo / redo in the headless editor ---
// Ctrl+Z used to send NovelAI's own undo to the hidden page. That undid
// NovelAI's last transaction (often an older push, or several at once), and
// with typing not yet pushed the next read saw both sides changed and kept
// NovelAI's copy: recent typing vanished and deleted text came back. Undo now
// works on the editor's own history and is pushed like any other edit.
const UNDO_LIMIT = 300;
const UNDO_GROUP_MS = 800;
const undoStack = [];
const redoStack = [];
let undoGroupOpen = false;
let undoGroupTimer = null;

function pushUndoPoint(text) {
  if (typeof text !== 'string') return;
  if (undoStack.length && undoStack[undoStack.length - 1] === text) return;
  undoStack.push(text);
  if (undoStack.length > UNDO_LIMIT) undoStack.shift();
  redoStack.length = 0;
}

function closeUndoGroup() {
  undoGroupOpen = false;
  if (undoGroupTimer) { clearTimeout(undoGroupTimer); undoGroupTimer = null; }
}

/** Typing: one undo step per burst (a pause of UNDO_GROUP_MS ends it). */
function noteUserEdit(textBefore) {
  if (!undoGroupOpen) { pushUndoPoint(textBefore); undoGroupOpen = true; }
  if (undoGroupTimer) clearTimeout(undoGroupTimer);
  undoGroupTimer = setTimeout(closeUndoGroup, UNDO_GROUP_MS);
}

/** A change that came from NovelAI (AI text, a read): its own undo step. */
function noteExternalChange(textBefore) {
  closeUndoGroup();
  pushUndoPoint(textBefore);
}

function resetUndoHistory() {
  closeUndoGroup();
  undoStack.length = 0;
  redoStack.length = 0;
}

function applyHistoryText(target) {
  const current = editorText(storyEditor);
  const d = diffText(current, target);
  state.naiRuns = shiftRuns(state.naiRuns || [], d.prefixLen, d.removed.length, d.added.length);
  applyDiff(storyEditor, target);
  lastEditorTextForAnnotation = target;
  updateStatusMetrics();
  scheduleAnnotation();
  restoreCursor(storyEditor, d.prefixLen + d.added.length);
  syncToWebview();
}

export function undoLocal() {
  closeUndoGroup();
  const current = editorText(storyEditor);
  while (undoStack.length && undoStack[undoStack.length - 1] === current) undoStack.pop();
  if (!undoStack.length) { showToast('Nothing to undo'); return; }
  redoStack.push(current);
  applyHistoryText(undoStack.pop());
}

export function redoLocal() {
  closeUndoGroup();
  if (!redoStack.length) { showToast('Nothing to redo'); return; }
  const current = editorText(storyEditor);
  undoStack.push(current);
  applyHistoryText(redoStack.pop());
}

// --- Init: Editor input listeners, story change, customization sliders ---

export function init() {
  if (!storyEditor) return;

  // Debounced sync to webview on input
  let syncTimeout = null;
  storyEditor.addEventListener('input', () => {
    if (isSyncingFromWebview) return;
    noteUserEdit(lastEditorTextForAnnotation);
    if (syncTimeout) clearTimeout(syncTimeout);
    syncTimeout = setTimeout(() => {
      syncToWebview();
    }, 500);
    updateStatusMetrics();

    // Keep NovelAI's colors lined up with the text until the next read
    // replaces them with what NovelAI actually recorded.
    const currentText = editorText(storyEditor);
    if (lastEditorTextForAnnotation) {
      const diff = diffText(lastEditorTextForAnnotation, currentText);
      state.naiRuns = shiftRuns(state.naiRuns || [], diff.prefixLen, diff.removed.length, diff.added.length);
    }
    lastEditorTextForAnnotation = currentText;

    scheduleAnnotation();
  });

  // Formatting shortcuts go through NovelAI marks too; the browser's own
  // bold/italic would only live until the next re-render.
  storyEditor.addEventListener('keydown', (e) => {
    if (!(e.ctrlKey || e.metaKey) || e.altKey || e.shiftKey) return;
    const mark = { b: 'bold', i: 'italic', u: 'underline' }[e.key.toLowerCase()];
    if (!mark) return;
    e.preventDefault();
    toggleFormat(mark);
  });

  // Typewriter mode scroll listeners
  storyEditor.addEventListener('input', () => {
    if (refs.editorContainer?.classList.contains('typewriter-mode')) scrollToSelection();
  });
  storyEditor.addEventListener('click', (e) => {
    if (refs.editorContainer?.classList.contains('typewriter-mode')) scrollToSelection();
    // Lore keyword click — switch to lore tab and highlight entry
    const kw = e.target.closest('.lore-keyword');
    if (kw) {
      const entryId = kw.dataset.entryId;
      if (entryId) {
        switchPanelTab('lore');
        bus.emit('lore:highlight-entry', { entryId, displayName: kw.dataset.displayName || '' });
      }
    }
  });
  storyEditor.addEventListener('keyup', (e) => {
    if (refs.editorContainer?.classList.contains('typewriter-mode') && e.key.startsWith('Arrow')) {
      scrollToSelection();
    }
  });

  // Bold/Italic/Underline toolbar buttons. mousedown is cancelled so the
  // click does not move focus out of the editor and drop the selection.
  const formatButtons = [[refs.editorBoldBtn, 'bold'], [refs.editorItalicBtn, 'italic'], [refs.editorUnderlineBtn, 'underline']];
  for (const [btn, mark] of formatButtons) {
    if (!btn) continue;
    btn.addEventListener('mousedown', (e) => e.preventDefault());
    btn.addEventListener('click', () => toggleFormat(mark));
  }

  // Focus mode button
  if (refs.editorFocusModeBtn) {
    refs.editorFocusModeBtn.addEventListener('click', () => toggleFocusMode());
  }

  // Lock button
  if (refs.editorLockBtn) {
    refs.editorLockBtn.addEventListener('click', toggleReadOnlyMode);
  }

  // Customization sliders
  if (refs.headlessFontSizeSlider) {
    refs.headlessFontSizeSlider.addEventListener('input', () => {
      typographyCustomized = true;
      if (refs.headlessFontSizeValue) refs.headlessFontSizeValue.textContent = `${refs.headlessFontSizeSlider.value}px`;
      updateEditorStyles();
    });
  }
  if (refs.headlessLineHeightSlider) {
    refs.headlessLineHeightSlider.addEventListener('input', () => {
      typographyCustomized = true;
      if (refs.headlessLineHeightValue) refs.headlessLineHeightValue.textContent = refs.headlessLineHeightSlider.value;
      updateEditorStyles();
    });
  }
  if (refs.headlessWidthSlider) {
    refs.headlessWidthSlider.addEventListener('input', () => {
      if (refs.headlessWidthValue) refs.headlessWidthValue.textContent = `${refs.headlessWidthSlider.value}px`;
      updateEditorStyles();
    });
  }

  // Width +/- buttons in status bar
  function adjustWidth(delta) {
    const slider = refs.headlessWidthSlider;
    const current = parseInt(slider?.value || '1100', 10);
    const next = Math.max(400, Math.min(1600, current + delta));
    if (slider) slider.value = next;
    if (refs.headlessWidthValue) refs.headlessWidthValue.textContent = `${next}px`;
    if (refs.editorWidthLabel) refs.editorWidthLabel.textContent = next;
    updateEditorStyles();
  }
  if (refs.editorWidthDown) {
    refs.editorWidthDown.addEventListener('click', () => adjustWidth(-100));
  }
  if (refs.editorWidthUp) {
    refs.editorWidthUp.addEventListener('click', () => adjustWidth(100));
  }

  // Immediate display from cache when bulk data arrives
  bus.on('story:text-cached', (cached) => {
    if (!storyEditor || !cached || !cached.text) return;
    if (editorText(storyEditor).length < 10) {
      console.log('[HeadlessSync] Pre-filling editor with cached text:', cached.char_count, 'chars');
      setEditorText(storyEditor, cached.text);
      // Display only: the cache may be older than NovelAI, so it is not a
      // baseline for writes. Nothing is pushed until a real read sets one.
      lastKnownWebviewText = null;
      lastEditorTextForAnnotation = cached.text;
      updateStatusMetrics();
      scheduleAnnotation();
    }
  });

  // Clear sync and mark state on story switch
  bus.on('story:changed', () => {
    state.naiRuns = [];
    lastKnownWebviewText = null;
    lastEditorTextForAnnotation = '';
    noViewWarned = false;
  });

  // Story change: keep overlay visible with loading status until text is ready
  bus.on('story:changed', async ({ storyTitle } = {}) => {
    const storyId = state.currentStoryId;
    console.log('[HeadlessSync] Story changed:', storyId);
    resetUndoHistory();
    if (refs.editorStoryTitle) refs.editorStoryTitle.textContent = storyTitle || 'Untitled Story';
    loadCustomizationFromStore();

    // Keep overlay visible — show "Loading story..." phase
    state.storyTextLoaded = false;
    bus.emit('story:loading-phase', 'connecting', 'Preparing story...');

    // Poll for ProseMirror + proxy readiness, then scroll to load full text.
    let attempts = 0;
    const maxAttempts = 20; // 20 * 1.5s = 30s max
    const pollInterval = setInterval(async () => {
      attempts++;
      if (state.currentStoryId !== storyId) {
        clearInterval(pollInterval);
        return;
      }

      // Story-specific progress phases
      if (attempts <= 2) {
        bus.emit('story:loading-phase', 'connecting', 'Opening story in NovelAI...');
      } else if (attempts <= 4) {
        bus.emit('story:loading-phase', 'dashboard', 'Waiting for story editor to initialize...');
      } else if (attempts <= 6) {
        bus.emit('story:loading-phase', 'dashboard', 'Connecting to story data...');
      } else {
        bus.emit('story:loading-phase', 'parsing', 'Loading story text... (' + (attempts * 1.5).toFixed(0) + 's)');
      }

      if (attempts >= maxAttempts) {
        clearInterval(pollInterval);
        // Last resort: use whatever ProseMirror has
        await syncFromWebview(true);
        const partialText = lastKnownWebviewText;
        if (partialText) {
          console.log('[HeadlessSync] Timeout - using partial text:', partialText.length, 'chars');
          window.powertool.storyTextSet(storyId, partialText, 'partial');
          finishStoryLoad(storyId);
        } else {
          bus.emit('story:loading-phase', 'error', 'Story text loading timed out. Try selecting the story again.');
        }
        return;
      }

      // Check if ProseMirror and script proxy are ready
      const hasPM = await webview.executeJavaScript(`!!document.querySelector('.ProseMirror')`).catch(() => false);

      if (hasPM && (state.loreProxyReady || state.memoryProxyReady)) {
        clearInterval(pollInterval);
        bus.emit('story:loading-phase', 'parsing', 'Retrieving full story from NovelAI...');
        console.log('[HeadlessSync] ProseMirror + proxy ready. Starting scroll-to-load...');

        // Scroll through the visible webview to trigger NovelAI's chunk loading
        await scrollToLoadAll();

        if (state.currentStoryId !== storyId) return;

        // scrollToLoadAll ends with a read of NovelAI's own document (text
        // and marks). That read is what the editor shows and what writes are
        // checked against; the Script API copy only warns about a partial load.
        let fullText = lastKnownWebviewText;
        if (!fullText) {
          await syncFromWebview(true);
          fullText = lastKnownWebviewText;
        }
        try {
          const apiText = await loreCall('getStoryText');
          if (apiText && fullText && apiText.length > fullText.length + 50) {
            showToast(`NovelAI has only part of this story loaded (${fullText.length.toLocaleString()} of ` +
              `${apiText.length.toLocaleString()} characters), so the headless editor shows that part. ` +
              'Reopen the story to load the rest.', null, 'warn');
          }
        } catch (e) { /* proxy not ready: nothing to compare against */ }

        if (fullText && fullText.length > 0) {
          console.log('[HeadlessSync] Full story loaded:', fullText.length, 'chars');
          window.powertool.storyTextSet(storyId, fullText, 'scroll-to-load');
          finishStoryLoad(storyId);
          await imageEmbed.loadStoryImages(state.currentStoryId);
          await imageEmbed.restoreFigures();
        } else {
          bus.emit('story:loading-phase', 'error', 'Could not load story text. Try again.');
        }
        return;
      }
    }, 1500);
  });

  function finishStoryLoad(storyId) {
    if (state.currentStoryId !== storyId) return;
    bus.emit('story:loading-phase', 'found', 'Story loaded!');
    setTimeout(() => {
      if (state.currentStoryId !== storyId) return;
      // Clear loading flags so overlay hides and editor shows
      state.storyTextLoaded = true;
      state.isDashboardActive = false;
      state._loadingStoryId = null;
      updateStorySelectorVisibility();
      hideLoadingBar();
      if (refs.editorSyncStatus) refs.editorSyncStatus.textContent = 'In Sync';
      if (refs.editorSyncIndicator) refs.editorSyncIndicator.className = 'status-indicator active';
      refreshLoreKeywords();
      bus.emit('headless:story-loaded', storyId);
    }, 500);
  }

  // Theme and NovelAI-look changes decide whether the sliders apply.
  bus.on('headless:theme-changed', updateEditorStyles);
  bus.on('headless:novelai-style', updateEditorStyles);

  // Webview <-> headless switch. Leaving: push pending headless edits so
  // NovelAI shows them. Entering: re-read, because the story may have been
  // edited or generated in webview mode meanwhile.
  bus.on('headless:mode-changed', async (headless) => {
    if (!state.currentStoryId || !state.storyTextLoaded) return;
    if (headless) await syncFromWebview(true);
    else await syncToWebview();
  });

  // Flush cache on story leave
  bus.on('headless:dashboard-state-changed', (isActive) => {
    if (isActive) flushCacheWrite();
  });

  // Streaming text from generation poll
  bus.on('headless:text-updated', handleStreamingText);

  // Generation complete: re-read text and marks, so the new AI text gets
  // NovelAI's own ai_text coloring.
  bus.on('headless:generation-complete', async () => {
    streamUndoNoted = false;
    if (refs.editorAiStatus) refs.editorAiStatus.textContent = 'Ready';
    if (refs.editorAiIndicator) refs.editorAiIndicator.className = 'status-indicator';
    await syncFromWebview(false);
  });
}
