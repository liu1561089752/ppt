# HTML ↔ Native visual parity

This fixture is a controlled migration test, not a claim that arbitrary browser CSS can be reproduced automatically.

## Paired source

- HTML source: `pptx/examples/design-reference.html`
- Extracted CSS: `pptx/native/native-theme-profile/source.css`
- Extracted theme: `pptx/native/native-theme-profile/theme.json`
- Editable Native counterpart: `pptx/examples/native_design_parity_demo.js`
- Expected rendered output: `pptx/native/render-check/native-design-parity-demo/`

Run from `pptx/native`:

```bash
python ../scripts/extract_html_design_tokens.py ../examples/design-reference.html native-theme-profile
node ../examples/native_design_parity_demo.js native-theme-profile/theme.json native-design-parity-demo.pptx
python scripts/render_check.py native-design-parity-demo.pptx --output-dir render-check/native-design-parity-demo
```

## Human review checklist

Review the HTML reference and Native render side by side at the same 16:9 viewport / slide size. Record pass, fail, or not applicable for each:

- [ ] **Composition:** same visual center of gravity, asymmetric balance, alignment, and relative block placement.
- [ ] **Hierarchy:** title, subtitle, card heading, body, and micro-label have equivalent prominence.
- [ ] **Typography:** family/fallback, weight, size, line spacing, CJK punctuation, and wrapping feel equivalent.
- [ ] **Palette:** background, surface, foreground, primary, accent, muted, and border colors match.
- [ ] **Spacing:** outer margins, card padding, inter-block gaps, and whitespace rhythm are preserved.
- [ ] **Surfaces:** corner treatment, borders, transparency, shadows, and gradients are intentionally translated.
- [ ] **Imagery:** crop, aspect ratio, focal point, and overlays are preserved where present.
- [ ] **Charts / diagrams:** visual encoding, label hierarchy, palette, and annotation treatment are equivalent.
- [ ] **Editability:** titles/body remain text, cards remain shapes, data remains tables/charts where practical; no full-slide rasterization.
- [ ] **Cross-renderer:** verify LibreOffice preview and at least one supported Microsoft PowerPoint environment before approving a baseline.

## Acceptance and baseline policy

1. Review every slide manually before accepting a parity fixture.
2. Capture golden PNGs only after visual review. Never promote the current output to golden merely to silence CI.
3. Keep the HTML source and its paired Deck Spec/example together so later engine changes can be compared against the same design intent.
4. A pixel metric is a regression signal, not an aesthetic judge. Typography rasterization and font substitution can create noise; composition and hierarchy still require human review.
5. Track unsupported CSS effects explicitly. Prefer native PowerPoint shapes, lines, transparency, gradients, and editable charts; use targeted SVG/image assets only for details that cannot be expressed cleanly as native objects.


## Supported CSS migration subset

The extractor and migration demo intentionally support a narrow, reviewable subset:

| CSS source | Extracted token | Native translation |
|---|---|---|
| Simple `linear-gradient()` with 2+ solid-color stops | `theme.backgrounds.gradient` | Editable DrawingML gradient on a shape |
| One simple `box-shadow` | `theme.effects.shadow` | Editable PowerPoint outer shadow |
| Explicit opacity token | `theme.effects.opacity` | Applied to gradient stop alpha and shadow opacity in the migration fixture |
| Colors, font families, sizes, spacing, radii | Existing theme token groups | Shared Native design tokens |

The migration demo and CI additionally inspect the generated PPTX XML for gradient,
shadow, and alpha nodes. This proves the effects were serialized as editable DrawingML;
it does not prove visual equivalence to a browser renderer.

Not automatically translated: CSS Grid/Flex sizing, arbitrary cascade/specificity,
multiple or inset shadows, radial/conic gradients, gradients with image layers,
filters/backdrop filters, blend modes, masks, pseudo-elements, transitions, and
browser-specific typography. Preserve the original CSS and manually translate
these cases into Native layout primitives or targeted vector assets.


The paired HTML fixture uses an explicit 1280×720 (16:9) composition. Its pixel geometry is aligned to the Native 13.333×7.5 inch slide at 96 CSS pixels per inch, including the right-side panel, accent bar, title/subtitle boxes, card, and micro-label. The fixture is intended to make manual side-by-side review concrete rather than comparing theme tokens alone.
