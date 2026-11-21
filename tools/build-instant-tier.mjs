/**
 * Build the "instant" dictionary tier.
 *
 * The first click on a cold visit is limited by how fast data can travel, not by
 * how clever the code is. To make that first answer feel immediate, the most
 * frequently looked-up words go into a small file (about 64 KB compressed) that
 * loads almost instantly. The full dictionary streams in behind it.
 *
 * Selection is by corpus rank, ascending, so the file holds the words a reader
 * is most likely to meet first.
 *
 * Usage: node tools/build-instant-tier.mjs [wordCount]
 */

import fs from 'node:fs';
import path from 'node:path';
import zlib from 'node:zlib';
import { fileURLToPath } from 'node:url';

const ROOT = path.dirname(fileURLToPath(import.meta.url));
const DATA = path.join(ROOT, '..', 'public', 'data');
const COUNT = Number(process.argv[2] || 2000);
const MAX_RANK = 4000;

/** Read every core chunk so the tier can draw on the whole everyday vocabulary. */
const all = {};
for (let i = 0; i < 6; i += 1) {
  const file = path.join(DATA, `core-${i}.json`);
  if (!fs.existsSync(file)) {
    console.error(`missing ${file} — run tools/split-dict.mjs first`);
    process.exit(1);
  }
  Object.assign(all, JSON.parse(fs.readFileSync(file, 'utf8')));
}

const ranked = Object.entries(all)
  .filter(([, def]) => def.f > 0 && def.f <= MAX_RANK)
  .sort((a, b) => (a[1].f || 1e9) - (b[1].f || 1e9));

if (ranked.length < COUNT) {
  console.warn(`only ${ranked.length} words ranked <= ${MAX_RANK}; writing all of them`);
}

const tier = Object.fromEntries(ranked.slice(0, COUNT));
const json = JSON.stringify(tier);
fs.writeFileSync(path.join(DATA, 'instant.json'), json, 'utf8');

const gz = zlib.gzipSync(json, { level: 9 }).length;
console.log(`instant tier: ${Object.keys(tier).length} words`);
console.log(`  raw  : ${(json.length / 1024).toFixed(0)} KB`);
console.log(`  gzip : ${(gz / 1024).toFixed(0)} KB  (what actually crosses the network)`);
console.log(`  rank range: 1..${ranked[Math.min(COUNT, ranked.length) - 1][1].f}`);
