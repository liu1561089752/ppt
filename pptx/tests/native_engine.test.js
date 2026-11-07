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
