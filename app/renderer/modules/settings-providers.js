// settings-providers.js — Provider section visibility, provider-specific load/save

import {
  providerSelect,
  imgWidth, imgHeight,
  perchanceCheckBtn, perchanceKeyDot, perchanceKeyText, perchanceApiUrlInput,
  perchanceArtStyleSelect, perchanceGuidanceSlider, perchanceGuidanceValue,
  veniceKeyDot, veniceKeyText, veniceApiKeyInput, saveVeniceKeyBtn,
  veniceModelSelect, veniceStepsInput, veniceCfgScaleInput,
  veniceStylePresetSelect, veniceSafeModeCheckbox, veniceHideWatermarkCheckbox,
  veniceVideoModelSelect, veniceVideoDurationSelect, veniceVideoResolutionSelect, veniceVideoAspectRatioSelect,
  veniceSettingsBalance, veniceSettingsBalanceText,
  puterModelSelect, puterQualitySelect, puterQualityGroup,
  novelaiTokenDot, novelaiTokenText,
  novelaiEmailInput, novelaiPasswordInput,
} from './dom-refs.js';
import { showToast } from './utils.js';

// Models that support quality setting and their allowed options
const PUTER_QUALITY_MODELS = {
  'gpt-image-1': ['high', 'medium', 'low'],
  'dall-e-3': ['hd', 'standard'],
};

// Show/hide settings sections based on selected provider
export function updateProviderSections() {
  const selected = providerSelect.value;
  document.querySelectorAll('.settings-section[data-provider]').forEach(section => {
    const match = section.dataset.provider === selected;
    section.classList.toggle('provider-visible', match);
  });
  // Clamp resolution max per provider
  const maxDimMap = { perchance: 768, venice: 1280, puter: 1536 };
  const maxDim = maxDimMap[selected] || 1536;
  imgWidth.max = maxDim;
  imgHeight.max = maxDim;
  if (maxDim < 1536) {
    if (parseInt(imgWidth.value) > maxDim) imgWidth.value = maxDim;
    if (parseInt(imgHeight.value) > maxDim) imgHeight.value = maxDim;
  }
}

// --- Venice ---

async function loadVeniceModels() {
  veniceModelSelect.innerHTML = '<option disabled selected>Loading models...</option>';
  veniceModelSelect.classList.add('select-loading');
  try {
    const models = await window.powertool.getVeniceModels();
    veniceModelSelect.innerHTML = '';
    if (models.length === 0) {
      const opt = document.createElement('option');
      opt.value = 'flux-2-max';
      opt.textContent = 'flux-2-max (default)';
      veniceModelSelect.appendChild(opt);
      return;
    }
    for (const model of models) {
      const opt = document.createElement('option');
      opt.value = model.id;
      opt.textContent = model.name;
      veniceModelSelect.appendChild(opt);
    }
  } catch (e) {
    console.error('Failed to load Venice models:', e);
    veniceModelSelect.innerHTML = '<option disabled selected>Failed to load models</option>';
    showToast('Failed to load Venice models', null, 'warn');
  } finally {
    veniceModelSelect.classList.remove('select-loading');
  }
}

let videoModelsData = [];

async function loadVeniceVideoModels() {
  veniceVideoModelSelect.innerHTML = '<option disabled selected>Loading models...</option>';
  try {
    const models = await window.powertool.veniceGetVideoModels();
    videoModelsData = models;
    veniceVideoModelSelect.innerHTML = '<option value="">Select a model</option>';
    for (const model of models) {
      const opt = document.createElement('option');
      opt.value = model.id;
      opt.textContent = model.name;
      veniceVideoModelSelect.appendChild(opt);
    }
  } catch (e) {
    console.error('Failed to load Venice video models:', e);
    videoModelsData = [];
    veniceVideoModelSelect.innerHTML = '<option disabled selected>Failed to load models</option>';
    showToast('Failed to load Venice video models', null, 'warn');
  }
}

const DEFAULT_DURATIONS = ['5s', '10s'];
const DEFAULT_RESOLUTIONS = ['1080p', '720p', '480p'];
const DEFAULT_ASPECT_RATIOS = ['16:9', '9:16', '1:1'];

function populateSelect(selectEl, values, defaultLabel) {
  selectEl.innerHTML = '';
  if (!values || values.length === 0) {
    const opt = document.createElement('option');
    opt.value = '';
    opt.textContent = defaultLabel || 'N/A';
    selectEl.appendChild(opt);
    return;
  }
  for (const val of values) {
    const opt = document.createElement('option');
    opt.value = val;
    opt.textContent = val;
    selectEl.appendChild(opt);
  }
}

function updateVideoConstraints(modelId) {
  const model = videoModelsData.find(m => m.id === modelId);
  const c = model?.constraints || {};
  populateSelect(veniceVideoDurationSelect, c.durations?.length ? c.durations : DEFAULT_DURATIONS, 'Select a model first');
  populateSelect(veniceVideoResolutionSelect, c.resolutions?.length ? c.resolutions : DEFAULT_RESOLUTIONS, 'Select a model first');
  populateSelect(veniceVideoAspectRatioSelect, c.aspect_ratios?.length ? c.aspect_ratios : DEFAULT_ASPECT_RATIOS, 'Select a model first');
}

async function showVeniceSettingsBalance() {
  if (veniceSettingsBalance && veniceSettingsBalanceText) {
    veniceSettingsBalanceText.textContent = 'Loading...';
    veniceSettingsBalance.classList.remove('u-hidden');
  }
  try {
    const balance = await window.powertool.veniceGetBalance();
    if (balance && balance.usd !== null && veniceSettingsBalance && veniceSettingsBalanceText) {
      let text = `Balance: $${balance.usd.toFixed(2)}`;
      if (balance.remainingRequests !== null) {
        text += ` | ${balance.remainingRequests} requests remaining`;
      }
      veniceSettingsBalanceText.textContent = text;
      veniceSettingsBalance.classList.remove('u-hidden');
    } else if (veniceSettingsBalance) {
      veniceSettingsBalance.classList.add('u-hidden');
    }
  } catch { /* ignore */ }
}

async function loadVeniceStyles() {
  try {
    const styles = await window.powertool.getVeniceStyles();
    veniceStylePresetSelect.innerHTML = '<option value="">None</option>';
    for (const style of styles) {
      const opt = document.createElement('option');
      opt.value = style.id;
      opt.textContent = style.name;
      veniceStylePresetSelect.appendChild(opt);
    }
  } catch (e) {
    console.error('Failed to load Venice styles:', e);
  }
}

// --- Puter ---

async function loadPuterModels() {
  puterModelSelect.innerHTML = '<option disabled selected>Loading models...</option>';
  try {
    const models = await window.powertool.getPuterModels();
    puterModelSelect.innerHTML = '';
    // Group models by their group property
    const groups = {};
    for (const model of models) {
      const g = model.group || 'Other';
      if (!groups[g]) groups[g] = [];
      groups[g].push(model);
    }
    for (const [groupName, groupModels] of Object.entries(groups)) {
      const optgroup = document.createElement('optgroup');
      optgroup.label = groupName;
      for (const model of groupModels) {
        const opt = document.createElement('option');
        opt.value = model.id;
        opt.textContent = model.name;
        optgroup.appendChild(opt);
      }
      puterModelSelect.appendChild(optgroup);
    }
  } catch (e) {
    console.error('Failed to load Puter models:', e);
    puterModelSelect.innerHTML = '<option disabled selected>Failed to load models</option>';
    showToast('Failed to load Puter models', null, 'warn');
  }
}

export function updatePuterQualityVisibility() {
  const model = puterModelSelect.value;
  const qualityOpts = PUTER_QUALITY_MODELS[model];
  if (qualityOpts) {
    puterQualityGroup.classList.remove('u-hidden');
    const currentVal = puterQualitySelect.value;
    puterQualitySelect.innerHTML = '';
    for (const q of qualityOpts) {
      const opt = document.createElement('option');
      opt.value = q;
      opt.textContent = q.charAt(0).toUpperCase() + q.slice(1);
      puterQualitySelect.appendChild(opt);
    }
    if (qualityOpts.includes(currentVal)) {
      puterQualitySelect.value = currentVal;
    }
  } else {
    puterQualityGroup.classList.add('u-hidden');
  }
}

/**
 * Paint the Perchance status dot and label from a getPerchanceStatus() result.
 *
 * "Server down" and "server up but no image generator" are different problems
 * with different fixes, so they get different messages rather than one
 * "not ready" - publishing is a one-time manual step the user has to run.
 */
function renderPerchanceStatus(status) {
  if (!status || !status.running) {
    perchanceKeyDot.className = 'dot inactive';
    perchanceKeyText.textContent =
      `Server not reachable at ${status?.url || 'the configured URL'}` +
      `${status?.error ? ` (${status.error})` : ''} — run: perchance-chat serve start`;
    return;
  }
  if (!status.configured) {
    perchanceKeyDot.className = 'dot inactive';
    perchanceKeyText.textContent =
      'Server up, but no image generator published — run: perchance-chat publish --image';
    return;
  }
  perchanceKeyDot.className = 'dot active';
  perchanceKeyText.textContent =
    `Ready${status.generator ? ` (generator ${status.generator})` : ''}` +
    `${status.busy ? ' — busy generating' : ''}`;
}

// --- Load all provider settings into the modal ---

export async function loadProviderSettings(effectiveProvider) {
  const [perchanceStatus, perchanceSettings, veniceSettings, veniceKeyStatus, puterSettings] = await Promise.all([
    window.powertool.getPerchanceStatus(),
    window.powertool.getPerchanceSettings(),
    window.powertool.getVeniceSettings(),
    window.powertool.getVeniceApiKeyStatus(),
    window.powertool.getPuterSettings(),
  ]);

  // Provider
  providerSelect.value = effectiveProvider || 'novelai';
  updateProviderSections();

  // Perchance local API status
  renderPerchanceStatus(perchanceStatus);

  // Perchance settings
  perchanceApiUrlInput.value = perchanceSettings.apiUrl || 'http://127.0.0.1:8730';
  perchanceArtStyleSelect.value = perchanceSettings.artStyle || 'no-style';
  perchanceGuidanceSlider.value = perchanceSettings.guidanceScale || 7;
  perchanceGuidanceValue.textContent = perchanceSettings.guidanceScale || 7;

  // Venice AI settings
  if (veniceKeyStatus.hasKey) {
    veniceKeyDot.className = 'dot active';
    veniceKeyText.textContent = 'API key configured';
  } else {
    veniceKeyDot.className = 'dot inactive';
    veniceKeyText.textContent = 'No API key';
  }
  veniceApiKeyInput.value = '';
  veniceApiKeyInput.placeholder = veniceKeyStatus.hasKey ? 'Key configured (enter new to replace)' : 'Venice AI API key';
  veniceStepsInput.value = veniceSettings.steps || 25;
  veniceCfgScaleInput.value = veniceSettings.cfgScale || 7;
  veniceSafeModeCheckbox.checked = veniceSettings.safeMode || false;
  veniceHideWatermarkCheckbox.checked = veniceSettings.hideWatermark !== false;
  await loadVeniceModels();
  veniceModelSelect.value = veniceSettings.model || 'flux-2-max';
  await loadVeniceStyles();
  veniceStylePresetSelect.value = veniceSettings.stylePreset || '';
  await loadVeniceVideoModels();
  veniceVideoModelSelect.value = veniceSettings.videoModel || '';
  updateVideoConstraints(veniceVideoModelSelect.value);
  veniceVideoDurationSelect.value = veniceSettings.videoDuration || '5s';
  veniceVideoResolutionSelect.value = veniceSettings.videoResolution || '1080p';
  if (veniceSettings.videoAspectRatio) veniceVideoAspectRatioSelect.value = veniceSettings.videoAspectRatio;
  showVeniceSettingsBalance();

  // Puter.js settings
  await loadPuterModels();
  puterModelSelect.value = puterSettings.model || 'dall-e-3';
  puterQualitySelect.value = puterSettings.quality || 'standard';
  updatePuterQualityVisibility();

  // NovelAI token status
  const tokenStatus = await window.powertool.getTokenStatus();
  if (tokenStatus.hasToken) {
    novelaiTokenDot.className = 'dot active';
    novelaiTokenText.textContent = 'Token active (auto-captured from login)';
  } else {
    novelaiTokenDot.className = 'dot inactive';
    novelaiTokenText.textContent = 'No token — log in to NovelAI';
  }

  // NovelAI credentials
  const creds = await window.powertool.getNovelaiCredentials();
  novelaiEmailInput.value = '';
  novelaiPasswordInput.value = '';
  if (creds.hasCredentials) {
    novelaiEmailInput.placeholder = 'Configured (enter new to replace)';
    novelaiPasswordInput.placeholder = 'Configured (enter new to replace)';
  } else {
    novelaiEmailInput.placeholder = 'Email (or set NOVELAI_EMAIL in .env)';
    novelaiPasswordInput.placeholder = 'Password (or set NOVELAI_PASSWORD in .env)';
  }

  // API Token
  const token = await window.powertool.getApiToken();
  document.getElementById('apiToken').value = '';
  document.getElementById('apiToken').placeholder = token ? 'Token configured (enter new to replace)' : 'Enter your persistent API token';
}

// --- Save all provider settings from the modal ---

export async function saveProviderSettings() {
  // Provider
  await window.powertool.setProvider(providerSelect.value);

  // NovelAI credentials
  const email = novelaiEmailInput.value.trim();
  const password = novelaiPasswordInput.value;
  if (email || password) {
    await window.powertool.setNovelaiCredentials({
      ...(email && { email }),
      ...(password && { password }),
    });
  }

  // NovelAI token
  const token = document.getElementById('apiToken').value;
  if (token) {
    await window.powertool.setApiToken(token);
  }

  // Perchance settings
  await window.powertool.setPerchanceSettings({
    artStyle: perchanceArtStyleSelect.value,
    guidanceScale: parseFloat(perchanceGuidanceSlider.value),
    apiUrl: perchanceApiUrlInput.value.trim() || 'http://127.0.0.1:8730',
  });

  // Venice AI settings
  await window.powertool.setVeniceSettings({
    model: veniceModelSelect.value,
    steps: parseInt(veniceStepsInput.value),
    cfgScale: parseFloat(veniceCfgScaleInput.value),
    stylePreset: veniceStylePresetSelect.value,
    safeMode: veniceSafeModeCheckbox.checked,
    hideWatermark: veniceHideWatermarkCheckbox.checked,
    videoModel: veniceVideoModelSelect.value,
    videoDuration: veniceVideoDurationSelect.value,
    videoResolution: veniceVideoResolutionSelect.value,
    videoAspectRatio: veniceVideoAspectRatioSelect.value,
  });

  // Venice API key (only if entered)
  const veniceKey = veniceApiKeyInput.value.trim();
  if (veniceKey) {
    await window.powertool.setVeniceApiKey(veniceKey);
    veniceApiKeyInput.value = '';
  }

  // Puter.js settings
  await window.powertool.setPuterSettings({
    model: puterModelSelect.value,
    quality: puterQualitySelect.value,
  });
}

// --- Init event listeners for provider sections ---

export function initProviderEvents() {
  providerSelect.addEventListener('change', updateProviderSections);
  puterModelSelect.addEventListener('change', updatePuterQualityVisibility);
  veniceVideoModelSelect.addEventListener('change', () => updateVideoConstraints(veniceVideoModelSelect.value));

  // Perchance guidance scale slider
  perchanceGuidanceSlider.addEventListener('input', () => {
    perchanceGuidanceValue.textContent = perchanceGuidanceSlider.value;
  });

  // Perchance local API check
  perchanceCheckBtn.addEventListener('click', async () => {
    perchanceCheckBtn.disabled = true;
    perchanceKeyDot.className = 'dot inactive';
    perchanceKeyText.textContent = 'Checking server...';
    try {
      // Persist the URL first so the probe tests what the field says.
      await window.powertool.setPerchanceSettings({
        apiUrl: perchanceApiUrlInput.value.trim() || 'http://127.0.0.1:8730',
      });
      renderPerchanceStatus(await window.powertool.getPerchanceStatus());
    } catch (e) {
      perchanceKeyDot.className = 'dot inactive';
      perchanceKeyText.textContent = 'Error: ' + e.message;
    } finally {
      perchanceCheckBtn.disabled = false;
    }
  });

  // Venice AI key save
  saveVeniceKeyBtn.addEventListener('click', async () => {
    const key = veniceApiKeyInput.value.trim();
    if (!key) {
      veniceKeyDot.className = 'dot inactive';
      veniceKeyText.textContent = 'Please enter an API key';
      return;
    }
    try {
      const result = await window.powertool.setVeniceApiKey(key);
      if (result.success) {
        veniceKeyDot.className = 'dot active';
        veniceKeyText.textContent = 'API key saved';
        veniceApiKeyInput.value = '';
        await loadVeniceModels();
        await loadVeniceStyles();
      }
    } catch (e) {
      veniceKeyText.textContent = 'Error saving key: ' + e.message;
    }
  });

  // Populate NovelAI art styles on load
  (async function loadNovelaiArtStyles() {
    try {
      const styles = await window.powertool.getNovelaiArtStyles();
      const novelaiArtStyleSelect = document.getElementById('novelaiArtStyle');
      novelaiArtStyleSelect.innerHTML = '';
      for (const style of styles) {
        const opt = document.createElement('option');
        opt.value = style.id;
        opt.textContent = style.name;
        novelaiArtStyleSelect.appendChild(opt);
      }
    } catch (e) {
      console.error('Failed to load NovelAI art styles:', e);
    }
  })();

  // Populate Perchance art styles on load
  (async function loadArtStyles() {
    try {
      const styles = await window.powertool.getPerchanceArtStyles();
      perchanceArtStyleSelect.innerHTML = '';
      for (const style of styles) {
        const opt = document.createElement('option');
        opt.value = style.id;
        opt.textContent = style.name;
        perchanceArtStyleSelect.appendChild(opt);
      }
    } catch (e) {
      console.error('Failed to load art styles:', e);
    }
  })();
}
