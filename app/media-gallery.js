/**
 * Media Gallery — auto-save generated images/videos to disk with browsable history.
 * Uses Electron nativeImage for thumbnail generation (same pattern as portrait-manager).
 */

const { nativeImage } = require('electron');
const path = require('path');
const fs = require('fs');

const { generateId: _sharedGenerateId } = require('./shared-utils');

const LOG_PREFIX = '[MediaGallery]';
const IMAGE_CAP = 100;
const VIDEO_CAP = 20;
const THUMB_WIDTH = 160;
const THUMB_HEIGHT = 120;

let galleryBaseDir = null;
let dbInstance = null;

function init(userDataPath, db) {
  galleryBaseDir = path.join(userDataPath, 'gallery');
  dbInstance = db;
  if (!fs.existsSync(galleryBaseDir)) {
    fs.mkdirSync(galleryBaseDir, { recursive: true });
  }
  console.log(`${LOG_PREFIX} Gallery dir: ${galleryBaseDir}`);
}

function getStoryDir(storyId) {
  const dir = path.join(galleryBaseDir, storyId);
  if (!fs.existsSync(dir)) {
    fs.mkdirSync(dir, { recursive: true });
  }
  return dir;
}

function generateId() {
  return _sharedGenerateId('mi');
}

// ---------------------------------------------------------------------------
// Save image
// ---------------------------------------------------------------------------

function saveImage(storyId, imageDataUrl, metadata = {}) {
  const id = generateId();
  const dir = getStoryDir(storyId);
  const timestamp = Date.now();
  const rand = Math.random().toString(36).slice(2, 6);
  const filename = `img_${timestamp}_${rand}.png`;
  const thumbFilename = `img_${timestamp}_${rand}_thumb.png`;

  // Decode base64 data URL to buffer
  const base64Data = imageDataUrl.replace(/^data:image\/\w+;base64,/, '');
  const imageBuffer = Buffer.from(base64Data, 'base64');

  // Write full image
  fs.writeFileSync(path.join(dir, filename), imageBuffer);
  const fileSize = imageBuffer.length;

  // Generate thumbnail
  let thumbCreated = false;
  try {
    const img = nativeImage.createFromBuffer(imageBuffer);
    const size = img.getSize();
    if (size.width > 0 && size.height > 0) {
      const thumb = img.resize({ width: THUMB_WIDTH, height: THUMB_HEIGHT });
      fs.writeFileSync(path.join(dir, thumbFilename), thumb.toPNG());
      thumbCreated = true;
    }
  } catch (err) {
    console.error(`${LOG_PREFIX} Thumbnail generation failed:`, err.message);
  }

  // Insert row
  dbInstance.prepare(`
    INSERT INTO media_items (id, story_id, type, filename, thumb_filename, prompt, negative_prompt, provider, model, width, height, file_size, created_at)
    VALUES (?, ?, 'image', ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(
    id, storyId, filename, thumbCreated ? thumbFilename : null,
    metadata.prompt || '', metadata.negativePrompt || '',
    metadata.provider || '', metadata.model || '',
    metadata.width || 0, metadata.height || 0,
    fileSize, timestamp
  );

  // Enforce cap
  enforceCap(storyId, 'image', IMAGE_CAP);

  console.log(`${LOG_PREFIX} Saved image ${id} for story ${storyId}`);
  return { id, filename };
}

// ---------------------------------------------------------------------------
// Save video
// ---------------------------------------------------------------------------

function saveVideo(storyId, videoDataUrl, metadata = {}) {
  const id = generateId();
  const dir = getStoryDir(storyId);
  const timestamp = Date.now();
  const rand = Math.random().toString(36).slice(2, 6);
  const filename = `vid_${timestamp}_${rand}.mp4`;

  // Decode base64 data URL to buffer
  const base64Data = videoDataUrl.replace(/^data:video\/\w+;base64,/, '');
  const videoBuffer = Buffer.from(base64Data, 'base64');

  fs.writeFileSync(path.join(dir, filename), videoBuffer);
  const fileSize = videoBuffer.length;

  dbInstance.prepare(`
    INSERT INTO media_items (id, story_id, type, filename, thumb_filename, prompt, negative_prompt, provider, model, width, height, file_size, created_at)
    VALUES (?, ?, 'video', ?, NULL, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(
    id, storyId, filename,
    metadata.prompt || '', metadata.negativePrompt || '',
    metadata.provider || '', metadata.model || '',
    metadata.width || 0, metadata.height || 0,
    fileSize, timestamp
  );

  enforceCap(storyId, 'video', VIDEO_CAP);

  console.log(`${LOG_PREFIX} Saved video ${id} for story ${storyId}`);
  return { id, filename };
}

// ---------------------------------------------------------------------------
// Cap enforcement
// ---------------------------------------------------------------------------

function enforceCap(storyId, type, cap) {
  const count = dbInstance.prepare(
    'SELECT COUNT(*) as cnt FROM media_items WHERE story_id = ? AND type = ?'
  ).get(storyId, type).cnt;

  if (count <= cap) return;

  const excess = count - cap;
  const oldest = dbInstance.prepare(
    'SELECT id, filename, thumb_filename FROM media_items WHERE story_id = ? AND type = ? ORDER BY created_at ASC LIMIT ?'
  ).all(storyId, type, excess);

  const dir = getStoryDir(storyId);
  for (const item of oldest) {
    const filePath = path.join(dir, item.filename);
    if (fs.existsSync(filePath)) fs.unlinkSync(filePath);
    if (item.thumb_filename) {
      const thumbPath = path.join(dir, item.thumb_filename);
      if (fs.existsSync(thumbPath)) fs.unlinkSync(thumbPath);
    }
  }
  // Batch delete rows
  const ids = oldest.map(item => item.id);
  const placeholders = ids.map(() => '?').join(',');
  dbInstance.prepare(`DELETE FROM media_items WHERE id IN (${placeholders})`).run(...ids);

  console.log(`${LOG_PREFIX} Enforced ${type} cap: removed ${excess} oldest items`);
}

// ---------------------------------------------------------------------------
// Query
// ---------------------------------------------------------------------------

function listMedia(storyId, opts = {}) {
  let sql = 'SELECT id, story_id, type, filename, thumb_filename, prompt, negative_prompt, provider, model, width, height, file_size, created_at FROM media_items WHERE story_id = ?';
  const params = [storyId];

  if (opts.type && opts.type !== 'all') {
    sql += ' AND type = ?';
    params.push(opts.type);
  }

  sql += ' ORDER BY created_at DESC';
  return dbInstance.prepare(sql).all(...params);
}

function getFullImage(storyId, mediaId) {
  const row = dbInstance.prepare('SELECT filename FROM media_items WHERE id = ? AND story_id = ?').get(mediaId, storyId);
  if (!row) return null;
  const filePath = path.join(getStoryDir(storyId), row.filename);
  if (!fs.existsSync(filePath)) return null;
  const buf = fs.readFileSync(filePath);
  return 'data:image/png;base64,' + buf.toString('base64');
}

function getThumbnail(storyId, mediaId) {
  const row = dbInstance.prepare('SELECT thumb_filename FROM media_items WHERE id = ? AND story_id = ?').get(mediaId, storyId);
  if (!row || !row.thumb_filename) return null;
  const filePath = path.join(getStoryDir(storyId), row.thumb_filename);
  if (!fs.existsSync(filePath)) return null;
  const buf = fs.readFileSync(filePath);
  return 'data:image/png;base64,' + buf.toString('base64');
}

function getVideo(storyId, mediaId) {
  const row = dbInstance.prepare('SELECT filename FROM media_items WHERE id = ? AND story_id = ?').get(mediaId, storyId);
  if (!row) return null;
  const filePath = path.join(getStoryDir(storyId), row.filename);
  if (!fs.existsSync(filePath)) return null;
  const buf = fs.readFileSync(filePath);
  return 'data:video/mp4;base64,' + buf.toString('base64');
}

function deleteMedia(storyId, mediaId) {
  const row = dbInstance.prepare('SELECT filename, thumb_filename FROM media_items WHERE id = ? AND story_id = ?').get(mediaId, storyId);
  if (!row) return { success: false };

  const dir = getStoryDir(storyId);
  const filePath = path.join(dir, row.filename);
  if (fs.existsSync(filePath)) fs.unlinkSync(filePath);
  if (row.thumb_filename) {
    const thumbPath = path.join(dir, row.thumb_filename);
    if (fs.existsSync(thumbPath)) fs.unlinkSync(thumbPath);
  }

  dbInstance.prepare('DELETE FROM media_items WHERE id = ?').run(mediaId);
  console.log(`${LOG_PREFIX} Deleted media ${mediaId}`);
  return { success: true };
}

function getMediaCount(storyId) {
  const row = dbInstance.prepare(`
    SELECT
      SUM(CASE WHEN type = 'image' THEN 1 ELSE 0 END) as images,
      SUM(CASE WHEN type = 'video' THEN 1 ELSE 0 END) as videos
    FROM media_items WHERE story_id = ?
  `).get(storyId);
  return { images: row?.images || 0, videos: row?.videos || 0 };
}

module.exports = {
  init,
  saveImage,
  saveVideo,
  listMedia,
  getFullImage,
  getThumbnail,
  getVideo,
  deleteMedia,
  getMediaCount,
};
