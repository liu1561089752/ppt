'use strict';

const { resolveTheme } = require('../themes/design_system');
const { estimateTextHeight } = require('../engine/text_measure');

function kpiCard(options = {}) {
  const theme = resolveTheme(options.theme);
  const x = options.x === undefined ? 0.75 : options.x;
  const y = options.y === undefined ? 2.0 : options.y;
  const w = options.w === undefined ? 2.85 : options.w;
  const h = options.h === undefined ? 1.72 : options.h;
  const color = options.color || theme.colors.primary;
  const inset = theme.spacing.md;
  const innerWidth = w - inset * 2;
  const valueSize = options.valueSize || 28;
  const label = options.label || '指标';
  const value = options.value === undefined ? '—' : String(options.value);
  const note = options.note === undefined || options.note === null ? null : String(options.note);
  // Three boxes stacked, each as tall as its own text. A fixed 0.25in label held two lines of
  // caption at 10pt and clipped the third; a note box pinned to the card's bottom had the same
  // problem. Both were invisible until a stress deck wrote longer labels than the fixtures did.
  const labelHeight = Math.max(0.25, estimateTextHeight(label, innerWidth, theme.sizes.caption));
  const valueHeight = Math.max(0.58, estimateTextHeight(value, innerWidth, valueSize));
  const noteHeight = note === null ? 0 : Math.max(0.24, estimateTextHeight(note, innerWidth, 9));
  const labelY = y + 0.16;
  const valueY = labelY + labelHeight + 0.06;
  // The note keeps its place at the bottom of the card when the content fits above it, which is
  // what every fixture expects; when the text is taller than the card it stacks instead of
  // escaping through the border.
  const pinnedNoteY = y + h - noteHeight - 0.16;
  const noteY = Math.max(pinnedNoteY, valueY + valueHeight + 0.06);
  return [
    { type: 'shape', x, y, w, h, radius: theme.radii.medium, fill: options.fill || theme.colors.surface,
      lineColor: options.border || theme.colors.border, lineWidth: theme.effects.cardBorder ? 0.8 : 0 },
    { type: 'text', text: label, x: x + inset, y: labelY, w: innerWidth, h: labelHeight,
      fontSize: theme.sizes.caption, color: options.muted || theme.colors.muted, fontFace: options.fontFace || theme.fonts.body },
    { type: 'text', text: value, x: x + inset, y: valueY, w: innerWidth, h: valueHeight,
      fontSize: valueSize, bold: true, color, fontFace: options.valueFontFace || theme.fonts.heading },
    ...(note === null ? [] : [{ type: 'text', text: note, x: x + inset, y: noteY, w: innerWidth, h: noteHeight,
      fontSize: 9, color: options.muted || theme.colors.muted }])
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
