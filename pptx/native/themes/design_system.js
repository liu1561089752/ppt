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
    pageMarginX: merged.margins && merged.margins.x || 0.72,
    pageMarginY: merged.margins && merged.margins.y || 0.52,
    columnGap: 0.28, sectionGap: 0.34
  }, source.layouts);
  return merged;
}

function themeColor(theme, name, fallback) {
  const resolved = resolveTheme(theme);
  return String(resolved.colors[name] || fallback || resolved.colors.foreground).replace(/^#/, '').toUpperCase();
}

module.exports = { resolveTheme, themeColor, mergeObject };
