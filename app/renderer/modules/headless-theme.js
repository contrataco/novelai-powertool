// headless-theme.js — Three switchable presentation themes for the headless editor.
//
// Themes are applied as CSS classes on the #editorContainer element.
// Stored per-story in story_settings.editorTheme.
// Scene break markers are converted to styled elements at render time.

import { state, bus } from './state.js';
import * as refs from './dom-refs.js';
import { showToast } from './utils.js';

const THEMES = ['manuscript', 'editorial', 'graphic-novel'];
const THEME_NAMES = { manuscript: 'Manuscript', editorial: 'Editorial', 'graphic-novel': 'Graphic Novel' };

// Scene break patterns — lines containing only these tokens get styled
const BREAK_PATTERNS = [/^---+$/, /^\*\s*\*\s*\*$/, /^#\s*#\s*#$/, /^✦\s*✦\s*✦$/];

let _currentTheme = 'manuscript';

/**
 * Set the active theme, persist to story settings, update DOM.
 */
export function setTheme(theme) {
  if (!THEMES.includes(theme)) return;
  _currentTheme = theme;

  const container = refs.editorContainer;
  if (container) {
    THEMES.forEach(t => container.classList.remove('theme-' + t));
    container.classList.add('theme-' + theme);
  }

  // Update toolbar button states
  ['manuscript', 'editorial', 'graphic-novel'].forEach(t => {
    const btn = document.getElementById('themeBtn-' + t);
    if (btn) btn.classList.toggle('active', t === theme);
  });

  // Persist
  if (state.currentStoryId) {
    _saveTheme(theme);
  }

  _renderSceneBreaks();
}

export function getTheme() { return _currentTheme; }

async function _saveTheme(theme) {
  try {
    const settings = await window.powertool.storySettingsGet(state.currentStoryId) || {};
    await window.powertool.storySettingsSet(state.currentStoryId, { ...settings, editorTheme: theme });
  } catch (e) {
    console.warn('[Theme] Could not save theme:', e);
  }
}

/**
 * Load the theme for the current story from story_settings.
 */
export async function loadTheme() {
  if (!state.currentStoryId) return;
  try {
    const settings = await window.powertool.storySettingsGet(state.currentStoryId) || {};
    setTheme(settings.editorTheme || 'manuscript');
  } catch (e) {
    setTheme('manuscript');
  }
}

/**
 * Scan the editor for scene break marker lines and replace them with
 * styled <div class="scene-break"> elements. Non-destructive: the
 * underlying text content is preserved as a data attribute.
 *
 * Call after syncFromWebview() or on theme change.
 */
export function _renderSceneBreaks() {
  const editor = refs.storyEditor;
  if (!editor) return;

  // First restore any previously styled breaks back to plain paragraphs
  editor.querySelectorAll('.scene-break[data-original]').forEach(el => {
    const p = document.createElement('p');
    p.textContent = el.dataset.original;
    el.replaceWith(p);
  });

  // Walk block-level children looking for break marker text
  Array.from(editor.children).forEach(child => {
    const text = (child.innerText || child.textContent || '').trim();
    if (BREAK_PATTERNS.some(p => p.test(text))) {
      const breakEl = document.createElement('div');
      breakEl.className = 'scene-break';
      breakEl.setAttribute('contenteditable', 'false');
      breakEl.dataset.original = child.innerText || text;
      child.replaceWith(breakEl);
    }
  });
}

export function init() {
  // Wire toolbar theme buttons (added in Task 8)
  ['manuscript', 'editorial', 'graphic-novel'].forEach(theme => {
    const btn = document.getElementById('themeBtn-' + theme);
    if (btn) btn.addEventListener('click', () => setTheme(theme));
  });

  // Load theme when story changes
  bus.on('story:changed', loadTheme);

  // Re-render scene breaks after sync
  bus.on('headless:synced-from-webview', _renderSceneBreaks);
}
