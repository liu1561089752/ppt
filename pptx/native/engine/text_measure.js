'use strict';

function glyphWidthFactor(char) {
  const code = char.codePointAt(0);
  if ((code >= 0x2E80 && code <= 0x9FFF) || (code >= 0xF900 && code <= 0xFAFF) ||
      (code >= 0xFF01 && code <= 0xFF60) || (code >= 0x1F000 && code <= 0x1FAFF)) return 1.0;
  if (/\s/.test(char)) return 0.34;
  if (/[ilI.,'\x60:;!|]/.test(char)) return 0.32;
  if (/[MW@#%&]/.test(char)) return 0.88;
  return 0.58;
}

function graphemes(text) {
  if (typeof Intl !== 'undefined' && Intl.Segmenter) {
    return Array.from(new Intl.Segmenter(undefined, { granularity: 'grapheme' }).segment(text), (part) => part.segment);
  }
  return Array.from(text);
}

function measureTextPt(text, fontSizePt, options = {}) {
  if (options.fontManager) {
    const measured = options.fontManager.measure(text, fontSizePt, options.fontFace);
    if (measured !== null) return measured;
  }
  return graphemes(String(text)).reduce((sum, char) => sum + glyphWidthFactor(char) * fontSizePt, 0);
}

function normalizeCjkLineBreaks(lines) {
  const leadingPunctuation = new Set(Array.from('，。！？：；、）》】」』〕〉〗〙〛,.!?;:%)]}'));
  const trailingOpening = new Set(Array.from('（【「『〔〈〖〘〚([{'));
  for (let i = 1; i < lines.length; i += 1) {
    const current = graphemes(lines[i]);
    const previous = graphemes(lines[i - 1]);
    if (current.length && leadingPunctuation.has(current[0]) && previous.length > 1) {
      current.unshift(previous.pop());
      lines[i - 1] = previous.join('');
      lines[i] = current.join('');
    }
    const adjustedPrevious = graphemes(lines[i - 1]);
    if (adjustedPrevious.length && trailingOpening.has(adjustedPrevious[adjustedPrevious.length - 1]) && current.length > 1) {
      current.unshift(adjustedPrevious.pop());
      lines[i - 1] = adjustedPrevious.join('');
      lines[i] = current.join('');
    }
  }
  return lines;
}

function wrapParagraph(paragraph, maxWidthPt, fontSizePt, options) {
  if (!paragraph) return [''];
  const tokens = paragraph.match(/\s+|[^\s]+/gu) || [paragraph];
  const lines = [];
  let line = '';
  let lineWidth = 0;
  const push = () => {
    lines.push(line.replace(/\s+$/u, ''));
    line = '';
    lineWidth = 0;
  };

  for (const token of tokens) {
    const tokenWidth = measureTextPt(token, fontSizePt, options);
    if (/^\s+$/u.test(token)) {
      if (line) { line += token; lineWidth += tokenWidth; }
      continue;
    }
    if (tokenWidth <= maxWidthPt) {
      if (line && lineWidth + tokenWidth > maxWidthPt) push();
      line += token;
      lineWidth += tokenWidth;
      continue;
    }
    if (line) push();
    for (const unit of graphemes(token)) {
      const unitWidth = measureTextPt(unit, fontSizePt, options);
      if (line && lineWidth + unitWidth > maxWidthPt) push();
      line += unit;
      lineWidth += unitWidth;
    }
  }
  if (line || lines.length === 0) lines.push(line.replace(/\s+$/u, ''));
  return normalizeCjkLineBreaks(lines);
}

function wrapText(text, widthIn, fontSizePt, options = {}) {
  const margin = options.marginIn === undefined ? 0.04 : options.marginIn;
  const usableWidthPt = Math.max(1, (widthIn - margin * 2) * 72 * (options.safetyFactor || 0.9));
  return String(text || '').split(/\r?\n/u)
    .flatMap((paragraph) => wrapParagraph(paragraph, usableWidthPt, fontSizePt, options))
    .join('\n');
}

function estimateLineCount(text, widthIn, fontSizePt, options = {}) {
  return Math.max(1, wrapText(text, widthIn, fontSizePt, options).split('\n').length);
}

function estimateTextHeight(text, widthIn, fontSizePt, options = {}) {
  const lines = estimateLineCount(text, widthIn, fontSizePt, options);
  const lineHeight = options.lineHeight || 1.22;
  const paddingPt = (options.marginIn === undefined ? 0.04 : options.marginIn) * 144;
  return (lines * fontSizePt * lineHeight + paddingPt) / 72;
}

/**
 * Height of a rich-text run array.
 *
 * Each run is measured at its own font size where one is declared, and the line
 * height is taken from the largest size in the paragraph. This is still a
 * greedy character-level wrap, not OpenType shaping, but it removes the
 * systematic under-measurement of mixed-size runs.
 */
function estimateRichTextHeight(runs, widthIn, fontSizePt, options = {}) {
  const margin = options.marginIn === undefined ? 0.04 : options.marginIn;
  const usableWidthPt = Math.max(1, (widthIn - margin * 2) * 72 * (options.safetyFactor || 0.9));
  const lineHeight = options.lineHeight || 1.22;
  const list = Array.isArray(runs) ? runs : [];
  let lines = 1;
  let lineWidth = 0;
  let tallest = fontSizePt;
  list.forEach((run) => {
    const value = typeof run === 'string' ? run : (run && run.text) || '';
    const runSize = typeof run === 'string'
      ? fontSizePt
      : Number(run && run.options && run.options.fontSize) || fontSizePt;
    if (runSize > tallest) tallest = runSize;
    Array.from(String(value)).forEach((character) => {
      if (character === '\n') {
        lines += 1;
        lineWidth = 0;
        return;
      }
      const width = measureTextPt(character, runSize, options);
      if (lineWidth > 0 && lineWidth + width > usableWidthPt) {
        lines += 1;
        lineWidth = 0;
      }
      lineWidth += width;
    });
  });
  const paddingPt = margin * 144;
  return (lines * tallest * lineHeight + paddingPt) / 72;
}

module.exports = {
  glyphWidthFactor, graphemes, measureTextPt, wrapText, estimateLineCount,
  estimateTextHeight, estimateRichTextHeight
};
