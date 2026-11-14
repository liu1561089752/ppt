#!/usr/bin/env python3
"""Measure what a rendered slide actually looks like, page by page.

`preview_deck.py` and `render_check.py` produce pictures; this script answers the
questions a picture can answer without a human and without a model:

  * how much of the page carries ink at all (a page can be legally composed and
    still be 80% empty paper);
  * how far down the page the content actually reaches (the bottom band is where
    "content collapsed into the top third" shows up);
  * whether the page is a single flat colour (a slide that failed to paint);
  * how many distinct colours survive (a gradient/photo page and a blank page
    are not the same thing).

Everything here is deterministic and pixel-based. It says nothing about taste:
a slide can score perfectly here and still be ugly. That judgement belongs to
the visual review step, and the two results are recorded separately.

Usage:
    python scripts/render_metrics.py render-dir/            # every slide-*.png
    python scripts/render_metrics.py a.png b.png            # explicit files
    python scripts/render_metrics.py render-dir/ --json out.json --quiet

Output (stdout, one JSON object):
    {"ok": true, "pages": [{"page": 1, "file": "...", "width": 1280, ...}],
     "averages": {...}, "flags": [{"page": 1, "code": "PAGE_MOSTLY_EMPTY", ...}]}
"""
from __future__ import annotations

import argparse
import json
import os
import re
import sys

try:
    from PIL import Image
except ImportError:  # pragma: no cover - exercised only on a machine without Pillow
    sys.stderr.write(
        "Pillow is required: python -m pip install pillow\n"
        "This script is the deterministic half of visual review; "
        "without it the pipeline must report visual checks as NOT RUN.\n"
    )
    raise SystemExit(3)

# A pixel "carries ink" when it differs from the page's own dominant colour by
# more than this, per channel. 12/255 keeps anti-aliased text edges in while
# ignoring JPEG-ish noise in a flat fill.
INK_THRESHOLD = 12
# The bottom band measured as "did the page reach the bottom".
BOTTOM_BAND = 0.25
# A page where less than this share of pixels carry ink reads as empty paper.
EMPTY_INK_RATIO = 0.03
# Content that stops above this line leaves a visibly dead bottom half.
EMPTY_BOTTOM_RATIO = 0.62
# Fewer distinct colours than this in a 6-bit-per-channel histogram = flat page.
FLAT_COLOUR_COUNT = 6


def dominant_colour(image: "Image.Image") -> tuple[int, int, int]:
    """The background is the single most common colour (quantised to 5 bits)."""
    small = image.convert("RGB").resize((160, 90))
    counts: dict[tuple[int, int, int], int] = {}
    # Pillow 12 deprecates getdata() in favour of get_flattened_data(); accept both so
    # this keeps running on the Pillow the CI image happens to ship.
    pixels = small.get_flattened_data() if hasattr(small, "get_flattened_data") else small.getdata()
    for pixel in pixels:
        key = (pixel[0] >> 3, pixel[1] >> 3, pixel[2] >> 3)
        counts[key] = counts.get(key, 0) + 1
    best = max(counts.items(), key=lambda item: item[1])[0]
    return (best[0] << 3, best[1] << 3, best[2] << 3)


def measure(path: str) -> dict:
    with Image.open(path) as handle:
        image = handle.convert("RGB")
        width, height = image.size
        background = dominant_colour(image)
        pixels = image.load()
        colours: set[tuple[int, int, int]] = set()
        ink_rows = 0
        ink_total = 0
        bottom_ink = 0
        # Sample the bottom band densely, the whole page sparsely: a 1280x720
        # page is 921k pixels and this runs once per page per repair round.
        step_x = max(1, width // 320)
        step_y = max(1, height // 180)
        for y in range(0, height, step_y):
            row_ink = 0
            for x in range(0, width, step_x):
                r, g, b = pixels[x, y]
                if abs(r - background[0]) + abs(g - background[1]) + abs(b - background[2]) > INK_THRESHOLD * 3:
                    row_ink += 1
                    ink_total += 1
                    if len(colours) < 4096:
                        colours.add((r >> 2, g >> 2, b >> 2))
                    if y >= height * (1 - BOTTOM_BAND):
                        bottom_ink += 1
            if row_ink:
                ink_rows += 1
        sampled = max(1, ((height // step_y) * (width // step_x)))
        # contentBottom: the lowest row that still has ink, as a share of height
        content_bottom = 0.0
        for y in range(height - 1, -1, -1):
            found = False
            for x in range(0, width, step_x):
                r, g, b = pixels[x, y]
                if abs(r - background[0]) + abs(g - background[1]) + abs(b - background[2]) > INK_THRESHOLD * 3:
                    found = True
                    break
            if found:
                content_bottom = round((y + 1) / height, 3)
                break
        return {
            "file": os.path.basename(path),
            "width": width,
            "height": height,
            "background": "#%02X%02X%02X" % background,
            "ink_ratio": round(ink_total / sampled, 4),
            "ink_rows_ratio": round(ink_rows / max(1, len(range(0, height, step_y))), 4),
            "content_bottom_ratio": content_bottom,
            "bottom_band_ink_ratio": round(bottom_ink / max(1, sampled * BOTTOM_BAND), 4),
            "distinct_colours": len(colours),
        }


def page_number(name: str, fallback: int) -> int:
    matched = re.search(r"(\d+)", name)
    return int(matched.group(1)) if matched else fallback


def collect(paths: list[str]) -> list[str]:
    files: list[str] = []
    for path in paths:
        if os.path.isdir(path):
            for name in sorted(os.listdir(path)):
                if re.match(r"^slide[-_]?\d+\.png$", name, re.IGNORECASE):
                    files.append(os.path.join(path, name))
        elif os.path.isfile(path):
            files.append(path)
    return files


def flags_for(page: dict) -> list[dict]:
    """Deterministic, evidence-bearing flags. Every one carries its measurement."""
    flags: list[dict] = []
    if page["ink_ratio"] < EMPTY_INK_RATIO:
        flags.append({
            "code": "PAGE_MOSTLY_EMPTY",
            "detail": f"only {page['ink_ratio'] * 100:.1f}% of the page carries ink",
        })
    if page["content_bottom_ratio"] and page["content_bottom_ratio"] < EMPTY_BOTTOM_RATIO:
        flags.append({
            "code": "CONTENT_STOPS_HIGH",
            "detail": f"content stops at {page['content_bottom_ratio'] * 100:.0f}% of page height",
        })
    if page["distinct_colours"] < FLAT_COLOUR_COUNT:
        flags.append({
            "code": "FLAT_PAGE",
            "detail": f"only {page['distinct_colours']} distinct colours rendered",
        })
    return flags


def main(argv: list[str]) -> int:
    parser = argparse.ArgumentParser(description="Deterministic pixel metrics for rendered slides.")
    parser.add_argument("paths", nargs="+", help="directory of slide-*.png, or png files")
    parser.add_argument("--json", dest="json_out", help="also write the report here")
    parser.add_argument("--quiet", action="store_true")
    args = parser.parse_args(argv)

    files = collect(args.paths)
    if not files:
        print(json.dumps({"ok": False, "error": "no slide PNG found", "paths": args.paths}))
        return 1

    pages: list[dict] = []
    for index, path in enumerate(files):
        try:
            metrics = measure(path)
        except Exception as error:  # noqa: BLE001 - report, never crash a delivery
            pages.append({"page": index + 1, "file": os.path.basename(path), "error": str(error), "flags": []})
            continue
        metrics["page"] = page_number(metrics["file"], index + 1)
        metrics["flags"] = flags_for(metrics)
        pages.append(metrics)

    measured = [page for page in pages if "ink_ratio" in page]
    averages = {}
    if measured:
        for key in ("ink_ratio", "content_bottom_ratio", "bottom_band_ink_ratio", "distinct_colours"):
            averages[key] = round(sum(page[key] for page in measured) / len(measured), 4)

    report = {
        "ok": True,
        "renderer": "pixels",
        "pages": pages,
        "averages": averages,
        "thresholds": {
            "empty_ink_ratio": EMPTY_INK_RATIO,
            "empty_bottom_ratio": EMPTY_BOTTOM_RATIO,
            "flat_colour_count": FLAT_COLOUR_COUNT,
            "ink_threshold": INK_THRESHOLD,
        },
        "page_flags": [
            {"page": page["page"], "code": flag["code"], "detail": flag["detail"]}
            for page in pages
            for flag in page.get("flags", [])
        ],
    }
    if args.json_out:
        with open(args.json_out, "w", encoding="utf-8") as handle:
            json.dump(report, handle, ensure_ascii=False, indent=2)
    if not args.quiet:
        print(json.dumps(report, ensure_ascii=False))
    return 0


if __name__ == "__main__":
    raise SystemExit(main(sys.argv[1:]))
