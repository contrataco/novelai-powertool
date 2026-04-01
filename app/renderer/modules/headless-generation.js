// headless-generation.js — Generation trigger, undo/redo, AI actions

import { state, bus } from './state.js';
import * as refs from './dom-refs.js';
import { showToast } from './utils.js';
import { mergeRanges } from './diff.js';

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

  // Safety timeout: if generation doesn't complete within 60s, reset state
  const genTimeout = setTimeout(() => {
    if (state.isWaitingForGeneration) {
      console.warn('[HeadlessSync] Generation timeout (60s), resetting state');
      state.isWaitingForGeneration = false;
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
      hideGenerationIndicator();
    }
  } catch (e) {
    console.error('[HeadlessSync] Error triggering generation:', e);
    state.isWaitingForGeneration = false;
    hideGenerationIndicator();
  }
}

function showGenerationIndicator() {
  if (!storyEditor) return;
  if (document.getElementById('ai-typing-indicator')) return;

  const indicator = document.createElement('span');
  indicator.id = 'ai-typing-indicator';
  indicator.className = 'ai-typing-indicator';
  indicator.textContent = '...';
  storyEditor.appendChild(indicator);
  indicator.scrollIntoView({ behavior: 'smooth', block: 'end' });
}

export function hideGenerationIndicator() {
  const indicator = document.getElementById('ai-typing-indicator');
  if (indicator) indicator.remove();
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
    selectedText = (editor.innerText || '').slice(-500).trim();
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

    // Track new text as AI-generated range
    const newStart = selectionRange
      ? _getCaretOffset(editor, selectionRange.startContainer, selectionRange.startOffset)
      : (editor.innerText || '').length - output.length;
    if (newStart >= 0) {
      state.aiTextRanges = mergeRanges([
        ...state.aiTextRanges,
        { start: newStart, end: newStart + output.length },
      ]);
    }
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
