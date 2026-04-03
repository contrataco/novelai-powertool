// prompt-history.js — Prompt History with Favorites for the Scene panel

import { state, bus } from './state.js';
import { showToast, timeAgo } from './utils.js';
import { promptDisplay, negativePromptDisplay, historyFavFilterBtn, historyList, storyboardSubTab, historySubTab, historyView, storyboardView, timelineView } from './dom-refs.js';

let favoritesOnly = false;
let currentEntries = [];

export function init() {
  // Hide history tab in webview mode
  if (!state.headlessMode && historySubTab) {
    historySubTab.classList.add('u-hidden');
  }

  bus.on('image:generated', ({ storyId, meta }) => autoSave(storyId, meta));

  historyFavFilterBtn?.addEventListener('click', () => {
    favoritesOnly = !favoritesOnly;
    historyFavFilterBtn.classList.toggle('active', favoritesOnly);
    renderHistory();
  });

  // Event delegation for all card actions
  historyList?.addEventListener('click', (e) => {
    const btn = e.target.closest('[data-action]');
    if (!btn) return;
    const { action, id } = btn.dataset;
    if (action === 'star') onToggleFavorite(id);
    else if (action === 'reuse') onReuse(id);
    else if (action === 'delete') onDelete(id);
  });
}

async function autoSave(storyId, meta) {
  if (!state.headlessMode) return;
  if (storyId !== state.currentStoryId) return;
  const prompt = state.prompt?.display || '';
  if (!prompt) return;

  const id = 'ph-' + crypto.randomUUID();
  try {
    await window.powertool.promptHistorySave(storyId, {
      id,
      prompt,
      negativePrompt: state.prompt?.negative || '',
      provider: meta?.provider || '',
      model: meta?.model || '',
    });
  } catch (e) {
    console.error('[PromptHistory] autoSave error:', e);
  }
}

export async function renderHistory() {
  if (!historyList) return;
  const storyId = state.currentStoryId;
  if (!storyId) {
    historyList.innerHTML = '<p class="history-empty">No story loaded.</p>';
    return;
  }

  let entries;
  try {
    entries = await window.powertool.promptHistoryList(storyId);
  } catch (e) {
    historyList.innerHTML = '<p class="history-empty">Failed to load history.</p>';
    return;
  }

  if (favoritesOnly) entries = entries.filter(e => e.is_favorite);

  currentEntries = entries;

  if (!entries.length) {
    historyList.innerHTML = '<p class="history-empty">No history yet. Generate an image to start.</p>';
    return;
  }

  historyList.innerHTML = entries.map(entry => buildCard(entry)).join('');
}

function buildCard(entry) {
  const truncated = entry.prompt.length > 120
    ? entry.prompt.slice(0, 120) + '…'
    : entry.prompt;
  const starClass = entry.is_favorite ? 'history-star fav' : 'history-star';
  const starGlyph = entry.is_favorite ? '★' : '☆';
  const meta = [entry.provider, entry.model].filter(Boolean).join(' / ');
  const age = timeAgo(entry.created_at);
  return `
    <div class="history-card" data-id="${entry.id}">
      <div class="history-card-header">
        <span class="history-prompt-text">${escapeHtml(truncated)}</span>
        <button class="${starClass}" data-action="star" data-id="${entry.id}" title="Toggle favorite">${starGlyph}</button>
      </div>
      <div class="history-card-footer">
        <span class="history-meta">${escapeHtml(meta)}${meta ? ' · ' : ''}${age}</span>
        <button class="history-reuse-btn" data-action="reuse" data-id="${entry.id}">Reuse</button>
        <button class="history-del-btn" data-action="delete" data-id="${entry.id}">Delete</button>
      </div>
    </div>`;
}

function escapeHtml(str) {
  return String(str)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

async function onToggleFavorite(id) {
  const storyId = state.currentStoryId;
  if (!storyId) return;
  try {
    await window.powertool.promptHistoryToggleFavorite(storyId, id);
    await renderHistory();
  } catch (e) {
    console.error('[PromptHistory] toggleFavorite error:', e);
  }
}

function onReuse(id) {
  const entry = currentEntries.find(e => e.id === id);
  if (!entry) return;
  // Load prompt into state and the display textareas
  state.prompt.display = entry.prompt;
  state.prompt.negativeEdited = false;
  if (entry.negative_prompt) {
    state.prompt.negative = entry.negative_prompt;
    if (negativePromptDisplay) negativePromptDisplay.value = entry.negative_prompt;
  }
  if (promptDisplay) promptDisplay.value = entry.prompt;

  // Switch back to Storyboard sub-tab
  if (historySubTab) historySubTab.classList.remove('active');
  if (storyboardSubTab) storyboardSubTab.classList.add('active');
  if (historyView) historyView.classList.add('u-hidden');
  if (timelineView) timelineView.classList.add('u-hidden');
  if (storyboardView) storyboardView.classList.remove('u-hidden');

  showToast('Prompt loaded', 2000);
}

async function onDelete(id) {
  const storyId = state.currentStoryId;
  if (!storyId) return;
  try {
    await window.powertool.promptHistoryDelete(storyId, id);
    await renderHistory();
  } catch (e) {
    console.error('[PromptHistory] delete error:', e);
  }
}
