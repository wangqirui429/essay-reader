/**
 * Split the compact dictionary into a small core plus 26 shards, so a phone
 * loads ~1 MB up front instead of 7 MB, and fetches only the shard it needs
 * when an uncommon word is tapped.
 *
 * Shards are keyed by the first letter of the word; words starting with
 * anything else (digits, punctuation) go into `_`.
 *
 * Usage: node tools/split-dict.mjs
 */

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.dirname(fileURLToPath(import.meta.url));
const DATA = path.join(ROOT, '..', 'public', 'data');
const SRC = path.join(DATA, 'dict-min.json');
const SHARD_DIR = path.join(DATA, 'shards');

/** Words at or below this rank are always in the core file. */
const CORE_RANK = 8000;
/** Extra very common words carried in the core regardless of rank. */
const CORE_EXTRA = /^(a|an|the|and|or|but|if|so|nor|for|yet|of|to|in|on|at|by|as|is|are|was|were|be|been|being|have|has|had|do|does|did|will|would|can|could|shall|should|may|might|must|this|that|these|those|it|its|he|she|they|them|his|her|their|we|you|i|me|him|us|my|your|our|what|which|who|whom|whose|when|where|why|how|all|any|some|more|most|other|such|no|not|only|own|same|than|then|there|too|very|just|also|even|into|over|after|before|about|against|between|through|during|without|within|up|out|off|down|again|further|once)$/;

if (!fs.existsSync(SRC)) {
  console.error(`missing ${SRC} — run tools/build-dict.mjs first`);
  process.exit(1);
}

const all = JSON.parse(fs.readFileSync(SRC, 'utf8'));
const core = {};
const shards = new Map();

for (const [word, def] of Object.entries(all)) {
  const rank = def.f || 0;
  const isCore = (rank > 0 && rank <= CORE_RANK) || CORE_EXTRA.test(word) || word.length <= 4;
  if (isCore) {
    core[word] = def;
    continue;
  }
  const letter = /^[a-z]/.test(word) ? word[0] : '_';
  if (!shards.has(letter)) shards.set(letter, {});
  shards.get(letter)[word] = def;
}

fs.mkdirSync(SHARD_DIR, { recursive: true });

// Remove shards from a previous run so stale letters cannot linger.
for (const old of fs.readdirSync(SHARD_DIR)) {
  if (old.endsWith('.json')) fs.unlinkSync(path.join(SHARD_DIR, old));
}

/**
 * The core is written as several files rather than one. On a high-latency
 * connection the cost is per request, not per byte: six parallel chunks land in
 * a fraction of the time one large file takes, and the first chunk alone is
 * enough to start looking words up.
 */
const CORE_CHUNKS = 6;
const coreEntries = Object.entries(core);
const perChunk = Math.ceil(coreEntries.length / CORE_CHUNKS);
for (let i = 0; i < CORE_CHUNKS; i += 1) {
  const slice = Object.fromEntries(coreEntries.slice(i * perChunk, (i + 1) * perChunk));
  fs.writeFileSync(path.join(DATA, `core-${i}.json`), JSON.stringify(slice), 'utf8');
}

const index = { core: Object.keys(core).length, coreChunks: CORE_CHUNKS, shards: {} };
for (const [letter, words] of [...shards].sort()) {
  const file = path.join(SHARD_DIR, `${letter}.json`);
  fs.writeFileSync(file, JSON.stringify(words), 'utf8');
  index.shards[letter] = Object.keys(words).length;
}
fs.writeFileSync(path.join(DATA, 'dict-index.json'), JSON.stringify(index), 'utf8');

// The legacy single-file build is no longer used by the app.
for (const legacy of ['dict-core.json', 'dict-min.json']) {
  const p = path.join(DATA, legacy);
  if (fs.existsSync(p)) fs.unlinkSync(p);
}

const kb = (p) => (fs.statSync(p).size / 1024).toFixed(0);
console.log(`core: ${coreEntries.length} words in ${CORE_CHUNKS} parallel chunks`);
for (let i = 0; i < CORE_CHUNKS; i += 1) {
  console.log(`  core-${i}.json: ${kb(path.join(DATA, `core-${i}.json`))} KB`);
}
console.log(`shards: ${shards.size} files`);
for (const letter of [...shards.keys()].sort()) {
  const p = path.join(SHARD_DIR, `${letter}.json`);
  console.log(`  ${letter}.json: ${Object.keys(shards.get(letter)).length} words, ${kb(p)} KB`);
}
