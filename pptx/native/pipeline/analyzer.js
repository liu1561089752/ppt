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
const { flexWidths } = require('../engine/flex_size');
const { flexLines, alignLines } = require('../engine/flex_lines');
const {
  placeGridItems,
  gridRowCount,
  gridItemWidth,
  gridItemX,
  resolveRowHeights,
  rowTops,
  spannedHeight
} = require('../engine/grid_place');

const SUPPORTED_PROPERTIES = new Set([
  'display', 'position', 'left', 'top', 'right', 'bottom', 'width', 'height',
  'minWidth', 'minHeight', 'maxWidth', 'maxHeight', 'flex', 'flexDirection',
  'flexWrap', 'flexGrow', 'flexBasis', 'flexShrink', 'gap', 'rowGap', 'columnGap', 'gridTemplateColumns',
  'gridColumn', 'gridRow', 'gridColumnStart', 'gridColumnEnd', 'gridRowStart', 'gridRowEnd',
  'gridArea', 'gridTemplateRows', 'gridAutoRows', 'alignItems', 'justifyItems', 'justifySelf',
  'alignContent',
  'justifyContent', 'alignSelf', 'order', 'transform', 'padding', 'paddingTop', 'paddingRight', 'paddingBottom', 'paddingLeft',
  'margin', 'marginTop', 'marginRight', 'marginBottom', 'marginLeft',
  'color', 'background', 'backgroundColor', 'backgroundImage', 'boxSizing', 'border', 'borderWidth',
  'borderTop', 'borderRight', 'borderBottom', 'borderLeft',
  // Per-side longhands: `border-top: 3px solid` plus `border-top-color: x` is the
  // usual way to recolour one edge, so they fold into the same side declaration.
  'borderTopWidth', 'borderRightWidth', 'borderBottomWidth', 'borderLeftWidth',
  'borderTopStyle', 'borderRightStyle', 'borderBottomStyle', 'borderLeftStyle',
  'borderTopColor', 'borderRightColor', 'borderBottomColor', 'borderLeftColor',
  'borderColor', 'borderStyle', 'borderRadius', 'borderTopLeftRadius',
  'borderTopRightRadius', 'borderBottomLeftRadius', 'borderBottomRightRadius',
  'boxShadow', 'opacity', 'fontFamily', 'fontSize', 'fontWeight',
  'fontStyle', 'lineHeight', 'letterSpacing', 'textAlign', 'textTransform', 'textIndent', 'whiteSpace',
  'writingMode', 'wordBreak', 'float', 'clear', 'aspectRatio',
  'objectFit', 'objectPosition', 'backgroundSize', 'backgroundPosition', 'zIndex', 'visibility'
]);

// `overflow` is deliberately absent from this set: it is reported after layout, and
// only when the box really clips content larger than itself (see `clipsContent`).
const POST_LAYOUT_PROPERTIES = new Set(['overflow']);

const UNSUPPORTED_ALWAYS = new Set([
  'borderCollapse', 'filter', 'backdropFilter', 'clipPath', 'mask', 'mixBlendMode',
  // writing-mode is translated (see applyWritingMode) or reported there.
  'animation', 'transition', 'columns', 'columnCount',
  'backgroundClip', 'textShadow',
  'textOverflow', 'hyphens', 'inset'
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

/** `align-content`, in the shapes the line distributor understands. */
function alignContentOf(style) {
  const value = String(style.alignContent || '').trim().toLowerCase();
  if (!value || value === 'normal') return 'stretch';
  if (value === 'center') return 'center';
  if (value === 'flex-end' || value === 'end') return 'end';
  if (value === 'space-between') return 'space-between';
  if (value === 'space-around' || value === 'space-evenly') return 'space-around';
  if (value === 'stretch') return 'stretch';
  return 'start';
}

/** `justify-self` on the item, in the three shapes the resolver understands. */
function justifyOf(style) {
  const self = String(style.justifySelf || '').trim().toLowerCase();
  if (!self || self === 'auto') return undefined;
  if (self === 'center') return 'center';
  if (self === 'end' || self === 'flex-end' || self === 'right') return 'end';
  if (self === 'start' || self === 'flex-start' || self === 'left') return 'start';
  if (self === 'stretch') return 'stretch';
  return undefined;
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
  clear: ['none'],
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
    // A table cell translates its four sides independently, so a single-side
    // border is not a limitation there (it is for every other element).
    if ((domNode.tag === 'td' || domNode.tag === 'th') && TABLE_CELL_BORDER_PROPERTIES.has(property)) return;
    // `overflow` is judged after layout, against the content it would clip.
    if (POST_LAYOUT_PROPERTIES.has(property)) return;
    if (UNSUPPORTED_ALWAYS.has(property)) {
      recordUnsupported(ctx, domNode, property, style[property], 'CSS feature has no native translation');
    } else if (!SUPPORTED_PROPERTIES.has(property)) {
      recordUnsupported(ctx, domNode, property, style[property], 'Property is outside the supported subset');
    }
  });
  if (style.display === 'inline' || style.display === 'inline-block') {
    recordUnsupported(ctx, domNode, 'display', style.display, 'Inline flow is approximated as a block box');
  }
  // A float value this solver does not know would otherwise be laid out as a block.
  const floatValue = String(style.float || 'none').toLowerCase();
  if (!FLOAT_VALUES.has(floatValue)) {
    recordUnsupported(ctx, domNode, 'float', style.float,
      'Only float: left/right (and their inline-start/inline-end spellings) are laid out');
  }
  // The wrap already breaks a token that cannot fit at grapheme level, which is what
  // `overflow-wrap: break-word`/`anywhere` and `word-break: break-all` ask for, so
  // those values are translated by construction. `keep-all` is the opposite request:
  // it forbids the very break this solver makes between CJK characters.
  const wordBreak = String(style.wordBreak || 'normal').toLowerCase();
  if (wordBreak === 'keep-all' || wordBreak === 'break-word') {
    // `break-word` is the legacy spelling of `overflow-wrap: break-word`, so it is
    // the behaviour we already have; only `keep-all` changes it.
    if (wordBreak === 'keep-all') {
      recordUnsupported(ctx, domNode, 'wordBreak', style.wordBreak,
        'CJK text breaks between characters here; keep-all forbids exactly that break');
    }
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
  // `flex-wrap: wrap` is laid out in real lines by the row branch; a wrapping
  // column still falls back to a single column, so it is reported there instead.
  // A native outline is uniform, so an asymmetric border cannot live on the shape
  // itself. Exactly one declared side is translated into a thin filled shape along
  // that edge (the accent bar on a card), which is a real editable object; any other
  // asymmetric combination is reported instead of silently losing sides.
  const isTableCell = domNode.tag === 'td' || domNode.tag === 'th';
  // One declared side is enough to translate (see `singleBorderSide`); two different
  // sides are reported rather than silently losing one.
  if (!isTableCell && !uniformBorderSides(style) && !singleBorderSide(style)) {
    recordUnsupported(ctx, domNode, 'border',
      BORDER_SIDES.map((side) => side + ': ' + borderSideText(style, side)).join('; '),
      'A native shape outline is uniform; declare every side the same, or use a separate rule/shape');
  }
}

/** The one declared border side of an element, when it is a single-side accent. */
function singleBorderSide(style) {
  if (uniformBorderSides(style)) return null;
  const declared = BORDER_SIDES
    .map((side) => ({ side, border: parseBorder(borderSideDeclaration(style, side)) }))
    .filter((entry) => entry.border && entry.border.width > 0);
  return declared.length === 1 ? declared[0] : null;
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

/**
 * A first-line indent in inches (`text-indent: 2em` in a Chinese paragraph is the
 * common case). DrawingML carries it as `<a:pPr indent="…">`, so it is a text-box
 * property, not a layout shift of the box itself.
 */
function textIndentOf(style, options) {
  const indent = inchesOf(style.textIndent, 'x', options);
  if (indent === null || !Number.isFinite(indent) || indent === 0) return null;
  return indent;
}

function measureTextElement(domNode, style, availableWidth, inheritedFontPx, ctx) {
  const fontPx = fontPxOf(style, inheritedFontPx);
  const fontSizePt = Number((fontPx * 0.75).toFixed(2));
  const { multiple } = lineSpacingOf(style, fontPx);
  const built = buildRuns(domNode, Object.assign({ fontSize: fontPx + 'px' }, style), ctx);
  const textIndent = textIndentOf(style, { parentWidth: availableWidth, fontSizePx: fontPx });
  const measureOptions = { lineHeight: multiple, safetyFactor: 0.92 };
  // A positive indent narrows the first line, which can add a line. A negative one
  // (a hanging indent) widens it; the box model around it is not modelled, so it is
  // reported instead of half-applied.
  if (textIndent && textIndent > 0) measureOptions.firstLineIndentPt = textIndent * 72;
  if (textIndent && textIndent < 0) {
    recordUnsupported(ctx, domNode, 'textIndent', style.textIndent,
      'A negative first-line indent (hanging indent) needs box insets we do not model');
  }
  const transform = String(style.textTransform || '').toLowerCase();
  if (transform && transform !== 'none') {
    built.text = transformText(built.text, transform);
    built.runs.forEach((run) => { run.text = transformText(run.text, transform); });
  }
  const whiteSpace = String(style.whiteSpace || 'normal').toLowerCase();
  const noWrap = whiteSpace === 'nowrap';
  if (whiteSpace !== 'normal' && !noWrap) {
    recordUnsupported(ctx, domNode, 'whiteSpace', style.whiteSpace,
      'Only white-space: nowrap is translated; the pre* values also preserve whitespace, which the DOM text walk already collapsed');
  }
  if (noWrap) measureOptions.noWrap = true;
  return {
    fontPx,
    fontSizePt,
    lineSpacingMultiple: multiple,
    runs: built.hasFormatting ? built.runs : null,
    text: built.text.replace(/\s*\n\s*/gu, '\n').trim(),
    textIndent: textIndent && textIndent > 0 ? textIndent : undefined,
    noWrap: noWrap || undefined,
    textHeight: estimateTextHeight(built.text, Math.max(0.2, availableWidth), fontSizePt, measureOptions)
  };
}

/**
 * Lay out one DOM node inside `slot`.
 * slot = { x, y, w, h } where x/y is the top-left corner and h may be null (auto).
 */
/**
 * True when a node clips and its own content is actually larger than its box, i.e.
 * when translating nothing would visibly differ. A box whose content fits is not
 * reported: `overflow: hidden` then changes no pixel.
 */
function clipsContent(node) {
  const value = String((node.style && node.style.overflow) || '').toLowerCase();
  if (!value || value === 'visible') return false;
  const tolerance = 0.01;
  if (![node.w, node.h].every((number) => Number.isFinite(number) && number > 0)) return false;
  const children = (node.children || []).filter((child) => !child.absolute);
  if (children.length) {
    const right = children.reduce((max, child) => Math.max(max, (child.x || 0) + (child.w || 0)), node.x || 0);
    const bottom = children.reduce((max, child) => Math.max(max, (child.y || 0) + (child.h || 0)), node.y || 0);
    return bottom - (node.y + node.h) > tolerance || right - (node.x + node.w) > tolerance;
  }
  // A leaf: its text can be taller than the fixed height that clips it.
  return Number.isFinite(node.textHeight) && node.textHeight > node.h + tolerance;
}

/**
 * `writing-mode` decides the direction the glyphs run. DrawingML has native values
 * for two of them, so those are translated and the rest are reported:
 *
 *   vertical-rl   → `eaVert`  (East Asian vertical: upright CJK, columns run right
 *                              to left, Latin runs rotated a quarter turn)
 *   sideways-rl   → `vert`    (the whole line rotated clockwise)
 *   vertical-lr / sideways-lr → reported: `verter`/`mongolianVert` means something
 *                              different from either CSS value.
 *
 * The trade the CSS makes is that a vertical box runs the text down its *height*:
 * the box height is the line length and extra text becomes another column, one
 * line-height to the left. So the fit test counts columns, and a box that cannot
 * hold them is reported instead of being drawn on top of its neighbour.
 */
function applyWritingMode(node, domNode, style, measured, explicitHeight, ctx) {
  const value = String(style.writingMode || 'horizontal-tb').toLowerCase();
  if (value === 'horizontal-tb') return;
  const vertical = { 'vertical-rl': 'eaVert', 'sideways-rl': 'vert' }[value];
  if (!vertical) {
    recordUnsupported(ctx, domNode, 'writingMode', value,
      'Only vertical-rl and sideways-rl have a native equivalent; this direction would be upside down');
    return;
  }
  if (explicitHeight === null) {
    recordUnsupported(ctx, domNode, 'writingMode', value,
      'Vertical text needs a declared height: the box height is the line length, so it cannot be derived from the text');
    return;
  }
  node.vert = vertical;
  // The advance is measured once, then divided by the line length the box offers.
  const lengthPt = measureTextPt(String(node.text || ''), measured.fontSizePt);
  const length = Math.max(0.02, lengthPt / 72);
  const lineStep = Math.max(0.02, (measured.fontSizePt * (measured.lineSpacingMultiple || 1.25)) / 72);
  // Padding is not text room, so the length is the content height, not the border box.
  const padding = node.padding || { top: 0, bottom: 0, left: 0, right: 0 };
  const usableHeight = Math.max(0.02, node.h - padding.top - padding.bottom);
  const columns = Math.max(1, Math.ceil(length / usableHeight - 0.02));
  const requiredWidth = columns * lineStep;
  const usableWidth = Number.isFinite(node.contentWidth) ? node.contentWidth : node.w;
  node.textHeight = length;
  if (requiredWidth > usableWidth + 0.01) {
    recordUnsupported(ctx, domNode, 'writingMode', value,
      'Vertical text needs ' + columns + ' column(s) (' + requiredWidth.toFixed(2) + 'in) but the box is '
      + usableWidth.toFixed(2) + 'in wide; widen it or give the text more height');
  }
}

function analyzeNode(domNode, slot, inherited, ctx) {
  const node = analyzeNodeTree(domNode, slot, inherited, ctx);
  if (!node) return null;
  applyHeightConstraints(node, slot, ctx);
  attachDecorations(domNode, node, ctx);
  absoluteChildOverlays(node);
  // One declared border side, on any kind of box, becomes a thin native shape along
  // that edge; the engine places it from the resolved box, so nothing is baked in.
  const isTableCell = domNode.tag === 'td' || domNode.tag === 'th';
  const accent = isTableCell ? null : singleBorderSide(ctx.styles.computed(domNode));
  if (accent) {
    node.edge = { side: accent.side, width: accent.border.width, color: accent.border.color };
    if (accent.border.dash) node.edge.dash = accent.border.dash;
  }
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

/**
 * The number `aspect-ratio` asks for. A block with an auto height is as tall as its
 * used width divided by this, which is what the property means; when the height is
 * declared the ratio changes nothing, and CSS ignores it in that case too.
 */
function aspectRatioOf(style, width) {
  const value = String(style.aspectRatio || '').trim().toLowerCase();
  if (!value || value === 'auto') return null;
  if (value.indexOf('auto') !== -1) return null;
  const parts = value.split('/');
  const ratio = parts.length === 2
    ? Number(parts[0].trim()) / Number(parts[1].trim())
    : Number(value);
  if (!Number.isFinite(ratio) || ratio <= 0) return null;
  if (!Number.isFinite(width) || width <= 0) return null;
  return ratio;
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
  // With an auto height, `aspect-ratio` means "the height follows the used width".
  // That is a real box, not a hint: a 16/9 card in a 600px column is 337.5px tall.
  let explicitHeight = inchesOf(style.height, 'y', { parentWidth, parentHeight: slot.h, fontSizePx });
  const aspectRatio = aspectRatioOf(style, width);
  if (aspectRatio !== null && explicitHeight === null && width > 0) explicitHeight = width / aspectRatio;
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
    // padding box of its positioned ancestor. `fixed` is the exception - it is
    // anchored to the viewport (the slide), not to the nearest positioned parent.
    const parentBox = style.position === 'fixed'
      ? (ctx.viewport || inherited.parentPaddingBox || parentBoxForWidth)
      : (inherited.parentPaddingBox || parentBoxForWidth);
    const absoluteParentWidth = Number.isFinite(parentBox.w) ? parentBox.w : parentWidth;
    const left = inchesOf(style.left, 'x', { parentWidth: absoluteParentWidth, fontSizePx });
    const right = inchesOf(style.right, 'x', { parentWidth: absoluteParentWidth, fontSizePx });
    const top = inchesOf(style.top, 'y', { parentWidth: absoluteParentWidth, parentHeight: parentBox.h, fontSizePx });
    const bottom = inchesOf(style.bottom, 'y', { parentWidth: absoluteParentWidth, parentHeight: parentBox.h, fontSizePx });
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
  // Stretch alignment may size a box on its cross axis, but never one whose own
  // CSS pinned that axis: an 80px chip in a 415px row stays 80px, top aligned.
  if (declaresLength(style.height)) node.fixedHeight = true;
  if (declaresLength(style.width)) node.fixedWidth = true;

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
    applyRelativeShift(node, style, parentWidth);
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
        { lineHeight: measured.lineSpacingMultiple, safetyFactor: 0.92, noWrap: measured.noWrap });
    }
    // Padding and border are part of the box: leaving them out of the height made a
    // padded card shorter than it renders, so a wrapped row put the next line on top
    // of it. The text itself still measures at the content width.
    node.h = explicitHeight === null ? node.textHeight + insetTop + insetBottom : explicitHeight;
    applyWritingMode(node, domNode, style, measured, explicitHeight, ctx);
    applyRelativeShift(node, style, parentWidth);
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
    applyRelativeShift(node, style, parentWidth);
    return node;
  }

  if (kind === 'line') {
    node.h = explicitHeight === null ? 0.02 : explicitHeight;
    applyRelativeShift(node, style, parentWidth);
    return node;
  }

  if (kind === 'table') {
    const table = readTable(domNode, ctx, contentWidth);
    node.rows = table.rows;
    node.columnCount = table.columns;
    node.colWidths = table.colWidths;
    node.rowHeights = table.rowHeights;
    // The height a declared CSS table already knows; otherwise the rows measured from
    // their real padding and line boxes, so the box reserved here matches what is drawn.
    const estimatedRows = (table.rowHeights || []).reduce((sum, height) => sum + height, 0);
    node.h = explicitHeight === null ? Math.max(0.4, estimatedRows) : explicitHeight;
    applyRelativeShift(node, style, parentWidth);
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
    if (node.children.gridRowTracks && node.children.gridRowTracks.length) {
      node.rowTracks = node.children.gridRowTracks;
      delete node.children.gridRowTracks;
    }
    if (node.children.gridAutoRowHeight !== undefined) {
      node.autoRowHeight = node.children.gridAutoRowHeight;
      delete node.children.gridAutoRowHeight;
    }
    // The analyzer decides whether the container has a content height to divide;
    // the engine replays that decision instead of re-deriving it from the box.
    if (node.children.gridContentHeight !== undefined) {
      node.rowContentHeight = node.children.gridContentHeight;
      delete node.children.gridContentHeight;
    }
  } else {
    node.children = layoutFlow(domNode, contentBox, childContext, ctx);
  }

  const contentBottom = node.children.reduce((bottom, child) => {
    const childBottom = child.absolute ? bottom : child.y - relativeDy(child) + child.h;
    return Math.max(bottom, childBottom);
  }, contentBox.y);
  // A child's bottom margin collapses out of its parent only when nothing separates
  // them. With a bottom padding (or border) the margin stays inside the box - which is
  // what a padded card with a trailing paragraph margin actually renders.
  const inFlow = node.children.filter((child) => !child.absolute);
  const lastInFlow = inFlow[inFlow.length - 1];
  const trailingMargin = insetBottom > 0 && lastInFlow
    ? Math.max(0, Number(lastInFlow.margins && lastInFlow.margins.bottom) || 0)
    : 0;
  const autoHeight = Math.max(0, Number((contentBottom - y + trailingMargin + insetBottom).toFixed(4)));
  // A declared height is the box the author asked for, so it is not grown here even
  // when the content measures taller: CSS would let the content spill out, and hiding
  // that difference behind a taller box is how a clipped design stops being reported.
  node.h = explicitHeight === null ? autoHeight : explicitHeight;
  applyRelativeShift(node, style, parentWidth);
  if (node.h <= 0) node.h = 0.02;
  return node;
}

/**
 * `position: relative` moves the box and leaves a hole where it used to be, so the
 * offset is applied after layout and the flow cursor reads the static position back.
 * `sticky` is the same in a slide: there is nothing to scroll, so it never sticks.
 */
function applyRelativeShift(node, style, parentWidth) {
  const position = String(style.position || 'static').toLowerCase();
  if (position !== 'relative' && position !== 'sticky') return;
  const options = { parentWidth, fontSizePx: 16 };
  const offsetX = (inchesOf(style.left, 'x', options) || 0) - (inchesOf(style.right, 'x', options) || 0);
  const offsetY = (inchesOf(style.top, 'y', options) || 0) - (inchesOf(style.bottom, 'y', options) || 0);
  if (!offsetX && !offsetY) return;
  node.staticX = node.x;
  node.staticY = node.y;
  node.x = Number((node.x + offsetX).toFixed(4));
  node.y = Number((node.y + offsetY).toFixed(4));
  node.relativeShift = { dx: Number(offsetX.toFixed(4)), dy: Number(offsetY.toFixed(4)) };
}

function relativeDy(node) {
  return node && node.relativeShift ? node.relativeShift.dy : 0;
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
  // CSS anchors absolute children to the padding box of their containing block.
  const anchorBox = (inherited && inherited.parentPaddingBox) || contentBox;
  const nodes = [];
  let cursor = contentBox.y;
  const visible = elementChildren(domNode).filter((child) => {
    const childStyle = ctx.styles.computed(child);
    return childStyle.display !== 'none' && childStyle.visibility !== 'hidden';
  });
  // A lone chart child has no content to measure, so a definite parent height is
  // its height; with siblings that would just overlap them.
  const soloHeight = visible.length === 1 ? contentBox.h : null;
  let floatedBefore = false;
  for (let index = 0; index < visible.length; index += 1) {
    const child = visible[index];
    const childStyle = ctx.styles.computed(child);
    if (floatOf(childStyle)) {
      // A run of consecutive floats is a row: `float: left` packs from the start edge
      // and wraps when the width runs out, which is a wrapping flex row. What a float
      // also does - shorten the line boxes of the blocks beside it - is not modelled
      // and is reported where it would show.
      const run = [];
      while (index < visible.length) {
        const next = visible[index];
        const nextStyle = ctx.styles.computed(next);
        if (!floatOf(nextStyle)) break;
        run.push({ child: next, style: nextStyle });
        index += 1;
      }
      index -= 1;
      const placed = layoutFloatRun(run, contentBox, cursor, inherited, ctx);
      placed.nodes.forEach((node) => nodes.push(node));
      // A float shortens the line boxes of the blocks beside it. When the text that
      // follows fits entirely inside the band the float occupies, the pair is exactly a
      // two-column row and is translated; anything else stays reported.
      const bandTop = cursor;
      const band = placed.band;
      let paired = 0;
      if (band) {
        const group = [];
        let remaining = placed.bottom - bandTop;
        let probe = index + 1;
        while (probe < visible.length && remaining > FLOAT_BAND_SLACK) {
          const candidateStyle = ctx.styles.computed(visible[probe]);
          const metrics = floatCompanionMetrics(visible[probe], candidateStyle, band, inherited);
          if (!metrics) break;
          const height = metrics.marginTop + metrics.height + metrics.marginBottom;
          if (height > remaining + 0.001) break;
          group.push({ child: visible[probe], metrics, height });
          remaining -= height;
          probe += 1;
        }
        // Nothing may be left over that the browser would still have wrapped beside the
        // float, so the band has to end exactly at the content or run out of children.
        const exact = probe >= visible.length || remaining <= FLOAT_BAND_SLACK;
        if (group.length && exact) {
          let offset = 0;
          group.forEach((entry) => {
            const slot = {
              x: band.x,
              y: bandTop + offset + entry.metrics.marginTop,
              w: band.w,
              h: null
            };
            const node = applyAnchorHints(analyzeNode(entry.child, slot, inherited, ctx), slot);
            if (node) {
              node.absolute = false;
              nodes.push(node);
            }
            offset += entry.height;
          });
          index = probe - 1;
          paired = group.length;
        }
      }
      cursor = placed.bottom;
      floatedBefore = paired === 0;
      continue;
    }
    if (floatedBefore) {
      // Only the block that directly follows the run would have been shortened by it;
      // everything after that one is already below the float anyway. An absolutely
      // positioned block is not in the flow at all, so a float cannot shorten it.
      const clears = hasClear(childStyle);
      if (!clears && !isAbsolute(childStyle) && String(normalizedText(child) || '').trim().length > 0) {
        recordUnsupported(ctx, child, 'float', 'left/right',
          'A block that follows a float is placed below it; the browser would wrap its lines beside the float');
      }
      floatedBefore = false;
    }
    const margins = childMargins(childStyle, { parentWidth: contentBox.w, fontSizePx: inherited.fontPx });
    const slotWidth = Math.max(0, contentBox.w - margins.left - margins.right);
    const explicitWidth = inchesOf(childStyle.width, 'x', { parentWidth: contentBox.w, fontSizePx: inherited.fontPx });
    const slot = isAbsolute(childStyle)
      ? anchoredSlot(childStyle, containingBlockFor(childStyle, anchorBox, ctx), inherited)
      : {
        x: contentBox.x + margins.left,
        y: cursor + margins.top,
        w: explicitWidth === null ? slotWidth : explicitWidth,
        explicitWidth: explicitWidth !== null,
        h: null,
        parentContentHeight: soloHeight
      };
    const node = applyAnchorHints(analyzeNode(child, slot, inherited, ctx), slot);
    if (!node) continue;
    node.absolute = isAbsolute(childStyle);
    nodes.push(node);
    if (!node.absolute) cursor = node.y - relativeDy(node) + node.h + margins.bottom;
  }
  return nodes;
}

/**
 * `clear` asks to start below the floats above. This flow always places the next
 * block after a float run, so the declaration is already honoured.
 */
function hasClear(style) {
  return String(style.clear || 'none').toLowerCase() !== 'none';
}

/** How close to a full band counts as full: a leftover thinner than one text line. */
const FLOAT_BAND_SLACK = 0.05;

/**
 * Height of a text block once it is narrowed to the band, or `null` when the block is
 * not a plain text box. A block that paints something (a background, a border, padding)
 * spans the full width in CSS even while its lines are shortened, so narrowing it would
 * move the paint and the translation would stop being exact.
 */
function floatCompanionMetrics(child, style, band, inherited) {
  if (isAbsolute(style)) return null;
  if (elementChildren(child).length > 0) return null;
  const text = String(normalizedText(child) || '').trim();
  if (!text) return null;
  if (backgroundOf(style)) return null;
  if (parseBorder(style)) return null;
  const padding = boxShorthand(style, 'padding');
  if (padding.top || padding.right || padding.bottom || padding.left) return null;
  if (declaresLength(style.width)) return null;
  if (style.writingMode) return null;
  const margins = childMargins(style, { parentWidth: band.w, fontSizePx: inherited.fontPx });
  if (margins.left || margins.right) return null;
  const fontPx = fontPxOf(style, inherited.fontPx);
  const fontSizePt = Number((fontPx * 0.75).toFixed(2));
  const lineHeight = lineSpacingOf(style, fontPx).multiple;
  const height = estimateTextHeight(text, band.w, fontSizePt, { marginIn: 0, lineHeight });
  return { height, marginTop: margins.top, marginBottom: margins.bottom };
}

/** A CSS length that pins an axis; `auto`, `none` and the keywords do not. */
function declaresLength(value) {
  if (value === undefined || value === null) return false;
  const text = String(value).trim().toLowerCase();
  return text !== '' && text !== 'auto' && text !== 'none'
    && text !== 'initial' && text !== 'inherit' && text !== 'unset';
}

/** `float: left|right` that has to be laid out; `none` and unset are not floats. */
function floatOf(style) {
  const value = String(style.float || 'none').toLowerCase();
  if (value === 'left' || value === 'inline-start') return 'left';
  if (value === 'right' || value === 'inline-end') return 'right';
  return null;
}

const FLOAT_VALUES = new Set(['none', 'left', 'right', 'inline-start', 'inline-end']);

/**
 * Lay a run of floated siblings out as a wrapping row and report the bottom of the
 * run. Floats pack against one edge and wrap when the line is full, so a line is as
 * tall as its tallest item and the next line starts below it.
 */
function layoutFloatRun(run, contentBox, top, inherited, ctx) {
  const options = { parentWidth: contentBox.w, fontSizePx: inherited.fontPx };
  const directions = new Set(run.map((entry) => floatOf(entry.style)));
  if (directions.size > 1) {
    recordUnsupported(ctx, run[0].child, 'float', 'left and right',
      'Left and right floats on one line pack from opposite edges; this run is packed from one edge');
  }
  const direction = floatOf(run[0].style) || 'left';
  const tolerance = 0.01;
  let runWidth = 0;
  const nodes = [];
  let lineTop = top;
  let lineHeight = 0;
  let cursorX = direction === 'right' ? contentBox.x + contentBox.w : contentBox.x;
  let lines = 1;
  const startLine = () => {
    lineTop += lineHeight;
    lineHeight = 0;
    cursorX = direction === 'right' ? contentBox.x + contentBox.w : contentBox.x;
    lines += 1;
  };

  run.forEach((entry) => {
    const margins = childMargins(entry.style, options);
    const declared = inchesOf(entry.style.width, 'x', options);
    if (declared === null) {
      // Shrink-to-fit is max-content, which a container does not measure.
      recordUnsupported(ctx, entry.child, 'float', floatOf(entry.style),
        'A floated box needs a declared width here: its shrink-to-fit width is not measured');
    }
    const width = Math.max(0.02, declared === null ? contentBox.w : declared);
    const outer = width + margins.left + margins.right;
    runWidth += outer;
    const fits = direction === 'right'
      ? cursorX - outer >= contentBox.x - tolerance
      : cursorX + outer <= contentBox.x + contentBox.w + tolerance;
    if (!fits && lineHeight > 0) startLine();
    const slot = {
      x: direction === 'right' ? cursorX - margins.right - width : cursorX + margins.left,
      y: lineTop + margins.top,
      w: width,
      explicitWidth: declared !== null,
      h: null,
      parentContentHeight: contentBox.h === undefined ? null : contentBox.h
    };
    const node = applyAnchorHints(analyzeNode(entry.child, slot, inherited, ctx), slot);
    if (!node) return;
    node.absolute = false;
    // The emitted geometry of a float row is the analyzer's; a declarative container
    // would re-run the flow as a column and stack the very items that pack in a row.
    node.floated = direction;
    nodes.push(node);
    const height = node.h + margins.top + margins.bottom;
    if (height > lineHeight) lineHeight = height;
    cursorX = direction === 'right' ? cursorX - outer : cursorX + outer;
  });

  // The strip this run leaves free, but only while it stays on one line: a run that
  // wrapped leaves a band that differs per line, and a single text box cannot express
  // that, so the caller keeps reporting instead.
  const bandWidth = contentBox.w - runWidth;
  const band = lines === 1 && bandWidth > 0.5
    ? { x: direction === 'right' ? contentBox.x : contentBox.x + runWidth, w: bandWidth }
    : null;
  return { nodes, bottom: nodes.length ? lineTop + lineHeight : top, band };
}

/**
 * Resolve an absolutely positioned child against its container box. Percentages
 * resolve against the container, and `left/right` plus `top/bottom` are
 * interchangeable, exactly like CSS.
 */
/**
 * The containing block for an out-of-flow child. `position: fixed` is anchored to
 * the viewport - the slide itself - rather than to the nearest positioned
 * ancestor, which is what a footer pinned with `bottom: 20px` means in a slide.
 */
function containingBlockFor(style, contentBox, ctx) {
  if (!style || style.position !== 'fixed') return contentBox;
  return (ctx && ctx.viewport) || contentBox;
}

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
 * The growth factor a flex item declares, 0 when it declares none (a plain width
 * does not grow). The caller decides what an undeclared grow means for its layout.
 */
function flexWeightOf(style) {
  const grow = Number(style.flexGrow);
  if (Number.isFinite(grow) && grow >= 0) return grow;
  const shorthand = String(style.flex === undefined ? '' : style.flex).trim().toLowerCase();
  if (shorthand === 'none') return 0;
  const first = Number(shorthand.split(/\s+/u)[0]);
  return Number.isFinite(first) && first >= 0 ? first : 0;
}

/** The shrink factor of a flex item: `flex-shrink`, then the `flex` shorthand, then 1. */
function flexShrinkOf(style) {
  const shrink = Number(style.flexShrink);
  if (Number.isFinite(shrink) && shrink >= 0) return shrink;
  const shorthand = String(style.flex === undefined ? '' : style.flex).trim().toLowerCase();
  if (shorthand === 'none') return 0;
  const parts = shorthand.split(/\s+/u);
  if (parts.length > 1) {
    const second = Number(parts[1]);
    if (Number.isFinite(second) && second >= 0) return second;
  }
  return 1;
}

/** A flex item's base size: the declared width, then `flex-basis`, then auto. */
function flexBasisOf(style, options) {
  const width = inchesOf(style.width, 'x', options);
  if (width !== null) return width;
  const longhand = inchesOf(style.flexBasis, 'x', options);
  if (longhand !== null) return longhand;
  // `flex: <grow> <shrink> <basis>` and `flex: <grow> <basis>` carry it too.
  const tokens = String(style.flex === undefined ? '' : style.flex).trim().toLowerCase().split(/\s+/u);
  for (let index = tokens.length - 1; index >= 1; index -= 1) {
    const inches = inchesOf(tokens[index], 'x', options);
    if (inches !== null) return inches;
  }
  return null;
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
      const childStyle = ctx.styles.computed(child);
      const anchorBox = (inherited && inherited.parentPaddingBox) || contentBox;
      const slot = anchoredSlot(childStyle, containingBlockFor(childStyle, anchorBox, ctx), inherited);
      return applyAnchorHints(analyzeNode(child, slot, inherited, ctx), slot);
    })
    .filter(Boolean)
    .map((node) => {
      node.absolute = true;
      return node;
    });
  const flow = kids.filter((child) => !isAbsolute(ctx.styles.computed(child)));

  if (direction === 'column') {
    const columnOptions = { parentWidth: contentBox.w, fontSizePx: inherited.fontPx };
    let cursor = contentBox.y;
    const measured = flow.map((child) => {
      const childStyle = ctx.styles.computed(child);
      const margins = childMargins(childStyle, columnOptions);
      const explicitWidth = inchesOf(childStyle.width, 'x', columnOptions);
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
        if (declaresLength(childStyle.width)) node.fixedWidth = true;
        if (declaresLength(childStyle.height)) node.fixedHeight = true;
        cursor = node.y - relativeDy(node) + node.h + gap + margins.bottom;
      }
      return { node, margins, style: childStyle };
    }).filter((entry) => entry.node);
    const nodes = measured.map((entry) => entry.node);

    // The main axis of a column is vertical, so `flex-grow`/`flex-shrink` size *heights*
    // and `justify-content` distributes what is left - the same arithmetic and the same
    // free-space rule the row branch uses, which is why the engine replays it exactly.
    const inner = Number.isFinite(contentBox.h) ? Math.max(0, contentBox.h) : null;
    if (inner !== null && nodes.length) {
      const gapTotal = gap * Math.max(0, nodes.length - 1);
      const heights = flexWidths(measured.map(({ node, margins, style }) => ({
        base: node.h + margins.top + margins.bottom,
        grow: flexWeightOf(style),
        shrink: flexShrinkOf(style)
      })), Math.max(0, inner - gapTotal));
      measured.forEach((entry, index) => {
        const boxHeight = Math.max(0, heights[index] - entry.margins.top - entry.margins.bottom);
        if (Math.abs(boxHeight - entry.node.h) > 0.0005) {
          // The width does not change, so the text keeps its line breaks; only the box
          // the CSS asked for moves (that is what `flex: 1` on a block means).
          entry.node.h = boxHeight;
        }
      });
    }

    // Cross-axis alignment inside a column; align-self wins for one child.
    nodes.filter((node) => !node.absolute).forEach((node) => {
      const align = node.alignSelf || alignItems;
      if (align === 'center') node.x = contentBox.x + (contentBox.w - node.w) / 2;
      else if (align === 'end' || align === 'flex-end') node.x = contentBox.x + contentBox.w - node.w;
      else if (align === 'stretch' && !node.fixedWidth) {
        node.x = contentBox.x;
        node.w = Math.max(node.w, contentBox.w);
      }
    });

    // Then the block itself: `justify-content` places the stack in the leftover height.
    // The stack is rewritten even with no leftover, because main-axis flexing above may
    // have changed the heights the cursor was walked with.
    if (inner !== null && nodes.length) {
      const stack = measured.reduce((sum, { node, margins }, index) =>
        sum + node.h + margins.top + margins.bottom + (index < measured.length - 1 ? gap : 0), 0);
      const free = Math.max(0, inner - stack);
      const justify = String(style.justifyContent || 'flex-start').toLowerCase();
      let offset = 0;
      let extra = 0;
      if (justify === 'center') offset = free / 2;
      else if (justify === 'flex-end' || justify === 'end') offset = free;
      else if (justify === 'space-between' && measured.length > 1) extra = free / (measured.length - 1);
      else if (justify === 'space-around') {
        offset = free / (2 * measured.length);
        extra = free / measured.length;
      }
      {
        let line = contentBox.y + offset;
        measured.forEach(({ node, margins }) => {
          node.y = line + margins.top;
          line += node.h + margins.top + margins.bottom + gap + extra;
        });
      }
    }
    return nodes.concat(absolute);
  }

  const options = { parentWidth: contentBox.w, fontSizePx: inherited.fontPx };
  const bases = flow.map((child) => flexBasisOf(ctx.styles.computed(child), options));
  const grows = flow.map((child, index) => {
    if (bases[index] !== null) return flexWeightOf(ctx.styles.computed(child));
    const declared = flexWeightOf(ctx.styles.computed(child));
    // An item with neither a base nor a declared grow shares equally (flex: 1).
    return declared > 0 ? declared : 1;
  });
  const shrinks = flow.map((child) => flexShrinkOf(ctx.styles.computed(child)));
  const available = Math.max(0, contentBox.w - gap * (flow.length - 1));
  const items = flow.map((child, index) => ({
    base: bases[index] === null ? 0 : bases[index],
    grow: grows[index],
    shrink: shrinks[index]
  }));
  const wrapValue = String(style.flexWrap || 'nowrap').toLowerCase();
  const wraps = wrapValue.startsWith('wrap');
  if (wrapValue && !wraps && wrapValue !== 'nowrap') {
    recordUnsupported(ctx, domNode, 'flexWrap', style.flexWrap,
      'Only flex-wrap: wrap and nowrap are translated');
  }
  // A wrapping row breaks into lines before growing; a single line is the same
  // computation with one group, so both paths share the code below.
  const lines = wraps
    ? flexLines(items, contentBox.w, gap)
    : [{
      indices: flow.map((child, index) => index),
      widths: flexWidths(items, available)
    }];

  const justify = String(style.justifyContent || 'flex-start').toLowerCase();
  const nodes = [];
  const lineGroups = [];
  let lineTop = contentBox.y;
  lines.forEach((line) => {
    const widthsInLine = line.widths;
    const count = line.indices.length;
    const usedLine = widthsInLine.reduce((sum, width) => sum + width, 0) + gap * (count - 1);
    const slack = Math.max(0, contentBox.w - usedLine);
    let startX = contentBox.x;
    let extraGap = 0;
    if (justify === 'center') startX += slack / 2;
    else if (justify === 'flex-end' || justify === 'end') startX += slack;
    else if (justify === 'space-between' && count > 1) extraGap = slack / (count - 1);
    else if (justify === 'space-around') {
      startX += slack / (count * 2);
      extraGap = slack / count;
    }

    let cursor = startX;
    const lineNodes = [];
    line.indices.forEach((index, position) => {
      const child = flow[index];
      const node = analyzeNode(child, { x: cursor, y: lineTop, w: widthsInLine[position], h: null }, inherited, ctx);
      if (node) {
        const self = alignSelfOf(ctx.styles.computed(child));
        if (declaresLength(ctx.styles.computed(child).height)) node.fixedHeight = true;
        if (self) node.alignSelf = self;
        if (declaresLength(ctx.styles.computed(child).width)) node.fixedWidth = true;
        // The engine replays these three numbers instead of re-reading the cascade.
        // A wrapped row states the base explicitly (0 = no base) so the engine
        // re-breaks the same lines instead of using the already distributed width.
        if (bases[index] !== null) node.flexBasis = bases[index];
        else if (wraps) node.flexBasis = 0;
        node.flexGrow = grows[index];
        node.flexShrink = shrinks[index];
        nodes.push(node);
        lineNodes.push(node);
      }
      cursor += widthsInLine[position] + gap + extraGap;
    });
    // Each line's cross size is its own tallest item: stretch fills it, others
    // align inside it, and the next line starts below it.
    const tallestInLine = lineNodes.reduce((max, node) => Math.max(max, node.h), 0);
    lineNodes.forEach((node) => {
      const align = node.alignSelf || alignItems;
      if (align === 'stretch' && !node.fixedHeight) node.h = Math.max(node.h, tallestInLine);
      else if (align === 'center') node.y = lineTop + (tallestInLine - node.h) / 2;
      else if (align === 'end' || align === 'flex-end') node.y = lineTop + tallestInLine - node.h;
    });
    lineGroups.push({ nodes: lineNodes, top: lineTop, height: tallestInLine });
    lineTop += tallestInLine + gap;
  });
  // `align-content` places the block of lines inside a height the CSS pinned. The shared
  // helper decides it, so the engine distributes the same leftover the same way.
  const linesHeight = Math.max(0, lineTop - gap - contentBox.y);
  const alignContent = alignContentOf(style);
  const distribution = alignLines(
    lineGroups.map((group) => group.height), linesHeight, contentBox.h, alignContent
  );
  if (distribution.some((entry) => entry.top || entry.extra)) {
    let cursor = contentBox.y;
    lineGroups.forEach((group, index) => {
      const { top, extra } = distribution[index];
      const lineTop = cursor + top;
      const lineHeight = group.height + extra;
      group.nodes.forEach((node) => {
        const align = node.alignSelf || alignItems;
        // `stretch` hands the leftover to the line, and a stretched item fills it.
        if (align === 'stretch' && !node.fixedHeight) node.h = lineHeight;
        // The cross-axis alignment is resolved against the *grown* line, so it is
        // recomputed here rather than before the distribution was known.
        if (align === 'center') node.y = lineTop + (lineHeight - node.h) / 2;
        else if (align === 'end' || align === 'flex-end') node.y = lineTop + lineHeight - node.h;
        else node.y = lineTop;
      });
      cursor += lineHeight + gap;
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

/**
 * Row tracks from `grid-template-rows`. Fixed lengths and percentages (against a
 * declared height) become inches; `auto` stays content-sized and `fr` stays
 * symbolic, because the leftover it divides is only known after the rows are
 * sized. The engine replays the same tracks against the same content height.
 */
function gridRowTracksOf(style, contentHeight, fontSizePx) {
  const tokens = expandGridTracks(gridTokens(style.gridTemplateRows));
  if (!tokens.length) return [];

  const readToken = (token) => {
    const value = String(token || '').trim().toLowerCase();
    const fr = /^([\d.]+)fr$/u.exec(value);
    if (fr) return { fr: Math.max(0.01, Number(fr[1])) };
    const minmax = /^minmax\(\s*([^,]+?)\s*,\s*(.+)\)$/u.exec(value);
    if (minmax) return readToken(minmax[2]);
    const length = parseLength(value);
    if (length && length.unit !== '%') {
      const inches = toInches(length, { parentHeight: contentHeight, fontSizePx });
      if (Number.isFinite(inches) && inches > 0) return { height: inches };
    }
    if (length && length.unit === '%' && contentHeight !== null) {
      return { height: (length.value / 100) * contentHeight };
    }
    return { auto: true };
  };

  return tokens.map(readToken);
}

/** `grid-auto-rows` as a fixed height; null when the implicit rows fit content. */
function autoRowHeightOf(style, fontSizePx) {
  const raw = style.gridAutoRows;
  const value = String(raw === undefined || raw === null ? '' : raw).trim().toLowerCase();
  if (!value || value === 'auto' || value === 'min-content' || value === 'max-content') return null;
  const length = parseLength(value);
  if (!length || length.unit === '%') return null;
  const inches = toInches(length, { fontSizePx });
  return Number.isFinite(inches) && inches > 0 ? inches : null;
}

/**
 * Resolve one side of `grid-column`/`grid-row` to 0-based cell indices.
 *
 * `lineCount` is how many tracks exist on that axis; negative line numbers count back
 * from the last line (`-1` is the line after the last track), which CSS only allows when
 * the explicit grid is known. A named line cannot be resolved here, so it is flagged.
 */
function gridPlacementOf(value, lineCount) {
  const text = String(value === undefined || value === null ? '' : value).trim().toLowerCase();
  if (!text || text === 'auto') return { start: null, end: null, span: 1, named: false };
  const cellOf = (token) => {
    if (token === 'auto') return null;
    const number = Number(token);
    if (!Number.isFinite(number) || number === 0) return undefined; // not a plain line
    if (number > 0) return number - 1;
    // `-1` is the line after the last track, so counting back needs one extra line.
    return lineCount === null ? undefined : lineCount + 1 + number;
  };
  const spanOf = (token) => {
    const match = /^span\s+(\d+)$/u.exec(token);
    return match ? Number(match[1]) : null;
  };
  const parts = text.split('/').map((part) => part.trim());
  if (parts.length === 1) {
    const span = spanOf(parts[0]);
    if (span !== null) return { start: null, end: null, span, named: false };
    const cell = cellOf(parts[0]);
    if (cell === null) return { start: null, end: null, span: 1, named: false };
    if (cell === undefined) return { start: null, end: null, span: 1, named: true };
    return { start: cell, end: cell + 1, span: 1, named: false };
  }
  const endSpan = spanOf(parts[1]);
  const startCell = cellOf(parts[0]);
  if (startCell === undefined) return { start: null, end: null, span: endSpan || 1, named: true };
  if (endSpan !== null) {
    return { start: startCell, end: startCell === null ? null : startCell + endSpan, span: endSpan, named: false };
  }
  const endCell = cellOf(parts[1]);
  if (endCell === undefined) return { start: startCell, end: null, span: 1, named: true };
  if (startCell === null && endCell === null) return { start: null, end: null, span: 1, named: false };
  if (startCell === null) return { start: Math.max(0, endCell - 1), end: endCell, span: 1, named: false };
  if (endCell === null) return { start: startCell, end: null, span: 1, named: false };
  const start = Math.min(startCell, endCell);
  const end = Math.max(startCell + 1, endCell);
  return { start, end, span: Math.max(1, end - start), named: false };
}

/** Join a `grid-column`/`grid-row` shorthand with its longhands, shorthand first. */
function gridAxisValue(style, axis) {
  const shorthand = axis === 'column' ? style.gridColumn : style.gridRow;
  if (shorthand !== undefined && String(shorthand).trim() !== '') return shorthand;
  const start = axis === 'column' ? style.gridColumnStart : style.gridRowStart;
  const end = axis === 'column' ? style.gridColumnEnd : style.gridRowEnd;
  if (start === undefined && end === undefined) return '';
  return String(start === undefined ? 'auto' : start).trim() + ' / '
    + String(end === undefined ? 'auto' : end).trim();
}

/** The spans and starts a grid item declares, plus anything that cannot be resolved. */
function gridPlacementSpec(style, columnCount, rowCount) {
  // `grid-area: row-start / column-start / row-end / column-end` is a shorthand for all
  // four longhands, so it wins when it is present.
  const area = String(style.gridArea === undefined ? '' : style.gridArea).trim();
  if (area && area.toLowerCase() !== 'auto') {
    const parts = area.split('/').map((part) => part.trim());
    if (parts.length === 4) {
      const row = gridPlacementOf(parts[0] + ' / ' + parts[2], rowCount);
      const column = gridPlacementOf(parts[1] + ' / ' + parts[3], columnCount);
      return {
        columnStart: column.start,
        columnEnd: column.end,
        columnSpan: column.span,
        rowStart: row.start,
        rowEnd: row.end,
        rowSpan: row.span,
        named: column.named || row.named
      };
    }
    // A bare name is a named area, which needs `grid-template-areas`.
    return { columnStart: null, columnEnd: null, columnSpan: 1, rowStart: null, rowEnd: null, rowSpan: 1, named: true };
  }
  const column = gridPlacementOf(gridAxisValue(style, 'column'), columnCount);
  const row = gridPlacementOf(gridAxisValue(style, 'row'), rowCount);
  return {
    columnStart: column.start,
    columnEnd: column.end,
    columnSpan: column.span,
    rowStart: row.start,
    rowEnd: row.end,
    rowSpan: row.span,
    named: column.named || row.named
  };
}

function visibleChildren(domNode, ctx) {
  return elementChildren(domNode).filter((child) => {
    const childStyle = ctx.styles.computed(child);
    return childStyle.display !== 'none' && childStyle.visibility !== 'hidden';
  });
}

/** Move a laid-out subtree vertically (heights never depend on y). */
/**
 * Move a laid-out subtree. A height never depends on y and an inline offset is a
 * constant, so children simply follow their container on both axes.
 */
function shiftSubtree(node, deltaY, deltaX = 0) {
  if (!node) return;
  if (Number.isFinite(node.y) && deltaY) node.y += deltaY;
  if (Number.isFinite(node.x) && deltaX) node.x += deltaX;
  (node.children || []).forEach((child) => shiftSubtree(child, deltaY, deltaX));
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
    for (let index = 0; index < column; index += 1) left += sizes[Math.min(index, sizes.length - 1)] + columnGap;
    return left;
  };
  const spanWidth = (column, span) => {
    let width = 0;
    for (let index = column; index < column + span; index += 1) {
      width += sizes[Math.min(index, sizes.length - 1)];
    }
    return width + columnGap * Math.max(0, span - 1);
  };

  const kids = sortByOrder(visibleChildren(domNode, ctx), ctx);
  // A negative row line counts back from the last line, which only exists once the
  // explicit row tracks are known.
  const rowCount = gridRowTracksOf(style, contentBox.h, inherited.fontPx).length || null;
  const plans = kids.map((child) => {
    const childStyle = ctx.styles.computed(child);
    const placement = gridPlacementSpec(childStyle, columns, rowCount);
    if (placement.named) {
      recordUnsupported(ctx, child, 'gridColumn', gridAxisValue(childStyle, 'column'),
        'Named grid lines and areas are not modelled; the item is auto-placed with its span width');
    }
    return placement;
  });

  const placements = placeGridItems(plans, columns);
  // A grid cell gives the item a width, but a declared width wins over the default
  // `stretch`. The item has to be *measured* at that width, not at the cell's, or its
  // own text would be wrapped against a box it does not have.
  const cells = kids.map((child, index) => {
    const place = placements[index];
    const childStyle = ctx.styles.computed(child);
    const cellLeft = columnLeft(place.column);
    const cellWidth = spanWidth(place.column, place.columnSpan);
    const declaredWidth = inchesOf(childStyle.width, 'x', { parentWidth: cellWidth, fontSizePx: inherited.fontPx });
    return { childStyle, cellLeft, cellWidth, declaredWidth, width: gridItemWidth(cellWidth, declaredWidth) };
  });
  const nodes = kids.map((child, index) => analyzeNode(child, {
    x: cells[index].cellLeft,
    y: contentBox.y,
    w: cells[index].width,
    h: null
  }, inherited, ctx));

  // A declared height is authoritative: it neither grows nor gets stretched.
  const declared = kids.map((child) => ctx.styles.computed(child).height !== undefined);
  const heights = nodes.map((node) => (node && Number.isFinite(node.h) ? node.h : 0));
  const rows = gridRowCount(placements);
  // Row tracks resolve here, against the declared height, so the engine can
  // replay the same tracks instead of re-reading the cascade.
  const paddingTop = inchesOf(style.paddingTop, 'y', {}) || 0;
  const paddingBottom = inchesOf(style.paddingBottom, 'y', {}) || 0;
  const declaredHeight = inchesOf(style.height, 'y', { fontSizePx: inherited.fontPx });
  const contentHeight = declaredHeight === null
    ? null
    : Math.max(0, declaredHeight - paddingTop - paddingBottom);
  const rowTracks = gridRowTracksOf(style, contentHeight, inherited.fontPx);
  const autoRowHeight = autoRowHeightOf(style, inherited.fontPx);
  const rowHeights = resolveRowHeights(placements, heights, rows, rowGap, rowTracks, autoRowHeight, contentHeight);
  const tops = rowTops(rowHeights, contentBox.y, rowGap);
  const alignItems = String(style.alignItems || 'stretch').toLowerCase();
  const justifyItems = justifyOf({ justifySelf: style.justifyItems }) || 'stretch';
  const aligned = [];
  nodes.forEach((node, index) => {
    if (!node) return;
    const place = placements[index];
    const total = spannedHeight(rowHeights, place, rowGap);
    const top = tops[place.row] === undefined ? contentBox.y : tops[place.row];
    const childAlign = alignSelfOf(ctx.styles.computed(kids[index])) || alignItems;
    const childStyle = ctx.styles.computed(kids[index]);
    // `justify-self` (then the container's `justify-items`) decides where the box sits in
    // its cell on the inline axis, and a declared width beats the default `stretch`.
    const justify = justifyOf(childStyle) || justifyItems || 'stretch';
    const { cellLeft, cellWidth, declaredWidth, width: itemWidth } = cells[index];
    // The child was measured at the cell's origin, so move its whole subtree to the
    // place both axes actually resolve to (a justified box is not at the cell's left).
    const targetX = gridItemX(cellLeft, cellWidth, itemWidth, justify);
    shiftSubtree(node, top - node.y, targetX - node.x);
    node.x = targetX;
    node.w = itemWidth;
    node.y = top;
    if (justify !== 'stretch') node.justifySelf = justify;
    if (declaredWidth !== null) node.fixedWidth = true;
    if (!declared[index]) node.h = total;
    const height = node.h;
    if (childAlign === 'center') node.y = top + (total - height) / 2;
    else if (childAlign === 'end' || childAlign === 'flex-end') node.y = top + total - height;
    if (childAlign && childAlign !== 'stretch') node.alignSelf = childAlign;
    if (place.columnSpan > 1) node.columnSpan = place.columnSpan;
    if (place.rowSpan > 1) node.rowSpan = place.rowSpan;
    // The resolved cell travels in the spec, so the engine reproduces the analyzer's
    // placement instead of re-running auto-flow and hoping it decides the same way.
    node.gridColumnStart = place.column;
    node.gridRowStart = place.row;
    aligned.push(node);
  });
  aligned.gridTracks = tracks;
  if (rowTracks.length) aligned.gridRowTracks = rowTracks;
  if (autoRowHeight !== null) aligned.gridAutoRowHeight = autoRowHeight;
  if (contentHeight !== null) aligned.gridContentHeight = contentHeight;
  return aligned;
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
  applyChartStyling(attrs, options, domNode, ctx);
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

const CHART_LEGEND_POSITIONS = {
  bottom: 'b', b: 'b', top: 't', t: 't', left: 'l', l: 'l', right: 'r', r: 'r', 'top-right': 'tr', tr: 'tr'
};
const CHART_LABEL_FLAGS = { value: 'showValue', percent: 'showPercent', series: 'showSerName' };
const CHART_LABEL_POSITIONS = new Set(['b', 'bestFit', 'ctr', 'l', 'r', 't', 'inEnd', 'outEnd']);
const CHART_GROUPINGS = new Set(['clustered', 'stacked', 'percentStacked']);

/**
 * Chart styling is declared, never guessed: every attribute below names exactly the
 * one thing it sets, so a chart that is happy with the theme defaults says nothing.
 * A value that cannot be translated is reported rather than dropped quietly, and a
 * chart colour list is per series, in the order the series appear.
 */
function applyChartStyling(attrs, options, domNode, ctx) {
  const colors = attrs['data-chart-colors'];
  if (colors !== undefined) {
    const list = [];
    const bad = [];
    String(colors).split(',').forEach((token) => {
      const trimmed = token.trim();
      if (!trimmed) return;
      const parsed = parseColor(trimmed);
      if (parsed && parsed.hex) list.push(parsed.hex); else bad.push(trimmed);
    });
    if (bad.length) {
      recordUnsupported(ctx, domNode, 'data-chart-colors', bad.join(','),
        'Chart colours must be #rrggbb values, one per series, in series order');
    }
    if (list.length) options.chartColors = list;
  }

  const labels = attrs['data-chart-labels'];
  if (labels !== undefined) {
    const tokens = String(labels).trim().toLowerCase().split(/[,\s]+/u).filter(Boolean);
    if (tokens.includes('none')) {
      options.showValue = false;
      options.showPercent = false;
      options.showSerName = false;
    }
    const unknown = [];
    tokens.forEach((token) => {
      if (token === 'none') return;
      const flag = CHART_LABEL_FLAGS[token];
      if (flag) options[flag] = true; else unknown.push(token);
    });
    if (unknown.length) {
      recordUnsupported(ctx, domNode, 'data-chart-labels', unknown.join(','),
        'Use value, percent, series or none');
    }
  }

  const labelPosition = String(attrs['data-chart-label-position'] || '').trim();
  if (labelPosition) {
    if (CHART_LABEL_POSITIONS.has(labelPosition)) options.dataLabelPosition = labelPosition;
    else recordUnsupported(ctx, domNode, 'data-chart-label-position', labelPosition,
      'Use b, bestFit, ctr, l, r, t, inEnd or outEnd');
  }

  const valueFormat = attrs['data-chart-value-format'];
  if (valueFormat !== undefined) {
    options.valLabelFormatCode = String(valueFormat);
    if (options.showValue === undefined) options.showValue = true;
  }

  const axisTitles = attrs['data-chart-axis-titles'];
  if (axisTitles !== undefined) {
    const parts = String(axisTitles).split('|').map((part) => part.trim());
    if (parts.length > 2) {
      recordUnsupported(ctx, domNode, 'data-chart-axis-titles', String(axisTitles),
        'Give at most two titles: "category|value"');
    } else {
      if (parts[0]) {
        options.catAxisTitle = parts[0];
        options.showCatAxisTitle = true;
      }
      if (parts[1]) {
        options.valAxisTitle = parts[1];
        options.showValAxisTitle = true;
      }
    }
  }

  const legend = attrs['data-chart-legend'];
  if (legend !== undefined) {
    const value = String(legend).trim().toLowerCase();
    if (value === 'none' || value === 'false' || value === '0') options.showLegend = false;
    else if (value === 'true' || value === '1') options.showLegend = true;
    else if (CHART_LEGEND_POSITIONS[value]) {
      options.showLegend = true;
      options.legendPos = CHART_LEGEND_POSITIONS[value];
    } else {
      recordUnsupported(ctx, domNode, 'data-chart-legend', value,
        'Use true, false, none, top, bottom, left, right or top-right');
    }
  }

  const grid = attrs['data-chart-grid'];
  if (grid !== undefined) {
    const value = String(grid).trim().toLowerCase();
    if (value === 'false' || value === 'none' || value === 'off') options.valGridLine = { style: 'none' };
    else if (value === 'true' || value === 'on') { /* the theme gridline already applies */ }
    else recordUnsupported(ctx, domNode, 'data-chart-grid', value, 'Use true or false');
  }

  const grouping = attrs['data-chart-grouping'];
  if (grouping !== undefined) {
    const value = String(grouping).trim();
    if (CHART_GROUPINGS.has(value)) options.barGrouping = value;
    else recordUnsupported(ctx, domNode, 'data-chart-grouping', value,
      'Use clustered, stacked or percentStacked');
  }

  const direction = attrs['data-chart-dir'];
  if (direction !== undefined) {
    const value = String(direction).trim().toLowerCase();
    if (value === 'col' || value === 'vertical') options.barDir = 'col';
    else if (value === 'bar' || value === 'horizontal') options.barDir = 'bar';
    else recordUnsupported(ctx, domNode, 'data-chart-dir', value, 'Use col (vertical bars) or bar (horizontal bars)');
  }

  // A chart can sit on a light panel inside a dark deck, so the text colour is a
  // declaration rather than something inferred from the slide background.
  const textColor = attrs['data-chart-text-color'];
  if (textColor !== undefined) {
    const parsed = parseColor(String(textColor));
    if (parsed && parsed.hex) {
      options.titleColor = parsed.hex;
      options.catAxisLabelColor = parsed.hex;
      options.valAxisLabelColor = parsed.hex;
      options.catAxisTitleColor = parsed.hex;
      options.valAxisTitleColor = parsed.hex;
      options.legendColor = parsed.hex;
      options.dataLabelColor = parsed.hex;
    } else {
      recordUnsupported(ctx, domNode, 'data-chart-text-color', String(textColor),
        'Chart text colour must be a #rrggbb value');
    }
  }
}

const BORDER_SIDES = ['top', 'right', 'bottom', 'left'];
const TABLE_CELL_BORDER_PROPERTIES = new Set(['borderTop', 'borderRight', 'borderBottom', 'borderLeft']);

/**
 * One declared border side. `border-top: 3px solid` plus `border-top-color: x` has to
 * reach the same parser as the shorthand, so the longhands are folded into the same
 * declaration object and `parseBorder` resolves them in CSS order (longhand wins).
 * Each longhand is read literally so the supported-property guard can see it.
 */
function borderSideDeclaration(style, side) {
  const declaration = {};
  const shorthand = borderSideShorthand(style, side);
  if (shorthand !== undefined) declaration.border = shorthand;
  const width = borderSideWidth(style, side);
  if (width !== undefined) declaration.borderWidth = width;
  const lineStyle = borderSideStyle(style, side);
  if (lineStyle !== undefined) declaration.borderStyle = lineStyle;
  const color = borderSideColor(style, side);
  if (color !== undefined) declaration.borderColor = color;
  return declaration;
}

function borderSideShorthand(style, side) {
  if (side === 'top') return style.borderTop;
  if (side === 'right') return style.borderRight;
  if (side === 'bottom') return style.borderBottom;
  if (side === 'left') return style.borderLeft;
  return undefined;
}

function borderSideWidth(style, side) {
  if (side === 'top') return style.borderTopWidth;
  if (side === 'right') return style.borderRightWidth;
  if (side === 'bottom') return style.borderBottomWidth;
  if (side === 'left') return style.borderLeftWidth;
  return undefined;
}

function borderSideStyle(style, side) {
  if (side === 'top') return style.borderTopStyle;
  if (side === 'right') return style.borderRightStyle;
  if (side === 'bottom') return style.borderBottomStyle;
  if (side === 'left') return style.borderLeftStyle;
  return undefined;
}

function borderSideColor(style, side) {
  if (side === 'top') return style.borderTopColor;
  if (side === 'right') return style.borderRightColor;
  if (side === 'bottom') return style.borderBottomColor;
  if (side === 'left') return style.borderLeftColor;
  return undefined;
}

/** A side as the author wrote it, for reports: `2px solid #123` plus any longhand. */
function borderSideText(style, side) {
  const declaration = borderSideDeclaration(style, side);
  return ['border', 'borderWidth', 'borderStyle', 'borderColor']
    .map((key) => declaration[key])
    .filter((value) => value !== undefined && value !== null)
    .join(' ');
}

/** A border declaration is uniform when every side names the same thing. */
function uniformBorderSides(style) {
  const values = BORDER_SIDES.map((side) => JSON.stringify(borderSideDeclaration(style, side)));
  return values.every((value) => value === values[0]);
}

/** A border declaration is uniform when every side names the same thing. */
/**
 * The borders of one table cell, per side. A native table cell can carry four
 * independent lines, so `td { border-bottom: ... }` is translated instead of
 * approximated, and a side that declares `none` stays empty.
 */
function cellBorderOptions(style) {
  const sides = BORDER_SIDES.map((side) => {
    const declaration = borderSideDeclaration(style, side);
    return Object.keys(declaration).length ? parseBorder(declaration) : null;
  });
  const option = (border) => (border
    ? { type: border.dash ? 'dash' : 'solid', color: border.color, pt: borderWidthPt(border.width) }
    : { type: 'none' });
  const options = sides.map(option);
  const first = JSON.stringify(options[0]);
  return options.every((entry) => JSON.stringify(entry) === first) ? options[0] : options;
}

/** A table cell line width in points, floored so PowerPoint still draws it. */
function borderWidthPt(value) {
  const number = Number(value);
  return Number.isFinite(number) ? Math.max(0.25, number) : 0.75;
}

function readTable(domNode, ctx, contentWidth) {
  const rows = [];
  const rowNodes = [];
  // A row or section may carry the background a browser paints behind its cells -
  // the usual way a striped table is written. A cell inherits it visually, so the
  // first declared background wins: cell, then row, then section, then table.
  const collect = (node, sectionBackground) => {
    (node.children || []).forEach((child) => {
      if (child.type !== 'element') return;
      if (child.tag === 'tr') rowNodes.push({ rowNode: child, sectionBackground });
      else if (child.tag === 'thead' || child.tag === 'tbody' || child.tag === 'tfoot') {
        collect(child, backgroundOf(ctx.styles.computed(child)) || sectionBackground);
      }
    });
  };
  collect(domNode, backgroundOf(ctx.styles.computed(domNode)));

  let columns = 0;
  // Per cell, the numbers a row height needs later: the text, the size it is set in,
  // the padding around it and which columns it covers.
  const metrics = [];
  rowNodes.forEach(({ rowNode, sectionBackground }) => {
    const rowBackground = backgroundOf(ctx.styles.computed(rowNode)) || sectionBackground;
    const cells = elementChildren(rowNode).filter((child) => child.tag === 'td' || child.tag === 'th');
    let spanTotal = 0;
    const rowMetrics = [];
    const mapped = cells.map((cell) => {
      const style = ctx.styles.computed(cell);
      const color = parseColor(style.color);
      const background = backgroundOf(style) || rowBackground;
      const weight = String(style.fontWeight || '').toLowerCase();
      const sizePt = parseLength(style.fontSize);
      const fontSizePt = sizePt ? Number((toInches(sizePt, {}) * 72).toFixed(2)) : 10.5;
      const colspan = spanOf(cell, 'colspan', 12);
      const rowspan = spanOf(cell, 'rowspan', 64);
      const padding = boxShorthand(style, 'padding');
      const paddingPt = [padding.top, padding.right, padding.bottom, padding.left]
        .map((value) => Number((value * 72).toFixed(2)));
      const text = normalizedText(cell);
      rowMetrics.push({
        column: spanTotal,
        colspan,
        text,
        fontSizePt,
        lineHeight: lineSpacingOf(style, fontSizePt).multiple,
        paddingTop: padding.top,
        paddingBottom: padding.bottom,
        paddingLeft: padding.left,
        paddingRight: padding.right
      });
      spanTotal += colspan;
      const options = {
        bold: cell.tag === 'th' || weight === 'bold' || Number(weight) >= 600,
        color: color && color.hex ? color.hex : undefined,
        fill: background && background.hex ? { color: background.hex } : undefined,
        fontSize: sizePt ? Number((toInches(sizePt, {}) * 72).toFixed(1)) : undefined,
        align: style.textAlign || (cell.tag === 'th' ? 'left' : undefined),
        border: cellBorderOptions(style)
      };
      // A cell margin is the CSS padding. PowerPoint stores it in points as
      // top/right/bottom/left and PptxGenJS writes marT/marR/marB/marL from it.
      if (paddingPt.some((value) => value > 0)) options.margin = paddingPt;
      const verticalAlign = String(style.verticalAlign || '').trim().toLowerCase();
      if (verticalAlign === 'middle' || verticalAlign === 'bottom' || verticalAlign === 'top') {
        options.valign = verticalAlign;
      }
      if (String(style.fontStyle || '').toLowerCase() === 'italic') options.italic = true;
      const spacingPt = letterSpacingPtOf(style);
      if (spacingPt) options.charSpacing = spacingPt;
      if (colspan > 1) options.colspan = colspan;
      if (rowspan > 1) options.rowspan = rowspan;
      return { text, options };
    });
    columns = Math.max(columns, spanTotal);
    rows.push(mapped);
    metrics.push(rowMetrics);
  });

  const colWidths = resolveColumnWidths(domNode, ctx, columns, contentWidth, rows, 16);
  // A row is as tall as its tallest cell: the measured line boxes plus the padding the
  // CSS declared. `rowH` then makes PowerPoint draw that height instead of its own
  // guess, so the reserved box and the drawing agree instead of drifting apart.
  // `colWidths` can be null when the table is laid out by content; the height estimate
  // then works from an equal split rather than skipping the row.
  const measureWidths = Array.isArray(colWidths) && colWidths.length
    ? colWidths
    : Array.from({ length: Math.max(1, columns) }, () => contentWidth / Math.max(1, columns));
  const rowHeights = metrics.map((cells) => {
    const tallest = cells.reduce((max, cell) => {
      const width = cellSpanWidth(measureWidths, cell.column, cell.colspan);
      const usable = Math.max(0.1, width - cell.paddingLeft - cell.paddingRight);
      const height = estimateTextHeight(cell.text, usable, cell.fontSizePt, {
        marginIn: 0,
        lineHeight: cell.lineHeight,
        verticalInsetIn: cell.paddingTop + cell.paddingBottom
      });
      return Math.max(max, height);
    }, 0);
    return Number(Math.max(0.16, tallest).toFixed(4));
  });
  return { rows, columns, colWidths, rowHeights };
}

/** Width of the columns a cell spans, from the resolved track widths. */
function cellSpanWidth(colWidths, column, span) {
  let width = 0;
  for (let index = column; index < column + span; index += 1) {
    width += Number.isFinite(colWidths[index]) ? colWidths[index] : 0;
  }
  return width;
}

/** `letter-spacing` in points, or 0 when it is absent or unparseable. */
function letterSpacingPtOf(style) {
  const raw = style.letterSpacing;
  if (raw === undefined || raw === null) return 0;
  const match = /^(-?[\d.]+)(px|pt|em|rem)?$/u.exec(String(raw).trim());
  if (!match) return 0;
  const value = Number(match[1]);
  if (!Number.isFinite(value)) return 0;
  const unit = match[2] || 'px';
  const points = unit === 'pt' ? value : (unit === 'em' || unit === 'rem' ? value * 12 : value * 0.75);
  return Number(points.toFixed(2));
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
    // `position: fixed` resolves against the slide frame, so a pinned footer is
    // measured from the slide edge and not from whatever container holds it.
    ctx.viewport = { x: 0, y: 0, w: pageSize.width, h: pageSize.height };
    const rootDisplay = String(style.display || 'block').toLowerCase();
    // The root is a real box: honour flex/grid instead of forcing block flow.
    const children = rootDisplay === 'grid'
      ? layoutGrid(slideNode, style, contentBox, rootContext, ctx)
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
  // `overflow: hidden` only matters when something actually overflows: with content
  // that fits, the declaration changes no pixel, so reporting it would be noise. The
  // check runs after layout because that is when the content extent is known.
  slides.forEach((slide) => {
    const visit = (node) => {
      if (clipsContent(node)) {
        ctx.unsupported.push({
          tag: node.tag,
          classes: node.classes || [],
          property: 'overflow',
          value: String(node.style.overflow),
          reason: 'The box clips content that is larger than the box, and a native shape cannot clip its children'
        });
      }
      (node.children || []).forEach(visit);
    };
    slide.nodes.forEach(visit);
  });
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
