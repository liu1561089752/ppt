'use strict';

function title(text, options = {}) {
  return {
    type: 'text', text,
    x: options.x === undefined ? 0.72 : options.x,
    y: options.y === undefined ? 0.62 : options.y,
    w: options.w === undefined ? 11.9 : options.w,
    h: options.h === undefined ? 0.62 : options.h,
    fontFace: options.fontFace || 'Aptos Display',
    fontSize: options.fontSize || 30,
    bold: options.bold === undefined ? true : options.bold,
    color: options.color || '183B3A',
    align: options.align || 'left',
    valign: 'mid',
    margin: 0
  };
}

function paragraph(text, options = {}) {
  return {
    type: 'text', text,
    x: options.x === undefined ? 0.74 : options.x,
    y: options.y === undefined ? 1.55 : options.y,
    w: options.w === undefined ? 11.85 : options.w,
    h: options.h,
    fontFace: options.fontFace || 'Aptos',
    fontSize: options.fontSize || 16,
    color: options.color || '394541',
    bold: !!options.bold,
    align: options.align || 'left',
    valign: options.valign || 'top',
    margin: options.margin === undefined ? 0.02 : options.margin
  };
}

function divider(options = {}) {
  return {
    type: 'line',
    x: options.x === undefined ? 0.74 : options.x,
    y: options.y === undefined ? 1.38 : options.y,
    w: options.w === undefined ? 11.85 : options.w,
    h: 0,
    color: options.color || 'D36B45',
    width: options.width || 1.4
  };
}

module.exports = { title, paragraph, divider };
