// headless-editor.js — Core text sync, editor modes, metrics, customization

import { state, bus } from './state.js';
import * as refs from './dom-refs.js';
import { readStoryTextFromDOM } from './webview-polling.js';
import { loreCall, switchPanelTab, refreshLoreKeywords } from './lore-creator.js';
import { updateVisibility as updateStorySelectorVisibility } from './story-selector.js';
import { applyDiff, annotateEditor, mergeRanges, shiftRangesAfterEdit, diffText } from './diff.js';
import { showToast } from './utils.js';
import * as imageEmbed from './headless-image-embed.js';

const { webview, storyEditor } = refs;

let isSyncingToWebview = false;
let isSyncingFromWebview = false;
let lastKnownWebviewText = '';

// Annotation tracking
let textBeforeGeneration = '';   // snapshot before generation starts (to compute AI range)
let pendingGenerationSync = false;
let annotationTimeout = null;
let lastEditorTextForAnnotation = '';

function scheduleAnnotation() {
  if (annotationTimeout) clearTimeout(annotationTimeout);
  annotationTimeout = setTimeout(() => {
    if (storyEditor) annotateEditor(storyEditor, state.aiTextRanges, state.loreKeywords);
    annotationTimeout = null;
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
    window.powertool.storyTextSet(state.currentStoryId, storyEditor.innerText || '', 'editor');
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

// --- Sync Functions ---

/**
 * Fetch text from NovelAI's ProseMirror and update the native editor.
 * @param {boolean} force - If true, replaces entire content without diffing.
 */
export async function syncFromWebview(force = false) {
  if (isSyncingToWebview) return;
  isSyncingFromWebview = true;

  try {
    const text = await readStoryTextFromDOM();
    if (text !== null && text !== storyEditor.innerText) {
      console.log('[HeadlessSync] Syncing text from webview');

      const isPostGen = pendingGenerationSync;
      pendingGenerationSync = false;

      if (force) {
        storyEditor.innerText = text;
      } else {
        const diff = applyDiff(storyEditor, text);
        // Track newly generated AI text range
        if (isPostGen && diff.added.length > 0) {
          const newRange = { start: diff.prefixLen, end: diff.prefixLen + diff.added.length };
          state.aiTextRanges = mergeRanges([...state.aiTextRanges, newRange]);
        }
      }

      if (refs.editorAiStatus) refs.editorAiStatus.textContent = 'Ready';
      if (refs.editorAiIndicator) refs.editorAiIndicator.className = 'status-indicator';
      if (refs.editorSyncStatus) refs.editorSyncStatus.textContent = 'In Sync';
      if (refs.editorSyncIndicator) refs.editorSyncIndicator.className = 'status-indicator active';

      updateStatusMetrics();

      lastKnownWebviewText = text;
      lastEditorTextForAnnotation = text;
      state.lastKnownStoryLength = text.length;

      // Update cache
      debouncedCacheWrite(text, state._lastTextReadSource || 'webview');

      // Re-annotate after sync
      scheduleAnnotation();
      await imageEmbed.restoreFigures();
      bus.emit('headless:synced-from-webview');
    }
  } catch (e) {
    console.error('[HeadlessSync] Error syncing from webview:', e);
  } finally {
    isSyncingFromWebview = false;
  }
}

/**
 * Push native editor text into NovelAI's ProseMirror.
 */
export async function syncToWebview() {
  if (isSyncingFromWebview) return;
  isSyncingToWebview = true;

  try {
    imageEmbed.stripFigures();
    const text = storyEditor.innerText;
    if (text === lastKnownWebviewText) return;

    console.log('[HeadlessSync] Syncing text to webview');
    if (refs.editorSyncStatus) refs.editorSyncStatus.textContent = 'Syncing...';
    if (refs.editorSyncIndicator) refs.editorSyncIndicator.className = 'status-indicator busy';

    // Escape text for injection into executeJavaScript
    const escapedText = JSON.stringify(text);
    const success = await webview.executeJavaScript(`
      (function() {
        var editor = document.querySelector('.ProseMirror');
        if (!editor) return false;

        var view = editor.pmViewDesc && editor.pmViewDesc.view;
        if (view && view.state && view.state.schema) {
          try {
            // Build paragraph-aware document to preserve ProseMirror structure
            var schema = view.state.schema;
            var lines = ${escapedText}.split('\\n');
            var paragraphs = lines.map(function(line) {
              if (!line) return schema.nodes.paragraph.create();
              return schema.nodes.paragraph.create(null, [schema.text(line)]);
            });
            var newDoc = schema.nodes.doc.create(null, paragraphs);
            var tr = view.state.tr.replaceWith(0, view.state.doc.content.size, newDoc.content);
            view.dispatch(tr);
            return true;
          } catch(e) {
            console.error('[PowerToolSync] PM paragraph replace error:', e);
          }
        }

        // Fallback: direct innerText + input event (loses PM state but works)
        editor.innerText = ${escapedText};
        editor.dispatchEvent(new Event('input', { bubbles: true }));
        editor.dispatchEvent(new Event('change', { bubbles: true }));
        return true;
      })()
    `);

    if (success) {
      lastKnownWebviewText = text;
      if (refs.editorSyncStatus) refs.editorSyncStatus.textContent = 'In Sync';
      if (refs.editorSyncIndicator) refs.editorSyncIndicator.className = 'status-indicator active';
    }
  } catch (e) {
    console.error('[HeadlessSync] Error syncing to webview:', e);
  } finally {
    isSyncingToWebview = false;
  }
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
  const wasHidden = wvContainer && wvContainer.style.display !== 'block';
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
      console.log('[HeadlessSync] Full story loaded:', (storyEditor.innerText || '').length, 'chars');
    }

    if (refs.editorSyncStatus) refs.editorSyncStatus.textContent = 'In Sync';
    if (refs.editorSyncIndicator) refs.editorSyncIndicator.className = 'status-indicator active';
  } catch (e) {
    console.error('[HeadlessSync] Scroll-to-load error:', e);
    if (refs.editorSyncStatus) refs.editorSyncStatus.textContent = 'Partial Load';
  } finally {
    // Restore webview container to hidden
    if (wasHidden && wvContainer) {
      wvContainer.style.display = 'none';
      wvContainer.style.position = '';
      wvContainer.style.left = '';
      wvContainer.style.width = '';
      wvContainer.style.height = '';
      wvContainer.style.opacity = '';
      wvContainer.style.pointerEvents = '';
    }
  }
}

// --- Status Metrics ---

export function updateStatusMetrics() {
  if (!storyEditor) return;
  const text = storyEditor.innerText || '';
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

  const fontSize = refs.headlessFontSizeSlider?.value || 16;
  const lineHeight = refs.headlessLineHeightSlider?.value || 1.8;
  const maxWidth = refs.headlessWidthSlider?.value || 1100;

  storyEditor.style.fontSize = `${fontSize}px`;
  storyEditor.style.lineHeight = lineHeight;
  storyEditor.style.maxWidth = `${maxWidth}px`;

  if (refs.headlessFontSizeValue) refs.headlessFontSizeValue.textContent = `${fontSize}px`;
  if (refs.headlessLineHeightValue) refs.headlessLineHeightValue.textContent = lineHeight;
  if (refs.headlessWidthValue) refs.headlessWidthValue.textContent = `${maxWidth}px`;
}

export async function saveCustomizationToStore() {
  const settings = {
    fontSize: refs.headlessFontSizeSlider?.value,
    lineHeight: refs.headlessLineHeightSlider?.value,
    editorWidth: refs.headlessWidthSlider?.value
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
  const text = storyEditor.innerText;
  storyEditor.innerText = text;
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

export function handleStreamingText(text) {
  if (!storyEditor || isSyncingToWebview) return;
  isSyncingFromWebview = true;
  try {
    applyDiff(storyEditor, text);
    lastKnownWebviewText = text;
    lastEditorTextForAnnotation = text;
    updateStatusMetrics();
    // Keep last-paragraph indicator current during streaming
    scheduleAnnotation();
  } finally {
    isSyncingFromWebview = false;
  }
}

// --- Init: Editor input listeners, story change, customization sliders ---

export function init() {
  if (!storyEditor) return;

  // Debounced sync to webview on input
  let syncTimeout = null;
  storyEditor.addEventListener('input', () => {
    if (isSyncingFromWebview) return;
    if (syncTimeout) clearTimeout(syncTimeout);
    syncTimeout = setTimeout(() => {
      syncToWebview();
    }, 500);
    updateStatusMetrics();

    // Shift AI text ranges to account for user edits
    if (state.aiTextRanges.length > 0 && lastEditorTextForAnnotation) {
      const currentText = storyEditor.innerText;
      const diff = diffText(lastEditorTextForAnnotation, currentText);
      if (diff.added.length !== diff.removed.length) {
        const delta = diff.added.length - diff.removed.length;
        state.aiTextRanges = shiftRangesAfterEdit(state.aiTextRanges, diff.prefixLen, delta);
      }
      lastEditorTextForAnnotation = currentText;
    }

    scheduleAnnotation();
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

  // Bold/Italic/Underline toolbar buttons
  if (refs.editorBoldBtn) {
    refs.editorBoldBtn.addEventListener('click', () => { document.execCommand('bold'); syncToWebview(); });
  }
  if (refs.editorItalicBtn) {
    refs.editorItalicBtn.addEventListener('click', () => { document.execCommand('italic'); syncToWebview(); });
  }
  if (refs.editorUnderlineBtn) {
    refs.editorUnderlineBtn.addEventListener('click', () => { document.execCommand('underline'); syncToWebview(); });
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
      if (refs.headlessFontSizeValue) refs.headlessFontSizeValue.textContent = `${refs.headlessFontSizeSlider.value}px`;
      updateEditorStyles();
    });
  }
  if (refs.headlessLineHeightSlider) {
    refs.headlessLineHeightSlider.addEventListener('input', () => {
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
    if ((storyEditor.innerText || '').length < 10) {
      console.log('[HeadlessSync] Pre-filling editor with cached text:', cached.char_count, 'chars');
      storyEditor.innerText = cached.text;
      lastKnownWebviewText = cached.text;
      updateStatusMetrics();
    }
  });

  // Clear annotation state on story switch
  bus.on('story:changed', () => {
    state.aiTextRanges = [];
    pendingGenerationSync = false;
    lastEditorTextForAnnotation = '';
  });

  // Story change: keep overlay visible with loading status until text is ready
  bus.on('story:changed', async ({ storyTitle } = {}) => {
    const storyId = state.currentStoryId;
    console.log('[HeadlessSync] Story changed:', storyId);
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
        const partialText = await readStoryTextFromDOM();
        if (partialText && partialText.length > 0) {
          console.log('[HeadlessSync] Timeout — using partial text:', partialText.length, 'chars');
          storyEditor.innerText = partialText;
          lastKnownWebviewText = partialText;
          updateStatusMetrics();
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

        // Now read the full text — try Script API first, then DOM
        let fullText = '';
        try {
          fullText = await loreCall('getStoryText');
          console.log('[HeadlessSync] Script API text after scroll:', (fullText || '').length, 'chars');
        } catch(e) {}

        if (!fullText || fullText.length < 100) {
          fullText = await readStoryTextFromDOM();
          console.log('[HeadlessSync] DOM text after scroll:', (fullText || '').length, 'chars');
        }

        if (fullText && fullText.length > 0) {
          console.log('[HeadlessSync] Full story loaded:', fullText.length, 'chars');
          storyEditor.innerText = fullText;
          lastKnownWebviewText = fullText;
          updateStatusMetrics();
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
    }, 500);
  }

  // Flush cache on story leave
  bus.on('headless:dashboard-state-changed', (isActive) => {
    if (isActive) flushCacheWrite();
  });

  // Streaming text from generation poll
  bus.on('headless:text-updated', handleStreamingText);

  // Generation complete — re-read, cache, and mark AI text
  bus.on('headless:generation-complete', async () => {
    if (refs.editorAiStatus) refs.editorAiStatus.textContent = 'Ready';
    if (refs.editorAiIndicator) refs.editorAiIndicator.className = 'status-indicator';
    // Flag the next syncFromWebview as post-generation so it records AI text ranges
    pendingGenerationSync = true;
    await syncFromWebview(false);
  });
}
