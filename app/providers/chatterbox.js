// Chatterbox TTS provider - a local Chatterbox server (voiceworks/chatterbox-server).
//
// API: GET /health, GET /voices, POST /warm, POST /tts {text, voice, ...} -> audio/wav.
// The server's own narrator mode splits on *asterisks*, which NovelAI prose does not
// use, so the app does speaker attribution itself and sends one voice per request.
//
// Voice gender (for auto-assign and pronoun-based speaker resolution) comes from, in
// order: a user override, the voice name (female_01, soothing_british_male), then the
// median pitch of the reference clip read from the voices folder. Pitch is reliable
// at the extremes only; men at 145-180 Hz and women at 165-210 Hz overlap, so the
// middle band is reported as unknown with the pitch attached.

const fs = require('fs');
const path = require('path');

const DEFAULT_URL = 'http://127.0.0.1:21065';
const DEFAULT_VOICES_DIR = 'C:\\AllTalk\\voices';
const MALE_BELOW_HZ = 140;
const FEMALE_ABOVE_HZ = 185;
const COLD_START_TIMEOUT_MS = 6 * 60 * 1000; // model load (up to 300 s) + render

// In memory: name -> { key, pitch }. Persisted in the store so restarts skip the analysis.
let pitchCache = null;

function getUrl(store) {
  const raw = (store.get('ttsChatterboxUrl') || DEFAULT_URL).trim().replace(/\/+$/, '');
  return raw.replace('://localhost', '://127.0.0.1'); // Electron fetch + IPv6 localhost
}

function getVoicesDir(store) {
  return (store.get('ttsChatterboxVoicesDir') || DEFAULT_VOICES_DIR).trim();
}

async function fetchWithTimeout(url, opts = {}, timeoutMs = 5000) {
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), timeoutMs);
  try {
    return await fetch(url, { ...opts, signal: ctrl.signal });
  } catch (e) {
    if (e.name === 'AbortError') throw new Error(`Chatterbox did not answer within ${Math.round(timeoutMs / 1000)}s`);
    throw new Error(`Chatterbox server not reachable at ${url.split('/').slice(0, 3).join('/')} (${e.message})`);
  } finally {
    clearTimeout(t);
  }
}

// --- Pitch analysis of the reference clips ---

function readWavMono(file) {
  const b = fs.readFileSync(file);
  if (b.toString('ascii', 0, 4) !== 'RIFF' || b.toString('ascii', 8, 12) !== 'WAVE') return null;
  let off = 12, fmt = null;
  while (off + 8 <= b.length) {
    const id = b.toString('ascii', off, off + 4);
    const size = b.readUInt32LE(off + 4);
    const body = off + 8;
    if (id === 'fmt ') {
      fmt = { format: b.readUInt16LE(body), ch: b.readUInt16LE(body + 2), sr: b.readUInt32LE(body + 4), bits: b.readUInt16LE(body + 14) };
    } else if (id === 'data' && fmt) {
      if (fmt.format !== 1 || fmt.bits !== 16) return null; // PCM s16 only
      const n = Math.floor(Math.min(size, b.length - body) / 2 / fmt.ch);
      const x = new Float32Array(n);
      for (let i = 0; i < n; i++) x[i] = b.readInt16LE(body + i * 2 * fmt.ch) / 32768;
      return { x, sr: fmt.sr };
    }
    off = body + size + (size & 1);
  }
  return null;
}

/** Median F0 in Hz over voiced 40 ms frames (normalised autocorrelation), or null. */
function medianPitch(wav) {
  if (!wav) return null;
  const { x, sr } = wav;
  const win = Math.round(sr * 0.04), hop = Math.round(sr * 0.02);
  const minLag = Math.floor(sr / 400), maxLag = Math.ceil(sr / 70);
  let peak = 0;
  for (let i = 0; i < x.length; i++) peak = Math.max(peak, Math.abs(x[i]));
  const f0s = [];
  for (let s = 0; s + win + maxLag < x.length; s += hop) {
    let e = 0;
    for (let i = 0; i < win; i++) e += x[s + i] * x[s + i];
    if (Math.sqrt(e / win) < peak * 0.08) continue; // silence / breath
    let best = 0, bestLag = 0;
    for (let lag = minLag; lag <= maxLag; lag++) {
      let c = 0, e2 = 0;
      for (let i = 0; i < win; i++) { c += x[s + i] * x[s + i + lag]; e2 += x[s + i + lag] * x[s + i + lag]; }
      const r = c / Math.sqrt(e * e2 + 1e-12);
      if (r > best) { best = r; bestLag = lag; }
    }
    if (best > 0.6) f0s.push(sr / bestLag);
  }
  if (f0s.length < 10) return null;
  f0s.sort((a, b) => a - b);
  return Math.round(f0s[Math.floor(f0s.length / 2)]);
}

const FEMALE_WORDS = new Set(['female', 'fem', 'f', 'woman', 'women', 'girl', 'lady', 'feminine']);
const MALE_WORDS = new Set(['male', 'm', 'man', 'men', 'boy', 'guy', 'masculine']);

/** Gender from words in the voice name (snake_case, kebab, spaces or CamelCase). */
function genderFromName(name) {
  const words = name.replace(/([a-z])([A-Z])/g, '$1 $2').toLowerCase().split(/[^a-z]+/).filter(Boolean);
  const f = words.some((w) => FEMALE_WORDS.has(w));
  const m = words.some((w) => MALE_WORDS.has(w));
  if (f && !m) return 'female';
  if (m && !f) return 'male';
  return null;
}

function genderFromPitch(hz) {
  if (!hz) return 'unknown';
  if (hz < MALE_BELOW_HZ) return 'male';
  if (hz > FEMALE_ABOVE_HZ) return 'female';
  return 'unknown';
}

/** Pitch for each voice name, computed once per clip version and cached. */
async function analyzeVoices(names, store) {
  const dir = getVoicesDir(store);
  if (!pitchCache) pitchCache = { ...(store.get('ttsChatterboxPitchCache') || {}) };
  let changed = false;
  const out = {};
  for (const name of names) {
    if (name === 'default') continue;
    const file = path.join(dir, `${name}.wav`);
    let st;
    try { st = fs.statSync(file); } catch { continue; } // folder not on this machine
    const key = `${st.size}:${Math.round(st.mtimeMs)}`;
    if (pitchCache[name]?.key !== key) {
      let pitch = null;
      try { pitch = medianPitch(readWavMono(file)); } catch (e) { console.warn('[Chatterbox] pitch failed for', name, e.message); }
      pitchCache[name] = { key, pitch };
      changed = true;
      await new Promise((r) => setImmediate(r)); // keep the main process responsive
    }
    out[name] = pitchCache[name].pitch;
  }
  if (changed) store.set('ttsChatterboxPitchCache', pitchCache);
  return out;
}

// name -> gender, from the last voice listing (used by main.js pronoun resolution)
let lastGenders = {};

module.exports = {
  id: 'chatterbox',
  name: 'Chatterbox (local)',
  DEFAULT_URL,
  DEFAULT_VOICES_DIR,

  async getStatus(store) {
    try {
      const res = await fetchWithTimeout(`${getUrl(store)}/health`, {}, 3000);
      if (!res.ok) return { online: false, error: `HTTP ${res.status}` };
      const h = await res.json();
      return { online: true, model: h.model || 'unknown', idleUnloadSeconds: h.idle_unload_seconds };
    } catch (e) {
      return { online: false, error: e.message };
    }
  },

  async warm(store) {
    const res = await fetchWithTimeout(`${getUrl(store)}/warm`, { method: 'POST' }, COLD_START_TIMEOUT_MS);
    if (!res.ok) throw new Error(`Chatterbox warm-up failed (${res.status}): ${(await res.text()).slice(0, 200)}`);
    return res.json();
  },

  /** [{ id, name, gender, genderSource, pitch }] for every voice the server offers. */
  async getVoices(store) {
    const res = await fetchWithTimeout(`${getUrl(store)}/voices`, {}, 5000);
    if (!res.ok) throw new Error(`Chatterbox /voices failed (${res.status})`);
    const { voices = [] } = await res.json();
    const pitches = await analyzeVoices(voices, store);
    const overrides = store.get('ttsChatterboxVoiceGenders') || {};
    const genders = {};
    const list = voices.map((id) => {
      const pitch = pitches[id] ?? null;
      let gender = 'unknown', genderSource = 'none';
      if (overrides[id] === 'male' || overrides[id] === 'female') { gender = overrides[id]; genderSource = 'override'; }
      else if (genderFromName(id)) { gender = genderFromName(id); genderSource = 'name'; }
      else if (pitch) { gender = genderFromPitch(pitch); genderSource = 'pitch'; }
      genders[id] = gender;
      const detail = [gender !== 'unknown' ? gender : null, pitch ? `${pitch} Hz` : null].filter(Boolean).join(', ');
      const label = id === 'default' ? 'default (Chatterbox built-in)' : (detail ? `${id} (${detail})` : id);
      return { id, name: label, gender, genderSource, pitch };
    });
    lastGenders = genders;
    return list;
  },

  /** Gender from the last listing; 'unknown' when the voice was never listed. */
  voiceGender(voiceId) {
    return lastGenders[voiceId] || 'unknown';
  },

  async generateSpeech(text, voice, store) {
    const body = {
      text,
      voice: voice || 'default',
      narrator_enabled: 'false', // the app already split narration from dialogue
    };
    const ex = Number(store.get('ttsChatterboxExaggeration'));
    if (Number.isFinite(ex) && ex > 0) body.exaggeration = ex;
    const res = await fetchWithTimeout(`${getUrl(store)}/tts`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    }, COLD_START_TIMEOUT_MS);
    if (!res.ok) {
      const errorText = await res.text();
      throw new Error(`Chatterbox TTS error ${res.status}: ${errorText.substring(0, 300)}`);
    }
    const buf = Buffer.from(await res.arrayBuffer());
    return { audioData: `data:audio/wav;base64,${buf.toString('base64')}`, format: 'wav' };
  },

  // exported for tests
  _medianPitch: medianPitch,
  _readWavMono: readWavMono,
  _genderFromName: genderFromName,
  _genderFromPitch: genderFromPitch,
};
