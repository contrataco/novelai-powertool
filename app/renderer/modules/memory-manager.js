// memory-manager.js — Token bar, events, auto-update, proxy

import { state } from './state.js';
import {
  webview,
  memoryProxyDot, memoryProxyText,
  memoryTokenCount, memoryTokenPercent, memoryTokenBar,
  memoryUpdateBtn, memoryRefreshBtn, memoryClearBtn,
  memoryProgress, memoryProgressText,
  memoryPreview, memoryEventList, memoryEventCount,
  memoryCharList, memoryCharCount,
  memoryAutoUpdate, memoryTokenLimit, memoryTokenLimitValue,
  memoryCompression, memoryCompressionValue, memoryKeywords,
} from './dom-refs.js';
import { checkProxyStatus, memoryCall } from './lore-creator.js';

export async function checkMemoryProxy() {
  const proxyStatus = await checkProxyStatus('__MEMORY_PROXY_CMD__', '__MEMORY_PROXY_RES__');
  state.memoryProxyReady = proxyStatus === 'ready';
  if (state.memoryProxyReady) {
    memoryProxyDot.classList.remove('inactive');
    memoryProxyDot.classList.add('active');
    memoryProxyText.textContent = 'Full Access';
  } else {
    // Memory read/write still works via DOM fallback
    memoryProxyDot.classList.remove('inactive');
    memoryProxyDot.classList.add('active');
    memoryProxyText.textContent = 'DOM Mode';
  }
}

// Load per-story memory state
async function loadMemoryState() {
  if (!state.currentStoryId) return;
  try {
    state.memoryState = await window.powertool.memoryGetState(state.currentStoryId);
    renderMemoryUI();
  } catch (e) {
    console.log('[Memory] Load state error:', e);
  }
}

// Render memory UI from current state
export function renderMemoryUI() {
  if (!state.memoryState || !state.memorySettings) return;

  const events = state.memoryState.events || [];
  const characters = state.memoryState.characters || {};
  const situation = state.memoryState.currentSituation || '';

  // Build memory text for preview
  const sections = [];
  if (events.length > 0) {
    sections.push('=== STORY TIMELINE ===\n' + events.map(e => '\u2022 ' + e.text).join('\n'));
  }
  if (situation) {
    sections.push('=== CURRENT SITUATION ===\n' + situation);
  }
  const charEntries = Object.entries(characters);
  if (charEntries.length > 0) {
    sections.push('=== KEY CHARACTERS ===\n' + charEntries.map(([n, d]) => n + ': ' + d.state).join('\n'));
  }
  const memoryText = sections.join('\n\n');

  // Token bar
  const tokenEst = Math.ceil(memoryText.length / 4);
  const limit = state.memorySettings.tokenLimit || 1000;
  const pct = Math.min(100, Math.round((tokenEst / limit) * 100));

  memoryTokenCount.textContent = `Tokens: ~${tokenEst} / ${limit}`;
  memoryTokenPercent.textContent = pct + '%';
  memoryTokenPercent.style.color = pct > 80 ? '#ff6b6b' : pct > 60 ? '#ffd93d' : '#6bcb77';
  memoryTokenBar.style.width = pct + '%';
  memoryTokenBar.style.backgroundColor = pct > 80 ? '#ff6b6b' : pct > 60 ? '#ffd93d' : '#6bcb77';

  // Preview
  memoryPreview.value = memoryText || '(No memory content yet)';

  // Event history (last 10)
  memoryEventCount.textContent = events.length;
  if (events.length > 0) {
    memoryEventList.innerHTML = events.slice(-10).reverse().map(e =>
      `<div class="memory-event-card${e.compressed ? ' compressed' : ''}">${e.compressed ? '[C] ' : '> '}${e.text}</div>`
    ).join('');
  } else {
    memoryEventList.innerHTML = '<div class="empty-state-sm">No events tracked yet</div>';
  }

  // Character states
  memoryCharCount.textContent = charEntries.length;
  if (charEntries.length > 0) {
    memoryCharList.innerHTML = charEntries.map(([name, data]) =>
      `<div class="memory-char-item"><span class="char-name">${name}</span>: ${data.state}</div>`
    ).join('');
  } else {
    memoryCharList.innerHTML = '<div class="empty-state-sm">No characters tracked</div>';
  }
}

export function refreshMemoryUI() {
  checkMemoryProxy();
  loadMemoryState();
}

// Update Now -- incremental processing
async function runMemoryUpdate() {
  if (!state.currentStoryId || state.memoryIsProcessing) return;
  state.memoryIsProcessing = true;
  memoryProgress.style.display = 'flex';
  memoryProgressText.textContent = 'Getting story text...';
  memoryUpdateBtn.disabled = true;
  memoryRefreshBtn.disabled = true;

  try {
    let storyText = await memoryCall('getStoryText');

    if (!storyText || storyText.trim().length < 50) {
      memoryProgressText.textContent = 'Not enough story content';
      setTimeout(() => { memoryProgress.style.display = 'none'; }, 2000);
      return;
    }

    memoryProgressText.textContent = 'Extracting events...';
    const result = await window.powertool.memoryProcess(storyText, state.currentStoryId);

    if (result.success) {
      state.memoryState = result.state;
      renderMemoryUI();

      // Write to NovelAI Memory field (smart: proxy -> DOM fallback)
      if (result.memoryText) {
        try { await memoryCall('setMemory', result.memoryText); } catch(e) {
          console.log('[Memory] Write failed:', e.message);
        }
      }

      memoryProgressText.textContent = 'Memory updated';
      state.memoryLastStoryLength = storyText.length;
    } else {
      memoryProgressText.textContent = result.error || 'Update failed';
    }
  } catch (e) {
    console.error('[Memory] Update error:', e);
    memoryProgressText.textContent = 'Error: ' + (e.message || e);
  } finally {
    state.memoryIsProcessing = false;
    memoryUpdateBtn.disabled = false;
    memoryRefreshBtn.disabled = false;
    setTimeout(() => { memoryProgress.style.display = 'none'; }, 2500);
  }
}

// Refresh All -- full re-analysis
async function runMemoryRefresh() {
  if (!state.currentStoryId || state.memoryIsProcessing) return;
  state.memoryIsProcessing = true;
  memoryProgress.style.display = 'flex';
  memoryProgressText.textContent = 'Getting story text...';
  memoryUpdateBtn.disabled = true;
  memoryRefreshBtn.disabled = true;

  try {
    let storyText = await memoryCall('getStoryText');

    if (!storyText || storyText.trim().length < 50) {
      memoryProgressText.textContent = 'Not enough story content';
      setTimeout(() => { memoryProgress.style.display = 'none'; }, 2000);
      return;
    }

    memoryProgressText.textContent = 'Analyzing full story...';
    const result = await window.powertool.memoryForceRefresh(storyText, state.currentStoryId);

    if (result.success) {
      state.memoryState = result.state;
      renderMemoryUI();

      if (result.memoryText) {
        try { await memoryCall('setMemory', result.memoryText); } catch(e) {
          console.log('[Memory] Write failed:', e.message);
        }
      }

      memoryProgressText.textContent = `Refreshed (${(result.state?.events || []).length} events)`;
      state.memoryLastStoryLength = storyText.length;
    } else {
      memoryProgressText.textContent = result.error || 'Refresh failed';
    }
  } catch (e) {
    console.error('[Memory] Refresh error:', e);
    memoryProgressText.textContent = 'Error: ' + (e.message || e);
  } finally {
    state.memoryIsProcessing = false;
    memoryUpdateBtn.disabled = false;
    memoryRefreshBtn.disabled = false;
    setTimeout(() => { memoryProgress.style.display = 'none'; }, 2500);
  }
}

// Clear memory (with inline confirmation)
async function runMemoryClear() {
  if (!state.currentStoryId) return;

  // Double-click confirmation pattern
  if (!state.memoryClearPending) {
    state.memoryClearPending = true;
    memoryClearBtn.textContent = 'Confirm Clear?';
    memoryClearBtn.style.background = 'var(--accent)';
    memoryClearBtn.style.color = '#fff';
    setTimeout(() => {
      state.memoryClearPending = false;
      memoryClearBtn.textContent = 'Clear';
      memoryClearBtn.style.background = '';
      memoryClearBtn.style.color = '';
    }, 3000);
    return;
  }
  state.memoryClearPending = false;
  memoryClearBtn.textContent = 'Clear';
  memoryClearBtn.style.background = '';
  memoryClearBtn.style.color = '';

  await window.powertool.memoryClear(state.currentStoryId);
  state.memoryState = { events: [], characters: {}, currentSituation: '', lastProcessedLength: 0 };
  state.memoryLastStoryLength = 0;
  renderMemoryUI();

  try { await memoryCall('setMemory', ''); } catch(e) {
    console.log('[Memory] Clear write failed:', e.message);
  }
}

function saveMemorySettings() {
  if (state.memorySettingsSaveTimeout) clearTimeout(state.memorySettingsSaveTimeout);
  state.memorySettingsSaveTimeout = setTimeout(() => {
    if (!state.memorySettings) return;
    window.powertool.memorySetSettings(state.memorySettings);
  }, 500);
}

export function init() {
  // Initialize memory settings
  (async function initMemory() {
    try {
      state.memorySettings = await window.powertool.memoryGetSettings();
      memoryAutoUpdate.checked = state.memorySettings.autoUpdate;
      memoryTokenLimit.value = state.memorySettings.tokenLimit;
      memoryTokenLimitValue.textContent = state.memorySettings.tokenLimit;
      memoryCompression.value = state.memorySettings.compressionThreshold;
      memoryCompressionValue.textContent = Math.round(state.memorySettings.compressionThreshold * 100) + '%';
      memoryKeywords.value = (state.memorySettings.trackedKeywords || []).join(', ');
    } catch (e) {
      console.log('[Memory] Init error:', e);
    }
  })();

  // Button handlers
  memoryUpdateBtn.addEventListener('click', runMemoryUpdate);
  memoryRefreshBtn.addEventListener('click', runMemoryRefresh);
  memoryClearBtn.addEventListener('click', runMemoryClear);

  // Settings change handlers
  memoryAutoUpdate.addEventListener('change', () => {
    if (!state.memorySettings) return;
    state.memorySettings.autoUpdate = memoryAutoUpdate.checked;
    saveMemorySettings();
  });

  memoryTokenLimit.addEventListener('input', () => {
    if (!state.memorySettings) return;
    state.memorySettings.tokenLimit = parseInt(memoryTokenLimit.value);
    memoryTokenLimitValue.textContent = memoryTokenLimit.value;
    saveMemorySettings();
    renderMemoryUI();
  });

  memoryCompression.addEventListener('input', () => {
    if (!state.memorySettings) return;
    state.memorySettings.compressionThreshold = parseFloat(memoryCompression.value);
    memoryCompressionValue.textContent = Math.round(state.memorySettings.compressionThreshold * 100) + '%';
    saveMemorySettings();
  });

  memoryKeywords.addEventListener('change', () => {
    if (!state.memorySettings) return;
    state.memorySettings.trackedKeywords = memoryKeywords.value.split(',').map(k => k.trim()).filter(k => k.length > 0);
    saveMemorySettings();
  });

  // Progress listener
  window.powertool.onMemoryProgress((data) => {
    if (data.phase === 'extracting') {
      memoryProgressText.textContent = `Extracting chunk ${data.chunk}/${data.totalChunks}...`;
    } else if (data.phase === 'compiling') {
      memoryProgressText.textContent = 'Compiling memory...';
    }
  });

  // Auto-update interval -- runs every 20s, checks for new content
  setInterval(async () => {
    if (!state.memorySettings || !state.memorySettings.autoUpdate) return;
    if (!state.currentStoryId || state.memoryIsProcessing) return;

    try {
      const text = await memoryCall('getStoryText');
      const storyLen = text ? text.length : 0;

      const lastLen = state.memoryState ? (state.memoryState.lastProcessedLength || 0) : 0;
      const newChars = storyLen - lastLen;

      if (newChars > 300) {
        console.log(`[Memory] Auto-update: ${newChars} new chars detected`);
        runMemoryUpdate();
      }
    } catch (e) {
      // Ignore polling errors
    }
  }, 20000);

  // Check memory proxy on initial webview ready (data loading handled by handleStoryContextChange)
  webview.addEventListener('dom-ready', () => {
    setTimeout(() => checkMemoryProxy(), 4000);
  });
}
