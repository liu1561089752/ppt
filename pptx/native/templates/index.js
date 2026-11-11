'use strict';

const components = require('../components');
const { resolveTheme, contrastRatio } = require('../themes/design_system');
const { estimateTextHeight } = require('../engine/text_measure');

/**
 * A title box tall enough for its own font size, and never shorter than the height the template has
 * always used.
 *
 * The fixed heights were tuned for the default theme's 30 pt title. Every colour preset runs at 34 pt,
 * so a 34 pt title overflowed its own 0.6 in box and `--strict` failed on template geometry. Keeping
 * the old value as the minimum means no existing deck moves.
 */
function titleBox(title, width, fontSize, minimum, theme) {
  // These options mirror `prepareElement` in engine/layout.js, which is the measurement the warning is
  // raised against: the layout wraps at 90% of the box width (safetyFactor), so measuring at the full
  // width finds one line where the layout finds two and the box comes out short. Measured this way the
  // template and the validator cannot disagree.
  const lineHeight = theme.typography?.lineSpacingMultiple || theme.lineSpacingMultiple || 1.22;
  const height = estimateTextHeight(String(title), width, fontSize, {
    fontFace: theme.fonts.heading, lineHeight, safetyFactor: 0.9
  });
  return Math.max(minimum, height);
}

function cover(options = {}) {
  const theme = resolveTheme(options.theme);
  return {
    background: options.background || theme.colors.background,
    elements: [
      components.title(options.title || '演示文稿标题', {
        theme, x: theme.layouts.pageMarginX, y: 1.6, w: 11.6, h: 1.0,
        fontSize: options.titleSize || theme.sizes.title, color: options.titleColor || theme.colors.primary
      }),
      components.paragraph(options.subtitle || '副标题 / 日期 / 汇报对象', {
        theme, x: theme.layouts.pageMarginX + 0.05, y: 2.85, w: 10.8, h: 0.7,
        fontSize: options.subtitleSize || theme.sizes.body, color: options.subtitleColor || theme.colors.muted
      }),
      components.divider({ theme, x: theme.layouts.pageMarginX + 0.05, y: 4.0, w: 2.0, color: options.accent || theme.colors.accent, width: 2.4 })
    ]
  };
}

function content(options = {}) {
  const theme = resolveTheme(options.theme);
  return {
    // `surface` is the card colour, not the page. Painting the page with it made every content page
    // pure white with white cards floating on it - the deck looked unfinished, and no rule said so.
    background: options.background || theme.colors.background,
    margin: theme.layouts.pageMarginX,
    elements: [
      components.title(options.title || '页面标题', {
        theme, x: theme.layouts.pageMarginX, y: 0.52, w: 11.9, fontSize: theme.sizes.title,
        h: titleBox(options.title || '页面标题', 11.9, theme.sizes.title, 0.58, theme)
      }),
      components.divider({ theme, x: theme.layouts.pageMarginX + 0.02, y: 1.24, w: 11.85 }),
      components.paragraph(options.body || '在这里放置核心观点、解释和证据。', {
        theme, x: theme.layouts.pageMarginX + 0.06, y: 1.62, w: 11.65,
        h: options.bodyHeight, fontSize: options.bodySize || theme.sizes.body
      })
    ]
  };
}

function kpi(options = {}) {
  const theme = resolveTheme(options.theme);
  const values = options.items || [];
  const gap = theme.layouts.columnGap;
  const x0 = theme.layouts.pageMarginX;
  const y = 2.0;
  const cardW = (13.333 - x0 * 2 - gap * Math.max(0, values.length - 1)) / Math.max(1, values.length);
  const elements = [
    components.title(options.title || '关键指标', { theme, x: x0, y: 0.55, w: 11.9, h: titleBox(options.title || '关键指标', 11.9, theme.sizes.title, 0.6, theme), fontSize: theme.sizes.title }),
    components.divider({ theme, x: x0 + 0.02, y: 1.28, w: 11.85 })
  ];
  values.forEach((item, index) => {
    elements.push(...components.kpiCard(Object.assign({}, item, {
      theme, x: x0 + index * (cardW + gap), y, w: cardW
    })));
  });
  return { background: options.background || theme.colors.background, elements };
}

function comparison(options = {}) {
  const theme = resolveTheme(options.theme);
  const left = options.left || {};
  const right = options.right || {};
  const margin = theme.layouts.pageMarginX;
  const gap = theme.layouts.columnGap * 1.5;
  const cardW = (13.333 - margin * 2 - gap) / 2;
  return {
    background: options.background || theme.colors.background,
    elements: [
      components.title(options.title || '方案对比', { theme, x: margin, y: 0.55, w: 11.9, h: titleBox(options.title || '方案对比', 11.9, theme.sizes.title, 0.6, theme), fontSize: theme.sizes.title }),
      components.divider({ theme, x: margin + 0.02, y: 1.28, w: 11.85 }),
      ...components.infoCard({ theme, x: margin, y: 1.8, w: cardW, h: 4.6, title: left.title || '方案 A', body: left.body || '', fill: left.fill || theme.colors.surface }),
      ...components.infoCard({ theme, x: margin + cardW + gap, y: 1.8, w: cardW, h: 4.6, title: right.title || '方案 B', body: right.body || '', fill: right.fill || theme.colors.surface })
    ]
  };
}

function process(options = {}) {
  const theme = resolveTheme(options.theme);
  const margin = theme.layouts.pageMarginX;
  return {
    background: options.background || theme.colors.surface,
    elements: [
      components.title(options.title || '关键流程', { theme, x: margin, y: 0.55, w: 11.9, h: titleBox(options.title || '关键流程', 11.9, theme.sizes.title, 0.6, theme), fontSize: theme.sizes.title }),
      components.divider({ theme, x: margin + 0.02, y: 1.28, w: 11.85 }),
      ...components.processFlow(options.steps || [], { theme, x: margin + 0.06, y: 2.2, w: 11.75 })
    ]
  };
}


function hero(options = {}) {
  const theme = resolveTheme(options.theme);
  const margin = theme.layouts.pageMarginX;
  const gradient = theme.backgrounds && theme.backgrounds.gradient;
  const shadowValue = theme.effects && theme.effects.shadow;
  const shadow = shadowValue && typeof shadowValue === 'object' ? shadowValue : null;
  const opacity = theme.effects && Number.isFinite(theme.effects.opacity) ? theme.effects.opacity : 1;
  const panelStops = gradient && Array.isArray(gradient.stops)
    ? gradient.stops.map((stop) => Object.assign({}, stop, {
        transparency: 100 - (100 - (stop.transparency || 0)) * opacity
      }))
    : null;
  const panel = {
    type: 'shape', x: 8.25, y: 0.68, w: 4.45, h: 6.12,
    fill: panelStops && panelStops.length ? panelStops[0].color : theme.colors.surface,
    line: false, rotate: 1.5,
    shadow: shadow ? Object.assign({}, shadow, { opacity: shadow.opacity * opacity }) : undefined
  };
  if (panelStops && panelStops.length >= 2) {
    panel.gradient = { angle: gradient.angle, stops: panelStops };
  }
  return {
    background: options.background || theme.colors.background,
    elements: [
      panel,
      { type: 'shape', x: 8.78, y: 1.25, w: 3.35, h: 4.95, fill: false,
        lineColor: theme.colors.foreground, lineTransparency: 82, lineWidth: 1 },
      { type: 'shape', x: margin, y: 0.98, w: 0.12, h: 0.48, fill: theme.colors.accent, line: false },
      { type: 'text', text: options.kicker || 'PRESENTATION / OVERVIEW',
        x: margin + 0.28, y: 1.02, w: 6.8, h: 0.3,
        fontFace: theme.fonts.body, fontSize: theme.sizes.caption, bold: true, color: theme.colors.muted },
      components.title(options.title || '一个有视觉重心的标题',
        {
          theme, x: margin, y: 1.72, w: 6.75,
          fontSize: options.titleSize || theme.sizes.title,
          color: options.titleColor || theme.colors.primary,
          h: titleBox(options.title || '页面标题', 6.75, options.titleSize || theme.sizes.title, 1.55, theme)
      }),
      components.paragraph(options.subtitle || '用清晰的叙事、克制的装饰和有层次的留白建立页面气质。',
        { theme, x: margin + 0.04, y: 3.62, w: 6.35, h: 1.05, fontSize: options.subtitleSize || theme.sizes.body, color: theme.colors.foreground }),
      { type: 'shape', x: margin + 0.04, y: 5.18, w: 1.15, h: 0.07, fill: theme.colors.accent, line: false },
      { type: 'text', text: options.footer || 'STRATEGY  ·  DESIGN  ·  DELIVERY',
        x: margin + 0.04, y: 5.58, w: 5.8, h: 0.26,
        fontFace: theme.fonts.body, fontSize: theme.sizes.caption, color: theme.colors.muted }
    ]
  };
}

/**
 * A section divider: one colour field, a big title in the theme's background colour, a thin rule.
 *
 * This page is what makes a deck read as designed rather than printed, and it is the page that used to
 * be hand-built in every deck (three of them in a 25-page run) because no template wrote it. The field
 * defaults to `primary`, the ink to `background` - the two colours a theme guarantees to be far apart -
 * and the rule falls back to the ink when `accent` would be invisible on the field.
 */
function section(options = {}) {
  const theme = resolveTheme(options.theme);
  const field = options.background || theme.colors.primary;
  const ink = options.titleColor || theme.colors.background;
  const rule = contrastRatio(theme.colors.accent, field) >= 3 ? theme.colors.accent : ink;
  const marginX = theme.layouts.pageMarginX;
  const elements = [];
  if (options.kicker) {
    elements.push(components.paragraph(String(options.kicker).toUpperCase(), {
      theme, x: marginX, y: 2.32, w: 8.0, h: 0.34,
      fontSize: theme.sizes.caption + 2, color: ink, charSpacing: 1.6, bold: true
    }));
  }
  elements.push(components.title(options.title || '章节标题', {
    theme, x: marginX, y: 2.78, w: 10.6, h: 1.5,
    fontSize: options.titleSize || Math.round(theme.sizes.title * 1.35), color: ink
  }));
  elements.push({ type: 'shape', x: marginX, y: 4.46, w: 1.7, h: 0.05, fill: rule, line: false });
  if (options.subtitle) {
    elements.push(components.paragraph(options.subtitle, {
      theme, x: marginX, y: 4.72, w: 9.4, h: 0.7,
      fontSize: theme.sizes.body + 2, color: ink, transparency: 18
    }));
  }
  return { background: field, elements };
}

function editorial(options = {}) {
  const theme = resolveTheme(options.theme);
  const margin = theme.layouts.pageMarginX;
  const gap = theme.layouts.columnGap * 1.4;
  const columnW = (13.333 - margin * 2 - gap) / 2;
  const leftX = margin;
  const rightX = margin + columnW + gap;
  const elements = [
    { type: 'text', text: options.kicker || 'INSIGHT / ANALYSIS',
      x: margin, y: 0.48, w: 5.5, h: 0.25, fontSize: theme.sizes.caption, bold: true, color: theme.colors.accent },
    components.title(options.title || '用编辑式版面组织复杂信息',
      { theme, x: margin, y: 0.9, w: 11.8, h: titleBox(options.title || '页面标题', 11.8, theme.sizes.title, 0.72, theme), fontSize: theme.sizes.title }),
    { type: 'shape', x: margin, y: 1.82, w: 0.82, h: 0.06, fill: theme.colors.accent, line: false },
    components.paragraph(options.lead || '先给出能够独立成立的核心判断，再用证据和解释展开。',
      { theme, x: margin, y: 2.18, w: 11.3, h: 0.76, fontSize: theme.sizes.heading, color: theme.colors.primary }),
    { type: 'shape', x: leftX, y: 3.22, w: columnW, h: 2.72, fill: theme.colors.surface,
      lineColor: theme.colors.border, lineWidth: 0.7, radius: theme.radii.medium },
    { type: 'shape', x: rightX, y: 3.22, w: columnW, h: 2.72, fill: theme.colors.surface,
      lineColor: theme.colors.border, lineWidth: 0.7, radius: theme.radii.medium },
    { type: 'text', text: options.leftHeading || '观点与背景',
      x: leftX + 0.28, y: 3.5, w: columnW - 0.56, h: 0.52,
      fontSize: theme.sizes.heading, bold: true, color: theme.colors.primary },
    components.paragraph(options.leftBody || '说明问题背景、关键事实和上下文。用简短段落保留阅读节奏。',
      { theme, x: leftX + 0.28, y: 4.16, w: columnW - 0.56, h: 1.38, fontSize: theme.sizes.body, color: theme.colors.foreground }),
    { type: 'text', text: options.rightHeading || '证据与行动',
      x: rightX + 0.28, y: 3.5, w: columnW - 0.56, h: 0.52,
      fontSize: theme.sizes.heading, bold: true, color: theme.colors.primary },
    components.paragraph(options.rightBody || '用数据、案例或行动建议支撑结论，并明确下一步的优先顺序。',
      { theme, x: rightX + 0.28, y: 4.16, w: columnW - 0.56, h: 1.38, fontSize: theme.sizes.body, color: theme.colors.foreground })
  ];
  return { background: options.background || theme.colors.background, elements };
}

module.exports = { cover, content, kpi, comparison, process, hero, section, editorial };
