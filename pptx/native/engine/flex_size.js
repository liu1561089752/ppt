'use strict';

/**
 * Flex sizing on the main axis, shared by the HTML analyzer and the native layout
 * engine so both resolve a row the same way.
 *
 * Each item contributes `{ base, grow, shrink }`:
 *   - `base`   the declared width or flex-basis (0 when the item has neither, which
 *              is what `flex: 1` means: `1 1 0%`);
 *   - `grow`   the flex-grow weight;
 *   - `shrink` the flex-shrink factor (1 by default in CSS).
 *
 * Free space is handed to the growing items; when the bases overflow, the items
 * shrink in proportion to `shrink * base`, which is what a browser does. Nothing
 * is clamped to a min-content width - text is measured, not shaped - so a row can
 * still overflow when every item is `flex-shrink: 0`.
 */
function flexWidths(items, available) {
  const list = Array.isArray(items) ? items : [];
  const base = list.map((item) => {
    const value = Number(item && item.base);
    return Number.isFinite(value) && value > 0 ? value : 0;
  });
  const grow = list.map((item) => {
    const value = Number(item && item.grow);
    return Number.isFinite(value) && value > 0 ? value : 0;
  });
  const shrink = list.map((item) => {
    const value = Number(item && item.shrink);
    return Number.isFinite(value) && value >= 0 ? value : 1;
  });
  const total = Math.max(0, Number(available) || 0);
  const baseTotal = base.reduce((sum, value) => sum + value, 0);

  if (baseTotal > total) {
    const weighted = base.map((value, index) => value * shrink[index]);
    const shrinkTotal = weighted.reduce((sum, value) => sum + value, 0);
    const overflow = baseTotal - total;
    if (shrinkTotal <= 0) return base.slice();
    return base.map((value, index) => Math.max(0, value - (overflow * weighted[index]) / shrinkTotal));
  }

  const growTotal = grow.reduce((sum, value) => sum + value, 0);
  const free = total - baseTotal;
  if (growTotal <= 0) return base.slice();
  return base.map((value, index) => value + (free * grow[index]) / growTotal);
}

module.exports = { flexWidths };
