#!/usr/bin/env node
'use strict';

/**
 * A native stress deck: N pages built straight from the engine's own API.
 *
 * The old stress generator produced HTML with CSS archetypes and converted it, so it stressed the
 * analyser. This one stresses what the product actually does: text measured in inches, blocks placed
 * after each other, tables with many rows, charts with several series, containers nested inside
 * containers, and the writer's patches. Nothing here is a stylesheet and nothing is parsed.
 *
 *   node scripts/stress_spec.js --slides 120 --seed 13 --out stress120.pptx
 *
 * Fails (exit 1) on: a spec the validator rejects, any layout warning on the written deck
 * (out of bounds, text taller than its box, overlapping text), a page count that does not match, or
 * a wall-clock time over the budget.
 */

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { generatePptx, validateDeck, components, templates, estimateTextHeight } = require('../index');
const { validateSlide } = require('../engine/validation');

const PAGE = { width: 13.333, height: 7.5 };
const MARGIN = 0.78;

const theme = {
  name: 'stress-native',
  colors: {
    background: 'F7F7F4', surface: 'FFFFFF', foreground: '202321', primary: '183B3A',
    accent: 'D36B45', muted: '6B7470', border: 'DCE2DE'
  },
  fonts: { heading: 'Microsoft YaHei', body: 'Microsoft YaHei' },
  sizes: { title: 30, heading: 20, body: 14, caption: 10 },
  spacing: { pageX: MARGIN, pageY: 0.5 },
  radii: { small: 0.06, medium: 0.12, large: 0.2 },
  effects: { cardBorder: true }
};

// Deterministic: the same seed has to reproduce a failure exactly.
function mulberry32(seed) {
  let state = seed >>> 0;
  return function next() {
    state = (state + 0x6D2B79F5) >>> 0;
    let value = Math.imul(state ^ (state >>> 15), 1 | state);
    value = (value + Math.imul(value ^ (value >>> 7), 61 | value)) ^ value;
    return ((value ^ (value >>> 14)) >>> 0) / 4294967296;
  };
}

const WORDS = ['增长', '留存', '渠道', '成本', '结构', '节奏', '证据', '结论', '路径', '边界', '假设',
  '验证', '样本', '口径', '拐点', '容量', '交付', '迭代', '反馈', '风险'];
const LATIN = ['retention', 'pipeline', 'cohort', 'margin', 'latency', 'throughput', 'variance'];

function makeText(random, characters) {
  const parts = [];
  let length = 0;
  while (length < characters) {
    const word = random() < 0.12 ? LATIN[Math.floor(random() * LATIN.length)] : WORDS[Math.floor(random() * WORDS.length)];
    parts.push(word);
    length += word.length + (random() < 0.2 ? 1 : 0);
  }
  return parts.join(random() < 0.5 ? '' : '');
}

/** Headline plus a stack of paragraphs that is cut to the room it has. */
function paragraphStack(random, x, y, w, room) {
  const elements = [];
  let cursor = y;
  const count = 1 + Math.floor(random() * 4);
  for (let index = 0; index < count; index += 1) {
    const text = makeText(random, 40 + Math.floor(random() * 160));
    const fontSize = 13 + Math.floor(random() * 4);
    // The engine measures a paragraph with its own line height; a box sized by the same rule plus a
    // little slack is a box the writer cannot overflow. Declaring lineSpacing on top would ask for
    // more height than was reserved, which is exactly the bug this generator is here to catch.
    const height = estimateTextHeight(text, w, fontSize) * 1.04;
    if (cursor + height > y + room) break;
    elements.push({
      type: 'text', text, x, y: cursor, w, h: height,
      fontFace: theme.fonts.body, fontSize, color: theme.colors.foreground
    });
    cursor += height + 0.14 + random() * 0.16;
  }
  return elements;
}

function headlinePage(random) {
  const width = PAGE.width - MARGIN * 2;
  return {
    background: theme.colors.background,
    notes: 'stress: headline',
    elements: [
      components.title(makeText(random, 8 + Math.floor(random() * 12)), {
        theme, x: MARGIN, y: 0.62, w: width, h: 0.62, fontSize: theme.sizes.title
      }),
      components.divider({ theme, x: MARGIN + 0.02, y: 1.36, w: width - 0.05 }),
      ...paragraphStack(random, MARGIN + 0.02, 1.62, width - 0.3, 4.9)
    ]
  };
}

function kpiPage(random) {
  const count = 3 + Math.floor(random() * 3);
  const items = [];
  for (let index = 0; index < count; index += 1) {
    items.push({
      label: makeText(random, 4 + Math.floor(random() * 6)),
      value: String(10 + Math.floor(random() * 990)) + (random() < 0.3 ? '%' : ''),
      note: makeText(random, 10 + Math.floor(random() * 26))
    });
  }
  const page = templates.kpi({ theme, title: makeText(random, 8 + Math.floor(random() * 12)), items });
  page.elements.push(...paragraphStack(random, MARGIN + 0.02, 4.3, PAGE.width - MARGIN * 2 - 0.3, 2.2));
  return page;
}

function tablePage(random) {
  const width = PAGE.width - MARGIN * 2;
  const columns = 3 + Math.floor(random() * 3);
  const rows = 3 + Math.floor(random() * 9);
  const header = [];
  for (let index = 0; index < columns; index += 1) {
    header.push({ text: makeText(random, 2 + Math.floor(random() * 4)), options: { bold: true } });
  }
  const body = [];
  for (let row = 0; row < rows; row += 1) {
    const cells = [];
    for (let column = 0; column < columns; column += 1) {
      cells.push(random() < 0.35 ? String(Math.floor(random() * 9000)) : makeText(random, 3 + Math.floor(random() * 9)));
    }
    body.push(cells);
  }
  const height = Math.min(4.9, 0.44 + rows * 0.34);
  return {
    background: theme.colors.surface,
    notes: 'stress: table ' + columns + 'x' + rows,
    elements: [
      components.title(makeText(random, 8 + Math.floor(random() * 12)), {
        theme, x: MARGIN, y: 0.62, w: width, h: 0.62, fontSize: theme.sizes.title
      }),
      components.divider({ theme, x: MARGIN + 0.02, y: 1.36, w: width - 0.05 }),
      {
        type: 'table', x: MARGIN + 0.02, y: 1.66, w: width - 0.05, h: height,
        options: { fontSize: 12, valign: 'middle' }, rows: [header].concat(body)
      }
    ]
  };
}

function chartPage(random) {
  const width = PAGE.width - MARGIN * 2;
  const seriesCount = 2 + Math.floor(random() * 2);
  const categories = 4 + Math.floor(random() * 5);
  const labels = [];
  for (let index = 0; index < categories; index += 1) labels.push(String(index + 1) + '月');
  const data = [];
  for (let series = 0; series < seriesCount; series += 1) {
    const values = [];
    for (let index = 0; index < categories; index += 1) values.push(Math.floor(random() * 900) / 10);
    data.push({ name: makeText(random, 4 + Math.floor(random() * 5)), labels, values });
  }
  const kind = random() < 0.5 ? 'bar' : 'line';
  return {
    background: theme.colors.surface,
    notes: 'stress: chart ' + kind,
    elements: [
      components.title(makeText(random, 8 + Math.floor(random() * 12)), {
        theme, x: MARGIN, y: 0.62, w: width, h: 0.62, fontSize: theme.sizes.title
      }),
      components.divider({ theme, x: MARGIN + 0.02, y: 1.36, w: width - 0.05 }),
      {
        type: 'chart', chartType: kind, x: MARGIN + 0.02, y: 1.72, w: width - 0.3, h: 4.6,
        data, options: { showLegend: true, barDir: 'col' }
      }
    ]
  };
}

function columnsPage(random) {
  const gap = 0.4;
  const columnWidth = (PAGE.width - MARGIN * 2 - gap) / 2;
  const elements = [
    components.title(makeText(random, 8 + Math.floor(random() * 12)), {
      theme, x: MARGIN, y: 0.62, w: PAGE.width - MARGIN * 2, h: 0.62, fontSize: theme.sizes.title
    }),
    components.divider({ theme, x: MARGIN + 0.02, y: 1.36, w: PAGE.width - MARGIN * 2 - 0.05 })
  ];
  [0, 1].forEach((column) => {
    const x = MARGIN + column * (columnWidth + gap);
    elements.push({ type: 'shape', x, y: 1.66, w: columnWidth, h: 4.9, radius: theme.radii.medium, fill: theme.colors.surface, lineColor: theme.colors.border, lineWidth: 0.8 });
    elements.push(...paragraphStack(random, x + 0.22, 1.88, columnWidth - 0.44, 4.4));
  });
  return { background: theme.colors.background, notes: 'stress: columns', elements };
}

/** Two containers side by side, each holding a stack of paragraphs the engine must place. */
function nestedPage(random) {
  const width = PAGE.width - MARGIN * 2;
  const half = (width - 0.4) / 2;
  const block = (x) => ({
    type: 'container', x, y: 1.7, w: half, h: 4.8,
    // Children carry boxes relative to the container: the stack already returns them that way
    // (it was asked to start at 0,0), so they must not be remapped.
    children: paragraphStack(random, 0.22, 0.22, half - 0.44, 4.4)
  });
  return {
    background: theme.colors.background,
    notes: 'stress: containers',
    elements: [
      components.title(makeText(random, 8 + Math.floor(random() * 12)), { theme, x: MARGIN, y: 0.62, w: width, h: 0.62, fontSize: theme.sizes.title }),
      components.divider({ theme, x: MARGIN + 0.02, y: 1.36, w: width - 0.05 }),
      block(MARGIN), block(MARGIN + half + 0.4)
    ]
  };
}

const PAGES = [headlinePage, headlinePage, kpiPage, tablePage, chartPage, columnsPage, nestedPage];

function buildDeck(slides, seed) {
  const random = mulberry32(seed);
  const built = [];
  for (let index = 0; index < slides; index += 1) {
    built.push(PAGES[index % PAGES.length](random));
  }
  return {
    title: 'Native stress deck (' + slides + ' pages, seed ' + seed + ')',
    author: 'native scripts/stress_spec.js',
    language: 'zh-CN',
    pageSize: 'wide',
    theme,
    slides: built
  };
}

function parseArgs(argv) {
  const options = { slides: 40, seed: 7, out: null, budget: 180, quiet: false };
  for (let index = 0; index < argv.length; index += 1) {
    const token = argv[index];
    if (token === '--slides') options.slides = Number(argv[index += 1]);
    else if (token === '--seed') options.seed = Number(argv[index += 1]);
    else if (token === '--out') options.out = argv[index += 1];
    else if (token === '--budget') options.budget = Number(argv[index += 1]);
    else if (token === '--quiet') options.quiet = true;
    else if (token === '--help' || token === '-h') options.help = true;
    else throw new Error('unknown argument ' + token);
  }
  return options;
}

async function main() {
  const options = parseArgs(process.argv.slice(2));
  if (options.help) {
    process.stdout.write('usage: node scripts/stress_spec.js --slides N --seed S --out deck.pptx [--budget secs]\n');
    return;
  }
  const output = options.out || path.join(os.tmpdir(), 'native-stress-' + options.slides + '-' + options.seed + '.pptx');
  const deck = buildDeck(options.slides, options.seed);
  const errors = validateDeck(deck);
  if (errors.length) {
    process.stderr.write('stress spec is invalid: ' + JSON.stringify(errors.slice(0, 5)) + '\n');
    process.exitCode = 1;
    return;
  }
  const started = Date.now();
  const result = await generatePptx(deck, output);
  const elapsed = Date.now() - started;

  // The invariants that matter for a native deck: nothing outside the canvas, no text taller than
  // its box, no two text boxes on top of each other. They are checked on the boxes that were
  // written, so a bug in the layout cannot hide behind a plausible spec.
  const warnings = [];
  (result.laidOut || []).forEach((elements, index) => {
    validateSlide(elements, result.pageSize).forEach((warning) => warnings.push({ slide: index + 1, code: warning.code, message: warning.message }));
  });
  const pages = (result.laidOut || []).length;
  const objects = (result.laidOut || []).reduce((sum, elements) => sum + elements.length, 0);

  const problems = [];
  if (pages !== options.slides) problems.push(pages + ' page(s) written, expected ' + options.slides);
  if (warnings.length) problems.push(warnings.length + ' layout warning(s): ' + JSON.stringify(warnings.slice(0, 3)));
  if (elapsed > options.budget * 1000) problems.push('took ' + elapsed + 'ms, budget ' + options.budget * 1000 + 'ms');
  if (!fs.existsSync(output)) problems.push('no file at ' + output);

  if (!options.quiet) {
    process.stdout.write('stress: ' + pages + ' page(s), ' + objects + ' element(s), '
      + String(result.droppedPictures ? result.droppedPictures.length : 0) + ' dropped picture(s), '
      + elapsed + 'ms of ' + options.budget + 's budget\n');
    process.stdout.write('wrote ' + output + '\n');
  }
  if (problems.length) {
    problems.forEach((problem) => process.stderr.write('PROBLEM: ' + problem + '\n'));
    process.exitCode = 1;
  }
}

// The deck builder is exported so a probe (and a test) can ask what it generates without writing
// a file, and so a failure can be reproduced from the seed that produced it.
module.exports = { buildDeck, PAGES };

if (require.main === module) {
  main().catch((error) => {
    process.stderr.write(String(error && error.stack ? error.stack : error) + '\n');
    process.exitCode = 1;
  });
}
