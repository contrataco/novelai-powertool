// headless-generation.js — Generation trigger, undo/redo, AI actions

import { state, bus } from './state.js';
import * as refs from './dom-refs.js';
import { showToast } from './utils.js';

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

export async function triggerAiAction(type) {
  const selection = window.getSelection();
  const selectedText = selection.toString();

  if (!selectedText && type !== 'expand') {
    showToast('Please select some text first.');
    return;
  }

  showToast(`AI is ${type}ing...`, 3000);

  try {
    if (_syncToWebview) await _syncToWebview();

    const label = type === 'rewrite' ? 'Rewrite' : type === 'summarize' ? 'Summarize' : type === 'expand' ? 'Expand' : 'Shorten';
    const commandText = `\n[ ${label} the following: ${selectedText} ]\n`;

    await webview.executeJavaScript(`
      (function() {
        var editor = document.querySelector('.ProseMirror');
        var view = editor && editor.pmViewDesc && editor.pmViewDesc.view;
        if (!view) return false;
        var tr = view.state.tr;
        tr.insertText(${JSON.stringify(commandText)});
        view.dispatch(tr);
        return true;
      })()
    `);

    triggerGeneration();
  } catch (e) {
    console.error(`[HeadlessSync] AI Action ${type} failed:`, e);
    showToast(`Failed to ${type}.`);
  }
}
