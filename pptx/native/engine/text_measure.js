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

/**
 * Advance width in points. `letterSpacingPt` adds tracking to every character, which is
 * what a tracked kicker actually occupies - ignoring it measured those labels too narrow
 * to hold their own text, so an absolutely positioned one wrapped in half.
 */
function measureTextPt(text, fontSizePt, options = {}) {
  const raw = String(text);
  let width = null;
  if (options.fontManager) {
    width = options.fontManager.measure(raw, fontSizePt, options.fontFace);
  }
  if (width === null || width === undefined) {
    width = graphemes(raw).reduce((sum, char) => sum + glyphWidthFactor(char) * fontSizePt, 0);
  }
  const tracking = Number(options.letterSpacingPt);
  if (!Number.isFinite(tracking) || tracking === 0) return width;
  return width + tracking * graphemes(raw).length;
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

// CJK permits a break between any two characters, so each CJK character is its
// own token. Treating a whole spacerless Chinese run as one word made the greedy
// filler push a half-empty line whenever that run was wider than the box.
const CJK_RANGES = '\\u1100-\\u11FF\\u2E80-\\u303F\\u3040-\\u30FF\\u3130-\\u318F' +
  '\\u3400-\\u4DBF\\u4E00-\\u9FFF\\uA960-\\uA97F\\uAC00-\\uD7FF\\uF900-\\uFAFF' +
  '\\uFE30-\\uFE4F\\uFF00-\\uFFEF';
const TOKEN_PATTERN = new RegExp('\\s+|[' + CJK_RANGES + ']|[^\\s' + CJK_RANGES + ']+', 'gu');

function wrapParagraph(paragraph, maxWidthPt, fontSizePt, options) {
  if (!paragraph) return [''];
  // `white-space: nowrap` keeps the paragraph on one line; the text overflows the
  // box instead of wrapping, which is also what `bodyPr wrap="none"` does natively.
  if (options.noWrap) return normalizeCjkLineBreaks([String(paragraph)]);

  const indentPt = Number(options.firstLineIndentPt) > 0 ? Number(options.firstLineIndentPt) : 0;
  // A first-line indent eats into the first line's width, so the wrap can produce
  // one more line than the bare text would.
  const firstLimit = Math.max(1, maxWidthPt - indentPt);
  let limit = firstLimit;

  const tokens = paragraph.match(TOKEN_PATTERN) || [paragraph];
  const lines = [];
  let line = '';
  let lineWidth = 0;
  const push = () => {
    lines.push(line.replace(/\s+$/u, ''));
    line = '';
    lineWidth = 0;
    limit = maxWidthPt;
  };

  for (const token of tokens) {
    const tokenWidth = measureTextPt(token, fontSizePt, options);
    if (/^\s+$/u.test(token)) {
      if (line) { line += token; lineWidth += tokenWidth; }
      continue;
    }
    if (tokenWidth <= limit) {
      if (line && lineWidth + tokenWidth > limit) push();
      line += token;
      lineWidth += tokenWidth;
      continue;
    }
    if (line) push();
    for (const unit of graphemes(token)) {
      const unitWidth = measureTextPt(unit, fontSizePt, options);
      if (line && lineWidth + unitWidth > limit) push();
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
  // The writer emits a text box with zero insets, so n lines are n line boxes high.
  // Charging a vertical inset here made every text box 0.08in too tall, and since each
  // following block is placed after it, a page with a dozen paragraphs drifted an inch.
  const paddingPt = (options.verticalInsetIn === undefined ? 0 : options.verticalInsetIn) * 72;
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
  const indentPt = Number(options.firstLineIndentPt) > 0 ? Number(options.firstLineIndentPt) : 0;
  let limit = Math.max(1, usableWidthPt - indentPt);
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
        limit = usableWidthPt;
        return;
      }
      const width = measureTextPt(character, runSize, options);
      if (lineWidth > 0 && lineWidth + width > limit) {
        lines += 1;
        lineWidth = 0;
        limit = usableWidthPt;
      }
      lineWidth += width;
    });
  });
  const paddingPt = (options.verticalInsetIn === undefined ? 0 : options.verticalInsetIn) * 72;
  return (lines * tallest * lineHeight + paddingPt) / 72;
}

module.exports = {
  glyphWidthFactor, graphemes, measureTextPt, wrapText, estimateLineCount,
  estimateTextHeight, estimateRichTextHeight
};
