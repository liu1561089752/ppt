'use strict';

// Tiled picture fills and the fit/crop geometry, verified where they are decided: the tile is
// checked on the emitted package (only the XML says whether the pattern is really a pattern)
// and the geometry on the resolver, with a known source size so the numbers are exact.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const JSZip = require(require.resolve('jszip', { paths: [require.resolve('../native/engine/native_pptx')] }));
const {
  generatePptx,
  applyTileFill,
  patchTiledFills
} = require('../native/engine/native_pptx');
const {
  resolveImageGeometry,
  fitDrawnSize,
  tileOrigin,
  srcRectAttributes
} = require('../native/engine/image_fit');
const { makePng } = require('../native/scripts/sample_image');

const PNG = 'data:image/png;base64,' + makePng(40, 100).toString('base64');
const inch = (px) => Number((px / 96).toFixed(4));

async function writePptx(deck) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'native-fill-'));
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
    cleanup() {
      fs.rmSync(directory, { recursive: true, force: true });
    }
  };
}

function pictures(slide) {
  return slide.match(/<p:pic>[\s\S]*?<\/p:pic>/gu) || [];
}

function tileOf(pic) {
  const found = /<a:tile\b([^>]*)\/>/u.exec(pic);
  if (!found) return null;
  const read = (name) => {
    const attribute = new RegExp('\\s' + name + '="(-?\\d+)"', 'u').exec(found[1]);
    return attribute ? Number(attribute[1]) : null;
  };
  return { tx: read('tx'), ty: read('ty'), sx: read('sx'), sy: read('sy') };
}

/** A geometry element with a known source size, so nothing has to be decoded from disk. */
function geometry(overrides) {
  return resolveImageGeometry(Object.assign({
    type: 'image', x: 0.5, y: 0.5, w: inch(200), h: inch(150)
  }, overrides, { naturalSize: overrides.naturalSize || { width: 40, height: 100 } }), {});
}

test('a repeating background is one native tile, not a stretched copy', async () => {
  // 40px cell in a 200x150px box: five cells across and three and three quarters down. The
  // percentages are the cell against the picture's own frame (100000 = the frame's size).
  const deck = await writePptx({
    slides: [{
      elements: [{
        type: 'image', data: PNG, x: 0.5, y: 0.5, w: inch(200), h: inch(150),
        tile: { x: true, y: true, width: inch(40), height: inch(40) }
      }]
    }]
  });
  try {
    const slide = await deck.slide();
    const pic = pictures(slide)[0];
    const tile = tileOf(pic);
    assert.ok(tile, 'the picture fill carries an a:tile: ' + pic);
    assert.equal(tile.sx, Math.round(inch(40) / inch(200) * 100000), 'five cells across');
    assert.equal(tile.sy, Math.round(inch(40) / inch(150) * 100000), 'and a cell that size down');
    assert.ok(tile.sx >= 19000 && tile.sx <= 20100, 'about a fifth of the frame: ' + tile.sx);
    assert.equal(tile.tx, 0, 'an undeclared background-position starts at the corner, not centred');
    assert.equal(tile.ty, 0);
    // A tiled fill is the whole fill: no stretch beside it, and no source rectangle either -
    // the cell is the pattern, so cropping it would crop every repetition.
    assert.ok(!pic.includes('<a:stretch'), 'no stretch is left beside the tile: ' + pic);
    assert.ok(!/<a:srcRect\b/u.test(pic), 'no source rectangle in a tiled fill: ' + pic);
  } finally {
    deck.cleanup();
  }
});

test('an axis that does not repeat keeps the stretch percentage', async () => {
  const deck = await writePptx({
    slides: [{
      elements: [{
        type: 'image', data: PNG, x: 0.5, y: 0.5, w: inch(200), h: inch(150),
        tile: { x: true, y: false, width: inch(48), height: inch(24) }
      }]
    }]
  });
  try {
    const tile = tileOf(pictures(await deck.slide())[0]);
    assert.equal(tile.sx, Math.round(inch(48) / inch(200) * 100000), 'repeat-x keeps the column size');
    assert.equal(tile.sy, 100000, 'repeat-x stretches one cell down the whole frame');
  } finally {
    deck.cleanup();
  }
});

test('a tiled picture is drawn at its box, whatever fit the layer declares', async () => {
  // The cell is a percentage of the frame, so a letterboxed frame would both shrink the pattern
  // and put it in the wrong place. `contain` on a repeating layer therefore still fills the box.
  const deck = await writePptx({
    slides: [{
      elements: [{
        type: 'image', data: PNG, x: 0.5, y: 0.5, w: inch(200), h: inch(150), fit: 'contain',
        tile: { x: true, y: true, width: inch(40), height: inch(40) }
      }]
    }]
  });
  try {
    const pic = pictures(await deck.slide())[0];
    const ext = /<a:ext\s+cx="(\d+)"\s+cy="(\d+)"\/>/u.exec(pic);
    assert.equal(Number(ext[1]), Math.round(inch(200) * 914400), 'the frame is the whole box');
    assert.equal(Number(ext[2]), Math.round(inch(150) * 914400));
    assert.ok(tileOf(pic), 'and it is still tiled');
  } finally {
    deck.cleanup();
  }
});

test('the background-position offset moves the pattern by a share of its own cell', async () => {
  // `background-position` is a placement, not an `object-position` focus: a length is the
  // offset itself and a percentage moves the pattern across the slack between box and cell.
  assert.deepEqual(tileOrigin(undefined, { w: 2.5, h: 1.5 }, { width: 0.5, height: 0.5 }),
    { x: 0, y: 0 }, 'undeclared is 0% 0%, the corner');
  assert.deepEqual(tileOrigin({ x: 0.5, y: 0.5 }, { w: 2.5, h: 1.5 }, { width: 0.5, height: 0.5 }),
    { x: 1, y: 0.5 }, '50% centres the pattern in the slack (2.5-0.5)/2 and (1.5-0.5)/2');
  assert.deepEqual(tileOrigin('0.25in 0.1in', { w: 2.5, h: 1.5 }, { width: 0.5, height: 0.5 }),
    { x: 0.25, y: 0.1 }, 'a length is the offset from the box corner, as CSS places it');
  assert.deepEqual(tileOrigin('bottom right', { w: 2.5, h: 1.5 }, { width: 0.5, height: 0.5 }),
    { x: 2, y: 1 }, 'a keyword pair in either order still means the far corner');

  const deck = await writePptx({
    slides: [{
      elements: [{
        type: 'image', data: PNG, x: 0.5, y: 0.5, w: 2.5, h: 1.5, focus: { x: 0.5, y: 0.25 },
        tile: { x: true, y: true, width: 0.5, height: 0.5 }
      }]
    }]
  });
  try {
    const tile = tileOf(pictures(await deck.slide())[0]);
    assert.equal(tile.tx, 200000, 'a 1in slack shift is two cells to the right');
    assert.equal(tile.ty, 50000, 'and half a cell down');
  } finally {
    deck.cleanup();
  }
});

test('a picture without a tile keeps the stretched fill it had', async () => {
  const deck = await writePptx({
    slides: [{ elements: [{ type: 'image', data: PNG, x: 0.5, y: 0.5, w: 2, h: 1, fit: 'cover' }] }]
  });
  try {
    const pic = pictures(await deck.slide())[0];
    assert.equal(tileOf(pic), null, 'no tile node');
    assert.ok(pic.includes('<a:stretch><a:fillRect/></a:stretch>'), 'the writer\'s stretch is untouched');
    assert.ok(/<a:srcRect\b/u.test(pic), 'and the cover crop is still there');
    // Nothing to do, so the patch says so instead of rewriting the package.
    assert.equal(await patchTiledFills(deck.output, deck.result.tiledFills), false);
  } finally {
    deck.cleanup();
  }
});

test('the tile patch is idempotent', async () => {
  const deck = await writePptx({
    slides: [{
      elements: [{
        type: 'image', data: PNG, x: 0.5, y: 0.5, w: 2.5, h: 1.5, focus: '0.25in 0.1in',
        tile: { x: true, y: true, width: 0.5, height: 0.5 }
      }]
    }]
  });
  try {
    const first = await deck.slide();
    assert.equal(await patchTiledFills(deck.output, deck.result.tiledFills), false,
      'a second run has nothing to change');
    assert.equal(await deck.slide(), first, 'and the part is byte-identical');
    assert.equal((first.match(/<a:tile\b/gu) || []).length, 1, 'still exactly one tile node');
  } finally {
    deck.cleanup();
  }
});

test('the tile patch refuses a spec and a package that do not line up', async () => {
  const deck = await writePptx({
    slides: [{
      elements: [{
        type: 'image', data: PNG, x: 0.5, y: 0.5, w: 2.5, h: 1.5,
        tile: { x: true, y: true, width: 0.5, height: 0.5 }
      }]
    }]
  });
  try {
    const plan = { tile: { x: true, y: true, width: 0.5, height: 0.5 }, box: { x: 0.5, y: 0.5, w: 2.5, h: 1.5 } };
    await assert.rejects(patchTiledFills(deck.output, [[plan, plan]]),
      /alignment mismatch on slide 1: Deck Spec has 2 image elements but PPTX has 1 p:pic/,
      'two plans, one picture');
    await assert.rejects(patchTiledFills(deck.output, [[Object.assign({}, plan, { box: { x: 0.5, y: 0.5, w: 1, h: 1 } })]]),
      /frame mismatch on slide 1.*picture frame is 2\.5x1\.5in/,
      'the cell is a percentage of the frame, so a frame the spec did not ask for is an error');
  } finally {
    deck.cleanup();
  }
});

test('a tiled fill drops a crop rather than cropping every repetition', () => {
  const pic = '<p:pic><p:blipFill><a:blip r:embed="rId1"/><a:srcRect l="10000" t="0" r="0" b="0"/>'
    + '<a:stretch><a:fillRect/></a:stretch></p:blipFill></p:pic>';
  const tiled = applyTileFill(pic, {
    tile: { x: true, y: true, width: 0.5, height: 0.5 },
    box: { x: 0, y: 0, w: 2.5, h: 1.5 },
    focus: undefined
  });
  assert.ok(!/<a:srcRect\b/u.test(tiled), 'the source rectangle is gone: ' + tiled);
  assert.ok(tiled.includes('<a:tile tx="0" ty="0" sx="20000" sy="33333" flip="none" algn="tl"/>'),
    'and the tile is where the stretch was: ' + tiled);
  // The same call again replaces its own node instead of looking for a stretch that is gone.
  assert.equal(applyTileFill(tiled, {
    tile: { x: true, y: true, width: 0.5, height: 0.5 },
    box: { x: 0, y: 0, w: 2.5, h: 1.5 },
    focus: undefined
  }), tiled);
});

test('a cover crop with a length object-position crops from the near edge', () => {
  // CSS lengths are measured from the box's left/top edge, so a positive offset pushes the
  // object inward: the browser answers with a gap and crops from the far edge, and the window
  // the engine can draw starts at that edge. A negative offset is what moves the window down
  // the source. 40x100 source in a 200x100 box: drawn 200x500, 400px of slack.
  const box = { w: inch(200), h: inch(100) };
  const near = Math.round;
  const down = geometry(Object.assign({ fit: 'cover', focus: '10px 20px' }, box));
  assert.equal(near(down.srcRect.top * 100000), 0, 'positive offset: no crop at the top');
  assert.ok(Math.abs(near(down.srcRect.bottom * 100000) - 80000) <= 2,
    'the whole overflow is cropped at the bottom: ' + srcRectAttributes(down.srcRect));

  const up = geometry(Object.assign({ fit: 'cover', focus: '-10px -20px' }, box));
  assert.ok(Math.abs(near(up.srcRect.top * 100000) - 4000) <= 2,
    '20px of a 500px object is 4% of the source: ' + srcRectAttributes(up.srcRect));
  assert.ok(Math.abs(near(up.srcRect.bottom * 100000) - 76000) <= 2,
    'and 76% is cropped from the bottom: ' + srcRectAttributes(up.srcRect));

  // A percentage position reaches the engine already resolved to a 0..1 focus, the way the
  // analyzer hands it over.
  const hundred = geometry(Object.assign({ fit: 'cover', focus: { x: 1, y: 1 } }, box));
  assert.ok(Math.abs(near(hundred.srcRect.top * 100000) - 80000) <= 2,
    'percentages still resolve as before: ' + srcRectAttributes(hundred.srcRect));
  assert.equal(near(hundred.srcRect.bottom * 100000), 0);
});

test('a contained picture is still placed at a length offset', () => {
  // A contained object is smaller than its slot, so the length is the distance from the edge -
  // the case the browser draws without a gap.
  const placed = geometry({ fit: 'contain', focus: '20px 0' });
  assert.ok(Math.abs(placed.box.x - (0.5 + 20 / 96)) < 0.002, 'placed 20px in: ' + placed.box.x);
  const corner = geometry({ fit: 'contain', focus: 'left top' });
  assert.ok(Math.abs(corner.box.x - 0.5) < 0.002, 'the keyword form lands top left: ' + corner.box.x);
});

test('object-fit: none draws at its own pixel size, and a length places it in inches', () => {
  // `none` used to mix pixels and inches in the position arithmetic (a 40px source was read as
  // 40in of slack), so the drawn size is checked here as well as the placement.
  assert.deepEqual(fitDrawnSize({ width: 40, height: 100 }, { w: 2, h: 2 }, 'none'),
    { w: 40 / 96, h: 100 / 96 });
  assert.deepEqual(fitDrawnSize({ width: 40, height: 100 }, { w: 2, h: 2 }, 'scale-down'),
    { w: 40 / 96, h: 100 / 96 }, 'scale-down never enlarges past the source');
  const none = geometry({ fit: 'none', focus: '10px 0', w: inch(200), h: inch(150) });
  assert.ok(Math.abs(none.box.x - (0.5 + 10 / 96)) < 0.002, 'a 10px offset is 10px: ' + none.box.x);
  assert.ok(Math.abs(none.box.w - 40 / 96) < 1e-6, 'drawn at its own size: ' + none.box.w);
});

test('a declared crop and a fit mode compose instead of one of them winning', () => {
  // The analyzer's clip-path inset arrives as a crop; the fit mode still has to place it. Both
  // are source fractions, so the fit's window is nested inside the crop.
  const stretched = geometry({ fit: 'stretch', crop: { left: 0.1, top: 0.2, right: 0.3, bottom: 0.1 } });
  assert.deepEqual(stretched.srcRect, { left: 0.1, top: 0.2, right: 0.3, bottom: 0.1 },
    'a stretched crop is drawn as the source rectangle it declares');
  // No crop used to be the only thing a stretch could draw; now the frame is still the box.
  assert.deepEqual(stretched.box, { x: 0.5, y: 0.5, w: inch(200), h: inch(150) });

  // cover over the visible part: a 40x100 source whose crop keeps rows 20%..90% (70 rows, 40
  // wide), so covering a 200x150 box scales it 5x to 200x350 and shows 30 of those 70 rows.
  const covered = geometry({ fit: 'cover', crop: { left: 0, top: 0.2, right: 0, bottom: 0.1 } });
  const rect = covered.srcRect;
  assert.ok(Math.abs((1 - rect.left - rect.right) - 1) < 1e-9, 'nothing cropped sideways: ' + srcRectAttributes(rect));
  const visible = 1 - rect.top - rect.bottom;
  assert.ok(Math.abs(visible - 0.30) < 0.01,
    'the visible band is the crop 5x-scaled into the box - 30 of the 100 source rows: ' + srcRectAttributes(rect));
  assert.ok(rect.top >= 0.2 - 1e-9 && rect.bottom >= 0.1 - 1e-9,
    'the window stays inside the crop: ' + srcRectAttributes(rect));
  assert.ok(Math.abs(rect.top - 0.4) < 0.01, 'centred in the crop it starts 20 rows in: ' + srcRectAttributes(rect));

  // A crop with no natural size still draws: the crop is source fractions, so it does not need
  // the pixel size that a cover crop does.
  const unmeasured = resolveImageGeometry({
    type: 'image', x: 0, y: 0, w: 1, h: 1, fit: 'stretch', crop: { left: 0.25, top: 0, right: 0, bottom: 0 },
    path: 'F:/native-ppt-engine/does-not-exist.png'
  }, {});
  assert.match(srcRectAttributes(unmeasured.srcRect), /l="25000"/u, 'the crop survives an unmeasurable source');
});
