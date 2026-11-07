'use strict';

const ELEMENT_TYPES = new Set(['text', 'shape', 'line', 'image', 'table', 'chart']);

function validateDeck(deck) {
  const errors = [];
  if (!deck || typeof deck !== 'object' || Array.isArray(deck)) return ['Deck spec must be an object'];
  if (!Array.isArray(deck.slides) || deck.slides.length === 0) errors.push('deck.slides must be a non-empty array');

  const slides = Array.isArray(deck.slides) ? deck.slides : [];
  slides.forEach((slide, slideIndex) => {
    const prefix = 'slides[' + slideIndex + ']';
    if (!slide || typeof slide !== 'object' || Array.isArray(slide)) {
      errors.push(prefix + ' must be an object');
      return;
    }
    if (!Array.isArray(slide.elements)) {
      errors.push(prefix + '.elements must be an array');
      return;
    }
    slide.elements.forEach((element, elementIndex) => {
      const p = prefix + '.elements[' + elementIndex + ']';
      if (!element || typeof element !== 'object' || Array.isArray(element)) {
        errors.push(p + ' must be an object');
        return;
      }
      if (!ELEMENT_TYPES.has(element.type)) errors.push(p + '.type must be one of: ' + Array.from(ELEMENT_TYPES).join(', '));
      if (element.type === 'text' && typeof element.text !== 'string' && !Array.isArray(element.text)) {
        errors.push(p + '.text must be a string or rich-text run array');
      }
      if (element.type === 'text' && Array.isArray(element.text) && element.text.some((run) => typeof run !== 'string' && (!run || typeof run !== 'object' || typeof run.text !== 'string'))) {
        errors.push(p + '.text rich-text runs must be strings or objects with a text field');
      }
      if (element.type === 'image' && !element.path && !element.data) errors.push(p + ' requires path or data');
      if (element.type === 'text' && element.transparency !== undefined &&
          (!Number.isFinite(element.transparency) || element.transparency < 0 || element.transparency > 100)) {
        errors.push(p + '.transparency must be between 0 and 100');
      }
      if (element.type === 'text' && element.fontSize !== undefined &&
          (!Number.isFinite(element.fontSize) || element.fontSize <= 0)) {
        errors.push(p + '.fontSize must be finite and greater than zero');
      }
      if (element.type === 'text') {
        ['charSpacing', 'paraSpaceBeforePt', 'paraSpaceAfterPt'].forEach((key) => {
          if (element[key] !== undefined && (!Number.isFinite(element[key]) || (key !== 'charSpacing' && element[key] < 0))) {
            errors.push(p + '.' + key + ' must be finite' + (key === 'charSpacing' ? '' : ' and non-negative'));
          }
        });
        if (element.lineSpacingMultiple !== undefined &&
            (!Number.isFinite(element.lineSpacingMultiple) || element.lineSpacingMultiple <= 0)) {
          errors.push(p + '.lineSpacingMultiple must be finite and greater than zero');
        }
        if (element.bullet !== undefined && typeof element.bullet !== 'boolean' &&
            (typeof element.bullet !== 'object' || element.bullet === null || Array.isArray(element.bullet))) {
          errors.push(p + '.bullet must be a boolean or options object');
        }
      }
      if (element.type === 'line' && element.transparency !== undefined &&
          (!Number.isFinite(element.transparency) || element.transparency < 0 || element.transparency > 100)) {
        errors.push(p + '.transparency must be between 0 and 100');
      }
      if (element.type === 'shape') {
        ['transparency', 'fillTransparency', 'lineTransparency'].forEach((key) => {
          if (element[key] !== undefined && (!Number.isFinite(element[key]) || element[key] < 0 || element[key] > 100)) {
            errors.push(p + '.' + key + ' must be between 0 and 100');
          }
        });
        if (element.rotate !== undefined && !Number.isFinite(element.rotate)) errors.push(p + '.rotate must be finite');
        if (element.radius !== undefined && (!Number.isFinite(element.radius) || element.radius < 0)) errors.push(p + '.radius must be finite and non-negative');
        ['fill', 'lineColor'].forEach((key) => {
          if (typeof element[key] === 'string' && !/^#?[0-9a-f]{6}$/iu.test(element[key])) {
            errors.push(p + '.' + key + ' must be a six-digit hex color');
          }
        });
        if (element.shadow !== undefined && element.shadow !== false && typeof element.shadow === 'object') {
          const shadow = element.shadow;
          if (shadow.opacity !== undefined && (!Number.isFinite(shadow.opacity) || shadow.opacity < 0 || shadow.opacity > 1)) errors.push(p + '.shadow.opacity must be between 0 and 1');
          ['blur', 'distance'].forEach((key) => {
            if (shadow[key] !== undefined && (!Number.isFinite(shadow[key]) || shadow[key] < 0)) errors.push(p + '.shadow.' + key + ' must be finite and non-negative');
          });
          if (shadow.angle !== undefined && !Number.isFinite(shadow.angle)) errors.push(p + '.shadow.angle must be finite');
          if (shadow.type !== undefined && !['outer', 'inner'].includes(shadow.type)) errors.push(p + '.shadow.type must be outer or inner');
          if (shadow.color !== undefined && (typeof shadow.color !== 'string' || !/^#?[0-9a-f]{6}$/iu.test(shadow.color))) errors.push(p + '.shadow.color must be a six-digit hex color');
        } else if (element.shadow !== undefined && element.shadow !== false && element.shadow !== true) {
          errors.push(p + '.shadow must be a boolean or options object');
        }
      }
      if (element.gradient !== undefined) {
        if (element.type !== 'shape') errors.push(p + '.gradient is only supported on shapes');
        const stops = element.gradient && element.gradient.stops;
        if (!Array.isArray(stops) || stops.length < 2) errors.push(p + '.gradient.stops must contain at least two stops');
        else stops.forEach((stop, stopIndex) => {
          if (!stop || typeof stop.color !== 'string' || !/^#?[0-9a-f]{6}$/iu.test(stop.color)) errors.push(p + '.gradient.stops[' + stopIndex + '].color must be a six-digit hex color');
          if (!Number.isFinite(stop.position) || stop.position < 0 || stop.position > 1) errors.push(p + '.gradient.stops[' + stopIndex + '].position must be between 0 and 1');
          if (stop.transparency !== undefined && (!Number.isFinite(stop.transparency) || stop.transparency < 0 || stop.transparency > 100)) errors.push(p + '.gradient.stops[' + stopIndex + '].transparency must be between 0 and 100');
        });
        if (element.gradient && element.gradient.angle !== undefined && !Number.isFinite(element.gradient.angle)) errors.push(p + '.gradient.angle must be finite');
      }
      if (element.type === 'chart') {
        const chartTypes = new Set(['bar', 'line', 'pie', 'doughnut', 'area']);
        if (element.chartType !== undefined && !chartTypes.has(element.chartType)) errors.push(p + '.chartType is not supported');
        if (!Array.isArray(element.data) || element.data.length === 0) {
          errors.push(p + '.data must be a non-empty chart series array');
        } else {
          element.data.forEach((series, seriesIndex) => {
            if (!series || !Array.isArray(series.labels) || !Array.isArray(series.values) || series.labels.length !== series.values.length || series.values.some((value) => !Number.isFinite(value))) {
              errors.push(p + '.data[' + seriesIndex + '] must have matching labels and finite numeric values');
            }
          });
        }
      }
      ['x', 'y', 'w', 'h'].forEach((key) => {
        if (element[key] !== undefined && (!Number.isFinite(element[key]) || element[key] < 0)) {
          errors.push(p + '.' + key + ' must be a finite non-negative number');
        }
      });
      if (element.type === 'line') {
        if (element.w === 0 && element.h === 0) errors.push(p + ' line must have a non-zero width or height');
      } else {
        ['w', 'h'].forEach((key) => {
          if (element[key] === 0) errors.push(p + '.' + key + ' must be greater than zero');
        });
      }
    });
  });
  return errors;
}

module.exports = { ELEMENT_TYPES, validateDeck };
