'use strict';

const components = require('../components');
const { resolveTheme } = require('../themes/design_system');

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
    background: options.background || theme.colors.surface,
    margin: theme.layouts.pageMarginX,
    elements: [
      components.title(options.title || '页面标题', { theme, x: theme.layouts.pageMarginX, y: 0.52, w: 11.9, h: 0.58, fontSize: theme.sizes.title }),
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
    components.title(options.title || '关键指标', { theme, x: x0, y: 0.55, w: 11.9, h: 0.6, fontSize: theme.sizes.title }),
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
      components.title(options.title || '方案对比', { theme, x: margin, y: 0.55, w: 11.9, h: 0.6, fontSize: theme.sizes.title }),
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
      components.title(options.title || '关键流程', { theme, x: margin, y: 0.55, w: 11.9, h: 0.6, fontSize: theme.sizes.title }),
      components.divider({ theme, x: margin + 0.02, y: 1.28, w: 11.85 }),
      ...components.processFlow(options.steps || [], { theme, x: margin + 0.06, y: 2.2, w: 11.75 })
    ]
  };
}


function hero(options = {}) {
  const theme = resolveTheme(options.theme);
  const margin = theme.layouts.pageMarginX;
  const gradient = theme.backgrounds && theme.backgrounds.gradient;
  const shadow = theme.effects && theme.effects.shadow;
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
        { theme, x: margin, y: 1.72, w: 6.75, h: 1.55, fontSize: options.titleSize || theme.sizes.title, color: options.titleColor || theme.colors.primary }),
      components.paragraph(options.subtitle || '用清晰的叙事、克制的装饰和有层次的留白建立页面气质。',
        { theme, x: margin + 0.04, y: 3.62, w: 6.35, h: 1.05, fontSize: options.subtitleSize || theme.sizes.body, color: theme.colors.foreground }),
      { type: 'shape', x: margin + 0.04, y: 5.18, w: 1.15, h: 0.07, fill: theme.colors.accent, line: false },
      { type: 'text', text: options.footer || 'STRATEGY  ·  DESIGN  ·  DELIVERY',
        x: margin + 0.04, y: 5.58, w: 5.8, h: 0.26,
        fontFace: theme.fonts.body, fontSize: theme.sizes.caption, color: theme.colors.muted }
    ]
  };
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
      { theme, x: margin, y: 0.9, w: 11.8, h: 0.72, fontSize: theme.sizes.title }),
    { type: 'shape', x: margin, y: 1.82, w: 0.82, h: 0.06, fill: theme.colors.accent, line: false },
    components.paragraph(options.lead || '先给出能够独立成立的核心判断，再用证据和解释展开。',
      { theme, x: margin, y: 2.18, w: 11.3, h: 0.76, fontSize: theme.sizes.heading, color: theme.colors.primary }),
    { type: 'shape', x: leftX, y: 3.22, w: columnW, h: 2.72, fill: theme.colors.surface,
      lineColor: theme.colors.border, lineWidth: 0.7, radius: theme.radii.medium },
    { type: 'shape', x: rightX, y: 3.22, w: columnW, h: 2.72, fill: theme.colors.surface,
      lineColor: theme.colors.border, lineWidth: 0.7, radius: theme.radii.medium },
    { type: 'text', text: options.leftHeading || '观点与背景',
      x: leftX + 0.28, y: 3.52, w: columnW - 0.56, h: 0.4,
      fontSize: theme.sizes.heading, bold: true, color: theme.colors.primary },
    components.paragraph(options.leftBody || '说明问题背景、关键事实和上下文。用简短段落保留阅读节奏。',
      { theme, x: leftX + 0.28, y: 4.12, w: columnW - 0.56, h: 1.42, fontSize: theme.sizes.body, color: theme.colors.foreground }),
    { type: 'text', text: options.rightHeading || '证据与行动',
      x: rightX + 0.28, y: 3.52, w: columnW - 0.56, h: 0.4,
      fontSize: theme.sizes.heading, bold: true, color: theme.colors.primary },
    components.paragraph(options.rightBody || '用数据、案例或行动建议支撑结论，并明确下一步的优先顺序。',
      { theme, x: rightX + 0.28, y: 4.12, w: columnW - 0.56, h: 1.42, fontSize: theme.sizes.body, color: theme.colors.foreground })
  ];
  return { background: options.background || theme.colors.background, elements };
}

module.exports = { cover, content, kpi, comparison, process, hero, editorial };
