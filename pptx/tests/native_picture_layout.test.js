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

  // A picture that already crops or letterboxes is a second crop, and one source rectangle
  // cannot hold two.
  const cover = convert('<img class="c" src="' + SQUARE + '" alt="x">',
    '.c { width: 200px; height: 150px; object-fit: cover; clip-path: inset(10%); }');
  assert.equal(firstOfKind(cover, 'image').objectFit, 'cover');
  assert.equal(firstOfKind(cover, 'image').crop, undefined);
  assert.match(reportsOf(cover, 'clipPath')[0], /two crops/u);
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
