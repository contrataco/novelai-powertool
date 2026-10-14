// headless-generation.js — Generation trigger, undo/redo, AI actions

import { state, bus } from './state.js';
import * as refs from './dom-refs.js';
import { showToast } from './utils.js';
import { editorText } from './diff.js';

const { webview, storyEditor } = refs;

let _syncToWebview = null;
let _syncFromWebview = null;

export function init({ syncToWebview, syncFromWebview }) {
  _syncToWebview = syncToWebview;
  _syncFromWebview = syncFromWebview;

  if (refs.editorGenerateBtn) {
    refs.editorGenerateBtn.addEventListener('click', () => triggerGeneration());
  }

  // Clear generation indicator on completion
  bus.on('headless:generation-complete', () => {
    hideGenerationIndicator();
    storyGenerating(false);
  });
}

// --- Generation ---

export async function triggerGeneration() {
  if (state.isWaitingForGeneration) {
    console.log('[HeadlessSync] Generation already in progress, ignoring');
    return;
  }

  console.log('[HeadlessSync] Triggering AI generation');

  if (refs.editorAiStatus) refs.editorAiStatus.textContent = 'Generating...';
  if (refs.editorAiIndicator) refs.editorAiIndicator.className = 'status-indicator busy';

  showGenerationIndicator();

  // Give modules a chance to flush state before generation (e.g. memory auto-save)
  bus.emit('headless:before-generation');

  // Sync latest text to webview before triggering generation
  if (_syncToWebview) await _syncToWebview();
  state.isWaitingForGeneration = true;

  // NovelAI runs one generation at a time: hold background AI work back and
  // let any request already sent finish, so the story is not refused.
  if (refs.editorAiStatus) refs.editorAiStatus.textContent = 'Waiting for background AI...';
  await storyGenerating(true);
  if (refs.editorAiStatus) refs.editorAiStatus.textContent = 'Generating...';

  // Safety timeout: if generation doesn't complete within 60s, reset state
  const genTimeout = setTimeout(() => {
    if (state.isWaitingForGeneration) {
      console.warn('[HeadlessSync] Generation timeout (60s), resetting state');
      state.isWaitingForGeneration = false;
      storyGenerating(false);
      hideGenerationIndicator();
      if (refs.editorAiStatus) refs.editorAiStatus.textContent = 'Ready';
      if (refs.editorAiIndicator) refs.editorAiIndicator.className = 'status-indicator';
      if (_syncFromWebview) _syncFromWebview();
    }
  }, 60000);

  // Use self-removing listener to avoid accumulating stale listeners
  const clearGenTimeout = () => {
    clearTimeout(genTimeout);
    bus.off('headless:generation-complete', clearGenTimeout);
  };
  bus.on('headless:generation-complete', clearGenTimeout);

  try {
    const success = await webview.executeJavaScript(`
      (function() {
        var editor = document.querySelector('.ProseMirror');
        if (!editor) return false;
        editor.focus();

        var keyDown = new KeyboardEvent('keydown', {
          key: 'Enter',
          code: 'Enter',
          keyCode: 13,
          which: 13,
          ctrlKey: true,
          bubbles: true,
          cancelable: true
        });
        editor.dispatchEvent(keyDown);
        return true;
      })()
    `);

    if (success) {
      console.log('[HeadlessSync] Generation triggered via Ctrl+Enter');
    } else {
      console.warn('[HeadlessSync] ProseMirror editor not found in webview');
      state.isWaitingForGeneration = false;
      storyGenerating(false);
      hideGenerationIndicator();
    }
  } catch (e) {
    console.error('[HeadlessSync] Error triggering generation:', e);
    state.isWaitingForGeneration = false;
    storyGenerating(false);
    hideGenerationIndicator();
  }
}

/** Tell the main process the story is (not) generating; never throws. */
async function storyGenerating(on) {
  try { await window.powertool.novelaiStoryGenerating?.(on); } catch (e) { console.warn('[HeadlessSync] story-generating signal failed:', e); }
}

function setGenerateButtonBusy(busy) {
  const btn = refs.editorGenerateBtn;
  if (!btn) return;
  btn.disabled = busy;
  btn.textContent = busy ? 'Generating...' : 'Generate';
}

// Animated dots at the end of the story while a generation starts. They live
// in an overlay on #editorContainer, never inside the editor: a "..." element
// in the editor was read as a paragraph of story text and pushed to NovelAI
// just before the generation, so every generation began with "...".
let dotsTeardown = null;

function showGenerationIndicator() {
  setGenerateButtonBusy(true);
  const container = refs.editorContainer;
  if (!storyEditor || !container || dotsTeardown) return;

  const dots = document.createElement('div');
  dots.id = 'ai-typing-indicator';
  dots.className = 'ai-typing-indicator';
  dots.setAttribute('aria-hidden', 'true');
  for (let i = 0; i < 3; i++) dots.appendChild(document.createElement('span'));
  container.appendChild(dots);

  const place = () => {
    const box = container.getBoundingClientRect();
    const view = storyEditor.getBoundingClientRect();
    const end = endOfStoryRect();
    if (!end || end.bottom < view.top || end.top > view.bottom) { dots.style.visibility = 'hidden'; return; }
    dots.style.visibility = '';
    dots.style.left = `${Math.round(end.right - box.left + 6)}px`;
    dots.style.top = `${Math.round(end.top - box.top + (end.height - dots.offsetHeight) / 2)}px`;
  };

  // Gone the moment generated text shows up in the editor.
  const before = editorText(storyEditor);
  const observer = new MutationObserver(() => {
    if (editorText(storyEditor) !== before) hideDots();
    else place();
  });
  observer.observe(storyEditor, { childList: true, subtree: true, characterData: true });
  storyEditor.addEventListener('scroll', place);
  window.addEventListener('resize', place);
  dotsTeardown = () => {
    observer.disconnect();
    storyEditor.removeEventListener('scroll', place);
    window.removeEventListener('resize', place);
    dots.remove();
  };

  place();
  if (dots.style.visibility === 'hidden') {
    storyEditor.scrollTo({ top: storyEditor.scrollHeight, behavior: 'smooth' });
  }
}

/** Where the story's text ends on screen (images after it are skipped). */
function endOfStoryRect() {
  let block = storyEditor.lastElementChild;
  while (block && block.matches('figure[data-image-id]')) block = block.previousElementSibling;
  if (!block) return null;
  // The last character's box: a collapsed range at the end of a paragraph
  // has no rects in Chromium.
  const walker = document.createTreeWalker(block, NodeFilter.SHOW_TEXT);
  let last = null;
  for (let n = walker.nextNode(); n; n = walker.nextNode()) if (n.textContent.length) last = n;
  if (last) {
    const range = document.createRange();
    range.setStart(last, last.textContent.length - 1);
    range.setEnd(last, last.textContent.length);
    const rects = range.getClientRects();
    if (rects.length) return rects[rects.length - 1];
  }
  // An empty paragraph has no text to measure: use its first line.
  const r = block.getBoundingClientRect();
  const line = parseFloat(getComputedStyle(block).lineHeight) || 24;
  const pad = parseFloat(getComputedStyle(block).paddingLeft) || 0;
  return { left: r.left + pad, right: r.left + pad, top: r.top, bottom: r.top + line, height: line };
}

function hideDots() {
  if (dotsTeardown) { dotsTeardown(); dotsTeardown = null; }
}

export function hideGenerationIndicator() {
  setGenerateButtonBusy(false);
  hideDots();
}

// --- Undo / Redo ---

export async function triggerUndo() {
  console.log('[HeadlessSync] Triggering undo');
  try {
    await webview.executeJavaScript(`
      (function() {
        var editor = document.querySelector('.ProseMirror');
        if (!editor) return;
        editor.focus();
        var event = new KeyboardEvent('keydown', {
          key: 'z', code: 'KeyZ', keyCode: 90, which: 90,
          ctrlKey: true, bubbles: true, cancelable: true
        });
        editor.dispatchEvent(event);
      })()
    `);
    setTimeout(() => { if (_syncFromWebview) _syncFromWebview(true); }, 300);
  } catch (e) {
    console.error('[HeadlessSync] Undo failed:', e);
  }
}

export async function triggerRedo() {
  console.log('[HeadlessSync] Triggering redo');
  try {
    await webview.executeJavaScript(`
      (function() {
        var editor = document.querySelector('.ProseMirror');
        if (!editor) return;
        editor.focus();
        var event = new KeyboardEvent('keydown', {
          key: 'z', code: 'KeyZ', keyCode: 90, which: 90,
          ctrlKey: true, shiftKey: true, bubbles: true, cancelable: true
        });
        editor.dispatchEvent(event);
      })()
    `);
    setTimeout(() => { if (_syncFromWebview) _syncFromWebview(true); }, 300);
  } catch (e) {
    console.error('[HeadlessSync] Redo failed:', e);
  }
}

// --- AI Actions (Rewrite, Expand, Summarize, Shorten) ---

/**
 * Apply an AI text action to the current selection (or end of document for 'expand').
 * Uses the text-action IPC which calls callLLM directly — no command injection.
 * @param {'rewrite'|'expand'|'shorten'|'summarize'} type
 */
export async function triggerAiAction(type) {
  if (state.llmBusy) { showToast('AI is busy — wait for generation to finish', 2000); return; }

  const editor = refs.storyEditor;
  if (!editor) return;

  let selectedText = '';
  let selectionRange = null;

  if (type !== 'expand') {
    const sel = window.getSelection();
    if (!sel.rangeCount || sel.isCollapsed) {
      showToast('Select some text first', 2000);
      return;
    }
    selectionRange = sel.getRangeAt(0).cloneRange();
    selectedText = sel.toString().trim();
    if (!selectedText) { showToast('Select some text first', 2000); return; }
  } else {
    // Expand: use last 500 chars of the editor as context
    selectedText = editorText(editor).slice(-500).trim();
    if (!selectedText) { showToast('No story text to expand', 2000); return; }
  }

  // Show indicator
  state.llmBusy = true;
  if (refs.editorAiStatus) refs.editorAiStatus.textContent = _actionLabel(type) + '…';
  if (refs.editorAiIndicator) refs.editorAiIndicator.className = 'status-indicator busy';

  try {
    const result = await window.powertool.textAction(type, selectedText, state.currentStoryId);
    if (result.error) throw new Error(result.error);
    const output = (result.output || '').trim();
    if (!output) { showToast('No output received', 2000); return; }

    if (type === 'expand') {
      // Append to end of editor
      editor.focus();
      const range = document.createRange();
      range.selectNodeContents(editor);
      range.collapse(false);
      const sel = window.getSelection();
      sel.removeAllRanges();
      sel.addRange(range);
      document.execCommand('insertText', false, '\n' + output);
    } else if (selectionRange) {
      // Replace selection
      const sel = window.getSelection();
      sel.removeAllRanges();
      sel.addRange(selectionRange);
      document.execCommand('insertText', false, output);
    }

    showToast(`${_actionLabel(type)} applied`);
    if (_syncToWebview) await _syncToWebview();

  } catch (e) {
    console.error('[Generation] AI action error:', e);
    showToast(`${_actionLabel(type)} failed`, 3000, 'error');
  } finally {
    state.llmBusy = false;
    if (refs.editorAiStatus) refs.editorAiStatus.textContent = 'Ready';
    if (refs.editorAiIndicator) refs.editorAiIndicator.className = 'status-indicator';
  }
}

function _actionLabel(type) {
  return { rewrite: 'Rewrite', expand: 'Expand', shorten: 'Shorten', summarize: 'Summarize' }[type] || type;
}

function _getCaretOffset(root, node, offset) {
  let charOffset = 0;
  const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT, null, false);
  let current;
  while ((current = walker.nextNode())) {
    if (current === node) { charOffset += offset; break; }
    charOffset += current.textContent.length;
  }
  return charOffset;
}
