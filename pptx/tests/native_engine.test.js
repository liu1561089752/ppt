'use strict';

const test = require('node:test');
const analyzer = require('../native/pipeline/analyzer.js');
const css = require('../native/pipeline/css.js');
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


test('legacy concurrent HTML conversion reserves and removes slide slots in source order', () => {
  const { createOrderedSlideTasks, removeFailedSlideTasks } = require('../slide_order');
  const slides = [];
  const removed = [];
  const pptx = {
    addSlide() {
      const slide = { _slideNum: slides.length + 1 };
      slides.push(slide);
      return slide;
    },
    removeSlide(slideNumber) {
      removed.push(slideNumber);
      slides.splice(slideNumber - 1, 1);
      slides.forEach((slide, index) => { slide._slideNum = index + 1; });
    }
  };
  const tasks = createOrderedSlideTasks(pptx, ['slide_01.html', 'slide_02.html', 'slide_03.html', 'slide_04.html']);
  tasks[1].failed = true;
  tasks[3].failed = true;
  const failed = removeFailedSlideTasks(pptx, tasks);
  assert.deepEqual(failed.map((task) => task.htmlFile), ['slide_04.html', 'slide_02.html']);
  assert.deepEqual(removed, [4, 2]);
  assert.deepEqual(slides.map((slide) => slide._slideNum), [1, 2]);
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

test('complex multi-page stress deck stays editable, complete, and warning-free', async () => {
  await withTempDir('native-stress-', async (directory) => {
    const { buildStressDeck, buildAssets } = require('../examples/native_stress_deck');
    const { generatePptx } = require('../native/engine/native_pptx');
    const { auditPptx } = require('../native/scripts/audit_deck');
    const assets = buildAssets(pathSync.join(directory, 'assets'));
    const output = pathSync.join(directory, 'stress.pptx');
    const result = await generatePptx(buildStressDeck(assets), output);
    assert.equal(result.report.length, 12);
    const blocking = result.report.flatMap((slide) =>
      slide.warnings.filter((warning) => warning.code !== 'LAYOUT_WARNING'));
    assert.deepEqual(blocking, []);

    const report = await auditPptx(output);
    assert.equal(report.slideCount, 12);
    assert.equal(report.errors, 0);
    assert.ok(report.totals.textShapes >= 100, 'expected a text-heavy deck, saw ' + report.totals.textShapes);
    assert.ok(report.totals.characters >= 1800, 'expected dense content, saw ' + report.totals.characters);
    assert.ok(report.totals.charts >= 1);
    assert.ok(report.totals.tables >= 1);
    assert.ok(report.totals.croppedPictures >= 2);
    assert.ok(report.totals.roundedPictures >= 2);
    assert.ok(report.totals.shadowedPictures >= 1);
    report.slides.forEach((slide) => {
      assert.ok(slide.textShapes >= 1, slide.part + ' must keep editable text');
      assert.ok(slide.characters >= 20, slide.part + ' must keep real content');
      assert.ok(slide.pictureCoverage <= 1.001, slide.part + ' pictures must stay inside the slide');
    });
  });
});

// ---------------------------------------------------------------------------
// HTML -> Native pipeline
// ---------------------------------------------------------------------------

const pipeline = require('../native/pipeline');
const htmlParser = require('../native/pipeline/html_parser');
const cssTools = require('../native/pipeline/css');

const PIPELINE_FIXTURES = pathSync.join(__dirname, '..', 'examples');

test('html parser handles attributes, entities, void tags, and raw text blocks', () => {
  const root = htmlParser.parseHtml(
    '<div class="a b" data-x=1><img src="i.png" alt="A &amp; B"><p>hello &lt;world&gt;</p></div>' +
    '<style>.x{color:red}</style><!-- note --><br>'
  );
  const div = htmlParser.elementChildren(root)[0];
  assert.equal(div.tag, 'div');
  assert.deepEqual(htmlParser.classesOf(div), ['a', 'b']);
  assert.equal(div.attrs['data-x'], '1');
  const img = htmlParser.elementChildren(div)[0];
  assert.equal(img.tag, 'img');
  assert.equal(img.attrs.alt, 'A & B');
  const paragraph = htmlParser.elementChildren(div)[1];
  assert.equal(htmlParser.normalizedText(paragraph), 'hello <world>');
  const styleNode = htmlParser.elementChildren(root).find((node) => node.tag === 'style');
  assert.equal(htmlParser.textContent(styleNode).trim(), '.x{color:red}');
});

test('css subset resolves variables, specificity, shorthands, and unitless line-height', () => {
  const sheet = cssTools.parseStylesheet([
    ':root { --ink: #183B3A; --pad: 12px; }',
    'p { color: #FF0000; line-height: 1.5; padding: var(--pad); }',
    '.lead { color: var(--ink); font-size: 18px; }',
    '.lead.strong { font-weight: 700; }'
  ].join('\n'));
  const resolver = cssTools.createStyleResolver(sheet);
  const document = htmlParser.parseHtml('<body><p class="lead strong">hi</p></body>');
  const paragraph = htmlParser.findAll(document, (node) => node.tag === 'p')[0];
  const style = resolver.computed(paragraph);
  assert.equal(style.color, '#183B3A');
  assert.equal(style.fontWeight, '700');
  assert.equal(style.paddingTop, '12px');
  assert.equal(style.paddingLeft, '12px');
  assert.equal(style.fontSize, '18px');
  // Unitless line-height must stay unitless instead of becoming 1.5px.
  assert.deepEqual(cssTools.parseLength(style.lineHeight), { value: 1.5, unit: '' });
  assert.equal(cssTools.parseColor('rgba(24, 59, 58, 0.5)').hex, '183B3A');
  assert.equal(cssTools.parseColor('rgba(24, 59, 58, 0.5)').alpha, 0.5);
  assert.equal(cssTools.parseLinearGradient('linear-gradient(135deg, #000000 0%, #FFFFFF 100%)').angle, 135);
});

test('html pipeline reproduces the reviewed parity fixture geometry', () => {
  const html = fsSync.readFileSync(pathSync.join(PIPELINE_FIXTURES, 'design-reference.html'), 'utf8');
  const result = pipeline.convertHtml(html);
  assert.deepEqual(result.errors, []);
  assert.equal(result.deck.slides.length, 1);
  const elements = result.deck.slides[0].elements;

  const panel = elements.find((element) => element.type === 'shape' && element.fill === '1B2836' && element.y === 0);
  assert.ok(Math.abs(panel.x - 8.653) < 0.01, 'right panel x was ' + panel.x);
  assert.ok(Math.abs(panel.w - 4.68) < 0.01, 'right panel width was ' + panel.w);

  const title = elements.find((element) => element.type === 'text' && element.role === 'title');
  assert.equal(title.text, '从 HTML 到原生 PowerPoint');
  assert.equal(title.fontSize, 28.5);
  assert.equal(title.color, 'F2AA4C');
  assert.equal(title.fontFace, 'Aptos Display');
  assert.equal(title.bold, true);
  assert.ok(Math.abs(title.x - 1.083) < 0.01);

  const card = elements.find((element) => element.type === 'shape' && element.fill === '1B2836' && element.y > 3);
  assert.ok(Math.abs(card.radius - 0.146) < 0.005, 'card radius was ' + card.radius);
  assert.equal(card.lineColor, '344657');

  const caption = elements.find((element) => element.type === 'text' && element.role === 'caption');
  assert.equal(caption.text, 'VISUAL SYSTEM / 01');
  assert.equal(caption.fontSize, 9);
  // The fixture declares `overflow: hidden` on the slide, but nothing overflows it,
  // so the declaration changes no pixel and is not a limitation to report.
  assert.deepEqual(result.report.unsupportedDetails.map((entry) => entry.property), []);
});

test('html pipeline maps flex rows, grid tracks, lists, tables, and images to native objects', () => {
  const html = fsSync.readFileSync(pathSync.join(PIPELINE_FIXTURES, 'pipeline-reference.html'), 'utf8');
  const result = pipeline.convertHtml(html);
  assert.deepEqual(result.errors, []);
  assert.equal(result.deck.slides.length, 4);
  assert.equal(result.report.images, 2);
  assert.equal(result.report.tables, 1);

  // Resolve the declarative spec exactly like the writer does, so the assertions
  // below prove what the containers actually produce.
  const { layoutSlide } = require('../native/engine/layout');
  const resolveSlide = (index) => layoutSlide(
    { elements: result.deck.slides[index].elements, margin: 0, gap: 0 },
    result.deck.pageSize,
    result.deck.theme,
    {}
  );

  // The flex row must be declared, not flattened into coordinates.
  const row = result.deck.slides[1].elements.find((element) => element.type === 'container');
  assert.ok(row, 'the flex row must become a native container');
  assert.equal(row.direction, 'row');
  assert.ok(Math.abs(row.gap - 24 / 96) < 1e-6, 'row gap was ' + row.gap);
  assert.equal(row.children.length, 3);
  assert.ok(row.children.every((child) => child.type === 'container'),
    'each card stays a nested container');
  assert.ok(result.report.declarativeContainers >= 4, 'row + cards must be declarative');
  assert.equal(result.report.absoluteGroups, 0, 'nothing should need to fall back');
  assert.ok(result.report.maxBoxDelta < 0.002,
    'engine and analyzer must agree, delta was ' + result.report.maxBoxDelta);

  const cards = resolveSlide(1).filter((element) => element.type === 'shape' && element.fill === 'FFFFFF');
  assert.equal(cards.length, 3);
  // flex: 1 with a 24px gap inside a 1152px row.
  assert.ok(Math.abs(cards[0].w - 368 / 96) < 0.01, 'card width was ' + cards[0].w);
  assert.ok(Math.abs(cards[1].x - cards[0].x - (368 + 24) / 96) < 0.01);
  // align-items defaults to stretch, so every card shares one height.
  assert.ok(cards.every((card) => Math.abs(card.h - cards[0].h) < 1e-6));
  assert.ok(cards[0].shadow, 'box-shadow must survive as an editable shadow');

  const gridSlide = resolveSlide(2);
  const image = gridSlide.find((element) => element.type === 'image');
  assert.ok(image, 'the grid slide must keep a native picture');
  assert.equal(image.fit, 'cover');
  assert.ok(Math.abs(image.radius - 0.125) < 0.005);

  const list = gridSlide.find((element) => element.type === 'text' && element.bullet === true);
  assert.ok(list, 'a <ul> must become a bulleted native text box');
  assert.ok(list.text.split('\n').length >= 4);
  assert.ok(list.h > 0.9, 'list height must cover all items, was ' + list.h);

  const tableSlide = resolveSlide(3);
  const table = tableSlide.find((element) => element.type === 'table');
  assert.equal(table.rows.length, 5);
  assert.equal(table.rows[0][0].options.bold, true);
  assert.equal(table.rows[0][1].text, '输出');
});

test('html pipeline reports unsupported CSS instead of silently dropping it', () => {
  const html = [
    '<html><head><style>',
    '.slide { width: 1280px; height: 720px; }',
    '.blur { filter: blur(8px); color: #FF0000; font-size: 20px; }',
    '.floaty { float: left; }',
    '</style></head><body>',
    '<main class="slide"><div class="blur floaty">内容</div></main>',
    '</body></html>'
  ].join('\n');
  const result = pipeline.convertHtml(html);
  const properties = result.report.unsupportedDetails.map((entry) => entry.property);
  assert.ok(properties.includes('filter'));
  assert.ok(properties.includes('float'));
  const text = result.deck.slides[0].elements.find((element) => element.type === 'text');
  assert.equal(text.text, '内容');
  assert.equal(text.color, 'FF0000');
});

test('html pipeline output stays editable once written to PPTX', async () => {
  await withTempDir('native-pipeline-', async (directory) => {
    const html = fsSync.readFileSync(pathSync.join(PIPELINE_FIXTURES, 'pipeline-reference.html'), 'utf8');
    const { generatePptx } = require('../native/engine/native_pptx');
    const { auditPptx } = require('../native/scripts/audit_deck');
    const result = pipeline.convertHtml(html);
    const output = pathSync.join(directory, 'pipeline.pptx');
    await generatePptx(result.deck, output);
    const report = await auditPptx(output);
    assert.equal(report.slideCount, 4);
    assert.equal(report.errors, 0);
    assert.equal(report.totals.tables, 1);
    assert.equal(report.totals.pictures, 2);
    // Only the figure crops: `object-fit: cover` in a 300px-tall box. The square logo in a
    // square box is stretched by the browser and by this engine alike, so it needs no crop.
    assert.equal(report.totals.croppedPictures, 1);
    assert.ok(report.totals.characters > 500);
    report.slides.forEach((slide) => assert.ok(slide.textShapes >= 2, slide.part + ' must keep editable text'));
  });
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

test('html pipeline converts CSS gradient angles into DrawingML angles', () => {
  const html = [
    '<html><head><style>',
    '.slide { width: 1280px; height: 720px; }',
    '.hero { position: absolute; left: 0; top: 0; width: 1280px; height: 720px;',
    '  background: linear-gradient(135deg, #142536 0%, #E56A42 100%); }',
    '</style></head><body><main class="slide"><div class="hero"></div></main></body></html>'
  ].join('\n');
  const result = pipeline.convertHtml(html);
  const shape = result.deck.slides[0].elements.find((element) => element.gradient);
  assert.ok(shape, 'the gradient must survive the conversion');
  // 135deg in CSS points to the bottom-right; DrawingML measures clockwise from
  // east, so the same direction is 45 degrees there.
  assert.equal(shape.gradient.angle, 45);
  assert.equal(shape.gradient.stops.length, 2);
  assert.equal(shape.gradient.stops[1].color, 'E56A42');
});

test('html pipeline paints table header cells declared with the background shorthand', () => {
  const html = [
    '<html><head><style>',
    '.slide { width: 1280px; height: 720px; }',
    'table { position: absolute; left: 40px; top: 40px; width: 800px; }',
    'th { background: #183B3A; color: #FFFFFF; font-weight: 700; }',
    'td { color: #202321; }',
    '</style></head><body><main class="slide"><table>',
    '<thead><tr><th>阶段</th><th>输出</th></tr></thead>',
    '<tbody><tr><td>A</td><td>B</td></tr></tbody>',
    '</table></main></body></html>'
  ].join('\n');
  const result = pipeline.convertHtml(html);
  const table = result.deck.slides[0].elements.find((element) => element.type === 'table');
  assert.ok(table, 'table must be converted');
  assert.equal(table.rows[0][0].options.fill.color, '183B3A');
  assert.equal(table.rows[0][0].options.color, 'FFFFFF');
  assert.equal(table.rows[0][0].options.bold, true);
  assert.equal(table.rows[1][0].options.color, '202321');
});

test('html pipeline turns a CSS background image into a native picture', async () => {
  const { makePng, gradientPainter } = require('../native/scripts/sample_image');
  await withTempDir('native-bgimage-', async (directory) => {
    fsSync.writeFileSync(pathSync.join(directory, 'photo.png'),
      makePng(400, 300, gradientPainter([10, 20, 30], [200, 120, 60])));
    const html = `<!doctype html><html><head><style>
.slide { width: 1280px; height: 720px; }
.hero { position: absolute; left: 40px; top: 40px; width: 600px; height: 300px;
  background-image: url("photo.png"); background-size: cover; background-position: top left;
  border-radius: 16px; }
.panel { position: absolute; left: 40px; top: 400px; width: 600px; height: 240px;
  background: url("photo.png") center / contain no-repeat; }
</style></head><body><main class="slide">
  <div class="hero"></div>
  <div class="panel"><p>叠加在图片上的正文</p></div>
</main></body></html>`;
    fsSync.writeFileSync(pathSync.join(directory, 'deck.html'), html);

    const result = await pipeline.convertFile(pathSync.join(directory, 'deck.html'), {
      pptx: pathSync.join(directory, 'deck.pptx')
    });
    assert.deepEqual(result.errors, []);
    // The childless .hero becomes a plain native picture; the .panel keeps its
    // text child, so it is a block with a background picture painted underneath.
    assert.equal(result.report.images, 2);
    assert.equal(result.report.backgroundImages, 1);
    assert.deepEqual(result.report.unsupportedDetails, []);

    const elements = result.deck.slides[0].elements;
    const pictures = elements.filter((element) => element.type === 'image');
    assert.equal(pictures.length, 2);
    assert.equal(pictures[0].fit, 'cover');
    assert.equal(pictures[0].focus, 'top left');
    assert.equal(pictures[0].radius, 0.167);
    assert.equal(pictures[1].fit, 'contain');
    // Children painted on top of a background image stay editable text.
    const overlay = elements.find((element) => element.type === 'text');
    assert.equal(overlay.text, '叠加在图片上的正文');
    assert.ok(elements.indexOf(overlay) > elements.indexOf(pictures[1]),
      'text must be painted above the background picture');

    // The relative url() must resolve against the HTML file when writing the PPTX.
    const { auditPptx } = require('../native/scripts/audit_deck');
    const audit = await auditPptx(result.output.pptx);
    assert.equal(audit.totals.pictures, 2);
    assert.equal(audit.errors, 0);
  });
});

test('html pipeline declares block-flow cards as containers and falls back when CSS is not expressible', () => {
  const html = [
    '<html><head><style>',
    '.slide { width: 1280px; height: 720px; }',
    '.row { position: absolute; left: 40px; top: 40px; width: 1000px; display: flex; gap: 20px; }',
    '.card { flex: 1; padding: 16px; background: #FFFFFF;',
    '  border: 1px solid #DCE2DE; border-radius: 12px; }',
    '.card h3 { margin: 0 0 8px 0; font-size: 16px; }',
    '.card p { margin: 0; font-size: 12px; }',
    '.spaced { position: absolute; left: 40px; top: 420px; width: 1000px; display: flex; gap: 20px; }',
    '.spaced div { flex: 1; margin: 6px; padding: 8px; background: #EEEEEE; font-size: 12px; }',
    '</style></head><body><main class="slide">',
    '<section class="row">',
    '  <article class="card"><h3>甲</h3><p>说明一</p></article>',
    '  <article class="card"><h3>乙</h3><p>说明二</p></article>',
    '</section>',
    '<div class="spaced"><div>一</div><div>二</div></div>',
    '</main></body></html>'
  ].join('\n');
  const result = pipeline.convertHtml(html);
  assert.deepEqual(result.errors, []);

  const row = result.deck.slides[0].elements.find((element) => element.type === 'container');
  assert.ok(row, 'the card row must be declarative');
  assert.equal(row.direction, 'row');

  // A card has a border, so the border inset must be folded into its padding,
  // and its block-flow children keep their CSS margins.
  const card = row.children[0];
  assert.equal(card.direction, 'column');
  assert.equal(card.gap, 0, 'block flow spaces children with margins, not a gap');
  assert.ok(Math.abs(card.padding.top - (16 / 96 + 0.75 / 72)) < 1e-6,
    'padding must include the 1px border inset, was ' + card.padding.top);
  assert.ok(Math.abs(card.children[0].boxMargin.bottom - 8 / 96) < 1e-6,
    'the h3 bottom margin must be preserved, was ' + JSON.stringify(card.children[0].boxMargin));
  // `margin` is the writer's text-inset option, so layout margins must never use
  // that name or converted text renders inset by 0.1in.
  assert.equal(card.children[0].margin, undefined,
    'layout margins must be emitted as boxMargin, not margin');

  // Resolving the spec must reproduce the analysed boxes.
  const { layoutSlide } = require('../native/engine/layout');
  const resolved = layoutSlide(
    { elements: result.deck.slides[0].elements, margin: 0, gap: 0 },
    result.deck.pageSize, result.deck.theme, {}
  );
  const headings = resolved.filter((element) => element.type === 'text' && (element.text === '甲' || element.text === '乙'));
  assert.equal(headings.length, 2);
  assert.ok(headings[0].x > 0 && headings[0].y > 0);
  assert.ok(Math.abs(headings[0].y - headings[1].y) < 1e-6, 'both cards start at the same y');

  // A flex row whose children declare margins has no container equivalent: it
  // must stay on explicit coordinates instead of silently dropping the margins.
  assert.ok(result.report.absoluteGroups >= 1, 'the margin-flex row must fall back');
  assert.ok(result.report.containerFallbacks.some((entry) => /margins/u.test(entry.reason)),
    'the fallback reason must name the margins: ' + JSON.stringify(result.report.containerFallbacks));
  assert.ok(result.report.maxBoxDelta < 0.002);
});

test('html pipeline honours text-transform, min-height and content-box sizing', () => {
  const html = [
    '<html><head><style>',
    '.slide { width: 1280px; height: 720px; }',
    '.minh { position: absolute; left: 40px; top: 40px; width: 200px; min-height: 200px; background: #DDDDDD; }',
    '.cap { position: absolute; left: 40px; top: 300px; width: 400px; text-transform: uppercase; font-size: 20px; }',
    '.boxy { position: absolute; left: 40px; top: 400px; width: 200px; height: 100px;',
    '  padding: 20px; box-sizing: content-box; background: #EEEEEE; }',
    '</style></head><body><main class="slide">',
    '<div class="minh"></div>',
    '<p class="cap">lowercase source text</p>',
    '<div class="boxy"></div>',
    '</main></body></html>'
  ].join('\n');
  const result = pipeline.convertHtml(html);
  assert.deepEqual(result.errors, []);

  const { layoutSlide } = require('../native/engine/layout');
  const elements = layoutSlide({ elements: result.deck.slides[0].elements, margin: 0, gap: 0 },
    result.deck.pageSize, result.deck.theme, {});

  const minh = elements.find((element) => element.type === 'shape' && element.fill === 'DDDDDD');
  assert.ok(minh, 'the min-height box must keep its fill');
  assert.ok(Math.abs(minh.h - 200 / 96) < 0.01, 'min-height was ignored, h=' + minh.h);

  const caption = elements.find((element) => element.type === 'text');
  assert.equal(caption.text, 'LOWERCASE SOURCE TEXT',
    'text-transform must be applied to the emitted text');

  const boxy = elements.find((element) => element.fill === 'EEEEEE');
  assert.ok(boxy, 'a box with padding keeps its surface');
  // content-box: 200px content + 2x20px padding = 240px border box.
  assert.ok(Math.abs(boxy.w - 240 / 96) < 0.01, 'content-box width was ' + boxy.w);
});

test('html pipeline keeps the surface behind text and paints z-index in order', () => {
  const html = [
    '<html><head><style>',
    '.slide { width: 1280px; height: 720px; }',
    '.badge { position: absolute; left: 40px; top: 40px; padding: 8px 16px;',
    '  background: #D2691E; color: #FFFFFF; border-radius: 999px; font-size: 14px; }',
    '.under { position: absolute; left: 60px; top: 300px; width: 300px; padding: 12px;',
    '  background: #222222; color: #FFFFFF; font-size: 18px; z-index: 1; }',
    '.over { position: absolute; left: 40px; top: 200px; width: 300px; padding: 12px;',
    '  background: #CCCCCC; color: #000000; font-size: 18px; z-index: 9; }',
    '</style></head><body><main class="slide">',
    '<div class="badge">徽标</div>',
    '<div class="over">z-index 9 but first in DOM</div>',
    '<div class="under">z-index 1 but second in DOM</div>',
    '</main></body></html>'
  ].join('\n');
  const result = pipeline.convertHtml(html);
  assert.deepEqual(result.errors, []);

  const elements = result.deck.slides[0].elements;
  const badge = elements.find((element) => element.type === 'container'
    && element.background && element.background.fill === 'D2691E');
  assert.ok(badge, 'a badge must keep its fill instead of emitting bare text');
  assert.equal(badge.children.length, 1);
  assert.equal(badge.children[0].type, 'text');
  assert.equal(badge.children[0].text, '徽标');
  assert.ok(badge.padding.left > 0.1, 'the text must be inset by the padding');

  const fills = elements
    .filter((element) => element.type === 'container' && element.background)
    .map((element) => element.background.fill)
    .filter((fill) => fill === '222222' || fill === 'CCCCCC');
  assert.deepEqual(fills, ['222222', 'CCCCCC'],
    'z-index must decide paint order, not DOM order');
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

test('html pipeline maps img object-position onto the native crop focus', () => {
  const png = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAgAAAAIAQMAAAChd0V1AAAABlBMVEX/AAAAAAAB1Vw7zQAAAAxJREFUCNdjYGBgAAAABQABh6FO1AAAAABJRU5ErkJggm==';
  const html = [
    '<html><head><style>',
    '.slide { width: 1280px; height: 720px; }',
    '.frame { position: absolute; left: 40px; top: 40px; width: 400px; height: 200px; }',
    '.frame img { width: 100%; height: 100%; object-fit: cover; object-position: right top; }',
    '</style></head><body><main class="slide">',
    '<figure class="frame"><img src="' + png + '" alt="probe"></figure>',
    '</main></body></html>'
  ].join('\n');
  const result = pipeline.convertHtml(html);
  assert.deepEqual(result.errors, []);

  const { layoutSlide } = require('../native/engine/layout');
  const image = layoutSlide({ elements: result.deck.slides[0].elements, margin: 0, gap: 0 },
    result.deck.pageSize, result.deck.theme, {}).find((element) => element.type === 'image');
  assert.ok(image, 'the figure must keep a native picture');
  assert.equal(image.fit, 'cover');
  assert.equal(image.focus, 'top right', 'object-position must become the crop focus');
  assert.ok([image.x, image.y, image.w, image.h].every(Number.isFinite),
    'picture geometry must stay finite: ' + JSON.stringify(image));
});


test('every CSS property claimed as supported is actually read', () => {
  // The "supported" set is a promise. Eight properties were listed there while
  // nothing ever read them, so `text-transform`, `min-height`, `z-index` and
  // friends were silently dropped. This test keeps the promise honest.
  const analyzer = require('../native/pipeline/analyzer.js');
  const files = ['analyzer.js', 'css.js', 'deck_builder.js', 'html_parser.js'];
  let source = files
    .map((file) => fsSync.readFileSync(pathSync.join(pathSync.join(__dirname, '..', 'native', 'pipeline'), file), 'utf8'))
    .join('\n');
  const start = source.indexOf('const SUPPORTED_PROPERTIES');
  const end = source.indexOf(']);', start);
  source = source.slice(0, start) + source.slice(end);

  // These are resolved through boxShorthand(style, 'padding' | 'margin').
  const shorthandDriven = new Set([
    'padding', 'paddingTop', 'paddingRight', 'paddingBottom', 'paddingLeft',
    'margin', 'marginTop', 'marginRight', 'marginBottom', 'marginLeft'
  ]);

  const unread = [];
  for (const property of analyzer.SUPPORTED_PROPERTIES) {
    if (shorthandDriven.has(property)) continue;
    const direct = new RegExp('style\\.' + property + '(?![A-Za-z0-9_])');
    const bracketed = new RegExp('style\\[\'' + property + '\'\\]');
    if (!direct.test(source) && !bracketed.test(source)) unread.push(property);
  }
  assert.deepEqual(unread, [],
    'these properties are declared supported but never read: ' + unread.join(', '));
});

test('html pipeline never lets pseudo rules deform the element they decorate', () => {
  const html = [
    '<html><head><style>',
    '.slide { width: 1280px; height: 720px; }',
    '.card { position: absolute; left: 40px; top: 40px; width: 200px; background: #EEEEEE; }',
    '.card::before { content: ""; width: 40px; height: 40px; background: #FF0000; }',
    '.card:hover { background: #000000; }',
    '</style></head><body><main class="slide">',
    '<div class="card">hello</div>',
    '</main></body></html>'
  ].join('\n');
  const result = pipeline.convertHtml(html);
  assert.deepEqual(result.errors, []);

  // A pseudo rule used to be stripped to `.card` and win the cascade, so the
  // element inherited the pseudo box: 40px wide, red, and hover-black.
  const element = result.deck.slides[0].elements[0];
  assert.equal(element.type, 'container');
  assert.ok(Math.abs(element.w - 200 / 96) < 0.01, 'pseudo width leaked, w=' + element.w);
  assert.equal(element.background.fill, 'EEEEEE', 'pseudo background leaked');
  assert.equal(element.children[0].text, 'hello');

  const reported = result.report.unsupportedDetails
    .map((entry) => entry.property + '=' + entry.value);
  // ::before is no longer a blind selector: it reports its own reason (here: it
  // is not absolutely positioned), and :hover is still only listed.
  assert.deepEqual(reported.sort(), ['::before=""', 'selector=.card:hover'],
    'pseudo rules must be reported, not silently applied');
});


test('html pipeline keeps table column widths, colspan and rowspan', () => {
  const html = [
    '<html><head><style>',
    '.slide { width: 1280px; height: 720px; }',
    '.grid { position: absolute; left: 40px; top: 40px; width: 900px; font-size: 12px; }',
    '.grid th { background: #183B3A; color: #FFFFFF; }',
    '.grid col.narrow { width: 120px; }',
    '.grid col.wide { width: 60%; }',
    '.plain { position: absolute; left: 40px; top: 320px; width: 600px; font-size: 12px; }',
    '.plain th.a { width: 30%; }',
    '.plain th.b { width: 70%; }',
    '.even { position: absolute; left: 40px; top: 520px; width: 400px; font-size: 12px; }',
    '</style></head><body><main class="slide">',
    '<table class="grid">',
    '<colgroup><col class="narrow"><col class="wide"><col></colgroup>',
    '<thead><tr><th>序号</th><th colspan="2">合并标题</th></tr></thead>',
    '<tbody>',
    '<tr><td>1</td><td>说明</td><td>值</td></tr>',
    '<tr><td rowspan="2">2</td><td>纵向合并</td><td>值</td></tr>',
    '<tr><td>续行</td><td>值</td></tr>',
    '</tbody></table>',
    '<table class="plain"><thead><tr><th class="a">字段</th><th class="b">描述</th></tr></thead>',
    '<tbody><tr><td>A</td><td>B</td></tr></tbody></table>',
    '<table class="even"><tbody><tr><td>A</td><td>B</td><td>C</td></tr></tbody></table>',
    '</main></body></html>'
  ].join('\n');
  const result = pipeline.convertHtml(html);
  assert.deepEqual(result.errors, []);

  const tables = result.deck.slides[0].elements.filter((element) => element.type === 'table');
  assert.equal(tables.length, 3);

  // <colgroup> widths: 120px, 60% of 900px, and a remainder column.
  const grid = tables[0];
  assert.ok(Math.abs(grid.options.colW[0] - 120 / 96) < 0.01, 'first column was ' + grid.options.colW[0]);
  assert.ok(Math.abs(grid.options.colW[1] - 0.6 * 900 / 96) < 0.01, 'second column was ' + grid.options.colW[1]);
  assert.equal(grid.options.colW.length, 3);
  const total = grid.options.colW.reduce((sum, width) => sum + width, 0);
  assert.ok(Math.abs(total - grid.w) < 0.002, 'columns must sum to the table width, got ' + total + ' vs ' + grid.w);

  // Merged cells survive as native colspan/rowspan.
  assert.equal(grid.rows[0][1].options.colspan, 2, 'colspan must reach the table cell');
  const spanned = grid.rows.flat().find((cell) => cell.options.rowspan === 2);
  assert.ok(spanned, 'rowspan must reach the table cell');
  assert.equal(spanned.text, '2');

  // Without <colgroup>, declared first-row cell widths set the proportions.
  const plain = tables[1];
  assert.ok(Math.abs(plain.options.colW[0] / plain.options.colW[1] - 30 / 70) < 0.02,
    'cell widths must give a 30/70 split, got ' + JSON.stringify(plain.options.colW));

  // No declared widths at all: equal columns.
  const even = tables[2];
  assert.deepEqual(even.options.colW.map((width) => Number(width.toFixed(3))),
    even.options.colW.map(() => Number((even.w / 3).toFixed(3))));
});

test('html pipeline turns declared chart data into native chart objects', () => {
  const html = [
    '<html><head><style>',
    '.slide { width: 1280px; height: 720px; }',
    '.stack { position: absolute; left: 40px; top: 40px; width: 800px; height: 300px; }',
    '.single { position: absolute; left: 40px; top: 400px; width: 600px; height: 200px; }',
    '</style></head><body><main class="slide">',
    '<div class="stack"><table data-chart="bar" data-chart-title="季度收入">',
    '<thead><tr><th>季度</th><th>收入</th><th>成本</th></tr></thead>',
    '<tbody>',
    '<tr><td>Q1</td><td>120</td><td>80</td></tr>',
    '<tr><td>Q2</td><td>160</td><td>95</td></tr>',
    '</tbody></table></div>',
    '<div class="single" data-chart="line" data-labels="一月,二月,三月" data-values="12,18,25"></div>',
    '</main></body></html>'
  ].join('\n');
  const result = pipeline.convertHtml(html);
  assert.deepEqual(result.errors, []);
  assert.equal(result.report.charts, 2);
  assert.equal(result.report.tables, 0, 'a chart table must not also become a table');

  const charts = [];
  const walk = (elements) => elements.forEach((element) => {
    if (element.type === 'chart') charts.push(element);
    if (element.children) walk(element.children);
  });
  walk(result.deck.slides[0].elements);
  assert.equal(charts.length, 2);

  const bar = charts.find((element) => element.chartType === 'bar');
  assert.ok(bar, 'the table must become a bar chart');
  assert.equal(bar.data.length, 2, 'one series per numeric column');
  assert.deepEqual(bar.data[0].labels, ['Q1', 'Q2']);
  assert.deepEqual(bar.data[0].values, [120, 160]);
  assert.equal(bar.data[1].name, '成本');
  assert.equal(bar.options.showLegend, true, 'two series need a legend');
  assert.equal(bar.options.title, '季度收入');
  // The chart fills the height its parent declared, not width*0.5.
  assert.ok(Math.abs(bar.h - 300 / 96) < 0.01, 'chart height was ' + bar.h);

  const line = charts.find((element) => element.chartType === 'line');
  assert.ok(line, 'data-values must become a line chart');
  assert.equal(line.data.length, 1);
  assert.deepEqual(line.data[0].values, [12, 18, 25]);
  assert.deepEqual(line.data[0].labels, ['一月', '二月', '三月']);
  assert.equal(line.options.showLegend, false, 'a single series needs no legend');
});

test('html pipeline reports an unusable chart declaration instead of dropping it', () => {
  const html = [
    '<html><head><style>.slide { width: 1280px; height: 720px; }</style></head>',
    '<body><main class="slide">',
    '<div data-chart="sankey" data-values="1,2,3"></div>',
    '<div data-chart="bar"></div>',
    '</main></body></html>'
  ].join('\n');
  const result = pipeline.convertHtml(html);
  const properties = result.report.unsupportedDetails.map((entry) => entry.property);
  assert.deepEqual(properties, ['data-chart', 'data-chart']);
  assert.equal(result.report.charts, 0);
  assert.equal(result.deck.slides[0].elements.filter((element) => element.type === 'chart').length, 0);
});

test('html pipeline resolves absolute offsets against the padding box', () => {
  const html = [
    '<html><head><style>',
    '.slide { position: relative; width: 1280px; height: 720px; padding: 40px; background: #FFFFFF; }',
    '.pin { position: absolute; left: 0; top: 0; width: 100px; height: 40px; background: #EEEEEE; }',
    '.inner { position: absolute; right: 0; bottom: 0; width: 100px; height: 40px; background: #DDDDDD; }',
    '</style></head><body><main class="slide">',
    '<div class="pin"></div><div class="inner"></div>',
    '</main></body></html>'
  ].join('\n');
  const result = pipeline.convertHtml(html);
  const elements = result.deck.slides[0].elements;

  // CSS: the containing block is the slide's padding box, so left/top 0 is the
  // slide edge, not the content box 40px inside it.
  const pin = elements.find((element) => element.fill === 'EEEEEE');
  assert.ok(pin, 'the pinned box must exist');
  assert.ok(Math.abs(pin.x) < 0.001, 'left:0 must be the slide edge, x was ' + pin.x);
  assert.ok(Math.abs(pin.y) < 0.001, 'top:0 must be the slide edge, y was ' + pin.y);

  const inner = elements.find((element) => element.fill === 'DDDDDD');
  assert.ok(inner, 'the bottom-right box must exist');
  assert.ok(Math.abs(inner.x + inner.w - 13.333) < 0.01, 'right:0 must sit at the slide edge, x+w was ' + (inner.x + inner.w));
  assert.ok(Math.abs(inner.y + inner.h - 7.5) < 0.01, 'bottom:0 must sit at the slide edge, y+h was ' + (inner.y + inner.h));
});


test('html pipeline finds chart data inside a wrapper element', () => {
  const html = [
    '<html><head><style>.slide { width: 1280px; height: 720px; }</style></head>',
    '<body><main class="slide">',
    '<div class="card" data-chart="doughnut" style="width: 600px; height: 320px;">',
    '  <table><thead><tr><th>来源</th><th>占比</th></tr></thead>',
    '  <tbody><tr><td>订阅</td><td>52</td></tr><tr><td>服务</td><td>28</td></tr></tbody></table>',
    '</div>',
    '</main></body></html>'
  ].join('\n');
  const result = pipeline.convertHtml(html);
  assert.deepEqual(result.errors, []);
  assert.equal(result.report.charts, 1, 'the nested table must feed the chart');
  assert.equal(result.report.tables, 0, 'it must not also be emitted as a table');

  const charts = [];
  const walk = (elements) => elements.forEach((element) => {
    if (element.type === 'chart') charts.push(element);
    if (element.children) walk(element.children);
  });
  walk(result.deck.slides[0].elements);
  assert.equal(charts.length, 1);
  assert.equal(charts[0].chartType, 'doughnut');
  assert.deepEqual(charts[0].data[0].values, [52, 28]);
  // The wrapper declares the height, so the chart must not fall back to width*0.5.
  assert.ok(Math.abs(charts[0].h - 320 / 96) < 0.02, 'chart height was ' + charts[0].h);
});


test('html pipeline honours align-self per child in rows and columns', () => {
  const html = [
    '<html><head><style>',
    '.slide { width: 1280px; height: 720px; }',
    '.row { position: absolute; left: 40px; top: 40px; width: 900px; display: flex; gap: 20px; align-items: stretch; }',
    '.card { background: #EEEEEE; padding: 16px; font-size: 13px; }',
    '.card.tall { height: 200px; }',
    '.card.mid { align-self: center; height: 80px; }',
    '.card.low { align-self: flex-end; height: 60px; }',
    '.col { position: absolute; left: 40px; top: 400px; width: 600px; display: flex; flex-direction: column; gap: 12px; }',
    '.col .a { background: #DDDDDD; height: 60px; }',
    '.col .b { background: #CCCCCC; height: 60px; width: 200px; align-self: center; }',
    '.col .c { background: #BBBBBB; height: 60px; width: 240px; align-self: flex-end; }',
    '</style></head><body><main class="slide">',
    '<div class="row"><div class="card tall">高</div><div class="card mid">中</div><div class="card low">低</div></div>',
    '<div class="col"><div class="a">A</div><div class="b">B</div><div class="c">C</div></div>',
    '</main></body></html>'
  ].join('\n');
  const result = pipeline.convertHtml(html);
  assert.deepEqual(result.errors, []);
  // align-self is translated now, so it must not be reported as unsupported.
  assert.equal(result.report.unsupportedDetails.filter((entry) => entry.property === 'alignSelf').length, 0);

  const containers = result.deck.slides[0].elements.filter((element) => element.type === 'container');
  const row = containers.find((element) => element.direction === 'row');
  assert.ok(row, 'the flex row must stay declarative');
  assert.equal(row.children.length, 3);
  assert.deepEqual(row.children.map((child) => child.alignSelf), [undefined, 'center', 'end']);
  // A stretching child keeps the row height; an aligned child keeps its own.
  assert.ok(Math.abs(row.children[1].h - 80 / 96) < 0.01, 'center child height was ' + row.children[1].h);
  assert.ok(Math.abs(row.children[2].h - 60 / 96) < 0.01, 'end child height was ' + row.children[2].h);

  const column = containers.find((element) => element.direction === 'column');
  assert.ok(column, 'the flex column must stay declarative');
  assert.deepEqual(column.children.map((child) => child.alignSelf), [undefined, 'center', 'end']);
  assert.ok(Math.abs(column.children[1].w - 200 / 96) < 0.01, 'center child width was ' + column.children[1].w);
  assert.ok(Math.abs(column.children[2].w - 240 / 96) < 0.01, 'end child width was ' + column.children[2].w);

  // The engine must re-resolve the same boxes, or the group would have to fall back.
  assert.equal(result.report.containerFallbacks.length, 0);
  assert.ok(result.report.maxBoxDelta < 0.012, 'engine/analyzer delta was ' + result.report.maxBoxDelta);
});


test('html pipeline applies CSS order inside flex and grid', () => {
  const html = [
    '<html><head><style>',
    '.slide { width: 1280px; height: 720px; }',
    '.row { position: absolute; left: 40px; top: 40px; width: 900px; display: flex; gap: 20px; }',
    '.card { background: #EEEEEE; padding: 12px; font-size: 13px; }',
    '.card.first { order: 2; }',
    '.card.second { order: 1; }',
    '.card.third { order: 3; }',
    '.grid { position: absolute; left: 40px; top: 300px; width: 900px; display: grid; grid-template-columns: repeat(3, 1fr); gap: 16px; }',
    '.grid .g { background: #DDDDDD; padding: 10px; font-size: 12px; }',
    '.grid .g.a { order: 3; }',
    '.grid .g.b { order: 1; }',
    '.grid .g.c { order: 2; }',
    '</style></head><body><main class="slide">',
    '<div class="row"><div class="card first">一</div><div class="card second">二</div><div class="card third">三</div></div>',
    '<div class="grid"><div class="g a">A</div><div class="g b">B</div><div class="g c">C</div></div>',
    '</main></body></html>'
  ].join('\n');
  const result = pipeline.convertHtml(html);
  assert.deepEqual(result.errors, []);
  assert.equal(result.report.unsupportedDetails.filter((entry) => entry.property === 'order').length, 0);

  const textOf = (element) => {
    if (typeof element.text === 'string' && element.text) return element.text;
    return (element.children || []).map(textOf).join('');
  };
  const containers = result.deck.slides[0].elements.filter((element) => element.type === 'container');
  const row = containers.find((element) => element.direction === 'row');
  const grid = containers.find((element) => element.columns > 1);
  assert.ok(row && grid, 'both groups must stay declarative');
  assert.deepEqual(row.children.map(textOf), ['二', '一', '三'], 'flex items follow order');
  assert.deepEqual(grid.children.map(textOf), ['B', 'C', 'A'], 'grid items follow order');
  assert.equal(result.report.containerFallbacks.length, 0);
});


test('html pipeline maps transform: rotate() to native shape rotation', () => {
  const html = [
    '<html><head><style>',
    '.slide { width: 1280px; height: 720px; background: #F4F6F6; }',
    '.watermark { position: absolute; left: 300px; top: 300px; width: 400px; height: 60px;',
    '  font-size: 28px; color: #B0B8B8; transform: rotate(-12deg); }',
    '.quarter { position: absolute; left: 600px; top: 500px; width: 100px; height: 40px;',
    '  background: #CCCCCC; transform: rotate(0.25turn); }',
    '.scaled { position: absolute; left: 100px; top: 100px; width: 100px; height: 40px;',
    '  background: #DDDDDD; transform: scale(1.5) rotate(10deg); }',
    '.flat { position: absolute; left: 100px; top: 600px; width: 100px; height: 40px;',
    '  background: #EEEEEE; transform: rotate(0deg); }',
    '.group { position: absolute; left: 100px; top: 400px; width: 300px; height: 120px;',
    '  background: #FFFFFF; padding: 16px; transform: rotate(4deg); }',
    '</style></head><body><main class="slide">',
    '<div class="watermark">内部评审稿</div>',
    '<div class="quarter"></div>',
    '<div class="scaled"></div>',
    '<div class="flat"></div>',
    '<div class="group"><p>卡片组旋转</p></div>',
    '</main></body></html>'
  ].join('\n');
  const result = pipeline.convertHtml(html);
  assert.deepEqual(result.errors, []);

  const elements = result.deck.slides[0].elements;
  const rotated = elements.filter((element) => element.rotate !== undefined);
  const watermark = rotated.find((element) => typeof element.text === 'string');
  assert.ok(watermark, 'the rotated text must carry a rotation');
  assert.equal(watermark.rotate, -12);
  // Grads/turns are converted to degrees; 0.25turn is a quarter turn.
  const quarter = rotated.find((element) => element.rotate === 90);
  assert.ok(quarter, 'rotate(0.25turn) must become 90 degrees');

  // A uniform scale is native now: the box grows about its centre and so does its type, so a
  // `scale(1.5) rotate(10deg)` box carries both and reports neither.
  const transformReports = result.report.unsupportedDetails.filter((entry) => entry.property === 'transform');
  assert.deepEqual(transformReports.map((entry) => entry.value), [], 'nothing to name: ' + JSON.stringify(transformReports));
  const spun = elements.filter((element) => element.rotate === 10);
  assert.equal(spun.length, 1, 'the rotation lands');
  // 100x40 at (100,100) about its centre, scaled by 1.5: 150x60 at (75,90).
  assert.ok(Math.abs(spun[0].w * 96 - 150) < 0.5, 'scaled width: ' + (spun[0].w * 96).toFixed(2));
  assert.ok(Math.abs(spun[0].h * 96 - 60) < 0.5, 'scaled height: ' + (spun[0].h * 96).toFixed(2));
  assert.ok(Math.abs(spun[0].x * 96 - 75) < 0.5, 'scaled x: ' + (spun[0].x * 96).toFixed(2));

  // rotate(0deg) is a no-op, not a rotation.
  const flat = elements.filter((element) => element.rotate === 0);
  assert.equal(flat.length, 0, 'a zero rotation must not be emitted');

  // A container cannot carry a rotation: it is counted and reported, not dropped.
  assert.equal(result.report.rotatedGroups, 1);
});


test('html pipeline resolves fractional and fixed grid tracks', () => {
  const html = [
    '<html><head><style>',
    '.slide { width: 1280px; height: 720px; }',
    '.split { position: absolute; left: 40px; top: 40px; width: 900px; display: grid;',
    '  grid-template-columns: 2fr 1fr; gap: 20px; }',
    '.mixed { position: absolute; left: 40px; top: 220px; width: 900px; display: grid;',
    '  grid-template-columns: 200px 1fr 2fr; gap: 16px; }',
    '.pct { position: absolute; left: 40px; top: 520px; width: 900px; display: grid;',
    '  grid-template-columns: 30% 70%; gap: 10px; }',
    '.item { background: #EEEEEE; font-size: 12px; height: 60px; }',
    '</style></head><body><main class="slide">',
    '<div class="split"><div class="item">A</div><div class="item">B</div></div>',
    '<div class="mixed"><div class="item">A</div><div class="item">B</div><div class="item">C</div></div>',
    '<div class="pct"><div class="item">A</div><div class="item">B</div></div>',
    '</main></body></html>'
  ].join('\n');
  const result = pipeline.convertHtml(html);
  assert.deepEqual(result.errors, []);
  const grids = result.deck.slides[0].elements.filter((element) => element.type === 'container');
  assert.equal(grids.length, 3, 'every grid must stay declarative');
  assert.equal(result.report.containerFallbacks.length, 0);
  assert.ok(result.report.maxBoxDelta < 0.012, 'delta was ' + result.report.maxBoxDelta);

  const byTracks = (tracks) => grids.find((grid) => JSON.stringify(grid.columnTracks) === JSON.stringify(tracks));

  // 2fr 1fr: fractions are kept as weights, not baked into inches.
  const halves = byTracks([{ fr: 2 }, { fr: 1 }]);
  assert.ok(halves, 'grid-template-columns: 2fr 1fr must keep its weights');

  // 200px 1fr 2fr: the fixed track is in inches, the rest stay fractional.
  const mixed = grids.find((grid) => Array.isArray(grid.columnTracks)
    && grid.columnTracks.length === 3 && grid.columnTracks[0].width !== undefined);
  assert.ok(mixed, 'a fixed track must be emitted as a width');
  assert.ok(Math.abs(mixed.columnTracks[0].width - 200 / 96) < 0.01,
    'fixed track was ' + mixed.columnTracks[0].width);
  assert.deepEqual(mixed.columnTracks.slice(1), [{ fr: 1 }, { fr: 2 }]);

  // 30% 70% resolves against the grid's own content width.
  const percent = grids.find((grid) => Array.isArray(grid.columnTracks)
    && grid.columnTracks.length === 2 && grid.columnTracks[1].width > 5);
  assert.ok(percent, 'percentage tracks must become widths');
  assert.ok(Math.abs(percent.columnTracks[0].width - 0.3 * 9.375) < 0.01,
    '30% track was ' + percent.columnTracks[0].width);

  // Track widths plus gaps must fill the container.
  mixed.columnTracks.forEach((track) => assert.ok(track.fr === undefined || track.fr > 0));
});


test('html pipeline gives pie and doughnut charts a legend and percentages', () => {
  const html = [
    '<html><head><style>.slide { width: 1280px; height: 720px; }</style></head>',
    '<body><main class="slide">',
    '<div style="width: 500px; height: 300px;" data-chart="doughnut">',
    '  <table><thead><tr><th>来源</th><th>占比</th></tr></thead>',
    '  <tbody><tr><td>订阅</td><td>52</td></tr><tr><td>服务</td><td>28</td></tr></tbody></table>',
    '</div>',
    '<div style="width: 500px; height: 300px;" data-chart="line" data-values="1,2,3"></div>',
    '</main></body></html>'
  ].join('\n');
  const result = pipeline.convertHtml(html);
  const charts = [];
  const walk = (elements) => elements.forEach((element) => {
    if (element.type === 'chart') charts.push(element);
    if (element.children) walk(element.children);
  });
  walk(result.deck.slides[0].elements);

  // A share chart with one series still needs named slices.
  const doughnut = charts.find((chart) => chart.chartType === 'doughnut');
  assert.ok(doughnut);
  assert.equal(doughnut.options.showLegend, true);
  assert.equal(doughnut.options.showPercent, true);

  // A single-series line chart stays clean.
  const line = charts.find((chart) => chart.chartType === 'line');
  assert.ok(line);
  assert.equal(line.options.showLegend, false);
  assert.equal(line.options.showPercent, undefined);
});


test('html pipeline resolves @media blocks against the slide viewport', () => {
  const html = [
    '<html><head><style>',
    '@media (min-width: 900px) {',
    '  .slide { width: 1280px; height: 720px; background: #0E1A1D; }',
    '  .title { position: absolute; left: 40px; top: 40px; width: 700px; font-size: 34px; color: #F2A24C; }',
    '}',
    '@media (max-width: 600px) {',
    '  .title { font-size: 14px; color: #FF0000; }',
    '}',
    '@media print { .title { display: none; } }',
    '</style></head><body><main class="slide"><h1 class="title">桌面标题</h1></main></body></html>'
  ].join('\n');
  const result = pipeline.convertHtml(html);
  assert.deepEqual(result.errors, []);

  const title = result.deck.slides[0].elements.find((element) => typeof element.text === 'string');
  assert.ok(title, 'the title must survive a media-query-only stylesheet');
  // 34px inside the matching min-width block → 25.5pt, not the 14px mobile rule.
  assert.equal(title.fontSize, 25.5, 'font size came from ' + title.fontSize);
  assert.equal(title.color, 'F2A24C');
  assert.ok(Math.abs(title.x - 40 / 96) < 0.01);
  // `top: 40px` plus the UA h1 margin, because a margin offsets an absolutely positioned box
  // too. The UA margin is 0.67em of the element's *own* 34px, which is what Chrome measures:
  // 62.77px. The engine lands on 62.78.
  assert.ok(Math.abs(title.y - (40 + 0.67 * 34) / 96) < 0.01, 'title y=' + title.y);

  // A query that cannot match the 1280x720 slide is reported, not silently lost.
  const reported = result.report.unsupportedDetails
    .filter((entry) => entry.property === '@media')
    .map((entry) => entry.value);
  assert.deepEqual(reported, ['(max-width: 600px)', 'print']);
  assert.ok(result.report.notes.some((note) => note.includes('@media block(s) applied at 1280x720')),
    'the applied count must be reported: ' + JSON.stringify(result.report.notes));
});


const DECORATION_HTML = [
  '<html><head><style>',
  '  .slide { position: relative; width: 1280px; height: 720px; background: #0F1C20; }',
  '  .card {',
  '    position: absolute; left: 60px; top: 80px; width: 460px; height: 180px;',
  '    background: #FFFFFF; border-radius: 14px; padding: 24px 28px;',
  '    display: flex; flex-direction: column; gap: 10px;',
  '  }',
  '  .card::before {',
  '    content: ""; position: absolute; left: 0; top: 18px; width: 6px; height: 60px;',
  '    background: #F2A24C; border-radius: 3px;',
  '  }',
  '  .card::after {',
  '    content: "\\2192"; position: absolute; right: 18px; bottom: 14px;',
  '    width: 40px; height: 30px; color: #0F1C20; font-size: 22px; text-align: center;',
  '  }',
  '  .card h3 { font-size: 20px; color: #16262B; }',
  '  .card p { font-size: 13px; color: #5B6B70; }',
  '  .badge { position: absolute; right: 40px; bottom: 40px; font-size: 12px; color: #9FB0B4; }',
  '</style></head><body><main class="slide">',
  '  <div class="card">',
  '    <h3>带装饰的卡片</h3>',
  '    <p>装饰条和箭头来自伪元素。</p>',
  '  </div>',
  '  <p class="badge">NATIVE</p>',
  '</main></body></html>'
].join('\n');

test('html pipeline turns ::before and ::after into container overlays', () => {
  const result = pipeline.convertHtml(DECORATION_HTML);
  assert.deepEqual(result.errors, []);
  const card = result.deck.slides[0].elements
    .find((element) => element.type === 'container' && element.overlays && element.overlays.length);
  assert.ok(card, 'the card must stay a declarative container carrying overlays');

  const bar = card.overlays.find((overlay) => overlay.fill === 'F2A24C');
  assert.ok(bar, 'the ::before accent bar must be an overlay');
  // left: 0, top: 18px, 6px wide, 60px tall, 3px radius.
  assert.ok(Math.abs(bar.x - 0) < 0.001);
  assert.ok(Math.abs(bar.y - 18 / 96) < 0.01, 'y=' + bar.y);
  assert.ok(Math.abs(bar.w - 6 / 96) < 0.001, 'w=' + bar.w);
  assert.ok(Math.abs(bar.h - 60 / 96) < 0.001, 'h=' + bar.h);
  assert.ok(Math.abs(bar.radius - 3 / 96) < 0.002, 'radius=' + bar.radius);

  // content is decoded, so CSS escapes become real characters.
  const arrow = card.overlays.find((overlay) => overlay.text === '\u2192');
  assert.ok(arrow, 'the ::after content must decode to an arrow: '
    + JSON.stringify(card.overlays.map((overlay) => overlay.text)));
  assert.equal(arrow.color, '0F1C20');
  assert.equal(arrow.fontSize, 16.5);

  // The engine emits both decorations as real shapes/text.
  const { layoutSlide } = require('../native/engine/layout');
  const laid = layoutSlide(result.deck.slides[0], { width: 13.333, height: 7.5 }, result.deck.theme || {}, {});
  const elements = Array.isArray(laid) ? laid : (laid.elements || []);
  assert.ok(elements.some((element) => element.fill === 'F2A24C'), 'the accent bar must be emitted');
  assert.ok(elements.some((element) => element.text === '\u2192'), 'the arrow must be emitted');
  assert.equal(result.report.droppedDecorations, 0);
});

test('html pipeline reports decorations it cannot place instead of dropping them', () => {
  const html = [
    '<html><head><style>',
    '  .slide { position: relative; width: 1280px; height: 720px; }',
    '  .card { position: absolute; left: 20px; top: 20px; width: 400px; height: 200px; }',
    // No width/height: the box is auto-sized, which is not measured for decorations.
    '  .card::before { content: ""; position: absolute; left: 10px; top: 10px; background: #F2A24C; }',
    '</style></head><body><main class="slide">',
    '<div class="card"><div>正文</div></div>',
    '</main></body></html>'
  ].join('\n');
  const result = pipeline.convertHtml(html);
  const reported = result.report.unsupportedDetails.filter((entry) => entry.property === '::before');
  assert.equal(reported.length, 1, JSON.stringify(result.report.unsupportedDetails));
  assert.match(reported[0].reason, /definite width and height/u);
});

test('html pipeline anchors right/bottom absolute children inside a flex column', () => {
  const html = [
    '<html><head><style>',
    '  .slide { position: relative; width: 1280px; height: 720px; display: flex;',
    '    flex-direction: column; gap: 20px; padding: 64px; }',
    '  h1 { font-size: 40px; }',
    '  .stamp { position: absolute; right: 72px; bottom: 56px; font-size: 12px; }',
    '</style></head><body><main class="slide"><h1>标题</h1>',
    '<p class="stamp">NATIVE DECORATIONS</p></main></body></html>'
  ].join('\n');
  const result = pipeline.convertHtml(html);
  const stamp = result.deck.slides[0].elements.find((element) => element.text === 'NATIVE DECORATIONS');
  assert.ok(stamp, 'the stamp must survive absolute positioning inside a flex column');
  // CSS anchors an absolute child to the padding box of its containing block, which
  // excludes the border and not the padding, so the 64px padding is not subtracted
  // from a right/bottom offset: 72px means 72px from the slide edge.
  const rightEdge = stamp.x + stamp.w;
  assert.ok(Math.abs(rightEdge - (13.333 - 72 / 96)) < 0.02,
    'right edge ' + rightEdge.toFixed(3));
  const bottomEdge = stamp.y + stamp.h;
  assert.ok(Math.abs(bottomEdge - (7.5 - 56 / 96)) < 0.02,
    'bottom edge ' + bottomEdge.toFixed(3));
  // A shrink-to-fit box: the measured width is far narrower than the container.
  assert.ok(stamp.w < 6, 'the box must hug its text, got ' + stamp.w);
});


test('html pipeline honours flex-grow and flex-basis longhands', () => {
  const html = [
    '<html><head><style>',
    '  .slide { position: relative; width: 1280px; height: 720px; display: flex;',
    '    flex-direction: row; gap: 20px; padding: 40px; }',
    '  .a { flex-basis: 200px; }',
    '  .b { flex-grow: 3; }',
    '  .c { flex-grow: 1; }',
    '</style></head><body><main class="slide">',
    '<div class="a"><div>a</div></div><div class="b"><div>b</div></div><div class="c"><div>c</div></div>',
    '</main></body></html>'
  ].join('\n');
  const result = pipeline.convertHtml(html);
  const [first, second, third] = result.deck.slides[0].elements;

  // flex-basis wins over the default flex: 1 sharing.
  assert.ok(Math.abs(first.w - 200 / 96) < 0.01, 'first width ' + first.w);
  // 1280 - 80 padding - 40 gaps - 200 basis = 960px, split 3:1.
  assert.ok(Math.abs(second.w - (960 * 0.75) / 96) < 0.02, 'second width ' + second.w);
  assert.ok(Math.abs(third.w - (960 * 0.25) / 96) < 0.02, 'third width ' + third.w);
  assert.equal(result.report.unsupportedDetails.length, 0);
});


test('html pipeline spans grid tracks with grid-column and grid-row', () => {
  const html = [
    '<html><head><style>',
    '  .slide { position: relative; width: 1280px; height: 720px; padding: 60px; }',
    '  .grid { display: grid; grid-template-columns: 1fr 1fr 1fr; gap: 20px; width: 1160px; }',
    '  .cell { background: #F7F9F9; padding: 18px; }',
    '  .wide { grid-column: span 2; background: #F2A24C; }',
    '  .tall { grid-row: span 2; background: #2FA8A0; }',
    '</style></head><body><main class="slide">',
    '<div class="grid">',
    '  <div class="cell wide"><div>宽</div></div>',
    '  <div class="cell tall"><div>高</div></div>',
    '  <div class="cell"><div>C</div></div>',
    '  <div class="cell"><div>D</div></div>',
    '  <div class="cell wide"><div>E</div></div>',
    '  <div class="cell"><div>F</div></div>',
    '</div></main></body></html>'
  ].join('\n');
  const result = pipeline.convertHtml(html);
  assert.deepEqual(result.errors, []);

  const grid = result.deck.slides[0].elements.find((element) => element.type === 'container');
  assert.ok(grid, 'the grid must stay a declarative container');
  const track = (1160 - 2 * 20) / 3 / 96; // (content 1160px - two gaps) / 3 tracks
  assert.ok(Math.abs(grid.children[0].columnSpan - 2) < 0.0001);
  assert.ok(Math.abs(grid.children[1].rowSpan - 2) < 0.0001);

  // Wide item spans two tracks plus the gap between them.
  const wide = grid.children[0];
  assert.equal(wide.w, undefined, 'a stretched grid item must not bake a width');
  const tall = grid.children[1];

  const { layoutSlide } = require('../native/engine/layout');
  const laid = layoutSlide(result.deck.slides[0], { width: 13.333, height: 7.5 }, result.deck.theme || {}, {});
  const elements = Array.isArray(laid) ? laid : (laid.elements || []);
  const shapes = elements.filter((element) => element.fill === 'F7F9F9' || element.fill === 'F2A24C' || element.fill === '2FA8A0');
  assert.ok(shapes.length >= 6, 'every cell surface must be emitted, got ' + shapes.length);

  const firstWide = shapes[0];
  assert.ok(Math.abs(firstWide.w - (track * 2 + 20 / 96)) < 0.02,
    'wide cell width ' + firstWide.w + ' expected ' + (track * 2 + 20 / 96));
  const tallCell = shapes.find((element) => element.fill === '2FA8A0');
  assert.ok(tallCell, 'the row-spanning cell must be emitted');
  assert.ok(Math.abs(tallCell.x - (0.625 + 2 * (track + 20 / 96))) < 0.02,
    'row-spanning cell x ' + tallCell.x);
  // Two single-line rows plus the gap: the span is one box, so it is roughly twice\n  // a single row. The exact value follows from the text line box, not from padding.\n  assert.ok(tallCell.h > 1.25, 'a two-row cell must be taller than one row: ' + tallCell.h);
  // Nothing was guessed: no unsupported entries and no absolute fallbacks.
  assert.equal(result.report.unsupportedDetails.length, 0,
    JSON.stringify(result.report.unsupportedDetails));
  assert.deepEqual(result.report.containerFallbacks, []);
});

test('html pipeline places an item on the grid line it names', () => {
  const build = (decl) => pipeline.convertHtml([
    '<html><head><style>',
    '  .slide { width: 1280px; height: 720px; padding: 40px; }',
    '  .grid { display: grid; grid-template-columns: 1fr 1fr; gap: 0; width: 1000px; }',
    '  .a { ' + decl + ' }',
    '</style></head><body><main class="slide">',
    '<div class="grid"><div class="a">x</div><div class="b">y</div></div>',
    '</main></body></html>'
  ].join('\n'));
  const boxes = (result) => {
    const grid = result.analysis.slides[0].nodes.find((node) => (node.classes || []).includes('grid'));
    return { grid, a: grid.children[0], b: grid.children[1] };
  };

  // `2 / 4` starts on the second column; the span is clamped to the two tracks there.
  const named = build('grid-column: 2 / 4');
  assert.deepEqual(named.report.unsupportedDetails, [], 'an explicit line is translated, not reported');
  const first = boxes(named);
  assert.ok(Math.abs(first.a.x - (first.grid.x + 500 / 96)) < 0.01, 'starts on column 2: ' + first.a.x);
  assert.ok(Math.abs(first.b.x - first.grid.x) < 0.01, 'the auto item takes the free column: ' + first.b.x);

  // The same placement written as the longhands.
  const longhands = build('grid-column-start: 2; grid-column-end: 3');
  assert.deepEqual(longhands.report.unsupportedDetails, []);
  assert.ok(Math.abs(boxes(longhands).a.x - (boxes(longhands).grid.x + 500 / 96)) < 0.01);

  // `span` on the end line, and a negative line counted back from the last one.
  const spanned = build('grid-column: 1 / span 2');
  assert.ok(Math.abs(boxes(spanned).a.w - 1000 / 96) < 0.01, 'span two columns: ' + boxes(spanned).a.w);
  const negative = build('grid-column: -2 / -1');
  assert.deepEqual(negative.report.unsupportedDetails, []);
  assert.ok(Math.abs(boxes(negative).a.x - (boxes(negative).grid.x + 500 / 96)) < 0.01,
    '-2 / -1 is the last column: ' + boxes(negative).a.x);

  // `grid-area` is the four-value shorthand, row-start / column-start / row-end / column-end.
  const area = build('grid-area: 1 / 2 / 2 / 3');
  assert.deepEqual(area.report.unsupportedDetails, []);
  assert.ok(Math.abs(boxes(area).a.x - (boxes(area).grid.x + 500 / 96)) < 0.01, 'area column: ' + boxes(area).a.x);

  // A bare name is a named area, which needs grid-template-areas: that is reported.
  const namedArea = build('grid-area: hero');
  const reported = namedArea.report.unsupportedDetails.filter((entry) => entry.property === 'gridColumn');
  assert.equal(reported.length, 1, JSON.stringify(namedArea.report.unsupportedDetails));
  assert.match(reported[0].reason, /Named grid lines/u);
});


test('the gap shorthand splits into row and column gap', () => {
  // `gap: 10px 30px` used to be dropped silently, collapsing the spacing to zero.
  const column = pipeline.convertHtml([
    '<html><head><style>',
    '  .slide { width: 1280px; height: 720px; padding: 40px; display: flex;',
    '    flex-direction: column; gap: 10px 30px; }',
    '  .cell { background: #DDDDDD; height: 100px; }',
    '</style></head><body><main class="slide">',
    '<div class="cell"><div>a</div></div><div class="cell"><div>b</div></div>',
    '</main></body></html>'
  ].join('\n'));
  const cells = column.deck.slides[0].elements.filter((element) => element.type === 'container');
  assert.equal(cells.length, 2);
  // A column flex stacks along the row axis, so the row gap (10px) applies.
  assert.ok(Math.abs((cells[1].y - (cells[0].y + 100 / 96)) - 10 / 96) < 0.002,
    'row gap ' + (cells[1].y - (cells[0].y + 100 / 96)));
  assert.deepEqual(column.report.unsupportedDetails, []);

  const grid = pipeline.convertHtml([
    '<html><head><style>',
    '  .slide { width: 1280px; height: 720px; padding: 40px; display: grid;',
    '    grid-template-columns: 1fr 1fr; gap: 20px 40px; }',
    '  .cell { background: #EEEEEE; height: 100px; }',
    '</style></head><body><main class="slide">',
    '<div class="cell"><div>a</div></div><div class="cell"><div>b</div></div>',
    '<div class="cell"><div>c</div></div>',
    '</main></body></html>'
  ].join('\n'));
  const boxes = grid.deck.slides[0].elements;
  // 1280 - 80 padding = 1200px, minus a 40px column gap, split in two.
  assert.ok(Math.abs(boxes[0].w - (1200 - 40) / 2 / 96) < 0.01, 'column width ' + boxes[0].w);
  assert.ok(Math.abs(boxes[1].x - (boxes[0].x + boxes[0].w + 40 / 96)) < 0.01, 'column gap ' + boxes[1].x);
  // The third cell wraps below the row: 100px cell + 20px row gap.
  assert.ok(Math.abs(boxes[2].y - (boxes[0].y + 100 / 96 + 20 / 96)) < 0.01, 'row gap ' + boxes[2].y);
});

test('a slide root declared as a grid lays its children out in columns', () => {
  // The root dispatch used to pass the wrong arguments, so a grid slide silently
  // became a single column.
  const result = pipeline.convertHtml([
    '<html><head><style>',
    '  .slide { position: relative; width: 1280px; height: 720px; padding: 40px;',
    '    display: grid; grid-template-columns: 1fr 1fr 1fr; gap: 20px; }',
    '  .cell { background: #EEEEEE; height: 100px; }',
    '</style></head><body><main class="slide">',
    '<div class="cell"><div>a</div></div><div class="cell"><div>b</div></div>',
    '<div class="cell"><div>c</div></div><div class="cell"><div>d</div></div>',
    '</main></body></html>'
  ].join('\n'));
  const boxes = result.deck.slides[0].elements;
  assert.equal(boxes.length, 4);
  const xs = new Set(boxes.slice(0, 3).map((element) => Math.round(element.x * 100)));
  assert.equal(xs.size, 3, 'the three cells must sit in three columns');
  assert.ok(Math.abs(boxes[3].x - boxes[0].x) < 0.001, 'the fourth cell wraps to column one');
  assert.ok(boxes[3].y > boxes[0].y + 0.5, 'the fourth cell wraps to a new row');
});


test('grid-template-rows pins rows and gives fr the leftover height', () => {
  const html = [
    '<html><head><style>',
    '  .slide { position: relative; width: 1280px; height: 720px; padding: 40px; }',
    '  .board { display: grid; width: 1200px; height: 600px;',
    '    grid-template-columns: 1fr 1fr; grid-template-rows: 120px 1fr auto; gap: 20px; }',
    '  .cell { background: #EEEEEE; padding: 10px; }',
    '</style></head><body><main class="slide">',
    '<div class="board">',
    '  <div class="cell"><div>r0c0</div></div><div class="cell"><div>r0c1</div></div>',
    '  <div class="cell"><div>r1c0</div></div><div class="cell"><div>r1c1</div></div>',
    '  <div class="cell"><div>r2c0</div></div><div class="cell"><div>r2c1</div></div>',
    '  <div class="cell"><div>r3c0</div></div><div class="cell"><div>r3c1</div></div>',
    '</div></main></body></html>'
  ].join('\n');
  const result = pipeline.convertHtml(html);
  assert.deepEqual(result.errors, []);
  assert.deepEqual(result.report.unsupportedDetails, []);

  const board = result.deck.slides[0].elements.find((element) => element.type === 'container');
  assert.equal(board.rowTracks.length, 3);
  assert.ok(Math.abs(board.rowTracks[0].height - 120 / 96) < 0.001, JSON.stringify(board.rowTracks[0]));
  assert.equal(board.rowTracks[1].fr, 1);
  assert.equal(board.rowTracks[2].auto, true);
  assert.ok(Math.abs(board.rowContentHeight - 600 / 96) < 0.001);

  const { layoutSlide } = require('../native/engine/layout');
  const laid = layoutSlide(result.deck.slides[0], { width: 13.333, height: 7.5 }, result.deck.theme || {}, {});
  const surfaces = (Array.isArray(laid) ? laid : laid.elements)
    .filter((element) => element.type === 'shape' && element.fill === 'EEEEEE');
  assert.equal(surfaces.length, 8);
  // Row 0 is exactly the declared 120px.
  assert.ok(Math.abs(surfaces[0].h - 120 / 96) < 0.002, 'row 0 height ' + surfaces[0].h);
  // The fr row absorbs what the fixed, auto and implicit rows leave.
  const rowTops = [...new Set(surfaces.map((element) => Number(element.y.toFixed(3))))].sort((a, b) => a - b);
  assert.equal(rowTops.length, 4, 'four rows: ' + rowTops.join(','));
  const frHeight = surfaces.find((element) => Math.abs(element.y - rowTops[1]) < 0.001).h;
  assert.ok(frHeight > 3 && frHeight < 4, 'fr row height ' + frHeight);
  // The rows plus their gaps fill the declared 600px height.
  let sum = 0;
  rowTops.forEach((top) => { sum += surfaces.find((element) => Math.abs(element.y - top) < 0.001).h; });
  assert.ok(Math.abs(sum + 3 * (20 / 96) - 600 / 96) < 0.02, 'rows total ' + sum);
});

test('grid-auto-rows sizes the implicit rows', () => {
  const html = [
    '<html><head><style>',
    '  .slide { width: 1280px; height: 720px; padding: 40px; }',
    '  .board { display: grid; width: 1200px; grid-template-columns: 1fr 1fr;',
    '    grid-template-rows: 100px; grid-auto-rows: 60px; gap: 10px; }',
    '  .cell { background: #DDDDDD; }',
    '</style></head><body><main class="slide">',
    '<div class="board">',
    '  <div class="cell"><div>a</div></div><div class="cell"><div>b</div></div>',
    '  <div class="cell"><div>c</div></div><div class="cell"><div>d</div></div>',
    '</div></main></body></html>'
  ].join('\n');
  const result = pipeline.convertHtml(html);
  const board = result.deck.slides[0].elements.find((element) => element.type === 'container');
  assert.ok(Math.abs(board.autoRowHeight - 60 / 96) < 0.001, 'autoRowHeight ' + board.autoRowHeight);

  const { layoutSlide } = require('../native/engine/layout');
  const laid = layoutSlide(result.deck.slides[0], { width: 13.333, height: 7.5 }, result.deck.theme || {}, {});
  const surfaces = (Array.isArray(laid) ? laid : laid.elements)
    .filter((element) => element.type === 'shape' && element.fill === 'DDDDDD');
  const first = surfaces[0];
  const second = surfaces[2];
  assert.ok(Math.abs(first.h - 100 / 96) < 0.002, 'declared row ' + first.h);
  assert.ok(Math.abs(second.h - 60 / 96) < 0.002, 'implicit row ' + second.h);
});

test('fr rows without a declared height fall back to their content', () => {
  const html = [
    '<html><head><style>',
    '  .slide { width: 1280px; height: 720px; padding: 40px; }',
    '  .board { display: grid; width: 1000px; grid-template-columns: 1fr;',
    '    grid-template-rows: 1fr 1fr; gap: 10px; }',
    '  .cell { background: #CCCCCC; height: 100px; }',
    '</style></head><body><main class="slide">',
    '<div class="board"><div class="cell"><div>a</div></div><div class="cell"><div>b</div></div></div>',
    '</main></body></html>'
  ].join('\n');
  const result = pipeline.convertHtml(html);
  assert.deepEqual(result.errors, []);
  // An auto-height grid has no leftover to divide, so both rows fit their cell.
  assert.equal(result.report.unsupportedDetails.length, 0, JSON.stringify(result.report.unsupportedDetails));
  const { layoutSlide } = require('../native/engine/layout');
  const laid = layoutSlide(result.deck.slides[0], { width: 13.333, height: 7.5 }, result.deck.theme || {}, {});
  const surfaces = (Array.isArray(laid) ? laid : laid.elements)
    .filter((element) => element.type === 'shape' && element.fill === 'CCCCCC');
  assert.equal(surfaces.length, 2);
  surfaces.forEach((element) => {
    assert.ok(Math.abs(element.h - 100 / 96) < 0.002, 'content-sized fr row ' + element.h);
  });
});


test('a row that overflows shrinks its items like a browser', () => {
  const html = [
    '<html><head><style>',
    '  .slide { position: relative; width: 1280px; height: 720px; padding: 40px; }',
    '  .row { display: flex; flex-direction: row; gap: 20px; width: 1200px; }',
    '  .card { width: 500px; background: #EEEEEE; padding: 10px; }',
    '</style></head><body><main class="slide">',
    '<div class="row">',
    '  <div class="card"><div>a</div></div><div class="card"><div>b</div></div><div class="card"><div>c</div></div>',
    '</div></main></body></html>'
  ].join('\n');
  const result = pipeline.convertHtml(html);
  const row = result.deck.slides[0].elements.find((element) => element.type === 'container');
  assert.equal(row.children.length, 3);
  // (1200 - 2 * 20) / 3 = 386.7px for each 500px card.
  const expected = (1200 - 40) / 3 / 96;
  row.children.forEach((child, index) => {
    assert.ok(Math.abs(child.w - expected) < 0.01, 'card ' + index + ' width ' + child.w);
  });
  assert.deepEqual(result.report.containerFallbacks, []);
  assert.deepEqual(result.report.unsupportedDetails, []);
});

test('flex-shrink: 0 keeps an authored width even when the row overflows', () => {
  const html = [
    '<html><head><style>',
    '  .slide { position: relative; width: 1280px; height: 720px; padding: 40px; }',
    '  .row { display: flex; flex-direction: row; gap: 20px; width: 1200px; }',
    '  .card { width: 500px; flex-shrink: 0; background: #EEEEEE; padding: 10px; }',
    '</style></head><body><main class="slide">',
    '<div class="row">',
    '  <div class="card"><div>a</div></div><div class="card"><div>b</div></div><div class="card"><div>c</div></div>',
    '</div></main></body></html>'
  ].join('\n');
  const result = pipeline.convertHtml(html);
  const row = result.deck.slides[0].elements.find((element) => element.type === 'container');
  assert.ok(row, 'the overflowing row stays declarative');
  row.children.forEach((child, index) => {
    assert.ok(Math.abs(child.w - 500 / 96) < 0.01, 'card ' + index + ' width ' + child.w);
  });
  assert.deepEqual(result.report.containerFallbacks, []);
});

test('the flex shorthand sets the base and the shrink factor', () => {
  const html = [
    '<html><head><style>',
    '  .slide { position: relative; width: 1280px; height: 720px; display: flex;',
    '    flex-direction: row; gap: 20px; padding: 40px; }',
    '  .a { flex: 0 0 300px; background: #EEEEEE; }',
    '  .b { flex: 1; background: #DDDDDD; }',
    '</style></head><body><main class="slide">',
    '<div class="a"><div>fixed</div></div><div class="b"><div>rest</div></div>',
    '</main></body></html>'
  ].join('\n');
  const result = pipeline.convertHtml(html);
  const [first, second] = result.deck.slides[0].elements;
  assert.ok(Math.abs(first.w - 300 / 96) < 0.01, 'fixed item ' + first.w);
  // 1280 - 80 padding - 300 - 20 gap = 880px for the growing item.
  assert.ok(Math.abs(second.w - 880 / 96) < 0.02, 'growing item ' + second.w);
  assert.equal(result.report.unsupportedDetails.length, 0);
  assert.deepEqual(result.report.containerFallbacks, []);
});


test('structural pseudo-classes select the right siblings', () => {
  const build = (selector) => pipeline.convertHtml([
    '<html><head><style>',
    '  .slide { width: 1280px; height: 720px; padding: 40px; }',
    '  .row { display: flex; flex-direction: row; gap: 10px; width: 1200px; }',
    '  .card { flex: 1; height: 80px; background: #EEEEEE; }',
    '  .row > .card' + selector + ' { background: #FF0000; }',
    '</style></head><body><main class="slide">',
    '<div class="row">' + [1, 2, 3, 4, 5, 6].map((n) => '<div class="card"><div>' + n + '</div></div>').join('') + '</div>',
    '</main></body></html>'
  ].join('\n'));

  const marks = (selector) => {
    const result = build(selector);
    assert.deepEqual(result.errors, []);
    assert.deepEqual(result.report.unsupportedDetails, [], selector + ' must not be reported');
    const row = result.deck.slides[0].elements.find((element) => element.type === 'container' && element.children && element.children.length === 6);
    assert.ok(row, 'the row must stay a declarative container');
    return row.children.map((child) => ((child.background && child.background.fill) === 'FF0000' ? 'X' : '.')).join('');
  };

  assert.equal(marks(':first-child'), 'X.....');
  assert.equal(marks(':last-child'), '.....X');
  assert.equal(marks(':nth-child(2)'), '.X....');
  assert.equal(marks(':nth-child(even)'), '.X.X.X');
  assert.equal(marks(':nth-child(odd)'), 'X.X.X.');
  assert.equal(marks(':nth-child(3n+1)'), 'X..X..');
  assert.equal(marks(':nth-child(-n+2)'), 'XX....');
  assert.equal(marks(':nth-last-child(1)'), '.....X');
  // The nth expression may contain spaces.
  assert.equal(marks(':nth-child(2n + 1)'), 'X.X.X.');
});

test('of-type pseudo-classes count only siblings of the same tag', () => {
  const result = pipeline.convertHtml([
    '<html><head><style>',
    '  .slide { width: 1280px; height: 720px; padding: 40px; }',
    '  .box p:first-of-type { color: #FF0000; }',
    '  .box p:nth-of-type(2) { color: #00FF00; }',
    '  .box p:nth-child(1) { font-size: 99px; }',
    '  .solo:only-child { color: #0000FF; }',
    '</style></head><body><main class="slide">',
    '<div class="box"><h3>h</h3><p>one</p><p>two</p><span>s</span></div>',
    '<div class="box"><span class="solo">only</span></div>',
    '</main></body></html>'
  ].join('\n'));
  const texts = [];
  const walk = (nodes) => nodes.forEach((node) => {
    if (node.type === 'text') texts.push(node);
    if (node.children) walk(node.children);
  });
  walk(result.deck.slides[0].elements);

  // A one-run text box may carry the run styling instead of top-level colour.
  const textOf = (element) => (typeof element.text === 'string'
    ? element.text
    : (Array.isArray(element.text) ? element.text.map((run) => run.text).join('') : ''));
  const colorOf = (element) => {
    if (Array.isArray(element.text)) {
      const run = element.text.find((entry) => entry.options && entry.options.color);
      if (run) return run.options.color;
    }
    return element.color;
  };
  const byText = (value) => texts.find((element) => textOf(element) === value);

  assert.ok(byText('one'), 'the first paragraph must be emitted');
  assert.equal(colorOf(byText('one')), 'FF0000', 'first <p> in its parent');
  assert.equal(colorOf(byText('two')), '00FF00', 'second <p> in its parent');
  // `p:nth-child(1)` cannot match: the first child is the <h3>.
  assert.ok(!texts.some((element) => Number(element.fontSize) === 99), 'nth-child(1) must not match the first <p>');
  assert.equal(colorOf(byText('only')), '0000FF', 'the only child');
});

test('pseudo-classes that cannot be translated are still reported', () => {
  const result = pipeline.convertHtml([
    '<html><head><style>',
    '  :root { --accent: #123456; }',
    '  .slide { width: 1280px; height: 720px; }',
    '  .card { background: var(--accent); }',
    '  .card:hover { background: #FFFFFF; }',
    '</style></head><body><main class="slide">',
    '<div class="card"><div>x</div></div>',
    '</main></body></html>'
  ].join('\n'));
  // `:root` only declares variables, so it is not an untranslated selector...
  const selectors = result.report.unsupportedDetails.filter((entry) => entry.property === 'selector');
  assert.equal(selectors.length, 1, JSON.stringify(result.report.unsupportedDetails));
  assert.equal(selectors[0].value, '.card:hover');
  // ...and its variables still resolve.
  const card = result.deck.slides[0].elements.find((element) => element.type === 'container');
  assert.equal(card.background.fill, '123456');
});


test('a table row background becomes the cell fill, so zebra rows survive', () => {
  const result = pipeline.convertHtml([
    '<html><head><style>',
    '  .slide { width: 1280px; height: 720px; padding: 40px; }',
    '  table { width: 900px; background: #FFFFFF; }',
    '  th { background: #0F2A2E; color: #FFFFFF; text-align: left; }',
    '  td { padding: 10px; }',
    '  tbody tr:nth-child(even) { background: #F1F4F4; }',
    '  td.num { text-align: right; }',
    '</style></head><body><main class="slide">',
    '<table><thead><tr><th>区域</th><th>数量</th></tr></thead><tbody>',
    '<tr><td>华东</td><td class="num">1,284</td></tr>',
    '<tr><td>华南</td><td class="num">1,096</td></tr>',
    '<tr><td>华北</td><td class="num">938</td></tr>',
    '</tbody></table>',
    '</main></body></html>'
  ].join('\n'));
  assert.deepEqual(result.report.unsupportedDetails, []);
  const table = result.deck.slides[0].elements.find((element) => element.type === 'table');
  assert.ok(table, 'the table must stay a native table');
  const fill = (row, column) => table.rows[row][column].options.fill.color;
  assert.equal(fill(0, 0), '0F2A2E', 'the header keeps its own background');
  assert.equal(fill(1, 0), 'FFFFFF', 'an odd body row falls back to the table background');
  assert.equal(fill(2, 0), 'F1F4F4', 'an even body row takes the row background');
  assert.equal(fill(3, 0), 'FFFFFF');
  // Per-cell alignment still wins over the table default.
  assert.equal(table.rows[2][1].options.align, 'right');
  assert.equal(table.rows[2][0].options.align, undefined);
});


test('a table cell keeps its per-side borders instead of a full grid', () => {
  const result = pipeline.convertHtml([
    '<html><head><style>',
    '  .slide { width: 1280px; height: 720px; padding: 40px; }',
    '  table { width: 900px; border-collapse: collapse; }',
    '  th { background: #0F2A2E; color: #FFFFFF; }',
    '  td { border-bottom: 1px solid #E4EAEA; }',
    '  td.plain { border: none; }',
    '</style></head><body><main class="slide">',
    '<table><thead><tr><th>区域</th><th>数量</th></tr></thead><tbody>',
    '<tr><td>华东</td><td>1,284</td></tr>',
    '<tr><td class="plain">华南</td><td>1,096</td></tr>',
    '</tbody></table>',
    '</main></body></html>'
  ].join('\n'));
  // `border-bottom` on a cell is translated, not reported.
  assert.deepEqual(result.report.unsupportedDetails, []);
  const table = result.deck.slides[0].elements.find((element) => element.type === 'table');
  assert.ok(table);
  // The table itself must not invent lines.
  assert.deepEqual(table.options.border, { type: 'none' });
  const sides = table.rows[1][0].options.border;
  assert.ok(Array.isArray(sides), 'a single side becomes a four-side array');
  assert.equal(sides[0].type, 'none', 'top');
  assert.equal(sides[1].type, 'none', 'right');
  assert.equal(sides[2].type, 'solid', 'bottom');
  assert.equal(sides[2].color, 'E4EAEA');
  assert.ok(Math.abs(sides[2].pt - 0.75) < 0.01, '1px is 0.75pt, got ' + sides[2].pt);
  assert.equal(sides[3].type, 'none', 'left');
  // `border: none` removes every side.
  const cleared = table.rows[2][0].options.border;
  assert.equal(Array.isArray(cleared) ? cleared.every((entry) => entry.type === 'none') : cleared.type === 'none', true);
  // The header cell declares no border of its own and gets none.
  const header = table.rows[0][0].options.border;
  assert.equal(Array.isArray(header) ? header.every((entry) => entry.type === 'none') : header.type === 'none', true);
});

test('a single-side border becomes a strip and two sides stay reported', () => {
  const result = pipeline.convertHtml([
    '<html><head><style>',
    '  .slide { width: 1280px; height: 720px; }',
    '  .card { border-bottom: 2px solid #123456; width: 300px; height: 120px; }',
    '</style></head><body><main class="slide">',
    '<div class="card"></div>',
    '</main></body></html>'
  ].join('\n'));
  // One declared side is a native strip, so nothing is reported for it any more.
  const reported = result.report.unsupportedDetails.filter((entry) => entry.property === 'border');
  assert.equal(reported.length, 0, JSON.stringify(result.report.unsupportedDetails));
  // The box paints nothing, so its border side is emitted as a standalone strip.
  const strip = result.deck.slides[0].elements.find((element) => element.fill === '123456');
  assert.ok(strip, JSON.stringify(result.deck.slides[0].elements.map((element) => element.type)));
  // 2px on the page is 1.5pt, and the strip is that thin in inches.
  assert.ok(Math.abs(strip.h - 2 / 96) < 0.002, 'strip height ' + strip.h);
  assert.ok(Math.abs((strip.y + strip.h) - 1.25) < 0.01, 'strip sits on the bottom edge: ' + strip.y);

  // Two declared sides cannot be one strip, so that case stays reported.
  const two = pipeline.convertHtml([
    '<html><head><style>',
    '  .slide { width: 1280px; height: 720px; }',
    '  .card { border-top: 2px solid #123456; border-bottom: 2px solid #123456; width: 300px; height: 120px; }',
    '</style></head><body><main class="slide">',
    '<div class="card"></div>',
    '</main></body></html>'
  ].join('\n'));
  const stillReported = two.report.unsupportedDetails.filter((entry) => entry.property === 'border');
  assert.equal(stillReported.length, 1, JSON.stringify(two.report.unsupportedDetails));
  assert.ok(/uniform/.test(stillReported[0].reason), stillReported[0].reason);
});


test('text-indent becomes a first-line indent and widens the wrap', () => {
  const make = (indent) => pipeline.convertHtml([
    '<html><head><style>',
    '  .slide { width: 1280px; height: 720px; padding: 40px; }',
    '  .para { width: 200px; font-size: 14px; line-height: 1.8; ' + indent + ' }',
    '</style></head><body><main class="slide">',
    '<div class="para">中文正文需要首行缩进两个字符，这样读者一眼就能看出段落从哪里开始，而不是靠段间留白。</div>',
    '</main></body></html>'
  ].join('\n'));

  const plain = make('');
  const indented = make('text-indent: 2em;');
  const find = (result) => result.deck.slides[0].elements.find((element) => element.type === 'text');
  // 2em at 14px is 28px = 0.2917in.
  assert.ok(Math.abs(find(indented).textIndent - 28 / 96) < 0.001, String(find(indented).textIndent));
  assert.equal(find(plain).textIndent, undefined);
  assert.deepEqual(indented.report.unsupportedDetails, []);

  // A wide indent eats into the first line, so the box must not come out shorter.
  const wide = make('text-indent: 10em;');
  assert.ok(find(wide).h >= find(plain).h,
    'indented height ' + find(wide).h + ' vs plain ' + find(plain).h);
  assert.ok(find(wide).h > find(plain).h - 1e-9);
});

test('a negative text-indent is reported, not half-applied', () => {
  const result = pipeline.convertHtml([
    '<html><head><style>',
    '  .slide { width: 1280px; height: 720px; }',
    '  .entry { width: 400px; text-indent: -1em; padding-left: 1em; }',
    '</style></head><body><main class="slide">',
    '<div class="entry">悬挂缩进的词条</div>',
    '</main></body></html>'
  ].join('\n'));
  const reported = result.report.unsupportedDetails.filter((entry) => entry.property === 'textIndent');
  assert.equal(reported.length, 1, JSON.stringify(result.report.unsupportedDetails));
  const text = result.deck.slides[0].elements.find((element) => element.type === 'text');
  assert.equal(text.textIndent, undefined);
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

test('a converted deck really carries the indent in the pptx', async () => {
  const fsSync = require('node:fs');
  const osSync = require('node:os');
  const pathSync = require('node:path');
  const JSZip = require(require.resolve('jszip', { paths: [require.resolve('../native/engine/native_pptx')] }));
  const { generatePptx } = require('../native/engine/native_pptx');

  const result = pipeline.convertHtml([
    '<html><head><style>',
    '  .slide { width: 1280px; height: 720px; padding: 40px; }',
    '  .para { width: 300px; font-size: 14px; text-indent: 2em; }',
    '  .flush { width: 300px; font-size: 14px; }',
    '</style></head><body><main class="slide">',
    '<div class="para">缩进段落</div>',
    '<div class="flush">顶格段落</div>',
    '</main></body></html>'
  ].join('\n'));
  const output = pathSync.join(osSync.tmpdir(), 'native-indent-' + process.pid + '.pptx');
  await generatePptx(result.deck, output);
  const zip = await JSZip.loadAsync(fsSync.readFileSync(output));
  const xml = await zip.file('ppt/slides/slide1.xml').async('string');
  fsSync.unlinkSync(output);

  // The writer rounds inches to 4 decimals, so derive the EMU from the spec value.
  const textElement = result.deck.slides[0].elements.find((element) => element.type === 'text' && element.textIndent);
  assert.ok(textElement, 'the indent must survive into the deck spec');
  const expected = String(Math.round(textElement.textIndent * 914400));
  const indented = /<a:t>缩进段落<\/a:t>/u;
  assert.ok(indented.test(xml));
  assert.ok(xml.includes('indent="' + expected + '"'), 'missing indent="' + expected + '"');
  // The flush paragraph keeps an indent of 0.
  const blocks = xml.match(/<p:sp>[\s\S]*?<\/p:sp>/gu) || [];
  const flushBlock = blocks.find((block) => block.includes('<a:t>顶格段落</a:t>'));
  assert.ok(flushBlock, 'flush paragraph must exist');
  const flushIndent = (/<a:pPr[^>]*indent="(-?\d+)"/u.exec(flushBlock) || [])[1];
  assert.ok(flushIndent === undefined || Number(flushIndent) === 0, 'flush indent was ' + flushIndent);
});


test(':not(), :is() and :where() select like a browser', () => {
  const build = (selector) => pipeline.convertHtml([
    '<html><head><style>',
    '  .slide { width: 1280px; height: 720px; padding: 40px; }',
    '  .row { display: flex; flex-direction: row; gap: 10px; width: 1200px; }',
    '  .card { flex: 1; height: 60px; background: #EEEEEE; }',
    '  .card' + selector + ' { background: #FF0000; }',
    '</style></head><body><main class="slide">',
    '<div class="row">' + [1, 2, 3, 4].map((n) => '<div class="card"><div>' + n + '</div></div>').join('') + '</div>',
    '</main></body></html>'
  ].join('\n'));

  const marks = (selector) => {
    const result = build(selector);
    assert.deepEqual(result.report.unsupportedDetails, [], selector + ' must be translated');
    const row = result.deck.slides[0].elements.find((element) => element.type === 'container' && element.children && element.children.length === 4);
    assert.ok(row, 'the row must stay declarative for ' + selector);
    return row.children.map((child) => ((child.background && child.background.fill) === 'FF0000' ? 'X' : '.')).join('');
  };

  assert.equal(marks(':not(:first-child)'), '.XXX');
  assert.equal(marks(':not(:nth-child(even))'), 'X.X.');
  assert.equal(marks(':not(.missing)'), 'XXXX');
  assert.equal(marks(':is(.card)'), 'XXXX');
  assert.equal(marks(':not(:not(.card))'), 'XXXX');
  // An argument we cannot evaluate is reported instead of over-matching.
  const hovered = build(':not(:hover)');
  const reported = hovered.report.unsupportedDetails.filter((entry) => entry.property === 'selector');
  assert.equal(reported.length, 1, JSON.stringify(hovered.report.unsupportedDetails));
});

test(':where() has zero specificity and :is() keeps its argument\'s', () => {
  const cascade = (second) => pipeline.convertHtml([
    '<html><head><style>',
    '  .slide { width: 1280px; height: 720px; }',
    '  .card { width: 200px; height: 100px; background: #00AA00; }',
    '  ' + second + ' { background: #FF0000; }',
    '</style></head><body><main class="slide">',
    '<div class="card"></div>',
    '</main></body></html>'
  ].join('\n'));
  const fillOf = (result) => {
    const walk = (nodes) => {
      for (const node of nodes) {
        const fill = (node.background && node.background.fill) || (node.fill && node.fill.color) || node.fill;
        if (typeof fill === 'string' && /^[0-9A-F]{6}$/iu.test(fill)) return fill;
        if (node.children) {
          const nested = walk(node.children);
          if (nested) return nested;
        }
      }
      return null;
    };
    return walk(result.deck.slides[0].elements);
  };
  // Declared later, but zero specificity: the class rule still wins.
  assert.equal(fillOf(cascade(':where(.card)')), '00AA00');
  // A comma inside :is() belongs to the argument, and the rule wins on specificity.
  const is = cascade(':is(.card, .other)');
  assert.equal(fillOf(is), 'FF0000');
  assert.deepEqual(is.report.unsupportedDetails, []);
});


test('attribute selectors match like a browser', () => {
  const build = (selector) => pipeline.convertHtml([
    '<html><head><style>',
    '  .slide { width: 1280px; height: 720px; padding: 40px; }',
    '  .row { display: flex; flex-direction: row; gap: 10px; width: 1200px; }',
    '  .card { flex: 1; height: 60px; background: #EEEEEE; }',
    '  .card' + selector + ' { background: #FF0000; }',
    '</style></head><body><main class="slide">',
    '<div class="row">',
    '  <div class="card" data-kind="kpi"><div>1</div></div>',
    '  <div class="card" data-kind="chart"><div>2</div></div>',
    '  <div class="card" data-kind="kpi extra"><div>3</div></div>',
    '  <div class="card"><div>4</div></div>',
    '</div></main></body></html>'
  ].join('\n'), {});

  const marks = (selector) => {
    const result = build(selector);
    assert.deepEqual(result.report.unsupportedDetails, [], selector + ' must be translated');
    const row = result.deck.slides[0].elements.find((element) => element.type === 'container' && element.children && element.children.length === 4);
    assert.ok(row, 'the row must stay declarative for ' + selector);
    return row.children.map((child) => ((child.background && child.background.fill) === 'FF0000' ? 'X' : '.')).join('');
  };

  assert.equal(marks('[data-kind]'), 'XXX.');
  assert.equal(marks('[data-kind="kpi"]'), 'X...');
  assert.equal(marks("[data-kind='kpi']"), 'X...');
  assert.equal(marks('[data-kind=chart]'), '.X..');
  assert.equal(marks('[data-kind~="kpi"]'), 'X.X.');
  assert.equal(marks('[data-kind|="kpi"]'), 'X...');
  assert.equal(marks('[data-kind^="ch"]'), '.X..');
  assert.equal(marks('[data-kind$="tra"]'), '..X.');
  assert.equal(marks('[data-kind*="pi"]'), 'X.X.');
  assert.equal(marks('[data-kind="KPI" i]'), 'X...');
  assert.equal(marks('[data-missing]'), '....');
  // Combined with a pseudo-class, and with :not().
  assert.equal(marks('[data-kind]:not([data-kind="chart"])'), 'X.X.');
});

test('an attribute selector we cannot parse is reported, not silently ignored', () => {
  const result = pipeline.convertHtml([
    '<html><head><style>',
    '  .slide { width: 1280px; height: 720px; }',
    '  .card { width: 200px; height: 80px; background: #EEEEEE; }',
    '  .card[data-kind!=kpi] { background: #FF0000; }',
    '</style></head><body><main class="slide"><div class="card" data-kind="kpi"></div></main></body></html>'
  ].join('\n'));
  const selectors = result.report.unsupportedDetails.filter((entry) => entry.property === 'selector');
  assert.equal(selectors.length, 1, JSON.stringify(result.report.unsupportedDetails));
  assert.ok(selectors[0].value.includes('data-kind!=kpi'), selectors[0].value);
  // The rule must not be half-applied to every .card.
  const card = result.deck.slides[0].elements.find((element) => element.type === 'shape' || element.type === 'container');
  const fill = card.fill || (card.background && card.background.fill);
  assert.equal(fill, 'EEEEEE');
});

test('position: fixed anchors to the slide, not to a positioned parent', () => {
  const result = pipeline.convertHtml([
    '<html><head><style>',
    '  .slide { position: relative; width: 1280px; height: 720px; }',
    '  .card { position: absolute; left: 100px; top: 100px; width: 400px; height: 300px; background: #EEEEEE; }',
    '  .badge { position: fixed; right: 20px; bottom: 20px; width: 120px; height: 40px; background: #FF0000; }',
    '</style></head><body><main class="slide">',
    '<div class="card"><div class="badge"><div>pinned</div></div></div>',
    '</main></body></html>'
  ].join('\n'));
  assert.deepEqual(result.report.unsupportedDetails, []);
  const walk = (nodes) => {
    for (const node of nodes) {
      const fill = node.fill || (node.background && node.background.fill);
      if (fill === 'FF0000') return node;
      if (node.children) {
        const nested = walk(node.children);
        if (nested) return nested;
      }
    }
    return null;
  };
  const badge = walk(result.deck.slides[0].elements);
  assert.ok(badge, 'the fixed badge must be emitted');
  // 1280 - 120 - 20 = 1140px, 720 - 40 - 20 = 660px, in inches.
  assert.ok(Math.abs(badge.x - 1140 / 96) < 0.02, 'x was ' + badge.x);
  assert.ok(Math.abs(badge.y - 660 / 96) < 0.02, 'y was ' + badge.y);
});


test('child and sibling combinators match the DOM, not a descendant approximation', () => {
  const build = (css) => pipeline.convertHtml([
    '<html><head><style>',
    '  .slide { width: 1280px; height: 720px; padding: 40px; }',
    '  .row { display: flex; flex-direction: row; gap: 10px; width: 1200px; }',
    '  .card { flex: 1; height: 60px; background: #EEEEEE; }',
    '  ' + css,
    '</style></head><body><main class="slide">',
    '  <div class="row">',
    '    <div class="card"><div>1</div></div>',
    '    <div class="card"><div>2</div></div>',
    '    <div class="card"><div>3</div></div>',
    '  </div></main></body></html>'
  ].join('\n'));

  const marks = (css) => {
    const result = build(css);
    assert.deepEqual(result.report.unsupportedDetails, [], css + ' must be translated');
    const row = result.deck.slides[0].elements.find((element) => element.type === 'container'
      && element.children && element.children.length === 3);
    assert.ok(row, 'the row must stay declarative for ' + css);
    return row.children.map((child) => ((child.background && child.background.fill) === 'FF0000' ? 'X' : '.')).join('');
  };

  // Descendant (unchanged behaviour).
  assert.equal(marks('.row .card { background: #FF0000; }'), 'XXX');
  // Child: direct children only, so a grandchild relationship does not match.
  assert.equal(marks('.row > .card { background: #FF0000; }'), 'XXX');
  assert.equal(marks('.slide > .card { background: #FF0000; }'), '...');
  // Adjacent and general siblings.
  assert.equal(marks('.card + .card { background: #FF0000; }'), '.XX');
  assert.equal(marks('.card ~ .card { background: #FF0000; }'), '.XX');
  assert.equal(marks('.row + .card { background: #FF0000; }'), '...');
  // Combined with a structural pseudo-class: "every item but the first".
  assert.equal(marks('.card:nth-child(1) + .card { background: #FF0000; }'), '.X.');
});

test('a descendant chain backtracks instead of failing on the first candidate', () => {
  const result = pipeline.convertHtml([
    '<html><head><style>',
    '  .slide { width: 1280px; height: 720px; padding: 40px; }',
    '  .outer { display: flex; flex-direction: row; width: 1200px; }',
    '  .inner { flex: 1; height: 40px; background: #EEEEEE; }',
    '  .mid .deep { background: #FF0000; }',
    '</style></head><body><main class="slide">',
    '  <div class="outer">',
    '    <div class="inner"><div class="mid"><div class="deep"><div>x</div></div></div></div>',
    '  </div></main></body></html>'
  ].join('\n'));
  assert.deepEqual(result.report.unsupportedDetails, []);
  const json = JSON.stringify(result.deck);
  assert.ok(json.includes('FF0000'), 'the deep background must be emitted');
});


test('white-space: nowrap stays on one line and is written as wrap="none"', async () => {
  // Analyzer: nowrap keeps a single line, so the box does not grow.
  const build = (extra) => pipeline.convertHtml([
    '<html><head><style>',
    '  .slide { width: 1280px; height: 720px; padding: 40px; }',
    '  .label { width: 90px; font-size: 13px; line-height: 1.4; ' + extra + ' }',
    '</style></head><body><main class="slide">',
    '  <div class="label">门店销售同比环比增长数据说明</div>',
    '</main></body></html>'
  ].join('\n'));
  const textNodeOf = (result) => {
    const walk = (nodes) => {
      for (const node of nodes) {
        if (node.type === 'text') return node;
        if (node.children) {
          const found = walk(node.children);
          if (found) return found;
        }
      }
      return null;
    };
    return walk(result.deck.slides[0].elements);
  };

  const wrapped = textNodeOf(build(''));
  const nowrap = textNodeOf(build('white-space: nowrap;'));
  assert.deepEqual(build('white-space: nowrap;').report.unsupportedDetails, []);
  assert.equal(nowrap.nowrap, true);
  assert.equal(wrapped.nowrap, undefined);
  assert.ok(nowrap.h < wrapped.h - 0.2, 'nowrap must be one line: ' + nowrap.h + ' vs ' + wrapped.h);

  // `pre` keeps whitespace now: the runs preserve their spaces, so nothing is lost
  // and nothing is reported.
  const pre = build('white-space: pre;');
  assert.equal(pre.report.unsupportedDetails.filter((entry) => entry.property === 'whiteSpace').length, 0);

  // Writer: wrap="none" and no autofit, which is what makes a renderer stop re-flowing.
  await withTempDir('native-nowrap-', async (directory) => {
    const output = pathSync.join(directory, 'nowrap.pptx');
    const { generatePptx } = require('../native/engine/native_pptx');
    await generatePptx({ slides: [{ elements: [
      { type: 'text', text: 'wrapped label text', x: 0.5, y: 0.5, w: 1.4, h: 0.4, fontSize: 12 },
      { type: 'text', text: 'nowrap label text', x: 0.5, y: 1.2, w: 1.4, h: 0.4, fontSize: 12, nowrap: true }
    ] }] }, output);
    const xml = await readSlideXml(output);
    assert.equal((xml.match(/wrap="none"/gu) || []).length, 1);
  // No box autofits: the analyzer measured each one, so the writer does not ask the
  // renderer to shrink the glyphs to fit (that would re-wrap the text as well).
  assert.equal((xml.match(/<a:normAutofit/gu) || []).length, 0);
    assert.equal((xml.match(/<a:spAutoFit/gu) || []).length, 0);
  });

  // The spec validator accepts the flag and rejects a non-boolean.
  assert.deepEqual(validateDeck({ slides: [{ elements: [
    { type: 'text', text: 'x', x: 0, y: 0, w: 1, h: 0.3, nowrap: true }
  ] }] }), []);
  assert.ok(validateDeck({ slides: [{ elements: [
    { type: 'text', text: 'x', x: 0, y: 0, w: 1, h: 0.3, nowrap: 'yes' }
  ] }] }).some((error) => error.includes('nowrap')));
});


test('flex-wrap: wrap breaks a row into lines the engine reproduces', () => {
  const build = (wrap) => pipeline.convertHtml([
    '<html><head><style>',
    '  .slide { width: 1280px; height: 720px; padding: 40px; }',
    '  .tags { display: flex; ' + (wrap ? 'flex-wrap: wrap; ' : '') + 'gap: 12px; width: 600px; }',
    '  .tag { flex: 0 0 180px; padding: 6px 10px; font-size: 12px; }',
    '</style></head><body><main class="slide">',
    '  <div class="tags">',
    [1, 2, 3, 4, 5].map((n) => '    <div class="tag"><div>' + n + '</div></div>').join('\n'),
    '  </div></main></body></html>'
  ].join('\n'));

  const wrapped = build(true);
  assert.deepEqual(wrapped.report.unsupportedDetails, []);
  assert.ok(wrapped.report.maxBoxDelta < 0.002, 'engine must replay the wrapped geometry, got ' + wrapped.report.maxBoxDelta);
  const row = wrapped.deck.slides[0].elements.find((element) => element.type === 'container');
  assert.equal(row.wrap, true);
  // 3 items of 180px + 2 gaps of 12px = 564px fit in 600px; two lines, so the
  // container is two tag boxes plus one gap tall.
  const single = build(false).deck.slides[0].elements.find((element) => element.type === 'container');
  assert.equal(single.wrap, undefined);
  assert.ok(row.h > single.h + 0.3, 'the wrapped row must be two lines tall: ' + row.h + ' vs ' + single.h);

  // An item without a base never forces a break, which keeps the intent predictable.
  const autoBasis = pipeline.convertHtml([
    '<html><head><style>',
    '  .slide { width: 1280px; height: 720px; }',
    '  .row { display: flex; flex-wrap: wrap; gap: 10px; width: 400px; }',
    '  .cell { flex: 1; height: 40px; }',
    '</style></head><body><main class="slide">',
    '  <div class="row"><div class="cell"></div><div class="cell"></div><div class="cell"></div></div>',
    '</main></body></html>'
  ].join('\n'));
  const autoRow = autoBasis.deck.slides[0].elements.find((element) => element.type === 'container');
  const autoSingle = pipeline.convertHtml([
    '<html><head><style>',
    '  .slide { width: 1280px; height: 720px; }',
    '  .row { display: flex; gap: 10px; width: 400px; }',
    '  .cell { flex: 1; height: 40px; }',
    '</style></head><body><main class="slide">',
    '  <div class="row"><div class="cell"></div><div class="cell"></div><div class="cell"></div></div>',
    '</main></body></html>'
  ].join('\n')).deck.slides[0].elements.find((element) => element.type === 'container');
  assert.ok(Math.abs(autoRow.h - autoSingle.h) < 0.01, 'auto items stay on one line');
});

test('a padded card is as tall as it renders, so a wrapped line does not overlap', () => {
  const result = pipeline.convertHtml([
    '<html><head><style>',
    '  .slide { width: 1280px; height: 720px; }',
    '  .card { width: 200px; padding: 10px 14px; font-size: 13px; line-height: 1.5; }',
    '</style></head><body><main class="slide">',
    '  <div class="card">标签文字</div>',
    '</main></body></html>'
  ].join('\n'));
  const card = result.deck.slides[0].elements.find((element) => element.type === 'text'
    || (element.type === 'container' && element.children));
  const textNode = card.type === 'container' ? card.children[0] : card;
  const textHeight = textNode.h;
  const pad = card.padding ? (card.padding.top + card.padding.bottom) / 2 : 0;
  // The box height carries the vertical padding; the text box inside does not.
  assert.ok(textHeight > 0.2, 'text height ' + textHeight);
  if (card.type === 'container') {
    assert.ok(card.h > textNode.h + 0.1, 'the container must add its padding back: ' + card.h + ' vs ' + textNode.h);
  } else {
    assert.ok(card.h > 0.3, 'a padded text box height must include the padding: ' + card.h);
  }
  assert.ok(pad >= 0);
});


test('the layout audit reports colliding boxes and content that spills out', () => {
  const audit = (html) => {
    const result = pipeline.convertHtml(html);
    return result.report.layout;
  };

  const overlap = audit([
    '<html><head><style>',
    '  .slide { width: 1280px; height: 720px; padding: 40px; }',
    '  .a { height: 100px; background: #EEEEEE; }',
    '  .b { height: 100px; margin-top: -60px; background: #DDDDDD; }',
    '</style></head><body><main class="slide">',
    '  <div class="a"></div><div class="b"></div>',
    '</main></body></html>'
  ].join('\n'));
  assert.equal(overlap.total, 1);
  const collision = overlap.slides[0].collisions[0];
  assert.ok(collision.a.includes('a') && collision.b.includes('b'), JSON.stringify(collision));
  assert.ok(collision.area > 1, 'the overlap area is reported in in²');

  const spill = audit([
    '<html><head><style>',
    '  .slide { width: 1280px; height: 720px; padding: 40px; }',
    '  .box { width: 400px; height: 60px; padding: 10px; }',
    '  .inner { height: 300px; }',
    '</style></head><body><main class="slide">',
    '  <div class="box"><div class="inner"></div></div>',
    '</main></body></html>'
  ].join('\n'));
  assert.equal(spill.total, 1);
  assert.equal(spill.slides[0].overflows[0].axis, 'y');
  assert.ok(spill.slides[0].overflows[0].over > 2, JSON.stringify(spill.slides[0].overflows));

  // A normal stack and deliberate absolute layers must not be reported.
  const clean = audit([
    '<html><head><style>',
    '  .slide { position: relative; width: 1280px; height: 720px; padding: 40px; }',
    '  .a { height: 100px; }',
    '  .b { height: 100px; margin-top: 20px; }',
    '  .bg { position: absolute; left: 0; top: 0; width: 1280px; height: 300px; }',
    '  .title { position: absolute; left: 60px; top: 100px; width: 600px; height: 80px; }',
    '</style></head><body><main class="slide">',
    '  <div class="bg"></div><div class="title">标题</div>',
    '  <div class="a"></div><div class="b"></div>',
    '</main></body></html>'
  ].join('\n'));
  assert.equal(clean.total, 0, JSON.stringify(clean.slides));

  // Content past the slide edge is content nobody in the audience sees.
  const over = audit([
    '<html><head><style>',
    '  .slide { width: 1280px; height: 720px; padding: 40px; }',
    '  .tall { height: 900px; }',
    '</style></head><body><main class="slide">',
    '  <div class="tall"></div>',
    '</main></body></html>'
  ].join('\n'));
  assert.equal(over.total, 1, JSON.stringify(over.slides));
  assert.equal(over.slides[0].beyond[0].side, 'bottom');
  assert.ok(over.slides[0].beyond[0].over > 2, JSON.stringify(over.slides[0].beyond));
});

test('every shipped HTML fixture lays out without a collision or an overflow', () => {
  const fs = require('node:fs');
  const pathSync = require('node:path');
  const directory = pathSync.join(__dirname, '..', 'examples');
  const files = fs.readdirSync(directory).filter((name) => name.endsWith('.html')).sort();
  assert.ok(files.length >= 6, 'the fixtures must be present: ' + files.join(', '));
  const failures = [];
  files.forEach((name) => {
    const result = pipeline.convertHtml(fs.readFileSync(pathSync.join(directory, name), 'utf8'));
    const layout = result.report.layout;
    if (layout && layout.total) {
      failures.push(name + ': ' + JSON.stringify(layout.slides).slice(0, 400));
    }
  });
  assert.deepEqual(failures, []);
});


test('a single declared border side becomes a real shape on that edge', () => {
  const result = pipeline.convertHtml([
    '<html><head><style>',
    '  .slide { width: 1280px; height: 720px; padding: 40px; }',
    '  .row { display: flex; gap: 12px; }',
    '  .card { flex: 1; padding: 12px; background: #FFFFFF; border-top: 3px solid #D98A4B; }',
    '</style></head><body><main class="slide">',
    '  <div class="row"><div class="card">甲</div><div class="card">乙</div></div>',
    '</main></body></html>'
  ].join('\n'));

  // The accent is not reported as an untranslatable border any more.
  assert.deepEqual(result.report.unsupportedDetails.map((entry) => entry.property), []);
  const row = result.deck.slides[0].elements.find((element) => element.type === 'container');
  const cards = row.children.filter((child) => child.type === 'container');
  assert.equal(cards.length, 2);
  cards.forEach((card) => {
    assert.equal(card.edge.side, 'top');
    assert.equal(card.edge.width, 2.25);          // 3px
    assert.equal(card.edge.color, 'D98A4B');
  });

  // The engine resolves it into a thin filled shape lying on the card's top edge.
  const { layoutSlide } = require('../native/engine/layout');
  const flat = layoutSlide({ elements: JSON.parse(JSON.stringify(result.deck.slides[0].elements)) },
    { width: 13.333, height: 7.5 }, {}, {});
  const strips = flat.filter((element) => element.type === 'shape' && element.fill === 'D98A4B');
  assert.equal(strips.length, 2, JSON.stringify(flat.map((element) => element.type)));
  strips.forEach((strip) => {
    assert.ok(Math.abs(strip.h - 2.25 / 72) < 0.002, 'strip height ' + strip.h);
    assert.equal(strip.line, false);
  });
  const firstCard = flat.find((element) => element.type === 'shape' && element.fill === 'FFFFFF');
  assert.ok(firstCard, 'the card surface is emitted');
  const onEdge = strips.find((strip) => Math.abs(strip.y - firstCard.y) < 0.001);
  assert.ok(onEdge, 'a strip sits on the card top edge: ' + JSON.stringify(strips));

  // Two different sides stay reported: a native strip is one edge, not four.
  const asymmetric = pipeline.convertHtml([
    '<html><head><style>',
    '  .slide { width: 1280px; height: 720px; }',
    '  .box { width: 200px; height: 80px; border-top: 2px solid #111111; border-bottom: 4px solid #222222; }',
    '</style></head><body><main class="slide"><div class="box"></div></main></body></html>'
  ].join('\n'));
  assert.ok(asymmetric.report.unsupportedDetails.some((entry) => entry.property === 'border'),
    JSON.stringify(asymmetric.report.unsupportedDetails));
});

test('a multi-slide HTML keeps every page inside the canvas', () => {
  const fs = require('node:fs');
  const pathSync = require('node:path');
  const html = fs.readFileSync(pathSync.join(__dirname, '..', 'examples', 'pipeline-stress.html'), 'utf8');
  const result = pipeline.convertHtml(html);
  // The stress fixture grew to seven pages: cover, columns, gradient/shadow cards,
  // chart + table, flow + timeline, image cover crop.
  assert.equal(result.deck.slides.length, 9);
  assert.equal(result.report.layout.total, 0, JSON.stringify(result.report.layout.slides));
  // Each slide carries its own theme-derived background and its own elements.
  result.deck.slides.forEach((slide, index) => {
    assert.ok(Array.isArray(slide.elements) && slide.elements.length, 'slide ' + (index + 1) + ' is empty');
  });
  assert.equal(result.deck.slides[0].elements.length >= 4, true);
});


test('overflow: hidden is reported only when the box really clips something', () => {
  const audit = (html) => pipeline.convertHtml(html).report.unsupportedDetails
    .filter((entry) => entry.property === 'overflow');

  // Content that fits: the declaration changes no pixel, so it is not a limitation.
  const fits = audit([
    '<html><head><style>',
    '  .slide { width: 1280px; height: 720px; padding: 40px; overflow: hidden; }',
    '  .box { width: 300px; height: 120px; overflow: hidden; padding: 10px; }',
    '</style></head><body><main class="slide">',
    '  <div class="box"><div style="height: 40px"></div></div>',
    '</main></body></html>'
  ].join('\n'));
  assert.deepEqual(fits, []);

  // Content that is clipped: a native shape cannot clip its children, so say so.
  const clips = audit([
    '<html><head><style>',
    '  .slide { width: 1280px; height: 720px; padding: 40px; }',
    '  .box { width: 300px; height: 60px; overflow: hidden; }',
    '  .inner { height: 300px; }',
    '</style></head><body><main class="slide">',
    '  <div class="box"><div class="inner"></div></div>',
    '</main></body></html>'
  ].join('\n'));
  assert.equal(clips.length, 1, JSON.stringify(clips));
  assert.ok(/cannot clip/u.test(clips[0].reason), clips[0].reason);
});


test('writing-mode: vertical-rl becomes native vertical text, not a rotation', async () => {
  const build = (extra) => pipeline.convertHtml([
    '<html><head><style>',
    '  .slide { width: 1280px; height: 720px; padding: 40px; }',
    '  .label { width: 44px; height: 320px; font-size: 20px; ' + extra + ' }',
    '</style></head><body><main class="slide">',
    '  <div class="label">竖排标题文字</div>',
    '</main></body></html>'
  ].join('\n'));

  const vertical = build('writing-mode: vertical-rl;');
  assert.deepEqual(vertical.report.unsupportedDetails, []);
  const label = vertical.deck.slides[0].elements.find((element) => element.type === 'text');
  assert.equal(label.vert, 'eaVert');
  assert.equal(label.rotate, undefined, 'vertical text is not a rotation');

  // An advance is measured down the box height, so the box is not re-wrapped by width.
  assert.equal(String(label.text).includes('\n'), false, JSON.stringify(label.text));

  const sideways = build('writing-mode: sideways-rl;');
  assert.deepEqual(sideways.report.unsupportedDetails, []);
  assert.equal(sideways.deck.slides[0].elements.find((element) => element.type === 'text').vert, 'vert');

  // Directions with no native equivalent must be reported, not rotated silently.
  const lr = build('writing-mode: vertical-lr;');
  assert.equal(lr.report.unsupportedDetails.filter((entry) => entry.property === 'writingMode').length, 1);
  assert.equal(lr.deck.slides[0].elements.find((element) => element.type === 'text').vert, undefined);

  // The box height is the line length, so it cannot be derived from the text.
  const autoHeight = pipeline.convertHtml([
    '<html><head><style>',
    '  .slide { width: 1280px; height: 720px; }',
    '  .label { width: 44px; writing-mode: vertical-rl; font-size: 20px; }',
    '</style></head><body><main class="slide">',
    '  <div class="label">竖排</div>',
    '</main></body></html>'
  ].join('\n'));
  assert.equal(autoHeight.report.unsupportedDetails.filter((entry) => entry.property === 'writingMode').length, 1);
  assert.ok(/declared height/u.test(autoHeight.report.unsupportedDetails[0].reason),
    autoHeight.report.unsupportedDetails[0].reason);

  // Too narrow for the columns the text needs: reported with the count, not drawn over.
  const narrow = pipeline.convertHtml([
    '<html><head><style>',
    '  .slide { width: 1280px; height: 720px; }',
    '  .label { width: 20px; height: 60px; writing-mode: vertical-rl; font-size: 16px; }',
    '</style></head><body><main class="slide">',
    '  <div class="label">这一句很长很长很长</div>',
    '</main></body></html>'
  ].join('\n'));
  const narrowReport = narrow.report.unsupportedDetails.filter((entry) => entry.property === 'writingMode');
  assert.equal(narrowReport.length, 1);
  assert.ok(/column\(s\)/u.test(narrowReport[0].reason), narrowReport[0].reason);

  // Writer: bodyPr vert on the vertical box, none on a horizontal one, and no autofit.
  await withTempDir('native-vertical-', async (directory) => {
    const output = pathSync.join(directory, 'vertical.pptx');
    const { generatePptx } = require('../native/engine/native_pptx');
    await generatePptx({ slides: [{ elements: [
      { type: 'text', text: 'horizontal', x: 0.5, y: 0.5, w: 3, h: 0.5, fontSize: 12 },
      { type: 'text', text: '竖排标题', x: 4.5, y: 0.5, w: 0.5, h: 3, fontSize: 18, vert: 'eaVert' }
    ] }] }, output);
    const xml = await readSlideXml(output);
    assert.equal((xml.match(/vert="eaVert"/gu) || []).length, 1);
  assert.equal((xml.match(/<a:normAutofit/gu) || []).length, 0);
  });
});


test('word-break is translated where the wrap already behaves that way', () => {
  const build = (declaration) => pipeline.convertHtml([
    '<html><head><style>',
    '  .slide { width: 1280px; height: 720px; padding: 40px; }',
    '  .cell { width: 140px; font-size: 12px; ' + declaration + ' }',
    '</style></head><body><main class="slide">',
    '  <div class="cell">https://example.com/a/very/long/path/that/cannot/fit/on/one/line</div>',
    '</main></body></html>'
  ].join('\n'));

  const plain = build('');
  const node = plain.deck.slides[0].elements.find((element) => element.type === 'text');
  // The wrap already breaks an unbreakable token, so the box is several lines tall
  // and nothing overflows: that is exactly what `break-all`/`break-word` ask for.
  assert.ok(node.h > 0.4, 'the long token wraps: ' + node.h);
  assert.equal(String(node.text).includes('\n'), false, 'the text itself is untouched');

  const breakAll = build('word-break: break-all;');
  assert.deepEqual(breakAll.report.unsupportedDetails, []);
  assert.equal(breakAll.deck.slides[0].elements.find((element) => element.type === 'text').h, node.h);

  // `keep-all` forbids the very break this solver makes, so it must be reported.
  const keepAll = build('word-break: keep-all;');
  const reported = keepAll.report.unsupportedDetails.filter((entry) => entry.property === 'wordBreak');
  assert.equal(reported.length, 1, JSON.stringify(keepAll.report.unsupportedDetails));
  assert.ok(/keep-all/u.test(reported[0].reason), reported[0].reason);
});


test('floats pack into a wrapping row and say where that stops being CSS', () => {
  const build = (body, extra = '') => pipeline.convertHtml([
    '<html><head><style>',
    '  .slide { width: 1280px; height: 720px; padding: 40px; }',
    '  .cell { float: left; width: 400px; height: 80px; ' + extra + ' }',
    '</style></head><body><main class="slide">' + body + '</main></body></html>'
  ].join('\n'));

  const boxes = (result) => {
    const out = [];
    const walk = (nodes) => (nodes || []).forEach((node) => { out.push(node); walk(node.children); });
    walk(result.analysis.slides[0].nodes);
    return out;
  };
  const cells = (result) => boxes(result).filter((node) => (node.classes || []).includes('cell'));

  // Two floats share a line; the second one sits exactly after the first.
  const pair = build('<div class="cell"></div><div class="cell"></div>');
  assert.deepEqual(pair.report.unsupportedDetails, []);
  const two = cells(pair);
  assert.equal(two.length, 2);
  assert.equal(two[0].floated, 'left');
  assert.ok(Math.abs(two[0].x - 40 / 96) < 0.005, 'first float starts at the padding edge: ' + two[0].x);
  assert.ok(Math.abs(two[1].x - (40 / 96 + 400 / 96)) < 0.005, 'second float follows it: ' + two[1].x);
  assert.equal(two[0].y, two[1].y);

  // A 1200px line holds two 500px floats, so the third wraps below the tallest.
  const wide = ' style="width: 500px"';
  const three = cells(build('<div class="cell"' + wide + '></div><div class="cell"' + wide
    + '></div><div class="cell"' + wide + '></div>'));
  assert.equal(three.length, 3);
  assert.ok(three[2].y > three[0].y + 0.5, 'the third float wraps: ' + three[2].y);
  assert.equal(three[2].x, three[0].x);

  // `float: right` packs against the end edge.
  const right = cells(build('<div class="cell" style="float: right"></div>'));
  assert.ok(Math.abs((right[0].x + right[0].w) - (40 / 96 + 1200 / 96)) < 0.005,
    'right float hugs the right edge: ' + (right[0].x + right[0].w));

  // A text block that fits inside the float band is translated: the pair is exactly
  // a two-column row, which is what the browser draws.
  const beside = build('<div class="cell"></div><p>text next to the float</p>');
  assert.deepEqual(beside.report.unsupportedDetails, [], 'a fitted pair needs no report');
  const besideText = boxes(beside).find((node) => node.kind === 'text');
  assert.ok(besideText.x >= 40 / 96 + 400 / 96 - 0.005, 'the text sits beside the float: ' + besideText.x);
  // Chrome puts this paragraph at 56px: 40px of slide padding plus the 16px UA margin, which a
  // float does not suppress. Only the lines shift beside the float, not the box.
  assert.ok(Math.abs(besideText.y - (40 + 16) / 96) < 0.005, 'and at the top of the band: ' + besideText.y);

  // Text taller than the band cannot be one box: that is still reported, and the
  // block goes below the float rather than on top of it.
  const wrapped = build('<div class="cell" style="height: 8px"></div><p>text next to the float</p>');
  const reported = wrapped.report.unsupportedDetails.filter((entry) => entry.property === 'float');
  assert.equal(reported.length, 1, JSON.stringify(wrapped.report.unsupportedDetails));
  assert.ok(/wrap its lines beside/u.test(reported[0].reason), reported[0].reason);

  // ...unless it clears first, which is exactly what `clear: both` asks for.
  const cleared = build('<div class="cell"></div><div style="clear: both"></div><p>text below</p>');
  assert.deepEqual(cleared.report.unsupportedDetails, []);

  // Shrink-to-fit floats are max-content, which a container cannot measure.
  const noWidth = pipeline.convertHtml([
    '<html><head><style>',
    '  .slide { width: 1280px; height: 720px; }',
    '  .tag { float: left; font-size: 12px; }',
    '</style></head><body><main class="slide"><div class="tag">标签</div></main></body></html>'
  ].join('\n'));
  const noWidthReport = noWidth.report.unsupportedDetails.filter((entry) => entry.property === 'float');
  assert.equal(noWidthReport.length, 1);
  assert.ok(/declared width/u.test(noWidthReport[0].reason), noWidthReport[0].reason);
});


test('a text box is exactly as tall as its lines, so stacked blocks do not drift', () => {
  const build = (blocks) => pipeline.convertHtml([
    '<html><head><style>',
    '  .slide { width: 1280px; height: 720px; padding: 40px; }',
    '  .line { width: 600px; font-size: 20px; line-height: 1.5; }',
    '  .para { width: 600px; font-size: 13px; line-height: 1.9; }',
    '</style></head><body><main class="slide">' + blocks + '</main></body></html>'
  ].join('\n'));

  const nodes = (result) => {
    const out = [];
    const walk = (list) => (list || []).forEach((node) => { out.push(node); walk(node.children); });
    walk(result.analysis.slides[0].nodes);
    return out.filter((node) => node.kind === 'text');
  };

  // One line at 20px with line-height 1.5 is 30px: 20 * 1.5 / 96 in. No inset, because
  // the emitted text box declares zero insets (lIns/tIns/rIns/bIns="0").
  const single = nodes(build('<div class="line">一行</div>'))[0];
  assert.ok(Math.abs(single.h - (20 * 1.5 / 96)) < 0.002, 'one line is ' + single.h);

  // Wrapped text is lines * fontSize * lineHeight, again with nothing added.
  const para = nodes(build('<div class="para">这是一段用于核对行高的文字，它会在 600 像素宽的盒子里折成若干行，'
    + '而每一行的高度应当等于字号乘以行高倍数。</div>'))[0];
  const lines = Math.round(para.h / (13 * 1.9 / 96));
  assert.ok(lines >= 2, 'the paragraph wraps: ' + para.h);
  assert.ok(Math.abs(para.h - (lines * 13 * 1.9 / 96)) < 0.002, 'lines ' + lines + ' give ' + para.h);

  // Three stacked one-line blocks: each is 30px tall and they do not accumulate a
  // phantom inset - the fourth block starts 90px below the first.
  const stacked = nodes(build('<div class="line">一</div><div class="line">二</div><div class="line">三</div>'));
  assert.equal(stacked.length, 3);
  stacked.forEach((node) => assert.ok(Math.abs(node.h - (30 / 96)) < 0.002, 'block height ' + node.h));
  assert.ok(Math.abs((stacked[2].y - stacked[0].y) - (2 * 30 / 96)) < 0.002,
    'stacking drift: ' + (stacked[2].y - stacked[0].y));
});


test('aspect-ratio turns a width into a height, and yields to a declared height', async () => {
  const build = (body, extra = '') => pipeline.convertHtml([
    '<html><head><style>',
    '  .slide { width: 1280px; height: 720px; padding: 40px; }',
    '  .video { width: 600px; aspect-ratio: 16 / 9; ' + extra + ' }',
    '</style></head><body><main class="slide">' + body + '</main></body></html>'
  ].join('\n'));

  const nodeOf = (result, className) => {
    let found = null;
    const walk = (nodes) => (nodes || []).forEach((node) => {
      if ((node.classes || []).includes(className)) found = node;
      walk(node.children);
    });
    walk(result.analysis.slides[0].nodes);
    return found;
  };

  // 16/9 in a 600px box is 337.5px, so the box is 6.25 x 3.5156in.
  const video = build('<div class="video"></div>');
  assert.deepEqual(video.report.unsupportedDetails, []);
  const box = nodeOf(video, 'video');
  assert.ok(Math.abs(box.h - (600 / (16 / 9) / 96)) < 0.002, 'video height ' + box.h);
  assert.ok(Math.abs((box.w / box.h) - 16 / 9) < 0.01, 'ratio ' + (box.w / box.h));

  // A plain number works too, and `aspect-ratio: auto` is the initial value.
  const square = nodeOf(build('<div class="video" style="width: 200px; aspect-ratio: 1"></div>'), 'video');
  assert.ok(Math.abs(square.w - square.h) < 0.002, 'square ' + square.w + 'x' + square.h);
  const auto = build('<div class="video" style="height: 50px; aspect-ratio: auto"></div>');
  assert.deepEqual(auto.report.unsupportedDetails, []);
  assert.ok(Math.abs(nodeOf(auto, 'video').h - (50 / 96)) < 0.002, 'declared height wins');

  // A declared height always wins: the ratio only fills in a missing dimension.
  const fixed = nodeOf(build('<div class="video" style="height: 100px"></div>'), 'video');
  assert.ok(Math.abs(fixed.h - (100 / 96)) < 0.002, 'height kept ' + fixed.h);
  assert.ok(Math.abs(fixed.w - 6.25) < 0.002, 'width kept ' + fixed.w);

  // Images: the ratio sets the frame and `object-fit` decides the crop inside it.
  await withTempDir('native-aspect-', (directory) => {
    const file = writePngFixture(directory, 'wide.png', 800, 400);
    const result = pipeline.convertHtml([
      '<html><head><style>',
      '  .slide { width: 1280px; height: 720px; padding: 40px; }',
      '  img { width: 480px; aspect-ratio: 1 / 1; object-fit: cover; }',
      '</style></head><body><main class="slide">',
      '  <img src="' + file.replace(/\\/gu, '/') + '" alt="">',
      '</main></body></html>'
    ].join('\n'));
    const image = result.deck.slides[0].elements.find((element) => element.type === 'image');
    assert.ok(image, 'the image must survive');
    assert.ok(Math.abs(image.h - (480 / 96)) < 0.002, 'square frame ' + image.h);
    assert.equal(image.fit, 'cover');
  });
});


test('stretch alignment never resizes a box whose CSS pinned that axis', () => {
  const html = [
    '<html><head><style>',
    '  .slide { width: 1280px; height: 720px; padding: 40px; }',
    '  .row { display: flex; flex-direction: row; align-items: stretch; width: 900px; }',
    '  .tall { width: 300px; height: 300px; background: #EEEEEE; }',
    '  .pinned { width: 200px; height: 80px; background: #DDDDDD; }',
    '  .free { width: 200px; background: #CCCCCC; }',
    '</style></head><body><main class="slide">',
    '  <div class="row"><div class="tall"></div><div class="pinned">pinned</div>',
    '  <div class="free">free</div></div>',
    '</main></body></html>'
  ].join('\n');
  const result = pipeline.convertHtml(html);
  assert.deepEqual(result.errors, []);
  const row = result.deck.slides[0].elements.find((element) => element.type === 'container');
  assert.ok(row, 'the row must stay a declarative container');

  const withText = (element, needle) => {
    if (typeof element.text === 'string' && element.text.indexOf(needle) !== -1) return true;
    return (element.children || []).some((child) => withText(child, needle));
  };
  const pinned = row.children.find((child) => withText(child, 'pinned'));
  const free = row.children.find((child) => withText(child, 'free'));
  assert.ok(pinned && free, 'both text boxes are row children');
  assert.equal(pinned.fixedHeight, true, 'the pinned box travels with its flag');
  assert.ok(Math.abs(pinned.h - (80 / 96)) < 0.002, 'the pinned box keeps its own height: ' + pinned.h);
  assert.equal(free.fixedHeight, undefined);

  // The engine replays the same rule: the pinned box keeps 80px, the free one fills.
  const { layoutSlide } = require('../native/engine/layout');
  const laid = layoutSlide(result.deck.slides[0], { width: 13.333, height: 7.5 }, result.deck.theme || {}, {});
  const elements = Array.isArray(laid) ? laid : (laid.elements || []);
  const pinnedBox = elements.find((element) => typeof element.text === 'string' && element.text.indexOf('pinned') !== -1);
  const freeBox = elements.find((element) => typeof element.text === 'string' && element.text.indexOf('free') !== -1);
  assert.ok(pinnedBox && freeBox, 'both boxes are emitted');
  assert.ok(Math.abs(pinnedBox.h - (80 / 96)) < 0.002, 'pinned height ' + pinnedBox.h);
  assert.ok(freeBox.h > 3, 'the unpinned box stretches: ' + freeBox.h);
  assert.ok(Math.abs(pinnedBox.y - freeBox.y) < 0.002, 'a non-stretched item aligns at the start');
});


test('a relative offset moves the box and leaves its siblings where they were', () => {
  const html = [
    '<html><head><style>',
    '  .slide { width: 1280px; height: 720px; padding: 40px; }',
    '  .nudge { position: relative; top: 20px; left: 30px; width: 200px; height: 60px; background: #EEE; }',
    '  .sticky { position: sticky; top: 0; width: 200px; height: 40px; background: #DDD; }',
    '  .plain { width: 200px; height: 40px; background: #CCC; }',
    '</style></head><body><main class="slide">',
    '  <div class="nudge"></div><div class="sticky"></div><div class="plain"></div>',
    '</main></body></html>'
  ].join('\n');
  const result = pipeline.convertHtml(html);
  assert.deepEqual(result.errors, []);
  assert.deepEqual(result.report.unsupportedDetails, [], 'relative and sticky are translated, not reported');

  const top = result.analysis.slides[0].nodes;
  const nudge = top.find((node) => (node.classes || []).includes('nudge'));
  const sticky = top.find((node) => (node.classes || []).includes('sticky'));
  const plain = top.find((node) => (node.classes || []).includes('plain'));
  // 40px padding + 30px / 20px of offset, in inches.
  assert.ok(Math.abs(nudge.x - (70 / 96)) < 0.002, 'nudged right: ' + nudge.x);
  assert.ok(Math.abs(nudge.y - (60 / 96)) < 0.002, 'nudged down: ' + nudge.y);
  assert.ok(Math.abs(nudge.relativeShift.dx - 30 / 96) < 0.002, 'shift dx ' + nudge.relativeShift.dx);
  assert.ok(Math.abs(nudge.relativeShift.dy - 20 / 96) < 0.002, 'shift dy ' + nudge.relativeShift.dy);
  // Siblings keep the static flow position: the nudge is visual only.
  assert.ok(Math.abs(sticky.y - (100 / 96)) < 0.002, 'sticky keeps the flow slot: ' + sticky.y);
  assert.ok(Math.abs(plain.y - (140 / 96)) < 0.002, 'the next block is unmoved: ' + plain.y);
  // In a slide nothing scrolls, so `sticky` never sticks and needs no offset.
  assert.equal(sticky.relativeShift, undefined);

  // The nudge travels in the spec and is applied by the engine, so a container child
  // is not placed twice and a flat element is not shifted twice.
  const cards = pipeline.convertHtml([
    '<html><head><style>',
    '  .slide { width: 1280px; height: 720px; padding: 40px; }',
    '  .card { width: 400px; padding: 20px; background: #FFFFFF; }',
    '  .card p { margin: 0; font-size: 14px; }',
    '  .tag { position: relative; top: -12px; left: 200px; width: 80px; height: 24px; background: #B4633A; }',
    '</style></head><body><main class="slide">',
    '  <div class="card"><p>body copy</p><div class="tag">NEW</div></div>',
    '</main></body></html>'
  ].join('\n'));
  const card = cards.deck.slides[0].elements.find((element) => element.type === 'container');
  assert.ok(card, 'the card stays a declarative container');
  assert.deepEqual(cards.report.containerFallbacks, []);
  const tag = card.children.find((child) => JSON.stringify(child).includes('NEW'));
  assert.ok(tag && tag.relativeShift, 'the shift travels beside the static position');

  const { layoutSlide } = require('../native/engine/layout');
  const laid = layoutSlide(cards.deck.slides[0], { width: 13.333, height: 7.5 }, cards.deck.theme || {}, {});
  const elements = Array.isArray(laid) ? laid : (laid.elements || []);
  const tagBox = elements.find((element) => JSON.stringify(element).includes('NEW'));
  const copy = elements.find((element) => typeof element.text === 'string' && element.text.includes('body copy'));
  assert.ok(tagBox && copy, 'both are emitted');
  assert.ok(Math.abs(tagBox.x - (copy.x + 200 / 96)) < 0.004, 'shifted right of the copy: ' + tagBox.x);
  // The tag follows the copy in the flow, so "up" means above its own slot.
  assert.ok(tagBox.y < copy.y + copy.h, 'shifted up from its slot: ' + tagBox.y);
});

test('a border side can be recoloured by its longhand', () => {
  const html = [
    '<html><head><style>',
    '  .slide { width: 1280px; height: 720px; padding: 40px; }',
    '  .card { width: 300px; height: 80px; background: #FFFFFF; border-top: 3px solid #EEEEEE; }',
    '  .card.active { border-top-color: #123456; }',
    '</style></head><body><main class="slide">',
    '  <div class="card"></div><div class="card active"></div>',
    '</main></body></html>'
  ].join('\n');
  const result = pipeline.convertHtml(html);
  assert.deepEqual(result.report.unsupportedDetails, [], 'a per-side colour longhand is translated');
  const strips = result.deck.slides[0].elements.filter((element) => element.edge);
  assert.equal(strips.length, 2, 'both cards get an accent strip');
  assert.equal(strips[0].edge.color, 'EEEEEE');
  assert.equal(strips[1].edge.color, '123456', 'the longhand wins over the shorthand colour');
  assert.ok(Math.abs(strips[1].edge.width - 2.25) < 0.01, 'the shorthand still supplies the width: ' + strips[1].edge.width);
});


test('declared chart styling reaches the chart part, not just the spec', async () => {
  const html = [
    '<html><head><style>',
    '  .slide { width: 1280px; height: 720px; padding: 40px; }',
    '  .chart { width: 900px; height: 420px; }',
    '</style></head><body><main class="slide">',
    '  <table class="chart" data-chart="bar" data-chart-title="收入"',
    '         data-chart-colors="#F2A24C,#4FB3A8" data-chart-legend="bottom" data-chart-grid="false"',
    '         data-chart-axis-titles="季度|万元" data-chart-labels="value" data-chart-value-format="#,##0"',
    '         data-chart-grouping="stacked" data-chart-dir="bar" data-chart-text-color="#3F5450">',
    '    <thead><tr><th>季度</th><th>收入</th><th>成本</th></tr></thead>',
    '    <tbody><tr><td>Q1</td><td>320</td><td>210</td></tr><tr><td>Q2</td><td>418</td><td>246</td></tr></tbody>',
    '  </table>',
    '</main></body></html>'
  ].join('\n');
  const result = pipeline.convertHtml(html);
  assert.deepEqual(result.errors, []);
  assert.deepEqual(result.report.unsupportedDetails, []);
  const chart = result.deck.slides[0].elements.find((element) => element.type === 'chart');
  assert.ok(chart, 'the chart element exists');
  const options = chart.options || {};
  assert.deepEqual(options.chartColors, ['F2A24C', '4FB3A8'], 'one colour per series');
  assert.equal(options.showLegend, true);
  assert.equal(options.legendPos, 'b');
  assert.equal(options.valGridLine.style, 'none');
  assert.equal(options.catAxisTitle, '季度');
  assert.equal(options.valAxisTitle, '万元');
  assert.equal(options.showCatAxisTitle, true);
  assert.equal(options.showValAxisTitle, true);
  assert.equal(options.showValue, true);
  assert.equal(options.valLabelFormatCode, '#,##0');
  assert.equal(options.barGrouping, 'stacked');
  assert.equal(options.barDir, 'bar');
  assert.equal(options.titleColor, '3F5450');
  assert.equal(options.catAxisLabelColor, '3F5450');

  await withTempDir('native-chart-', async (directory) => {
    const JSZip = require(require.resolve('jszip', { paths: [require.resolve('../native/engine/native_pptx')] }));
    const { generatePptx } = require('../native/engine/native_pptx');
    const output = require('node:path').join(directory, 'chart.pptx');
    await generatePptx(result.deck, output);
    const zip = await JSZip.loadAsync(require('node:fs').readFileSync(output));
    const chartName = Object.keys(zip.files).find((name) => /charts\/chart\d+\.xml$/u.test(name));
    const chartEntry = chartName ? zip.file(chartName) : null;
    assert.ok(chartEntry, 'the chart is a real chart part');
    const xml = await chartEntry.async('string');
    assert.ok(xml.includes('<c:barDir val="bar"'), 'declared direction');
    assert.ok(xml.includes('<c:grouping val="stacked"'), 'declared grouping');
    assert.ok(xml.includes('<c:legendPos val="b"'), 'declared legend position');
    assert.ok(xml.includes('F2A24C') && xml.includes('4FB3A8'), 'declared series colours');
    assert.ok(!xml.includes('<c:majorGridlines'), 'gridlines are off');
    assert.ok(xml.includes('<c:showVal val="1"'), 'value labels are on');
    assert.ok(xml.includes('3F5450'), 'the declared text colour reaches the axis labels');
  });
});

test('chart styling that cannot be translated is reported instead of dropped', () => {
  const html = [
    '<html><head><style>',
    '  .slide { width: 1280px; height: 720px; padding: 40px; }',
    '  .chart { width: 800px; height: 400px; }',
    '</style></head><body><main class="slide">',
    '  <div class="chart" data-chart="line" data-values="1,2,3"',
    '       data-chart-colors="#123456,notacolor" data-chart-legend="diagonal"',
    '       data-chart-grouping="wobble" data-chart-labels="value,sparkle"',
    '       data-chart-grid="maybe" data-chart-dir="sideways"></div>',
    '</main></body></html>'
  ].join('\n');
  const result = pipeline.convertHtml(html);
  const reported = result.report.unsupportedDetails.map((entry) => entry.property);
  ['data-chart-colors', 'data-chart-legend', 'data-chart-grouping', 'data-chart-labels',
    'data-chart-grid', 'data-chart-dir'].forEach((property) => {
    assert.ok(reported.includes(property), property + ' must be reported: ' + reported.join(', '));
  });
  const chart = result.deck.slides[0].elements.find((element) => element.type === 'chart');
  // The valid half of the colour list survives: one colour, one rejection.
  assert.deepEqual(chart.options.chartColors, ['123456']);
});


test('table cells keep their padding, alignment and row heights', async () => {
  const html = [
    '<html><head><style>',
    '  .slide { width: 1280px; height: 720px; padding: 40px; }',
    '  table { width: 900px; font-size: 14px; }',
    '  td { padding: 10px 14px; vertical-align: middle; border-bottom: 1px solid #DDD; }',
    '  th { padding: 12px 14px; letter-spacing: 1px; text-align: left; }',
    '  td.big { font-size: 24px; padding: 18px 14px; }',
    '</style></head><body><main class="slide">',
    '  <table><thead><tr><th>项目</th><th>本月</th></tr></thead>',
    '  <tbody><tr><td>华东</td><td>1,284</td></tr>',
    '  <tr><td class="big">华南</td><td>1,096</td></tr></tbody></table>',
    '</main></body></html>'
  ].join('\n');
  const result = pipeline.convertHtml(html);
  assert.deepEqual(result.errors, []);
  assert.deepEqual(result.report.unsupportedDetails, [], 'padding and vertical-align on a cell are translated');
  const table = result.deck.slides[0].elements.find((element) => element.type === 'table');
  assert.ok(table, 'the table element exists');

  const header = table.rows[0][0].options;
  // 10px/14px padding is 7.5pt/10.5pt in PowerPoint's order: top, right, bottom, left.
  assert.deepEqual(table.rows[1][0].options.margin, [7.5, 10.5, 7.5, 10.5]);
  assert.deepEqual(header.margin, [9, 10.5, 9, 10.5]);
  assert.equal(table.rows[1][0].options.valign, 'middle');
  assert.equal(header.charSpacing, 0.75, 'letter-spacing travels as charSpacing');

  // Rows are measured, not assumed: the 24px row is taller, and the heights add up.
  const rowHeights = table.options.rowH;
  assert.equal(rowHeights.length, 3);
  assert.ok(rowHeights[0] > rowHeights[1], 'the padded header is taller than a plain row');
  assert.ok(rowHeights[2] > rowHeights[1], 'a 24px cell makes its row taller');
  const total = rowHeights.reduce((sum, height) => sum + height, 0);
  assert.ok(Math.abs(total - table.h) < 0.01, 'the element height is the sum of the rows: ' + table.h);

  await withTempDir('native-table-', async (directory) => {
    const JSZip = require(require.resolve('jszip', { paths: [require.resolve('../native/engine/native_pptx')] }));
    const { generatePptx } = require('../native/engine/native_pptx');
    const output = require('node:path').join(directory, 'table.pptx');
    await generatePptx(result.deck, output);
    const zip = await JSZip.loadAsync(require('node:fs').readFileSync(output));
    const slideName = Object.keys(zip.files).find((name) => /slides\/slide1\.xml$/u.test(name));
    const xml = await zip.file(slideName).async('string');
    assert.ok(xml.includes('marT="114300"'), 'the 9pt header padding reaches the cell');
    assert.ok(xml.includes('marL="133350"'), 'the 10.5pt horizontal padding reaches the cell');
    assert.ok(xml.includes('anchor="ctr"'), 'middle alignment is a valid anchor');
    assert.ok(!xml.includes('anchor="mid"'), 'anchor="mid" is not valid OOXML');
    assert.ok(xml.includes('spc="75"'), 'letter-spacing is written');
    const heights = (xml.match(/<a:tr h="(\d+)"/gu) || []).map((match) => Number(match.replace(/\D/gu, '')));
    assert.equal(heights.length, 3, 'three rows are drawn');
    assert.ok(heights[2] > heights[1], 'the drawn rows follow the measured heights');
  });
});


test('text that fits a float band becomes a two-column pair, and the rest stays reported', () => {
  const build = (body) => pipeline.convertHtml([
    '<html><head><style>',
    '  body { margin: 0; }',
    '  .slide { width: 1280px; height: 720px; padding: 40px; }',
    '  .card { width: 900px; }',
    '  .thumb { float: left; width: 320px; height: 240px; background: #17332F; margin-right: 24px; }',
    '  p { font-size: 15px; line-height: 1.7; margin: 0 0 8px; }',
    '</style></head><body><main class="slide">',
    body,
    '</main></body></html>'
  ].join('\n'));

  const childrenOf = (result) => {
    const card = result.analysis.slides[0].nodes.find((node) => (node.classes || []).includes('card'));
    return card ? card.children : [];
  };

  // Two short paragraphs fit inside the 240px band, so both sit beside the float.
  const paired = build('<div class="card"><div class="thumb"></div><p>短句一。</p><p>短句二。</p></div>');
  assert.deepEqual(paired.report.unsupportedDetails, [], 'a fitted pair needs no report');
  const pairedKids = childrenOf(paired);
  const floatBox = pairedKids.find((node) => node.floated);
  const texts = pairedKids.filter((node) => node.kind === 'text');
  assert.equal(texts.length, 2);
  assert.ok(Math.abs(texts[0].x - (floatBox.x + floatBox.w + 24 / 96)) < 0.002,
    'the text starts after the float margin: ' + texts[0].x);
  assert.ok(Math.abs(texts[0].y - floatBox.y) < 0.002, 'and at the top of the band');
  assert.ok(Math.abs(texts[1].y - (texts[0].y + texts[0].h + 8 / 96)) < 0.01,
    'the second paragraph keeps its own margin: ' + (texts[1].y - (texts[0].y + texts[0].h)));
  assert.ok(texts[1].y + texts[1].h <= floatBox.y + floatBox.h + 0.01, 'the pair stays in the band');

  // A paragraph taller than the band cannot be one box: it is reported and stacked.
  const tall = build('<div class="card"><div class="thumb" style="height: 60px"></div>'
    + '<p>' + '这段文字明显比色块高得多，浏览器会让它绕到色块下方。'.repeat(6) + '</p></div>');
  const reasons = tall.report.unsupportedDetails.map((entry) => entry.property);
  assert.ok(reasons.includes('float'), 'the wrap-beside case is reported: ' + reasons.join(','));
  const tallKids = childrenOf(tall);
  const tallFloat = tallKids.find((node) => node.floated);
  const tallText = tallKids.find((node) => node.kind === 'text');
  assert.ok(tallText.y >= tallFloat.y + tallFloat.h - 0.01, 'it starts below the float instead');

  // A painted block spans the full width even beside a float, so it is not narrowed.
  const painted = build('<div class="card"><div class="thumb"></div>'
    + '<p style="background: #EEE">有底色的段落不会被收窄。</p></div>');
  assert.ok(painted.report.unsupportedDetails.map((entry) => entry.property).includes('float'));
  const paintedText = childrenOf(painted).find((node) => node.kind === 'text');
  assert.ok(Math.abs(paintedText.x - 0.0) < 1.1, 'it keeps the container width');

  // An absolutely positioned block is out of flow: a float cannot shorten it, and
  // reporting it as "placed below the float" would be wrong.
  const absolute = build('<div class="card"><div class="thumb"></div>'
    + '<div style="position: absolute; top: 10px; left: 10px">角标</div></div>');
  assert.deepEqual(absolute.report.unsupportedDetails, [], 'an absolute block is not shortened by a float');
});


test('a grid cell aligns its child, and a declared width beats stretch', () => {
  const build = (childCss, containerCss = '') => pipeline.convertHtml([
    '<html><head><style>',
    '  .slide { width: 1280px; height: 720px; padding: 40px; }',
    '  .grid { display: grid; grid-template-columns: 1fr 1fr; gap: 0; width: 1000px; ' + containerCss + ' }',
    '  .a { ' + childCss + ' }',
    '</style></head><body><main class="slide">',
    '  <div class="grid"><div class="a">x</div><div>b</div></div>',
    '</main></body></html>'
  ].join('\n'));

  const gridOf = (result) => {
    const flat = [];
    const walk = (nodes) => (nodes || []).forEach((node) => { flat.push(node); walk(node.children); });
    walk(result.analysis.slides[0].nodes);
    return flat.find((node) => (node.classes || []).includes('grid'));
  };

  // Without an alignment a declared width still wins over the default stretch, and the
  // box is measured at that width rather than at the cell's.
  const plain = build('width: 200px; height: 60px');
  assert.deepEqual(plain.report.unsupportedDetails, []);
  const plainChild = gridOf(plain).children[0];
  assert.ok(Math.abs(plainChild.w - 200 / 96) < 0.002, 'declared width survives: ' + plainChild.w);
  assert.ok(Math.abs(plainChild.x - 40 / 96) < 0.002, 'and starts at the cell edge: ' + plainChild.x);

  // `justify-self: center` centres it inside the cell it owns (500px wide here).
  const centred = build('width: 200px; height: 60px; justify-self: center');
  assert.deepEqual(centred.report.unsupportedDetails, [], 'justify-self is translated, not reported');
  const centredChild = gridOf(centred).children[0];
  assert.ok(Math.abs(centredChild.x - (40 / 96 + (500 / 96 - 200 / 96) / 2)) < 0.003,
    'centred in its track: ' + centredChild.x);
  assert.equal(centredChild.justifySelf, 'center');

  // The container's `justify-items` supplies the same thing for every child.
  const items = build('width: 200px; height: 60px', 'justify-items: center;');
  assert.deepEqual(items.report.unsupportedDetails, []);
  assert.ok(Math.abs(gridOf(items).children[0].x - (40 / 96 + (500 / 96 - 200 / 96) / 2)) < 0.003);

  // `justify-self: end` pushes it to the far edge, and the spec carries the choice so
  // the engine reaches the same x instead of demoting the container.
  const ending = build('width: 200px; height: 60px; justify-self: end');
  const endChild = gridOf(ending).children[0];
  assert.ok(Math.abs(endChild.x - (40 / 96 + 500 / 96 - 200 / 96)) < 0.003, 'end: ' + endChild.x);
  assert.deepEqual(ending.report.containerFallbacks, [], 'the engine agrees about the cell');
});

test('a pill centres its one line the way flex does', () => {
  const result = pipeline.convertHtml([
    '<html><head><style>',
    '  .slide { width: 1280px; height: 720px; padding: 40px; }',
    '  .pill {',
    '    width: 200px; height: 56px; background: #17332F; border-radius: 28px;',
    '    display: flex; flex-direction: row; align-items: center; justify-content: center;',
    '  }',
    '  .pill span { font-size: 13px; font-weight: 700; color: #DFF3EF; }',
    '</style></head><body><main class="slide">',
    '  <div class="pill"><span>标签</span></div>',
    '</main></body></html>'
  ].join('\n'));
  assert.deepEqual(result.report.unsupportedDetails, []);
  const pill = result.deck.slides[0].elements.find((element) => element.type === 'container');
  assert.ok(pill, 'the pill is a container with a surface');
  assert.equal(pill.children.length, 1);
  const label = pill.children[0];
  // A column wrapper would read `align` as the inline axis, so the block-axis centring
  // has to be the text box's own anchor.
  assert.equal(label.valign, 'middle', 'the line sits in the middle of the pill');
  assert.equal(label.align, 'center', 'and is centred across it');
  assert.ok(Math.abs(label.h - (56 - 0) / 96) < 0.01, 'the box still fills the pill: ' + label.h);
});


test('a wrapped row distributes its lines with align-content', () => {
  const build = (alignContent, extraCss = '') => pipeline.convertHtml([
    '<html><head><style>',
    '  .slide { width: 1280px; height: 720px; padding: 40px; }',
    '  .row { display: flex; flex-direction: row; flex-wrap: wrap; gap: 10px;',
    '    width: 600px; height: 400px; align-content: ' + alignContent + '; }',
    '  .c { width: 280px; height: 80px; background: #CCCCCC; }',
    '  .c.mid { align-self: center; height: 40px; }',
    '</style></head><body><main class="slide"><div class="row">',
    '  <div class="c">1</div><div class="c mid">2</div><div class="c">3</div><div class="c">4</div>',
    '</div></main></body></html>',
    extraCss
  ].join('\n'));

  const lines = (result) => {
    const row = result.analysis.slides[0].nodes[0];
    const pooled = {};
    // The centred item owns its own y (it aligns inside its line), so the lines are the
    // ys of the plain items.
    (row.children || []).filter((node) => !(node.classes || []).includes('mid'))
      .forEach((node) => { pooled[String(node.y.toFixed(3))] = true; });
    return Object.keys(pooled).map(Number).sort((a, b) => a - b);
  };
  // 400px height, two 80px lines and a 10px gap leave 230px of free cross space.
  const free = 400 / 96 - (2 * 80 / 96 + 10 / 96);
  assert.ok(Math.abs(free - 2.396) < 0.01, 'free space is ' + free);

  const start = build('flex-start');
  assert.deepEqual(start.report.unsupportedDetails, [], 'align-content is translated, not reported');
  const startLines = lines(start);
  assert.equal(startLines.length, 2);
  assert.ok(Math.abs(startLines[0] - 40 / 96) < 0.002, 'start: ' + startLines[0]);
  assert.ok(Math.abs(startLines[1] - (40 / 96 + 80 / 96 + 10 / 96)) < 0.002);

  const centre = build('center');
  const centreLines = lines(centre);
  assert.ok(Math.abs(centreLines[0] - (40 / 96 + free / 2)) < 0.003, 'center: ' + centreLines[0]);
  assert.ok(Math.abs(centreLines[1] - (40 / 96 + free / 2 + 90 / 96)) < 0.003);
  // The engine has to reach the same lines, or the row would fall back to absolute boxes.
  assert.deepEqual(centre.report.containerFallbacks, []);
  assert.ok(centre.report.maxBoxDelta < 0.012, 'delta was ' + centre.report.maxBoxDelta);

  const ending = build('flex-end');
  assert.ok(Math.abs(lines(ending)[1] - (40 / 96 + 400 / 96 - 80 / 96)) < 0.003, 'end');

  const between = build('space-between');
  assert.ok(Math.abs(lines(between)[0] - 40 / 96) < 0.002, 'the first line stays put');
  assert.ok(Math.abs(lines(between)[1] - (40 / 96 + 400 / 96 - 80 / 96)) < 0.003, 'the last one is flush');

  // `stretch` is the default: the leftover height goes to the lines themselves, so a
  // centred item inside a grown line sits lower than it would in a tight one.
  const stretched = build('stretch');
  const stretchedRow = stretched.analysis.slides[0].nodes[0];
  const mid = stretchedRow.children.find((node) => (node.classes || []).includes('mid'));
  const extraPerLine = free / 2;
  assert.ok(Math.abs(mid.y - (40 / 96 + (80 / 96 + extraPerLine - 40 / 96) / 2)) < 0.01,
    'centred inside the grown line: ' + mid.y);
});


test('a flex column sizes and justifies along the height', () => {
  const build = (colCss, childCss) => pipeline.convertHtml([
    '<html><head><style>',
    '  .slide { width: 1280px; height: 720px; padding: 40px; }',
    '  .col { display: flex; flex-direction: column; width: 600px; height: 400px; background: #EEEEEE; ' + colCss + ' }',
    '  .b { ' + childCss + ' background: #CCCCCC; }',
    '</style></head><body><main class="slide"><div class="col">',
    '  <div class="b">a</div><div class="b">b</div><div class="b">c</div>',
    '</div></main></body></html>'
  ].join('\n'));

  const column = (result) => result.analysis.slides[0].nodes[0];

  // `justify-content` was silently ignored on a column: both sides put the stack at the
  // top, so the deck rendered it uncentred. It is distributed now, and the engine has to
  // reach the same lines or the container would fall back to absolute boxes.
  const centred = build('justify-content: center;', 'padding: 10px;');
  const centredColumn = column(centred);
  const stack = centredColumn.children.reduce((sum, node) => sum + node.h, 0);
  const free = 4.1667 - stack;
  assert.ok(Math.abs(centredColumn.children[0].y - (0.4167 + free / 2)) < 0.01,
    'the stack is centred: ' + centredColumn.children[0].y);
  assert.deepEqual(centred.report.containerFallbacks, []);
  assert.ok(centred.report.maxBoxDelta < 0.012, 'delta was ' + centred.report.maxBoxDelta);

  const ending = build('justify-content: flex-end;', 'padding: 10px;');
  const endingColumn = column(ending);
  const last = endingColumn.children[endingColumn.children.length - 1];
  assert.ok(Math.abs(last.y + last.h - (0.4167 + 4.1667)) < 0.01,
    'the stack sits at the bottom: ' + (last.y + last.h));

  // `flex: 1` shares the height: three items of a 400px column each get a third, and the
  // stack stays contiguous (the cursor used to keep the pre-flex positions).
  const grown = build('', 'flex: 1; padding: 10px;');
  const grownColumn = column(grown);
  const heights = grownColumn.children.map((node) => node.h);
  const ys = grownColumn.children.map((node) => node.y);
  assert.ok(Math.abs(heights[0] - heights[1]) < 0.002 && Math.abs(heights[1] - heights[2]) < 0.002,
    'equal shares: ' + heights.join(','));
  assert.ok(Math.abs(heights.reduce((sum, h) => sum + h, 0) - 4.1667) < 0.01, 'it fills the column');
  assert.ok(Math.abs(ys[1] - (ys[0] + heights[0])) < 0.002, 'contiguous: ' + ys.join(','));
  assert.deepEqual(grown.report.containerFallbacks, []);
});

test('a flow margin is part of the box it sits in', () => {
  // A padded card keeps its last child's bottom margin (nothing collapses through the
  // padding), and a container child's own margin separates it from the next sibling.
  // Both were dropped before, which made the analyzer disagree with the engine about
  // where the following block starts.
  const result = pipeline.convertHtml([
    '<html><head><style>',
    '  .slide { width: 1280px; height: 720px; padding: 40px; }',
    '  .col { width: 700px; }',
    '  .card { padding: 18px 22px; background: #FFFFFF; margin: 0 0 14px 0; }',
    '  .card p { margin: 0 0 8px 0; font-size: 13px; line-height: 1.95; }',
    '  .next { background: #DDDDDD; padding: 10px; }',
    '</style></head><body><main class="slide"><div class="col">',
    '  <div class="card"><p>copy</p></div>',
    '  <div class="next">next</div>',
    '</div></main></body></html>'
  ].join('\n'));
  assert.deepEqual(result.report.unsupportedDetails, []);
  const col = result.analysis.slides[0].nodes[0];
  const card = col.children[0];
  const next = col.children[1];
  // 18 top + one line of text + 8 of paragraph margin + 18 bottom, in inches.
  const textLine = card.children[0].h;
  assert.ok(Math.abs(card.h - (18 / 96 + textLine + 8 / 96 + 18 / 96)) < 0.01, 'card height ' + card.h);
  // And the card's own 14px bottom margin still pushes the next block down.
  assert.ok(Math.abs(next.y - (card.y + card.h + 14 / 96)) < 0.01, 'next starts after the margin: ' + next.y);
  assert.deepEqual(result.report.containerFallbacks, []);
  assert.ok(result.report.maxBoxDelta < 0.012, 'delta was ' + result.report.maxBoxDelta);
});


test('a stretched row fills the height its parent gave it', () => {
  // `flex: 1` sizes the row *after* its children were laid out, so the cross-axis
  // alignment has to be resolved again: `align-items: stretch` fills the row's final
  // height, not just the tallest sibling.
  const result = pipeline.convertHtml([
    '<html><head><style>',
    '  .slide { width: 1280px; height: 720px; padding: 40px; }',
    '  .body { display: flex; flex-direction: column; width: 1000px; height: 600px; gap: 20px; }',
    '  .head { height: 80px; background: #DDDDDD; }',
    '  .row { display: flex; flex-direction: row; flex: 1; gap: 20px; }',
    '  .card { flex: 1; background: #EEEEEE; padding: 12px; }',
    '  .card p { margin: 0; font-size: 13px; }',
    '</style></head><body><main class="slide"><div class="body">',
    '  <div class="head"></div>',
    '  <div class="row"><div class="card"><p>left</p></div><div class="card"><p>right</p></div></div>',
    '</div></main></body></html>'
  ].join('\n'));
  assert.deepEqual(result.report.unsupportedDetails, []);
  const body = result.analysis.slides[0].nodes[0];
  const row = body.children.find((node) => (node.classes || []).includes('row'));
  const cards = row.children;
  // 600 − 80 head − 20 gap = 500px for the row, which `flex: 1` gives it.
  assert.ok(Math.abs(row.h - 500 / 96) < 0.02, 'the row takes the leftover: ' + row.h);
  cards.forEach((card) => {
    assert.ok(Math.abs(card.h - row.h) < 0.01, 'the card fills the row: ' + card.h + ' vs ' + row.h);
  });
  assert.deepEqual(result.report.containerFallbacks, []);
  assert.ok(result.report.maxBoxDelta < 0.012, 'delta was ' + result.report.maxBoxDelta);
});


test('a wrapping column breaks by height and starts the next column', () => {
  const build = (containerCss, itemCss) => pipeline.convertHtml([
    '<html><head><style>',
    '  .slide { width: 1280px; height: 720px; padding: 40px; }',
    '  .cols { display: flex; flex-direction: column; flex-wrap: wrap; width: 900px; ' + containerCss + ' }',
    '  .c { ' + itemCss + ' background: #CCCCCC; }',
    '</style></head><body><main class="slide"><div class="cols">',
    '  <div class="c">1</div><div class="c">2</div><div class="c">3</div>',
    '  <div class="c">4</div><div class="c">5</div>',
    '</div></main></body></html>'
  ].join('\n'));

  // 300px of height, items of 120px and a 12px gap: three fit (120*3 + 12*2 = 384 > 300),
  // so two per column and the third item opens the second column.
  const first = build('height: 300px; gap: 12px;', 'width: 200px; height: 120px;');
  assert.deepEqual(first.report.unsupportedDetails, []);
  assert.deepEqual(first.report.containerFallbacks, []);
  const firstColumn = first.analysis.slides[0].nodes[0];
  const xs = firstColumn.children.map((node) => Number(node.x.toFixed(3)));
  const ys = firstColumn.children.map((node) => Number(node.y.toFixed(3)));
  // Two items per column: 0+1, 2+3, then 4 opens a third column.
  assert.deepEqual(xs.slice(0, 2), [xs[0], xs[0]], 'the first column holds two: ' + xs.join(','));
  assert.deepEqual(xs.slice(2, 4), [xs[2], xs[2]], 'the second column holds two: ' + xs.join(','));
  assert.ok(xs[4] > xs[2] && xs[2] > xs[0], 'each column starts further right: ' + xs.join(','));
  assert.ok(Math.abs(ys[1] - ys[0]) > 0.5, 'items stack down a column');
  assert.deepEqual([ys[0], ys[2], ys[4]], [ys[0], ys[0], ys[0]], 'each column starts at the top: ' + ys.join(','));
  assert.ok(Math.abs(ys[1] - ys[3]) < 0.01, 'both columns put their second item at the same offset');

  assert.ok(first.report.maxBoxDelta < 0.012, 'delta was ' + first.report.maxBoxDelta);

  // `align-content` puts the columns on the inline axis, like the lines of a wrapped row.
  const spread = build('height: 300px; gap: 12px; align-content: space-between;', 'width: 200px; height: 120px;');
  const spreadColumn = spread.analysis.slides[0].nodes[0];
  const spreadXs = spreadColumn.children.map((node) => node.x);
  // 900px wide, three columns of 200px: the last one is pushed to the far edge and the
  // one before it sits between the two.
  assert.ok(Math.abs(spreadXs[4] - (spreadColumn.x + 900 / 96 - 200 / 96)) < 0.02,
    'space-between pushes the last column to the edge: ' + spreadXs[4]);
  assert.ok(spreadXs[2] > spreadXs[0] && spreadXs[2] < spreadXs[4],
    'the middle column sits between them: ' + spreadXs.join(','));
  assert.deepEqual(spread.report.containerFallbacks, []);

  // A column is as wide as its widest item, so a narrower item is centred inside it.
  const centred = pipeline.convertHtml([
    '<html><head><style>',
    '  .slide { width: 1280px; height: 720px; padding: 40px; }',
    '  .cols { display: flex; flex-direction: column; flex-wrap: wrap; width: 900px; gap: 12px; height: 260px; align-content: flex-start; align-items: center; }',
    '  .c { height: 100px; background: #CCCCCC; }',
    '  .wide { width: 200px; }',
    '  .narrow { width: 160px; }',
    '</style></head><body><main class="slide"><div class="cols">',
    '  <div class="c wide">A</div><div class="c narrow">B</div>',
    '  <div class="c wide">C</div><div class="c wide">D</div>',
    '</div></main></body></html>'
  ].join('\n'));
  const centredColumn = centred.analysis.slides[0].nodes[0];
  const [a, b] = centredColumn.children;
  // 200px column, 160px item: 20px of slack on each side.
  assert.ok(Math.abs(b.x - (a.x + 20 / 96)) < 0.005, 'the narrow item is centred: ' + b.x + ' vs ' + a.x);
  assert.deepEqual(centred.report.containerFallbacks, []);
});

test('a wrapping column that cannot be translated is reported, not guessed', () => {
  const build = (containerCss, itemCss) => pipeline.convertHtml([
    '<html><head><style>',
    '  .slide { width: 1280px; height: 720px; padding: 40px; }',
    '  .cols { display: flex; flex-direction: column; flex-wrap: wrap; width: 900px; ' + containerCss + ' }',
    '  .c { ' + itemCss + ' background: #CCCCCC; }',
    '</style></head><body><main class="slide"><div class="cols">',
    '  <div class="c">1</div><div class="c">2</div><div class="c">3</div>',
    '</div></main></body></html>'
  ].join('\n'));

  // Without a height there is nothing to break against.
  const noHeight = build('gap: 12px;', 'width: 200px; height: 120px;');
  assert.ok(noHeight.report.unsupportedDetails.some((entry) => entry.property === 'flexWrap'),
    'a wrapping column without a definite height is reported');

  // A column takes its width from its items; without one the break cannot be measured.
  const autoWidth = build('height: 300px; gap: 12px;', 'height: 120px;');
  assert.ok(autoWidth.report.unsupportedDetails.some((entry) => entry.property === 'flexWrap'),
    'a wrapping column with auto-width items is reported');
});


test('a generated multi-page deck keeps every layout invariant', () => {
  const stress = require('../native/scripts/stress_html');
  const html = stress.generate({ slides: 9, seed: 3 });
  // Deterministic by construction: the same seed has to reproduce a failure exactly.
  assert.equal(html, stress.generate({ slides: 9, seed: 3 }));
  assert.notEqual(html, stress.generate({ slides: 9, seed: 4 }));
  const started = Date.now();
  const result = pipeline.convertHtml(html);
  const elapsed = Date.now() - started;
  const problems = stress.checkDeck(result, { slides: 9 });
  assert.deepEqual(problems, [], 'generated deck problems: ' + JSON.stringify(problems, null, 1));
  assert.equal(result.deck.slides.length, 9);
  // Nine archetypes cycle, so a nine-page deck exercises all of them - including the two
  // hard ones: a card holding a merged-cell table with a rotated badge and a cropped
  // picture, and a ten-row table with a striped body.
  const kinds = new Set(result.deck.slides.map((slide) => (slide.elements || []).length));
  assert.ok(kinds.size > 1, 'the pages are not identical');
  const walk = (elements) => (elements || []).flatMap((element) => [element].concat(walk(element.children)));
  const shapes = result.deck.slides.flatMap((slide) => walk(slide.elements));
  assert.ok(shapes.some((shape) => Number(shape.rotate) !== 0 && Number.isFinite(Number(shape.rotate))),
    'the rotated badge reaches the deck');
  const tables = shapes.filter((shape) => shape.type === 'table');
  assert.ok(tables.some((table) => table.rows.length >= 10), 'the dense table is there');
  assert.ok(tables.some((table) => table.rows.some((row) => row.some((cell) => cell.options && cell.options.rowspan))),
    'and the merged cell too');
  assert.ok(shapes.some((shape) => shape.type === 'image' && shape.fit === 'cover'),
    'the cropped picture is a native cover crop');
  assert.ok(result.report.unsupportedDetails.length === 0, 'the generated CSS stays inside the supported subset');
  assert.ok(result.report.declarativeContainers > 20, 'containers stayed declarative: ' + result.report.declarativeContainers);
  assert.ok(elapsed < 20000, 'nine pages should convert in well under 20s, took ' + elapsed + 'ms');
});

test('the bounds check flags what a page-level check cannot see', () => {
  const stress = require('../native/scripts/stress_html');
  const pageSize = { width: 13.333, height: 7.5 };
  // A text box off the right edge and a shape entirely outside are both errors; a
  // decorative shape that hangs over the edge is not, because the page clips it.
  const deck = {
    slides: [{
      elements: [
        { type: 'text', x: 12.5, y: 1, w: 2, h: 0.4, text: 'spills' },
        { type: 'shape', x: 20, y: 1, w: 2, h: 2 },
        { type: 'shape', x: 12.9, y: 0.5, w: 3, h: 3 }
      ]
    }]
  };
  const problems = stress.checkBounds(deck, pageSize);
  assert.equal(problems.length, 2, 'expected the text and the far shape: ' + JSON.stringify(problems));
  assert.deepEqual(problems.map((problem) => problem.type), ['text', 'shape']);
});


test('an ellipsis truncates a single line, and only when the CSS asks', () => {
  const build = (style, text) => pipeline.convertHtml([
    '<html><head><style>',
    '  .slide { width: 1280px; height: 720px; padding: 40px; }',
    '  .box { box-sizing: border-box; width: 180px; padding: 8px 10px; background: #EEEEEE; font-size: 13px; ' + style + ' }',
    '</style></head><body><main class="slide"><div class="box">' + text + '</div></main></body></html>'
  ].join('\n'));

  const ellipsis = 'white-space: nowrap; overflow: hidden; text-overflow: ellipsis;';
  const long = 'A considerably longer label that will not fit';
  const short = 'Short one';

  // Text that fits is left exactly as it is: a declaration that changes no pixel is silent.
  const small = build(ellipsis, short);
  assert.deepEqual(small.report.unsupportedDetails, []);
  const smallNode = small.analysis.slides[0].nodes[0];
  assert.equal(smallNode.text, short);

  // Text that does not fit is cut at the widest prefix that still leaves room for the
  // ellipsis - and the result really is narrower than the box.
  const big = build(ellipsis, long);
  assert.deepEqual(big.report.unsupportedDetails, []);
  const bigNode = big.analysis.slides[0].nodes[0];
  assert.ok(bigNode.text.endsWith('\u2026'), 'the line ends with an ellipsis: ' + bigNode.text);
  assert.ok(bigNode.text.length < long.length, 'it is shorter than the original');
  assert.ok(!bigNode.text.startsWith(long.slice(0, long.length)), 'it is not the whole string');
  const contentWidth = 180 / 96 - 20 / 96;
  const measured = require('../native/engine/text_measure').measureTextPt(bigNode.text, 9.75) / 72;
  assert.ok(measured <= contentWidth, 'the truncated line fits: ' + measured.toFixed(3) + ' vs ' + contentWidth.toFixed(3));

  // A wrapping block cannot be ellipsized without losing text, so it is reported and kept.
  const wrapped = build('overflow: hidden; text-overflow: ellipsis;', long);
  assert.equal(wrapped.analysis.slides[0].nodes[0].text, long);
  assert.ok(wrapped.report.unsupportedDetails.some((entry) => entry.property === 'textOverflow'),
    'a wrapping block reports the ellipsis it cannot apply');

  // And so is a box that does not clip at all: the browser needs `overflow: hidden`.
  const visible = build('white-space: nowrap; text-overflow: ellipsis;', long);
  assert.ok(visible.report.unsupportedDetails.some((entry) => entry.property === 'textOverflow'),
    'an unclipped box reports the ellipsis');
});


test('all four writing modes have a native direction, except upright CJK', () => {
  const build = (writingMode, text) => pipeline.convertHtml([
    '<html><head><style>',
    '  .slide { width: 1280px; height: 720px; padding: 40px; }',
    '  .lbl { position: absolute; left: 60px; top: 60px; width: 80px; height: 260px;',
    '         font-size: 15px; ' + writingMode + ' }',
    '</style></head><body><main class="slide"><div class="lbl">' + text + '</div></main></body></html>'
  ].join('\n'));
  const vertOf = (result) => {
    let found;
    const visit = (elements) => (elements || []).forEach((element) => {
      if (element.type === 'text' && found === undefined) found = element.vert;
      visit(element.children);
    });
    visit(result.deck.slides[0].elements);
    return found;
  };

  const rightToLeft = build('writing-mode: vertical-rl;', 'vertical rl label');
  assert.equal(vertOf(rightToLeft), 'eaVert');
  assert.deepEqual(rightToLeft.report.unsupportedDetails, []);

  assert.equal(vertOf(build('writing-mode: sideways-rl;', 'sideways rl label')), 'vert');

  // Columns running left to right is `vert270`; Latin text needs no upright glyphs, so
  // `vertical-lr` renders the same way.
  const sidewaysLeft = build('writing-mode: sideways-lr;', 'sideways lr label');
  assert.equal(vertOf(sidewaysLeft), 'vert270');
  assert.deepEqual(sidewaysLeft.report.unsupportedDetails, []);
  const verticalLeft = build('writing-mode: vertical-lr;', 'vertical lr latin only');
  assert.equal(vertOf(verticalLeft), 'vert270');

  // Upright CJK in a left-to-right column has no DrawingML direction, so it is reported
  // rather than rendered upside down.
  const cjk = build('writing-mode: vertical-lr;', '\u7ad6\u6392\u4ece\u5de6\u5f80\u53f3');
  assert.ok(cjk.report.unsupportedDetails.some((entry) => entry.property === 'writingMode'),
    'vertical-lr over CJK is reported');
});

test('position: sticky is static, because a slide never scrolls', () => {
  const result = pipeline.convertHtml([
    '<html><head><style>',
    '  .slide { width: 1280px; height: 720px; padding: 40px; }',
    '  .head { position: sticky; top: 0; height: 40px; background: #DDDDDD; }',
    '  .body { height: 200px; background: #EEEEEE; }',
    '</style></head><body><main class="slide">',
    '  <div class="head">header</div><div class="body"></div>',
    '</main></body></html>'
  ].join('\n'));
  assert.deepEqual(result.report.unsupportedDetails, []);
  const [head, body] = result.analysis.slides[0].nodes;
  // Sticky offsets apply while scrolling; with no scroll, the box stays where flow put it.
  assert.ok(Math.abs(head.y - 40 / 96) < 0.01, 'the sticky box stays in flow: ' + head.y);
  assert.ok(Math.abs(body.y - (head.y + head.h)) < 0.01, 'and the next box starts below it');
});


test('a linear gradient reads its direction only when it has one', () => {
  const build = (background) => pipeline.convertHtml([
    '<html><head><style>',
    '  .slide { width: 1280px; height: 720px; padding: 40px; }',
    '  .box { width: 300px; height: 120px; ' + background + ' }',
    '</style></head><body><main class="slide"><div class="box"></div></main></body></html>'
  ].join('\n'));
  const shapeOf = (result) => (result.deck.slides[0].elements || []).find((element) => element.type === 'shape');

  // CSS defaults to `to bottom` (180deg) when the direction is omitted; the deck spec
  // stores the DrawingML angle, which is measured 90deg round from the CSS one.
  const plain = build('background: linear-gradient(#f00, #00f);');
  assert.deepEqual(plain.report.unsupportedDetails, []);
  const plainShape = shapeOf(plain);
  assert.equal(plainShape.gradient.angle, 90);
  assert.equal(plainShape.gradient.stops.length, 2);
  assert.equal(plainShape.gradient.stops[0].color, 'FF0000');

  // `to right` is 90deg in CSS, i.e. 0 in the file, and `0.25turn` says the same thing.
  assert.equal(shapeOf(build('background: linear-gradient(to right, #f00, #00f);')).gradient.angle, 0);
  assert.equal(shapeOf(build('background: linear-gradient(0.25turn, #f00, #00f);')).gradient.angle, 0);
  assert.equal(shapeOf(build('background: linear-gradient(135deg, #f00, #00f);')).gradient.angle, 45);

  // A fill PowerPoint cannot express is reported and left unpainted: no shape is emitted
  // for it (nothing to paint), while the analyzer keeps the box so the layout around it
  // is unchanged - which is also what the report says.
  ['conic-gradient(#f00, #00f)', 'radial-gradient(circle, #f00, #00f)',
    'repeating-linear-gradient(#f00, #00f 20px)'].forEach((fill) => {
    const result = build('background: ' + fill + ';');
    assert.equal(shapeOf(result), undefined, 'no shape pretends to paint ' + fill);
    const node = result.analysis.slides[0].nodes[0];
    assert.equal(Number(node.w.toFixed(3)), 3.125, 'the box keeps its declared width');
    const report = result.report.unsupportedDetails.find((entry) => entry.property === 'backgroundImage');
    assert.ok(report, fill + ' is reported');
    assert.ok(report.reason.includes(fill.split('(')[0]), 'the reason names the function: ' + report.reason);
    assert.ok(report.reason.includes('unpainted'), 'and says what happens instead: ' + report.reason);
  });
});


test('a gradient above a background picture is a native scrim, not a lost layer', () => {
  const result = pipeline.convertHtml([
    '<html><head><style>',
    '  .slide { width: 1280px; height: 720px; padding: 0; }',
    '  .hero { width: 1280px; height: 420px;',
    '          background-image: linear-gradient(180deg, rgba(10,20,26,0.15) 0%, rgba(10,20,26,0.92) 100%),',
    '            url(native-image-assets/sample-panorama.png);',
    '          background-size: cover; }',
    '  .hero h1 { position: absolute; left: 64px; bottom: 32px; margin: 0; font-size: 40px; color: #FFFFFF; }',
    '</style></head><body><main class="slide">',
    '  <div class="hero"><h1>Caption above the scrim</h1></div>',
    '</main></body></html>'
  ].join('\n'));
  assert.deepEqual(result.report.unsupportedDetails, []);
  const elements = result.deck.slides[0].elements;
  const picture = elements.find((element) => element.type === 'image');
  assert.ok(picture, 'the picture layer is emitted');
  const scrim = elements.find((element) => element.type === 'shape' && element.gradient);
  assert.ok(scrim, 'the gradient layer is emitted as its own shape');
  assert.equal(scrim.w, picture.w, 'and covers the picture');
  assert.equal(scrim.h, picture.h);
  assert.equal(scrim.gradient.stops.length, 2);
  assert.equal(scrim.gradient.stops[0].transparency, 85, 'the alpha stops travel');
  assert.equal(scrim.gradient.stops[1].transparency, 8);
  // The caption has to sit above the scrim: it comes after it in paint order.
  const caption = elements.find((element) => element.type === 'text');
  assert.ok(caption && caption.text === 'Caption above the scrim', 'the absolute caption survives');
  assert.ok(elements.indexOf(caption) > elements.indexOf(scrim), 'and paints above the scrim');

  // A fill PowerPoint cannot paint is reported instead of being swallowed.
  const radial = pipeline.convertHtml([
    '<html><head><style>',
    '  .slide { width: 1280px; height: 720px; padding: 0; }',
    '  .hero { width: 600px; height: 300px;',
    '          background-image: radial-gradient(circle, rgba(0,0,0,0.4), rgba(0,0,0,0)),',
    '            url(native-image-assets/sample-panorama.png); }',
    '</style></head><body><main class="slide"><div class="hero"></div></main></body></html>'
  ].join('\n'));
  const report = radial.report.unsupportedDetails.find((entry) => entry.property === 'backgroundImage');
  assert.ok(report, 'the radial layer is reported');
  assert.ok(report.reason.includes('radial-gradient'), 'and named: ' + report.reason);
});

test('one radius for four corners, and three reports for what a run cannot paint', () => {
  const perCorner = pipeline.convertHtml([
    '<html><head><style>',
    '  .slide { width: 1280px; height: 720px; padding: 40px; }',
    '  .tab { width: 240px; height: 80px; background: #4FA398; border-radius: 16px 16px 0 0; }',
    '  .round { width: 240px; height: 80px; background: #4FA398; border-radius: 12px; }',
    '</style></head><body><main class="slide"><div class="tab"></div><div class="round"></div></main></body></html>'
  ].join('\n'));
  const radiusReports = perCorner.report.unsupportedDetails.filter((entry) => entry.property === 'borderRadius');
  assert.equal(radiusReports.length, 1, 'only the box with different corners is reported');
  assert.equal(perCorner.analysis.slides[0].nodes[1].radius, 0.125, 'uniform radii are kept');

  const inline = pipeline.convertHtml([
    '<html><head><style>',
    '  .slide { width: 1280px; height: 720px; padding: 40px; }',
    '  .line { width: 600px; font-size: 14px; }',
    '  .tag { background: #4FA398; color: #FFFFFF; padding: 2px 6px; }',
    '</style></head><body><main class="slide">',
    '  <div class="line"><span class="tag">tag</span> trailing words</div>',
    '</main></body></html>'
  ].join('\n'));
  assert.ok(inline.report.unsupportedDetails.some((entry) => entry.property === 'inlineBox'),
    'a painted inline box is reported, not silently flattened');
  // The span carries its own colour, so the box becomes rich text: the words live in
  // the runs, and they are all still there.
  const kept = JSON.stringify(inline.deck.slides[0].elements[0].text);
  assert.ok(kept.includes('tag') && kept.includes('trailing'), 'while its words are kept: ' + kept);

  const mixed = pipeline.convertHtml([
    '<html><head><style>',
    '  .slide { width: 1280px; height: 720px; padding: 40px; }',
    '  .wrap { width: 600px; font-size: 14px; }',
    '  .card { background: #EEEEEE; padding: 8px; }',
    '</style></head><body><main class="slide">',
    '  <div class="wrap">Intro text<div class="card">card body</div>Outro text</div>',
    '</main></body></html>'
  ].join('\n'));
  // Text mixed with a block sibling forms an anonymous box in CSS, so the words used
  // to be dropped; they are kept now, in document order and with no report.
  const mixedTexts = [];
  const collect = (element) => {
    if (element.text !== undefined) mixedTexts.push(Array.isArray(element.text)
      ? element.text.map((run) => run.text).join('') : String(element.text));
    (element.children || []).forEach(collect);
  };
  mixed.deck.slides[0].elements.forEach(collect);
  assert.deepEqual(mixedTexts, ['Intro text', 'card body', 'Outro text'],
    'the words on both sides of the card survive, in order: ' + JSON.stringify(mixedTexts));
  assert.ok(!mixed.report.unsupportedDetails.some((entry) => entry.property === 'element'),
    'and no report claims they were lost');
});

test('margin: auto centres a fixed-width box, and tracking widens the measurement', () => {
  const centred = pipeline.convertHtml([
    '<html><head><style>',
    '  .slide { width: 1280px; height: 720px; padding: 0; }',
    '  .note { width: 1000px; margin: 40px auto 0; font-size: 14px; }',
    '  .pin { width: 800px; margin-left: auto; margin-right: 0; font-size: 14px; }',
    '</style></head><body><main class="slide">',
    '  <p class="note">centred</p><p class="pin">pushed right</p>',
    '</main></body></html>'
  ].join('\n'));
  assert.deepEqual(centred.report.unsupportedDetails, []);
  const [note, pin] = centred.analysis.slides[0].nodes;
  assert.equal(Number(note.x.toFixed(3)), 1.458, 'both autos split the free space');
  assert.equal(Number(pin.x.toFixed(3)), 5, 'a left auto pushes the box to the end edge');

  // letter-spacing is part of the advance, so a tracked label still fits on one line.
  const tracked = pipeline.convertHtml([
    '<html><head><style>',
    '  .slide { width: 1280px; height: 720px; padding: 40px; }',
    '  .kicker { position: absolute; top: 80px; left: 56px; font-size: 12px;',
    '            letter-spacing: 3px; text-transform: uppercase; }',
    '</style></head><body><main class="slide"><div class="kicker">NATIVE PAINT</div></main></body></html>'
  ].join('\n'));
  const kicker = tracked.deck.slides[0].elements.find((element) => element.type === 'text');
  assert.equal(kicker.text, 'NATIVE PAINT', 'the whole label is one run');
  assert.equal(kicker.charSpacing, 2.25, 'and the tracking is written');
  const plainWidth = require('../native/engine/text_measure').measureTextPt('NATIVE PAINT', 9) / 72;
  assert.ok(kicker.w > plainWidth + 0.2, 'the box grew by the tracking: ' + kicker.w);
});


test('CSS math and viewport units resolve against the slide viewport', () => {
  const { css } = require('../native/pipeline');
  const context = { parentWidth: 12.5, parentHeight: 8, percentBase: 12.5, fontSizePx: 16 };
  const inches = (value) => {
    const result = css.evaluateInches(value, context);
    return result === null ? null : Number(result.toFixed(4));
  };
  assert.equal(inches('600px'), 6.25);
  assert.equal(inches('calc(50% - 24px)'), 6);
  assert.equal(inches('calc(100% / 3)'), 4.1667);
  assert.equal(inches('min(600px, 100%)'), 6.25);
  assert.equal(inches('max(120px, 2in)'), 2);
  assert.equal(inches('clamp(14px, 1.2vw, 18px)'), 0.16, '1.2vw of a 1280px viewport');
  assert.equal(inches('60vw'), 8);
  assert.equal(inches('90vh'), 6.75);
  // A zero is ~0.58em and an x-height ~0.52em; half an em for both made `40ch` a sixth
  // too narrow, so a box measured in characters wrapped a line early.
  assert.equal(inches('40ch'), 3.8667, 'ch is the advance of a zero');
  assert.equal(inches('10ex'), 0.8667, 'ex is the x-height');
  assert.equal(inches('fit-content'), null, 'what cannot be resolved stays null');
  assert.equal(inches('calc(100% - env(safe-area-inset-left))'), null);

  // The box geometry follows the expression, not the fallback.
  const result = pipeline.convertHtml([
    '<html><head><style>',
    '  .slide { width: 1280px; height: 720px; padding: 40px; }',
    '  .box { width: calc(50% - 24px); height: max(120px, 16vh); background: #EEEEEE; }',
    '</style></head><body><main class="slide"><div class="box">text</div></main></body></html>'
  ].join('\n'));
  const box = result.analysis.slides[0].nodes[0];
  assert.equal(Number(box.w.toFixed(3)), 6, '50% of the 1200px content box minus 24px');
  assert.equal(Number(box.h.toFixed(3)), 1.25, '16vh of 720px is 115.2px');
  assert.deepEqual(result.report.unsupportedDetails, []);

  // A length that cannot be resolved is reported, not silently ignored.
  const reported = pipeline.convertHtml([
    '<html><head><style>',
    '  .slide { width: 1280px; height: 720px; padding: 40px; }',
    '  .box { width: fit-content; background: #EEEEEE; }',
    '</style></head><body><main class="slide"><div class="box">text</div></main></body></html>'
  ].join('\n'));
  const lengthReport = reported.report.unsupportedDetails.find((entry) => entry.property === 'length');
  assert.ok(lengthReport, 'fit-content is reported');
  assert.equal(lengthReport.value, 'fit-content');
});

test('!important is a flag, relative font sizes apply once, and gaps keep their function', () => {
  const result = pipeline.convertHtml([
    '<html><head><style>',
    '  .slide { width: 1280px; height: 720px; padding: 40px; }',
    '  .wide { width: 600px !important; height: 60px; background: #EEEEEE; }',
    '  .grow { font-size: 120%; }',
    '  .band { display: flex; gap: clamp(12px, 1.6vw, 28px); width: 1000px; }',
    '  .band > div { width: calc(50% - 16px); height: 60px; background: #DDDDDD; }',
    '</style></head><body><main class="slide">',
    '  <div class="wide">flagged</div>',
    '  <div class="grow">relative</div>',
    '  <div class="band"><div></div><div></div></div>',
    '</main></body></html>'
  ].join('\n'));
  assert.deepEqual(result.report.unsupportedDetails, []);
  const [wide, grow] = result.analysis.slides[0].nodes;
  assert.equal(Number(wide.w.toFixed(3)), 6.25, 'the flagged width is read, not dropped');
  assert.equal(Number(grow.fontSizePt.toFixed(2)), 14.4, '120% of 16px is 19.2px, applied once');
  // The clamp() gap reads the same in the analyzer and in the engine, so the row stays
  // declarative instead of falling back to absolute placement.
  assert.equal(result.report.absoluteGroups, 0);
  assert.ok(result.report.declarativeContainers >= 1, 'the row is emitted as a native container');
});


test('a box-shadow becomes a native outer shadow with the CSS direction', () => {
  const result = pipeline.convertHtml([
    '<html><head><style>',
    '  .slide { width: 1280px; height: 720px; padding: 40px; }',
    '  .card { width: 400px; height: 160px; background: #FFFFFF; border-radius: 12px;',
    '          box-shadow: 0 10px 26px rgba(6, 18, 20, 0.35); }',
    '</style></head><body><main class="slide"><div class="card"></div></main></body></html>'
  ].join('\n'));
  assert.deepEqual(result.report.unsupportedDetails, []);
  const card = result.deck.slides[0].elements[0];
  const shadow = card.shadow;
  assert.ok(shadow, 'the shadow travels with the shape');
  assert.equal(shadow.color, '061214');
  assert.equal(Number(shadow.opacity.toFixed(2)), 0.35);
  assert.equal(Number(shadow.blur.toFixed(2)), 19.5, '26px is 19.5pt');
  assert.equal(Number(shadow.distance.toFixed(2)), 7.5, '10px is 7.5pt');
  // DrawingML measures the direction clockwise from +x with y down: straight down is 90.
  assert.equal(Number(shadow.angle.toFixed(1)), 90);

  const toTheRight = pipeline.convertHtml([
    '<html><head><style>',
    '  .slide { width: 1280px; height: 720px; padding: 40px; }',
    '  .chip { width: 200px; height: 80px; background: #FFFFFF; box-shadow: 12px 0 8px #000000; }',
    '</style></head><body><main class="slide"><div class="chip"></div></main></body></html>'
  ].join('\n'));
  assert.equal(Number(toTheRight.deck.slides[0].elements[0].shadow.angle.toFixed(1)), 0,
    'an offset to the right is zero degrees');

  // The parts of a shadow a native effect cannot express are named.
  const spread = pipeline.convertHtml([
    '<html><head><style>',
    '  .slide { width: 1280px; height: 720px; padding: 40px; }',
    '  .ring { width: 200px; height: 80px; background: #FFFFFF; box-shadow: 0 0 0 6px rgba(0,0,0,0.2); }',
    '  .inner { width: 200px; height: 80px; background: #FFFFFF; box-shadow: inset 0 2px 6px #000000; }',
    '  .stacked { width: 200px; height: 80px; background: #FFFFFF; box-shadow: 0 2px 4px #000000, 0 8px 16px #000000; }',
    '</style></head><body><main class="slide">',
    '  <div class="ring"></div><div class="inner"></div><div class="stacked"></div>',
    '</main></body></html>'
  ].join('\n'));
  const reasons = spread.report.unsupportedDetails
    .filter((entry) => entry.property === 'boxShadow').map((entry) => entry.reason);
  assert.equal(reasons.length, 2, 'a spread and a second layer are each reported');
  assert.ok(reasons.some((reason) => reason.includes('spread')));
  assert.ok(reasons.some((reason) => reason.includes('first shadow layer')));
  assert.ok(!reasons.some((reason) => reason.includes('inset')),
    'an inset layer is an inner shadow now, so it is not a gap');
  const elements = spread.deck.slides[0].elements;
  assert.ok(elements.some((element) => element.innerShadow), 'the inset box keeps its shadow');
});

test('opacity fades a leaf, multiplies with the colour alpha, and is reported on a subtree', () => {
  const result = pipeline.convertHtml([
    '<html><head><style>',
    '  .slide { width: 1280px; height: 720px; padding: 40px; }',
    '  .plate { width: 300px; height: 100px; background: #2FA8A0; opacity: 0.5; }',
    '  .label { width: 300px; font-size: 18px; color: rgba(255,255,255,0.8); opacity: 0.5; }',
    '  .group { width: 300px; height: 120px; background: #EEEEEE; opacity: 0.6; }',
    '  .group p { margin: 0; font-size: 14px; color: #333333; }',
    '</style></head><body><main class="slide">',
    '  <div class="plate"></div>',
    '  <div class="label">half faded</div>',
    '  <div class="group"><p>child text</p></div>',
    '</main></body></html>'
  ].join('\n'));
  const [plate, label] = result.deck.slides[0].elements;
  assert.equal(plate.transparency, 50, 'the plate is half transparent');
  // 0.8 alpha from the colour and 0.5 from the box multiply to 0.4.
  assert.equal(label.transparency, 60, 'two alphas multiply, they do not replace');
  const opacityReport = result.report.unsupportedDetails.find((entry) => entry.property === 'opacity');
  assert.ok(opacityReport, 'a faded subtree is reported');
  assert.equal(opacityReport.value, '0.6');
  assert.ok(opacityReport.reason.includes('subtree'));
});


test('colspan and rowspan place cells on the real grid instead of shifting columns', () => {
  const result = pipeline.convertHtml([
    '<html><head><style>',
    '  .slide { width: 1280px; height: 720px; padding: 40px; }',
    '  table { width: 900px; border-collapse: collapse; font-size: 13px; }',
    '  th, td { border: 1px solid #CCCCCC; padding: 8px; }',
    '</style></head><body><main class="slide"><table>',
    '  <thead><tr><th colspan="2">Region</th><th>Q1</th><th>Q2</th></tr></thead>',
    '  <tbody>',
    '    <tr><td rowspan="2">East</td><td>Shanghai</td><td>1284</td><td>1102</td></tr>',
    '    <tr><td>Hangzhou</td><td>1096</td><td>988</td></tr>',
    '    <tr><td colspan="4">Totals</td></tr>',
    '  </tbody>',
    '</table></main></body></html>'
  ].join('\n'));
  assert.deepEqual(result.report.unsupportedDetails, []);
  const table = result.analysis.slides[0].nodes[0];
  assert.equal(table.columnCount, 4, 'the grid is four columns wide');
  // Rows are lopsided on purpose: PptxGenJS writes the merge placeholders itself, so a
  // row holds only the cells that *start* in it.
  assert.equal(table.rows[0].length, 3);
  assert.equal(table.rows[0][0].options.colspan, 2);
  assert.equal(table.rows[1].length, 4);
  assert.equal(table.rows[1][0].options.rowspan, 2);
  assert.equal(table.rows[2].length, 3, 'the rowspan cell does not repeat in the next row');
  assert.equal(table.rows[3].length, 1);
  assert.equal(table.rows[3][0].options.colspan, 4);
  const element = result.deck.slides[0].elements.find((entry) => entry.type === 'table');
  assert.equal(element.options.colW.length, 4);
  assert.equal(element.rows.length, 4);
  assert.equal(element.options.rowH.length, 4);
});

test('a rowspan is clipped to the rows that exist and an unused slot becomes an empty cell', () => {
  const clipped = pipeline.convertHtml([
    '<html><head><style>',
    '  .slide { width: 1280px; height: 720px; padding: 40px; }',
    '  table { width: 800px; } td, th { padding: 6px; font-size: 12px; }',
    '</style></head><body><main class="slide"><table>',
    '  <tr><td rowspan="5">only one row exists</td><td>b</td></tr>',
    '</table></main></body></html>'
  ].join('\n'));
  const report = clipped.report.unsupportedDetails.find((entry) => entry.property === 'rowspan');
  assert.ok(report, 'the clipped span is reported');
  const table = clipped.analysis.slides[0].nodes[0];
  assert.equal(table.rows.length, 1);
  assert.equal(table.rows[0][0].options.rowspan, undefined, 'a span of one row is not a merge');

  // A row that stops short of the grid leaves empty cells in a browser; they are emitted
  // so PowerPoint draws the same rectangle.
  const ragged = pipeline.convertHtml([
    '<html><head><style>',
    '  .slide { width: 1280px; height: 720px; padding: 40px; }',
    '  table { width: 800px; } td, th { padding: 6px; font-size: 12px; }',
    '</style></head><body><main class="slide"><table>',
    '  <tr><td>a</td><td>b</td><td>c</td></tr>',
    '  <tr><td>only one</td></tr>',
    '</table></main></body></html>'
  ].join('\n'));
  const raggedTable = ragged.analysis.slides[0].nodes[0];
  assert.equal(raggedTable.columnCount, 3);
  assert.equal(raggedTable.rows[1].length, 3, 'the short row is padded');
  assert.equal(raggedTable.rows[1][2].text, '');
});


test('inline semantics become native run properties, and lists keep their levels', () => {
  const result = pipeline.convertHtml([
    '<html><head><style>',
    '  .slide { width: 1280px; height: 720px; padding: 60px; }',
    '  p { margin: 0 0 12px; font-size: 16px; }',
    '  ul { margin: 0; padding-left: 24px; }',
    '</style></head><body><main class="slide">',
    '  <p>H<sub>2</sub>O and mc<sup>2</sup>, <u>under</u>, <s>struck</s>, <mark>marked</mark>,',
    '     <code>code</code>, <strong>bold</strong>, <em>italic</em>,',
    '     <a href="https://example.com/x">link</a>.</p>',
    '  <ul><li>Parent<ul><li>Child</li></ul></li><li>Second</li></ul>',
    '</main></body></html>'
  ].join('\n'));
  assert.deepEqual(result.report.unsupportedDetails, []);
  const elements = result.deck.slides[0].elements;
  const runs = elements[0].text;
  const byText = (needle) => runs.find((run) => run.text === needle);
  assert.equal(byText('2').options.subscript, true);
  assert.equal(byText('2').options.superscript, undefined);
  assert.equal(runs.filter((run) => run.options && run.options.superscript).length, 1);
  assert.equal(byText('under').options.underline, true);
  assert.equal(byText('struck').options.strike, true);
  assert.equal(byText('marked').options.highlight, 'FFFF00', 'a plain background is a highlighter');
  assert.equal(byText('code').options.fontFace, 'Consolas', 'the UA monospace default');
  assert.equal(byText('bold').options.bold, true);
  assert.equal(byText('italic').options.italic, true);
  assert.equal(byText('link').options.hyperlink.url, 'https://example.com/x');

  const list = elements[1].text;
  assert.ok(Array.isArray(list), 'a nested list is a run list, one run per item level');
  const child = list.find((run) => run.text === 'Child');
  assert.equal(child.options.indentLevel, 1, 'the nested item is one level in');
  assert.ok(list.every((run) => run.options && run.options.bullet), 'every item keeps its bullet');
  assert.ok(list.filter((run) => run.options.breakLine).length === list.length - 1, 'one paragraph per item');
});

test('line-height maps to exact points, not a percentage of the font line box', async () => {
  const result = pipeline.convertHtml([
    '<html><head><style>',
    '  .slide { width: 1280px; height: 720px; padding: 60px; }',
    '  p { margin: 0; font-size: 20px; line-height: 2; }',
    '</style></head><body><main class="slide"><p>two<br>lines<br>here</p></main></body></html>'
  ].join('\n'));
  const element = result.deck.slides[0].elements[0];
  // Into the writer: the CSS multiple times the font size, in points.
  const { buildPresentation } = require('../native');
  const written = await buildPresentation({
    slides: [{ elements: [Object.assign({}, element)] }]
  });
  const textObject = written.pptx._slides[0]._slideObjects.find((object) => object._type === 'text');
  const options = textObject.options;
  assert.equal(options.lineSpacing, Number((2 * element.fontSize).toFixed(2)));
  assert.ok(!options.lineSpacingMultiple, 'spcPct would render ~20% taller than the CSS asks');
  // And the reserved box uses the same number, so the text cannot spill out of it.
  assert.equal(Number(element.h.toFixed(2)), Number((3 * 2 * element.fontSize / 72).toFixed(2)));
});


test('speaker notes become native notes instead of hidden slide content', () => {
  const result = pipeline.convertHtml([
    '<html><head><style>',
    '  .slide { width: 1280px; height: 720px; padding: 60px; }',
    '  .notes { display: none; }',
    '</style></head><body>',
    '<main class="slide"><h1>Title</h1>',
    '  <aside class="notes">Mention the Q3 number.</aside></main>',
    '<main class="slide" data-notes="Terse note"><h1>Second</h1></main>',
    '<main class="slide"><h1>Third</h1><div class="notes" style="display: block">visible anyway</div></main>',
    '</body></html>'
  ].join('\n'));
  assert.equal(result.deck.slides[0].notes, 'Mention the Q3 number.');
  assert.equal(result.deck.slides[0].elements.length, 1, 'the hidden note is not slide content');
  assert.equal(result.deck.slides[1].notes, 'Terse note');
  assert.equal(result.deck.slides[2].notes, undefined,
    'a notes box that the design shows is content, not a note');
  const visible = result.deck.slides[2].elements.map((element) => element.text).join(' ');
  assert.ok(visible.includes('visible anyway'));
});

test('every unsupported declaration is reported exactly once, by name', () => {
  // The honesty contract: what this shape cannot do has to leave a trace, and the trace has
  // to name the declaration. One case per report, so a regression shows up as a missing name.
  const cases = {
    // One text-shadow layer reaches the run properties now; the second has nowhere to go.
    textShadow: '.box { width: 400px; font-size: 20px; text-shadow: 0 2px 8px #000, 0 0 2px #FFF; }',
    filter: '.box { width: 400px; height: 80px; background: #EEE; filter: blur(2px); }',
    wordSpacing: '.box { width: 400px; font-size: 20px; word-spacing: 6px; }',
    direction: '.box { width: 400px; font-size: 16px; direction: rtl; }',
    backgroundBlendMode: '.box { width: 400px; height: 80px; background-color: #345; background-image: linear-gradient(45deg, #000, #FFF); background-blend-mode: multiply; }',
    // `break-all`/`break-word` are how the wrap already behaves, so they stay silent;
    // only the value that forbids a break this solver makes is reported.
    wordBreak: '.box { width: 300px; font-size: 14px; word-break: keep-all; }',
    textWrap: '.box { width: 300px; font-size: 14px; text-wrap: balance; }',
    hyphens: '.box { width: 300px; font-size: 14px; hyphens: auto; }',
    clipPath: '.box { width: 400px; height: 80px; background: #EEE; clip-path: circle(40%); }'
  };
  Object.entries(cases).forEach(([expected, css]) => {
    const result = pipeline.convertHtml([
      '<html><head><style>',
      '  .slide { width: 1280px; height: 720px; padding: 40px; }',
      '  ' + css,
      '</style></head><body><main class="slide"><div class="box">text</div></main></body></html>'
    ].join('\n'));
    const properties = result.report.unsupportedDetails.map((entry) => entry.property);
    assert.ok(properties.includes(expected),
      expected + ' is not in the report: ' + JSON.stringify(properties));
  });

  // `columns: 2` on an element that holds its own text is a native columned text box now
  // (numCol/spcCol on bodyPr), so it belongs with the quiet cases; the block-child shapes
  // that cannot be poured into a column are still named.
  const columned = pipeline.convertHtml([
    '<html><head><style>',
    '  .slide { width: 1280px; height: 720px; padding: 40px; }',
    '  .box { width: 600px; columns: 2; column-gap: 30px; font-size: 14px; }',
    '</style></head><body><main class="slide"><p class="box">分栏文字，写长一点好让它真的排成两栏。</p></main></body></html>'
  ].join('\n'));
  const columnElement = columned.deck.slides[0].elements[0];
  assert.equal(columnElement.type, 'text');
  assert.equal(columnElement.columns, 2);
  assert.ok(Math.abs(columnElement.columnGap * 96 - 30) < 0.5, 'gap: ' + (columnElement.columnGap * 96));
  assert.deepEqual(columned.report.unsupportedDetails, [], 'a columned paragraph says nothing');
  const poured = pipeline.convertHtml([
    '<html><head><style>',
    '  .slide { width: 1280px; height: 720px; padding: 40px; }',
    '  .box { width: 600px; columns: 2; font-size: 14px; }',
    '  .card { background: #EEE; padding: 8px; }',
    '</style></head><body><main class="slide"><div class="box"><p class="card">一</p></div></main></body></html>'
  ].join('\n'));
  assert.ok(poured.report.unsupportedDetails.some((entry) => entry.property === 'columns'),
    'a column child that paints its own box is still named');

  // And the other half of the contract: a declaration that changes no pixel stays silent.
  const quiet = pipeline.convertHtml([
    '<html><head><style>',
    '  .slide { width: 1280px; height: 720px; padding: 40px; }',
    '  .box { width: 400px; height: 80px; background: #EEE; overflow: visible; }',
    '</style></head><body><main class="slide"><div class="box">text</div></main></body></html>'
  ].join('\n'));
  assert.deepEqual(quiet.report.unsupportedDetails, []);
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


test('!important outranks a normal declaration wherever it appears', () => {
  const width = (css, inline) => pipeline.convertHtml([
    '<html><head><style>',
    '  .slide { width: 1280px; height: 720px; padding: 40px; }',
    '  ' + css,
    '</style></head><body><main class="slide">',
    '  <div class="box" style="' + (inline || '') + '">x</div>',
    '</main></body></html>'
  ].join('\n')).deck.slides[0].elements[0].w;

  assert.equal(width('.box { width: 400px; } .box { width: 300px; }'), 3.125, 'later normal wins');
  assert.equal(width('.box { width: 400px !important; } .box { width: 300px; }'), 4.1667,
    'a later normal declaration cannot take an important property back');
  assert.equal(width('.box { width: 400px; } .box { width: 300px !important; }'), 3.125,
    'an important declaration wins from further down');
  assert.equal(width('.box { width: 400px !important; } .box { width: 200px !important; }'), 2.0833,
    'between two important ones, order still decides');
  assert.equal(width('.box { width: 400px !important; }', 'width: 100px'), 4.1667,
    'an inline style is normal priority, so an important rule beats it');
  assert.equal(width('.box { width: 400px !important; }', 'width: 100px !important'), 1.0417,
    'an inline important declaration is the most specific normal case and wins');
  // The shorthand carries its priority into the longhands it expands to.
  const padded = pipeline.convertHtml([
    '<html><head><style>',
    '  .slide { width: 1280px; height: 720px; padding: 40px; }',
    '  .box { width: 200px; font-size: 16px; padding: 20px !important; }',
    '  .box { padding: 0; }',
    '</style></head><body><main class="slide"><div class="box">x</div></main></body></html>'
  ].join('\n')).deck.slides[0].elements[0];
  assert.ok(padded.h > 0.5, 'the important padding survives a later reset: ' + padded.h);
});


test('ch and ex resolve from font ratios, not from half an em', () => {
  const width = (declaration) => pipeline.convertHtml([
    '<html><head><style>',
    '  .slide { width: 1280px; height: 720px; padding: 40px; }',
    '  .box { font-size: 16px; ' + declaration + ' }',
    '</style></head><body><main class="slide"><div class="box">x</div></main></body></html>'
  ].join('\n')).deck.slides[0].elements[0].w;

  // A zero is ~0.58em in the UI faces these decks use, an x-height ~0.52em. Half an em for
  // both made `width: 40ch` about a sixth too narrow, so the words wrapped a line early.
  assert.equal(Number(width('width: 40ch').toFixed(4)), Number((40 * 16 * 0.58 / 96).toFixed(4)));
  assert.equal(Number(width('width: 10ex').toFixed(4)), Number((10 * 16 * 0.52 / 96).toFixed(4)));
  assert.notEqual(Number(width('width: 40ch').toFixed(4)), Number(width('width: 40ex').toFixed(4)),
    'a character is wider than an x-height');
  // The plain em still means what it says.
  assert.equal(Number(width('width: 20em').toFixed(4)), Number((20 * 16 / 96).toFixed(4)));
});


test('left and right floats pack from opposite edges and the text sits between them', () => {
  const html = [
    '<html><head><style>',
    '  .slide { width: 1280px; height: 720px; padding: 40px; }',
    '  .l { float: left; width: 300px; height: 200px; margin-right: 24px; background: #17332F; }',
    '  .r { float: right; width: 260px; height: 200px; margin-left: 24px; background: #B4633A; }',
    '  .mid { margin: 0; font-size: 16px; line-height: 1.5; }',
    '</style></head><body><main class="slide">',
    '  <div class="l"></div>',
    '  <div class="r"></div>',
    '  <p class="mid">中间这一栏就是两条游标相遇之后剩下的空档。</p>',
    '</main></body></html>'
  ].join('\n');
  const result = pipeline.convertHtml(html);
  const [left, right, middle] = result.deck.slides[0].elements;
  const near = (actual, expected, message) =>
    assert.ok(Math.abs(actual - expected) < 0.001, message + ': ' + actual + ' vs ' + expected);
  const content = { x: 40 / 96, w: (1280 - 80) / 96 };

  near(left.x, content.x, 'the left float starts at the left edge');
  // The right float hugs the right edge; its 24px margin sits on its own left, inside the
  // band, which is where the browser puts it too.
  near(right.x + right.w, content.x + content.w, 'the right float ends at the right edge');
  // The band starts after the left float's box and margin, and stops at the right float's
  // margin: that gap is what the text gets.
  near(middle.x, content.x + (300 + 24) / 96, 'the text starts where the left float ends');
  near(middle.w, (1200 - 324 - 284) / 96, 'the text is as wide as the gap');
  near(middle.y, left.y, 'the text starts level with the floats');

  const reported = (result.report && result.report.unsupported) || [];
  assert.ok(!reported.some((entry) => entry.property === 'float'),
    'a left and a right float on one line is translated, not reported: ' + JSON.stringify(reported));
});


test('-webkit-line-clamp keeps N lines and ends the last one with an ellipsis', () => {
  const { clampText } = require('../native/engine/text_measure');
  const long = '这是一段很长的卡片说明文字，用来验证截断是否只保留两行并在末尾加上省略号。后面还有更多内容应当被丢掉。';
  const options = { lineHeight: 1.7, safetyFactor: 0.92 };
  const full = Number(require('../native/engine/text_measure').estimateLineCount(long, 2.5, 9.75, options));
  assert.ok(full > 2, 'the sample is long enough to wrap: ' + full);

  const clamped = clampText(long, 2.5, 9.75, 2, options);
  const lines = clamped.split('\n');
  assert.equal(lines.length, 2, 'exactly the clamped number of lines');
  assert.ok(lines[1].endsWith('…'), 'the last line carries the mark: ' + lines[1]);
  assert.ok(long.startsWith(lines[0].slice(0, -0)), 'the kept text is the beginning of the original');
  // Shorter than the limit is left exactly as it came in: truncating text that already fits
  // deletes content for no reason.
  assert.equal(clampText('短文本。', 2.5, 9.75, 4, options), null);

  // End to end: the deck carries the clamped string, reserves the clamped height, and says
  // nothing about the declaration, because it was honoured.
  const result = pipeline.convertHtml([
    '<html><head><style>',
    '  .slide { width: 1280px; height: 720px; padding: 40px; }',
    '  .c { width: 240px; font-size: 13px; line-height: 1.7; display: -webkit-box;',
    '       -webkit-box-orient: vertical; -webkit-line-clamp: 2; overflow: hidden; }',
    '</style></head><body><main class="slide">',
    '  <div class="c">' + long + '</div>',
    '</main></body></html>'
  ].join('\n'));
  const element = result.deck.slides[0].elements[0];
  assert.equal(String(element.text).split('\n').length, 2);
  assert.ok(String(element.text).endsWith('…'));
  assert.equal(result.report.unsupported, 0, JSON.stringify(result.report.unsupportedDetails));

  // A clamp outside a `-webkit-box` changes nothing in a browser, so it is reported rather
  // than applied: silently clamping there would delete text the design never asked to lose.
  const ignored = pipeline.convertHtml([
    '<html><head><style>',
    '  .slide { width: 1280px; height: 720px; padding: 40px; }',
    '  .c { width: 240px; font-size: 13px; -webkit-line-clamp: 2; }',
    '</style></head><body><main class="slide">',
    '  <div class="c">' + long + '</div>',
    '</main></body></html>'
  ].join('\n'));
  assert.equal(ignored.deck.slides[0].elements[0].text, long, 'the text is untouched');
  assert.ok((ignored.report.unsupportedDetails || []).some((entry) => entry.property === 'WebkitLineClamp'));
});


test('columns: N becomes one native text box with N columns', () => {
  const build = (css, markup) => pipeline.convertHtml([
    '<html><head><style>',
    '  .slide { width: 1280px; height: 720px; padding: 40px; }',
    '  ' + css,
    '</style></head><body><main class="slide">',
    markup,
    '</main></body></html>'
  ].join('\n'));

  const result = build(
    '.cols { columns: 2; column-gap: 48px; width: 900px; font-size: 12px; line-height: 2; }',
    '<div class="cols"><p>第一段足够长，会在栏宽之内折成几行，用来观察分栏之后的行数。</p>'
    + '<p>第二段也同样长，它应当接着第一段流进第二栏，而不是落在下面。</p></div>'
  );
  const element = result.deck.slides[0].elements[0];
  assert.equal(element.type, 'text', 'a column block is a text box, not a container');
  assert.equal(element.columns, 2);
  assert.equal(Number(element.columnGap.toFixed(4)), 0.5, 'column-gap 48px');
  assert.ok(String(element.text).includes('\n'), 'the paragraphs are one flow');
  assert.equal(result.report.unsupported, 0, JSON.stringify(result.report.unsupportedDetails));

  // The box is as tall as the balanced columns need: ceil(lines / N) rows, measured at the
  // column width, because PowerPoint fills a column to the bottom before starting the next.
  const { estimateLineCount } = require('../native/engine/text_measure');
  const gapIn = 48 / 96;
  const columnWidth = (900 / 96 - gapIn) / 2;
  const lines = estimateLineCount(String(element.text), columnWidth, 9,
    { lineHeight: 2, safetyFactor: 0.92 });
  const rowHeight = 9 * 2 / 72;
  assert.equal(Math.round(element.h / rowHeight), Math.ceil(lines / 2),
    'the box holds the balanced rows, not the whole text at full width');
  assert.ok(lines > Math.ceil(lines / 2), 'the sample really needs more than one row per column: ' + lines);
  // Inline semantics survive the split: the run array keeps bold and code.
  const rich = build(
    '.cols { columns: 2; width: 800px; font-size: 12px; }',
    '<div class="cols"><p>这里有 <strong>加粗</strong> 和 <code>代码</code>。</p><p>第二段。</p></div>'
  ).deck.slides[0].elements[0];
  assert.ok(Array.isArray(rich.text), 'mixed styling is carried as runs');
  assert.ok(rich.text.some((run) => run.options && run.options.bold), 'the bold run survives');
  assert.ok(rich.text.some((run) => run.options && run.options.fontFace), 'the code run keeps its face');

  // A child that paints its own box cannot be poured into a column: the paint would be cut in
  // half at the column edge, so the block keeps reporting instead of inventing geometry.
  const painted = build(
    '.cols { columns: 2; width: 800px; font-size: 12px; } .card { background: #eee; }',
    '<div class="cols"><div class="card">第一段带背景。</div><p>第二段。</p></div>'
  );
  assert.ok((painted.report.unsupportedDetails || []).some((entry) => entry.property === 'columns'),
    'a painted column child is reported');
});


test('font-variant: small-caps becomes the native run property cap="small"', () => {
  const build = (css, markup) => pipeline.convertHtml([
    '<html><head><style>',
    '  .slide { width: 1280px; height: 720px; padding: 40px; }',
    '  ' + css,
    '</style></head><body><main class="slide">',
    markup,
    '</main></body></html>'
  ].join('\n'));

  const block = build('.caps { font-variant: small-caps; font-size: 18px; }', '<div class="caps">Section Kicker</div>');
  assert.equal(block.deck.slides[0].elements[0].smallCaps, true);
  assert.equal(block.report.unsupported, 0, JSON.stringify(block.report.unsupportedDetails));

  // A column block carries it too: the flag rides on the same element.
  const columns = build('.cols { columns: 2; font-variant: small-caps; width: 700px; font-size: 12px; }',
    '<div class="cols"><p>第一段。</p><p>第二段。</p></div>');
  assert.equal(columns.deck.slides[0].elements[0].columns, 2);
  assert.equal(columns.deck.slides[0].elements[0].smallCaps, true);

  // `cap` is one attribute for the whole run, so an inline span asking for small caps inside
  // an ordinary paragraph would apply to every run or to none: that is reported, not guessed.
  const inline = build('.p { font-size: 18px; } .k { font-variant: small-caps; }',
    '<div class="p">A <span class="k">span</span> here</div>');
  assert.ok((inline.report.unsupportedDetails || []).some((entry) => entry.property === 'fontVariant'),
    'an inline small-caps span is reported');

  // Other values have no native spelling at all.
  const other = build('.p { font-variant: all-small-caps; font-size: 18px; }', '<div class="p">Text</div>');
  assert.ok((other.report.unsupportedDetails || []).some((entry) => entry.property === 'fontVariant'));
  assert.ok(!other.deck.slides[0].elements[0].smallCaps);
});


test('clip-path: polygon becomes a native custom geometry', () => {
  const build = (css, markup) => pipeline.convertHtml([
    '<html><head><style>',
    '  .slide { width: 1280px; height: 720px; padding: 40px; }',
    '  ' + css,
    '</style></head><body><main class="slide">',
    markup,
    '</main></body></html>'
  ].join('\n'));

  const slanted = build('.band { width: 600px; height: 200px; background: #17332F;'
    + ' clip-path: polygon(0 0, 100% 0, 100% 60%, 0 100%); }', '<div class="band"></div>');
  const shape = slanted.deck.slides[0].elements.find((element) => element.type === 'shape');
  assert.ok(shape && shape.clip, 'the surface carries the polygon');
  // Points are CSS pixels relative to the border box, which is what `a:path` scales from.
  assert.deepEqual(shape.clip.points, [[0, 0], [600, 0], [600, 120], [0, 200]]);
  assert.equal(shape.clip.width, 600);
  assert.equal(shape.clip.height, 200);
  assert.equal(slanted.report.unsupported, 0, JSON.stringify(slanted.report.unsupportedDetails));

  // Lengths work as well as percentages.
  const lengths = build('.chip { width: 200px; height: 100px; background: #E8E1D0;'
    + ' clip-path: polygon(10px 0, 100% 0, 100% 100%, 0 100%); }', '<div class="chip"></div>');
  const chip = lengths.deck.slides[0].elements.find((element) => element.type === 'shape');
  assert.deepEqual(chip.clip.points[0], [10, 0]);

  // A custom geometry clips the box, not the subtree: children would paint outside the polygon.
  const withKids = build('.panel { width: 400px; height: 200px; background: #eee;'
    + ' clip-path: polygon(0 0, 100% 0, 100% 100%, 0 80%); }',
    '<div class="panel"><p>里面有文字。</p></div>');
  assert.ok((withKids.report.unsupportedDetails || []).some((entry) => entry.property === 'clipPath'),
    'a clipped box with children is reported');

  // An inscribed circle is the native ellipse preset now, not a report; only a
  // non-inscribed circle or a moved centre stays named.
  const circle = build('.dot { width: 120px; height: 120px; background: #123; clip-path: circle(50%); }',
    '<div class="dot"></div>');
  assert.equal(circle.deck.slides[0].elements[0].shape, 'ellipse');
  const offCircle = build('.dot { width: 200px; height: 100px; background: #123; clip-path: circle(50%); }',
    '<div class="dot"></div>');
  assert.ok((offCircle.report.unsupportedDetails || []).some((entry) => entry.property === 'clipPath'));
  const autoHeight = build('.p { width: 300px; background: #123; clip-path: polygon(0 0, 100% 0, 0 100%); }',
    '<div class="p">auto height text</div>');
  assert.ok((autoHeight.report.unsupportedDetails || []).some((entry) => entry.property === 'clipPath'));

  // The emitted XML is a closed path with a point per vertex.
  const { clipGeometryXml } = require('../native/engine/native_pptx');
  const xml = clipGeometryXml({ points: [[0, 0], [10, 0], [10, 10]], width: 10, height: 10 });
  assert.ok(xml.startsWith('<a:custGeom>'));
  assert.equal((xml.match(/<a:pt /gu) || []).length, 3);
  assert.ok(xml.includes('<a:close/>'));
  assert.ok(xml.includes('w="10" h="10"'));
  assert.equal(clipGeometryXml({ points: [[0, 0]] }), null, 'two points are not a shape');
});


test('a run with its own size is measured at that size', () => {
  const build = (markup) => pipeline.convertHtml([
    '<html><head><style>',
    '  .slide { width: 1280px; height: 720px; padding: 40px; }',
    '  .num { width: 200px; font-size: 44px; line-height: 1.1; }',
    '  .num small { font-size: 16px; }',
    '</style></head><body><main class="slide">',
    markup,
    '</main></body></html>'
  ].join('\n'));

  // Charging the small run to the 44px number reserved two lines for one: the box was a
  // line too tall and the box below it slid down by that line.
  const short = build('<div class="num">12<small> 个</small></div>').deck.slides[0].elements[0];
  const lineBox = 44 * 1.1 / 72;
  assert.equal(Math.round(short.h / lineBox), 1, 'one line, measured at both sizes');

  // The same box with a long number still grows, which is the point of measuring at all.
  const long = build('<div class="num">1200000000<small> 个</small></div>').deck.slides[0].elements[0];
  assert.ok(long.h > short.h);
});

test('text on text is a collision even when it is positioned', () => {
  const build = (markup) => pipeline.convertHtml([
    '<html><head><style>',
    '  .slide { width: 1280px; height: 720px; padding: 40px; position: relative; }',
    '  .a { position: absolute; left: 100px; top: 100px; width: 300px; height: 100px; font-size: 14px; }',
    '  .b { position: absolute; left: 250px; top: 120px; width: 300px; height: 100px; font-size: 14px; }',
    '  .bg { position: absolute; left: 100px; top: 300px; width: 300px; height: 100px; background: #eee; }',
    '  .lbl { position: absolute; left: 120px; top: 320px; width: 200px; height: 40px; font-size: 14px; }',
    '</style></head><body><main class="slide">',
    markup,
    '</main></body></html>'
  ].join('\n'));

  // Two absolute text boxes over each other is unreadable, and absolute positioning was
  // previously enough to hide it: only a shape under a text box is a layer.
  const overlapped = build('<div class="a">AAAAAAAAAA</div><div class="b">BBBBBBBBBB</div>');
  assert.equal(overlapped.report.layout.total, 1);
  const collision = overlapped.report.layout.slides[0].collisions[0];
  assert.match(collision.a, /AAAAAAAAAA/u);
  assert.match(collision.b, /BBBBBBBBBB/u);

  const layered = build('<div class="bg"></div><div class="lbl">label on card</div>');
  assert.equal(layered.report.layout.total, 0, 'a label on a card is a layer, not a collision');

  // A wrapper that holds text is a text block for this purpose: the common "step" layout
  // puts the date, the title and the body in one absolutely positioned wrapper.
  const wrapped = pipeline.convertHtml([
    '<html><head><style>',
    '  .slide { width: 1280px; height: 720px; padding: 40px; position: relative; }',
    '  .step { position: absolute; top: 100px; width: 200px; }',
    '</style></head><body><main class="slide">',
    '<div class="step" style="left: 0"><div>01</div><div>first</div></div>',
    '<div class="step" style="left: 120px"><div>02</div><div>second</div></div>',
    '</main></body></html>'
  ].join('\n'));
  assert.equal(wrapped.report.layout.total, 1, 'two overlapping step wrappers are reported');
});

test('a table caption becomes its own text box above the table', () => {
  const result = pipeline.convertHtml([
    '<html><head><style>',
    '  .slide { width: 1280px; height: 720px; padding: 40px; }',
    '  table { width: 800px; font-size: 13px; } td, th { padding: 8px; }',
    '  caption { font-size: 12px; text-align: left; color: #8A9793; padding: 0 8px 6px; }',
    '</style></head><body><main class="slide">',
    '<table><caption>Rendering times</caption>',
    '<thead><tr><th>Layout</th><th>ms</th></tr></thead>',
    '<tbody><tr><td>Cover</td><td>41</td></tr></tbody></table>',
    '</main></body></html>'
  ].join('\n'));
  const elements = result.deck.slides[0].elements;
  const caption = elements.find((element) => element.type === 'text' && element.text === 'Rendering times');
  const table = elements.find((element) => element.type === 'table');
  assert.ok(caption, 'the caption is a text box, not a lost row');
  assert.equal(caption.color, '8A9793');
  assert.equal(caption.align, 'left');
  assert.ok(caption.y + caption.h <= table.y + 0.001, 'the caption sits above the grid');
  assert.equal(table.rows.length, 2, 'the caption is not one of the table rows');
  assert.equal(result.report.unsupported, 0, JSON.stringify(result.report.unsupportedDetails));
});


test('justify-content: space-evenly gives every gap the same width', () => {
  const rows = (value) => {
    const slide = pipeline.convertHtml([
    '<html><head><style>',
    '  .slide { width: 1280px; height: 720px; padding: 80px; }',
    '  .row { display: flex; justify-content: ' + value + '; }',
    '  .row div { width: 100px; }',
    '</style></head><body><main class="slide">',
    '<div class="row"><div>a</div><div>b</div><div>c</div></div>',
    '</main></body></html>'
    ].join('\n')).deck.slides[0];
  // A container positions its children when the deck is written, so the boxes come from the
  // engine that writes them rather than from the spec.
  const { layoutSlide } = require('../native/engine/layout');
  return Object.values(layoutSlide(
    { elements: JSON.parse(JSON.stringify(slide.elements)), margin: 0, gap: 0 },
    { width: 13.3333, height: 7.5 }, {}, {}
  )).map((element) => Number(element.x.toFixed(3)));
  };

  // The container is 11.6663in wide, holds three 1.0417in boxes, so free is 8.5412in and each
  // of the four gaps - the two outer ones included - is 2.1353in.
  const evenly = rows('space-evenly');
  const evened = rows('space-around');
  assert.equal(evenly.length, 3);
  assert.equal(evened.length, 3);
  // Both sides of the middle box must be the same distance: that is what "evenly" means.
  const leftGap = evenly[1] - evenly[0];
  const rightGap = evenly[2] - evenly[1];
  assert.ok(Math.abs(leftGap - rightGap) < 0.002, 'gaps are equal on both sides');
  assert.ok(evenly[0] > 0.85, 'the outer gaps exist');
  // The two outer boxes differ from space-around (a wider outer gap); the middle one does not,
  // because both distribute symmetrically about the centre - which is why this compares the edge.
  assert.ok(evenly[0] > evened[0], 'space-evenly is not space-around in disguise');
});

test('a table cell carries its line spacing, and names the wrap it cannot switch', async () => {
  // The row height was measured with the cell's line spacing while the drawn cell used
  // single spacing - measured tall, drawn tight. The writer does spell both halves of
  // a:lnSpc for a cell, so points win when CSS gave a length. A cell has no per-cell wrap
  // switch, and that is named once per table instead of quietly re-wrapping the line.
  const JSZip = require(require.resolve('jszip', { paths: [require.resolve('../native/engine/native_pptx')] }));
  const fs = require('node:fs');
  const os = require('node:os');
  const path = require('node:path');
  const { generatePptx } = require('../native/engine/native_pptx');
  const build = (css) => pipeline.convertHtml([
    '<html><head><style>',
    '  .slide { width: 1280px; height: 720px; padding: 40px; }',
    '  table { width: 700px; border-collapse: collapse; }',
    '  td { font-size: 15px; padding: 10px; }',
    css,
    '</style></head><body><main class="slide"><table><tr><td class="x">间距检验</td></tr></table></main></body></html>'
  ].join('\n'));
  const cellXml = async (css) => {
    const result = build(css);
    const output = path.join(os.tmpdir(), 'native-cell-' + process.pid + '.pptx');
    await generatePptx(result.deck, output);
    const zip = await JSZip.loadAsync(fs.readFileSync(output));
    const xml = await zip.file('ppt/slides/slide1.xml').async('string');
    fs.rmSync(output, { force: true });
    return { cell: (/<a:tc>[\s\S]*?间距检验[\s\S]*?<\/a:tc>/u.exec(xml) || [''])[0], report: result.report };
  };

  const multiple = await cellXml('td.x { line-height: 1.6; }');
  assert.match(multiple.cell, /<a:lnSpc><a:spcPct val="160000"\/>/u, '1.6 is 160% line spacing');

  const points = await cellXml('td.x { line-height: 26px; }');
  assert.match(points.cell, /<a:lnSpc><a:spcPts val="1950"\/>/u, '26px is 19.5pt');

  const nowrap = await cellXml('td.x { white-space: nowrap; }');
  const named = nowrap.report.unsupportedDetails.filter((entry) => entry.property === 'whiteSpace');
  assert.equal(named.length, 1, 'nowrap in a cell is named once');
  assert.match(named[0].reason, /no wrap switch/u, named[0].reason);
  assert.equal((nowrap.report.unsupportedDetails.filter((entry) => entry.property === 'whiteSpace')).length, 1,
    'and not once per cell');
});

test('a clipped single line is named, and word-wrap is the old name for overflow-wrap', () => {
  // `text-overflow: clip` in a box that clips cuts the line at its edge. A reader draws the
  // words past the box instead, so the case is named - but only when the line really is
  // longer than the box, which is measured rather than assumed.
  const build = (css, text) => pipeline.convertHtml([
    '<html><head><style>',
    '  .slide { width: 1280px; height: 720px; padding: 40px; }',
    '  p.x { width: 240px; font-size: 20px; }',
    css,
    '</style></head><body><main class="slide"><p class="x">',
    text || '这是一段很长很长的说明文字，会被截断并加省略号',
    '</p></main></body></html>'
  ].join('\n'));

  const clipped = build('p.x { overflow: hidden; white-space: nowrap; text-overflow: clip; }');
  const named = clipped.report.unsupportedDetails.filter((entry) => entry.property === 'textOverflow');
  assert.equal(named.length, 1, 'the clipped overflow is named');
  assert.match(named[0].reason, /in of text in a [\d.]+in box/u, named[0].reason);

  const fits = build('p.x { overflow: hidden; white-space: nowrap; text-overflow: clip; }', '短');
  assert.deepEqual(fits.report.unsupportedDetails.map((entry) => entry.property), [], 'a line that fits is silent');

  const wrapping = build('p.x { overflow: hidden; }');
  assert.deepEqual(wrapping.report.unsupportedDetails.map((entry) => entry.property), [],
    'a wrapping block hides nothing the deck could not draw');

  // The ellipsis case truncates instead, so it needs no word.
  const ellipsis = build('p.x { overflow: hidden; white-space: nowrap; text-overflow: ellipsis; }');
  assert.deepEqual(ellipsis.report.unsupportedDetails.map((entry) => entry.property), []);

  // `word-wrap` is the legacy spelling of `overflow-wrap` (CSS Text 3). The deck breaks long
  // words either way, so reporting the old name was noise about a word, not about a loss.
  for (const css of ['p.x { word-wrap: break-word; }', 'p.x { overflow-wrap: break-word; }']) {
    assert.deepEqual(build(css).report.unsupportedDetails.map((entry) => entry.property), [],
      'no report for ' + css);
  }
});

test('cell text carries its own decoration, case and honest gaps', async () => {
  // A table cell builds its own run properties, so it needs its own audit: the cell's
  // decoration and its text-transform were read from inline elements only, which left a
  // total row un-underlined and an uppercase header in lower case. Something a cell
  // cannot carry is named once per table instead of disappearing.
  const JSZip = require(require.resolve('jszip', { paths: [require.resolve('../native/engine/native_pptx')] }));
  const fs = require('node:fs');
  const os = require('node:os');
  const path = require('node:path');
  const { generatePptx } = require('../native/engine/native_pptx');
  const cellXml = async (css, cellHtml) => {
    const result = pipeline.convertHtml([
      '<html><head><style>',
      '  .slide { width: 1280px; height: 720px; padding: 40px; }',
      '  table { width: 900px; font-size: 14px; }',
      '  td { padding: 8px; }',
      css,
      '</style></head><body><main class="slide">',
      '<table><tr>' + (cellHtml || '<td class="c">Cell 单元格</td>') + '</tr></table>',
      '</main></body></html>'
    ].join('\n'));
    const output = path.join(os.tmpdir(), 'native-cell-' + process.pid + '.pptx');
    await generatePptx(result.deck, output);
    const zip = await JSZip.loadAsync(fs.readFileSync(output));
    const xml = await zip.file('ppt/slides/slide1.xml').async('string');
    fs.rmSync(output, { force: true });
    return { xml, report: result.report };
  };

  const underlined = await cellXml('td.c { text-decoration: underline; }');
  assert.match(underlined.xml, /<a:rPr[^>]*u="sng"/u, 'a plain underline is u="sng" in a cell');

  const dotted = await cellXml('td.c { text-decoration: underline dotted; }');
  assert.match(dotted.xml, /<a:rPr[^>]*u="dotted"/u, 'the underline style rides the same attribute');

  const struck = await cellXml('td.c { text-decoration: line-through; }');
  assert.match(struck.xml, /<a:rPr[^>]*strike="sngStrike"/u, 'a struck cell is struck');

  const shouted = await cellXml('td.c { text-transform: uppercase; }');
  assert.match(shouted.xml, /<a:t>CELL 单元格<\/a:t>/u, 'the case reaches the characters in a cell too');

  for (const [css, property] of [
    ['td.c { font-variant: small-caps; }', 'fontVariant'],
    ['td.c { word-spacing: 6px; }', 'wordSpacing'],
    ['td.c { text-shadow: 1px 1px 2px #000; }', 'textShadow'],
    ['td.c { text-indent: 2em; }', 'textIndent']
  ]) {
    const result = await cellXml(css);
    assert.ok(result.report.unsupportedDetails.some((entry) => entry.property === property),
      property + ' is named for a cell rather than dropped');
  }
});

test('typography either reaches the file or is named', async () => {
  // The same read-back rule as the chart options, applied to type: every CSS typography
  // property either lands in the XML or is named. The probe found one silent drop - a
  // light weight drawn as regular - and the rest already honest.
  const JSZip = require(require.resolve('jszip', { paths: [require.resolve('../native/engine/native_pptx')] }));
  const fs = require('node:fs');
  const os = require('node:os');
  const path = require('node:path');
  const { generatePptx } = require('../native/engine/native_pptx');
  const build = (css, text) => pipeline.convertHtml([
    '<html><head><style>',
    '  .slide { width: 1280px; height: 720px; padding: 40px; }',
    '  p { font-size: 24px; width: 900px; }',
    css,
    '</style></head><body><main class="slide"><p class="x">' + (text || 'Typography 排版') + '</p></main></body></html>'
  ].join('\n'));
  const xmlOf = async (css, text) => {
    const result = build(css, text);
    const output = path.join(os.tmpdir(), 'native-typo-' + process.pid + '.pptx');
    await generatePptx(result.deck, output);
    const zip = await JSZip.loadAsync(fs.readFileSync(output));
    const xml = await zip.file('ppt/slides/slide1.xml').async('string');
    fs.rmSync(output, { force: true });
    return { xml, report: result.report };
  };

  const spacing = await xmlOf('p.x { letter-spacing: 2px; }');
  assert.match(spacing.xml, /spc="150"/u, '2px of tracking is 1.5pt of spc');

  const caps = await xmlOf('p.x { font-variant: small-caps; }');
  assert.match(caps.xml, /cap="small"/u, 'small caps are cap="small"');

  const justified = await xmlOf('p.x { text-align: justify; }');
  assert.match(justified.xml, /algn="just"/u, 'justify is algn="just"');

  const struck = await xmlOf('p.x { text-decoration: line-through; }');
  assert.match(struck.xml, /strike="sngStrike"/u, 'a line through is sngStrike');

  const upper = await xmlOf('p.x { text-transform: uppercase; }');
  assert.match(upper.xml, /<a:t>TYPOGRAPHY 排版<\/a:t>/u, 'uppercase reaches the characters');

  const pre = await xmlOf('p.x { white-space: pre; }', '两  个');
  assert.match(pre.xml, /<a:t>两  个<\/a:t>/u, 'pre keeps the double space');

  // A text shadow is a run effect: 4px of blur is 3pt (38100 EMU), a 1px offset straight
  // right is 0.75pt (9525) at 0 degrees, and the node sits inside the run properties.
  const shadowed = await xmlOf('p.x { text-shadow: 1px 0 4px #000; }');
  assert.match(shadowed.xml, /<a:outerShdw blurRad="38100" dist="9525" dir="0"[^>]*algn="t"/u,
    'the text shadow reaches the run properties');
  assert.deepEqual(shadowed.report.unsupportedDetails.map((entry) => entry.property), [],
    'a single text shadow is not a gap');

  // The rest have no native spelling and say so.
  for (const [css, property] of [
    ['p.x { word-spacing: 8px; }', 'wordSpacing'],
    ['p.x { hyphens: auto; }', 'hyphens'],

    ['p.x { font-stretch: condensed; }', 'fontStretch'],
    ['p.x { font-weight: 300; }', 'fontWeight']
  ]) {
    const result = await xmlOf(css);
    assert.ok(result.report.unsupportedDetails.some((entry) => entry.property === property),
      property + ' is named rather than dropped');
  }

  // 400 and 500 are regular, 600 and up are bold: both spellable, both silent.
  for (const weight of [400, 500, 600, 700]) {
    const result = await xmlOf('p.x { font-weight: ' + weight + '; }');
    assert.deepEqual(result.report.unsupportedDetails.map((entry) => entry.property), [],
      weight + ' needs no report');
  }
});

test('an undeclared table shares its width the way the browser does', () => {
  // A table that declares no widths used to be split evenly, which made a 60px label
  // column 350px wide and wrapped a sentence Chrome kept on one line. Chrome measures
  // each column's widest line and shares the table out; these numbers are what Chrome
  // reported for each case (getBoundingClientRect on the first row's cells).
  const build = (rows) => pipeline.convertHtml([
    '<html><head><style>',
    '  .slide { width: 1280px; height: 720px; padding: 0; }',
    '  table { width: 700px; border-collapse: collapse; }',
    '  td { font-size: 15px; padding: 10px 12px; border-bottom: 1px solid #ccc; }',
    '</style></head><body><main class="slide"><table>',
    rows.map((cells) => '<tr>' + cells.map((text) => '<td>' + text + '</td>').join('') + '</tr>').join(''),
    '</table></main></body></html>'
  ].join('\n'));
  const widths = (rows) => {
    const table = build(rows).deck.slides[0].elements.find((entry) => entry.type === 'table');
    return table.options.colW.map((value) => Math.round(value * 96 * 100) / 100);
  };
  const near = (actual, expected, message) => {
    assert.equal(actual.length, expected.length, message + ': column count');
    actual.forEach((value, index) => {
      assert.ok(Math.abs(value - expected[index]) <= 1,
        message + ': column ' + index + ' is ' + value + ', Chrome said ' + expected[index]);
    });
  };

  near(widths([['项目', '这一单元格的行距是一点六倍，用于检验行距是否写进文件而不是只用于测量高度。']]),
    [59.7, 640.3], 'a label beside a sentence');
  near(widths([['编号', '名称', '说明文字稍微长一些并会换行显示的内容']]), [94.02, 94.02, 511.97], 'three columns');
  near(widths([['甲', '乙', '丙']]), [233.33, 233.33, 233.34], 'nothing to measure: an even split');
  near(widths([['第一列稍微长一点点', '短']]), [562.11, 137.89], 'the wider column keeps the room');

  // A declared width still wins: the browser's answer only fills the gap.
  const declared = pipeline.convertHtml([
    '<html><head><style>',
    '  .slide { width: 1280px; height: 720px; }',
    '  table { width: 700px; } td { font-size: 15px; padding: 0; }',
    '  td.a { width: 200px; } td.b { width: 500px; }',
    '</style></head><body><main class="slide"><table>',
    '<tr><td class="a">甲</td><td class="b">乙</td></tr></table></main></body></html>'
  ].join('\n'));
  const declaredWidths = declared.deck.slides[0].elements.find((entry) => entry.type === 'table')
    .options.colW.map((value) => Math.round(value * 96));
  assert.deepEqual(declaredWidths, [200, 500], 'a declared column width is kept');
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

test('alignment and fit values that would move a pixel are named', () => {
  const build = (css) => pipeline.convertHtml([
    '<html><head><style>',
    '  .slide { width: 1280px; height: 720px; padding: 40px; }',
    '  ' + css,
    '</style></head><body><main class="slide">',
    '<div class="row"><div class="small">small</div><div style="font-size: 30px">BIG</div></div>',
    '</main></body></html>'
  ].join('\n')).report.unsupportedDetails.map((item) => item.property);

  // `align-items: baseline` was silently stretched: every box in the row moved.
  assert.ok(build('.row { display: flex; align-items: baseline; }').includes('alignItems'));
  // Exactly-mapped values stay silent, or the report becomes noise nobody reads.
  assert.deepEqual(build('.row { display: flex; align-items: center; }'), []);

  const fit = (value) => pipeline.convertHtml([
    '<html><head><style>',
    '  .slide { width: 1280px; height: 720px; padding: 40px; }',
    '  .p { width: 200px; height: 120px; } .p img { width: 100%; height: 100%; object-fit: ' + value + '; }',
    '</style></head><body><main class="slide">',
    '<div class="p"><img src="data:image/gif;base64,R0lGODlhAQABAIAAAAAAAP///yH5BAEAAAAALAAAAAABAAEAAAIBRAA7" alt=""></div>',
    '</main></body></html>'
  ].join('\n')).report.unsupportedDetails.map((item) => item.property);
  assert.deepEqual(fit('cover'), [], 'cover is translated exactly');
  // These two used to be approximated as contain and named; the fit geometry now spells
  // them, so the report goes quiet - the geometry test below pins what they draw.
  assert.deepEqual(fit('none'), [], 'none is drawn at the source size now');
  assert.deepEqual(fit('scale-down'), [], 'and so is scale-down');
});


test('an inline ::before joins the line as a run, and attr() resolves', () => {
  const build = (css, markup) => pipeline.convertHtml([
    '<html><head><style>',
    '  .slide { width: 1280px; height: 720px; padding: 40px; }',
    '  .row { font-size: 18px; color: #212B29; }',
    '  ' + css,
    '</style></head><body><main class="slide">' + markup + '</main></body></html>'
  ].join('\n'));

  const arrow = build('.row::before { content: "\\2192  "; color: #C05B3E; }',
    '<div class="row">read the DOM</div>');
  const boxes = arrow.deck.slides[0].elements.filter((element) => element.type === 'text');
  assert.equal(boxes.length, 1, 'the decoration does not become a box of its own');
  assert.ok(Array.isArray(boxes[0].text), 'the line is made of runs');
  // CSS collapses the run of spaces in normal white-space, so two spaces are one.
  assert.equal(boxes[0].text[0].text, '\u2192 ');
  assert.equal(boxes[0].text[0].options.color, 'C05B3E', 'the arrow keeps its own colour');
  assert.equal(boxes[0].text[1].text, 'read the DOM');
  assert.equal(arrow.report.unsupported, 0, 'a translatable decoration says nothing');

  // `content` is a sequence: a string and an attribute are concatenated in order.
  const tag = build('.row::after { content: "  \\00B7  " attr(data-k); font-size: 11px; }',
    '<div class="row" data-k="P0">body</div>');
  const tagged = tag.deck.slides[0].elements.find((element) => element.type === 'text');
  const tail = tagged.text[tagged.text.length - 1];
  assert.equal(tail.text, ' \u00B7 P0');
  assert.equal(tail.options.fontSize, 8.25);

  // Generated content that needs state the DOM does not carry is named, not guessed.
  const counter = build('.row::before { content: counter(step) ". "; }', '<div class="row">alpha</div>');
  assert.ok(counter.report.unsupportedDetails.some((item) => item.property === '::before'));

  // A container has no single line for the words to join.
  const container = build('.card::before { content: "NEW"; }',
    '<div class="card"><p>one</p><p>two</p></div>');
  assert.ok(container.report.unsupportedDetails.some((item) => item.property === '::before'));
});


test('a table taller than its slide continues on more slides with the header repeated', () => {
  const rows = (count) => Array.from({ length: count },
    (unused, index) => '<tr><td>row ' + index + '</td><td>' + index * 3 + ' ms</td></tr>').join('');
  const result = pipeline.convertHtml([
    '<html><head><style>',
    '  .slide { width: 1280px; height: 720px; padding: 48px; }',
    '  table { width: 1000px; font-size: 14px; border-collapse: collapse; }',
    '  th, td { padding: 8px; border-bottom: 1px solid #ddd; }',
    '  thead th { background: #17332F; color: #fff; }',
    '  tfoot td { font-weight: 600; }',
    '</style></head><body><main class="slide"><table>',
    '<thead><tr><th>name</th><th>value</th></tr></thead>',
    '<tbody>' + rows(60) + '</tbody>',
    '<tfoot><tr><td>total</td><td>999</td></tr></tfoot>',
    '</table></main></body></html>'
  ].join('\n'));

  const slides = result.deck.slides;
  assert.ok(slides.length > 1, 'one source page became several slides');
  assert.equal(result.report.paginatedTables.length, 1);
  // Every row is still there, once: 1 header + 60 body + 1 footer, plus one repeated header per
  // continuation page.
  const written = slides.flatMap((slide) => slide.elements.find((element) => element.type === 'table').rows);
  assert.equal(written.length, 62 + (slides.length - 1), 'each continuation repeats only the header');
  assert.equal(written.filter((cells) => cells[0].text === 'name').length, slides.length, 'the header is on every page');
  assert.equal(written.filter((cells) => cells[0].text === 'total').length, 1, 'the footer is on the last page only');
  slides.forEach((slide, index) => {
    const table = slide.elements.find((element) => element.type === 'table');
    assert.ok(table.y + table.h <= 7.5 - 0.24, 'page ' + (index + 1) + ' fits');
    assert.equal(table.y, slides[0].elements.find((element) => element.type === 'table').y,
      'every page keeps the table top');
  });
  // The deck no longer runs off the page, so the analysis overflow is not reported.
  assert.equal(result.report.layout.total, 0, 'a split table is not an overflow');
});

test('a table that fits is left alone', () => {
  const result = pipeline.convertHtml([
    '<html><head><style>',
    '  .slide { width: 1280px; height: 720px; padding: 48px; }',
    '  table { width: 800px; font-size: 14px; }',
    '  td { padding: 6px; }',
    '</style></head><body><main class="slide">',
    '<table><thead><tr><th>a</th></tr></thead><tbody><tr><td>1</td></tr></tbody></table>',
    '</main></body></html>'
  ].join('\n'));
  assert.equal(result.deck.slides.length, 1);
  assert.equal(result.report.paginatedTables.length, 0);
  assert.equal(result.deck.slides[0].elements.find((element) => element.type === 'table').rows.length, 2);
});


test('border-radius: 50% is the inscribed ellipse, smaller percentages are named', () => {
  const shape = (css) => {
    const result = pipeline.convertHtml([
      '<html><head><style>',
      '  .slide { width: 1280px; height: 720px; padding: 40px; }',
      '  ' + css,
      '</style></head><body><main class="slide"><div class="box"></div></main></body></html>'
    ].join('\n'));
    return {
      element: result.deck.slides[0].elements[0] || {},
      reported: result.report.unsupportedDetails.map((item) => item.property)
    };
  };

  // A dot and a badge are the same declaration on boxes of different proportions.
  const dot = shape('.box { width: 120px; height: 120px; background: #17332F; border-radius: 50%; }');
  assert.equal(dot.element.shape, 'ellipse', 'a square with 50% is a circle');
  assert.equal(dot.element.radius, undefined, 'and not a rounded rectangle');
  assert.deepEqual(dot.reported, []);

  const wide = shape('.box { width: 300px; height: 120px; background: #C05B3E; border-radius: 50%; }');
  assert.equal(wide.element.shape, 'ellipse', 'a wide box with 50% is the inscribed ellipse');

  // A radius in points stays a rounded rectangle.
  const card = shape('.box { width: 300px; height: 120px; background: #fff; border-radius: 16px; }');
  assert.equal(card.element.radius, 0.167);
  assert.equal(card.element.shape, undefined);

  // A smaller percentage is an elliptical corner no native geometry spells.
  const soft = shape('.box { width: 120px; height: 120px; background: #ccc; border-radius: 25%; }');
  assert.equal(soft.element.shape, undefined);
  assert.equal(soft.element.radius, undefined);
  assert.deepEqual(soft.reported, ['borderRadius'], 'the box arrives square, so it is named');
});


test('a border side is a border: the content starts inside it', () => {
  // A single-side border is drawn as a strip, but CSS still treats it as a border: the content
  // box sits inside it. Chrome, on this markup, puts the first line 26px from the card's left
  // edge (4px of border plus 22px of padding) and leaves 22px on the right.
  const html = [
    '<html><head><style>',
    '  .slide { width: 1280px; height: 720px; padding: 40px; background: #FBFAF7; }',
    '  .card { width: 300px; padding: 20px 22px; background: #FFFFFF;',
    '    border-left: 4px solid #2F5D50; }',
    '</style></head><body><main class="slide"><div class="card">盒子里的文字</div></main></body></html>'
  ].join('\n');
  const card = pipeline.convertHtml(html).deck.slides[0].elements[0];
  assert.equal(card.type, 'container');
  assert.equal(card.edge.side, 'left');
  assert.ok(Math.abs(card.padding.left * 96 - 26) < 0.2, 'left inset: ' + (card.padding.left * 96).toFixed(2));
  assert.ok(Math.abs(card.padding.right * 96 - 22) < 0.2, 'right inset: ' + (card.padding.right * 96).toFixed(2));
  assert.ok(Math.abs(card.w * 96 - 300) < 0.5, 'the border box keeps its declared width');
});

test('every example deck is one the gates convert', () => {
  // The reader gates read `pipeline-converted/`, which is generated. A new example that no gate
  // converts is a fixture nobody checks, so the conversion list is pinned to the examples on disk:
  // adding an example means adding it here, and `npm run pipeline:all` picks it up.
  const fs = require('node:fs');
  const path = require('node:path');
  const { execFileSync } = require('node:child_process');
  const native = path.join(__dirname, '..', 'native');
  const listed = execFileSync(process.execPath, [path.join(native, 'scripts', 'convert_examples.js'), '--list'],
    { cwd: native, encoding: 'utf8' }).trim().split('\n').filter(Boolean);
  const onDisk = fs.readdirSync(path.join(__dirname, '..', 'examples'))
    .filter((name) => /^pipeline-.*\.html$/u.test(name))
    .map((name) => name.replace(/\.html$/u, ''))
    .sort();
  assert.deepEqual(listed, onDisk, 'the converter covers every pipeline example');
  assert.equal(listed.length, 19, 'nineteen example decks today');
});

test('the catalogue of what the engine cannot draw matches the code', () => {
  // The contract is that every difference the drawing cannot express is named. That claim is easy
  // to erode - a new report appears and the document drifts - so LIMITS.md is generated from the
  // analyzer and this test is the drift gate. `npm run limits:update` is the way to bless it.
  const { collect, prose } = require('../native/scripts/limits_report');
  const fs = require('node:fs');
  const path = require('node:path');
  const entries = collect();
  assert.ok(entries.length > 100, 'the analyzer reports on more than a hundred sites, got ' + entries.length);
  const properties = new Set(entries.map((entry) => entry.property));
  assert.ok(properties.size > 50, 'spread over more than fifty properties, got ' + properties.size);
  ['float', 'borderCollapse', 'clipPath', 'objectFit', 'data-chart', 'element'].forEach((property) => {
    assert.ok(properties.has(property), 'the catalogue knows about ' + property);
  });
  assert.ok(entries.every((entry) => entry.property && entry.property.length), 'every site names its property');

  const file = path.join(__dirname, '..', 'native', 'LIMITS.md');
  const written = fs.readFileSync(file, 'utf8').replace(/\r\n/gu, '\n').trimEnd();
  assert.equal(written, prose().trimEnd(), 'LIMITS.md is stale: run `npm run limits:update`');
});

test('a picture this engine cannot read is named, not silently missing', async () => {
  // Three ways to have no bytes for a picture: a remote url (this converter never touches the
  // network), a file that is not there, and a relative path with no base directory to resolve
  // against. Each used to leave a hole in the slide and say nothing - the spec claimed a picture
  // and the package had none; a missing local file was worse, failing the whole write at the last
  // moment with a media error. All three are now one line in the report, and the box keeps its
  // place so the composition around it does not move.
  const fs = require('node:fs');
  const os = require('node:os');
  const path = require('node:path');
  const png = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAGQAAAAyCAIAAAC0m0JJAAAAWklEQVR4nO3NMQEAAAgDoC251a3gLzRgkjl3dgEAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAOA1A3l0AAG8DQ0iAAAAAElFTkSuQmCC', 'base64');
  const folder = fs.mkdtempSync(path.join(os.tmpdir(), 'native-src-'));
  fs.writeFileSync(path.join(folder, 'real.png'), png);
  const page = (src) => [
    '<html><head><style>.slide { width: 1280px; height: 720px; padding: 40px; }</style></head>',
    '<body><main class="slide"><p style="font-size: 14px">前文</p>',
    '<img src="' + src + '" width="200" height="100"></main></body></html>'
  ].join('\n');
  const convert = async (name, src) => {
    const file = path.join(folder, name + '.html');
    fs.writeFileSync(file, page(src));
    return pipeline.convertFile(file, { pptx: path.join(folder, name + '.pptx') });
  };
  const kindsOf = (result) => (result.deck.slides[0].elements || []).map((element) => element.type);
  const reportsOf = (result) => result.report.unsupportedDetails.filter((entry) => entry.property === 'src');

  const real = await convert('real', 'real.png');
  assert.ok(kindsOf(real).includes('image'), 'a file that is there is drawn');
  assert.deepEqual(reportsOf(real), [], 'and nothing is said about it');

  const missing = await convert('missing', 'nope.png');
  assert.deepEqual(kindsOf(missing), ['text'], 'a file that is not there draws nothing');
  assert.equal(reportsOf(missing).length, 1, 'and is named once');
  assert.match(reportsOf(missing)[0].reason, /could not be read/u);

  const remote = await convert('remote', 'https://example.com/a.png');
  assert.deepEqual(kindsOf(remote), ['text'], 'a remote picture is not downloaded');
  assert.match(reportsOf(remote)[0].reason, /never touches the network/u);

  // The string API has no base directory, so the path travels unresolved: the writer decides, and
  // says so. That is better than guessing - the caller's working directory might have the file.
  const anonymous = pipeline.convertHtml(page('assets/photo.png'));
  assert.ok(kindsOf(anonymous).includes('image'), 'the picture travels');
  assert.deepEqual(reportsOf(anonymous), [], 'and nothing is claimed before the write');
  const { generatePptx } = require('../native/engine/native_pptx');
  const JSZip = require(require.resolve('jszip', { paths: [require.resolve('../native/engine/native_pptx')] }));
  const file = path.join(os.tmpdir(), 'native-src-' + process.pid + '.pptx');
  const anonymousWrite = await generatePptx(anonymous.deck, file);
  assert.equal(anonymousWrite.droppedPictures.length, 1, 'the writer names it at write time');
  assert.match(anonymousWrite.droppedPictures[0].reason, /could not be read/u);

  // And the package really has no phantom picture in it.
  await generatePptx(missing.deck, file);
  const zip = await JSZip.loadAsync(fs.readFileSync(file));
  const xml = await zip.file('ppt/slides/slide1.xml').async('string');
  fs.unlinkSync(file);
  assert.equal((xml.match(/<p:pic>/gu) || []).length, 0, 'no picture element for a picture with no bytes');
});

test('every way of having no bytes for a picture is named', async () => {
  // Probing the image edge cases found four more: an empty src, a missing src attribute, a data
  // URI that is not base64 or not an image, and a background layer with an unreadable source. The
  // first three were silent holes; the last two aborted the whole conversion while the package
  // was being assembled, with a message about pixel sizes. Each is one line in the report now,
  // and the geometry degrades rather than throwing.
  const svg = 'data:image/svg+xml;base64,PHN2ZyB4bWxucz0iaHR0cDovL3d3dy53My5vcmcvMjAwMC9zdmciIHdpZHRoPSIxMDAiIGhlaWdodD0iNTAiPjxyZWN0IHdpZHRoPSIxMDAiIGhlaWdodD0iNTAiIGZpbGw9IiNGMkEyNEMiLz48L3N2Zz4=';
  const page = (body) => pipeline.convertHtml([
    '<html><head><style>.slide { width: 1280px; height: 720px; padding: 40px; }</style></head>',
    '<body><main class="slide">' + body + '</main></body></html>'
  ].join('\n'));
  const kindsOf = (result) => (result.deck.slides[0].elements || []).map((element) => element.type);
  const sourcesOf = (result) => result.report.unsupportedDetails
    .filter((entry) => entry.property === 'src' || entry.property === 'backgroundImage');

  [['an empty source', '<img src="" width="200" height="100">', 'src'],
    ['no source attribute', '<img width="200" height="100">', 'src'],
    ['a payload that is not base64', '<img src="data:image/png;base64,not-actually-png" width="200" height="100">', 'src'],
    ['a data URI that is not an image', '<img src="data:text/plain;base64,aGVsbG8gd29ybGQ=" width="200" height="100">', 'src'],
    ['a remote background', '<div style="width: 300px; height: 200px; background: #2F5D50 url(https://e.example/bg.jpg)"></div>', 'backgroundImage'],
    ['a background on text', '<p style="background-image: url(https://e.example/x.jpg); width: 300px; height: 60px; font-size: 14px">文字</p>', 'backgroundImage']
  ].forEach(([label, body, property]) => {
    const result = page(body);
    assert.ok(!kindsOf(result).includes('image'), label + ' draws no picture');
    const reported = sourcesOf(result).filter((entry) => entry.property === property);
    assert.equal(reported.length, 1, label + ' is named once');
    assert.ok(String(reported[0].reason).length > 20, label + ' explains itself: ' + reported[0].reason);
  });

  // A data URI that decodes is still drawn.
  assert.ok(kindsOf(page('<img src="' + svg + '" width="200" height="100">')).includes('image'),
    'a decodable data URI is a picture');

  // And none of it throws on the way to a package.
  const fs = require('node:fs');
  const os = require('node:os');
  const path = require('node:path');
  const { generatePptx } = require('../native/engine/native_pptx');
  const fragile = page('<div style="width: 300px; height: 200px; background-image: url(nope.jpg)"></div>');
  const file = path.join(os.tmpdir(), 'native-nobytes-' + process.pid + '.pptx');
  const written = await generatePptx(fragile.deck, file);
  fs.unlinkSync(file);
  assert.ok(Array.isArray(written.droppedPictures), 'the writer reports what it could not read');
});

test('a line box that is not positive is dropped the way CSS drops it', () => {
  // `line-height: -1` is not a valid declaration, so a browser discards it and keeps `normal`.
  // This converter took the number literally: the line box came out negative and the text
  // disappeared from the deck without a word - a silent loss of the only content on the slide.
  const page = (value) => pipeline.convertHtml([
    '<html><head><style>.slide { width: 1280px; height: 720px; padding: 40px; }',
    '  .a { font-size: 14px; line-height: ' + value + '; }',
    '</style></head><body><main class="slide"><p class="a">负行高也要出现</p></main></body></html>'
  ].join('\n'));
  const textOf = (result) => (result.deck.slides[0].elements || []).find((element) => element.type === 'text');
  [-1, 0, '-3px', '-50%'].forEach((value) => {
    const element = textOf(page(value));
    assert.ok(element, 'line-height: ' + value + ' still draws the text');
    assert.ok(element.h > 0, 'and the box has a height');
  });
  // A valid line box is still honoured, and a taller one takes more room than `normal`.
  const loose = textOf(page('2.4'));
  const normal = textOf(page('normal'));
  assert.ok(loose.h > normal.h, 'a line-height of 2.4 is taller than normal');
});

test('a chart value with no number in it is named, not plotted as zero in silence', () => {
  // A typo in a data cell used to become a real data point worth 0: the chart looked
  // authoritative and said something the page never said. Scatter and bubble already refused
  // a text axis; every chart can now say when a value cell holds no number.
  const chartOf = (rows) => pipeline.convertHtml([
    '<html><head><style>.slide { width: 1280px; height: 720px; padding: 40px; }',
    '  .t { width: 420px; }</style></head><body><main class="slide">',
    '<table class="t" data-chart="bar"><tr><th>季度</th><th>收入</th></tr>' + rows + '</table>',
    '</main></body></html>'
  ].join('\n'));
  const reportsOf = (result) => result.report.unsupportedDetails.filter((entry) => entry.property === 'data-chart');

  const typo = chartOf('<tr><td>Q1</td><td>abc</td></tr><tr><td>Q2</td><td>30</td></tr>');
  assert.equal(reportsOf(typo).length, 1, 'the text cell is named once');
  assert.match(reportsOf(typo)[0].reason, /plotted as 0/u);
  assert.equal(reportsOf(typo)[0].value, 'abc', 'and the value is quoted back');

  const blank = chartOf('<tr><td>Q1</td><td></td></tr><tr><td>Q2</td><td>30</td></tr>');
  assert.equal(reportsOf(blank).length, 1);
  assert.match(reportsOf(blank)[0].reason, /empty value cell/u);

  // Numbers written the way pages write them are numbers: a thousands separator, a sign, a
  // decimal. Reporting those would be noise.
  ['1,200', '-8', '0.5'].forEach((value) => {
    const clean = chartOf('<tr><td>Q1</td><td>' + value + '</td></tr><tr><td>Q2</td><td>30</td></tr>');
    assert.deepEqual(reportsOf(clean), [], value + ' is a number');
  });
});

test('a picture with no alt text carries no alt text', async () => {
  // The writer fills `descr` with the image source when no alt is given, which put a build
  // machine's path into the alt text a screen reader reads out. A picture with no description
  // has no description; the check that keeps it that way lives in the integrity audit.
  const png = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAIAAACQd1PeAAAADElEQVR4nGOQtTYDAAEHAI9Yd1qPAAAAAElFTkSuQmCC';
  const html = [
    '<html><head><style>.slide { width: 1280px; height: 720px; padding: 40px; }</style></head><body>',
    '<main class="slide">',
    '  <img src="data:image/png;base64,' + png + '" width="120" height="80">',
    '  <img src="data:image/png;base64,' + png + '" alt="一张流程图" width="120" height="80">',
    '</main></body></html>'
  ].join('\n');
  const result = pipeline.convertHtml(html);
  const fs = require('node:fs');
  const os = require('node:os');
  const path = require('node:path');
  const JSZip = require(require.resolve('jszip', { paths: [require.resolve('../native/engine/native_pptx')] }));
  const engine = require('../native/engine/native_pptx');
  const file = path.join(os.tmpdir(), 'native-alt-' + process.pid + '.pptx');
  await engine.generatePptx(result.deck, file);
  const zip = await JSZip.loadAsync(fs.readFileSync(file));
  const xml = await zip.file('ppt/slides/slide1.xml').async('string');
  fs.unlinkSync(file);
  const descriptions = [...xml.matchAll(/descr="([^"]*)"/gu)].map((match) => match[1]);
  assert.deepEqual(descriptions, ['', '一张流程图'], 'the invented alt text is gone, the author`s is kept');
  assert.ok(!xml.includes('preencoded.png'), 'and no source name reaches the package');

  assert.equal(engine.looksLikeSourcePath('preencoded.png'), true);
  assert.equal(engine.looksLikeSourcePath('F:\\work\\photo.png'), true);
  assert.equal(engine.looksLikeSourcePath('assets/flow.png'), true);
  assert.equal(engine.looksLikeSourcePath('一张流程图'), false);
});

test('a decoration style keeps the vocabulary the schema uses', async () => {
  // CSS says `double` and `dashed`; the schema says `dbl` and `dash`. Passing the CSS word
  // through wrote u="double", which no reader on this machine complained about - so the
  // vocabulary is pinned here and checked against the schema's value set by the audit.
  const cases = [['underline', 'sng'], ['underline wavy', 'wavy'], ['underline double', 'dbl'],
    ['underline dotted', 'dotted'], ['underline dashed', 'dash']];
  const body = cases.map(([value]) => '<p style="font-size:16px; text-decoration: ' + value + '">' + value + '</p>').join('');
  const html = ['<html><head><style>.slide { width: 1280px; height: 720px; padding: 40px; }</style>',
    '</head><body><main class="slide">' + body + '</main></body></html>'].join('\n');
  const result = pipeline.convertHtml(html);
  // The decoration is a run property: a plain underline is the boolean, a styled one carries
  // the schema's word for the style.
  const styles = result.deck.slides[0].elements.map((element) => {
    const runs = Array.isArray(element.text) ? element.text : [];
    const underline = runs.length ? runs[0].options.underline : undefined;
    return underline === true ? 'sng' : (underline && underline.style);
  });
  assert.deepEqual(styles, cases.map(([, style]) => style));

  const { underlineStyleOf } = require('../native/pipeline/analyzer');
  assert.equal(underlineStyleOf('double'), 'dbl');
  assert.equal(underlineStyleOf('dashed'), 'dash');
  assert.equal(underlineStyleOf('solid'), 'sng');
  assert.equal(underlineStyleOf(''), 'sng');
});

test('the slide title is a title placeholder, not a text box'
  , async () => {
  // A heading written as a plain text box renders exactly right and is invisible to PowerPoint's
  // outline view, to accessibility names, to `Reset slide` and to any tool reading
  // `slide.shapes.title`. One `<p:ph type="title"/>` makes it the title, and changes no pixel.
  const html = [
    '<html><head><style>',
    '  .slide { width: 1280px; height: 720px; padding: 60px; }',
    '  h1 { font-size: 30px; } p { font-size: 14px; }',
    '  .mark { position: absolute; right: 20px; top: 200px; font-size: 96px; transform: rotate(-9deg); }',
    '</style></head><body><main class="slide">',
    '  <div class="mark">NATIVE</div><h1>真正的标题</h1><p>正文</p>',
    '</main></body></html>'
  ].join('\n');
  const result = pipeline.convertHtml(html);
  const elements = result.deck.slides[0].elements;
  const titled = elements.filter((element) => element.placeholderType === 'title');
  assert.equal(titled.length, 1, 'one title per slide');
  assert.equal(titled[0].text, '真正的标题', 'the h1 outranks the 96px rotated watermark');
  assert.equal(elements.filter((element) => element.role === 'title').length, 1, 'and only one element claims the role');

  const fs = require('node:fs');
  const os = require('node:os');
  const path = require('node:path');
  const JSZip = require(require.resolve('jszip', { paths: [require.resolve('../native/engine/native_pptx')] }));
  const { generatePptx } = require('../native/engine/native_pptx');
  const file = path.join(os.tmpdir(), 'native-title-' + process.pid + '.pptx');
  await generatePptx(result.deck, file);
  const zip = await JSZip.loadAsync(fs.readFileSync(file));
  const xml = await zip.file('ppt/slides/slide1.xml').async('string');
  fs.unlinkSync(file);
  assert.equal((xml.match(/<p:ph type="title"\/>/gu) || []).length, 1, 'the package declares one title');
  assert.ok(/<p:cNvPr id="\d+" name="Title"/u.test(xml), 'and the shape is named Title for the selection pane');
  // The point of the change: nothing about the box or the runs moves.
  const title = elements.find((element) => element.placeholderType === 'title');
  assert.ok(title.w > 0 && title.h > 0 && title.fontSize > 0);
});

test('a form control keeps the words the browser shows', () => {
  // A filled input shows its value - the placeholder only stands in while it is empty. Reading
  // the placeholder alone left a mock-up with `<input value="name@example.com">` empty where
  // the browser shows the address, and an <iframe> inside a paragraph vanished without a word.
  const build = (body) => pipeline.convertHtml([
    '<html><head><style>.slide { width: 1280px; height: 720px; padding: 40px; }</style>',
    '</head><body><main class="slide">' + body + '</main></body></html>'
  ].join('\n'));
  const textsOf = (result) => (result.deck.slides[0].elements || [])
    .map((element) => element.text)
    .filter((value) => typeof value === 'string' && value.length);
  const namesOf = (result) => result.report.unsupportedDetails.map((entry) => entry.property + '=' + entry.value);

  const filled = build('<p><input value="name@example.com"></p>');
  assert.deepEqual(textsOf(filled), ['name@example.com'], 'the value is what shows');
  assert.deepEqual(namesOf(filled), ['element=input'], 'and the control box is named');

  const both = build('<p><input value="显示值" placeholder="占位"></p>');
  assert.deepEqual(textsOf(both), ['显示值'], 'a filled input does not show its placeholder');

  const empty = build('<p><input placeholder="请输入"></p>');
  assert.deepEqual(textsOf(empty), ['请输入'], 'an empty input shows the placeholder');

  const checkbox = build('<p><input type="checkbox"> 同意条款</p>');
  assert.deepEqual(textsOf(checkbox), ['\u2610 同意条款'], 'a checkbox draws its state glyph');

  const select = build('<p><select><option>甲</option><option selected="selected">乙</option><option>丙</option></select></p>');
  assert.deepEqual(textsOf(select), ['乙'], 'a closed select shows the chosen option only');

  const embedded = build('<p>前 <iframe src="about:blank" width="100" height="50"></iframe> 后</p>');
  assert.deepEqual(namesOf(embedded), ['element=iframe'], 'an inline document cannot be walked into silence');

  const block = build('<textarea>多行文本</textarea>');
  assert.deepEqual(textsOf(block), ['多行文本'], 'a textarea keeps its text');
  assert.deepEqual(namesOf(block), ['element=textarea'], 'and its box is named');
});

test('the example decks lose nothing that the baseline does not already name', async () => {
  // The fixtures are the designs this engine claims to translate whole. Every declaration it
  // cannot translate is already listed in baselines/reports.json with the reason; a new name
  // means a design that used to come through now loses something, which is the one regression
  // the geometry and look gates cannot see.
  const { collectEntries, readBaseline } = require('../native/scripts/audit_report_baseline');
  const baseline = readBaseline();
  assert.ok(baseline && baseline.length, 'the baseline exists');
  const known = new Set(baseline.map((entry) => entry.deck + '|' + entry.property + '|' + entry.reason));
  const entries = await collectEntries();
  const added = entries.filter((entry) => !known.has(entry.deck + '|' + entry.property + '|' + entry.reason));
  assert.deepEqual(added.map((entry) => entry.deck + ': ' + entry.property), [],
    'a newly named declaration has to be understood, then blessed with --update');
});

test('embedding a face carries the font inside the package', async () => {
  // A deck that names a font nobody installed renders in the reader's substitute. Opting in
  // puts the font's own bytes in the package (p:embeddedFontLst + ppt/fonts/*.fntdata), which
  // is the only way a measurement survives the trip to another machine.
  const { fontFileForFamily } = require('../native/engine/font_manager');
  const html = [
    '<html><head><style>',
    '  .slide { width: 1280px; height: 720px; padding: 60px; font-family: Arial, sans-serif; }',
    '  h1 { font-size: 30px; }',
    '</style></head><body><main class="slide"><h1>Arial headline</h1></main></body></html>'
  ].join('\n');
  const result = pipeline.convertHtml(html);
  const os = require('node:os');
  const path = require('node:path');
  const fs = require('node:fs');
  const JSZip = require(require.resolve('jszip', { paths: [require.resolve('../native/engine/native_pptx')] }));
  const { generatePptx } = require('../native/engine/native_pptx');
  const plainFile = path.join(os.tmpdir(), 'native-fonts-plain-' + process.pid + '.pptx');
  const embeddedFile = path.join(os.tmpdir(), 'native-fonts-on-' + process.pid + '.pptx');
  await generatePptx(result.deck, plainFile);
  const written = await generatePptx(result.deck, embeddedFile, { embedFonts: true });
  const plain = await JSZip.loadAsync(fs.readFileSync(plainFile));
  const patched = await JSZip.loadAsync(fs.readFileSync(embeddedFile));
  const plainParts = Object.keys(plain.files).filter((name) => /^ppt\/fonts\/[^/]+\.fntdata$/u.test(name));
  assert.deepEqual(plainParts, [], 'nothing travels unless the caller asks');
  if (!fontFileForFamily('Arial')) {
    assert.deepEqual(written.embeddedFonts, []);
    assert.ok(written.skippedFonts.some((entry) => entry.face === 'Arial'), 'a missing face is named');
    fs.unlinkSync(plainFile);
    fs.unlinkSync(embeddedFile);
    return;
  }
  const parts = Object.keys(patched.files).filter((name) => /^ppt\/fonts\/[^/]+\.fntdata$/u.test(name));
  assert.equal(parts.length, 1, 'one part per file: ' + JSON.stringify(parts));
  const fontBytes = await patched.file(parts[0]).async('nodebuffer');
  assert.ok(fontBytes.length > 1000, 'the font itself is inside: ' + fontBytes.length + ' bytes');
  const presentation = await patched.file('ppt/presentation.xml').async('string');
  assert.ok(presentation.includes('<p:embeddedFontLst>'), 'the list is declared');
  assert.ok(/<p:font typeface="Arial"\/><p:regular r:id="rId\d+"\/>/u.test(presentation), presentation.slice(0, 400));
  assert.ok(/embedTrueTypeFonts="1"/u.test(presentation), 'the presentation says it carries fonts');
  const rels = await patched.file('ppt/_rels/presentation.xml.rels').async('string');
  assert.ok(/Type="[^"]*\/font"[^>]*Target="fonts\/font1\.fntdata"/u.test(rels), rels.slice(-260));
  // A part with no content type is a package a reader offers to repair; the audit gate found
  // exactly that when the embedding was first written.
  const types = await patched.file('[Content_Types].xml').async('string');
  assert.ok(/<Default Extension="fntdata" ContentType="application\/x-fontdata"\/>/u.test(types), types.slice(-200));
  assert.deepEqual(written.embeddedFonts.map((entry) => entry.face), ['Arial']);
  fs.unlinkSync(plainFile);
  fs.unlinkSync(embeddedFile);
});

test('a word wider than its box is named, not silently broken', () => {
  // CSS `overflow-wrap: normal` lets a long word stick out of its box; a reader breaks it
  // instead, and the box has to be measured with that break or the next block would sit a line
  // too high. So the break is kept and the difference is named - once, and only where it bites.
  const build = (css, body) => pipeline.convertHtml([
    '<html><head><style>.slide { width: 1280px; height: 720px; padding: 40px; } ' + css + '</style>',
    '</head><body><main class="slide">' + body + '</main></body></html>'
  ].join('\n'));
  const reports = (result) => result.report.unsupportedDetails
    .filter((entry) => entry.property === 'overflowWrap')
    .map((entry) => entry.value);
  const word = 'Supercalifragilisticexpialidocious';
  assert.deepEqual(reports(build('.w { width: 120px; font-size: 14px; }', '<p class="w">' + word + '</p>')),
    ['normal'], 'the default has to be named where it bites');
  assert.deepEqual(reports(build('.w { width: 120px; font-size: 14px; overflow-wrap: break-word; }',
    '<p class="w">' + word + '</p>')), [], 'break-word asks for exactly this break');
  assert.deepEqual(reports(build('.w { width: 600px; font-size: 14px; }', '<p class="w">ordinary words</p>')),
    [], 'a box whose words fit says nothing');
  assert.deepEqual(reports(build('.w { width: 60px; font-size: 14px; }', '<p class="w">中文按字符换行</p>')),
    [], 'CJK breaks between characters anyway');
});

test('a border band follows the rounded corner it sits on', async () => {
  // Chrome, on a 300x200 card with a 40px radius and a 12px left border: the band is a
  // rectangle only along the straight part of the edge; over each corner it tapers, reaching
  // full width 40px down and vanishing 11.4px down (40 - sqrt(2*40*12 - 12*12)).
  const html = [
    '<html><head><style>',
    '  .slide { width: 1280px; height: 720px; background: #FBFAF7; }',
    '  .card { position: absolute; left: 40px; top: 40px; width: 300px; height: 200px;',
    '    background: #FFFFFF; border-radius: 40px; border-left: 12px solid #2F5D50; }',
    '</style></head><body><main class="slide"><div class="card"></div></main></body></html>'
  ].join('\n');
  const card = pipeline.convertHtml(html).deck.slides[0].elements[0];
  assert.ok(card.edge && card.edge.path, 'a rounded box carries an outline for its band');
  const points = card.edge.path.points;
  assert.ok(points.length >= 10, 'an arc needs samples: ' + points.length);
  assert.ok(Math.abs(card.edge.path.width - 12) < 0.5, 'band space width: ' + card.edge.path.width);
  assert.ok(Math.abs(card.edge.path.height - 200) < 0.5, 'band space height: ' + card.edge.path.height);
  const lowest = Math.min(...points.map((point) => point[1]));
  const expected = 40 - Math.sqrt(2 * 40 * 12 - 12 * 12);
  assert.ok(Math.abs(lowest - expected) < 1, 'the taper starts at ' + lowest.toFixed(1) + ', not ' + expected.toFixed(1));
  // Every point is inside the band's own width, and the outer edge reaches zero in the middle.
  assert.ok(points.every((point) => point[0] >= -0.01 && point[0] <= 12.01), 'inside the band');
  assert.ok(points.some((point) => Math.abs(point[0]) < 0.01), 'the outer edge is the box edge');

  const fs = require('node:fs');
  const os = require('node:os');
  const path = require('node:path');
  const JSZip = require(require.resolve('jszip', { paths: [require.resolve('../native/engine/native_pptx')] }));
  const { generatePptx } = require('../native/engine/native_pptx');
  const result = pipeline.convertHtml(html);
  const file = path.join(os.tmpdir(), 'native-arc-' + process.pid + '.pptx');
  await generatePptx(result.deck, file);
  const zip = await JSZip.loadAsync(fs.readFileSync(file));
  const xml = await zip.file('ppt/slides/slide1.xml').async('string');
  fs.unlinkSync(file);
  assert.ok(xml.includes('<a:custGeom>'), 'the strip is a custom geometry, not a rectangle');
  assert.ok((xml.match(/<a:lnTo>/gu) || []).length >= 10, 'the arc is traced');
});

test('a single-side border reaches the slide as a strip, scaled or not', async () => {
  // `border-left` is not a shape edge in DrawingML: it is a thin filled rectangle on the box's
  // own edge. It travelled as far as the spec and stopped - a container's accent bar was never
  // drawn, and a group that fell back to absolute placement lost it too.
  const fs = require('node:fs');
  const os = require('node:os');
  const path = require('node:path');
  const JSZip = require(require.resolve('jszip', { paths: [require.resolve('../native/engine/native_pptx')] }));
  const { generatePptx } = require('../native/engine/native_pptx');
  const html = [
    '<html><head><style>',
    '  .slide { width: 1280px; height: 720px; padding: 40px; background: #FBFAF7; }',
    '  .card { width: 400px; padding: 20px; background: #FFFFFF; border-left: 4px solid #2F5D50; }',
    '  .card h3 { font-size: 16px; margin: 0; }',
    '  .loud { width: 400px; padding: 20px; background: #FFFFFF; border-left: 4px solid #C2703F;',
    '    transform: scale(1.2); }',
    '</style></head><body><main class="slide">',
    '  <div class="card"><h3>对齐的一条</h3></div>',
    '  <div class="loud"><h3>放大的一条</h3></div>',
    '</main></body></html>'
  ].join('\n');
  const result = pipeline.convertHtml(html);
  const surface = result.deck.slides[0].elements.find((element) => element.fill === 'FFFFFF');
  assert.ok(surface && surface.edge, 'the box that fell back still carries its edge');
  const file = path.join(os.tmpdir(), 'native-edge-' + process.pid + '.pptx');
  await generatePptx(result.deck, file);
  const zip = await JSZip.loadAsync(fs.readFileSync(file));
  const xml = await zip.file('ppt/slides/slide1.xml').async('string');
  fs.unlinkSync(file);
  const strips = (colour) => (xml.match(new RegExp('<a:srgbClr val="' + colour + '"', 'gu')) || []).length;
  assert.equal(strips('2F5D50'), 1, 'the container accent is drawn');
  assert.equal(strips('C2703F'), 1, 'and so is the scaled group accent');
  // 4px of CSS is 3pt of DrawingML: 3 * 12700 = 38100 EMU across.
  const widths = [...xml.matchAll(/<a:ext cx="(\d+)" cy="(\d+)"/gu)]
    .map((match) => Number(match[1]))
    .filter((value) => value > 20000 && value < 60000);
  assert.ok(widths.length >= 2, 'two strips, each about 4px across: ' + JSON.stringify(widths));
  assert.ok(widths.every((value) => Math.abs(value - 38100) < 2000), 'strip width: ' + JSON.stringify(widths));
});

test('a uniform scale grows the box and everything drawn inside it', () => {
  // Chrome, measured on this markup, slide-relative: the 200x100 box scaled 1.5 about its
  // centre sits at 10,35 and is 300x150; the 300x80 box scaled 0.5 sits at 135,220 and is
  // 150x40 (its layout box, 200..280, is untouched, so the box after it stays at 280).
  const html = [
    '<html><head><style>',
    '  .slide { width: 1280px; height: 720px; padding: 60px; }',
    '  .pop { width: 200px; height: 100px; background: #2F5D50; transform: scale(1.5); }',
    '  .shrink { width: 300px; height: 80px; background: #C2703F; transform: scale(0.5); margin-top: 40px; }',
    '  .after { width: 100px; height: 40px; background: #F2A24C; }',
    '</style></head><body><main class="slide">',
    '  <div class="pop"></div><div class="shrink"></div><div class="after"></div>',
    '</main></body></html>'
  ].join('\n');
  const elements = pipeline.convertHtml(html).deck.slides[0].elements;
  const box = (fill) => elements.find((element) => element.fill === fill);
  const near = (actual, expected) => Math.abs(actual * 96 - expected) < 0.5;
  const pop = box('2F5D50');
  assert.deepEqual([pop.x, pop.y, pop.w, pop.h].map((value) => Math.round(value * 96)), [10, 35, 300, 150]);
  const shrink = box('C2703F');
  assert.deepEqual([shrink.x, shrink.y, shrink.w, shrink.h].map((value) => Math.round(value * 96)), [135, 220, 150, 40]);
  const after = box('F2A24C');
  assert.ok(near(after.y, 280), 'layout ignores the transform: after y=' + (after.y * 96).toFixed(1));
  assert.ok(near(after.w, 100), 'the following box is not scaled');
});
test('a scaled text box carries its type and its padding with it', () => {
  // 20px type inside 12px padding, scaled 1.2: 24px type and 14.4px padding. Chrome draws the
  // glyphs 1.2x larger inside a box 1.2x larger, which is what a bigger font in a bigger box is.
  const html = [
    '<html><head><style>',
    '  .slide { width: 1280px; height: 720px; padding: 60px; }',
    '  .bubble { width: 300px; height: 90px; background: #17332F; color: #FFFFFF;',
    '    font-size: 20px; padding: 12px; transform: scale(1.2); }',
    '</style></head><body><main class="slide"><div class="bubble">放大的标注</div></main></body></html>'
  ].join('\n');
  const container = pipeline.convertHtml(html).deck.slides[0].elements[0];
  assert.equal(container.type, 'container');
  assert.ok(Math.abs(container.padding.top * 96 - 14.4) < 0.2, 'padding=' + (container.padding.top * 96).toFixed(2));
  assert.ok(Math.abs(container.w * 96 - 360) < 0.5, 'w=' + (container.w * 96).toFixed(1));
  const words = container.children[0];
  assert.equal(words.fontSize, 18, '20px type at 1.2 is 18pt');
});

test('a transform: translate() is a shift, and it composes with rotate', () => {
  const build = (css) => {
    const result = pipeline.convertHtml([
      '<html><head><style>',
      '  .slide { width: 1280px; height: 720px; padding: 40px; position: relative; }',
      '  ' + css,
      '</style></head><body><main class="slide"><div class="box"></div></main></body></html>'
    ].join('\n'));
    return { element: result.deck.slides[0].elements[0] || {}, reported: result.report.unsupportedDetails.map((item) => item.property) };
  };

  // `translate(-50%, -50%)` centres a 200x80 box on the 640,300 anchor.
  const centred = build('.box { position: absolute; left: 640px; top: 300px; width: 200px; height: 80px;'
    + ' background: #17332F; transform: translate(-50%, -50%); }');
  assert.equal(centred.element.x, 5.625);
  assert.equal(centred.element.y, 2.7083);
  assert.deepEqual(centred.reported, [], 'a translation is exact, so nothing is named');

  // A rotation composes: a translate written after it is turned with it.
  const turned = build('.box { width: 200px; height: 80px; background: #ccc;'
    + ' transform: rotate(90deg) translate(96px, 0); }');
  assert.equal(turned.element.rotate, 90);
  assert.equal(turned.element.x, 0.4167, 'the horizontal anchor does not move');
  assert.equal(turned.element.y, 1.4167, 'the 96px offset becomes vertical');

  // A uniform scale is native: the box is twice as big and centred where it was.
  const scaled = build('.box { width: 100px; height: 50px; background: #ccc; transform: scale(2); }');
  assert.deepEqual(scaled.reported, [], 'a uniform scale needs no apology');
  assert.ok(Math.abs(scaled.element.w * 96 - 200) < 0.5, 'w=' + (scaled.element.w * 96).toFixed(1));
  assert.ok(Math.abs(scaled.element.h * 96 - 100) < 0.5, 'h=' + (scaled.element.h * 96).toFixed(1));
  // scale(50%, 150%) stretches the glyphs, which no native shape can do: named, not half-applied.
  const stretched = build('.box { width: 100px; height: 50px; background: #ccc; transform: scale(50%, 150%); }');
  assert.deepEqual(stretched.reported, ['transform']);
  assert.ok(Math.abs(stretched.element.w * 96 - 100) < 0.5, 'the box keeps its declared size');
});

test('a positioned child paints above the in-flow boxes it sits on', () => {
  const result = pipeline.convertHtml([
    '<html><head><style>',
    '  .slide { width: 1280px; height: 720px; padding: 40px; }',
    '  .media { display: flex; width: 800px; }',
    '  .stage { width: 520px; height: 292px; background: #17332F; }',
    '  .pin { position: absolute; left: 260px; top: 0; width: 132px; height: 34px;',
    '    background: #C05B3E; border-radius: 17px; color: #fff; font-size: 11px;',
    '    transform: translate(-50%, -50%); }',
    '</style></head><body><main class="slide">',
    '<div class="media"><div class="pin">16 : 9</div><div class="stage"></div></div>',
    '</main></body></html>'
  ].join('\n'));
  const elements = result.deck.slides[0].elements;
  const flat = elements.flatMap((element) => [element, ...(element.children || [])]);
  const pin = flat.find((element) => element.text === '16 : 9' || (Array.isArray(element.text)
    && element.text.some((run) => run.text === '16 : 9')));
  const stage = flat.find((element) => element.fill === '17332F');
  assert.ok(pin, 'the pin keeps its own words');
  // The pin comes first in the DOM, so a document-order sort would paint it under the picture.
  assert.ok(flat.indexOf(pin) > flat.indexOf(stage), 'the positioned pin paints after the picture');
  // A child that paints its own surface must keep it: an overlay would carry text only, and
  // the pin would arrive as bare words.
  const painted = flat.find((element) => (element.background && element.background.fill === 'C05B3E')
    || element.fill === 'C05B3E');
  assert.ok(painted, 'the pill keeps its own fill');
  const surface = painted.background || painted;
  assert.equal(surface.radius, 0.177, 'and its rounded corners');
});


test('line-height: normal comes from the metrics of the first face that exists', () => {
  const metrics = require('../native/engine/font_manager.js');
  const fontkit = (() => { try { return require('fontkit'); } catch (_) { return null; } })();
  const result = pipeline.convertHtml([
    '<html><head><style>',
    '  .slide { width: 1280px; height: 720px; padding: 40px; }',
    '  .local { font-family: "Microsoft YaHei"; font-size: 100px; line-height: normal; width: 500px; }',
    '  .stacked { font-family: "Mystery Face", "Microsoft YaHei"; font-size: 100px; line-height: normal; width: 500px; }',
    '  .missing { font-family: "Mystery Face", "Also Missing"; font-size: 100px; line-height: normal; width: 500px; }',
    '  .explicit { font-family: "Microsoft YaHei"; font-size: 100px; line-height: 1.2; width: 500px; }',
    '</style></head><body><main class="slide">',
    '<div class="local">汉字</div><div class="stacked">汉字</div>',
    '<div class="missing">汉字</div><div class="explicit">汉字</div>',
    '</main></body></html>'
  ].join('\n'));
  const elements = result.deck.slides[0].elements;
  const heightOf = (selector) => {
    const index = ['local', 'stacked', 'missing', 'explicit'].indexOf(selector);
    return +(elements[index].h * 96).toFixed(1);
  };
  const normal = metrics.normalLineHeight('Microsoft YaHei', fontkit);
  if (normal !== null) {
    // The face exists here, so its real metrics replace the 1.25 estimate.
    assert.equal(heightOf('local'), +(normal * 100).toFixed(1));
    // A stack whose first face is missing falls through to the one that exists.
    assert.equal(heightOf('stacked'), heightOf('local'), 'the walk follows the CSS stack');
  }
  // No face in the stack exists: the 1.25 estimate stays, because the reader's generic
  // fallback measured *taller* than any static guess we could make.
  assert.equal(heightOf('missing'), 125);
  // An explicit line-height is untouched by any of this.
  assert.equal(heightOf('explicit'), 120);
});


test('visibility: hidden keeps the box in the layout but paints nothing', () => {
  const build = (inner) => pipeline.convertHtml([
    '<html><head><style>',
    '  .slide { width: 1280px; height: 720px; padding: 40px; }',
    '  .ghost { width: 200px; height: 100px; background: #C05B3E; visibility: hidden; }',
    '  .after { width: 200px; height: 50px; background: #17332F; }',
    '  .row { display: flex; gap: 20px; width: 900px; }',
    '  .cell { flex: 1; height: 60px; background: #17332F; }',
    '</style></head><body><main class="slide">', inner, '</main></body></html>'
  ].join('\n'));

  // Block flow: the ghost occupies its band, so the sibling below cannot move up.
  const flow = build('<div class="ghost"></div><div class="after"></div>');
  const flowShapes = flow.deck.slides[0].elements.filter((element) => element.type === 'shape');
  assert.equal(flowShapes.length, 1, 'the ghost emits no object');
  assert.equal(+(flowShapes[0].y * 96).toFixed(1), 140, 'and the sibling below keeps its place');

  // Flex: the ghost keeps its slot, so the visible cells are thirds, not halves.
  // the ghost cell takes visibility from the inline style only: the .ghost class above
  // also declares a width, and a flex basis would change the arithmetic under test.
  const flex = build('<div class="row"><div class="cell"></div><div class="cell" style="visibility: hidden"></div><div class="cell"></div></div>');
  const cells = flex.deck.slides[0].elements.filter((element) => element.type === 'shape');
  assert.equal(cells.length, 2, 'two visible cells');
  assert.equal(+(cells[0].w * 96).toFixed(1), 286.7, 'each a third of the row, not a half');
  assert.equal(+(cells[1].x * 96).toFixed(1), 653.3, 'the second sits in the third slot');

  // display: none remains the one that collapses the box entirely.
  const gone = build('<div class="ghost" style="display: none"></div><div class="after"></div>');
  const goneShapes = gone.deck.slides[0].elements.filter((element) => element.type === 'shape');
  assert.equal(goneShapes.length, 1);
  assert.equal(+(goneShapes[0].y * 96).toFixed(1), 40, 'display:none moves the sibling up');
});


test('text-decoration is a run property, and the values without one are named', () => {
  const build = (css) => pipeline.convertHtml([
    '<html><head><style>',
    '  .slide { width: 1280px; height: 720px; padding: 40px; }',
    '  ' + css,
    '</style></head><body><main class="slide"><p class="b">hello</p></main></body></html>'
  ].join('\n'));
  const optionsOf = (result) => result.deck.slides[0].elements[0].text[0].options;

  // Underline and line-through are run properties, not unsupported CSS.
  assert.equal(optionsOf(build('.b { text-decoration: underline; }')).underline, true);
  assert.equal(optionsOf(build('.b { text-decoration: line-through; }')).strike, true);

  // `overline` has no native run property, so it is named instead of silently dropped.
  const over = build('.b { text-decoration: overline; }');
  assert.deepEqual(over.report.unsupportedDetails.map((entry) => entry.property), ['textDecoration']);

  // A decoration colour would need an underline fill the writer does not emit.
  const tinted = build('.b { text-decoration: underline; text-decoration-color: #C05B3E; }');
  assert.deepEqual(tinted.report.unsupportedDetails.map((entry) => entry.property), ['textDecorationColor']);
});


test('an inset shadow is written as an inner effect, beside the outer one', async () => {
  const fs = require('node:fs');
  const os = require('node:os');
  const path = require('node:path');
  const JSZip = require(require.resolve('jszip', { paths: [require.resolve('../native/engine/native_pptx')] }));
  const { generatePptx } = require('../native/engine/native_pptx');
  // PptxGenJS has no inner shadow, so the node is patched into the shape's spPr. Checked in
  // the part: 6px of blur is 4.5pt (57150 EMU), a 2px offset is 1.5pt (19050), straight down
  // is 90 degrees (5400000). WPS draws it; LibreOffice ignores <a:innerShdw>, so this page is
  // not part of the two-reader comparison.
  const html = [
    '<html><head><style>',
    '  * { box-sizing: border-box; }',
    '  .slide { width: 1280px; height: 720px; padding: 60px; }',
    '  .card { width: 300px; height: 160px; background: #FFFFFF; padding: 16px; }',
    '  .pressed { box-shadow: inset 0 2px 6px rgba(0,0,0,0.30); }',
    '  .both { box-shadow: inset 0 2px 6px rgba(0,0,0,0.30), 0 6px 14px rgba(0,0,0,0.25); }',
    '</style></head><body><main class="slide">',
    '<div class="card pressed">a</div><div class="card both">b</div>',
    '</main></body></html>'
  ].join('\n');
  const result = pipeline.convertHtml(html);
  assert.deepEqual(result.report.unsupportedDetails, [], 'an inner shadow is not a gap any more');
  const file = path.join(os.tmpdir(), 'inner-shadow-' + process.pid + '.pptx');
  try {
    await generatePptx(result.deck, file);
    const zip = await JSZip.loadAsync(fs.readFileSync(file));
    const xml = await zip.file('ppt/slides/slide1.xml').async('string');
    const inner = [...xml.matchAll(/<a:innerShdw blurRad="(\d+)" dist="(\d+)" dir="(\d+)"/gu)];
    assert.equal(inner.length, 2, 'both cards carry an inner shadow');
    assert.equal(Number(inner[0][1]), 57150, '6px of blur is 4.5pt');
    assert.equal(Number(inner[0][2]), 19050, '2px of offset is 1.5pt, not rounded to 2');
    assert.equal(Number(inner[0][3]), 5400000, 'straight down is 90 degrees');
    const outer = [...xml.matchAll(/<a:outerShdw/gu)];
    assert.equal(outer.length, 1, 'the outer layer of the mixed declaration survives');
    // One effect list per shape: the inner node lives beside the outer one, not in its own
    // effectLst, which would be schema-invalid.
    const lists = [...xml.matchAll(/<a:effectLst>([\s\S]*?)<\/a:effectLst>/gu)].map((match) => match[1]);
    assert.equal(lists.length, 2);
    assert.ok(lists.some((inner1) => inner1.includes('outerShdw') && inner1.includes('innerShdw')),
      'the mixed card keeps both effects in one list');
  } finally {
    fs.rmSync(file, { force: true });
  }
});

test('an unstyled document still reads as a document', () => {
  // With no CSS at all, the browser's own block defaults are what make the page readable:
  // a 32px bold h1, a 24px h2, a list with an indent, a table header that is bold and
  // centred. They are UA declarations, so an author rule still wins.
  const html = [
    '<html><head><style>.slide { width: 1280px; height: 720px; }</style></head><body>',
    '<main class="slide">',
    '<h1>季度回顾</h1><p>正文。</p><h2>要点</h2><ul><li>一条</li><li>两条</li></ul>',
    '<table><thead><tr><th>线</th><th>额</th></tr></thead><tbody><tr><td>甲</td><td>1</td></tr></tbody></table>',
    '</main></body></html>'
  ].join('\n');
  const result = pipeline.convertHtml(html);
  assert.deepEqual(result.errors, []);
  const elements = result.deck.slides[0].elements;
  const heading = elements.find((element) => element.text === '季度回顾');
  assert.equal(heading.fontSize, 24, 'a UA h1 is 32px = 24pt, was ' + heading.fontSize);
  assert.equal(heading.bold, true);
  const second = elements.find((element) => element.text === '要点');
  assert.equal(second.fontSize, 18, 'a UA h2 is 24px = 18pt, was ' + second.fontSize);
  const body = elements.find((element) => typeof element.text === 'string' && element.text.startsWith('正文'));
  assert.equal(body.fontSize, 12, 'body text stays 16px = 12pt');
  const list = elements.find((element) => element.type === 'text' && element.bullet);
  assert.ok(list, 'the list is still a bulleted text box');
  const table = elements.find((element) => element.type === 'table');
  assert.equal(table.rows[0][0].options.bold, true, 'a <th> is bold without any CSS');
  assert.equal(table.rows[0][0].options.align, 'center', 'and centred');
  // An author rule wins over the UA sheet, exactly as in a browser.
  const styled = pipeline.convertHtml(html.replace(".slide { width: 1280px; height: 720px; }",
    '.slide { width: 1280px; height: 720px; } h1 { font-size: 40px; font-weight: 400; }'));
  const styledHeading = styled.deck.slides[0].elements.find((element) => element.text === '季度回顾');
  assert.equal(styledHeading.fontSize, 30, '40px is 30pt when the author says so');
  assert.ok(!styledHeading.bold, 'and the weight is the author\u2019s too');
});

test('an em inset belongs to the element that wrote it, not to its parent', () => {
  // Chrome: an h1 raised to 34px has a 22.78px UA top margin (0.67em of its own size), and the
  // same h1 placed with position:absolute at top: 40px draws at 62.77px. Both were wrong while
  // the em was resolved against a hard-coded 16px: 10.72px of margin instead of 22.78.
  const html = (position) => [
    '<html><head><style>.slide { width: 1280px; height: 720px; padding: 40px; }',
    '  .title { ' + position + ' font-size: 34px; }',
    '</style></head><body><main class="slide"><h1 class="title">标题</h1>',
    '<div class="pad">盒子<br>文字</div></main></body></html>'
  ].join('\n');
  const own = pipeline.convertHtml(html(''));
  const title = own.deck.slides[0].elements.find((element) => element.text === '标题');
  assert.ok(Math.abs(title.y * 96 - (40 + 0.67 * 34)) < 0.6, 'static h1 y=' + (title.y * 96).toFixed(2));
  const absolute = pipeline.convertHtml(html('position: absolute; left: 40px; top: 40px;'));
  const pinned = absolute.deck.slides[0].elements.find((element) => element.text === '标题');
  assert.ok(Math.abs(pinned.y * 96 - (40 + 0.67 * 34)) < 0.6, 'absolute h1 y=' + (pinned.y * 96).toFixed(2));
});
test('em padding is the element\u2019s own font size, not the page\u2019s', () => {
  // A 40px box with `padding: 0.5em` holds its text 20px in on every side. Resolved at the
  // page's 16px it would have been 8px, and the text would sit inside the edge of the fill.
  const html = [
    '<html><head><style>',
    '  .slide { width: 1280px; height: 720px; padding: 40px; }',
    '  .pad { padding: 0.5em; font-size: 40px; background: #EEEEEE; width: 400px; }',
    '</style></head><body><main class="slide"><div class="pad">盒子文字</div></main></body></html>'
  ].join('\n');
  const elements = pipeline.convertHtml(html).deck.slides[0].elements;
  const box = elements.find((element) => element.type === 'container' && element.background);
  assert.ok(box, 'the padded div is a container with a surface');
  assert.equal(box.background.fill, 'EEEEEE');
  // 0.5em of the box's own 40px on every side; the page's 16px would have given 8.
  ['top', 'right', 'bottom', 'left'].forEach((side) => {
    assert.ok(Math.abs(box.padding[side] * 96 - 20) < 0.5,
      side + ' padding: ' + (box.padding[side] * 96).toFixed(2) + 'px');
  });
  const words = (box.children || []).find((child) => typeof child.text === 'string');
  assert.ok(words && words.text.startsWith('盒子'), 'the words live inside the padded box');
});

test('a margin escapes a padding-less parent, and a flex box keeps it inside', () => {
  // Chrome, measured on this markup, slide-relative: the plain card is at 0 and its child at 0
  // (the child's 20px margin escaped through the parent, which has no padding to stop it);
  // the padded card is at 42 and its child at 72 (10px of padding plus the 20px margin);
  // the flex card is at 124 and its child at 144 (a flex container is a formatting context,
  // so the margin stays inside and does not collapse with the parent's).
  const html = [
    '<html><head><style>',
    '  .slide { width: 1280px; height: 720px; }',
    '  .card { width: 300px; margin: 12px 0 0; background: #EEEEEE; }',
    '  .padded { width: 300px; margin: 12px 0 0; padding: 10px; background: #DDDDDD; }',
    '  .flexcard { width: 300px; margin: 12px 0 0; background: #E8E8E8; display: flex; flex-direction: column; }',
    '  .kid { height: 30px; margin: 20px 0 0; background: #CCCCCC; }',
    '</style></head><body><main class="slide">',
    '  <section class="card"><div class="kid"></div></section>',
    '  <section class="padded"><div class="kid"></div></section>',
    '  <section class="flexcard"><div class="kid"></div></section>',
    '</main></body></html>'
  ].join('\n');
  const result = pipeline.convertHtml(html);
  const elements = result.deck.slides[0].elements;
  const tops = elements.map((element) => Math.round(element.y * 96 * 10) / 10);
  // The padded card's child sits inside the container (not a top-level box); the flex card's
  // child does not, because a flex child with margins is a fallback the container model does
  // not carry - reported, and drawn at its own coordinates.
  // The flex card is a column, and a column carries its children's margins as `boxMargin`, so
  // it stays a container: its child is placed by the engine, not emitted beside it.
  assert.deepEqual(tops, [0, 0, 42, 124], 'tops: ' + JSON.stringify(tops));
  assert.equal(elements.length, 4);
  const heights = elements.map((element) => Math.round(element.h * 96 * 10) / 10);
  assert.deepEqual(heights, [30, 30, 70, 50], 'heights: ' + JSON.stringify(heights));
  assert.ok(elements.some((element) => element.type === 'container'), 'the flex column is a container');
});

test('two margins between blocks become one gap, and a negative one keeps its pull', () => {
  // Chrome, measured on this exact markup: tops 40 / 104 / 134. The gap after the first block
  // is max(24px bottom, 16px top) = 24 - not 40 - and the third block is pulled up 10px by its
  // own negative margin, because a zero and a negative add instead of taking the larger.
  const html = [
    '<html><head><style>',
    '  .slide { width: 1280px; height: 720px; padding: 40px; }',
    '  .a { height: 40px; margin: 0 0 24px; background: #EEEEEE; }',
    '  .b { height: 40px; margin: 16px 0 0; background: #DDDDDD; }',
    '  .c { height: 40px; margin: -10px 0 0; background: #CCCCCC; }',
    '</style></head><body><main class="slide">',
    '  <div class="a"></div><div class="b"></div><div class="c"></div>',
    '</main></body></html>'
  ].join('\n');
  const elements = pipeline.convertHtml(html).deck.slides[0].elements;
  const tops = elements.map((element) => Math.round(element.y * 96 * 10) / 10);
  assert.deepEqual(tops, [40, 104, 134], 'collapsed tops: ' + JSON.stringify(tops));
  // A zero margin does not cancel the pull: positive margins take the larger, negatives add.
  const pulled = pipeline.convertHtml(html.replace('margin: 16px 0 0;', 'margin: 0;'));
  const pulledTops = pulled.deck.slides[0].elements.map((element) => Math.round(element.y * 96 * 10) / 10);
  assert.deepEqual(pulledTops, [40, 104, 134], 'the -10px still pulls: ' + JSON.stringify(pulledTops));
});

test('a table with no declared width is as wide as its content', () => {
  // Chrome draws such a table at 98px inside a 1280px slide, not across the whole page.
  const html = (tableStyle) => [
    '<html><head><style>.slide { width: 1280px; height: 720px; padding: 40px; }</style></head><body>',
    '<main class="slide"><table style="' + tableStyle + '">',
    '<thead><tr><th>产品线</th><th>收入</th><th>同比</th></tr></thead>',
    '<tbody><tr><td>第一条</td><td>3,120</td><td>+4%</td></tr></tbody></table></main></body></html>'
  ].join('\n');
  const auto = pipeline.convertHtml(html(''));
  const autoTable = auto.deck.slides[0].elements.find((element) => element.type === 'table');
  assert.ok(autoTable.w < 3, 'shrink to fit: ' + autoTable.w.toFixed(2) + 'in');
  // Every auto column fits its own longest cell, insets included, or the reader wraps it.
  const insets = 2 / 72;
  const widths = autoTable.options.colW;
  assert.equal(widths.length, 3);
  assert.ok(widths[0] * 72 >= 33 + 2, '产品线 needs 33pt of text plus its insets, got ' + (widths[0] * 72).toFixed(2));
  assert.ok(Math.abs(widths.reduce((sum, value) => sum + value, 0) - autoTable.w) < 0.01,
    'the columns add up to the table width');
  assert.ok(insets > 0);
  // A declared width still wins: the same table asked to fill the page does.
  const stretched = pipeline.convertHtml(html('width: 100%'));
  const stretchedTable = stretched.deck.slides[0].elements.find((element) => element.type === 'table');
  assert.ok(Math.abs(stretchedTable.w * 96 - 1200) < 2, 'width: 100% is the container: ' + (stretchedTable.w * 96).toFixed(1) + 'px');
});

test('a table row is tall enough for the reader that draws it', async () => {
  // Two measurements that only a renderer knows: a cell margin below one point is written
  // 72x too large, and a CJK line box is 1.5em where the Latin one is 1.2em. Both were
  // found by rendering: 0.75pt of padding became 54pt of margin, and a row measured at the
  // Latin ratio drew its text 9pt past the row, on top of the paragraph below the table.
  const html = [
    '<html><head><style>.slide { width: 1280px; height: 720px; padding: 40px; }',
    'td, th { padding: 1px; }</style></head><body><main class="slide">',
    '<table><thead><tr><th>产品线</th><th>收入</th></tr></thead>',
    '<tbody><tr><td>第一条</td><td>3,120</td></tr></tbody></table>',
    '</main></body></html>'
  ].join('\n');
  const result = pipeline.convertHtml(html);
  const table = result.deck.slides[0].elements.find((element) => element.type === 'table');
  assert.equal(table.rows[0][0].options.margin[0], 1, 'a sub-point inset is floored at one point');
  const rowPt = table.options.rowH[0] * 72;
  assert.ok(rowPt >= 17, 'an 11pt CJK row needs its 1.5em line box, was ' + rowPt.toFixed(2) + 'pt');
  assert.ok(table.options.rowH.every((height, index) => index === 0 || height > 0));

  const fs = require('node:fs');
  const os = require('node:os');
  const path = require('node:path');
  const JSZip = require(require.resolve('jszip', { paths: [require.resolve('../native/engine/native_pptx')] }));
  const { generatePptx } = require('../native/engine/native_pptx');
  const file = path.join(os.tmpdir(), 'table-row-' + process.pid + '.pptx');
  try {
    await generatePptx(result.deck, file);
    const zip = await JSZip.loadAsync(fs.readFileSync(file));
    const xml = await zip.file('ppt/slides/slide1.xml').async('string');
    const top = Number((/marT="(\d+)"/u.exec(xml) || [0, 0])[1]);
    assert.equal(top, 12700, 'one point of margin is 12700 EMU, not 685800');
    const heights = [...xml.matchAll(/<a:tr h="(\d+)"/gu)].map((match) => Number(match[1]));
    assert.equal(heights.length, 2, 'header and body row');
    heights.forEach((height) => {
      assert.ok(height >= 215900, 'a row of 11pt CJK text is at least 17pt tall, was ' + (height / 12700).toFixed(2) + 'pt');
    });
  } finally {
    fs.rmSync(file, { force: true });
  }
});

test('a picture filter becomes blip colour transforms, and the rest is named', async () => {
  // DrawingML spells three of CSS's filter functions on a picture: <a:grayscl/>, <a:lum
  // bright contrast/> and <a:alphaModFix/>. Contrast maps exactly (both scale about 0.5);
  // brightness does not (CSS multiplies, DrawingML adds), so it is drawn and said out loud.
  assert.deepEqual(css.parseImageFilter('grayscale(1) contrast(1.25) brightness(0.85)').applied,
    { grayscale: true, contrast: 25, brightness: -15 });
  assert.deepEqual(css.parseImageFilter('opacity(60%)').applied, { opacity: 0.6 });
  const unsupported = css.parseImageFilter('sepia(0.5) blur(4px)');
  assert.equal(unsupported.applied, null, 'nothing there has a native spelling');
  assert.deepEqual(unsupported.unhandled.map((entry) => entry.name), ['sepia', 'blur']);
  assert.equal(css.parseImageFilter('grayscale(0.4)').applied, null, 'half a greyscale is not on or off');

  const fs = require('node:fs');
  const os = require('node:os');
  const path = require('node:path');
  const JSZip = require(require.resolve('jszip', { paths: [require.resolve('../native/engine/native_pptx')] }));
  const { generatePptx } = require('../native/engine/native_pptx');
  // A one-pixel PNG, so the deck needs no fixture image on disk.
  const pixel = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAIAAACQd1PeAAAADElEQVR4nGOQtTYDAAEHAI9Yd1qPAAAAAElFTkSuQmCC';
  const html = [
    '<html><head><style>.slide { width: 1280px; height: 720px; padding: 40px; }</style></head><body>',
    '<main class="slide">',
    '<img src="data:image/png;base64,' + pixel + '" style="width:200px;height:120px;filter:grayscale(1)">',
    '<img src="data:image/png;base64,' + pixel + '" style="width:200px;height:120px;filter:contrast(1.25) brightness(0.85)">',
    '<img src="data:image/png;base64,' + pixel + '" style="width:200px;height:120px;filter:opacity(0.55) sepia(0.3)">',
    '</main></body></html>'
  ].join('\n');
  const result = pipeline.convertHtml(html);
  const images = result.deck.slides[0].elements.filter((element) => element.type === 'image');
  assert.equal(images.length, 3);
  assert.deepEqual(images[0].imageFilter, { grayscale: true });
  assert.deepEqual(images[1].imageFilter, { contrast: 25, brightness: -15 });
  assert.deepEqual(images[2].imageFilter, { opacity: 0.55 });
  const reasons = result.report.unsupportedDetails.filter((entry) => entry.property === 'filter');
  assert.equal(reasons.length, 2, 'one for the brightness approximation, one for sepia');
  assert.ok(reasons.some((entry) => entry.reason.includes('luminance offset')));
  assert.ok(reasons.some((entry) => entry.reason.includes('sepia')));

  const file = path.join(os.tmpdir(), 'image-filter-' + process.pid + '.pptx');
  try {
    await generatePptx(result.deck, file);
    const zip = await JSZip.loadAsync(fs.readFileSync(file));
    const xml = await zip.file('ppt/slides/slide1.xml').async('string');
    const blips = [...xml.matchAll(/<a:blip[^>]*>([\s\S]*?)<\/a:blip>/gu)].map((match) => match[1]);
    assert.equal(blips[0], '<a:grayscl/>');
    assert.equal(blips[1], '<a:lum bright="-15000" contrast="25000"/>',
      '-15% of full scale and +25% of contrast is what -0.15 and +0.25 mean');
    assert.equal(blips[2], '<a:alphaModFix amt="55000"/>');
    assert.equal((xml.match(/<a:grayscl\/>/gu) || []).length, 1, 'the patch is idempotent');
  } finally {
    fs.rmSync(file, { force: true });
  }
});

test('a first letter is its own run, in place, and a floated one is named', () => {
  // `::first-letter` styles the first glyph without moving it, which is a run property: the
  // paragraph keeps one text box, one paragraph, and the letter carries its own size, colour
  // and weight. A declaration that would push the rest of the line away has no run spelling.
  const drop = pipeline.convertHtml([
    '<html><head><style>',
    '  .slide { width: 1280px; height: 720px; padding: 40px; }',
    '  p { width: 600px; font-size: 20px; line-height: 1.8; color: #2C3634; }',
    '  p.drop::first-letter { font-size: 3em; color: #C2703F; font-weight: 700; }',
    '</style></head><body><main class="slide">',
    '<p class="drop">排版的第一笔</p>',
    '</main></body></html>'
  ].join('\n'));
  const paragraph = drop.deck.slides[0].elements[0];
  assert.ok(Array.isArray(paragraph.text), 'the paragraph travels as runs');
  assert.equal(paragraph.text.length, 2, 'the letter is split from the rest of the line');
  assert.equal(paragraph.text[0].text, '排', 'one character, not one word');
  assert.equal(paragraph.text[0].options.color, 'C2703F');
  assert.equal(paragraph.text[0].options.bold, true);
  // 3em of a 20px block is 60px, which is 45pt.
  assert.equal(Math.round(paragraph.text[0].options.fontSize), 45);
  assert.equal(paragraph.text[1].text, '版的第一笔');
  assert.equal(paragraph.text[1].options, undefined, 'the rest keeps the paragraph type');
  assert.equal(paragraph.text.map((run) => run.text).join(''), '排版的第一笔');
  assert.deepEqual(drop.report.unsupportedDetails, [], 'carrying it is not a gap');

  const floated = pipeline.convertHtml([
    '<html><head><style>',
    '  .slide { width: 1280px; height: 720px; padding: 40px; }',
    '  p { width: 600px; font-size: 20px; color: #2C3634; }',
    '  p.f::first-letter { float: left; margin-right: 8px; font-size: 3em; }',
    '</style></head><body><main class="slide">',
    '<p class="f">浮动首字会把后面的字挤开</p>',
    '</main></body></html>'
  ].join('\n'));
  const named = floated.report.unsupportedDetails.map((entry) => entry.property);
  assert.ok(named.includes('float'), 'a floated first letter is named');
  assert.ok(named.includes('marginRight'), 'and so is the margin that goes with it');
  // The type still lands: only the layout part is refused.
  const letter = floated.deck.slides[0].elements[0].text[0];
  assert.equal(Math.round(letter.options.fontSize), 45);
});

test('a line is as tall as the tallest run on it, not the tallest run in the box', () => {
  // Chrome, measured: the same paragraph is 74px tall without a drop cap and 155.39px with a
  // 3.2em first letter - the first line grows, the second does not. Charging the largest run
  // to every line reserved 236.8px, so the box was half a line too tall and everything below
  // it slid down by the difference.
  const html = (drop) => [
    '<html><head><style>',
    '  * { box-sizing: border-box; }',
    '  .slide { width: 1280px; height: 720px; padding: 60px; }',
    '  p { width: 760px; font-size: 20px; line-height: 1.85; color: #2C3634; margin: 0; }',
    '  p.drop::first-letter { font-size: 3.2em; font-weight: 700; }',
    '  p.plain { margin-top: 30px; }',
    '</style></head><body><main class="slide">',
    '<p class="' + (drop ? 'drop' : 'plain') + '">排版的第一笔，往往是首字下沉。编辑设计用它把一页正文的入口敞开，让读者先看见一个放大的字，再顺着行走进内容。</p>',
    '</main></body></html>'
  ].join('\n');
  const tall = pipeline.convertHtml(html(true)).deck.slides[0].elements[0];
  const plain = pipeline.convertHtml(html(false)).deck.slides[0].elements[0];
  assert.equal(Number((plain.h * 96).toFixed(1)), 74);
  // 3.2em is 64px; 64 x 1.85 plus one 20px line at 1.85 is 155.4.
  assert.equal(Number((tall.h * 96).toFixed(1)), 155.4, 'the big letter grows one line only');
  assert.ok(tall.h < 2, 'and not every line: the box used to reserve 2.47in');
});

test('a box-shadow parses its hex colour and its first layer', () => {
  const build = (css) => pipeline.convertHtml([
    '<html><head><style>',
    '  .slide { width: 1280px; height: 720px; padding: 40px; }',
    '  ' + css,
    '</style></head><body><main class="slide"><div class="b"></div></main></body></html>'
  ].join('\n'));

  // A solid offset shadow in a named hex: the colour used to fragment into stray
  // lengths, which blackened the shadow and reported a working declaration.
  const hard = build('.b { width: 200px; height: 80px; background: #fff; box-shadow: 6px 8px 0 #C05B3E; }');
  const hardShadow = hard.deck.slides[0].elements[0].shadow;
  assert.equal(hardShadow.color, 'C05B3E', 'the declared colour reaches the shadow');
  assert.equal(hardShadow.opacity, 1);
  assert.deepEqual(hard.report.unsupportedDetails.map((entry) => entry.property), [],
    'a parsed shadow is not reported');

  // A layered declaration keeps its first layer and names the rest.
  const layered = build('.b { width: 200px; height: 80px; background: #fff;'
    + ' box-shadow: 0 2px 4px rgba(0,0,0,0.2), 0 8px 20px rgba(0,0,0,0.3); }');
  assert.ok(layered.deck.slides[0].elements[0].shadow, 'the first layer lands');
  assert.deepEqual(layered.report.unsupportedDetails.map((entry) => entry.property), ['boxShadow'],
    'the second layer is named, not dropped in silence');

  // An inset declaration is an inner shadow now: DrawingML spells it `<a:innerShdw>`, so it
  // travels as `innerShadow` and is not reported at all. It used to be refused whole, and a
  // declaration that carried an inset layer beside an outer one lost both.
  const inset = build('.b { width: 200px; height: 80px; background: #fff;'
    + ' box-shadow: inset 0 2px 6px rgba(0,0,0,0.3); }');
  const insetShadow = inset.deck.slides[0].elements[0].innerShadow;
  assert.ok(insetShadow, 'the inset layer becomes an inner shadow');
  assert.equal(inset.deck.slides[0].elements[0].shadow, undefined, 'and not an outer one');
  assert.equal(Number(insetShadow.blur.toFixed(2)), 4.5, '6px is 4.5pt');
  assert.equal(Number(insetShadow.distance.toFixed(2)), 1.5, '2px is 1.5pt');
  assert.equal(Number(insetShadow.opacity.toFixed(2)), 0.3);
  assert.deepEqual(inset.report.unsupportedDetails.map((entry) => entry.property), []);

  const both = build('.b { width: 200px; height: 80px; background: #fff;'
    + ' box-shadow: inset 0 2px 6px rgba(0,0,0,0.3), 0 6px 14px rgba(0,0,0,0.25); }');
  assert.ok(both.deck.slides[0].elements[0].shadow, 'the outer layer still lands');
  assert.ok(both.deck.slides[0].elements[0].innerShadow, 'and so does the inset one');
  assert.deepEqual(both.report.unsupportedDetails.map((entry) => entry.property), []);
});


test('list-style: none switches the bullet off, and repeat values are named per value', () => {
  const buildList = (css) => pipeline.convertHtml([
    '<html><head><style>',
    '  .slide { width: 1280px; height: 720px; padding: 40px; }',
    '  ' + css,
    '</style></head><body><main class="slide"><ul class="b"><li>one</li><li>two</li></ul></main></body></html>'
  ].join('\n'));

  // The design asked for no marker: the native bullet has an off switch, and using it
  // is what `list-style: none` means. It used to be reported while the dot still drew.
  const plain = buildList('ul.b { list-style: none; }');
  assert.equal(plain.deck.slides[0].elements[0].bullet, undefined, 'no bullet is emitted');
  assert.deepEqual(plain.report.unsupportedDetails.map((entry) => entry.property), [],
    'asking for what the native side does is not a limitation');

  // The round shapes have native buChar spellings now, and the ordered ones have
  // buAutoNum; only the rare markers still draw the round bullet and stay named.
  const square = buildList('ul.b { list-style: square; }');
  assert.deepEqual(square.deck.slides[0].elements[0].bullet, { code: '25AA' });
  assert.deepEqual(square.report.unsupportedDetails.map((entry) => entry.property), []);

  const numbered = buildList('ul.b { list-style: decimal; }');
  assert.deepEqual(numbered.deck.slides[0].elements[0].bullet, { type: 'number', style: 'arabicPeriod' });

  const rare = buildList('ul.b { list-style: cjk-ideographic; }');
  assert.equal(rare.deck.slides[0].elements[0].bullet, true, 'the rare marker still draws the round bullet');
  const rareNote = rare.report.unsupportedDetails.find((entry) => entry.property === 'listStyle');
  assert.ok(rareNote.reason.includes('round bullet'), 'the reason says what actually draws');

  // `no-repeat` is what a fitted picture does; tiling is the real limitation.
  const buildDiv = (css) => pipeline.convertHtml([
    '<html><head><style>',
    '  .slide { width: 1280px; height: 720px; padding: 40px; }',
    '  ' + css,
    '</style></head><body><main class="slide"><div class="b"></div></main></body></html>'
  ].join('\n'));
  const quiet = buildDiv('.b { width: 100px; height: 50px; background: url(x.png); background-repeat: no-repeat; }');
  assert.deepEqual(quiet.report.unsupportedDetails.map((entry) => entry.property), []);
  const tiled = buildDiv('.b { width: 100px; height: 50px; background: url(x.png); background-repeat: repeat; }');
  const tiledNote = tiled.report.unsupportedDetails.find((entry) => entry.property === 'backgroundRepeat');
  assert.ok(tiledNote.reason.includes('drawn once'), 'the reason says what the reader sees');
});


test('clip-path circle and ellipse that cut the inscribed shape become the geometry', () => {
  const build = (css) => pipeline.convertHtml([
    '<html><head><style>',
    '  .slide { width: 1280px; height: 720px; padding: 40px; }',
    '  ' + css,
    '</style></head><body><main class="slide"><div class="b"></div></main></body></html>'
  ].join('\n'));
  const element = (result) => result.deck.slides[0].elements[0];

  // A circle avatar on a square box and an ellipse pill on any box are the native
  // ellipse preset, not a polygon patch.
  const dot = build('.b { width: 120px; height: 120px; background: #17332F; clip-path: circle(50%); }');
  assert.equal(element(dot).shape, 'ellipse');
  assert.equal(element(dot).clip, undefined);
  assert.deepEqual(dot.report.unsupportedDetails.map((entry) => entry.property), []);

  const pill = build('.b { width: 300px; height: 120px; background: #C05B3E; clip-path: ellipse(50% 50%); }');
  assert.equal(element(pill).shape, 'ellipse');
  assert.deepEqual(pill.report.unsupportedDetails.map((entry) => entry.property), []);

  // A circle on a non-square box is bigger than the inscribed one (the CSS reference is
  // the half-diagonal), so it is not the box geometry and stays reported.
  const wide = build('.b { width: 200px; height: 100px; background: #17332F; clip-path: circle(50%); }');
  assert.equal(element(wide).shape, undefined);
  assert.deepEqual(wide.report.unsupportedDetails.map((entry) => entry.property), ['clipPath']);

  // A smaller radius leaves paint in the corners, which a filled geometry cannot keep.
  const small = build('.b { width: 120px; height: 120px; background: #17332F; clip-path: circle(40%); }');
  assert.deepEqual(small.report.unsupportedDetails.map((entry) => entry.property), ['clipPath']);

  // A moved centre has no native spelling.
  const moved = build('.b { width: 120px; height: 120px; background: #17332F; clip-path: circle(50%) at 50% 50%; }');
  assert.deepEqual(moved.report.unsupportedDetails.map((entry) => entry.property), ['clipPath']);
});


test('the font shorthand expands into the longhands it sets', () => {
  const build = (css) => pipeline.convertHtml([
    '<html><head><style>',
    '  .slide { width: 1280px; height: 720px; padding: 40px; }',
    '  ' + css,
    '</style></head><body><main class="slide"><p class="b">hello</p></main></body></html>'
  ].join('\n'));
  const face = (result) => {
    const element = result.deck.slides[0].elements[0];
    const run = Array.isArray(element.text) ? element.text[0] : {};
    return { h: +(element.h * 96).toFixed(1), bold: element.bold || run.options && run.options.bold,
      face: element.fontFace || (run.options && run.options.fontFace) };
  };

  // Shorthand and longhand land on the same box, the same weight and the same face.
  const short = build('.b { font: 700 24px/1.4 "Microsoft YaHei"; }');
  const long = build('.b { font-size: 24px; font-weight: 700; line-height: 1.4; font-family: "Microsoft YaHei"; }');
  assert.deepEqual(face(short), face(long), 'the shorthand is the longhand');
  assert.deepEqual(short.report.unsupportedDetails.map((entry) => entry.property), []);

  // A comma stack survives verbatim, and the keywords before the size all land.
  const stacked = build('.b { font: small-caps 500 18pt/1.2 "Segoe UI", sans-serif; }');
  assert.equal(face(stacked).face, 'Segoe UI');
  assert.equal(stacked.deck.slides[0].elements[0].smallCaps, true, 'small-caps travels');

  // A system-font keyword form has no face to name, so it stays reported whole.
  const system = build('.b { font: caption; }');
  assert.deepEqual(system.report.unsupportedDetails.map((entry) => entry.property), ['font']);
});


test('::marker colours the bullet, not the text', () => {
  const build = (css) => pipeline.convertHtml([
    '<html><head><style>',
    '  .slide { width: 1280px; height: 720px; padding: 40px; }',
    '  ' + css,
    '</style></head><body><main class="slide">',
    '<ul><li class="cool plain">one</li><li class="cool plain">two</li></ul>',
    '</main></body></html>'
  ].join('\n'));

  // A uniform marker colour rides on the element and lands as a:buClr before buChar.
  const red = build('li.cool::marker { color: #C05B3E; } .plain { font-size: 20px; }');
  assert.equal(red.deck.slides[0].elements[0].markerColor, 'C05B3E');
  assert.deepEqual(red.report.unsupportedDetails.map((entry) => entry.property), []);
  const { applyMarkerColour } = require('../native/engine/native_pptx');
  const paragraph = '<a:pPr marL="342900" indent="-342900"><a:buSzPct val="100000"/><a:buChar char="•"/></a:pPr>';
  const coloured = applyMarkerColour(paragraph, 'C05B3E');
  assert.ok(coloured.indexOf('<a:buClr><a:srgbClr val="C05B3E"/></a:buClr><a:buChar') > 0, 'buClr precedes buChar');

  // The rule targets the li, so the element-level list never sees it on its own.
  const plain = build('.plain { font-size: 20px; }');
  assert.equal(plain.deck.slides[0].elements[0].markerColor, undefined);

  // A disagreement across items is named: one text box carries one bullet colour.
  const mixed = pipeline.convertHtml([
    '<html><head><style>',
    '  .slide { width: 1280px; height: 720px; padding: 40px; }',
    '  li.a::marker { color: #C05B3E; } li.b::marker { color: #17332F; }',
    '  .plain { font-size: 20px; }',
    '</style></head><body><main class="slide">',
    '<ul><li class="a plain">one</li><li class="b plain">two</li></ul>',
    '</main></body></html>'
  ].join('\n'));
  assert.equal(mixed.deck.slides[0].elements[0].markerColor, undefined);
  assert.deepEqual(mixed.report.unsupportedDetails.map((entry) => entry.property), ['::marker']);
});


test('caption-side: bottom moves the caption under the grid', () => {
  const build = (css) => pipeline.convertHtml([
    '<html><head><style>',
    '  .slide { width: 1280px; height: 720px; padding: 40px; }',
    '  ' + css,
    '</style></head><body><main class="slide">',
    '<table class="t"><caption>表题</caption><tr><td>a</td><td>b</td></tr></table>',
    '</main></body></html>'
  ].join('\n'));
  const spots = (result) => {
    const spotsOut = {};
    result.deck.slides[0].elements.forEach((element) => {
      if (element.type === 'text' && typeof element.text === 'string') spotsOut.captionY = +(element.y * 96).toFixed(1);
      if (element.type === 'table') spotsOut.tableY = +(element.y * 96).toFixed(1);
    });
    return spotsOut;
  };

  // Default is top: caption above the grid, grid starting below the caption text.
  const top = build('.t { }');
  assert.deepEqual(spots(top).captionY < spots(top).tableY, true, 'top caption above the grid');
  assert.deepEqual(top.report.unsupportedDetails.map((entry) => entry.property), []);

  // Bottom swaps the order, and the grid itself starts at the node top. Verified in
  // Chrome: captionTop 78 > tableTop 48 on the same fixture.
  const bottom = build('.t { caption-side: bottom; }');
  assert.deepEqual(spots(bottom).captionY > spots(bottom).tableY, true, 'bottom caption under the grid');
  // The caption box TOP sits one caption-height above the grid bottom, which is where
  // Chrome puts it (captionTop 78 = gridBottom 95.9 - caption 17.5 on the twin fixture).
  assert.equal(spots(bottom).captionY,
    +(spots(bottom).tableY + spotsUnder(bottom) - (spots(bottom).captionY === 0 ? 0 : captionHeight(bottom))).toFixed(1),
    'the caption sits at the grid bottom');
  assert.deepEqual(bottom.report.unsupportedDetails.map((entry) => entry.property), []);

  function captionHeight(result) {
    let height = 0;
    result.deck.slides[0].elements.forEach((element) => {
      if (element.type === 'text' && typeof element.text === 'string') height = element.h * 96;
    });
    return height;
  }
  function spotsUnder(result) {
    let tableH = 0;
    result.deck.slides[0].elements.forEach((element) => {
      if (element.type === 'table') tableH = element.h * 96;
    });
    return tableH;
  }
});


test('text-transform: full-width maps the ASCII range onto fullwidth forms', () => {
  const build = (markup, css) => pipeline.convertHtml([
    '<html><head><style>',
    '  .slide { width: 1280px; height: 720px; padding: 40px; }',
    '  ' + (css || ''),
    '</style></head><body><main class="slide">', markup, '</main></body></html>'
  ].join('\n'));
  const textOf = (result) => {
    const element = result.deck.slides[0].elements[0];
    return typeof element.text === 'string' ? element.text : (element.text || []).map((run) => run.text).join('');
  };

  // The CJK typographic request: every ASCII printable gains its fullwidth cousin.
  const wide = build('<p class="b">Price: $1,200 (USD)</p>', '.b { text-transform: full-width; }');
  assert.equal(textOf(wide), 'Ｐｒｉｃｅ： ＄１，２００ （ＵＳＤ）');
  assert.deepEqual(wide.report.unsupportedDetails.map((entry) => entry.property), []);

  // The other transforms keep their behaviour (guards against a regression here).
  const upper = build('<p class="b">hello</p>', '.b { text-transform: uppercase; }');
  assert.equal(textOf(upper), 'HELLO');
  const cap = build('<p class="b">hello world</p>', '.b { text-transform: capitalize; }');
  assert.equal(textOf(cap), 'Hello World');
});


test('grid fr and flex-basis allocation matches the browser exactly', () => {
  // Chrome-measured on the twin fixture: 1fr 2fr in 1200px with a 10px gap gives
  // 396.7 / 793.3, and two flex-basis:30% items with grow 0 stay 360 each.
  const build = (css) => pipeline.convertHtml([
    '<html><head><style>',
    '  .slide { width: 1280px; height: 720px; padding: 40px; }',
    '  ' + css,
    '</style></head><body><main class="slide">',
    '<div class="g"><div>a</div><div>b</div></div>',
    '</main></body></html>'
  ].join('\n'));
  const widths = (result) => {
    const found = [];
    const walk = (children) => (children || []).forEach((child) => {
      if (child.type === 'text' && child.w) found.push(+(child.w * 96).toFixed(1));
      walk(child.children);
    });
    walk(result.deck.slides[0].elements);
    return found;
  };

  // A painted cell keeps its measured width (a bare text child does not - the box
  // exists only in the reader's layout there).
  const cell = '.g div { height: 50px; background: #E8E1D0; }';
  const grid = build('.g { display: grid; grid-template-columns: 1fr 2fr; gap: 10px; } ' + cell);
  assert.deepEqual(widths(grid), [396.7, 793.3]);

  const flex = build('.g { display: flex; gap: 10px; } .g div { flex-basis: 30%; height: 50px; background: #E8E1D0; }');
  assert.deepEqual(widths(flex), [360, 360]);
});


test('outline draws a uniform ring without taking layout space', () => {
  const build = (css) => pipeline.convertHtml([
    '<html><head><style>',
    '  .slide { width: 1280px; height: 720px; padding: 40px; }',
    '  ' + css,
    '</style></head><body><main class="slide">',
    '<div class="a">one</div><div class="b">two</div>',
    '</main></body></html>'
  ].join('\n'));
  const ringOf = (result) => {
    const element = result.deck.slides[0].elements[0];
    const bg = element.background || element.fill;
    return { colour: bg && bg.lineColor, dash: bg && bg.lineDash };
  };

  // The outline becomes the shape's line, with its colour and dash.
  const solid = build('.a { outline: 2px solid #C05B3E; width: 140px; height: 60px; } .b { width: 140px; height: 60px; }');
  assert.equal(ringOf(solid).colour, 'C05B3E');
  assert.deepEqual(solid.report.unsupportedDetails.map((entry) => entry.property), []);

  const dashed = build('.a { outline: 2px dashed #C05B3E; width: 140px; height: 60px; } .b { width: 140px; height: 60px; }');
  assert.equal(ringOf(dashed).colour, 'C05B3E');
  assert.ok(ringOf(dashed).dash, 'the dash survives');

  // A declared border wins the shape line; the outline is a fallback, not an override.
  const both = build('.a { border: 1px solid #17332F; outline: 2px solid #C05B3E; width: 140px; height: 60px; } .b { width: 140px; height: 60px; }');
  assert.equal(ringOf(both).colour, '17332F');

  // The ring takes no layout space: the second box does not shift (Chrome puts it at
  // 40 + 60 + 30 = 130px on the twin fixture - the same number the deck shows).
  const spaced = build('.a { outline: 4px solid #C05B3E; width: 140px; height: 60px; } .b { margin-top: 30px; width: 140px; height: 60px; }');
  const second = spaced.deck.slides[0].elements.find((element) => typeof element.text === 'string' && element.text.includes('two'));
  assert.equal(+(second.y * 96).toFixed(1), 130, 'the outline adds no inset');
});


test('logical properties alias their physical sides in ltr', () => {
  // Chrome-measured on the twin fixture: inset 10px 20px puts the box at x 20 (left wins
  // in ltr), y 10; inset-inline-start 50px puts it at x 50.
  const build = (css) => pipeline.convertHtml([
    '<html><head><style>',
    '  .slide { width: 1280px; height: 720px; padding: 40px; }',
    '  ' + css,
    '</style></head><body><main class="slide"><div class="b"></div></main></body></html>'
  ].join('\n'));
  const spot = (result) => {
    const element = result.deck.slides[0].elements[0];
    return { x: +(element.x * 96).toFixed(1), y: +(element.y * 96).toFixed(1) };
  };

  const inset = build('.b { position: absolute; inset: 10px 20px; width: 100px; height: 50px; background: #ccc; }');
  assert.deepEqual(spot(inset), { x: 20, y: 10 });
  assert.deepEqual(inset.report.unsupportedDetails.map((entry) => entry.property), []);

  const inline = build('.b { position: absolute; inset-inline-start: 50px; top: 10px; width: 100px; height: 50px; background: #ccc; }');
  assert.deepEqual(spot(inline), { x: 50, y: 10 });

  // Single-value inset spreads to all four sides.
  const all = build('.b { position: absolute; inset: 10px; width: 100px; height: 50px; background: #ccc; }');
  assert.deepEqual(spot(all), { x: 10, y: 10 });

  // The border alias feeds the same single-side edge path the physical side does.
  const ring = build('.b { border-block-start: 2px solid #C05B3E; width: 100px; height: 50px; background: #ccc; }');
  const element = ring.deck.slides[0].elements[0];
  assert.equal(element.edge && element.edge.color, 'C05B3E');
  assert.equal(element.edge && element.edge.side, 'top');
});


test('a relative offset reaches the final PPTX coordinates', async () => {
  const fs = require('node:fs');
  // The regression: layoutSlide applied relativeShift on the element paths but not on
  // the top-level container and text paths, so a shifted box painted at its static spot.
  const os = require('node:os');
  const path = require('node:path');
  const JSZip = require(require.resolve('jszip', { paths: [require.resolve('../native/engine/native_pptx')] }));
  const { generatePptx } = require('../native/engine/native_pptx');
  const result = pipeline.convertHtml([
    '<html><head><style>',
    '  .slide { width: 1280px; height: 720px; padding: 40px; }',
    '  .a { position: relative; top: 20px; left: 30px; width: 140px; height: 60px; background: #C05B3E; }',
    '  .b { position: sticky; top: 10px; width: 140px; height: 60px; background: #17332F; margin-top: 10px; }',
    '</style></head><body><main class="slide">',
    '<div class="a">rel</div><div class="b">sticky</div>',
    '</main></body></html>'
  ].join('\n'));
  const output = path.join(os.tmpdir(), 'native-relative-' + process.pid + '.pptx');
  try {
    await generatePptx(result.deck, output);
    const zip = await JSZip.loadAsync(require('node:fs').readFileSync(output));
    const xml = await zip.file('ppt/slides/slide1.xml').async('string');
    const offs = [];
    const pattern = /<a:off x="(\d+)" y="(\d+)"/gu;
    let match;
    while ((match = pattern.exec(xml))) offs.push([Math.round(match[1] / 9525), Math.round(match[2] / 9525)]);
    // rel: 40 + 30 = 70, 40 + 20 = 60. sticky: x 40, y 110 + 10 = 120.
    assert.deepEqual(offs.slice(1, 2), [[70, 60]], 'the relative box moved');
    assert.deepEqual(offs.slice(3, 4), [[40, 120]], 'the sticky box moved');
  } finally {
    if (fs.existsSync(output)) fs.unlinkSync(output);
  }
});


test('inline semantics reach the file: hyperlink, mark, and sub/sup', async () => {
  // Semantic audit round: every family translated with no reports. The file-level checks
  // pin the ones a spec-only assertion would miss.
  const os = require('node:os');
  const path = require('node:path');
  const fs = require('node:fs');
  const JSZip = require(require.resolve('jszip', { paths: [require.resolve('../native/engine/native_pptx')] }));
  const { generatePptx } = require('../native/engine/native_pptx');

  const result = pipeline.convertHtml([
    '<html><head><style>',
    '  .slide { width: 1280px; height: 720px; padding: 40px; }',
    '  .p { font-size: 16px; }',
    '</style></head><body><main class="slide">',
    '<p class="p">见<a href="https://example.com">链接</a>与<mark>高亮</mark>和H<sub>2</sub>O</p>',
    '</main></body></html>'
  ].join('\n'));
  const output = path.join(os.tmpdir(), 'native-semantics-' + process.pid + '.pptx');
  try {
    await generatePptx(result.deck, output);
    const zip = await JSZip.loadAsync(fs.readFileSync(output));
    const rels = await zip.file('ppt/slides/_rels/slide1.xml.rels').async('string');
    const slide = await zip.file('ppt/slides/slide1.xml').async('string');
    assert.ok(rels.includes('example.com'), 'the hyperlink target is in the relationships');
    assert.ok(slide.includes('hlinkClick'), 'the run carries the link');
    assert.ok(slide.includes('<a:highlight><a:srgbClr val="FFFF00"/>'), 'mark paints its yellow');
    assert.ok(slide.includes('baseline="-40000"'), 'subscript drops the baseline');
    assert.deepEqual(result.report.unsupportedDetails.map((entry) => entry.property), []);
  } finally {
    if (fs.existsSync(output)) fs.unlinkSync(output);
  }
});


test('transition and animation reports name the journey, not the state', () => {
  // The end state of a transform IS drawn; what the reader misses is the movement.
  const build = (css) => pipeline.convertHtml([
    '<html><head><style>',
    '  .slide { width: 1280px; height: 720px; padding: 40px; }',
    '  ' + css,
    '</style></head><body><main class="slide"><div class="b">x</div></main></body></html>'
  ].join('\n'));

  const transition = build('.b { transition: transform .3s; transform: translateX(10px); width: 50px; height: 30px; }');
  const tReport = transition.report.unsupportedDetails.find((entry) => entry.property === 'transition');
  assert.ok(tReport.reason.includes('end state'), 'the report says the end state is drawn');
  // The translate landed: x is 40 + 10.
  assert.equal(+(transition.deck.slides[0].elements[0].x * 96).toFixed(1), 50);

  const animation = build('.b { animation: slide 1s forwards; width: 50px; height: 30px; }');
  const aReport = animation.report.unsupportedDetails.find((entry) => entry.property === 'animation');
  assert.ok(aReport.reason.includes('final state'), 'the report says the final state is drawn');

  // `none` stays silent on both.
  const quiet = build('.b { transition: none; animation: none; width: 50px; height: 30px; }');
  assert.deepEqual(quiet.report.unsupportedDetails.map((entry) => entry.property), []);
});


test('chart styling reaches the chart part', async () => {
  // Title, custom colours and the legend position live in ppt/charts/chart1.xml, not
  // just the spec - a spec-only assertion would pass while the reader lost the styling.
  const os = require('node:os');
  const path = require('node:path');
  const fs = require('node:fs');
  const JSZip = require(require.resolve('jszip', { paths: [require.resolve('../native/engine/native_pptx')] }));
  const { generatePptx } = require('../native/engine/native_pptx');
  const result = pipeline.convertHtml([
    '<html><head><style>',
    '  .slide { width: 1280px; height: 720px; padding: 40px; }',
    '</style></head><body><main class="slide">',
    '<div style="width:500px;height:350px" data-chart="pie" data-chart-title="销量表"',
    '     data-chart-legend="bottom" data-chart-colors="#C05B3E,#17332F">',
    '<table><tr><th>季度</th><th>销量</th></tr><tr><td>Q1</td><td>100</td></tr><tr><td>Q2</td><td>150</td></tr></table>',
    '</div>',
    '</main></body></html>'
  ].join('\n'));
  const output = path.join(os.tmpdir(), 'native-chart-style-' + process.pid + '.pptx');
  try {
    await generatePptx(result.deck, output);
    const zip = await JSZip.loadAsync(fs.readFileSync(output));
    const chartName = Object.keys(zip.files).find((name) => /ppt\/charts\/chart\d+\.xml$/.test(name));
    const xml = await zip.file(chartName).async('string');
    assert.ok(xml.includes('C05B3E') && xml.includes('17332F'), 'the custom series colours are in the chart');
    assert.ok(xml.includes('销量表'), 'the title is in the chart');
    assert.ok(/legendPos val="b"/.test(xml), 'the legend sits at the bottom');
    assert.deepEqual(result.report.unsupportedDetails.map((entry) => entry.property), []);
  } finally {
    if (fs.existsSync(output)) fs.unlinkSync(output);
  }
});


test('an emphasis mark is named, because no reader draws one', async () => {
  // DrawingML's run properties carry no emphasis element and no emphasis attribute
  // (ECMA-376 20.1.2.3.1), and a render of the hand-made markup drew the words bare.
  // Claiming the translation was the dishonest part; the report is the honest one.
  const os = require('node:os');
  const path = require('node:path');
  const fs = require('node:fs');
  const JSZip = require(require.resolve('jszip', { paths: [require.resolve('../native/engine/native_pptx')] }));
  const { generatePptx } = require('../native/engine/native_pptx');
  const result = pipeline.convertHtml([
    '<html><head><style>',
    '  .slide { width: 1280px; height: 720px; padding: 40px; }',
    '  .b { text-emphasis: dot #C05B3E; font-size: 22px; }',
    '</style></head><body><main class="slide">',
    '<p class="b">着重号</p>',
    '</main></body></html>'
  ].join('\n'));
  const reported = result.report.unsupportedDetails.filter((entry) => entry.property === 'textEmphasis');
  assert.equal(reported.length, 1, 'the emphasis mark is named once');
  assert.match(reported[0].reason, /no emphasis mark/u, 'with the reason a design can act on');
  const output = path.join(os.tmpdir(), 'native-emphasis-' + process.pid + '.pptx');
  try {
    await generatePptx(result.deck, output);
    const zip = await JSZip.loadAsync(fs.readFileSync(output));
    const xml = await zip.file('ppt/slides/slide1.xml').async('string');
    assert.ok(!/emphasisMark/u.test(xml), 'and nothing invalid is written into the run properties');
    assert.ok(/<a:t>着重号<\/a:t>/u.test(xml), 'the words themselves are still there');
  } finally {
    if (fs.existsSync(output)) fs.unlinkSync(output);
  }

  // `none` asks for nothing, so it stays silent.
  const none = pipeline.convertHtml([
    '<html><head><style>',
    '  .slide { width: 1280px; height: 720px; padding: 40px; }',
    '  .b { text-emphasis: none; font-size: 22px; }',
    '</style></head><body><main class="slide"><p class="b">着重号</p></main></body></html>'
  ].join('\n'));
  assert.deepEqual(none.report.unsupportedDetails.map((entry) => entry.property), []);
});

test('writing-mode vertical spellings land as native vert attributes', () => {
  // eaVert / vert / vert270 are the DrawingML names; the vertical-lr report is the one
  // honest gap (DrawingML names no upright left-to-right direction).
  const build = (value) => pipeline.convertHtml([
    '<html><head><style>',
    '  .slide { width: 1280px; height: 720px; padding: 40px; }',
    '  .b { writing-mode: ' + value + '; height: 300px; width: 400px; font-size: 16px; }',
    '</style></head><body><main class="slide"><p class="b">竖排 mixed 横排</p></main></body></html>'
  ].join('\n'));
  const vert = (result) => result.deck.slides[0].elements[0].vert;

  assert.equal(vert(build('vertical-rl')), 'eaVert');
  assert.equal(vert(build('sideways-rl')), 'vert');
  assert.equal(vert(build('sideways-lr')), 'vert270');
  assert.deepEqual(build('vertical-rl').report.unsupportedDetails.map((entry) => entry.property), []);

  const lr = build('vertical-lr');
  assert.equal(lr.deck.slides[0].elements[0].vert, undefined);
  assert.deepEqual(lr.report.unsupportedDetails.map((entry) => entry.property), ['writingMode']);
});


test('visibility: collapse hides an ordinary box exactly like hidden', () => {
  // CSS defines collapse as hidden outside the table layout; the silent draw was a bug.
  const build = (visibility) => pipeline.convertHtml([
    '<html><head><style>',
    '  .slide { width: 1280px; height: 720px; padding: 40px; }',
    '  .b { visibility: ' + visibility + '; width: 100px; height: 50px; background: #C05B3E; }',
    '</style></head><body><main class="slide">',
    '<div class="b">gone</div><p class="k" style="font-size: 16px;">after</p>',
    '</main></body></html>'
  ].join('\n'));

  const collapse = build('collapse');
  const hidden = build('hidden');
  const afterOf = (result) => {
    const element = result.deck.slides[0].elements.find((item) => typeof item.text === 'string' && item.text.includes('after'));
    return { y: +(element.y * 96).toFixed(1) };
  };
  // The hole is kept: the after paragraph sits at the same y whether the box is
  // collapse, hidden, or not styled at all (40 + 50 = 90 + margins).
  assert.equal(afterOf(collapse).y, afterOf(hidden).y, 'collapse keeps the same hole as hidden');
  assert.deepEqual(collapse.report.unsupportedDetails.map((entry) => entry.property), []);
});


test('preference media queries report why they cannot match', () => {
  const build = (media) => pipeline.convertHtml([
    '<html><head><style>',
    '  .slide { width: 1280px; height: 720px; padding: 40px; }',
    '  ' + media,
    '</style></head><body><main class="slide"><p class="b">x</p></main></body></html>'
  ].join('\n'));
  const reason = (result) => result.report.unsupportedDetails.find((entry) => entry.property === '@media').reason;

  assert.ok(reason(build('@media (prefers-color-scheme: dark) { .b { color: red; } }')).includes('preference'),
    'the preference query names what it reads');
  assert.ok(reason(build('@media (min-width: 5000px) { .b { color: red; } }')).includes('viewport'),
    'the size query keeps the viewport reason');
});


test('counters number the rows, literals join them', () => {
  // counter-reset/increment print through the list branch: the state is opened by
  // the reset, advanced by each item, and counter() in the content prints the value.
  const build = (cssRules, markup) => pipeline.convertHtml([
    '<html><head><style>',
    '  .slide { width: 1280px; height: 720px; padding: 40px; }',
    cssRules,
    '</style></head><body><main class="slide">',
    markup,
    '</main></body></html>'
  ].join('\n'));
  const textOf = (result) => {
    const element = result.deck.slides[0].elements[0];
    return typeof element.text === 'string' ? element.text : element.text.map((run) => run.text).join('');
  };

  const numbered = build(
    ['  ol.b { counter-reset: n; list-style: none; margin: 0; padding: 0; }',
     '  ol.b li { counter-increment: n; font-size: 16px; }',
     '  ol.b li::before { content: counter(n) ". "; }'].join('\n'),
    '<ol class="b"><li>first</li><li>second</li><li>third</li></ol>'
  );
  assert.equal(textOf(numbered), '1 . first\n2 . second\n3 . third');
  assert.deepEqual(numbered.report.unsupportedDetails.map((entry) => entry.property), []);

  // Reset start and increment step are honoured.
  const stepped = build(
    ['  ol.b { counter-reset: n 5; list-style: none; margin: 0; padding: 0; }',
     '  ol.b li { counter-increment: n 2; font-size: 16px; }',
     '  ol.b li::before { content: counter(n) ". "; }'].join('\n'),
    '<ol class="b"><li>one</li><li>two</li></ol>'
  );
  assert.equal(textOf(stepped), '7 . one\n9 . two');


  // Nested scopes: the inner ol resets h2, counters() joins the scope chain, and
  // the outer counter continues after the nested list closes.
  const nested = build(
    ['  ol.outline { counter-reset: h1; list-style: none; margin: 0; padding: 0; }',
     '  ol.outline li { font-size: 16px; }',
     '  ol.outline > li { counter-increment: h1; }',
     '  ol.outline ol { counter-reset: h2; list-style: none; margin: 0; padding-left: 20px; }',
     '  ol.outline ol > li { counter-increment: h2; }',
     '  ol.outline > li::before { content: counter(h1) ". "; }',
     '  ol.outline ol > li::before { content: counters(h2, "-") " "; }'].join('\n'),
    '<ol class="outline"><li>one<ol><li>sub-a</li><li>sub-b</li></ol></li><li>two</li></ol>'
  );
  const nestedText = typeof nested.deck.slides[0].elements[0].text === 'string'
    ? nested.deck.slides[0].elements[0].text
    : nested.deck.slides[0].elements[0].text.map((run) => run.text).join('');
  // A single scope has no joiner to apply; the separator only appears between
  // nested levels.
  assert.equal(nestedText, '1 . one1  sub-a2  sub-b2 . two');
  assert.deepEqual(nested.report.unsupportedDetails.map((entry) => entry.property), []);

  // A literal prefix still joins the line, and the arrow arrives before the words.
  const literal = build(
    ['  .b li { font-size: 16px; }',
     '  .b li::before { content: "\u2192 "; }'].join('\n'),
    '<ul class="b" style="margin: 0; padding: 0; list-style: none;"><li>\u7532</li></ul>'
  );
  assert.deepEqual(literal.report.unsupportedDetails.map((entry) => entry.property), []);
  assert.ok(textOf(literal).includes('\u2192'), 'the arrow joined the line');
});


test('open-quote and close-quote print the element quotes', () => {
  // The quote keywords resolve against the inherited `quotes` pair (the UA default
  // otherwise); they used to vanish silently.
  const build = (cssRules, markup) => pipeline.convertHtml([
    '<html><head><style>',
    '  .slide { width: 1280px; height: 720px; padding: 40px; }',
    cssRules,
    '</style></head><body><main class="slide">', markup, '</main></body></html>'
  ].join('\n'));
  const textOf = (result) => {
    const element = result.deck.slides[0].elements[0];
    return typeof element.text === 'string' ? element.text : element.text.map((run) => run.text).join('');
  };
  const propertySet = (result) => result.report.unsupportedDetails.map((entry) => entry.property);

  const custom = build(
    '  .b { quotes: "\u300A" "\u300B"; font-size: 16px; }\n'
    + '  .b q::before { content: open-quote; }\n'
    + '  .b q::after { content: close-quote; }',
    '<blockquote class="b"><q>\u5F15\u7528</q></blockquote>');
  assert.equal(textOf(custom), '\u300A\u5F15\u7528\u300B', 'the declared pair prints');
  assert.deepEqual(propertySet(custom), []);

  const defaults = build(
    '  .b { font-size: 16px; }\n'
    + '  .b q::before { content: open-quote; }\n'
    + '  .b q::after { content: close-quote; }',
    '<blockquote class="b"><q>\u5F15\u7528</q></blockquote>');
  assert.equal(textOf(defaults), '\u201C\u5F15\u7528\u201D', 'the UA default pair prints');

  // A literal pseudo on any inline still joins in source order.
  const arrow = build(
    '  .b { font-size: 16px; }\n  .b em::before { content: "\u2192"; }',
    '<p class="b">\u524D <em>\u5F3A\u8C03</em> \u540E</p>');
  assert.equal(textOf(arrow), '\u524D \u2192\u5F3A\u8C03 \u540E');
});







test('flex order and the justify grow shrink answers are native', async () => {
  // `order` reorders the runs, space-between spreads the boxes, grow divides the
  // free space - all read back from the written shapes.
  const build = (css, markup) => pipeline.convertHtml([
    '<html><head><style>',
    '  .slide { width: 1280px; height: 720px; padding: 40px; }',
    css,
    '</style></head><body><main class="slide">', markup, '</main></body></html>'
  ].join('\n'));
  const childOf = (result, text) => {
    const element = result.deck.slides[0].elements.find((item) => item.children
      && item.children.some((child) => String(child.text) === text));
    return element.children.find((item) => String(item.text) === text);
  };

  const ordered = build(
    ['  .row { display: flex; width: 600px; }',
     '  .row .a { order: 2; width: 100px; height: 40px; font-size: 14px; }',
     '  .row .b { order: 1; width: 100px; height: 40px; font-size: 14px; }'].join('\n'),
    '<div class="row"><div class="a">first-dom</div><div class="b">second-dom</div></div>'
  );
  const texts = ordered.deck.slides[0].elements[0].children.map((child) => child.text);
  assert.deepEqual(texts, ['second-dom', 'first-dom'], 'order reorders the children');

  // Positions resolve at serialization, so the spread reads back from the XML.
  const os = require('node:os');
  const path = require('node:path');
  const fs = require('node:fs');
  const JSZip = require(require.resolve('jszip', { paths: [require.resolve('../native/engine/native_pptx')] }));
  const { generatePptx } = require('../native/engine/native_pptx');
  const offsets = async (css, markup) => {
    const result = build(css, markup);
    const output = path.join(os.tmpdir(), 'native-flex-' + process.pid + '.pptx');
    try {
      await generatePptx(result.deck, output);
      const zip = await JSZip.loadAsync(fs.readFileSync(output));
      const xml = await zip.file('ppt/slides/slide1.xml').async('string');
      const pattern = /<a:off x="(\d+)"/gu;
      const xs = [];
      let match;
      while ((match = pattern.exec(xml))) xs.push(Number(match[1]) / 914400 * 96);
      return xs;
    } finally {
      if (fs.existsSync(output)) fs.unlinkSync(output);
    }
  };

  const spreadXs = await offsets(
    '  .row { display: flex; justify-content: space-between; width: 600px; }\n'
    + '  .row div { width: 100px; height: 40px; font-size: 14px; }',
    '<div class="row"><div>left</div><div>right</div></div>'
  );
  assert.equal(Number((spreadXs[2] - spreadXs[1]).toFixed(1)), 500, 'the boxes spread over the main axis');

  const grownXs = await offsets(
    '  .row { display: flex; width: 600px; }\n'
    + '  .row div { flex-grow: 1; height: 40px; font-size: 14px; }',
    '<div class="row"><div>a</div><div>b</div></div>'
  );
  assert.equal(Number((grownXs[2] - grownXs[1]).toFixed(1)), 300, 'the free space divides evenly');
});
test('z-index decides the paint order of overlapping absolutes', () => {
  // Higher z paints on top regardless of DOM order - the same stacking CSS gives. Each
  // absolute becomes a container whose background is the surface shape with a hex fill.
  const build = (zA, zC) => pipeline.convertHtml([
    '<html><head><style>',
    '  .slide { width: 1280px; height: 720px; padding: 40px; position: relative; }',
    '  .a { position: absolute; top: 40px; left: 40px; z-index: ' + zA + '; width: 200px; height: 100px; background: #17332F; font-size: 20px; }',
    '  .c { position: absolute; top: 60px; left: 60px; z-index: ' + zC + '; width: 200px; height: 100px; background: #C05B3E; font-size: 20px; }',
    '</style></head><body><main class="slide">',
    '<div class="a">dark</div>',
    '<div class="c">red</div>',
    '</main></body></html>'
  ].join('\n'));
  const fills = (result) => result.deck.slides[0].elements.map((element) => element.background && element.background.fill);

  assert.deepEqual(fills(build(1, 9)), ['17332F', 'C05B3E'], 'dark paints first');
  assert.deepEqual(fills(build(9, 1)), ['C05B3E', '17332F'], 'the paint order follows z, not the DOM');
  assert.deepEqual(build(1, 9).report.unsupportedDetails.map((entry) => entry.property), []);
});

test('mixed corner radii are named, uniform ones draw', () => {
  // A native roundRect rounds all four corners alike. Longhand zeros count: a single
  // corner declaration is already a mix, while the shorthand's repeat rules stand.
  const build = (css) => pipeline.convertHtml([
    '<html><head><style>',
    '  .slide { width: 1280px; height: 720px; padding: 40px; }',
    '  ' + css,
    '</style></head><body><main class="slide"><div class="b">x</div></main></body></html>'
  ].join('\n'));
  const notes = (result) => result.report.unsupportedDetails.filter((entry) => entry.property === 'borderRadius');

  assert.equal(notes(build('  .b { width: 120px; height: 60px; background: #C05B3E; border-top-left-radius: 16px; }')).length, 1,
    'a single corner is a mix of 16px and three zeros');
  assert.equal(notes(build('  .b { width: 120px; height: 60px; background: #C05B3E; border-radius: 16px 8px; }')).length, 1,
    'a two-value shorthand is a mix');
  assert.equal(notes(build('  .b { width: 120px; height: 60px; background: #C05B3E; border-radius: 16px; }')).length, 0,
    'a uniform shorthand draws');
  assert.equal(notes(build('  .b { width: 120px; height: 60px; background: #C05B3E; border-top-left-radius: 16px; border-top-right-radius: 16px; border-bottom-right-radius: 16px; border-bottom-left-radius: 16px; }')).length, 0,
    'four equal longhands draw');
});


test('eight-digit hex carries its alpha', () => {
  // #RRGGBBAA is standard CSS. The alpha channel becomes transparency on shapes and in
  // gradient stops; the parser used to reject the whole colour.
  const build = (css) => pipeline.convertHtml([
    '<html><head><style>',
    '  .slide { width: 1280px; height: 720px; padding: 40px; }',
    css,
    '</style></head><body><main class="slide"><div class="b">x</div></main></body></html>'
  ].join('\n'));
  const surfaceOf = (result) => {
    const element = result.deck.slides[0].elements[0];
    return element.background || element;
  };

  const solid = surfaceOf(build('  .b { width: 200px; height: 100px; background: #C05B3E66; font-size: 16px; }'));
  assert.equal(solid.fill, 'C05B3E');
  assert.equal(solid.fillTransparency, 60, '40% alpha means 60% transparency');

  const overlay = pipeline.convertHtml([
    '<html><head><style>',
    '  .slide { width: 1280px; height: 720px; padding: 40px; position: relative; }',
    '  .b { position: relative; width: 200px; height: 100px; font-size: 16px; }',
    '  .b::before { content: ""; position: absolute; top: 0; left: 0; width: 100%; height: 100%;',
    '    background: linear-gradient(#C05B3E66, #17332F33); }',
    '</style></head><body><main class="slide"><div class="b">overlay</div></main></body></html>'
  ].join('\n'));
  const shape = overlay.deck.slides[0].elements.find((element) => element.gradient);
  assert.ok(shape, 'the gradient overlay is a shape');
  assert.deepEqual(shape.gradient.stops.map((stop) => stop.transparency), [60, 80]);
  assert.deepEqual(overlay.report.unsupportedDetails.map((entry) => entry.property), []);
});


test('picture opacity lands as alphaModFix', async () => {
  // CSS opacity on a picture is the native alphaModFix; it used to be dropped silently.
  const os = require('node:os');
  const path = require('node:path');
  const fs = require('node:fs');
  const JSZip = require(require.resolve('jszip', { paths: [require.resolve('../native/engine/native_pptx')] }));
  const { generatePptx } = require('../native/engine/native_pptx');
  const result = pipeline.convertHtml([
    '<html><head><style>',
    '  .slide { width: 1280px; height: 720px; padding: 40px; }',
    '  .b { width: 100px; height: 80px; opacity: 0.5; object-fit: cover; }',
    '</style></head><body><main class="slide">',
    '<img class="b" src="data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==">',
    '</main></body></html>'
  ].join('\n'));
  assert.deepEqual(result.report.unsupportedDetails.map((entry) => entry.property), []);
  const output = path.join(os.tmpdir(), 'native-imgop-' + process.pid + '.pptx');
  try {
    await generatePptx(result.deck, output);
    const zip = await JSZip.loadAsync(fs.readFileSync(output));
    const xml = await zip.file('ppt/slides/slide1.xml').async('string');
    assert.ok(/alphaModFix amt="50000"/u.test(xml), '50% opacity = 50000 alpha');
  } finally {
    if (fs.existsSync(output)) fs.unlinkSync(output);
  }
});


test('an oversized absolute picture in a clipping frame becomes a crop', async () => {
  // overflow: hidden + an absolute picture larger than its frame is the crop idiom. The
  // visible part is an intersection; the native spelling is a crop rectangle in source
  // fractions. The picture used to draw past its frame with no clip and no report.
  const os = require('node:os');
  const path = require('node:path');
  const fs = require('node:fs');
  const JSZip = require(require.resolve('jszip', { paths: [require.resolve('../native/engine/native_pptx')] }));
  const { generatePptx } = require('../native/engine/native_pptx');
  const result = pipeline.convertHtml([
    '<html><head><style>',
    '  .slide { width: 1280px; height: 720px; padding: 40px; }',
    '  .frame { position: relative; width: 300px; height: 200px; overflow: hidden; border-radius: 10px; }',
    '  .frame img { position: absolute; left: -50px; top: -30px; width: 420px; height: 280px; }',
    '</style></head><body><main class="slide">',
    '<div class="frame"><img src="stress-photo.png"></div>',
    '</main></body></html>'
  ].join('\n'));
  const image = result.deck.slides[0].elements[0];
  assert.equal(image.fit, 'crop', 'the fit names the crop');
  // The fractions come from layout inches, so they carry float noise; compare with
  // a tolerance.
  assert.ok(Math.abs(image.crop.left - 50 / 420) < 1e-6, 'left crop = 50px of 420');
  assert.ok(Math.abs(image.crop.top - 30 / 280) < 1e-6, 'top crop = 30px of 280');
  assert.ok(Math.abs(image.crop.right - 70 / 420) < 1e-6, 'right crop = 70px of 420');
  assert.ok(Math.abs(image.crop.bottom - 50 / 280) < 1e-6, 'bottom crop = 50px of 280');
  assert.equal(Number((image.w * 96).toFixed(1)), 300, 'the picture is the frame size');
  // Rebase the relative url onto the fixture directory, as the CLI does.
  const imageWalk = (element) => {
    if (element.type === 'image' && element.path && !path.isAbsolute(element.path)) {
      element.path = path.join(__dirname, '..', 'examples', element.path);
    }
    (element.children || []).forEach(imageWalk);
  };
  result.deck.slides.forEach((slide) => (slide.elements || []).forEach(imageWalk));
  const output = path.join(os.tmpdir(), 'native-crop-' + process.pid + '.pptx');
  try {
    await generatePptx(result.deck, output);
    const zip = await JSZip.loadAsync(fs.readFileSync(output));
    const xml = await zip.file('ppt/slides/slide1.xml').async('string');
    assert.ok(/<a:srcRect l="11905" t="10714" r="16667" b="17857"\/>/u.test(xml),
      'the written srcRect carries the crop fractions');
  } finally {
    if (fs.existsSync(output)) fs.unlinkSync(output);
  }
});


test('pre and pre-wrap keep their runs of spaces', () => {
  // The collapse is a normal-mode rule; pre* contexts preserve both the spaces and the
  // line breaks, and the written run keeps them (PptxGenJS holds the text verbatim).
  const build = (whiteSpace) => pipeline.convertHtml([
    '<html><head><style>',
    '  .slide { width: 1280px; height: 720px; padding: 40px; }',
    '  .b { white-space: ' + whiteSpace + '; font-size: 16px; }',
    '</style></head><body><main class="slide">',
    '<p class="b">double  space\nnewline</p>',
    '</main></body></html>'
  ].join('\n'));

  const preserved = build('pre');
  const element = preserved.deck.slides[0].elements[0];
  const text = typeof element.text === 'string' ? element.text : element.text.map((run) => run.text).join('');
  assert.ok(text.includes('double  space'), 'the spaces survive: ' + JSON.stringify(text));
  assert.deepEqual(preserved.report.unsupportedDetails.map((entry) => entry.property), []);

  const wrapped = build('pre-wrap');
  assert.deepEqual(wrapped.report.unsupportedDetails.map((entry) => entry.property), [],
    'pre-wrap is translated the same way');

  const normal = build('normal');
  const normalElement = normal.deck.slides[0].elements[0];
  const normalText = typeof normalElement.text === 'string'
    ? normalElement.text
    : normalElement.text.map((run) => run.text).join('');
  assert.ok(!normalText.includes('double  space'), 'normal mode still collapses');
});


test('the report tallies the roles a page translated into', () => {
  // A reader of the report sees what the structure became - title, body, cards - not
  // just raw shape counts.
  const result = pipeline.convertHtml([
    '<html><head><style>',
    '  .slide { width: 1280px; height: 720px; padding: 48px; background: #F7F5F1; }',
    '  h1 { font-size: 40px; color: #10303A; margin: 0 0 12px; }',
    '  .lede { font-size: 15px; color: #4A5A5E; width: 720px; }',
    '  .card { width: 240px; padding: 18px; background: #FFFFFF; border-radius: 12px; }',
    '  .card h3 { font-size: 16px; color: #1D2A2E; margin: 0 0 8px; }',
    '  .card p { font-size: 12px; color: #566; margin: 0; }',
    '</style></head><body><main class="slide">',
    '<h1>季度经营回顾</h1>',
    '<p class="lede">四项关键指标全面达标。</p>',
    '<div class="card"><h3>新签客户</h3><p>46 家。</p></div>',
    '</main></body></html>'
  ].join('\n'));
  assert.equal(result.report.roles.title, 1);
  assert.equal(result.report.roles.body, 1);
  assert.equal(result.report.roles.heading, 1);
  assert.equal(result.report.roles.caption, 1);
  assert.equal(result.report.textElements >= 4, true);
});


test('header cell colours become the series palette', () => {
  // A design that paints each column header gives the chart its series colours; the
  // analyzer reads them in series order. Without this the chart silently fell back to
  // the theme palette.
  const result = pipeline.convertHtml([
    '<html><head><style>',
    '  .slide { width: 1280px; height: 720px; padding: 48px; }',
    '  .chart { width: 640px; height: 360px; }',
    '  .s1 { color: #1C4B57; } .s2 { color: #D98A4B; } .s3 { color: #7A9E93; }',
    '</style></head><body><main class="slide">',
    '<div class="chart" data-chart="bar">',
    '  <table>',
    '    <tr><th>Q</th><th class="s1">A</th><th class="s2">B</th><th class="s3">C</th></tr>',
    '    <tr><td>Q1</td><td>1</td><td>2</td><td>3</td></tr>',
    '    <tr><td>Q2</td><td>4</td><td>5</td><td>6</td></tr>',
    '  </table>',
    '</div>',
    '</main></body></html>'
  ].join('\n'));
  const chart = result.deck.slides[0].elements.find((element) => element.type === 'chart');
  assert.deepEqual(chart.options.chartColors, ['1C4B57', 'D98A4B', '7A9E93']);
  assert.deepEqual(result.report.unsupportedDetails.map((entry) => entry.property), []);
  // An explicit data-chart-colors still wins (it is the more specific spelling).
  const explicit = pipeline.convertHtml([
    '<html><head><style>',
    '  .slide { width: 1280px; height: 720px; padding: 48px; }',
    '  .chart { width: 640px; height: 360px; }',
    '  .s1 { color: #1C4B57; }',
    '</style></head><body><main class="slide">',
    '<div class="chart" data-chart="bar" data-chart-colors="#D98A4B,#1C4B57">',
    '  <table>',
    '    <tr><th>Q</th><th class="s1">A</th><th>B</th></tr>',
    '    <tr><td>Q1</td><td>1</td><td>2</td></tr>',
    '    <tr><td>Q2</td><td>4</td><td>5</td></tr>',
    '  </table>',
    '</div>',
    '</main></body></html>'
  ].join('\n'));
  const explicitChart = explicit.deck.slides[0].elements.find((element) => element.type === 'chart');
  assert.deepEqual(explicitChart.options.chartColors, ['D98A4B', '1C4B57'],
    'the attribute keeps the final say');
});


test('an unknown chart attribute is named, not dropped', () => {
  // A typo in a styling attribute (data-chart-value-labels) is a silently lost style;
  // the sweep names it while every real attribute stays silent.
  const result = pipeline.convertHtml([
    '<html><head><style>',
    '  .slide { width: 1280px; height: 720px; padding: 48px; }',
    '  .chart { width: 640px; height: 360px; }',
    '</style></head><body><main class="slide">',
    '<div class="chart" data-chart="bar" data-chart-legend="bottom" data-chart-value-labels="true">',
    '  <table><tr><th>Q</th><th>A</th></tr><tr><td>Q1</td><td>128</td></tr></table>',
    '</div>',
    '</main></body></html>'
  ].join('\n'));
  const notes = result.report.unsupportedDetails.map((entry) => entry.property);
  assert.deepEqual(notes, ['data-chart-value-labels'], JSON.stringify(notes));
  // Known attributes, correctly spelled, stay silent.
  const clean = pipeline.convertHtml([
    '<html><head><style>',
    '  .slide { width: 1280px; height: 720px; padding: 48px; }',
    '  .chart { width: 640px; height: 360px; }',
    '</style></head><body><main class="slide">',
    '<div class="chart" data-chart="bar" data-chart-legend="bottom" data-chart-grid="true" data-chart-text-color="#10303A">',
    '  <table><tr><th>Q</th><th>A</th></tr><tr><td>Q1</td><td>128</td></tr></table>',
    '</div>',
    '</main></body></html>'
  ].join('\n'));
  assert.deepEqual(clean.report.unsupportedDetails.map((entry) => entry.property), []);
});


test('the table border draws its perimeter', () => {
  // CSS `table { border: 2px solid }` is the outline a browser draws in
  // border-collapse mode. It used to vanish: cells read only their own style. Perimeter
  // cells now take the table's edge where the cell is silent.
  const result = pipeline.convertHtml([
    '<html><head><style>',
    '  .slide { width: 1280px; height: 720px; padding: 48px; }',
    '  table { width: 400px; border: 2px solid #10303A; border-collapse: collapse; font-size: 13px; }',
    '  th,td { padding: 6px; }',
    '</style></head><body><main class="slide">',
    '<table><tr><th>H1</th><th>H2</th></tr><tr><td>a</td><td>b</td></tr></table>',
    '</main></body></html>'
  ].join('\n'));
  const table = result.deck.slides[0].elements.find((element) => element.rows);
  table.rows.forEach((row) => row.forEach((cell) => {
    const sides = Array.isArray(cell.options.border) ? cell.options.border
      : [cell.options.border, cell.options.border, cell.options.border, cell.options.border];
    // Every side draws the table's colour.
    sides.forEach((side) => {
      assert.equal(side.type, 'solid');
      assert.equal(side.color, '10303A');
    });
    // The table's 2px (1.5pt) edge lands on the perimeter sides.
    assert.ok(sides.some((side) => side.pt >= 1.4), 'the perimeter edge draws: ' + JSON.stringify(sides));
  }));
  // A cell that declares its own edge keeps it.
  const own = pipeline.convertHtml([
    '<html><head><style>',
    '  .slide { width: 1280px; height: 720px; padding: 48px; }',
    '  table { width: 400px; border: 2px solid #10303A; border-collapse: collapse; font-size: 13px; }',
    '  th,td { padding: 6px; }',
    '  td.special { border-bottom: 4px solid #D98A4B; }',
    '</style></head><body><main class="slide">',
    '<table><tr><th>H1</th><th>H2</th></tr><tr><td class="special">a</td><td>b</td></tr></table>',
    '</main></body></html>'
  ].join('\n'));
  const ownTable = own.deck.slides[0].elements.find((element) => element.rows);
  const special = ownTable.rows[1][0].options.border;
  const borders = Array.isArray(special) ? special : [special, special, special, special];
  assert.equal(borders[2].color, 'D98A4B', 'the cell keeps its own bottom edge');
});


test('percentage line-height is a font multiple', () => {
  // 150% of a 16px font is 24px: a 1.5 multiple of the element's own size. The percent
  // case used to fall through to the default multiple (1.25) because a box-relative
  // percent has no basis here - a silent 17% tighter leading.
  const build = (lineHeight) => pipeline.convertHtml([
    '<html><head><style>',
    '  .slide { width: 1280px; height: 720px; padding: 40px; }',
    '  .b { font-size: 16px; line-height: ' + lineHeight + '; }',
    '</style></head><body><main class="slide"><p class="b">text</p></main></body></html>'
  ].join('\n'));
  assert.equal(build('150%').deck.slides[0].elements[0].lineSpacingMultiple, 1.5);
  assert.equal(build('200%').deck.slides[0].elements[0].lineSpacingMultiple, 2);
  assert.equal(build('1.8').deck.slides[0].elements[0].lineSpacingMultiple, 1.8);
  assert.equal(build('32px').deck.slides[0].elements[0].lineSpacingMultiple, 2);
});


test('margin auto centers a flex item in the line slack', async () => {
  // `margin: 0 auto` on a flex item absorbs the line slack: both margins split it,
  // which centers a declared-width item. The row path read auto margins as zero and
  // drew the item at the line start.
  const os = require('node:os');
  const path = require('node:path');
  const fs = require('node:fs');
  const JSZip = require(require.resolve('jszip', { paths: [require.resolve('../native/engine/native_pptx')] }));
  const { generatePptx } = require('../native/engine/native_pptx');
  const offsets = async (marginCss) => {
    const result = pipeline.convertHtml([
      '<html><head><style>',
      '  .slide { width: 1280px; height: 720px; padding: 40px; }',
      '  .row { display: flex; width: 600px; }',
      '  .b { ' + marginCss + ' width: 100px; height: 40px; font-size: 14px; }',
      '</style></head><body><main class="slide">',
      '<div class="row"><div class="b">c</div></div>',
      '</main></body></html>'
    ].join('\n'));
    const output = path.join(os.tmpdir(), 'native-ma-' + process.pid + '.pptx');
    try {
      await generatePptx(result.deck, output);
      const zip = await JSZip.loadAsync(fs.readFileSync(output));
      const xml = await zip.file('ppt/slides/slide1.xml').async('string');
      const pattern = /<a:off x="(-?\d+)"/gu;
      const xs = [];
      let match;
      while ((match = pattern.exec(xml))) xs.push(Number(match[1]) / 914400 * 96);
      return xs;
    } finally {
      if (fs.existsSync(output)) fs.unlinkSync(output);
    }
  };
  // The child's absolute x: 40px slide padding + 250px of slack before it.
  const centered = await offsets('margin: 0 auto;');
  assert.equal(Number((centered[centered.length - 1]).toFixed(1)), 290,
    'the item centers: 40px padding + 250px slack, got ' + centered[centered.length - 1]);
  const pushed = await offsets('margin-left: auto;');
  assert.equal(Number((pushed[pushed.length - 1]).toFixed(1)), 540,
    'a single auto margin takes the whole slack: 40 + 500');
});


test('a variable weight between 501 and 599 is named', () => {
  // 550 is a real semibold in CSS; the deck has no intermediate weight, so it draws as
  // regular. Silence would read as "no weight was asked for".
  const build = (weight) => pipeline.convertHtml([
    '<html><head><style>',
    '  .slide { width: 1280px; height: 720px; padding: 40px; }',
    '  .b { font-weight: ' + weight + '; font-size: 16px; }',
    '</style></head><body><main class="slide"><p class="b">x</p></main></body></html>'
  ].join('\n'));
  assert.equal(build('550').report.unsupportedDetails.filter((entry) => entry.property === 'fontWeight').length, 1);
  assert.deepEqual(build('600').report.unsupportedDetails.map((entry) => entry.property), [], '600 maps to bold');
  // A light weight used to be drawn as regular in silence; regular is heavier than the
  // design asked for, so it is named with the way out: a Light family in font-family.
  const light = build('300').report.unsupportedDetails.filter((entry) => entry.property === 'fontWeight');
  assert.equal(light.length, 1, 'a light weight is named');
  assert.match(light[0].reason, /Light family/u, light[0].reason);
  assert.deepEqual(build('400').report.unsupportedDetails.map((entry) => entry.property), [], 'regular is exact');
});


test('vertical glyph defaults stay silent, alternatives are named', () => {
  // `text-orientation: mixed` is the initial value and what eaVert already does (CJK
  // upright, Latin rotated): an equivalent implementation, so it stays silent. The
  // alternatives change Latin behaviour and are named. `list-style-position: inside`
  // has no native spelling either - the bullet always hangs.
  const build = (css) => pipeline.convertHtml([
    '<html><head><style>',
    '  .slide { width: 1280px; height: 720px; padding: 40px; }',
    css,
    '</style></head><body><main class="slide"><p class="b">縦書き Latin</p></main></body></html>'
  ].join('\n'));
  assert.deepEqual(build('  .b { writing-mode: vertical-rl; text-orientation: mixed; font-size: 16px; height: 200px; }')
    .report.unsupportedDetails.map((entry) => entry.property), []);
  const upright = build('  .b { writing-mode: vertical-rl; text-orientation: upright; font-size: 16px; height: 200px; }');
  assert.equal(upright.report.unsupportedDetails.filter((entry) => entry.property === 'textOrientation').length, 1);
  const list = pipeline.convertHtml([
    '<html><head><style>',
    '  .slide { width: 1280px; height: 720px; padding: 40px; }',
    '  .b { list-style-position: inside; font-size: 16px; }',
    '</style></head><body><main class="slide"><ul class="b"><li>项一</li></ul></main></body></html>'
  ].join('\n'));
  const note = list.report.unsupportedDetails.find((entry) => entry.property === 'listStylePosition');
  assert.ok(note.reason.includes('hang'), 'the reason names the real limitation: ' + note.reason);
});


test('a background picture behind text draws as image-under-text', () => {
  // The scrim idiom with a photo instead of a gradient: `background: url(...) no-repeat
  // center` on a text box. The layer used to vanish (a naive split(';') first cut the
  // data URI at its payload semicolons, then the text kind never consulted the layer).
  const analysis = analyzer.analyzeHtml([
    '<html><head><style>',
    '  .slide { width: 1280px; height: 720px; padding: 40px; }',
    '  .b { width: 300px; height: 120px; background: url("data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==") no-repeat center; font-size: 14px; }',
    '</style></head><body><main class="slide"><div class="b">bg text</div></main></body></html>'
  ].join('\n'));
  const textNode = analysis.slides[0].nodes.find((entry) => entry.kind === 'text');
  assert.ok(textNode.bgImage && textNode.bgImage.src.startsWith('data:image/png'), 'the layer travels with the text node');
  const deck = pipeline.convertHtml([
    '<html><head><style>',
    '  .slide { width: 1280px; height: 720px; padding: 40px; }',
    '  .b { width: 300px; height: 120px; background: url("data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==") no-repeat center; font-size: 14px; }',
    '</style></head><body><main class="slide"><div class="b">bg text</div></main></body></html>'
  ].join('\n'));
  const container = deck.deck.slides[0].elements[0];
  assert.deepEqual(container.children.map((child) => child.type), ['image', 'text'],
    'the image element paints beneath the text, both editable');
});

test('data URIs survive declaration parsing', () => {
  // `background: url("data:image/png;base64,...")` carries semicolons inside the value;
  // the naive split cut the payload and silently lost the layer.
  const sheet = css.parseStylesheet('.b { background-image: url("data:image/png;base64,AAAA"); color: red; }');
  const declarations = sheet.rules[0].declarations;
  assert.equal(declarations.length, 2);
  assert.match(declarations[0].value, /base64,AAAA/);
  assert.equal(declarations[1].value, 'red');
});


test('column-span: all is named where it changes the design', () => {
  // Inside a multicol container, a spanning child pulls itself out of the column flow.
  // The native text box wraps every paragraph with no exemptions, so the design is
  // named; outside multicol the declaration is a no-op and stays silent.
  const build = (css) => pipeline.convertHtml([
    '<html><head><style>',
    '  .slide { width: 1280px; height: 720px; padding: 40px; }',
    css,
    '</style></head><body><main class="slide">',
    '<div class="b"><h3>标题</h3><p>栏内文本内容，足够长以形成换行与两栏排布的效果。</p></div>',
    '</main></body></html>'
  ].join('\n'));
  const multicol = build('  .b { columns: 2; width: 500px; font-size: 14px; } .b h3 { column-span: all; font-size: 16px; }');
  const spanNote = multicol.report.unsupportedDetails.find((entry) => entry.reason.includes('span every column'));
  assert.ok(spanNote, 'the design is named: ' + JSON.stringify(multicol.report.unsupportedDetails));
  const outside = build('  .b { font-size: 14px; } .b h3 { column-span: all; font-size: 16px; }');
  assert.deepEqual(outside.report.unsupportedDetails.map((entry) => entry.property), [],
    'outside multicol the declaration does nothing, so it stays silent');
});


test('a closed details keeps its content collapsed', () => {
  // The browser hides the content of a closed <details>; the deck drew it anyway -
  // words the mock does not show.
  const result = pipeline.convertHtml([
    '<html><head><style>',
    '  .slide { width: 1280px; height: 720px; padding: 40px; font-size: 14px; }',
    '</style></head><body><main class="slide">',
    '<details><summary>标题</summary>内容正文</details>',
    '<details open><summary>打开</summary>显示正文</details>',
    '</main></body></html>'
  ].join('\n'));
  const texts = [];
  const walk = (element) => {
    if (element.text) texts.push(String(Array.isArray(element.text) ? element.text.map((run) => run.text).join('') : element.text));
    (element.children || []).forEach(walk);
  };
  result.deck.slides[0].elements.forEach(walk);
  const joined = texts.join('');
  assert.ok(joined.includes('标题') && !joined.split('打开')[0].includes('内容正文'), 'the collapsed content stays hidden');
  assert.ok(joined.includes('显示正文'), 'the open details keeps its content');
});

test('a list nested without an li still renders its items', () => {
  // Loose markup nests one list directly inside another; the browser renders the
  // items, and the walk silently dropped them.
  const result = pipeline.convertHtml([
    '<html><head><style>',
    '  .slide { width: 1280px; height: 720px; padding: 40px; font-size: 14px; }',
    '</style></head><body><main class="slide">',
    '<ul><li>外</li><ul><ol><li>内一</li></ol></ul></ul>',
    '</main></body></html>'
  ].join('\n'));
  const element = result.deck.slides[0].elements[0];
  const nested = element.text.find((run) => run.text === '内一');
  assert.ok(nested, 'the loosely nested item survives');
  assert.equal(nested.options.indentLevel, 2, 'two levels in');
  assert.equal(nested.options.bullet.type, 'number', 'and counts like its ol');
});

test('nested lists draw the markers the browser draws, level by level', async () => {
  // The browser's own stylesheet nests markers: a ul inside a list is a hollow circle,
  // two deep a square, an ol keeps counting - and a marker declared on a list wins over
  // that default, including `list-style: none`, which switches the marker off. Chrome was
  // asked for each of these and answered; the deck now writes the same shapes.
  const JSZip = require(require.resolve('jszip', { paths: [require.resolve('../native/engine/native_pptx')] }));
  const fs = require('node:fs');
  const os = require('node:os');
  const path = require('node:path');
  const { generatePptx } = require('../native/engine/native_pptx');
  const build = (body) => pipeline.convertHtml([
    '<html><head><style>',
    '  .slide { width: 1280px; height: 720px; padding: 40px; }',
    '  li { font-size: 18px; }',
    '</style></head><body><main class="slide">' + body + '</main></body></html>'
  ].join('\n'));
  const marks = async (body) => {
    const result = build(body);
    const output = path.join(os.tmpdir(), 'native-markers-' + process.pid + '.pptx');
    await generatePptx(result.deck, output);
    const zip = await JSZip.loadAsync(fs.readFileSync(output));
    const xml = await zip.file('ppt/slides/slide1.xml').async('string');
    fs.rmSync(output, { force: true });
    const found = [...xml.matchAll(/<a:(buChar|buAutoNum|buNone)([^>]*)>/gu)].map((match) => {
      const char = /char="&#x([0-9A-F]+);"/u.exec(match[2]);
      if (char) return String.fromCodePoint(parseInt(char[1], 16));
      if (match[1] === 'buNone') return 'none';
      const start = /startAt="(\d+)"/u.exec(match[2]);
      return 'number' + (start ? ':' + start[1] : '');
    });
    return { found, report: result.report };
  };

  const depths = await marks('<ul><li>一<ul><li>二<ul><li>三<ul><li>四</li></ul></li></ul></li></ul></li></ul>');
  assert.deepEqual(depths.found, ['\u2022', '\u25CB', '\u25AA', '\u25AA'],
    'solid, hollow, square, square: ' + depths.found.join(' '));
  assert.deepEqual(depths.report.unsupportedDetails.map((entry) => entry.property), []);

  const declaredOuter = await marks('<ul style="list-style-type: square"><li>一<ul><li>二</li></ul></li></ul>');
  assert.deepEqual(declaredOuter.found, ['\u25AA', '\u25CB'],
    'the outer marker is declared; the nested list takes the browser default');

  const declaredInner = await marks('<ul><li>一<ul style="list-style-type: square"><li>二</li></ul></li></ul>');
  assert.deepEqual(declaredInner.found, ['\u2022', '\u25AA'], 'a marker declared on the nested list wins');

  const switchedOff = await marks('<ul><li>一<ul style="list-style: none"><li>二</li></ul></li></ul>');
  assert.deepEqual(switchedOff.found, ['\u2022', 'none'],
    'the shorthand switches the nested marker off instead of letting the default win');
  // A paragraph with no marker still sits at its level: the writer zeroes marL when the
  // bullet is off, which parked the words at the left edge while the browser keeps them
  // under their parent. The patch puts the writer's own 27pt level margin back.
  const levelOff = (await (async () => {
    const result = build('<ul><li>一<ul style="list-style: none"><li>二</li></ul></li></ul>');
    const output = path.join(os.tmpdir(), 'native-level-' + process.pid + '.pptx');
    await generatePptx(result.deck, output);
    const zip = await JSZip.loadAsync(fs.readFileSync(output));
    const xml = await zip.file('ppt/slides/slide1.xml').async('string');
    fs.rmSync(output, { force: true });
    return /<a:pPr[^>]*lvl="1"[^>]*marL="(\d+)"/u.exec(xml);
  })());
  assert.ok(levelOff, 'the marker-off paragraph carries its level');
  // The writer's own bulleted paragraph uses `27pt + 27pt * level`, so level 1 sits one full
  // margin past the level-0 text rather than at it.
  assert.equal(levelOff[1], '685800', 'and two 27pt margins below the box: ' + (levelOff && levelOff[1]));

  const counted = await marks('<ol><li>一</li><li value="7">七</li></ol>');
  assert.deepEqual(counted.found, ['number:1', 'number:7'], 'value="7" starts that item at seven');

  const picture = await marks('<ul style="list-style: url(a.png) disc"><li>一</li></ul>');
  assert.ok(picture.report.unsupportedDetails.some((entry) => entry.property === 'listStyleImage'),
    'a marker drawn from an image is named');
});

test('a nested list keeps its own marker language', () => {
  // The browser switches markers per level: an ol inside a ul counts, a ul inside
  // an ol rounds. The deck stamped the outer marker on every line.
  const result = pipeline.convertHtml([
    '<html><head><style>',
    '  .slide { width: 1280px; height: 720px; padding: 40px; font-size: 14px; }',
    '</style></head><body><main class="slide">',
    '<ol><li>外一</li><li>外二<ul><li>内一</li></ul></li></ol>',
    '</main></body></html>'
  ].join('\n'));
  const element = result.deck.slides[0].elements[0];
  const nested = element.text.find((run) => run.text === '内一');
  assert.ok(nested, 'the nested item is its own paragraph');
  assert.equal(nested.options.indentLevel, 1, 'one level in');
  // Chrome was asked what a ul nested in a list draws: a hollow circle at the first
  // level and a square below that (u1 disc, u2 circle, u3 square, u4 square). The deck
  // used to stamp the solid round bullet on every depth.
  assert.equal(nested.options.bullet.code, '25CB', 'and opens up to a hollow circle');
});

test('a declared row height is a minimum, and where it is written matters', () => {
  // Chrome is the reference, measured before the code was written: tr { height: 60px }
  // gives a 60px row, td { height: 60px } gives 60px of content plus the cell's 6px padding
  // either side (72px), a height smaller than the content is ignored, and a <thead> row
  // honours its own height.
  const build = (markup) => pipeline.convertHtml([
    '<html><head><style>',
    '  .slide { width: 1280px; height: 720px; padding: 40px; }',
    '  table { width: 800px; font-size: 13px; border-collapse: collapse; }',
    '  td, th { padding: 6px 8px; }',
    '</style></head><body><main class="slide">',
    markup,
    '</main></body></html>'
  ].join('\n'));
  const rows = (markup) => {
    const table = build(markup).deck.slides[0].elements.filter((entry) => entry.type === 'table')[0];
    return table.options.rowH.map((inches) => Math.round(inches * 96));
  };

  assert.equal(rows('<table><tr style="height: 60px"><td>a</td></tr><tr><td>b</td></tr></table>')[0], 60,
    'a row height is the row box');
  assert.equal(rows('<table><tr><td style="height: 60px">a</td></tr></table>')[0], 72,
    'a cell height is a content height, so the padding is added');
  assert.equal(rows('<table><tr><td style="height: 60px; box-sizing: border-box;">a</td></tr></table>')[0], 60,
    'border-box already includes it');
  const header = '<table><thead><tr style="height: 44px"><th>a</th></tr></thead>'
    + '<tbody><tr><td>b</td></tr></tbody></table>';
  assert.equal(rows(header)[0], 44, 'a header row keeps its height');
  const small = rows('<table><tr style="height: 10px"><td>内容更高的一行文字 taller than ten pixels</td></tr></table>')[0];
  assert.ok(small > 20, 'a height smaller than the content is ignored, got ' + small + 'px');
});

test('a <col> width and a cell width share the table', () => {
  // The two ways to declare a column used to be exclusive: one <col> width made the
  // first-row cell widths invisible, so the rest of the columns were split equally.
  // Chrome on the fixture in examples/pipeline-table.html measures 200 / 148 / 552 for a
  // 900px fixed table with <col> 200px, a header cell of 120px content width and 14px
  // padding either side, and one column left open.
  const result = pipeline.convertHtml([
    '<html><head><style>',
    '  .slide { width: 1280px; height: 720px; padding: 40px; }',
    '  * { box-sizing: border-box; }',
    '  table { width: 900px; table-layout: fixed; border-collapse: collapse; font-size: 13px; }',
    '  td, th { padding: 11px 14px; }',
    '</style></head><body><main class="slide">',
    '<table><colgroup><col style="width: 200px"></colgroup>',
    '<tr><th>项目</th><th style="width: 120px; box-sizing: content-box">状态</th><th>备注</th></tr>',
    '<tr><td>a</td><td>b</td><td>c</td></tr></table>',
    '</main></body></html>'
  ].join('\n'));
  const table = result.deck.slides[0].elements.filter((entry) => entry.type === 'table')[0];
  assert.deepEqual(table.options.colW.map((inches) => Math.round(inches * 96)), [200, 148, 552],
    'the <col> width, the content width plus padding, and the rest');
  assert.deepEqual(result.report.unsupportedDetails, []);
});

test('a cell width is a content width, whatever its borders do', () => {
  // Chrome is the reference and the numbers below were measured in it: a 200px cell with
  // 6px/8px padding draws a 216px column, 217px when it carries a 1px collapsed border,
  // 218px when the borders are separate, 220px for 2px separate borders, and exactly 200px
  // either with box-sizing: border-box or when the width comes from a <col>.
  const build = (markup, cellCss, tableCss) => pipeline.convertHtml([
    '<html><head><style>',
    '  .slide { width: 1280px; height: 720px; padding: 40px; }',
    '  table { width: 800px; font-size: 13px; ' + (tableCss || 'border-collapse: collapse;') + ' }',
    '  td, th { padding: 6px 8px; }',
    cellCss || '',
    '</style></head><body><main class="slide">',
    markup,
    '</main></body></html>'
  ].join('\n'));
  const cell = (style) => '<table><tr><th style="' + style + '">甲</th><th>乙</th></tr>'
    + '<tr><td>1</td><td>2</td></tr></table>';
  const columnPx = (result) => {
    const table = result.deck.slides[0].elements.filter((entry) => entry.type === 'table')[0];
    return Math.round(table.options.colW[0] * 96 * 10) / 10;
  };

  assert.equal(columnPx(build(cell('width: 200px'))), 216, 'padding widens the column');
  assert.equal(columnPx(build(cell('width: 200px'), 'th, td { border: 1px solid #000; }')), 217,
    'a collapsed border is shared, so half of it lands here');
  const separate = build(cell('width: 200px'), 'th, td { border: 1px solid #000; }',
    'border-collapse: separate;');
  assert.equal(columnPx(separate), 218, 'separate borders are not shared');
  assert.equal(columnPx(build(cell('width: 200px'), 'th, td { border: 2px solid #000; }',
    'border-collapse: separate;')), 220);
  assert.equal(columnPx(build(cell('width: 200px; box-sizing: border-box;'),
    'th, td { border: 1px solid #000; }')), 200, 'border-box already includes them');
  assert.equal(columnPx(build('<table><colgroup><col style="width: 200px"></colgroup>'
    + '<tr><th>甲</th><th>乙</th></tr><tr><td>1</td><td>2</td></tr></table>')), 200,
    'a <col> width carries no padding');

  // A fixed-layout table whose columns ask for more room than it has is named, not silenced:
  // CSS would let the table grow, a slide cannot.
  const fixed = pipeline.convertHtml([
    '<html><head><style>',
    '  .slide { width: 1280px; height: 720px; padding: 40px; }',
    '  table { width: 800px; table-layout: fixed; border-collapse: collapse; }',
    '</style></head><body><main class="slide">',
    '<table><colgroup><col style="width: 600px"><col style="width: 600px"></colgroup>',
    '<tr><th>甲</th><th>乙</th></tr><tr><td>1</td><td>2</td></tr></table>',
    '</main></body></html>'
  ].join('\n'));
  const fixedTable = fixed.deck.slides[0].elements.filter((entry) => entry.type === 'table')[0];
  assert.deepEqual(fixedTable.options.colW.map((inches) => Math.round(inches * 100) / 100), [4.17, 4.17],
    'the proportions are kept inside the box');
  const named = fixed.report.unsupportedDetails.filter((entry) => entry.property === 'column-widths');
  assert.equal(named.length, 1, 'the overshoot is named once');
  assert.match(named[0].value, /^12\.50in of columns in a 8\.33in table$/u);
});

test('a chart wears the typography of the element around it', () => {
  // A card that sets `font-size: 12px; color: #5A6A66` used to get a chart drawn in the
  // writer's own 18pt black: legible, but not part of the page. The chart now takes the
  // face, size and colour of the element that declares it, and a <caption> on the data
  // table is the title's own style.
  const build = (style, attrs) => pipeline.convertHtml([
    '<html><head><style>',
    '  .slide { width: 1280px; height: 720px; padding: 40px; }',
    style,
    '</style></head><body><main class="slide">',
    '<table data-chart="bar" data-chart-title="t"' + (attrs || '') + '>',
    '<caption>标题</caption>',
    '<tr><th>季度</th><th>收入</th></tr><tr><td>Q1</td><td>120</td></tr>',
    '</table>',
    '</main></body></html>'
  ].join('\n'));
  const chartOf = (result) => result.deck.slides[0].elements.filter((entry) => entry.type === 'chart')[0]
    || result.deck.slides[0].elements
      .flatMap((entry) => entry.children || [])
      .filter((entry) => entry.type === 'chart')[0];

  const plain = chartOf(build('  table { font-size: 12px; }'));
  assert.equal(plain.options.titleFontSize, 9, '12px is 9pt');
  assert.equal(plain.options.catAxisLabelFontSize, 9);
  assert.equal(plain.options.titleFontColor, undefined, 'no colour declared, none invented');

  const card = chartOf(build('  .card table { font-size: 12px; color: #5A6A66; font-family: Georgia, serif; }'
    .replace('.card ', '')));
  assert.equal(card.options.titleFontFace, 'Georgia');
  assert.equal(card.options.catAxisLabelFontFace, 'Georgia');
  assert.equal(card.options.legendFontFace, 'Georgia');
  assert.equal(card.options.titleColor, '5A6A66');
  assert.equal(card.options.valAxisLabelColor, '5A6A66');
  assert.equal(card.options.legendColor, '5A6A66');
  assert.equal(card.options.chartColors, undefined,
    'an inherited neutral text colour is not a series colour');

  // The caption is the title's own style, the table is the label style.
  const withCaption = chartOf(build(
    '  table { font-size: 12px; color: #5A6A66; } caption { font-size: 15px; color: #1D6F42; }'));
  assert.equal(withCaption.options.titleFontSize, 11.3, '15px is 11.3pt');
  assert.equal(withCaption.options.catAxisLabelFontSize, 9, 'the labels keep the table size');

  // A generic family is not a face: it must not be written as a typeface.
  const generic = chartOf(build('  table { font-family: sans-serif; }'));
  assert.equal(generic.options.titleFontFace, undefined);

  // And a declared attribute still wins over the inherited style.
  const declared = chartOf(build('  table { color: #5A6A66; }',
    ' data-chart-text-color="#123456" data-chart-legend-font-size="12"'));
  assert.equal(declared.options.titleColor, '123456');
  assert.equal(declared.options.legendFontSize, 12, 'the explicit size is kept');
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

test('a background picture survives its container and paints above its own fill', async () => {
  // Two silent losses, found by rendering a card with a background picture - the slide looked
  // like plain coloured boxes. (1) `background-image` paints *above* `background-color`; the
  // picture was pushed before its own box, so the box's fill covered it. (2) A child of a
  // container cannot carry a picture - a container child has no coordinates of its own - and
  // the picture was dropped without a word. The group falls back to absolute placement now,
  // which draws the picture and the box.
  const PNG = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAABgAAAAQCAYAAAATu1kYAAAAJUlEQVR42u3NMQEAAAgDoC251a3gLzSgknB3VwEBAQEBAQEBAQEBAQEBAQHA1wABl6y0GQAAAABJRU5ErkJggg==';
  const markup = (inner) => [
    '<html><head><style>',
    '  .slide { width: 1280px; height: 720px; padding: 40px; }',
    '  .row { display: flex; gap: 20px; }',
    '  .card { width: 210px; }',
    '  .b { width: 210px; height: 120px; background-image: url(' + PNG + '); background-color: #EEF2F1; }',
    '</style></head><body><main class="slide">', inner, '</main></body></html>'
  ].join('\n');

  const flat = pipeline.convertHtml(markup('<div class="b"></div>'));
  const flatTypes = flat.deck.slides[0].elements.map((element) => element.type);
  assert.ok(flatTypes.includes('image'), 'the picture is in the deck: ' + flatTypes.join('+'));
  assert.ok(flatTypes.indexOf('image') > flatTypes.indexOf('shape'),
    'and it paints above its own fill, not under it: ' + flatTypes.join('+'));

  for (const inner of [
    '<div class="wrap"><div class="b"></div></div>',
    '<div class="row"><div class="b"></div></div>',
    '<div class="row"><div class="card"><div class="b"></div></div></div>'
  ]) {
    const nested = pipeline.convertHtml(markup(inner));
    const count = nested.deck.slides[0].elements.filter((element) => element.type === 'image').length;
    assert.equal(count, 1, 'one picture, not zero: ' + inner);
  }
});

test('a background-size that names a length draws at that length', async () => {
  // `background-size` was cover, contain, 100% 100% or nothing: anything else fell through to
  // `contain`, so `background-size: 120px` drew a 1.875in picture where the design asked for
  // 1.25in. The declared size is resolved per axis now - a length, a percentage of the box,
  // or `auto` from the source's proportions - and a picture bigger than its box is cropped to
  // the box, which is what the browser's own clipping shows.
  const PNG = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAABgAAAAQCAYAAAATu1kYAAAAJUlEQVR42u3NMQEAAAgDoC251a3gLzSgknB3VwEBAQEBAQEBAQEBAQEBAQHA1wABl6y0GQAAAABJRU5ErkJggg==';
  const JSZip = require(require.resolve('jszip', { paths: [require.resolve('../native/engine/native_pptx')] }));
  const fs = require('node:fs');
  const os = require('node:os');
  const path = require('node:path');
  const { generatePptx } = require('../native/engine/native_pptx');
  const picture = async (css) => {
    const result = pipeline.convertHtml([
      '<html><head><style>',
      '  .slide { width: 1280px; height: 720px; padding: 40px; }',
      '  div.b { width: 240px; height: 120px; background-image: url(' + PNG + '); ' + css + ' }',
      '</style></head><body><main class="slide"><div class="b"></div></main></body></html>'
    ].join('\n'));
    const output = path.join(os.tmpdir(), 'native-bgsize-' + process.pid + '.pptx');
    await generatePptx(result.deck, output);
    const zip = await JSZip.loadAsync(fs.readFileSync(output));
    const xml = await zip.file('ppt/slides/slide1.xml').async('string');
    fs.rmSync(output, { force: true });
    const pic = xml.slice(xml.indexOf('<p:pic>'), xml.indexOf('</p:pic>'));
    const offset = /<a:off x="(-?\d+)" y="(-?\d+)"\/>/u.exec(pic);
    const extent = /<a:ext cx="(\d+)" cy="(\d+)"\/>/u.exec(pic);
    const srcRect = /<a:srcRect([^/>]*)\/?>/u.exec(pic);
    const inch = (emu) => Number(emu) / 914400;
    return {
      x: inch(offset[1]), y: inch(offset[2]), w: inch(extent[1]), h: inch(extent[2]),
      crop: srcRect ? srcRect[1].trim() : ''
    };
  };
  const close = (actual, expected) => Math.abs(actual - expected) < 0.003;

  // 120px is 1.25in wide; the picture is 24x16, so the height follows at 0.833in, centred in
  // a 240x120 box that starts at 0.4167in.
  const sized = await picture('background-size: 120px;');
  assert.ok(close(sized.w, 1.25), 'width is the declared 120px: ' + sized.w);
  assert.ok(close(sized.h, 0.8333), 'height follows the source aspect: ' + sized.h);
  assert.ok(close(sized.x, 1.0417), 'centred horizontally: ' + sized.x);
  assert.ok(close(sized.y, 0.625), 'centred vertically: ' + sized.y);

  // One axis by the source, one by the design; and a percentage of the box.
  const heightOnly = await picture('background-size: auto 80px;');
  assert.ok(close(heightOnly.h, 0.8333) && close(heightOnly.w, 1.25), 'auto 80px: ' + heightOnly.w + 'x' + heightOnly.h);
  const half = await picture('background-size: 50%;');
  assert.ok(close(half.w, 1.25), 'half the box is 1.25in: ' + half.w);
  const both = await picture('background-size: 120px 80px;');
  assert.ok(close(both.w, 1.25) && close(both.h, 0.8333), 'both axes written: ' + both.w + 'x' + both.h);

  // The position still places it: right bottom puts it at the box's corner.
  const corner = await picture('background-size: 120px; background-position: right bottom;');
  assert.ok(close(corner.x, 1.6667) && close(corner.y, 0.8333), 'placed at the corner: ' + corner.x + ',' + corner.y);

  // Bigger than its box: the picture becomes the box and the browser's clipping becomes a
  // source rectangle - 300px of 240 leaves 10% cut on each side, 200px of 120 leaves 20%.
  const big = await picture('background-size: 300px;');
  assert.ok(close(big.w, 2.5) && close(big.h, 1.25), 'the drawn picture is the box: ' + big.w + 'x' + big.h);
  assert.match(big.crop, /l="10000"/u, 'a centred clip: ' + big.crop);
  assert.match(big.crop, /t="20000"/u, 'vertically too: ' + big.crop);
  const cornerClip = await picture('background-size: 300px; background-position: left top;');
  assert.match(cornerClip.crop, /l="0"/u, 'left top shows the top left: ' + cornerClip.crop);
  assert.match(cornerClip.crop, /r="20000"/u, 'and cuts the rest away: ' + cornerClip.crop);
});

test('a background picture stretches, crops and is placed like its CSS says', async () => {
  // A background picture is not an <img>, so it has its own path - and it had its own two
  // silent drops. `background-size: 100% 100%` arrived as the fit-mode spelling "stretch",
  // which the object-fit table did not know, so it fell through to a cover crop: a
  // stretched background was cropped. And a length `background-position` was read by the
  // percentage parser, which dropped the offset.
  const PNG = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAABgAAAAQCAYAAAATu1kYAAAAJUlEQVR42u3NMQEAAAgDoC251a3gLzSgknB3VwEBAQEBAQEBAQEBAQEBAQHA1wABl6y0GQAAAABJRU5ErkJggg==';
  const JSZip = require(require.resolve('jszip', { paths: [require.resolve('../native/engine/native_pptx')] }));
  const fs = require('node:fs');
  const os = require('node:os');
  const path = require('node:path');
  const { generatePptx } = require('../native/engine/native_pptx');
  const background = async (css) => {
    const result = pipeline.convertHtml([
      '<html><head><style>',
      '  .slide { width: 1280px; height: 720px; padding: 40px; }',
      '  div.b { width: 240px; height: 120px; background-image: url(' + PNG + '); ' + css + ' }',
      '</style></head><body><main class="slide"><div class="b"></div></main></body></html>'
    ].join('\n'));
    const output = path.join(os.tmpdir(), 'native-background-' + process.pid + '.pptx');
    await generatePptx(result.deck, output);
    const zip = await JSZip.loadAsync(fs.readFileSync(output));
    const xml = await zip.file('ppt/slides/slide1.xml').async('string');
    fs.rmSync(output, { force: true });
    const picture = xml.slice(xml.indexOf('<p:pic>'), xml.indexOf('</p:pic>'));
    const offset = /<a:off x="(-?\d+)" y="(-?\d+)"\/>/u.exec(picture);
    const srcRect = /<a:srcRect([^/>]*)\/?>/u.exec(picture);
    return {
      x: offset ? Number(offset[1]) / 914400 : null,
      crop: srcRect ? srcRect[1].trim() : '',
      fit: result.deck.slides[0].elements[0].fit
    };
  };

  const stretched = await background('background-size: 100% 100%;');
  assert.equal(stretched.fit, 'stretch', 'a 100% 100% background stretches, not crops');
  assert.equal(stretched.crop, '', 'and a stretched picture has nothing to crop');

  const centred = await background('background-size: cover;');
  assert.match(centred.crop, /t="12500"/u, 'cover crops from the middle: ' + centred.crop);

  const down = await background('background-size: cover; background-position: 10px 5px;');
  assert.match(down.crop, /t="9375"/u, 'a 5px offset moves the crop window: ' + down.crop);
  const up = await background('background-size: cover; background-position: -10px -5px;');
  assert.match(up.crop, /t="15625"/u, 'and the sign decides the direction: ' + up.crop);

  const placed = await background('background-size: contain; background-position: 20px 0;');
  assert.ok(Math.abs(placed.x - (0.4167 + 20 / 96)) < 0.002, 'a contained background is placed at 20px: ' + placed.x);
});

test('a length object-position crops and places the picture it names', async () => {
  // `object-position` was read as a keyword or a percentage only: a length fell through the
  // background parser as "center" and the picture was cropped from the middle in silence.
  // A length can only be read with the source size and the box in hand, so it travels to the
  // fit resolver - and it means two different things there, as it does in CSS.
  const PNG = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAABgAAAAQCAYAAAATu1kYAAAAJUlEQVR42u3NMQEAAAgDoC251a3gLzSgknB3VwEBAQEBAQEBAQEBAQEBAQHA1wABl6y0GQAAAABJRU5ErkJggg==';
  const JSZip = require(require.resolve('jszip', { paths: [require.resolve('../native/engine/native_pptx')] }));
  const fs = require('node:fs');
  const os = require('node:os');
  const path = require('node:path');
  const { generatePptx } = require('../native/engine/native_pptx');
  const picture = async (css) => {
    const result = pipeline.convertHtml([
      '<html><head><style>',
      '  .slide { width: 1280px; height: 720px; padding: 40px; }',
      '  img { width: 240px; height: 120px; }',
      css,
      '</style></head><body><main class="slide">',
      '<img src="' + PNG + '" alt="x">',
      '</main></body></html>'
    ].join('\n'));
    const output = path.join(os.tmpdir(), 'native-position-' + process.pid + '.pptx');
    await generatePptx(result.deck, output);
    const zip = await JSZip.loadAsync(fs.readFileSync(output));
    const xml = await zip.file('ppt/slides/slide1.xml').async('string');
    fs.rmSync(output, { force: true });
    const pic = xml.slice(xml.indexOf('<p:pic>'), xml.indexOf('</p:pic>'));
    const offset = /<a:off x="(-?\d+)" y="(-?\d+)"\/>/u.exec(pic);
    const srcRect = /<a:srcRect([^/>]*)\/?>/u.exec(pic);
    return {
      x: offset ? Number(offset[1]) / 914400 : null,
      y: offset ? Number(offset[2]) / 914400 : null,
      crop: srcRect ? srcRect[1].trim() : ''
    };
  };

  // A cover crop fills the box, so the offset can only mean "this far from centred": the
  // window moves by that fraction of the overflow, and the sign decides the direction.
  const centred = await picture('img { object-fit: cover; }');
  const down = await picture('img { object-fit: cover; object-position: 10px 5px; }');
  const up = await picture('img { object-fit: cover; object-position: -10px -5px; }');
  assert.match(centred.crop, /t="12500"/u, 'the default crop is centred: ' + centred.crop);
  assert.match(centred.crop, /b="12500"/u, 'top and bottom alike: ' + centred.crop);
  assert.match(down.crop, /t="9375"/u, '5px down moves the window up: ' + down.crop);
  assert.match(down.crop, /b="15625"/u, 'and takes the bottom with it: ' + down.crop);
  assert.match(up.crop, /t="15625"/u, 'and the minus sign goes the other way: ' + up.crop);
  assert.match(up.crop, /b="9375"/u, 'bottom first: ' + up.crop);

  // A contained picture is smaller than its box, so the offset is placement from the edge:
  // 20px in a 0.625in of free space lands 0.208in past the box's left edge.
  const placed = await picture('img { object-fit: contain; object-position: 20px 0; }');
  assert.ok(Math.abs(placed.x - (0.4167 + 20 / 96)) < 0.002, 'placed at 20px: ' + placed.x);
  const corner = await picture('img { object-fit: contain; object-position: left top; }');
  assert.ok(Math.abs(corner.x - 0.4167) < 0.002, 'the keyword form still lands top left: ' + corner.x);
});

test('a picture with no object-fit is stretched, the way CSS stretches it', () => {
  // CSS stretches a picture whose box does not match its proportions (`object-fit: fill` is
  // the initial value). This engine used to cover-crop instead - a designer's opinion about
  // not distorting a photo, honestly named, and still a different picture from the browser's.
  // Fidelity won: the box decides the shape, and `object-fit: cover` is how a design says
  // otherwise. Nothing is reported now, because silence is right when the drawing agrees.
  const PNG = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAgAAAAgCAYAAAA1xQ0wAAAAIklEQVR42mNkYPjPQARgZCAGjCocVTiqcFThqMJRhcNKIQBcFwIB/8K7zQAAAABJRU5ErkJggg==';
  const build = (rule) => pipeline.convertHtml([
    '<html><head><style>',
    '  .slide { width: 1280px; height: 720px; padding: 60px; }',
    '  ' + rule,
    '</style></head><body><main class="slide">',
    '<img src="' + PNG + '">',
    '</main></body></html>'
  ].join('\n'));
  const fitOf = (rule) => {
    const image = build(rule).deck.slides[0].elements.find((element) => element.type === 'image');
    return image && (image.objectFit || image.fit);
  };
  const reportOf = (rule) => build(rule).report.unsupportedDetails
    .filter((entry) => entry.property === 'objectFit');

  assert.equal(fitOf('img { width: 300px; height: 120px; }'), 'stretch',
    'an undeclared fit stretches to the box, as CSS does');
  assert.deepEqual(reportOf('img { width: 300px; height: 120px; }'), [],
    'and there is nothing to report: the drawing agrees with the CSS');
  assert.equal(fitOf('img { width: 300px; height: 120px; object-fit: cover; }'), 'cover',
    'a declared crop is the design being explicit');
  assert.equal(fitOf('img { width: 300px; height: 120px; object-fit: contain; }'), 'contain');
  assert.equal(fitOf('img { width: 300px; }'), 'stretch',
    'an auto height already takes the picture proportions');
  assert.deepEqual(reportOf('img { width: 300px; height: 120px; object-fit: sideways; }').length, 1,
    'an unknown fit is still named');
});


test('a data label position the writer cannot spell is named', () => {
  // The writer filters label positions per chart shape and deletes the rest without a
  // word, so the analyzer mirrors the rule and says what it refused. A clustered bar
  // cannot put a label outside its bar; a stacked one can.
  const build = (type, attrs) => pipeline.convertHtml([
    '<html><head><style>',
    '  .slide { width: 1280px; height: 720px; padding: 40px; }',
    '</style></head><body><main class="slide">',
    '<table data-chart="' + type + '" ' + attrs + '><tr><th>项目</th><th>甲</th></tr>',
    '<tr><td>一月</td><td>30</td></tr><tr><td>二月</td><td>50</td></tr></table>',
    '</main></body></html>'
  ].join('\n'));
  const chartOf = (result) => result.deck.slides[0].elements.find((entry) => entry.type === 'chart');

  const clustered = build('bar', 'data-chart-labels="value" data-chart-label-position="outside-end"');
  assert.equal(chartOf(clustered).options.dataLabelPosition, undefined,
    'a clustered bar has nowhere outside to put it');
  const named = clustered.report.unsupportedDetails.filter((entry) => entry.property === 'data-chart-label-position');
  assert.equal(named.length, 1, 'and the refusal is named');
  assert.match(named[0].reason, /accepts ctr\/inBase\/inEnd/u, named[0].reason);

  const stacked = build('bar', 'data-chart-labels="value" data-chart-label-position="outside-end" data-chart-grouping="stacked"');
  assert.equal(chartOf(stacked).options.dataLabelPosition, 'outEnd', 'a stacked bar can');
  assert.deepEqual(stacked.report.unsupportedDetails.map((entry) => entry.property), []);

  const pie = build('pie', 'data-chart-labels="value" data-chart-label-position="top"');
  assert.equal(chartOf(pie).options.dataLabelPosition, undefined, 'a pie has no top label');
  assert.ok(pie.report.unsupportedDetails.some((entry) => entry.property === 'data-chart-label-position'));

  const line = build('line', 'data-chart-labels="value" data-chart-label-position="top"');
  assert.equal(chartOf(line).options.dataLabelPosition, 't', 'a line can take a top label');

  // The friendly spellings are accepted at all: `outside-end` is what people type.
  const friendly = build('bar', 'data-chart-labels="value" data-chart-label-position="center"');
  assert.equal(chartOf(friendly).options.dataLabelPosition, 'ctr');
});

test('a bubble reads x, y and size, and says which columns it cannot pair', async () => {
  // A bubble needs three numbers per point: x, a y value and the size of the dot. The
  // numbers after x pair up as (y, size), so an even count of them leaves one unpaired -
  // which is named rather than read as a silently wrong series.
  const JSZip = require(require.resolve('jszip', { paths: [require.resolve('../native/engine/native_pptx')] }));
  const fs = require('node:fs');
  const os = require('node:os');
  const path = require('node:path');
  const { generatePptx } = require('../native/engine/native_pptx');
  const build = (rows) => pipeline.convertHtml([
    '<html><head><style>',
    '  .slide { width: 1280px; height: 720px; padding: 40px; }',
    '  table { width: 900px; }',
    '</style></head><body><main class="slide">',
    '<table data-chart="bubble">' + rows + '</table>',
    '</main></body></html>'
  ].join('\n'));
  const xmlOf = async (rows) => {
    const result = build(rows);
    const output = path.join(os.tmpdir(), 'native-bubble-' + process.pid + '.pptx');
    await generatePptx(result.deck, output);
    const zip = await JSZip.loadAsync(fs.readFileSync(output));
    const entry = Object.keys(zip.files).find((name) => /^ppt\/charts\/chart\d+\.xml$/u.test(name));
    const xml = entry ? await zip.file(entry).async('string') : '';
    fs.rmSync(output, { force: true });
    return { xml, report: result.report };
  };

  const one = await xmlOf('<tr><th>面积</th><th>单价</th><th>套数</th></tr>'
    + '<tr><td>60</td><td>3.2</td><td>18</td></tr>'
    + '<tr><td>90</td><td>2.8</td><td>42</td></tr>');
  assert.deepEqual(one.report.unsupportedDetails.map((entry) => entry.property), [], 'three columns read cleanly');
  assert.match(one.xml, /<c:bubbleChart>/u, 'it is a native bubble chart');
  assert.equal((one.xml.match(/<c:ser>/gu) || []).length, 1, 'one bubble series');
  assert.equal((one.xml.match(/<c:bubbleSize>/gu) || []).length, 1, 'with a size per point');
  const sizes = [...(/<c:bubbleSize>[\s\S]*?<\/c:bubbleSize>/u.exec(one.xml) || [''])[0]
    .matchAll(/<c:v>([\d.]+)<\/c:v>/gu)].map((match) => match[1]);
  assert.deepEqual(sizes, ['18', '42'], 'the third column is the size: ' + sizes.join(','));

  const two = await xmlOf('<tr><th>面积</th><th>单价</th><th>套数</th><th>租金</th><th>在租</th></tr>'
    + '<tr><td>60</td><td>3.2</td><td>18</td><td>80</td><td>5</td></tr>'
    + '<tr><td>90</td><td>2.8</td><td>42</td><td>95</td><td>9</td></tr>');
  assert.equal((two.xml.match(/<c:ser>/gu) || []).length, 2, 'five columns are two bubble series');

  const thin = await xmlOf('<tr><th>面积</th><th>单价</th></tr><tr><td>60</td><td>3.2</td></tr>');
  assert.ok(thin.report.unsupportedDetails.some((entry) => entry.property === 'data-chart'
    && /three numbers per point/u.test(entry.reason)), 'two columns cannot hold a size');

  const unpaired = await xmlOf('<tr><th>面积</th><th>单价</th><th>套数</th><th>租金</th></tr>'
    + '<tr><td>60</td><td>3.2</td><td>18</td><td>80</td></tr>');
  assert.ok(unpaired.report.unsupportedDetails.some((entry) => /pairs/u.test(entry.reason)),
    'an unpaired column is named');

  const categorical = await xmlOf('<tr><th>城市</th><th>单价</th><th>套数</th></tr>'
    + '<tr><td>上海</td><td>3.2</td><td>18</td></tr>');
  assert.ok(categorical.report.unsupportedDetails.some((entry) => /x axis/u.test(entry.reason)),
    'a category in the x column is named');
});

test('a scatter reads its first column as the x axis and draws markers', async () => {
  // A scatter plots pairs. The table's first column is therefore the x axis, the numbers
  // after it are y series, and a category in that column is a report rather than a
  // silently mis-plotted chart. The writer spells one style - lineMarker - so the file
  // is corrected to marker, which is what the word means; PowerPoint honours it.
  const JSZip = require(require.resolve('jszip', { paths: [require.resolve('../native/engine/native_pptx')] }));
  const fs = require('node:fs');
  const os = require('node:os');
  const path = require('node:path');
  const { generatePptx } = require('../native/engine/native_pptx');
  const build = (rows) => pipeline.convertHtml([
    '<html><head><style>',
    '  .slide { width: 1280px; height: 720px; padding: 40px; }',
    '  table { width: 900px; }',
    '</style></head><body><main class="slide">',
    '<table data-chart="scatter">' + rows + '</table>',
    '</main></body></html>'
  ].join('\n'));
  const xmlOf = async (result) => {
    const output = path.join(os.tmpdir(), 'native-scatter-' + process.pid + '.pptx');
    await generatePptx(result.deck, output);
    const zip = await JSZip.loadAsync(fs.readFileSync(output));
    const name = Object.keys(zip.files).find((entry) => /^ppt\/charts\/chart\d+\.xml$/u.test(entry));
    const xml = name ? await zip.file(name).async('string') : '';
    fs.rmSync(output, { force: true });
    return xml;
  };

  const paired = build('<tr><th>楼层</th><th>售价</th><th>租金</th></tr>'
    + '<tr><td>3</td><td>120</td><td>8</td></tr>'
    + '<tr><td>6</td><td>210</td><td>13</td></tr>'
    + '<tr><td>9</td><td>330</td><td>19</td></tr>');
  assert.deepEqual(paired.report.unsupportedDetails.map((entry) => entry.property), [],
    'a numeric pair needs no report');
  const xml = await xmlOf(paired);
  assert.match(xml, /<c:scatterChart>/u, 'it is a native scatter chart');
  const xValues = [...(/<c:xVal>[\s\S]*?<\/c:xVal>/u.exec(xml) || [''])[0]
    .matchAll(/<c:v>([-\d.]+)<\/c:v>/gu)].map((match) => match[1]);
  assert.deepEqual(xValues, ['3', '6', '9'], 'the first column is the x axis: ' + xValues.join(','));
  assert.equal((xml.match(/<c:ser>/gu) || []).length, 2, 'both y columns are plotted');
  assert.match(xml, /<c:scatterStyle val="marker"\/>/u, 'markers, not invented connecting lines');
  assert.ok(!xml.includes('lineMarker'), 'and not the writer default');

  const categorical = build('<tr><th>月份</th><th>售价</th><th>租金</th></tr>'
    + '<tr><td>一月</td><td>120</td><td>8</td></tr><tr><td>二月</td><td>210</td><td>13</td></tr>');
  assert.ok(categorical.report.unsupportedDetails.some((entry) => entry.property === 'data-chart'
    && /x axis/u.test(entry.reason)), 'a category in the x column is named, not plotted as zero');
});

test('column, hbar, donut and radar are names for real charts', async () => {
  // A designer writes `column`, `hbar`, `donut` or `radar`; each one is the same
  // DrawingML chart under a different name, and reporting them as unknown types turned
  // a chart into a table nobody expected.
  const JSZip = require(require.resolve('jszip', { paths: [require.resolve('../native/engine/native_pptx')] }));
  const fs = require('node:fs');
  const os = require('node:os');
  const path = require('node:path');
  const { generatePptx } = require('../native/engine/native_pptx');
  const build = (attrs) => pipeline.convertHtml([
    '<html><head><style>',
    '  .slide { width: 1280px; height: 720px; padding: 40px; }',
    '  table { width: 800px; }',
    '</style></head><body><main class="slide">',
    '<table ' + attrs + '><tr><th>项目</th><th>甲</th></tr>',
    '<tr><td>一月</td><td>30</td></tr><tr><td>二月</td><td>50</td></tr></table>',
    '</main></body></html>'
  ].join('\n'));
  const chartOf = async (attrs) => {
    const result = build(attrs);
    const output = path.join(os.tmpdir(), 'native-chart-alias-' + process.pid + '.pptx');
    await generatePptx(result.deck, output);
    const zip = await JSZip.loadAsync(fs.readFileSync(output));
    const name = Object.keys(zip.files).find((entry) => /^ppt\/charts\/chart\d+\.xml$/u.test(entry));
    const xml = name ? await zip.file(name).async('string') : '';
    fs.rmSync(output, { force: true });
    return {
      kind: (/<c:(\w+Chart)>/u.exec(xml) || [])[1] || null,
      direction: (/<c:barDir val="(\w+)"/u.exec(xml) || [])[1] || null,
      reported: result.report.unsupportedDetails.map((entry) => entry.property)
    };
  };

  const column = await chartOf('data-chart="column"');
  assert.equal(column.kind, 'barChart', 'column is a bar chart');
  assert.equal(column.direction, 'col', 'with upright columns');
  assert.deepEqual(column.reported, [], 'and nothing to report');

  const horizontal = await chartOf('data-chart="hbar"');
  assert.equal(horizontal.direction, 'bar', 'hbar lies down');

  const overridden = await chartOf('data-chart="column" data-chart-dir="bar"');
  assert.equal(overridden.direction, 'bar', 'an explicit direction still wins');

  assert.equal((await chartOf('data-chart="donut"')).kind, 'doughnutChart', 'donut is the doughnut');
  assert.equal((await chartOf('data-chart="radar"')).kind, 'radarChart', 'radar is native');
  assert.equal((await chartOf('data-chart="spider"')).kind, 'radarChart', 'and spider is its other name');
});

test('position: fixed anchors to the slide, the way print does', () => {
  // A browser pins a fixed element to its scrolling viewport, which for a deck means
  // wherever the preview window happens to be; paged media pins it to the page box,
  // and that is the meaning a footer at `bottom: 40px` carries on a slide. Measured
  // against Chrome on the stress fixture: the browser put the footer at y=854 (below
  // the 720px canvas), the deck puts it at the slide's bottom edge, which is the one
  // a reader can use.
  const build = (wrapper) => pipeline.convertHtml([
    '<html><head><style>',
    '  .slide { width: 1280px; height: 720px; padding: 40px; }',
    '  .deep { position: relative; margin-left: 100px; height: 120px; }',
    '  .pin { position: fixed; left: 56px; bottom: 40px; font-size: 12px; }',
    '</style></head><body><main class="slide">',
    wrapper,
    '</main></body></html>'
  ].join('\n'));
  const pinOf = (result) => {
    let found = null;
    const walk = (element) => {
      if (element.text !== undefined && String(Array.isArray(element.text)
        ? element.text.map((run) => run.text).join('') : element.text).includes('页脚')) found = element;
      (element.children || []).forEach(walk);
    };
    result.deck.slides[0].elements.forEach(walk);
    return found;
  };
  const flat = pinOf(build('<p class="pin">页脚</p>'));
  assert.ok(flat, 'the footer exists');
  // 720 - 40 = 680px from the top, less the line box the estimate gives it.
  assert.ok(Math.abs(flat.y * 96 - (680 - flat.h * 96)) <= 1.5,
    'the footer sits on the slide bottom edge: y=' + (flat.y * 96).toFixed(1));
  // A positioned ancestor does not move it: the slide is the containing block.
  const nested = pinOf(build('<div class="deep"><p class="pin">页脚</p></div>'));
  assert.ok(nested, 'the nested footer exists too');
  assert.ok(Math.abs(nested.y - flat.y) < 0.01,
    'and a positioned ancestor does not drag it down: ' + (nested.y * 96).toFixed(1) + ' vs ' + (flat.y * 96).toFixed(1));
  assert.ok(Math.abs(nested.x - flat.x) < 0.01, 'nor across: ' + (nested.x * 96).toFixed(1));
});

test('the top-level boxes land where Chrome put them', () => {
  // Recorded from a real browser: pipeline-grid.html opened in Chrome 156 and read with
  // getBoundingClientRect(), each slide's children in document order, in CSS px relative
  // to the slide's own corner. The engine never sees these numbers; it has to arrive at
  // them from the CSS alone. Two pixels of slack covers a wrapped line that the estimate
  // rounds differently - anything more is a box in the wrong place.
  const recorded = [
    [{ x: 64, y: 56, w: 1152, h: 16 }, { x: 64, y: 94, w: 1152, h: 43 },
     { x: 64, y: 159, w: 900, h: 24 }, { x: 64, y: 205, w: 1152, h: 428 }],
    [{ x: 64, y: 56, w: 1152, h: 16 }, { x: 64, y: 94, w: 1152, h: 43 },
     { x: 64, y: 159, w: 900, h: 49 }, { x: 64, y: 230, w: 1152, h: 386 }],
    [{ x: 64, y: 56, w: 1152, h: 16 }, { x: 64, y: 94, w: 1152, h: 43 },
     { x: 64, y: 159, w: 900, h: 50 }, { x: 64, y: 231, w: 1152, h: 322 }]
  ];
  const html = require('node:fs').readFileSync(
    require('node:path').join(__dirname, '..', 'examples', 'pipeline-grid.html'), 'utf8');
  const deck = pipeline.convertHtml(html).deck;
  assert.equal(deck.slides.length, recorded.length, 'the fixture still has its pages');
  deck.slides.forEach((slide, page) => {
    assert.equal(slide.elements.length, recorded[page].length,
      'page ' + (page + 1) + ' still has its blocks');
    slide.elements.forEach((element, position) => {
      const expected = recorded[page][position];
      const engine = {
        x: Math.round(element.x * 96), y: Math.round(element.y * 96),
        w: Math.round(element.w * 96), h: Math.round(element.h * 96)
      };
      ['x', 'y', 'w', 'h'].forEach((side) => {
        const delta = engine[side] - expected[side];
        assert.ok(Math.abs(delta) <= 2, 'page ' + (page + 1) + ' block ' + (position + 1)
          + ' ' + side + ' is ' + engine[side] + 'px where Chrome put ' + expected[side] + 'px');
      });
    });
  });
});

test('shape ids stay unique on a slide that mixes text, pictures and tables', () => {
  // Shape ids are one namespace per slide, and the writer numbers a table from its
  // own counter - a table landing on a number a text box already took makes
  // PowerPoint offer to repair the file, which no render would show.
  const JSZip = require('../native/node_modules/jszip');
  const fs = require('node:fs');
  const os = require('node:os');
  const path = require('node:path');
  const { generatePptx } = require('../native/engine/native_pptx');
  const png = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==';
  const html = [
    '<html><head><style>',
    '  .slide { width: 1280px; height: 720px; padding: 40px; font-size: 14px; }',
    '</style></head><body><main class="slide">',
    '<h1>标题</h1><p>正文</p>',
    '<img src="' + png + '" style="width: 100px;">',
    '<table style="width: 400px"><tr><td>甲</td><td>乙</td></tr></table>',
    '</main></body></html>'
  ].join('\n');
  const output = path.join(os.tmpdir(), 'native-shape-ids-' + Date.now() + '.pptx');
  return generatePptx(pipeline.convertHtml(html).deck, output).then(async () => {
    const zip = await JSZip.loadAsync(fs.readFileSync(output));
    const xml = await zip.file('ppt/slides/slide1.xml').async('string');
    const ids = [...xml.matchAll(/<p:cNvPr id="(\d+)"/gu)].map((match) => match[1]);
    assert.ok(ids.length >= 4, 'the slide carries its shapes: ' + ids.join(','));
    assert.equal(new Set(ids).size, ids.length, 'every id is used once: ' + ids.join(','));
    assert.deepEqual(ids, ids.map((value, index) => String(index + 1)),
      'and they run in order, the group first: ' + ids.join(','));
    fs.rmSync(output, { force: true });
  });
});

test('an outline draws alone and is named beside a border', () => {
  // A native shape carries one line, so an outline declared beside a border used to
  // vanish without a word.
  const build = (css) => {
    const result = pipeline.convertHtml([
      '<html><head><style>',
      '  .slide { width: 1280px; height: 720px; padding: 40px; font-size: 14px; }',
      '  .b { width: 200px; height: 80px; ' + css + ' }',
      '</style></head><body><main class="slide"><div class="b">框</div></main></body></html>'
    ].join('\n'));
    return { line: result.deck.slides[0].elements[0].background || {},
      reported: result.report.unsupportedDetails.map((entry) => entry.property) };
  };

  const outline = build('outline: 2px dotted #CC0000;');
  assert.equal(outline.line.lineColor, 'CC0000', 'an outline alone is the shape line');
  assert.equal(outline.line.lineDash, 'sysDot', 'with its dash');
  assert.deepEqual(outline.reported, [], 'and no report');

  const both = build('border: 1px solid #0000CC; outline: 3px dotted #CC0000;');
  assert.equal(both.line.lineColor, '0000CC', 'the border keeps the single line slot');
  assert.ok(both.reported.includes('outline'), 'and the outline is named, not dropped');
});

test('text mixed into a nested container keeps its words too', () => {
  // The same anonymous box applies below the root: a div holding a paragraph and
  // some words used to report a loss and drop the words.
  const textsOf = (body) => {
    const result = pipeline.convertHtml([
      '<html><head><style>',
      '  body { margin: 0; }',
      '  .slide { width: 1280px; height: 720px; padding: 40px; font-size: 14px; }',
      '</style></head><body><main class="slide">' + body + '</main></body></html>'
    ].join('\n'));
    const texts = [];
    const collect = (element) => {
      if (element.text !== undefined) texts.push(Array.isArray(element.text)
        ? element.text.map((run) => run.text).join('') : String(element.text));
      (element.children || []).forEach(collect);
    };
    result.deck.slides[0].elements.forEach(collect);
    return { texts, reported: result.report.unsupportedDetails.map((entry) => entry.property) };
  };

  const spaced = textsOf('<div><p>甲</p>乙</div>');
  assert.deepEqual(spaced.texts, ['甲', '乙'], 'the words after a paragraph survive');
  assert.deepEqual(spaced.reported, [], 'and nothing claims a loss');
  assert.deepEqual(textsOf('<div>乙<p>甲</p></div>').texts, ['乙', '甲'], 'as do the words before');
  assert.deepEqual(textsOf('<div><p>甲</p>乙<p>丙</p></div>').texts, ['甲', '乙', '丙'],
    'and the words between two blocks');
  // A list item and a table cell read their own direct text, so the wrap leaves them
  // alone - the list numbering depends on it.
  assert.deepEqual(textsOf('<ul><li>一</li><li>二</li></ul>').texts, ['一\n二']);
});

test('text directly in the slide root keeps its words', () => {
  // CSS forms an anonymous block box for text sitting directly in a block
  // container; the walk only reached elements, so a one-line slide lost its words
  // without a word of report.
  const textsOf = (body) => {
    const result = pipeline.convertHtml([
      '<html><head><style>',
      '  body { margin: 0; }',
      '  .slide { width: 1280px; height: 720px; padding: 40px; font-size: 14px; }',
      '</style></head><body><main class="slide">' + body + '</main></body></html>'
    ].join('\n'));
    const texts = [];
    const walk = (element) => {
      if (element.text !== undefined) texts.push(Array.isArray(element.text)
        ? element.text.map((run) => run.text).join('') : String(element.text));
      (element.children || []).forEach(walk);
    };
    result.deck.slides[0].elements.forEach(walk);
    return texts;
  };

  assert.deepEqual(textsOf('甲'), ['甲'], 'a one-line slide keeps its words');
  assert.deepEqual(textsOf('甲<div>乙</div>'), ['甲', '乙'],
    'and text before a block keeps its place in the flow');
  assert.deepEqual(textsOf('<div>乙</div>甲'), ['乙', '甲'],
    'as does text after one');
  // Text and inline elements share one anonymous box, so they share a line box.
  assert.deepEqual(textsOf('丁<span>戊</span>'), ['丁戊'],
    'bare text joins the inline run instead of becoming its own box');
});

test('the chart grid is read per axis', () => {
  // A grid is asked for per axis: y is what the theme already draws, x is the other
  // one, both is both. The single true/false spelling stopped reading the axis
  // letters and named them as unknown instead.
  const chartOf = (grid) => {
    const html = [
      '<html><head><style>.slide { width: 1280px; height: 720px; padding: 40px; }</style></head><body><main class="slide">',
      '<div style="width: 800px; height: 400px;"><table class="chart" data-chart="bar"'
        + (grid === null ? '' : ' data-chart-grid="' + grid + '"') + '>',
      '<tr><th>月</th><th>A</th></tr><tr><td>一</td><td>10</td></tr></table></div>',
      '</main></body></html>'
    ].join('\n');
    const result = pipeline.convertHtml(html);
    const chart = result.deck.slides[0].elements[0].children.find((child) => child.type === 'chart');
    return { options: (chart && chart.options) || {}, reported: result.report.unsupportedDetails.map((entry) => entry.property) };
  };

  assert.deepEqual(chartOf('y').options.catGridLine, undefined,
    'y asks for the value lines the theme already draws');
  assert.deepEqual(chartOf('y').reported, [], 'and is not named as unknown');
  assert.deepEqual(chartOf('x').options.catGridLine, { style: 'solid' },
    'x turns the category lines on');
  assert.deepEqual(chartOf('both').options.catGridLine, { style: 'solid' });
  assert.deepEqual(chartOf('none').options.valGridLine, { style: 'none' },
    'none turns both off');
  assert.deepEqual(chartOf('none').options.catGridLine, { style: 'none' });
  assert.deepEqual(chartOf('diagonal').reported, ['data-chart-grid'],
    'a spelling with no meaning is named');
});

test('collapsed borders name the edges the cells disagree on', () => {
  const html = (css) => [
    '<html><head><style>',
    '  .slide { width: 1280px; height: 720px; padding: 40px; font-size: 14px; }',
    '  table { width: 600px; border-collapse: collapse; }',
    css,
    '</style></head><body><main class="slide">',
    '<table><tr><td>甲</td><td>乙</td></tr></table>',
    '</main></body></html>'
  ].join('\n');
  const named = (css) => pipeline.convertHtml(html(css)).report.unsupportedDetails
    .filter((entry) => entry.property === 'borderCollapse');

  // The browser resolves a shared edge to ONE line; a native cell keeps its own edge,
  // so two different declarations are named.
  const conflict = named('td:nth-child(1) { border-right: 1px solid #C00; } td:nth-child(2) { border-left: 3px solid #00C; }');
  assert.equal(conflict.length, 1, 'the disagreement is named once');
  assert.match(conflict[0].reason, /1px|0\.75pt/u, 'the reason quotes the losing edge');
  assert.match(conflict[0].reason, /2\.25pt/u, 'and the winning one');

  // One painted edge and one bare edge is what the collapse draws anyway: the union of
  // the two declarations is the line the browser shows, so it stays silent.
  assert.deepEqual(named('td:nth-child(1) { border-right: 1px solid #C00; }'), [],
    'a single painted edge needs no report');
  assert.deepEqual(named('td { border: 1px solid #333; }'), [],
    'agreeing cells need no report');
});

test('a table cell radius is named as squaring off', () => {
  // An OOXML table cell has no corner geometry; the styled radius drew nothing
  // silently.
  const result = pipeline.convertHtml([
    '<html><head><style>',
    '  .slide { width: 1280px; height: 720px; padding: 40px; font-size: 14px; }',
    '  .t td { border-radius: 12px; background: #C05B3E; }',
    '</style></head><body><main class="slide">',
    '<table class="t" style="border-collapse: separate; border-spacing: 8px;"><tr><td>x</td><td>y</td></tr></table>',
    '</main></body></html>'
  ].join('\n'));
  const report = result.report.unsupportedDetails.find((entry) => entry.property === 'borderRadius');
  assert.ok(report, 'the cell radius is named');
  assert.equal(report.value, '12px');
  // Once per table, not once per cell.
  assert.equal(result.report.unsupportedDetails.filter((entry) => entry.property === 'borderRadius').length, 1);
});

test('an absolutely positioned box pinned on both sides stretches', () => {
  // CSS resolves the width as the span between the insets when left and right both
  // pin the box; the solver hugged the content instead - an inset box came out
  // stamp-sized.
  const result = pipeline.convertHtml([
    '<html><head><style>',
    '  .slide { width: 1280px; height: 720px; padding: 40px; font-size: 14px; position: relative; }',
    '  .b { position: absolute; left: 50px; right: 30px; top: 20px; bottom: 40px; background: #C05B3E; }',
    '</style></head><body><main class="slide"><div class="b">x</div></main></body></html>'
  ].join('\n'));
  const element = result.deck.slides[0].elements[0];
  // The containing block is the slide's padding box (1280px); width = 1280 - 50 - 30.
  assert.ok(Math.abs(element.w - 1200 / 96) < 0.01, 'the box spans between the insets, got ' + element.w);
  assert.ok(Math.abs(element.x - 50 / 96) < 0.01, 'and starts at the left inset');
  // The vertical pair works the same: top and bottom both pinned stretch the height.
  const vertical = pipeline.convertHtml([
    '<html><head><style>',
    '  .slide { width: 1280px; height: 720px; padding: 40px; font-size: 14px; position: relative; }',
    '  .b { position: absolute; left: 50px; top: 20px; bottom: 40px; width: 200px; background: #C05B3E; }',
    '</style></head><body><main class="slide"><div class="b">x</div></main></body></html>'
  ].join('\n')).deck.slides[0].elements[0];
  assert.ok(Math.abs(vertical.h - 660 / 96) < 0.01, 'the height spans top to bottom, got ' + vertical.h);
  // A one-sided pin still hugs its content.
  const hug = pipeline.convertHtml([
    '<html><head><style>',
    '  .slide { width: 1280px; height: 720px; padding: 40px; font-size: 14px; position: relative; }',
    '  .b { position: absolute; left: 56px; bottom: 20px; background: #C05B3E; font-size: 14px; }',
    '</style></head><body><main class="slide"><div class="b">页脚</div></main></body></html>'
  ].join('\n')).deck.slides[0].elements[0];
  assert.ok(hug.w < 2, 'a one-sided pin keeps its shrink-to-fit width, got ' + hug.w);
});

test('quotes: none keeps the q bare', () => {
  // The browser suppresses the synthesized quotes when quotes: none is declared;
  // we drew them anyway.
  const result = pipeline.convertHtml([
    '<html><head><style>',
    '  .slide { width: 1280px; height: 720px; padding: 40px; font-size: 14px; }',
    '  q { quotes: none; }',
    '</style></head><body><main class="slide"><p><q>测试引用</q></p></main></body></html>'
  ].join('\n'));
  const element = result.deck.slides[0].elements[0];
  const text = Array.isArray(element.text) ? element.text.map((run) => run.text).join('') : element.text;
  assert.ok(!text.includes('\u201C'), 'no synthesized quote, got ' + text);
});

test('an in-page anchor is named; external and mailto links ride', () => {
  // A #fragment anchor jumps within the HTML page; in the deck the link draws but
  // leads nowhere, and the design learns that instead of finding a dead link.
  const result = pipeline.convertHtml([
    '<html><head><style>',
    '  .slide { width: 1280px; height: 720px; padding: 40px; font-size: 14px; }',
    '</style></head><body><main class="slide">',
    '<p><a href="#section-2">跳到第二节</a></p>',
    '<p><a href="https://example.com">示例站点</a></p>',
    '</main></body></html>'
  ].join('\n'));
  const anchor = result.report.unsupportedDetails.find((entry) => entry.property === 'href');
  assert.ok(anchor, 'the anchor is named');
  assert.equal(anchor.value, '#section-2');
  let external = null;
  const walk = (element) => {
    if (Array.isArray(element.text)) element.text.forEach((run) => { if (run.options && run.options.hyperlink) external = run.options.hyperlink.url; });
    (element.children || []).forEach(walk);
  };
  result.deck.slides[0].elements.forEach(walk);
  assert.equal(external, 'https://example.com', 'the external link rides natively');
});

test('checkbox and radio draw their state glyphs, optgroup keeps its options', () => {
  // A checked checkbox drew nothing at all, and a select whose selected option sat
  // inside an <optgroup> lost its words - both silent losses of visible mock parts.
  const result = pipeline.convertHtml([
    '<html><head><style>',
    '  .slide { width: 1280px; height: 720px; padding: 40px; font-size: 14px; }',
    '</style></head><body><main class="slide">',
    '<input type="checkbox" checked>',
    '<input type="radio">',
    '<select><optgroup label="组一"><option selected>甲</option></optgroup></select>',
    '</main></body></html>'
  ].join('\n'));
  const texts = [];
  const walk = (element) => {
    if (element.text) texts.push(String(Array.isArray(element.text) ? element.text.map((run) => run.text).join('') : element.text));
    (element.children || []).forEach(walk);
  };
  result.deck.slides[0].elements.forEach(walk);
  const joined = texts.join('');
  assert.ok(joined.includes('\u2611'), 'checked box shows its mark, got ' + joined);
  assert.ok(joined.includes('\u25CB'), 'unchecked radio shows its circle');
  assert.ok(joined.includes('甲'), 'the optgroup option text survives');
});

test('a repeat keyword inside the background shorthand is named', () => {
  // `background: url(x) round` carried its tiling request inside the shorthand,
  // which the longhand read missed - the pattern drew as one fitted image silently.
  const result = pipeline.convertHtml([
    '<html><head><style>',
    '  .slide { width: 1280px; height: 720px; padding: 40px; font-size: 14px; }',
    '  .b { width: 200px; height: 100px; background: url(../examples/asset-x.png) round; }',
    '</style></head><body><main class="slide"><div class="b"></div></main></body></html>'
  ].join('\n'));
  const report = result.report.unsupportedDetails.find((entry) => entry.property === 'backgroundRepeat');
  assert.ok(report, 'the tiling request is named');
  assert.equal(report.value, 'round');
  // A no-repeat in the shorthand still means exactly what the native side draws.
  const silent = pipeline.convertHtml([
    '<html><head><style>',
    '  .slide { width: 1280px; height: 720px; padding: 40px; font-size: 14px; }',
    '  .b { width: 200px; height: 100px; background: url(../examples/asset-x.png) center/cover no-repeat; }',
    '</style></head><body><main class="slide"><div class="b"></div></main></body></html>'
  ].join('\n'));
  assert.ok(!silent.report.unsupportedDetails.some((entry) => entry.property === 'backgroundRepeat'), 'no-repeat stays silent');
});

test('transform-origin reports once, through the parser that knows the shift', () => {
  // The generic sweep listed transformOrigin AND the transform parser named the
  // same origin again - one honest line beats two.
  const result = pipeline.convertHtml([
    '<html><head><style>',
    '  .slide { width: 1280px; height: 720px; padding: 40px; }',
    '  .b { position: absolute; left: 200px; top: 200px; width: 100px; height: 50px; background: #C05B3E; transform: rotate(15deg); transform-origin: left top; font-size: 14px; }',
    '</style></head><body><main class="slide"><div class="b">x</div></main></body></html>'
  ].join('\n'));
  const entries = result.report.unsupportedDetails.filter((entry) => entry.property === 'transform' || entry.property === 'transformOrigin');
  assert.equal(entries.length, 1, 'one entry, got ' + entries.length);
  assert.equal(entries[0].property, 'transform');
});

test('a double border is named as one solid line', () => {
  // cmpd="dbl" has no pptxgenjs option, so the border would draw as a single
  // solid line silently.
  const result = pipeline.convertHtml([
    '<html><head><style>',
    '  .slide { width: 1280px; height: 720px; padding: 40px; }',
    '  .b { border: 4px double #C05B3E; width: 100px; height: 50px; font-size: 14px; }',
    '</style></head><body><main class="slide"><div class="b">x</div></main></body></html>'
  ].join('\n'));
  const report = result.report.unsupportedDetails.find((entry) => entry.property === 'borderStyle');
  assert.ok(report, 'the double style is named');
  assert.ok(report.reason.includes('compound'), 'and explains why: ' + report.reason);
});

test('dashed and dotted borders spell their dash', async () => {
  // The writer sent `dash` where pptxgenjs reads `dashType`, so every dashed, dotted
  // or otherwise styled border drew solid.
  const os = require('node:os');
  const path = require('node:path');
  const fs = require('node:fs');
  const JSZip = require(require.resolve('jszip', { paths: [require.resolve('../native/engine/native_pptx')] }));
  const { generatePptx } = require('../native/engine/native_pptx');
  const result = pipeline.convertHtml([
    '<html><head><style>',
    '  .slide { width: 1280px; height: 720px; padding: 40px; }',
    '  .b { border: 2px dashed #C05B3E; width: 100px; height: 50px; font-size: 14px; }',
    '  .c { border: 2px dotted #17332F; width: 100px; height: 50px; font-size: 14px; }',
    '</style></head><body><main class="slide"><div class="b">x</div><div class="c">y</div></main></body></html>'
  ].join('\n'));
  const output = path.join(os.tmpdir(), 'native-dash-' + process.pid + '.pptx');
  try {
    await generatePptx(result.deck, output);
    const zip = await JSZip.loadAsync(fs.readFileSync(output));
    const xml = await zip.file('ppt/slides/slide1.xml').async('string');
    assert.ok(/prstDash val="dash"/.test(xml), 'dashed spells dash');
    assert.ok(/prstDash val="sysDot"/.test(xml), 'dotted spells sysDot');
  } finally {
    if (fs.existsSync(output)) fs.unlinkSync(output);
  }
});

test('ol type and li value ride the native numbering', () => {
  // type="A" drew arabic digits and value="7" started at 1: both attributes name
  // the marker language and the count, which the native bullet carries.
  const build = (markup) => pipeline.convertHtml([
    '<html><head><style>',
    '  .slide { width: 1280px; height: 720px; padding: 40px; font-size: 14px; }',
    '</style></head><body><main class="slide">' + markup + '</main></body></html>'
  ].join('\n')).deck.slides[0].elements[0];
  assert.equal(build('<ol type="A"><li>甲</li></ol>').bullet.style, 'alphaUcPeriod', 'A numbers as upper alpha');
  assert.equal(build('<ol type="i"><li>一</li></ol>').bullet.style, 'romanLcPeriod', 'i numbers as lower roman');
  assert.equal(build('<ol><li value="7">七</li></ol>').bullet.startAt, 7, 'value starts the count');
  // A start attribute still outranks the item value when both are spelled.
  assert.equal(build('<ol start="3"><li value="7">七</li></ol>').bullet.startAt, 3, 'start wins over value');
  // dl keeps its definition-list shape without bullets.
  const dl = build('<dl><dt>术语</dt><dd>释义</dd></dl>');
  assert.ok(!dl.bullet, 'dl terms carry no bullet');
});

test('q paints its quotes like the browser does', () => {
  // The browser synthesizes open/close quotes around <q> content; the deck drew the
  // bare words, silently dropping glyphs the mock shows.
  const result = pipeline.convertHtml([
    '<html><head><style>',
    '  .slide { width: 1280px; height: 720px; padding: 40px; font-size: 14px; }',
    '</style></head><body><main class="slide"><p><q>引用的话</q>与正文。</p></main></body></html>'
  ].join('\n'));
  const texts = [];
  const walk = (element) => {
    if (element.text) texts.push(Array.isArray(element.text) ? element.text.map((run) => run.text).join('') : String(element.text));
    (element.children || []).forEach(walk);
  };
  result.deck.slides[0].elements.forEach(walk);
  const joined = texts.join('');
  assert.ok(joined.includes('\u201C引用的话\u201D'), 'the quotes surround the content, got ' + joined);
  // A design that declares its own pseudos keeps them.
  const custom = pipeline.convertHtml([
    '<html><head><style>',
    '  .slide { width: 1280px; height: 720px; padding: 40px; font-size: 14px; }',
    '  q::before { content: "《"; } q::after { content: "》"; }',
    '</style></head><body><main class="slide"><p><q>引用的话</q></p></main></body></html>'
  ].join('\n'));
  const customTexts = [];
  const walk2 = (element) => {
    if (element.text) customTexts.push(Array.isArray(element.text) ? element.text.map((run) => run.text).join('') : String(element.text));
    (element.children || []).forEach(walk2);
  };
  custom.deck.slides[0].elements.forEach(walk2);
  assert.ok(customTexts.join('').includes('《引用的话》'), 'declared pseudos win, got ' + customTexts.join(''));
});

test('alt text reaches the file and srcset names its choice', () => {
  // alt rode the whole chain already (element, writer, p:cNvPr descr); pinned at the
  // deck level. srcset was silent: the deck always draws src, and the design may
  // have meant a different picture - the choice is named.
  const result = pipeline.convertHtml([
    '<html><head><style>',
    '  .slide { width: 1280px; height: 720px; padding: 40px; }',
    '</style></head><body><main class="slide">',
    '<img src="data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==" alt="产品照片" style="width:100px;height:50px;">',
    '<img src="data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==" srcset="x2.png 2x" style="width:100px;height:50px;">',
    '</main></body></html>'
  ].join('\n'));
  const images = result.deck.slides[0].elements.filter((e) => e.type === 'image');
  assert.equal(images[0].altText, '产品照片', 'alt rides the element');
  const srcset = result.report.unsupportedDetails.find((entry) => entry.property === 'srcset');
  assert.ok(srcset, 'the srcset choice is named');
});

test('axis bounds and label format spell natively; a second axis is named', () => {
  // The three chart attributes were named as unknown; pptxgenjs spells each one,
  // so the honest report was actually hiding native capability.
  const build = (attrs) => {
    const result = pipeline.convertHtml([
    '<html><head><style>',
    '  .slide { width: 1280px; height: 720px; padding: 40px; }',
    '</style></head><body><main class="slide">',
    '<table class="chart" data-chart="bar" ' + attrs + '>',
    '<thead><tr><th>季度</th><th>收入</th></tr></thead>',
    '<tbody><tr><td>Q1</td><td>320</td></tr><tr><td>Q2</td><td>418</td></tr></tbody>',
    '</table>',
    '</main></body></html>'
  ].join('\n'));
    return {
      chart: result.deck.slides[0].elements.find((e) => e.type === 'chart'),
      report: result.report
    };
  };
  const bounded = build('data-chart-y-min="0" data-chart-y-max="100"');
  assert.equal(bounded.chart.options.valAxisMinVal, 0, 'min rides the options');
  assert.equal(bounded.chart.options.valAxisMaxVal, 100, 'max rides the options');
  const formatted = build('data-chart-label-format="0.0%"');
  assert.equal(formatted.chart.options.dataLabelFormatCode, '0.0%', 'the format code rides');
  // The writer emits one value axis: a series marked secondary points at an axis that is
  // never written, so the option is named instead of riding along doing nothing.
  const secondary = build('data-chart-secondary-axis="true"');
  assert.equal(secondary.chart.options.secondaryValAxis, undefined, 'no phantom second axis');
  const named = secondary.report.unsupportedDetails.filter((entry) => entry.property === 'data-chart-secondary-axis');
  assert.equal(named.length, 1, 'and the request is named');
  assert.match(named[0].reason, /one value axis/u, 'with the reason: ' + named[0].reason);
  const clean = build('');
  assert.equal(clean.report.unsupportedDetails.length, 0, 'a plain chart stays silent');
});

test('form controls show the words the mock shows', () => {
  // An input drew an empty box: the placeholder lived in an attribute no text path
  // read. A select read EVERY option out loud - the labels sit behind the dropdown
  // a static deck cannot open. The parser seeds the placeholder, and the text walk
  // stops at a closed select to push only the chosen option's label.
  const result = pipeline.convertHtml([
    '<html><head><style>',
    '  .slide { width: 1280px; height: 720px; padding: 40px; }',
    '  .f { width: 200px; height: 32px; border: 1px solid #999; font-size: 14px; }',
    '</style></head><body><main class="slide">',
    '<input class="f" type="text" placeholder="用户名">',
    '<select class="f"><option>选项甲</option><option selected>选项乙</option></select>',
    '</main></body></html>'
  ].join('\n'));
  const texts = [];
  const walk = (element) => {
    if (element.text) texts.push(String(element.text));
    (element.children || []).forEach(walk);
  };
  result.deck.slides[0].elements.forEach(walk);
  assert.ok(texts.includes('用户名'), 'the placeholder is visible, got ' + JSON.stringify(texts));
  assert.ok(texts.includes('选项乙') && !texts.some((t) => t.includes('选项甲')),
    'only the chosen option shows, got ' + JSON.stringify(texts));
});

test('an elliptical corner is named instead of silently half-drawn', () => {
  // `border-radius: 50% / 30%` carries a horizontal and a vertical radius. The slash
  // used to be fed to the box expansion, which split it as tokens: the vertical half
  // vanished, each corner kept its horizontal radius alone, and the box drew an
  // ordinary circle-corner with no trace of the ry the design asked for.
  const result = pipeline.convertHtml([
    '<html><head><style>',
    '  .slide { width: 1280px; height: 720px; padding: 40px; }',
    '  .b { position: absolute; left: 100px; top: 100px; width: 100px; height: 50px; background: #C05B3E; border-radius: 50% / 30%; font-size: 14px; }',
    '</style></head><body><main class="slide"><div class="b">x</div></main></body></html>'
  ].join('\n'));
  const reports = result.report.unsupportedDetails.filter((entry) => entry.property === 'borderRadius');
  assert.equal(reports.length, 1, 'the elliptical corner is named once, got ' + reports.length);
  assert.ok(reports[0].value.includes('50%') && reports[0].value.includes('30%'),
    'both radii ride the report: ' + reports[0].value);
  // A plain uniform radius still draws without a report.
  const round = pipeline.convertHtml([
    '<html><head><style>',
    '  .slide { width: 1280px; height: 720px; padding: 40px; }',
    '  .b { width: 100px; height: 50px; background: #C05B3E; border-radius: 12px; font-size: 14px; }',
    '</style></head><body><main class="slide"><div class="b">x</div></main></body></html>'
  ].join('\n'));
  assert.deepEqual(round.report.unsupportedDetails.map((entry) => entry.property), [], 'a plain radius stays silent');
});

test('an ordered list numbers natively and honors start', async () => {
  // A UA-default <ol> drew a round bullet: the marker lookup keyed off the computed
  // list-style-type, which the browser defaults to decimal without spelling it. The
  // ordered tag now seeds decimal; start=5 rides buAutoNum startAt; reversed is named
  // because DrawingML counts up only.
  const build = (attrs) => pipeline.convertHtml([
    '<html><head><style>',
    '  .slide { width: 1280px; height: 720px; padding: 40px; }',
    '  .b { font-size: 16px; }',
    '</style></head><body><main class="slide">',
    '<ol class="b"' + attrs + '><li>第一</li><li>第二</li></ol>',
    '</main></body></html>'
  ].join('\n'));
  const plain = build('');
  assert.equal(plain.deck.slides[0].elements[0].bullet.type, 'number', 'a plain ol numbers');
  const started = build(' start="5"');
  assert.equal(started.deck.slides[0].elements[0].bullet.startAt, 5, 'start rides the bullet');
  const reversed = build(' reversed');
  assert.ok(reversed.report.unsupportedDetails.some((entry) => entry.property === 'reversed'),
    'reversed is named');
  const os = require('node:os');
  const path = require('node:path');
  const fs = require('node:fs');
  const JSZip = require(require.resolve('jszip', { paths: [require.resolve('../native/engine/native_pptx')] }));
  const { generatePptx } = require('../native/engine/native_pptx');
  const output = path.join(os.tmpdir(), 'native-ol-' + process.pid + '.pptx');
  try {
    await generatePptx(started.deck, output);
    const zip = await JSZip.loadAsync(fs.readFileSync(output));
    const xml = await zip.file('ppt/slides/slide1.xml').async('string');
    assert.ok(/buAutoNum type="arabicPeriod" startAt="5"/.test(xml), 'startAt spells at 5');
  } finally {
    if (fs.existsSync(output)) fs.unlinkSync(output);
  }
});

test('a margin offsets an absolutely positioned box', async () => {
  // CSS: the margin shifts the box from its inset position; a negative value pulls
  // it back. The absolute branch recomputed x from style.left and ignored margins -
  // the box drew at 100px instead of 80px with margin-left: -20px.
  const os = require('node:os');
  const path = require('node:path');
  const fs = require('node:fs');
  const JSZip = require(require.resolve('jszip', { paths: [require.resolve('../native/engine/native_pptx')] }));
  const { generatePptx } = require('../native/engine/native_pptx');
  const result = pipeline.convertHtml([
    '<html><head><style>',
    '  .slide { width: 1280px; height: 720px; padding: 40px; }',
    '  .b { position: absolute; left: 100px; top: 100px; margin-left: -20px; width: 100px; height: 50px; background: #C05B3E; font-size: 14px; }',
    '</style></head><body><main class="slide"><div class="b">x</div></main></body></html>'
  ].join('\n'));
  const output = path.join(os.tmpdir(), 'native-absm-' + process.pid + '.pptx');
  try {
    await generatePptx(result.deck, output);
    const zip = await JSZip.loadAsync(fs.readFileSync(output));
    const xml = await zip.file('ppt/slides/slide1.xml').async('string');
    const pattern = /<a:off x="(-?\d+)"/gu;
    const offsets = [];
    let match;
    while ((match = pattern.exec(xml))) offsets.push(Number(match[1]) / 914400 * 96);
    const childX = offsets[offsets.length - 1];
    assert.equal(Number(childX.toFixed(1)), 80, 'the box lands at 100 - 20 = 80px, got ' + childX);
  } finally {
    if (fs.existsSync(output)) fs.unlinkSync(output);
  }
});

test('each-line indent is named instead of half-applied', () => {
  // text-indent: 3em each-line asks for every wrapped line; the native paragraph
  // indent touches only the first line. The keyword used to silently parse as null
  // and no indent was drawn with no trace.
  const build = (indent) => pipeline.convertHtml([
    '<html><head><style>',
    '  .slide { width: 1280px; height: 720px; padding: 40px; }',
    '  .b { text-indent: ' + indent + '; width: 200px; font-size: 16px; }',
    '</style></head><body><main class="slide"><p class="b">每行缩进的长文本，宽度足够小以致换行。</p></main></body></html>'
  ].join('\n'));
  const eachLine = build('3em each-line');
  assert.ok(eachLine.report.unsupportedDetails.some((entry) => entry.property === 'textIndent' && entry.reason.includes('every wrapped line')),
    'the keyword is named');
  const plain = build('3em');
  assert.deepEqual(plain.report.unsupportedDetails.map((entry) => entry.property), [],
    'a plain first-line indent stays native and silent');
});

test('decoration style and sub/superscript spell at the run level', async () => {
  // dotted/wavy underlines collapse to a plain one, and vertical-align sub/super
  // carries a baseline offset: both are DrawingML run properties the writer already
  // forwards. Pinned at the XML level.
  const os = require('node:os');
  const path = require('node:path');
  const fs = require('node:fs');
  const JSZip = require(require.resolve('jszip', { paths: [require.resolve('../native/engine/native_pptx')] }));
  const { generatePptx } = require('../native/engine/native_pptx');
  const result = pipeline.convertHtml([
    '<html><head><style>',
    '  .slide { width: 1280px; height: 720px; padding: 40px; }',
    '  .a { text-decoration: underline dotted; } .b2 { text-decoration: underline wavy; } .c { text-decoration: underline; }',
    '  .c2 { vertical-align: sub; } .d { vertical-align: super; }',
    '</style></head><body><main class="slide">',
    '<p><span class="a">点线</span><span class="b2">波浪</span><span class="c">普通</span><span class="c2">下</span><span class="d">上</span></p>',
    '</main></body></html>'
  ].join('\n'));
  const output = path.join(os.tmpdir(), 'native-deco-' + process.pid + '.pptx');
  try {
    await generatePptx(result.deck, output);
    const zip = await JSZip.loadAsync(fs.readFileSync(output));
    const xml = await zip.file('ppt/slides/slide1.xml').async('string');
    assert.ok(/u="dotted"/.test(xml), 'dotted underline spelled');
    assert.ok(/u="wavy"/.test(xml), 'wavy underline spelled');
    assert.ok(/u="sng"/.test(xml), 'plain underline stays single');
    assert.ok(/baseline="-40000"/.test(xml), 'subscript baseline offset');
    assert.ok(/baseline="30000"/.test(xml), 'superscript baseline offset');
  } finally {
    if (fs.existsSync(output)) fs.unlinkSync(output);
  }
});

test('doughnut hole size and legend font size map to reader options', () => {
  // Two more reader-native chart settings that were reported away as unknown:
  // holeSize (10-90) and legendFontSize. Out-of-range values are named, not clamped.
  const build = (tableTag) => pipeline.convertHtml([
    '<html><head><style>',
    '  .slide { width: 1280px; height: 720px; padding: 40px; }',
    '  table { font-size: 13px; }',
    '</style></head><body><main class="slide">',
    '<table ' + tableTag + '><tr><th>项</th><th>值</th></tr>',
    '<tr><td>甲</td><td>40</td></tr><tr><td>乙</td><td>60</td></tr></table>',
    '</main></body></html>'
  ].join('\n'));
  const chartOf = (result) => result.deck.slides[0].elements.find((entry) => entry.type === 'chart');
  const hole = build('data-chart="doughnut" data-chart-title="t" data-chart-hole-size="60"');
  assert.equal(chartOf(hole).options.holeSize, 60);
  const badHole = build('data-chart="doughnut" data-chart-title="t" data-chart-hole-size="900"');
  assert.equal(chartOf(badHole).options.holeSize, undefined);
  assert.ok(badHole.report.unsupportedDetails.some((entry) => entry.property === 'data-chart-hole-size'));
  const legend = build('data-chart="bar" data-chart-title="t" data-chart-legend-font-size="12"');
  assert.equal(chartOf(legend).options.legendFontSize, 12);
});

test('an explicit colour attribute outranks the header palette', () => {
  // Header cells that paint a colour name their series, but a data-chart-colors
  // attribute is a design statement: it wins even when the fixture-wide th style
  // paints every header cell. The deeper stress page caught this - the attr was
  // silently overwritten by the inherited th colour there.
  const build = (styleTag, tableTag) => pipeline.convertHtml([
    '<html><head><style>',
    '  .slide { width: 1280px; height: 720px; padding: 40px; }',
    '  table { font-size: 13px; }',
    styleTag,
    '</style></head><body><main class="slide">',
    '<table ' + tableTag + '><tr><th>季度</th><th>销售额</th></tr>',
    '<tr><td>Q1</td><td>120</td></tr><tr><td>Q2</td><td>150</td></tr></table>',
    '</main></body></html>'
  ].join('\n'));
  const chartOf = (result) => result.deck.slides[0].elements.find((entry) => entry.type === 'chart');
  const attr = build('  th { color: #3F5450; }', 'data-chart="bar" data-chart-title="t" data-chart-colors="#F2A24C,#4FB3A8"');
  assert.deepEqual(chartOf(attr).options.chartColors, ['F2A24C', '4FB3A8'],
    'the attribute wins over the th palette');
  const derived = build('  th { color: #3F5450; } th:nth-child(2) { color: #C05B3E; }', 'data-chart="bar" data-chart-title="t"');
  assert.deepEqual(chartOf(derived).options.chartColors, ['C05B3E'],
    'without an attribute, per-series header colours still name the palette');
});

test('chart tuning attributes map to reader options', () => {
  // Gap width, line smoothing and category label rotation are reader-native chart
  // settings; each data-chart-* attribute maps to one option and out-of-range values
  // are named.
  const build = (tableTag) => pipeline.convertHtml([
    '<html><head><style>',
    '  .slide { width: 1280px; height: 720px; padding: 40px; }',
    '  table { font-size: 13px; }',
    '</style></head><body><main class="slide">',
    '<table ' + tableTag + '><tr><th>季度</th><th>销售额</th></tr>',
    '<tr><td>Q1</td><td>120</td></tr><tr><td>Q2</td><td>150</td></tr></table>',
    '</main></body></html>'
  ].join('\n'));
  const tuned = build('data-chart="line" data-chart-title="t" data-chart-gap-width="40" data-chart-smooth="true" data-chart-cat-label-rotate="-45"');
  const chart = tuned.deck.slides[0].elements.find((entry) => entry.type === 'chart');
  assert.equal(chart.options.barGapWidthPct, 40);
  assert.equal(chart.options.lineSmooth, true, 'a line can bend');
  assert.equal(chart.options.catAxisLabelRotate, -45);
  // A bar has no line to bend, so the request is named rather than dropped.
  const bentBar = build('data-chart="bar" data-chart-smooth="true"');
  assert.ok(bentBar.report.unsupportedDetails.some((entry) => entry.property === 'data-chart-smooth'
    && /draws none/u.test(entry.reason)), 'smoothing a bar chart is named');
  assert.equal(bentBar.deck.slides[0].elements.find((entry) => entry.type === 'chart').options.lineSmooth,
    undefined, 'and the option is not set');
  const rejected = build('data-chart="bar" data-chart-title="t" data-chart-gap-width="900"');
  assert.ok(rejected.report.unsupportedDetails.some((entry) => entry.property === 'data-chart-gap-width'),
    'a 900% gap is named, not clamped');
  assert.equal(rejected.deck.slides[0].elements.find((entry) => entry.type === 'chart').options.barGapWidthPct, undefined);
});


test('merged cells round-trip to OOXML merge marks', async () => {
  // rowspan/colspan are reader-native merges: the spanning cell carries rowSpan/colspan
  // and the continuation rows omit it, which the OOXML writer expresses as vMerge and
  // hMerge with the span attributes. Locked at the XML level because the deck-level
  // convention (fewer cells in continuation rows) looks like data loss in JSON.
  const os = require('node:os');
  const path = require('node:path');
  const fs = require('node:fs');
  const JSZip = require(require.resolve('jszip', { paths: [require.resolve('../native/engine/native_pptx')] }));
  const { generatePptx } = require('../native/engine/native_pptx');
  const table = (cells) => pipeline.convertHtml([
    '<html><head><style>',
    '  .slide { width: 1280px; height: 720px; padding: 40px; }',
    '  table { width: 600px; font-size: 13px; }',
    '</style></head><body><main class="slide"><table>' + cells + '</table></main></body></html>'
  ].join('\n'));
  const xmlOf = async (deck) => {
    const output = path.join(os.tmpdir(), 'native-merge-' + process.pid + '.pptx');
    try {
      await generatePptx(deck, output);
      const zip = await JSZip.loadAsync(fs.readFileSync(output));
      return await zip.file('ppt/slides/slide1.xml').async('string');
    } finally {
      if (fs.existsSync(output)) fs.unlinkSync(output);
    }
  };
  const row = await xmlOf(table('<tr><td rowspan="2">跨行</td><td>A</td></tr><tr><td>B</td></tr>').deck);
  assert.ok(/rowSpan="2"/.test(row) && row.includes('vMerge'), 'the row span survives as a real vertical merge');
  const col = await xmlOf(table('<tr><td colspan="2">跨列</td></tr><tr><td>A</td><td>B</td></tr>').deck);
  assert.ok(/gridSpan="2"/.test(col) && col.includes('hMerge'), 'the column span survives as a real horizontal merge');
});


test('interaction-only properties stay silent on a static slide', () => {
  // cursor, user-select and background-attachment are judged against interaction or
  // scrolling a slide never has: every value draws the same, so they are equivalent
  // no-ops. The outline (no offset) is the native line, already drawn.
  const build = (css) => pipeline.convertHtml([
    '<html><head><style>',
    '  .slide { width: 1280px; height: 720px; padding: 40px; }',
    css,
    '</style></head><body><main class="slide"><div class="b">x</div></main></body></html>'
  ].join('\n'));
  assert.deepEqual(build('  .b { width: 200px; height: 60px; cursor: pointer; user-select: none; background-attachment: fixed; font-size: 14px; }')
    .report.unsupportedDetails.map((entry) => entry.property), []);
  const outline = build('  .b { position: absolute; left: 100px; top: 100px; width: 200px; height: 60px; background: #C05B3E; outline: 2px solid #17332F; font-size: 14px; }');
  const background = outline.deck.slides[0].elements[0].background;
  assert.equal(background.lineColor, '17332F');
  assert.equal(background.lineWidth, 1.5, '2px is 1.5pt');
});


test('background-size auto draws at natural size, centred', () => {
  // `background-size: auto` (the default) draws the picture at its intrinsic size
  // centred in the box; the emitter used to stretch every background picture over the
  // box, so a 1x1 PNG became a full-bleed block. Intrinsic dimensions come from the
  // PNG/JPEG/GIF header; an unreadable image falls back to the box fill.
  const build = (body) => pipeline.convertHtml([
    '<html><head><style>',
    '  .slide { width: 1280px; height: 720px; padding: 40px; }',
    '</style></head><body><main class="slide">' + body + '</main></body></html>'
  ].join('\n'));
  const png1x1 = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==';
  const result = build('<div style="position: absolute; left: 100px; top: 100px; width: 300px; height: 200px; background: url(&quot;' + png1x1 + '&quot;) no-repeat center;"></div>');
  const image = result.deck.slides[0].elements.find((entry) => entry.type === 'image');
  assert.ok(image, 'the background picture is emitted');
  assert.equal(Number((image.w * 96).toFixed(1)), 4.8, 'a 1x1 PNG draws at its natural 1px (minimum tile size), not 300px wide');
  const centreX = Number((image.x * 96 + image.w * 96 / 2).toFixed(0));
  assert.ok(Math.abs(centreX - 250) <= 3, 'the natural picture centres on the box (100 + 150), got ' + centreX);
});

