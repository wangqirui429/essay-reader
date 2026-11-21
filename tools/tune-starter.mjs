/**
 * Work out how small a "starter" dictionary can be while still covering almost
 * every word an ordinary reader clicks.
 *
 * The idea: the core file currently carries ~19k words because it keeps
 * everything that is frequent OR short OR a function word. But a starter set
 * only needs the words people actually look up — rare enough to be unknown,
 * common enough to appear. This script measures coverage of several real
 * essays at different cut-offs so the choice is evidence-based.
 *
 * Usage: node tools/tune-starter.mjs
 */

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.dirname(fileURLToPath(import.meta.url));
const PUB = path.join(ROOT, '..', 'public');
const core = JSON.parse(fs.readFileSync(path.join(PUB, 'data', 'dict-core.json'), 'utf8'));
const shardsDir = path.join(PUB, 'data', 'shards');
const shards = {};
for (const f of fs.readdirSync(shardsDir)) {
  shards[f[0]] = JSON.parse(fs.readFileSync(path.join(shardsDir, f), 'utf8'));
}

/** Full dictionary, for a baseline. */
const all = { ...core };
for (const [letter, words] of Object.entries(shards)) {
  for (const [w, d] of Object.entries(words)) if (!all[w]) all[w] = d;
}
console.log(`full dictionary: ${Object.keys(all).length} words`);

/* ------------------------------------------------------- real prose to test */

const ESSAYS = [
  fs.readFileSync(path.join(PUB, 'samples', 'a-hanging.txt'), 'utf8'),
  `Discipline and the Deadline

Last term I watched a classmate rewrite the same paragraph eleven times. She was not lazy; she was afraid. Every sentence she typed sounded like someone else's, so she deleted it and began again.

The habit of endless revision feels like care. It is not care. It is a way of postponing judgement, because a draft that is never finished can never be criticised.

What finally broke the cycle was a rule she invented: no sentence may be rewritten after the fourth attempt.`,
  `Should Artificial Intelligence Enter the Classroom?

Few educational questions divide teachers as sharply as artificial intelligence. Some see in it a tireless assistant that can explain a difficult idea in twelve different ways. Others see a machine that quietly does the thinking that the student was supposed to do.

The strongest argument for the technology is personalisation. A well-designed tool can adapt to the student who is lost without embarrassing either of them.`,
  `Reading on a Screen: Loss or Change?

When paper was replaced by the screen, many readers predicted the death of serious reading. That prediction was partly wrong and partly early.

Research on the difference between paper and screen reading points in a consistent direction. On a screen, readers tend to skim more and remember fewer details of location.`,
];

for (const [i, text] of ESSAYS.entries()) {
  const words = [...new Set((text.toLowerCase().match(/[a-z][a-z'-]*/g) || []))];
  const inFull = words.filter((w) => all[w]).length;
  ESSAYS[i] = { words, coverageFull: inFull / words.length, total: words.length };
}

/* --------------------------------------------- try progressively smaller sets */

/**
 * Build a starter dictionary: keep words whose corpus rank is at or below
 * `maxRank`, plus everything short enough to be unavoidable in real prose.
 */
function buildStarter(maxRank, keepShort) {
  const out = {};
  for (const [word, def] of Object.entries(all)) {
    const rank = def.f || 0;
    const ranked = rank > 0 && rank <= maxRank;
    const short = keepShort && word.length <= keepShort;
    if (ranked || short) out[word] = def;
  }
  return out;
}

console.log('\nrank   short  words    size      coverage of the test essays');
console.log('-'.repeat(74));

const rows = [];
for (const maxRank of [3000, 5000, 8000, 12000, 20000]) {
  for (const keepShort of [0, 3, 4, 5]) {
    const starter = buildStarter(maxRank, keepShort);
    const n = Object.keys(starter).length;
    const sizeKb = Math.round(Buffer.byteLength(JSON.stringify(starter)) / 1024);
    const cov = ESSAYS.map((e) => (e.words.filter((w) => starter[w]).length / e.total) * 100);
    const avg = cov.reduce((a, b) => a + b, 0) / cov.length;
    rows.push({ maxRank, keepShort, n, sizeKb, avg, cov });
    console.log(
      `${String(maxRank).padEnd(6)} ${String(keepShort || '-').padEnd(6)} ${String(n).padEnd(8)} ${String(sizeKb + 'KB').padEnd(9)} ` +
        `${avg.toFixed(1)}%  (${cov.map((c) => c.toFixed(0)).join(' / ')})`,
    );
  }
}

console.log('\nbaseline with the full dictionary:');
for (const [i, e] of ESSAYS.entries()) {
  console.log(`  essay ${i + 1}: ${(e.coverageFull * 100).toFixed(1)}% covered, ${e.total} unique words`);
}

/* ------------------------------------------------------------- recommendation */

// A 4-second budget on a 92 KB/s connection is ~370 KB. Prefer the best
// coverage that fits, because the rest arrives lazily.
const BUDGET_KB = 380;
const fits = rows.filter((r) => r.sizeKb <= BUDGET_KB).sort((a, b) => b.avg - a.avg);
if (fits.length) {
  const best = fits[0];
  console.log(
    `\nrecommended starter: rank<=${best.maxRank}, short<=${best.keepShort || 'off'} ` +
      `-> ${best.n} words, ${best.sizeKb} KB, ${best.avg.toFixed(1)}% coverage`,
  );
} else {
  console.log('\nno configuration fits the budget; the smallest still costs too much');
}
