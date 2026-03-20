// utils.js — Shared utilities

import { toastEl } from './dom-refs.js';

export function escapeHtml(str) {
  if (!str) return '';
  return str.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

const TOAST_ICONS = {
  success: '\u2713',
  error: '\u2717',
  warn: '\u26A0',
  info: '\u2139',
};

let toastTimer = null;
let toastUndoTimer = null;

/**
 * Show a toast notification.
 * @param {string} msg
 * @param {number} duration
 * @param {string} variant - 'success'|'error'|'warn'|'info'
 * @param {object} [opts] - { onUndo: Function, undoLabel: string }
 */
export function showToast(msg, duration, variant = '', opts = {}) {
  if (duration == null) {
    duration = variant === 'error' ? 10000 : variant === 'warn' ? 5000 : 2500;
  }
  const icon = TOAST_ICONS[variant] || '';
  let html = (icon ? `<span class="toast-icon">${icon}</span> ` : '') + escapeHtml(msg);
  if (opts.onUndo) {
    html += ` <button class="toast-undo">${escapeHtml(opts.undoLabel || 'Undo')}</button>`;
  }
  toastEl.innerHTML = html;
  toastEl.className = 'toast show' + (variant ? ' ' + variant : '');
  toastEl.style.pointerEvents = opts.onUndo ? 'auto' : '';
  clearTimeout(toastTimer);
  clearTimeout(toastUndoTimer);
  if (opts.onUndo) {
    const undoBtn = toastEl.querySelector('.toast-undo');
    if (undoBtn) {
      undoBtn.addEventListener('click', () => {
        clearTimeout(toastUndoTimer);
        opts.onUndo();
        toastEl.className = 'toast';
        toastEl.style.pointerEvents = '';
      }, { once: true });
    }
    toastUndoTimer = setTimeout(() => {
      if (opts.onExpire) opts.onExpire();
    }, duration);
  }
  toastTimer = setTimeout(() => {
    toastEl.className = 'toast';
    toastEl.style.pointerEvents = '';
  }, duration);
}

/**
 * Parse raw API error strings into user-friendly actionable messages.
 */
export function friendlyApiError(error, provider = '') {
  const msg = typeof error === 'string' ? error : error?.message || 'Unknown error';
  if (/401|unauthorized|invalid.*token|invalid.*key/i.test(msg))
    return `Invalid API key — update in Settings${provider ? ` (${provider})` : ''}`;
  if (/403|forbidden/i.test(msg))
    return 'Access denied — check your subscription or API permissions';
  if (/429|rate.?limit|too many/i.test(msg))
    return 'Rate limited — wait 30 seconds before retrying';
  if (/500|502|503|504|server error|internal/i.test(msg))
    return 'Server error — try again in a minute';
  if (/timeout|timed.?out|abort/i.test(msg))
    return 'Request timed out — check your connection';
  if (/network|econnrefused|enotfound|fetch failed/i.test(msg))
    return 'Connection failed — check your internet or server status';
  return msg;
}

/**
 * Format a timestamp as relative time (e.g. "5m ago", "2h ago").
 */
export function timeAgo(ts) {
  if (!ts) return '';
  const diff = Date.now() - ts;
  if (diff < 60000) return 'just now';
  if (diff < 3600000) return Math.floor(diff / 60000) + 'm ago';
  if (diff < 86400000) return Math.floor(diff / 3600000) + 'h ago';
  return Math.floor(diff / 86400000) + 'd ago';
}

// ---------------------------------------------------------------------------
// Loading state utility
// ---------------------------------------------------------------------------

const STATUS_VARIANT_ICONS = {
  success: '\u2713',
  error: '\u2717',
  warn: '\u26A0',
};

/**
 * Create a reusable loading state controller for a status element.
 * @param {HTMLElement} statusEl - element to display status text/class
 * @returns {{ start(msg), progress(msg, pct), done(msg, variant), abort() }}
 */
export function createLoadingState(statusEl) {
  if (!statusEl) return { start() {}, progress() {}, done() {}, abort() {} };
  if (!statusEl.getAttribute('aria-live')) {
    statusEl.setAttribute('aria-live', 'polite');
  }
  return {
    start(msg) {
      statusEl.textContent = msg || 'Working...';
      statusEl.className = 'status loading';
    },
    progress(msg, pct) {
      const pctStr = pct != null ? ` (${Math.round(pct)}%)` : '';
      statusEl.textContent = (msg || 'Working...') + pctStr;
      statusEl.className = 'status loading';
    },
    done(msg, variant = 'success') {
      const icon = STATUS_VARIANT_ICONS[variant] || '';
      statusEl.textContent = (icon ? icon + ' ' : '') + (msg || 'Done');
      statusEl.className = 'status ' + variant;
    },
    abort() {
      statusEl.textContent = '';
      statusEl.className = 'status';
    },
  };
}

// ---------------------------------------------------------------------------
// Story switch guard
// ---------------------------------------------------------------------------

/**
 * Create a guard function that checks if the current story has changed.
 * Call at the start of an async operation, then check .isStale() before applying results.
 * @param {object} state - renderer state object with currentStoryId
 * @returns {{ storyId: string, isStale: () => boolean }}
 */
export function createStoryGuard(state) {
  const storyId = state.currentStoryId;
  return {
    storyId,
    isStale() { return state.currentStoryId !== storyId; },
  };
}

// ---------------------------------------------------------------------------
// Memoize async IPC calls with TTL
// ---------------------------------------------------------------------------

const _memoCache = new Map();

/**
 * Memoize an async function with a time-to-live.
 * Prevents redundant IPC calls (e.g., getModels, getVoices) on every settings modal open.
 * @param {string} key - unique cache key
 * @param {Function} fn - async function to memoize
 * @param {number} [ttlMs=30000] - cache lifetime in ms
 */
export async function memoizeAsync(key, fn, ttlMs = 30000) {
  const cached = _memoCache.get(key);
  if (cached && Date.now() - cached.ts < ttlMs) return cached.value;
  const value = await fn();
  _memoCache.set(key, { value, ts: Date.now() });
  return value;
}

/** Clear a specific memoized entry or all entries. */
export function memoizeClear(key) {
  if (key) _memoCache.delete(key);
  else _memoCache.clear();
}

// Structured error banner for inline error display
export function showError(container, message, detail = '') {
  container.innerHTML = `
    <div style="display:flex;align-items:flex-start;gap:8px;background:var(--error-bg-subtle);border:1px solid var(--error-border);border-radius:6px;padding:8px 12px;font-size:11px;color:var(--error-light);">
      <span style="font-size:14px;flex-shrink:0;">\u26A0</span>
      <div style="flex:1;">
        <div>${escapeHtml(message)}</div>
        ${detail ? `<div style="color:var(--error-soft);font-size:10px;margin-top:2px;">${escapeHtml(detail)}</div>` : ''}
      </div>
      <button onclick="this.parentElement.parentElement.style.display='none'" style="background:none;border:none;color:var(--text-dim);cursor:pointer;font-size:14px;padding:0;">\u00D7</button>
    </div>
  `;
  container.style.display = '';
}
