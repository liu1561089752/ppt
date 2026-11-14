'use strict';

const fs = require('node:fs');

/**
 * Image fit geometry.
 *
 * PptxGenJS 3.12 `sizing` cannot express what a design-driven deck needs:
 * `contain` emits negative `<a:srcRect>` values for every non-matching aspect
 * ratio, and `crop` shrinks the picture extent instead of filling the frame.
 * This module therefore computes the geometry itself and the writer patches
 * `<a:srcRect>` / `<a:prstGeom>` / `<a:ln>` / `<a:effectLst>` into the slide XML.
 *
 * All crop fractions are expressed as a share of the *source* image, matching
 * OOXML `a:srcRect` semantics. Geometry boxes are in inches.
 */

const EMU_PER_INCH = 914400;
const EMU_PER_POINT = 12700;
const PX_PER_INCH = 96;

const FIT_MODES = new Set(['stretch', 'cover', 'contain', 'crop', 'none', 'scale-down']);

const FOCUS_PRESETS = new Map([
  ['center', { x: 0.5, y: 0.5 }],
  ['centre', { x: 0.5, y: 0.5 }],
  ['middle', { x: 0.5, y: 0.5 }],
  ['top', { x: 0.5, y: 0 }],
  ['bottom', { x: 0.5, y: 1 }],
  ['left', { x: 0, y: 0.5 }],
  ['right', { x: 1, y: 0.5 }],
  ['top left', { x: 0, y: 0 }],
  ['top right', { x: 1, y: 0 }],
  ['bottom left', { x: 0, y: 1 }],
  ['bottom right', { x: 1, y: 1 }],
  ['left top', { x: 0, y: 0 }],
  ['right top', { x: 1, y: 0 }],
  ['left bottom', { x: 0, y: 1 }],
  ['right bottom', { x: 1, y: 1 }]
]);

function clamp(value, min, max) {
  return Math.min(max, Math.max(min, value));
}

function normalizeFit(fit) {
  if (fit === undefined || fit === null || fit === '') return 'stretch';
  const value = String(fit).trim().toLowerCase();
  if (value === 'fill' || value === 'stretch') return 'stretch';
  if (value === 'none') return 'none';
  if (value === 'scale-down' || value === 'scaledown') return 'scale-down';
  if (!FIT_MODES.has(value)) {
    throw new Error('Unsupported image fit "' + fit + '"; expected cover, contain, crop, or stretch');
  }
  return value;
}

function normalizeFocus(focus, context = null) {
  if (focus === undefined || focus === null || focus === '') return { x: 0.5, y: 0.5 };
  if (typeof focus === 'string') {
    const key = focus.trim().toLowerCase().replace(/[-_]+/gu, ' ').replace(/\s+/gu, ' ');
    // Lengths need the box and the source size; without them the caller only has keywords.
    if (context && context.natural && context.box) {
      const tokens = key.split(' ').filter(Boolean);
      const looksLikeLengths = tokens.length <= 2 && tokens.every((token) => /^-?[\d.]+(px|pt|in|cm|mm)?$/u.test(token))
        && tokens.some((token) => /^-?[\d.]+$/u.test(token) || /(px|pt|in|cm|mm)$/u.test(token));
      if (looksLikeLengths) {
        // The preset key has its hyphens flattened to spaces, so the offsets are read from
        // the string as written - a minus sign is a direction, not a separator.
        const lengths = focusFromLengths(String(focus).trim().split(/\s+/u).filter(Boolean),
          context.natural, context.box, context.fit);
        if (lengths) return lengths;
      }
    }
    const preset = FOCUS_PRESETS.get(key);
    if (!preset) throw new Error('Unknown image focus preset "' + focus + '"');
    return Object.assign({}, preset);
  }
  if (typeof focus === 'object' && !Array.isArray(focus)) {
    const x = Number(focus.x);
    const y = Number(focus.y);
    if (!Number.isFinite(x) || !Number.isFinite(y)) {
      throw new Error('Image focus object requires finite x and y in the 0..1 range');
    }
    return { x: clamp(x, 0, 1), y: clamp(y, 0, 1) };
  }
  throw new Error('Image focus must be a preset name or an { x, y } object');
}

/** A CSS length in inches (px is the default unit, as in the rest of the pipeline). */
function lengthInInches(token) {
  const match = /^(-?[\d.]+)(px|pt|in|cm|mm)?$/u.exec(String(token).trim());
  if (!match) return null;
  const value = Number(match[1]);
  if (!Number.isFinite(value)) return null;
  const per = { px: PX_PER_INCH, pt: 72, in: 1, cm: 2.54, mm: 25.4 }[match[2] || 'px'];
  return value / per;
}

/**
 * The size an object is really drawn at inside its slot, in inches: the same arithmetic every
 * fit mode uses. A length position is read against that drawn size, so the modes cannot drift
 * apart - `object-fit: none` at its own pixel size, `scale-down` as contain that never enlarges,
 * `cover` overflowing the slot by `drawn - box`.
 */
function fitDrawnSize(natural, box, fit) {
  const naturalW = natural.width / PX_PER_INCH;
  const naturalH = natural.height / PX_PER_INCH;
  if (fit === 'none') return { w: naturalW, h: naturalH };
  if (fit === 'cover') {
    const scale = Math.max(box.w / naturalW, box.h / naturalH);
    return { w: naturalW * scale, h: naturalH * scale };
  }
  let scale = Math.min(box.w / naturalW, box.h / naturalH);
  // `scale-down` is contain capped at the source's own size: 40x100 px draws 0.4167x1.0417in
  // at most, however much room the slot offers.
  if (fit === 'scale-down') scale = Math.min(scale, 1);
  return { w: naturalW * scale, h: naturalH * scale };
}

/**
 * `object-position: 10px 5px` is an offset from the box's top-left edge, not a percentage, so
 * it can only be read once the source size and the box are known.
 *
 * CSS `<position>` lengths are measured from the near edge: a positive length moves the object
 * right/down. A *contained* picture is therefore placed at that offset, so the focus is the
 * offset across the free space. A *cropped* picture already overflows its box, and the browser
 * answers a positive offset by pushing the object inward - a real gap at the near edge, with
 * the crop moving to the far edge - so the crop window starts at `max(0, -offset)`. That is
 * the clamp below: `a:srcRect` always fills the frame and cannot draw a gap, so the window
 * stops at the edge and the analyzer names the strip that the browser would have left blank.
 */
function focusFromLengths(tokens, natural, box, fit) {
  const xIn = lengthInInches(tokens[0]);
  const yIn = tokens.length > 1 ? lengthInInches(tokens[1]) : null;
  if (xIn === null || (tokens.length > 1 && yIn === null)) return null;
  const centre = 0.5;
  const drawn = fitDrawnSize(natural, box, fit);
  const fraction = (offset, drawnSize, boxSize) => {
    if (!Number.isFinite(drawnSize) || Math.abs(drawnSize - boxSize) < 1e-6) return centre;
    const value = drawnSize > boxSize
      ? Math.max(0, -offset) / (drawnSize - boxSize)
      : offset / (boxSize - drawnSize);
    return Math.min(1, Math.max(0, value));
  };
  return {
    x: fraction(xIn || 0, drawn.w, box.w),
    // One value leaves the other axis `center`, as CSS resolves `object-position: 10px`.
    y: yIn === null ? centre : fraction(yIn || 0, drawn.h, box.h)
  };
}

const TILE_POSITION_KEYWORDS = new Map([
  ['left', 0], ['top', 0], ['center', 0.5], ['centre', 0.5], ['right', 1], ['bottom', 1]
]);

/**
 * Where a tiled pattern's first cell starts, in inches from the box's top-left.
 *
 * `background-position` is not `object-position`: a repeating layer is *placed*, so a length is
 * the offset itself, and a keyword or percentage moves the pattern across the box's slack
 * (`(box - cell) * p`) - negative when the cell is bigger than the box, which is how a pattern
 * that starts before the box's corner is spelled. An undeclared position is `0% 0%`, the box's
 * corner, not the centred default `object-position` has.
 */
function tileOrigin(focus, box, tile) {
  const boxW = Number(box && box.w);
  const boxH = Number(box && box.h);
  const cellW = Number(tile && tile.width);
  const cellH = Number(tile && tile.height);
  if (![boxW, boxH, cellW, cellH].every(Number.isFinite) || boxW <= 0 || boxH <= 0 || cellW <= 0 || cellH <= 0) {
    throw new Error('A tile needs a positive cell size and a finite picture frame');
  }
  const zero = { kind: 'fraction', value: 0 };
  let x = zero;
  let y = zero;
  if (focus && typeof focus === 'object' && !Array.isArray(focus)) {
    x = { kind: 'fraction', value: Number(focus.x) };
    y = { kind: 'fraction', value: Number(focus.y) };
  } else if (typeof focus === 'string' && focus.trim()) {
    const tokens = focus.trim().toLowerCase().split(/\s+/u).filter(Boolean);
    const read = (token) => {
      const length = lengthInInches(token);
      if (length !== null) return { kind: 'length', value: length };
      if (/^-?[\d.]+%$/u.test(token)) return { kind: 'fraction', value: Number(token.slice(0, -1)) / 100 };
      const keyword = TILE_POSITION_KEYWORDS.get(token.replace(/[()]/gu, ''));
      return keyword === undefined ? null : { kind: 'fraction', value: keyword };
    };
    // A two-token keyword pair may be written in either order (`top left`); a length pair is
    // always horizontal then vertical, and one value leaves the other `center`, as CSS does.
    const verticalFirst = /^(top|bottom)$/u.test(tokens[0] || '')
      || /^(left|right)$/u.test(tokens[1] || '');
    const first = read(tokens[0]) || zero;
    const second = tokens.length > 1 ? (read(tokens[1]) || zero) : { kind: 'fraction', value: 0.5 };
    x = verticalFirst ? second : first;
    y = verticalFirst ? first : second;
  }
  const offset = (position, boxSize, cellSize) => {
    const value = Number(position.value);
    if (position.kind === 'length') return Number.isFinite(value) ? value : 0;
    return (boxSize - cellSize) * (Number.isFinite(value) ? value : 0);
  };
  return { x: offset(x, boxW, cellW), y: offset(y, boxH, cellH) };
}

function normalizeCrop(crop) {
  if (!crop || typeof crop !== 'object' || Array.isArray(crop)) {
    throw new Error('Image fit "crop" requires a crop object with left/top/right/bottom fractions');
  }
  const keys = ['left', 'top', 'right', 'bottom'];
  Object.keys(crop).forEach((key) => {
    if (!keys.includes(key)) throw new Error('Unsupported crop key "' + key + '"; expected left, top, right, bottom');
  });
  const result = {};
  keys.forEach((key) => {
    const value = crop[key] === undefined ? 0 : Number(crop[key]);
    if (!Number.isFinite(value) || value < 0 || value > 1) {
      throw new Error('Image crop.' + key + ' must be between 0 and 1');
    }
    result[key] = value;
  });
  if (result.left + result.right >= 1) throw new Error('Image crop left + right must be less than 1');
  if (result.top + result.bottom >= 1) throw new Error('Image crop top + bottom must be less than 1');
  return result;
}

function normalizeZoom(zoom) {
  if (zoom === undefined || zoom === null || zoom === '') return 1;
  const value = Number(zoom);
  if (!Number.isFinite(value) || value < 1) throw new Error('Image zoom must be a finite number greater than or equal to 1');
  return value;
}

function decodeBase64Payload(data) {
  const source = String(data);
  const comma = source.indexOf(',');
  const payload = source.startsWith('data:') && comma >= 0 ? source.slice(comma + 1) : source;
  try {
    return Buffer.from(payload, 'base64');
  } catch (_) {
    return null;
  }
}

function loadImageSizeModule() {
  try {
    const mod = require('image-size');
    if (typeof mod === 'function') return mod;
    if (mod && typeof mod.imageSize === 'function') return mod.imageSize;
    if (mod && typeof mod.default === 'function') return mod.default;
  } catch (_) { /* natural image size is optional but required for fit modes */ }
  return null;
}

/**
 * Resolve the natural pixel size of an image element.
 * Returns { width, height } or null when it cannot be determined.
 */
function readImageSize(element, options = {}) {
  if (!element || element.type !== 'image') return null;
  const explicit = element.naturalSize;
  if (explicit && Number.isFinite(Number(explicit.width)) && Number.isFinite(Number(explicit.height)) &&
      Number(explicit.width) > 0 && Number(explicit.height) > 0) {
    return { width: Number(explicit.width), height: Number(explicit.height) };
  }
  const measure = loadImageSizeModule();
  if (!measure) return null;
  let buffer = null;
  try {
    if (element.data) buffer = decodeBase64Payload(element.data);
    else if (element.path) {
      const readFile = options.readFile || ((file) => fs.readFileSync(file));
      buffer = readFile(element.path);
    }
  } catch (_) {
    return null;
  }
  if (!buffer || !buffer.length) return null;
  try {
    const size = measure(buffer);
    if (size && Number(size.width) > 0 && Number(size.height) > 0) {
      return { width: Number(size.width), height: Number(size.height) };
    }
  } catch (_) { /* unsupported or corrupt image */ }
  return null;
}

function normalizeBox(element) {
  const box = {
    x: Number(element.x === undefined ? 0 : element.x),
    y: Number(element.y === undefined ? 0 : element.y),
    w: Number(element.w),
    h: Number(element.h)
  };
  ['x', 'y', 'w', 'h'].forEach((key) => {
    if (!Number.isFinite(box[key])) throw new Error('Image element requires a finite ' + key + ' for fit resolution');
  });
  if (box.w <= 0 || box.h <= 0) throw new Error('Image element requires a positive w and h for fit resolution');
  return box;
}

/** Largest crop of the source that fills the box without distortion. */
function computeCoverCrop(natural, box, focus = { x: 0.5, y: 0.5 }, zoom = 1) {
  const scale = Math.max(box.w / natural.width, box.h / natural.height);
  const scaledW = natural.width * scale;
  const scaledH = natural.height * scale;
  const visibleW = clamp(box.w / scaledW / zoom, 1e-6, 1);
  const visibleH = clamp(box.h / scaledH / zoom, 1e-6, 1);
  const left = (1 - visibleW) * focus.x;
  const top = (1 - visibleH) * focus.y;
  return {
    left,
    top,
    right: 1 - visibleW - left,
    bottom: 1 - visibleH - top
  };
}

/** Box that shows the whole source at its native aspect ratio. */
function computeContainBox(natural, box, focus = { x: 0.5, y: 0.5 }) {
  const scale = Math.min(box.w / natural.width, box.h / natural.height);
  const w = natural.width * scale;
  const h = natural.height * scale;
  return {
    x: box.x + (box.w - w) * focus.x,
    y: box.y + (box.h - h) * focus.y,
    w,
    h
  };
}

/** Rounded-rectangle adjustment value, where 50000 is a full pill on the short side. */
/**
 * `object-fit: none` draws the source at its own pixel size and lets the box clip it, and
 * `scale-down` is contain that refuses to enlarge. Both are expressed with the same two
 * pieces every other mode uses: a drawn box and a source rectangle.
 */
function computeIntrinsicGeometry(natural, box, focus, mayGrow) {
  const naturalW = natural.width / PX_PER_INCH;
  const naturalH = natural.height / PX_PER_INCH;
  let w = naturalW;
  let h = naturalH;
  if (mayGrow) {
    const scale = Math.min(box.w / naturalW, box.h / naturalH, 1);
    w = naturalW * scale;
    h = naturalH * scale;
  }
  const visibleW = clamp(box.w / w, 1e-6, 1);
  const visibleH = clamp(box.h / h, 1e-6, 1);
  if (visibleW >= 1 && visibleH >= 1) {
    // Smaller than its slot: it keeps its size and sits where the focus says.
    return {
      box: { x: box.x + (box.w - w) * focus.x, y: box.y + (box.h - h) * focus.y, w, h },
      srcRect: null
    };
  }
  // Bigger than its slot: the box clips it, so the overflow becomes a source rectangle.
  const left = (1 - visibleW) * focus.x;
  const top = (1 - visibleH) * focus.y;
  return {
    box,
    srcRect: { left, top, right: 1 - visibleW - left, bottom: 1 - visibleH - top }
  };
}

function roundRectAdjustment(radiusIn, box) {
  const radius = Number(radiusIn);
  if (!Number.isFinite(radius) || radius <= 0) return null;
  const shortSide = Math.min(box.w, box.h);
  if (!Number.isFinite(shortSide) || shortSide <= 0) return null;
  return Math.max(0, Math.min(50000, Math.round((radius / shortSide) * 100000)));
}

/**
 * A window inside a window, back in source fractions.
 *
 * A declared crop (`element.crop`, the analyzer's clip-path inset) and a fit mode's own source
 * rectangle describe the same picture twice: the crop says *which* part of the source is
 * visible, the fit says how that part is drawn. Nesting the fit's window inside the crop draws
 * both instead of letting one of them win in silence.
 */
function nestSrcRect(outer, inner) {
  if (!outer) return inner;
  if (!inner) return outer;
  const width = 1 - outer.left - outer.right;
  const height = 1 - outer.top - outer.bottom;
  return {
    left: outer.left + inner.left * width,
    top: outer.top + inner.top * height,
    right: outer.right + inner.right * width,
    bottom: outer.bottom + inner.bottom * height
  };
}

/**
 * Resolve an image element into its drawn box and OOXML crop fractions.
 *
 * - stretch: fills the box, no crop (distortion is possible; legacy behaviour).
 * - cover:   fills the box, crops the overflow around the focus point.
 * - contain: shrinks the drawn box to the native aspect ratio inside the slot.
 * - crop:    draws an explicit source sub-rectangle into the box.
 *
 * A declared `crop` is applied first and the fit mode to the crop, so a picture that carries
 * both draws their composition: the crop selects the visible source, the fit places it.
 */
function resolveImageGeometry(element, options = {}) {
  const fit = normalizeFit(element.fit);
  const box = normalizeBox(element);
  // The source size is read once, here: a length-based `object-position` needs it, and so
  // does every fit that keeps proportions.
  const natural = options.natural || readImageSize(element, options);
  const crop = element.crop ? normalizeCrop(element.crop) : null;
  // What the fit modes see: the declared crop carved out of the source, so a cropped picture
  // covers/contains at the proportions of the part that is actually visible.
  const visible = crop && natural
    ? { width: natural.width * (1 - crop.left - crop.right), height: natural.height * (1 - crop.top - crop.bottom) }
    : natural;
  const focus = normalizeFocus(element.focus, { natural: visible, box, fit });

  if (fit === 'stretch') {
    return { fit, box, srcRect: crop, natural, crop };
  }

  // An explicit crop rectangle is already expressed in source-image fractions,
  // so it does not depend on the natural pixel size.
  if (fit === 'crop') {
    return { fit, box, srcRect: crop || normalizeCrop(element.crop), natural, crop };
  }

  if (!visible) {
    // The source size is unknown - a picture whose bytes the analyzer could not read, or a data
    // URI it could not decode. The analyzer has already named the source; failing the whole
    // conversion here would take every other slide down with it, so the geometry degrades to a
    // stretch, which is what a reader draws for a picture it cannot measure anyway.
    return { fit: 'stretch', box, srcRect: crop, natural: null, fitFallback: fit, crop };
  }

  if (fit === 'contain') {
    return { fit, box: computeContainBox(visible, box, focus), srcRect: crop, natural, crop };
  }
  if (fit === 'none' || fit === 'scale-down') {
    const intrinsic = computeIntrinsicGeometry(visible, box, focus, fit === 'scale-down');
    return { fit, box: intrinsic.box, srcRect: nestSrcRect(crop, intrinsic.srcRect), natural, crop };
  }
  const zoom = normalizeZoom(element.zoom);
  return { fit, box, srcRect: nestSrcRect(crop, computeCoverCrop(visible, box, focus, zoom)), natural, crop };
}

function srcRectAttributes(srcRect) {
  if (!srcRect) return '';
  const pct = (value) => Math.round(clamp(value, 0, 1) * 100000);
  return 'l="' + pct(srcRect.left) + '" t="' + pct(srcRect.top) +
    '" r="' + pct(srcRect.right) + '" b="' + pct(srcRect.bottom) + '"';
}

module.exports = {
  EMU_PER_INCH,
  EMU_PER_POINT,
  PX_PER_INCH,
  FIT_MODES,
  FOCUS_PRESETS,
  normalizeFit,
  normalizeFocus,
  normalizeCrop,
  normalizeZoom,
  readImageSize,
  fitDrawnSize,
  tileOrigin,
  computeCoverCrop,
  computeContainBox,
  computeIntrinsicGeometry,
  roundRectAdjustment,
  nestSrcRect,
  resolveImageGeometry,
  srcRectAttributes
};
