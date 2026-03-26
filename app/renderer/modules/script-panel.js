// script-panel.js — Scripts tab: manage NovelAI user scripts

import { state, bus } from './state.js';
import * as refs from './dom-refs.js';
import { showToast } from './utils.js';

const POWERTOOL_SCRIPT_NAME = 'NovelAI PowerTool';
let cachedScripts = [];
let bundledInfo = null;

async function loadBundledInfo() {
  if (!bundledInfo) {
    try {
      bundledInfo = await window.powertool.scriptMgrGetBundled();
    } catch (e) {
      bundledInfo = { version: null, content: null };
    }
  }
  return bundledInfo;
}

function parseVersion(vStr) {
  if (!vStr) return null;
  const m = vStr.match(/v?(\d+)\.(\d+)\.(\d+)/);
  return m ? { major: +m[1], minor: +m[2], patch: +m[3], raw: vStr } : null;
}

function isNewer(bundled, installed) {
  if (!bundled || !installed) return false;
  if (bundled.major !== installed.major) return bundled.major > installed.major;
  if (bundled.minor !== installed.minor) return bundled.minor > installed.minor;
  return bundled.patch > installed.patch;
}

function renderScriptCard(script, bundledVersion) {
  const card = document.createElement('div');
  card.className = 'script-card' + (script.name === POWERTOOL_SCRIPT_NAME ? ' powertool' : '');

  const installedV = parseVersion(script.version);
  const bundledV = parseVersion(bundledVersion);
  const updateAvailable = script.name === POWERTOOL_SCRIPT_NAME && isNewer(bundledV, installedV);

  card.innerHTML = `
    <div class="script-card-header">
      <span class="script-card-name">${script.name}${updateAvailable ? `<span class="script-update-badge">Update</span>` : ''}</span>
      <span class="script-card-version">${script.version}${script.author ? ' \u2022 ' + script.author : ''}</span>
    </div>
    <div class="script-card-status">
      <span class="script-card-dot ${script.enabled ? 'active' : 'inactive'}"></span>
      <span style="font-size:11px;color:var(--text-dim);">${script.enabled ? 'Enabled' : 'Disabled'}</span>
      ${script.section === 'account' ? '<span style="font-size:10px;color:var(--text-faint);margin-left:auto;">Account</span>' : '<span style="font-size:10px;color:var(--text-faint);margin-left:auto;">Story</span>'}
    </div>
    <div class="script-card-actions"></div>
  `;

  const actions = card.querySelector('.script-card-actions');

  // Toggle button
  const toggleBtn = document.createElement('button');
  toggleBtn.className = 'btn-sm ' + (script.enabled ? 'tertiary' : 'primary');
  toggleBtn.textContent = script.enabled ? 'Disable' : 'Enable';
  toggleBtn.addEventListener('click', async () => {
    toggleBtn.disabled = true;
    toggleBtn.textContent = 'Working...';
    try {
      if (script.enabled) {
        await window.powertool.scriptMgrDisableScript(script.name);
      } else {
        await window.powertool.scriptMgrEnableScript(script.name);
      }
      showToast(`${script.name} ${script.enabled ? 'disabled' : 'enabled'}`);
      // Close the script manager dialog in the webview
      await window.powertool.scriptMgrClose();
      // Refresh after a brief delay
      setTimeout(refreshScripts, 1000);
    } catch (e) {
      showToast('Failed: ' + e.message);
      toggleBtn.disabled = false;
      toggleBtn.textContent = script.enabled ? 'Disable' : 'Enable';
    }
  });
  actions.appendChild(toggleBtn);

  // Update button (PowerTool only)
  if (updateAvailable) {
    const updateBtn = document.createElement('button');
    updateBtn.className = 'btn-sm primary';
    updateBtn.textContent = `Update to ${bundledVersion}`;
    updateBtn.addEventListener('click', async () => {
      updateBtn.disabled = true;
      updateBtn.textContent = 'Updating...';
      try {
        const bundled = await loadBundledInfo();
        if (!bundled.content) { showToast('Bundled script not found'); return; }
        // Disable old, import new
        // For now, user should re-import manually — full automation needs more testing
        showToast('Copy the updated script to clipboard and import via NovelAI Script Manager');
        // Copy to clipboard
        await navigator.clipboard.writeText(bundled.content);
        showToast('Script copied to clipboard! Paste in NovelAI Script Manager.');
      } catch (e) {
        showToast('Update failed: ' + e.message);
      } finally {
        updateBtn.disabled = false;
        updateBtn.textContent = `Update to ${bundledVersion}`;
      }
    });
    actions.appendChild(updateBtn);
  }

  return card;
}

async function refreshScripts() {
  if (!refs.scriptsList) return;

  refs.scriptsLoading.classList.remove('u-hidden');
  refs.scriptsList.classList.add('u-hidden');
  refs.scriptsEmpty.classList.add('u-hidden');

  try {
    const result = await window.powertool.scriptMgrListScripts();
    cachedScripts = result.scripts || [];
    const bundled = await loadBundledInfo();

    refs.scriptsLoading.classList.add('u-hidden');

    if (cachedScripts.length === 0) {
      refs.scriptsEmpty.classList.remove('u-hidden');
      return;
    }

    refs.scriptsList.classList.remove('u-hidden');
    refs.scriptsList.innerHTML = '';

    // Sort: PowerTool first, then alphabetical
    cachedScripts.sort((a, b) => {
      if (a.name === POWERTOOL_SCRIPT_NAME) return -1;
      if (b.name === POWERTOOL_SCRIPT_NAME) return 1;
      return a.name.localeCompare(b.name);
    });

    for (const script of cachedScripts) {
      refs.scriptsList.appendChild(renderScriptCard(script, bundled?.version));
    }

    // Close the script manager dialog to clean up
    await window.powertool.scriptMgrClose();
  } catch (e) {
    console.error('[ScriptPanel] Error refreshing:', e);
    refs.scriptsLoading.classList.add('u-hidden');
    refs.scriptsEmpty.classList.remove('u-hidden');
    refs.scriptsEmpty.querySelector('p').textContent = 'Error loading scripts: ' + e.message;
  }
}

export function init() {
  if (!refs.scriptsRefreshBtn) return;

  refs.scriptsRefreshBtn.addEventListener('click', refreshScripts);

  // Auto-refresh when tab is activated
  bus.on('panel:scripts-activated', refreshScripts);
}

export { refreshScripts };
