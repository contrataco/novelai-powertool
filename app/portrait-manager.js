/**
 * Portrait Manager — filesystem-based portrait storage with thumbnails.
 * Uses Electron nativeImage for thumbnail generation (no external deps).
 */

const { nativeImage } = require('electron');
const path = require('path');
const fs = require('fs');

const LOG_PREFIX = '[Portrait]';
const THUMB_SIZE = 128;

let portraitsBaseDir = null;

function init(userDataPath) {
  portraitsBaseDir = path.join(userDataPath, 'portraits');
  if (!fs.existsSync(portraitsBaseDir)) {
    fs.mkdirSync(portraitsBaseDir, { recursive: true });
  }
  console.log(`${LOG_PREFIX} Portraits dir: ${portraitsBaseDir}`);
}

function getStoryDir(storyId) {
  const dir = path.join(portraitsBaseDir, storyId);
  if (!fs.existsSync(dir)) {
    fs.mkdirSync(dir, { recursive: true });
  }
  return dir;
}

function getPortraitPath(storyId, characterId) {
  return path.join(getStoryDir(storyId), `${characterId}.png`);
}

function getThumbnailPath(storyId, characterId) {
  return path.join(getStoryDir(storyId), `${characterId}_thumb.png`);
}

function hasPortrait(storyId, characterId) {
  return fs.existsSync(getPortraitPath(storyId, characterId));
}

function savePortrait(storyId, characterId, imageBuffer) {
  const fullPath = getPortraitPath(storyId, characterId);
  fs.writeFileSync(fullPath, imageBuffer);

  // Generate thumbnail using Electron nativeImage
  try {
    const img = nativeImage.createFromBuffer(imageBuffer);
    const size = img.getSize();
    if (size.width > 0 && size.height > 0) {
      const thumb = img.resize({ width: THUMB_SIZE, height: THUMB_SIZE });
      fs.writeFileSync(getThumbnailPath(storyId, characterId), thumb.toPNG());
    }
  } catch (err) {
    console.error(`${LOG_PREFIX} Thumbnail generation failed:`, err.message);
  }

  console.log(`${LOG_PREFIX} Saved portrait for ${characterId} in story ${storyId}`);
}

function getPortraitAsBase64(storyId, characterId, thumbnail = false) {
  if (thumbnail) {
    const thumbPath = getThumbnailPath(storyId, characterId);
    const fullPath = getPortraitPath(storyId, characterId);
    // Lazy regeneration: if thumb missing or undersized, regenerate from full portrait
    const thumbExists = fs.existsSync(thumbPath);
    let needsRegen = !thumbExists;
    if (thumbExists && fs.existsSync(fullPath)) {
      try {
        const existing = nativeImage.createFromPath(thumbPath);
        const sz = existing.getSize();
        if (sz.width > 0 && sz.width < THUMB_SIZE) needsRegen = true;
      } catch (_) { needsRegen = true; }
    }
    if (needsRegen && fs.existsSync(fullPath)) {
      try {
        const img = nativeImage.createFromPath(fullPath);
        const size = img.getSize();
        if (size.width > 0 && size.height > 0) {
          const thumb = img.resize({ width: THUMB_SIZE, height: THUMB_SIZE });
          fs.writeFileSync(thumbPath, thumb.toPNG());
          console.log(`${LOG_PREFIX} Regenerated thumbnail for ${characterId}`);
        }
      } catch (err) {
        console.error(`${LOG_PREFIX} Thumbnail regen failed:`, err.message);
      }
    }
    if (!fs.existsSync(thumbPath)) return null;
    return fs.readFileSync(thumbPath).toString('base64');
  }

  const filePath = getPortraitPath(storyId, characterId);
  if (!fs.existsSync(filePath)) return null;
  return fs.readFileSync(filePath).toString('base64');
}

function deletePortrait(storyId, characterId) {
  const fullPath = getPortraitPath(storyId, characterId);
  const thumbPath = getThumbnailPath(storyId, characterId);
  if (fs.existsSync(fullPath)) fs.unlinkSync(fullPath);
  if (fs.existsSync(thumbPath)) fs.unlinkSync(thumbPath);
  console.log(`${LOG_PREFIX} Deleted portrait for ${characterId}`);
}

// ---------------------------------------------------------------------------
// Album — multiple images per character
// ---------------------------------------------------------------------------

const ALBUM_THUMB_SIZE = 128;
const ALBUM_CAP = 20;

function getAlbumDir(storyId, characterId) {
  const dir = path.join(getStoryDir(storyId), `${characterId}_album`);
  if (!fs.existsSync(dir)) {
    fs.mkdirSync(dir, { recursive: true });
  }
  return dir;
}

/**
 * Save an image to a character's album. Returns the album entry id.
 * Also auto-saves to album when savePortrait is called (see savePortraitAndAlbum).
 */
function saveToAlbum(storyId, characterId, imageBuffer) {
  const dir = getAlbumDir(storyId, characterId);
  const id = Date.now() + '_' + Math.random().toString(36).slice(2, 6);
  const filename = `${id}.png`;
  const thumbFilename = `${id}_thumb.png`;

  fs.writeFileSync(path.join(dir, filename), imageBuffer);

  try {
    const img = nativeImage.createFromBuffer(imageBuffer);
    const size = img.getSize();
    if (size.width > 0 && size.height > 0) {
      const thumb = img.resize({ width: ALBUM_THUMB_SIZE, height: ALBUM_THUMB_SIZE });
      fs.writeFileSync(path.join(dir, thumbFilename), thumb.toPNG());
    }
  } catch (err) {
    console.error(`${LOG_PREFIX} Album thumbnail failed:`, err.message);
  }

  // Enforce cap — remove oldest if over limit
  enforceAlbumCap(dir);

  console.log(`${LOG_PREFIX} Saved album image ${id} for ${characterId}`);
  return id;
}

function enforceAlbumCap(dir) {
  const files = fs.readdirSync(dir)
    .filter(f => f.endsWith('.png') && !f.includes('_thumb'))
    .sort(); // timestamp-based names sort chronologically
  if (files.length > ALBUM_CAP) {
    const toRemove = files.slice(0, files.length - ALBUM_CAP);
    for (const f of toRemove) {
      const full = path.join(dir, f);
      const thumb = path.join(dir, f.replace('.png', '_thumb.png'));
      if (fs.existsSync(full)) fs.unlinkSync(full);
      if (fs.existsSync(thumb)) fs.unlinkSync(thumb);
    }
    console.log(`${LOG_PREFIX} Album cap enforced — removed ${toRemove.length} oldest images`);
  }
}

/**
 * List album entries for a character. Returns [{id, thumbnailData}] sorted newest-first.
 */
function listAlbum(storyId, characterId) {
  const dir = getAlbumDir(storyId, characterId);
  if (!fs.existsSync(dir)) return [];

  const files = fs.readdirSync(dir)
    .filter(f => f.endsWith('.png') && !f.includes('_thumb'))
    .sort()
    .reverse(); // newest first

  return files.map(f => {
    const id = f.replace('.png', '');
    const thumbPath = path.join(dir, `${id}_thumb.png`);
    let thumbnailData = null;
    if (fs.existsSync(thumbPath)) {
      thumbnailData = fs.readFileSync(thumbPath).toString('base64');
    }
    return { id, thumbnailData };
  });
}

/**
 * Get a full-size album image as base64.
 */
function getAlbumImage(storyId, characterId, imageId) {
  const filePath = path.join(getAlbumDir(storyId, characterId), `${imageId}.png`);
  if (!fs.existsSync(filePath)) return null;
  return fs.readFileSync(filePath).toString('base64');
}

/**
 * Delete an album image.
 */
function deleteAlbumImage(storyId, characterId, imageId) {
  const dir = getAlbumDir(storyId, characterId);
  const full = path.join(dir, `${imageId}.png`);
  const thumb = path.join(dir, `${imageId}_thumb.png`);
  if (fs.existsSync(full)) fs.unlinkSync(full);
  if (fs.existsSync(thumb)) fs.unlinkSync(thumb);
  console.log(`${LOG_PREFIX} Deleted album image ${imageId} for ${characterId}`);
}

/**
 * Set an album image as the active portrait.
 */
function setActiveFromAlbum(storyId, characterId, imageId) {
  const albumPath = path.join(getAlbumDir(storyId, characterId), `${imageId}.png`);
  if (!fs.existsSync(albumPath)) return false;
  const imageBuffer = fs.readFileSync(albumPath);
  savePortrait(storyId, characterId, imageBuffer);
  return true;
}

module.exports = {
  init,
  getPortraitPath,
  getThumbnailPath,
  hasPortrait,
  savePortrait,
  getPortraitAsBase64,
  deletePortrait,
  // Album
  saveToAlbum,
  listAlbum,
  getAlbumImage,
  deleteAlbumImage,
  setActiveFromAlbum,
};
