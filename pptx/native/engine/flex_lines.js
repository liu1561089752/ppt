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

/**
 * `align-content` for a wrapped row: where the block of lines sits inside a container
 * whose height the CSS pinned, and how the leftover is distributed.
 *
 * Returns one entry per line: `top` is added to its cross-axis origin and `extra` grows
 * its cross size (`stretch` hands the leftover to the lines themselves, which is what a
 * stretched item then fills). With no definite height, or with no leftover, everything is
 * zero and the caller behaves exactly as before.
 */
function alignLines(lineHeights, totalHeight, contentHeight, alignContent) {
  const heights = Array.isArray(lineHeights) ? lineHeights : [];
  const count = heights.length;
  const result = heights.map(() => ({ top: 0, extra: 0 }));
  if (!count || !Number.isFinite(contentHeight)) return result;
  const free = Number(contentHeight) - Number(totalHeight);
  if (!(free > 0.001)) return result;
  const value = String(alignContent === undefined || alignContent === null ? '' : alignContent)
    .trim().toLowerCase();
  // `align-content: normal` is `stretch` for a flex container, and an absent declaration is
  // the same thing - both sides resolve it here so they cannot disagree about the default.
  if (value === 'stretch' || value === '' || value === 'normal') {
    const extra = free / count;
    return result.map(() => ({ top: 0, extra }));
  }
  if (value === 'center') return result.map(() => ({ top: free / 2, extra: 0 }));
  if (value === 'end' || value === 'flex-end') return result.map(() => ({ top: free, extra: 0 }));
  if (value === 'space-between' && count > 1) {
    return result.map((entry, index) => ({ top: (free * index) / (count - 1), extra: 0 }));
  }
  if (value === 'space-around') {
    const step = free / count;
    return result.map((entry, index) => ({ top: step * (index + 0.5), extra: 0 }));
  }
  if (value === 'space-evenly') {
    // n+1 equal gaps, the two outer ones included.
    const step = free / (count + 1);
    return result.map((entry, index) => ({ top: step * (index + 1), extra: 0 }));
  }
  return result;
}

/**
 * `flex-direction: column` + `flex-wrap: wrap`: the same break rule with the main axis
 * turned, so an item's *height* is its base and the container's height is what runs out.
 * The returned `widths` are therefore the per-column heights.
 */
function flexColumns(items, available, gap) {
  return flexLines(items, available, gap);
}

module.exports = { flexLines, flexColumns, alignLines };
