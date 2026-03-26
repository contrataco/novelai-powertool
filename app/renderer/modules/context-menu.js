// context-menu.js — Custom native context menu for the story editor

import * as refs from './dom-refs.js';

let contextMenu = null;

/**
 * Initialize the custom context menu for the story editor.
 * @param {Object} actions - Object containing callback functions for menu items.
 */
export function init(actions = {}) {
  if (contextMenu) return;

  // Create context menu element
  contextMenu = document.createElement('div');
  contextMenu.id = 'editorContextMenu';
  contextMenu.className = 'editor-context-menu';
  contextMenu.classList.add('u-hidden');
  document.body.appendChild(contextMenu);

  const menuItems = [
    { label: 'Generate', action: 'generate', icon: '✨', shortcut: 'Ctrl+Enter' },
    { type: 'divider' },
    { label: 'Cut', action: 'cut', icon: '✂️', shortcut: 'Ctrl+X' },
    { label: 'Copy', action: 'copy', icon: '📋', shortcut: 'Ctrl+C' },
    { label: 'Paste', action: 'paste', icon: '📥', shortcut: 'Ctrl+V' },
    { type: 'divider' },
    { label: 'Rewrite', action: 'rewrite', icon: '🔄', subtext: 'AI Rewrite Selection' },
    { label: 'Expand', action: 'expand', icon: '➕', subtext: 'AI Expand Selection' },
    { label: 'Summarize', action: 'summarize', icon: '📝', subtext: 'AI Summarize Selection' },
    { type: 'divider' },
    { label: 'Undo', action: 'undo', icon: '↩️', shortcut: 'Ctrl+Z' },
    { label: 'Redo', action: 'redo', icon: '↪️', shortcut: 'Ctrl+Shift+Z' },
    { type: 'divider' },
    { label: 'Select All', action: 'selectAll', icon: '✅', shortcut: 'Ctrl+A' }
  ];

  // Render menu items
  menuItems.forEach(item => {
    if (item.type === 'divider') {
      const divider = document.createElement('div');
      divider.className = 'menu-divider';
      contextMenu.appendChild(divider);
      return;
    }

    const menuItem = document.createElement('div');
    menuItem.className = 'menu-item';
    
    const left = document.createElement('div');
    left.className = 'menu-item-left';
    left.innerHTML = `<span class="menu-icon">${item.icon}</span><span class="menu-label">${item.label}</span>`;
    menuItem.appendChild(left);

    if (item.shortcut || item.subtext) {
      const right = document.createElement('div');
      right.className = 'menu-item-right';
      right.textContent = item.shortcut || item.subtext;
      menuItem.appendChild(right);
    }

    menuItem.addEventListener('click', (e) => {
      e.stopPropagation();
      hide();
      if (actions[item.action]) {
        actions[item.action]();
      } else {
        // Default handlers for standard text actions
        handleDefaultAction(item.action);
      }
    });

    contextMenu.appendChild(menuItem);
  });

  // Global listeners
  window.addEventListener('click', () => hide());
  window.addEventListener('scroll', () => hide(), true);
  window.addEventListener('resize', () => hide());

  // Attach to story editor
  const storyEditor = refs.storyEditor;
  if (storyEditor) {
    storyEditor.addEventListener('contextmenu', (e) => {
      e.preventDefault();
      show(e.pageX, e.pageY);
    });
  }
}

function handleDefaultAction(action) {
  switch (action) {
    case 'cut':
      document.execCommand('cut');
      break;
    case 'copy':
      document.execCommand('copy');
      break;
    case 'paste':
      // Paste is tricky in browsers/Electron due to security, but we can try execCommand
      document.execCommand('paste');
      break;
    case 'selectAll':
      document.execCommand('selectAll');
      break;
  }
}

export function show(x, y) {
  if (!contextMenu) return;
  
  contextMenu.classList.remove('u-hidden');
  
  // Constrain to window bounds
  const menuWidth = contextMenu.offsetWidth || 180;
  const menuHeight = contextMenu.offsetHeight || 300;
  const winWidth = window.innerWidth;
  const winHeight = window.innerHeight;

  if (x + menuWidth > winWidth) x -= menuWidth;
  if (y + menuHeight > winHeight) y -= menuHeight;

  contextMenu.style.left = `${x}px`;
  contextMenu.style.top = `${y}px`;
  
  contextMenu.classList.add('visible');
}

export function hide() {
  if (!contextMenu) return;
  contextMenu.classList.add('u-hidden');
  contextMenu.classList.remove('visible');
}
