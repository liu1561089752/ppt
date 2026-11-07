'use strict';

const PT_PER_IN = 72;
const PX_PER_IN = 96;
const EMU_PER_IN = 914400;

function toInches(value, unit = 'in') {
  if (typeof value !== 'number' || !Number.isFinite(value)) throw new TypeError('Expected a finite numeric dimension');
  if (unit === 'in') return value;
  if (unit === 'pt') return value / PT_PER_IN;
  if (unit === 'px') return value / PX_PER_IN;
  if (unit === 'mm') return value / 25.4;
  throw new Error('Unsupported unit: ' + unit);
}

function normalizePageSize(size) {
  if (!size || size === 'wide' || size === '16:9') return { width: 13.333, height: 7.5 };
  if (size === 'standard' || size === '4:3') return { width: 10, height: 7.5 };
  if (typeof size === 'object' && Number.isFinite(size.width) && Number.isFinite(size.height)) return { width: size.width, height: size.height };
  throw new Error('pageSize must be wide, standard, or { width, height } in inches');
}

module.exports = { PT_PER_IN, PX_PER_IN, EMU_PER_IN, toInches, normalizePageSize };
