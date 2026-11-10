#!/usr/bin/env node
'use strict';

/**
 * Generate LIMITS.md from what the engine actually refuses.
 *
 * The previous catalogue was generated from `recordUnsupported(...)` call sites inside the HTML
 * analyser: 157 sites and 87 CSS properties, every one of them a statement about CSS the converter
 * could not map. With the analyser gone, that list describes nothing. What the native tool can
 * honestly say is narrower and checkable:
 *
 *   - every `throw new Error(...)` in the engine, core, components, themes and the CLI: the cases
 *     where the writer refuses to guess;
 *   - every rule in `validateDeck`, which rejects a spec before a byte is written;
 *   - the three codes `validateSlide` reports on the boxes that were written;
 *   - and the hand-written section below, which no code on this machine can adjudicate.
 *
 *   node scripts/limits_report.js            # fail if LIMITS.md is stale
 *   node scripts/limits_report.js --update   # accept what the code says now
 */

const fs = require('node:fs');
const path = require('node:path');

const NATIVE = path.resolve(__dirname, '..');
const TARGET = path.join(NATIVE, 'LIMITS.md');

const REFUSAL_SOURCES = [
  'engine/native_pptx.js', 'engine/image_fit.js', 'engine/layout.js', 'engine/text_measure.js',
  'engine/font_manager.js', 'engine/validation.js', 'engine/flex_lines.js', 'engine/flex_size.js',
  'engine/grid_place.js', 'engine/east_asian_font.js', 'core/schema.js', 'core/units.js',
  'components/text.js', 'components/cards.js', 'components/diagrams.js', 'themes/design_system.js',
  'cli.js'
];

const THROW = /throw new Error\(\s*(['"`])((?:[^'"`\\]|\\.){4,200})\1/gu;
const RULE = /errors\.push\(/gu;

// No code can settle these on a machine that has no PowerPoint: the readers here (LibreOffice, WPS)
// and the schema say nothing about what PowerPoint itself will do with the same bytes.
const UNJUDGEABLE = `## Only PowerPoint can adjudicate

These are written correctly as far as this machine can tell, and the readers here disagree with
PowerPoint (or with each other) about them. They stay here rather than in a fixture, because a
fixture would record one reader's opinion as if it were a fact.

- **\`a:tile\` picture and shape fills.** A tiled fill is written as a blip fill with
  \`<a:tile tx="…" ty="…"/>\`. LibreOffice and WPS both ignore the tile rectangle and draw one
  stretched cell of the image: a dotted-pattern probe came back as a single dot per panel. PowerPoint
  is expected to tile it. The element is correct; the picture on this machine is not evidence.
- **\`a:spcPct\` line spacing.** Line-spacing multiples are written as a percentage of a line
  (\`val="118000"\` for 1.18). A reader computes that percentage against its own font metrics, so the
  same deck can be one line taller in one reader and one line shorter in another. PowerPoint's
  convention is the one we target.
- **Repair prompts.** A part that a reader tolerates can still make PowerPoint offer to "repair" the
  presentation. \`verify_native_ooxml.py\` checks the schema of everything written and
  \`corrupt_anchor.py\` proves those checks fire on a deliberately damaged part, but neither can say
  what PowerPoint's repair logic will decide.
- **A dashed bar has no visible outline.** A per-series \`<a:prstDash>\` lands on the series'
  \`<a:ln>\`, and a DrawingML line with no fill draws nothing. Hand-adding a colour to that line made
  the dash appear in a render, which proves the element is right and that inventing an outline colour
  would be a design change rather than a fix.
`;

function escapeCell(text) {
  return String(text).replace(/\|/gu, '\\|').replace(/\s+/gu, ' ').trim();
}

function collect(file, pattern) {
  const text = fs.readFileSync(path.join(NATIVE, file), 'utf8');
  const rows = [];
  text.split(/\r?\n/u).forEach((line, index) => {
    pattern.lastIndex = 0;
    let match;
    while ((match = pattern.exec(line)) !== null) rows.push({ file, line: index + 1, message: match[2] });
  });
  return rows;
}

function refusals() {
  const rows = [];
  REFUSAL_SOURCES.forEach((file) => {
    if (fs.existsSync(path.join(NATIVE, file))) collect(file, THROW).forEach((row) => rows.push(row));
  });
  return rows;
}

/** How many conditions reject a spec; the messages are built per path, so they are counted, not quoted. */
function schemaRules() {
  const text = fs.readFileSync(path.join(NATIVE, 'core/schema.js'), 'utf8');
  return (text.match(RULE) || []).length;
}

function render() {
  const throws = refusals();
  const rules = schemaRules();
  const lines = [];
  lines.push('# What the writer cannot do');
  lines.push('');
  lines.push('Generated from the code by `npm run limits:update`; `npm run limits` fails when this');
  lines.push('document and the source disagree. Every entry is a place where the engine refuses to guess, a');
  lines.push('rule that rejects a spec before anything is written, or a check the tool reports on the boxes');
  lines.push('it did write.');
  lines.push('');
  lines.push('## Refusals the engine can raise (' + throws.length + ')');
  lines.push('');
  lines.push('| where | message |');
  lines.push('| --- | --- |');
  throws.forEach((row) => lines.push('| `' + row.file + ':' + row.line + '` | ' + escapeCell(row.message) + ' |'));
  lines.push('');
  lines.push('## A spec is rejected before anything is written');
  lines.push('');
  lines.push('`core/schema.js` holds **' + rules + ' conditions** that reject a spec, and every message names');
  lines.push('the path that broke (`slides[2].elements[7].w must be a finite non-negative number`). They are');
  lines.push('counted here rather than quoted: the text is built per element, so a table of it would be a');
  lines.push('table of the code. `node cli.js <spec> --check` prints the message for the spec in hand.');
  lines.push('');
  lines.push('The three value sets worth knowing before writing a spec: element types `text, shape, line,');
  lines.push('image, table, chart, container`; image fits `stretch, fill, none, cover, contain, crop,');
  lines.push('scale-down`; page sizes `wide`, `standard`, or `{ width, height }` in inches.');
  lines.push('');
  lines.push('## Layout checks on the deck that was written');
  lines.push('');
  lines.push('`cli.js` runs these on the boxes the writer really used, prints them on stderr, and fails the');
  lines.push('run with `--strict`.');
  lines.push('');
  lines.push('| code | meaning |');
  lines.push('| --- | --- |');
  lines.push('| `OUT_OF_BOUNDS` | an element extends past the page; a decorative shape may bleed, a text box may not |');
  lines.push('| `TEXT_OVERFLOW_RISK` | the measured text needs more height than its box has |');
  lines.push('| `TEXT_OVERLAP` | two text boxes intersect |');
  lines.push('');
  lines.push(UNJUDGEABLE);
  lines.push('## Named by the tool rather than drawn');
  lines.push('');
  lines.push('- A picture the writer cannot read is reported in `droppedPictures` and omitted; the tool');
  lines.push('  prints how many, so the run is not silent about it.');
  lines.push('- A per-series marker rhythm, per-run `text-transform`, right-to-left runs and a list marker');
  lines.push('  inside a table cell are not implemented; they are listed here instead of half-drawn.');
  return lines.join('\n') + '\n';
}

function main() {
  const update = process.argv.includes('--update');
  const expected = render();
  const current = fs.existsSync(TARGET) ? fs.readFileSync(TARGET, 'utf8').split('\r\n').join('\n') : null;
  if (update) {
    fs.writeFileSync(TARGET, expected, 'utf8');
    process.stdout.write('wrote LIMITS.md with ' + refusals().length + ' refusal(s) and '
      + schemaRules() + ' schema condition(s)\n');
    return;
  }
  if (current === expected) {
    process.stdout.write('limits catalogue current: ' + refusals().length + ' refusal(s), '
      + schemaRules() + ' schema condition(s)\n');
    return;
  }
  process.stderr.write('LIMITS.md is stale: run npm run limits:update\n');
  if (current === null) process.stderr.write('  (the file does not exist)\n');
  process.exitCode = 1;
}

main();
