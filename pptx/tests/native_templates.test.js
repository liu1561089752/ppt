'use strict';

/**
 * The page templates and components learned four things the hard way in the acceptance decks, and each
 * one of them was a silent failure: a box invented a height, a card ignored its copy, a diagram dropped
 * a field nobody typed, a grid row was a constant. These tests pin the four, so the fifth deck cannot
 * reintroduce them.
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const { preset } = require('../native/themes/presets');
const templates = require('../native/templates');
const components = require('../native/components');

const theme = preset('clay');

const textElements = (elements) => elements.filter((element) => element.type === 'text');
const shapes = (elements) => elements.filter((element) => element.type === 'shape');

test('components.title measures its own box instead of inventing 0.62 in', () => {
  const one = components.title('短标题', { theme, x: 0.7, y: 1, w: 4.4, fontSize: 20 });
  const two = components.title('内蒙古阿拉善 200MW/800MWh', { theme, x: 0.7, y: 1, w: 4.4, fontSize: 20 });
  assert.ok(two.h > one.h, 'a title that wraps needs a taller box: ' + one.h + ' vs ' + two.h);
  // and the box is the measured height, not a smaller guess
  assert.equal(two.h, components.measuredHeight(two.text, 4.4, 20, theme));
  const fixed = components.title('短标题', { theme, x: 0.7, y: 1, w: 4.4, h: 1.1 });
  assert.equal(fixed.h, 1.1, 'an explicit height still wins');
});

test('templates.comparison sizes its cards from their copy, and can be told otherwise', () => {
  const short = templates.comparison({ theme, title: 'T', left: { title: 'A', body: '一行' }, right: { title: 'B', body: '一行' } });
  const paragraph = '这是一段足够长的说明文字，长到在卡片宽度里必须折成很多行才放得下，这样卡片就必须长高，而不能停在两点二英寸的下限上。';
  const long = templates.comparison({
    theme, title: 'T',
    left: { title: 'A', body: paragraph + paragraph },
    right: { title: 'B', body: paragraph + paragraph }
  });
  const heightOf = (page) => shapes(page.elements).filter((shape) => shape.h > 1)[0].h;
  assert.ok(heightOf(long) > heightOf(short), 'longer copy makes taller cards');
  const pinned = templates.comparison({ theme, title: 'T', cardHeight: 3.3, left: { title: 'A', body: '一行' }, right: { title: 'B', body: '一行' } });
  assert.equal(heightOf(pinned), 3.3, 'cardHeight overrides the measurement');
});

test('a comparison page can carry its own takeaway under the cards', () => {
  const without = templates.comparison({ theme, title: 'T', left: { title: 'A', body: 'x' }, right: { title: 'B', body: 'y' } });
  const withTakeaway = templates.comparison({
    theme, title: 'T', left: { title: 'A', body: 'x' }, right: { title: 'B', body: 'y' },
    takeaway: '结论写在这里，下半页就不是空白。'
  });
  assert.equal(textElements(withTakeaway.elements).length, textElements(without.elements).length + 1);
  const cardBottom = Math.max(...shapes(withTakeaway.elements).map((shape) => shape.y + shape.h));
  const line = textElements(withTakeaway.elements).pop();
  assert.ok(line.y >= cardBottom, 'the takeaway sits under the cards, not on them');
});

test('processFlow and timeline accept `body` as well as `description`', () => {
  const flow = components.processFlow([{ title: '采摘', body: '一芽一叶。' }, { title: '杀青', body: '高温定色。' }], { theme });
  assert.deepEqual(textElements(flow).map((element) => element.text), ['采摘', '一芽一叶。', '杀青', '高温定色。']);
  const line = components.timeline([{ date: 'M0', title: '立项', body: '国别尽调。' }], { theme });
  assert.ok(textElements(line).some((element) => element.text === '国别尽调。'), 'timeline reads body too');
});

test('a timeline keeps its end labels on the page and measures a two-line title', () => {
  const short = components.timeline([
    { date: 'M0', title: 'A', description: '一' },
    { date: 'M1', title: 'B', description: '二' }
  ], { theme, x: 0.85, y: 2, w: 11.6 });
  const tall = components.timeline([
    { date: 'M0', title: 'A', description: '一' },
    { date: 'M1', title: '措施与并网验收', description: '二' }
  ], { theme, x: 0.85, y: 2, w: 11.6 });
  [...short, ...tall].forEach((element) => {
    assert.ok(element.x >= 0, 'no label starts left of the page');
    assert.ok(element.x + (element.w || 0) <= 13.333, 'no label runs off the right edge');
  });
  // the title boxes are the ones drawn in the heading size
  const titleHeight = (elements) => Math.max(...textElements(elements)
    .filter((element) => element.fontSize === theme.sizes.heading)
    .map((element) => element.h));
  assert.ok(titleHeight(tall) > titleHeight(short), 'a two-line point gets a taller title box');
});

test('bento rows grow to their content instead of standing at the minimum', () => {
  const long = '这是一段足够长的说明文字，长到必须折成好几行，网格的这一行就应该长高，而不是把文字挤在一点四英寸里。';
  const flat = components.bento({ theme, columns: 3, items: [{ title: 'A', body: '一行' }, { title: 'B', body: '一行' }] });
  const grown = components.bento({ theme, columns: 3, items: [{ title: 'A', body: long }, { title: 'B', body: '一行' }] });
  const firstCard = (elements) => shapes(elements)[0];
  assert.ok(firstCard(grown).h > firstCard(flat).h, 'the row grew: ' + flat[0].h + ' -> ' + grown[0].h);
  // a cell that spans two rows is as tall as the two rows plus the gap between them
  const spanned = components.bento({
    theme, columns: 3, items: [{ title: 'A', body: long, rows: 2 }, { title: 'B', body: '一行' }, { title: 'C', body: '一行' }]
  });
  const cards = shapes(spanned);
  const rowOne = cards.filter((card) => card.y === cards[0].y && card !== cards[0]);
  const gap = theme.layouts.columnGap;
  assert.ok(Math.abs(cards[0].h - (rowOne[0].h * 2 + gap)) < 1e-6, 'a 2-row cell is two rows plus one gap');
});

test('templates.table measures every row and keeps the takeaway under the table', () => {
  const page = templates.table({
    theme,
    title: '成本结构',
    intro: '一句口径说明。',
    rows: [
      ['环节', '占比', '说明'],
      ['采摘', '30%', '人工'],
      ['加工', '18%', '能耗与经验，名优茶更高一些；这一格刻意写得很长，长到在六点四英寸的列宽里必须折成两行以上，用来检验行高是不是真的按内容算出来的，而不是按行数猜的。']
    ],
    colWidths: [2.6, 2.2, 6.4],
    takeaway: '前两行决定底价，后三行决定售价。',
    source: '来源：测试。'
  });
  const table = page.elements.find((element) => element.type === 'table');
  assert.ok(table, 'the page has a table');
  assert.equal(table.rows.length, 3);
  const measured = table.options.rowH;
  assert.equal(measured.length, 3);
  assert.ok(measured[2] > measured[1], 'the row with a wrapping cell is taller');
  assert.ok(Math.abs(table.h - measured.reduce((sum, value) => sum + value, 0)) < 1e-9, 'the frame is the sum of its rows');
  const takeaway = textElements(page.elements).find((element) => element.text.indexOf('决定售价') >= 0);
  assert.ok(takeaway.y >= table.y + table.h, 'the takeaway starts below the table');
  assert.equal(table.rows[0][0].options.bold, true, 'the header row is styled');
});

test('the credits page is derived from the images, not typed again', () => {
  const credit = { subject: '茶园', author: '某人', licence: 'CC BY 4.0' };
  const slides = [
    { elements: [{ type: 'image', path: 'assets/a.jpg', credit }] },
    { elements: [{ type: 'image', path: 'assets/a.jpg', credit }, { type: 'image', path: 'assets/b.jpg', credit: Object.assign({}, credit, { subject: '干茶' }) }] }
  ];
  const images = components.collectImageCredits(slides);
  assert.equal(images.length, 2, 'the same picture used twice is credited once');
  assert.deepEqual(images.map((image) => image.file), ['a.jpg', 'b.jpg']);
  const page = templates.credits({ theme, images });
  const table = page.elements.find((element) => element.type === 'table');
  assert.equal(table.rows.length, 1 + images.length, 'header plus one row per picture');
  assert.equal(table.rows[1][2].text, '某人');
  assert.equal(table.rows[1][3].text, 'CC BY 4.0');
});
