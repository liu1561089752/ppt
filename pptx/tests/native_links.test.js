'use strict';

// Picture hyperlinks and table-cell bullet markers, verified on the package rather than on
// the spec: both are things the writer drops in silence, so only the emitted XML says whether
// the deck really carries them.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const JSZip = require(require.resolve('jszip', { paths: [require.resolve('../native/engine/native_pptx')] }));
const { generatePptx, patchCellBullets, patchHyperlinkRelEscapes, bulletParagraphIndent,
  cellBulletIndentBase, patchShapeHyperlinks } = require('../native/engine/native_pptx');
const { imageElementFromNode, anchorHrefOf, anchorLinkFits, anchorLinkObjects, buildDeckSpec } =
  require('../native/pipeline/deck_builder');
const { makePng } = require('../native/scripts/sample_image');

const PNG = 'data:image/png;base64,' + makePng(120, 60).toString('base64');
const HYPERLINK_TYPE = 'http://schemas.openxmlformats.org/officeDocument/2006/relationships/hyperlink';

/**
 * Write a deck and hand back a reader for its parts.
 * The deck comes back too, because some patches are also called directly.
 */
async function writePptx(deck) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'native-links-'));
  const output = path.join(directory, 'deck.pptx');
  const result = await generatePptx(deck, output);
  return {
    output,
    result,
    deck,
    async xml(name = 'ppt/slides/slide1.xml') {
      const zip = await JSZip.loadAsync(fs.readFileSync(output));
      const file = zip.file(name);
      return file ? file.async('string') : null;
    },
    async slide() {
      return this.xml('ppt/slides/slide1.xml');
    },
    async relationships() {
      return this.xml('ppt/slides/_rels/slide1.xml.rels');
    },
    cleanup() {
      fs.rmSync(directory, { recursive: true, force: true });
    }
  };
}

function writeDeck(elements) {
  return writePptx({ slides: [{ elements }] });
}

function pictureElements(slide) {
  return slide.match(/<p:pic>[\s\S]*?<\/p:pic>/gu) || [];
}

/** Every table on the slide, as its cells in row-major order, each cell as its paragraphs. */
function tableCells(slide) {
  return (slide.match(/<a:tbl>[\s\S]*?<\/a:tbl>/gu) || []).map((table) =>
    (table.match(/<a:tc\b[\s\S]*?<\/a:tc>/gu) || []).map(
      (cell) => cell.match(/<a:p>[\s\S]*?<\/a:p>/gu) || []
    ));
}

test('a picture inside an anchor carries its url as a native hyperlink', async () => {
  const url = 'https://example.com/x?a=1&b=2';
  const deck = await writeDeck([
    { type: 'image', data: PNG, x: 0.5, y: 0.5, w: 2, h: 1, fit: 'contain', hyperlink: { url } }
  ]);
  try {
    const slide = await deck.slide();
    const clicks = slide.match(/<a:hlinkClick[^>]*\/>/gu) || [];
    assert.equal(clicks.length, 1, 'exactly one click target on the picture');
    const relId = /r:id="([^"]+)"/u.exec(clicks[0])[1];
    const relationships = await deck.relationships();
    const external = (relationships.match(/<Relationship [^>]*TargetMode="External"[^>]*\/>/gu) || []);
    assert.equal(external.length, 1, 'one external relationship, and only one');
    assert.ok(external[0].includes('Type="' + HYPERLINK_TYPE + '"'), 'it is a hyperlink relationship');
    // The url travels verbatim, so the part carries it escaped once: an XML attribute cannot
    // hold a bare `&`, and the writer does not escape a picture's target by itself.
    assert.ok(external[0].includes('Target="' + url.replace(/&/gu, '&amp;') + '"'),
      'the target is the url, escaped exactly once');
    assert.ok(external[0].includes('Id="' + relId + '"'), 'the click points at that relationship');
    // A picture with no `alt` has no description: the writer used to offer the source path.
    assert.equal(/descr="([^"]*)"/u.exec(pictureElements(slide)[0])[1], '');
  } finally {
    deck.cleanup();
  }
});

test('a query string in a picture url leaves the relationship part well formed', async () => {
  const url = 'https://e.example/x?a=1&b=2';
  const deck = await writeDeck([
    { type: 'image', data: PNG, x: 0.5, y: 0.5, w: 2, h: 1, fit: 'contain', hyperlink: { url } },
    { type: 'text', x: 0.5, y: 2, w: 5, h: 0.5, text: [{ text: '文字链接', options: { hyperlink: { url } } }] }
  ]);
  try {
    const relationships = await deck.relationships();
    assert.ok(relationships.includes('Target="https://e.example/x?a=1&amp;b=2"'),
      'the picture target is escaped');
    assert.equal((relationships.match(/&(?!(?:amp|lt|gt|quot|apos|#[0-9]+|#x[0-9A-Fa-f]+);)/gu) || []).length,
      0, 'no bare ampersand is left in the part');
    assert.ok(!relationships.includes('&amp;amp;'), 'the already escaped text target is not escaped twice');
    assert.equal((relationships.match(/TargetMode="External"/gu) || []).length, 2,
      'both links survived the repair');
    // The repair reads its own output as already escaped, so running it again is a no-op.
    assert.equal(await patchHyperlinkRelEscapes(deck.output), false);
    assert.equal(await deck.relationships(), relationships);
  } finally {
    deck.cleanup();
  }
});

test('a picture without a link writes neither a click nor a relationship', async () => {
  const deck = await writeDeck([
    { type: 'image', data: PNG, x: 0.5, y: 0.5, w: 2, h: 1, fit: 'contain' }
  ]);
  try {
    const slide = await deck.slide();
    assert.equal((slide.match(/<a:hlinkClick/gu) || []).length, 0);
    assert.ok(!(await deck.relationships()).includes(HYPERLINK_TYPE));
  } finally {
    deck.cleanup();
  }
});

test('a linked picture keeps the alt text the source declared', async () => {
  const deck = await writeDeck([
    { type: 'image', data: PNG, x: 0.5, y: 0.5, w: 2, h: 1, fit: 'contain',
      altText: '年度对比图', hyperlink: { url: 'https://example.com/report' } }
  ]);
  try {
    const slide = await deck.slide();
    assert.match(pictureElements(slide)[0], /descr="年度对比图"/u);
    assert.equal((slide.match(/<a:hlinkClick/gu) || []).length, 1);
  } finally {
    deck.cleanup();
  }
});

test('the deck builder carries an anchor href and drops an in-page fragment', () => {
  const node = (href) => ({
    kind: 'image', tag: 'img', x: 1, y: 1, w: 2, h: 1, src: 'photo.png',
    objectFit: 'fill', href
  });
  const url = imageElementFromNode(node('https://example.com/x?a=1&b=2')).hyperlink;
  assert.deepEqual(url, { url: 'https://example.com/x?a=1&b=2' }, 'the url is not rewritten');
  assert.deepEqual(imageElementFromNode(node('mailto:team@example.com')).hyperlink,
    { url: 'mailto:team@example.com' });
  assert.deepEqual(imageElementFromNode(node('../docs/x.html')).hyperlink,
    { url: '../docs/x.html' });
  // A `#fragment` names a place in the HTML page; the deck has no slide to jump to, and a
  // relationship to a bare fragment navigates nowhere.
  assert.equal(imageElementFromNode(node('#section-2')).hyperlink, undefined);
  assert.equal(imageElementFromNode(node(undefined)).hyperlink, undefined);
});

/** A header row, then one cell that lists two items, then a cell that does not list. */
function listTable() {
  return [{
    type: 'table', x: 0.5, y: 0.5, w: 6, h: 2.4, options: { colW: [3, 3] },
    rows: [
      [{ text: '项目', options: {} }, { text: '说明', options: {} }],
      [{ text: [
        { text: '甲', options: { bullet: { type: 'bullet' }, breakLine: true } },
        { text: '乙', options: { bullet: { type: 'bullet' } } }
      ], options: {} }, { text: '没有列表', options: {} }]
    ]
  }];
}

test('a bullet in a table cell reaches the cell paragraph, and only that paragraph', async () => {
  const deck = await writeDeck(listTable());
  try {
    const slide = await deck.slide();
    assert.equal((slide.match(/<a:buChar char="•"\/>/gu) || []).length, 2, 'one marker per item');
    // A cell is not a text box: a quarter inch of recess, the marker hanging in it, and the
    // marker pinned at the size of its own text.
    assert.ok(slide.includes('<a:pPr marL="228600" indent="-228600">'
      + '<a:buSzPct val="100000"/><a:buChar char="•"/></a:pPr>'),
    'the marker rides the compact cell indent');
    const [cells] = tableCells(slide);
    // Row-major: header, header, list cell, plain cell.
    assert.ok(!cells[0][0].includes('<a:buChar'), 'a header cell is untouched');
    assert.ok(!cells[1][0].includes('<a:buChar'), 'a header cell is untouched');
    assert.match(cells[3][0], /<a:buNone\/>/u);
    assert.ok(!cells[3][0].includes('<a:buChar'), 'a cell that does not list stays plain');
    assert.match(cells[2][0], /<a:buChar char="•"\/>/u);
    assert.match(cells[2][1], /<a:buChar char="•"\/>/u);
    assert.match(cells[2][0], /<a:t>甲<\/a:t>/u, 'the marker went to the paragraph it was declared on');
    assert.match(cells[2][1], /<a:t>乙<\/a:t>/u);
  } finally {
    deck.cleanup();
  }
});

test('a numbered cell list writes the numbering the spec declared', async () => {
  const deck = await writeDeck([{
    type: 'table', x: 0.5, y: 0.5, w: 6, h: 1.6, options: { colW: [6] },
    rows: [[{ text: [
      { text: '一', options: { bullet: { type: 'number', startAt: 3 }, breakLine: true } },
      { text: '二', options: { bullet: { type: 'number' } } }
    ], options: {} }]]
  }]);
  try {
    const slide = await deck.slide();
    assert.equal((slide.match(/<a:buAutoNum/gu) || []).length, 2);
    // Only the paragraph that really begins the count says where it begins; the next one
    // continues it, the way a `<ol>` numbers.
    assert.ok(slide.includes('<a:buAutoNum type="arabicPeriod" startAt="3"/>'));
    assert.ok(slide.includes('<a:buAutoNum type="arabicPeriod"/>'));
    // The marker's children keep the order the schema requires, once each: the writer already
    // wrote a size and a font of its own for a numbered cell paragraph.
    assert.ok(slide.includes('<a:buSzPct val="100000"/><a:buFont typeface="+mj-lt"/>'
      + '<a:buAutoNum type="arabicPeriod" startAt="3"/>'), 'size, then font, then the marker');
    assert.equal((slide.match(/<a:buSzPct/gu) || []).length, 2, 'one size per paragraph, not two');
    assert.equal((slide.match(/<a:buFont /gu) || []).length, 2, 'one font per paragraph, not two');
  } finally {
    deck.cleanup();
  }
});

test('a nested cell marker keeps its own glyph and its own indent step', async () => {
  const deck = await writeDeck([{
    type: 'table', x: 0.5, y: 0.5, w: 6, h: 1.8, options: { colW: [6] },
    rows: [[{ text: [
      { text: '父', options: { bullet: { type: 'bullet' }, breakLine: true } },
      // A nested `<ul>` draws a hollow circle, not the filled one its parent draws.
      { text: '子', options: { bullet: { type: 'bullet', characterCode: '25CB' }, indentLevel: 1 } }
    ], options: {} }]]
  }]);
  try {
    const slide = await deck.slide();
    assert.ok(slide.includes('<a:pPr marL="228600" indent="-228600">'
      + '<a:buSzPct val="100000"/><a:buChar char="•"/></a:pPr>'));
    // One more quarter inch per nested level, not the writer's 27pt text-box margin: a nested
    // item must step in, but it must not jump to twice its parent's recess.
    assert.match(slide,
      /<a:pPr[^>]*marL="457200" indent="-228600"[^>]*><a:buSzPct val="100000"\/><a:buChar char="○"\/>/u);
  } finally {
    deck.cleanup();
  }
});

test('a cell that declares its own list recess is honoured', async () => {
  // 18px is what the contract fixture sets: `ul, ol { padding-left: 18px }`, i.e. 0.1875in.
  const deck = await writeDeck([{
    type: 'table', x: 0.5, y: 0.5, w: 6, h: 1.4, options: { colW: [6] },
    rows: [[{ text: [
      { text: '甲', options: { bullet: { type: 'bullet' }, breakLine: true } },
      { text: '乙', options: { bullet: { type: 'bullet' } } }
    ], options: { listIndent: 0.1875 } }]]
  }]);
  try {
    const slide = await deck.slide();
    assert.ok(slide.includes('<a:pPr marL="171450" indent="-171450">'),
      'the declared recess replaces the default quarter inch');
  } finally {
    deck.cleanup();
  }
});

test('a cell indent pair steps a quarter inch per level and is never a text-box margin', () => {
  assert.equal(bulletParagraphIndent(0), ' marL="228600" indent="-228600"');
  assert.equal(bulletParagraphIndent(1), ' marL="457200" indent="-228600"');
  assert.equal(bulletParagraphIndent(2), ' marL="685800" indent="-228600"');
  assert.equal(cellBulletIndentBase({ options: {} }), 228600);
  assert.equal(cellBulletIndentBase({}), 228600);
  assert.equal(cellBulletIndentBase({ options: { listIndent: 0.1875 } }), 171450);
  // A nonsense value falls back to the default rather than writing an indent of zero.
  assert.equal(cellBulletIndentBase({ options: { listIndent: -1 } }), 228600);
});

test('the marker lands in the table that declares it, not the first table on the slide', async () => {
  const plain = {
    type: 'table', x: 0.5, y: 0.5, w: 6, h: 1, options: { colW: [6] },
    rows: [[{ text: '第一张表', options: {} }]]
  };
  const listing = {
    type: 'table', x: 0.5, y: 2, w: 6, h: 1.4, options: { colW: [6] },
    rows: [[{ text: [{ text: '甲', options: { bullet: { type: 'bullet' } } }], options: {} }]]
  };
  const deck = await writeDeck([plain, listing]);
  try {
    const [first, second] = tableCells(await deck.slide());
    assert.ok(!first[0][0].includes('<a:buChar'), 'the first table has no list to mark');
    assert.match(second[0][0], /<a:buChar char="•"\/>/u);
  } finally {
    deck.cleanup();
  }
});

test('re-running the cell bullet patch does not stack a second marker', async () => {
  const deck = await writeDeck(listTable());
  try {
    const again = await patchCellBullets(deck.output, deck.deck, deck.result.laidOut);
    const slide = await deck.slide();
    assert.equal((slide.match(/<a:buChar char="•"\/>/gu) || []).length, 2);
    // Its own work is recognised as already done, so the part is not rewritten.
    assert.equal(again, false);
  } finally {
    deck.cleanup();
  }
});

test('the cell bullet patch refuses a table it cannot align', async () => {
  const deck = await writeDeck([{
    type: 'table', x: 0.5, y: 0.5, w: 6, h: 1, options: { colW: [6] },
    rows: [[{ text: 'only row', options: {} }]]
  }]);
  try {
    // The spec says two rows, the package has one: patching would write the marker into a
    // paragraph that is not the one the spec meant, so it stops instead.
    const mismatched = { slides: [{ elements: [{
      type: 'table', x: 0.5, y: 0.5, w: 6, h: 1.6, options: { colW: [6] },
      rows: [
        [{ text: [{ text: '甲', options: { bullet: { type: 'bullet' } } }], options: {} }],
        [{ text: 'second', options: {} }]
      ]
    }] }] };
    await assert.rejects(() => patchCellBullets(deck.output, mismatched),
      /Cell bullet patch alignment mismatch/u);
  } finally {
    deck.cleanup();
  }
});

const ZERO_PADDING = { top: 0, right: 0, bottom: 0, left: 0 };

/** A shape or text box whose own non-visual properties carry the click. */
const SHAPE_CLICK = /<p:cNvPr [^>]*><a:hlinkClick r:id="rId\d+" tooltip=""\/>/u;

/** The node shape the analyzer produces for `<a href class="card"><h2>标题</h2></a>`. */
function cardAnchorNode(href, style) {
  return {
    id: 1, tag: 'a', kind: 'block', href,
    x: 1, y: 1, w: 4, h: 2, contentWidth: 3.6,
    style: Object.assign({ display: 'block' }, style),
    radius: 0.12,
    padding: { top: 0.2, right: 0.2, bottom: 0.2, left: 0.2 },
    border: null,
    children: [{
      id: 2, tag: 'h2', kind: 'text',
      x: 1.2, y: 1.2, w: 3.6, h: 0.5, contentWidth: 3.6,
      style: {}, text: '标题', fontSizePt: 24, lineSpacingMultiple: 1.2,
      padding: ZERO_PADDING, border: null, children: []
    }]
  };
}

function analysisOf(node) {
  return {
    pageSize: { width: 13.333, height: 7.5 },
    variables: {},
    unsupported: [],
    title: 'cards',
    slides: [{ background: 'FFFFFF', nodes: [node] }]
  };
}

test('a link around a block lands on the card surface, and the package carries it', async () => {
  const { deck } = buildDeckSpec(analysisOf(
    cardAnchorNode('https://example.com/card?a=1&b=2', { backgroundColor: '#f2f4f3' })
  ), {});
  const container = deck.slides[0].elements[0];
  assert.equal(container.type, 'container');
  // A container is layout-only and has no `cNvPr`, so the surface it paints takes the click -
  // and so do the words above it, because the copy is what a reader aims at.
  assert.deepEqual(container.background.hyperlink, { url: 'https://example.com/card?a=1&b=2' });
  assert.deepEqual(container.children[0].hyperlink, { url: 'https://example.com/card?a=1&b=2' });

  const written = await writePptx(deck);
  try {
    const slide = await written.slide();
    const shapes = slide.match(/<p:sp>[\s\S]*?<\/p:sp>/gu) || [];
    assert.equal((slide.match(/<a:hlinkClick/gu) || []).length, 2, 'surface and words both click');
    shapes.forEach((shape) => assert.match(shape, SHAPE_CLICK));
    const relationships = await written.relationships();
    assert.match(relationships, /<Relationship [^>]*Type="[^"]*\/hyperlink" Target="https:\/\/example\.com\/card\?a=1&amp;b=2" TargetMode="External"\/>/u);
    // Two objects, one url, one relationship.
    assert.equal((relationships.match(/TargetMode="External"/gu) || []).length, 1);
  } finally {
    written.cleanup();
  }
});

test('an anchor whose box paints nothing links the objects inside it', () => {
  // No fill, no border, no radius: the container draws no surface of its own, so the link has
  // to reach the words. It must not land on nothing and vanish.
  const { deck } = buildDeckSpec(analysisOf(cardAnchorNode('https://example.com/bare', {})), {});
  const container = deck.slides[0].elements[0];
  assert.equal(container.type, 'container');
  assert.equal(container.background, undefined, 'a bare box paints no surface');
  assert.deepEqual(container.children[0].hyperlink, { url: 'https://example.com/bare' });
});

test('a card whose children cannot be packed still links every object it paints', () => {
  // An absolutely positioned child makes the container plan fail, so the card is emitted as a
  // surface plus loose children. The link has to reach both on that path too.
  const node = cardAnchorNode('https://example.com/absolute', { backgroundColor: '#eeeeee' });
  node.children[0].absolute = true;
  const { deck } = buildDeckSpec(analysisOf(node), {});
  const elements = deck.slides[0].elements;
  assert.equal(elements[0].type, 'shape', 'the surface is its own object here');
  assert.deepEqual(elements[0].hyperlink, { url: 'https://example.com/absolute' });
  assert.deepEqual(elements[1].hyperlink, { url: 'https://example.com/absolute' },
    'the words underneath are clickable too');
});

test('a link is never written twice, and every object of a card takes it once', () => {
  const text = { type: 'text', x: 0, y: 0, w: 2, h: 0.5, text: [{ text: '链接', options: {} }] };
  assert.equal(anchorLinkFits(text), true, 'a plain box can take a link');
  text.hyperlink = { url: 'https://example.com/a' };
  assert.equal(anchorLinkFits(text), false, 'a box that links is left alone');
  const runLinked = { type: 'text', x: 0, y: 0, w: 2, h: 0.5,
    text: [{ text: '链接', options: { hyperlink: { url: 'https://example.com/b' } } }] };
  assert.equal(anchorLinkFits(runLinked), false, 'a box whose run links already has its link');
  const picture = { type: 'image', path: 'p.png', hyperlink: { url: 'https://example.com/c' } };
  assert.equal(anchorLinkFits(picture), false, 'a picture keeps the link its anchor gave it');
  assert.equal(anchorLinkFits({ type: 'container' }), false, 'a container has nothing to click');
  assert.equal(anchorHrefOf({ href: '#slide-2' }), '', 'an in-page fragment is not a link');
  assert.equal(anchorHrefOf({ href: 'mailto:a@b.example' }), 'mailto:a@b.example');
  assert.equal(anchorHrefOf({}), '');

  // A card hands its url to its surface and to each line of copy, once each.
  const card = {
    type: 'container',
    background: { type: 'shape', x: 0, y: 0, w: 2, h: 1 },
    children: [
      { type: 'text', x: 0, y: 0, w: 2, h: 0.3, text: [{ text: '甲', options: {} }] },
      { type: 'text', x: 0, y: 0.4, w: 2, h: 0.3, text: [{ text: '乙', options: {} }] }
    ]
  };
  assert.equal(anchorLinkObjects(card, 'https://example.com/card'), 3, 'surface and both lines');
  assert.equal(anchorLinkObjects(card, 'https://example.com/card'), 0,
    'a second pass finds every object already linked');
});

test('a link inside a table cell rides the cell and keeps its marker', async () => {
  const deck = await writeDeck([{
    type: 'table', x: 0.5, y: 0.5, w: 6, h: 2, options: { colW: [3, 3] },
    rows: [
      [{ text: '整格链接', options: { hyperlink: { url: 'https://e.example/cell?a=1&b=2' } } },
        { text: '普通', options: {} }],
      [{ text: [{ text: '列表链接', options: { bullet: { type: 'bullet' }, hyperlink: { url: 'https://e.example/item' } } }], options: {} },
        { text: '普通', options: {} }]
    ]
  }]);
  try {
    const slide = await deck.slide();
    const cells = slide.match(/<a:tc\b[\s\S]*?<\/a:tc>/gu) || [];
    assert.match(cells[0], /<a:hlinkClick r:id="rId\d+"/u, 'the whole-cell link rides the cell text');
    assert.match(cells[2], /<a:hlinkClick r:id="rId\d+"/u, 'a linked list item keeps its link');
    assert.match(cells[2], /<a:buChar char="•"\/>/u, 'and keeps the marker the writer drops');
    assert.ok(!cells[1].includes('<a:hlinkClick'), 'a plain cell is left alone');
    assert.ok(!cells[3].includes('<a:hlinkClick'), 'a plain cell is left alone');
    const relationships = await deck.relationships();
    assert.match(relationships, /Target="https:\/\/e\.example\/cell\?a=1&amp;b=2" TargetMode="External"/u);
    assert.match(relationships, /Target="https:\/\/e\.example\/item" TargetMode="External"/u);
  } finally {
    deck.cleanup();
  }
});

test('a text box that is the whole anchor is clickable, and its runs are not linked twice', async () => {
  const deck = await writeDeck([
    { type: 'text', x: 0.5, y: 0.5, w: 3, h: 0.6, text: '整句链接',
      hyperlink: { url: 'https://e.example/box' } },
    { type: 'text', x: 0.5, y: 1.5, w: 4, h: 0.6,
      text: [{ text: '见' }, { text: '链接', options: { hyperlink: { url: 'https://e.example/run' } } }] }
  ]);
  try {
    const slide = await deck.slide();
    const shapes = slide.match(/<p:sp>[\s\S]*?<\/p:sp>/gu) || [];
    assert.match(shapes[0], SHAPE_CLICK, 'the box itself is the click target');
    // The box with an inline link keeps the click on its run and gets no second, box-level one.
    assert.ok(!SHAPE_CLICK.test(shapes[1]), 'a box whose run links gets no box-level link');
    // The click sits on the box only: the writer's own box link would also have underlined every
    // run it holds, and this design declared no underline.
    assert.ok(!/<a:rPr[^>]*\su="sng"/u.test(shapes[0]), 'the box link adds no underline');
    const relationships = await deck.relationships();
    assert.match(relationships, /Target="https:\/\/e\.example\/run" TargetMode="External"/u);
    assert.equal((relationships.match(/Target="https:\/\/e\.example\/box"/gu) || []).length, 1);
  } finally {
    deck.cleanup();
  }
});

test('the shape hyperlink patch is idempotent and keeps one relationship per url', async () => {
  const deck = await writePptx({ slides: [{ elements: [
    { type: 'shape', x: 0.5, y: 0.5, w: 3, h: 1, fill: 'F2F4F3',
      hyperlink: { url: 'https://e.example/card' } },
    { type: 'text', x: 0.6, y: 0.6, w: 2, h: 0.4, text: '标题',
      hyperlink: { url: 'https://e.example/card' } },
    { type: 'text', x: 0.6, y: 1.1, w: 2, h: 0.4, text: '副文',
      hyperlink: { url: 'https://e.example/other' } }
  ] }] });
  try {
    const before = await deck.slide();
    const beforeRels = await deck.relationships();
    assert.equal((before.match(/<a:hlinkClick/gu) || []).length, 3, 'every object carries the click');
    assert.equal((beforeRels.match(/TargetMode="External"/gu) || []).length, 2,
      'two urls, two relationships');

    const again = await patchShapeHyperlinks(deck.output, deck.deck, deck.result.laidOut);
    assert.equal(again, false, 'a second run is a no-op');
    assert.equal(await deck.slide(), before, 'the slide part is untouched');
    assert.equal(await deck.relationships(), beforeRels, 'the relationships part is untouched');
  } finally {
    deck.cleanup();
  }
});

test('the shape hyperlink patch refuses a package it cannot align', async () => {
  const deck = await writeDeck([{ type: 'text', x: 0.5, y: 0.5, w: 3, h: 0.6, text: '一',
    hyperlink: { url: 'https://e.example/one' } }]);
  try {
    // The spec claims two boxes, the package has one: writing the second click would put it on a
    // shape the spec never described, so the patch stops instead.
    const mismatched = { slides: [{ elements: [
      { type: 'text', x: 0.5, y: 0.5, w: 3, h: 0.6, text: '一', hyperlink: { url: 'https://e.example/one' } },
      { type: 'text', x: 0.5, y: 1.4, w: 3, h: 0.6, text: '二', hyperlink: { url: 'https://e.example/two' } }
    ] }] };
    await assert.rejects(() => patchShapeHyperlinks(deck.output, mismatched),
      /Shape hyperlink patch alignment mismatch/u);
  } finally {
    deck.cleanup();
  }
});

/** Convert real HTML through the pipeline, so the analyzer, builder and engine all take part. */
async function writeHtml(body) {
  const pipeline = require('../native/pipeline');
  const html = [
    '<html><head><style>.slide { width: 1280px; height: 720px; padding: 40px; }',
    '  .card { display: block; width: 320px; padding: 24px; border-radius: 12px;',
    '    background: #f2f4f3; text-decoration: none; }',
    '  td { font-size: 14px; }</style></head><body><main class="slide">',
    body,
    '</main></body></html>'
  ].join('\n');
  return writePptx(pipeline.convertHtml(html).deck);
}

test('a clickable card in real html reaches the shape non-visual properties', async () => {
  const written = await writeHtml(
    '<a href="https://example.com/card" class="card"><h2>标题</h2><p>副文</p></a>'
  );
  try {
    const slide = await written.slide();
    // The surface and both paragraphs carry the click: the copy covers most of a card, and a
    // reader who clicks the headline is clicking the card.
    assert.equal((slide.match(/<a:hlinkClick/gu) || []).length, 3, 'surface plus both lines');
    assert.match(slide, /<p:cNvPr [^>]*name="Shape 0"><a:hlinkClick r:id="rId\d+" tooltip=""\/>/u);
    // Not one of them is a run click, so no run gained the writer's underline.
    assert.equal((slide.match(/<a:rPr[^>]*\su="sng"/gu) || []).length, 0,
      'the card copy is not underlined by the link');
    const relationships = await written.relationships();
    assert.match(relationships,
      /<Relationship [^>]*Type="[^"]*\/hyperlink" Target="https:\/\/example\.com\/card" TargetMode="External"\/>/u);
    assert.equal((relationships.match(/TargetMode="External"/gu) || []).length, 1,
      'three clicks, one url, one relationship');
  } finally {
    written.cleanup();
  }
});

test('a link inside a table cell in real html reaches the cell', async () => {
  const written = await writeHtml(
    '<table style="width: 480px"><tr><td><a href="https://example.com/cell">格内链接</a></td>'
      + '<td>普通</td></tr></table>'
  );
  try {
    const slide = await written.slide();
    const cells = slide.match(/<a:tc\b[\s\S]*?<\/a:tc>/gu) || [];
    assert.match(cells[0], /<a:hlinkClick r:id="rId\d+"/u, 'the linked cell carries the click');
    assert.ok(!cells[1].includes('<a:hlinkClick'), 'its neighbour does not');
    const relationships = await written.relationships();
    assert.match(relationships, /Target="https:\/\/example\.com\/cell" TargetMode="External"/u);
  } finally {
    written.cleanup();
  }
});
