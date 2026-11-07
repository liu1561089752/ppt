'use strict';

const { resolveTheme } = require('../themes/design_system');

function processFlow(steps, options = {}) {
  const theme = resolveTheme(options.theme);
  const items = Array.isArray(steps) ? steps : [];
  const x = options.x === undefined ? theme.layouts.pageMarginX : options.x;
  const y = options.y === undefined ? 2.1 : options.y;
  const totalWidth = options.w === undefined ? 11.85 : options.w;
  const gap = options.gap === undefined ? theme.layouts.columnGap : options.gap;
  const nodeWidth = (totalWidth - gap * Math.max(0, items.length - 1)) / Math.max(1, items.length);
  const nodeHeight = options.nodeHeight || 1.15;
  const elements = [];

  items.forEach((item, index) => {
    const nodeX = x + index * (nodeWidth + gap);
    elements.push({
      type: 'shape', x: nodeX, y, w: nodeWidth, h: nodeHeight,
      radius: theme.radii.medium,
      fill: item.fill || theme.colors.surface,
      lineColor: item.border || theme.colors.border,
      lineWidth: theme.effects.cardBorder ? 0.9 : 0
    });
    elements.push({
      type: 'text', text: item.title || String(item),
      x: nodeX + 0.12, y: y + 0.2, w: nodeWidth - 0.24, h: 0.32,
      fontFace: theme.fonts.heading,
      fontSize: options.titleSize || theme.sizes.heading, bold: true,
      color: item.color || theme.colors.primary, align: 'center'
    });
    if (item.description) {
      elements.push({
        type: 'text', text: item.description,
        x: nodeX + 0.12, y: y + 0.58, w: nodeWidth - 0.24, h: nodeHeight - 0.68,
        fontFace: theme.fonts.body,
        fontSize: options.bodySize || theme.sizes.caption, color: theme.colors.muted,
        align: 'center', valign: 'top'
      });
    }
    if (index < items.length - 1) {
      elements.push({
        type: 'line',
        x: nodeX + nodeWidth + 0.02,
        y: y + nodeHeight / 2,
        w: gap - 0.04,
        h: 0,
        color: options.connectorColor || theme.colors.accent,
        width: 1.5,
        endArrowType: 'triangle'
      });
    }
  });
  return elements;
}

function timeline(items, options = {}) {
  const theme = resolveTheme(options.theme);
  const points = Array.isArray(items) ? items : [];
  const x = options.x === undefined ? 1.0 : options.x;
  const y = options.y === undefined ? 2.4 : options.y;
  const w = options.w === undefined ? 11.2 : options.w;
  const spacing = points.length > 1 ? w / (points.length - 1) : 0;
  const elements = [];
  if (points.length > 1) {
    elements.push({
      type: 'line', x, y: y + 0.12, w, h: 0,
      color: options.lineColor || theme.colors.border, width: 2
    });
  }
  points.forEach((point, index) => {
    const pointX = x + spacing * index;
    elements.push({
      type: 'shape', shape: 'ellipse',
      x: pointX - 0.11, y, w: 0.22, h: 0.22,
      fill: point.color || options.accent || theme.colors.accent,
      line: false
    });
    elements.push({
      type: 'text', text: point.date || '',
      x: pointX - 0.65, y: y + 0.42, w: 1.3, h: 0.25,
      fontFace: theme.fonts.body,
      fontSize: theme.sizes.caption, bold: true, color: theme.colors.muted, align: 'center'
    });
    elements.push({
      type: 'text', text: point.title || '',
      x: pointX - 0.85, y: y + 0.78, w: 1.7, h: 0.48,
      fontFace: theme.fonts.heading,
      fontSize: theme.sizes.heading, bold: true, color: theme.colors.primary, align: 'center'
    });
    if (point.description) {
      elements.push({
        type: 'text', text: point.description,
        x: pointX - 0.9, y: y + 1.34, w: 1.8, h: 0.75,
        fontFace: theme.fonts.body,
        fontSize: theme.sizes.caption, color: theme.colors.muted, align: 'center', valign: 'top'
      });
    }
  });
  return elements;
}

module.exports = { processFlow, timeline };
