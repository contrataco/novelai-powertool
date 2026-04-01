// headless-preamble.js — Preamble and Author's Note panel
//
// Preamble: stored in story_settings.preamble (not in the memory field).
// Author's Note: stored via memoryCall('setAuthorNote') — same as before.
// Both panels moved here from headless-memory-note.js.

import { state, bus } from './state.js';
import * as refs from './dom-refs.js';
import { memoryCall } from './lore-creator.js';
import { showToast } from './utils.js';

const TEMPLATES = [
  {
    name: 'Establish POV',
    text: 'The story is told in close third person, following a single protagonist. Thoughts and feelings are rendered intimately, but not in first person.',
  },
  {
    name: 'Genre: Dark Fantasy',
    text: 'Write in a dark, atmospheric style. Violence and moral ambiguity are expected. Avoid generic fantasy clichés. Favour specificity over vagueness.',
  },
  {
    name: 'Writing Style Guide',
    text: 'Use short, direct sentences. Prefer action verbs. Favour showing over telling. Avoid adverbs where possible. Keep dialogue natural and character-specific.',
  },
];

function _updateCounter(textarea, counterEl) {
  if (!textarea || !counterEl) return;
  const chars = (textarea.value || '').length;
  counterEl.textContent = `${chars} chars · ~${Math.round(chars / 4)} tokens`;
}

export function init() {
  const { preambleTextarea, preambleCounter, authorNoteTextarea, authorNoteCounter,
          authorNoteDepth, authorNoteDepthVal, preambleSaveBtn, editorPreambleBtn } = refs;

  // Toolbar button
  if (editorPreambleBtn) {
    editorPreambleBtn.addEventListener('click', () => {
      import('./headless-panels.js').then(p => {
        p.togglePanel(refs.headlessPreamblePanel, _load);
      });
    });
  }

  // Counters
  if (preambleTextarea) preambleTextarea.addEventListener('input', () => _updateCounter(preambleTextarea, preambleCounter));
  if (authorNoteTextarea) authorNoteTextarea.addEventListener('input', () => _updateCounter(authorNoteTextarea, authorNoteCounter));

  // Depth slider
  if (authorNoteDepth) {
    authorNoteDepth.addEventListener('input', () => {
      if (authorNoteDepthVal) authorNoteDepthVal.textContent = authorNoteDepth.value;
    });
  }

  // Save
  if (preambleSaveBtn) preambleSaveBtn.addEventListener('click', _save);

  // Templates
  const templateBtn = document.getElementById('preambleTemplateBtn');
  const templateMenu = document.getElementById('preambleTemplateMenu');
  if (templateBtn && templateMenu) {
    templateBtn.addEventListener('click', () => {
      templateMenu.classList.toggle('u-hidden');
      if (!templateMenu.classList.contains('u-hidden')) {
        templateMenu.innerHTML = '';
        TEMPLATES.forEach(tpl => {
          const item = document.createElement('div');
          item.className = 'preamble-template-item';
          item.textContent = tpl.name;
          item.onclick = () => {
            if (preambleTextarea) {
              preambleTextarea.value = tpl.text;
              _updateCounter(preambleTextarea, preambleCounter);
            }
            templateMenu.classList.add('u-hidden');
          };
          templateMenu.appendChild(item);
        });
      }
    });
    document.addEventListener('click', (e) => {
      if (!templateBtn.contains(e.target) && !templateMenu.contains(e.target)) {
        templateMenu.classList.add('u-hidden');
      }
    });
  }

  // Reset on story change
  bus.on('story:changed', () => {
    if (refs.preambleTextarea) refs.preambleTextarea.value = '';
    if (refs.authorNoteTextarea) refs.authorNoteTextarea.value = '';
  });
}

async function _load() {
  if (!state.currentStoryId) return;
  try {
    const [settings, authorNote] = await Promise.all([
      window.powertool.storySettingsGet(state.currentStoryId),
      memoryCall('getAuthorNote'),
    ]);
    if (refs.preambleTextarea) refs.preambleTextarea.value = settings?.preamble || '';
    if (refs.authorNoteTextarea) refs.authorNoteTextarea.value = authorNote || '';
    _updateCounter(refs.preambleTextarea, refs.preambleCounter);
    _updateCounter(refs.authorNoteTextarea, refs.authorNoteCounter);
  } catch (e) {
    console.error('[Preamble] Load error:', e);
  }
}

async function _save() {
  if (!state.currentStoryId) return;
  try {
    const preamble = refs.preambleTextarea?.value || '';
    const authorNote = refs.authorNoteTextarea?.value || '';
    const settings = await window.powertool.storySettingsGet(state.currentStoryId) || {};
    await Promise.all([
      window.powertool.storySettingsSet(state.currentStoryId, { ...settings, preamble }),
      memoryCall('setAuthorNote', authorNote),
    ]);
    showToast('Preamble & instructions saved');
  } catch (e) {
    console.error('[Preamble] Save error:', e);
    showToast('Save failed', 3000, 'error');
  }
}

// Called at generation time to inject preamble into memory context
export async function getPreamble() {
  if (!state.currentStoryId) return '';
  try {
    const settings = await window.powertool.storySettingsGet(state.currentStoryId) || {};
    return settings.preamble || '';
  } catch (e) { return ''; }
}
