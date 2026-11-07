'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { toInches, normalizePageSize } = require('../native/core/units');
const { validateDeck } = require('../native/core/schema');
const { estimateLineCount, estimateTextHeight, wrapText } = require('../native/engine/text_measure');
const { FontManager } = require('../native/engine/font_manager');
const { layoutSlide } = require('../native/engine/layout');
const { validateSlide } = require('../native/engine/validation');

test('unit conversion is explicit and deterministic', () => {
  assert.equal(toInches(72, 'pt'), 1);
  assert.equal(toInches(96, 'px'), 1);
  assert.deepEqual(normalizePageSize('standard'), { width: 10, height: 7.5 });
});

test('deck schema rejects malformed elements', () => {
  assert.ok(validateDeck({ slides: [{ elements: [{ type: 'unknown' }] }] }).length > 0);
  assert.deepEqual(validateDeck({ slides: [{ elements: [{ type: 'text', text: '你好' }] }] }), []);
});

test('CJK text is conservatively measured wider than Latin text', () => {
  const cjk = estimateLineCount('中文排版测试中文排版测试中文排版测试', 2, 18);
  const latin = estimateLineCount('abcdefghijklmnopqr', 2, 18);
  assert.ok(cjk >= latin);
  assert.ok(estimateTextHeight('一段中文文本', 3, 18) > 0);
});

test('layout assigns sequential positions and estimated text heights', () => {
  const elements = layoutSlide({ elements: [{ type: 'text', text: '标题', fontSize: 24 }, { type: 'text', text: '正文', fontSize: 16 }] }, normalizePageSize('wide'), {});
  assert.equal(elements[0].x, 0.58);
  assert.ok(elements[1].y > elements[0].y);
  assert.ok(elements[0].h > 0);
});

test('validator reports out-of-bounds and overlapping text', () => {
  const warnings = validateSlide([
    { type: 'text', x: 1, y: 1, w: 3, h: 1 },
    { type: 'text', x: 2, y: 1.5, w: 3, h: 1 },
    { type: 'shape', x: 13, y: 7, w: 2, h: 1 }
  ], { width: 13.333, height: 7.5 });
  assert.ok(warnings.some((w) => w.code === 'TEXT_OVERLAP'));
  assert.ok(warnings.some((w) => w.code === 'OUT_OF_BOUNDS'));
});


test('text wrapping inserts explicit line breaks for long CJK content', () => {
  const wrapped = wrapText('这是一个用于测试中文文本自动换行的较长句子', 1.5, 18);
  assert.ok(wrapped.includes('\\n'));
  assert.ok(wrapped.split('\\n').length > 1);
});

test('font manager safely falls back when no font files are configured', () => {
  const manager = new FontManager();
  assert.equal(manager.measure('中文', 18, 'Missing Font'), null);
  assert.equal(manager.inspect().configuredFaces.length, 0);
});

test('validator detects fixed-height text overflow risk', () => {
  const elements = layoutSlide({
    elements: [{ type: 'text', text: '这是一段很长很长的中文内容，需要自动换行并且高度不足时发出警告。'.repeat(4), x: 1, y: 1, w: 1.4, h: 0.25, fontSize: 18 }]
  }, normalizePageSize('wide'), {});
  const warnings = validateSlide(elements, normalizePageSize('wide'));
  assert.ok(warnings.some((warning) => warning.code === 'TEXT_OVERFLOW_RISK'));
});
