'use strict';

const { resolveTheme } = require('../themes/design_system');

function kpiCard(options = {}) {
  const theme = resolveTheme(options.theme);
  const x = options.x === undefined ? 0.75 : options.x;
  const y = options.y === undefined ? 2.0 : options.y;
  const w = options.w === undefined ? 2.85 : options.w;
  const h = options.h === undefined ? 1.72 : options.h;
  const color = options.color || theme.colors.primary;
  const inset = theme.spacing.md;
  return [
    { type: 'shape', x, y, w, h, radius: theme.radii.medium, fill: options.fill || theme.colors.surface,
      lineColor: options.border || theme.colors.border, lineWidth: theme.effects.cardBorder ? 0.8 : 0 },
    { type: 'text', text: options.label || '指标', x: x + inset, y: y + 0.16, w: w - inset * 2, h: 0.25,
      fontSize: theme.sizes.caption, color: options.muted || theme.colors.muted, fontFace: options.fontFace || theme.fonts.body },
    { type: 'text', text: options.value === undefined ? '—' : String(options.value), x: x + inset, y: y + 0.5,
      w: w - inset * 2, h: 0.58, fontSize: options.valueSize || 28, bold: true, color,
      fontFace: options.valueFontFace || theme.fonts.heading },
    ...(options.note ? [{ type: 'text', text: options.note, x: x + inset, y: y + h - 0.42,
      w: w - inset * 2, h: 0.24, fontSize: 9, color: options.muted || theme.colors.muted }] : [])
  ];
}

function infoCard(options = {}) {
  const theme = resolveTheme(options.theme);
  const x = options.x === undefined ? 0.75 : options.x;
  const y = options.y === undefined ? 2.0 : options.y;
  const w = options.w === undefined ? 3.7 : options.w;
  const h = options.h === undefined ? 2.0 : options.h;
  const inset = theme.spacing.md;
  return [
    { type: 'shape', x, y, w, h, radius: theme.radii.medium, fill: options.fill || theme.colors.surface,
      lineColor: options.border || theme.colors.border, lineWidth: theme.effects.cardBorder ? 0.8 : 0 },
    { type: 'text', text: options.title || '', x: x + inset, y: y + 0.18, w: w - inset * 2, h: 0.52,
      fontSize: options.titleSize || theme.sizes.heading, bold: true, color: options.titleColor || theme.colors.primary },
    { type: 'text', text: options.body || '', x: x + inset, y: y + 0.82, w: w - inset * 2, h: h - 1.0,
      fontSize: options.bodySize || theme.sizes.body, color: options.bodyColor || theme.colors.foreground, valign: 'top' }
  ];
}

module.exports = { kpiCard, infoCard };
