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

/** Forget the voice list so the next use re-reads it (e.g. after tags change). */
export function invalidateVoiceCache() {
  cachedVoices = null;
}

async function getVoices() {
  if (!cachedVoices) {
    // The story's own provider when it has one, so a per-story Chatterbox lists its voices.
    const provider = state.storySettings?.ttsProvider;
    try {
      cachedVoices = await window.powertool.ttsGetVoices(provider ? { provider } : undefined);
    } catch (e) {
      // A local server (Chatterbox) can be down; do not cache the empty list.
      console.warn('[TTS] Voice list unavailable:', e.message);
      return [];
    }
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
      const result = await window.powertool.ttsGenerateSpeech(sample, currentVoice, state.currentStoryId);
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
  if (!voices.length) {
    const off = document.createElement('div');
    off.style.cssText = 'font-size:12px;color:var(--warning);padding:4px 0;';
    off.textContent = 'Voice list unavailable - is the TTS server running? Voices shown as saved.';
    ttsVoiceList.appendChild(off);
  }

  const makeCallbacks = () => ({
    onChange: async (name, newVoice) => {
      await window.powertool.ttsSetCharacterVoice(state.currentStoryId, name, newVoice);
      state.ttsState.characterVoices[name] = newVoice;
    },
    onRemove: async (name, row) => {
      await window.powertool.ttsRemoveCharacterVoice(state.currentStoryId, name);
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

// Providers that know their voices' gender (Chatterbox) send it with the listing.
function voiceGenderOf(v) {
  return v.gender && v.gender !== 'unknown' ? v.gender : classifyVoiceGender(v.id);
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

    let globals = {};
    try { globals = await window.powertool.ttsGetSettings(); } catch { /* optional */ }
    const provider = state.storySettings?.ttsProvider || globals.ttsProvider;
    // Narrator and dialogue voices stay free so characters do not sound like the narration.
    const narratorVoice = state.storySettings?.ttsNarratorVoice || globals.ttsNarratorVoice;
    const dialogueVoice = state.storySettings?.ttsDialogueVoice || globals.ttsDialogueVoice;

    // Voices saved under another provider (NovelAI names on Chatterbox) cannot be
    // spoken here, so those characters are recast. NovelAI accepts any seed text,
    // so its assignments are always kept.
    if (provider !== 'novelai') {
      const listed = new Set(voices.map((v) => v.id));
      for (const [name, voice] of Object.entries(existing)) {
        if (!listed.has(voice)) delete existing[name];
      }
    }
    const reserved = [narratorVoice, dialogueVoice].filter((v) => typeof v === 'string' && v);
    const usedVoices = new Set([...Object.values(existing), ...reserved]);

    // Characters still without a voice, with what the lorebook says about them.
    const todo = [];
    for (const entry of characters) {
      const name = entry.displayName || entry.keys?.[0] || '';
      if (!name || existing[name]) continue;
      const meta = parseMetadataClient(entry.text);
      todo.push({ name, gender: extractGenderFromEntry(entry.text), description: meta.rest || entry.text, entry });
    }

    // First choice: the lore AI casts each character from their description.
    let reasons = {};
    if (todo.length) {
      showToast(`Casting voices for ${todo.length} character${todo.length !== 1 ? 's' : ''}...`, 2500);
      const res = await window.powertool.ttsSmartAssign(
        todo.map(({ name, gender, description }) => ({ name, gender, description })),
        voices.map((v) => ({ id: v.id, gender: voiceGenderOf(v), pitch: v.pitch || null, tags: v.tags || [] })),
        [...usedVoices].filter((v) => typeof v === 'string'),
      );
      if (res?.error) console.warn('[TTS] AI casting failed, using gender pools:', res.error);
      for (const [name, voice] of Object.entries(res?.assignments || {})) {
        if (existing[name] || usedVoices.has(voice)) continue; // the AI reused a voice
        existing[name] = voice;
        usedVoices.add(voice);
        assigned++;
      }
      reasons = res?.reasons || {};
    }

    // Build gendered voice pools
    const femaleVoices = voices.filter(v => voiceGenderOf(v) === 'female');
    const maleVoices = voices.filter(v => voiceGenderOf(v) === 'male');
    const unknownVoices = voices.filter(v => voiceGenderOf(v) === 'unknown');
    const femaleIdx = { val: 0 };
    const maleIdx = { val: 0 };
    const unknownIdx = { val: 0 };
    const allIdx = { val: 0 };

    // Fallback: anyone the AI did not cast gets the next free voice of their gender.
    for (const { name, gender } of todo) {
      if (existing[name]) continue;
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
    await window.powertool.ttsSetState(state.currentStoryId, ttsState);
    await refreshVoiceMapUI();
    const why = Object.entries(reasons).slice(0, 3).map(([n, r]) => `${n}: ${r}`).join('; ');
    showToast(`Assigned voices to ${assigned} character${assigned !== 1 ? 's' : ''}${why ? ` (${why})` : ''}`, why ? 6000 : 3000);
  } catch (e) {
    console.error('[TTS] Auto-assign error:', e);
    showToast('Auto-assign failed: ' + friendlyApiError(e), 4000, 'error');
  }
}

// The last ~3000 characters, starting at a paragraph or sentence boundary so
// narration never opens mid-sentence.
const NARRATE_TAIL = 3000;
export function narrationTail(text) {
  if (text.length <= NARRATE_TAIL) return text;
  const tail = text.slice(-NARRATE_TAIL);
  const para = tail.indexOf('\n');
  if (para >= 0 && para < 1200) return tail.slice(para + 1);
  const m = /[.!?]["”’)]*\s+/.exec(tail);
  return m && m.index < 1200 ? tail.slice(m.index + m[0].length) : tail;
}

// textOverride: narrate exactly this text (e.g. a whole scene from the timeline).
async function narrateScene(textOverride) {
  if (isNarrating) return;
  isNarrating = true;
  aborted = false;
  ttsNarrateBtn.disabled = true;
  ttsStopBtn.classList.remove('u-hidden');

  try {
    const storyText = typeof textOverride === 'string' ? textOverride : narrationTail((await readStoryTextFromDOM()) || '');
    if (!storyText || storyText.trim().length < 20) {
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
    const { provider, segments } = await window.powertool.ttsPlanScene(
      storyText,
      state.currentStoryId,
      protagonistName
    );

    if (!segments || segments.length === 0) {
      ttsProgress.textContent = 'No audio generated';
      return;
    }

    if (provider === 'chatterbox') {
      const st = await window.powertool.chatterboxStatus();
      if (!st.online) throw new Error(`Chatterbox server is not running (${st.error || 'no answer'})`);
      if (st.model === 'stopped' || st.model === 'loading') {
        ttsProgress.textContent = 'Loading the Chatterbox voice model (first use takes up to a minute)...';
      }
    }

    if (!audioEl) {
      audioEl = document.createElement('audio');
    }

    // Render the next segment while the current one plays. One request in
    // flight at a time, so providers that reject concurrent calls are safe.
    const render = async (seg) => {
      try {
        return await window.powertool.ttsGenerateSpeech(seg.text, seg.voice, state.currentStoryId);
      } catch (firstErr) {
        console.warn('[TTS] Segment retry after error:', firstErr.message);
        await new Promise((r) => setTimeout(r, 1000));
        return window.powertool.ttsGenerateSpeech(seg.text, seg.voice, state.currentStoryId);
      }
    };
    let next = render(segments[0]);
    let failed = 0;
    let firstError = null;
    for (let i = 0; i < segments.length; i++) {
      if (aborted) break;
      const seg = segments[i];
      let audio = null;
      try { audio = await next; } catch (e) {
        failed++;
        firstError = firstError || e;
        console.error('[TTS] Segment failed:', e);
      }
      if (aborted) break;
      next = i + 1 < segments.length ? render(segments[i + 1]) : null;
      next?.catch(() => {}); // awaited on the next pass; avoid an unhandled rejection meanwhile
      if (!audio?.audioData) continue;
      let label;
      if (seg.type === 'narration') label = 'narration';
      else if (seg.isProtagonist) label = 'protagonist';
      else if (seg.speaker) label = `\u201C${seg.speaker}\u201D`;
      else label = 'dialogue (unmatched)';
      ttsProgress.textContent = `Playing ${i + 1}/${segments.length} - ${label}`;
      audioEl.src = audio.audioData;
      await new Promise((resolve, reject) => {
        audioEl.onended = resolve;
        audioEl.onerror = reject;
        audioEl.play().catch(reject);
      });
    }
    if (failed === segments.length) throw firstError || new Error('every segment failed to generate');
    if (failed && !aborted) {
      showToast(`${failed} of ${segments.length} lines could not be spoken: ${friendlyApiError(firstError)}`, 6000, 'warn');
    }
    ttsProgress.textContent = aborted ? 'Stopped' : 'Done';
  } catch (e) {
    if (aborted) { ttsProgress.textContent = 'Stopped'; return; } // Stop clears src, which fires error
    console.error('[TTS] Error:', e);
    const ttsErrMsg = friendlyApiError(e);
    ttsProgress.textContent = 'Error: ' + ttsErrMsg;
    showToast('TTS error: ' + ttsErrMsg, 4000, 'error');
  } finally {
    isNarrating = false;
    ttsNarrateBtn.disabled = false;
    ttsStopBtn.classList.add('u-hidden');
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
  await window.powertool.ttsSetCharacterVoice(state.currentStoryId, name, voice);
  ttsPanelAddName.value = '';
  await refreshVoiceMapUI();
  showToast(`Added ${name}`, 2000);
}

export function init() {
  if (!ttsNarrateBtn) return;
  ttsNarrateBtn.addEventListener('click', () => narrateScene());
  // Other panels (scene timeline) narrate their own text through this player,
  // so it streams line by line and the Stop button works. Resolves when done.
  bus.on('tts:narrate-text', ({ text, done } = {}) => {
    if (isNarrating) { showToast('Narration is already playing - press Stop first', 3000, 'warn'); done?.(false); return; }
    narrateScene(text).finally(() => done?.(true));
  });
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
