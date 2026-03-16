// dom-refs.js — All document.getElementById() calls and constants

// Main elements
export const webview = document.getElementById('novelai');
export const status = document.getElementById('status');
export const settingsModal = document.getElementById('settingsModal');
export const imagePanel = document.getElementById('imagePanel');
export const imageContainer = document.getElementById('imageContainer');
export const loadingIndicator = document.getElementById('loadingIndicator');
export const promptDisplay = document.getElementById('promptDisplay');
export const negativePromptDisplay = document.getElementById('negativePromptDisplay');

// Buttons
export const generateBtn = document.getElementById('generateBtn');
export const sidebarGenerateBtn = document.getElementById('sidebarGenerateBtn');
export const togglePanelBtn = document.getElementById('togglePanelBtn');
export const settingsBtn = document.getElementById('settingsBtn');
export const reloadBtn = document.getElementById('reloadBtn');
export const closePanelBtn = document.getElementById('closePanelBtn');
export const cancelBtn = document.getElementById('cancelBtn');
export const saveBtn = document.getElementById('saveBtn');

// Settings elements -- Provider
export const providerSelect = document.getElementById('provider');

// Settings elements -- NovelAI
export const modelSelect = document.getElementById('model');
export const resolutionPreset = document.getElementById('resolutionPreset');
export const imgWidth = document.getElementById('imgWidth');
export const imgHeight = document.getElementById('imgHeight');
export const samplerSelect = document.getElementById('sampler');
export const noiseScheduleSelect = document.getElementById('noiseSchedule');
export const stepsInput = document.getElementById('steps');
export const scaleInput = document.getElementById('scale');
export const cfgRescaleSlider = document.getElementById('cfgRescale');
export const cfgRescaleValue = document.getElementById('cfgRescaleValue');
export const smeaCheckbox = document.getElementById('smea');
export const smeaDynCheckbox = document.getElementById('smeaDyn');
export const ucPresetSelect = document.getElementById('ucPreset');
export const qualityTagsCheckbox = document.getElementById('qualityTags');
export const v3Options = document.getElementById('v3Options');

// Settings elements -- NovelAI art style
export const novelaiArtStyleSelect = document.getElementById('novelaiArtStyle');

// Settings elements -- Perchance
export const extractKeyBtn = document.getElementById('extractKeyBtn');
export const perchanceKeyDot = document.getElementById('perchanceKeyDot');
export const perchanceKeyText = document.getElementById('perchanceKeyText');
export const perchanceArtStyleSelect = document.getElementById('perchanceArtStyle');
export const perchanceGuidanceSlider = document.getElementById('perchanceGuidance');
export const perchanceGuidanceValue = document.getElementById('perchanceGuidanceValue');

// Settings elements -- Venice AI
export const veniceKeyDot = document.getElementById('veniceKeyDot');
export const veniceKeyText = document.getElementById('veniceKeyText');
export const veniceApiKeyInput = document.getElementById('veniceApiKeyInput');
export const saveVeniceKeyBtn = document.getElementById('saveVeniceKeyBtn');
export const veniceModelSelect = document.getElementById('veniceModel');
export const veniceStepsInput = document.getElementById('veniceSteps');
export const veniceCfgScaleInput = document.getElementById('veniceCfgScale');
export const veniceStylePresetSelect = document.getElementById('veniceStylePreset');
export const veniceSafeModeCheckbox = document.getElementById('veniceSafeMode');
export const veniceHideWatermarkCheckbox = document.getElementById('veniceHideWatermark');
export const veniceVideoModelSelect = document.getElementById('veniceVideoModel');
export const veniceVideoDurationSelect = document.getElementById('veniceVideoDuration');
export const veniceVideoResolutionSelect = document.getElementById('veniceVideoResolution');
export const veniceBalance = document.getElementById('veniceBalance');
export const veniceBalanceText = document.getElementById('veniceBalanceText');
export const veniceSettingsBalance = document.getElementById('veniceSettingsBalance');
export const veniceSettingsBalanceText = document.getElementById('veniceSettingsBalanceText');

// Settings elements -- Puter.js
export const puterModelSelect = document.getElementById('puterModel');
export const puterQualitySelect = document.getElementById('puterQuality');
export const puterQualityGroup = document.getElementById('puterQualityGroup');

// Auto-generate toggle
export const autoGenerateToggle = document.getElementById('autoGenerateToggle');

// Scene settings elements
export const sceneAutoGenerate = document.getElementById('sceneAutoGenerate');
export const sceneUseCharacterLore = document.getElementById('sceneUseCharacterLore');
export const sceneArtStyleTags = document.getElementById('sceneArtStyleTags');
export const sceneMinTextChange = document.getElementById('sceneMinTextChange');
export const sceneMinTextChangeValue = document.getElementById('sceneMinTextChangeValue');
export const scenePromptTemperature = document.getElementById('scenePromptTemperature');
export const scenePromptTemperatureValue = document.getElementById('scenePromptTemperatureValue');
export const sceneSuggestionStyle = document.getElementById('sceneSuggestionStyle');
export const sceneSuggestionTemperature = document.getElementById('sceneSuggestionTemperature');
export const sceneSuggestionTemperatureValue = document.getElementById('sceneSuggestionTemperatureValue');
export const sceneEnableLitrpg = document.getElementById('sceneEnableLitrpg');

// Text LLM / Pipeline settings elements
export const scenePipelineVersion = document.getElementById('scenePipelineVersion');
export const sceneSecondaryLlm = document.getElementById('sceneSecondaryLlm');
export const textLlmOpenaiKey = document.getElementById('textLlmOpenaiKey');
export const textLlmOpenaiModel = document.getElementById('textLlmOpenaiModel');
export const textLlmAnthropicKey = document.getElementById('textLlmAnthropicKey');
export const textLlmAnthropicModel = document.getElementById('textLlmAnthropicModel');
export const textLlmOllamaModelSelect = document.getElementById('textLlmOllamaModelSelect');

// NovelAI token status elements
export const novelaiTokenDot = document.getElementById('novelaiTokenDot');
export const novelaiTokenText = document.getElementById('novelaiTokenText');

// NovelAI credential elements
export const novelaiEmailInput = document.getElementById('novelaiEmail');
export const novelaiPasswordInput = document.getElementById('novelaiPassword');

// Storyboard elements
export const storyboardBtn = document.getElementById('storyboardBtn');
export const storyboardModal = document.getElementById('storyboardModal');
export const storyboardSelect = document.getElementById('storyboardSelect');
export const sceneList = document.getElementById('sceneList');
export const storyboardCloseBtn = document.getElementById('storyboardCloseBtn');
export const sbNewBtn = document.getElementById('sbNewBtn');
export const sbDeleteBtn = document.getElementById('sbDeleteBtn');
export const sbRenameBtn = document.getElementById('sbRenameBtn');
export const commitBtn = document.getElementById('commitBtn');
export const commitConfirm = document.getElementById('commitConfirm');
export const commitSbName = document.getElementById('commitSbName');
export const commitNoteInput = document.getElementById('commitNoteInput');
export const commitConfirmBtn = document.getElementById('commitConfirmBtn');
export const commitCancelBtn = document.getElementById('commitCancelBtn');
export const commitStoryLabel = document.getElementById('commitStoryLabel');
export const storyIndicator = document.getElementById('storyIndicator');
export const sbLinkBtn = document.getElementById('sbLinkBtn');
export const toastEl = document.getElementById('toast');

// Suggestions elements
export const suggestionsBtn = document.getElementById('suggestionsBtn');
export const suggestionsBadge = document.getElementById('suggestionsBadge');
export const suggestionsPopover = document.getElementById('suggestionsPopover');
export const popoverCloseBtn = document.getElementById('popoverCloseBtn');
export const popoverRegenBtn = document.getElementById('popoverRegenBtn');
export const popoverSettingsBtn = document.getElementById('popoverSettingsBtn');
export const popoverSettings = document.getElementById('popoverSettings');
export const popoverBody = document.getElementById('popoverBody');
export const popoverSuggestionsContainer = document.getElementById('popoverSuggestionsContainer');
export const popoverLoading = document.getElementById('popoverLoading');
export const popoverStatus = document.getElementById('popoverStatus');
export const suggestionsEnabledCheckbox = document.getElementById('suggestionsEnabled');
export const suggestionsAutoShowCheckbox = document.getElementById('suggestionsAutoShow');

// Lore Creator elements
export const sceneTab = document.getElementById('sceneTab');
export const loreTab = document.getElementById('loreTab');
export const memoryTab = document.getElementById('memoryTab');
export const sceneContent = document.getElementById('sceneContent');
export const loreContent = document.getElementById('loreContent');
export const memoryContent = document.getElementById('memoryContent');
export const loreScanBtn = document.getElementById('loreScanBtn');
export const loreOrganizeBtn = document.getElementById('loreOrganizeBtn');
export const loreAcceptAllBtn = document.getElementById('loreAcceptAllBtn');
export const loreClearBtn = document.getElementById('loreClearBtn');
export const loreCleanupSection = document.getElementById('loreCleanupSection');
export const loreCleanupList = document.getElementById('loreCleanupList');
export const loreCleanupCount = document.getElementById('loreCleanupCount');
export const loreCleanupApplyAllBtn = document.getElementById('loreCleanupApplyAllBtn');
export const loreScanStatus = document.getElementById('loreScanStatus');
export const loreScanPhase = document.getElementById('loreScanPhase');
export const loreScanProgressFill = document.getElementById('loreScanProgressFill');
export const loreError = document.getElementById('loreError');
export const lorePendingList = document.getElementById('lorePendingList');
export const lorePendingCount = document.getElementById('lorePendingCount');
export const loreMergesSection = document.getElementById('loreMergesSection');
export const loreMergesList = document.getElementById('loreMergesList');
export const loreMergesCount = document.getElementById('loreMergesCount');
export const loreUpdatesSection = document.getElementById('loreUpdatesSection');
export const loreUpdatesList = document.getElementById('loreUpdatesList');
export const loreUpdatesCount = document.getElementById('loreUpdatesCount');
export const loreLlmIndicator = document.getElementById('loreLlmIndicator');
export const loreCreateInput = document.getElementById('loreCreateInput');
export const loreCreateBtn = document.getElementById('loreCreateBtn');
export const loreCreateCategory = document.getElementById('loreCreateCategory');
export const loreCreatePreview = document.getElementById('loreCreatePreview');
export const loreEnrichInput = document.getElementById('loreEnrichInput');
export const loreEnrichBtn = document.getElementById('loreEnrichBtn');
export const loreEnrichPreview = document.getElementById('loreEnrichPreview');
export const loreEnrichTarget = document.getElementById('loreEnrichTarget');
export const loreEnrichOld = document.getElementById('loreEnrichOld');
export const loreEnrichNew = document.getElementById('loreEnrichNew');
export const loreEnrichAcceptBtn = document.getElementById('loreEnrichAcceptBtn');
export const loreEnrichEditBtn = document.getElementById('loreEnrichEditBtn');
export const loreEnrichRejectBtn = document.getElementById('loreEnrichRejectBtn');

// Lorebook Optimizer elements
export const loreOptProfile = document.getElementById('loreOptProfile');
export const loreOptimizeAllBtn = document.getElementById('loreOptimizeAllBtn');
export const loreDiscoverFieldsBtn = document.getElementById('loreDiscoverFieldsBtn');
export const loreOptStatus = document.getElementById('loreOptStatus');

// Lore settings elements
export const loreAutoScan = document.getElementById('loreAutoScan');
export const loreAutoUpdates = document.getElementById('loreAutoUpdates');
export const loreMinChars = document.getElementById('loreMinChars');
export const loreMinCharsValue = document.getElementById('loreMinCharsValue');
export const loreTemp = document.getElementById('loreTemp');
export const loreTempValue = document.getElementById('loreTempValue');
export const loreDetailLevel = document.getElementById('loreDetailLevel');
export const loreLlmSelect = document.getElementById('loreLlmSelect');
export const loreOllamaSettings = document.getElementById('loreOllamaSettings');
export const loreOllamaModelSelect = document.getElementById('loreOllamaModelSelect');
export const loreOllamaRefreshBtn = document.getElementById('loreOllamaRefreshBtn');
export const loreHybridToggle = document.getElementById('loreHybridToggle');

// Lore scan menu
export const loreScanMenu = document.getElementById('loreScanMenu');

// Comprehension elements
export const startProgressiveScanBtn = document.getElementById('startProgressiveScanBtn');
export const pauseProgressiveScanBtn = document.getElementById('pauseProgressiveScanBtn');
export const cancelProgressiveScanBtn = document.getElementById('cancelProgressiveScanBtn');
export const comprehensionStatusText = document.getElementById('comprehensionStatusText');
export const comprehensionProgressFill = document.getElementById('comprehensionProgressFill');
export const masterSummaryDisplay = document.getElementById('masterSummaryDisplay');
export const masterSummaryText = document.getElementById('masterSummaryText');
export const entityProfilesList = document.getElementById('entityProfilesList');
export const entityCount = document.getElementById('entityCount');
export const entityProfileCards = document.getElementById('entityProfileCards');

// Memory DOM refs
export const memoryProxyDot = document.getElementById('memoryProxyDot');
export const memoryProxyText = document.getElementById('memoryProxyText');
export const memoryTokenCount = document.getElementById('memoryTokenCount');
export const memoryTokenPercent = document.getElementById('memoryTokenPercent');
export const memoryTokenBar = document.getElementById('memoryTokenBar');
export const memoryUpdateBtn = document.getElementById('memoryUpdateBtn');
export const memoryRefreshBtn = document.getElementById('memoryRefreshBtn');
export const memoryClearBtn = document.getElementById('memoryClearBtn');
export const memoryProgress = document.getElementById('memoryProgress');
export const memoryProgressText = document.getElementById('memoryProgressText');
export const memoryPreview = document.getElementById('memoryPreview');
export const memoryEventList = document.getElementById('memoryEventList');
export const memoryEventCount = document.getElementById('memoryEventCount');
export const memoryCharList = document.getElementById('memoryCharList');
export const memoryCharCount = document.getElementById('memoryCharCount');
export const memoryAutoUpdate = document.getElementById('memoryAutoUpdate');
export const memoryTokenLimit = document.getElementById('memoryTokenLimit');
export const memoryTokenLimitValue = document.getElementById('memoryTokenLimitValue');
export const memoryCompression = document.getElementById('memoryCompression');
export const memoryCompressionValue = document.getElementById('memoryCompressionValue');
export const memoryKeywords = document.getElementById('memoryKeywords');

// Perchance manual key elements
export const saveManualKeyBtn = document.getElementById('saveManualKeyBtn');
export const perchanceManualKeyInput = document.getElementById('perchanceManualKey');

// Family tree elements
export const familyTreeSection = document.getElementById('familyTreeSection');
export const familyTreeContainer = document.getElementById('familyTreeContainer');
export const familyTreeCount = document.getElementById('familyTreeCount');

// Resolution presets
export const RESOLUTION_PRESETS = {
  'square-sm': { width: 640, height: 640 },
  'square': { width: 832, height: 832 },
  'portrait-sm': { width: 512, height: 768 },
  'portrait': { width: 832, height: 1216 },
  'landscape-sm': { width: 768, height: 512 },
  'landscape': { width: 1216, height: 832 },
};

// V4 models list (for disabling SMEA)
export const V4_MODELS = [
  'nai-diffusion-4-curated-preview',
  'nai-diffusion-4-full',
  'nai-diffusion-4-5-curated',
  'nai-diffusion-4-5-full'
];

// LitRPG elements
export const rpgTab = document.getElementById('rpgTab');
export const rpgContent = document.getElementById('rpgContent');
export const rpgDetectionBanner = document.getElementById('rpgDetectionBanner');
export const rpgEnableBtn = document.getElementById('rpgEnableBtn');
export const rpgDismissBtn = document.getElementById('rpgDismissBtn');
export const rpgSystemIndicator = document.getElementById('rpgSystemIndicator');
export const rpgSystemType = document.getElementById('rpgSystemType');
export const rpgScanBtn = document.getElementById('rpgScanBtn');
export const rpgSyncLorebookBtn = document.getElementById('rpgSyncLorebookBtn');
export const rpgReverseSyncBtn = document.getElementById('rpgReverseSyncBtn');
export const rpgScanStatus = document.getElementById('rpgScanStatus');
export const rpgScanPhase = document.getElementById('rpgScanPhase');
export const rpgPartyList = document.getElementById('rpgPartyList');
export const rpgPartyCount = document.getElementById('rpgPartyCount');
export const rpgQuestListActive = document.getElementById('rpgQuestListActive');
export const rpgQuestListDone = document.getElementById('rpgQuestListDone');
export const rpgQuestCount = document.getElementById('rpgQuestCount');
export const rpgNpcList = document.getElementById('rpgNpcList');
export const rpgNpcCount = document.getElementById('rpgNpcCount');
export const rpgUpdatesList = document.getElementById('rpgUpdatesList');
export const rpgUpdatesSection = document.getElementById('rpgUpdatesSection');
export const rpgUpdatesCount = document.getElementById('rpgUpdatesCount');
export const rpgAutoScan = document.getElementById('rpgAutoScan');
export const rpgAutoSync = document.getElementById('rpgAutoSync');
export const rpgDisableBtn = document.getElementById('rpgDisableBtn');
export const rpgAcceptAllBtn = document.getElementById('rpgAcceptAllBtn');
export const rpgRejectAllBtn = document.getElementById('rpgRejectAllBtn');
export const rpgForceReEnrich = document.getElementById('rpgForceReEnrich');
export const rpgNpcSearch = document.getElementById('rpgNpcSearch');
export const rpgNpcGroupBtn = document.getElementById('rpgNpcGroupBtn');
export const rpgInventoryList = document.getElementById('rpgInventoryList');
export const rpgCurrencyList = document.getElementById('rpgCurrencyList');
export const rpgStatusEffectsList = document.getElementById('rpgStatusEffectsList');
export const rpgStatOverlay = document.getElementById('rpgStatOverlay');
export const rpgStatOverlayContent = document.getElementById('rpgStatOverlayContent');
export const rpgStatOverlayClose = document.getElementById('rpgStatOverlayClose');

// LitRPG scan progress + history
export const rpgScanSteps = document.getElementById('rpgScanSteps');
export const rpgScanElapsed = document.getElementById('rpgScanElapsed');
export const rpgScanHistorySection = document.getElementById('rpgScanHistorySection');
export const rpgScanHistoryCount = document.getElementById('rpgScanHistoryCount');
export const rpgScanHistoryList = document.getElementById('rpgScanHistoryList');
export const rpgDetectedType = document.getElementById('rpgDetectedType');

// LitRPG album lightbox
export const rpgAlbumLightbox = document.getElementById('rpgAlbumLightbox');
export const rpgAlbumLightboxImg = document.getElementById('rpgAlbumLightboxImg');
export const rpgAlbumPrev = document.getElementById('rpgAlbumPrev');
export const rpgAlbumNext = document.getElementById('rpgAlbumNext');
export const rpgAlbumCounter = document.getElementById('rpgAlbumCounter');
export const rpgAlbumSetActive = document.getElementById('rpgAlbumSetActive');
export const rpgAlbumDelete = document.getElementById('rpgAlbumDelete');
export const rpgAlbumClose = document.getElementById('rpgAlbumClose');

// LitRPG entity collection elements
export const rpgFactionList = document.getElementById('rpgFactionList');
export const rpgFactionCount = document.getElementById('rpgFactionCount');
export const rpgClassList = document.getElementById('rpgClassList');
export const rpgClassCount = document.getElementById('rpgClassCount');
export const rpgRaceList = document.getElementById('rpgRaceList');
export const rpgRaceCount = document.getElementById('rpgRaceCount');

// TTS elements
export const ttsNarrateBtn = document.getElementById('ttsNarrateBtn');
export const ttsStopBtn = document.getElementById('ttsStopBtn');
export const ttsProgress = document.getElementById('ttsProgress');
export const ttsProviderSelect = document.getElementById('ttsProvider');
export const ttsVersionSelect = document.getElementById('ttsVersion');
export const ttsVersionGroup = document.getElementById('ttsVersionGroup');
export const ttsNarratorVoiceSelect = document.getElementById('ttsNarratorVoice');
export const ttsDialogueVoiceSelect = document.getElementById('ttsDialogueVoice');
export const ttsSpeedSlider = document.getElementById('ttsSpeed');
export const ttsSpeedValue = document.getElementById('ttsSpeedValue');
export const ttsFirstPersonCheckbox = document.getElementById('ttsFirstPerson');
export const ttsVoiceMap = document.getElementById('ttsVoiceMap');
export const ttsVoiceList = document.getElementById('ttsVoiceList');
export const ttsVoiceCount = document.getElementById('ttsVoiceCount');
export const ttsAutoAssignBtn = document.getElementById('ttsAutoAssignBtn');
export const ttsPanelAddName = document.getElementById('ttsPanelAddName');
export const ttsPanelAddBtn = document.getElementById('ttsPanelAddBtn');
export const ttsSettingsVoiceList = document.getElementById('ttsSettingsVoiceList');
export const ttsSettingsVoiceCount = document.getElementById('ttsSettingsVoiceCount');
export const ttsAddCharName = document.getElementById('ttsAddCharName');
export const ttsAddCharVoice = document.getElementById('ttsAddCharVoice');
export const ttsAddCharBtn = document.getElementById('ttsAddCharBtn');
// TTS v2 advanced fields
export const ttsV2NarratorGroup = document.getElementById('ttsV2NarratorGroup');
export const ttsV2DialogueGroup = document.getElementById('ttsV2DialogueGroup');
export const ttsNarratorStyle = document.getElementById('ttsNarratorStyle');
export const ttsNarratorIntonation = document.getElementById('ttsNarratorIntonation');
export const ttsNarratorCadence = document.getElementById('ttsNarratorCadence');
export const ttsDialogueStyle = document.getElementById('ttsDialogueStyle');
export const ttsDialogueIntonation = document.getElementById('ttsDialogueIntonation');
export const ttsDialogueCadence = document.getElementById('ttsDialogueCadence');
export const ttsNarratorCustomSeed = document.getElementById('ttsNarratorCustomSeed');
export const ttsDialogueCustomSeed = document.getElementById('ttsDialogueCustomSeed');
export const ttsAddCharCustomSeed = document.getElementById('ttsAddCharCustomSeed');

// Media Gallery elements
export const mediaTab = document.getElementById('mediaTab');
export const mediaContent = document.getElementById('mediaContent');
export const mediaGrid = document.getElementById('mediaGrid');
export const mediaCount = document.getElementById('mediaCount');
export const mediaFilterSelect = document.getElementById('mediaFilter');
export const mediaLightbox = document.getElementById('mediaLightbox');
export const mediaLightboxContent = document.getElementById('mediaLightboxContent');
export const mediaLightboxClose = document.getElementById('mediaLightboxClose');

// Lore category management elements
export const loreCategoryToggles = document.getElementById('loreCategoryToggles');
export const loreAddCategoryBtn = document.getElementById('loreAddCategoryBtn');
export const loreDetectCategoriesBtn = document.getElementById('loreDetectCategoriesBtn');
export const loreAddCategoryForm = document.getElementById('loreAddCategoryForm');
export const loreNewCategoryName = document.getElementById('loreNewCategoryName');
export const loreNewCategoryColor = document.getElementById('loreNewCategoryColor');
export const loreAddCategoryConfirm = document.getElementById('loreAddCategoryConfirm');
export const loreAddCategoryCancel = document.getElementById('loreAddCategoryCancel');
export const dynamicCategoriesStyle = document.getElementById('dynamic-categories');
