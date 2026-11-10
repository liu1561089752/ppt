# What the writer cannot do

Generated from the code by `npm run limits:update`; `npm run limits` fails when this
document and the source disagree. Every entry is a place where the engine refuses to guess, a
rule that rejects a spec before anything is written, or a check the tool reports on the boxes
it did write.

## Refusals the engine can raise (66)

| where | message |
| --- | --- |
| `engine/native_pptx.js:144` | Container elements must be resolved by the layout engine before serialization |
| `engine/native_pptx.js:255` | Unsupported chart type: |
| `engine/native_pptx.js:386` | Unable to locate the picture blip for a filter patch |
| `engine/native_pptx.js:407` | Unable to locate the picture blip fill for an image crop patch |
| `engine/native_pptx.js:416` | Unable to locate the picture geometry for an image effect patch |
| `engine/native_pptx.js:442` | Image patch alignment mismatch on slide |
| `engine/native_pptx.js:487` | Unable to locate the picture fill for a tile patch |
| `engine/native_pptx.js:494` | Unable to read the picture frame for a tile patch |
| `engine/native_pptx.js:519` | Tile patch alignment mismatch on slide |
| `engine/native_pptx.js:530` | Tile patch frame mismatch on slide |
| `engine/native_pptx.js:549` | Invalid deck spec:\n- |
| `engine/native_pptx.js:644` | Gradient base transparency must be between 0 and 100 |
| `engine/native_pptx.js:647` | Gradient fill requires at least two color stops |
| `engine/native_pptx.js:649` | Gradient angle must be finite |
| `engine/native_pptx.js:652` | Gradient stop |
| `engine/native_pptx.js:655` | Gradient stop |
| `engine/native_pptx.js:659` | Gradient stop |
| `engine/native_pptx.js:687` | Gradient patch alignment mismatch on slide |
| `engine/native_pptx.js:698` | Unable to locate solid shape fill for gradient on slide |
| `engine/native_pptx.js:704` | Gradient patch count mismatch on slide |
| `engine/native_pptx.js:742` | Unable to locate spPr for an inner shadow patch |
| `engine/native_pptx.js:934` | Clip geometry patch alignment mismatch on slide |
| `engine/native_pptx.js:939` | Clip geometry patch count mismatch on slide |
| `engine/native_pptx.js:1015` | Small caps patch alignment mismatch on slide |
| `engine/native_pptx.js:1020` | Small caps patch count mismatch on slide |
| `engine/native_pptx.js:1053` | Text column patch alignment mismatch on slide |
| `engine/native_pptx.js:1058` | Text column patch count mismatch on slide |
| `engine/native_pptx.js:1234` | Cell bullet patch alignment mismatch in |
| `engine/native_pptx.js:1240` | Cell bullet patch paragraph mismatch in |
| `engine/native_pptx.js:1248` | Cell bullet patch alignment mismatch in |
| `engine/native_pptx.js:1263` | Cell bullet patch alignment mismatch in |
| `engine/native_pptx.js:1271` | Cell bullet patch alignment mismatch in |
| `engine/native_pptx.js:1428` | Shape hyperlink patch found no relationships part for slide |
| `engine/native_pptx.js:1452` | Shape hyperlink patch alignment mismatch on slide |
| `engine/native_pptx.js:1457` | Shape hyperlink patch could not put a click on |
| `engine/native_pptx.js:1504` | Cell bullet patch alignment mismatch on slide |
| `engine/native_pptx.js:1522` | Cell bullet patch alignment mismatch on slide |
| `engine/native_pptx.js:1629` | List numbering patch alignment mismatch on slide |
| `engine/native_pptx.js:1683` | Marker colour patch alignment mismatch on slide |
| `engine/native_pptx.js:1759` | Text indent patch alignment mismatch on slide |
| `engine/native_pptx.js:1765` | Text indent patch count mismatch on slide |
| `engine/native_pptx.js:1895` | Data-label position patch alignment mismatch: the Deck Spec has |
| `engine/native_pptx.js:1912` | Data-label position patch alignment mismatch on chart part |
| `engine/native_pptx.js:2027` | Series line style patch: the series holds no c:spPr to carry a line |
| `engine/native_pptx.js:2081` | Series line style patch alignment mismatch: |
| `engine/native_pptx.js:2122` | Series line style patch alignment mismatch: the Deck Spec has |
| `engine/native_pptx.js:2134` | Series line style patch alignment mismatch on chart part |
| `engine/native_pptx.js:2138` | Series line style patch: |
| `engine/native_pptx.js:2342` | Title placeholder patch alignment mismatch on slide |
| `engine/native_pptx.js:2346` | Title placeholder patch missed on slide |
| `engine/native_pptx.js:2358` | outputPath is required |
| `engine/image_fit.js:83` | Image focus object requires finite x and y in the 0..1 range |
| `engine/image_fit.js:87` | Image focus must be a preset name or an { x, y } object |
| `engine/image_fit.js:172` | A tile needs a positive cell size and a finite picture frame |
| `engine/image_fit.js:218` | Image crop. |
| `engine/image_fit.js:222` | Image crop left + right must be less than 1 |
| `engine/image_fit.js:223` | Image crop top + bottom must be less than 1 |
| `engine/image_fit.js:230` | Image zoom must be a finite number greater than or equal to 1 |
| `engine/image_fit.js:296` | Image element requires a finite |
| `engine/image_fit.js:298` | Image element requires a positive w and h for fit resolution |
| `core/units.js:13` | Unsupported unit: |
| `core/units.js:20` | pageSize must be wide, standard, or { width, height } in inches |
| `cli.js:65` | unknown option |
| `cli.js:81` | spec not found: |
| `cli.js:88` | spec is not valid JSON ( |
| `cli.js:92` | spec must be .json, .js or .cjs (got |

## A spec is rejected before anything is written

`core/schema.js` holds **110 conditions** that reject a spec, and every message names
the path that broke (`slides[2].elements[7].w must be a finite non-negative number`). They are
counted here rather than quoted: the text is built per element, so a table of it would be a
table of the code. `node cli.js <spec> --check` prints the message for the spec in hand.

The three value sets worth knowing before writing a spec: element types `text, shape, line,
image, table, chart, container`; image fits `stretch, fill, none, cover, contain, crop,
scale-down`; page sizes `wide`, `standard`, or `{ width, height }` in inches.

## Layout checks on the deck that was written

`cli.js` runs these on the boxes the writer really used, prints them on stderr, and fails the
run with `--strict`.

| code | meaning |
| --- | --- |
| `OUT_OF_BOUNDS` | an element extends past the page; a decorative shape may bleed, a text box may not |
| `TEXT_OVERFLOW_RISK` | the measured text needs more height than its box has |
| `TEXT_OVERLAP` | two text boxes intersect |

## Only PowerPoint can adjudicate

These are written correctly as far as this machine can tell, and the readers here disagree with
PowerPoint (or with each other) about them. They stay here rather than in a fixture, because a
fixture would record one reader's opinion as if it were a fact.

- **`a:tile` picture and shape fills.** A tiled fill is written as a blip fill with
  `<a:tile tx="…" ty="…"/>`. LibreOffice and WPS both ignore the tile rectangle and draw one
  stretched cell of the image: a dotted-pattern probe came back as a single dot per panel. PowerPoint
  is expected to tile it. The element is correct; the picture on this machine is not evidence.
- **`a:spcPct` line spacing.** Line-spacing multiples are written as a percentage of a line
  (`val="118000"` for 1.18). A reader computes that percentage against its own font metrics, so the
  same deck can be one line taller in one reader and one line shorter in another. PowerPoint's
  convention is the one we target.
- **Text metrics without the face.** Every build prints `fonts … no face files: wrap is
  estimated` when the deck's family is not installed here: the wrap then comes from fallback metrics,
  so a line count - and every block placed under that text - is an estimate. `--strict` does not fail
  on it, deliberately: a machine without the font would then fail every deck. A real 25-page run
  found the cover title breaking one line later than estimated and pushing the whole page down
  0.65 in, with no gate complaining. Give tight boxes slack, or break the line explicitly.
- **Repair prompts.** A part that a reader tolerates can still make PowerPoint offer to "repair" the
  presentation. `verify_native_ooxml.py` checks the schema of everything written and
  `corrupt_anchor.py` proves those checks fire on a deliberately damaged part, but neither can say
  what PowerPoint's repair logic will decide.
- **A dashed bar has no visible outline.** A per-series `<a:prstDash>` lands on the series'
  `<a:ln>`, and a DrawingML line with no fill draws nothing. Hand-adding a colour to that line made
  the dash appear in a render, which proves the element is right and that inventing an outline colour
  would be a design change rather than a fix.

## Named by the tool rather than drawn

- A picture the writer cannot read is reported in `droppedPictures` and omitted; the tool
  prints how many, so the run is not silent about it.
- A per-series marker rhythm, per-run `text-transform`, right-to-left runs and a list marker
  inside a table cell are not implemented; they are listed here instead of half-drawn.
