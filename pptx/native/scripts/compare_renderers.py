#!/usr/bin/env python3
"""Compare two different renderers' output after downscaling, so glyph antialiasing
washes out and only placement survives.

Two renderers never produce identical pixels: text is hinted and anti-aliased
differently, so a same-renderer golden threshold (mean absolute error around 0.015) is
the wrong test for "did they agree". Downscaling by a factor averages a glyph down to a
few pixels, which leaves a real disagreement - a block in the wrong place, a missing
shape, different spacing - as the dominant signal.

Usage:
    python compare_renderers.py --a lorender/ --b wpsrender/ [--downscale 4]
"""

from __future__ import annotations

import argparse
import json
import sys
from pathlib import Path

from PIL import Image

sys.path.insert(0, str(Path(__file__).resolve().parent))
from visual_regression import metrics, slide_files  # noqa: E402


def downscaled(path: Path, factor: int) -> Image.Image:
    with Image.open(path) as image:
        picture = image.convert("RGB")
    width = max(1, picture.width // factor)
    height = max(1, picture.height // factor)
    return picture.resize((width, height), Image.BOX)


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--a", type=Path, required=True, help="first renderer's PNG folder")
    parser.add_argument("--b", type=Path, required=True, help="second renderer's PNG folder")
    parser.add_argument("--downscale", type=int, default=4)
    parser.add_argument("--max-mae", type=float, default=0.03)
    parser.add_argument("--min-ssim", type=float, default=0.9)
    args = parser.parse_args()

    first = slide_files(args.a)
    second = slide_files(args.b)
    if not first or not second:
        raise SystemExit("both folders must contain slide PNGs")
    results = []
    for index in range(max(len(first), len(second))):
        if index >= len(first) or index >= len(second):
            results.append({"slide": index + 1, "status": "missing"})
            continue
        values = metrics(downscaled(first[index], args.downscale),
                         downscaled(second[index], args.downscale))
        passed = values["mae"] <= args.max_mae and values["ssim"] >= args.min_ssim
        results.append({"slide": index + 1, "status": "pass" if passed else "fail", **values})
    report = {
        "a": str(args.a), "b": str(args.b), "downscale": args.downscale,
        "thresholds": {"max_mae": args.max_mae, "min_ssim": args.min_ssim},
        "slides": results,
        "passed": all(item["status"] == "pass" for item in results),
    }
    print(json.dumps(report, ensure_ascii=False, indent=2))
    return 0 if report["passed"] else 1


if __name__ == "__main__":
    raise SystemExit(main())
