#!/usr/bin/env node
/**
 * Draws the app icon and writes every size the web needs into public/.
 *
 *   node tools/make-icons.mjs
 *
 * The icon is generated rather than committed as a binary blob, for the same
 * reason the icon set in src/components/Icon.jsx is hand-written SVG: this
 * project has no design tool in the loop and no image dependency. The artwork
 * is the `SHAPES` list below — change a number, re-run, and every size,
 * including the SVG favicon, is regenerated consistently.
 *
 * No canvas library either: polygons are filled with a scanline rasteriser at
 * 3x and box-downsampled for anti-aliasing, and the PNG is assembled from
 * zlib-deflated scanlines. Both are a few dozen lines, which is cheaper than
 * a native dependency that has to build on Windows.
 */

import { deflateSync } from 'node:zlib';
import { writeFileSync, mkdirSync } from 'node:fs';
import path from 'node:path';

const OUT = path.join(import.meta.dirname, '..', 'public');

/** Everything is drawn in a 1024x1024 design space and scaled per size. */
const D = 1024;

const BLUE = '#2563eb';
const WHITE = '#ffffff';

/**
 * A card with a bolt through it: the deck, and the "smash".
 *
 * The back card is rotated to read as a *stack* at 32 pixels, where two
 * aligned rectangles would merge into one. Everything stays inside the middle
 * ~76% of the square so that Android's maskable crop — which can cut a circle
 * out of this — never takes a bite out of the bolt.
 */
const SHAPES = [
  { kind: 'rect', x: 0, y: 0, w: D, h: D, r: 224, fill: BLUE },
  { kind: 'rect', x: 302, y: 232, w: 420, h: 560, r: 56, fill: WHITE, alpha: 0.42, rotate: -15 },
  { kind: 'rect', x: 302, y: 232, w: 420, h: 560, r: 56, fill: WHITE, rotate: 4 },
  {
    kind: 'poly',
    fill: BLUE,
    points: [[560, 332], [422, 532], [500, 532], [464, 692], [602, 492], [524, 492]],
    rotate: 4,
  },
];

/** The sizes the manifest, Safari and the browser tab all want. */
const SIZES = [
  { file: 'icon-512.png', size: 512 },
  { file: 'icon-192.png', size: 192 },
  { file: 'apple-touch-icon.png', size: 180 },
  { file: 'favicon-32.png', size: 32 },
];

/** Called at the bottom of the file: the helpers below are `const`, so running
 *  this at the top would hit them inside their temporal dead zone. */
function main() {
  mkdirSync(OUT, { recursive: true });

  for (const { file, size } of SIZES) {
    writeFileSync(path.join(OUT, file), encodePng(size, size, raster(size)));
    console.log(`wrote public/${file}  (${size}x${size})`);
  }

  // An .ico is just a container, and every browser that reads one also reads a
  // PNG inside it — so the 32px render is reused rather than drawn again.
  writeFileSync(path.join(OUT, 'favicon.ico'), ico(encodePng(32, 32, raster(32)), 32));
  console.log('wrote public/favicon.ico');

  writeFileSync(path.join(OUT, 'icon.svg'), svg());
  console.log('wrote public/icon.svg');
}

// ------------------------------------------------------------- rasteriser --

/**
 * Paints the shapes into an RGBA buffer, 3x supersampled and averaged down.
 *
 * Painter's algorithm: shapes are composited in order, so the bolt lands on
 * the card and the card on the background, exactly as they are listed.
 */
function raster(size) {
  const ss = 3;
  const w = size * ss;
  const big = new Float64Array(w * w * 4); // straight (non-premultiplied) RGBA

  for (const shape of SHAPES) {
    const points = toPolygon(shape).map(([x, y]) => [(x * w) / D, (y * w) / D]);
    const [r, g, b] = hex(shape.fill);
    fillPolygon(big, w, points, r, g, b, shape.alpha ?? 1);
  }

  // Box-downsample: the average of each ss x ss block is the anti-aliasing.
  const out = Buffer.alloc(size * size * 4);
  const n = ss * ss;

  for (let y = 0; y < size; y += 1) {
    for (let x = 0; x < size; x += 1) {
      let R = 0; let G = 0; let B = 0; let A = 0;

      for (let dy = 0; dy < ss; dy += 1) {
        for (let dx = 0; dx < ss; dx += 1) {
          const i = ((y * ss + dy) * w + (x * ss + dx)) * 4;
          const a = big[i + 3];
          // Weight colour by alpha, or a transparent sample would drag the
          // edge pixels toward black.
          R += big[i] * a; G += big[i + 1] * a; B += big[i + 2] * a; A += a;
        }
      }

      const o = (y * size + x) * 4;
      out[o] = A > 0 ? Math.round(R / A) : 0;
      out[o + 1] = A > 0 ? Math.round(G / A) : 0;
      out[o + 2] = A > 0 ? Math.round(B / A) : 0;
      out[o + 3] = Math.round((A / n) * 255);
    }
  }

  return out;
}

/** Even-odd scanline fill, sampling at the centre of each row. */
function fillPolygon(buf, w, points, r, g, b, alpha) {
  let minY = Infinity; let maxY = -Infinity;
  for (const [, y] of points) { if (y < minY) minY = y; if (y > maxY) maxY = y; }

  const from = Math.max(0, Math.floor(minY));
  const to = Math.min(w - 1, Math.ceil(maxY));

  for (let y = from; y <= to; y += 1) {
    const cy = y + 0.5;
    const crossings = [];

    for (let i = 0; i < points.length; i += 1) {
      const [x1, y1] = points[i];
      const [x2, y2] = points[(i + 1) % points.length];
      if ((y1 <= cy && y2 > cy) || (y2 <= cy && y1 > cy)) {
        crossings.push(x1 + ((cy - y1) / (y2 - y1)) * (x2 - x1));
      }
    }

    crossings.sort((a, c) => a - c);

    for (let i = 0; i + 1 < crossings.length; i += 2) {
      const start = Math.max(0, Math.round(crossings[i]));
      const end = Math.min(w - 1, Math.round(crossings[i + 1]) - 1);

      for (let x = start; x <= end; x += 1) {
        const o = (y * w + x) * 4;
        const under = buf[o + 3];
        const over = alpha;
        const out = over + under * (1 - over);
        if (out === 0) continue;

        buf[o] = (r * over + buf[o] * under * (1 - over)) / out;
        buf[o + 1] = (g * over + buf[o + 1] * under * (1 - over)) / out;
        buf[o + 2] = (b * over + buf[o + 2] * under * (1 - over)) / out;
        buf[o + 3] = out;
      }
    }
  }
}

/** Every shape becomes a polygon; a rounded rect's corners are 10 segments each. */
function toPolygon(shape) {
  const points = shape.kind === 'poly' ? shape.points.slice() : roundedRect(shape);
  if (!shape.rotate) return points;

  const rad = (shape.rotate * Math.PI) / 180;
  const cos = Math.cos(rad);
  const sin = Math.sin(rad);
  // Rotate about the design's centre, which is where the artwork is balanced.
  const cx = D / 2;
  const cy = D / 2;

  return points.map(([x, y]) => [
    cx + (x - cx) * cos - (y - cy) * sin,
    cy + (x - cx) * sin + (y - cy) * cos,
  ]);
}

function roundedRect({ x, y, w, h, r }) {
  const radius = Math.min(r, w / 2, h / 2);
  const steps = 10;
  const points = [];

  const corners = [
    [x + w - radius, y + radius, -90],   // top right
    [x + w - radius, y + h - radius, 0], // bottom right
    [x + radius, y + h - radius, 90],    // bottom left
    [x + radius, y + radius, 180],       // top left
  ];

  for (const [cx, cy, start] of corners) {
    for (let i = 0; i <= steps; i += 1) {
      const a = ((start + (i / steps) * 90) * Math.PI) / 180;
      points.push([cx + radius * Math.cos(a), cy + radius * Math.sin(a)]);
    }
  }

  return points;
}

function hex(value) {
  return [
    parseInt(value.slice(1, 3), 16),
    parseInt(value.slice(3, 5), 16),
    parseInt(value.slice(5, 7), 16),
  ];
}

// ------------------------------------------------------------------- PNG --

function encodePng(width, height, rgba) {
  const raw = Buffer.alloc((width * 4 + 1) * height);
  for (let y = 0; y < height; y += 1) {
    raw[y * (width * 4 + 1)] = 0; // filter type 0 (None)
    rgba.copy(raw, y * (width * 4 + 1) + 1, y * width * 4, (y + 1) * width * 4);
  }

  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0);
  ihdr.writeUInt32BE(height, 4);
  ihdr[8] = 8;  // bit depth
  ihdr[9] = 6;  // colour type: RGBA

  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', ihdr),
    chunk('IDAT', deflateSync(raw, { level: 9 })),
    chunk('IEND', Buffer.alloc(0)),
  ]);
}

function chunk(type, data) {
  const head = Buffer.alloc(8);
  head.writeUInt32BE(data.length, 0);
  head.write(type, 4, 'ascii');

  const crcBuf = Buffer.alloc(4);
  crcBuf.writeUInt32BE(crc32(Buffer.concat([head.subarray(4), data])), 0);

  return Buffer.concat([head, data, crcBuf]);
}

const CRC_TABLE = (() => {
  const table = new Uint32Array(256);
  for (let n = 0; n < 256; n += 1) {
    let c = n;
    for (let k = 0; k < 8; k += 1) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    table[n] = c >>> 0;
  }
  return table;
})();

function crc32(buf) {
  let c = 0xffffffff;
  for (const byte of buf) c = CRC_TABLE[(c ^ byte) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

/** ICO header + one directory entry pointing at an embedded PNG. */
function ico(pngBuffer, size) {
  const header = Buffer.alloc(6);
  header.writeUInt16LE(0, 0);
  header.writeUInt16LE(1, 2); // type: icon
  header.writeUInt16LE(1, 4); // one image

  const entry = Buffer.alloc(16);
  entry[0] = size === 256 ? 0 : size;
  entry[1] = size === 256 ? 0 : size;
  entry.writeUInt16LE(1, 4);  // colour planes
  entry.writeUInt16LE(32, 6); // bits per pixel
  entry.writeUInt32LE(pngBuffer.length, 8);
  entry.writeUInt32LE(22, 12); // offset: 6 + 16

  return Buffer.concat([header, entry, pngBuffer]);
}

// ------------------------------------------------------------------- SVG --

/** The same artwork as vector, for the tab icon on browsers that prefer one. */
function svg() {
  const body = SHAPES.map((shape) => {
    const transform = shape.rotate ? ` transform="rotate(${shape.rotate} ${D / 2} ${D / 2})"` : '';
    const opacity = shape.alpha ? ` opacity="${shape.alpha}"` : '';

    if (shape.kind === 'rect') {
      return `  <rect x="${shape.x}" y="${shape.y}" width="${shape.w}" height="${shape.h}"`
        + ` rx="${shape.r}" fill="${shape.fill}"${opacity}${transform}/>`;
    }

    const d = shape.points.map(([x, y]) => `${x} ${y}`).join(' L ');
    return `  <path d="M ${d} Z" fill="${shape.fill}"${opacity}${transform}/>`;
  }).join('\n');

  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${D} ${D}" width="${D}" height="${D}">\n${body}\n</svg>\n`;
}

main();
