/**
 * Perchance image generation via the local perchance-chat API.
 *
 * Backed by ~/git/perchance-experiment, which publishes its own Perchance
 * generator and drives it through a real Chrome, exposing an
 * OpenAI-compatible HTTP API on loopback. That replaces the previous
 * approach here (extracting a userKey via Chrome CDP and calling
 * image-generation.perchance.org directly), which was fragile because
 * Cloudflare Turnstile only ever solved in system Chrome.
 *
 * The server sends no CORS headers and checks the Host header, so it can
 * only be called from the main process - never from the renderer.
 *
 * See ~/git/perchance-experiment/docs/integrating.md for the contract.
 */

const LOG_PREFIX = '[Perchance]';

// Electron's main-process fetch can fail resolving `localhost` over IPv6,
// so the default is spelled as a loopback literal.
const DEFAULT_API_URL = 'http://127.0.0.1:8730';

// The image model id the local API exposes. One only: the plugin has no
// art-style parameter, so style words go in the prompt (see ART_STYLES).
const IMAGE_MODEL = 'perchance-image';

// The four sizes Perchance's text-to-image-plugin accepts. This is the
// plugin's own limit, not the local API's: `resolution: "99x99"` makes the
// plugin return the plain string "(text-to-image-plugin: Currently, the only
// valid resolutions are 512x512, 768x768, 512x768 and 768x512)". Anything
// outside this set is a 400 from the local API, so we snap before sending.
const VALID_RESOLUTIONS = [
  { w: 512, h: 512 },
  { w: 768, h: 768 },
  { w: 512, h: 768 },
  { w: 768, h: 512 },
];

// A generation runs in a real browser and queues behind any other image
// request, so this is generous relative to the app's other providers.
const REQUEST_TIMEOUT_MS = 180000;

// Art styles: prompt/negative prompt modifiers
const ART_STYLES = {
  'no-style': {
    name: 'No Style',
    prompt: '',
    negative: '',
  },
  'cinematic': {
    name: 'Cinematic',
    prompt: ', cinematic shot, dynamic lighting, 75mm, Technicolor, Panavision, cinemascope, sharp focus, fine details, 8k, HDR, realism, realistic, key visual, film still, superb cinematic color grading, depth of field',
    negative: 'bad lighting, low-quality, deformed, text, poorly drawn, bad art, bad angle, boring, low-resolution, worst quality, bad composition, disfigured',
  },
  'digital-painting': {
    name: 'Digital Painting',
    prompt: ', digital painting, highly detailed, artstation, sharp focus, illustration, concept art, 8k',
    negative: 'blurry, bad anatomy, extra limbs, poorly drawn face, poorly drawn hands, missing fingers, worst quality, low quality',
  },
  'concept-art': {
    name: 'Concept Art',
    prompt: ', concept art, illustration, matte painting, highly detailed, cinematic composition, dynamic lighting, artstation trending',
    negative: 'blurry, low-quality, text, watermark, bad anatomy, worst quality',
  },
  'oil-painting': {
    name: 'Oil Painting',
    prompt: ', oil painting, alla prima, painterly, canvas texture, brush strokes, rich colors, masterwork, fine art',
    negative: 'blurry, low resolution, worst quality, fuzzy, digital artifacts',
  },
  'fantasy-painting': {
    name: 'Fantasy Painting',
    prompt: ', fantasy art, D&D illustration style, epic, dramatic lighting, highly detailed, magical atmosphere, artstation',
    negative: 'blurry, low resolution, worst quality, bad anatomy, text, watermark',
  },
  'anime': {
    name: 'Anime',
    prompt: ', anime style, anime art, detailed, vibrant colors, clean lines, high quality anime illustration',
    negative: 'blurry, low resolution, worst quality, realistic, photo, 3d render',
  },
  'painted-anime': {
    name: 'Painted Anime',
    prompt: ', painted anime, pixiv, painterly anime style, soft shading, vibrant, detailed background, studio quality',
    negative: 'blurry, low resolution, worst quality, sketch, lineart, flat colors',
  },
  'watercolor': {
    name: 'Watercolor',
    prompt: ', watercolor painting, soft colors, textured paper, flowing paint, artistic, delicate details, traditional media',
    negative: 'blurry, low resolution, worst quality, digital artifacts, sharp edges',
  },
  'illustration': {
    name: 'Illustration',
    prompt: ', breathtaking illustration, detailed, masterwork, vivid colors, professional, trending on artstation',
    negative: 'blurry, low resolution, worst quality, amateur, bad composition',
  },
  'manga': {
    name: 'Manga',
    prompt: ', manga style, black and white, ink drawing, detailed linework, dramatic shading, screentone',
    negative: 'blurry, low resolution, worst quality, color, painted',
  },
  'casual-photo': {
    name: 'Casual Photo',
    prompt: ', casual photography, natural lighting, candid, authentic, high resolution photograph, bokeh',
    negative: 'blurry, low resolution, worst quality, painting, drawn, illustration, cartoon',
  },
  'professional-photo': {
    name: 'Professional Photo',
    prompt: ', professional photography, studio lighting, high resolution, sharp focus, DSLR, 85mm lens, detailed, award-winning photograph',
    negative: 'blurry, low resolution, worst quality, painting, drawn, illustration, amateur, grainy',
  },
  'vintage-comic': {
    name: 'Vintage Comic',
    prompt: ', vintage comic book style, 1950s comic art, halftone dots, bold outlines, retro colors, speech bubble aesthetic',
    negative: 'blurry, low resolution, worst quality, modern, realistic, photograph',
  },
  'fantasy-landscape': {
    name: 'Fantasy Landscape',
    prompt: ', fantasy landscape, epic vista, matte painting style, breathtaking scenery, magical environment, detailed worldbuilding, cinematic wide shot',
    negative: 'blurry, low resolution, worst quality, text, watermark, close-up, portrait',
  },
};

/**
 * Base URL of the local perchance-chat server, without a trailing slash.
 *
 * `localhost` is rewritten to the loopback literal: Electron's main-process
 * fetch can fail to resolve `localhost` over IPv6, the same trap `getOllamaUrl`
 * works around in main.js.
 */
function getApiUrl(store) {
  const raw = (store.get('perchanceApiUrl') || DEFAULT_API_URL).trim();
  return raw.replace('localhost', '127.0.0.1').replace(/\/+$/, '');
}

/**
 * Snap requested dimensions onto one of the four resolutions the plugin
 * accepts, preferring the closest aspect ratio and breaking ties on area.
 *
 * The app's imageSettings default is 832x1216, which is not a valid Perchance
 * resolution, so this runs on essentially every call. It exists because the
 * limit lives in Perchance's text-to-image-plugin rather than in our
 * generator - if that ever stops being true, delete this and pass the
 * requested size straight through.
 */
function pickResolution(width, height) {
  const w = Number(width) > 0 ? Number(width) : 512;
  const h = Number(height) > 0 ? Number(height) : 512;
  const wantAspect = w / h;

  let best = VALID_RESOLUTIONS[0];
  let bestScore = Infinity;
  for (const cand of VALID_RESOLUTIONS) {
    const aspectDelta = Math.abs((cand.w / cand.h) - wantAspect);
    // Area is the tie-breaker, scaled small enough that it never outweighs
    // a genuinely closer aspect ratio.
    const areaDelta = Math.abs((cand.w * cand.h) - (w * h)) / 1e9;
    const score = aspectDelta + areaDelta;
    if (score < bestScore) {
      bestScore = score;
      best = cand;
    }
  }
  return { resolution: `${best.w}x${best.h}`, snapped: best.w !== w || best.h !== h };
}

/**
 * Derive the data-URI mime type from the payload's magic bytes.
 *
 * The old implementation hardcoded image/jpeg. The local API returns whatever
 * the plugin produced, so sniff rather than assume - a PNG mislabelled as JPEG
 * renders in Chromium but breaks anything that trusts the declared type.
 */
function sniffMime(buf) {
  if (buf.length >= 8 && buf[0] === 0x89 && buf[1] === 0x50 && buf[2] === 0x4e && buf[3] === 0x47) {
    return 'image/png';
  }
  if (buf.length >= 3 && buf[0] === 0xff && buf[1] === 0xd8 && buf[2] === 0xff) {
    return 'image/jpeg';
  }
  if (buf.length >= 12 && buf.toString('ascii', 0, 4) === 'RIFF' && buf.toString('ascii', 8, 12) === 'WEBP') {
    return 'image/webp';
  }
  if (buf.length >= 6 && buf.toString('ascii', 0, 3) === 'GIF') {
    return 'image/gif';
  }
  return 'image/png';
}

/**
 * Turn a non-2xx response into an error that says what to actually do.
 *
 * The status codes are specific to the images route and each has a different
 * fix, so they are worth distinguishing rather than collapsing into one
 * "request failed" (see docs/integrating.md in perchance-experiment).
 */
function describeHttpError(status, bodyText, retryAfter) {
  let detail = bodyText;
  try {
    const parsed = JSON.parse(bodyText);
    detail = parsed?.error?.message || parsed?.detail || bodyText;
  } catch (_) { /* not JSON - use the raw text */ }
  const suffix = detail ? ` - ${String(detail).slice(0, 300)}` : '';

  switch (status) {
    case 400:
      return new Error(`Perchance rejected the request${suffix}`);
    case 404:
      return new Error(`Perchance has no model '${IMAGE_MODEL}'. Check GET /v1/models${suffix}`);
    case 422:
      return new Error(`Malformed request to Perchance${suffix}`);
    case 501:
      return new Error(
        'No Perchance image generator is published yet. Run: perchance-chat publish --image'
      );
    case 502:
      return new Error(`Perchance plugin error, or the frame could not be driven${suffix}`);
    case 503:
      return new Error(
        `Perchance is busy with another image generation${retryAfter ? ` (retry after ${retryAfter}s)` : ''}${suffix}`
      );
    case 504:
      return new Error(`Perchance image generation timed out${suffix}`);
    default:
      return new Error(`Perchance API returned HTTP ${status}${suffix}`);
  }
}

module.exports = {
  id: 'perchance',
  name: 'Perchance (Local API)',

  /**
   * Liveness probe against the local server.
   *
   * Async, unlike the other providers' synchronous key checks, because
   * readiness here is a property of a running server rather than a stored
   * credential. Nothing in the app currently calls checkReady on any
   * provider, so this widening breaks no caller.
   */
  async checkReady(store) {
    try {
      const res = await fetch(`${getApiUrl(store)}/healthz`, {
        signal: AbortSignal.timeout(5000),
      });
      if (!res.ok) return false;
      const health = await res.json();
      return !!health?.image?.configured;
    } catch (_) {
      return false;
    }
  },

  getModels() {
    return [];
  },

  getArtStyles() {
    return Object.entries(ART_STYLES).map(([id, style]) => ({
      id,
      name: style.name
    }));
  },

  getNegativeSuffix(store) {
    const artStyleId = store.get('perchanceArtStyle') || 'no-style';
    const artStyle = ART_STYLES[artStyleId] || ART_STYLES['no-style'];
    const styleNegative = artStyle.negative || '';
    return {
      styleNegative,
      ucPresetNegative: '',
      combined: styleNegative,
    };
  },

  /**
   * Report what the local server can currently do, for the settings UI.
   * Distinguishes "server down" from "server up but no image generator".
   */
  async getStatus(store) {
    const url = getApiUrl(store);
    try {
      const res = await fetch(`${url}/healthz`, { signal: AbortSignal.timeout(5000) });
      if (!res.ok) {
        return { running: false, configured: false, error: `HTTP ${res.status}`, url };
      }
      const health = await res.json();
      return {
        running: true,
        configured: !!health?.image?.configured,
        busy: !!health?.image?.busy,
        attached: !!health?.image?.attached,
        generator: health?.generator || null,
        models: health?.image?.models || [],
        url,
      };
    } catch (e) {
      return {
        running: false,
        configured: false,
        error: e.name === 'TimeoutError' ? 'timed out' : e.message,
        url,
      };
    }
  },

  async generate(prompt, negativePrompt, store, options = {}) {
    const settings = store.get('imageSettings') || {};
    const artStyleId = store.get('perchanceArtStyle') || 'no-style';
    const artStyle = ART_STYLES[artStyleId] || ART_STYLES['no-style'];

    const finalPrompt = prompt + artStyle.prompt;
    let finalNegative;
    if (options && options.rawNegativePrompt) {
      finalNegative = negativePrompt || '';
    } else {
      finalNegative = [negativePrompt, artStyle.negative].filter(Boolean).join(', ');
    }

    const { resolution, snapped } = pickResolution(settings.width, settings.height);
    if (snapped) {
      console.log(
        `${LOG_PREFIX} Requested ${settings.width}x${settings.height} is not a valid ` +
        `Perchance resolution; using ${resolution}`
      );
    }

    const perchanceOpts = {
      guidance_scale: store.get('perchanceGuidanceScale') || 7,
    };
    if (finalNegative) perchanceOpts.negative_prompt = finalNegative;
    if (options.seed !== undefined && options.seed !== null) {
      perchanceOpts.seed = options.seed;
    }

    const body = {
      model: IMAGE_MODEL,
      prompt: finalPrompt,
      n: 1,
      size: resolution,
      perchance: perchanceOpts,
    };

    const url = `${getApiUrl(store)}/v1/images/generations`;
    console.log(`${LOG_PREFIX} Generating at ${resolution} via ${url}`);

    let res;
    try {
      res = await fetch(url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
        signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
      });
    } catch (e) {
      if (e.name === 'TimeoutError') {
        throw new Error(
          `Perchance did not respond within ${Math.round(REQUEST_TIMEOUT_MS / 1000)}s. ` +
          'The generation may still be running; check: perchance-chat serve status'
        );
      }
      throw new Error(
        `Cannot reach the Perchance local API at ${getApiUrl(store)}. ` +
        'Start it with: perchance-chat serve start'
      );
    }

    if (!res.ok) {
      const text = await res.text().catch(() => '');
      throw describeHttpError(res.status, text, res.headers.get('retry-after'));
    }

    const payload = await res.json();
    const b64 = payload?.data?.[0]?.b64_json;
    if (!b64) {
      throw new Error(`Perchance returned no image data: ${JSON.stringify(payload).slice(0, 300)}`);
    }

    const buf = Buffer.from(b64, 'base64');
    console.log(`${LOG_PREFIX} Image generated successfully (${buf.length} bytes)`);
    return `data:${sniffMime(buf)};base64,${b64}`;
  }
};
