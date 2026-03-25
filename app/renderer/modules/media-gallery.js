// media-gallery.js — Auto-save generated images/videos, browsable gallery grid, lightbox viewer

import { state, bus } from './state.js';
import {
  mediaGrid, mediaCount, mediaFilterSelect,
  mediaLightbox, mediaLightboxContent, mediaLightboxClose,
  mediaContent,
} from './dom-refs.js';
import { showToast } from './utils.js';
import { switchPanelTab } from './lore-creator.js';

let galleryItems = [];
let currentFilter = 'all';

// ---------------------------------------------------------------------------
// Auto-save hooks
// ---------------------------------------------------------------------------

async function autoSaveImage(imageData, meta) {
  try {
    const metadata = {
      prompt: state.currentPrompt || '',
      negativePrompt: state.currentNegativePrompt || '',
      provider: meta?.provider || '',
      model: meta?.model || '',
      width: meta?.width || 0,
      height: meta?.height || 0,
    };
    await window.powertool.mediaSaveImage(state.currentStoryId, imageData, metadata);
    // Refresh grid if media tab is visible
    if (mediaContent && mediaContent.classList.contains('active')) {
      refreshGallery();
    }
  } catch (e) {
    console.error('[MediaGallery] Auto-save image failed:', e);
  }
}

async function autoSaveVideo(videoDataUrl, meta) {
  try {
    const metadata = {
      prompt: meta?.prompt || state.currentPrompt || '',
      negativePrompt: meta?.negativePrompt || state.currentNegativePrompt || '',
      provider: meta?.provider || '',
      model: meta?.model || '',
    };
    await window.powertool.mediaSaveVideo(state.currentStoryId, videoDataUrl, metadata);
    if (mediaContent && mediaContent.classList.contains('active')) {
      refreshGallery();
    }
  } catch (e) {
    console.error('[MediaGallery] Auto-save video failed:', e);
  }
}

// ---------------------------------------------------------------------------
// Gallery refresh + rendering
// ---------------------------------------------------------------------------

async function refreshGallery() {
  if (!state.currentStoryId) return;
  try {
    const opts = currentFilter !== 'all' ? { type: currentFilter } : {};
    galleryItems = await window.powertool.mediaList(state.currentStoryId, opts);
    renderGrid(galleryItems);
    updateCount();
  } catch (e) {
    console.error('[MediaGallery] Refresh failed:', e);
  }
}

async function updateCount() {
  if (!state.currentStoryId || !mediaCount) return;
  try {
    const counts = await window.powertool.mediaGetCount(state.currentStoryId);
    const total = counts.images + counts.videos;
    mediaCount.textContent = `(${total})`;
  } catch { /* ignore */ }
}

function renderGrid(items) {
  if (!mediaGrid) return;

  if (!items || items.length === 0) {
    mediaGrid.innerHTML = `<div class="media-empty-state">
      <span style="font-size:24px;opacity:0.3;">&#128247;</span>
      <div style="font-size:11px;color:var(--text-dim);margin-top:4px;">Generated images will appear here</div>
    </div>`;
    return;
  }

  mediaGrid.innerHTML = '';
  for (const item of items) {
    const cell = document.createElement('div');
    cell.className = 'media-grid-cell';
    cell.dataset.mediaId = item.id;

    if (item.type === 'video') {
      cell.innerHTML = `
        <div style="width:100%;height:100%;background:rgba(0,0,0,0.5);display:flex;align-items:center;justify-content:center;">
          <span class="media-video-icon">&#9654;</span>
        </div>
        <span class="media-badge">${item.provider || 'video'}</span>`;
    } else {
      // Load thumbnail async
      const img = document.createElement('img');
      img.alt = 'thumbnail';
      img.style.background = 'rgba(0,0,0,0.3)';
      cell.appendChild(img);

      loadThumbnail(item, img);

      const badge = document.createElement('span');
      badge.className = 'media-badge';
      badge.textContent = item.provider || 'image';
      cell.appendChild(badge);
    }

    cell.addEventListener('click', () => openLightbox(item));
    mediaGrid.appendChild(cell);
  }
}

async function loadThumbnail(item, imgEl) {
  try {
    const thumbDataUrl = await window.powertool.mediaGetThumbnail(state.currentStoryId, item.id);
    if (thumbDataUrl) {
      imgEl.src = thumbDataUrl;
    } else {
      // Fallback: load full image
      const fullDataUrl = await window.powertool.mediaGetFull(state.currentStoryId, item.id);
      if (fullDataUrl) imgEl.src = fullDataUrl;
    }
  } catch { /* ignore */ }
}

// ---------------------------------------------------------------------------
// Lightbox
// ---------------------------------------------------------------------------

async function openLightbox(item) {
  if (!mediaLightbox || !mediaLightboxContent) return;

  mediaLightboxContent.innerHTML = '<div style="text-align:center;padding:20px;"><div class="spinner"></div></div>';
  mediaLightbox.style.display = 'flex';

  try {
    let mediaHtml = '';
    if (item.type === 'video') {
      const videoDataUrl = await window.powertool.mediaGetVideo(state.currentStoryId, item.id);
      if (videoDataUrl) {
        mediaHtml = `<div class="media-lightbox-media"><video controls autoplay muted style="max-width:100%;max-height:50vh;border-radius:6px;display:block;margin:0 auto 12px;"><source src="${videoDataUrl}" type="video/mp4"></video></div>`;
      }
    } else {
      const fullDataUrl = await window.powertool.mediaGetFull(state.currentStoryId, item.id);
      if (fullDataUrl) {
        mediaHtml = `<div class="media-lightbox-media"><img src="${fullDataUrl}" alt="Full image"></div>`;
      }
    }

    const date = new Date(item.created_at);
    const timeStr = date.toLocaleString();
    const sizeStr = item.file_size ? `${(item.file_size / 1024).toFixed(0)} KB` : '';
    const resStr = (item.width && item.height) ? `${item.width}x${item.height}` : '';

    const promptHtml = item.prompt
      ? `<div class="media-lightbox-prompt"><span class="meta-label">Prompt:</span> ${escapeHtml(item.prompt)}</div>`
      : '';
    const negPromptHtml = item.negative_prompt
      ? `<div class="media-lightbox-prompt" style="opacity:0.7;"><span class="meta-label">Negative:</span> ${escapeHtml(item.negative_prompt)}</div>`
      : '';

    mediaLightboxContent.innerHTML = `
      ${mediaHtml}
      <div class="media-lightbox-meta">
        <span class="meta-label">Provider:</span> ${escapeHtml(item.provider || 'unknown')}
        ${item.model ? ` &middot; <span class="meta-label">Model:</span> ${escapeHtml(item.model)}` : ''}
        ${resStr ? ` &middot; ${resStr}` : ''}
        ${sizeStr ? ` &middot; ${sizeStr}` : ''}
        <br><span class="meta-label">Time:</span> ${timeStr}
      </div>
      ${promptHtml}
      ${negPromptHtml}
      <div class="media-lightbox-actions">
        <button id="mediaLbCopyPrompt" title="Copy prompt to clipboard">Copy Prompt</button>
        <button id="mediaLbReusePrompt" title="Set as current prompt and switch to Scene tab">Re-use Prompt</button>
        <button id="mediaLbDownload" title="Download file">Download</button>
        <button id="mediaLbDelete" class="btn-danger" title="Delete from gallery">Delete</button>
      </div>
    `;

    // Wire action buttons
    const copyBtn = document.getElementById('mediaLbCopyPrompt');
    const reuseBtn = document.getElementById('mediaLbReusePrompt');
    const downloadBtn = document.getElementById('mediaLbDownload');
    const deleteBtn = document.getElementById('mediaLbDelete');

    if (copyBtn) {
      copyBtn.addEventListener('click', () => {
        navigator.clipboard.writeText(item.prompt || '').then(() => showToast('Prompt copied', 2000));
      });
    }

    if (reuseBtn) {
      reuseBtn.addEventListener('click', () => {
        state.currentPrompt = item.prompt || '';
        state.currentNegativePrompt = item.negative_prompt || '';
        const promptDisplay = document.getElementById('promptDisplay');
        if (promptDisplay) promptDisplay.value = state.currentPrompt;
        closeLightbox();
        switchPanelTab('scene');
        showToast('Prompt loaded', 2000);
      });
    }

    if (downloadBtn) {
      downloadBtn.addEventListener('click', async () => {
        try {
          let dataUrl;
          if (item.type === 'video') {
            dataUrl = await window.powertool.mediaGetVideo(state.currentStoryId, item.id);
          } else {
            dataUrl = await window.powertool.mediaGetFull(state.currentStoryId, item.id);
          }
          if (dataUrl) {
            const a = document.createElement('a');
            a.href = dataUrl;
            a.download = item.filename || (item.type === 'video' ? 'video.mp4' : 'image.png');
            document.body.appendChild(a);
            a.click();
            document.body.removeChild(a);
          }
        } catch (e) {
          showToast('Download failed: ' + e.message, 3000, 'error');
        }
      });
    }

    if (deleteBtn) {
      deleteBtn.addEventListener('click', async () => {
        if (!confirm('Delete this item from gallery?')) return;
        try {
          await window.powertool.mediaDelete(state.currentStoryId, item.id);
          closeLightbox();
          // Remove from cached items and re-render
          galleryItems = galleryItems.filter(g => g.id !== item.id);
          renderGrid(galleryItems);
          updateCount();
          showToast('Deleted', 2000);
        } catch (e) {
          showToast('Delete failed: ' + e.message, 3000, 'error');
        }
      });
    }
  } catch (e) {
    mediaLightboxContent.innerHTML = `<div style="color:var(--error);padding:16px;">Failed to load: ${escapeHtml(e.message)}</div>`;
  }
}

function closeLightbox() {
  if (mediaLightbox) mediaLightbox.style.display = 'none';
  if (mediaLightboxContent) mediaLightboxContent.innerHTML = '';
}

function escapeHtml(str) {
  const div = document.createElement('div');
  div.textContent = str;
  return div.innerHTML;
}

// ---------------------------------------------------------------------------
// Init
// ---------------------------------------------------------------------------

export function init() {
  // Auto-save hooks
  bus.on('image:generated', ({ imageData, meta }) => {
    if (!state.currentStoryId) return;
    autoSaveImage(imageData, meta);
  });

  bus.on('video:generated', ({ videoDataUrl, meta }) => {
    if (!state.currentStoryId) return;
    autoSaveVideo(videoDataUrl, meta);
  });

  // Tab activation
  bus.on('media:tab-activated', refreshGallery);

  // Story switch — clear gallery
  bus.on('story:changed', () => {
    galleryItems = [];
    renderGrid([]);
  });

  // Filter change
  if (mediaFilterSelect) {
    mediaFilterSelect.addEventListener('change', () => {
      currentFilter = mediaFilterSelect.value;
      refreshGallery();
    });
  }

  // Lightbox close
  if (mediaLightboxClose) {
    mediaLightboxClose.addEventListener('click', closeLightbox);
  }
  if (mediaLightbox) {
    mediaLightbox.addEventListener('click', (e) => {
      if (e.target === mediaLightbox) closeLightbox();
    });
  }
}
