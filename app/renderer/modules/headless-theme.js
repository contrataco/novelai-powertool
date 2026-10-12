// headless-theme.js - Switchable presentation themes for the headless editor.
//
// Themes are applied as CSS classes on the #editorContainer element.
// Stored per-story in story_settings.editorTheme.
// Scene break markers are converted to styled elements at render time.
//
// The default, 'novelai', copies NovelAI's own look: font, size, line
// spacing, paragraph indent and spacing, and the text-origin colors, read
// from the live NovelAI page (NovelAI keeps its theme server-side, so there
// is nothing to read but computed styles). The values become CSS variables
// on the container and are cached so the look is right before the page loads.

import { state, bus } from './state.js';
import * as refs from './dom-refs.js';
import { showToast } from './utils.js';
import { injectedPlain, probeTheme } from './nai-doc.js';

const THEMES = ['novelai', 'manuscript', 'editorial', 'graphic-novel'];
const THEME_NAMES = { novelai: 'NovelAI', manuscript: 'Manuscript', editorial: 'Editorial', 'graphic-novel': 'Graphic Novel' };
const DEFAULT_THEME = 'novelai';
const STYLE_CACHE_KEY = 'powertool.novelaiStyle';

// Scene break patterns — lines containing only these tokens get styled
const BREAK_PATTERNS = [/^---+$/, /^\*\s*\*\s*\*$/, /^#\s*#\s*#$/, /^✦\s*✦\s*✦$/];

let _currentTheme = DEFAULT_THEME;

/**
 * Set the active theme, persist to story settings, update DOM.
 * `chosen` marks an explicit pick (button or shortcut); a story without one
 * follows the default, so changing the default reaches stories that only
 * ever had the old default saved.
 */
export function setTheme(theme, chosen = false) {
  if (!THEMES.includes(theme)) return;
  _currentTheme = theme;

  const container = refs.editorContainer;
  if (container) {
    THEMES.forEach(t => container.classList.remove('theme-' + t));
    container.classList.add('theme-' + theme);
  }

  // Update toolbar button states
  THEMES.forEach(t => {
    const btn = document.getElementById('themeBtn-' + t);
    if (btn) btn.classList.toggle('active', t === theme);
  });

  // Persist
  if (state.currentStoryId) {
    _saveTheme(theme, chosen);
  }

  _renderSceneBreaks();
  bus.emit('headless:theme-changed', theme);
}

export function getTheme() { return _currentTheme; }

async function _saveTheme(theme, chosen) {
  try {
    const settings = await window.powertool.storySettingsGet(state.currentStoryId) || {};
    await window.powertool.storySettingsSet(state.currentStoryId, {
      ...settings,
      editorTheme: theme,
      ...(chosen ? { editorThemeChosen: true } : {}),
    });
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
    setTheme(settings.editorThemeChosen ? (settings.editorTheme || DEFAULT_THEME) : DEFAULT_THEME);
  } catch (e) {
    setTheme(DEFAULT_THEME);
  }
}

// --- NovelAI look ---

/** CSS variables for the 'novelai' theme from a probeTheme() result. */
function applyNovelaiStyle(s) {
  const c = refs.editorContainer;
  if (!c || !s) return;
  const set = (k, v) => { if (v !== undefined && v !== null && v !== '') c.style.setProperty(k, String(v)); };
  // NovelAI serves Source Sans Pro as a web font; Source Sans 3 is its
  // successor and ships with the app, so it is the stand-in.
  const family = String(s.fontFamily || '').replace(/("?)Source Sans Pro\1/, '"Source Sans Pro", "Source Sans 3"');
  set('--nai-font', family);
  if (s.fontSize > 0) set('--nai-size', `${s.fontSize}px`);
  if (s.lineHeight > 0) set('--nai-line-height', Math.round(s.lineHeight * 100) / 100);
  set('--nai-color', s.color);
  set('--nai-indent', s.textIndent);
  set('--nai-para-gap', s.paragraphGap);
  if (s.background && s.background !== 'rgba(0, 0, 0, 0)') set('--nai-bg', s.background);
  const m = s.marks || {};
  set('--nai-user', m.userText?.color);
  set('--nai-ai', m.aiText?.color);
  set('--nai-edit', m.editText?.color);
  set('--nai-prompt', m.promptText?.color);
  set('--nai-script', m.scriptText?.color);
  set('--nai-dialogue', m.dialogue?.color);
  set('--nai-dialogue-style', m.dialogue?.fontStyle);
  set('--nai-highlight', m.highlight?.background);
  set('--nai-link', m.link?.color);
  bus.emit('headless:novelai-style', s);
}

/** NovelAI's look as last read, or null. */
export function getNovelaiStyle() {
  try { return JSON.parse(localStorage.getItem(STYLE_CACHE_KEY) || 'null'); } catch { return null; }
}

/**
 * Read NovelAI's current look from the webview and apply it. Quietly keeps
 * the cached look when the editor is not on the page.
 */
export async function refreshNovelaiStyle() {
  if (!refs.webview) return;
  let s = null;
  try { s = await refs.webview.executeJavaScript(injectedPlain(probeTheme)); } catch { /* page not ready */ }
  if (!s) return;
  try { localStorage.setItem(STYLE_CACHE_KEY, JSON.stringify(s)); } catch { /* cache is a convenience */ }
  applyNovelaiStyle(s);
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
  // Wire toolbar theme buttons
  THEMES.forEach(theme => {
    const btn = document.getElementById('themeBtn-' + theme);
    if (btn) btn.addEventListener('click', () => setTheme(theme, true));
  });

  // NovelAI look: cached copy now, the live one once a story is loaded.
  applyNovelaiStyle(getNovelaiStyle());
  bus.on('headless:story-loaded', refreshNovelaiStyle);
  bus.on('headless:mode-changed', (headless) => { if (headless) refreshNovelaiStyle(); });

  // Load theme when story changes
  bus.on('story:changed', loadTheme);

  // Re-render scene breaks after sync
  bus.on('headless:synced-from-webview', _renderSceneBreaks);
}
