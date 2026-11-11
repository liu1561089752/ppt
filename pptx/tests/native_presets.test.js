'use strict';

/**
 * The presets exist to stop a deck from being white pages with white cards on them, so the tests are
 * the two rules in `themes/presets.js`: a card has to read as a card, and text has to stay legible
 * everywhere a template puts it.
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const { preset, presetNames } = require('../native/themes/presets');
const { contrastRatio } = require('../native/themes/design_system');
const templates = require('../native/templates');
const components = require('../native/components');

test('every preset keeps its text legible', () => {
  presetNames.forEach((name) => {
    const { colors } = preset(name);
    const ratio = (first, second) => contrastRatio(colors[first], colors[second]);
    assert.ok(ratio('foreground', 'background') >= 4.5,
      name + ': body text on the page is ' + ratio('foreground', 'background').toFixed(2) + ':1');
    assert.ok(ratio('foreground', 'surface') >= 4.5,
      name + ': body text on a card is ' + ratio('foreground', 'surface').toFixed(2) + ':1');
    assert.ok(ratio('muted', 'background') >= 4.5,
      name + ': captions on the page are ' + ratio('muted', 'background').toFixed(2) + ':1');
    assert.ok(ratio('primary', 'background') >= 4.5,
      name + ': a title in the primary colour is ' + ratio('primary', 'background').toFixed(2) + ':1');
    assert.ok(ratio('accent', 'background') >= 3,
      name + ': an accent number or rule is ' + ratio('accent', 'background').toFixed(2) + ':1');
    // KPI numbers and titles are drawn inside cards as often as on the page.
    assert.ok(ratio('accent', 'surface') >= 3,
      name + ': an accent number on a card is ' + ratio('accent', 'surface').toFixed(2) + ':1');
    assert.ok(ratio('primary', 'surface') >= 4.5,
      name + ': a title on a card is ' + ratio('primary', 'surface').toFixed(2) + ':1');
    // `templates.section()` writes the background colour as ink on a primary field.
    assert.ok(ratio('background', 'primary') >= 4.5,
      name + ': a title on a colour field is ' + ratio('background', 'primary').toFixed(2) + ':1');
  });
});

test('no preset is a white page with white cards', () => {
  presetNames.forEach((name) => {
    const { colors } = preset(name);
    assert.notEqual(colors.background.toUpperCase(), 'FFFFFF', name + ' has a page colour of its own');
    assert.ok(contrastRatio(colors.surface, colors.background) >= 1.05,
      name + ': a card has to read as a card (' + contrastRatio(colors.surface, colors.background).toFixed(3) + ')');
  });
});

test('a content page is painted with the page colour, not the card colour', () => {
  // The old template used `surface` here, which is why every content page was pure white with white
  // cards on it. This is that bug, pinned.
  const theme = preset('sand');
  assert.equal(templates.content({ theme }).background, theme.colors.background);
  assert.notEqual(theme.colors.background, theme.colors.surface);
});

test('a section page is one colour field with legible ink', () => {
  const theme = preset('clay');
  const page = templates.section({ theme, kicker: '02 打法', title: '三条战线', subtitle: '各自算账' });
  assert.equal(page.background, theme.colors.primary, 'the field is the primary colour');
  const title = page.elements.find((element) => element.type === 'text' && element.fontSize > 20);
  assert.equal(title.color, theme.colors.background, 'the title is written in the page colour');
  const rule = page.elements.find((element) => element.type === 'shape');
  assert.ok(contrastRatio(rule.fill, page.background) >= 3,
    'the rule is visible on its own field: ' + contrastRatio(rule.fill, page.background).toFixed(2));
});

test('numbers get a face of their own, defaulting to the heading', () => {
  // SKILL.md told writers "render numbers in the numeric face the theme declares" while the theme had
  // no such slot - the field did not exist, so every number silently rendered in the heading face.
  const theme = preset('sand');
  assert.equal(theme.fonts.numeric, theme.fonts.heading, 'a theme with no numeric face inherits the heading');
  const declared = preset('sand', { fonts: { heading: 'Aptos Display', body: 'Aptos', numeric: 'Consolas' } });
  assert.equal(declared.fonts.numeric, 'Consolas');
  const card = components.kpiCard({ theme: declared, label: '增长率', value: '128%' });
  const value = card.find((element) => element.type === 'text' && element.fontSize > 20);
  assert.equal(value.fontFace, 'Consolas', 'the KPI value is drawn in the numeric face');
});

test('the size scale has the two ends the original declared', () => {
  const { sizes } = preset('ink');
  assert.ok(Number.isFinite(sizes.display) && sizes.display > sizes.title, 'display sits above title');
  assert.ok(Number.isFinite(sizes.micro) && sizes.micro < sizes.caption, 'micro sits below caption');
});

test('a bento grid keeps one gutter and never overlaps two cards', () => {
  const theme = preset('sand');
  const elements = components.bento({
    theme, x: 0.9, w: 11.5, y: 1.8, columns: 3, rowHeight: 1.7, gap: 0.25,
    items: [
      { kicker: '01', title: 'A', body: 'a', columns: 2 },
      { kicker: '02', title: 'B', body: 'b' },
      { kicker: '03', title: 'C', body: 'c' },
      { kicker: '04', title: 'D', body: 'd', columns: 2 }
    ]
  });
  const cards = elements.filter((element) => element.type === 'shape');
  assert.equal(cards.length, 4, 'one card per item');
  const cellWidth = (11.5 - 0.25 * 2) / 3;
  assert.ok(Math.abs(cards[0].w - (cellWidth * 2 + 0.25)) < 1e-9, 'a 2-column card spans one gutter too');
  assert.ok(Math.abs(cards[1].x - (0.9 + 2 * (cellWidth + 0.25))) < 1e-9, 'the second card starts after two columns');
  assert.ok(cards[2].y > cards[0].y + cards[0].h, 'the second row starts below the first');
  for (let a = 0; a < cards.length; a += 1) {
    for (let b = a + 1; b < cards.length; b += 1) {
      const first = cards[a];
      const second = cards[b];
      const apart = first.x + first.w <= second.x + 1e-9 || second.x + second.w <= first.x + 1e-9
        || first.y + first.h <= second.y + 1e-9 || second.y + second.h <= first.y + 1e-9;
      assert.ok(apart, 'cards ' + a + ' and ' + b + ' overlap');
    }
  }
});

test('a quote on a colour field is written in the ink that field can hold', () => {
  const theme = preset('sand');
  const page = templates.quote({
    theme, quote: '把车卖出去不难。', attribution: '某人', role: '访谈', background: theme.colors.primary
  });
  const sentence = page.elements.find((element) => element.type === 'text' && element.fontSize > 20);
  assert.equal(sentence.color, theme.colors.background);
  assert.ok(contrastRatio(sentence.color, page.background) >= 4.5);
});

test('the quote mark is decoration and can be switched off', () => {
  const theme = preset('ink');
  const texts = (options) => templates.quote(Object.assign({ theme, quote: 'x' }, options))
    .elements.filter((element) => element.type === 'text').length;
  assert.equal(texts({}), 2, 'mark + sentence');
  assert.equal(texts({ mark: false }), 1, 'sentence only');
});

test('an unknown preset is refused, not silently defaulted', () => {
  assert.throws(() => preset('neon'), /unknown preset "neon"/u);
});
