'use strict';

// Deterministic fallback estimator. It intentionally errs on the spacious side.
// Calibrate against the exact fonts and renderers used for delivery; this is not
// a substitute for rendering the generated deck in PowerPoint/LibreOffice.
function glyphWidthFactor(char) {
  const code = char.codePointAt(0);
  if ((code >= 0x2E80 && code <= 0x9FFF) || (code >= 0xF900 && code <= 0xFAFF) ||
      (code >= 0xFF01 && code <= 0xFF60) || (code >= 0x1F000 && code <= 0x1FAFF)) return 1.0;
  if (/\s/.test(char)) return 0.34;
  if (/[ilI.,'\x60:;!|]/.test(char)) return 0.32;
  if (/[MW@#%&]/.test(char)) return 0.88;
  return 0.58;
}

function estimateLineCount(text, widthIn, fontSizePt, options = {}) {
  const margin = options.marginIn === undefined ? 0.04 : options.marginIn;
  const usableWidthPt = Math.max(1, (widthIn - margin * 2) * 72);
  const maxLineWidth = usableWidthPt * (options.safetyFactor || 0.88);
  const paragraphs = String(text || '').split(/\r?\n/);
  let lines = 0;
  for (const paragraph of paragraphs) {
    if (!paragraph) { lines += 1; continue; }
    let current = 0;
    let paragraphLines = 1;
    for (const char of Array.from(paragraph)) {
      const next = glyphWidthFactor(char) * fontSizePt;
      if (current > 0 && current + next > maxLineWidth) { paragraphLines += 1; current = next; }
      else current += next;
    }
    lines += paragraphLines;
  }
  return Math.max(1, lines);
}

function estimateTextHeight(text, widthIn, fontSizePt, options = {}) {
  const lines = estimateLineCount(text, widthIn, fontSizePt, options);
  const lineHeight = options.lineHeight || 1.22;
  const paddingPt = (options.marginIn === undefined ? 0.04 : options.marginIn) * 144;
  return (lines * fontSizePt * lineHeight + paddingPt) / 72;
}

module.exports = { glyphWidthFactor, estimateLineCount, estimateTextHeight };
