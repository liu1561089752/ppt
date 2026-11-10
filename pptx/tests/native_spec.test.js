'use strict';

/**
 * The Deck Spec is the contract the writer consumes: what an HTML attribute declares has to arrive
 * on the element, and what the spec cannot carry has to be named in the report.
 *
 * These tests read the spec that `convertHtml`/`buildDeckSpec` produce from real markup, and - for
 * the claims that are about the package rather than the spec - the XML the writer actually emits.
 * A few of them deliberately record *today's* shape where the design is not carried; they are
 * named "(today's shape)" and are meant to fail the day somebody closes the gap, so the difference
 * cannot disappear quietly.
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const JSZip = require(require.resolve('jszip', { paths: [require.resolve('../native/engine/native_pptx')] }));
const { convertHtml } = require('../native/pipeline/index.js');
const { buildDeckSpec, imageElementFromNode, tileOf } = require('../native/pipeline/deck_builder');
const { generatePptx } = require('../native/engine/native_pptx');
const { makePng } = require('../native/scripts/sample_image');

const PNG = 'data:image/png;base64,' + makePng(40, 20).toString('base64');
const PAGE = { width: 13.3333, height: 7.5 };

/** Every element of every slide, depth first - a picture can live inside a container. */
function flatten(elements, out = []) {
  (elements || []).forEach((element) => {
    out.push(element);
    flatten(element.children, out);
  });
  return out;
}

function specOf(nodes) {
  const analysis = {
    pageSize: PAGE,
    title: 'spec',
    variables: {},
    unsupported: [],
    slides: [{ nodes }]
  };
  return buildDeckSpec(analysis, {}).deck;
}

function elementsOfType(deck, type) {
  return deck.slides.flatMap((slide) => flatten(slide.elements)).filter((element) => element.type === type);
}

/**
 * Write a deck and hand back a reader for one part of the package.
 *
 * The deck is cloned first: PptxGenJS rewrites each cell's options while it builds the table
 * (`valign`, an expanded `border`, `_lineIdx`), so writing a shared deck would let one test's
 * output change what the next test reads out of the spec.
 */
async function partOf(deck, name) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'native-spec-'));
  const output = path.join(directory, 'deck.pptx');
  try {
    await generatePptx(JSON.parse(JSON.stringify(deck)), output);
    const zip = await JSZip.loadAsync(fs.readFileSync(output));
    const file = zip.file(name);
    return file ? file.async('string') : null;
  } finally {
    fs.rmSync(directory, { recursive: true, force: true });
  }
}

/* ---------------------------------------------------------------------------------------------
 * ITEM 1 - a repeating background is a native tile.
 *
 * The analyzer resolves the pattern (which axes repeat, the tile cell in inches) because it is the
 * only stage with the CSS and the source's natural size. The builder's job is to hand those numbers
 * to the element unchanged, and to draw the picture at the box the pattern fills: `a:tile` repeats
 * inside the picture's frame, so a frame shrunk to the tile cell would show one cell, not a pattern.
 * ------------------------------------------------------------------------------------------- */

test('a background layer that repeats carries its tile cell and is drawn at its box', () => {
  const deck = specOf([{
    id: 1, kind: 'image', tag: 'div', classes: [], style: {},
    x: 1, y: 1, w: 3, h: 2, src: PNG, alt: '', objectFit: 'contain',
    backgroundSize: '40px 40px', backgroundSizeSpec: [{ inches: 0.4167 }, { inches: 0.4167 }],
    focus: 'center',
    tile: { x: true, y: true, width: 0.4167, height: 0.4167 }
  }]);
  const image = elementsOfType(deck, 'image')[0];
  assert.deepEqual(image.tile, { x: true, y: true, width: 0.4167, height: 0.4167 });
  // The frame is the box, not the 0.42in cell and not the source's natural size.
  assert.deepEqual({ x: image.x, y: image.y, w: image.w, h: image.h }, { x: 1, y: 1, w: 3, h: 2 });
  assert.equal(image.fit, 'stretch');
  // The focus still travels: it is what the engine turns into `a:tile`'s tx/ty offset.
  assert.equal(image.focus, 'center');
});

test('a container background layer carries its tile onto the picture it draws', () => {
  const deck = specOf([{
    id: 2, kind: 'group', tag: 'div', classes: [], style: {},
    x: 1, y: 4, w: 4, h: 2,
    backgroundImage: {
      src: PNG, fit: 'contain', size: '40px 40px',
      sizeSpec: [{ inches: 0.4167 }, { inches: 0.4167 }], focus: 'center',
      tile: { x: true, y: false, width: 0.5, height: 0.25 }
    },
    children: [{
      id: 3, kind: 'text', tag: 'p', classes: [], style: {}, text: '上',
      x: 1, y: 4, w: 1, h: 0.5, fontSizePt: 12, lineHeight: 1.2
    }]
  }]);
  const image = elementsOfType(deck, 'image')[0];
  assert.deepEqual(image.tile, { x: true, y: false, width: 0.5, height: 0.25 });
  assert.deepEqual({ x: image.x, y: image.y, w: image.w, h: image.h }, { x: 1, y: 4, w: 4, h: 2 });
  assert.equal(image.fit, 'stretch');
});

test('a text box with a tiled background carries the tile under its words', () => {
  const deck = specOf([{
    id: 4, kind: 'text', tag: 'p', classes: [], style: {}, text: '花纹',
    x: 7, y: 1, w: 3, h: 1.5, fontSizePt: 14, lineHeight: 1.3,
    bgImage: {
      src: PNG, fit: 'contain', size: '40px 40px', focus: 'center',
      tile: { x: true, y: true, width: 0.5, height: 0.5 }
    }
  }]);
  const elements = flatten(deck.slides[0].elements);
  const image = elements.find((element) => element.type === 'image');
  const text = elements.find((element) => element.type === 'text');
  assert.deepEqual(image.tile, { x: true, y: true, width: 0.5, height: 0.5 });
  assert.deepEqual({ x: image.x, y: image.y, w: image.w, h: image.h }, { x: 7, y: 1, w: 3, h: 1.5 });
  assert.equal(image.fit, 'stretch');
  // The words still sit on top, and the pair is still one container.
  assert.equal(text.text, '花纹');
});

test('a tile with no positive cell size is not carried, so the picture keeps the size it drew before', () => {
  // The tile scale is a division by the cell; a zero cell would be a broken picture rather than a
  // pattern. Nothing is guessed here - the analyzer that declared the pattern has to say so.
  assert.equal(tileOf({ tile: { x: true, y: true, width: 0, height: 0.4 } }), undefined);
  assert.equal(tileOf({ tile: { x: true, y: true, width: 0.4 } }), undefined);
  assert.equal(tileOf({}), undefined);
  assert.equal(tileOf(null), undefined);

  const deck = specOf([{
    id: 5, kind: 'image', tag: 'div', classes: [], style: {},
    x: 1, y: 1, w: 3, h: 2, src: PNG, alt: '', objectFit: 'contain',
    backgroundSize: '40px 40px', backgroundSizeSpec: [{ inches: 0.4167 }, { inches: 0.4167 }],
    focus: 'center', tile: { x: true, y: true, width: 0, height: 0 }
  }]);
  const image = elementsOfType(deck, 'image')[0];
  assert.equal(image.tile, undefined);
  // The `background-size` geometry still applies, exactly as before the tile existed.
  assert.deepEqual({ w: image.w, h: image.h }, { w: 0.4167, h: 0.4167 });
});

test('a plain picture carries no tile field at all', () => {
  const element = imageElementFromNode({
    kind: 'image', x: 1, y: 1, w: 2, h: 1, src: PNG, objectFit: 'cover'
  });
  assert.equal('tile' in element, false);
  assert.equal(element.fit, 'cover');
});

test('a repeating background in real markup arrives as one image node the tile can ride on', () => {
  // The structural half of the contract: whichever stage sets `tile`, it lands on an image node
  // that the builder turns into exactly one picture element.
  const result = convertHtml(`<!doctype html><html><head><style>
    .slide { position: relative; width: 800px; height: 400px; }
    .pattern { width: 300px; height: 200px; background-repeat: repeat; background-size: 40px 40px;
      background-image: url(${PNG}); }
  </style></head><body><main class="slide"><div class="pattern"></div></main></body></html>`);
  const square = [];
  const walk = (nodes) => nodes.forEach((node) => {
    if (node.kind === 'image') square.push(node);
    walk(node.children || []);
  });
  result.analysis.slides.forEach((slide) => walk(slide.nodes));
  assert.equal(square.length, 1);
  assert.equal(square[0].backgroundSizeSpec.length, 2);
  assert.equal(Number(square[0].backgroundSizeSpec[0].inches.toFixed(4)), 0.4167);
  assert.equal(elementsOfType(result.deck, 'image').length, 1);
});

/* ---------------------------------------------------------------------------------------------
 * ITEM 2 - table styling: what the spec carries, and what only the report can name.
 * ------------------------------------------------------------------------------------------- */

const TABLE_HTML = `<!doctype html><html><head><style>
  .slide { position: relative; width: 1280px; height: 720px; padding: 40px; }
  table { border-collapse: collapse; font-size: 13px; }
  td, th { padding: 6px; border: 1px solid #ccc; }
  .merged { width: 700px; }
  .cols { width: 600px; table-layout: fixed; }
  .strip { width: 300px; }
  .strip tr:nth-child(even) { background: #eef3f7; }
  .top td { vertical-align: top; }
  .bottom td { vertical-align: bottom; }
  .spaced { border-collapse: separate; border-spacing: 8px 6px; }
</style></head><body><main class="slide">
  <table class="merged">
    <caption>表头标题</caption>
    <colgroup><col style="width: 200px"><col><col></colgroup>
    <thead><tr><th>区域</th><th>口径</th><th>金额</th></tr></thead>
    <tbody>
      <tr><td rowspan="2">华东</td><td colspan="2">合并口径 · 跨两列</td></tr>
      <tr><td>自然</td><td>968.20</td></tr>
    </tbody>
    <tfoot><tr><td>合计</td><td>—</td><td>3,696.70</td></tr></tfoot>
  </table>
  <table class="cols"><colgroup><col style="width: 120px"><col><col></colgroup>
    <tbody><tr><td>a</td><td>b</td><td>c</td></tr></tbody></table>
  <table class="strip"><tbody>
    <tr><td>一</td><td>b</td></tr>
    <tr><td>二</td><td>d</td></tr>
  </tbody></table>
  <table class="top"><tbody><tr><td>顶</td><td>两行<br>文字</td></tr></tbody></table>
  <table class="bottom"><tbody><tr><td>底</td><td>两行<br>文字</td></tr></tbody></table>
  <table class="spaced"><tbody><tr><td>间距</td><td>边框分离</td></tr></tbody></table>
</main></body></html>`;

const tableResult = convertHtml(TABLE_HTML);
const tableSpecs = elementsOfType(tableResult.deck, 'table');
const merged = tableSpecs[0];
const fixedColumns = tableSpecs[1];
const striped = tableSpecs[2];
const topAligned = tableSpecs[3];
const bottomAligned = tableSpecs[4];

test('a merged cell keeps its colspan and rowspan, in the spec and in the written table', async () => {
  // col 0 is the rowspan, col 1..2 the colspan: the grid stays three columns wide.
  assert.equal(merged.rows[1][0].options.rowspan, 2);
  assert.equal(merged.rows[1][1].options.colspan, 2);
  assert.equal(merged.options.colW.length, 3);
  assert.equal(merged.rows.length, 4);

  const slide = await partOf(tableResult.deck, 'ppt/slides/slide1.xml');
  const table = (slide.match(/<a:tbl>[\s\S]*?<\/a:tbl>/u) || [''])[0];
  // DrawingML spells a merge on the cell element: `gridSpan`/`rowSpan` on the first cell, and
  // `hMerge`/`vMerge` markers on the cells the merge covers.
  assert.match(table, /<a:tc rowSpan="2">/u);
  assert.match(table, /<a:tc gridSpan="2">/u);
  assert.match(table, /<a:tc hMerge="1">/u);
  assert.match(table, /<a:tc vMerge="1">/u);
});

test('a <caption> is a text box above the grid and the table starts below it', () => {
  const caption = flatten(tableResult.deck.slides[0].elements)
    .find((element) => element.type === 'text' && element.text === '表头标题');
  assert.ok(caption, 'caption text box was not emitted');
  assert.equal(Number(caption.y.toFixed(4)), 0.4167);
  assert.equal(Number((caption.y + caption.h).toFixed(4)), Number(merged.y.toFixed(4)));
  // The caption is not repeated inside the grid.
  assert.equal(merged.rows.flat().some((cell) => String(cell.text).includes('表头标题')), false);
});

test('colgroup widths and table-layout: fixed become the table column widths', () => {
  // 120px declared, the other two share what is left of the 600px table.
  assert.equal(fixedColumns.options.colW[0], 1.25);
  assert.equal(Number(fixedColumns.options.colW.reduce((sum, value) => sum + value, 0).toFixed(3)), 6.25);
  // The merged table's declared 200px column is the first one.
  assert.equal(merged.options.colW[0], Number((200 / 96).toFixed(3)));
});

test('row striping reaches every cell of the row as its fill', () => {
  // `tr:nth-child(even)` is the row a browser tints; the cell inherits it.
  assert.deepEqual(striped.rows[1].map((cell) => cell.options.fill), [
    { color: 'EEF3F7' }, { color: 'EEF3F7' }
  ]);
  assert.equal(striped.rows[0][0].options.fill, undefined);
});

test('a declared per-cell vertical-align travels with the cell', () => {
  assert.equal(topAligned.rows[0][0].options.valign, 'top');
  assert.equal(bottomAligned.rows[0][0].options.valign, 'bottom');
  // A cell that declares nothing keeps the table's anchoring. That default is not a guess: measured
  // in Chrome, the single line of a 1-line cell sat 20.75px below a 61.75px cell's top, which is
  // the centred offset (21.375px), so a browser centres an undeclared cell and the spec says so.
  assert.equal(striped.rows[0][0].options.valign, undefined);
  assert.equal(striped.options.valign, 'middle');
});

test('border-spacing has no native spelling: it is named, and nothing about it reaches the spec', () => {
  const named = tableResult.report.unsupportedDetails
    .filter((entry) => entry.property === 'borderSpacing');
  assert.equal(named.length, 1);
  assert.equal(named[0].value, '8px 6px');
  const spaced = tableSpecs[5];
  assert.equal(spaced.options.borderSpacing, undefined);
  assert.equal(spaced.options.cellSpacing, undefined);
  assert.equal(spaced.rows.flat().some((cell) => cell.options && cell.options.margin === undefined), false);
});

test('a leftover slot in a ragged row is an empty cell that keeps no fill', () => {
  // Chrome paints a `tr` background only behind the cells the row actually has: measured on a
  // 300x29 row whose second `tr` holds one cell, the pixel inside that cell was #DDEEFF and the
  // pixel in the empty tail of the same row was #FFFFFF. The filler cells must therefore stay
  // unfilled, or the deck would stripe an area the browser leaves white.
  const ragged = convertHtml(`<!doctype html><html><head><style>
    .slide { position: relative; width: 800px; height: 400px; }
    table { border-collapse: collapse; font-size: 13px; }
    td { padding: 6px; }
    .rag tr:nth-child(2) { background: #ddeeff; }
  </style></head><body><main class="slide"><table class="rag"><tbody>
    <tr><td>宽行</td><td>b</td><td>c</td></tr>
    <tr><td>短行</td></tr>
  </tbody></table></main></body></html>`);
  const table = elementsOfType(ragged.deck, 'table')[0];
  assert.equal(table.rows[1].length, 3);
  assert.deepEqual(table.rows[1][0].options.fill, { color: 'DDEEFF' });
  assert.equal(table.rows[1][1].options.fill, undefined);
  assert.equal(table.rows[1][2].options.fill, undefined);
});

test('a <tfoot> is drawn after the body whatever the source order', () => {
  // Browsers place a footer row after every body row whatever the source order; the analyzer used
  // to keep the DOM order, so a source that wrote <tfoot> first drew the total above the rows.
  const footerFirst = convertHtml(`<!doctype html><html><head><style>
    .slide { position: relative; width: 800px; height: 400px; }
    table { border-collapse: collapse; font-size: 13px; }
    td { padding: 6px; }
  </style></head><body><main class="slide"><table><tbody></tbody>
    <tfoot><tr><td>页脚合计</td></tr></tfoot>
    <tbody><tr><td>正文一</td></tr><tr><td>正文二</td></tr></tbody>
  </table></main></body></html>`);
  const table = elementsOfType(footerFirst.deck, 'table')[0];
  assert.deepEqual(table.rows.map((row) => row[0].text), ['正文一', '正文二', '页脚合计']);
  // A tfoot is not a header: nothing is repeated on a continuation page.
  const footerLast = convertHtml(`<!doctype html><html><head><style>
    .slide { position: relative; width: 800px; height: 400px; }
    table { border-collapse: collapse; font-size: 13px; }
    td { padding: 6px; }
  </style></head><body><main class="slide"><table>
    <tbody><tr><td>正文一</td></tr></tbody>
    <tfoot><tr><td>页脚合计</td></tr></tfoot>
  </table></main></body></html>`);
  const ordered = elementsOfType(footerLast.deck, 'table')[0];
  assert.deepEqual(ordered.rows.map((row) => row[0].text), ['正文一', '页脚合计']);
  assert.equal(ordered.headerRows, undefined);
});

/* ---------------------------------------------------------------------------------------------
 * ITEM 3 - chart spec capability.
 *
 * A chart element is `chartType` + `data` + the writer's own options object verbatim. Everything
 * the analyzer resolves from `data-chart-*` therefore travels: colours, legend, labels, title, axis
 * titles and gridlines. It is one object, so these tests read it field by field.
 * ------------------------------------------------------------------------------------------- */

const chartResult = convertHtml(
  fs.readFileSync(path.join(__dirname, '..', 'examples', 'pipeline-chart.html'), 'utf8')
);
const chart = elementsOfType(chartResult.deck, 'chart')[0];

test('a chart carries its declared styling in the writer\'s own options', () => {
  assert.equal(chart.chartType, 'bar');
  assert.deepEqual(chart.data.map((series) => series.name), ['收入', '成本']);
  assert.deepEqual(chart.data[0].values, [320, 418, 502, 587]);
  assert.deepEqual(chart.options.chartColors, ['F2A24C', '4FB3A8']);
  assert.equal(chart.options.showLegend, true);
  assert.equal(chart.options.legendPos, 'b');
  assert.equal(chart.options.showTitle, true);
  assert.equal(chart.options.title, '季度收入与成本（万元）');
  assert.equal(chart.options.catAxisTitle, '季度');
  assert.equal(chart.options.valAxisTitle, '万元');
  assert.equal(chart.options.showCatAxisTitle, true);
  assert.equal(chart.options.showValAxisTitle, true);
  assert.equal(chart.options.showValue, true);
  assert.deepEqual(chart.options.valGridLine, { style: 'none' });
});

test('a chart element has no styling fields of its own: they live in options (today\'s shape)', async () => {
  // A future refactor that lifts `legend`/`title`/`seriesColours` onto the element breaks this test
  // on purpose: the writer reads them from options, not from the element.
  ['legend', 'title', 'labels', 'seriesColours', 'axisTitles'].forEach((field) => {
    assert.equal(field in chart, false, field + ' should not be on the chart element');
  });
  // The declared value format is carried under the name the writer uses for DATA LABELS.
  // PptxGenJS reads `valLabelFormatCode` only for a chart's data table, so the earlier spelling
  // wrote the writer's default into `c:dLbls` and dropped the design's format in silence.
  assert.equal(chart.options.dataLabelFormatCode, '#,##0');
  const slide = await partOf(chartResult.deck, 'ppt/charts/chart1.xml');
  assert.ok(slide, 'chart part was not written');
});
