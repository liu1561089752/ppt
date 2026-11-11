# Running this engine as a service

A native deck generator is a *batch job*, not a web request: research, writing and rendering take minutes
and produce megabytes. This note records what the engine already gives a service, what blocked it, and
what is still missing before a public site. Everything marked **measured** was run on this machine while
writing this file; everything else is a claim about the code.

## What is already service-shaped

| Property | Evidence |
|---|---|
| One command in, one file out | `node cli.js <spec> <out.pptx>`; exit `0` written, `1` spec rejected (nothing written), `2` writer failed |
| Machine-readable result | `--json` (one object) and `--report <f>` (census, warnings by code, font situation, dropped pictures) |
| Validate without writing | `--check` — cheap enough for a "will this spec build?" endpoint |
| Page-level editing | one module per page + `render_check.py --slides 3,7-9`, so a fix re-renders 3 pages instead of 25 |
| Deterministic layout | same spec + same fonts ⇒ same boxes; the `.pptx` bytes differ per build (docProps timestamps), so compare `report.json`, not hashes |
| Cheap build, expensive render | **measured**: 25 pages build in 1.15 s at 32 MB peak RSS; LibreOffice render 9–14 s and 11.8 MB of artifacts (2.9 MB pptx, 2.5 MB pdf, 25 PNGs) |

## Blocking issues found while reviewing it for deployment — all fixed here

1. **A `.js` spec is arbitrary code.** `cli.js` `require()`s it by design, which is right for a local
   skill and wrong for a server: model-authored page modules would run with full Node privileges.
   *For the service: generate `.json` specs only* — the engine has supported them all along
   (`native-cover.spec.json`), containers, charts and tables included. Keep `.js` for local use.
2. **LibreOffice locks its user profile.** Two conversions sharing the default profile do not run side
   by side. **Measured**: of two concurrent `render_check.py` runs, one died with `CalledProcessError`
   and wrote no image. Fixed: a private `-env:UserInstallation` per conversion; **verified** with three
   concurrent renders, all six PNGs each.
3. **Relative media paths were resolved against `cwd`, not the spec.** **Measured**: the same 25-page
   deck built from another directory exited `0` and dropped all six pictures, 798 KB instead of 2.9 MB.
   Fixed: `path` resolves against the spec's directory (absolute paths and `data:` URIs untouched).
4. **A dropped picture was a footer note, not a failure.** Fixed: `PICTURE_DROPPED` is a warning, so
   `--strict` fails and the report names the page and the path it tried.
5. **On Linux, family → file resolution was a filename-prefix guess.** `Noto Sans CJK SC` lives in
   `NotoSansCJK-Regular.ttc`, which never matches a prefix test, so every width silently fell back to
   the estimate — the exact failure that made a 25-page run reflow 11 pages. Fixed: `fc-match`, trusted
   only when fontconfig names the family that was asked for. The server image must install the faces
   the themes declare (`fonts-noto-cjk`), and the smoke test below proves it does.

## Still open before a public site

- **API quotas and keys.** Bocha is billed per query (**measured**: 10 queries for a 25-page deck, 74
  results). Unsplash's demo tier is 50 requests/hour and its guidelines require the attribution line,
  a link to the photographer, and the `/photos/:id/download` ping — the skill does all three — but a
  commercial site needs their approval or another licensed source. Cache research per
  `(topic, freshness window)` and cap queries per job.
- **Latency is the writer, not the engine.** **Measured**: one agent wrote 25 pages in 19m30s, then six
  build→render→look rounds. So: async job + progress stream, per-page modules persisted so a retry
  rebuilds one page, and no synchronous "generate" request.
- **Storage.** 11.8 MB of artifacts per 25-page deck, before the user's own exports. Object storage with
  signed URLs, a retention window, and renders produced on demand rather than always.
- **Gates as UX.** `warnings` are the quality signal: show them per page ("this box may overflow"),
  auto-repair at most twice, and never ship a deck whose build printed `warnings` without saying so.
- **Multi-tenancy.** One process per build (32 MB, 1.2 s CPU) is easy; LibreOffice is the cost — plan
  ~2 concurrent conversions per 2 cores, each with its own profile and temp dir, and clean the temp dir
  even on failure.
- **Sandboxing.** Give each job its own directory and no ambient credentials. The research stage only
  calls two fixed hosts, so there is no SSRF surface today — do not add "import my URL" without a guard.
- **Fidelity is still unproven.** Nothing here says PowerPoint renders the deck the way LibreOffice does.
  Offer the PDF/PNG preview as what it is: a preview.

## Suggested shape

```
POST /decks            → { jobId }            (json spec or a topic + answers)
GET  /decks/:id/events → SSE: stage, page i of 25, warnings, done
GET  /decks/:id        → { pptx, pdf, sheet, report }

worker: research (Bocha/Unsplash, cached) → brief → page modules (LLM, one page per call)
        → cli.js --strict → gates → preview_deck.py --sheet → [repair loop ≤2] → artifacts
```

Keep the four gates in the worker, not in the client: `cli.js --strict` (geometry), `audit_deck.js`
(editable objects per page), `verify_native_ooxml.py` (enumerated values, parts), `check_all_text_fit.py`
only in CI — it needs LibreOffice plus the real faces and is too slow per request.

## Container recipe

```dockerfile
FROM node:22-bookworm
RUN apt-get update && apt-get install -y --no-install-recommends \
      python3 python3-pip libreoffice-impress poppler-utils \
      fonts-noto-cjk fontconfig && rm -rf /var/lib/apt/lists/*
RUN pip install --break-system-packages python-pptx pillow defusedxml
WORKDIR /engine
COPY pptx/native/package*.json ./
RUN npm ci --omit=dev
COPY pptx/native/ ./
WORKDIR /job
ENV NATIVE_FONT_DISCOVERY=1
HEALTHCHECK CMD node /engine/cli.js /engine/../examples/native-cover.spec.json --check
```

## The smoke test that proves the image is right

```bash
node cli.js ../examples/native-deploy-smoke.spec.json /tmp/smoke.pptx --strict --require-face-metrics
python scripts/preview_deck.py /tmp/smoke.pptx --output-dir /tmp/preview --sheet /tmp/preview/sheet.png
python scripts/verify_native_ooxml.py /tmp/smoke.pptx
LIBREOFFICE_SOFFICE=/usr/bin/soffice python scripts/render_check.py /tmp/smoke.pptx --slides 1
```

`examples/native-deploy-smoke.spec.json` exists for this: one page, a table, a chart, CJK copy, and its
theme declares `Noto Sans CJK SC` — the family `fonts-noto-cjk` installs. What passing looks like:
`warnings none`, `exit 0`, and

```
metrics   fontkit: 212 of 212 measurements used real faces
fonts     Noto Sans CJK SC · metrics from 1 face file(s) (found on this machine)
```

If it reads `no face files: wrap is estimated` instead, `--require-face-metrics` refuses the build —
which is the check that keeps a silently-estimated server from shipping. (This Windows box has no Noto,
so here the same command exits 1: that is the gate working, and the reason the smoke test names the
family the image is expected to carry rather than one it happens to have.)
