# The HTML path is gone — what it was, and what replaced it

The product is the native generator: a Deck Spec in, a native `.pptx` out. The HTML converter was a
second renderer with its own code, fixtures and gates; it is now removed from this branch.

The rule followed here is the one this repository already uses: **the replacement gate lands first,
and only then does the code it protected come out.** That order is what made the cut safe, and it is
also why the test count dropped by more than half — see the last section.

## What was deleted

| file | size | role |
| --- | --- | --- |
| `pptx/html2pptx1.js` | 275 KB | the original converter: CSS → boxes, with a raster fallback for SVG artwork and gradient canvases |
| `pptx/batch_html2pptx.js` | 13 KB | its batch CLI (page ordering, concurrency, image materialisation) |
| `pptx/slide_order.js` | 0.9 KB | the slot reservation its batch tests used |
| `native/pipeline/analyzer.js` | 372 KB | DOM + CSS → Deck Spec (6,700 lines) |
| `native/pipeline/css.js` | 76 KB | the CSS subset parser |
| `native/pipeline/deck_builder.js` | 77 KB | spec → writer calls, container placement, pagination |
| `native/pipeline/{cli,index,collide,html_parser}.js` | 28 KB | the converter's front door, its page-fit audit and its HTML parser |
| `native/pipeline/README.md` | 64 KB | the supported CSS subset and every property it refused |
| `examples/pipeline-*.html` (21 files) | — | the fixtures the analyser was tested against |
| `scripts/{convert_examples,stress_html,scale_gate,audit_report_baseline,promote_goldens,limits_report}.js` | — | the scripts that only existed to drive the above (`limits_report.js` was rewritten, not dropped) |
| `pptx/scripts/extract_html_{design_tokens,style}.py` | — | theme extraction from an HTML file |
| `native/baselines/reports.json` | — | the converter's per-property report baseline (nothing read it after the cut; the file itself was deleted during the 2026 housekeeping pass) |
| `tests/native_spec.test.js`, `tests/native_cell_lists.test.js`, `tests/native_picture_layout.test.js` | 25 + 29 + 39 tests | the builder's, the analyser's cell lists and its picture/layout fixtures |

`index.js` no longer exports `convertHtml` / `convertFile`, and the lazy `require('./pipeline')` that
backed them is gone. Nothing in `engine/`, `core/`, `components/`, `themes/` or `templates/` ever
imported the pipeline, so the cut left no seam — that was verified by grep before deleting, not after.

## What replaced each gate

| gate | before | after |
| --- | --- | --- |
| visual golden | 21 HTML fixtures converted by `pipeline/cli.js`, 69 pages | `golden/specs.json`: 10 native decks, 65 pages, built by `cli.js` or by the demo script itself |
| text fit | same fixtures, 677 boxes | same corpus, 466 boxes, 0 needing an extra line, 0 lost words |
| stress | HTML archetypes converted (40 / 120 / 300 pages) | `scripts/stress_spec.js`: N pages straight from the engine API, 0.7 s / 1.7 s / 4.0 s of a 180 s budget, zero warnings at 40 / 120 / 300 pages and seeds 1/3/7/13/21/99 |
| OOXML integrity | the converted stress deck | the same check on `stress40/120/300.pptx`: 0 integrity problems |
| limits catalogue | generated from 157 `recordUnsupported` call sites in the analyser | generated from 66 `throw` sites in the engine/core/CLI plus the 110 conditions in `validateDeck` |
| readers / WPS | `pipeline-converted/` | the decks this repository builds, by directory |

Two things had to exist before the converter could go, and both landed in the commit before this one:
`cli.js --layout-out` (the writer reporting the boxes it really used, which the text-fit gate needs
when it cannot parse CSS any more) and `scripts/corpus.py` (one description of the deck corpus that
both visual gates read).

## What the gates found on the way out

- `components.kpiCard` reserved a fixed 0.24 in for its note and a fixed 0.25 in for its label. A
  three-line note and a two-line label in a five-card row were both clipped; neither appears in any
  fixture, and the first stress deck to write longer labels than the fixtures found both within a
  minute. All three text boxes in the card are measured now.
- Nothing else. With 300 pages of generated content, six seeds, 262 measured text boxes and 35
  photographed pages, the engine needed no other change — which is the point of building the gate
  first.

## The honest cost

`npm test` went from 469 tests to 121. Of the 348 that went, almost all were the analyser's tests:
they asserted what CSS became, not what the product does. The 121 that remain are the engine's
(text measurement, layout, schema, OOXML patches, the CLI, the corpus and the catalogue), and every
one of them runs on a Deck Spec. Nine cases that had been written against the converter were ported
rather than dropped: three chart-deck cases, one three-series chart, two table-cell typography
cases, two hyperlink cases and the list-cell helper — each rewritten as the spec the converter used
to produce, with its assertions kept.
