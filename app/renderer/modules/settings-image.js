// settings-image.js — Model, resolution, art style, V3-specific options, scene settings, text LLM

import {
  modelSelect, resolutionPreset, imgWidth, imgHeight,
  samplerSelect, stepsInput, scaleInput,
  smeaCheckbox, smeaDynCheckbox,
  qualityTagsCheckbox, v3Options,
  novelaiArtStyleSelect, providerSelect,
  sceneAutoGenerate, sceneUseCharacterLore, sceneArtStyleTags,
  sceneMinTextChange, sceneMinTextChangeValue,
  scenePromptTemperature, scenePromptTemperatureValue,
  sceneSuggestionStyle, sceneSuggestionTemperature, sceneSuggestionTemperatureValue,
  sceneEnableLitrpg,
  scenePipelineVersion, sceneSecondaryLlm,
  textLlmOpenaiKey, textLlmOpenaiModel, textLlmAnthropicKey, textLlmAnthropicModel,
  textLlmOllamaModelSelect,
  autoGeneratePortraitsCheckbox, portraitProviderSelect, portraitProviderCostWarning,
  RESOLUTION_PRESETS, V4_MODELS,
} from './dom-refs.js';
import { state } from './state.js';

// Update V3 options visibility based on model
function updateV3Options() {
  const isV4 = V4_MODELS.includes(modelSelect.value);
  v3Options.classList.toggle('disabled', isV4);
  if (isV4) {
    smeaCheckbox.checked = false;
    smeaDynCheckbox.checked = false;
  }
}

// --- Load image/scene settings into the modal ---

export async function loadImageSettings(effectiveSettings, effectiveArtStyle, effectiveSceneSettings) {
  // NovelAI art style
  novelaiArtStyleSelect.value = effectiveArtStyle || 'no-style';

  // Scene settings
  sceneAutoGenerate.checked = effectiveSceneSettings.autoGeneratePrompts !== false;
  interfaceShowWebview.checked = effectiveSceneSettings.headlessMode !== undefined 
    ? !effectiveSceneSettings.headlessMode 
    : !!effectiveSceneSettings.showWebview;
  sceneUseCharacterLore.checked = effectiveSceneSettings.useCharacterLore !== false;
  sceneArtStyleTags.value = effectiveSceneSettings.artStyleTags || '';
  sceneMinTextChange.value = effectiveSceneSettings.minTextChange || 50;
  sceneMinTextChangeValue.textContent = effectiveSceneSettings.minTextChange || 50;
  scenePromptTemperature.value = effectiveSceneSettings.promptTemperature || 0.7;
  scenePromptTemperatureValue.textContent = effectiveSceneSettings.promptTemperature || 0.7;
  sceneSuggestionStyle.value = effectiveSceneSettings.suggestionStyle || 'mixed';
  sceneSuggestionTemperature.value = effectiveSceneSettings.suggestionTemperature || 0.6;
  sceneSuggestionTemperatureValue.textContent = effectiveSceneSettings.suggestionTemperature || 0.6;
  sceneEnableLitrpg.checked = !!(state.litrpgState && state.litrpgState.enabled);

  // Text LLM / Pipeline settings (wrapped — must not abort settings open on failure)
  try {
    const textLlmSettings = await window.powertool.textLlmGetSettings();
    scenePipelineVersion.value = String(textLlmSettings.pipelineVersion || 1);
    sceneSecondaryLlm.value = textLlmSettings.secondaryLlm || 'none';
    textLlmOpenaiKey.value = '';
    textLlmOpenaiKey.placeholder = textLlmSettings.openaiApiKey ? 'Key configured (enter new to replace)' : 'sk-...';
    textLlmOpenaiModel.value = textLlmSettings.openaiModel || 'gpt-4o-mini';
    textLlmAnthropicKey.value = '';
    textLlmAnthropicKey.placeholder = textLlmSettings.anthropicApiKey ? 'Key configured (enter new to replace)' : 'sk-ant-...';
    textLlmAnthropicModel.value = textLlmSettings.anthropicModel || 'claude-sonnet-4-20250514';
    // Load Ollama models
    const ollamaResult = await window.powertool.textLlmListOllamaModels();
    textLlmOllamaModelSelect.innerHTML = '';
    if (ollamaResult.success && ollamaResult.models.length > 0) {
      for (const m of ollamaResult.models) {
        const opt = document.createElement('option');
        opt.value = m.id;
        opt.textContent = m.name;
        textLlmOllamaModelSelect.appendChild(opt);
      }
      // Select current model from lore LLM provider settings (authoritative source)
      const loreLlm = await window.powertool.loreGetLlmProvider();
      if (loreLlm.ollamaModel) textLlmOllamaModelSelect.value = loreLlm.ollamaModel;
    } else {
      const opt = document.createElement('option');
      opt.value = '';
      opt.textContent = ollamaResult.success ? 'No models found' : 'Ollama not available';
      textLlmOllamaModelSelect.appendChild(opt);
    }
  } catch (e) {
    console.error('[Settings] Text LLM load error:', e);
  }

  // Model
  modelSelect.value = effectiveSettings.model || 'nai-diffusion-4-curated-preview';

  // Resolution
  imgWidth.value = effectiveSettings.width || 832;
  imgHeight.value = effectiveSettings.height || 1216;

  // Find matching preset
  const matchingPreset = Object.entries(RESOLUTION_PRESETS).find(
    ([, p]) => p.width === effectiveSettings.width && p.height === effectiveSettings.height
  );
  resolutionPreset.value = matchingPreset ? matchingPreset[0] : 'custom';

  // Generation parameters
  samplerSelect.value = effectiveSettings.sampler || 'k_euler_ancestral';
  stepsInput.value = effectiveSettings.steps || 28;
  scaleInput.value = effectiveSettings.scale || 6;

  // V3 options (SMEA)
  smeaCheckbox.checked = effectiveSettings.smea || false;
  smeaDynCheckbox.checked = effectiveSettings.smeaDyn || false;

  // Quality options
  qualityTagsCheckbox.checked = effectiveSettings.qualityTags !== false; // Default true

  // Update V3 options visibility
  updateV3Options();

  // Portrait settings
  try {
    const portraitSettings = await window.powertool.getSettings?.() || {};
    if (autoGeneratePortraitsCheckbox) {
      autoGeneratePortraitsCheckbox.checked = portraitSettings.autoGeneratePortraits !== false;
    }
    if (portraitProviderSelect) {
      portraitProviderSelect.value = portraitSettings.portraitProvider || 'novelai';
      if (portraitProviderCostWarning) {
        portraitProviderCostWarning.classList.toggle('u-hidden', !(portraitProviderSelect.value !== 'novelai'));
      }
    }
  } catch (e) {
    console.error('[Settings] Portrait settings load error:', e);
  }
}

// --- Save image/scene settings from the modal ---

export async function saveImageSettings() {
  // Text LLM / Pipeline settings (wrapped — must not abort settings save on failure)
  try {
    const textLlmPayload = {
      pipelineVersion: parseInt(scenePipelineVersion.value),
      secondaryLlm: sceneSecondaryLlm.value,
      openaiModel: textLlmOpenaiModel.value.trim() || 'gpt-4o-mini',
      anthropicModel: textLlmAnthropicModel.value.trim() || 'claude-sonnet-4-20250514',
    };
    const openaiKey = textLlmOpenaiKey.value.trim();
    if (openaiKey) textLlmPayload.openaiApiKey = openaiKey;
    const anthropicKey = textLlmAnthropicKey.value.trim();
    if (anthropicKey) textLlmPayload.anthropicApiKey = anthropicKey;
    await window.powertool.textLlmSetSettings(textLlmPayload);
    // Update Ollama model via lore LLM provider (authoritative store key)
    if (textLlmOllamaModelSelect.value) {
      await window.powertool.loreSetLlmProvider({ ollamaModel: textLlmOllamaModelSelect.value });
    }
  } catch (e) {
    console.error('[Settings] Text LLM save error:', e);
  }

  // Scene settings
  await window.powertool.setSceneSettings({
    autoGeneratePrompts: sceneAutoGenerate.checked,
    showWebview: interfaceShowWebview.checked,
    headlessMode: !interfaceShowWebview.checked,
    useCharacterLore: sceneUseCharacterLore.checked,
    artStyleTags: sceneArtStyleTags.value.trim(),
    minTextChange: parseInt(sceneMinTextChange.value),
    promptTemperature: parseFloat(scenePromptTemperature.value),
    suggestionStyle: sceneSuggestionStyle.value,
    suggestionTemperature: parseFloat(sceneSuggestionTemperature.value),
  });

  // NovelAI art style
  await window.powertool.setNovelaiArtStyle(novelaiArtStyleSelect.value);

  // Image settings
  await window.powertool.setImageSettings({
    model: modelSelect.value,
    width: parseInt(imgWidth.value),
    height: parseInt(imgHeight.value),
    sampler: samplerSelect.value,
    noiseSchedule: 'native',
    steps: parseInt(stepsInput.value),
    scale: parseFloat(scaleInput.value),
    cfgRescale: 0,
    smea: smeaCheckbox.checked,
    smeaDyn: smeaDynCheckbox.checked,
    ucPreset: 'heavy',
    qualityTags: qualityTagsCheckbox.checked
  });

  // Portrait settings
  if (autoGeneratePortraitsCheckbox) {
    await window.powertool.setSetting?.('autoGeneratePortraits', autoGeneratePortraitsCheckbox.checked);
  }
  if (portraitProviderSelect) {
    await window.powertool.setSetting?.('portraitProvider', portraitProviderSelect.value);
  }
}

// --- Build per-story image/scene settings object ---

export function buildPerStoryImageSettings() {
  return {
    imageProvider: providerSelect.value,
    imageSettings: {
      model: modelSelect.value,
      width: parseInt(imgWidth.value),
      height: parseInt(imgHeight.value),
      sampler: samplerSelect.value,
      noiseSchedule: 'native',
      steps: parseInt(stepsInput.value),
      scale: parseFloat(scaleInput.value),
      cfgRescale: 0,
      smea: smeaCheckbox.checked,
      smeaDyn: smeaDynCheckbox.checked,
      ucPreset: 'heavy',
      qualityTags: qualityTagsCheckbox.checked,
    },
    novelaiArtStyle: novelaiArtStyleSelect.value,
    sceneSettings: {
      autoGeneratePrompts: sceneAutoGenerate.checked,
      useCharacterLore: sceneUseCharacterLore.checked,
      artStyleTags: sceneArtStyleTags.value.trim(),
      minTextChange: parseInt(sceneMinTextChange.value),
      promptTemperature: parseFloat(scenePromptTemperature.value),
      suggestionStyle: sceneSuggestionStyle.value,
      suggestionTemperature: parseFloat(sceneSuggestionTemperature.value),
    },
  };
}

// --- Init event listeners for image/scene settings ---

export function initImageEvents() {
  // Scene settings sliders
  sceneMinTextChange.addEventListener('input', () => {
    sceneMinTextChangeValue.textContent = sceneMinTextChange.value;
  });
  scenePromptTemperature.addEventListener('input', () => {
    scenePromptTemperatureValue.textContent = scenePromptTemperature.value;
  });
  sceneSuggestionTemperature.addEventListener('input', () => {
    sceneSuggestionTemperatureValue.textContent = sceneSuggestionTemperature.value;
  });

  // Handle resolution preset change
  resolutionPreset.addEventListener('change', () => {
    const preset = RESOLUTION_PRESETS[resolutionPreset.value];
    if (preset) {
      imgWidth.value = preset.width;
      imgHeight.value = preset.height;
    }
  });

  // Handle width/height manual change -> switch to custom
  imgWidth.addEventListener('change', () => {
    const matchingPreset = Object.entries(RESOLUTION_PRESETS).find(
      ([, p]) => p.width === parseInt(imgWidth.value) && p.height === parseInt(imgHeight.value)
    );
    resolutionPreset.value = matchingPreset ? matchingPreset[0] : 'custom';
  });

  imgHeight.addEventListener('change', () => {
    const matchingPreset = Object.entries(RESOLUTION_PRESETS).find(
      ([, p]) => p.width === parseInt(imgWidth.value) && p.height === parseInt(imgHeight.value)
    );
    resolutionPreset.value = matchingPreset ? matchingPreset[0] : 'custom';
  });

  // Handle model change
  modelSelect.addEventListener('change', updateV3Options);

  // Portrait provider cost warning
  if (portraitProviderSelect && portraitProviderCostWarning) {
    portraitProviderSelect.addEventListener('change', () => {
      portraitProviderCostWarning.classList.toggle('u-hidden', !(portraitProviderSelect.value !== 'novelai'));
    });
  }
}
