// tts.js — Text-to-Speech narration controls with per-character voice mapping

import {
  ttsNarrateBtn, ttsStopBtn, ttsProgress,
  ttsVoiceList, ttsVoiceCount, ttsAutoAssignBtn,
  ttsPanelAddName, ttsPanelAddBtn,
} from './dom-refs.js';
import { state, bus } from './state.js';
import { readStoryTextFromDOM } from './webview-polling.js';
import { showToast, friendlyApiError } from './utils.js';
import { loreCall } from './lore-creator.js';
import { parseMetadataClient } from './metadata.js';

let audioEl = null;
let aborted = false;
let isNarrating = false;
let cachedVoices = null;

async function getVoices() {
  if (!cachedVoices) {
    cachedVoices = await window.sceneVisualizer.ttsGetVoices();
  }
  return cachedVoices;
}

function getVoiceDisplayName(voiceId) {
  if (voiceId && typeof voiceId === 'object' && voiceId.v === 2) {
    const parts = [voiceId.style, voiceId.intonation, voiceId.cadence].filter(Boolean);
    const unique = [...new Set(parts)];
    return unique.join('/') + ' (custom)';
  }
  return voiceId || '';
}

function buildVoiceSelect(voices, selectedVoice) {
  const sel = document.createElement('select');
  sel.className = 'tts-voice-select';
  // Group voices by version
  const v2 = voices.filter(v => v.version === 'v2');
  const v1 = voices.filter(v => v.version === 'v1');
  const other = voices.filter(v => !v.version);
  const addGroup = (label, items) => {
    if (!items.length) return;
    const grp = document.createElement('optgroup');
    grp.label = label;
    for (const v of items) {
      const opt = document.createElement('option');
      opt.value = v.id;
      opt.textContent = v.name;
      if (typeof selectedVoice === 'string' && v.id === selectedVoice) opt.selected = true;
      grp.appendChild(opt);
    }
    sel.appendChild(grp);
  };
  if (v2.length) addGroup('v2 Voices', v2);
  if (v1.length) addGroup('v1 Voices (legacy)', v1);
  for (const v of other) {
    const opt = document.createElement('option');
    opt.value = v.id;
    opt.textContent = v.name;
    if (typeof selectedVoice === 'string' && v.id === selectedVoice) opt.selected = true;
    sel.appendChild(opt);
  }
  // If selectedVoice is a v2 object, add a display-only option
  if (selectedVoice && typeof selectedVoice === 'object' && selectedVoice.v === 2) {
    const customOpt = document.createElement('option');
    customOpt.value = JSON.stringify(selectedVoice);
    customOpt.textContent = getVoiceDisplayName(selectedVoice);
    customOpt.selected = true;
    sel.appendChild(customOpt);
  }
  // If selectedVoice is a custom string not in presets, add it
  if (typeof selectedVoice === 'string' && !sel.value) {
    const customOpt = document.createElement('option');
    customOpt.value = selectedVoice;
    customOpt.textContent = selectedVoice + ' (custom)';
    customOpt.selected = true;
    sel.insertBefore(customOpt, sel.firstChild);
  }
  return sel;
}

function renderVoiceRow(container, charName, voiceId, voices, onVoiceChange, onRemove) {
  const row = document.createElement('div');
  row.className = 'tts-voice-row';

  const nameSpan = document.createElement('span');
  nameSpan.className = 'tts-char-name';
  nameSpan.textContent = charName;

  const sel = buildVoiceSelect(voices, voiceId);
  sel.addEventListener('change', () => onVoiceChange(charName, sel.value));

  const previewBtn = document.createElement('button');
  previewBtn.className = 'tts-voice-preview';
  previewBtn.textContent = '\u25B6';
  previewBtn.title = 'Preview voice';
  previewBtn.addEventListener('click', async () => {
    previewBtn.disabled = true;
    previewBtn.textContent = '\u23F3';
    try {
      const currentVoice = sel.value;
      const sample = `Hello, my name is ${charName}.`;
      const result = await window.sceneVisualizer.ttsGenerateSpeech(sample, currentVoice, state.currentStoryId);
      if (result && result.audioData) {
        if (!audioEl) audioEl = document.createElement('audio');
        audioEl.src = result.audioData;
        await audioEl.play();
      }
    } catch (e) {
      showToast('Preview failed: ' + friendlyApiError(e), 3000, 'error');
    } finally {
      previewBtn.disabled = false;
      previewBtn.textContent = '\u25B6';
    }
  });

  const removeBtn = document.createElement('button');
  removeBtn.className = 'tts-voice-remove';
  removeBtn.textContent = '\u00d7';
  removeBtn.title = 'Remove';
  removeBtn.addEventListener('click', () => onRemove(charName, row));

  row.appendChild(nameSpan);
  row.appendChild(sel);
  row.appendChild(previewBtn);
  row.appendChild(removeBtn);
  container.appendChild(row);
}

function classifyCharacterGroup(charName) {
  const rpgChars = state.litrpgState?.characters || {};
  for (const char of Object.values(rpgChars)) {
    if (char.name === charName || (char.aliases || []).includes(charName)) {
      if (char.isPartyMember) return 'party';
      if (char.isNPC) return 'npc';
    }
  }
  return 'other';
}

function renderGroupLabel(container, label) {
  const el = document.createElement('div');
  el.className = 'tts-group-label';
  el.textContent = label;
  container.appendChild(el);
}

export async function refreshVoiceMapUI() {
  if (!ttsVoiceList || !state.currentStoryId) return;

  const ttsState = state.ttsState || { characterVoices: {} };
  const characterVoices = ttsState.characterVoices || {};
  const entries = Object.entries(characterVoices);

  ttsVoiceList.innerHTML = '';
  ttsVoiceCount.textContent = `(${entries.length})`;

  if (entries.length === 0) {
    const empty = document.createElement('div');
    empty.style.cssText = 'font-size:11px;color:var(--text-muted);padding:4px 0;';
    empty.innerHTML = 'No character voices assigned. Click <b>Auto-Assign</b> to match lorebook characters to voices, or add manually below.';
    ttsVoiceList.appendChild(empty);
    return;
  }

  const voices = await getVoices();

  const makeCallbacks = () => ({
    onChange: async (name, newVoice) => {
      await window.sceneVisualizer.ttsSetCharacterVoice(state.currentStoryId, name, newVoice);
      state.ttsState.characterVoices[name] = newVoice;
    },
    onRemove: async (name, row) => {
      await window.sceneVisualizer.ttsRemoveCharacterVoice(state.currentStoryId, name);
      delete state.ttsState.characterVoices[name];
      row.remove();
      ttsVoiceCount.textContent = `(${Object.keys(state.ttsState.characterVoices).length})`;
    }
  });

  // Group entries by party/NPC/other
  const groups = { party: [], npc: [], other: [] };
  for (const [charName, voiceVal] of entries) {
    const group = classifyCharacterGroup(charName);
    groups[group].push([charName, voiceVal]);
  }

  const hasMultipleGroups = [groups.party, groups.npc, groups.other].filter(g => g.length > 0).length > 1;
  const cbs = makeCallbacks();

  for (const [groupKey, label] of [['party', 'Party'], ['npc', 'NPCs'], ['other', 'Other']]) {
    if (groups[groupKey].length === 0) continue;
    if (hasMultipleGroups) renderGroupLabel(ttsVoiceList, label);
    for (const [charName, voiceVal] of groups[groupKey]) {
      renderVoiceRow(ttsVoiceList, charName, voiceVal, voices, cbs.onChange, cbs.onRemove);
    }
  }
}

// Gender classification for voices
const NOVELAI_FEMALE_V1 = new Set(['Cyllene', 'Leucosia', 'Crina', 'Hespe', 'Ida']);
const NOVELAI_MALE_V1 = new Set(['Alseid', 'Daphnis', 'Echo', 'Thel', 'Nomios']);
const NOVELAI_FEMALE_V2 = new Set(['Aini', 'Orea', 'Claea', 'Lim', 'Aurae', 'Naia']);
const NOVELAI_MALE_V2 = new Set(['Aulon', 'Elei', 'Ogma', 'Raid', 'Pega', 'Lam', 'Ligeia']);

function classifyVoiceGender(voiceId) {
  if (!voiceId || typeof voiceId !== 'string') return 'unknown';
  // Venice: af_/bf_ = female, am_/bm_ = male
  if (/^[ab]f_/.test(voiceId)) return 'female';
  if (/^[ab]m_/.test(voiceId)) return 'male';
  // NovelAI presets
  if (NOVELAI_FEMALE_V1.has(voiceId) || NOVELAI_FEMALE_V2.has(voiceId)) return 'female';
  if (NOVELAI_MALE_V1.has(voiceId) || NOVELAI_MALE_V2.has(voiceId)) return 'male';
  return 'unknown';
}

function extractGenderFromEntry(text) {
  if (!text) return 'unknown';
  const match = text.match(/\bGender:\s*(\w+)/i);
  if (!match) return 'unknown';
  const val = match[1].toLowerCase();
  if (/^(?:female|woman|f)$/.test(val)) return 'female';
  if (/^(?:male|man|m)$/.test(val)) return 'male';
  return 'unknown';
}

function pickFromPool(pool, usedVoices, idxRef) {
  for (let i = 0; i < pool.length; i++) {
    const candidate = pool[(idxRef.val + i) % pool.length].id;
    if (!usedVoices.has(candidate)) {
      idxRef.val = (idxRef.val + i + 1) % pool.length;
      return candidate;
    }
  }
  // All used — cycle
  if (pool.length > 0) {
    const v = pool[idxRef.val % pool.length].id;
    idxRef.val = (idxRef.val + 1) % pool.length;
    return v;
  }
  return null;
}

async function autoAssignFromLore() {
  if (!state.currentStoryId) {
    showToast('No story loaded', 3000, 'warn');
    return;
  }

  try {
    let entries = [];
    try { entries = await loreCall('getEntries'); } catch { /* ignore */ }
    if (!entries || entries.length === 0) {
      showToast('No lore entries found', 3000, 'warn');
      return;
    }

    // Filter to character entries (has @type: character, or heuristic)
    const characters = entries.filter(e => {
      if (!e.text) return false;
      const meta = parseMetadataClient(e.text);
      if (meta.type) return meta.type === 'character';
      return /\b(?:Class|Race|Level|Appearance|Personality)\b/i.test(e.text);
    });

    if (characters.length === 0) {
      showToast('No character entries found in lorebook', 3000, 'warn');
      return;
    }

    const voices = await getVoices();
    if (!voices || voices.length === 0) {
      showToast('No TTS voices available', 3000, 'warn');
      return;
    }

    const ttsState = state.ttsState || { characterVoices: {} };
    const existing = ttsState.characterVoices || {};
    let assigned = 0;

    const usedVoices = new Set(Object.values(existing));

    // Build gendered voice pools
    const femaleVoices = voices.filter(v => classifyVoiceGender(v.id) === 'female');
    const maleVoices = voices.filter(v => classifyVoiceGender(v.id) === 'male');
    const unknownVoices = voices.filter(v => classifyVoiceGender(v.id) === 'unknown');
    const femaleIdx = { val: 0 };
    const maleIdx = { val: 0 };
    const unknownIdx = { val: 0 };
    const allIdx = { val: 0 };

    for (const entry of characters) {
      const name = entry.displayName || entry.keys?.[0] || '';
      if (!name || existing[name]) continue;

      const gender = extractGenderFromEntry(entry.text);
      let voice = null;

      // Try gender-matched pool first, then fall back to other pools
      if (gender === 'female') {
        voice = pickFromPool(femaleVoices, usedVoices, femaleIdx)
             || pickFromPool(unknownVoices, usedVoices, unknownIdx)
             || pickFromPool(maleVoices, usedVoices, maleIdx);
      } else if (gender === 'male') {
        voice = pickFromPool(maleVoices, usedVoices, maleIdx)
             || pickFromPool(unknownVoices, usedVoices, unknownIdx)
             || pickFromPool(femaleVoices, usedVoices, femaleIdx);
      } else {
        voice = pickFromPool(voices, usedVoices, allIdx);
      }

      if (!voice) {
        // Absolute fallback
        voice = voices[0]?.id;
      }

      existing[name] = voice;
      usedVoices.add(voice);
      assigned++;
    }

    ttsState.characterVoices = existing;
    state.ttsState = ttsState;
    await window.sceneVisualizer.ttsSetState(state.currentStoryId, ttsState);
    await refreshVoiceMapUI();
    showToast(`Assigned voices to ${assigned} character${assigned !== 1 ? 's' : ''}`, 3000);
  } catch (e) {
    console.error('[TTS] Auto-assign error:', e);
    showToast('Auto-assign failed: ' + friendlyApiError(e), 4000, 'error');
  }
}

async function narrateScene() {
  if (isNarrating) return;
  isNarrating = true;
  aborted = false;
  ttsNarrateBtn.disabled = true;
  ttsStopBtn.style.display = '';

  try {
    const storyText = await readStoryTextFromDOM();
    if (!storyText || storyText.length < 50) {
      showToast('Not enough text to narrate', 3000, 'warn');
      return;
    }

    let protagonistName = null;
    try {
      const entries = await loreCall('getEntries');
      const protag = entries?.find(e => e.text && parseMetadataClient(e.text).protagonist);
      if (protag) protagonistName = protag.displayName;
    } catch { /* lorebook may not be available */ }

    ttsProgress.textContent = 'Generating audio...';
    const segments = await window.sceneVisualizer.ttsNarrateScene(
      storyText.slice(-3000),
      state.currentStoryId,
      protagonistName
    );

    if (!segments || segments.length === 0) {
      ttsProgress.textContent = 'No audio generated';
      return;
    }

    if (!audioEl) {
      audioEl = document.createElement('audio');
    }

    for (let i = 0; i < segments.length; i++) {
      if (aborted) break;
      const seg = segments[i];
      let label;
      if (seg.type === 'narration') label = 'narration';
      else if (seg.isProtagonist) label = 'protagonist';
      else if (seg.speaker) label = `\u201C${seg.speaker}\u201D`;
      else label = 'dialogue (unmatched)';
      ttsProgress.textContent = `Playing ${i + 1}/${segments.length} \u2014 ${label}`;
      audioEl.src = seg.audioData;
      await new Promise((resolve, reject) => {
        audioEl.onended = resolve;
        audioEl.onerror = reject;
        audioEl.play();
      });
    }
    ttsProgress.textContent = aborted ? 'Stopped' : 'Done';
  } catch (e) {
    console.error('[TTS] Error:', e);
    const ttsErrMsg = friendlyApiError(e);
    ttsProgress.textContent = 'Error: ' + ttsErrMsg;
    showToast('TTS error: ' + ttsErrMsg, 4000, 'error');
  } finally {
    isNarrating = false;
    ttsNarrateBtn.disabled = false;
    ttsStopBtn.style.display = 'none';
    setTimeout(() => { ttsProgress.textContent = ''; }, 3000);
  }
}

function stopNarration() {
  aborted = true;
  if (audioEl) { audioEl.pause(); audioEl.src = ''; }
}

async function addCharacterInline() {
  if (!ttsPanelAddName || !state.currentStoryId) return;
  const name = ttsPanelAddName.value.trim();
  if (!name) {
    showToast('Enter a character name', 2000, 'warn');
    return;
  }
  const ttsState = state.ttsState || { characterVoices: {} };
  if (ttsState.characterVoices[name]) {
    showToast(`${name} already has a voice assigned`, 2000, 'warn');
    return;
  }
  const voices = await getVoices();
  const usedVoices = new Set(Object.values(ttsState.characterVoices));
  const firstFree = voices.find(v => !usedVoices.has(v.id));
  const voice = firstFree ? firstFree.id : (voices[0]?.id || '');
  ttsState.characterVoices[name] = voice;
  state.ttsState = ttsState;
  await window.sceneVisualizer.ttsSetCharacterVoice(state.currentStoryId, name, voice);
  ttsPanelAddName.value = '';
  await refreshVoiceMapUI();
  showToast(`Added ${name}`, 2000);
}

export function init() {
  if (!ttsNarrateBtn) return;
  ttsNarrateBtn.addEventListener('click', narrateScene);
  ttsStopBtn.addEventListener('click', stopNarration);
  if (ttsAutoAssignBtn) {
    ttsAutoAssignBtn.addEventListener('click', autoAssignFromLore);
  }
  if (ttsPanelAddBtn) {
    ttsPanelAddBtn.addEventListener('click', addCharacterInline);
  }
  if (ttsPanelAddName) {
    ttsPanelAddName.addEventListener('keydown', (e) => {
      if (e.key === 'Enter') addCharacterInline();
    });
  }
  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape' && isNarrating) stopNarration();
  });

  // Refresh voice map on story switch
  bus.on('story:changed', () => {
    cachedVoices = null;
    refreshVoiceMapUI();
  });

  // Refresh voice map after settings save (provider/voices may have changed)
  bus.on('settings:saved', () => {
    cachedVoices = null;
    refreshVoiceMapUI();
  });
}
