'use strict';

/**
 * CSS grid placement, shared by the HTML analyzer and the native layout engine so
 * both resolve a grid the same way.
 *
 * Supported: row-major auto-flow with per-item `columnSpan`/`rowSpan`. Explicit
 * line placement (`grid-column: 2 / 4`), named areas and `grid-auto-flow: column`
 * are not modelled; the caller reports them.
 */

/** Clamp a raw span value to a usable integer. */
function normalizeSpan(value, limit) {
  const span = Math.floor(Number(value));
  if (!Number.isFinite(span) || span < 1) return 1;
  return limit === undefined ? span : Math.min(span, Math.max(1, limit));
}

/**
 * Place items into a row-major grid.
 *
 * An item may pin its lines with `columnStart`/`columnEnd`/`rowStart`/`rowEnd`
 * (0-based cells, `columnEnd` exclusive, the way `grid-column: 2 / 4` resolves). The
 * four phases are CSS 8.5 for `grid-auto-flow: row`: items with a definite row and
 * column go first, then items with only a column hunt a row, then items with only a row
 * take the earliest free column in it, and everything else flows from the cursor.
 * `items` carries `{ columnSpan, rowSpan }` plus those optional starts; the result keeps
 * the same order and adds `{ row, column }` (0-based) with the clamped spans.
 */
function placeGridItems(items, columns) {
  const count = Math.max(1, Math.floor(Number(columns)) || 1);
  const occupied = [];
  const ensureRow = (row) => {
    while (occupied.length <= row) occupied.push(new Array(count).fill(false));
  };
  const isFree = (row, column, rowSpan, columnSpan) => {
    if (column + columnSpan > count) return false;
    for (let r = row; r < row + rowSpan; r += 1) {
      ensureRow(r);
      for (let c = column; c < column + columnSpan; c += 1) {
        if (occupied[r][c]) return false;
      }
    }
    return true;
  };
  const fill = (row, column, rowSpan, columnSpan) => {
    for (let r = row; r < row + rowSpan; r += 1) {
      ensureRow(r);
      for (let c = column; c < column + columnSpan; c += 1) occupied[r][c] = true;
    }
  };

  const list = items || [];
  const placements = new Array(list.length);
  const hasStart = (value) => Number.isFinite(value);
  const clampColumn = (value) => Math.max(0, Math.min(count - 1, Math.floor(value)));
  const spanFor = (item, column) => {
    const declared = normalizeSpan(item && item.columnSpan, count);
    const end = item && hasStart(item.columnEnd) ? Math.floor(item.columnEnd) - column : null;
    const wanted = end !== null && end > 0 ? end : declared;
    return Math.max(1, Math.min(wanted, count - column));
  };
  const rowSpanFor = (item) => {
    const declared = normalizeSpan(item && item.rowSpan);
    const end = item && hasStart(item.rowEnd) ? Math.floor(item.rowEnd) - Math.floor(item.rowStart) : null;
    return end !== null && end > 0 ? end : declared;
  };

  // Phase 1: a definite row and column needs no search.
  list.forEach((item, index) => {
    if (!item || !hasStart(item.rowStart) || !hasStart(item.columnStart)) return;
    const row = Math.max(0, Math.floor(item.rowStart));
    const column = clampColumn(item.columnStart);
    const columnSpan = spanFor(item, column);
    const rowSpan = rowSpanFor(item);
    fill(row, column, rowSpan, columnSpan);
    placements[index] = { row, column, rowSpan, columnSpan };
  });

  // Phase 2: a definite column hunts the first row where it fits.
  list.forEach((item, index) => {
    if (placements[index] || !item || !hasStart(item.columnStart)) return;
    const column = clampColumn(item.columnStart);
    const columnSpan = spanFor(item, column);
    const rowSpan = rowSpanFor(item);
    let row = 0;
    for (let guard = 0; guard < 10000 && !isFree(row, column, rowSpan, columnSpan); guard += 1) {
      row += 1;
    }
    fill(row, column, rowSpan, columnSpan);
    placements[index] = { row, column, rowSpan, columnSpan };
  });

  // Phase 3: a definite row takes the earliest free column in it.
  list.forEach((item, index) => {
    if (placements[index] || !item || !hasStart(item.rowStart)) return;
    let row = Math.max(0, Math.floor(item.rowStart));
    const rowSpan = rowSpanFor(item);
    const columnSpan = Math.max(1, Math.min(normalizeSpan(item.columnSpan, count), count));
    let column = 0;
    for (let guard = 0; guard < 10000; guard += 1) {
      if (column + columnSpan > count) {
        row += 1;
        column = 0;
        continue;
      }
      if (isFree(row, column, rowSpan, columnSpan)) break;
      column += 1;
    }
    fill(row, column, rowSpan, columnSpan);
    placements[index] = { row, column, rowSpan, columnSpan };
  });

  // Phase 4: everything left flows from the cursor, in document order.
  let row = 0;
  let column = 0;
  list.forEach((item, index) => {
    if (placements[index]) return;
    const rowSpan = normalizeSpan(item && item.rowSpan);
    const columnSpan = normalizeSpan(item && item.columnSpan, count);
    // Advance until the spans fit without overlapping anything already placed.
    for (let guard = 0; guard < 10000; guard += 1) {
      if (column + columnSpan > count) {
        row += 1;
        column = 0;
        continue;
      }
      if (isFree(row, column, rowSpan, columnSpan)) break;
      column += 1;
      if (column >= count) {
        row += 1;
        column = 0;
      }
    }
    fill(row, column, rowSpan, columnSpan);
    placements[index] = { row, column, rowSpan, columnSpan };
    column += columnSpan;
    if (column >= count) {
      row += 1;
      column = 0;
    }
  });
  return placements;
}

/** How many rows the placements need. */
function gridRowCount(placements) {
  return (placements || []).reduce((max, place) => Math.max(max, place.row + place.rowSpan), 0);
}

/**
 * Classify the declared rows. A track is a fixed `height`, `auto` (sized by its
 * items) or `fr` (a share of the height left over); rows past the declared tracks
 * use `autoRowHeight` when `grid-auto-rows` set one, otherwise they fit content.
 */
function rowTrackHeights(rowTracks, rowCount, autoRowHeight) {
  const declared = Array.isArray(rowTracks) ? rowTracks : [];
  const fallback = Number.isFinite(autoRowHeight) && autoRowHeight > 0 ? autoRowHeight : null;
  const heights = [];
  const flexible = [];
  const fractions = [];
  const total = Math.max(rowCount, declared.length);
  for (let index = 0; index < total; index += 1) {
    const track = declared[index];
    const fixed = track && Number.isFinite(track.height) && track.height >= 0 ? track.height : null;
    const fr = track && Number.isFinite(track.fr) && track.fr > 0 ? track.fr : null;
    if (fixed !== null) {
      heights.push(fixed);
      flexible.push(false);
      fractions.push(0);
    } else if (fr !== null) {
      heights.push(0);
      flexible.push(true);
      fractions.push(fr);
    } else if (fallback !== null) {
      heights.push(fallback);
      flexible.push(false);
      fractions.push(0);
    } else {
      heights.push(0);
      flexible.push(true);
      fractions.push(0);
    }
  }
  return { heights, flexible, fractions };
}

function resolveRowHeights(placements, heights, rowCount, rowGap = 0, rowTracks = null,
  autoRowHeight = null, contentHeight = null) {
  const totalRows = Math.max(rowCount, gridRowCount(placements));
  const start = rowTrackHeights(rowTracks, totalRows, autoRowHeight);
  const rows = start.heights;
  const flexible = start.flexible;
  const fractions = start.fractions;
  while (rows.length < totalRows) {
    rows.push(0);
    flexible.push(true);
    fractions.push(0);
  }
  const heightAt = (index) => (Number.isFinite(heights[index]) ? Math.max(0, heights[index]) : 0);
  // `fr` rows take a share of the leftover height, so their items must not set them.
  const canGrow = (row) => flexible[row] !== false && !(fractions[row] > 0 && Number.isFinite(contentHeight));

  (placements || []).forEach((place, index) => {
    if (place.rowSpan !== 1) return;
    if (place.row < rows.length && canGrow(place.row)) {
      rows[place.row] = Math.max(rows[place.row], heightAt(index));
    }
  });

  (placements || [])
    .map((place, index) => ({ place, index }))
    .filter((entry) => entry.place.rowSpan > 1)
    .sort((a, b) => a.place.rowSpan - b.place.rowSpan)
    .forEach(({ place, index }) => {
      let covered = rowGap * Math.max(0, place.rowSpan - 1);
      for (let r = place.row; r < place.row + place.rowSpan; r += 1) covered += rows[r] || 0;
      const needed = heightAt(index);
      if (needed <= covered) return;
      const growers = [];
      for (let r = place.row; r < place.row + place.rowSpan; r += 1) {
        if (canGrow(r)) growers.push(r);
      }
      if (!growers.length) return;
      const extra = (needed - covered) / growers.length;
      growers.forEach((r) => { rows[r] = (rows[r] || 0) + extra; });
    });

  // Finally hand the leftover height to the fractional rows, in track order.
  if (Number.isFinite(contentHeight)) {
    const totalFractions = fractions.reduce((sum, value) => sum + (value || 0), 0);
    if (totalFractions > 0) {
      const used = rows.reduce((sum, value) => sum + (value || 0), 0)
        + rowGap * Math.max(0, totalRows - 1);
      const leftover = Math.max(0, contentHeight - used);
      rows.forEach((value, row) => {
        if (fractions[row] > 0) rows[row] = (leftover * fractions[row]) / totalFractions;
      });
    }
  }
  return rows;
}

/** Absolute top edge of each row. */
function rowTops(rowHeights, originY, rowGap) {
  const tops = [];
  let top = originY;
  (rowHeights || []).forEach((height) => {
    tops.push(top);
    top += height + rowGap;
  });
  return tops;
}

/** Height an item occupies: the rows it spans plus the gaps between them. */
function spannedHeight(rowHeights, place, rowGap) {
  let height = 0;
  for (let r = place.row; r < place.row + place.rowSpan; r += 1) {
    height += (rowHeights[r] === undefined ? 0 : rowHeights[r]);
  }
  return height + rowGap * Math.max(0, place.rowSpan - 1);
}

module.exports = {
  normalizeSpan,
  placeGridItems,
  gridRowCount,
  rowTrackHeights,
  resolveRowHeights,
  rowTops,
  spannedHeight
};
