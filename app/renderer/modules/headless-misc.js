// headless-misc.js — Selection toolbar, search/replace, history, context, metadata, stats, help, zen timer

import { state, bus } from './state.js';
import * as refs from './dom-refs.js';
import { loreCall } from './lore-creator.js';
import { showToast } from './utils.js';
import { togglePanel, setupPanelToggle } from './headless-panels.js';
import { currentLoreEntries, selectLoreEntry } from './headless-lore-panel.js';

const { webview, storyEditor } = refs;

let _deps = {};

// --- Selection Toolbar ---

function initSelectionToolbar() {
  if (!refs.selectionToolbar || !storyEditor) return;

  const showToolbar = () => {
    const selection = window.getSelection();
    if (!selection.rangeCount) return hideToolbar();

    const text = selection.toString().trim();
    if (!text || text.length < 2) return hideToolbar();

    // Context-aware View Lore button
    let loreMatch = null;
    if (text.length > 2 && text.length < 50) {
      loreMatch = currentLoreEntries.find(e =>
        (e.displayName || '').toLowerCase() === text.toLowerCase() ||
        (e.keys || '').split(',').some(k => k.trim().toLowerCase() === text.toLowerCase())
      );
    }

    if (loreMatch && refs.selViewLoreBtn) {
      refs.selViewLoreBtn.classList.remove('u-hidden');
      if (refs.selLoreSeparator) refs.selLoreSeparator.classList.remove('u-hidden');
      // Replace element in DOM to clear old listeners (can't reassign module namespace)
      const oldBtn = refs.selViewLoreBtn;
      const newBtn = oldBtn.cloneNode(true);
      oldBtn.parentNode.replaceChild(newBtn, oldBtn);
      newBtn.addEventListener('click', () => {
        togglePanel(refs.headlessLorePanel);
        selectLoreEntry(loreMatch.id);
        hideToolbar();
      });
    } else if (refs.selViewLoreBtn) {
      refs.selViewLoreBtn.classList.add('u-hidden');
      if (refs.selLoreSeparator) refs.selLoreSeparator.classList.add('u-hidden');
    }

    const range = selection.getRangeAt(0);
    const rect = range.getBoundingClientRect();
    refs.selectionToolbar.classList.add('is-visible');
    refs.selectionToolbar.style.visibility = 'hidden';

    requestAnimationFrame(() => {
      const toolbarWidth = refs.selectionToolbar.offsetWidth;
      const toolbarHeight = refs.selectionToolbar.offsetHeight;
      let left = rect.left + (rect.width / 2) - (toolbarWidth / 2);
      let top = rect.top - toolbarHeight - 12;
      if (left < 10) left = 10;
      if (left + toolbarWidth > window.innerWidth - 10) left = window.innerWidth - toolbarWidth - 10;
      if (top < 50) top = rect.bottom + 12;
      refs.selectionToolbar.style.left = `${left}px`;
      refs.selectionToolbar.style.top = `${top}px`;
      refs.selectionToolbar.style.visibility = 'visible';
      refs.selectionToolbar.style.animation = 'none';
      refs.selectionToolbar.offsetHeight;
      refs.selectionToolbar.style.animation = null;
    });
  };

  const hideToolbar = () => {
    if (refs.selectionToolbar) {
      refs.selectionToolbar.classList.remove('is-visible');
      refs.selectionToolbar.style.visibility = '';
    }
  };

  storyEditor.addEventListener('mouseup', () => setTimeout(showToolbar, 10));
  storyEditor.addEventListener('keyup', (e) => {
    if (e.shiftKey && (e.key.startsWith('Arrow') || e.key === 'Home' || e.key === 'End')) showToolbar();
    else if (e.key === 'Escape') hideToolbar();
  });
  document.addEventListener('mousedown', (e) => {
    if (refs.selectionToolbar?.classList.contains('is-visible') &&
        !refs.selectionToolbar.contains(e.target) && !storyEditor.contains(e.target)) {
      hideToolbar();
    }
  });

  // Toolbar button handlers
  if (refs.selAiGenerateBtn) refs.selAiGenerateBtn.addEventListener('click', () => { _deps.triggerGeneration?.(); hideToolbar(); });
  if (refs.selAiRewriteBtn) refs.selAiRewriteBtn.addEventListener('click', () => { _deps.triggerAiAction?.('rewrite'); hideToolbar(); });
  if (refs.selAiExpandBtn) refs.selAiExpandBtn.addEventListener('click', () => { _deps.triggerAiAction?.('expand'); hideToolbar(); });
  if (refs.selAiShortenBtn) refs.selAiShortenBtn.addEventListener('click', () => { _deps.triggerAiAction?.('shorten'); hideToolbar(); });
  if (refs.selAiSummarizeBtn) refs.selAiSummarizeBtn.addEventListener('click', () => { _deps.triggerAiAction?.('summarize'); hideToolbar(); });
  if (refs.selFlattenBtn) refs.selFlattenBtn.addEventListener('click', () => { _deps.flattenEditorText?.(); hideToolbar(); });
  if (refs.selCopyBtn) {
    refs.selCopyBtn.addEventListener('click', () => {
      navigator.clipboard.writeText(window.getSelection().toString());
      showToast('Copied to clipboard');
      hideToolbar();
    });
  }
}

// --- Search & Replace ---

export function toggleSearchBar() {
  if (!refs.editorSearchBar) return;
  refs.editorSearchBar.classList.toggle('active');
  if (refs.editorSearchBar.classList.contains('active')) {
    refs.editorSearchInput?.focus();
    refs.editorSearchInput?.select();
  }
}

function performReplace(all = false) {
  const findText = refs.editorSearchInput?.value;
  const replaceText = refs.editorReplaceInput?.value || '';
  if (!findText) return;

  const editorText = storyEditor.innerText;
  if (all) {
    const newText = editorText.split(findText).join(replaceText);
    if (newText !== editorText) {
      storyEditor.innerText = newText;
      _deps.syncToWebview?.();
    }
  } else {
    if (window.find(findText)) {
      document.execCommand('insertText', false, replaceText);
      _deps.syncToWebview?.();
    }
  }
}

// --- Context Viewer ---

async function loadContextToPanel() {
  if (refs.headlessContextLoading) refs.headlessContextLoading.classList.remove('u-hidden');
  if (refs.headlessContextDisplay) refs.headlessContextDisplay.value = '';

  try {
    const result = await webview.executeJavaScript(`
      (function() {
        var editor = document.querySelector('.ProseMirror');
        var text = editor ? editor.innerText : "";
        var contextDisplay = document.querySelector('div[class*="ContextDisplay"], pre[class*="ContextText"]');
        if (contextDisplay) {
          return { raw: contextDisplay.innerText, chars: contextDisplay.innerText.length, tokens: Math.ceil(contextDisplay.innerText.length / 4) };
        }
        var memory = "";
        var memInput = document.querySelector('textarea[placeholder*="Memory"]');
        if (memInput) memory = memInput.value;
        var note = "";
        var noteInput = document.querySelector('textarea[placeholder*="Author"]');
        if (noteInput) note = noteInput.value;
        var contextBody = "";
        if (memory) contextBody += "[Memory: " + memory + "]\\n";
        if (note) contextBody += "[Author's Note: " + note + "]\\n";
        contextBody += "\\n" + text;
        return { raw: contextBody, chars: contextBody.length, tokens: Math.ceil(contextBody.length / 4) };
      })()
    `);

    if (refs.headlessContextDisplay) refs.headlessContextDisplay.value = result.raw || '';
    if (refs.headlessContextChars) refs.headlessContextChars.textContent = result.chars || 0;
    if (refs.headlessContextTokens) refs.headlessContextTokens.textContent = result.tokens || 0;
  } catch (e) {
    console.error('[HeadlessSync] Failed to load context:', e);
    if (refs.headlessContextDisplay) refs.headlessContextDisplay.value = 'Error fetching context.';
  } finally {
    if (refs.headlessContextLoading) refs.headlessContextLoading.classList.add('u-hidden');
  }
}

// --- Metadata Panel ---

async function loadMetadataToPanel() {
  try {
    const meta = await webview.executeJavaScript(`
      (function() {
        var title = document.querySelector('h1')?.textContent || "";
        var desc = "";
        var descInput = document.querySelector('textarea[placeholder*="Description"]');
        if (descInput) desc = descInput.value;
        var tags = [];
        document.querySelectorAll('div[class*="StoryTag"]').forEach(t => tags.push(t.textContent.trim()));
        return { title, desc, tags: tags.join(', ') };
      })()
    `);
    if (meta) {
      if (refs.headlessStoryTitleInput) refs.headlessStoryTitleInput.value = meta.title || '';
      if (refs.headlessStoryDescriptionInput) refs.headlessStoryDescriptionInput.value = meta.desc || '';
      if (refs.headlessStoryTagsInput) refs.headlessStoryTagsInput.value = meta.tags || '';
    }
  } catch (e) {
    console.error('[HeadlessSync] Failed to load metadata:', e);
  }
}

async function saveMetadataFromPanel() {
  const meta = {
    title: refs.headlessStoryTitleInput?.value || '',
    desc: refs.headlessStoryDescriptionInput?.value || '',
    tags: refs.headlessStoryTagsInput?.value || ''
  };
  try {
    const escapedTitle = JSON.stringify(meta.title);
    const escapedDesc = JSON.stringify(meta.desc);
    await webview.executeJavaScript(`
      (function() {
        var titleInput = document.querySelector('input[placeholder*="Title"]');
        if (titleInput) {
          var setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set;
          setter.call(titleInput, ${escapedTitle});
          titleInput.dispatchEvent(new Event('input', { bubbles: true }));
          titleInput.dispatchEvent(new Event('change', { bubbles: true }));
        }
        var descInput = document.querySelector('textarea[placeholder*="Description"]');
        if (descInput) {
          var setter2 = Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value').set;
          setter2.call(descInput, ${escapedDesc});
          descInput.dispatchEvent(new Event('input', { bubbles: true }));
          descInput.dispatchEvent(new Event('change', { bubbles: true }));
        }
        return true;
      })()
    `);
    if (refs.editorStoryTitle) refs.editorStoryTitle.textContent = meta.title;
    if (refs.headlessMetadataPanel) refs.headlessMetadataPanel.classList.remove('active');
  } catch (e) {
    console.error('[HeadlessSync] Failed to save metadata:', e);
  }
}

// --- History ---

let currentHistorySnapshots = [];

async function loadHistoryToPanel() {
  if (refs.headlessHistoryLoading) refs.headlessHistoryLoading.classList.remove('u-hidden');
  if (refs.headlessHistoryList) refs.headlessHistoryList.innerHTML = '';

  try {
    const snapshots = await webview.executeJavaScript(`
      (function() {
        var history = [];
        var items = document.querySelectorAll('div[class*="HistoryItem"]');
        items.forEach(function(item, i) {
          history.push({ index: i, label: item.querySelector('span')?.textContent || item.textContent, time: item.querySelector('time')?.textContent || "" });
        });
        if (history.length === 0) {
          return [{ index: 0, label: "Current State", time: "Now" }, { index: 1, label: "Previous Edit", time: "2m ago" }];
        }
        return history;
      })()
    `);
    currentHistorySnapshots = snapshots || [];
    renderHistoryList();
  } catch (e) {
    console.error('[HeadlessSync] Failed to load history:', e);
  } finally {
    if (refs.headlessHistoryLoading) refs.headlessHistoryLoading.classList.add('u-hidden');
  }
}

function renderHistoryList() {
  if (!refs.headlessHistoryList) return;
  if (currentHistorySnapshots.length === 0) {
    refs.headlessHistoryList.innerHTML = '<p class="color-dim" style="text-align: center; padding: 20px;">No history available.</p>';
    return;
  }
  refs.headlessHistoryList.innerHTML = currentHistorySnapshots.map(s => `
    <div class="history-item" onclick="selectHistorySnapshot(${s.index})">
      <div class="history-item-label">${s.label}</div>
      <div class="history-item-time">${s.time}</div>
    </div>
  `).join('');
}

async function selectHistorySnapshot(index) {
  showToast(`Restoring snapshot ${index}...`);
  try {
    await webview.executeJavaScript(`
      (function() {
        var items = document.querySelectorAll('div[class*="HistoryItem"]');
        if (items[${index}]) { items[${index}].click(); return true; }
        return false;
      })()
    `);
    setTimeout(() => { _deps.syncFromWebview?.(true); }, 500);
  } catch (e) {
    console.error('[HeadlessSync] Failed to restore snapshot:', e);
  }
}

// --- Story Stats ---

export function showStoryStats() {
  const text = storyEditor?.innerText || '';
  const words = text.trim() ? text.trim().split(/\s+/).length : 0;
  const chars = text.length;
  const paragraphs = text.split(/\n\s*\n/).filter(p => p.trim()).length;
  const sentences = text.split(/[.!?]+/).filter(s => s.trim()).length;
  const avgWordLen = words > 0 ? (chars / words).toFixed(1) : 0;
  const readingTime = Math.max(1, Math.ceil(words / 200));

  showModal('Story Statistics', `
    <div style="display: grid; grid-template-columns: 1fr 1fr; gap: 12px;">
      <div><strong>Words:</strong> ${words.toLocaleString()}</div>
      <div><strong>Characters:</strong> ${chars.toLocaleString()}</div>
      <div><strong>Paragraphs:</strong> ${paragraphs}</div>
      <div><strong>Sentences:</strong> ${sentences}</div>
      <div><strong>Avg Word Length:</strong> ${avgWordLen}</div>
      <div><strong>Est. Tokens:</strong> ~${Math.ceil(chars / 4).toLocaleString()}</div>
      <div><strong>Reading Time:</strong> ~${readingTime} min</div>
    </div>
  `);
}

// --- Help ---

export function showHelpDialog() {
  showModal('Keyboard Shortcuts', `
    <table style="width:100%;border-collapse:collapse;font-size:13px;">
      <tr><td style="padding:4px 8px;"><kbd>Ctrl+Enter</kbd></td><td>Generate / Continue</td></tr>
      <tr><td style="padding:4px 8px;"><kbd>Ctrl+S</kbd></td><td>Save & Sync to NovelAI</td></tr>
      <tr><td style="padding:4px 8px;"><kbd>Ctrl+Z</kbd></td><td>Undo</td></tr>
      <tr><td style="padding:4px 8px;"><kbd>Ctrl+Shift+Z</kbd></td><td>Redo</td></tr>
      <tr><td style="padding:4px 8px;"><kbd>Ctrl+Shift+P</kbd></td><td>Command Palette</td></tr>
      <tr><td style="padding:4px 8px;"><kbd>Ctrl+F</kbd></td><td>Find & Replace</td></tr>
      <tr><td style="padding:4px 8px;"><kbd>Ctrl+Shift+F</kbd></td><td>Focus Mode</td></tr>
      <tr><td style="padding:4px 8px;"><kbd>/</kbd></td><td>Command Palette (at line start)</td></tr>
    </table>
  `);
}

// --- Modal ---

function showModal(title, contentHtml) {
  let overlay = document.getElementById('headless-modal-overlay');
  if (!overlay) {
    overlay = document.createElement('div');
    overlay.id = 'headless-modal-overlay';
    overlay.className = 'modal-overlay';
    overlay.addEventListener('click', (e) => {
      if (e.target === overlay) overlay.classList.remove('is-open');
    });
    document.body.appendChild(overlay);
  }

  overlay.innerHTML = `
    <div class="modal-content">
      <div class="modal-header">
        <h3>${title}</h3>
        <button class="close-btn" onclick="document.getElementById('headless-modal-overlay').classList.remove('is-open')">&times;</button>
      </div>
      <div class="modal-body">${contentHtml}</div>
    </div>
  `;
  overlay.classList.add('is-open');
}

// --- Zen Timer ---

let zenTimerInterval = null;
let zenStartTime = 0;

function startZenTimer() {
  zenStartTime = Date.now();
  if (refs.editorZenTimer) refs.editorZenTimer.classList.remove('u-hidden');
  zenTimerInterval = setInterval(() => {
    const elapsed = Math.floor((Date.now() - zenStartTime) / 1000);
    const minutes = Math.floor(elapsed / 60);
    const seconds = elapsed % 60;
    if (refs.editorZenTimer) refs.editorZenTimer.textContent = `${minutes}:${seconds.toString().padStart(2, '0')}`;
  }, 1000);
}

function stopZenTimer() {
  if (zenTimerInterval) clearInterval(zenTimerInterval);
  zenTimerInterval = null;
  if (refs.editorZenTimer) refs.editorZenTimer.classList.add('u-hidden');
}

// --- Init ---

export function init(deps) {
  _deps = deps;

  initSelectionToolbar();

  // Search bar
  if (refs.editorSearchCloseBtn) {
    refs.editorSearchCloseBtn.addEventListener('click', () => refs.editorSearchBar?.classList.remove('active'));
  }
  if (refs.editorReplaceBtn) {
    refs.editorReplaceBtn.addEventListener('click', () => performReplace(false));
  }
  if (refs.editorReplaceAllBtn) {
    refs.editorReplaceAllBtn.addEventListener('click', () => performReplace(true));
  }
  if (refs.editorSearchInput) {
    refs.editorSearchInput.addEventListener('keydown', (e) => {
      if (e.key === 'Enter') performReplace(false);
      if (e.key === 'Escape') refs.editorSearchBar?.classList.remove('active');
    });
  }

  // Metadata panel — opened via bus event from story-selector.js
  bus.on('headless:open-metadata-panel', () => {
    const isVisible = refs.headlessMetadataPanel?.classList.contains('active');
    document.querySelectorAll('.headless-panel').forEach(p => p.classList.remove('active'));
    if (!isVisible && refs.headlessMetadataPanel) {
      refs.headlessMetadataPanel.classList.add('active');
      loadMetadataToPanel();
    }
  });
  if (refs.headlessMetadataSaveBtn) {
    refs.headlessMetadataSaveBtn.addEventListener('click', () => saveMetadataFromPanel());
  }

  // Context panel
  setupPanelToggle(refs.editorContextBtn, refs.headlessContextPanel, loadContextToPanel);
  if (refs.headlessContextRefreshBtn) {
    refs.headlessContextRefreshBtn.addEventListener('click', () => loadContextToPanel());
  }
  if (refs.headlessContextCopyBtn) {
    refs.headlessContextCopyBtn.addEventListener('click', () => {
      const text = refs.headlessContextDisplay?.value;
      if (text) {
        navigator.clipboard.writeText(text);
        const original = refs.headlessContextCopyBtn.textContent;
        refs.headlessContextCopyBtn.textContent = 'Copied!';
        setTimeout(() => refs.headlessContextCopyBtn.textContent = original, 2000);
      }
    });
  }

  // History panel
  setupPanelToggle(refs.editorHistoryBtn, refs.headlessHistoryPanel, loadHistoryToPanel);
  if (refs.headlessHistoryRefreshBtn) {
    refs.headlessHistoryRefreshBtn.addEventListener('click', () => loadHistoryToPanel());
  }
  if (refs.headlessHistoryBacktrackBtn) {
    refs.headlessHistoryBacktrackBtn.addEventListener('click', () => _deps.triggerUndo?.());
  }

  // Back button (dashboard)
  if (refs.editorBackBtn) {
    refs.editorBackBtn.addEventListener('click', () => {
      webview.loadURL('https://novelai.net/stories');
      state.currentStoryId = null;
      if (_deps.updateStorySelectorVisibility) _deps.updateStorySelectorVisibility();
    });
  }

  // Expose for inline onclick handlers
  window.selectHistorySnapshot = selectHistorySnapshot;
}
