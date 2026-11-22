/**
 * Unit tests for the tokenizer. Run with: node --test test/
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import { tokenizeParagraph, splitParas, countWords, lemmaKey, excerpt, escapeHtml } from '../public/js/tokenize.js';

test('every word becomes a clickable token, punctuation stays put', () => {
  const html = tokenizeParagraph("The child's idea — it works!");
  const tokens = html.match(/class="w"/g) || [];
  assert.equal(tokens.length, 5, 'five words should be interactive');
  assert.match(html, /data-w="child's"/, "apostrophes stay inside the word");
  assert.match(html, /<span class="w" data-w="the"[^>]*>The<\/span>/);
});

test('function words are clickable too (spec: every word)', () => {
  const html = tokenizeParagraph('a an the of');
  assert.equal((html.match(/class="w"/g) || []).length, 4);
});

test('html special characters are escaped, never injected', () => {
  const html = tokenizeParagraph('<script>alert(1)</script> danger');
  assert.ok(!html.includes('<script>'), 'raw script tag must not survive');
  assert.ok(html.includes('&lt;'), 'angle brackets are escaped');
});

test('seen words are marked for the dotted underline', () => {
  const html = tokenizeParagraph('pressure grows', { seenKeys: new Set(['pressure']) });
  assert.match(html, /class="w w--seen"/);
});

test('splitParas lifts a short first line as the heading', () => {
  const { heading, paragraphs } = splitParas('My Title\n\nFirst paragraph.\n\nSecond paragraph.');
  assert.equal(heading, 'My Title');
  assert.deepEqual(paragraphs, ['First paragraph.', 'Second paragraph.']);
});

test('splitParas keeps a full sentence as a paragraph, not a heading', () => {
  const { heading, paragraphs } = splitParas('This is a complete sentence.\n\nNext one.');
  assert.equal(heading, null);
  assert.equal(paragraphs.length, 2);
});

test('countWords ignores punctuation and numbers', () => {
  assert.equal(countWords('Two 3 cats ran fast!'), 4);
});

test('lemmaKey normalises case and stray punctuation', () => {
  assert.equal(lemmaKey('“Pressure”'), 'pressure');
  assert.equal(lemmaKey("CHILD'S"), "child's");
});

test('excerpt truncates on a word boundary', () => {
  const long = 'word '.repeat(60).trim();
  const short = excerpt(long);
  assert.ok(short.length <= 146);
  assert.ok(short.endsWith('…'));
});

test('escapeHtml covers the five dangerous characters', () => {
  assert.equal(escapeHtml(`&<>"'`), '&amp;&lt;&gt;&quot;\'');
});
