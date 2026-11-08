'use strict';

/**
 * DOM → layout tree analysis (stage 2 of the HTML → Native pipeline).
 *
 * HTML → DOM Analyzer → **Layout Analyzer** → Style Mapper → Native Deck Spec → PPTX
 *
 * What this stage does
 *  - collects `<style>` blocks and `style=""` declarations into a declared style;
 *  - resolves geometry for absolute positioning, block flow, flex row/column and
 *    equal-width grid tracks;
 *  - measures text with the native engine's own text measurement so the HTML
 *    path and the Native path agree on heights;
 *  - classifies each node into a semantic kind/role;
 *  - records every CSS feature it cannot translate into `report.unsupported`.
 *
 * What this stage does NOT do: behave like a browser. There is no default UA
 * stylesheet cascade, no inline formatting context (text and inline elements do
 * not share a line box), no floats, no margins collapsing, no writing modes and
 * no font shaping. Percentages resolve against the direct parent content box.
 */

const { parseHtml, elementChildren, normalizedText, walk, textContent } = require('./html_parser');
const {
  parseStylesheet,
  createStyleResolver,
  dimensionInches,
  parseColor,
  parseLinearGradient,
  parseBoxShadow,
  parseBorder,
  parseLength,
  toInches,
  backgroundOf,
  gradientOf,
  backgroundImageOf,
  parseBackgroundFocus
} = require('./css');
const { estimateTextHeight, measureTextPt } = require('../engine/text_measure');

const SUPPORTED_PROPERTIES = new Set([
  'display', 'position', 'left', 'top', 'right', 'bottom', 'width', 'height',
  'minWidth', 'minHeight', 'maxWidth', 'maxHeight', 'flex', 'flexDirection',
  'flexWrap', 'flexGrow', 'flexBasis', 'gap', 'rowGap', 'columnGap', 'gridTemplateColumns', 'alignItems',
  'justifyContent', 'alignSelf', 'order', 'transform', 'padding', 'paddingTop', 'paddingRight', 'paddingBottom', 'paddingLeft',
  'margin', 'marginTop', 'marginRight', 'marginBottom', 'marginLeft',
  'color', 'background', 'backgroundColor', 'backgroundImage', 'boxSizing', 'border', 'borderWidth',
  'borderColor', 'borderStyle', 'borderRadius', 'borderTopLeftRadius',
  'borderTopRightRadius', 'borderBottomLeftRadius', 'borderBottomRightRadius',
  'boxShadow', 'opacity', 'fontFamily', 'fontSize', 'fontWeight',
  'fontStyle', 'lineHeight', 'letterSpacing', 'textAlign', 'textTransform',
  'objectFit', 'objectPosition', 'backgroundSize', 'backgroundPosition', 'zIndex', 'visibility'
]);

const UNSUPPORTED_ALWAYS = new Set([
  'overflow', 'borderCollapse', 'filter', 'backdropFilter', 'clipPath', 'mask', 'mixBlendMode',
  'animation', 'transition', 'float', 'columns', 'columnCount', 'writingMode',
  'backgroundClip', 'textShadow',
  'textOverflow', 'whiteSpace', 'wordBreak', 'hyphens', 'aspectRatio', 'inset',
  'gridTemplateRows', 'gridAutoRows', 'gridColumn', 'gridRow',
  'flexShrink', 'justifySelf'
]);

/** CSS align-self spelling → the native container's per-child alignment. */
const ALIGN_SELF_NATIVE = {
  stretch: 'stretch',
  'flex-start': 'start',
  start: 'start',
  center: 'center',
  'flex-end': 'end',
  end: 'end'
};

const ROTATE_FUNCTIONS = new Set(['rotate', 'rotatez']);

/** Every transform function in a declaration, in source order. */
function transformFunctions(value) {
  const text = String(value === undefined || value === null ? '' : value).trim();
  if (!text || text === 'none') return [];
  const functions = [];
  const pattern = /([a-zA-Z0-9]+)\s*\(([^)]*)\)/gu;
  let match = pattern.exec(text);
  while (match) {
    functions.push({ name: match[1].toLowerCase(), args: match[2] });
    match = pattern.exec(text);
  }
  return functions;
}

function angleDegrees(argument) {
  const match = /^(-?[\d.]+)\s*(deg|rad|grad|turn)?$/u.exec(String(argument || '').trim());
  if (!match) return null;
  const value = Number(match[1]);
  if (!Number.isFinite(value)) return null;
  const unit = match[2] || 'deg';
  if (unit === 'rad') return (value * 180) / Math.PI;
  if (unit === 'grad') return value * 0.9;
  if (unit === 'turn') return value * 360;
  return value;
}

/** `transform: rotate(-4deg)` → degrees, clockwise positive like DrawingML. */
function rotationFromTransform(value) {
  const functions = transformFunctions(value);
  if (!functions.length) return undefined;
  if (!functions.every((entry) => ROTATE_FUNCTIONS.has(entry.name))) return undefined;
  let total = 0;
  for (const entry of functions) {
    const degrees = angleDegrees(entry.args);
    if (degrees === null) return undefined;
    total += degrees;
  }
  if (Math.abs(total) < 0.01) return undefined;
  return Number(total.toFixed(2));
}

/** CSS `order`; 0 when absent, and DOM order is the stable tiebreak. */
function sortByOrder(kids, ctx) {
  return kids
    .map((child, index) => {
      const style = ctx.styles.computed(child);
      const order = Number(style.order);
      return { child, index, order: Number.isFinite(order) ? order : 0 };
    })
    .sort((left, right) => (left.order - right.order) || (left.index - right.index))
    .map((entry) => entry.child);
}

/** The child's align-self in native spelling, or undefined to inherit. */
function alignSelfOf(style) {
  const self = String(style.alignSelf || '').toLowerCase();
  if (!self || self === 'auto') return undefined;
  return ALIGN_SELF_NATIVE[self] || 'start';
}

const KIND_BY_TAG = {
  h1: 'text', h2: 'text', h3: 'text', h4: 'text', h5: 'text', h6: 'text',
  p: 'text', span: 'text', strong: 'text', em: 'text', b: 'text', i: 'text',
  small: 'text', time: 'text', label: 'text', figcaption: 'text',
  blockquote: 'text', li: 'text', td: 'text', th: 'text',
  ul: 'list', ol: 'list', img: 'image', hr: 'line', table: 'table',
  br: 'break', svg: 'unsupported', video: 'unsupported', iframe: 'unsupported',
  canvas: 'unsupported', object: 'unsupported'
};

const TITLE_CLASS_HINTS = ['title', 'headline', 'hero-title', 'slide-title'];
const HEADING_CLASS_HINTS = ['heading', 'subtitle', 'subhead', 'section-title'];
const CAPTION_CLASS_HINTS = ['caption', 'note', 'footnote', 'meta', 'label', 'kicker', 'eyebrow', 'tag'];

const BLOCK_TAGS = new Set([
  'div', 'section', 'article', 'header', 'footer', 'main', 'aside', 'nav',
  'figure', 'ul', 'ol', 'table', 'p', 'h1', 'h2', 'h3', 'h4', 'h5', 'h6',
  'blockquote', 'hr', 'form', 'img', 'video', 'canvas', 'iframe', 'svg'
]);

function classList(node) {
  return String((node.attrs && node.attrs.class) || '').split(/\s+/u).filter(Boolean);
}

function hasHint(classes, hints) {
  return classes.some((name) => hints.some((hint) => name.toLowerCase().includes(hint)));
}

function inchesOf(value, axis, context) {
  if (value === undefined || value === null || value === '') return null;
  return dimensionInches(value, axis, context);
}

function boxShorthand(style, prefix) {
  const read = (side) => {
    const value = style[prefix + side];
    if (value === undefined) return 0;
    const inches = toInches(parseLength(value) || { value: 0, unit: 'px' }, {});
    return inches === null ? 0 : inches;
  };
  return {
    top: read('Top'), right: read('Right'), bottom: read('Bottom'), left: read('Left')
  };
}

/** `object-position: right top` uses the same grammar as background-position. */
function descriptionFocus(value) {
  if (!value) return undefined;
  return parseBackgroundFocus(value);
}

function radiusOf(style) {
  const raw = style.borderTopLeftRadius || style.borderRadius;
  if (!raw) return null;
  const length = parseLength(raw);
  if (!length) return null;
  const inches = toInches(length, {});
  return inches && inches > 0 ? Number(inches.toFixed(3)) : null;
}

function isAbsolute(style) {
  return style.position === 'absolute' || style.position === 'fixed';
}

function flexGap(style, direction) {
  const gap = inchesOf(direction === 'row' ? (style.columnGap || style.gap) : (style.rowGap || style.gap), 'x', {});
  return gap === null ? 0 : gap;
}

function createContext(html, options = {}) {
  const root = parseHtml(html);
  const styleBlocks = [];
  walk(root, (node) => {
    if (node.type === 'element' && node.tag === 'style') styleBlocks.push(textContent(node));
  });
  const pageSize = pageSizeInches(options);
  // The slide is a fixed viewport, so `@media` can be resolved instead of dropped.
  const stylesheet = parseStylesheet(styleBlocks.join('\n'), {
    viewportWidth: Math.round(pageSize.width * 96),
    viewportHeight: Math.round(pageSize.height * 96)
  });
  const decorationSelectors = new Set((stylesheet.decorationRules || []).map((rule) => rule.selectorText));
  const unsupported = (stylesheet.pseudoSelectors || [])
    // ::before/::after are either turned into overlays or reported per element.
    .filter((selectorText) => !decorationSelectors.has(selectorText))
    .map((selectorText) => ({
      tag: null,
      classes: [],
      property: 'selector',
      value: selectorText,
      reason: 'Pseudo-elements and pseudo-classes describe boxes that do not exist; their rules are not translated'
    }));
  const mediaQueries = stylesheet.mediaQueries || [];
  mediaQueries.filter((entry) => !entry.matched).forEach((entry) => {
    unsupported.push({
      tag: null,
      classes: [],
      property: '@media',
      value: entry.query,
      reason: 'Media query does not match the slide viewport; its rules were not applied'
    });
  });
  const notes = [];
  const appliedMedia = mediaQueries.filter((entry) => entry.matched).length;
  if (appliedMedia) {
    notes.push(appliedMedia + ' @media block(s) applied at '
      + Math.round(pageSize.width * 96) + 'x' + Math.round(pageSize.height * 96));
  }
  return {
    root,
    stylesheet,
    styles: createStyleResolver(stylesheet),
    nextId: 1,
    unsupported,
    notes,
    options
  };
}

function recordUnsupported(ctx, node, property, value, reason) {
  ctx.unsupported.push({
    tag: node && node.tag,
    classes: node ? classList(node) : [],
    property,
    value: String(value),
    reason
  });
}

/**
 * Declaring a property with its initial value changes nothing, so it is not a
 * real limitation and must not pollute the unsupported report.
 */
const NOOP_VALUES = {
  overflow: ['visible'],
  borderCollapse: ['collapse'],
  textShadow: ['none'],
  transform: ['none'],
  filter: ['none'],
  backdropFilter: ['none'],
  clipPath: ['none'],
  mask: ['none'],
  mixBlendMode: ['normal'],
  animation: ['none'],
  transition: ['none'],
  float: ['none'],
  columns: ['auto'],
  columnCount: ['auto'],
  writingMode: ['horizontal-tb'],
  backgroundClip: ['border-box'],
  textOverflow: ['clip'],
  whiteSpace: ['normal'],
  wordBreak: ['normal'],
  hyphens: ['manual'],
  aspectRatio: ['auto'],
  inset: ['auto'],
  gridTemplateRows: ['none'],
  gridAutoRows: ['auto'],
  order: ['0'],
  zIndex: ['auto'],
  alignSelf: ['auto'],
  justifySelf: ['auto'],
  flexBasis: ['auto'],
  flexGrow: ['0'],
  flexShrink: ['1']
};

function isNoopValue(property, value) {
  const allowed = NOOP_VALUES[property];
  if (!allowed) return false;
  return allowed.includes(String(value).trim().toLowerCase());
}

function checkUnsupported(ctx, domNode, style) {
  Object.keys(style).forEach((property) => {
    if (property.startsWith('--')) return;
    if (isNoopValue(property, style[property])) return;
    if (UNSUPPORTED_ALWAYS.has(property)) {
      recordUnsupported(ctx, domNode, property, style[property], 'CSS feature has no native translation');
    } else if (!SUPPORTED_PROPERTIES.has(property)) {
      recordUnsupported(ctx, domNode, property, style[property], 'Property is outside the supported subset');
    }
  });
  if (style.display === 'inline' || style.display === 'inline-block') {
    recordUnsupported(ctx, domNode, 'display', style.display, 'Inline flow is approximated as a block box');
  }
  const transform = style.transform;
  if (transform && !isNoopValue('transform', transform)) {
    const unsupported = transformFunctions(transform)
      .filter((entry) => !ROTATE_FUNCTIONS.has(entry.name))
      .map((entry) => entry.name + '()');
    if (unsupported.length) {
      recordUnsupported(ctx, domNode, 'transform', unsupported.join(', '),
        'Only rotate() has a native shape rotation');
    }
  }
  if (style.flexWrap === 'wrap' && style.display === 'flex') {
    recordUnsupported(ctx, domNode, 'flexWrap', 'wrap', 'Wrapping flex rows are laid out as a single line');
  }
}

function fontPxOf(style, inheritedPx) {
  const size = parseLength(style.fontSize);
  if (!size) return inheritedPx;
  if (size.unit === 'em') return size.value * inheritedPx;
  if (size.unit === 'rem') return size.value * 16;
  if (size.unit === '%') return (size.value / 100) * inheritedPx;
  const inches = toInches(size, { fontSizePx: inheritedPx });
  return inches === null ? inheritedPx : inches * 96;
}

function lineSpacingOf(style, fontPx) {
  const raw = style.lineHeight;
  if (!raw || raw === 'normal') return { multiple: 1.25, explicit: null };
  const length = parseLength(raw);
  if (!length) return { multiple: 1.25, explicit: null };
  if (length.unit === '') return { multiple: Number(length.value) || 1.25, explicit: null };
  const inches = toInches(length, { fontSizePx: fontPx });
  if (!inches) return { multiple: 1.25, explicit: null };
  return { multiple: Math.max(0.8, Number((inches / (fontPx / 96)).toFixed(3))), explicit: inches };
}

/** Build rich-text runs from inline children, keeping bold/italic/colour spans. */
function baseRunFlags(baseStyle) {
  const color = parseColor(baseStyle.color);
  const weight = String(baseStyle.fontWeight || '').toLowerCase();
  const size = parseLength(baseStyle.fontSize);
  return {
    color: color && color.hex ? color.hex : null,
    bold: weight === 'bold' || weight === 'bolder' || Number(weight) >= 600,
    italic: String(baseStyle.fontStyle || '').toLowerCase() === 'italic',
    fontSize: size ? Math.round(toInches(size, {}) * 72 * 100) / 100 : null
  };
}

function buildRuns(domNode, baseStyle, ctx) {
  const base = baseRunFlags(baseStyle);
  const runs = [];
  const pushText = (value, style) => {
    if (!value) return;
    const options = {};
    if (style) {
      const color = parseColor(style.color);
      if (color && color.hex && color.hex !== base.color) options.color = color.hex;
      const weight = String(style.fontWeight || '').toLowerCase();
      const bold = weight === 'bold' || weight === 'bolder' || Number(weight) >= 600;
      if (bold !== base.bold) options.bold = bold;
      const italic = String(style.fontStyle || '').toLowerCase() === 'italic';
      if (italic !== base.italic) options.italic = italic;
      const sizePt = parseLength(style.fontSize);
      if (sizePt) {
        const inches = toInches(sizePt, { fontSizePx: fontPxOf(baseStyle, 16) });
        const rounded = inches ? Math.round(inches * 72 * 100) / 100 : null;
        if (rounded && rounded !== base.fontSize) options.fontSize = rounded;
      }
    }
    runs.push(Object.keys(options).length ? { text: value, options } : { text: value });
  };

  const visit = (node, inheritedStyle) => {
    if (node.type === 'text') {
      pushText(node.text.replace(/[ \t\u00A0]+/gu, ' '), inheritedStyle);
      return;
    }
    if (node.type !== 'element') return;
    if (node.tag === 'br') {
      pushText('\n', null);
      return;
    }
    const style = ctx.styles.computed(node);
    const merged = Object.assign({}, inheritedStyle || baseStyle, style);
    if (!node.children.length) {
      pushText(normalizedText(node), merged);
      return;
    }
    node.children.forEach((child) => visit(child, merged));
  };

  (domNode.children || []).forEach((child) => visit(child, baseStyle));
  const text = runs.map((run) => run.text).join('');
  const hasFormatting = runs.some((run) => run.options);
  return { runs, text, hasFormatting };
}

function resolveKind(domNode, style, children) {
  const tagKind = KIND_BY_TAG[domNode.tag];
  if (tagKind) return tagKind;
  const hasBlockChild = children.some((child) => BLOCK_TAGS.has(child.tag));
  if (hasBlockChild) return 'block';
  const text = normalizedText(domNode);
  if (text) return 'text';
  if (backgroundImageOf(style)) return style.backgroundColor ? 'block' : 'image';
  if (backgroundOf(style) || gradientOf(style) || style.border || style.boxShadow) return 'shape';
  return 'block';
}

/** CSS text-transform is a content change, so it is applied before measuring. */
function transformText(value, transform) {
  if (transform === 'uppercase') return value.toUpperCase();
  if (transform === 'lowercase') return value.toLowerCase();
  if (transform === 'capitalize') {
    return value.replace(/(^|[\s\u3000])([a-z])/gu, (match, lead, letter) => lead + letter.toUpperCase());
  }
  return value;
}

function measureTextElement(domNode, style, availableWidth, inheritedFontPx, ctx) {
  const fontPx = fontPxOf(style, inheritedFontPx);
  const fontSizePt = Number((fontPx * 0.75).toFixed(2));
  const { multiple } = lineSpacingOf(style, fontPx);
  const built = buildRuns(domNode, Object.assign({ fontSize: fontPx + 'px' }, style), ctx);
  const measureOptions = { lineHeight: multiple, safetyFactor: 0.92 };
  const transform = String(style.textTransform || '').toLowerCase();
  if (transform && transform !== 'none') {
    built.text = transformText(built.text, transform);
    built.runs.forEach((run) => { run.text = transformText(run.text, transform); });
  }
  return {
    fontPx,
    fontSizePt,
    lineSpacingMultiple: multiple,
    runs: built.hasFormatting ? built.runs : null,
    text: built.text.replace(/\s*\n\s*/gu, '\n').trim(),
    textHeight: estimateTextHeight(built.text, Math.max(0.2, availableWidth), fontSizePt, measureOptions)
  };
}

/**
 * Lay out one DOM node inside `slot`.
 * slot = { x, y, w, h } where x/y is the top-left corner and h may be null (auto).
 */
function analyzeNode(domNode, slot, inherited, ctx) {
  const node = analyzeNodeTree(domNode, slot, inherited, ctx);
  if (!node) return null;
  applyHeightConstraints(node, slot, ctx);
  attachDecorations(domNode, node, ctx);
  absoluteChildOverlays(node);
  return node;
}

/**
 * A text child with `position: absolute` is placed by the container but painted
 * above the flow, which is exactly what a container overlay is. Keeping it out of
 * `children` lets the group stay declarative; anything more complex than a text
 * box stays a real (absolute) child and demotes the group, which is reported.
 */
function absoluteChildOverlays(node) {
  if (!Array.isArray(node.children) || !node.children.length) return;
  const kept = [];
  let added = false;
  node.children.forEach((child) => {
    const convertible = child.absolute
      && child.kind === 'text'
      && typeof child.text === 'string'
      && !(child.children && child.children.length)
      && [child.x, child.y, child.w, child.h].every((value) => Number.isFinite(value))
      && child.h > 0 && child.w > 0;
    if (!convertible) {
      kept.push(child);
      return;
    }
    const round = (value) => Number(value.toFixed(4));
    const overlay = {
      x: round(child.x - node.x),
      y: round(child.y - node.y),
      w: round(child.w),
      h: round(child.h),
      text: child.text,
      align: child.align || 'left',
      valign: child.valign || 'top'
    };
    if (child.color) overlay.color = child.color;
    if (Number.isFinite(child.fontSize)) overlay.fontSize = child.fontSize;
    if (child.bold) overlay.bold = true;
    if (child.italic) overlay.italic = true;
    if (child.fontFace) overlay.fontFace = child.fontFace;
    if (child.lineSpacingMultiple) overlay.lineSpacingMultiple = child.lineSpacingMultiple;
    if (node.overlays) node.overlays.push(overlay);
    else node.overlays = [overlay];
    added = true;
  });
  if (added) node.children = kept;
}

/**
 * Decode a CSS `content` value: strip the quotes, then resolve CSS escapes so
 * `"\2192"` becomes an arrow instead of the literal text.
 */
function decodeCssContent(value) {
  const text = String(value === undefined ? '' : value).replace(/^\s*['"]|['"]\s*$/gu, '');
  return text
    .replace(/\\([0-9a-fA-F]{1,6})\s?/gu, (match, hex) => {
      const point = parseInt(hex, 16);
      return point > 0 && point <= 0x10ffff ? String.fromCodePoint(point) : '';
    })
    .replace(/\\(.)/gu, '$1');
}

/**
 * `::before`/`::after` decorations are extra boxes the DOM does not contain.
 * An absolutely positioned decoration with a definite size and a background or
 * content becomes an overlay of the element's container, which keeps the group
 * declarative instead of forcing it to absolute coordinates.
 */
function attachDecorations(domNode, node, ctx) {
  const overlays = [];
  const skip = (pseudo, reason, value) => {
    recordUnsupported(ctx, { tag: domNode.tag, classes: classList(domNode) },
      '::' + pseudo, value, reason);
  };
  ['before', 'after'].forEach((pseudo) => {
    const declaration = ctx.styles.decoration(domNode, pseudo);
    if (!declaration) return;
    const content = declaration.content;
    if (content === undefined) return; // CSS requires content on a pseudo box
    const position = String(declaration.position || '').toLowerCase();
    if (position !== 'absolute') {
      skip(pseudo, 'Only absolutely positioned decorations have a placeable box', content);
      return;
    }

    const parentWidth = node.w;
    const parentHeight = node.h;
    if (!Number.isFinite(parentWidth) || !Number.isFinite(parentHeight)) {
      skip(pseudo, 'The host element has no definite box to anchor the decoration', content);
      return;
    }

    const offsetOf = (value, axis) => {
      const length = parseLength(value);
      if (!length) return undefined;
      if (length.unit === '%') {
        const base = axis === 'x' ? parentWidth : parentHeight;
        return (length.value / 100) * base;
      }
      return toInches(length, { parentWidth, fontSizePx: 16 });
    };
    const left = offsetOf(declaration.left, 'x');
    const right = offsetOf(declaration.right, 'x');
    const top = offsetOf(declaration.top, 'y');
    const bottom = offsetOf(declaration.bottom, 'y');
    let width = offsetOf(declaration.width, 'x');
    let height = offsetOf(declaration.height, 'y');
    if (width === undefined && left !== undefined && right !== undefined) width = parentWidth - left - right;
    if (height === undefined && top !== undefined && bottom !== undefined) height = parentHeight - top - bottom;
    if (!Number.isFinite(width) || !Number.isFinite(height) || width <= 0 || height <= 0) {
      skip(pseudo, 'A decoration needs a definite width and height (auto-sized content is not measured)', content);
      return;
    }

    const x = left !== undefined ? left : (right !== undefined ? parentWidth - width - right : 0);
    const y = top !== undefined ? top : (bottom !== undefined ? parentHeight - height - bottom : 0);

    const background = backgroundOf(declaration);
    const text = content === 'none' || content === 'normal' ? '' : decodeCssContent(content);
    const colour = parseColor(declaration.color);
    if (!(background && background.hex) && !text) {
      skip(pseudo, 'The decoration paints nothing (no background and no content)', content);
      return;
    }

    const overlay = {
      x: Number(x.toFixed(4)),
      y: Number(y.toFixed(4)),
      w: Number(width.toFixed(4)),
      h: Number(height.toFixed(4))
    };
    if (background && background.hex) overlay.fill = background.hex;
    const radius = parseLength(declaration.borderRadius);
    if (radius && radius.unit !== '%') overlay.radius = Number(toInches(radius, { fontSizePx: 16 }).toFixed(3));
    if (text) {
      overlay.text = text;
      if (colour && colour.hex) overlay.color = colour.hex;
      const sizePt = parseLength(declaration.fontSize);
      if (sizePt) overlay.fontSize = Number((toInches(sizePt, {}) * 72).toFixed(1));
      overlay.align = declaration.textAlign || 'center';
    }
    overlay.pseudo = pseudo;
    overlays.push(overlay);
  });
  if (overlays.length) node.overlays = overlays;
}

/**
 * min/max-height is applied after the subtree is measured, because an auto
 * height is only known then. A max-height that actually clamps would need
 * clipping, which no native shape can express, so it is reported instead of
 * being silently obeyed.
 */
function applyHeightConstraints(node, slot, ctx) {
  const style = node.style || {};
  const options = {
    parentWidth: node.parentWidth === undefined ? node.w : node.parentWidth,
    parentHeight: slot ? slot.h : null,
    fontSizePx: node.fontPx || 16
  };
  const minHeight = inchesOf(style.minHeight, 'y', options);
  const maxHeight = inchesOf(style.maxHeight, 'y', options);
  const height = node.h === null || node.h === undefined ? null : node.h;
  if (minHeight !== null && (height === null ? 0 : height) < minHeight) node.h = minHeight;
  if (maxHeight !== null && node.h !== null && node.h > maxHeight) {
    if (node.kind === 'text' || node.kind === 'list' || node.kind === 'image') {
      node.h = maxHeight;
    } else {
      recordUnsupported(ctx, { tag: node.tag, classes: node.classes }, 'maxHeight',
        style.maxHeight, 'Clamping a container would need clipping, which native shapes cannot do');
    }
  }
}

function analyzeNodeTree(domNode, slot, inherited, ctx) {
  const style = ctx.styles.computed(domNode);
  if (style.display === 'none' || style.visibility === 'hidden') return null;
  checkUnsupported(ctx, domNode, style);

  const fontSizePx = fontPxOf(style, inherited.fontPx);
  const absolute = isAbsolute(style);
  // Percentages resolve against the containing block, never against an already
  // resolved child slot, otherwise relative widths would be applied twice.
  const parentBoxForWidth = inherited.parentBox || { x: 0, y: 0, w: slot.w, h: null };
  const parentWidth = parentBoxForWidth.w;

  const padding = boxShorthand(style, 'padding');
  const border = parseBorder(style);
  const insetLeft = padding.left + (border ? border.width / 72 : 0);
  const insetTop = padding.top + (border ? border.width / 72 : 0);
  const insetRight = padding.right + (border ? border.width / 72 : 0);
  const insetBottom = padding.bottom + (border ? border.width / 72 : 0);

  let width = slot.w === null || slot.w === undefined ? null : slot.w;
  const explicitHeight = inchesOf(style.height, 'y', { parentWidth, parentHeight: slot.h, fontSizePx });
  const styleWidth = (width === null || slot.explicitWidth)
    ? inchesOf(style.width, 'x', { parentWidth, fontSizePx })
    : null;
  if (width === null) {
    width = styleWidth === null ? Math.max(0, parentWidth) : styleWidth;
  }

  // `width` is resolved as a border box. Honouring an explicit content-box keeps
  // the padding from silently shrinking designed boxes.
  const boxSizing = String(style.boxSizing || '').toLowerCase();
  if (styleWidth !== null && boxSizing === 'content-box') {
    width += insetLeft + insetRight;
  } else if (styleWidth !== null && boxSizing === '' && (insetLeft + insetRight) > 0) {
    recordUnsupported(ctx, domNode, 'boxSizing', 'content-box (default)',
      'Width is resolved as a border box; declare box-sizing: border-box to make it exact');
  }

  const sizeOptions = { parentWidth, parentHeight: slot.h, fontSizePx };
  const minWidth = inchesOf(style.minWidth, 'x', sizeOptions);
  const maxWidth = inchesOf(style.maxWidth, 'x', sizeOptions);
  if (minWidth !== null && width < minWidth) width = minWidth;
  if (maxWidth !== null && width > maxWidth) width = maxWidth;

  let x = slot.x;
  let y = slot.y;
  if (absolute) {
    // CSS: the containing block of an absolutely positioned element is the
    // padding box of its positioned ancestor.
    const parentBox = inherited.parentPaddingBox || parentBoxForWidth;
    const left = inchesOf(style.left, 'x', { parentWidth, fontSizePx });
    const right = inchesOf(style.right, 'x', { parentWidth, fontSizePx });
    const top = inchesOf(style.top, 'y', { parentWidth, parentHeight: parentBox.h, fontSizePx });
    const bottom = inchesOf(style.bottom, 'y', { parentWidth, parentHeight: parentBox.h, fontSizePx });
    if (left !== null) x = parentBox.x + left;
    else if (right !== null) x = parentBox.x + parentBox.w - right - width;
    if (top !== null) y = parentBox.y + top;
    else if (bottom !== null && parentBox.h !== null) y = parentBox.y + parentBox.h - bottom - (explicitHeight || 0);
  }

  const contentWidth = Math.max(0, width - insetLeft - insetRight);

  const contentBox = {
    x: x + insetLeft,
    y: y + insetTop,
    w: contentWidth,
    h: explicitHeight === null ? null : Math.max(0, explicitHeight - insetTop - insetBottom)
  };

  const borderInset = border ? border.width / 72 : 0;
  const paddingBox = {
    x: x + borderInset,
    y: y + borderInset,
    w: Math.max(0, width - borderInset * 2),
    h: explicitHeight === null ? null : Math.max(0, explicitHeight - borderInset * 2)
  };

  const childContext = {
    fontPx: fontSizePx,
    parentBox: Object.assign({}, contentBox, { h: explicitHeight }),
    parentPaddingBox: paddingBox
  };

  const elementKids = elementChildren(domNode);
  const kind = resolveKind(domNode, style, elementKids);
  const node = {
    id: ctx.nextId++,
    parentWidth,
    tag: domNode.tag,
    classes: classList(domNode),
    kind,
    style,
    margins: boxShorthand(style, 'margin'),
    radius: radiusOf(style),
    x,
    y,
    w: width,
    h: explicitHeight,
    contentWidth,
    padding,
    border,
    children: []
  };

  if (kind === 'unsupported') {
    recordUnsupported(ctx, domNode, 'element', domNode.tag, 'Element type has no native translation');
    return null;
  }

  const rotate = rotationFromTransform(style.transform);
  if (rotate !== undefined) node.rotate = rotate;

  const chart = readChart(domNode, ctx);
  if (chart) {
    node.kind = 'chart';
    node.chartType = chart.chartType;
    node.chartData = chart.data;
    node.chartOptions = chart.options;
    const boxHeight = slot.parentContentHeight;
    node.h = explicitHeight !== null
      ? explicitHeight
      : (Number.isFinite(boxHeight) && boxHeight > 0.2 ? boxHeight : Math.max(1.6, width * 0.5));
    return node;
  }

  if (kind === 'text' || kind === 'list') {
    const measured = measureTextElement(domNode, style, contentWidth, fontSizePx, ctx);
    Object.assign(node, measured);
    if (kind === 'list') {
      const items = elementKids.filter((child) => child.tag === 'li').map((child) => normalizedText(child));
      node.text = items.join('\n');
      node.bullet = true;
      node.runs = null;
      node.textHeight = estimateTextHeight(node.text, Math.max(0.2, contentWidth), measured.fontSizePt,
        { lineHeight: measured.lineSpacingMultiple, safetyFactor: 0.92 });
    }
    node.h = explicitHeight === null ? node.textHeight : explicitHeight;
    return node;
  }

  if (kind === 'image') {
    const layer = backgroundImageOf(style);
    if (layer && domNode.tag !== 'img') {
      node.h = explicitHeight === null ? Math.max(width * 0.5625, 0.2) : explicitHeight;
      node.src = layer.src;
      node.alt = '';
      node.objectFit = layer.fit;
      node.focus = layer.focus;
      node.radius = radiusOf(style);
      return node;
    }
    const attrWidth = Number(domNode.attrs.width);
    const attrHeight = Number(domNode.attrs.height);
    if (width === null || width === slot.w) {
      if (Number.isFinite(attrWidth) && attrWidth > 0) width = attrWidth / 96;
    }
    let height = explicitHeight;
    if (height === null && Number.isFinite(attrHeight) && attrHeight > 0) height = attrHeight / 96;
    node.w = width;
    node.x = x;
    node.h = height === null ? width * 0.5625 : height;
    node.src = domNode.attrs.src || null;
    node.alt = domNode.attrs.alt || '';
    node.objectFit = (style.objectFit || 'cover').toLowerCase();
    node.focus = descriptionFocus(style.objectPosition);
    node.radius = radiusOf(style);
    return node;
  }

  if (kind === 'line') {
    node.h = explicitHeight === null ? 0.02 : explicitHeight;
    return node;
  }

  if (kind === 'table') {
    const table = readTable(domNode, ctx, contentWidth);
    node.rows = table.rows;
    node.columnCount = table.columns;
    node.colWidths = table.colWidths;
    node.h = explicitHeight === null ? Math.max(0.4, node.rows.length * 0.34) : explicitHeight;
    return node;
  }

  const backgroundLayer = backgroundImageOf(style);
  if (backgroundLayer) node.backgroundImage = backgroundLayer;

  // Container-ish node: lay out children.
  const display = style.display;
  if (display === 'flex') {
    node.children = layoutFlex(domNode, contentBox, childContext, ctx);
  } else if (display === 'grid') {
    node.children = layoutGrid(domNode, style, contentBox, childContext, ctx);
    if (node.children.gridTracks && node.children.gridTracks.length) {
      node.gridTracks = node.children.gridTracks;
      delete node.children.gridTracks;
    }
  } else {
    node.children = layoutFlow(domNode, contentBox, childContext, ctx);
  }

  const contentBottom = node.children.reduce((bottom, child) => {
    const childBottom = child.absolute ? bottom : child.y + child.h;
    return Math.max(bottom, childBottom);
  }, contentBox.y);
  const autoHeight = contentBottom - y + insetBottom;
  node.h = explicitHeight === null ? Math.max(0, Number(autoHeight.toFixed(4))) : explicitHeight;
  if (node.h <= 0) node.h = 0.02;
  return node;
}

function childMargins(childStyle, context) {
  const read = (side, axis) => {
    const value = childStyle['margin' + side];
    if (value === undefined) return 0;
    const inches = inchesOf(value, axis, context);
    return inches === null ? 0 : inches;
  };
  return {
    top: read('Top', 'y'),
    right: read('Right', 'x'),
    bottom: read('Bottom', 'y'),
    left: read('Left', 'x')
  };
}

function layoutFlow(domNode, contentBox, inherited, ctx) {
  const nodes = [];
  let cursor = contentBox.y;
  const visible = elementChildren(domNode).filter((child) => {
    const childStyle = ctx.styles.computed(child);
    return childStyle.display !== 'none' && childStyle.visibility !== 'hidden';
  });
  // A lone chart child has no content to measure, so a definite parent height is
  // its height; with siblings that would just overlap them.
  const soloHeight = visible.length === 1 ? contentBox.h : null;
  elementChildren(domNode).forEach((child) => {
    const childStyle = ctx.styles.computed(child);
    if (childStyle.display === 'none' || childStyle.visibility === 'hidden') return;
    const margins = childMargins(childStyle, { parentWidth: contentBox.w, fontSizePx: inherited.fontPx });
    const slotWidth = Math.max(0, contentBox.w - margins.left - margins.right);
    const explicitWidth = inchesOf(childStyle.width, 'x', { parentWidth: contentBox.w, fontSizePx: inherited.fontPx });
    const slot = isAbsolute(childStyle)
      ? anchoredSlot(childStyle, contentBox, inherited)
      : {
        x: contentBox.x + margins.left,
        y: cursor + margins.top,
        w: explicitWidth === null ? slotWidth : explicitWidth,
        explicitWidth: explicitWidth !== null,
        h: null,
        parentContentHeight: soloHeight
      };
    const node = applyAnchorHints(analyzeNode(child, slot, inherited, ctx), slot);
    if (!node) return;
    node.absolute = isAbsolute(childStyle);
    nodes.push(node);
    if (!node.absolute) cursor = node.y + node.h + margins.bottom;
  });
  return nodes;
}

/**
 * Resolve an absolutely positioned child against its container box. Percentages
 * resolve against the container, and `left/right` plus `top/bottom` are
 * interchangeable, exactly like CSS.
 */
function anchoredSlot(style, contentBox, inherited) {
  const options = {
    parentWidth: contentBox.w,
    parentHeight: contentBox.h === undefined ? null : contentBox.h,
    fontSizePx: inherited.fontPx
  };
  const horizontal = (value) => {
    const length = parseLength(value);
    if (!length) return undefined;
    if (length.unit === '%') return (length.value / 100) * contentBox.w;
    return toInches(length, options);
  };
  const vertical = (value) => {
    const length = parseLength(value);
    if (!length) return undefined;
    if (length.unit === '%') return (length.value / 100) * (contentBox.h || 0);
    return toInches(length, options);
  };
  const left = horizontal(style.left);
  const right = horizontal(style.right);
  const top = vertical(style.top);
  const bottom = vertical(style.bottom);
  let width = horizontal(style.width);
  let height = vertical(style.height);
  if (width === undefined && left !== undefined && right !== undefined) width = contentBox.w - left - right;
  // Shrink-to-fit text is not measured here; the container width is the safe bound.
  if (width === undefined) width = contentBox.w;
  const x = left !== undefined
    ? contentBox.x + left
    : (right !== undefined ? contentBox.x + contentBox.w - width - right : contentBox.x);
  let y = contentBox.y;
  if (top !== undefined) y = contentBox.y + top;
  else if (bottom !== undefined && height !== undefined) y = contentBox.y + (contentBox.h || 0) - height - bottom;
  return {
    x,
    y,
    w: Math.max(0, width),
    explicitWidth: style.width !== undefined,
    h: height === undefined ? null : height,
    parentContentHeight: contentBox.h === undefined ? null : contentBox.h,
    // No declared width and only a right offset: the box hugs the right edge.
    hugRight: right !== undefined && left === undefined && style.width === undefined,
    hugBottom: bottom !== undefined && top === undefined && height === undefined,
    rightEdge: right === undefined ? undefined : contentBox.x + contentBox.w - right,
    bottomEdge: bottom === undefined ? undefined : contentBox.y + (contentBox.h || 0) - bottom
  };
}

/**
 * Apply the anchor hints of a slot to the node it produced. A box that hugs an
 * edge is resized to its content first: the measured text width for text, the
 * whole container otherwise.
 */
function applyAnchorHints(node, slot) {
  if (!node || !slot) return node;
  if (slot.hugRight && Number.isFinite(slot.rightEdge)) {
    if (node.kind === 'text' && typeof node.text === 'string' && node.text.indexOf('\n') === -1) {
      const fontPt = node.fontSize || 18;
      const natural = (measureTextPt(node.text, fontPt) / 72) * 1.02;
      node.w = Math.max(0.2, Math.min(node.w, natural));
    }
    node.x = slot.rightEdge - node.w;
  }
  if (slot.hugBottom && Number.isFinite(slot.bottomEdge)) {
    node.y = slot.bottomEdge - (Number.isFinite(node.h) ? node.h : 0);
  }
  return node;
}

/**
 * The growth factor of a flex item: the `flex-grow` longhand wins, then the
 * `flex` shorthand, then 1 (a flex item grows by default).
 */
function flexWeightOf(style) {
  const grow = Number(style.flexGrow);
  if (Number.isFinite(grow) && grow >= 0) return grow;
  const shorthand = String(style.flex === undefined ? '' : style.flex).trim().toLowerCase();
  if (shorthand === 'none') return 0;
  const first = Number(shorthand.split(/\s+/u)[0]);
  return Number.isFinite(first) && first >= 0 ? first : 1;
}

/** A flex item's base size: the declared width, then `flex-basis`, then auto. */
function flexBasisOf(style, options) {
  const width = inchesOf(style.width, 'x', options);
  if (width !== null) return width;
  return inchesOf(style.flexBasis, 'x', options);
}

function layoutFlex(domNode, contentBox, inherited, ctx) {
  const style = ctx.styles.computed(domNode);
  const direction = String(style.flexDirection || 'row').startsWith('column') ? 'column' : 'row';
  const gap = flexGap(style, direction);
  const kids = sortByOrder(elementChildren(domNode).filter((child) => {
    const childStyle = ctx.styles.computed(child);
    return childStyle.display !== 'none' && childStyle.visibility !== 'hidden';
  }), ctx);
  if (!kids.length) return [];

  const alignItems = String(style.alignItems || 'stretch').toLowerCase();
  // An absolute child is anchored to the container, never a flow item.
  const absolute = kids
    .filter((child) => isAbsolute(ctx.styles.computed(child)))
    .map((child) => {
      const slot = anchoredSlot(ctx.styles.computed(child), contentBox, inherited);
      return applyAnchorHints(analyzeNode(child, slot, inherited, ctx), slot);
    })
    .filter(Boolean)
    .map((node) => {
      node.absolute = true;
      return node;
    });
  const flow = kids.filter((child) => !isAbsolute(ctx.styles.computed(child)));

  if (direction === 'column') {
    let cursor = contentBox.y;
    const nodes = flow.map((child) => {
      const childStyle = ctx.styles.computed(child);
      const margins = childMargins(childStyle, { parentWidth: contentBox.w, fontSizePx: inherited.fontPx });
      const explicitWidth = inchesOf(childStyle.width, 'x', { parentWidth: contentBox.w, fontSizePx: inherited.fontPx });
      const slot = {
        x: contentBox.x + margins.left,
        y: cursor + margins.top,
        w: explicitWidth === null ? Math.max(0, contentBox.w - margins.left - margins.right) : explicitWidth,
      explicitWidth: explicitWidth !== null,
        h: null
      };
      const node = analyzeNode(child, slot, inherited, ctx);
      if (node) {
        const self = alignSelfOf(childStyle);
        if (self) node.alignSelf = self;
        cursor = node.y + node.h + gap + margins.bottom;
      }
      return node;
    }).filter(Boolean);
    // Cross-axis alignment inside a column; align-self wins for one child.
    nodes.filter((node) => !node.absolute).forEach((node) => {
      const align = node.alignSelf || alignItems;
      if (align === 'center') node.x = contentBox.x + (contentBox.w - node.w) / 2;
      else if (align === 'end' || align === 'flex-end') node.x = contentBox.x + contentBox.w - node.w;
      else if (align === 'stretch') {
        node.x = contentBox.x;
        node.w = Math.max(node.w, contentBox.w);
      }
    });
    return nodes.concat(absolute);
  }

  const fixed = flow.map((child) => flexBasisOf(ctx.styles.computed(child),
    { parentWidth: contentBox.w, fontSizePx: inherited.fontPx }));
  const weights = flow.map((child, index) => {
    if (fixed[index] !== null) return 0;
    const weight = flexWeightOf(ctx.styles.computed(child));
    return weight > 0 ? weight : 1;
  });
  const fixedTotal = fixed.reduce((sum, value) => sum + (value || 0), 0);
  const weightTotal = weights.reduce((sum, value) => sum + value, 0);
  const free = Math.max(0, contentBox.w - fixedTotal - gap * (flow.length - 1));
  const widths = fixed.map((width, index) => (width !== null
    ? width
    : (weightTotal > 0 ? (free * weights[index]) / weightTotal : 0)));

  const usedWidth = widths.reduce((sum, width) => sum + width, 0) + gap * (flow.length - 1);
  const slack = Math.max(0, contentBox.w - usedWidth);
  const justify = String(style.justifyContent || 'flex-start').toLowerCase();
  let startX = contentBox.x;
  let extraGap = 0;
  if (justify === 'center') startX += slack / 2;
  else if (justify === 'flex-end' || justify === 'end') startX += slack;
  else if (justify === 'space-between' && flow.length > 1) extraGap = slack / (flow.length - 1);
  else if (justify === 'space-around') {
    startX += slack / (flow.length * 2);
    extraGap = slack / flow.length;
  }

  let cursor = startX;
  const nodes = [];
  flow.forEach((child, index) => {
    const node = analyzeNode(child, { x: cursor, y: contentBox.y, w: widths[index], h: null }, inherited, ctx);
    if (node) {
      const self = alignSelfOf(ctx.styles.computed(child));
      if (self) node.alignSelf = self;
      nodes.push(node);
    }
    cursor += widths[index] + gap + extraGap;
  });
  // The row's cross size is its tallest item: stretch fills it, others align in it.
  if (nodes.length) {
    const tallest = nodes.reduce((max, node) => Math.max(max, node.h), 0);
    nodes.filter((node) => !node.absolute).forEach((node) => {
      const align = node.alignSelf || alignItems;
      if (align === 'stretch') node.h = Math.max(node.h, tallest);
      else if (align === 'center') node.y = contentBox.y + (tallest - node.h) / 2;
      else if (align === 'end' || align === 'flex-end') node.y = contentBox.y + tallest - node.h;
    });
  }
  return nodes.concat(absolute);
}

/** Split a track list on top-level whitespace, keeping repeat(...) intact. */
function gridTokens(text) {
  const tokens = [];
  let depth = 0;
  let current = '';
  for (const char of String(text || '')) {
    if (char === '(') depth += 1;
    if (char === ')') depth -= 1;
    if (/\s/u.test(char) && depth === 0) {
      if (current) tokens.push(current);
      current = '';
      continue;
    }
    current += char;
  }
  if (current) tokens.push(current);
  return tokens;
}

function expandGridTracks(tokens) {
  const expanded = [];
  tokens.forEach((token) => {
    const repeat = /^repeat\(\s*(\d+)\s*,\s*(.+)\)$/u.exec(token);
    if (!repeat) {
      if (token !== 'none') expanded.push(token);
      return;
    }
    const inner = gridTokens(repeat[2]);
    const count = Math.min(Number(repeat[1]), 24);
    for (let index = 0; index < count; index += 1) expanded.push(...inner);
  });
  return expanded;
}

/** One track as { fr } (fraction of the free space) or { width } in inches. */
function gridTrackOf(token, contentWidth, fontSizePx) {
  const value = String(token || '').trim().toLowerCase();
  const fr = /^([\d.]+)fr$/u.exec(value);
  if (fr) return { fr: Math.max(0.01, Number(fr[1])) };
  const minmax = /^minmax\(\s*([^,]+?)\s*,\s*(.+)\)$/u.exec(value);
  if (minmax) return gridTrackOf(minmax[2], contentWidth, fontSizePx);
  const length = parseLength(value);
  if (length) {
    const inches = length.unit === '%'
      ? (length.value / 100) * contentWidth
      : toInches(length, { parentWidth: contentWidth, fontSizePx });
    if (Number.isFinite(inches) && inches > 0) return { width: inches };
  }
  // auto / min-content / max-content: an equal share is the closest safe reading.
  return { fr: 1 };
}

function gridTracksOf(style, contentWidth, fontSizePx) {
  const tokens = expandGridTracks(gridTokens(style.gridTemplateColumns));
  return tokens.map((token) => gridTrackOf(token, contentWidth, fontSizePx));
}

/** Fixed tracks keep their width; the rest share what is left by weight. */
function resolveGridSizes(tracks, totalWidth, gap) {
  if (!tracks.length) return [];
  const fixed = tracks.reduce((sum, track) => sum + (track.width || 0), 0);
  const weights = tracks.reduce((sum, track) => sum + (track.fr || 0), 0);
  const free = Math.max(0, totalWidth - fixed - gap * (tracks.length - 1));
  return tracks.map((track) => {
    if (track.width !== undefined) return track.width;
    if (weights <= 0) return 0;
    return (free * (track.fr || 0)) / weights;
  });
}

function layoutGrid(domNode, style, contentBox, inherited, ctx) {
  const columnGap = inchesOf(style.columnGap || style.gap, 'x', {}) || 0;
  const rowGap = inchesOf(style.rowGap || style.gap, 'x', {}) || 0;
  const tracks = gridTracksOf(style, contentBox.w, inherited.fontPx);
  const columns = Math.max(1, tracks.length);
  const sizes = tracks.length
    ? resolveGridSizes(tracks, contentBox.w, columnGap)
    : [Math.max(0, contentBox.w)];
  const columnLeft = (column) => {
    let left = contentBox.x;
    for (let index = 0; index < column; index += 1) left += sizes[index] + columnGap;
    return left;
  };
  const kids = sortByOrder(elementChildren(domNode), ctx);
  const nodes = [];
  let cursorY = contentBox.y;
  for (let start = 0; start < kids.length; start += columns) {
    const row = kids.slice(start, start + columns);
    const rowNodes = [];
    row.forEach((child, column) => {
      const node = analyzeNode(child, {
        x: columnLeft(column),
        y: cursorY,
        w: sizes[Math.min(column, sizes.length - 1)],
        h: null
      }, inherited, ctx);
      if (node) rowNodes.push(node);
    });
    const rowHeight = rowNodes.reduce((max, node) => Math.max(max, node.h), 0);
    rowNodes.forEach((node) => { node.h = Math.max(node.h, rowHeight); });
    nodes.push(...rowNodes);
    cursorY += rowHeight + rowGap;
  }
  nodes.gridTracks = tracks;
  return nodes;
}

function spanOf(cell, attribute, limit) {
  const value = Number(cell.attrs && cell.attrs[attribute]);
  if (!Number.isFinite(value) || value < 2) return 1;
  return Math.min(Math.floor(value), limit);
}

/** <colgroup><col style="width: 30%"> — the only per-column width CSS offers. */
function collectColNodes(domNode) {
  const nodes = [];
  (domNode.children || []).forEach((child) => {
    if (child.tag === 'colgroup') {
      (child.children || []).forEach((column) => {
        if (column.tag === 'col') nodes.push(column);
      });
    } else if (child.tag === 'col') {
      nodes.push(child);
    }
  });
  return nodes;
}

function widthInchesOf(value, contentWidth, fontSizePx) {
  const length = parseLength(value);
  if (!length) return null;
  if (length.unit === '%') return (length.value / 100) * contentWidth;
  const inches = toInches(length, { parentWidth: contentWidth, fontSizePx });
  return inches === null || !Number.isFinite(inches) || inches <= 0 ? null : inches;
}

/**
 * Resolve one width per column. Explicit <col> widths win, then the first row's
 * declared cell widths, and anything still unknown shares what is left; the
 * result is scaled so the columns always fill the table box exactly.
 */
function resolveColumnWidths(domNode, ctx, columns, contentWidth, rows, fontSizePx) {
  if (!columns) return null;
  const widths = new Array(columns).fill(null);

  let cursor = 0;
  collectColNodes(domNode).forEach((column) => {
    const style = ctx.styles.computed(column);
    const declared = widthInchesOf(style.width, contentWidth, fontSizePx);
    const span = Math.max(1, Math.min(Number(column.attrs && column.attrs.span) || 1, 24));
    for (let index = 0; index < span && cursor < columns; index += 1, cursor += 1) {
      widths[cursor] = declared;
    }
  });

  if (widths.every((width) => width === null)) {
    // Fall back to declared first-row cell widths, which is how most authors
    // express table proportions.
    const firstRowDom = (domNode.children || [])
      .flatMap((child) => (child.tag === 'thead' || child.tag === 'tbody' || child.tag === 'tfoot'
        ? (child.children || []) : [child]))
      .filter((child) => child.tag === 'tr')[0];
    if (firstRowDom) {
      const cells = elementChildren(firstRowDom).filter((child) => child.tag === 'td' || child.tag === 'th');
      let index = 0;
      cells.forEach((cell) => {
        const style = ctx.styles.computed(cell);
        const declared = widthInchesOf(style.width, contentWidth, fontSizePx);
        const span = spanOf(cell, 'colspan', columns);
        for (let step = 0; step < span && index < columns; step += 1, index += 1) widths[index] = declared;
      });
    }
  }

  const known = widths.filter((width) => width !== null);
  if (!known.length) return null;
  const knownSum = known.reduce((sum, width) => sum + width, 0);
  const missing = columns - known.length;
  if (missing === 0) {
    if (knownSum <= 0) return null;
    return widths.map((width) => (width / knownSum) * contentWidth);
  }
  const remainder = Math.max(0, contentWidth - knownSum) / missing;
  return widths.map((width) => (width === null ? remainder : width));
}

const CHART_TYPES = new Set(['bar', 'line', 'pie', 'doughnut', 'area']);

/** The first table inside a node, so data-chart works on a wrapper too. */
function findTableNode(domNode) {
  if (domNode.tag === 'table') return domNode;
  let found = null;
  const visit = (node) => {
    (node.children || []).forEach((child) => {
      if (found || child.type !== 'element') return;
      if (child.tag === 'table') {
        found = child;
        return;
      }
      visit(child);
    });
  };
  visit(domNode);
  return found;
}

/** Every row of text cells, so a chart and a table read the same numbers. */
function tableRowTexts(domNode) {
  const rowNodes = [];
  const collect = (node) => {
    (node.children || []).forEach((child) => {
      if (child.type !== 'element') return;
      if (child.tag === 'tr') rowNodes.push(child);
      else if (child.tag === 'thead' || child.tag === 'tbody' || child.tag === 'tfoot') collect(child);
    });
  };
  const tableNode = findTableNode(domNode);
  if (!tableNode) return [];
  collect(tableNode);
  return rowNodes.map((rowNode) => elementChildren(rowNode)
    .filter((cell) => cell.tag === 'td' || cell.tag === 'th')
    .map((cell) => normalizedText(cell).trim()));
}

function numericOrZero(value) {
  const cleaned = String(value === undefined || value === null ? '' : value).replace(/[^0-9.\-]/gu, '');
  const parsed = Number(cleaned);
  return Number.isFinite(parsed) ? parsed : 0;
}

function parseNumberList(value) {
  const text = value === undefined || value === null ? '' : String(value);
  if (!text.trim()) return [];
  return text
    .split(/[,;\s]+/u)
    .map((item) => item.trim())
    .filter((item) => item !== '' && Number.isFinite(Number(item)))
    .map((item) => Number(item));
}

function parseLabelList(value) {
  return String(value || '')
    .split(/[,;]/u)
    .map((item) => item.trim())
    .filter(Boolean);
}

/**
 * CSS cannot express a data series, so a chart must be declared:
 *   <table data-chart="bar">  → first column is the label axis, each further
 *                               column is a series named by the header row
 *   data-chart + data-values  → a single series
 * Guessing a chart from divs is deliberately not attempted.
 */
function readChart(domNode, ctx) {
  const attrs = domNode.attrs || {};
  const requested = String(attrs['data-chart'] || '').trim().toLowerCase();
  if (!requested) return null;
  if (!CHART_TYPES.has(requested)) {
    recordUnsupported(ctx, domNode, 'data-chart', requested,
      'Unknown chart type; use bar, line, pie, doughnut or area');
    return null;
  }

  const options = {};
  const legend = String(attrs['data-chart-legend'] || '').trim().toLowerCase();
  if (legend) options.showLegend = legend === 'true' || legend === '1';
  const title = attrs['data-chart-title'];

  let data = null;
  const rows = tableRowTexts(domNode);
  if (rows.length >= 2) {
    const header = rows[0];
    const body = rows.slice(1);
    const seriesCount = Math.max(0, ...body.map((row) => row.length - 1));
    if (seriesCount >= 1) {
      data = [];
      for (let series = 0; series < seriesCount; series += 1) {
        data.push({
          name: (header[series + 1] || 'Series ' + (series + 1)).trim(),
          labels: body.map((row) => row[0] || ''),
          values: body.map((row) => numericOrZero(row[series + 1]))
        });
      }
    }
  }

  if (!data) {
    const values = parseNumberList(attrs['data-values']);
    if (!values.length) {
      recordUnsupported(ctx, domNode, 'data-chart', requested,
        'A chart needs data: add data-values="1,2,3" or put the numbers in a <table>');
      return null;
    }
    const labels = parseLabelList(attrs['data-labels']);
    data = [{
      name: attrs['data-series'] || 'Series 1',
      labels: labels.length === values.length ? labels : values.map((value, index) => String(index + 1)),
      values
    }];
  }

  const shareChart = requested === 'pie' || requested === 'doughnut';
  if (options.showLegend === undefined) options.showLegend = data.length > 1 || shareChart;
  if (shareChart && options.showPercent === undefined) options.showPercent = true;
  if (title) {
    options.showTitle = true;
    options.title = title;
  }
  return { chartType: requested, data, options };
}

function readTable(domNode, ctx, contentWidth) {
  const rows = [];
  const rowNodes = [];
  const collect = (node) => {
    (node.children || []).forEach((child) => {
      if (child.type !== 'element') return;
      if (child.tag === 'tr') rowNodes.push(child);
      else if (child.tag === 'thead' || child.tag === 'tbody' || child.tag === 'tfoot') collect(child);
    });
  };
  collect(domNode);

  let columns = 0;
  rowNodes.forEach((rowNode) => {
    const cells = elementChildren(rowNode).filter((child) => child.tag === 'td' || child.tag === 'th');
    let spanTotal = 0;
    const mapped = cells.map((cell) => {
      const style = ctx.styles.computed(cell);
      const color = parseColor(style.color);
      const background = backgroundOf(style);
      const weight = String(style.fontWeight || '').toLowerCase();
      const sizePt = parseLength(style.fontSize);
      const colspan = spanOf(cell, 'colspan', 12);
      const rowspan = spanOf(cell, 'rowspan', 64);
      spanTotal += colspan;
      const options = {
        bold: cell.tag === 'th' || weight === 'bold' || Number(weight) >= 600,
        color: color && color.hex ? color.hex : undefined,
        fill: background && background.hex ? { color: background.hex } : undefined,
        fontSize: sizePt ? Number((toInches(sizePt, {}) * 72).toFixed(1)) : undefined,
        align: style.textAlign || (cell.tag === 'th' ? 'left' : undefined)
      };
      if (colspan > 1) options.colspan = colspan;
      if (rowspan > 1) options.rowspan = rowspan;
      return { text: normalizedText(cell), options };
    });
    columns = Math.max(columns, spanTotal);
    rows.push(mapped);
  });

  const colWidths = resolveColumnWidths(domNode, ctx, columns, contentWidth, rows, 16);
  return { rows, columns, colWidths };
}

/** Assign semantic roles to text nodes from class hints and the size ranking. */
function assignRoles(slideNodes) {
  const texts = [];
  const visit = (node) => {
    if (node.kind === 'text') texts.push(node);
    (node.children || []).forEach(visit);
  };
  slideNodes.forEach(visit);
  if (!texts.length) return;
  const sizes = texts.map((node) => node.fontSizePt).sort((a, b) => b - a);
  const largest = sizes[0];
  const smallest = sizes[sizes.length - 1];
  texts.forEach((node) => {
    // Order matters: "subtitle" contains "title", and "kicker" is caption-like.
    if (hasHint(node.classes, CAPTION_CLASS_HINTS)) { node.role = 'caption'; return; }
    if (hasHint(node.classes, HEADING_CLASS_HINTS)) { node.role = 'heading'; return; }
    if (hasHint(node.classes, TITLE_CLASS_HINTS)) { node.role = 'title'; return; }
    if (node.tag === 'h1' || (node.fontSizePt >= largest - 0.01 && largest >= 20)) { node.role = 'title'; return; }
    if (node.tag === 'h2' || node.tag === 'h3' || node.fontSizePt >= largest * 0.8) { node.role = 'heading'; return; }
    if (node.fontSizePt <= smallest + 0.01 && smallest <= 11) { node.role = 'caption'; return; }
    node.role = 'body';
  });
}

function pageSizeInches(options) {
  const size = options.pageSize || 'wide';
  if (size === 'wide') return { width: 13.333, height: 7.5 };
  if (size === 'standard') return { width: 10, height: 7.5 };
  return { width: Number(size.width), height: Number(size.height) };
}

function findSlideElements(root, options) {
  const selectorClass = options.slideClass || 'slide';
  const nodes = [];
  walk(root, (node) => {
    if (node.type !== 'element') return;
    const classes = classList(node);
    if (classes.includes(selectorClass) || node.attrs['data-slide'] !== undefined) nodes.push(node);
  });
  if (nodes.length) return nodes;
  const body = (function find(node) {
    if (node.type !== 'element') return null;
    if (node.tag === 'body') return node;
    for (const child of node.children || []) {
      const found = find(child);
      if (found) return found;
    }
    return null;
  })(root) || root;
  const candidates = elementChildren(body).filter((child) => child.tag !== 'script' && child.tag !== 'style');
  if (candidates.length) return candidates;
  return [body];
}

/**
 * Analyze a whole HTML document into slide layout trees.
 * @returns {{pageSize: object, slides: Array, unsupported: Array, notes: Array, stats: object}}
 */
function analyzeHtml(html, options = {}) {
  const ctx = createContext(html, options);
  const pageSize = pageSizeInches(options);
  const slideElements = findSlideElements(ctx.root, options);
  const slides = [];

  slideElements.forEach((slideNode, index) => {
    const style = ctx.styles.computed(slideNode);
    checkUnsupported(ctx, slideNode, style);
    const padding = boxShorthand(style, 'padding');
    const contentBox = {
      x: padding.left,
      y: padding.top,
      w: pageSize.width - padding.left - padding.right,
      h: pageSize.height - padding.top - padding.bottom
    };
    const background = backgroundOf(style) || { hex: 'FFFFFF', alpha: 1 };
    const gradient = gradientOf(style);
    const slideBorder = parseBorder(style);
    const slideInset = slideBorder ? slideBorder.width / 72 : 0;
    const slidePaddingBox = {
      x: slideInset,
      y: slideInset,
      w: Math.max(0, pageSize.width - slideInset * 2),
      h: Math.max(0, pageSize.height - slideInset * 2)
    };
    const rootContext = { fontPx: 16, parentBox: contentBox, parentPaddingBox: slidePaddingBox };
    const rootDisplay = String(style.display || 'block').toLowerCase();
    // The root is a real box: honour flex/grid instead of forcing block flow.
    const children = rootDisplay === 'grid'
      ? layoutGrid(slideNode, contentBox, rootContext, ctx)
      : (rootDisplay === 'flex'
        ? layoutFlex(slideNode, contentBox, rootContext, ctx)
        : layoutFlow(slideNode, contentBox, rootContext, ctx));
    assignRoles(children);

    // The root is not emitted as a container, so a decoration on it has no host.
    ['before', 'after'].forEach((pseudo) => {
      const declaration = ctx.styles.decoration(slideNode, pseudo);
      if (!declaration) return;
      recordUnsupported(ctx, slideNode, '::' + pseudo, declaration.content,
        'A decoration on the slide root has no container to anchor to; put it on a card or panel');
    });

    slides.push({
      index: index + 1,
      background: background.hex || 'FFFFFF',
      gradient,
      nodes: children
    });
  });

  if (!slides.length) ctx.notes.push('No slide containers were found; the whole document was treated as one slide.');
  const textCount = slides.reduce((sum, slide) => {
    let count = 0;
    const visit = (node) => {
      if (node.kind === 'text') count += 1;
      (node.children || []).forEach(visit);
    };
    slide.nodes.forEach(visit);
    return sum + count;
  }, 0);

  return {
    pageSize,
    slides,
    variables: ctx.stylesheet.variables,
    unsupported: ctx.unsupported,
    notes: ctx.notes,
    stats: {
      slides: slides.length,
      textNodes: textCount,
      unsupportedCount: ctx.unsupported.length
    }
  };
}

module.exports = {
  SUPPORTED_PROPERTIES,
  UNSUPPORTED_ALWAYS,
  KIND_BY_TAG,
  classList,
  hasHint,
  parseColor,
  parseLinearGradient,
  parseBoxShadow,
  parseBorder,
  radiusOf,
  analyzeHtml,
  analyzeNode,
  assignRoles,
  pageSizeInches
};
