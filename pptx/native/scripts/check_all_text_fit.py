#!/usr/bin/env python
"""Run the text-fit audit over every fixture deck and compare it with the recorded baseline.

`check_text_fit.py` answers the question for one deck. This runs it for all of them, keeps a
baseline of the counts and fails when a count gets worse, so a change that makes the estimate
disagree with a renderer more often cannot slip in unnoticed.

    python scripts/check_all_text_fit.py --write-baseline
    python scripts/check_all_text_fit.py

The baseline records, per deck, how many text boxes were matched, how many needed more lines
than the analyzer reserved, and how many words never reached the page. The numbers are a
property of this machine as much as of the engine - LibreOffice substitutes a face for any font
that is not installed, and a substituted CJK face is wider than the em - which is exactly why
they are baselined instead of asserted to zero.
"""

from __future__ import annotations

import argparse
import json
import subprocess
import sys
import tempfile
from pathlib import Path

HERE = Path(__file__).resolve().parent
NATIVE = HERE.parent
EXAMPLES = NATIVE.parent / "examples"
BASELINE = NATIVE / "baselines" / "text-fit.json"


def fixtures():
    return sorted(path for path in EXAMPLES.glob("pipeline-*.html"))


def build(html, workdir):
    stem = html.stem
    deck = workdir / (stem + ".pptx")
    layout = workdir / (stem + "-layout.json")
    result = subprocess.run(
        [
            "node",
            str(NATIVE / "pipeline" / "cli.js"),
            str(html),
            "--out",
            str(workdir / (stem + ".json")),
            "--pptx",
            str(deck),
            "--layout-out",
            str(layout),
        ],
        cwd=str(NATIVE),
        stdout=subprocess.PIPE,
        stderr=subprocess.STDOUT,
        text=True,
    )
    if not deck.exists() or not layout.exists():
        print("  build failed for " + html.name + ":\n" + result.stdout[-2000:])
        return None, None
    return deck, layout


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--write-baseline", action="store_true")
    parser.add_argument("--only", default=None, help="a substring of the fixture name")
    parser.add_argument("--deck", default=None, help="just this deck (path to the pptx)")
    args = parser.parse_args()

    sys.path.insert(0, str(HERE))
    from check_text_fit import check, find_soffice

    soffice = find_soffice(None)
    previous = {}
    if BASELINE.exists():
        previous = json.loads(BASELINE.read_text(encoding="utf-8"))

    current = {}
    problems = []
    with tempfile.TemporaryDirectory() as tmp:
        workdir = Path(tmp)
        for html in fixtures():
            if args.only and args.only not in html.name:
                continue
            deck, layout = build(html, workdir)
            if deck is None:
                problems.append(html.name + ": the deck did not build")
                continue
            print("== " + html.name)
            counts = check(deck, layout, soffice, 0.02, True)
            current[html.name] = counts
            before = previous.get(html.name)
            if before and not args.write_baseline:
                if counts["boxes"] < before.get("boxes", 0):
                    problems.append(
                        html.name + ": only " + str(counts["boxes"]) + " box(es) checked, baseline had "
                        + str(before.get("boxes"))
                    )
                if counts["extraLines"] > before.get("extraLines", 0):
                    problems.append(
                        html.name + ": " + str(counts["extraLines"]) + " box(es) needed an extra line, baseline had "
                        + str(before.get("extraLines"))
                    )
                if counts["missingWords"] > before.get("missingWords", 0):
                    problems.append(
                        html.name + ": " + str(counts["missingWords"]) + " box(es) lost words, baseline had "
                        + str(before.get("missingWords"))
                    )

    total = {
        "boxes": sum(entry["boxes"] for entry in current.values()),
        "extraLines": sum(entry["extraLines"] for entry in current.values()),
        "missingWords": sum(entry["missingWords"] for entry in current.values()),
    }
    print("")
    print("checked " + str(total["boxes"]) + " text box(es) across " + str(len(current)) + " deck(s)")
    print("  boxes that needed an extra line: " + str(total["extraLines"]))
    print("  boxes that lost words:           " + str(total["missingWords"]))

    if args.write_baseline:
        BASELINE.parent.mkdir(parents=True, exist_ok=True)
        BASELINE.write_text(json.dumps(current, indent=2, sort_keys=True) + "\n", encoding="utf-8")
        print("baseline written to " + str(BASELINE))
        return 0

    if problems:
        print("")
        print("WORSE THAN BASELINE:")
        for problem in problems:
            print("  - " + problem)
        return 1
    if not previous:
        print("no baseline yet: run with --write-baseline to record one")
    return 0


if __name__ == "__main__":
    sys.exit(main())
