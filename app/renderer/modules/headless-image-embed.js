// headless-image-embed.js — Inline scene image embedding for the headless editor
//
// Images live as <figure contenteditable="false"> nodes in the editor.
// They are stripped before syncing to NovelAI and re-injected after.
// All placement data is persisted in the story_images SQLite table.

import { state, bus } from './state.js';
import * as refs from './dom-refs.js';
import { showToast } from './utils.js';

// In-memory cache of story images for the current story
let _storyImages = [];
let _syncToWebview = null;
let _lastUsedLayout = 'break';

/**
 * Strip all <figure data-image-id> elements from the editor.
 * Updates paragraph_index on each record before stripping so SQLite
 * reflects the current position. Call this before syncToWebview().
 */
export function stripFigures() {
  const editor = refs.storyEditor;
  if (!editor) return;

  const figures = Array.from(editor.querySelectorAll('figure[data-image-id]'));
  figures.forEach(fig => {
    const rowId = fig.dataset.imageId;
    const paraIdx = _getParagraphIndex(editor, fig);
    // Update in-memory record so position is accurate when restoring
    const record = _storyImages.find(r => r.id === rowId);
    if (record) {
      record.paragraph_index = paraIdx;
      // Persist updated position (fire-and-forget)
      window.powertool.storyImagesSet(record);
    }
    fig.remove();
  });
}

/**
 * Re-inject all figures for the current story after syncFromWebview().
 */
export async function restoreFigures() {
  const editor = refs.storyEditor;
  if (!editor || !state.currentStoryId) return;

  // Remove any stale figures first
  editor.querySelectorAll('figure[data-image-id]').forEach(f => f.remove());

  // Insert in reverse paragraph_index order so earlier inserts don't shift later ones
  const sorted = [..._storyImages].sort((a, b) => b.paragraph_index - a.paragraph_index);
  for (const record of sorted) {
    const fig = await _createFigure(record);
    if (fig) _insertAtParagraph(editor, fig, record.paragraph_index);
  }
}

/**
 * Count block-level child nodes before `target` inside `editor`.
 * Used to compute paragraph_index for a figure element.
 */
function _getParagraphIndex(editor, target) {
  let count = 0;
  for (const node of editor.childNodes) {
    if (node === target) break;
    if (node.nodeType === Node.ELEMENT_NODE) count++;
  }
  return count;
}

/**
 * Insert `fig` after the Nth block-level child of `editor`.
 */
function _insertAtParagraph(editor, fig, paragraphIndex) {
  const blockChildren = Array.from(editor.childNodes).filter(
    n => n.nodeType === Node.ELEMENT_NODE
  );
  if (paragraphIndex >= blockChildren.length) {
    editor.appendChild(fig);
  } else {
    blockChildren[paragraphIndex].after(fig);
  }
}

/**
 * Load story images from SQLite for the given story.
 * Called on story load.
 */
export async function loadStoryImages(storyId) {
  if (!storyId) { _storyImages = []; return; }
  _storyImages = await window.powertool.storyImagesGet(storyId);
}

async function _createFigure(record, dataUrlOverride) {
  const dataUrl = dataUrlOverride || await window.powertool.storyImagesGetDataUrl(
    record.story_id, record.image_id
  );
  if (!dataUrl) return null;

  const fig = document.createElement('figure');
  fig.contentEditable = 'false';
  fig.dataset.imageId = record.id;
  fig.dataset.mediaId = record.image_id;
  fig.className = `editor-image layout-${record.layout_mode} float-${record.float_side}`;

  const img = document.createElement('img');
  img.src = dataUrl;
  img.alt = record.caption || '';
  img.draggable = false;
  fig.appendChild(img);

  if (record.caption) {
    const cap = document.createElement('figcaption');
    cap.textContent = record.caption;
    fig.appendChild(cap);
  }

  _attachHoverToolbar(fig, record);
  if (record.layout_mode === 'break') _attachBreakStrip(fig, record);

  return fig;
}

/**
 * Auto-place a newly generated image at the current cursor paragraph.
 * @param {string} imageId  - media_items id
 * @param {string} dataUrl  - full data URI for immediate display
 */
export async function autoPlaceImage(imageId, dataUrl) {
  const editor = refs.storyEditor;
  if (!editor || !state.currentStoryId) return;

  const paragraphIndex = _getCurrentParagraphIndex(editor);
  const id = 'img_' + Date.now() + '_' + Math.random().toString(36).slice(2, 7);

  const record = {
    id,
    story_id: state.currentStoryId,
    image_id: imageId,
    paragraph_index: paragraphIndex,
    layout_mode: _lastUsedLayout,
    float_side: 'right',
    caption: '',
    created_at: Date.now(),
    _dataUrl: dataUrl, // transient — not persisted
  };

  await window.powertool.storyImagesSet(record);
  _storyImages.push(record);

  const fig = await _createFigure(record, dataUrl);
  if (fig) _insertAtParagraph(editor, fig, paragraphIndex);
}

function _getCurrentParagraphIndex(editor) {
  const sel = window.getSelection();
  if (!sel.rangeCount) return Math.max(0, editor.childElementCount - 1);
  const range = sel.getRangeAt(0);
  let node = range.commonAncestorContainer;
  // Walk up to find direct child of editor
  while (node && node.parentNode !== editor) node = node.parentNode;
  if (!node) return Math.max(0, editor.childElementCount - 1);
  const blockChildren = Array.from(editor.childNodes).filter(n => n.nodeType === Node.ELEMENT_NODE);
  return blockChildren.indexOf(node);
}

export function init({ syncToWebview }) {
  _syncToWebview = syncToWebview;

  // Auto-place images on generation
  bus.on('image:generated', async ({ imageData, storyId }) => {
    if (!state.headlessMode || storyId !== state.currentStoryId) return;
    await autoPlaceImage(null, imageData);
  });

  // Reset on story change
  bus.on('story:changed', () => { _storyImages = []; });
}

// --- Hover Toolbar ---

const LAYOUT_ICONS = {
  break:  '⬛',
  float:  '↩',
  margin: '▐',
  bleed:  '⬜',
};

function _attachHoverToolbar(fig, record) {
  const toolbar = document.createElement('div');
  toolbar.className = 'image-hover-toolbar';
  toolbar.setAttribute('contenteditable', 'false');

  const modeGroup = document.createElement('span');
  modeGroup.className = 'image-toolbar-modes';

  ['break', 'float', 'margin', 'bleed'].forEach(mode => {
    const btn = document.createElement('button');
    btn.type = 'button';
    btn.title = mode.charAt(0).toUpperCase() + mode.slice(1);
    btn.textContent = LAYOUT_ICONS[mode];
    btn.className = 'image-toolbar-btn' + (record.layout_mode === mode ? ' active' : '');
    btn.onclick = (e) => { e.stopPropagation(); _setLayout(fig, record, mode); };
    modeGroup.appendChild(btn);
  });

  const swapBtn = document.createElement('button');
  swapBtn.type = 'button';
  swapBtn.className = 'image-toolbar-btn';
  swapBtn.title = 'Swap image';
  swapBtn.textContent = '⇄';
  swapBtn.onclick = (e) => { e.stopPropagation(); _openSwapPicker(fig, record); };

  const settingsBtn = document.createElement('button');
  settingsBtn.type = 'button';
  settingsBtn.className = 'image-toolbar-btn';
  settingsBtn.title = 'Image settings';
  settingsBtn.textContent = '⚙';
  settingsBtn.onclick = (e) => { e.stopPropagation(); _togglePopover(fig, record); };

  const removeBtn = document.createElement('button');
  removeBtn.type = 'button';
  removeBtn.className = 'image-toolbar-btn remove';
  removeBtn.title = 'Remove image';
  removeBtn.textContent = '✕';
  removeBtn.onclick = (e) => { e.stopPropagation(); _removeImage(fig, record); };

  toolbar.appendChild(modeGroup);
  toolbar.appendChild(swapBtn);
  toolbar.appendChild(settingsBtn);
  toolbar.appendChild(removeBtn);
  fig.appendChild(toolbar);
}

// --- Break Strip (shown only in break layout mode) ---

function _attachBreakStrip(fig, record) {
  fig.querySelector('.image-break-strip')?.remove();

  const strip = document.createElement('div');
  strip.className = 'image-break-strip';
  strip.setAttribute('contenteditable', 'false');

  ['break', 'float', 'margin', 'bleed'].forEach(mode => {
    const pill = document.createElement('button');
    pill.type = 'button';
    pill.textContent = mode.charAt(0).toUpperCase() + mode.slice(1);
    pill.className = 'image-strip-pill' + (record.layout_mode === mode ? ' active' : '');
    pill.onclick = (e) => { e.stopPropagation(); _setLayout(fig, record, mode); };
    strip.appendChild(pill);
  });

  const sep = document.createElement('span');
  sep.className = 'image-strip-sep';
  strip.appendChild(sep);

  const removeBtn = document.createElement('button');
  removeBtn.type = 'button';
  removeBtn.className = 'image-strip-pill remove';
  removeBtn.textContent = '✕ Remove';
  removeBtn.onclick = (e) => { e.stopPropagation(); _removeImage(fig, record); };
  strip.appendChild(removeBtn);

  fig.appendChild(strip);
}

// --- Popover (settings) ---

function _togglePopover(fig, record) {
  let popover = fig.querySelector('.image-popover');
  if (popover) {
    if (fig._popoverClose) { document.removeEventListener('click', fig._popoverClose); delete fig._popoverClose; }
    popover.remove();
    return;
  }

  popover = document.createElement('div');
  popover.className = 'image-popover';
  popover.setAttribute('contenteditable', 'false');

  popover.innerHTML = `
    <div class="popover-row">
      <label>Caption</label>
      <input type="text" class="popover-caption" placeholder="Optional caption..." value="${_escapeHtml(record.caption || '')}">
    </div>
    <div class="popover-row" data-float-row style="${record.layout_mode !== 'float' ? 'display:none' : ''}">
      <label>Float side</label>
      <div class="popover-toggle">
        <button type="button" class="${record.float_side === 'left' ? 'active' : ''}" data-side="left">Left</button>
        <button type="button" class="${record.float_side === 'right' ? 'active' : ''}" data-side="right">Right</button>
      </div>
    </div>
    <div class="popover-row">
      <button type="button" class="popover-save btn-sm primary">Save</button>
    </div>
  `;

  popover.querySelector('.popover-save').onclick = () => {
    record.caption = popover.querySelector('.popover-caption').value;
    _persistRecord(record);
    let cap = fig.querySelector('figcaption');
    if (record.caption && !cap) {
      cap = document.createElement('figcaption');
      fig.querySelector('img').after(cap);
    }
    if (cap) cap.textContent = record.caption;
    if (!record.caption && cap) cap.remove();
    if (fig._popoverClose) { document.removeEventListener('click', fig._popoverClose); delete fig._popoverClose; }
    popover.remove();
  };

  popover.querySelectorAll('[data-side]').forEach(btn => {
    btn.onclick = () => {
      record.float_side = btn.dataset.side;
      popover.querySelectorAll('[data-side]').forEach(b => b.classList.remove('active'));
      btn.classList.add('active');
    };
  });

  fig.appendChild(popover);

  const close = (e) => {
    if (!fig.contains(e.target)) {
      popover.remove();
      document.removeEventListener('click', close);
      delete fig._popoverClose;
    }
  };
  fig._popoverClose = close;
  setTimeout(() => document.addEventListener('click', close), 50);
}

// --- Actions ---

function _setLayout(fig, record, mode) {
  record.layout_mode = mode;
  _lastUsedLayout = mode;
  fig.className = `editor-image layout-${mode} float-${record.float_side}`;
  fig.querySelectorAll('.image-toolbar-btn').forEach(btn => {
    if (btn.title.toLowerCase() === mode) btn.classList.add('active');
    else if (Object.keys(LAYOUT_ICONS).includes(btn.title.toLowerCase())) btn.classList.remove('active');
  });
  if (mode === 'break') _attachBreakStrip(fig, record);
  else fig.querySelector('.image-break-strip')?.remove();
  fig.querySelectorAll('.image-strip-pill').forEach(pill => {
    pill.classList.toggle('active', pill.textContent.toLowerCase() === mode);
  });
  _persistRecord(record);
}

function _removeImage(fig, record) {
  if (fig._popoverClose) { document.removeEventListener('click', fig._popoverClose); delete fig._popoverClose; }
  window.powertool.storyImagesRemove(record.id);
  _storyImages = _storyImages.filter(r => r.id !== record.id);
  fig.remove();
}

function _openSwapPicker(fig, record) {
  showToast('Swap: generate a new image while this panel is open to replace it', 4000);
}

function _persistRecord(record) {
  window.powertool.storyImagesSet(record);
  const idx = _storyImages.findIndex(r => r.id === record.id);
  if (idx !== -1) _storyImages[idx] = record;
}

function _escapeHtml(str) {
  return str.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}
