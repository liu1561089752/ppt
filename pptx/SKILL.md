---
name: ppt
metadata:
  author: Z.AI
  version: "2.0-native"
  adapted: "the creation path is the native Deck Spec engine; web search is Bocha, image search is Unsplash"
description: "Presentation creation, editing, and analysis for .pptx files: (1) Creating new presentations as native PowerPoint objects from a Deck Spec, (2) Modifying or editing content, (3) Working with layouts, (4) Adding comments or speaker notes."
license: Proprietary. LICENSE.txt has complete terms
---

# PPT creation, editing, and analysis

## Overview

A user may ask you to create, edit, or analyze the contents of a .pptx file. A .pptx file is essentially a ZIP archive containing XML files and other resources that you can read or edit. You have different tools and workflows available for different tasks.

**Creating a new deck goes through the native engine, and only through it.** A Deck Spec — content and design intent written as elements in inches — goes in; a `.pptx` whose every word is a text run, every panel a shape, every table an `a:tbl`, every chart a chart with its workbook beside it comes out. There is no HTML step, no browser, no screenshot, and no rasterised page: a page that cannot be expressed as objects does not get written, it gets named as a limitation.

> Changed from v1.0: the four-stage flow, the design language, the quality bar and the whole editing section are the same. What changed is the renderer (stage 4), the export (there is none — the deck is written directly), the search provider (**Bocha**, not `web_search`) and the image source (**Unsplash**, not `z-ai image-search`). The engine's contract is in the appendix; read it before writing your first spec.

## Reading and analyzing content

### Text extraction

To read the text content of a presentation, convert it to markdown:

```bash
python -m markitdown path-to-file.pptx
```

### Raw XML access

For comments, speaker notes, slide layouts, animations, design elements, or complex formatting, unpack the presentation and inspect its raw XML.

#### Unpacking a file

```
python ooxml/scripts/unpack.py <office_file> <output_dir>
```

**Note**: `unpack.py` is at `skills/pptx/ooxml/scripts/unpack.py` relative to the project root. If not found, run `find . -name "unpack.py"` to locate it.

#### Key file structures

| Path | Contents |
|------|----------|
| `ppt/presentation.xml` | Main metadata and slide references |
| `ppt/slides/slide{N}.xml` | Per-slide content |
| `ppt/notesSlides/notesSlide{N}.xml` | Speaker notes |
| `ppt/comments/modernComment_*.xml` | Slide comments |
| `ppt/slideLayouts/` | Layout templates |
| `ppt/slideMasters/` | Master slide templates |
| `ppt/theme/` | Theme and styling |
| `ppt/media/` | Images and other media |

#### Typography and color extraction

**When emulating an existing design**, extract typography and colors before starting:

1. **Theme file** — `ppt/theme/theme1.xml`: colors (`<a:clrScheme>`), fonts (`<a:fontScheme>`)
2. **Slide content** — `ppt/slides/slide1.xml`: actual font usage (`<a:rPr>`) and colors
3. **Global search** — grep for `<a:solidFill>`, `<a:srgbClr>`, and font references across all XML files

When the reference is a `.pptx` you want the new deck to look like, do not read it by hand — sample it:

```bash
python <engine>/../scripts/extract_native_design.py reference.pptx design/
# → design/tokens.json (palette, type scale, spacing), design/fonts.json, design/blocks.json
```

Feed that straight into `deck/theme.js` (stage 3).

---

## Creating a new PowerPoint presentation **without a template** (most case, creating ppt/pptx from scratch)

When the user uploads a pptx and asks to use it as a template, do **not** follow this section — follow `## Editing an existing PowerPoint presentation（pptx）` instead.

You are an elite deck design agent. You produce beautiful, content-rich, 16:9 decks that are written as **native PowerPoint objects** from a Deck Spec, and you commit every page of that spec to disk via the `Write` tool. Use the `Agent` tool to fan out the writing of body pages to a **ppt sub-agent** (`subagent_type: ppt-expert`, falling back to `general-purpose` if unavailable) so multiple sections are written in parallel.

You operate in four strict stages. Do NOT skip or reorder stages.

```
<work_dir>/deck/
├── theme.js            ← the deck-wide design tokens (palette, type scale, spacing, radii)
├── slides_brief.json   ← the dispatch manifest: design + one self-contained brief per page
├── slide_01.js         ← one page per module, written in stage 4 by sub-agents
├── slide_02.js
├── deck.js             ← requires theme.js + every slide_NN.js in order (written by you)
├── assets/             ← Unsplash photos, downloaded once, referenced by relative path
└── <name>.pptx         ← the deck the engine writes
```

═══════════════════════════════════════════════════════════════════════
STAGE 1 — CLARIFY (collect mandatory inputs via `AskUserQuestion`)
═══════════════════════════════════════════════════════════════════════

**Step 0 — Reference detection (run BEFORE asking any question).**

Before invoking `AskUserQuestion`, look at the user's upload directory and the user's prompt for a single reference asset. The cases below are auto-handleable; run the matching extraction first, write the result into `<work_dir>/deck/`, then SKIP the palette and typography questions (the user has implicitly answered them by handing you the reference). Still ask the remaining questions.

  • **PPTX reference** (`*.pptx` whose design the deck should follow):
      ```
      python <engine>/../scripts/extract_native_design.py <reference.pptx> <work_dir>/deck/design
      ```
      Convert `design/tokens.json` into `deck/theme.js` verbatim (colors without `#`, inches for spacing). `slides_brief.json.design` records `reference: "imitating <reference.pptx>"` and the model must NOT redefine the palette or the type scale afterwards.

  • **HTML / CSS reference** (a page whose look the deck should follow):
      Read it as a *design brief*, not as input to a renderer. Extract the palette, the type scale, the spacing rhythm and the radii by reading the CSS, then write them into `deck/theme.js` by hand. Nothing in this repository parses HTML any more; there is no converter to hand it to.

If neither reference exists, proceed to the questions below as normal.

**Step 1 — Ask the user.** Before doing anything else (after Step 0), collect the user's explicit choices on the dimensions below.
**These are mandatory inputs — do NOT silently default any of them**, even when the user's request hints at one. Explicit confirmation prevents wrong-style decks and saves whole re-renders later.

Mandatory dimensions — ask between 4-6 questions (not exceed 6 questions) across the 10 items below.
Items marked **★** are strictly mandatory (palette, typography, per-page detail); the rest should be asked unless the user's original request explicitly rules them out (e.g. "internal deck, no notes" → skip notes question).

  1. **主题与目的 (Topic & purpose)** — the deck's core theme and the main aspects it should showcase. Ask this FIRST — every downstream choice (length, layouts, data) hinges on it, so do not let it be implicit.
  2. **目标受众 (Audience & tone)** — who is this for, what register.
  3. **篇幅 (Deck length)** — tight range. like 1–8 / 8–12 / 12以上 slides, you must give user short slides choice.
  4. **风格与基调 (Style & tone)** — the deck's overall voice as ONE preset: 商务 (business) / 简约 (minimal) / 正式汇报 (formal report). This is the high-level register; the palette and typography questions below refine it into concrete colors and fonts.
  5. **Visual reference** — a recognizable style anchor (one or two named reference decks / websites the user wants this to feel like).
  6. **★ Palette (调色盘)** — ONE question that collects **all three** of `background` / `primary` / `accent` together (as a unified palette choice). Do NOT split into three separate questions. The options the user picks from must be generated at runtime — do not hard-code specific colors or hex codes here in the skill.
  7. **Speaker notes (备注讲稿)** — none / short bullet hints / verbatim full script.
  8. **已有素材 / 数据来源 (Existing materials / data sourcing)** — 用户是否已提供素材或数据；是否需要在最终页面标注数据来源 (是 / 否)。
  9. **Must include data** — the numbers, tables or charts the deck cannot ship without.
  10. **Need image search** — whether the deck should carry photography at all (this decides whether stage 2 spends Unsplash requests).

Important constraints when constructing the actual `AskUserQuestion` calls:
  • **Think carefully before asking.** Before each `AskUserQuestion` call, spend real reasoning on the user's domain, audience, and visual reference (Q1 / Q4). The point of asking is to surface CHOICES — so the choices you offer must themselves be a creative, well-considered design proposal. Generic "Light / Dark / Other" is a failure mode.
  • **Each option must be a concrete creative direction**, not a category label. For the palette question that means each option names a coherent trio (background + primary + accent) tuned to the user's topic — e.g. a finance deck and a children's-book pitch should NEVER see the same three palette options. Same rule for typography: each option proposes a specific heading + body pairing that fits the deck's voice.
  • **Mark your recommendation.** In every question, pick ONE option that you genuinely believe is the strongest fit and put it FIRST, with the suffix `(Recommended)` appended to its `label`. Use this for palette, typography, per-page detail level, and visual reference — anywhere the answer materially shapes the deck. Do NOT mark more than one option as recommended per question.
  • The palette question is a SINGLE question whose options each describe a coherent (background + primary + accent) trio. The user picks one trio, or chooses "Other" to provide their own three colors.

How to dispatch the questions:
  • `AskUserQuestion` carries 4-6 questions per call.
  • Each question: a short `header` (≤12 chars), the `question` itself, and 3–4 `options` (each with `label` + short `description`). The user can always pick "Other" for free-text custom input.
  • Do NOT call any other tool in the same turn as `AskUserQuestion`.
  • Do NOT proceed to Stage 2 until every mandatory dimension has been answered. Once answered, the palette / typography / detail-level choices flow directly into `deck/theme.js`, `slides_brief.json.design` and the per-slide `task_brief` in Stage 3 — they MUST match exactly.

═══════════════════════════════════════════════════════════════════════
STAGE 2 — RESEARCH (Bocha web search + page visits + Unsplash images)
═══════════════════════════════════════════════════════════════════════

Gather facts and visual assets. Both providers need a key in the environment; **if a key is missing, stop and ask the user for it** — do not invent facts and do not pretend you searched.

Text research — **Bocha Web Search API** (博查):

```bash
curl -sS 'https://api.bochaai.com/v1/web-search' \
  -H "Authorization: Bearer $BOCHA_API_KEY" \
  -H 'Content-Type: application/json' \
  -d '{"query": "人工智能 2025 市场规模", "freshness": "oneYear", "summary": true, "count": 8}'
```

  • `query` is a natural-language question, not a keyword soup.
  • `freshness`: `noLimit` (default) · `oneDay` · `oneWeek` · `oneMonth` · `oneYear` · or an explicit `YYYY-MM-DD..YYYY-MM-DD` range. Use the tightest window the question tolerates; "最新/今天/今年" needs one of these, or the answer will be last year's.
  • `count`: 1–10 (8 is a good default).
  • `summary: true` returns an LLM-written `summary` per result — read the snippets first, and only visit a page when the snippet cannot settle the question.
  • Read `data.webPages.value[]`: each entry has `name`, `url`, `siteName`, `snippet`, `summary`, `datePublished`. Quote the numbers you take, and keep the `url` — it belongs in the deck's source line.
  • Batch 2–3 queries in one turn (they run concurrently), and prefer one wide query over five narrow ones. Budget: at most ~10 searches per deck.
  • Follow up with a page visit (`web_fetch <url>`) only for pages whose snippet is ambiguous or whose data you are going to chart.

Image assets (THIS IS IMPORTANT) — **Unsplash**:

  • Search:
      ```bash
      curl -sS -H "Authorization: Client-ID $UNSPLASH_ACCESS_KEY" \
        "https://api.unsplash.com/search/photos?query=modern%20office%20meeting&per_page=5&orientation=landscape&content_filter=high&order_by=relevant"
      ```
      Each result carries `id`, `width`, `height`, `color` (average colour — useful for a bleed band), `blur_hash`, `alt_description`, `urls.raw|full|regular|small|thumb`, `links.html` (the photo page) and `user.name` / `user.links.html` (the photographer).
  • Pick the photo by reading `alt_description` and `color`, never by guessing from the URL.
  • **Download it once, then reference the file.** A deck must not depend on a URL being reachable at open time:
      ```bash
      mkdir -p <work_dir>/deck/assets
      curl -sS -L -H "Authorization: Client-ID $UNSPLASH_ACCESS_KEY" \
        "https://api.unsplash.com/photos/<id>/download" -o <work_dir>/deck/assets/hero-office.jpg
      ```
      (`/photos/:id/download` both serves the file and registers the download, which is how Unsplash counts usage. If it returns a 302, add `-L` as above.) Ask for the size you will actually place, e.g. `urls.raw + "&w=1600&q=80&fm=jpg"`, and keep the `ixid` parameter if the URL has one.
  • **Attribute.** Whenever a photo appears, the slide carries a small credit line (`Photo: <user.name> / Unsplash`, `fontSize` from `theme.sizes.caption`, `color: theme.colors.muted`), and `slides_brief.json` keeps the full `links.html` of the photo and the photographer in a `credits` array. A deck with unattributed Unsplash photos is not deliverable.
  • In the spec, images are referenced by **relative path** (`assets/hero-office.jpg`), because the engine reads them from disk at build time. Never inline a base64 blob, never point a slide at `images.unsplash.com`.
  • You MAY emit several `Bash` calls in the SAME assistant turn — they run concurrently. Prefer batching 3–4 searches per turn to save wall time.
  • HARD LIMIT: at most **6 Unsplash searches** across the whole trajectory, and at most ~8 photos downloaded for the deck. Plan the image needs up front and reuse a photo across pages where it helps (a cover and its closing page may share one).
  • If the API answers 403 with `Rate Limit Exceeded`, the demo tier is 50 requests/hour: say so, reuse what you already have, and continue without the extra photo instead of retrying in a loop.

═══════════════════════════════════════════════════════════════════════
STAGE 3 — PLAN (commit the design and the page briefs as files before fan-out)
═══════════════════════════════════════════════════════════════════════

After research, commit the deck design and page briefs to disk so the build stage and every sub-agent share the SAME source of truth.

**`<work_dir>` definition (MANDATORY)**: `<work_dir>` IS the user's `download/` directory itself. Do NOT create an intermediate themed/topic-named subdirectory. The deck folder must end up at `download/deck/`, NOT `download/<anything>/deck/`. Every `<work_dir>/deck/...` path in this skill resolves under `download/` directly.

**Step 3.0 —** in a SINGLE assistant turn, use `Write` to create both files.

1. `<work_dir>/deck/theme.js` — the deck-wide design, the analogue of v1.0's `global.css`. Every page imports it; **no page redefines a colour, a font size or the palette**. It is a plain module so the engine can read it and the sub-agents can `require` it:

   ```js
   'use strict';
   const { resolveTheme } = require('<engine>/themes/design_system');

   module.exports = resolveTheme({
     name: 'the-deck',
     colors: {
       background: 'F7F5F1',   // hex without '#'
       surface: 'FFFFFF',
       foreground: '1F2421',
       primary: '183B3A',
       accent: 'D36B45',
       muted: '6B7470',
       border: 'DCE2DE'
     },
     fonts: { heading: 'Source Han Sans SC', body: 'Source Han Sans SC' },
     sizes: { title: 34, heading: 20, body: 14, caption: 10 },   // points
     spacing: { pageX: 0.9, pageY: 0.62, md: 0.24, lg: 0.4 },    // inches
     radii: { small: 0.06, medium: 0.12, large: 0.2 },
     effects: { cardBorder: true }
   });
   ```

   Keep it under ~60 lines. `resolveTheme` merges it over the engine's baseline, so state only what differs — and it fills in the rest: `spacing` (`xs`/`sm`/`md`/`lg`/`xl`/`pageX`/`pageY`), `radii` (`small`/`medium`/`large`), `effects` (`cardBorder`/`softShadow`/`accentRule`), `typography`, `layouts`.

   **Typography scope — tokens only, no bundled classes.** The theme carries *values* (families and sizes); a page chooses *which* size a headline gets (`fontSize: theme.sizes.title`) and never hard-codes `28`. This is v1.0's "global CSS scope" rule in native form: a page may not invent a type scale, a colour, or a radius.

2. `<work_dir>/deck/slides_brief.json` — the dispatch manifest. Schema:

   ```json
   {
     "design": {
       "title": "(deck title)",
       "style_name": "...",
       "palette": { "background": "#…", "primary": "#…", "accent": "#…" },
       "typography": { "heading": "xx", "body": "xx", "numeric": "xx" },
       "reference": "Apple keynote / The Verge / …"
     },
     "theme_path": "<absolute path to <work_dir>/deck/theme.js>",
     "deck_dir": "<absolute path to <work_dir>/deck>",
     "language": "zh|en|bilingual",
     "speaker_notes": "none | short | full",
     "credits": [
       { "file": "assets/hero-office.jpg", "photo": "https://unsplash.com/photos/…",
         "photographer": "Name", "photographer_url": "https://unsplash.com/@…" }
     ],
     "slides": [
       {
         "title": "...",
         "layout": "cover",
         "output_path": "<absolute path to <work_dir>/deck/slide_01.js>",
         "task_brief": "Self-contained brief — see rules below."
       }
     ]
   }
   ```

   • Slide ORDER is the order of entries in the `slides` array — no `position` / index field. To reorder a deck, reorder the list.
   • Every slide MUST have `title`, `layout`, `output_path`, `task_brief`.
   • `output_path` is the ABSOLUTE path the page module will be written to. Filenames are arbitrary stable identifiers (`slide_01.js`, …); their alphabetical order does NOT define slide order. Once assigned, do NOT rename a page's file when reordering or inserting; move its entry in the list instead.
   • `layout` MUST be chosen per page from a coherent catalog: cover, section header, key message, KPI row, bento grid, split text+image, timeline, process, comparison, table, chart, quote, closing. Prefer a real engine template or component when one fits (`cover`, `hero`, `content`, `kpi`, `comparison`, `process`, `editorial`); hand-place elements only for the pages no template describes. Diversify layouts across pages — do NOT reuse the same layout for consecutive slides.
   • Section structure for longer decks: once the deck gets long (roughly **≥10 pages**), split the body into 2–5 named chapters with a `section header` page at the start of each. A reasonable rhythm is 3–6 content pages per chapter; if a stretch goes past ~7 pages without a break, that's a hint another section header would help. Section-header briefs typically carry: chapter number ("01 / 03"), chapter title, one short tagline; no body bullets, no images.
   • `task_brief` is the SOLE input the sub-agent will see for that page — it MUST be self-contained.
       – Keep it concise: exactly what the page needs, no filler, no restating the design block, no meta reminders.
       – Restate the page's exact text content: headline, body copy, data points, stats, quotes, key phrases. Copy verbatim — do not paraphrase loosely.
       – Resolve every "hero photo of …" reference into the **local asset path** (`assets/hero-office.jpg`) that stage 2 downloaded, plus one sentence of what the photo shows (the sub-agent must be able to choose `fit`/`focus` from that). The sub-agent cannot search; if the path is not in the brief, the page ships with no photo.
       – If the user asked for speaker notes, append `Speaker notes:` at the END of the brief and say what they must cover. The top-level `speaker_notes` field (`none`/`short`/`full`) tells the sub-agent how deep to go. The sub-agent writes them into the page's `notes` field, which the engine puts in the notes part — never onto the slide.
       – Add any layout-specific payload the sub-agent needs (chart series and values, table rows, timeline events, comparison columns, exact quote attribution). The committed `design` block is already in `slides_brief.json`, so do NOT repeat it inside each `task_brief`.
       – Do NOT carry meta / quality-bar reminders inside the brief: word-count targets, "diversify layouts", "no photos", "verify contrast". Those live ONCE in the sub-agent's checklist (stage 4).

═══════════════════════════════════════════════════════════════════════
STAGE 4 — BUILD (fan out `Agent` sub-agents to write the pages)
═══════════════════════════════════════════════════════════════════════

Every page — cover / body / closing — is committed by a `ppt` sub-agent that calls `Write` itself. The main agent NEVER writes page modules. This keeps the work uniformly parallel and removes any temptation to serialize it onto the main turn.

  • `Agent(subagent_type="ppt-expert", description=..., prompt=...)` — spawn a sub-agent that writes a CONTIGUOUS RANGE of pages. Use it for every page in the deck. Single-page groups are fine when a section (or the cover) stands alone.
  • **If you cannot spawn sub-agents** (some harnesses cap depth at 1, so an agent that is itself a
    sub-agent gets `subagent depth 2 exceeds maxDepth 1`), write every page module yourself, in brief
    order, one page at a time. Stage 3's `theme.js` and `slides_brief.json` remain mandatory — they
    are what keeps 25 sequential pages consistent — and every build/verify step below still applies.

  1. Immediately after Stage 3's files are on disk, emit ALL `Agent` calls in ONE assistant turn. Everything in that turn runs concurrently — this is ~3–5x faster than sequential iteration.

  2. How to group the pages:
     • A group is a CONTIGUOUS RANGE of entries in the `slides` list (e.g. indices 0..4 in JSON order). The sub-agent reads the briefs for those entries and writes each page module to its `output_path` in list order — locking in a consistent layout/component language across a section.
     • Pages in DIFFERENT groups run IN PARALLEL.
     • Keep groups small (5–7 pages). Good groups follow narrative sections: cover / intro / data / cases / closing.
     • HARD CAP: at most **3 `Agent` calls per deck total**. If the body has more sections than that, MERGE adjacent sections into a single group rather than spawning a sixth. The cap is real — more groups means more sub-agent spin-up overhead AND weaker visual consistency across the deck.

  3. Sub-agent dispatch prompt — every `Agent` call's `prompt` MUST explicitly carry these three things at the top, in this exact order:
     a) the index range (0-based, half-open) into `slides_brief.json.slides[]` the sub-agent is responsible for (`start..end`),
     b) the ABSOLUTE path to `slides_brief.json` (`<work_dir>/deck/slides_brief.json`),
     c) the ABSOLUTE path to `theme.js` (`<work_dir>/deck/theme.js`).
     If any of the three is missing or relative, the sub-agent will write pages that do not fit the deck. Do NOT hand-wave these as "see the brief" — write the literal absolute paths and the literal index numbers into every dispatch prompt.

     Use this exact shape for every `Agent` call's `prompt` field (substitute the bracketed values per group):

     ```
     You are a page-writing sub-agent for a native PowerPoint deck. Write ONLY pages `slides[{start}:{end}]` (0-based, half-open) — do NOT touch other pages.

     First Read these absolute paths:
       • Brief manifest: {absolute path to <work_dir>/deck/slides_brief.json}
       • Deck theme:     {absolute path to <work_dir>/deck/theme.js}
     Both live in the SAME directory ({absolute path to <work_dir>/deck/}); write each page module there as a sibling.

     For each entry in `slides[{start}:{end}]`, in list order, write ONE CommonJS module at its `output_path`:

       'use strict';
       const theme = require('<absolute path to theme.js>');
       module.exports = function page() {          // or: module.exports = { theme, elements: [...] }
         return {
           background: theme.colors.background,
           notes: '…',                              // only when the brief asks for speaker notes
           elements: [ /* inches, straight from the brief */ ]
         };
       };

     Rules:
       - `elements` use the engine vocabulary only: text · shape · line · image · table · chart · container
       - every colour comes from `theme.colors.*`, every font size from `theme.sizes.*`, every gap/inset from `theme.spacing.*`; never hard-code a hex, a point size or a margin
       - positions and sizes are INCHES on a 13.333 x 7.5 canvas; keep text inside x 0.9..12.43 and y 0.62..6.88 unless the design bleeds a shape on purpose
       - render EVERY fact / headline / bullet / stat / quote / image path in `task_brief` verbatim
       - images: `{ type: 'image', path: 'assets/xxx.jpg', x, y, w, h, fit: 'cover', focus: 'center' }` — the field is `path` (or a `data:` blob), NOT `src`; a `src` fails validation with "requires path or data". The file must already exist beside the deck; never invent a path, never use a URL
       - a chart is a `chart` element with real `data` (name/labels/values), never a picture of a chart; a table is a `table` element with `rows`, never a stack of text boxes
       - speaker notes: if `speaker_notes` is `short`/`full`, fill `notes` (`short` = 3–5 bullet hints, `full` = ~80–150 word script; match the deck language; cover any `notes_must_include:` points). If `none`, omit it.
       - obey every constraint in the NATIVE QUALITY BAR (text density, contrast, element discipline, no rasterised page)
     Commit each page with `Write(file_path=<output_path from brief>, content=<full module>)`.

     Update the worklog only once, when finished — one sentence summary per page.
     ```

     Pass `subagent_type: ppt-expert`. If the harness reports it as unavailable, fall back to `subagent_type: general-purpose` and prepend the engine contract from the appendix of this skill into the prompt.

  4. The `Agent` tool result returns ONLY the sub-agent's textual summary (in one sentence) — it does NOT echo the module source. To inspect a page, `Read(file_path=<output_path>)`.

  5. A sub-agent must never echo source as plain text — only the `Write` call commits a page.

**Step 4.6 — assemble and write the deck (you, the main agent, do this).**

Write `<work_dir>/deck/deck.js` once every page module exists:

```js
'use strict';
const theme = require('./theme');
// A page module may export the page itself, or a function that returns it.
const page = (n) => {
  const loaded = require('./slide_' + n);              // slide_01.js … slide_NN.js
  return typeof loaded === 'function' ? loaded() : loaded;
};
module.exports = {
  title: '…', author: '…', language: 'zh-CN', pageSize: 'wide', theme,
  slides: [page('01'), page('02') /* … in brief order … */]
};
```

Then build it, and **read what the tool says**:

```bash
cd <work_dir>/deck
node <engine>/cli.js deck.js out.pptx --report out.json --layout-out layout.json
```

  • Exit `0` = written; `1` = the spec was rejected (nothing written — fix it, do not ship a partial deck); `2` = the writer failed.
  • `warnings none` is the target. A warning names its page and its box: `OUT_OF_BOUNDS` (a box escapes the canvas — a decorative shape may bleed on purpose, a text box may not), `TEXT_OVERFLOW_RISK` (the measured text needs more height than its box has), `TEXT_OVERLAP` (two text boxes intersect).
  • Fix the **geometry or the copy**, in the page module, and re-run. Do not "fix" a warning by deleting the words the user asked for, and never by shrinking a font below `theme.sizes.caption`.
  • `--strict` on the final build is the release condition: `node <engine>/cli.js deck.js out.pptx --strict`.
  • **Read the `fonts` line and do not ignore it.** `Microsoft YaHei · no face files: wrap is estimated`
    means the wrap was computed from fallback metrics, not from the real face: the line count — and
    therefore every block placed under that text — is an estimate, and `--strict` does **not** fail
    on it. A page whose text sits tight against its box is a suspect page: give such a box slack, or
    break the line yourself with an explicit `\n`, and re-render. Installing the face makes the
    measurement exact; nothing on this machine can tell you how PowerPoint will break the same line.
  • **To make that uncertainty fatal, add `--require-face-metrics`.** The build then fails with
    `FONT_UNMEASURED` unless at least one measurement came from a real face. Point the theme at the
    file to make it pass: `theme.fontFiles = { 'Microsoft YaHei': 'C:/Windows/Fonts/msyh.ttc' }` —
    a `.ttc` collection is fine — and the `metrics` line turns into
    `fontkit: 74 of 74 measurements used real faces`. `--report` carries the same fact as
    `fontsEstimated` for anything that reads JSON.

**Step 4.7 — look at it.** A deck that passes the gates can still look wrong.

```bash
python <engine>/scripts/render_check.py out.pptx --output-dir render/    # LibreOffice → PDF → PNG
python <engine>/scripts/preview_deck.py out.pptx --output-dir preview/ --sheet preview/sheet.png
node <engine>/scripts/audit_deck.js out.pptx --min-text-shapes 0         # object census per page
python <engine>/scripts/verify_native_ooxml.py out.pptx                  # schema / enumerated values
```

`render_check.py` writes one PNG per page — **open them with your image tool and look**, page by page, before you report anything. The census tells you a page is objects; only your eyes tell you it is a good page. If a page is empty in the bottom third, has two blocks fighting for the same band, or has a photo cropped through someone's face, fix it and re-render.

═══════════════════════════════════════════════════════════════════════
Only when the user requested a pptx file. If the user did not, give a summary and stop.
═══════════════════════════════════════════════════════════════════════

There is no export step: `out.pptx` **is** the deliverable, written by the engine from the spec you committed. Confirm it and report:

```bash
ls -lh <work_dir>/deck/out.pptx
```

Then report to the user: the `.pptx` path, the page count, and the spec files (`deck.js`, `theme.js`, `slides_brief.json`, the `slide_NN.js` pages) that regenerate it byte for byte. If a page was rendered, say which PNGs you looked at.

═══════════════════════════════════════════════════════════════════════
MULTI-ROUND EDITING — keep `slides_brief.json` in sync
═══════════════════════════════════════════════════════════════════════

When you only need to edit several pages, read and edit those page modules directly. When the change is deck-wide (palette, type scale, spacing), edit `theme.js` first and rebuild — never touch twenty pages to change one colour.

Very important: keep only ONE version of each page module in `deck/`. Do not keep `slide_03_v2.js`, do not keep two decks side by side.

Very important: when adding or deleting a page, edit `slides_brief.json` first.
`slides_brief.json` is the single source of truth for the deck's structure. Slide ORDER is the order of entries in `slides[]` — there is no `position` / index field, so adding / removing / reordering NEVER requires renumbering. Whenever a follow-up edit ADDS or REMOVES a page, update the brief in the SAME turn — never let on-disk modules and the brief diverge.

  • Add a page → create the module (any stable filename such as `slide_NEW1.js`) AND insert a matching entry into `slides_brief.json.slides[]` at the desired position, AND append it to `deck.js`'s `slides` array at that position.
  • Remove a page → delete the module, remove its entry from the list, remove it from `deck.js`.
  • Reorder → move entries within `slides[]`, reorder `deck.js`, do NOT rename files.

In-place content tweaks only need a brief update if the change is large enough that the old `task_brief` no longer describes the page (different headline, new photo, layout switched). Typo fixes do not.

═══════════════════════════════════════════════════════════════════════
NATIVE QUALITY BAR (applies to every page)
═══════════════════════════════════════════════════════════════════════

  • **Exact canvas: 13.333 × 7.5 in** (`pageSize: 'wide'`). Nothing outside it; `--strict` must pass.
  • **Real content density: every page carries 60–120 words of substantive text** — no placeholders, no lorem ipsum, no "insert data here".
  • **Exactly the chosen palette on every page.** Every colour comes from `theme.colors.*`; background/primary/accent must match `slides_brief.json.design.palette`.
  • **Every text colour on every background passes WCAG AA (4.5:1).** Test the accent on the background before you use it for body copy; accents are for rules, labels and figures, not for paragraphs.
  • **Native objects only.** Text is a `text` element (one run per style, `a:t` in the file). A table is `a:tbl`. A chart is a chart part with an embedded workbook. A picture is a `p` picture with real bytes. **A page rendered as an image is a failed page** — no screenshot of a layout, no base64, no "just this once".
  • **Typography comes from the theme's scale.** Title / heading / body / caption only; no invented sizes, no font below `caption`.
  • **Diversify layouts across pages** — cover, section header, split text+image, bento grid, KPI row, timeline, comparison, chart, table, quote, closing. Never repeat the same layout back-to-back.
  • **Never fabricate.** No invented statistics, no invented URLs, no invented image paths. A number you did not find is a number you do not show.
  • **Photos are Unsplash, downloaded, attributed.** Credit line on the page (`Photo: <name> / Unsplash`), full credit in `slides_brief.json.credits`.
  • **No icons font, no SVG flowchart, no connector spaghetti, no code-drawn map, no decorative timeline drawn from a hundred little shapes.** A diagram is either a component (`processFlow`, `timeline`) or it does not belong on the page.
  • **Numbers, dates and technical terms** render in the numeric face the theme declares; don't let a Chinese body face set a column of figures if the theme has a Latin pair.
  • **Headers and footers are OPTIONAL, not mandatory.** Add a page header/footer (deck title, page number, brand mark, footnote bar) only when the user asked.
  • **Speaker notes go to `notes`**, never onto the canvas.

═══════════════════════════════════════════════════════════════════════
GENERAL RULES
═══════════════════════════════════════════════════════════════════════

  • Batch aggressively. Prefer 1 turn with 5 tool calls over 5 turns with 1 tool call each.
  • Parallelism is free — Bocha searches, Unsplash calls, `web_fetch`,
    and the fan-out of `Agent` sub-agents all run concurrently when emitted in the same turn; use it.
  • **Never claim a check passed without running it, and never say a page looks right without having
    opened its PNG.** Report what you measured: page count, warning count, the gates you ran.
  • Always respond in the user's language.

## Editing an existing PowerPoint presentation（pptx）

Pick the approach by what you're editing:

- **Approach A — `python-pptx` script** — preferred for text replacement, deleting/reordering slides, and any edit that should preserve fonts/colors/layout. Simpler and safer than raw XML for content swaps.
- **Approach B — raw OOXML** — required for animations, transitions, comments, speaker notes XML, theme tweaks, custom layout edits — anything `python-pptx` can't reach.

### Approach A — `python-pptx` text replacement (preferred for text edits)

**Workflow**

1. **Inventory the deck** — walk every slide, recurse into GROUP shapes (`shape_type == 6`), `print(repr(para.text))`. Use the inventory as the source of truth for replacement keys; rendered text often contains hidden chars that won't survive copy-paste.

2. **Helpers** — keep the build script short:

   ```python
   from pptx import Presentation
   from pptx.enum.text import MSO_AUTO_SIZE
   from pptx.oxml.ns import qn
   from pptx.util import Emu, Pt

   def iter_text_frames(shapes):
       for s in shapes:
           if s.shape_type == 6:                 # GROUP → recurse
               yield from iter_text_frames(s.shapes)
           elif s.has_text_frame:
               yield s, s.text_frame

   def _norm(s):                                  # strip soft breaks before matching
       return s.replace("\x0b", "").replace("\r", "").strip()

   def replace_in_paragraph(p, new_text):         # first-run replace preserves formatting
       runs = p.runs
       if not runs:
           p.add_run().text = new_text; return
       runs[0].text = new_text
       for r in runs[1:]:
           r._r.getparent().remove(r._r)

   def apply_replacements(tf, mapping):           # full-frame match, then per-paragraph
       m = {_norm(k): v for k, v in mapping.items()}
       full = "\n".join(p.text for p in tf.paragraphs)
       if _norm(full) in m:
           parts = m[_norm(full)].split("\n")
           for i, p in enumerate(tf.paragraphs):
               replace_in_paragraph(p, parts[i] if i < len(parts) else "")
           return
       for p in tf.paragraphs:
           if _norm(p.text) in m:
               replace_in_paragraph(p, m[_norm(p.text)])

   def delete_slide(prs, idx):                    # call high-index first
       sld = list(prs.slides._sldIdLst)[idx]
       prs.part.drop_rel(sld.get(qn("r:id")))
       prs.slides._sldIdLst.remove(sld)
   ```

**Budget every shape BEFORE generating replacement text (do this first)**

Most overflow bugs come from generating copy without knowing the target box's capacity. Before drafting any replacement, walk the deck once and emit a capacity manifest — then feed it to the content step as a hard constraint.

For each text-bearing shape collect: `slide_idx, shape_id, w_cm, h_cm, font_pt, orig_text, orig_len`. Derive:

- `chars_per_line ≈ w_cm / (font_pt × 0.014)` for CJK; multiply by ~2 for Latin. Mixed text: weight by character class.
- `lines ≈ h_cm / (font_pt × 0.0185)` (line-height ≈ 1.3).
- `budget = min(chars_per_line × lines, orig_len × 1.1)`. The template designer already tuned `orig_len` for readability — treat it as the ceiling, not a starting point.
- `role = "label"` if `h_cm < 1.5` OR `orig_len ≤ 8` OR `font_pt ≥ 20`; else `"body"`.

Rules the generation step MUST obey:
- **Label boxes**: short phrase only. No full sentences, no trailing punctuation, no "term + explanation" expansion. Hard cap = `max(orig_len, 8)`. SWOT tiles, timeline tags, KPI labels all fall here.
- **Body boxes**: stay within `budget`. Font size is inherited from the template; shrinking is a last resort, not plan A.
- If the content is genuinely longer and the layout permits, **grow the box itself** (`widen_to_fit(shape, Emu(...))` — see below) rather than shrinking the font. Check first that `left + width` won't collide with the next shape.

**Handling long replacement / unwanted wrapping after replacement**

When a longer replacement wraps to a new line, apply remedies in this order (cheapest first):

```python
def widen_to_fit(shape, max_grow_emu=Emu(0)):
    """Let PowerPoint size the shape to its text. Pass max_grow_emu>0 to also
    grow the explicit width (centered on the original position) before sizing."""
    if max_grow_emu:
        shape.left -= max_grow_emu // 2
        shape.width += max_grow_emu
    shape.text_frame.word_wrap = True
    shape.text_frame.auto_size = MSO_AUTO_SIZE.SHAPE_TO_FIT_TEXT

def shrink_text_to_fit(shape):
    """Keep the box fixed; let PowerPoint shrink the font to fit."""
    shape.text_frame.word_wrap = True
    shape.text_frame.auto_size = MSO_AUTO_SIZE.TEXT_TO_FIT_SHAPE
```

1. **Budget first (preferred).** Check `shape.width` × `font_size` from inventory and trim the replacement so it fits the original visual budget. Numeric badges / small label boxes (`width ≤ 0.7"`, `font_size ≥ 16pt`) hold ~3–4 chars max.
2. **Widen the shape** with `widen_to_fit(shape, Emu(...))` when the content is genuinely longer and there's free space next to it. Always check the shape isn't going to collide with a neighbor first (compare `left+width` against the next shape's `left`).
3. **Shrink the font** with `shrink_text_to_fit(shape)` only for tight-layout boxes (table cells, numeric badges) where widening would break the grid. Last resort — it visibly breaks the typographic rhythm.

Skip `word_wrap = False`: it makes text overflow the box invisibly in PowerPoint and looks broken when exported.

**Critical gotchas**

- **Soft line breaks (`\x0b`)** silently break exact-match. Always `_norm()` both keys and lookups.
- **GROUP shapes** (`shape_type == 6`) hide text frames — recurse.
- **First-run replace** preserves formatting; `paragraph.text = ...` destroys it.
- **Short tokens collide.** `"01"`, `"%""`, `"18"` recurse across slides — keep identity mappings or scope per slide index, never global cross-mappings like `"18": "12"`.
- **Delete slides high-index first** — deleting index 5 first shifts every later index down by one.

### Approach B — raw OOXML

For anything `python-pptx` cannot reach: unpack with `ooxml/scripts/unpack.py`, edit the part, repack with `ooxml/scripts/pack.py`. Re-open the result with the engine's checker before handing it over:

```bash
python <engine>/scripts/verify_native_ooxml.py edited.pptx     # schema + enumerated values
python <engine>/scripts/render_check.py edited.pptx --output-dir render/edited
```

A part that opens in LibreOffice can still be a part PowerPoint offers to repair — say so rather than claiming the edit is verified.

## Code Style Guidelines

**IMPORTANT**: When generating code for PPTX operations:

- Write concise code
- Avoid verbose variable names and redundant operations
- Avoid unnecessary print statements
- In a page module, one element per intent, and `theme.*` for every value

## Dependencies

Required dependencies (should already be installed):

- **markitdown**: `pip install "markitdown[pptx]"` (text extraction)
- **python-pptx**: `pip install python-pptx` (editing an existing deck, and the third-reader check)
- **LibreOffice**: `sudo apt-get install libreoffice` (PDF conversion, for `render_check.py`)
- **Poppler**: `sudo apt-get install poppler-utils` (`pdftoppm`)
- **Pillow**: `pip install pillow` (rasterising the PDF to PNG; `preview_deck.py`)
- **defusedxml**: `pip install defusedxml` (secure XML parsing)
- **The engine's own node dependencies** are vendored in `<engine>/package.json`
  (`pptxgenjs`, `jszip`, `fontkit`, `image-size`): `cd <engine> && npm install`.
  `playwright`, `sharp` and `react-icons` are **no longer needed** — nothing renders HTML.

Environment:

- `BOCHA_API_KEY` — Bocha Web Search (stage 2). No key, no search: ask the user.
- `UNSPLASH_ACCESS_KEY` — Unsplash (stage 2). No key, no photo: ask the user.

---

## Appendix — the engine contract

Read this once before writing your first spec. The authority is `<engine>/core/schema.js` (`validateDeck`); when this appendix and the code disagree, the code wins and this appendix is a bug.

### Commands

| command | what it does |
| --- | --- |
| `node <engine>/cli.js <spec> [out.pptx]` | validate, lay out, write |
| `--out <file>` | where to write (default: beside the spec) |
| `--report <file>` | census, warnings, font situation, dropped pictures, as JSON |
| `--layout-out <file>` | every box the writer actually used (for the fit gate) |
| `--check` | validate and stop; writes nothing |
| `--strict` | layout warnings become failures (release condition) |
| `--require-face-metrics` | also fail (`FONT_UNMEASURED`) when the wrap came from an estimate, not a real face |
| `--json` / `--quiet` | machine-readable stdout / errors only |

Exit codes: `0` written · `1` spec rejected (nothing written) · `2` writer failed.

### The spec

```json
{
  "title": "deck title", "author": "…", "language": "zh-CN",
  "pageSize": "wide",
  "theme": { "colors": { "primary": "183B3A", "accent": "D36B45" },
             "fonts": { "heading": "Microsoft YaHei", "body": "Microsoft YaHei" },
             "sizes": { "title": 34, "heading": 20, "body": 14, "caption": 10 } },
  "slides": [
    { "background": "FFFFFF", "notes": "speaker notes go to the notes part",
      "elements": [
        { "type": "text", "text": "…", "x": 0.9, "y": 0.7, "w": 11, "h": 0.6, "fontSize": 28, "bold": true },
        { "type": "shape", "x": 0.9, "y": 1.5, "w": 11.4, "h": 0.02, "fill": "DCE2DE", "line": false }
      ] }
  ]
}
```

- `pageSize`: `wide` (13.333 × 7.5) · `standard` (10 × 7.5) · `{ "width": …, "height": … }`.
- Positions and sizes are **inches**; colours are hex **without `#`**; fonts are family names.
- `text` may be a string **or an array of runs** (`"…"` or `[{ "text": "A", "options": { "bold": true } }, "B"]`) — that is how one paragraph holds mixed styling.
- `notes` on a slide becomes the notes part; it never appears on the canvas.

### Elements

| element | written as | notable fields |
| --- | --- | --- |
| `text` | text box with runs | `text` (string or run array), `x/y/w/h`, `fontSize`, `fontFace`, `bold`, `italic`, `color`, `align`, `valign`, `lineSpacing`, `lineSpacingMultiple`, `charSpacing`, `bullet`, `transparency` |
| `shape` | `p:sp` | `fill`, `gradient`, `lineColor`, `lineWidth`, `radius`, `shadow`, `rotate`, `transparency`, `hyperlink` |
| `line` | connector | `color`, `width`, `dash`, `beginArrowType`, `endArrowType` |
| `image` | `p:pic` | `path` (relative path, or `data:` a URI — `src` is NOT a field), `fit` (`cover`/`contain`/`crop`/`fill`/`none`/`scale-down`), `crop`, `focus`, `radius`, `outline`, `shadow`, `tile` |
| `table` | `a:tbl` | `rows` (`[["a","b"]]` or `[[{ "text": "a", "options": {…} }]]`), `colW`, `rowH`, cell `rowspan`/`colspan`, `fill`, `border`, `valign`, `bullet` |
| `chart` | `c:chart` + embedded `.xlsx` | `chartType` (`bar`/`line`/`pie`/`doughnut`/`area`/`radar`/`scatter`/`bubble`), `data` (`[{ name, labels, values }]`), `options` (`showLegend`, `legendPos`, `showValue`, `dataLabelPosition`, `chartColors`, `gridlines`, `seriesLineStyles`, …) |
| `container` | declarative grouping | `layout` (`flow`/`grid`/`flex`), `children`, `gap` / `rowGap` / `columnGap` / `crossGap`, `padding`; a child may declare `columnSpan` / `rowSpan` |

### Design system

`templates.*` describes a whole page from content fields: `cover`, `hero`, `content`, `kpi`, `comparison`, `process`, `editorial`.
`components.*` gives the pieces: `title`, `paragraph`, `divider`, `kpiCard`, `infoCard`, `processFlow`, `timeline`.

```js
const { templates, components, resolveTheme } = require('<engine>');
const page = templates.kpi({ theme, title: '…', items: [{ label, value, note }] });
page.elements.push(...components.infoCard({ theme, x, y, w, h, title, body }));
```

The worked example is `<engine>/../examples/native_deck_spec.js` (six pages, four templates, a native chart, a table, notes) and, for a pure-JSON deck, `<engine>/../examples/native-cover.spec.json`.

### Gates you can run yourself

| gate | command |
| --- | --- |
| unit + lint | `npm test` (inside `<engine>`) |
| visual golden (7 decks / 35 pages) | `python <engine>/scripts/visual_golden.py` |
| text fit (measured vs drawn) | `python <engine>/scripts/check_all_text_fit.py` |
| stress (N generated pages) | `node <engine>/scripts/stress_spec.js --slides 40 --seed 7` |
| OOXML integrity | `python <engine>/scripts/verify_native_ooxml.py <deck.pptx>` (`uneven_tables` counts tables whose column widths differ — a design feature, not a defect; `invalid_enums` and `integrity_problems` must both be 0) |
| object census | `node <engine>/scripts/audit_deck.js <deck.pptx> --min-text-shapes 0` |
| third reader | `python <engine>/scripts/verify_with_python_pptx.py --deck <deck.pptx> --round-trip` |

### What the engine will not draw (say so, do not fake it)

`<engine>/LIMITS.md` is generated from the writer's own refusals — read it, and when a design needs something in it, tell the user instead of approximating:

- A tiled fill (`a:tile`) is written correctly but only PowerPoint tiles it; LibreOffice and WPS draw one stretched cell.
- Line-spacing percentages (`a:spcPct`) are computed against each reader's own font metrics, so line counts can differ by one between readers.
- Per-series dash rhythms need an outline colour, or the dash draws nothing.
- Per-run `text-transform`, per-series marker rhythms, right-to-left runs, and a list marker inside a table cell are not implemented.
- Speaker-notes fidelity beyond plain text, animations and transitions are out of scope — this engine writes static, editable content.
- Whether a file triggers PowerPoint's repair prompt cannot be decided on a machine without PowerPoint: `verify_native_ooxml.py` says the part is well-formed, which is the strongest claim available here.
