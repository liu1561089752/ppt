# ppt

## Native PowerPoint engine

A first native PowerPoint generation engine is available in `pptx/native/`. It creates editable PowerPoint text boxes, shapes, lines, images, and tables directly with PptxGenJS. The original HTML-to-PPTX pipeline remains available for backward compatibility.

Quick start:

```bash
cd pptx/native
npm install
npm run demo
npm test
```

The example writes `native-demo.pptx` in the current directory. See [the native generation guide](pptx/SKILL.md#native-powerpoint-generation-new-engine) for the Deck Spec, API, limitations, and migration status.

**Status:** initial migration slice / opt-in preview. The CJK text measurement is conservative estimation, not exact font shaping. Always render and inspect output in the target PowerPoint environment before delivery.


Native mode now also includes configurable font-file metrics (via fontkit), CJK-aware explicit wrapping, estimated text-overflow warnings, and starter component/template factories. See the typography and component sections in `pptx/SKILL.md`. Font metrics require actual font files to be configured; otherwise the conservative fallback estimator is used.

Native output now sets East Asian font properties in OOXML, supports editable PowerPoint charts, and includes process-flow, timeline, comparison, and KPI templates. CI uses LibreOffice plus Poppler to render both demo decks and upload PPTX/PDF/PNG previews as artifacts.

### Layout, images, and editability

Declarative `container` elements provide real layout instead of a single cursor flow: `row` / `column` directions, `gap`, `padding`, `align`, `justify`, equal-width `columns` grids, nested containers, and content-sized heights. A container can paint its own card `background`, emitted as a normal editable shape behind its children.

Images support `fit: 'cover' | 'contain' | 'crop' | 'stretch'`, focal points, `zoom`, opacity, rounded corners, outlines and shadows. The engine computes the geometry itself and patches `<a:srcRect>` / `<a:prstGeom>` / `<a:ln>` / `<a:effectLst>`, because the PptxGenJS 3.12 `sizing` API cannot express `contain` without emitting invalid negative crop rectangles. Every mode keeps an editable picture frame — no slide is ever rasterized into a background image.

```bash
cd pptx/native
npm run demo:images     # cover / contain / stretch / focus / zoom / rounded / shadow
npm run demo:stress     # twelve designed pages exercising the whole engine
npm run audit:stress    # per-slide editability audit, fails on warnings
```

`node scripts/audit_deck.js <deck.pptx>` is the machine check for "content is still editable": it reports editable text shapes, characters, pictures, charts and tables per slide and flags `TEXT_AS_IMAGE`, `NO_EDITABLE_TEXT` and `POSSIBLE_FULL_SLIDE_RASTER`.

### HTML → Native pipeline

`pptx/native/pipeline/` implements the staged migration: **HTML → DOM Analyzer → Layout Analyzer → Style Mapper → Native Deck Spec → PPTX**. Text keeps semantic roles, cards stay editable surfaces plus their own text boxes, `<table>` becomes a native table, `<ul>` becomes bulleted native text, and images keep an editable crop rectangle.

```bash
cd pptx/native
node pipeline/cli.js ../examples/pipeline-reference.html \
  --out converted/deck.json --report converted/report.json --pptx converted/deck.pptx
```

Both paths can be inspected without LibreOffice: `python scripts/preview_deck.py <deck.pptx> --sheet preview/sheet.png` renders the real OOXML geometry, fills, gradients, tables, picture crops and text wrapping to PNG with Pillow. It is a layout preview, not a faithful Office render.

The pipeline reports every CSS feature it could not translate instead of dropping it silently. See `pptx/native/pipeline/README.md` for the supported subset and the explicit limitations — it is a deliberate subset translator, not a browser engine.

Batch conversion is available through `node pptx/batch_native_pptx.js --input-dir <deck-spec-directory> --output-dir <output-directory>`. Each JSON Deck Spec is rendered to a separate editable PPTX; see `pptx/SKILL.md` for options.
Reference PPTX analysis for Native mode is available with `python pptx/scripts/extract_native_design.py reference.pptx extracted-design/`; it samples all slides and exports design tokens, layout geometry, repeated component signatures, and font usage.
The legacy HTML batch converter also now preserves source slide order under concurrent rendering by assigning each job a pre-created slide slot.

## Visual design continuity

Native mode is not intended to downgrade or simplify the design language of the HTML workflow. A shared design-token resolver now supports palette, typography, spacing, radii, layout rhythm, and effect preferences across Native templates and text/card components.

For an HTML or CSS reference, extract a first-pass Native theme:

```bash
python pptx/scripts/extract_html_design_tokens.py reference.html extracted-design/
# or pass a standalone .css file
```

Review `theme.json` and `design-tokens.json`, then apply the theme to the Deck Spec's `theme` field. The original CSS is retained as `source.css` for design review. Extraction is best-effort: complex selectors, gradients, filters, animations, and browser-specific layout still need deliberate translation into native PowerPoint elements or vector assets. Do not replace distinctive layouts with generic templates merely because the renderer changed.

Visual regression tooling and golden baseline guidance are documented in `pptx/native/golden/README.md`.

## HTML / Native visual parity fixtures

A paired reference now lives at `pptx/examples/design-reference.html` and `pptx/examples/native_design_parity_demo.js`. CI extracts the HTML's embedded CSS, applies the resulting theme to an editable Native slide, and renders the result. The review checklist and baseline acceptance policy are in `pptx/native/parity/README.md`. This fixture checks a representative composition and shared design tokens; it is not a claim of automatic pixel-perfect conversion for arbitrary CSS.
