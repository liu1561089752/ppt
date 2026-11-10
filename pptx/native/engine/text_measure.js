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
  // Marks that may not start a line, and marks that may not end one. The quotes are here
  // because without them a sentence that closes with a quotation mark had the mark carried to
  // the head of the next line - a typographic error, and one a reader notices immediately.
  const leadingPunctuation = new Set(Array.from('，。！？：；、）》】」』〕〉〗〙〛”’»›,.!?;:%)]}'));
  const trailingOpening = new Set(Array.from('（【「『〔〈〖〘〚《“‘«‹([{'));
  if (lines.length < 2) return lines;
  // Repeat until nothing moves. One pass is not enough: carrying a mark back can leave the
  // previous line ending with an opening bracket, and that has to be pushed forward again.
  // Every mark has to be carried, not just the first: `。」` and `」，` are two marks, and
  // carrying one left the second sitting at the start of the next line. A line that is
  // nothing but a mark is dropped after the mark joins the line above it.
  for (let pass = 0; pass < 8; pass += 1) {
    let changed = false;
    for (let i = 1; i < lines.length; i += 1) {
      const previous = graphemes(lines[i - 1]);
      const current = graphemes(lines[i]);
      while (current.length && previous.length > 1 && leadingPunctuation.has(current[0])) {
        previous.push(current.shift());
        changed = true;
      }
      while (current.length > 1 && previous.length > 1
        && trailingOpening.has(previous[previous.length - 1])) {
        current.unshift(previous.pop());
        changed = true;
      }
      lines[i - 1] = previous.join('');
      if (current.length === 0) {
        lines.splice(i, 1);
        i -= 1;
        changed = true;
        continue;
      }
      lines[i] = current.join('');
    }
    if (!changed) break;
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

/**
 * Truncate to `count` lines and end the last one with an ellipsis, the way
 * `-webkit-line-clamp` does. Returns null when the text already fits, so a caller can
 * tell "nothing to do" from "clamped to nothing".
 *
 * The lines come from the same wrap that reserved the box height, so the clamp agrees with
 * the space the text was given. The last line sheds characters until the mark itself fits:
 * an ellipsis hanging outside the box is what a clamp looks like when it is broken.
 */
function clampText(text, widthIn, fontSizePt, count, options = {}) {
  const limit = Math.max(1, Math.floor(Number(count) || 0));
  // A clamp bakes its lines as hard breaks, and a baked line that only just fitted would wrap
  // again in a reader whose face is wider than the one measured here. That does not shorten
  // the excerpt - it turns one line into a line plus a dangling character. The headroom is the
  // widest substitution this machine produced (about 1.17em per CJK glyph): a slightly shorter
  // excerpt is a fair price for a box that stays intact when the font is missing.
  const bakeWidthIn = widthIn * 0.85;
  const lines = wrapText(String(text || ''), bakeWidthIn, fontSizePt, options).split('\n');
  if (lines.length <= limit) return null;
  const usableWidthPt = Math.max(1,
    (bakeWidthIn - (options.marginIn === undefined ? 0.04 : options.marginIn) * 2)
      * 72 * (options.safetyFactor || 0.9));
  const kept = lines.slice(0, limit);
  let last = kept[limit - 1];
  while (last && measureTextPt(last + '\u2026', fontSizePt, options) > usableWidthPt) {
    const chars = graphemes(last);
    if (!chars.length) break;
    chars.pop();
    last = chars.join('').replace(/\s+$/u, '');
  }
  kept[limit - 1] = last + '\u2026';
  return kept.join('\n');
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
  // A line's height comes from the tallest run *on that line*, not from the tallest run in
  // the box. A 3.2em first letter is on the first line only, and charging it to every line
  // reserved 236.8px where Chrome draws 155.4 - a box half a line too tall, and everything
  // below it slid down by the difference.
  let lines = 1;
  let line = 0;
  let lineWidth = 0;
  const lineSizes = [];
  const bump = (index, size) => {
    if (!(lineSizes[index] >= size)) lineSizes[index] = size;
  };
  list.forEach((run) => {
    const value = typeof run === 'string' ? run : (run && run.text) || '';
    const runSize = typeof run === 'string'
      ? fontSizePt
      : Number(run && run.options && run.options.fontSize) || fontSizePt;
    Array.from(String(value)).forEach((character) => {
      if (character === '\n') {
        lines += 1;
        line += 1;
        lineWidth = 0;
        limit = usableWidthPt;
        return;
      }
      const width = measureTextPt(character, runSize, options);
      if (lineWidth > 0 && lineWidth + width > limit) {
        lines += 1;
        line += 1;
        lineWidth = 0;
        limit = usableWidthPt;
      }
      bump(line, runSize);
      lineWidth += width;
    });
  });
  let tall = 0;
  for (let index = 0; index < lines; index++) tall += lineSizes[index] || fontSizePt;
  const paddingPt = (options.verticalInsetIn === undefined ? 0 : options.verticalInsetIn) * 72;
  return (tall * lineHeight + paddingPt) / 72;
}

module.exports = {
  glyphWidthFactor, graphemes, measureTextPt, wrapText, clampText, estimateLineCount,
  estimateTextHeight, estimateRichTextHeight
};
