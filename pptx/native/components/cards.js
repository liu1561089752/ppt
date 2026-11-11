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
  // Measured with the line spacing the layout will draw with: a theme that loosens leading
  // (`lineSpacingMultiple: 1.3` in every colour preset) needs more room than the 1.18 default the
  // estimate falls back to, and a 34 pt value in a "0.58 in" box overflowed by 0.04 in.
  const measure = { lineHeight: theme.typography?.lineSpacingMultiple || theme.lineSpacingMultiple };
  const labelHeight = Math.max(0.25, estimateTextHeight(label, innerWidth, theme.sizes.caption, measure));
  const valueHeight = Math.max(0.58, estimateTextHeight(value, innerWidth, valueSize, measure));
  const noteHeight = note === null ? 0 : Math.max(0.24, estimateTextHeight(note, innerWidth, 9, measure));
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
      fontSize: valueSize, bold: true, color, fontFace: options.valueFontFace || theme.fonts.numeric || theme.fonts.heading },
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

/**
 * A bento grid: cards of differing span, laid out on an integer grid.
 *
 * The original HTML skill's layout catalogue named "bento grid" and got it from CSS grid for free.
 * Natively there is no grid, so every deck that wanted one placed its own cards and redid the
 * arithmetic - which is how two decks end up with different gutters and a ragged right edge. This is
 * that arithmetic, once, with the rows tracked so a 2-row card pushes the next one down instead of
 * overlapping it.
 *
 * `items`: `[{ title, body, kicker, columns: 1..4, rows: 1..3, fill, titleColor, bodyColor }]`
 * Placement is row-major: each item takes the first free slot where its span fits.
 */
function bento(options = {}) {
  const theme = resolveTheme(options.theme);
  const items = Array.isArray(options.items) ? options.items : [];
  const columns = Math.max(1, Math.min(4, options.columns || 3));
  const gap = Number.isFinite(options.gap) ? options.gap : theme.layouts.columnGap;
  // `rowHeight` is a MINIMUM now, not the height. It used to be the height, so a row of two-line
  // cards was 1.9 in tall whatever was in it: every bento page in every deck came out with cells
  // half full of air. Rows grow to fit their tallest cell, then the grid stays aligned.
  const minimumRowHeight = Number.isFinite(options.rowHeight) ? options.rowHeight : 1.4;
  const x0 = Number.isFinite(options.x) ? options.x : theme.layouts.pageMarginX;
  const totalWidth = Number.isFinite(options.w) ? options.w : 13.333 - x0 * 2;
  const y0 = Number.isFinite(options.y) ? options.y : 1.75;
  const cellWidth = (totalWidth - gap * (columns - 1)) / columns;
  const inset = theme.spacing.md;
  const lineHeight = theme.typography?.lineSpacingMultiple || theme.lineSpacingMultiple || 1.22;
  const measure = (value, width, size) =>
    estimateTextHeight(String(value), width, size, { lineHeight, safetyFactor: 0.9 });
  const padding = { top: 0.17, bottom: inset * 0.75, kicker: 0.05, title: 0.06 };

  const occupied = [];
  const isFree = (row, column, spanColumns, spanRows) => {
    for (let r = row; r < row + spanRows; r += 1) {
      const cells = occupied[r];
      if (!cells) continue;
      for (let c = column; c < column + spanColumns; c += 1) if (cells.has(c)) return false;
    }
    return true;
  };
  const take = (row, column, spanColumns, spanRows) => {
    for (let r = row; r < row + spanRows; r += 1) {
      if (!occupied[r]) occupied[r] = new Set();
      for (let c = column; c < column + spanColumns; c += 1) occupied[r].add(c);
    }
  };

  // First pass: place every cell on the grid and work out how tall its own copy is.
  const placed = items.map((item) => {
    const spanColumns = Math.max(1, Math.min(columns, item.columns || 1));
    const spanRows = Math.max(1, Math.min(3, item.rows || 1));
    let row = 0;
    let column = 0;
    let free = false;
    while (!free) {
      for (column = 0; column + spanColumns <= columns; column += 1) {
        if (isFree(row, column, spanColumns, spanRows)) { free = true; break; }
      }
      if (!free) row += 1;
    }
    take(row, column, spanColumns, spanRows);
    const width = cellWidth * spanColumns + gap * (spanColumns - 1);
    const innerWidth = width - inset * 2;
    let needed = padding.top + padding.bottom;
    if (item.kicker) needed += measure(item.kicker, innerWidth, theme.sizes.caption) + padding.kicker;
    if (item.title !== undefined && item.title !== null) {
      needed += measure(item.title, innerWidth, item.titleSize || theme.sizes.heading) + padding.title;
    }
    if (item.body !== undefined && item.body !== null) {
      needed += measure(item.body, innerWidth, item.bodySize || theme.sizes.body);
    }
    return { item, row, column, spanColumns, spanRows, width, innerWidth, needed };
  });

  // Second pass: every row is at least the minimum and at least its tallest single-row cell; a cell
  // that spans rows then stretches the rows it covers until it fits.
  const rowCount = placed.reduce((total, cell) => Math.max(total, cell.row + cell.spanRows), 0);
  const rowHeights = new Array(rowCount).fill(minimumRowHeight);
  placed.filter((cell) => cell.spanRows === 1).forEach((cell) => {
    rowHeights[cell.row] = Math.max(rowHeights[cell.row], cell.needed);
  });
  placed.filter((cell) => cell.spanRows > 1).forEach((cell) => {
    const rows = [];
    for (let r = cell.row; r < cell.row + cell.spanRows; r += 1) rows.push(r);
    const current = () => rows.reduce((total, r) => total + rowHeights[r], 0) + gap * (rows.length - 1);
    const deficit = cell.needed - current();
    if (deficit > 0) rows.forEach((r) => { rowHeights[r] += deficit / rows.length; });
  });

  const rowY = [];
  let cursor = y0;
  for (let r = 0; r < rowCount; r += 1) {
    rowY[r] = cursor;
    cursor += rowHeights[r] + gap;
  }

  const elements = [];
  placed.forEach((cell) => {
    const item = cell.item;
    const x = x0 + cell.column * (cellWidth + gap);
    const y = rowY[cell.row];
    let h = gap * (cell.spanRows - 1);
    for (let r = cell.row; r < cell.row + cell.spanRows; r += 1) h += rowHeights[r];
    elements.push({
      type: 'shape', x, y, w: cell.width, h, radius: theme.radii.medium,
      fill: item.fill || theme.colors.surface,
      lineColor: item.border || theme.colors.border,
      lineWidth: theme.effects.cardBorder ? 0.8 : 0
    });
    let textCursor = y + padding.top;
    if (item.kicker) {
      const kickerHeight = measure(item.kicker, cell.innerWidth, theme.sizes.caption);
      elements.push({
        type: 'text', text: String(item.kicker), x: x + inset, y: textCursor, w: cell.innerWidth, h: kickerHeight,
        fontSize: theme.sizes.caption, bold: true, charSpacing: 1.4,
        color: item.kickerColor || theme.colors.accent
      });
      textCursor += kickerHeight + padding.kicker;
    }
    if (item.title !== undefined && item.title !== null) {
      const titleSize = item.titleSize || theme.sizes.heading;
      const titleHeight = measure(item.title, cell.innerWidth, titleSize);
      elements.push({
        type: 'text', text: String(item.title), x: x + inset, y: textCursor, w: cell.innerWidth, h: titleHeight,
        fontSize: titleSize, bold: true, color: item.titleColor || theme.colors.primary
      });
      textCursor += titleHeight + padding.title;
    }
    if (item.body !== undefined && item.body !== null) {
      const bodySize = item.bodySize || theme.sizes.body;
      elements.push({
        type: 'text', text: String(item.body), x: x + inset, y: textCursor, w: cell.innerWidth,
        h: Math.max(0.3, y + h - padding.bottom - textCursor),
        fontSize: bodySize, color: item.bodyColor || theme.colors.foreground, valign: 'top'
      });
    }
  });
  return elements;
}

module.exports = { kpiCard, infoCard, bento };
