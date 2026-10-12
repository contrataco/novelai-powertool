// panel-resize.js - Drag (or arrow-key) resizing of the right-hand side panel.
//
// The width lives in the --side-panel-width CSS variable on #imagePanel and
// is remembered per machine in localStorage. Double-click the handle to go
// back to the default. Width transitions are switched off while dragging so
// the panel tracks the pointer instead of easing behind it.

const STORAGE_KEY = 'powertool.sidePanelWidth';
const DEFAULT_WIDTH = 440;
const MIN_WIDTH = 300;
const KEY_STEP = 24;

function maxWidth() {
  // Leave the editor or webview at least 360px of the window.
  return Math.max(MIN_WIDTH, Math.min(1000, window.innerWidth - 360));
}

function clamp(w) {
  return Math.round(Math.min(maxWidth(), Math.max(MIN_WIDTH, w)));
}

function readSaved() {
  try {
    const v = parseInt(localStorage.getItem(STORAGE_KEY), 10);
    return Number.isFinite(v) ? v : null;
  } catch {
    return null;
  }
}

function save(w) {
  try { localStorage.setItem(STORAGE_KEY, String(w)); } catch { /* per-viewer convenience only */ }
}

export function init() {
  const panel = document.getElementById('imagePanel');
  const handle = document.getElementById('panelResizeHandle');
  if (!panel || !handle) return;

  let width = clamp(readSaved() ?? DEFAULT_WIDTH);
  const apply = (w, persist) => {
    width = clamp(w);
    panel.style.setProperty('--side-panel-width', `${width}px`);
    handle.setAttribute('aria-valuenow', String(width));
    if (persist) save(width);
  };
  handle.setAttribute('aria-valuemin', String(MIN_WIDTH));
  handle.setAttribute('aria-valuemax', String(maxWidth()));
  apply(width, false);

  handle.addEventListener('pointerdown', (e) => {
    if (e.button !== 0) return;
    e.preventDefault();
    handle.setPointerCapture(e.pointerId);
    const startX = e.clientX;
    const startWidth = width;
    panel.classList.add('is-resizing');
    document.body.classList.add('is-resizing-panel');

    const onMove = (ev) => apply(startWidth + (startX - ev.clientX), false);
    const onUp = () => {
      handle.removeEventListener('pointermove', onMove);
      handle.removeEventListener('pointerup', onUp);
      handle.removeEventListener('pointercancel', onUp);
      panel.classList.remove('is-resizing');
      document.body.classList.remove('is-resizing-panel');
      save(width);
    };
    handle.addEventListener('pointermove', onMove);
    handle.addEventListener('pointerup', onUp);
    handle.addEventListener('pointercancel', onUp);
  });

  handle.addEventListener('dblclick', () => apply(DEFAULT_WIDTH, true));

  // Left widens (the panel grows toward the editor), right narrows.
  handle.addEventListener('keydown', (e) => {
    if (e.key === 'ArrowLeft') { apply(width + KEY_STEP, true); e.preventDefault(); }
    else if (e.key === 'ArrowRight') { apply(width - KEY_STEP, true); e.preventDefault(); }
    else if (e.key === 'Home') { apply(DEFAULT_WIDTH, true); e.preventDefault(); }
  });

  // A smaller window must not leave the panel wider than the room it has.
  window.addEventListener('resize', () => {
    handle.setAttribute('aria-valuemax', String(maxWidth()));
    if (width > maxWidth()) apply(width, false);
  });
}
