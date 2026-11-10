#!/usr/bin/env python3
"""Open a deck with python-pptx: a third, spec-driven reader that is not LibreOffice or WPS.

Two readers agreeing on where the ink is says the shapes are placed alike. It does not say the
package is well formed, because both readers are forgiving in their own ways. python-pptx parses
the OOXML parts by the book - a missing relationship, a shape without a geometry, a chart whose
`c:ser` has no `c:cat` raises there - so it is the closest thing to "would PowerPoint offer to
repair this" that runs on this machine. It is also the only check that reads the *chart* parts
back into numbers.

The round trip matters as much as the open: a deck another implementation can open, rewrite and
still describe the same number of objects is a deck whose structure survives editing.

Usage:
    python scripts/verify_with_python_pptx.py --deck a.pptx [--deck b.pptx ...] [--round-trip]
    python scripts/verify_with_python_pptx.py --dir pipeline-converted
"""

from __future__ import annotations

import argparse
import io
import json
import sys
import tempfile
from pathlib import Path

from pptx import Presentation
from pptx.enum.shapes import MSO_SHAPE_TYPE


def shape_counts(slide) -> dict:
    """Shapes by kind, walking into groups: a group is one shape to a reader, several to a design."""
    counts = {"shapes": 0, "pictures": 0, "charts": 0, "tables": 0, "groups": 0,
              "text_shapes": 0, "text_characters": 0, "rotated": 0, "titles": 0}
    # A slide whose heading is a plain text box has no title: no outline entry, no
    # accessibility name, and nothing for `Reset slide` to reset.
    if slide.shapes.title is not None:
        counts["titles"] = 1
    stack = list(slide.shapes)
    while stack:
        shape = stack.pop()
        counts["shapes"] += 1
        if shape.shape_type == MSO_SHAPE_TYPE.GROUP:
            counts["groups"] += 1
            stack.extend(shape.shapes)
            continue
        if shape.shape_type == MSO_SHAPE_TYPE.PICTURE:
            counts["pictures"] += 1
        if getattr(shape, "has_chart", False) and shape.has_chart:
            counts["charts"] += 1
        if getattr(shape, "has_table", False) and shape.has_table:
            counts["tables"] += 1
        if getattr(shape, "has_text_frame", False) and shape.has_text_frame:
            counts["text_shapes"] += 1
            counts["text_characters"] += len(shape.text_frame.text)
        if getattr(shape, "rotation", None):
            counts["rotated"] += 1
    return counts


def chart_facts(slide) -> list:
    """What the chart part says when read back: type, series and their point counts."""
    facts = []
    for shape in slide.shapes:
        if not (getattr(shape, "has_chart", False) and shape.has_chart):
            continue
        chart = shape.chart
        plots = list(chart.plots)
        series = []
        for plot in plots:
            for entry in plot.series:
                values = list(entry.values)
                series.append({"name": entry.name, "points": len(values),
                               "numbers": sum(1 for value in values if value is not None)})
        facts.append({"chart_type": str(chart.chart_type).split(" ")[0],
                      "plots": len(plots), "series": series,
                      "title": bool(chart.has_title)})
    return facts


def describe(path: Path, round_trip: bool) -> dict:
    report = {"deck": str(path), "opened": False, "slides": 0,
              "totals": {}, "charts": [], "problems": []}
    try:
        presentation = Presentation(str(path))
    except Exception as error:  # noqa: BLE001 - any parse failure is the finding
        report["problems"].append(f"python-pptx cannot open it: {error}")
        return report
    report["opened"] = True
    report["slides"] = len(presentation.slides)
    totals = {"shapes": 0, "pictures": 0, "charts": 0, "tables": 0, "groups": 0,
              "text_shapes": 0, "text_characters": 0, "rotated": 0, "titles": 0}
    for index, slide in enumerate(presentation.slides, start=1):
        counts = shape_counts(slide)
        if counts["titles"] and not slide.shapes.title.text.strip():
            report["problems"].append(f"slide {index}: the title placeholder is empty")
        for key, value in counts.items():
            totals[key] += value
        facts = chart_facts(slide)
        for entry in facts:
            report["charts"].append({"slide": index, **entry})
        empty_series = [entry for entry in facts for entry in entry["series"] if entry["points"] == 0]
        if empty_series:
            report["problems"].append(f"slide {index}: a chart series has no points")
    report["totals"] = totals
    if not report["problems"] and totals["shapes"] == 0:
        report["problems"].append("the deck describes no shapes at all")
    if round_trip and not report["problems"]:
        buffer = io.BytesIO()
        try:
            presentation.save(buffer)
            buffer.seek(0)
            again = Presentation(buffer)
        except Exception as error:  # noqa: BLE001
            report["problems"].append(f"round trip failed: {error}")
            return report
        if len(again.slides) != report["slides"]:
            report["problems"].append(
                f"round trip lost slides: {report['slides']} became {len(again.slides)}")
        second = {"shapes": 0, "pictures": 0, "charts": 0, "tables": 0, "groups": 0,
                  "text_shapes": 0, "text_characters": 0, "rotated": 0, "titles": 0}
        for slide in again.slides:
            for key, value in shape_counts(slide).items():
                second[key] += value
        for key in ("charts", "tables", "pictures", "titles"):
            if second[key] != totals[key]:
                report["problems"].append(
                    f"round trip changed {key}: {totals[key]} became {second[key]}")
        report["round_trip"] = {"shapes": second["shapes"], "text_characters": second["text_characters"]}
    return report


def self_check(deck: Path) -> int:
    """Two controls: the deck opens clean, and a deliberately broken copy does not.

    A checker that cannot fail is not a checker. The broken copy loses a chart part's XML, which
    is exactly the kind of damage a hand-edited or truncated package carries.
    """
    good = describe(deck, True)
    if good["problems"]:
        print("self-check failed: the reference deck already has problems: " + "; ".join(good["problems"]))
        return 1
    import zipfile
    with tempfile.TemporaryDirectory() as folder:
        broken = Path(folder) / "broken.pptx"
        with zipfile.ZipFile(deck) as source, zipfile.ZipFile(broken, "w", zipfile.ZIP_DEFLATED) as target:
            names = source.namelist()
            victim = next((name for name in names if name.startswith("ppt/charts/chart") and name.endswith(".xml")), None)
            for name in names:
                if name == victim:
                    target.writestr(name, b"<c:chartSpace")  # truncated part
                else:
                    target.writestr(name, source.read(name))
            if victim is None:
                # No chart in the reference deck: truncate the slide instead.
                target.writestr("ppt/slides/slide1.xml", b"<p:sld")
        damaged = describe(broken, False)
    if not damaged["problems"]:
        print("self-check failed: a truncated part still looked clean")
        return 1
    print("Self-check passed: 2 controls (a clean deck opens, a truncated part is caught)")
    return 0


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--deck", action="append", default=[], help="a deck to check (repeatable)")
    parser.add_argument("--dir", nargs="*", default=[], help="folders to scan for *.pptx")
    parser.add_argument("--round-trip", action="store_true",
                        help="save the deck again through python-pptx and compare the object counts")
    parser.add_argument("--json", action="store_true", help="print the whole report")
    parser.add_argument("--only", default="", help="keep only decks whose name starts with this")
    parser.add_argument("--self-check", action="store_true",
                        help="prove the checker can fail, using the first --deck as the reference")
    args = parser.parse_args()

    decks = [Path(entry) for entry in args.deck]
    for folder in args.dir:
        decks.extend(sorted(Path(folder).glob((args.only or "") + "*.pptx")))
    if not decks:
        raise SystemExit("nothing to check: pass --deck or --dir")
    missing = [deck for deck in decks if not deck.exists()]
    if missing:
        raise SystemExit("no such deck: " + ", ".join(str(deck) for deck in missing))

    if args.self_check:
        return self_check(decks[0])

    reports = [describe(deck, args.round_trip) for deck in decks]
    if args.json:
        print(json.dumps({"decks": reports}, ensure_ascii=False, indent=2))
    else:
        for report in reports:
            state = "open" if report["opened"] else "FAILED"
            print(f"{Path(report['deck']).name:<34} {state:<7} slides {report['slides']:>2}  "
                  f"shapes {report['totals'].get('shapes', 0):>4}  "
                  f"charts {report['totals'].get('charts', 0):>2}  "
                  f"tables {report['totals'].get('tables', 0):>2}  "
                  f"pictures {report['totals'].get('pictures', 0):>3}  "
                  f"titles {report['totals'].get('titles', 0):>2}  "
                  f"chars {report['totals'].get('text_characters', 0):>5}")
            for problem in report["problems"]:
                print("    ! " + problem)
    failures = [report for report in reports if report["problems"]]
    if failures:
        print(f"\n{len(failures)} deck(s) have problems")
        return 1
    print(f"\n{len(reports)} deck(s) open cleanly"
          + (" and survive a round trip" if args.round_trip else ""))
    return 0


if __name__ == "__main__":
    sys.exit(main())
