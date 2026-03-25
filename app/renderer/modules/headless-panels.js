// headless-panels.js — Panel toggle management and infrastructure

import * as refs from './dom-refs.js';

/**
 * Toggle a headless panel open/closed. Closes all other panels first.
 */
export function togglePanel(panel) {
  if (!panel) return;
  const isVisible = panel.style.display === 'flex';
  document.querySelectorAll('.headless-panel').forEach(p => p.style.display = 'none');
  if (!isVisible) panel.style.display = 'flex';
}

/**
 * Set up a toolbar button to toggle a panel, with an optional onOpen callback.
 */
export function setupPanelToggle(btn, panel, onOpen) {
  if (!btn || !panel) return;
  btn.addEventListener('click', (e) => {
    e.stopPropagation();
    const isVisible = panel.style.display === 'flex';
    document.querySelectorAll('.headless-panel').forEach(p => p.style.display = 'none');
    if (!isVisible) {
      panel.style.display = 'flex';
      if (onOpen) onOpen();
    }
  });
}

export function init() {
  // Close panel on close button
  document.querySelectorAll('.headless-panel .close-btn').forEach(btn => {
    btn.addEventListener('click', () => {
      btn.closest('.headless-panel').style.display = 'none';
    });
  });

  // Close panel on click outside
  document.addEventListener('click', (e) => {
    if (!e.target.closest('.headless-panel') &&
        !e.target.closest('.editor-toolbar-center') &&
        !e.target.closest('#editorSettingsBtn')) {
      document.querySelectorAll('.headless-panel').forEach(p => p.style.display = 'none');
    }
  });

  // Expose togglePanel globally for inline onclick handlers
  window.togglePanel = togglePanel;
  window.refs = refs;
}
