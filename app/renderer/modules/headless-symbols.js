// headless-symbols.js - Insert NovelAI special symbols (***, [ Style: ], *sfx*, ...)
//
// The catalog lives in app/nai-symbols.js (main process) and arrives over
// IPC. The picker lists each symbol with its literal syntax, what it does,
// where it belongs and which models honour it; choosing one inserts it at the
// caret (block symbols on their own line) with the caret placed inside it.

import * as refs from './dom-refs.js';
import { showToast, escapeHtml } from './utils.js';
import { editorText, selectionOffsets, restoreCursor } from './diff.js';

let catalog = null;
let picker = null;
let lastSel = null;      // last editor selection as text offsets
let _syncToWebview = null;

export async function loadSymbols() {
  if (catalog) return catalog;
  try { catalog = await window.powertool.naiSymbolsList(); } catch (e) { console.warn('[Symbols] list failed:', e); catalog = []; }
  return catalog;
}

export function getSymbolsSync() { return catalog || []; }

/**
 * Insert a symbol at the remembered caret. Block symbols go on their own line.
 * The "|" in the template marks where the caret ends up.
 */
export async function insertSymbol(id) {
  const list = await loadSymbols();
  const sym = list.find((s) => s.id === id);
  const editor = refs.storyEditor;
  if (!sym || !editor) return false;
  if (!editor.isContentEditable) { showToast('The editor is locked', 2500, 'warn'); return false; }

  const text = editorText(editor);
  const sel = lastSel && lastSel.end <= text.length ? lastSel : { start: text.length, end: text.length };
  let body = sym.insert;
  const bar = body.indexOf('|');
  body = body.replace('|', '');
  let prefix = '';
  let suffix = '';
  if (sym.block) {
    if (sel.start > 0 && text[sel.start - 1] !== '\n') prefix = '\n';
    if (sel.end < text.length && text[sel.end] !== '\n') suffix = '\n';
  }
  const insert = prefix + body + suffix;

  editor.focus();
  restoreSelection(editor, sel);
  document.execCommand('insertText', false, insert);

  const expected = text.slice(0, sel.start) + insert + text.slice(sel.end);
  if (editorText(editor) !== expected) {
    // Browser split it differently (e.g. extra paragraph): fall back to undo + report.
    document.execCommand('undo');
    showToast('Could not insert the symbol here', 3000, 'error');
    return false;
  }
  restoreCursor(editor, sel.start + prefix.length + (bar >= 0 ? bar : body.length));
  lastSel = null;
  return true;
}

function restoreSelection(editor, sel) {
  restoreCursor(editor, sel.start);
  if (sel.end === sel.start) return;
  // Extend to the end offset
  const s = window.getSelection();
  const anchor = s.rangeCount ? s.getRangeAt(0).cloneRange() : null;
  restoreCursor(editor, sel.end);
  const r = s.rangeCount ? s.getRangeAt(0) : null;
  if (anchor && r) {
    const range = document.createRange();
    range.setStart(anchor.startContainer, anchor.startOffset);
    range.setEnd(r.endContainer, r.endOffset);
    s.removeAllRanges();
    s.addRange(range);
  }
}

// --- Picker ---

export async function openSymbolPicker(x, y) {
  const list = await loadSymbols();
  if (!list.length) { showToast('Symbol list unavailable', 2500, 'error'); return; }
  closeSymbolPicker();
  picker = document.createElement('div');
  picker.className = 'nai-symbol-picker';
  picker.setAttribute('role', 'dialog');
  picker.setAttribute('aria-label', 'Insert NovelAI symbol');
  picker.innerHTML = `
    <div class="nai-symbol-picker-head">
      <input type="text" placeholder="Filter (e.g. scene, style, telepathy)" aria-label="Filter symbols">
      <button type="button" class="nai-symbol-close" aria-label="Close">&times; Close</button>
    </div>
    <div class="nai-symbol-list" role="listbox"></div>`;
  document.body.appendChild(picker);

  const input = picker.querySelector('input');
  const listEl = picker.querySelector('.nai-symbol-list');
  const render = () => {
    const q = input.value.trim().toLowerCase();
    const shown = list.filter((s) => !q || [s.name, s.syntax, s.use, s.where, s.models].join(' ').toLowerCase().includes(q));
    listEl.innerHTML = shown.map((s) => `
      <button type="button" class="nai-symbol-item" role="option" data-id="${escapeHtml(s.id)}">
        <span class="nai-symbol-name">${escapeHtml(s.name)}</span><span class="nai-symbol-syntax">${escapeHtml(s.syntax)}</span>
        <div class="nai-symbol-use">${escapeHtml(s.use)}</div>
        <div class="nai-symbol-meta">Where: ${escapeHtml(s.where)} &middot; Models: ${escapeHtml(s.models)}</div>
      </button>`).join('') || '<div class="nai-symbol-use">No symbols match.</div>';
  };
  render();
  input.addEventListener('input', render);
  input.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') { e.preventDefault(); listEl.querySelector('.nai-symbol-item')?.click(); }
    if (e.key === 'ArrowDown') { e.preventDefault(); listEl.querySelector('.nai-symbol-item')?.focus(); }
  });
  listEl.addEventListener('keydown', (e) => {
    const items = [...listEl.querySelectorAll('.nai-symbol-item')];
    const i = items.indexOf(document.activeElement);
    if (e.key === 'ArrowDown' && i < items.length - 1) { e.preventDefault(); items[i + 1].focus(); }
    if (e.key === 'ArrowUp') { e.preventDefault(); (i > 0 ? items[i - 1] : input).focus(); }
  });
  listEl.addEventListener('click', async (e) => {
    const item = e.target.closest('.nai-symbol-item');
    if (!item) return;
    closeSymbolPicker();
    if (await insertSymbol(item.dataset.id) && _syncToWebview) _syncToWebview();
  });
  picker.querySelector('.nai-symbol-close').addEventListener('click', closeSymbolPicker);
  picker.addEventListener('keydown', (e) => { if (e.key === 'Escape') { e.preventDefault(); closeSymbolPicker(); refs.storyEditor?.focus(); } });

  // Place near the click, kept on screen; centred when opened from the keyboard.
  const w = picker.offsetWidth;
  const h = picker.offsetHeight;
  const left = x == null ? (window.innerWidth - w) / 2 : Math.min(Math.max(16, x), window.innerWidth - w - 16);
  const top = y == null ? Math.max(16, (window.innerHeight - h) / 3) : Math.min(Math.max(16, y), window.innerHeight - h - 16);
  picker.style.left = `${Math.round(left)}px`;
  picker.style.top = `${Math.round(top)}px`;
  input.focus();
}

export function closeSymbolPicker() {
  picker?.remove();
  picker = null;
}

export function init({ syncToWebview } = {}) {
  _syncToWebview = syncToWebview;
  loadSymbols();
  // Remember where the caret was in the story, since opening the picker or the
  // command palette moves focus away from it.
  document.addEventListener('selectionchange', () => {
    const ed = refs.storyEditor;
    if (!ed || picker) return;
    const s = window.getSelection();
    if (s.rangeCount && ed.contains(s.anchorNode)) lastSel = selectionOffsets(ed) || lastSel;
  });
  document.addEventListener('mousedown', (e) => { if (picker && !picker.contains(e.target)) closeSymbolPicker(); });
}
