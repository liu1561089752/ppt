'use strict';

const { flexWidths } = require('./flex_size');

/**
 * `flex-wrap: wrap` line breaking, shared by the HTML analyzer and the native
 * layout engine so both put the same items on the same line.
 *
 * An item whose basis is 0 (no width, no `flex-basis`, i.e. `flex: 1`) never
 * forces a break: CSS would use its max-content size, which we do not measure for
 * a container. Declared widths and `flex-basis` are what drive wrapping, which is
 * what a tag row or a badge strip is written with.
 *
 * Each item is `{ base, grow, shrink }`; each line gets the widths `flexWidths`
 * computes for its own items and the free space of a full row.
 */
function flexLines(items, available, gap) {
  const list = Array.isArray(items) ? items : [];
  const total = Math.max(0, Number(available) || 0);
  const spacing = Number.isFinite(gap) && gap > 0 ? gap : 0;
  const basisOf = (item) => {
    const value = Number(item && item.base);
    return Number.isFinite(value) && value > 0 ? value : 0;
  };

  const groups = [];
  let current = [];
  let used = 0;
  list.forEach((item, index) => {
    const basis = basisOf(item);
    if (current.length) {
      const needed = used + spacing + basis;
      if (basis > 0 && needed > total + 1e-6) {
        groups.push(current);
        current = [index];
        used = basis;
        return;
      }
      current.push(index);
      used = needed;
      return;
    }
    current = [index];
    used = basis;
  });
  if (current.length) groups.push(current);

  return groups.map((indices) => ({
    indices,
    widths: flexWidths(
      indices.map((index) => list[index]),
      Math.max(0, total - spacing * (indices.length - 1))
    ),
    used: indices.reduce((sum, index) => sum + basisOf(list[index]), 0) + spacing * (indices.length - 1)
  }));
}

module.exports = { flexLines };
