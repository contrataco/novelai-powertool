/**
 * Portrait Queue — sequential portrait generation with progress UI.
 * Listens for new character events and auto-enqueues when enabled.
 */
import { state, bus } from './state.js';
import { showToast, dismissToast } from './utils.js';

let queue = [];
let isProcessing = false;
let currentIndex = 0;
let autoGenEnabled = true;
let cancelRequested = false;
let currentToast = null;

async function processQueue() {
  if (isProcessing || queue.length === 0) return;
  isProcessing = true;
  cancelRequested = false;
  const total = queue.length;

  for (currentIndex = 0; currentIndex < queue.length; currentIndex++) {
    if (cancelRequested) break;

    const { charId, charName, rpgData } = queue[currentIndex];
    if (currentToast) dismissToast(currentToast);
    currentToast = showToast(`Generating portrait ${currentIndex + 1}/${total}: ${charName}...`, null, 'info', {
      persistent: true,
      onCancel: () => cancel(),
    });

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

  // Release large base64 strings from character objects before save
  const rpg = state.litrpgState;
  if (rpg?.characters) {
    for (const char of Object.values(rpg.characters)) {
      if (char._portraitData) char._portraitData = null;
      if (char._thumbnailData) char._thumbnailData = null;
    }
  }

  queue = [];
  isProcessing = false;

  if (currentToast) dismissToast(currentToast);
  if (cancelRequested) {
    showToast('Portrait generation cancelled.', 3000);
  } else {
    showToast(`Generated ${total} portrait${total !== 1 ? 's' : ''}.`, 3000, 'success');
  }
  currentToast = null;

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

export async function init() {
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
      if (currentToast) { dismissToast(currentToast); currentToast = null; }
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
