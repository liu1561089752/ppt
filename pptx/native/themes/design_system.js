'use strict';

const defaults = require('./default');

function mergeObject(base, override) {
  const result = Object.assign({}, base || {});
  Object.keys(override || {}).forEach((key) => {
    const value = override[key];
    if (value && typeof value === 'object' && !Array.isArray(value)) {
      result[key] = mergeObject(result[key], value);
    } else if (value !== undefined && value !== null) {
      result[key] = value;
    }
  });
  return result;
}

function resolveTheme(input = {}) {
  const source = input && typeof input === 'object' ? input : {};
  const merged = mergeObject(defaults, source);
  merged.colors = mergeObject(defaults.colors, source.colors);
  merged.fonts = mergeObject(defaults.fonts, source.fonts);
  merged.sizes = mergeObject(defaults.sizes, source.sizes);
  merged.spacing = mergeObject({
    xs: 0.08, sm: 0.16, md: 0.24, lg: 0.36, xl: 0.56, pageX: 0.72, pageY: 0.52
  }, source.spacing);
  merged.radii = mergeObject({ small: 0.06, medium: 0.12, large: 0.2 }, source.radii);
  merged.typography = mergeObject({
    titleWeight: 'bold', headingWeight: 'bold', bodyWeight: 'normal',
    lineSpacingMultiple: merged.lineSpacingMultiple || 1.18,
    titleTracking: 0, bodyTracking: 0
  }, source.typography);
  merged.effects = mergeObject({
    cardBorder: true, softShadow: false, accentRule: true
  }, source.effects);
  merged.layouts = mergeObject({
    pageMarginX: source.margins?.x ?? source.spacing?.pageX ?? source.spacing?.xl ?? (merged.margins && merged.margins.x) ?? 0.72,
    pageMarginY: source.margins?.y ?? source.spacing?.pageY ?? (merged.margins && merged.margins.y) ?? 0.52,
    columnGap: source.spacing?.lg ?? 0.28, sectionGap: source.spacing?.xl ?? 0.34
  }, source.layouts);
  return merged;
}

function themeColor(theme, name, fallback) {
  const resolved = resolveTheme(theme);
  return String(resolved.colors[name] || fallback || resolved.colors.foreground).replace(/^#/, '').toUpperCase();
}

function relativeLuminance(hex) {
  const clean = String(hex || '').replace(/^#/u, '');
  const channels = [0, 2, 4].map((offset) => parseInt(clean.slice(offset, offset + 2), 16) / 255);
  const linear = channels.map((value) => (value <= 0.03928
    ? value / 12.92
    : Math.pow((value + 0.055) / 1.055, 2.4)));
  return 0.2126 * linear[0] + 0.7152 * linear[1] + 0.0722 * linear[2];
}

/**
 * WCAG 2.1 contrast ratio between two colours given as hex (with or without `#`).
 *
 * A template that paints a colour field has to choose its ink at runtime, and `options.titleColor ||
 * white` is how a dark title ends up on a dark field. This is the measurement the skill tells a writer
 * to make by hand, in one line.
 */
function contrastRatio(a, b) {
  const first = relativeLuminance(a);
  const second = relativeLuminance(b);
  const lighter = Math.max(first, second);
  const darker = Math.min(first, second);
  return (lighter + 0.05) / (darker + 0.05);
}

module.exports = { resolveTheme, themeColor, mergeObject, contrastRatio };
