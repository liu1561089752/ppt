'use strict';

const fs = require('node:fs');
const JSZip = require('jszip');
const pptxgen = require('pptxgenjs');
const { normalizePageSize } = require('../core/units');
const { validateDeck } = require('../core/schema');
const { layoutSlide, flattenElements } = require('./layout');
const { validateSlide } = require('./validation');
const { FontManager } = require('./font_manager');
const { patchEastAsianFonts } = require('./east_asian_font');
const {
  EMU_PER_INCH,
  EMU_PER_POINT,
  roundRectAdjustment,
  resolveImageGeometry,
  srcRectAttributes,
  tileOrigin
} = require('./image_fit');
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
  const options = {
    x: el.x, y: el.y, w: el.w, h: el.h,
    fontFace: el.fontFace || (isTitle ? theme.fonts.heading : theme.fonts.body),
    fontSize: el.fontSize || (isTitle ? theme.sizes[el.role] || theme.sizes.title : theme.sizes.body),
    color: cleanColor(el.color, theme.colors.foreground),
    bold: el.bold === undefined ? isBoldWeight(weight, false) : !!el.bold,
    italic: !!el.italic,
    underline: !!el.underline,
    strike: !!el.strike,
    charSpacing: el.charSpacing,
    // CSS `line-height` is a multiple of the *font size*; DrawingML `spcPct` is a
    // percentage of the font's own line box, which is ~1.2em, so a 200% multiple drew
    // lines ~20% taller than the analyser reserved and text spilled out of its box.
    // Points carry the CSS number exactly.
    lineSpacing: Number(((el.lineSpacingMultiple || theme.typography.lineSpacingMultiple
      || theme.lineSpacingMultiple || 1.22) * (el.fontSize
      || (isTitle ? theme.sizes[el.role] || theme.sizes.title : theme.sizes.body))).toFixed(2)),
    paraSpaceBeforePt: el.paraSpaceBeforePt,
    bullet: el.bullet,
    margin: Number.isFinite(el.margin) ? el.margin : 0,
    valign: el.valign || 'middle',
    align: el.align || 'left',
    paraSpaceAfterPt: el.paraSpaceAfterPt || 0,
    // No autofit: the analyzer already measured this box to the line, so letting the
    // renderer shrink the glyphs to fit would trade a designed size for a guess at
    // metrics it never told us. Wrapping is 10% conservative, so it wraps at most as
    // often as the renderer does and the box stays big enough.
    fit: 'none',
    transparency: el.transparency || 0,
    rotate: el.rotate || 0,
    isTextBox: true
  };
  // `white-space: nowrap` is `bodyPr wrap="none"`: the line is never broken, so it
  // overflows the box instead of reflowing inside it. Autofit has to be off as well,
  // because `normAutofit` shrinks the text box back and the renderer re-wraps it.
  if (el.nowrap) {
    options.wrap = false;
    options.fit = 'none';
  }
  // `writing-mode: vertical-rl` is `bodyPr vert="eaVert"`. The box comes from the
  // author (height = line length), so autofit stays off: `normAutofit` would shrink
  // the glyphs to fit instead of adding the column the CSS would add.
  if (el.vert) {
    options.vert = el.vert;
    options.fit = 'none';
  }
  // The writer's own `hyperlink` option is deliberately not used for a text box: it writes the
  // click on the box AND a click on every run, and the run click brings the writer's underline.
  // A box link is written by `patchShapeHyperlinks` instead - the same `cNvPr` child the writer
  // would have produced, without touching a run.
  return options;
}

function shapeStyle(el, theme) {
  const fill = el.fill === false
    ? { color: 'FFFFFF', transparency: 100 }
    : {
        color: cleanColor(el.fill, theme.colors.surface),
        transparency: el.fillTransparency === undefined
          ? (el.transparency === undefined ? 0 : el.transparency)
          : el.fillTransparency
      };
  const line = el.line === false
    ? { color: 'FFFFFF', transparency: 100 }
    : {
        color: cleanColor(el.lineColor, theme.colors.border),
        width: el.lineWidth === undefined ? 0.8 : el.lineWidth,
        transparency: el.lineTransparency === undefined ? 0 : el.lineTransparency,
        // pptxgenjs spells the line dash as `dashType`; a bare `dash` is ignored and
        // every styled border drew solid.
        dashType: el.lineDash || el.dash
      };
  const options = {
    x: el.x, y: el.y, w: el.w, h: el.h,
    rectRadius: el.radius,
    rotate: el.rotate || 0,
    transparency: el.transparency === undefined ? 0 : el.transparency,
    fill,
    line
  };
  // A clickable surface gets its click from `patchShapeHyperlinks`, not from the writer: one
  // route for every object the anchor produced means one relationship per url and no run-level
  // click anywhere.
  if (el.shadow) {
    const shadow = typeof el.shadow === 'object' ? el.shadow : {};
    options.shadow = {
      type: shadow.type || 'outer',
      color: cleanColor(shadow.color, '000000'),
      opacity: shadow.opacity === undefined ? 0.18 : shadow.opacity,
      blur: shadow.blur === undefined ? 4 : shadow.blur,
      angle: shadow.angle === undefined ? 45 : shadow.angle,
      // The writer spells the offset `offset` (in points); `distance` was accepted and
      // then ignored, which put every shadow directly under its shape.
      offset: shadow.offset === undefined
        ? (shadow.distance === undefined ? 2 : shadow.distance)
        : shadow.offset
    };
  }
  return options;
}

function addElement(slide, el, theme, pptx, context = {}) {
  if (el.type === 'container') {
    throw new Error('Container elements must be resolved by the layout engine before serialization');
  }
  if (el.type === 'text') {
    const opts = textOptions(el, theme);
    if (Array.isArray(el.text)) {
      const runs = el.text.map((run) => {
        if (typeof run === 'string') return { text: run, options: {} };
        return {
          text: run.text || '',
          options: Object.assign({}, run.options || {}, {
            fontFace: (run.options && run.options.fontFace) || opts.fontFace
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
    let geometry = resolveImageGeometry(el, context.image || {});
    // A repeating layer paints its whole box: `<a:tile>` anchors the pattern at the frame's
    // corner and the frame clips it, so a fitted (letterboxed) frame would leave the pattern
    // short of the edges the CSS painted - and the cell is a percentage of the frame, so the
    // frame decides the pattern's scale. The box it fills is the element's own.
    if (el.tile) {
      const box = {
        x: Number(el.x), y: Number(el.y), w: Number(el.w), h: Number(el.h)
      };
      if ([box.x, box.y, box.w, box.h].every(Number.isFinite)) {
        geometry = { fit: 'stretch', box, srcRect: null, natural: geometry.natural };
      }
    }
    // The writer reads media while it assembles the package, long after this call, so a source
    // that cannot be read has to be caught here. It costs this picture and one line in the
    // report; it used to abort the whole deck, every other slide included.
    if (el.path && !pictureIsReadable(el.path, context.image)) {
      if (Array.isArray(context.droppedPictures)) {
        context.droppedPictures.push({
          slide: (context.slideIndex || 0) + 1,
          source: el.path,
          reason: 'The picture file could not be read, so it is missing from the slide - check the path, or inline the image as a data URI'
        });
      }
      return;
    }
    const source = el.path ? { path: el.path } : { data: el.data };
    const imageOptions = Object.assign(source, {
      x: geometry.box.x, y: geometry.box.y, w: geometry.box.w, h: geometry.box.h,
      transparency: el.transparency || 0
    });
    if (el.altText) imageOptions.altText = el.altText;
    // An `<a href>` around a picture is a link a reader can click, and the writer spells it as
    // `<a:hlinkClick>` on the picture plus an external relationship. The url travels verbatim:
    // a value that needs escaping is the writer's problem, and rewriting it would move the
    // reader to a page the author never named.
    if (el.hyperlink && el.hyperlink.url) {
      imageOptions.hyperlink = { url: String(el.hyperlink.url) };
    }
    if (el.rotate !== undefined) imageOptions.rotate = el.rotate;
    if (el.flipH) imageOptions.flipH = true;
    if (el.flipV) imageOptions.flipV = true;
    try {
      slide.addImage(imageOptions);
    } catch (error) {
      // A picture whose bytes cannot be read used to abort the whole deck at the last moment,
      // long after the report had been assembled and long after every other slide was fine.
      // It costs this picture and one line in the report instead.
      if (Array.isArray(context.droppedPictures)) {
        context.droppedPictures.push({
          slide: (context.slideIndex || 0) + 1,
          source: el.path || '(inline data)',
          reason: 'The picture could not be read, so it is missing from the slide: '
            + String((error && error.message) || error).split('\n')[0]
        });
      }
      return;
    }
    if (Array.isArray(context.imagePlans)) context.imagePlans.push(buildImagePlan(el, geometry));
    // One entry per picture the writer really placed, in the order it emitted them, so the tile
    // patch can pair `p:pic` with the element that asked for the pattern - or prove it cannot.
    if (Array.isArray(context.tileFills)) {
      context.tileFills.push(el.tile ? { tile: el.tile, box: geometry.box, focus: el.focus } : null);
    }
  } else if (el.type === 'chart') {
    const chartTypes = {
      bar: pptx.ChartType.bar,
      line: pptx.ChartType.line,
      pie: pptx.ChartType.pie,
      doughnut: pptx.ChartType.doughnut,
      area: pptx.ChartType.area,
      radar: pptx.ChartType.radar,
      scatter: pptx.ChartType.scatter,
      bubble: pptx.ChartType.bubble
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
      valGridLine: { color: theme.colors.border, size: 0.6 },
      // Axis titles must use the deck face: PptxGenJS defaults to Arial and black,
      // which looks imported next to a themed chart. Colours stay as declared by the
      // deck (`data-chart-text-color`) because a chart can sit on a light panel.
      titleFontFace: theme.fonts.heading || theme.fonts.body,
      catAxisTitleFontFace: theme.fonts.body,
      valAxisTitleFontFace: theme.fonts.body,
      legendFontFace: theme.fonts.body
    }, el.options || {}));
  } else if (el.type === 'table') {
    // A cell whose words carry their own styling arrives as `rowsPayload`: the same rows, with
    // the writer's run array in place of the string. The spec keeps `rows` because the row-height
    // estimate and the cell patches read one paragraph per string there.
    slide.addTable(el.rowsPayload || el.rows || [], Object.assign({
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

function normalizeShadowOptions(shadow) {
  const source = shadow === true || !shadow || typeof shadow !== 'object' ? {} : shadow;
  return {
    type: source.type || 'outer',
    color: cleanColor(source.color, '000000'),
    opacity: source.opacity === undefined ? 0.18 : source.opacity,
    blur: source.blur === undefined ? 4 : source.blur,
    angle: source.angle === undefined ? 45 : source.angle,
    distance: source.distance === undefined ? 2 : source.distance
  };
}

/**
 * Collect the OOXML-level changes an image element needs beyond what PptxGenJS
 * can express: source-rectangle cropping, rounded corners, an outline, and an
 * outer shadow. Returns null when the element is a plain stretched picture.
 */
function buildImagePlan(el, geometry) {
  const plan = {};
  let required = false;
  if (geometry && geometry.srcRect) {
    plan.srcRect = geometry.srcRect;
    required = true;
  }
  const adjustment = roundRectAdjustment(el.radius, geometry.box);
  if (adjustment !== null) {
    plan.geometry = { prst: 'roundRect', adj: adjustment };
    required = true;
  }
  if (el.line !== false && (el.lineColor !== undefined || el.lineWidth !== undefined)) {
    plan.line = {
      color: cleanColor(el.lineColor, '000000'),
      width: el.lineWidth === undefined ? 0.75 : el.lineWidth,
      transparency: el.lineTransparency === undefined ? 0 : el.lineTransparency,
      dash: el.lineDash || el.dash
    };
    required = true;
  }
  if (el.shadow !== undefined && el.shadow !== false) {
    plan.shadow = normalizeShadowOptions(el.shadow);
    required = true;
  }
  // A photo filter is a set of `<a:blip>` colour transforms; PptxGenJS writes none of them.
  if (el.imageFilter) {
    plan.blip = el.imageFilter;
    required = true;
  }
  return required ? plan : null;
}

function imageSpPrExtras(plan) {
  const parts = [];
  if (plan.line) {
    const width = Math.max(1, Math.round(plan.line.width * EMU_PER_POINT));
    const alpha = plan.line.transparency ? '<a:alpha val="' + Math.round((100 - plan.line.transparency) * 1000) + '"/>' : '';
    const dash = plan.line.dash ? '<a:prstDash val="' + plan.line.dash + '"/>' : '';
    parts.push('<a:ln w="' + width + '" cap="flat" cmpd="sng" algn="ctr"><a:solidFill><a:srgbClr val="' +
      plan.line.color + '">' + alpha + '</a:srgbClr></a:solidFill>' + dash + '</a:ln>');
  }
  if (plan.shadow) {
    const shadow = plan.shadow;
    // 60000 units per degree, matching DrawingML `dir`; blur/distance are points.
    const direction = Math.round((((Number(shadow.angle) || 0) % 360) + 360) % 360 * 60000);
    parts.push('<a:effectLst><a:' + shadow.type + 'Shdw' +
      (shadow.type === 'outer' ? ' sx="100000" sy="100000" kx="0" ky="0" algn="bl" rotWithShape="0"' : '') +
      ' blurRad="' + Math.round(shadow.blur * EMU_PER_POINT) + '"' +
      ' dist="' + Math.round(shadow.distance * EMU_PER_POINT) + '"' +
      ' dir="' + direction + '"><a:srgbClr val="' + shadow.color + '"><a:alpha val="' +
      Math.round(shadow.opacity * 100000) + '"/></a:srgbClr></a:' + shadow.type + 'Shdw></a:effectLst>');
  }
  return parts.join('');
}

/**
 * The `<a:blip>` colour transforms: `<a:grayscl/>`, then `<a:lum bright contrast/>`, then
 * `<a:alphaModFix/>`. ECMA-376 allows them in any order inside the blip.
 */
function blipTransformXml(filter) {
  const parts = [];
  if (filter.grayscale) parts.push('<a:grayscl/>');
  const bright = Number(filter.brightness) || 0;
  const contrast = Number(filter.contrast) || 0;
  if (bright || contrast) {
    parts.push('<a:lum bright="' + Math.round(bright * 1000) + '" contrast="' + Math.round(contrast * 1000) + '"/>');
  }
  if (filter.opacity !== undefined && Number(filter.opacity) < 1) {
    parts.push('<a:alphaModFix amt="' + Math.round(Math.max(0, Number(filter.opacity)) * 100000) + '"/>');
  }
  return parts.join('');
}

function applyBlipTransforms(xml, filter) {
  const transforms = blipTransformXml(filter);
  if (!transforms) return xml;
  const pattern = /<a:blip([^>]*?)(\/?)>([\s\S]*?)<\/a:blip>|<a:blip([^>]*?)\/>/u;
  if (!pattern.test(xml)) throw new Error('Unable to locate the picture blip for a filter patch');
  return xml.replace(/<a:blip([^>]*?)\/>|<a:blip([^>]*?)>([\s\S]*?)<\/a:blip>/u,
    (whole, selfAttrs, openAttrs, inner) => {
      const attrs = selfAttrs !== undefined ? selfAttrs : openAttrs;
      // Idempotent: a repeated patch drops its own transforms before writing them again.
      const kept = String(inner || '').replace(/<a:(grayscl|lum|alphaModFix)\b[^>]*\/>|<a:lum\b[^>]*\/>/gu, '');
      return '<a:blip' + attrs + '>' + transforms + kept + '</a:blip>';
    });
}

function applyImagePlan(picXml, plan) {
  let xml = picXml;
  if (plan.blip) xml = applyBlipTransforms(xml, plan.blip);
  if (plan.srcRect) {
    const attributes = srcRectAttributes(plan.srcRect);
    if (/<a:srcRect\b[^>]*\/>/u.test(xml)) {
      xml = xml.replace(/<a:srcRect\b[^>]*\/>/u, '<a:srcRect ' + attributes + '/>');
    } else if (/<a:stretch><a:fillRect\/><\/a:stretch>/u.test(xml)) {
      xml = xml.replace('<a:stretch><a:fillRect/></a:stretch>',
        '<a:srcRect ' + attributes + '/><a:stretch><a:fillRect/></a:stretch>');
    } else {
      throw new Error('Unable to locate the picture blip fill for an image crop patch');
    }
  }
  const extras = imageSpPrExtras(plan);
  if (!plan.geometry && !extras) return xml;
  // Drop any pre-existing outline/effect so repeated patches stay idempotent.
  xml = xml.replace(/<a:ln[\s>][\s\S]*?<\/a:ln>/gu, '').replace(/<a:effectLst[\s>][\s\S]*?<\/a:effectLst>/gu, '');
  const geometryPattern = /<a:prstGeom prst="[^"]*">[\s\S]*?<\/a:prstGeom>/u;
  if (!geometryPattern.test(xml)) {
    throw new Error('Unable to locate the picture geometry for an image effect patch');
  }
  xml = xml.replace(geometryPattern, (whole) => {
    const geometry = plan.geometry
      ? '<a:prstGeom prst="' + plan.geometry.prst + '"><a:avLst><a:gd name="adj" fmla="val ' +
        plan.geometry.adj + '"/></a:avLst></a:prstGeom>'
      : whole;
    return geometry + extras;
  });
  return xml;
}

async function patchImageEffects(outputPath, plansBySlide) {
  const slides = Array.isArray(plansBySlide) ? plansBySlide : [];
  const needed = slides.some((plans) => Array.isArray(plans) && plans.some(Boolean));
  if (!needed) return false;
  const zip = await JSZip.loadAsync(fs.readFileSync(outputPath));
  for (let slideIndex = 0; slideIndex < slides.length; slideIndex += 1) {
    const plans = slides[slideIndex] || [];
    if (!plans.some(Boolean)) continue;
    const name = 'ppt/slides/slide' + (slideIndex + 1) + '.xml';
    const file = zip.file(name);
    if (!file) continue;
    let xml = await file.async('string');
    const pictureCount = (xml.match(/<p:pic>/gu) || []).length;
    if (pictureCount !== plans.length) {
      throw new Error('Image patch alignment mismatch on slide ' + (slideIndex + 1) +
        ': Deck Spec has ' + plans.length + ' image elements but PPTX has ' + pictureCount + ' p:pic elements');
    }
    let index = 0;
    xml = xml.replace(/<p:pic>[\s\S]*?<\/p:pic>/gu, (whole) => {
      const plan = plans[index++];
      return plan ? applyImagePlan(whole, plan) : whole;
    });
    zip.file(name, xml);
  }
  const buffer = await zip.generateAsync({ type: 'nodebuffer', compression: 'DEFLATE', compressionOptions: { level: 6 } });
  fs.writeFileSync(outputPath, buffer);
  return true;
}

/**
 * A repeating background is DrawingML's `<a:tile>`: one cell, expressed as a percentage of the
 * picture's own frame, and the reader repeats it. The writer only ever writes
 * `<a:stretch><a:fillRect/></a:stretch>`, so a repeating layer used to arrive as a single
 * stretched copy - the pattern collapsed into one enormous cell, which is not what
 * `background-repeat` asked for.
 *
 * `sx`/`sy` are the cell against the frame, in ST_Percentage (100000 = the frame's own size).
 * The axis that does not repeat keeps `100000`, which is exactly the un-repeated picture
 * stretched across that axis - one cell is not a repeat - and its offset stays 0, because a
 * shift on that axis would drag the single cell against the wrap and paint a seam at the edge.
 * `tx`/`ty` move the pattern's origin by a percentage of the cell, negative when it starts
 * before the box's corner. A tiled fill has no stretch left for a source rectangle to describe,
 * so any `<a:srcRect>` is dropped.
 */
function applyTileFill(picXml, plan) {
  const tile = plan.tile;
  const box = plan.box;
  const origin = tileOrigin(plan.focus, box, tile);
  const percent = (value) => Math.round(value * 100000);
  const node = '<a:tile tx="' + (tile.x ? percent(origin.x / tile.width) : 0)
    + '" ty="' + (tile.y ? percent(origin.y / tile.height) : 0)
    + '" sx="' + (tile.x ? percent(tile.width / box.w) : 100000)
    + '" sy="' + (tile.y ? percent(tile.height / box.h) : 100000)
    + '" flip="none" algn="tl"/>';
  const xml = String(picXml).replace(/<a:srcRect\b[^>]*\/>/gu, '');
  // Idempotent: a second run replaces its own tile node instead of looking for the stretch it
  // already replaced.
  if (/<a:tile\b[^>]*\/>/u.test(xml)) return xml.replace(/<a:tile\b[^>]*\/>/u, node);
  const stretch = /<a:stretch\s*\/>|<a:stretch>[\s\S]*?<\/a:stretch>/u;
  if (!stretch.test(xml)) throw new Error('Unable to locate the picture fill for a tile patch');
  return xml.replace(stretch, node);
}

/** The frame a picture was really drawn in, in inches, read back from its own geometry. */
function pictureFrameInches(picXml) {
  const ext = /<a:ext\s+cx="(\d+)"\s+cy="(\d+)"\/>/u.exec(String(picXml));
  if (!ext) throw new Error('Unable to read the picture frame for a tile patch');
  return { w: Number(ext[1]) / EMU_PER_INCH, h: Number(ext[2]) / EMU_PER_INCH };
}

/**
 * Tiled picture fills, one entry per picture the writer emitted and `null` for the rest - the
 * same pairing `patchImageEffects` uses, because both patch the same `p:pic` nodes in order.
 * The cell is a percentage of the frame, so the frame is checked against the spec box: a tile
 * scaled against a fitted (letterboxed) frame would draw a smaller pattern than the design.
 */
async function patchTiledFills(outputPath, tilesBySlide) {
  const slides = Array.isArray(tilesBySlide) ? tilesBySlide : [];
  const needed = slides.some((plans) => Array.isArray(plans) && plans.some(Boolean));
  if (!needed) return false;
  const zip = await JSZip.loadAsync(fs.readFileSync(outputPath));
  let touched = 0;
  for (let slideIndex = 0; slideIndex < slides.length; slideIndex += 1) {
    const plans = slides[slideIndex] || [];
    if (!plans.some(Boolean)) continue;
    const name = 'ppt/slides/slide' + (slideIndex + 1) + '.xml';
    const file = zip.file(name);
    if (!file) continue;
    const xml = await file.async('string');
    const pictureCount = (xml.match(/<p:pic>/gu) || []).length;
    if (pictureCount !== plans.length) {
      throw new Error('Tile patch alignment mismatch on slide ' + (slideIndex + 1)
        + ': Deck Spec has ' + plans.length + ' image elements but PPTX has ' + pictureCount + ' p:pic elements');
    }
    let index = 0;
    let patched = 0;
    const next = xml.replace(/<p:pic>[\s\S]*?<\/p:pic>/gu, (whole) => {
      const plan = plans[index];
      index += 1;
      if (!plan) return whole;
      const frame = pictureFrameInches(whole);
      if (Math.abs(frame.w - plan.box.w) > 0.01 || Math.abs(frame.h - plan.box.h) > 0.01) {
        throw new Error('Tile patch frame mismatch on slide ' + (slideIndex + 1) + ': the spec box is '
          + plan.box.w + 'x' + plan.box.h + 'in but the picture frame is ' + frame.w + 'x' + frame.h + 'in');
      }
      const updated = applyTileFill(whole, plan);
      if (updated !== whole) patched += 1;
      return updated;
    });
    if (!patched) continue;
    zip.file(name, next);
    touched += 1;
  }
  if (!touched) return false;
  const buffer = await zip.generateAsync({ type: 'nodebuffer', compression: 'DEFLATE', compressionOptions: { level: 6 } });
  fs.writeFileSync(outputPath, buffer);
  return true;
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
  const imagePlans = [];
  const tiledFills = [];
  const droppedPictures = [];
  // The patches below rewrite `slideN.xml` by walking the elements in order, so they need
  // the *laid out* list: a container contributes its background, its single-side border
  // strips and its overlays on top of the elements the spec lists.
  const laidOut = [];
  for (const [index, spec] of deck.slides.entries()) {
    const slide = pptx.addSlide();
    slide.background = { color: cleanColor(spec.background, theme.colors.background) };
    const elements = layoutSlide(spec, pageSize, theme, { fontManager });
    laidOut.push(elements);
    const warnings = validateSlide(elements, pageSize);
    elements.forEach((element, elementIndex) => {
      (element._layoutWarnings || []).forEach((message) => {
        warnings.push({ code: 'LAYOUT_WARNING', element: elementIndex, message });
      });
    });
    const slidePlans = [];
    const slideTiles = [];
    elements.forEach((element) => addElement(slide, element, theme, pptx, {
      image: { readFile: options.readImageFile },
      imagePlans: slidePlans,
      tileFills: slideTiles,
      droppedPictures,
      slideIndex: index
    }));
    if (spec.notes) slide.addNotes(spec.notes);
    imagePlans.push(slidePlans);
    tiledFills.push(slideTiles);
    report.push({ slide: index + 1, warnings });
  }
  return { pptx, report, pageSize, fontReport: fontManager.inspect(), imagePlans, tiledFills, laidOut, droppedPictures };
}

/** Can the bytes behind this source be read? A `data:` source carries its own. */
function pictureIsReadable(file, imageOptions) {
  if (/^data:/iu.test(String(file))) return true;
  try {
    if (imageOptions && typeof imageOptions.readFile === 'function') {
      const bytes = imageOptions.readFile(file);
      return Boolean(bytes && bytes.length);
    }
    return fs.existsSync(file);
  } catch (error) {
    return false;
  }
}

/**
 * The laid-out elements of one slide, when the caller supplied them, flattened to the
 * order PptxGenJS serializes `p:sp` nodes in. Falls back to the spec so the helpers stay
 * usable on their own.
 */
function supplied(laidOut, slides) {
  if (Array.isArray(laidOut) && laidOut.length === slides.length) return laidOut;
  return slides.map((slide) => flattenElements(slide.elements));
}

function serializedShapes(laidOut, slideIndex, deck) {
  const slides = (deck && deck.slides) || [];
  const elements = supplied(laidOut, slides)[slideIndex] || [];
  return elements.filter((element) =>
    element.type === 'text' || element.type === 'shape' || element.type === 'line'
  );
}

function gradientFillXml(gradient, baseTransparency = 0) {
  if (!Number.isFinite(baseTransparency) || baseTransparency < 0 || baseTransparency > 100) {
    throw new Error('Gradient base transparency must be between 0 and 100');
  }
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
    const stopTransparency = stop.transparency === undefined ? 0 : Number(stop.transparency);
    if (!Number.isFinite(stopTransparency) || stopTransparency < 0 || stopTransparency > 100) {
      throw new Error('Gradient stop ' + index + ' transparency must be between 0 and 100');
    }
    const transparency = 100 - ((100 - stopTransparency) * (100 - baseTransparency) / 100);
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

async function patchGradientFills(outputPath, deck, laidOut) {
  const zip = await JSZip.loadAsync(fs.readFileSync(outputPath));
  for (let slideIndex = 0; slideIndex < deck.slides.length; slideIndex++) {
    const name = 'ppt/slides/slide' + (slideIndex + 1) + '.xml';
    const file = zip.file(name);
    if (!file) continue;
    let shapeIndex = 0;
    let patchedGradientCount = 0;
    // PptxGenJS serializes text, shapes, and lines as p:sp; images and graphic frames use other OOXML nodes.
    const shapeElements = serializedShapes(laidOut, slideIndex, deck);
    let xml = await file.async('string');
    const serializedShapeCount = (xml.match(/<p:sp>/gu) || []).length;
    if (serializedShapeCount !== shapeElements.length) {
      throw new Error('Gradient patch alignment mismatch on slide ' + (slideIndex + 1) +
        ': Deck Spec has ' + shapeElements.length + ' text/shape elements but PPTX has ' + serializedShapeCount + ' p:sp elements');
    }
    xml = xml.replace(/<p:sp>([\s\S]*?)<\/p:sp>/gu, (whole, inner) => {
      const element = shapeElements[shapeIndex++];
      if (!element || element.type !== 'shape' || !element.gradient) return whole;
      const baseTransparency = element.fillTransparency === undefined
        ? (element.transparency === undefined ? 0 : element.transparency)
        : element.fillTransparency;
      const fillXml = gradientFillXml(element.gradient, baseTransparency);
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

/**
 * An inset `box-shadow` is DrawingML's `<a:innerShdw>`, which PptxGenJS cannot write: its
 * `shadow` option always produces an outer shadow. The node is patched into the shape's
 * `spPr` here, beside any outer shadow the writer already emitted.
 */
function innerShadowXml(shadow) {
  const direction = Math.round((((Number(shadow.angle) || 0) % 360) + 360) % 360 * 60000);
  // Points, not EMU: rounding the inches first turned a 1.5pt offset into 2pt.
  const blur = Math.max(0, Number(shadow.blur) || 0);
  const distance = Math.max(0, Number(shadow.distance) || 0);
  return '<a:innerShdw blurRad="' + Math.round(blur * EMU_PER_POINT) + '"'
    + ' dist="' + Math.round(distance * EMU_PER_POINT) + '"'
    + ' dir="' + direction + '">'
    + '<a:srgbClr val="' + cleanColor(shadow.color, '000000') + '">'
    + '<a:alpha val="' + Math.round((Number(shadow.opacity) || 0.2) * 100000) + '"/>'
    + '</a:srgbClr></a:innerShdw>';
}

function applyInnerShadow(shapeXml, shadow) {
  // Idempotent: a repeated patch replaces its own node instead of stacking a second one.
  let xml = shapeXml.replace(/<a:innerShdw\b[\s\S]*?<\/a:innerShdw>/gu, '');
  const node = innerShadowXml(shadow);
  if (/<a:effectLst>([\s\S]*?)<\/a:effectLst>/u.test(xml)) {
    return xml.replace(/<a:effectLst>([\s\S]*?)<\/a:effectLst>/u,
      (whole, inner) => '<a:effectLst>' + inner.replace(/^\s*<a:effectLst\/>|^\s*$/u, '') + node + '</a:effectLst>');
  }
  if (/<a:effectLst\/>/u.test(xml)) return xml.replace('<a:effectLst/>', '<a:effectLst>' + node + '</a:effectLst>');
  // No effect list yet: CT_ShapeProperties puts effectLst after ln and before scene3d/extLst,
  // and the writer emits nothing after ln for a plain shape, so the end of spPr is right.
  if (!/<\/p:spPr>/u.test(xml)) throw new Error('Unable to locate spPr for an inner shadow patch');
  return xml.replace(/<\/p:spPr>/u, '<a:effectLst>' + node + '</a:effectLst></p:spPr>');
}

/**
 * A text shadow is a run property: every `<a:rPr>` of the shape gets its own
 * `<a:effectLst><a:outerShdw>`. PptxGenJS writes no run effects at all, so the nodes are
 * patched in here. WPS draws them; LibreOffice ignores them (same as `<a:innerShdw>`).
 */
function applyTextShadow(shapeXml, shadow) {
  const direction = Math.round((((Number(shadow.angle) || 0) % 360) + 360) % 360 * 60000);
  const node = '<a:effectLst><a:outerShdw blurRad="'
    + Math.round((Number(shadow.blur) || 0) * EMU_PER_POINT) + '"'
    + ' dist="' + Math.round((Number(shadow.distance) || 0) * EMU_PER_POINT) + '"'
    + ' dir="' + direction + '" algn="t" rotWithShape="0">'
    + '<a:srgbClr val="' + cleanColor(shadow.color, '000000') + '">'
    + '<a:alpha val="' + Math.round((Number(shadow.opacity) || 0.2) * 100000) + '"/>'
    + '</a:srgbClr></a:outerShdw></a:effectLst>';
  let patched = 0;
  // Idempotent, and it keeps whatever the run already carried: the effect list goes in at
  // the end of the run properties, which is where CT_TextCharacterProperties allows it.
  const xml = shapeXml
    .replace(/<a:rPr([^>]*)\/>/gu, (whole, attrs) => { patched += 1; return '<a:rPr' + attrs + '>' + node + '</a:rPr>'; })
    .replace(/<a:rPr([^>]*)>((?:(?!<\/a:rPr>)[\s\S])*?)<\/a:rPr>/gu, (whole, attrs, inner) => {
      if (inner.includes('<a:effectLst')) return whole;
      patched += 1;
      return '<a:rPr' + attrs + '>' + inner + node + '</a:rPr>';
    });
  return patched ? xml : null;
}

async function patchTextShadows(outputPath, deck, laidOut) {
  const zip = await JSZip.loadAsync(fs.readFileSync(outputPath));
  let patched = 0;
  for (let slideIndex = 0; slideIndex < deck.slides.length; slideIndex++) {
    const shapes = serializedShapes(laidOut, slideIndex, deck);
    if (!shapes.some((element) => element.textShadow)) continue;
    const name = 'ppt/slides/slide' + (slideIndex + 1) + '.xml';
    const file = zip.file(name);
    if (!file) continue;
    let xml = await file.async('string');
    let shapeIndex = 0;
    xml = xml.replace(/<p:sp>([\s\S]*?)<\/p:sp>/gu, (whole, inner) => {
      const element = shapes[shapeIndex++];
      if (!element || !element.textShadow) return whole;
      const next = applyTextShadow(inner, element.textShadow);
      if (!next) return whole;
      patched += 1;
      return '<p:sp>' + next + '</p:sp>';
    });
    zip.file(name, xml);
  }
  if (!patched) return;
  const buffer = await zip.generateAsync({ type: 'nodebuffer', compression: 'DEFLATE', compressionOptions: { level: 6 } });
  fs.writeFileSync(outputPath, buffer);
}

async function patchInnerShadows(outputPath, deck, laidOut) {
  const zip = await JSZip.loadAsync(fs.readFileSync(outputPath));
  let patched = 0;
  for (let slideIndex = 0; slideIndex < deck.slides.length; slideIndex++) {
    const shapes = serializedShapes(laidOut, slideIndex, deck);
    if (!shapes.some((element) => element.innerShadow)) continue;
    const name = 'ppt/slides/slide' + (slideIndex + 1) + '.xml';
    const file = zip.file(name);
    if (!file) continue;
    let xml = await file.async('string');
    let shapeIndex = 0;
    xml = xml.replace(/<p:sp>([\s\S]*?)<\/p:sp>/gu, (whole, inner) => {
      const element = shapes[shapeIndex++];
      if (!element || !element.innerShadow) return whole;
      patched += 1;
      return '<p:sp>' + applyInnerShadow(inner, element.innerShadow) + '</p:sp>';
    });
    zip.file(name, xml);
  }
  if (!patched) return;
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

/**
 * Add `<a:pPr indent="…">` to every paragraph of a text box that declares a
 * first-line indent (`text-indent`). DrawingML calls it `indent` on the paragraph
 * properties; PptxGenJS has no option for it and reads `indent` as bullet spacing,
 * so the attribute is written here instead of being approximated in layout.
 *
 * Shape order in `slideN.xml` matches the deck spec's text/shape/line order, the
 * same alignment `patchGradientFills` relies on.
 */
function applyTextIndent(xml, indentIn) {
  const emu = Math.round(indentIn * 914400);
  if (!emu) return xml;
  return xml.replace(/<a:p>([\s\S]*?)<\/a:p>/gu, (whole, body) => {
    const pPr = /<a:pPr([^>]*?)(\/?)>/u.exec(body);
    if (!pPr) return '<a:p><a:pPr indent="' + emu + '"/>' + body + '</a:p>';
    const existing = /\bindent="(-?\d+)"/u.exec(pPr[1]);
    // A hanging bullet indent is negative; a first-line indent adds to it, which is
    // what CSS does when both apply to the same paragraph.
    const merged = existing
      ? pPr[1].replace(/\bindent="(-?\d+)"/u, 'indent="' + (Number(existing[1]) + emu) + '"')
      : pPr[1] + ' indent="' + emu + '"';
    return '<a:p>' + body.replace(pPr[0], '<a:pPr' + merged + (pPr[2] || '') + '>') + '</a:p>';
  });
}

/**
 * `numCol`/`spcCol` on `a:bodyPr` is how DrawingML spells a columned text box, and the
 * writer has no option for it, so the part is patched the same way text indents are: the
 * elements come back in the order they were serialized, and every `<p:sp>` is paired with
 * the element that produced it. A mismatch in either direction throws rather than patching
 * the wrong box.
 */
function applyTextColumns(xml, count, gapIn) {
  const columns = Math.max(2, Math.min(16, Math.floor(Number(count) || 0)));
  const spacing = Math.max(0, Math.round((Number(gapIn) || 0) * 914400));
  const extras = ' numCol="' + columns + '"' + (spacing ? ' spcCol="' + spacing + '"' : '');
  return xml.replace(/<a:bodyPr([^>]*?)(\/?)>/u, (whole, attrs, selfClose) => {
    const cleaned = attrs
      .replace(/\s*numCol="[^"]*"/gu, '')
      .replace(/\s*spcCol="[^"]*"/gu, '');
    return '<a:bodyPr' + cleaned + extras + (selfClose || '') + '>';
  });
}

/**
 * A CSS `polygon()` clip is a `custGeom` path: the shape cannot paint outside its own
 * geometry, which is the same constraint CSS gives the clip. Points arrive in CSS pixels
 * relative to the border box, and `a:path` scales that space onto the shape's extents.
 */
function clipGeometryXml(clip) {
  // An inscribed circle/ellipse clip is the native ellipse preset, not a polygon:
  // the geometry lands as prstGeom and needs no patch at all.
  if (clip && clip.ellipse) return null;
  const points = (clip && Array.isArray(clip.points) ? clip.points : [])
    .filter((point) => Array.isArray(point) && point.length === 2)
    .map((point) => '<a:pt x="' + Math.round(point[0]) + '" y="' + Math.round(point[1]) + '"/>');
  if (points.length < 3) return null;
  const width = Math.max(1, Math.round(clip.width || 1));
  const height = Math.max(1, Math.round(clip.height || 1));
  return '<a:custGeom><a:avLst/><a:gdLst/><a:ahLst/><a:cxnLst/>'
    + '<a:rect l="0" t="0" r="r" b="b"/><a:pathLst><a:path w="' + width + '" h="' + height + '">'
    + '<a:moveTo>' + points[0] + '</a:moveTo>'
    + points.slice(1).map((point) => '<a:lnTo>' + point + '</a:lnTo>').join('')
    + '<a:close/></a:path></a:pathLst></a:custGeom>';
}

function applyClipGeometry(xml, clip) {
  const geometry = clipGeometryXml(clip);
  if (!geometry) return xml;
  const pattern = /<a:prstGeom[\s\S]*?<\/a:prstGeom>/u;
  if (!pattern.test(xml)) return xml;
  return xml.replace(pattern, geometry);
}

async function patchClipGeometry(outputPath, deck, laidOut) {
  const slides = (deck && deck.slides) || [];
  const clipped = (element) => element && element.clip && Array.isArray(element.clip.points)
    && element.clip.points.length >= 3;
  if (!supplied(laidOut, slides).some((elements) => elements.some(clipped))) return false;
  const zip = await JSZip.loadAsync(fs.readFileSync(outputPath));
  for (let slideIndex = 0; slideIndex < slides.length; slideIndex += 1) {
    const shapeElements = serializedShapes(laidOut, slideIndex, deck);
    if (!shapeElements.some(clipped)) continue;
    const name = 'ppt/slides/slide' + (slideIndex + 1) + '.xml';
    const file = zip.file(name);
    if (!file) continue;
    const xml = await file.async('string');
    let shapeIndex = 0;
    let patched = 0;
    const next = xml.replace(/<p:sp>([\s\S]*?)<\/p:sp>/gu, (whole, inner) => {
      const element = shapeElements[shapeIndex++];
      if (!clipped(element)) return whole;
      const updated = applyClipGeometry(inner, element.clip);
      if (updated !== inner) patched += 1;
      return '<p:sp>' + updated + '</p:sp>';
    });
    if (shapeIndex !== shapeElements.length) {
      throw new Error('Clip geometry patch alignment mismatch on slide ' + (slideIndex + 1)
        + ': Deck Spec has ' + shapeElements.length + ' elements but PPTX has ' + shapeIndex + ' p:sp elements');
    }
    const expected = shapeElements.filter(clipped).length;
    if (patched !== expected) {
      throw new Error('Clip geometry patch count mismatch on slide ' + (slideIndex + 1)
        + ': expected ' + expected + ', patched ' + patched);
    }
    zip.file(name, next);
  }
  const buffer = await zip.generateAsync({ type: 'nodebuffer', compression: 'DEFLATE', compressionOptions: { level: 6 } });
  fs.writeFileSync(outputPath, buffer);
  return true;
}

/**
 * Clear the alt text the writer invented.
 *
 * pptxgenjs writes `descr` as `altText || the image source`, so a picture with no `alt` carried
 * `descr="F:\\path\\to\\stress-photo.png"` - a build machine's folder layout inside the alt text of
 * a deliverable, offered to a screen reader as if it described the picture. A picture with no
 * description has no description; the source path belongs in the shape name at most.
 */
function looksLikeSourcePath(value) {
  return value === 'preencoded.png' || /[\\/]/u.test(value) || /^[A-Za-z]:/u.test(value);
}

function applyPictureAltText(xml) {
  return xml.replace(/<p:cNvPr ([^>]*?)descr="([^"]*)"([^>]*?)>/gu, (whole, before, descr, after) => {
    if (!looksLikeSourcePath(descr)) return whole;
    return '<p:cNvPr ' + before + 'descr=""' + after + '>';
  });
}

async function patchPictureAltText(outputPath) {
  const zip = await JSZip.loadAsync(fs.readFileSync(outputPath));
  let touched = 0;
  const names = Object.keys(zip.files).filter((name) => /^ppt\/slides\/slide\d+\.xml$/u.test(name));
  for (const name of names) {
    const xml = await zip.file(name).async('string');
    const next = applyPictureAltText(xml);
    if (next === xml) continue;
    zip.file(name, next);
    touched += 1;
  }
  if (!touched) return false;
  const buffer = await zip.generateAsync({ type: 'nodebuffer', compression: 'DEFLATE', compressionOptions: { level: 6 } });
  fs.writeFileSync(outputPath, buffer);
  return true;
}

/** `cap="small"` is DrawingML's small caps, and the writer has no option for it. */
function applySmallCaps(xml) {
  return xml.replace(/<a:rPr([^>]*?)(\/?)>/gu, (whole, attrs, selfClose) => {
    const cleaned = attrs.replace(/\s*cap="[^"]*"/gu, '');
    return '<a:rPr' + cleaned + ' cap="small"' + (selfClose || '') + '>';
  });
}

async function patchSmallCaps(outputPath, deck, laidOut) {
  const slides = (deck && deck.slides) || [];
  const needsCaps = (element) => element && element.type === 'text' && element.smallCaps === true;
  if (!supplied(laidOut, slides).some((elements) => elements.some(needsCaps))) return false;
  const zip = await JSZip.loadAsync(fs.readFileSync(outputPath));
  for (let slideIndex = 0; slideIndex < slides.length; slideIndex += 1) {
    const shapeElements = serializedShapes(laidOut, slideIndex, deck);
    if (!shapeElements.some(needsCaps)) continue;
    const name = 'ppt/slides/slide' + (slideIndex + 1) + '.xml';
    const file = zip.file(name);
    if (!file) continue;
    const xml = await file.async('string');
    let shapeIndex = 0;
    let patched = 0;
    const next = xml.replace(/<p:sp>([\s\S]*?)<\/p:sp>/gu, (whole, inner) => {
      const element = shapeElements[shapeIndex++];
      if (!needsCaps(element)) return whole;
      const updated = applySmallCaps(inner);
      if (updated !== inner) patched += 1;
      return '<p:sp>' + updated + '</p:sp>';
    });
    if (shapeIndex !== shapeElements.length) {
      throw new Error('Small caps patch alignment mismatch on slide ' + (slideIndex + 1)
        + ': Deck Spec has ' + shapeElements.length + ' elements but PPTX has ' + shapeIndex + ' p:sp elements');
    }
    const expected = shapeElements.filter(needsCaps).length;
    if (patched !== expected) {
      throw new Error('Small caps patch count mismatch on slide ' + (slideIndex + 1)
        + ': expected ' + expected + ', patched ' + patched);
    }
    zip.file(name, next);
  }
  const buffer = await zip.generateAsync({ type: 'nodebuffer', compression: 'DEFLATE', compressionOptions: { level: 6 } });
  fs.writeFileSync(outputPath, buffer);
  return true;
}

async function patchTextColumns(outputPath, deck, laidOut) {
  const slides = (deck && deck.slides) || [];
  const columnar = (element) => element && element.type === 'text' && Number(element.columns) > 1;
  const needed = supplied(laidOut, slides).some((elements) => elements.some(columnar));
  if (!needed) return false;
  const zip = await JSZip.loadAsync(fs.readFileSync(outputPath));
  for (let slideIndex = 0; slideIndex < slides.length; slideIndex += 1) {
    const shapeElements = serializedShapes(laidOut, slideIndex, deck);
    if (!shapeElements.some(columnar)) continue;
    const name = 'ppt/slides/slide' + (slideIndex + 1) + '.xml';
    const file = zip.file(name);
    if (!file) continue;
    const xml = await file.async('string');
    let shapeIndex = 0;
    let patched = 0;
    const next = xml.replace(/<p:sp>([\s\S]*?)<\/p:sp>/gu, (whole, inner) => {
      const element = shapeElements[shapeIndex++];
      if (!columnar(element)) return whole;
      const updated = applyTextColumns(inner, element.columns, element.columnGap);
      if (updated !== inner) patched += 1;
      return '<p:sp>' + updated + '</p:sp>';
    });
    if (shapeIndex !== shapeElements.length) {
      throw new Error('Text column patch alignment mismatch on slide ' + (slideIndex + 1)
        + ': Deck Spec has ' + shapeElements.length + ' elements but PPTX has ' + shapeIndex + ' p:sp elements');
    }
    const expected = shapeElements.filter(columnar).length;
    if (patched !== expected) {
      throw new Error('Text column patch count mismatch on slide ' + (slideIndex + 1)
        + ': expected ' + expected + ', patched ' + patched);
    }
    zip.file(name, next);
  }
  const buffer = await zip.generateAsync({ type: 'nodebuffer', compression: 'DEFLATE', compressionOptions: { level: 6 } });
  fs.writeFileSync(outputPath, buffer);
  return true;
}

/**
 * DrawingML's `ST_TextAutonumberScheme`: every numbering style a marker may name. A value
 * outside the set is not a different list, it is an invalid part, which the reader answers
 * with a repair prompt - so an unknown style falls back to the decimal period.
 */
const AUTONUMBER_SCHEMES = new Set([
  'alphaLcParenBoth', 'alphaLcParenR', 'alphaLcPeriod', 'alphaUcParenBoth', 'alphaUcParenR',
  'alphaUcPeriod', 'arabic1Minus', 'arabic2Minus', 'arabicDbPeriod', 'arabicDbPlain',
  'arabicParenBoth', 'arabicParenR', 'arabicPeriod', 'arabicPlain', 'circleNumDbPlain',
  'circleNumWdBlackPlain', 'circleNumWdWhitePlain', 'ea1ChsPeriod', 'ea1ChsPlain',
  'ea1ChtPeriod', 'ea1ChtPlain', 'ea1JpnChsDbPeriod', 'ea1JpnKorPeriod', 'ea1JpnKorPlain',
  'ea2ChsPeriod', 'ea2ChsPlain', 'ea2ChtPeriod', 'ea2ChtPlain', 'ea2JpnChsDbPeriod',
  'ea2JpnKorPeriod', 'ea2JpnKorPlain', 'hebrew2Minus', 'hindiAlpha1Period',
  'hindiAlphaPeriod', 'hindiNumParenR', 'hindiNumPeriod', 'romanLcParenBoth',
  'romanLcParenR', 'romanLcPeriod', 'romanUcParenBoth', 'romanUcParenR', 'romanUcPeriod',
  'thaiAlphaParenBoth', 'thaiAlphaParenR', 'thaiAlphaPeriod', 'thaiNumParenBoth',
  'thaiNumParenR', 'thaiNumPeriod'
]);

/**
 * The hanging indent for a bulleted paragraph in a table CELL.
 *
 * Not the writer's text-box convention: a text box reserves 27pt per outline level
 * (`marL="685800"` at level 1), which inside a cell left a visible gutter between the marker and
 * the cell's own padding, and the items read as detached from their cell. A cell is a quarter
 * inch: the marker hangs at the cell's left padding and the text starts 0.25in in, one more
 * quarter inch per nested level.
 */
const CELL_BULLET_INDENT_EMU = 228600;

function bulletParagraphIndent(level, base = CELL_BULLET_INDENT_EMU) {
  const step = Math.max(1, Math.round(Number(base) || CELL_BULLET_INDENT_EMU));
  return ' marL="' + step * (Math.max(0, Number(level) || 0) + 1) + '" indent="-' + step + '"';
}

/**
 * How far a cell's list is recessed: the spec's own `listIndent` in inches when it declares one
 * (a cell list inherits the CSS `padding-left` the design chose), otherwise the quarter inch.
 */
function cellBulletIndentBase(cell) {
  const inches = Number(cell && cell.options && cell.options.listIndent);
  if (Number.isFinite(inches) && inches > 0) return Math.round(inches * 72 * EMU_PER_POINT);
  return CELL_BULLET_INDENT_EMU;
}

/** The marker a cell paragraph declares, or null when it declares none. */
function cellParagraphBullet(paragraph) {
  const bullet = paragraph && paragraph.options && paragraph.options.bullet;
  return bullet || null;
}

/**
 * The outline level of a cell paragraph: what the spec declares, or the `lvl` the writer has
 * already written when the spec is silent.
 */
function cellParagraphLevel(paragraph, spec) {
  const declared = Number(spec && spec.options && spec.options.indentLevel);
  if (Number.isFinite(declared) && declared >= 0) return Math.round(declared);
  const written = /^<a:p>\s*<a:pPr[^>]*\slvl="(\d+)"/u.exec(paragraph);
  return written ? Number(written[1]) : 0;
}

/** Does this cell hold a list? Only the cells that answer yes are walked at all. */
function cellLists(cell) {
  return Array.isArray(cell && cell.text) && cell.text.some(cellParagraphBullet);
}

/**
 * The glyph a `<ul>` marker draws. A nested `<ul>` and `list-style-type: circle/square` draw a
 * hollow or square marker, and the analyzer names it the way the writer does - a code point
 * such as `25CB`. Drawing every bullet round made those lists read as the wrong list.
 */
function bulletGlyph(bullet) {
  if (typeof bullet.character === 'string' && bullet.character) return bullet.character;
  const code = String(bullet.characterCode === undefined ? '' : bullet.characterCode).trim();
  if (!code) return '•';
  if (/^[0-9A-Fa-f]{2,6}$/u.test(code)) {
    const point = parseInt(code, 16);
    if (Number.isFinite(point) && point > 0) return String.fromCodePoint(point);
  }
  return code;
}

/**
 * The marker's children, in the order DrawingML requires: the marker size, the marker font, then
 * the marker itself.
 *
 * `buSzPct` pins the marker at the size of its own text. Without it a reader falls back to the
 * paragraph default, which is where a 10.5pt cell got a marker that looked larger than the item;
 * 100% means "the size of the text", so it is right at every cell font size and every level.
 */
function cellBulletMarker(bullet) {
  const size = '<a:buSzPct val="100000"/>';
  if (String(bullet.type) === 'number') {
    const declared = String(bullet.style || '');
    const scheme = AUTONUMBER_SCHEMES.has(declared) ? declared : 'arabicPeriod';
    const startAt = Math.round(Number(bullet.startAt));
    // The writer spells the numbering font this way for its own numbered paragraphs.
    return size + '<a:buFont typeface="+mj-lt"/><a:buAutoNum type="' + scheme + '"'
      + (Number.isFinite(startAt) && startAt > 0 ? ' startAt="' + startAt + '"' : '') + '/>';
  }
  return size + '<a:buChar char="' + xmlText(bulletGlyph(bullet)) + '"/>';
}

/**
 * The marker goes where the schema allows it: after the spacing children the writer may already
 * have written, and before `tabLst`/`defRPr`/`extLst`. Every bullet child already there - the
 * marker, its size and its font - is dropped first, so a second patch replaces its own work
 * instead of stacking, and the writer's own half-written numbering properties cannot end up on
 * the wrong side of the marker.
 */
function cellParagraphProperties(inner, marker) {
  const cleaned = String(inner).replace(
    /<a:buNone\/>|<a:buChar\b[^>]*\/>|<a:buAutoNum\b[^>]*\/>|<a:buSzTx\/>|<a:buSzPct\b[^>]*\/>|<a:buSzPts\b[^>]*\/>|<a:buFontTx\/>|<a:buFont\b[^>]*\/>/gu,
    '');
  const tail = /<a:(tabLst|defRPr|extLst)\b/u.exec(cleaned);
  if (!tail) return cleaned + marker;
  return cleaned.slice(0, tail.index) + marker + cleaned.slice(tail.index);
}

/** One cell paragraph gains its marker; the writer writes none of this for a table cell. */
function insertCellBullet(paragraph, bullet, level, base) {
  const marker = cellBulletMarker(bullet);
  const indent = bulletParagraphIndent(level, base);
  const withIndent = (attributes) => String(attributes || '')
    .replace(/\s*(?:marL|indent)="[^"]*"/gu, '') + indent;
  const selfClosed = /^(<a:p>\s*)<a:pPr([^>]*)\/>/u.exec(paragraph);
  if (selfClosed) {
    return selfClosed[1] + '<a:pPr' + withIndent(selfClosed[2]) + '>' + marker + '</a:pPr>'
      + paragraph.slice(selfClosed[0].length);
  }
  const paired = /^(<a:p>\s*)<a:pPr([^>]*)>([\s\S]*?)<\/a:pPr>/u.exec(paragraph);
  if (paired) {
    return paired[1] + '<a:pPr' + withIndent(paired[2]) + '>'
      + cellParagraphProperties(paired[3], marker) + '</a:pPr>'
      + paragraph.slice(paired[0].length);
  }
  // A cell paragraph that came from a list of runs carries no properties block at all.
  return paragraph.replace(/^<a:p>/u,
    '<a:p><a:pPr' + indent + '>' + marker + '</a:pPr>');
}

/** Map the paragraphs the spec declares onto one cell's `<a:p>` elements, in order. */
function applyCellBullets(cellXml, paragraphs, base) {
  let index = 0;
  return cellXml.replace(/<a:p>[\s\S]*?<\/a:p>/gu, (paragraph) => {
    const spec = paragraphs[index];
    index += 1;
    const bullet = cellParagraphBullet(spec);
    if (!bullet) return paragraph;
    return insertCellBullet(paragraph, bullet, cellParagraphLevel(paragraph, spec), base);
  });
}

/**
 * One table row. A merge continuation (`vMerge`/`hMerge`) is a placeholder that covers a cell
 * its neighbour already owns, so it consumes no cell of the spec.
 */
function applyRowCellBullets(rowXml, cells, label) {
  let cellIndex = 0;
  let changed = false;
  const next = rowXml.replace(/<a:tc\b([^>]*)>[\s\S]*?<\/a:tc>/gu, (cellXml, attributes) => {
    if (/\s(?:vMerge|hMerge)="1"/u.test(String(attributes))) return cellXml;
    const cell = cells[cellIndex];
    cellIndex += 1;
    if (!cell) {
      throw new Error('Cell bullet patch alignment mismatch in ' + label
        + ': PPTX has more cells than the Deck Spec row');
    }
    if (!cellLists(cell)) return cellXml;
    const paragraphs = (cellXml.match(/<a:p>/gu) || []).length;
    if (paragraphs !== cell.text.length) {
      throw new Error('Cell bullet patch paragraph mismatch in ' + label + ': Deck Spec declares '
        + cell.text.length + ' paragraph(s) but PPTX has ' + paragraphs + ' a:p elements');
    }
    const updated = applyCellBullets(cellXml, cell.text, cellBulletIndentBase(cell));
    if (updated !== cellXml) changed = true;
    return updated;
  });
  if (cellIndex !== cells.length) {
    throw new Error('Cell bullet patch alignment mismatch in ' + label + ': Deck Spec has '
      + cells.length + ' cells but PPTX has ' + cellIndex);
  }
  return { xml: next, changed };
}

/** One table, walked row by row against the spec. */
function applyTableCellBullets(frameXml, table, label) {
  const rows = Array.isArray(table.rows) ? table.rows : [];
  let rowIndex = 0;
  let changed = false;
  const next = frameXml.replace(/<a:tr\b[\s\S]*?<\/a:tr>/gu, (rowXml) => {
    const cells = rows[rowIndex];
    rowIndex += 1;
    if (!Array.isArray(cells)) {
      throw new Error('Cell bullet patch alignment mismatch in ' + label
        + ': PPTX has more rows than the Deck Spec table');
    }
    const row = applyRowCellBullets(rowXml, cells, label + ', row ' + rowIndex);
    if (row.changed) changed = true;
    return row.xml;
  });
  if (rowIndex !== rows.length) {
    throw new Error('Cell bullet patch alignment mismatch in ' + label + ': Deck Spec has '
      + rows.length + ' rows but PPTX has ' + rowIndex);
  }
  return { xml: next, changed };
}

/**
 * Escape a lone `&` in a slide's relationship part.
 *
 * The writer escapes a text run's hyperlink target but writes a picture's target raw, so the
 * common case - a query string, `?a=1&b=2` - left a bare `&` in the rels part. That is not
 * well-formed XML, and the reader answers it with a repair prompt. Only an `&` that does not
 * already begin a character reference is touched, which keeps the text path escaped exactly
 * once: a second run of this patch changes nothing.
 */
function applyRelsEscapes(xml) {
  return xml.replace(/&(?!(?:amp|lt|gt|quot|apos|#[0-9]+|#x[0-9A-Fa-f]+);)/gu, '&amp;');
}

async function patchHyperlinkRelEscapes(outputPath) {
  const zip = await JSZip.loadAsync(fs.readFileSync(outputPath));
  const names = Object.keys(zip.files)
    .filter((name) => /^ppt\/slides\/_rels\/[^/]+\.rels$/u.test(name));
  let touched = 0;
  for (const name of names) {
    const xml = await zip.file(name).async('string');
    const next = applyRelsEscapes(xml);
    if (next === xml) continue;
    zip.file(name, next);
    touched += 1;
  }
  if (!touched) return false;
  const buffer = await zip.generateAsync({ type: 'nodebuffer', compression: 'DEFLATE', compressionOptions: { level: 6 } });
  fs.writeFileSync(outputPath, buffer);
  return true;
}

const HYPERLINK_RELATIONSHIP = 'http://schemas.openxmlformats.org/officeDocument/2006/relationships/hyperlink';

/** A url as an XML attribute value: the one place a click target is written from the spec. */
function attributeText(value) {
  return String(value)
    .replace(/&/gu, '&amp;')
    .replace(/</gu, '&lt;')
    .replace(/>/gu, '&gt;')
    .replace(/"/gu, '&quot;');
}

/** The reverse, so a target already in the part compares equal to the raw url in the spec. */
function attributeValue(value) {
  return String(value)
    .replace(/&quot;/gu, '"')
    .replace(/&apos;/gu, "'")
    .replace(/&lt;/gu, '<')
    .replace(/&gt;/gu, '>')
    .replace(/&amp;/gu, '&');
}

/**
 * What a slide's relationships part already holds: the last `rId` in use and the hyperlink id
 * already written for each target. One relationship per distinct url is what keeps a card that
 * links three objects to one entry, and what makes a second run of the patch find its own work.
 */
function hyperlinkRegistry(relsXml) {
  const registry = { next: 0, byUrl: new Map(), added: [] };
  const text = String(relsXml);
  const pattern = /<Relationship\b([^>]*?)\/>/gu;
  let match = pattern.exec(text);
  while (match) {
    const attributes = match[1];
    const id = /Id="([^"]*)"/u.exec(attributes);
    const type = /Type="([^"]*)"/u.exec(attributes);
    const target = /Target="([^"]*)"/u.exec(attributes);
    if (id) {
      const numbered = /^rId(\d+)$/u.exec(id[1]);
      if (numbered) registry.next = Math.max(registry.next, Number(numbered[1]));
    }
    if (id && type && target && type[1] === HYPERLINK_RELATIONSHIP) {
      registry.byUrl.set(attributeValue(target[1]), id[1]);
    }
    match = pattern.exec(text);
  }
  return registry;
}

/** The id for a url, writing one relationship the first time that url is asked for. */
function hyperlinkId(registry, url) {
  const known = registry.byUrl.get(url);
  if (known) return known;
  registry.next += 1;
  const id = 'rId' + registry.next;
  registry.byUrl.set(url, id);
  registry.added.push('<Relationship Id="' + id + '" Type="' + HYPERLINK_RELATIONSHIP
    + '" Target="' + attributeText(url) + '" TargetMode="External"/>');
  return id;
}

/**
 * Put one click in a shape's non-visual properties.
 *
 * The writer closes `cNvPr` empty, so it is opened up to hold the child. A block that already
 * carries a click is left exactly as it is: two `hlinkClick` children name two targets and no
 * reader knows which one a click meant.
 */
function applyShapeClick(inner, id) {
  const open = /<p:cNvPr\b[^>]*?(\/?)>/u.exec(inner);
  if (!open) return inner;
  const click = '<a:hlinkClick r:id="' + id + '" tooltip=""/>';
  if (open[1] === '') {
    const end = inner.indexOf('</p:cNvPr>', open.index);
    if (end < 0) return inner;
    const block = inner.slice(open.index, end);
    if (/<a:hlinkClick\b/u.test(block)) return inner;
    // `hlinkClick` precedes `extLst` in the schema, so it goes before one if the block has it.
    const extension = block.indexOf('<a:extLst');
    const at = extension < 0 ? end : open.index + extension;
    return inner.slice(0, at) + click + inner.slice(at);
  }
  const opened = inner.slice(open.index, open.index + open[0].length - 2) + '>';
  return inner.slice(0, open.index) + opened + click + '</p:cNvPr>'
    + inner.slice(open.index + open[0].length);
}

/** The url an element wants its own box to navigate to, or '' when it wants no click. */
function spHyperlinkUrl(element) {
  if (!element) return '';
  // A picture is `p:pic`, not `p:sp`, and carries its click from the writer's own option; a line
  // is a hairline nobody can aim at, so it is not a click target either.
  if (element.type !== 'text' && element.type !== 'shape') return '';
  const url = element.hyperlink && element.hyperlink.url;
  return url ? String(url) : '';
}

/**
 * Shape-level hyperlinks: the click an `<a href>` around a block asks for.
 *
 * The writer can put a click on a shape, but for a text box it also links - and underlines -
 * every run inside it, which is not the design's underline state. So the click is written here
 * instead, into each object's own `cNvPr`, with one relationship per distinct url: a card links
 * its surface and the words on it, and all of them name one relationship.
 */
async function patchShapeHyperlinks(outputPath, deck, laidOut) {
  const slides = (deck && deck.slides) || [];
  const linked = (element) => Boolean(spHyperlinkUrl(element));
  const elements = supplied(laidOut, slides);
  if (!elements.some((list) => list.some(linked))) return false;
  const zip = await JSZip.loadAsync(fs.readFileSync(outputPath));
  let touched = 0;
  for (let slideIndex = 0; slideIndex < slides.length; slideIndex += 1) {
    const shapeElements = serializedShapes(laidOut, slideIndex, deck);
    if (!shapeElements.some(linked)) continue;
    const name = 'ppt/slides/slide' + (slideIndex + 1) + '.xml';
    const relsName = 'ppt/slides/_rels/slide' + (slideIndex + 1) + '.xml.rels';
    const file = zip.file(name);
    const relsFile = zip.file(relsName);
    if (!file) continue;
    if (!relsFile) {
      throw new Error('Shape hyperlink patch found no relationships part for slide '
        + (slideIndex + 1));
    }
    const xml = await file.async('string');
    const registry = hyperlinkRegistry(await relsFile.async('string'));
    let shapeIndex = 0;
    let patched = 0;
    let missed = 0;
    const next = xml.replace(/<p:sp>([\s\S]*?)<\/p:sp>/gu, (whole, inner) => {
      const element = shapeElements[shapeIndex];
      shapeIndex += 1;
      const url = spHyperlinkUrl(element);
      if (!url) return whole;
      const updated = applyShapeClick(inner, hyperlinkId(registry, url));
      if (updated === inner) {
        // Already carries its click: the patch found its own work and leaves it alone.
        if (/<a:hlinkClick\b/u.test(inner)) return whole;
        missed += 1;
        return whole;
      }
      patched += 1;
      return '<p:sp>' + updated + '</p:sp>';
    });
    if (shapeIndex !== shapeElements.length) {
      throw new Error('Shape hyperlink patch alignment mismatch on slide ' + (slideIndex + 1)
        + ': Deck Spec has ' + shapeElements.length + ' elements but PPTX has '
        + shapeIndex + ' p:sp elements');
    }
    if (missed) {
      throw new Error('Shape hyperlink patch could not put a click on ' + missed
        + ' linked shape(s) on slide ' + (slideIndex + 1));
    }
    if (registry.added.length) {
      const rels = await relsFile.async('string');
      zip.file(relsName, rels.replace('</Relationships>', registry.added.join('') + '</Relationships>'));
    }
    if (!patched) continue;
    zip.file(name, next);
    touched += 1;
  }
  if (!touched) return false;
  const buffer = await zip.generateAsync({ type: 'nodebuffer', compression: 'DEFLATE', compressionOptions: { level: 6 } });
  fs.writeFileSync(outputPath, buffer);
  return true;
}

/**
 * Bullet markers inside table cells.
 *
 * The writer emits one `<a:p>` per cell paragraph - verified - but drops the marker for a
 * table cell, so a list in a cell arrived as plain stacked lines with no bullet at all. The
 * spec knows which paragraph carries which marker, so each cell's paragraphs are walked
 * against it and the marker is written where it belongs. A cell that declares no list is left
 * exactly as the writer wrote it.
 */
async function patchCellBullets(outputPath, deck, laidOut) {
  const slides = (deck && deck.slides) || [];
  const listsIn = (element) => element && element.type === 'table'
    && Array.isArray(element.rows)
    && element.rows.some((row) => Array.isArray(row) && row.some(cellLists));
  const elements = supplied(laidOut, slides);
  if (!elements.some((slideElements) => slideElements.some(listsIn))) return false;
  const zip = await JSZip.loadAsync(fs.readFileSync(outputPath));
  let touched = 0;
  for (let slideIndex = 0; slideIndex < slides.length; slideIndex += 1) {
    // Charts are `p:graphicFrame` shapes too, so only the frames that carry an `<a:tbl>` are
    // tables - and they appear in the order the writer emitted them.
    const tables = elements[slideIndex].filter((element) => element && element.type === 'table');
    if (!tables.some(listsIn)) continue;
    const name = 'ppt/slides/slide' + (slideIndex + 1) + '.xml';
    const file = zip.file(name);
    if (!file) continue;
    const xml = await file.async('string');
    const frames = (xml.match(/<p:graphicFrame>[\s\S]*?<\/p:graphicFrame>/gu) || [])
      .filter((frame) => frame.includes('<a:tbl>'));
    if (frames.length !== tables.length) {
      throw new Error('Cell bullet patch alignment mismatch on slide ' + (slideIndex + 1)
        + ': Deck Spec has ' + tables.length + ' table elements but PPTX has '
        + frames.length + ' a:tbl graphicFrame elements');
    }
    let tableIndex = 0;
    let changed = false;
    const next = xml.replace(/<p:graphicFrame>[\s\S]*?<\/p:graphicFrame>/gu, (frame) => {
      if (!frame.includes('<a:tbl>')) return frame;
      const table = tables[tableIndex];
      const position = tableIndex + 1;
      tableIndex += 1;
      if (!listsIn(table)) return frame;
      const result = applyTableCellBullets(frame, table,
        'slide ' + (slideIndex + 1) + ', table ' + position);
      if (result.changed) changed = true;
      return result.xml;
    });
    if (tableIndex !== tables.length) {
      throw new Error('Cell bullet patch alignment mismatch on slide ' + (slideIndex + 1)
        + ': Deck Spec has ' + tables.length + ' tables but PPTX has ' + tableIndex
        + ' a:tbl graphicFrame elements');
    }
    if (!changed) continue;
    zip.file(name, next);
    touched += 1;
  }
  if (!touched) return false;
  const buffer = await zip.generateAsync({ type: 'nodebuffer', compression: 'DEFLATE', compressionOptions: { level: 6 } });
  fs.writeFileSync(outputPath, buffer);
  return true;
}

/**
 * The start number each paragraph of a text shape really declares, in paragraph order.
 *
 * PptxGenJS writes `startAt` on every numbered paragraph it generates, and a reader reads that
 * as "this paragraph starts at N" - so a three-item list that starts at 5 rendered 5, 5, 5 and
 * a plain list rendered 1, 1, 1. Only the paragraph that really begins a count keeps the
 * attribute; the rest continue the count. A nested level begins its own count, which is what a
 * nested `<ol>` does in a browser.
 */
function paragraphNumbering(spec) {
  const paragraphs = [];
  const declared = (bullet) => {
    const value = bullet ? Number(bullet.startAt) : NaN;
    return Number.isFinite(value) && value > 0 ? value : null;
  };
  if (typeof (spec && spec.text) === 'string') {
    String(spec.text).split('\n').forEach((line, index) => {
      paragraphs.push({ level: 0, startAt: index === 0 ? declared(spec.bullet) : null });
    });
    return paragraphs;
  }
  if (!spec || !Array.isArray(spec.text)) return paragraphs;
  let current = null;
  let currentLevel = 0;
  let open = false;
  spec.text.forEach((run) => {
    const options = (run && run.options) || {};
    if (!open) {
      current = declared(options.bullet);
      currentLevel = Number.isFinite(Number(options.indentLevel)) ? Number(options.indentLevel) : 0;
      open = true;
    }
    if (options.breakLine) {
      paragraphs.push({ level: currentLevel, startAt: current });
      open = false;
    }
  });
  if (open) paragraphs.push({ level: currentLevel, startAt: current });
  // A level that has not been seen yet starts at 1, the way a nested <ol> numbers.
  const seen = new Set();
  paragraphs.forEach((paragraph) => {
    if (paragraph.startAt !== null) { seen.add(paragraph.level); return; }
    if (paragraph.level > 0 && !seen.has(paragraph.level)) paragraph.startAt = 1;
    seen.add(paragraph.level);
  });
  return paragraphs;
}

/** Rewrite the `startAt` of every numbered paragraph in one text body. */
function applyListNumbering(xml, paragraphs) {
  let index = 0;
  return xml.replace(/<a:p>[\s\S]*?<\/a:p>/gu, (paragraph) => {
    const wanted = paragraphs[index];
    index += 1;
    if (!/<a:buAutoNum/u.test(paragraph)) return paragraph;
    const desired = wanted && wanted.startAt !== null && wanted.startAt !== undefined ? wanted.startAt : null;
    return paragraph.replace(/<a:buAutoNum([^/]*?)(?:\s+startAt="\d+")?\/>/u, (match, rest) => {
      const base = '<a:buAutoNum' + rest;
      return desired === null ? base + '/>' : base + ' startAt="' + desired + '"/>';
    });
  });
}

/**
 * Numbered lists: one `startAt` per count, not one per paragraph.
 *
 * Every paragraph carried the attribute, so a list of three rendered 5, 5, 5 when it started at
 * 5 and 1, 1, 1 when it did not - the numbers were there, all of them the same one. The deck spec
 * knows which paragraphs really begin a count, so the shapes are walked against it.
 */
async function patchListNumbering(outputPath, deck, laidOut) {
  const slides = (deck && deck.slides) || [];
  const numbered = (element) => element && element.type === 'text' && typeof element.text !== 'undefined';
  if (!supplied(laidOut, slides).some((elements) => elements.some(numbered))) return false;
  const zip = await JSZip.loadAsync(fs.readFileSync(outputPath));
  let touched = 0;
  for (let slideIndex = 0; slideIndex < slides.length; slideIndex += 1) {
    const shapeElements = serializedShapes(laidOut, slideIndex, deck);
    if (!shapeElements.some(numbered)) continue;
    const name = 'ppt/slides/slide' + (slideIndex + 1) + '.xml';
    const file = zip.file(name);
    if (!file) continue;
    const xml = await file.async('string');
    let shapeIndex = 0;
    let changed = false;
    const next = xml.replace(/<p:sp>([\s\S]*?)<\/p:sp>/gu, (whole, inner) => {
      const element = shapeElements[shapeIndex++];
      if (!numbered(element) || !/<a:buAutoNum/u.test(inner)) return whole;
      const updated = applyListNumbering(inner, paragraphNumbering(element));
      if (updated !== inner) changed = true;
      return '<p:sp>' + updated + '</p:sp>';
    });
    if (shapeIndex !== shapeElements.length) {
      throw new Error('List numbering patch alignment mismatch on slide ' + (slideIndex + 1)
        + ': Deck Spec has ' + shapeElements.length + ' elements but PPTX has ' + shapeIndex + ' p:sp elements');
    }
    if (changed) { zip.file(name, next); touched += 1; }
  }
  if (!touched) return false;
  const buffer = await zip.generateAsync({ type: 'nodebuffer', compression: 'DEFLATE', compressionOptions: { level: 6 } });
  fs.writeFileSync(outputPath, buffer);
  return true;
}

/**
 * `::marker { color: ... }` becomes `a:buClr` inside the bulleted paragraph's
 * `a:pPr`, before the `buChar` it colours. PptxGenJS has no bullet-colour option,
 * so the marker colour rides the same post-serialization patch as the indents.
 */
function applyMarkerColour(xml, colour) {
  const fill = '<a:buClr><a:srgbClr val="' + colour + '"/></a:buClr>';
  const paragraph = /<a:pPr[\s\S]*?<\/a:pPr>|<a:pPr[^>]*\/>/gu;
  if (!paragraph.test(xml)) return xml;
  return xml.replace(paragraph, (whole) => {
    if (/a:buClr/u.test(whole)) return whole;
    if (/<a:buChar|<a:buAutoNum/u.test(whole)) {
      return whole.replace(/(<a:bu(?:Char|AutoNum)[^>]*\/>)/u, fill + '$1');
    }
    // No bullet property yet: the fill goes in ahead of the closing tag.
    if (whole.endsWith('/>')) return whole;
    return whole.replace(/<\/a:pPr>$/u, fill + '</a:pPr>');
  });
}

async function patchMarkerColours(outputPath, deck, laidOut) {
  const slides = (deck && deck.slides) || [];
  const coloured = (element) => element.type === 'text' && element.markerColor;
  if (!supplied(laidOut, slides).some((elements) => elements.some(coloured))) return false;
  const zip = await JSZip.loadAsync(fs.readFileSync(outputPath));
  let touched = 0;
  for (let slideIndex = 0; slideIndex < slides.length; slideIndex += 1) {
    const shapeElements = serializedShapes(laidOut, slideIndex, deck);
    if (!shapeElements.some(coloured)) continue;
    const name = 'ppt/slides/slide' + (slideIndex + 1) + '.xml';
    const file = zip.file(name);
    if (!file) continue;
    const xml = await file.async('string');
    let shapeIndex = 0;
    let patched = 0;
    const next = xml.replace(/<p:sp>([\s\S]*?)<\/p:sp>/gu, (whole, inner) => {
      const element = shapeElements[shapeIndex++];
      if (!element || !coloured(element)) return whole;
      const updated = applyMarkerColour(inner, element.markerColor);
      if (updated !== inner) patched += 1;
      return '<p:sp>' + updated + '</p:sp>';
    });
    if (shapeIndex !== shapeElements.length) {
      throw new Error('Marker colour patch alignment mismatch on slide ' + (slideIndex + 1)
        + ': Deck Spec has ' + shapeElements.length + ' elements but PPTX has ' + shapeIndex + ' p:sp elements');
    }
    if (patched) {
      zip.file(name, next);
      touched += patched;
    }
  }
  if (touched) {
    const buffer = await zip.generateAsync({ type: 'nodebuffer' });
    fs.writeFileSync(outputPath, buffer);
  }
  return touched > 0;
}

/**
 * A level-indented paragraph whose marker is switched off still sits at its level: the
 * writer zeroes `marL` when there is no bullet, which parks the words at the left edge
 * while the browser keeps them under their parent. The level margin is the writer's own
 * 27pt per level (342900 EMU), the same number it writes for a bulleted paragraph.
 */
const LEVEL_INDENT_EMU = 342900;

async function patchLevelIndents(outputPath, deck, laidOut) {
  const slides = (deck && deck.slides) || [];
  const needed = supplied(laidOut, slides).some((elements) => elements.some((element) =>
    element.type === 'text' && Array.isArray(element.text) && element.text.some((run) =>
      run && run.options && run.options.bullet === false && Number(run.options.indentLevel) > 0)));
  if (!needed) return false;
  const zip = await JSZip.loadAsync(fs.readFileSync(outputPath));
  let touched = 0;
  for (let slideIndex = 0; slideIndex < slides.length; slideIndex += 1) {
    const name = 'ppt/slides/slide' + (slideIndex + 1) + '.xml';
    const file = zip.file(name);
    if (!file) continue;
    const xml = await file.async('string');
    const next = xml.replace(/<a:pPr([^>]*)>/gu, (whole, attributes) => {
      if (!/\blvl="[1-9]\d*"/u.test(attributes) || !/\bmarL="0"/u.test(attributes)) return whole;
      const level = Number(/\blvl="(\d+)"/u.exec(attributes)[1]);
      touched += 1;
      // The writer's bulleted paragraph uses `bulletMarL + bulletMarL * level`: level 1 sits
      // one full margin past the level-0 text, not at it.
      const margin = LEVEL_INDENT_EMU * (level + 1);
      return '<a:pPr' + attributes.replace(/\bmarL="0"/u, 'marL="' + margin + '"') + '>';
    });
    if (next !== xml) zip.file(name, next);
  }
  if (!touched) return false;
  const buffer = await zip.generateAsync({ type: 'nodebuffer', compression: 'DEFLATE', compressionOptions: { level: 6 } });
  fs.writeFileSync(outputPath, buffer);
  return true;
}

async function patchTextIndents(outputPath, deck, laidOut) {
  const slides = (deck && deck.slides) || [];
  const needed = supplied(laidOut, slides).some((elements) => elements
    .some((element) => element.type === 'text' && Number.isFinite(element.textIndent) && element.textIndent > 0));
  if (!needed) return false;
  const zip = await JSZip.loadAsync(fs.readFileSync(outputPath));
  for (let slideIndex = 0; slideIndex < slides.length; slideIndex += 1) {
    const shapeElements = serializedShapes(laidOut, slideIndex, deck);
    if (!shapeElements.some((element) => element.type === 'text' && Number.isFinite(element.textIndent))) continue;
    const name = 'ppt/slides/slide' + (slideIndex + 1) + '.xml';
    const file = zip.file(name);
    if (!file) continue;
    const xml = await file.async('string');
    let shapeIndex = 0;
    let patched = 0;
    const next = xml.replace(/<p:sp>([\s\S]*?)<\/p:sp>/gu, (whole, inner) => {
      const element = shapeElements[shapeIndex++];
      if (!element || element.type !== 'text' || !Number.isFinite(element.textIndent) || element.textIndent <= 0) return whole;
      const updated = applyTextIndent(inner, element.textIndent);
      if (updated !== inner) patched += 1;
      return '<p:sp>' + updated + '</p:sp>';
    });
    if (shapeIndex !== shapeElements.length) {
      throw new Error('Text indent patch alignment mismatch on slide ' + (slideIndex + 1) +
        ': Deck Spec has ' + shapeElements.length + ' elements but PPTX has ' + shapeIndex + ' p:sp elements');
    }
    const expected = shapeElements.filter((element) => element.type === 'text'
      && Number.isFinite(element.textIndent) && element.textIndent > 0).length;
    if (patched !== expected) {
      throw new Error('Text indent patch count mismatch on slide ' + (slideIndex + 1) +
        ': expected ' + expected + ', patched ' + patched);
    }
    zip.file(name, next);
  }
  const buffer = await zip.generateAsync({ type: 'nodebuffer', compression: 'DEFLATE', compressionOptions: { level: 6 } });
  fs.writeFileSync(outputPath, buffer);
  return true;
}

/**
 * Shape ids are one namespace per slide, and the writer numbers tables from its own
 * counter: a table landing on a number a text box already took makes PowerPoint offer
 * to repair the file. Nothing refers to these ids - this deck emits no animation
 * timeline - so a single sequential pass makes them unique again, the group first.
 */
async function patchShapeIds(outputPath) {
  const zip = await JSZip.loadAsync(fs.readFileSync(outputPath));
  const names = Object.keys(zip.files).filter((name) => /^ppt\/slides\/slide\d+\.xml$/u.test(name));
  let touched = 0;
  for (const name of names) {
    const file = zip.file(name);
    if (!file) continue;
    const xml = await file.async('string');
    const seen = new Set();
    let next = 1;
    let changed = false;
    const updated = xml.replace(/<p:cNvPr id="(\d+)"/gu, (whole, id) => {
      const value = String(next++);
      if (seen.has(id) || id !== value) changed = true;
      seen.add(id);
      return '<p:cNvPr id="' + value + '"';
    });
    if (changed) {
      zip.file(name, updated);
      touched += 1;
    }
  }
  if (touched) {
    const buffer = await zip.generateAsync({ type: 'nodebuffer' });
    fs.writeFileSync(outputPath, buffer);
  }
  return touched > 0;
}

/** `ST_DLblPos`: every token a data label may be placed at, and nothing else. */
const DATA_LABEL_POSITIONS = new Set(['ctr', 'inBase', 'inEnd', 'outEnd', 'bestFit', 'b', 'c', 't', 'l', 'r']);

/**
 * The schema token for a declared data-label position. The writer's own vocabulary is the
 * camelCase form (`outEnd`), and the analyzer hands that straight through, but a hand-written
 * spec may say what the CSS-ish spelling was, so the folded word is accepted too.
 */
function dataLabelPositionToken(value) {
  const raw = String(value === undefined || value === null ? '' : value).trim();
  if (!raw) return null;
  if (DATA_LABEL_POSITIONS.has(raw)) return raw;
  const folded = raw.toLowerCase().replace(/[^a-z]/gu, '');
  const aliases = {
    center: 'ctr', centre: 'ctr', middle: 'ctr',
    insidebase: 'inBase', insideend: 'inEnd', outsideend: 'outEnd', outside: 'outEnd',
    bestfit: 'bestFit', top: 't', bottom: 'b', left: 'l', right: 'r'
  };
  return aliases[folded] || null;
}

/**
 * Put one `c:dLblPos` into every label block of a chart part. `CT_DLbls` is a sequence and
 * `dLblPos` may only stand between `txPr` and `showLegendKey`; the writer always writes
 * `showLegendKey`, so it is the anchor, with the block's own close as the fallback.
 * Returns how many blocks changed, so a patch that finds the position already right writes
 * nothing.
 */
function applyDataLabelPosition(xml, token) {
  const node = '<c:dLblPos val="' + token + '"/>';
  let changed = 0;
  let next = xml.replace(/<c:dLbls>[\s\S]*?<\/c:dLbls>/gu, (block) => {
    if (/<c:dLblPos val="/u.test(block)) {
      // A declared position is one value for the whole chart, so every label in the block takes
      // it - a pie writes one position per point, and leaving any of them behind would draw two
      // different placements in one chart.
      const replaced = block.replace(/<c:dLblPos val="[^"]*"\/>/gu, (existing) => {
        if (existing === node) return existing;
        changed += 1;
        return node;
      });
      return replaced;
    }
    const anchor = block.indexOf('<c:showLegendKey');
    const at = anchor >= 0 ? anchor : block.lastIndexOf('</c:dLbls>');
    changed += 1;
    return block.slice(0, at) + node + block.slice(at);
  });
  // An empty `<c:dLbls/>` has no anchor; giving it a body is still the right shape.
  if (/<c:dLbls\/>/u.test(next)) {
    changed += 1;
    next = next.replace(/<c:dLbls\/>/gu, '<c:dLbls>' + node + '</c:dLbls>');
  }
  return { xml: next, changed };
}

/** Which plot-area group a chart type must appear as, so a patch can prove its alignment. */
const CHART_PLOT_GROUP = {
  bar: 'barChart', line: 'lineChart', pie: 'pieChart', doughnut: 'doughnutChart',
  area: 'areaChart', radar: 'radarChart', scatter: 'scatterChart', bubble: 'bubbleChart'
};

/**
 * A data label's position is `c:dLblPos`, and the writer drops the request for the chart types
 * its own validator refuses - a doughnut, an area chart and a radar keep the position in the
 * spec and lose it in the part. One value covers the whole chart (a per-point position would
 * need one entry per point, which no deck has asked for), so every label block gets it.
 *
 * Chart parts are numbered in creation order, which is the order the elements are added, so the
 * walk is positional - and a part whose plot group does not match the spec's chart type means
 * the two walks have drifted apart, which is an error rather than a guess.
 */
async function patchDataLabelPositions(outputPath, deck, laidOut) {
  const slides = (deck && deck.slides) || [];
  const charts = [];
  supplied(laidOut, slides).forEach((elements) => {
    (elements || []).forEach((element) => {
      if (element && element.type === 'chart') charts.push(element);
    });
  });
  if (!charts.some((chart) => chart.options && chart.options.dataLabelPosition)) return false;
  const zip = await JSZip.loadAsync(fs.readFileSync(outputPath));
  const names = Object.keys(zip.files).filter((name) => /^ppt\/charts\/chart\d+\.xml$/u.test(name))
    .sort((left, right) => Number(/(\d+)\.xml$/u.exec(left)[1]) - Number(/(\d+)\.xml$/u.exec(right)[1]));
  if (names.length !== charts.length) {
    throw new Error('Data-label position patch alignment mismatch: the Deck Spec has ' + charts.length +
      ' chart element(s) but the PPTX has ' + names.length + ' chart part(s)');
  }
  let touched = 0;
  for (let index = 0; index < names.length; index += 1) {
    const options = charts[index].options || {};
    const token = dataLabelPositionToken(options.dataLabelPosition);
    if (!token) {
      if (options.dataLabelPosition) {
        throw new Error('Data-label position patch: unknown position "' + options.dataLabelPosition +
          '" on chart ' + (index + 1) + ' of the file');
      }
      continue;
    }
    const xml = await zip.file(names[index]).async('string');
    const group = CHART_PLOT_GROUP[charts[index].chartType || 'bar'];
    if (group && !xml.includes('<c:' + group)) {
      throw new Error('Data-label position patch alignment mismatch on chart part ' + (index + 1) +
        ': the spec says ' + (charts[index].chartType || 'bar') + ' but the part holds no c:' + group);
    }
    const applied = applyDataLabelPosition(xml, token);
    if (applied.changed > 0) {
      zip.file(names[index], applied.xml);
      touched += 1;
    }
  }
  if (touched) {
    const buffer = await zip.generateAsync({ type: 'nodebuffer' });
    fs.writeFileSync(outputPath, buffer);
  }
  return touched > 0;
}

/** `a:prstDash` values for the dash names a deck can ask for. A Map: a plain object answers
 * `SERIES_DASH['toString']` with a function, and that would be written into the part. */
const SERIES_DASH = new Map(Object.entries({
  solid: 'solid', dashed: 'dash', dotted: 'dot', dashDot: 'dashDot',
  lgDash: 'lgDash', lgDashDot: 'lgDashDot', sysDash: 'sysDash', sysDot: 'sysDot'
}));

/**
 * The schema token for one declared dash. The writer's own vocabulary is the camelCase form
 * (`dashDot`), the schema spells it the same way, and `dash`/`dot` - the OOXML words - are
 * accepted so a hand-written spec is not a typo.
 */
function seriesDashToken(value) {
  const raw = String(value === undefined || value === null ? '' : value).trim();
  if (!raw) return null;
  if (SERIES_DASH.has(raw)) return SERIES_DASH.get(raw);
  if (raw === 'dash' || raw === 'dot') return raw;
  const folded = raw.toLowerCase();
  const match = [...SERIES_DASH.keys()].find((name) => name.toLowerCase() === folded);
  return match ? SERIES_DASH.get(match) : null;
}

/**
 * The element `tag` inside `content` with its offsets, matching nested elements of the same
 * name (there are none in a chart part, but an unbalanced search is the kind of thing that
 * silently eats half a document). Depth is why this exists: a series carries its own `c:spPr`,
 * and its marker and label block each carry one too - styling the wrong one is invisible in
 * the XML and obvious in the render.
 */
function elementSpan(content, tag, startAt = 0) {
  const openAt = content.indexOf('<' + tag, startAt);
  if (openAt < 0) return null;
  const openEnd = content.indexOf('>', openAt);
  if (openEnd < 0) return null;
  if (content[openEnd - 1] === '/') {
    return { start: openAt, openEnd, closeStart: openEnd, end: openEnd + 1, inner: '', selfClosing: true };
  }
  let depth = 1;
  let cursor = openEnd + 1;
  while (depth > 0) {
    const nextOpen = content.indexOf('<' + tag, cursor);
    const nextClose = content.indexOf('</' + tag + '>', cursor);
    if (nextClose < 0) return null;
    if (nextOpen >= 0 && nextOpen < nextClose) {
      depth += 1;
      cursor = nextOpen + tag.length + 1;
      continue;
    }
    depth -= 1;
    cursor = nextClose + tag.length + 3;
    if (depth === 0) {
      return {
        start: openAt,
        openEnd,
        closeStart: nextClose,
        end: nextClose + tag.length + 3,
        inner: content.slice(openEnd + 1, nextClose)
      };
    }
  }
  return null;
}

/** The offset of the first of `tags` in `content`, or -1. */
function firstTagOffset(content, tags) {
  let best = -1;
  tags.forEach((tag) => {
    const at = content.indexOf(tag);
    if (at >= 0 && (best < 0 || at < best)) best = at;
  });
  return best;
}

/** `a:ln`'s children are ordered: fill, prstDash, join, headEnd, tailEnd. */
const LINE_AFTER_DASH = ['<a:round', '<a:bevel', '<a:miter', '<a:headEnd', '<a:tailEnd', '<a:extLst'];
/** ...and an `a:ln` goes after the fill of its `c:spPr`, before the effects. */
const SHAPE_AFTER_LINE = ['<a:effectLst', '<a:effectDag', '<a:scene3d', '<a:sp3d', '<a:extLst'];

/** Put one `a:prstDash` into an `a:ln`, keeping whatever else the line already carries. */
function dashInLine(lnInner, token) {
  const node = '<a:prstDash val="' + token + '"/>';
  const existing = elementSpan(lnInner, 'a:prstDash');
  if (existing) {
    if (lnInner.slice(existing.start, existing.end) === node) return { inner: lnInner, changed: false };
    return { inner: lnInner.slice(0, existing.start) + node + lnInner.slice(existing.end), changed: true };
  }
  const at = firstTagOffset(lnInner, LINE_AFTER_DASH);
  const cut = at < 0 ? lnInner.length : at;
  return { inner: lnInner.slice(0, cut) + node + lnInner.slice(cut), changed: true };
}

/**
 * One series' own dash: `<c:ser><c:spPr><a:ln><a:prstDash val="…"/></a:ln></c:spPr>`. The
 * writer writes the `c:spPr` (it carries the series fill) but an `a:ln` only for the chart
 * types that draw a line, so a bar needs the `a:ln` created - and an existing `a:ln` is not
 * rewritten, only added to, because it holds the series' line colour and width.
 */
function applySeriesLineStyle(serBlock, token) {
  const spPr = elementSpan(serBlock, 'c:spPr');
  if (!spPr) throw new Error('Series line style patch: the series holds no c:spPr to carry a line');
  const node = '<a:prstDash val="' + token + '"/>';
  if (spPr.selfClosing) {
    const text = serBlock.slice(0, spPr.start) + '<c:spPr><a:ln>' + node + '</a:ln></c:spPr>' + serBlock.slice(spPr.end);
    return { text, changed: true };
  }
  const ln = elementSpan(spPr.inner, 'a:ln');
  let inner;
  let changed;
  if (!ln) {
    // No line yet (a bar has none): the schema puts `a:ln` after the fill and before the effects.
    changed = true;
    const at = firstTagOffset(spPr.inner, SHAPE_AFTER_LINE);
    const cut = at < 0 ? spPr.inner.length : at;
    inner = spPr.inner.slice(0, cut) + '<a:ln>' + node + '</a:ln>' + spPr.inner.slice(cut);
  } else if (ln.selfClosing) {
    // `<a:ln w="…"/>` keeps its attributes; only the body is given.
    changed = true;
    const attributes = spPr.inner.slice(ln.start + 5, ln.openEnd - 1).replace(/\/\s*$/u, '');
    inner = spPr.inner.slice(0, ln.start) + '<a:ln' + attributes + '>' + node + '</a:ln>'
      + spPr.inner.slice(ln.end);
  } else {
    const dashed = dashInLine(ln.inner, token);
    changed = dashed.changed;
    inner = spPr.inner.slice(0, ln.openEnd + 1) + dashed.inner + '</a:ln>' + spPr.inner.slice(ln.end);
  }
  if (!changed) return { text: serBlock, changed: false };
  const text = serBlock.slice(0, spPr.openEnd + 1) + inner + '</c:spPr>' + serBlock.slice(spPr.end);
  return { text, changed: true };
}

/** Every `<c:ser>` element of a chart part, in series order, with its offsets. */
function seriesBlocks(xml) {
  const blocks = [];
  let cursor = 0;
  for (;;) {
    const open = xml.indexOf('<c:ser>', cursor);
    if (open < 0) break;
    const close = xml.indexOf('</c:ser>', open);
    if (close < 0) break;
    blocks.push({ start: open, end: close + '</c:ser>'.length });
    cursor = close + '</c:ser>'.length;
  }
  return blocks;
}

/**
 * One dash per series, in series order. Rebuilt from the last series backwards so the earlier
 * offsets stay valid; a series whose dash is already what the deck asks for is left alone,
 * which is what makes a second run a no-op.
 */
function applySeriesLineStyles(xml, tokens) {
  const blocks = seriesBlocks(xml);
  if (blocks.length !== tokens.length) {
    throw new Error('Series line style patch alignment mismatch: ' + tokens.length +
      ' style(s) for ' + blocks.length + ' series in the part');
  }
  let next = xml;
  let changed = 0;
  for (let index = blocks.length - 1; index >= 0; index -= 1) {
    const token = tokens[index];
    if (!token) continue;
    const block = blocks[index];
    const applied = applySeriesLineStyle(next.slice(block.start, block.end), token);
    if (!applied.changed) continue;
    next = next.slice(0, block.start) + applied.text + next.slice(block.end);
    changed += 1;
  }
  return { xml: next, changed };
}

/**
 * A design that says "this series is dashed" is asking for something the writer only offers for
 * the whole chart (`lineDash` paints every series the same). The part can hold a dash per
 * series, so it is written here, after the file exists.
 *
 * The count of `<c:ser>` blocks is checked against the number of series the spec declares:
 * a chart whose series list is shorter than the part's would otherwise style the wrong series
 * and look plausible. Markers keep whatever the chart-level setting gave them - a marker's line
 * is its own `c:spPr` and a design that wants a different marker rhythm can ask for it.
 */
async function patchSeriesLineStyles(outputPath, deck, laidOut) {
  const slides = (deck && deck.slides) || [];
  const charts = [];
  supplied(laidOut, slides).forEach((elements) => {
    (elements || []).forEach((element) => {
      if (element && element.type === 'chart') charts.push(element);
    });
  });
  if (!charts.some((chart) => Array.isArray(chart.options && chart.options.seriesLineStyles)
    && chart.options.seriesLineStyles.length)) return false;
  const zip = await JSZip.loadAsync(fs.readFileSync(outputPath));
  const names = Object.keys(zip.files).filter((name) => /^ppt\/charts\/chart\d+\.xml$/u.test(name))
    .sort((left, right) => Number(/(\d+)\.xml$/u.exec(left)[1]) - Number(/(\d+)\.xml$/u.exec(right)[1]));
  if (names.length !== charts.length) {
    throw new Error('Series line style patch alignment mismatch: the Deck Spec has ' + charts.length +
      ' chart element(s) but the PPTX has ' + names.length + ' chart part(s)');
  }
  let touched = 0;
  for (let index = 0; index < names.length; index += 1) {
    const options = charts[index].options || {};
    const declared = Array.isArray(options.seriesLineStyles) ? options.seriesLineStyles : [];
    if (!declared.length) continue;
    const xml = await zip.file(names[index]).async('string');
    const blocks = seriesBlocks(xml);
    const specSeries = Array.isArray(charts[index].data) ? charts[index].data.length : blocks.length;
    if (specSeries !== blocks.length) {
      throw new Error('Series line style patch alignment mismatch on chart part ' + (index + 1) +
        ': the spec declares ' + specSeries + ' series but the part holds ' + blocks.length);
    }
    if (declared.length > blocks.length) {
      throw new Error('Series line style patch: ' + declared.length + ' dash(es) declared for ' +
        blocks.length + ' series on chart part ' + (index + 1));
    }
    // A short list means the rest inherit the writer's solid line.
    const tokens = new Array(blocks.length).fill(null);
    declared.forEach((value, position) => {
      const token = seriesDashToken(value);
      if (!token) {
        throw new Error('Series line style patch: unknown dash "' + value + '" for series ' +
          (position + 1) + ' of chart part ' + (index + 1));
      }
      tokens[position] = token;
    });
    const applied = applySeriesLineStyles(xml, tokens);
    if (applied.changed > 0) {
      zip.file(names[index], applied.xml);
      touched += 1;
    }
  }
  if (touched) {
    const buffer = await zip.generateAsync({ type: 'nodebuffer' });
    fs.writeFileSync(outputPath, buffer);
  }
  return touched > 0;
}

/**
 * The writer spells one scatter style: `lineMarker`, which draws a line between points
 * that a scatter never claimed to connect. `marker` is what the word scatter means -
 * points on two numeric axes - so the file is corrected after it is written.
 */
async function patchScatterStyle(outputPath) {  const zip = await JSZip.loadAsync(fs.readFileSync(outputPath));
  const names = Object.keys(zip.files).filter((name) => /^ppt\/charts\/chart\d+\.xml$/u.test(name));
  let touched = 0;
  for (const name of names) {
    const file = zip.file(name);
    if (!file) continue;
    const xml = await file.async('string');
    if (!xml.includes('scatterStyle val="lineMarker"')) continue;
    zip.file(name, xml.replace(/<c:scatterStyle val="lineMarker"\/>/gu, '<c:scatterStyle val="marker"/>'));
    touched += 1;
  }
  if (touched) {
    const buffer = await zip.generateAsync({ type: 'nodebuffer' });
    fs.writeFileSync(outputPath, buffer);
  }
  return touched > 0;
}

/** Text for an XML attribute or element: the five characters that would break the part. */
function xmlText(value) {
  return String(value === undefined || value === null ? '' : value)
    .replace(/&/gu, '&amp;').replace(/</gu, '&lt;').replace(/>/gu, '&gt;')
    .replace(/"/gu, '&quot;');
}

/**
 * Every face the deck asks for: shapes, table cells, runs and the theme's own defaults.
 * A face that only appears in a theme is still the face an unset run renders in.
 */
function collectDeckFaces(deck) {
  const faces = new Set();
  const add = (value) => {
    const face = String(value || '').replace(/["']/gu, '').split(',')[0].trim();
    if (!face || /^(inherit|initial|unset|sans-serif|serif|monospace|system-ui)$/iu.test(face)) return;
    faces.add(face);
  };
  const walkElement = (element) => {
    if (!element || typeof element !== 'object') return;
    add(element.fontFace);
    (element.runs || []).forEach((run) => {
      if (run && run.options) add(run.options.fontFace);
    });
    (element.rows || []).forEach((row) => {
      (row.cells || []).forEach((cell) => {
        add(cell && cell.fontFace);
        ((cell && cell.runs) || []).forEach((run) => {
          if (run && run.options) add(run.options.fontFace);
        });
      });
    });
    (element.children || []).forEach(walkElement);
    (element.overlays || []).forEach(walkElement);
  };
  ((deck && deck.slides) || []).forEach((slide) => (slide.elements || []).forEach(walkElement));
  const themeFonts = (deck && deck.theme && deck.theme.fonts) || {};
  ['heading', 'body', 'cjk', 'mono'].forEach((key) => add(themeFonts[key]));
  return Array.from(faces);
}

/**
 * Embed the faces the deck was designed with.
 *
 * A deck that names a font nobody installed renders in the reader's substitute, which is how
 * a carefully measured layout arrives looking wrong. `p:embeddedFontLst` plus one
 * `ppt/fonts/*.fntdata` part per face is the OOXML answer, and PowerPoint honours it. Opt-in,
 * because the font's own bytes travel inside the package: a CJK face is tens of megabytes.
 * Only TrueType files embed; an OpenType/CFF or a collection is named instead of half-written.
 */
async function patchEmbeddedFonts(outputPath, deck, options = {}) {
  const { fontFileForFamily } = require('./font_manager');
  const faces = collectDeckFaces(deck);
  const wanted = [];
  const skipped = [];
  const seenFiles = new Map();
  faces.forEach((face) => {
    const file = fontFileForFamily(face);
    if (!file) { skipped.push({ face, reason: 'not installed on this machine' }); return; }
    if (!/\.ttf$/iu.test(file)) { skipped.push({ face, reason: 'not a TrueType file, so it cannot ride in fntdata' }); return; }
    wanted.push({ face, file });
  });
  if (!wanted.length) return { embedded: [], skipped };
  const zip = await JSZip.loadAsync(fs.readFileSync(outputPath));
  const relsFile = zip.file('ppt/_rels/presentation.xml.rels');
  const presFile = zip.file('ppt/presentation.xml');
  if (!relsFile || !presFile) return { embedded: [], skipped };
  let rels = await relsFile.async('string');
  let presentation = await presFile.async('string');
  const usedIds = Array.from(rels.matchAll(/Id="rId(\d+)"/gu), (match) => Number(match[1]));
  let nextId = (usedIds.length ? Math.max(...usedIds) : 0) + 1;
  const entries = [];
  const addedRels = [];
  wanted.forEach((entry, index) => {
    let partIndex = seenFiles.get(entry.file);
    if (!partIndex) {
      partIndex = seenFiles.size + 1;
      seenFiles.set(entry.file, partIndex);
      const partName = 'ppt/fonts/font' + partIndex + '.fntdata';
      zip.file(partName, fs.readFileSync(entry.file));
      const rid = 'rId' + nextId;
      nextId += 1;
      addedRels.push('<Relationship Id="' + rid + '" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/font" Target="fonts/font' + partIndex + '.fntdata"/>');
      entries.push({ face: entry.face, file: entry.file, part: partName, rid, bytes: fs.statSync(entry.file).size });
    }
  });
  rels = rels.replace('</Relationships>', addedRels.join('') + '</Relationships>');
  const list = entries.map((entry) => '<p:embeddedFont><p:font typeface="' + xmlText(entry.face) + '"/><p:regular r:id="' + entry.rid + '"/></p:embeddedFont>').join('');
  if (!presentation.includes('<p:embeddedFontLst>')) {
    const block = '<p:embeddedFontLst>' + list + '</p:embeddedFontLst>';
    const anchor = presentation.includes('<p:defaultTextStyle') ? '<p:defaultTextStyle' : '</p:presentation>';
    presentation = presentation.replace(anchor, block + anchor);
  }
  presentation = presentation.replace(/<p:presentation([^>]*?)(\/?)>/u, (whole, attrs, selfClose) => {
    if (/embedTrueTypeFonts=/u.test(attrs)) return whole;
    return '<p:presentation' + attrs + ' embedTrueTypeFonts="1"' + (selfClose || '') + '>';
  });
  // A part needs a content type or a reader offers to repair the package: the extension is
  // mapped once, which is how PowerPoint spells an embedded font.
  const typesFile = zip.file('[Content_Types].xml');
  if (typesFile) {
    let types = await typesFile.async('string');
    if (!/Extension="fntdata"/iu.test(types)) {
      types = types.replace('</Types>', '<Default Extension="fntdata" ContentType="application/x-fontdata"/></Types>');
      zip.file('[Content_Types].xml', types);
    }
  }
  zip.file('ppt/_rels/presentation.xml.rels', rels);
  zip.file('ppt/presentation.xml', presentation);
  const buffer = await zip.generateAsync({ type: 'nodebuffer', compression: 'DEFLATE', compressionOptions: { level: 6 } });
  fs.writeFileSync(outputPath, buffer);
  return { embedded: entries, skipped };
}

/**
 * Declare the slide's title as a title placeholder.
 *
 * Every heading this engine writes is a text box, which renders exactly right and is invisible to
 * PowerPoint's outline view, to accessibility names, to `Reset slide` and to any tool that reads
 * `slide.shapes.title`. A `<p:ph type="title"/>` in the shape's non-visual properties is all the
 * difference: the shape keeps its position, geometry and runs, and simply becomes the title.
 * The name in the selection pane follows it, so a title is findable by name too.
 */
function applyTitlePlaceholder(xml) {
  const withPh = xml.replace(/<p:nvPr>\s*<\/p:nvPr>/u, '<p:nvPr><p:ph type="title"/></p:nvPr>');
  if (withPh !== xml) return withPh.replace(/<p:cNvPr (id="\d+") name="[^"]*"/u, '<p:cNvPr $1 name="Title"');
  // A non-visual property block that already carries something (a hyperlink, a hidden flag).
  return xml.replace(/<p:nvPr>/u, '<p:nvPr><p:ph type="title"/>');
}

async function patchTitlePlaceholders(outputPath, deck, laidOut) {
  const slides = (deck && deck.slides) || [];
  const titled = (element) => Boolean(element && element.placeholderType === 'title' && element.type === 'text');
  if (!supplied(laidOut, slides).some((elements) => elements.some(titled))) return false;
  const zip = await JSZip.loadAsync(fs.readFileSync(outputPath));
  let touched = 0;
  for (let slideIndex = 0; slideIndex < slides.length; slideIndex += 1) {
    const shapeElements = serializedShapes(laidOut, slideIndex, deck);
    const target = shapeElements.findIndex(titled);
    if (target < 0) continue;
    const name = 'ppt/slides/slide' + (slideIndex + 1) + '.xml';
    const file = zip.file(name);
    if (!file) continue;
    const xml = await file.async('string');
    let shapeIndex = 0;
    let patched = 0;
    const next = xml.replace(/<p:sp>([\s\S]*?)<\/p:sp>/gu, (whole, inner) => {
      const position = shapeIndex;
      shapeIndex += 1;
      if (position !== target) return whole;
      const updated = applyTitlePlaceholder(inner);
      if (updated !== inner) patched += 1;
      return '<p:sp>' + updated + '</p:sp>';
    });
    if (shapeIndex !== shapeElements.length) {
      throw new Error('Title placeholder patch alignment mismatch on slide ' + (slideIndex + 1)
        + ': Deck Spec has ' + shapeElements.length + ' elements but PPTX has ' + shapeIndex + ' p:sp elements');
    }
    if (patched !== 1) {
      throw new Error('Title placeholder patch missed on slide ' + (slideIndex + 1));
    }
    zip.file(name, next);
    touched += 1;
  }
  if (!touched) return false;
  const buffer = await zip.generateAsync({ type: 'nodebuffer', compression: 'DEFLATE', compressionOptions: { level: 6 } });
  fs.writeFileSync(outputPath, buffer);
  return true;
}

async function generatePptx(deck, outputPath, options = {}) {
  if (!outputPath) throw new Error('outputPath is required');
  const result = await buildPresentation(deck, options);
  await result.pptx.writeFile({ fileName: outputPath });
  const laidOutShapes = result.laidOut.map((elements) => flattenElements(elements));
  if (laidOutShapes.some((elements) => elements.some((element) => element.type === 'shape' && element.gradient))) {
    await patchGradientFills(outputPath, deck, result.laidOut);
  }
  await patchTextIndents(outputPath, deck, result.laidOut);
  await patchLevelIndents(outputPath, deck, result.laidOut);
  await patchMarkerColours(outputPath, deck, result.laidOut);
  await patchTextColumns(outputPath, deck, result.laidOut);
  // Cell markers, which the writer drops for a table cell while it keeps the paragraphs.
  await patchCellBullets(outputPath, deck, result.laidOut);
  // Every numbered paragraph carried `startAt`, which reads as "start here" - so lists repeated
  // one number. Runs after the columns patch, which rewrites the same text bodies.
  await patchListNumbering(outputPath, deck, result.laidOut);
  await patchSmallCaps(outputPath, deck, result.laidOut);
  await patchClipGeometry(outputPath, deck, result.laidOut);
  await patchTitlePlaceholders(outputPath, deck, result.laidOut);
  await patchPictureAltText(outputPath);
  if (laidOutShapes.some((elements) => elements.some((element) => element.textShadow))) {
    await patchTextShadows(outputPath, deck, result.laidOut);
  }
  if (laidOutShapes.some((elements) => elements.some((element) => element.innerShadow))) {
    await patchInnerShadows(outputPath, deck, result.laidOut);
  }
  await patchImageEffects(outputPath, result.imagePlans);
  // A repeating background is `<a:tile>`, which the writer has no option for. After the image
  // effects, because this patch owns the fill mode and drops the source rectangle it writes.
  await patchTiledFills(outputPath, result.tiledFills);
  if (laidOutShapes.some((elements) => elements.some((element) => element.type === 'chart'
    && element.chartType === 'scatter'))) {
    await patchScatterStyle(outputPath);
  }
  // A data label's position, which the writer keeps for a bar or a line and drops for the
  // chart types its own validator refuses (a doughnut, an area, a radar). After the scatter
  // style, because both rewrite the same chart parts and this one only inserts an element.
  await patchDataLabelPositions(outputPath, deck, result.laidOut);
  // A dash per series, which the writer only offers for the whole chart. Last of the chart
  // patches: it works inside a `c:ser` that the two above only read.
  await patchSeriesLineStyles(outputPath, deck, result.laidOut);
  const cjkFace = (deck.theme && deck.theme.fonts && deck.theme.fonts.cjk) || (options.theme && options.theme.fonts && options.theme.fonts.cjk) || defaultTheme.fonts.cjk;
  await applyEastAsianFontPatch(outputPath, cjkFace);
  // A picture's hyperlink target is written raw where a text run's is escaped, so the rels part
  // could carry a lone `&` and no reader would open the deck without a repair prompt.
  await patchHyperlinkRelEscapes(outputPath);
  // The click an `<a href>` around a block asks for: written into each object's own `cNvPr`,
  // after every patch that writes shapes, so the walk sees the nodes it expects.
  await patchShapeHyperlinks(outputPath, deck, result.laidOut);
  const fontEmbedding = options.embedFonts ? await patchEmbeddedFonts(outputPath, deck, options) : { embedded: [], skipped: [] };
  // Last, after every patch that writes shapes: ids stay unique whatever the writer did.
  await patchShapeIds(outputPath);
  // The boxes the writer really used, for a gate that compares a render against the layout. The
  // CLI has --layout-out for people; a demo script that builds its own deck has nowhere to pass a
  // flag, so the environment can ask for the same file.
  const layoutTarget = options.layoutPath || process.env.NATIVE_LAYOUT_OUT;
  if (layoutTarget) {
    fs.writeFileSync(layoutTarget, JSON.stringify({
      pageSize: result.pageSize,
      slides: laidOutShapes.map((elements) => ({ elements }))
    }, null, 2) + '\n', 'utf8');
  }
  return {
    outputPath,
    report: result.report,
    pageSize: result.pageSize,
    fontReport: result.fontReport,
    // Pictures the writer was asked to place but could not read: named, never silent.
    droppedPictures: result.droppedPictures || [],
    embeddedFonts: fontEmbedding.embedded,
    skippedFonts: fontEmbedding.skipped,
    // The boxes the writer really used, containers already resolved to absolute
    // positions: a reader that checks the render needs these, not the nested spec.
    laidOut: laidOutShapes
  };
}

module.exports = {
  buildPresentation, generatePptx, applyEastAsianFontPatch, patchGradientFills, gradientFillXml,
  shapeStyle, isBoldWeight, buildImagePlan, applyImagePlan, patchImageEffects,
  applyTileFill, patchTiledFills, pictureFrameInches, applyTextColumns, patchTextColumns,
  applyDataLabelPosition, patchDataLabelPositions, dataLabelPositionToken,
  applySeriesLineStyle, applySeriesLineStyles, patchSeriesLineStyles, seriesDashToken,
  cellBulletMarker, applyCellBullets, patchCellBullets, bulletParagraphIndent, cellBulletIndentBase,
  applyRelsEscapes, patchHyperlinkRelEscapes,
  applyShapeClick, patchShapeHyperlinks, hyperlinkRegistry, hyperlinkId, spHyperlinkUrl,
  patchListNumbering, paragraphNumbering, applyListNumbering,
  applySmallCaps, patchSmallCaps, clipGeometryXml, applyClipGeometry, patchClipGeometry,
  applyTextIndent, patchTextIndents, applyMarkerColour,
  innerShadowXml, applyInnerShadow, patchInnerShadows,
  applyTextShadow, patchTextShadows, collectDeckFaces, patchEmbeddedFonts,
  applyTitlePlaceholder, patchTitlePlaceholders,
  looksLikeSourcePath, applyPictureAltText, patchPictureAltText
};
