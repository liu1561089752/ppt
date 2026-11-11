'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { toInches, normalizePageSize } = require('../native/core/units');
const { validateDeck } = require('../native/core/schema');
const { estimateLineCount, estimateTextHeight, wrapText } = require('../native/engine/text_measure');
const { FontManager } = require('../native/engine/font_manager');
const { layoutSlide } = require('../native/engine/layout');
const { validateSlide } = require('../native/engine/validation');
const components = require('../native/components/text');

test('unit conversion is explicit and deterministic', () => {
  assert.equal(toInches(72, 'pt'), 1);
  assert.equal(toInches(96, 'px'), 1);
  assert.deepEqual(normalizePageSize('standard'), { width: 10, height: 7.5 });
});

test('deck schema rejects malformed elements', () => {
  assert.ok(validateDeck({ slides: [{ elements: [{ type: 'unknown' }] }] }).length > 0);
  assert.deepEqual(validateDeck({ slides: [{ elements: [{ type: 'text', text: '你好' }] }] }), []);
});

test('CJK text is conservatively measured wider than Latin text', () => {
  const cjk = estimateLineCount('中文排版测试中文排版测试中文排版测试', 2, 18);
  const latin = estimateLineCount('abcdefghijklmnopqr', 2, 18);
  assert.ok(cjk >= latin);
  assert.ok(estimateTextHeight('一段中文文本', 3, 18) > 0);
});

test('layout assigns sequential positions and estimated text heights', () => {
  const elements = layoutSlide({ elements: [{ type: 'text', text: '标题', fontSize: 24 }, { type: 'text', text: '正文', fontSize: 16 }] }, normalizePageSize('wide'), {});
  assert.equal(elements[0].x, 0.58);
  assert.ok(elements[1].y > elements[0].y);
  assert.ok(elements[0].h > 0);
});

test('validator reports out-of-bounds and overlapping text', () => {
  const warnings = validateSlide([
    { type: 'text', x: 1, y: 1, w: 3, h: 1 },
    { type: 'text', x: 2, y: 1.5, w: 3, h: 1 },
    { type: 'shape', x: 13, y: 7, w: 2, h: 1 }
  ], { width: 13.333, height: 7.5 });
  assert.ok(warnings.some((w) => w.code === 'TEXT_OVERLAP'));
  assert.ok(warnings.some((w) => w.code === 'OUT_OF_BOUNDS'));
});

test('text wrapping inserts explicit line breaks for long CJK content', () => {
  const wrapped = wrapText('这是一个用于测试中文文本自动换行的较长句子', 1.5, 18);
  assert.ok(wrapped.includes('\n'));
  assert.ok(wrapped.split('\n').length > 1);
});

test('font manager safely falls back when no font files are configured', () => {
  const manager = new FontManager();
  assert.equal(manager.measure('中文', 18, 'Missing Font'), null);
  assert.equal(manager.inspect().configuredFaces.length, 0);
});

test('validator detects fixed-height text overflow risk', () => {
  const elements = layoutSlide({
    elements: [{ type: 'text', text: '这是一段很长很长的中文内容，需要自动换行并且高度不足时发出警告。'.repeat(4), x: 1, y: 1, w: 1.4, h: 0.25, fontSize: 18 }]
  }, normalizePageSize('wide'), {});
  const warnings = validateSlide(elements, normalizePageSize('wide'));
  assert.ok(warnings.some((warning) => warning.code === 'TEXT_OVERFLOW_RISK'));
});

test('Chinese punctuation is not stranded at the start of a wrapped line', () => {
  const wrapped = wrapText('第一段，第二段。第三段！', 1.2, 20);
  assert.ok(wrapped.split('\n').every((line) => !/^[，。！？：；、]/u.test(line)));
});

test('component factories return editable PowerPoint elements', () => {
  const styledTitle = components.title('Styled', { italic: true, underline: true, charSpacing: 1.1 });
  assert.equal(styledTitle.italic, true);
  assert.equal(styledTitle.underline, true);
  assert.equal(styledTitle.charSpacing, 1.1);

  const api = require('../native');
  const card = api.components.kpiCard({ label: '营收', value: '¥12.8M', x: 1, y: 1 });
  assert.equal(card[0].type, 'shape');
  assert.ok(card.slice(1).every((element) => element.type === 'text'));
  const cover = api.templates.cover({ title: '年度报告' });
  assert.ok(cover.elements.some((element) => element.type === 'text' && element.text === '年度报告'));
});

test('OOXML font patch adds an explicit East Asian typeface', () => {
  const { patchEastAsianFonts } = require('../native/engine/east_asian_font');
  const source = '<a:rPr lang="en-US"><a:latin typeface="Aptos"/></a:rPr><a:defRPr/>';
  const patched = patchEastAsianFonts(source, 'Microsoft YaHei');
  assert.ok(patched.includes('<a:ea typeface="Microsoft YaHei"/>'));
  assert.equal((patched.match(/<a:ea /g) || []).length, 2);
});

test('deck schema accepts native editable chart data', () => {
  const deck = { slides: [{ elements: [{ type: 'chart', chartType: 'bar', x: 1, y: 1, w: 5, h: 3, data: [{ name: 'Series', labels: ['A', 'B'], values: [1, 2] }] }] }] };
  assert.deepEqual(validateDeck(deck), []);
});

test('process and timeline components compose native shapes, text, and connectors', () => {
  const api = require('../native');
  const flow = api.components.processFlow([{ title: '输入' }, { title: '分析' }, { title: '输出' }]);
  assert.equal(flow.filter((element) => element.type === 'line').length, 2);
  assert.equal(flow.filter((element) => element.type === 'shape').length, 3);
  const timeline = api.components.timeline([{ date: 'Q1', title: '启动' }, { date: 'Q2', title: '交付' }]);
  assert.ok(timeline.some((element) => element.shape === 'ellipse'));
  assert.ok(api.templates.comparison({ left: { title: 'A' }, right: { title: 'B' } }).elements.length > 0);
});

test('East Asian font patch updates an existing typeface rather than duplicating it', () => {
  const { patchEastAsianFonts } = require('../native/engine/east_asian_font');
  const source = '<a:rPr><a:ea typeface="Old Font"/><a:latin typeface="Aptos"/></a:rPr>';
  const patched = patchEastAsianFonts(source, 'New CJK Font');
  assert.equal((patched.match(/<a:ea /g) || []).length, 1);
  assert.ok(patched.includes('typeface="New CJK Font"'));
});

test('deck schema accepts horizontal and vertical native lines', () => {
  assert.deepEqual(validateDeck({ slides: [{ elements: [{ type: 'line', x: 1, y: 1, w: 4, h: 0 }, { type: 'line', x: 1, y: 1, w: 0, h: 2 }] }] }), []);
  assert.ok(validateDeck({ slides: [{ elements: [{ type: 'line', x: 1, y: 1, w: 0, h: 0 }] }] }).length > 0);
});

test('native renderer accepts a valid editable bar chart', async () => {
  const { buildPresentation } = require('../native');
  const result = await buildPresentation({
    slides: [{
      elements: [{
        type: 'chart', chartType: 'bar', x: 1, y: 1, w: 5, h: 3,
        data: [{ name: 'Revenue', labels: ['2024', '2025'], values: [10, 12] }]
      }]
    }]
  });
  assert.equal(result.pptx._slides.length, 1);
});

test('batch CLI parses inputs and limits concurrency', () => {
  const { parseArgs } = require('../batch_native_pptx');
  const options = parseArgs(['--input', 'a.json', '--input-dir', 'decks', '--output-dir', 'out', '--concurrency', '3']);
  assert.deepEqual(options.inputs, ['a.json']);
  assert.equal(options.inputDir, 'decks');
  assert.equal(options.outputDir, 'out');
  assert.equal(options.concurrency, 3);
  assert.throws(() => parseArgs(['--concurrency', '20']));
});

test('shared design system resolves legacy and expanded visual tokens', () => {
  const api = require('../native');
  const theme = api.resolveTheme({
    colors: { primary: '123456', accent: 'E56A42' },
    fonts: { heading: 'Aptos Display', body: 'Arial' },
    sizes: { title: 36 },
    spacing: { lg: 0.42 },
    radii: { medium: 0.18 },
    typography: { titleTracking: 1.2 },
    effects: { softShadow: true }
  });
  assert.equal(theme.colors.primary, '123456');
  assert.equal(theme.colors.background, api.defaultTheme.colors.background);
  assert.equal(theme.fonts.heading, 'Aptos Display');
  assert.equal(theme.sizes.title, 36);
  assert.equal(theme.spacing.lg, 0.42);
  assert.equal(theme.radii.medium, 0.18);
  assert.equal(theme.typography.titleTracking, 1.2);
  assert.equal(theme.effects.softShadow, true);
});

test('native templates propagate custom design tokens into editable elements', () => {
  const api = require('../native');
  const slide = api.templates.cover({
    title: 'Custom theme',
    theme: {
      colors: { background: '101820', primary: 'F2AA4C', accent: '00A6A6', muted: 'CCD6DD' },
      fonts: { heading: 'Arial', body: 'Arial' },
      sizes: { title: 38 }
    }
  });
  assert.equal(slide.background, '101820');
  const title = slide.elements.find((element) => element.type === 'text' && element.text === 'Custom theme');
  assert.equal(title.color, 'F2AA4C');
  assert.equal(title.fontFace, 'Arial');
  assert.equal(title.fontSize, 38);
  const rule = slide.elements.find((element) => element.type === 'line');
  assert.equal(rule.color, '00A6A6');
});

test('native shape styles preserve transparency, rotation, line dash, and shadow options', () => {
  const { shapeStyle } = require('../native/engine/native_pptx');
  const style = shapeStyle({
    x: 1, y: 1, w: 4, h: 2, fill: '123456', fillTransparency: 22,
    lineColor: 'ABCDEF', lineWidth: 1.5, lineTransparency: 35, lineDash: 'dash',
    transparency: 12, rotate: 8,
    shadow: { color: '000000', opacity: 0.24, blur: 6, angle: 90, distance: 3 }
  }, { colors: { surface: 'FFFFFF', border: 'CCCCCC' } });
  assert.equal(style.fill.transparency, 22);
  assert.equal(style.line.transparency, 35);
  assert.equal(style.line.dashType, 'dash');
  assert.equal(style.transparency, 12);
  assert.equal(style.rotate, 8);
  assert.equal(style.shadow.opacity, 0.24);
  assert.equal(style.shadow.blur, 6);
});

test('native shape style keeps backwards-compatible defaults', () => {
  const { shapeStyle } = require('../native/engine/native_pptx');
  const style = shapeStyle({ x: 0, y: 0, w: 1, h: 1, fill: 'FFFFFF' }, { colors: { surface: 'FFFFFF', border: '000000' } });
  assert.equal(style.fill.transparency, 0);
  assert.equal(style.line.width, 0.8);
  assert.equal(style.transparency, 0);
  assert.equal(style.rotate, 0);
  assert.equal(style.shadow, undefined);
});

test('gradient fills serialize editable DrawingML gradient stops and transparency', () => {
  const { gradientFillXml } = require('../native/engine/native_pptx');
  const xml = gradientFillXml({ angle: 135, stops: [
    { position: 0, color: '#112233' },
    { position: 1, color: 'E56A42', transparency: 25 }
  ] });
  assert.ok(xml.includes('<a:gradFill'));
  assert.ok(xml.includes('<a:lin ang="8100000"'));
  assert.ok(xml.includes('<a:gs pos="0">'));
  assert.ok(xml.includes('<a:gs pos="100000">'));
  assert.ok(xml.includes('<a:alpha val="75000"/>'));
  assert.throws(() => gradientFillXml({ stops: [{ position: 0, color: 'FFFFFF' }] }), /at least two/);
});

test('deck schema validates gradient stop definitions', () => {
  assert.deepEqual(validateDeck({ slides: [{ elements: [{ type: 'shape', x: 0, y: 0, w: 4, h: 2, gradient: { angle: 45, stops: [{ position: 0, color: '112233' }, { position: 1, color: '#E56A42' }] } }] }] }), []);
  assert.ok(validateDeck({ slides: [{ elements: [{ type: 'shape', gradient: { stops: [{ position: 1.5, color: 'bad' }] } }] }] }).some((message) => message.includes('gradient')));
});

test('generated PPTX contains editable DrawingML gradient fill', async () => {
  const fs = require('node:fs');
  const os = require('node:os');
  const path = require('node:path');
  const JSZip = require(require.resolve('jszip', { paths: [require.resolve('../native/engine/native_pptx')] }));
  const { generatePptx } = require('../native/engine/native_pptx');
  const output = path.join(os.tmpdir(), 'native-gradient-' + process.pid + '.pptx');
  try {
    await generatePptx({ slides: [{ elements: [
      { type: 'shape', x: 1, y: 1, w: 5, h: 2, fill: 'FFFFFF', gradient: { angle: 90, stops: [{ position: 0, color: '112233' }, { position: 1, color: 'E56A42', transparency: 20 }] } }
    ] }] }, output);
    const zip = await JSZip.loadAsync(require('node:fs').readFileSync(output));
    const xml = await zip.file('ppt/slides/slide1.xml').async('string');
    assert.ok(xml.includes('<a:gradFill'));
    assert.ok(xml.includes('<a:gsLst>'));
    assert.ok(xml.includes('<a:alpha val="80000"/>'));
    assert.ok(!xml.includes('<a:solidFill><a:srgbClr val="FFFFFF"/>'));
  } finally {
    if (fs.existsSync(output)) fs.unlinkSync(output);
  }
});

test('gradient patch keeps text, lines, and multiple shapes aligned in source order', async () => {
  const fs = require('node:fs');
  const os = require('node:os');
  const path = require('node:path');
  const JSZip = require(require.resolve('jszip', { paths: [require.resolve('../native/engine/native_pptx')] }));
  const { generatePptx } = require('../native/engine/native_pptx');
  const output = path.join(os.tmpdir(), 'native-gradient-order-' + process.pid + '.pptx');
  const gradient = (color) => ({ angle: 90, stops: [{ position: 0, color }, { position: 1, color: 'FFFFFF' }] });
  try {
    await generatePptx({ slides: [{ elements: [
      { type: 'text', text: 'before', x: 0.5, y: 0.5, w: 2, h: 0.4 },
      { type: 'line', x: 0.5, y: 1.2, w: 2, h: 0 },
      { type: 'shape', x: 0.5, y: 1.5, w: 2, h: 1, fill: '112233', gradient: gradient('112233') },
      { type: 'text', text: 'between', x: 0.5, y: 2.7, w: 2, h: 0.4 },
      { type: 'shape', x: 3, y: 1.5, w: 2, h: 1, fill: '445566', gradient: gradient('445566') }
    ] }] }, output);
    const zip = await JSZip.loadAsync(require('node:fs').readFileSync(output));
    const xml = await zip.file('ppt/slides/slide1.xml').async('string');
    assert.equal((xml.match(/<a:gradFill/g) || []).length, 2);
    assert.ok(xml.includes('<a:srgbClr val="112233">'));
    assert.ok(xml.includes('<a:srgbClr val="445566">'));
  } finally {
    if (fs.existsSync(output)) fs.unlinkSync(output);
  }
});

test('hero and editorial templates preserve asymmetric and editorial layout patterns', () => {
  const api = require('../native');
  const hero = api.templates.hero({ title: 'Launch', theme: {
    colors: { background: '101820', primary: 'F2AA4C', accent: '00A6A6', surface: '1B2836' },
    backgrounds: { gradient: { angle: 135, stops: [{ position: 0, color: '112233' }, { position: 1, color: '445566' }] } },
    effects: { shadow: { color: '000000', opacity: 0.2, blur: 5, angle: 45, distance: 2 } }
  } });
  const heroGradient = hero.elements.find((element) => element.type === 'shape' && element.gradient);
  assert.ok(heroGradient);
  assert.ok(heroGradient.x > 7.5);
  assert.ok(hero.elements.some((element) => element.type === 'text' && element.text === 'Launch'));
  const editorial = api.templates.editorial({ title: 'Insight' });
  assert.equal(editorial.elements.filter((element) => element.type === 'shape').length, 3);
  assert.ok(editorial.elements.some((element) => element.type === 'text' && element.text === '观点与背景'));
});

test('deck schema rejects invalid native shape effects before serialization', () => {
  const invalid = { slides: [{ elements: [
    { type: 'shape', x: 0, y: 0, w: 2, h: 1, fill: 'not-a-color', transparency: 140 },
    { type: 'shape', x: 3, y: 0, w: 2, h: 1, shadow: { opacity: 1.4, blur: -2, color: 'bad' } },
    { type: 'shape', x: 6, y: 0, w: 2, h: 1, rotate: NaN },
    { type: 'shape', x: 9, y: 0, w: 2, h: 1, radius: -1 }
  ] }] };
  const errors = validateDeck(invalid);
  assert.ok(errors.some((message) => message.includes('fill must be a six-digit')));
  assert.ok(errors.some((message) => message.includes('transparency must be between 0 and 100')));
  assert.ok(errors.some((message) => message.includes('shadow.opacity')));
  assert.ok(errors.some((message) => message.includes('shadow.blur')));
  assert.ok(errors.some((message) => message.includes('rotate must be finite')));
  assert.ok(errors.some((message) => message.includes('radius must be finite and non-negative')));
});

test('deck schema validates text and line transparency and typography', () => {
  const errors = validateDeck({ slides: [{ elements: [
    { type: 'text', text: 'bad', x: 0, y: 0, w: 2, h: 1, fontSize: 0, transparency: 110 },
    { type: 'line', x: 0, y: 2, w: 2, h: 0, transparency: -1 },
    { type: 'shape', x: 0, y: 3, w: 2, h: 1, shadow: { type: 'invalid' } }
  ] }] });
  assert.ok(errors.some((message) => message.includes('fontSize')));
  assert.ok(errors.filter((message) => message.includes('transparency')).length >= 2);
  assert.ok(errors.some((message) => message.includes('shadow.type')));
});

test('native radius tokens serialize as editable rounded-rectangle geometry', async () => {
  const fs = require('node:fs');
  const os = require('node:os');
  const path = require('node:path');
  const JSZip = require(require.resolve('jszip', { paths: [require.resolve('../native/engine/native_pptx')] }));
  const { generatePptx } = require('../native/engine/native_pptx');
  const output = path.join(os.tmpdir(), 'native-rounded-rect-' + process.pid + '.pptx');
  try {
    await generatePptx({ slides: [{ elements: [
      { type: 'shape', x: 1, y: 1, w: 4, h: 2, fill: 'FFFFFF', radius: 0.16 }
    ] }] }, output);
    const zip = await JSZip.loadAsync(require('node:fs').readFileSync(output));
    const xml = await zip.file('ppt/slides/slide1.xml').async('string');
    assert.ok(xml.includes('<a:prstGeom prst="roundRect">'));
  } finally {
    if (fs.existsSync(output)) fs.unlinkSync(output);
  }
});

test('native text styling preserves italic underline strike and character spacing', async () => {
  const fs = require('node:fs');
  const os = require('node:os');
  const path = require('node:path');
  const JSZip = require(require.resolve('jszip', { paths: [require.resolve('../native/engine/native_pptx')] }));
  const { generatePptx } = require('../native/engine/native_pptx');
  const output = path.join(os.tmpdir(), 'native-text-style-' + process.pid + '.pptx');
  try {
    await generatePptx({ slides: [{ elements: [
      { type: 'text', text: 'Styled text', x: 1, y: 1, w: 4, h: 1, bold: true, italic: true,
        underline: true, strike: true, charSpacing: 1.2, paraSpaceAfterPt: 4, lineSpacingMultiple: 1.1 }
    ] }] }, output);
    const zip = await JSZip.loadAsync(require('node:fs').readFileSync(output));
    const xml = await zip.file('ppt/slides/slide1.xml').async('string');
    assert.match(xml, /\bi="1"/);
    assert.match(xml, /\bu="sng"/);
    assert.match(xml, /strike="sngStrike"/);
    assert.match(xml, /spc="120"/);
  } finally {
    if (fs.existsSync(output)) fs.unlinkSync(output);
  }
});

test('typography tokens control title and body weights in editable text components', () => {
  const api = require('../native');
  const theme = {
    typography: { titleWeight: '500', headingWeight: '700', bodyWeight: 'normal' },
    fonts: { heading: 'Aptos Display', body: 'Aptos' }
  };
  const title = api.components.title('Title', { theme });
  const paragraph = api.components.paragraph('Body', { theme });
  assert.equal(title.bold, false);
  assert.equal(title.role, 'title');
  assert.equal(paragraph.bold, false);
  const { isBoldWeight } = require('../native/engine/native_pptx');
  assert.equal(isBoldWeight('600'), true);
  assert.equal(isBoldWeight('400'), false);
  assert.equal(isBoldWeight('semibold'), false);
});

test('raw title and body elements inherit shared theme font weights', async () => {
  const { buildPresentation } = require('../native');
  const result = await buildPresentation({
    theme: { typography: { titleWeight: '400', bodyWeight: '700' } },
    slides: [{ elements: [
      { type: 'text', role: 'title', text: 'Title', x: 1, y: 1, w: 4, h: 1 },
      { type: 'text', role: 'body', text: 'Body', x: 1, y: 2, w: 4, h: 1 }
    ] }]
  });
  const shapes = result.pptx._slides[0]._slideObjects.filter((object) => object._type === 'text');
  assert.equal(shapes[0].options.bold, false);
  assert.equal(shapes[1].options.bold, true);
});

test('deck schema validates image opacity, exclusive sources, and rich-text run options', () => {
  const errors = validateDeck({ slides: [{ elements: [
    { type: 'image', path: 'photo.png', data: 'data:image/png;base64,AA==', x: 0, y: 0, w: 2, h: 2, transparency: 120 },
    { type: 'text', text: [{ text: 'bad', options: { fontSize: 0, transparency: -1 } }], x: 0, y: 3, w: 2, h: 1 },
    { type: 'line', x: 0, y: 5, w: 2, h: 0, width: 0 }
  ] }] });
  assert.ok(errors.some((message) => message.includes('either path or data')));
  assert.ok(errors.some((message) => message.includes('.transparency must be between 0 and 100')));
  assert.ok(errors.some((message) => message.includes('options.fontSize')));
  assert.ok(errors.some((message) => message.includes('options.transparency')));
  assert.ok(errors.some((message) => message.includes('width must be finite')));
});

test('layout measures title and heading text with role-specific typography tokens', () => {
  const { layoutSlide } = require('../native/engine/layout');
  const { resolveTheme } = require('../native/themes/design_system');
  const theme = resolveTheme({
    sizes: { title: 40, heading: 28, body: 14 },
    fonts: { heading: 'Display Face', body: 'Body Face' },
    typography: { lineSpacingMultiple: 1.35 }
  });
  const result = layoutSlide({ elements: [
    { type: 'text', role: 'title', text: 'A title without explicit font size', x: 1, y: 1, w: 5 },
    { type: 'text', role: 'heading', text: 'A heading', x: 1, y: 2, w: 5 },
    { type: 'text', role: 'body', text: 'Body copy', x: 1, y: 3, w: 5 }
  ] }, { width: 13.333, height: 7.5 }, theme);
  assert.ok(result[0]._requiredTextHeight > result[1]._requiredTextHeight);
  assert.ok(result[1]._requiredTextHeight > result[2]._requiredTextHeight);
  assert.ok(result.every((element) => element.h > 0));
});

test('native text boxes inherit shared theme line spacing when not overridden', async () => {
  const { buildPresentation } = require('../native');
  const result = await buildPresentation({
    theme: { typography: { lineSpacingMultiple: 1.42 } },
    slides: [{ elements: [
      { type: 'text', text: 'Theme line spacing', x: 1, y: 1, w: 5, h: 1 }
    ] }]
  });
  const textObject = result.pptx._slides[0]._slideObjects.find((object) => object._type === 'text');
  // CSS `line-height` is a multiple of the font size, so the writer turns it into exact
  // points: DrawingML `spcPct` is a percentage of the font's own line box instead.
  assert.ok(!textObject.options.lineSpacingMultiple, 'the percentage form is not used');
  assert.equal(textObject.options.lineSpacing,
    Number((1.42 * textObject.options.fontSize).toFixed(2)));
});

test('shape-level transparency maps to editable fill transparency', () => {
  const { shapeStyle } = require('../native/engine/native_pptx');
  const theme = require('../native/themes/default');
  const inherited = shapeStyle({ x: 0, y: 0, w: 1, h: 1, fill: '123456', transparency: 35 }, theme);
  const explicit = shapeStyle({ x: 0, y: 0, w: 1, h: 1, fill: '123456', transparency: 35, fillTransparency: 12 }, theme);
  assert.equal(inherited.fill.transparency, 35);
  assert.equal(explicit.fill.transparency, 12);
});

test('rich text runs inherit the enclosing title font face', async () => {
  const { buildPresentation } = require('../native');
  const result = await buildPresentation({
    theme: { fonts: { heading: 'Display Face', body: 'Body Face' } },
    slides: [{ elements: [
      { type: 'text', role: 'title', text: [{ text: 'Styled' }, { text: ' title', options: { bold: true } }],
        x: 1, y: 1, w: 5, h: 1 }
    ] }]
  });
  const textObject = result.pptx._slides[0]._slideObjects.find((object) => object._type === 'text');
  assert.equal(textObject.options.fontFace, 'Display Face');
  assert.equal(textObject.text[0].options.fontFace, 'Display Face');
  assert.equal(textObject.text[1].options.fontFace, 'Display Face');
});

test('gradient fill combines stop alpha with shape-level transparency', () => {
  const { gradientFillXml } = require('../native/engine/native_pptx');
  const xml = gradientFillXml({
    angle: 90,
    stops: [
      { position: 0, color: '112233', transparency: 20 },
      { position: 1, color: '445566', transparency: 0 }
    ]
  }, 50);
  assert.match(xml, /<a:alpha val="40000"\/>/);
  assert.match(xml, /<a:alpha val="50000"\/>/);
  assert.throws(() => gradientFillXml({ stops: [{ position: 0, color: '112233' }, { position: 1, color: '445566' }] }, 101), /base transparency/);
});


// ---------------------------------------------------------------------------
// Image fit, crop, and picture effect support
// ---------------------------------------------------------------------------

const os = require('node:os');
const fsSync = require('node:fs');
const pathSync = require('node:path');
const { makePng, writePngFixture } = require('./helpers/png');
const imageFit = require('../native/engine/image_fit');

async function withTempDir(prefix, run) {
  const directory = fsSync.mkdtempSync(pathSync.join(os.tmpdir(), prefix));
  try {
    return await run(directory);
  } finally {
    fsSync.rmSync(directory, { recursive: true, force: true });
  }
}

function readSlideXml(pptxPath, slideNumber = 1) {
  const JSZip = require(require.resolve('jszip', { paths: [require.resolve('../native/engine/native_pptx')] }));
  return JSZip.loadAsync(fsSync.readFileSync(pptxPath))
    .then((zip) => zip.file('ppt/slides/slide' + slideNumber + '.xml').async('string'));
}

test('PNG fixture helper emits an image-size readable file', async () => {
  await withTempDir('native-png-', (directory) => {
    const file = writePngFixture(directory, 'fixture.png', 400, 300);
    assert.deepEqual(imageFit.readImageSize({ type: 'image', path: file }), { width: 400, height: 300 });
    assert.ok(makePng(16, 9).length > 40);
  });
});

test('cover crops the overflow symmetrically around the centre focus', () => {
  const result = imageFit.resolveImageGeometry({
    type: 'image', path: 'unused.png', x: 0, y: 0, w: 4, h: 2, fit: 'cover',
    naturalSize: { width: 400, height: 300 }
  });
  assert.equal(result.fit, 'cover');
  assert.deepEqual(result.box, { x: 0, y: 0, w: 4, h: 2 });
  assert.ok(Math.abs(result.srcRect.top - 1 / 6) < 1e-9);
  assert.ok(Math.abs(result.srcRect.bottom - 1 / 6) < 1e-9);
  assert.equal(result.srcRect.left, 0);
  assert.equal(result.srcRect.right, 0);
  assert.equal(imageFit.srcRectAttributes(result.srcRect), 'l="0" t="16667" r="0" b="16667"');
});

test('cover honours focal presets and zoom without distorting the aspect ratio', () => {
  const top = imageFit.resolveImageGeometry({
    type: 'image', path: 'unused.png', x: 0, y: 0, w: 4, h: 2, fit: 'cover', focus: 'top',
    naturalSize: { width: 400, height: 300 }
  });
  assert.equal(top.srcRect.top, 0);
  assert.ok(Math.abs(top.srcRect.bottom - 1 / 3) < 1e-9);

  const zoomed = imageFit.resolveImageGeometry({
    type: 'image', path: 'unused.png', x: 0, y: 0, w: 4, h: 2, fit: 'cover', zoom: 2, focus: { x: 0.5, y: 0.5 },
    naturalSize: { width: 400, height: 300 }
  });
  assert.ok(Math.abs(zoomed.srcRect.left - 0.25) < 1e-9);
  assert.ok(Math.abs(zoomed.srcRect.top - 1 / 3) < 1e-9);

  // A 2x zoom must cut the visible source area to a quarter while keeping the box aspect ratio.
  const visibleW = 1 - zoomed.srcRect.left - zoomed.srcRect.right;
  const visibleH = 1 - zoomed.srcRect.top - zoomed.srcRect.bottom;
  assert.ok(Math.abs(visibleW - 0.5) < 1e-9);
  assert.ok(Math.abs(visibleH - 1 / 3) < 1e-9);
  assert.ok(Math.abs((visibleW * 400) / (visibleH * 300) - 4 / 2) < 1e-9);
});

test('contain shrinks the drawn box to the native aspect ratio inside the slot', () => {
  const result = imageFit.resolveImageGeometry({
    type: 'image', path: 'unused.png', x: 1, y: 1, w: 4, h: 4, fit: 'contain',
    naturalSize: { width: 400, height: 300 }
  });
  assert.equal(result.srcRect, null);
  assert.ok(Math.abs(result.box.x - 1) < 1e-9);
  assert.ok(Math.abs(result.box.y - 1.5) < 1e-9);
  assert.ok(Math.abs(result.box.w - 4) < 1e-9);
  assert.ok(Math.abs(result.box.h - 3) < 1e-9);
});

test('explicit crop fractions map onto the source rectangle', () => {
  const result = imageFit.resolveImageGeometry({
    type: 'image', path: 'unused.png', x: 0, y: 0, w: 3, h: 3, fit: 'crop',
    crop: { left: 0.25, right: 0, top: 0, bottom: 0.1 }
  });
  assert.equal(imageFit.srcRectAttributes(result.srcRect), 'l="25000" t="0" r="0" b="10000"');
  assert.throws(() => imageFit.resolveImageGeometry({
    type: 'image', path: 'unused.png', x: 0, y: 0, w: 3, h: 3, fit: 'crop', crop: { left: 0.7, right: 0.4 }
  }), /less than 1/);
});

test('image fit resolves a natural size from data URIs, and degrades when it cannot', () => {
  const dataUri = 'data:image/png;base64,' + makePng(120, 60).toString('base64');
  assert.deepEqual(imageFit.readImageSize({ type: 'image', data: dataUri }), { width: 120, height: 60 });
  // A fit that keeps proportions needs the source size. When it is unknown - a picture the
  // analyzer already named, or a data URI it could not decode - the geometry used to throw and
  // take the whole conversion with it. It now degrades to a stretch and says which fit it lost.
  const degraded = imageFit.resolveImageGeometry({
    type: 'image', path: 'does-not-exist.png', x: 0, y: 0, w: 2, h: 2, fit: 'cover'
  });
  assert.equal(degraded.fit, 'stretch', 'the box is filled, not abandoned');
  assert.equal(degraded.fitFallback, 'cover', 'and the lost fit is named on the geometry');
  assert.equal(degraded.srcRect, null);
});

test('schema rejects invalid image fit, focus, zoom, and picture effect tokens', () => {
  const errors = validateDeck({ slides: [{ elements: [
    { type: 'image', path: 'a.png', x: 0, y: 0, w: 2, h: 2, fit: 'zoomify' },
    { type: 'image', path: 'b.png', x: 0, y: 3, w: 2, h: 2, fit: 'crop' },
    { type: 'image', path: 'c.png', x: 0, y: 5, w: 2, h: 2, fit: 'cover', focus: 'middle-ish' },
    { type: 'image', path: 'd.png', x: 0, y: 7, w: 2, h: 2, fit: 'cover', zoom: 0.5 },
    { type: 'image', path: 'e.png', x: 3, y: 0, w: 2, h: 2, radius: -1, lineColor: 'nope' },
    { type: 'image', path: 'f.png', x: 3, y: 3, w: 2, h: 2, crop: { left: 0.2 } },
    { type: 'image', path: 'g.png', x: 3, y: 5, w: 2, h: 2, fit: 'crop', crop: { left: 0.6, right: 0.5 } },
    { type: 'image', path: 'h.png', x: 3, y: 7, w: 2, h: 2, naturalSize: { width: 0, height: 10 } }
  ] }] });
  assert.ok(errors.some((message) => message.includes('.fit must be one of')));
  assert.ok(errors.some((message) => message.includes('.crop is required when fit is crop')));
  assert.ok(errors.some((message) => message.includes('.focus is not a known focal preset')));
  assert.ok(errors.some((message) => message.includes('.zoom must be a finite number')));
  assert.ok(errors.some((message) => message.includes('.radius must be finite and non-negative')));
  assert.ok(errors.some((message) => message.includes('.lineColor must be a six-digit hex color')));
  assert.ok(errors.some((message) => message.includes('.crop requires fit: "crop"')));
  assert.ok(errors.some((message) => message.includes('.crop left + right must be less than 1')));
  assert.ok(errors.some((message) => message.includes('.naturalSize requires positive finite width and height')));
});

test('schema accepts a fully specified picture element', () => {
  assert.deepEqual(validateDeck({ slides: [{ elements: [{
    type: 'image', path: 'a.png', x: 0, y: 0, w: 4, h: 3,
    fit: 'cover', focus: { x: 0.4, y: 0.2 }, zoom: 1.4, transparency: 12,
    radius: 0.18, lineColor: 'DCE2DE', lineWidth: 1, lineTransparency: 20, lineDash: 'dash',
    shadow: { type: 'outer', color: '000000', opacity: 0.2, blur: 6, angle: 45, distance: 3 },
    flipH: true, flipV: false, altText: '图表示意', naturalSize: { width: 400, height: 300 }
  }] }] }), []);
});

test('generated PPTX stores cover cropping as editable a:srcRect on a picture frame', async () => {
  await withTempDir('native-cover-', async (directory) => {
    const image = writePngFixture(directory, 'cover.png', 400, 300);
    const output = pathSync.join(directory, 'cover.pptx');
    const { generatePptx } = require('../native/engine/native_pptx');
    await generatePptx({ slides: [{ elements: [
      { type: 'image', path: image, x: 1, y: 1, w: 4, h: 2, fit: 'cover'
      }
    ] }] }, output);
    const xml = await readSlideXml(output);
    assert.equal((xml.match(/<p:pic>/gu) || []).length, 1);
    assert.ok(xml.includes('<a:srcRect l="0" t="16667" r="0" b="16667"/>'));
    assert.ok(xml.includes('<a:stretch><a:fillRect/></a:stretch>'));
    // The picture frame keeps the requested 4x2 inch slot; it is not promoted to a full-slide raster.
    assert.ok(xml.includes('<a:ext cx="3657600" cy="1828800"/>'));
  });
});

test('generated PPTX keeps contain sizing native with no crop rectangle', async () => {
  await withTempDir('native-contain-', async (directory) => {
    const image = writePngFixture(directory, 'contain.png', 400, 300);
    const output = pathSync.join(directory, 'contain.pptx');
    const { generatePptx } = require('../native/engine/native_pptx');
    await generatePptx({ slides: [{ elements: [
      { type: 'image', path: image, x: 1, y: 1, w: 4, h: 4, fit: 'contain' }
    ] }] }, output);
    const xml = await readSlideXml(output);
    assert.ok(!xml.includes('<a:srcRect'));
    // 4 x 3 inches at 914400 EMU/inch.
    assert.ok(xml.includes('<a:ext cx="3657600" cy="2743200"/>'));
  });
});

test('generated PPTX serializes rounded corners, outline, and shadow on a picture', async () => {
  await withTempDir('native-pic-effect-', async (directory) => {
    const image = writePngFixture(directory, 'effect.png', 200, 200);
    const output = pathSync.join(directory, 'effect.pptx');
    const { generatePptx } = require('../native/engine/native_pptx');
    await generatePptx({ slides: [{ elements: [
      { type: 'image', path: image, x: 1, y: 1, w: 3, h: 3, radius: 0.3,
        lineColor: 'DCE2DE', lineWidth: 1.5, lineTransparency: 25, lineDash: 'dash',
        shadow: { type: 'outer', color: '000000', opacity: 0.25, blur: 8, angle: 90, distance: 4 },
        transparency: 15, altText: '带描边的图片' }
    ] }] }, output);
    const xml = await readSlideXml(output);
    assert.match(xml, /<a:prstGeom prst="roundRect"><a:avLst><a:gd name="adj" fmla="val 10000"\/><\/a:avLst><\/a:prstGeom>/);
    assert.match(xml, /<a:ln w="19050"/);
    assert.match(xml, /<a:prstDash val="dash"\/>/);
    assert.match(xml, /<a:alpha val="75000"\/>/);
    assert.match(xml, /<a:outerShdw[^>]*blurRad="101600"[^>]*dist="50800"[^>]*dir="5400000"/);
    assert.match(xml, /<a:alphaModFix amt="85000"\/>/);
    assert.ok(xml.includes('带描边的图片'));
  });
});

test('plain stretched images require no post-serialization patch', async () => {
  const { buildPresentation } = require('../native');
  await withTempDir('native-plain-', async (directory) => {
    const image = writePngFixture(directory, 'plain.png', 64, 48);
    const result = await buildPresentation({ slides: [{ elements: [
      { type: 'image', path: image, x: 1, y: 1, w: 2, h: 2 }
    ] }] });
    assert.deepEqual(result.imagePlans, [[null]]);
  });
});

test('image patch rejects a plan/element misalignment instead of patching the wrong picture', () => {
  const { applyImagePlan } = require('../native/engine/native_pptx');
  const pic = '<p:pic><p:blipFill><a:blip r:embed="rId2"/><a:stretch><a:fillRect/></a:stretch></p:blipFill>' +
    '<p:spPr><a:xfrm/><a:prstGeom prst="rect"><a:avLst/></a:prstGeom></p:spPr></p:pic>';
  const patched = applyImagePlan(pic, { srcRect: { left: 0.1, top: 0, right: 0, bottom: 0 } });
  assert.ok(patched.includes('<a:srcRect l="10000" t="0" r="0" b="0"/>'));
  // Idempotent: re-applying replaces rather than duplicating the rectangle.
  const twice = applyImagePlan(patched, { srcRect: { left: 0.2, top: 0, right: 0, bottom: 0 } });
  assert.equal((twice.match(/<a:srcRect /gu) || []).length, 1);
  assert.ok(twice.includes('l="20000"'));
});

test('image patch raises when the picture blip fill is missing', () => {
  const { applyImagePlan } = require('../native/engine/native_pptx');
  assert.throws(() => applyImagePlan('<p:pic><p:blipFill></p:blipFill></p:pic>',
    { srcRect: { left: 0, top: 0, right: 0, bottom: 0 } }), /blip fill/);
});


// ---------------------------------------------------------------------------
// Declarative container layout
// ---------------------------------------------------------------------------

const { layoutContainer, flattenElements } = require('../native/engine/layout');

test('column containers stack children with padding and gap', () => {
  const { elements, height } = layoutContainer({
    type: 'container', x: 1, y: 1, w: 4, padding: 0.2, gap: 0.1,
    children: [{ type: 'shape', h: 1, fill: 'FFFFFF' }, { type: 'shape', h: 2, fill: 'FFFFFF' }]
  }, { x: 1, y: 1, w: 4 }, {});
  assert.equal(elements.length, 2);
  assert.ok(Math.abs(elements[0].x - 1.2) < 1e-9);
  assert.ok(Math.abs(elements[0].y - 1.2) < 1e-9);
  assert.ok(Math.abs(elements[0].w - 3.6) < 1e-9);
  assert.ok(Math.abs(elements[1].y - 2.3) < 1e-9);
  assert.ok(Math.abs(height - 3.5) < 1e-9);
});

test('row containers share the remaining width between unconstrained children', () => {
  const { elements, height } = layoutContainer({
    type: 'container', x: 0, y: 0, w: 6, direction: 'row', gap: 0.5,
    children: [{ type: 'shape', h: 1, fill: 'FFFFFF' }, { type: 'shape', h: 2, fill: 'FFFFFF' }]
  }, { x: 0, y: 0, w: 6 }, {});
  assert.ok(Math.abs(elements[0].w - 2.75) < 1e-9);
  assert.ok(Math.abs(elements[1].w - 2.75) < 1e-9);
  assert.ok(Math.abs(elements[1].x - 3.25) < 1e-9);
  // default cross-axis alignment stretches both children to the tallest row.
  assert.ok(Math.abs(elements[0].h - 2) < 1e-9);
  assert.ok(Math.abs(height - 2) < 1e-9);
});

test('row containers honour flex weights and explicit widths', () => {
  const { elements } = layoutContainer({
    type: 'container', x: 0, y: 0, w: 6, direction: 'row', gap: 0,
    children: [
      { type: 'shape', w: 1, h: 1, fill: 'FFFFFF' },
      { type: 'shape', flex: 2, h: 1, fill: 'FFFFFF' },
      { type: 'shape', flex: 1, h: 1, fill: 'FFFFFF' }
    ]
  }, { x: 0, y: 0, w: 6 }, {});
  assert.ok(Math.abs(elements[0].w - 1) < 1e-9);
  assert.ok(Math.abs(elements[1].w - 10 / 3) < 1e-9);
  assert.ok(Math.abs(elements[2].w - 5 / 3) < 1e-9);
});

test('grid containers wrap children into equal columns with row heights', () => {
  const { elements, height } = layoutContainer({
    type: 'container', x: 0, y: 0, w: 6.2, columns: 3, gap: 0.1,
    children: [
      { type: 'shape', h: 1, fill: 'FFFFFF' }, { type: 'shape', h: 1.5, fill: 'FFFFFF' },
      { type: 'shape', h: 1, fill: 'FFFFFF' }, { type: 'shape', h: 1, fill: 'FFFFFF' }
    ]
  }, { x: 0, y: 0, w: 6.2 }, {});
  assert.equal(elements.length, 4);
  assert.ok(Math.abs(elements[0].w - 2) < 1e-9);
  assert.ok(Math.abs(elements[1].x - 2.1) < 1e-9);
  assert.ok(Math.abs(elements[2].x - 4.2) < 1e-9);
  // the second row starts below the tallest cell of the first row
  assert.ok(Math.abs(elements[3].y - 1.6) < 1e-9);
  // Four children in three columns means one wrapped row: 1.5 + 0.1 + 1.
  assert.ok(Math.abs(height - 2.6) < 1e-9);
});

test('containers centre or right-align narrower children', () => {
  const centred = layoutContainer({
    type: 'container', x: 0, y: 0, w: 6, align: 'center',
    children: [{ type: 'shape', w: 2, h: 1, fill: 'FFFFFF' }]
  }, { x: 0, y: 0, w: 6 }, {});
  assert.ok(Math.abs(centred.elements[0].x - 2) < 1e-9);
  const right = layoutContainer({
    type: 'container', x: 0, y: 0, w: 6, align: 'end',
    children: [{ type: 'shape', w: 2, h: 1, fill: 'FFFFFF' }]
  }, { x: 0, y: 0, w: 6 }, {});
  assert.ok(Math.abs(right.elements[0].x - 4) < 1e-9);
});

test('justify distributes free vertical space inside a fixed-height container', () => {
  const { elements } = layoutContainer({
    type: 'container', x: 0, y: 0, w: 4, h: 5, justify: 'space-between',
    children: [{ type: 'shape', h: 1, fill: 'FFFFFF' }, { type: 'shape', h: 1, fill: 'FFFFFF' }]
  }, { x: 0, y: 0, w: 4, h: 5 }, {});
  assert.ok(Math.abs(elements[0].y - 0) < 1e-9);
  assert.ok(Math.abs(elements[1].y - 4) < 1e-9);
});

test('nested containers resolve recursively into flat editable geometry', () => {
  const flattenSpec = {
    type: 'container', x: 0, y: 0, w: 6, direction: 'row', gap: 0.5,
    children: [
      { type: 'container', direction: 'column', gap: 0.2, padding: 0.1,
        children: [{ type: 'shape', h: 1, fill: 'FFFFFF' }, { type: 'shape', h: 1, fill: 'FFFFFF' }] },
      { type: 'shape', h: 2, fill: 'FFFFFF' }
    ]
  };
  const { elements } = layoutContainer(flattenSpec, { x: 0, y: 0, w: 6 }, {});
  assert.equal(elements.length, 3);
  assert.ok(Math.abs(elements[0].x - 0.1) < 1e-9);
  assert.ok(Math.abs(elements[0].y - 0.1) < 1e-9);
  assert.ok(Math.abs(elements[1].y - 1.3) < 1e-9);
  assert.equal(flattenElements([flattenSpec]).length, 3);
  assert.ok(flattenElements([flattenSpec]).every((element) => element.type !== 'container'));
});

test('container height grows to fit measured text', () => {
  const { elements, height } = layoutContainer({
    type: 'container', x: 0, y: 0, w: 2, padding: 0.1,
    children: [{ type: 'text', text: '很长的中文段落需要在窄容器内自动换行并撑开容器高度。'.repeat(3), fontSize: 16 }]
  }, { x: 0, y: 0, w: 2 }, {});
  assert.ok(height > 0.5);
  assert.ok(elements[0]._requiredTextHeight > 0.5);
  assert.ok(Math.abs(height - (elements[0].h + 0.2)) < 1e-9);
});

test('layoutSlide flattens containers and advances the cursor past them', () => {
  const elements = layoutSlide({
    elements: [
      { type: 'text', text: '标题', x: 0.5, y: 0.4, w: 5, h: 0.6 },
      { type: 'container', w: 5, gap: 0.2, children: [
        { type: 'shape', h: 1, fill: 'FFFFFF' },
        { type: 'shape', h: 1, fill: 'FFFFFF' }
      ] },
      { type: 'text', text: '尾部' }
    ]
  }, normalizePageSize('wide'), {});
  assert.equal(elements.length, 4);
  assert.ok(elements.every((element) => element.type !== 'container'));
  const tail = elements[3];
  // The default page margin is 0.58in and the container occupies 2.2in from there.
  assert.ok(tail.y >= 0.58 + 2.2, 'trailing flow element must clear the container');
});

test('schema validates container options and children recursively', () => {
  const errors = validateDeck({ slides: [{ elements: [
    { type: 'container', direction: 'diagonal', columns: 0, gap: -1, align: 'middle', justify: 'evenly',
      padding: { top: -1 }, children: [{ type: 'shape', h: 1, fill: 'not-a-color' }, { type: 'bogus' }] }
  ] }] });
  assert.ok(errors.some((message) => message.includes('.direction must be row or column')));
  assert.ok(errors.some((message) => message.includes('.columns must be a positive integer')));
  assert.ok(errors.some((message) => message.includes('.gap must be finite and non-negative')));
  assert.ok(errors.some((message) => message.includes('.align must be one of')));
  assert.ok(errors.some((message) => message.includes('.justify must be one of')));
  assert.ok(errors.some((message) => message.includes('.padding.top must be finite and non-negative')));
  assert.ok(errors.some((message) => message.includes('.children[0].fill must be a six-digit hex color')));
  assert.ok(errors.some((message) => message.includes('.children[1].type must be one of')));
  assert.deepEqual(validateDeck({ slides: [{ elements: [
    { type: 'container', w: 4, direction: 'row', gap: 0.2, padding: 0.1, align: 'center', justify: 'space-between',
      children: [{ type: 'shape', h: 1, fill: 'FFFFFF' }] }
  ] }] }), []);
});

test('gradient patch stays aligned when effects live inside containers', async () => {
  await withTempDir('native-container-gradient-', async (directory) => {
    const output = pathSync.join(directory, 'container-gradient.pptx');
    const gradient = (color) => ({ angle: 90, stops: [{ position: 0, color }, { position: 1, color: 'FFFFFF' }] });
    const { generatePptx } = require('../native/engine/native_pptx');
    await generatePptx({ slides: [{ elements: [
      { type: 'text', text: 'before', x: 0.5, y: 0.4, w: 3, h: 0.4 },
      { type: 'container', x: 0.5, y: 1, w: 5, direction: 'row', gap: 0.2, children: [
        { type: 'shape', h: 1, fill: '112233', gradient: gradient('112233') },
        { type: 'shape', h: 1, fill: '445566', gradient: gradient('445566') }
      ] },
      { type: 'text', text: 'after', x: 0.5, y: 5, w: 3, h: 0.4 }
    ] }] }, output);
    const xml = await readSlideXml(output);
    assert.equal((xml.match(/<a:gradFill/gu) || []).length, 2);
    assert.ok(xml.includes('<a:srgbClr val="112233">'));
    assert.ok(xml.includes('<a:srgbClr val="445566">'));
    assert.equal((xml.match(/<p:sp>/gu) || []).length, 4);
  });
});

test('container backgrounds render as editable card surfaces behind their children', async () => {
  await withTempDir('native-card-', async (directory) => {
    const output = pathSync.join(directory, 'card.pptx');
    const { generatePptx } = require('../native/engine/native_pptx');
    await generatePptx({ slides: [{ elements: [
      { type: 'container', x: 1, y: 1, w: 4, gap: 0.2, padding: 0.3,
        background: { fill: 'FFFFFF', radius: 0.18, lineColor: 'DCE2DE', lineWidth: 0.75, shadow: { opacity: 0.2, blur: 8 } },
        children: [
          { type: 'text', text: '卡片标题', fontSize: 20, bold: true },
          { type: 'text', text: '卡片正文内容', fontSize: 13 }
        ] }
    ] }] }, output);
    const xml = await readSlideXml(output);
    assert.equal((xml.match(/<p:sp>/gu) || []).length, 3);
    // The card surface must be emitted first so it sits behind the two texts.
    const firstShape = xml.match(/<p:sp>[\s\S]*?<\/p:sp>/u)[0];
    assert.ok(firstShape.includes('<a:prstGeom prst="roundRect">'));
    assert.ok(!firstShape.includes('<a:t>'), 'the card surface must not carry text');
    assert.match(xml, /<a:outerShdw/);
  });
});

test('rich-text height uses the largest declared run size', () => {
  const { estimateRichTextHeight } = require('../native/engine/text_measure');
  const small = estimateRichTextHeight([{ text: '小字内容' }], 4, 12);
  const large = estimateRichTextHeight([{ text: '大字内容', options: { fontSize: 32 } }], 4, 12);
  assert.ok(large > small);
  const multiline = estimateRichTextHeight([{ text: 'a\nb\nc' }], 4, 12);
  assert.ok(multiline > small);
});

test('native CJK wrapping fills each line instead of breaking at a spacerless run', () => {
  const { wrapText } = require('../native/engine/text_measure');
  const paragraph = '这段内容由 DOM 分析、布局求解与样式映射自动转换而来，标题、正文、卡片、图片、表格仍然全部可编辑。';
  const lines = wrapText(paragraph, 6.46, 13.5).split('\n');
  assert.equal(lines.length, 2, 'expected two filled lines, got: ' + JSON.stringify(lines));
  // The first line must use most of the box instead of wasting it on 9 characters.
  assert.ok(lines[0].length >= paragraph.length * 0.45,
    'first line wasted the box: ' + JSON.stringify(lines[0]));

  // Pure CJK must break between characters, not at a single hard boundary.
  const pure = wrapText('一二三四五六七八九十一二三四五六七八九十一二三四五六七八九十', 2.0, 13.5).split('\n');
  assert.equal(pure.length, 4);
  assert.ok(pure.slice(0, -1).every((line) => line.length >= 9));
});

test('the crop focus maps onto the source rectangle on both axes', () => {
  // object-position has to move the crop window, not just the words around it: the
  // fraction kept must stay the same wherever the focus sits, and each edge focus
  // must keep the picture's own edge.
  const { resolveImageGeometry } = require('../native/engine/image_fit');
  const natural = { width: 16, height: 8 };
  const cropFocus = (focus, box) => resolveImageGeometry({ fit: 'cover', focus, x: 0, y: 0, ...box },
    { natural }).srcRect;
  const tall = { w: 1, h: 3 };
  const centre = cropFocus({ x: 0.5, y: 0.5 }, tall);
  assert.ok(Math.abs(centre.left - centre.right) < 1e-9, 'a centred focus crops evenly');
  assert.ok(Math.abs(centre.left - 5 / 12) < 1e-9,
    'and by the overflow only: ' + JSON.stringify(centre));
  assert.equal(cropFocus({ x: 0, y: 0.5 }, tall).left, 0, 'a left focus keeps the left edge');
  assert.equal(cropFocus({ x: 1, y: 0.5 }, tall).right, 0, 'a right focus keeps the right edge');
  const quarter = cropFocus({ x: 0.25, y: 0.5 }, tall);
  assert.ok(Math.abs((quarter.left + quarter.right) - (centre.left + centre.right)) < 1e-9,
    'the crop total holds wherever the focus sits: ' + JSON.stringify(quarter));
  const bottom = cropFocus({ x: 0.5, y: 1 }, { w: 4, h: 1 });
  assert.equal(bottom.bottom, 0, 'a bottom focus keeps the bottom edge');
  assert.equal(cropFocus({ x: 0.5, y: 0 }, { w: 4, h: 1 }).top, 0, 'a top focus keeps the top edge');
});

test('the writer patches a:pPr indent without touching other paragraphs', () => {
  const { applyTextIndent } = require('../native/engine/native_pptx');
  const emu = Math.round(0.25 * 914400);

  // No pPr at all: one is inserted as the first paragraph child.
  const bare = applyTextIndent('<a:p><a:r><a:t>x</a:t></a:r></a:p>', 0.25);
  assert.ok(bare.includes('<a:pPr indent="' + emu + '"/>'), bare);
  assert.ok(bare.startsWith('<a:p><a:pPr indent="' + emu + '"/><a:r>'), bare);

  // An existing indent (a hanging bullet) is added to, not replaced.
  const hanging = applyTextIndent('<a:p><a:pPr marL="171450" indent="-171450"/><a:r><a:t>y</a:t></a:r></a:p>', 0.25);
  assert.ok(hanging.includes('indent="' + (-171450 + emu) + '"'), hanging);
  assert.ok(hanging.includes('marL="171450"'), hanging);

  // Every paragraph of a multi-paragraph box is patched.
  const multi = applyTextIndent('<a:p><a:r><a:t>a</a:t></a:r></a:p><a:p><a:pPr algn="l" indent="0"/><a:r><a:t>b</a:t></a:r></a:p>', 0.25);
  assert.equal((multi.match(/indent="(\d+)"/gu) || []).length, 2, multi);
});

test('CJK line breaking never starts a line with a closing mark or ends one with an opening bracket', () => {
  const { wrapText } = require('../native/engine/text_measure');
  const closing = new Set(Array.from('，。！？：；、）》】」』〕〉,.!?;:%)]}'));
  const opening = new Set(Array.from('（【「『〔〈〖([{'));
  const patterns = ['一（。」', '一。」」', '一，（」', '一（（。', '一。」，', '一」。、', '一（「。'];
  const sentences = ['中文排版里标点不能出现在行首这是常识。', '一二三四五六七，后续内容继续排版。'];
  const violations = [];
  patterns.forEach((pattern) => {
    sentences.forEach((sentence) => {
      const sample = '一二三四五' + pattern + sentence;
      for (let width = 1.0; width <= 2.6; width += 0.05) {
        const lines = String(wrapText(sample, width, 12, {})).split('\n');
        lines.slice(1).forEach((line) => {
          if (closing.has(Array.from(line)[0])) {
            violations.push({ sample, width: width.toFixed(2), line, kind: 'starts with a mark' });
          }
        });
        lines.slice(0, -1).forEach((line) => {
          if (opening.has(Array.from(line).slice(-1)[0])) {
            violations.push({ sample, width: width.toFixed(2), line, kind: 'ends with an opening bracket' });
          }
        });
      }
    });
  });
  assert.deepEqual(violations.slice(0, 5), [], JSON.stringify(violations.length) + ' violation(s)');

  // The case that exposed it: two marks in a row left the second one at the start of a line.
  const lines = String(wrapText('一二三四五。」」后续文字继续排版', 1.0, 12, {})).split('\n');
  assert.ok(!/^[。」]/u.test(lines[1]), JSON.stringify(lines));
  // And nothing may vanish while the marks are carried.
  assert.equal(lines.join(''), '一二三四五。」」后续文字继续排版');
});

test('object-fit none keeps the source size and scale-down refuses to grow', () => {
  // CSS: `none` draws the source at its own pixel size and lets the slot clip it;
  // `scale-down` is contain that never enlarges. Both used to be drawn as contain,
  // which grows an icon to fill the slot it was given.
  const { resolveImageGeometry, PX_PER_INCH } = require('../native/engine/image_fit');
  const natural = { width: 8, height: 32 };
  const box = { x: 0, y: 0, w: 300 / PX_PER_INCH, h: 120 / PX_PER_INCH };
  const resolve = (fit) => resolveImageGeometry({ type: 'image', fit, x: box.x, y: box.y, w: box.w, h: box.h, naturalSize: natural });

  const none = resolve('none');
  assert.equal(Math.round(none.box.w * PX_PER_INCH), 8, 'none keeps the source width');
  assert.equal(Math.round(none.box.h * PX_PER_INCH), 32, 'and its height');
  assert.equal(none.srcRect, null, 'nothing is cropped: the slot is bigger');

  const scaled = resolve('scale-down');
  assert.equal(Math.round(scaled.box.w * PX_PER_INCH), 8, 'scale-down stops at the source size');

  const contain = resolve('contain');
  assert.equal(Math.round(contain.box.w * PX_PER_INCH), 30, 'while contain fills the slot');
  assert.equal(Math.round(contain.box.h * PX_PER_INCH), 120);

  // A slot smaller than the source: the box clips it, which is a source rectangle.
  const clipped = resolveImageGeometry({ type: 'image', fit: 'none', x: 0, y: 0,
    w: 4 / PX_PER_INCH, h: 10 / PX_PER_INCH, naturalSize: natural });
  assert.ok(clipped.srcRect, 'the overflow becomes a crop');
  assert.equal(Math.round(clipped.srcRect.left * 100), 25, 'half the width is lost, a quarter each side');
  assert.equal(Math.round(clipped.srcRect.bottom * 100), 34, 'and the height keeps a third');
});

test('the static gate sees code, and only code', () => {
  // A rule that is not itself checked drifts. The stripper has to blank strings, comments,
  // regexes and templates while losing no line, or a violation is reported at the wrong line
  // - or not at all.
  const { lintFile, stripStringsAndComments } = require('../native/scripts/lint_static');
  const fs = require('node:fs');
  const os = require('node:os');
  const path = require('node:path');
  const lintText = (text, name) => {
    const file = path.join(os.tmpdir(), 'lint-' + process.pid + '-' + (name || 'case') + '.js');
    fs.writeFileSync(file, text);
    try {
      return lintFile(file);
    } finally {
      fs.rmSync(file, { force: true });
    }
  };
  const rules = (text) => lintText(text).map((problem) => problem.rule + '@' + problem.line).join(',');

  assert.equal(rules("'use strict';\nconst a = 1;\nif (a === 1) {}\n"), '', 'clean code is clean');
  assert.equal(rules("const a = 1;\nif (a == 1) {}\n"), 'double-equals@2', 'a loose comparison is caught');
  assert.equal(rules("var a = 1;\n"), 'var@1', 'var is caught');
  assert.equal(rules("debugger;\n"), 'debugger@1', 'a debugger statement is caught');
  assert.equal(rules("const t = 'a == b';\n"), '', 'but not inside a string');
  assert.equal(rules("// a == b\nconst t = 1;\n"), '', 'nor inside a comment');
  assert.equal(rules("const pattern = /a == b/u;\n"), '', 'nor inside a regular expression');
  assert.equal(rules("const t = `x ${ 1 == 1 } y`;\n"), 'double-equals@1', 'an interpolation is code again');
  assert.equal(rules("const t = 1;\n"), '', 'and a string after it does not swallow the rest');
  assert.equal(rules('const t = "a ` b";\n'), '', 'a backtick inside a string is not a template');
  assert.equal(rules("const value = 1;  \n"), 'trailing-space@1', 'trailing whitespace is caught');
  assert.equal(rules('const value = 1;'), 'final-newline@1', 'a missing final newline is caught');
  assert.equal(rules("const value = 1;\n\tif (value) {}\n"), 'tabs@2', 'tabs are caught');

  // A file that does not compile is reported once, not a hundred times.
  assert.equal(rules("const = ;\n"), 'syntax@1');

  // And the stripper keeps the line count, which is what makes the line numbers true.
  const sample = [
    'const a = `one',
    "two ${ 'x' }`;",
    '/* three',
    'four */',
    'const b = /re[/]x/u;',
    ''
  ].join('\n');
  assert.equal(stripStringsAndComments(sample).split('\n').length, sample.split('\n').length);
});

test('every spec the gates photograph is a spec that builds', () => {
  // The visual gates photograph golden/specs.json. A deck nobody photographs is a deck nobody
  // checks, so the corpus is pinned both ways: every entry builds, and every example spec is listed.
  const fs = require('node:fs');
  const path = require('node:path');
  const native = path.join(__dirname, '..', 'native');
  const manifest = JSON.parse(fs.readFileSync(path.join(native, 'golden', 'specs.json'), 'utf8'));
  assert.ok(manifest.decks.length >= 5, 'the corpus has decks: ' + manifest.decks.length);
  const listed = new Set(manifest.decks.map((entry) => entry.spec).filter(Boolean));
  const specsOnDisk = fs.readdirSync(path.join(__dirname, '..', 'examples'))
    .filter((name) => /^native.*\.spec\.json$/u.test(name) || name === 'native_deck_spec.js')
    .map((name) => name);
  specsOnDisk.forEach((name) => {
    assert.ok(listed.has(name), 'the corpus builds ' + name + ' (add it to golden/specs.json)');
  });
  manifest.decks.forEach((entry) => {
    assert.ok(entry.spec || entry.run, entry.name + ' names something to build');
  });
});

test('the catalogue of what the engine cannot draw matches the code', () => {
  // LIMITS.md is generated from the engine's own refusals and from the schema's conditions. A new
  // throw or a new rule that nobody catalogued is drift, and this is the drift gate.
  const path = require('node:path');
  const { spawnSync } = require('node:child_process');
  const native = path.join(__dirname, '..', 'native');
  const result = spawnSync(process.execPath, [path.join(native, 'scripts', 'limits_report.js')], {
    cwd: native, encoding: 'utf8'
  });
  assert.equal(result.status, 0, 'LIMITS.md is stale: ' + result.stdout + result.stderr);
  const summary = /limits catalogue current: (\d+) refusal\(s\), (\d+) schema condition\(s\)/u.exec(result.stdout);
  assert.ok(summary, 'the catalogue prints what it found: ' + result.stdout);
  assert.ok(Number(summary[1]) > 50, 'the engine refuses more than fifty things, got ' + summary[1]);
  assert.ok(Number(summary[2]) > 50, 'the schema holds more than fifty rules, got ' + summary[2]);
});
test('tracking is measured, not just written', () => {
  // `charSpacing` reaches the writer as `a:rPr@spc`, and for a long time it stopped there: the
  // measurement never saw it, so the wrap put more characters on a line than the render did and
  // the box reserved one line fewer than it drew.
  const body = '把渠道成本摊开来看，单车毛利才是一句实话，其余都是口径。';
  const plain = { type: 'text', text: body, x: 0.5, y: 0.5, w: 2.6, h: 0.4, fontSize: 14 };
  const tracked = Object.assign({}, plain, { charSpacing: 4 });
  const layoutOf = (element) => layoutSlide({ elements: [element] }, { width: 13.333, height: 7.5 })[0];
  const fromPlain = layoutOf(plain);
  const fromTracked = layoutOf(tracked);
  const widest = (element) => Math.max.apply(null,
    String(element._renderText).split('\n').map((line) => Array.from(line).length));
  assert.notEqual(fromTracked._renderText, fromPlain._renderText, 'the wrap sees the tracking');
  assert.ok(widest(fromTracked) < widest(fromPlain),
    'a tracked line holds fewer characters: ' + widest(fromTracked) + ' vs ' + widest(fromPlain));
  assert.ok(fromTracked._requiredTextHeight >= fromPlain._requiredTextHeight,
    'and the box is never reserved smaller than before: ' + fromTracked._requiredTextHeight);
});

test('a closing quotation mark never starts a line', () => {
  // The kinsoku pass carried 。and ，back to the line above but not the quotes, so a sentence that
  // ended in a quotation mark had the mark sitting at the head of the next line.
  const lines = wrapText('行业里有一句话说得对：“毛利才是实话，份额只是过程。”所以我们要看单车毛利。', 4.2, 16).split('\n');
  assert.ok(lines.length > 1, 'the sample wraps: ' + JSON.stringify(lines));
  lines.forEach((line, index) => {
    assert.ok(!/^[”’»›]/u.test(line), 'line ' + index + ' starts with a closing mark: ' + line);
  });
});

test('an opening quotation mark never ends a line', () => {
  const lines = wrapText('会议纪要里写着：他说“明年的重点是把渠道成本压到最低”，这句话要落到预算里。', 3.4, 16).split('\n');
  lines.forEach((line, index) => {
    assert.ok(!/[“‘«‹]$/u.test(line), 'line ' + index + ' ends with an opening mark: ' + line);
  });
});

test('a malformed edge is reported, not thrown', () => {
  // `validateEdge` was called without its `errors` array, so the first thing it did with a malformed
  // edge was `undefined.push`: the CLI exited 2 with a stack trace instead of naming the field and
  // exiting 1. The feature itself was unusable, because validation runs before layout.
  const bad = validateDeck({ slides: [{ elements: [
    { type: 'shape', x: 0.5, y: 0.5, w: 2, h: 1, fill: '12283F', line: false, edge: { side: 'diagonal' } }
  ] }] });
  assert.ok(bad.length >= 3, 'side, width and color are all named: ' + JSON.stringify(bad));
  bad.forEach((message) => assert.match(message, /\.edge\./u, message));

  const good = validateDeck({ slides: [{ elements: [
    { type: 'shape', x: 0.5, y: 0.5, w: 2, h: 1, fill: '12283F', line: false,
      edge: { side: 'top', width: 4, color: 'D08C3A' } }
  ] }] });
  assert.deepEqual(good, [], 'a well-formed edge validates');
});

test('a declared edge is drawn as a strip along that side of the box', () => {
  const laid = layoutSlide({ elements: [
    { type: 'shape', x: 0.5, y: 1.2, w: 4, h: 1, fill: 'FFFFFF', line: false,
      edge: { side: 'bottom', width: 7.2, color: 'D08C3A' } }
  ] }, { width: 13.333, height: 7.5 });
  assert.equal(laid.length, 2, 'the box and its edge strip');
  const strip = laid[1];
  assert.equal(strip.type, 'shape');
  assert.equal(strip.fill, 'D08C3A');
  assert.equal(strip.w, 4, 'the strip spans the box');
  assert.ok(Math.abs(strip.h - 7.2 / 72) < 1e-9, 'thickness is the declared points: ' + strip.h);
  assert.ok(Math.abs(strip.y - (1.2 + 1 - 7.2 / 72)) < 1e-9, 'and it sits on the bottom edge: ' + strip.y);
});

test('a bad inner shadow is named once', () => {
  // The shadow validator ran twice for `innerShadow`, so every complaint about it arrived in pairs
  // and an author went looking for a second, imaginary problem.
  const errors = validateDeck({ slides: [{ elements: [
    { type: 'shape', x: 0.5, y: 0.5, w: 2, h: 1, fill: 'FFFFFF', innerShadow: { blur: -1 } }
  ] }] });
  const inner = errors.filter((message) => /innerShadow/u.test(message));
  assert.equal(inner.length, 1, 'one complaint: ' + JSON.stringify(errors));
});

test('a font collection is measured through one of its faces', () => {
  // A Windows family ships as a `.ttc`; fontkit hands the collection back without `layout`, so a
  // correctly declared `msyh.ttc` measured nothing and the wrap stayed an estimate for ever.
  const { pickFace } = require('../native/engine/font_manager');
  const face = { layout: () => ({ positions: [] }), glyphForCodePoint: () => ({ id: 1 }) };
  assert.equal(pickFace(face), face, 'a single font is its own face');
  assert.equal(pickFace({ fonts: [face] }), face, 'a collection yields its first real face');
  assert.equal(pickFace({ fonts: [] }), null, 'an empty collection yields nothing, not a crash');
  assert.equal(pickFace(null), null);
});
test('a family is enough when the face is installed', (t) => {
  // The 25-page run measured 11,678 text widths from an estimate on a machine that had
  // \`Microsoft YaHei\` installed, because the deck named the family and not the file - and the file
  // (\`msyh.ttc\`) cannot be guessed from the name. The family-to-file table is a system fact, so the
  // manager reads it: no spec change is needed for exact metrics.
  const installed = require('../native/engine/font_manager').fontFileForFamily('Microsoft YaHei');
  if (!installed) { t.skip('Microsoft YaHei is not installed on this machine'); return; }
  const manager = new FontManager();
  const width = manager.measure('中国新能源汽车出海', 14, 'Microsoft YaHei');
  assert.ok(Number.isFinite(width) && width > 0, 'the face was measured: ' + width);
  assert.equal(manager.inspect().measuredCalls, 1, 'and it counted as a measurement, not an estimate');
  assert.ok(manager.inspect().loadedFiles.length > 0, 'the file it opened is reported: '
    + JSON.stringify(manager.inspect().loadedFiles));
});

test('discovery can be switched off for a reproducible build', () => {
  // A build that must not read the host's fonts says so, and falls back to the estimate - which is
  // reported, counted, and refused by --require-face-metrics.
  const manager = new FontManager({ discoverFaces: false });
  assert.equal(manager.measure('中国新能源汽车出海', 14, 'Microsoft YaHei'), null);
  assert.equal(manager.inspect().measuredCalls, 0);
  assert.equal(manager.inspect().estimatedCalls, 1);
  assert.equal(manager.inspect().discoveredFaces, false);
});
test('fontconfig is trusted only when it names the family', () => {
  // A server is a Linux box: the family is \`Noto Sans CJK SC\` and the file is
  // \`NotoSansCJK-Regular.ttc\`, so a filename-prefix guess resolves nothing and every width falls back
  // to the estimate. fontconfig knows the mapping - and never fails, it answers with the closest family
  // it has, so a fallback answer must be refused.
  const { fcMatchFile } = require('../native/engine/font_manager');
  const realFile = process.execPath;
  const answers = (familyName) => (args) => (args[1] === '%{file}' ? realFile + '\n' : familyName + '\n');

  assert.equal(fcMatchFile('Noto Sans CJK SC', answers('Noto Sans CJK JP, Noto Sans CJK SC')),
    realFile, 'the family is in the list fontconfig reports');
  assert.equal(fcMatchFile('Noto Sans CJK SC', answers('DejaVu Sans')),
    null, 'a fallback to another family is not the face that was asked for');
  assert.equal(fcMatchFile('Noto Sans CJK SC', () => { throw new Error('fc-match: not found'); }),
    null, 'no fontconfig means no answer, not a wrong one');
  assert.equal(fcMatchFile('Noto Sans CJK SC', (args) => (args[1] === '%{file}' ? '/nope/missing.ttc' : 'Noto Sans CJK SC')),
    null, 'and a path that is not on disk is not a face');
});
test('relative media paths resolve against the spec, not the process', () => {
  // A server worker runs the build from wherever it likes. When a relative picture path was resolved
  // against \`cwd\` instead of the spec, the build exited 0 and dropped every picture - 6 of them on a
  // 25-page deck, with one line in the footer to say so.
  const { withResolvedAssets } = require('../native/engine/native_pptx');
  const deck = {
    slides: [{
      elements: [
        { type: 'image', path: 'assets/hero.jpg', x: 0, y: 0, w: 1, h: 1 },
        { type: 'image', path: 'data:image/png;base64,AAAA', x: 0, y: 0, w: 1, h: 1 },
        { type: 'image', path: 'C:/fixtures/pinned.png', x: 0, y: 0, w: 1, h: 1 },
        { type: 'container', children: [{ type: 'image', path: 'assets/inner.jpg' }] }
      ]
    }]
  };
  const resolved = require('node:path').win32 ? withResolvedAssets(deck, 'F:\\jobs\\42\\deck') : withResolvedAssets(deck, '/jobs/42/deck');
  const base = require('node:path').win32 ? 'F:\\jobs\\42\\deck' : '/jobs/42/deck';
  const expected = require('node:path').resolve(base, 'assets/hero.jpg');
  assert.equal(resolved.slides[0].elements[0].path, expected, 'the relative path is anchored at the deck');
  assert.equal(resolved.slides[0].elements[1].path, 'data:image/png;base64,AAAA', 'a data URI is left alone');
  assert.equal(resolved.slides[0].elements[2].path, 'C:/fixtures/pinned.png', 'an absolute path is left alone');
  assert.equal(resolved.slides[0].elements[3].children[0].path,
    require('node:path').resolve(base, 'assets/inner.jpg'), 'container children too');
  assert.equal(deck.slides[0].elements[0].path, 'assets/hero.jpg', 'and the caller\'s spec is not mutated');
});
