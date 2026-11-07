'use strict';

function processFlow(steps, options = {}) {
  const items = Array.isArray(steps) ? steps : [];
  const x = options.x === undefined ? 0.75 : options.x;
  const y = options.y === undefined ? 2.1 : options.y;
  const totalWidth = options.w === undefined ? 11.85 : options.w;
  const gap = options.gap === undefined ? 0.28 : options.gap;
  const nodeWidth = (totalWidth - gap * Math.max(0, items.length - 1)) / Math.max(1, items.length);
  const nodeHeight = options.nodeHeight || 1.15;
  const elements = [];

  items.forEach((item, index) => {
    const nodeX = x + index * (nodeWidth + gap);
    elements.push({
      type: 'shape', x: nodeX, y, w: nodeWidth, h: nodeHeight,
      fill: item.fill || 'FFFFFF',
      lineColor: item.border || 'DCE2DE',
      lineWidth: 0.9
    });
    elements.push({
      type: 'text', text: item.title || String(item),
      x: nodeX + 0.12, y: y + 0.2, w: nodeWidth - 0.24, h: 0.32,
      fontSize: options.titleSize || 15, bold: true,
      color: item.color || '183B3A', align: 'center'
    });
    if (item.description) {
      elements.push({
        type: 'text', text: item.description,
        x: nodeX + 0.12, y: y + 0.58, w: nodeWidth - 0.24, h: nodeHeight - 0.68,
        fontSize: options.bodySize || 10, color: '6B7470',
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
        color: options.connectorColor || 'D36B45',
        width: 1.5,
        endArrowType: 'triangle'
      });
    }
  });
  return elements;
}

function timeline(items, options = {}) {
  const points = Array.isArray(items) ? items : [];
  const x = options.x === undefined ? 1.0 : options.x;
  const y = options.y === undefined ? 2.4 : options.y;
  const w = options.w === undefined ? 11.2 : options.w;
  const spacing = points.length > 1 ? w / (points.length - 1) : 0;
  const elements = [];
  if (points.length > 1) {
    elements.push({
      type: 'line', x, y: y + 0.12, w, h: 0,
      color: options.lineColor || 'DCE2DE', width: 2
    });
  }
  points.forEach((point, index) => {
    const pointX = x + spacing * index;
    elements.push({
      type: 'shape', shape: 'ellipse',
      x: pointX - 0.11, y, w: 0.22, h: 0.22,
      fill: point.color || options.accent || 'D36B45',
      line: false
    });
    elements.push({
      type: 'text', text: point.date || '',
      x: pointX - 0.65, y: y + 0.42, w: 1.3, h: 0.25,
      fontSize: 10, bold: true, color: '6B7470', align: 'center'
    });
    elements.push({
      type: 'text', text: point.title || '',
      x: pointX - 0.85, y: y + 0.78, w: 1.7, h: 0.48,
      fontSize: 14, bold: true, color: '183B3A', align: 'center'
    });
    if (point.description) {
      elements.push({
        type: 'text', text: point.description,
        x: pointX - 0.9, y: y + 1.34, w: 1.8, h: 0.75,
        fontSize: 10, color: '6B7470', align: 'center', valign: 'top'
      });
    }
  });
  return elements;
}

module.exports = { processFlow, timeline };
