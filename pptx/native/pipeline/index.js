'use strict';

/**
 * HTML → Native Deck Spec pipeline.
 *
 * Stages: HTML → DOM Analyzer → Layout Analyzer → Style Mapper → Native Deck
 * Spec → PPTX Engine. See `README.md` next to this file for the supported CSS
 * subset and the honest list of what is not translated.
 */

const fs = require('node:fs');
const path = require('node:path');

const { analyzeHtml } = require('./analyzer');
const { buildDeckSpec, deriveTheme } = require('./deck_builder');
const { auditAnalysis } = require('./collide');
const htmlParser = require('./html_parser');
const css = require('./css');
const { generatePptx } = require('../engine/native_pptx');
const { validateDeck } = require('../core/schema');

function collectTitle(analysis) {
  let title = null;
  analysis.slides.forEach((slide) => {
    if (title) return;
    const visit = (node) => {
      if (title) return;
      if (node.kind === 'text' && node.role === 'title' && node.text) title = node.text.split('\n')[0];
      (node.children || []).forEach(visit);
    };
    slide.nodes.forEach(visit);
  });
  return title;
}

/**
 * Convert HTML source into a native deck.
 * @param {string} html
 * @param {object} [options]
 * @returns {{deck: object, report: object, analysis: object, errors: string[]}}
 */
function convertHtml(html, options = {}) {
  const analysis = analyzeHtml(html, options);
  analysis.title = collectTitle(analysis);
  const { deck, report } = buildDeckSpec(analysis, options);
  const layout = auditAnalysis(analysis);
  // A table that was split onto further slides no longer runs off the page, so the analysis
  // overflow it would still report is not true of the deck that was written.
  if ((report.paginatedTables || []).length) {
    layout.slides.forEach((slide) => {
      const kept = slide.beyond.filter((entry) => !/^table\(/u.test(String(entry.node || '')));
      slide.overflows = slide.overflows.filter((entry) => !/^table\(/u.test(String(entry.node || '')));
      slide.beyond = kept;
    });
    layout.total = layout.slides.reduce((sum, slide) =>
      sum + slide.collisions.length + slide.overflows.length + slide.beyond.length, 0);
  }
  const errors = validateDeck(deck);
  return {
    deck,
    report: Object.assign({}, report, {
      notes: analysis.notes,
      unsupportedDetails: analysis.unsupported,
      stats: analysis.stats,
      layout
    }),
    analysis,
    errors
  };
}

/**
 * PptxGenJS reads picture files relative to the process cwd, so relative urls
 * from the HTML must be rebased onto the HTML file's own directory first.
 */
function resolveDeckImagePaths(deck, baseDirectory) {
  const isAbsolute = (value) => path.isAbsolute(value) || /^[a-zA-Z]:[\\/]/u.test(value);
  const rebase = (element) => {
    if (element.type !== 'image' || !element.path) return;
    if (isAbsolute(element.path) || /^(?:data|https?):/iu.test(element.path)) return;
    element.path = path.resolve(baseDirectory, element.path);
  };
  // Pictures travel inside containers too, so the walk covers the whole tree.
  const walk = (element) => {
    rebase(element);
    (element.children || []).forEach(walk);
  };
  deck.slides.forEach((slide) => {
    (slide.elements || []).forEach(walk);
  });
  return deck;
}

/** Convert an HTML file and optionally write the deck JSON and a PPTX. */
async function convertFile(inputPath, options = {}) {
  const absolute = path.resolve(inputPath);
  if (!fs.existsSync(absolute)) throw new Error('HTML file not found: ' + absolute);
  const html = fs.readFileSync(absolute, 'utf8');
  const baseDirectory = path.dirname(absolute);
  // The analyzer decides whether a relative picture path can be read, so it needs the folder the
  // HTML came from.
  const result = convertHtml(html, { ...options, baseDir: baseDirectory });
  resolveDeckImagePaths(result.deck, baseDirectory);

  if (options.out) {
    fs.mkdirSync(path.dirname(path.resolve(options.out)), { recursive: true });
    fs.writeFileSync(path.resolve(options.out), JSON.stringify(result.deck, null, 2));
  }
  if (options.reportPath) {
    fs.writeFileSync(path.resolve(options.reportPath), JSON.stringify(result.report, null, 2));
  }
  if (options.pptx) {
    if (result.errors.length) {
      throw new Error('Generated deck spec is invalid:\n- ' + result.errors.join('\n- '));
    }
    fs.mkdirSync(path.dirname(path.resolve(options.pptx)), { recursive: true });
    const written = await generatePptx(result.deck, path.resolve(options.pptx), {
      readImageFile: (file) => fs.readFileSync(path.isAbsolute(file) ? file : path.join(baseDirectory, file)),
      embedFonts: options.embedFonts === true
    });
    result.output = { pptx: written.outputPath, slides: written.report.length };
    // A picture the writer could not read is a hole in the slide, so it joins the same list
    // the rest of the honest reporting uses.
    (written.droppedPictures || []).forEach((entry) => {
      result.report.unsupportedDetails.push({
        slide: entry.slide, tag: 'img', property: 'src', value: entry.source, reason: entry.reason
      });
    });
    if (written.droppedPictures && written.droppedPictures.length) {
      result.output.droppedPictures = written.droppedPictures.length;
    }
    if (written.embeddedFonts && written.embeddedFonts.length) {
      result.output.embeddedFonts = written.embeddedFonts.map((entry) => ({ face: entry.face, bytes: entry.bytes }));
    }
    if (written.skippedFonts && written.skippedFonts.length) {
      result.output.skippedFonts = written.skippedFonts;
    }
    if (options.layoutPath) {
      const slides = (written.laidOut || []).map((elements) => ({
        elements: elements.filter((element) => element.type === 'text').map((element) => ({
          type: 'text',
          x: element.x, y: element.y, w: element.w, h: element.h,
          fontSize: element.fontSize,
          lineSpacingMultiple: element.lineSpacingMultiple,
          textHeight: element.textHeight,
          text: element.text,
          // The audit needs to know a box draws small caps: those runs come back from the
          // renderer as capitals, and comparing them case-sensitively would call them lost.
          ...(element.smallCaps ? { smallCaps: true } : {})
        }))
      }));
      fs.mkdirSync(path.dirname(path.resolve(options.layoutPath)), { recursive: true });
      fs.writeFileSync(path.resolve(options.layoutPath), JSON.stringify({ slides }, null, 2));
    }
  }
  return result;
}

module.exports = {
  convertHtml,
  convertFile,
  resolveDeckImagePaths,
  analyzeHtml,
  buildDeckSpec,
  deriveTheme,
  htmlParser,
  css
};
