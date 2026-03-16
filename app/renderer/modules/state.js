// state.js — Shared state object + EventBus class

export class EventBus {
  constructor() {
    this._listeners = {};
  }

  on(event, fn) {
    if (!this._listeners[event]) this._listeners[event] = [];
    this._listeners[event].push(fn);
  }

  off(event, fn) {
    if (!this._listeners[event]) return;
    this._listeners[event] = this._listeners[event].filter(f => f !== fn);
  }

  emit(event, data) {
    if (!this._listeners[event]) return;
    for (const fn of this._listeners[event]) {
      fn(data);
    }
  }
}

export const bus = new EventBus();

export const state = {
  // Prompt state
  currentPrompt: '',
  currentNegativePrompt: '',
  currentBaseCaption: '',
  currentCharCaptions: [],
  currentStoryExcerpt: '',
  isGenerating: false,
  isGeneratingPrompt: false,
  lastKnownStoryLength: 0,

  // Story state
  currentStoryId: null,
  currentStoryTitle: null,

  // Storyboard state
  currentImageData: null,       // base64 of last generated image
  currentGenerationMeta: null,  // { provider, model, resolution }
  activeStoryboardId: null,
  activeStoryboardName: '',

  // Suggestions state
  suggestionsBadgeCount: 0,
  currentSuggestions: [],

  // Lore state
  loreState: null,
  loreSettings: null,
  loreIsScanning: false,
  categoryRegistry: null,
  loreEnrichResult: null, // {entry, updatedText, originalText, displayName}
  loreProxyReady: false,
  loreLastStoryLength: 0,
  loreIsOrganizing: false,
  loreCreateResults: [], // array of generated entries
  scanMenuOpen: false,

  // Comprehension state
  comprehensionScanning: false,
  comprehensionPaused: false,
  comprehensionAutoUpdatePending: false,

  // Memory state
  memorySettings: null,
  memoryState: null,
  memoryProxyReady: false,
  memoryIsProcessing: false,
  memoryLastStoryLength: 0,
  memorySettingsSaveTimeout: null,

  // LitRPG state
  litrpgState: null,
  litrpgEnabled: false,
  litrpgScanning: false,

  // TTS state (per-story character voice map)
  ttsState: null,

  // Per-story settings (TTS config, image settings, scene settings)
  storySettings: null,

  // Lorebook optimizer state
  loreOptProfile: 'general',
  loreOptConfirmedFields: null,  // fields confirmed writable by discovery
  loreOptLastAdjust: 0,          // timestamp of last continuous adjustment
};
