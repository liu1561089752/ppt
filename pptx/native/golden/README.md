# Golden slide images

This directory is reserved for reviewed PNG baselines used by visual regression.

## Create or refresh a baseline

1. Run the native CI render workflow (or install LibreOffice, Poppler, and Pillow locally).
2. Generate previews with `npm run render:demo` and/or `npm run render:components`.
3. Copy the reviewed output into the matching directory:
   - `golden/native-demo/`
   - `golden/native-components-demo/`
4. Review every PNG before committing. Baselines are intentional design contracts; do not refresh them merely to make a failing comparison green.

The comparator can also copy a current preview set:

```bash
python scripts/visual_regression.py \
  --baseline-dir golden/native-components-demo \
  --current-dir render-check/native-components-demo \
  --update-baseline
```

Then inspect and commit the PNGs. CI compares a deck only when its reviewed baseline directory contains PNG files. Until baselines are checked in, CI still runs the synthetic shifted-geometry self-test, which verifies that the comparator detects a five-pixel object displacement.

## Thresholds

The initial CI thresholds are MAE <= 0.015 and global SSIM >= 0.97. They are conservative starting points, not universal quality guarantees. Rendering should use the same LibreOffice and font environment for baseline capture and CI. Every failure produces JSON metrics, an HTML summary, and per-slide difference heatmaps.
