// suggestions.js — Suggestions popover, type filters, insertion, badge

import { state } from './state.js';
import { syncToWebview } from './headless-sync.js';
import {
  webview, storyEditor,
  suggestionsBtn, suggestionsBadge, suggestionsPopover,
  popoverCloseBtn, popoverRegenBtn, popoverSettingsBtn, popoverSettings,
  popoverSuggestionsContainer, popoverLoading, popoverStatus,
  suggestionsEnabledCheckbox, suggestionsAutoShowCheckbox,
} from './dom-refs.js';

// Load popover settings from localStorage
const popoverPrefs = JSON.parse(localStorage.getItem('suggestionsPopoverPrefs') || '{}');
const activeTypeFilters = new Set(popoverPrefs.typeFilters || ['action', 'dialogue', 'narrative']);

function savePopoverPrefs() {
  localStorage.setItem('suggestionsPopoverPrefs', JSON.stringify({
    enabled: suggestionsEnabledCheckbox.checked,
    autoShow: suggestionsAutoShowCheckbox.checked,
    typeFilters: Array.from(activeTypeFilters),
  }));
}

function openPopover() {
  suggestionsPopover.classList.remove('hidden');
  // Clear badge on open
  state.suggestionsBadgeCount = 0;
  suggestionsBadge.classList.add('hidden');
}

function closePopover() {
  suggestionsPopover.classList.add('hidden');
}

/**
 * Render suggestion cards in the popover with type filtering
 */
export function renderSuggestions(suggestions) {
  popoverSuggestionsContainer.innerHTML = '';

  if (!suggestions || suggestions.length === 0) {
    popoverSuggestionsContainer.innerHTML = '<div class="suggestions-empty">Suggestions will appear after the AI responds.</div>';
    return;
  }

  if (!suggestionsEnabledCheckbox.checked) {
    popoverSuggestionsContainer.innerHTML = '<div class="suggestions-empty">Suggestions are disabled.</div>';
    return;
  }

  const filtered = suggestions.filter(s => activeTypeFilters.has(s.type || 'mixed') || s.type === 'mixed');

  if (filtered.length === 0) {
    popoverSuggestionsContainer.innerHTML = '<div class="suggestions-empty">No suggestions match current filters.</div>';
    return;
  }

  for (const suggestion of filtered) {
    const card = document.createElement('div');
    card.className = 'suggestion-card type-' + (suggestion.type || 'mixed');

    const typeLabel = document.createElement('div');
    typeLabel.className = 'suggestion-type';
    const typeNames = { action: 'Action', dialogue: 'Dialogue', narrative: 'Narrative', mixed: 'Mixed' };
    typeLabel.textContent = typeNames[suggestion.type] || 'Mixed';

    const textEl = document.createElement('div');
    textEl.className = 'suggestion-text';
    textEl.textContent = suggestion.text;

    card.appendChild(typeLabel);
    card.appendChild(textEl);

    card.addEventListener('click', () => {
      insertSuggestionIntoEditor(suggestion);
    });

    popoverSuggestionsContainer.appendChild(card);
  }
}

/**
 * Show a temporary status message in the popover
 */
function showSuggestionStatus(message, type) {
  popoverStatus.textContent = message;
  popoverStatus.className = 'suggestion-status ' + type;
  setTimeout(() => {
    popoverStatus.className = 'suggestion-status';
    popoverStatus.style.display = 'none';
  }, 3000);
}

/**
 * Update the badge counter
 */
export function updateBadge(count) {
  if (count > 0) {
    suggestionsBadge.textContent = String(count);
    suggestionsBadge.classList.remove('hidden');
  } else {
    suggestionsBadge.classList.add('hidden');
  }
}

/**
 * Insert suggestion text into NovelAI's story editor via executeJavaScript.
 * Prefers the companion script's document.append API (updates NovelAI's own
 * document model). Falls back to direct ProseMirror manipulation if the
 * companion script isn't running.
 */
async function insertSuggestionIntoEditor(suggestion) {
  try {
    const text = suggestion.text;

    // Strategy 0: Insert into native editor (Primary)
    if (storyEditor) {
      console.log('[Suggestions] Inserting into native editor');
      storyEditor.focus();
      const sel = window.getSelection();
      if (sel.rangeCount > 0) {
        const range = sel.getRangeAt(0);
        if (storyEditor.contains(range.commonAncestorContainer)) {
          range.deleteContents();
          const node = document.createTextNode(text);
          range.insertNode(node);
          range.setStartAfter(node);
          range.collapse(true);
          sel.removeAllRanges();
          sel.addRange(range);
        } else {
          storyEditor.innerText += (storyEditor.innerText.endsWith('\n') ? '' : '\n') + text;
        }
      } else {
        storyEditor.innerText += (storyEditor.innerText.endsWith('\n') ? '' : '\n') + text;
      }
      // Trigger sync to webview
      await syncToWebview();
      showSuggestionStatus('Suggestion inserted', 'success');
      return;
    }

    const result = await webview.executeJavaScript(`
      (async function() {
        // Strategy 1: Use companion script's API (most reliable -- updates NovelAI's document model)
        if (window.__sceneVisInsert) {
          try {
            const ok = await window.__sceneVisInsert(${JSON.stringify(text)});
            if (ok) return { success: true, method: 'document-append' };
          } catch (e) {
            console.warn('[PowerTool] __sceneVisInsert threw:', e);
          }
        }

        // Strategy 2: Direct ProseMirror transaction (fallback if companion script not running)
        const editor = document.querySelector('.ProseMirror[contenteditable="true"]');
        if (!editor) return { success: false, error: 'No editor found' };

        const before = editor.textContent.length;

        try {
          const view = editor.pmViewDesc && editor.pmViewDesc.view;
          if (view && view.state) {
            editor.focus();
            const { state } = view;
            // Find the last textblock and insert at its end
            let insertPos = null;
            state.doc.descendants((node, pos) => {
              if (node.isTextblock) {
                insertPos = pos + 1 + node.content.size;
              }
            });
            if (insertPos !== null) {
              const tr = state.tr.insertText('\\n' + ${JSON.stringify(text)}, insertPos);
              view.dispatch(tr);
              if (editor.textContent.length > before) {
                return { success: true, method: 'prosemirror-transaction' };
              }
            }
          }
        } catch (e) {
          console.warn('[PowerTool] ProseMirror transaction error:', e);
        }

        // Strategy 3: execCommand fallback
        try {
          editor.focus();
          const sel = window.getSelection();
          const range = document.createRange();
          range.selectNodeContents(editor);
          range.collapse(false);
          sel.removeAllRanges();
          sel.addRange(range);
          document.execCommand('insertText', false, ${JSON.stringify(text)});
          if (editor.textContent.length > before) {
            return { success: true, method: 'execCommand' };
          }
        } catch (e) {}

        return { success: false, error: 'All insertion strategies failed' };
      })()
    `);

    if (result && result.success) {
      console.log('[Renderer] Suggestion inserted via', result.method);
      showSuggestionStatus('Suggestion inserted into editor', 'success');
    } else {
      console.warn('[Renderer] Suggestion insertion failed:', result?.error);
      showSuggestionStatus(result?.error || 'Could not insert suggestion', 'error');
    }
  } catch (e) {
    console.error('[Renderer] Error inserting suggestion:', e);
    showSuggestionStatus('Error inserting suggestion', 'error');
  }
}

// Electron-side suggestion generation -- triggered when prompt update arrives.
// Reads story text directly from NovelAI's ProseMirror editor via executeJavaScript,
// then calls Electron main process to generate suggestions in parallel with image gen.
export async function generateSuggestionsFromEditor() {
  if (!suggestionsEnabledCheckbox.checked) return;

  try {
    const storyText = await webview.executeJavaScript(`
      (function() {
        var editor = document.querySelector('.ProseMirror');
        if (editor) return editor.innerText;
        return '';
      })()
    `);
    if (!storyText || storyText.length < 100) return;

    // Use last 4000 chars to match suggestion context limit
    const contextText = storyText.length > 4000 ? storyText.slice(-4000) : storyText;

    console.log('[Renderer] Generating suggestions via Electron direct API...');
    popoverLoading.style.display = 'flex';
    popoverSuggestionsContainer.innerHTML = '';

    const result = await window.powertool.generateSuggestionsDirect({
      storyText: contextText,
      storyId: state.currentStoryId,
    });
    popoverLoading.style.display = 'none';

    if (result.success && result.suggestions) {
      state.currentSuggestions = result.suggestions;
      renderSuggestions(result.suggestions);

      // Persist suggestions for this story
      if (state.currentStoryId) {
        try {
          const sceneState = await window.powertool.sceneGetState(state.currentStoryId);
          sceneState.suggestions = result.suggestions;
          await window.powertool.sceneSetState(state.currentStoryId, sceneState);
        } catch (e) { /* non-fatal */ }
      }

      if (result.suggestions.length > 0 && suggestionsPopover.classList.contains('hidden')) {
        state.suggestionsBadgeCount = result.suggestions.length;
        updateBadge(state.suggestionsBadgeCount);
      }
      if (result.suggestions.length > 0 && suggestionsAutoShowCheckbox.checked) {
        openPopover();
      }
    } else if (result.error) {
      console.error('[Renderer] Electron-side suggestion generation failed:', result.error);
    }
  } catch (e) {
    popoverLoading.style.display = 'none';
    console.error('[Renderer] Electron-side suggestion generation error:', e);
  }
}

export function init() {
  // Initialize checkbox states from prefs
  suggestionsEnabledCheckbox.checked = popoverPrefs.enabled !== false;
  suggestionsAutoShowCheckbox.checked = popoverPrefs.autoShow === true;

  // Init type filter button states
  document.querySelectorAll('.type-filter-btn').forEach(btn => {
    const type = btn.dataset.type;
    btn.classList.toggle('active', activeTypeFilters.has(type));
  });

  suggestionsEnabledCheckbox.addEventListener('change', savePopoverPrefs);
  suggestionsAutoShowCheckbox.addEventListener('change', savePopoverPrefs);

  // Type filter button clicks
  document.querySelectorAll('.type-filter-btn').forEach(btn => {
    btn.addEventListener('click', () => {
      const type = btn.dataset.type;
      if (activeTypeFilters.has(type)) {
        activeTypeFilters.delete(type);
        btn.classList.remove('active');
      } else {
        activeTypeFilters.add(type);
        btn.classList.add('active');
      }
      savePopoverPrefs();
      renderSuggestions(state.currentSuggestions);
    });
  });

  // Toggle popover
  suggestionsBtn.addEventListener('click', (e) => {
    e.stopPropagation();
    if (suggestionsPopover.classList.contains('hidden')) {
      openPopover();
    } else {
      closePopover();
    }
  });

  popoverCloseBtn.addEventListener('click', closePopover);

  // Outside-click dismiss
  document.addEventListener('click', (e) => {
    if (!suggestionsPopover.classList.contains('hidden') &&
        !suggestionsPopover.contains(e.target) &&
        !suggestionsBtn.contains(e.target)) {
      closePopover();
    }
  });

  // Escape key dismiss
  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape' && !suggestionsPopover.classList.contains('hidden')) {
      closePopover();
    }
  });

  // Settings toggle
  popoverSettingsBtn.addEventListener('click', () => {
    popoverSettings.classList.toggle('visible');
  });

  // Regenerate button
  popoverRegenBtn.addEventListener('click', async () => {
    popoverRegenBtn.disabled = true;
    try {
      await generateSuggestionsFromEditor();
    } catch (e) {
      console.error('[Renderer] Regen suggestions error:', e);
    } finally {
      popoverRegenBtn.disabled = false;
    }
  });
}
