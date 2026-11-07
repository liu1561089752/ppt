'use strict';

const { buildPresentation, generatePptx } = require('./engine/native_pptx');
const { validateDeck } = require('./core/schema');
const { normalizePageSize, toInches } = require('./core/units');
const { layoutSlide } = require('./engine/layout');
const { validateSlide } = require('./engine/validation');
const defaultTheme = require('./themes/default');

module.exports = {
  buildPresentation, generatePptx, validateDeck, normalizePageSize, toInches,
  layoutSlide, validateSlide, defaultTheme
};
