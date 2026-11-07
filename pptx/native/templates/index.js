'use strict';

const components = require('../components');

function cover(options = {}) {
  return {
    background: options.background || 'F7F7F4',
    elements: [
      components.title(options.title || '演示文稿标题', {
        x: 0.85, y: 1.6, w: 11.6, h: 1.0,
        fontSize: options.titleSize || 34,
        color: options.titleColor || '183B3A'
      }),
      components.paragraph(options.subtitle || '副标题 / 日期 / 汇报对象', {
        x: 0.9, y: 2.85, w: 10.8, h: 0.7,
        fontSize: options.subtitleSize || 18,
        color: options.subtitleColor || '6B7470'
      }),
      components.divider({ x: 0.9, y: 4.0, w: 2.0, color: options.accent || 'D36B45', width: 2.4 })
    ]
  };
}

function content(options = {}) {
  return {
    background: options.background || 'FFFFFF',
    margin: 0.72,
    elements: [
      components.title(options.title || '页面标题', { x: 0.72, y: 0.52, w: 11.9, h: 0.58, fontSize: 26 }),
      components.divider({ x: 0.74, y: 1.24, w: 11.85 }),
      components.paragraph(options.body || '在这里放置核心观点、解释和证据。', {
        x: 0.78, y: 1.62, w: 11.65, h: options.bodyHeight,
        fontSize: options.bodySize || 17
      })
    ]
  };
}

function kpi(options = {}) {
  const values = options.items || [];
  const gap = 0.22;
  const x0 = 0.75;
  const y = 2.0;
  const cardW = (11.85 - gap * Math.max(0, values.length - 1)) / Math.max(1, values.length);
  const elements = [
    components.title(options.title || '关键指标', { x: 0.72, y: 0.55, w: 11.9, h: 0.6, fontSize: 26 }),
    components.divider({ x: 0.74, y: 1.28, w: 11.85 })
  ];
  values.forEach((item, index) => {
    elements.push(...components.kpiCard(Object.assign({}, item, { x: x0 + index * (cardW + gap), y, w: cardW })));
  });
  return { background: options.background || 'F7F7F4', elements };
}

module.exports = { cover, content, kpi };
