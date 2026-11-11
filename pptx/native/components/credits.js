'use strict';

const path = require('node:path');

/**
 * Image credits, collected from the deck instead of retyped next to it.
 *
 * A credit that lives in two places drifts: the deck's last page said one author for a photograph while
 * the page carrying it said another, because both were typed by hand. An image can now carry its own
 * `credit` ({ subject, author, licence }), and this walks the slides and returns the unique list - so the
 * credits page is derived, not remembered.
 */
function collectImageCredits(slides, options = {}) {
  const seen = new Map();
  const baseDir = options.baseDir || '';
  (Array.isArray(slides) ? slides : []).forEach((slide) => {
    const elements = (slide && slide.elements) || [];
    elements.forEach((element) => {
      if (!element || element.type !== 'image' || !element.credit) return;
      const file = element.path ? path.basename(String(element.path)) : '（内嵌图片）';
      const key = file + '|' + (element.credit.author || '');
      if (seen.has(key)) return;
      seen.set(key, {
        file: baseDir ? path.join(baseDir, file).replace(/\\/gu, '/') : file,
        subject: element.credit.subject || '',
        author: element.credit.author || '',
        licence: element.credit.licence || ''
      });
    });
  });
  return Array.from(seen.values());
}

/** The credit rows this engine can render, as table rows (header + one row per image). */
function creditRows(images) {
  return [[
    { text: '文件', options: { bold: true } },
    { text: '内容', options: { bold: true } },
    { text: '作者', options: { bold: true } },
    { text: '许可', options: { bold: true } }
  ]].concat((Array.isArray(images) ? images : []).map((image) => [
    { text: image.file }, { text: image.subject }, { text: image.author }, { text: image.licence }
  ]));
}

module.exports = { collectImageCredits, creditRows };
