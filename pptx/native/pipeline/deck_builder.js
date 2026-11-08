'use strict';

/**
 * Layout tree → Native Deck Spec (stage 3 of the HTML → Native pipeline).
 *
 * The analyzer has already resolved CSS intent into geometry. This stage maps
 * semantics and visual attributes onto native PowerPoint objects:
 *
 *   text          → native text box (role-aware) with optional rich-text runs
 *   list          → native text box with PowerPoint bullets
 *   block/card    → editable rounded-rectangle shape + its children
 *   image         → native picture with an editable crop rectangle
 *   table         → native PowerPoint table (rows/cells stay editable)
 *   line / hr     → native connector
 *
 * Cards remain a shape *plus* its own text boxes; no node is rasterized.
 */

const defaultTheme = require('../themes/default');
const { resolveTheme } = require('../themes/design_system');
const { isBoldWeight } = require('../engine/native_pptx');
const {
  parseColor,
  parseBoxShadow,
  backgroundOf,
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
  const merged = resolveTheme(Object.assign({}, baseTheme || defaultTheme, theme));
  return merged;
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
  const element = {
    type: 'text',
    role,
    text: node.runs || node.text,
    x: Number(node.x.toFixed(4)),
    y: Number(node.y.toFixed(4)),
    w: Number(Math.max(0.05, node.w).toFixed(4)),
    h: Number(Math.max(0.05, node.h).toFixed(4)),
    fontFace,
    fontSize: Math.max(4, Number((node.fontSizePt || 14).toFixed(2))),
    color: (color && color.hex) || (isHeadingRole ? resolvedTheme.colors.primary : resolvedTheme.colors.foreground),
    bold: weight === 'bold' || weight === 'bolder' || Number(weight) >= 600,
    italic: String(style.fontStyle || '').toLowerCase() === 'italic',
    align: ['left', 'center', 'right', 'justify'].includes(align) ? align : 'left',
    valign: role === 'caption' || role === 'body' ? 'top' : 'mid',
    lineSpacingMultiple: node.lineSpacingMultiple
  };
  const transparency = transparencyOf(color);
  if (transparency) element.transparency = transparency;
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
    x: Number(node.x.toFixed(4)),
    y: Number(node.y.toFixed(4)),
    w: Number(Math.max(0.02, node.w).toFixed(4)),
    h: Number(Math.max(0.02, node.h).toFixed(4)),
    fill: background ? background.hex : resolvedTheme.colors.surface
  };
  const fillTransparency = transparencyOf(background);
  if (fillTransparency !== undefined) element.fillTransparency = fillTransparency;
  if (gradient) {
    element.gradient = gradient;
    element.fill = gradient.stops[0].color;
  }
  if (radius) element.radius = radius;
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
  const opacity = Number(style.opacity);
  if (Number.isFinite(opacity) && opacity < 1) element.transparency = Math.round((1 - opacity) * 100);
  return element;
}

function imageElementFromNode(node) {
  if (!node.src) return null;
  const element = {
    type: 'image',
    x: Number(node.x.toFixed(4)),
    y: Number(node.y.toFixed(4)),
    w: Number(Math.max(0.05, node.w).toFixed(4)),
    h: Number(Math.max(0.05, node.h).toFixed(4)),
    fit: FIT_BY_OBJECT_FIT[node.objectFit] || 'cover'
  };
  if (/^data:/iu.test(node.src) || /^https?:/iu.test(node.src)) element.data = node.src;
  else element.path = node.src;
  if (node.alt) element.altText = node.alt;
  if (node.radius) element.radius = node.radius;
  if (node.border) {
    element.lineColor = node.border.color;
    element.lineWidth = node.border.width;
  }
  return element;
}

function tableElementFromNode(node, resolvedTheme) {
  if (!node.rows || !node.rows.length) return null;
  const columns = Math.max(...node.rows.map((row) => row.length));
  return {
    type: 'table',
    x: Number(node.x.toFixed(4)),
    y: Number(node.y.toFixed(4)),
    w: Number(Math.max(0.2, node.w).toFixed(4)),
    h: Number(Math.max(0.2, node.h).toFixed(4)),
    rows: node.rows,
    options: {
      colW: Array.from({ length: columns }, () => Number((node.w / columns).toFixed(3))),
      fontFace: resolvedTheme.fonts.body,
      fontSize: Math.max(6, Number((node.fontSizePt || 11).toFixed(1))),
      border: { type: 'solid', color: resolvedTheme.colors.border, pt: 0.5 },
      valign: 'mid'
    }
  };
}

function lineElementFromNode(node, resolvedTheme) {
  const style = node.style || {};
  const color = backgroundOf(style) || hexOrNull(style.borderColor);
  return {
    type: 'line',
    x: Number(node.x.toFixed(4)),
    y: Number(node.y.toFixed(4)),
    w: Number(Math.max(0.05, node.w).toFixed(4)),
    h: 0,
    color: (color && color.hex) || resolvedTheme.colors.border,
    width: 1
  };
}

function emitNode(node, resolvedTheme, elements, report) {
  if (!node || node.w <= 0.01 || node.h <= 0.01) return;

  if (node.kind === 'text' || node.kind === 'list') {
    if (!node.text && !node.runs) return;
    elements.push(textElementFromNode(node, null, resolvedTheme));
    report.textElements += 1;
    if (node.runs) report.richTextElements += 1;
    return;
  }
  if (node.kind === 'image') {
    const element = imageElementFromNode(node);
    if (element) {
      elements.push(element);
      report.images += 1;
    }
    return;
  }
  if (node.kind === 'table') {
    const element = tableElementFromNode(node, resolvedTheme);
    if (element) {
      elements.push(element);
      report.tables += 1;
    }
    return;
  }
  if (node.kind === 'line') {
    elements.push(lineElementFromNode(node, resolvedTheme));
    report.lines += 1;
    return;
  }

  // Block / card / group
  const surface = surfaceElementFromNode(node, resolvedTheme);
  if (surface) {
    elements.push(surface);
    report.shapes += 1;
  }
  (node.children || []).forEach((child) => emitNode(child, resolvedTheme, elements, report));
}

/** Convert an analyzed document into a Native Deck Spec plus a mapping report. */
function buildDeckSpec(analysis, options = {}) {
  const resolvedTheme = options.theme
    ? resolveTheme(options.theme)
    : deriveTheme(analysis.variables || {}, options.baseTheme);

  const report = {
    slides: analysis.slides.length,
    textElements: 0,
    richTextElements: 0,
    shapes: 0,
    images: 0,
    tables: 0,
    lines: 0,
    unsupported: analysis.unsupported.length
  };

  const slides = analysis.slides.map((slide) => {
    const elements = [];
    if (slide.gradient) {
      elements.push({
        type: 'shape',
        x: 0, y: 0,
        w: analysis.pageSize.width,
        h: analysis.pageSize.height,
        fill: slide.gradient.stops[0].color,
        gradient: slide.gradient,
        line: false
      });
      report.shapes += 1;
    }
    slide.nodes.forEach((node) => emitNode(node, resolvedTheme, elements, report));
    return {
      background: slide.background,
      elements
    };
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
  FIT_BY_OBJECT_FIT
};
