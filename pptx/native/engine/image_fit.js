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

function normalizeFocus(focus) {
  if (focus === undefined || focus === null || focus === '') return { x: 0.5, y: 0.5 };
  if (typeof focus === 'string') {
    const key = focus.trim().toLowerCase().replace(/[-_]+/gu, ' ').replace(/\s+/gu, ' ');
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
 * Resolve an image element into its drawn box and OOXML crop fractions.
 *
 * - stretch: fills the box, no crop (distortion is possible; legacy behaviour).
 * - cover:   fills the box, crops the overflow around the focus point.
 * - contain: shrinks the drawn box to the native aspect ratio inside the slot.
 * - crop:    draws an explicit source sub-rectangle into the box.
 */
function resolveImageGeometry(element, options = {}) {
  const fit = normalizeFit(element.fit);
  const box = normalizeBox(element);
  const focus = normalizeFocus(element.focus);

  if (fit === 'stretch') {
    return { fit, box, srcRect: null, natural: options.natural || readImageSize(element, options) };
  }

  // An explicit crop rectangle is already expressed in source-image fractions,
  // so it does not depend on the natural pixel size.
  if (fit === 'crop') {
    return { fit, box, srcRect: normalizeCrop(element.crop), natural: options.natural || readImageSize(element, options) };
  }

  const natural = options.natural || readImageSize(element, options);
  if (!natural) {
    throw new Error('Image fit "' + fit + '" needs the natural pixel size; provide a readable path/data source or an explicit naturalSize { width, height }');
  }

  if (fit === 'contain') {
    return { fit, box: computeContainBox(natural, box, focus), srcRect: null, natural };
  }
  if (fit === 'none' || fit === 'scale-down') {
    const intrinsic = computeIntrinsicGeometry(natural, box, focus, fit === 'scale-down');
    return { fit, box: intrinsic.box, srcRect: intrinsic.srcRect, natural };
  }
  const zoom = normalizeZoom(element.zoom);
  return { fit, box, srcRect: computeCoverCrop(natural, box, focus, zoom), natural };
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
  computeCoverCrop,
  computeContainBox,
  computeIntrinsicGeometry,
  roundRectAdjustment,
  resolveImageGeometry,
  srcRectAttributes
};
