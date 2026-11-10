# Removing the HTML path — inventory and order of work

The product is the native generator (`cli.js`: a Deck Spec in, a native `.pptx` out). The HTML
converter is a second renderer with its own 890 KB of code, its own fixtures and its own gates. This
document is the measured inventory and the order in which the pieces can be removed *without losing
the checks that currently protect the engine*.

Nothing here is deleted yet. The rule is the one this repository already follows: the replacement
gate lands first, and only then does the code it protected come out.

## 1. What is actually HTML-path code

| file | size | role |
| --- | --- | --- |
| `pptx/html2pptx1.js` | 275 KB | the original converter: CSS → boxes, with a raster fallback for SVG artwork and gradient canvases |
| `pptx/batch_html2pptx.js` | 13 KB | its batch CLI (page ordering, concurrency, image materialisation) |
| `pptx/slide_order.js` | 0.9 KB | slot reservation shared with the pipeline's tests |
| `native/pipeline/analyzer.js` | 372 KB | DOM + CSS → Deck Spec (6,700 lines) |
| `native/pipeline/css.js` | 76 KB | the CSS subset parser |
| `native/pipeline/deck_builder.js` | 77 KB | spec → writer calls, container placement, pagination |
| `native/pipeline/html_parser.js`, `collide.js`, `cli.js`, `index.js` | 29 KB | the rest of the pipeline |
| `native/pipeline/README.md` | 64 KB | capability table for the analyser |
| **total** | **≈ 890 KB** | |

Independent side confirmed by grep: `engine/`, `core/`, `components/`, `themes/`, `templates/` import
**nothing** from `pipeline/`. The dependency only runs downward (pipeline → engine), so the cut is
clean at that boundary.

Also HTML-specific: `pptx/examples/pipeline-*.html` (21 fixtures), `native/pipeline-converted/`
(gitignored build output), `native/baselines/visual.json` (21 decks / 69 pages of HTML fixtures),
`native/baselines/text-fit.json`, `native/baselines/reports.json`.

## 2. Tests: what survives, what goes with the code

| file | tests | HTML-dependent | verdict |
| --- | --- | --- | --- |
| `native_engine.test.js` | 323 | **242** | keeps its 81 engine/schema/template/component tests; the 242 CSS-analysis tests die with the analyser |
| `native_spec.test.js` | 25 | 7 | tests `deck_builder` (`tablePayloadRows`, pagination, tfoot) — **deleted with the builder** |
| `native_picture_layout.test.js` | 39 | 3 | image-fit unit tests survive; 3 HTML cases become spec cases |
| `native_cell_lists.test.js` | 29 | 1 | survives; 1 case becomes a spec |
| `native_fill.test.js` | 23 | 4 | engine XML patches survive; 4 HTML cases become specs |
| `native_links.test.js` | 23 | 1 | survives; 1 case becomes a spec |
| `native_cli.test.js` | 7 | 0 | survives unchanged |

After the cut: **≈ 200 tests** over the engine, the schema, the components, the templates and the
CLI. The 242 that go are not coverage of the product — they are coverage of a parser being deleted.

## 3. Gates that currently ride on HTML fixtures

These must be re-pointed at native specs **before** the fixtures are removed, otherwise the engine
loses its safety net in the same commit that removes 890 KB.

| gate | today | needs |
| --- | --- | --- |
| `visual_golden.py` | builds 21 `pipeline-*.html`, fingerprints 69 pages | build from a corpus of **specs/demos**; baseline rewritten for the new corpus |
| `check_all_text_fit.py` | same fixture list, needs `--layout-out` from `pipeline/cli.js` | same corpus; the native CLI now writes `--layout-out` (added) |
| `stress:html` (40) / `gate:big` (120) / `gate:scale` (300) | `stress_html.js` generates HTML with CSS archetypes | a **spec generator** (`stress_spec.js`) that produces N pages from the engine's own API and checks bounds, overflow, overlap, OOXML integrity and the time budget |
| `verify:pptx` / `verify:readers` / `verify:wps` | iterate `pipeline-converted/*.pptx` | generic already — point `--dir` at the native corpus output |
| `audit:report` (`reports.json`, 9 declarations) | pipeline reports | replaced by the CLI's `--report` census (bounds/overflow/overlap + dropped pictures) |
| `limits` / `limits:update` | generated from **analyser call sites** (157 sites / 87 properties) | re-sourced: writer throws, `validateDeck`/`validateSlide` codes, `droppedPictures`, plus the hand-written "only PowerPoint can adjudicate" section |

`limits` is the subtle one: `LIMITS.md` is *generated* from `recordUnsupported(...)` calls inside
`analyzer.js`. In a native-only tree those call sites are gone, so the catalogue has to be
regenerated from the engine's own refusals, or the document becomes prose that nothing checks.

## 4. What the native tool still needs (found while doing this)

1. **A tracked image fixture.** `native-images-demo.js` and `native-stress-deck.js` read
   `native-image-assets/` and `native-stress-assets/`, both **gitignored** — they build here and
   would fail on a clean clone. The corpus needs either one small committed PNG, or a spec that
   writes its own PNG deterministically.
2. **A spec-level stress generator.** The CSS archetypes in `stress_html.js` (grid maps, crops,
   tiles) have no replacement. A native stress deck should randomise *content* (pages, KPI rows,
   tables, charts, nested containers) and assert the engine's invariants, not a browser's.
3. **`index.js` API surface.** It exports `convertHtml`/`convertFile` behind a lazy require; both go,
   together with the comment that explains the cycle they were avoiding.
4. **Docs to rewrite rather than patch**: `SKILL.md`'s "HTML compatibility workflow" (Stages 4–7),
   `README.md`, `native/README.md`'s "legacy" section, and `package.json`'s 14 `pipeline:*` /
   `stress:*` / `gate:*` / `audit:*` entries.

## 5. Order of work

1. **Corpus + gates** (no deletions): `golden/specs.json`, `scripts/corpus.py`, retarget
   `visual_golden.py` and `check_all_text_fit.py`, regenerate both baselines, add the image fixture.
2. **Native stress**: `scripts/stress_spec.js` at 40 / 120 / 300 pages with the invariant checks and
   a budget; wire `stress`, `gate:big`, `gate:scale` to it.
3. **Re-source `LIMITS.md`** from engine refusals; keep the "PowerPoint only" prose hand-written.
4. **Delete**: the two root scripts, `slide_order.js`, `pipeline/**`, the 21 fixtures, the pipeline
   scripts, the three HTML baselines, `pipeline-converted/`, and the pipeline's README.
5. **Test surgery**: delete `native_spec.test.js`; port the 9 HTML cases in the four surviving files
   to specs; delete the 242 analysis tests.
6. **Surface**: `index.js`, `package.json`, `SKILL.md`, both READMEs, `native/README.md`.
7. **Verify**: `npm test`, both retargeted visual gates, `stress_spec` at three sizes, readers/WPS on
   the native corpus, `cli.js --strict` on every spec, and one rendered deck looked at.
