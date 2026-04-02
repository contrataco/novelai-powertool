const { BrowserWindow, session } = require('electron');
const { spawn } = require('child_process');
const http = require('http');
const path = require('path');
const fs = require('fs');
const os = require('os');
const WebSocket = require('ws');

const CHROME_UA = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36';

// Chrome binary paths per platform
function findChromePath() {
  const candidates = process.platform === 'darwin'
    ? [
        '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
        '/Applications/Chromium.app/Contents/MacOS/Chromium',
        '/Applications/Google Chrome Canary.app/Contents/MacOS/Google Chrome Canary',
        '/Applications/Brave Browser.app/Contents/MacOS/Brave Browser',
      ]
    : process.platform === 'win32'
    ? [
        path.join(process.env.PROGRAMFILES || '', 'Google/Chrome/Application/chrome.exe'),
        path.join(process.env['PROGRAMFILES(X86)'] || '', 'Google/Chrome/Application/chrome.exe'),
        path.join(process.env.LOCALAPPDATA || '', 'Google/Chrome/Application/chrome.exe'),
      ]
    : [
        '/usr/bin/google-chrome',
        '/usr/bin/google-chrome-stable',
        '/usr/bin/chromium',
        '/usr/bin/chromium-browser',
        '/snap/bin/chromium',
      ];

  return candidates.find(p => {
    try { return fs.existsSync(p); } catch { return false; }
  });
}

function fetchJSON(url) {
  return new Promise((resolve, reject) => {
    http.get(url, (res) => {
      let data = '';
      res.on('data', chunk => data += chunk);
      res.on('end', () => {
        try { resolve(JSON.parse(data)); }
        catch (e) { reject(e); }
      });
    }).on('error', reject);
  });
}

async function waitForDebugPort(port, maxWait = 15000) {
  const start = Date.now();
  while (Date.now() - start < maxWait) {
    try {
      await fetchJSON(`http://127.0.0.1:${port}/json/version`);
      return true;
    } catch {
      await new Promise(r => setTimeout(r, 500));
    }
  }
  return false;
}

/**
 * Extract a Perchance userKey via system Chrome + CDP.
 * Launches Chrome with remote debugging, auto-attaches to all targets
 * (including cross-origin iframes), monitors network for userKey,
 * and auto-clicks the Generate button via Runtime.evaluate on iframe targets.
 */
async function extractPerchanceKeyViaChrome(store) {
  const chromePath = findChromePath();
  if (!chromePath) {
    console.log('[PerchanceKey] No system Chrome found');
    return null;
  }

  console.log(`[PerchanceKey] Using system Chrome: ${chromePath}`);

  const debugPort = 9222 + Math.floor(Math.random() * 700);
  const tmpDir = path.join(os.tmpdir(), `sv-chrome-extract-${Date.now()}`);
  fs.mkdirSync(tmpDir, { recursive: true });

  const chromeArgs = [
    `--remote-debugging-port=${debugPort}`,
    `--user-data-dir=${tmpDir}`,
    '--no-first-run',
    '--no-default-browser-check',
    '--disable-background-networking',
    '--disable-sync',
    'https://perchance.org/ai-text-to-image-generator',
  ];

  const chrome = spawn(chromePath, chromeArgs, {
    stdio: ['ignore', 'pipe', 'pipe'],
    detached: false,
  });

  let chromeExited = false;
  chrome.on('exit', () => { chromeExited = true; });
  chrome.on('error', (err) => {
    console.error('[PerchanceKey] Chrome launch error:', err.message);
  });

  function cleanup() {
    if (!chromeExited) {
      try { chrome.kill(); } catch {}
    }
    setTimeout(() => {
      try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch {}
    }, 2000);
  }

  return new Promise(async (resolve) => {
    let resolved = false;
    let ws;

    function done(key) {
      if (resolved) return;
      resolved = true;
      clearTimeout(timeout);
      if (key) {
        store.set('perchanceUserKey', key);
        store.set('perchanceKeyAcquiredAt', Date.now());
        console.log(`[PerchanceKey] Key captured via Chrome: ${key.substring(0, 10)}...`);
      }
      try { ws?.close(); } catch {}
      cleanup();
      resolve(key || null);
    }

    const timeout = setTimeout(() => {
      console.log('[PerchanceKey] Chrome extraction timed out');
      done(null);
    }, 90000);

    try {
      console.log(`[PerchanceKey] Waiting for Chrome debug port ${debugPort}...`);
      const ready = await waitForDebugPort(debugPort);
      if (!ready) {
        console.log('[PerchanceKey] Chrome debug port did not become available');
        done(null);
        return;
      }

      const version = await fetchJSON(`http://127.0.0.1:${debugPort}/json/version`);
      const browserWsUrl = version.webSocketDebuggerUrl;

      console.log(`[PerchanceKey] Connecting to browser CDP: ${browserWsUrl}`);
      ws = new WebSocket(browserWsUrl);

      let cmdId = 1;
      function cdpSend(method, params = {}, sessionId) {
        const msg = { id: cmdId++, method, params };
        if (sessionId) msg.sessionId = sessionId;
        ws.send(JSON.stringify(msg));
      }

      // Track iframe sessions for auto-click
      const iframeSessions = new Map(); // sessionId → targetUrl
      const enabledSessions = new Set();
      let autoClicked = false;

      function enableNetworkOnSession(sessionId) {
        if (enabledSessions.has(sessionId)) return;
        enabledSessions.add(sessionId);
        cdpSend('Network.enable', {}, sessionId);
        cdpSend('Runtime.enable', {}, sessionId);
      }

      function checkForKey(url) {
        try {
          if (!url.includes('image-generation.perchance.org')) return;
          const parsed = new URL(url);
          const userKey = parsed.searchParams.get('userKey');
          if (userKey && userKey.length === 64) {
            done(userKey);
          }
        } catch {}
      }

      /**
       * Try to auto-click Generate in an iframe session via Runtime.evaluate.
       */
      function tryAutoClickInSession(sessionId) {
        if (autoClicked || resolved) return;
        const clickScript = `
          (function() {
            var ta = document.querySelector('textarea');
            if (ta) {
              var setter = Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value').set;
              if (setter) {
                setter.call(ta, 'test');
                ta.dispatchEvent(new Event('input', { bubbles: true }));
              }
            }
            var btns = document.querySelectorAll('button');
            for (var b of btns) {
              if (b.textContent.toLowerCase().includes('generate')) {
                b.click();
                return 'clicked';
              }
            }
            return 'no_button';
          })()
        `;
        cdpSend('Runtime.evaluate', { expression: clickScript, returnByValue: true }, sessionId);
      }

      ws.on('open', () => {
        console.log('[PerchanceKey] CDP connected, setting up auto-attach...');
        cdpSend('Target.setAutoAttach', {
          autoAttach: true,
          waitForDebuggerOnStart: false,
          flatten: true,
        });
        cdpSend('Target.getTargets');
      });

      ws.on('message', (raw) => {
        try {
          const msg = JSON.parse(raw.toString());

          // New target attached — enable Network + Runtime monitoring
          if (msg.method === 'Target.attachedToTarget') {
            const sessionId = msg.params.sessionId;
            const targetInfo = msg.params.targetInfo;
            console.log(`[PerchanceKey] Attached to target: ${targetInfo.type} - ${targetInfo.url?.substring(0, 80)}`);
            enableNetworkOnSession(sessionId);

            // Track iframe targets that look like the generator
            if (targetInfo.url && targetInfo.url.includes('perchance.org/ai-text-to-image')) {
              iframeSessions.set(sessionId, targetInfo.url);
              // Delay auto-click to let page JS initialize
              setTimeout(() => tryAutoClickInSession(sessionId), 3000);
              setTimeout(() => tryAutoClickInSession(sessionId), 6000);
              setTimeout(() => tryAutoClickInSession(sessionId), 10000);
              setTimeout(() => tryAutoClickInSession(sessionId), 15000);
            }
          }

          // Network request — check for userKey
          if (msg.method === 'Network.requestWillBeSent') {
            checkForKey(msg.params.request.url);
          }

          // Runtime.evaluate response — check if auto-click succeeded
          if (msg.result?.result?.value === 'clicked' && !autoClicked) {
            autoClicked = true;
            console.log('[PerchanceKey] Auto-clicked Generate via CDP');
          }

          // Handle getTargets response
          if (msg.id && msg.result?.targetInfos) {
            for (const target of msg.result.targetInfos) {
              if (target.type === 'page' || target.type === 'iframe') {
                cdpSend('Target.attachToTarget', {
                  targetId: target.targetId,
                  flatten: true,
                });
              }
            }
          }
        } catch {}
      });

      ws.on('error', (err) => {
        console.error('[PerchanceKey] CDP WebSocket error:', err.message);
      });

      ws.on('close', () => {
        console.log('[PerchanceKey] CDP connection closed');
      });

      chrome.on('exit', () => { done(null); });

    } catch (err) {
      console.error('[PerchanceKey] Chrome extraction error:', err);
      done(null);
    }
  });
}

/**
 * Fallback: Extract key using Electron BrowserWindow.
 * Window must be visible for Turnstile — may still fail.
 */
async function extractPerchanceKeyViaElectron(store) {
  return new Promise((resolve) => {
    const partition = 'persist:perchance-api';
    const ses = session.fromPartition(partition);
    ses.setUserAgent(CHROME_UA);

    const win = new BrowserWindow({
      width: 900,
      height: 700,
      show: false,
      title: 'Perchance Key Extraction',
      webPreferences: {
        partition,
        nodeIntegration: false,
        contextIsolation: false,
        preload: path.join(__dirname, 'perchance-stealth.js'),
      }
    });

    let resolved = false;

    function finish(key) {
      if (resolved) return;
      resolved = true;
      clearTimeout(timeoutTimer);
      ses.webRequest.onBeforeSendHeaders(null);
      if (key) {
        store.set('perchanceUserKey', key);
        store.set('perchanceKeyAcquiredAt', Date.now());
        console.log(`[PerchanceKey] Key extracted via Electron: ${key.substring(0, 10)}...`);
      }
      win.destroy();
      resolve(key || null);
    }

    ses.webRequest.onBeforeSendHeaders(
      { urls: ['*://image-generation.perchance.org/*'] },
      (details, callback) => {
        try {
          const url = new URL(details.url);
          const userKey = url.searchParams.get('userKey');
          if (userKey && userKey.length === 64) {
            finish(userKey);
          }
        } catch {}
        callback({ cancel: false });
      }
    );

    const timeoutTimer = setTimeout(() => {
      if (!resolved) {
        console.log('[PerchanceKey] Electron extraction timed out');
        finish(null);
      }
    }, 60000);

    win.webContents.on('did-finish-load', () => {
      win.show();
      win.webContents.executeJavaScript(`
        (function() {
          if (document.getElementById('sv-extract-banner')) return;
          var banner = document.createElement('div');
          banner.id = 'sv-extract-banner';
          banner.style.cssText = 'position:fixed;top:0;left:0;right:0;z-index:999999;background:#e94560;color:white;padding:14px 20px;font-family:sans-serif;font-size:15px;text-align:center;font-weight:bold;box-shadow:0 2px 8px rgba(0,0,0,0.3);line-height:1.5;';
          var TIMEOUT_S = 60;
          banner.innerHTML = 'PowerTool — Key Extraction<br><span style="font-weight:normal;font-size:13px;">1. Wait for the page to fully load &nbsp; 2. Click <b>Generate</b> &nbsp; 3. This window closes automatically &nbsp;<span id="sv-countdown" style="opacity:0.8;">(' + TIMEOUT_S + 's)</span></span>';
          document.body.appendChild(banner);
          document.body.style.paddingTop = '64px';

          var _svCount = TIMEOUT_S;
          var _svTimer = setInterval(function() {
            _svCount--;
            var el = document.getElementById('sv-countdown');
            if (el) el.textContent = '(' + _svCount + 's)';
            if (_svCount <= 0) clearInterval(_svTimer);
          }, 1000);

          function tryFillPrompt() {
            var ta = document.querySelector('textarea[placeholder*="prompt"], textarea[placeholder*="Prompt"], textarea.prompt');
            if (!ta) ta = document.querySelector('textarea');
            if (ta) {
              var nativeSetter = Object.getOwnPropertyDescriptor(window.HTMLTextAreaElement.prototype, 'value').set;
              nativeSetter.call(ta, 'a scenic mountain landscape');
              ta.dispatchEvent(new Event('input', { bubbles: true }));
            }
          }
          tryFillPrompt();
          setTimeout(tryFillPrompt, 2000);
          setTimeout(tryFillPrompt, 5000);
        })()
      `).catch(() => {});
    });

    win.on('closed', () => {
      if (!resolved) {
        resolved = true;
        clearTimeout(timeoutTimer);
        ses.webRequest.onBeforeSendHeaders(null);
        resolve(null);
      }
    });

    win.loadURL('https://perchance.org/ai-text-to-image-generator', {
      userAgent: CHROME_UA
    });
  });
}

/**
 * Main extraction entry point. Tries system Chrome first (Turnstile/CF
 * challenges pass reliably in real Chrome but always fail in Electron).
 * Falls back to Electron BrowserWindow if Chrome is unavailable.
 */
async function extractPerchanceKey(store) {
  const chromePath = findChromePath();
  if (chromePath) {
    console.log('[PerchanceKey] Attempting extraction via system Chrome...');
    const chromeKey = await extractPerchanceKeyViaChrome(store);
    if (chromeKey) return chromeKey;
    console.log('[PerchanceKey] Chrome extraction failed, falling back to Electron...');
  } else {
    console.log('[PerchanceKey] No system Chrome found, using Electron fallback...');
  }

  const electronKey = await extractPerchanceKeyViaElectron(store);
  if (electronKey) return electronKey;

  return null;
}

/**
 * Check if a stored userKey is still valid.
 */
async function verifyPerchanceKey(userKey) {
  try {
    const url = `https://image-generation.perchance.org/api/checkVerificationStatus?userKey=${encodeURIComponent(userKey)}&__cacheBust=${Math.random()}`;
    const response = await fetch(url);
    const text = await response.text();

    if (text.includes('Just a moment') || text.includes('cf_chl_opt') || text.includes('challenge-platform')) {
      console.log('[PerchanceKey] Verification blocked by Cloudflare, assuming key is valid');
      return 'unknown';
    }

    if (text.includes('not_verified')) {
      return 'not_verified';
    }

    return 'valid';
  } catch (e) {
    console.log('[PerchanceKey] Verification request failed (likely CF):', e.message);
    return 'unknown';
  }
}

module.exports = { extractPerchanceKey, verifyPerchanceKey };
