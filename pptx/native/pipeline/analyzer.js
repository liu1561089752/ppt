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
const { estimateTextHeight } = require('../engine/text_measure');

const SUPPORTED_PROPERTIES = new Set([
  'display', 'position', 'left', 'top', 'right', 'bottom', 'width', 'height',
  'minWidth', 'minHeight', 'maxWidth', 'maxHeight', 'flex', 'flexDirection',
  'flexWrap', 'gap', 'rowGap', 'columnGap', 'gridTemplateColumns', 'alignItems',
  'justifyContent', 'padding', 'paddingTop', 'paddingRight', 'paddingBottom', 'paddingLeft',
  'margin', 'marginTop', 'marginRight', 'marginBottom', 'marginLeft',
  'color', 'background', 'backgroundColor', 'backgroundImage', 'boxSizing', 'border', 'borderWidth',
  'borderColor', 'borderStyle', 'borderRadius', 'borderTopLeftRadius',
  'borderTopRightRadius', 'borderBottomLeftRadius', 'borderBottomRightRadius',
  'boxShadow', 'opacity', 'fontFamily', 'fontSize', 'fontWeight',
  'fontStyle', 'lineHeight', 'letterSpacing', 'textAlign', 'textTransform',
  'objectFit', 'objectPosition', 'backgroundSize', 'backgroundPosition', 'zIndex', 'visibility'
]);

const UNSUPPORTED_ALWAYS = new Set([
  'overflow', 'borderCollapse', 'transform', 'filter', 'backdropFilter', 'clipPath', 'mask', 'mixBlendMode',
  'animation', 'transition', 'float', 'columns', 'columnCount', 'writingMode',
  'backgroundClip', 'textShadow',
  'textOverflow', 'whiteSpace', 'wordBreak', 'hyphens', 'aspectRatio', 'inset',
  'gridTemplateRows', 'gridAutoRows', 'gridColumn', 'gridRow', 'order',
  'flexBasis', 'flexGrow', 'flexShrink', 'alignSelf', 'justifySelf'
]);

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
  const stylesheet = parseStylesheet(styleBlocks.join('\n'));
  const unsupported = (stylesheet.pseudoSelectors || []).map((selectorText) => ({
    tag: null,
    classes: [],
    property: 'selector',
    value: selectorText,
    reason: 'Pseudo-elements and pseudo-classes describe boxes that do not exist; their rules are not translated'
  }));
  return {
    root,
    stylesheet,
    styles: createStyleResolver(stylesheet),
    nextId: 1,
    unsupported,
    notes: [],
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
  return node;
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
    const slot = {
      x: contentBox.x + margins.left,
      y: isAbsolute(childStyle) ? contentBox.y : cursor + margins.top,
      w: explicitWidth === null ? slotWidth : explicitWidth,
      explicitWidth: explicitWidth !== null,
      h: null,
      parentContentHeight: soloHeight
    };
    const node = analyzeNode(child, slot, inherited, ctx);
    if (!node) return;
    node.absolute = isAbsolute(childStyle);
    nodes.push(node);
    if (!node.absolute) cursor = node.y + node.h + margins.bottom;
  });
  return nodes;
}

function layoutFlex(domNode, contentBox, inherited, ctx) {
  const style = ctx.styles.computed(domNode);
  const direction = String(style.flexDirection || 'row').startsWith('column') ? 'column' : 'row';
  const gap = flexGap(style, direction);
  const kids = elementChildren(domNode).filter((child) => {
    const childStyle = ctx.styles.computed(child);
    return childStyle.display !== 'none' && childStyle.visibility !== 'hidden';
  });
  if (!kids.length) return [];

  const alignItems = String(style.alignItems || 'stretch').toLowerCase();

  if (direction === 'column') {
    let cursor = contentBox.y;
    const nodes = kids.map((child) => {
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
      if (node) cursor = node.y + node.h + gap + margins.bottom;
      return node;
    }).filter(Boolean);
    // Cross-axis alignment inside a column.
    nodes.forEach((node) => {
      if (alignItems === 'center') node.x = contentBox.x + (contentBox.w - node.w) / 2;
      else if (alignItems === 'end' || alignItems === 'flex-end') node.x = contentBox.x + contentBox.w - node.w;
      else if (alignItems === 'stretch') node.w = Math.max(node.w, contentBox.w);
    });
    return nodes;
  }

  const fixed = kids.map((child) => {
    const childStyle = ctx.styles.computed(child);
    return inchesOf(childStyle.width, 'x', { parentWidth: contentBox.w, fontSizePx: inherited.fontPx });
  });
  const weights = kids.map((child, index) => {
    if (fixed[index] !== null) return 0;
    const value = Number(ctx.styles.computed(child).flex);
    return Number.isFinite(value) && value > 0 ? value : 1;
  });
  const fixedTotal = fixed.reduce((sum, value) => sum + (value || 0), 0);
  const weightTotal = weights.reduce((sum, value) => sum + value, 0);
  const free = Math.max(0, contentBox.w - fixedTotal - gap * (kids.length - 1));
  const widths = fixed.map((width, index) => (width !== null
    ? width
    : (weightTotal > 0 ? (free * weights[index]) / weightTotal : 0)));

  const usedWidth = widths.reduce((sum, width) => sum + width, 0) + gap * (kids.length - 1);
  const slack = Math.max(0, contentBox.w - usedWidth);
  const justify = String(style.justifyContent || 'flex-start').toLowerCase();
  let startX = contentBox.x;
  let extraGap = 0;
  if (justify === 'center') startX += slack / 2;
  else if (justify === 'flex-end' || justify === 'end') startX += slack;
  else if (justify === 'space-between' && kids.length > 1) extraGap = slack / (kids.length - 1);
  else if (justify === 'space-around') {
    startX += slack / (kids.length * 2);
    extraGap = slack / kids.length;
  }

  let cursor = startX;
  const nodes = [];
  kids.forEach((child, index) => {
    const node = analyzeNode(child, { x: cursor, y: contentBox.y, w: widths[index], h: null }, inherited, ctx);
    if (node) nodes.push(node);
    cursor += widths[index] + gap + extraGap;
  });
  // Default flex behaviour: every item stretches to the tallest item in the row.
  if (alignItems === 'stretch' && nodes.length) {
    const tallest = nodes.reduce((max, node) => Math.max(max, node.h), 0);
    nodes.forEach((node) => { node.h = Math.max(node.h, tallest); });
  }
  return nodes;
}

function layoutGrid(domNode, style, contentBox, inherited, ctx) {
  const columnText = style.gridTemplateColumns || '';
  const repeat = /repeat\(\s*(\d+)\s*,/u.exec(columnText);
  const columns = repeat ? Number(repeat[1]) : Math.max(1, columnText.split(/\s+/u).filter(Boolean).length || 1);
  const columnGap = inchesOf(style.columnGap || style.gap, 'x', {}) || 0;
  const rowGap = inchesOf(style.rowGap || style.gap, 'x', {}) || 0;
  const cellWidth = Math.max(0, (contentBox.w - columnGap * (columns - 1)) / columns);
  const kids = elementChildren(domNode);
  const nodes = [];
  let cursorY = contentBox.y;
  for (let start = 0; start < kids.length; start += columns) {
    const row = kids.slice(start, start + columns);
    const rowNodes = [];
    row.forEach((child, column) => {
      const node = analyzeNode(child, {
        x: contentBox.x + column * (cellWidth + columnGap),
        y: cursorY,
        w: cellWidth,
        h: null
      }, inherited, ctx);
      if (node) rowNodes.push(node);
    });
    const rowHeight = rowNodes.reduce((max, node) => Math.max(max, node.h), 0);
    rowNodes.forEach((node) => { node.h = Math.max(node.h, rowHeight); });
    nodes.push(...rowNodes);
    cursorY += rowHeight + rowGap;
  }
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

  if (options.showLegend === undefined) options.showLegend = data.length > 1;
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
    const children = layoutFlow(slideNode, contentBox,
      { fontPx: 16, parentBox: contentBox, parentPaddingBox: slidePaddingBox }, ctx);
    assignRoles(children);

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
