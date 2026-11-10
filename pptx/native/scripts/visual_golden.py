#!/usr/bin/env python
"""Lock the rendered look of every fixture deck, so a change that moves pixels is noticed.

The structural checks compare the engine with the analyzer, and the text-fit audit compares the
estimate with a renderer, but nothing watched the picture itself: a gradient that flips
direction, a shadow that loses its offset, a z-order that swaps, an image cropped from the wrong
origin, or a colour that shifts by ten points all pass every other test.

This renders each fixture with LibreOffice and fingerprints every page three ways:

  * a 64-bit difference hash of the luminance, which is stable against antialiasing and
    sensitive to anything that moves
  * an 8x5 grid of mean RGB, which catches a colour or emphasis change that the hash averages
    away
  * a digest of the words the renderer actually drew

The third one exists because the first two cannot see a word. A list that numbered every item
1 instead of 1, 2, 3 moves almost no pixels - the glyph is the same shape in the same place -
and it passed this gate, the text-fit audit and every structural test for as long as it existed.

    python scripts/visual_golden.py --update      # accept what is there now
    python scripts/visual_golden.py               # fail if a page moved

The baseline is a fingerprint, not a picture: it says "this page looked like this", not "this
page was drawn by these commands". Updating it is a decision - run `--update` only after looking
at the render and deciding the new picture is the one you want.
"""

from __future__ import annotations

import argparse
import base64
import hashlib
import json
import subprocess
import sys
import tempfile
from pathlib import Path

HERE = Path(__file__).resolve().parent
NATIVE = HERE.parent
EXAMPLES = NATIVE.parent / "examples"
BASELINE = NATIVE / "baselines" / "visual.json"
GRID = (24, 14)  # colour cells: fine enough that a 4px accent strip moves one


def find_soffice(explicit=None):
    import os

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


def fixtures():
    return sorted(path for path in EXAMPLES.glob("pipeline-*.html"))


def build(html, workdir):
    stem = html.stem
    deck = workdir / (stem + ".pptx")
    result = subprocess.run(
        ["node", str(NATIVE / "pipeline" / "cli.js"), str(html), "--pptx", str(deck)],
        cwd=str(NATIVE),
        stdout=subprocess.PIPE,
        stderr=subprocess.STDOUT,
        text=True,
    )
    if not deck.exists():
        print("  build failed for " + html.name + ":\n" + result.stdout[-1500:])
        return None
    return deck


def render_pages(deck, soffice, workdir):
    """Every page of the deck as a PIL image and as words, via a PDF."""
    import pymupdf
    import pypdfium2 as pdfium

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
    pdf_path = workdir / (deck.stem + ".pdf")
    if not pdf_path.exists():
        raise SystemExit("LibreOffice did not produce a PDF:\n" + result.stdout)
    # The words come from the same PDF, read separately: pypdfium2 renders, pymupdf reads the
    # text layer, and the drawing is not part of the text.
    words = pymupdf.open(str(pdf_path))
    texts = [" ".join(words[index].get_text("text").split()) for index in range(len(words))]
    pages = []
    document = pdfium.PdfDocument(str(pdf_path))
    try:
        for index in range(len(document)):
            page = document[index]
            scale = 96 / 72
            bitmap = page.render(scale=scale)
            pages.append(bitmap.to_pil().convert("RGB"))
            bitmap.close()
            page.close()
    finally:
        document.close()
    words.close()
    if len(texts) != len(pages):
        raise SystemExit("the PDF has " + str(len(pages)) + " page(s) but " + str(len(texts)) + " text layers")
    return pages, texts


def fingerprint(image, text=""):
    """A difference hash plus a colour grid.

    The hash is stable against antialiasing and sensitive to anything that moves; the grid is
    what catches a colour change on a thin element, where a luminance hash and a coarse average
    both look the same. A 4px accent strip is 1/53 of a 24x14 cell, so the grid has to be this
    fine to see it at all.
    """
    small = image.convert("L").resize((9, 8), 1)
    pixels = small.tobytes()
    bits = 0
    for row in range(8):
        for column in range(8):
            left = pixels[row * 9 + column]
            right = pixels[row * 9 + column + 1]
            bits = (bits << 1) | (1 if left > right else 0)
    cells = base64.b64encode(image.resize(GRID, 1).tobytes()).decode("ascii")
    digest = hashlib.sha1(text.encode("utf-8")).hexdigest()[:16]
    return {"hash": format(bits, "016x"), "cells": cells, "words": digest, "count": len(text.split())}


def distance(a, b):
    """How far apart two fingerprints are: bits that flipped, and the worst colour step."""
    if len(a["hash"]) != len(b["hash"]) or len(a["cells"]) != len(b["cells"]):
        return 64, 255
    hamming = bin(int(a["hash"], 16) ^ int(b["hash"], 16)).count("1")
    left = base64.b64decode(a["cells"])
    right = base64.b64decode(b["cells"])
    worst = max(abs(x - y) for x, y in zip(left, right))
    return hamming, worst


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--update", action="store_true")
    parser.add_argument("--soffice", default=None)
    parser.add_argument("--only", default=None)
    parser.add_argument("--max-bits", type=int, default=8)
    parser.add_argument("--max-cell", type=int, default=10)
    args = parser.parse_args()

    soffice = find_soffice(args.soffice)
    previous = json.loads(BASELINE.read_text(encoding="utf-8")) if BASELINE.exists() else {}
    current = {}
    problems = []

    with tempfile.TemporaryDirectory() as tmp:
        root = Path(tmp)
        for html in fixtures():
            if args.only and args.only not in html.name:
                continue
            deck = build(html, root)
            if deck is None:
                problems.append(html.name + ": the deck did not build")
                continue
            pages, texts = render_pages(deck, soffice, root)
            prints = [fingerprint(page, text) for page, text in zip(pages, texts)]
            current[html.name] = prints
            print("== " + html.name + " (" + str(len(prints)) + " page(s), "
                  + str(pages[0].size[0]) + "x" + str(pages[0].size[1]) + ")")
            before = previous.get(html.name)
            if args.update:
                continue
            if not before:
                # A fixture nobody photographed is not a fixture this gate can hold: accepting
                # it silently let a new deck skip the comparison for as long as it existed.
                problems.append(html.name + ': no baseline yet - look at the pages, then run'
                                ' --update' )
                continue
            if len(before) != len(prints):
                problems.append(html.name + ": " + str(len(prints)) + " page(s), baseline had " + str(len(before)))
                continue
            for number, (old, new) in enumerate(zip(before, prints), start=1):
                bits, cell = distance(old, new)
                if bits > args.max_bits or cell > args.max_cell:
                    problems.append(
                        html.name + " page " + str(number) + ": moved by " + str(bits)
                        + " bit(s), colour by " + str(cell)
                    )
                # A word counts even when no pixel moves: the numbering bug drew the same
                # glyph in the same place for every item of a list.
                if old.get("words") != new.get("words"):
                    problems.append(
                        html.name + " page " + str(number) + ": the words changed ("
                        + str(old.get("count", "?")) + " -> " + str(new.get("count", "?")) + " words)"
                    )

    if args.update:
        BASELINE.parent.mkdir(parents=True, exist_ok=True)
        BASELINE.write_text(json.dumps(current, indent=1, sort_keys=True) + "\n", encoding="utf-8")
        pages_total = sum(len(entry) for entry in current.values())
        print("")
        print("baseline written: " + str(len(current)) + " deck(s), " + str(pages_total) + " page(s)")
        return 0

    if problems:
        print("")
        print("LOOK HAS CHANGED:")
        for problem in problems:
            print("  - " + problem)
        return 1
    if not previous:
        print("no baseline yet: run with --update to accept the current look")
        return 1
    print("")
    print("look unchanged: " + str(len(current)) + " deck(s), "
          + str(sum(len(entry) for entry in current.values())) + " page(s)")
    return 0


if __name__ == "__main__":
    sys.exit(main())
