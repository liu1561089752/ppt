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
    const zip = await JSZip.loadAsync(fs.readFileSync(output));
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
    const zip = await JSZip.loadAsync(fs.readFileSync(output));
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
    const zip = await JSZip.loadAsync(fs.readFileSync(output));
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
    const zip = await JSZip.loadAsync(fs.readFileSync(output));
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
  // The fixture clips its slide with `overflow: hidden`, which no native shape can
  // express, so it must be reported instead of silently claimed as supported.
  assert.deepEqual(result.report.unsupportedDetails.map((entry) => entry.property), ['overflow']);
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
  // right: 72px against the padding box → 64px padding + 72px inset.
  const rightEdge = stamp.x + stamp.w;
  assert.ok(Math.abs(rightEdge - (13.333 - 64 / 96 - 72 / 96)) < 0.02,
    'right edge ' + rightEdge.toFixed(3));
  // bottom: 56px against the padded content box.
  const bottomEdge = stamp.y + stamp.h;
  assert.ok(Math.abs(bottomEdge - (7.5 - 64 / 96 - 56 / 96)) < 0.02,
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
  assert.ok(tallCell.h > 1.5, 'a two-row cell must be taller than one row: ' + tallCell.h);
  // Nothing was guessed: no unsupported entries and no absolute fallbacks.
  assert.equal(result.report.unsupportedDetails.length, 0,
    JSON.stringify(result.report.unsupportedDetails));
  assert.deepEqual(result.report.containerFallbacks, []);
});

test('html pipeline reports explicit grid line placement', () => {
  const html = [
    '<html><head><style>',
    '  .slide { width: 1280px; height: 720px; }',
    '  .grid { display: grid; grid-template-columns: 1fr 1fr; width: 1000px; }',
    '  .a { grid-column: 2 / 4; }',
    '</style></head><body><main class="slide">',
    '<div class="grid"><div class="a"><div>x</div></div><div><div>y</div></div></div>',
    '</main></body></html>'
  ].join('\n');
  const result = pipeline.convertHtml(html);
  const reported = result.report.unsupportedDetails.filter((entry) => entry.property === 'gridColumn');
  assert.equal(reported.length, 1, JSON.stringify(result.report.unsupportedDetails));
  assert.match(reported[0].reason, /Explicit grid line placement/u);
});

