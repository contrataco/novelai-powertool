/**
 * Perchance Text Provider - chat completions from the local perchance-chat
 * server, the same one the Perchance image provider uses.
 * TEXT-ONLY provider (not image generation).
 * Follows generateTextFn contract: async (messages, options) => { output: string }
 *
 * Main process only: the server sends no CORS headers and checks the Host
 * header. It serializes requests, so a parallel caller just waits its turn -
 * which is why this is never picked as a hybrid-scan partner.
 */

const LOG_PREFIX = '[Perchance-Text]';

const id = 'perchance';
const name = 'Perchance (Local API)';
const defaultModel = 'perchance';
// The server's own models: plain chat, code, and story continuation.
const MODELS = ['perchance', 'perchance-story', 'perchance-code'];

// The server queues behind any running request for up to 120s before it
// gives up with a 504, so the client must wait longer than that.
const TIMEOUT_MS = 180000;

function baseUrl(store) {
  const raw = (store.get('perchanceApiUrl') || 'http://127.0.0.1:8730').trim();
  return raw.replace('localhost', '127.0.0.1').replace(/\/+$/, '');
}

/**
 * Generate text via the perchance-chat OpenAI-compatible endpoint.
 * @param {Array<{role: string, content: string}>} messages
 * @param {{max_tokens?: number, temperature?: number, model?: string}} options
 * @param {import('electron-store')} store
 * @returns {Promise<{output: string}>}
 */
async function generateText(messages, options, store) {
  const url = baseUrl(store);
  const model = options.model || store.get('perchanceTextModel') || defaultModel;
  const maxTokens = options.max_tokens || 300;
  const temperature = options.temperature || 0.4;

  console.log(`${LOG_PREFIX} Calling ${model} (max_tokens=${maxTokens}, temp=${temperature})`);

  let response;
  try {
    response = await fetch(`${url}/v1/chat/completions`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ model, messages, max_tokens: maxTokens, temperature }),
      signal: AbortSignal.timeout(TIMEOUT_MS),
    });
  } catch (err) {
    if (err.name === 'TimeoutError') throw new Error(`Perchance text API timed out after ${TIMEOUT_MS / 1000}s`);
    throw new Error(`Cannot reach the Perchance server at ${url} - is perchance-chat running? (${err.cause?.code || err.message})`);
  }

  if (!response.ok) {
    const text = await response.text().catch(() => '');
    const err = new Error(`Perchance text API error ${response.status}: ${text.slice(0, 300)}`);
    err.status = response.status;
    throw err;
  }

  const data = await response.json();
  const content = data.choices?.[0]?.message?.content || '';
  console.log(`${LOG_PREFIX} Response: ${content.length} chars`);
  return { output: content };
}

/** Whether the server answers and lists text models. */
async function checkReady(store) {
  try {
    const res = await fetch(`${baseUrl(store)}/v1/models`, { signal: AbortSignal.timeout(4000) });
    if (!res.ok) return false;
    const data = await res.json();
    return (data.data || []).some((m) => m.perchance_kind === 'text');
  } catch {
    return false;
  }
}

module.exports = { id, name, defaultModel, MODELS, generateText, checkReady };
