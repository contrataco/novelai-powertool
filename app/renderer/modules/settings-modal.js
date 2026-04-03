// settings-modal.js — Settings modal orchestrator (open/close/save)

import {
  settingsModal, status, webview,
  providerSelect,
  sceneEnableLitrpg, interfaceShowWebview,
  settingsBtn, toggleWebviewBtn, cancelBtn, saveBtn, reloadBtn,
  storySelectionOverlay,
} from './dom-refs.js';
import { state, bus } from './state.js';
import { refreshRpgUI } from './litrpg-panel.js';

import { loadProviderSettings, saveProviderSettings, initProviderEvents } from './settings-providers.js';
import { loadTtsSettings, saveTtsSettings, buildPerStoryTtsSettings, initTtsEvents } from './settings-tts.js';
import { loadImageSettings, saveImageSettings, buildPerStoryImageSettings, initImageEvents } from './settings-image.js';

export function init() {
  // Initialize sub-module event listeners
  initProviderEvents();
  initTtsEvents();
  initImageEvents();

  // Settings open
  settingsBtn.addEventListener('click', async () => {
    // Load per-story settings if a story is active (overrides globals for TTS/image/scene)
    const storySettings = state.currentStoryId
      ? await window.powertool.storySettingsGet(state.currentStoryId)
      : null;

    const [settings, currentProvider, novelaiArtStyle, sceneSettingsData] = await Promise.all([
      window.powertool.getImageSettings(),
      window.powertool.getProvider(),
      window.powertool.getNovelaiArtStyle(),
      window.powertool.getSceneSettings(),
    ]);

    // Use per-story overrides when available
    const effectiveSettings = storySettings?.imageSettings || settings;
    const effectiveProvider = storySettings?.imageProvider || currentProvider;
    const effectiveArtStyle = storySettings?.novelaiArtStyle || novelaiArtStyle;
    const effectiveSceneSettings = storySettings?.sceneSettings
      ? { ...sceneSettingsData, ...storySettings.sceneSettings }
      : sceneSettingsData;

    // Load all sub-module settings (provider-specific loads are async)
    await loadProviderSettings(effectiveProvider);
    await loadTtsSettings(storySettings);
    await loadImageSettings(effectiveSettings, effectiveArtStyle, effectiveSceneSettings);

    settingsModal.classList.add('active');
  });

  cancelBtn.addEventListener('click', () => {
    settingsModal.classList.remove('active');
  });

  saveBtn.addEventListener('click', async () => {
    // Save all sub-module settings
    await saveTtsSettings();
    await saveImageSettings();
    await saveProviderSettings();

    // LitRPG toggle
    if (state.currentStoryId) {
      const wantEnabled = sceneEnableLitrpg.checked;
      const wasEnabled = !!(state.litrpgState && state.litrpgState.enabled);
      if (wantEnabled !== wasEnabled) {
        if (!state.litrpgState) state.litrpgState = {};
        state.litrpgState.enabled = wantEnabled;
        if (wantEnabled) {
          state.litrpgState.detected = true;
          state.litrpgState.dismissedDetection = false;
        }
        state.litrpgEnabled = wantEnabled;
        await window.powertool.litrpgSetState(state.currentStoryId, state.litrpgState);
        refreshRpgUI();
      }
    }

    // Save per-story settings (TTS config, image, scene) when a story is active
    if (state.currentStoryId) {
      const perStory = {
        // Preserve fields set by other modules (lorebook optimizer, etc.)
        ...(state.storySettings || {}),
        ...buildPerStoryTtsSettings(),
        ...buildPerStoryImageSettings(),
      };
      await window.powertool.storySettingsSet(state.currentStoryId, perStory);
      state.storySettings = perStory;
    }

    settingsModal.classList.remove('active');
    status.textContent = 'Settings saved';
    status.className = 'status connected';
    
    // Update headless mode if it changed via checkbox
    state.headlessMode = !interfaceShowWebview.checked;
    updateWebviewModeUI();

    bus.emit('settings:saved');
    setTimeout(() => {
      status.textContent = 'Connected';
      status.className = 'status connected';
    }, 2000);
  });

  reloadBtn.addEventListener('click', () => {
    webview.reload();
  });

  document.getElementById('hardReloadBtn').addEventListener('click', async () => {
    status.textContent = 'Clearing cache...';
    status.className = 'status generating';
    try {
      await window.powertool.clearWebviewCache();
      webview.reloadIgnoringCache();
      status.textContent = 'Cache cleared, reloading...';
      status.className = 'status connected';
    } catch (e) {
      console.error('[Renderer] Hard reload error:', e);
      webview.reloadIgnoringCache();
    }
  });

  // Close modal on escape (also storyboard modal)
  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape') {
      settingsModal.classList.remove('active');
      document.getElementById('storyboardModal').classList.remove('active');
    }
  });

  // Listen for token status changes
  window.powertool.onTokenStatusChanged((data) => {
    console.log('[Renderer] Token status changed:', data);
    status.textContent = 'Token captured';
    status.className = 'status connected';
    setTimeout(() => {
      if (status.textContent === 'Token captured') {
        status.textContent = 'Connected';
      }
    }, 3000);
  });

  // Toggle panel
  document.getElementById('togglePanelBtn').addEventListener('click', () => {
    document.getElementById('imagePanel').classList.toggle('hidden');
  });

  document.getElementById('closePanelBtn').addEventListener('click', () => {
    document.getElementById('imagePanel').classList.add('hidden');
  });

  // Toggle Webview Mode
  toggleWebviewBtn.addEventListener('click', async () => {
    state.headlessMode = !state.headlessMode;
    updateWebviewModeUI();
    
    // Save to electron-store (persistent)
    const sceneSettings = await window.powertool.getSceneSettings();
    sceneSettings.headlessMode = state.headlessMode;
    // Keep legacy showWebview in sync for settings modal checkbox
    sceneSettings.showWebview = !state.headlessMode;
    await window.powertool.setSceneSettings(sceneSettings);
  });

  // Initial UI state
  window.powertool.getSceneSettings().then(settings => {
    if (settings) {
      // Prioritize headlessMode key, fallback to legacy showWebview
      if (settings.headlessMode !== undefined) {
        state.headlessMode = settings.headlessMode;
      } else if (settings.showWebview !== undefined) {
        state.headlessMode = !settings.showWebview;
      }
    }
    updateWebviewModeUI();
  });
}

export function updateWebviewModeUI() {
  const mainContainer = document.querySelector('.main-container');
  if (state.headlessMode) {
    mainContainer.classList.remove('webview-active');
    toggleWebviewBtn.textContent = 'Show Webview';
    // Restore story selector if no story is loaded
    if (!state.currentStoryId && storySelectionOverlay) {
      storySelectionOverlay.classList.add('visible');
    }
  } else {
    mainContainer.classList.add('webview-active');
    toggleWebviewBtn.textContent = 'Hide Webview';
    // Hide overlay so webview is visible
    if (storySelectionOverlay) {
      storySelectionOverlay.classList.remove('visible');
    }
  }
}
