'use strict';

const zlib = require('node:zlib');

/**
 * Minimal deterministic PNG encoder. Used to produce demo and test image
 * fixtures at runtime so no binary assets need to be committed.
 */

const CRC_TABLE = (() => {
  const table = new Uint32Array(256);
  for (let n = 0; n < 256; n += 1) {
    let c = n;
    for (let k = 0; k < 8; k += 1) c = c & 1 ? 0xEDB88320 ^ (c >>> 1) : c >>> 1;
    table[n] = c >>> 0;
  }
  return table;
})();

function crc32(buffer) {
  let crc = 0xFFFFFFFF;
  for (let i = 0; i < buffer.length; i += 1) crc = CRC_TABLE[(crc ^ buffer[i]) & 0xFF] ^ (crc >>> 8);
  return (crc ^ 0xFFFFFFFF) >>> 0;
}

function chunk(type, data) {
  const length = Buffer.alloc(4);
  length.writeUInt32BE(data.length, 0);
  const typeBuffer = Buffer.from(type, 'ascii');
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(Buffer.concat([typeBuffer, data])), 0);
  return Buffer.concat([length, typeBuffer, data, crc]);
}

/**
 * Build a truecolor PNG.
 * @param {number} width
 * @param {number} height
 * @param {(x: number, y: number) => [number, number, number]} [shade]
 * @returns {Buffer}
 */
function makePng(width, height, shade) {
  if (!Number.isInteger(width) || !Number.isInteger(height) || width <= 0 || height <= 0) {
    throw new Error('makePng requires positive integer dimensions');
  }
  const paint = typeof shade === 'function' ? shade : (x, y) => [x % 256, y % 256, (x + y) % 256];
  const raw = Buffer.alloc(height * (1 + width * 3));
  let offset = 0;
  for (let y = 0; y < height; y += 1) {
    raw[offset] = 0;
    offset += 1;
    for (let x = 0; x < width; x += 1) {
      const [r, g, b] = paint(x, y, width, height);
      raw[offset] = r & 0xFF;
      raw[offset + 1] = g & 0xFF;
      raw[offset + 2] = b & 0xFF;
      offset += 3;
    }
  }
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0);
  ihdr.writeUInt32BE(height, 4);
  ihdr[8] = 8;   // bit depth
  ihdr[9] = 2;   // color type: truecolor
  ihdr[10] = 0;  // compression
  ihdr[11] = 0;  // filter
  ihdr[12] = 0;  // interlace
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4E, 0x47, 0x0D, 0x0A, 0x1A, 0x0A]),
    chunk('IHDR', ihdr),
    chunk('IDAT', zlib.deflateSync(raw, { level: 9 })),
    chunk('IEND', Buffer.alloc(0))
  ]);
}

/** Write a PNG fixture into a directory and return its absolute path. */
function writePngFixture(directory, fileName, width, height, shade) {
  const fs = require('node:fs');
  const path = require('node:path');
  fs.mkdirSync(directory, { recursive: true });
  const target = path.join(directory, fileName);
  fs.writeFileSync(target, makePng(width, height, shade));
  return target;
}

/** Two-colour diagonal gradient painter, handy for visually obvious crops. */
function gradientPainter(from, to) {
  const start = from || [24, 59, 58];
  const end = to || [211, 107, 69];
  return (x, y, width, height) => {
    const t = width > 1 && height > 1 ? (x / (width - 1) + y / (height - 1)) / 2 : 0;
    return [0, 1, 2].map((channel) => Math.round(start[channel] + (end[channel] - start[channel]) * t));
  };
}

/**
 * Four-quadrant pattern with a white frame, a centre cross and corner ticks.
 * A smooth gradient makes every fit mode look identical, so fixture images that
 * are meant to prove cropping/focus/zoom need landmarks like these.
 */
function quadrantPainter(colours, options = {}) {
  const quadrants = colours && colours.length === 4
    ? colours
    : [[24, 59, 58], [0, 166, 166], [211, 107, 69], [245, 240, 230]];
  const frame = options.frame === undefined ? 26 : options.frame;
  const tick = options.tick === undefined ? 60 : options.tick;
  return (x, y, width, height) => {
    const midX = width / 2;
    const midY = height / 2;
    const left = x < midX;
    const top = y < midY;
    if (x < frame || y < frame || x >= width - frame || y >= height - frame) return [255, 255, 255];
    if (Math.abs(x - midX) < 2 || Math.abs(y - midY) < 2) return [255, 255, 255];
    // Corner ticks inside each quadrant give an obvious distortion cue.
    const inTickX = left ? x - frame < tick : width - frame - x < tick;
    const inTickY = top ? y - frame < tick : height - frame - y < tick;
    if (inTickX && inTickY) return [255, 255, 255];
    if (left && top) return quadrants[0];
    if (!left && top) return quadrants[1];
    if (left && !top) return quadrants[2];
    return quadrants[3];
  };
}

module.exports = { makePng, writePngFixture, gradientPainter, quadrantPainter, crc32 };
