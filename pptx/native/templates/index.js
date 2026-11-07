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

module.exports = { cover, content, kpi, comparison, process };
