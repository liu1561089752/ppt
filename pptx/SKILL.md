---
name: ppt
metadata:
  author: Z.AI
  version: "1.0"
description: "Presentation creation, editing, and analysis for .pptx files: (1) Creating new presentations, (2) Modifying or editing content, (3) Working with layouts, (4) Adding comments or speaker notes. Academic/paper-based presentations use the embedded Beamer module at end of this file (PDF output only)."
license: Proprietary. LICENSE.txt has complete terms
---

# PPT creation, editing, and analysis

## Overview

A user may ask you to create, edit, or analyze the contents of a .pptx file. A .pptx file is essentially a ZIP archive containing XML files and other resources that you can read or edit. You have different tools and workflows available for different tasks.

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

---
## Creating a new PowerPoint presentation **without a template**(most case,creating ppt/pptx from scrach)

When user upload pptx and ask for to use it as template ,do not follow this section routine! follow ## Editing an existing PowerPoint presentation（pptx）instead
### Renderer selection — highest-priority rule

For **new presentations**, use **Native PowerPoint mode by default**. Do not create HTML slide files and do not run `batch_html2pptx.js` for a new deck unless the user explicitly requests HTML output or needs exact reproduction of an existing HTML/CSS slide source that the native components cannot represent.

Native workflow:
1. Keep the content work in Stages 1–3 below: clarify the brief, research, build the story, and plan slide-by-slide design.
2. For a reference PPTX, run `python pptx/scripts/extract_native_design.py <reference.pptx> <design_dir>` and use its design tokens and geometry patterns. For an HTML/CSS design reference, run `python pptx/scripts/extract_html_design_tokens.py <reference.html-or-css> <design_dir>`, inspect `theme.json` and `design-tokens.json`, and use the reviewed theme as `deck.theme`. Keep `source.css` as the fidelity reference; token extraction is best-effort, not a full CSS renderer.
3. Create a structured Deck Spec (JSON-compatible data) with ordered slides and semantic elements. Treat the visual design as a first-class input: preserve the reference's palette, typography, spacing rhythm, hierarchy, card treatment, image composition, and distinctive layout patterns. Pass the shared theme into templates/components rather than relying on their defaults. Do not reduce expressive source designs to generic title-plus-divider slides. Use native text, shapes, tables, charts, and connectors for editable content; use SVG/image assets selectively for complex illustration, texture, or browser-only effects—not as a rasterized full-slide substitute.
3a. Prefer expressive Native layout patterns where they fit the story: `templates.hero()` for asymmetric launch/cover pages and `templates.editorial()` for evidence-led two-column pages. These templates consume the shared theme, including extracted gradient/shadow tokens when present; they remain editable shapes and text rather than flattened slide images.
4. Generate with `require('./pptx/native').generatePptx(deck, outputPath)`, or use `pptx/batch_native_pptx.js` for multiple JSON Deck Specs.
5. Inspect the generation report, run the CI-equivalent LibreOffice render check, and review the PDF/PNG previews for wrapping, overflow, missing fonts, object collisions, and visual hierarchy. Report any unresolved warnings.
6. Keep speaker notes in the Deck Spec slide's `notes` field; the Native renderer writes them to the PowerPoint notes part.

Use the HTML compatibility workflow below only for existing HTML slide projects, explicit HTML deliverables, or visual effects not yet supported by Native components. Changing renderers must not mean discarding the original design language: when migrating an HTML reference to Native, carry forward the extracted theme and manually translate important CSS compositions/effects into editable PowerPoint elements or targeted vector assets. Existing PPTX template editing follows the dedicated editing section.

You are an elite presentation design agent. You produce beautiful, content-rich, editable PowerPoint decks. Native PowerPoint objects are the default output for new presentations; standalone HTML pages are the compatibility path for legacy HTML slide sources.

You operate in four strict stages. Do NOT skip or reorder stages.

═══════════════════════════════════════════════════════════════════════
STAGE 1 — CLARIFY (collect mandatory inputs via `AskUserQuestion`)
═══════════════════════════════════════════════════════════════════════

**Step 0 — Reference detection (run BEFORE asking any question).**

For a reference `.pptx` intended to guide the look of a new Native deck, run `pptx/scripts/extract_native_design.py` and inspect `design.json`, `layout_patterns.json`, `component_patterns.json`, and `font_config.json`. Do not route a PPTX reference through the HTML/CSS extractor unless the user specifically asks for HTML output.

Before invoking `AskUserQuestion`, look at the user's upload directory and
the user's prompt for a single reference asset. The case below is
auto-handleable; run the matching extraction script first,
write the result into `<work_dir>/slides/`,the <work_dir> is directly the download directory
then SKIP the palette and typography questions in the list below (the user has implicitly answered
them by handing you the reference). Still ask the remaining questions.

  • **HTML/CSS reference** (`*.html` or `*.css` containing the desired deck-wide style):
      ```
      python pptx/scripts/extract_html_design_tokens.py <reference.html-or-css> <work_dir>/slides/design-tokens
      ```
      Inspect `theme.json`, `design-tokens.json`, and `source.css`. Apply the reviewed `theme.json` values to the Native Deck Spec's `theme` field. This extracts reusable tokens; it does not promise pixel-identical recreation of arbitrary CSS layouts, gradients, filters, or animations.

  • **Legacy HTML source** (`*.html` containing the desired deck-wide style):
      ```
      python /home/z/my-project/skills/ppt/scripts/extract_html_style.py \
          <reference.html> <work_dir>/slides
      ```
      Writes `<work_dir>/slides/global.css` by concatenating every
      `<style>...</style>` block from the source HTML verbatim. The
      generated slides will reuse those CSS variables and class names
      directly. After running this, `slides_brief.json.design` should
      record `reference: "imitating <reference.html>"` and the model
      should NOT redefine the palette/typography in `global.css`.

If neither reference exists, proceed to the questions below as normal.

**Step 1 — Ask the user.** Before doing anything else (after Step 0),
collect the user's explicit choices on the dimensions below.
**These are mandatory inputs — do NOT silently default any of them**,
even when the user's request hints at one. Explicit confirmation
prevents wrong-style decks and saves whole re-renders later.

Mandatory dimensions — ask between 4-6 questions(not exceed 6 questions) across the 10 items below.
Items marked **★** are strictly mandatory (palette, typography, per-page detail);
the rest should be asked unless the user's original request explicitly rules
them out (e.g. "internal deck, no notes" → skip notes question).

  1. **主题与目的 (Topic & purpose)** — the deck's core theme and the main
     aspects it should showcase. Ask this FIRST — every downstream choice
     (length, layouts, data) hinges on it, so do not let it be implicit.
  2. **目标受众 (Audience & tone)** — who is this for, what register.
  3. **篇幅 (Deck length)** — tight range. like 1–8 / 8–12 / 12以上 slides，you must give user short slides choice.
  4. **风格与基调 (Style & tone)** — the deck's overall voice as ONE preset:
     商务 (business) / 简约 (minimal) / 正式汇报 (formal report). This is the
     high-level register; the palette and typography questions below refine
     it into concrete colors and fonts.
  5. **Visual reference** — a recognizable style anchor (one or two named
     reference decks / websites the user wants this to feel like).
  6. **★ Palette (调色盘)** — ONE question that collects **all three** of
     `background` / `primary` / `accent` together (as a unified palette
     choice). Do NOT split into three separate questions. The options the
     user picks from must be generated at runtime — do not hard-code
     specific colors or hex codes here in the skill.
  7. **Speaker notes (备注讲稿)** — none / short bullet hints / verbatim full script.
  8. **已有素材 / 数据来源 (Existing materials / data sourcing)** — 用户是否
     已提供素材或数据;是否需要在最终页面标注数据来源 (是 / 否)。
  9. **Must include data**
  10. **Need image search**
Important constraints when constructing the actual `AskUserQuestion` calls:
  • **Think carefully before asking.** Before each `AskUserQuestion` call,
    spend real reasoning on the user's domain, audience, and visual
    reference (Q1 / Q4). The point of asking is to surface CHOICES — so
    the choices you offer must themselves be a creative, well-considered
    design proposal. Generic "Light / Dark / Other" is a failure mode.
  • **Each option must be a concrete creative direction**, not a category
    label. For the palette question that means each option names a coherent
    trio (background + primary + accent) tuned to the user's topic — e.g.
    a finance deck and a children's-book pitch should NEVER see the same
    three palette options. Same rule for typography: each option proposes
    a specific heading + body pairing that fits the deck's voice.
  • **Mark your recommendation.** In every question, pick ONE option that
    you genuinely believe is the strongest fit and put it FIRST, with the
    suffix `(Recommended)` appended to its `label`. Use this for palette,
    typography, per-page detail level, and visual reference — anywhere the
    answer materially shapes the deck. Do NOT mark more than one option as
    recommended per question.
  • The palette question is a SINGLE question whose options each describe
    a coherent (background + primary + accent) trio. The user picks one
    trio, or chooses "Other" to provide their own three colors.

How to dispatch the questions:
  • `AskUserQuestion` carries 4-6 questions per call. 
  • Each question: a short `header` (≤12 chars), the `question` itself, and
    3–4 `options` (each with `label` + short `description`). The user can
    always pick "Other" for free-text custom input.
  • Do NOT call any other tool in the same turn as `AskUserQuestion`.
  • Do NOT proceed to Stage 2 until every mandatory dimension has been
    answered. Once answered, the palette / typography / detail-level
    choices flow directly into `slides_brief.json.design` and the per-slide
    `task_brief` in Stage 3 — they MUST match exactly.

═══════════════════════════════════════════════════════════════════════
STAGE 2 — RESEARCH (parallel web search + page visits + parallel image search)
═══════════════════════════════════════════════════════════════════════
Gather facts and visual assets.

Text research:
  • Use `web_search` function for up-to-date facts(if the user do not provided). Batch 2-3 queries across parallel calls in one turn.
      ```bash
    # Simple search query
    z-ai function --name "web_search" --args '{"query": "artificial intelligence","num": 3}'

    # Using short options
    z-ai function -n web_search -a '{"query": "cryptocurrency news", "num": 3, "recency_days": 7}'
    ```


Image assets (THIS IS IMPORTANT):
  • For EVERY slide that needs a photo or illustration, run the `z-ai image-search` CLI (provided by `z-ai-web-dev-sdk`). Prerequisite: `npm install -g z-ai-web-dev-sdk` (or `bun add -g z-ai-web-dev-sdk`), which installs the `z-ai` binary.
  • Basic invocation:
        z-ai image-search --query "<natural-language sentence>" --count 3
    The CLI prints the JSON response (pretty-formatted) to stdout(--count control the image number return,use 5 by default). The query MUST be a natural-language sentence (NOT keywords). The response contains `results[].original_url` (OSS-hosted, embeddable) and `results[].caption`.
  • **Output handling — print-to-stdout only.** pick the best `original_url`, and **bake that URL directly into the slide's `task_brief`** in `slides_brief.json` (see Stage 3). The sub-agent that renders the slide has no access to the search results, so the URL MUST be inlined into `task_brief` — that is the only carrier.
  • Very important!!! if you want to use local image, YOU MUST use RELATIVE path rather than absolute path
  • You MAY emit several `Bash` calls in the SAME assistant turn — they will run concurrently. Prefer batching 3–4 image searches per turn to save wall time.
  • HARD LIMIT: invoke the image-search CLI at most 6 times total across the whole trajectory. Plan your image needs up front and reuse returned URLs across multiple slides where appropriate.
  • If anything goes wrong (e.g. `Unknown command "image-search"`, auth errors, empty results, region tuning, `--no-rank` for speed) consult the image-search skill — it documents every flag, the full response schema, and the standard troubleshooting matrix.

═══════════════════════════════════════════════════════════════════════
STAGE 3 — PLAN (commit design as files on disk before fan-out)
═══════════════════════════════════════════════════════════════════════
After research, commit the deck design(global css) and slide brief(slides_brief.json) to disk so the build stage and every sub-agent share the SAME source of truth.

**Step 3.0 — After `Reasearch` succeeds**, in a SINGLE assistant turn, use `Write` to create:

**`<work_dir>` definition (MANDATORY)**: `<work_dir>` IS the user's `download/` directory itself. Do NOT create an intermediate themed/topic-named subdirectory (e.g. `download/theme_ppt/`, `download/<topic>/`). The slides folder must end up at `download/slides/`, NOT `download/<anything>/slides/`. Every `<work_dir>/...` path in this skill resolves under `download/` directly.
You should first create a directory '<work_dir>/slides' to keep the produced files
**Directory layout (MANDATORY)**: `global.css`, `slides_brief.json`, AND every `slide_NN.html` MUST all live under the SAME single directory `<work_dir>/slides/` (i.e. `download/slides/`). Do NOT place `global.css` or `slides_brief.json` at `<work_dir>/` root, do NOT split slides into per-section subfolders, and do NOT create an `images/` subfolder — image-search results are NEVER written to disk; the picked `original_url` is inlined directly into each slide's `task_brief` (see Stage 2). The flat-under-`slides/` layout is what every sub-agent assumes when it reads the brief and resolves the `<link rel="stylesheet">` href.

Final on-disk layout after Stage 3:
```
<work_dir>/slides/
├── global.css
├── slides_brief.json
├── slide_01.html        ← written in Stage 4 by sub-agents
├── slide_02.html
└── ...
```

1. `<work_dir>/slides/global.css` — the deck-wide stylesheet that EVERY slide will `<link>` into its `<head>`. Bake in:
     • You must use the font size /font style/color in the global.css, do not redefine it in each html
     • CSS variables for the chosen palette: `--bg`, `--primary`, `--accent`, plus any tonal stops you need.
     • `@import` lines for the chosen Google Fonts and a `:root` typography scale (title / subtitle / body / footnote sizes — see SLIDE QUALITY BAR).
     • Reusable utility classes for the slide canvas (e.g. `.slide { width:1280px; min-height:720px; overflow:hidden; padding:64px; background:var(--bg); }`), card surfaces, and accent emphasis.
     • NO per-slide layout CSS — that lives inside each slide's HTML. Keep this file under ~150 lines.
     • Avoid CSS class collisions with Tailwind utilities
          When the slide loads Tailwind via <script src="https://cdn.tailwindcss.com">, the CDN injects its utility styles into <head> after your <link
          rel="stylesheet">. Custom classes that share a name with a Tailwind utility lose the cascade (same specificity, Tailwind comes later) and get silently
          overridden.
          Critical example: Do not name heading classes .h-1 / .h-2 / .h-3. In Tailwind these are height utilities (.h-1 = 4px, .h-2 = 8px, .h-3 = 12px). Applied to
          a heading, the box collapses to a few pixels while the text still renders at full size — the heading visibly overlaps the element below it.
     • Because `global.css` and the slide HTMLs are siblings inside `<work_dir>/slides/`, slides may link it as `<link rel="stylesheet" href="global.css">` (relative). 
     • keep these in mind！！！ Global CSS scope — typography tokens only, no typography classes.Define typography design tokens (--font-heading, --font-body, --font-cn, --font-num, --fs-display, --fs-h1, --fs-h2, --fs-h3, --fs-body, --fs-small, --fs-micro) on :root in
      global.css Do not ship pre-baked typography classes like .h-display / .h-1 / .h-2 / .h-3 / .cn-sub that bundle font-family, font-size, line-height,font-weight, and letter-spacing together. (This rule applies only to font family / size — palette, spacing, layout primitives, and other non-typography utilities can stilllive in global.css as before.) keep these in mind！！！

2. `<work_dir>/slides/slides_brief.json` — the dispatch manifest. Schema:
     ```json
     {
       "design": {
         "title":"(ppt title)",
         "style_name": "...",
         "palette": {"background": "#...", "primary": "#...", "accent": "#..."},
         "typography": {"heading": "xx", "body": "xx", "numeric": "xx"},
         "reference": "Apple keynote / The Verge / ..."
       },
       "global_css_path": "<absolute path to <work_dir>/slides/global.css>",
       "slides_dir": "<absolute path to <work_dir>/slides>",
       "language": "zh|en|bilingual",
       "speaker_notes": "none | short | full",
       "slides": [
         {
           "title": "...",
           "layout": "cover",
           "output_path": "<absolute path to <work_dir>/slides/slide_XX.html>",
           "task_brief": "Self-contained brief — see rules below."
         },
         ...
       ]
     }
     ```
   • Slide ORDER is the order of entries in the `slides` array — no `position` / index field. To reorder a deck, reorder the list.
   • Every slide MUST have `title`, `layout`, `output_path`, `task_brief`.
   • `output_path` is the ABSOLUTE path the slide HTML will be written to. Filenames are arbitrary stable identifiers (e.g. `slide_01.html`, `slide_02.html` at first creation) — they live in the same directory as `global.css` and `slides_brief.json`, but their alphabetical order does NOT define slide order. Once assigned, do NOT rename a slide's file when reordering or inserting; keep the filename stable and just move its entry in the list.
   • `layout` MUST be chosen per page from a coherent catalog (cover, section header, key message, bento grid, split text+image, timeline, stats, comparison, quote, closing, etc.). Diversify layouts across pages — do NOT reuse the same layout for consecutive slides.
   • Section structure for longer decks: once the deck gets long (roughly **≥10 pages**), split the body into 2–5 named chapters with a `section header` page at the start of each. A reasonable rhythm is 3–6 content pages per chapter; if a stretch goes past ~7 pages without a break, that's a hint another section header would help. Section-header `task_brief` typically carries: chapter number ("01 / 03"), chapter title, one short tagline; no body bullets, no images. For shorter decks, only add a section header if the content has a strong narrative break.
   • `task_brief` is the SOLE input the sub-agent will see for that slide — it MUST be self-contained for the renderer. 
       – Keep it concise and to the point: carry exactly what the renderer needs, no filler, no restating the design block, no meta reminders.
       – Restate the slide's exact text content: headline, body copy, data points, stats, quotes, key phrases. Copy verbatim — do not paraphrase loosely.
       – Resolve every "Hero photo of …" / "icon of …" reference into the FULL image URL (https://…) from your `z-ai image-search` results. The sub-agent has NO access to search results — if a URL isn't in the brief (either inlined here or read back from a saved `images/<slot>.json` manifest), the slide can't display the image.
       – If the user asked for speaker notes in Stage 1, append a `Speaker notes:` block at the END of the brief. write the notes request. do NOT write notes verbatim here. The top-level `speaker_notes` field (`none` / `short` / `full`) tells the sub-agent whether and how deeply to generate notes from the rendered slide. The sub-agent will inject them into the slide HTML as `<aside data-notes>…</aside>` (visually hidden). If the user did NOT request notes, omit this block — do not invent notes.
       – Add any layout-specific payload the sub-agent needs (chart data values, ordered timeline events, comparison columns, exact quote attribution, etc.). The committed `design` block (palette, typography, reference) is already in `slides_brief.json`, so do NOT repeat it inside each `task_brief`.
       – Do NOT carry meta / quality-bar reminders inside the brief: word-count targets, "diversify layouts", "no photos", "verify contrast", etc. Those live ONCE in the sub-agent's self-audit checklist (Stage 4) — repeating them per slide is noise. If the slide is image-free, simply do not include any image URL; the sub-agent will not invent one.

═══════════════════════════════════════════════════════════════════════
STAGE 4 — BUILD (LEGACY HTML COMPATIBILITY MODE ONLY — Native mode uses the renderer-selection workflow above)
═══════════════════════════════════════════════════════════════════════
every slide, cover / TOC / body / closing, is committed by a `ppt` sub-agent that calls the `Write` tool itself. The main agent NEVER calls `Write` to commit slide HTML. This keeps rendering uniformly parallel and removes any temptation to serialize work onto the main turn.

  • `Agent(subagent_type="ppt-expert", description=..., prompt=...)` — spawn a sub-agent that writes a CONTIGUOUS RANGE of slides. Use for every slide in the deck — cover, intro, data, cases, narrative chapters, closing, thank-you. Single-slide groups are fine when a section (or the cover) stands alone.

  1. Immediately after Stage 3's files are on disk, emit ALL `Agent` calls in ONE assistant turn. Everything in that turn runs concurrently — this is ~3–5x faster than sequential iteration.

  2. How to group the slides:
     • A group is a CONTIGUOUS RANGE of entries in the `slides` list (e.g. indices 0..4 in JSON order). The sub-agent reads the briefs for those entries from `slides_brief.json` and writes each slide's HTML to its `output_path` in list order — locking in a consistent layout/component language across a section.
     • Slides in DIFFERENT groups run IN PARALLEL.
     • Keep groups small (5–7 slides). Good groups follow narrative sections: cover / intro / data / cases / closing.
     • HARD CAP: at most **3 `Agent` calls per deck total**. If the body has more sections than that, MERGE adjacent sections into a single group rather than spawning a 6th. The cap is real — more groups means more sub-agent spin-up overhead AND weaker visual consistency across the deck. 
  3. Sub-agent dispatch prompt — every `Agent` call's `prompt` MUST explicitly carry these three things at the top, in this exact order:
     a) the index range (0-based, half-open) into `slides_brief.json.slides[]` the sub-agent is responsible for (`start..end`),
     b) the ABSOLUTE path to `slides_brief.json` (`<work_dir>/slides/slides_brief.json`),
     c) the ABSOLUTE path to `global.css` (`<work_dir>/slides/global.css`). directly use it in every html
     If any of the three is missing or relative, the sub-agent will fail to render. Do NOT hand-wave these as "see the brief" — write the literal absolute paths and the literal index numbers into every dispatch prompt.

     Use this exact shape for every `Agent` call's `prompt` field (substitute the bracketed values per group):

     ```
     You are a slide-rendering sub-agent. Render ONLY slides `slides[{start}:{end}]` (0-based, half-open) — do NOT touch other slides.

     First Read these absolute paths:
       • Brief manifest:    {absolute path to <work_dir>/slides/slides_brief.json}
       • Global stylesheet: {absolute path to <work_dir>/slides/global.css}
     Both live in the SAME directory ({absolute path to <work_dir>/slides/}); write each slide HTML there as a sibling.

     For each entry in `slides[{start}:{end}]`, in list order, produce one 1280x720 standalone HTML page that:
       - starts with `<!DOCTYPE html>`, ends with `</html>`, and links `global.css` via `<link rel="stylesheet" href="global.css">` in `<head>`
       - uses ONLY the palette/typography in `design`, and renders EVERY fact/headline/bullet/stat/quote/image URL in `task_brief` verbatim
       - obeys every constraint in the SLIDE QUALITY BAR (canvas, contrast, layout discipline)
       - speaker notes: if `speaker_notes` is `short`/`full`, generate notes (`short` = 3–5 bullet hints, `full` = ~80–150 word script; match deck language; cover any `notes_must_include:` points) embedded as the LAST `<body>` child `<aside data-notes class="hidden">…</aside>`. If `none`, omit it.
     Commit each slide with `Write(file_path=<output_path from brief>, content=<full HTML>)`.

     Update the worklog only once, when finished — one sentence summary per slide.
     ```

     Pass `subagent_type: ppt-expert`. If the harness reports it as unavailable, fall back to `subagent_type: general-purpose` and prepend the rendering rules from this skill into the prompt.

  4. The `Agent` tool result returns ONLY the sub-agent's textual summary(in one sentence) — it does NOT echo the HTML source. To inspect a generated slide, call `Read(file_path=<output_path>)`.

  5. Sub-agent slide HTML rules: must start with `<!DOCTYPE html>`, end with `</html>`, link `global.css`, follow the SAME design palette / typography committed in `slides_brief.json`, and obey every constraint in the SLIDE QUALITY BAR. The sub-agent must NOT echo the HTML as plain text — only the `Write` call commits the slide.


═══════════════════════════════════════════════════════════════════════
LEGACY HTML MODE ONLY — when exporting HTML slides to PPTX, use the following compatibility instructions. Native mode generates the PPTX directly from the Deck Spec and must not use this HTML export path:
═══════════════════════════════════════════════════════════════════════
Convert `<work_dir>/slides/` into ONE `.pptx` via `batch_html2pptx.js`.

The converter walks sorted filename order. Right before invoking it,
ensure filenames sort alphabetically into the same order as
`slides_brief.json.slides[]`. If editing rounds left them out of order,
rename to `slide_{NN:02d}.html` matching list index AND update each
entry's `output_path`. This is the ONLY step that renames files.
You can directly run the files，do not try to modify it
Invoke:
```
cd /home/z/my-project && NODE_PATH=/usr/local/lib/node_modules nohup node /home/z/my-project/skills/ppt/batch_html2pptx.js /home/z/my-project/download/slides /home/z/my-project/download/xx.pptx
```

  • Arg 1: slides directory. Arg 2 (optional): output path; defaults to
    `<work_dir>/<basename(work_dir)>.pptx`.
  • `NODE_PATH` is required so `pptxgenjs` / `playwright` / `sharp` resolve.
  • Per-slide warnings (`🚨 CRITICAL OVERFLOW`, `⚠ BOUNDS/FONT/OVERLAP/LAYOUT`)
    are non-fatal, but treat any `🚨 CRITICAL` as a real bug — fix the
    source HTML and re-run (the pptx is overwritten in place).

After export: `ls -lh <path>` to confirm, then report the `.pptx` path
(and source slide HTML paths) to the user.

═══════════════════════════════════════════════════════════════════════
MULTI-ROUND HTML EDITING — keep `slides_brief.json` in sync
═══════════════════════════════════════════════════════════════════════
When you only need to editing severals pages，directly read and editing them,when you need to change the entire design,try to edit global.css first
Very inportant!: Keep only one version of html slides directly in "slides/" directory,do not keep mutiple versions of html. and there is only one version of slides.
Very inportant!: when deleting or adding pages,first editing slides_brief.json first
`slides_brief.json` is the single source of truth for the deck's
structure. Slide ORDER is the order of entries in `slides[]` — there is
no `position` / index field, so adding / removing / reordering NEVER
requires renumbering. Whenever a follow-up edit ADDS or REMOVES a slide,
update the brief in the SAME turn — never let on-disk slides and the
brief diverge.

  • Add a page → create the HTML file (any stable filename like
    `slide_NEW1.html`) AND insert a matching entry into
    `slides_brief.json.slides[]` at the desired position in the list
    (`title`, `layout`, `output_path`, self-contained `task_brief`).
  • Remove a page → delete the file AND remove its entry from the list.
  • Reorder → just move entries within `slides[]`. Do NOT rename files.

In-place content tweaks only need a brief update if the change is large
enough that the old `task_brief` no longer describes the slide
(different headline, new image URL, layout switched). Typo fixes do not.

═══════════════════════════════════════════════════════════════════════
SLIDE QUALITY BAR (applies to every page)
═══════════════════════════════════════════════════════════════════════
  • Exact canvas: 1280 × 720, `overflow-hidden`. No scroll.
  • Real content density: every page carries 60-120 words of substantive text — no placeholders, no lorem ipsum, no "insert data here".
  • Exactly the chosen palette on every page. Background/primary/accent must match `slides_brief.json.design.palette`.
  • Every text color on every background must pass WCAG AA (4.5:1 contrast).
  • Use TailwindCSS via CDN (`<script src="https://cdn.tailwindcss.com"></script>`) and link the deck-wide `global.css`. Use Google Fonts for typography.
  • Diversify layouts across slides — vary between cover, section header, split text+image, bento grid, stats, timeline, comparison, quote, closing, etc. Never repeat the same layout back-to-back.
  • Never fabricate image URLs. Only use URLs that came back from the `z-ai image-search` CLI.
  • Include icons (Material Icons via `<link href="https://fonts.googleapis.com/icon?family=Material+Icons" rel="stylesheet">` and `<i class="material-icons">name</i>`). No `<script>` icon loaders.
  • Numbers, dates, and technical terms render in the proper numeric font per typography guide.
  • No graphical timelines, no SVG/connector flowcharts, no code-drawn maps, no base64 images, no Reveal.js.
  • Headers and footers are OPTIONAL, not mandatory. Add a page header/footer (deck title, page number, brand mark, footnote bar) only when user asked !!!

═══════════════════════════════════════════════════════════════════════
GENERAL RULES
═══════════════════════════════════════════════════════════════════════
  • Batch aggressively. Prefer 1 turn with 5 tool calls over 5 turns with 1 tool call each.
  • Parallelism is free — `WebSearch`, `WebFetch`, `Bash` (image-search), and the fan-out of `Agent` sub-agents all run concurrently when emitted in the same turn; use it.
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
- **Short tokens collide.** `"01"`, `"%"`, `"18"` recur across slides — keep identity mappings or scope per slide index, never global cross-mappings like `"18": "12"`.
- **Delete slides high-index first** — deleting index 5 first shifts every later index down by one.







## Code Style Guidelines
**IMPORTANT**: When generating code for PPTX operations:
- Write concise code
- Avoid verbose variable names and redundant operations
- Avoid unnecessary print statements

## Dependencies

Required dependencies (should already be installed):

- **markitdown**: `pip install "markitdown[pptx]"` (text extraction)
- **pptxgenjs**: `npm install -g pptxgenjs` (creating presentations)
- **playwright**: `npm install -g playwright@1.50.0` (HTML rendering)
- **react-icons**: `npm install -g react-icons react react-dom` (icons)
- **sharp**: `npm install -g sharp` (SVG rasterization and image processing)
- **LibreOffice**: `sudo apt-get install libreoffice` (PDF conversion)
- **Poppler**: `sudo apt-get install poppler-utils` (pdftoppm)
- **defusedxml**: `pip install defusedxml` (secure XML parsing)


---

## Native PowerPoint generation (new engine)

The repository now includes an initial editable-object generation engine in `pptx/native/`. It uses PptxGenJS directly and does not render a slide through HTML or a browser. The existing `html2pptx1.js` and `batch_html2pptx.js` remain the compatibility path.

### When to use it

Use Native mode by default for new presentations. It produces editable PowerPoint text, shapes, lines, images, tables, and charts with structured layout validation. Use HTML compatibility mode for existing HTML slide projects, explicit HTML deliverables, or browser-specific compositions that have not yet been translated into Native elements.

Do not silently migrate an existing HTML project: preserve its current renderer unless the user requests migration. Native is the default for new work, while the legacy HTML path remains supported and must retain its visual design language during any migration.

### Deck Spec

A deck is described as structured JavaScript data (JSON-compatible):

```js
const { generatePptx } = require('./native');

const deck = {
  title: 'Quarterly strategy',
  language: 'zh-CN',
  pageSize: 'wide', // wide (16:9), standard (4:3), or { width, height } in inches
  slides: [{
    background: 'F7F7F4',
    margin: 0.6,
    gap: 0.2,
    elements: [
      { type: 'text', text: '战略重点', x: 0.8, y: 0.7, w: 11.7, h: 0.7,
        fontSize: 30, bold: true, fontFace: 'Microsoft YaHei', color: '183B3A' },
      { type: 'shape', x: 0.8, y: 2, w: 4, h: 1.5, fill: 'FFFFFF' },
      { type: 'line', x: 0.8, y: 4, w: 11.7, h: 0, color: 'D36B45' }
    ]
  }]
};

await generatePptx(deck, 'strategy.pptx');
```

All geometry is in inches. Supported element types are `text`, `shape`, `line`, `image`, `table`, and editable `chart`. Text can be a string or an array of rich-text runs. Images accept a local `path` or PptxGenJS-compatible `data`. Tables accept `rows` and optional PptxGenJS table options. Shapes support editable gradients, transparency, rounded-rectangle geometry, rotation, line styling, and shadows.

### API and example

- Public API: `require('./native')`
- `buildPresentation(deck, options)`: build in memory and return the PptxGenJS instance plus layout warnings.
- `generatePptx(deck, outputPath, options)`: write a .pptx file.
- `validateDeck(deck)`: validate the basic Deck Spec structure.
- `layoutSlide(slide, pageSize, theme)`: assign default positions and estimate text heights.
- `validateSlide(elements, pageSize)`: report slide-boundary violations and text-to-text overlaps.
- Example: `node pptx/examples/native_demo.js output.pptx`
- Tests: `node --test pptx/tests/native_engine.test.js`

### Layout and typography limitations

The current text measurement is a conservative estimator with optional font-file glyph metrics. It distinguishes CJK glyphs, Latin glyphs, whitespace, and common narrow/wide characters, applies role-specific title/heading/body font sizes and shared line-spacing tokens, and adds a safety margin. It does not perform full OpenType shaping, support every complex script, or guarantee identical wrapping in PowerPoint and LibreOffice. The renderer uses native text boxes and asks PptxGenJS to shrink text to fit; this is a safety net, not a substitute for review.

Always render generated decks in the target Office environment and inspect text wrapping, clipping, font fallback, and object overlap before delivery. The validation report currently checks explicit geometry and text-box intersections; it cannot detect every glyph-level overflow or visual collision.

### Migration status

The Native engine now includes Deck Spec validation, unit conversion, role-aware text measurement (including per-run rich text), optional font-file metrics, CJK wrapping and punctuation handling, a declarative container layout engine, shared design tokens, reusable templates/components, editable text/shapes/images/tables/charts, image cover/contain/crop with focal points and zoom, rounded picture corners, picture outlines and shadows, gradient/shadow/transparency OOXML support, East Asian font properties, batch generation, a staged HTML to Native pipeline, an editability audit, LibreOffice render checks, and pixel-regression tooling. It is the default for new presentations but is not a universal CSS renderer or a guarantee of pixel-identical output across Office renderers. Remaining release gates are human review of paired HTML/Native slides, approved Golden PNGs, and spot checks in Microsoft PowerPoint on supported platforms.

Do not remove or change the legacy HTML engine as part of Native mode development. Both paths are intentionally kept side by side during migration.


### Typography upgrade: explicit wrapping and font metrics

The Native renderer now performs a pre-layout text pass for plain strings. It inserts explicit line breaks using a conservative width budget, supports grapheme-aware fallback wrapping, and avoids common Chinese punctuation at the beginning of a line. Estimated text height is recorded and the slide validator reports `TEXT_OVERFLOW_RISK` when a fixed-height text box is too short.

For closer measurement, install/configure font files and map the PowerPoint face names to actual font files:

```js
const deck = {
  theme: {
    fontFiles: {
      'Aptos': '/absolute/path/to/Aptos.ttf',
      'Aptos Display': '/absolute/path/to/Aptos-Display.ttf',
      'Microsoft YaHei': '/absolute/path/to/msyh.ttf'
    },
    fallbackFontFile: '/absolute/path/to/msyh.ttf'
  },
  slides: [/* ... */]
};
```

The optional metrics layer uses `fontkit` glyph advance widths when a configured font file is available. If a font is missing or a glyph is unavailable, the estimator falls back to conservative CJK/Latin width classes. The metrics layer does not yet perform full OpenType shaping, kerning, variable-font axis selection, or exact PowerPoint line breaking. It improves measurement but does not eliminate the need for rendering checks.

Rich-text run arrays stay editable and are now measured per run: each run is measured at its own declared font size and the line height comes from the largest size in the paragraph. It is still a greedy character-level wrap rather than shaping, so add explicit line breaks when precise wrapping matters.

### Reusable native components and templates

`require('./native')` now exports `components` and `templates`:

- `components.title(text, options)`, `components.paragraph(text, options)`, `components.divider(options)`
- `components.kpiCard(options)`, `components.infoCard(options)` return arrays of editable shape/text elements.
- `templates.cover(options)`, `templates.content(options)`, and `templates.kpi(options)` return slide specifications ready to add to `deck.slides`.

These are starter design primitives. Additional templates include `templates.comparison(options)`, `templates.process(options)`, `templates.hero(options)`, and `templates.editorial(options)`. Compose and adapt them to the content hierarchy instead of using every component as a repeated card; the design system should retain variation across slide types.


### East Asian font properties and editable charts

When writing a PPTX file, the renderer post-processes the OOXML package and sets the configured CJK font in run-level East Asian font properties (`a:ea`) in slide, layout, master, and theme XML. The default CJK face is `Microsoft YaHei`; override it with `theme.fonts.cjk`. The font still needs to be installed on the target machine. This patch sets the font reference; it does not embed font files or bypass font licensing.

Native chart elements are supported with `type: 'chart'`, `chartType: 'bar' | 'line' | 'pie' | 'doughnut' | 'area'`, and PptxGenJS series data:

```js
{
  type: 'chart',
  chartType: 'bar',
  x: 0.9, y: 1.7, w: 11.4, h: 4.8,
  data: [{ name: 'Revenue', labels: ['2023', '2024', '2025'], values: [7.8, 10.1, 12.8] }],
  options: { showLegend: false, showValue: true }
}
```

Charts remain editable PowerPoint chart objects. Chart-specific styling is passed through `options` to PptxGenJS.

### Diagram components

The component library also exports `components.processFlow(steps, options)` and `components.timeline(items, options)`. They return editable text, shape, and line elements. Starter templates include `templates.comparison(options)` and `templates.process(options)`.


### Batch generation

Use `pptx/batch_native_pptx.js` to convert one or more JSON Deck Specs into separate PPTX files. Each deck gets its own PptxGenJS instance; slides within one deck are added in source order, and concurrent workers only write independent output files.

```bash
node pptx/batch_native_pptx.js --input-dir pptx/examples/decks --output-dir dist --concurrency 2
node pptx/batch_native_pptx.js --input pptx/examples/native_deck.json --output-dir dist
```

The input directory is scanned for `.json` files in alphabetical order. The concurrency setting is limited to 1–8 and defaults to 2. Input files must have unique base names to prevent output collisions. The script prints a JSON summary with each output path and its slide warnings.


### Native design-system extraction from reference PPTX

Use `pptx/scripts/extract_native_design.py` when a user supplies a reference presentation whose visual system should be reused:

```bash
python pptx/scripts/extract_native_design.py reference.pptx extracted-design/
```

The extractor samples every slide and writes:

- `design.json`: page size, theme tokens, master/layout counts, and observed palette/font/shape usage.
- `layout_patterns.json`: per-slide editable object geometry in inches and normalized page ratios.
- `component_patterns.json`: repeated shape/geometry signatures, common font sizes, and fill colors.
- `font_config.json`: theme and observed Latin/East Asian font usage.

The original `extract_pptx_style.py` remains available for the legacy HTML/CSS workflow. The native extractor does not infer semantic roles perfectly; treat its frequency-based patterns as evidence for human/AI design planning, not as an automatic clone of every master or custom drawing.


### Legacy HTML batch ordering fix

The HTML compatibility batch converter now pre-creates slide slots in the sorted source-file order, then lets workers render into their assigned slide. Failed or severe-warning slides are removed after workers finish, in descending source order. This preserves the original HTML slide order even when concurrent render tasks finish out of order.


### Image fit, cropping, and picture surfaces

Images no longer rely on PptxGenJS `sizing`: the engine computes the geometry itself and patches the slide XML, because `contain` in PptxGenJS 3.12 emits negative crop rectangles for every non-matching aspect ratio and `crop` shrinks the picture frame.

```js
{
  type: 'image',
  path: 'photo.jpg',            // or data: 'data:image/png;base64,...'
  x: 1.2, y: 1.6, w: 4.4, h: 3.0,   // the frame you designed
  fit: 'cover',                 // 'cover' | 'contain' | 'crop' | 'stretch' (default)
  focus: 'center',              // 'top' | 'bottom' | 'top left' | ... | { x: 0.5, y: 0.2 }
  zoom: 1.4,                    // >= 1, tightens the cover framing without distorting
  crop: { left: 0.1, right: 0, top: 0, bottom: 0.15 },  // fit: 'crop' only
  transparency: 15,
  radius: 0.18,                 // rounded corners via a:prstGeom roundRect
  lineColor: 'DCE2DE', lineWidth: 1, lineTransparency: 20, lineDash: 'dash',
  shadow: { color: '000000', opacity: 0.2, blur: 8, angle: 45, distance: 4 },
  flipH: true, altText: '图表示意',
  naturalSize: { width: 1600, height: 900 }   // required only when the size cannot be read
}
```

| `fit` | Result |
|---|---|
| `stretch` | Fills the frame, no crop. Legacy behaviour; distortion is possible. |
| `cover` | Fills the frame and writes `<a:srcRect>` for the overflow, around `focus`, tightened by `zoom`. |
| `contain` | Shrinks the *picture frame* to the source aspect ratio inside the slot; no crop, no letterbox artifacts. |
| `crop` | Draws the explicit source sub-rectangle into the frame. |

`cover`/`contain` need the natural pixel size, which is read from `path` or a `data:` URI with `image-size`; pass `naturalSize` for remote URLs. All four modes keep an editable picture frame: cropping, rounding, outline, and shadow can be re-edited in PowerPoint. Nothing is promoted to a slide background or a rasterized snapshot.

Unit and OOXML coverage lives in `pptx/tests/native_engine.test.js`; the visual tour is `pptx/examples/native_images_demo.js` (`npm run demo:images`).


### Declarative layout containers

Element arrays still support the historical single-column flow, but real layouts should use `container` elements. A container is a layout-only type: it never reaches the writer, it resolves to absolute, still-editable geometry.

```js
{
  type: 'container',
  x: 0.66, y: 1.8, w: 12.0,        // omit h to size to content
  direction: 'row',                // 'row' | 'column' (default 'column')
  gap: 0.3, rowGap: 0.24, columnGap: 0.3,
  padding: 0.26,                   // number or { top, right, bottom, left }
  align: 'stretch',                // cross axis: start | center | end | stretch
  justify: 'start',                // main axis: start | center | end | space-between | space-around
  columns: 4,                      // turn it into an equal-width grid instead of a single line
  columnTracks: [{ fr: 1 }, { width: 2.4 }],   // explicit column tracks instead of equal columns
  rowTracks: [{ height: 1.2 }, { fr: 1 }, { auto: true }],  // explicit row heights
  autoRowHeight: 0.6,              // height for rows past rowTracks
  background: {                    // optional editable card surface behind the children
    fill: 'FFFFFF', radius: 0.18, lineColor: 'DCE2DE', lineWidth: 0.75,
    shadow: { color: '000000', opacity: 0.16, blur: 10, angle: 45, distance: 3 },
    gradient: { angle: 135, stops: [{ position: 0, color: '183B3A' }, { position: 1, color: 'D36B45' }] }
  },
  children: [
    { type: 'text', text: '指标', fontSize: 10, bold: true },   // width follows the cell
    { type: 'text', text: '¥12.8 亿', fontSize: 24, bold: true, flex: 2, flexBasis: 2.4, flexShrink: 1 },
    { type: 'shape', w: 1.2, h: 0.06, fill: 'D36B45', line: false }  // fixed width, flex-free
  ]
}
```

Behaviour worth knowing:

- A child without `w` fills the cross axis; inside a `row` it claims an equal share of the remaining width unless it declares `flex` (a weight), `w` or `flexBasis` (a base width). A `row` whose bases overflow shrinks its items in proportion to `flexShrink × base` — pass `flexShrink: 0` on a child that must keep its width.
- `align: 'stretch'` is the default, matching CSS `align-items: stretch`, so siblings share the tallest height — this is what makes card rows line up without manual heights.
- `background` is emitted as a normal editable shape *before* the children, so a card is still "one surface plus its own text boxes".
- Nested containers resolve recursively; a container without `h` measures its own content, including estimated text height.
- A child may declare `boxMargin: { top, right, bottom, left }`. Columns honour all four (they also shrink the child's slot), rows honour left/right, and grids ignore margins so a track stays aligned to its cell. The field is **not** called `margin` because the PPTX writer already reads `margin` as text-box insets; passing a margin object under that name silently renders converted text inset by 0.1in.
- A `direction: "column"` container may also carry `wrap: true`; `crossGap` is the space between columns. A wrapping column needs a definite height and every item needs a declared width: it breaks by height (the shared `flexColumns`), and `alignContent` then spreads the columns on the inline axis exactly as it spreads the lines of a wrapped row.
- `writing-mode`: `vertical-rl` → `vert="eaVert"`, `sideways-rl` → `vert`, `sideways-lr` and Latin-only `vertical-lr` → `vert270`. `vertical-lr` over CJK is reported: DrawingML names no upright left-to-right direction.
- The vert spellings are pinned by a test (`eaVert`/`vert`/`vert270` on the element, the vertical-lr CJK report), and the vertical text was rendered in LibreOffice with the characters running down the declared height - the "not modelled" note some earlier audit notes carried was stale: the solver has had vertical text all along.
- `visibility: collapse` hides an ordinary box exactly as `hidden` does (CSS defines it so outside the table layout) - the silent draw is fixed, and the hole-keeping semantics are shared. The interaction and containment leftovers (`scroll-behavior`, `touch-action`, `will-change`, `contain`, `appearance`, the `all` shorthand) stay reported: each names something a static slide genuinely has no use for.
- Preference media queries report their own truth: `(prefers-color-scheme: dark)` reads a browser preference a slide render does not have - a different reason from a size query that simply compares against the viewport. `color-scheme`, `forced-color-adjust`, `accent-color` and `scroll-snap` stay reported; the declared colours themselves are consumed, so a dark-mode design drawn with explicit colours needs no adaptation.
- Generated content on list items: a literal `::before`/`::after` string now joins the item text (the arrow a design puts before every row), and a `counter()` is named once for the whole list instead of vanishing - the list path read DOM text only, so both used to disappear silently.
- CSS counters are implemented for the numbered-rows design: `counter-reset` (with optional start) opens the state from the list or any ancestor, `counter-increment` (with optional step) advances it per item, and `counter(name)` in the `::before`/`::after` content prints the value with the quoted strings around it decoded. The rendered deck shows `第 1 章 · 开篇` with the accent colour. `counters()` (nested scopes) and non-list counter use stay reported.
- `open-quote`/`close-quote` (and the `no-` suppress forms) print on inline pseudos: the keywords resolve against the inherited `quotes` pair (the UA default curly quotes otherwise), and the runs land in source order - before, the words, after. The keywords used to vanish silently; `quotes` itself is silent now because the pair feeds the keywords and never draws alone.
- Nested counter scopes print: a nested list resetting the same or another name opens a scope on a per-name stack, `counters(name, sep)` joins the scopes outermost-in, and the outer counter continues after the nested list closes. The rendered outline shows `1. one` over `1) sub-a` / `2) sub-b` with the outer `2. two` intact. Counter names are custom idents - `h1` with its digit is legal, and the letter-only regex class was dropping every numbered heading.
- The transform/attr/calc audits confirmed silent-correct behaviour: translate (both axes, mixed), rotate (DrawingML degrees), calc in width/font-size (subtract, multiply, nested, custom properties) and attr() in content (with or without the attribute present) all land with the right numbers. The unsupported transform functions now carry their arguments in the report - `scale(1.5)`, not a bare `scale()` - so the designer can see which scale was asked.
- The common list markers are native now: `disc`/`circle`/`square` spell buChar (`2022`/`25CB`/`25AA`) and the ordered forms spell buAutoNum (`arabicPeriod`, alpha and roman styles) - the rendered deck shows the square marker and the numbered list. Only the rare markers (cjk-ideographic and friends) still draw the round bullet and stay named. The builder used to collapse every truthy bullet to `true`, which is why the option was lost on the way to the writer.
- The table cell styling and stacking audits verified silent-correct behaviour at the file level: rowspan lands as rowSpan + vMerge, colspan as gridSpan, cell `vertical-align` as `anchor="ctr"`, zebra fills arrive per row, and z-index sorts the absolute paint order (ascending z, DOM order for ties) - the overlap render shows the high-z surface covering the low-z one. The z-index pin test swaps the declared z values and asserts the paint order follows.
- Mixed corner radii are named now: a native roundRect rounds all four corners alike, and the corner set that differs - including a single longhand, whose undeclared siblings are CSS 0 - reports instead of silently rounding every corner at the top-left value. Uniform sets (one shorthand value, four equal longhands) draw. The old corner check modelled the shorthand repeat on longhand input, which read a single-corner design as uniform.
- Eight-digit hex (#RRGGBBAA) parses: the alpha channel becomes transparency on shapes and in gradient stops (`#C05B3E66` → fill C05B3E at 60% transparency). The parser used to reject the whole colour, which silently dropped alpha-background cards and gradient overlays. The empty-content `::before` overlay now carries its gradient as a real shape (`node.overlays` → native gradient), closing the scrim-over-card pattern.
- Picture opacity lands as `alphaModFix` (PptxGenJS carries the option on both raster and SVG images): CSS `opacity: 0.5` on an img becomes transparency 50 and the written XML holds `alphaModFix amt="50000"`. The value used to be dropped silently - the one P0 image-family item that was actually missing; cover/contain/fill, object-position focus, radius and border were already native and are file-verified.
- The multi-page stress fixture grew from 3 to 7 pages: gradient banner + shadow card + transparency overlay, native bar chart + data table side by side, flow steps + absolute timeline, and a cover-crop image with caption. It caught two real gaps: gradient stops beyond 100% now clamp to the CSS-defined edge (the schema wants 0..1), and container-nested relative image paths now rebase onto the HTML directory through the full tree walk - both silent failures before the fixture existed. The LibreOffice render of all seven pages shows the gradient ramp, the shadow card, the chart and the cropped image correct.
- The explicit crop rectangle is native now: `overflow: hidden` + an absolute picture larger than its frame is the crop idiom, and the analyzer converts it to `fit: crop` with a source-fraction rectangle instead of drawing the picture past its frame (the old behaviour hung it at a negative x with no clip and no report). The written XML carries the intersection as `srcRect`, asserted in the suite. This closes the last P0 image item from the handoff.
- `white-space: pre` and `pre-wrap` are native now: the runs keep their runs of spaces and the line breaks (the written run holds `double  space` verbatim), so the old report - which named a collapse that the translation no longer does - is gone. Normal mode still collapses, as CSS says. Pinned in the suite alongside the existing nowrap case.
- The report now carries a semantic tally (`report.roles`): what the source structure translated into, role by role - "1 title + 1 body + 3 headings + captions" instead of raw shape counts. The DOM-to-layout recognition itself was already broad (title/body/heading/caption/kicker/table/chart/image roles, verified by probe), but nothing said so in the report a reader sees.
- Chart series colours are read from the header cells a design paints: `th.s1 { color: #1C4B57 }` gives series 1 that colour, in series order, so a chart sits on the page palette instead of the theme defaults. The explicit `data-chart-colors` attribute keeps the final say. Without the class route the chart silently drew theme colours next to a styled page.
- An unknown `data-chart-*` attribute is named as a typo now. A mistyped styling attribute was silently ignored - the style it asked for simply never arrived - while a mistyped VALUE on a known attribute was already reported. The sweep covers the full known set (title, colors, labels, label-position, value-format, axis-titles, legend, grid, grouping, dir, text-color).
- The table border draws its perimeter now: CSS `table { border: 2px solid }` is the outline border-collapse paints, and perimeter cells take the table edge where the cell is silent (a cell that declares its own edge keeps it, as CSS conflict rules say). It used to vanish - cells read only their own style. Also probe-verified silent-correct this round: colgroup widths (px and percent land as colW) and the `<caption>` element (a text box above the grid).
- Percentage line-height is a font multiple now: `150%` of a 16px font is 1.5, not the 1.25 default the percent case silently fell back to (a box-relative percent has no basis in a line-height context). Unitless and px forms were already right; the leading was ~17% tighter than declared only in the percent form. Also probe-verified silent-correct: float right lands at the right edge, sticky/inline-table draw as their static equivalents (slides do not scroll, so the behaviour is equivalent), and hanging text-indent stays reported.
- `margin: auto` on a flex row item absorbs the line slack now: both margins split it (centering a declared-width item), one takes the whole slack. The row path read auto margins as zero and drew the item at the line start - the classic horizontal-centering idiom on cards silently failed. Pinned at the XML level: 600px line + 100px item → child at 290px (40 padding + 250 slack). Also probe-verified correct this round: media queries resolve against the 1280px slide viewport in cascade order (nested @media included), align-self: flex-end and align-content place on the cross axis, and column-reverse stacks bottom-up.
- A variable-font weight between 501 and 599 is named now: 550 is a real semibold in CSS but the deck has no intermediate weight, so it draws as regular - silence would read as "no weight was asked for". Weights ≥ 600 map to bold and ≤ 500 draw as regular without a report. Also probe-verified correct: font-family stacks take the first named face (system-ui resolves to the theme display face), and monospace stacks keep their mono face.
- Per-value truth replaced two generic reports: `list-style-position: inside` says the marker would sit in the text line (native bullets always hang), and `text-orientation` distinguishes the default `mixed` - which is exactly what `eaVert` already draws, so it is silent - from `upright`/`sideways`, which change Latin behaviour and are named. Both used to read "Property is outside the supported subset", a reason that described the audit tool rather than the page.
- Gradient audit closed with no gap found: deg/turn/to-right angle forms parse, container backgrounds carry the gradient with the text as a child (the scrim pattern), pseudo overlays carry gradients as real shapes, and the stress deck banner (105deg ramp) renders correctly in both readers. Angle conversion CSS→OOXML (clockwise from the +x axis) verified against the render.
- A background picture behind text draws now: the photo-under-text idiom (`background: url(...) no-repeat center` on a text box) emits an image element beneath the text in one container, both editable. The layer used to vanish twice over - the declaration splitter cut every data URI at its payload semicolons (`image/png;base64,`), and the text kind never consulted the layer. Empty boxes with the same background were already native image nodes and stay so. alt text carries natively, SVG images embed as vectors, and table pagination repeats the styled header on every continuation page (probe-verified: 30 rows split 23+9 with a bold header on both).
- `column-span: all` inside a multicol container is named now: the native text box wraps every paragraph with no exemptions, so a spanning headline would silently lose its full-width position. Outside multicol the declaration is a no-op and stays silent. Also probe-verified correct: `translate()` moves the box natively (a 40px/20px offset lands exactly), `break-inside: avoid` is honestly named (no native keep-together), and column-rule is named with the columns bail.
- Chart tuning is reader-native now: `data-chart-gap-width` → barGapWidthPct (0–500), `data-chart-smooth` → lineSmooth, `data-chart-cat-label-rotate` → catAxisLabelRotate (-90–90). Out-of-range values are named, not clamped. These were reported as unknown attributes before; the reader accepts all three options and PowerPoint exposes the same settings in its chart UI.
- Table merge audit closed with a clean bill: rowspan/colspan carry as real merges (OOXML rowSpan+vMerge, gridSpan+hMerge — pinned at the XML level because the deck JSON looks like data loss when continuation rows omit the merged cell), cell vertical-align is native, caption draws at either side. The deck JSON convention (fewer cells in continuation rows) is the pptxgenjs one, not a dropped cell.
- Interaction-only properties are silent now: cursor, user-select and background-attachment are judged against interaction or scrolling a slide never has, so every value draws the same - equivalent no-ops like position:sticky. The outline audit found the ring already native (outline maps to the shape line, 2px = 1.5pt pinned at the XML level); only a non-zero outline-offset stays reported, since the native line sits on the edge.
- The stress deck grew to eight pages: page 8 stacks grid layout, a background picture behind text, a tuned chart (gap-width), a rowspan merge and percentage line-height on one page - the feature interactions no previous page co-located. It converts with zero reports, and both baselines were regenerated to cover the new page (45 pages total).
- Rendering page 8 caught a real precedence bug the JSON check missed: on a table whose fixture-wide `th` style paints every header cell, the inherited th palette silently overwrote an explicit `data-chart-colors` attribute (the stress page's bars lost their colours). An explicit attribute is a design statement and now outranks the derived header palette; per-series header colours still name the palette when no attribute speaks. Also observed in the render: a background image draws stretched to the box (object-fit cover), where CSS would draw it at natural size with `background-size: auto` — recorded as a known difference of the image-under-text pair.
- `background-size: auto` now draws at the picture's natural size, centred: the intrinsic dimensions come from the PNG/JPEG/GIF header, so the stress page's 1×1 placeholder is a dot at the box centre instead of a full-bleed stretched block. `cover`/`contain`/percent sizes keep the old mapping, and an unreadable image falls back to the box fill. Both background paths honour it (the general background layer and the picture-behind-text pair).
- Two more reader-native chart settings mapped: `data-chart-hole-size` → holeSize (10–90) and `data-chart-legend-font-size` → legendFontSize. Out-of-range values are named, not clamped. The data-label-position family was already native. The chart tuning family is now: gap-width, smooth, cat-label-rotate, hole-size, legend-font-size, label-position.
- Decoration styles and vertical shifts are run properties now: `text-decoration: underline dotted|dashed|wavy|double` spells the style on the DrawingML u= attribute instead of collapsing to a plain single underline, and `vertical-align: sub/super` (and <sub>/<sup>) carries the native baseline offset (-40000/+30000). Both were silently flattened before; the reader forwards both spellings, pinned at the XML level. small-caps stays honestly reported (no native spelling).
- `text-indent: 3em each-line` is named now: the keyword asks for every wrapped line, the native paragraph indent touches only the first line, and the value used to parse as null with no trace. A plain first-line indent stays native and silent; word-spacing stays honestly reported. Also probe-verified: pre keeps tabs, negative letter-spacing narrows correctly.
- A margin now offsets an absolutely positioned box from its inset position (negative values pull it back): the absolute branch recomputed x from style.left and ignored margins entirely, so `margin-left: -20px` on a `left: 100px` box drew at 100px instead of 80px. Resolved once, in the branch that owns the position, after the inset math. Also probe-verified correct: box-sizing: content-box outer width (100 + 2×20 = 140), percentage padding against the width, min-width over flex-basis.
- The stress deck grew to nine pages: page 9 stacks run-level features (dotted and wavy underlines in one line, sub/sup baseline offsets) with flex auto-margin pushing a card to the far edge - the newest features sharing geometry. Both baselines regenerated (46 pages across 16 decks); the run attributes are pinned in the generated deck XML (u=dotted/wavy, baseline ±).
- A UA-default <ol> drew a round bullet: the marker lookup keyed off the computed list-style-type, which the browser numbers as decimal without spelling it. The ordered tag now seeds decimal numbering; `start="5"` rides buAutoNum startAt; `reversed` is honestly named (DrawingML counts up only). Also probe-verified: square/circle markers native (buChar), cjk-ideographic reported, nested lists and list-style:none intact.
- An elliptical corner (`border-radius: 50% / 30%`) was silently halved: the slash was fed to the box expansion, which split it as tokens and dropped the vertical radius, so each corner kept its horizontal half and drew an ordinary circle-corner. The expansion keeps each corner's rx/ry pair now and the pair is named as what no native geometry spells. Positioning probe-verified correct meanwhile: bottom/right anchors resolve against the padding box (CSS-correct), 15° rotation spells, opacity maps to alpha, z-index/fixed behave.
- Page 9 of the stress deck is now visually verified end to end: LibreOffice draws the dotted/wavy underlines, the H2O/x2 sub/sup baseline offsets, and the auto-margin card at the far edge. The WPS gates re-ran green on the nine-page deck (all 20 fixtures open in the second reader; renderer comparison passes). Table-family probe also clean: caption-side bottom positions the caption below the table, col widths honor 200px (colW [2.083, 4.167] in), empty cells fine, border-spacing honestly reported.
- Form controls show the words a static mock shows now: an `input` drew an empty box because the placeholder lived in an attribute no text path read, and a `select` read every option out loud when only the chosen one is visible behind no dropdown the deck can open. The parser seeds the placeholder, and the text walk stops at a closed select to push just the chosen label. svg/iframe/video keep their honest element reports; textarea content was already flowing.
- Three chart attributes held native spellings the honest report was hiding: `data-chart-y-min/max` map to the reader's axis bounds, `data-chart-label-format` to the data-label number format code, and `data-chart-secondary-axis` to the secondary value axis. All three ride the options now, with out-of-range values still named. Chart probe also confirmed the title attr was already wired.
- Image audit: alt text rides the whole chain (element → writer → p:cNvPr descr), pinned at the deck level; `srcset` is named now because the deck always draws `src` while the design may have meant a different picture. `image-rendering: pixelated` keeps its honest report; `loading="lazy"` stays silent (a static deck always has the image loaded - equivalent implementation).
- Family sweeps came back clean: animation (transition, will-change, contain, content-visibility, accent-color), scroll/interaction (overscroll-behavior, scroll-snap, scrollbar-width, touch-action, zoom) and paged media (page-break-*, break-inside, orphans/widows, column-fill, hyphens) all carry honest named reports. The design-reference fixture also re-verified visually through LibreOffice: accent bar, rounded card, panel rule all draw.
- Text-detail probes: word-break: break-all and overflow-wrap wrap mid-token correctly (silent, modeled), while tab-size, text-underline-offset, font-feature-settings and font-kerning keep named reports. The 1.25-vs-reader-1.45 line-height fallback residual was probed for naming and deliberately left documented: naming it fired on every deck whose stack names a face this machine lacks - noise on the machine where the golden guard actually runs - and it can only tighten with font embedding (needs real PowerPoint).
- `<q>` paints its quotes now: the browser synthesizes open/close quotation marks around the content and the deck drew bare words. The quotes join the line unless the design declares its own pseudos for the element, which win. The rest of the inline-semantics probe was clean: mark draws its native highlight, ruby shows base plus annotation, wbr contributes a break point, abbr title stays silent (a tooltip is interactive; a static deck shows the same glyphs).
- The ordered list attributes ride the native numbering: `type="A/a/I/i"` picks the alpha/roman marker style, and `value="7"` on the first item starts the count at 7 (a `start` attribute still outranks it when both are spelled). Both drew arabic digits starting at 1 before. dl terms keep their definition-list shape without bullets.
- A real dash bug: the writer sent `dash` where pptxgenjs reads `dashType`, so EVERY dashed, dotted or otherwise styled border drew solid. The keyword now rides the option the reader actually spells - `prstDash val="dash"` and `sysDot` verified in the file - and the baselines were regenerated around the corrected dash drawing.
- A double border is named now: cmpd="dbl" has no pptxgenjs option, so the border would draw as one solid line silently. Line transparency verified correct (rgba alpha reaches a:alpha). border-image and outline-offset keep their honest reports.
- The chart option family is visually verified end to end: a deck built with data-chart-y-min/max, data-chart-label-format and a custom palette renders through LibreOffice with the axis bounded exactly 0-500, the declared colours on the bars, and the legend placed. The options draw, not just spell.
- Transform family probe: rotate followed by translate composes correctly (the translation lands in the rotated frame, matching the browser), scale and matrix keep their named reports, transform-origin is named twice over - both the longhand and its property entry - which is honest if redundant. The renderer comparison gate passes on the current deck set.
- The gradient family is fully native and verified in the file: 135deg rides ang="2700000", a 90deg gradient maps to DrawingML east, and a three-stop design carries its three stops. radial, conic and repeating keep their named reports. The transform-origin double report was deduplicated - the transform parser names the origin, the generic sweep no longer repeats it.
- The table family probe came back clean: caption-side: bottom places the caption box below the grid, colgroup column widths ride the native column sizing, empty cells keep their slots, and rowspan/colspan ride the native merges - the only report is a rowspan that dangles past the last row, which the browser clamps and the deck names.
- The advanced-text probe: negative tracking draws natively (letter-spacing: -0.5px reaches the run as spc="-38"), while text-shadow, ::first-letter, ::first-line, hyphens and word-spacing keep their named reports.
- A shorthand gap closed: `background: url(x) round` carried its tiling request inside the shorthand, which the longhand-only read missed - the pattern drew as one fitted image silently. The repeat keyword is now read from the shorthand too, and tiling requests name themselves; `no-repeat` in the shorthand still means exactly what the native side draws. cover/contain/attachment verified equivalent.
- Two silent losses in the form family: a checkbox or radio input drew nothing at all (it now draws its state glyph - checked box, empty box, dot-marked or empty circle - as native font text), and a select whose selected option sat inside an `<optgroup>` lost its words (the grouping no longer hides the options).
- The SVG family rides: an `<img src="*.svg">` lands both the svg itself and a PNG raster fallback in the media folder (readers that understand svg use it, the rest draw the raster), a background svg does the same, and an inline `<svg>` block keeps its named report (no native translation for the element).
- The link family rides natively: external URLs and mailto become run hyperlinks (with the underline the browser draws), while a `#fragment` anchor is named - it jumps within the HTML page but has no slide to resolve against in the deck, so the link draws and does not navigate.
- Pagination residuals all keep their named reports (page-break, break-inside, orphans, widows, column-span). An uncommon-property sweep named eight of twelve honestly; the other four are equivalent-silent (user-select and cursor are interaction-only) - except quotes: none, which the browser uses to suppress the synthesized quotes and which we drew anyway. The q branch now honours it, keeping the words bare.
- The golden review is now a single file: `examples/golden-contact-sheet.html` embeds all 46 rendered pages of the 16 fixture decks as base64 images, so the human review pass reads one document instead of opening 46 pngs. Regenerate it by re-running the contact-sheet build after any baseline-affecting change.
- A real layout bug in the compound-layout audit: an absolutely positioned box pinned on BOTH sides (left + right, or `inset:`) hugged its content instead of stretching - CSS resolves the width as the span between the insets against the padding box. One-sided pins keep their shrink-to-fit width. sticky and fixed verified equivalent in a static slide (no scroll: sticky is relative, fixed anchors to the slide).
- The vertical pair got the same fix: top and bottom both pinned now stretch the height between the insets, completing the two-axis inset resolution.
- The inset resolution holds across its variants: percentage insets span against the padding box, negative insets land off the parent edge, and an absolute child anchors to its absolute parent - the nested containing block chain resolves. The golden contact sheet was regenerated against the current renders.
- Second-reader verification: the seven-page stress deck renders through WPS Presentation (COM) alongside LibreOffice. Page 1 (dark cover, glow circle, fixed-position meta) and page 5 (native bar chart + paginated table, legend on the right) both draw correctly - the native objects hold up outside LibreOffice. True Microsoft PowerPoint remains unverified (not installed on this machine).
- `position: sticky` is static: a slide never scrolls, so its offsets never apply.
- Lengths resolve through one evaluator: `px/pt/pc/in/cm/mm/q/em/rem/ex/ch/%` plus `vw/vh/vmin/vmax` against the 1280x720 slide, and `calc()`/`min()`/`max()`/`clamp()` over any mix of them. `ch` and `ex` count as half an em. A value it cannot resolve is reported as `length`.
- `!important` is stripped from the value, and it carries real priority: it outranks every normal declaration (even an inline `style`), while two important declarations are decided by specificity and then order.
- Shorthand splitting respects parentheses, so `gap: clamp(12px, 1.6vw, 28px)` stays one value in both the analyzer and the engine.
- A run with its own `font-size` is measured at that size. Charging `12 个夹具` to the 44pt number reserved two lines for one, which made the box a line too tall and slid everything below it down by that line.
- An absolutely positioned *text* box is still checked for collisions: text under text is unreadable, while a shape under a text box is a layer. A wrapper that holds text counts as text, because that is the shape a step or timeline layout produces.
- `line-height: normal` now comes from the real face: fontkit reads the hhea ascent/descent/lineGap of the first family in the stack that exists on this machine (found through the Windows font registry, since file names are abbreviations like `msyh.ttc`), and the hhea ratio was verified against Chrome per face - Arial 1.15, Segoe UI 1.33, YaHei 1.32, Calibri 1.22, DengXian 1.04, all exact. A stack whose faces all miss keeps the 1.25 estimate, because the reader falls into a generic per-character fallback that measured *taller* (1.45) than any static guess; that residue is a measured, named limit. Fontkit missing or metrics unreadable degrade the same way.
- `transform: translate()` and `rotate()` are resolved as one plan once the box is measured: a percentage translate resolves against the box (which is what makes `translate(-50%, -50%)` centring exact), and a translate written after a rotate is itself turned, because CSS applies the list right to left. `scale()` and `skew()` change the glyphs inside a text box, so they are named while the exact remainder of the list still lands. A non-centre `transform-origin` is named too, because DrawingML can only rotate about a shape`s own centre.
- A positioned box paints above the in-flow boxes around it, which is the browser`s paint order and what a pin or badge written *before* the picture it marks relies on; sorting by z-index alone put such a pin underneath. And an absolutely positioned text child that paints its own surface (a pill, a chip, a bordered tag) keeps its own shape instead of being folded into a text-only overlay, which dropped the paint and drew the words under the container`s children.
- `border-radius: 50%` is the inscribed ellipse, emitted as its own geometry: a dot, a badge, an avatar and a wide pill are all this one declaration, and a rounded rectangle with a large corner radius would draw a stadium instead. A percentage *below* 50% is an elliptical corner no native geometry spells, so the box arrives square and the declaration is named. Absolute radii stay rounded rectangles.
- A table taller than its slide is split into further slides instead of running off the bottom: a row never straddles two pages, the leading `<thead>` rows are repeated on every continuation page, and each page keeps the table`s left edge, width and top margin. Only full-page backdrops travel with the continuation, because the rest of that page belongs to the page. `Paged:` on stdout says how many rows became how many slides, and the analysis overflow it would otherwise report is dropped - a split table is not an overflow.
- A `::before`/`::after` box that is not absolutely positioned is an inline box in its host line, so its words join that line as runs: a `content` sequence of quoted strings and `attr()` is concatenated, the pseudo keeps its own colour and size, and runs of spaces collapse the way a browser collapses them. `counter()` and the quote keywords need state the DOM does not carry and are reported, and a decoration on a container has no single line to join, so it is reported too. Before this, an arrow or a `data-` tag in front of every row simply disappeared.
- `justify-content: space-evenly` and `align-content: space-evenly` are computed, not approximated: `n+1` equal gaps, the two outer ones included, so `free/(n+1)` replaces the `free/n` that `space-around` uses. The same expression lives in the analyzer, the engine and the shared line distributor, so both sides agree by construction rather than by review.
- A CSS value that has no native spelling is named even when the property is supported: `align-items: baseline` used to become `stretch` without a word, and `object-fit: none`/`scale-down` are approximated as `contain`. Exactly-mapped values stay silent, because a report nobody reads is worse than no report.
- `text-shadow` and `innerShdw` are reported rather than drawn, and both were tried first: run-level `a:effectLst/a:outerShdw` inside `a:rPr` and shape-level `a:innerShdw` are schema-correct and are ignored by LibreOffice (a shape-level outer shadow is drawn, which is what `box-shadow` maps to). Nothing available here can render them, so shipping them would be an unverifiable claim.
- A `<caption>` becomes its own text box above the table, and the table box starts below it, because that is where CSS draws it and a PowerPoint table has no caption part. The tempting alternative - a merged first row - is schema-valid but LibreOffice lays the rest of the table off the page when row 0 carries a `gridSpan`, so it would be unverifiable here.
- `clip-path: polygon(...)` is a custom geometry, not a raster clip: the box's own geometry *is* the polygon, so the shape stays draggable and recolourable and its outline follows the slanted edge. It needs a declared height (a `custGeom` cannot follow auto height), it clips the box rather than the subtree - a box with children is reported, because its children would paint outside the polygon - and `circle()`/`ellipse()`/`inset()`/`url()` have no path here and stay reported.
- `font-variant: small-caps` is a run property (`cap="small"`), so a block that asks for it is patched into the part rather than reported. It is one attribute for a whole run, so a *span* asking for small caps inside an ordinary paragraph is reported instead of half-applied. `all-small-caps`, `petite-caps` and `unicase` have no native spelling and keep reporting. The audit compares small-caps boxes by letters rather than by position, because a renderer reports those glyphs as capitals in fragments.
- `columns: N` is translated to what PowerPoint calls a columned body: **one** text box with `numCol`/`spcCol` on its `bodyPr`, so the reader splits the text itself and editing reflows. The box reserves the balanced height - `ceil(lines / N)` rows measured at the column width - because PowerPoint fills a column to the bottom before starting the next. Only a block whose children are paragraphs of inline content qualifies; a child that paints its own background, border or padding would be cut in half at the column edge and stays reported. The writer has no option for `numCol`, so it is patched into the part the way text indents are, with the element/shape alignment checked and thrown on.
- `-webkit-line-clamp: N` is translated, not reported: the text is cut to N lines with an ellipsis and the box reserves N lines, which is what makes a row of cards equal height. It is only honoured inside `display: -webkit-box` (`-webkit-box-orient: vertical`), and a clamp written anywhere else is reported instead of silently deleting text. The lines are baked as hard breaks with about 15% headroom, because a baked line that only just fitted re-wraps into a dangling character in a reader whose face is wider than the measured one.
- `float: left` and `float: right` are packed at the same time, from opposite edges: the two cursors meet in the middle and that gap is the band the following paragraphs get. A footer pinned with `position: absolute` does not make the band inexact, because it is not in the flow. The one case that stays reported is text taller than the float beside it - that is a wrap no single text box can express.
- `npm run golden:check` is the visual gate: sixteen decks, 40 pages, each fingerprinted as a 64-bit luminance hash plus a 24x14 colour grid. It catches what no structural test can - a gradient direction, a shadow offset, a z-order swap, a colour that shifts by more than ten points on one channel - and it is tuned to be insensitive to antialiasing but sensitive to a 4px accent strip. `npm run golden:update` accepts a new look and must only be run after seeing the render.
- `npm run audit:text-fit` runs the fit audit over all sixteen fixtures and compares it with `native/baselines/text-fit.json`: 441 text boxes, 0 words missing, 0 boxes that draw more lines than reserved. The baseline records this machine`s numbers precisely because they are a property of the installed fonts, not of the engine; the last five extra-line boxes went away when a run with its own size stopped being charged to the parent font.
- The audit reads `--layout-out` boxes, not the deck spec: a nested container positions its children when the deck is written, so only the laid-out list says where a caption ended up.
- `npm run check:text-fit` is the renderer-side check on the text estimate: it renders the deck to PDF, matches rendered line rectangles to text elements by their words (inside a geometry window, because a short label repeats across a page), and reports words that were never drawn, boxes that needed more lines than were reserved, and lines that reach below their box. A `textHeight` field on each text element records what the analyzer measured, so a box the design fixed can be judged leniently while a box the analyzer sized is a promise.
- Unmatched boxes are printed, never skipped silently: they are either words the renderer clipped away or a rectangle whose attribution stayed ambiguous.
- Speaker notes are native `ppt/notesSlides` parts: a hidden `<aside class="notes">` or `data-notes` on the slide container is harvested instead of dropped with the rest of the hidden DOM.
- The unsupported report counts elements, not measurement calls: a re-measured box does not repeat its declarations.
- `text-decoration: underline`/`line-through` are native run properties, rendered and verified in LibreOffice including a run that is both at once; the properties used to be *reported as unsupported* while being translated, the opposite lie - the support list simply never contained them. `overline`, a decoration colour and a declared thickness are named per value: no native channel.
- Inline semantics are runs: `<sup>`/`<sub>` → `baseline`, `<u>`/`<s>` → underline/strike, a plain inline background (`<mark>`) → `highlight`, `<a href>` → `hyperlink`, `<code>` → monospace. The browser's element defaults (`b`, `strong`, `em`, `i`, `mark`, `small`, `code`, `h1`-`h6`) are modelled.
- A list item is its own paragraph with its own bullet; nesting is `indentLevel`, and the bullet goes on every run of the item because the writer reads paragraph properties from the run that ends the paragraph.
- `list-style: none` switches the native bullet off (rendered and verified) - it used to be reported while the dot still drew, the worst kind of lie: the design asked for nothing and got a mark. Any other marker (`square`, `decimal`) draws as the native round bullet and says so. `background-repeat: no-repeat` is what a fitted picture does and stays silent; tiling values say the picture is drawn once - both were generic subset complaints before, naming `no-repeat`, exactly what the native side does, as a limitation.
- `white-space: pre-line` is what this text walk already does (breaks kept, space runs collapsed, the box wraps), so it is silent; `pre`/`pre-wrap` name the one residue - space runs collapse - instead of the old claim that whitespace was already collapsed. `word-spacing: normal` stays silent; a declared value says a run has per-character spacing, not per-word.
- `table-layout: fixed` is the model this solver implements - declared or equal columns, content wraps instead of stretching them - so it is silent; the column model (declared `colWidths` scaled to the table width, otherwise equal) is documented, and a browser`s `auto` content-stretching is not modelled anywhere, which the column-width rule already states.
- `clip-path: circle(50%)` on a square box and `ellipse(50% 50%)` on any box cut the inscribed round shape, which *is* the native ellipse preset - they become the shape itself, rendered and verified, no polygon patch. Everything else (a non-inscribed radius - a percentage `circle()` resolves against the half-diagonal, so a wide box is not covered - a moved `at` centre, `inset()`, `path()`) stays reported.
- `line-height` is written as `spcPts` (multiple x font size), never `spcPct`, which would render ~20% taller than the reserved box.
- `colspan`/`rowspan` are resolved into a real grid: rows hold only the cells that start in them (lopsided), the covered slots are covered by the writer's own merge placeholders, `columnCount` is the grid width, and a rowspan past the last row is clipped and reported.
- `box-shadow` becomes a native outer shadow (offset, blur, colour); the CSS offset maps to DrawingML `dist`/`dir` with `dir = atan2(dy, dx)` - `0 10px` is 90 degrees. Rendered and verified, including a solid `6px 8px 0 #C05B3E` hard shadow. The tokeniser once lacked `A-F` in its hex class, so `#C05B3E` fragmented into stray lengths that blackened the shadow and reported the working declaration - the opposite lie again. A layered declaration keeps its first layer and names the rest; `inset` is refused whole, because an outer shadow would be the wrong look rather than half of it; a spread radius is reported.
- `opacity` fades a leaf's fill or text (alpha multiplies); on a box with children it is reported instead, since PowerPoint cannot fade a subtree.
- A `linear-gradient` layered above a `url()` picture is a scrim: the picture and a gradient shape are emitted, the shape above the picture and below the text.
- `margin: auto` centres a fixed-width box (both sides) or pushes it to the end edge (one side); in a flex column the same decision travels to the engine as `align-self`.
- A painted inline box, text mixed with element children, and a per-corner `border-radius` are reported rather than approximated silently.
- Gradients: only `linear-gradient` is translated, and its direction is optional (`to bottom` when omitted, otherwise `deg`/`rad`/`grad`/`turn` or `to <side>`). `radial-`/`conic-`/`repeating-*` fills are reported and the box is left unpainted.
- The untranslatable gradient families each say their own truth: `radial-gradient` (a native fill has no radial mode), `conic-gradient` (no angular mode), `repeating-linear-gradient` (a native fill draws one ramp, not a pattern that repeats it). A pixel-stop repeating gradient was briefly parsed before the basis question killed it: the axis length lives with the box, which the parser cannot see, and a wrong basis bakes a wrong pattern in - refusal is the honest answer.
- The `font` shorthand expands into the longhands it sets (`<style> || <variant> || <weight>? <size>[/<line-height>]? <family>`): the size is the first unit-bearing token, the family is the raw remainder so a quoted face or a comma stack survives verbatim, and a declaration that does not parse stays whole and is named - a half-expanded font is worse than a refusal. Verified equal to the longhand spelling, box for box.
- `::marker { color: ... }` styles the bullet itself: the rule is captured per `li`, a colour agreed across the items rides on the list element and lands as `a:buClr` before `buChar` through the post-serialization patch (PptxGenJS has no bullet-colour option), and it was rendered with three red dots in LibreOffice. A disagreement across items is named - one text box carries one bullet colour.
- `caption-side: bottom` moves the caption under the grid (the property was added to the inherited set - it declares on the table and inherits to the caption, which an early draft missed until the probe showed the caption staying put). Verified in Chrome: the caption top lands one caption-height above the grid bottom, same as the deck.
- `text-transform: full-width` maps the ASCII printables onto U+FF01-FF5E (the CJK typographic request; the characters exist in the CJK faces the deck names). The selector family audits complete: structural pseudo-classes, `:not()`, attribute selectors, sibling combinators and nth-child odd/even all match with no reports; `:hover`/`:focus`, `@media print` and animations stay reported because a static slide has no such states.
- Browser parity is now pinned by a test: grid `1fr 2fr` in 1200px with a 10px gap allocates 396.7/793.3 and two `flex-basis:30%` items stay 360 - both measured live in Chrome on the twin fixture and asserted in the suite. A bare text cell carries no width (the box exists only in the reader layout there); a painted cell keeps its measurement, which is what the test reads.
- `outline` draws its uniform ring as the shape line (colour and dash ride along), taking no layout space - the second box keeps its margin, Chrome-verified at the same pixel. A declared border wins the shape line; the outline is the fallback. It left the report-once contract: a value that asks for exactly what the native side draws is not a limitation.
- Logical properties (inset, margin/padding/border-block/inline and their start/end sides, logical radii) normalise to their physical aliases at declaration time - the solver models exactly one writing mode (horizontal-tb, ltr), where every alias is 1:1. `inset` follows the box-shorthand expansion, and in ltr the left wins when left and right are both set - Chrome-verified at x 20 for `inset: 10px 20px`.
- A top-level `position: relative`/`sticky` offset now reaches the final PPTX coordinates: layoutSlide applied the shift on the element paths but skipped it on the top-level container and text paths, so a nudged box painted at its static spot. The gap existed because every prior test put `position: relative` on the slide itself (a no-op); the regression test reads `a:off` from the written file.
- The semantic element families audit clean end to end: table structure (rowspan, thead/tbody/tfoot, col/colgroup, th scope, nesting), image semantics (figure/figcaption, picture/source, links around images), anchors (hlinkClick in the slide plus the target in .rels, file-verified), inline semantics (mark paints a:highlight, sub/sup ride the baseline, del/strike, abbr keeps its visible text - the title tooltip is not a slide artifact), nested lists carry indentLevel, and dl/dt/dd lay out. A file-level test pins the hyperlink, highlight and baseline so a spec-only regression cannot pass.
- Multi-layer audits: two- and three-layer backgrounds draw the gradient scrim over the picture natively (image element + scrim shape), the first shadow layer draws with the rest named, and blend modes stay reported. `transition`/`animation` reports now name the journey - the end state IS drawn (the transform landed, verified at x 50), what the reader misses is the movement between states. A generic "no native translation" sentence was a lie of omission for exactly this case.
- Chart styling is file-pinned: `data-chart-title`, `data-chart-legend` and `data-chart-colors` reach `ppt/charts/chartN.xml` (title text, legendPos, per-series srgbClr), and a styled pie rendered in LibreOffice with all three visible on a native, editable chart object. The test locates the chart part by pattern - the chart number depends on what else the deck serialises.
- `text-emphasis: dot <colour>` draws the CJK accent as `<a:emphasisMark><a:buChar char="•"/></a:emphasisMark>` on the run through the post-serialization patch (PptxGenJS has no option). The check is file-level because LibreOffice ignores the mark while PowerPoint honours it - exactly the split the two-reader strategy exists for. `sesame` maps to the 〆 dot, other shapes stay reported, and a colour-only value (no shape keyword) is reported too. `overflow-wrap: break-word`/`anywhere`/`normal` are silent - the grapheme-level break is what the wrap already makes, and `normal` is the initial value spelled out.
- The gradient, `text-indent` and East-Asian-font patches rewrite `slideN.xml` by index, so they must walk the laid-out element list (container backgrounds, single-side border strips and overlays included), not the deck spec.
- `writing-mode`: `vertical-rl` → `vert="eaVert"` (`white-space: nowrap` plus `overflow: hidden`): the analyzer keeps the widest fitting prefix plus `…`, flattens rich runs, and stays silent when the text already fits. A wrapping block or an unclipped box is reported instead.
- An absolutely positioned box with no declared width is shrink-to-fit (`scripts/stress_html.js` found a footer at `left: 56px` being emitted as a 13in box that hung off the page); a leaf hugs its text, a container keeps the containing-block width.
- A `direction: "row"` container aligns on the cross axis with `align`/`alignSelf`, and a *single-line* row fills the height its own parent gave it (`flex: 1`, or a declared height): a stretched child takes the row’s inner height, a centred or end-aligned child is placed inside it.
- A `direction: "column"` container distributes its children the same way a row does: `justify` places the stack in the leftover height, and a child carrying its final `h` (a `flex: 1` item, for instance) keeps that height. `boxMargin` is honoured for blocks and columns (all four sides) and rows (the horizontal pair); a grid child keeps its margins out of the geometry.
- Whenever the analyzer moves a child it moves the child’s subtree with it (`shiftSubtree`): the spec stores the *final* box, and the engine replays the descendants relative to it, so a child that is re-placed without its contents makes every probe inside it disagree by the offset.
- A container may declare `alignContent` (`start`/`center`/`end`/`space-between`/`space-around`/`stretch`). It only acts on a `wrap` row whose `h` is pinned: the leftover cross space is distributed between the lines (`stretch` grows the lines themselves, which a stretched item then fills).
- A grid child may declare `columnSpan` / `rowSpan` (integers) and, when the analyzer resolved its cell, `gridColumnStart` / `gridRowStart` (0-based cell indices) plus `justifySelf` (`start`/`center`/`end`/`stretch`) for its place inside that cell. A declared `width` beats the cell: the engine measures the child at `min(w, cell)` and only stretches when CSS left the axis free. With the resolved cell present the engine places the child there instead of re-running auto-flow, so an explicit `grid-column: 2 / 4` cannot drift between the two. Row heights come from `rowTracks`: a fixed `height` in inches pins the row, `auto` fits its items, and `fr` divides whatever height is left over (which needs a declared container height — pass `rowContentHeight`, as the HTML pipeline does). Rows beyond `rowTracks` use `autoRowHeight` when set, otherwise they fit their items. A child that declares its own `h` keeps it instead of stretching.
- Text inside a container is wrapped against the cell width, so `h` can be omitted entirely for text.

`pptx/examples/native_stress_deck.js` is the reference for the intended usage: twelve designed pages built mostly from containers.

### Editability audit

`node scripts/audit_deck.js <deck.pptx>` reads the package and reports, per slide, editable text shapes, characters, pictures, charts and tables, plus findings such as `TEXT_AS_IMAGE`, `NO_EDITABLE_TEXT` and `POSSIBLE_FULL_SLIDE_RASTER`.

```bash
node scripts/audit_deck.js native-stress-deck.pptx --min-text-shapes 1 --fail-on-warning
node scripts/audit_deck.js deck.pptx --json --max-picture-coverage 0.6
```

Use `--fail-on-warning` in CI for fixtures that must stay clean. A full-bleed hero picture is reported as `info` (`FULL_BLEED_PICTURE`) because it is still a croppable native picture, not a raster.

### Offline layout preview

When LibreOffice or PowerPoint is not available, `scripts/preview_deck.py` renders a generated PPTX to PNG with Pillow so geometry can still be reviewed.

```bash
cd pptx/native
python scripts/preview_deck.py native-stress-deck.pptx --output-dir preview/stress --sheet preview/stress-sheet.png
python scripts/preview_deck.py deck.pptx --scale 0.5
```

It reads the real package through `python-pptx`, so slide size, shape frames, z-order, solid fills, linear gradients, line transparency, native tables, picture crops, rotated shapes, and text wrapping/anchoring all come from the actual OOXML. It warns when text exceeds its box and when a table is taller than its frame.

What it is not: a faithful Office renderer. There is no OpenType shaping or kerning, no shadow/glow/bevel rendering, no pattern fills, native charts are drawn as labelled placeholder panels, and gradient stop transparency is ignored. Use it to catch layout mistakes — final typography still has to be approved in the target Office environment.

### Real rendering with LibreOffice

`scripts/render_check.py` converts a deck with `soffice` and verifies the slide count, then rasterises the PDF. It uses `pdfinfo`/`pdftoppm` when poppler is installed and falls back to `pypdfium2`, so it runs on a plain Windows box:

```bash
cd pptx/native
export LIBREOFFICE_SOFFICE=/path/to/soffice        # or pass --soffice
npm run render:pipeline && npm run render:chart    # render-check/<deck>/*.png
python scripts/render_with_libreoffice.py deck.pptx --output-dir render/deck --soffice "$LIBREOFFICE_SOFFICE"
```

This is the only check that exercises real text shaping, native charts, rotation and merged table cells. Two findings it produced that the Pillow preview cannot show: a native chart has a *transparent* plot area (so it needs a light panel behind it on a dark slide), and pie/doughnut charts are unreadable without a legend.

### HTML → Native conversion pipeline

`pptx/native/pipeline/` implements the staged conversion described in the migration plan:

```
HTML → DOM Analyzer → Layout Analyzer → Style Mapper → Native Deck Spec → PPTX
```

```bash
cd pptx/native
node pipeline/cli.js ../examples/pipeline-reference.html \
  --out converted/deck.json --report converted/report.json --pptx converted/deck.pptx
```

The same conversion is available from the package entry point, so a Node script can go HTML → PPTX in one call:

```js
const { convertHtml, convertFile } = require('./pptx/native');
const { deck, report, errors } = convertFile('deck.html', { pptx: 'deck.pptx' });
```

The CLI prints how many nodes became text / shapes / images / tables, and lists every CSS feature it could not translate. Text keeps semantic roles (`title` / `heading` / `body` / `caption`), cards become editable shapes plus their own text boxes, `<img>` and `background-image: url(...)` both become native pictures with an editable crop rectangle (honouring `object-fit` / `background-size` and `background-position`), `<table>` becomes a native table that keeps its column proportions (`<colgroup>/<col>` or declared cell widths) and its merged cells (`colspan`/`rowspan`), and `<ul>` becomes a bulleted native text box.

Subtree layout is emitted **declaratively** wherever the CSS intent has a container equivalent: a flex row, an equal-track grid, or a block-flow stack (spacing carried by per-child `boxMargin`) becomes a native `container` with nested children instead of a pile of coordinates. Because the analyzer and the engine both implement the layout rules, every declarative group is then re-resolved by the engine and compared with the analyzed boxes; a disagreement over 0.012in demotes that subtree to explicit coordinates, and the report records how many groups are declarative, how many fell back, why, and the worst residual delta. The shipped fixtures convert with 7 containers, 0 fallbacks and a 0.0001in worst delta.

Scope discipline: the pipeline covers absolute positioning (and `position: fixed` anchored to the slide), block flow, single-line and wrapping flex (row/column) and grids with fractional/fixed/percentage tracks, track spans and explicit lines (grid-column/grid-row: `span N`, `A / span N`, `A / B`, the `-start`/`-end` longhands, negative lines and the four-value `grid-area`; the four CSS 8.5 placement phases run, so an item that names its cell stays there and the rest flow around it, while named areas need `grid-template-areas` and are reported) and declared heights (`grid-template-rows`, `grid-auto-rows`). Selectors cover type/class/id, the descendant/child/adjacent-sibling/general-sibling combinators (each with its real meaning), the structural pseudo-classes (`:first-child`, `:last-child`, `:only-child`, `:nth-child(an+b|odd|even)`, and the `-of-type` / `-last-` forms), attribute selectors (`[data-kind="kpi"]`, `~=`, `^=`, `$=`, `*=`, the `i` flag) and `:not()`/`:is()`/`:where()`, which is what zebra striping, first/last-item accents and "everything but the last row" spacing are written with. Typography covers `text-indent` as a real paragraph property (`<a:pPr indent>`), so a Chinese first-line indent stays editable and the measured height already accounts for the narrower first line, and `white-space: nowrap` as `bodyPr wrap="none"` with autofit off, so a label or badge never breaks into two lines. It is **not** a browser — see `pptx/native/pipeline/README.md` for the exact supported subset and the reported gaps (`filter`, `clip-path`, `mask`, `flex-wrap`, media queries, pseudo-elements, transforms, and more). Unsupported visuals are reported for deliberate human translation; the pipeline never rasterizes a slide.


### Current Native quality gates

- The CI suite runs Node engine tests (172 assertions), creates editable sample decks, audits each deck for editability, converts the HTML fixtures through the pipeline, inspects DrawingML for gradients/shadows/alpha/image crops, renders through LibreOffice/Poppler, and uploads previews.
- The visual comparator is active, but it only performs real deck comparisons when reviewed PNGs exist under `pptx/native/golden/<deck>/`. Its self-test is not a substitute for a real baseline.
- Never add generated PNGs to Golden directories merely to make CI green. A human must review each paired HTML/Native slide and approve the baseline first.
- LibreOffice rendering is a useful regression signal, not a substitute for opening the deliverable in Microsoft PowerPoint. Font availability, fallback, and renderer differences must be reported.
- Image `cover`/`contain`/`crop`, rounded corners, picture outlines and picture shadows are asserted at the OOXML level, not only visually.
- The editability audit (`scripts/audit_deck.js`) is the machine check for "content stays editable". It cannot judge aesthetics.
- The layout audit (`pptx/native/pipeline/collide.js`) is the machine check for "the page fits": it reports sibling boxes that collide, content taller or wider than its own box, and flow content past the slide edge. The pipeline CLI fails on any of them (`--allow-layout-issues` opts out), so a measurement error cannot ship silently.
- A run of consecutive `float: left/right` siblings is packed into a wrapping row (declared widths, one edge, every line as tall as its tallest item); `clear` is honoured because the next block always starts below the run. A block that would have wrapped its lines *beside* a float is reported, and a floated box without a declared width is reported because shrink-to-fit is max-content.
- Absolute children resolve against the **padding box** of their containing block, like CSS: a `right: 72px` footer sits 72px from the slide edge, not 72px inside the padded content area.
- `aspect-ratio` sizes a box whose height is auto from its used width; a declared height wins, and `align-items: stretch` still wins over the ratio, exactly as in CSS. Stretch never resizes an axis the CSS pinned (`fixedHeight`/`fixedWidth` travel in the spec so the engine agrees).
- TEXT BESIDE A FLOAT: a float shortens the line boxes beside it, and the common editorial case - a picture with a caption or two short lines next to it - is exactly a two-column row. When the float run stays on one line, the free rectangle is measured, and the following plain text blocks are placed in it if their measured heights fit; the pair then fills the band, so later content starts below the float the way CSS does. The text may not paint anything (background, border, padding, horizontal margin), since a painted block spans the full width even while its lines are shortened. Text taller than the band, a painted block, or a run that wrapped is reported, not approximated. An absolutely positioned block is never reported: a float cannot shorten a box that is out of flow.
- COMPATIBILITY EVIDENCE: Microsoft PowerPoint is not installed on the dev machine, so two independent readers are used instead. `npm run verify:wps` opens every fixture through WPS Presentation's PowerPoint-compatible COM surface and fails if a deck will not open or a slide arrives empty; `npm run compare:renderers` compares LibreOffice's render against WPS's after downscaling by 4 (two renderers never match pixel for pixel, so the same-renderer golden thresholds are wrong here - downscaling leaves placement as the dominant signal; the fixtures agree at mae 0.006-0.016, ssim 0.95-0.98). This is not a substitute for Office: `scripts/corrupt_anchor.py` rewrites a deck with an invalid `anchor` value and WPS opens it happily, which is why the enumerated-value audit, not a renderer, is the guard.
- Table cells keep their CSS padding (written as the cell margin in points), their `vertical-align` and their `letter-spacing`, and rows are measured rather than assumed: `rowH` makes PowerPoint draw the heights the analyzer reserved. `valign` must be `middle` - PptxGenJS writes `anchor="mid"` verbatim, which is not a valid value, so `middle` is the only spelling that survives.
- Chart styling is declared, not inherited from library defaults: `data-chart-colors`, `data-chart-legend` (with a position), `data-chart-grid`, `data-chart-axis-titles`, `data-chart-labels`/`-label-position`, `data-chart-value-format`, `data-chart-grouping`, `data-chart-dir`, `data-chart-text-color`. Unknown values are reported; the axis text uses the deck font.
- `position: relative` offsets are applied after layout and travel in the spec as `relativeShift`: the sibling flow keeps the static slot and the engine nudges the box once, whether it sits flat on the slide or inside a declarative container. `sticky` is treated as in-flow because a slide never scrolls.
- A border side can be recoloured with `border-top-color` (or re-weighted with `border-top-width`) on top of the `border-top` shorthand.
- Text boxes carry no autofit (`normAutofit` made LibreOffice draw a 25.5pt title at 22pt); the conservative wrap width is what keeps the declared size safe.
- Text height is the CSS line box (`lines x fontSize x lineHeight`, nothing added), so stacked blocks stay on their CSS positions; the width used for wrapping is deliberately 10% conservative so a line breaks early rather than overflowing.
- Wrapping is greedy and breaks an over-long token at grapheme level, so `word-break: break-all`/`break-word` are translated (that is also what PowerPoint itself does) while `keep-all` is reported. `overflow-wrap` is not read, so it is reported rather than claimed.
- `writing-mode: vertical-rl` is native vertical text (`bodyPr vert="eaVert"`, upright CJK, columns right to left) and `sideways-rl` is `vert`; the box height is the line length, so the fit test counts columns instead of shrinking the font. `vertical-lr`/`sideways-lr` are reported because DrawingML has no matching direction.
- `overflow: hidden` is reported only when the content really is larger than the box; with content that fits the declaration changes no pixel and stays silent. There is no clipping, so a bleeding decoration is drawn past the edge.
- A single declared border side (`border-top: 3px solid ...`) is translated into a thin filled shape on that edge - a real editable object - instead of a rejected asymmetric outline. Two or more differing sides are still reported, because a native outline is uniform.
- CSS token extraction is best-effort. It supports a limited set of colors, font tokens, spacing, simple linear gradients, one simple box shadow, and explicit opacity. Complex CSS cascade, Grid/Flex composition, filters, masks, blend modes, pseudo-elements, and animation require deliberate manual translation.
- The HTML pipeline's layout solver is not a browser engine. Its output must be reviewed against the HTML reference before it is treated as a delivered design.
