'use strict';

const { buildPresentation, generatePptx, patchImageEffects } = require('./engine/native_pptx');
const { validateDeck } = require('./core/schema');
const { normalizePageSize, toInches } = require('./core/units');
const { layoutSlide } = require('./engine/layout');
const { validateSlide } = require('./engine/validation');
const { FontManager } = require('./engine/font_manager');
const { wrapText, estimateTextHeight, estimateLineCount, measureTextPt } = require('./engine/text_measure');
const imageFit = require('./engine/image_fit');
const defaultTheme = require('./themes/default');
const { resolveTheme, themeColor } = require('./themes/design_system');
const components = require('./components');
const templates = require('./templates');

// The HTML -> Native pipeline loads lazily: a hand-authored deck never pays for
// the parser, and requiring it eagerly here could form a cycle.
let pipelineModule = null;
const pipelineApi = () => {
  if (!pipelineModule) pipelineModule = require('./pipeline');
  return pipelineModule;
};

module.exports = {
  buildPresentation, generatePptx, validateDeck, normalizePageSize, toInches,
  layoutSlide, validateSlide, FontManager, wrapText, estimateTextHeight,
  estimateLineCount, measureTextPt, defaultTheme, resolveTheme, themeColor, components, templates,
  patchImageEffects,
  resolveImageGeometry: imageFit.resolveImageGeometry,
  readImageSize: imageFit.readImageSize,
  computeCoverCrop: imageFit.computeCoverCrop,
  computeContainBox: imageFit.computeContainBox,
  convertHtml: (html, options) => pipelineApi().convertHtml(html, options),
  convertFile: (file, options) => pipelineApi().convertFile(file, options)
};
