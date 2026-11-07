# ppt

## Native PowerPoint engine

A first native PowerPoint generation engine is available in `pptx/native/`. It creates editable PowerPoint text boxes, shapes, lines, images, and tables directly with PptxGenJS. The original HTML-to-PPTX pipeline remains available for backward compatibility.

Quick start:

```bash
cd pptx/native
npm install
npm run demo
npm test
```

The example writes `native-demo.pptx` in the current directory. See [the native generation guide](pptx/SKILL.md#native-powerpoint-generation-new-engine) for the Deck Spec, API, limitations, and migration status.

**Status:** initial migration slice / opt-in preview. The CJK text measurement is conservative estimation, not exact font shaping. Always render and inspect output in the target PowerPoint environment before delivery.


Native mode now also includes configurable font-file metrics (via fontkit), CJK-aware explicit wrapping, estimated text-overflow warnings, and starter component/template factories. See the typography and component sections in `pptx/SKILL.md`. Font metrics require actual font files to be configured; otherwise the conservative fallback estimator is used.

Native output now sets East Asian font properties in OOXML, supports editable PowerPoint charts, and includes process-flow, timeline, comparison, and KPI templates. CI uses LibreOffice plus Poppler to render both demo decks and upload PPTX/PDF/PNG previews as artifacts.
