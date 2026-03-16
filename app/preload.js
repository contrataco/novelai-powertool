const { contextBridge, ipcRenderer } = require('electron');

// Expose secure API to renderer
contextBridge.exposeInMainWorld('sceneVisualizer', {
  // Image generation
  generateImage: (prompt, negativePrompt, opts = {}) =>
    ipcRenderer.invoke('generate-image', { prompt, negativePrompt, ...opts }),

  // Settings
  getApiToken: () => ipcRenderer.invoke('get-api-token'),
  setApiToken: (token) => ipcRenderer.invoke('set-api-token', token),
  getImageSettings: () => ipcRenderer.invoke('get-image-settings'),
  setImageSettings: (settings) => ipcRenderer.invoke('set-image-settings', settings),
  getModels: () => ipcRenderer.invoke('get-models'),

  // Provider management
  getProvider: () => ipcRenderer.invoke('get-provider'),
  setProvider: (providerId) => ipcRenderer.invoke('set-provider', providerId),
  getProviders: () => ipcRenderer.invoke('get-providers'),

  // NovelAI art styles
  getNovelaiArtStyles: () => ipcRenderer.invoke('get-novelai-art-styles'),
  getNovelaiArtStyle: (storyId) => ipcRenderer.invoke('get-novelai-art-style', storyId),
  setNovelaiArtStyle: (styleId) => ipcRenderer.invoke('set-novelai-art-style', styleId),

  // Perchance
  extractPerchanceKey: () => ipcRenderer.invoke('extract-perchance-key'),
  setPerchanceKey: (key) => ipcRenderer.invoke('set-perchance-key', key),
  getPerchanceKeyStatus: () => ipcRenderer.invoke('get-perchance-key-status'),
  getPerchanceArtStyles: () => ipcRenderer.invoke('get-perchance-art-styles'),
  getPerchanceSettings: () => ipcRenderer.invoke('get-perchance-settings'),
  setPerchanceSettings: (settings) => ipcRenderer.invoke('set-perchance-settings', settings),

  // Venice AI
  getVeniceSettings: () => ipcRenderer.invoke('get-venice-settings'),
  setVeniceSettings: (settings) => ipcRenderer.invoke('set-venice-settings', settings),
  setVeniceApiKey: (key) => ipcRenderer.invoke('set-venice-api-key', key),
  getVeniceApiKeyStatus: () => ipcRenderer.invoke('get-venice-api-key-status'),
  getVeniceModels: () => ipcRenderer.invoke('get-venice-models'),
  getVeniceStyles: () => ipcRenderer.invoke('get-venice-styles'),
  veniceGetBalance: () => ipcRenderer.invoke('venice:get-balance'),
  onVeniceBalanceUpdate: (callback) => {
    ipcRenderer.on('venice:balance-update', (_, data) => callback(data));
  },
  veniceGetVideoModels: () => ipcRenderer.invoke('venice:get-video-models'),
  veniceQuoteVideo: (prompt, opts) => ipcRenderer.invoke('venice:quote-video', { prompt, opts }),
  veniceQueueVideo: (prompt, imageData, opts) => ipcRenderer.invoke('venice:queue-video', { prompt, imageData, opts }),
  veniceRetrieveVideo: (queueId, model) => ipcRenderer.invoke('venice:retrieve-video', { queueId, model }),

  // Puter.js
  getPuterSettings: () => ipcRenderer.invoke('get-puter-settings'),
  setPuterSettings: (settings) => ipcRenderer.invoke('set-puter-settings', settings),
  getPuterModels: () => ipcRenderer.invoke('get-puter-models'),

  // Token status
  getTokenStatus: () => ipcRenderer.invoke('get-token-status'),

  // Cache management
  clearWebviewCache: () => ipcRenderer.invoke('clear-webview-cache'),

  // DevTools
  openWebviewDevtools: () => ipcRenderer.invoke('open-webview-devtools'),

  // NovelAI credentials
  getNovelaiCredentials: () => ipcRenderer.invoke('get-novelai-credentials'),
  setNovelaiCredentials: (creds) => ipcRenderer.invoke('set-novelai-credentials', creds),

  // Storyboard
  storyboardList: () => ipcRenderer.invoke('storyboard:list'),
  storyboardCreate: (name) => ipcRenderer.invoke('storyboard:create', name),
  storyboardDelete: (id) => ipcRenderer.invoke('storyboard:delete', id),
  storyboardRename: (id, name) => ipcRenderer.invoke('storyboard:rename', { id, name }),
  storyboardSetActive: (id) => ipcRenderer.invoke('storyboard:set-active', id),
  storyboardGetScenes: (id) => ipcRenderer.invoke('storyboard:get-scenes', id),
  storyboardCommitScene: (storyboardId, sceneData) => ipcRenderer.invoke('storyboard:commit-scene', { storyboardId, sceneData }),
  storyboardDeleteScene: (storyboardId, sceneId) => ipcRenderer.invoke('storyboard:delete-scene', { storyboardId, sceneId }),
  storyboardReorderScenes: (storyboardId, sceneIds) => ipcRenderer.invoke('storyboard:reorder-scenes', { storyboardId, sceneIds }),
  storyboardUpdateSceneNote: (storyboardId, sceneId, note) => ipcRenderer.invoke('storyboard:update-scene-note', { storyboardId, sceneId, note }),
  storyboardGetSceneImage: (storyboardId, sceneId) => ipcRenderer.invoke('storyboard:get-scene-image', { storyboardId, sceneId }),
  storyboardGetOrCreateForStory: (storyId, storyTitle) => ipcRenderer.invoke('storyboard:get-or-create-for-story', { storyId, storyTitle }),
  storyboardAssociateWithStory: (storyboardId, storyId, storyTitle) => ipcRenderer.invoke('storyboard:associate-with-story', { storyboardId, storyId, storyTitle }),
  storyboardDissociateFromStory: (storyboardId) => ipcRenderer.invoke('storyboard:dissociate-from-story', { storyboardId }),

  // Event listeners
  onTokenStatusChanged: (callback) => {
    ipcRenderer.on('token-status-changed', (event, data) => callback(data));
  },
  onImageReady: (callback) => {
    ipcRenderer.on('image-ready', (event, data) => callback(data));
  },
  // Scene settings
  getSceneSettings: () => ipcRenderer.invoke('get-scene-settings'),
  setSceneSettings: (settings) => ipcRenderer.invoke('set-scene-settings', settings),

  // Prompt suffix (art style + quality tags the provider appends)
  getPromptSuffix: () => ipcRenderer.invoke('get-prompt-suffix'),
  // Negative prompt suffix (art style negative + UC preset the provider appends)
  getNegativePromptSuffix: () => ipcRenderer.invoke('get-negative-prompt-suffix'),

  // Electron-side suggestion generation (parallel with script's image prompt)
  generateSuggestionsDirect: (data) => ipcRenderer.invoke('generate-suggestions-direct', data),

  // Electron-side scene prompt generation (replaces script sandbox)
  generateScenePrompt: (data) => ipcRenderer.invoke('generate-scene-prompt', data),

  // Per-story bulk load (SQLite)
  storyLoadAll: (storyId, storyTitle) =>
    ipcRenderer.invoke('story:load-all', { storyId, storyTitle }),

  // Per-story settings
  storySettingsGet: (storyId) => ipcRenderer.invoke('story-settings:get', storyId),
  storySettingsSet: (storyId, settings) => ipcRenderer.invoke('story-settings:set', { storyId, settings }),

  // Per-story scene state persistence
  sceneGetState: (storyId) => ipcRenderer.invoke('scene:get-state', storyId),
  sceneSetState: (storyId, state) => ipcRenderer.invoke('scene:set-state', { storyId, state }),

  // Lore Creator
  loreScan: (storyText, existingEntries, storyId, scanOptions) =>
    ipcRenderer.invoke('lore:scan', { storyText, existingEntries, storyId, scanOptions }),
  loreIdentifyTarget: (prompt, entries) =>
    ipcRenderer.invoke('lore:identify-target', { prompt, entries }),
  loreGenerateEnriched: (prompt, currentText, displayName) =>
    ipcRenderer.invoke('lore:generate-enriched', { prompt, currentText, displayName }),
  loreCreateFromPrompt: (prompt, category, storyText, storyId) =>
    ipcRenderer.invoke('lore:create-from-prompt', { prompt, category, storyText, storyId }),
  loreReformatEntry: (displayName, currentText, storyText, storyId, entryType) =>
    ipcRenderer.invoke('lore:reformat-entry', { displayName, currentText, storyText, storyId, entryType }),
  loreParseMetadata: (text) =>
    ipcRenderer.invoke('lore:parse-metadata', { text }),
  loreSetMetadata: (text, opts) =>
    ipcRenderer.invoke('lore:set-metadata', { text, opts }),
  loreGetEntryType: (text, displayName) =>
    ipcRenderer.invoke('lore:get-entry-type', { text, displayName }),
  loreGetSettings: () => ipcRenderer.invoke('lore:get-settings'),
  loreSetSettings: (settings) => ipcRenderer.invoke('lore:set-settings', settings),
  loreGetState: (storyId) => ipcRenderer.invoke('lore:get-state', storyId),
  loreSetState: (storyId, state) => ipcRenderer.invoke('lore:set-state', { storyId, state }),
  loreGetLlmProvider: () => ipcRenderer.invoke('lore:get-llm-provider'),
  loreSetLlmProvider: (config) => ipcRenderer.invoke('lore:set-llm-provider', config),
  loreCheckOllama: () => ipcRenderer.invoke('lore:check-ollama'),
  loreGetCategoryRegistry: (storyId) => ipcRenderer.invoke('lore:get-category-registry', storyId),
  loreAddCustomCategory: (storyId, category) => ipcRenderer.invoke('lore:add-custom-category', { storyId, category }),
  loreRemoveCustomCategory: (storyId, categoryId) => ipcRenderer.invoke('lore:remove-custom-category', { storyId, categoryId }),
  onLoreScanProgress: (callback) => {
    ipcRenderer.on('lore:scan-progress', (event, data) => callback(data));
  },
  loreOrganize: (entries, storyText, storyId, categoryMap) =>
    ipcRenderer.invoke('lore:organize', { entries, storyText, storyId, categoryMap }),
  onLoreOrganizeProgress: (callback) => {
    ipcRenderer.on('lore:organize-progress', (event, data) => callback(data));
  },

  // Lorebook Optimizer
  loreGetProfiles: () => ipcRenderer.invoke('lore:get-profiles'),
  loreGetProfile: (profileId) => ipcRenderer.invoke('lore:get-profile', profileId),
  loreOptimizeEntries: (entries, profileId, storyId, confirmedFields) =>
    ipcRenderer.invoke('lore:optimize-entries', { entries, profileId, storyId, confirmedFields }),
  loreAdjustEntries: (entries, profileId, storyId) =>
    ipcRenderer.invoke('lore:adjust-entries', { entries, profileId, storyId }),
  loreParseDiscovery: (inspectResult, writeTestResult) =>
    ipcRenderer.invoke('lore:parse-discovery', { inspectResult, writeTestResult }),

  // Lore Comprehension (progressive scan)
  loreStartProgressiveScan: (storyId, storyText, existingEntries) =>
    ipcRenderer.invoke('lore:start-progressive-scan', { storyId, storyText, existingEntries }),
  lorePauseProgressiveScan: (storyId) =>
    ipcRenderer.invoke('lore:pause-progressive-scan', { storyId }),
  loreResumeProgressiveScan: (storyId) =>
    ipcRenderer.invoke('lore:resume-progressive-scan', { storyId }),
  loreCancelProgressiveScan: (storyId) =>
    ipcRenderer.invoke('lore:cancel-progressive-scan', { storyId }),
  loreGetComprehension: (storyId) =>
    ipcRenderer.invoke('lore:get-comprehension', storyId),
  loreIncrementalUpdate: (storyId, storyText, existingEntries) =>
    ipcRenderer.invoke('lore:incremental-update', { storyId, storyText, existingEntries }),
  onProgressiveScanProgress: (callback) => {
    ipcRenderer.on('lore:progressive-scan-progress', (event, data) => callback(data));
  },
  onProgressiveScanComplete: (callback) => {
    ipcRenderer.on('lore:progressive-scan-complete', (event, data) => callback(data));
  },

  // Memory Manager
  memoryProcess: (storyText, storyId) =>
    ipcRenderer.invoke('memory:process', { storyText, storyId }),
  memoryForceRefresh: (storyText, storyId) =>
    ipcRenderer.invoke('memory:force-refresh', { storyText, storyId }),
  memoryClear: (storyId) =>
    ipcRenderer.invoke('memory:clear', { storyId }),
  memoryGetState: (storyId) =>
    ipcRenderer.invoke('memory:get-state', storyId),
  memorySetState: (storyId, state) =>
    ipcRenderer.invoke('memory:set-state', { storyId, state }),
  memoryGetSettings: () =>
    ipcRenderer.invoke('memory:get-settings'),
  memorySetSettings: (settings) =>
    ipcRenderer.invoke('memory:set-settings', settings),
  onMemoryProgress: (callback) => {
    ipcRenderer.on('memory:progress', (event, data) => callback(data));
  },

  // LitRPG Tracker
  litrpgDetect: (storyText, storyId) =>
    ipcRenderer.invoke('litrpg:detect', { storyText, storyId }),
  litrpgScan: (storyText, storyId, loreEntries, options) =>
    ipcRenderer.invoke('litrpg:scan', { storyText, storyId, loreEntries, ...options }),
  litrpgGetState: (storyId) =>
    ipcRenderer.invoke('litrpg:get-state', storyId),
  litrpgSetState: (storyId, state) =>
    ipcRenderer.invoke('litrpg:set-state', { storyId, state }),
  litrpgAcceptUpdate: (storyId, updateId) =>
    ipcRenderer.invoke('litrpg:accept-update', { storyId, updateId }),
  litrpgRejectUpdate: (storyId, updateId) =>
    ipcRenderer.invoke('litrpg:reject-update', { storyId, updateId }),
  litrpgBuildLorebookText: (entryText, rpgData) =>
    ipcRenderer.invoke('litrpg:build-lorebook-text', { entryText, rpgData }),
  litrpgBuildRoleUpdate: (entryText, role) =>
    ipcRenderer.invoke('litrpg:build-role-update', { entryText, role }),
  litrpgGeneratePortraitPrompt: (characterEntryText, rpgData) =>
    ipcRenderer.invoke('litrpg:generate-portrait-prompt', { characterEntryText, rpgData }),
  litrpgAcceptAllUpdates: (storyId) =>
    ipcRenderer.invoke('litrpg:accept-all-updates', { storyId }),
  litrpgRejectAllUpdates: (storyId) =>
    ipcRenderer.invoke('litrpg:reject-all-updates', { storyId }),
  litrpgUpdateCharacter: (storyId, characterId, updates) =>
    ipcRenderer.invoke('litrpg:update-character', { storyId, characterId, updates }),
  litrpgDeleteCharacter: (storyId, characterId) =>
    ipcRenderer.invoke('litrpg:delete-character', { storyId, characterId }),
  litrpgResetState: (storyId) =>
    ipcRenderer.invoke('litrpg:reset-state', { storyId }),
  litrpgReverseSync: (entryText, entryName, storyId) =>
    ipcRenderer.invoke('litrpg:reverse-sync', { entryText, entryName, storyId }),
  litrpgReverseSyncAll: (entries, storyId) =>
    ipcRenderer.invoke('litrpg:reverse-sync-all', { entries, storyId }),
  onLitrpgScanProgress: (callback) => {
    ipcRenderer.on('litrpg:scan-progress', (event, data) => callback(data));
  },
  onLitrpgStateUpdated: (callback) => {
    ipcRenderer.on('litrpg:state-updated', (event, data) => callback(data));
  },
  onLitrpgDetected: (callback) => {
    ipcRenderer.on('litrpg:detected', (event, data) => callback(data));
  },

  // TTS
  ttsGetSettings: () => ipcRenderer.invoke('tts:get-settings'),
  ttsSetSettings: (settings) => ipcRenderer.invoke('tts:set-settings', settings),
  ttsGetVoices: () => ipcRenderer.invoke('tts:get-voices'),
  ttsGenerateSpeech: (text, voice) => ipcRenderer.invoke('tts:generate-speech', { text, voice }),
  ttsNarrateScene: (text, storyId, protagonistName) => ipcRenderer.invoke('tts:narrate-scene', { text, storyId, protagonistName }),
  ttsGetState: (storyId) => ipcRenderer.invoke('tts:get-state', storyId),
  ttsSetState: (storyId, state) => ipcRenderer.invoke('tts:set-state', { storyId, state }),
  ttsSetCharacterVoice: (storyId, characterName, voiceId) =>
    ipcRenderer.invoke('tts:set-character-voice', { storyId, characterName, voiceId }),
  ttsRemoveCharacterVoice: (storyId, characterName) =>
    ipcRenderer.invoke('tts:remove-character-voice', { storyId, characterName }),

  // Media Gallery
  mediaSaveImage: (storyId, imageDataUrl, metadata) =>
    ipcRenderer.invoke('media:save-image', { storyId, imageDataUrl, metadata }),
  mediaSaveVideo: (storyId, videoDataUrl, metadata) =>
    ipcRenderer.invoke('media:save-video', { storyId, videoDataUrl, metadata }),
  mediaList: (storyId, opts) =>
    ipcRenderer.invoke('media:list', { storyId, opts }),
  mediaGetFull: (storyId, mediaId) =>
    ipcRenderer.invoke('media:get-full', { storyId, mediaId }),
  mediaGetThumbnail: (storyId, mediaId) =>
    ipcRenderer.invoke('media:get-thumbnail', { storyId, mediaId }),
  mediaGetVideo: (storyId, mediaId) =>
    ipcRenderer.invoke('media:get-video', { storyId, mediaId }),
  mediaDelete: (storyId, mediaId) =>
    ipcRenderer.invoke('media:delete', { storyId, mediaId }),
  mediaGetCount: (storyId) =>
    ipcRenderer.invoke('media:get-count', { storyId }),

  // Text LLM Providers
  textLlmGetSettings: () => ipcRenderer.invoke('text-llm:get-settings'),
  textLlmSetSettings: (settings) => ipcRenderer.invoke('text-llm:set-settings', settings),
  textLlmListProviders: () => ipcRenderer.invoke('text-llm:list-providers'),
  textLlmListOllamaModels: () => ipcRenderer.invoke('text-llm:list-ollama-models'),

  // Visual Profiles
  visualProfilesGet: (storyId) => ipcRenderer.invoke('visual-profiles:get', storyId),
  visualProfilesReset: (storyId) => ipcRenderer.invoke('visual-profiles:reset', storyId),

  // Portrait Manager
  portraitGenerate: (storyId, characterId, characterEntry, rpgData) =>
    ipcRenderer.invoke('portrait:generate', { storyId, characterId, characterEntry, rpgData }),
  portraitUpload: (storyId, characterId) =>
    ipcRenderer.invoke('portrait:upload', { storyId, characterId }),
  portraitGet: (storyId, characterId, thumbnail) =>
    ipcRenderer.invoke('portrait:get', { storyId, characterId, thumbnail }),
  portraitDelete: (storyId, characterId) =>
    ipcRenderer.invoke('portrait:delete', { storyId, characterId }),

  // Portrait Album
  portraitAlbumList: (storyId, characterId) =>
    ipcRenderer.invoke('portrait:album-list', { storyId, characterId }),
  portraitAlbumGet: (storyId, characterId, imageId) =>
    ipcRenderer.invoke('portrait:album-get', { storyId, characterId, imageId }),
  portraitAlbumDelete: (storyId, characterId, imageId) =>
    ipcRenderer.invoke('portrait:album-delete', { storyId, characterId, imageId }),
  portraitAlbumSetActive: (storyId, characterId, imageId) =>
    ipcRenderer.invoke('portrait:album-set-active', { storyId, characterId, imageId }),
});
