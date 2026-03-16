// lore-creator.js — Lore scanning, organize, enrich, entry cards, comprehension, proxy communication

import { state, bus } from './state.js';
import {
  webview,
  sceneTab, loreTab, memoryTab, rpgTab, mediaTab, sceneContent, loreContent, memoryContent, rpgContent, mediaContent,
  loreScanBtn, loreOrganizeBtn, loreAcceptAllBtn, loreClearBtn,
  loreCleanupSection, loreCleanupList, loreCleanupCount, loreCleanupApplyAllBtn,
  loreScanStatus, loreScanPhase, loreScanProgressFill, loreError,
  lorePendingList, lorePendingCount,
  loreMergesSection, loreMergesList, loreMergesCount,
  loreUpdatesSection, loreUpdatesList, loreUpdatesCount,
  loreLlmIndicator,
  loreCreateInput, loreCreateBtn, loreCreateCategory, loreCreatePreview,
  loreEnrichInput, loreEnrichBtn, loreEnrichPreview, loreEnrichTarget,
  loreEnrichOld, loreEnrichNew, loreEnrichAcceptBtn, loreEnrichEditBtn, loreEnrichRejectBtn,
  loreAutoScan, loreAutoUpdates, loreMinChars, loreMinCharsValue,
  loreTemp, loreTempValue, loreDetailLevel,
  loreLlmSelect, loreOllamaSettings, loreOllamaModelSelect, loreOllamaRefreshBtn,
  loreHybridToggle,
  loreScanMenu,
  startProgressiveScanBtn, pauseProgressiveScanBtn, cancelProgressiveScanBtn,
  comprehensionStatusText, comprehensionProgressFill,
  masterSummaryDisplay, masterSummaryText,
  entityProfilesList, entityCount, entityProfileCards,
  familyTreeSection, familyTreeContainer, familyTreeCount,
  loreCategoryToggles, loreAddCategoryBtn, loreDetectCategoriesBtn,
  loreAddCategoryForm, loreNewCategoryName, loreNewCategoryColor,
  loreAddCategoryConfirm, loreAddCategoryCancel, dynamicCategoriesStyle,
  loreOptProfile, loreOptimizeAllBtn, loreDiscoverFieldsBtn, loreOptStatus,
} from './dom-refs.js';
import { escapeHtml, showToast } from './utils.js';
import { parseMetadataClient } from './metadata.js';
import { refreshMemoryUI } from './memory-manager.js';
import { readStoryTextFromDOM, readMemoryFromDOM, writeMemoryToDOM } from './webview-polling.js';

// =========================================================================
// CATEGORY REGISTRY
// Dynamic category system — builtins + per-story custom categories.
// =========================================================================

function needsDarkText(hexColor) {
  const hex = hexColor.replace('#', '');
  const r = parseInt(hex.substring(0, 2), 16);
  const g = parseInt(hex.substring(2, 4), 16);
  const b = parseInt(hex.substring(4, 6), 16);
  // Perceived brightness (YIQ formula)
  return (r * 299 + g * 587 + b * 114) / 1000 > 150;
}

function slugifyCategory(name) {
  return name.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');
}

/** Derive singular/plural forms from a category name, avoiding mangling words like "Species", "Class", "Status". */
function deriveSingularPlural(name) {
  if (/ies$/i.test(name) && /[^aeiou]ies$/i.test(name) && !/(spec|ser|sper)ies$/i.test(name)) {
    return { singular: name.slice(0, -3) + 'y', plural: name };
  } else if (/ses$/i.test(name) || /xes$/i.test(name) || /zes$/i.test(name) || /ches$/i.test(name) || /shes$/i.test(name)) {
    return { singular: name.slice(0, -2), plural: name };
  } else if (/ss$/i.test(name) || /us$/i.test(name) || /is$/i.test(name) || /(spec|ser|sper)ies$/i.test(name)) {
    return { singular: name, plural: name };
  } else if (/s$/i.test(name)) {
    return { singular: name.slice(0, -1), plural: name };
  }
  return { singular: name, plural: name + 's' };
}

function getCategoryDef(categoryId) {
  if (!state.categoryRegistry) return null;
  return state.categoryRegistry.find(c => c.id === categoryId) || null;
}

function getCategoryIds() {
  if (!state.categoryRegistry) return ['character', 'location', 'item', 'faction', 'concept'];
  return state.categoryRegistry.map(c => c.id);
}

function getCategoryDisplayName(categoryId) {
  const def = getCategoryDef(categoryId);
  return def ? def.displayName : (categoryId.charAt(0).toUpperCase() + categoryId.slice(1) + 's');
}

function injectCategoryStyles() {
  if (!dynamicCategoriesStyle || !state.categoryRegistry) return;

  let css = '';
  for (const cat of state.categoryRegistry) {
    const dark = needsDarkText(cat.color) ? 'color: #333;' : '';
    css += `.lore-card.${cat.id} { border-left-color: ${cat.color}; }\n`;
    css += `.category-badge.${cat.id} { background: ${cat.color}; ${dark} }\n`;
    css += `.entity-profile-card.${cat.id} { border-left-color: ${cat.color}; }\n`;
  }
  dynamicCategoriesStyle.textContent = css;
}

function rebuildCategoryUI() {
  if (!state.categoryRegistry) return;
  const catIds = getCategoryIds();

  // Rebuild toggles
  if (loreCategoryToggles) {
    loreCategoryToggles.innerHTML = '';
    for (const cat of state.categoryRegistry) {
      const label = document.createElement('label');
      const cb = document.createElement('input');
      cb.type = 'checkbox';
      cb.dataset.cat = cat.id;
      cb.checked = state.loreSettings ? state.loreSettings.enabledCategories[cat.id] !== false : true;
      cb.addEventListener('change', saveLoreSettings);
      label.appendChild(cb);
      label.appendChild(document.createTextNode(' ' + cat.singularName));
      if (!cat.isBuiltin) {
        const removeBtn = document.createElement('span');
        removeBtn.textContent = '\u00d7';
        removeBtn.title = 'Remove custom category';
        removeBtn.style.cssText = 'cursor:pointer;margin-left:3px;color:var(--text-dim);font-size:12px;';
        removeBtn.addEventListener('click', async (e) => {
          e.preventDefault();
          e.stopPropagation();
          if (!confirm(`Remove custom category "${cat.singularName}"?`)) return;
          await window.sceneVisualizer.loreRemoveCustomCategory(state.currentStoryId, cat.id);
          await loadCategoryRegistry();
        });
        label.appendChild(removeBtn);
      }
      loreCategoryToggles.appendChild(label);
    }
  }

  // Rebuild scan menu
  if (loreScanMenu) {
    loreScanMenu.innerHTML = '';
    const allBtn = document.createElement('button');
    allBtn.dataset.scan = 'all';
    allBtn.textContent = 'Scan All';
    allBtn.addEventListener('click', () => {
      state.scanMenuOpen = false;
      loreScanMenu.style.display = 'none';
      runLoreScan('all');
    });
    loreScanMenu.appendChild(allBtn);

    for (const cat of state.categoryRegistry) {
      const btn = document.createElement('button');
      btn.dataset.scan = cat.id;
      btn.textContent = cat.displayName;
      btn.addEventListener('click', () => {
        state.scanMenuOpen = false;
        loreScanMenu.style.display = 'none';
        runLoreScan(cat.id);
      });
      loreScanMenu.appendChild(btn);
    }

    const relBtn = document.createElement('button');
    relBtn.dataset.scan = 'relationships';
    relBtn.textContent = 'Relationships';
    relBtn.addEventListener('click', () => {
      state.scanMenuOpen = false;
      loreScanMenu.style.display = 'none';
      runLoreScan('relationships');
    });
    loreScanMenu.appendChild(relBtn);
  }

  // Rebuild create-entry category dropdown
  if (loreCreateCategory) {
    // Keep auto-detect option, remove others
    while (loreCreateCategory.options.length > 1) {
      loreCreateCategory.remove(1);
    }
    for (const cat of state.categoryRegistry) {
      const opt = document.createElement('option');
      opt.value = cat.id;
      opt.textContent = cat.singularName;
      loreCreateCategory.appendChild(opt);
    }
  }
}

export async function loadCategoryRegistry() {
  if (!state.currentStoryId) return;
  try {
    state.categoryRegistry = await window.sceneVisualizer.loreGetCategoryRegistry(state.currentStoryId);
  } catch (e) {
    console.error('[Lore] Failed to load category registry:', e);
    // Fallback to builtins
    state.categoryRegistry = [
      { id: 'character', displayName: 'Characters', singularName: 'Character', color: '#4d96ff', isBuiltin: true, template: 'character' },
      { id: 'location', displayName: 'Locations', singularName: 'Location', color: '#6bcb77', isBuiltin: true, template: null },
      { id: 'item', displayName: 'Items', singularName: 'Item', color: '#ffd93d', isBuiltin: true, template: null },
      { id: 'faction', displayName: 'Factions', singularName: 'Faction', color: '#ff6b6b', isBuiltin: true, template: null },
      { id: 'concept', displayName: 'Concepts', singularName: 'Concept', color: '#a855f7', isBuiltin: true, template: null },
    ];
  }

  // Auto-detect lorebook categories and merge non-builtin ones into the registry
  // (session-only, not persisted — re-detected on each story load)
  try {
    if (state.loreProxyReady) {
      const lorebookCats = await loreCall('getCategories');
      if (Array.isArray(lorebookCats) && lorebookCats.length > 0) {
        const existingNames = new Set(state.categoryRegistry.map(c => c.displayName.toLowerCase()));
        const autoColors = ['#ff9900', '#00bcd4', '#e91e63', '#8bc34a', '#9c27b0', '#ff5722', '#607d8b', '#cddc39'];
        let colorIdx = 0;
        for (const cat of lorebookCats) {
          const name = (cat.name || '').trim();
          if (!name || existingNames.has(name.toLowerCase())) continue;
          const id = slugifyCategory(name);
          if (!id || state.categoryRegistry.find(c => c.id === id)) continue;
          const { singular, plural } = deriveSingularPlural(name);
          state.categoryRegistry.push({
            id, displayName: plural, singularName: singular,
            color: autoColors[colorIdx++ % autoColors.length],
            isBuiltin: false, template: null,
          });
          existingNames.add(name.toLowerCase());
          console.log(`[Lore] Auto-detected lorebook category: ${name} → ${id}`);
        }
      }
    }
  } catch (e) {
    console.log('[Lore] Lorebook category auto-detect skipped:', e.message);
  }

  injectCategoryStyles();
  rebuildCategoryUI();
}

// =========================================================================
// DIRECT NOVELAI STATE ACCESS
// Access NovelAI's internal React state for lorebook/memory operations.
// This bypasses the proxy panel requirement by walking the React fiber
// tree to find the decrypted story data in memory.
// =========================================================================

// Probe the webview's internal state to discover available data paths
async function probeNovelAIState() {
  try {
    return await webview.executeJavaScript(`
      (function() {
        var result = { strategies: [], time: Date.now() };

        // Check React fiber tree
        var root = document.getElementById('__next');
        if (root) {
          var fiberKey = Object.keys(root).find(function(k) { return k.startsWith('__reactFiber'); });
          if (fiberKey) {
            result.strategies.push('react-fiber');
            result.fiberKey = fiberKey;
          }
        }

        // Check for API log
        if (window.__naiApiLog) {
          result.apiLogEntries = window.__naiApiLog.length;
          result.strategies.push('api-log');
        }

        // Check __NEXT_DATA__
        if (window.__NEXT_DATA__) {
          result.strategies.push('next-data');
          result.nextDataKeys = Object.keys(window.__NEXT_DATA__);
        }

        // Try to find Zustand stores (common in Next.js apps)
        // Zustand stores attach to window when using devtools middleware
        var storeKeys = Object.getOwnPropertyNames(window).filter(function(k) {
          try {
            var v = window[k];
            return v && typeof v === 'object' && typeof v.getState === 'function';
          } catch(e) { return false; }
        });
        if (storeKeys.length > 0) {
          result.strategies.push('zustand');
          result.zustandStores = storeKeys;
        }

        return result;
      })()
    `);
  } catch (e) {
    console.error('[Probe] Error:', e);
    return { strategies: [], error: e.message };
  }
}

// Walk React fiber tree to find a state matching a predicate
// Returns the first matching state object, or null
async function findReactState(predicateCode) {
  try {
    return await webview.executeJavaScript(`
      (function() {
        var predicate = ${predicateCode};
        var root = document.getElementById('__next');
        if (!root) return null;
        var fiberKey = Object.keys(root).find(function(k) { return k.startsWith('__reactFiber'); });
        if (!fiberKey) return null;

        var fiber = root[fiberKey];
        var queue = [fiber];
        var visited = new WeakSet();
        var maxIter = 50000;

        while (queue.length > 0 && maxIter-- > 0) {
          var current = queue.shift();
          if (!current || visited.has(current)) continue;
          visited.add(current);

          // Check memoizedState chain (hooks)
          var hook = current.memoizedState;
          var hookDepth = 0;
          while (hook && hookDepth < 50) {
            hookDepth++;
            if (hook.memoizedState != null) {
              try {
                var result = predicate(hook.memoizedState);
                if (result) return result;
              } catch(e) {}
            }
            // Also check hook.queue.lastRenderedState
            if (hook.queue && hook.queue.lastRenderedState != null) {
              try {
                var result = predicate(hook.queue.lastRenderedState);
                if (result) return result;
              } catch(e) {}
            }
            hook = hook.next;
          }

          // Check stateNode (class components)
          if (current.stateNode && current.stateNode !== root && current.stateNode.state) {
            try {
              var result = predicate(current.stateNode.state);
              if (result) return result;
            } catch(e) {}
          }

          // Traverse: child first, then sibling
          if (current.child) queue.push(current.child);
          if (current.sibling) queue.push(current.sibling);
        }
        return null;
      })()
    `);
  } catch (e) {
    console.error('[ReactState] Error:', e);
    return null;
  }
}

// Direct lorebook entry reading via React state
async function directGetEntries() {
  try {
    const entries = await findReactState(`function(state) {
      // Look for lorebook entries array in state
      if (!state || typeof state !== 'object') return null;

      // Direct lorebook property
      var lb = state.lorebook || state.lorebookEntries;
      if (!lb && state.storyContent) lb = state.storyContent.lorebook;
      if (!lb && state.story) lb = state.story.lorebook;
      if (!lb && state.content) lb = state.content.lorebook;

      if (lb) {
        var entries = lb.entries || lb;
        if (Array.isArray(entries) && entries.length > 0 && entries[0].text !== undefined) {
          return entries.map(function(e) {
            return {
              id: e.id || e.uid || '',
              displayName: e.displayName || e.name || '',
              keys: e.keys || [],
              text: e.text || '',
              enabled: e.enabled !== false,
              category: e.category || null
            };
          });
        }
      }

      // Check if state itself is a lorebook entries array
      if (Array.isArray(state) && state.length > 0 && state[0].displayName !== undefined && state[0].text !== undefined) {
        return state.map(function(e) {
          return {
            id: e.id || e.uid || '',
            displayName: e.displayName || e.name || '',
            keys: e.keys || [],
            text: e.text || '',
            enabled: e.enabled !== false,
            category: e.category || null
          };
        });
      }

      return null;
    }`);
    if (entries) {
      console.log('[Direct] Found', entries.length, 'lorebook entries via React state');
    }
    return entries;
  } catch (e) {
    console.error('[Direct] Error getting entries:', e);
    return null;
  }
}

// Direct memory reading via React state (falls back to DOM)
async function directGetMemory() {
  // Try DOM first since it's more reliable
  const domResult = await readMemoryFromDOM();
  if (domResult !== null) return domResult;

  // Try React state
  try {
    const memory = await findReactState(`function(state) {
      if (!state || typeof state !== 'object') return null;
      // Look for memory text in story content
      if (typeof state.memory === 'string') return state.memory;
      if (state.storyContent && typeof state.storyContent.memory === 'string') return state.storyContent.memory;
      if (state.story && typeof state.story.memory === 'string') return state.story.memory;
      if (state.content && typeof state.content.memory === 'string') return state.content.memory;
      // Memory might be in a context object
      if (state.context && typeof state.context.memory === 'string') return state.context.memory;
      return null;
    }`);
    if (memory !== null) {
      console.log('[Direct] Found memory via React state');
      return memory;
    }
  } catch (e) {
    console.error('[Direct] Error getting memory:', e);
  }
  return null;
}

// =========================================================================
// UI PANEL PROXY RPC
// The proxy scripts register UI panels with text inputs (command channel)
// and text displays (response channel). We find these panel elements in
// the webview DOM and communicate through them.
// =========================================================================

async function proxyCall(cmdLabel, resPrefix, resEnd, method, args) {
  const reqId = 'r' + Date.now() + Math.random().toString(36).slice(2, 8);
  const payload = JSON.stringify({ id: reqId, method, args: args || [] });
  // DOM response element written by naiscript's writeDomResponse (works even when panel update fails)
  const domResId = cmdLabel === '__LORE_PROXY_CMD__' ? '__lore_proxy_dom_res__' : '__memory_proxy_dom_res__';

  const code = `
    new Promise(function(resolve, reject) {
      var CMD_LABEL = ${JSON.stringify(cmdLabel)};
      var RES_PREFIX = ${JSON.stringify(resPrefix)};
      var RES_END = ${JSON.stringify(resEnd)};
      var PAYLOAD = ${JSON.stringify(payload)};
      var REQ_ID = ${JSON.stringify(reqId)};
      var DOM_RES_ID = ${JSON.stringify(domResId)};

      // Find the command input by placeholder or label marker text
      function findCmdInput() {
        var byPlaceholder = document.querySelector('input[placeholder="' + CMD_LABEL + '"], textarea[placeholder="' + CMD_LABEL + '"]');
        if (byPlaceholder) return byPlaceholder;
        var walker = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT);
        var node;
        while (node = walker.nextNode()) {
          if (node.textContent.indexOf(CMD_LABEL) !== -1) {
            var container = node.parentElement;
            for (var i = 0; i < 10 && container; i++) {
              var inputs = container.querySelectorAll('input[type="text"], input:not([type]), textarea');
              if (inputs.length > 0) return inputs[0];
              container = container.parentElement;
            }
          }
        }
        return null;
      }

      // Extract response JSON — check both panel text markers AND DOM fallback element
      function readResponse() {
        // Strategy 1: panel text markers (rendered by api.v1.ui.update)
        var walker = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT);
        var node;
        while (node = walker.nextNode()) {
          var text = node.textContent;
          var si = text.indexOf(RES_PREFIX);
          if (si !== -1) {
            var cs = si + RES_PREFIX.length;
            var ei = text.indexOf(RES_END, cs);
            if (ei !== -1) {
              var panelRaw = text.substring(cs, ei);
              if (panelRaw && panelRaw.length > 0) return panelRaw;
            }
          }
        }
        // Strategy 2: DOM element written by naiscript's writeDomResponse
        var domEl = document.getElementById(DOM_RES_ID);
        if (domEl && domEl.textContent && domEl.textContent.length > 0) {
          return domEl.textContent;
        }
        return null;
      }

      var cmdInput = findCmdInput();
      if (!cmdInput) { reject(new Error('Proxy panel not found')); return; }

      // Set input value using native setter to trigger the Script API onChange
      var setter = cmdInput.tagName === 'TEXTAREA'
        ? Object.getOwnPropertyDescriptor(window.HTMLTextAreaElement.prototype, 'value').set
        : Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value').set;
      setter.call(cmdInput, PAYLOAD);
      cmdInput.dispatchEvent(new Event('input', { bubbles: true }));
      cmdInput.dispatchEvent(new Event('change', { bubbles: true }));

      // Poll for our response
      var polls = 0;
      function poll() {
        var raw = readResponse();
        if (raw && raw.length > 0) {
          try {
            var res = JSON.parse(raw);
            if (res.id === REQ_ID) {
              if (res.data && res.data.__error) reject(new Error(res.data.__error));
              else resolve(res.data);
              return;
            }
          } catch(e) { /* not valid JSON yet, keep polling */ }
        }
        if (++polls < 150) setTimeout(poll, 100);
        else reject(new Error('Proxy response timeout (15s)'));
      }
      setTimeout(poll, 50);
    })
  `;

  return webview.executeJavaScript(code);
}

// Smart wrappers -- try CDP first, then webview proxy, then direct fallbacks
export async function loreCall(method, ...args) {
  // Try proxy first if available
  if (state.loreProxyReady) {
    try {
      return await proxyCall('__LORE_PROXY_CMD__', '__LORE_PROXY_RES__', '__LORE_PROXY_END__', method, args);
    } catch (e) {
      console.log('[Lore] Proxy call failed, trying direct:', method, e.message);
    }
  }
  // Direct fallbacks for read operations
  switch (method) {
    case 'getStoryText':
      return await readStoryTextFromDOM() || '';
    case 'getEntries':
      return await directGetEntries() || [];
    case 'getCategories': {
      const entries = await directGetEntries() || [];
      const catMap = new Map();
      for (const e of entries) {
        if (e.category && !catMap.has(e.category)) {
          catMap.set(e.category, { id: e.category, name: '', enabled: true });
        }
      }
      return Array.from(catMap.values());
    }
    case 'createEntry':
    case 'updateEntry':
    case 'deleteEntry':
    case 'createCategory':
      // Write operations require proxy -- no direct fallback yet
      throw new Error('Proxy not available for write operation: ' + method);
    default:
      throw new Error('Unknown lore method: ' + method);
  }
}

export async function memoryCall(method, ...args) {
  if (state.memoryProxyReady) {
    try {
      return await proxyCall('__MEMORY_PROXY_CMD__', '__MEMORY_PROXY_RES__', '__MEMORY_PROXY_END__', method, args);
    } catch (e) {
      console.log('[Memory] Proxy call failed, trying direct:', method, e.message);
    }
  }
  switch (method) {
    case 'getStoryText':
      return await readStoryTextFromDOM() || '';
    case 'getMemory':
      return await directGetMemory() || '';
    case 'setMemory': {
      const wrote = await writeMemoryToDOM(args[0]);
      if (!wrote) throw new Error('Memory textarea not found in DOM');
      return true;
    }
    case 'countTokens':
      return Math.ceil((args[0] || '').length / 4);
    default:
      throw new Error('Unknown memory method: ' + method);
  }
}

// =========================================================================
// Proxy status checking -- looks for UI panel markers in webview DOM
// =========================================================================

export async function checkProxyStatus(cmdLabel, resPrefix) {
  try {
    // Derive DOM channel IDs
    const domCmdId = cmdLabel === '__LORE_PROXY_CMD__' ? '__lore_proxy_dom_cmd__' : '__memory_proxy_dom_cmd__';
    const domResId = cmdLabel === '__LORE_PROXY_CMD__' ? '__lore_proxy_dom_res__' : '__memory_proxy_dom_res__';

    const proxyStatus = await webview.executeJavaScript(`
      (function() {
        var CMD = ${JSON.stringify(cmdLabel)};
        var RES = ${JSON.stringify(resPrefix)};
        var DOM_CMD = ${JSON.stringify(domCmdId)};
        var DOM_RES = ${JSON.stringify(domResId)};
        var foundCmd = false, foundRes = false;
        // Check placeholder attributes on inputs
        var byPlaceholder = document.querySelector('input[placeholder="' + CMD + '"], textarea[placeholder="' + CMD + '"]');
        if (byPlaceholder) foundCmd = true;
        // Walk text nodes for CMD label and RES marker
        var walker = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT);
        var node;
        while (node = walker.nextNode()) {
          if (!foundCmd && node.textContent.indexOf(CMD) !== -1) foundCmd = true;
          if (node.textContent.indexOf(RES) !== -1) foundRes = true;
          if (foundCmd && foundRes) return 'ready';
        }
        // Also check DOM channel elements (fallback indicators)
        if (!foundCmd && document.getElementById(DOM_CMD)) foundCmd = true;
        if (!foundRes && document.getElementById(DOM_RES)) foundRes = true;
        if (foundCmd && foundRes) return 'ready';
        if (foundCmd || foundRes) return 'partial';
        return 'not-found';
      })()
    `);
    return proxyStatus;
  } catch (e) {
    return 'check-error:' + (e.message || e);
  }
}

// Load state for current story
async function loadLoreState() {
  if (!state.currentStoryId) return;
  state.loreState = await window.sceneVisualizer.loreGetState(state.currentStoryId);
  await loadCategoryRegistry();
  refreshLoreUI();
}

export async function saveLoreState() {
  if (!state.currentStoryId || !state.loreState) return;
  await window.sceneVisualizer.loreSetState(state.currentStoryId, state.loreState);
}

export async function checkLoreProxy() {
  const proxyStatus = await checkProxyStatus('__LORE_PROXY_CMD__', '__LORE_PROXY_RES__');
  state.loreProxyReady = proxyStatus === 'ready';
  const loreProxyDot = document.getElementById('loreProxyDot');
  const loreProxyStatusText = document.getElementById('loreProxyStatusText');
  if (loreProxyDot && loreProxyStatusText) {
    if (state.loreProxyReady) {
      loreProxyDot.classList.remove('inactive');
      loreProxyDot.classList.add('active');
      loreProxyStatusText.textContent = 'Full Access';
    } else {
      // Read operations still work via direct mode (React state + DOM)
      loreProxyDot.classList.remove('active');
      loreProxyDot.classList.add('inactive');
      loreProxyStatusText.textContent = 'Read-Only (open Script Manager for writes)';
    }
  }
}

// Refresh the lore UI from state
export function refreshLoreUI() {
  checkLoreProxy(); // Update proxy status dot
  if (!state.loreState) {
    lorePendingList.innerHTML = '<div class="lore-empty">Select a story to get started.</div>';
    lorePendingCount.textContent = '(0)';
    loreMergesSection.style.display = 'none';
    loreUpdatesSection.style.display = 'none';
    loreCleanupSection.style.display = 'none';
    return;
  }

  const pe = state.loreState.pendingEntries || [];
  const pm = state.loreState.pendingMerges || [];
  const pu = state.loreState.pendingUpdates || [];

  lorePendingCount.textContent = `(${pe.length})`;
  loreMergesCount.textContent = `(${pm.length})`;
  loreUpdatesCount.textContent = `(${pu.length})`;

  const pc = state.loreState.pendingCleanups || [];

  loreMergesSection.style.display = pm.length > 0 ? '' : 'none';
  loreUpdatesSection.style.display = pu.length > 0 ? '' : 'none';
  loreCleanupSection.style.display = pc.length > 0 ? '' : 'none';
  loreCleanupCount.textContent = `(${pc.length})`;

  // Render pending cleanups
  loreCleanupList.innerHTML = '';
  for (const cleanup of pc) {
    loreCleanupList.appendChild(createCleanupCard(cleanup));
  }

  // Render pending entries
  if (pe.length === 0) {
    lorePendingList.innerHTML = '<div class="lore-empty">No pending entries. Click "Scan Now" to analyze your story.</div>';
  } else {
    lorePendingList.innerHTML = '';
    for (const entry of pe) {
      lorePendingList.appendChild(createEntryCard(entry));
    }
  }

  // Render pending merges
  loreMergesList.innerHTML = '';
  for (const merge of pm) {
    loreMergesList.appendChild(createMergeCard(merge));
  }

  // Render pending updates
  loreUpdatesList.innerHTML = '';
  for (const update of pu) {
    loreUpdatesList.appendChild(createUpdateCard(update));
  }
}

function cycleCategoryBadge(badge, getCurrent, onChanged) {
  const current = getCurrent();
  const catIds = getCategoryIds();
  const idx = catIds.indexOf(current);
  const next = catIds[(idx + 1) % catIds.length];
  const def = getCategoryDef(next);
  badge.className = `category-badge editable ${next}`;
  badge.textContent = def ? def.singularName.toUpperCase() : next.toUpperCase();
  // Update the card's outer class too
  const card = badge.closest('.lore-card');
  if (card) {
    for (const cat of catIds) card.classList.remove(cat);
    card.classList.add(next);
  }
  onChanged(next);
}

/** Build small colored badge HTML for metadata fields (skip @v and @updated as noise) */
function buildMetaBadges(text) {
  const meta = parseMetadataClient(text);
  if (Object.keys(meta.all).length === 0) return '';
  const BADGE_COLORS = {
    source: { bg: '#1e3a5f', fg: '#60a5fa' },
    role: { bg: '#3b1f5e', fg: '#c084fc' },
    protagonist: { bg: '#5f1e1e', fg: '#f87171' },
    'opt-v': { bg: '#1e4d3a', fg: '#6ee7b7' },
  };
  const DEFAULT_COLOR = { bg: '#374151', fg: '#9ca3af' };
  const SKIP = new Set(['type', 'v', 'updated']);
  const badges = [];
  for (const [key, val] of Object.entries(meta.all)) {
    if (SKIP.has(key)) continue;
    const c = BADGE_COLORS[key] || DEFAULT_COLOR;
    let label;
    if (key === 'protagonist') label = '@protagonist';
    else if (key === 'opt-v') label = 'optimized';
    else if (key === 'opt-at') continue; // skip date, shown via opt-v
    else if (key === 'opt-speech') continue; // internal cache
    else label = `@${key}: ${val}`;
    badges.push(`<span style="background:${c.bg};color:${c.fg};font-size:9px;padding:1px 4px;border-radius:3px;margin-left:4px;" title="${key === 'opt-v' ? 'Lorebook optimizer applied' : ''}">${escapeHtml(label)}</span>`);
  }
  return badges.join('');
}

function createEntryCard(entry) {
  const card = document.createElement('div');
  card.className = `lore-card ${entry.category || ''}`;
  card.dataset.entryId = entry.id;

  // Show reformat button for any entry type that has a template
  const templateTypes = ['character', 'location', 'item', 'faction', 'concept'];
  const hasTemplate = templateTypes.includes(entry.category);
  const reformatBtn = hasTemplate
    ? `<button class="btn-reformat" data-action="reformat" data-id="${entry.id}" style="background:#4d96ff;color:#fff;border:none;padding:4px 8px;font-size:10px;border-radius:3px;cursor:pointer;">Reformat</button>`
    : '';

  // Build metadata badges from parsed header
  const metaBadge = buildMetaBadges(entry.text);

  card.innerHTML = `
    <div class="lore-card-header">
      <span class="category-badge editable ${entry.category || ''}" title="Click to change type">${((getCategoryDef(entry.category) || {}).singularName || entry.category || '').toUpperCase()}</span>
      <span class="entry-name">${escapeHtml(entry.displayName)}${metaBadge}</span>
    </div>
    <div class="lore-card-text">${escapeHtml(entry.text)}</div>
    <div class="lore-card-keys">Keys: ${(entry.keys || []).map(k => escapeHtml(k)).join(', ')}</div>
    <div class="lore-card-actions">
      <button class="btn-accept" data-action="accept" data-id="${entry.id}">Accept</button>
      <button class="btn-edit" data-action="edit" data-id="${entry.id}">Edit</button>
      ${reformatBtn}
      <button class="btn-reject" data-action="reject" data-id="${entry.id}">Reject</button>
    </div>
  `;

  card.querySelector('.lore-card-text').addEventListener('click', (e) => {
    e.stopPropagation();
    e.currentTarget.classList.toggle('expanded');
  });
  card.querySelector('.category-badge').addEventListener('click', (e) => {
    e.stopPropagation();
    cycleCategoryBadge(e.target, () => entry.category, (newCat) => {
      entry.category = newCat;
      saveLoreState();
    });
  });
  card.querySelector('[data-action="accept"]').addEventListener('click', () => acceptEntry(entry.id));
  card.querySelector('[data-action="reject"]').addEventListener('click', () => rejectEntry(entry.id));
  card.querySelector('[data-action="edit"]').addEventListener('click', () => editEntry(entry.id, card));
  if (hasTemplate) {
    card.querySelector('[data-action="reformat"]').addEventListener('click', () => reformatEntry(entry.id));
  }

  return card;
}

function createMergeCard(merge) {
  const card = document.createElement('div');
  card.className = `lore-card ${merge.newCategory || ''}`;
  card.innerHTML = `
    <div class="lore-card-header">
      <span class="category-badge editable ${merge.newCategory || ''}" title="Click to change type">${((getCategoryDef(merge.newCategory) || {}).singularName || merge.newCategory || '').toUpperCase()}</span>
      <span class="entry-name">${escapeHtml(merge.newName)} &rarr; ${escapeHtml(merge.existingDisplayName)}</span>
    </div>
    <div class="lore-card-text">${escapeHtml(merge.proposedText)}</div>
    <div class="lore-card-keys">Keys: ${(merge.proposedKeys || []).map(k => escapeHtml(k)).join(', ')}</div>
    <div class="lore-card-actions">
      <button class="btn-accept" data-action="accept-merge" data-id="${merge.id}">Apply</button>
      <button class="btn-edit" data-action="edit-merge" data-id="${merge.id}">Edit</button>
      <button class="btn-reject" data-action="reject-merge" data-id="${merge.id}">Reject</button>
    </div>
  `;

  card.querySelector('.lore-card-text').addEventListener('click', (e) => {
    e.stopPropagation();
    e.currentTarget.classList.toggle('expanded');
  });
  card.querySelector('.category-badge').addEventListener('click', (e) => {
    e.stopPropagation();
    cycleCategoryBadge(e.target, () => merge.newCategory, (newCat) => {
      merge.newCategory = newCat;
      saveLoreState();
    });
  });
  card.querySelector('[data-action="accept-merge"]').addEventListener('click', () => acceptMerge(merge.id));
  card.querySelector('[data-action="reject-merge"]').addEventListener('click', () => rejectMerge(merge.id));
  card.querySelector('[data-action="edit-merge"]').addEventListener('click', () => editMerge(merge.id, card));

  return card;
}

function createUpdateCard(update) {
  const card = document.createElement('div');
  card.className = `lore-card ${update.category || ''}`;
  let typeBadge = '';
  if (update.isNameUpdate) {
    typeBadge = ' <span style="font-size:9px;background:#f59e0b;color:#000;padding:1px 5px;border-radius:3px;margin-left:4px;">NAME</span>';
  } else if (update.isRelationshipUpdate) {
    typeBadge = ' <span style="font-size:9px;background:#ec4899;color:#fff;padding:1px 5px;border-radius:3px;margin-left:4px;">RELATIONSHIPS</span>';
  } else if (update.isReformat) {
    typeBadge = ' <span style="font-size:9px;background:#a855f7;color:#fff;padding:1px 5px;border-radius:3px;margin-left:4px;">ENRICHED</span>';
  }
  const nameReasonHtml = update.nameReason
    ? `<div style="font-size:11px;color:#f59e0b;margin:4px 8px;">${escapeHtml(update.nameReason)}</div>`
    : '';
  card.innerHTML = `
    <div class="lore-card-header">
      <span class="category-badge editable ${update.category || ''}" title="Click to change type">${((getCategoryDef(update.category) || {}).singularName || update.category || '').toUpperCase()}</span>
      <span class="entry-name">${escapeHtml(update.displayName)}${typeBadge}</span>
    </div>
    ${nameReasonHtml}
    <div class="lore-diff">
      <div class="lore-diff-col"><h5>Current</h5><div>${escapeHtml(update.originalText)}</div></div>
      <div class="lore-diff-col"><h5>Proposed</h5><div>${escapeHtml(update.updatedText)}</div></div>
    </div>
    <div class="lore-card-actions">
      <button class="btn-accept" data-action="accept-update" data-id="${update.id}">Apply</button>
      <button class="btn-edit" data-action="edit-update" data-id="${update.id}">Edit</button>
      <button class="btn-reject" data-action="dismiss-update" data-id="${update.id}">Dismiss</button>
    </div>
  `;

  card.querySelector('.category-badge').addEventListener('click', (e) => {
    e.stopPropagation();
    cycleCategoryBadge(e.target, () => update.category, (newCat) => {
      update.category = newCat;
      saveLoreState();
    });
  });
  card.querySelector('[data-action="accept-update"]').addEventListener('click', () => acceptUpdate(update.id));
  card.querySelector('[data-action="dismiss-update"]').addEventListener('click', () => dismissUpdate(update.id));
  card.querySelector('[data-action="edit-update"]').addEventListener('click', () => editUpdate(update.id, card));

  return card;
}

function showLoreError(msg) {
  loreError.textContent = msg;
  loreError.style.display = '';
}

// Get or create a lorebook category for an entry type
async function getCategoryForType(entryType) {
  if (!state.loreState) return undefined;
  // Migrate old single-category format
  if (state.loreState.loreCategoryId && !state.loreState.loreCategoryIds) {
    state.loreState.loreCategoryIds = {};
  }
  if (!state.loreState.loreCategoryIds) state.loreState.loreCategoryIds = {};

  const catName = getCategoryDisplayName(entryType);
  if (state.loreState.loreCategoryIds[catName]) return state.loreState.loreCategoryIds[catName];

  try {
    const catId = await loreCall('createCategory', { name: catName });
    if (catId) {
      state.loreState.loreCategoryIds[catName] = catId;
      return catId;
    }
  } catch (e) {
    console.error('[Lore] Failed to create category:', catName, e.message);
  }
  return undefined;
}

// Accept entry: write to lorebook via proxy
async function acceptEntry(entryId) {
  if (!state.loreState) return;
  const idx = state.loreState.pendingEntries.findIndex(e => e.id === entryId);
  if (idx === -1) return;

  const entry = state.loreState.pendingEntries[idx];

  // Write to lorebook via proxy (required for writes)
  let success = false;
  await checkLoreProxy();

  // Duplicate guard: check if entry already exists in lorebook
  try {
    const currentEntries = await loreCall('getEntries');
    const newNameLower = entry.displayName.toLowerCase();
    const duplicate = currentEntries.find(e => {
      const n = (e.displayName || '').toLowerCase();
      return n && (n === newNameLower || n.includes(newNameLower) || newNameLower.includes(n));
    });
    if (duplicate) {
      if (!confirm(`"${duplicate.displayName}" already exists in lorebook. Create separate entry for "${entry.displayName}"?`)) {
        showToast(`Skipped "${entry.displayName}"`);
        return;
      }
    }
  } catch (e) { /* proceed on error */ }

  try {
    // Determine category: prefer @type metadata if present, fall back to entry.category
    let entryCategory = entry.category;
    const entryMeta = parseMetadataClient(entry.text);
    if (entryMeta.type) entryCategory = entryMeta.type;
    const categoryId = await getCategoryForType(entryCategory);

    const entryData = {
      displayName: entry.displayName,
      keys: entry.keys,
      text: entry.text,
      category: categoryId,
    };
    const lorebookId = await loreCall('createEntry', entryData);
    success = !!lorebookId;
    if (lorebookId) state.loreState.acceptedEntryIds.push(lorebookId);
  } catch (e) {
    console.error('[Lore] Write failed:', e.message);
  }

  if (success) {
    state.loreState.pendingEntries.splice(idx, 1);
    await saveLoreState();
    showToast(`Added "${entry.displayName}" to lorebook`);
  } else {
    showToast(`Failed to write "${entry.displayName}" — open Script Manager to enable proxy`);
  }
  refreshLoreUI();
}

// Reject entry
async function rejectEntry(entryId) {
  if (!state.loreState) return;
  const idx = state.loreState.pendingEntries.findIndex(e => e.id === entryId);
  if (idx === -1) return;

  const entry = state.loreState.pendingEntries[idx];
  state.loreState.pendingEntries.splice(idx, 1);
  state.loreState.rejectedNames.push(entry.displayName);
  await saveLoreState();
  showToast(`Rejected "${entry.displayName}"`);
  refreshLoreUI();
}

// Edit entry (inline) — strips metadata header from textarea, re-prepends on save
function editEntry(entryId, card) {
  const entry = (state.loreState.pendingEntries || []).find(e => e.id === entryId);
  if (!entry) return;

  const textDiv = card.querySelector('.lore-card-text');
  const meta = parseMetadataClient(entry.text);

  const textarea = document.createElement('textarea');
  textarea.className = 'lore-edit-area';
  textarea.value = meta.rest;
  textDiv.replaceWith(textarea);

  const actions = card.querySelector('.lore-card-actions');
  actions.innerHTML = `
    <button class="btn-accept">Save</button>
    <button class="btn-reject">Cancel</button>
  `;
  actions.querySelector('.btn-accept').addEventListener('click', async () => {
    // Re-prepend original metadata with updated timestamp, including custom keys
    const today = new Date().toISOString().slice(0, 10);
    const knownKeys = new Set(['type', 'v', 'updated', 'source', 'role', 'protagonist']);
    const extras = {};
    for (const [k, v] of Object.entries(meta.all)) {
      if (!knownKeys.has(k)) extras[k] = v;
    }
    entry.text = await window.sceneVisualizer.loreSetMetadata(textarea.value, {
      ...(meta.type ? { type: meta.type } : {}),
      ...(meta.version ? { version: meta.version } : {}),
      ...(meta.source ? { source: meta.source } : {}),
      ...(meta.role ? { role: meta.role } : {}),
      ...(meta.protagonist ? { protagonist: meta.protagonist } : {}),
      updated: today,
      extras,
    });
    await saveLoreState();
    refreshLoreUI();
  });
  actions.querySelector('.btn-reject').addEventListener('click', () => refreshLoreUI());
}

// Accept merge
async function acceptMerge(mergeId) {
  if (!state.loreState) return;
  const idx = state.loreState.pendingMerges.findIndex(m => m.id === mergeId);
  if (idx === -1) return;
  const merge = state.loreState.pendingMerges[idx];

  await checkLoreProxy();
  if (!state.loreProxyReady) {
    showToast('Open Script Manager to enable lorebook writes');
    return;
  }

  // Find existing entry by display name
  const entries = await loreCall('getEntries');
  const existing = entries.find(e => e.displayName.toLowerCase() === merge.existingDisplayName.toLowerCase());
  if (!existing) {
    showToast(`Entry "${merge.existingDisplayName}" not found in lorebook`);
    state.loreState.pendingMerges.splice(idx, 1);
    await saveLoreState();
    refreshLoreUI();
    return;
  }

  // Merge metadata: proposed wins for content keys, existing @role/@protagonist preserved if absent in proposed
  let mergedText = merge.proposedText;
  if (existing.text) {
    const existingMeta = parseMetadataClient(existing.text);
    const proposedMeta = parseMetadataClient(merge.proposedText);
    const preserveFields = {};
    if (existingMeta.role && !proposedMeta.role) preserveFields.role = existingMeta.role;
    if (existingMeta.protagonist && !proposedMeta.protagonist) preserveFields.protagonist = existingMeta.protagonist;
    // Preserve custom keys from existing that aren't in proposed
    const knownKeys = new Set(['type', 'v', 'updated', 'source', 'role', 'protagonist']);
    const extras = {};
    for (const [k, v] of Object.entries(existingMeta.all)) {
      if (!knownKeys.has(k) && !(k in proposedMeta.all)) extras[k] = v;
    }
    if (Object.keys(preserveFields).length > 0 || Object.keys(extras).length > 0) {
      mergedText = await window.sceneVisualizer.loreSetMetadata(merge.proposedText, { ...preserveFields, extras });
    }
  }

  const mergePayload = {
    displayName: merge.proposedDisplayName,
    keys: merge.proposedKeys,
    text: mergedText,
  };
  if (merge.newCategory) {
    const catId = await getCategoryForType(merge.newCategory);
    if (catId) mergePayload.category = catId;
  }
  const success = await loreCall('updateEntry', existing.id, mergePayload);

  if (success) {
    state.loreState.pendingMerges.splice(idx, 1);
    await saveLoreState();
    showToast(`Merged "${merge.newName}" into "${merge.proposedDisplayName}"`);
  } else {
    showToast('Merge failed');
  }
  refreshLoreUI();
  buildFamilyTree();
}

// Reject merge
async function rejectMerge(mergeId) {
  if (!state.loreState) return;
  const idx = state.loreState.pendingMerges.findIndex(m => m.id === mergeId);
  if (idx === -1) return;
  const merge = state.loreState.pendingMerges[idx];
  state.loreState.pendingMerges.splice(idx, 1);
  state.loreState.rejectedMergeNames.push(`${merge.newName.toLowerCase()}->${merge.existingDisplayName.toLowerCase()}`);
  await saveLoreState();
  refreshLoreUI();
}

// Edit merge (inline) — strips metadata header from textarea, re-prepends on save
function editMerge(mergeId, card) {
  const merge = (state.loreState.pendingMerges || []).find(m => m.id === mergeId);
  if (!merge) return;

  const textDiv = card.querySelector('.lore-card-text');
  const meta = parseMetadataClient(merge.proposedText);

  const textarea = document.createElement('textarea');
  textarea.className = 'lore-edit-area';
  textarea.value = meta.rest;
  textDiv.replaceWith(textarea);

  const actions = card.querySelector('.lore-card-actions');
  actions.innerHTML = `
    <button class="btn-accept">Save</button>
    <button class="btn-reject">Cancel</button>
  `;
  actions.querySelector('.btn-accept').addEventListener('click', async () => {
    // Re-prepend original metadata with updated timestamp, including custom keys
    const today = new Date().toISOString().slice(0, 10);
    const knownKeys = new Set(['type', 'v', 'updated', 'source', 'role', 'protagonist']);
    const extras = {};
    for (const [k, v] of Object.entries(meta.all)) {
      if (!knownKeys.has(k)) extras[k] = v;
    }
    merge.proposedText = await window.sceneVisualizer.loreSetMetadata(textarea.value, {
      ...(meta.type ? { type: meta.type } : {}),
      ...(meta.version ? { version: meta.version } : {}),
      ...(meta.source ? { source: meta.source } : {}),
      ...(meta.role ? { role: meta.role } : {}),
      ...(meta.protagonist ? { protagonist: meta.protagonist } : {}),
      updated: today,
      extras,
    });
    await saveLoreState();
    refreshLoreUI();
  });
  actions.querySelector('.btn-reject').addEventListener('click', () => refreshLoreUI());
}

// Accept update
async function acceptUpdate(updateId) {
  if (!state.loreState) return;
  const idx = state.loreState.pendingUpdates.findIndex(u => u.id === updateId);
  if (idx === -1) return;
  const update = state.loreState.pendingUpdates[idx];

  await checkLoreProxy();
  if (!state.loreProxyReady) {
    showToast('Open Script Manager to enable lorebook writes');
    return;
  }

  const entries = await loreCall('getEntries');
  const existing = entries.find(e => e.displayName.toLowerCase() === update.displayName.toLowerCase());
  if (!existing) {
    showToast(`Entry "${update.displayName}" not found`);
    state.loreState.pendingUpdates.splice(idx, 1);
    await saveLoreState();
    refreshLoreUI();
    return;
  }

  const updatePayload = { text: update.updatedText };
  // If this is a name update, also update the displayName in the lorebook
  if (update.isNameUpdate && update.proposedDisplayName) {
    updatePayload.displayName = update.proposedDisplayName;
  }
  if (update.category) {
    const catId = await getCategoryForType(update.category);
    if (catId) updatePayload.category = catId;
  }

  const success = await loreCall('updateEntry', existing.id, updatePayload);

  if (success) {
    state.loreState.pendingUpdates.splice(idx, 1);
    await saveLoreState();
    showToast(`Updated "${update.proposedDisplayName || update.displayName}"`);
  } else {
    showToast('Update failed');
  }
  refreshLoreUI();
  buildFamilyTree();
}

// Dismiss update
async function dismissUpdate(updateId) {
  if (!state.loreState) return;
  const idx = state.loreState.pendingUpdates.findIndex(u => u.id === updateId);
  if (idx === -1) return;
  const update = state.loreState.pendingUpdates[idx];
  state.loreState.pendingUpdates.splice(idx, 1);
  state.loreState.dismissedUpdateNames.push(update.displayName);
  if (update.isReformat) {
    if (!state.loreState.dismissedReformatNames) state.loreState.dismissedReformatNames = [];
    state.loreState.dismissedReformatNames.push(update.displayName);
  }
  await saveLoreState();
  refreshLoreUI();
}

// Edit update (inline)
function editUpdate(updateId, card) {
  const update = (state.loreState.pendingUpdates || []).find(u => u.id === updateId);
  if (!update) return;

  const diffDiv = card.querySelector('.lore-diff');
  const textarea = document.createElement('textarea');
  textarea.className = 'lore-edit-area';
  textarea.value = update.updatedText;
  diffDiv.replaceWith(textarea);

  const actions = card.querySelector('.lore-card-actions');
  actions.innerHTML = `
    <button class="btn-accept">Save</button>
    <button class="btn-reject">Cancel</button>
  `;
  actions.querySelector('.btn-accept').addEventListener('click', async () => {
    update.updatedText = textarea.value;
    await saveLoreState();
    refreshLoreUI();
  });
  actions.querySelector('.btn-reject').addEventListener('click', () => refreshLoreUI());
}

async function runLoreScan(scanType = 'all') {
  if (state.loreIsScanning || !state.currentStoryId) return;

  state.loreIsScanning = true;
  loreScanBtn.disabled = true;
  loreScanStatus.style.display = '';
  loreScanProgressFill.style.width = '0%';
  loreError.style.display = 'none';

  try {
    // Get story text (smart: proxy -> DOM fallback)
    await checkLoreProxy();
    let storyText = await loreCall('getStoryText');

    if (!storyText || storyText.trim().length < 100) {
      showLoreError('Not enough story content to analyze (need at least 100 characters).');
      return;
    }

    // Get existing entries (smart: proxy -> direct React state fallback)
    let existingEntries = await loreCall('getEntries');
    if (!existingEntries || !Array.isArray(existingEntries)) existingEntries = [];

    // Safety: if we have accepted entries but getEntries returned nothing,
    // the proxy/fallback likely failed — warn rather than create duplicates
    const acceptedCount = (state.loreState?.acceptedEntryIds || []).length;
    if (existingEntries.length === 0 && acceptedCount > 0) {
      console.warn('[Lore] getEntries returned empty but we have', acceptedCount, 'accepted entries — lorebook read may have failed');
      showLoreError('Could not read lorebook entries. Open Script Manager and ensure the Lore Creator Proxy script is active.');
      return;
    }

    // Build scan options based on type
    const scanOptions = {};
    if (scanType === 'relationships') {
      scanOptions.relationshipsOnly = true;
    } else if (scanType !== 'all') {
      scanOptions.categoryFilter = scanType;
    }

    const result = await window.sceneVisualizer.loreScan(storyText, existingEntries, state.currentStoryId, scanOptions);

    if (result.success) {
      state.loreState = result.state;
      await saveLoreState();
      state.loreLastStoryLength = storyText.length;

      if (result.noResults) {
        showToast('No new lore elements found');
      } else if (result.summary) {
        const parts = [];
        if (result.summary.generated > 0) parts.push(`${result.summary.generated} entries`);
        if (result.summary.mergesFound > 0) parts.push(`${result.summary.mergesFound} merges`);
        if (result.summary.updatesFound > 0) parts.push(`${result.summary.updatesFound} updates`);
        if (result.summary.relationshipUpdatesFound > 0) parts.push(`${result.summary.relationshipUpdatesFound} relationship updates`);
        if (result.summary.nameProposals > 0) parts.push(`${result.summary.nameProposals} name updates`);
        if (result.summary.optimized > 0) parts.push(`${result.summary.optimized} optimized`);
        showToast(`Found ${parts.join(' and ')}`);
      }
    } else {
      showLoreError(result.error || 'Scan failed');
    }
  } catch (e) {
    showLoreError(e.message || 'Scan failed');
  } finally {
    loreScanProgressFill.style.width = '100%';
    loreScanPhase.textContent = 'Scan complete';
    state.loreIsScanning = false;
    loreScanBtn.disabled = false;
    refreshLoreUI();
    buildFamilyTree();
    setTimeout(() => {
      loreScanStatus.style.display = 'none';
      loreScanProgressFill.style.width = '0%';
    }, 1500);
  }
}

async function runLoreOrganize() {
  if (state.loreIsOrganizing || state.loreIsScanning || !state.currentStoryId) return;

  state.loreIsOrganizing = true;
  loreOrganizeBtn.disabled = true;
  loreScanStatus.style.display = '';
  loreScanPhase.textContent = 'Organizing...';
  loreError.style.display = 'none';

  try {
    await checkLoreProxy();
    let storyText = await loreCall('getStoryText');
    let entries = await loreCall('getEntries');

    if (!entries || entries.length === 0) {
      showLoreError('No lorebook entries to organize.');
      return;
    }

    // Build reverse categoryMap from loreCategoryIds
    if (!state.loreState) state.loreState = { pendingEntries: [], pendingMerges: [], pendingUpdates: [], acceptedEntryIds: [], rejectedNames: [], dismissedUpdateNames: [], rejectedMergeNames: [], charsSinceLastScan: 0, loreCategoryIds: {}, pendingCleanups: [], dismissedCleanupIds: [] };
    const categoryMap = {};
    for (const [catName, catId] of Object.entries(state.loreState.loreCategoryIds || {})) {
      if (catId) categoryMap[catId] = catName;
    }

    const result = await window.sceneVisualizer.loreOrganize(
      entries, storyText || '', state.currentStoryId, categoryMap
    );

    if (result.success) {
      if (!state.loreState.pendingCleanups) state.loreState.pendingCleanups = [];
      if (!state.loreState.dismissedCleanupIds) state.loreState.dismissedCleanupIds = [];
      state.loreState.pendingCleanups = result.cleanups || [];
      await saveLoreState();

      if (result.cleanups && result.cleanups.length > 0) {
        showToast(`Found ${result.cleanups.length} cleanup suggestions`);
      } else {
        showToast('Lorebook is already well-organized');
      }
    } else {
      showLoreError(result.error || 'Organize failed');
    }
  } catch (e) {
    showLoreError(e.message || 'Organize failed');
  } finally {
    state.loreIsOrganizing = false;
    loreOrganizeBtn.disabled = false;
    loreScanStatus.style.display = 'none';
    refreshLoreUI();
  }
}

function createCleanupCard(cleanup) {
  const card = document.createElement('div');
  card.className = 'lore-card cleanup';
  card.dataset.cleanupId = cleanup.id;

  if (cleanup.type === 'duplicate') {
    card.innerHTML = `
      <div class="lore-card-header">
        <span class="category-badge cleanup">DUPLICATE</span>
        <span class="entry-name">${cleanup.keepEntry.displayName} + ${cleanup.removeEntry.displayName}</span>
      </div>
      <div class="cleanup-comparison">
        <div class="cleanup-col">
          <h5>Keep: ${cleanup.keepEntry.displayName}</h5>
          <div class="cleanup-text">${cleanup.keepEntry.text.slice(0, 200)}</div>
        </div>
        <div class="cleanup-col">
          <h5>Remove: ${cleanup.removeEntry.displayName}</h5>
          <div class="cleanup-text">${cleanup.removeEntry.text.slice(0, 200)}</div>
        </div>
      </div>
      <div style="font-size:10px;color:#f59e0b;margin-bottom:6px;">${cleanup.reason || ''}</div>
      <div class="lore-card-actions">
        <button class="btn-accept" data-action="accept-cleanup">Merge</button>
        <button class="btn-reject" data-action="reject-cleanup">Dismiss</button>
      </div>
    `;
  } else if (cleanup.type === 'duplicate-group') {
    const removeNames = cleanup.removeEntries.map(e => escapeHtml(e.displayName)).join(', ');
    const totalCount = 1 + cleanup.removeEntries.length;
    card.innerHTML = `
      <div class="lore-card-header">
        <span class="category-badge cleanup">DUPLICATES (${totalCount})</span>
        <span class="entry-name">${escapeHtml(cleanup.keepEntry.displayName)}</span>
      </div>
      <div style="font-size:11px;color:#bbb;margin-bottom:6px;">
        <div style="margin-bottom:4px;"><strong style="color:#10b981;">Keep:</strong> ${escapeHtml(cleanup.keepEntry.displayName)}</div>
        <div><strong style="color:#ef4444;">Remove:</strong> ${removeNames}</div>
      </div>
      <details style="margin-bottom:6px;">
        <summary style="font-size:10px;color:#888;cursor:pointer;">Merged text preview</summary>
        <div class="cleanup-text" style="margin-top:4px;max-height:150px;overflow-y:auto;">${escapeHtml((cleanup.mergedText || '').slice(0, 500))}</div>
      </details>
      <div style="font-size:10px;color:#f59e0b;margin-bottom:6px;">${escapeHtml(cleanup.reason || '')}</div>
      <div class="lore-card-actions">
        <button class="btn-accept" data-action="accept-cleanup">Merge All</button>
        <button class="btn-reject" data-action="reject-cleanup">Dismiss</button>
      </div>
    `;
  } else if (cleanup.type === 'add-metadata') {
    const metaDef = getCategoryDef(cleanup.proposedType);
    const metaLabel = metaDef ? metaDef.singularName.toUpperCase() : (cleanup.proposedType || '').toUpperCase();
    card.className = `lore-card cleanup ${cleanup.proposedType || ''}`;
    card.innerHTML = `
      <div class="lore-card-header">
        <span class="category-badge cleanup">ADD HEADER</span>
        <span class="entry-name">${cleanup.displayName}</span>
      </div>
      <div style="font-size:11px;color:#bbb;margin-bottom:8px;display:flex;align-items:center;gap:6px;">
        Add @type: <span class="category-badge editable ${cleanup.proposedType || ''}" title="Click to change type">${metaLabel}</span> metadata header
      </div>
      <div class="lore-card-actions">
        <button class="btn-accept" data-action="accept-cleanup">Add Header</button>
        <button class="btn-reject" data-action="reject-cleanup">Dismiss</button>
      </div>
    `;

    // Wire category badge cycling for add-metadata cards
    card.querySelector('.category-badge.editable').addEventListener('click', (e) => {
      e.stopPropagation();
      cycleCategoryBadge(e.target, () => cleanup.proposedType, (newCat) => {
        cleanup.proposedType = newCat;
        saveLoreState();
      });
    });
  } else {
    // recategorize or legacy-move
    const label = cleanup.type === 'legacy-move' ? 'UNCATEGORIZED' : 'MISPLACED';
    const proposedDef = getCategoryDef(cleanup.proposedType);
    const proposedLabel = proposedDef ? proposedDef.singularName.toUpperCase() : (cleanup.proposedType || '').toUpperCase();
    card.className = `lore-card cleanup ${cleanup.proposedType || ''}`;
    card.innerHTML = `
      <div class="lore-card-header">
        <span class="category-badge cleanup">${label}</span>
        <span class="entry-name">${cleanup.displayName}</span>
      </div>
      <div style="font-size:11px;color:#bbb;margin-bottom:8px;display:flex;align-items:center;gap:6px;flex-wrap:wrap;">
        <span style="color:#888;">${cleanup.currentCategory}</span>
        <span class="cleanup-arrow"> → </span>
        <span class="category-badge editable ${cleanup.proposedType || ''}" title="Click to change">${proposedLabel}</span>
        <button class="btn-new-cat" title="Create new category" style="background:none;border:1px solid #555;color:#aaa;font-size:10px;padding:1px 6px;border-radius:3px;cursor:pointer;">+ New</button>
      </div>
      <div class="cleanup-new-cat-form" style="display:none;margin-bottom:8px;gap:6px;align-items:center;flex-wrap:wrap;">
        <input type="text" placeholder="Category name" class="new-cat-name" style="background:#2a2a40;border:1px solid #555;color:#eee;padding:3px 6px;font-size:11px;border-radius:3px;width:120px;">
        <input type="color" value="#ff9900" class="new-cat-color" style="width:28px;height:22px;border:none;padding:0;cursor:pointer;background:transparent;">
        <button class="new-cat-confirm" style="background:#10b981;color:#fff;border:none;padding:3px 8px;font-size:10px;border-radius:3px;cursor:pointer;">Add</button>
        <button class="new-cat-cancel" style="background:none;border:1px solid #555;color:#aaa;padding:3px 8px;font-size:10px;border-radius:3px;cursor:pointer;">Cancel</button>
      </div>
      <div class="lore-card-actions">
        <button class="btn-accept" data-action="accept-cleanup">Move</button>
        <button class="btn-reject" data-action="reject-cleanup">Dismiss</button>
      </div>
    `;

    // Wire category badge cycling
    card.querySelector('.category-badge.editable').addEventListener('click', (e) => {
      e.stopPropagation();
      cycleCategoryBadge(e.target, () => cleanup.proposedType, (newCat) => {
        cleanup.proposedType = newCat;
        cleanup.proposedCategory = getCategoryDisplayName(newCat);
        cleanup.proposedCategoryId = null;
        saveLoreState();
      });
    });

    // Wire "+ New" button
    const newCatForm = card.querySelector('.cleanup-new-cat-form');
    card.querySelector('.btn-new-cat').addEventListener('click', (e) => {
      e.stopPropagation();
      newCatForm.style.display = 'flex';
    });
    newCatForm.querySelector('.new-cat-cancel').addEventListener('click', (e) => {
      e.stopPropagation();
      newCatForm.style.display = 'none';
      newCatForm.querySelector('.new-cat-name').value = '';
    });
    newCatForm.querySelector('.new-cat-confirm').addEventListener('click', async (e) => {
      e.stopPropagation();
      const nameInput = newCatForm.querySelector('.new-cat-name');
      const colorInput = newCatForm.querySelector('.new-cat-color');
      const name = nameInput.value.trim();
      if (!name) { showToast('Enter a category name'); return; }
      const id = slugifyCategory(name);
      if (!id) { showToast('Invalid category name'); return; }
      const color = colorInput.value || '#ff9900';
      const { singular, plural } = deriveSingularPlural(name);
      const result = await window.sceneVisualizer.loreAddCustomCategory(state.currentStoryId, {
        id, displayName: plural, singularName: singular, color,
      });
      if (result.success) {
        await loadCategoryRegistry();
        cleanup.proposedType = id;
        cleanup.proposedCategory = plural;
        cleanup.proposedCategoryId = null;
        // Update the badge
        const badge = card.querySelector('.category-badge.editable');
        badge.className = `category-badge editable ${id}`;
        badge.textContent = singular.toUpperCase();
        // Update card border color
        for (const cat of getCategoryIds()) card.classList.remove(cat);
        card.classList.add(id);
        saveLoreState();
        showToast(`Added category "${singular}"`);
        newCatForm.style.display = 'none';
        nameInput.value = '';
      } else {
        showToast(result.error || 'Failed to add category');
      }
    });
  }

  card.querySelector('[data-action="accept-cleanup"]').addEventListener('click', () => acceptCleanup(cleanup.id));
  card.querySelector('[data-action="reject-cleanup"]').addEventListener('click', () => rejectCleanup(cleanup.id));

  return card;
}

async function acceptCleanup(cleanupId) {
  if (!state.loreState || !state.loreState.pendingCleanups) return;
  const idx = state.loreState.pendingCleanups.findIndex(c => c.id === cleanupId);
  if (idx === -1) return;
  const cleanup = state.loreState.pendingCleanups[idx];

  await checkLoreProxy();
  if (!state.loreProxyReady) {
    showToast('Open Script Manager to enable lorebook writes');
    return;
  }

  if (cleanup.type === 'duplicate') {
    // Update keep entry with merged text/keys
    const entries = await loreCall('getEntries');
    console.log(`[Lore] Pairwise merge: keeper id=${cleanup.keepEntry.id} name="${cleanup.keepEntry.displayName}", remove id=${cleanup.removeEntry.id} name="${cleanup.removeEntry.displayName}"`);
    const keepEntry = entries.find(e => e.id === cleanup.keepEntry.id || e.displayName.toLowerCase() === cleanup.keepEntry.displayName.toLowerCase());
    const keepId = keepEntry ? keepEntry.id : null;
    console.log(`[Lore] Keeper found: ${keepEntry ? `id=${keepEntry.id}` : 'NOT FOUND'}`);

    if (keepEntry) {
      await loreCall('updateEntry', keepEntry.id, {
        text: cleanup.mergedText,
        keys: cleanup.mergedKeys,
      });
    }
    // Exclude keeper ID so name-based fallback doesn't match it
    const removeEntry = entries.find(e =>
      e.id !== keepId && (e.id === cleanup.removeEntry.id || e.displayName.toLowerCase() === cleanup.removeEntry.displayName.toLowerCase())
    );
    console.log(`[Lore] Remove found: ${removeEntry ? `id=${removeEntry.id}` : 'NOT FOUND'}`);
    if (removeEntry) {
      const deleteResult = await loreCall('deleteEntry', removeEntry.id);
      console.log(`[Lore] Delete result:`, deleteResult);
    }
    showToast(`Merged "${cleanup.removeEntry.displayName}" into "${cleanup.keepEntry.displayName}"`);
  } else if (cleanup.type === 'duplicate-group') {
    // N-way merge: update keeper, delete all others
    const entries = await loreCall('getEntries');
    console.log(`[Lore] Duplicate-group merge: ${entries.length} entries in lorebook`);
    console.log(`[Lore] Looking for keeper: id=${cleanup.keepEntry.id}, name="${cleanup.keepEntry.displayName}"`);
    const keepEntry = entries.find(e => e.id === cleanup.keepEntry.id || e.displayName.toLowerCase() === cleanup.keepEntry.displayName.toLowerCase());
    const keepId = keepEntry ? keepEntry.id : null;
    console.log(`[Lore] Keeper found: ${keepEntry ? `id=${keepEntry.id}, name="${keepEntry.displayName}"` : 'NOT FOUND'}`);

    if (keepEntry) {
      await loreCall('updateEntry', keepEntry.id, {
        text: cleanup.mergedText,
        keys: cleanup.mergedKeys,
      });
      console.log(`[Lore] Keeper updated with merged text (${(cleanup.mergedText || '').length} chars)`);
    }

    // Delete all removeEntries — exclude keeper ID and already-deleted IDs
    // to avoid matching the wrong entry when names collide
    let deleted = 0;
    const deletedIds = new Set();
    if (keepId) deletedIds.add(keepId);
    for (const re of cleanup.removeEntries) {
      console.log(`[Lore] Looking for removal: id=${re.id}, name="${re.displayName}"`);
      // Prefer ID match, fall back to name match excluding already-processed entries
      const removeEntry = entries.find(e =>
        !deletedIds.has(e.id) && (e.id === re.id || e.displayName.toLowerCase() === re.displayName.toLowerCase())
      );
      if (removeEntry) {
        console.log(`[Lore] Deleting: id=${removeEntry.id}, name="${removeEntry.displayName}"`);
        const deleteResult = await loreCall('deleteEntry', removeEntry.id);
        console.log(`[Lore] Delete result:`, deleteResult);
        deletedIds.add(removeEntry.id);
        deleted++;
      } else {
        console.warn(`[Lore] Removal target NOT FOUND: id=${re.id}, name="${re.displayName}"`);
      }
    }
    showToast(`Merged ${deleted + 1} entries into "${cleanup.keepEntry.displayName}"`);
  } else if (cleanup.type === 'add-metadata') {
    // Prepend metadata header to existing entry text
    const metadataResult = await window.sceneVisualizer.loreSetMetadata(cleanup.currentText, {
      type: cleanup.proposedType,
      updated: new Date().toISOString().slice(0, 10),
      source: 'import',
    });
    if (metadataResult) {
      await loreCall('updateEntry', cleanup.entryId, { text: metadataResult });
      showToast(`Added header to "${cleanup.displayName}"`);
    } else {
      showToast('Failed to add metadata header');
    }
  } else {
    // recategorize or legacy-move
    const catId = cleanup.proposedCategoryId || await getCategoryForType(cleanup.proposedType);
    if (catId) {
      await loreCall('updateEntry', cleanup.entryId, { category: catId });
      showToast(`Moved "${cleanup.displayName}" to ${cleanup.proposedCategory}`);
    } else {
      showToast(`Could not find/create category "${cleanup.proposedCategory}"`);
    }
  }

  state.loreState.pendingCleanups.splice(idx, 1);
  await saveLoreState();
  refreshLoreUI();
  buildFamilyTree();
}

async function rejectCleanup(cleanupId) {
  if (!state.loreState || !state.loreState.pendingCleanups) return;
  const idx = state.loreState.pendingCleanups.findIndex(c => c.id === cleanupId);
  if (idx === -1) return;
  const cleanup = state.loreState.pendingCleanups[idx];

  state.loreState.pendingCleanups.splice(idx, 1);
  if (!state.loreState.dismissedCleanupIds) state.loreState.dismissedCleanupIds = [];
  state.loreState.dismissedCleanupIds.push(cleanup.id);
  await saveLoreState();
  refreshLoreUI();
}

// ---- Reformat Entry (for pending entries with templates) ----
async function reformatEntry(entryId) {
  if (!state.loreState) return;
  const entry = state.loreState.pendingEntries.find(e => e.id === entryId);
  const templateTypes = ['character', 'location', 'item', 'faction', 'concept'];
  if (!entry || !templateTypes.includes(entry.category)) return;

  const card = lorePendingList.querySelector(`[data-entry-id="${entryId}"]`);
  if (card) {
    const btn = card.querySelector('.btn-reformat');
    if (btn) { btn.disabled = true; btn.textContent = '...'; }
  }

  try {
    // Get story text for enrichment context
    let storyText = '';
    try {
      await checkLoreProxy();
      storyText = await loreCall('getStoryText') || '';
    } catch (_) {}

    const result = await window.sceneVisualizer.loreReformatEntry(entry.displayName, entry.text, storyText, state.currentStoryId, entry.category);
    if (result.success && result.result) {
      entry.text = result.result;
      await saveLoreState();
      showToast(`Enriched "${entry.displayName}"`);
      refreshLoreUI();
    } else {
      showToast(result.error || 'Reformat failed');
    }
  } catch (e) {
    showToast('Reformat failed: ' + (e.message || 'Unknown error'));
  }

  if (card) {
    const btn = card.querySelector('.btn-reformat');
    if (btn) { btn.disabled = false; btn.textContent = 'Reformat'; }
  }
}

// ---- Enrich entry ----
async function runEnrich() {
  const promptText = loreEnrichInput.value.trim();
  if (!promptText) return;

  loreEnrichBtn.disabled = true;
  loreEnrichBtn.textContent = '...';
  loreEnrichPreview.style.display = 'none';

  try {
    // Get entries for target identification (loreCall falls back to direct access)
    let entries = [];
    try {
      entries = await loreCall('getEntries');
    } catch (e) {
      console.log('[LoreEnrich] Failed to get entries:', e.message);
    }

    if (entries.length === 0) {
      showLoreError('No lorebook entries found. Create some entries first.');
      return;
    }

    // Pass 1: Identify target
    const identifyResult = await window.sceneVisualizer.loreIdentifyTarget(promptText, entries);
    if (!identifyResult.success || !identifyResult.result || identifyResult.result.confidence < 2) {
      showLoreError('Could not identify which entry to update. Try mentioning the entry name.');
      return;
    }

    const targetEntry = identifyResult.result.entry;

    // Pass 2: Generate enriched text
    const enrichResult = await window.sceneVisualizer.loreGenerateEnriched(
      promptText,
      targetEntry.text || '',
      targetEntry.displayName
    );

    if (!enrichResult.success || !enrichResult.result) {
      showLoreError('Failed to generate updated text.');
      return;
    }

    // Show preview
    state.loreEnrichResult = {
      entry: targetEntry,
      originalText: targetEntry.text || '',
      updatedText: enrichResult.result,
      displayName: targetEntry.displayName,
    };

    loreEnrichTarget.textContent = targetEntry.displayName;
    loreEnrichOld.textContent = targetEntry.text || '(empty)';
    loreEnrichNew.textContent = enrichResult.result;
    loreEnrichPreview.style.display = '';
  } catch (e) {
    showLoreError(e.message || 'Enrich failed');
  } finally {
    loreEnrichBtn.disabled = false;
    loreEnrichBtn.textContent = 'Enrich';
  }
}

// ---- Create Entry ----
async function runLoreCreate() {
  const promptText = loreCreateInput.value.trim();
  if (!promptText || !state.currentStoryId) return;

  loreCreateBtn.disabled = true;
  loreCreateBtn.textContent = '...';
  loreCreatePreview.style.display = 'none';
  state.loreCreateResults = [];

  try {
    // Get story text (smart fallback)
    await checkLoreProxy();
    let storyText = await loreCall('getStoryText');

    const category = loreCreateCategory.value;
    const result = await window.sceneVisualizer.loreCreateFromPrompt(promptText, category, storyText, state.currentStoryId);

    if (result.success && result.entries && result.entries.length > 0) {
      state.loreCreateResults = result.entries;
      renderCreatePreview();
    } else {
      showToast(result.error || 'No entries generated');
    }
  } catch (e) {
    showToast('Create failed: ' + (e.message || 'Unknown error'));
  } finally {
    loreCreateBtn.disabled = false;
    loreCreateBtn.textContent = 'Create';
  }
}

function renderCreatePreview() {
  loreCreatePreview.innerHTML = '';
  loreCreatePreview.style.display = '';

  // Accept All button if multiple entries
  if (state.loreCreateResults.length > 1) {
    const acceptAllBar = document.createElement('div');
    acceptAllBar.className = 'lore-create-accept-all';
    const acceptAllBtn = document.createElement('button');
    acceptAllBtn.textContent = `Accept All (${state.loreCreateResults.length})`;
    acceptAllBtn.addEventListener('click', async () => {
      for (const entry of [...state.loreCreateResults]) {
        await acceptCreatedEntry(entry);
      }
      state.loreCreateResults = [];
      loreCreatePreview.style.display = 'none';
      loreCreateInput.value = '';
    });
    acceptAllBar.appendChild(acceptAllBtn);
    loreCreatePreview.appendChild(acceptAllBar);
  }

  for (const entry of state.loreCreateResults) {
    loreCreatePreview.appendChild(createCreatedEntryCard(entry));
  }
}

function createCreatedEntryCard(entry) {
  const card = document.createElement('div');
  card.className = `lore-card ${entry.category || ''}`;
  card.dataset.createId = entry.id;
  card.innerHTML = `
    <div class="lore-card-header">
      <span class="category-badge ${entry.category || ''}">${(entry.category || '').toUpperCase()}</span>
      <span class="entry-name">${escapeHtml(entry.displayName)}</span>
    </div>
    <div class="lore-card-text">${escapeHtml(entry.text)}</div>
    <div class="lore-card-keys">Keys: ${(entry.keys || []).map(k => escapeHtml(k)).join(', ')}</div>
    <div class="lore-card-actions">
      <button class="btn-accept">Accept</button>
      <button class="btn-edit">Edit</button>
      <button class="btn-reject">Reject</button>
    </div>
  `;

  card.querySelector('.btn-accept').addEventListener('click', async () => {
    await acceptCreatedEntry(entry);
    state.loreCreateResults = state.loreCreateResults.filter(e => e.id !== entry.id);
    if (state.loreCreateResults.length === 0) {
      loreCreatePreview.style.display = 'none';
      loreCreateInput.value = '';
    } else {
      renderCreatePreview();
    }
  });

  card.querySelector('.btn-edit').addEventListener('click', () => {
    const textDiv = card.querySelector('.lore-card-text');
    const textarea = document.createElement('textarea');
    textarea.className = 'lore-edit-area';
    textarea.value = entry.text;
    textDiv.replaceWith(textarea);

    const actions = card.querySelector('.lore-card-actions');
    actions.innerHTML = '<button class="btn-accept">Save</button><button class="btn-reject">Cancel</button>';
    actions.querySelector('.btn-accept').addEventListener('click', () => {
      entry.text = textarea.value;
      renderCreatePreview();
    });
    actions.querySelector('.btn-reject').addEventListener('click', () => renderCreatePreview());
  });

  card.querySelector('.btn-reject').addEventListener('click', () => {
    state.loreCreateResults = state.loreCreateResults.filter(e => e.id !== entry.id);
    if (state.loreCreateResults.length === 0) {
      loreCreatePreview.style.display = 'none';
    } else {
      renderCreatePreview();
    }
  });

  return card;
}

async function acceptCreatedEntry(entry) {
  let success = false;
  await checkLoreProxy();
  if (state.loreProxyReady) {
    if (!state.loreState) {
      state.loreState = { pendingEntries: [], pendingMerges: [], pendingUpdates: [], acceptedEntryIds: [], rejectedNames: [], dismissedUpdateNames: [], rejectedMergeNames: [], charsSinceLastScan: 0, loreCategoryIds: {}, pendingCleanups: [], dismissedCleanupIds: [] };
    }
    const categoryId = await getCategoryForType(entry.category);

    const entryData = {
      displayName: entry.displayName,
      keys: entry.keys,
      text: entry.text,
      category: categoryId,
    };
    const lorebookId = await loreCall('createEntry', entryData);
    success = !!lorebookId;
    if (lorebookId) state.loreState.acceptedEntryIds.push(lorebookId);
  }

  if (success) {
    await saveLoreState();
    showToast(`Added "${entry.displayName}" to lorebook`);
  } else {
    showToast(`Failed to write "${entry.displayName}" — open Script Manager to enable writes`);
  }
}

// ---- Family Tree Visualization ----
export async function buildFamilyTree() {
  const section = familyTreeSection;
  const container = familyTreeContainer;
  const countEl = familyTreeCount;
  if (!section || !container) return;

  // Gather character entries from lorebook and pending
  let entries = [];
  try {
    await checkLoreProxy();
    const lorebookEntries = await loreCall('getEntries');
    entries = lorebookEntries.filter(e => {
      if (!e.text || e.text.length < 30) return false;
      return /^Name:/m.test(e.text) || /\b(he|she|they)\s+(is|are|was|were)\b/i.test(e.text);
    });
  } catch (_) {}

  // Also include pending character entries
  if (state.loreState && state.loreState.pendingEntries) {
    for (const pe of state.loreState.pendingEntries) {
      if (pe.category === 'character' && pe.text) {
        entries.push(pe);
      }
    }
  }

  if (entries.length < 2) {
    section.style.display = 'none';
    return;
  }

  // Parse family data from each entry
  const characters = entries.map(e => {
    const nameField = (e.text.match(/^Name:\s*(.*)/m) || [])[1] || e.displayName || '';
    const name = nameField.trim();
    const familyLines = [];
    const relationLines = [];

    // Parse Family: section
    const familyMatch = e.text.match(/^Family:\s*(.*(?:\n\s*-\s+.*)*)/m);
    if (familyMatch) {
      const block = familyMatch[1];
      const lines = block.split('\n');
      for (const line of lines) {
        const m = line.match(/^\s*-\s+(.+?):\s+(.+)/);
        if (m) familyLines.push({ name: m[1].trim(), role: m[2].trim() });
      }
    }

    // Parse Relationships: section
    const relMatch = e.text.match(/^Relationships:\s*(.*(?:\n\s*-\s+.*)*)/m);
    if (relMatch) {
      const block = relMatch[1];
      const lines = block.split('\n');
      for (const line of lines) {
        const m = line.match(/^\s*-\s+(.+?):\s+(.+)/);
        if (m) relationLines.push({ name: m[1].trim(), role: m[2].trim() });
      }
    }

    // Extract last name
    const nameParts = name.split(/\s+/);
    const lastName = nameParts.length > 1 ? nameParts[nameParts.length - 1] : null;

    return { name, lastName, family: familyLines, relationships: relationLines, displayName: e.displayName };
  });

  // Union-find for grouping characters by explicit family references
  const parent = new Map();
  const charByName = new Map();
  for (let i = 0; i < characters.length; i++) {
    parent.set(i, i);
    charByName.set(characters[i].name.toLowerCase(), i);
    const firstName = characters[i].name.split(/\s+/)[0].toLowerCase();
    if (!charByName.has(firstName)) charByName.set(firstName, i);
  }

  function find(x) {
    while (parent.get(x) !== x) {
      parent.set(x, parent.get(parent.get(x)));
      x = parent.get(x);
    }
    return x;
  }
  function union(a, b) {
    const ra = find(a), rb = find(b);
    if (ra !== rb) parent.set(ra, rb);
  }

  function findCharIndex(refName) {
    const lower = refName.toLowerCase().trim();
    if (charByName.has(lower)) return charByName.get(lower);
    const first = lower.split(/\s+/)[0];
    if (charByName.has(first)) return charByName.get(first);
    for (const [key, idx] of charByName) {
      if (key.includes(first) || first.includes(key)) return idx;
    }
    return -1;
  }

  // Union characters linked by Family fields
  for (let i = 0; i < characters.length; i++) {
    for (const fam of characters[i].family) {
      const j = findCharIndex(fam.name);
      if (j >= 0 && j !== i) union(i, j);
    }
  }

  // Also union characters sharing last names
  const lastNameMap = new Map();
  for (let i = 0; i < characters.length; i++) {
    if (characters[i].lastName) {
      const ln = characters[i].lastName.toLowerCase();
      if (lastNameMap.has(ln)) {
        union(i, lastNameMap.get(ln));
      } else {
        lastNameMap.set(ln, i);
      }
    }
  }

  // Build groups from union-find
  const groups = new Map();
  for (let i = 0; i < characters.length; i++) {
    const root = find(i);
    if (!groups.has(root)) groups.set(root, []);
    groups.get(root).push(i);
  }

  function getRoleLabel(memberIdx, groupIndices) {
    for (const otherIdx of groupIndices) {
      if (otherIdx === memberIdx) continue;
      for (const fam of characters[otherIdx].family) {
        const refIdx = findCharIndex(fam.name);
        if (refIdx === memberIdx) {
          return fam.role;
        }
      }
    }
    return null;
  }

  // Render
  let html = '';
  let groupCount = 0;

  for (const [, memberIndices] of groups) {
    if (memberIndices.length < 2) continue;
    groupCount++;

    let label = null;
    for (const idx of memberIndices) {
      if (characters[idx].lastName) {
        label = `${characters[idx].lastName} Family`;
        break;
      }
    }
    if (!label) label = `${characters[memberIndices[0]].name}'s Family`;

    html += `<div style="margin-bottom:12px;border:1px solid #333;border-radius:6px;overflow:hidden;">`;
    html += `<div style="background:#2a2a4a;padding:6px 10px;font-weight:600;color:#e94560;font-size:12px;">${escapeHtml(label)}</div>`;
    html += `<div style="padding:6px 10px;">`;

    for (const idx of memberIndices) {
      const member = characters[idx];
      const role = getRoleLabel(idx, memberIndices);
      html += `<div style="margin:3px 0;padding:3px 0;border-bottom:1px solid #222;">`;
      html += `<span style="color:#ccc;font-size:12px;">${escapeHtml(member.name)}</span>`;
      if (role) {
        html += ` <span style="color:#e94560;font-size:10px;font-style:italic;">(${escapeHtml(role)})</span>`;
      }

      if (member.family.length > 0) {
        const famStr = member.family.map(f => `<span style="color:#888;font-size:10px;">${escapeHtml(f.name)} (${escapeHtml(f.role)})</span>`).join(', ');
        html += `<div style="margin-left:16px;margin-top:2px;">${famStr}</div>`;
      }

      if (member.relationships.length > 0) {
        const relStr = member.relationships.map(r => `<span style="color:#6a9ec9;font-size:10px;">${escapeHtml(r.name)} (${escapeHtml(r.role)})</span>`).join(', ');
        html += `<div style="margin-left:16px;margin-top:2px;">${relStr}</div>`;
      }
      html += `</div>`;
    }

    html += `</div></div>`;
  }

  if (groupCount > 0) {
    container.innerHTML = html;
    countEl.textContent = `(${groupCount})`;
    section.style.display = '';
  } else {
    section.style.display = 'none';
  }
}

// =========================================================================
// STORY COMPREHENSION UI
// =========================================================================

export function renderComprehensionState(compState) {
  if (!compState || !compState.masterSummary) {
    comprehensionStatusText.textContent = 'Not scanned';
    comprehensionProgressFill.style.width = '0%';
    masterSummaryDisplay.style.display = 'none';
    entityProfilesList.style.display = 'none';
    return;
  }

  const pct = compState.totalStoryLength > 0
    ? Math.round((compState.lastProcessedLength / compState.totalStoryLength) * 100)
    : 100;
  comprehensionStatusText.textContent = `${compState.chunks?.length || 0} chunks processed`;
  comprehensionProgressFill.style.width = pct + '%';

  if (compState.masterSummary) {
    masterSummaryDisplay.style.display = '';
    masterSummaryText.textContent = compState.masterSummary;
  } else {
    masterSummaryDisplay.style.display = 'none';
  }

  const profiles = compState.entityProfiles || {};
  const profileKeys = Object.keys(profiles);
  if (profileKeys.length > 0) {
    entityProfilesList.style.display = '';
    entityCount.textContent = profileKeys.length;
    entityProfileCards.innerHTML = '';

    const sorted = profileKeys
      .map(k => ({ name: k, ...profiles[k] }))
      .sort((a, b) => (b.lastChunkIndex || 0) - (a.lastChunkIndex || 0));

    for (const entity of sorted) {
      const card = document.createElement('div');
      card.className = `entity-profile-card ${entity.category || ''}`;
      const detailParts = [entity.traits, entity.relationships, entity.status].filter(p => p);
      card.innerHTML = `
        <div class="entity-header">
          <span class="category-badge ${entity.category || ''}">${entity.category || '?'}</span>
          <span class="entity-name">${escapeHtml(entity.name)}</span>
        </div>
        <div class="entity-detail">${escapeHtml(detailParts.join(' | '))}</div>
      `;
      card.addEventListener('click', () => card.classList.toggle('expanded'));
      entityProfileCards.appendChild(card);
    }
  } else {
    entityProfilesList.style.display = 'none';
  }
}

async function loadComprehensionState() {
  if (!state.currentStoryId) {
    console.log('[Comprehension] No currentStoryId, skipping load');
    renderComprehensionState(null);
    return;
  }
  console.log('[Comprehension] Loading state for story:', state.currentStoryId);
  const compState = await window.sceneVisualizer.loreGetComprehension(state.currentStoryId);
  console.log('[Comprehension] Got state:', compState ? `masterSummary=${!!compState.masterSummary}, entities=${Object.keys(compState.entityProfiles || {}).length}` : 'null');
  renderComprehensionState(compState);
}

// LLM indicator
async function updateLlmIndicator(provider, model) {
  const primary = provider === 'ollama'
    ? 'Ollama ' + (model || 'mistral:7b')
    : 'NovelAI GLM-4-6';

  // Check if hybrid is enabled in settings and secondary is available
  const hybridEnabled = loreHybridToggle.checked;
  let hybridLabel = '';
  if (hybridEnabled) {
    try {
      if (provider === 'ollama') {
        hybridLabel = ' + NovelAI';
      } else {
        const ollamaStatus = await window.sceneVisualizer.loreCheckOllama();
        if (ollamaStatus.available) {
          hybridLabel = ' + Ollama';
        }
      }
    } catch {}
  }

  if (hybridLabel) {
    loreLlmIndicator.innerHTML = 'LLM: <span>' + primary + '</span> <span style="color:#22c55e;font-weight:bold;">&#9889; Hybrid</span> <span style="color:#888;font-size:9px;">(' + primary + hybridLabel + ')</span>';
  } else {
    loreLlmIndicator.innerHTML = 'LLM: <span>' + primary + '</span>';
  }
}

function saveLoreSettings() {
  const cats = {};
  if (loreCategoryToggles) {
    loreCategoryToggles.querySelectorAll('input[data-cat]').forEach(cb => {
      cats[cb.dataset.cat] = cb.checked;
    });
  }
  state.loreSettings = {
    autoScan: loreAutoScan.checked,
    autoDetectUpdates: loreAutoUpdates.checked,
    minNewCharsForScan: parseInt(loreMinChars.value),
    temperature: parseFloat(loreTemp.value),
    detailLevel: loreDetailLevel.value,
    enabledCategories: cats,
    hybridEnabled: loreHybridToggle.checked,
  };
  window.sceneVisualizer.loreSetSettings(state.loreSettings);
}

async function refreshOllamaModels() {
  const result = await window.sceneVisualizer.loreCheckOllama();
  loreOllamaModelSelect.innerHTML = '';
  if (result.available && result.models) {
    for (const m of result.models) {
      const opt = document.createElement('option');
      opt.value = m.name;
      opt.textContent = m.name;
      loreOllamaModelSelect.appendChild(opt);
    }
    const llmConfig = await window.sceneVisualizer.loreGetLlmProvider();
    loreOllamaModelSelect.value = llmConfig.ollamaModel;
  } else {
    const opt = document.createElement('option');
    opt.value = '';
    opt.textContent = 'Ollama not available';
    loreOllamaModelSelect.appendChild(opt);
  }
}

// Tab switching
export function switchPanelTab(tab) {
  // Deactivate all tabs and panels
  sceneTab.classList.remove('active');
  loreTab.classList.remove('active');
  memoryTab.classList.remove('active');
  if (rpgTab) rpgTab.classList.remove('active');
  if (mediaTab) mediaTab.classList.remove('active');
  sceneContent.classList.remove('active');
  sceneContent.style.display = 'none';
  loreContent.classList.remove('active');
  loreContent.style.display = 'none';
  memoryContent.classList.remove('active');
  memoryContent.style.display = 'none';
  if (rpgContent) { rpgContent.classList.remove('active'); rpgContent.style.display = 'none'; }
  if (mediaContent) { mediaContent.classList.remove('active'); mediaContent.style.display = 'none'; }

  if (tab === 'scene') {
    sceneTab.classList.add('active');
    sceneContent.classList.add('active');
    sceneContent.style.display = '';
  } else if (tab === 'lore') {
    loreTab.classList.add('active');
    loreContent.classList.add('active');
    loreContent.style.display = '';
    refreshLoreUI();
  } else if (tab === 'memory') {
    memoryTab.classList.add('active');
    memoryContent.classList.add('active');
    memoryContent.style.display = '';
    refreshMemoryUI();
  } else if (tab === 'rpg') {
    if (rpgTab) rpgTab.classList.add('active');
    if (rpgContent) { rpgContent.classList.add('active'); rpgContent.style.display = ''; }
    // refreshRpgUI is called from litrpg-panel.js
    import('./litrpg-panel.js').then(m => m.refreshRpgUI && m.refreshRpgUI());
  } else if (tab === 'media') {
    if (mediaTab) mediaTab.classList.add('active');
    if (mediaContent) { mediaContent.classList.add('active'); mediaContent.style.display = ''; }
    bus.emit('media:tab-activated');
  }
}

export function init() {
  // Tab switching
  sceneTab.addEventListener('click', () => switchPanelTab('scene'));
  loreTab.addEventListener('click', () => switchPanelTab('lore'));
  memoryTab.addEventListener('click', () => switchPanelTab('memory'));
  if (rpgTab) rpgTab.addEventListener('click', () => switchPanelTab('rpg'));
  if (mediaTab) mediaTab.addEventListener('click', () => switchPanelTab('media'));

  // Initialize lore settings
  (async function initLore() {
    try {
      state.loreSettings = await window.sceneVisualizer.loreGetSettings();
      loreAutoScan.checked = state.loreSettings.autoScan;
      loreAutoUpdates.checked = state.loreSettings.autoDetectUpdates;
      loreMinChars.value = state.loreSettings.minNewCharsForScan;
      loreMinCharsValue.textContent = state.loreSettings.minNewCharsForScan;
      loreTemp.value = state.loreSettings.temperature;
      loreTempValue.textContent = state.loreSettings.temperature;
      loreDetailLevel.value = state.loreSettings.detailLevel;

      // Load category registry and rebuild UI (handles toggles)
      await loadCategoryRegistry();

      // LLM provider
      const llmConfig = await window.sceneVisualizer.loreGetLlmProvider();
      loreLlmSelect.value = llmConfig.provider;
      updateLlmIndicator(llmConfig.provider, llmConfig.ollamaModel);
      if (llmConfig.provider === 'ollama') {
        loreOllamaSettings.style.display = '';
        refreshOllamaModels();
      }

      // Hybrid toggle
      loreHybridToggle.checked = state.loreSettings.hybridEnabled !== false;
    } catch (e) {
      console.log('[Lore] Init error:', e);
    }
  })();

  // Settings change handlers
  loreAutoScan.addEventListener('change', saveLoreSettings);
  loreAutoUpdates.addEventListener('change', saveLoreSettings);
  loreHybridToggle.addEventListener('change', async () => {
    saveLoreSettings();
    const llmConfig = await window.sceneVisualizer.loreGetLlmProvider();
    updateLlmIndicator(llmConfig.provider, llmConfig.ollamaModel);
  });
  loreMinChars.addEventListener('input', () => {
    loreMinCharsValue.textContent = loreMinChars.value;
    saveLoreSettings();
  });
  loreTemp.addEventListener('input', () => {
    loreTempValue.textContent = loreTemp.value;
    saveLoreSettings();
  });
  loreDetailLevel.addEventListener('change', saveLoreSettings);
  // Category toggle change handlers are attached dynamically in rebuildCategoryUI()

  loreLlmSelect.addEventListener('change', async () => {
    const provider = loreLlmSelect.value;
    loreOllamaSettings.style.display = provider === 'ollama' ? '' : 'none';
    await window.sceneVisualizer.loreSetLlmProvider({ provider });
    if (provider === 'ollama') await refreshOllamaModels();
    const llmConfig = await window.sceneVisualizer.loreGetLlmProvider();
    updateLlmIndicator(llmConfig.provider, llmConfig.ollamaModel);
  });

  loreOllamaModelSelect.addEventListener('change', async () => {
    await window.sceneVisualizer.loreSetLlmProvider({ ollamaModel: loreOllamaModelSelect.value });
    updateLlmIndicator('ollama', loreOllamaModelSelect.value);
  });

  loreOllamaRefreshBtn.addEventListener('click', refreshOllamaModels);

  // Category management buttons
  if (loreAddCategoryBtn) {
    loreAddCategoryBtn.addEventListener('click', () => {
      if (loreAddCategoryForm) loreAddCategoryForm.style.display = '';
    });
  }
  if (loreAddCategoryCancel) {
    loreAddCategoryCancel.addEventListener('click', () => {
      if (loreAddCategoryForm) loreAddCategoryForm.style.display = 'none';
      if (loreNewCategoryName) loreNewCategoryName.value = '';
    });
  }
  if (loreAddCategoryConfirm) {
    loreAddCategoryConfirm.addEventListener('click', async () => {
      if (!loreNewCategoryName || !state.currentStoryId) return;
      const name = loreNewCategoryName.value.trim();
      if (!name) { showToast('Enter a category name'); return; }

      const id = slugifyCategory(name);
      if (!id) { showToast('Invalid category name'); return; }

      const color = loreNewCategoryColor ? loreNewCategoryColor.value : '#ff9900';
      const { singular, plural } = deriveSingularPlural(name);

      const result = await window.sceneVisualizer.loreAddCustomCategory(state.currentStoryId, {
        id,
        displayName: plural,
        singularName: singular,
        color,
      });

      if (result.success) {
        showToast(`Added category "${singular}"`);
        if (loreNewCategoryName) loreNewCategoryName.value = '';
        if (loreAddCategoryForm) loreAddCategoryForm.style.display = 'none';
        await loadCategoryRegistry();
      } else {
        showToast(result.error || 'Failed to add category');
      }
    });
  }
  if (loreDetectCategoriesBtn) {
    loreDetectCategoriesBtn.addEventListener('click', async () => {
      if (!state.currentStoryId) return;
      loreDetectCategoriesBtn.disabled = true;
      loreDetectCategoriesBtn.textContent = 'Detecting...';
      try {
        // Ensure category registry is loaded
        if (!state.categoryRegistry) await loadCategoryRegistry();

        await checkLoreProxy();
        const lorebookCats = await loreCall('getCategories');
        if (!lorebookCats || lorebookCats.length === 0) {
          showToast('No lorebook categories found');
          return;
        }

        // Filter out categories already in registry
        const existingIds = new Set(getCategoryIds());
        const existingNames = new Set((state.categoryRegistry || []).map(c => c.displayName.toLowerCase()));
        const novel = lorebookCats.filter(c => {
          const name = (c.name || '').toLowerCase();
          return name && !existingNames.has(name);
        });

        if (novel.length === 0) {
          showToast('All lorebook categories already tracked');
          return;
        }

        // Show confirmation with checkboxes
        const msg = `Found ${novel.length} new lorebook categories:\n${novel.map(c => `- ${c.name}`).join('\n')}\n\nImport them as custom categories?`;
        if (!confirm(msg)) return;

        // Pre-defined colors for auto-assignment
        const autoColors = ['#ff9900', '#00bcd4', '#e91e63', '#8bc34a', '#9c27b0', '#ff5722', '#607d8b', '#cddc39'];
        let colorIdx = 0;

        for (const cat of novel) {
          const name = cat.name;
          const id = slugifyCategory(name);
          if (!id || existingIds.has(id)) continue;

          const { singular, plural } = deriveSingularPlural(name);

          await window.sceneVisualizer.loreAddCustomCategory(state.currentStoryId, {
            id,
            displayName: plural,
            singularName: singular,
            color: autoColors[colorIdx % autoColors.length],
          });
          existingIds.add(id);
          colorIdx++;
        }

        showToast(`Imported ${novel.length} categories`);
        await loadCategoryRegistry();
      } catch (e) {
        showToast('Detection failed: ' + (e.message || 'Unknown error'));
      } finally {
        loreDetectCategoriesBtn.disabled = false;
        loreDetectCategoriesBtn.textContent = 'Detect from Lorebook';
      }
    });
  }

  // Scan action -- dropdown menu
  loreScanBtn.addEventListener('click', () => {
    if (state.loreIsScanning) return;
    state.scanMenuOpen = !state.scanMenuOpen;
    loreScanMenu.style.display = state.scanMenuOpen ? '' : 'none';
  });

  // Close menu when clicking outside
  document.addEventListener('click', (e) => {
    if (state.scanMenuOpen && !loreScanBtn.contains(e.target) && !loreScanMenu.contains(e.target)) {
      state.scanMenuOpen = false;
      loreScanMenu.style.display = 'none';
    }
  });

  // Dropdown items are populated dynamically in rebuildCategoryUI()

  // Scan progress listener
  window.sceneVisualizer.onLoreScanProgress((progress) => {
    const phaseLabels = {
      deduplicating: 'Finding duplicates...',
      'confirming-duplicates': 'Confirming duplicates...',
      identifying: 'Identifying elements...',
      generating: 'Generating entries...',
      'processing-merges': 'Processing merges...',
      'checking-updates': 'Checking for updates...',
      'updating-relationships': 'Updating relationships...',
      'enriching': 'Enriching character details...',
      'propagating-names': 'Propagating family names...',
      'optimizing': 'Optimizing lorebook settings...',
    };
    // Show per-entry detail for optimization phase
    if (progress.phase === 'optimizing' && progress.characterName) {
      loreScanPhase.textContent = `Optimizing: ${progress.characterName} (${progress.current}/${progress.total})`;
    } else {
      loreScanPhase.textContent = phaseLabels[progress.phase] || 'Scanning...';
    }

    // Update progress bar
    const phaseProgress = {
      deduplicating: 5,
      'confirming-duplicates': 10,
      identifying: 15,
      generating: 40,
      'processing-merges': 55,
      'checking-updates': 70,
      'updating-relationships': 80,
      enriching: 90,
      'propagating-names': 95,
      'optimizing': 97,
    };
    loreScanProgressFill.style.width = (phaseProgress[progress.phase] || 0) + '%';

    // Live update pending entries as they come in
    if (progress.pendingEntries) {
      if (!state.loreState) state.loreState = { pendingEntries: [], pendingMerges: [], pendingUpdates: [], acceptedEntryIds: [], rejectedNames: [], dismissedUpdateNames: [], rejectedMergeNames: [], charsSinceLastScan: 0, loreCategoryIds: {}, pendingCleanups: [], dismissedCleanupIds: [] };
      state.loreState.pendingEntries = progress.pendingEntries;
      refreshLoreUI();
    }
  });

  // Organize
  loreOrganizeBtn.addEventListener('click', () => runLoreOrganize());

  // Organize progress listener
  window.sceneVisualizer.onLoreOrganizeProgress((progress) => {
    const phaseLabels = {
      classifying: 'Classifying entries...',
      'classifying-llm': 'Classifying (LLM)...',
      deduplicating: 'Finding duplicates...',
      'confirming-duplicates': 'Confirming duplicates...',
      recategorizing: 'Checking categories...',
    };
    loreScanPhase.textContent = phaseLabels[progress.phase] || 'Organizing...';
  });

  // Cleanup apply all
  loreCleanupApplyAllBtn.addEventListener('click', async () => {
    if (!state.loreState || !state.loreState.pendingCleanups || state.loreState.pendingCleanups.length === 0) return;

    loreCleanupApplyAllBtn.disabled = true;
    const ids = state.loreState.pendingCleanups.map(c => c.id);
    for (const id of ids) {
      await acceptCleanup(id);
    }
    loreCleanupApplyAllBtn.disabled = false;
  });

  // Accept all entries
  loreAcceptAllBtn.addEventListener('click', async () => {
    if (!state.loreState || state.loreState.pendingEntries.length === 0) return;

    loreAcceptAllBtn.disabled = true;
    const entries = [...state.loreState.pendingEntries];
    let accepted = 0;

    await checkLoreProxy();
    if (!state.loreProxyReady) {
      showToast('Open Script Manager to enable lorebook writes');
      loreAcceptAllBtn.disabled = false;
      return;
    }

    // Fetch existing entries once for duplicate detection
    let existingNames = new Set();
    let skipped = 0;
    try {
      const currentEntries = await loreCall('getEntries');
      for (const e of currentEntries) {
        if (e.displayName) existingNames.add(e.displayName.toLowerCase());
      }
    } catch (e) { /* proceed without dedup on error */ }

    for (const entry of entries) {
      // Silently skip duplicates in Accept All
      const newNameLower = entry.displayName.toLowerCase();
      const isDuplicate = [...existingNames].some(n =>
        n === newNameLower || n.includes(newNameLower) || newNameLower.includes(n)
      );
      if (isDuplicate) {
        skipped++;
        continue;
      }

      const categoryId = await getCategoryForType(entry.category);
      const entryData = {
        displayName: entry.displayName,
        keys: entry.keys,
        text: entry.text,
        category: categoryId,
      };
      const lorebookId = await loreCall('createEntry', entryData);
      if (lorebookId) {
        state.loreState.acceptedEntryIds.push(lorebookId);
        existingNames.add(newNameLower);
        accepted++;
      }
    }

    state.loreState.pendingEntries = [];
    await saveLoreState();
    const msg = skipped > 0
      ? `Accepted ${accepted} entries (${skipped} duplicates skipped)`
      : `Accepted ${accepted} entries`;
    showToast(msg);
    loreAcceptAllBtn.disabled = false;
    refreshLoreUI();
  });

  // Clear all pending
  loreClearBtn.addEventListener('click', async () => {
    if (!state.loreState) return;

    // Double-click confirmation pattern
    if (!state.loreClearPending) {
      state.loreClearPending = true;
      loreClearBtn.textContent = 'Confirm?';
      loreClearBtn.style.background = 'var(--accent)';
      loreClearBtn.style.color = '#fff';
      setTimeout(() => {
        state.loreClearPending = false;
        loreClearBtn.textContent = 'Clear All';
        loreClearBtn.style.background = '';
        loreClearBtn.style.color = '';
      }, 3000);
      return;
    }
    state.loreClearPending = false;
    loreClearBtn.textContent = 'Clear All';
    loreClearBtn.style.background = '';
    loreClearBtn.style.color = '';

    state.loreState.pendingEntries = [];
    state.loreState.pendingMerges = [];
    state.loreState.pendingUpdates = [];
    await saveLoreState();
    showToast('Pending items cleared');
    refreshLoreUI();
  });

  // Enrich entry
  loreEnrichBtn.addEventListener('click', () => runEnrich());
  loreEnrichInput.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') runEnrich();
  });

  loreEnrichAcceptBtn.addEventListener('click', async () => {
    if (!state.loreEnrichResult) return;

    await checkLoreProxy();
    if (!state.loreProxyReady) {
      showToast('Open Script Manager to enable lorebook writes');
      return;
    }

    const success = await loreCall('updateEntry', state.loreEnrichResult.entry.id, { text: state.loreEnrichResult.updatedText });

    if (success) {
      showToast(`Updated "${state.loreEnrichResult.displayName}"`);
    } else {
      showToast('Failed to update entry');
    }

    state.loreEnrichResult = null;
    loreEnrichPreview.style.display = 'none';
    loreEnrichInput.value = '';
  });

  loreEnrichEditBtn.addEventListener('click', () => {
    if (!state.loreEnrichResult) return;
    const textarea = document.createElement('textarea');
    textarea.className = 'lore-edit-area';
    textarea.value = state.loreEnrichResult.updatedText;
    loreEnrichNew.innerHTML = '';
    loreEnrichNew.appendChild(textarea);

    loreEnrichEditBtn.style.display = 'none';
    textarea.addEventListener('input', () => {
      state.loreEnrichResult.updatedText = textarea.value;
    });
  });

  loreEnrichRejectBtn.addEventListener('click', () => {
    state.loreEnrichResult = null;
    loreEnrichPreview.style.display = 'none';
  });

  // Create Entry
  loreCreateBtn.addEventListener('click', () => runLoreCreate());
  loreCreateInput.addEventListener('keydown', (e) => {
    if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); runLoreCreate(); }
  });

  // =========================================================================
  // STORY COMPREHENSION UI
  // =========================================================================

  startProgressiveScanBtn.addEventListener('click', async () => {
    if (state.comprehensionScanning || !state.currentStoryId) return;

    state.comprehensionScanning = true;
    state.comprehensionPaused = false;
    startProgressiveScanBtn.disabled = true;
    pauseProgressiveScanBtn.style.display = '';
    cancelProgressiveScanBtn.style.display = '';
    comprehensionStatusText.textContent = 'Starting...';

    try {
      await checkLoreProxy();
      let storyText = await loreCall('getStoryText');

      if (!storyText || storyText.trim().length < 100) {
        comprehensionStatusText.textContent = 'Not enough story text';
        return;
      }

      // Fetch lorebook entries for category-aware entity extraction
      let entries = [];
      try { entries = await loreCall('getEntries'); } catch (_) { /* best-effort */ }

      await window.sceneVisualizer.loreStartProgressiveScan(state.currentStoryId, storyText, entries);
    } catch (e) {
      comprehensionStatusText.textContent = 'Error: ' + (e.message || 'Scan failed');
    } finally {
      state.comprehensionScanning = false;
      startProgressiveScanBtn.disabled = false;
      pauseProgressiveScanBtn.style.display = 'none';
      cancelProgressiveScanBtn.style.display = 'none';
    }
  });

  pauseProgressiveScanBtn.addEventListener('click', async () => {
    if (!state.currentStoryId) return;
    if (state.comprehensionPaused) {
      await window.sceneVisualizer.loreResumeProgressiveScan(state.currentStoryId);
      state.comprehensionPaused = false;
      pauseProgressiveScanBtn.textContent = 'Pause';
    } else {
      await window.sceneVisualizer.lorePauseProgressiveScan(state.currentStoryId);
      state.comprehensionPaused = true;
      pauseProgressiveScanBtn.textContent = 'Resume';
    }
  });

  cancelProgressiveScanBtn.addEventListener('click', async () => {
    if (!state.currentStoryId) return;
    await window.sceneVisualizer.loreCancelProgressiveScan(state.currentStoryId);
    comprehensionStatusText.textContent = 'Cancelled';
  });

  // Progress listener
  window.sceneVisualizer.onProgressiveScanProgress((data) => {
    if (data.storyId !== state.currentStoryId) return;
    const pct = data.chunksTotal > 0
      ? Math.round((data.chunksProcessed / data.chunksTotal) * 100)
      : 0;
    comprehensionProgressFill.style.width = pct + '%';

    const phaseLabels = {
      processing: `Processing chunk ${data.chunksProcessed}/${data.chunksTotal}...`,
      consolidating: 'Consolidating summaries...',
      complete: 'Complete',
    };
    comprehensionStatusText.textContent = phaseLabels[data.phase] || `${pct}%`;
  });

  // Completion listener
  window.sceneVisualizer.onProgressiveScanComplete((data) => {
    if (data.storyId !== state.currentStoryId) return;
    state.comprehensionScanning = false;
    startProgressiveScanBtn.disabled = false;
    pauseProgressiveScanBtn.style.display = 'none';
    cancelProgressiveScanBtn.style.display = 'none';
    loadComprehensionState();
  });

  // Auto-incremental update when story grows and comprehension data exists
  setInterval(async () => {
    if (state.comprehensionAutoUpdatePending || state.comprehensionScanning || !state.currentStoryId) return;

    try {
      const compState = await window.sceneVisualizer.loreGetComprehension(state.currentStoryId);
      if (!compState || !compState.lastProcessedLength) return;

      await checkLoreProxy();
      const _st = await loreCall('getStoryText');
      let storyLen = _st ? _st.length : 0;

      const newChars = storyLen - compState.lastProcessedLength;
      if (newChars > 2000) {
        state.comprehensionAutoUpdatePending = true;
        console.log(`[Comprehension] Auto-incremental update: ${newChars} new chars`);

        let storyText = await loreCall('getStoryText');
        let entries = [];
        try { entries = await loreCall('getEntries'); } catch (_) { /* best-effort */ }

        await window.sceneVisualizer.loreIncrementalUpdate(state.currentStoryId, storyText, entries);
        await loadComprehensionState();
        state.comprehensionAutoUpdatePending = false;
      }
    } catch (e) {
      state.comprehensionAutoUpdatePending = false;
    }
  }, 30000);

  // Check lore proxy on initial webview ready (data loading handled by handleStoryContextChange)
  webview.addEventListener('dom-ready', () => {
    setTimeout(() => checkLoreProxy(), 3000);
  });

  // =========================================================================
  // Lorebook Optimizer — profile selection, discover, optimize all
  // =========================================================================

  // Restore profile from story settings if available
  bus.on('story:changed', () => {
    const profile = state.storySettings?.lorebookProfile || 'general';
    state.loreOptProfile = profile;
    if (loreOptProfile) loreOptProfile.value = profile;
  });

  // Profile change
  if (loreOptProfile) {
    loreOptProfile.addEventListener('change', async () => {
      state.loreOptProfile = loreOptProfile.value;
      // Persist to per-story settings
      if (state.currentStoryId) {
        const existing = state.storySettings || {};
        existing.lorebookProfile = loreOptProfile.value;
        await window.sceneVisualizer.storySettingsSet(state.currentStoryId, existing);
        state.storySettings = existing;
      }
    });
  }

  // Discover fields button
  if (loreDiscoverFieldsBtn) {
    loreDiscoverFieldsBtn.addEventListener('click', async () => {
      if (!state.loreProxyReady) {
        showToast('Proxy not connected — open Script Manager first');
        return;
      }
      loreDiscoverFieldsBtn.disabled = true;
      loreDiscoverFieldsBtn.textContent = 'Discovering...';
      try {
        // Run discovery via proxy
        const inspectResult = await loreCall('inspectEntry');
        const writeTestResult = await loreCall('testAdvancedWrite');
        const report = await window.sceneVisualizer.loreParseDiscovery(inspectResult, writeTestResult);

        state.loreOptConfirmedFields = report.writableFields;

        // Persist confirmed fields in story settings
        if (state.currentStoryId) {
          const existing = state.storySettings || {};
          existing.loreOptConfirmedFields = report.writableFields;
          await window.sceneVisualizer.storySettingsSet(state.currentStoryId, existing);
          state.storySettings = existing;
        }

        // Show results
        const msg = `Discovered ${report.readableFields.length} readable, ${report.writableFields.length} writable fields`;
        if (loreOptStatus) {
          loreOptStatus.style.display = '';
          loreOptStatus.textContent = msg;
          setTimeout(() => { loreOptStatus.style.display = 'none'; }, 5000);
        }
        showToast(msg);

        console.log('[LoreOpt] Discovery report:', report);
      } catch (e) {
        showToast('Discovery failed: ' + (e.message || 'Unknown error'));
      } finally {
        loreDiscoverFieldsBtn.disabled = false;
        loreDiscoverFieldsBtn.textContent = 'Discover';
      }
    });
  }

  // Optimize All button
  if (loreOptimizeAllBtn) {
    loreOptimizeAllBtn.addEventListener('click', async () => {
      if (state.loreIsScanning || !state.currentStoryId) return;
      if (!state.loreProxyReady) {
        showToast('Proxy not connected — open Script Manager first');
        return;
      }

      const confirmedFields = state.loreOptConfirmedFields
        || state.storySettings?.loreOptConfirmedFields
        || [];
      if (confirmedFields.length === 0) {
        showToast('Run "Discover" first to find writable fields');
        return;
      }

      state.loreIsScanning = true;
      loreOptimizeAllBtn.disabled = true;
      loreScanStatus.style.display = '';
      loreScanPhase.textContent = 'Optimizing lorebook...';
      loreScanProgressFill.style.width = '0%';

      try {
        // Get expanded entries (with current advanced field values)
        const entries = await loreCall('getEntriesExpanded');
        if (!entries || entries.length === 0) {
          showToast('No lorebook entries to optimize');
          return;
        }

        const result = await window.sceneVisualizer.loreOptimizeEntries(
          entries, state.loreOptProfile, state.currentStoryId, confirmedFields
        );

        if (result.success && result.details && result.details.length > 0) {
          // Apply changes via proxy batch update
          const updates = result.details
            .filter(d => d.delta && Object.keys(d.delta).length > 0)
            .map(d => ({ id: d.entryId, fields: d.delta }));

          if (updates.length > 0) {
            loreScanPhase.textContent = `Applying ${updates.length} optimizations...`;
            loreScanProgressFill.style.width = '60%';

            // Batch in chunks of 10
            for (let i = 0; i < updates.length; i += 10) {
              const chunk = updates.slice(i, i + 10);
              const batchResult = await loreCall('batchUpdateAdvanced', chunk);
              console.log(`[LoreOpt] Batch ${Math.floor(i / 10) + 1}: ${batchResult.success} ok, ${batchResult.failed} failed`);
              loreScanProgressFill.style.width = `${60 + (i / updates.length) * 35}%`;
            }
          }

          // Build summary
          const summary = [];
          const s = result;
          if (s.optimized > 0) summary.push(`${s.optimized} optimized`);
          if (s.skipped > 0) summary.push(`${s.skipped} unchanged`);
          showToast(`Lorebook optimization: ${summary.join(', ')}`);

          if (loreOptStatus) {
            const details = result.details;
            const forceCount = details.filter(d => d.delta?.forceActivation).length;
            const budgetCount = details.filter(d => d.delta?.budgetPriority !== undefined || d.delta?.contextSize !== undefined).length;
            const rangeCount = details.filter(d => d.delta?.searchRange !== undefined).length;
            const prefixCount = details.filter(d => d.delta?.prefix).length;
            const parts = [];
            if (forceCount) parts.push(`${forceCount} force-activated`);
            if (budgetCount) parts.push(`${budgetCount} budget-adjusted`);
            if (rangeCount) parts.push(`${rangeCount} range-changed`);
            if (prefixCount) parts.push(`${prefixCount} with prefixes`);
            loreOptStatus.style.display = '';
            loreOptStatus.textContent = `Optimized ${details.length} entries: ${parts.join(', ') || 'no changes'}`;
          }
        } else if (result.success) {
          showToast('All entries already optimized');
        } else {
          showToast('Optimization failed: ' + (result.error || 'Unknown'));
        }
      } catch (e) {
        showToast('Optimization failed: ' + (e.message || 'Unknown error'));
      } finally {
        loreScanProgressFill.style.width = '100%';
        loreScanPhase.textContent = 'Optimization complete';
        state.loreIsScanning = false;
        loreOptimizeAllBtn.disabled = false;
        setTimeout(() => {
          loreScanStatus.style.display = 'none';
          loreScanProgressFill.style.width = '0%';
        }, 1500);
      }
    });
  }

}
