/**
 * Generate the PWA icons without any image library: rasterises a book glyph
 * onto an RGBA buffer and encodes it as PNG with zlib.
 *
 * Usage: node tools/make-icons.mjs
 */

import fs from 'node:fs';
import path from 'node:path';
import zlib from 'node:zlib';
import { fileURLToPath } from 'node:url';

const ROOT = path.dirname(fileURLToPath(import.meta.url));
const OUT_DIR = path.join(ROOT, '..', 'public', 'icons');

const PAPER = [246, 241, 230];
const ACCENT = [154, 59, 31];
const ACCENT_DARK = [110, 40, 20];

function crc32(buf) {
  let c = ~0;
  for (let i = 0; i < buf.length; i += 1) {
    c ^= buf[i];
    for (let k = 0; k < 8; k += 1) c = (c >>> 1) ^ (0xedb88320 & -(c & 1));
  }
  return ~c >>> 0;
}

function chunk(type, data) {
  const len = Buffer.alloc(4);
  len.writeUInt32BE(data.length);
  const body = Buffer.concat([Buffer.from(type, 'ascii'), data]);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(body));
  return Buffer.concat([len, body, crc]);
}

function encodePng(width, height, rgba) {
  const sig = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0);
  ihdr.writeUInt32BE(height, 4);
  ihdr[8] = 8;
  ihdr[9] = 6;
  const stride = width * 4;
  const raw = Buffer.alloc((stride + 1) * height);
  for (let y = 0; y < height; y += 1) {
    raw[y * (stride + 1)] = 0;
    rgba.copy(raw, y * (stride + 1) + 1, y * stride, (y + 1) * stride);
  }
  return Buffer.concat([
    sig,
    chunk('IHDR', ihdr),
    chunk('IDAT', zlib.deflateSync(raw, { level: 9 })),
    chunk('IEND', Buffer.alloc(0)),
  ]);
}

/** Signed distance to a rounded rectangle, negative inside. */
function sdRoundRect(px, py, x0, y0, x1, y1, r) {
  const cx = (x0 + x1) / 2;
  const cy = (y0 + y1) / 2;
  const hw = (x1 - x0) / 2 - r;
  const hh = (y1 - y0) / 2 - r;
  const dx = Math.abs(px - cx) - hw;
  const dy = Math.abs(py - cy) - hh;
  const ax = Math.max(dx, 0);
  const ay = Math.max(dy, 0);
  return Math.hypot(ax, ay) + Math.min(Math.max(dx, dy), 0) - r;
}

/** Coverage in [0,1] from a signed distance, 1px anti-aliasing. */
const cover = (d) => Math.min(1, Math.max(0, 0.5 - d));

/** Mix colour `a` over `b` by alpha t. */
function mix(a, b, t) {
  return [
    Math.round(a[0] + (b[0] - a[0]) * t),
    Math.round(a[1] + (b[1] - a[1]) * t),
    Math.round(a[2] + (b[2] - a[2]) * t),
  ];
}

/**
 * An open book: two page quads meeting at a central spine, a bookmark ribbon
 * on the right page, and a couple of ruled lines to read as text.
 */
function drawIcon(size, maskable) {
  const rgba = Buffer.alloc(size * size * 4);
  const pad = maskable ? size * 0.12 : 0;
  const innerW = size - pad * 2;
  const bgR = maskable ? innerW / 2 : size * 0.22;

  // Geometry relative to the icon box.
  const cx = size / 2;
  const cy = size / 2 + size * 0.01;
  const halfW = innerW * 0.31;
  const halfH = innerW * 0.23;
  const spineGap = innerW * 0.018;
  const pageR = innerW * 0.03;

  for (let y = 0; y < size; y += 1) {
    for (let x = 0; x < size; x += 1) {
      const px = x + 0.5;
      const py = y + 0.5;

      // Rounded background.
      const dBg = maskable ? 0 : sdRoundRect(px, py, pad, pad, size - pad, size - pad, bgR);
      const bgA = maskable ? 1 : cover(dBg);
      if (bgA <= 0.001) continue;

      let col = PAPER;

      // Outer page block (slightly larger, for a cover edge).
      const dCover = sdRoundRect(px, py, cx - halfW - 2, cy - halfH - 2, cx + halfW + 2, cy + halfH + 2, pageR + 2);

      // Left page and right page, split by the spine gap.
      const dLeft = sdRoundRect(px, py, cx - halfW, cy - halfH, cx - spineGap, cy + halfH, pageR);
      const dRight = sdRoundRect(px, py, cx + spineGap, cy - halfH, cx + halfW, cy + halfH, pageR);

      if (dCover < 0.5) col = mix(col, ACCENT_DARK, cover(dCover));

      // Pages are paper-coloured, so the cover reads as a thin outline.
      if (dLeft < 0.5) col = mix(col, PAPER, cover(dLeft));
      if (dRight < 0.5) col = mix(col, PAPER, cover(dRight));

      // Ruled text lines on both pages.
      const lines = 4;
      for (let i = 0; i < lines; i += 1) {
        const ly = cy - halfH * 0.62 + (i * halfH * 1.28) / (lines - 1);
        const lh = Math.max(1.2, innerW * 0.012);
        const inset = innerW * 0.055;
        const dLineL = sdRoundRect(px, py, cx - halfW + inset, ly - lh, cx - spineGap - inset * 0.7, ly + lh, lh);
        const dLineR = sdRoundRect(px, py, cx + spineGap + inset * 0.7, ly - lh, cx + halfW - inset, ly + lh, lh);
        if (dLineL < 0.5) col = mix(col, ACCENT, cover(dLineL) * 0.55);
        if (dLineR < 0.5) col = mix(col, ACCENT, cover(dLineR) * 0.55);
      }

      // Bookmark ribbon on the right page, with a notch cut at the bottom.
      const rbW = innerW * 0.075;
      const rbX0 = cx + halfW * 0.42;
      const rbX1 = rbX0 + rbW;
      const rbY0 = cy - halfH - innerW * 0.075;
      const rbY1 = cy + halfH * 0.12;
      const dRibbon = sdRoundRect(px, py, rbX0, rbY0, rbX1, rbY1, Math.max(1, innerW * 0.008));
      const notch = Math.abs(px - (rbX0 + rbW / 2)) / (rbW / 2) + (py - rbY1) / (rbW * 0.8);
      if (dRibbon < 0.5 && notch < 1) col = mix(col, ACCENT, cover(dRibbon));
      // Cut a V into the ribbon bottom.
      if (notch < 1 && dRibbon < 0.5) {
        const depth = (1 - Math.abs(px - (rbX0 + rbW / 2)) / (rbW / 2)) * rbW * 0.8;
        if (py > rbY1 - depth) col = mix(col, PAPER, 1);
      }

      const i4 = (y * size + x) * 4;
      rgba[i4] = col[0];
      rgba[i4 + 1] = col[1];
      rgba[i4 + 2] = col[2];
      rgba[i4 + 3] = Math.round(bgA * 255);
    }
  }
  return encodePng(size, size, rgba);
}

fs.mkdirSync(OUT_DIR, { recursive: true });
for (const [name, size, maskable] of [
  ['icon-192.png', 192, false],
  ['icon-512.png', 512, false],
  ['icon-maskable-512.png', 512, true],
]) {
  const png = drawIcon(size, maskable);
  fs.writeFileSync(path.join(OUT_DIR, name), png);
  console.log(`${name}: ${size}x${size}, ${png.length} bytes`);
}
