'use strfot';

/**
 * Layout tree → Native Deck Spec (stage 3 of the HTML → Native pipeline).
 *
 * The analyzer has already resolved CSS intent into geometry. This stage maps
 * semantics and visual attributes onto native PowerPoint objects:
 *
 *   text          → native text box (role-aware) with optional rich-text runs
 *   list          → native text box with PowerPoint bullets
 *   group / card  → native `container` (row / column / grid) + optional surface
 *   image         → native picture with an editable crop rectangle
 *   table         → native PowerPoint table (rows/cells stay editable)
 *   line / hr     → native connector
 *
 * Design decision: a subtree whose CSS intent is expressible as a container is
 * emitted *declaratively* (`direction`, `gap`, `padding`, `align`, `justify`,
 * `columns`, per-child `margin`/`flex`), so its layout is described once and can
 * be re-resolved. Because the analyzer and the engine are two implementations of
 * the same rules, every declarative group is then re-resolved by the engine and
 * compared with the analyzer's boxes; any disagreement above `BOX_TOLERANCE`
 * demotes that subtree to explicit coordinates. That keeps the conversion
 * geometry-preserving while removing the duplicated flex/grid math wherever it
 * is provably safe.
 */

const defaultTheme = require('../themes/default');
const { resolveTheme } = require('../themes/design_system');
const { layoutSlide } = require('../engine/layout');
// Background pictures are sized and placed here, before the picture element exists, so the
// focus arithmetic is the engine's rather than a second copy of it.
const { normalizeFocus } = require('../engine/image_fit');
const {
  parseColor,
  parseBoxShadow,
  backgroundOf,
  backgroundOverlayGradientOf,
  evaluateInches,
  gradientOf
} = require('./css');

const GENERIC_FAMILIES = {
  'sans-serif': null,
  'serif': 'Georgia',
  'monospace': 'Consolas',
  'cursive': null,
  'system-ui': null,
  '-apple-system': null
};

const FIT_BY_OBJECT_FIT = {
  cover: 'cover',
  contain: 'contain',
  fill: 'stretch',
  // `background-size: 100% 100%` arrives as the fit-mode spelling; without this key it fell
  // through to a cover crop, so a stretched background was cropped in silence.
  stretch: 'stretch',
  none: 'none',
  'scale-down': 'scale-down',
  crop: 'crop'
};

/** Maximum tolerated deviation (inches) between analyzer and engine boxes. */
const BOX_TOLERANCE = 0.012;
const MAX_LAYOUT_ATTEMPTS = 4;

const ZERO_MARGIN = { top: 0, right: 0, bottom: 0, left: 0 };

const ALIGN_BY_CSS = {
  stretch: 'stretch',
  'flex-start': 'start',
  start: 'start',
  center: 'center',
  'flex-end': 'end',
  end: 'end'
};

const JUSTIFY_BY_CSS = {
  'flex-start': 'start',
  start: 'start',
  center: 'center',
  'flex-end': 'end',
  end: 'end',
  'space-between': 'space-between',
  'space-around': 'space-around',
  'space-evenly': 'space-evenly'
};

function round4(value) {
  return Number(Number(value).toFixed(4));
}

function firstFontFamily(value) {
  if (!value) return null;
  const first = String(value).split(',')[0].trim().replace(/^["']|["']$/gu, '').trim();
  if (!first) return null;
  const lower = first.toLowerCase();
  if (Object.prototype.hasOwnProperty.call(GENERIC_FAMILIES, lower)) return GENERIC_FAMILIES[lower];
  return first;
}

function hexOrNull(value) {
  const parsed = parseColor(value);
  return parsed && parsed.hex ? parsed : null;
}

function transparencyOf(parsed) {
  if (!parsed || parsed.alpha === undefined || parsed.alpha === null) return undefined;
  const transparency = Math.round((1 - parsed.alpha) * 100);
  return transparency > 0 ? transparency : undefined;
}

function marginsOf(node) {
  return (node && node.margins) || ZERO_MARGIN;
}

function hasMargin(node) {
  const margin = marginsOf(node);
  return margin.top !== 0 || margin.right !== 0 || margin.bottom !== 0 || margin.left !== 0;
}

function isGroup(node) {
  return !!node && (node.children || []).length > 0;
}

/** Derive a Native theme from CSS custom properties when the source declares them. */
function deriveTheme(variables = {}, baseTheme) {
  const pick = (...names) => {
    for (const name of names) {
      const value = variables['--' + name];
      if (!value) continue;
      const color = hexOrNull(value);
      if (color) return color.hex;
    }
    return null;
  };
  const fontPick = (...names) => {
    for (const name of names) {
      const value = variables['--' + name];
      if (value) return firstFontFamily(value) || undefined;
    }
    return undefined;
  };
  const theme = {
    colors: {},
    fonts: {},
    sizes: {},
    spacing: {},
    radii: {},
    typography: {}
  };
  const mapping = {
    background: pick('background', 'bg', 'color-background', 'surface-page'),
    foreground: pick('foreground', 'color-foreground', 'text', 'color-text', 'ink'),
    primary: pick('primary', 'color-primary', 'brand'),
    accent: pick('accent', 'color-accent', 'highlight'),
    muted: pick('muted', 'color-muted', 'subtle'),
    surface: pick('surface', 'color-surface', 'card'),
    border: pick('border', 'color-border', 'divider')
  };
  Object.keys(mapping).forEach((key) => {
    if (mapping[key]) theme.colors[key] = mapping[key];
  });
  const heading = fontPick('font-heading', 'font-display', 'heading-font', 'color-font-heading');
  const body = fontPick('font-body', 'font-base', 'body-font');
  if (heading) theme.fonts.heading = heading;
  if (body) theme.fonts.body = body;
  const cjk = fontPick('font-cjk', 'font-chinese');
  if (cjk) theme.fonts.cjk = cjk;
  return resolveTheme(Object.assign({}, baseTheme || defaultTheme, theme));
}

function textElementFromNode(node, theme, resolvedTheme) {
  const style = node.style || {};
  const color = hexOrNull(style.color);
  const role = node.role || 'body';
  const isHeadingRole = role === 'title' || role === 'heading';
  const fontFace = firstFontFamily(style.fontFamily)
    || (isHeadingRole ? resolvedTheme.fonts.heading : resolvedTheme.fonts.body);
  const weight = String(style.fontWeight || '').toLowerCase();
  const align = String(style.textAlign || 'left').toLowerCase();
  const letterSpacing = style.letterSpacing;
  // `columns: N` is one text box with N native columns, which is exactly what PowerPoint
  // calls a columned body: the reader splits the text itself, so editing still reflows.
  const element = {
    type: 'text',
    role,
    text: node.runs || node.text,
    x: Number(xOf(node).toFixed(4)),
    y: Number(yOf(node).toFixed(4)),
    w: Number(Math.max(0.05, node.w).toFixed(4)),
    h: Number(Math.max(0.05, node.h).toFixed(4)),
    fontFace,
    fontSize: Math.max(4, Number((node.fontSizePt || 14).toFixed(2))),
    color: (color && color.hex) || (isHeadingRole ? resolvedTheme.colors.primary : resolvedTheme.colors.foreground),
    bold: weight === 'bold' || weight === 'bolder' || Number(weight) >= 600,
    italic: String(style.fontStyle || '').toLowerCase() === 'italic',
    align: ['left', 'center', 'right', 'justify'].includes(align) ? align : 'left',
    valign: role === 'caption' || role === 'body' ? 'top' : 'middle',
    lineSpacingMultiple: node.lineSpacingMultiple,
    // What the analyzer measured the words to need, next to the box it gave them: a reader
    // that renders the deck can tell an auto-sized box from one the design fixed.
    textHeight: Number(Math.max(0, node.textHeight || 0).toFixed(4))
  };
  const transparency = transparencyOf(color);
  // Two alphas multiply, they do not replace each other: a `rgba()` colour inside a box
  // with `opacity: 0.5` ends up half as opaque again.
  const opacityFactor = node.opacity === undefined ? 1 : node.opacity;
  const fromOpacity = opacityFactor < 1 ? Math.round((1 - opacityFactor) * 100) : 0;
  const combined = 100 - Math.round(((100 - (transparency || 0)) * (100 - fromOpacity)) / 100);
  if (combined) element.transparency = combined;
  // `cap="small"` is a run property the writer has no option for, so it travels on the
  // element and is patched into the part after the file is written.
  if (node.smallCaps) element.smallCaps = true;
  if (node.columns) {
    element.columns = node.columns.count;
    element.columnGap = node.columns.gapIn;
  }
  if (letterSpacing) {
    const match = /^(-?[\d.]+)(px|pt|em|rem)?$/u.exec(String(letterSpacing).trim());
    if (match) {
      const magnitude = Number(match[1]);
      const unit = match[2] || 'px';
      const points = unit === 'px' ? magnitude * 0.75
        : unit === 'pt' ? magnitude
          : unit === 'em' ? magnitude * (node.fontSizePt || 14)
            : magnitude * 12;
      if (Number.isFinite(points) && points !== 0) element.charSpacing = Number(points.toFixed(2));
    }
  }
  if (node.bullet) element.bullet = node.bullet === true ? true : node.bullet;
  // `::marker` styles the bullet, not the text: the colour rides to the writer as its
  // own field so a red dot stays a red dot.
  if (node.markerColor) element.markerColor = node.markerColor;
  // First-line indent travels as a paragraph property; the writer patches
  // `<a:pPr indent="…">` because PptxGenJS has no option for it.
  if (Number.isFinite(node.textIndent) && node.textIndent > 0) {
    element.textIndent = Number(node.textIndent.toFixed(4));
  }
  // `white-space: nowrap` becomes `bodyPr wrap="none"` in the writer.
  if (node.noWrap) element.nowrap = true;
  // `writing-mode: vertical-rl` becomes `bodyPr vert="eaVert"`; the box is the
  // author's, because in vertical text the height is the line length.
  if (node.vert) element.vert = node.vert;
  return element;
}

function surfaceElementFromNode(node, resolvedTheme) {
  const style = node.style || {};
  const background = backgroundOf(style);
  const gradient = gradientOf(style);
  const shadow = parseBoxShadow(style.boxShadow || '');
  const radius = node.radius === undefined ? null : node.radius;
  const border = node.border;
  if (!background && !gradient && !shadow && !border) return null;

  const element = {
    type: 'shape',
    x: Number(xOf(node).toFixed(4)),
    y: Number(yOf(node).toFixed(4)),
    w: Number(Math.max(0.02, node.w).toFixed(4)),
    h: Number(Math.max(0.02, node.h).toFixed(4)),
    fill: background ? background.hex : resolvedTheme.colors.surface
  };
  const fillTransparency = transparencyOf(background);
  if (fillTransparency !== undefined) element.fillTransparency = fillTransparency;
  if (gradient) {
    element.gradient = nativeGradient(gradient);
    element.fill = gradient.stops[0].color;
  }
  // `border-radius: 50%` is the inscribed ellipse: a real geometry, not a rounded rectangle
  // with a large corner radius, which would draw a stadium on a non-square box.
  if (node.ellipse) element.shape = 'ellipse';
  else if (radius) element.radius = radius;
  // An inscribed circle/ellipse clip *is* the shape: the paint fills the box, and the
  // round geometry cuts exactly where the native ellipse does, so the clip travels as
  // the shape itself rather than a polygon patch.
  if (node.clip && node.clip.ellipse) element.shape = 'ellipse';
  else if (node.clip) element.clip = node.clip;
  if (border) {
    element.lineColor = border.color;
    element.lineWidth = border.width;
    if (border.transparency) element.lineTransparency = border.transparency;
    if (border.dash) element.lineDash = border.dash;
  } else if (!background && !gradient && !shadow) {
    return null;
  } else {
    element.line = false;
  }
  if (shadow) element.shadow = shadow;
  const opacity = node.opacity === undefined ? Number(style.opacity) : node.opacity;
  if (Number.isFinite(opacity) && opacity < 1) element.transparency = Math.round((1 - opacity) * 100);
  return element;
}

/**
 * Containers are layout-only, so a container's own single-side border travels as
 * `edge` and the engine draws the strip once the box is resolved.
 */
/**
 * Copy the parts of a node that describe its box rather than its content: the
 * single-side border strip, and whether CSS pinned the width or the height. The
 * engine needs the latter to know what stretch alignment may resize.
 */
/**
 * The position the box occupies in the flow. A `position: relative` offset is
 * applied again by the engine, so the spec carries the static position and the
 * shift separately - otherwise a container child would be placed twice.
 */
function xOf(node) {
  return Number.isFinite(node.staticX) ? node.staticX : node.x;
}

function yOf(node) {
  return Number.isFinite(node.staticY) ? node.staticY : node.y;
}

function attachBoxFacts(element, node) {
  if (node.relativeShift) element.relativeShift = Object.assign({}, node.relativeShift);
  if (node.fixedWidth) element.fixedWidth = true;
  if (node.fixedHeight) element.fixedHeight = true;
  if (!node.edge) return element;
  element.edge = Object.assign({}, node.edge);
  return element;
}

/**
 * A box that paints nothing of its own (a bare `<div>` whose only style is one
 * border side) still has an edge to draw, so the strip is emitted on its own
 * instead of being dropped with the invisible box.
 */
function standaloneEdgeElement(node) {
  const edge = node.edge;
  if (!edge) return null;
  const thickness = Math.max(0.01, Number((edge.width / 72).toFixed(4)));
  const round = (value) => Number(value.toFixed(4));
  const element = { type: 'shape', fill: edge.color, line: false };
  if (edge.side === 'top') {
    Object.assign(element, { x: round(xOf(node)), y: round(yOf(node)), w: round(node.w), h: thickness });
  } else if (edge.side === 'bottom') {
    Object.assign(element, {
      x: round(xOf(node)), y: round(yOf(node) + node.h - thickness), w: round(node.w), h: thickness
    });
  } else if (edge.side === 'left') {
    Object.assign(element, { x: round(xOf(node)), y: round(yOf(node)), w: thickness, h: round(node.h) });
  } else {
    Object.assign(element, {
      x: round(xOf(node) + node.w - thickness), y: round(yOf(node)), w: thickness, h: round(node.h)
    });
  }
  return element;
}

function imageElementFromNode(node) {
  if (!node.src) return null;
  const element = {
    type: 'image',
    x: Number(xOf(node).toFixed(4)),
    y: Number(yOf(node).toFixed(4)),
    w: Number(Math.max(0.05, node.w).toFixed(4)),
    h: Number(Math.max(0.05, node.h).toFixed(4)),
    fit: FIT_BY_OBJECT_FIT[node.objectFit] || 'cover'
  };
  if (/^data:/iu.test(node.src) || /^https?:/iu.test(node.src)) element.data = node.src;
  else element.path = node.src;
  if (node.alt) element.altText = node.alt;
  if (node.focus) element.focus = node.focus;
  if (node.radius) element.radius = node.radius;
  if (node.border) {
    element.lineColor = node.border.color;
    element.lineWidth = node.border.width;
  }
  if (node.transparency !== undefined) element.transparency = node.transparency;
  if (node.crop) element.crop = node.crop;
  return element;
}

/** Column widths must sum to the table width, or PowerPoint draws a ragged table. */
function tableColumnWidths(node, columns, total) {
  const declared = node.colWidths;
  if (!Array.isArray(declared) || declared.length !== columns) {
    return Array.from({ length: columns }, () => Number((total / columns).toFixed(3)));
  }
  const sum = declared.reduce((accumulator, width) => accumulator + (Number.isFinite(width) ? width : 0), 0);
  if (sum <= 0) return Array.from({ length: columns }, () => Number((total / columns).toFixed(3)));
  const scaled = declared.map((width) => (Number.isFinite(width) && width > 0 ? (width / sum) * total : 0));
  const rounded = scaled.map((width) => Number(width.toFixed(3)));
  const drift = Number((total - rounded.reduce((accumulator, width) => accumulator + width, 0)).toFixed(3));
  rounded[rounded.length - 1] = Number((rounded[rounded.length - 1] + drift).toFixed(3));
  return rounded;
}

function captionElementFromNode(node, resolvedTheme) {
  const caption = node.caption;
  if (!caption || !caption.text) return null;
  // The default side is top: the caption sits above the grid. `bottom` drops it under
  // the grid, which means the grid itself starts at the node top instead of below the
  // caption text.
  const below = Boolean(caption.below);
  const element = {
    type: 'text',
    x: Number(xOf(node).toFixed(4)),
    y: Number((below ? yOf(node) + node.h - caption.height : yOf(node)).toFixed(4)),
    w: Number(Math.max(0.2, node.w).toFixed(4)),
    h: Number(Math.max(0.05, caption.height).toFixed(4)),
    text: caption.text,
    fontSize: caption.fontSizePt,
    fontFace: resolvedTheme.fonts.body,
    align: caption.align,
    // CSS puts the caption's own baseline just above the grid, which is a bottom anchor.
    valign: 'bottom',
    lineSpacingMultiple: caption.lineHeight
  };
  if (caption.color) element.color = caption.color;
  if (caption.bold) element.bold = true;
  if (caption.italic) element.italic = true;
  if (caption.paddingTop || caption.paddingBottom) {
    element.boxMargin = { top: caption.paddingTop / 72, right: 0, bottom: caption.paddingBottom / 72, left: 0 };
  }
  return element;
}

function tableElementFromNode(node, resolvedTheme) {
  if (!node.rows || !node.rows.length) return null;
  const columns = Math.max(
    Number(node.columnCount) || 0,
    ...node.rows.map((row) => row.reduce(
      (accumulator, cell) => accumulator + ((cell.options && cell.options.colspan) || 1), 0))
  );
  const width = Math.max(0.2, node.w);
  const captionHeight = node.caption ? node.caption.height : 0;
  return {
    type: 'table',
    x: Number(xOf(node).toFixed(4)),
    y: Number((yOf(node) + captionHeight).toFixed(4)),
    w: Number(width.toFixed(4)),
    h: Number(Math.max(0.2, node.h - captionHeight).toFixed(4)),
    rows: node.rows,
    options: {
      colW: tableColumnWidths(node, columns, width),
      // PowerPoint draws the rows at these heights, so the box reserved by
      // the analyzer and the drawn table agree instead of drifting apart.
      rowH: Array.isArray(node.rowHeights) && node.rowHeights.length === node.rows.length
        ? node.rowHeights
        : undefined,
      fontFace: resolvedTheme.fonts.body,
      fontSize: Math.max(6, Number((node.fontSizePt || 11).toFixed(1))),
      // Each cell carries the four sides its CSS asked for, so the table must not
      // invent a grid: an undeclared side stays empty.
      border: { type: 'none' },
      // PptxGenJS turns 'middle' into anchor="ctr"; 'mid' would be written
      // verbatim and produce an invalid anchoring value.
      valign: 'middle'
    }
  };
}

function lineElementFromNode(node, resolvedTheme) {
  const style = node.style || {};
  const color = backgroundOf(style) || hexOrNull(style.borderColor);
  return {
    type: 'line',
    x: Number(xOf(node).toFixed(4)),
    y: Number(yOf(node).toFixed(4)),
    w: Number(Math.max(0.05, node.w).toFixed(4)),
    h: 0,
    color: (color && color.hex) || resolvedTheme.colors.border,
    width: 1
  };
}

/** CSS gradient angles are clockwise from north; DrawingML measures clockwise from east. */
function toDrawingMlAngle(cssAngle) {
  const value = Number(cssAngle);
  if (!Number.isFinite(value)) return 180;
  return Math.round(((value - 90) % 360 + 360) % 360 * 100) / 100;
}

function nativeGradient(gradient) {
  if (!gradient) return null;
  return Object.assign({}, gradient, { angle: toDrawingMlAngle(gradient.angle) });
}

function gridColumnCount(style) {
  const text = String((style && style.gridTemplateColumns) || '');
  const repeat = /repeat\(\s*(\d+)\s*,/u.exec(text);
  if (repeat) return Number(repeat[1]);
  const count = text.split(/\s+/u).filter(Boolean).length;
  return Math.max(1, count || 1);
}

function inchesOfGap(value) {
  if (value === undefined || value === null || value === '') return null;
  const inches = evaluateInches(value, { fontSizePx: 16, percentBase: undefined });
  return inches;
}

function containerGap(style, axis) {
  const primary = axis === 'row' ? (style.columnGap || style.gap) : (style.rowGap || style.gap);
  const value = inchesOfGap(primary);
  return value === null ? 0 : value;
}

function emptyCounters() {
  return {
    slides: 0,
    textElements: 0,
    richTextElements: 0,
    shapes: 0,
    images: 0,
    backgroundImages: 0,
    tables: 0,
    lines: 0,
    charts: 0,
    rotatedGroups: 0,
    droppedDecorations: 0,
    declarativeContainers: 0,
    absoluteGroups: 0,
    containerFallbacks: [],
    paginatedTables: [],
    layoutAttempts: 0,
    maxBoxDelta: 0
  };
}

function noteFallback(report, reason) {
  if (report.containerFallbacks.length >= 12) return;
  if (report.containerFallbacks.some((entry) => entry.reason === reason)) return;
  report.containerFallbacks.push({ reason });
}

/**
 * Decide whether a group can be expressed as a native container.
 * Purely structural: numeric agreement is proven later by `verifySlide`.
 */
function containerPlan(node, state) {
  if (!isGroup(node)) return { ok: false, reason: 'no children' };
  if (state && state.blocked && state.blocked.has(node.id)) {
    const delta = state.blockedDeltas && state.blockedDeltas.get(node.id);
    return {
      ok: false,
      reason: delta === undefined
        ? 'engine geometry disagreed'
        : 'engine geometry disagreed by ' + delta.toFixed(3) + 'in'
    };
  }
  if (node.backgroundImage) return { ok: false, reason: 'group paints a background image' };

  const style = node.style || {};
  const display = String(style.display || 'block').toLowerCase();
  const children = node.children || [];
  if (children.some((child) => child.absolute)) {
    return { ok: false, reason: 'child uses absolute positioning' };
  }
  // A run of floats is packed by the analyzer (margins, wrapping, edge packing). The
  // engine's row model has no margins, so the placed boxes are the honest answer.
  if (children.some((child) => child.floated)) {
    return { ok: false, reason: 'children are floated' };
  }
  // A child that paints a picture behind itself cannot be a container child: a container
  // child has no coordinates of its own, and a picture is placed by geometry. Without this
  // the picture was dropped in silence - a card with a background image inside a flex row
  // drew its colour and no image. The absolute path draws both, so the group falls back.
  if (children.some((child) => child.backgroundImage)) {
    return { ok: false, reason: 'a child paints a background image' };
  }

  let direction = 'column';
  let columns = null;
  let tracks = null;
  let wrap = false;
  if (display === 'grid') {
    columns = gridColumnCount(style);
    if (Array.isArray(node.gridTracks) && node.gridTracks.length) {
      tracks = node.gridTracks.map((track) => (track.width !== undefined
        ? { width: Number(track.width.toFixed(3)) }
        : { fr: track.fr }));
      columns = tracks.length;
    }
  } else if (display === 'flex') {
    direction = String(style.flexDirection || 'row').toLowerCase().startsWith('column') ? 'column' : 'row';
    const wrapValue = String(style.flexWrap || 'nowrap').toLowerCase();
    if (wrapValue.startsWith('wrap')) wrap = true;
  }

  for (const child of children) {
    if (!isGroup(child)) continue;
    const nested = containerPlan(child, state);
    if (!nested.ok) return { ok: false, reason: 'nested group: ' + nested.reason };
  }

  if (display === 'flex' && wrap && direction === 'column') {
    // The analyzer reports a wrapping column it cannot translate exactly (no definite
    // height, or an item without a declared width) and leaves the children in block flow.
    if (!Number.isFinite(node.h)) return { ok: false, reason: 'wrapping column has no definite height' };
    const undeclared = children.find((child) => !(child.style && child.style.width !== undefined));
    if (undeclared) return { ok: false, reason: 'wrapping column item has no declared width' };
  }
  if (display === 'flex' || display === 'grid') {
    const spaced = children.find((child) => hasMargin(child));
    if (spaced) return { ok: false, reason: display + ' child declares margins' };
  }

  return { ok: true, direction, columns, display, tracks, wrap };
}

function containerPadding(node) {
  const padding = node.padding || ZERO_MARGIN;
  const inset = node.border ? node.border.width / 72 : 0;
  return {
    top: padding.top + inset,
    right: padding.right + inset,
    bottom: padding.bottom + inset,
    left: padding.left + inset
  };
}

/** Build the declarative container descriptor for a group. */
function containerElement(node, plan, resolvedTheme, report) {
  const style = node.style || {};
  // A rotated group would need every child rotated about the group centre.
  if (node.rotate !== undefined) report.rotatedGroups += 1;
  const spec = { type: 'container', w: round4(node.w), h: round4(node.h) };
  if (Number.isFinite(xOf(node))) spec.x = round4(xOf(node));
  if (Number.isFinite(yOf(node))) spec.y = round4(yOf(node));
  attachBoxFacts(spec, node);

  spec.padding = containerPadding(node);

  if (node.overlays && node.overlays.length) spec.overlays = node.overlays;
  if (plan.columns) {
    spec.columns = Math.max(1, plan.columns);
    if (plan.tracks) spec.columnTracks = plan.tracks;
    if (Array.isArray(node.rowTracks) && node.rowTracks.length) {
      spec.rowTracks = node.rowTracks.map((track) => {
        if (Number.isFinite(track.height)) return { height: Number(track.height.toFixed(4)) };
        if (Number.isFinite(track.fr) && track.fr > 0) return { fr: track.fr };
        return { auto: true };
      });
    }
    if (Number.isFinite(node.autoRowHeight)) {
      spec.autoRowHeight = Number(node.autoRowHeight.toFixed(4));
    }
    if (Number.isFinite(node.rowContentHeight)) {
      spec.rowContentHeight = Number(node.rowContentHeight.toFixed(4));
    }
    spec.gap = containerGap(style, 'row');
    spec.columnGap = style.columnGap !== undefined ? containerGap(style, 'row') : spec.gap;
    spec.rowGap = style.rowGap !== undefined ? containerGap(style, 'column') : spec.gap;
  } else if (plan.direction === 'row') {
    spec.direction = 'row';
    spec.gap = containerGap(style, 'row');
    if (plan.wrap) spec.wrap = true;
  } else if (plan.display === 'flex') {
    spec.direction = 'column';
    spec.gap = containerGap(style, 'column');
    if (plan.wrap) {
      spec.wrap = true;
      // The gap *between* columns is the inline-axis one; `gap` above is the main axis.
      spec.crossGap = containerGap(style, 'row');
    }
  } else {
    // Block flow: spacing lives on the children's margins, not on a gap.
    spec.direction = 'column';
    spec.gap = 0;
  }

  const align = ALIGN_BY_CSS[String(style.alignItems || 'stretch').toLowerCase()];
  if (align) spec.align = align;
  const justify = JUSTIFY_BY_CSS[String(style.justifyContent || '').toLowerCase()];
  if (justify && plan.display !== 'block' && !plan.columns) spec.justify = justify;
  // `align-content` only means something for a wrapping row whose height is pinned.
  const alignContent = String(style.alignContent || '').trim().toLowerCase();
  if (plan.wrap && alignContent && alignContent !== 'normal') spec.alignContent = alignContent;

  const surface = surfaceElementFromNode(node, resolvedTheme);
  if (surface) {
    delete surface.x;
    delete surface.y;
    delete surface.w;
    delete surface.h;
    spec.background = surface;
    if (report) report.shapes += 1;
  }
  return spec;
}

function zIndexOf(node) {
  const value = Number(node && node.style && node.style.zIndex);
  return Number.isFinite(value) ? value : 0;
}

/**
 * A text node may paint its own surface (a badge, a chip, a quote block, an
 * overlay caption). Emitting only the text lost the fill, which on a dark theme
 * meant white text on the pale page. The pair is expressed as a container whose
 * background is the surface and whose single child is the text, so the padding
 * offsets the text exactly like CSS does and everything stays editable.
 */
function textWithSurface(node, resolvedTheme, report) {
  const surface = surfaceElementFromNode(node, resolvedTheme);
  if (!surface) return null;
  report.textElements += 1;
  if (node.runs) report.richTextElements += 1;
  const text = textElementFromNode(node, null, resolvedTheme);
  if (!text) return null;
  report.shapes += 1;
  delete surface.x;
  delete surface.y;
  delete surface.w;
  delete surface.h;
  delete text.x;
  delete text.y;
  // The text box is the container's content box: the container adds the padding
  // back, so giving the text the border-box height would double it.
  const boxPadding = containerPadding(node);
  text.h = round4(Math.max(0.02, node.h - boxPadding.top - boxPadding.bottom));
  // The pill/button pattern: one line of text inside a box. CSS aligns it with the
  // container's own `align-items` (block axis) and `justify-content` (inline axis).
  // The wrapper is a column container, where `align` would mean the *inline* axis, so
  // the block-axis alignment belongs on the text box's anchor instead.
  const alignItemsValue = String((node.style && node.style.alignItems) || '').toLowerCase();
  const justifyValue = String((node.style && node.style.justifyContent) || '').toLowerCase();
  if (alignItemsValue === 'center') text.valign = 'middle';
  else if (alignItemsValue === 'flex-end' || alignItemsValue === 'end') text.valign = 'bottom';
  const inlineAlign = justifyValue === 'center' ? 'center'
    : (justifyValue === 'flex-end' || justifyValue === 'end' || justifyValue === 'right') ? 'right'
      : (justifyValue === 'flex-start' || justifyValue === 'start') ? 'left' : null;
  if (inlineAlign) text.align = inlineAlign;
  const spec = {
    type: 'container',
    x: round4(xOf(node)),
    y: round4(yOf(node)),
    w: round4(node.w),
    h: round4(node.h),
    padding: boxPadding,
    direction: 'column',
    gap: 0,
    align: 'stretch',
    background: surface,
    children: [text]
  };
  attachBoxFacts(spec, node);
  if (node.rotate !== undefined) {
    // The wrapper is layout-only, so the rotation goes on the surface (emitted
    // from `background` as a leading shape of the container's own box) and on the
    // text box inside it. Both share the container centre, which is the axis CSS
    // rotates about.
    surface.rotate = node.rotate;
    text.rotate = node.rotate;
  }
  return spec;
}

/**
 * Absolutely positioned children of a leaf are emitted as separate objects at the leaf's
 * corner plus their own offsets. A leaf cannot hold them, but dropping them loses content:
 * a `position: absolute` caption inside a card that is not a container used to vanish.
 */
function emitLeafOverlays(node, context, shapes) {
  const { report, resolvedTheme } = context;
  (node.overlays || []).forEach((overlay) => {
    // The child node travels with the descriptor, so the emission reuses the ordinary
    // element builder: colour, tracking, font, role and line spacing all come along.
    if (overlay.node) {
      const element = leafElement(overlay.node, resolvedTheme, report);
      if (element) {
        element._z = zIndexOf(node);
        shapes.push(element);
      }
      return;
    }
    const box = {
      x: Number((xOf(node) + (overlay.x || 0)).toFixed(4)),
      y: Number((yOf(node) + (overlay.y || 0)).toFixed(4)),
      w: Number(Math.max(0.02, overlay.w).toFixed(4)),
      h: Number(Math.max(0.02, overlay.h).toFixed(4))
    };
    if (overlay.fill || overlay.gradient) {
      const shape = Object.assign({ type: 'shape', line: false, fill: overlay.fill || (overlay.gradient && overlay.gradient.stops[0].color) }, box);
      if (overlay.gradient) shape.gradient = nativeGradient(overlay.gradient);
      if (overlay.radius) shape.radius = overlay.radius;
      shapes.push(shape);
      report.shapes += 1;
    }
    if (overlay.text) {
      const caption = Object.assign({ type: 'text', text: overlay.text }, box);
      ['color', 'fontSize', 'align', 'valign', 'bold', 'italic', 'fontFace'].forEach((field) => {
        if (overlay[field] !== undefined) caption[field] = overlay[field];
      });
      shapes.push(caption);
      report.textElements += 1;
    }
  });
}

/** Leaf element (text / image / table / line) for a node, with counters bumped. */
function leafElement(node, resolvedTheme, report) {
  const element = leafElementRotationFree(node, resolvedTheme, report);
  if (element) attachBoxFacts(element, node);
  if (!element || node.rotate === undefined) return element;
  if (element.type === 'container') {
    // A surface + text wrapper: rotate every leaf inside it, since the wrapper
    // itself is layout-only and cannot carry a rotation.
    rotateLeaves(element, node.rotate);
    return element;
  }
  // Rotation is native on any leaf object; tables and charts accept it too.
  element.rotate = node.rotate;
  return element;
}

function rotateLeaves(element, degrees) {
  (element.children || []).forEach((child) => {
    if (child.type === 'container') rotateLeaves(child, degrees);
    else child.rotate = degrees;
  });
}

/** Intrinsic pixel size from an image header: PNG, JPEG and GIF are read directly;
 *  anything else returns null and the caller falls back to filling its box. */
/**
 * Geometry for a `background-image`, from `background-size` and `background-position`.
 * A size that is not `cover`/`contain`/`auto` is a drawn size: it is resolved per axis
 * (a length in inches, a percentage of the box, or `auto` from the source's proportions),
 * placed by the position, and - when it is bigger than the box - cropped to the box, which
 * is what the browser's clipping shows.
 */
function backgroundPictureGeometry(layer, box, natural) {
  layer = layer || {};
  const declared = String(layer.size || 'auto');
  // `cover` and `contain` are the layer's own fit, resolved by the engine; this function is
  // for the sizes that name a length or a percentage.
  if (declared === 'cover' || declared === 'contain') return null;
  const spec = layer.sizeSpec;
  const focus = normalizeFocus(layer.focus, {
    natural: natural ? { width: natural.widthPx, height: natural.heightPx } : null,
    box,
    fit: 'contain'
  });
  if (!natural) return null;
  const naturalW = natural.widthPx / 96;
  const naturalH = natural.heightPx / 96;
  const axis = (entry, boxSize) => {
    if (!entry || entry.auto) return null;
    if (entry.percent !== undefined) return (boxSize * entry.percent) / 100;
    if (entry.inches !== undefined) return entry.inches;
    return null;
  };
  let w = axis(spec && spec[0], box.w);
  let h = axis(spec && spec[1], box.h);
  if (w === null && h === null) {
    // Both axes auto: the picture keeps its own size. Clamping it into the box made a
    // picture that is bigger than its card *stretch* to fit, where the browser draws it at
    // its own size and clips the overflow - which the branch below already expresses.
    w = naturalW;
    h = naturalH;
  } else {
    if (w === null) w = h * (naturalW / naturalH);
    if (h === null) h = w * (naturalH / naturalW);
  }
  if (!(w > 0) || !(h > 0)) return null;
  const offsetX = (box.w - w) * focus.x;
  const offsetY = (box.h - h) * focus.y;
  if (w <= box.w + 0.0001 && h <= box.h + 0.0001) {
    return { x: box.x + offsetX, y: box.y + offsetY, w, h, fit: 'stretch', crop: null, focus };
  }
  // Bigger than its box: the drawn picture is the box, and what the browser clips away is a
  // source rectangle - the same arithmetic `computeCoverCrop` does, with the position in it.
  const left = Math.max(0, -offsetX / w);
  const top = Math.max(0, -offsetY / h);
  const visibleW = Math.min(1, box.w / w);
  const visibleH = Math.min(1, box.h / h);
  return {
    x: box.x,
    y: box.y,
    w: box.w,
    h: box.h,
    fit: 'crop',
    crop: {
      left: Math.min(left, Math.max(0, 1 - visibleW)),
      top: Math.min(top, Math.max(0, 1 - visibleH)),
      right: Math.max(0, 1 - visibleW - left),
      bottom: Math.max(0, 1 - visibleH - top)
    },
    focus
  };
}

function intrinsicImageSize(src) {
  try {
    if (typeof src !== 'string') return null;
    let bytes = null;
    const dataMatch = /^data:image\/([a-z+]+);base64,(.*)$/iu.exec(src);
    if (dataMatch) bytes = Buffer.from(dataMatch[2], 'base64');
    else return null;
    if (bytes.length > 24 && bytes[0] === 0x89 && bytes[1] === 0x50) {
      return { widthPx: bytes.readUInt32BE(16), heightPx: bytes.readUInt32BE(20) };
    }
    if (bytes.length > 10 && bytes[0] === 0x47 && bytes[1] === 0x49) {
      return { widthPx: bytes.readUInt16LE(6), heightPx: bytes.readUInt16LE(8) };
    }
    if (bytes.length > 4 && bytes[0] === 0xFF && bytes[1] === 0xD8) {
      let scan = 2;
      while (scan + 9 < bytes.length) {
        if (bytes[scan] !== 0xFF) { scan += 1; continue; }
        const marker = bytes[scan + 1];
        const length = bytes.readUInt16BE(scan + 2);
        if (marker >= 0xC0 && marker <= 0xCF && marker !== 0xC4 && marker !== 0xC8 && marker !== 0xCC) {
          return { widthPx: bytes.readUInt16BE(scan + 7), heightPx: bytes.readUInt16BE(scan + 5) };
        }
        scan += 2 + length;
      }
    }
  } catch (error) { return null; }
  return null;
}

function leafElementRotationFree(node, resolvedTheme, report) {
  // `visibility: hidden` laid out its box but paints nothing: the honest emission is no object.
  if (node.hidden) return null;
  if (node.kind === 'text' || node.kind === 'list') {
    if (!node.text && !node.runs) return null;
    // A background picture behind text: the image element first (document order
    // paints it beneath), then the text on top - both stay editable.
    if (node.bgImage && node.bgImage.src) {
      // `background-size: auto` draws the picture at its natural size, centred in
      // the box - not stretched. The intrinsic dimensions come from the image
      // header (PNG, JPEG, GIF); anything unreadable falls back to the box fill.
      let natural = null;
      if ((node.bgImage.size || 'auto') === 'auto') natural = intrinsicImageSize(node.bgImage.src);
      let imageW = node.w;
      let imageH = node.h;
      let imageX = xOf(node);
      let imageY = yOf(node);
      if (natural) {
        const w = natural.widthPx / 96;
        const h = natural.heightPx / 96;
        imageW = Math.min(w, node.w);
        imageH = Math.min(h, node.h);
        imageX = xOf(node) + Math.max(0, (node.w - imageW) / 2);
        imageY = yOf(node) + Math.max(0, (node.h - imageH) / 2);
      }
      const fitForPair = natural ? 'contain' : (node.bgImage.fit || 'cover');
      const imageNode = {
        kind: 'image', x: imageX, y: imageY, w: imageW, h: imageH,
        src: node.bgImage.src, alt: '', objectFit: fitForPair,
        focus: node.bgImage.focus, style: {}
      };
      const image = imageElementFromNode(imageNode);
      const text = textElementFromNode(node, null, resolvedTheme);
      if (image && text) {
        report.images += 1;
        report.textElements += 1;
        if (node.runs) report.richTextElements += 1;
        delete text.x; delete text.y;
        return {
          type: 'container', x: Number(xOf(node).toFixed(4)), y: Number(yOf(node).toFixed(4)),
          w: Number(node.w.toFixed(4)), h: Number(Math.max(0.02, node.h).toFixed(4)),
          direction: 'column', children: [image, text]
        };
      }
    }
    report.textElements += 1;
    if (node.runs) report.richTextElements += 1;
    const wrapped = textWithSurface(node, resolvedTheme, report);
    if (wrapped) return wrapped;
    return textElementFromNode(node, null, resolvedTheme);
  }
  if (node.kind === 'image') {
    // A background picture with an explicit `background-size` is drawn at that size; the
    // geometry is resolved before the element is built, because the element carries a box.
    if (node.backgroundSizeSpec && !node.backgroundNatural) {
      const geometry = backgroundPictureGeometry(
        { size: node.backgroundSize, sizeSpec: node.backgroundSizeSpec, focus: node.focus, fit: node.objectFit },
        boxOf(node), intrinsicImageSize(node.src));
      if (geometry) {
        node = { ...node, x: geometry.x, y: geometry.y, w: geometry.w, h: geometry.h,
          objectFit: geometry.fit, crop: geometry.crop || undefined, focus: undefined };
      }
    }
    if (node.backgroundNatural) {
      const natural = intrinsicImageSize(node.src);
      if (natural) {
        const naturalW = Math.min(natural.widthPx / 96, node.w);
        const naturalH = Math.min(natural.heightPx / 96, node.h);
        node = { ...node, w: naturalW, h: naturalH,
          x: xOf(node) + Math.max(0, (node.w - naturalW) / 2),
          y: yOf(node) + Math.max(0, (node.h - naturalH) / 2) };
      }
    }
    const element = imageElementFromNode(node);
    if (element) report.images += 1;
    return element;
  }
  if (node.kind === 'table') {
    const element = tableElementFromNode(node, resolvedTheme);
    if (element) report.tables += 1;
    return element;
  }
  if (node.kind === 'line') {
    report.lines += 1;
    return lineElementFromNode(node, resolvedTheme);
  }
  if (node.kind === 'chart') {
    report.charts += 1;
    return {
      type: 'chart',
      x: Number(xOf(node).toFixed(4)),
      y: Number(yOf(node).toFixed(4)),
      w: Number(Math.max(0.5, node.w).toFixed(4)),
      h: Number(Math.max(0.5, node.h).toFixed(4)),
      chartType: node.chartType,
      data: node.chartData,
      options: node.chartOptions
    };
  }
  // A childless group contributes only its surface, if it has one.
  const surface = surfaceElementFromNode(node, resolvedTheme);
  if (surface) report.shapes += 1;
  return surface;
}

/**
 * The box a probe compares against: where the element must *end up*, which is `node.x`/
 * `node.y` - already shifted for a `position: relative` offset. The spec carries the
 * static position plus `relativeShift` and the engine applies it, so comparing against
 * the static box would report every nudged box as a disagreement.
 */
function boxOf(node) {
  return { x: node.x, y: node.y, w: node.w, h: node.h };
}

function emitContainerChildren(spec, node, plan, context) {
  const children = [];
  (node.children || []).forEach((child) => {
    const element = containerChild(child, plan, Object.assign({}, context, { ownerId: node.id }));
    if (element) children.push(element);
  });
  spec.children = sortByPaintOrder(children, node);
}

/**
 * Stable paint-order sort: z-index, then in-flow before positioned, then DOM order.
 *
 * A browser paints non-positioned boxes first and the positioned ones above them, so a pin
 * written before the picture it marks still sits on top of it. Sorting by z-index alone put
 * it underneath.
 */
function sortByPaintOrder(children, parent) {
  const nodesById = new Map((parent.children || []).map((child) => [child.id, child]));
  const positioned = (element) => {
    const node = nodesById.get(element && element._probe);
    return node && node.absolute ? 1 : 0;
  };
  return children
    .map((element, index) => ({ element, index }))
    .sort((a, b) => {
      const za = elementZ(a.element);
      const zb = elementZ(b.element);
      if (za !== zb) return za - zb;
      const pa = positioned(a.element);
      const pb = positioned(b.element);
      if (pa !== pb) return pa - pb;
      return a.index - b.index;
    })
    .map((entry) => entry.element);
}

function elementZ(element) {
  const value = Number(element && element._z);
  return Number.isFinite(value) ? value : 0;
}

/** Emit one child positioned by its parent container. */
function containerChild(node, parentPlan, context) {
  const { resolvedTheme, report, state, probes, owners, ownerId } = context;
  // A hidden child keeps its slot in the layout but is not emitted as an object.
  if (node.hidden) return null;
  let element;
  if (isGroup(node)) {
    const plan = containerPlan(node, state);
    if (!plan.ok) return null;
    element = containerElement(node, plan, resolvedTheme, report);
    // A container child is positioned by its parent just like a leaf, so its flow margin
    // has to travel the same way (a grid track keeps its margins out of the geometry).
    if (!parentPlan.columns) element.boxMargin = marginsOf(node);
    // A container child's own box is placed by the engine, so it needs a probe too:
    // otherwise a disagreement about *where a child sits inside its parent* is invisible
    // to the gate (the parent's box can be right while its children are all at the top).
    element._probe = node.id;
    probes.set(node.id, boxOf(node));
    owners.set(node.id, ownerId);
    report.declarativeContainers += 1;
    emitContainerChildren(element, node, plan, context);
  } else {
    if (node.overlays && node.overlays.length) report.droppedDecorations += node.overlays.length;
    element = leafElement(node, resolvedTheme, report);
    if (!element) return null;
    element.h = round4(node.h);
    const declaredWidth = node.style && node.style.width !== undefined;
    // The parent sizes a child whose CSS left the width free (stretch, or a flex share).
    // A declared width is the child's own, in a row, a column and a grid cell alike.
    if (!declaredWidth) {
      delete element.w;
      if (parentPlan.direction === 'row' && !parentPlan.columns) {
        const weight = Number(node.style && node.style.flex);
        if (Number.isFinite(weight) && weight > 0) element.flex = weight;
      }
    } else {
      element.fixedWidth = true;
    }
    // Named boxMargin: the writer reads `margin` as text-box insets, so the flow margin
    // travels under its own name. Every non-grid parent honours it (blocks all four
    // sides, columns all four, rows the horizontal pair); a grid track must stay aligned
    // to its cell, so a grid child keeps its margins out of the geometry.
    if (!parentPlan.columns) element.boxMargin = marginsOf(node);
  }
  // Alignment belongs to the child, not to its kind: a container child of a grid needs
  // the same `align-self`/`justify-self` that a leaf does.
  if (node.alignSelf) element.alignSelf = node.alignSelf;
  if (node.justifySelf) element.justifySelf = node.justifySelf;
  // A row child keeps the base and the shrink factor the analyzer resolved, so
  // the engine sizes the row identically (a fixed width must not shrink).
  if (parentPlan.direction === 'row' && !parentPlan.columns) {
    if (Number.isFinite(node.flexBasis)) element.flexBasis = round4(node.flexBasis);
    if (Number.isFinite(node.flexShrink) && node.flexShrink !== 1) {
      element.flexShrink = node.flexShrink;
    }
    // The engine grows an item only when it declares a weight; without the
    // declared weight a `flex: 1 1 300px` card would freeze at its basis.
    const derivedGrow = Number.isFinite(node.flexBasis) && node.flexBasis > 0 ? 0 : 1;
    if (Number.isFinite(node.flexGrow) && node.flexGrow !== derivedGrow) {
      element.flex = node.flexGrow;
    }
  }
  // A grid child may span several tracks; the engine replays the same placement.
  if (node.columnSpan) element.columnSpan = node.columnSpan;
  if (node.rowSpan) element.rowSpan = node.rowSpan;
  // The engine derives a grid item's box from its tracks, so only the sizes the
  // CSS actually declared may be baked in - a stretched height would otherwise be
  // measured back as the item's natural size and inflate the row.
  if (parentPlan.columns) {
    if (!(node.style && node.style.width !== undefined)) delete element.w;
    if (!(node.style && node.style.height !== undefined)) delete element.h;
  }
  if (process.env.NATIVE_DEBUG_GRID) {
    process.stderr.write('[grid] node ' + String(node.id) + ' tag=' + String(node.tag)
      + ' display=' + String(parentPlan.display)
      + ' nodeSpan=' + String(node.columnSpan) + '/' + String(node.rowSpan)
      + ' elementSpan=' + String(element.columnSpan) + '/' + String(element.rowSpan) + '\n');
  }
  delete element.x;
  delete element.y;
  element._probe = node.id;
  element._z = zIndexOf(node);
  probes.set(node.id, boxOf(node));
  owners.set(node.id, ownerId);
  return element;
}

/** Emit a node (and its subtree) at explicit coordinates. */
function emitAbsolute(node, context) {
  const { resolvedTheme, elements, report, state, probes, owners, ownerId } = context;
  if (!node || node.hidden || node.w <= 0.01 || node.h <= 0.01) return;
  // Pictures and scrims above them are held back until the box that holds them is emitted:
  // `background-image` paints above `background-color`, and a scrim above the picture. Pushed
  // first, the box'''s own fill covered both.
  const deferredPaint = [];
  const flushDeferredPaint = () => {
    while (deferredPaint.length) elements.push(deferredPaint.shift());
  };

  if (node.backgroundImage) {
    // `background-size` decides the drawn size: the natural size, a length, a percentage, or
    // the box itself for `cover`/`contain`. `backgroundPictureGeometry` resolves the first
    // three - including the clip a picture bigger than its box needs.
    const natural = intrinsicImageSize(node.backgroundImage.src);
    const geometry = backgroundPictureGeometry(node.backgroundImage, boxOf(node), natural);
    let pictureW = node.w;
    let pictureH = node.h;
    let pictureX = xOf(node);
    let pictureY = yOf(node);
    let pictureFit = node.backgroundImage.fit;
    let pictureCrop = null;
    if (geometry) {
      pictureW = geometry.w;
      pictureH = geometry.h;
      pictureX = geometry.x;
      pictureY = geometry.y;
      pictureFit = geometry.fit;
      pictureCrop = geometry.crop;
    }
    const picture = imageElementFromNode({
      src: node.backgroundImage.src,
      x: pictureX,
      y: pictureY,
      w: pictureW,
      h: pictureH,
      objectFit: geometry ? pictureFit : node.backgroundImage.fit,
      focus: node.backgroundImage.focus,
      crop: pictureCrop || undefined,
      radius: node.radius,
      alt: ''
    });
    if (picture) {
      picture._probe = 'bg-' + node.id;
      // The probe is the box the picture is drawn in, not the box that holds it: a
      // background the design sized smaller than its card is right, and measuring it
      // against the card reported a 1.8in disagreement for a picture that was correct.
      probes.set(picture._probe, { x: pictureX, y: pictureY, w: pictureW, h: pictureH });
      owners.set(picture._probe, ownerId);
      // Held back until the box that holds it is emitted: `background-image` paints *above*
      // `background-color`, so pushing the picture first let its own fill cover it.
      deferredPaint.push(picture);
      report.images += 1;
      report.backgroundImages += 1;
    }
    // A gradient declared above the picture is a scrim: its own shape, above the picture
    // and below the children, so text inside the container still reads.
    // The scrim is read from the CSS here rather than carried on the node: an overlay
    // gradient above a picture only exists for this container path, and the picture path
    // for a leaf already emits its scrim as a sibling shape.
    const scrimCss = backgroundOverlayGradientOf(node.style || {});
    if (scrimCss) {
      const scrim = surfaceElementFromNode({
        id: 'overlay-' + node.id,
        tag: node.tag,
        style: { backgroundImage: scrimCss },
        x: xOf(node),
        y: yOf(node),
        w: node.w,
        h: node.h,
        radius: node.radius
      }, resolvedTheme);
      if (scrim) {
        scrim._probe = 'scrim-' + node.id;
        probes.set(scrim._probe, boxOf(node));
        owners.set(scrim._probe, ownerId);
        deferredPaint.push(scrim);
        report.shapes += 1;
      }
    }
  }

  if (isGroup(node)) {
    const plan = containerPlan(node, state);
    if (plan.ok) {
      const spec = containerElement(node, plan, resolvedTheme, report);
      report.declarativeContainers += 1;
      if (spec.background) {
        spec.background._probe = 'surface-' + node.id;
        probes.set(spec.background._probe, boxOf(node));
        owners.set(spec.background._probe, ownerId);
      }
      emitContainerChildren(spec, node, plan, Object.assign({}, context, { ownerId: node.id }));
      flushDeferredPaint();
      elements.push(spec);
      return;
    }
    report.absoluteGroups += 1;
    noteFallback(report, plan.reason);
    const surface = surfaceElementFromNode(node, resolvedTheme);
    if (surface) {
      surface._probe = node.id;
      probes.set(node.id, boxOf(node));
      owners.set(node.id, ownerId);
      elements.push(surface);
      report.shapes += 1;
    }
    flushDeferredPaint();
    (node.children || []).forEach((child) =>
      emitAbsolute(child, Object.assign({}, context, { ownerId: node.id })));
    return;
  }

  const element = leafElement(node, resolvedTheme, report);
  if (!element) {
    const strip = standaloneEdgeElement(node);
    if (strip) {
      elements.push(strip);
      report.shapes += 1;
    }
    flushDeferredPaint();
    emitLeafOverlays(node, context, elements);
    return;
  }
  if (element.type === 'table' && node.headerRows) element.headerRows = node.headerRows;
  // A table's caption is drawn before it in document order, so it is emitted first and a
  // reader paints it under nothing. It is a plain text box: a merged first row would put the
  // rest of the table off the page in LibreOffice, which could not be verified.
  if (node.caption) {
    const captionElement = captionElementFromNode(node, resolvedTheme);
    if (captionElement) {
      captionElement._z = zIndexOf(node);
      elements.push(captionElement);
      report.texts = (report.texts || 0) + 1;
    }
  }
  element._probe = node.id;
  element._z = zIndexOf(node);
  probes.set(node.id, boxOf(node));
  owners.set(node.id, ownerId);
  elements.push(element);
  flushDeferredPaint();
  emitLeafOverlays(node, context, elements);
}

/**
 * Re-resolve a slide through the engine and report boxes that disagree with the
 * analyzer. Returns the set of owning container ids that must fall back.
 */
function verifySlide(elements, pageSize, theme, probes, owners) {
  const mismatched = new Set();
  let maxDelta = 0;
  let resolved;
  try {
    resolved = layoutSlide(
      { elements: JSON.parse(JSON.stringify(elements)), margin: 0, gap: 0 },
      pageSize,
      theme,
      {}
    );
  } catch (error) {
    owners.forEach((ownerId) => { if (ownerId !== undefined) mismatched.add(ownerId); });
    return { mismatched, maxDelta: Number.POSITIVE_INFINITY, error };
  }
  const deltas = new Map();
  resolved.forEach((element) => {
    const probe = element._probe;
    if (probe === undefined) return;
    const expected = probes.get(probe);
    if (!expected) return;
    if (![element.x, element.y, element.w, element.h].every(Number.isFinite)) {
      const owner = owners.get(probe);
      if (owner !== undefined && owner !== null) {
        mismatched.add(owner);
        deltas.set(owner, Number.POSITIVE_INFINITY);
      }
      maxDelta = Number.POSITIVE_INFINITY;
      return;
    }
    const delta = Math.max(
      Math.abs(element.x - expected.x),
      Math.abs(element.y - expected.y),
      Math.abs(element.w - expected.w),
      Math.abs(element.h - expected.h)
    );
    if (delta > maxDelta) maxDelta = delta;
    if (delta > BOX_TOLERANCE) {
      const owner = owners.get(probe);
      if (owner !== undefined && owner !== null) {
        mismatched.add(owner);
        if (delta > (deltas.get(owner) || 0)) deltas.set(owner, delta);
      }
      // Debugging aid: NATIVE_DEBUG_GEOMETRY=1 prints every disagreement.
      if (process.env.NATIVE_DEBUG_GEOMETRY) {
        process.stderr.write('[geometry] ' + String(probe) + ' delta=' + delta.toFixed(3)
          + ' expected=' + [expected.x, expected.y, expected.w, expected.h].map((v) => Number(v).toFixed(3)).join(',')
          + ' actual=' + [element.x, element.y, element.w, element.h].map((v) => Number(v).toFixed(3)).join(',')
          + ' type=' + element.type + '\n');
      }
    }
  });
  return { mismatched, deltas, maxDelta };
}

function stripProbes(elements) {
  const clean = (element) => {
    delete element._probe;
    delete element._z;
    if (element.background) {
      delete element.background._probe;
      delete element.background._z;
    }
    (element.children || []).forEach(clean);
  };
  elements.forEach(clean);
  return elements;
}

/** Convert an analyzed document into a Native Deck Spec plus a mapping report. */
/**
 * A table taller than its slide is split into pages instead of running off the bottom.
 *
 * A row never straddles two slides, the leading `<thead>` rows are repeated on every
 * continuation page, and every page keeps the table's own left edge, width and top margin.
 * What it cannot keep is whatever the host slide painted around the table, so only full-page
 * backdrops travel with it: the rest of that page belongs to the page, not to the table.
 */
const TABLE_BOTTOM_KEEP = 0.25;

function isPageBackdrop(element, pageSize) {
  return Boolean(element) && element.type === 'shape' && !element.rotated
    && Number(element.x) === 0 && Number(element.y) === 0
    && Number(element.w) >= pageSize.width - 0.01 && Number(element.h) >= pageSize.height - 0.01;
}

function splitOverflowingTable(built, pageSize, report) {
  const tableIndex = built.elements.findIndex((element) => element.type === 'table'
    && Number(element.y) + Number(element.h) > pageSize.height - TABLE_BOTTOM_KEEP + 0.001);
  if (tableIndex < 0) return [built];
  const table = built.elements[tableIndex];
  const heights = table.options && Array.isArray(table.options.rowH) ? table.options.rowH : null;
  if (!heights || heights.length !== table.rows.length) return [built];
  const headerCount = Math.min(Number(table.headerRows) || 0, table.rows.length - 1);
  const headerHeight = headerCount
    ? heights.slice(0, headerCount).reduce((sum, value) => sum + value, 0)
    : 0;
  const top = Math.max(0, Number(table.y));
  const chunks = [];
  let rowIndex = 0;
  while (rowIndex < table.rows.length) {
    const budget = pageSize.height - TABLE_BOTTOM_KEEP - top - (chunks.length ? headerHeight : 0);
    let used = 0;
    let end = rowIndex;
    while (end < table.rows.length) {
      const next = heights[end];
      if (used + next > budget && end > rowIndex) break;
      used += next;
      end += 1;
    }
    // A single row taller than the page still has to go somewhere; it is left to overflow.
    if (end === rowIndex) end = rowIndex + 1;
    chunks.push({ start: rowIndex, end });
    rowIndex = end;
  }
  if (chunks.length < 2) return [built];
  const pageOf = (chunk, first) => {
    const rows = (first ? [] : table.rows.slice(0, headerCount)).concat(table.rows.slice(chunk.start, chunk.end));
    const rowH = (first ? [] : heights.slice(0, headerCount)).concat(heights.slice(chunk.start, chunk.end));
    const height = rowH.reduce((sum, value) => sum + value, 0);
    const element = Object.assign({}, table, {
      y: Number(top.toFixed(4)),
      h: Number(height.toFixed(4)),
      rows,
      options: Object.assign({}, table.options, { rowH })
    });
    if (!headerCount) delete element.headerRows;
    return element;
  };
  const backdrop = built.elements.filter((element, position) =>
    position !== tableIndex && isPageBackdrop(element, pageSize));
  const first = Object.assign({}, built, {
    elements: built.elements.slice(0, tableIndex)
      .concat([pageOf(chunks[0], true)])
      .concat(built.elements.slice(tableIndex + 1))
  });
  const pages = [first];
  for (let index = 1; index < chunks.length; index += 1) {
    pages.push({ background: built.background, elements: backdrop.concat([pageOf(chunks[index], false)]) });
  }
  report.paginatedTables.push({ rows: table.rows.length, headerRows: headerCount, pages: chunks.length });
  return pages;
}

function buildDeckSpec(analysis, options = {}) {
  const resolvedTheme = options.theme
    ? resolveTheme(options.theme)
    : deriveTheme(analysis.variables || {}, options.baseTheme);

  const report = emptyCounters();
  report.slides = analysis.slides.length;
  report.unsupported = analysis.unsupported.length;

  const slides = analysis.slides.flatMap((slide) => {
    const state = { blocked: new Set() };
    let elements = [];
    let attemptReport = emptyCounters();

    for (let attempt = 0; attempt < MAX_LAYOUT_ATTEMPTS; attempt += 1) {
      attemptReport = emptyCounters();
      const probes = new Map();
      const owners = new Map();
      elements = [];
      if (slide.gradient) {
        attemptReport.shapes += 1;
        elements.push({
          type: 'shape',
          x: 0,
          y: 0,
          w: analysis.pageSize.width,
          h: analysis.pageSize.height,
          fill: slide.gradient.stops[0].color,
          gradient: nativeGradient(slide.gradient),
          line: false
        });
      }
      const context = {
        resolvedTheme,
        elements,
        report: attemptReport,
        state,
        probes,
        owners,
        ownerId: null
      };
      slide.nodes.forEach((node) => emitAbsolute(node, context));
      if (slide.nodes.some((node) => zIndexOf(node) !== 0)) {
        const background = elements.length && elements[0].type === 'shape' && elements[0].x === 0
          ? elements.shift() : null;
        elements = sortByPaintOrder(elements, { children: slide.nodes });
        if (background) elements.unshift(background);
      }

      const verification = verifySlide(elements, analysis.pageSize, resolvedTheme, probes, owners);
      attemptReport.layoutAttempts = attempt + 1;
      attemptReport.maxBoxDelta = verification.maxDelta;
      if (!verification.mismatched.size) break;
      const newlyBlocked = [...verification.mismatched].filter((id) => !state.blocked.has(id));
      if (!newlyBlocked.length) break;
      state.blockedDeltas = state.blockedDeltas || new Map();
      newlyBlocked.forEach((id) => {
        state.blocked.add(id);
        const delta = verification.deltas && verification.deltas.get(id);
        if (delta !== undefined) state.blockedDeltas.set(id, delta);
      });
    }

    [
      'textElements', 'richTextElements', 'shapes', 'images', 'backgroundImages',
      'tables', 'lines', 'charts', 'rotatedGroups', 'droppedDecorations',
      'declarativeContainers', 'absoluteGroups'
    ].forEach((key) => { report[key] += attemptReport[key]; });
    attemptReport.containerFallbacks.forEach((entry) => noteFallback(report, entry.reason));
    report.layoutAttempts = Math.max(report.layoutAttempts, attemptReport.layoutAttempts);
    report.maxBoxDelta = Math.max(report.maxBoxDelta, attemptReport.maxBoxDelta);

    const built = {
      background: slide.background,
      elements: stripProbes(elements)
    };
    // Speaker notes are native `ppt/notesSlides` parts, not slide content.
    if (slide.notes) built.notes = slide.notes;
    return splitOverflowingTable(built, analysis.pageSize, report);
  });

  // A semantic tally: what the source's structure became. A reader of the report
  // sees "1 title + 1 body + 3 cards" instead of raw shape counts.
  const roles = {};
  const tallyRole = (node) => {
    if (node.role) roles[node.role] = (roles[node.role] || 0) + 1;
    (node.children || []).forEach(tallyRole);
  };
  analysis.slides.forEach((slide) => slide.nodes.forEach(tallyRole));
  report.roles = roles;
  // Pagination adds slides, so the count a reader sees is the deck's, not the source's.
  report.slides = slides.length;
  const deck = {
    title: options.title || analysis.title || 'HTML to native',
    language: options.language || 'zh-CN',
    pageSize: analysis.pageSize,
    theme: resolvedTheme,
    slides
  };
  return { deck, report };
}

module.exports = {
  buildDeckSpec,
  deriveTheme,
  firstFontFamily,
  textElementFromNode,
  surfaceElementFromNode,
  imageElementFromNode,
  tableElementFromNode,
  containerPlan,
  containerElement,
  verifySlide,
  BOX_TOLERANCE,
  FIT_BY_OBJECT_FIT
};
