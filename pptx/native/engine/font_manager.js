'use strict';

const fs = require('node:fs');
const path = require('node:path');

class FontManager {
  constructor(options = {}) {
    this.fontFiles = options.fontFiles || {};
    this.fallbackFont = options.fallbackFont || null;
    this.cache = new Map();
    this.fontkit = null;
    try { this.fontkit = require('fontkit'); } catch (_) { /* optional until fontkit is installed */ }
  }

  loadFont(filePath) {
    if (!filePath || !this.fontkit) return null;
    const absolute = path.resolve(filePath);
    if (this.cache.has(absolute)) return this.cache.get(absolute);
    if (!fs.existsSync(absolute)) return null;
    try {
      const font = this.fontkit.openSync(absolute);
      this.cache.set(absolute, font);
      return font;
    } catch (_) {
      return null;
    }
  }

  fontForCodePoint(codePoint, requestedFace) {
    const requestedPath = this.fontFiles[requestedFace];
    const requested = this.loadFont(requestedPath);
    if (requested && requested.glyphForCodePoint(codePoint).id !== 0) return requested;
    const fallback = this.loadFont(this.fallbackFont);
    if (fallback && fallback.glyphForCodePoint(codePoint).id !== 0) return fallback;
    return requested || fallback;
  }

  measure(text, fontSizePt, requestedFace) {
    if (!this.fontkit || !text) return null;
    let width = 0;
    for (const char of Array.from(String(text))) {
      const font = this.fontForCodePoint(char.codePointAt(0), requestedFace);
      if (!font) return null;
      const glyph = font.glyphForCodePoint(char.codePointAt(0));
      if (!glyph || glyph.id === 0) return null;
      width += (glyph.advanceWidth / font.unitsPerEm) * fontSizePt;
    }
    return width;
  }

  inspect() {
    return {
      fontkitAvailable: !!this.fontkit,
      configuredFaces: Object.keys(this.fontFiles),
      loadedFiles: Array.from(this.cache.keys())
    };
  }
}

module.exports = { FontManager };
