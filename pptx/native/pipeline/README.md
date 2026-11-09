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
| Selectors | type, `.class`, `#id`, compound (`tag.class`), `*`, every combinator with its real meaning — descendant, child (`>`), adjacent (`+`) and general sibling (`~`), matched right to left with backtracking — attribute selectors (`[attr]`, `[attr=value]`, `[attr~=]`, `[attr\|=]`, `[attr^=]`, `[attr$=]`, `[attr*=]`, quoted or bare values, optional `i` flag), the structural pseudo-classes `:first-child`, `:last-child`, `:only-child`, `:nth-child()`, `:nth-last-child()`, `:first-of-type`, `:last-of-type`, `:only-of-type`, `:nth-of-type()`, `:nth-last-of-type()` (with `an+b`, `odd`, `even`), and `:not()`, `:is()`, `:where()` over simple selectors — arguments may contain attribute and structural selectors (`:not([data-kind="chart"])`), `:where()` adds no specificity, and a comma inside `:is()`/`:not()` does not end the rule |
| Cascade | stylesheet order + specificity (ids, classes, tags), then inline `style=""`, plus `var(--token, fallback)` |
| Lengths | `px`, `pt`, `in`, `cm`, `mm`, `em`, `rem`, `%` (against the direct parent content box) |
| Box | `width`, `height`, `padding`, `margin`, `border`, `border-radius`, `box-sizing` (border-box by default, `content-box` honoured), `min`/`max-width`, `min-height`. A single declared side (`border-top: 3px solid …`) becomes a thin filled shape on that edge — a real editable object — because a native outline is uniform; two or more differing sides are reported; a side may be given as longhands (`border-top-width`, `border-top-style`, `border-top-color`), which override the shorthand colour or width the way the cascade says  `aspect-ratio` (with an auto height the box is as tall as its used width divided by the ratio; a declared height wins, and stretch alignment still wins over the ratio, as in CSS) |
| Layout | `position: absolute` with `left/top/right/bottom` (resolved against the containing block's padding box), `position: fixed` (resolved against the slide, so a pinned footer is measured from the slide edge rather than from whatever container holds it), block flow, `position: relative` with `left/top/right/bottom` (the box moves and the flow keeps its slot: siblings do not shift and the parent does not grow; the offset travels in the spec as `relativeShift` so a container child is nudged once), `position: sticky` (a slide never scrolls, so it stays where the flow put it), `display: flex` (row/column, main-axis `flex-grow`/`flex-shrink` on **either** axis - a column hands its leftover height to the items that ask for it, so `flex: 1` fills the column - `justify-content` on a column as well as a row, `flex-wrap` on a column (breaks by height into columns, `align-content` spreads them - the counter axis of a column container), `gap` including the two-value form, `flex`/`flex-grow`/`flex-basis`/`flex-shrink` including the shorthand's basis and shrink, `align-items`, `align-self`, `justify-content`, `order`, and `flex-wrap: wrap` on a row — items break into lines by their declared width/`flex-basis`, each line is distributed and cross-aligned on its own; an overflowing single line shrinks its items in proportion to `shrink × base`; when the row pins a height, `align-content` (`start`/`center`/`end`/`space-between`/`space-around`/`stretch`) places the block of lines and hands the leftover to them - the same shared helper both sides call, so a centred tag cloud lands where the browser put it), `display: grid` with fractional/fixed/percentage tracks (`repeat()`, `minmax()` max, `order` too) plus `grid-column`/`grid-row` placement — spans (`span N`, `A / span N`) and explicit lines (`A / B`, the longhands `grid-column-start`/`grid-column-end`/`grid-row-start`/`grid-row-end`, negative lines counted back from the last one, and the four-value `grid-area` shorthand), resolved with the four CSS 8.5 phases so a definite row+column is pinned, a definite column hunts its row, a definite row takes the earliest free column, and only the rest auto-flow from the cursor (a named line or area needs `grid-template-areas` and is reported) — `grid-template-rows` (fixed, percentage, `auto`, `fr`) and `grid-auto-rows`  `float: left/right` (a run of consecutive floats is packed into a wrapping row: declared widths, lines as tall as their tallest item, and **both edges at once** - a run that mixes the two directions packs left floats from the left and right floats from the right until the cursors meet, which is what the browser does; `clear` is honoured because the next block always starts below the run). The shortening of the line boxes beside a float is translated when it is expressible: a run that stays on one line leaves a rectangle, and the plain text blocks after it whose measured height fits inside that rectangle are placed there as a two-column pair — the pair then occupies the full band, so everything after it starts below the float exactly as CSS does. The text must paint nothing (no background, border, padding or horizontal margin), because such a block spans the full width even while its lines are shortened; text that outgrows the band, a block that paints, or a run that wrapped are reported instead of approximated  A grid cell aligns its child the way the CSS says: `justify-items` on the container and `justify-self` on the item decide where the box sits on the inline axis, and a declared `width` wins over the default `stretch` (the item is then *measured* at that width, so its own text wraps against the box it actually has - stretching a fixed card to the whole track silently rewrote designed geometry).. Stretch alignment only sizes a box on an axis its own CSS left free: a child with a declared height keeps it (the spec carries `fixedHeight`/`fixedWidth` so the engine reaches the same answer) |
| Type | `font-family`, `font-size`, `font-weight`, `font-style`, `line-height`, `letter-spacing`, `text-align`, `color`, `text-transform` (`uppercase`/`lowercase`/`capitalize` applied before measuring), `text-indent` (first-line indent in `em`/`px`/`%`, written as `<a:pPr indent>`; a negative value is reported), `text-overflow: ellipsis` (a single line that cannot wrap, in a box that clips: the widest fitting prefix is kept and an ellipsis appended - the other combinations are reported), `white-space: nowrap` (written as `bodyPr wrap="none"` with autofit off, so a label never breaks and overflows instead of reflowing; the `pre*` values are reported because the DOM text walk has already collapsed whitespace), `writing-mode: vertical-rl` → `bodyPr vert="eaVert"` (upright CJK, columns run right to left) and `sideways-rl` → `vert`, `vertical-lr`/`sideways-lr` → `vert270` (columns left to right; `vertical-lr` over CJK is reported because upright glyphs have no left-to-right variant); the box height is the line length, so the fit test counts columns and a box that cannot hold them is reported |
| Lengths | `px`, `pt`, `pc`, `in`, `cm`, `mm`, `q`, `em`, `rem`, `ex`, `ch`, `%`, and the viewport units `vw`/`vh`/`vmin`/`vmax` against the 1280x720 slide; `calc()`, `min()`, `max()` and `clamp()` over any mix of them, including nested parentheses and unitless multipliers. `ch` resolves as the advance of a zero (~0.58em) and `ex` as the x-height (~0.52em), because half an em for both made a box measured in characters a sixth too narrow. A value the evaluator cannot resolve (`fit-content`, `env(...)`, an unknown unit) is reported as `length` rather than silently laid out at the layout default. |

| Shadows | `box-shadow` becomes a native `a:outerShdw` effect on the shape: offset, blur and colour travel, and the CSS offset is converted to DrawingML `dist`/`dir` (clockwise from +x, y down, so `0 10px` is 90 degrees). A second layer, `inset`, or a spread radius are reported, because a native outer shadow carries none of them. `text-shadow`, `outline`, `filter`, `border-image` and `background-blend-mode` are reported too. |

| Transforms | `transform: rotate(<deg|rad|grad|turn>)` on a text box, shape or picture → native shape rotation (clockwise, about the centre). A rotation combined with `scale`/`skew`/`translate` is reported rather than half-applied; a rotated *group* is reported because a native container cannot carry a rotation |
| Surfaces | `background`/`background-color`, two-or-more-stop `linear-gradient`, `background-image: url(...)` with `background-size` (`cover`/`contain`) and `background-position` → native picture with crop and focus, and a `linear-gradient` layer *above* that picture → a second native object, a gradient-filled shape whose per-stop alpha is the scrim (so text inside the box stays above it), single outer `box-shadow`, `opacity`. The direction of a `linear-gradient` is optional in CSS (`to bottom` when omitted), and `deg`/`rad`/`grad`/`turn` plus `to <side>`/`to <corner>` are all resolved to the DrawingML angle; `radial-`, `conic-` and `repeating-*` fills are reported, because PowerPoint fills are linear only - the box keeps its geometry and is left unpainted. |
| Media | `<img>` with `object-fit: cover/contain/fill` and `object-position` → native crop rectangle with focus |
| Visual baseline | `npm run golden:check` renders every fixture and compares a per-page fingerprint (a 64-bit luminance hash plus a 24x14 colour grid) with `native/baselines/visual.json`, so a gradient that flips, a shadow that loses its offset, a z-order that swaps or a colour that shifts fails the build. The baseline is a fingerprint rather than a picture: it says the page looked like this, not that it was drawn by these commands, and `npm run golden:update` is a decision taken after looking at the render |

| Clip path | `clip-path: polygon(...)` on a box with a declared height becomes a `custGeom` path whose vertices are the polygon corners: the shape itself is the clip, so it stays editable and its outline follows the cut. Percentages and lengths both resolve; anything else (`circle()`, `ellipse()`, `inset()`, `url()`) is reported, and so is a clipped box that has children, because only the box's own paint is clipped here |

| list-style | `none` switches the bullet off (verified); other markers draw the native round bullet and say so |

| background-repeat | `no-repeat` is the fitted-picture default and stays silent; `repeat`/`repeat-x` name that the picture is drawn once | Outer shadows with offset, blur and hex/rgba colour (rendered, verified). Layered values keep their first layer and name the rest; inset is refused whole. The hex bug: the tokeniser lacked A-F, so `#C05B3E` became stray lengths that blackened the shadow and reported it | `underline`/`line-through` are run properties (rendered and verified, including both on one run); `overline`, a decoration colour and a declared thickness are named - no native channel | `translate()`/`rotate()` compose as one plan (a later translate is turned with the rotation; percentages resolve against the box); `scale()`/`skew()` and a non-centre `transform-origin` are reported |
| white-space | `pre-line` is the behaviour (silent); `pre`/`pre-wrap` name that space runs collapse. `word-spacing: normal` is silent; a declared value names the per-character-only channel |
| table-layout | `fixed` is the implemented model (declared or equal columns; content wraps) and is silent; the browser`s `auto` content-stretching is not modelled - stated by the column-width rule |
| clip-path rounds | `circle(50%)` on a square and `ellipse(50% 50%)` anywhere are the inscribed shape and become the native ellipse preset; non-inscribed radii, `at` centres and `inset()`/`path()` stay reported |
| radial/conic/repeating | Refused per family with its own truth: no radial mode, no angular mode, one ramp instead of a repeating pattern; the box stays unpainted either way |
| font shorthand | Expands to the longhands (style/variant/weight, size, line-height, family - the family kept verbatim incl. comma stacks); unparsable forms stay whole and are named |
| ::marker colour | Read per `li`; one agreed colour becomes `a:buClr` in the patched `a:pPr`; items that disagree are named instead of silently picking one |
| caption-side | `bottom` drops the caption under the grid (grid keeps the node top, caption box at grid bottom minus its height); default top unchanged. Chrome-verified |
| text-transform full-width | ASCII printables map onto U+FF01-FF5E; uppercase/lowercase/capitalize unchanged |
| grid/flex parity | Chrome-measured allocation (1fr 2fr -> 396.7/793.3; flex-basis 30% -> 360/360) pinned in the suite |
| outline | Uniform ring becomes the shape line (colour + dash), no layout space; border wins when both are declared |
| logical properties | Aliased to physical sides at declaration time (one writing mode modelled); inset uses the box-shorthand expansion, ltr left-wins Chrome-verified |
| relative/sticky shift | Applied at every level incl. top-level containers and text; the flow hole stays at the static position; regression test reads a:off from the written file |
| semantic elements | Tables, figures, anchors, mark/sub/sup, nested lists and dl all translate natively; a file-level test pins hyperlink rels, a:highlight and the subscript baseline |
| transition/animation | Report names the journey: the end state is drawn, the movement between states is not |
| chart styling | Title/legend/colours land in ppt/charts/chartN.xml; file-level test locates the part by pattern |
| writing-mode | eaVert/vert/vert270 pinned by test; vertical-lr over CJK is the one named gap; render-verified in LibreOffice |
| visibility collapse | Hides like hidden outside the table layout (was silently drawn - fixed); the hole is kept |
| prefers-* media | Reports read a browser preference the render does not have; size queries keep the viewport reason |
| list pseudo content | A literal before/after string joins the item text; a counter() is reported once per list (was silent) |
| css counters | reset/increment/counter() implemented in the list branch (start and step honoured); counters() and non-list use stay reported |
| quote keywords | open/close-quote resolve against the inherited quotes pair (UA default otherwise) on inline pseudos; no- forms suppress; quotes itself is silent |
| nested counters | Per-name scope stacks; counters(name, sep) joins outermost-in; names are custom idents (h1 legal) |
| transform reports | Unsupported functions carry their arguments (scale(1.5)); translate/rotate/calc/attr verified silent-correct |
| list markers | disc/circle/square spell buChar, ordered forms spell buAutoNum; rare markers still named; builder no longer collapses the option to true |
| table cells + z-index | rowSpan/vMerge, gridSpan, anchor, zebra fills file-verified; z-index sorts paint order (pin test swaps z values) |
| corner radii | Mixed sets (incl. one longhand - undeclared corners are 0) report; uniform sets draw; repeat rules only for the shorthand |
| text-emphasis | Dot (or sesame) becomes a:emphasisMark on the run via the patch; other shapes and colour-only values stay reported; LibreOffice ignores the mark, so the test is file-level |

| line-height: normal | Read from the first face in the stack that exists (fontkit hhea metrics via the Windows font registry), verified against Chrome per face. A stack whose faces all miss keeps the 1.25 estimate - the reader`s generic fallback measured taller (1.45) than any static guess, so that residue stays named, not guessed |

| Paint order | Positioned boxes paint above the in-flow boxes around them, and an absolute text child that paints its own surface keeps that surface instead of becoming a bare-text overlay |

| Round or elliptical | `border-radius: 50%` becomes the ellipse geometry (a circle on a square box, the inscribed ellipse on any other); a smaller percentage is reported and drawn square |

| Long tables | A table taller than the page continues on further slides, one row never split across pages, with the `<thead>` rows repeated and the same left edge, width and top margin. `Paged:` on stdout names the split |

| Inline pseudo content | `::before`/`::after` that is not absolutely positioned joins its host line as a run: quoted strings and `attr()` are concatenated, the pseudo keeps its colour and size, and spaces collapse as in a browser. `counter()`/quote keywords and decorations on containers are reported |

| Space evenly | `justify-content: space-evenly` and `align-content: space-evenly` distribute `n+1` equal gaps, the two outer ones included, instead of falling back to `space-around` |

| Table caption | `<caption>` is drawn as its own text box above the table (that is where CSS puts it) and the table box starts below it. It keeps the caption type, alignment and padding, and the words stay editable. A merged first row is not used: with a `gridSpan` in row 0, LibreOffice lays the rest of the table off the page, so it could not be verified |

| Small caps | `font-variant: small-caps` becomes `cap="small"` on the runs of the block, patched into the part like columns. Inline spans are reported: one `cap` cannot cover part of a paragraph. `all-small-caps`/`petite-caps`/`unicase` have no native spelling |

| Columns | `columns: N` / `column-count` on a block of paragraphs becomes one text box with `numCol` and `spcCol` on its `bodyPr` - the native columned body, so the reader splits the text and editing reflows. The reserved height is the balanced one (`ceil(lines / N)` rows), and the column width is the declaration minus the gaps. Inline runs keep their formatting; a child that paints its own box is reported, because a background would be cut at the column edge |

| Shrink to fit | An absolutely positioned text box with no declared width hugs its content: the width is grown until the wrapper measures one line, instead of being a guess that left the last character wrapping |

| Text truncation | `text-overflow: ellipsis` on a single clipped line, and `-webkit-line-clamp: N` on wrapping text: the text is cut to N lines, the last one ends with an ellipsis, and the box reserves exactly N lines. A clamp needs its `-webkit-box` host and vertical orientation, and one written elsewhere is reported rather than applied. Baked clamp lines keep about 15% headroom so a substituted font cannot re-wrap one into a dangling character |

| Text fit audit | `npm run audit:text-fit` runs it over every fixture and compares the counts with `native/baselines/text-fit.json`, so a change that makes the estimate disagree with a renderer more often fails the build. `npm run check:text-fit` renders a deck with LibreOffice, reads the line rectangles back out of the PDF and compares them with the boxes the analyzer reserved: did every word get drawn, did any box need more lines than reserved, does the last line reach below its box. It is the only check that compares the estimate with a renderer instead of with ourselves |

| Speaker notes | A hidden `<aside class="notes">` (the reveal.js convention) or `data-notes` on the slide container becomes a native `ppt/notesSlides` part: the presenter text a browser hides, PowerPoint keeps |

| Inline text | `<sup>`/`<sub>` → run `baseline`, `<u>`/`<s>`/`text-decoration` → `u`/`strike`, a plain background on an inline element (like `<mark>`) → the native text highlighter (`<a:highlight>`), `<a href>` → a real run hyperlink, and `<code>`/`<kbd>` → a monospace run. The element defaults a browser applies with no CSS are modelled too: `b`/`strong`/`h1`-`h6` bold, `i`/`em`/`cite` italic, `mark` yellow, `small` 0.833em, `code`/`pre` monospace - without them semantic HTML came out as plain words |

| Data | `<table>` → native table with real column widths (`<colgroup>/<col>`, then declared first-row cell widths, then equal columns), merged cells (`colspan`/`rowspan` placed on a real grid first, so a span reserves its slots and the row emits only the cells that start in it, exactly the lopsided shape the writer turns into `gridSpan`/`rowSpan`; a span clipped by the last row is reported, and a slot the HTML leaves unused becomes an empty cell), per-cell fill/colour/weight/size/`text-align`, cell padding (the CSS `padding` becomes the PowerPoint cell margin in points), `vertical-align` on a cell, `letter-spacing`, and row heights measured from the real padding and line boxes (written as `rowH`, so the drawn table matches the reserved box), per-side borders (`border` and `border-top/right/bottom/left`, so a design with only row rules gets only row rules and nothing is invented), and a background painted on a `tr`, `thead`/`tbody`/`tfoot` or the `table` itself carried into the cells (cell paint wins, so `tbody tr:nth-child(even) { background: … }` produces real zebra rows), `<ul>/<ol>` → bulleted native text box, `<hr>` → connector |
| Charts | Declared, never guessed: `<table data-chart="bar">` turns a data table into a native chart (first column = categories, each further column = a series named by the header row), and `data-chart` + `data-values="1,2,3"` + optional `data-labels` makes a single series. `bar`/`line`/`pie`/`doughnut`/`area`; `data-chart-title` and `data-chart-legend` are honoured; an unknown type or missing data is reported  Styling is declared too, and each attribute names the one thing it sets: `data-chart-colors="#F2A24C,#4FB3A8"` (one colour per series, in order), `data-chart-legend="bottom|top|left|right|none|true|false"`, `data-chart-grid="true|false"`, `data-chart-axis-titles="category|value"`, `data-chart-labels="value|percent|series|none"` with `data-chart-label-position`, `data-chart-value-format="#,##0"`, `data-chart-grouping="clustered|stacked|percentStacked"`, `data-chart-dir="col|bar"` and `data-chart-text-color="#rrggbb"` for the title/axis/legend text (a chart often sits on a light panel inside a dark deck). A value that cannot be translated is reported, and the axis text uses the deck font rather than the library default |
| Decorations | `::before`/`::after` with `content`, `position: absolute`, a definite `width`/`height` (or `left`+`right` / `top`+`bottom`) and a background fill, a border radius, or text → an overlay of the element's container, emitted as a real shape or text box above the flow children. CSS escapes in `content` are decoded (`"\2192"` → `→`). Anything without a definite box, a non-absolute decoration, or one on the slide root is reported instead of guessed |
| Stacking | `z-index` decides paint order among siblings; equal or missing values keep document order |
| Anchoring | An absolutely positioned *text* child of a container becomes an overlay (so the group stays declarative); `right`/`bottom`-only boxes hug their measured content and resolve against the container's padding box. A more complex absolute child demotes the group to absolute coordinates, which the report counts |
| Surfaces on text | An element that paints a fill/border/shadow *and* holds text becomes a container whose background is the surface, so badges and overlay captions keep their fill and their editable text. That container is a column, where `align` means the *inline* axis, so the container’s own `align-items`/`justify-content` travel on the text box instead: `align-items: center` becomes `valign: middle` and `justify-content: center` becomes a centred paragraph - which is exactly the pill/button pattern |

## Box agreement

Every element carries a probe: the box the analyzer decided, keyed by node id. After
layout the deck is re-resolved through the engine and each probed box is compared, so a
container that disagrees falls back to absolute coordinates instead of quietly emitting
the engine’s answer.

A container child is probed too - on the surface the engine draws for it, because that is
the only element carrying the child’s own box. Without it the gate could only see the
parent’s frame, so "the parent is right but every child sits at the top" was invisible;
that is how a column ignoring `justify-content` survived several rounds of fixtures.

A height often arrives late: a row with `flex: 1` is sized by its parent *after* its own
children were laid out, so `align-items: stretch` can only fill it in a second, top-down
pass once every box is final. Without that pass the analyzer reported the content height
and the engine the stretched one, and the two disagreed by exactly the leftover.

The probe compares the box where the element must *end up*, which for a
`position: relative` node already includes its offset - the spec carries the static
position plus `relativeShift`, and the engine applies it there.

## Layout audit

The solver reports what it cannot lay out cleanly; it does not hide it. Every
conversion runs `auditLayout` over the analyzed tree and the CLI **fails** on a
finding (`--allow-layout-issues` opts out for a deliberate exception):

- **collision** — two boxes that are siblings in the same parent and are not
  absolutely positioned overlap by more than 0.02in² and more than 10% of the
  smaller box. Absolute positioning is a layer by definition, so layers are silent.
- **overflow** — a container's content reaches past its own box by more than
  0.01in, which means a height was measured too small.
- **beyond** — flow content runs past the slide edge (left/right/top/bottom), i.e.
  the page does not fit. `nowrap` text is exempt (overflowing is its meaning) and so
  are absolutely positioned layers that bleed off the canvas on purpose.

This exists because a wrong text measurement is invisible until something stacks:
the fixture that produced it looked fine in isolation and had a second card row
sitting on top of the stat cards.

## OOXML audit

`scripts/verify_native_ooxml.py` counts the editable features a deck should contain and
also checks every **enumerated attribute** the pipeline writes — text anchoring
(`t`/`ctr`/`b`/`just`/`dist`), `bodyPr vert`, paragraph alignment, and the chart enums
(`legendPos`, `barDir`, `grouping`, `dLblPos`). A value outside the schema set is not a
cosmetic slip: PowerPoint treats the file as damaged, and it is invisible in a rendered
screenshot. `valign: 'mid'` shipped `anchor="mid"` on every table and every middle-anchored
text box until this check existed, which is why the gate is unconditional.

`scripts/corrupt_anchor.py` exists to prove that gate is not vacuous: it rewrites a copy of
a deck with an invalid value, and the audit then refuses it. That experiment also answered a
question worth recording — **WPS Presentation opens the corrupted deck without complaint**,
same slide and shape count. A second renderer tolerating the defect is exactly why the audit
cannot be replaced by "it renders, therefore it is valid".

## Multi-page stress deck

`scripts/stress_html.js` generates a deck the way a person would: dozens of pages, seven
archetypes cycling (cover, card row, steps, grid, table + chart, column wrap, metrics),
seeded so a failure reproduces exactly. `npm run stress:html` builds 40 pages; the
twelve-page version runs in the test suite.

The point is what it asserts, because these are the properties a page-level fixture cannot
see: `unsupportedDetails` empty (the generated CSS stays inside the subset), no container
fallback, `maxBoxDelta` small, no empty slide, **nothing outside the slide box** (text is
held strictly; a decoration may hang over the edge, which is what a clipped shape means),
and a wall-clock budget. Forty pages convert in about 650 ms and open in the second reader
as 40 slides.

## Second reader

Microsoft PowerPoint is **not installed on the development machine** (Office is absent; the
`PowerPoint.Application` registration belongs to WPS). Compatibility evidence therefore comes
from two independent readers rather than from the one that matters:

- `scripts/verify_with_wps.ps1` opens a deck through the PowerPoint-compatible COM surface
  WPS exposes and reports slide count, per-slide shape count and text length, exiting
  non-zero if it cannot open the file or if a slide arrives empty. `-ExportDir` also renders
  each slide through WPS.
- `scripts/verify_all_with_wps.ps1` (`npm run verify:wps`) does that for every fixture.
- `scripts/compare_renderers.py` (`npm run compare:renderers`) compares LibreOffice's render
  with WPS's after **downscaling by 4**. Two renderers never match pixel for pixel — glyph
  hinting and anti-aliasing differ everywhere — so the same-renderer golden thresholds are
  the wrong test here; averaging a glyph down to a few pixels leaves placement, missing
  shapes and spacing as the dominant signal. On the fixture decks the two agree at mae
  0.006–0.016 and ssim 0.95–0.98, and the diff heatmaps show differences confined to glyph
  edges and box borders rather than to position.

What this still does not prove is that Microsoft PowerPoint opens these decks. The counts and
the cross-renderer agreement catch a whole class of damage, but the last mile needs a machine
with Office installed.

## Known limitations (by design, not oversights)

- **`margin: auto` needs a declared width.** Two auto sides centre the box in the free
  space, one auto side pushes it to the opposite edge - in block flow and, via
  `align-self`, in a flex column. A box that hugs its text has no free space to
  distribute, so that case is reported.
- **Tracking counts towards the advance.** `letter-spacing` is added per character when
  measuring, so a tracked label fits the box the analyzer reserves for it; before this,
  those labels measured a few percent narrow and wrapped in the renderer.
- **Index-aligned XML patches follow the laid-out slide.** Three things PptxGenJS cannot
  express - gradient fills, `text-indent` and East Asian font faces - are written by
  rewriting `slideN.xml` after the file is produced. That rewrite walks the shapes in
  serialization order, so it uses the *laid out* element list: a container contributes a
  background shape, one strip per single-side border and its overlays on top of what the
  spec lists. Aligning against the spec instead under-counted by exactly those shapes, and
  a deck that combined a gradient with such a container aborted the build.
- **Not a browser.** There is no UA default stylesheet, no inline formatting
  context (text and `<span>` do not share a line box), no floats, no margin
  collapsing, no `z-index` stacking contexts. `position: sticky` is treated as static:
  nothing scrolls a slide, so the sticky offsets never apply and the layout is the static
  one. All four writing modes are translated - `vertical-rl`/`sideways-rl` to `eaVert`/`vert`
  and `vertical-lr`/`sideways-lr` to `vert270` - except `vertical-lr` over CJK text, which
  wants upright glyphs and has no left-to-right counterpart in DrawingML. `position: fixed` is anchored to the slide - which
  is what a slide deck means, since the viewport is the slide - so it does not
  scroll or repeat per fragment. `transform` supports rotation only: a rotated
  container keeps its children unrotated and is reported.
- **Cascade is simplified.** `@media` blocks are evaluated against the slide
  viewport (1280x720 by default): `min`/`max-width`, `min`/`max-height`,
  `orientation`, `screen` and `print` are supported, and a condition that cannot
  be evaluated is reported rather than applied. `::before`/`::after` are
  translated when they have a placeable box (see the Decorations row); the
  structural pseudo-classes listed above are matched against element siblings,
  counting only elements (so an interleaved `<br>` does not shift the index).
  `:not()`, `:is()` and `:where()` are evaluated when every argument is a simple
  selector we can match; an argument that is not (`.card:not(:hover)`) makes the
  whole rule reported instead of silently matching too much. Attribute selectors
  support `[attr]`, `=`, `~=`, `|=`, `^=`, `$=`, `*=` and the `i` flag; an operator
  we cannot evaluate (`[data-x!=y]`) leaves the rule reported rather than matching
  every element with the class. Other pseudo-classes and pseudo-elements are
  ignored, and a rule whose selector is ignored is listed in the report. A
  selector that names no element at all (`:root { --x: ... }`) is not listed,
  because its declarations are only custom properties. Custom properties are
  resolved globally rather than per-subtree.
- **Percentages** resolve against the direct parent's *content* box, which is the
  authored intent but differs from a browser when a parent's height is auto.
- **Flex sizing is a single pass, with no min-content floor.** Bases come from
  `width`/`flex-basis` (0 when neither is declared, which is what `flex: 1`
  means), free space goes to the growing items, and an overflowing row shrinks
  its items in proportion to `flex-shrink × base`. Text measurement is an
  estimate, so nothing is clamped to a min-content width: a row where every item
  is `flex-shrink: 0` still overflows, exactly as authored.
- **Grid placement is row-major auto-flow.** `grid-column`/`grid-row` spans
  (`span N`, `A / span N`, `A / B`) are honoured, but an explicit line number
  (`grid-column: 2`) is reported: the item is still auto-placed and the report
  says so. Named areas and `grid-auto-flow: column` are not modelled. Rows obey
  `grid-template-rows`: a fixed length pins the row, `auto` fits its items, and
  `fr` divides the leftover height of a container that declares one (without a
  declared height, `fr` rows behave as `auto`, exactly like CSS). `grid-auto-rows`
  sizes the implicit rows. Otherwise rows are sized by their single-row items, an
  item spanning several rows grows only the flexible rows it covers, and an item
  that declares its own `height` keeps it instead of stretching.
- **Text height is the CSS line box**: `lines x fontSize x lineHeight`, with nothing added,
  which is why a stack of paragraphs does not drift down the page. Wrapping, on the other
  hand, is deliberately conservative: the usable width is 10% narrower than the box (plus
  0.08in) because PowerPoint measures glyphs a little differently, so a long line breaks a
  touch early instead of running over its neighbour. There is no OpenType shaping, so
  mixed scripts and unusual tracking can still differ from the browser. The wrap is greedy
  and breaks an over-long token at grapheme level, which is what `word-break: break-all`/
  `break-word` ask for and what PowerPoint itself does - so those values are translated,
  while `keep-all` (which forbids that break) is reported. `overflow-wrap` is not read at
  all, so it is reported rather than claimed.
  from the browser, especially with mixed scripts and unusual tracking. It is greedy
  and breaks an over-long token at grapheme level, which is what
  `word-break: break-all`/`break-word` ask for and what PowerPoint's own renderer
  does - so those values are translated, while `keep-all` (which forbids that break)
  is reported. `overflow-wrap` is not read at all, so it is reported rather than
  claimed.
- **`flex-wrap: wrap` breaks on the declared basis.** An item with no width and no
  `flex-basis` (a bare `flex: 1`) contributes zero to the break decision, because
  its max-content width is not measured for a container - so such items stay on one
  line instead of wrapping. Declared widths, `flex-basis` and the `flex` shorthand's
  basis value are what drive lines, which is how tag rows and stat strips are
  written. The same rule turns for a wrapping *column*: items stack until the
  container’s height runs out (so a definite height and a declared width per item
  are required and are reported when missing), then a new column opens beside it,
  `column-gap` apart, and `align-content` spreads those columns.
- **A padded box is as tall as it renders.** Vertical padding and border belong to
  the box height (and to the text box's insets inside a card), so a wrapped line
  starts below the card instead of on top of it.
- **One border side is a shape, several are a report.** A single side becomes a thin
  strip; `border-top` + `border-bottom` at different widths cannot be one native
  outline, so it is reported instead of half-applied. There is no clipping: a native
  shape cannot cut off its children, so `overflow: hidden` is translated into
  "the content is clipped here" **only when the content really is larger than the
  box** - with content that fits, the declaration changes no pixel and is silent.
  A bleeding decoration is therefore drawn past the slide edge instead of cut off.
- **`text-indent` is a paragraph property, not a layout shift.** The box keeps its
  position and the indent is written to `<a:pPr indent="…">`, which is what
  PowerPoint's own "first line" paragraph setting edits. The measured height
  already accounts for the narrower first line, so a deck does not clip. A
  negative indent (hanging indent, which needs matching box insets) is reported
  rather than half-applied.
- **`white-space: nowrap` overflows, it does not shrink.** That is what the CSS
  keyword means, but it also means a nowrap label wider than its box spills out -
  by design, since `overflow` is not translated either. Autofit is switched off for
  those boxes: leaving `normAutofit` on makes PowerPoint and LibreOffice shrink the
  text box and then re-wrap the text, which defeats the keyword entirely.
- **Three ways a text-heavy page loses pixels are reported, not swallowed.** A painted
  inline box (`<span>` with a background inside a sentence) keeps its words and drops the
  paint; text that sits directly in a block next to element children never shares their
  line box, so it is not translated at all; and a `border-radius` with four different
  corners keeps only the first, because a native rounded rectangle carries one.
- **An absolutely positioned child of a leaf is emitted beside it.** A caption pinned
  inside a card that is not a container used to vanish; it is now an ordinary text
  object at the leaf's corner plus its own offsets.
- **An ellipsis changes the text.** `text-overflow: ellipsis` is the one place where the
  pipeline rewrites content: the cut point is computed from the measured width, which is an
  estimate (glyph factors, or a real font metric when a font manager is available), so it
  can land a character either side of what a browser would choose. That is why it only
  happens when the CSS explicitly asks for it, why the box has to be single-line and
  clipping, and why the untouched line keeps its original string. Rich runs on a truncated
  line are flattened, because the runs no longer describe the string.
- **`opacity` fades a leaf, and is reported on a subtree.** A shape or a text box gets
  its paint faded (two alphas multiply, they do not replace each other); a box with
  children reports the gap, because CSS fades the whole subtree and a PowerPoint shape
  can only fade its own fill.
- **`!important` marks the declaration, it is not part of the value.** It is stripped
  before the value is read (so `width: 600px !important` is 600px) and recorded on the
  declaration, and it really outranks a normal declaration: a later normal rule cannot
  take the property back, an important one still beats an inline `style` property, and
  between two important declarations the usual specificity and order decide.
- **`font-size` is resolved once.** A relative size (`120%`, `1.2em`) used to be applied
  twice, once when the box was sized and again when its text was measured, so every
  relative size came out about 20% too large.
- **The report counts elements, not measurement calls.** A box can be measured more than
  once (shrink-to-fit, a container probe), so the same declaration is only reported once.
- **A list is paragraphs, not one string.** Each item is its own paragraph with its own
  bullet, and a nested `<ul>`/`<ol>` is `indentLevel`, so the second level is a real
  second-level bullet rather than more words on the parent line. The bullet has to sit
  on the run that starts the paragraph - the writer takes a paragraph's properties from
  the run it ends on, so a bullet on the first run alone lost the first item.
- **`line-height` is a multiple of the font size, so it is written in points.** DrawingML
  also has a percentage form (`spcPct`), but that is a percentage of the font's own line
  box, which is about 1.2em: `line-height: 2` came out ~20% taller than the analyzer
  reserved and the last line spilled out of its box. `spcPts` carries the CSS number.
- **A merged cell is a grid, not a run of cells.** `colspan`/`rowspan` are placed on the
  real grid before anything is emitted: a span reserves the slots it covers, the next
  row skips them, and the covered cells are not emitted at all - the writer inserts the
  merge placeholders from the two numbers. Emitting the covered cells as well is what
  used to add a column per span and shear the whole table one cell to the right.
- **A shape border is uniform.** The `border` shorthand is expanded into
  `border-top/right/bottom/left` so the cascade behaves (a later `border` really
  clears an earlier `border-bottom`), but a native outline has one width and one
  colour: a design that borders only some sides of a *non-table* element is
  reported with the sides it declared. Table cells are the exception - they carry
  four independent lines and are translated per side.
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
