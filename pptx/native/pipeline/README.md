# HTML → Native pipeline

Stage 2 of the Native migration: turning structured HTML slide markup into a
**Native Deck Spec**, so the primary content becomes editable PowerPoint objects
instead of a screenshot.

```
HTML  →  DOM Analyzer  →  Layout Analyzer  →  Style Mapper  →  Native Deck Spec  →  PPTX Engine
         html_parser.js   analyzer.js         deck_builder.js                    engine/native_pptx.js
```

```bash
cd pptx/native
node pipeline/cli.js ../examples/pipeline-reference.html \
  --out deck.json --pptx converted.pptx --report report.json
```

The CLI prints a mapping summary and, importantly, the CSS features it could
**not** translate.

## Design decisions

1. **Semantic output, not a coordinate dump.** Every node is classified
   (`title` / `heading` / `body` / `caption`, card, list, image, table) and keeps
   its role, so a converted deck can still be restyled by changing theme tokens.
   Subtrees with a container equivalent are emitted as native `container`
   elements — `direction`, `gap`, `padding`, `align`, `justify`, `columns` and
   per-child `boxMargin`/`flex`/`alignSelf` — so a converted row of cards stays a
   row of cards instead of eleven absolute boxes.
2. **Declarative output is proven, not assumed.** The analyzer and the engine are
   two implementations of the same layout rules, so every declarative group is
   re-resolved by the engine and compared with the analyzed boxes. Anything above
   `0.012in` is demoted to explicit coordinates for that subtree, and
   `report.json` records the container count, the fallback count, the reasons and
   the worst residual delta.
3. **No rasterization.** Text stays text (with rich-text runs), cards stay
   editable rounded rectangles plus their own text boxes, images stay native
   pictures with an editable crop rectangle, and tables stay native tables.
4. **Honest gaps.** Anything outside the supported subset is listed in
   `report.unsupportedDetails` with the element, the property and the reason.
   Nothing is silently dropped.
5. **Shared measurement.** Text heights come from the same estimator the Native
   writer uses, so the two paths agree.

## Supported CSS subset

| Area | Supported |
|---|---|
| Selectors | type, `.class`, `#id`, compound (`tag.class`), descendant and child combinators (both treated as descendant), `*` |
| Cascade | stylesheet order + specificity (ids, classes, tags), then inline `style=""`, plus `var(--token, fallback)` |
| Lengths | `px`, `pt`, `in`, `cm`, `mm`, `em`, `rem`, `%` (against the direct parent content box) |
| Box | `width`, `height`, `padding`, `margin`, `border`, `border-radius`, `box-sizing` (border-box by default, `content-box` honoured), `min`/`max-width`, `min-height` |
| Layout | `position: absolute` with `left/top/right/bottom` (resolved against the containing block's padding box), block flow, `display: flex` (row/column, `gap`, `flex`, `align-items`, `align-self`, `justify-content`, `order`), `display: grid` with fractional/fixed/percentage tracks (`repeat()`, `minmax()` max, `order` too) |
| Type | `font-family`, `font-size`, `font-weight`, `font-style`, `line-height`, `letter-spacing`, `text-align`, `color`, `text-transform` (`uppercase`/`lowercase`/`capitalize` applied before measuring) |
| Transforms | `transform: rotate(<deg|rad|grad|turn>)` on a text box, shape or picture → native shape rotation (clockwise, about the centre). A rotation combined with `scale`/`skew`/`translate` is reported rather than half-applied; a rotated *group* is reported because a native container cannot carry a rotation |
| Surfaces | `background`/`background-color`, two-or-more-stop `linear-gradient`, `background-image: url(...)` with `background-size` (`cover`/`contain`) and `background-position` → native picture with crop and focus, single outer `box-shadow`, `opacity` |
| Media | `<img>` with `object-fit: cover/contain/fill` and `object-position` → native crop rectangle with focus |
| Data | `<table>` → native table with real column widths (`<colgroup>/<col>`, then declared first-row cell widths, then equal columns) and merged cells (`colspan`/`rowspan`), `<ul>/<ol>` → bulleted native text box, `<hr>` → connector |
| Charts | Declared, never guessed: `<table data-chart="bar">` turns a data table into a native chart (first column = categories, each further column = a series named by the header row), and `data-chart` + `data-values="1,2,3"` + optional `data-labels` makes a single series. `bar`/`line`/`pie`/`doughnut`/`area`; `data-chart-title` and `data-chart-legend` are honoured; an unknown type or missing data is reported |
| Decorations | `::before`/`::after` with `content`, `position: absolute`, a definite `width`/`height` (or `left`+`right` / `top`+`bottom`) and a background fill, a border radius, or text → an overlay of the element's container, emitted as a real shape or text box above the flow children. CSS escapes in `content` are decoded (`"\2192"` → `→`). Anything without a definite box, a non-absolute decoration, or one on the slide root is reported instead of guessed |
| Stacking | `z-index` decides paint order among siblings; equal or missing values keep document order |
| Anchoring | An absolutely positioned *text* child of a container becomes an overlay (so the group stays declarative); `right`/`bottom`-only boxes hug their measured content and resolve against the container's padding box. A more complex absolute child demotes the group to absolute coordinates, which the report counts |
| Surfaces on text | An element that paints a fill/border/shadow *and* holds text becomes a container whose background is the surface, so badges and overlay captions keep their fill and their editable text |

## Known limitations (by design, not oversights)

- **Not a browser.** There is no UA default stylesheet, no inline formatting
  context (text and `<span>` do not share a line box), no floats, no margin
  collapsing, no writing modes, no `flex-wrap`, no `position: fixed`
  stacking contexts. `transform` supports rotation only: a rotated container
  keeps its children unrotated and is reported.
- **Cascade is simplified.** `@media` blocks are evaluated against the slide
  viewport (1280x720 by default): `min`/`max-width`, `min`/`max-height`,
  `orientation`, `screen` and `print` are supported, and a condition that cannot
  be evaluated is reported rather than applied. `::before`/`::after` are
  translated when they have a placeable box (see the Decorations row); other
  pseudo-classes and pseudo-elements, attribute selectors, `:not()`, sibling
  combinators and `!important` are ignored. Custom
  properties are resolved globally rather than per-subtree.
- **Percentages** resolve against the direct parent's *content* box, which is the
  authored intent but differs from a browser when a parent's height is auto.
- **Text measurement is an estimate**, not OpenType shaping. Wrapping can differ
  from the browser, especially with mixed scripts and unusual tracking.
- **Unsupported visuals are reported, not approximated**: `filter`,
  `backdrop-filter`, `clip-path`, `mask`, `mix-blend-mode`, `text-shadow`,
  transforms, animations and transitions.
- **`overflow: hidden` is reported, not faked.** Native shapes cannot clip their
  contents, so a slide that relies on clipping (a very common `main { overflow:
  hidden }`) is flagged instead of being claimed as supported. A property declared
  with its initial value (`overflow: visible`, `text-shadow: none`, …) is not
  reported, because it changes nothing.
- **`max-height` on a container is reported** (clamping needs clipping);
  `min-height` is honoured exactly.
- **Charts are declared, not inferred.** A bar chart drawn with divs stays
  divs; use `data-chart` on the data table or on a wrapper element. The output is
  a live chart part (editable data in PowerPoint), never a picture.
- **CSS background images** become real native pictures, so they keep an
  editable crop rectangle. Explicit pixel or percentage sizes other than
  `cover`/`contain`/`100% 100%` are approximated as `contain`.
- **No automatic fallback to images.** If a element cannot be expressed natively,
  it is reported so a human can translate that detail into a native shape or a
  targeted vector asset. Whole-slide rasterization is never produced.

## Review workflow

1. `node pipeline/cli.js reference.html --pptx converted.pptx --report report.json`
2. Read `report.json`; decide per unsupported entry whether it matters.
3. Render the converted deck for inspection. Without LibreOffice/PowerPoint use
   the offline previewer, which reads the real OOXML geometry, fills, gradients,
   tables and picture crops:

   ```bash
   python scripts/preview_deck.py converted.pptx --output-dir preview/converted --sheet preview/converted-sheet.png
   ```

   It is a layout preview, not a faithful Office render (no shaping, no
   shadows), so it catches dropped objects, wrong positions and overflowing
   text — not final typography.
4. Compare against the HTML render using the checklist in
   [`../parity/README.md`](../parity/README.md).
5. Only after human review, treat the result as a baseline.

## Roadmap

- Emit native `container` elements for clean flex/grid subtrees so converted
  cards stay declaratively reflowable instead of individually positioned.
- Accept a measured-layout JSON (from a real browser) to replace the internal
  flow solver for pages that depend on exact browser line breaking.
