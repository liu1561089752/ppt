#!/usr/bin/env node
/**
 * Write the catalogue of everything this engine refuses to draw.
 *
 * The engine's contract is that a difference the drawing cannot express is *named*, not swallowed.
 * That contract is easy to state and easy to erode: a new `recordUnsupported` appears, nobody adds
 * it to a document, and the claim "every deviation is reported" quietly becomes false.
 *
 * So the catalogue is generated from the source instead of maintained by hand. Every call site in
 * the analyzer is extracted, its property and its reason string are read, and the list is written
 * into `LIMITS.md` between two markers. The prose around it is hand-written and survives
 * regeneration; `npm run limits` fails when the file and the source disagree.
 */

const fs = require('node:fs');
const path = require('node:path');

const ROOT = path.join(__dirname, '..');
const ANALYZER = path.join(ROOT, 'pipeline', 'analyzer.js');
const TARGET = path.join(ROOT, 'LIMITS.md');
const START = '<!-- generated:start -->';
const END = '<!-- generated:end -->';

/** Every `recordUnsupported(...)` call, with the arguments split at the top level. */
function callSites(text) {
  const sites = [];
  const marker = 'recordUnsupported(';
  let at = text.indexOf(marker);
  while (at >= 0) {
    let depth = 0;
    // Braces and brackets nest *inside* an argument (an object literal like
    // `{ classes: classList(node) }`), so their commas are not argument separators.
    let nested = 0;
    let quote = null;
    let index = at + marker.length - 1;
    const args = [];
    let current = '';
    for (; index < text.length; index += 1) {
      const character = text[index];
      if (quote) {
        current += character;
        if (character === '\\') { current += text[index + 1] || ''; index += 1; continue; }
        if (character === quote) quote = null;
        continue;
      }
      if (character === "'" || character === '"' || character === '`') { quote = character; current += character; continue; }
      if (character === '(') { depth += 1; if (depth > 1) current += character; continue; }
      if (character === '{' || character === '[') { nested += 1; current += character; continue; }
      if (character === '}' || character === ']') { nested -= 1; current += character; continue; }
      if (character === ')') {
        depth -= 1;
        if (depth === 0) { args.push(current); break; }
        current += character;
        continue;
      }
      if (character === ',' && depth === 1 && nested === 0) { args.push(current); current = ''; continue; }
      current += character;
    }
    sites.push(args.slice(1));
    at = text.indexOf(marker, at + marker.length);
  }
  return sites;
}

/**
 * A string literal argument, with `+` concatenation collapsed onto one line.
 *
 * A message is often built as `'the box keeps its geometry, ' + value + ' is dropped'`. Rendering
 * only the literals gives `the box keeps its geometry,  is dropped`, which reads like a typo;
 * rendering the expression itself gives the code. So each non-literal piece becomes `⟨…⟩`: the
 * sentence stays readable and the dynamic part is visibly dynamic.
 */
function literalOf(argument) {
  const source = String(argument || '').trim();
  const parts = [];
  let depth = 0;
  let quote = null;
  let current = '';
  for (let index = 0; index < source.length; index += 1) {
    const character = source[index];
    if (quote) {
      current += character;
      if (character === '\\') { current += source[index + 1] || ''; index += 1; continue; }
      if (character === quote) quote = null;
      continue;
    }
    if (character === "'" || character === '"' || character === '`') { quote = character; current += character; continue; }
    if ('([{'.includes(character)) depth += 1;
    if (')]}'.includes(character)) depth -= 1;
    if (character === '+' && depth === 0) { parts.push(current); current = ''; continue; }
    current += character;
  }
  parts.push(current);

  return parts.map((part) => {
    const trimmed = part.trim();
    if (!trimmed) return '';
    const literal = /^'((?:[^'\\]|\\.)*)'$/u.exec(trimmed) || /^"((?:[^"\\]|\\.)*)"$/u.exec(trimmed);
    if (literal) return literal[1].replace(/\\'/gu, "'").replace(/\\\\/gu, '\\');
    if (/^`([^`]*)`$/u.test(trimmed)) return trimmed.slice(1, -1).replace(/\$\{[^}]*\}/gu, '\u27e8\u2026\u27e9');
    // A piece built at run time keeps its expression, shortened: the reader can see what the
    // engine substitutes, and can find that expression in the source.
    const expression = trimmed.replace(/\s+/gu, ' ');
    return '\u27e8' + (expression.length > 36 ? expression.slice(0, 33) + '\u2026' : expression) + '\u27e9';
  }).join('');
}

/** The property is either a literal or an expression; an expression is shown as written. */
function propertyOf(argument) {
  const source = String(argument || '').trim();
  const literal = literalOf(source);
  // A property built at run time (`'::' + pseudo`) keeps its expression, which says more than the
  // rendered `::⟨…⟩` would: the reader can see which variable the report is keyed on.
  if (literal && !literal.includes('\u27e8')) return literal;
  const oneLine = source.replace(/\s+/gu, ' ');
  return oneLine.length > 44 ? oneLine.slice(0, 41) + '\u2026' : oneLine;
}

function collect() {
  const text = fs.readFileSync(ANALYZER, 'utf8');
  const entries = [];
  for (const args of callSites(text)) {
    // recordUnsupported(ctx, node, property, value, reason)
    const property = propertyOf(args[1]);
    const reason = literalOf(args.slice(3).join(', '));
    if (!property) continue;
    entries.push({ property, reason });
  }
  return entries;
}

function table(entries) {
  const byProperty = new Map();
  for (const entry of entries) {
    if (!byProperty.has(entry.property)) byProperty.set(entry.property, new Set());
    if (entry.reason) byProperty.get(entry.property).add(entry.reason);
  }
  const rows = [...byProperty.keys()].sort((a, b) => a.localeCompare(b)).map((property) => {
    const reasons = [...byProperty.get(property)].sort();
    const shown = reasons.length ? reasons.map((reason) => reason.replace(/\|/gu, '\\|')).join('<br>') : '—';
    return '| `' + property + '` | ' + shown + ' |';
  });
  return [
    '| reported as | what the deck says it could not do |',
    '| --- | --- |',
    ...rows
  ].join('\n') + '\n\n`⟨expr⟩` is a part of the sentence the engine fills in at run time: the expression inside'
    + ' the brackets is what it substitutes, so it can be found in `pipeline/analyzer.js`. The wording'
    + ' around it is fixed.';
}

function generated(entries) {
  const properties = new Set(entries.map((entry) => entry.property));
  const reasons = new Set(entries.filter((entry) => entry.reason).map((entry) => entry.reason));
  return [
    START,
    '',
    `Generated from \`pipeline/analyzer.js\`: **${entries.length} call sites**, **${properties.size} properties**,`,
    `**${reasons.size} distinct explanations**. Regenerate with \`npm run limits:update\`; a new report`,
    'without a line here fails the gate.',
    '',
    table(entries),
    '',
    END
  ].join('\n');
}

function prose() {
  return [
    '# What this engine will not draw',
    '',
    'The engine\'s contract is narrow and it is the whole point: **silence means the deck agrees with',
    'the browser.** A difference the drawing cannot express is named in the report, in the slide it',
    'happens on, with a reason a designer can act on. This file is the full list of those reasons -',
    'generated from the source, so it cannot drift away from the code.',
    '',
    '## How to read a report entry',
    '',
    '`npm run pipeline -- deck.html` prints them, and each deck carries a `report` object:',
    '',
    '```json',
    '{ "slide": 3, "tag": "div", "property": "float", "value": "left",',
    '  "reason": "A float escapes the flow ..." }',
    '```',
    '',
    '## The catalogue',
    '',
    generated(collect()),
    '',
    '## Gaps that are not a missing feature',
    '',
    'These are places where DrawingML has no object to draw, so no amount of work closes them. They',
    'are named in the report like everything else, and each one lists what a design can do instead.',
    '',
    '| CSS | why no native object exists | what to write instead |',
    '| --- | --- | --- |',
    '| `float` with text wrapping around it | DrawingML text flows in a box, not around shapes; a',
    'slide has no float context | absolute positioning, or a two-column flex row |',
    '| `border-collapse: collapse` where neighbours disagree | a table cell has four independent',
    'borders; a shared edge with two different widths is not representable | give both cells the same',
    'border, or let the engine draw the first one and name the conflict |',
    '| `background-clip: text` | a fill is painted behind glyphs, never inside their outline | a',
    'picture fill on the words, or a solid colour |',
    '| `clip-path: circle(30% at 70% 30%)` | a custom geometry is a polygon in shape coordinates; an',
    'off-centre circle would need a curved path with an arbitrary arc | a centred radius (a native',
    'ellipse), or a pre-cropped image |',
    '| `image-rendering: pixelated` | picture resampling is a reader setting | scale the asset |',
    '| a form control\'s own box | the reader paints its own border, fill and padding around a widget |',
    'a styled container that looks like a control |',
    '| a `.ttc` or `.otf` face | the embedding part carries TrueType data only | convert to `.ttf`, or',
    'let the deck reference the font by name |',
    '| `text-decoration-style: wavy` on a *table cell* | the cell run mapper takes one underline per',
    'cell, and small caps and per-cell decorations are named once per table | set it on the cell text',
    '|',
    '',
    '## Gaps this machine cannot adjudicate',
    '',
    'Three questions need a real Microsoft PowerPoint, and no reader available here can answer them:',
    '',
    '1. **Line spacing convention.** `a:lnSpc/a:spcPct` is a percentage of the line\'s *natural*',
    '   height, and CSS `line-height: 1.25` is 1.25 *em*. LibreOffice and WPS both read it the CSS',
    '   way and agree with each other to the pixel on 60 fingerprint pages, but PowerPoint may',
    '   interpret the same number differently. The engine writes what it measured and reports nothing;',
    '   if a real PowerPoint disagrees, this line is where to start.',
    '2. **Repair behaviour.** Three readers open every deck without a complaint - LibreOffice, WPS,',
    '   and python-pptx (which round-trips the package) - and the OOXML audit checks child order,',
    '   table grids, enumerations and fonts against the schema. Only PowerPoint itself decides whether',
    '   it offers to repair a file it can parse.',
    '3. **Tile rendering.** `a:tile` is standard DrawingML and the numbers are verified by',
    '   construction - `sx`/`sy` are the cell as a fraction of the frame, `tx`/`ty` the pattern\'s',
    '   origin in cells - but LibreOffice\'s and WPS\'s importers ignore the tile attributes and',
    '   draw the first cell stretched across the frame. The deck is right (`pipeline-crop.html`',
    '   names this on its own page); whether PowerPoint agrees is not measurable here.',
    '',
    '## What is *not* on this list',
    '',
    'Everything else the HTML can say, the deck draws: flex and grid tracks, columns, insets and',
    'margins with CSS\'s quirks, single-side borders (including along a rounded corner), gradients,',
    'shadows, transforms, tables with merged cells, native charts with declared data, and every',
    'typographic property listed in `SKILL.md` with its own gate.'
  ].join('\n');
}

function main() {
  const wanted = prose();
  if (process.argv.includes('--update')) {
    fs.writeFileSync(TARGET, wanted.endsWith('\n') ? wanted : wanted + '\n');
    const entries = collect();
    console.log('wrote ' + path.relative(ROOT, TARGET) + ' with ' + entries.length + ' call site(s)');
    return 0;
  }
  if (!fs.existsSync(TARGET)) {
    console.log('LIMITS.md is missing: run `npm run limits:update`');
    return 1;
  }
  const current = fs.readFileSync(TARGET, 'utf8').replace(/\r\n/gu, '\n').trimEnd();
  if (current !== wanted.trimEnd()) {
    console.log('LIMITS.md is out of date with pipeline/analyzer.js: run `npm run limits:update`');
    return 1;
  }
  const entries = collect();
  console.log('limits catalogue current: ' + entries.length + ' call site(s), '
    + new Set(entries.map((entry) => entry.property)).size + ' property(ies)');
  return 0;
}

if (require.main === module) {
  process.exitCode = main();
}

module.exports = { collect, table, prose, callSites, literalOf, propertyOf, TARGET };
