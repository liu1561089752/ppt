'use strict';

/**
 * What a picture can carry: a crop from `clip-path: inset()`, a repeating layer as `a:tile`, and
 * the length positions both of them read - plus the six layout properties that used to vanish in
 * silence and are now either drawn or named.
 *
 * The four picture items are behaviour the spec had no field for:
 *   - `object-position`/`background-position` lengths were read by the percentage parser, which
 *     dropped the offset and left the picture cropped from the middle with nothing said;
 *   - `clip-path: inset()` on a picture is that picture's own source rectangle, which the file
 *     format already spells;
 *   - `background-repeat` is `a:tile`, one cell repeated by the reader;
 *   - and a length offset the crop window cannot reach names the strip the browser would have
 *     left blank, because `a:srcRect` always fills its frame.
 *
 * The layout half (`z-index`, `min`/`max` sizes, `aspect-ratio`, flex `order`, `vertical-align:
 * super`/`sub`, `-webkit-line-clamp`) turned out to be implemented already; these tests hold that
 * shape so a future refactor cannot lose it quietly.
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const pipeline = require('../native/pipeline');
const { generatePptx } = require('../native/engine/native_pptx');
const { makePng } = require('../native/scripts/sample_image');
// JSZip is resolved from the engine's own dependency folder, the way the rest of the suite
// does: the pipeline has no direct dependency on it.
const JSZip = require(require.resolve('jszip', { paths: [require.resolve('../native/engine/native_pptx')] }));

const TALL = 'data:image/png;base64,' + makePng(40, 100).toString('base64');
const SQUARE = 'data:image/png;base64,' + makePng(40, 40).toString('base64');

const page = (body, extraCss) => [
  '<html><head><style>',
  '  .slide { width: 1280px; height: 720px; padding: 40px; font-size: 14px; }',
  '  p { margin: 0; }',
  extraCss || '',
  '</style></head><body><main class="slide">' + body + '</main></body></html>'
].join('\n');

const convert = (body, extraCss) => pipeline.convertHtml(page(body, extraCss));

/** Every node of a slide, depth first. */
const allNodes = (result, slideIndex = 0) => {
  const found = [];
  const visit = (node) => {
    found.push(node);
    (node.children || []).forEach(visit);
  };
  (result.analysis.slides[slideIndex] || { nodes: [] }).nodes.forEach(visit);
  return found;
};

const nodesOfKind = (result, kind) => allNodes(result).filter((node) => node.kind === kind);
const firstOfKind = (result, kind) => {
  const found = nodesOfKind(result, kind);
  assert.ok(found.length, 'the html produced a ' + kind + ' node');
  return found[0];
};

const reportsOf = (result, property) => result.report.unsupportedDetails
  .filter((entry) => entry.property === property)
  .map((entry) => String(entry.value) + ' :: ' + entry.reason);

const reportProperties = (result) => result.report.unsupportedDetails.map((entry) => entry.property);

/** Every element of a deck, depth first; the picture payload is dropped, it is megabytes wide. */
const flatElements = (elements) => elements
  .flatMap((element) => [element, ...flatElements(element.children || [])]);

const shapeOf = (element) => ({
  type: element.type,
  x: element.x,
  y: element.y,
  w: element.w,
  h: element.h,
  fit: element.fit,
  focus: element.focus,
  tile: element.tile,
  crop: element.crop,
  fill: element.fill
});

/** The slide part of a generated file, so an assertion can look at what a reader will. */
const slideXml = async (result, slide = 1) => {
  const output = path.join(os.tmpdir(), 'native-picture-' + process.pid + '-' + Math.random().toString(36).slice(2) + '.pptx');
  await generatePptx(result.deck, output);
  const zip = await JSZip.loadAsync(fs.readFileSync(output));
  const xml = await zip.file('ppt/slides/slide' + slide + '.xml').async('string');
  fs.rmSync(output, { force: true });
  return xml;
};

/** The `<p:pic>` of a slide that holds exactly one picture. */
const picturePart = (xml) => {
  const start = xml.indexOf('<p:pic>');
  const end = xml.indexOf('</p:pic>');
  assert.ok(start >= 0 && end > start, 'the slide holds a picture');
  return xml.slice(start, end);
};

const srcRectOf = (xml) => {
  const match = /<a:srcRect([^/>]*)\/?>/u.exec(picturePart(xml));
  return match ? match[1].trim() : '';
};

/** The `<a:tile>` attributes of a slide, as numbers where they are numbers. */
const tileAttrsOf = (xml) => {
  const match = /<a:tile ([^/>]*)\/?>/u.exec(xml);
  const attrs = {};
  if (!match) return attrs;
  match[1].split(/\s+/u).forEach((pair) => {
    const at = pair.indexOf('=');
    if (at <= 0) return;
    const value = pair.slice(at + 1).replace(/"/gu, '');
    attrs[pair.slice(0, at)] = /^-?\d+$/u.test(value) ? Number(value) : value;
  });
  return attrs;
};

const close = (actual, expected, what, tolerance = 0.003) => {
  assert.ok(Number.isFinite(actual) && Math.abs(actual - expected) < tolerance,
    what + ' (' + actual + ' vs ' + expected + ')');
};

const firstTable = (result) => {
  const find = (node) => {
    if (node && node.rows) return node;
    for (const child of (node && node.children) || []) {
      const hit = find(child);
      if (hit) return hit;
    }
    return null;
  };
  for (const node of result.analysis.slides[0].nodes) {
    const hit = find(node);
    if (hit) return hit;
  }
  return null;
};

// ---------------------------------------------------------------------------------------------
// Item 1: a length position is an offset the fit has to read, and a gap is named.
// ---------------------------------------------------------------------------------------------

test('a length object-position travels to the fit, and a gap it cannot draw is named', async () => {
  const result = convert('<img src="' + TALL + '" alt="x">',
    'img { width: 200px; height: 100px; object-fit: cover; object-position: 10px 20px; }');
  const image = firstOfKind(result, 'image');
  // The analyzer has the box but not the source size, and the offset is measured against the
  // *drawn* size: the raw pair travels to the resolver that holds both.
  assert.equal(image.focus, '10px 20px', 'the length pair is passed through, not read as a percentage');
  assert.equal(image.objectFit, 'cover');

  const named = reportsOf(result, 'objectPosition');
  assert.equal(named.length, 1, 'the gap is named once: ' + JSON.stringify(reportProperties(result)));
  assert.match(named[0], /^10px 20px :: /u);
  assert.match(named[0], /cannot draw that gap/u);

  // 20px down on a picture that overflows its box means a blank strip at the top. A source
  // rectangle always fills the frame, so the window stops at the near edge instead.
  const crop = srcRectOf(await slideXml(result));
  assert.match(crop, /t="0"/u, 'the window starts at the near edge: ' + crop);
});

test('a percentage object-position keeps its centring and is not named', async () => {
  const result = convert('<img src="' + TALL + '" alt="x">',
    'img { width: 200px; height: 100px; object-fit: cover; object-position: 50% 40%; }');
  assert.deepEqual(reportsOf(result, 'objectPosition'), []);
  const image = firstOfKind(result, 'image');
  assert.deepEqual(image.focus, { x: 0.5, y: 0.4 });
  // A 40x100 picture covering a 200x100 box is drawn 200x500, so 40% of the 400px overflow sits
  // above the frame and 60% below it.
  const crop = srcRectOf(await slideXml(result));
  assert.match(crop, /t="32000"/u, 'the window follows the share: ' + crop);
  assert.match(crop, /b="47999"/u, 'and the other side is the remainder: ' + crop);
});

test('a length background-position is named only while the layer is fitted', async () => {
  const fitted = convert('<div class="b"></div>',
    '.b { width: 200px; height: 100px; background-image: url(' + TALL + ');'
    + ' background-size: cover; background-position: 10px 20px; }');
  const named = reportsOf(fitted, 'backgroundPosition');
  assert.equal(named.length, 1, 'the fitted layer names the gap: ' + JSON.stringify(reportProperties(fitted)));
  assert.match(named[0], /^10px 20px :: /u);

  // A repeating layer *places* its first cell instead of cropping a window, so the same offset is
  // honoured and there is nothing to name.
  const tiled = convert('<div class="t"></div>',
    '.t { width: 200px; height: 100px; background-image: url(' + SQUARE + ');'
    + ' background-size: 40px 40px; background-repeat: repeat; background-position: 10px 20px; }');
  assert.deepEqual(reportProperties(tiled), [], 'a tile reads the offset as its origin');
  assert.equal(firstOfKind(tiled, 'image').tile.width, 0.4167);
});

test('a background layer with no declared position starts at the box corner', async () => {
  // CSS's initial `background-position` is `0% 0%` while `object-position` starts at 50% 50%:
  // a `contain` layer letterboxed in the middle was the one silent difference left.
  const contained = convert('<div class="c"></div>',
    '.c { width: 200px; height: 150px; background-image: url(' + TALL + '); background-size: contain; }');
  const node = firstOfKind(contained, 'image');
  assert.deepEqual(node.focus, { x: 0, y: 0 }, 'the layer sits at the corner');
  const containedShape = flatElements(contained.deck.slides[0].elements)[0];
  assert.deepEqual(containedShape.focus, { x: 0, y: 0 });

  // An `<img>` is a different property with a different initial value: no `object-position`
  // leaves the node without a focus at all, and the emitter's own default is the centre.
  const picture = convert('<img src="' + TALL + '" alt="x">',
    'img { width: 200px; height: 100px; object-fit: contain; }');
  assert.equal(firstOfKind(picture, 'image').focus, undefined);

  // A declared position still wins.
  const placed = convert('<div class="p"></div>',
    '.p { width: 200px; height: 150px; background-image: url(' + SQUARE + ');'
    + ' background-size: 40px 40px; background-repeat: repeat; background-position: right bottom; }');
  const placedTile = firstOfKind(placed, 'image').tile;
  assert.ok(placedTile && placedTile.width > 0, 'the pattern is still a tile');
  const attrs = tileAttrsOf(await slideXml(placed));
  assert.ok(attrs.tx > 300000 && attrs.ty > 200000,
    'the pattern starts at the far corner the design named: ' + JSON.stringify(attrs));
});

// ---------------------------------------------------------------------------------------------
// Item 2: `clip-path: inset()` on a picture is that picture's own crop.
// ---------------------------------------------------------------------------------------------

test('clip-path: inset() on a picture becomes its source rectangle', async () => {
  const result = convert('<img class="c" src="' + SQUARE + '" alt="x">',
    '.c { width: 200px; height: 150px; clip-path: inset(10% 20% 30% 40%); }');
  const image = firstOfKind(result, 'image');
  assert.deepEqual(reportProperties(result), []);
  assert.equal(image.objectFit, 'crop');
  assert.deepEqual(image.crop, { left: 0.4, top: 0.1, right: 0.2, bottom: 0.3 });
  // The visible pixels keep the size they were drawn at: the box shrinks to the inset rather than
  // the inset being stretched back over the box.
  close(image.w, 2.0833 * 0.4, 'the visible width is 40% of the slot');
  close(image.h, 1.5625 * 0.6, 'the visible height is 60% of the slot');
  close(image.x, 0.4167 + 2.0833 * 0.4, 'the left edge is the inset');
  close(image.y, 0.4167 + 1.5625 * 0.1, 'the top edge is the inset');
  // CSS clips the paint, not the layout, so the slot is still there for the flow to read.
  assert.deepEqual([image.layoutX, image.layoutY, image.layoutW, image.layoutH].map((value) => Number(value.toFixed(4))),
    [0.4167, 0.4167, 2.0833, 1.5625]);

  const crop = srcRectOf(await slideXml(result));
  assert.match(crop, /l="40000"/u, 'left 40%: ' + crop);
  assert.match(crop, /t="10000"/u, 'top 10%: ' + crop);
  assert.match(crop, /r="20000"/u, 'right 20%: ' + crop);
  assert.match(crop, /b="30000"/u, 'bottom 30%: ' + crop);
});

test('a clipped picture leaves its slot in the flow where it was', () => {
  const result = convert('<img class="c" src="' + SQUARE + '" alt="x"><p>after</p>',
    '.c { width: 200px; height: 150px; clip-path: inset(45% 0 45% 0); }');
  const image = firstOfKind(result, 'image');
  const paragraph = allNodes(result).find((node) => node.kind === 'text' && /after/u.test(String(node.text)));
  assert.ok(paragraph, 'the paragraph node exists');
  close(image.h, 1.5625 * 0.1, 'a tenth of the picture is left');
  // The paragraph follows the slot, not the strip: an image clipped to a band still takes its
  // full height in the flow, exactly as `clip-path` leaves the layout alone.
  close(paragraph.y, image.layoutY + image.layoutH, 'the next box starts below the slot');
});

test('inset() in pixels names the same fractions from the box', () => {
  const result = convert('<img class="c" src="' + SQUARE + '" alt="x">',
    '.c { width: 192px; height: 96px; clip-path: inset(9.6px 19.2px 9.6px 19.2px); }');
  const image = firstOfKind(result, 'image');
  assert.deepEqual(reportProperties(result), []);
  close(image.crop.left, 0.1, '19.2 of 192');
  close(image.crop.top, 0.1, '9.6 of 96');
  close(image.crop.right, 0.1, 'and the same on the far side');
  close(image.crop.bottom, 0.1, 'top and bottom alike');
});

test('an inset that is not one rectangle is named instead of approximated', () => {
  const rounded = convert('<img class="c" src="' + SQUARE + '" alt="x">',
    '.c { width: 200px; height: 150px; clip-path: inset(10% round 8px); }');
  assert.equal(firstOfKind(rounded, 'image').crop, undefined, 'a rounded inset is not a crop');
  assert.match(reportsOf(rounded, 'clipPath')[0], /right angles/u);

  const keyword = convert('<img class="c" src="' + SQUARE + '" alt="x">',
    '.c { width: 200px; height: 150px; clip-path: inset(0 auto); }');
  assert.equal(firstOfKind(keyword, 'image').crop, undefined);
  assert.match(reportsOf(keyword, 'clipPath')[0], /Only lengths and percentages/u);

  const empty = convert('<img class="c" src="' + SQUARE + '" alt="x">',
    '.c { width: 200px; height: 150px; clip-path: inset(60% 0 50% 0); }');
  assert.equal(firstOfKind(empty, 'image').crop, undefined);
  assert.match(reportsOf(empty, 'clipPath')[0], /leaves no picture/u);

  // A picture drawn at a size of its own carries no fit to compose with the inset: the source
  // rectangle the clip would need is not the one the layer draws.
  const sized = convert('<div class="c"></div>',
    '.c { width: 200px; height: 150px; background-image: url(' + SQUARE + ');'
    + ' background-size: 120px 120px; clip-path: inset(10%); }');
  assert.equal(firstOfKind(sized, 'image').crop, undefined);
  assert.match(reportsOf(sized, 'clipPath')[0], /size of its own/u);
});

test('an inset that cuts nothing is silent', () => {
  const negative = convert('<img class="c" src="' + SQUARE + '" alt="x">',
    '.c { width: 200px; height: 150px; clip-path: inset(-10% -5%); }');
  assert.deepEqual(reportProperties(negative), []);
  assert.equal(firstOfKind(negative, 'image').crop, undefined, 'a region that grows outward cuts nothing');

  const zero = convert('<img class="c" src="' + SQUARE + '" alt="x">',
    '.c { width: 200px; height: 150px; clip-path: inset(0); }');
  assert.deepEqual(reportProperties(zero), []);
  assert.equal(firstOfKind(zero, 'image').crop, undefined);
});

// ---------------------------------------------------------------------------------------------
// Item 3: `background-repeat` is `a:tile`.
// ---------------------------------------------------------------------------------------------

test('a repeating background becomes one a:tile cell', async () => {
  const result = convert('<div class="t"></div>',
    '.t { width: 200px; height: 150px; background-image: url(' + SQUARE + ');'
    + ' background-size: 50px 50px; background-repeat: repeat; }');
  assert.deepEqual(reportProperties(result), []);
  const node = firstOfKind(result, 'image');
  assert.deepEqual(node.tile, { x: true, y: true, width: 0.5208, height: 0.5208 });
  // `background-size` stays as the CSS spelled it: the emitter reads the cell, not the fit.
  assert.equal(node.backgroundSize, '50px 50px');

  const shape = flatElements(result.deck.slides[0].elements)[0];
  assert.equal(shape.type, 'image');
  assert.equal(shape.fit, 'stretch', 'a tiled fill paints the whole frame, one cell at a time');
  assert.deepEqual(shape.tile, { x: true, y: true, width: 0.5208, height: 0.5208 });

  const xml = await slideXml(result);
  assert.ok(/<a:tile\b/u.test(xml), 'the file carries a tile');
  const attrs = tileAttrsOf(xml);
  // `sx`/`sy` are the cell against the frame in ST_Percentage: 100000 is the frame's own size.
  close(attrs.sx / 100000, 0.25, 'a 50px cell is a quarter of the 200px frame', 0.0005);
  close(attrs.sy / 100000, 1 / 3, 'and a third of the 150px one', 0.0005);
  assert.equal(attrs.tx, 0, 'an undeclared position starts the pattern at the corner');
  assert.equal(attrs.ty, 0);
  assert.ok(!/<a:stretch/u.test(xml), 'a tiled fill has no stretch left');
  assert.ok(!/<a:srcRect/u.test(xml), 'and no source rectangle to describe it');
});

test('the repeat axes and the cell follow the declaration', async () => {
  const once = (css, extra) => convert('<div class="t"></div>',
    '.t { width: 200px; height: 150px; background-image: url(' + (extra || SQUARE) + '); ' + css + ' }');

  const horizontal = once('background-size: 40px 20px; background-repeat: repeat-x;');
  assert.deepEqual(firstOfKind(horizontal, 'image').tile, { x: true, y: false, width: 0.4167, height: 0.2083 });
  const horizontalAttrs = tileAttrsOf(await slideXml(horizontal));
  assert.equal(horizontalAttrs.sy, 100000, 'the axis that does not repeat keeps one cell');
  assert.equal(horizontalAttrs.ty, 0, 'and its offset stays zero, or the single cell would seam');

  const vertical = once('background-size: 40px 20px; background-repeat: repeat-y;');
  assert.deepEqual(firstOfKind(vertical, 'image').tile, { x: false, y: true, width: 0.4167, height: 0.2083 });

  // A percentage is a share of the box, not of the source.
  const share = once('background-size: 25% 50%; background-repeat: repeat;');
  assert.deepEqual(firstOfKind(share, 'image').tile, { x: true, y: true, width: 0.5208, height: 0.7813 });

  // `auto` is the source's own pixel size - 40px is 0.4167in here, and the fit is `contain`.
  const auto = once('background-repeat: repeat;');
  assert.deepEqual(firstOfKind(auto, 'image').tile, { x: true, y: true, width: 0.4167, height: 0.4167 });

  // `contain` names a fit, so the cell is the size that fit is drawn at: 40px in a 200x150 slot
  // scales by 3.75 to touch the height.
  const contained = once('background-size: contain; background-repeat: repeat;');
  assert.deepEqual(firstOfKind(contained, 'image').tile, { x: true, y: true, width: 1.5625, height: 1.5625 });

  const none = once('background-size: 40px 40px; background-repeat: no-repeat;');
  assert.equal(firstOfKind(none, 'image').tile, undefined, 'nothing repeats');
  assert.deepEqual(reportProperties(none), []);
});

test('a text box keeps its pattern behind the words', () => {
  const result = convert('<div class="t">words</div>',
    '.t { width: 200px; height: 100px; font-size: 14px; background-image: url(' + SQUARE + ');'
    + ' background-size: 25% 25%; background-repeat: repeat; }');
  assert.deepEqual(reportProperties(result), []);
  const node = firstOfKind(result, 'text');
  assert.deepEqual(node.bgImage.tile, { x: true, y: true, width: 0.5208, height: 0.2604 });
  const layer = flatElements(result.deck.slides[0].elements).find((element) => element.type === 'image');
  assert.deepEqual(layer.tile, { x: true, y: true, width: 0.5208, height: 0.2604 });
});

test('a repeat with nothing to tile is named, not dropped', () => {
  const flat = convert('<div class="f"></div>',
    '.f { width: 200px; height: 150px; background: #EEEEEE; background-repeat: repeat; }');
  assert.deepEqual(reportsOf(flat, 'backgroundRepeat'), ['repeat :: The picture is drawn once, fitted to the box; a tiled pattern cannot be spelled']);

  const gradient = convert('<div class="g"></div>',
    '.g { width: 200px; height: 150px; background-image: linear-gradient(#FFF, #000); background-repeat: repeat-x; }');
  assert.match(reportsOf(gradient, 'backgroundRepeat')[0], /^repeat-x :: /u);

  // `space`/`round` resize the cell until a whole number of cells fits, which a fixed-cell tile
  // cannot do.
  const rounded = convert('<div class="r"></div>',
    '.r { width: 200px; height: 150px; background-image: url(' + SQUARE + ');'
    + ' background-size: 40px 40px; background-repeat: space; }');
  assert.equal(firstOfKind(rounded, 'image').tile, undefined);
  assert.match(reportsOf(rounded, 'backgroundRepeat')[0], /whole number of cells/u);

  // A source that cannot be measured leaves no cell to repeat, and says so.
  const unreadable = convert('<div class="u"></div>',
    '.u { width: 200px; height: 150px; background-image: url(https://example.test/x.png);'
    + ' background-repeat: repeat; }');
  const named = reportProperties(unreadable);
  assert.ok(named.includes('backgroundRepeat'), 'the pattern is named: ' + named.join(', '));
  assert.ok(named.includes('backgroundImage'), 'and so is the dropped layer: ' + named.join(', '));
});

// ---------------------------------------------------------------------------------------------
// Item 4: the six layout properties.
// ---------------------------------------------------------------------------------------------

test('z-index paints in stacking order, not in document order', () => {
  const red = 'background: #FF0000;';
  const blue = 'background: #0000FF;';
  const box = (extra) => 'width: 100px; height: 100px; position: absolute; ' + extra;
  const result = convert(
    '<div style="' + box(red + ' left: 0; top: 0; z-index: 2;') + '"></div>'
    + '<div style="' + box(blue + ' left: 20px; top: 20px;') + '"></div>');
  const fills = flatElements(result.deck.slides[0].elements)
    .filter((element) => element.type === 'shape').map((element) => element.fill);
  assert.deepEqual(fills, ['0000FF', 'FF0000'], 'the raised box is emitted last');

  // The same order inside a container, which is emitted as a group of absolutely placed boxes.
  const nested = convert('<div class="card">'
    + '<div style="' + box(red + ' left: 0; top: 0; z-index: 2;') + '"></div>'
    + '<div style="' + box(blue + ' left: 20px; top: 20px;') + '"></div>'
    + '</div>',
    '.card { position: relative; width: 400px; height: 200px; }');
  const inner = flatElements(nested.deck.slides[0].elements)
    .filter((element) => element.type === 'shape').map((element) => element.fill);
  assert.deepEqual(inner, ['0000FF', 'FF0000'], 'a group paints in the same order');

  // A negative z-index goes behind the in-flow boxes.
  const behind = convert('<div style="width: 100px; height: 100px; background: #00FF00;"></div>'
    + '<div style="' + box(red + ' left: 60px; top: 60px; z-index: -1;') + '"></div>');
  const behindFills = flatElements(behind.deck.slides[0].elements)
    .filter((element) => element.type === 'shape').map((element) => element.fill);
  assert.deepEqual(behindFills, ['FF0000', '00FF00']);
});

test('min and max sizes narrow or widen the declared box', () => {
  const boxes = convert(
    '<div class="minw"></div><div class="maxw"></div><div class="minh"></div><div class="maxh"></div>',
    '.minw { width: 300px; min-width: 500px; height: 20px; }'
    + ' .maxw { width: 600px; max-width: 200px; height: 20px; }'
    + ' .minh { width: 300px; height: 60px; min-height: 240px; }'
    + ' .maxh { width: 300px; height: 500px; max-height: 120px; }');
  const nodes = allNodes(boxes).filter((node) => node.kind === 'block');
  close(nodes[0].w, 5.2083, 'min-width wins over the declared width');
  close(nodes[1].w, 2.0833, 'max-width wins too');
  close(nodes[2].h, 2.5, 'min-height grows the box');
  // A container cannot clamp its own height without clipping, so the declared height is drawn and
  // the clamp is named rather than half-applied.
  close(nodes[3].h, 5.2083, 'a max-height on a container keeps the declared height');
  assert.deepEqual(reportsOf(boxes, 'maxHeight').map((entry) => entry.slice(0, 6)), ['120px ']);
});

test('aspect-ratio turns a width into a height unless the height is declared', () => {
  const boxes = convert('<div class="a"></div><div class="b"></div>',
    '.a { width: 300px; aspect-ratio: 16 / 9; } .b { width: 300px; height: 50px; aspect-ratio: 16 / 9; }');
  const nodes = allNodes(boxes).filter((node) => node.kind === 'block');
  close(nodes[0].h, 3.125 / (16 / 9), 'the height follows the ratio');
  close(nodes[1].h, 0.5208, 'a declared height wins');
});

test('flex order places an item where it asked to go', () => {
  const result = convert(
    '<div class="row"><div class="a"></div><div class="b"></div></div>',
    '.row { display: flex; width: 400px; height: 100px; }'
    + ' .a { width: 100px; height: 50px; order: 2; } .b { width: 60px; height: 50px; order: 0; }');
  const row = allNodes(result).find((node) => node.kind === 'block' && (node.children || []).length === 2);
  assert.ok(row, 'the flex row exists');
  assert.deepEqual(row.children.map((child) => child.classes[0]), ['b', 'a'],
    'the lower order is laid out first');
  close(row.children[0].x, 0.4167, 'at the row start');
  close(row.children[1].x, 0.4167 + 60 / 96, 'and the other follows it');
});

test('vertical-align: super and sub become native baselines', async () => {
  const result = convert('<p>E = mc<sup>2</sup> and H<sub>2</sub>O</p>');
  const text = firstOfKind(result, 'text');
  const runs = text.runs || [];
  const raised = runs.find((run) => run.options && run.options.superscript);
  const lowered = runs.find((run) => run.options && run.options.subscript);
  assert.ok(raised, 'the superscript run is marked: ' + JSON.stringify(runs));
  assert.ok(lowered, 'the subscript run is marked: ' + JSON.stringify(runs));
  const xml = await slideXml(result);
  assert.match(xml, /baseline="30000"/u, 'the raised baseline');
  assert.match(xml, /baseline="-40000"/u, 'and the lowered one');
});

test('-webkit-line-clamp truncates to the lines it names', () => {
  const long = 'A line that is long enough to wrap several times inside the box it is given. ';
  const result = convert('<div class="c">' + long.repeat(4) + '</div>',
    '.c { width: 200px; font-size: 14px; line-height: 1.5;'
    + ' display: -webkit-box; -webkit-box-orient: vertical; -webkit-line-clamp: 2; }');
  const text = firstOfKind(result, 'text');
  assert.ok(text.text.endsWith('\u2026'), 'the clamp leaves an ellipsis: ' + text.text);
  assert.equal(text.runs, null, 'the runs no longer describe the string');
  assert.deepEqual(reportProperties(result), [], 'a clamp that is drawn is not a loss');
  // Two lines of a 14px/1.5 box.
  close(text.textHeight, 2 * 0.2188, 'two lines tall', 0.02);
});

// ---------------------------------------------------------------------------------------------
// Addition B: `<tfoot>` paints last wherever it is written.
// ---------------------------------------------------------------------------------------------

test('a tfoot written before tbody still draws after every body row', () => {
  const result = convert('<table><tfoot><tr><td>total</td></tr></tfoot>'
    + '<tbody><tr><td>a</td></tr><tr><td>b</td></tr></tbody>'
    + '<thead><tr><th>head</th></tr></thead></table>',
    'table { width: 600px; }');
  const table = firstTable(result);
  assert.deepEqual(table.rows.map((row) => row.map((cell) => cell.text)),
    [['head'], ['a'], ['b'], ['total']], 'the head first and the foot last');
  assert.equal(table.headerRows, 1, 'the head is still the header');
});

// ---------------------------------------------------------------------------------------------
// Addition C: the data-label number format.
// ---------------------------------------------------------------------------------------------

test('data-chart-value-format reaches the data labels', async () => {
  const result = convert('<table class="c" data-chart="bar" data-values="3,5" data-labels="a,b"'
    + " data-chart-value-format='0.0&quot;'>"
    + '<tr><td>a</td><td>3</td></tr><tr><td>b</td><td>5</td></tr></table>',
    'table { width: 600px; }');
  const chart = result.deck.slides[0].elements.find((element) => element.type === 'chart');
  assert.ok(chart, 'the chart element exists');
  assert.equal(chart.options.dataLabelFormatCode, '0.0"', 'the labels carry the declared format');
  assert.equal(chart.options.valLabelFormatCode, undefined,
    'valLabelFormatCode is the data table\'s format and nothing else sets it');
  assert.equal(chart.options.showValue, true, 'the format implies the labels are shown');

  const output = path.join(os.tmpdir(), 'native-chart-format-' + process.pid + '.pptx');
  await generatePptx(result.deck, output);
  const zip = await JSZip.loadAsync(fs.readFileSync(output));
  const name = Object.keys(zip.files).find((entry) => /charts\/chart\d+\.xml$/u.test(entry));
  const xml = await zip.file(name).async('string');
  fs.rmSync(output, { force: true });
  const labels = xml.slice(xml.indexOf('<c:dLbls>'), xml.indexOf('</c:dLbls>'));
  assert.match(labels, /<c:numFmt formatCode="0\.0&quot;"/u, 'the label format reaches the chart part: ' + labels.slice(0, 200));
});

// ---------------------------------------------------------------------------------------------
// The fixture that holds all three picture items together.
// ---------------------------------------------------------------------------------------------

test('the crop fixture draws its pictures and names nothing', () => {
  const directory = path.join(__dirname, '..', 'examples');
  const html = fs.readFileSync(path.join(directory, 'pipeline-crop.html'), 'utf8');
  const result = pipeline.convertHtml(html, { baseDir: directory });
  assert.equal(result.analysis.slides.length, 3, 'three pages');
  assert.deepEqual(result.errors, []);
  assert.deepEqual(reportProperties(result), [], 'nothing on that page is a loss');
  const nodes = [];
  result.analysis.slides.forEach((slide) => nodes.push(...allNodes({ analysis: { slides: [slide] } })));
  const cropped = nodes.filter((node) => node.crop);
  const tiled = nodes.filter((node) => node.tile);
  assert.ok(cropped.length >= 2, 'the inset and the overflow frame both crop: ' + cropped.length);
  assert.equal(tiled.length, 2, 'two of the three pattern boxes repeat: ' + tiled.length);
  assert.deepEqual(tiled.map((node) => [node.tile.x, node.tile.y]), [[true, true], [true, false]]);
});

// ---------------------------------------------------------------------------------------------
// Named grid areas: the map is the explicit grid, and a name is its rectangle.
// ---------------------------------------------------------------------------------------------

const namedAreaGrid = (areas) => convert(
  '<div class="g"><div class="head">head</div><div class="side">side</div>'
  + '<div class="main">main</div></div>',
  '.g { display: grid; grid-template-columns: 200px 200px;'
  + " grid-template-areas: " + areas + "; gap: 12px; width: 420px; }"
  + ' .head { grid-area: head; } .side { grid-area: side; } .main { grid-area: main; }');

test('grid-template-areas places an item in the rectangle its name draws', () => {
  const result = namedAreaGrid("'head head' 'side main'");
  assert.deepEqual(reportProperties(result), [], 'a rectangular map is drawn, not named');
  const boxes = allNodes(result).filter((node) => node.style && node.style.gridArea);
  const byArea = (name) => boxes.find((node) => String(node.style.gridArea) === name);
  const head = byArea('head');
  const side = byArea('side');
  const main = byArea('main');
  assert.ok(head && side && main, 'all three items exist');

  // Row 1 is the whole width: two 200px tracks and the 12px gap between them.
  close(head.x, 0.4167, 'head starts at the content edge');
  close(head.w, 412 / 96, 'head spans both columns and the gap');
  close(head.y, 0.4167, 'head is on the first row');
  assert.equal(head.gridColumnStart, 0);
  assert.equal(head.columnSpan, 2, 'the area covers two columns');

  // Row 2: side | main, side by side, one row down.
  close(side.x, 0.4167, 'side keeps the first column');
  close(side.w, 200 / 96, 'side is one track wide');
  close(main.x, 0.4167 + 212 / 96, 'main starts after the second track begins');
  close(main.w, 200 / 96, 'main is one track wide');
  close(side.y, main.y, 'side and main share a row');
  assert.ok(side.y > head.y, 'the second row is below the first');
  assert.equal(side.gridRowStart, 1);
  assert.equal(main.gridColumnStart, 1);
  // The map names two rows even though no `grid-template-rows` does.
  close(head.h + side.h + 12 / 96, head.h + side.h + 0.125, 'the gap between the rows is the declared one');
});

test('a name that covers a non-rectangular set of cells is named, not guessed', () => {
  const result = namedAreaGrid("'head head' 'side head'");
  const mapReports = reportsOf(result, 'gridTemplateAreas');
  assert.equal(mapReports.length, 1, 'the map itself is the loss: ' + JSON.stringify(reportProperties(result)));
  assert.match(mapReports[0], /one rectangle of whole cells/u);
  // Every item still places in document order, and each one says why it is not in its area.
  assert.equal(reportsOf(result, 'gridColumn').length, 3, 'the three named items say why they were not placed');
  const boxes = allNodes(result).filter((node) => node.style && node.style.gridArea);
  assert.equal(boxes.filter((node) => node.columnSpan === 2).length, 0, 'nothing spans two columns');
});

test('an item that names an area the map does not draw keeps its own report', () => {
  const result = convert('<div class="g"><div class="lead">x</div></div>',
    '.g { display: grid; grid-template-columns: 200px 200px;'
    + " grid-template-areas: 'head head' 'side main'; width: 420px; }"
    + ' .lead { grid-area: headline; }');
  assert.deepEqual(reportsOf(result, 'gridTemplateAreas'), [], 'the map is rectangular');
  const placementReports = reportsOf(result, 'gridColumn');
  assert.equal(placementReports.length, 1, 'the missing name is the loss');
  assert.match(placementReports[0], /Named grid lines and areas are not modelled/u);
  const box = allNodes(result).find((node) => node.style && node.style.gridArea);
  assert.equal(box.columnSpan, undefined, 'the item keeps auto placement');
});

test('the named-areas page of the grid fixture lands on Chrome\'s cells', () => {
  // Read from Chrome 156 with getBoundingClientRect() on pipeline-grid.html's last page, in CSS
  // px from that page's own corner. The map is 1.6fr/1fr/0.9fr over 1152px with an 18px gap and
  // rows of 92/200/92: head and chart take the first two tracks, rail both rows of the last one.
  const recorded = {
    named: [64, 230, 1152, 420],
    head: [64, 230, 847, 92],
    chart: [64, 340, 847, 200],
    rail: [929, 230, 287, 310],
    note: [64, 558, 847, 92],
    foot: [929, 558, 287, 92]
  };
  const directory = path.join(__dirname, '..', 'examples');
  const html = fs.readFileSync(path.join(directory, 'pipeline-grid.html'), 'utf8');
  const result = pipeline.convertHtml(html, { baseDir: directory });
  assert.deepEqual(reportProperties(result), [], 'the named map is drawn, not named');
  const nodes = result.analysis.slides[result.analysis.slides.length - 1].nodes;
  const find = (node) => {
    if (node.classes && node.classes.includes('named')) return node;
    for (const child of node.children || []) {
      const hit = find(child);
      if (hit) return hit;
    }
    return null;
  };
  const named = find({ children: nodes });
  assert.ok(named, 'the page still holds the named grid');
  const px = (value) => Math.round(value * 96);
  const compare = (box, expected, what) => {
    assert.ok(Math.abs(px(box.x) - expected[0]) <= 2, what + ' x (' + px(box.x) + ' vs ' + expected[0] + ')');
    assert.ok(Math.abs(px(box.y) - expected[1]) <= 2, what + ' y (' + px(box.y) + ' vs ' + expected[1] + ')');
    assert.ok(Math.abs(px(box.w) - expected[2]) <= 2, what + ' w (' + px(box.w) + ' vs ' + expected[2] + ')');
    assert.ok(Math.abs(px(box.h) - expected[3]) <= 2, what + ' h (' + px(box.h) + ' vs ' + expected[3] + ')');
  };
  compare(named, recorded.named, 'the grid itself');
  named.children.forEach((child) => {
    const name = (child.classes || []).find((entry) => entry !== 'band');
    assert.ok(recorded[name], 'the cell ' + name + ' was measured');
    compare(child, recorded[name], name);
  });
});

// ---------------------------------------------------------------------------------------------
// Two windows in one picture nest: the fit the picture already draws, and the clip over it.
// ---------------------------------------------------------------------------------------------

test('an inset composes with the fit the picture already draws', async () => {
  // 40x100 source in a 200x100 box: `cover` draws 200x500, so the source window is y 0.4..0.6.
  // The inset keeps 10% off each side of that drawing, which is 20px of 200 and 10px of 100.
  const result = convert('<img src="' + TALL + '" alt="x">',
    'img { width: 200px; height: 100px; object-fit: cover; clip-path: inset(10%); }');
  const image = firstOfKind(result, 'image');
  assert.deepEqual(reportProperties(result), [], 'one source rectangle holds both windows');
  assert.equal(image.objectFit, 'crop');
  close(image.crop.left, 0.1, 'the left tenth of the drawn window');
  close(image.crop.right, 0.1, 'the right tenth');
  close(image.crop.top, 0.42, 'a tenth of the 0.2 the cover window shows');
  close(image.crop.bottom, 0.42, 'and the same at the bottom');
  close(image.x, 0.625, 'the visible rectangle keeps the box position it had');
  close(image.y, 0.5208, 'including the ten percent above it');
  close(image.w, 160 / 96, 'the drawn width is the part that stayed visible');
  close(image.h, 80 / 96, 'and the drawn height likewise');

  const rect = srcRectOf(await slideXml(result));
  assert.equal(rect, 'l="10000" t="42000" r="10000" b="42000"', 'the composed window reaches the part');
});

test('a contained picture composes at its own scale, and an inset over the margin cuts nothing', () => {
  // 40x100 in a 200x100 box is drawn 40x100, centred: the inset leaves the whole picture across
  // and ten percent off the top and bottom.
  const contained = convert('<img src="' + TALL + '" alt="x">',
    'img { width: 200px; height: 100px; object-fit: contain; clip-path: inset(10%); }');
  const picture = firstOfKind(contained, 'image');
  assert.deepEqual(reportProperties(contained), []);
  close(picture.crop.left, 0, 'the letterbox margin takes the horizontal cut');
  close(picture.crop.right, 0, 'on both sides');
  close(picture.crop.top, 0.1, 'the vertical cut is a tenth of the drawn picture');
  close(picture.crop.bottom, 0.1, 'and the same at the bottom');
  close(picture.w, 40 / 96, 'the drawn width is unchanged');

  // A cut that only reaches into the margin leaves every pixel of the picture visible, so the
  // box is left exactly as it was and nothing is reported.
  const margin = convert('<img src="' + TALL + '" alt="x">',
    'img { width: 200px; height: 100px; object-fit: contain; clip-path: inset(0 0 0 5%); }');
  const kept = firstOfKind(margin, 'image');
  assert.deepEqual(reportProperties(margin), []);
  assert.equal(kept.crop, undefined, 'no crop is needed');
  assert.equal(kept.objectFit, 'contain', 'and the fit is untouched');
  close(kept.w, 200 / 96, 'the box keeps its width');
});

test('an overflow frame nests its crop inside the inset the picture already carries', async () => {
  // 40x100 in a 300x100 box under `cover`: the window is y 0.4333..0.5667. The picture sits 20px
  // left of its frame, so the frame cuts it at 200 of its 300 columns, and the inset takes
  // another 30px off each end: 190 of the 240 visible columns survive.
  const result = convert('<div class="frame"><img class="p" src="' + TALL + '" alt="x"></div>',
    '.frame { position: relative; width: 200px; height: 100px; overflow: hidden; }'
    + ' .p { position: absolute; left: -20px; top: 0; width: 300px; height: 100px;'
    + ' object-fit: cover; clip-path: inset(10%); }');
  const image = firstOfKind(result, 'image');
  assert.deepEqual(reportProperties(result), [], 'two windows in one source rectangle, not a loss');
  close(image.x, 10 / 96 + 0.4167, 'the frame keeps the part of the inset picture it can show');
  close(image.w, 190 / 96, '190 of the 300 columns are left');
  close(image.crop.left, 0.1, 'the inset still holds the left edge');
  close(image.crop.right, 0.2667, 'and the frame adds the columns it cut away');
});

// ---------------------------------------------------------------------------------------------
// The two residuals: the UA shrink on `<sup>`/`<sub>`, and a length position with no size to read.
// ---------------------------------------------------------------------------------------------

const runsOf = (result) => {
  const boxes = nodesOfKind(result, 'text').filter((node) => Array.isArray(node.runs));
  return boxes.flatMap((node) => node.runs);
};

test('a superscript run carries the browser\'s own 5/6 size as well as its baseline', async () => {
  const result = convert('<p class="p">E = mc<sup>2</sup> and H<sub>2</sub>O</p>',
    '.p { font-size: 14px; }');
  const runs = runsOf(result);
  const superscript = runs.find((run) => run.options && run.options.superscript);
  const subscript = runs.find((run) => run.options && run.options.subscript);
  assert.ok(superscript && subscript, 'both runs exist: ' + JSON.stringify(runs));
  // Chrome draws 11.6667px inside 14px, which is 5/6 and 8.75pt.
  close(superscript.options.fontSize, 8.75, 'the superscript is 5/6 of the paragraph');
  close(subscript.options.fontSize, 8.75, 'and so is the subscript');

  const xml = await slideXml(result);
  assert.match(xml, /baseline="30000"/u, 'the raise is still the native baseline');
  assert.match(xml, /baseline="-40000"/u, 'and the lower is its own');

  // A size the design declares on the element is the cascade's answer, not the tag's.
  const declared = convert('<p class="p">E = mc<sup class="s">2</sup></p>',
    '.p { font-size: 14px; } .s { font-size: 20px; }');
  const sized = runsOf(declared).find((run) => run.options && run.options.superscript);
  close(sized.options.fontSize, 15, 'the declared 20px wins over the UA shrink');
});

test('a length position with no source size to read is named, a remote one is already named', () => {
  // A picture that exists and is drawn, but whose size this cannot read: the offset is measured
  // against that size, so staying quiet would lose the placement.
  const unmeasurable = convert('<img src="no-such-picture-here.png" alt="x">',
    'img { width: 200px; height: 100px; object-fit: cover; object-position: 10px 5px; }');
  const positionReports = reportsOf(unmeasurable, 'objectPosition');
  assert.equal(positionReports.length, 1, 'the offset has no size to resolve against: '
    + JSON.stringify(reportProperties(unmeasurable)));
  assert.match(positionReports[0], /size cannot be read here/u);

  // A remote source is not downloaded, so the picture itself is named and stays unpainted: a
  // second note about where it would have sat would be noise.
  const remote = convert('<img src="https://example.com/x.png" alt="x">',
    'img { width: 200px; height: 100px; object-fit: cover; object-position: 10px 5px; }');
  assert.deepEqual(reportProperties(remote), ['src'], 'the source is the one loss');
});

// ---------------------------------------------------------------------------------------------
// `data-chart-label-pos`: the writer accepts the position, the part is patched to carry it.
// ---------------------------------------------------------------------------------------------

test('data-chart-label-pos reaches the chart as a label position', async () => {
  const chartOf = (attributes, type = 'pie') => {
    const result = convert('<table class="c" data-chart="' + type + '" data-values="3,5" data-labels="a,b" '
      + attributes + '><tr><td>a</td><td>3</td></tr><tr><td>b</td><td>5</td></tr></table>',
      'table { width: 600px; }');
    return { result, chart: result.deck.slides[0].elements.find((element) => element.type === 'chart') };
  };

  const outside = chartOf('data-chart-label-pos="outEnd"');
  assert.ok(outside.chart, 'the chart element exists');
  assert.equal(outside.chart.options.dataLabelPosition, 'outEnd', 'the short name is the same declaration');
  assert.equal(outside.chart.options.showValue, true, 'a position needs labels, so they are asked for');
  assert.deepEqual(reportProperties(outside.result), [], 'nothing is lost');

  const inside = chartOf('data-chart-label-pos="inside-base" data-chart-grouping="stacked"', 'bar');
  assert.equal(inside.chart.options.dataLabelPosition, 'inBase',
    'the alias table reaches the one token the writer needs for a stacked bar');

  const asked = chartOf('data-chart-label-pos="outEnd" data-chart-labels="percent"');
  assert.equal(asked.chart.options.dataLabelPosition, 'outEnd');
  assert.equal(asked.chart.options.showPercent, true, 'the labels the design named win');
  assert.equal(asked.chart.options.showValue, undefined,
    'a percent label with a position does not grow a second line of value labels');

  // A shape the writer cannot spell `outEnd` for is the writer's own filter, and it says so under
  // the long name it was always reported with.
  const filtered = chartOf('data-chart-label-pos="outEnd"', 'bar');
  assert.equal(filtered.chart.options.dataLabelPosition, undefined, 'the shape filter deletes it');
  assert.equal(reportsOf(filtered.result, 'data-chart-label-position').length, 1,
    'and names the position it could not use');

  const refused = chartOf('data-chart-label-pos="sideways"');
  const refusedReports = reportsOf(refused.result, 'data-chart-label-pos');
  assert.equal(refusedReports.length, 1, 'the name that was written is the name that is reported');
  assert.match(refusedReports[0], /outside-end, inside-end, center/u);
  assert.equal(refused.chart.options.dataLabelPosition, undefined);

  // The long spelling still reports under its own name, so a typo reads like the attribute.
  const longName = chartOf('data-chart-label-position="sideways"');
  assert.equal(reportsOf(longName.result, 'data-chart-label-position').length, 1);
  assert.equal(reportsOf(longName.result, 'data-chart-label-pos').length, 0);
});

