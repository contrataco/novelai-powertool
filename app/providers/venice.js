// Venice AI Image + Video Generation Provider
// API Docs: https://docs.venice.ai/api-reference

const MAX_DIMENSION = 1280;
const API_BASE = 'https://api.venice.ai/api/v1';

// Cache for models and styles lists
let modelsCache = null;
let modelsCacheTime = 0;
let stylesCache = null;
let stylesCacheTime = 0;
let videoModelsCache = null;
let videoModelsCacheTime = 0;
const CACHE_TTL_MS = 10 * 60 * 1000; // 10 minutes

// Credit balance state (updated after every API response)
let lastBalance = null;

/**
 * Capture balance/rate-limit headers from a Venice API response.
 */
function captureBalanceHeaders(res) {
  const usd = res.headers.get('x-venice-balance-usd');
  const diem = res.headers.get('x-venice-balance-diem');
  const remaining = res.headers.get('x-ratelimit-remaining-requests');
  if (usd !== null || diem !== null || remaining !== null) {
    lastBalance = {
      usd: usd !== null ? parseFloat(usd) : (lastBalance?.usd ?? null),
      diem: diem !== null ? parseFloat(diem) : (lastBalance?.diem ?? null),
      remainingRequests: remaining !== null ? parseInt(remaining, 10) : (lastBalance?.remainingRequests ?? null),
      timestamp: Date.now(),
    };
    console.log(`[Venice] Balance: $${lastBalance.usd?.toFixed(2) ?? '?'}, ${lastBalance.remainingRequests ?? '?'} requests remaining`);
  }
}

/**
 * Fetch the list of available image generation models from Venice API.
 */
async function fetchModels(apiKey) {
  const now = Date.now();
  if (modelsCache && (now - modelsCacheTime) < CACHE_TTL_MS) {
    return modelsCache;
  }

  try {
    const res = await fetch(`${API_BASE}/models?type=image`, {
      headers: { 'Authorization': `Bearer ${apiKey}` },
    });
    captureBalanceHeaders(res);
    if (!res.ok) {
      console.log(`[Venice] Failed to fetch models: HTTP ${res.status}`);
      return modelsCache || [];
    }
    const data = await res.json();
    modelsCache = (data.data || [])
      .filter(m => !m.offline)
      .map(m => ({
        id: m.id,
        name: m.name || m.id,
        constraints: m.model_spec?.constraints || {},
      }));
    modelsCacheTime = now;
    console.log(`[Venice] Fetched ${modelsCache.length} image models`);
    return modelsCache;
  } catch (e) {
    console.log('[Venice] Error fetching models:', e.message);
    return modelsCache || [];
  }
}

/**
 * Fetch the list of available style presets from Venice API.
 */
async function fetchStyles(apiKey) {
  const now = Date.now();
  if (stylesCache && (now - stylesCacheTime) < CACHE_TTL_MS) {
    return stylesCache;
  }

  try {
    const res = await fetch(`${API_BASE}/image/styles`, {
      headers: { 'Authorization': `Bearer ${apiKey}` },
    });
    captureBalanceHeaders(res);
    if (!res.ok) {
      console.log(`[Venice] Failed to fetch styles: HTTP ${res.status}`);
      return stylesCache || [];
    }
    const data = await res.json();
    stylesCache = (data.data || data || []).map(s => ({
      id: s.id || s,
      name: s.name || s.id || s,
    }));
    stylesCacheTime = now;
    console.log(`[Venice] Fetched ${stylesCache.length} style presets`);
    return stylesCache;
  } catch (e) {
    console.log('[Venice] Error fetching styles:', e.message);
    return stylesCache || [];
  }
}

/**
 * Fetch the list of available video generation models from Venice API.
 */
async function fetchVideoModels(apiKey) {
  const now = Date.now();
  if (videoModelsCache && (now - videoModelsCacheTime) < CACHE_TTL_MS) {
    return videoModelsCache;
  }

  try {
    const res = await fetch(`${API_BASE}/models?type=video`, {
      headers: { 'Authorization': `Bearer ${apiKey}` },
    });
    captureBalanceHeaders(res);
    if (!res.ok) {
      console.log(`[Venice] Failed to fetch video models: HTTP ${res.status}`);
      return videoModelsCache || [];
    }
    const data = await res.json();
    videoModelsCache = (data.data || [])
      .filter(m => !m.offline)
      .map(m => ({
        id: m.id,
        name: m.name || m.id,
        constraints: m.model_spec?.constraints || {},
      }));
    videoModelsCacheTime = now;
    console.log(`[Venice] Fetched ${videoModelsCache.length} video models`);
    return videoModelsCache;
  } catch (e) {
    console.log('[Venice] Error fetching video models:', e.message);
    return videoModelsCache || [];
  }
}

// Kokoro TTS voices (tts-kokoro)
const KOKORO_VOICES = [
  { id: 'af_heart', name: 'Heart (American Female)' },
  { id: 'af_alloy', name: 'Alloy (American Female)' },
  { id: 'af_aoede', name: 'Aoede (American Female)' },
  { id: 'af_bella', name: 'Bella (American Female)' },
  { id: 'af_jadzia', name: 'Jadzia (American Female)' },
  { id: 'af_jessica', name: 'Jessica (American Female)' },
  { id: 'af_kore', name: 'Kore (American Female)' },
  { id: 'af_nicole', name: 'Nicole (American Female)' },
  { id: 'af_nova', name: 'Nova (American Female)' },
  { id: 'af_river', name: 'River (American Female)' },
  { id: 'af_sarah', name: 'Sarah (American Female)' },
  { id: 'af_sky', name: 'Sky (American Female)' },
  { id: 'am_adam', name: 'Adam (American Male)' },
  { id: 'am_echo', name: 'Echo (American Male)' },
  { id: 'am_eric', name: 'Eric (American Male)' },
  { id: 'am_fenrir', name: 'Fenrir (American Male)' },
  { id: 'am_liam', name: 'Liam (American Male)' },
  { id: 'am_michael', name: 'Michael (American Male)' },
  { id: 'am_onyx', name: 'Onyx (American Male)' },
  { id: 'am_puck', name: 'Puck (American Male)' },
  { id: 'am_santa', name: 'Santa (American Male)' },
  { id: 'bf_alice', name: 'Alice (British Female)' },
  { id: 'bf_emma', name: 'Emma (British Female)' },
  { id: 'bf_lily', name: 'Lily (British Female)' },
  { id: 'bm_daniel', name: 'Daniel (British Male)' },
  { id: 'bm_fable', name: 'Fable (British Male)' },
  { id: 'bm_george', name: 'George (British Male)' },
  { id: 'bm_lewis', name: 'Lewis (British Male)' },
  { id: 'em_alex', name: 'Alex (Expressive)' },
  { id: 'em_santa', name: 'Santa (Expressive)' },
];

// Qwen3 TTS voices (tts-qwen3-0-6b, tts-qwen3-1-7b)
const QWEN3_VOICES = [
  { id: 'Vivian', name: 'Vivian' },
  { id: 'Serena', name: 'Serena' },
  { id: 'Ono_Anna', name: 'Ono Anna' },
  { id: 'Sohee', name: 'Sohee' },
  { id: 'Uncle_Fu', name: 'Uncle Fu' },
  { id: 'Dylan', name: 'Dylan' },
  { id: 'Eric', name: 'Eric' },
  { id: 'Ryan', name: 'Ryan' },
  { id: 'Aiden', name: 'Aiden' },
];

module.exports = {
  id: 'venice',
  name: 'Venice AI',

  checkReady(store) {
    return !!store.get('veniceApiKey');
  },

  getModels() {
    return modelsCache || [];
  },

  getArtStyles() {
    return stylesCache || [];
  },

  getBalance() {
    return lastBalance;
  },

  async fetchModelsForUI(store) {
    const apiKey = store.get('veniceApiKey');
    if (!apiKey) return [];
    return fetchModels(apiKey);
  },

  async fetchStylesForUI(store) {
    const apiKey = store.get('veniceApiKey');
    if (!apiKey) return [];
    return fetchStyles(apiKey);
  },

  async fetchVideoModelsForUI(store) {
    const apiKey = store.get('veniceApiKey');
    if (!apiKey) return [];
    return fetchVideoModels(apiKey);
  },

  async generate(prompt, negativePrompt, store) {
    const apiKey = store.get('veniceApiKey');
    if (!apiKey) {
      throw new Error('No Venice AI API key configured. Add one in Settings.');
    }

    const settings = store.get('imageSettings');
    const model = store.get('veniceModel') || 'flux-2-max';
    const steps = store.get('veniceSteps') || 25;
    const cfgScale = store.get('veniceCfgScale') || 7;
    const stylePreset = store.get('veniceStylePreset') || '';
    const safeMode = store.get('veniceSafeMode') || false;
    const hideWatermark = store.get('veniceHideWatermark') !== false;

    const width = Math.min(settings.width || 1024, MAX_DIMENSION);
    const height = Math.min(settings.height || 1024, MAX_DIMENSION);

    console.log(`[Venice] Generating with model=${model}, ${width}x${height}, steps=${steps}, cfg=${cfgScale}`);

    const body = {
      model,
      prompt,
      width,
      height,
      steps,
      cfg_scale: cfgScale,
      safe_mode: safeMode,
      hide_watermark: hideWatermark,
      format: 'png',
    };

    if (negativePrompt) {
      body.negative_prompt = negativePrompt;
    }

    if (stylePreset) {
      body.style_preset = stylePreset;
    }

    const seed = Math.floor(Math.random() * 999999999);
    body.seed = seed;

    const res = await fetch(`${API_BASE}/image/generate`, {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${apiKey}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify(body),
    });

    captureBalanceHeaders(res);

    if (!res.ok) {
      const errorText = await res.text();
      throw new Error(`Venice API error ${res.status}: ${errorText.substring(0, 300)}`);
    }

    const data = await res.json();

    if (!data.images || data.images.length === 0) {
      throw new Error('Venice API returned no images: ' + JSON.stringify(data).substring(0, 300));
    }

    const base64 = data.images[0];
    console.log('[Venice] Image generated successfully');
    return `data:image/png;base64,${base64}`;
  },

  // ---------------------------------------------------------------------------
  // Video generation
  // ---------------------------------------------------------------------------

  async quoteVideo(prompt, store, opts = {}) {
    const apiKey = store.get('veniceApiKey');
    if (!apiKey) throw new Error('No Venice AI API key configured.');

    const model = opts.model || store.get('veniceVideoModel') || '';
    const duration = opts.duration || store.get('veniceVideoDuration') || '5s';
    const resolution = opts.resolution || store.get('veniceVideoResolution') || '1080p';

    const body = { model, duration, resolution };
    body.aspect_ratio = opts.aspect_ratio || store.get('veniceVideoAspectRatio') || '16:9';

    const res = await fetch(`${API_BASE}/video/quote`, {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${apiKey}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify(body),
    });
    captureBalanceHeaders(res);

    if (!res.ok) {
      const errorText = await res.text();
      throw new Error(`Venice video quote error ${res.status}: ${errorText.substring(0, 300)}`);
    }
    return res.json();
  },

  async queueVideo(prompt, imageDataUrl, store, opts = {}) {
    const apiKey = store.get('veniceApiKey');
    if (!apiKey) throw new Error('No Venice AI API key configured.');

    const model = opts.model || store.get('veniceVideoModel') || '';
    const duration = opts.duration || store.get('veniceVideoDuration') || '5s';
    const resolution = opts.resolution || store.get('veniceVideoResolution') || '1080p';

    if (!model) throw new Error('No video model selected. Configure one in Settings.');

    const body = {
      model,
      prompt,
      duration,
      resolution,
      aspect_ratio: opts.aspect_ratio || store.get('veniceVideoAspectRatio') || '16:9',
    };
    if (imageDataUrl) body.image_url = imageDataUrl;
    if (opts.negative_prompt) body.negative_prompt = opts.negative_prompt;

    console.log(`[Venice] Queuing video: model=${model}, duration=${duration}, resolution=${resolution}`);

    const res = await fetch(`${API_BASE}/video/queue`, {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${apiKey}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify(body),
    });
    captureBalanceHeaders(res);

    if (!res.ok) {
      const errorText = await res.text();
      throw new Error(`Venice video queue error ${res.status}: ${errorText.substring(0, 300)}`);
    }

    const data = await res.json();
    console.log(`[Venice] Video queued: queue_id=${data.queue_id}, model=${data.model}`);
    return data;
  },

  // ---------------------------------------------------------------------------
  // Text-to-Speech
  // ---------------------------------------------------------------------------

  getTtsModels() {
    return [
      { id: 'tts-kokoro', name: 'Kokoro' },
      { id: 'tts-qwen3-0-6b', name: 'Qwen3 0.6B' },
      { id: 'tts-qwen3-1-7b', name: 'Qwen3 1.7B' },
    ];
  },

  getVoices(ttsModel) {
    if (ttsModel === 'tts-qwen3-0-6b' || ttsModel === 'tts-qwen3-1-7b') {
      return QWEN3_VOICES;
    }
    return KOKORO_VOICES;
  },

  async generateSpeech(text, voice, store) {
    const apiKey = store.get('veniceApiKey');
    if (!apiKey) throw new Error('No Venice AI API key configured.');

    const speed = store.get('ttsSpeed') || 1.0;
    const ttsModel = store.get('veniceTtsModel') || 'tts-kokoro';

    const res = await fetch(`${API_BASE}/audio/speech`, {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${apiKey}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        input: text,
        model: ttsModel,
        voice,
        response_format: 'mp3',
        speed,
      }),
    });

    captureBalanceHeaders(res);

    if (!res.ok) {
      const errorText = await res.text();
      throw new Error(`Venice TTS error ${res.status}: ${errorText.substring(0, 300)}`);
    }

    const buf = Buffer.from(await res.arrayBuffer());
    return { audioData: `data:audio/mp3;base64,${buf.toString('base64')}`, format: 'mp3' };
  },

  async retrieveVideo(queueId, model, store) {
    const apiKey = store.get('veniceApiKey');
    if (!apiKey) throw new Error('No Venice AI API key configured.');

    const res = await fetch(`${API_BASE}/video/retrieve`, {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${apiKey}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({ queue_id: queueId, model }),
    });
    captureBalanceHeaders(res);

    if (!res.ok) {
      const errorText = await res.text();
      throw new Error(`Venice video retrieve error ${res.status}: ${errorText.substring(0, 300)}`);
    }

    const contentType = res.headers.get('content-type') || '';
    console.log(`[Venice] Video retrieve — status: ${res.status}, content-type: ${contentType}`);

    if (contentType.includes('video/')) {
      // Completed — return video as base64 data URL
      const buffer = Buffer.from(await res.arrayBuffer());
      const base64 = buffer.toString('base64');
      const mimeType = contentType.split(';')[0].trim();
      console.log(`[Venice] Video retrieved successfully (${(buffer.length / 1024 / 1024).toFixed(1)} MB)`);
      return { status: 'completed', videoDataUrl: `data:${mimeType};base64,${base64}` };
    }

    // Still processing — JSON response
    const data = await res.json();
    console.log(`[Venice] Video status: ${data.status}, duration: ${data.execution_duration}ms / avg: ${data.average_execution_time}ms`);
    return {
      status: 'processing',
      averageExecutionTime: data.average_execution_time,
      executionDuration: data.execution_duration,
    };
  },
};
