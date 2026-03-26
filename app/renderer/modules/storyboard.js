// storyboard.js — Storyboard modal, scene cards, commit, CRUD operations

import { state } from './state.js';
import {
  imagePanel, promptDisplay,
  storyboardBtn, storyboardModal, storyboardSelect, sceneList,
  storyboardCloseBtn, sbNewBtn, sbDeleteBtn, sbRenameBtn,
  commitBtn, commitConfirm, commitSbName, commitNoteInput,
  commitConfirmBtn, commitCancelBtn, commitStoryLabel, sbLinkBtn,
} from './dom-refs.js';
import { showToast } from './utils.js';

// Init storyboard state on load
async function initStoryboard() {
  try {
    const data = await window.powertool.storyboardList();

    // If we know the current story, find its associated board
    if (state.currentStoryId) {
      const storyBoard = data.storyboards.find(sb => sb.storyId === state.currentStoryId);
      if (storyBoard) {
        state.activeStoryboardId = storyBoard.id;
        state.activeStoryboardName = storyBoard.name;
        commitSbName.textContent = state.activeStoryboardName;
        return;
      }
    }

    // Fallback: use persisted active board
    state.activeStoryboardId = data.activeStoryboardId;
    const active = data.storyboards.find(sb => sb.id === state.activeStoryboardId);
    state.activeStoryboardName = active ? active.name : '';
    commitSbName.textContent = state.activeStoryboardName || 'Default';
  } catch (e) {
    console.log('[Renderer] Storyboard init:', e);
  }
}

async function openStoryboardViewer() {
  storyboardModal.classList.add('active');
  await refreshStoryboardSelect();
  await renderSceneList();
}

export async function refreshStoryboardSelect() {
  const data = await window.powertool.storyboardList();
  storyboardSelect.innerHTML = '';

  if (data.storyboards.length === 0) {
    const opt = document.createElement('option');
    opt.value = '';
    opt.textContent = 'No storyboards yet';
    storyboardSelect.appendChild(opt);
    state.activeStoryboardId = null;
    state.activeStoryboardName = '';
    sbLinkBtn.classList.add('u-hidden');
    return;
  }

  // Group storyboards: Current Story, Other Stories, Unlinked
  const currentStoryGroup = [];
  const otherStoryGroup = [];
  const unlinkedGroup = [];

  for (const sb of data.storyboards) {
    if (sb.storyId && sb.storyId === state.currentStoryId) {
      currentStoryGroup.push(sb);
    } else if (sb.storyId) {
      otherStoryGroup.push(sb);
    } else {
      unlinkedGroup.push(sb);
    }
  }

  function addOptions(group, parent, showStoryTitle) {
    for (const sb of group) {
      const opt = document.createElement('option');
      opt.value = sb.id;
      const suffix = ` (${sb.sceneCount} scenes)`;
      opt.textContent = (showStoryTitle && sb.storyTitle) ? `${sb.name} — ${sb.storyTitle}${suffix}` : `${sb.name}${suffix}`;
      if (sb.id === state.activeStoryboardId) opt.selected = true;
      parent.appendChild(opt);
    }
  }

  const nonEmptyGroups = [currentStoryGroup, otherStoryGroup, unlinkedGroup].filter(g => g.length > 0).length;
  const hasGroups = nonEmptyGroups > 1;

  if (hasGroups) {
    if (currentStoryGroup.length > 0) {
      const grp = document.createElement('optgroup');
      grp.label = 'Current Story';
      addOptions(currentStoryGroup, grp, false);
      storyboardSelect.appendChild(grp);
    }
    if (unlinkedGroup.length > 0) {
      const grp = document.createElement('optgroup');
      grp.label = 'Unlinked';
      addOptions(unlinkedGroup, grp, false);
      storyboardSelect.appendChild(grp);
    }
    if (otherStoryGroup.length > 0) {
      const grp = document.createElement('optgroup');
      grp.label = 'Other Stories';
      addOptions(otherStoryGroup, grp, true);
      storyboardSelect.appendChild(grp);
    }
  } else {
    // No grouping needed -- flat list
    addOptions(data.storyboards, storyboardSelect, false);
  }

  // Only fall back to disk value if in-memory ID is missing or invalid
  const inMemoryValid = state.activeStoryboardId && data.storyboards.find(sb => sb.id === state.activeStoryboardId);
  if (!inMemoryValid) {
    state.activeStoryboardId = data.activeStoryboardId;
  }
  const active = data.storyboards.find(sb => sb.id === state.activeStoryboardId);
  state.activeStoryboardName = active ? active.name : '';
  commitSbName.textContent = state.activeStoryboardName || 'Default';

  // Show/hide link button based on whether active storyboard is linked and story is detected
  if (active && state.currentStoryId) {
    if (active.storyId) {
      sbLinkBtn.textContent = 'Unlink';
      sbLinkBtn.classList.remove('u-hidden');
    } else {
      sbLinkBtn.textContent = 'Link Story';
      sbLinkBtn.classList.remove('u-hidden');
    }
  } else {
    sbLinkBtn.classList.add('u-hidden');
  }
}

async function renderSceneList() {
  if (!state.activeStoryboardId) {
    sceneList.innerHTML = '<div class="scene-empty">No storyboards yet. Generate an image and commit it to start your storyboard.</div>';
    return;
  }

  const scenes = await window.powertool.storyboardGetScenes(state.activeStoryboardId);
  if (!scenes || scenes.length === 0) {
    sceneList.innerHTML = '<div class="scene-empty">No scenes yet. Generate an image and click "Commit to Storyboard".</div>';
    return;
  }

  sceneList.innerHTML = '';

  for (let i = 0; i < scenes.length; i++) {
    const scene = scenes[i];
    const card = document.createElement('div');
    card.className = 'scene-card';

    // Thumbnail (lazy loaded)
    const thumbDiv = document.createElement('div');
    thumbDiv.className = 'scene-thumb';
    thumbDiv.innerHTML = '<span class="thumb-placeholder">Loading...</span>';
    card.appendChild(thumbDiv);

    // Lazy load image (capture storyboardId to avoid race condition)
    (async (td, sid, sbId) => {
      const imgData = await window.powertool.storyboardGetSceneImage(sbId, sid);
      if (imgData) {
        td.innerHTML = `<img src="${imgData}" alt="Scene">`;
      } else {
        td.innerHTML = '<span class="thumb-placeholder">Missing</span>';
      }
    })(thumbDiv, scene.id, state.activeStoryboardId);

    // Metadata
    const meta = document.createElement('div');
    meta.className = 'scene-meta';

    const num = document.createElement('div');
    num.className = 'scene-number';
    num.textContent = `Scene ${i + 1}`;
    meta.appendChild(num);

    const ts = document.createElement('div');
    ts.className = 'scene-timestamp';
    ts.textContent = new Date(scene.committedAt).toLocaleString();
    meta.appendChild(ts);

    if (scene.prompt) {
      const pr = document.createElement('div');
      pr.className = 'scene-prompt';
      pr.textContent = scene.prompt.length > 120 ? scene.prompt.slice(0, 120) + '...' : scene.prompt;
      meta.appendChild(pr);
    }

    if (scene.storyExcerpt) {
      const ex = document.createElement('div');
      ex.className = 'scene-excerpt';
      ex.textContent = scene.storyExcerpt.length > 100 ? '...' + scene.storyExcerpt.slice(-100) : scene.storyExcerpt;
      meta.appendChild(ex);
    }

    if (scene.characters && scene.characters.length > 0) {
      const ch = document.createElement('div');
      ch.className = 'scene-chars';
      ch.textContent = 'Characters: ' + scene.characters.join(', ');
      meta.appendChild(ch);
    }

    if (scene.note) {
      const nt = document.createElement('div');
      nt.className = 'scene-note';
      nt.textContent = scene.note;
      meta.appendChild(nt);
    }

    const info = document.createElement('div');
    info.className = 'scene-info';
    const parts = [];
    if (scene.provider) parts.push(scene.provider);
    if (scene.model) parts.push(scene.model);
    if (scene.resolution && scene.resolution.width) parts.push(`${scene.resolution.width}x${scene.resolution.height}`);
    if (parts.length > 0) info.textContent = parts.join(' | ');
    meta.appendChild(info);

    // Actions
    const actions = document.createElement('div');
    actions.className = 'scene-actions';

    const editNoteBtn = document.createElement('button');
    editNoteBtn.textContent = 'Edit Note';
    editNoteBtn.addEventListener('click', async () => {
      const note = prompt('Scene note:', scene.note || '');
      if (note === null) return;
      await window.powertool.storyboardUpdateSceneNote(state.activeStoryboardId, scene.id, note);
      await renderSceneList();
    });
    actions.appendChild(editNoteBtn);

    const regenBtn = document.createElement('button');
    regenBtn.textContent = 'Load Prompt';
    regenBtn.addEventListener('click', () => {
      state.currentPrompt = scene.prompt;
      state.currentNegativePrompt = scene.negativePrompt || '';
      promptDisplay.textContent = state.currentPrompt;
      imagePanel.classList.remove('hidden');
      storyboardModal.classList.remove('active');
      showToast('Prompt loaded — click Generate');
    });
    actions.appendChild(regenBtn);

    if (i > 0) {
      const upBtn = document.createElement('button');
      upBtn.textContent = 'Move Up';
      upBtn.addEventListener('click', async () => {
        const ids = scenes.map(s => s.id);
        [ids[i - 1], ids[i]] = [ids[i], ids[i - 1]];
        await window.powertool.storyboardReorderScenes(state.activeStoryboardId, ids);
        await renderSceneList();
      });
      actions.appendChild(upBtn);
    }

    if (i < scenes.length - 1) {
      const downBtn = document.createElement('button');
      downBtn.textContent = 'Move Down';
      downBtn.addEventListener('click', async () => {
        const ids = scenes.map(s => s.id);
        [ids[i], ids[i + 1]] = [ids[i + 1], ids[i]];
        await window.powertool.storyboardReorderScenes(state.activeStoryboardId, ids);
        await renderSceneList();
      });
      actions.appendChild(downBtn);
    }

    const delBtn = document.createElement('button');
    delBtn.className = 'danger';
    delBtn.textContent = 'Delete';
    delBtn.addEventListener('click', async () => {
      if (!confirm('Delete this scene?')) return;
      await window.powertool.storyboardDeleteScene(state.activeStoryboardId, scene.id);
      await renderSceneList();
      await refreshStoryboardSelect();
    });
    actions.appendChild(delBtn);

    meta.appendChild(actions);
    card.appendChild(meta);
    sceneList.appendChild(card);
  }
}

export function init() {
  initStoryboard();

  // Commit button flow
  commitBtn.addEventListener('click', () => {
    commitSbName.textContent = state.activeStoryboardName || 'Default';
    if (state.currentStoryTitle) {
      commitStoryLabel.textContent = 'Story: ' + state.currentStoryTitle;
      commitStoryLabel.classList.remove('u-hidden');
    } else {
      commitStoryLabel.classList.add('u-hidden');
    }
    commitNoteInput.value = '';
    commitConfirm.classList.add('active');
  });

  commitCancelBtn.addEventListener('click', () => {
    commitConfirm.classList.remove('active');
  });

  commitConfirmBtn.addEventListener('click', async () => {
    if (!state.currentImageData) return;

    commitConfirmBtn.disabled = true;
    commitConfirmBtn.textContent = 'Saving...';

    try {
      const sceneData = {
        imageData: state.currentImageData,
        prompt: state.currentPrompt,
        negativePrompt: state.currentNegativePrompt,
        storyExcerpt: state.currentStoryExcerpt,
        characters: [],
        provider: state.currentGenerationMeta?.provider || '',
        model: state.currentGenerationMeta?.model || '',
        resolution: state.currentGenerationMeta?.resolution || {},
        note: commitNoteInput.value.trim(),
      };

      const result = await window.powertool.storyboardCommitScene(state.activeStoryboardId, sceneData);

      if (result.success) {
        // Update active storyboard ID if it was auto-created
        if (result.storyboardId && result.storyboardId !== state.activeStoryboardId) {
          state.activeStoryboardId = result.storyboardId;
        }
        // Refresh viewer if it's open (don't call initStoryboard -- it would clobber activeStoryboardId)
        if (storyboardModal.classList.contains('active')) {
          await refreshStoryboardSelect();
          await renderSceneList();
        }
        showToast('Scene committed to storyboard');
        commitConfirm.classList.remove('active');
      } else {
        showToast('Failed: ' + (result.error || 'unknown error'));
      }
    } catch (e) {
      showToast('Error: ' + e.message);
    } finally {
      commitConfirmBtn.disabled = false;
      commitConfirmBtn.textContent = 'Confirm';
    }
  });

  // Storyboard viewer
  storyboardBtn.addEventListener('click', () => openStoryboardViewer());
  storyboardCloseBtn.addEventListener('click', () => storyboardModal.classList.remove('active'));

  storyboardSelect.addEventListener('change', async () => {
    const id = storyboardSelect.value;
    if (id) {
      await window.powertool.storyboardSetActive(id);
      state.activeStoryboardId = id;
      // Look up name from data, not display text
      const data = await window.powertool.storyboardList();
      const found = data.storyboards.find(sb => sb.id === id);
      state.activeStoryboardName = found ? found.name : '';
      commitSbName.textContent = state.activeStoryboardName;
      await renderSceneList();
      await refreshStoryboardSelect(); // Refresh link button state
    }
  });

  sbNewBtn.addEventListener('click', async () => {
    const defaultName = state.currentStoryTitle || '';
    const name = prompt('Storyboard name:', defaultName);
    if (!name || !name.trim()) return;
    const result = await window.powertool.storyboardCreate(name.trim());
    // Pre-link to current story if detected
    if (state.currentStoryId) {
      await window.powertool.storyboardAssociateWithStory(result.id, state.currentStoryId, state.currentStoryTitle || '');
    }
    await window.powertool.storyboardSetActive(result.id);
    state.activeStoryboardId = result.id;
    state.activeStoryboardName = result.name;
    commitSbName.textContent = state.activeStoryboardName;
    await refreshStoryboardSelect();
    await renderSceneList();
  });

  sbDeleteBtn.addEventListener('click', async () => {
    if (!state.activeStoryboardId) return;
    if (!confirm(`Delete storyboard "${state.activeStoryboardName}" and all its scenes?`)) return;
    const result = await window.powertool.storyboardDelete(state.activeStoryboardId);
    state.activeStoryboardId = result.activeStoryboardId;
    await refreshStoryboardSelect();
    await renderSceneList();
  });

  sbRenameBtn.addEventListener('click', async () => {
    if (!state.activeStoryboardId) return;
    const name = prompt('New name:', state.activeStoryboardName);
    if (!name || !name.trim()) return;
    await window.powertool.storyboardRename(state.activeStoryboardId, name.trim());
    state.activeStoryboardName = name.trim();
    commitSbName.textContent = state.activeStoryboardName;
    await refreshStoryboardSelect();
  });

  sbLinkBtn.addEventListener('click', async () => {
    if (!state.activeStoryboardId || !state.currentStoryId) return;
    const data = await window.powertool.storyboardList();
    const active = data.storyboards.find(sb => sb.id === state.activeStoryboardId);

    if (active && active.storyId) {
      // Unlink
      await window.powertool.storyboardDissociateFromStory(state.activeStoryboardId);
      showToast('Storyboard unlinked from story');
    } else {
      // Link
      await window.powertool.storyboardAssociateWithStory(state.activeStoryboardId, state.currentStoryId, state.currentStoryTitle || '');
      showToast('Storyboard linked to: ' + (state.currentStoryTitle || state.currentStoryId.slice(0, 12)));
    }
    await refreshStoryboardSelect();
  });
}
