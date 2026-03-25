/**
 * Lore Creator Proxy
 *
 * Thin proxy script for the PowerTool's Electron-side Lore Creator.
 * Exposes lorebook CRUD operations via globalThis.__loreCreator so the
 * Electron renderer can call them through webview.executeJavaScript().
 *
 * No UI, no LLM calls, no onGenerationEnd hook.
 *
 * @version 1.0.0
 * @author ryanrobson
 */

const LOG_PREFIX = '[LoreProxy]';

// ============================================================================
// LOREBOOK UTILITIES
// ============================================================================

/**
 * Three-strategy update fallback for lorebook entries.
 * 1. Try updateEntry API
 * 2. Try direct mutation + save
 * 3. Fall back to delete + recreate
 */
async function updateLorebookEntry(rawEntry: any, updates: Record<string, any>): Promise<boolean> {
  const entryId = rawEntry.id;

  // Strategy 1: Try updateEntry API
  try {
    await (api.v1.lorebook as any).updateEntry(entryId, updates);
    api.v1.log(`${LOG_PREFIX} Updated entry via updateEntry API: ${rawEntry.displayName}`);
    return true;
  } catch (_) {
    api.v1.log(`${LOG_PREFIX} updateEntry API not available, trying direct mutation`);
  }

  // Strategy 2: Try direct mutation + save
  try {
    for (const [key, value] of Object.entries(updates)) {
      rawEntry[key] = value;
    }
    if (typeof rawEntry.save === 'function') {
      await rawEntry.save();
      api.v1.log(`${LOG_PREFIX} Updated entry via direct mutation: ${rawEntry.displayName}`);
      return true;
    }
  } catch (_) {
    api.v1.log(`${LOG_PREFIX} Direct mutation failed, falling back to delete + recreate`);
  }

  // Strategy 3: Delete + recreate
  try {
    await (api.v1.lorebook as any).deleteEntry(entryId);

    const recreated: any = {
      displayName: updates.displayName ?? rawEntry.displayName,
      text: updates.text ?? rawEntry.text,
      keys: updates.keys ?? rawEntry.keys ?? [],
      enabled: rawEntry.enabled !== false,
    };
    if (rawEntry.category) {
      recreated.category = rawEntry.category;
    }

    await (api.v1.lorebook as any).createEntry(recreated);
    api.v1.log(`${LOG_PREFIX} Updated entry via delete+recreate: ${recreated.displayName}`);
    return true;
  } catch (e) {
    api.v1.error(`${LOG_PREFIX} All update strategies failed for ${rawEntry.displayName}:`, e);
    return false;
  }
}

// ============================================================================
// PROXY API
// ============================================================================

const loreCreatorProxy = {
  isReady(): boolean {
    return true;
  },

  async getEntries(): Promise<any[]> {
    try {
      const entries = await api.v1.lorebook.entries();
      return entries.map((entry: any) => ({
        id: entry.id,
        displayName: entry.displayName || '',
        keys: entry.keys || [],
        text: entry.text || '',
        category: entry.category || null,
        enabled: entry.enabled !== false,
      }));
    } catch (e) {
      api.v1.error(`${LOG_PREFIX} Error reading lorebook entries:`, e);
      return [];
    }
  },

  async createEntry(data: {
    displayName: string;
    keys: string[];
    text: string;
    enabled?: boolean;
    category?: string;
  }): Promise<string | null> {
    try {
      const entry: any = {
        displayName: data.displayName,
        text: data.text,
        keys: data.keys,
        enabled: data.enabled !== false,
      };
      if (data.category) {
        entry.category = data.category;
      }
      const result = await (api.v1.lorebook as any).createEntry(entry);
      const entryId = (result && result.id) ? result.id : result;
      api.v1.log(`${LOG_PREFIX} Created entry: ${data.displayName} (${entryId})`);
      return entryId;
    } catch (e) {
      api.v1.error(`${LOG_PREFIX} Error creating entry ${data.displayName}:`, e);
      return null;
    }
  },

  async updateEntry(
    id: string,
    updates: { displayName?: string; keys?: string[]; text?: string }
  ): Promise<boolean> {
    try {
      const entries = await api.v1.lorebook.entries();
      const rawEntry = entries.find((e: any) => e.id === id);
      if (!rawEntry) {
        api.v1.error(`${LOG_PREFIX} Entry not found: ${id}`);
        return false;
      }
      return await updateLorebookEntry(rawEntry, updates);
    } catch (e) {
      api.v1.error(`${LOG_PREFIX} Error updating entry ${id}:`, e);
      return false;
    }
  },

  async deleteEntry(id: string): Promise<boolean> {
    try {
      await (api.v1.lorebook as any).deleteEntry(id);
      api.v1.log(`${LOG_PREFIX} Deleted entry: ${id}`);
      return true;
    } catch (e) {
      api.v1.error(`${LOG_PREFIX} Error deleting entry ${id}:`, e);
      return false;
    }
  },

  async createCategory(data: { name: string; enabled?: boolean }): Promise<string | null> {
    try {
      const category = await (api.v1.lorebook as any).createCategory({
        name: data.name,
        enabled: data.enabled !== false,
      });
      const categoryId = (category && category.id) ? category.id : category;
      api.v1.log(`${LOG_PREFIX} Created category: ${data.name} (${categoryId})`);
      return categoryId;
    } catch (e) {
      api.v1.error(`${LOG_PREFIX} Error creating category ${data.name}:`, e);
      return null;
    }
  },

  async getStoryText(): Promise<string> {
    try {
      const scanResults = await api.v1.document.scan();
      let text = '';
      for (const { section } of scanResults) {
        if (section.text) {
          text += section.text + '\n';
        }
      }
      return text;
    } catch (e) {
      api.v1.error(`${LOG_PREFIX} Error reading story text:`, e);
      return '';
    }
  },
};

// ============================================================================
// INITIALIZATION
// ============================================================================

async function init(): Promise<void> {
  api.v1.log(`${LOG_PREFIX} Initializing Lore Creator Proxy...`);

  // Request permissions
  const hasPermissions = await api.v1.permissions.request(['storyEdit', 'lorebookEdit']);
  if (!hasPermissions) {
    api.v1.error(`${LOG_PREFIX} Required permissions not granted`);
    return;
  }

  // Expose proxy on globalThis for Electron renderer access
  (globalThis as any).__loreCreator = loreCreatorProxy;

  api.v1.log(`${LOG_PREFIX} Lore Creator Proxy ready (globalThis.__loreCreator exposed)`);
}

init();
