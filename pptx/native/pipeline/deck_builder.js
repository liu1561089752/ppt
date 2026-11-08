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
  none: 'contain',
  'scale-down': 'contain'
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
  'space-around': 'space-around'
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
  if (node.bullet) element.bullet = true;
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
  if (radius) element.radius = radius;
  if (node.clip) element.clip = node.clip;
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

function tableElementFromNode(node, resolvedTheme) {
  if (!node.rows || !node.rows.length) return null;
  const columns = Math.max(
    Number(node.columnCount) || 0,
    ...node.rows.map((row) => row.reduce(
      (accumulator, cell) => accumulator + ((cell.options && cell.options.colspan) || 1), 0))
  );
  const width = Math.max(0.2, node.w);
  return {
    type: 'table',
    x: Number(xOf(node).toFixed(4)),
    y: Number(yOf(node).toFixed(4)),
    w: Number(width.toFixed(4)),
    h: Number(Math.max(0.2, node.h).toFixed(4)),
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
    if (overlay.fill) {
      const shape = Object.assign({ type: 'shape', line: false, fill: overlay.fill }, box);
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

function leafElementRotationFree(node, resolvedTheme, report) {
  if (node.kind === 'text' || node.kind === 'list') {
    if (!node.text && !node.runs) return null;
    report.textElements += 1;
    if (node.runs) report.richTextElements += 1;
    const wrapped = textWithSurface(node, resolvedTheme, report);
    if (wrapped) return wrapped;
    return textElementFromNode(node, null, resolvedTheme);
  }
  if (node.kind === 'image') {
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

/** Stable paint-order sort: DOM order, unless a child declares z-index. */
function sortByPaintOrder(children, parent) {
  const indexed = (parent.children || []).filter((child) => zIndexOf(child) !== 0);
  if (!indexed.length) return children;
  return children
    .map((element, index) => ({ element, index }))
    .sort((a, b) => {
      const za = elementZ(a.element);
      const zb = elementZ(b.element);
      if (za === zb) return a.index - b.index;
      return za - zb;
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
  if (!node || node.w <= 0.01 || node.h <= 0.01) return;

  if (node.backgroundImage) {
    const picture = imageElementFromNode({
      src: node.backgroundImage.src,
      x: xOf(node),
      y: yOf(node),
      w: node.w,
      h: node.h,
      objectFit: node.backgroundImage.fit,
      focus: node.backgroundImage.focus,
      radius: node.radius,
      alt: ''
    });
    if (picture) {
      picture._probe = 'bg-' + node.id;
      probes.set(picture._probe, boxOf(node));
      owners.set(picture._probe, ownerId);
      elements.push(picture);
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
        elements.push(scrim);
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
    emitLeafOverlays(node, context, elements);
    return;
  }
  element._probe = node.id;
  element._z = zIndexOf(node);
  probes.set(node.id, boxOf(node));
  owners.set(node.id, ownerId);
  elements.push(element);
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
function buildDeckSpec(analysis, options = {}) {
  const resolvedTheme = options.theme
    ? resolveTheme(options.theme)
    : deriveTheme(analysis.variables || {}, options.baseTheme);

  const report = emptyCounters();
  report.slides = analysis.slides.length;
  report.unsupported = analysis.unsupported.length;

  const slides = analysis.slides.map((slide) => {
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
    return built;
  });

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
