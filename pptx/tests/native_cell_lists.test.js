'use strict';

/**
 * A list inside a table cell, a ruby reading, and the anchor around a picture.
 *
 * All three were quiet losses: the cell ran its items together on one unmarked line, the
 * reading sat inline with nothing said about where it belongs, and the anchor around a
 * picture left no url on the image node. These tests hold the shape the writer reads.
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const pipeline = require('../native/pipeline');
const { generatePptx } = require('../native/engine/native_pptx');
// JSZip is resolved from the engine's own dependency folder, the way the rest of the
// suite does: the pipeline has no direct dependency on it.
const JSZip = require(require.resolve('jszip', { paths: [require.resolve('../native/engine/native_pptx')] }));

const page = (body, extraCss) => [
  '<html><head><style>',
  '  .slide { width: 1280px; height: 720px; padding: 40px; font-size: 14px; }',
  '  table { width: 800px; }',
  '  td { font-size: 16px; }',
  extraCss || '',
  '</style></head><body><main class="slide">' + body + '</main></body></html>'
].join('\n');

const convert = (body, extraCss) => pipeline.convertHtml(page(body, extraCss));

/** The first table node of the first slide, wherever the layout put it. */
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

const firstCell = (result) => {
  const table = firstTable(result);
  assert.ok(table, 'the html produced a table node');
  return table.rows[0][0];
};

/** Every node of the first slide, depth first. */
const allNodes = (result) => {
  const found = [];
  const visit = (node) => {
    found.push(node);
    (node.children || []).forEach(visit);
  };
  result.analysis.slides[0].nodes.forEach(visit);
  return found;
};

/** The `<a:p>` paragraphs of one `<a:tc>` of the written slide, as their text. */
const paragraphsOf = (html) => {
  const result = convert(html);
  const output = path.join(os.tmpdir(), 'native-cell-paragraphs-' + process.pid + '.pptx');
  return generatePptx(result.deck, output).then(async () => {
    const zip = await JSZip.loadAsync(fs.readFileSync(output));
    const xml = await zip.file('ppt/slides/slide1.xml').async('string');
    fs.rmSync(output, { force: true });
    const table = (/<a:tbl>[\s\S]*?<\/a:tbl>/u.exec(xml) || [''])[0];
    assert.ok(table, 'the slide carries a table');
    return [...table.matchAll(/<a:tc>[\s\S]*?<\/a:tc>/gu)].map((cell) => {
      const paragraphs = [...cell[0].matchAll(/<a:p>[\s\S]*?<\/a:p>/gu)].map((paragraph) =>
        [...paragraph[0].matchAll(/<a:t>([\s\S]*?)<\/a:t>/gu)].map((runs) => runs[1]).join(''));
      return paragraphs;
    });
  });
};

test('a list in a table cell becomes one paragraph per item', () => {
  const cell = firstCell(convert('<table><tr><td><ul><li>甲</li><li>乙</li></ul></td></tr></table>'));
  // The cell text is the paragraph array, not the run-together string "甲乙" it used to be:
  // PptxGenJS writes one `<a:p>` per paragraph object, so the items land on their own lines.
  assert.ok(Array.isArray(cell.text), 'the cell text is a paragraph array');
  assert.deepEqual(cell.text, [
    { text: '甲', options: { bullet: { type: 'bullet' }, breakLine: true } },
    { text: '乙', options: { bullet: { type: 'bullet' } } }
  ]);
  // Everything that is not the text stays on the cell, untouched.
  assert.equal(typeof cell.options, 'object');
  assert.equal(cell.options.fontSize, 12);
});

test('the written cell carries one <a:p> per paragraph, one item each', async () => {
  const [cell] = await paragraphsOf('<table><tr><td><ul><li>甲</li><li>乙</li></ul></td><td>plain</td></tr></table>');
  assert.deepEqual(cell, ['甲', '乙']);
});

test('a cell without a list is still a plain string', () => {
  const rows = firstTable(convert('<table><tr><td>甲</td><td><p>一</p><p>二</p></td></tr></table>')).rows;
  // Byte-identical to what it always wrote: block children of a cell that holds no list are
  // still flattened into the one string the writer has always taken.
  assert.equal(typeof rows[0][0].text, 'string');
  assert.equal(rows[0][0].text, '甲');
  assert.equal(typeof rows[0][1].text, 'string');
  assert.equal(rows[0][1].text, '一二');
});

test('a nested ordered list in a cell counts, and keeps its depth', () => {
  const cell = firstCell(convert(
    '<table><tr><td><ol><li>一<ol><li>一甲</li></ol></li><li>二</li></ol></td></tr></table>'));
  const outer = cell.text.find((paragraph) => paragraph.text === '一');
  const inner = cell.text.find((paragraph) => paragraph.text === '一甲');
  assert.equal(outer.options.bullet.type, 'number', 'an ol numbers its items');
  assert.equal(outer.options.bullet.style, 'arabicPeriod');
  assert.equal(inner.options.bullet.type, 'number', 'the nested ol numbers too');
  assert.equal(inner.options.indentLevel, 1, 'and sits one level in');
  // Only the last paragraph closes without a break, so the items do not merge into one line.
  assert.equal(cell.text[cell.text.length - 1].options.breakLine, undefined);
  assert.equal(cell.text.filter((paragraph) => paragraph.options.breakLine).length, cell.text.length - 1);
});

test('a declared start and an item value travel as the count they name', () => {
  const cell = firstCell(convert(
    '<table><tr><td><ol start="5"><li>五</li><li value="9">九</li><li>十</li></ol></td></tr></table>'));
  assert.equal(cell.text[0].options.bullet.startAt, 5, 'start="5" begins the count at five');
  assert.equal(cell.text[1].options.bullet.startAt, 9, 'value="9" restarts that item at nine');
  // The third item continues the count, so it carries no `startAt` of its own: a reader reads
  // the attribute as "start here", so a number on every item counted 9, 9, 9.
  assert.equal(cell.text[2].options.bullet.startAt, undefined);
});

test('a sentence beside a list in the same cell keeps its words', () => {
  const cell = firstCell(convert('<table><tr><td>说明<ul><li>甲</li><li>乙</li></ul></td></tr></table>'));
  assert.deepEqual(cell.text.map((paragraph) => paragraph.text), ['说明', '甲', '乙']);
  assert.equal(cell.text[0].options.bullet, undefined, 'the sentence is not a list item');
});

test('a ruby reading is reported once per element and its text is kept', () => {
  const result = convert('<p>漢字<ruby>東京<rt>とうきょう</rt></ruby></p>');
  const entries = result.report.unsupportedDetails.filter((entry) => entry.property === 'ruby');
  assert.equal(entries.length, 1, 'one element, one report');
  assert.equal(entries[0].tag, 'ruby');
  assert.equal(entries[0].value, 'とうきょう', 'the reading is named, not just the element');
  assert.match(entries[0].reason, /cannot be placed above its base text/u);
  // No content is lost: the text is what the line always held, reading and all.
  const text = allNodes(result).find((node) => node.kind === 'text');
  assert.equal(text.text, '漢字東京とうきょう');
});

test('two ruby elements are two reports, not one repeated', () => {
  const result = convert('<p><ruby>東<rt>とう</rt></ruby>と<ruby>京<rt>きょう</rt></ruby></p>');
  const readings = result.report.unsupportedDetails
    .filter((entry) => entry.property === 'ruby')
    .map((entry) => entry.value);
  assert.deepEqual(readings, ['とう', 'きょう']);
});

test('a picture inside an anchor carries the url on the image node', () => {
  const png = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==';
  const image = (result) => allNodes(result).find((node) => node.kind === 'image');
  const linked = image(convert('<a href="https://example.com/x"><img src="' + png + '" width="200" height="100"></a>'));
  assert.ok(linked, 'the html produced an image node');
  // The raw attribute string, which is what the writer turns into the link.
  assert.equal(linked.href, 'https://example.com/x');
  assert.equal(linked.alt, '', 'a picture with no alt keeps its empty alt');

  const plain = image(convert('<img src="' + png + '" width="200" height="100">'));
  assert.equal(plain.href, undefined, 'an unlinked picture carries no link');

  const mail = image(convert('<a href="mailto:team@example.com"><img src="' + png + '" width="200" height="100"></a>'));
  assert.equal(mail.href, 'mailto:team@example.com', 'a mailto: link survives unchanged');
});

// --- progress bars, meters and video posters ------------------------------------------------

const PNG = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==';

/** The first element of the first slide. */
const firstElement = (result) => {
  const elements = result.deck.slides[0].elements;
  assert.ok(elements.length, 'the html produced at least one element');
  return elements[0];
};

/** The filled fraction of a bar: the fill's width against the track's inner width. */
const fillRatio = (bar) => {
  const fill = bar.children && bar.children[0];
  assert.ok(fill, 'the bar carries a filled shape');
  const inner = bar.w - bar.padding.left - bar.padding.right;
  return fill.w / inner;
};

/** The fraction is a drawn length, rounded to 1/10000 of an inch, so it is compared with slack. */
const assertRatio = (bar, expected, message) => {
  const actual = fillRatio(bar);
  assert.ok(Math.abs(actual - expected) < 0.002, (message || 'filled fraction') + ': ' + actual + ' against ' + expected);
};

test('a progress bar is drawn as a track and the part of it that is done', () => {
  const bar = firstElement(convert('<progress value="40" max="100"></progress>'));
  // Two native shapes: the element box is the track, one child is the filled part. Before this
  // a progress element drew nothing at all and said nothing either.
  assert.equal(bar.type, 'container');
  // Chrome's own bar, measured: 160px wide and 8px tall, not the whole page width.
  assert.equal(bar.w, 1.6667);
  assert.equal(bar.h, 0.0833);
  assert.equal(bar.background.fill, 'EFEFEF', 'the track is the browser light grey');
  assert.equal(bar.background.lineColor, 'B2B2B2', 'under its hairline edge');
  assertRatio(bar, 0.4, '40 of 100 is 40% of the track');
  assert.equal(bar.children[0].fill, '0075FF', 'in the browser accent');
});

test('a meter gauge fills by its value between min and max', () => {
  // HTML's own range: min 0, max 1 unless declared.
  assertRatio(firstElement(convert('<meter value="0.25">x</meter>')), 0.25);
  assertRatio(firstElement(convert('<meter min="10" max="30" value="20">x</meter>')), 0.5,
    'a declared range is the denominator');
  const bar = firstElement(convert('<meter value="0.25">x</meter>'));
  assert.equal(bar.children[0].fill, '107C10', 'a meter fills in the browser green');
  // The fallback words are not drawn by the browser once the gauge renders, so the deck's
  // text is the bar itself rather than the "25%" the element happens to carry.
  assert.equal(bar.type, 'container');
});

test('a value outside the range is clamped the way the browser clamps it', () => {
  assertRatio(firstElement(convert('<progress value="250" max="100"></progress>')), 1);
  // A value below the range fills nothing, so only the track is drawn - the same shape a bar
  // sitting at 0% gets.
  const empty = firstElement(convert('<progress value="-5" max="100"></progress>'));
  assert.equal(empty.type, 'shape');
  assert.equal(empty.children, undefined);
});

test('the accent colour a design declares is the bar it draws', () => {
  // `accent-color` is the browser's own way to colour a progress bar, so the deck honours it
  // instead of reporting it as an unsupported property.
  const declared = firstElement(convert('<progress value="40" max="100" style="accent-color: #B3261E"></progress>'));
  assert.equal(declared.children[0].fill, 'B3261E');

  // With no accent declared the bar takes the deck's own colour, read from the same custom
  // properties the theme is derived from, so it belongs to the deck rather than to Chrome.
  const themed = firstElement(convert('<progress value="40" max="100"></progress>',
    ':root { --accent: #C2410C; }'));
  assert.equal(themed.children[0].fill, 'C2410C');
});

test('a declared size and radius are the bar the design asked for', () => {
  const bar = firstElement(convert(
    '<progress value="62" max="100" style="width: 240px; height: 10px; border-radius: 2px"></progress>'));
  assert.equal(bar.w, 2.5, '240px');
  assert.equal(bar.h, 0.1042, '10px');
  assert.equal(bar.background.radius, 0.021, 'the declared 2px radius, on the track and the fill');
  assert.equal(bar.children[0].radius, 0.021);
  assertRatio(bar, 0.62);
});

test('a bar with no value draws the empty track and says why', () => {
  const result = convert('<progress></progress>');
  const bar = firstElement(result);
  assert.equal(bar.type, 'shape', 'the track alone, with no fill to draw');
  assert.equal(bar.fill, 'EFEFEF');
  const entries = result.report.unsupportedDetails.filter((entry) => entry.property === 'progress');
  assert.equal(entries.length, 1);
  assert.equal(entries[0].value, 'indeterminate');
  assert.match(entries[0].reason, /cannot animate/u);
  // Nothing to say about a bar that is merely empty.
  assert.deepEqual(convert('<progress value="0" max="100"></progress>').report.unsupportedDetails, []);
});

test('a bar inside a line of text is named instead of vanishing', () => {
  // A run carries characters, so a bar cannot sit in a line box: the words are kept and the
  // bar is reported. Silently skipping it is the defect this engine refuses.
  const result = convert('<p>完成 <progress value="40" max="100"></progress> 了</p>');
  const entries = result.report.unsupportedDetails.filter((entry) => entry.property === 'element');
  assert.equal(entries.length, 1);
  assert.equal(entries[0].value, 'progress');
  assert.match(entries[0].reason, /box of its own/u);
});

test('the written bar is two shapes in the colours it reports', async () => {
  const result = convert('<progress value="40" max="100"></progress>');
  const output = path.join(os.tmpdir(), 'native-gauge-' + process.pid + '.pptx');
  await generatePptx(result.deck, output);
  const zip = await JSZip.loadAsync(fs.readFileSync(output));
  const xml = await zip.file('ppt/slides/slide1.xml').async('string');
  fs.rmSync(output, { force: true });
  const shapes = [...xml.matchAll(/<p:sp>[\s\S]*?<\/p:sp>/gu)].map((match) => match[0]);
  assert.equal(shapes.length, 2, 'a track and a fill');
  const fills = shapes.map((shape) => (/<a:solidFill><a:srgbClr val="([0-9A-F]{6})"/u.exec(shape) || [])[1]);
  assert.deepEqual(fills, ['EFEFEF', '0075FF']);
  // The fill is inside the track and narrower than it.
  const widths = shapes.map((shape) => Number((/<a:ext cx="(\d+)"/u.exec(shape) || [])[1]));
  assert.ok(widths[1] < widths[0], 'the fill is narrower than its track: ' + widths.join(' < '));
  assert.ok(Math.abs(widths[0] - 160 * 9525) <= 9525, 'the track is 160px wide: ' + widths[0]);
});

test('a video draws its poster frame and still reports the player', () => {
  const result = convert('<video poster="' + PNG + '" width="320" height="180"></video>');
  const element = firstElement(result);
  // The poster is a picture, and a picture is exactly what this engine draws: the design's
  // video area is no longer an empty hole.
  assert.equal(element.type, 'image');
  assert.equal(element.data, PNG);
  assert.equal(element.w, 3.3333, 'the box stays the size of the video');
  assert.equal(element.h, 1.875);
  const entries = result.report.unsupportedDetails.filter((entry) => entry.property === 'element');
  assert.equal(entries.length, 1);
  assert.equal(entries[0].value, 'video');
  assert.match(entries[0].reason, /poster frame is drawn/u, 'and says the frame is drawn, not lost');
});

test('a poster the engine cannot read keeps the empty box and says why', () => {
  const remote = convert('<video poster="https://example.com/frame.jpg" width="320" height="180"></video>');
  assert.deepEqual(remote.deck.slides[0].elements, [], 'no picture bytes, so nothing is drawn');
  const poster = remote.report.unsupportedDetails.filter((entry) => entry.property === 'poster');
  assert.equal(poster.length, 1);
  assert.equal(poster[0].value, 'https://example.com/frame.jpg');
  assert.match(poster[0].reason, /no poster frame is drawn/u);

  // A video with no poster at all keeps the old report and nothing else.
  const bare = convert('<video src="clip.mp4" width="320" height="180"></video>');
  assert.deepEqual(bare.deck.slides[0].elements, []);
  assert.deepEqual(bare.report.unsupportedDetails.map((entry) => entry.property), ['element']);
});

// --- links around boxes, and links inside cells --------------------------------------------

/** The slide part and its relationships, read back from a written package. */
const writtenSlide = async (result) => {
  const output = path.join(os.tmpdir(), 'native-links-' + process.pid + '-' + Math.random().toString(36).slice(2) + '.pptx');
  await generatePptx(result.deck, output);
  const zip = await JSZip.loadAsync(fs.readFileSync(output));
  const parts = {
    xml: await zip.file('ppt/slides/slide1.xml').async('string'),
    rels: await zip.file('ppt/slides/_rels/slide1.xml.rels').async('string')
  };
  fs.rmSync(output, { force: true });
  return parts;
};

/** The external urls the package points at: one per click target a reader can follow. */
const externalTargets = (rels) => [...rels.matchAll(/<Relationship[^>]*TargetMode="External"[^>]*/gu)]
  .map((match) => (/Target="([^"]*)"/u.exec(match[0]) || [])[1]);

test('a link around a block lands on the box it wraps', async () => {
  const result = convert('<a href="https://example.com/card" class="card">'
    + '<h2>标题</h2><p>副文</p></a>', '.card { display: block; background: #EEF3F2; padding: 16px; }');
  // The url travels on the anchor's own node, in the same raw form the picture path uses.
  const anchor = allNodes(result).find((node) => node.tag === 'a');
  assert.equal(anchor.href, 'https://example.com/card');
  // Every object the card paints carries the click, not only the panel under the words.
  // A reader aims at the headline as often as at the padding, and PowerPoint does not let a
  // click fall through from a text box to the shape beneath it - so the first-object rule
  // made "the whole card is a link" true only for its margins.
  const linked = result.deck.slides[0].elements.filter((element) => element.hyperlink);
  const tree = (element) => [element, ...(element.children || []).flatMap(tree)];
  const linkedEverywhere = result.deck.slides[0].elements.flatMap(tree)
    .filter((element) => element.type !== 'container' && element.hyperlink);
  assert.equal(linkedEverywhere.length, 3, 'panel and both lines carry it: ' + linkedEverywhere.map((e) => e.type).join(', '));
  linkedEverywhere.forEach((element) => assert.equal(element.hyperlink.url, 'https://example.com/card'));
  const parts = await writtenSlide(result);
  assert.equal(externalTargets(parts.rels).length, 1, 'one relationship for one url');
  assert.equal([...parts.xml.matchAll(/<a:hlinkClick/gu)].length, 3, 'one click per object');
  // The writer's text-level hyperlink option is what underlined linked words; the shape-level
  // patch must not bring it back.
  assert.equal([...parts.xml.matchAll(/u="sng"/gu)].length, 0, 'no run gained an underline');
});

test('a link around a picture stays one link, on the picture', async () => {
  const result = convert('<a href="https://example.com/i"><img src="' + PNG + '" width="200" height="100"></a>');
  const linked = result.deck.slides[0].elements.filter((element) => element.hyperlink);
  assert.equal(linked.length, 1);
  assert.equal(linked[0].type, 'image');
  assert.equal(linked[0].hyperlink.url, 'https://example.com/i');
  const parts = await writtenSlide(result);
  assert.deepEqual(externalTargets(parts.rels), ['https://example.com/i'], 'one relationship, not two');
});

test('a cell that is one link is a click on the cell', async () => {
  const result = convert('<table><tr><td><a href="https://example.com/x">链接</a></td></tr></table>');
  const cell = firstCell(result);
  // A cell has no runs, so the whole cell carries the link - which the writer does support.
  assert.deepEqual(cell.options.hyperlink, { url: 'https://example.com/x' });
  assert.equal(cell.text, '链接', 'and the words are unchanged');
  const parts = await writtenSlide(result);
  assert.equal([...parts.xml.matchAll(/<a:hlinkClick/gu)].length, 1);
  assert.deepEqual(externalTargets(parts.rels), ['https://example.com/x']);
});

test('a link around part of a cell is named and the cell stays unlinked', async () => {
  // Linking it would make 前缀 and 后缀 clickable too, so the loss is named instead.
  const result = convert('<table><tr><td>前缀<a href="https://example.com/y">链接</a>后缀</td></tr></table>');
  const cell = firstCell(result);
  assert.equal(cell.options.hyperlink, undefined);
  assert.equal(cell.text, '前缀链接后缀');
  const entries = result.report.unsupportedDetails.filter((entry) => entry.property === 'href');
  assert.equal(entries.length, 1);
  assert.equal(entries[0].value, 'https://example.com/y');
  assert.match(entries[0].reason, /would make the whole cell clickable/u);
  const parts = await writtenSlide(result);
  assert.deepEqual(externalTargets(parts.rels), [], 'nothing to follow');
});

test('two links in one row are two cells, each with its own url', async () => {
  const result = convert('<table><tr><td><a href="https://example.com/a">一</a></td>'
    + '<td><a href="https://example.com/b">二</a></td></tr></table>');
  const row = firstTable(result).rows[0];
  assert.deepEqual(row.map((cell) => cell.options.hyperlink), [
    { url: 'https://example.com/a' },
    { url: 'https://example.com/b' }
  ]);
  const parts = await writtenSlide(result);
  assert.deepEqual(externalTargets(parts.rels), ['https://example.com/a', 'https://example.com/b']);
});

test('a link around a whole table is named: a table has no click target', () => {
  const result = convert('<a href="https://example.com/tb"><table><tr><td>甲</td></tr></table></a>');
  // The words and the table are drawn; the link is what the format cannot carry.
  assert.equal(firstTable(result).rows.length, 1);
  const entries = result.report.unsupportedDetails.filter((entry) => entry.property === 'href');
  assert.equal(entries.length, 1);
  assert.equal(entries[0].value, 'https://example.com/tb');
  assert.equal(entries[0].tag, 'table');
  assert.match(entries[0].reason, /no click target/u);
});

// --- vector pictures ------------------------------------------------------------------------

const SVG = 'data:image/svg+xml;base64,' + Buffer.from(
  '<svg xmlns="http://www.w3.org/2000/svg" width="24" height="24"><rect width="24" height="24" fill="#0a0"/></svg>'
).toString('base64');

test('an SVG picture is drawn, and the deck says only PowerPoint draws it', () => {
  // A render proved this: the package carries the vector behind PowerPoint's svgBlip extension
  // and a grey PNG fallback, so every other reader draws a placeholder. Drawn, and named.
  const result = convert(`<img src="` + SVG + `" width="24" height="24">`);
  const element = firstElement(result);
  assert.equal(element.type, 'image', 'the vector is still drawn');
  assert.equal(element.data, SVG);
  const entries = result.report.unsupportedDetails.filter((entry) => entry.property === 'svgPicture');
  assert.equal(entries.length, 1);
  assert.match(entries[0].reason, /PowerPoint 2016/u);
  assert.match(entries[0].reason, /PNG/u, 'and names the portable alternative');
  // The value is a readable label, not a kilobyte of base64.
  assert.ok(entries[0].value.length <= 68, 'the source is truncated: ' + entries[0].value.length);
  assert.ok(entries[0].value.startsWith('data:image/svg+xml'));
});

test('a deck of identical icons is one line, and two vectors are two', () => {
  const three = convert(`<div><img src="` + SVG + `" width="24" height="24">`
    + `<img src="` + SVG + `" width="24" height="24"><img src="` + SVG + `" width="24" height="24"></div>`);
  // Three pictures draw, one line is reported: the noise floor a report has to keep.
  assert.equal(three.deck.slides[0].elements.filter((element) => element.type === 'image').length, 3);
  assert.equal(three.report.unsupportedDetails.filter((entry) => entry.property === 'svgPicture').length, 1);

  // Two different vectors differ inside the readable part of their label, so they are two
  // lines: the fix is per file, and a reader would have to re-export both.
  const second = 'data:image/svg+xml;base64,' + Buffer.from(
    '<svg xmlns="http://www.w3.org/2000/svg" width="32" height="32"><circle r="8" fill="#00a"/></svg>'
  ).toString('base64');
  const two = convert(`<div><img src="` + SVG + `" width="24" height="24">`
    + `<img src="` + second + `" width="24" height="24"></div>`);
  assert.equal(two.report.unsupportedDetails.filter((entry) => entry.property === 'svgPicture').length, 2,
    'a different vector is a different line, because the fix is per file');
});

test('a PNG picture says nothing about vectors', () => {
  assert.deepEqual(convert(`<img src="` + PNG + `" width="24" height="24">`).report.unsupportedDetails, []);
});

test('a vector used as a background picture carries the same note', () => {
  const result = convert(`<div style="width: 60px; height: 60px; background-image: url(` + SVG + `)"></div>`);
  assert.equal(firstElement(result).type, 'image', 'the layer is drawn as the picture it is');
  const entries = result.report.unsupportedDetails.filter((entry) => entry.property === 'svgPicture');
  assert.equal(entries.length, 1);
  assert.match(entries[0].reason, /svgBlip/u);
});
