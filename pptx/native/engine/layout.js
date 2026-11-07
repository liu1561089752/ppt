'use strict';

const { estimateTextHeight } = require('./text_measure');

function layoutSlide(slide, pageSize, theme = {}) {
  const margin = slide.margin === undefined ? 0.58 : slide.margin;
  const gap = slide.gap === undefined ? 0.22 : slide.gap;
  const contentWidth = pageSize.width - margin * 2;
  let cursorY = margin;

  return (slide.elements || []).map((source, index) => {
    const element = Object.assign({}, source);
    const explicitPosition = Number.isFinite(element.x) && Number.isFinite(element.y);
    const width = element.w === undefined ? contentWidth : element.w;
    let height = element.h;

    if (element.type === 'text') {
      const fontSize = element.fontSize || theme.sizes?.body || 16;
      const plainText = Array.isArray(element.text)
        ? element.text.map((run) => typeof run === 'string' ? run : (run.text || '')).join('')
        : element.text;
      if (height === undefined) height = estimateTextHeight(plainText, width, fontSize, {
        lineHeight: element.lineSpacingMultiple || theme.lineSpacingMultiple || 1.22
      });
    } else if (height === undefined) {
      height = element.type === 'line' ? 0.01 : 1.0;
    }

    element.x = element.x === undefined ? margin : element.x;
    element.y = element.y === undefined ? cursorY : element.y;
    element.w = width;
    element.h = height;
    if (!explicitPosition && source.y === undefined) cursorY = element.y + height + gap;
    element._layoutIndex = index;
    return element;
  });
}

module.exports = { layoutSlide };
