// headless-lore-panel.js — Lorebook panel for headless mode

import * as refs from './dom-refs.js';
import { loreCall } from './lore-creator.js';
import { showToast } from './utils.js';
import { setupPanelToggle, togglePanel } from './headless-panels.js';

const { storyEditor, webview } = refs;

export let currentLoreEntries = [];
let selectedLoreEntryId = null;

// --- Load & Render ---

async function loadLoreToPanel() {
  if (refs.headlessLoreList) {
    refs.headlessLoreList.innerHTML = '<p class="text-xs color-dim" style="text-align: center; padding: 20px;">Loading entries...</p>';
  }

  try {
    const entries = await loreCall('getEntriesExpanded');
    currentLoreEntries = entries || [];
    renderLoreList();
  } catch (e) {
    console.error('[HeadlessSync] Error loading lore:', e);
    if (refs.headlessLoreList) {
      refs.headlessLoreList.innerHTML = '<p class="text-xs color-error" style="text-align: center; padding: 20px;">Error loading lorebook.</p>';
    }
  }
}

function renderLoreList() {
  if (!refs.headlessLoreList) return;

  const searchTerm = refs.headlessLoreSearch?.value.toLowerCase() || '';
  const filtered = currentLoreEntries.filter(e =>
    (e.displayName || '').toLowerCase().includes(searchTerm) ||
    (e.keys || '').toLowerCase().includes(searchTerm)
  );

  if (filtered.length === 0) {
    refs.headlessLoreList.innerHTML = '<p class="text-xs color-dim" style="text-align: center; padding: 20px;">No entries found.</p>';
    return;
  }

  refs.headlessLoreList.innerHTML = '';
  filtered.forEach(entry => {
    const item = document.createElement('div');
    item.className = `lore-entry-item ${selectedLoreEntryId === entry.id ? 'active' : ''}`;
    item.innerHTML = `
      <div class="lore-entry-info">
        <div class="lore-entry-name">${entry.displayName || 'Unnamed Entry'}</div>
        <div class="lore-entry-meta">${(entry.keys || '').split(',').slice(0, 3).join(', ')}</div>
      </div>
    `;
    item.addEventListener('click', () => selectLoreEntry(entry.id));
    refs.headlessLoreList.appendChild(item);
  });
}

export function selectLoreEntry(id) {
  selectedLoreEntryId = id;
  const entry = currentLoreEntries.find(e => e.id === id);
  if (!entry) return;

  if (refs.headlessLoreNameInput) refs.headlessLoreNameInput.value = entry.displayName || '';
  if (refs.headlessLoreKeysInput) refs.headlessLoreKeysInput.value = entry.keys || '';
  if (refs.headlessLoreTextInput) refs.headlessLoreTextInput.value = entry.text || '';

  if (refs.headlessLoreEditor) refs.headlessLoreEditor.style.display = 'block';
  renderLoreList();
}

function createNewLoreEntry() {
  selectedLoreEntryId = null;
  if (refs.headlessLoreNameInput) refs.headlessLoreNameInput.value = '';
  if (refs.headlessLoreKeysInput) refs.headlessLoreKeysInput.value = '';
  if (refs.headlessLoreTextInput) refs.headlessLoreTextInput.value = '';
  if (refs.headlessLoreEditor) refs.headlessLoreEditor.style.display = 'block';
}

async function saveLoreEntryFromPanel() {
  const name = refs.headlessLoreNameInput?.value;
  const keys = refs.headlessLoreKeysInput?.value;
  const text = refs.headlessLoreTextInput?.value;

  if (!name) {
    showToast('Entry name is required');
    return;
  }

  try {
    if (selectedLoreEntryId) {
      await loreCall('updateEntry', {
        id: selectedLoreEntryId,
        displayName: name,
        keys: keys,
        text: text
      });
      showToast('Entry updated');
    } else {
      await loreCall('createEntry', {
        displayName: name,
        keys: keys,
        text: text
      });
      showToast('Entry created');
    }
    await loadLoreToPanel();
  } catch (e) {
    console.error('[HeadlessSync] Failed to save lore entry:', e);
    showToast('Failed to save entry');
  }
}

async function deleteLoreEntryFromPanel() {
  if (!selectedLoreEntryId) return;
  if (!confirm('Delete this lorebook entry?')) return;

  try {
    await loreCall('removeEntry', selectedLoreEntryId);
    showToast('Entry deleted');
    selectedLoreEntryId = null;
    if (refs.headlessLoreEditor) refs.headlessLoreEditor.style.display = 'none';
    await loadLoreToPanel();
  } catch (e) {
    console.error('[HeadlessSync] Failed to delete lore entry:', e);
    showToast('Failed to delete entry');
  }
}

// --- Active Lore Panel ---

async function loadActiveLoreToPanel() {
  if (refs.headlessActiveLoreList) {
    refs.headlessActiveLoreList.innerHTML = '<div class="loading"><div class="spinner"></div><span>Detecting active lore...</span></div>';
  }

  try {
    const storyText = storyEditor?.innerText || '';
    const recentText = storyText.slice(-4000);

    if (currentLoreEntries.length === 0) {
      currentLoreEntries = await loreCall('getEntriesExpanded') || [];
    }

    const activeEntries = currentLoreEntries.filter(entry => {
      if (!entry.keys) return false;
      const keys = entry.keys.split(',').map(k => k.trim().toLowerCase()).filter(k => k.length > 0);
      return keys.some(key => recentText.toLowerCase().includes(key));
    });

    if (refs.headlessActiveLoreList) {
      if (activeEntries.length > 0) {
        refs.headlessActiveLoreList.innerHTML = activeEntries.map(entry => `
          <div class="active-lore-item" onclick="selectLoreEntry('${entry.id}'); togglePanel(refs.headlessLorePanel);">
            <div class="active-lore-header">
              <span class="active-lore-name">${entry.displayName || 'Unnamed'}</span>
              <span class="active-lore-badge">Triggered</span>
            </div>
            <p class="active-lore-preview">${(entry.text || '').substring(0, 100)}...</p>
          </div>
        `).join('');
        if (refs.editorActiveLoreCount) refs.editorActiveLoreCount.textContent = activeEntries.length;
        if (refs.editorActiveLoreBtn) refs.editorActiveLoreBtn.classList.add('has-active');
      } else {
        refs.headlessActiveLoreList.innerHTML = '<p class="color-dim" style="text-align: center; padding: 20px;">No triggered entries found in recent text.</p>';
        if (refs.editorActiveLoreCount) refs.editorActiveLoreCount.textContent = '0';
        if (refs.editorActiveLoreBtn) refs.editorActiveLoreBtn.classList.remove('has-active');
      }
    }
  } catch (e) {
    console.error('[HeadlessSync] Failed to detect active lore:', e);
  }
}

// --- Init ---

export function init() {
  setupPanelToggle(refs.editorLoreBtn, refs.headlessLorePanel, loadLoreToPanel);

  if (refs.headlessLoreSearch) {
    refs.headlessLoreSearch.addEventListener('input', () => renderLoreList());
  }
  if (refs.headlessLoreCreateBtn) {
    refs.headlessLoreCreateBtn.addEventListener('click', () => createNewLoreEntry());
  }
  if (refs.headlessLoreSaveBtn) {
    refs.headlessLoreSaveBtn.addEventListener('click', () => saveLoreEntryFromPanel());
  }
  if (refs.headlessLoreDeleteBtn) {
    refs.headlessLoreDeleteBtn.addEventListener('click', () => deleteLoreEntryFromPanel());
  }

  // Active Lore panel
  if (refs.editorActiveLoreBtn) {
    refs.editorActiveLoreBtn.addEventListener('click', (e) => {
      e.stopPropagation();
      const isVisible = refs.headlessActiveLorePanel?.style.display === 'flex';
      document.querySelectorAll('.headless-panel').forEach(p => p.style.display = 'none');
      if (!isVisible && refs.headlessActiveLorePanel) {
        refs.headlessActiveLorePanel.style.display = 'flex';
        loadActiveLoreToPanel();
      }
    });
  }
  if (refs.headlessActiveLoreRefreshBtn) {
    refs.headlessActiveLoreRefreshBtn.addEventListener('click', () => loadActiveLoreToPanel());
  }

  // Expose for inline onclick handlers
  window.selectLoreEntry = selectLoreEntry;
}
