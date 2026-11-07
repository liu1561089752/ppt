'use strict';

const pptxgen = require('pptxgenjs');
const { normalizePageSize } = require('../core/units');
const { validateDeck } = require('../core/schema');
const { layoutSlide } = require('./layout');
const { validateSlide } = require('./validation');
const { FontManager } = require('./font_manager');
const defaultTheme = require('../themes/default');

function cleanColor(value, fallback) {
  return String(value || fallback || '000000').replace(/^#/, '').toUpperCase();
}

function textOptions(el, theme) {
  return {
    x: el.x, y: el.y, w: el.w, h: el.h,
    fontFace: el.fontFace || theme.fonts.body,
    fontSize: el.fontSize || theme.sizes.body,
    color: cleanColor(el.color, theme.colors.foreground),
    bold: !!el.bold,
    breakLine: false,
    margin: el.margin === undefined ? 0 : el.margin,
    valign: el.valign || 'mid',
    align: el.align || 'left',
    paraSpaceAfterPt: el.paraSpaceAfterPt || 0,
    lineSpacingMultiple: el.lineSpacingMultiple || theme.lineSpacingMultiple,
    fit: 'shrink',
    transparency: el.transparency || 0,
    isTextBox: true
  };
}

function addElement(slide, el, theme, pptx) {
  if (el.type === 'text') {
    const opts = textOptions(el, theme);
    if (Array.isArray(el.text)) {
      const runs = el.text.map((run) => {
        if (typeof run === 'string') return { text: run, options: {} };
        return { text: run.text || '', options: Object.assign({}, run.options || {}, {
          fontFace: (run.options && run.options.fontFace) || el.fontFace || theme.fonts.body
        }) };
      });
      slide.addText(runs, opts);
    } else slide.addText(el._renderText || el.text, opts);
  } else if (el.type === 'shape') {
    const shape = el.shape || pptx.ShapeType.rect;
    slide.addShape(shape, {
      x: el.x, y: el.y, w: el.w, h: el.h,
      rectRadius: el.radius,
      fill: el.fill === false ? { color: 'FFFFFF', transparency: 100 } : { color: cleanColor(el.fill, theme.colors.surface), transparency: el.fillTransparency || 0 },
      line: el.line === false ? { color: 'FFFFFF', transparency: 100 } : { color: cleanColor(el.lineColor, theme.colors.border), width: el.lineWidth === undefined ? 0.8 : el.lineWidth, transparency: el.lineTransparency || 0 },
      radius: el.radius
    });
  } else if (el.type === 'line') {
    slide.addShape(pptx.ShapeType.line, {
      x: el.x, y: el.y, w: el.w, h: el.h,
      line: { color: cleanColor(el.color, theme.colors.accent), width: el.width || 1.5, beginArrowType: el.beginArrowType, endArrowType: el.endArrowType, dash: el.dash }
    });
  } else if (el.type === 'image') {
    const source = el.path ? { path: el.path } : { data: el.data };
    slide.addImage(Object.assign(source, { x: el.x, y: el.y, w: el.w, h: el.h }));
  } else if (el.type === 'table') {
    slide.addTable(el.rows || [], Object.assign({
      x: el.x, y: el.y, w: el.w, h: el.h,
      border: { type: 'solid', color: theme.colors.border, pt: 0.8 },
      color: theme.colors.foreground,
      fontFace: theme.fonts.body,
      fontSize: theme.sizes.body,
      margin: 0.06,
      autoFit: false
    }, el.options || {}));
  }
}

async function buildPresentation(deck, options = {}) {
  const errors = validateDeck(deck);
  if (errors.length) throw new Error('Invalid deck spec:\n- ' + errors.join('\n- '));

  const pptx = new pptxgen();
  const pageSize = normalizePageSize(deck.pageSize || options.pageSize || 'wide');
  const theme = Object.assign({}, defaultTheme, deck.theme || options.theme || {});
  theme.colors = Object.assign({}, defaultTheme.colors, (deck.theme && deck.theme.colors) || (options.theme && options.theme.colors) || {});
  theme.fonts = Object.assign({}, defaultTheme.fonts, (deck.theme && deck.theme.fonts) || (options.theme && options.theme.fonts) || {});
  theme.sizes = Object.assign({}, defaultTheme.sizes, (deck.theme && deck.theme.sizes) || (options.theme && options.theme.sizes) || {});\n  theme.fontFiles = Object.assign({}, (options.theme && options.theme.fontFiles) || {}, (deck.theme && deck.theme.fontFiles) || {});\n  const fontManager = new FontManager({ fontFiles: theme.fontFiles, fallbackFont: theme.fallbackFontFile || (deck.theme && deck.theme.fallbackFontFile) });

  pptx.defineLayout({ name: 'NATIVE_CUSTOM', width: pageSize.width, height: pageSize.height });
  pptx.layout = 'NATIVE_CUSTOM';
  pptx.author = deck.author || options.author || 'Native PPT Engine';
  pptx.subject = deck.subject || '';
  pptx.title = deck.title || 'Presentation';
  pptx.company = deck.company || '';
  pptx.lang = deck.language || 'zh-CN';
  pptx.theme = {
    headFontFace: theme.fonts.heading,
    bodyFontFace: theme.fonts.body,
    lang: deck.language || 'zh-CN'
  };

  const report = [];
  for (const [index, spec] of deck.slides.entries()) {
    const slide = pptx.addSlide();
    slide.background = { color: cleanColor(spec.background, theme.colors.background) };
    const elements = layoutSlide(spec, pageSize, theme, { fontManager });
    const warnings = validateSlide(elements, pageSize);\n    elements.forEach((element, elementIndex) => {\n      (element._layoutWarnings || []).forEach((message) => warnings.push({ code: 'LAYOUT_WARNING', element: elementIndex, message }));\n    });
    elements.forEach((element) => addElement(slide, element, theme, pptx));
    if (spec.notes) slide.addNotes(spec.notes);
    report.push({ slide: index + 1, warnings });
  }
  return { pptx, report, pageSize };
}

async function generatePptx(deck, outputPath, options = {}) {
  if (!outputPath) throw new Error('outputPath is required');
  const result = await buildPresentation(deck, options);
  await result.pptx.writeFile({ fileName: outputPath });
  return { outputPath, report: result.report, pageSize: result.pageSize };
}

module.exports = { buildPresentation, generatePptx };
