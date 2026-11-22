/**
 * Verify the two locales define exactly the same keys, and that every
 * `data-i18n` attribute in index.html and every t('...') call in the JS
 * resolves to a real key.
 *
 * A missing key is invisible at runtime — t() returns the key itself, so the
 * user would see "settings.email" printed on screen. This catches that.
 *
 * Usage: node tools/check-i18n-keys.mjs
 */

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const pub = path.join(here, '..', 'public');
const source = fs.readFileSync(path.join(pub, 'js', 'i18n.js'), 'utf8');

/** Pull one locale block out of the STRINGS literal. */
function localeBlock(name) {
  const start = source.indexOf(`\n  ${name}: {`);
  if (start < 0) throw new Error(`locale ${name} not found`);
  // The block ends at the first line holding exactly "  }," after the start.
  const end = source.indexOf('\n  },', start);
  if (end < 0) throw new Error(`locale ${name} not terminated`);
  return source.slice(start, end);
}

function keysOf(block) {
  const keys = new Set();
  for (const match of block.matchAll(/^\s{4}'([^']+)':/gm)) keys.add(match[1]);
  return keys;
}

const zh = keysOf(localeBlock('zh'));
const en = keysOf(localeBlock('en'));

let failures = 0;
const fail = (msg) => { console.log(`FAIL ${msg}`); failures += 1; };

console.log(`zh: ${zh.size} keys, en: ${en.size} keys`);

for (const key of zh) if (!en.has(key)) fail(`missing from en: ${key}`);
for (const key of en) if (!zh.has(key)) fail(`missing from zh: ${key}`);

// ---- every key used by the markup must exist -------------------------------
const html = fs.readFileSync(path.join(pub, 'index.html'), 'utf8');
const usedInHtml = new Set();
for (const m of html.matchAll(/data-i18n="([^"]+)"/g)) usedInHtml.add(m[1]);
for (const m of html.matchAll(/data-i18n-attr="([^"]+)"/g)) {
  for (const pair of m[1].split(',')) {
    const key = pair.split(':')[1]?.trim();
    if (key) usedInHtml.add(key);
  }
}
for (const key of usedInHtml) {
  if (!zh.has(key)) fail(`index.html uses an unknown key: ${key}`);
}

// ---- every static t('...') call in the scripts must exist ------------------
const jsFiles = fs.readdirSync(path.join(pub, 'js')).filter((f) => f.endsWith('.js'));
const usedInJs = new Set();
for (const file of jsFiles) {
  const text = fs.readFileSync(path.join(pub, 'js', file), 'utf8');
  for (const m of text.matchAll(/\bt\('([a-zA-Z][\w.]*\.[\w.]+)'/g)) usedInJs.add(m[1]);
}
for (const key of usedInJs) {
  if (!zh.has(key)) fail(`js uses an unknown key: ${key}`);
}

// Keys built at runtime (`auth.${code}`) are checked against their families.
const dynamicFamilies = ['auth.', 'sync.', 'time.'];
const familyCounts = Object.fromEntries(
  dynamicFamilies.map((f) => [f, [...zh].filter((k) => k.startsWith(f)).length]),
);

console.log(`used in index.html: ${usedInHtml.size}`);
console.log(`used in js: ${usedInJs.size}`);
console.log('dynamic key families:', JSON.stringify(familyCounts));
for (const [family, count] of Object.entries(familyCounts)) {
  if (count === 0) fail(`no keys defined for dynamic family ${family}`);
}

if (failures) {
  console.log(`\n${failures} problem(s)`);
  process.exit(1);
}
console.log('\nall i18n keys consistent');