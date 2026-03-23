'use strict';

const { generateId } = require('./shared-utils');

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

module.exports = {
  TIMELINE_STATE_DEFAULTS,
  BOUNDARY_TYPES,
  MAX_SCAN_HISTORY,
};
