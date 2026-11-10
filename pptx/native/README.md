# Native PowerPoint engine — the deck tool

A Deck Spec goes in, a native `.pptx` comes out. Nothing on this path parses HTML, nothing
rasterises a page, and no browser is involved: every word becomes a text run, every panel a shape,
every table a table, every chart a chart whose data lives in the workbook embedded beside it.

```
Deck Spec (JSON or JS)  →  validation  →  layout (measured in inches)  →  OOXML writer + patches  →  .pptx
```

## 60 seconds

```bash
cd pptx/native

node cli.js ../examples/native-cover.spec.json cover.pptx --report cover.json   # JSON spec
node cli.js ../examples/native_deck_spec.js deck.pptx --report deck.json        # JS spec, templates
node cli.js ../examples/native_deck_spec.js --check                             # validate only
```

The tool prints what it wrote:

```
spec      ..\examples\native_deck_spec.js
slides    6
page      13.333 x 7.5 in
objects   chart 1 · line 10 · shape 19 · table 1 · text 52
metrics   fontkit: real face metrics
fonts     Microsoft YaHei · no face files: wrap is estimated
warnings  none
wrote     deck.pptx (184 KB)
```

Layout warnings (a box outside the canvas, a text box whose measured text does not fit, two text
boxes overlapping) print on stderr and do not stop the write; `--strict` makes them fatal. Exit
codes: `0` written, `1` the spec was rejected (nothing is written — a partial deck is worse than
none, because the file looks finished), `2` the writer failed.

## Options

| option | what it does |
| --- | --- |
| `<spec>` | `.json`, or `.js`/`.cjs` exporting a deck (or a function returning one, or `{ deck }`) |
| `[out.pptx]` / `--out <file>` | where to write; defaults beside the spec |
| `--report <file>` | census, warnings, font situation, dropped pictures, as JSON |
| `--check` | validate and stop; writes nothing |
| `--strict` | layout warnings become failures |
| `--json` | one JSON object for another program |
| `--quiet` | errors only |

## The spec

```json
{
  "title": "deck title",
  "pageSize": "wide",
  "theme": { "colors": { "primary": "183B3A", "accent": "D36B45" },
             "fonts": { "heading": "Microsoft YaHei", "body": "Microsoft YaHei" },
             "sizes": { "title": 34, "heading": 20, "body": 14, "caption": 10 } },
  "slides": [
    { "background": "FFFFFF",
      "notes": "speaker notes go to the notes part",
      "elements": [
        { "type": "text", "text": "…", "x": 0.9, "y": 0.7, "w": 11, "h": 0.6, "fontSize": 28, "bold": true },
        { "type": "shape", "x": 0.9, "y": 1.5, "w": 11.4, "h": 0.02, "fill": "DCE2DE", "line": false }
      ] }
  ]
}
```

Positions and sizes are **inches**; colours are hex without `#`; fonts are family names. The full
field list lives in `core/schema.js` (`validateDeck` is the authority, and the CLI runs it before
touching the disk).

| element | written as | notable fields |
| --- | --- | --- |
| `text` | text box with runs | `fontSize` (pt), `bold`, `italic`, `color`, `align`, `valign`, `lineSpacing`, `charSpacing`, `paragraphs`, `text` as a run array for mixed styling |
| `shape` | `p:sp` | `fill`, `gradient`, `lineColor`, `lineWidth`, `radius`, `shadow`, `rotate`, `transparency` |
| `line` | connector | `color`, `width`, `dash`, `endArrowType` |
| `image` | `p:pic` | `path`/`src`, `fit` (`cover`, `contain`, `crop`, `fill`, `none`), `crop`, `focus`, `alt` |
| `table` | `a:tbl` | `rows` (strings or `{text, options}`), `colW`, `rowH`, cell `rowspan`/`colspan`, `fill`, `border` |
| `chart` | `c:chart` + embedded `.xlsx` | `chartType` (`bar`, `line`, `pie`, `doughnut`, `area`, `scatter`, `bubble`, `radar`), `data`, `options` |
| `container` | declarative grouping | `layout` (`flow`, `grid`, `flex`), children with `gridColumnStart`/`span` |

Two authoring styles, same output:

* **JSON** — the portable contract. A spec that needs no code is one a human can review in a diff.
* **JS** — `templates.*` describes a whole page from content fields (`hero`, `content`, `kpi`,
  `comparison`, `process`, `editorial`), `components.*` gives the pieces (`title`, `paragraph`,
  `divider`, `kpiCard`, `infoCard`, `processFlow`, `timeline`). Use it when a deck is generated from
  data, or when you want the design system to own the geometry.

`../examples/native_deck_spec.js` is the worked example: six pages, four templates, a native chart,
a table, speaker notes.

## Themes

`themes/default.js` is the baseline (`editorial-light`); `themes/design_system.js` merges a partial
theme over it, so a spec only states what differs. To start from a file that already looks right:

```bash
python ../scripts/extract_native_design.py reference.pptx design/    # tokens + fonts + colours
```

## What "native" is checked against

The claim is not that the deck looks right — it is that the deck *is* objects. Four gates:

```bash
node ../scripts/audit_deck.js deck.pptx --min-text-shapes 0   # per-slide object census, no page raster
python ../scripts/render_check.py deck.pptx --output-dir render/   # LibreOffice → PDF → PNG, look at it
python ../scripts/check_text_fit.py deck.pptx                 # measured text vs the boxes it got
node ../cli.js deck.spec.json --strict                        # bounds / overflow / overlap
```

`audit_deck.js` reports one line per slide (text shapes, characters, pictures with crop and
coverage, charts, tables). A page degraded to a screenshot shows up there as `picCoverage=1.00` and
zero text shapes; for the 21 fixture decks in `pipeline-converted/` that number is 0 everywhere.

## What the writer cannot do

`LIMITS.md` is generated from the call sites that report a gap: ~157 sites, 87 CSS/OOXML
properties, each with the reason. Two kinds live there:

* **Named** — the engine reports the property and draws the closest honest thing (`borderCollapse`,
  `mixBlendMode`, a `<sup>` that shrinks the glyph but not the line box).
* **Only PowerPoint can adjudicate** — `a:tile` fills, `a:spcPct` line spacing, whether a file
  triggers a repair prompt: LibreOffice and WPS are what this machine can see, and they differ.

## The HTML converter is legacy

`native/pipeline/` (HTML → Deck Spec) and `pptx/batch_html2pptx.js` still exist, because decks that
were authored as HTML need a way across. They are not the product: the converter reconstructs boxes
from CSS and keeps a raster fallback for SVG artwork and gradient canvases. For new work, write a
spec — see `SKILL.md`'s renderer-selection rule.
