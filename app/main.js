const { app, BrowserWindow, ipcMain, session, globalShortcut, webContents } = require('electron');
const path = require('path');
const fs = require('fs');
const Store = require('electron-store');

// Suppress EPIPE errors on stdout/stderr (parent pipe may close in dev mode)
process.stdout?.on('error', () => {});
process.stderr?.on('error', () => {});

// Providers
const novelaiProvider = require('./providers/novelai');
const perchanceProvider = require('./providers/perchance');
const veniceProvider = require('./providers/venice');
const puterProvider = require('./providers/puter');
const openaiTextProvider = require('./providers/openai-text');
const anthropicTextProvider = require('./providers/anthropic-text');
const { extractPerchanceKey, verifyPerchanceKey } = require('./perchance-key');
const storyboard = require('./storyboard');
const loreCreator = require('./lore-creator');
const scenePromptPipeline = require('./scene-prompt-pipeline');
const loreComprehension = require('./lore-comprehension');
const memoryManager = require('./memory-manager');
const litrpgTracker = require('./litrpg-tracker');
const { extractTransientFields } = require('./litrpg-tracker');
const lorebookOptimizer = require('./lorebook-optimizer');
const portraitManager = require('./portrait-manager');
const mediaGallery = require('./media-gallery');
const db = require('./db');

const PROVIDERS = {
  [novelaiProvider.id]: novelaiProvider,
  [perchanceProvider.id]: perchanceProvider,
  [veniceProvider.id]: veniceProvider,
  [puterProvider.id]: puterProvider,
};

// Text-only LLM providers (for lore, comprehension, scene analysis, etc.)
const TEXT_PROVIDERS = {
  novelai: { id: 'novelai', name: 'NovelAI (GLM-4-6)' },
  ollama: { id: 'ollama', name: 'Ollama (Local)' },
  openai: { id: 'openai', name: 'OpenAI', provider: openaiTextProvider },
  anthropic: { id: 'anthropic', name: 'Anthropic', provider: anthropicTextProvider },
};

// Secure storage for API token and settings
const store = new Store({
  encryptionKey: 'novelai-scene-visualizer-key',
  schema: {
    apiToken: { type: 'string', default: '' },
    novelaiEmail: { type: 'string', default: '' },
    novelaiPassword: { type: 'string', default: '' },
    provider: { type: 'string', default: 'novelai' },
    perchanceUserKey: { type: 'string', default: '' },
    novelaiArtStyle: { type: 'string', default: 'no-style' },
    perchanceArtStyle: { type: 'string', default: 'no-style' },
    perchanceGuidanceScale: { type: 'number', default: 7 },
    perchanceKeyAcquiredAt: { type: 'number', default: 0 },
    veniceApiKey: { type: 'string', default: '' },
    veniceModel: { type: 'string', default: 'flux-2-max' },
    veniceSteps: { type: 'number', default: 25 },
    veniceCfgScale: { type: 'number', default: 7 },
    veniceStylePreset: { type: 'string', default: '' },
    veniceSafeMode: { type: 'boolean', default: false },
    veniceHideWatermark: { type: 'boolean', default: true },
    veniceVideoModel: { type: 'string', default: '' },
    veniceVideoDuration: { type: 'string', default: '5s' },
    veniceVideoResolution: { type: 'string', default: '720p' },
    imageSettings: {
      type: 'object',
      default: {
        // Model selection
        model: 'nai-diffusion-4-5-full',
        // Dimensions
        width: 832,
        height: 1216,
        // Generation params
        steps: 28,
        scale: 5,
        sampler: 'k_euler',
        noiseSchedule: 'native',
        // SMEA (only for V3 models)
        smea: false,
        smeaDyn: false,
        // Quality
        cfgRescale: 0,
        qualityTags: true,
        // UC Preset
        ucPreset: 'heavy'
      }
    },
    loreSettings: {
      type: 'object',
      default: loreCreator.DEFAULT_SETTINGS
    },
    loreState: {
      type: 'object',
      default: {}
    },
    loreLlmProvider: { type: 'string', default: 'novelai' },
    loreOllamaModel: { type: 'string', default: 'mistral:7b' },
    loreOllamaUrl: { type: 'string', default: 'http://localhost:11434' },
    loreComprehension: { type: 'object', default: {} },
    memorySettings: { type: 'object', default: {} },
    memoryState: { type: 'object', default: {} },
    ttsProvider: { type: 'string', default: 'novelai' },
    ttsNarratorVoice: { type: 'string', default: 'Cyllene' },
    ttsDialogueVoice: { type: 'string', default: 'Alseid' },
    ttsSpeed: { type: 'number', default: 1.0 },
    ttsFirstPerson: { type: 'boolean', default: false },
  }
});

function getOllamaUrl() {
  return (store.get('loreOllamaUrl') || 'http://localhost:11434').replace('localhost', '127.0.0.1');
}

function getActiveProvider() {
  const id = store.get('provider') || 'novelai';
  return PROVIDERS[id] || PROVIDERS.novelai;
}

// Enforce single instance — prevent data corruption from concurrent store access
const gotTheLock = app.requestSingleInstanceLock();
if (!gotTheLock) {
  console.log('[Main] Another instance is already running — quitting');
  app.quit();
}

let mainWindow;

app.on('second-instance', () => {
  if (mainWindow) {
    if (mainWindow.isMinimized()) mainWindow.restore();
    mainWindow.focus();
  }
});

function createWindow() {
  mainWindow = new BrowserWindow({
    width: 1400,
    height: 900,
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      nodeIntegration: false,
      contextIsolation: true,
      webviewTag: true
    },
    title: 'NovelAI Scene Visualizer'
  });

  // Load the wrapper HTML that contains the webview
  mainWindow.loadFile('renderer/index.html');

  // Inject webview preload for bridge communication
  mainWindow.webContents.on('will-attach-webview', (event, webPreferences, params) => {
    webPreferences.preload = path.join(__dirname, 'webview-preload.js');
  });

  // Open DevTools in development
  if (process.argv.includes('--enable-logging')) {
    mainWindow.webContents.openDevTools();
  }
}

// Token auto-extraction from NovelAI webview session
function setupTokenInterception() {
  const novelaiSession = session.fromPartition('persist:novelai');

  novelaiSession.webRequest.onBeforeSendHeaders(
    { urls: ['*://api.novelai.net/*', '*://*.novelai.net/api/*'] },
    (details, callback) => {
      const authHeader = details.requestHeaders['Authorization'] ||
                          details.requestHeaders['authorization'];
      if (authHeader && authHeader.startsWith('Bearer ')) {
        const token = authHeader.substring(7);
        if (token !== store.get('apiToken')) {
          store.set('apiToken', token);
          console.log('[Main] NovelAI token auto-captured from webview session');
          if (mainWindow && !mainWindow.isDestroyed()) {
            mainWindow.webContents.send('token-status-changed', { hasToken: true });
          }
        }
      }
      callback({ cancel: false, requestHeaders: details.requestHeaders });
    }
  );
}

// Token status query
ipcMain.handle('get-token-status', () => ({ hasToken: !!store.get('apiToken') }));

// Open webview DevTools for DOM inspection
ipcMain.handle('open-webview-devtools', () => {
  const allContents = webContents.getAllWebContents();
  const wv = allContents.find(wc => wc.getURL().includes('novelai.net'));
  if (wv) {
    wv.openDevTools({ mode: 'detach' });
    console.log('[Main] Opened webview DevTools');
    return { success: true };
  }
  console.log('[Main] No NovelAI webview found');
  return { success: false, error: 'No NovelAI webview found' };
});

// Clear webview cache (NovelAI partition)
ipcMain.handle('clear-webview-cache', async () => {
  const novelaiSession = session.fromPartition('persist:novelai');
  await novelaiSession.clearCache();
  await novelaiSession.clearStorageData({ storages: ['cachestorage', 'serviceworkers'] });
  console.log('[Main] Webview cache cleared');
  return { success: true };
});

// (CDP lorebook proxy removed — Script API sandbox is not a real JS execution
// context, so Runtime.evaluate cannot reach globalThis.__loreCreator.)

// Load .env file (simple parser, no dependency)
function loadEnvCredentials() {
  const envPath = path.join(__dirname, '.env');
  try {
    if (!fs.existsSync(envPath)) return {};
    const content = fs.readFileSync(envPath, 'utf-8');
    const vars = {};
    for (const line of content.split('\n')) {
      const trimmed = line.trim();
      if (!trimmed || trimmed.startsWith('#')) continue;
      const eqIdx = trimmed.indexOf('=');
      if (eqIdx === -1) continue;
      const key = trimmed.substring(0, eqIdx).trim();
      const val = trimmed.substring(eqIdx + 1).trim();
      vars[key] = val;
    }
    return vars;
  } catch (e) {
    console.log('[Main] Could not read .env:', e.message);
    return {};
  }
}

// Seed Venice API key from .env if store is empty
(function seedVeniceKey() {
  if (!store.get('veniceApiKey')) {
    const env = loadEnvCredentials();
    if (env.VENICE_API_KEY) {
      store.set('veniceApiKey', env.VENICE_API_KEY);
      console.log('[Main] Venice API key loaded from .env');
    }
  }
})();

// Get NovelAI credentials (.env primary, store fallback)
ipcMain.handle('get-novelai-credentials', () => {
  const env = loadEnvCredentials();
  const email = env.NOVELAI_EMAIL || store.get('novelaiEmail') || '';
  const password = env.NOVELAI_PASSWORD || store.get('novelaiPassword') || '';
  return { email, password, hasCredentials: !!(email && password) };
});

// Save NovelAI credentials to store
ipcMain.handle('set-novelai-credentials', (event, { email, password }) => {
  if (email !== undefined) store.set('novelaiEmail', email);
  if (password !== undefined) store.set('novelaiPassword', password);
  return { success: true };
});

// ---------------------------------------------------------------------------
// Blank image detection
// ---------------------------------------------------------------------------

/**
 * Detect if a data URI represents a blank/black image (common when content is
 * silently filtered by providers). Uses two heuristics:
 * 1. Size — real images at 512px+ are typically 100KB+; all-black PNGs compress
 *    to ~2-5KB.
 * 2. Byte variance — sample ~200 bytes spread across the image data; if fewer
 *    than 4 distinct values appear, the image is likely uniform/blank.
 * Returns true only if both checks agree.
 */
function isBlankImage(dataUri) {
  try {
    const base64 = dataUri.replace(/^data:image\/[^;]+;base64,/, '');
    const buf = Buffer.from(base64, 'base64');

    // Size check: suspicious if < 15KB
    const isTiny = buf.length < 15 * 1024;

    // Byte variance check: sample ~200 bytes evenly, skip 100-byte header
    const sampleCount = 200;
    const start = Math.min(100, Math.floor(buf.length * 0.1));
    const range = buf.length - start;
    if (range <= 0) return isTiny; // degenerate case

    const step = Math.max(1, Math.floor(range / sampleCount));
    const seen = new Set();
    for (let i = start; i < buf.length && seen.size < 10; i += step) {
      seen.add(buf[i]);
    }
    const isUniform = seen.size < 4;

    return isTiny && isUniform;
  } catch {
    return false;
  }
}

// ---------------------------------------------------------------------------
// Content restriction error detection
// ---------------------------------------------------------------------------

const CONTENT_RESTRICTION_KEYWORDS = [
  'content_policy', 'content policy', 'nsfw', 'restricted', 'safety',
  'moderation', 'blocked', 'inappropriate', 'not allowed', 'violat',
];

function isContentRestrictionError(errorMessage) {
  if (!errorMessage) return false;
  const lower = errorMessage.toLowerCase();
  return CONTENT_RESTRICTION_KEYWORDS.some(kw => lower.includes(kw));
}

// ---------------------------------------------------------------------------
// Model fallback helper (Venice only)
// ---------------------------------------------------------------------------

async function tryModelFallback(provider, providerId, prompt, negativePrompt, genOpts = {}) {
  // NovelAI model fallback via provider's fallback chain
  if (providerId === 'novelai' && typeof provider.getModelFallbackOrder === 'function') {
    const settings = store.get('imageSettings');
    const currentModel = settings.model || 'nai-diffusion-4-5-full';
    const fallbacks = provider.getModelFallbackOrder(currentModel);

    for (const fallbackModel of fallbacks) {
      console.log(`[Main] NovelAI fallback: trying ${fallbackModel} (was: ${currentModel})`);
      store.set('imageSettings', { ...settings, model: fallbackModel });
      try {
        const imageData = await provider.generate(prompt, negativePrompt, store, genOpts);
        if (!isBlankImage(imageData)) {
          return { imageData, fallbackModel };
        }
        console.log(`[Main] Fallback ${fallbackModel} returned blank image`);
      } catch (e) {
        console.log(`[Main] Fallback ${fallbackModel} failed: ${e.message}`);
      } finally {
        store.set('imageSettings', settings);
      }
    }
    return null;
  }

  // Venice model fallback
  const modelStoreKey = { venice: 'veniceModel' }[providerId];
  if (!modelStoreKey) return null;

  const currentModel = store.get(modelStoreKey);

  // Use cached models; if cache is empty, fetch fresh list
  let models = provider.getModels();
  if (!models || models.length === 0) {
    try {
      models = await provider.fetchModelsForUI(store);
    } catch {
      return null;
    }
  }
  if (!models || models.length < 2) return null;

  const fallback = models.find(m => m.id !== currentModel);
  if (!fallback) return null;

  console.log(`[Main] Trying fallback model: ${fallback.id} (was: ${currentModel})`);

  store.set(modelStoreKey, fallback.id);
  try {
    const imageData = await provider.generate(prompt, negativePrompt, store, genOpts);
    if (!isBlankImage(imageData)) {
      return { imageData, fallbackModel: fallback.id };
    }
    console.log('[Main] Fallback model also returned blank image');
  } catch (e) {
    console.log(`[Main] Fallback model failed: ${e.message}`);
  } finally {
    store.set(modelStoreKey, currentModel);
  }

  return null;
}

// ---------------------------------------------------------------------------
// IPC Handlers — Image generation (with retry + model fallback)
// ---------------------------------------------------------------------------

// IPC Handler — Get the prompt suffix (art style + quality tags) that the provider would append
ipcMain.handle('get-prompt-suffix', () => {
  const provider = getActiveProvider();
  if (provider.getPromptSuffix) {
    return provider.getPromptSuffix(store);
  }
  return { artStyleSuffix: '', qualitySuffix: '', combined: '' };
});

ipcMain.handle('get-negative-prompt-suffix', () => {
  const provider = getActiveProvider();
  if (provider.getNegativeSuffix) {
    return provider.getNegativeSuffix(store);
  }
  return { styleNegative: '', ucPresetNegative: '', combined: '' };
});

ipcMain.handle('generate-image', async (event, { prompt, negativePrompt, rawPrompt, rawNegativePrompt, storyId, baseCaption, charCaptions }) => {
  // Apply per-story settings temporarily for this generation
  const ss = storyId ? db.getStorySettings(storyId) : null;
  const savedStoreValues = {};
  if (ss) {
    const overrides = {
      provider: ss.imageProvider,
      imageSettings: ss.imageSettings,
      novelaiArtStyle: ss.novelaiArtStyle,
    };
    for (const [k, v] of Object.entries(overrides)) {
      if (v !== undefined) { savedStoreValues[k] = store.get(k); store.set(k, v); }
    }
  }
  const restoreStore = () => {
    for (const [k, v] of Object.entries(savedStoreValues)) store.set(k, v);
  };

  try {
  const provider = getActiveProvider();
  const providerId = store.get('provider') || 'novelai';
  const settings = store.get('imageSettings');

  const makeMeta = (extra = {}) => ({
    provider: providerId,
    model: settings.model || '',
    resolution: { width: settings.width || 832, height: settings.height || 1216 },
    ...extra,
  });

  // Broadcast Venice balance after generation (if Venice is active)
  const broadcastVeniceBalance = () => {
    if (providerId === 'venice' && mainWindow && !mainWindow.isDestroyed()) {
      const balance = veniceProvider.getBalance();
      if (balance) mainWindow.webContents.send('venice:balance-update', balance);
    }
  };

  const genOpts = {
    ...(rawPrompt ? { rawPrompt: true } : {}),
    ...(rawNegativePrompt ? { rawNegativePrompt: true } : {}),
    ...(baseCaption ? { baseCaption } : {}),
    ...(charCaptions?.length ? { charCaptions } : {}),
  };

  // Auto-save generated image to character albums (fire-and-forget)
  const autoSaveToCharacterAlbums = (imageData) => {
    if (!storyId || !charCaptions?.length) return;
    try {
      const rpgState = db.getLitrpgState(storyId);
      if (!rpgState?.characters) return;
      const charNames = charCaptions.map(c => c._name).filter(Boolean);
      if (charNames.length === 0) return;

      // Decode image data URL to buffer
      const base64Match = imageData.match(/^data:image\/\w+;base64,(.+)$/);
      if (!base64Match) return;
      const buffer = Buffer.from(base64Match[1], 'base64');

      // Match each pipeline character name to LitRPG characters via fuzzy match
      for (const name of charNames) {
        for (const [charId, char] of Object.entries(rpgState.characters)) {
          const nameScore = loreCreator.fuzzyNameScore(name, char.name);
          const aliasScore = (char.aliases || []).reduce((best, a) =>
            Math.max(best, loreCreator.fuzzyNameScore(name, a)), 0);
          if (Math.max(nameScore, aliasScore) >= 0.7) {
            portraitManager.saveToAlbum(storyId, charId, buffer);
            console.log(`[Main] Auto-saved scene image to album for ${char.name} (${charId})`);
            break; // one match per pipeline name
          }
        }
      }
    } catch (err) {
      console.warn('[Main] Auto-save to character albums failed:', err.message);
    }
  };

  let lastError = null;

  // --- Attempt 1: normal generation ---
  try {
    console.log(`[Main] Generating via ${provider.name}...${rawPrompt ? ' (raw prompt, no suffix)' : ''}`);
    const imageData = await provider.generate(prompt, negativePrompt, store, genOpts);
    if (!isBlankImage(imageData)) {
      broadcastVeniceBalance();
      autoSaveToCharacterAlbums(imageData);
      return { success: true, imageData, meta: makeMeta() };
    }
    console.log('[Main] Blank image detected, retrying with new seed...');
  } catch (e) {
    lastError = e;
    console.error('[Main] Generation attempt 1 failed:', e.message);
    broadcastVeniceBalance();
    if (isContentRestrictionError(e.message)) {
      const fb = await tryModelFallback(provider, providerId, prompt, negativePrompt, genOpts);
      if (fb) {
        broadcastVeniceBalance();
        autoSaveToCharacterAlbums(fb.imageData);
        return {
          success: true,
          imageData: fb.imageData,
          meta: makeMeta({ retried: true, fallbackModel: fb.fallbackModel }),
        };
      }
      return { success: false, error: e.message, contentRestricted: true };
    }
  }

  // --- Attempt 2: retry (blank image or transient error) ---
  try {
    const imageData = await provider.generate(prompt, negativePrompt, store, genOpts);
    if (!isBlankImage(imageData)) {
      broadcastVeniceBalance();
      autoSaveToCharacterAlbums(imageData);
      return { success: true, imageData, meta: makeMeta({ retried: true }) };
    }
    console.log('[Main] Blank image on retry, trying model fallback...');
  } catch (e) {
    lastError = e;
    console.error('[Main] Generation attempt 2 failed:', e.message);
    broadcastVeniceBalance();
    if (isContentRestrictionError(e.message)) {
      const fb = await tryModelFallback(provider, providerId, prompt, negativePrompt, genOpts);
      if (fb) {
        broadcastVeniceBalance();
        autoSaveToCharacterAlbums(fb.imageData);
        return {
          success: true,
          imageData: fb.imageData,
          meta: makeMeta({ retried: true, fallbackModel: fb.fallbackModel }),
        };
      }
      return { success: false, error: e.message, contentRestricted: true };
    }
  }

  // --- Attempt 3: model fallback ---
  const fb = await tryModelFallback(provider, providerId, prompt, negativePrompt, genOpts);
  if (fb) {
    broadcastVeniceBalance();
    autoSaveToCharacterAlbums(fb.imageData);
    return {
      success: true,
      imageData: fb.imageData,
      meta: makeMeta({ retried: true, fallbackModel: fb.fallbackModel }),
    };
  }

  // --- All attempts exhausted ---
  broadcastVeniceBalance();
  return {
    success: false,
    error: lastError?.message || 'Image generation failed (blank image detected)',
    blankDetected: !lastError,
  };
  } finally {
    restoreStore();
  }
});

// IPC Handlers — Models (delegates to active provider)
ipcMain.handle('get-models', () => {
  return getActiveProvider().getModels();
});

// IPC Handlers — Provider management
ipcMain.handle('get-provider', () => {
  return store.get('provider') || 'novelai';
});

ipcMain.handle('set-provider', (event, providerId) => {
  if (!PROVIDERS[providerId]) {
    return { success: false, error: `Unknown provider: ${providerId}` };
  }
  store.set('provider', providerId);
  return { success: true };
});

ipcMain.handle('get-providers', () => {
  return Object.values(PROVIDERS).map(p => ({ id: p.id, name: p.name }));
});

// IPC Handlers — Perchance key extraction
ipcMain.handle('extract-perchance-key', async () => {
  try {
    const key = await extractPerchanceKey(store);
    return { success: !!key, hasKey: !!key };
  } catch (error) {
    console.error('[Main] Perchance key extraction failed:', error);
    return { success: false, error: error.message };
  }
});

ipcMain.handle('get-perchance-key-status', async () => {
  const key = store.get('perchanceUserKey');
  if (!key) return { hasKey: false, preview: '' };
  const status = await verifyPerchanceKey(key);
  if (status === 'not_verified') {
    // Only clear on definitive "not_verified" from the API (not CF blocks)
    store.set('perchanceUserKey', '');
    store.set('perchanceKeyAcquiredAt', 0);
    return { hasKey: false, preview: '', expired: true };
  }
  // 'valid' or 'unknown' (CF blocked) — keep the key
  return { hasKey: true, preview: key.substring(0, 10) + '...' };
});

ipcMain.handle('set-perchance-key', (event, key) => {
  store.set('perchanceUserKey', key);
  store.set('perchanceKeyAcquiredAt', Date.now());
  console.log(`[Main] Perchance key set manually: ${key.substring(0, 10)}...`);
  return { success: true };
});

// IPC Handlers — Perchance settings
ipcMain.handle('get-perchance-art-styles', () => {
  return perchanceProvider.getArtStyles();
});

ipcMain.handle('get-perchance-settings', () => {
  return {
    artStyle: store.get('perchanceArtStyle') || 'no-style',
    guidanceScale: store.get('perchanceGuidanceScale') || 7,
  };
});

ipcMain.handle('set-perchance-settings', (event, settings) => {
  if (settings.artStyle !== undefined) store.set('perchanceArtStyle', settings.artStyle);
  if (settings.guidanceScale !== undefined) store.set('perchanceGuidanceScale', settings.guidanceScale);
  return { success: true };
});

// IPC Handlers — NovelAI art styles
ipcMain.handle('get-novelai-art-styles', () => {
  return novelaiProvider.getArtStyles();
});

ipcMain.handle('get-novelai-art-style', (event, storyId) => {
  if (storyId) {
    const ss = db.getStorySettings(storyId);
    if (ss?.novelaiArtStyle) return ss.novelaiArtStyle;
  }
  return store.get('novelaiArtStyle') || 'no-style';
});

ipcMain.handle('set-novelai-art-style', (event, styleId) => {
  store.set('novelaiArtStyle', styleId);
  return { success: true };
});

// IPC Handlers — Venice AI
ipcMain.handle('get-venice-settings', () => {
  return {
    model: store.get('veniceModel') || 'flux-2-max',
    steps: store.get('veniceSteps') || 25,
    cfgScale: store.get('veniceCfgScale') || 7,
    stylePreset: store.get('veniceStylePreset') || '',
    safeMode: store.get('veniceSafeMode') || false,
    hideWatermark: store.get('veniceHideWatermark') !== false,
    videoModel: store.get('veniceVideoModel') || '',
    videoDuration: store.get('veniceVideoDuration') || '5s',
    videoResolution: store.get('veniceVideoResolution') || '720p',
  };
});

ipcMain.handle('set-venice-settings', (event, settings) => {
  if (settings.model !== undefined) store.set('veniceModel', settings.model);
  if (settings.steps !== undefined) store.set('veniceSteps', settings.steps);
  if (settings.cfgScale !== undefined) store.set('veniceCfgScale', settings.cfgScale);
  if (settings.stylePreset !== undefined) store.set('veniceStylePreset', settings.stylePreset);
  if (settings.safeMode !== undefined) store.set('veniceSafeMode', settings.safeMode);
  if (settings.hideWatermark !== undefined) store.set('veniceHideWatermark', settings.hideWatermark);
  if (settings.videoModel !== undefined) store.set('veniceVideoModel', settings.videoModel);
  if (settings.videoDuration !== undefined) store.set('veniceVideoDuration', settings.videoDuration);
  if (settings.videoResolution !== undefined) store.set('veniceVideoResolution', settings.videoResolution);
  return { success: true };
});

ipcMain.handle('set-venice-api-key', (event, key) => {
  store.set('veniceApiKey', key);
  console.log('[Main] Venice API key set');
  return { success: true };
});

ipcMain.handle('get-venice-api-key-status', () => {
  return { hasKey: !!store.get('veniceApiKey') };
});

ipcMain.handle('get-venice-models', async () => {
  return veniceProvider.fetchModelsForUI(store);
});

ipcMain.handle('get-venice-styles', async () => {
  return veniceProvider.fetchStylesForUI(store);
});

// Venice balance
ipcMain.handle('venice:get-balance', () => {
  return veniceProvider.getBalance();
});

// Venice video
ipcMain.handle('venice:get-video-models', async () => {
  return veniceProvider.fetchVideoModelsForUI(store);
});

ipcMain.handle('venice:quote-video', async (event, { prompt, opts }) => {
  return veniceProvider.quoteVideo(prompt, store, opts || {});
});

ipcMain.handle('venice:queue-video', async (event, { prompt, imageData, opts }) => {
  const result = await veniceProvider.queueVideo(prompt, imageData, store, opts || {});
  // Broadcast updated balance after queueing
  if (mainWindow && !mainWindow.isDestroyed()) {
    const balance = veniceProvider.getBalance();
    if (balance) mainWindow.webContents.send('venice:balance-update', balance);
  }
  return result;
});

ipcMain.handle('venice:retrieve-video', async (event, { queueId, model }) => {
  return veniceProvider.retrieveVideo(queueId, model, store);
});

// IPC Handlers — Puter.js
ipcMain.handle('get-puter-settings', () => {
  return {
    model: store.get('puterModel') || 'dall-e-3',
    quality: store.get('puterQuality') || 'standard',
  };
});

ipcMain.handle('set-puter-settings', (event, settings) => {
  if (settings.model !== undefined) store.set('puterModel', settings.model);
  if (settings.quality !== undefined) store.set('puterQuality', settings.quality);
  return { success: true };
});

ipcMain.handle('get-puter-models', () => {
  return puterProvider.getModels();
});

// ---------------------------------------------------------------------------
// TTS — Text-to-Speech
// ---------------------------------------------------------------------------

const FIRST_PERSON_VERBS = /\bI\s+(?:said|replied|whispered|shouted|muttered|spoke|asked|answered|called|yelled|cried|exclaimed|declared|announced|mentioned|added|continued|began|started|finished)\b/i;

// Speaker attribution patterns for TTS character voice mapping
const SPEECH_VERBS = '(?:said|replied|whispered|shouted|muttered|spoke|asked|answered|called|yelled|cried|exclaimed|declared|announced|mentioned|added|continued|began|started|finished|growled|hissed|purred|sighed|murmured|snapped|demanded|pleaded|insisted|warned|laughed|chuckled|groaned)';
// Name pattern: supports O'Brien, Jean-Pierre, d'Artagnan-style names
const NAME_PATTERN = "([A-Z][a-z]+(?:['-][A-Z]?[a-z]+)*(?:\\s+[A-Z][a-z]+(?:['-][A-Z]?[a-z]+)*){0,2})";
// "..." said CharName  (verb before name)
const AFTER_VERB_NAME = new RegExp(`^\\s*,?\\s*${SPEECH_VERBS}\\s+${NAME_PATTERN}`, 'i');
// "..." CharName said   (name before verb)
const AFTER_NAME_VERB = new RegExp(`^\\s*,?\\s*${NAME_PATTERN}\\s+${SPEECH_VERBS}`, 'i');
// CharName said, "..."  /  CharName: "..."
const BEFORE_ATTR = new RegExp(`${NAME_PATTERN}\\s+${SPEECH_VERBS}\\s*,?\\s*$|${NAME_PATTERN}\\s*:\\s*$`, 'i');
// Em-dash attribution: "..." — said CharName  or  "..." — CharName said
const AFTER_DASH_VERB = new RegExp(`^\\s*[\u2014—]\\s*${SPEECH_VERBS}\\s+${NAME_PATTERN}`, 'i');
const AFTER_DASH_NAME = new RegExp(`^\\s*[\u2014—]\\s*${NAME_PATTERN}\\s+${SPEECH_VERBS}`, 'i');

/**
 * Parse text into narration vs dialogue segments for TTS voice assignment.
 * @param {string} text
 * @param {boolean} firstPerson - If true, protagonist dialogue uses narrator voice
 * @returns {Array<{type: string, text: string, isProtagonist: boolean}>}
 */
function matchSpeakerToVoice(speaker, characterVoices) {
  if (!speaker || !characterVoices) return null;
  // Exact match first
  if (characterVoices[speaker]) return { name: speaker, voice: characterVoices[speaker] };
  // Fuzzy match against all keys
  const keys = Object.keys(characterVoices);
  let bestScore = 0, bestKey = null;
  for (const key of keys) {
    const score = loreCreator.fuzzyNameScore(speaker, key);
    if (score > bestScore) { bestScore = score; bestKey = key; }
  }
  if (bestScore >= 0.7 && bestKey) return { name: bestKey, voice: characterVoices[bestKey] };
  return null;
}

function extractSpeaker(text, matchIndex, matchEnd, characterVoices) {
  const afterText = text.slice(matchEnd, matchEnd + 80);

  // Check after: "..." said CharName  (verb-name order)
  const afterVN = AFTER_VERB_NAME.exec(afterText);
  if (afterVN && afterVN[1]) return afterVN[1].trim();

  // Check after: "..." CharName said  (name-verb order)
  const afterNV = AFTER_NAME_VERB.exec(afterText);
  if (afterNV && afterNV[1]) return afterNV[1].trim();

  // Check after em-dash: "..." — said CharName
  const afterDV = AFTER_DASH_VERB.exec(afterText);
  if (afterDV && afterDV[1]) return afterDV[1].trim();

  // Check after em-dash: "..." — CharName said
  const afterDN = AFTER_DASH_NAME.exec(afterText);
  if (afterDN && afterDN[1]) return afterDN[1].trim();

  // Check before: CharName said, "..."  or  CharName: "..."
  const beforeStart = Math.max(0, matchIndex - 80);
  const beforeText = text.slice(beforeStart, matchIndex);
  const beforeMatch = BEFORE_ATTR.exec(beforeText);
  if (beforeMatch) {
    const name = (beforeMatch[1] || beforeMatch[2] || '').trim();
    if (name) return name;
  }

  // Action-based attribution: preceding sentence contains a known character name
  // Handles: Varian slammed his fist. "How dare you!"
  if (characterVoices && Object.keys(characterVoices).length > 0) {
    const lookbackText = text.slice(Math.max(0, matchIndex - 200), matchIndex);
    const lastSentenceEnd = Math.max(lookbackText.lastIndexOf('.'), lookbackText.lastIndexOf('!'), lookbackText.lastIndexOf('?'));
    if (lastSentenceEnd >= 0) {
      const sentence = lookbackText.slice(lastSentenceEnd + 1).toLowerCase().trim();
      if (sentence.length > 0 && sentence.length < 150) {
        for (const charName of Object.keys(characterVoices)) {
          if (sentence.includes(charName.toLowerCase())) return charName;
          const words = charName.split(/\s+/).filter(w => w.length >= 3);
          for (const word of words) {
            if (sentence.includes(word.toLowerCase())) return charName;
          }
        }
      }
    }
  }

  // Fallback: search nearby text for any known character name from voice map
  if (characterVoices && Object.keys(characterVoices).length > 0) {
    const nearby = text.slice(Math.max(0, matchIndex - 100), matchEnd + 100).toLowerCase();
    for (const charName of Object.keys(characterVoices)) {
      // Check each word of multi-word names (≥3 chars) and full name
      if (nearby.includes(charName.toLowerCase())) return charName;
      const words = charName.split(/\s+/).filter(w => w.length >= 3);
      for (const word of words) {
        if (nearby.includes(word.toLowerCase())) return charName;
      }
    }
  }

  return null;
}

function parseTextForTTS(text, firstPerson, characterVoices, protagonistName) {
  const segments = [];
  // Match quoted dialogue: double quotes (straight + curly), curly single quotes with word boundaries
  // Excludes straight single quotes to avoid false positives from contractions/possessives
  const regex = /[\u201C\u201F""]([^"\u201C\u201D\u201F""]+)[\u201D""]|(?<!\w)\u2018([^\u2019]+)\u2019(?!\w)/g;
  let lastIndex = 0;
  let match;
  let lastSpeaker = null;

  while ((match = regex.exec(text)) !== null) {
    // Add narration before this dialogue
    const hasNarrationGap = match.index > lastIndex;
    if (hasNarrationGap) {
      const narration = text.slice(lastIndex, match.index).trim();
      if (narration) {
        segments.push({ type: 'narration', text: narration, speaker: null, isProtagonist: false });
        lastSpeaker = null; // Reset on narration gap
      }
    }

    const dialogue = match[1] || match[2];
    let isProtagonist = false;
    let speaker = null;

    if (firstPerson) {
      const lookback = text.slice(Math.max(0, match.index - 80), match.index);
      if (FIRST_PERSON_VERBS.test(lookback)) {
        isProtagonist = true;
      }
    }

    if (!isProtagonist) {
      speaker = extractSpeaker(text, match.index, regex.lastIndex, characterVoices);
    }

    // Consecutive dialogue inheritance: if no speaker found and no narration gap, inherit last speaker
    if (!isProtagonist && !speaker && lastSpeaker && !hasNarrationGap) {
      speaker = lastSpeaker;
    }

    if (!isProtagonist && speaker && protagonistName) {
      if (loreCreator.fuzzyNameScore(speaker, protagonistName) >= 0.7) {
        isProtagonist = true;
      }
    }

    // Track last speaker for consecutive dialogue
    if (speaker) lastSpeaker = speaker;

    segments.push({ type: 'dialogue', text: dialogue, speaker, isProtagonist });
    lastIndex = regex.lastIndex;
  }

  // Trailing narration
  if (lastIndex < text.length) {
    const narration = text.slice(lastIndex).trim();
    if (narration) segments.push({ type: 'narration', text: narration, speaker: null, isProtagonist: false });
  }

  // If no dialogue was found, return the whole text as narration
  if (segments.length === 0 && text.trim()) {
    segments.push({ type: 'narration', text: text.trim(), speaker: null, isProtagonist: false });
  }

  return segments;
}

ipcMain.handle('tts:get-settings', () => ({
  ttsProvider: store.get('ttsProvider'),
  ttsNarratorVoice: store.get('ttsNarratorVoice'),
  ttsDialogueVoice: store.get('ttsDialogueVoice'),
  ttsSpeed: store.get('ttsSpeed'),
  ttsFirstPerson: store.get('ttsFirstPerson'),
  ttsVersion: store.get('ttsVersion') || 'auto',
}));

ipcMain.handle('tts:set-settings', (_, settings) => {
  for (const [k, v] of Object.entries(settings)) {
    if (k.startsWith('tts')) store.set(k, v);
  }
  return { success: true };
});

ipcMain.handle('tts:get-voices', () => {
  const provider = store.get('ttsProvider');
  if (provider === 'venice') return veniceProvider.getVoices();
  return novelaiProvider.getVoiceSeeds();
});

ipcMain.handle('tts:generate-speech', async (_, { text, voice, storyId }) => {
  const ss = storyId ? db.getStorySettings(storyId) : null;
  const provider = ss?.ttsProvider || store.get('ttsProvider');
  if (provider === 'venice') return veniceProvider.generateSpeech(text, voice, store);
  // Auto-detect TTS version from voice preset; falls back to stored preference
  return novelaiProvider.generateSpeech(text, voice, store, 'auto');
});

ipcMain.handle('tts:narrate-scene', async (_, { text, storyId, protagonistName }) => {
  const ss = storyId ? db.getStorySettings(storyId) : null;
  const provider = ss?.ttsProvider || store.get('ttsProvider');
  const narratorVoice = ss?.ttsNarratorVoice || store.get('ttsNarratorVoice');
  const dialogueVoice = ss?.ttsDialogueVoice || store.get('ttsDialogueVoice');
  const firstPerson = ss?.ttsFirstPerson ?? store.get('ttsFirstPerson');
  const ttsState = storyId ? db.getTtsState(storyId) : { characterVoices: {} };
  const characterVoices = ttsState.characterVoices || {};
  const segments = parseTextForTTS(text, firstPerson, characterVoices, protagonistName);
  const results = [];

  for (const seg of segments) {
    let voice;
    if (seg.type === 'narration' || seg.isProtagonist) {
      voice = narratorVoice;
    } else if (seg.speaker) {
      const mapped = matchSpeakerToVoice(seg.speaker, characterVoices);
      voice = mapped ? mapped.voice : dialogueVoice;
    } else {
      voice = dialogueVoice;
    }
    const isVenice = provider === 'venice';
    // Auto-detect TTS version from the voice preset
    const audio = isVenice
      ? await veniceProvider.generateSpeech(seg.text, voice, store)
      : await novelaiProvider.generateSpeech(seg.text, voice, store, 'auto');
    results.push({ type: seg.type, text: seg.text, speaker: seg.speaker, isProtagonist: seg.isProtagonist, ...audio });
  }

  return results;
});

ipcMain.handle('tts:get-state', (_, storyId) => db.getTtsState(storyId));

ipcMain.handle('tts:set-state', (_, { storyId, state }) => {
  db.setTtsState(storyId, state);
  return { success: true };
});

ipcMain.handle('tts:set-character-voice', (_, { storyId, characterName, voiceId }) => {
  const state = db.getTtsState(storyId);
  state.characterVoices[characterName] = voiceId;
  db.setTtsState(storyId, state);
  return { success: true };
});

ipcMain.handle('tts:remove-character-voice', (_, { storyId, characterName }) => {
  const state = db.getTtsState(storyId);
  delete state.characterVoices[characterName];
  db.setTtsState(storyId, state);
  return { success: true };
});

// IPC Handlers — API token (unchanged)
ipcMain.handle('get-api-token', () => {
  return store.get('apiToken') ? '***configured***' : '';
});

ipcMain.handle('set-api-token', (event, token) => {
  store.set('apiToken', token);
  return { success: true };
});

// IPC Handlers — Image settings (unchanged)
ipcMain.handle('get-image-settings', () => {
  return store.get('imageSettings');
});

ipcMain.handle('set-image-settings', (event, settings) => {
  store.set('imageSettings', settings);
  return { success: true };
});

// ---------------------------------------------------------------------------
// Per-Story Settings (snapshot-on-first-visit from globals)
// ---------------------------------------------------------------------------

function snapshotGlobalSettings() {
  return {
    ttsProvider: store.get('ttsProvider'),
    ttsNarratorVoice: store.get('ttsNarratorVoice'),
    ttsDialogueVoice: store.get('ttsDialogueVoice'),
    ttsSpeed: store.get('ttsSpeed'),
    ttsFirstPerson: store.get('ttsFirstPerson'),
    imageProvider: store.get('provider') || 'novelai',
    imageSettings: store.get('imageSettings'),
    novelaiArtStyle: store.get('novelaiArtStyle') || 'no-style',
    sceneSettings: store.get('sceneSettings') || {},
  };
}

function getStorySettingsOrSnapshot(storyId) {
  let settings = db.getStorySettings(storyId);
  if (!settings) {
    settings = snapshotGlobalSettings();
    db.setStorySettings(storyId, settings);
  }
  return settings;
}

ipcMain.handle('story-settings:get', (_, storyId) => {
  return getStorySettingsOrSnapshot(storyId);
});

ipcMain.handle('story-settings:set', (_, { storyId, settings }) => {
  db.setStorySettings(storyId, settings);
  return { success: true };
});

// Scene settings (prompt generation, suggestions)
const SCENE_SETTINGS_DEFAULTS = {
  autoGeneratePrompts: true,
  useCharacterLore: true,
  artStyleTags: '',
  minTextChange: 50,
  promptTemperature: 0.7,
  suggestionStyle: 'mixed',
  suggestionTemperature: 0.6,
};

ipcMain.handle('get-scene-settings', () => {
  return { ...SCENE_SETTINGS_DEFAULTS, ...store.get('sceneSettings') };
});

ipcMain.handle('set-scene-settings', (event, settings) => {
  const existing = store.get('sceneSettings') || {};
  store.set('sceneSettings', { ...existing, ...settings });
  return { success: true };
});

// IPC Handler — Electron-side suggestion generation (parallel with script's image prompt)
ipcMain.handle('generate-suggestions-direct', async (event, data) => {
  try {
    // Backward-compat: accept string or {storyText, storyId}
    const storyText = typeof data === 'string' ? data : data.storyText;
    const storyId = typeof data === 'string' ? null : data.storyId;

    // Build narrative context from comprehension + memory
    const narrativeContext = storyId
      ? buildUnifiedContext(storyId, { comprehension: true, memory: true, budget: 2000 })
      : '';
    if (narrativeContext) {
      console.log(`[Main] Suggestions: injecting narrative context (${narrativeContext.length} chars)`);
    }

    const provider = PROVIDERS.novelai;
    const ss2 = storyId ? db.getStorySettings(storyId) : null;
    const sceneSettings = { ...SCENE_SETTINGS_DEFAULTS, ...store.get('sceneSettings'), ...(ss2?.sceneSettings || {}) };
    const narrativeBlock = narrativeContext
      ? `\nNARRATIVE CONTEXT:\n${narrativeContext}\n\nUse established characters, situations, and relationships.`
      : '';

    // Build style instruction based on suggestion style setting
    const styleInstructions = {
      brief: 'Keep ALL suggestions brief: 1-2 sentences each.',
      detailed: 'Make ALL suggestions detailed: 3-5 sentences each with rich description.',
      mixed: 'Vary the format naturally based on what fits the story moment:\n- For action scenes: Brief 1-2 sentence prompts\n- For dialogue moments: A character line with brief context\n- For dramatic beats: Longer 2-4 sentence continuations',
    };

    const messages = [
      {
        role: 'system',
        content: `You are a creative writing assistant helping with interactive fiction. Generate exactly 3 different, compelling story continuation suggestions.

${styleInstructions[sceneSettings.suggestionStyle] || styleInstructions.mixed}

Each suggestion should:
- Feel natural as something the user might type
- Offer a distinct direction (don't repeat the same idea)
- Match the tone and style of the existing story
- Be written from the perspective the story uses (first/second/third person)
${narrativeBlock}
Output ONLY valid JSON in this exact format:
{"suggestions":[{"type":"action","text":"suggestion 1"},{"type":"dialogue","text":"suggestion 2"},{"type":"narrative","text":"suggestion 3"}]}

Types: "action" for physical actions, "dialogue" for speech, "narrative" for description/thought, "mixed" for combinations.`
      },
      {
        role: 'user',
        content: `Based on this story so far, generate 3 distinct continuation suggestions:\n\n---\n${storyText}\n---\n\nRemember: Output ONLY the JSON object, nothing else.`
      }
    ];

    console.log('[Main] Generating suggestions via direct API call...');
    const response = await provider.generateText(messages, {
      model: 'glm-4-6',
      max_tokens: 300,
      temperature: sceneSettings.suggestionTemperature,
    }, store);

    let content = '';
    if (response.output) {
      content = response.output;
    } else if (response.choices && response.choices.length > 0) {
      content = response.choices[0].text || response.choices[0].message?.content || '';
    }

    const jsonMatch = content.match(/\{[\s\S]*\}/);
    if (jsonMatch) {
      let jsonStr = jsonMatch[0];
      try {
        JSON.parse(jsonStr);
      } catch {
        // Fix truncated JSON
        const quoteCount = (jsonStr.match(/"/g) || []).length;
        if (quoteCount % 2 !== 0) jsonStr += '"';
        const openBrackets = (jsonStr.match(/\[/g) || []).length;
        const closeBrackets = (jsonStr.match(/\]/g) || []).length;
        const openBraces = (jsonStr.match(/\{/g) || []).length;
        const closeBraces = (jsonStr.match(/\}/g) || []).length;
        for (let i = 0; i < openBrackets - closeBrackets; i++) jsonStr += ']';
        for (let i = 0; i < openBraces - closeBraces; i++) jsonStr += '}';
      }
      const parsed = JSON.parse(jsonStr);
      if (Array.isArray(parsed.suggestions)) {
        const suggestions = parsed.suggestions
          .map(s => ({ type: s.type || 'mixed', text: typeof s.text === 'string' ? s.text : String(s.text || '') }))
          .filter(s => s.text.length > 0)
          .slice(0, 3);
        console.log(`[Main] Generated ${suggestions.length} suggestions via direct API`);
        return { success: true, suggestions };
      }
    }

    console.log('[Main] Could not parse suggestions from API response');
    return { success: false, error: 'Could not parse response' };
  } catch (e) {
    console.error('[Main] Direct suggestion generation failed:', e.message);
    return { success: false, error: e.message };
  }
});

// IPC Handler — Electron-side scene prompt generation (v1 classic + v2 enhanced pipeline)
ipcMain.handle('generate-scene-prompt', async (event, { storyText, entries, artStyle, storyId }) => {
  try {
    const ss = storyId ? db.getStorySettings(storyId) : null;
    const sceneSettings = { ...SCENE_SETTINGS_DEFAULTS, ...store.get('sceneSettings'), ...(ss?.sceneSettings || {}) };
    const pipelineVersion = sceneSettings.pipelineVersion || 1;

    // Resolve art style (shared by v1 and v2)
    const provider = PROVIDERS.novelai;
    const artStyleId = ss?.novelaiArtStyle || store.get('novelaiArtStyle') || 'no-style';
    const resolvedArtStyle = provider.getArtStyleTags(artStyleId);
    const customTags = sceneSettings.artStyleTags || '';
    const style = (customTags && provider.getArtStyleTags(customTags)) || customTags || resolvedArtStyle || 'anime style, detailed, high quality';

    // Build narrative context (shared)
    const narrativeContext = storyId
      ? buildUnifiedContext(storyId, { comprehension: true, memory: true, budget: 2000 })
      : '';

    // --- V2 Enhanced Pipeline ---
    if (pipelineVersion === 2) {
      console.log('[Main] Using v2 enhanced pipeline');
      const primaryProvider = store.get('loreLlmProvider') || 'novelai';
      const secondaryProvider = sceneSettings.secondaryLlm || 'none';

      const primaryGenFn = makeGenerateTextFn(primaryProvider);
      let secondaryGenFn = null;

      if (secondaryProvider !== 'none' && secondaryProvider !== primaryProvider) {
        secondaryGenFn = makeGenerateTextFn(secondaryProvider);
      }

      // Force sequential if both are novelai (429 guard)
      const forceSequential = primaryProvider === 'novelai' && secondaryProvider === 'novelai';

      // Gather RPG data if available
      let rpgData = null;
      if (storyId) {
        const litrpgState = db.getLitrpgState(storyId);
        if (litrpgState?.enabled && litrpgState?.characters) {
          rpgData = litrpgState;
        }
      }

      // Get stored visual profiles
      const visualProfiles = storyId ? db.getVisualProfiles(storyId) : {};

      const result = await scenePromptPipeline.generateScenePromptV2({
        storyText, entries, storyId,
        primaryGenerateTextFn: primaryGenFn,
        secondaryGenerateTextFn: secondaryGenFn,
        narrativeContext, rpgData, visualProfiles,
        forceSequential,
      });

      // Persist updated visual profiles
      if (result.success && result.updatedProfiles && storyId) {
        for (const [charName, profile] of Object.entries(result.updatedProfiles)) {
          db.setVisualProfile(storyId, charName, profile);
        }
      }

      // If v2 failed completely, fall through to v1
      if (!result.success) {
        console.warn('[Main] v2 pipeline failed, falling back to v1:', result.error);
      } else {
        return result;
      }
    }

    // --- V1 Classic Pipeline ---
    console.log('[Main] Using v1 classic pipeline');

    // 1. Extract character appearances from lorebook entries (skip if disabled)
    const appearancePatterns = [
      /appearance[:\s]+([^.]+(?:\.[^.]+){0,3})/i,
      /physical(?:\s+description)?[:\s]+([^.]+(?:\.[^.]+){0,3})/i,
      /looks?\s+like[:\s]+([^.]+(?:\.[^.]+){0,2})/i,
      /(?:has|with)\s+([\w\s,]+(?:hair|eyes|skin|build|height)[^.]*)/i,
      /description[:\s]+([^.]+(?:\.[^.]+){0,3})/i,
    ];
    const visualKeywords = ['hair', 'eyes', 'tall', 'short', 'wears', 'wearing', 'dressed', 'skin', 'face', 'build'];
    const characters = [];

    if (sceneSettings.useCharacterLore) {
      for (const entry of (entries || [])) {
        if (entry.enabled === false) continue;
        const text = entry.text || '';
        const displayName = entry.displayName || '';
        const keys = entry.keys || [];
        let appearance = '';

        for (const pattern of appearancePatterns) {
          const match = text.match(pattern);
          if (match && match[1]) {
            appearance = match[1].trim();
            break;
          }
        }

        if (!appearance && text.length < 500) {
          const hasVisual = visualKeywords.some(kw => text.toLowerCase().includes(kw));
          if (hasVisual) appearance = text;
        }

        if (appearance) {
          const name = displayName || (keys.length > 0 ? keys[0] : '');
          if (name) characters.push({ name, appearance: appearance.slice(0, 300) });
        }
      }
    }

    // 2. Detect which characters appear in recent text
    const recentText = storyText.slice(-3000).toLowerCase();
    const mentioned = characters.filter(c => recentText.includes(c.name.toLowerCase()));

    // 3. Build character reference string
    let characterRefs = '';
    if (mentioned.length > 0) {
      characterRefs = '\n\nCharacter References:\n' + mentioned.map(c => `[${c.name}: ${c.appearance}]`).join('\n');
      console.log(`[Main] Scene prompt: ${mentioned.length} characters in scene: ${mentioned.map(c => c.name).join(', ')}`);
    }

    // 4. Build system prompt
    console.log(`[Main] Scene prompt style: artStyleId=${artStyleId}, customTags="${customTags}", resolved="${resolvedArtStyle}", final="${style}"`);
    let systemContent = `You are an expert at creating image generation prompts. Analyze story text and create a vivid visual prompt that captures the current scene.

Output ONLY a JSON object with this format:
{"prompt": "detailed visual description", "negativePrompt": "things to avoid"}

Guidelines:
- Focus on the CURRENT scene, not backstory
- Describe characters' appearance, poses, expressions
- Include setting details (location, lighting, atmosphere)
- Use comma-separated tags/descriptors
- MANDATORY style: Include these exact style tags in the prompt: ${style}
- Do NOT add any other style tags (no "anime style", "detailed", "high quality" unless they appear above)
- Keep prompts under 200 words
- For negativePrompt: list common image generation issues to avoid`;

    if (characterRefs) {
      systemContent += '\n\nIMPORTANT: Use the provided Character References for accurate character appearances. Include their visual details (hair color, eye color, clothing, etc.) in the prompt when they appear in the scene.';
    }

    if (narrativeContext) {
      systemContent += `\n\nNARRATIVE CONTEXT (use for scene understanding):\n${narrativeContext}`;
      console.log(`[Main] Scene prompt: injecting narrative context (${narrativeContext.length} chars)`);
    }

    let userContent = `Create an image prompt for this scene:\n\n${storyText.slice(-2000)}`;
    if (characterRefs) userContent += characterRefs;
    userContent += '\n\nRemember: Output ONLY valid JSON with "prompt" and "negativePrompt" keys.';

    const messages = [
      { role: 'system', content: systemContent },
      { role: 'user', content: userContent }
    ];

    // 5. Call GLM-4-6
    console.log('[Main] Generating scene prompt via direct API call...');
    const response = await provider.generateText(messages, {
      model: 'glm-4-6',
      max_tokens: 400,
      temperature: sceneSettings.promptTemperature,
    }, store);

    let content = '';
    if (response.output) {
      content = response.output;
    } else if (response.choices && response.choices.length > 0) {
      content = response.choices[0].text || response.choices[0].message?.content || '';
    }

    // 6. Parse JSON with truncated-JSON recovery
    const jsonMatch = content.match(/\{[\s\S]*\}/);
    if (jsonMatch) {
      let jsonStr = jsonMatch[0];
      try {
        JSON.parse(jsonStr);
      } catch {
        const quoteCount = (jsonStr.match(/"/g) || []).length;
        if (quoteCount % 2 !== 0) jsonStr += '"';
        const openBrackets = (jsonStr.match(/\[/g) || []).length;
        const closeBrackets = (jsonStr.match(/\]/g) || []).length;
        const openBraces = (jsonStr.match(/\{/g) || []).length;
        const closeBraces = (jsonStr.match(/\}/g) || []).length;
        for (let i = 0; i < openBrackets - closeBrackets; i++) jsonStr += ']';
        for (let i = 0; i < openBraces - closeBraces; i++) jsonStr += '}';
      }
      const parsed = JSON.parse(jsonStr);
      const prompt = parsed.prompt || '';
      const negativePrompt = parsed.negativePrompt || 'lowres, bad anatomy, bad hands, text, error, missing fingers';
      console.log(`[Main] Scene prompt generated (${prompt.length} chars)`);
      return { success: true, prompt, negativePrompt };
    }

    console.log('[Main] Could not parse scene prompt from API response');
    return { success: false, error: 'Could not parse response' };
  } catch (e) {
    console.error('[Main] Scene prompt generation failed:', e.message);
    return { success: false, error: e.message };
  }
});

// IPC Handlers — Per-story scene prompt state persistence
ipcMain.handle('scene:get-state', (event, storyId) => {
  return db.getSceneState(storyId) || {
    lastPrompt: '', lastNegativePrompt: '', lastStoryLength: 0,
    suggestions: [], artStyle: '',
  };
});

ipcMain.handle('scene:set-state', (event, { storyId, state }) => {
  db.setSceneState(storyId, state);
  return { success: true };
});

// ---------------------------------------------------------------------------
// Text LLM Provider Settings
// ---------------------------------------------------------------------------

ipcMain.handle('text-llm:get-settings', () => {
  return {
    openaiApiKey: store.get('openaiApiKey') ? '••••' : '',
    openaiModel: store.get('openaiModel') || openaiTextProvider.defaultModel,
    anthropicApiKey: store.get('anthropicApiKey') ? '••••' : '',
    anthropicModel: store.get('anthropicModel') || anthropicTextProvider.defaultModel,
    secondaryLlm: store.get('sceneSettings')?.secondaryLlm || 'none',
    pipelineVersion: store.get('sceneSettings')?.pipelineVersion || 1,
  };
});

ipcMain.handle('text-llm:set-settings', (event, settings) => {
  if (settings.openaiApiKey && settings.openaiApiKey !== '••••') {
    store.set('openaiApiKey', settings.openaiApiKey);
  }
  if (settings.openaiModel !== undefined) store.set('openaiModel', settings.openaiModel);
  if (settings.anthropicApiKey && settings.anthropicApiKey !== '••••') {
    store.set('anthropicApiKey', settings.anthropicApiKey);
  }
  if (settings.anthropicModel !== undefined) store.set('anthropicModel', settings.anthropicModel);
  // secondaryLlm and pipelineVersion are saved as part of sceneSettings
  if (settings.secondaryLlm !== undefined || settings.pipelineVersion !== undefined) {
    const sceneSettings = store.get('sceneSettings') || {};
    if (settings.secondaryLlm !== undefined) sceneSettings.secondaryLlm = settings.secondaryLlm;
    if (settings.pipelineVersion !== undefined) sceneSettings.pipelineVersion = settings.pipelineVersion;
    store.set('sceneSettings', sceneSettings);
  }
  return { success: true };
});

ipcMain.handle('text-llm:list-providers', () => {
  return Object.values(TEXT_PROVIDERS).map(p => ({ id: p.id, name: p.name }));
});

ipcMain.handle('text-llm:list-ollama-models', async () => {
  try {
    const ollamaUrl = getOllamaUrl();
    const response = await fetch(`${ollamaUrl}/api/tags`, { signal: AbortSignal.timeout(3000) });
    if (!response.ok) return { success: false, models: [] };
    const data = await response.json();
    const models = (data.models || []).map(m => ({ id: m.name, name: m.name, size: m.size }));
    return { success: true, models };
  } catch (err) {
    console.error('[Main] Ollama model list failed:', err.message || err);
    return { success: false, models: [] };
  }
});

// ---------------------------------------------------------------------------
// Visual Profiles
// ---------------------------------------------------------------------------

ipcMain.handle('visual-profiles:get', (event, storyId) => {
  return db.getVisualProfiles(storyId);
});

ipcMain.handle('visual-profiles:reset', (event, storyId) => {
  db.resetVisualProfiles(storyId);
  return { success: true };
});

// ---------------------------------------------------------------------------
// Lore Comprehension — Progressive scan state (in-memory, not persisted)
// ---------------------------------------------------------------------------

const progressiveScans = new Map(); // storyId → {cancel: false, pause: false}

// ---------------------------------------------------------------------------
// Lore Creator — LLM provider factory
// ---------------------------------------------------------------------------

function makeNovelaiGenerateTextFn() {
  return async (messages, options) => {
    return novelaiProvider.generateText(messages, {
      model: 'glm-4-6',
      max_tokens: options.max_tokens || 300,
      temperature: options.temperature || 0.4,
    }, store);
  };
}

function makeOllamaGenerateTextFn() {
  return async (messages, options) => {
    // Read URL and model at call time so settings changes take effect immediately
    const ollamaUrl = getOllamaUrl();
    const ollamaModel = store.get('loreOllamaModel') || 'mistral:7b';

    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 120000);

    let response;
    try {
      response = await fetch(`${ollamaUrl}/api/chat`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          model: ollamaModel,
          messages,
          stream: false,
          options: {
            num_predict: options.max_tokens || 300,
            temperature: options.temperature || 0.4,
          },
        }),
        signal: controller.signal,
      });
    } catch (err) {
      clearTimeout(timeout);
      if (err.name === 'AbortError') throw new Error('Ollama API timed out after 120s');
      throw err;
    }

    if (!response.ok) {
      clearTimeout(timeout);
      const text = await response.text();
      throw new Error(`Ollama API error ${response.status}: ${text}`);
    }

    const data = await response.json();
    clearTimeout(timeout);
    return { output: data.message?.content || '' };
  };
}

function makeOpenaiGenerateTextFn() {
  return async (messages, options) => {
    return openaiTextProvider.generateText(messages, {
      max_tokens: options.max_tokens || 300,
      temperature: options.temperature || 0.4,
    }, store);
  };
}

function makeAnthropicGenerateTextFn() {
  return async (messages, options) => {
    return anthropicTextProvider.generateText(messages, {
      max_tokens: options.max_tokens || 300,
      temperature: options.temperature || 0.4,
    }, store);
  };
}

function makeGenerateTextFn(providerName) {
  switch (providerName) {
    case 'ollama': return makeOllamaGenerateTextFn();
    case 'openai': return makeOpenaiGenerateTextFn();
    case 'anthropic': return makeAnthropicGenerateTextFn();
    default: return makeNovelaiGenerateTextFn();
  }
}

function makeLoreGenerateTextFn() {
  const llmProvider = store.get('loreLlmProvider') || 'novelai';
  return makeGenerateTextFn(llmProvider);
}

async function isOllamaAvailable() {
  try {
    const ollamaUrl = getOllamaUrl();
    const response = await fetch(`${ollamaUrl}/api/tags`, { signal: AbortSignal.timeout(2000) });
    return response.ok;
  } catch {
    return false;
  }
}

// ---------------------------------------------------------------------------
// Unified Context Builder — combines comprehension + memory for subsystems
// ---------------------------------------------------------------------------

function buildUnifiedContext(storyId, options = {}) {
  if (!storyId) return '';
  const includeComp = options.comprehension !== false;
  const includeMem = options.memory === true;
  const totalBudget = options.budget || 3000;
  const sections = [];
  let remaining = totalBudget;

  if (includeComp) {
    const compState = db.getComprehension(storyId);
    if (compState && compState.masterSummary) {
      const ctx = loreComprehension.formatComprehensionContext(
        compState.masterSummary, compState.entityProfiles
      );
      if (ctx) {
        const capped = ctx.slice(0, Math.min(2500, Math.floor(remaining * 0.6)));
        sections.push(capped);
        remaining -= capped.length;
      }
    }
  }

  if (includeMem) {
    const memState = db.getMemoryState(storyId);
    if (memState) {
      const ctx = memoryManager.formatMemoryContext(memState, Math.min(1200, remaining));
      if (ctx) { sections.push(ctx); remaining -= ctx.length; }
    }
  }

  return sections.filter(s => s.length > 0).join('\n\n').slice(0, totalBudget);
}

// ---------------------------------------------------------------------------
// IPC Handlers — Lore Creator
// ---------------------------------------------------------------------------

ipcMain.handle('lore:scan', async (event, { storyText, existingEntries, storyId, scanOptions }) => {
  try {
    const settings = store.get('loreSettings') || loreCreator.DEFAULT_SETTINGS;
    const state = db.getLoreState(storyId) || {
      pendingEntries: [], pendingUpdates: [], pendingMerges: [],
      acceptedEntryIds: [], rejectedNames: [], dismissedUpdateNames: [],
      rejectedMergeNames: [], dismissedReformatNames: [], charsSinceLastScan: 0, loreCategoryIds: {},
      pendingCleanups: [], dismissedCleanupIds: [],
    };

    const generateTextFn = makeLoreGenerateTextFn();

    // Check if secondary provider is available for hybrid scanning
    let secondaryGenerateTextFn = null;
    if (settings.hybridEnabled !== false) {
      const primaryProvider = store.get('loreLlmProvider') || 'novelai';
      if (primaryProvider === 'novelai') {
        if (await isOllamaAvailable()) {
          secondaryGenerateTextFn = makeOllamaGenerateTextFn();
          console.log('[Main] Hybrid scan: NovelAI (primary) + Ollama (secondary)');
        }
      } else {
        secondaryGenerateTextFn = makeNovelaiGenerateTextFn();
        console.log('[Main] Hybrid scan: Ollama (primary) + NovelAI (secondary)');
      }
    }

    // Build comprehension context if available
    let comprehensionContext = '';
    const compState = db.getComprehension(storyId);
    if (compState && compState.masterSummary) {
      comprehensionContext = loreComprehension.formatComprehensionContext(
        compState.masterSummary, compState.entityProfiles
      );
      console.log(`[Main] Injecting comprehension context (${comprehensionContext.length} chars) into lore scan`);
    }

    // Inject memory state context into lore scan
    const memState = db.getMemoryState(storyId);
    if (memState && (memState.currentSituation || (memState.events && memState.events.length > 0))) {
      const memCtx = memoryManager.formatMemoryContext(memState, 500);
      if (memCtx) {
        comprehensionContext = comprehensionContext
          ? comprehensionContext + '\n\n' + memCtx
          : memCtx;
        console.log(`[Main] Injecting memory context (${memCtx.length} chars) into lore scan`);
      }
    }

    // Apply scan options (category filter, relationships-only)
    // Inject custom categories from lore state so registry is available during scan
    const loreState = db.getLoreState(storyId) || {};
    const effectiveSettings = { ...settings, customCategories: loreState.customCategories || [] };
    if (scanOptions) {
      if (scanOptions.categoryFilter) {
        const registry = loreCreator.buildCategoryRegistry(loreState.customCategories);
        const allCatIds = loreCreator.getCategoryIds(registry);
        effectiveSettings.enabledCategories = {};
        for (const cat of allCatIds) {
          effectiveSettings.enabledCategories[cat] = (cat === scanOptions.categoryFilter);
        }
      }
      if (scanOptions.relationshipsOnly) {
        effectiveSettings._relationshipsOnly = true;
      }
    }

    // Inject lorebook optimizer settings for Pass 6
    const storySettingsData = db.getStorySettings(storyId);
    if (storySettingsData) {
      const optProfile = storySettingsData.lorebookProfile;
      const optFields = storySettingsData.loreOptConfirmedFields;
      if (optProfile && optFields && optFields.length > 0) {
        effectiveSettings._lorebookProfile = optProfile;
        effectiveSettings._confirmedFields = optFields;
        // Load entity profiles for optimization rules
        const compStateForOpt = db.getComprehension(storyId);
        if (compStateForOpt && compStateForOpt.entityProfiles) {
          effectiveSettings._entityProfiles = compStateForOpt.entityProfiles;
        }
        console.log(`[Main] Pass 6 enabled: profile=${optProfile}, fields=${optFields.length}`);
      }
    }

    const result = await loreCreator.scanForLore(
      storyText, effectiveSettings, existingEntries, state, generateTextFn,
      (progress) => {
        if (mainWindow && !mainWindow.isDestroyed()) {
          mainWindow.webContents.send('lore:scan-progress', progress);
        }
      },
      comprehensionContext || undefined,
      secondaryGenerateTextFn
    );

    // Extract transient optimization data before saving (renderer-only, not persisted)
    const pendingOptimizations = result.state._pendingOptimizations || [];
    delete result.state._pendingOptimizations;

    // Save updated state
    db.setLoreState(storyId, result.state);

    // Chain LitRPG scan asynchronously — don't block lore scan return
    const rpgState = db.getLitrpgState(storyId);
    if (rpgState && rpgState.enabled && rpgState.autoScan !== false) {
      console.log('[Main] Chaining LitRPG scan after lore scan (async)');
      // Fire-and-forget — lore scan result returns immediately
      (async () => {
        try {
          const rpgResult = await litrpgTracker.scanForRPGData(
            storyText, rpgState, existingEntries || [], generateTextFn,
            (progress) => {
              if (mainWindow && !mainWindow.isDestroyed()) {
                mainWindow.webContents.send('litrpg:scan-progress', progress);
              }
            },
            comprehensionContext || undefined,
            secondaryGenerateTextFn,
            {} // options — no forceReEnrich for chained scans
          );
          // Extract transient fields before saving (not persisted in DB)
          const transient = extractTransientFields(rpgResult.state);
          const roleUpdates = transient._pendingRoleUpdates || [];
          const pendingLoreEntries = transient._pendingLoreEntries || [];

          db.setLitrpgState(storyId, rpgResult.state);
          if (mainWindow && !mainWindow.isDestroyed()) {
            mainWindow.webContents.send('litrpg:state-updated', {
              state: rpgResult.state,
              roleUpdates,
              pendingLoreEntries,
              report: rpgResult.report,
            });
          }
        } catch (rpgErr) {
          console.error('[Main] Chained LitRPG scan failed:', rpgErr.message);
        }
      })();
    } else if (!rpgState || rpgState.detected === null || rpgState.detected === false) {
      // First scan — run LitRPG detection (lightweight, keep synchronous)
      try {
        const detection = await litrpgTracker.detectLitRPG(storyText, generateTextFn);
        const newRpgState = rpgState || { ...db.LITRPG_STATE_DEFAULTS };
        newRpgState.detected = detection.detected;
        newRpgState.systemType = detection.systemType;
        db.setLitrpgState(storyId, newRpgState);
        if (detection.detected && mainWindow && !mainWindow.isDestroyed()) {
          mainWindow.webContents.send('litrpg:detected', { systemType: detection.systemType });
        }
      } catch (detErr) {
        console.error('[Main] LitRPG detection failed:', detErr.message);
      }
    }

    return { success: true, ...result, pendingOptimizations };
  } catch (e) {
    console.error('[Main] Lore scan failed:', e.message);
    return { success: false, error: e.message };
  }
});

ipcMain.handle('lore:organize', async (event, { entries, storyText, storyId, categoryMap }) => {
  try {
    const settings = store.get('loreSettings') || loreCreator.DEFAULT_SETTINGS;
    const generateTextFn = makeLoreGenerateTextFn();

    // Build comprehension context if available
    let comprehensionContext = '';
    const compState = db.getComprehension(storyId);
    if (compState && compState.masterSummary) {
      comprehensionContext = loreComprehension.formatComprehensionContext(
        compState.masterSummary, compState.entityProfiles
      );
    }

    // Get dismissed cleanup IDs and custom categories
    const state = db.getLoreState(storyId) || {};
    const dismissedCleanupIds = state.dismissedCleanupIds || [];
    settings.customCategories = state.customCategories || [];

    const result = await loreCreator.organizeLorebook(
      entries, storyText, settings, generateTextFn,
      (progress) => {
        if (mainWindow && !mainWindow.isDestroyed()) {
          mainWindow.webContents.send('lore:organize-progress', progress);
        }
      },
      comprehensionContext || undefined,
      categoryMap,
      dismissedCleanupIds
    );

    return { success: true, ...result };
  } catch (e) {
    console.error('[Main] Lore organize failed:', e.message);
    return { success: false, error: e.message };
  }
});

ipcMain.handle('lore:identify-target', async (event, { prompt, entries }) => {
  try {
    const generateTextFn = makeLoreGenerateTextFn();
    const result = await loreCreator.identifyTargetEntry(prompt, entries, generateTextFn);
    return { success: true, result };
  } catch (e) {
    console.error('[Main] Lore identify-target failed:', e.message);
    return { success: false, error: e.message };
  }
});

ipcMain.handle('lore:generate-enriched', async (event, { prompt, currentText, displayName }) => {
  try {
    const generateTextFn = makeLoreGenerateTextFn();
    const result = await loreCreator.generateEnrichedText(prompt, currentText, displayName, generateTextFn);
    return { success: true, result };
  } catch (e) {
    console.error('[Main] Lore generate-enriched failed:', e.message);
    return { success: false, error: e.message };
  }
});

ipcMain.handle('lore:create-from-prompt', async (event, { prompt, category, storyText, storyId }) => {
  try {
    const settings = store.get('loreSettings') || loreCreator.DEFAULT_SETTINGS;
    const loreStateCfp = db.getLoreState(storyId) || {};
    settings.customCategories = loreStateCfp.customCategories || [];
    const generateTextFn = makeLoreGenerateTextFn();

    // Build comprehension context if available
    let comprehensionContext = '';
    const compState2 = db.getComprehension(storyId);
    if (compState2 && compState2.masterSummary) {
      comprehensionContext = loreComprehension.formatComprehensionContext(
        compState2.masterSummary, compState2.entityProfiles
      );
    }

    // Get existing entry names to avoid duplicates
    const loreStateForPrompt = db.getLoreState(storyId) || { pendingEntries: [], rejectedNames: [] };
    const existingEntryNames = (loreStateForPrompt.pendingEntries || []).map(e => e.displayName).filter(Boolean);

    const entries = await loreCreator.generateEntriesFromPrompt(
      prompt, category, storyText, settings, existingEntryNames, generateTextFn,
      comprehensionContext || undefined
    );

    return { success: true, entries };
  } catch (e) {
    console.error('[Main] Lore create-from-prompt failed:', e.message);
    return { success: false, error: e.message };
  }
});

ipcMain.handle('lore:reformat-entry', async (event, { displayName, currentText, storyText, storyId, entryType }) => {
  try {
    const generateTextFn = makeLoreGenerateTextFn();

    // Build comprehension context if available
    let comprehensionContext = '';
    if (storyId) {
      const compState3 = db.getComprehension(storyId);
      if (compState3 && compState3.masterSummary) {
        comprehensionContext = loreComprehension.formatComprehensionContext(
          compState3.masterSummary, compState3.entityProfiles
        );
      }
    }

    const result = await loreCreator.enrichAndReformatEntry(
      displayName, currentText, generateTextFn,
      comprehensionContext || undefined, storyText || undefined, entryType || undefined
    );
    return { success: true, result };
  } catch (e) {
    console.error('[Main] Lore reformat-entry failed:', e.message);
    return { success: false, error: e.message };
  }
});

ipcMain.handle('lore:parse-metadata', (event, { text }) => {
  return loreCreator.parseMetadata(text);
});

ipcMain.handle('lore:set-metadata', (event, { text, opts }) => {
  return loreCreator.setMetadata(text, opts);
});

ipcMain.handle('lore:get-entry-type', (event, { text, displayName }) => {
  return loreCreator.getEntryType(text, displayName);
});

ipcMain.handle('lore:get-settings', () => {
  return store.get('loreSettings') || loreCreator.DEFAULT_SETTINGS;
});

ipcMain.handle('lore:set-settings', (event, settings) => {
  store.set('loreSettings', settings);
  return { success: true };
});

ipcMain.handle('lore:get-category-registry', (event, storyId) => {
  // Custom categories are session-only — don't restore from DB.
  // They can be re-detected from the lorebook via "Detect Categories".
  return loreCreator.buildCategoryRegistry([]);
});

ipcMain.handle('lore:add-custom-category', (event, { storyId, category }) => {
  const loreState = db.getLoreState(storyId) || {};
  if (!loreState.customCategories) loreState.customCategories = [];

  // Validate: id required, no duplicates
  if (!category || !category.id) return { success: false, error: 'Category ID required' };
  const builtinIds = loreCreator.BUILTIN_CATEGORIES.map(c => c.id);
  if (builtinIds.includes(category.id)) return { success: false, error: 'Cannot override builtin category' };
  if (loreState.customCategories.find(c => c.id === category.id)) return { success: false, error: 'Category already exists' };

  loreState.customCategories.push({
    id: category.id,
    displayName: category.displayName,
    singularName: category.singularName,
    color: category.color,
    isBuiltin: false,
    template: null,
  });
  db.setLoreState(storyId, loreState);

  // Also add to enabled categories in global settings
  const settings = store.get('loreSettings') || loreCreator.DEFAULT_SETTINGS;
  if (!settings.enabledCategories) settings.enabledCategories = {};
  settings.enabledCategories[category.id] = true;
  store.set('loreSettings', settings);

  return { success: true };
});

ipcMain.handle('lore:remove-custom-category', (event, { storyId, categoryId }) => {
  const loreState = db.getLoreState(storyId) || {};
  if (!loreState.customCategories) return { success: false, error: 'No custom categories' };

  const builtinIds = loreCreator.BUILTIN_CATEGORIES.map(c => c.id);
  if (builtinIds.includes(categoryId)) return { success: false, error: 'Cannot remove builtin category' };

  loreState.customCategories = loreState.customCategories.filter(c => c.id !== categoryId);
  db.setLoreState(storyId, loreState);

  // Also remove from enabled categories
  const settings = store.get('loreSettings') || loreCreator.DEFAULT_SETTINGS;
  if (settings.enabledCategories) {
    delete settings.enabledCategories[categoryId];
    store.set('loreSettings', settings);
  }

  return { success: true };
});

ipcMain.handle('lore:get-state', (event, storyId) => {
  return db.getLoreState(storyId) || {
    pendingEntries: [], pendingUpdates: [], pendingMerges: [],
    acceptedEntryIds: [], rejectedNames: [], dismissedUpdateNames: [],
    rejectedMergeNames: [], charsSinceLastScan: 0, loreCategoryIds: {},
    pendingCleanups: [], dismissedCleanupIds: [],
  };
});

ipcMain.handle('lore:set-state', (event, { storyId, state }) => {
  db.setLoreState(storyId, state);
  return { success: true };
});

ipcMain.handle('lore:get-llm-provider', () => {
  return {
    provider: store.get('loreLlmProvider') || 'novelai',
    ollamaModel: store.get('loreOllamaModel') || 'mistral:7b',
    ollamaUrl: store.get('loreOllamaUrl') || 'http://localhost:11434',
  };
});

ipcMain.handle('lore:set-llm-provider', (event, { provider, ollamaModel, ollamaUrl }) => {
  if (provider !== undefined) store.set('loreLlmProvider', provider);
  if (ollamaModel !== undefined) store.set('loreOllamaModel', ollamaModel);
  if (ollamaUrl !== undefined) store.set('loreOllamaUrl', ollamaUrl);
  return { success: true };
});

ipcMain.handle('lore:check-ollama', async () => {
  try {
    const url = getOllamaUrl();
    const response = await fetch(`${url}/api/tags`);
    if (!response.ok) return { available: false };
    const data = await response.json();
    const models = (data.models || []).map(m => ({ name: m.name, size: m.size }));
    return { available: true, models };
  } catch {
    return { available: false };
  }
});

// ---------------------------------------------------------------------------
// IPC Handlers — Lore Comprehension (progressive scan)
// ---------------------------------------------------------------------------

ipcMain.handle('lore:start-progressive-scan', async (event, { storyId, storyText, existingEntries }) => {
  try {
    // Cancel any existing scan for this story
    if (progressiveScans.has(storyId)) {
      progressiveScans.get(storyId).cancel = true;
    }

    const scanControl = { cancel: false, pause: false };
    progressiveScans.set(storyId, scanControl);

    const generateTextFn = makeLoreGenerateTextFn();
    const existingState = db.getComprehension(storyId) || null;

    // Set up hybrid provider for parallel chunk processing
    let secondaryGenerateTextFn = null;
    const settings = store.get('loreSettings') || loreCreator.DEFAULT_SETTINGS;
    if (settings.hybridEnabled !== false) {
      const primaryProvider = store.get('loreLlmProvider') || 'novelai';
      if (primaryProvider === 'novelai') {
        if (await isOllamaAvailable()) {
          secondaryGenerateTextFn = makeOllamaGenerateTextFn();
          console.log('[Main] Hybrid comprehension scan: NovelAI (primary) + Ollama (secondary)');
        }
      } else if (primaryProvider === 'ollama') {
        secondaryGenerateTextFn = makeNovelaiGenerateTextFn();
        console.log('[Main] Hybrid comprehension scan: Ollama (primary) + NovelAI (secondary)');
      }
    }

    // Build category registry for category-aware entity extraction
    const loreState = db.getLoreState(storyId) || {};
    const categories = loreCreator.buildCategoryRegistry(loreState.customCategories || []);

    const updatedState = await loreComprehension.runProgressiveScan(
      storyText,
      existingState,
      generateTextFn,
      (progress) => {
        if (mainWindow && !mainWindow.isDestroyed()) {
          mainWindow.webContents.send('lore:progressive-scan-progress', {
            storyId,
            ...progress,
          });
        }
      },
      () => {
        const ctrl = progressiveScans.get(storyId);
        if (!ctrl) return true;
        return ctrl.cancel;
      },
      {
        secondaryGenerateTextFn,
        categories,
        knownEntries: existingEntries || [],
      }
    );

    // Save state
    db.setComprehension(storyId, updatedState);

    progressiveScans.delete(storyId);

    if (mainWindow && !mainWindow.isDestroyed()) {
      mainWindow.webContents.send('lore:progressive-scan-complete', { storyId });
    }

    return { success: true, state: updatedState };
  } catch (e) {
    console.error('[Main] Progressive scan failed:', e.message);
    progressiveScans.delete(storyId);
    return { success: false, error: e.message };
  }
});

ipcMain.handle('lore:pause-progressive-scan', (event, { storyId }) => {
  const ctrl = progressiveScans.get(storyId);
  if (ctrl) ctrl.pause = true;
  return { success: !!ctrl };
});

ipcMain.handle('lore:resume-progressive-scan', (event, { storyId }) => {
  const ctrl = progressiveScans.get(storyId);
  if (ctrl) ctrl.pause = false;
  return { success: !!ctrl };
});

ipcMain.handle('lore:cancel-progressive-scan', (event, { storyId }) => {
  const ctrl = progressiveScans.get(storyId);
  if (ctrl) ctrl.cancel = true;
  return { success: !!ctrl };
});

ipcMain.handle('lore:get-comprehension', (event, storyId) => {
  const state = db.getComprehension(storyId);
  if (state) {
    console.log(`[Main] Found comprehension for ${storyId}: masterSummary=${!!state.masterSummary}, entities=${Object.keys(state.entityProfiles || {}).length}`);
  } else {
    console.log(`[Main] No comprehension data for story ${storyId}`);
  }
  return state;
});

ipcMain.handle('lore:incremental-update', async (event, { storyId, storyText, existingEntries }) => {
  try {
    const generateTextFn = makeLoreGenerateTextFn();
    const existingState = db.getComprehension(storyId) || null;

    // Set up hybrid for incremental updates too
    let secondaryGenerateTextFn = null;
    const settings = store.get('loreSettings') || loreCreator.DEFAULT_SETTINGS;
    if (settings.hybridEnabled !== false) {
      const primaryProvider = store.get('loreLlmProvider') || 'novelai';
      if (primaryProvider === 'novelai') {
        if (await isOllamaAvailable()) secondaryGenerateTextFn = makeOllamaGenerateTextFn();
      } else if (primaryProvider === 'ollama') {
        secondaryGenerateTextFn = makeNovelaiGenerateTextFn();
      }
    }

    const loreState = db.getLoreState(storyId) || {};
    const categories = loreCreator.buildCategoryRegistry(loreState.customCategories || []);

    const updatedState = await loreComprehension.incrementalUpdate(
      storyText, existingState, generateTextFn, {
        secondaryGenerateTextFn,
        categories,
        knownEntries: existingEntries || [],
      }
    );

    db.setComprehension(storyId, updatedState);

    return { success: true, state: updatedState };
  } catch (e) {
    console.error('[Main] Incremental update failed:', e.message);
    return { success: false, error: e.message };
  }
});

// ---------------------------------------------------------------------------
// IPC Handlers — Lorebook Optimizer
// ---------------------------------------------------------------------------

ipcMain.handle('lore:get-profiles', () => {
  return lorebookOptimizer.PROFILES;
});

ipcMain.handle('lore:get-profile', (event, profileId) => {
  return lorebookOptimizer.getProfile(profileId);
});

ipcMain.handle('lore:optimize-entries', async (event, { entries, profileId, storyId, confirmedFields }) => {
  try {
    const generateTextFn = makeLoreGenerateTextFn();

    // Set up hybrid providers (same pattern as lore:scan)
    let secondaryFn = null;
    const primaryProvider = store.get('loreLlmProvider') || 'novelai';
    if (primaryProvider === 'novelai') {
      if (await isOllamaAvailable()) secondaryFn = makeOllamaGenerateTextFn();
    } else {
      secondaryFn = makeNovelaiGenerateTextFn();
    }
    const hybrid = loreCreator.createHybridProviders(generateTextFn, secondaryFn);

    // Load entity profiles from comprehension state
    const compState = db.getComprehension(storyId);
    const entityProfiles = (compState && compState.entityProfiles) || {};

    const result = await lorebookOptimizer.optimizeLoreEntries(
      entries, profileId, entityProfiles, hybrid.getProviders, confirmedFields,
      (progress) => {
        if (mainWindow && !mainWindow.isDestroyed()) {
          mainWindow.webContents.send('lore:scan-progress', progress);
        }
      }
    );

    // Save optimization state in lore state
    const loreState = db.getLoreState(storyId) || {};
    loreState.optimizationState = {
      lastRun: Date.now(),
      profileId,
      summary: lorebookOptimizer.buildOptimizationSummary(result.details),
      confirmedFields,
    };
    db.setLoreState(storyId, loreState);

    return { success: true, ...result };
  } catch (e) {
    console.error('[Main] Lorebook optimization failed:', e.message);
    return { success: false, error: e.message };
  }
});

ipcMain.handle('lore:adjust-entries', async (event, { entries, profileId, storyId }) => {
  try {
    const compState = db.getComprehension(storyId);
    const entityProfiles = (compState && compState.entityProfiles) || {};

    const adjustments = lorebookOptimizer.adjustOnNewText(entries, profileId, entityProfiles);
    return { success: true, adjustments };
  } catch (e) {
    console.error('[Main] Lorebook adjustment failed:', e.message);
    return { success: false, error: e.message };
  }
});

ipcMain.handle('lore:parse-discovery', (event, { inspectResult, writeTestResult }) => {
  return lorebookOptimizer.parseDiscoveryResults(inspectResult, writeTestResult);
});

// ---------------------------------------------------------------------------
// IPC Handlers — Memory Manager
// ---------------------------------------------------------------------------

const memoryProcessingLock = new Set();

ipcMain.handle('memory:process', async (event, { storyText, storyId }) => {
  if (memoryProcessingLock.has(storyId)) {
    return { success: false, error: 'Already processing' };
  }
  memoryProcessingLock.add(storyId);
  try {
    const settings = { ...memoryManager.DEFAULT_SETTINGS, ...store.get('memorySettings') };
    const state = db.getMemoryState(storyId) || memoryManager.createEmptyState();
    const generateTextFn = makeLoreGenerateTextFn();

    // Build comprehension context if available
    let comprehensionContext = '';
    const compState = db.getComprehension(storyId);
    if (compState && compState.masterSummary) {
      comprehensionContext = loreComprehension.formatComprehensionContext(
        compState.masterSummary, compState.entityProfiles
      );
    }

    const result = await memoryManager.processNewContent(
      storyText, state, settings, generateTextFn, comprehensionContext || undefined
    );

    db.setMemoryState(storyId, result.updatedState);

    return { success: true, memoryText: result.memoryText, state: result.updatedState };
  } catch (e) {
    console.error('[Main] Memory process failed:', e.message);
    return { success: false, error: e.message };
  } finally {
    memoryProcessingLock.delete(storyId);
  }
});

ipcMain.handle('memory:force-refresh', async (event, { storyText, storyId }) => {
  if (memoryProcessingLock.has(storyId)) {
    return { success: false, error: 'Already processing' };
  }
  memoryProcessingLock.add(storyId);
  try {
    const settings = { ...memoryManager.DEFAULT_SETTINGS, ...store.get('memorySettings') };
    const generateTextFn = makeLoreGenerateTextFn();

    // Check for secondary provider (hybrid) — respects lore settings toggle
    let secondaryGenerateTextFn = null;
    const loreSettings = store.get('loreSettings') || {};
    if (loreSettings.hybridEnabled !== false) {
      const primaryProvider = store.get('loreLlmProvider') || 'novelai';
      if (primaryProvider === 'novelai') {
        if (await isOllamaAvailable()) {
          secondaryGenerateTextFn = makeOllamaGenerateTextFn();
          console.log('[Main] Memory refresh: hybrid mode (NovelAI + Ollama)');
        }
      } else {
        secondaryGenerateTextFn = makeNovelaiGenerateTextFn();
        console.log('[Main] Memory refresh: hybrid mode (Ollama + NovelAI)');
      }
    }

    let comprehensionContext = '';
    const compState = db.getComprehension(storyId);
    if (compState && compState.masterSummary) {
      comprehensionContext = loreComprehension.formatComprehensionContext(
        compState.masterSummary, compState.entityProfiles
      );
    }

    const result = await memoryManager.forceRefresh(
      storyText, settings, generateTextFn,
      (progress) => {
        if (mainWindow && !mainWindow.isDestroyed()) {
          mainWindow.webContents.send('memory:progress', progress);
        }
      },
      comprehensionContext || undefined,
      secondaryGenerateTextFn
    );

    db.setMemoryState(storyId, result.updatedState);

    return { success: true, memoryText: result.memoryText, state: result.updatedState };
  } catch (e) {
    console.error('[Main] Memory force-refresh failed:', e.message);
    return { success: false, error: e.message };
  } finally {
    memoryProcessingLock.delete(storyId);
  }
});

ipcMain.handle('memory:clear', (event, { storyId }) => {
  db.setMemoryState(storyId, memoryManager.createEmptyState());
  return { success: true };
});

ipcMain.handle('memory:get-state', (event, storyId) => {
  return db.getMemoryState(storyId) || memoryManager.createEmptyState();
});

ipcMain.handle('memory:set-state', (event, { storyId, state }) => {
  db.setMemoryState(storyId, state);
  return { success: true };
});

ipcMain.handle('memory:get-settings', () => {
  return { ...memoryManager.DEFAULT_SETTINGS, ...store.get('memorySettings') };
});

ipcMain.handle('memory:set-settings', (event, settings) => {
  store.set('memorySettings', settings);
  return { success: true };
});

// IPC Handlers — LitRPG

ipcMain.handle('litrpg:detect', async (event, { storyText, storyId }) => {
  try {
    const generateTextFn = makeLoreGenerateTextFn();
    const result = await litrpgTracker.detectLitRPG(storyText, generateTextFn);
    // Save detection result
    const rpgState = db.getLitrpgState(storyId) || { ...db.LITRPG_STATE_DEFAULTS };
    rpgState.detected = result.detected;
    rpgState.systemType = result.systemType;
    db.setLitrpgState(storyId, rpgState);
    return { success: true, ...result };
  } catch (e) {
    console.error('[Main] LitRPG detection failed:', e.message);
    return { success: false, error: e.message };
  }
});

ipcMain.handle('litrpg:scan', async (event, { storyText, storyId, loreEntries, forceReEnrich }) => {
  try {
    const rpgState = db.getLitrpgState(storyId) || { ...db.LITRPG_STATE_DEFAULTS };
    if (!rpgState.enabled) return { success: false, error: 'LitRPG mode not enabled' };

    const generateTextFn = makeLoreGenerateTextFn();

    // Check for secondary provider
    let secondaryGenerateTextFn = null;
    const loreSettings = store.get('loreSettings') || {};
    if (loreSettings.hybridEnabled !== false) {
      const primaryProvider = store.get('loreLlmProvider') || 'novelai';
      if (primaryProvider === 'novelai') {
        if (await isOllamaAvailable()) secondaryGenerateTextFn = makeOllamaGenerateTextFn();
      } else {
        secondaryGenerateTextFn = makeNovelaiGenerateTextFn();
      }
    }

    // Build comprehension context
    let comprehensionContext = '';
    const compState = db.getComprehension(storyId);
    if (compState && compState.masterSummary) {
      comprehensionContext = loreComprehension.formatComprehensionContext(
        compState.masterSummary, compState.entityProfiles
      );
    }

    const result = await litrpgTracker.scanForRPGData(
      storyText, rpgState, loreEntries || [], generateTextFn,
      (progress) => {
        if (mainWindow && !mainWindow.isDestroyed()) {
          mainWindow.webContents.send('litrpg:scan-progress', progress);
        }
      },
      comprehensionContext || undefined,
      secondaryGenerateTextFn,
      { forceReEnrich: !!forceReEnrich }
    );

    // Extract transient fields before saving (not persisted in DB)
    const transient = extractTransientFields(result.state);
    const roleUpdates = transient._pendingRoleUpdates || [];
    const pendingLoreEntries = transient._pendingLoreEntries || [];
    const r4Skipped = transient._r4Skipped || 0;

    db.setLitrpgState(storyId, result.state);
    return { success: true, state: result.state, roleUpdates, pendingLoreEntries, r4Skipped, report: result.report };
  } catch (e) {
    console.error('[Main] LitRPG scan failed:', e.message);
    return { success: false, error: e.message };
  }
});

ipcMain.handle('litrpg:get-state', (event, storyId) => {
  return db.getLitrpgState(storyId);
});

ipcMain.handle('litrpg:set-state', (event, { storyId, state }) => {
  // Strip transient portrait base64 data before persisting (filesystem-backed)
  if (state && state.characters) {
    for (const char of Object.values(state.characters)) {
      delete char._portraitData;
      delete char._thumbnailData;
    }
  }
  db.setLitrpgState(storyId, state);
  return { success: true };
});

ipcMain.handle('litrpg:accept-update', (event, { storyId, updateId }) => {
  const rpgState = db.getLitrpgState(storyId);
  if (!rpgState) return { success: false, error: 'No LitRPG state' };
  const updated = litrpgTracker.acceptPendingUpdate(rpgState, updateId);
  db.setLitrpgState(storyId, updated);
  return { success: true, state: updated };
});

ipcMain.handle('litrpg:reject-update', (event, { storyId, updateId }) => {
  const rpgState = db.getLitrpgState(storyId);
  if (!rpgState) return { success: false, error: 'No LitRPG state' };
  const updated = litrpgTracker.rejectPendingUpdate(rpgState, updateId);
  db.setLitrpgState(storyId, updated);
  return { success: true, state: updated };
});

ipcMain.handle('litrpg:build-lorebook-text', (event, { entryText, rpgData }) => {
  return litrpgTracker.buildLitRPGCharacterText(entryText, rpgData);
});

ipcMain.handle('litrpg:build-role-update', (event, { entryText, role }) => {
  return litrpgTracker.buildRoleUpdatePayload(entryText, role);
});

ipcMain.handle('litrpg:generate-portrait-prompt', async (event, { characterEntryText, rpgData }) => {
  try {
    const generateTextFn = makeLoreGenerateTextFn();
    const prompt = await litrpgTracker.generatePortraitPrompt(characterEntryText, rpgData, generateTextFn);
    return { success: true, prompt };
  } catch (e) {
    return { success: false, error: e.message };
  }
});

ipcMain.handle('litrpg:accept-all-updates', (event, { storyId }) => {
  const rpgState = db.getLitrpgState(storyId);
  if (!rpgState) return { success: false, error: 'No LitRPG state' };
  const updated = litrpgTracker.acceptAllPendingUpdates(rpgState);
  db.setLitrpgState(storyId, updated);
  return { success: true, state: updated };
});

ipcMain.handle('litrpg:reject-all-updates', (event, { storyId }) => {
  const rpgState = db.getLitrpgState(storyId);
  if (!rpgState) return { success: false, error: 'No LitRPG state' };
  const updated = litrpgTracker.rejectAllPendingUpdates(rpgState);
  db.setLitrpgState(storyId, updated);
  return { success: true, state: updated };
});

ipcMain.handle('litrpg:update-character', (event, { storyId, characterId, updates }) => {
  const rpgState = db.getLitrpgState(storyId);
  if (!rpgState) return { success: false, error: 'No LitRPG state' };
  const char = rpgState.characters[characterId];
  if (!char) return { success: false, error: 'Character not found' };
  Object.assign(char, updates, { lastUpdated: Date.now() });
  db.setLitrpgState(storyId, rpgState);
  return { success: true, state: rpgState };
});

ipcMain.handle('litrpg:delete-character', (event, { storyId, characterId }) => {
  const rpgState = db.getLitrpgState(storyId);
  if (!rpgState) return { success: false, error: 'No LitRPG state' };
  delete rpgState.characters[characterId];
  rpgState.party.members = rpgState.party.members.filter(id => id !== characterId);
  rpgState.pendingUpdates = rpgState.pendingUpdates.filter(u => u.characterId !== characterId);
  db.setLitrpgState(storyId, rpgState);
  return { success: true, state: rpgState };
});

ipcMain.handle('litrpg:reset-state', (event, { storyId }) => {
  const freshState = { ...db.LITRPG_STATE_DEFAULTS };
  db.setLitrpgState(storyId, freshState);
  return { success: true, state: freshState };
});

ipcMain.handle('litrpg:reverse-sync', (event, { entryText, entryName, storyId }) => {
  const rpgState = db.getLitrpgState(storyId) || { ...db.LITRPG_STATE_DEFAULTS };
  const result = litrpgTracker.reverseSyncCharacter(entryText, entryName, rpgState);
  return result;
});

ipcMain.handle('litrpg:reverse-sync-all', (event, { entries, storyId }) => {
  const rpgState = db.getLitrpgState(storyId) || { ...db.LITRPG_STATE_DEFAULTS };
  const results = [];
  let updatedCount = 0;
  let failedCount = 0;

  for (const entry of entries) {
    try {
      const result = litrpgTracker.reverseSyncCharacter(entry.text, entry.displayName, rpgState);
      if (result.changed && result.charId) {
        // Apply parsed data to character
        const char = rpgState.characters[result.charId];
        const parsed = result.parsed;
        if (parsed.class) char.class = parsed.class;
        if (parsed.subclass) char.subclass = parsed.subclass;
        if (parsed.level != null) char.level = parsed.level;
        if (parsed.race) char.race = parsed.race;
        if (parsed.cultivationRealm) char.cultivationRealm = parsed.cultivationRealm;
        if (parsed.cultivationStage) char.cultivationStage = parsed.cultivationStage;
        if (parsed.xp) char.xp = { ...(char.xp || {}), ...parsed.xp };
        if (parsed.stats) char.stats = { ...(char.stats || {}), ...parsed.stats };
        if (parsed.currency) char.currency = { ...(char.currency || {}), ...parsed.currency };
        if (parsed.abilities && parsed.abilities.length > 0) char.abilities = parsed.abilities;
        if (parsed.equipment && parsed.equipment.length > 0) char.equipment = parsed.equipment;
        if (parsed.inventory && parsed.inventory.length > 0) char.inventory = parsed.inventory;
        if (parsed.statusEffects && parsed.statusEffects.length > 0) char.statusEffects = parsed.statusEffects;
        updatedCount++;
      }
      results.push({ entryName: entry.displayName, success: true, ...result });
    } catch (err) {
      console.error(`[Main] Reverse sync failed for ${entry.displayName}:`, err.message);
      failedCount++;
      results.push({ entryName: entry.displayName, success: false, error: err.message });
    }
  }

  if (updatedCount > 0) {
    db.setLitrpgState(storyId, rpgState);
  }

  return { success: true, results, updatedCount, failedCount, state: rpgState };
});

// IPC Handlers — Portraits

ipcMain.handle('portrait:generate', async (event, { storyId, characterId, characterEntry, rpgData }) => {
  try {
    // Generate prompt from character data
    const generateTextFn = makeLoreGenerateTextFn();
    const prompt = await litrpgTracker.generatePortraitPrompt(
      typeof characterEntry === 'string' ? characterEntry : (characterEntry || ''),
      rpgData || {},
      generateTextFn
    );
    if (!prompt) return { success: false, error: 'Failed to generate portrait prompt' };

    // Generate image via active provider
    const providerId = store.get('provider') || 'novelai';
    const provider = PROVIDERS[providerId];
    if (!provider) return { success: false, error: 'No active image provider' };

    const imageData = await provider.generate(prompt, '', store);
    const base64 = imageData.replace(/^data:image\/[^;]+;base64,/, '');
    const buffer = Buffer.from(base64, 'base64');

    portraitManager.savePortrait(storyId, characterId, buffer);
    portraitManager.saveToAlbum(storyId, characterId, buffer);

    return {
      success: true,
      imageData,
      thumbnailData: portraitManager.getPortraitAsBase64(storyId, characterId, true),
    };
  } catch (e) {
    console.error('[Main] Portrait generate failed:', e.message);
    return { success: false, error: e.message };
  }
});

ipcMain.handle('portrait:upload', async (event, { storyId, characterId }) => {
  const { dialog } = require('electron');
  const { canceled, filePaths } = await dialog.showOpenDialog({
    filters: [{ name: 'Images', extensions: ['png', 'jpg', 'jpeg', 'webp'] }],
    properties: ['openFile'],
  });
  if (canceled || filePaths.length === 0) return { success: false };
  const buffer = fs.readFileSync(filePaths[0]);
  portraitManager.savePortrait(storyId, characterId, buffer);
  portraitManager.saveToAlbum(storyId, characterId, buffer);
  return {
    success: true,
    imageData: portraitManager.getPortraitAsBase64(storyId, characterId),
    thumbnailData: portraitManager.getPortraitAsBase64(storyId, characterId, true),
  };
});

ipcMain.handle('portrait:get', (event, { storyId, characterId, thumbnail }) => {
  return portraitManager.getPortraitAsBase64(storyId, characterId, !!thumbnail);
});

ipcMain.handle('portrait:delete', (event, { storyId, characterId }) => {
  portraitManager.deletePortrait(storyId, characterId);
  return { success: true };
});

// IPC Handlers — Portrait Album
ipcMain.handle('portrait:album-list', (event, { storyId, characterId }) => {
  return portraitManager.listAlbum(storyId, characterId);
});

ipcMain.handle('portrait:album-get', (event, { storyId, characterId, imageId }) => {
  return portraitManager.getAlbumImage(storyId, characterId, imageId);
});

ipcMain.handle('portrait:album-delete', (event, { storyId, characterId, imageId }) => {
  portraitManager.deleteAlbumImage(storyId, characterId, imageId);
  return { success: true };
});

ipcMain.handle('portrait:album-set-active', (event, { storyId, characterId, imageId }) => {
  const ok = portraitManager.setActiveFromAlbum(storyId, characterId, imageId);
  if (!ok) return { success: false, error: 'Album image not found' };
  return {
    success: true,
    imageData: portraitManager.getPortraitAsBase64(storyId, characterId),
    thumbnailData: portraitManager.getPortraitAsBase64(storyId, characterId, true),
  };
});

// IPC Handlers — Media Gallery
ipcMain.handle('media:save-image', (event, { storyId, imageDataUrl, metadata }) => {
  return mediaGallery.saveImage(storyId, imageDataUrl, metadata);
});
ipcMain.handle('media:save-video', (event, { storyId, videoDataUrl, metadata }) => {
  return mediaGallery.saveVideo(storyId, videoDataUrl, metadata);
});
ipcMain.handle('media:list', (event, { storyId, opts }) => {
  return mediaGallery.listMedia(storyId, opts);
});
ipcMain.handle('media:get-full', (event, { storyId, mediaId }) => {
  return mediaGallery.getFullImage(storyId, mediaId);
});
ipcMain.handle('media:get-thumbnail', (event, { storyId, mediaId }) => {
  return mediaGallery.getThumbnail(storyId, mediaId);
});
ipcMain.handle('media:get-video', (event, { storyId, mediaId }) => {
  return mediaGallery.getVideo(storyId, mediaId);
});
ipcMain.handle('media:delete', (event, { storyId, mediaId }) => {
  return mediaGallery.deleteMedia(storyId, mediaId);
});
ipcMain.handle('media:get-count', (event, { storyId }) => {
  return mediaGallery.getMediaCount(storyId);
});

// IPC Handlers — Story bulk load (SQLite)
ipcMain.handle('story:load-all', (event, { storyId, storyTitle }) => {
  db.upsertStory(storyId, storyTitle || '');
  const allData = db.loadAllStoryData(storyId);

  // Hydrate portrait data from filesystem for characters with portraitPath
  if (allData.litrpgState && allData.litrpgState.characters) {
    for (const [charId, char] of Object.entries(allData.litrpgState.characters)) {
      if (char.portraitPath && portraitManager.hasPortrait(storyId, charId)) {
        char._portraitData = portraitManager.getPortraitAsBase64(storyId, charId, false);
        char._thumbnailData = portraitManager.getPortraitAsBase64(storyId, charId, true);
      } else if (char.portraitPath) {
        // Portrait file missing — clear stale flag
        char.portraitPath = false;
      }
    }
  }

  return allData;
});

// IPC Handlers — Storyboard
ipcMain.handle('storyboard:list', () => storyboard.list());
ipcMain.handle('storyboard:create', (event, name) => storyboard.create(name));
ipcMain.handle('storyboard:delete', (event, id) => storyboard.delete(id));
ipcMain.handle('storyboard:rename', (event, { id, name }) => storyboard.rename(id, name));
ipcMain.handle('storyboard:set-active', (event, id) => storyboard.setActive(id));
ipcMain.handle('storyboard:get-scenes', (event, id) => storyboard.getScenes(id));
ipcMain.handle('storyboard:commit-scene', (event, { storyboardId, sceneData }) => storyboard.commitScene(storyboardId, sceneData));
ipcMain.handle('storyboard:delete-scene', (event, { storyboardId, sceneId }) => storyboard.deleteScene(storyboardId, sceneId));
ipcMain.handle('storyboard:reorder-scenes', (event, { storyboardId, sceneIds }) => storyboard.reorderScenes(storyboardId, sceneIds));
ipcMain.handle('storyboard:update-scene-note', (event, { storyboardId, sceneId, note }) => storyboard.updateSceneNote(storyboardId, sceneId, note));
ipcMain.handle('storyboard:get-scene-image', (event, { storyboardId, sceneId }) => storyboard.getSceneImage(storyboardId, sceneId));
ipcMain.handle('storyboard:get-or-create-for-story', (event, { storyId, storyTitle }) => storyboard.getOrCreateForStory(storyId, storyTitle));
ipcMain.handle('storyboard:associate-with-story', (event, { storyboardId, storyId, storyTitle }) => storyboard.associateWithStory(storyboardId, storyId, storyTitle));
ipcMain.handle('storyboard:dissociate-from-story', (event, { storyboardId }) => storyboard.dissociateFromStory(storyboardId));

app.whenReady().then(() => {
  // Initialize SQLite database
  db.init(app.getPath('userData'));

  // Initialize portrait manager
  portraitManager.init(app.getPath('userData'));

  // Initialize media gallery
  mediaGallery.init(app.getPath('userData'), db.getDb());

  // One-time migration from electron-store to SQLite
  if (!store.get('migratedToSqlite')) {
    console.log('[Main] Migrating per-story data from electron-store to SQLite...');
    db.migrateFromStore(store);
    store.set('migratedToSqlite', true);
    console.log('[Main] Migration complete');
  }

  setupTokenInterception();
  createWindow();

  // Register keyboard shortcut to open webview DevTools for DOM inspection
  globalShortcut.register('CommandOrControl+Shift+I', () => {
    const allContents = webContents.getAllWebContents();
    const wv = allContents.find(wc => wc.getURL().includes('novelai.net'));
    if (wv) {
      wv.openDevTools({ mode: 'detach' });
      console.log('[Main] Opened webview DevTools via shortcut');
    }
  });

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) {
      createWindow();
    }
  });
});

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') {
    app.quit();
  }
});

app.on('will-quit', () => {
  db.close();
});
