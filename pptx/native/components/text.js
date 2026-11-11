'use strict';

const { resolveTheme } = require('../themes/design_system');
const { estimateTextHeight } = require('../engine/text_measure');

/**
 * The height this text will actually need, measured the way engine/layout.js measures it.
 *
 * `title()` used to hand back a flat 0.62 in box. A title long enough to wrap to two lines then
 * overflowed its own box - which is exactly what happened to a 20 pt heading reading
 * "内蒙古阿拉善 200MW/800MWh" in a 4.4 in column, and `--strict` refused the deck for it. A component
 * that invents a box has to invent the right one; omit `h` and this is what it uses.
 */
function measuredHeight(value, widthIn, fontSize, theme, options = {}) {
  const lineHeight = options.lineSpacingMultiple
    || theme.typography?.lineSpacingMultiple || theme.lineSpacingMultiple || 1.22;
  const measure = { lineHeight, safetyFactor: 0.9 };
  if (Number.isFinite(options.charSpacing) && options.charSpacing !== 0) measure.letterSpacingPt = options.charSpacing;
  return estimateTextHeight(String(value), widthIn, fontSize, measure);
}

function title(text, options = {}) {
  const theme = resolveTheme(options.theme);
  const boxWidth = options.w === undefined ? 11.9 : options.w;
  const fontSize = options.fontSize || theme.sizes.title;
  const tracking = options.charSpacing === undefined ? theme.typography.titleTracking : options.charSpacing;
  return {
    type: 'text', role: 'title', text,
    x: options.x === undefined ? theme.layouts.pageMarginX : options.x,
    y: options.y === undefined ? 0.62 : options.y,
    w: boxWidth,
    h: options.h === undefined ? measuredHeight(text, boxWidth, fontSize, theme, { charSpacing: tracking }) : options.h,
    fontFace: options.fontFace || theme.fonts.heading,
    fontSize,
    bold: options.bold === undefined
      ? ['bold', 'bolder', '600', '700', '800', '900'].includes(String(theme.typography.titleWeight).toLowerCase())
        || Number(theme.typography.titleWeight) >= 600
      : options.bold,
    italic: !!options.italic,
    underline: !!options.underline,
    strike: !!options.strike,
    color: options.color || theme.colors.primary,
    align: options.align || 'left',
    valign: 'mid',
    margin: 0,
    charSpacing: tracking,
    lineSpacingMultiple: options.lineSpacingMultiple === undefined ? theme.typography.lineSpacingMultiple : options.lineSpacingMultiple,
    paraSpaceAfterPt: options.paraSpaceAfterPt,
    transparency: options.transparency
  };
}

function paragraph(text, options = {}) {
  const theme = resolveTheme(options.theme);
  return {
    type: 'text', role: 'body', text,
    x: options.x === undefined ? theme.layouts.pageMarginX : options.x,
    y: options.y === undefined ? 1.55 : options.y,
    w: options.w === undefined ? 11.85 : options.w,
    h: options.h,
    fontFace: options.fontFace || theme.fonts.body,
    fontSize: options.fontSize || theme.sizes.body,
    color: options.color || theme.colors.foreground,
    bold: options.bold === undefined ? ['bold', '600', '700', '800', '900'].includes(String(theme.typography.bodyWeight).toLowerCase()) : !!options.bold,
    italic: !!options.italic,
    underline: !!options.underline,
    strike: !!options.strike,
    align: options.align || 'left',
    valign: options.valign || 'top',
    margin: options.margin === undefined ? 0.02 : options.margin,
    charSpacing: options.charSpacing === undefined ? theme.typography.bodyTracking : options.charSpacing,
    lineSpacingMultiple: options.lineSpacingMultiple,
    paraSpaceAfterPt: options.paraSpaceAfterPt,
    transparency: options.transparency
  };
}

function divider(options = {}) {
  const theme = resolveTheme(options.theme);
  return {
    type: 'line',
    x: options.x === undefined ? theme.layouts.pageMarginX : options.x,
    y: options.y === undefined ? 1.38 : options.y,
    w: options.w === undefined ? 11.85 : options.w,
    h: 0,
    color: options.color || theme.colors.accent,
    width: options.width || 1.4
  };
}

module.exports = { title, paragraph, divider, measuredHeight };
