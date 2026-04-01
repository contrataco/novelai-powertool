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

// Stub — full implementation added in Task 4
async function _createFigure(record, dataUrlOverride) {
  return null; // placeholder
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
  bus.on('image:generated', async ({ imageId, dataUrl, storyId }) => {
    if (!state.headlessMode || storyId !== state.currentStoryId) return;
    await autoPlaceImage(imageId, dataUrl);
  });

  // Reset on story change
  bus.on('story:changed', () => { _storyImages = []; });
}
