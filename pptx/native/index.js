'use strict';

const { buildPresentation, generatePptx } = require('./engine/native_pptx');
const { validateDeck } = require('./core/schema');
const { normalizePageSize, toInches } = require('./core/units');
const { layoutSlide } = require('./engine/layout');
const { validateSlide } = require('./engine/validation');
const { FontManager } = require('./engine/font_manager');
const { wrapText, estimateTextHeight, estimateLineCount, measureTextPt } = require('./engine/text_measure');
const defaultTheme = require('./themes/default');
const { resolveTheme, themeColor } = require('./themes/design_system');
const components = require('./components');
const templates = require('./templates');

module.exports = {
  buildPresentation, generatePptx, validateDeck, normalizePageSize, toInches,
  layoutSlide, validateSlide, FontManager, wrapText, estimateTextHeight,
  estimateLineCount, measureTextPt, defaultTheme, resolveTheme, themeColor, components, templates
};
