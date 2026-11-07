'use strict';

function kpiCard(options = {}) {
  const x = options.x === undefined ? 0.75 : options.x;
  const y = options.y === undefined ? 2.0 : options.y;
  const w = options.w === undefined ? 2.85 : options.w;
  const h = options.h === undefined ? 1.72 : options.h;
  const color = options.color || '183B3A';
  return [
    { type: 'shape', x, y, w, h, fill: options.fill || 'FFFFFF', lineColor: options.border || 'DCE2DE', lineWidth: 0.8 },
    { type: 'text', text: options.label || '指标', x: x + 0.18, y: y + 0.16, w: w - 0.36, h: 0.25, fontSize: 10, color: options.muted || '6B7470', fontFace: options.fontFace || 'Aptos' },
    { type: 'text', text: options.value === undefined ? '—' : String(options.value), x: x + 0.18, y: y + 0.5, w: w - 0.36, h: 0.58, fontSize: options.valueSize || 28, bold: true, color, fontFace: options.valueFontFace || 'Aptos Display' },
    ...(options.note ? [{ type: 'text', text: options.note, x: x + 0.18, y: y + h - 0.42, w: w - 0.36, h: 0.24, fontSize: 9, color: options.muted || '6B7470' }] : [])
  ];
}

function infoCard(options = {}) {
  const x = options.x === undefined ? 0.75 : options.x;
  const y = options.y === undefined ? 2.0 : options.y;
  const w = options.w === undefined ? 3.7 : options.w;
  const h = options.h === undefined ? 2.0 : options.h;
  return [
    { type: 'shape', x, y, w, h, fill: options.fill || 'FFFFFF', lineColor: options.border || 'DCE2DE', lineWidth: 0.8 },
    { type: 'text', text: options.title || '', x: x + 0.2, y: y + 0.18, w: w - 0.4, h: 0.42, fontSize: options.titleSize || 18, bold: true, color: options.titleColor || '183B3A' },
    { type: 'text', text: options.body || '', x: x + 0.2, y: y + 0.72, w: w - 0.4, h: h - 0.9, fontSize: options.bodySize || 13, color: options.bodyColor || '394541', valign: 'top' }
  ];
}

module.exports = { kpiCard, infoCard };
