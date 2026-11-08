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
  assert.equal(style.line.dash, 'dash');
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
  assert.equal(textObject.options.lineSpacingMultiple, 1.42);
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

test('image fit resolves natural size from data URIs and reports a helpful error otherwise', () => {
  const dataUri = 'data:image/png;base64,' + makePng(120, 60).toString('base64');
  assert.deepEqual(imageFit.readImageSize({ type: 'image', data: dataUri }), { width: 120, height: 60 });
  assert.throws(() => imageFit.resolveImageGeometry({
    type: 'image', path: 'does-not-exist.png', x: 0, y: 0, w: 2, h: 2, fit: 'cover'
  }), /natural pixel size/);
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
    assert.equal(report.totals.croppedPictures, 2);
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

  // A transform that also scales has no native equivalent, so it is reported and
  // must not be silently half-applied.
  const transformReports = result.report.unsupportedDetails.filter((entry) => entry.property === 'transform');
  assert.equal(transformReports.length, 1);
  assert.equal(transformReports[0].value, 'scale()');
  assert.equal(elements.filter((element) => element.rotate === 10).length, 0);

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
  assert.ok(Math.abs(title.y - 40 / 96) < 0.01);

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

  // `pre` keeps whitespace, which the DOM text walk already collapsed: reported.
  const pre = build('white-space: pre;');
  assert.equal(pre.report.unsupportedDetails.filter((entry) => entry.property === 'whiteSpace').length, 1);

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
  assert.equal(result.deck.slides.length, 3);
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
  assert.ok(Math.abs(besideText.y - 40 / 96) < 0.005, 'and at the top of the band: ' + besideText.y);

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
  // Seven archetypes cycle, so a nine-page deck has to exercise most of them.
  const kinds = new Set(result.deck.slides.map((slide) => (slide.elements || []).length));
  assert.ok(kinds.size > 1, 'the pages are not identical');
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
  assert.ok(mixed.report.unsupportedDetails.some((entry) => entry.property === 'element'
    && entry.reason.includes('does not share a line box')),
  'text mixed with element children is reported');
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
  assert.equal(inches('40ch'), 3.3333, 'ch is half an em');
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

