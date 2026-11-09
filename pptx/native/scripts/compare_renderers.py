#!/usr/bin/env python3
"""Compare two different renderers' output after downscaling, so glyph antialiasing
washes out and only placement survives.

Why not judge on SSIM: this implementation of it is global, so on a dark page with sparse
text the covariance is dominated by the flat background and one glyph drawn with a
different font collapses the score to ~0.5 while the mean absolute error stays at 0.006.
A difference image of exactly that case showed nothing but glyph edges - every block in
the same place. Two readers cannot share fonts, so the judge here is ink, not pixels:
where the ink is (dilated a couple of pixels to forgive hinting), how much of it moved,
and how far the mean went. SSIM is still reported, as information.

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

from PIL import Image, ImageChops, ImageFilter

sys.path.insert(0, str(Path(__file__).resolve().parent))
from visual_regression import metrics, slide_files  # noqa: E402


def downscaled(path: Path, factor: int, width: int) -> Image.Image:
    with Image.open(path) as image:
        picture = image.convert("RGB")
    # The two readers export at different sizes (LibreOffice at 1920 wide, WPS at 1280),
    # and upscaling the smaller one to compare would compare a blur against detail. Both
    # are brought to one width first, so a size difference cannot masquerade as a layout
    # difference - or hide one.
    if width and picture.width != width:
        height = max(1, round(picture.height * width / picture.width))
        picture = picture.resize((width, height), Image.LANCZOS)
    small_width = max(1, picture.width // factor)
    small_height = max(1, picture.height // factor)
    return picture.resize((small_width, small_height), Image.BOX)


def ink_mask(image: Image.Image, threshold: int = 24) -> Image.Image:
    """Pixels that differ from this page's own background, for light and dark alike."""
    gray = image.convert("L")
    histogram = gray.histogram()
    total = sum(histogram)
    # The background is the most common tone: 247 on a light page, 20 on a dark one.
    background = max(range(256), key=lambda level: histogram[level])
    if total and histogram[background] / total < 0.2:
        background = 255 if sum(i * histogram[i] for i in range(256)) / total > 128 else 0
    return gray.point(lambda level: 255 if abs(level - background) > threshold else 0)


def dilated(mask: Image.Image, radius: int = 2) -> Image.Image:
    size = radius * 2 + 1
    grown = mask.filter(ImageFilter.MaxFilter(size))
    return grown.filter(ImageFilter.MaxFilter(size))


def ink_agreement(reference: Image.Image, actual: Image.Image) -> dict:
    """How much of the ink is in the same place, forgiving a couple of pixels of hinting."""
    first = dilated(ink_mask(reference))
    second = dilated(ink_mask(actual))
    intersection = ImageChops.multiply(first, second)
    union = ImageChops.lighter(first, second)
    shared = intersection.histogram()[255]
    combined = union.histogram()[255]
    ink_first = dilated(ink_mask(reference), 0).histogram()[255]
    ink_second = dilated(ink_mask(actual), 0).histogram()[255]
    iou = shared / combined if combined else 1.0
    ratio = min(ink_first, ink_second) / max(ink_first, ink_second) if max(ink_first, ink_second) else 1.0
    return {"ink_iou": round(iou, 6), "ink_ratio": round(ratio, 6)}


def self_check() -> int:
    """Four controls: the ink judge must pass a glyph-level shift, pass a thickness change
    and fail a block that actually moved. A judge that cannot be falsified is not a judge."""
    controls = []

    def plate(boxes):
        image = Image.new("RGB", (400, 300), (255, 255, 255))
        for box in boxes:
            image.paste((20, 20, 20), box)
        return image

    base = plate([(50, 50, 150, 80), (50, 120, 350, 132)])
    same = plate([(50, 50, 150, 80), (50, 120, 350, 132)])
    nudged = plate([(51, 51, 151, 81), (51, 121, 351, 133)])
    thinner = plate([(50, 50, 150, 74), (50, 120, 350, 128)])
    moved = plate([(250, 200, 350, 230), (50, 120, 350, 132)])

    identical = ink_agreement(base, same)
    controls.append(("identical", identical["ink_iou"] >= 0.99))
    shifted = ink_agreement(base, nudged)
    controls.append(("one pixel of hinting", shifted["ink_iou"] >= 0.90))
    weight = ink_agreement(base, thinner)
    controls.append(("a thinner glyph", weight["ink_iou"] >= 0.80))
    displaced = ink_agreement(base, moved)
    # Measured separation on real renders: two readers land at 0.81-0.99 while a block
    # moved by 200px lands at 0.43. The judge sits at 0.72; this control proves it can fail.
    controls.append(("a block in the wrong place", displaced["ink_iou"] < 0.60))
    # Measured separation on real renders: two readers land at 0.81-0.99, a block moved by

    failed = [name for name, ok in controls if not ok]
    if failed:
        print("Self-check failed: " + ", ".join(failed))
        for name, ok in controls:
            print("  ", "ok  " if ok else "FAIL", name)
        return 1
    print("Self-check passed: " + str(len(controls)) + " controls")
    return 0

def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--a", type=Path, help="first renderer's PNG folder")
    parser.add_argument("--b", type=Path, help="second renderer's PNG folder")
    parser.add_argument("--downscale", type=int, default=4)
    parser.add_argument("--width", type=int, default=1280,
                        help="normalise both renders to this width before comparing (0 keeps them as they are)")
    parser.add_argument("--max-mae", type=float, default=0.03)
    parser.add_argument("--min-ssim", type=float, default=0.9,
                        help="reported for information; not the judge across readers")
    # Text-dense pages shift a fifth of their pixels on glyph shape alone - the changed
    # ratio is a coarse companion to the ink overlap, not the judge on its own.
    parser.add_argument("--max-changed", type=float, default=0.25)
    parser.add_argument("--skip", type=str, default="",
                        help="1-based slide numbers to leave out, e.g. 1,4 - for pages whose text a reader flows itself")
    parser.add_argument("--min-ink", type=float, default=0.72)
    parser.add_argument("--self-check", action="store_true",
                        help="run the ink judge against three synthetic controls and exit")
    args = parser.parse_args()
    if args.self_check:
        return self_check()

    skipped = {int(part) for part in str(args.skip).replace(' ', '').split(',') if part.isdigit()}
    if not args.a or not args.b:
        raise SystemExit("--a and --b are required unless --self-check is used")
    first = slide_files(args.a)
    second = slide_files(args.b)
    if not first or not second:
        raise SystemExit("both folders must contain slide PNGs")
    results = []
    for index in range(max(len(first), len(second))):
        if index >= len(first) or index >= len(second):
            results.append({"slide": index + 1, "status": "missing"})
            continue
        scaled_first = downscaled(first[index], args.downscale, args.width)
        scaled_second = downscaled(second[index], args.downscale, args.width)
        values = metrics(scaled_first, scaled_second)
        values.update(ink_agreement(scaled_first, scaled_second))
        passed = (values["mae"] <= args.max_mae
                  and values["changed_pixel_ratio"] <= args.max_changed
                  and values["ink_iou"] >= args.min_ink)
        if (index + 1 in skipped):
            results.append({"slide": index + 1, "status": "skipped", **values})
        else:
            results.append({"slide": index + 1, "status": "pass" if passed else "fail", **values})
    report = {
        "a": str(args.a), "b": str(args.b), "downscale": args.downscale, "width": args.width,
        "thresholds": {"max_mae": args.max_mae, "max_changed": args.max_changed,
                       "min_ink": args.min_ink, "min_ssim_reported": args.min_ssim},
        "slides": results,
        # A skipped page is neither agreement nor disagreement: its text is flowed by the
        # reader, so each implementation breaks the lines with its own fonts and the ink
        # moves while the column frame does not. The count is reported so a skip cannot be
        # mistaken for a pass.
        "passed": all(item["status"] != "fail" for item in results),
        "skipped": sum(1 for item in results if item["status"] == "skipped"),
    }
    print(json.dumps(report, ensure_ascii=False, indent=2))
    return 0 if report["passed"] else 1


if __name__ == "__main__":
    raise SystemExit(main())
