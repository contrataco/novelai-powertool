// headless-memory-note.js — Memory, Author's Note, and AI Settings panels

import * as refs from './dom-refs.js';
import { bus } from './state.js';
import { memoryCall } from './lore-creator.js';
import { showToast } from './utils.js';
import { setupPanelToggle } from './headless-panels.js';

const { webview } = refs;

// --- Memory ---

async function loadMemoryToPanel() {
  try {
    const memory = await memoryCall('getMemory');
    if (refs.headlessMemoryInput) refs.headlessMemoryInput.value = memory || '';
  } catch (e) {
    console.error('[HeadlessSync] Failed to load memory:', e);
    if (refs.headlessMemoryInput) refs.headlessMemoryInput.value = '';
  }
}

async function saveMemoryFromPanel() {
  const text = refs.headlessMemoryInput?.value || '';
  try {
    await memoryCall('setMemory', text);
    showToast('Memory saved');
    refs.headlessMemoryPanel.classList.remove('active');
  } catch (e) {
    console.error('[HeadlessSync] Failed to save memory:', e);
    showToast('Failed to save memory — proxy may not be loaded');
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

  if (refs.headlessMemorySaveBtn) {
    refs.headlessMemorySaveBtn.addEventListener('click', () => saveMemoryFromPanel());
  }
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
