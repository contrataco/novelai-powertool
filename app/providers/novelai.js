const AdmZip = require('adm-zip');

// Art style presets for NovelAI (danbooru-compatible tags)
const ART_STYLES = {
  'no-style': {
    name: 'No Style',
    prompt: '',
    negative: '',
  },
  'anime': {
    name: 'Anime',
    prompt: ', anime coloring, cel shading, detailed, vibrant colors',
    negative: '',
  },
  'cinematic': {
    name: 'Cinematic',
    prompt: ', cinematic lighting, dramatic atmosphere, depth of field, bokeh',
    negative: 'flat lighting, boring composition',
  },
  'digital-painting': {
    name: 'Digital Painting',
    prompt: ', digital media, illustration, highly detailed',
    negative: '',
  },
  'oil-painting': {
    name: 'Oil Painting',
    prompt: ', oil painting (medium), painterly, traditional media, canvas texture, rich colors',
    negative: '',
  },
  'watercolor': {
    name: 'Watercolor',
    prompt: ', watercolor (medium), traditional media, soft edges, textured paper',
    negative: '',
  },
  'fantasy-art': {
    name: 'Fantasy Art',
    prompt: ', fantasy, epic, dramatic lighting, detailed background, magical atmosphere',
    negative: '',
  },
  'manga': {
    name: 'Manga',
    prompt: ', monochrome, greyscale, ink, lineart, screentone',
    negative: 'color',
  },
  'concept-art': {
    name: 'Concept Art',
    prompt: ', concept art, illustration, cinematic composition, dynamic lighting',
    negative: '',
  },
  'painted-anime': {
    name: 'Painted Anime',
    prompt: ', painterly, no lineart, soft shading, vibrant, detailed background',
    negative: 'flat colors',
  },
  'pixel-art': {
    name: 'Pixel Art',
    prompt: ', pixel art, retro game style, 16-bit, clean pixels, sprite art',
    negative: 'blurry, smooth, photorealistic',
  },
};

// Model configurations
const MODEL_CONFIG = {
  // V3 Models (support SMEA)
  'nai-diffusion-3': { isV4: false, name: 'NAI Diffusion Anime V3' },
  'nai-diffusion-furry-3': { isV4: false, name: 'NAI Diffusion Furry V3' },
  // V4 Models
  'nai-diffusion-4-curated-preview': { isV4: true, name: 'NAI Diffusion V4 Curated' },
  'nai-diffusion-4-full': { isV4: true, name: 'NAI Diffusion V4 Full' },
  // V4.5 Models
  'nai-diffusion-4-5-curated': { isV4: true, name: 'NAI Diffusion V4.5 Curated' },
  'nai-diffusion-4-5-full': { isV4: true, name: 'NAI Diffusion V4.5 Full' },
};

// Quality presets per model
const QUALITY_PRESETS = {
  'nai-diffusion-3': ', best quality, amazing quality, very aesthetic, absurdres',
  'nai-diffusion-furry-3': ', {best quality}, {amazing quality}',
  'nai-diffusion-4-curated-preview': ', rating:general, amazing quality, very aesthetic, absurdres',
  'nai-diffusion-4-full': ', no text, best quality, very aesthetic, absurdres',
  'nai-diffusion-4-5-curated': ', very aesthetic, masterpiece, absurdres, no text, rating:general',
  'nai-diffusion-4-5-full': ', very aesthetic, masterpiece, absurdres, no text',
};

// Negative prompt presets
const UC_PRESETS = {
  'nai-diffusion-3': {
    heavy: 'lowres, {bad}, error, fewer, extra, missing, worst quality, jpeg artifacts, bad quality, watermark, unfinished, displeasing, chromatic aberration, signature, extra digits, artistic error, username, scan, [abstract],',
    light: 'lowres, jpeg artifacts, worst quality, watermark, blurry, very displeasing,',
    human: 'lowres, {bad}, error, fewer, extra, missing, worst quality, jpeg artifacts, bad quality, watermark, unfinished, displeasing, chromatic aberration, signature, extra digits, artistic error, username, scan, [abstract], bad anatomy, bad hands, @_@, mismatched pupils, heart-shaped pupils, glowing eyes,',
  },
  'nai-diffusion-furry-3': {
    heavy: '{{worst quality}}, [displeasing], {unusual pupils}, guide lines, {{unfinished}}, {bad}, url, artist name, {{tall image}}, mosaic, {sketch page}, comic panel, impact (font), [dated], {logo}, ych,',
    light: '{worst quality}, guide lines, unfinished, bad, url, tall image, widescreen, compression artifacts,',
    human: '{{worst quality}}, [displeasing], {unusual pupils}, guide lines, {{unfinished}}, {bad}, url, artist name, {{tall image}}, mosaic, {sketch page}, comic panel, impact (font), [dated], {logo}, ych, bad anatomy, bad hands,',
  },
  'nai-diffusion-4-curated-preview': {
    heavy: 'blurry, lowres, error, film grain, scan artifacts, worst quality, bad quality, jpeg artifacts, very displeasing, chromatic aberration, logo, dated, signature, multiple views, gigantic breasts, white blank page, blank page,',
    light: 'blurry, lowres, error, worst quality, bad quality, jpeg artifacts, very displeasing, logo, dated, signature, white blank page, blank page,',
    human: 'blurry, lowres, error, film grain, scan artifacts, worst quality, bad quality, jpeg artifacts, very displeasing, chromatic aberration, logo, dated, signature, multiple views, gigantic breasts, white blank page, blank page, bad anatomy, bad hands, extra fingers, fewer fingers, extra limbs, missing limbs, fused fingers, poorly drawn hands, poorly drawn face, @_@, mismatched pupils, glowing eyes,',
  },
  'nai-diffusion-4-full': {
    heavy: 'blurry, lowres, error, film grain, scan artifacts, worst quality, bad quality, jpeg artifacts, very displeasing, chromatic aberration, multiple views, logo, too many watermarks, white blank page, blank page,',
    light: 'blurry, lowres, error, worst quality, bad quality, jpeg artifacts, very displeasing, white blank page, blank page,',
    human: 'blurry, lowres, error, film grain, scan artifacts, worst quality, bad quality, jpeg artifacts, very displeasing, chromatic aberration, multiple views, logo, too many watermarks, white blank page, blank page, bad anatomy, bad hands, extra fingers, fewer fingers, extra limbs, missing limbs, fused fingers, poorly drawn hands, poorly drawn face, @_@, mismatched pupils, glowing eyes,',
  },
  'nai-diffusion-4-5-curated': {
    heavy: 'blurry, lowres, upscaled, artistic error, film grain, scan artifacts, worst quality, bad quality, jpeg artifacts, very displeasing, chromatic aberration, halftone, multiple views, logo, too many watermarks, negative space, blank page,',
    light: 'blurry, lowres, upscaled, artistic error, scan artifacts, jpeg artifacts, logo, too many watermarks, negative space, blank page,',
    human: 'blurry, lowres, upscaled, artistic error, film grain, scan artifacts, worst quality, bad quality, jpeg artifacts, very displeasing, chromatic aberration, halftone, multiple views, logo, too many watermarks, bad anatomy, bad hands, extra fingers, fewer fingers, extra limbs, missing limbs, fused fingers, poorly drawn hands, poorly drawn face, @_@, mismatched pupils, glowing eyes, negative space, blank page,',
  },
  'nai-diffusion-4-5-full': {
    heavy: 'lowres, artistic error, film grain, scan artifacts, worst quality, bad quality, jpeg artifacts, very displeasing, chromatic aberration, dithering, halftone, screentone, multiple views, logo, too many watermarks, negative space, blank page,',
    light: 'lowres, artistic error, scan artifacts, worst quality, bad quality, jpeg artifacts, multiple views, very displeasing, too many watermarks, negative space, blank page,',
    human: 'lowres, artistic error, film grain, scan artifacts, worst quality, bad quality, jpeg artifacts, very displeasing, chromatic aberration, dithering, halftone, screentone, multiple views, logo, too many watermarks, bad anatomy, bad hands, extra fingers, fewer fingers, extra limbs, missing limbs, fused fingers, poorly drawn hands, poorly drawn face, @_@, mismatched pupils, glowing eyes, negative space, blank page,',
  },
};

module.exports = {
  id: 'novelai',
  name: 'NovelAI',

  checkReady(store) {
    return !!store.get('apiToken');
  },

  getModels() {
    return Object.entries(MODEL_CONFIG).map(([id, config]) => ({
      id,
      name: config.name,
      isV4: config.isV4
    }));
  },

  getArtStyles() {
    return Object.entries(ART_STYLES).map(([id, style]) => ({
      id,
      name: style.name,
    }));
  },

  // Resolve an art style ID to its prompt tags string (for LLM scene prompt injection)
  getArtStyleTags(styleId) {
    const style = ART_STYLES[styleId] || ART_STYLES['no-style'];
    // Return trimmed prompt (strip leading ", ")
    return style.prompt ? style.prompt.replace(/^,\s*/, '') : '';
  },

  // Compute the suffix tags that would be appended to a prompt (art style + quality tags).
  // Used by renderer to show the full final prompt in the textarea.
  getPromptSuffix(store) {
    const settings = store.get('imageSettings') || {};
    const model = settings.model || 'nai-diffusion-4-5-full';
    const artStyleId = store.get('novelaiArtStyle') || 'no-style';
    const artStyle = ART_STYLES[artStyleId] || ART_STYLES['no-style'];
    const qualityTags = settings.qualityTags !== false ? (QUALITY_PRESETS[model] || '') : '';
    return {
      artStyleSuffix: artStyle.prompt || '',
      qualitySuffix: qualityTags || '',
      combined: (artStyle.prompt || '') + (qualityTags || ''),
    };
  },

  // Compute the negative prompt suffix (art style negative + UC preset) for preview.
  getNegativeSuffix(store) {
    const settings = store.get('imageSettings') || {};
    const model = settings.model || 'nai-diffusion-4-5-full';
    const artStyleId = store.get('novelaiArtStyle') || 'no-style';
    const artStyle = ART_STYLES[artStyleId] || ART_STYLES['no-style'];
    const ucPresets = UC_PRESETS[model] || UC_PRESETS['nai-diffusion-4-curated-preview'];
    const ucPreset = settings.ucPreset || 'heavy';
    const baseNegative = ucPresets[ucPreset] || ucPresets.heavy;
    const styleNegative = artStyle.negative || '';
    return {
      styleNegative,
      ucPresetNegative: baseNegative || '',
      combined: [styleNegative, baseNegative].filter(Boolean).join(', '),
    };
  },

  async generate(prompt, negativePrompt, store, options = {}) {
    const apiToken = store.get('apiToken');
    if (!apiToken) {
      throw new Error('No API token configured. Please set your NovelAI API token.');
    }

    const settings = store.get('imageSettings');
    const model = settings.model || 'nai-diffusion-4-5-full';
    const modelConfig = MODEL_CONFIG[model] || { isV4: true };
    const seed = Math.floor(Math.random() * 4294967295);

    // Get art style
    const artStyleId = store.get('novelaiArtStyle') || 'no-style';
    const artStyle = ART_STYLES[artStyleId] || ART_STYLES['no-style'];

    // Build negative prompt — skip combining if rawNegativePrompt (already baked in)
    let finalNegative;
    if (options.rawNegativePrompt) {
      finalNegative = negativePrompt || '';
    } else {
      const ucPresets = UC_PRESETS[model] || UC_PRESETS['nai-diffusion-4-curated-preview'];
      let ucPreset = settings.ucPreset || 'heavy';
      // Auto-upgrade to human-focus UC when characters are detected in prompt or charCaptions
      if (ucPreset === 'heavy') {
        const hasChars = options.charCaptions?.length > 0
          || /\b\d*(girl|boy|woman|man|people|person|character)\b/i.test(prompt);
        if (hasChars) ucPreset = 'human';
      }
      const baseNegative = ucPresets[ucPreset] || ucPresets.heavy;
      const styleNegative = artStyle.negative;
      const negParts = [negativePrompt, styleNegative, baseNegative].filter(Boolean);
      finalNegative = negParts.join(', ');
    }

    // Get quality tags for model — skip if rawPrompt (tags already baked into prompt)
    let finalPrompt;
    if (options.rawPrompt) {
      finalPrompt = prompt;
    } else {
      const qualityTags = settings.qualityTags ? (QUALITY_PRESETS[model] || '') : '';
      finalPrompt = prompt + artStyle.prompt + qualityTags;
    }

    console.log(`[NovelAI] Using model: ${model}, isV4: ${modelConfig.isV4}`);
    if (options.charCaptions?.length) {
      console.log(`[NovelAI] Using ${options.charCaptions.length} char_captions for V4+ structured prompt`);
    }

    // Build request body
    const requestBody = {
      model: model,
      action: 'generate',
      input: finalPrompt,
      parameters: {
        width: settings.width,
        height: settings.height,
        steps: settings.steps,
        scale: settings.scale,
        sampler: settings.sampler,
        n_samples: 1,
        seed: seed,
        negative_prompt: finalNegative,
        cfg_rescale: 0,
        noise_schedule: 'native',
      }
    };

    // Add model-specific parameters
    if (modelConfig.isV4) {
      const noiseSchedule = 'native';
      const v4Params = {
        params_version: 1,
        legacy: false,
        legacy_uc: false,
        legacy_v3_extend: false,
        dynamic_thresholding: false,
        qualityToggle: false, // we append our own quality tags via QUALITY_PRESETS — API must not double-add
        sm: false,
        sm_dyn: false,
        autoSmea: false,
        ucPreset: 3,
        use_coords: false,
        uncond_scale: 1.0,
        controlnet_strength: 1.0,
        add_original_image: false,
        reference_image_multiple: [],
        reference_information_extracted_multiple: [],
        reference_strength_multiple: [],
        extra_noise_seed: seed,
        v4_prompt: {
          use_coords: false,
          use_order: false,
          caption: {
            base_caption: finalPrompt,
            char_captions: []
          }
        },
        v4_negative_prompt: {
          use_coords: false,
          use_order: false,
          caption: {
            base_caption: finalNegative,
            char_captions: []
          }
        }
      };

      // Only add euler ancestral params when using that sampler with non-native schedule
      if (settings.sampler === 'k_euler_ancestral' && noiseSchedule !== 'native') {
        v4Params.deliberate_euler_ancestral_bug = false;
        v4Params.prefer_brownian = true;
      }

      // Populate char_captions if structured prompt data provided
      if (options.charCaptions && options.charCaptions.length > 0) {
        // Base caption = scene/environment only (with suffixes if not raw)
        let baseCaption;
        if (options.rawPrompt) {
          baseCaption = options.baseCaption || prompt;
        } else {
          const qualityTags = settings.qualityTags ? (QUALITY_PRESETS[model] || '') : '';
          baseCaption = (options.baseCaption || prompt) + artStyle.prompt + qualityTags;
        }
        v4Params.v4_prompt.caption.base_caption = baseCaption;
        // Strip internal _name field before sending to API
        v4Params.v4_prompt.caption.char_captions = options.charCaptions.map(c => ({
          char_caption: c.char_caption,
          centers: c.centers,
        }));
        console.log('[NovelAI] V4 char_captions payload:', JSON.stringify(
          v4Params.v4_prompt.caption.char_captions.map(c => ({
            centers: c.centers,
            tags: c.char_caption?.substring(0, 60),
          })), null, 2));
        console.log('[NovelAI] V4 base_caption:', v4Params.v4_prompt.caption.base_caption?.substring(0, 80) + '...');
      }

      Object.assign(requestBody.parameters, v4Params);
    } else {
      Object.assign(requestBody.parameters, {
        legacy: false,
        qualityToggle: settings.qualityTags,
        sm: settings.smea || false,
        sm_dyn: settings.smeaDyn || false,
      });
    }

    console.log('[NovelAI] Generating image with prompt:', prompt.substring(0, 100) + '...');

    const response = await fetch('https://image.novelai.net/ai/generate-image', {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${apiToken}`,
        'Content-Type': 'application/json',
        'Accept': 'application/zip'
      },
      body: JSON.stringify(requestBody)
    });

    if (!response.ok) {
      const errorText = await response.text();
      throw new Error(`API Error ${response.status}: ${errorText}`);
    }

    // Response is a ZIP file containing the image
    const arrayBuffer = await response.arrayBuffer();
    const buffer = Buffer.from(arrayBuffer);
    const zip = new AdmZip(buffer);
    const zipEntries = zip.getEntries();

    const imageEntry = zipEntries.find(entry =>
      entry.entryName.endsWith('.png') || entry.entryName.endsWith('.jpg')
    );

    if (!imageEntry) {
      throw new Error('No image found in response');
    }

    const imageBuffer = imageEntry.getData();
    const base64 = imageBuffer.toString('base64');
    const mimeType = imageEntry.entryName.endsWith('.png') ? 'image/png' : 'image/jpeg';

    console.log('[NovelAI] Image generated successfully');
    return `data:${mimeType};base64,${base64}`;
  },

  /**
   * Generate text via NovelAI's OpenAI-compatible chat API (GLM-4-6).
   * Endpoint streams SSE chunks; we accumulate delta.content text.
   */
  async generateText(messages, options, store) {
    const apiToken = store.get('apiToken');
    if (!apiToken) throw new Error('No API token available');

    const model = options.model || 'glm-4-6';
    const maxTokens = options.max_tokens || 300;
    const temperature = options.temperature || 0.6;

    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 60000);

    let response;
    try {
      response = await fetch('https://text.novelai.net/oa/v1/chat/completions', {
        method: 'POST',
        headers: {
          'Authorization': `Bearer ${apiToken}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          model,
          messages,
          max_tokens: maxTokens,
          temperature,
          stream: true,
        }),
        signal: controller.signal,
      });
    } catch (err) {
      clearTimeout(timeout);
      if (err.name === 'AbortError') throw new Error('NovelAI text API timed out after 60s');
      throw err;
    }

    if (!response.ok) {
      clearTimeout(timeout);
      const text = await response.text();
      throw new Error(`NovelAI text API error ${response.status}: ${text}`);
    }

    // Read SSE stream and accumulate text from delta.content
    const rawText = await response.text();
    clearTimeout(timeout);
    let fullText = '';
    const lines = rawText.split('\n');
    for (const line of lines) {
      if (!line.startsWith('data: ') || line.trim() === 'data: [DONE]') continue;
      try {
        const chunk = JSON.parse(line.slice(6));
        if (chunk.choices?.[0]?.delta?.content) {
          fullText += chunk.choices[0].delta.content;
        } else if (chunk.choices?.[0]?.text && chunk.choices[0].text.length > 0) {
          fullText += chunk.choices[0].text;
        }
      } catch (e) {
        // Skip unparseable chunks
      }
    }

    return { output: fullText };
  },

  // ---------------------------------------------------------------------------
  // Text-to-Speech
  // ---------------------------------------------------------------------------

  // V1 preset voices (use numeric speaker IDs)
  V1_VOICES: ['Cyllene', 'Leucosia', 'Crina', 'Hespe', 'Ida', 'Alseid', 'Daphnis', 'Echo', 'Thel', 'Nomios'],
  // V1 speaker ID map (name → numeric sid)
  V1_SID: { Cyllene: 17, Leucosia: 95, Crina: 44, Hespe: 80, Ida: 106, Alseid: 6, Daphnis: 10, Echo: 16, Thel: 41, Nomios: 77 },
  // V2 preset seeds (use string seed, voice=-1)
  V2_VOICES: ['Aini', 'Orea', 'Claea', 'Lim', 'Aurae', 'Naia', 'Ligeia', 'Aulon', 'Elei', 'Ogma', 'Raid', 'Pega', 'Lam'],
  // Set for fast lookup
  _v1Set: null,
  _v2Set: null,
  getV1Set() { if (!this._v1Set) this._v1Set = new Set(this.V1_VOICES); return this._v1Set; },
  getV2Set() { if (!this._v2Set) this._v2Set = new Set(this.V2_VOICES); return this._v2Set; },

  /**
   * Returns all voice presets grouped by version, plus a custom option.
   * Each voice: { id, name, version: 'v1'|'v2', category: 'novelai' }
   */
  getVoiceSeeds() {
    const voices = [];
    for (const s of this.V2_VOICES) {
      voices.push({ id: s, name: s, version: 'v2', category: 'novelai' });
    }
    for (const s of this.V1_VOICES) {
      voices.push({ id: s, name: s, version: 'v1', category: 'novelai' });
    }
    return voices;
  },

  /**
   * Determine the best TTS version for a voice value.
   * v2 objects always use v2. Known v2 presets use v2. Known v1 presets use v1.
   * Unknown seeds (custom) use the provided default or 'v2'.
   */
  detectVoiceVersion(voice, defaultVersion = 'v2') {
    if (voice && typeof voice === 'object' && voice.v === 2) return 'v2';
    if (typeof voice === 'string') {
      if (this.getV2Set().has(voice)) return 'v2';
      if (this.getV1Set().has(voice)) return 'v1';
    }
    return defaultVersion;
  },

  /**
   * Normalize a voice config into URL params.
   * V1 voices use numeric speaker IDs (sid). V2 voices use string seed with voice=-1.
   * @param {string} voice — preset name string
   * @param {string} ttsVersion — 'v1', 'v2', or 'auto' (default 'auto')
   * @returns {object} key-value pairs for URLSearchParams
   */
  normalizeVoiceConfig(voice, ttsVersion = 'auto') {
    const seed = (typeof voice === 'string' && voice) ? voice : 'Aini';
    const resolvedVersion = ttsVersion === 'auto' ? this.detectVoiceVersion(seed) : ttsVersion;
    if (resolvedVersion === 'v1') {
      // V1: numeric speaker ID + seed name
      const sid = this.V1_SID[seed];
      return { seed, voice: String(sid != null ? sid : -1), opus: 'false', version: 'v1' };
    }
    // V2: string seed, voice=-1
    return { seed, voice: '-1', opus: 'false', version: 'v2' };
  },

  async generateSpeech(text, voice, store, ttsVersion) {
    const token = store.get('apiToken');
    if (!token) throw new Error('No API token configured.');

    const voiceParams = this.normalizeVoiceConfig(voice, ttsVersion || 'auto');
    const params = new URLSearchParams({ text, ...voiceParams });
    const url = `https://api.novelai.net/ai/generate-voice?${params}`;
    console.log('[TTS] Request:', { voice, version: voiceParams.version, url: url.replace(/Bearer\s+\S+/, 'Bearer ***') });
    const res = await fetch(url, {
      headers: { 'Authorization': `Bearer ${token}` },
    });

    if (!res.ok) {
      const errorText = await res.text();
      console.error('[TTS] Error response:', res.status, errorText.substring(0, 500));
      throw new Error(`NovelAI TTS error ${res.status}: ${errorText.substring(0, 300)}`);
    }

    const buf = Buffer.from(await res.arrayBuffer());
    return { audioData: `data:audio/webm;base64,${buf.toString('base64')}`, format: 'webm' };
  },

  getModelFallbackOrder(currentModel) {
    const chain = [
      'nai-diffusion-4-5-full',
      'nai-diffusion-4-5-curated',
      'nai-diffusion-4-full',
      'nai-diffusion-4-curated-preview',
      'nai-diffusion-3',
    ];
    return chain.filter(m => m !== currentModel);
  }
};
