#!/usr/bin/env python3
"""Compare rendered slide PNGs with committed golden images.

The comparator is deliberately conservative: it reports image-level drift and
produces per-slide heatmaps, but does not claim semantic understanding of text.
"""
from __future__ import annotations

import argparse
import json
import math
import re
import sys
from pathlib import Path
from PIL import Image, ImageChops, ImageEnhance, ImageStat


def slide_files(folder: Path) -> list[Path]:
    return sorted(
        (p for p in folder.glob("*.png") if p.is_file()),
        key=lambda p: [int(x) if x.isdigit() else x.lower()
                       for x in re.split(r"(\d+)", p.name)],
    )


def metrics(reference: Image.Image, actual: Image.Image) -> dict:
    if reference.size != actual.size:
        actual = actual.resize(reference.size, Image.Resampling.LANCZOS)
    ref = reference.convert("RGB")
    cur = actual.convert("RGB")
    diff = ImageChops.difference(ref, cur)
    stat = ImageStat.Stat(diff)
    mae = sum(stat.mean) / (3 * 255)
    rms = math.sqrt(sum(v * v for v in stat.rms) / 3) / 255
    gray_ref = ref.convert("L")
    gray_cur = cur.convert("L")
    a = ImageStat.Stat(gray_ref)
    b = ImageStat.Stat(gray_cur)
    mean_a, mean_b = a.mean[0], b.mean[0]
    var_a, var_b = a.var[0], b.var[0]
    mean_product = ImageStat.Stat(ImageChops.multiply(gray_ref, gray_cur)).mean[0]
    covariance = mean_product - mean_a * mean_b
    c1, c2 = 6.5025, 58.5225
    ssim = ((2 * mean_a * mean_b + c1) * (2 * covariance + c2)) / (
        (mean_a * mean_a + mean_b * mean_b + c1) * (var_a + var_b + c2)
    )
    gray_diff = ImageChops.difference(gray_ref, gray_cur)
    changed = sum(1 for value in gray_diff.histogram()[4:] for _ in range(value))
    total = ref.width * ref.height
    return {
        "mae": round(mae, 6),
        "rmse": round(rms, 6),
        "ssim": round(max(-1.0, min(1.0, ssim)), 6),
        "changed_pixel_ratio": round(changed / total, 6),
        "width": ref.width,
        "height": ref.height,
    }


def make_heatmap(reference: Image.Image, actual: Image.Image, output: Path) -> None:
    if reference.size != actual.size:
        actual = actual.resize(reference.size, Image.Resampling.LANCZOS)
    diff = ImageChops.difference(reference.convert("RGB"), actual.convert("RGB"))
    diff = ImageEnhance.Contrast(diff).enhance(4.0)
    diff.save(output)


def compare(baseline: Path, current: Path, output: Path,
            max_mae: float, min_ssim: float) -> dict:
    expected = slide_files(baseline)
    observed = slide_files(current)
    output.mkdir(parents=True, exist_ok=True)
    results = []
    count = max(len(expected), len(observed))
    for index in range(count):
        if index >= len(expected) or index >= len(observed):
            results.append({
                "slide": index + 1, "status": "missing",
                "baseline": expected[index].name if index < len(expected) else None,
                "actual": observed[index].name if index < len(observed) else None,
            })
            continue
        with Image.open(expected[index]) as ref, Image.open(observed[index]) as cur:
            values = metrics(ref, cur)
            heatmap = output / f"slide-{index + 1:03d}-diff.png"
            make_heatmap(ref, cur, heatmap)
        passed = values["mae"] <= max_mae and values["ssim"] >= min_ssim
        results.append({
            "slide": index + 1, "status": "pass" if passed else "fail",
            "baseline": expected[index].name, "actual": observed[index].name,
            "heatmap": heatmap.name, **values,
        })
    report = {
        "baseline_dir": str(baseline), "current_dir": str(current),
        "thresholds": {"max_mae": max_mae, "min_ssim": min_ssim},
        "passed": bool(results) and all(item["status"] == "pass" for item in results),
        "slide_count_baseline": len(expected),
        "slide_count_actual": len(observed),
        "slides": results,
    }
    (output / "visual-regression.json").write_text(
        json.dumps(report, ensure_ascii=False, indent=2) + "\n", encoding="utf-8"
    )
    rows = []
    for item in results:
        rows.append(
            "<tr><td>{slide}</td><td>{status}</td><td>{mae}</td>"
            "<td>{ssim}</td><td>{changed_pixel_ratio}</td><td>{heatmap}</td></tr>".format(
                slide=item["slide"], status=item["status"],
                mae=item.get("mae", "—"), ssim=item.get("ssim", "—"),
                changed_pixel_ratio=item.get("changed_pixel_ratio", "—"),
                heatmap=item.get("heatmap", "—"),
            )
        )
    html = ("<!doctype html><meta charset='utf-8'><title>Visual regression</title>"
            "<h1>Visual regression report</h1><p>Pass: {}</p>"
            "<table border='1' cellpadding='6'><tr><th>Slide</th><th>Status</th>"
            "<th>MAE ↓</th><th>SSIM ↑</th><th>Changed pixels</th><th>Diff</th></tr>{}</table>"
            .format(report["passed"], "".join(rows)))
    (output / "index.html").write_text(html, encoding="utf-8")
    return report


def self_test() -> None:
    from tempfile import TemporaryDirectory
    with TemporaryDirectory(prefix="ppt-visual-test-") as temp:
        root = Path(temp)
        baseline, current, output = root / "golden", root / "actual", root / "report"
        baseline.mkdir()
        current.mkdir()
        image = Image.new("RGB", (80, 60), "white")
        from PIL import ImageDraw
        ImageDraw.Draw(image).rectangle((10, 10, 30, 30), fill="black")
        image.save(baseline / "slide-1.png")
        shifted = Image.new("RGB", (80, 60), "white")
        ImageDraw.Draw(shifted).rectangle((15, 10, 35, 30), fill="black")
        shifted.save(current / "slide-1.png")
        report = compare(baseline, current, output, 0.0001, 0.999)
        assert report["slides"][0]["status"] == "fail", report
        assert (output / "slide-001-diff.png").is_file()
        assert (output / "visual-regression.json").is_file()
    print("Visual regression self-test passed (shifted geometry detected).")


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--baseline-dir", type=Path)
    parser.add_argument("--current-dir", type=Path)
    parser.add_argument("--output-dir", type=Path, default=Path("visual-regression"))
    parser.add_argument("--max-mae", type=float, default=0.015)
    parser.add_argument("--min-ssim", type=float, default=0.97)
    parser.add_argument("--update-baseline", action="store_true",
                        help="Copy current PNGs into baseline-dir (review before committing).")
    parser.add_argument("--self-test", action="store_true")
    args = parser.parse_args()
    if args.self_test:
        self_test()
        return 0
    if not args.baseline_dir or not args.current_dir:
        parser.error("--baseline-dir and --current-dir are required")
    if args.update_baseline:
        args.baseline_dir.mkdir(parents=True, exist_ok=True)
        for source in slide_files(args.current_dir):
            Image.open(source).save(args.baseline_dir / source.name)
        print(f"Updated golden images in {args.baseline_dir}; review and commit them.")
        return 0
    report = compare(args.baseline_dir, args.current_dir, args.output_dir,
                     args.max_mae, args.min_ssim)
    print(json.dumps(report, ensure_ascii=False, indent=2))
    return 0 if report["passed"] else 1


if __name__ == "__main__":
    sys.exit(main())
