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
  const errors = validateDeck(deck);
  return {
    deck,
    report: Object.assign({}, report, {
      notes: analysis.notes,
      unsupportedDetails: analysis.unsupported,
      stats: analysis.stats
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
  deck.slides.forEach((slide) => {
    (slide.elements || []).forEach((element) => {
      if (element.type !== 'image' || !element.path) return;
      if (isAbsolute(element.path) || /^(?:data|https?):/iu.test(element.path)) return;
      element.path = path.resolve(baseDirectory, element.path);
    });
  });
  return deck;
}

/** Convert an HTML file and optionally write the deck JSON and a PPTX. */
async function convertFile(inputPath, options = {}) {
  const absolute = path.resolve(inputPath);
  if (!fs.existsSync(absolute)) throw new Error('HTML file not found: ' + absolute);
  const html = fs.readFileSync(absolute, 'utf8');
  const baseDirectory = path.dirname(absolute);
  const result = convertHtml(html, options);
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
      readImageFile: (file) => fs.readFileSync(path.isAbsolute(file) ? file : path.join(baseDirectory, file))
    });
    result.output = { pptx: written.outputPath, slides: written.report.length };
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
