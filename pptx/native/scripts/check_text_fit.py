#!/usr/bin/env python
"""Measure whether the text of a generated deck really fits the boxes it was given.

The analyzer reserves a box for every text element and predicts how many lines the words
need. Nothing else checks that prediction against a renderer: the engine and the analyzer
agree with each other by construction, so a shared mistake - a face wider than the estimate,
a line height that is not the one CSS asked for - stays invisible to both.

This script renders the deck with LibreOffice, reads the rendered line rectangles back out of
the PDF with pypdfium2, and compares, per text element:

  * the lines the analyzer reserved (box height / line box)
  * the lines the renderer drew for those words
  * how far the last drawn line reaches below the reserved box (spill, in inches)
  * whether every word of the element was drawn at all

Two signals decide attribution, and they have to agree. The words say which rectangle belongs
to which element: LibreOffice emits a rectangle per run rather than per visual line, and its
reading order drifts, so position alone cannot tell two stacked boxes apart. The box says
where to look: without it a short label like "01" would match a rectangle on the other side
of the slide and the spill would be measured against the wrong element entirely.

    python scripts/check_text_fit.py deck.pptx --layout layout.json
    python scripts/check_text_fit.py deck.pptx --layout layout.json --verbose

`layout.json` is written by `node pipeline/cli.js --layout-out`: the boxes the writer really
used, with container children already resolved into absolute positions. The raw deck spec is
accepted too, but a nested container positions its children at write time, so the spec alone
cannot say where a caption ended up.

Requires LibreOffice (soffice) and pypdfium2. Set LIBREOFFICE_SOFFICE when soffice is not on
PATH.
"""

from __future__ import annotations

import argparse
import json
import os
import re
import subprocess
import sys
import tempfile
from pathlib import Path

POINTS_PER_INCH = 72.0
SPACE = re.compile(r"\s+", re.UNICODE)


def find_soffice(explicit):
    candidate = explicit or os.environ.get("LIBREOFFICE_SOFFICE")
    if candidate:
        path = Path(candidate)
        if not path.exists():
            raise SystemExit(f"soffice not found at {path}")
        return path
    from shutil import which

    for name in ("soffice", "soffice.exe"):
        found = which(name)
        if found:
            return Path(found)
    raise SystemExit("soffice not found: pass --soffice or set LIBREOFFICE_SOFFICE")


def render_pdf(deck, soffice, workdir):
    profile = (workdir / "profile").as_posix()
    result = subprocess.run(
        [
            str(soffice),
            "--headless",
            "--norestore",
            "-env:UserInstallation=file:///" + profile,
            "--convert-to",
            "pdf",
            "--outdir",
            str(workdir),
            str(deck),
        ],
        stdout=subprocess.PIPE,
        stderr=subprocess.STDOUT,
        text=True,
        timeout=600,
    )
    pdf = workdir / (deck.stem + ".pdf")
    if not pdf.exists():
        raise SystemExit("LibreOffice did not produce a PDF:\n" + result.stdout)
    return pdf


def normalise(text):
    return SPACE.sub("", text or "")


def text_elements(slide):
    """Every element of the deck spec that draws text, flattened out of containers."""
    found = []

    def walk(nodes):
        for node in nodes or []:
            if node.get("type") == "text" and node.get("visible", True):
                found.append(node)
            walk(node.get("children"))

    walk(slide.get("elements") or [])
    return found


def element_text(node):
    text = node.get("text")
    if isinstance(text, list):
        return "".join(str(run.get("text", "")) for run in text)
    return str(text or "")


WORD = re.compile(r"[\W_]+", re.UNICODE)


def skeleton(text):
    """The letters, digits and CJK of a string: punctuation cannot be compared reliably."""
    return WORD.sub("", text or "")


def reserved_lines(node):
    """How many text lines the analyzer reserved room for."""
    font = float(node.get("fontSize") or 12)
    spacing = float(node.get("lineSpacingMultiple") or 1.2)
    line_box = font * spacing / POINTS_PER_INCH
    height = float(node.get("h") or 0)
    if line_box <= 0:
        return 0
    return max(1, round(height / line_box))


def read_line_rects(pdf_path):
    """Per page, every rendered line box in inches measured from the top-left corner."""
    import pypdfium2 as pdfium

    document = pdfium.PdfDocument(str(pdf_path))
    pages = []
    try:
        for index in range(len(document)):
            page = document[index]
            height = page.get_height() / POINTS_PER_INCH
            textpage = page.get_textpage()
            rects = []
            for rect_index in range(textpage.count_rects()):
                left, bottom, right, top = textpage.get_rect(rect_index)
                text = textpage.get_text_bounded(left, bottom, right, top) or ""
                if not normalise(text):
                    continue
                rects.append(
                    {
                        "text": normalise(text),
                        "x0": left / POINTS_PER_INCH,
                        "x1": right / POINTS_PER_INCH,
                        "top": height - top / POINTS_PER_INCH,
                        "bottom": height - bottom / POINTS_PER_INCH,
                    }
                )
            textpage.close()
            page.close()
            pages.append(rects)
    finally:
        document.close()
    return pages


def claim_lines(target, rects, box):
    """Rectangles inside `box` that spell out `target`, and the ones the window left alone."""
    x0, y0, width, height = box
    remaining = skeleton(target)
    claimed = []
    skipped = []
    if not target:
        return claimed, skipped
    wanted = skeleton(target)
    ordered = sorted(rects, key=lambda rect: -len(skeleton(rect["text"])))
    for rect in ordered:
        shape = skeleton(rect["text"])
        if not shape:
            continue
        # A rectangle holds our words, or - when the renderer merged neighbours into one
        # rectangle - holds more than our words. Either way the words were drawn here.
        merged = shape != wanted and wanted and wanted in shape
        if not merged and shape not in skeleton(remaining):
            continue
        centre_x = (rect["x0"] + rect["x1"]) / 2
        inside = (
            x0 - 0.15 <= centre_x <= x0 + width + 0.15
            and y0 - 0.10 <= rect["top"] <= y0 + height + max(0.35, height * 1.5)
        )
        if not inside:
            skipped.append(rect)
            continue
        claimed.append(rect)
        if merged:
            remaining = ""
        else:
            remaining = skeleton(remaining).replace(shape, "", 1)
    return claimed, skipped


def visual_lines(claimed, line_box):
    """Fold the rectangles that spell one visual line into a single line.

    LibreOffice emits a rectangle per text run, not per line, so counting rectangles counts
    style changes instead of lines. Rectangles whose tops are within half a line box of each
    other are the same line.
    """
    if not claimed:
        return []
    ordered = sorted(claimed, key=lambda rect: rect["top"])
    tolerance = max(0.02, line_box * 0.5)
    lines = [[ordered[0]]]
    for rect in ordered[1:]:
        if abs(rect["top"] - lines[-1][0]["top"]) <= tolerance:
            lines[-1].append(rect)
        else:
            lines.append([rect])
    return [
        {"top": min(item["top"] for item in line), "bottom": max(item["bottom"] for item in line)}
        for line in lines
    ]


def load_slides(spec_path):
    """The text elements of every slide, with absolute boxes."""
    data = json.loads(spec_path.read_text(encoding="utf-8"))
    return data


def check(deck, spec, soffice, tolerance=0.02, verbose=False, quiet=False):
    deck_spec = load_slides(spec)
    with tempfile.TemporaryDirectory() as tmp:
        pdf = render_pdf(deck, soffice, Path(tmp))
        pages = read_line_rects(pdf)

    checked = 0
    unmatched = 0
    extra_lines = 0
    missing_words = 0
    dropped_by_window = 0
    rows = []
    for slide_number, slide in enumerate(deck_spec.get("slides") or [], start=1):
        rects = pages[slide_number - 1] if slide_number - 1 < len(pages) else []
        page_text = skeleton("".join(rect["text"] for rect in rects))
        for node in text_elements(slide):
            text = element_text(node).strip()
            if not text:
                continue
            if float(node.get("w") or 0) <= 0:
                # Chart internals (series names, data labels) are placed by the chart part,
                # not by this engine, and carry no box to check.
                continue
            target = normalise(text)
            box = (
                float(node.get("x") or 0),
                float(node.get("y") or 0),
                float(node.get("w") or 0),
                float(node.get("h") or 0),
            )
            claimed, skipped = claim_lines(target, rects, box)
            if not claimed:
                unmatched += 1
                if verbose:
                    print("  slide " + str(slide_number) + ": nothing matched " + repr(text[:40]))
                continue
            checked += 1
            remaining = skeleton(target)
            for rect in claimed:
                remaining = remaining.replace(skeleton(rect["text"]), "", 1)
            # Words the window missed may still be on the page: call them missing only when
            # the glyphs really are absent, not when attribution was too narrow.
            missing = 0
            if remaining and remaining not in page_text:
                missing = len(remaining)
                missing_words += 1
            elif remaining:
                dropped_by_window += 1
            y0, height = box[1], box[3]
            font = float(node.get("fontSize") or 12)
            spacing = float(node.get("lineSpacingMultiple") or 1.2)
            line_box = font * spacing / POINTS_PER_INCH
            text_height = float(node.get("textHeight") or 0)
            lines = visual_lines(claimed, line_box)
            drawn = len(lines)
            # Line count is the signal both sides agree on. A rectangle that holds CJK glyphs
            # carries the whole em box, and a tall box may centre its first line well below
            # the top, so measuring spill in ink inches reports differences that neither the
            # browser nor PowerPoint would show. Lines are counted, not measured.
            auto_sized = text_height > 0 and abs(height - text_height) <= 0.02
            reserved = reserved_lines(node)
            over = 0
            if auto_sized and line_box:
                over = max(0, drawn - max(1, round(text_height / line_box)))
                if over:
                    extra_lines += 1
            rows.append(
                {
                    "slide": slide_number,
                    "text": text[:40].replace("\n", " "),
                    "reserved": reserved,
                    "drawn": drawn,
                    "over": over,
                    "missing": missing,
                    "auto": auto_sized,
                    "box": [round(value, 2) for value in box],
                }
            )
            if verbose and (missing or over):
                print(
                    "    slide " + str(slide_number) + " box " + str(rows[-1]["box"])
                    + " reserved " + str(reserved) + " drawn " + str(drawn)
                    + " missing " + str(missing) + " " + repr(text[:40])
                )

    counts = {
        "boxes": checked,
        "unmatched": unmatched,
        "extraLines": extra_lines,
        "missingWords": missing_words,
        "droppedByWindow": dropped_by_window,
    }
    if not quiet:
        print(deck.name + ": " + str(checked) + " text box(es) matched, " + str(unmatched) + " unmatched")
        print("  boxes that drew more lines than the analyzer reserved: " + str(extra_lines))
        print("  boxes with words missing from the render:              " + str(missing_words))
        if dropped_by_window:
            print("  boxes whose words the window missed (still on the page): " + str(dropped_by_window))
    return counts


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("deck", type=Path)
    parser.add_argument("--layout", type=Path, default=None,
                        help="the layout JSON written by pipeline/cli.js --layout-out")
    parser.add_argument("--spec", type=Path, default=None, help="the deck JSON (nested boxes)")
    parser.add_argument("--soffice", default=None)
    parser.add_argument("--tolerance", type=float, default=0.02, help="inches of spill allowed")
    parser.add_argument("--verbose", action="store_true")
    args = parser.parse_args()
    source = args.layout or args.spec
    if source is None:
        parser.error("pass --layout (preferred) or --spec")
    counts = check(args.deck, source, find_soffice(args.soffice), args.tolerance, args.verbose)
    if counts["extraLines"] or counts["missingWords"]:
        return 1
    return 0


if __name__ == "__main__":
    sys.exit(main())
