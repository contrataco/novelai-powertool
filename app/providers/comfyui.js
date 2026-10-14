/**
 * ComfyUI image generation against a self-hosted server.
 *
 * Talks to ComfyUI's native HTTP API: POST /prompt queues a node graph,
 * GET /history/<id> reports completion, GET /view returns the image bytes.
 * Two graphs are built here. The plain checkpoint one covers every
 * SD1.5/SDXL-family checkpoint. Models that ship as a bare diffusion model
 * (Flux, Z-Image) get a second graph with separate text-encoder and VAE
 * loaders, described per family in DIFFUSION_FAMILIES.
 *
 * Completion is polled rather than read off the /ws socket so the provider
 * works the same whether it reaches ComfyUI directly or through a reverse
 * proxy that may not forward websockets.
 *
 * Main process only, like the other local provider: ComfyUI sends no CORS
 * headers, and the renderer's CSP does not list the host.
 */

const crypto = require('crypto');
const { ART_STYLES } = require('./perchance');
const {
  buildProsePrompt, flatToProse, novelaiToComfyWeights, joinPrompt,
} = require('./comfyui-prompt');

const LOG_PREFIX = '[ComfyUI]';

// ComfyUI's own default bind. A server on another machine is a setting.
const DEFAULT_API_URL = 'http://127.0.0.1:8188';

const DEFAULTS = {
  steps: 25,
  cfg: 6,
  sampler: 'dpmpp_2m',
  scheduler: 'karras',
};

// The first generation after a checkpoint switch loads several GB into VRAM
// before sampling starts, and the request may queue behind other jobs.
const GENERATION_TIMEOUT_MS = 240000;
// Bare diffusion models plus their text encoders can exceed the card's VRAM,
// so ComfyUI streams weights from system RAM and a cold run is much slower.
const DIFFUSION_TIMEOUT_MS = 360000;
const POLL_INTERVAL_MS = 1000;
const REQUEST_TIMEOUT_MS = 15000;

const MAX_SIDE = 2048;

/**
 * How the scene prompt should be WRITTEN for each kind of text encoder. The
 * scene pipeline hands `text` to the LLM that writes the final prompt.
 * `words` is the target length: CLIP-based checkpoints (SDXL, RealVis) read
 * 75 tokens per chunk and weight the start, while Qwen (Z-Image) and T5
 * (Flux) encoders were trained on long captions and use every detail.
 */
const WRITING_GUIDES = {
  longCaption: {
    words: '120-200 words',
    text: 'This model reads long, detailed natural-language captions. Write one flowing paragraph of plain descriptive sentences. Start with the main subject and the action, then each person (sex, apparent age, build, skin, hair, clothing or lack of it, pose, expression, where they are in the frame and what they are doing to or with whom), then the setting, props, lighting and camera framing. Be concrete and literal; every detail you write will be drawn.',
  },
  mediumCaption: {
    words: '80-150 words',
    text: 'This model reads natural-language captions. Write a few plain descriptive sentences: main subject and action first, then each person (sex, apparent age, hair, clothing, pose, expression, position in the frame), then setting, lighting and camera framing. Be concrete and literal.',
  },
  shortCaption: {
    words: '40-70 words',
    text: 'This model reads only the first ~75 tokens closely. Write 2-4 short, dense descriptive sentences with the most important visual facts first: who is in the shot, what they look like and what they are doing, then the setting and lighting. No filler words.',
  },
  photoCaption: {
    words: '40-70 words',
    text: 'This is a photorealistic model that reads only the first ~75 tokens closely. Write 2-4 short, dense sentences describing the scene as a photograph: who is in the shot, their appearance, clothing, pose and expression, then the setting, lighting and camera framing (shot type, angle). Most important facts first.',
  },
  tags: {
    words: '25-45 tags',
    text: "This model was trained on booru tags. Write comma-separated tags: count tags (1girl, 2boys) first, then each person's appearance, clothing, pose and expression, then setting, lighting and framing.",
  },
};

/**
 * How each checkpoint family wants to be prompted, matched on the filename.
 *
 * `style` picks the prompt form: 'tags' is the comma-separated booru list
 * the scene pipeline writes, 'prose' rewrites it into sentences for models
 * whose text encoder was trained on captions. A checkpoint that matches no
 * row keeps tags and nothing else - what every checkpoint got before.
 * `clipSkip` is applied with CLIPSetLastLayer.
 */
const CHECKPOINT_PROFILES = [
  {
    // Pony V6 model card: load with clip skip 2 or output degrades to "low
    // quality blobs", and the full score string works far better than
    // score_9 alone.
    match: /pony/i,
    style: 'tags',
    prefix: 'score_9, score_8_up, score_7_up, score_6_up, score_5_up, score_4_up',
    negative: 'score_6, score_5, score_4',
    clipSkip: -2,
    writer: 'tags',
  },
  {
    match: /realvis/i,
    style: 'prose',
    prefix: '',
    negative: 'face asymmetry, eyes asymmetry, deformed eyes, lowres, blurry',
    clipSkip: null,
    writer: 'photoCaption',
  },
  {
    match: /sd_?xl_base|sdxl[_-]?base/i,
    style: 'prose',
    prefix: '',
    negative: '',
    clipSkip: null,
    writer: 'shortCaption',
  },
];

const DEFAULT_PROFILE = { style: 'tags', prefix: '', negative: '', clipSkip: null, writer: 'tags' };
// Distilled diffusion models: caption-trained encoders, and no negative.
const DIFFUSION_PROFILE = { style: 'prose', prefix: '', negative: '', clipSkip: null, writer: 'mediumCaption' };

// Stored model ids for bare diffusion models carry this prefix, so they can
// never be confused with a checkpoint of the same filename. A colon cannot
// appear in a Windows filename, and checkpoint ids stay the plain filename.
const DIFFUSION_PREFIX = 'diffusion:';

/**
 * Bare diffusion models this provider knows how to wire up, matched on
 * filename. Anything in models/diffusion_models that matches no family is
 * left out of the model list - on a typical server that folder also holds
 * video models, which would only fail in an image graph.
 *
 * These are distilled models: steps, sampler and scheduler are part of how
 * they were trained, CFG is 1, and a negative prompt has no effect. The
 * user's checkpoint settings are deliberately not applied to them.
 *
 * A guidance-distilled model (Flux dev) would be one more row plus a
 * FluxGuidance node on the positive conditioning; none is installed to
 * prove it against, so it is not here.
 */
const DIFFUSION_FAMILIES = [
  {
    id: 'flux-schnell',
    label: 'Flux schnell',
    match: /flux.*schnell/i,
    clip: { node: 'DualCLIPLoader', type: 'flux', inputs: ['clip_name1', 'clip_name2'], files: [/t5xxl/i, /clip_l/i] },
    vae: /^ae\./i,
    shift: null,
    steps: 4,
    sampler: 'euler',
    scheduler: 'simple',
    writer: 'mediumCaption',
  },
  {
    id: 'z-image-turbo',
    label: 'Z-Image Turbo',
    match: /z[_-]?image.*turbo/i,
    clip: { node: 'CLIPLoader', type: 'lumina2', inputs: ['clip_name'], files: [/qwen_3_4b/i] },
    vae: /^ae\./i,
    shift: 3,
    steps: 9,
    sampler: 'res_multistep',
    scheduler: 'simple',
    writer: 'longCaption',
  },
];

function basename(file) {
  return file.replace(/^.*[\\/]/, '');
}

function familyFor(file) {
  return DIFFUSION_FAMILIES.find((f) => f.match.test(basename(file || ''))) || null;
}

function isDiffusionId(modelId) {
  return (modelId || '').startsWith(DIFFUSION_PREFIX);
}

function getApiUrl(store) {
  const raw = (store.get('comfyuiApiUrl') || DEFAULT_API_URL).trim();
  return raw.replace('localhost', '127.0.0.1').replace(/\/+$/, '');
}

/** The built-in profile for a model id, before the user's own additions. */
function builtInProfile(modelId) {
  if (isDiffusionId(modelId)) {
    const family = familyFor(modelId.slice(DIFFUSION_PREFIX.length));
    return family?.writer ? { ...DIFFUSION_PROFILE, writer: family.writer } : DIFFUSION_PROFILE;
  }
  return CHECKPOINT_PROFILES.find((p) => p.match.test(basename(modelId || ''))) || DEFAULT_PROFILE;
}

/**
 * The profile a generation uses: the built-in one for the model actually
 * run, plus what the user saved for the model they picked in settings
 * (`settingsId` is '' when they left it on Auto). Saved fields: `style`
 * ('' for the built-in choice), `positive` and `negative` descriptors.
 */
function profileFor(modelId, settingsId, store) {
  const base = builtInProfile(modelId);
  const saved = (store.get('comfyuiModelProfiles') || {})[settingsId || ''] || {};
  const style = saved.style === 'tags' || saved.style === 'prose' ? saved.style : base.style;
  return {
    ...base,
    style,
    extraPositive: String(saved.positive || '').trim(),
    // A distilled model runs at CFG 1, where a negative does nothing.
    extraNegative: isDiffusionId(modelId) ? '' : String(saved.negative || '').trim(),
  };
}

/**
 * The prompt body before prefixes and style: sentences for a prose model,
 * built from the structured captions when the scene pipeline sent them.
 */
function promptBody(prompt, style, options) {
  if (style !== 'prose') return prompt;
  // Rebuild from the captions only when the prompt IS their tag assembly. A
  // prompt the pipeline wrote for this model, or one the user edited, would
  // otherwise be thrown away.
  const assembled = [options.baseCaption, ...(options.charCaptions || []).map((c) => c.char_caption)]
    .filter(Boolean).join(', ');
  if (assembled && String(prompt || '').trim() === assembled.trim()) {
    const prose = buildProsePrompt({ baseCaption: options.baseCaption, charCaptions: options.charCaptions });
    if (prose) return prose;
  }
  return flatToProse(prompt);
}

// The model the last generation ran on, for gallery and history metadata.
let lastModelId = '';

/**
 * The model the next generation will run: the one picked in settings, or on
 * Auto the first installed checkpoint. Prompt writing and generate() both
 * use this, so the prompt is always written for the model that runs.
 */
async function resolveCheckpoint(store) {
  const settingsId = store.get('comfyuiCheckpoint') || '';
  if (settingsId) return settingsId;
  const baseUrl = getApiUrl(store);
  let installed;
  try {
    installed = await nodeOptions(baseUrl, 'CheckpointLoaderSimple', 'ckpt_name');
  } catch (e) {
    throw unreachable(baseUrl, e);
  }
  if (!installed.length) {
    throw new Error('ComfyUI has no checkpoints installed (models/checkpoints is empty)');
  }
  return installed[0];
}

/**
 * Latent sizes must be a multiple of the latent node's step, or the graph is
 * rejected: 8 for EmptyLatentImage, 16 for EmptySD3LatentImage.
 */
function snapSide(v, step = 8) {
  const n = Math.round(Number(v));
  if (!Number.isFinite(n) || n < 64) return 1024;
  return Math.min(Math.round(n / step) * step, MAX_SIDE);
}

/** Display name for a model path: no prefix, no folder, no extension. */
function checkpointLabel(file) {
  return basename(file.replace(DIFFUSION_PREFIX, '')).replace(/\.(safetensors|ckpt|pt|gguf|sft)$/i, '');
}

async function getJson(url, timeoutMs = REQUEST_TIMEOUT_MS) {
  const res = await fetch(url, { signal: AbortSignal.timeout(timeoutMs) });
  if (!res.ok) throw new Error(`HTTP ${res.status} from ${url}`);
  return res.json();
}

/** The option list ComfyUI advertises for one input of one node class. */
async function nodeOptions(baseUrl, nodeClass, inputName) {
  const info = await getJson(`${baseUrl}/object_info/${nodeClass}`);
  const spec = info?.[nodeClass]?.input?.required?.[inputName];
  // Older builds: [[...options], {...}]. Newer combo form: ['COMBO', {options}].
  if (Array.isArray(spec?.[0])) return spec[0];
  if (Array.isArray(spec?.[1]?.options)) return spec[1].options;
  return [];
}

/**
 * Every model the provider can drive: checkpoints, then the bare diffusion
 * models that match a known family. The GGUF loader is a custom node, so a
 * server without it simply contributes nothing.
 */
async function listModels(baseUrl) {
  const [checkpoints, unets, ggufs] = await Promise.all([
    nodeOptions(baseUrl, 'CheckpointLoaderSimple', 'ckpt_name'),
    nodeOptions(baseUrl, 'UNETLoader', 'unet_name').catch(() => []),
    nodeOptions(baseUrl, 'UnetLoaderGGUF', 'unet_name').catch(() => []),
  ]);
  const models = checkpoints.map((file) => ({
    id: file, name: checkpointLabel(file), family: null, fixed: null, promptStyle: builtInProfile(file).style,
  }));
  for (const file of [...unets, ...ggufs]) {
    const family = familyFor(file);
    if (!family) continue;
    models.push({
      promptStyle: DIFFUSION_PROFILE.style,
      id: DIFFUSION_PREFIX + file,
      name: `${checkpointLabel(file)} (${family.label})`,
      family: family.id,
      fixed: { steps: family.steps, cfg: 1, sampler: family.sampler, scheduler: family.scheduler },
    });
  }
  return models;
}

/**
 * Pick the text encoder and VAE files a family needs out of what the server
 * has. Done here rather than hardcoded because the filenames vary by
 * precision (fp8, fp16, scaled) and a missing one should say which folder to
 * fill, not surface as ComfyUI's "value not in list".
 */
async function resolveFamilyFiles(baseUrl, family) {
  const [clips, vaes] = await Promise.all([
    nodeOptions(baseUrl, family.clip.node, family.clip.inputs[0]),
    nodeOptions(baseUrl, 'VAELoader', 'vae_name'),
  ]);
  const clipFiles = family.clip.files.map((pattern) => clips.find((f) => pattern.test(basename(f))));
  const missing = family.clip.files.filter((_, i) => !clipFiles[i]).map((pattern) => pattern.source);
  if (missing.length) {
    throw new Error(
      `${family.label} needs a text encoder matching ${missing.join(' and ')} in the server's models/text_encoders folder`
    );
  }
  const vae = vaes.find((f) => family.vae.test(basename(f)));
  if (!vae) {
    throw new Error(`${family.label} needs its VAE (ae.safetensors) in the server's models/vae folder`);
  }
  return { clipFiles, vae };
}

/**
 * The socket-level reason behind a bare "fetch failed". A refused connection
 * arrives as an AggregateError (one entry per address tried), so the code is
 * one level further down than for a DNS failure.
 */
function causeCode(e) {
  return e?.cause?.code || e?.cause?.errors?.[0]?.code || e?.cause?.message || null;
}

function unreachable(baseUrl, e) {
  const why = e?.name === 'TimeoutError' ? 'timed out' : (causeCode(e) || e?.message || 'unknown error');
  return new Error(
    `Cannot reach ComfyUI at ${baseUrl} (${why}). Check that it is running and the URL in ComfyUI settings.`
  );
}

function buildGraph({ checkpoint, positive, negative, width, height, seed, steps, cfg, sampler, scheduler, clipSkip }) {
  // Both encoders read the clip through CLIPSetLastLayer when the model
  // wants clip skip, straight from the checkpoint otherwise.
  const clip = clipSkip ? ['8', 0] : ['1', 1];
  const graph = {
    '1': { class_type: 'CheckpointLoaderSimple', inputs: { ckpt_name: checkpoint } },
    '2': { class_type: 'CLIPTextEncode', inputs: { text: positive, clip } },
    '3': { class_type: 'CLIPTextEncode', inputs: { text: negative, clip } },
    '4': { class_type: 'EmptyLatentImage', inputs: { width, height, batch_size: 1 } },
    '5': {
      class_type: 'KSampler',
      inputs: {
        model: ['1', 0],
        positive: ['2', 0],
        negative: ['3', 0],
        latent_image: ['4', 0],
        seed,
        steps,
        cfg,
        sampler_name: sampler,
        scheduler,
        denoise: 1,
      },
    },
    '6': { class_type: 'VAEDecode', inputs: { samples: ['5', 0], vae: ['1', 2] } },
    // PreviewImage, not SaveImage: results go to ComfyUI's temp directory,
    // so the app does not fill the server's output folder.
    '7': { class_type: 'PreviewImage', inputs: { images: ['6', 0] } },
  };
  if (clipSkip) {
    graph['8'] = { class_type: 'CLIPSetLastLayer', inputs: { clip: ['1', 1], stop_at_clip_layer: clipSkip } };
  }
  return graph;
}

/**
 * Graph for a bare diffusion model: the model, its text encoder(s) and its
 * VAE each come from their own loader. The negative is the positive zeroed
 * out - these models run at CFG 1, where a text negative does nothing, and
 * zeroing skips a second pass through a multi-gigabyte text encoder.
 */
function buildDiffusionGraph({ family, file, clipFiles, vae, positive, width, height, seed }) {
  const isGguf = /\.gguf$/i.test(file);
  const clipInputs = { type: family.clip.type };
  family.clip.inputs.forEach((name, i) => { clipInputs[name] = clipFiles[i]; });

  const graph = {
    '1': isGguf
      ? { class_type: 'UnetLoaderGGUF', inputs: { unet_name: file } }
      : { class_type: 'UNETLoader', inputs: { unet_name: file, weight_dtype: 'default' } },
    '2': { class_type: family.clip.node, inputs: clipInputs },
    '3': { class_type: 'VAELoader', inputs: { vae_name: vae } },
    '4': { class_type: 'CLIPTextEncode', inputs: { text: positive, clip: ['2', 0] } },
    '5': { class_type: 'ConditioningZeroOut', inputs: { conditioning: ['4', 0] } },
    '6': { class_type: 'EmptySD3LatentImage', inputs: { width, height, batch_size: 1 } },
    '7': {
      class_type: 'KSampler',
      inputs: {
        model: family.shift ? ['10', 0] : ['1', 0],
        positive: ['4', 0],
        negative: ['5', 0],
        latent_image: ['6', 0],
        seed,
        steps: family.steps,
        cfg: 1,
        sampler_name: family.sampler,
        scheduler: family.scheduler,
        denoise: 1,
      },
    },
    '8': { class_type: 'VAEDecode', inputs: { samples: ['7', 0], vae: ['3', 0] } },
    '9': { class_type: 'PreviewImage', inputs: { images: ['8', 0] } },
  };
  if (family.shift) {
    graph['10'] = { class_type: 'ModelSamplingAuraFlow', inputs: { model: ['1', 0], shift: family.shift } };
  }
  return graph;
}

/** Pull a readable reason out of a failed POST /prompt body. */
function describeQueueError(status, bodyText) {
  try {
    const parsed = JSON.parse(bodyText);
    const parts = [];
    if (parsed?.error?.message) parts.push(parsed.error.message);
    for (const node of Object.values(parsed?.node_errors || {})) {
      for (const err of node.errors || []) {
        parts.push([err.message, err.details].filter(Boolean).join(': '));
      }
    }
    if (parts.length) return new Error(`ComfyUI rejected the workflow - ${parts.join('; ').slice(0, 400)}`);
  } catch (_) { /* not JSON - fall through to the raw text */ }
  return new Error(`ComfyUI returned HTTP ${status} - ${String(bodyText).slice(0, 300)}`);
}

/** The execution_error message from a history entry, if there is one. */
function executionError(entry) {
  for (const [type, data] of entry?.status?.messages || []) {
    if (type === 'execution_error') {
      return `${data?.node_type || 'node'}: ${data?.exception_message || 'execution failed'}`.trim();
    }
  }
  return null;
}

/** Best-effort removal of a prompt we have given up on. Never throws. */
async function cancelPrompt(baseUrl, promptId) {
  try {
    const queue = await getJson(`${baseUrl}/queue`, 5000);
    const isRunning = (queue?.queue_running || []).some((item) => item?.[1] === promptId);
    if (isRunning) {
      await fetch(`${baseUrl}/interrupt`, { method: 'POST', signal: AbortSignal.timeout(5000) });
    } else {
      await fetch(`${baseUrl}/queue`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ delete: [promptId] }),
        signal: AbortSignal.timeout(5000),
      });
    }
  } catch (_) { /* the timeout error the caller throws is the useful one */ }
}

async function waitForOutput(baseUrl, promptId, timeoutMs) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    await new Promise((r) => setTimeout(r, POLL_INTERVAL_MS));
    let history;
    try {
      history = await getJson(`${baseUrl}/history/${promptId}`);
    } catch (e) {
      // One dropped poll is not a failed generation; the deadline bounds it.
      console.log(`${LOG_PREFIX} history poll failed: ${e.message}`);
      continue;
    }
    const entry = history?.[promptId];
    if (!entry) continue;

    const failure = executionError(entry);
    if (failure) throw new Error(`ComfyUI generation failed - ${failure.slice(0, 400)}`);

    for (const output of Object.values(entry.outputs || {})) {
      if (output?.images?.length) return output.images[0];
    }
    if (entry.status?.completed) {
      throw new Error('ComfyUI finished the workflow but produced no image');
    }
  }
  await cancelPrompt(baseUrl, promptId);
  throw new Error(
    `ComfyUI did not finish within ${Math.round(timeoutMs / 1000)}s, so the job was cancelled. ` +
    'If the GPU is shared with another workload (a loaded LLM, another queue), it may not have had room for the model.'
  );
}

module.exports = {
  id: 'comfyui',
  name: 'ComfyUI (self-hosted)',

  async checkReady(store) {
    const status = await this.getStatus(store);
    return status.running && status.checkpoints.length > 0;
  },

  getModels() {
    return [];
  },

  /** Models currently usable on the server, for the settings UI. */
  async fetchModelsForUI(store) {
    return listModels(getApiUrl(store));
  },

  getArtStyles() {
    return Object.entries(ART_STYLES).map(([id, style]) => ({ id, name: style.name }));
  },

  /**
   * The negative the renderer bakes into its prompt before sending it with
   * rawNegativePrompt, so the model's profile and the user's per-model
   * negative descriptors have to be in here, not added again in generate().
   */
  getNegativeSuffix(store) {
    const checkpoint = store.get('comfyuiCheckpoint') || '';
    if (isDiffusionId(checkpoint)) {
      return { styleNegative: '', ucPresetNegative: '', combined: '' };
    }
    const artStyle = ART_STYLES[store.get('comfyuiArtStyle') || 'no-style'] || ART_STYLES['no-style'];
    const profile = profileFor(checkpoint, checkpoint, store);
    const styleNegative = artStyle.negative || '';
    const ucPresetNegative = [profile.negative, profile.extraNegative].filter(Boolean).join(', ');
    return {
      styleNegative,
      ucPresetNegative,
      combined: [styleNegative, ucPresetNegative].filter(Boolean).join(', '),
    };
  },

  /**
   * How to write the scene prompt for the model the next generation runs:
   * { modelId, label, style: 'tags'|'prose', words, text }. The user's saved
   * style for the model wins, as it does at generation time.
   */
  async getPromptGuide(store) {
    const settingsId = store.get('comfyuiCheckpoint') || '';
    const modelId = await resolveCheckpoint(store);
    const profile = profileFor(modelId, settingsId, store);
    let writer = profile.writer || 'tags';
    // A saved style that disagrees with the built-in one picks a matching guide.
    if (profile.style === 'tags') writer = 'tags';
    else if (writer === 'tags') writer = 'mediumCaption';
    return { modelId, label: checkpointLabel(modelId), style: profile.style, ...WRITING_GUIDES[writer] };
  },

  /** Display name of the model the last generation ran on. */
  getActiveModelLabel() {
    return lastModelId ? checkpointLabel(lastModelId) : '';
  },

  /**
   * What the server can do right now: reachable, which GPU, what is installed.
   * One call feeds the status line and every dropdown in the settings block.
   */
  async getStatus(store) {
    const url = getApiUrl(store);
    try {
      const [stats, checkpoints, samplers, schedulers, queue] = await Promise.all([
        getJson(`${url}/system_stats`, 6000),
        listModels(url),
        nodeOptions(url, 'KSampler', 'sampler_name'),
        nodeOptions(url, 'KSampler', 'scheduler'),
        getJson(`${url}/queue`, 6000).catch(() => null),
      ]);
      const gpu = stats?.devices?.[0];
      return {
        running: true,
        url,
        version: stats?.system?.comfyui_version || null,
        // "cuda:0 NVIDIA GeForce RTX 5070 Ti : cudaMallocAsync" -> the card name
        gpu: gpu ? gpu.name.replace(/^\w+:\d+\s*/, '').replace(/\s+:\s.*$/, '') : null,
        vramFreeGb: gpu ? Math.round((gpu.vram_free / 2 ** 30) * 10) / 10 : null,
        vramTotalGb: gpu ? Math.round((gpu.vram_total / 2 ** 30) * 10) / 10 : null,
        queued: (queue?.queue_pending?.length || 0) + (queue?.queue_running?.length || 0),
        checkpoints,
        samplers,
        schedulers,
      };
    } catch (e) {
      return {
        running: false,
        url,
        error: e?.name === 'TimeoutError' ? 'timed out' : (causeCode(e) || e.message),
        checkpoints: [],
        samplers: [],
        schedulers: [],
      };
    }
  },

  async generate(prompt, negativePrompt, store, options = {}) {
    const baseUrl = getApiUrl(store);
    const settings = store.get('imageSettings') || {};
    const artStyle = ART_STYLES[store.get('comfyuiArtStyle') || 'no-style'] || ART_STYLES['no-style'];

    const settingsId = store.get('comfyuiCheckpoint') || '';
    const checkpoint = await resolveCheckpoint(store);

    const seed = (options.seed !== undefined && options.seed !== null)
      ? Number(options.seed)
      : crypto.randomInt(0, 2 ** 32);

    // The positive is always assembled here, even under rawPrompt: the
    // renderer sets that flag on every scene prompt because NovelAI's suffix
    // is baked in renderer-side, but this provider has no positive suffix
    // for it to bake. The negative does arrive baked (getNegativeSuffix).
    const profile = profileFor(checkpoint, settingsId, store);
    const positive = novelaiToComfyWeights(joinPrompt(
      [profile.prefix, promptBody(prompt, profile.style, options), profile.extraPositive, artStyle.prompt],
      profile.style,
    ));
    const negative = novelaiToComfyWeights(options.rawNegativePrompt
      ? (negativePrompt || '')
      : [negativePrompt, artStyle.negative, profile.negative, profile.extraNegative].filter(Boolean).join(', '));

    let graph;
    let width;
    let height;
    let timeoutMs = GENERATION_TIMEOUT_MS;
    if (isDiffusionId(checkpoint)) {
      const file = checkpoint.slice(DIFFUSION_PREFIX.length);
      const family = familyFor(file);
      if (!family) throw new Error(`No ComfyUI workflow is defined for the model '${file}'`);
      let files;
      try {
        files = await resolveFamilyFiles(baseUrl, family);
      } catch (e) {
        if (e?.name === 'TimeoutError' || e?.cause) throw unreachable(baseUrl, e);
        throw e;
      }
      width = snapSide(settings.width, 16);
      height = snapSide(settings.height, 16);
      timeoutMs = DIFFUSION_TIMEOUT_MS;
      graph = buildDiffusionGraph({
        family, file, ...files, positive, width, height, seed,
      });
    } else {
      width = snapSide(settings.width);
      height = snapSide(settings.height);
      graph = buildGraph({
        checkpoint,
        positive,
        negative,
        clipSkip: profile.clipSkip,
        width,
        height,
        seed,
        steps: store.get('comfyuiSteps') || DEFAULTS.steps,
        cfg: store.get('comfyuiCfg') || DEFAULTS.cfg,
        sampler: store.get('comfyuiSampler') || DEFAULTS.sampler,
        scheduler: store.get('comfyuiScheduler') || DEFAULTS.scheduler,
      });
    }

    console.log(`${LOG_PREFIX} Queueing ${width}x${height} on ${checkpointLabel(checkpoint)} via ${baseUrl}`);
    console.log(`${LOG_PREFIX} Prompt (${profile.style}): ${positive.slice(0, 600)}`);
    if (!isDiffusionId(checkpoint)) console.log(`${LOG_PREFIX} Negative: ${negative.slice(0, 300)}`);
    lastModelId = checkpoint;

    let res;
    try {
      res = await fetch(`${baseUrl}/prompt`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ prompt: graph, client_id: crypto.randomUUID() }),
        signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
      });
    } catch (e) {
      throw unreachable(baseUrl, e);
    }
    if (!res.ok) {
      throw describeQueueError(res.status, await res.text().catch(() => ''));
    }
    const { prompt_id: promptId } = await res.json();
    if (!promptId) throw new Error('ComfyUI accepted the workflow but returned no prompt id');

    const image = await waitForOutput(baseUrl, promptId, timeoutMs);

    const query = new URLSearchParams({
      filename: image.filename,
      subfolder: image.subfolder || '',
      type: image.type || 'temp',
    });
    const imgRes = await fetch(`${baseUrl}/view?${query}`, { signal: AbortSignal.timeout(60000) });
    if (!imgRes.ok) throw new Error(`ComfyUI could not serve the finished image (HTTP ${imgRes.status})`);

    const buf = Buffer.from(await imgRes.arrayBuffer());
    const mime = (imgRes.headers.get('content-type') || 'image/png').split(';')[0];
    console.log(`${LOG_PREFIX} Image generated successfully (${buf.length} bytes)`);
    return `data:${mime};base64,${buf.toString('base64')}`;
  },
};
