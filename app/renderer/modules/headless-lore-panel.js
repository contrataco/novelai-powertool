// headless-lore-panel.js — Two-pane lorebook manager
//
// Left pane: collapsible category tree with search and bulk mode.
// Right pane: entry editor with tag-chip keys, badge selectors, and advanced settings.
// All operations go through the existing loreCall() proxy — no new channels needed.

import { bus } from './state.js';
import { loreCall } from './lore-creator.js';
import { showToast } from './utils.js';
import { parseMetadataClient } from './metadata.js';

// Module state
let _categories = [];
let _allEntries = [];
let _filteredEntries = [];
let _selectedCategoryId = null;
let _selectedEntryId = null;
let _bulkMode = false;
let _bulkSelected = new Set();
let _expandedCategories = new Set();

// DOM refs (local)
const $ = id => document.getElementById(id);

export function init() {
  // Search
  $('loreSearchInput').addEventListener('input', _onSearch);

  // New category
  $('loreNewCategoryBtn').addEventListener('click', _createCategory);

  // New entry
  $('loreNewEntryBtn').addEventListener('click', _createEntry);

  // Save
  $('loreSaveBtn').addEventListener('click', _saveEntry);

  // Delete
  $('loreDeleteBtn').addEventListener('click', _deleteEntry);

  // Bulk mode toggle
  $('loreBulkToggleBtn').addEventListener('click', _toggleBulkMode);
  $('loreBulkMoveBtn').addEventListener('click', _bulkMove);
  $('loreBulkDeleteBtn').addEventListener('click', _bulkDelete);
  $('loreBulkExportBtn').addEventListener('click', _bulkExport);

  // Key chip input
  $('loreKeyInput').addEventListener('keydown', (e) => {
    if (e.key === 'Enter' || e.key === ',') {
      e.preventDefault();
      const val = e.target.value.trim().replace(/,$/, '');
      if (val) { _addKeyChip(val); e.target.value = ''; }
    }
  });

  // Content counter
  $('loreEntryContent').addEventListener('input', _updateContentCounter);

  // Budget priority slider
  $('loreBudgetPriority').addEventListener('input', (e) => {
    $('loreBudgetPriorityVal').textContent = e.target.value;
  });

  // Load on panel open
  const panel = $('headlessLorePanel');
  if (panel) {
    const observer = new MutationObserver(() => {
      if (panel.classList.contains('active')) _loadAll();
    });
    observer.observe(panel, { attributes: true, attributeFilter: ['class'] });
  }

  // Refresh on story change
  bus.on('story:changed', () => {
    _categories = [];
    _allEntries = [];
    _selectedEntryId = null;
    _selectedCategoryId = null;
    _renderTree();
    _showEmpty();
  });
}

// --- Data loading ---

async function _loadAll() {
  try {
    [_categories, _allEntries] = await Promise.all([
      loreCall('getCategories'),
      loreCall('getEntries'),
    ]);
    _filteredEntries = _allEntries;
    if (_categories?.length && !_selectedCategoryId) {
      _selectedCategoryId = _categories[0]?.id || null;
    }
    _renderTree();
  } catch (e) {
    console.error('[LorePanel] Load error:', e);
    showToast('Could not load lorebook', 3000, 'error');
  }
}

// --- Rendering ---

function _renderTree() {
  const tree = $('loreCategoryTree');
  if (!tree) return;
  tree.innerHTML = '';

  const query = ($('loreSearchInput')?.value || '').toLowerCase();
  const cats = _categories || [];

  cats.forEach(cat => {
    const entries = _filteredEntries.filter(e => e.category === cat.id && (
      !query ||
      (e.displayName || '').toLowerCase().includes(query) ||
      (e.keys || '').toLowerCase().includes(query)
    ));

    if (query && entries.length === 0) return; // hide empty categories when filtering

    const isExpanded = _expandedCategories.has(cat.id) || !!query;
    const catEl = document.createElement('div');
    catEl.className = 'lore-category-item' + (_selectedCategoryId === cat.id ? ' active' : '');
    catEl.innerHTML = `
      <span class="lore-category-arrow">${isExpanded ? '▾' : '▸'}</span>
      <span class="lore-category-name">${_escHtml(cat.name)}</span>
      <span class="lore-category-count">${entries.length}</span>
    `;
    catEl.onclick = () => {
      _selectedCategoryId = cat.id;
      if (_expandedCategories.has(cat.id)) _expandedCategories.delete(cat.id);
      else _expandedCategories.add(cat.id);
      _renderTree();
    };
    tree.appendChild(catEl);

    if (isExpanded) {
      entries.forEach(entry => {
        const entryEl = document.createElement('div');
        entryEl.className = 'lore-entry-item' + (_selectedEntryId === entry.id ? ' active' : '');
        entryEl.dataset.entryId = entry.id;

        if (_bulkMode) {
          const cb = document.createElement('input');
          cb.type = 'checkbox';
          cb.className = 'lore-entry-checkbox';
          cb.checked = _bulkSelected.has(entry.id);
          cb.onchange = (e) => {
            e.stopPropagation();
            if (cb.checked) _bulkSelected.add(entry.id);
            else _bulkSelected.delete(entry.id);
            _updateBulkCount();
          };
          entryEl.appendChild(cb);
        }

        const nameSpan = document.createElement('span');
        nameSpan.textContent = entry.displayName || entry.keys || '(unnamed)';
        entryEl.appendChild(nameSpan);

        entryEl.onclick = () => _selectEntry(entry.id);
        tree.appendChild(entryEl);
      });
    }
  });

  // Uncategorised
  const uncategorised = _filteredEntries.filter(e => !e.category || !cats.find(c => c.id === e.category));
  if (uncategorised.length > 0) {
    const catEl = document.createElement('div');
    catEl.className = 'lore-category-item';
    catEl.innerHTML = `<span class="lore-category-arrow">▾</span><span class="lore-category-name">Uncategorised</span><span class="lore-category-count">${uncategorised.length}</span>`;
    tree.appendChild(catEl);
    uncategorised.forEach(entry => {
      const entryEl = document.createElement('div');
      entryEl.className = 'lore-entry-item' + (_selectedEntryId === entry.id ? ' active' : '');
      entryEl.textContent = entry.displayName || entry.keys || '(unnamed)';
      entryEl.onclick = () => _selectEntry(entry.id);
      tree.appendChild(entryEl);
    });
  }
}

function _selectEntry(entryId) {
  _selectedEntryId = entryId;
  const entry = _allEntries.find(e => e.id === entryId);
  if (!entry) return;

  $('loreEditorEmpty')?.classList.add('u-hidden');
  $('loreEditorForm')?.classList.remove('u-hidden');
  $('loreEditorFooter')?.classList.remove('u-hidden');
  $('loreEditorTitle').textContent = entry.displayName || 'Edit Entry';

  $('loreEntryName').value = entry.displayName || '';

  // Keys as chips
  _renderKeyChips((entry.keys || '').split(',').map(k => k.trim()).filter(Boolean));

  // Content
  const meta = parseMetadataClient(entry.text || '');
  $('loreEntryContent').value = meta.rest || entry.text || '';
  _updateContentCounter();

  // Type + role badges
  _renderTypeBadges(meta.type || '', meta.role || '');

  // Advanced
  if (entry.searchRange !== undefined) $('loreSearchRange').value = entry.searchRange;
  if (entry.forceActivation !== undefined) $('loreForceActivation').checked = !!entry.forceActivation;

  // Update tree selection highlight
  _renderTree();
}

function _showEmpty() {
  $('loreEditorEmpty')?.classList.remove('u-hidden');
  $('loreEditorForm')?.classList.add('u-hidden');
  $('loreEditorFooter')?.classList.add('u-hidden');
  $('loreEditorTitle').textContent = 'Lorebook';
}

// --- Key chips ---

function _renderKeyChips(keys) {
  const container = $('loreKeyChips');
  container.innerHTML = '';
  keys.forEach(key => {
    const chip = document.createElement('span');
    chip.className = 'lore-key-chip';
    chip.dataset.key = key;
    chip.innerHTML = `${_escHtml(key)}<button class="lore-key-chip-remove" title="Remove key">×</button>`;
    chip.querySelector('.lore-key-chip-remove').onclick = () => {
      chip.remove();
    };
    container.appendChild(chip);
  });
}

function _addKeyChip(key) {
  const existing = Array.from($('loreKeyChips').querySelectorAll('.lore-key-chip'))
    .map(c => c.dataset.key);
  if (!existing.includes(key)) {
    _renderKeyChips([...existing, key]);
  }
}

function _getKeys() {
  return Array.from($('loreKeyChips').querySelectorAll('.lore-key-chip'))
    .map(c => c.dataset.key).join(', ');
}

// --- Type/role badges ---

const TYPES = ['character', 'location', 'item', 'faction', 'concept'];
const ROLES = ['party-member', 'companion', 'npc'];
let _badgeType = '';
let _badgeRole = '';

function _renderTypeBadges(currentType, currentRole) {
  _badgeType = currentType;
  _badgeRole = currentRole;
  const row = $('loreTypeBadges');
  row.innerHTML = '';

  TYPES.forEach(t => {
    const btn = document.createElement('button');
    btn.type = 'button';
    btn.className = 'lore-badge' + (currentType === t ? ' active' : '');
    btn.textContent = t;
    btn.onclick = () => {
      _badgeType = _badgeType === t ? '' : t;
      _renderTypeBadges(_badgeType, _badgeRole);
    };
    row.appendChild(btn);
  });

  const sep = document.createElement('span');
  sep.style.cssText = 'width:1px;background:#333;margin:0 4px';
  row.appendChild(sep);

  ROLES.forEach(r => {
    const btn = document.createElement('button');
    btn.type = 'button';
    btn.className = 'lore-badge' + (currentRole === r ? ' active' : '');
    btn.textContent = r;
    btn.onclick = () => {
      _badgeRole = _badgeRole === r ? '' : r;
      _renderTypeBadges(_badgeType, _badgeRole);
    };
    row.appendChild(btn);
  });
}

// --- Content counter ---

function _updateContentCounter() {
  const text = $('loreEntryContent').value || '';
  const chars = text.length;
  const tokens = Math.round(chars / 4);
  $('loreContentCounter').textContent = `${chars} chars · ~${tokens} tokens`;
}

// --- CRUD ---

async function _saveEntry() {
  if (!_selectedEntryId) return;
  const entry = _allEntries.find(e => e.id === _selectedEntryId);
  if (!entry) return;

  const name = $('loreEntryName').value.trim();
  const keys = _getKeys();
  let content = $('loreEntryContent').value;

  // Rebuild metadata header
  const existingMeta = parseMetadataClient(entry.text || '');
  const metaLines = [];
  if (_badgeType) metaLines.push(`@type: ${_badgeType}`);
  const version = existingMeta.version || '1';
  metaLines.push(`@v: ${version}`);
  metaLines.push(`@updated: ${new Date().toISOString().split('T')[0]}`);
  if (existingMeta.source) metaLines.push(`@source: ${existingMeta.source}`);
  if (_badgeRole) metaLines.push(`@role: ${_badgeRole}`);
  // Preserve unknown keys
  Object.entries(existingMeta.all || {}).forEach(([k, v]) => {
    if (!['type','v','updated','source','role'].includes(k)) metaLines.push(`@${k}: ${v}`);
  });

  const newText = metaLines.length > 0
    ? metaLines.join('\n') + '\n\n' + content
    : content;

  try {
    await loreCall('updateEntry', { id: _selectedEntryId, displayName: name, keys, text: newText });
    const idx = _allEntries.findIndex(e => e.id === _selectedEntryId);
    if (idx !== -1) _allEntries[idx] = { ..._allEntries[idx], displayName: name, keys, text: newText };
    showToast('Entry saved');
    _renderTree();
  } catch (e) {
    console.error('[LorePanel] Save error:', e);
    showToast('Save failed', 3000, 'error');
  }
}

async function _deleteEntry() {
  if (!_selectedEntryId) return;
  if (!confirm('Delete this entry? This cannot be undone.')) return;
  try {
    await loreCall('removeEntry', _selectedEntryId);
    _allEntries = _allEntries.filter(e => e.id !== _selectedEntryId);
    _filteredEntries = _filteredEntries.filter(e => e.id !== _selectedEntryId);
    _selectedEntryId = null;
    _showEmpty();
    _renderTree();
    showToast('Entry deleted');
  } catch (e) {
    showToast('Delete failed', 3000, 'error');
  }
}

async function _createEntry() {
  try {
    const catId = _selectedCategoryId || (_categories[0]?.id || null);
    const entry = await loreCall('createEntry', {
      displayName: 'New Entry',
      keys: 'new entry',
      text: '',
      category: catId,
    });
    if (entry?.id) {
      _allEntries.push(entry);
      _filteredEntries = _allEntries;
      _expandedCategories.add(catId);
      _renderTree();
      _selectEntry(entry.id);
    }
  } catch (e) {
    showToast('Could not create entry', 3000, 'error');
  }
}

async function _createCategory() {
  const name = prompt('Category name:');
  if (!name) return;
  try {
    const cat = await loreCall('createCategory', { name });
    if (cat?.id) {
      _categories.push(cat);
      _expandedCategories.add(cat.id);
      _selectedCategoryId = cat.id;
      _renderTree();
    }
  } catch (e) {
    showToast('Could not create category', 3000, 'error');
  }
}

// --- Search ---

function _onSearch(e) {
  const q = (e.target.value || '').toLowerCase().trim();
  _filteredEntries = q
    ? _allEntries.filter(entry =>
        (entry.displayName || '').toLowerCase().includes(q) ||
        (entry.keys || '').toLowerCase().includes(q)
      )
    : _allEntries;
  _renderTree();
}

// --- Bulk operations ---

function _toggleBulkMode() {
  _bulkMode = !_bulkMode;
  _bulkSelected.clear();
  const bar = $('loreBulkBar');
  if (bar) bar.classList.toggle('u-hidden', !_bulkMode);
  _updateBulkCount();
  _renderTree();
}

function _updateBulkCount() {
  const el = $('loreBulkCount');
  if (el) el.textContent = `${_bulkSelected.size} selected`;
}

async function _bulkMove() {
  if (_bulkSelected.size === 0) return;
  const catNames = (_categories || []).map(c => c.name);
  const catName = prompt(`Move ${_bulkSelected.size} entries to category:\n${catNames.join(', ')}`);
  if (!catName) return;
  const cat = _categories.find(c => c.name.toLowerCase() === catName.toLowerCase());
  if (!cat) { showToast('Category not found', 2000, 'error'); return; }

  let moved = 0;
  for (const id of _bulkSelected) {
    const entry = _allEntries.find(e => e.id === id);
    if (entry) {
      await loreCall('updateEntry', { id, displayName: entry.displayName, keys: entry.keys, text: entry.text, category: cat.id });
      entry.category = cat.id;
      moved++;
    }
  }
  _bulkSelected.clear();
  _updateBulkCount();
  _renderTree();
  showToast(`Moved ${moved} entries to ${cat.name}`);
}

async function _bulkDelete() {
  if (_bulkSelected.size === 0) return;
  if (!confirm(`Delete ${_bulkSelected.size} entries? This cannot be undone.`)) return;
  for (const id of _bulkSelected) {
    await loreCall('removeEntry', id);
  }
  _allEntries = _allEntries.filter(e => !_bulkSelected.has(e.id));
  _filteredEntries = _filteredEntries.filter(e => !_bulkSelected.has(e.id));
  if (_bulkSelected.has(_selectedEntryId)) { _selectedEntryId = null; _showEmpty(); }
  _bulkSelected.clear();
  _updateBulkCount();
  _renderTree();
  showToast('Entries deleted');
}

function _bulkExport() {
  if (_bulkSelected.size === 0) return;
  const entries = _allEntries.filter(e => _bulkSelected.has(e.id));
  const json = JSON.stringify(entries, null, 2);
  const blob = new Blob([json], { type: 'application/json' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = `lorebook-export-${Date.now()}.json`;
  a.click();
  URL.revokeObjectURL(url);
  showToast(`Exported ${entries.length} entries`);
}

function _escHtml(s) {
  return (s || '').replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;');
}

// Expose for use by headless-autocomplete (currentLoreEntries)
export function getCurrentEntries() { return _allEntries; }
