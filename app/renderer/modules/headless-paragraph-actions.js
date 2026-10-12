// headless-paragraph-actions.js - Per-paragraph AI edits (NovelAI's paragraph star)
//
// A star button sits in the left gutter beside the hovered paragraph (or the
// one holding the caret). It opens a card with Transform / Expand / Condense /
// Rewrite Style / Custom, an instruction box for any of them, Adjust (run the
// AI on the text in the card), Save (replace the paragraph) and Cancel.
// Everything lives in an overlay on #editorContainer, never inside the
// contenteditable, so editor re-renders and the text model are untouched.

import { state, bus } from './state.js';
import * as refs from './dom-refs.js';
import { showToast } from './utils.js';
import { editorText, linearize, naiLineClass } from './diff.js';

const ACTIONS = [
  { id: 'transform', label: 'Transform', hint: 'Optional: how to change it (e.g. "make her angrier")' },
  { id: 'expand', label: 'Expand', hint: 'Optional: what to add (e.g. "more about the smell of the room")' },
  { id: 'condense', label: 'Condense', hint: 'Optional: what to keep or cut' },
  { id: 'rewrite-style', label: 'Rewrite Style', hint: 'Optional: the style (e.g. "noir, short punchy sentences")' },
  { id: 'custom', label: 'Custom', hint: 'Describe the change you want (required)' },
];
const CONTEXT_BEFORE = 2000;
const CONTEXT_AFTER = 600;

let _syncToWebview = null;
let star = null;
let card = null;
let hoverP = null;   // paragraph under the mouse
let starP = null;    // paragraph the star points at
let edit = null;     // { p, index, original, action, busy }

function paragraphs() {
  return Array.from(refs.storyEditor.children).filter((n) => n.tagName === 'P');
}

function caretParagraph() {
  const sel = window.getSelection();
  if (!sel.rangeCount || !refs.storyEditor.contains(sel.anchorNode)) return null;
  let n = sel.anchorNode;
  while (n && n.parentNode !== refs.storyEditor) n = n.parentNode;
  return n && n.tagName === 'P' ? n : null;
}

function editable() {
  return state.headlessMode && refs.storyEditor.isContentEditable;
}

// --- Star placement ---

function placeStar() {
  if (!star) return;
  const p = hoverP && hoverP.isConnected ? hoverP : caretParagraph();
  // Not on NovelAI notation lines (## comments, [ headers ], *** breaks): nothing to rewrite.
  const isNotation = p && (naiLineClass(p.textContent) || /^\s*(\*\*\*|⁂)\s*$/.test(p.textContent));
  if (!p || !editable() || !p.textContent.trim() || isNotation || card?.classList.contains('is-open')) {
    star.classList.add('u-hidden');
    starP = null;
    return;
  }
  const box = refs.editorContainer.getBoundingClientRect();
  const ed = refs.storyEditor.getBoundingClientRect();
  const pr = p.getBoundingClientRect();
  if (pr.bottom < ed.top || pr.top > ed.bottom) { star.classList.add('u-hidden'); starP = null; return; }
  const lineH = parseFloat(getComputedStyle(p).lineHeight) || 32;
  const top = Math.max(ed.top, pr.top + (lineH - 36) / 2) - box.top;
  const left = Math.max(4, pr.left - box.left - 48);
  star.style.top = `${Math.round(top)}px`;
  star.style.left = `${Math.round(left)}px`;
  star.classList.remove('u-hidden');
  starP = p;
}

// --- Card ---

function buildCard() {
  card = document.createElement('div');
  card.className = 'para-card u-hidden';
  card.setAttribute('role', 'dialog');
  card.setAttribute('aria-label', 'Edit paragraph with AI');
  card.innerHTML = `
    <div class="para-card-actions" role="toolbar">
      ${ACTIONS.map((a) => `<button type="button" class="para-action" data-action="${a.id}" aria-pressed="false">${a.label}</button>`).join('')}
    </div>
    <div class="para-card-row">
      <input type="text" class="para-instruction" aria-label="Instruction for the AI">
      <button type="button" class="para-adjust">Adjust &#9656;</button>
    </div>
    <textarea class="para-text" aria-label="Paragraph text" spellcheck="true"></textarea>
    <div class="para-card-foot">
      <span class="para-status" aria-live="polite"></span>
      <button type="button" class="para-narrate" title="Read the text in this card aloud">&#9654; Narrate</button>
      <button type="button" class="para-revert">Undo changes</button>
      <button type="button" class="para-save">&#10003; Save</button>
      <button type="button" class="para-cancel">&#10005; Cancel</button>
    </div>`;
  refs.editorContainer.appendChild(card);

  card.querySelectorAll('.para-action').forEach((b) =>
    b.addEventListener('click', () => { setAction(b.dataset.action); card.querySelector('.para-instruction').focus(); }));
  card.querySelector('.para-adjust').addEventListener('click', runAdjust);
  card.querySelector('.para-instruction').addEventListener('keydown', (e) => {
    if (e.key === 'Enter') { e.preventDefault(); runAdjust(); }
  });
  card.querySelector('.para-instruction').addEventListener('input', updateButtons);
  card.querySelector('.para-text').addEventListener('input', () => { autoGrow(); updateButtons(); });
  card.querySelector('.para-revert').addEventListener('click', () => {
    card.querySelector('.para-text').value = edit.original;
    autoGrow(); updateButtons(); setStatus('');
  });
  // Hear the card's text (the original, or the AI's version before you Save).
  card.querySelector('.para-narrate').addEventListener('click', () => narrate(card.querySelector('.para-text').value));
  card.querySelector('.para-save').addEventListener('click', saveEdit);
  card.querySelector('.para-cancel').addEventListener('click', closeCard);
  card.addEventListener('keydown', (e) => { if (e.key === 'Escape') { e.preventDefault(); closeCard(); } });
}

function setAction(id) {
  edit.action = id;
  const spec = ACTIONS.find((a) => a.id === id);
  card.querySelectorAll('.para-action').forEach((b) => b.setAttribute('aria-pressed', String(b.dataset.action === id)));
  card.querySelector('.para-instruction').placeholder = spec.hint;
  updateButtons();
}

function setStatus(msg, variant = '') {
  const el = card.querySelector('.para-status');
  el.textContent = msg;
  el.className = 'para-status' + (variant ? ' ' + variant : '');
}

function autoGrow() {
  const ta = card.querySelector('.para-text');
  ta.style.height = 'auto';
  ta.style.height = `${Math.min(ta.scrollHeight + 4, 420)}px`;
}

function updateButtons() {
  if (!edit) return;
  const instr = card.querySelector('.para-instruction').value.trim();
  const text = card.querySelector('.para-text').value;
  card.querySelector('.para-adjust').disabled = edit.busy || !text.trim() || (edit.action === 'custom' && !instr);
  card.querySelector('.para-save').disabled = edit.busy || text === edit.original || !text.trim();
  card.querySelector('.para-revert').disabled = edit.busy || text === edit.original;
}

function placeCard() {
  if (!edit || !card.classList.contains('is-open')) return;
  const box = refs.editorContainer.getBoundingClientRect();
  const ed = refs.storyEditor.getBoundingClientRect();
  const p = edit.p.isConnected ? edit.p : paragraphs()[edit.index];
  const pr = p ? p.getBoundingClientRect() : ed;
  const width = Math.min(ed.width - 32, 900);
  card.style.width = `${Math.round(width)}px`;
  card.style.left = `${Math.round(ed.left - box.left + (ed.width - width) / 2)}px`;
  // Over the paragraph, kept inside the visible editor area.
  const h = card.offsetHeight;
  let top = pr.top - box.top - 8;
  top = Math.min(top, ed.bottom - box.top - h - 8);
  top = Math.max(top, ed.top - box.top + 8);
  card.style.top = `${Math.round(top)}px`;
}

function openCard(p, actionId) {
  if (!p) return;
  if (!card) buildCard();
  const index = paragraphs().indexOf(p);
  const original = textOfParagraph(p);
  edit = { p, index, original, action: 'transform', busy: false };
  card.querySelector('.para-instruction').value = '';
  card.querySelector('.para-text').value = original;
  setStatus('');
  setAction(actionId || 'transform');
  card.classList.remove('u-hidden');
  card.classList.add('is-open');
  p.classList.add('para-editing');
  star.classList.add('u-hidden');
  autoGrow();
  placeCard();
  card.querySelector('.para-instruction').focus();
}

function closeCard() {
  if (!card) return;
  card.classList.remove('is-open');
  card.classList.add('u-hidden');
  refs.storyEditor.querySelectorAll('.para-editing').forEach((n) => n.classList.remove('para-editing'));
  edit = null;
  placeStar();
}

function textOfParagraph(p) {
  const { text, entries } = linearize(refs.storyEditor);
  const e = entries.get(p);
  return e ? text.slice(e.start, e.end) : p.textContent;
}

// --- AI ---

async function runAdjust() {
  if (!edit || edit.busy) return;
  if (state.isWaitingForGeneration) { setStatus('Wait for the story generation to finish', 'warn'); return; }
  const instruction = card.querySelector('.para-instruction').value.trim();
  const text = card.querySelector('.para-text').value;
  if (edit.action === 'custom' && !instruction) { setStatus('Write what you want changed first', 'warn'); return; }

  // Context comes from the story as it is now, around the paragraph being edited.
  const full = editorText(refs.storyEditor);
  const p = edit.p.isConnected ? edit.p : paragraphs()[edit.index];
  const entry = p && linearize(refs.storyEditor).entries.get(p);
  const start = entry ? entry.start : full.indexOf(edit.original);
  const end = entry ? entry.end : start + edit.original.length;
  const before = start > 0 ? full.slice(Math.max(0, start - CONTEXT_BEFORE), start).trim() : '';
  const after = end >= 0 ? full.slice(end, end + CONTEXT_AFTER).trim() : '';

  edit.busy = true;
  updateButtons();
  const label = ACTIONS.find((a) => a.id === edit.action).label;
  setStatus(`${label}: asking the AI...`);
  card.classList.add('busy');
  const mine = edit;
  try {
    const res = await window.powertool.paragraphAction({
      action: edit.action, instruction, text, before, after, storyId: state.currentStoryId,
    });
    if (edit !== mine) return; // card was closed or reopened meanwhile
    if (res?.error) throw new Error(res.error);
    card.querySelector('.para-text').value = res.output;
    autoGrow();
    setStatus('Review the new text, edit it if you like, then Save. Adjust again to keep refining.', 'ok');
  } catch (e) {
    if (edit === mine) setStatus(`${label} failed: ${e.message}`, 'error');
  } finally {
    if (edit === mine) { edit.busy = false; card.classList.remove('busy'); updateButtons(); placeCard(); }
  }
}

// --- Save: replace the paragraph through the browser's own input path ---

async function saveEdit() {
  if (!edit || edit.busy) return;
  const newText = card.querySelector('.para-text').value.replace(/\s+$/, '');
  if (!newText.trim()) return;

  // Find the paragraph again and make sure it was not changed under us
  // (a NovelAI read or generation can re-render the editor).
  let p = edit.p.isConnected ? edit.p : null;
  if (!p || textOfParagraph(p) !== edit.original) {
    p = paragraphs().find((n) => textOfParagraph(n) === edit.original) || null;
  }
  if (!p) {
    setStatus('That paragraph changed in the story since you opened this. Copy your text, then Cancel and try again.', 'error');
    return;
  }

  const editor = refs.storyEditor;
  const before = editorText(editor);
  const entry = linearize(editor).entries.get(p);
  editor.focus();
  const range = document.createRange();
  range.selectNodeContents(p);
  const sel = window.getSelection();
  sel.removeAllRanges();
  sel.addRange(range);
  document.execCommand('insertText', false, newText);

  // Prove the edit landed exactly: the story must equal the old story with
  // only this paragraph swapped. If the browser did anything else, undo it.
  const expected = before.slice(0, entry.start) + newText + before.slice(entry.end);
  if (editorText(editor) !== expected) {
    document.execCommand('undo');
    if (editorText(editor) !== before) console.warn('[ParagraphActions] undo did not restore the text');
    setStatus('Could not replace the paragraph cleanly; nothing was changed.', 'error');
    return;
  }
  closeCard();
  showToast('Paragraph updated', 2500, 'success');
  if (_syncToWebview) await _syncToWebview();
}

// --- Init ---

export function init({ syncToWebview }) {
  _syncToWebview = syncToWebview;
  const editor = refs.storyEditor;
  if (!editor || !refs.editorContainer) return;

  star = document.createElement('button');
  star.type = 'button';
  star.className = 'para-star u-hidden';
  star.title = 'Edit this paragraph with AI';
  star.setAttribute('aria-label', 'Edit this paragraph with AI');
  star.textContent = '✦';
  // mousedown would move the caret out of the editor and hide the star first
  star.addEventListener('mousedown', (e) => e.preventDefault());
  star.addEventListener('click', () => openCard(starP));
  refs.editorContainer.appendChild(star);

  editor.addEventListener('mousemove', (e) => {
    const p = e.target.closest && e.target.closest('#storyEditor > p');
    if (p && p !== hoverP) { hoverP = p; placeStar(); }
  });
  refs.editorContainer.addEventListener('mouseleave', () => { hoverP = null; placeStar(); });
  editor.addEventListener('scroll', () => { placeStar(); placeCard(); });
  editor.addEventListener('keyup', () => { hoverP = null; placeStar(); });
  editor.addEventListener('click', () => { hoverP = null; placeStar(); });
  editor.addEventListener('input', () => placeStar());
  window.addEventListener('resize', () => { placeStar(); placeCard(); });

  // Keyboard: Ctrl+Shift+E opens the card for the caret's paragraph;
  // Ctrl+Shift+N reads the selection (or the caret's paragraph) aloud.
  editor.addEventListener('keydown', (e) => {
    if ((e.ctrlKey || e.metaKey) && e.shiftKey && e.key.toLowerCase() === 'e') {
      const p = caretParagraph();
      if (p && p.textContent.trim()) { e.preventDefault(); openCard(p); }
    } else if ((e.ctrlKey || e.metaKey) && e.shiftKey && e.key.toLowerCase() === 'n') {
      e.preventDefault();
      narrateSelectionOrParagraph();
    }
  });
  document.addEventListener('selectionchange', () => {
    const sel = window.getSelection();
    if (sel.rangeCount && editor.contains(sel.anchorNode)) lastEditorRange = sel.getRangeAt(0).cloneRange();
  });
}

// --- Narrate: read the selection, or the caret's paragraph, aloud ---

let lastEditorRange = null;  // the palette input steals the selection; remember the editor's

function narrate(text) {
  if (!text || !text.trim()) { showToast('Select some text or put the cursor in a paragraph first', 3000, 'warn'); return; }
  bus.emit('tts:narrate-text', { text, label: 'Narrating' });
}

export function narrateSelectionOrParagraph() {
  const sel = window.getSelection();
  let range = sel.rangeCount && refs.storyEditor.contains(sel.anchorNode) ? sel.getRangeAt(0) : lastEditorRange;
  if (range && !refs.storyEditor.contains(range.startContainer)) range = null;
  if (range && !range.collapsed) { narrate(range.toString()); return; }
  let p = null;
  if (range) {
    p = range.startContainer;
    while (p && p.parentNode !== refs.storyEditor) p = p.parentNode;
  }
  narrate(p && p.tagName === 'P' ? textOfParagraph(p) : '');
}

// For the command palette / tests
export function openForCaret(actionId) {
  const p = caretParagraph();
  if (p && p.textContent.trim()) openCard(p, actionId);
  else showToast('Put the cursor in a paragraph first', 2500);
}
