'use strict';

const { estimateTextHeight, estimateRichTextHeight, wrapText } = require('./text_measure');
const { flexWidths } = require('./flex_size');
const { flexLines, flexColumns, alignLines } = require('./flex_lines');
const {
  placeGridItems,
  gridItemWidth,
  gridItemX,
  gridRowCount,
  resolveRowHeights,
  rowTops,
  spannedHeight
} = require('./grid_place');

/**
 * Layout engine.
 *
 * Two layers:
 *  1. `layoutSlide` keeps the historical single-column cursor flow for plain
 *     element arrays, so existing specs keep their exact geometry.
 *  2. `container` elements declare real layout: rows, columns, grids, padding,
 *     gap, cross-axis alignment and main-axis distribution. Containers resolve
 *     to absolute geometry before serialization, which keeps every emitted
 *     object editable while still describing intent declaratively.
 *
 * Containers are a layout-only type: they never reach the PPTX writer.
 */

const CONTAINER_TYPE = 'container';

function isContainer(element) {
  return !!element && element.type === CONTAINER_TYPE;
}

/** A container decoration as concrete shapes; `box` is the container frame. */
function overlayElements(container, box) {
  const emitted = [];
  (container.overlays || []).forEach((overlay) => {
    const frame = {
      x: box.x + (overlay.x || 0),
      y: box.y + (overlay.y || 0),
      w: overlay.w,
      h: overlay.h
    };
    if (!Number.isFinite(frame.w) || !Number.isFinite(frame.h) || frame.w <= 0 || frame.h <= 0) return;
    if (overlay.fill) {
      emitted.push(Object.assign({
        type: 'shape',
        fill: overlay.fill,
        line: false
      }, frame, overlay.radius ? { radius: overlay.radius } : {}));
    }
    if (overlay.text) {
      emitted.push(Object.assign({
        type: 'text',
        text: overlay.text,
        color: overlay.color,
        fontSize: overlay.fontSize,
        align: overlay.align || 'center',
        valign: 'middle',
        margin: 0
      }, frame));
    }
  });
  return emitted;
}

/** Flatten containers into their concrete children in document order. */
function flattenElements(elements) {
  const flattened = [];
  (elements || []).forEach((element) => {
    if (isContainer(element)) {
      const background = containerBackgroundSpec(element);
      if (background) {
        // The surface of a clipped container is the polygon, not a rectangle.
        if (element.clip) background.clip = element.clip;
        flattened.push(background);
      }
      flattened.push(...flattenElements(element.children));
      const frame = { x: element.x, y: element.y, w: element.w, h: element.h };
      if (Number.isFinite(frame.x) && Number.isFinite(frame.y)) {
        flattened.push(...overlayElements(element, frame));
      }
    } else {
      flattened.push(element);
    }
  });
  return flattened;
}

/**
 * A container may paint its own surface (`background`), which is emitted as a
 * regular editable shape behind its children. Returning the same descriptor in
 * both the layout and flatten passes keeps OOXML patch alignment exact.
 */
function containerBackgroundSpec(container) {
  const background = container && container.background;
  if (!background) return null;
  if (background === true) return { type: 'shape' };
  if (typeof background !== 'object' || Array.isArray(background)) return null;
  return Object.assign({ type: 'shape' }, background);
}

function normalizePadding(padding) {
  if (padding === undefined || padding === null) return { top: 0, right: 0, bottom: 0, left: 0 };
  if (typeof padding === 'number') return { top: padding, right: padding, bottom: padding, left: padding };
  return {
    top: padding.top || 0,
    right: padding.right || 0,
    bottom: padding.bottom || 0,
    left: padding.left || 0
  };
}

/**
 * Optional per-child margins. The engine reserves them only where they can be
 * honoured exactly: columns use top/bottom/left/right, rows use left/right, and
 * grids ignore them (a grid track must stay aligned to its cell).
 *
 * The field is `boxMargin`, deliberately not `margin`: the PPTX writer already
 * interprets `margin` as text-box insets, so overloading that name silently
 * insets (or shifts) converted text.
 */
function normalizeMargin(child) {
  const margin = child && child.boxMargin;
  if (margin === undefined || margin === null) return { top: 0, right: 0, bottom: 0, left: 0 };
  if (typeof margin === 'number') return { top: margin, right: margin, bottom: margin, left: margin };
  return {
    top: margin.top || 0,
    right: margin.right || 0,
    bottom: margin.bottom || 0,
    left: margin.left || 0
  };
}

function resolveGap(value, theme, fallback) {
  if (value !== undefined) return value;
  if (fallback !== undefined) return fallback;
  return theme.layouts?.columnGap || theme.spacing?.md || 0.22;
}

/**
 * Compute the width/height and typographic wrapping for one concrete element.
 * Returns the prepared element plus whether the spec pinned its own position.
 */
function prepareElement(source, availableWidth, theme = {}, options = {}) {
  const element = Object.assign({}, source);
  const explicitPosition = Number.isFinite(element.x) && Number.isFinite(element.y);
  const width = element.w === undefined ? availableWidth : element.w;
  let height = element.h;

  if (element.type === 'text') {
    const textRole = element.role === 'title' || element.role === 'heading' ? element.role : 'body';
    const fontSize = element.fontSize || theme.sizes?.[textRole] || theme.sizes?.body || 16;
    const defaultFontFace = textRole === 'body' ? theme.fonts?.body : theme.fonts?.heading;
    const measureOptions = {
      fontManager: options.fontManager,
      fontFace: element.fontFace || defaultFontFace || theme.fonts?.body,
      lineHeight: element.lineSpacingMultiple || theme.typography?.lineSpacingMultiple || theme.lineSpacingMultiple || 1.22,
      safetyFactor: options.safetyFactor || 0.9
    };
    // `white-space: nowrap` never wraps, so the box keeps one line and the text
    // overflows instead - which is what `bodyPr wrap="none"` does natively.
    if (element.nowrap) measureOptions.noWrap = true;
    // Vertical text runs down the box height and wraps into columns, so wrapping it
    // at the box *width* would invent line breaks that never render. The analyzer
    // already decided the box; here we only need a height that does not shrink it.
    if (element.vert) measureOptions.noWrap = true;
    // The first-line indent narrows the first line, so the wrap sees it; the height
    // measures the already wrapped text and must not apply it a second time.
    const wrapOptions = Object.assign({}, measureOptions);
    if (Number.isFinite(element.textIndent) && element.textIndent > 0) {
      wrapOptions.firstLineIndentPt = element.textIndent * 72;
    }
    if (typeof element.text === 'string') {
      element._renderText = element.vert
        ? element.text
        : wrapText(element.text, width, fontSize, wrapOptions);
      element._requiredTextHeight = estimateTextHeight(element._renderText, width, fontSize, measureOptions);
    } else {
      // Runs keep their own sizes editable; only the height estimate is derived here.
      element._requiredTextHeight = estimateRichTextHeight(element.text, width, fontSize, measureOptions);
    }
    if (height === undefined) height = element._requiredTextHeight;
  } else if (height === undefined) {
    height = element.type === 'line' ? 0.01 : 1.0;
  }

  element.w = width;
  element.h = height;
  return { element, explicitPosition };
}

/** Auto height of a child measured at a given width, recursing through containers. */
function measureElementHeight(source, width, theme, options) {
  if (isContainer(source)) {
    return layoutContainer(source, { x: 0, y: 0, w: width, h: source.h }, theme, options).height;
  }
  return prepareElement(source, width, theme, options).element.h;
}

function placeColumn(container, box, theme, options, sink) {
  const padding = normalizePadding(container.padding);
  const gap = resolveGap(container.gap, theme);
  const contentX = box.x + padding.left;
  const contentY = box.y + padding.top;
  const contentWidth = Math.max(0, box.w - padding.left - padding.right);
  const children = container.children || [];
  if (!children.length) return padding.top + padding.bottom;
  if (container.wrap) {
    const contentHeight = Number.isFinite(box.h)
      ? Math.max(0, box.h - padding.top - padding.bottom)
      : undefined;
    return placeWrappedColumn(container, box, theme, options, sink, {
      padding, gap, contentX, contentY, contentWidth, children, contentHeight
    });
  }

  const margins = children.map((child) => normalizeMargin(child));
  const widths = children.map((child, index) => {
    if (child.w !== undefined) return child.w;
    return Math.max(0, contentWidth - margins[index].left - margins[index].right);
  });
  const heights = children.map((child, index) => measureElementHeight(child, widths[index], theme, options));
  const totalContent = heights.reduce((sum, height, index) =>
    sum + height + margins[index].top + margins[index].bottom, 0) + gap * (children.length - 1);
  const availableInner = box.h === undefined
    ? totalContent
    : Math.max(totalContent, box.h - padding.top - padding.bottom);
  const free = Math.max(0, availableInner - totalContent);

  const justify = container.justify || 'start';
  let offset = 0;
  let extraGap = 0;
  if (justify === 'center') offset = free / 2;
  else if (justify === 'end') offset = free;
  else if (justify === 'space-between' && children.length > 1) extraGap = free / (children.length - 1);
  else if (justify === 'space-around') {
    offset = free / (children.length * 2);
    extraGap = free / children.length;
  }

  const align = container.align || 'stretch';
  let cursorY = contentY + offset;
  children.forEach((child, index) => {
    const childAlign = child.alignSelf || align;
    let x = contentX + margins[index].left;
    if (childAlign === 'center') x = contentX + (contentWidth - widths[index]) / 2;
    else if (childAlign === 'end') x = contentX + (contentWidth - widths[index]);
    const y = cursorY + margins[index].top;
    emitElement(child, { x, y, w: widths[index], h: heights[index] }, theme, options, sink);
    cursorY = y + heights[index] + margins[index].bottom + gap + extraGap;
  });

  return padding.top + availableInner + padding.bottom;
}

function placeRow(container, box, theme, options, sink) {
  const padding = normalizePadding(container.padding);
  const gap = resolveGap(container.gap, theme);
  const contentX = box.x + padding.left;
  const contentY = box.y + padding.top;
  const contentWidth = Math.max(0, box.w - padding.left - padding.right);
  // A pinned height is what `align-content` distributes inside; without one there is
  // no leftover to hand out.
  const contentHeight = Number.isFinite(box.h)
    ? Math.max(0, box.h - padding.top - padding.bottom)
    : undefined;
  const children = container.children || [];
  if (!children.length) return padding.top + padding.bottom;
  if (container.wrap) {
    return placeWrappedRow(container, box, theme, options, sink, {
      padding, gap, contentX, contentY, contentWidth, children, contentHeight
    });
  }

  const available = Math.max(0, contentWidth - gap * (children.length - 1));
  const widths = flexWidths(children.map((child) => {
    const base = Number.isFinite(child.w) ? child.w
      : (Number.isFinite(child.flexBasis) ? child.flexBasis : 0);
    const declaredGrow = Number.isFinite(child.flex) && child.flex > 0 ? child.flex : 0;
    // No width, no basis and no declared grow: the item shares the space equally.
    const grow = declaredGrow > 0 ? declaredGrow : (base > 0 ? 0 : 1);
    const shrink = Number.isFinite(child.flexShrink) && child.flexShrink >= 0 ? child.flexShrink : 1;
    return { base, grow, shrink };
  }), available);

  const heights = children.map((child, index) => measureElementHeight(child, widths[index], theme, options));
  const tallest = Math.max(...heights);
  const innerHeight = box.h === undefined ? tallest : Math.max(tallest, box.h - padding.top - padding.bottom);

  const justify = container.justify || 'start';
  const usedWidth = widths.reduce((sum, width) => sum + width, 0) + gap * (children.length - 1);
  const free = Math.max(0, contentWidth - usedWidth);
  let offset = 0;
  let extraGap = 0;
  if (justify === 'center') offset = free / 2;
  else if (justify === 'end') offset = free;
  else if (justify === 'space-between' && children.length > 1) extraGap = free / (children.length - 1);
  else if (justify === 'space-around') {
    offset = free / (children.length * 2);
    extraGap = free / children.length;
  }

  const align = container.align || 'stretch';
  let cursorX = contentX + offset;
  children.forEach((child, index) => {
    // align-self overrides the container's cross-axis alignment for one child.
    const childAlign = child.alignSelf || align;
    let height = heights[index];
    let y = contentY;
    // A box whose CSS pinned its height keeps it: stretch only sizes the others.
    if (childAlign === 'stretch' && !child.fixedHeight) height = Math.max(height, innerHeight);
    else if (childAlign === 'center') y = contentY + (innerHeight - height) / 2;
    else if (childAlign === 'end') y = contentY + innerHeight - height;
    emitElement(child, { x: cursorX, y, w: widths[index], h: height }, theme, options, sink);
    cursorX += widths[index] + gap + extraGap;
  });

  return padding.top + Math.max(innerHeight, tallest) + padding.bottom;
}

/**
 * A `flex-wrap: wrap` row: items break into lines before they grow, each line is
 * distributed and cross-aligned on its own, and the container height is the sum of
 * the line heights plus the gaps. Mirrors the analyzer's row branch so both sides
 * agree by construction - the line groups come from the shared `flexLines`.
 */
/**
 * `flex-direction: column; flex-wrap: wrap`: the vertical twin of `placeWrappedRow`.
 * The column break comes from the shared `flexColumns` and the leftover width is
 * distributed by the shared `alignLines`, so the analyzer and the engine cannot disagree
 * about where a column starts or how many items it holds.
 */
function placeWrappedColumn(container, box, theme, options, sink, frame) {
  const { padding, gap, contentX, contentY, contentWidth, contentHeight } = frame;
  const children = frame.children || [];
  const crossGap = Number.isFinite(container.crossGap) ? container.crossGap : gap;
  const margins = children.map((child) => normalizeMargin(child));
  const widths = children.map((child, index) => {
    if (child.w !== undefined) return child.w;
    return Math.max(0, contentWidth - margins[index].left - margins[index].right);
  });
  const heights = children.map((child, index) => measureElementHeight(child, widths[index], theme, options));
  const available = Number.isFinite(contentHeight) ? contentHeight : 0;
  // No growth inside a column here: the items keep the heights the CSS gave them and
  // `justify` decides where the stack sits.
  const columns = flexColumns(heights.map((height, index) => ({
    base: height + margins[index].top + margins[index].bottom,
    grow: 0
  })), available, gap);
  const columnWidths = columns.map((column) =>
    column.indices.reduce((max, index) => Math.max(max, widths[index]), 0));
  const totalWidth = columnWidths.reduce((sum, width) => sum + width, 0)
    + crossGap * Math.max(0, columns.length - 1);
  const distribution = alignLines(columnWidths, totalWidth, contentWidth, container.alignContent);
  const align = container.align || 'stretch';
  const justify = container.justify || 'start';

  let columnCursor = contentX;
  let tallest = 0;
  columns.forEach((column, columnIndex) => {
    const { top: columnShift, extra: columnExtra } = distribution[columnIndex];
    const columnWidth = columnWidths[columnIndex] + columnExtra;
    const left = columnCursor + columnShift;
    const used = column.indices.reduce((sum, index) =>
      sum + heights[index] + margins[index].top + margins[index].bottom, 0)
      + gap * Math.max(0, column.indices.length - 1);
    const free = Math.max(0, available - used);
    let offset = 0;
    let extra = 0;
    if (justify === 'center') offset = free / 2;
    else if (justify === 'end') offset = free;
    else if (justify === 'space-between' && column.indices.length > 1) {
      extra = free / (column.indices.length - 1);
    } else if (justify === 'space-around') {
      offset = free / (2 * column.indices.length);
      extra = free / column.indices.length;
    }
    let cursorY = contentY + offset;
    column.indices.forEach((index) => {
      const child = children[index];
      const childAlign = child.alignSelf || align;
      let x = left + margins[index].left;
      if (childAlign === 'center') x = left + (columnWidth - widths[index]) / 2;
      else if (childAlign === 'end') x = left + columnWidth - widths[index];
      emitElement(child, {
        x,
        y: cursorY + margins[index].top,
        w: widths[index],
        h: heights[index]
      }, theme, options, sink);
      cursorY += heights[index] + margins[index].top + margins[index].bottom + gap + extra;
    });
    tallest = Math.max(tallest, used);
    columnCursor += columnWidth + crossGap;
  });

  const inner = Math.max(tallest, available);
  return padding.top + inner + padding.bottom;
}

function placeWrappedRow(container, box, theme, options, sink, frame) {
  const { padding, gap, contentX, contentY, contentWidth, children } = frame;
  const items = children.map((child) => {
    // A wrapped row states its base explicitly (`flexBasis`, 0 = no base), because
    // `w` already holds the width distributed inside its line: re-breaking on that
    // would sum back to a full row and never wrap.
    const base = Number.isFinite(child.flexBasis) ? child.flexBasis
      : (Number.isFinite(child.w) ? child.w : 0);
    const declaredGrow = Number.isFinite(child.flex) && child.flex > 0 ? child.flex : 0;
    const grow = declaredGrow > 0 ? declaredGrow : (base > 0 ? 0 : 1);
    const shrink = Number.isFinite(child.flexShrink) && child.flexShrink >= 0 ? child.flexShrink : 1;
    return { base, grow, shrink };
  });
  const lines = flexLines(items, contentWidth, gap);
  const justify = container.justify || 'start';
  const align = container.align || 'stretch';
  // Measure every line first: `align-content` needs to know how tall the block of lines
  // is before it can distribute the leftover the container's height leaves.
  const measuredLines = lines.map((line) => {
    const heights = line.indices.map((index, position) =>
      measureElementHeight(children[index], line.widths[position], theme, options));
    return { line, heights, tallest: Math.max(...heights) };
  });
  const blockHeight = measuredLines.reduce((sum, entry, index) =>
    sum + entry.tallest + (index < measuredLines.length - 1 ? gap : 0), 0);
  const distribution = alignLines(
    measuredLines.map((entry) => entry.tallest), blockHeight, frame.contentHeight,
    container.alignContent
  );

  let lineTop = contentY;
  let totalHeight = 0;

  measuredLines.forEach((entry, lineIndex) => {
    const { line, heights, tallest: measuredTallest } = entry;
    const { top: lineShift, extra: lineExtra } = distribution[lineIndex];
    const tallestInLine = measuredTallest + lineExtra;
    const lineOrigin = lineTop + lineShift;
    const widthsInLine = line.widths;
    const count = line.indices.length;
    const used = widthsInLine.reduce((sum, width) => sum + width, 0) + gap * (count - 1);
    const free = Math.max(0, contentWidth - used);
    let offset = 0;
    let extraGap = 0;
    if (justify === 'center') offset = free / 2;
    else if (justify === 'end') offset = free;
    else if (justify === 'space-between' && count > 1) extraGap = free / (count - 1);
    else if (justify === 'space-around') {
      offset = free / (count * 2);
      extraGap = free / count;
    }

    let cursorX = contentX + offset;
    line.indices.forEach((index, position) => {
      const child = children[index];
      const childAlign = child.alignSelf || align;
      let height = heights[position];
      let y = lineOrigin;
      if (childAlign === 'stretch' && !child.fixedHeight) height = Math.max(height, tallestInLine);
      else if (childAlign === 'center') y = lineOrigin + (tallestInLine - height) / 2;
      else if (childAlign === 'end') y = lineOrigin + tallestInLine - height;
      emitElement(child, { x: cursorX, y, w: widthsInLine[position], h: height }, theme, options, sink);
      cursorX += widthsInLine[position] + gap + extraGap;
    });
    totalHeight += tallestInLine;
    if (lineIndex < measuredLines.length - 1) totalHeight += gap;
    lineTop += tallestInLine + gap;
  });

  const inner = box.h === undefined ? totalHeight : Math.max(totalHeight, box.h - padding.top - padding.bottom);
  return padding.top + inner + padding.bottom;
}

/** Fixed tracks keep their width; fractional tracks share what is left. */
function resolveTrackSizes(tracks, totalWidth, gap) {
  const fixed = tracks.reduce((sum, track) => sum + (Number(track.width) || 0), 0);
  const weights = tracks.reduce((sum, track) => sum + (Number(track.fr) || 0), 0);
  const free = Math.max(0, totalWidth - fixed - gap * (tracks.length - 1));
  return tracks.map((track) => {
    if (Number.isFinite(track.width)) return track.width;
    if (weights <= 0) return 0;
    return (free * (Number(track.fr) || 0)) / weights;
  });
}

function placeGrid(container, box, theme, options, sink) {
  const padding = normalizePadding(container.padding);
  const gap = resolveGap(container.gap, theme);
  const columnGap = resolveGap(container.columnGap, theme, gap);
  const rowGap = resolveGap(container.rowGap, theme, gap);
  const contentX = box.x + padding.left;
  const contentY = box.y + padding.top;
  const contentWidth = Math.max(0, box.w - padding.left - padding.right);
  const tracks = Array.isArray(container.columnTracks) && container.columnTracks.length
    ? container.columnTracks
    : null;
  const columns = tracks ? tracks.length : Math.max(1, Math.floor(container.columns));
  const equalWidth = Math.max(0, (contentWidth - columnGap * (columns - 1)) / columns);
  const sizes = tracks
    ? resolveTrackSizes(tracks, contentWidth, columnGap)
    : Array.from({ length: columns }, () => equalWidth);
  const columnWidth = (column) => sizes[Math.min(column, sizes.length - 1)];
  const columnLeft = (column) => {
    let left = contentX;
    for (let index = 0; index < column; index += 1) left += sizes[Math.min(index, sizes.length - 1)] + columnGap;
    return left;
  };
  const children = container.children || [];
  if (!children.length) return padding.top + padding.bottom;

  const spanWidth = (column, span) => {
    let width = 0;
    for (let index = column; index < column + span; index += 1) width += columnWidth(index);
    return width + columnGap * Math.max(0, span - 1);
  };
  // The analyzer resolves the cell each child occupies; carrying it here means the two
  // cannot disagree about a grid whose placement came from explicit lines.
  const plans = children.map((child) => ({
    columnSpan: child.columnSpan,
    rowSpan: child.rowSpan,
    columnStart: child.gridColumnStart,
    rowStart: child.gridRowStart
  }));
  const placements = placeGridItems(plans, columns);
  // A child that declares its own height keeps it and does not size the rows.
  const declared = children.map((child) => child.h !== undefined);
  const heights = children.map((child, index) => {
    const place = placements[index];
    const cellWidth = spanWidth(place.column, place.columnSpan);
    // A declared width wins over the cell, so the content has to be measured at it.
    const ownWidth = child.fixedWidth && Number.isFinite(child.w) ? child.w : null;
    return measureElementHeight(child, gridItemWidth(cellWidth, ownWidth), theme, options);
  });
  const rowHeights = resolveRowHeights(placements, heights, gridRowCount(placements), rowGap,
    container.rowTracks, container.autoRowHeight, container.rowContentHeight);
  const tops = rowTops(rowHeights, contentY, rowGap);
  const align = container.align || 'stretch';
  if (process.env.NATIVE_DEBUG_GRID) {
    process.stderr.write('[placeGrid] columns=' + columns + ' rowGap=' + rowGap.toFixed(4)
      + ' sizes=' + sizes.map((v) => v.toFixed(3)).join('/')
      + ' heights=' + heights.map((v) => v.toFixed(3)).join('/')
      + ' rows=' + rowHeights.map((v) => v.toFixed(3)).join('/')
      + ' placements=' + placements.map((p) => p.row + ':' + p.column + 'x' + p.columnSpan + 'x' + p.rowSpan).join(' ') + '\n');
  }

  children.forEach((child, index) => {
    const place = placements[index];
    const total = spannedHeight(rowHeights, place, rowGap);
    const top = tops[place.row] === undefined ? contentY : tops[place.row];
    const childAlign = child.alignSelf || align;
    let height = heights[index];
    let y = top;
    if (childAlign === 'stretch' && !declared[index]) height = total;
    else if (childAlign === 'center') y = top + (total - height) / 2;
    else if (childAlign === 'end') y = top + total - height;
    // The inline axis mirrors the block axis: a declared width beats `stretch`, and
    // `justify-self` says where the box sits in the cell.
    const cellLeft = columnLeft(place.column);
    const cellWidth = spanWidth(place.column, place.columnSpan);
    const ownWidth = child.fixedWidth && Number.isFinite(child.w) ? child.w : null;
    const width = gridItemWidth(cellWidth, ownWidth);
    emitElement(child, {
      x: gridItemX(cellLeft, cellWidth, width, child.justifySelf),
      y,
      w: width,
      h: height
    }, theme, options, sink);
  });

  const lastRow = rowHeights.length - 1;
  const contentHeight = lastRow < 0 ? 0 : tops[lastRow] + rowHeights[lastRow] - contentY;
  return padding.top + contentHeight + padding.bottom;
}

/**
 * A single declared border side as a thin filled shape along that edge. The box is
 * the resolved frame of the element the edge belongs to, so the strip lands exactly
 * on its edge whatever the layout decided.
 */
function edgeElements(element, box) {
  const edge = element && element.edge;
  if (!edge || !Number.isFinite(box.x) || !Number.isFinite(box.y)) return [];
  const w = Number.isFinite(box.w) ? box.w : element.w;
  const h = Number.isFinite(box.h) ? box.h : element.h;
  if (!Number.isFinite(w) || !Number.isFinite(h) || w <= 0 || h <= 0) return [];
  const thickness = Math.max(0.01, Number(edge.width) / 72);
  const strip = { type: 'shape', fill: edge.color, line: false };
  if (edge.side === 'top') Object.assign(strip, { x: box.x, y: box.y, w, h: thickness });
  else if (edge.side === 'bottom') {
    Object.assign(strip, { x: box.x, y: box.y + h - thickness, w, h: thickness });
  } else if (edge.side === 'left') {
    Object.assign(strip, { x: box.x, y: box.y, w: thickness, h });
  } else Object.assign(strip, { x: box.x + w - thickness, y: box.y, w: thickness, h });
  return [strip];
}

function emitElement(source, box, theme, options, sink) {
  // A relative offset moves the box after placement, so it never affects siblings.
  const shift = source.relativeShift;
  const placed = shift
    ? { x: box.x + (shift.dx || 0), y: box.y + (shift.dy || 0), w: box.w, h: box.h }
    : box;
  if (isContainer(source)) {
    layoutContainer(source, { x: placed.x, y: placed.y, w: placed.w, h: placed.h === undefined ? source.h : placed.h }, theme, options)
      .elements.forEach((element) => sink.push(element));
    // Drawn after the container so the accent stays on top of its own surface.
    const frameH = placed.h === undefined ? source.h : box.h;
    edgeElements(source, { x: placed.x, y: placed.y, w: placed.w, h: frameH })
      .forEach((strip) => sink.push(strip));
    return;
  }
  const { element } = prepareElement(source, box.w, theme, options);
  element.x = placed.x;
  element.y = placed.y;
  element.w = placed.w;
  element.h = placed.h === undefined ? element.h : placed.h;
  sink.push(element);
  edgeElements(element, { x: element.x, y: element.y, w: element.w, h: element.h })
    .forEach((strip) => sink.push(strip));
}

/**
 * Resolve a container into concrete elements plus the height it occupies.
 * `box.h === undefined` means "size to content".
 */
function layoutContainer(container, box, theme = {}, options = {}) {
  const sink = [];
  const resolvedBox = {
    x: box.x,
    y: box.y,
    w: box.w,
    h: box.h === undefined ? container.h : box.h
  };
  let height;
  if (Number.isInteger(container.columns) && container.columns > 1) {
    height = placeGrid(container, resolvedBox, theme, options, sink);
  } else if (container.direction === 'row') {
    height = placeRow(container, resolvedBox, theme, options, sink);
  } else {
    height = placeColumn(container, resolvedBox, theme, options, sink);
  }
  if (resolvedBox.h !== undefined) height = Math.max(height, resolvedBox.h);
  if (container.overlays && container.overlays.length) {
    // Decorations paint above the flow children so a badge or chevron is not
    // hidden by a sibling; the container surface is unshifted underneath below.
    overlayElements(container, { x: resolvedBox.x, y: resolvedBox.y, w: resolvedBox.w, h: height })
      .forEach((overlay) => {
        emitElement(overlay, { x: overlay.x, y: overlay.y, w: overlay.w, h: overlay.h }, theme, options, sink);
      });
  }
  const background = containerBackgroundSpec(container);
  if (background) {
    // The surface is the only element that carries the container's own box, so the
    // geometry probe rides on it (see `verifySlide`).
    if (container._probe !== undefined) background._probe = container._probe;
    sink.unshift(Object.assign(background, {
      x: resolvedBox.x, y: resolvedBox.y, w: resolvedBox.w, h: height
    }));
  }
  return { elements: sink, height };
}

function layoutSlide(slide, pageSize, theme = {}, options = {}) {
  const margin = slide.margin === undefined ? (theme.layouts?.pageMarginX || theme.margins?.x || 0.58) : slide.margin;
  const gap = slide.gap === undefined ? (theme.layouts?.sectionGap || theme.spacing?.md || 0.22) : slide.gap;
  const contentWidth = pageSize.width - margin * 2;
  let cursorY = slide.startY === undefined ? (theme.layouts?.pageMarginY || theme.margins?.y || margin) : slide.startY;
  const resolved = [];

  (slide.elements || []).forEach((source) => {
    if (isContainer(source)) {
      const x = source.x === undefined ? margin : source.x;
      const y = source.y === undefined ? cursorY : source.y;
      const w = source.w === undefined ? contentWidth : source.w;
      const { elements, height } = layoutContainer(source, { x, y, w, h: source.h }, theme, options);
      elements.forEach((element) => resolved.push(element));
      if (source.y === undefined) cursorY = Math.max(cursorY, y + height + gap);
      return;
    }
    const { element, explicitPosition } = prepareElement(source, contentWidth, theme, options);
    element.x = element.x === undefined ? margin : element.x;
    element.y = element.y === undefined ? cursorY : element.y;
    if (!explicitPosition) cursorY = Math.max(cursorY, element.y + element.h + gap);
    resolved.push(element);
  });

  return resolved.map((element, index) => {
    element._layoutIndex = index;
    return element;
  });
}

module.exports = {
  CONTAINER_TYPE,
  isContainer,
  flattenElements,
  containerBackgroundSpec,
  normalizePadding,
  normalizeMargin,
  prepareElement,
  measureElementHeight,
  layoutContainer,
  layoutSlide
};
