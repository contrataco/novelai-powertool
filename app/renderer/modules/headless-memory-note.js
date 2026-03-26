// headless-memory-note.js — Memory and Author's Note panels

import * as refs from './dom-refs.js';
import { memoryCall } from './lore-creator.js';
import { showToast } from './utils.js';
import { setupPanelToggle } from './headless-panels.js';

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
    const note = await memoryCall('getAuthorNote');
    if (refs.headlessNoteInput) refs.headlessNoteInput.value = note || '';
  } catch (e) {
    console.error('[HeadlessSync] Failed to load author note:', e);
    if (refs.headlessNoteInput) refs.headlessNoteInput.value = '';
  }
}

async function saveNoteFromPanel() {
  const text = refs.headlessNoteInput?.value || '';
  try {
    await memoryCall('setAuthorNote', text);
    showToast("Author's note saved");
    refs.headlessNotePanel.style.display = 'none';
  } catch (e) {
    console.error('[HeadlessSync] Failed to save author note:', e);
    showToast("Failed to save author's note — proxy may not be loaded");
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
