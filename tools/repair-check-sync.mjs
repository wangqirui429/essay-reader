/**
 * One-off repair: PowerShell's Get-Content/Set-Content round-trip corrupted
 * the non-ASCII characters in verify/check-sync.mjs.
 *
 * The source below is deliberately pure ASCII (Chinese is written with \u
 * escapes) so that running this file cannot itself be mangled.
 */

import fs from 'node:fs';

const file = 'verify/check-sync.mjs';
let text = fs.readFileSync(file, 'utf8');
const original = text;

const replacements = [
  // em dash in prose
  [/do NOT travel [^\s]{0,3}?they stay local/, 'do NOT travel \u2014 they stay local'],
  [/` [^\s]{0,3}\$\{detail\}`/, '` \u2014 ${detail}`'],
  // arrows in section banners
  [/laptop [^\s]{0,3}phone -----/g, 'laptop \u2190 phone -----'],
  [/phone [^\s]{0,3}laptop -----/g, 'phone \u2190 laptop -----'],
  // The corruption ate the closing quote as well as one character, so match
  // the damaged run up to the stray "?)" and restore the full literal.
  [/\u5df2\u540c\uFFFD\?\)/g, '\u5df2\u540c\u6b65")'],
  [/\u4e0d\u6b63\uFFFD\?\)/g, '\u4e0d\u6b63\u786e\')'],
];

for (const [pattern, replacement] of replacements) {
  text = text.replace(pattern, replacement);
}

fs.writeFileSync(file, text, 'utf8');

const leftover = [...text.matchAll(/\uFFFD/g)].length;
console.log('changed:', text !== original);
console.log('remaining U+FFFD:', leftover);
process.exitCode = leftover === 0 ? 0 : 1;