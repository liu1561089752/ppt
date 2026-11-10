# What this engine will not draw

The engine's contract is narrow and it is the whole point: **silence means the deck agrees with
the browser.** A difference the drawing cannot express is named in the report, in the slide it
happens on, with a reason a designer can act on. This file is the full list of those reasons -
generated from the source, so it cannot drift away from the code.

## How to read a report entry

`npm run pipeline -- deck.html` prints them, and each deck carries a `report` object:

```json
{ "slide": 3, "tag": "div", "property": "float", "value": "left",
  "reason": "A float escapes the flow ..." }
```

## The catalogue

<!-- generated:start -->

Generated from `pipeline/analyzer.js`: **126 call sites**, **75 properties**,
**115 distinct explanations**. Regenerate with `npm run limits:update`; a new report
without a line here fails the gate.

| reported as | what the deck says it could not do |
| --- | --- |
| `::before` | Generated content beyond a literal string or attr() (counters, quotes) has no value this walker can compute |
| `::marker` | The items want different marker colours; a text box carries one bullet colour, so none was applied |
| `'::' + pseudo` | A decoration on the slide root has no container to anchor to; put it on a card or panel<br>Generated content beyond a literal string or attr() (counters, quotes) has no value this walker can compute<br>⟨reason⟩ |
| `animation` | The slide draws the final state; the entrance or motion itself is not drawn |
| `backgroundImage` | Only one picture layer and one linear gradient above it can be painted: ⟨what⟩ is dropped<br>Only one picture layer behind the text can be painted: ⟨what⟩ is dropped<br>⟨unsupportedGradient⟩ cannot be translated (⟨why⟩), so the box keeps its geometry and is left unpainted |
| `backgroundRepeat` | The picture is drawn once, fitted to the box; a tiled pattern cannot be spelled |
| `border` | A native shape outline is uniform; declare every side the same, or use a separate rule/shape |
| `borderCollapse` | Collapsed borders resolve to one line in the browser; adjacent cells disagree on ⟨conflicts⟩, and a native table cell keeps both edges |
| `borderRadius` | A corner with a horizontal and a vertical radius is an elliptical corner, which no native geometry spells: the box is drawn square<br>A native rounded rectangle carries one radius: corners ⟨corners.map((value) => value.toFi…⟩ keep only the first value<br>A percentage radius below 50% is an elliptical corner, which no native geometry spells: the box is drawn square<br>A percentage radius below 50% is an elliptical corner, which no native geometry spells: the picture keeps square corners<br>A table cell has no corner geometry in the file format; the radius squares off<br>The corners round by different amounts; a native roundRect rounds all four alike, so the box is drawn at the top-left radius |
| `borderStyle` | A double border needs a compound line, which the writer cannot spell: it draws as one solid line |
| `boxShadow` | ⟨shadowNote⟩ |
| `boxSizing` | Width is resolved as a border box; declare box-sizing: border-box to make it exact |
| `clipPath` | clip-path clips the subtree; only this box's own paint is clipped, its children keep their shape<br>⟨explicitHeight === null ? 'A clip…⟩ |
| `column-widths` | Fixed-layout columns are scaled into the table box instead of widening it |
| `columns` | ⟨reason⟩ |
| `data-chart` | A bubble needs three numbers per point: an x column, a y column and a size column<br>A bubble reads the columns after x in pairs (y, size); ⟨seriesCount⟩ leaves one of them unpaired<br>A chart needs data: add data-values="1,2,3" or put the numbers in a <table><br>A scatter needs an x column and at least one y series: two numeric columns<br>The first column of a bubble is the x axis, so it has to hold numbers (⟨notNumbers[0]⟩ is not one)<br>The first column of a scatter is the x axis, so it has to hold numbers (⟨notNumbers[0]⟩ is not one)<br>Unknown chart type; use bar or column, line, area, pie, doughnut or radar |
| `data-chart-axis-titles` | Give at most two titles: "category\|value" |
| `data-chart-cat-label-rotate` | Use an angle from -90 to 90 |
| `data-chart-colors` | Chart colours must be #rrggbb values, one per series, in series order |
| `data-chart-dir` | Use col (vertical bars) or bar (horizontal bars) |
| `data-chart-gap-width` | Use a percentage from 0 to 500 |
| `data-chart-grid` | Use y, x, both, true or false |
| `data-chart-grouping` | Use clustered, stacked or percentStacked |
| `data-chart-hole-size` | Use a percentage from 10 to 90 |
| `data-chart-label-format` | Use an Excel number format code |
| `data-chart-label-position` | A ⟨chartType⟩ chart accepts ⟨allowed.join('/')⟩ for data labels, not ⟨options.dataLabelPosition⟩<br>Use outside-end, inside-end, center, best-fit, top, bottom, left or right |
| `data-chart-labels` | Use value, percent, series or none |
| `data-chart-legend` | Use true, false, none, top, bottom, left, right or top-right |
| `data-chart-legend-font-size` | Use a font size in points |
| `data-chart-secondary-axis` | The writer draws one value axis only: a second scale would need hand-written chart XML - split the series into a second chart instead<br>Use true or false |
| `data-chart-smooth` | Smoothing bends a line, and a ⟨chartType⟩ chart draws none<br>Use true or false |
| `data-chart-text-color` | Chart text colour must be a #rrggbb value |
| `data-chart-y-max` | Use a number |
| `data-chart-y-min` | Use a number |
| `details` | A closed details element shows only its summary in a browser; its other content is kept here |
| `display` | Inline flow is approximated as a block box |
| `element` | A form control keeps its text; the reader`s control box (border, fill, padding) is not reproduced<br>Element type has no native translation<br>Text directly inside a block that also has element children does not share a line box with them, so it is not translated: wrap it in an element ("⟨ownText(domNode).slice(0, 32)⟩") |
| `filter` | No native spelling for ⟨entry.name⟩ on a picture: the image draws unfiltered for that function<br>⟨reason⟩ |
| `flexWrap` | A wrapping column needs a definite height to break against<br>Every item of a wrapping column needs a declared width: a column takes its width from its items, and an auto width would be the item\u2019s max-content size<br>Only flex-wrap: wrap and nowrap are translated |
| `float` | A block that follows a float is placed below it; the browser would wrap its lines beside the float<br>A floated box needs a declared width here: its shrink-to-fit width is not measured<br>Only float: left/right (and their inline-start/inline-end spellings) are laid out |
| `fontVariant` | A table cell has no small-caps switch: the letters draw at their own size<br>Only small-caps has a native run property; this value has none<br>Small caps on an inline span is not carried: declare it on the block so the whole box can be patched |
| `fontWeight` | A weight below 400 draws as regular: the format has bold or not, no light axis - name a Light family in font-family to get the cut<br>A weight between 501 and 599 draws as regular: no native spelling exists for intermediate weights |
| `gridColumn` | Named grid lines and areas are not modelled; the item is auto-placed with its span width |
| `href` | An in-page anchor has no slide to jump to in the deck; the link draws but does not navigate |
| `inlineBox` | An inline element that paints a background or border has no native equivalent inside a text run: its text is kept and the paint is dropped |
| `length` | This ⟨entry.property⟩ is not a length this shape can resolve, so the box falls back to the layout default instead of the declared value |
| `listStyle` | Every marker draws as the native round bullet; the declared shape does not change it |
| `listStyleImage` | A marker drawn from an image has no native spelling: the round bullet is used instead |
| `margin` | An auto margin distributes the free space, which needs a declared width: this box hugs its text |
| `maxHeight` | Clamping a container would need clipping, which native shapes cannot do |
| `name` | Unknown chart attribute; the styling it asks for is not applied |
| `objectFit` | Unknown object-fit value: the picture is stretched to fill the box instead |
| `opacity` | opacity fades the whole subtree; only this box's own fill and text are faded, its children keep full opacity |
| `outline` | A shape carries one line: the outline sits beside a border here, so the border is what draws |
| `overflowWrap` | A word is wider than its box: the browser lets it stick out, a reader breaks it, so the box is laid out with the break |
| `property` | A ::first-letter declaration that changes layout is not carried: the letter keeps its place in the line, and only its type is applied<br>CSS feature has no native translation<br>No native spelling for ⟨note⟩: the box falls back to the flex default, and the alignment the design asked for is not applied<br>No native spelling outside a picture, where filter becomes a colour transform<br>Only the default glyph behaviour (mixed) is drawn: eaVert keeps CJK upright and rotates Latin, and no native spelling rotates Latin upright<br>Only the first text-shadow layer is drawn<br>Property is outside the supported subset<br>The marker would sit inside the text line: native bullets always hang in the margin<br>⟨reason⟩ |
| `reversed` | The native numbered list counts up; there is no reverse switch, so the numbering would read in the wrong order |
| `rowspan` | A rowspan reaching past the last row is clipped to the rows that exist |
| `srcset` | The deck always draws the src image; the variants srcset offers are not consulted |
| `textDecoration` | Overline has no native run property; a line above every wrapped line cannot be drawn |
| `textDecorationColor` | The decoration keeps the text colour; the writer emits no underline fill |
| `textDecorationThickness` | The decoration draws at the reader`s default stroke width |
| `textEmphasis` | DrawingML has no emphasis mark: the dots above the characters are not drawn - use a bold or coloured run instead |
| `textIndent` | A cell has no first-line indent: the line starts at the cell edge<br>A negative first-line indent (hanging indent) needs box insets we do not model<br>The native paragraph indent touches only the first line; each-line would indent every wrapped line, so no indent is drawn |
| `textOverflow` | An ellipsis needs a single line: a wrapping block cannot be truncated without losing text<br>The box cuts this line at its edge; the deck keeps the words and a reader draws them past the box (⟨lineWidthIn.toFixed(2)⟩in of text in a ⟨contentWidth.toFixed(2)⟩in box)<br>The browser only ellipsizes a box that clips (overflow: hidden) |
| `textShadow` | A shadow on cell text has no native spelling: the letters draw flat |
| `textWrap` | Balanced line breaking needs the whole paragraph measured twice, which this shape does not do |
| `transform` | rotate(), translate() and a uniform scale() have native answers; skew(), a non-uniform scale() and a non-centre transform-origin do not |
| `transition` | The slide draws the end state; the animated journey between states is not drawn |
| `WebkitBoxOrient` | A line count needs `-webkit-box-orient: vertical` |
| `WebkitLineClamp` | A clamp counts wrapped lines, so it needs wrapping text<br>A clamp is only honoured on `display: -webkit-box` |
| `whiteSpace` | A table cell has no wrap switch: the line may re-wrap inside its column<br>Line breaks are kept, but runs of spaces collapse to one, which ⟨whiteSpace⟩ preserves |
| `wordBreak` | CJK text breaks between characters here; keep-all forbids exactly that break |
| `wordSpacing` | A table cell cannot space its words apart: the space keeps its own width<br>Words keep their ordinary advance; a run has per-character spacing, not per-word |
| `writingMode` | Vertical text needs a declared height: the box height is the line length, so it cannot be derived from the text<br>Vertical text needs ⟨columns⟩ column(s) (⟨requiredWidth.toFixed(2)⟩in) but the box is ⟨usableWidth.toFixed(2)⟩in wide; widen it or give the text more height<br>⟨value === 'vertical-lr' ? 'vertic…⟩ |

`⟨expr⟩` is a part of the sentence the engine fills in at run time: the expression inside the brackets is what it substitutes, so it can be found in `pipeline/analyzer.js`. The wording around it is fixed.

<!-- generated:end -->

## Gaps that are not a missing feature

These are places where DrawingML has no object to draw, so no amount of work closes them. They
are named in the report like everything else, and each one lists what a design can do instead.

| CSS | why no native object exists | what to write instead |
| --- | --- | --- |
| `float` with text wrapping around it | DrawingML text flows in a box, not around shapes; a
slide has no float context | absolute positioning, or a two-column flex row |
| `border-collapse: collapse` where neighbours disagree | a table cell has four independent
borders; a shared edge with two different widths is not representable | give both cells the same
border, or let the engine draw the first one and name the conflict |
| `background-clip: text` | a fill is painted behind glyphs, never inside their outline | a
picture fill on the words, or a solid colour |
| `clip-path: circle(30% at 70% 30%)` | a custom geometry is a polygon in shape coordinates; an
off-centre circle would need a curved path with an arbitrary arc | a centred radius (a native
ellipse), or a pre-cropped image |
| `image-rendering: pixelated` | picture resampling is a reader setting | scale the asset |
| a form control's own box | the reader paints its own border, fill and padding around a widget |
a styled container that looks like a control |
| a `.ttc` or `.otf` face | the embedding part carries TrueType data only | convert to `.ttf`, or
let the deck reference the font by name |
| `text-decoration-style: wavy` on a *table cell* | the cell run mapper takes one underline per
cell, and small caps and per-cell decorations are named once per table | set it on the cell text
|

## Gaps this machine cannot adjudicate

Two questions need a real Microsoft PowerPoint, and no reader available here can answer them:

1. **Line spacing convention.** `a:lnSpc/a:spcPct` is a percentage of the line's *natural*
   height, and CSS `line-height: 1.25` is 1.25 *em*. LibreOffice and WPS both read it the CSS
   way and agree with each other to the pixel on 60 fingerprint pages, but PowerPoint may
   interpret the same number differently. The engine writes what it measured and reports nothing;
   if a real PowerPoint disagrees, this line is where to start.
2. **Repair behaviour.** Three readers open every deck without a complaint - LibreOffice, WPS,
   and python-pptx (which round-trips the package) - and the OOXML audit checks child order,
   table grids, enumerations and fonts against the schema. Only PowerPoint itself decides whether
   it offers to repair a file it can parse.

## What is *not* on this list

Everything else the HTML can say, the deck draws: flex and grid tracks, columns, insets and
margins with CSS's quirks, single-side borders (including along a rounded corner), gradients,
shadows, transforms, tables with merged cells, native charts with declared data, and every
typographic property listed in `SKILL.md` with its own gate.
