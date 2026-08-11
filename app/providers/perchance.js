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

const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFile } = require('child_process');

const LOG_PREFIX = '[Perchance]';

// Required on every /admin call on the local API. The value is ignored; the
// header exists to force a CORS preflight the server never answers, so a web
// page cannot reach /admin/stop. Not a secret - do not treat it as one.
const ADMIN_HEADER = 'X-Perchance-Admin';

// Electron's main-process fetch can fail resolving `localhost` over IPv6,
// so the default is spelled as a loopback literal.
const DEFAULT_API_URL = 'http://127.0.0.1:8730';

// The image model id the local API exposes. One only: the plugin has no
// art-style parameter, so style words go in the prompt (see ART_STYLES).
const IMAGE_MODEL = 'perchance-image';

// Perchance's text-to-image-plugin only generates at 512x512, 768x768,
// 512x768 or 768x512 - its own limit, not the local API's, and not one our
// generator can lift: `width`/`height` are accepted and silently ignored
// (probed live). The local API therefore generates at the closest native
// aspect and resamples to whatever size we ask for, so nothing here needs to
// know that list. What it does need is the API's own ceiling, since a size
// over this is a 400.
const MAX_SIDE = 4096;

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
 * The output size to ask the local API for, as "WxH".
 *
 * No snapping. The API now accepts any size within its bounds: it generates at
 * the closest native aspect Perchance offers and resamples to exactly what was
 * asked for, so the app can request whatever its imageSettings say. Note that
 * resampling changes geometry, not detail - anything above the native 768px is
 * interpolated, not generated at that resolution.
 */
function requestedSize(width, height) {
  const clamp = (v) => {
    const n = Math.round(Number(v));
    if (!Number.isFinite(n) || n < 1) return 512;
    return Math.min(n, MAX_SIDE);
  };
  return `${clamp(width)}x${clamp(height)}`;
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

/**
 * Absolute path to the perchance-chat CLI, or null if it cannot be found.
 *
 * Never resolved off PATH. An Electron app launched from Finder inherits a
 * minimal PATH (/usr/bin:/bin:/usr/sbin:/sbin) that contains none of the
 * places this gets installed, so `spawn('perchance-chat')` works when the app
 * is started from a terminal and fails when it is started normally - the worst
 * kind of bug to chase. An explicit override wins so a non-standard install is
 * a setting rather than a patch.
 */
function resolveCli(store) {
  const configured = (store.get('perchanceCliPath') || '').trim();
  if (configured) {
    try {
      fs.accessSync(configured, fs.constants.X_OK);
      return configured;
    } catch (_) {
      return null;
    }
  }
  const home = os.homedir();
  const candidates = [
    '/opt/homebrew/bin/perchance-chat',
    '/usr/local/bin/perchance-chat',
    path.join(home, '.local', 'bin', 'perchance-chat'),
    path.join(home, 'Library', 'Python', '3.14', 'bin', 'perchance-chat'),
  ];
  for (const c of candidates) {
    try {
      fs.accessSync(c, fs.constants.X_OK);
      return c;
    } catch (_) { /* try the next one */ }
  }
  return null;
}

/** Run one `perchance-chat serve <action>` and resolve with its outcome. */
function runCli(cliPath, args, timeoutMs) {
  return new Promise((resolve) => {
    execFile(cliPath, args, { timeout: timeoutMs }, (err, stdout, stderr) => {
      const out = `${stdout || ''}${stderr || ''}`.trim();
      resolve({ ok: !err, output: out, error: err ? err.message : null });
    });
  });
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

  /**
   * Server lifecycle state, for the settings UI.
   *
   * Status comes over HTTP because /admin/status is richer than the CLI's
   * printed report and costs no process spawn. When the server is down there
   * is nothing to ask, so the answer is simply "not running" plus whether the
   * CLI needed to start it can be found at all - which is the actionable part.
   */
  async getServerStatus(store) {
    const url = getApiUrl(store);
    const cli = resolveCli(store);
    try {
      const res = await fetch(`${url}/admin/status`, {
        headers: { [ADMIN_HEADER]: '1' },
        signal: AbortSignal.timeout(5000),
      });
      if (res.ok) {
        const s = await res.json();
        return {
          running: true,
          url,
          cliPath: cli,
          pid: s.pid,
          uptimeSeconds: s.uptime_seconds,
          managedBy: s.managed_by,
          canRestartOverHttp: !!s.is_detached_server,
          generator: s.generator,
          log: s.log,
          config: s.config,
          imageConfigured: !!s.image?.configured,
          busy: !!s.busy || !!s.image?.busy,
        };
      }
      if (res.status === 404) {
        // Listening, but an older build without /admin. Everything else still
        // works, so say so precisely instead of reporting the server as down.
        return {
          running: true,
          url,
          cliPath: cli,
          adminUnavailable: true,
          error: 'this server predates /admin - restart it to pick up the new build',
        };
      }
      return { running: true, url, cliPath: cli, error: `HTTP ${res.status}` };
    } catch (e) {
      return {
        running: false,
        url,
        cliPath: cli,
        error: e.name === 'TimeoutError' ? 'timed out' : e.message,
      };
    }
  },

  /**
   * start / stop / restart, driven through the CLI rather than /admin.
   *
   * The CLI is the right tool even though two of the three have HTTP
   * equivalents: `start` has no HTTP form at all (nothing is listening to
   * answer it), and the CLI's start waits for the port to accept connections
   * before reporting success, so "started" means started rather than "a
   * process existed for a moment". Driving all three the same way also means
   * one code path to be wrong, instead of two that can disagree.
   */
  async serverControl(store, action) {
    if (!['start', 'stop', 'restart', 'status'].includes(action)) {
      return { ok: false, error: `unknown action '${action}'` };
    }
    const cliPath = resolveCli(store);
    if (!cliPath) {
      return {
        ok: false,
        error:
          'Could not find the perchance-chat command. Set its full path in ' +
          'Perchance settings (find it with `which perchance-chat`).',
      };
    }
    // start/restart wait for the port, which includes a Python process boot.
    const timeoutMs = action === 'stop' ? 30000 : 90000;
    const res = await runCli(cliPath, ['serve', action], timeoutMs);
    return { ...res, cliPath, action };
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

    const size = requestedSize(settings.width, settings.height);

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
      size,
      perchance: perchanceOpts,
    };

    const url = `${getApiUrl(store)}/v1/images/generations`;
    console.log(`${LOG_PREFIX} Generating at ${size} via ${url}`);

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
