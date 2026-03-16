// webview-polling.js — Story context detection, DOM relay, webview events, story change polling

import { state, bus } from './state.js';
import {
  webview, status,
  storyIndicator, promptDisplay, negativePromptDisplay, commitSbName, commitStoryLabel,
} from './dom-refs.js';
import { showToast } from './utils.js';
import { renderSuggestions, updateBadge } from './suggestions.js';
import { refreshLoreUI, renderComprehensionState, loadCategoryRegistry } from './lore-creator.js';
import { renderMemoryUI } from './memory-manager.js';
import { generateScenePromptFromEditor } from './image-gen.js';

// =========================================================================
// DOM-BASED MEMORY HELPERS
// Read/write NovelAI's Memory field directly via DOM manipulation.
// This works regardless of proxy panel visibility -- it finds the Memory
// textarea in NovelAI's story settings sidebar and manipulates it directly.
// =========================================================================

export async function readMemoryFromDOM() {
  try {
    return await webview.executeJavaScript(`
      (function() {
        // Strategy 1: Look for the Memory textarea by placeholder text
        var textareas = document.querySelectorAll('textarea');
        for (var i = 0; i < textareas.length; i++) {
          var ph = (textareas[i].placeholder || '').toLowerCase();
          if (ph.includes('memory')) return textareas[i].value;
        }
        // Strategy 2: Look for a label containing "Memory" near a textarea
        var labels = document.querySelectorAll('label, span, div');
        for (var j = 0; j < labels.length; j++) {
          var text = (labels[j].textContent || '').trim();
          if (text === 'Memory' || text === 'memory') {
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
  } catch (e) {
    console.log('[DOM] Error reading memory:', e);
    return null;
  }
}

export async function writeMemoryToDOM(text) {
  try {
    return await webview.executeJavaScript(`
      (function() {
        var targetTA = null;
        // Strategy 1: placeholder
        var textareas = document.querySelectorAll('textarea');
        for (var i = 0; i < textareas.length; i++) {
          var ph = (textareas[i].placeholder || '').toLowerCase();
          if (ph.includes('memory')) { targetTA = textareas[i]; break; }
        }
        // Strategy 2: label
        if (!targetTA) {
          var labels = document.querySelectorAll('label, span, div');
          for (var j = 0; j < labels.length; j++) {
            var text = (labels[j].textContent || '').trim();
            if (text === 'Memory' || text === 'memory') {
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
        var setter = Object.getOwnPropertyDescriptor(
          window.HTMLTextAreaElement.prototype, 'value'
        ).set;
        setter.call(targetTA, ${JSON.stringify(text)});
        targetTA.dispatchEvent(new Event('input', { bubbles: true }));
        targetTA.dispatchEvent(new Event('change', { bubbles: true }));
        return true;
      })()
    `);
  } catch (e) {
    console.log('[DOM] Error writing memory:', e);
    return false;
  }
}

// Read story text directly from ProseMirror editor in the webview DOM
export async function readStoryTextFromDOM() {
  try {
    return await webview.executeJavaScript(`
      (function() {
        // ProseMirror editor has class .ProseMirror
        var pm = document.querySelector('.ProseMirror');
        if (pm) return pm.textContent || '';
        // Fallback: contenteditable div
        var ce = document.querySelector('[contenteditable="true"]');
        if (ce) return ce.textContent || '';
        return null;
      })()
    `);
  } catch (e) {
    console.log('[DOM] Error reading story text:', e);
    return null;
  }
}

// ========================================================================
// STORY CONTEXT -- auto-switch storyboards per story
// ========================================================================

async function handleStoryContextChange(storyId, storyTitle) {
  if (!storyId || storyId === state.currentStoryId) return;

  state.currentStoryId = storyId;
  state.currentStoryTitle = storyTitle || null;

  // Update toolbar indicator
  storyIndicator.textContent = 'Story: ' + (storyTitle || storyId.slice(0, 12));
  storyIndicator.style.display = '';

  bus.emit('story:changed', { storyId, storyTitle });

  // SINGLE CALL: load all per-story data from SQLite
  try {
    const allData = await window.sceneVisualizer.storyLoadAll(storyId, storyTitle);

    // Restore scene state
    const ss = allData.sceneState;
    if (ss && ss.lastPrompt) {
      state.currentPrompt = ss.lastPrompt;
      state.currentNegativePrompt = ss.lastNegativePrompt || '';
      state.lastKnownStoryLength = ss.lastStoryLength || 0;
      promptDisplay.value = state.currentPrompt;
      if (negativePromptDisplay) negativePromptDisplay.value = state.currentNegativePrompt;
      if (ss.suggestions && ss.suggestions.length > 0) {
        state.currentSuggestions = ss.suggestions;
        renderSuggestions(ss.suggestions);
        state.suggestionsBadgeCount = ss.suggestions.length;
        updateBadge(state.suggestionsBadgeCount);
      }
    } else {
      state.currentPrompt = '';
      state.currentNegativePrompt = '';
      state.lastKnownStoryLength = 0;
      promptDisplay.value = '';
      if (negativePromptDisplay) negativePromptDisplay.value = '';
      state.currentSuggestions = [];
      renderSuggestions([]);
      updateBadge(0);
    }

    // Eagerly restore lore state
    if (allData.loreState) {
      state.loreState = allData.loreState;
      loadCategoryRegistry().then(() => refreshLoreUI());
    }

    // Eagerly restore comprehension
    if (allData.comprehension) {
      renderComprehensionState(allData.comprehension);
    }

    // Eagerly restore memory state
    if (allData.memoryState) {
      state.memoryState = allData.memoryState;
      renderMemoryUI();
    }

    // Eagerly restore LitRPG state
    if (allData.litrpgState) {
      state.litrpgState = allData.litrpgState;
      state.litrpgEnabled = !!allData.litrpgState.enabled;
    } else {
      state.litrpgState = null;
      state.litrpgEnabled = false;
    }
    // Refresh RPG UI (dynamic import to avoid circular deps)
    import('./litrpg-panel.js').then(m => m.refreshRpgUI && m.refreshRpgUI()).catch(() => {});

    // Eagerly restore TTS state (per-story character voice map)
    state.ttsState = allData.ttsState || { characterVoices: {} };

    // Eagerly restore per-story settings (TTS config, image, scene)
    state.storySettings = allData.storySettings || null;

    console.log('[Renderer] Eagerly loaded all data for story:', storyId);
  } catch (e) {
    console.error('[Renderer] Failed to load story data:', e.message);
  }

  // Auto-switch storyboard (filesystem-based, unchanged)
  try {
    const result = await window.sceneVisualizer.storyboardGetOrCreateForStory(storyId, storyTitle);
    if (result && result.id) {
      state.activeStoryboardId = result.id;
      state.activeStoryboardName = result.name;
      await window.sceneVisualizer.storyboardSetActive(result.id);
      commitSbName.textContent = state.activeStoryboardName;
      if (result.created) {
        showToast('Storyboard created for story: ' + (storyTitle || storyId.slice(0, 12)));
      } else {
        console.log('[Renderer] Switched to storyboard:', state.activeStoryboardName);
      }
      if (storyTitle) {
        commitStoryLabel.textContent = 'Story: ' + storyTitle;
        commitStoryLabel.style.display = '';
      }
    }
  } catch (e) {
    console.error('[Renderer] Error auto-switching storyboard:', e);
  }
}

export function init() {
  // Webview events
  webview.addEventListener('did-start-loading', () => {
    status.textContent = 'Loading...';
    status.className = 'status';
  });

  webview.addEventListener('did-finish-load', () => {
    status.textContent = 'Connected';
    status.className = 'status connected';

    // Poll webview for story context. The script sandbox can't use
    // contextBridge or write to page DOM, so we extract story identity
    // directly from NovelAI's page state via executeJavaScript.
    let lastPolledStoryId = null;
    setInterval(async () => {
      try {
        const ctx = await webview.executeJavaScript(`
          (function() {
            // Extract story ID from NovelAI URL query param (/stories?id=uuid)
            var params = new URLSearchParams(window.location.search);
            var storyId = params.get('id');
            if (storyId) {
              // Try document.title (NovelAI sets it to "Story Title - NovelAI")
              var title = '';
              var dt = document.title || '';
              var sep = dt.lastIndexOf(' - NovelAI');
              if (sep > 0) {
                title = dt.substring(0, sep).trim();
              }
              return { storyId: storyId, storyTitle: title };
            }
            return null;
          })()
        `);
        if (ctx && ctx.storyId && ctx.storyId !== lastPolledStoryId) {
          lastPolledStoryId = ctx.storyId;
          console.log('[Renderer] Story context from webview poll:', ctx.storyId, ctx.storyTitle);
          handleStoryContextChange(ctx.storyId, ctx.storyTitle);
        }
      } catch (e) {
        // Webview not ready or navigating
      }
    }, 3000);
  });

  webview.addEventListener('did-fail-load', (e) => {
    status.textContent = 'Failed to load';
    status.className = 'status error';
    console.error('Webview load failed:', e);
  });

  // Story text change detection -- triggers Electron-side prompt generation
  // Uses sceneSettings for auto-gen toggle and min text change threshold
  let cachedSceneSettings = null;
  // Load scene settings once at startup, refresh periodically
  async function refreshSceneSettings() {
    try { cachedSceneSettings = await window.sceneVisualizer.getSceneSettings(); } catch (e) { /* ignore */ }
  }
  refreshSceneSettings();
  setInterval(refreshSceneSettings, 30000);

  setInterval(async () => {
    if (state.isGenerating || state.isGeneratingPrompt) return;
    // Check auto-generate setting
    if (cachedSceneSettings && cachedSceneSettings.autoGeneratePrompts === false) return;
    const minChange = (cachedSceneSettings && cachedSceneSettings.minTextChange) || 50;
    try {
      const text = await readStoryTextFromDOM();
      if (text && Math.abs(text.length - state.lastKnownStoryLength) > minChange) {
        state.lastKnownStoryLength = text.length;
        await generateScenePromptFromEditor();
      }
    } catch (e) {
      // Ignore errors during polling
    }
  }, 10000);

  // Continuous lorebook adjustment — lightweight, no LLM, max once per 30s
  setInterval(async () => {
    if (!state.currentStoryId || state.loreIsScanning) return;
    if (!state.loreProxyReady) return;
    const confirmedFields = state.loreOptConfirmedFields
      || state.storySettings?.loreOptConfirmedFields;
    if (!confirmedFields || confirmedFields.length === 0) return;

    const now = Date.now();
    if (now - state.loreOptLastAdjust < 30000) return;

    // Check if enough new text since last adjustment
    const storyLen = state.lastKnownStoryLength || 0;
    const lastLen = state._loreOptLastLen || 0;
    if (storyLen - lastLen < 500) return;

    state.loreOptLastAdjust = now;
    state._loreOptLastLen = storyLen;

    try {
      const { loreCall } = await import('./lore-creator.js');
      const entries = await loreCall('getEntriesExpanded');
      if (!entries || entries.length === 0) return;

      const profileId = state.loreOptProfile || 'general';
      const result = await window.sceneVisualizer.loreAdjustEntries(
        entries, profileId, state.currentStoryId
      );

      if (result.success && result.adjustments && result.adjustments.length > 0) {
        // Apply adjustments via proxy
        const updates = result.adjustments.map(a => ({ id: a.entryId, fields: a.delta }));
        await loreCall('batchUpdateAdvanced', updates);
        console.log(`[LoreOpt] Continuous adjustment: ${updates.length} entries updated`);
      }
    } catch (e) {
      // Silent fail for continuous adjustment
      console.log('[LoreOpt] Continuous adjustment error:', e.message);
    }
  }, 15000);
}
