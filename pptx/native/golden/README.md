# Golden slide images

This directory holds reviewed PNG baselines for the visual-regression gate.

## Baselines must come from the CI renderer

CI renders on Ubuntu with LibreOffice and `fonts-noto-cjk`. A PNG rendered on a
developer machine uses that machine's fonts, so its text metrics differ and the
comparison fails on typography alone — not on a design change. Therefore:

1. Run the workflow and download the `native-ppt-rendered-demos` artifact. It
   contains `render-check/<deck>/*.png`, `preview/<deck>/` and
   `visual-regression/<deck>/`.
2. Review every PNG of that deck by eye (open the whole set, not just the slides
   you expect to have changed).
3. Promote the reviewed set:

```bash
cd pptx/native
python scripts/promote_goldens.py --source path/to/artifact/render-check --deck native-components-demo --yes
```

   Each promoted directory also gets a `MANIFEST.json` with the soffice version,
   the slide list and the promotion date, so a later failure can be traced to a
   renderer change instead of being blamed on the deck.

4. Commit the PNGs and the manifest. Never promote images you have not looked at:
   a baseline is a design contract, not a snapshot of whatever the code produced.

`golden/` currently contains no PNGs on purpose. Renderers here and in CI agree
on geometry, but approving a baseline is a human design decision.

## Comparator

`scripts/visual_regression.py` reports MAE and global SSIM, writes a JSON metric
file, an HTML summary and per-slide heatmaps. It compares a deck only when its
`golden/<deck>/` directory contains PNG files; otherwise CI runs the synthetic
self-test (a five-pixel displacement must be detected).

## Thresholds

Initial thresholds are MAE <= 0.015 and global SSIM >= 0.97. They are starting
points, not a quality guarantee. Rendering must use the same LibreOffice and font
environment for baseline capture and for CI; that is what the artifact workflow
above enforces.

## Current gate

Every fixture now renders in a real engine (LibreOffice 26.2.7 verified locally,
Ubuntu LibreOffice in CI), including native charts, rotation, merged table cells
and image crops. Text rendering still depends on the machine's fonts, and
Microsoft PowerPoint itself has not been used for review — that remains the last
open verification step before baselines are approved.
