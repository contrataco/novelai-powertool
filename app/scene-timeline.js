'use strict';

const { generateId } = require('./shared-utils');

const EXPLICIT_BREAK_REGEX = /\n\s*(\*\s*\*\s*\*|\*{3,}|-{3,}|={3,})\s*\n/g;
const CHAPTER_HEADER_REGEX = /\n\s*(Chapter\s+\d+|CHAPTER\s+\d+|Part\s+\d+|Act\s+\d+)[^\n]*/gi;
const TIME_SKIP_REGEX = /(?:^|\n\n)\s*((?:The next|That|Three|Two|Several|A few|Many|Some)\s+(?:morning|evening|night|day|days|weeks|months|hours|years)\s+later|(?:Hours|Days|Weeks|Months|Years)\s+(?:later|passed|went by)|When\s+(?:they|she|he|we|I)\s+(?:arrived|returned|woke|came))/gi;

const TIMELINE_STATE_DEFAULTS = {
  version: 1,
  scenes: [],
  chapters: [],
  lastProcessedLength: 0,
  lastProcessedHash: '',
  scanHistory: [],
  settings: {
    autoDetect: true,
    minSceneLength: 500,
    chapterGrouping: true,
  },
};

const BOUNDARY_TYPES = [
  'location-change', 'time-skip', 'pov-shift',
  'dramatic-shift', 'chapter-break', 'explicit-break',
];

const MAX_SCAN_HISTORY = 10;

function simpleHash(str) {
  return str.split('').reduce((h, c) => ((h << 5) - h + c.charCodeAt(0)) | 0, 0).toString(36);
}

function detectBoundariesHeuristic(storyText) {
  const boundaries = [];

  // Explicit break markers (*** / --- / ===)
  let match;
  EXPLICIT_BREAK_REGEX.lastIndex = 0;
  while ((match = EXPLICIT_BREAK_REGEX.exec(storyText)) !== null) {
    boundaries.push({
      offset: match.index,
      type: 'explicit-break',
      confidence: 0.95,
      source: 'heuristic',
    });
  }

  // Chapter / part / act headers
  CHAPTER_HEADER_REGEX.lastIndex = 0;
  while ((match = CHAPTER_HEADER_REGEX.exec(storyText)) !== null) {
    boundaries.push({
      offset: match.index,
      type: 'chapter-break',
      confidence: 0.95,
      source: 'heuristic',
      chapterTitle: match[1].trim(),
    });
  }

  // Time-skip phrases
  TIME_SKIP_REGEX.lastIndex = 0;
  while ((match = TIME_SKIP_REGEX.exec(storyText)) !== null) {
    boundaries.push({
      offset: match.index,
      type: 'time-skip',
      confidence: 0.7,
      source: 'heuristic',
    });
  }

  // Sort by offset
  boundaries.sort((a, b) => a.offset - b.offset);

  // Deduplicate: boundaries within 200 chars of each other → keep highest confidence
  const deduped = [];
  for (const b of boundaries) {
    const prev = deduped[deduped.length - 1];
    if (prev && b.offset - prev.offset < 200) {
      if (b.confidence > prev.confidence) {
        deduped[deduped.length - 1] = b;
      }
      // else discard b
    } else {
      deduped.push(b);
    }
  }

  return deduped;
}

function segmentIntoScenes(storyText, boundaries) {
  const minLength = TIMELINE_STATE_DEFAULTS.settings.minSceneLength;

  // Build segment start/end pairs
  // Each boundary marks the start of a new segment
  const segmentStarts = [0, ...boundaries.map(b => b.offset)];

  const rawSegments = segmentStarts.map((start, i) => {
    const end = i + 1 < segmentStarts.length ? segmentStarts[i + 1] : storyText.length;
    const boundary = i > 0 ? boundaries[i - 1] : null;
    return { start, end, boundary };
  });

  // Merge short segments into the previous one
  const merged = [];
  for (const seg of rawSegments) {
    const length = seg.end - seg.start;
    if (length < minLength && merged.length > 0) {
      // Extend previous segment's end
      merged[merged.length - 1].end = seg.end;
    } else {
      merged.push({ ...seg });
    }
  }

  return merged.map((seg, index) => ({
    id: generateId('scene'),
    order: index,
    chapterId: null,
    textStart: seg.start,
    textEnd: seg.end,
    textHash: simpleHash(storyText.slice(seg.start, seg.start + 100)),
    excerpt: storyText.slice(seg.start, seg.start + 200).trim(),
    boundaryExcerpt: storyText.slice(seg.start, seg.start + 50).trim(),
    description: null,
    location: null,
    timeOfDay: null,
    mood: null,
    tone: null,
    weather: null,
    keyEvents: [],
    characters: [],
    boundaryType: seg.boundary ? seg.boundary.type : 'explicit-break',
    boundaryConfidence: seg.boundary ? seg.boundary.confidence : 0.5,
    status: 'tentative',
    imageId: null,
    promptData: null,
    detectedAt: Date.now(),
    updatedAt: Date.now(),
  }));
}

module.exports = {
  TIMELINE_STATE_DEFAULTS,
  BOUNDARY_TYPES,
  MAX_SCAN_HISTORY,
  detectBoundariesHeuristic,
  segmentIntoScenes,
};
