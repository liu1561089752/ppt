'use strict';

const { estimateTextHeight, estimateRichTextHeight, wrapText } = require('./text_measure');

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

/** Flatten containers into their concrete children in document order. */
function flattenElements(elements) {
  const flattened = [];
  (elements || []).forEach((element) => {
    if (isContainer(element)) {
      const background = containerBackgroundSpec(element);
      if (background) flattened.push(background);
      flattened.push(...flattenElements(element.children));
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
    if (typeof element.text === 'string') {
      element._renderText = wrapText(element.text, width, fontSize, measureOptions);
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
  const children = container.children || [];
  if (!children.length) return padding.top + padding.bottom;

  const fixedWidths = children.map((child) => (child.w === undefined ? null : child.w));
  const flexWeights = children.map((child) => {
    if (child.w !== undefined) return 0;
    return Number.isFinite(child.flex) && child.flex > 0 ? child.flex : 1;
  });
  const fixedTotal = fixedWidths.reduce((sum, width) => sum + (width || 0), 0);
  const weightTotal = flexWeights.reduce((sum, weight) => sum + weight, 0);
  const freeWidth = Math.max(0, contentWidth - fixedTotal - gap * (children.length - 1));
  const widths = fixedWidths.map((width, index) => {
    if (width !== null) return width;
    return weightTotal > 0 ? (freeWidth * flexWeights[index]) / weightTotal : 0;
  });

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
    if (childAlign === 'stretch') height = Math.max(height, innerHeight);
    else if (childAlign === 'center') y = contentY + (innerHeight - height) / 2;
    else if (childAlign === 'end') y = contentY + innerHeight - height;
    emitElement(child, { x: cursorX, y, w: widths[index], h: height }, theme, options, sink);
    cursorX += widths[index] + gap + extraGap;
  });

  return padding.top + Math.max(innerHeight, tallest) + padding.bottom;
}

function placeGrid(container, box, theme, options, sink) {
  const padding = normalizePadding(container.padding);
  const gap = resolveGap(container.gap, theme);
  const columnGap = resolveGap(container.columnGap, theme, gap);
  const rowGap = resolveGap(container.rowGap, theme, gap);
  const contentX = box.x + padding.left;
  const contentY = box.y + padding.top;
  const contentWidth = Math.max(0, box.w - padding.left - padding.right);
  const columns = Math.max(1, Math.floor(container.columns));
  const cellWidth = Math.max(0, (contentWidth - columnGap * (columns - 1)) / columns);
  const children = container.children || [];
  if (!children.length) return padding.top + padding.bottom;

  const align = container.align || 'stretch';
  let cursorY = contentY;
  for (let start = 0; start < children.length; start += columns) {
    const row = children.slice(start, start + columns);
    const heights = row.map((child) => measureElementHeight(child, cellWidth, theme, options));
    const rowHeight = Math.max(...heights);
    row.forEach((child, column) => {
      const childAlign = child.alignSelf || align;
      let height = heights[column];
      let y = cursorY;
      if (childAlign === 'stretch') height = rowHeight;
      else if (childAlign === 'center') y = cursorY + (rowHeight - height) / 2;
      else if (childAlign === 'end') y = cursorY + rowHeight - height;
      emitElement(child, {
        x: contentX + column * (cellWidth + columnGap),
        y,
        w: cellWidth,
        h: height
      }, theme, options, sink);
    });
    cursorY += rowHeight + rowGap;
  }
  return padding.top + (cursorY - contentY - rowGap) + padding.bottom;
}

function emitElement(source, box, theme, options, sink) {
  if (isContainer(source)) {
    layoutContainer(source, { x: box.x, y: box.y, w: box.w, h: box.h === undefined ? source.h : box.h }, theme, options)
      .elements.forEach((element) => sink.push(element));
    return;
  }
  const { element } = prepareElement(source, box.w, theme, options);
  element.x = box.x;
  element.y = box.y;
  element.w = box.w;
  element.h = box.h === undefined ? element.h : box.h;
  sink.push(element);
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
  const background = containerBackgroundSpec(container);
  if (background) {
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
