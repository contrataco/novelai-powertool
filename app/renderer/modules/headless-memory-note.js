// headless-memory-note.js — Memory and Author's Note panels

import * as refs from './dom-refs.js';
import { memoryCall } from './lore-creator.js';
import { showToast } from './utils.js';
import { setupPanelToggle } from './headless-panels.js';

const { webview } = refs;

// --- Memory ---

async function loadMemoryToPanel() {
  try {
    const memory = await memoryCall('getMemory');
    if (refs.headlessMemoryInput) refs.headlessMemoryInput.value = memory || '';
  } catch (e) {
    console.error('[HeadlessSync] Failed to load memory:', e);
    if (refs.headlessMemoryInput) refs.headlessMemoryInput.value = '';
  }
}

async function saveMemoryFromPanel() {
  const text = refs.headlessMemoryInput?.value || '';
  try {
    await memoryCall('setMemory', text);
    showToast('Memory saved');
    refs.headlessMemoryPanel.style.display = 'none';
  } catch (e) {
    console.error('[HeadlessSync] Failed to save memory:', e);
    showToast('Failed to save memory — proxy may not be loaded');
  }
}

// --- Author's Note ---

async function loadNoteToPanel() {
  try {
    const note = await webview.executeJavaScript(`
      (function() {
        var textareas = document.querySelectorAll('textarea');
        for (var i = 0; i < textareas.length; i++) {
          var ph = (textareas[i].placeholder || '').toLowerCase();
          if (ph.includes('author') || ph.includes('note')) return textareas[i].value;
        }
        var labels = document.querySelectorAll('label, span, div');
        for (var j = 0; j < labels.length; j++) {
          var text = (labels[j].textContent || '').trim().toLowerCase();
          if (text.includes("author's note") || text === 'author note') {
            var parent = labels[j].parentElement;
            for (var k = 0; k < 5 && parent; k++) {
              var ta = parent.querySelector('textarea');
              if (ta) return ta.value;
              parent = parent.parentElement;
            }
          }
        }
        return null;
      })()
    `);
    if (refs.headlessNoteInput) refs.headlessNoteInput.value = note || '';
  } catch (e) {
    console.error('[HeadlessSync] Failed to load author note:', e);
    if (refs.headlessNoteInput) refs.headlessNoteInput.value = '';
  }
}

async function saveNoteFromPanel() {
  const text = refs.headlessNoteInput?.value || '';
  try {
    const escapedText = JSON.stringify(text);
    const success = await webview.executeJavaScript(`
      (function() {
        var targetTA = null;
        var textareas = document.querySelectorAll('textarea');
        for (var i = 0; i < textareas.length; i++) {
          var ph = (textareas[i].placeholder || '').toLowerCase();
          if (ph.includes('author') || ph.includes('note')) { targetTA = textareas[i]; break; }
        }
        if (!targetTA) {
          var labels = document.querySelectorAll('label, span, div');
          for (var j = 0; j < labels.length; j++) {
            var lt = (labels[j].textContent || '').trim().toLowerCase();
            if (lt.includes("author's note") || lt === 'author note') {
              var parent = labels[j].parentElement;
              for (var k = 0; k < 5 && parent; k++) {
                var ta = parent.querySelector('textarea');
                if (ta) { targetTA = ta; break; }
                parent = parent.parentElement;
              }
              if (targetTA) break;
            }
          }
        }
        if (!targetTA) return false;
        var setter = Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value').set;
        setter.call(targetTA, ${escapedText});
        targetTA.dispatchEvent(new Event('input', { bubbles: true }));
        targetTA.dispatchEvent(new Event('change', { bubbles: true }));
        return true;
      })()
    `);
    if (success) {
      showToast("Author's note saved");
      refs.headlessNotePanel.style.display = 'none';
    } else {
      showToast("Author's Note textarea not found in webview — open the sidebar first");
    }
  } catch (e) {
    console.error('[HeadlessSync] Failed to save author note:', e);
    showToast('Failed to save author note');
  }
}

// --- AI Settings (stub) ---

async function loadAiSettingsToPanel() {
  console.log('[HeadlessSync] AI settings panel opened (read-only stub)');
}

async function saveAiSettingsFromPanel() {
  showToast('AI generation settings must be configured in NovelAI. Use the webview toggle.');
  refs.headlessAiSettingsPanel.style.display = 'none';
}

// --- Init ---

export function init({ saveCustomizationToStore, flattenEditorText }) {
  setupPanelToggle(refs.editorMemoryBtn, refs.headlessMemoryPanel, loadMemoryToPanel);
  setupPanelToggle(refs.editorNoteBtn, refs.headlessNotePanel, loadNoteToPanel);
  setupPanelToggle(refs.editorSettingsBtn, refs.headlessAiSettingsPanel, loadAiSettingsToPanel);

  if (refs.headlessMemorySaveBtn) {
    refs.headlessMemorySaveBtn.addEventListener('click', () => saveMemoryFromPanel());
  }
  if (refs.headlessNoteSaveBtn) {
    refs.headlessNoteSaveBtn.addEventListener('click', () => saveNoteFromPanel());
  }
  if (refs.headlessAiSaveBtn) {
    refs.headlessAiSaveBtn.addEventListener('click', () => {
      saveAiSettingsFromPanel();
      if (saveCustomizationToStore) saveCustomizationToStore();
    });
  }
  if (refs.headlessAiFlattenBtn) {
    refs.headlessAiFlattenBtn.addEventListener('click', () => {
      if (confirm('Are you sure you want to remove ALL formatting from the editor? This cannot be undone.')) {
        if (flattenEditorText) flattenEditorText();
      }
    });
  }

  // Slider feedback for AI settings panel
  if (refs.headlessTempSlider) {
    refs.headlessTempSlider.addEventListener('input', () => {
      if (refs.headlessTempValue) refs.headlessTempValue.textContent = refs.headlessTempSlider.value;
    });
  }
  if (refs.headlessLengthSlider) {
    refs.headlessLengthSlider.addEventListener('input', () => {
      if (refs.headlessLengthValue) refs.headlessLengthValue.textContent = refs.headlessLengthSlider.value;
    });
  }
  if (refs.headlessRepSlider) {
    refs.headlessRepSlider.addEventListener('input', () => {
      if (refs.headlessRepValue) refs.headlessRepValue.textContent = refs.headlessRepSlider.value;
    });
  }
  if (refs.headlessRepRangeSlider) {
    refs.headlessRepRangeSlider.addEventListener('input', () => {
      if (refs.headlessRepRangeValue) refs.headlessRepRangeValue.textContent = refs.headlessRepRangeSlider.value;
    });
  }
}
