/**
 * Portrait Queue — sequential portrait generation with progress UI.
 * Listens for new character events and auto-enqueues when enabled.
 */
import { bus } from './state.js';

let state = null;
let queue = [];
let isProcessing = false;
let currentIndex = 0;
let autoGenEnabled = true;
let cancelRequested = false;

function showProgressToast(message, showCancel = false) {
  const existing = document.getElementById('portrait-queue-toast');
  if (existing) existing.remove();

  const toast = document.createElement('div');
  toast.id = 'portrait-queue-toast';
  toast.className = 'toast toast-info';
  toast.style.cssText = 'position:fixed;bottom:20px;right:20px;z-index:10000;padding:12px 16px;background:#2a2a4a;color:#e0e0e0;border-radius:8px;display:flex;align-items:center;gap:8px;box-shadow:0 4px 12px rgba(0,0,0,0.3);';
  toast.textContent = message;

  if (showCancel) {
    const cancelBtn = document.createElement('button');
    cancelBtn.textContent = 'Cancel';
    cancelBtn.style.cssText = 'background:#e94560;color:white;border:none;border-radius:4px;padding:4px 8px;cursor:pointer;margin-left:8px;';
    cancelBtn.onclick = () => cancel();
    toast.appendChild(cancelBtn);
  }

  document.body.appendChild(toast);
  return toast;
}

function dismissToast() {
  const existing = document.getElementById('portrait-queue-toast');
  if (existing) existing.remove();
}

async function processQueue() {
  if (isProcessing || queue.length === 0) return;
  isProcessing = true;
  cancelRequested = false;
  const total = queue.length;

  for (currentIndex = 0; currentIndex < queue.length; currentIndex++) {
    if (cancelRequested) break;

    const { charId, charName, rpgData } = queue[currentIndex];
    showProgressToast(`Generating portrait ${currentIndex + 1}/${total}: ${charName}...`, true);

    try {
      const result = await window.powertool.portraitGenerate(
        state.currentStoryId, charId, charName, rpgData
      );
      if (result?.success) {
        const rpg = state.litrpgState;
        if (rpg?.characters?.[charId]) {
          rpg.characters[charId].portraitPath = true;
          rpg.characters[charId]._portraitData = result.imageData;
          rpg.characters[charId]._thumbnailData = result.thumbnailData;
        }
        bus.emit('portrait:generated', { charId });
      } else {
        console.warn(`[PortraitQueue] Failed for ${charName}:`, result?.error);
      }
    } catch (err) {
      console.warn(`[PortraitQueue] Error generating portrait for ${charName}:`, err.message);
    }
  }

  queue = [];
  isProcessing = false;

  if (cancelRequested) {
    showProgressToast('Portrait generation cancelled.');
  } else {
    showProgressToast(`Generated ${total} portrait${total !== 1 ? 's' : ''}.`);
  }
  setTimeout(dismissToast, 3000);

  bus.emit('portrait:queue-complete');
}

export function enqueue(characters, opts = {}) {
  const { regenerate = false } = opts;
  const queuedIds = new Set(queue.map(q => q.charId));
  const rpg = state?.litrpgState;

  for (const char of characters) {
    if (queuedIds.has(char.charId)) continue;
    if (!regenerate && rpg?.characters?.[char.charId]?.portraitPath) continue;
    queue.push(char);
    queuedIds.add(char.charId);
  }

  if (!isProcessing && queue.length > 0) {
    processQueue();
  }
}

export function cancel() {
  cancelRequested = true;
  queue = [];
}

export async function init(appState) {
  state = appState;

  try {
    const settings = await window.powertool.getSettings?.();
    autoGenEnabled = settings?.autoGeneratePortraits !== false;
  } catch {
    autoGenEnabled = true;
  }

  // Cancel queue on story switch to avoid saving portraits to wrong story
  bus.on('story:changed', () => {
    if (isProcessing || queue.length > 0) {
      cancel();
      dismissToast();
    }
  });

  bus.on('settings:saved', async () => {
    try {
      const settings = await window.powertool.getSettings?.();
      autoGenEnabled = settings?.autoGeneratePortraits !== false;
    } catch { /* keep current */ }
  });

  bus.on('litrpg:new-characters', ({ newCharacterIds, characters }) => {
    if (!autoGenEnabled || !newCharacterIds?.length) return;
    const toEnqueue = newCharacterIds
      .filter(id => characters?.[id])
      .map(id => ({
        charId: id,
        charName: characters[id].name || characters[id].loreEntryName || id,
        rpgData: characters[id],
      }));
    if (toEnqueue.length) enqueue(toEnqueue);
  });

  bus.on('litrpg:visual-profiles-updated', ({ visualProfileUpdatedIds, characters }) => {
    if (!autoGenEnabled || !visualProfileUpdatedIds?.length) return;
    const toEnqueue = visualProfileUpdatedIds
      .filter(id => characters?.[id] && !characters[id].portraitPath)
      .map(id => ({
        charId: id,
        charName: characters[id].name || characters[id].loreEntryName || id,
        rpgData: characters[id],
      }));
    if (toEnqueue.length) enqueue(toEnqueue);
  });
}
