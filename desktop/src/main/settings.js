'use strict';

// Settings store. Mirrors NotchSettings.swift: the same keys, options and
// defaults, saved as JSON in the app's user data folder.

const fs = require('fs');
const path = require('path');
const { EventEmitter } = require('events');

const OPTIONS = {
  overlayMode: ['pinned', 'floating', 'fullscreen'],
  notchDisplayMode: ['followMouse', 'fixedDisplay'],
  listeningMode: ['wordTracking', 'classic', 'silencePaused'],
  fontSizePreset: ['xs', 'sm', 'lg', 'xl'],
  fontFamilyPreset: ['sans', 'serif', 'mono', 'dyslexia'],
  fontColorPreset: ['white', 'yellow', 'green', 'blue', 'pink', 'orange'],
  cueColorPreset: ['white', 'yellow', 'green', 'blue', 'pink', 'orange'],
  cueBrightness: ['dim', 'low', 'medium', 'bright'],
  externalDisplayMode: ['off', 'teleprompter', 'mirror'],
  mirrorAxis: ['horizontal', 'vertical', 'both'],
  readingPosition: ['centered', 'nearTop'],
};

const RANGES = {
  notchWidth: [310, 500],
  textAreaHeight: [100, 400],
  glassOpacity: [0, 0.6],
  overlayTransparencyOpacity: [0, 0.9],
  scrollSpeed: [0.5, 8],
  fullscreenFontScale: [1, 4],
  browserServerPort: [1024, 65534],
  directorServerPort: [1024, 65534],
};

const DEFAULTS = {
  notchWidth: 340,
  textAreaHeight: 150,
  speechModel: 'en-20M',
  fontSizePreset: 'lg',
  fontFamilyPreset: 'sans',
  fontColorPreset: 'white',
  cueColorPreset: 'white',
  cueBrightness: 'dim',
  overlayMode: 'pinned',
  notchDisplayMode: 'followMouse',
  pinnedScreenID: 0,
  floatingGlassEffect: false,
  glassOpacity: 0.15,
  overlayTransparency: false,
  overlayTransparencyOpacity: 0.5,
  followCursorWhenUndocked: false,
  externalDisplayMode: 'off',
  externalScreenID: 0,
  mirrorAxis: 'horizontal',
  listeningMode: 'wordTracking',
  scrollSpeed: 3,
  hideFromScreenShare: true,
  showElapsedTime: true,
  keepScreenAwake: false,
  remoteControl: true,
  readingPosition: 'centered',
  showParagraphDividers: false,
  showLastSpokenWords: true,
  selectedMicId: '',
  autoNextPage: false,
  autoNextPageDelay: 3,
  fullscreenScreenID: 0,
  fullscreenFontScale: 2.5,
  browserServerEnabled: false,
  browserServerPort: 7373,
  directorModeEnabled: false,
  directorServerPort: 7575,
  lastDocumentDirectory: '',
};

const FONT_SIZES = { xs: 14, sm: 16, lg: 20, xl: 24 };

const FONT_COLORS = {
  white: '#ffffff',
  yellow: 'rgb(255,214,10)',
  green: 'rgb(51,214,74)',
  blue: 'rgb(79,140,255)',
  pink: 'rgb(255,97,145)',
  orange: 'rgb(255,158,10)',
};

// [unreadOpacity, readOpacity]
const CUE_BRIGHTNESS = {
  dim: [0.2, 0.5],
  low: [0.35, 0.6],
  medium: [0.5, 0.7],
  bright: [0.8, 1.0],
};

function sanitize(key, value) {
  if (!(key in DEFAULTS)) return undefined;
  const fallback = DEFAULTS[key];
  if (OPTIONS[key]) return OPTIONS[key].includes(value) ? value : undefined;
  if (RANGES[key]) {
    const n = Number(value);
    if (!Number.isFinite(n)) return undefined;
    const [lo, hi] = RANGES[key];
    const clamped = Math.min(hi, Math.max(lo, n));
    return key.endsWith('Port') ? Math.round(clamped) : clamped;
  }
  if (key === 'autoNextPageDelay') return [0, 1, 3, 5].includes(Number(value)) ? Number(value) : undefined;
  if (typeof fallback === 'boolean') return typeof value === 'boolean' ? value : undefined;
  if (typeof fallback === 'number') return Number.isFinite(Number(value)) ? Number(value) : undefined;
  if (typeof fallback === 'string') return typeof value === 'string' ? value : undefined;
  return undefined;
}

class Settings extends EventEmitter {
  constructor(dir) {
    super();
    this.file = path.join(dir, 'settings.json');
    this.values = { ...DEFAULTS };
    try {
      const saved = JSON.parse(fs.readFileSync(this.file, 'utf8'));
      for (const [k, v] of Object.entries(saved)) {
        const clean = sanitize(k, v);
        if (clean !== undefined) this.values[k] = clean;
      }
    } catch (e) {
      // First launch, or an unreadable file: start from defaults.
    }
  }

  get(key) {
    return this.values[key];
  }

  all() {
    return { ...this.values };
  }

  /// Apply a partial update. Returns the keys that changed.
  set(patch) {
    const changed = [];
    for (const [k, v] of Object.entries(patch || {})) {
      const clean = sanitize(k, v);
      if (clean === undefined || clean === this.values[k]) continue;
      this.values[k] = clean;
      changed.push(k);
    }
    if (changed.length) {
      this.save();
      this.emit('change', changed, this.all());
    }
    return changed;
  }

  save() {
    try {
      fs.mkdirSync(path.dirname(this.file), { recursive: true });
      fs.writeFileSync(this.file, JSON.stringify(this.values, null, 2));
    } catch (e) {
      console.error('Could not save settings', e);
    }
  }
}

/// Style values every prompter view needs, derived from settings.
function viewStyle(values) {
  const [cueUnread, cueRead] = CUE_BRIGHTNESS[values.cueBrightness] || CUE_BRIGHTNESS.dim;
  return {
    fontSize: FONT_SIZES[values.fontSizePreset] || 20,
    fontFamily: values.fontFamilyPreset,
    fontColor: FONT_COLORS[values.fontColorPreset] || '#ffffff',
    cueColor: FONT_COLORS[values.cueColorPreset] || '#ffffff',
    cueUnreadOpacity: cueUnread,
    cueReadOpacity: cueRead,
    readingPosition: values.readingPosition,
    showParagraphDividers: values.showParagraphDividers,
    showLastSpokenWords: values.showLastSpokenWords,
    showElapsedTime: values.showElapsedTime,
    mirrorAxis: values.mirrorAxis,
    fullscreenFontScale: values.fullscreenFontScale,
    glass: values.floatingGlassEffect,
    glassOpacity: values.glassOpacity,
    transparency: values.overlayTransparency,
    transparencyOpacity: values.overlayTransparencyOpacity,
    followCursor: values.followCursorWhenUndocked,
  };
}

module.exports = { Settings, DEFAULTS, OPTIONS, RANGES, FONT_COLORS, viewStyle, sanitize };
