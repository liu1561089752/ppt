'use strict';

const fs = require('node:fs');
const JSZip = require('jszip');
const pptxgen = require('pptxgenjs');
const { normalizePageSize } = require('../core/units');
const { validateDeck } = require('../core/schema');
const { layoutSlide } = require('./layout');
const { validateSlide } = require('./validation');
const { FontManager } = require('./font_manager');
const { patchEastAsianFonts } = require('./east_asian_font');
const defaultTheme = require('../themes/default');
const { resolveTheme } = require('../themes/design_system');

function cleanColor(value, fallback) {
  return String(value || fallback || '000000').replace(/^#/, '').toUpperCase();
}

function isBoldWeight(weight, fallback = false) {
  if (weight === undefined || weight === null || weight === '') return fallback;
  const normalized = String(weight).trim().toLowerCase();
  if (['normal', 'regular', '400', '300', '200', '100'].includes(normalized)) return false;
  if (['bold', 'bolder', '600', '700', '800', '900'].includes(normalized)) return true;
  const numeric = Number(normalized);
  return Number.isFinite(numeric) ? numeric >= 600 : fallback;
}

function textOptions(el, theme) {
  const isTitle = el.role === 'title' || el.role === 'heading';
  const weight = isTitle
    ? (el.role === 'title' ? theme.typography.titleWeight : theme.typography.headingWeight)
    : theme.typography.bodyWeight;
  return {
    x: el.x, y: el.y, w: el.w, h: el.h,
    fontFace: el.fontFace || (isTitle ? theme.fonts.heading : theme.fonts.body),
    fontSize: el.fontSize || (isTitle ? theme.sizes[el.role] || theme.sizes.title : theme.sizes.body),
    color: cleanColor(el.color, theme.colors.foreground),
    bold: el.bold === undefined ? isBoldWeight(weight, false) : !!el.bold,
    italic: !!el.italic,
    underline: !!el.underline,
    strike: !!el.strike,
    charSpacing: el.charSpacing,
    lineSpacingMultiple: el.lineSpacingMultiple || theme.typography.lineSpacingMultiple || theme.lineSpacingMultiple || 1.22,
    paraSpaceBeforePt: el.paraSpaceBeforePt,
    bullet: el.bullet,
    margin: el.margin === undefined ? 0 : el.margin,
    valign: el.valign || 'mid',
    align: el.align || 'left',
    paraSpaceAfterPt: el.paraSpaceAfterPt || 0,
    fit: 'shrink',
    transparency: el.transparency || 0,
    isTextBox: true
  };
}

function shapeStyle(el, theme) {
  const fill = el.fill === false
    ? { color: 'FFFFFF', transparency: 100 }
    : {
        color: cleanColor(el.fill, theme.colors.surface),
        transparency: el.fillTransparency === undefined ? 0 : el.fillTransparency
      };
  const line = el.line === false
    ? { color: 'FFFFFF', transparency: 100 }
    : {
        color: cleanColor(el.lineColor, theme.colors.border),
        width: el.lineWidth === undefined ? 0.8 : el.lineWidth,
        transparency: el.lineTransparency === undefined ? 0 : el.lineTransparency,
        dash: el.lineDash || el.dash
      };
  const options = {
    x: el.x, y: el.y, w: el.w, h: el.h,
    rectRadius: el.radius,
    rotate: el.rotate || 0,
    transparency: el.transparency === undefined ? 0 : el.transparency,
    fill,
    line
  };
  if (el.shadow) {
    const shadow = typeof el.shadow === 'object' ? el.shadow : {};
    options.shadow = {
      type: shadow.type || 'outer',
      color: cleanColor(shadow.color, '000000'),
      opacity: shadow.opacity === undefined ? 0.18 : shadow.opacity,
      blur: shadow.blur === undefined ? 4 : shadow.blur,
      angle: shadow.angle === undefined ? 45 : shadow.angle,
      distance: shadow.distance === undefined ? 2 : shadow.distance
    };
  }
  return options;
}

function addElement(slide, el, theme, pptx) {
  if (el.type === 'text') {
    const opts = textOptions(el, theme);
    if (Array.isArray(el.text)) {
      const runs = el.text.map((run) => {
        if (typeof run === 'string') return { text: run, options: {} };
        return {
          text: run.text || '',
          options: Object.assign({}, run.options || {}, {
            fontFace: (run.options && run.options.fontFace) || el.fontFace || theme.fonts.body
          })
        };
      });
      slide.addText(runs, opts);
    } else {
      slide.addText(el._renderText || el.text, opts);
    }
  } else if (el.type === 'shape') {
    // A radius token must select a rounded-rectangle geometry; rectRadius alone is ignored by some renderers.
    const shape = el.shape || (el.radius ? pptx.ShapeType.roundRect : pptx.ShapeType.rect);
    slide.addShape(shape, shapeStyle(el, theme));
  } else if (el.type === 'line') {
    slide.addShape(pptx.ShapeType.line, {
      x: el.x, y: el.y, w: el.w, h: el.h,
      line: {
        color: cleanColor(el.color, theme.colors.accent),
        width: el.width || 1.5,
        beginArrowType: el.beginArrowType,
        endArrowType: el.endArrowType,
        dash: el.dash,
        transparency: el.transparency === undefined ? 0 : el.transparency
      }
    });
  } else if (el.type === 'image') {
    const source = el.path ? { path: el.path } : { data: el.data };
    slide.addImage(Object.assign(source, { x: el.x, y: el.y, w: el.w, h: el.h, transparency: el.transparency || 0 }));
  } else if (el.type === 'chart') {
    const chartTypes = {
      bar: pptx.ChartType.bar,
      line: pptx.ChartType.line,
      pie: pptx.ChartType.pie,
      doughnut: pptx.ChartType.doughnut,
      area: pptx.ChartType.area
    };
    const chartType = chartTypes[el.chartType || 'bar'];
    if (!chartType) throw new Error('Unsupported chart type: ' + el.chartType);
    slide.addChart(chartType, el.data, Object.assign({
      x: el.x, y: el.y, w: el.w, h: el.h,
      showTitle: false,
      showLegend: false,
      showValue: false,
      chartColors: [theme.colors.primary, theme.colors.accent, '6B8F87', 'D8A17C'],
      catAxisLabelFontFace: theme.fonts.body,
      valAxisLabelFontFace: theme.fonts.body,
      catAxisLabelColor: theme.colors.muted,
      valAxisLabelColor: theme.colors.muted,
      valGridLine: { color: theme.colors.border, width: 0.6 }
    }, el.options || {}));
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
  const selectedTheme = deck.theme || options.theme || {};
  const theme = resolveTheme(selectedTheme);
  theme.fontFiles = Object.assign({}, (options.theme && options.theme.fontFiles) || {}, (deck.theme && deck.theme.fontFiles) || {});
  const fontManager = new FontManager({
    fontFiles: theme.fontFiles,
    fallbackFont: theme.fallbackFontFile || null
  });

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
    const warnings = validateSlide(elements, pageSize);
    elements.forEach((element, elementIndex) => {
      (element._layoutWarnings || []).forEach((message) => {
        warnings.push({ code: 'LAYOUT_WARNING', element: elementIndex, message });
      });
    });
    elements.forEach((element) => addElement(slide, element, theme, pptx));
    if (spec.notes) slide.addNotes(spec.notes);
    report.push({ slide: index + 1, warnings });
  }
  return { pptx, report, pageSize, fontReport: fontManager.inspect() };
}

function gradientFillXml(gradient) {
  const stops = gradient && gradient.stops;
  if (!Array.isArray(stops) || stops.length < 2) throw new Error('Gradient fill requires at least two color stops');
  const rawAngle = gradient.angle === undefined ? 0 : Number(gradient.angle);
  if (!Number.isFinite(rawAngle)) throw new Error('Gradient angle must be finite');
  const normalized = stops.map((stop, index) => {
    if (!stop || !Number.isFinite(Number(stop.position)) || Number(stop.position) < 0 || Number(stop.position) > 1) {
      throw new Error('Gradient stop ' + index + ' position must be between 0 and 1');
    }
    if (typeof stop.color !== 'string' || !/^#?[0-9a-f]{6}$/iu.test(stop.color)) {
      throw new Error('Gradient stop ' + index + ' color must be a six-digit hex color');
    }
    const transparency = stop.transparency === undefined ? 0 : Number(stop.transparency);
    if (!Number.isFinite(transparency) || transparency < 0 || transparency > 100) {
      throw new Error('Gradient stop ' + index + ' transparency must be between 0 and 100');
    }
    return { position: Math.round(Number(stop.position) * 100000), color: cleanColor(stop.color, '000000'), transparency };
  }).sort((a, b) => a.position - b.position);
  const angle = Math.round((((rawAngle % 360) + 360) % 360) * 60000);
  const stopXml = normalized.map((stop) =>
    '<a:gs pos="' + stop.position + '"><a:srgbClr val="' + stop.color + '">' +
    (stop.transparency ? '<a:alpha val="' + Math.round((100 - stop.transparency) * 1000) + '"/>' : '') +
    '</a:srgbClr></a:gs>'
  ).join('');
  return '<a:gradFill rotWithShape="1"><a:gsLst>' + stopXml +
    '</a:gsLst><a:lin ang="' + angle + '" scaled="1"/></a:gradFill>';
}

async function patchGradientFills(outputPath, deck) {
  const zip = await JSZip.loadAsync(fs.readFileSync(outputPath));
  for (let slideIndex = 0; slideIndex < deck.slides.length; slideIndex++) {
    const name = 'ppt/slides/slide' + (slideIndex + 1) + '.xml';
    const file = zip.file(name);
    if (!file) continue;
    let shapeIndex = 0;
    let patchedGradientCount = 0;
    // PptxGenJS serializes text, shapes, and lines as p:sp; images and graphic frames use other OOXML nodes.
    const shapeElements = deck.slides[slideIndex].elements.filter((element) =>
      element.type === 'text' || element.type === 'shape' || element.type === 'line'
    );
    let xml = await file.async('string');
    const serializedShapeCount = (xml.match(/<p:sp>/gu) || []).length;
    if (serializedShapeCount !== shapeElements.length) {
      throw new Error('Gradient patch alignment mismatch on slide ' + (slideIndex + 1) +
        ': Deck Spec has ' + shapeElements.length + ' text/shape elements but PPTX has ' + serializedShapeCount + ' p:sp elements');
    }
    xml = xml.replace(/<p:sp>([\s\S]*?)<\/p:sp>/gu, (whole, inner) => {
      const element = shapeElements[shapeIndex++];
      if (!element || element.type !== 'shape' || !element.gradient) return whole;
      const fillXml = gradientFillXml(element.gradient);
      const patched = inner.replace(/<a:solidFill>[\s\S]*?<\/a:solidFill>/u, fillXml);
      if (patched === inner) throw new Error('Unable to locate solid shape fill for gradient on slide ' + (slideIndex + 1) + ', element ' + (shapeIndex - 1));
      patchedGradientCount += 1;
      return '<p:sp>' + patched + '</p:sp>';
    });
    const expectedGradientCount = shapeElements.filter((element) => element.type === 'shape' && element.gradient).length;
    if (patchedGradientCount !== expectedGradientCount) {
      throw new Error('Gradient patch count mismatch on slide ' + (slideIndex + 1) +
        ': expected ' + expectedGradientCount + ', patched ' + patchedGradientCount);
    }
    zip.file(name, xml);
  }
  const buffer = await zip.generateAsync({ type: 'nodebuffer', compression: 'DEFLATE', compressionOptions: { level: 6 } });
  fs.writeFileSync(outputPath, buffer);
}

async function applyEastAsianFontPatch(outputPath, fontFace) {
  if (!fontFace) return;
  const zip = await JSZip.loadAsync(fs.readFileSync(outputPath));
  const targets = Object.keys(zip.files).filter((name) =>
    /^ppt\/(slides|slideMasters|slideLayouts)\/.*\.xml$/u.test(name) || /^ppt\/theme\/theme\d+\.xml$/u.test(name)
  );
  for (const name of targets) {
    const source = await zip.file(name).async('string');
    zip.file(name, patchEastAsianFonts(source, fontFace));
  }
  const buffer = await zip.generateAsync({ type: 'nodebuffer', compression: 'DEFLATE', compressionOptions: { level: 6 } });
  fs.writeFileSync(outputPath, buffer);
}

async function generatePptx(deck, outputPath, options = {}) {
  if (!outputPath) throw new Error('outputPath is required');
  const result = await buildPresentation(deck, options);
  await result.pptx.writeFile({ fileName: outputPath });
  if (deck.slides.some((slide) => slide.elements.some((element) => element.type === 'shape' && element.gradient))) await patchGradientFills(outputPath, deck);
  const cjkFace = (deck.theme && deck.theme.fonts && deck.theme.fonts.cjk) || (options.theme && options.theme.fonts && options.theme.fonts.cjk) || defaultTheme.fonts.cjk;
  await applyEastAsianFontPatch(outputPath, cjkFace);
  return {
    outputPath,
    report: result.report,
    pageSize: result.pageSize,
    fontReport: result.fontReport
  };
}

module.exports = { buildPresentation, generatePptx, applyEastAsianFontPatch, patchGradientFills, gradientFillXml, shapeStyle, isBoldWeight };
