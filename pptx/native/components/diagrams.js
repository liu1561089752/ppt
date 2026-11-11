'use strict';

const { resolveTheme } = require('../themes/design_system');
const { estimateTextHeight } = require('../engine/text_measure');

function textBlock(fontSizePt, theme, minimum = 0.26) {
  const lineSpacing = theme.typography?.lineSpacingMultiple || theme.lineSpacingMultiple || 1.22;
  // One line plus the 2pt inset margin used by the text renderer.
  return Math.max(minimum, (fontSizePt * lineSpacing + 6) / 72);
}

function processFlow(steps, options = {}) {
  const theme = resolveTheme(options.theme);
  const items = Array.isArray(steps) ? steps : [];
  const x = options.x === undefined ? theme.layouts.pageMarginX : options.x;
  const y = options.y === undefined ? 2.1 : options.y;
  const totalWidth = options.w === undefined ? 11.85 : options.w;
  const gap = options.gap === undefined ? theme.layouts.columnGap : options.gap;
  const nodeWidth = (totalWidth - gap * Math.max(0, items.length - 1)) / Math.max(1, items.length);
  const nodeHeight = options.nodeHeight || 1.15;
  const titleSize = options.titleSize || theme.sizes.heading;
  const titleHeight = textBlock(titleSize, theme, 0.3);
  const titleY = y + 0.18;
  const bodyY = titleY + titleHeight + 0.06;
  const bodyHeight = Math.max(0.2, y + nodeHeight - bodyY - 0.08);
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
      x: nodeX + 0.12, y: titleY, w: nodeWidth - 0.24, h: titleHeight,
      fontFace: theme.fonts.heading,
      fontSize: titleSize, bold: true,
      color: item.color || theme.colors.primary, align: 'center'
    });
    if (item.description) {
      elements.push({
        type: 'text', text: item.description,
        x: nodeX + 0.12, y: bodyY, w: nodeWidth - 0.24, h: bodyHeight,
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
  const pageWidth = options.pageWidth || 13.333;
  const spacing = points.length > 1 ? w / (points.length - 1) : 0;
  const headingSize = options.titleSize || theme.sizes.heading;
  const lineHeight = theme.typography?.lineSpacingMultiple || theme.lineSpacingMultiple || 1.22;
  const measure = (value, boxWidth, size) => estimateTextHeight(String(value), boxWidth, size,
    { lineHeight, safetyFactor: 0.9 });
  // Every label box is centred on its dot, so the first and last one hang past the dot by half a box:
  // at the right-hand end that ran off the page. Clamped here, and the tallest title across the row
  // sets the height for all of them, so a two-line point does not push its own body out of line.
  const boxLeft = (centre, boxWidth) => {
    const left = Math.max(0.08, centre - boxWidth / 2);
    return Math.min(left, pageWidth - 0.08 - boxWidth);
  };
  const titleHeight = Math.max(
    textBlock(headingSize, theme, 0.42),
    ...points.map((point) => measure(point.title || '', 1.7, headingSize))
  );
  const dateY = y + 0.42;
  const titleY = dateY + 0.3;
  const bodyY = titleY + titleHeight + 0.07;
  const bodyHeight = options.descriptionHeight || Math.max(
    0.6,
    ...points.map((point) => measure(point.description || '', 1.8, theme.sizes.caption))
  );
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
      x: boxLeft(pointX, 1.3), y: dateY, w: 1.3, h: 0.26,
      fontFace: theme.fonts.body,
      fontSize: theme.sizes.caption, bold: true, color: theme.colors.muted, align: 'center'
    });
    elements.push({
      type: 'text', text: point.title || '',
      x: boxLeft(pointX, 1.7), y: titleY, w: 1.7, h: titleHeight,
      fontFace: theme.fonts.heading,
      fontSize: headingSize, bold: true, color: theme.colors.primary, align: 'center'
    });
    if (point.description) {
      elements.push({
        type: 'text', text: point.description,
        x: boxLeft(pointX, 1.8), y: bodyY, w: 1.8, h: bodyHeight,
        fontFace: theme.fonts.body,
        fontSize: theme.sizes.caption, color: theme.colors.muted, align: 'center', valign: 'top'
      });
    }
  });
  return elements;
}

module.exports = { processFlow, timeline };
