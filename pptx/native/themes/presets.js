'use strict';

/**
 * Colour presets.
 *
 * Why this file exists: the engine shipped one theme, and it was pale - `background` off-white,
 * `surface` pure white - and `templates.content()` painted pages with `surface`. Every deck that did
 * not invent its own palette therefore came out as white pages with white cards on them, which is not
 * a design decision anybody made; it was the default. A deck is judged on colour before it is read,
 * so the system has to ship colour.
 *
 * Two rules every preset keeps, both asserted in `tests/native_presets.test.js`:
 *   1. `surface` is visibly different from `background` - a card has to be a card, not a hole.
 *   2. text stays legible everywhere it is placed: `foreground` and `muted` on the background and on
 *      the surface, `primary` and `accent` as title / graphic colours, and the background colour used
 *      as ink on a `primary` colour field (that is how `templates.section()` writes its title).
 *
 * A preset is a partial theme: `resolveTheme` fills in the rest (sizes, spacing, radii, effects).
 */

const { resolveTheme } = require('./design_system');

const presets = {
  // Deep ink. The whole deck can live on this: dark ground, lighter panels, warm text.
  ink: {
    name: 'ink',
    colors: {
      background: '12202B',
      surface: '1A2C39',
      foreground: 'EEF3F6',
      primary: 'F0D9A8',
      accent: 'E4785C',
      muted: 'A9BAC6',
      border: '2C4150'
    },
    sizes: { title: 34, heading: 20, body: 14, caption: 10 },
    lineSpacingMultiple: 1.3
  },

  // Warm sand: a paper tint that reads as "printed", with ink-brown titles.
  sand: {
    name: 'sand',
    colors: {
      background: 'F2E8D9',
      surface: 'FFFCF6',
      foreground: '2B2118',
      primary: '4E3A26',
      accent: 'B4552B',
      muted: '75634E',
      border: 'E1D2BC'
    },
    sizes: { title: 34, heading: 20, body: 14, caption: 10 },
    lineSpacingMultiple: 1.32
  },

  // Mist green: cool, quiet, still a colour.
  sage: {
    name: 'sage',
    colors: {
      background: 'E6EFE8',
      surface: 'FBFDFB',
      foreground: '1E2B24',
      primary: '1F4438',
      accent: 'C0653A',
      muted: '4F6659',
      border: 'CFDED4'
    },
    sizes: { title: 34, heading: 20, body: 14, caption: 10 },
    lineSpacingMultiple: 1.32
  },

  // Terracotta: warm field, brick titles, ochre numbers.
  clay: {
    name: 'clay',
    colors: {
      background: 'F8E7DF',
      surface: 'FFFBF8',
      foreground: '2C1D17',
      primary: '6B2D1F',
      accent: '985C17',
      muted: '7A5F52',
      border: 'EBD5C9'
    },
    sizes: { title: 34, heading: 20, body: 14, caption: 10 },
    lineSpacingMultiple: 1.32
  }
};

/**
 * A preset, resolved and ready for `templates.*` / `components.*`.
 *
 * `overrides` is shallow - `{ fonts: { heading: 'Microsoft YaHei', body: 'Microsoft YaHei' } }` is the
 * usual one, because a colour preset makes no claim about type and the engine's default faces are
 * Aptos (no CJK glyphs).
 */
function preset(name, overrides = {}) {
  const chosen = presets[name];
  if (!chosen) {
    throw new Error('unknown preset "' + name + '": use one of ' + Object.keys(presets).join(', '));
  }
  return resolveTheme(Object.assign({}, chosen, overrides));
}

module.exports = { presets, preset, presetNames: Object.keys(presets) };
