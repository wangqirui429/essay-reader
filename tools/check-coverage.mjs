/**
 * Measure how well the bundled dictionary covers real prose.
 * Usage: node tools/check-coverage.mjs
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.dirname(fileURLToPath(import.meta.url));
const dict = JSON.parse(fs.readFileSync(path.join(ROOT, '..', 'public', 'data', 'dict-min.json'), 'utf8'));
const sample = fs.readFileSync(path.join(ROOT, '..', 'public', 'samples', 'a-hanging.txt'), 'utf8');

const words = sample.toLowerCase().match(/[a-z][a-z'-]*/g) || [];
const unique = [...new Set(words)];
const missing = unique.filter((w) => !dict[w]);
const cited = missing.filter((w) => !/^(a|an|the|and|or|of|to|in|on|at|is|was|were|he|she|it|they|his|her|its|their|with|for|that|this|as|by|from|had|have|has|but|not|all|one|up|out|be|been|are|we|you|i|me|him|them|us|my|your|our|so|if|no|do|did|does|then|than|there|when|what|who|which|how|into|over|after|about|would|could|should|will|can|may|might|must|very|just|only|more|most|other|such|too|also|even|至)$/);

console.log(`dictionary entries: ${Object.keys(dict).length}`);
console.log(`sample tokens: ${words.length}, unique: ${unique.length}`);
console.log(`covered: ${unique.length - missing.length}/${unique.length} (${(((unique.length - missing.length) / unique.length) * 100).toFixed(1)}%)`);
console.log(`missing: ${missing.length}`);
console.log('missing words:', missing.join(', ').slice(0, 800));
console.log(`\nmissing content words (${cited.length}):`, cited.join(', ').slice(0, 800));

// How many of a few hard words resolve?
for (const w of ['sodden', 'condemned', 'gallows', 'puny', 'warders', 'gambolled', 'reiterated', 'servile', 'torpid']) {
  console.log(`  ${w}: ${dict[w] ? dict[w].t.slice(0, 40) : 'MISSING'}`);
}
