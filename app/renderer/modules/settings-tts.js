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
} from './dom-refs.js';
import { state } from './state.js';
import { refreshVoiceMapUI } from './tts.js';
import { showToast } from './utils.js';

// Toggle v2 fields visibility based on TTS version and provider
function updateTtsV2Visibility() {
  const isNovelai = ttsProviderSelect.value !== 'venice';
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
  ttsNarratorVoiceSelect.innerHTML = '<option disabled selected>Loading voices...</option>';
  ttsDialogueVoiceSelect.innerHTML = '<option disabled selected>Loading voices...</option>';
  try {
    const opts = {};
    if (ttsProviderSelect.value === 'venice' && veniceTtsModelSelect?.value) {
      opts.ttsModel = veniceTtsModelSelect.value;
    }
    const voices = await window.powertool.ttsGetVoices(opts);
    for (const sel of [ttsNarratorVoiceSelect, ttsDialogueVoiceSelect, ttsAddCharVoice]) {
      if (!sel) continue;
      const addCustom = sel === ttsNarratorVoiceSelect || sel === ttsDialogueVoiceSelect || sel === ttsAddCharVoice;
      populateVoiceSelect(sel, voices, addCustom);
    }
    return voices;
  } catch (e) {
    console.error('Failed to load TTS voices:', e);
    ttsNarratorVoiceSelect.innerHTML = '<option disabled selected>Failed to load voices</option>';
    ttsDialogueVoiceSelect.innerHTML = '<option disabled selected>Failed to load voices</option>';
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
    await loadVeniceTtsModels(ttsProviderSelect.value === 'venice');
    // Restore stored TTS model from Venice settings
    if (ttsProviderSelect.value === 'venice' && veniceTtsModelSelect) {
      try {
        const veniceSettings = await window.powertool.getVeniceSettings();
        if (veniceSettings.ttsModel) veniceTtsModelSelect.value = veniceSettings.ttsModel;
      } catch { /* ignore */ }
    }
    const voices = await loadTtsVoices();
    // Load narrator voice — handle object values (v2 custom) or custom seed strings
    const narVoice = ttsSettings.ttsNarratorVoice;
    if (narVoice && typeof narVoice === 'object' && narVoice.v === 2) {
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
    if (dlgVoice && typeof dlgVoice === 'object' && dlgVoice.v === 2) {
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
      ttsNarratorVoice: buildVoiceValue(ttsNarratorVoiceSelect, ttsNarratorStyle, ttsNarratorIntonation, ttsNarratorCadence, curTtsVersion, ttsNarratorCustomSeed),
      ttsDialogueVoice: buildVoiceValue(ttsDialogueVoiceSelect, ttsDialogueStyle, ttsDialogueIntonation, ttsDialogueCadence, curTtsVersion, ttsDialogueCustomSeed),
      ttsSpeed: parseFloat(ttsSpeedSlider.value),
      ttsFirstPerson: ttsFirstPersonCheckbox.checked,
    });
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
    ttsNarratorVoice: buildVoiceValue(ttsNarratorVoiceSelect, ttsNarratorStyle, ttsNarratorIntonation, ttsNarratorCadence, perStoryTtsVersion, ttsNarratorCustomSeed),
    ttsDialogueVoice: buildVoiceValue(ttsDialogueVoiceSelect, ttsDialogueStyle, ttsDialogueIntonation, ttsDialogueCadence, perStoryTtsVersion, ttsDialogueCustomSeed),
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
    await loadTtsVoices();
    document.getElementById('ttsSpeedGroup').classList.toggle('u-hidden', !isVenice);
    updateTtsV2Visibility();
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
