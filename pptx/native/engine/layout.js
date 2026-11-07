'use strict';

const { estimateTextHeight, wrapText } = require('./text_measure');

function layoutSlide(slide, pageSize, theme = {}, options = {}) {
  const margin = slide.margin === undefined ? (theme.margins?.x || 0.58) : slide.margin;
  const gap = slide.gap === undefined ? 0.22 : slide.gap;
  const contentWidth = pageSize.width - margin * 2;
  let cursorY = slide.startY === undefined ? (theme.margins?.y || margin) : slide.startY;

  return (slide.elements || []).map((source, index) => {
    const element = Object.assign({}, source);
    const explicitPosition = Number.isFinite(element.x) && Number.isFinite(element.y);
    const width = element.w === undefined ? contentWidth : element.w;
    let height = element.h;

    if (element.type === 'text') {
      const fontSize = element.fontSize || theme.sizes?.body || 16;
      const measureOptions = {
        fontManager: options.fontManager,
        fontFace: element.fontFace || theme.fonts?.body,
        lineHeight: element.lineSpacingMultiple || theme.lineSpacingMultiple || 1.22,
        safetyFactor: options.safetyFactor || 0.9
      };
      if (typeof element.text === 'string') {
        element._renderText = wrapText(element.text, width, fontSize, measureOptions);
        if (height === undefined) height = estimateTextHeight(element._renderText, width, fontSize, measureOptions);
      } else if (height === undefined) {
        const plainText = element.text.map((run) => typeof run === 'string' ? run : (run.text || '')).join('');
        element._requiredTextHeight = estimateTextHeight(plainText, width, fontSize, measureOptions);\n        height = height === undefined ? element._requiredTextHeight : height;
        element._layoutWarnings = ['Rich-text runs are measured as plain text; explicit line breaks are recommended.'];
      }
    } else if (height === undefined) {
      height = element.type === 'line' ? 0.01 : 1.0;
    }

    element.x = element.x === undefined ? margin : element.x;
    element.y = element.y === undefined ? cursorY : element.y;
    element.w = width;
    element.h = height;
    if (!explicitPosition) cursorY = Math.max(cursorY, element.y + height + gap);
    element._layoutIndex = index;
    return element;
  });
}

module.exports = { layoutSlide };
