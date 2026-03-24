/*---
compatibilityVersion: naiscript-1.0
id: e02be7b4-4993-4ebf-abc0-ca7ed996744f
name: NovelAI PowerTool
createdAt: 1766945065236
updatedAt: 1771655623976
version: 3.0.0
author: Contrataco
description: Lightweight bridge for PowerTool Electron app — story identity, text relay, suggestion insertion
memoryLimit: 16
---*/

// ============================================================================
// CONFIGURATION
// ============================================================================

interface ScriptStorage {
  lastProcessedSectionId: number | null;
}

const DEFAULT_STORAGE: ScriptStorage = {
  lastProcessedSectionId: null,
};

// Story identity
let currentStoryId: string | null = null;
let currentStoryTitle: string | null = null;

// ============================================================================
// STORAGE UTILITIES
// ============================================================================

async function getStorage(): Promise<ScriptStorage> {
  try {
    const stored = await api.v1.storyStorage.get('sceneVisualizerData');
    if (stored) {
      return { ...DEFAULT_STORAGE, ...JSON.parse(stored) };
    }
  } catch (e) {
    api.v1.error('[PowerTool] Error loading storage:', e);
  }
  return { ...DEFAULT_STORAGE };
}

async function saveStorage(data: ScriptStorage): Promise<void> {
  try {
    await api.v1.storyStorage.set('sceneVisualizerData', JSON.stringify(data));
  } catch (e) {
    api.v1.error('[PowerTool] Error saving storage:', e);
  }
}

// ============================================================================
// DOM RELAY — Data bridge for Electron polling
// ============================================================================

// Broadcast story context to Electron via DOM element (the contextBridge is
// inaccessible from NovelAI's script sandbox, so we use DOM data attributes
// that the webview-preload MutationObserver can detect and relay via IPC).
function broadcastStoryContext(): void {
  if (!currentStoryId) return;
  try {
    let el = document.getElementById('scene-vis-story-context');
    if (!el) {
      el = document.createElement('div');
      el.id = 'scene-vis-story-context';
      el.style.display = 'none';
      document.body.appendChild(el);
    }
    el.dataset.storyId = currentStoryId;
    el.dataset.storyTitle = currentStoryTitle || '';
  } catch (e) {
    // DOM not available
  }
}

function broadcastStoryText(storyText: string): void {
  try {
    let el = document.getElementById('scene-vis-story-text');
    if (!el) {
      el = document.createElement('div');
      el.id = 'scene-vis-story-text';
      el.style.display = 'none';
      document.body.appendChild(el);
    }
    el.dataset.text = storyText.slice(-4000);
    el.dataset.timestamp = String(Date.now());
  } catch (e) {
    // DOM not available
  }
}

// Signal that a generation just completed — Electron polls this for
// near-instant prompt generation instead of waiting for the 10s auto-gen cycle.
function broadcastGenerationEnded(textLength: number): void {
  try {
    let el = document.getElementById('scene-vis-gen-ended');
    if (!el) {
      el = document.createElement('div');
      el.id = 'scene-vis-gen-ended';
      el.style.display = 'none';
      document.body.appendChild(el);
    }
    el.dataset.timestamp = String(Date.now());
    el.dataset.textLength = String(textLength);
  } catch (e) {
    // DOM not available
  }
}

// ============================================================================
// STORY IDENTITY
// ============================================================================

async function refreshStoryIdentity(): Promise<void> {
  try {
    if ((api.v1 as any).story?.id) {
      const id = await (api.v1 as any).story.id();
      if (id && String(id) !== currentStoryId) {
        currentStoryId = String(id);
        api.v1.log(`[PowerTool] Story changed to: ${currentStoryId}`);
      }
    }
    if ((api.v1 as any).story?.title?.get) {
      const title = await (api.v1 as any).story.title.get();
      if (title) currentStoryTitle = String(title);
    }
    broadcastStoryContext();
  } catch (e) {
    // Non-fatal
  }
}

// ============================================================================
// HOOK — onGenerationEnd
// ============================================================================

// Lightweight hook: reads story text, broadcasts via DOM, signals Electron.
// All LLM work (prompt gen, suggestions, character extraction) is handled
// by the Electron app — the script never calls api.v1.generate().
function registerHooks(): void {
  api.v1.hooks.register('onGenerationEnd', async () => {
    try {
      await refreshStoryIdentity();

      // Read full story text
      let storyText = '';
      const scanResults = await api.v1.document.scan();
      for (const { section } of scanResults) {
        if (section.text) storyText += section.text + '\n';
      }

      if (storyText.length >= 100) {
        broadcastStoryText(storyText);
        broadcastGenerationEnded(storyText.length);
      }
    } catch (e) {
      api.v1.error('[PowerTool] Error in onGenerationEnd hook:', e);
    }
  });
}

// ============================================================================
// UI PANEL — Minimal status display
// ============================================================================

async function createUIPanel(): Promise<void> {
  const buildPanel = async () => {
    return api.v1.ui.part.column({
      content: [
        api.v1.ui.part.text({
          text: 'PowerTool v3.0.0',
          style: { fontWeight: 'bold', fontSize: '16px', marginBottom: '8px' }
        }),
        api.v1.ui.part.text({
          text: currentStoryTitle
            ? `Story: ${currentStoryTitle}`
            : 'No story detected',
          style: { fontSize: '12px', color: '#888', marginBottom: '4px' }
        }),
        api.v1.ui.part.text({
          text: currentStoryId
            ? `ID: ${currentStoryId.slice(0, 12)}…`
            : '',
          style: { fontSize: '10px', color: '#666', marginBottom: '12px' }
        }),
        api.v1.ui.part.text({
          text: 'All prompts, suggestions, and image generation are handled by the Electron app. This script provides story data relay and text insertion.',
          style: { fontSize: '11px', color: '#888', lineHeight: '1.4' }
        }),
      ],
      style: { padding: '12px' }
    });
  };

  try {
    const initialPanel = await buildPanel();
    await api.v1.ui.register([
      api.v1.ui.extension.scriptPanel({
        id: 'powertoolPanel',
        name: 'PowerTool',
        content: [initialPanel]
      })
    ]);
  } catch (e) {
    api.v1.error('[PowerTool] Error creating panel:', e);
  }
}

// ============================================================================
// INITIALIZATION
// ============================================================================

async function initialize(): Promise<void> {
  try {
    api.v1.log('[PowerTool] Initializing v3.0.0 (bridge mode)...');

    // Request storyEdit permission (needed for suggestion insertion via document.append)
    const hasPermissions = await api.v1.permissions.request(['storyEdit']);
    if (!hasPermissions) {
      api.v1.log('[PowerTool] storyEdit permission not granted — suggestion insertion may not work');
    }

    // Extract story identity
    try {
      if ((api.v1 as any).story?.id) {
        const id = await (api.v1 as any).story.id();
        if (id) {
          currentStoryId = String(id);
          api.v1.log(`[PowerTool] Story ID from API: ${currentStoryId}`);
        }
      }

      // Fall back to storyStorage-based UUID
      if (!currentStoryId) {
        const stored = await api.v1.storyStorage.get('sceneVisualizerStoryId');
        if (stored) {
          currentStoryId = stored;
          api.v1.log(`[PowerTool] Story ID from storage: ${currentStoryId}`);
        } else {
          currentStoryId = 'sv_' + Date.now() + '_' + Math.random().toString(36).slice(2, 8);
          await api.v1.storyStorage.set('sceneVisualizerStoryId', currentStoryId);
          api.v1.log(`[PowerTool] Generated new story ID: ${currentStoryId}`);
        }
      }

      // Try to get story title
      if ((api.v1 as any).story?.title?.get) {
        const title = await (api.v1 as any).story.title.get();
        if (title) {
          currentStoryTitle = String(title);
          api.v1.log(`[PowerTool] Story title: ${currentStoryTitle}`);
        }
      }

      broadcastStoryContext();
    } catch (e) {
      api.v1.log('[PowerTool] Could not extract story identity (non-fatal):' + e);
    }

    await getStorage();
    await createUIPanel();
    registerHooks();

    // Expose insertion function for Electron to call via webview.executeJavaScript
    (globalThis as any).__sceneVisInsert = async (text: string): Promise<boolean> => {
      try {
        await api.v1.document.append('\n' + text);
        api.v1.log(`[PowerTool] Insertion via document.append: "${text.slice(0, 50)}..."`);
        return true;
      } catch (e) {
        api.v1.log('[PowerTool] document.append failed: ' + e);
        try {
          if (api.v1.prefill?.set) {
            await api.v1.prefill.set(text);
            api.v1.log(`[PowerTool] Insertion via prefill.set: "${text.slice(0, 50)}..."`);
            return true;
          }
        } catch (e2) {
          api.v1.log('[PowerTool] prefill.set also failed: ' + e2);
        }
        return false;
      }
    };

    api.v1.ui.toast('PowerTool bridge loaded', { autoClose: 2000, type: 'success' });
    api.v1.log('[PowerTool] v3.0.0 initialization complete (bridge mode)');

  } catch (e) {
    api.v1.error('[PowerTool] Initialization failed:', e);
    api.v1.ui.toast('PowerTool failed to load', { autoClose: 5000, type: 'error' });
  }
}

// Start
initialize();
