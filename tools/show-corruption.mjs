/** Print the remaining corruption with code points, pure ASCII source. */
import fs from 'node:fs';

const file = process.argv[2] || 'verify/check-sync.mjs';
const text = fs.readFileSync(file, 'utf8');
const lines = text.split('\n');

lines.forEach((line, i) => {
  if (!line.includes('\uFFFD')) return;
  // Render the neighbourhood with code points so nothing is ambiguous.
  const body = [...line].map((ch) => (ch === '\uFFFD' ? '<FFFD>' : ch)).join('');
  console.log(`line ${i + 1}: ${body}`);
  const idx = [...line].findIndex((ch) => ch === '\uFFFD');
  const slice = [...line].slice(Math.max(0, idx - 6), idx + 6);
  console.log('  codepoints:', slice.map((c) => `U+${c.codePointAt(0).toString(16).toUpperCase().padStart(4, '0')}`).join(' '));
});