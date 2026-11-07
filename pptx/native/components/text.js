'use strict';

const { resolveTheme } = require('../themes/design_system');

function title(text, options = {}) {
  const theme = resolveTheme(options.theme);
  return {
    type: 'text', text,
    x: options.x === undefined ? theme.layouts.pageMarginX : options.x,
    y: options.y === undefined ? 0.62 : options.y,
    w: options.w === undefined ? 11.9 : options.w,
    h: options.h === undefined ? 0.62 : options.h,
    fontFace: options.fontFace || theme.fonts.heading,
    fontSize: options.fontSize || theme.sizes.title,
    bold: options.bold === undefined ? true : options.bold,
    color: options.color || theme.colors.primary,
    align: options.align || 'left',
    valign: 'mid',
    margin: 0,
    charSpacing: options.charSpacing === undefined ? theme.typography.titleTracking : options.charSpacing
  };
}

function paragraph(text, options = {}) {
  const theme = resolveTheme(options.theme);
  return {
    type: 'text', text,
    x: options.x === undefined ? theme.layouts.pageMarginX : options.x,
    y: options.y === undefined ? 1.55 : options.y,
    w: options.w === undefined ? 11.85 : options.w,
    h: options.h,
    fontFace: options.fontFace || theme.fonts.body,
    fontSize: options.fontSize || theme.sizes.body,
    color: options.color || theme.colors.foreground,
    bold: options.bold === undefined ? ['bold', '600', '700', '800', '900'].includes(String(theme.typography.bodyWeight).toLowerCase()) : !!options.bold,
    align: options.align || 'left',
    valign: options.valign || 'top',
    margin: options.margin === undefined ? 0.02 : options.margin,
    charSpacing: options.charSpacing === undefined ? theme.typography.bodyTracking : options.charSpacing
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

module.exports = { title, paragraph, divider };
