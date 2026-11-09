'use strict';

/**
 * A deliberately small CSS subset for the HTML → Native pipeline.
 *
 * Supported: type/class/id selectors (with descendant and child combinators
 * treated alike), structural pseudo-classes (`:first-child`, `:last-child`,
 * `:only-child`, `:nth-child()`, `:nth-of-type()`, and their `-last-`/`-of-type`
 * forms), `:not()`/`:is()`/`:where()` over simple selectors, simple compound
 * selectors, CSS custom properties via `var()`, inline styles, and a
 * declared-value cascade with specificity.
 *
 * Not supported (recorded as unsupported by the analyzer): @media queries,
 * pseudo-elements, attribute selectors, sibling combinators, shorthands
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
  'letterSpacing', 'textAlign', 'textTransform', 'fontVariant', 'visibility', 'captionSide', 'quotes'
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
    let value = chunk.slice(colon + 1).trim();
    if (!property || !value) return;
    // `!important` marks the declaration, it is not part of its value: leaving it in
    // made `width: 600px !important` unparseable and the box fell back to full width.
    let important = false;
    const flagged = /\s*!\s*important\s*$/iu.exec(value);
    if (flagged) {
      important = true;
      value = value.slice(0, flagged.index).trim();
    }
    if (!value) return;
    declarations.push(important ? { property, value, important } : { property, value });
  });
  return declarations;
}

function stripComments(css) {
  return String(css || '').replace(/\/\*[\s\S]*?\*\//gu, '');
}

function mediaLengthInPx(value, unit) {
  const number = Number(value);
  if (!Number.isFinite(number)) return null;
  if (unit === 'em' || unit === 'rem') return number * 16;
  return number;
}

/** One media condition, e.g. `(min-width: 900px) and (orientation: landscape)`. */
function mediaConditionMatches(condition, viewport) {
  const parts = String(condition || '').split(/\s+and\s+/u).map((part) => part.trim()).filter(Boolean);
  if (!parts.length) return true;
  return parts.every((part) => {
    if (part === 'screen' || part === 'all') return true;
    if (part === 'print') return false;
    const comparison = /^\(\s*(min|max)-(width|height)\s*:\s*([\d.]+)\s*(px|em|rem)?\s*\)$/u.exec(part);
    if (comparison) {
      const pixels = mediaLengthInPx(comparison[3], comparison[4] || 'px');
      if (pixels === null) return false;
      const actual = comparison[2] === 'width' ? viewport.width : viewport.height;
      return comparison[1] === 'min' ? actual >= pixels : actual <= pixels;
    }
    const orientation = /^\(\s*orientation\s*:\s*(landscape|portrait)\s*\)$/u.exec(part);
    if (orientation) {
      const landscape = viewport.width >= viewport.height;
      return orientation[1] === 'landscape' ? landscape : !landscape;
    }
    // A condition we cannot evaluate is not applied, and the caller reports it.
    return false;
  });
}

/** A media query list: any matching query applies. */
function mediaMatches(query, viewport) {
  const text = String(query || '').trim();
  if (!text) return true;
  return text.split(',').some((part) => mediaConditionMatches(part.trim(), viewport));
}

/**
 * Parse a stylesheet into ordered rules plus a global custom-property map.
 * `@media` blocks are evaluated against `options.viewportWidth/Height`.
 */
/**
 * The element defaults a browser applies with no CSS at all: what `<b>`, `<em>`, `<mark>`
 * and `<code>` mean before any stylesheet speaks.
 */
const UA_TAG_STYLES = {
  b: { fontWeight: 'bold' },
  strong: { fontWeight: 'bold' },
  h1: { fontWeight: 'bold' },
  h2: { fontWeight: 'bold' },
  h3: { fontWeight: 'bold' },
  h4: { fontWeight: 'bold' },
  h5: { fontWeight: 'bold' },
  h6: { fontWeight: 'bold' },
  i: { fontStyle: 'italic' },
  em: { fontStyle: 'italic' },
  cite: { fontStyle: 'italic' },
  dfn: { fontStyle: 'italic' },
  var: { fontStyle: 'italic' },
  address: { fontStyle: 'italic' },
  mark: { backgroundColor: '#FFFF00', color: '#000000' },
  small: { fontSize: '0.8333em' },
  code: { fontFamily: 'Consolas, Menlo, monospace' },
  kbd: { fontFamily: 'Consolas, Menlo, monospace' },
  samp: { fontFamily: 'Consolas, Menlo, monospace' },
  pre: { fontFamily: 'Consolas, Menlo, monospace' }
};

function parseStylesheet(cssText, options = {}) {
  const viewport = {
    width: Number(options.viewportWidth) || 1280,
    height: Number(options.viewportHeight) || 720
  };
  const state = {
    rules: [],
    variables: Object.create(null),
    pseudoSelectors: [],
    decorationRules: [],
    mediaQueries: [],
    order: 0
  };
  collectRules(stripComments(cssText), viewport, state);
  return {
    rules: state.rules,
    variables: state.variables,
    pseudoSelectors: state.pseudoSelectors,
    decorationRules: state.decorationRules,
    mediaQueries: state.mediaQueries
  };
}

function collectRules(css, viewport, state) {
  const { rules, variables, pseudoSelectors } = state;
  let index = 0;

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
      const media = /^@media\s+(.+)$/iu.exec(selectorText);
      if (media) {
        // The slide is a fixed viewport, so min/max-width can be resolved now.
        const matched = mediaMatches(media[1], viewport);
        state.mediaQueries.push({ query: media[1].trim(), matched });
        if (matched) collectRules(body, viewport, state);
        continue;
      }
      // Other at-rules are not modeled; keep custom properties they declare.
      if (/@(supports|layer)/u.test(selectorText)) parseDeclarations(body).forEach((declaration) => {
        if (declaration.property.startsWith('--')) variables[declaration.property] = declaration.value;
      });
      continue;
    }

    const declarations = parseDeclarations(body);
    declarations.forEach((declaration) => {
      if (declaration.property.startsWith('--')) variables[declaration.property] = declaration.value;
    });

    splitSelectorList(selectorText).forEach((rawSelector) => {
      const parsed = parseSelector(rawSelector);
      if (!parsed) return;
      if (parsed.pseudo) {
        // A pseudo rule describes a box the DOM does not contain, so letting it
        // match the element itself would deform the real element. ::before and
        // ::after keep their declarations so the decoration can be rebuilt as a
        // native shape; every other pseudo is only listed.
        pseudoSelectors.push(rawSelector.trim());
        if (parsed.pseudoName === 'marker') {
          // `::marker` styles the bullet itself - its colour and size are native
          // `a:buClr`/`buSzPct` properties, so the rule is kept for the list node
          // to read instead of being reported as a box that does not exist.
          state.decorationRules.push({
            selectorText: rawSelector.trim(),
            parts: parsed.parts,
            links: parsed.links,
            pseudo: 'marker',
            declarations,
            order: state.order++,
            specificity: parsed.specificity
          });
        }
        if (parsed.pseudoName === 'before' || parsed.pseudoName === 'after') {
          state.decorationRules.push({
            selectorText: rawSelector.trim(),
            parts: parsed.parts,
            links: parsed.links,
            pseudo: parsed.pseudoName,
            declarations,
            order: state.order++,
            specificity: parsed.specificity
          });
        }
        return;
      }
      rules.push({
        selectorText: rawSelector.trim(),
        parts: parsed.parts,
        links: parsed.links,
        declarations,
        order: state.order++,
        specificity: parsed.specificity
      });
    });
  }
}

/**
 * `[attr]`, `[attr=value]` and the `~ | ^ $ *` operators, with an optional `i`/`s`
 * flag. Returns null when the bracket syntax is not one we can evaluate.
 */
const ATTRIBUTE_SELECTOR = /\[\s*([\w-]+)\s*(?:([~|^$*]?=)\s*(?:"([^"]*)"|'([^']*)'|([^\]\s]*))\s*([is])?\s*)?\]/gu;

function parseAttributeSelectors(segment) {
  const tests = [];
  const source = String(segment || '');
  let remaining = source;
  ATTRIBUTE_SELECTOR.lastIndex = 0;
  let match = ATTRIBUTE_SELECTOR.exec(source);
  while (match) {
    const value = match[3] !== undefined ? match[3] : (match[4] !== undefined ? match[4] : match[5]);
    tests.push({
      name: match[1],
      operator: match[2] || null,
      value: value === undefined ? null : value,
      insensitive: (match[6] || '').toLowerCase() === 'i'
    });
    match = ATTRIBUTE_SELECTOR.exec(source);
  }
  // Anything left in brackets is a selector we do not understand.
  remaining = source.replace(ATTRIBUTE_SELECTOR, '');
  ATTRIBUTE_SELECTOR.lastIndex = 0;
  return { tests, untranslatable: remaining.includes('[') || remaining.includes(']') };
}

function matchesAttribute(node, test) {
  const attrs = (node && node.attrs) || {};
  if (!Object.prototype.hasOwnProperty.call(attrs, test.name)) return false;
  if (test.operator === null) return true;
  let actual = String(attrs[test.name] === undefined || attrs[test.name] === null ? '' : attrs[test.name]);
  let expected = test.value === null ? '' : String(test.value);
  if (test.insensitive) {
    actual = actual.toLowerCase();
    expected = expected.toLowerCase();
  }
  switch (test.operator) {
    case '=':
      return actual === expected;
    case '~=':
      return actual.split(/\s+/u).filter(Boolean).includes(expected);
    case '|=':
      return actual === expected || actual.startsWith(expected + '-');
    case '^=':
      return expected !== '' && actual.startsWith(expected);
    case '$=':
      return expected !== '' && actual.endsWith(expected);
    case '*=':
      return expected !== '' && actual.includes(expected);
    default:
      return false;
  }
}

function parseSimpleSelector(segment) {
  const simple = { tag: null, id: null, classes: [], universal: false };
  let rest = segment;
  const tagMatch = /^(\*|[a-zA-Z][\w-]*)/u.exec(rest);
  if (tagMatch) {
    simple.universal = tagMatch[1] === '*';
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
 * Split a selector into compound segments on combinators and whitespace, without
 * splitting inside `nth-child(2n + 1)` or inside `[attr="a b"]`. Each segment
 * keeps the combinator that links it to the segment on its left (`null` for the
 * first one), so `a > b` and `a b` stay distinguishable.
 */
function selectorSegments(text) {
  const tokens = [];
  let current = '';
  let depth = 0;
  for (const char of String(text || '')) {
    if (char === '(' || char === '[') depth += 1;
    else if (char === ')' || char === ']') depth = Math.max(0, depth - 1);
    if (depth === 0 && /[\s>+~]/u.test(char)) {
      if (current) tokens.push({ type: 'segment', value: current });
      current = '';
      tokens.push({ type: 'combinator', value: char === '>' || char === '+' || char === '~' ? char : ' ' });
      continue;
    }
    current += char;
  }
  if (current) tokens.push({ type: 'segment', value: current });

  const segments = [];
  let pending = null;
  for (const token of tokens) {
    if (token.type === 'segment') {
      segments.push({ text: token.value, combinator: segments.length === 0 ? null : (pending || ' ') });
      pending = null;
    } else if (!pending || token.value !== ' ') {
      // An explicit combinator wins over the whitespace that surrounds it.
      pending = token.value;
    }
  }
  return segments;
}

const STRUCTURAL_PSEUDO = /:(first-child|last-child|only-child|first-of-type|last-of-type|only-of-type|nth-child|nth-of-type|nth-last-child|nth-last-of-type)(?:\(([^)]*)\))?/giu;

/** `an+b` from an nth expression; `odd`/`even` and plain integers included. */
function parseNth(text) {
  const value = String(text === null || text === undefined ? '' : text).replace(/\s+/gu, '').toLowerCase();
  if (!value) return null;
  if (value === 'odd') return { a: 2, b: 1 };
  if (value === 'even') return { a: 2, b: 0 };
  const match = /^([+-]?\d*)n([+-]\d+)?$/u.exec(value);
  if (match) {
    const head = match[1];
    const a = head === '' || head === '+' ? 1 : (head === '-' ? -1 : Number(head));
    const b = match[2] ? Number(match[2]) : 0;
    return { a, b };
  }
  const number = Number(value);
  return Number.isFinite(number) ? { a: 0, b: number } : null;
}

function matchesNth(position, nth) {
  if (!nth) return false;
  if (nth.a === 0) return position === nth.b;
  const difference = position - nth.b;
  return difference % nth.a === 0 && difference / nth.a >= 0;
}

/** Element siblings of a node, used by the structural pseudo-classes. */
function elementSiblings(node) {
  const parent = node && node.parent;
  if (!parent || !Array.isArray(parent.children)) return node ? [node] : [];
  return parent.children.filter((child) => child && child.type === 'element');
}

function matchesStructural(node, test) {
  const siblings = elementSiblings(node);
  const list = test.kind.endsWith('of-type')
    ? siblings.filter((child) => child.tag === node.tag)
    : siblings;
  const position = list.indexOf(node) + 1;
  if (position < 1) return false;
  switch (test.kind) {
    case 'first-child':
    case 'first-of-type':
      return position === 1;
    case 'last-child':
    case 'last-of-type':
      return position === list.length;
    case 'only-child':
    case 'only-of-type':
      return list.length === 1;
    default:
      break;
  }
  const nth = parseNth(test.arg);
  if (test.kind.startsWith('nth-last')) return matchesNth(list.length - position + 1, nth);
  return matchesNth(position, nth);
}

/**
 * Split a selector list on top-level commas. A comma inside `:is(.a, .b)` belongs
 * to the argument, not to the rule.
 */
function splitSelectorList(text) {
  const source = String(text || '');
  const parts = [];
  let current = '';
  let depth = 0;
  for (const char of source) {
    if (char === '(' || char === '[') depth += 1;
    else if (char === ')' || char === ']') depth = Math.max(0, depth - 1);
    if (char === ',' && depth === 0) {
      parts.push(current);
      current = '';
      continue;
    }
    current += char;
  }
  parts.push(current);
  return parts;
}

/**
 * Find the first `:name(...)` functional pseudo-class with balanced parentheses,
 * so an argument may itself contain one (`:not(:nth-child(2n))`).
 */
function findFunctionalPseudo(text, names) {
  const source = String(text || '');
  for (let index = 0; index < source.length; index += 1) {
    if (source[index] !== ':') continue;
    const match = /^:([\w-]+)\(/u.exec(source.slice(index));
    if (!match) continue;
    const name = match[1].toLowerCase();
    if (!names.includes(name)) continue;
    let depth = 0;
    for (let cursor = index + match[0].length - 1; cursor < source.length; cursor += 1) {
      if (source[cursor] === '(') depth += 1;
      else if (source[cursor] === ')') {
        depth -= 1;
        if (depth === 0) {
          return {
            name,
            inner: source.slice(index + match[0].length, cursor),
            start: index,
            end: cursor + 1
          };
        }
      }
    }
    return null;
  }
  return null;
}

/** Parse a comma-separated list of simple selectors; null when one is untranslatable. */
function parseSimpleList(inner, depth) {
  if (depth > 2) return null;
  const parts = String(inner || '').split(',');
  const selectors = [];
  for (const part of parts) {
    const read = readSegment(part, depth + 1);
    if (!read || read.others.length) return null;
    if (!read.simple.tag && !read.simple.id && !read.simple.classes.length
      && !read.simple.universal && !read.simple.structural.length
      && !(read.simple.attributes && read.simple.attributes.length)
      && !read.simple.negations && !read.simple.alternatives) return null;
    selectors.push(read.simple);
  }
  return selectors.length ? selectors : null;
}

/**
 * Read one compound segment: structural pseudo-classes become match tests, `:not()`
 * `:is()` and `:where()` are evaluated as nested simple selectors, and every other
 * pseudo-class is left to the caller to report.
 */
function readSegment(segment, depth = 0) {
  const structural = [];
  const negations = [];
  const alternatives = [];
  let attributes = [];
  let zeroSpecificity = false;
  let rest = String(segment || '');

  // Pull out the functional pseudo-classes first: their argument may itself hold a
  // structural pseudo-class (`:not(:first-child)`) or an attribute selector
  // (`:not([data-kind="x"])`), and both belong to the argument.
  for (let guard = 0; guard < 6; guard += 1) {
    const found = findFunctionalPseudo(rest, ['not', 'is', 'where']);
    if (!found) break;
    const inner = parseSimpleList(found.inner, depth);
    // An argument we cannot translate is left in place so the rule is reported
    // instead of silently matching too much.
    if (!inner) break;
    if (found.name === 'not') negations.push(...inner);
    else {
      if (found.name === 'where') zeroSpecificity = true;
      alternatives.push(...inner);
    }
    rest = rest.slice(0, found.start) + rest.slice(found.end);
  }

  // Attribute selectors: brackets may contain quotes and operator characters.
  const attributeRead = parseAttributeSelectors(rest);
  if (attributeRead.untranslatable) {
    // Keep the text so the rule is reported instead of matching too much.
    return { simple: parseSimpleSelector(''), others: [String(segment || '').trim()], unparsed: true };
  }
  if (attributeRead.tests.length) {
    attributes = attributeRead.tests;
    rest = rest.replace(ATTRIBUTE_SELECTOR, '');
    ATTRIBUTE_SELECTOR.lastIndex = 0;
  }

  rest = rest.replace(STRUCTURAL_PSEUDO, (whole, kind, arg) => {
    structural.push({ kind: String(kind).toLowerCase(), arg: arg === undefined ? null : arg });
    return '';
  });

  const others = rest.match(/::?[\w-]+(?:\([^)]*\))?/gu) || [];
  rest = rest.replace(/::?[\w-]+(?:\([^)]*\))?/gu, '');
  const simple = parseSimpleSelector(rest.trim());
  simple.structural = structural;
  if (attributes.length) simple.attributes = attributes;
  if (negations.length) simple.negations = negations;
  if (alternatives.length) simple.alternatives = alternatives;
  simple.zeroSpecificity = zeroSpecificity;
  return { simple, others };
}

/**
 * Parse a selector into right-to-left parts plus the combinator linking each part
 * to the one on its left. Descendant, child (`>`), adjacent (`+`) and general
 * (`~`) sibling combinators are all honoured when matching.
 */
function parseSelector(rawSelector) {
  const raw = String(rawSelector || '');
  const segments = selectorSegments(raw);
  if (!segments.length) return null;
  const reads = segments.map((segment) => ({ ...readSegment(segment.text), combinator: segment.combinator }));
  const parts = reads.map((read) => read.simple).reverse();
  // links[k] joins parts[k] (right) to parts[k + 1] (left); the combinator is
  // stored on the segment it introduces, which is parts[k] itself.
  const links = parts.slice(0, -1).map((unused, index) => reads[reads.length - 1 - index].combinator || ' ');
  const others = reads.flatMap((read) => read.others);
  const pseudoName = others.length
    ? (/:{1,2}([\w-]+)/u.exec(others[others.length - 1]) || [])[1] || null
    : null;
  const structuralCount = parts.reduce((sum, part) => sum + (part.structural ? part.structural.length : 0), 0);
  // `:not()` and `:is()` contribute one class of specificity, `:where()` none.
  const functionalCount = parts.reduce((sum, part) => {
    if (part.zeroSpecificity) return sum;
    const count = (part.negations ? 1 : 0) + (part.alternatives && !part.zeroSpecificity ? 1 : 0);
    return sum + count;
  }, 0);
  const attributeCount = parts.reduce((sum, part) => sum + (part.attributes ? part.attributes.length : 0), 0);
  // A selector that names nothing (`:root { --x: ... }`, a lone `:hover`) cannot
  // describe an element, so it is not reported as an untranslated selector. A
  // selector that names an element but contains a construct we could not parse
  // (an attribute operator we do not support) is reported instead of dropped.
  const identifies = parts.some((part) => part.tag || part.id || part.classes.length
    || part.universal || (part.structural && part.structural.length)
    || (part.attributes && part.attributes.length)
    || part.negations || part.alternatives);
  if (!identifies && !reads.some((read) => read.unparsed)) return null;
  const specificity = parts.reduce((accumulator, part) => ({
    ids: accumulator.ids + (part.id ? 1 : 0),
    classes: accumulator.classes + (part.zeroSpecificity ? 0 : part.classes.length),
    tags: accumulator.tags + (part.tag ? 1 : 0)
  }), { ids: 0, classes: structuralCount + functionalCount + attributeCount, tags: 0 });
  return {
    parts,
    links,
    specificity,
    pseudo: others.length > 0,
    pseudoName: pseudoName ? pseudoName.toLowerCase() : null
  };
}

function matchesSimple(node, simple) {
  if (!node || node.type !== 'element') return false;
  if (simple.tag && node.tag !== simple.tag) return false;
  if (simple.id && node.attrs.id !== simple.id) return false;
  if (simple.classes.length) {
    const classes = String(node.attrs.class || '').split(/\s+/u);
    if (!simple.classes.every((name) => classes.includes(name))) return false;
  }
  if (simple.structural && simple.structural.length) {
    for (const test of simple.structural) {
      if (!matchesStructural(node, test)) return false;
    }
  }
  if (simple.attributes && simple.attributes.length) {
    for (const test of simple.attributes) {
      if (!matchesAttribute(node, test)) return false;
    }
  }
  if (simple.alternatives && simple.alternatives.length) {
    if (!simple.alternatives.some((alternative) => matchesSimple(node, alternative))) return false;
  }
  if (simple.negations && simple.negations.length) {
    if (simple.negations.some((negation) => matchesSimple(node, negation))) return false;
  }
  return true;
}

/** The nearest element ancestor, skipping text and comment nodes. */
function elementParent(node) {
  let parent = node && node.parent;
  while (parent && parent.type !== 'element') parent = parent.parent;
  return parent || null;
}

/** The element immediately before `node` among its element siblings. */
function previousElementSibling(node) {
  const siblings = elementSiblings(node);
  const index = siblings.indexOf(node);
  return index > 0 ? siblings[index - 1] : null;
}

/**
 * Match right to left: `parts[0]` is the rightmost compound selector. The
 * combinator decides where the next compound may be found, and a descendant or
 * general-sibling step backtracks so `.a .b .c` still matches through a `.b`
 * that was reached on the first try.
 */
function matchSelectorChain(node, parts, links, index) {
  if (!matchesSimple(node, parts[index])) return false;
  if (index === parts.length - 1) return true;
  const link = links[index] || ' ';
  if (link === '>') {
    const parent = elementParent(node);
    return parent ? matchSelectorChain(parent, parts, links, index + 1) : false;
  }
  if (link === '+') {
    const previous = previousElementSibling(node);
    return previous ? matchSelectorChain(previous, parts, links, index + 1) : false;
  }
  if (link === '~') {
    let previous = previousElementSibling(node);
    while (previous) {
      if (matchSelectorChain(previous, parts, links, index + 1)) return true;
      previous = previousElementSibling(previous);
    }
    return false;
  }
  let ancestor = elementParent(node);
  while (ancestor) {
    if (matchSelectorChain(ancestor, parts, links, index + 1)) return true;
    ancestor = elementParent(ancestor);
  }
  return false;
}

function matchesSelector(node, selector) {
  if (!selector || !selector.parts || !selector.parts.length) return false;
  if (!node || node.type !== 'element') return false;
  const links = selector.links || new Array(Math.max(0, selector.parts.length - 1)).fill(' ');
  return matchSelectorChain(node, selector.parts, links, 0);
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

/** Split on whitespace that is not inside parentheses or a function call. */
function splitTopLevelSpaces(value) {
  const parts = [];
  let depth = 0;
  let buffer = '';
  for (const character of String(value === undefined || value === null ? '' : value)) {
    if (character === '(') depth += 1;
    if (character === ')') depth -= 1;
    if (/\s/u.test(character) && depth === 0) {
      if (buffer) parts.push(buffer);
      buffer = '';
      continue;
    }
    buffer += character;
  }
  if (buffer) parts.push(buffer);
  return parts;
}

function expandBoxShorthand(value) {
  const parts = splitTopLevelSpaces(value);
  if (parts.length === 1) return [parts[0], parts[0], parts[0], parts[0]];
  if (parts.length === 2) return [parts[0], parts[1], parts[0], parts[1]];
  if (parts.length === 3) return [parts[0], parts[1], parts[2], parts[1]];
  return [parts[0], parts[1], parts[2], parts[3]];
}

/**
 * `font: 700 24px/1.4 "Microsoft YaHei"` as the longhands it sets. The grammar is
 * `[<style> || <variant> || <weight>]? <size>[/<line-height>]? <family>`; the size and
 * family are mandatory, everything else is optional. A declaration that does not parse
 * stays whole and the subset report names it - a half-expanded font is worse than a
 * named refusal.
 */
function expandFontShorthand(value) {
  const text = String(value || '').trim();
  if (!text || /^(?:caption|icon|menu|message-box|small-caption|status-bar)$/iu.test(text)) return null;
  // Font grammar: [style || variant || weight]? <size>[/<line-height>]? <family>.
  // The size is therefore the FIRST unit-bearing token, the family is everything
  // after it (a quoted face or a comma stack stays one string), and every keyword
  // sits before the size.
  const tokens = text.match(/("[^"]*"|'[^']*'|\.?\d+(?:\.\d+)?(?:px|pt|em|rem|%)?|[\w-]+|\/)/gu) || [];
  let sizeIndex = -1;
  for (let index = 0; index < tokens.length; index += 1) {
    if (/^\.?\d+(?:\.\d+)?(px|pt|em|rem|%)$/iu.test(tokens[index])) { sizeIndex = index; break; }
  }
  if (sizeIndex < 0 || sizeIndex === tokens.length - 1) return null;
  const size = tokens[sizeIndex];
  // The family is the raw remainder - a quoted face with spaces or a comma stack
  // must survive verbatim, and re-joining tokens would eat the comma.
  const sizeText = tokens[sizeIndex];
  let consumed = text.indexOf(sizeText) + sizeText.length;
  const afterSize = text.slice(consumed);
  const lineHeightMatch = /^\s*\/\s*(\.?\d+(?:\.\d+)?)\s*/u.exec(afterSize);
  const lineHeight = lineHeightMatch ? lineHeightMatch[1] : '';
  const family = (lineHeightMatch ? afterSize.slice(lineHeightMatch[0].length) : afterSize).trim();
  if (!family) return null;
  const out = { fontSize: sizeText, fontFamily: family };
  if (lineHeight) out.lineHeight = lineHeight;
  const front = tokens.slice(0, sizeIndex).join(' ');
  const weight = /(?:\b|^)(100|200|300|400|500|600|700|800|900|bold|bolder|lighter)(?:\b|$)/iu.exec(front);
  if (weight) out.fontWeight = weight[1];
  const styleWord = /(?:\b|^)(italic|oblique)(?:\b|$)/iu.exec(front);
  if (styleWord) out.fontStyle = styleWord[1];
  if (/\bsmall-caps\b/iu.test(front)) out.fontVariant = 'small-caps';
  return out;
}
/**
 * Logical → physical aliases for the horizontal-tb, ltr writing mode. Multi-value
 * shorthands map positionally: `inset: 10px 20px` is top/bottom 10, left/right 20.
 */
const LOGICAL_ALIASES = {
  // `inset` follows the box-shorthand expansion (top right bottom left), not pairs:
  // `inset: 10px 20px` is top/bottom 10, left/right 20, and in ltr the left wins when
  // left and right are both set (Chrome-verified).
  inset: 'BOX',
  'inset-block': [['top', 0], ['bottom', 0]],
  'inset-inline': [['left', 0], ['right', 1]],
  'inset-block-start': 'top',
  'inset-block-end': 'bottom',
  'inset-inline-start': 'left',
  'inset-inline-end': 'right',
  'margin-block': [['marginTop', 0], ['marginBottom', 0]],
  'margin-inline': [['marginLeft', 0], ['marginRight', 1]],
  'margin-block-start': 'marginTop',
  'margin-block-end': 'marginBottom',
  'margin-inline-start': 'marginLeft',
  'margin-inline-end': 'marginRight',
  'padding-block': [['paddingTop', 0], ['paddingBottom', 0]],
  'padding-inline': [['paddingLeft', 0], ['paddingRight', 1]],
  'padding-block-start': 'paddingTop',
  'padding-block-end': 'paddingBottom',
  'padding-inline-start': 'paddingLeft',
  'padding-inline-end': 'paddingRight',
  'border-block-start': 'borderTop',
  'border-block-end': 'borderBottom',
  'border-inline-start': 'borderLeft',
  'border-inline-end': 'borderRight',
  'border-start-start-radius': 'borderTopLeftRadius',
  'border-start-end-radius': 'borderTopRightRadius',
  'border-end-start-radius': 'borderBottomLeftRadius',
  'border-end-end-radius': 'borderBottomRightRadius'
};

/**
 * Which properties a style object has already taken from an `!important` declaration.
 * Kept beside the style instead of on it: the resolver hands plain objects to the rest of
 * the pipeline, and a bookkeeping key inside one would leak into the cascade.
 */
const IMPORTANT_PROPERTIES = new WeakMap();

function applyDeclarations(style, declarations, variables) {
  let locked = IMPORTANT_PROPERTIES.get(style);
  if (!locked) {
    locked = new Set();
    IMPORTANT_PROPERTIES.set(style, locked);
  }
  declarations.forEach((declaration) => {
    const { property, value } = declaration;
    const important = Boolean(declaration.important);
    // An `!important` declaration outranks every normal one no matter where it sits, so a
    // later normal declaration cannot take the property back. Between two important ones
    // the usual order applies, which is what the ascending-specificity walk gives us.
    const set = (name, next) => {
      if (!important && locked.has(name)) return;
      style[name] = next;
      if (important) locked.add(name);
    };
    const resolvedValue = expandVariables(value, variables);
    if (property.startsWith('--')) {
      set(property, resolvedValue);
      return;
    }
    if (property === 'gap' || property === 'grid-gap') {
      // `gap: <row> <column>`; a single value applies to both axes.
      const parts = splitTopLevelSpaces(resolvedValue);
      set('rowGap', parts[0]);
      set('columnGap', parts.length > 1 ? parts[1] : parts[0]);
      return;
    }
    if (property === 'border') {
      // Keep the shorthand, but expand it into the four sides so a later or more
      // specific `border-bottom` (and a `border` that clears it) cascades the way
      // CSS says instead of always losing to the longhand.
      set('border', resolvedValue);
      ['Top', 'Right', 'Bottom', 'Left'].forEach((side) => {
        set('border' + side, resolvedValue);
      });
      return;
    }
    if (property === 'padding' || property === 'margin') {
      const [top, right, bottom, left] = expandBoxShorthand(resolvedValue);
      const suffix = property === 'padding' ? 'padding' : 'margin';
      set(suffix + 'Top', top);
      set(suffix + 'Right', right);
      set(suffix + 'Bottom', bottom);
      set(suffix + 'Left', left);
      return;
    }
    // Logical properties are aliases of the physical ones in a horizontal-tb, ltr
    // writing mode, which is the only mode this solver models. Normalising here keeps
    // the whole pipeline physical-property-only without a report per alias.
    const logical = LOGICAL_ALIASES[property];
    if (logical) {
      if (logical === 'BOX') {
        const [topSide, rightSide, bottomSide, leftSide] = expandBoxShorthand(resolvedValue);
        set('top', topSide);
        set('right', rightSide);
        set('bottom', bottomSide);
        set('left', leftSide);
        return;
      }
      if (typeof logical === 'string') { set(logical, resolvedValue); return; }
      logical.forEach(([name, index]) => {
        set(name, splitTopLevelSpaces(resolvedValue)[index] || splitTopLevelSpaces(resolvedValue)[0]);
      });
      return;
    }
    if (property === 'font') {
      const expanded = expandFontShorthand(resolvedValue);
      if (!expanded) { set('font', resolvedValue); return; }
      Object.entries(expanded).forEach(([name, next]) => set(name, next));
      return;
    }
    if (property === 'border-radius') {
      const [topLeft, topRight, bottomRight, bottomLeft] = expandBoxShorthand(resolvedValue);
      set('borderTopLeftRadius', topLeft);
      set('borderTopRightRadius', topRight);
      set('borderBottomRightRadius', bottomRight);
      set('borderBottomLeftRadius', bottomLeft);
      set('borderRadius', topLeft);
      return;
    }
    set(camelCase(property), resolvedValue);
  });
  return style;
}

/** Resolve the declared (not yet unit-converted) style of a node. */
function createStyleResolver(stylesheet) {
  const cache = new WeakMap();
  const { rules, variables } = stylesheet;
  const mediaQueries = stylesheet.mediaQueries || [];
  const decorationRules = stylesheet.decorationRules || [];

  function declared(node) {
    if (cache.has(node)) return cache.get(node);
    const matched = rules.filter((rule) => matchesSelector(node, rule)).sort(compareSpecificity);
    const style = Object.create(null);
    // The element defaults a browser applies with no CSS at all. A design that writes
    // `<strong>`, `<em>`, `<mark>` or `<code>` and no rules relies on these, and without
    // them those words come out plain: the tag itself is not a styling hint.
    const defaults = UA_TAG_STYLES[node.tag];
    if (defaults) Object.assign(style, defaults);
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

  /** Declarations of a `::before`/`::after` box for a node, or null. */
  function decoration(node, pseudo) {
    const matched = decorationRules
      .filter((rule) => rule.pseudo === pseudo && matchesSelector(node, rule))
      .sort(compareSpecificity);
    if (!matched.length) return null;
    const style = Object.create(null);
    matched.forEach((rule) => applyDeclarations(style, rule.declarations, variables));
    return style;
  }

  return { declared, computed, decoration, variables, rules, mediaQueries };
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

/** The slide is the viewport, so viewport units resolve to a fixed number. */
const VIEWPORT_PX = { width: 1280, height: 720 };

function viewportPx(context, axis) {
  const viewport = context.viewport || VIEWPORT_PX;
  const width = Number(viewport.width) || VIEWPORT_PX.width;
  const height = Number(viewport.height) || VIEWPORT_PX.height;
  return { width, height, min: Math.min(width, height), max: Math.max(width, height) };
}

function toInches(length, context = {}) {
  if (!length) return null;
  const { value, unit } = length;
  const view = viewportPx(context);
  switch (unit) {
    case 'in': return value;
    case 'pt': return value / 72;
    case 'pc': return value / 6;
    case 'cm': return value / 2.54;
    case 'mm': return value / 25.4;
    case 'q': return value / 101.6;
    case '':
    case 'px': return value / 96;
    case 'em': return (value * (context.fontSizePx || 16)) / 96;
    case 'rem': return (value * (context.rootFontSizePx || 16)) / 96;
    // `ch` is the advance of a zero and `ex` is the x-height. Half an em for both was a
    // sixth too narrow for `ch` in every UI face these decks use, which matters when a
    // box is measured in characters: `width: 40ch` came out ~10% short and the words
    // wrapped a line early. The two factors are the usual values for a Latin UI face.
    case 'ch': return (value * (context.fontSizePx || 16) * 0.58) / 96;
    case 'ex': return (value * (context.fontSizePx || 16) * 0.52) / 96;
    case 'vw': return (value * view.width) / 9600;
    case 'vh': return (value * view.height) / 9600;
    case 'vmin': return (value * view.min) / 9600;
    case 'vmax': return (value * view.max) / 9600;
    case '%': {
      const base = context.percentBase;
      if (base === null || base === undefined) return null;
      return (value / 100) * base;
    }
    default: return null;
  }
}

const MATH_LENGTH_TOKEN = /^(\d*\.?\d+)(px|pt|pc|in|cm|mm|q|em|rem|ex|ch|vw|vh|vmin|vmax|%)?/iu;

/**
 * Evaluate a CSS length expression - `calc(50% - 24px)`, `min(600px, 100%)`,
 * `clamp(14px, 1.2vw, 18px)`, `60vw` - to inches, or null when it uses something this
 * shape cannot resolve. Returning null is what makes the caller report the declaration
 * instead of silently laying the box out at full width.
 */
function evaluateInches(text, context = {}) {
  const source = String(text === undefined || text === null ? '' : text).trim();
  if (!source) return null;
  let index = 0;
  const skip = () => { while (index < source.length && /\s/u.test(source[index])) index += 1; };
  const fail = () => { throw new Error("unsupported length"); };
  const parseNumber = () => {
    skip();
    const rest = source.slice(index);
    const match = MATH_LENGTH_TOKEN.exec(rest);
    if (!match) {
      // A unitless number is a valid multiplier, not a length.
      const bare = /^\d*\.?\d+/u.exec(rest);
      if (!bare) fail();
      index += bare[0].length;
      return { inches: Number(bare[0]), unitless: true };
    }
    index += match[0].length;
    // A bare number inside an expression is a multiplier, not a px length: treating it
    // as px made `calc(100% / 3)` and `calc(1000 - 2 * 24px)` unsolvable.
    if (!match[2]) return { inches: Number(match[1]), unitless: true };
    const inches = toInches({ value: Number(match[1]), unit: match[2].toLowerCase() }, context);
    if (inches === null) fail();
    return { inches, unitless: false };
  };
  const parseArgs = () => {
    const args = [parseSum()];
    skip();
    while (source[index] === ',') {
      index += 1;
      args.push(parseSum());
      skip();
    }
    return args;
  };
  function parsePrimary() {
    skip();
    if (source[index] === '(') {
      index += 1;
      const value = parseSum();
      skip();
      if (source[index] !== ')') fail();
      index += 1;
      return value;
    }
    const name = /^([a-z]+)\(/iu.exec(source.slice(index));
    if (name) {
      const fn = name[1].toLowerCase();
      index += name[0].length;
      const args = parseArgs();
      skip();
      if (source[index] !== ')') fail();
      index += 1;
      if (fn === 'calc') return args.length === 1 ? args[0] : fail();
      // Every term carries its unit, so a function returns a term too - returning a bare
      // number here made the caller read `.inches` off a number and give up.
      if (fn === 'min') return { inches: Math.min(...args.map((arg) => arg.inches)), unitless: false };
      if (fn === 'max') return { inches: Math.max(...args.map((arg) => arg.inches)), unitless: false };
      if (fn === 'clamp') {
        if (args.length !== 3) fail();
        return { inches: Math.min(Math.max(args[0].inches, args[1].inches), args[2].inches), unitless: false };
      }
      return fail();
    }
    return parseNumber();
  }
  function parseProduct() {
    let left = parsePrimary();
    for (;;) {
      skip();
      const op = source[index];
      if (op !== '*' && op !== '/') return left;
      index += 1;
      const right = parsePrimary();
      if (op === '*') {
        if (!left.unitless && !right.unitless) fail();
        left = {
          inches: left.unitless ? right.inches * left.inches : left.inches * right.inches,
          unitless: left.unitless && right.unitless
        };
      } else {
        if (right.inches === 0) fail();
        left = { inches: left.inches / right.inches, unitless: left.unitless && right.unitless };
      }
    }
  }
  function parseSum() {
    let left = parseProduct();
    for (;;) {
      skip();
      const op = source[index];
      if (op !== '+' && op !== '-') return left;
      index += 1;
      const right = parseProduct();
      const inches = op === '+' ? left.inches + right.inches : left.inches - right.inches;
      left = { inches, unitless: left.unitless && right.unitless };
    }
  }
  try {
    const result = parseSum();
    skip();
    if (index !== source.length) return null;
    if (result.unitless) return null;
    return Number.isFinite(result.inches) ? result.inches : null;
  } catch (error) {
    return null;
  }
}

function dimensionInches(value, axis, context = {}) {
  if (value === undefined || value === null) return null;
  const percentBase = axis === 'y' ? context.parentHeight : context.parentWidth;
  const scoped = Object.assign({}, context, { percentBase });
  const expression = evaluateInches(value, scoped);
  if (expression !== null) return expression;
  const length = parseLength(value);
  if (!length) return null;
  return toInches(length, scoped);
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
  // #RRGGBBAA is standard CSS: the alpha channel becomes transparency, which the
  // shapes carry and the gradient stops scale into their own alpha field.
  const hex8Match = /^#([0-9a-f]{8})$/u.exec(text);
  if (hex8Match) {
    const digits = hex8Match[1];
    const alpha = parseInt(digits.slice(6), 16) / 255;
    return { hex: digits.slice(0, 6).toUpperCase(), alpha: Number(alpha.toFixed(3)) };
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

/** Split on a separator that is not nested inside parentheses. */
function splitTopLevel(text, separator) {
  const parts = [];
  let depth = 0;
  let buffer = '';
  for (const character of String(text)) {
    if (character === '(') depth += 1;
    if (character === ')') depth -= 1;
    if (character === separator && depth === 0) {
      parts.push(buffer);
      buffer = '';
    } else {
      buffer += character;
    }
  }
  if (buffer.trim()) parts.push(buffer);
  return parts;
}

const SIDE_ANGLES = {
  bottom: 180, top: 0, right: 90, left: 270,
  'bottom right': 135, 'bottom left': 225, 'right bottom': 135, 'left bottom': 225,
  'top right': 45, 'top left': 315, 'right top': 45, 'left top': 315
};

/** An angle or a `to <side>` direction, or null when the text is neither. */
function gradientAngleOf(text) {
  const value = String(text === undefined ? '' : text).trim().toLowerCase();
  const numeric = /^([-+]?[\d.]+)(deg|rad|grad|turn)$/u.exec(value);
  if (numeric) {
    const amount = Number.parseFloat(numeric[1]);
    if (!Number.isFinite(amount)) return null;
    if (numeric[2] === 'deg') return amount;
    if (numeric[2] === 'rad') return (amount * 180) / Math.PI;
    if (numeric[2] === 'grad') return amount * 0.9;
    return amount * 360;
  }
  if (!value.startsWith('to ')) return null;
  const key = value.slice(3).trim().split(/\s+/u).filter(Boolean).join(' ');
  const angle = SIDE_ANGLES[key];
  return angle === undefined ? null : angle;
}

/**
 * The gradient function a declaration uses when no native fill can express it. Only a
 * plain `linear-gradient` is translatable: PowerPoint has no radial or conic fill, and a
 * repeating gradient would have to be rasterised into stops it does not have.
 */
function unsupportedGradientOf(style) {
  const candidates = [style.backgroundImage, style.background];
  for (const candidate of candidates) {
    const match = /((?:repeating-)?(?:radial|conic|linear)-gradient)\s*\(/iu.exec(String(candidate || ''));
    if (!match) continue;
    const name = match[1].toLowerCase();
    if (name === 'linear-gradient') continue;
    return name;
  }
  return null;
}

/**
 * Parse a two-or-more-stop linear gradient. The direction is optional in CSS (it
 * defaults to `to bottom`), so the first argument is only read as one when it *is* a
 * direction - otherwise a plain `linear-gradient(#f00, #00f)` swallowed its first
 * colour as an angle and the whole declaration was dropped without a word.
 */
function parseLinearGradient(value) {
  const text = String(value || '').trim();
  const open = /^linear-gradient\(([\s\S]*)\)$/u.exec(text);
  if (!open) return null;
  const args = splitTopLevel(open[1], ',');
  let angleText = '';
  if (args.length > 1 && gradientAngleOf(args[0]) !== null) {
    angleText = String(args.shift()).trim().toLowerCase();
  }
  const stopText = args.join(',');
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
    // A repeating gradient usually writes pixel stops (`#ddd 0 10px`). A px stop is a
    // position along the gradient axis, but the axis length lives with the box, which
    // the parser does not see - and a wrong basis bakes a wrong pattern in. Pixel
    // stops therefore keep the declaration unsupported instead of guessing.
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

  // `to <side>`, `rad`/`grad`/`turn` and the plain `deg` form all resolve here; an
  // unknown direction falls back to the CSS default, `to bottom`.
  const direction = gradientAngleOf(angleText);
  const angle = direction === null ? 180 : direction;

  return { angle, stops };
}

/** Parse a single outer box-shadow. Returns null for lists/inset shadows. */
/**
 * What a `box-shadow` leaves behind: an inset direction, a second layer and a spread
 * radius are all things a native outer shadow cannot express, so they are reported
 * instead of disappearing into a shadow that looks close but is not the same.
 */
function boxShadowNote(value) {
  const text = String(value === undefined || value === null ? '' : value).trim();
  if (!text || text === 'none') return null;
  if (/\binset\b/iu.test(text)) return 'An inset shadow paints inside the box; only an outer shadow is translated';
  const layers = splitTopLevel(text, ',');
  if (layers.length > 1) return 'Only the first shadow layer is translated';
  const shadow = parseBoxShadow(text);
  if (!shadow) return null;
  if (shadow.spread) return 'The spread of a shadow is dropped: a native outer shadow carries offset, blur and colour';
  return null;
}

function parseBoxShadow(value) {
  const text = String(value || '').trim();
  if (!text || text === 'none') return null;
  // A layered declaration translates its first layer - the one that carries most of the
  // look - and boxShadowNote names the rest. An inset layer is refused whole: an inner
  // shadow is not what a native outer shadow paints, and halving it would be a wrong one.
  const body = text.includes('inset') ? null
    : splitTopLevel(text, ',').filter((layer) => !/\binset\b/iu.test(layer))[0] || null;
  if (!body) return null;
  // Hex letters are case-insensitive in CSS: without A-F, `#C05B3E` fragmented into
  // stray lengths (05, 3), which poisoned the spread and reported a working shadow.
  const tokens = body.match(/(rgba?\([^)]*\)|#[0-9a-fA-F]{3,8}|[a-z]+|-?[\d.]+(?:px|em|rem|pt)?)/gu);
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
  // DrawingML measures the direction clockwise from the positive x axis with y pointing
  // down, which is exactly `atan2(dy, dx)`: `0 10px` is 90 degrees, straight down. The
  // negated form used here before pointed every shadow to the left.
  const angle = (Math.atan2(offsetY, offsetX) * 180) / Math.PI;
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

/**
 * The CSS layers of a background, topmost first, each tagged with what it is. A deck hero
 * is usually `background-image: linear-gradient(...), url(photo.jpg)` - a picture with a
 * scrim over it - which is two native objects (a picture and a gradient shape), not one.
 */
function backgroundLayersOf(style) {
  const declaration = String(style.backgroundImage || style.background || '').trim();
  if (!declaration) return [];
  if (!/gradient\(|url\(/iu.test(declaration)) return [];
  return splitTopLevel(declaration, ',').map((layer) => layer.trim()).filter(Boolean).map((layer) => {
    const gradient = parseLinearGradient(layer);
    if (gradient) return { kind: 'gradient', gradient, css: layer };
    const name = unsupportedGradientOf({ backgroundImage: layer });
    if (name) return { kind: 'unsupported-gradient', name, css: layer };
    if (/url\(/iu.test(layer)) return { kind: 'image', css: layer };
    return { kind: 'unknown', css: layer };
  });
}

/** The gradient painted above a background image, as the CSS text of that layer. */
function backgroundOverlayGradientOf(style) {
  const layers = backgroundLayersOf(style);
  const imageIndex = layers.findIndex((layer) => layer.kind === 'image');
  if (imageIndex < 0) return null;
  const overlay = layers.slice(0, imageIndex).find((layer) => layer.kind === 'gradient');
  return overlay ? overlay.css : null;
}

/** Layers this translation cannot paint, described for the report. */
function untranslatedBackgroundLayers(style) {
  const layers = backgroundLayersOf(style);
  const problems = [];
  const imageIndex = layers.findIndex((layer) => layer.kind === 'image');
  layers.forEach((layer, index) => {
    if (layer.kind === 'unsupported-gradient') problems.push(layer.name + '()');
    else if (layer.kind === 'unknown') problems.push('that layer');
    else if (layer.kind === 'gradient' && imageIndex >= 0 && index > imageIndex) problems.push('a gradient behind the picture');
    else if (layer.kind === 'image' && index !== imageIndex) problems.push('a second picture layer');
  });
  if (layers.filter((layer) => layer.kind === 'image').length > 1) problems.push('a second picture layer');
  return [...new Set(problems)];
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
  boxShadowNote,
  evaluateInches,
  VIEWPORT_PX,
  gradientAngleOf,
  unsupportedGradientOf,
  backgroundLayersOf,
  backgroundOverlayGradientOf,
  untranslatedBackgroundLayers,
  parseBoxShadow,
  parseBorder,
  backgroundOf,
  gradientOf,
  backgroundImageOf,
  parseBackgroundFocus,
  expandVariables,
  expandBoxShorthand
};
