'use strict';

const fs = require('node:fs');
const path = require('node:path');

class FontManager {
  constructor(options = {}) {
    this.fontFiles = options.fontFiles || {};
    this.fallbackFont = options.fallbackFont || null;
    this.cache = new Map();
    this.fontkit = null;
    try { this.fontkit = require('fontkit'); } catch (_) { /* font metrics remain optional */ }
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
    const requested = this.loadFont(this.fontFiles[requestedFace]);
    if (requested && requested.glyphForCodePoint(codePoint).id !== 0) return requested;
    const fallback = this.loadFont(this.fallbackFont);
    if (fallback && fallback.glyphForCodePoint(codePoint).id !== 0) return fallback;
    return requested || fallback;
  }

  measure(text, fontSizePt, requestedFace) {
    if (!this.fontkit || !text) return null;
    const runs = [];
    for (const char of Array.from(String(text))) {
      const font = this.fontForCodePoint(char.codePointAt(0), requestedFace);
      if (!font || font.glyphForCodePoint(char.codePointAt(0)).id === 0) return null;
      const previous = runs[runs.length - 1];
      if (previous && previous.font === font) previous.text += char;
      else runs.push({ font, text: char });
    }

    let width = 0;
    for (const run of runs) {
      const shaped = run.font.layout(run.text);
      const advance = shaped.positions.reduce((sum, position) => sum + position.xAdvance, 0);
      width += (advance / run.font.unitsPerEm) * fontSizePt;
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


// `line-height: normal` is a property of the typeface, not a constant: each face carries its
// own ascent, descent and line gap, and reading them is what makes an auto-height box reserve
// what the reader will actually draw. Measured against Chrome on this machine, the 1.25 estimate
// ran a few px short per CJK block and positions drifted cumulatively.
const METRIC_DIRECTORIES = process.platform === 'win32'
  ? ['C:/Windows/Fonts', process.env.WINDIR ? process.env.WINDIR.replace(/\\$/u, '') + '/Fonts' : null]
  : ['/usr/share/fonts', '/Library/Fonts', '/System/Library/Fonts'];

const normalLineCache = new Map();

let registryMap = null;

/**
 * Windows keeps the family-to-file table in the registry; the file names are abbreviations
 * (`Microsoft YaHei` lives in `msyh.ttc`), so guessing them from the family name fails. The
 * `&`-joined collection display names are split so either name finds the file.
 */
function fontFamilyFiles() {
  if (registryMap) return registryMap;
  registryMap = new Map();
  if (process.platform !== 'win32') return registryMap;
  try {
    const { execFileSync } = require('node:child_process');
    const os = require('node:os');
    // A script file, not -Command: passing the pipeline inline through two quoting layers ate
    // the `$_` variables and the table came back empty.
    const script = [
      "$k = [Microsoft.Win32.Registry]::LocalMachine.OpenSubKey('SOFTWARE\\Microsoft\\Windows NT\\CurrentVersion\\Fonts')",
      'if ($k) { $k.GetValueNames() | ForEach-Object { "$($_)|$($k.GetValue($_))" } }'
    ].join('\r\n');
    const scriptPath = path.join(os.tmpdir(), 'dsh-font-table.ps1');
    fs.writeFileSync(scriptPath, script, 'utf8');
    let output = '';
    try {
      output = execFileSync('powershell', ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', scriptPath],
        { encoding: 'utf8', timeout: 15000 });
    } finally {
      try { fs.unlinkSync(scriptPath); } catch (_) { /* temp cleanup is best effort */ }
    }
    output.split(/\r?\n/u).forEach((line) => {
      const separator = line.lastIndexOf('|');
      if (separator < 0) return;
      const display = line.slice(0, separator).replace(/\s*\((?:True|Open)Type\)\s*$/iu, '').trim();
      const file = line.slice(separator + 1).trim();
      if (!display || !file) return;
      const styleMatch = display.match(/\s(Bold|Italic|Light|Black|Semibold)$/u);
      const family = (styleMatch ? display.slice(0, styleMatch.index) : display).toLowerCase();
      family.split(/\s*&\s*/u).forEach((name) => {
        const clean = name.trim().toLowerCase();
        if (clean && !registryMap.has(clean)) registryMap.set(clean, file);
      });
    });
  } catch (_) { /* the abbreviation guess below still applies */ }
  return registryMap;
}

/** Font file for a family: the registry table first, then the abbreviation guess. */
function fontFileFor(family) {
  const wanted = String(family || '').trim();
  if (!wanted) return null;
  const directories = METRIC_DIRECTORIES.filter(Boolean).filter((directory) => {
    try { return fs.existsSync(directory); } catch (_) { return false; }
  });
  const registered = fontFamilyFiles().get(wanted.toLowerCase());
  if (registered) {
    for (const directory of directories) {
      const candidate = directory + '/' + registered;
      try { if (fs.existsSync(candidate)) return candidate; } catch (_) { continue; }
    }
  }
  const lower = wanted.toLowerCase();
  for (const directory of directories) {
    let entries = [];
    try { entries = fs.readdirSync(directory); } catch (_) { continue; }
    const match = entries.find((entry) => {
      const lower = entry.toLowerCase();
      if (!/\.(ttf|otf|ttc)$/u.test(lower)) return false;
      return lower === wanted + '.ttf' || lower === wanted + '.otf' || lower === wanted + '.ttc'
        || lower.startsWith(wanted);
    });
    if (match) return directory + '/' + match;
  }
  return null;
}

/**
/**
 * `line-height: normal` for a face, in multiples of em. Fontkit reads the hhea metrics;
 * collections hand their first face. Returns null when the face does not exist here or its
 * metrics cannot be read - the caller decides what an unknown face means, because a wrong
 * guess (serif, 1.15) measured *smaller* than what readers fall back to.
 */
function normalLineHeight(family, fontkit) {
  const key = String(family || '').trim();
  if (!key) return null;
  if (normalLineCache.has(key)) return normalLineCache.get(key);
  let value = null;
  if (fontkit) {
    const file = fontFileFor(key);
    if (file) {
      try {
        const opened = fontkit.openSync(file);
        const font = opened && opened.fonts ? opened.fonts[0] : opened;
        if (font && font.unitsPerEm) value = (font.ascent - font.descent + font.lineGap) / font.unitsPerEm;
      } catch (_) { /* stays null */ }
    }
  }
  normalLineCache.set(key, value);
  return value;
}

module.exports = { FontManager, normalLineHeight };
