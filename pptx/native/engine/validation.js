'use strict';

function intersection(a, b) {
  const x = Math.max(a.x, b.x);
  const y = Math.max(a.y, b.y);
  const w = Math.min(a.x + a.w, b.x + b.w) - x;
  const h = Math.min(a.y + a.h, b.y + b.h) - y;
  return w > 0 && h > 0 ? { x, y, w, h } : null;
}

function validateSlide(elements, pageSize, options = {}) {
  const warnings = [];
  const tolerance = options.boundsTolerance === undefined ? 0.015 : options.boundsTolerance;
  elements.forEach((el, i) => {
    if (el.x < -tolerance || el.y < -tolerance || el.x + el.w > pageSize.width + tolerance || el.y + el.h > pageSize.height + tolerance) {
      warnings.push({ code: 'OUT_OF_BOUNDS', element: i, message: 'Element ' + i + ' exceeds slide bounds', bounds: { x: el.x, y: el.y, w: el.w, h: el.h } });
    }
    if (el.type === 'text' && Number.isFinite(el._requiredTextHeight) && el._requiredTextHeight > el.h + tolerance) {
      warnings.push({
        code: 'TEXT_OVERFLOW_RISK',
        element: i,
        message: 'Estimated text height exceeds its text box height',
        requiredHeight: el._requiredTextHeight,
        actualHeight: el.h
      });
    }
  });
  const textItems = elements.map((el, i) => ({ el, i })).filter(({ el }) => el.type === 'text');
  for (let i = 0; i < textItems.length; i += 1) {
    for (let j = i + 1; j < textItems.length; j += 1) {
      const overlap = intersection(textItems[i].el, textItems[j].el);
      if (overlap) warnings.push({ code: 'TEXT_OVERLAP', elements: [textItems[i].i, textItems[j].i], message: 'Text elements ' + textItems[i].i + ' and ' + textItems[j].i + ' overlap', overlap });
    }
  }
  return warnings;
}

module.exports = { intersection, validateSlide };
