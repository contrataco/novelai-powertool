const Database = require('better-sqlite3');
const path = require('path');
const { LITRPG_STATE_DEFAULTS } = require('./litrpg-tracker');
const { TIMELINE_STATE_DEFAULTS } = require('./scene-timeline');

const LOG_PREFIX = '[DB]';

let db;

function getDb() { return db; }

function init(userDataPath) {
  const dbPath = path.join(userDataPath, 'stories.db');
  console.log(`${LOG_PREFIX} Opening database at ${dbPath}`);
  db = new Database(dbPath);
  db.pragma('journal_mode = WAL');
  db.pragma('foreign_keys = ON');
  createTables();
  db.pragma('analysis_limit = 1000');
  db.exec('ANALYZE');
  return db;
}

function createTables() {
  db.exec(`
    CREATE TABLE IF NOT EXISTS stories (
      id TEXT PRIMARY KEY,
      title TEXT NOT NULL DEFAULT '',
      first_seen_at INTEGER NOT NULL,
      last_accessed_at INTEGER NOT NULL
    );

    CREATE INDEX IF NOT EXISTS idx_stories_last_accessed ON stories(last_accessed_at DESC);

    CREATE TABLE IF NOT EXISTS scene_state (
      story_id TEXT PRIMARY KEY REFERENCES stories(id),
      data TEXT NOT NULL DEFAULT '{}',
      updated_at INTEGER NOT NULL
    );

    CREATE TABLE IF NOT EXISTS lore_state (
      story_id TEXT PRIMARY KEY REFERENCES stories(id),
      data TEXT NOT NULL DEFAULT '{}',
      updated_at INTEGER NOT NULL
    );

    CREATE TABLE IF NOT EXISTS lore_comprehension (
      story_id TEXT PRIMARY KEY REFERENCES stories(id),
      data TEXT NOT NULL DEFAULT '{}',
      updated_at INTEGER NOT NULL
    );

    CREATE TABLE IF NOT EXISTS memory_state (
      story_id TEXT PRIMARY KEY REFERENCES stories(id),
      data TEXT NOT NULL DEFAULT '{}',
      updated_at INTEGER NOT NULL
    );

    CREATE TABLE IF NOT EXISTS litrpg_state (
      story_id TEXT PRIMARY KEY REFERENCES stories(id),
      data TEXT NOT NULL DEFAULT '{}',
      updated_at INTEGER NOT NULL
    );

    CREATE TABLE IF NOT EXISTS tts_state (
      story_id TEXT PRIMARY KEY REFERENCES stories(id),
      data TEXT NOT NULL DEFAULT '{}',
      updated_at INTEGER NOT NULL
    );

    CREATE TABLE IF NOT EXISTS story_settings (
      story_id TEXT PRIMARY KEY REFERENCES stories(id),
      data TEXT NOT NULL DEFAULT '{}',
      updated_at INTEGER NOT NULL
    );

    CREATE TABLE IF NOT EXISTS media_items (
      id TEXT PRIMARY KEY,
      story_id TEXT NOT NULL,
      type TEXT NOT NULL DEFAULT 'image',
      filename TEXT NOT NULL,
      thumb_filename TEXT,
      prompt TEXT DEFAULT '',
      negative_prompt TEXT DEFAULT '',
      provider TEXT DEFAULT '',
      model TEXT DEFAULT '',
      width INTEGER DEFAULT 0,
      height INTEGER DEFAULT 0,
      file_size INTEGER DEFAULT 0,
      created_at INTEGER NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_media_story ON media_items(story_id, type, created_at);

    CREATE TABLE IF NOT EXISTS visual_profiles (
      story_id TEXT NOT NULL,
      character_name TEXT NOT NULL,
      data TEXT NOT NULL DEFAULT '{}',
      updated_at INTEGER NOT NULL,
      PRIMARY KEY (story_id, character_name)
    );

    CREATE TABLE IF NOT EXISTS migrations (
      version INTEGER PRIMARY KEY,
      applied_at INTEGER NOT NULL
    );

    CREATE TABLE IF NOT EXISTS timeline_state (
      story_id TEXT PRIMARY KEY REFERENCES stories(id),
      data TEXT NOT NULL DEFAULT '{}',
      updated_at INTEGER NOT NULL
    );

    CREATE TABLE IF NOT EXISTS story_text (
      story_id TEXT PRIMARY KEY REFERENCES stories(id),
      text TEXT NOT NULL DEFAULT '',
      char_count INTEGER NOT NULL DEFAULT 0,
      source TEXT NOT NULL DEFAULT 'webview',
      updated_at INTEGER NOT NULL
    );

    CREATE TABLE IF NOT EXISTS story_images (
      id TEXT PRIMARY KEY,
      story_id TEXT NOT NULL REFERENCES stories(id),
      image_id TEXT NOT NULL,
      paragraph_index INTEGER NOT NULL DEFAULT 0,
      layout_mode TEXT NOT NULL DEFAULT 'break',
      float_side TEXT NOT NULL DEFAULT 'right',
      caption TEXT NOT NULL DEFAULT '',
      created_at INTEGER NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_story_images_story ON story_images(story_id, paragraph_index);
  `);
  console.log(`${LOG_PREFIX} Tables verified`);
}

// --- Stories ---

function upsertStory(id, title) {
  const now = Date.now();
  db.prepare(`
    INSERT INTO stories (id, title, first_seen_at, last_accessed_at)
    VALUES (?, ?, ?, ?)
    ON CONFLICT(id) DO UPDATE SET
      title = CASE WHEN excluded.title != '' THEN excluded.title ELSE stories.title END,
      last_accessed_at = excluded.last_accessed_at
  `).run(id, title || '', now, now);
}

function getStory(id) {
  return db.prepare('SELECT * FROM stories WHERE id = ?').get(id) || null;
}

function listStories() {
  return db.prepare('SELECT * FROM stories ORDER BY last_accessed_at DESC').all();
}

// --- Generic per-story CRUD ---

const VALID_TABLES = new Set(['scene_state', 'lore_state', 'lore_comprehension', 'memory_state', 'litrpg_state', 'tts_state', 'story_settings', 'timeline_state']);

function getData(table, storyId) {
  if (!VALID_TABLES.has(table)) throw new Error(`Invalid table: ${table}`);
  const row = db.prepare(`SELECT data FROM ${table} WHERE story_id = ?`).get(storyId);
  return row ? JSON.parse(row.data) : null;
}

function setData(table, storyId, data) {
  if (!VALID_TABLES.has(table)) throw new Error(`Invalid table: ${table}`);
  // Ensure story exists
  upsertStory(storyId, '');
  db.prepare(`INSERT OR REPLACE INTO ${table} (story_id, data, updated_at) VALUES (?, ?, ?)`)
    .run(storyId, JSON.stringify(data), Date.now());
}

// --- Convenience wrappers ---

const LORE_STATE_DEFAULTS = {
  pendingEntries: [], pendingUpdates: [], pendingMerges: [],
  acceptedEntryIds: [], rejectedNames: [], dismissedUpdateNames: [],
  rejectedMergeNames: [], dismissedReformatNames: [], charsSinceLastScan: 0, loreCategoryIds: {},
  pendingCleanups: [], dismissedCleanupIds: [],
};

function getSceneState(storyId) {
  return getData('scene_state', storyId);
}

function setSceneState(storyId, data) {
  setData('scene_state', storyId, data);
}

function getLoreState(storyId) {
  const data = getData('lore_state', storyId);
  if (!data) return null;
  // Merge with defaults so all keys exist
  return { ...LORE_STATE_DEFAULTS, ...data };
}

function setLoreState(storyId, data) {
  setData('lore_state', storyId, data);
}

function getComprehension(storyId) {
  return getData('lore_comprehension', storyId);
}

function setComprehension(storyId, data) {
  setData('lore_comprehension', storyId, data);
}

function getMemoryState(storyId) {
  return getData('memory_state', storyId);
}

function setMemoryState(storyId, data) {
  setData('memory_state', storyId, data);
}

function getLitrpgState(storyId) {
  const data = getData('litrpg_state', storyId);
  if (!data) return null;
  return { ...LITRPG_STATE_DEFAULTS, ...data };
}

function setLitrpgState(storyId, data) {
  setData('litrpg_state', storyId, data);
}

function getOrCreateLitrpgState(storyId) {
  const data = getData('litrpg_state', storyId);
  return { ...LITRPG_STATE_DEFAULTS, ...(data || {}) };
}

const TTS_STATE_DEFAULTS = { characterVoices: {} };

function getTtsState(storyId) {
  const data = getData('tts_state', storyId);
  if (!data) return { ...TTS_STATE_DEFAULTS };
  return { ...TTS_STATE_DEFAULTS, ...data };
}

function setTtsState(storyId, data) {
  setData('tts_state', storyId, data);
}

function getStorySettings(storyId) {
  return getData('story_settings', storyId);
}

function setStorySettings(storyId, data) {
  setData('story_settings', storyId, data);
}

function getTimelineState(storyId) {
  const data = getData('timeline_state', storyId);
  if (!data) return null;
  return { ...TIMELINE_STATE_DEFAULTS, ...data };
}

function setTimelineState(storyId, state) {
  setData('timeline_state', storyId, state);
}

// --- Story text cache (dedicated schema, not generic JSON) ---

function getStoryText(storyId) {
  const row = db.prepare('SELECT text, char_count, source, updated_at FROM story_text WHERE story_id = ?').get(storyId);
  return row || null;
}

function setStoryText(storyId, text, source = 'webview') {
  upsertStory(storyId, '');
  db.prepare('INSERT OR REPLACE INTO story_text (story_id, text, char_count, source, updated_at) VALUES (?, ?, ?, ?, ?)')
    .run(storyId, text, text.length, source, Date.now());
}

// --- Story Images ---

function getStoryImages(storyId) {
  return db.prepare(
    'SELECT * FROM story_images WHERE story_id = ? ORDER BY paragraph_index ASC'
  ).all(storyId);
}

function setStoryImage(img) {
  upsertStory(img.story_id, '');
  db.prepare(`
    INSERT OR REPLACE INTO story_images
      (id, story_id, image_id, paragraph_index, layout_mode, float_side, caption, created_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?)
  `).run(
    img.id,
    img.story_id,
    img.image_id,
    img.paragraph_index,
    img.layout_mode || 'break',
    img.float_side || 'right',
    img.caption || '',
    img.created_at || Date.now()
  );
}

function removeStoryImage(id) {
  db.prepare('DELETE FROM story_images WHERE id = ?').run(id);
}

function removeAllStoryImages(storyId) {
  db.prepare('DELETE FROM story_images WHERE story_id = ?').run(storyId);
}

// --- Bulk load (used on story switch) ---

function loadAllStoryData(storyId) {
  const loadInTransaction = db.transaction((sid) => ({
    sceneState: getSceneState(sid),
    loreState: getLoreState(sid),
    comprehension: getComprehension(sid),
    memoryState: getMemoryState(sid),
    litrpgState: getLitrpgState(sid),
    ttsState: getTtsState(sid),
    storySettings: getStorySettings(sid),
    timelineState: getTimelineState(sid),
    storyText: getStoryText(sid),
  }));
  return loadInTransaction(storyId);
}

// --- Migration from electron-store ---

function migrateFromStore(store) {
  const tables = [
    { storeKey: 'sceneState', table: 'scene_state' },
    { storeKey: 'loreState', table: 'lore_state' },
    { storeKey: 'loreComprehension', table: 'lore_comprehension' },
    { storeKey: 'memoryState', table: 'memory_state' },
  ];

  const insertStory = db.prepare(
    'INSERT OR IGNORE INTO stories (id, title, first_seen_at, last_accessed_at) VALUES (?, ?, ?, ?)'
  );

  const migrate = db.transaction(() => {
    let totalMigrated = 0;
    for (const { storeKey, table } of tables) {
      const allData = store.get(storeKey) || {};
      const storyIds = Object.keys(allData);
      for (const storyId of storyIds) {
        const data = allData[storyId];
        if (!data || typeof data !== 'object') continue;
        const now = Date.now();
        insertStory.run(storyId, '', now, now);
        db.prepare(`INSERT OR IGNORE INTO ${table} (story_id, data, updated_at) VALUES (?, ?, ?)`)
          .run(storyId, JSON.stringify(data), now);
        totalMigrated++;
      }
    }
    console.log(`${LOG_PREFIX} Migrated ${totalMigrated} records from electron-store`);
  });

  migrate();
}

// --- Visual Profiles ---

function getVisualProfiles(storyId) {
  const rows = db.prepare('SELECT character_name, data FROM visual_profiles WHERE story_id = ?').all(storyId);
  const profiles = {};
  for (const row of rows) {
    try { profiles[row.character_name] = JSON.parse(row.data); } catch { /* skip corrupt */ }
  }
  return profiles;
}

function getVisualProfile(storyId, characterName) {
  const row = db.prepare('SELECT data FROM visual_profiles WHERE story_id = ? AND character_name = ?').get(storyId, characterName);
  if (!row) return null;
  try { return JSON.parse(row.data); } catch { return null; }
}

function setVisualProfile(storyId, characterName, data) {
  upsertStory(storyId, '');
  db.prepare(`INSERT OR REPLACE INTO visual_profiles (story_id, character_name, data, updated_at) VALUES (?, ?, ?, ?)`)
    .run(storyId, characterName, JSON.stringify(data), Date.now());
}

function resetVisualProfiles(storyId) {
  db.prepare('DELETE FROM visual_profiles WHERE story_id = ?').run(storyId);
}

function close() {
  if (db) {
    console.log(`${LOG_PREFIX} Closing database`);
    db.close();
    db = null;
  }
}

module.exports = {
  init, close, getDb,
  upsertStory, getStory, listStories,
  getSceneState, setSceneState,
  getLoreState, setLoreState,
  getComprehension, setComprehension,
  getMemoryState, setMemoryState,
  getLitrpgState, setLitrpgState, getOrCreateLitrpgState, LITRPG_STATE_DEFAULTS,
  getTtsState, setTtsState, TTS_STATE_DEFAULTS,
  getStorySettings, setStorySettings,
  getVisualProfiles, getVisualProfile, setVisualProfile, resetVisualProfiles,
  getTimelineState, setTimelineState,
  getStoryText, setStoryText,
  getStoryImages, setStoryImage, removeStoryImage, removeAllStoryImages,
  loadAllStoryData, migrateFromStore,
};
