// headless-memory-note.js — Memory, Author's Note, and AI Settings panels

import * as refs from './dom-refs.js';
import { state, bus } from './state.js';
import { memoryCall } from './lore-creator.js';
import { showToast } from './utils.js';
import { setupPanelToggle } from './headless-panels.js';

const { webview } = refs;

// --- Memory (Pinned Facts + Narrative) ---

let _pinnedFacts = [];

function _renderPinnedFacts() {
  const list = document.getElementById('memoryPinnedList');
  if (!list) return;
  list.innerHTML = '';
  _pinnedFacts.forEach((fact, i) => {
    const row = document.createElement('div');
    row.className = 'memory-pinned-fact';
    row.innerHTML = `<input type="text" value="${fact.replace(/"/g,'&quot;')}" data-index="${i}"><button class="memory-pinned-remove" data-index="${i}" title="Remove">×</button>`;
    row.querySelector('input').addEventListener('input', (e) => { _pinnedFacts[i] = e.target.value; });
    row.querySelector('.memory-pinned-remove').addEventListener('click', () => {
      _pinnedFacts.splice(i, 1);
      _renderPinnedFacts();
    });
    list.appendChild(row);
  });
}

function _addFact() {
  _pinnedFacts.push('');
  _renderPinnedFacts();
  const inputs = document.getElementById('memoryPinnedList')?.querySelectorAll('input');
  if (inputs?.length) inputs[inputs.length - 1].focus();
}

function _assembleMemory() {
  const narrative = document.getElementById('memoryNarrativeTextarea')?.value || '';
  const facts = _pinnedFacts.filter(f => f.trim());
  const parts = [];
  if (facts.length) parts.push(facts.join('\n'));
  if (narrative.trim()) parts.push(narrative.trim());
  return parts.join('\n\n');
}

function _parseMemory(raw) {
  const sections = raw.split(/\n\n+/);
  if (sections.length <= 1) return { facts: [], narrative: raw };
  const firstSection = sections[0];
  const lines = firstSection.split('\n');
  const allShort = lines.every(l => l.length < 120);
  if (allShort && lines.length <= 10) {
    return { facts: lines.filter(Boolean), narrative: sections.slice(1).join('\n\n') };
  }
  return { facts: [], narrative: raw };
}

export async function loadMemoryToPanel() {
  try {
    const raw = await memoryCall('getMemory') || '';
    const { facts, narrative } = _parseMemory(raw);
    _pinnedFacts = facts;
    _renderPinnedFacts();
    const narrativeEl = document.getElementById('memoryNarrativeTextarea');
    if (narrativeEl) {
      narrativeEl.value = narrative;
      _updateNarrativeCounter();
    }
    _updateContextPreview();
  } catch (e) {
    console.error('[Memory] Load error:', e);
  }
}

export async function saveMemoryFromPanel() {
  try {
    const assembled = _assembleMemory();
    await memoryCall('setMemory', assembled);
    showToast('Memory saved');
    _updateContextPreview();
  } catch (e) {
    console.error('[Memory] Save error:', e);
    showToast('Save failed', 3000, 'error');
  }
}

function _updateNarrativeCounter() {
  const textarea = document.getElementById('memoryNarrativeTextarea');
  const counter = document.getElementById('memoryNarrativeCounter');
  if (textarea && counter) {
    counter.textContent = `${textarea.value.length} chars`;
  }
}

async function _updateContextPreview() {
  try {
    const settings = state.currentStoryId
      ? await window.powertool.storySettingsGet(state.currentStoryId)
      : {};
    const preamble = settings?.preamble || '';
    const pinnedText = _pinnedFacts.filter(f => f.trim()).join('\n');
    const narrative = document.getElementById('memoryNarrativeTextarea')?.value || '';
    const assembled = [preamble, pinnedText, narrative].filter(Boolean).join('\n\n');
    const MODEL_CONTEXT = 8192;
    const preambleTokens = Math.round(preamble.length / 4);
    const pinnedTokens = Math.round(pinnedText.length / 4);
    const narrativeTokens = Math.round(narrative.length / 4);
    const total = preambleTokens + pinnedTokens + narrativeTokens;
    const pct = (t) => Math.min(100, Math.round((t / MODEL_CONTEXT) * 100)) + '%';

    const setPct = (id, width) => {
      const el = document.getElementById(id);
      if (el) el.style.width = width;
    };
    setPct('memoryBudgetPreamble', pct(preambleTokens));
    setPct('memoryBudgetPinned', pct(pinnedTokens));
    setPct('memoryBudgetNarrative', pct(narrativeTokens));

    const legend = document.getElementById('memoryBudgetLegend');
    if (legend) {
      legend.innerHTML = `
        <span>● Preamble: ~${preambleTokens}t</span>
        <span>● Pinned: ~${pinnedTokens}t</span>
        <span>● Narrative: ~${narrativeTokens}t</span>
        <span style="margin-left:auto;color:#aaa">Total: ~${total}/${MODEL_CONTEXT}t</span>
      `;
    }

    const preview = document.getElementById('memoryPreviewText');
    if (preview) preview.textContent = assembled;
  } catch (e) {
    console.warn('[Memory] Preview error:', e);
  }
}

// --- Author's Note ---

async function loadNoteToPanel() {
  try {
    const note = await memoryCall('getAuthorNote');
    if (refs.headlessNoteInput) refs.headlessNoteInput.value = note || '';
  } catch (e) {
    console.error('[HeadlessSync] Failed to load author note:', e);
    if (refs.headlessNoteInput) refs.headlessNoteInput.value = '';
  }
}

async function saveNoteFromPanel() {
  const text = refs.headlessNoteInput?.value || '';
  try {
    await memoryCall('setAuthorNote', text);
    showToast("Author's note saved");
    refs.headlessNotePanel.classList.remove('active');
  } catch (e) {
    console.error('[HeadlessSync] Failed to save author note:', e);
    showToast("Failed to save author's note — proxy may not be loaded");
  }
}

// --- AI Settings ---

let _loadedAiSettings = null;

async function readAiSettingsFromWebview() {
  if (!webview) return null;
  try {
    return await webview.executeJavaScript(`
      (function() {
        function getText(el) {
          if (!el) return '';
          if (typeof el === 'string') return el;
          if (typeof el === 'number') return String(el);
          if (Array.isArray(el)) return el.map(getText).join('');
          if (el.props && el.props.children != null) return getText(el.props.children);
          return '';
        }
        function getFiber(el) {
          if (!el) return null;
          var k = Object.keys(el).find(function(k) { return k.startsWith('__reactFiber') || k.startsWith('__reactInternalInstance'); });
          return k ? el[k] : null;
        }
        function findOptionsInFiber(el) {
          var fiber = getFiber(el);
          for (var i = 0; i < 30 && fiber; i++) {
            if (fiber.memoizedProps && Array.isArray(fiber.memoizedProps.options)) {
              return { options: fiber.memoizedProps.options, onChange: fiber.memoizedProps.onChange || null };
            }
            fiber = fiber.return;
          }
          return null;
        }
        function findLabeledSection(labelText) {
          var divs = document.querySelectorAll('div, span, label');
          for (var i = 0; i < divs.length; i++) {
            var d = divs[i];
            if (d.childNodes.length <= 3 && d.textContent.trim() === labelText) return d;
          }
          return null;
        }
        function findNearbyCombobox(labelEl) {
          var parent = labelEl.parentElement;
          for (var depth = 0; depth < 5 && parent; depth++) {
            var combo = parent.querySelector('[role="combobox"], input[type="text"][aria-autocomplete]');
            if (combo) return combo;
            parent = parent.parentElement;
          }
          return null;
        }
        function findNearbyNumberInput(labelEl) {
          var parent = labelEl.parentElement;
          for (var depth = 0; depth < 5 && parent; depth++) {
            var inp = parent.querySelector('input[type="number"]');
            if (inp) return inp;
            parent = parent.parentElement;
          }
          return null;
        }
        function findCurrentValueText(labelEl) {
          var parent = labelEl.parentElement;
          if (!parent) return null;
          var sibs = parent.children;
          for (var i = 0; i < sibs.length; i++) {
            var t = sibs[i].textContent.trim();
            if (t && t !== labelEl.textContent.trim()) return t;
          }
          return null;
        }

        var result = { models: [], currentModel: '', presets: [], currentPreset: '', temperature: null, outputLength: null };

        // Models
        var modelLabel = findLabeledSection('AI Model');
        if (modelLabel) {
          result.currentModel = findCurrentValueText(modelLabel) || '';
          var combo = findNearbyCombobox(modelLabel);
          if (combo) {
            var data = findOptionsInFiber(combo);
            if (data && data.options) {
              result.models = data.options.map(function(o) { return { value: o.value, label: getText(o.label) || o.value }; });
            }
          }
        }

        // Presets
        var presetLabel = findLabeledSection('Config Preset');
        if (presetLabel) {
          result.currentPreset = findCurrentValueText(presetLabel) || '';
          var pCombo = findNearbyCombobox(presetLabel);
          if (pCombo) {
            var pData = findOptionsInFiber(pCombo);
            if (pData && pData.options) {
              result.presets = pData.options.map(function(o) { return { value: o.value, label: getText(o.label) || o.value }; });
            }
          }
        }

        // Temperature (labeled "Randomness" in NovelAI)
        var tempLabel = findLabeledSection('Randomness');
        if (tempLabel) {
          var tempInput = findNearbyNumberInput(tempLabel);
          if (tempInput) result.temperature = parseFloat(tempInput.value);
        }

        // Output Length
        var lenLabel = findLabeledSection('Output Length');
        if (lenLabel) {
          var lenInput = findNearbyNumberInput(lenLabel);
          if (lenInput) result.outputLength = parseInt(lenInput.value, 10);
        }

        // Stop Sequences
        result.stopSequences = null;
        try {
          var stopLabels = document.querySelectorAll('label, [class*="Label"]');
          for (var si = 0; si < stopLabels.length; si++) {
            if (/stop sequence/i.test(stopLabels[si].textContent)) {
              var stopInput = stopLabels[si].closest('[class*="Field"], [class*="Row"], div')
                ?.querySelector('input[type="text"], textarea');
              if (stopInput) { result.stopSequences = stopInput.value; break; }
            }
          }
        } catch(e) {}

        return result;
      })()
    `);
  } catch (e) {
    console.error('[HeadlessSync] Failed to read AI settings from webview:', e);
    return null;
  }
}

function populateSelect(selectEl, options, currentLabel) {
  if (!selectEl) return;
  selectEl.innerHTML = '';
  if (!options || options.length === 0) {
    const opt = document.createElement('option');
    opt.value = '';
    opt.textContent = 'No options found';
    selectEl.appendChild(opt);
    return;
  }
  let selectedIdx = 0;
  options.forEach((o, i) => {
    const opt = document.createElement('option');
    opt.value = o.value;
    opt.textContent = o.label;
    selectEl.appendChild(opt);
    if (currentLabel && o.label === currentLabel) selectedIdx = i;
  });
  selectEl.selectedIndex = selectedIdx;
}

async function loadAiSettingsToPanel() {
  const data = await readAiSettingsFromWebview();
  if (!data) {
    showToast('Could not read AI settings — Story tab may not be visible in webview');
    return;
  }

  _loadedAiSettings = {
    model: null,
    preset: null,
    temperature: data.temperature,
    outputLength: data.outputLength
  };

  // Populate model select
  populateSelect(refs.headlessModelSelect, data.models, data.currentModel);
  if (refs.headlessModelSelect && refs.headlessModelSelect.selectedOptions[0]) {
    _loadedAiSettings.model = refs.headlessModelSelect.selectedOptions[0].value;
  }

  // Populate preset select
  populateSelect(refs.headlessPresetSelect, data.presets, data.currentPreset);
  if (refs.headlessPresetSelect && refs.headlessPresetSelect.selectedOptions[0]) {
    _loadedAiSettings.preset = refs.headlessPresetSelect.selectedOptions[0].value;
  }

  // Set temperature slider
  if (data.temperature != null && refs.headlessTempSlider) {
    refs.headlessTempSlider.value = data.temperature;
    if (refs.headlessTempValue) refs.headlessTempValue.textContent = data.temperature;
  }

  // Set output length slider
  if (data.outputLength != null && refs.headlessLengthSlider) {
    refs.headlessLengthSlider.value = data.outputLength;
    if (refs.headlessLengthValue) refs.headlessLengthValue.textContent = data.outputLength;
  }

  // Set stop sequences
  if (data.stopSequences != null && refs.headlessStopInput) {
    refs.headlessStopInput.value = data.stopSequences;
  }

  console.log('[HeadlessSync] AI settings loaded from webview:', {
    model: data.currentModel, preset: data.currentPreset,
    temp: data.temperature, len: data.outputLength,
    modelCount: data.models.length, presetCount: data.presets.length
  });
}

async function saveAiSettingsFromPanel() {
  if (!webview) {
    showToast('Webview not available');
    return;
  }

  const newModel = refs.headlessModelSelect?.value || '';
  const newPreset = refs.headlessPresetSelect?.value || '';
  const newTemp = refs.headlessTempSlider ? parseFloat(refs.headlessTempSlider.value) : null;
  const newLen = refs.headlessLengthSlider ? parseInt(refs.headlessLengthSlider.value, 10) : null;

  const changes = [];

  // Write model change via React fiber onChange
  if (newModel && _loadedAiSettings && newModel !== _loadedAiSettings.model) {
    try {
      const ok = await webview.executeJavaScript(`
        (function() {
          var labels = document.querySelectorAll('div, span');
          var labelEl = null;
          for (var i = 0; i < labels.length; i++) {
            if (labels[i].childNodes.length <= 3 && labels[i].textContent.trim() === 'AI Model') { labelEl = labels[i]; break; }
          }
          if (!labelEl) return false;
          var parent = labelEl.parentElement;
          var combo = null;
          for (var d = 0; d < 5 && parent; d++) {
            combo = parent.querySelector('[role="combobox"], input[type="text"][aria-autocomplete]');
            if (combo) break;
            parent = parent.parentElement;
          }
          if (!combo) return false;
          var k = Object.keys(combo).find(function(k) { return k.startsWith('__reactFiber') || k.startsWith('__reactInternalInstance'); });
          if (!k) return false;
          var fiber = combo[k];
          for (var i = 0; i < 30 && fiber; i++) {
            if (fiber.memoizedProps && typeof fiber.memoizedProps.onChange === 'function') {
              var opts = fiber.memoizedProps.options;
              if (opts) {
                var match = opts.find(function(o) { return o.value === ${JSON.stringify(newModel)}; });
                if (match) {
                  fiber.memoizedProps.onChange(match);
                  return true;
                }
              }
              fiber.memoizedProps.onChange({ value: ${JSON.stringify(newModel)} });
              return true;
            }
            fiber = fiber.return;
          }
          return false;
        })()
      `);
      if (ok) changes.push('model');
    } catch (e) {
      console.error('[HeadlessSync] Failed to set model:', e);
    }
  }

  // Write preset change via React fiber onChange
  if (newPreset && _loadedAiSettings && newPreset !== _loadedAiSettings.preset) {
    try {
      const ok = await webview.executeJavaScript(`
        (function() {
          var labels = document.querySelectorAll('div, span');
          var labelEl = null;
          for (var i = 0; i < labels.length; i++) {
            if (labels[i].childNodes.length <= 3 && labels[i].textContent.trim() === 'Config Preset') { labelEl = labels[i]; break; }
          }
          if (!labelEl) return false;
          var parent = labelEl.parentElement;
          var combo = null;
          for (var d = 0; d < 5 && parent; d++) {
            combo = parent.querySelector('[role="combobox"], input[type="text"][aria-autocomplete]');
            if (combo) break;
            parent = parent.parentElement;
          }
          if (!combo) return false;
          var k = Object.keys(combo).find(function(k) { return k.startsWith('__reactFiber') || k.startsWith('__reactInternalInstance'); });
          if (!k) return false;
          var fiber = combo[k];
          for (var i = 0; i < 30 && fiber; i++) {
            if (fiber.memoizedProps && typeof fiber.memoizedProps.onChange === 'function') {
              var opts = fiber.memoizedProps.options;
              if (opts) {
                var match = opts.find(function(o) { return o.value === ${JSON.stringify(newPreset)}; });
                if (match) {
                  fiber.memoizedProps.onChange(match);
                  return true;
                }
              }
              fiber.memoizedProps.onChange({ value: ${JSON.stringify(newPreset)} });
              return true;
            }
            fiber = fiber.return;
          }
          return false;
        })()
      `);
      if (ok) changes.push('preset');
    } catch (e) {
      console.error('[HeadlessSync] Failed to set preset:', e);
    }
  }

  // Write temperature
  if (newTemp != null && _loadedAiSettings && newTemp !== _loadedAiSettings.temperature) {
    try {
      const tempOk = await webview.executeJavaScript(`
        (function() {
          var labels = document.querySelectorAll('div, span');
          for (var i = 0; i < labels.length; i++) {
            if (labels[i].childNodes.length <= 3 && labels[i].textContent.trim() === 'Randomness') {
              var parent = labels[i].parentElement;
              for (var d = 0; d < 5 && parent; d++) {
                var inp = parent.querySelector('input[type="number"]');
                if (inp) {
                  var setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set;
                  setter.call(inp, ${JSON.stringify(String(newTemp))});
                  inp.dispatchEvent(new Event('input', { bubbles: true }));
                  inp.dispatchEvent(new Event('change', { bubbles: true }));
                  return true;
                }
                parent = parent.parentElement;
              }
            }
          }
          return false;
        })()
      `);
      if (tempOk) changes.push('temperature');
    } catch (e) {
      console.error('[HeadlessSync] Failed to set temperature:', e);
    }
  }

  // Write output length
  if (newLen != null && _loadedAiSettings && newLen !== _loadedAiSettings.outputLength) {
    try {
      const lenOk = await webview.executeJavaScript(`
        (function() {
          var labels = document.querySelectorAll('div, span');
          for (var i = 0; i < labels.length; i++) {
            if (labels[i].childNodes.length <= 3 && labels[i].textContent.trim() === 'Output Length') {
              var parent = labels[i].parentElement;
              for (var d = 0; d < 5 && parent; d++) {
                var inp = parent.querySelector('input[type="number"]');
                if (inp) {
                  var setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set;
                  setter.call(inp, ${JSON.stringify(String(newLen))});
                  inp.dispatchEvent(new Event('input', { bubbles: true }));
                  inp.dispatchEvent(new Event('change', { bubbles: true }));
                  return true;
                }
                parent = parent.parentElement;
              }
            }
          }
          return false;
        })()
      `);
      if (lenOk) changes.push('output length');
    } catch (e) {
      console.error('[HeadlessSync] Failed to set output length:', e);
    }
  }

  // Write Stop Sequences
  if (refs.headlessStopInput) {
    const stopValue = refs.headlessStopInput.value;
    try {
      await webview.executeJavaScript(`
        (function() {
          var labels = document.querySelectorAll('label, [class*="Label"]');
          for (var i = 0; i < labels.length; i++) {
            if (/stop sequence/i.test(labels[i].textContent)) {
              var input = labels[i].closest('[class*="Field"], [class*="Row"], div')
                ?.querySelector('input[type="text"], textarea');
              if (input) {
                var proto = input.tagName === 'TEXTAREA' ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype;
                var setter = Object.getOwnPropertyDescriptor(proto, 'value').set;
                setter.call(input, ${JSON.stringify(stopValue)});
                input.dispatchEvent(new Event('input', { bubbles: true }));
                input.dispatchEvent(new Event('change', { bubbles: true }));
                return true;
              }
            }
          }
          return false;
        })()
      `);
    } catch (e) {
      console.warn('[HeadlessSync] Could not set stop sequences:', e);
    }
  }

  if (changes.length > 0) {
    if (changes.includes('model')) _loadedAiSettings.model = newModel;
    if (changes.includes('preset')) _loadedAiSettings.preset = newPreset;
    if (changes.includes('temperature')) _loadedAiSettings.temperature = newTemp;
    if (changes.includes('output length')) _loadedAiSettings.outputLength = newLen;
    showToast('AI settings applied: ' + changes.join(', '));
  } else {
    showToast('No AI settings changed');
  }
  refs.headlessAiSettingsPanel.classList.remove('active');
}

// --- Init ---

export function init({ saveCustomizationToStore, flattenEditorText }) {
  setupPanelToggle(refs.editorMemoryBtn, refs.headlessMemoryPanel, loadMemoryToPanel);
  setupPanelToggle(refs.editorNoteBtn, refs.headlessNotePanel, loadNoteToPanel);
  setupPanelToggle(refs.editorSettingsBtn, refs.headlessAiSettingsPanel, loadAiSettingsToPanel);

  // Memory panel new wiring
  const addFactBtn = document.getElementById('memoryAddFactBtn');
  if (addFactBtn) addFactBtn.addEventListener('click', _addFact);

  const narrativeEl = document.getElementById('memoryNarrativeTextarea');
  if (narrativeEl) narrativeEl.addEventListener('input', () => {
    _updateNarrativeCounter();
    _updateContextPreview();
  });

  const memorySaveBtn = document.getElementById('memorySaveBtn');
  if (memorySaveBtn) memorySaveBtn.addEventListener('click', saveMemoryFromPanel);

  const summariseBtn = document.getElementById('memorySummariseBtn');
  if (summariseBtn) summariseBtn.addEventListener('click', async () => {
    const storyText = refs.storyEditor?.innerText?.slice(-4000) || '';
    if (!storyText.trim()) { showToast('No story text to summarise', 2000); return; }
    summariseBtn.textContent = 'Summarising…';
    summariseBtn.disabled = true;
    try {
      const result = await window.powertool.textAction('summarise-memory', storyText, state.currentStoryId);
      if (result.output && narrativeEl) {
        narrativeEl.value = result.output;
        _updateNarrativeCounter();
        showToast('Summary generated — edit before saving');
      }
    } catch (e) {
      showToast('Summarise failed', 3000, 'error');
    } finally {
      summariseBtn.textContent = 'Summarise…';
      summariseBtn.disabled = false;
    }
  });

  // Auto-save memory before generation
  bus.on('headless:before-generation', saveMemoryFromPanel);

  if (refs.headlessNoteSaveBtn) {
    refs.headlessNoteSaveBtn.addEventListener('click', () => saveNoteFromPanel());
  }
  if (refs.headlessAiSaveBtn) {
    refs.headlessAiSaveBtn.addEventListener('click', () => {
      saveAiSettingsFromPanel();
      if (saveCustomizationToStore) saveCustomizationToStore();
    });
  }
  if (refs.headlessAiFlattenBtn) {
    refs.headlessAiFlattenBtn.addEventListener('click', () => {
      if (confirm('Are you sure you want to remove ALL formatting from the editor? This cannot be undone.')) {
        if (flattenEditorText) flattenEditorText();
      }
    });
  }

  // Slider feedback for AI settings panel
  if (refs.headlessTempSlider) {
    refs.headlessTempSlider.addEventListener('input', () => {
      if (refs.headlessTempValue) refs.headlessTempValue.textContent = refs.headlessTempSlider.value;
    });
  }
  if (refs.headlessLengthSlider) {
    refs.headlessLengthSlider.addEventListener('input', () => {
      if (refs.headlessLengthValue) refs.headlessLengthValue.textContent = refs.headlessLengthSlider.value;
    });
  }
  if (refs.headlessRepSlider) {
    refs.headlessRepSlider.addEventListener('input', () => {
      if (refs.headlessRepValue) refs.headlessRepValue.textContent = refs.headlessRepSlider.value;
    });
  }
  if (refs.headlessRepRangeSlider) {
    refs.headlessRepRangeSlider.addEventListener('input', () => {
      if (refs.headlessRepRangeValue) refs.headlessRepRangeValue.textContent = refs.headlessRepRangeSlider.value;
    });
  }

  // Refresh AI settings when switching stories
  bus.on('story:changed', () => {
    _loadedAiSettings = null;
    if (refs.headlessAiSettingsPanel?.classList.contains('active')) {
      loadAiSettingsToPanel();
    }
  });
}
