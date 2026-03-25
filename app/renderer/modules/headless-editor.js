// headless-editor.js — Core text sync, editor modes, metrics, customization

import { state, bus } from './state.js';
import * as refs from './dom-refs.js';
import { readStoryTextFromDOM } from './webview-polling.js';
import { applyDiff } from './diff.js';
import { showToast } from './utils.js';

const { webview, storyEditor } = refs;

let isSyncingToWebview = false;
let isSyncingFromWebview = false;
let lastKnownWebviewText = '';

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

      if (force) {
        storyEditor.innerText = text;
      } else {
        applyDiff(storyEditor, text);
      }

      if (refs.editorAiStatus) refs.editorAiStatus.textContent = 'Ready';
      if (refs.editorAiIndicator) refs.editorAiIndicator.className = 'status-indicator';
      if (refs.editorSyncStatus) refs.editorSyncStatus.textContent = 'In Sync';
      if (refs.editorSyncIndicator) refs.editorSyncIndicator.className = 'status-indicator active';

      updateStatusMetrics();

      lastKnownWebviewText = text;
      state.lastKnownStoryLength = text.length;
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
  const maxWidth = refs.headlessWidthSlider?.value || 850;

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
      editorWidth: 850
    };

    if (refs.headlessFontSizeSlider) refs.headlessFontSizeSlider.value = settings.fontSize;
    if (refs.headlessLineHeightSlider) refs.headlessLineHeightSlider.value = settings.lineHeight;
    if (refs.headlessWidthSlider) refs.headlessWidthSlider.value = settings.editorWidth;

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
    updateStatusMetrics();
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
  });

  // Typewriter mode scroll listeners
  storyEditor.addEventListener('input', () => {
    if (refs.editorContainer?.classList.contains('typewriter-mode')) scrollToSelection();
  });
  storyEditor.addEventListener('click', () => {
    if (refs.editorContainer?.classList.contains('typewriter-mode')) scrollToSelection();
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

  // Story change: initial sync + load customization
  bus.on('story:changed', async ({ storyTitle } = {}) => {
    console.log('[HeadlessSync] Story changed, performing initial sync');
    await syncFromWebview(true);
    if (refs.editorStoryTitle) refs.editorStoryTitle.textContent = storyTitle || 'Untitled Story';
    updateStatusMetrics();
    loadCustomizationFromStore();
  });

  // Streaming text from generation poll
  bus.on('headless:text-updated', handleStreamingText);

  // Generation complete
  bus.on('headless:generation-complete', () => {
    if (refs.editorAiStatus) refs.editorAiStatus.textContent = 'Ready';
    if (refs.editorAiIndicator) refs.editorAiIndicator.className = 'status-indicator';
  });
}
