'use strict';

/**
 * A deliberately small CSS subset for the HTML → Native pipeline.
 *
 * Supported: type/class/id selectors (with descendant and child combinators
 * treated alike), simple compound selectors, CSS custom properties via `var()`,
 * inline styles, and a declared-value cascade with specificity.
 *
 * Not supported (recorded as unsupported by the analyzer): @media queries,
 * pseudo-elements, attribute selectors, `:not()`, sibling combinators, shorthands
 * outside the handled set, animations, transforms, filters, blend modes.
 */

const NAMED_COLORS = {
  transparent: null,
  white: 'FFFFFF', black: '000000', silver: 'C0C0C0', gray: '808080', grey: '808080',
  red: 'FF0000', maroon: '800000', orange: 'FFA500', yellow: 'FFFF00', olive: '808000',
  lime: '00FF00', green: '008000', teal: '008080', aqua: '00FFFF', cyan: '00FFFF',
  blue: '0000FF', navy: '000080', fuchsia: 'FF00FF', magenta: 'FF00FF', purple: '800080',
  brown: 'A52A2A', pink: 'FFC0CB', gold: 'FFD700', beige: 'F5F5DC', ivory: 'FFFFF0',
  whitesmoke: 'F5F5F5', gainsboro: 'DCDCDC', darkgray: 'A9A9A9', darkgrey: 'A9A9A9',
  lightgray: 'D3D3D3', lightgrey: 'D3D3D3', dimgray: '696969', dimgrey: '696969',
  slategray: '708090', slategrey: '708090', charcoal: '333333', cream: 'FFFDD0'
};

const INHERITED_PROPERTIES = new Set([
  'color', 'fontFamily', 'fontSize', 'fontWeight', 'fontStyle', 'lineHeight',
  'letterSpacing', 'textAlign', 'textTransform', 'fontVariant', 'visibility'
]);

const AXIS_RELATIVE = new Set(['left', 'right', 'width', 'marginLeft', 'marginRight', 'paddingLeft', 'paddingRight']);
const VERTICAL_RELATIVE = new Set(['top', 'bottom', 'height', 'marginTop', 'marginBottom', 'paddingTop', 'paddingBottom']);

function camelCase(property) {
  if (property.startsWith('--')) return property;
  return property.replace(/-([a-z])/gu, (_, letter) => letter.toUpperCase());
}

function parseDeclarations(text) {
  const declarations = [];
  String(text || '').split(';').forEach((chunk) => {
    const colon = chunk.indexOf(':');
    if (colon === -1) return;
    const property = chunk.slice(0, colon).trim().toLowerCase();
    const value = chunk.slice(colon + 1).trim();
    if (!property || !value) return;
    declarations.push({ property, value });
  });
  return declarations;
}

function stripComments(css) {
  return String(css || '').replace(/\/\*[\s\S]*?\*\//gu, '');
}

/** Parse a stylesheet into ordered rules plus a global custom-property map. */
function parseStylesheet(cssText) {
  const css = stripComments(cssText);
  const rules = [];
  const variables = Object.create(null);
  const pseudoSelectors = [];
  let index = 0;
  let order = 0;

  while (index < css.length) {
    const open = css.indexOf('{', index);
    if (open === -1) break;
    const selectorText = css.slice(index, open).trim();
    let depth = 1;
    let scan = open + 1;
    while (scan < css.length && depth > 0) {
      if (css[scan] === '{') depth += 1;
      else if (css[scan] === '}') depth -= 1;
      scan += 1;
    }
    const body = css.slice(open + 1, scan - 1);
    index = scan;

    if (selectorText.startsWith('@')) {
      // At-rules are not modeled; keep any custom properties they declare at the root.
      if (/@(media|supports|layer)/u.test(selectorText)) parseDeclarations(body).forEach((declaration) => {
        if (declaration.property.startsWith('--')) variables[declaration.property] = declaration.value;
      });
      continue;
    }

    const declarations = parseDeclarations(body);
    declarations.forEach((declaration) => {
      if (declaration.property.startsWith('--')) variables[declaration.property] = declaration.value;
    });

    selectorText.split(',').forEach((rawSelector) => {
      const parsed = parseSelector(rawSelector);
      if (!parsed) return;
      if (parsed.pseudo) {
        // A pseudo rule describes a box the DOM does not contain, so letting it
        // match the element itself would deform the real element.
        pseudoSelectors.push(rawSelector.trim());
        return;
      }
      rules.push({
        selectorText: rawSelector.trim(),
        parts: parsed.parts,
        declarations,
        order: order++,
        specificity: parsed.specificity
      });
    });
  }
  return { rules, variables, pseudoSelectors };
}

function parseSimpleSelector(segment) {
  const simple = { tag: null, id: null, classes: [] };
  let rest = segment;
  const tagMatch = /^(\*|[a-zA-Z][\w-]*)/u.exec(rest);
  if (tagMatch) {
    simple.tag = tagMatch[1] === '*' ? null : tagMatch[1].toLowerCase();
    rest = rest.slice(tagMatch[1].length);
  }
  const pattern = /([.#])([\w-]+)/gu;
  let match = pattern.exec(rest);
  while (match) {
    if (match[1] === '#') simple.id = match[2];
    else simple.classes.push(match[2]);
    match = pattern.exec(rest);
  }
  return simple;
}

/**
 * Parse a selector into right-to-left parts. `>` and `+`/`~` collapse to a
 * descendant relationship, which over-matches slightly but never under-matches.
 */
function parseSelector(rawSelector) {
  const raw = String(rawSelector || '');
  const pseudo = /::?[\w-]+/u.test(raw);
  const cleaned = raw
    .replace(/::[\w-]+(\([^)]*\))?/gu, '')
    .replace(/:[\w-]+(\([^)]*\))?/gu, '')
    .trim();
  if (!cleaned) return null;
  const segments = cleaned.split(/\s*[>+~]\s*|\s+/u).filter(Boolean);
  if (!segments.length) return null;
  const parts = segments.map(parseSimpleSelector).reverse();
  const specificity = parts.reduce((accumulator, part) => ({
    ids: accumulator.ids + (part.id ? 1 : 0),
    classes: accumulator.classes + part.classes.length,
    tags: accumulator.tags + (part.tag ? 1 : 0)
  }), { ids: 0, classes: 0, tags: 0 });
  return { parts, specificity, pseudo };
}

function matchesSimple(node, simple) {
  if (!node || node.type !== 'element') return false;
  if (simple.tag && node.tag !== simple.tag) return false;
  if (simple.id && node.attrs.id !== simple.id) return false;
  if (simple.classes.length) {
    const classes = String(node.attrs.class || '').split(/\s+/u);
    if (!simple.classes.every((name) => classes.includes(name))) return false;
  }
  return true;
}

function matchesSelector(node, selector) {
  const parts = selector.parts;
  if (!matchesSimple(node, parts[0])) return false;
  let remaining = 1;
  let ancestor = node.parent;
  while (remaining < parts.length) {
    let found = false;
    while (ancestor) {
      if (matchesSimple(ancestor, parts[remaining])) {
        found = true;
        ancestor = ancestor.parent;
        break;
      }
      ancestor = ancestor.parent;
    }
    if (!found) return false;
    remaining += 1;
  }
  return true;
}

function compareSpecificity(a, b) {
  if (a.specificity.ids !== b.specificity.ids) return a.specificity.ids - b.specificity.ids;
  if (a.specificity.classes !== b.specificity.classes) return a.specificity.classes - b.specificity.classes;
  if (a.specificity.tags !== b.specificity.tags) return a.specificity.tags - b.specificity.tags;
  return a.order - b.order;
}

function expandVariables(value, variables, depth = 0) {
  if (depth > 8 || typeof value !== 'string' || !value.includes('var(')) return value;
  const replaced = value.replace(/var\(\s*(--[\w-]+)\s*(?:,\s*([^()]*))?\)/gu, (whole, name, fallback) => {
    const resolved = variables[name];
    if (resolved !== undefined) return resolved;
    return fallback === undefined ? whole : fallback.trim();
  });
  return replaced === value ? value : expandVariables(replaced, variables, depth + 1);
}

function expandBoxShorthand(value) {
  const parts = String(value || '').trim().split(/\s+/u);
  if (parts.length === 1) return [parts[0], parts[0], parts[0], parts[0]];
  if (parts.length === 2) return [parts[0], parts[1], parts[0], parts[1]];
  if (parts.length === 3) return [parts[0], parts[1], parts[2], parts[1]];
  return [parts[0], parts[1], parts[2], parts[3]];
}

function applyDeclarations(style, declarations, variables) {
  declarations.forEach(({ property, value }) => {
    const resolvedValue = expandVariables(value, variables);
    if (property.startsWith('--')) {
      style[property] = resolvedValue;
      return;
    }
    if (property === 'padding' || property === 'margin') {
      const [top, right, bottom, left] = expandBoxShorthand(resolvedValue);
      const suffix = property === 'padding' ? 'padding' : 'margin';
      style[suffix + 'Top'] = top;
      style[suffix + 'Right'] = right;
      style[suffix + 'Bottom'] = bottom;
      style[suffix + 'Left'] = left;
      return;
    }
    if (property === 'border-radius') {
      const [topLeft, topRight, bottomRight, bottomLeft] = expandBoxShorthand(resolvedValue);
      style.borderTopLeftRadius = topLeft;
      style.borderTopRightRadius = topRight;
      style.borderBottomRightRadius = bottomRight;
      style.borderBottomLeftRadius = bottomLeft;
      style.borderRadius = topLeft;
      return;
    }
    style[camelCase(property)] = resolvedValue;
  });
  return style;
}

/** Resolve the declared (not yet unit-converted) style of a node. */
function createStyleResolver(stylesheet) {
  const cache = new WeakMap();
  const { rules, variables } = stylesheet;

  function declared(node) {
    if (cache.has(node)) return cache.get(node);
    const matched = rules.filter((rule) => matchesSelector(node, rule)).sort(compareSpecificity);
    const style = Object.create(null);
    matched.forEach((rule) => applyDeclarations(style, rule.declarations, variables));
    if (node.attrs && node.attrs.style) {
      applyDeclarations(style, parseDeclarations(node.attrs.style.replace(/&quot;/gu, '"')), variables);
    }
    cache.set(node, style);
    return style;
  }

  /** Declared style merged with inherited typography from ancestors. */
  function computed(node) {
    const own = declared(node);
    const result = Object.create(null);
    let ancestor = node.parent;
    const inheritedChain = [];
    while (ancestor && ancestor.type === 'element') {
      inheritedChain.unshift(declared(ancestor));
      ancestor = ancestor.parent;
    }
    inheritedChain.forEach((parentStyle) => {
      Object.keys(parentStyle).forEach((property) => {
        if (INHERITED_PROPERTIES.has(property)) result[property] = parentStyle[property];
      });
    });
    Object.keys(own).forEach((property) => { result[property] = own[property]; });
    return result;
  }

  return { declared, computed, variables, rules };
}

function parseLength(value) {
  if (value === undefined || value === null) return null;
  const text = String(value).trim();
  if (!text || text === 'auto' || text === 'none' || text === 'initial' || text === 'inherit') return null;
  const match = /^(-?[\d.]+)\s*(px|pt|in|cm|mm|em|rem|%|)$/u.exec(text);
  if (!match) return null;
  const magnitude = Number(match[1]);
  if (!Number.isFinite(magnitude)) return null;
  return { value: magnitude, unit: match[2] === undefined ? 'px' : match[2] };
}

function toInches(length, context = {}) {
  if (!length) return null;
  const { value, unit } = length;
  switch (unit) {
    case 'in': return value;
    case 'pt': return value / 72;
    case 'cm': return value / 2.54;
    case 'mm': return value / 25.4;
    case '':
    case 'px': return value / 96;
    case 'em': return (value * (context.fontSizePx || 16)) / 96;
    case 'rem': return (value * (context.rootFontSizePx || 16)) / 96;
    case '%': {
      const base = context.percentBase;
      if (base === null || base === undefined) return null;
      return (value / 100) * base;
    }
    default: return null;
  }
}

function dimensionInches(value, axis, context = {}) {
  const length = parseLength(value);
  if (!length) return null;
  const percentBase = axis === 'y' ? context.parentHeight : context.parentWidth;
  return toInches(length, Object.assign({}, context, { percentBase }));
}

function pxToPoints(value, context = {}) {
  const length = parseLength(value);
  if (!length) return null;
  const inches = toInches(length, Object.assign({}, context, {
    percentBase: context.parentWidth
  }));
  return inches === null ? null : Number((inches * 72).toFixed(2));
}

function parseColor(value) {
  if (value === undefined || value === null) return null;
  const text = String(value).trim().toLowerCase();
  if (!text || text === 'none' || text === 'currentcolor') return null;
  if (text === 'transparent' || text === 'rgba(0, 0, 0, 0)' || text === 'rgba(0,0,0,0)') return { hex: null, alpha: 0 };
  if (Object.prototype.hasOwnProperty.call(NAMED_COLORS, text)) {
    const hex = NAMED_COLORS[text];
    return hex === null ? { hex: null, alpha: 0 } : { hex, alpha: 1 };
  }
  const hexMatch = /^#([0-9a-f]{3}|[0-9a-f]{6})$/u.exec(text);
  if (hexMatch) {
    const digits = hexMatch[1];
    if (digits.length === 3) {
      return { hex: digits.split('').map((d) => d + d).join('').toUpperCase(), alpha: 1 };
    }
    return { hex: digits.toUpperCase(), alpha: 1 };
  }
  const rgbMatch = /^rgba?\(\s*([\d.]+%?)\s*[, ]\s*([\d.]+%?)\s*[, ]\s*([\d.]+%?)\s*(?:[,/]\s*([\d.]+%?)\s*)?\)$/u.exec(text);
  if (rgbMatch) {
    const channel = (raw) => {
      const number = raw.endsWith('%') ? (Number(raw.slice(0, -1)) / 100) * 255 : Number(raw);
      return Math.max(0, Math.min(255, Math.round(number)));
    };
    const toHex = (number) => number.toString(16).padStart(2, '0').toUpperCase();
    const alphaRaw = rgbMatch[4];
    let alpha = 1;
    if (alphaRaw !== undefined) {
      alpha = alphaRaw.endsWith('%') ? Number(alphaRaw.slice(0, -1)) / 100 : Number(alphaRaw);
    }
    return {
      hex: toHex(channel(rgbMatch[1])) + toHex(channel(rgbMatch[2])) + toHex(channel(rgbMatch[3])),
      alpha: Math.max(0, Math.min(1, alpha))
    };
  }
  return null;
}

/** Parse a simple two-or-more-stop linear-gradient. Returns null when too complex. */
function parseLinearGradient(value) {
  const match = /linear-gradient\(\s*([^,]*),\s*([\s\S]*)\)$/u.exec(String(value || '').trim());
  if (!match) return null;
  const angleText = match[1].trim().toLowerCase();
  const stopText = match[2];
  const stopParts = [];
  let depth = 0;
  let buffer = '';
  for (const character of stopText) {
    if (character === '(') depth += 1;
    if (character === ')') depth -= 1;
    if (character === ',' && depth === 0) {
      stopParts.push(buffer);
      buffer = '';
    } else {
      buffer += character;
    }
  }
  if (buffer.trim()) stopParts.push(buffer);

  const stops = [];
  for (let index = 0; index < stopParts.length; index += 1) {
    const chunk = stopParts[index].trim();
    if (!chunk) continue;
    const explicit = /^(.*?)\s+(-?[\d.]+)%\s*$/u.exec(chunk);
    const colorText = explicit ? explicit[1].trim() : chunk;
    const color = parseColor(colorText);
    if (!color || !color.hex) return null;
    stops.push({
      color: color.hex,
      transparency: Math.round((1 - color.alpha) * 100),
      position: explicit ? Number(explicit[2]) / 100 : (stops.length === 0 ? 0 : null)
    });
  }
  if (stops.length < 2) return null;
  // Fill in missing positions evenly, always pinning the ends.
  stops.forEach((stop, index) => {
    if (stop.position === null) stop.position = index / (stops.length - 1);
  });
  stops.sort((a, b) => a.position - b.position);

  let angle = 180;
  if (/^-?[\d.]+deg$/u.test(angleText)) angle = Number.parseFloat(angleText);
  else if (angleText === 'to bottom') angle = 180;
  else if (angleText === 'to top') angle = 0;
  else if (angleText === 'to right') angle = 90;
  else if (angleText === 'to left') angle = 270;
  else if (angleText === 'to bottom right') angle = 135;
  else if (angleText === 'to bottom left') angle = 225;
  else if (angleText === 'to top right') angle = 45;
  else if (angleText === 'to top left') angle = 315;

  return { angle, stops };
}

/** Parse a single outer box-shadow. Returns null for lists/inset shadows. */
function parseBoxShadow(value) {
  const text = String(value || '').trim();
  if (!text || text === 'none') return null;
  if (text.includes('inset') || text.split(/,(?![^(]*\))/u).length > 1) return null;
  const tokens = text.match(/(rgba?\([^)]*\)|#[0-9a-f]{3,8}|[a-z]+|-?[\d.]+(?:px|em|rem|pt)?)/gu);
  if (!tokens) return null;
  let color = null;
  const lengths = [];
  tokens.forEach((token) => {
    const parsed = parseColor(token);
    if (parsed) { color = parsed; return; }
    const length = parseLength(token);
    if (length) lengths.push(toInches(length, { fontSizePx: 16 }));
  });
  if (lengths.length < 2) return null;
  const [offsetX, offsetY, blur, spread] = lengths;
  const opacity = color ? color.alpha : 0.2;
  if (opacity === 0) return null;
  const distance = Math.sqrt(offsetX * offsetX + offsetY * offsetY);
  const angle = (Math.atan2(offsetX, -offsetY) * 180) / Math.PI;
  return {
    color: (color && color.hex) || '000000',
    opacity,
    blur: (blur || 0) * 72,
    distance: distance * 72 || 2,
    angle: Number.isFinite(angle) ? (angle + 360) % 360 : 45,
    spread: (spread || 0) * 72
  };
}

/** Parse `border: 1px solid #ddd` or `border-width`/`border-color` pairs. */
function parseBorder(style) {
  const shorthand = style.border;
  let widthPt = null;
  let color = null;
  let styleName = null;
  if (shorthand) {
    String(shorthand).split(/\s+/u).forEach((token) => {
      const length = parseLength(token);
      if (length) { widthPt = toInches(length, {}) * 72; return; }
      const parsed = parseColor(token);
      if (parsed) { color = parsed; return; }
      if (['solid', 'dashed', 'dotted', 'double', 'none'].includes(token.toLowerCase())) styleName = token.toLowerCase();
    });
  }
  if (style.borderWidth) {
    const length = parseLength(style.borderWidth);
    if (length) widthPt = toInches(length, {}) * 72;
  }
  if (style.borderColor) {
    const parsed = parseColor(style.borderColor);
    if (parsed) color = parsed;
  }
  if (style.borderStyle) styleName = String(style.borderStyle).toLowerCase();
  const declared = shorthand !== undefined || style.borderWidth !== undefined
    || style.borderColor !== undefined || style.borderStyle !== undefined;
  if (!declared) return null;
  if (styleName === 'none' || widthPt === 0) return null;
  return {
    width: widthPt === null ? 0.75 : Math.max(0.25, Number(widthPt.toFixed(2))),
    color: color && color.hex ? color.hex : 'DCE2DE',
    transparency: color ? Math.round((1 - color.alpha) * 100) : 0,
    dash: styleName === 'dashed' ? 'dash' : styleName === 'dotted' ? 'sysDot' : null
  };
}

/** Resolve a background colour from `background-color` or the `background` shorthand. */
function backgroundOf(style) {
  if (!style) return null;
  const direct = parseColor(style.backgroundColor);
  if (direct) return direct;
  const shorthand = style.background;
  if (!shorthand || /gradient|url\(|image-set/iu.test(String(shorthand))) return null;
  for (const token of String(shorthand).split(/\s+/u)) {
    const parsed = parseColor(token);
    if (parsed) return parsed;
  }
  return null;
}

/** Resolve a linear gradient from `background-image` or the `background` shorthand. */
function gradientOf(style) {
  if (!style) return null;
  const fromLayer = parseLinearGradient(style.backgroundImage);
  if (fromLayer) return fromLayer;
  if (style.background && /gradient\(/iu.test(String(style.background))) {
    return parseLinearGradient(style.background);
  }
  return null;
}

/** Turn `background-position` into a nine-grid focus preset or a {x,y} pair. */
function parseBackgroundFocus(value) {
  if (!value) return 'center';
  const tokens = String(value).trim().toLowerCase().split(/\s+/u).filter(Boolean);
  if (!tokens.length) return 'center';
  const named = tokens.filter((token) => ['top', 'bottom', 'left', 'right', 'center'].includes(token));
  if (named.length === tokens.length) {
    const vertical = tokens.find((token) => token === 'top' || token === 'bottom');
    const horizontal = tokens.find((token) => token === 'left' || token === 'right');
    if (vertical && horizontal) return vertical + ' ' + horizontal;
    return vertical || horizontal || 'center';
  }
  const ratios = tokens.slice(0, 2).map((token) => {
    const length = parseLength(token);
    if (!length) return null;
    if (length.unit === '%') return length.value / 100;
    if (length.unit === '') return length.value;
    return null;
  });
  if (ratios[0] === null && (ratios[1] === undefined || ratios[1] === null)) return 'center';
  return {
    x: ratios[0] === null || ratios[0] === undefined ? 0.5 : Math.max(0, Math.min(1, ratios[0])),
    y: ratios[1] === null || ratios[1] === undefined ? 0.5 : Math.max(0, Math.min(1, ratios[1]))
  };
}

/** Pull size/position out of a `background` shorthand layer (after the url()). */
function shorthandLayerGeometry(shorthand) {
  const text = String(shorthand || '').replace(/url\([^)]*\)/iu, ' ');
  const [beforeSlash, afterSlash] = text.split(/\s*\/\s*/u);
  const isPosition = (token) => ['top', 'bottom', 'left', 'right', 'center'].includes(token)
    || /^[\d.]+%$/u.test(token);
  const isSize = (token) => ['cover', 'contain', 'auto'].includes(token)
    || /^[\d.]+(?:%|px)?$/u.test(token);
  const position = (beforeSlash || '').split(/\s+/u).filter(isPosition).join(' ') || null;
  const size = (afterSlash || '').split(/\s+/u).filter(isSize).slice(0, 2).join(' ') || null;
  return { size, position };
}

/**
 * Resolve a `background-image: url(...)` layer into a native picture request.
 * Returns `{ src, fit, focus }` or null.
 */
function backgroundImageOf(style) {
  if (!style) return null;
  const layers = [style.backgroundImage, style.background];
  let src = null;
  for (const layer of layers) {
    if (!layer) continue;
    const match = /url\(\s*(?:'([^']*)'|"([^"]*)"|([^)\s]+))\s*\)/iu.exec(String(layer));
    if (match) {
      src = (match[1] || match[2] || match[3] || '').trim();
      if (src) break;
    }
  }
  if (!src) return null;

  const shorthand = style.background && /url\(/iu.test(String(style.background))
    ? shorthandLayerGeometry(style.background)
    : { size: null, position: null };
  const rawSize = style.backgroundSize !== undefined ? style.backgroundSize : shorthand.size;
  const rawPosition = style.backgroundPosition !== undefined
    ? style.backgroundPosition
    : shorthand.position;

  const size = String(rawSize || '').trim().toLowerCase();
  let fit = 'cover';
  if (size.startsWith('contain')) fit = 'contain';
  else if (size.startsWith('cover')) fit = 'cover';
  else if (/^100%\s*(?:100%|auto)?$/u.test(size) || /^auto\s+100%$/u.test(size)) fit = 'stretch';
  else if (size) fit = 'contain';

  return { src, fit, focus: parseBackgroundFocus(rawPosition) };
}

module.exports = {
  NAMED_COLORS,
  INHERITED_PROPERTIES,
  AXIS_RELATIVE,
  VERTICAL_RELATIVE,
  camelCase,
  parseDeclarations,
  parseStylesheet,
  parseSelector,
  matchesSelector,
  createStyleResolver,
  parseLength,
  toInches,
  dimensionInches,
  pxToPoints,
  parseColor,
  parseLinearGradient,
  parseBoxShadow,
  parseBorder,
  backgroundOf,
  gradientOf,
  backgroundImageOf,
  parseBackgroundFocus,
  expandVariables,
  expandBoxShorthand
};
