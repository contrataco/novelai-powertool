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
  // Prompt state (consolidated)
  prompt: {
    display: '',          // what user sees in textarea (with art style suffix)
    raw: '',              // original from pipeline (before suffix)
    negative: '',         // negative prompt
    baseCaption: '',      // V4 base caption for structured prompts
    charCaptions: [],     // V4 per-character captions
    edited: false,        // user modified display prompt
    negativeEdited: false,// user modified negative prompt
    source: 'pipeline',   // 'pipeline' | 'manual' | 'storyboard'
  },
  currentStoryExcerpt: '',
  isGenerating: false,
  isGeneratingPrompt: false,
  lastKnownStoryLength: 0,

  // Backward-compat accessors — use state.prompt.* directly in new code
  get currentPrompt() { return this.prompt.display; },
  set currentPrompt(v) { this.prompt.display = v; },
  get currentRawPrompt() { return this.prompt.raw; },
  set currentRawPrompt(v) { this.prompt.raw = v; },
  get currentNegativePrompt() { return this.prompt.negative; },
  set currentNegativePrompt(v) { this.prompt.negative = v; },
  get currentBaseCaption() { return this.prompt.baseCaption; },
  set currentBaseCaption(v) { this.prompt.baseCaption = v; },
  get currentCharCaptions() { return this.prompt.charCaptions; },
  set currentCharCaptions(v) { this.prompt.charCaptions = v; },

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

  // Scene Timeline state
  timelineState: null,
  llmBusy: false,
};
