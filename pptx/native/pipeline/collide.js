'use strict';

/**
 * Layout audit: report boxes that collide with a sibling, and content that spills
 * out of its container.
 *
 * The declared layout is exact, so these are the two failure modes that a wrong
 * measurement produces. They are reported rather than "fixed", because a pipeline
 * that silently ships a card on top of another card is worse than one that says so.
 *
 * Deliberate overlaps are not reported: absolutely positioned nodes are layers by
 * definition, decorations travel as `overlays`, and a container's own background is
 * not a sibling of its children.
 */

const MIN_AREA = 0.02;      // in²  - smaller touches are rounding, not design
const MIN_RATIO = 0.1;      // share of the smaller box
const TOLERANCE = 0.01;     // in

function boxOf(node) {
  if (!node) return null;
  const { x, y, w, h } = node;
  if (![x, y, w, h].every((value) => Number.isFinite(value))) return null;
  if (w <= 0 || h <= 0) return null;
  return { x, y, w, h };
}

function intersectionArea(a, b) {
  const left = Math.max(a.x, b.x);
  const top = Math.max(a.y, b.y);
  const right = Math.min(a.x + a.w, b.x + b.w);
  const bottom = Math.min(a.y + a.h, b.y + b.h);
  if (right <= left || bottom <= top) return 0;
  return (right - left) * (bottom - top);
}

function labelOf(node) {
  const classes = Array.isArray(node.classes) && node.classes.length ? '.' + node.classes.join('.') : '';
  const tag = node.tag ? String(node.tag) : '';
  const kind = node.kind ? '(' + node.kind + ')' : '';
  const text = typeof node.text === 'string' && node.text.trim()
    ? ' "' + node.text.trim().replace(/\s+/gu, ' ').slice(0, 18) + '"'
    : '';
  return (tag + classes || 'node') + kind + text;
}

function round3(value) {
  return Number(Number(value).toFixed(3));
}

/**
 * @param {Array} nodes  analyzer nodes for one slide
 * @param {{width: number, height: number}} [page]  page size in inches
 * @returns {{collisions: Array, overflows: Array, beyond: Array}}
 */
function auditLayout(nodes, page) {
  const collisions = [];
  const overflows = [];
  const beyond = [];
  const pageSize = page && Number.isFinite(page.width) && Number.isFinite(page.height) ? page : null;

  const visit = (siblings, parent) => {
    const boxes = siblings.map((node) => ({ node, box: boxOf(node) }));

    for (let i = 0; i < boxes.length; i += 1) {
      for (let j = i + 1; j < boxes.length; j += 1) {
        const first = boxes[i];
        const second = boxes[j];
        if (!first.box || !second.box) continue;
        // Layers are intentional: absolute positioning says so, and so does a relative
        // nudge - the author moved the box onto its neighbour on purpose.
        if (first.node.absolute || second.node.absolute) continue;
        if (first.node.relativeShift || second.node.relativeShift) continue;
        const area = intersectionArea(first.box, second.box);
        if (area < MIN_AREA) continue;
        const smaller = Math.min(first.box.w * first.box.h, second.box.w * second.box.h);
        if (smaller > 0 && area / smaller < MIN_RATIO) continue;
        collisions.push({
          a: labelOf(first.node),
          b: labelOf(second.node),
          parent: parent ? labelOf(parent) : 'slide',
          area: round3(area)
        });
      }
    }

    siblings.forEach((node) => {
      const children = node.children || [];
      const box = boxOf(node);
      // A slide is a fixed canvas: content past its edge is content the audience
      // never sees. `nowrap` text is exempt because overflowing is what it means,
      // and an absolutely positioned node is a deliberate layer (a band that bleeds
      // past the edge on purpose), not flow content that ran out of room.
      // A relative nudge is the same kind of statement: the author put it there.
      if (box && pageSize && !node.noWrap && !node.absolute
        && !node.relativeShift) {
        const overRight = box.x + box.w - pageSize.width;
        const overBottom = box.y + box.h - pageSize.height;
        const underLeft = -box.x;
        const underTop = -box.y;
        const worst = Math.max(overRight, overBottom, underLeft, underTop);
        if (worst > TOLERANCE) {
          const side = worst === overRight ? 'right'
            : (worst === overBottom ? 'bottom' : (worst === underLeft ? 'left' : 'top'));
          beyond.push({ node: labelOf(node), side, over: round3(worst) });
        }
      }
      if (box && children.length) {
        const content = children.filter((child) => !child.absolute && !child.relativeShift);
        const right = content.reduce((max, child) => Math.max(max, (child.x || 0) + (child.w || 0)), box.x);
        const bottom = content.reduce((max, child) => Math.max(max, (child.y || 0) + (child.h || 0)), box.y);
        const overflowX = right - (box.x + box.w);
        const overflowY = bottom - (box.y + box.h);
        if (overflowY > TOLERANCE || overflowX > TOLERANCE) {
          overflows.push({
            node: labelOf(node),
            over: round3(Math.max(overflowX, overflowY)),
            axis: overflowY >= overflowX ? 'y' : 'x'
          });
        }
      }
      if (children.length) visit(children, node);
    });
  };

  visit(Array.isArray(nodes) ? nodes : [], null);
  return { collisions, overflows, beyond };
}

/** Audit every slide of an analysis result. */
function auditAnalysis(analysis) {
  const slides = [];
  const page = analysis && analysis.pageSize ? analysis.pageSize : null;
  (analysis && analysis.slides ? analysis.slides : []).forEach((slide, index) => {
    const result = auditLayout(slide.nodes, page);
    if (result.collisions.length || result.overflows.length || result.beyond.length) {
      slides.push({ slide: slide.index || index + 1, ...result });
    }
  });
  const total = slides.reduce((sum, entry) =>
    sum + entry.collisions.length + entry.overflows.length + entry.beyond.length, 0);
  return { slides, total };
}

module.exports = { auditLayout, auditAnalysis };
