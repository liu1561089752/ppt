'use strict';

/**
 * Tolerant HTML parser for the HTML → Native pipeline.
 *
 * This is not a WHATWG-conformant browser parser: it targets author-written
 * slide markup (well-formed, no implied-tag trickery) and degrades gracefully on
 * malformed input so the analyzer can still report useful diagnostics.
 *
 * Produces a tree of:
 *   { type: 'element', tag, attrs, children, parent }
 *   { type: 'text', text, parent }
 */

const VOID_TAGS = new Set([
  'area', 'base', 'br', 'col', 'embed', 'hr', 'img', 'input',
  'link', 'meta', 'param', 'source', 'track', 'wbr'
]);

const RAW_TEXT_TAGS = new Set(['script', 'style', 'textarea']);

const NAMED_ENTITIES = {
  amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: '\u00A0',
  copy: '©', reg: '®', trade: '™', hellip: '…', mdash: '—', ndash: '–',
  middot: '·', times: '×', divide: '÷', laquo: '«', raquo: '»',
  ldquo: '“', rdquo: '”', lsquo: '‘', rsquo: '’', deg: '°'
};

function decodeEntities(text) {
  return String(text).replace(/&(#x?[0-9a-fA-F]+|[a-zA-Z][a-zA-Z0-9]*);/gu, (whole, body) => {
    if (body[0] === '#') {
      const code = body[1] === 'x' || body[1] === 'X'
        ? Number.parseInt(body.slice(2), 16)
        : Number.parseInt(body.slice(1), 10);
      if (Number.isFinite(code) && code > 0 && code <= 0x10FFFF) return String.fromCodePoint(code);
      return whole;
    }
    const named = NAMED_ENTITIES[body.toLowerCase()];
    return named === undefined ? whole : named;
  });
}

function findTagEnd(source, from) {
  let quote = null;
  for (let index = from + 1; index < source.length; index += 1) {
    const character = source[index];
    if (quote) {
      if (character === quote) quote = null;
    } else if (character === '"' || character === "'") {
      quote = character;
    } else if (character === '>') {
      return index;
    }
  }
  return -1;
}

function parseAttributes(text) {
  const attrs = Object.create(null);
  const pattern = /([^\s=/]+)(?:\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s"'>]+)))?/gu;
  let match = pattern.exec(text);
  while (match) {
    const name = match[1].toLowerCase();
    const value = match[2] !== undefined ? match[2]
      : match[3] !== undefined ? match[3]
        : match[4] !== undefined ? match[4]
          : '';
    if (name && name !== '/') attrs[name] = decodeEntities(value);
    match = pattern.exec(text);
  }
  return attrs;
}

function createElement(tag, attrs) {
  return { type: 'element', tag, attrs: attrs || Object.create(null), children: [], parent: null };
}

function appendNode(parent, node) {
  node.parent = parent;
  parent.children.push(node);
  return node;
}

function parseHtml(source) {
  const root = createElement('#document', Object.create(null));
  const stack = [root];
  const input = String(source || '');
  let index = 0;

  const appendText = (raw) => {
    const text = decodeEntities(raw);
    if (!text.trim() && text.indexOf('\u00A0') === -1) return;
    appendNode(stack[stack.length - 1], { type: 'text', text, children: [], parent: null });
  };

  while (index < input.length) {
    const lt = input.indexOf('<', index);
    if (lt === -1) {
      appendText(input.slice(index));
      break;
    }
    if (lt > index) appendText(input.slice(index, lt));

    if (input.startsWith('<!--', lt)) {
      const end = input.indexOf('-->', lt + 4);
      index = end === -1 ? input.length : end + 3;
      continue;
    }
    if (input.startsWith('<!', lt) || input.startsWith('<?', lt)) {
      const end = input.indexOf('>', lt);
      index = end === -1 ? input.length : end + 1;
      continue;
    }
    if (input.startsWith('</', lt)) {
      const end = input.indexOf('>', lt);
      const name = input.slice(lt + 2, end === -1 ? input.length : end).trim().toLowerCase();
      for (let depth = stack.length - 1; depth > 0; depth -= 1) {
        if (stack[depth].tag === name) {
          stack.length = depth;
          break;
        }
      }
      index = end === -1 ? input.length : end + 1;
      continue;
    }

    const end = findTagEnd(input, lt);
    if (end === -1) {
      appendText(input.slice(lt));
      break;
    }
    const raw = input.slice(lt + 1, end);
    const selfClosing = /\/\s*$/u.test(raw);
    const body = selfClosing ? raw.replace(/\/\s*$/u, '') : raw;
    const boundary = body.search(/[\s/]/u);
    const tag = (boundary === -1 ? body : body.slice(0, boundary)).toLowerCase();
    const attrText = boundary === -1 ? '' : body.slice(boundary);
    index = end + 1;
    if (!tag) continue;

    const node = appendNode(stack[stack.length - 1], createElement(tag, parseAttributes(attrText)));

    if (RAW_TEXT_TAGS.has(tag)) {
      const closeIndex = input.toLowerCase().indexOf('</' + tag, index);
      const content = input.slice(index, closeIndex === -1 ? input.length : closeIndex);
      if (content.trim()) appendNode(node, { type: 'text', text: decodeEntities(content), children: [], parent: null });
      if (closeIndex === -1) {
        index = input.length;
      } else {
        const closeEnd = input.indexOf('>', closeIndex);
        index = closeEnd === -1 ? input.length : closeEnd + 1;
      }
      continue;
    }

    if (!selfClosing && !VOID_TAGS.has(tag)) stack.push(node);
  }

  return root;
}

function classesOf(node) {
  const raw = node && node.attrs && node.attrs.class;
  if (!raw) return [];
  return String(raw).split(/\s+/u).filter(Boolean);
}

function hasClass(node, name) {
  return classesOf(node).includes(name);
}

function walk(node, visitor) {
  if (!node) return;
  visitor(node);
  (node.children || []).forEach((child) => walk(child, visitor));
}

function textContent(node) {
  if (!node) return '';
  if (node.type === 'text') return node.text;
  return (node.children || []).map(textContent).join('');
}

function normalizedText(node) {
  return textContent(node).replace(/[ \t\u00A0]+/gu, ' ').replace(/\s*\n\s*/gu, '\n').trim();
}

function findAll(node, predicate) {
  const found = [];
  walk(node, (candidate) => { if (predicate(candidate)) found.push(candidate); });
  return found;
}

function elementChildren(node) {
  return (node.children || []).filter((child) => child.type === 'element');
}

module.exports = {
  VOID_TAGS,
  RAW_TEXT_TAGS,
  decodeEntities,
  parseHtml,
  parseAttributes,
  classesOf,
  hasClass,
  walk,
  textContent,
  normalizedText,
  findAll,
  elementChildren
};
