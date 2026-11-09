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
  unsupportedGradientOf,
  boxShadowNote,
  evaluateInches,
  backgroundOverlayGradientOf,
  untranslatedBackgroundLayers,
  backgroundImageOf,
  parseBackgroundFocus
} = require('./css');
const { estimateTextHeight, estimateRichTextHeight, estimateLineCount, measureTextPt, clampText } = require('../engine/text_measure');
const { normalLineHeight } = require('../engine/font_manager');

/** Fontkit is an optional dependency; metrics stay best-effort without it. */
function fontkit() {
  try { return require('fontkit'); } catch (_) { return null; }
}
const { flexWidths } = require('../engine/flex_size');
const { flexLines, flexColumns, alignLines } = require('../engine/flex_lines');
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
  'gridArea', 'captionSide', 'outline', 'gridTemplateRows', 'gridAutoRows', 'alignItems', 'justifyItems', 'justifySelf',
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
  'borderColor', 'borderStyle', 'borderRadius', 'borderTopLeftRadius', 'columns', 'columnCount', 'columnGap', 'clipPath',
  'borderTopRightRadius', 'borderBottomLeftRadius', 'borderBottomRightRadius',
  'boxShadow', 'opacity', 'fontFamily', 'fontSize', 'fontWeight',
  'fontStyle', 'lineHeight', 'letterSpacing', 'textAlign', 'textTransform', 'textIndent', 'whiteSpace',
  // `underline`/`line-through` land as run properties via decorationOptions; `overline`
  // and a declared thickness or colour are named separately below.
  'textDecoration', 'textDecorationLine', 'textDecorationColor', 'textDecorationThickness',
  // `mixed` is the initial value: eaVert already keeps CJK upright, so the default is
  // an equivalent implementation and not a limitation.
  'fontVariant',
  'writingMode', 'wordBreak', 'float', 'clear', 'aspectRatio',
  // transformOrigin is named by the transform parser itself, which knows whether
  // the origin actually shifted the drawn box; the sweep would only duplicate it.
  'transformOrigin',
  // The `-webkit-line-clamp` properties; the clamp itself is applied where the text is
  // measured, and the orientation it needs is read there too.
  'WebkitLineClamp', 'WebkitBoxOrient', 'lineClamp',
  'objectFit', 'objectPosition', 'backgroundSize', 'backgroundPosition', 'zIndex', 'visibility'
]);

// `overflow` is deliberately absent from this set: it is reported after layout, and
// only when the box really clips content larger than itself (see `clipsContent`).
const POST_LAYOUT_PROPERTIES = new Set(['overflow']);

const UNSUPPORTED_ALWAYS = new Set([
  // clip-path is translated when it is a polygon on a box with a declared height.
  'borderCollapse', 'filter', 'backdropFilter', 'mask', 'mixBlendMode',
  // writing-mode is translated (see applyWritingMode) or reported there.
  'animation', 'transition',
  'backgroundClip', 'textShadow',
  'hyphens', 'inset'
]);

/** CSS align-self spelling → the native container's per-child alignment. */
// `stretch` and `flex-start` are what an unmapped value already does, so only the values that
// would move a box are named. `baseline` aligns baselines; `stretch` aligns box heights.
const ALIGN_UNSUPPORTED = new Set(['baseline', 'last baseline', 'self-start', 'self-end', 'safe center', 'unsafe center']);

/**
 * Alignment values that would change a pixel but have no native spelling here.
 * Value-level silence is the same lie as property-level silence: `align-items: baseline`
 * became `stretch`, which moves every box in the row.
 */
function alignmentProblems(style, display) {
  const problems = [];
  const align = String(style.alignItems || '').trim().toLowerCase();
  const justify = String(style.justifyContent || '').trim().toLowerCase();
  const self = String(style.alignSelf || '').trim().toLowerCase();
  const isFlexLike = display === 'flex' || display === 'grid';
  if (isFlexLike && ALIGN_UNSUPPORTED.has(align)) {
    problems.push({ property: 'alignItems', value: style.alignItems, note: align });
  }
  if (ALIGN_UNSUPPORTED.has(self)) {
    problems.push({ property: 'alignSelf', value: style.alignSelf, note: self });
  }
  return problems;
}

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

/**
 * What a `transform` list does to a box: how far it moves and how far it turns.
 *
 * CSS applies the list right to left, so a translate that follows a rotate is itself rotated.
 * Both are exact for a box whose `transform-origin` is its centre, which is the default and the
 * only origin DrawingML can express: `x`/`y` plus a rotation about the shape's own centre.
 * `scale()` and `skew()` change the glyphs inside a text box, which no native shape can carry,
 * so they are named instead of approximated.
 */
function transformPlanOf(value, widthIn, heightIn, origin) {
  const plan = { rotate: 0, dx: 0, dy: 0, unsupported: [] };
  const functions = transformFunctions(value);
  if (!functions.length) return plan;
  const originValue = String(origin === undefined || origin === null ? '' : origin).trim();
  const centred = !originValue || /^(?:50%|center)(?:\s+(?:50%|center))?$/iu.test(originValue);
  if (!centred) plan.unsupported.push('transform-origin: ' + originValue);
  const steps = [];
  for (const entry of functions) {
    if (ROTATE_FUNCTIONS.has(entry.name)) {
      const degrees = angleDegrees(entry.args);
      if (degrees === null) { plan.unsupported.push(entry.name + '(' + entry.args + ')'); continue; }
      plan.rotate += degrees;
      steps.push({ rotate: degrees });
      continue;
    }
    const movesX = entry.name === 'translatex' || entry.name === 'translate';
    const movesY = entry.name === 'translatey' || entry.name === 'translate';
    if (!movesX && !movesY) { plan.unsupported.push(entry.name + '(' + entry.args + ')'); continue; }
    const args = String(entry.args || '').split(/[,\s]+/u).filter(Boolean);
    const axis = (argument, basis) => {
      const length = parseLength(argument);
      if (!length) return null;
      if (length.unit === '%') return basis === null ? null : (length.value / 100) * basis;
      return toInches(length, {});
    };
    const tx = entry.name === 'translatey' ? 0 : axis(args[0] || '0', widthIn);
    const ty = entry.name === 'translatex' ? 0 : axis(args[1] || '0', heightIn);
    if (tx === null || ty === null) { plan.unsupported.push(entry.name + '()'); continue; }
    steps.push({ dx: tx, dy: ty });
  }
  // Right to left: a rotation turns every translation written after it.
  let x = 0;
  let y = 0;
  for (let index = steps.length - 1; index >= 0; index -= 1) {
    const step = steps[index];
    if (step.rotate !== undefined) {
      const radians = (step.rotate * Math.PI) / 180;
      const cos = Math.cos(radians);
      const sin = Math.sin(radians);
      const nx = x * cos - y * sin;
      const ny = x * sin + y * cos;
      x = nx;
      y = ny;
      continue;
    }
    x += step.dx;
    y += step.dy;
  }
  plan.dx = Number(x.toFixed(4));
  plan.dy = Number(y.toFixed(4));
  plan.rotate = Number((plan.rotate % 360).toFixed(2));
  return plan;
}

/** `transform: rotate(-4deg)` → degrees, clockwise positive like DrawingML. */
function rotationFromTransform(value) {
  const plan = transformPlanOf(value, null, null, null);
  return plan.rotate ? plan.rotate : undefined;
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
  if (value === 'space-around') return 'space-around';
  if (value === 'space-evenly') return 'space-evenly';
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

/**
 * The four corner radii in inches, in CSS order (top-left, top-right, bottom-right,
 * bottom-left). `border-radius: 12px 12px 0 0` is a tab; a native rounded rectangle can
 * only carry one radius, so the analyzer reports the corners it cannot keep.
 */
function radiusCorners(style) {
  // Longhands say one corner each; an undeclared corner is CSS 0 there. The
  // shorthand expands to all four at declaration time, so its repeat rules apply.
  const longhands = [style.borderTopLeftRadius, style.borderTopRightRadius,
    style.borderBottomRightRadius, style.borderBottomLeftRadius];
  let sides = longhands.filter((value) => value);
  if (sides.length && sides.length < 4) {
    // Mixed longhand set: the missing corners are zero, not a repeat of the first.
    sides = longhands.map((value) => value || '0');
  } else if (sides.length === 4) {
    sides = longhands;
  } else {
    sides = String(style.borderRadius || "").trim().split(/\s+/u).filter(Boolean);
    if (!sides.length) return null;
  }
  const values = [];
  for (const token of sides) {
    const length = parseLength(token);
    if (!length) return null;
    const inches = toInches(length, {});
    values.push(Number.isFinite(inches) && inches > 0 ? Number(inches.toFixed(3)) : 0);
  }
  if (!values.length) return null;
  // The shorthand repeats its list: one value means all four, two mean
  // vertical/horizontal pairs. A full longhand set does not repeat.
  if (sides.length < 4) {
    const pick = (index) => values[index % values.length];
    return [pick(0), pick(1), pick(2), pick(3)];
  }
  return values;
}

/**
 * `border-radius: 50%` is the inscribed ellipse - the shape every dot, badge and avatar is
 * drawn with. A percentage radius used to fall out of `radiusOf` (it is not a length), so the
 * box was drawn square without a word. Only a full ellipse is expressible natively: a smaller
 * percentage is an elliptical corner, which is reported instead of approximated.
 */
function ellipseOf(style) {
  const raw = style.borderTopLeftRadius || style.borderRadius;
  if (!raw) return null;
  const parts = String(raw).split('/');
  const horizontal = String(parts[0] || '').trim().split(/\s+/u).filter(Boolean);
  const vertical = parts.length > 1
    ? String(parts[1]).trim().split(/\s+/u).filter(Boolean)
    : horizontal;
  if (!horizontal.length || !vertical.length) return null;
  const axisPercent = (value) => {
    const length = parseLength(value);
    return length && length.unit === '%' ? length.value : null;
  };
  const percents = [axisPercent(horizontal[0]), axisPercent(vertical[0])];
  if (percents.some((value) => value === null)) return null;
  return { percent: Math.min(percents[0], percents[1]) };
}

/** Radius or ellipse, plus the report a shape that can hold neither deserves. */
function applyRadius(node, domNode, style, ctx) {
  // Corner mixes are judged by the box branch's radiusCorners check; this fn adds
  // what that one misses: the elliptical percentage corner no native geometry spells.
  // A corner can also carry two lengths (`border-top-left-radius: 50% 30%`): an
  // rx/ry pair, elliptical whenever they differ. ellipseOf reads the slash form
  // only, so this one reached here with rx alone and no trace of the ry.
  const cornerRaw = String(style.borderTopLeftRadius || style.borderRadius || '').trim();
  if (/\S+\s+\S+/u.test(cornerRaw)) {
    recordUnsupported(ctx, domNode, 'borderRadius', cornerRaw,
      'A corner with a horizontal and a vertical radius is an elliptical corner, which no native geometry spells: the box is drawn square');
    return;
  }
  const radius = radiusOf(style);
  if (radius) {
    node.radius = radius;
    return;
  }
  const ellipse = ellipseOf(style);
  if (!ellipse) return;
  if (ellipse.percent >= 50) {
    node.ellipse = true;
    return;
  }
  recordUnsupported(ctx, domNode, 'borderRadius', style.borderTopLeftRadius || style.borderRadius,
    'A percentage radius below 50% is an elliptical corner, which no native geometry spells:'
      + ' the box is drawn square');
}

/**
 * A native roundRect rounds all four corners alike. A mix of corner values would
 * silently round every corner at the top-left's size, so a mixed set stays named.
 * An undeclared corner is CSS 0, so a single-corner declaration is already a mix.
 */
function checkCornerMix(domNode, style, ctx) {
  const corners = ['borderTopLeftRadius', 'borderTopRightRadius',
    'borderBottomRightRadius', 'borderBottomLeftRadius'].map((name) => style[name]);
  const declared = corners.filter((value) => value !== undefined && value !== null);
  if (!declared.length) return;
  const distinct = new Set(corners.map((value) => (value === undefined || value === null) ? '0' : String(value).trim()));
  if (distinct.size > 1) {
    recordUnsupported(ctx, domNode, 'borderRadius', declared.join(' '),
      'The corners round by different amounts; a native roundRect rounds all four alike, so the box is drawn at the top-left radius');
  }
}

function radiusOf(style) {
  const raw = style.borderTopLeftRadius || style.borderRadius;
  if (!raw) return null;
  const length = parseLength(raw);
  if (!length) return null;
  const inches = toInches(length, {});
  return inches && inches > 0 ? Number(inches.toFixed(3)) : null;
}

/**
 * `position: absolute|fixed` without a declared width is shrink-to-fit, not "as wide as
 * the containing block": a pinned box that hugs its text. Only a leaf has a max-content
 * width here - a container would need a max-content layout pass this shape does not run,
 * so it keeps the containing-block width.
 */
function shrinkToFitWidth(domNode, style, options) {
  const hasElementChild = (domNode.children || []).some((child) => child.type === 'element');
  if (hasElementChild) return null;
  const raw = textContent(domNode).replace(/\s+/gu, ' ').trim();
  if (!raw) return null;
  const fontSizePt = fontPxOf(style, options.fontSizePx) * 0.75;
  // A little slack: the glyph factors are estimates, and a box that hugs the text too
  // tightly wraps in the renderer, which is the one outcome shrink-to-fit must avoid.
  const advance = measureTextPt(raw, fontSizePt, {
    fontManager: options.fontManager,
    letterSpacingPt: options.letterSpacingPt
  }) / 72;
  // The wrapper charges a safety margin on every line, so a box that hugs its text has to
  // undo exactly that margin - and the only reliable way to undo it is to ask the wrapper.
  // A fixed divisor guessed the margin and left footers wrapping their last character,
  // which is the one outcome shrink-to-fit exists to avoid.
  const measureOptions = { safetyFactor: 0.9, letterSpacingPt: options.letterSpacingPt, fontManager: options.fontManager };
  let preferred = advance / 0.9 + 0.08 + 0.01;
  for (let attempt = 0; attempt < 12; attempt += 1) {
    if (estimateLineCount(raw, preferred, fontSizePt, measureOptions) <= 1) break;
    preferred *= 1.03;
  }
  const available = Math.max(0, options.availableWidth);
  return Math.min(available, preferred) + options.insetLeft + options.insetRight;
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
    // A preference query does not match for a different reason than a size query:
    // the slide has no user preference to read, where a size simply compares.
    const preference = /prefers-[a-z-]+/iu.test(entry.query);
    unsupported.push({
      tag: null,
      classes: [],
      property: '@media',
      value: entry.query,
      reason: preference
        ? 'The query reads a browser preference (colour scheme, reduced motion); a slide render has none, so its rules were not applied'
        : 'Media query does not match the slide viewport; its rules were not applied'
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
  // A box can be measured more than once (shrink-to-fit, a container probe), and the same
  // declaration must not be reported twice: the report counts elements, not calls.
  if (node) {
    if (!ctx.unsupportedSeen) ctx.unsupportedSeen = new WeakMap();
    let seen = ctx.unsupportedSeen.get(node);
    if (!seen) {
      seen = new Set();
      ctx.unsupportedSeen.set(node, seen);
    }
    const key = property + '|' + String(value);
    if (seen.has(key)) return;
    seen.add(key);
  }
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
  writingMode: ['horizontal-tb', 'vertical-rl', 'vertical-lr', 'sideways-rl', 'sideways-lr'],
  backgroundClip: ['border-box'],
  textOverflow: ['clip', 'ellipsis'],
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
    // `word-spacing: normal` is the initial value and changes nothing; a declared
    // value is judged per value below, because the generic report would call it
    // a subset gap when the truth is about what a run can carry.
    if (property === 'wordSpacing') return;
    // A table cell translates its four sides independently, so a single-side
    // border is not a limitation there (it is for every other element).
    if ((domNode.tag === 'td' || domNode.tag === 'th') && TABLE_CELL_BORDER_PROPERTIES.has(property)) return;
    // A variable-font weight between the regular and bold thresholds draws as regular
    // here: no native spelling exists for the intermediate weights. Silence would
    // read as 'no weight was asked for'.
    if (property === 'fontWeight') {
      const numeric = Number(style[property]);
      if (Number.isFinite(numeric) && numeric > 500 && numeric < 600) {
        recordUnsupported(ctx, domNode, 'fontWeight', style[property],
          'A weight between 501 and 599 draws as regular: no native spelling exists for intermediate weights');
      }
      return;
    }
    // `overflow` is judged after layout, against the content it would clip.
    if (POST_LAYOUT_PROPERTIES.has(property)) return;
    // List markers and picture tiling are judged per value below: the generic
    // subset report would call `no-repeat` and `none` unsupported when they ask
    // for exactly what the native side does.
    if (property === 'listStyle' || property === 'listStyleType' || property === 'backgroundRepeat') return;
    // `table-layout: fixed` is the model this solver implements (declared or equal
    // columns, content wraps rather than stretches), so it says nothing.
    if (property === 'tableLayout') return;
    // `overflow-wrap: break-word`/`anywhere` ask for the grapheme-level break the
    // wrap already makes; the values are translated by construction and the generic
    // report would name a gap that does not exist.
    // `normal` is the initial value; the declared spelling changes nothing.
    if (property === 'overflowWrap') return;
    // Counter state is consumed by the list branch (reset, increment, print); the
    // properties say nothing the list output does not already carry.
    if (property === 'counterReset' || property === 'counterIncrement') return;
    // `quotes` feeds open-quote/close-quote resolution; the pair itself never draws.
    if (property === 'quotes') return;
    // `text-emphasis` is consumed at the run level; values without a shape keyword
    // (colour-only or a `none`) fall through to the generic report.
    if (property === 'textEmphasis' && /\b(dot|circle|filled|open|double-circle|triangle|sesame)\b/iu.test(String(style[property]))) return;
    // A transition or animation names a journey. The slide draws the END state (the
    // transform and the final values are all applied), so the report says what the
    // reader actually misses: the movement between states.
    if (property === 'transition') {
      recordUnsupported(ctx, domNode, 'transition', style[property],
        'The slide draws the end state; the animated journey between states is not drawn');
      return;
    }
    if (property === 'animation') {
      recordUnsupported(ctx, domNode, 'animation', style[property],
        'The slide draws the final state; the entrance or motion itself is not drawn');
      return;
    }
    // A per-value truth beats the generic sweep: `inside` puts the marker in the
    // text's own line box, which no native list spells - the bullet always hangs.
    // `mixed` is the initial value and what eaVert already draws (CJK upright, Latin
    // rotated): an equivalent implementation, so it is silent. The alternatives
    // change Latin behaviour and are named.
    if (property === 'textOrientation') {
      if (String(style[property]).trim().toLowerCase() !== 'mixed') {
        recordUnsupported(ctx, domNode, property, style[property],
          'Only the default glyph behaviour (mixed) is drawn: eaVert keeps CJK upright and rotates Latin, and no native spelling rotates Latin upright');
      }
      return;
    }
    // `column-span` only means something inside a multicol container; when it does,
    // the column plan names the design itself. Everywhere else it is a no-op.
    // Interaction-only properties mean nothing on a static slide: no pointer, no
    // selection, no scrolling surface. `background-attachment` is likewise judged
    // against a slide that never scrolls - every value draws the same.
    if (property === 'cursor' || property === 'userSelect' || property === 'backgroundAttachment') return;
    if (property === 'columnSpan') return;    if (property === 'columnSpan') return;
    if (property === 'columnSpan') return;
    if (property === 'listStylePosition' && String(style[property]).trim().toLowerCase() === 'inside') {
      recordUnsupported(ctx, domNode, property, style[property],
        'The marker would sit inside the text line: native bullets always hang in the margin');
      return;
    }
    if (UNSUPPORTED_ALWAYS.has(property)) {
      recordUnsupported(ctx, domNode, property, style[property], 'CSS feature has no native translation');
    } else if (!SUPPORTED_PROPERTIES.has(property)) {
      recordUnsupported(ctx, domNode, property, style[property], 'Property is outside the supported subset');
    }
  });
  // There is no per-word spacing channel on a run (charSpacing is per character), so
  // a declared word-spacing is a real residue: words keep their ordinary advance.
  const wordSpacing = String(style.wordSpacing || '').trim();
  if (wordSpacing && wordSpacing !== 'normal' && wordSpacing !== 'inherit' && wordSpacing !== '0px') {
    recordUnsupported(ctx, domNode, 'wordSpacing', style.wordSpacing,
      'Words keep their ordinary advance; a run has per-character spacing, not per-word');
  }
  // The common markers have native spellings (buChar for the round shapes, buAutoNum
  // for the ordered ones) and are consumed by the list branch; anything rarer still
  // draws the round bullet, so it stays named.
  const listStyleValue = String(style.listStyleType || style.listStyle || '').trim().toLowerCase();
  const KNOWN_MARKERS = new Set(['disc', 'circle', 'square', 'decimal', 'lower-alpha',
    'lower-latin', 'upper-alpha', 'upper-latin', 'lower-roman', 'upper-roman',
    'none', 'inherit']);
  if (listStyleValue && !KNOWN_MARKERS.has(listStyleValue)) {
    recordUnsupported(ctx, domNode, 'listStyle', style.listStyleType || style.listStyle,
      'Every marker draws as the native round bullet; the declared shape does not change it');
  }
  // A picture is drawn once, fitted to its box, which is `no-repeat`. Tiling asks
  // for something a fitted picture cannot do, so those values are named.
  // The `background` shorthand can carry the repeat keyword too (`url(x) round`),
  // and the longhand read above would miss it.
  const shorthandRepeat = String(style.background || '').replace(/url\([^)]*\)/iu, ' ')
    .split(/\s+/u).find((token) => /^(no-repeat|repeat|repeat-x|repeat-y|round|space)$/iu.test(token));
  const repeat = String(style.backgroundRepeat !== undefined ? style.backgroundRepeat : (shorthandRepeat || '')).trim().toLowerCase();
  if (repeat && repeat !== 'no-repeat' && repeat !== 'inherit' && repeat !== 'initial') {
    recordUnsupported(ctx, domNode, 'backgroundRepeat', repeat,
      'The picture is drawn once, fitted to the box; a tiled pattern cannot be spelled');
  }
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
  // `underline` and `line-through` are run properties; the rest of the decoration
  // family has no native spelling on a run. `overline` would need a drawn line above
  // every line of wrapped text, and a decoration colour would need `a:uFill`, which
  // the writer does not emit - so both are named rather than silently inherited.
  const decorationLine = String(style.textDecorationLine || style.textDecoration || '').toLowerCase();
  if (decorationLine.includes('overline')) {
    recordUnsupported(ctx, domNode, 'textDecoration', style.textDecorationLine || style.textDecoration,
      'Overline has no native run property; a line above every wrapped line cannot be drawn');
  }
  if (style.textDecorationColor) {
    recordUnsupported(ctx, domNode, 'textDecorationColor', style.textDecorationColor,
      'The decoration keeps the text colour; the writer emits no underline fill');
  }
  // Only the browser`s own stroke width can be meant; a declared thickness has no channel.
  const thickness = String(style.textDecorationThickness || '').trim();
  if (thickness && !/^(auto|from-font)$/iu.test(thickness)) {
    recordUnsupported(ctx, domNode, 'textDecorationThickness', style.textDecorationThickness,
      'The decoration draws at the reader`s default stroke width');
  }
  // The transform is resolved in analyzeNode, where the box it moves is known.
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
  const raw = style.fontSize;
  if (raw === undefined || raw === null || raw === '') return inheritedPx;
  // `font-size: clamp(14px, 1.2vw, 18px)` and `2.2vh` are resolved like any other length.
  const resolved = evaluateInches(raw, {
    fontSizePx: inheritedPx,
    rootFontSizePx: 16,
    percentBase: inheritedPx / 96
  });
  if (resolved !== null) return resolved * 96;
  const size = parseLength(raw);
  if (!size) return inheritedPx;
  if (size.unit === 'em') return size.value * inheritedPx;
  if (size.unit === 'rem') return size.value * 16;
  if (size.unit === '%') return (size.value / 100) * inheritedPx;
  const inches = toInches(size, { fontSizePx: inheritedPx });
  return inches === null ? inheritedPx : inches * 96;
}

/**
 * `line-height: normal` for the face the element asks for, or 1.25 when metrics are unreadable.
 *
 * The stack is walked in CSS order and the first face that exists on this machine wins, because
 * that is the face the reader will use. When nothing in the stack exists the browser falls into
 * its per-character generic fallback, whose line box we cannot read statically - the 1.25
 * estimate is kept for that case, since a serif guess measured *smaller* than the reader.
 */
function normalLineMultiple(familyStack) {
  const families = fontFamilyList(familyStack);
  const metricsOf = (family) => {
    if (!family) return null;
    const metrics = normalLineHeight(family, fontkit());
    return metrics === null || !Number.isFinite(metrics) ? null : Number(metrics.toFixed(3));
  };
  for (const family of families) {
    const metrics = metricsOf(family);
    if (metrics !== null) return Math.max(1.0, metrics);
  }
  return 1.25;
}

function lineSpacingOf(style, fontPx) {
  const raw = style.lineHeight;
  if (!raw || raw === 'normal') return { multiple: normalLineMultiple(style.fontFamily), explicit: null };
  const length = parseLength(raw);
  if (!length) return { multiple: normalLineMultiple(style.fontFamily), explicit: null };
  if (length.unit === '') return { multiple: Number(length.value) || 1.25, explicit: null };
  // A percentage line-height is a multiple of the element's own font size
  // (150% of 16px = 24px = 1.5); it is not a box-relative percent.
  if (length.unit === '%') {
    const multiple = Number((length.value / 100).toFixed(3));
    return { multiple: Math.max(0.8, multiple), explicit: null };
  }
  const inches = toInches(length, { fontSizePx: fontPx });
  if (!inches) return { multiple: normalLineMultiple(style.fontFamily), explicit: null };
  return { multiple: Math.max(0.8, Number((inches / (fontPx / 96)).toFixed(3))), explicit: inches };
}

/** Build rich-text runs from inline children, keeping bold/italic/colour spans. */
/** Every family a `font-family` declaration names, in order, quotes stripped. */
function fontFamilyList(value) {
  const text = String(value === undefined || value === null ? '' : value).trim();
  if (!text) return [];
  return text.split(',')
    .map((name) => name.trim().replace(/^["']|["']$/gu, '').trim())
    .filter(Boolean);
}

/** The first family a `font-family` declaration names, or null. */
function runFontFamily(value) {
  return fontFamilyList(value)[0] || null;
}

function baseRunFlags(baseStyle) {
  const color = parseColor(baseStyle.color);
  const weight = String(baseStyle.fontWeight || '').toLowerCase();
  const size = parseLength(baseStyle.fontSize);
  return {
    color: color && color.hex ? color.hex : null,
    bold: weight === 'bold' || weight === 'bolder' || Number(weight) >= 600,
    italic: String(baseStyle.fontStyle || '').toLowerCase() === 'italic',
    fontSize: size ? Math.round(toInches(size, {}) * 72 * 100) / 100 : null,
    fontFace: runFontFamily(baseStyle.fontFamily)
  };
}

/**
 * The words a `::before`/`::after` box contributes to its host's own line.
 *
 * A literal string and `attr()` are text the DOM already holds. `counter()` and the quote
 * keywords depend on state the DOM does not carry, so they are named instead of guessed.
 */
/**
 * The words a `::before`/`::after` box contributes to its host's own line.
 *
 * A CSS `content` value is a sequence: quoted strings and `attr()` are text the DOM already
 * holds, so they are concatenated. `counter()` and the quote keywords depend on state the DOM
 * does not carry, so the whole declaration is named instead of half-guessed.
 */
/** UA default quote pair; `quotes` on the element overrides it. */
function quotePairOf(style) {
  const pairs = String((style && style.quotes) || '').trim();
  if (!pairs || pairs === 'none') return null;
  const tokens = [];
  let rest = pairs;
  while (rest.length) {
    if (/^\s/u.test(rest)) { rest = rest.slice(1); continue; }
    const quote = rest[0];
    if (quote !== '"' && quote !== "'") return null;
    let cursor = 1;
    let body = '';
    while (cursor < rest.length && rest[cursor] !== quote) {
      if (rest[cursor] === '\\' && cursor + 1 < rest.length) {
        body += rest[cursor] + rest[cursor + 1];
        cursor += 2;
        continue;
      }
      body += rest[cursor];
      cursor += 1;
    }
    tokens.push(decodeCssContent(quote + body + quote));
    rest = rest.slice(cursor + 1);
  }
  return tokens.length >= 2 ? { open: tokens[0], close: tokens[1] } : null;
}

function inlinePseudoText(declaration, domNode) {
  const content = declaration ? declaration.content : undefined;
  if (content === undefined) return { text: '' };
  const value = String(content).trim();
  if (!value || value === 'none' || value === 'normal') return { text: '' };
  const parts = [];
  let index = 0;
  while (index < value.length) {
    const rest = value.slice(index);
    if (/^\s/u.test(rest)) { index += 1; continue; }
    const quote = rest[0];
    if (quote === '"' || quote === "'") {
      let cursor = 1;
      let body = '';
      while (cursor < rest.length && rest[cursor] !== quote) {
        if (rest[cursor] === '\\' && cursor + 1 < rest.length) {
          body += rest[cursor] + rest[cursor + 1];
          cursor += 2;
          continue;
        }
        body += rest[cursor];
        cursor += 1;
      }
      if (cursor >= rest.length) return { text: '', unsupported: value };
      parts.push(decodeCssContent(quote + body + quote));
      index += cursor + 1;
      continue;
    }
    const call = /^([A-Za-z-]+)\(([^)]*)\)/u.exec(rest);
    if (call) {
      const name = call[1].toLowerCase();
      if (name !== 'attr') return { text: '', unsupported: value };
      const attribute = call[2].trim().replace(/^['"]|['"]$/gu, '');
      const raw = domNode && domNode.attrs ? domNode.attrs[attribute] : undefined;
      parts.push(raw === undefined || raw === null ? '' : String(raw));
      index += call[0].length;
      continue;
    }
    const word = /^[A-Za-z-]+/u.exec(rest);
    if (word && (word[0] === 'none' || word[0] === 'normal')) { index += word[0].length; continue; }
    return { text: '', unsupported: value, word: word ? word[0] : null };
  }
  // A browser collapses runs of spaces in a normal white-space context, so the words a
  // pseudo box contributes are collapsed the way the DOM text around them already was.
  const joined = parts.join('');
  const preserve = /^pre/u.test(String((declaration && declaration.whiteSpace) || '').trim().toLowerCase());
  return { text: preserve ? joined : joined.replace(/[ \t\u00A0]+/gu, ' ') };
}

function buildRuns(domNode, baseStyle, ctx) {
  const base = baseRunFlags(baseStyle);
  const runs = [];
  /**
   * The decoration an inline element carries. `<u>`/`<s>` are the tags a design uses for
   * it and `text-decoration` is the declaration; both end up as run properties, which is
   * where PowerPoint keeps them.
   */
  const decorationOptions = (style, tag) => {
    const options = {};
    const decoration = String((style && (style.textDecorationLine || style.textDecoration)) || '').toLowerCase();
    if (decoration.includes('underline') || tag === 'u' || tag === 'ins') {
      // DrawingML spells the decoration style on the same u= attribute: dotted,
      // dashed, wavy, double. A plain underline stays the boolean.
      const style = /\b(dotted|dashed|wavy|double)\b/iu.exec(decoration);
      options.underline = style ? style[1].toLowerCase() : true;
    }
    if (decoration.includes('line-through') || tag === 's' || tag === 'del' || tag === 'strike') {
      options.strike = true;
    }
    const vertical = String((style && style.verticalAlign) || '').trim().toLowerCase();
    if (tag === 'sup' || vertical === 'super') options.superscript = true;
    else if (tag === 'sub' || vertical === 'sub') options.subscript = true;
    // `text-emphasis` is the CJK dot above each character: OOXML spells it as
    // emphasisMark on the run, with its own fill. Shape (dot only) plus colour.
    const emphasis = style && style.textEmphasis;
    if (emphasis && String(emphasis).trim()) {
      const shape = /\b(dot|circle|filled|open|double-circle|triangle|sesame)\b/iu.exec(String(emphasis));
      if (shape) {
        options.emphasisMark = {
          character: shape[1].toLowerCase() === 'sesame' ? '〆' : '•',
          colour: null
        };
        const hexToken = /#[0-9a-fA-F]{3,8}/u.exec(String(emphasis));
        const emphasisColour = hexToken ? parseColor(hexToken[0]) : null;
        if (emphasisColour && emphasisColour.hex) options.emphasisMark.colour = emphasisColour.hex;
      }
    }
    return options;
  };
  const pushText = (value, style, inline) => {
    if (!value) return;
    const options = {};
    const tag = inline && inline.tag ? inline.tag : '';
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
      const face = runFontFamily(style.fontFamily);
      if (face && face !== base.fontFace) options.fontFace = face;
      // `cap="small"` applies to a whole run, and a box is patched as a unit: a span that
      // asks for small caps inside an ordinary paragraph would apply to every run or to
      // none, so it is named rather than half-applied.
      const variant = String(style.fontVariant || '').toLowerCase().trim();
      if (inline && variant === 'small-caps') {
        recordUnsupported(ctx, inline || {}, 'fontVariant', style.fontVariant,
          'Small caps on an inline span is not carried: declare it on the block so the whole box can be patched');
      }
    }
    Object.assign(options, decorationOptions(style, tag));
    // A background on a plain inline element is a highlighter, which PowerPoint keeps
    // as a run property (`<a:highlight>`), so the words really are marked.
    if (inline && inline.highlight) options.highlight = inline.highlight;
    if (inline && inline.href) {
      options.hyperlink = { url: inline.href };
      // A `#fragment` anchor jumps within the HTML page; the deck has no slide
      // mapping to resolve it against, so the link draws but leads nowhere. Named,
      // not faked as a jump.
      if (String(inline.href).startsWith('#')) {
        recordUnsupported(ctx, domNode, 'href', inline.href,
          'An in-page anchor has no slide to jump to in the deck; the link draws but does not navigate');
      }
    }
    runs.push(Object.keys(options).length ? { text: value, options } : { text: value });
  };

  const visit = (node, inheritedStyle, inheritedInline) => {
    if (node.type === 'text') {
      // pre/pre-wrap keep their runs of spaces; the collapse is a normal-mode rule.
      const preserveSpaces = /^pre/u.test(String((inheritedStyle && inheritedStyle.whiteSpace) || '').trim().toLowerCase());
      pushText(preserveSpaces ? node.text : node.text.replace(/[ \t\u00A0]+/gu, ' '), inheritedStyle, inheritedInline);
      return;
    }
    if (node.type !== 'element') return;
    if (node.tag === 'br') {
      pushText('\n', null, null);
      return;
    }
    const style = ctx.styles.computed(node);
    // `<a href>` becomes a native run hyperlink, which also carries the underline the
    // browser draws; the URL is kept instead of being flattened into plain words.
    const inline = {
      tag: node.tag,
      href: node.tag === 'a' && node.attrs && node.attrs.href ? String(node.attrs.href) : undefined
    };
    // An inline box that paints a fill or a border draws a rectangle around its words. A
    // text run has no such rectangle - but it does have a highlighter, so a plain
    // background (no padding, no border, like `<mark>`) becomes one.
    const background = backgroundOf(style);
    const paintsBox = gradientOf(style) || style.border || style.boxShadow;
    if (background || paintsBox) {
      const padding = boxShorthand(style, 'padding');
      const padded = [padding.top, padding.right, padding.bottom, padding.left].some((value) => value > 0);
      if (background && background.hex && !paintsBox && !padded && !elementChildren(node).length) {
        inline.highlight = background.hex;
      } else {
        recordUnsupported(ctx, node, 'inlineBox', node.tag,
          'An inline element that paints a background or border has no native equivalent inside a text run: its text is kept and the paint is dropped');
      }
    }
    // A `::before`/`::after` on the inline element itself (q::before with
    // open-quote) resolves here: the quote keywords take the element's `quotes`,
    // everything literal joins the line as a run - before first, then the words,
    // then after, in source order.
    const inlinePseudoRuns = { before: '', after: '' };
    ['before', 'after'].forEach((pseudo) => {
      if (node.tag === 'li') return; // the list branch owns the item's pseudos
      const declaration = ctx.styles.decoration(node, pseudo);
      if (!declaration) return;
      const resolved = inlinePseudoText(declaration, node);
      if (resolved.unsupported && resolved.word
        && (resolved.word === 'open-quote' || resolved.word === 'close-quote'
          || resolved.word === 'no-open-quote' || resolved.word === 'no-close-quote')) {
        const pair = quotePairOf(style);
        const suppress = resolved.word.startsWith('no-');
        resolved.text = suppress ? '' : (resolved.word === 'open-quote'
          ? (pair ? pair.open : '\u201C') : (pair ? pair.close : '\u201D'));
        delete resolved.unsupported;
      }
      if (resolved.unsupported) {
        recordUnsupported(ctx, node, '::' + pseudo, resolved.unsupported,
          'Generated content beyond a literal string or attr() (counters, quotes) has no value this walker can compute');
        return;
      }
      inlinePseudoRuns[pseudo] = resolved.text;
    });
    // `<q>` is the browser quoting its content: open-quote before, close-quote
    // after. The quotes are painted glyphs in the mock, so they join the line
    // unless the design declares its own pseudos for the element.
    if (node.tag === 'q' && !inlinePseudoRuns.before && !inlinePseudoRuns.after
      && !/^none$/iu.test(String(style.quotes || '').trim())) {
      inlinePseudoRuns.before = '\u201C';
      inlinePseudoRuns.after = '\u201D';
    }
    if (inlinePseudoRuns.before) pushText(inlinePseudoRuns.before, null, inline);
    const merged = Object.assign({}, inheritedStyle || baseStyle, style);
    if (!node.children.length) {
      pushText(normalizedText(node), merged, inline);
      if (inlinePseudoRuns.after) pushText(inlinePseudoRuns.after, null, inline);
      return;
    }
    // A closed <select> shows only the chosen option: the others sit behind the
    // dropdown a static deck cannot open. Visiting every option read them all out
    // loud, so the walk stops at the control and pushes its visible label.
    if (node.tag === 'select') {
      pushText(normalizedText(node), merged, inline);
      return;
    }
    node.children.forEach((child) => visit(child, merged, inline));
    if (inlinePseudoRuns.after) pushText(inlinePseudoRuns.after, null, inline);
  };

  // A `::before`/`::after` box that is not absolutely positioned is an inline box in the
  // host's own line, so its words join the line as runs. They used to be dropped, which lost
  // the arrow, the tag or the number a design puts before every row.
  const pseudoRun = (pseudo) => {
    const declaration = ctx.styles.decoration(domNode, pseudo);
    if (!declaration) return;
    if (String(declaration.position || '').toLowerCase() === 'absolute') return; // a placed overlay
    let resolved = inlinePseudoText(declaration, domNode);
    if (resolved.unsupported && resolved.word
      && (resolved.word === 'open-quote' || resolved.word === 'close-quote'
        || resolved.word === 'no-open-quote' || resolved.word === 'no-close-quote')) {
      // The quote keywords resolve against the element's `quotes` (the UA default
      // pair otherwise); the no- forms suppress, the open/close forms print.
      const pair = quotePairOf(domNode.computedStyle || ctx.styles.computed(domNode));
      const suppress = resolved.word.startsWith('no-');
      resolved = { text: suppress ? '' : (resolved.word === 'open-quote'
        ? (pair ? pair.open : '\u201C') : (pair ? pair.close : '\u201D')) };
    } else if (resolved.unsupported) {
      // A counter() in the content is a generated value the DOM does not carry;
      // dropping it silently loses the numbers a design counts on.
      recordUnsupported(ctx, domNode, '::' + pseudo, resolved.unsupported,
        'Generated content beyond a literal string or attr() (counters, quotes) has no value this walker can compute');
      return;
    }
    if (!resolved.text) return;
    pushText(resolved.text, declaration, null);
  };
  pseudoRun('before');
  if (domNode.tag === 'input') {
    // A text input shows its placeholder: the visible words of the mock.
    pushText(normalizedText(domNode), baseStyle, null);
    return { runs, text: runs.map((run) => run.text).join(''), hasFormatting: runs.some((run) => run.options) };
  }
  if (domNode.tag === 'select') {
    // A closed <select> shows only the chosen option; visiting the children read
    // every option out loud. Push the visible label and stop.
    pushText(normalizedText(domNode), baseStyle, null);
    return { runs, text: runs.map((run) => run.text).join(''), hasFormatting: false };
  }
  (domNode.children || []).forEach((child) => visit(child, baseStyle, null));
  pseudoRun('after');
  const text = runs.map((run) => run.text).join('');
  const hasFormatting = runs.some((run) => run.options);
  return { runs, text, hasFormatting };
}

/** Text nodes that belong to this element and not to a child element. */
function ownText(domNode) {
  return (domNode.children || []).filter((child) => child.type === 'text')
    .map((child) => String(child.text || ''))
    .join(' ')
    .replace(/\s+/gu, ' ')
    .trim();
}

/**
 * Declarations the length evaluator could not resolve, so the caller can report them.
 * A box that silently falls back to the full width is exactly the kind of quiet loss this
 * pipeline is supposed to refuse: `fit-content`, `env()`, `calc()` over `ch` of an unknown
 * font all end up here instead.
 */
const LENGTH_PROPERTIES = [
  'width', 'height', 'minWidth', 'maxWidth', 'minHeight', 'maxHeight',
  'paddingTop', 'paddingRight', 'paddingBottom', 'paddingLeft',
  'marginTop', 'marginRight', 'marginBottom', 'marginLeft',
  'gap', 'rowGap', 'columnGap', 'fontSize'
];

const LENGTH_KEYWORDS = new Set([
  '', 'auto', 'none', 'normal', 'initial', 'inherit', 'unset', 'revert', 'revert-layer', '0'
]);

function unresolvableLengths(style, context) {
  const found = [];
  LENGTH_PROPERTIES.forEach((property) => {
    const value = style[property];
    if (value === undefined || value === null) return;
    const text = String(value).trim();
    if (LENGTH_KEYWORDS.has(text.toLowerCase())) return;
    if (parseLength(text)) return;
    if (evaluateInches(text, context) !== null) return;
    found.push({ property, value: text });
  });
  return found;
}

function resolveKind(domNode, style, children) {
  const tagKind = KIND_BY_TAG[domNode.tag];
  if (tagKind) return tagKind;
  const hasBlockChild = children.some((child) => BLOCK_TAGS.has(child.tag));
  if (hasBlockChild) return 'block';
  const text = normalizedText(domNode);
  if (text) return 'text';
  if (backgroundImageOf(style)) return style.backgroundColor ? 'block' : 'image';
  // A gradient we cannot express still paints a box, so it stays a shape instead of
  // collapsing to a childless block.
  if (backgroundOf(style) || gradientOf(style) || unsupportedGradientOf(style)
    || style.border || style.boxShadow) return 'shape';
  return 'block';
}

/** CSS text-transform is a content change, so it is applied before measuring. */
function transformText(value, transform) {
  if (transform === 'uppercase') return value.toUpperCase();
  if (transform === 'lowercase') return value.toLowerCase();
  if (transform === 'capitalize') {
    return value.replace(/(^|[\s\u3000])([a-z])/gu, (match, lead, letter) => lead + letter.toUpperCase());
  }
  // `full-width` maps the ASCII range onto its fullwidth forms (U+FF01-FF5E) - the
  // CJK typographic request, and the characters already exist in the CJK fonts the
  // deck embeds by face.
  if (transform === 'full-width') {
    return value.replace(/[!-~]/gu, (character) => String.fromCharCode(character.charCodeAt(0) + 0xFEE0));
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

/**
 * `text-overflow: ellipsis` cuts a single line that does not fit and ends it with an
 * ellipsis. That is a *content* change, so it only happens when the CSS asks for it, the
 * line cannot wrap, and the box has a width to clip against - every other combination is
 * reported instead. Returns null when the text already fits.
 */
function truncateWithEllipsis(rawText, maxWidthIn, fontSizePt, slack = 0.02) {
  if (!(maxWidthIn > 0.05)) return null;
  const budget = maxWidthIn * (1 - slack);
  const widthOf = (value) => measureTextPt(value, fontSizePt) / 72;
  if (widthOf(rawText) <= budget) return null;
  const chars = Array.from(rawText);
  const tail = '\u2026';
  if (widthOf(tail) > budget) return tail;
  let low = 0;
  let high = chars.length;
  while (low < high) {
    const middle = Math.ceil((low + high) / 2);
    if (widthOf(chars.slice(0, middle).join('') + tail) <= budget) low = middle;
    else high = middle - 1;
  }
  // Do not leave a dangling space before the ellipsis.
  return chars.slice(0, low).join('').replace(/\s+$/u, '') + tail;
}

function measureTextElement(domNode, style, availableWidth, resolvedFontPx, ctx, options = {}) {
  // The caller already resolved this element's own `font-size`; resolving it again
  // applied `120%` (and `1.2em`) twice and every relative size came out too large.
  const fontPx = resolvedFontPx;
  const fontSizePt = Number((fontPx * 0.75).toFixed(2));
  const { multiple } = lineSpacingOf(style, fontPx);
  const built = buildRuns(domNode, Object.assign({ fontSize: fontPx + 'px' }, style), ctx);
  let textIndent = textIndentOf(style, { parentWidth: availableWidth, fontSizePx: fontPx });
  const measureOptions = { lineHeight: multiple, safetyFactor: 0.92 };
  const trackingPt = letterSpacingPtOf(style);
  if (trackingPt) measureOptions.letterSpacingPt = trackingPt;
  // `each-line` would indent every wrapped line; the native paragraph indent touches
  // only a paragraph's first line. Silently indenting one line while CSS asked for
  // every line is a fake application, so the keyword is named and no indent drawn.
  if (/each-line/iu.test(String(style.textIndent || ''))) {
    recordUnsupported(ctx, domNode, 'textIndent', style.textIndent,
      'The native paragraph indent touches only the first line; each-line would indent every wrapped line, so no indent is drawn');
    textIndent = null;
  }
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
  // Line breaking is modelled at spaces, CJK boundaries and inside a long unbreakable
  // token, which is what `word-break: break-all`/`break-word` ask for - so those stay
  // silent while `keep-all` is reported where the value is checked. Balanced wrapping is
  // the one request this shape cannot honour: it needs the paragraph measured twice.
  const textWrapMode = String(style.textWrap || '').trim().toLowerCase();
  if (textWrapMode === 'balance' || textWrapMode === 'pretty' || textWrapMode === 'stable') {
    recordUnsupported(ctx, domNode, 'textWrap', style.textWrap,
      'Balanced line breaking needs the whole paragraph measured twice, which this shape does not do');
  }
  const whiteSpace = String(style.whiteSpace || 'normal').toLowerCase();
  const noWrap = whiteSpace === 'nowrap';
  // `pre-line` is what this text walk already does - breaks kept, space runs collapsed,
  // the box wraps - so it is an equivalent implementation and not a limitation. The
  // other pre* values keep space runs in CSS, which the walk collapses; that residue
  // is what the report names.
  if (whiteSpace !== 'normal' && !noWrap && whiteSpace !== 'pre-line'
    && whiteSpace !== 'pre' && whiteSpace !== 'pre-wrap') {
    recordUnsupported(ctx, domNode, 'whiteSpace', style.whiteSpace,
      'Line breaks are kept, but runs of spaces collapse to one, which '
        + whiteSpace + ' preserves');
  }
  if (noWrap) measureOptions.noWrap = true;
  // A run with its own size is measured at that size: charging `12 个夹具` to the 33pt
  // number reserved two lines for one, and every box below it slid down by a line.
  const width = Math.max(0.2, availableWidth);
  const sized = built.hasFormatting && (built.runs || []).some((run) => run.options
    && Number.isFinite(Number(run.options.fontSize))
    && Math.abs(Number(run.options.fontSize) - fontSizePt) > 0.5);
  const lineBox = fontSizePt * multiple / 72;
  const textHeight = sized && options.richHeight !== false
    ? Math.max(estimateRichTextHeight(built.runs, width, fontSizePt, measureOptions), lineBox)
    : estimateTextHeight(built.text, width, fontSizePt, measureOptions);
  return {
    fontPx,
    fontSizePt,
    lineSpacingMultiple: multiple,
    runs: built.hasFormatting ? built.runs : null,
    text: built.text.replace(/\s*\n\s*/gu, '\n').trim(),
    textIndent: textIndent && textIndent > 0 ? textIndent : undefined,
    noWrap: noWrap || undefined,
    textHeight
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
 *   sideways-lr   → `vert270` (columns left to right)
 *   vertical-lr   → reported: the upright-glyph left-to-right column order is
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
  // DrawingML names two directions: `vert` turns the line 90° clockwise (columns run
  // right to left, CJK upright -> `eaVert`) and `vert270` turns it 90° the other way
  // (columns left to right). That makes `sideways-lr` a direct match, and `vertical-lr`
  // one too whenever the text does not need upright glyphs: with Latin text the two
  // spellings render the same, while upright CJK would need `eaVert270`, which does not
  // exist.
  const needsUprightGlyphs = /[\u2E80-\u9FFF\uF900-\uFAFF\uFF01-\uFF60]/u.test(String(node.text || ''));
  let vertical = { 'vertical-rl': 'eaVert', 'sideways-rl': 'vert' }[value];
  if (!vertical && value === 'sideways-lr') vertical = 'vert270';
  if (!vertical && value === 'vertical-lr' && !needsUprightGlyphs) vertical = 'vert270';
  if (!vertical) {
    recordUnsupported(ctx, domNode, 'writingMode', value,
      value === 'vertical-lr'
        ? 'vertical-lr needs upright CJK glyphs, and DrawingML only names the right-to-left variant (eaVert); sideways-lr is the translatable spelling'
        : 'Only vertical-rl, vertical-lr, sideways-rl and sideways-lr have a native equivalent');
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

/**
 * A background gradient that sits above a picture is painted by its own shape, on top of
 * the picture. Emitting it as a sibling node keeps the layout, the emission and the
 * index-aligned XML patches working exactly as they do for a declared shape.
 */
function insertOverlayNodes(node, ctx) {
  (node.children || []).forEach((child) => insertOverlayNodes(child, ctx));
  if (!node.children || !node.children.length) return;
  const decorated = [];
  node.children.forEach((child) => {
    decorated.push(child);
    if (!child.overlayCss) return;
    decorated.push({
      id: ctx.nextId++,
      tag: child.tag,
      classes: child.classes,
      kind: 'shape',
      style: { backgroundImage: child.overlayCss },
      override: { backgroundImage: child.overlayCss },
      x: child.x,
      y: child.y,
      w: child.w,
      h: child.h,
      contentWidth: child.contentWidth,
      padding: { top: 0, right: 0, bottom: 0, left: 0 },
      border: null,
      radius: child.radius,
      overlayOf: child.id,
      children: []
    });
  });
  node.children.splice(0, node.children.length, ...decorated);
}

function analyzeNode(domNode, slot, inherited, ctx) {
  const node = analyzeNodeTree(domNode, slot, inherited, ctx);
  if (!node) return null;
  applyHeightConstraints(node, slot, ctx);
  // The transform is resolved once the box is measured: a percentage translate resolves
  // against that box, and the rotation rides on the shape's own centre.
  const style = ctx.styles.computed(domNode);
  const transformPlan = transformPlanOf(style.transform,
    Number(node.w) || 0, Number(node.h) || 0, style.transformOrigin);
  if (transformPlan.rotate) node.rotate = transformPlan.rotate;
  if (transformPlan.dx || transformPlan.dy) {
    node.x = Number(((Number(node.x) || 0) + transformPlan.dx).toFixed(4));
    node.y = Number(((Number(node.y) || 0) + transformPlan.dy).toFixed(4));
  }
  if (transformPlan.unsupported.length) {
    recordUnsupported(ctx, domNode, 'transform', transformPlan.unsupported.join(', '),
      'rotate() and translate() have native answers; scale()/skew() and a non-centre'
        + ' transform-origin do not');
  }
  attachDecorations(domNode, node, ctx);
  // A percentage radius that is not a full ellipse is an elliptical corner, and the shape is
  // drawn square: saying so beats letting a rounded card arrive with sharp corners.
  const percentRadius = ellipseOf(ctx.styles.computed(domNode));
  if (percentRadius && percentRadius.percent < 50 && !node.ellipse
    && (node.radius === undefined || node.radius === null) && !node.src && !node.backgroundImage) {
    const style = ctx.styles.computed(domNode);
    recordUnsupported(ctx, domNode, 'borderRadius', style.borderTopLeftRadius || style.borderRadius,
      'A percentage radius below 50% is an elliptical corner, which no native geometry spells:'
        + ' the box is drawn square');
  }
  absoluteChildOverlays(node);
  insertOverlayNodes(node, ctx);
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
    const childStyle = child.style || {};
    // A child that paints its own surface (a pill, a chip, a bordered tag) must keep its
    // own shape: an overlay carries text only, so converting it would drop the paint and
    // paint the words *under* the container's children instead of above them.
    const paintsSurface = Boolean(child.radius || child.ellipse || child.clip
      || backgroundOf(childStyle) || childStyle.border || childStyle.boxShadow);
    const convertible = child.absolute
      && !paintsSurface
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
    // The node itself travels with the descriptor: a leaf that is not a container emits
    // its overlays as ordinary text elements, and those want the full style (colour,
    // tracking, font, role) rather than the handful of fields the engine's overlay
    // builder understands.
    overlay.node = child;
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
      // An inline decoration is already part of the host's text (buildRuns pushed it as a
      // run). Only the shapes that cannot join a line are worth naming.
      const resolved = inlinePseudoText(declaration, domNode);
      const hostCarriesWords = node.kind === 'text' || node.kind === 'list';
      if (resolved.unsupported) {
        skip(pseudo, 'Only a literal string or attr() can join the line: '
          + resolved.unsupported + ' needs generated content the DOM does not carry', content);
      } else if (!resolved.text) {
        skip(pseudo, 'An inline decoration with no words paints nothing this shape can place', content);
      } else if (!hostCarriesWords) {
        skip(pseudo, 'The decoration belongs to a container, whose children have no single line to join', content);
      }
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
    const gradient = gradientOf(declaration);
    const text = content === 'none' || content === 'normal' ? '' : decodeCssContent(content);
    const colour = parseColor(declaration.color);
    if (!(background && background.hex) && !gradient && !text) {
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
    if (gradient) overlay.gradient = gradient;
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
  if (style.display === 'none') return null;
  // `visibility: hidden` keeps the box in the layout - siblings must not move up -
  // but paints nothing. The flag survives to the builder, which skips the emission.
  // `collapse` hides outside the table layout it belongs to; on ordinary boxes CSS
  // defines it as `hidden`, so it takes the same keep-the-hole path.
  const visibilityValue = String(style.visibility || '').toLowerCase();
  const hidden = visibilityValue === 'hidden' || visibilityValue === 'collapse';
  checkUnsupported(ctx, domNode, style);

  const fontSizePx = fontPxOf(style, inherited.fontPx);
  const absolute = isAbsolute(style);
  // Percentages resolve against the containing block, never against an already
  // resolved child slot, otherwise relative widths would be applied twice.
  const parentBoxForWidth = inherited.parentBox || { x: 0, y: 0, w: slot.w, h: null };
  const parentWidth = parentBoxForWidth.w;

  const padding = boxShorthand(style, 'padding');
  const border = parseBorder(style);
  // `double` needs a compound line (cmpd="dbl"); pptxgenjs spells no compound
  // option, so the border would draw as one solid line. Name it.
  if (border && /\bdouble\b/iu.test(String(style.border || style.borderStyle || ''))) {
    recordUnsupported(ctx, domNode, 'borderStyle', style.border || style.borderStyle,
      'A double border needs a compound line, which the writer cannot spell: it draws as one solid line');
  }
  // `outline` paints a uniform ring without taking layout space. The native line is
  // centred on the shape edge where CSS hugs the outside, so the ring shifts in by
  // half a line width - at decoration sizes that is the ring slightly overlapping the
  // box instead of floating outside it, and it is named, not hidden.
  const outline = style.outline ? parseBorder({ border: style.outline }) : null;
  const ring = border || (outline && outline.width > 0 ? outline : null);
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
    // A pinned box with no width hugs its content, so a footer at `left: 56px` does not
    // become a 13in box that hangs off the page. But when BOTH left and right pin the
    // box, CSS resolves the width as the span between the insets - an `inset:` box
    // stretches, it does not hug.
    if (styleWidth === null && left !== null && right !== null) {
      width = Math.max(0, parentBox.w - left - right);
    }
    // The vertical pair works the same way: top and bottom both pinned stretch the
    // height between the insets.
    if (explicitHeight === null && top !== null && bottom !== null && Number.isFinite(parentBox.h)) {
      explicitHeight = Math.max(0, parentBox.h - top - bottom);
    }
    if (styleWidth === null && !(left !== null && right !== null)) {
      const shrink = shrinkToFitWidth(domNode, style, {
        fontSizePx,
        letterSpacingPt: letterSpacingPtOf(style),
        fontManager: ctx.fontManager,
        insetLeft,
        insetRight,
        availableWidth: parentBox.w - (left === null ? 0 : left) - (right === null ? 0 : right)
      });
      if (shrink !== null) width = shrink;
    }
    if (left !== null) x = parentBox.x + left;
    else if (right !== null) x = parentBox.x + parentBox.w - right - width;
    if (top !== null) y = parentBox.y + top;
    else if (bottom !== null && parentBox.h !== null) y = parentBox.y + parentBox.h - bottom - (explicitHeight || 0);
    // A margin offsets the box from its offset position; negative values pull it
    // back toward the edge it came from. CSS resolves an absolute margin here,
    // after the inset position, before layout continues.
    const absMargin = boxShorthand(style, 'margin');
    if (absMargin.left || absMargin.top) {
      x += absMargin.left;
      y += absMargin.top;
    }
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
  // A closed `<details>` shows only its summary in a browser; every renderer here grows
  // the box instead, so the difference is named rather than discovered later.
  if (domNode.tag === 'details' && !(domNode.attrs && 'open' in domNode.attrs)) {
    recordUnsupported(ctx, domNode, 'details', 'closed',
      'A closed details element shows only its summary in a browser; its other content is kept here');
  }
  const kind = resolveKind(domNode, style, elementKids);
  const displayValue = String(style.display || '').trim().toLowerCase();
  alignmentProblems(style, displayValue).forEach(({ property, value, note }) => {
    recordUnsupported(ctx, domNode, property, value,
      'No native spelling for ' + note + ': the box falls back to the flex default, and the'
        + ' alignment the design asked for is not applied');
  });
  const unsupportedGradient = unsupportedGradientOf(style);
  const shadowNote = boxShadowNote(style.boxShadow);
  if (shadowNote) recordUnsupported(ctx, domNode, 'boxShadow', style.boxShadow, shadowNote);
  unresolvableLengths(style, {
    fontSizePx,
    parentWidth,
    parentHeight: slot.h === null ? undefined : slot.h,
    percentBase: parentWidth
  }).forEach((entry) => {
    recordUnsupported(ctx, domNode, 'length', entry.value,
      'This ' + entry.property + ' is not a length this shape can resolve, so the box falls back to the layout default instead of the declared value');
  });
  // A block that holds both text and elements has an inline formatting context: its text
  // would share a line box with those children, which this shape does not model, so the
  // text is not translated at all. Silence here would lose words, so it is reported.
  if (kind === 'block' && elementKids.length && ownText(domNode)) {
    recordUnsupported(ctx, domNode, 'element', domNode.tag,
      'Text directly inside a block that also has element children does not share a line box with them, so it is not translated: wrap it in an element ("'
      + ownText(domNode).slice(0, 32) + '")');
  }
  const corners = radiusCorners(style);
  if (corners && new Set(corners).size > 1) {
    recordUnsupported(ctx, domNode, 'borderRadius', style.borderRadius || style.borderTopLeftRadius,
      'A native rounded rectangle carries one radius: corners ' + corners.map((value) => value.toFixed(2)).join('/')
      + ' keep only the first value');
  }
  if (unsupportedGradient) {
    // Each family fails for its own reason: a radial has no native fill at all, a
    // conic neither, and a repeating linear would need the reader to cycle a ramp
    // the fill model cannot. The box is left unpainted in every case - that part
    // is the same and is what the design needs to know.
    const why = unsupportedGradient === 'radial-gradient'
      ? 'a native fill has no radial mode'
      : unsupportedGradient === 'conic-gradient'
        ? 'a native fill has no angular mode'
        : 'a native fill draws one ramp, not a pattern that repeats it';
    recordUnsupported(ctx, domNode, 'backgroundImage', style.backgroundImage || style.background,
      unsupportedGradient + ' cannot be translated (' + why + '), so the box keeps its geometry and is left unpainted');
  }
  const node = {
    id: ctx.nextId++,
    parentWidth,
    tag: domNode.tag,
    classes: classList(domNode),
    kind,
    style,
    margins: boxShorthand(style, 'margin'),
    radius: radiusOf(style),
    ellipse: (ellipseOf(style) || {}).percent >= 50 || undefined,
    x,
    y,
    w: width,
    h: explicitHeight,
    contentWidth,
    padding,
    border: ring,
    children: []
  };
  // The radius family (mixed corners, elliptical percentages) is judged here for
  // every box; pictures judge their own later with their own wording.
  if (kind !== 'image') applyRadius(node, domNode, style, ctx);
  // CSS fades the whole subtree; a PowerPoint shape can only fade its own paint, so a
  // box with content reports the gap instead of pretending the fade reached its children.
  const opacityValue = Number(style.opacity);
  if (Number.isFinite(opacityValue) && opacityValue >= 0 && opacityValue < 1) {
    if (elementKids.length > 0 && kind !== 'image') {
      recordUnsupported(ctx, domNode, 'opacity', style.opacity,
        'opacity fades the whole subtree; only this box\'s own fill and text are faded, its children keep full opacity');
    } else {
      node.opacity = opacityValue;
    }
  }
  // Stretch alignment may size a box on its cross axis, but never one whose own
  // CSS pinned that axis: an 80px chip in a 415px row stays 80px, top aligned.
  // `clip-path: polygon()` becomes the shape's own geometry. It clips the box, not the
  // subtree, so a box that has children is reported: their paint would escape the polygon.
  const maybeClip = clipPolygonOf(style, width, explicitHeight === null ? 0 : explicitHeight);
  if (maybeClip && maybeClip.unsupported === undefined && explicitHeight !== null) {
    if (elementKids.length && kind !== 'image') {
      recordUnsupported(ctx, domNode, 'clipPath', style.clipPath,
        'clip-path clips the subtree; only this box\'s own paint is clipped, its children keep their shape');
    }
    node.clip = maybeClip;
  } else if (maybeClip) {
    recordUnsupported(ctx, domNode, 'clipPath', style.clipPath,
      explicitHeight === null
        ? 'A clipped box needs a declared height: a custom geometry cannot follow auto height'
        : 'Only polygon() is a custom geometry here; this clip shape has no native spelling');
  }

  if (declaresLength(style.height)) node.fixedHeight = true;
  if (declaresLength(style.width)) node.fixedWidth = true;
  if (hidden) node.hidden = true;

  if (kind === 'unsupported') {
    recordUnsupported(ctx, domNode, 'element', domNode.tag, 'Element type has no native translation');
    return null;
  }

  // Rotation and shift are applied in analyzeNode, once the box is measured.

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

  // `columns: N` flows a block's text into N native columns of one text box. Only plain
  // text children qualify: a card with its own paint between two columns has geometry the
  // split would have to invent, so that case keeps reporting instead.
  const columnPlan = columnPlanOf(domNode, style, contentWidth, fontSizePx, ctx);
  if (columnPlan) {
    Object.assign(node, columnPlan);
    node.h = explicitHeight === null ? columnPlan.textHeight + insetTop + insetBottom : explicitHeight;
    applyRelativeShift(node, style, parentWidth);
    return node;
  }

  if (kind === 'text' || kind === 'list') {
    // A list item is measured on its flattened text: each item is its own paragraph, and the
    // run array only decides which paragraph breaks where.
    // A background picture behind text is a real native pair - the picture element
    // first, the text on top - so the layer travels with the node instead of
    // vanishing behind the words.
    const textLayer = backgroundImageOf(style);
    if (textLayer) {
      node.bgImage = { src: textLayer.src, fit: textLayer.fit, size: textLayer.size || 'auto', focus: textLayer.focus };
      untranslatedBackgroundLayers(style).forEach((what) => {
        recordUnsupported(ctx, domNode,
          'backgroundImage', style.backgroundImage || style.background,
          'Only one picture layer behind the text can be painted: ' + what + ' is dropped');
      });
    }
    const measured = measureTextElement(domNode, style, contentWidth, fontSizePx, ctx,
      { richHeight: kind !== 'list' });
    Object.assign(node, measured);
    if (kind === 'list') {
      const items = readListItems(domNode);
      // A `::before { content: counter(...) }` on the items is a design that numbers
      // rows itself. The list path reads DOM text only, so the counter silently
      // vanished - name it instead.
      // Counters: a reset on the list or any ancestor opens the state, an increment
      // on each item advances it, and a counter() in the before-content prints the
      // value. This covers the numbered-rows design the list spellings serve.
      const counters = {};
      const nestedListsOf = (node) => (node.children || []).filter((child) => child.type === 'element'
        && (child.tag === 'ul' || child.tag === 'ol'));
      const resetOn = (node) => {
        const style = ctx.styles.computed(node);
        const reset = String(style.counterReset || '').trim();
        if (reset && reset !== 'none') {
          reset.split(/\s*,\s*/u).forEach((entry) => {
            const [name, start] = entry.split(/\s+/u);
            const key = name.trim();
            if (!counters[key]) counters[key] = [];
            counters[key].push(start === undefined ? 0 : (Number(start) || 0));
          });
        }
      };
      for (let ancestor = domNode; ancestor; ancestor = ancestor.parent) resetOn(ancestor);
      // The evaluated content is decoded here rather than handed back to the literal
      // walk: a number followed by quoted strings fails the bare-token walk, and the
      // quotes themselves must not print.
      const decodeCounted = (content) => {
        let rest = String(content || '');
        const parts = [];
        while (rest.length) {
          const quote = rest[0];
          if (quote === '"' || quote === "'") {
            let cursor = 1;
            let body = '';
            while (cursor < rest.length && rest[cursor] !== quote) {
              if (rest[cursor] === '\\' && cursor + 1 < rest.length) {
                body += rest[cursor] + rest[cursor + 1];
                cursor += 2;
                continue;
              }
              body += rest[cursor];
              cursor += 1;
            }
            parts.push(decodeCssContent(quote + body + quote));
            rest = rest.slice(cursor + 1);
            continue;
          }
          const bare = /^\s+|[A-Za-z0-9.-]+|\s+/u.exec(rest);
          if (!bare) { rest = rest.slice(1); continue; }
          if (/^\s+$/u.test(bare[0])) { parts.push(' '); rest = rest.slice(bare[0].length); continue; }
          parts.push(bare[0]);
          rest = rest.slice(bare[0].length);
        }
        return parts.join('');
      };
      const currentValue = (key) => {
        const scopes = counters[key];
        return scopes && scopes.length ? scopes[scopes.length - 1] : '';
      };
      // Counter names are custom idents: letters, digits, hyphen, underscore after
      // the first character - 'h1' is a legal name and the letter-only class dropped it.
      const evaluate = (content) => decodeCounted(String(content || '')
        .replace(/counters?\(([A-Za-z0-9_-]+)\s*,\s*('(?:[^']*)'|"(?:[^"]*)")\)/giu, (whole, name, sep) => {
          const scopes = counters[name.trim()] || [];
          return scopes.map((value) => String(value)).join(decodeCssContent(sep.trim()));
        })
        .replace(/counter\(([A-Za-z0-9_-]+)\)/giu, (whole, name) => String(currentValue(name.trim()))));
      const generated = [];
      items.forEach((item) => {
        const itemStyle = ctx.styles.computed(item.node);
        const increment = String(itemStyle.counterIncrement || '').trim();
        if (increment && increment !== 'none') {
          increment.split(/\s*,\s*/u).forEach((entry) => {
            const [name, step] = entry.split(/\s+/u);
            const key = name.trim();
            if (!counters[key] || !counters[key].length) counters[key] = [0];
            const top = counters[key];
            top[top.length - 1] += step === undefined ? 1 : (Number(step) || 0);
          });
        }
        // A nested list under this item opens its own scopes when the walk reaches
        // its items; its reset applies from that point on.
        const incrementScopes = [];
        nestedListsOf(item.node).forEach((nested) => {
          const nestedStyle = ctx.styles.computed(nested);
          const nestedReset = String(nestedStyle.counterReset || '').trim();
          if (nestedReset && nestedReset !== 'none') {
            nestedReset.split(/\s*,\s*/u).forEach((entry) => {
              const [name, start] = entry.split(/\s+/u);
              const key = name.trim();
              if (!counters[key]) counters[key] = [];
              counters[key].push(start === undefined ? 0 : (Number(start) || 0));
              incrementScopes.push(key);
            });
          }
        });
        ['before', 'after'].forEach((pseudo) => {
          const declaration = ctx.styles.decoration(item.node, pseudo);
          if (!declaration) return;
          const raw = String(declaration.content || '');
          // A counter() call is resolved against the state before the literal walk:
          // the call is replaced by its number, and the remaining quoted strings take
          // the normal decoding path.
          const hasCounter = /\bcounter/iu.test(raw);
          const resolved = hasCounter
            ? { text: evaluate(raw) }
            : inlinePseudoText(declaration, item.node);
          if (resolved.unsupported) {
            if (!generated.includes(resolved.unsupported)) generated.push(resolved.unsupported);
            return;
          }
          // A literal prefix joins the item the way an inline pseudo joins any line.
          if (pseudo === 'before' && resolved.text) item.text = resolved.text + item.text;
          else if (pseudo === 'after' && resolved.text) item.text = item.text + resolved.text;
        });
      });
      generated.forEach((value) => recordUnsupported(ctx, domNode, '::before', value,
        'Generated content beyond a literal string or attr() (counters, quotes) has no value this walker can compute'));
      // `list-style: none` is the design asking for no marker at all - a checklist row,
      // a custom-drawn marker - and the native bullet has an `off` switch. The other
      // markers have native spellings: buChar for the round shapes, buAutoNum for the
      // ordered ones.
      let listStyle = String(style.listStyleType || style.listStyle || '').trim().toLowerCase();
      // A UA-default <ol> carries no explicit list-style-type; the browser numbers it
      // 1. 2. 3. Falling through to the round-bullet default drew a bullet where the
      // design asked for a count, so the ordered tag seeds decimal.
      const orderedTag = String(domNode.tag || '').toLowerCase() === 'ol';
      // The `type` attribute is the ordered list's own marker language: A/a/I/i/1.
      const typeAttr = String((domNode.attrs && domNode.attrs.type) || '').trim();
      const TYPE_STYLES = { A: 'upper-alpha', a: 'lower-alpha', I: 'upper-roman', i: 'lower-roman', '1': 'decimal' };
      if (orderedTag && !listStyle && TYPE_STYLES[typeAttr]) listStyle = TYPE_STYLES[typeAttr];
      if (orderedTag && !listStyle) listStyle = 'decimal';
      // MARKER_CHARS follows:
      const MARKER_CHARS = { disc: '2022', circle: '25CB', square: '25AA' };
      const MARKER_NUMBERS = {
        decimal: 'arabicPeriod',
        'lower-alpha': 'alphaLcPeriod', 'lower-latin': 'alphaLcPeriod',
        'upper-alpha': 'alphaUcPeriod', 'upper-latin': 'alphaUcPeriod',
        'lower-roman': 'romanLcPeriod', 'upper-roman': 'romanUcPeriod'
      };
      let markerOption = null;
      if (listStyle !== 'none') {
        if (MARKER_CHARS[listStyle]) markerOption = { code: MARKER_CHARS[listStyle] };
        else if (MARKER_NUMBERS[listStyle]) markerOption = { type: 'number', style: MARKER_NUMBERS[listStyle] };
      }
      node.bullet = listStyle !== 'none' ? (markerOption || true) : null;
      // `start="5"` on the ordered list asks the count to begin at 5; the native
      // buAutoNum carries a startAt. A `reversed` list counts down - DrawingML has
      // no reverse switch, so the honest spelling is the reported one, not a fake
      // forward count.
      if (node.bullet && node.bullet.type === 'number' && domNode.attrs) {
        const startAt = Number(domNode.attrs.start);
        if (Number.isFinite(startAt) && startAt > 0) node.bullet.startAt = startAt;
        // The first item's `value` is the same request spelled on the item: the
        // count starts there.
        const firstItem = (domNode.children || []).find((child) => child.tag === 'li');
        if (!Number.isFinite(Number(domNode.attrs.start))) {
          const itemValue = Number(firstItem && firstItem.attrs && firstItem.attrs.value);
          if (Number.isFinite(itemValue) && itemValue > 0) node.bullet.startAt = itemValue;
        }
        if (domNode.attrs.reversed !== undefined) {
          recordUnsupported(ctx, domNode, 'reversed', domNode.attrs.reversed === null ? '' : String(domNode.attrs.reversed),
            'The native numbered list counts up; there is no reverse switch, so the numbering would read in the wrong order');
        }
      }
      // `::marker { color: ... }` styles the bullet itself, which DrawingML spells as
      // `a:buClr` inside the paragraph properties. The rule targets the `li`, so every
      // item is asked; one colour across them rides on the element, a disagreement is
      // named because the element carries one bullet colour.
      const markerColors = new Set();
      (domNode.children || []).filter((child) => child.type === 'element').forEach((item) => {
        const markerStyle = ctx.styles.decoration(item, 'marker');
        if (!markerStyle) return;
        const markerColor = parseColor(markerStyle.color);
        if (markerColor && markerColor.hex) markerColors.add(markerColor.hex);
      });
      if (markerColors.size === 1) node.markerColor = markerColors.values().next().value;
      else if (markerColors.size > 1) {
        recordUnsupported(ctx, domNode, '::marker', [...markerColors].join(', '),
          'The items want different marker colours; a text box carries one bullet colour, so none was applied');
      }
      node.runs = null;
      // An item's own inline content keeps its styling (a `<strong>` in a bullet, a link
      // inside a bullet), so each item is built as runs rather than one flat string.
      const itemRuns = items.map((item) => {
        const shallow = {
          children: (item.node.children || []).filter((child) =>
            !(child.type === 'element' && (child.tag === 'ul' || child.tag === 'ol')))
        };
        const built = buildRuns(shallow, style, ctx);
        return { level: item.level, text: item.text, ordered: item.ordered, runs: built.hasFormatting ? built.runs : null };
      });
      const rich = itemRuns.some((item) => item.runs) || itemRuns.some((item) => item.level > 0);
      // A nested list is a bullet level, not more words on the parent line: each item is
      // its own paragraph, and the levels PowerPoint already knows carry the indent.
      if (rich) {
        const flat = [];
        itemRuns.forEach((item, index) => {
          const runs = item.runs && item.runs.length ? item.runs : [{ text: item.text }];
          runs.forEach((run, runIndex) => {
            const options = Object.assign({}, run.options);
            // The bullet belongs on the run that starts the paragraph: the writer reads a
            // paragraph's properties from that run, and a run without its own bullet gets
            // `buNone` plus `marL="0"` - which is why every item after the first lost both.
            // Every run of the item carries the bullet: the writer takes a paragraph's
            // properties from the run it closes the paragraph on, which is the last one,
            // so a bullet only on the first run lost the first item of every list.
            // A nested list keeps its own marker language: an ol inside counts, a ul
            // inside rounds - the browser switches markers per level, so the deck does
            // too instead of the outer list's marker on every line.
            const itemOrdered = item.ordered !== undefined ? item.ordered : orderedTag;
            // A nested list keeps its own marker language: an ol inside counts, a ul
            // inside rounds - the browser switches markers per level, so the deck does
            // too instead of the outer list's marker on every line.
            const itemMarker = itemOrdered === orderedTag
              ? (markerOption || true)
              : (itemOrdered
                  ? { type: 'number', style: 'arabicPeriod' }
                  : { code: '2022' });
            options.bullet = itemMarker;
            // `value="7"` starts that item's count at 7; the reader spells it as
            // the paragraph's own buAutoNum startAt.
            if (item.node && item.node.attrs && item.node.attrs.value !== undefined) {
              const startAt = Number(item.node.attrs.value);
              if (Number.isFinite(startAt) && startAt > 0) options.bullet = Object.assign({}, options.bullet, { startAt });
            }
            if (item.level > 0) options.indentLevel = item.level;
            if (runIndex === runs.length - 1 && index < itemRuns.length - 1) options.breakLine = true;
            flat.push(Object.keys(options).length ? { text: run.text, options } : { text: run.text });
          });
        });
        node.text = flat;
      } else {
        node.text = items.map((item) => item.text).join('\n');
      }
      // Each item is measured at the width its level leaves, so an indented item wraps
      // where the browser wraps it instead of where the full width would.
      node.textHeight = items.reduce((sum, item) => sum + estimateTextHeight(
        item.text, Math.max(0.4, contentWidth - item.level * LIST_INDENT_IN),
        measured.fontSizePt,
        { lineHeight: measured.lineSpacingMultiple, safetyFactor: 0.92, noWrap: measured.noWrap }
      ), 0);
    }
    // Padding and border are part of the box: leaving them out of the height made a
    // padded card shorter than it renders, so a wrapped row put the next line on top
    // of it. The text itself still measures at the content width.
    // `text-overflow: ellipsis` only exists for a single line that cannot wrap; the other
    // combinations are reported rather than half-applied.
    // `font-variant: small-caps` is DrawingML's `cap="small"` on the run properties, so it is
  // carried to the writer rather than reported. The other values (`all-small-caps`,
  // `petite-caps`, `unicase`) have no native spelling and keep reporting.
  const fontVariant = String(style.fontVariant || 'normal').toLowerCase().trim();
  if (fontVariant !== 'normal' && fontVariant !== 'none' && fontVariant !== '') {
    if (fontVariant === 'small-caps') {
      node.smallCaps = true;
    } else {
      recordUnsupported(ctx, domNode, 'fontVariant', style.fontVariant,
        'Only small-caps has a native run property; this value has none');
    }
  }

  const textOverflow = String(style.textOverflow || 'clip').toLowerCase();
    if (textOverflow === 'ellipsis') {
      const clips = String(style.overflow || 'visible').toLowerCase();
      if (!node.noWrap) {
        recordUnsupported(ctx, domNode, 'textOverflow', style.textOverflow,
          'An ellipsis needs a single line: a wrapping block cannot be truncated without losing text');
      } else if (clips === 'visible') {
        recordUnsupported(ctx, domNode, 'textOverflow', style.textOverflow,
          'The browser only ellipsizes a box that clips (overflow: hidden)');
      } else if (Number.isFinite(contentWidth) && contentWidth > 0) {
        const cut = truncateWithEllipsis(node.text, contentWidth, measured.fontSizePt);
        if (cut !== null) {
          node.text = cut;
          // Rich runs no longer describe the string, so the line becomes plain text.
          node.runs = null;
          node.textHeight = estimateTextHeight(cut, Math.max(0.2, contentWidth), measured.fontSizePt,
            { lineHeight: measured.lineSpacingMultiple, safetyFactor: 0.92, noWrap: true });
        }
      }
    }
      // `-webkit-line-clamp: N` keeps N lines and ends the last with an ellipsis - the way a
  // card grid gets an even row of excerpts. Browsers only honour it inside a `-webkit-box`,
  // so a clamp written anywhere else is reported instead of silently applied.
  const clampCount = lineClampOf(style);
  if (clampCount > 0 && Number.isFinite(contentWidth) && contentWidth > 0) {
    const clampHost = String(style.display || '').toLowerCase();
    // Both halves of the mechanism are read: the box that makes the clamp legal, and the
    // vertical orientation that gives it lines to count. A horizontal box clamps a column,
    // which is not what a line count means.
    const clampOrient = String(style.WebkitBoxOrient || '').toLowerCase();
    if (clampHost !== '-webkit-box' && clampHost !== '-webkit-inline-box') {
      recordUnsupported(ctx, domNode, 'WebkitLineClamp', style.WebkitLineClamp || style.lineClamp,
        'A clamp is only honoured on `display: -webkit-box`');
    } else if (clampOrient && clampOrient !== 'vertical') {
      recordUnsupported(ctx, domNode, 'WebkitBoxOrient', style.WebkitBoxOrient,
        'A line count needs `-webkit-box-orient: vertical`');
    } else if (node.noWrap) {
      recordUnsupported(ctx, domNode, 'WebkitLineClamp', style.WebkitLineClamp || style.lineClamp,
        'A clamp counts wrapped lines, so it needs wrapping text');
    } else {
      const clampedText = Array.isArray(node.text)
        ? node.text.map((run) => (typeof run === 'string' ? run : run.text)).join('')
        : node.text;
      const clamped = clampText(clampedText, contentWidth, measured.fontSizePt, clampCount,
        { lineHeight: measured.lineSpacingMultiple, safetyFactor: 0.92, noWrap: false });
      if (clamped) {
        node.text = clamped;
        // The runs no longer describe the string once characters are gone.
        node.runs = null;
        node.textHeight = estimateTextHeight(clamped, contentWidth, measured.fontSizePt,
          { lineHeight: measured.lineSpacingMultiple, safetyFactor: 0.92 });
      }
    }
  }
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
      // `background-size: auto` is a natural-size picture centred in the box, not a
      // stretched one: the geometry is resolved here, the emitter just draws it.
      if ((layer.size || 'auto') === 'auto') {
        node.backgroundNatural = true;
        node.objectFit = 'contain';
      } else {
        node.objectFit = layer.fit;
      }
      node.focus = layer.focus;
      checkCornerMix(domNode, style, ctx);
    node.radius = radiusOf(style);
      if ((ellipseOf(style) || {}).percent >= 50) node.ellipse = true;
      // A gradient layer above the picture is a scrim: a second native object paints it.
      const overlay = backgroundOverlayGradientOf(style);
      if (overlay) node.overlayCss = overlay;
      untranslatedBackgroundLayers(style).forEach((what) => {
        recordUnsupported(ctx, domNode, 
          'backgroundImage', style.backgroundImage || style.background,
          'Only one picture layer and one linear gradient above it can be painted: ' + what + ' is dropped');
      });
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
    // `srcset` lets the browser pick a source per density or art direction; the
    // static deck always draws `src`. Same-layout different-pixels is close, but a
    // different crop silently changes the picture - name the choice.
    if (domNode.attrs.srcset) {
      recordUnsupported(ctx, domNode, 'srcset', String(domNode.attrs.srcset),
        'The deck always draws the src image; the variants srcset offers are not consulted');
    }
    node.objectFit = (style.objectFit || 'cover').toLowerCase();
    // CSS opacity on a picture is the native alphaModFix: 40% opacity = 60% transparency.
    const imgOpacity = Number(style.opacity);
    if (Number.isFinite(imgOpacity) && imgOpacity >= 0 && imgOpacity < 1) node.transparency = Number(((1 - imgOpacity) * 100).toFixed(1));
  // `none` shows the picture at its own size and `scale-down` at the smaller of that and the
  // box; both are approximated as `contain`, which scales. Naming it beats scaling quietly.
  if (node.objectFit === 'none' || node.objectFit === 'scale-down') {
    recordUnsupported(ctx, domNode, 'objectFit', style.objectFit,
      'This value is approximated as contain: the picture is scaled to the box instead of'
        + ' keeping its own size');
  } else if (!['cover', 'contain', 'fill'].includes(node.objectFit)) {
    recordUnsupported(ctx, domNode, 'objectFit', style.objectFit,
      'Unknown object-fit value: the picture is cropped to cover the box instead');
  }
    node.focus = descriptionFocus(style.objectPosition);
    checkCornerMix(domNode, style, ctx);
    node.radius = radiusOf(style);
    if ((ellipseOf(style) || {}).percent >= 50) node.ellipse = true;
    else if (ellipseOf(style)) {
      recordUnsupported(ctx, domNode, 'borderRadius', style.borderTopLeftRadius || style.borderRadius,
        'A percentage radius below 50% is an elliptical corner, which no native geometry spells:'
          + ' the picture keeps square corners');
    }
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
    if (table.headerRows) node.headerRows = table.headerRows;
    // The height a declared CSS table already knows; otherwise the rows measured from
    // their real padding and line boxes, so the box reserved here matches what is drawn.
    const estimatedRows = (table.rowHeights || []).reduce((sum, height) => sum + height, 0);
    node.h = explicitHeight === null ? Math.max(0.4, estimatedRows) : explicitHeight;
    // The caption is a text box above the grid, so the table's height has to carry it:
    // whatever follows the table starts below both.
    const caption = captionOf(domNode, ctx, contentWidth);
    if (caption) {
      node.caption = caption;
      node.h = Number((node.h + caption.height).toFixed(4));
    }
    applyRelativeShift(node, style, parentWidth);
    return node;
  }

  const backgroundLayer = backgroundImageOf(style);
  if (backgroundLayer) {
    node.backgroundImage = backgroundLayer;
    // The scrim above the picture is painted by the emitter (deck_builder reads the
    // layer); what matters here is reporting the layers nothing can paint.
    untranslatedBackgroundLayers(style).forEach((what) => {
      recordUnsupported(ctx, domNode, 'backgroundImage', style.backgroundImage || style.background,
        'Only one picture layer and one linear gradient above it can be painted: ' + what + ' is dropped');
    });
  }

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

/**
 * A block with a declared width and `margin: auto` centres itself in the free space.
 * One auto side pushes the box the other way, two split the space. The free space needs
 * a declared width, so a box that hugs its text is reported instead of guessed.
 */
function autoMarginSlotX(style, contentBox, margins, explicitWidth, child, ctx) {
  const left = String(style.marginLeft === undefined ? '' : style.marginLeft).trim().toLowerCase();
  const right = String(style.marginRight === undefined ? '' : style.marginRight).trim().toLowerCase();
  const autoLeft = left === 'auto';
  const autoRight = right === 'auto';
  if (!autoLeft && !autoRight) return contentBox.x + margins.left;
  if (explicitWidth === null) {
    recordUnsupported(ctx, child, 'margin', style.marginLeft || style.marginRight,
      'An auto margin distributes the free space, which needs a declared width: this box hugs its text');
    return contentBox.x + margins.left;
  }
  const free = Math.max(0, contentBox.w - explicitWidth);
  return contentBox.x + (autoLeft && autoRight ? free / 2 : (autoLeft ? free : 0));
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
    return childStyle.display !== 'none';
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
        // A sibling that is out of flow cannot be wrapped beside anything, so a footer
        // pinned with `position: absolute` does not make the band inexact: it is placed
        // whether or not the band is used.
        const stillInFlow = visible.slice(probe).some((sibling) => {
          const siblingStyle = ctx.styles.computed(sibling);
          return !isAbsolute(siblingStyle)
            && siblingStyle.display !== 'none';
        });
        const exact = !stillInFlow || remaining <= FLOAT_BAND_SLACK;
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
    let slot = isAbsolute(childStyle)
      ? anchoredSlot(childStyle, containingBlockFor(childStyle, anchorBox, ctx), inherited)
      : {
        x: autoMarginSlotX(childStyle, contentBox, margins, explicitWidth, child, ctx),
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
  const tolerance = 0.01;
  const rightEdge = contentBox.x + contentBox.w;
  const nodes = [];
  let lineTop = top;
  let lineHeight = 0;
  let lines = 1;
  // Both edges are packed at once. A left float takes width from the left cursor and a
  // right float from the right one, so a run that mixes them meets in the middle - which
  // is what the browser does: the two stack from opposite edges and the line box that is
  // left between them carries the text.
  let leftCursor = contentBox.x;
  let rightCursor = rightEdge;
  let usedLeft = false;
  let usedRight = false;
  const startLine = () => {
    lineTop += lineHeight;
    lineHeight = 0;
    leftCursor = contentBox.x;
    rightCursor = rightEdge;
    lines += 1;
  };

  run.forEach((entry) => {
    const direction = floatOf(entry.style) || 'left';
    const margins = childMargins(entry.style, options);
    const declared = inchesOf(entry.style.width, 'x', options);
    if (declared === null) {
      // Shrink-to-fit is max-content, which a container does not measure.
      recordUnsupported(ctx, entry.child, 'float', floatOf(entry.style),
        'A floated box needs a declared width here: its shrink-to-fit width is not measured');
    }
    const width = Math.max(0.02, declared === null ? contentBox.w : declared);
    const outer = width + margins.left + margins.right;
    const fits = direction === 'right'
      ? rightCursor - outer >= leftCursor - tolerance
      : leftCursor + outer <= rightCursor + tolerance;
    if (!fits && lineHeight > 0) {
      startLine();
      usedLeft = false;
      usedRight = false;
    }
    const slot = {
      x: direction === 'right' ? rightCursor - margins.right - width : leftCursor + margins.left,
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
    if (direction === 'right') {
      rightCursor -= outer;
      usedRight = true;
    } else {
      leftCursor += outer;
      usedLeft = true;
    }
  });

  // The strip this run leaves free, but only while it stays on one line: a run that
  // wrapped leaves a band that differs per line, and a single text box cannot express
  // that, so the caller keeps reporting instead. When both edges were used the free strip
  // is the middle one, which is exactly where the browser puts the text.
  let band = null;
  if (lines === 1) {
    const bandX = usedLeft ? leftCursor : contentBox.x;
    const bandRight = usedRight ? rightCursor : rightEdge;
    const bandWidth = bandRight - bandX;
    if (bandWidth > 0.5) band = { x: bandX, w: bandWidth };
  }
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

/**
 * Re-resolve `align-items`/`align-self` inside a single-line flex row once the row's own
 * height is final. A row that grew because of `flex: 1` or a declared height makes its
 * stretched children fill it - the in-loop pass could only see the content height, because
 * the parent had not been sized yet.
 */
function applyRowStretch(node) {
  if (!node) return;
  const style = node.style || {};
  const isRow = String(style.display || '') === 'flex'
    && String(style.flexDirection || 'row').toLowerCase().startsWith('row')
    && !String(style.flexWrap || 'nowrap').toLowerCase().startsWith('wrap');
  if (isRow) {
    const padding = node.padding || {};
    const inner = Math.max(0, (Number(node.h) || 0) - (padding.top || 0) - (padding.bottom || 0));
    const contentY = (Number(node.y) || 0) + (padding.top || 0);
    const alignItems = String(style.alignItems || 'stretch').toLowerCase();
    (node.children || []).filter((child) => !child.absolute).forEach((child) => {
      const self = child.alignSelf || alignItems;
      if (self === 'stretch') {
        if (!child.fixedHeight && child.h < inner) child.h = inner;
      } else if (self === 'center') {
        child.y = contentY + (inner - child.h) / 2;
      } else if (self === 'end' || self === 'flex-end') {
        child.y = contentY + inner - child.h;
      }
    });
  }
  (node.children || []).forEach(applyRowStretch);
}

/**
 * `flex-direction: column; flex-wrap: wrap`: items stack until the container's height runs
 * out, then a new column starts beside it.
 *
 * Two declarations are load-bearing and are reported when missing: the container needs a
 * definite height (that is what the break is measured against) and every item needs a
 * declared width (that is the column's cross size - an auto-width item would be sized by
 * its max-content width, which this shape measures nowhere). Everything else comes from
 * the shared break/distribution helpers, so the engine reaches the same columns.
 */
function layoutWrappedColumn(domNode, style, contentBox, inherited, ctx, flow) {
  if (!Number.isFinite(contentBox.h)) {
    recordUnsupported(ctx, domNode, 'flexWrap', style.flexWrap,
      'A wrapping column needs a definite height to break against');
    return null;
  }
  const options = { parentWidth: contentBox.w, fontSizePx: inherited.fontPx };
  const undeclared = flow.filter((child) => inchesOf(ctx.styles.computed(child).width, 'x', options) === null);
  if (undeclared.length) {
    recordUnsupported(ctx, domNode, 'flexWrap', style.flexWrap,
      'Every item of a wrapping column needs a declared width: a column takes its width from '
      + 'its items, and an auto width would be the item\u2019s max-content size');
    return null;
  }

  const mainGap = flexGap(style, 'column');
  const crossGap = flexGap(style, 'row');
  const entries = flow.map((child) => {
    const childStyle = ctx.styles.computed(child);
    const margins = childMargins(childStyle, options);
    const width = inchesOf(childStyle.width, 'x', options);
    const node = analyzeNode(child, { x: contentBox.x, y: contentBox.y, w: width, h: null }, inherited, ctx);
    if (!node) return null;
    const self = alignSelfOf(childStyle);
    if (self) node.alignSelf = self;
    node.fixedWidth = true;
    if (declaresLength(childStyle.height)) node.fixedHeight = true;
    return { node, margins, width };
  }).filter(Boolean);
  if (!entries.length) return [];

  // Columns: how many items fit before the height runs out (shared with the engine).
  const groups = flexColumns(
    entries.map((entry) => ({ base: entry.node.h + entry.margins.top + entry.margins.bottom, grow: 0 })),
    Math.max(0, contentBox.h),
    mainGap
  );
  const columnWidths = groups.map((group) =>
    group.indices.reduce((max, index) => Math.max(max, entries[index].width), 0));
  const totalWidth = columnWidths.reduce((sum, width) => sum + width, 0)
    + crossGap * Math.max(0, groups.length - 1);
  // Columns are the lines of a column container, so `align-content` distributes them on the
  // inline axis - the same helper the row case uses for its lines.
  const distribution = alignLines(columnWidths, totalWidth, contentBox.w, alignContentOf(style));
  const alignItems = String(style.alignItems || 'stretch').toLowerCase();
  const justify = String(style.justifyContent || 'flex-start').toLowerCase();

  let columnCursor = contentBox.x;
  groups.forEach((group, columnIndex) => {
    const { top: columnShift, extra: columnExtra } = distribution[columnIndex];
    const columnWidth = columnWidths[columnIndex] + columnExtra;
    // `columnShift` distributes the columns; the cursor itself never moves by it.
    const left = columnCursor + columnShift;
    const entriesHere = group.indices.map((index) => entries[index]);
    const columnHeight = entriesHere.reduce((sum, entry, index) =>
      sum + entry.node.h + entry.margins.top + entry.margins.bottom
      + (index < entriesHere.length - 1 ? mainGap : 0), 0);
    const free = Math.max(0, contentBox.h - columnHeight);
    let offset = 0;
    let extra = 0;
    if (justify === 'center') offset = free / 2;
    else if (justify === 'flex-end' || justify === 'end') offset = free;
    else if (justify === 'space-between' && entriesHere.length > 1) extra = free / (entriesHere.length - 1);
    else if (justify === 'space-around') {
      offset = free / (2 * entriesHere.length);
      extra = free / entriesHere.length;
    } else if (justify === 'space-evenly') {
      // Each of the n+1 gaps - both edges included - is the same width.
      offset = free / (entriesHere.length + 1);
      extra = free / (entriesHere.length + 1);
    }
    let cursor = contentBox.y + offset;
    entriesHere.forEach((entry) => {
      const align = entry.node.alignSelf || alignItems;
      let x = left;
      if (align === 'center') x = left + (columnWidth - entry.width) / 2;
      else if (align === 'end' || align === 'flex-end') x = left + columnWidth - entry.width;
      // The subtree travels with the item: its children were measured at the earlier
      // position and the engine replays them relative to the box it is handed.
      shiftSubtree(entry.node, cursor + entry.margins.top - entry.node.y,
        x + entry.margins.left - entry.node.x);
      cursor += entry.node.h + entry.margins.top + entry.margins.bottom + mainGap + extra;
    });
    columnCursor += columnWidth + crossGap;
  });
  return entries.map((entry) => entry.node);
}

function layoutFlex(domNode, contentBox, inherited, ctx) {
  const style = ctx.styles.computed(domNode);
  const direction = String(style.flexDirection || 'row').startsWith('column') ? 'column' : 'row';
  const gap = flexGap(style, direction);
  const kids = sortByOrder(elementChildren(domNode).filter((child) => {
    const childStyle = ctx.styles.computed(child);
    return childStyle.display !== 'none';
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

  if (direction === 'column' && String(style.flexWrap || 'nowrap').toLowerCase().startsWith('wrap')) {
    const wrapped = layoutWrappedColumn(domNode, style, contentBox, inherited, ctx, flow);
    if (wrapped) return wrapped.concat(absolute);
  }
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
      const style = node.style || {};
      const autoLeft = String(style.marginLeft || '').trim().toLowerCase() === 'auto';
      const autoRight = String(style.marginRight || '').trim().toLowerCase() === 'auto';
      // An auto margin absorbs the free space on the cross axis before `align-items` gets
      // a say, which is how a fixed-width paragraph centres itself in a flex column.
      // The shift keeps the analyzer box right; `alignSelf` is how the same decision
      // reaches the engine, which places a declarative column child from that field.
      if (autoLeft && autoRight && Number.isFinite(node.w)) {
        node.alignSelf = 'center';
        shiftSubtree(node, 0, (contentBox.x + (contentBox.w - node.w) / 2) - node.x);
        return;
      }
      if (autoLeft && !autoRight && Number.isFinite(node.w)) {
        node.alignSelf = 'end';
        shiftSubtree(node, 0, (contentBox.x + contentBox.w - node.w) - node.x);
        return;
      }
      const align = node.alignSelf || alignItems;
      let targetX = node.x;
      if (align === 'center') targetX = contentBox.x + (contentBox.w - node.w) / 2;
      else if (align === 'end' || align === 'flex-end') targetX = contentBox.x + contentBox.w - node.w;
      else if (align === 'stretch' && !node.fixedWidth) {
        targetX = contentBox.x;
        node.w = Math.max(node.w, contentBox.w);
      }
      // A child that moves takes its own children with it: their boxes are relative to it,
      // and the engine replays them from the box it is handed.
      shiftSubtree(node, 0, targetX - node.x);
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
      } else if (justify === 'space-evenly') {
        offset = free / (measured.length + 1);
        extra = free / (measured.length + 1);
      }
      {
        let line = contentBox.y + offset;
        measured.forEach(({ node, margins }) => {
          const targetY = line + margins.top;
          shiftSubtree(node, targetY - node.y, 0);
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
    } else if (justify === 'space-evenly') {
      startX += slack / (count + 1);
      extraGap = slack / (count + 1);
    }

    // Auto margins absorb the line's slack: count them, each takes an equal share.
    let autoCount = 0;
    line.indices.forEach((index) => {
      const itemStyle = ctx.styles.computed(flow[index]);
      if (String(itemStyle.marginLeft || '').trim().toLowerCase() === 'auto') autoCount += 1;
      if (String(itemStyle.marginRight || '').trim().toLowerCase() === 'auto') autoCount += 1;
    });
    const autoShare = autoCount ? slack / autoCount : 0;
    let cursor = startX;
    const lineNodes = [];
    line.indices.forEach((index, position) => {
      const child = flow[index];
      // `margin: auto` on a flex item absorbs line slack before the item: both sides
      // of one item split it (centering a declared-width item).
      const itemStyle = ctx.styles.computed(child);
      const autoLeft = String(itemStyle.marginLeft || '').trim().toLowerCase() === 'auto';
      const autoRight = String(itemStyle.marginRight || '').trim().toLowerCase() === 'auto';
      const share = autoLeft ? autoShare : 0;
      if (autoLeft) cursor += share;
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
      if (autoRight) cursor += autoShare;
      cursor += widthsInLine[position] + gap + extraGap;
    });
    // Each line's cross size is its own tallest item, but a container whose height the
    // CSS pinned gives a *single* line all of its inner height: `align-items: stretch`
    // then fills the container, not just the tallest sibling.
    const tallestInLine = lineNodes.reduce((max, node) => Math.max(max, node.h), 0);
    const isSingleLine = lines.length === 1;
    const lineCross = isSingleLine && Number.isFinite(contentBox.h)
      ? Math.max(tallestInLine, contentBox.h)
      : tallestInLine;
    lineNodes.forEach((node) => {
      const align = node.alignSelf || alignItems;
      if (align === 'stretch' && !node.fixedHeight) node.h = Math.max(node.h, lineCross);
      else if (align === 'center') node.y = lineTop + (lineCross - node.h) / 2;
      else if (align === 'end' || align === 'flex-end') node.y = lineTop + lineCross - node.h;
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
    return childStyle.display !== 'none';
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

/**
 * The colour each header cell paints is the colour a design gives that series.
 * A th styled `.s1 { color: #1C4B57 }` is a per-series colour declaration in the
 * language a designer actually writes; reading it keeps the chart on the page
 * palette instead of the theme defaults.
 */
function headerSeriesColours(domNode, ctx) {
  const findFirstRow = (node) => {
    let found = null;
    (node.children || []).forEach((child) => {
      if (child.type !== 'element') return;
      if (child.tag === 'tr') found = found || child;
      else if (child.tag === 'thead' || child.tag === 'tbody') found = found || findFirstRow(child);
    });
    return found;
  };
  const tableNode = findTableNode(domNode);
  const headerRow = tableNode ? findFirstRow(tableNode) : null;
  if (!headerRow) return [];
  return elementChildren(headerRow)
    .filter((cell) => cell.tag === 'th' || cell.tag === 'td')
    .map((cell) => {
      const colour = parseColor(ctx.styles.computed(cell).color);
      return colour && colour.hex ? colour.hex : null;
    });
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
      // Header cells that paint a colour name their series; the list rides in series
      // order so the chart matches the page palette.
      const seriesColours = headerSeriesColours(domNode, ctx).slice(1)
        .filter((colour) => colour);
      // An explicit data-chart-colors attribute is a design statement: it outranks
      // the palette the header cells merely inherit.
      if (seriesColours.length === seriesCount && !options.chartColors) options.chartColors = seriesColours;
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
  // An unknown data-chart-* attribute is a typo, and a typo in a styling attribute
  // is a silently lost style. Name it.
  const KNOWN_CHART_ATTRS = new Set(['data-chart', 'data-chart-colors', 'data-chart-labels',
    'data-chart-label-position', 'data-chart-value-format', 'data-chart-axis-titles',
    'data-chart-legend', 'data-chart-title', 'data-chart-grid', 'data-chart-grouping',
    'data-chart-dir', 'data-chart-text-color', 'data-values', 'data-labels',
    'data-chart-gap-width', 'data-chart-smooth', 'data-chart-cat-label-rotate',
    'data-chart-hole-size', 'data-chart-legend-font-size', 'data-chart-y-min',
    'data-chart-y-max', 'data-chart-label-format', 'data-chart-secondary-axis']);
  Object.keys(attrs).filter((name) => name.startsWith('data-chart-') && !KNOWN_CHART_ATTRS.has(name))
    .forEach((name) => {
      recordUnsupported(ctx, domNode, name, String(attrs[name]),
        'Unknown chart attribute; the styling it asks for is not applied');
    });
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

  // Reader-native chart tuning: bar gap width, line smoothing, category label
  // rotation - each maps to one pptxgenjs option.
  const gapWidth = attrs['data-chart-gap-width'];
  if (gapWidth !== undefined) {
    const value = Number(gapWidth);
    if (Number.isFinite(value) && value >= 0 && value <= 500) options.barGapWidthPct = value;
    else recordUnsupported(ctx, domNode, 'data-chart-gap-width', gapWidth, 'Use a percentage from 0 to 500');
  }
  const smooth = attrs['data-chart-smooth'];
  if (smooth !== undefined) {
    const value = String(smooth).trim().toLowerCase();
    if (value === 'true' || value === '1') options.lineSmooth = true;
    else if (value === 'false' || value === '0') options.lineSmooth = false;
    else recordUnsupported(ctx, domNode, 'data-chart-smooth', smooth, 'Use true or false');
  }
  const holeSize = attrs['data-chart-hole-size'];
  if (holeSize !== undefined) {
    const value = Number(holeSize);
    if (Number.isFinite(value) && value >= 10 && value <= 90) options.holeSize = value;
    else recordUnsupported(ctx, domNode, 'data-chart-hole-size', holeSize, 'Use a percentage from 10 to 90');
  }
  const legendFontSize = attrs['data-chart-legend-font-size'];
  if (legendFontSize !== undefined) {
    const value = Number(legendFontSize);
    if (Number.isFinite(value) && value > 0) options.legendFontSize = value;
    else recordUnsupported(ctx, domNode, 'data-chart-legend-font-size', legendFontSize, 'Use a font size in points');
  }
  // Axis bounds, a data-label number format and a secondary axis all carry native
  // spellings the reader honours.
  const yMin = attrs['data-chart-y-min'];
  if (yMin !== undefined) {
    const value = Number(yMin);
    if (Number.isFinite(value)) options.valAxisMinVal = value;
    else recordUnsupported(ctx, domNode, 'data-chart-y-min', yMin, 'Use a number');
  }
  const yMax = attrs['data-chart-y-max'];
  if (yMax !== undefined) {
    const value = Number(yMax);
    if (Number.isFinite(value)) options.valAxisMaxVal = value;
    else recordUnsupported(ctx, domNode, 'data-chart-y-max', yMax, 'Use a number');
  }
  const labelFormat = attrs['data-chart-label-format'];
  if (labelFormat !== undefined) {
    if (String(labelFormat).trim()) options.dataLabelFormatCode = String(labelFormat).trim();
    else recordUnsupported(ctx, domNode, 'data-chart-label-format', labelFormat, 'Use an Excel number format code');
  }
  const secondary = attrs['data-chart-secondary-axis'];
  if (secondary !== undefined) {
    if (/^(true|on)$/iu.test(String(secondary).trim())) options.secondaryValAxis = true;
    else if (/^(false|off)$/iu.test(String(secondary).trim())) options.secondaryValAxis = false;
    else recordUnsupported(ctx, domNode, 'data-chart-secondary-axis', secondary, 'Use true or false');
  }
  const labelRotate = attrs['data-chart-cat-label-rotate'];
  if (labelRotate !== undefined) {
    const value = Number(labelRotate);
    if (Number.isFinite(value) && value >= -90 && value <= 90) options.catAxisLabelRotate = value;
    else recordUnsupported(ctx, domNode, 'data-chart-cat-label-rotate', labelRotate, 'Use an angle from -90 to 90');
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

/**
 * One `<td>`/`<th>`: the text, the cell options PowerPoint understands, the span it
 * covers, and the numbers a row height needs later.
 */
function readTableCell(cell, ctx, rowBackground) {
  const style = ctx.styles.computed(cell);
  const color = parseColor(style.color);
  const background = backgroundOf(style) || rowBackground;
  const weight = String(style.fontWeight || '').toLowerCase();
  const sizePt = parseLength(style.fontSize);
  const fontSizePt = sizePt ? Number((toInches(sizePt, {}) * 72).toFixed(2)) : 10.5;
  // An OOXML table cell has no corner geometry; a styled radius would silently
  // square off. Named once per table (the flag lives on the ctx).
  if (radiusOf(style) && !ctx.cellRadiusNamed) {
    ctx.cellRadiusNamed = true;
    recordUnsupported(ctx, cell, 'borderRadius', style.borderRadius,
      'A table cell has no corner geometry in the file format; the radius squares off');
  }
  const colspan = spanOf(cell, 'colspan', 12);
  const rowspan = spanOf(cell, 'rowspan', 64);
  const padding = boxShorthand(style, 'padding');
  const paddingPt = [padding.top, padding.right, padding.bottom, padding.left]
    .map((value) => Number((value * 72).toFixed(2)));
  const text = normalizedText(cell);
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
  return {
    node: cell,
    style,
    text,
    options,
    colspan,
    rowspan,
    metrics: {
      column: 0,
      colspan,
      rowspan,
      text,
      fontSizePt,
      lineHeight: lineSpacingOf(style, fontSizePt).multiple,
      paddingTop: padding.top,
      paddingBottom: padding.bottom,
      paddingLeft: padding.left,
      paddingRight: padding.right
    }
  };
}

/** One bullet level of indent, matching what PowerPoint gives `indentLevel`. */
const LIST_INDENT_IN = 0.25;

/**
 * The words of one list item: its text and inline children, but not a nested list,
 * which is a deeper bullet level rather than more words on this line.
 */
function ownListItemText(item) {
  const parts = [];
  (item.children || []).forEach((child) => {
    if (child.type === 'text') { parts.push(child.text); return; }
    if (child.type !== 'element') return;
    if (child.tag === 'ul' || child.tag === 'ol') return;
    parts.push(normalizedText(child));
  });
  return parts.join(' ').replace(/\s+/gu, ' ').trim();
}

function readListItems(domNode, level = 0, out = [], parentOrdered = null) {
  const ordered = String(domNode.tag || '').toLowerCase() === 'ol';
  elementChildren(domNode).filter((child) => child.tag === 'li').forEach((item) => {
    const own = ownListItemText(item);
    if (own) out.push({ node: item, text: own, level, ordered });
    elementChildren(item).filter((child) => child.tag === 'ul' || child.tag === 'ol')
      .forEach((nested) => readListItems(nested, level + 1, out, ordered));
  });
  // Loose markup nests one list directly inside another (a ul inside a ul with no
  // li between). The browser still renders its items, so the walk follows it.
  elementChildren(domNode).filter((child) => child.tag === 'ul' || child.tag === 'ol')
    .forEach((nested) => readListItems(nested, level + 1, out, ordered));
  return out;
}

/**
 * A `<caption>` as its own text box.
 *
 * CSS draws it above the table grid, and a PowerPoint table has no caption part. The other
 * candidate - a merged first row - is schema-valid but LibreOffice lays the rest of the table
 * out off the page when row 0 carries a gridSpan, so it cannot be verified anywhere here.
 */
function captionOf(domNode, ctx, contentWidth) {
  const captionElement = (domNode.children || []).find((child) =>
    child.type === 'element' && child.tag === 'caption' && String(normalizedText(child) || '').trim());
  if (!captionElement) return null;
  const style = ctx.styles.computed(captionElement);
  if (style.display === 'none' || style.visibility === 'hidden') return null;
  const text = String(normalizedText(captionElement) || '').replace(/\s+/gu, ' ').trim();
  if (!text) return null;
  const size = parseLength(style.fontSize);
  const fontSizePt = size ? Number((toInches(size, {}) * 72).toFixed(2)) : 10.5;
  const padding = boxShorthand(style, 'padding');
  const lineHeight = lineSpacingOf(style, fontSizePt).multiple;
  const height = estimateTextHeight(text, Math.max(0.2, contentWidth), fontSizePt, {
    marginIn: 0,
    lineHeight,
    verticalInsetIn: padding.top + padding.bottom
  });
  const color = parseColor(style.color);
  const weight = String(style.fontWeight || '').toLowerCase();
  const caption = {
    text,
    fontSizePt,
    lineHeight,
    height: Number(height.toFixed(4)),
    align: String(style.textAlign || 'left').toLowerCase(),
    paddingTop: Number((padding.top * 72).toFixed(2)),
    paddingBottom: Number((padding.bottom * 72).toFixed(2))
  };
  if (color && color.hex) caption.color = color.hex;
  if (weight === 'bold' || Number(weight) >= 600) caption.bold = true;
  // `caption-side: bottom` moves the whole caption under the grid - a real placement
  // the native text box can take, not a report.
  if (String(style.captionSide || '').trim().toLowerCase() === 'bottom') caption.below = true;
  if (String(style.fontStyle || '').toLowerCase() === 'italic') caption.italic = true;
  return caption;
}

function readTable(domNode, ctx, contentWidth) {
  const rows = [];
  const rowNodes = [];
  // A row or section may carry the background a browser paints behind its cells -
  // the usual way a striped table is written. A cell inherits it visually, so the
  // first declared background wins: cell, then row, then section, then table.
  const collect = (node, sectionBackground, inHeader) => {
    (node.children || []).forEach((child) => {
      if (child.type !== 'element') return;
      if (child.tag === 'tr') rowNodes.push({ rowNode: child, sectionBackground, header: inHeader });
      else if (child.tag === 'thead' || child.tag === 'tbody' || child.tag === 'tfoot') {
        collect(child, backgroundOf(ctx.styles.computed(child)) || sectionBackground,
          inHeader || child.tag === 'thead');
      }
    });
  };
  collect(domNode, backgroundOf(ctx.styles.computed(domNode)), false);

  // Phase 1: read every row's cells the way the DOM presents them.
  const rawRows = rowNodes.map(({ rowNode, sectionBackground }) => {
    const rowBackground = backgroundOf(ctx.styles.computed(rowNode)) || sectionBackground;
    const cells = elementChildren(rowNode).filter((child) => child.tag === 'td' || child.tag === 'th');
    return cells.map((cell) => readTableCell(cell, ctx, rowBackground));
  });

  // Phase 2: place the cells on the grid `colspan` and `rowspan` describe. A browser walks
  // each row left to right and skips the slots an earlier row reserved, and so does this.
  // Only the cells that *start* in a row are emitted: PptxGenJS writes the merge
  // placeholders itself from `colspan`/`rowspan`, so emitting the covered cells too would
  // add a column per span and shift the whole table.
  const occupied = [];
  const carried = [];
  let columns = 0;
  const grid = rawRows.map((cells, rowIndex) => {
    if (!occupied[rowIndex]) occupied[rowIndex] = [];
    if (!carried[rowIndex]) carried[rowIndex] = [];
    const placed = [];
    let column = 0;
    cells.forEach((cell) => {
      while (occupied[rowIndex][column]) column += 1;
      const rowspan = Math.min(cell.rowspan, Math.max(1, rawRows.length - rowIndex));
      if (rowspan !== cell.rowspan) {
        recordUnsupported(ctx, cell.node, 'rowspan', cell.rowspan,
          'A rowspan reaching past the last row is clipped to the rows that exist');
        if (rowspan > 1) cell.options.rowspan = rowspan;
        else delete cell.options.rowspan;
      }
      for (let rowOffset = 0; rowOffset < rowspan; rowOffset += 1) {
        const target = rowIndex + rowOffset;
        if (!occupied[target]) occupied[target] = [];
        if (!carried[target]) carried[target] = [];
        for (let columnOffset = 0; columnOffset < cell.colspan; columnOffset += 1) {
          occupied[target][column + columnOffset] = true;
          // A rowspan covers the slots of the rows below it; those rows must not emit a
          // cell there, because the merge placeholder already fills the slot.
          if (rowOffset > 0) carried[target][column + columnOffset] = true;
        }
      }
      cell.metrics.column = column;
      placed.push(Object.assign(cell, { column, rowspan }));
      column += cell.colspan;
    });
    columns = Math.max(columns, column);
    return placed;
  });
  columns = Math.max(columns, ...occupied.map((marks) => marks.length));

  // The table's own CSS border is the perimeter a browser draws in border-collapse
  // mode. A perimeter cell that does not declare that edge itself takes the table's,
  // wider of the two winning as CSS says - so the outline is not silently lost.
  const tableBorderStyle = ctx.styles.computed(domNode);
  const tableBorderEdges = BORDER_SIDES.map((side) => {
    const declaration = borderSideDeclaration(tableBorderStyle, side);
    return Object.keys(declaration).length ? parseBorder(declaration) : null;
  });
  const anyTableEdge = tableBorderEdges.some((edge) => edge);
  if (anyTableEdge) {
    grid.forEach((placed, rowIndex) => {
      placed.forEach((cell) => {
        const cellStyle = cell.style || {};
        // Compose the effective style: the cell's own declarations win, and the
        // table's perimeter edges fill only the sides the cell left silent.
        const composed = Object.assign({}, tableBorderStyle, cellStyle);
        const onTop = rowIndex === 0;
        const onBottom = rowIndex === grid.length - 1;
        const onLeft = cell.column === 0;
        const onRight = cell.column + cell.colspan === columns;
        const perimeter = { borderTop: onTop, borderRight: onRight, borderBottom: onBottom, borderLeft: onLeft };
        BORDER_SIDES.forEach((side, index) => {
          const longhand = ['borderTop', 'borderRight', 'borderBottom', 'borderLeft'][index];
          if (!perimeter[longhand]) return;
          const own = borderSideDeclaration(cellStyle, side);
          if (Object.keys(own).length) return;
          const edge = tableBorderEdges[index];
          if (!edge) return;
          composed[longhand] = edge.width + 'px ' + edge.style + ' #' + edge.color;
        });
        cell.options.border = cellBorderOptions(composed);
      });
    });
  }

  // Phase 3: emit the rows. A slot the HTML leaves unused is an empty cell in a browser,
  // so it is emitted as one instead of letting PowerPoint close the gap.
  const metrics = [];
  grid.forEach((placed, rowIndex) => {
    const rowMetrics = [];
    const emitted = [];
    let cursor = 0;
    let next = 0;
    while (cursor < columns) {
      if (carried[rowIndex][cursor]) {
        cursor += 1;
        continue;
      }
      const cell = placed[next];
      if (cell && cell.column === cursor) {
        emitted.push({ text: cell.text, options: cell.options });
        rowMetrics.push(cell.metrics);
        cursor += cell.colspan;
        next += 1;
      } else {
        emitted.push({ text: '', options: {} });
        cursor += 1;
      }
    }
    // Any cell that never found its column still has to be drawn.
    while (next < placed.length) {
      emitted.push({ text: placed[next].text, options: placed[next].options });
      rowMetrics.push(placed[next].metrics);
      next += 1;
    }
    rows.push(emitted);
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
  const cellHeight = (cell) => {
    const width = cellSpanWidth(measureWidths, cell.column, cell.colspan);
    const usable = Math.max(0.1, width - cell.paddingLeft - cell.paddingRight);
    return estimateTextHeight(cell.text, usable, cell.fontSizePt, {
      marginIn: 0,
      lineHeight: cell.lineHeight,
      verticalInsetIn: cell.paddingTop + cell.paddingBottom
    });
  };
  const rowHeights = metrics.map((cells) => {
    // A rowspan cell is measured over the rows it covers, further down.
    const tallest = cells.reduce((max, cell) => (cell.rowspan > 1 ? max : Math.max(max, cellHeight(cell))), 0);
    return Number(Math.max(0.16, tallest).toFixed(4));
  });
  metrics.forEach((cells, rowIndex) => {
    cells.forEach((cell) => {
      if (!(cell.rowspan > 1)) return;
      const share = cellHeight(cell) / cell.rowspan;
      for (let offset = 0; offset < cell.rowspan && rowIndex + offset < rowHeights.length; offset += 1) {
        rowHeights[rowIndex + offset] = Number(Math.max(rowHeights[rowIndex + offset], share).toFixed(4));
      }
    });
  });
  // Only leading `<thead>` rows can be repeated at the top of a continuation page.
  let headerRows = 0;
  while (headerRows < rowNodes.length && rowNodes[headerRows].header) headerRows += 1;
  return { rows, columns, colWidths, rowHeights, headerRows };
}

/** Width of the columns a cell spans, from the resolved track widths. */
function cellSpanWidth(colWidths, column, span) {
  let width = 0;
  for (let index = column; index < column + span; index += 1) {
    width += Number.isFinite(colWidths[index]) ? colWidths[index] : 0;
  }
  return width;
}

/** `columns: N` (or `column-count`) as an integer, or 0 when the block is single column. */
function columnCountOf(style) {
  const raw = style.columnCount !== undefined ? style.columnCount : style.columns;
  if (raw === undefined || raw === null) return 0;
  const value = Number(String(raw).trim().split(/\s+/u)[0]);
  return Number.isFinite(value) && value > 1 ? Math.min(16, Math.floor(value)) : 0;
}

/** The gap between columns in inches: `column-gap` when it is a length, else 0.4in. */
function columnGapIn(style, fontSizePx, parentWidth) {
  const gap = inchesOf(style.columnGap, 'x', { parentWidth, fontSizePx });
  return gap === null ? 0.4 : Math.max(0, gap);
}

const COLUMN_INLINE_TAGS = new Set(['span', 'a', 'b', 'strong', 'i', 'em', 'u', 's', 'del', 'ins',
  'code', 'kbd', 'samp', 'mark', 'small', 'sup', 'sub', 'br', 'abbr', 'cite', 'q', 'time']);

function onlyInlineDescendants(node) {
  return elementChildren(node).every((child) =>
    COLUMN_INLINE_TAGS.has(child.tag) && onlyInlineDescendants(child));
}

/** One `polygon()` coordinate as inches, or null when the unit is not resolvable here. */
function polygonLength(token, extentIn) {
  const value = String(token === undefined || token === null ? '' : token).trim();
  if (!value) return null;
  const percent = /^(-?[0-9.]+)%$/u.exec(value);
  if (percent) return extentIn * Number(percent[1]) / 100;
  if (/^calc\(/iu.test(value)) return null;
  const inches = inchesOf(value, 'x', { parentWidth: extentIn, fontSizePx: 16 });
  return inches;
}

/**
 * `circle()`/`ellipse()` when they cut the inscribed round shape, as native ellipse
 * geometry. A percentage radius on `circle()` resolves against the box's half-diagonal
 * (the CSS reference extent), so only a square box makes `circle(50%)` inscribed;
 * `ellipse(50% 50%)` is inscribed on every box. An `at <position>` centre and any
 * non-inscribed radius cannot become the box's own geometry.
 */
function inscribedRoundOf(value, widthIn, heightIn) {
  const circle = /^circle\s*\(\s*([^)]+?)\s*\)$/iu.exec(value);
  const ellipse = /^ellipse\s*\(\s*([^)]+?)\s*\)$/iu.exec(value);
  if (!circle && !ellipse) return null;
  const args = ((circle ? circle[1] : ellipse[1]) || '').trim();
  if (/\bat\b/iu.test(args)) return null;
  const radiusOf = (argument, basis) => {
    const trimmed = String(argument || '').trim();
    const percent = /^([\d.]+)%$/u.exec(trimmed);
    if (percent) return (Number(percent[1]) / 100) * basis;
    const length = parseLength(trimmed);
    if (!length || length.unit === '%') return null;
    return toInches(length, {});
  };
  if (circle) {
    // A bare `circle()` defaults to closest-side, which is the inscribed radius.
    const reference = /^\s*$/u.test(args)
      ? Math.min(widthIn, heightIn) / 2
      : radiusOf(args, Math.sqrt(widthIn * widthIn + heightIn * heightIn) / Math.SQRT2);
    if (reference === null || !Number.isFinite(reference)) return null;
    if (Math.abs(reference * 2 - widthIn) > 0.004 || Math.abs(reference * 2 - heightIn) > 0.004) return null;
    return { ellipse: true, width: Number((widthIn * 96).toFixed(2)), height: Number((heightIn * 96).toFixed(2)) };
  }
  const radii = args.split(/\s+/u).filter(Boolean);
  if (radii.length !== 2) return null;
  const rx = radiusOf(radii[0], widthIn);
  const ry = radiusOf(radii[1], heightIn);
  if (rx === null || ry === null || !Number.isFinite(rx) || !Number.isFinite(ry)) return null;
  if (Math.abs(rx * 2 - widthIn) > 0.004 || Math.abs(ry * 2 - heightIn) > 0.004) return null;
  return { ellipse: true, width: Number((widthIn * 96).toFixed(2)), height: Number((heightIn * 96).toFixed(2)) };
}

/**
 * `clip-path: polygon(...)` as a DrawingML custom geometry.
 *
 * PowerPoint has no CSS clip: the shape itself is the clip, so a polygon becomes a
 * `custGeom` path whose points are the corners. Coordinates are kept in CSS pixels
 * relative to the border box, which is the unit `a:path` expects to be scaled from.
 */
function clipPolygonOf(style, widthIn, heightIn) {
  const raw = style.clipPath;
  if (!raw) return null;
  const value = String(raw).trim();
  if (!value || value === 'none') return null;
  const round = inscribedRoundOf(value, widthIn, heightIn);
  if (round) return round;
  const match = /^polygon\s*\(([\s\S]*)\)$/iu.exec(value);
  if (!match) return { unsupported: value };
  const parts = match[1].split(',').map((part) => part.trim()).filter(Boolean);
  if (parts.length < 3) return { unsupported: value };
  const widthPx = Math.max(1, widthIn * 96);
  const heightPx = Math.max(1, heightIn * 96);
  const points = [];
  for (const part of parts) {
    const tokens = part.split(/\s+/u).filter(Boolean);
    // A `polygon()` vertex can carry a rounding keyword after its two lengths.
    if (tokens.length < 2) return { unsupported: value };
    const x = polygonLength(tokens[0], widthIn);
    const y = polygonLength(tokens[1], heightIn);
    if (x === null || y === null) return { unsupported: value };
    points.push([Number((x * 96).toFixed(2)), Number((y * 96).toFixed(2))]);
  }
  return { points, width: Number(widthPx.toFixed(2)), height: Number(heightPx.toFixed(2)) };
}

function columnPlanOf(domNode, style, contentWidth, fontSizePx, ctx) {
  const count = columnCountOf(style);
  if (count === 0) return null;
  const children = elementChildren(domNode);
  const bail = (reason) => {
    recordUnsupported(ctx, domNode, 'columns', style.columns || style.columnCount, reason);
    return null;
  };
  if (!children.length || ownText(domNode)) {
    return bail('A column block has to hold paragraph elements; text of its own is a line box this shape does not model');
  }
  // `column-span: all` pulls one child out of the column flow to span every column:
  // the native text box columns cannot exempt a paragraph, so the design is named
  // instead of silently column-wrapping the headline.
  if (children.some((child) => String(ctx.styles.computed(child).columnSpan || '').trim().toLowerCase() === 'all')) {
    return bail('A child asks to span every column; the native text box wraps every paragraph, no exemptions');
  }
  const paragraphs = [];
  let rich = false;
  for (const child of children) {
    const childStyle = ctx.styles.computed(child);
    if (childStyle.display === 'none') continue;
    const words = String(normalizedText(child) || '').trim();
    if (!words) continue;
    if (!onlyInlineDescendants(child)) {
      return bail('Every child of a column block has to be a paragraph of inline content; <' + child.tag + '> holds blocks');
    }
    // A child that paints its own box cannot be poured into a column: its background would be
    // cut in half at the column edge, which is geometry the design never asked for.
    const padding = boxShorthand(childStyle, 'padding');
    if (backgroundOf(childStyle) || parseBorder(childStyle) || padding.top || padding.left) {
      return bail('A column child cannot paint its own box; <' + child.tag + '> has a background, border or padding');
    }
    const built = buildRuns(child, childStyle, ctx);
    if (built.hasFormatting) rich = true;
    paragraphs.push({ text: words, runs: built.hasFormatting ? built.runs : null });
  }
  if (!paragraphs.length) return null;
  const gapIn = columnGapIn(style, fontSizePx, contentWidth);
  const columnWidth = Math.max(0.4, (contentWidth - gapIn * (count - 1)) / count);
  const fontSizePt = Number((fontSizePx * 0.75).toFixed(2));
  const lineSpacing = lineSpacingOf(style, fontSizePx);
  const plain = paragraphs.map((paragraph) => paragraph.text).join('\n');
  // The height is measured on the plain text at the column width, so both models agree on how
  // many rows the columns need; runs only change how the words are painted.
  const needed = estimateTextHeight(plain, columnWidth, fontSizePt,
    { lineHeight: lineSpacing.multiple, safetyFactor: 0.92 });
  const perRow = fontSizePt * lineSpacing.multiple / 72;
  const rows = Math.max(1, Math.ceil(Math.round(needed / perRow) / count));
  let emitted = plain;
  if (rich) {
    const flat = [];
    paragraphs.forEach((paragraph, index) => {
      const runs = paragraph.runs && paragraph.runs.length ? paragraph.runs : [{ text: paragraph.text }];
      runs.forEach((run, runIndex) => {
        const options = Object.assign({}, run.options);
        if (runIndex === runs.length - 1 && index < paragraphs.length - 1) options.breakLine = true;
        flat.push(Object.keys(options).length ? { text: run.text, options } : { text: run.text });
      });
    });
    emitted = flat;
  }
  return {
    kind: 'text',
    role: 'body',
    text: emitted,
    runs: null,
    fontSizePt,
    lineSpacingMultiple: lineSpacing.multiple,
    textHeight: Number((rows * perRow).toFixed(4)),
    columns: { count, gapIn: Number(gapIn.toFixed(4)) },
    ...(String(style.fontVariant || '').toLowerCase().trim() === 'small-caps' ? { smallCaps: true } : {})
  };
}

/**
 * `-webkit-line-clamp` as a line count, or 0 when the element does not ask for one.
 * The property is spelled with a capital W after the cascade camel-cases it.
 */
function lineClampOf(style) {
  const raw = style.WebkitLineClamp !== undefined ? style.WebkitLineClamp
    : style.webkitLineClamp !== undefined ? style.webkitLineClamp : style.lineClamp;
  if (raw === undefined || raw === null) return 0;
  const value = Number(String(raw).trim());
  return Number.isFinite(value) && value > 0 ? Math.floor(value) : 0;
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
/** A class, id or attribute that names speaker notes rather than slide content. */
const NOTES_HINT = /(^|[-_\s])(note|notes|speaker|presenter|script)([-_\s]|$)/iu;

/**
 * Speaker notes are content a browser hides and PowerPoint keeps. A hidden element whose
 * class says "notes" is exactly the reveal.js convention, so its text becomes the speaker
 * notes of that slide instead of vanishing with the rest of the hidden DOM.
 */
function readSlideNotes(slideNode, ctx) {
  const collected = [];
  const visit = (node, hidden) => {
    (node.children || []).forEach((child) => {
      if (child.type !== 'element') return;
      const style = ctx.styles.computed(child);
      const hiddenHere = hidden || String(style.display || '').toLowerCase() === 'none'
        || String(style.visibility || '').toLowerCase() === 'hidden';
      const label = [child.tag, ...classList(child), (child.attrs && child.attrs.id) || ''].join(' ');
      if (hiddenHere && NOTES_HINT.test(label)) {
        const text = normalizedText(child).trim();
        if (text) collected.push(text);
        return;
      }
      visit(child, hiddenHere);
    });
  };
  visit(slideNode, false);
  const declared = slideNode.attrs && (slideNode.attrs['data-notes'] || slideNode.attrs.notes);
  if (declared) collected.unshift(String(declared).trim());
  const text = collected.filter(Boolean).join('\n\n');
  return text || null;
}

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
    // The root list is built here rather than by `analyzeNode`, so the scrim pass that
    // turns a gradient-over-picture into a sibling shape has to run on it too.
    insertOverlayNodes({ children }, ctx);

    // The root is not emitted as a container, so a decoration on it has no host.
    ['before', 'after'].forEach((pseudo) => {
      const declaration = ctx.styles.decoration(slideNode, pseudo);
      if (!declaration) return;
      recordUnsupported(ctx, slideNode, '::' + pseudo, declaration.content,
        'A decoration on the slide root has no container to anchor to; put it on a card or panel');
    });

    const notes = readSlideNotes(slideNode, ctx);
    slides.push({
      index: index + 1,
      background: background.hex || 'FFFFFF',
      gradient,
      notes,
      nodes: children
    });
    // A container's height can come from its own parent (`flex: 1`, a declared height),
    // which is only known once the parent is sized - after its children were laid out.
    // `align-items: stretch` then fills that height, so the cross-axis alignment is
    // resolved once more, top-down, against the final boxes.
    children.forEach(applyRowStretch);
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
      // A clipping box that holds an oversized absolute picture is the crop idiom:
      // the visible part is an intersection, and the native spelling for that
      // intersection is a crop rectangle in source fractions. Converting keeps the
      // picture inside its frame instead of drawing past it.
      if (String((node.style && node.style.overflow) || '').toLowerCase() === 'hidden') {
        (node.children || []).forEach((child) => {
          if (!child.absolute || child.tag !== 'img') return;
          const boxLeft = node.x, boxTop = node.y;
          const boxRight = node.x + node.w, boxBottom = node.y + node.h;
          const imgLeft = child.x, imgTop = child.y;
          const imgRight = child.x + child.w, imgBottom = child.y + child.h;
          if (imgLeft >= boxLeft - 0.005 && imgTop >= boxTop - 0.005
            && imgRight <= boxRight + 0.005 && imgBottom <= boxBottom + 0.005) return;
          const cropLeft = Math.max(0, (boxLeft - imgLeft) / child.w);
          const cropTop = Math.max(0, (boxTop - imgTop) / child.h);
          const cropRight = Math.max(0, (imgRight - boxRight) / child.w);
          const cropBottom = Math.max(0, (imgBottom - boxBottom) / child.h);
          child.x = Math.max(imgLeft, boxLeft);
          child.y = Math.max(imgTop, boxTop);
          child.w = Math.min(imgRight, boxRight) - child.x;
          child.h = Math.min(imgBottom, boxBottom) - child.y;
          child.objectFit = 'crop';
          child.crop = { left: cropLeft, top: cropTop, right: cropRight, bottom: cropBottom };
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
