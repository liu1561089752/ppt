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

test('an unknown preset is refused, not silently defaulted', () => {
  assert.throws(() => preset('neon'), /unknown preset "neon"/u);
});
