// webview-polling.js — Story context detection, DOM relay, webview events, story change polling

import { state, bus } from './state.js';
import { updateVisibility as updateStorySelectorVisibility } from './story-selector.js';
import {
  webview, status,
  storyIndicator, promptDisplay, negativePromptDisplay, commitSbName, commitStoryLabel,
} from './dom-refs.js';
import { showToast } from './utils.js';
import { renderSuggestions, updateBadge } from './suggestions.js';
import { refreshLoreUI, renderComprehensionState, loadCategoryRegistry } from './lore-creator.js';
import { renderMemoryUI } from './memory-manager.js';
import { generateScenePromptFromEditor } from './image-gen.js';
import { syncFromWebview } from './headless-sync.js';
import { PollingCoordinator } from './polling.js';

export const polling = new PollingCoordinator();

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

  // Update native toolbar's story title
  if (refs.editorStoryTitle) {
    refs.editorStoryTitle.textContent = storyTitle || 'Untitled Story';
    refs.editorStoryTitle.title = 'Edit Story Metadata';
  }

  // Update sidebar indicator
  if (storyIndicator) {
    storyIndicator.textContent = 'Story: ' + (storyTitle || storyId.slice(0, 12));
    storyIndicator.style.display = '';
  }

  bus.emit('story:changed', { storyId, storyTitle });

  // Cancel any in-progress operations from previous story
  if (state.loreIsScanning) {
    state.loreIsScanning = false;
    const scanStatus = document.getElementById('loreScanStatus');
    if (scanStatus) scanStatus.style.display = 'none';
  }
  if (state.isGenerating) {
    state.isGenerating = false;
  }
  state.isGeneratingPrompt = false;
  state.loreLastScanAt = null;

  // SINGLE CALL: load all per-story data from SQLite
  try {
    const allData = await window.powertool.storyLoadAll(storyId, storyTitle);

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

    // Eagerly restore lore state (always initialize — new stories have no DB row)
    state.loreState = allData.loreState || {
      pendingEntries: [], pendingUpdates: [], pendingMerges: [],
      acceptedEntryIds: [], rejectedNames: [], dismissedUpdateNames: [],
      rejectedMergeNames: [], dismissedReformatNames: [], charsSinceLastScan: 0,
      loreCategoryIds: {}, pendingCleanups: [], dismissedCleanupIds: [],
    };
    loadCategoryRegistry().then(() => refreshLoreUI());

    // Eagerly restore comprehension
    renderComprehensionState(allData.comprehension || { entities: [], summary: '', chunkCount: 0 });

    // Eagerly restore memory state
    state.memoryState = allData.memoryState || {};
    renderMemoryUI();

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
    const result = await window.powertool.storyboardGetOrCreateForStory(storyId, storyTitle);
    if (result && result.id) {
      state.activeStoryboardId = result.id;
      state.activeStoryboardName = result.name;
      await window.powertool.storyboardSetActive(result.id);
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

  // Track webview readiness for the story-context poll condition
  let webviewReady = false;
  let lastPolledStoryId = null;
  let lastDashboardCheck = 0;

  webview.addEventListener('did-finish-load', async () => {
    status.textContent = 'Connected';
    status.className = 'status connected';
    webviewReady = true;

    // Auto-navigate to stories dashboard if user is already authenticated
    try {
      const url = webview.getURL();
      if (url === 'https://novelai.net/' || url === 'https://novelai.net') {
        const { hasToken } = await window.powertool.getTokenStatus();
        if (hasToken) {
          console.log('[Renderer] Token found, navigating to stories dashboard');
          webview.loadURL('https://novelai.net/stories');
    
          // Retry dashboard navigation a limited number of times to avoid stacking
          // intervals on repeated did-finish-load events.
          if (!window._dashboardRetryActive) {
            window._dashboardRetryActive = true;
            let attempts = 0;
            const maxAttempts = 6; // 30s total
            const dashboardCheckInterval = setInterval(async () => {
              if (state.currentStoryId || ++attempts > maxAttempts) {
                clearInterval(dashboardCheckInterval);
                window._dashboardRetryActive = false;
                return;
              }
              const retryUrl = webview.getURL();
              if (retryUrl === 'https://novelai.net/' || retryUrl === 'https://novelai.net') {
                const tokenStatus = await window.powertool.getTokenStatus();
                if (tokenStatus.hasToken) {
                  console.log('[Renderer] Still on landing page, forcing dashboard navigation');
                  webview.loadURL('https://novelai.net/stories');
                }
              }
            }, 5000);
          }
        }
      }
    } catch (e) {
      console.error('[Renderer] Auto-navigate failed:', e);
    }
  });

  // Listen for headless story selection
  bus.on('headless:select-story', (storyId) => {
    if (!storyId) {
      console.log('[Renderer] Navigating to NovelAI stories dashboard...');
      webview.loadURL('https://novelai.net/stories');
      return;
    }
    console.log(`[Renderer] Navigating to story: ${storyId}`);
    webview.loadURL(`https://novelai.net/stories?id=${storyId}`);
  });

  // Listen for force dashboard re-parse
  bus.on('headless:force-dashboard-reparse', () => {
    lastDashboardCheck = 0;
  });

  // Listen for force webview display (e.g., "Create New Story" or "Go to NovelAI Dashboard")
  bus.on('headless:force-webview', (show) => {
    if (show) {
      state.headlessMode = false;
      window.powertool.setSceneSettings({ interfaceShowWebview: true, headlessMode: false });
      // Toggle webview visibility CSS
      const mainContainer = document.querySelector('.main-container');
      if (mainContainer) {
        mainContainer.classList.remove('headless-mode');
        mainContainer.classList.add('webview-mode');
      }
      bus.emit('settings:saved');
    }
  });

  webview.addEventListener('did-fail-load', (e) => {
    status.textContent = 'Failed to load';
    status.className = 'status error';
    webviewReady = false;
    console.error('Webview load failed:', e);
  });

  // -- Scene settings cache (used by auto-gen poll) --
  let cachedSceneSettings = null;
  async function refreshSceneSettings() {
    try { cachedSceneSettings = await window.powertool.getSceneSettings(); } catch (e) { /* ignore */ }
  }
  refreshSceneSettings();

  // =====================================================================
  // Register polling tasks
  // =====================================================================

  // 1. Story context poll (~3s) — extract story identity from NovelAI page
  polling.register('story-context', async () => {
    try {
      const url = webview.getURL();
      const isDashboard = url.includes('/stories') && !url.includes('?id=');
      
      // Auto-navigate to dashboard if in headless mode and no story is selected
      if (state.headlessMode && !state.currentStoryId && !isDashboard && !url.includes('login')) {
        const { hasToken } = await window.powertool.getTokenStatus();
        if (hasToken) {
          console.log('[Renderer] Headless mode active but no story selected, forcing dashboard navigation');
          webview.loadURL('https://novelai.net/stories');
          return; // Skip rest of poll for this tick
        }
      }

      if (isDashboard !== state.isDashboardActive) {
        state.isDashboardActive = isDashboard;
        bus.emit('headless:dashboard-state-changed', isDashboard);
        
        // If we just entered the dashboard, trigger an immediate parse
        if (isDashboard) {
          lastDashboardCheck = 0; // Force immediate parse in next check
        }
      }

      if (isDashboard) {
        // Only parse story list every 10s to avoid heavy DOM polling,
        // but parse immediately if lastDashboardCheck was reset to 0.
        if (lastDashboardCheck === 0 || Date.now() - lastDashboardCheck > 10000) {
          lastDashboardCheck = Date.now();
          console.log('[Renderer] Dashboard active, parsing stories...');
          const stories = await webview.executeJavaScript(`
            (function() {
              // Strategy 1: Look for elements with "StoryItem" in class name
              var storyElements = document.querySelectorAll('div[class*="StoryList_StoryItem"]');
              
              // Strategy 2: Look for elements that contain both a title and an "Updated" text
              if (storyElements.length === 0) {
                storyElements = Array.from(document.querySelectorAll('div')).filter(el => {
                  var h3 = el.querySelector('h3');
                  var text = el.innerText || '';
                  return h3 && (text.includes('Updated') || text.includes('ago') || text.includes('Modified'));
                });
              }
              
              // Strategy 3: Look for any list items that look like stories
              if (storyElements.length === 0) {
                storyElements = Array.from(document.querySelectorAll('li')).filter(el => {
                  var h3 = el.querySelector('h3');
                  return h3 && h3.innerText.length > 0;
                });
              }

              console.log('[Dashboard] Found potential story elements:', storyElements.length);

              return Array.from(storyElements).map(el => {
                var titleEl = el.querySelector('h3') || el.querySelector('div[class*="title"]') || el.querySelector('span[class*="Title"]');
                var title = titleEl ? titleEl.innerText : 'Untitled Story';
                
                // Try to find the link to extract the ID
                var link = el.querySelector('a') || (el.tagName === 'A' ? el : null);
                if (!link) {
                  // Search parents or children for an <a> tag
                  link = el.closest('a') || el.querySelector('a');
                }
                
                var href = link ? (link.href || '') : '';
                var id = '';
                if (href.includes('id=')) {
                  id = href.split('id=')[1].split('&')[0];
                } else if (href.includes('/stories/')) {
                  // Alternative URL format check
                  id = href.split('/stories/')[1].split('?')[0];
                }

                var descriptionEl = el.querySelector('p') || el.querySelector('div[class*="description"]') || el.querySelector('span[class*="Description"]');
                var description = descriptionEl ? descriptionEl.innerText : '';

                var tags = Array.from(el.querySelectorAll('span[class*="Tag"]')).map(t => t.innerText);

                return {
                  id: id,
                  title: title.trim(),
                  description: description.trim(),
                  tags: tags,
                  lastModified: Date.now()
                };
              }).filter(s => s.id && s.title !== 'Untitled Story');
            })()
          `);
          
          if (stories && stories.length > 0) {
            console.log(`[Renderer] Found ${stories.length} stories on dashboard`);
            bus.emit('headless:stories-updated', stories);
          } else {
            console.log('[Renderer] No stories found on dashboard, retrying in 10s...');
            // If we're on the dashboard but no stories are found, 
            // maybe it's still loading or the user has no stories.
            bus.emit('headless:stories-updated', []);
          }
        }
        return;
      }

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
        
        // Ensure story selector is hidden when we have a story
        updateStorySelectorVisibility();
      }
    } catch (e) {
      // Webview not ready or navigating
    }
  }, 3000, { condition: () => webviewReady });

  // 2. Scene settings refresh (~30s) — keep cached settings up to date
  polling.register('scene-settings', refreshSceneSettings, 30000);

  // 3. Auto-gen / story change detection (~10s)
  polling.register('auto-gen', async () => {
    if (state.isGenerating || state.isGeneratingPrompt) return;
    // Check auto-generate setting
    if (cachedSceneSettings && cachedSceneSettings.autoGeneratePrompts === false) return;
    const minChange = (cachedSceneSettings && cachedSceneSettings.minTextChange) || 50;
    try {
      const text = await readStoryTextFromDOM();
      if (text && Math.abs(text.length - state.lastKnownStoryLength) > minChange) {
        state.lastKnownStoryLength = text.length;
        // Sync the change from webview to native editor (e.g. AI generation)
        if (state.headlessMode) {
          await syncFromWebview();
        }
        await generateScenePromptFromEditor();
      }
    } catch (e) {
      // Ignore errors during polling
    }
  }, 10000);

  // 4. Continuous lorebook optimizer adjustment (~15s, extra guards inside)
  polling.register('lore-adjust', async () => {
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
      const result = await window.powertool.loreAdjustEntries(
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

  // 5. Incremental scene detection (~30s)
  polling.register('scene-detect', async () => {
    if (!state.currentStoryId) return;
    if (!state.timelineState?.settings?.autoDetect) return;
    if (state.llmBusy) return; // avoid NovelAI 429 concurrent request errors

    const storyText = await readStoryTextFromDOM();
    if (!storyText || storyText.length < 1000) return;

    try {
      const result = await window.powertool.timelineDetectNew(state.currentStoryId, storyText);
      if (result?.success && !result.noChange && result.newScenes?.length) {
        state.timelineState = result.state;
        bus.emit('timeline:scene-detected', { scenes: result.newScenes });
      }
    } catch (err) {
      console.error('[Timeline] Incremental detection error:', err);
    }
  }, 30000, {
    condition: () => state.currentStoryId && state.timelineState?.settings?.autoDetect
  });

  // 6. Generation-ended signal detection (~2s)
  // The companion script sets #scene-vis-gen-ended timestamp on every onGenerationEnd.
  // Detecting this allows near-instant prompt generation instead of waiting for the 10s auto-gen cycle.
  let lastGenEndedTimestamp = '';
  polling.register('generation-ended', async () => {
    if (!state.currentStoryId || state.isGenerating || state.isGeneratingPrompt) return;
    if (cachedSceneSettings && cachedSceneSettings.autoGeneratePrompts === false) return;
    if (state.llmBusy || state.loreIsScanning) return;
    try {
      const ts = await webview.executeJavaScript(`
        (function() {
          var el = document.getElementById('scene-vis-gen-ended');
          return el ? el.dataset.timestamp || '' : '';
        })()
      `);
      if (ts && ts !== lastGenEndedTimestamp) {
        console.log('[PowerTool] Generation ended signal detected, triggering prompt generation');
        // Clear headless generation waiting state
        if (state.isWaitingForGeneration) {
          state.isWaitingForGeneration = false;
          bus.emit('headless:generation-complete');
        }
        if (state.headlessMode) {
          await syncFromWebview();
        }
        await generateScenePromptFromEditor();
        // Only consume timestamp after successful prompt generation
        lastGenEndedTimestamp = ts;
      }
    } catch (_) {
      // Silent — webview may not be ready
    }
  }, 2000, {
    condition: () => !!state.currentStoryId
  });

  // 7. Generation streaming poll (~500ms) — headless mode only
  // Polls for text changes during active generation to stream output into native editor.
  let lastStreamedText = '';
  polling.register('gen-stream', async () => {
    if (!state.isWaitingForGeneration) return;
    try {
      const text = await readStoryTextFromDOM();
      if (text && text !== lastStreamedText) {
        lastStreamedText = text;
        bus.emit('headless:text-updated', text);
      }
    } catch (_) {
      // Silent — webview may not be ready
    }
  }, 500, {
    condition: () => state.headlessMode && state.isWaitingForGeneration
  });

  // Start the coordinator
  polling.start();
}
