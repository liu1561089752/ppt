'use strict';

const fs = require('node:fs');
const path = require('node:path');

/**
 * A metric face, from a single font file or from a collection (`.ttc`).
 *
 * A collection exposes its faces as `fonts` (or `getFonts()`); the collection object itself has no
 * `layout`. Treating it as a face made every measurement throw, the throw was read as "no metrics",
 * and a correctly declared `msyh.ttc` therefore measured nothing at all.
 */
function pickFace(opened) {
  if (!opened) return null;
  const usable = (candidate) => !!candidate
    && typeof candidate.layout === 'function' && typeof candidate.glyphForCodePoint === 'function';
  if (usable(opened)) return opened;
  // fontkit exposes a collection's faces as `.fonts`; `getFonts()` exists on some builds and is
  // empty on others, so take whichever actually yields faces instead of trusting the method name.
  let faces = [];
  if (Array.isArray(opened.fonts) && opened.fonts.length) faces = opened.fonts;
  if (!faces.length && typeof opened.getFonts === 'function') {
    const listed = opened.getFonts();
    if (Array.isArray(listed)) faces = listed;
  }
  if (!Array.isArray(faces)) return null;
  return faces.find(usable) || null;
}

class FontManager {
  constructor(options = {}) {
    this.fontFiles = options.fontFiles || {};
    this.fallbackFont = options.fallbackFont || null;
    // A deck names a family ("Microsoft YaHei"); the file is a system fact ("msyh.ttc"), and nobody
    // can guess it from the name. 25 pages were measured from an estimate on a machine that had the
    // face installed all along, purely because the spec did not repeat the file path. So resolve the
    // family here unless the caller asked for the estimate (`discoverFaces: false`, or
    // `NATIVE_FONT_DISCOVERY=0` for a reproducible build that must not read the host's fonts).
    this.discoverFaces = options.discoverFaces !== false && process.env.NATIVE_FONT_DISCOVERY !== '0';
    this.cache = new Map();
    // How many measurements came from a real face and how many fell back to the glyph-width
    // estimate. `inspect()` used to report only that fontkit was installed, which reads like
    // "metrics are exact" even on a machine that has no file for the declared face and measured
    // nothing at all: that is how a cover title broke one line later than estimated, unseen.
    this.measuredCalls = 0;
    this.estimatedCalls = 0;
    this.fontkit = null;
    try { this.fontkit = require('fontkit'); } catch (_) { /* font metrics remain optional */ }
  }

  loadFont(filePath) {
    if (!filePath || !this.fontkit) return null;
    const absolute = path.resolve(filePath);
    if (this.cache.has(absolute)) return this.cache.get(absolute);
    if (!fs.existsSync(absolute)) return null;
    try {
      const opened = this.fontkit.openSync(absolute);
      // A family on Windows ships as a `.ttc` collection more often than as a single `.ttf`, and
      // fontkit hands a collection back as an object with no glyph API of its own. Taking it as a
      // font made every `glyphForCodePoint` call throw, the throw was swallowed as "no metrics",
      // and a correctly declared `msyh.ttc` silently fell back to the estimate. Pick a real face.
      const font = pickFace(opened);
      if (!font) return null;
      this.cache.set(absolute, font);
      return font;
    } catch (_) {
      return null;
    }
  }

  /**
   * The file a family means: what the spec declared, else what the system says. A declared path
   * always wins, so a deck can pin an exact file and stop depending on the machine.
   */
  fileForFace(family) {
    if (!family) return null;
    const declared = this.fontFiles[family];
    if (declared) return declared;
    if (!this.discoverFaces) return null;
    return fontFileFor(family);
  }

  fontForCodePoint(codePoint, requestedFace) {
    const requested = this.loadFont(this.fileForFace(requestedFace));
    if (requested && requested.glyphForCodePoint(codePoint).id !== 0) return requested;
    const fallback = this.loadFont(this.fallbackFont);
    if (fallback && fallback.glyphForCodePoint(codePoint).id !== 0) return fallback;
    return requested || fallback;
  }

  measure(text, fontSizePt, requestedFace) {
    if (!this.fontkit || !text) { this.estimatedCalls += 1; return null; }
    const runs = [];
    for (const char of Array.from(String(text))) {
      const font = this.fontForCodePoint(char.codePointAt(0), requestedFace);
      if (!font || font.glyphForCodePoint(char.codePointAt(0)).id === 0) { this.estimatedCalls += 1; return null; }
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
    this.measuredCalls += 1;
    return width;
  }

  inspect() {
    return {
      fontkitAvailable: !!this.fontkit,
      configuredFaces: Object.keys(this.fontFiles),
      discoveredFaces: this.discoverFaces,
      loadedFiles: Array.from(this.cache.keys()),
      measuredCalls: this.measuredCalls,
      estimatedCalls: this.estimatedCalls
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
        const font = pickFace(opened);
        if (font && font.unitsPerEm) value = (font.ascent - font.descent + font.lineGap) / font.unitsPerEm;
      } catch (_) { /* stays null */ }
    }
  }
  normalLineCache.set(key, value);
  return value;
}

module.exports = { FontManager, normalLineHeight, fontFileForFamily: fontFileFor, pickFace };
