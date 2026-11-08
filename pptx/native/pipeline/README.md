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
2. **No rasterization.** Text stays text (with rich-text runs), cards stay
   editable rounded rectangles plus their own text boxes, images stay native
   pictures with an editable crop rectangle, and tables stay native tables.
3. **Honest gaps.** Anything outside the supported subset is listed in
   `report.unsupportedDetails` with the element, the property and the reason.
   Nothing is silently dropped.
4. **Shared measurement.** Text heights come from the same estimator the Native
   writer uses, so the two paths agree.

## Supported CSS subset

| Area | Supported |
|---|---|
| Selectors | type, `.class`, `#id`, compound (`tag.class`), descendant and child combinators (both treated as descendant), `*` |
| Cascade | stylesheet order + specificity (ids, classes, tags), then inline `style=""`, plus `var(--token, fallback)` |
| Lengths | `px`, `pt`, `in`, `cm`, `mm`, `em`, `rem`, `%` (against the direct parent content box) |
| Box | `width`, `height`, `padding`, `margin`, `border`, `border-radius` |
| Layout | `position: absolute` with `left/top/right/bottom`, block flow, `display: flex` (row/column, `gap`, `flex`, `align-items`, `justify-content`), `display: grid` with equal tracks |
| Type | `font-family`, `font-size`, `font-weight`, `font-style`, `line-height`, `letter-spacing`, `text-align`, `color` |
| Surfaces | `background`/`background-color`, two-or-more-stop `linear-gradient`, single outer `box-shadow`, `opacity` |
| Media | `<img>` with `object-fit: cover/contain/fill` → native crop rectangle |
| Data | `<table>` → native table, `<ul>/<ol>` → bulleted native text box, `<hr>` → connector |

## Known limitations (by design, not oversights)

- **Not a browser.** There is no UA default stylesheet, no inline formatting
  context (text and `<span>` do not share a line box), no floats, no margin
  collapsing, no writing modes, no `flex-wrap`, no `order`, no `position: fixed`
  stacking contexts.
- **Cascade is simplified.** `@media`, pseudo-elements, attribute selectors,
  `:not()`, sibling combinators and `!important` are ignored. Custom properties
  are resolved globally rather than per-subtree.
- **Percentages** resolve against the direct parent's *content* box, which is the
  authored intent but differs from a browser when a parent's height is auto.
- **Text measurement is an estimate**, not OpenType shaping. Wrapping can differ
  from the browser, especially with mixed scripts and unusual tracking.
- **Unsupported visuals are reported, not approximated**: `filter`,
  `backdrop-filter`, `clip-path`, `mask`, `mix-blend-mode`, `text-shadow`,
  `background-size`/`position`, transforms, animations and transitions.
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
