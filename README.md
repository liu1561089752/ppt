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
