// headless-command-palette.js — Command palette for headless mode

import { state, bus } from './state.js';
import * as refs from './dom-refs.js';
import { currentLoreEntries, selectLoreEntry } from './headless-lore-panel.js';
import { togglePanel } from './headless-panels.js';
import { showToast } from './utils.js';

const { storyEditor } = refs;

let _deps = {};

const COMMANDS = [
  { id: 'expand', name: 'Expand', description: 'AI continues writing from cursor', shortcut: 'Ctrl+Enter' },
  { id: 'rewrite', name: 'Rewrite', description: 'AI rewrites selected text', shortcut: '' },
  { id: 'summarize', name: 'Summarize', description: 'AI summarizes selected text', shortcut: '' },
  { id: 'shorten', name: 'Shorten', description: 'AI shortens selected text', shortcut: '' },
  { id: 'save', name: 'Save & Sync', description: 'Force sync with NovelAI', shortcut: 'Ctrl+S' },
  { id: 'undo', name: 'Undo', description: 'Undo last change', shortcut: 'Ctrl+Z' },
  { id: 'redo', name: 'Redo', description: 'Redo last change', shortcut: 'Ctrl+Shift+Z' },
  { id: 'lore', name: 'Open Lorebook', description: 'Manage lore entries', shortcut: '' },
  { id: 'settings', name: 'AI Settings', description: 'Tune generation parameters', shortcut: '' },
  { id: 'focus', name: 'Focus Mode', description: 'Toggle distraction-free writing', shortcut: 'Ctrl+Shift+F' },
  { id: 'typewriter', name: 'Typewriter Mode', description: 'Keep cursor centered vertically', shortcut: '' },
  { id: 'search', name: 'Search', description: 'Open search and replace', shortcut: 'Ctrl+F' },
  { id: 'flatten', name: 'Flatten Text', description: 'Remove all styling from editor', shortcut: '' },
  { id: 'lock', name: 'Lock/Unlock Editor', description: 'Toggle read-only mode', shortcut: '' },
  { id: 'stats', name: 'Show Stats', description: 'Show detailed story statistics', shortcut: '' },
  { id: 'help', name: 'Help', description: 'List all commands and shortcuts', shortcut: '/help' },
  { id: 'context', name: 'View AI Context', description: 'Open AI context viewer', shortcut: '' }
];

let selectedCommandIndex = 0;

export function showCommandPalette() {
  if (!refs.editorCommandPalette) return;
  refs.editorCommandPalette.style.display = 'flex';
  if (refs.editorCommandInput) refs.editorCommandInput.value = '';
  selectedCommandIndex = 0;
  renderCommandList();
  setTimeout(() => refs.editorCommandInput?.focus(), 10);
}

export function hideCommandPalette() {
  if (!refs.editorCommandPalette) return;
  refs.editorCommandPalette.style.display = 'none';
  if (storyEditor) storyEditor.focus();
}

function renderCommandList() {
  if (!refs.editorCommandList) return;
  const filter = (refs.editorCommandInput?.value || '').toLowerCase();

  const filteredCommands = COMMANDS.filter(c =>
    c.name.toLowerCase().includes(filter) ||
    c.description.toLowerCase().includes(filter)
  ).map(c => ({ ...c, type: 'command' }));

  let storyResults = [];
  if (filter.length >= 2) {
    storyResults = state.availableStories.filter(s =>
      (s.title || '').toLowerCase().includes(filter)
    ).slice(0, 3).map(s => ({
      id: `story-${s.id}`, name: s.title,
      description: 'Switch to this story', type: 'story', storyId: s.id
    }));
  }

  let loreResults = [];
  if (filter.length >= 2) {
    loreResults = currentLoreEntries.filter(e =>
      (e.displayName || '').toLowerCase().includes(filter) ||
      (e.keys || '').toLowerCase().includes(filter)
    ).slice(0, 5).map(e => ({
      id: `lore-${e.id}`, name: e.displayName || 'Unnamed Entry',
      description: `Lore: ${(e.keys || '').split(',')[0]}`, type: 'lore', loreId: e.id
    }));
  }

  const allItems = [...filteredCommands, ...storyResults, ...loreResults];
  if (selectedCommandIndex >= allItems.length) selectedCommandIndex = Math.max(0, allItems.length - 1);

  refs.editorCommandList.innerHTML = allItems.map((c, i) => `
    <div class="command-item ${i === selectedCommandIndex ? 'selected' : ''} type-${c.type}" data-id="${c.id}">
      <div class="command-info">
        <div class="command-name">${c.name}</div>
        <div class="command-description">${c.description}</div>
      </div>
      ${c.shortcut ? `<div class="command-shortcut">${c.shortcut}</div>` : ''}
      ${c.type !== 'command' ? `<div class="command-type-badge">${c.type}</div>` : ''}
    </div>
  `).join('');

  const selected = refs.editorCommandList.querySelector('.selected');
  if (selected) selected.scrollIntoView({ block: 'nearest' });

  refs.editorCommandList.querySelectorAll('.command-item').forEach((item, i) => {
    item.addEventListener('click', () => {
      selectedCommandIndex = i;
      executeSelectedCommand();
    });
  });
}

function getItemCount() {
  const filter = (refs.editorCommandInput?.value || '').toLowerCase();
  const cmdCount = COMMANDS.filter(c => c.name.toLowerCase().includes(filter) || c.description.toLowerCase().includes(filter)).length;
  const storyCount = filter.length >= 2 ? state.availableStories.filter(s => (s.title || '').toLowerCase().includes(filter)).slice(0, 3).length : 0;
  const loreCount = filter.length >= 2 ? currentLoreEntries.filter(e => (e.displayName || '').toLowerCase().includes(filter) || (e.keys || '').toLowerCase().includes(filter)).slice(0, 5).length : 0;
  return cmdCount + storyCount + loreCount;
}

export function selectNextCommand() {
  const total = getItemCount();
  if (total === 0) return;
  selectedCommandIndex = (selectedCommandIndex + 1) % total;
  renderCommandList();
}

export function selectPrevCommand() {
  const total = getItemCount();
  if (total === 0) return;
  selectedCommandIndex = (selectedCommandIndex - 1 + total) % total;
  renderCommandList();
}

async function executeSelectedCommand() {
  const filter = (refs.editorCommandInput?.value || '').toLowerCase();

  const filteredCommands = COMMANDS.filter(c =>
    c.name.toLowerCase().includes(filter) || c.description.toLowerCase().includes(filter)
  ).map(c => ({ ...c, type: 'command' }));

  let storyResults = filter.length >= 2
    ? state.availableStories.filter(s => (s.title || '').toLowerCase().includes(filter)).slice(0, 3).map(s => ({ id: `story-${s.id}`, name: s.title, type: 'story', storyId: s.id }))
    : [];

  let loreResults = filter.length >= 2
    ? currentLoreEntries.filter(e => (e.displayName || '').toLowerCase().includes(filter) || (e.keys || '').toLowerCase().includes(filter)).slice(0, 5).map(e => ({ id: `lore-${e.id}`, name: e.displayName, type: 'lore', loreId: e.id }))
    : [];

  const allItems = [...filteredCommands, ...storyResults, ...loreResults];
  const item = allItems[selectedCommandIndex];
  if (!item) return;

  hideCommandPalette();

  if (item.type === 'command') {
    const d = _deps;
    switch (item.id) {
      case 'expand': if (d.triggerGeneration) d.triggerGeneration(); break;
      case 'rewrite': if (d.triggerAiAction) d.triggerAiAction('rewrite'); break;
      case 'summarize': if (d.triggerAiAction) d.triggerAiAction('summarize'); break;
      case 'shorten': if (d.triggerAiAction) d.triggerAiAction('shorten'); break;
      case 'save': if (d.syncToWebview) d.syncToWebview(); break;
      case 'undo': if (d.triggerUndo) d.triggerUndo(); break;
      case 'redo': if (d.triggerRedo) d.triggerRedo(); break;
      case 'lore': togglePanel(refs.headlessLorePanel); break;
      case 'settings': togglePanel(refs.headlessAiSettingsPanel); break;
      case 'focus': if (d.toggleFocusMode) d.toggleFocusMode(); break;
      case 'typewriter': if (d.toggleTypewriterMode) d.toggleTypewriterMode(); break;
      case 'search': if (d.toggleSearchBar) d.toggleSearchBar(); break;
      case 'flatten': if (d.flattenEditorText) d.flattenEditorText(); break;
      case 'lock': if (d.toggleReadOnlyMode) d.toggleReadOnlyMode(); break;
      case 'stats': if (d.showStoryStats) d.showStoryStats(); break;
      case 'help': if (d.showHelpDialog) d.showHelpDialog(); break;
      case 'context': togglePanel(refs.headlessContextPanel); break;
    }
  } else if (item.type === 'story') {
    bus.emit('headless:select-story', { storyId: item.storyId, title: item.name });
    showToast(`Switching to story: ${item.name}`);
  } else if (item.type === 'lore') {
    togglePanel(refs.headlessLorePanel);
    selectLoreEntry(item.loreId);
  }
}

export function init(deps) {
  _deps = deps;

  if (refs.editorCommandInput) {
    refs.editorCommandInput.addEventListener('input', () => renderCommandList());
    refs.editorCommandInput.addEventListener('keydown', (e) => {
      if (e.key === 'Escape') hideCommandPalette();
      else if (e.key === 'ArrowDown') { e.preventDefault(); selectNextCommand(); }
      else if (e.key === 'ArrowUp') { e.preventDefault(); selectPrevCommand(); }
      else if (e.key === 'Enter') { e.preventDefault(); executeSelectedCommand(); }
    });
  }

  document.addEventListener('mousedown', (e) => {
    if (refs.editorCommandPalette?.style.display === 'flex' && !refs.editorCommandPalette.contains(e.target)) {
      hideCommandPalette();
    }
  });
}
