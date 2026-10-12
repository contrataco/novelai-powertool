// settings-tts.js — TTS voice config, version switching, voice preview, character voices

import {
  ttsProviderSelect, ttsVersionSelect, ttsVersionGroup,
  ttsNarratorVoiceSelect, ttsDialogueVoiceSelect,
  ttsSpeedSlider, ttsSpeedValue, ttsFirstPersonCheckbox,
  ttsSettingsVoiceList, ttsSettingsVoiceCount,
  ttsAddCharName, ttsAddCharVoice, ttsAddCharBtn,
  ttsV2NarratorGroup, ttsV2DialogueGroup,
  ttsNarratorStyle, ttsNarratorIntonation, ttsNarratorCadence,
  ttsDialogueStyle, ttsDialogueIntonation, ttsDialogueCadence,
  ttsNarratorCustomSeed, ttsDialogueCustomSeed, ttsAddCharCustomSeed,
  veniceTtsModelSelect, veniceTtsModelGroup,
  ttsChatterboxGroup, ttsChatterboxUrl, ttsChatterboxVoicesDir,
  ttsChatterboxExaggeration, ttsChatterboxExaggerationValue,
  ttsChatterboxStatus, ttsChatterboxCheckBtn, ttsChatterboxWarmBtn,
  ttsChatterboxGenderList, ttsChatterboxGenderCount,
} from './dom-refs.js';
import { state } from './state.js';
import { refreshVoiceMapUI } from './tts.js';
import { showToast } from './utils.js';

// Toggle v2 fields visibility based on TTS version and provider
function updateTtsV2Visibility() {
  const isNovelai = ttsProviderSelect.value === 'novelai';
  const ver = ttsVersionSelect.value;
  const showV2 = isNovelai && (ver === 'v2' || ver === 'auto');
  ttsVersionGroup.classList.toggle('u-hidden', !(isNovelai));
  ttsV2NarratorGroup.classList.toggle('u-hidden', !(showV2));
  ttsV2DialogueGroup.classList.toggle('u-hidden', !(showV2));
  // Custom seed inputs
  if (ttsNarratorCustomSeed) ttsNarratorCustomSeed.classList.toggle('u-hidden', !(ttsNarratorVoiceSelect.value === '__custom__'));
  if (ttsDialogueCustomSeed) ttsDialogueCustomSeed.classList.toggle('u-hidden', !(ttsDialogueVoiceSelect.value === '__custom__'));
}

// Populate v2 fields from a voice value (string preset or v2 object)
function populateV2Fields(voice, styleEl, intonationEl, cadenceEl) {
  if (voice && typeof voice === 'object' && voice.v === 2) {
    styleEl.value = voice.style || '';
    intonationEl.value = voice.intonation || '';
    cadenceEl.value = voice.cadence || '';
  } else {
    const seed = voice || '';
    styleEl.value = seed;
    intonationEl.value = seed;
    cadenceEl.value = seed;
  }
}

// Build voice value from v2 fields, dropdown, and custom seed input.
// If all three v2 fields match, return string; if they diverge, return v2 object.
export function buildVoiceValue(selectEl, styleEl, intonationEl, cadenceEl, ttsVersion, customSeedEl) {
  const preset = selectEl.value;
  // Custom seed mode — use the custom seed text input
  if (preset === '__custom__') {
    const customSeed = customSeedEl?.value?.trim();
    if (ttsVersion === 'v2' || ttsVersion === 'auto') {
      const s = styleEl.value.trim();
      const i = intonationEl.value.trim();
      const c = cadenceEl.value.trim();
      // If v2 fields are customized, use them
      if (s && (s !== i || s !== c)) return { v: 2, style: s, intonation: i || s, cadence: c || s };
      // Otherwise use the custom seed text
      if (customSeed) return customSeed;
      return s || 'Cyllene';
    }
    return customSeed || 'Cyllene';
  }
  // Preset selected — check if v2 fields diverge
  if (ttsVersion === 'v2' || ttsVersion === 'auto') {
    const s = styleEl.value.trim();
    const i = intonationEl.value.trim();
    const c = cadenceEl.value.trim();
    if (s && (s !== preset || i !== preset || c !== preset)) {
      return { v: 2, style: s, intonation: i || s, cadence: c || s };
    }
  }
  return preset || 'Cyllene';
}

// Seeds, custom seeds and v2 style/intonation/cadence are NovelAI-only. Other
// providers take the listed voice id as is; the hidden v2 fields may still hold
// an old NovelAI voice and must not leak into a Chatterbox or Venice setting.
function readVoice(selectEl, ...novelaiArgs) {
  // Still loading, or the list failed (server down): keep the saved voice rather
  // than saving a placeholder.
  const real = [...selectEl.options].filter((o) => o.value && !o.disabled && o.value !== '__custom__');
  if (!real.length) return storedVoices[selectEl.id] ?? '';
  if (ttsProviderSelect.value === 'novelai') return buildVoiceValue(selectEl, ...novelaiArgs);
  const v = selectEl.value;
  return v && v !== '__custom__' ? v : real[0].value;
}

// Voices as they were when the modal opened (see readVoice).
let storedVoices = {};

// Select a stored voice if this provider lists it, else the first voice (e.g. a
// NovelAI voice left over after switching to Chatterbox).
function selectListedVoice(selectEl, voice) {
  const listed = typeof voice === 'string' && [...selectEl.options].some((o) => o.value === voice);
  selectEl.value = listed ? voice : (selectEl.options[0]?.value || '');
}

// Populate a voice <select> with grouped voices (v2/v1/custom)
function populateVoiceSelect(sel, voices, addCustomOption) {
  const prev = sel.value;
  sel.innerHTML = '';
  // Group by version
  const v2 = voices.filter(v => v.version === 'v2');
  const v1 = voices.filter(v => v.version === 'v1');
  const other = voices.filter(v => !v.version);
  if (v2.length) {
    const grp = document.createElement('optgroup');
    grp.label = 'v2 Voices';
    for (const v of v2) {
      const opt = document.createElement('option');
      opt.value = v.id;
      opt.textContent = v.name;
      grp.appendChild(opt);
    }
    sel.appendChild(grp);
  }
  if (v1.length) {
    const grp = document.createElement('optgroup');
    grp.label = 'v1 Voices (legacy)';
    for (const v of v1) {
      const opt = document.createElement('option');
      opt.value = v.id;
      opt.textContent = v.name;
      grp.appendChild(opt);
    }
    sel.appendChild(grp);
  }
  for (const v of other) {
    const opt = document.createElement('option');
    opt.value = v.id;
    opt.textContent = v.name;
    sel.appendChild(opt);
  }
  if (addCustomOption) {
    const customOpt = document.createElement('option');
    customOpt.value = '__custom__';
    customOpt.textContent = 'Custom seed...';
    sel.appendChild(customOpt);
  }
  if (prev && [...sel.options].some(o => o.value === prev)) sel.value = prev;
}

// Load TTS voices into narrator and dialogue dropdowns
async function loadTtsVoices() {
  ttsNarratorVoiceSelect.innerHTML = '<option value="" disabled selected>Loading voices...</option>';
  ttsDialogueVoiceSelect.innerHTML = '<option value="" disabled selected>Loading voices...</option>';
  try {
    const opts = { provider: ttsProviderSelect.value };
    if (ttsProviderSelect.value === 'venice' && veniceTtsModelSelect?.value) {
      opts.ttsModel = veniceTtsModelSelect.value;
    }
    const voices = await window.powertool.ttsGetVoices(opts);
    for (const sel of [ttsNarratorVoiceSelect, ttsDialogueVoiceSelect, ttsAddCharVoice]) {
      if (!sel) continue;
      const addCustom = sel === ttsNarratorVoiceSelect || sel === ttsDialogueVoiceSelect || sel === ttsAddCharVoice;
      populateVoiceSelect(sel, voices, addCustom && ttsProviderSelect.value === 'novelai');
    }
    if (ttsProviderSelect.value === 'chatterbox') renderChatterboxGenders(voices);
    return voices;
  } catch (e) {
    console.error('Failed to load TTS voices:', e);
    ttsNarratorVoiceSelect.innerHTML = '<option value="" disabled selected>Failed to load voices</option>';
    ttsDialogueVoiceSelect.innerHTML = '<option value="" disabled selected>Failed to load voices</option>';
    showToast('Failed to load TTS voices', null, 'warn');
    return [];
  }
}

// Render character voice rows in settings modal
function renderSettingsVoiceList(voices) {
  if (!ttsSettingsVoiceList) return;
  const ttsState = state.ttsState || { characterVoices: {} };
  const charVoices = ttsState.characterVoices || {};
  const entries = Object.entries(charVoices);

  ttsSettingsVoiceList.innerHTML = '';
  if (ttsSettingsVoiceCount) ttsSettingsVoiceCount.textContent = `(${entries.length})`;

  for (const [charName, voiceId] of entries) {
    const row = document.createElement('div');
    row.className = 'char-voice-row';

    const nameEl = document.createElement('span');
    nameEl.className = 'char-voice-name';
    nameEl.textContent = charName;

    const sel = document.createElement('select');
    sel.className = 'char-voice-select';
    populateVoiceSelect(sel, voices, true);
    if (voiceId) sel.value = voiceId;
    // If voiceId is a custom seed not in the presets, add it as an option
    if (voiceId && !sel.value) {
      const customOpt = document.createElement('option');
      customOpt.value = voiceId;
      customOpt.textContent = voiceId + ' (custom)';
      sel.insertBefore(customOpt, sel.firstChild);
      sel.value = voiceId;
    }
    sel.addEventListener('change', async () => {
      if (state.currentStoryId) {
        await window.powertool.ttsSetCharacterVoice(state.currentStoryId, charName, sel.value);
        state.ttsState.characterVoices[charName] = sel.value;
      }
    });

    const rmBtn = document.createElement('button');
    rmBtn.textContent = '\u00d7';
    rmBtn.className = 'char-voice-remove';
    rmBtn.addEventListener('click', async () => {
      if (state.currentStoryId) {
        await window.powertool.ttsRemoveCharacterVoice(state.currentStoryId, charName);
        delete state.ttsState.characterVoices[charName];
        row.remove();
        if (ttsSettingsVoiceCount) ttsSettingsVoiceCount.textContent = `(${Object.keys(state.ttsState.characterVoices).length})`;
        refreshVoiceMapUI();
      }
    });

    row.appendChild(nameEl);
    row.appendChild(sel);
    row.appendChild(rmBtn);
    ttsSettingsVoiceList.appendChild(row);
  }
}

// Load Venice TTS models into the TTS model dropdown
async function loadVeniceTtsModels(show) {
  if (veniceTtsModelGroup) veniceTtsModelGroup.classList.toggle('u-hidden', !show);
  if (!show || !veniceTtsModelSelect) return;
  try {
    const models = await window.powertool.veniceGetTtsModels();
    veniceTtsModelSelect.innerHTML = '';
    for (const m of models) {
      const opt = document.createElement('option');
      opt.value = m.id;
      opt.textContent = m.name;
      veniceTtsModelSelect.appendChild(opt);
    }
  } catch (e) {
    console.error('Failed to load Venice TTS models:', e);
  }
}

// --- Chatterbox (local server) ---

let chatterboxGenderOverrides = {};

function showChatterboxGroup() {
  ttsChatterboxGroup?.classList.toggle('u-hidden', ttsProviderSelect.value !== 'chatterbox');
}

const MODEL_STATE_TEXT = {
  stopped: 'model not loaded (loads on first use, about a minute)',
  loading: 'model loading...',
  ready: 'model loaded and ready',
  busy: 'model busy rendering',
};

async function refreshChatterboxStatus() {
  if (!ttsChatterboxStatus) return;
  ttsChatterboxStatus.textContent = 'Checking...';
  ttsChatterboxStatus.dataset.state = '';
  const st = await window.powertool.chatterboxStatus();
  if (!st.online) {
    ttsChatterboxStatus.textContent = `Offline: ${st.error || 'no answer'}`;
    ttsChatterboxStatus.dataset.state = 'offline';
    return st;
  }
  ttsChatterboxStatus.textContent = `Online - ${MODEL_STATE_TEXT[st.model] || st.model}`;
  ttsChatterboxStatus.dataset.state = st.model === 'ready' ? 'ready' : 'online';
  return st;
}

// The URL and folder are read by the main process, so store them before asking it anything.
async function saveChatterboxFields() {
  await window.powertool.ttsSetSettings({
    ttsChatterboxUrl: ttsChatterboxUrl.value.trim(),
    ttsChatterboxVoicesDir: ttsChatterboxVoicesDir.value.trim(),
    ttsChatterboxExaggeration: parseFloat(ttsChatterboxExaggeration.value),
    ttsChatterboxVoiceGenders: chatterboxGenderOverrides,
  });
}

const SOURCE_TEXT = { name: 'from name', pitch: 'from pitch', override: 'set by you', none: 'not detected' };

function renderChatterboxGenders(voices) {
  if (!ttsChatterboxGenderList) return;
  ttsChatterboxGenderList.innerHTML = '';
  const real = voices.filter((v) => v.id !== 'default');
  const unknown = real.filter((v) => v.gender === 'unknown').length;
  if (ttsChatterboxGenderCount) {
    ttsChatterboxGenderCount.textContent = `(${real.length} voices${unknown ? `, ${unknown} unknown` : ''})`;
  }
  for (const v of real) {
    const row = document.createElement('div');
    row.className = 'chatterbox-gender-row';

    const name = document.createElement('div');
    name.className = 'chatterbox-gender-name';
    name.textContent = v.id;
    const detail = document.createElement('div');
    detail.className = 'chatterbox-gender-detail';
    const hz = v.pitch ? `${v.pitch} Hz` : 'no clip found';
    detail.textContent = v.genderSource === 'override'
      ? `${v.gender}, set by you (${hz})`
      : `${v.gender === 'unknown' ? 'unsure' : v.gender}, ${SOURCE_TEXT[v.genderSource] || ''} (${hz})`;

    const sel = document.createElement('select');
    sel.setAttribute('aria-label', `Gender for ${v.id}`);
    for (const [val, label] of [['', 'Auto'], ['female', 'Female'], ['male', 'Male']]) {
      const opt = document.createElement('option');
      opt.value = val;
      opt.textContent = label;
      sel.appendChild(opt);
    }
    sel.value = chatterboxGenderOverrides[v.id] || '';
    sel.addEventListener('change', async () => {
      if (sel.value) chatterboxGenderOverrides[v.id] = sel.value;
      else delete chatterboxGenderOverrides[v.id];
      await saveChatterboxFields();
      await loadTtsVoices();
    });

    const text = document.createElement('div');
    text.appendChild(name);
    text.appendChild(detail);
    row.appendChild(text);
    row.appendChild(sel);
    ttsChatterboxGenderList.appendChild(row);
  }
}

async function loadChatterboxFields() {
  const s = await window.powertool.ttsGetSettings();
  ttsChatterboxUrl.value = s.ttsChatterboxUrl || '';
  ttsChatterboxVoicesDir.value = s.ttsChatterboxVoicesDir || '';
  ttsChatterboxExaggeration.value = s.ttsChatterboxExaggeration ?? 0.5;
  ttsChatterboxExaggerationValue.textContent = Number(ttsChatterboxExaggeration.value).toFixed(2);
  chatterboxGenderOverrides = { ...(s.ttsChatterboxVoiceGenders || {}) };
}

// --- Load TTS settings into the modal ---

export async function loadTtsSettings(storySettings) {
  try {
    const ttsSettings = storySettings || await window.powertool.ttsGetSettings();
    ttsProviderSelect.value = ttsSettings.ttsProvider || 'novelai';
    ttsVersionSelect.value = ttsSettings.ttsVersion || 'auto';
    ttsSpeedSlider.value = ttsSettings.ttsSpeed || 1.0;
    ttsSpeedValue.textContent = ttsSettings.ttsSpeed || 1.0;
    ttsFirstPersonCheckbox.checked = !!ttsSettings.ttsFirstPerson;
    document.getElementById('ttsSpeedGroup').classList.toggle('u-hidden', ttsProviderSelect.value !== 'venice');
    showChatterboxGroup();
    try { await loadChatterboxFields(); } catch (e) { console.warn('[Settings] Chatterbox fields:', e.message); }
    if (ttsProviderSelect.value === 'chatterbox') refreshChatterboxStatus();
    await loadVeniceTtsModels(ttsProviderSelect.value === 'venice');
    // Restore stored TTS model from Venice settings
    if (ttsProviderSelect.value === 'venice' && veniceTtsModelSelect) {
      try {
        const veniceSettings = await window.powertool.getVeniceSettings();
        if (veniceSettings.ttsModel) veniceTtsModelSelect.value = veniceSettings.ttsModel;
      } catch (e) {
        console.log('[Settings] Could not restore Venice TTS model:', e.message);
      }
    }
    storedVoices = { [ttsNarratorVoiceSelect.id]: ttsSettings.ttsNarratorVoice, [ttsDialogueVoiceSelect.id]: ttsSettings.ttsDialogueVoice };
    const voices = await loadTtsVoices();
    // Load narrator voice — handle object values (v2 custom) or custom seed strings
    const narVoice = ttsSettings.ttsNarratorVoice;
    if (ttsProviderSelect.value !== 'novelai') {
      selectListedVoice(ttsNarratorVoiceSelect, narVoice);
    } else if (narVoice && typeof narVoice === 'object' && narVoice.v === 2) {
      ttsNarratorVoiceSelect.value = '__custom__';
    } else if (narVoice && ![...ttsNarratorVoiceSelect.options].some(o => o.value === narVoice)) {
      ttsNarratorVoiceSelect.value = '__custom__';
      if (ttsNarratorCustomSeed) ttsNarratorCustomSeed.value = narVoice;
    } else {
      ttsNarratorVoiceSelect.value = narVoice || '';
    }
    if (ttsNarratorCustomSeed) ttsNarratorCustomSeed.classList.toggle('u-hidden', !(ttsNarratorVoiceSelect.value === '__custom__'));
    populateV2Fields(narVoice, ttsNarratorStyle, ttsNarratorIntonation, ttsNarratorCadence);
    // Load dialogue voice — handle object values (v2 custom) or custom seed strings
    const dlgVoice = ttsSettings.ttsDialogueVoice;
    if (ttsProviderSelect.value !== 'novelai') {
      selectListedVoice(ttsDialogueVoiceSelect, dlgVoice);
    } else if (dlgVoice && typeof dlgVoice === 'object' && dlgVoice.v === 2) {
      ttsDialogueVoiceSelect.value = '__custom__';
    } else if (dlgVoice && ![...ttsDialogueVoiceSelect.options].some(o => o.value === dlgVoice)) {
      ttsDialogueVoiceSelect.value = '__custom__';
      if (ttsDialogueCustomSeed) ttsDialogueCustomSeed.value = dlgVoice;
    } else {
      ttsDialogueVoiceSelect.value = dlgVoice || '';
    }
    if (ttsDialogueCustomSeed) ttsDialogueCustomSeed.classList.toggle('u-hidden', !(ttsDialogueVoiceSelect.value === '__custom__'));
    populateV2Fields(dlgVoice, ttsDialogueStyle, ttsDialogueIntonation, ttsDialogueCadence);
    updateTtsV2Visibility();
    renderSettingsVoiceList(voices);
  } catch (e) {
    console.error('[Settings] TTS load error:', e);
  }
}

// --- Save TTS settings from the modal ---

export async function saveTtsSettings() {
  try {
    const curTtsVersion = ttsVersionSelect.value;
    await window.powertool.ttsSetSettings({
      ttsProvider: ttsProviderSelect.value,
      ttsVersion: curTtsVersion,
      ttsNarratorVoice: readVoice(ttsNarratorVoiceSelect, ttsNarratorStyle, ttsNarratorIntonation, ttsNarratorCadence, curTtsVersion, ttsNarratorCustomSeed),
      ttsDialogueVoice: readVoice(ttsDialogueVoiceSelect, ttsDialogueStyle, ttsDialogueIntonation, ttsDialogueCadence, curTtsVersion, ttsDialogueCustomSeed),
      ttsSpeed: parseFloat(ttsSpeedSlider.value),
      ttsFirstPerson: ttsFirstPersonCheckbox.checked,
    });
    await saveChatterboxFields();
    // Save Venice TTS model selection
    if (ttsProviderSelect.value === 'venice' && veniceTtsModelSelect?.value) {
      await window.powertool.setVeniceSettings({ ttsModel: veniceTtsModelSelect.value });
    }
  } catch (e) {
    console.error('[Settings] TTS save error:', e);
  }
}

// --- Build per-story TTS settings object ---

export function buildPerStoryTtsSettings() {
  const perStoryTtsVersion = ttsVersionSelect.value;
  return {
    ttsProvider: ttsProviderSelect.value,
    ttsVersion: perStoryTtsVersion,
    ttsNarratorVoice: readVoice(ttsNarratorVoiceSelect, ttsNarratorStyle, ttsNarratorIntonation, ttsNarratorCadence, perStoryTtsVersion, ttsNarratorCustomSeed),
    ttsDialogueVoice: readVoice(ttsDialogueVoiceSelect, ttsDialogueStyle, ttsDialogueIntonation, ttsDialogueCadence, perStoryTtsVersion, ttsDialogueCustomSeed),
    ttsSpeed: parseFloat(ttsSpeedSlider.value),
    ttsFirstPerson: ttsFirstPersonCheckbox.checked,
  };
}

// --- Init event listeners for TTS ---

export function initTtsEvents() {
  // TTS speed slider
  ttsSpeedSlider.addEventListener('input', () => {
    ttsSpeedValue.textContent = ttsSpeedSlider.value;
  });

  // TTS character voice add button
  if (ttsAddCharBtn) {
    ttsAddCharBtn.addEventListener('click', async () => {
      const name = ttsAddCharName.value.trim();
      let voice = ttsAddCharVoice.value;
      if (voice === '__custom__' && ttsAddCharCustomSeed) {
        const customSeed = ttsAddCharCustomSeed.value.trim();
        if (!customSeed) return;
        voice = customSeed;
      }
      if (!name) return;
      if (!state.currentStoryId) return;
      if (!state.ttsState) state.ttsState = { characterVoices: {} };
      state.ttsState.characterVoices[name] = voice;
      await window.powertool.ttsSetCharacterVoice(state.currentStoryId, name, voice);
      ttsAddCharName.value = '';
      const voices = await loadTtsVoices();
      renderSettingsVoiceList(voices);
      refreshVoiceMapUI();
    });
  }

  // TTS provider change — refresh voice lists, toggle speed slider, load TTS models
  ttsProviderSelect.addEventListener('change', async () => {
    const isVenice = ttsProviderSelect.value === 'venice';
    await loadVeniceTtsModels(isVenice);
    // Restore saved TTS model before loading voices so the correct voice set is fetched
    if (isVenice && veniceTtsModelSelect) {
      try {
        const veniceSettings = await window.powertool.getVeniceSettings();
        if (veniceSettings.ttsModel) veniceTtsModelSelect.value = veniceSettings.ttsModel;
      } catch (e) {
        console.log('[Settings] Could not restore Venice TTS model:', e.message);
      }
    }
    showChatterboxGroup();
    if (ttsProviderSelect.value === 'chatterbox') {
      await saveChatterboxFields();
      refreshChatterboxStatus();
    }
    await loadTtsVoices();
    document.getElementById('ttsSpeedGroup').classList.toggle('u-hidden', !isVenice);
    updateTtsV2Visibility();
  });

  // Chatterbox: status, voice reload, model warm-up
  ttsChatterboxExaggeration?.addEventListener('input', () => {
    ttsChatterboxExaggerationValue.textContent = Number(ttsChatterboxExaggeration.value).toFixed(2);
  });
  ttsChatterboxCheckBtn?.addEventListener('click', async () => {
    await saveChatterboxFields();
    const st = await refreshChatterboxStatus();
    if (st?.online) await loadTtsVoices();
  });
  ttsChatterboxWarmBtn?.addEventListener('click', async () => {
    ttsChatterboxWarmBtn.disabled = true;
    ttsChatterboxStatus.textContent = 'Loading model (up to a minute)...';
    try {
      await saveChatterboxFields();
      const r = await window.powertool.chatterboxWarm();
      if (!r.success) showToast('Chatterbox: ' + r.error, 5000, 'error');
    } finally {
      ttsChatterboxWarmBtn.disabled = false;
      refreshChatterboxStatus();
    }
  });

  // Venice TTS model change — reload voices for the selected model
  if (veniceTtsModelSelect) {
    veniceTtsModelSelect.addEventListener('change', async () => {
      await loadTtsVoices();
    });
  }

  // TTS version change — toggle v2 fields
  ttsVersionSelect.addEventListener('change', () => {
    updateTtsV2Visibility();
  });

  // Sync v2 fields when a preset is selected in narrator/dialogue dropdowns + toggle custom seed
  ttsNarratorVoiceSelect.addEventListener('change', () => {
    const val = ttsNarratorVoiceSelect.value;
    if (ttsNarratorCustomSeed) ttsNarratorCustomSeed.classList.toggle('u-hidden', !(val === '__custom__'));
    if (val && val !== '__custom__') {
      populateV2Fields(val, ttsNarratorStyle, ttsNarratorIntonation, ttsNarratorCadence);
    }
  });
  ttsDialogueVoiceSelect.addEventListener('change', () => {
    const val = ttsDialogueVoiceSelect.value;
    if (ttsDialogueCustomSeed) ttsDialogueCustomSeed.classList.toggle('u-hidden', !(val === '__custom__'));
    if (val && val !== '__custom__') {
      populateV2Fields(val, ttsDialogueStyle, ttsDialogueIntonation, ttsDialogueCadence);
    }
  });
  // Character voice add — toggle custom seed input
  if (ttsAddCharVoice && ttsAddCharCustomSeed) {
    ttsAddCharVoice.addEventListener('change', () => {
      ttsAddCharCustomSeed.classList.toggle('u-hidden', !(ttsAddCharVoice.value === '__custom__'));
    });
  }
}
