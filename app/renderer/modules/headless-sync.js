// headless-sync.js — Orchestrator for headless mode sub-modules
//
// This file wires together all headless sub-modules and provides the
// single keyboard shortcut dispatcher. All logic lives in sub-modules.

import { state, bus } from './state.js';
import * as refs from './dom-refs.js';
import { updateVisibility as updateStorySelectorVisibility } from './story-selector.js';
import { showToast } from './utils.js';

import * as editor from './headless-editor.js';
import * as generation from './headless-generation.js';
import * as panels from './headless-panels.js';
import * as memoryNote from './headless-memory-note.js';
import * as lorePanel from './headless-lore-panel.js';
import * as commandPalette from './headless-command-palette.js';
import * as autocomplete from './headless-autocomplete.js';
import * as misc from './headless-misc.js';
import * as imageEmbed from './headless-image-embed.js';
import * as theme from './headless-theme.js';
import * as preamble from './headless-preamble.js';
import * as contextMenu from './context-menu.js';
import * as paragraphActions from './headless-paragraph-actions.js';
import * as symbols from './headless-symbols.js';

// Re-export sync functions for use by webview-polling.js and other modules
export const syncFromWebview = editor.syncFromWebview;
export const syncToWebview = editor.syncToWebview;
export const updateStatusMetrics = editor.updateStatusMetrics;
export const triggerGeneration = generation.triggerGeneration;
export const triggerUndo = generation.triggerUndo;
export const triggerRedo = generation.triggerRedo;

/**
 * Initialize all headless mode sub-modules.
 */
export function init() {
  if (!refs.storyEditor) return;

  // Shared dependency objects
  const editorDeps = {
    syncToWebview: editor.syncToWebview,
    syncFromWebview: editor.syncFromWebview,
    flattenEditorText: editor.flattenEditorText,
    toggleFocusMode: editor.toggleFocusMode,
    toggleTypewriterMode: editor.toggleTypewriterMode,
    toggleReadOnlyMode: editor.toggleReadOnlyMode,
    saveCustomizationToStore: editor.saveCustomizationToStore,
    updateStorySelectorVisibility,
    triggerGeneration: generation.triggerGeneration,
    triggerUndo: editor.undoLocal,
    triggerRedo: editor.redoLocal,
    triggerAiAction: generation.triggerAiAction,
    toggleSearchBar: misc.toggleSearchBar,
    showStoryStats: misc.showStoryStats,
    showHelpDialog: misc.showHelpDialog,
  };

  // Initialize sub-modules (order matters for some)
  editor.init();
  panels.init();
  generation.init({ syncToWebview: editor.syncToWebview, syncFromWebview: editor.syncFromWebview });
  memoryNote.init({ saveCustomizationToStore: editor.saveCustomizationToStore, flattenEditorText: editor.flattenEditorText });
  lorePanel.init();
  commandPalette.init(editorDeps);
  autocomplete.init({ syncToWebview: editor.syncToWebview });
  misc.init(editorDeps);
  imageEmbed.init({ syncToWebview: editor.syncToWebview });
  theme.init();
  preamble.init();
  paragraphActions.init({ syncToWebview: editor.syncToWebview });
  symbols.init({ syncToWebview: editor.syncToWebview });

  // Context menu
  contextMenu.init({
    generate: generation.triggerGeneration,
    undo: editor.undoLocal,
    redo: editor.redoLocal,
    rewrite: () => generation.triggerAiAction('rewrite'),
    expand: () => generation.triggerAiAction('expand'),
    summarize: () => generation.triggerAiAction('summarize'),
    symbols: (x, y) => symbols.openSymbolPicker(x, y),
  });

  // Undo/Redo under the story: same history as Ctrl+Z / Ctrl+Shift+Z
  refs.editorUndoBtn?.addEventListener('click', () => editor.undoLocal());
  refs.editorRedoBtn?.addEventListener('click', () => editor.redoLocal());

  // Dashboard state changes
  bus.on('headless:dashboard-state-changed', () => {
    updateStorySelectorVisibility();
  });

  const isOtherTextField = (t) => !!t && t !== refs.storyEditor && !refs.storyEditor?.contains(t) &&
    (t.tagName === 'INPUT' || t.tagName === 'TEXTAREA' || t.isContentEditable);

  // --- Single keyboard shortcut dispatcher ---
  window.addEventListener('keydown', (e) => {
    if (e.metaKey || e.ctrlKey) {
      if (e.key === 's') {
        e.preventDefault();
        editor.syncToWebview();
        showToast('Story synced with NovelAI');
      } else if (e.key === 'Enter') {
        e.preventDefault();
        generation.triggerGeneration();
      } else if ((e.key === 'z' || e.key === 'Z' || e.key === 'y') && isOtherTextField(e.target)) {
        // Other text boxes keep the browser's own undo.
      } else if ((e.key === 'z' || e.key === 'Z') && !e.shiftKey) {
        e.preventDefault();
        editor.undoLocal();
      } else if ((e.key === 'z' || e.key === 'Z') && e.shiftKey) {
        e.preventDefault();
        editor.redoLocal();
      } else if (e.key === 'y') {
        e.preventDefault();
        editor.redoLocal();
      } else if (e.key === 'F' && e.shiftKey) {
        e.preventDefault();
        editor.toggleFocusMode();
      } else if (e.key === 'f' && !e.shiftKey) {
        e.preventDefault();
        misc.toggleSearchBar();
      } else if (e.key === 'p' && e.shiftKey) {
        e.preventDefault();
        commandPalette.showCommandPalette();
      } else if (e.shiftKey && e.code === 'Digit0') {
        e.preventDefault();
        theme.setTheme('novelai', true);
      } else if (e.shiftKey && (e.key === '1' || e.code === 'Digit1')) {
        e.preventDefault();
        theme.setTheme('manuscript', true);
      } else if (e.shiftKey && (e.key === '2' || e.code === 'Digit2')) {
        e.preventDefault();
        theme.setTheme('editorial', true);
      } else if (e.shiftKey && (e.key === '3' || e.code === 'Digit3')) {
        e.preventDefault();
        theme.setTheme('graphic-novel', true);
      } else if (e.shiftKey && e.key === 'L') {
        e.preventDefault();
        panels.togglePanel(refs.headlessLorePanel);
      } else if (e.shiftKey && e.key === 'M') {
        e.preventDefault();
        panels.togglePanel(refs.headlessMemoryPanel);
      } else if (e.shiftKey && e.key === 'T') {
        e.preventDefault();
        editor.toggleTypewriterMode?.();
      } else if (e.shiftKey && e.key === 'I') {
        e.preventDefault();
        panels.togglePanel(refs.headlessPreamblePanel);
      }
    } else if (e.key === 'Enter' && e.shiftKey && !e.ctrlKey && !e.metaKey) {
      // Only trigger from body — storyEditor uses Ctrl+Enter so Shift+Enter remains available
      // for soft line breaks (contenteditable default behavior)
      if (document.activeElement === document.body) {
        e.preventDefault();
        generation.triggerGeneration();
      }
    } else if (e.key === '/') {
      const selection = window.getSelection();
      if (selection.rangeCount > 0) {
        const range = selection.getRangeAt(0);
        const textBefore = range.startContainer.textContent.substring(0, range.startOffset);
        if ((textBefore === '' || textBefore.endsWith(' ')) && document.activeElement === refs.storyEditor) {
          e.preventDefault();
          commandPalette.showCommandPalette();
        }
      }
    }
  });
}
