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
      if (element.type === 'chart' && (!Array.isArray(element.data) || element.data.length === 0)) errors.push(p + '.data must be a non-empty chart series array');
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
