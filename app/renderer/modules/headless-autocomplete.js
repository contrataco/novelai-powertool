// headless-autocomplete.js — Lorebook autocomplete as-you-type

import * as refs from './dom-refs.js';
import { currentLoreEntries } from './headless-lore-panel.js';

const { storyEditor } = refs;

let autocompleteBox = null;
let autocompleteMatches = [];
let autocompleteIndex = 0;

let _syncToWebview = null;

function showAutocomplete(matches, x, y) {
  if (!autocompleteBox) {
    autocompleteBox = document.createElement('div');
    autocompleteBox.className = 'editor-autocomplete-box';
    document.body.appendChild(autocompleteBox);
  }

  autocompleteMatches = matches;
  autocompleteIndex = 0;
  autocompleteBox.style.display = 'block';
  autocompleteBox.style.left = `${x}px`;
  autocompleteBox.style.top = `${y}px`;
  autocompleteBox.style.animation = 'none';
  autocompleteBox.offsetHeight;
  autocompleteBox.style.animation = 'fadeSlideIn 0.2s ease';

  requestAnimationFrame(() => {
    if (!autocompleteBox) return;
    const boxRect = autocompleteBox.getBoundingClientRect();
    if (boxRect.right > window.innerWidth - 10) {
      autocompleteBox.style.left = `${window.innerWidth - boxRect.width - 10}px`;
    }
    if (boxRect.bottom > window.innerHeight - 10) {
      autocompleteBox.style.top = `${y - boxRect.height - 20}px`;
    }
  });

  renderAutocomplete();
}

function hideAutocomplete() {
  if (autocompleteBox) autocompleteBox.style.display = 'none';
  autocompleteMatches = [];
}

function renderAutocomplete() {
  if (!autocompleteBox) return;

  const sortedMatches = [...autocompleteMatches];
  if (autocompleteIndex >= sortedMatches.length) autocompleteIndex = 0;

  autocompleteBox.innerHTML = sortedMatches.map((m, i) => {
    const entryText = m.text || '';
    const type = entryText.toLowerCase().includes('@type: character') ? 'character' :
                 entryText.toLowerCase().includes('@type: location') ? 'location' :
                 entryText.toLowerCase().includes('@type: item') ? 'item' :
                 entryText.toLowerCase().includes('@type: faction') ? 'faction' : 'concept';

    const icon = type === 'character' ? '👤' :
                 type === 'location' ? '📍' :
                 type === 'item' ? '🗡️' :
                 type === 'faction' ? '🚩' : '💡';

    const primaryKey = (m.keys || '').split(',')[0] || '';

    return `
      <div class="autocomplete-item ${i === autocompleteIndex ? 'selected' : ''} type-${type}" data-index="${i}">
        <div class="autocomplete-icon">${icon}</div>
        <div class="autocomplete-info">
          <span class="autocomplete-name">${m.displayName || 'Unnamed Entry'}</span>
          <span class="autocomplete-key">${primaryKey ? `Key: ${primaryKey}` : 'No keys'}</span>
        </div>
        ${m.category ? `<div class="autocomplete-category">${m.category}</div>` : ''}
      </div>
    `;
  }).join('');

  autocompleteBox.querySelectorAll('.autocomplete-item').forEach(item => {
    item.addEventListener('click', (e) => {
      e.stopPropagation();
      autocompleteIndex = parseInt(item.dataset.index);
      insertAutocomplete();
    });
  });
}

function insertAutocomplete() {
  const match = autocompleteMatches[autocompleteIndex];
  if (!match || !storyEditor) return;

  const selection = window.getSelection();
  if (!selection.rangeCount) return;

  const range = selection.getRangeAt(0);
  const textNode = range.startContainer;
  const offset = range.startOffset;
  const content = textNode.textContent;

  let startOfWord = content.lastIndexOf(' ', offset - 1) + 1;
  if (startOfWord < 0) startOfWord = 0;

  const replacement = match.displayName + ' ';
  textNode.textContent = content.substring(0, startOfWord) + replacement + content.substring(offset);

  const newRange = document.createRange();
  newRange.setStart(textNode, startOfWord + replacement.length);
  newRange.collapse(true);
  selection.removeAllRanges();
  selection.addRange(newRange);

  hideAutocomplete();
  if (_syncToWebview) _syncToWebview();
}

export function init({ syncToWebview }) {
  _syncToWebview = syncToWebview;
  if (!storyEditor) return;

  storyEditor.addEventListener('input', () => {
    const selection = window.getSelection();
    if (!selection.rangeCount) return;

    const range = selection.getRangeAt(0);
    const textNode = range.startContainer;
    const offset = range.startOffset;
    const content = textNode.textContent.substring(0, offset);

    const lastSpace = content.lastIndexOf(' ');
    const word = content.substring(lastSpace + 1).toLowerCase();

    if (word.length >= 2 && currentLoreEntries.length > 0) {
      const matches = currentLoreEntries.filter(entry =>
        (entry.displayName || '').toLowerCase().startsWith(word) ||
        (entry.keys || '').toLowerCase().split(',').some(k => k.trim().toLowerCase().startsWith(word))
      ).slice(0, 8);

      if (matches.length > 0) {
        const rect = range.getBoundingClientRect();
        showAutocomplete(matches, rect.left, rect.bottom + 8);
      } else {
        hideAutocomplete();
      }
    } else {
      hideAutocomplete();
    }
  });

  storyEditor.addEventListener('keydown', (e) => {
    if (autocompleteBox && autocompleteBox.style.display === 'block') {
      if (e.key === 'ArrowDown') {
        e.preventDefault();
        autocompleteIndex = (autocompleteIndex + 1) % autocompleteMatches.length;
        renderAutocomplete();
      } else if (e.key === 'ArrowUp') {
        e.preventDefault();
        autocompleteIndex = (autocompleteIndex - 1 + autocompleteMatches.length) % autocompleteMatches.length;
        renderAutocomplete();
      } else if (e.key === 'Enter' || e.key === 'Tab') {
        e.preventDefault();
        insertAutocomplete();
      } else if (e.key === 'Escape') {
        hideAutocomplete();
      }
    }
  });
}
