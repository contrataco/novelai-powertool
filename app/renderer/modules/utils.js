// utils.js — Shared utilities

import { toastContainer } from './dom-refs.js';

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

const MAX_VISIBLE_TOASTS = 3;
const activeToasts = [];

function pruneToasts() {
  while (activeToasts.length > MAX_VISIBLE_TOASTS) {
    const oldest = activeToasts.shift();
    if (oldest?.el?.parentNode) {
      oldest.el.classList.remove('show');
      setTimeout(() => oldest.el.remove(), 300);
    }
    if (oldest?.timer) clearTimeout(oldest.timer);
    if (oldest?.undoTimer) clearTimeout(oldest.undoTimer);
  }
}

/**
 * Show a toast notification. Supports stacking (max 3 visible).
 * @param {string} msg
 * @param {number} [duration]
 * @param {string} [variant] - 'success'|'error'|'warn'|'info'
 * @param {object} [opts] - { onUndo, undoLabel, onExpire, persistent, onCancel }
 * @returns {HTMLElement} the toast element (for dismissToast)
 */
export function showToast(msg, duration, variant = '', opts = {}) {
  if (!toastContainer) return null;
  if (duration == null) {
    duration = opts.persistent ? 0 : variant === 'error' ? 10000 : variant === 'warn' ? 5000 : 2500;
  }

  const el = document.createElement('div');
  el.className = 'toast' + (variant ? ' ' + variant : '');
  const icon = TOAST_ICONS[variant] || '';
  let html = (icon ? `<span class="toast-icon">${icon}</span> ` : '') + escapeHtml(msg);
  if (opts.onUndo) html += ` <button class="toast-undo">${escapeHtml(opts.undoLabel || 'Undo')}</button>`;
  if (opts.onCancel) html += ` <button class="toast-cancel">Cancel</button>`;
  el.innerHTML = html;

  toastContainer.appendChild(el);
  requestAnimationFrame(() => el.classList.add('show'));

  const entry = { el, timer: null, undoTimer: null };
  activeToasts.push(entry);
  pruneToasts();

  if (opts.onUndo) {
    const undoBtn = el.querySelector('.toast-undo');
    if (undoBtn) {
      undoBtn.addEventListener('click', () => {
        clearTimeout(entry.undoTimer);
        opts.onUndo();
        dismissToast(el);
      }, { once: true });
    }
    entry.undoTimer = setTimeout(() => { if (opts.onExpire) opts.onExpire(); }, duration || 10000);
  }

  if (opts.onCancel) {
    const cancelBtn = el.querySelector('.toast-cancel');
    if (cancelBtn) cancelBtn.addEventListener('click', () => { opts.onCancel(); dismissToast(el); }, { once: true });
  }

  if (duration > 0) {
    entry.timer = setTimeout(() => dismissToast(el), duration);
  }

  return el;
}

/**
 * Dismiss a specific toast element.
 */
export function dismissToast(el) {
  if (!el) return;
  el.classList.remove('show');
  const idx = activeToasts.findIndex(t => t.el === el);
  if (idx >= 0) {
    const entry = activeToasts[idx];
    if (entry.timer) clearTimeout(entry.timer);
    if (entry.undoTimer) clearTimeout(entry.undoTimer);
    activeToasts.splice(idx, 1);
  }
  setTimeout(() => el.remove(), 300);
}

/**
 * Create a spinner element with consistent sizing.
 * @param {'sm'|'md'|'lg'} [size='md'] - sm=12px, md=20px, lg=40px (default .spinner)
 */
export function createSpinner(size = 'md') {
  const el = document.createElement('div');
  el.className = size === 'lg' ? 'spinner' : `spinner spinner-${size}`;
  return el;
}

/**
 * Set progress bar fill via CSS custom property.
 * @param {HTMLElement} fillEl - the progress fill element
 * @param {number} pct - percentage (0-100)
 */
export function setProgress(fillEl, pct) {
  if (fillEl) fillEl.style.setProperty('--progress', Math.min(100, Math.max(0, pct)) + '%');
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
    <div class="error-banner">
      <span class="error-banner-icon">\u26A0</span>
      <div class="error-banner-body">
        <div>${escapeHtml(message)}</div>
        ${detail ? `<div class="error-banner-detail">${escapeHtml(detail)}</div>` : ''}
      </div>
      <button onclick="this.parentElement.parentElement.style.display='none'" class="error-banner-close">\u00D7</button>
    </div>
  `;
  container.style.display = '';
}
