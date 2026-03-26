// scene-timeline.js — Timeline renderer module: chapter-grouped scene cards + scene explorer overlay

import { state, bus } from './state.js';
import {
  timelineScanBtn, timelineScanStatus, timelineList,
  sceneExplorerOverlay, sceneExplorerHeader, sceneExplorerBody,
  promptDisplay,
} from './dom-refs.js';
import { escapeHtml, showToast, friendlyApiError } from './utils.js';
import { switchPanelTab, loreCall } from './lore-creator.js';
import { readStoryTextFromDOM } from './webview-polling.js';

// =========================================================================
// CONSTANTS
// =========================================================================

const AVATAR_COLORS = ['#e94560', '#4a9eff', '#f59e0b', '#10b981', '#a855f7', '#ec4899', '#f97316', '#06b6d4'];

function getAvatarColor(index) {
  return AVATAR_COLORS[index % AVATAR_COLORS.length];
}

// =========================================================================
// RENDER TIMELINE
// =========================================================================

/**
 * Render the full chapter-grouped timeline into timelineList.
 * @param {object} timelineState
 */
export function renderTimeline(timelineState) {
  if (!timelineList) return;

  const scenes = timelineState?.scenes || [];
  const chapters = timelineState?.chapters || [];

  if (!scenes.length) {
    timelineList.innerHTML = '<p class="empty-state">No scenes detected yet. Click "Scan Story" to analyze.</p>';
    return;
  }

  // Group scenes by chapterId
  const scenesByChapter = new Map();
  for (const scene of scenes) {
    const chId = scene.chapterId || '__ungrouped__';
    if (!scenesByChapter.has(chId)) scenesByChapter.set(chId, []);
    scenesByChapter.get(chId).push(scene);
  }

  // Build chapter order — follow chapters array, then append any ungrouped
  const orderedChapterIds = [];
  for (const ch of chapters) {
    orderedChapterIds.push(ch.id);
  }
  if (scenesByChapter.has('__ungrouped__')) {
    orderedChapterIds.push('__ungrouped__');
  }

  const lastChapterId = orderedChapterIds[orderedChapterIds.length - 1];

  const fragments = [];

  for (const chapterId of orderedChapterIds) {
    const chapterScenes = scenesByChapter.get(chapterId);
    if (!chapterScenes || !chapterScenes.length) continue;

    const chapter = chapters.find(c => c.id === chapterId);
    const chapterTitle = chapter?.title || (chapterId === '__ungrouped__' ? 'Scenes' : `Chapter ${chapterId}`);
    const isLastChapter = chapterId === lastChapterId;
    const lastSceneId = scenes[scenes.length - 1]?.id;

    const details = document.createElement('details');
    details.className = 'timeline-chapter';
    if (isLastChapter) details.open = true;

    // Summary
    const summary = document.createElement('summary');
    let summaryHTML = `<span class="timeline-chapter-title">${escapeHtml(chapterTitle)}</span>`;
    summaryHTML += ` <span class="timeline-chapter-count">${chapterScenes.length} scene${chapterScenes.length !== 1 ? 's' : ''}</span>`;
    if (isLastChapter) {
      summaryHTML += ' <span class="scene-badge action" style="font-size:10px;padding:1px 6px;vertical-align:middle;">CURRENT</span>';
    }
    summary.innerHTML = summaryHTML;
    details.appendChild(summary);

    // Scene cards
    for (const scene of chapterScenes) {
      const card = buildSceneCard(scene, scene.id === lastSceneId);
      details.appendChild(card);
    }

    fragments.push(details);
  }

  timelineList.innerHTML = '';
  for (const el of fragments) {
    timelineList.appendChild(el);
  }
}

/**
 * Build a single scene card element.
 * @param {object} scene
 * @param {boolean} isCurrent
 * @returns {HTMLElement}
 */
function buildSceneCard(scene, isCurrent) {
  const card = document.createElement('div');
  const classes = ['timeline-scene-card'];
  if (isCurrent) classes.push('current');
  if (scene.status === 'tentative') classes.push('tentative');
  if (scene.imageId) classes.push('has-image');
  card.className = classes.join(' ');
  card.dataset.sceneId = scene.id;

  // Title
  const rawTitle = scene.description ? scene.description.split('.')[0] : null;
  const displayTitle = rawTitle || `Scene ${scene.index ?? scene.id}`;

  // Description snippet
  const snippetSource = scene.description || scene.excerpt || '';
  const snippet = snippetSource.length > 100 ? snippetSource.slice(0, 100) + '…' : snippetSource;

  // Badges
  let badgesHTML = '';
  if (scene.location) {
    badgesHTML += `<span class="scene-badge location">${escapeHtml(scene.location)}</span>`;
  }
  if (scene.mood) {
    badgesHTML += `<span class="scene-badge mood">${escapeHtml(scene.mood)}</span>`;
  }
  if (scene.timeOfDay) {
    badgesHTML += `<span class="scene-badge time-of-day" style="background:#a855f722;color:#a855f7;border:1px solid #a855f740;">${escapeHtml(scene.timeOfDay)}</span>`;
  }
  if (isCurrent) {
    badgesHTML += '<span class="scene-badge action" style="font-size:10px;padding:1px 6px;">NOW</span>';
  }
  if (scene.status === 'tentative') {
    badgesHTML += '<span class="scene-badge" style="background:#f59e0b22;color:#f59e0b;border:1px solid #f59e0b40;font-size:10px;padding:1px 6px;">TENTATIVE</span>';
  }

  // Character avatars
  let avatarsHTML = '';
  const chars = scene.characters || [];
  if (chars.length) {
    avatarsHTML = '<div class="scene-avatars" style="display:flex;gap:4px;flex-wrap:wrap;margin-top:6px;">';
    for (let i = 0; i < Math.min(chars.length, 6); i++) {
      const name = typeof chars[i] === 'string' ? chars[i] : chars[i].name || '?';
      const initial = name.charAt(0).toUpperCase();
      const color = getAvatarColor(i);
      avatarsHTML += `<span class="scene-avatar" title="${escapeHtml(name)}" style="display:inline-flex;align-items:center;justify-content:center;width:22px;height:22px;border-radius:50%;background:${color}22;color:${color};border:1px solid ${color}66;font-size:11px;font-weight:600;cursor:pointer;" data-char-name="${escapeHtml(name)}">${escapeHtml(initial)}</span>`;
    }
    if (chars.length > 6) {
      avatarsHTML += `<span style="color:#888;font-size:11px;line-height:22px;">+${chars.length - 6}</span>`;
    }
    avatarsHTML += '</div>';
  }

  const thumbHTML = scene._imageData
    ? `<img src="${scene._imageData}" style="width:56px;height:56px;object-fit:cover;border-radius:6px;border:1px solid #3a3a5e;flex-shrink:0;" alt="">`
    : '';

  card.innerHTML = `
    <div style="display:flex;align-items:flex-start;justify-content:space-between;gap:8px;">
      <div style="flex:1;min-width:0;">
        <div class="timeline-scene-title" style="font-size:13px;font-weight:600;color:#e0e0e0;margin-bottom:4px;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;">${escapeHtml(displayTitle)}</div>
        ${snippet ? `<div style="font-size:11px;color:#888;line-height:1.4;">${escapeHtml(snippet)}</div>` : ''}
        ${badgesHTML ? `<div style="margin-top:6px;display:flex;flex-wrap:wrap;gap:4px;">${badgesHTML}</div>` : ''}
        ${avatarsHTML}
      </div>
      ${thumbHTML}
    </div>
  `;

  card.addEventListener('click', () => openSceneExplorer(scene.id));

  return card;
}

// =========================================================================
// SCENE EXPLORER OVERLAY
// =========================================================================

/** Currently open scene ID (for nav arrows) */
let explorerSceneId = null;
let pendingImageForSceneId = null; // scene ID awaiting image generation

/**
 * Open the scene explorer overlay for a given scene ID.
 * @param {string} sceneId
 */
export function openSceneExplorer(sceneId) {
  if (!sceneExplorerOverlay || !sceneExplorerHeader || !sceneExplorerBody) return;

  const timelineState = state.timelineState;
  if (!timelineState?.scenes?.length) return;

  const scenes = timelineState.scenes;
  const sceneIndex = scenes.findIndex(s => s.id === sceneId);
  if (sceneIndex === -1) return;

  explorerSceneId = sceneId;
  const scene = scenes[sceneIndex];
  const chapter = (timelineState.chapters || []).find(c => c.id === scene.chapterId);

  const prevScene = sceneIndex > 0 ? scenes[sceneIndex - 1] : null;
  const nextScene = sceneIndex < scenes.length - 1 ? scenes[sceneIndex + 1] : null;
  const isCurrentScene = sceneIndex === scenes.length - 1;

  // Derive title
  const rawTitle = scene.description ? scene.description.split('.')[0] : null;
  const displayTitle = rawTitle || `Scene ${scene.index ?? sceneIndex + 1}`;

  // Build header HTML
  const chapterNum = chapter ? ((timelineState.chapters || []).indexOf(chapter) + 1) : '?';
  const boundaryBadge = scene.boundaryType
    ? `<span class="scene-badge action" style="font-size:10px;">${escapeHtml(scene.boundaryType)}</span>`
    : '';

  sceneExplorerHeader.innerHTML = `
    <div style="background:#22223a;padding:14px 16px;border-bottom:1px solid #2a2a4e;">
      <div style="display:flex;align-items:center;justify-content:space-between;flex-wrap:wrap;gap:8px;">
        <div style="display:flex;align-items:center;gap:8px;">
          <button class="scene-nav-btn" data-dir="prev" style="background:#2a2a4e;border:1px solid #3a3a5e;color:#ccc;border-radius:4px;padding:2px 8px;cursor:pointer;font-size:16px;" ${!prevScene ? 'disabled style="opacity:0.4;cursor:default;"' : ''}>←</button>
          <span style="color:#888;font-size:11px;">Scene ${sceneIndex + 1} of ${scenes.length}</span>
          <button class="scene-nav-btn" data-dir="next" style="background:#2a2a4e;border:1px solid #3a3a5e;color:#ccc;border-radius:4px;padding:2px 8px;cursor:pointer;font-size:16px;" ${!nextScene ? 'disabled style="opacity:0.4;cursor:default;"' : ''}>→</button>
        </div>
        <div style="display:flex;align-items:center;gap:6px;flex-wrap:wrap;">
          <span class="scene-badge location">Ch. ${escapeHtml(String(chapterNum))}</span>
          ${boundaryBadge}
          <button class="scene-close-btn" style="background:none;border:none;color:#888;font-size:16px;cursor:pointer;padding:2px 6px;line-height:1;">✕</button>
        </div>
      </div>
      <h3 style="margin:8px 0 0;font-size:16px;color:#e0e0e0;">${escapeHtml(displayTitle)}</h3>
    </div>
  `;

  // Build body HTML
  const chars = scene.characters || [];
  const keyEvents = scene.keyEvents || [];
  const prevSceneTitle = prevScene
    ? (prevScene.description ? prevScene.description.split('.')[0] : `Scene ${sceneIndex}`)
    : null;
  const nextSceneTitle = nextScene
    ? (nextScene.description ? nextScene.description.split('.')[0] : `Scene ${sceneIndex + 2}`)
    : null;

  let bodyHTML = '';

  // Image section
  bodyHTML += `
    <div style="margin-bottom:16px;">
      <div style="background:#22223a;border:1px dashed #3a3a5e;border-radius:8px;padding:20px;text-align:center;color:#888;">
        ${scene._imageData
          ? `<img src="${scene._imageData}" style="max-width:100%;border-radius:6px;" alt="Scene image">
             <button class="action-btn scene-gen-image-btn" data-scene-id="${escapeHtml(sceneId)}" style="background:#333;color:#aaa;border:none;padding:4px 10px;border-radius:4px;cursor:pointer;font-size:11px;margin-top:8px;">Regenerate</button>`
          : `<div style="font-size:12px;margin-bottom:10px;">No image generated yet</div>
             <button class="action-btn scene-gen-image-btn" data-scene-id="${escapeHtml(sceneId)}" style="background:#e94560;color:white;border:none;padding:5px 12px;border-radius:5px;cursor:pointer;font-size:12px;">Generate Scene Image</button>`
        }
      </div>
    </div>
  `;

  // Description section
  if (scene.description) {
    bodyHTML += `
      <div style="margin-bottom:16px;">
        <div style="display:flex;align-items:center;justify-content:space-between;margin-bottom:6px;">
          <span style="font-size:12px;font-weight:600;color:#aaa;text-transform:uppercase;letter-spacing:0.5px;">Description</span>
          <button class="scene-edit-desc-btn" data-scene-id="${escapeHtml(sceneId)}" style="background:none;border:1px solid #3a3a5e;color:#888;border-radius:4px;padding:2px 8px;cursor:pointer;font-size:11px;">Edit</button>
        </div>
        <p style="font-size:13px;color:#ccc;line-height:1.6;${isCurrentScene ? 'font-style:italic;' : ''}">${escapeHtml(scene.description)}</p>
      </div>
    `;
  }

  // Characters section
  if (chars.length) {
    bodyHTML += `
      <div style="margin-bottom:16px;">
        <div style="font-size:12px;font-weight:600;color:#aaa;text-transform:uppercase;letter-spacing:0.5px;margin-bottom:8px;">Characters</div>
        <div style="display:flex;flex-wrap:wrap;gap:8px;">
    `;
    for (let i = 0; i < chars.length; i++) {
      const char = typeof chars[i] === 'string' ? { name: chars[i] } : chars[i];
      const color = getAvatarColor(i);
      const presenceBadge = char.presence === 'entering'
        ? `<span style="font-size:10px;color:#10b981;">entering</span>`
        : char.presence === 'exiting'
        ? `<span style="font-size:10px;color:#f59e0b;">exiting</span>`
        : `<span style="font-size:10px;color:#888;">present</span>`;
      bodyHTML += `
        <div class="scene-char-card" data-char-name="${escapeHtml(char.name)}" style="background:#22223a;border:1px solid ${color}44;border-radius:8px;padding:8px 10px;cursor:pointer;min-width:80px;text-align:center;">
          <div style="width:30px;height:30px;border-radius:50%;background:${color}22;color:${color};border:1px solid ${color}66;display:flex;align-items:center;justify-content:center;font-size:14px;font-weight:600;margin:0 auto 4px;">${escapeHtml(char.name.charAt(0).toUpperCase())}</div>
          <div style="font-size:12px;color:#e0e0e0;font-weight:500;">${escapeHtml(char.name)}</div>
          ${char.narrativeRole ? `<div style="font-size:10px;color:#888;margin-top:2px;">${escapeHtml(char.narrativeRole)}</div>` : ''}
          <div style="margin-top:4px;">${presenceBadge}</div>
        </div>
      `;
    }
    bodyHTML += `</div></div>`;
  }

  // Location section
  if (scene.location) {
    const locationIndicator = scene.locationChanged === false
      ? '<span style="font-size:10px;color:#888;margin-left:6px;">Same as previous</span>'
      : '<span style="font-size:10px;color:#10b981;margin-left:6px;">New location</span>';
    bodyHTML += `
      <div style="margin-bottom:16px;">
        <div style="font-size:12px;font-weight:600;color:#aaa;text-transform:uppercase;letter-spacing:0.5px;margin-bottom:4px;">Location ${locationIndicator}</div>
        <span class="scene-badge location" style="font-size:12px;">${escapeHtml(scene.location)}</span>
      </div>
    `;
  }

  // Key Events section
  if (keyEvents.length) {
    bodyHTML += `
      <div style="margin-bottom:16px;">
        <div style="font-size:12px;font-weight:600;color:#aaa;text-transform:uppercase;letter-spacing:0.5px;margin-bottom:6px;">Key Events</div>
        <ul style="margin:0;padding:0 0 0 16px;list-style:disc;">
          ${keyEvents.map(e => `<li style="font-size:13px;color:#ccc;margin-bottom:3px;">${escapeHtml(typeof e === 'string' ? e : e.description || String(e))}</li>`).join('')}
        </ul>
      </div>
    `;
  }

  // Atmosphere section
  const hasMood = scene.mood || scene.timeOfDay || scene.weather || scene.tone;
  if (hasMood) {
    bodyHTML += `
      <div style="margin-bottom:16px;">
        <div style="font-size:12px;font-weight:600;color:#aaa;text-transform:uppercase;letter-spacing:0.5px;margin-bottom:6px;">Atmosphere</div>
        <div style="display:flex;flex-wrap:wrap;gap:6px;">
          ${scene.mood ? `<span class="scene-badge mood">${escapeHtml(scene.mood)}</span>` : ''}
          ${scene.timeOfDay ? `<span class="scene-badge" style="background:#a855f722;color:#a855f7;border:1px solid #a855f740;">${escapeHtml(scene.timeOfDay)}</span>` : ''}
          ${scene.weather ? `<span class="scene-badge" style="background:#06b6d422;color:#06b6d4;border:1px solid #06b6d440;">${escapeHtml(scene.weather)}</span>` : ''}
          ${scene.tone ? `<span class="scene-badge" style="background:#88888822;color:#aaa;border:1px solid #88888840;">${escapeHtml(scene.tone)}</span>` : ''}
        </div>
      </div>
    `;
  }

  // Story Context section
  if (prevSceneTitle || nextSceneTitle) {
    bodyHTML += `
      <div style="margin-bottom:16px;">
        <div style="font-size:12px;font-weight:600;color:#aaa;text-transform:uppercase;letter-spacing:0.5px;margin-bottom:6px;">Story Context</div>
        <div style="display:flex;flex-direction:column;gap:6px;">
          ${prevScene ? `<div style="font-size:12px;color:#888;"><span style="color:#4a9eff;cursor:pointer;" class="scene-context-link" data-scene-id="${escapeHtml(prevScene.id)}">← ${escapeHtml(prevSceneTitle)}</span></div>` : ''}
          ${nextScene ? `<div style="font-size:12px;color:#888;"><span style="color:#4a9eff;cursor:pointer;" class="scene-context-link" data-scene-id="${escapeHtml(nextScene.id)}">→ ${escapeHtml(nextSceneTitle)}</span></div>` : ''}
        </div>
      </div>
    `;
  }

  // Actions section
  bodyHTML += `
    <div style="display:flex;flex-wrap:wrap;gap:8px;padding-top:8px;border-top:1px solid #2a2a4e;">
      <button class="action-btn scene-narrate-btn" data-scene-id="${escapeHtml(sceneId)}" style="background:#2a2a4e;border:1px solid #3a3a5e;color:#e0e0e0;border-radius:6px;padding:6px 14px;cursor:pointer;font-size:12px;">Narrate Scene</button>
      <button class="action-btn scene-jump-btn" data-scene-id="${escapeHtml(sceneId)}" style="background:#2a2a4e;border:1px solid #3a3a5e;color:#e0e0e0;border-radius:6px;padding:6px 14px;cursor:pointer;font-size:12px;">Jump to Text</button>
      <button class="action-btn scene-note-btn" data-scene-id="${escapeHtml(sceneId)}" style="background:#2a2a4e;border:1px solid #3a3a5e;color:#e0e0e0;border-radius:6px;padding:6px 14px;cursor:pointer;font-size:12px;">Add Note</button>
    </div>
  `;

  sceneExplorerBody.innerHTML = bodyHTML;

  // Wire header events
  const closeBtn = sceneExplorerHeader.querySelector('.scene-close-btn');
  if (closeBtn) {
    closeBtn.addEventListener('click', closeSceneExplorer);
  }

  const prevBtn = sceneExplorerHeader.querySelector('[data-dir="prev"]');
  if (prevBtn && prevScene) {
    prevBtn.addEventListener('click', () => openSceneExplorer(prevScene.id));
  }

  const nextBtn = sceneExplorerHeader.querySelector('[data-dir="next"]');
  if (nextBtn && nextScene) {
    nextBtn.addEventListener('click', () => openSceneExplorer(nextScene.id));
  }

  // Wire body events
  for (const link of sceneExplorerBody.querySelectorAll('.scene-context-link')) {
    link.addEventListener('click', () => openSceneExplorer(link.dataset.sceneId));
  }

  for (const charCard of sceneExplorerBody.querySelectorAll('.scene-char-card')) {
    charCard.addEventListener('click', () => {
      const charName = charCard.dataset.charName || '';
      closeSceneExplorer();
      switchPanelTab('rpg');

      // Find matching character in LitRPG state and open stat sheet
      const chars = state.litrpgState?.characters || {};
      const charNameLower = charName.toLowerCase();
      const matchEntry = Object.entries(chars).find(([, c]) => {
        if (!c.name) return false;
        return c.name.toLowerCase() === charNameLower ||
               (c.aliases || []).some(a => a.toLowerCase() === charNameLower);
      });
      if (matchEntry) {
        const [charId] = matchEntry;
        import('./litrpg-panel.js').then(mod => {
          if (mod.openStatOverlay) mod.openStatOverlay(charId, state.litrpgState);
        });
      }
    });
  }

  // Action: Generate Scene Image
  const genImageBtn = sceneExplorerBody.querySelector('.scene-gen-image-btn');
  if (genImageBtn) {
    genImageBtn.addEventListener('click', () => {
      const sceneText = scene.description || scene.excerpt || '';
      if (!sceneText) {
        showToast('No scene description to use as prompt', 3000, 'warn');
        return;
      }
      state.prompt.display = sceneText;
      state.prompt.raw = sceneText;
      state.prompt.edited = false;
      state.prompt.source = 'timeline';
      pendingImageForSceneId = genImageBtn.dataset.sceneId;
      if (promptDisplay) promptDisplay.value = sceneText;
      closeSceneExplorer();
      switchPanelTab('scene');
      showToast('Scene set as prompt — click Generate to create image', 3000);
    });
  }

  // Action: Narrate Scene
  const narrateBtn = sceneExplorerBody.querySelector('.scene-narrate-btn');
  if (narrateBtn) {
    narrateBtn.addEventListener('click', async () => {
      const sceneText = scene.excerpt || scene.description || '';
      if (!sceneText || sceneText.length < 20) {
        showToast('Not enough scene text to narrate', 3000, 'warn');
        return;
      }
      narrateBtn.disabled = true;
      narrateBtn.textContent = 'Generating…';
      try {
        const segments = await window.powertool.ttsNarrateScene(
          sceneText,
          state.currentStoryId,
          null
        );
        if (!segments || segments.length === 0) {
          showToast('No audio generated for this scene', 3000, 'warn');
          return;
        }
        // Play segments sequentially
        const audioEl = document.createElement('audio');
        for (const seg of segments) {
          audioEl.src = seg.audioData;
          await new Promise((resolve, reject) => {
            audioEl.onended = resolve;
            audioEl.onerror = reject;
            audioEl.play();
          });
        }
        showToast('Narration complete', 2000);
      } catch (e) {
        console.error('[Timeline] Narrate error:', e);
        showToast('TTS error: ' + friendlyApiError(e), 4000, 'error');
      } finally {
        narrateBtn.disabled = false;
        narrateBtn.textContent = 'Narrate Scene';
      }
    });
  }

  // Action: Jump to Text
  const jumpBtn = sceneExplorerBody.querySelector('.scene-jump-btn');
  if (jumpBtn) {
    jumpBtn.addEventListener('click', () => {
      const webview = document.querySelector('webview');
      if (!webview) {
        showToast('NovelAI editor not available', 3000, 'warn');
        return;
      }
      const textStart = scene.textStart ?? 0;
      webview.executeJavaScript(`
        try {
          const editor = document.querySelector('.ProseMirror');
          if (editor) {
            const totalLength = editor.textContent?.length || 1;
            const ratio = ${textStart} / totalLength;
            editor.scrollTop = ratio * editor.scrollHeight;
          }
        } catch(e) {}
      `);
      closeSceneExplorer();
      showToast('Jumped to scene in editor', 2000);
    });
  }

  // Action: Add Note
  const noteBtn = sceneExplorerBody.querySelector('.scene-note-btn');
  if (noteBtn) {
    noteBtn.addEventListener('click', async () => {
      const existingNote = scene.note || '';
      const newNote = window.prompt('Add a note for this scene:', existingNote);
      if (newNote === null) return; // User cancelled

      scene.note = newNote.trim();
      
      // Persist update
      try {
        await window.powertool.timelineSetState(state.currentStoryId, state.timelineState);
        showToast('Scene note updated');
        
        // Re-render timeline to show the note if needed
        renderTimeline(state.timelineState);
        
        // Update the explorer view to show the new note
        const noteArea = sceneExplorerBody.querySelector('.scene-note-text');
        if (noteArea) {
          noteArea.textContent = scene.note;
          const noteSection = noteArea.closest('.explorer-section');
          if (noteSection) noteSection.style.display = scene.note ? 'block' : 'none';
        }
      } catch (err) {
        console.error('[Timeline] Failed to save scene note:', err);
        showToast('Failed to save note');
      }
    });
  }

  // Action: Edit Description
  const editDescBtn = sceneExplorerBody.querySelector('.scene-edit-desc-btn');
  if (editDescBtn) {
    editDescBtn.addEventListener('click', () => {
      const descPara = editDescBtn.closest('div').nextElementSibling;
      if (!descPara) return;
      const currentText = scene.description || '';
      const textarea = document.createElement('textarea');
      textarea.value = currentText;
      textarea.style.cssText = 'width:100%;min-height:80px;background:#1a1a2e;color:#e0e0e0;border:1px solid #4a9eff;border-radius:4px;padding:6px;font-size:13px;line-height:1.5;resize:vertical;box-sizing:border-box;';
      descPara.replaceWith(textarea);
      editDescBtn.textContent = 'Save';
      textarea.focus();

      const saveDesc = async () => {
        const newText = textarea.value.trim();
        editDescBtn.textContent = 'Saving…';
        editDescBtn.disabled = true;
        try {
          if (window.powertool.timelineUpdateScene && state.currentStoryId) {
            await window.powertool.timelineUpdateScene(state.currentStoryId, sceneId, { description: newText });
          }
          // Update in-memory state
          scene.description = newText;
          if (state.timelineState?.scenes) {
            const idx = state.timelineState.scenes.findIndex(s => s.id === sceneId);
            if (idx !== -1) state.timelineState.scenes[idx].description = newText;
          }
          renderTimeline(state.timelineState);
          openSceneExplorer(sceneId);
          showToast('Description saved', 2000);
        } catch (e) {
          console.error('[Timeline] Save description error:', e);
          showToast('Failed to save description', 3000, 'error');
          editDescBtn.disabled = false;
          editDescBtn.textContent = 'Save';
        }
      };

      editDescBtn.addEventListener('click', saveDesc, { once: true });
      textarea.addEventListener('keydown', e => {
        if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) {
          e.preventDefault();
          saveDesc();
        }
      });
    });
  }

  // Show overlay
  sceneExplorerOverlay.classList.add('is-open');
}

function closeSceneExplorer() {
  if (sceneExplorerOverlay) {
    sceneExplorerOverlay.classList.remove('is-open');
  }
  explorerSceneId = null;
}

// =========================================================================
// SCAN
// =========================================================================

async function startTimelineScan() {
  if (!state.currentStoryId) return;
  if (state.llmBusy) return;

  const storyId = state.currentStoryId;

  if (timelineScanStatus) timelineScanStatus.textContent = 'Scanning story for scenes…';
  if (timelineScanBtn) timelineScanBtn.disabled = true;

  state.llmBusy = true;
  try {
    const storyText = await readStoryTextFromDOM() || '';
    const entries = await loreCall('getEntriesExpanded') || [];
    const result = await window.powertool.timelineScan(storyId, storyText, entries);

    // Stale check — story may have switched during async scan
    if (state.currentStoryId !== storyId) return;

    if (result.success) {
      state.timelineState = result.state;
      const report = result.report || {};
      const sceneCount = report.sceneCount ?? result.state?.scenes?.length ?? 0;
      const chapterCount = report.chapterCount ?? result.state?.chapters?.length ?? 0;
      if (timelineScanStatus) {
        timelineScanStatus.textContent = `${sceneCount} scene${sceneCount !== 1 ? 's' : ''} in ${chapterCount} chapter${chapterCount !== 1 ? 's' : ''}`;
      }
      bus.emit('timeline:scanned', report);
      renderTimeline(state.timelineState);
    } else {
      if (timelineScanStatus) timelineScanStatus.textContent = `Error: ${result.error || 'Scan failed'}`;
    }
  } catch (err) {
    if (state.currentStoryId === storyId && timelineScanStatus) {
      timelineScanStatus.textContent = 'Scan failed';
    }
    console.error('[Timeline] Scan error:', err);
  } finally {
    state.llmBusy = false;
    if (timelineScanBtn) timelineScanBtn.disabled = false;
  }
}

// =========================================================================
// REFRESH UI
// =========================================================================

export function refreshTimelineUI() {
  if (!timelineList) return;
  if (!state.timelineState?.scenes?.length) {
    timelineList.innerHTML = '<p class="empty-state">No scenes detected yet. Click "Scan Story" to analyze.</p>';
    return;
  }
  renderTimeline(state.timelineState);
}

// =========================================================================
// INIT
// =========================================================================

let isInitialized = false;

export function init() {
  if (isInitialized) return;
  isInitialized = true;

  timelineScanBtn?.addEventListener('click', startTimelineScan);

  // Close overlay on Escape
  document.addEventListener('keydown', e => {
    if (e.key === 'Escape' && sceneExplorerOverlay?.classList.contains('is-open')) {
      closeSceneExplorer();
    }
  });

  // Close overlay on backdrop click
  sceneExplorerOverlay?.addEventListener('click', e => {
    if (e.target === sceneExplorerOverlay) closeSceneExplorer();
  });

  bus.on('story:changed', async () => {
    if (state.currentStoryId) {
      try {
        state.timelineState = await window.powertool.timelineGetState(state.currentStoryId);
      } catch (_) {
        state.timelineState = null;
      }
      refreshTimelineUI();
      if (timelineScanStatus) timelineScanStatus.textContent = '';
    } else {
      refreshTimelineUI();
    }
  });

  // Refresh timeline when settings are saved (provider or story settings may affect scan behavior)
  bus.on('settings:saved', () => {
    refreshTimelineUI();
  });

  // Link generated images to timeline scenes
  bus.on('image:generated', ({ imageData }) => {
    if (!pendingImageForSceneId || !state.timelineState?.scenes) return;
    const scene = state.timelineState.scenes.find(s => s.id === pendingImageForSceneId);
    if (!scene) {
      pendingImageForSceneId = null;
      return;
    }

    // Store image data on the scene (transient — not persisted to DB)
    scene._imageData = imageData;
    scene.imageId = 'generated-' + Date.now();
    const sceneId = pendingImageForSceneId;
    pendingImageForSceneId = null;

    // Persist the imageId to timeline state (strip transient _imageData before save)
    if (state.currentStoryId) {
      const savedImageData = scene._imageData;
      delete scene._imageData;
      window.powertool.timelineSetState?.(state.currentStoryId, state.timelineState)
        .catch(() => {})
        .finally(() => { scene._imageData = savedImageData; });
    }

    // Refresh UI
    refreshTimelineUI();
    console.log(`[Timeline] Linked generated image to scene "${scene.description?.slice(0, 40) || sceneId}"`);
  });
}
