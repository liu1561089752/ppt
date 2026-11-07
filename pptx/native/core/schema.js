'use strict';

const ELEMENT_TYPES = new Set(['text', 'shape', 'line', 'image', 'table']);

function validateDeck(deck) {
  const errors = [];
  if (!deck || typeof deck !== 'object') return ['Deck spec must be an object'];
  if (!Array.isArray(deck.slides) || deck.slides.length === 0) errors.push('deck.slides must be a non-empty array');
  (deck.slides || []).forEach((slide, slideIndex) => {
    const prefix = 'slides[' + slideIndex + ']';
    if (!slide || typeof slide !== 'object') { errors.push(prefix + ' must be an object'); return; }
    if (!Array.isArray(slide.elements)) errors.push(prefix + '.elements must be an array');
    (slide.elements || []).forEach((element, elementIndex) => {
      const p = prefix + '.elements[' + elementIndex + ']';
      if (!element || typeof element !== 'object') { errors.push(p + ' must be an object'); return; }
      if (!ELEMENT_TYPES.has(element.type)) errors.push(p + '.type must be one of: ' + Array.from(ELEMENT_TYPES).join(', '));
      if (element.type === 'text' && typeof element.text !== 'string' && !Array.isArray(element.text)) errors.push(p + '.text must be a string or rich-text run array');
      if (element.type === 'image' && !element.path && !element.data) errors.push(p + ' requires path or data');
      ['x', 'y', 'w', 'h'].forEach((key) => {
        if (element[key] !== undefined && (!Number.isFinite(element[key]) || element[key] < 0)) errors.push(p + '.' + key + ' must be a finite non-negative number');
      });
    });
  });
  return errors;
}

module.exports = { ELEMENT_TYPES, validateDeck };
