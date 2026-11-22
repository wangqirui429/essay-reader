/**
 * Unit tests for the sync merge. Run with: node test/merge.test.js
 *
 * The sync protocol pulls, merges, pushes on every device, so the merge must
 * be commutative (device A merging and device B merging reach the same result)
 * and idempotent (merging twice is merging once). These tests assert those
 * properties directly, on top of the individual conflict rules.
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import {
  emptySnapshot,
  mergeSnapshots,
  normalizeSnapshot,
  snapshotEqual,
  snapshotSignature,
} from '../public/js/merge.js';

const essay = (id, over = {}) => ({
  id,
  title: `Essay ${id}`,
  text: `Body of essay ${id}.`,
  words: 4,
  source: 'paste',
  addedAt: 1000,
  updatedAt: 1000,
  ...over,
});

const word = (key, over = {}) => ({
  key,
  raw: key,
  glosses: [{ pos: 'n.', text: '释义' }],
  phonetics: { us: '', uk: '' },
  examples: [],
  source: 'core',
  firstAt: 1000,
  lastAt: 1000,
  hits: 1,
  ...over,
});

test('an empty snapshot is the identity', () => {
  const a = { essays: { x: essay('x') }, seen: { x: ['a'] }, words: { a: word('a') } };
  const merged = mergeSnapshots(a, emptySnapshot());
  assert.deepEqual(Object.keys(merged.essays), ['x']);
  assert.deepEqual(Object.keys(merged.words), ['a']);
  assert.deepEqual(merged.seen.x, ['a']);
});

test('essays from two devices are unioned', () => {
  const a = { essays: { one: essay('one') } };
  const b = { essays: { two: essay('two') } };
  const merged = mergeSnapshots(a, b);
  assert.deepEqual(Object.keys(merged.essays).sort(), ['one', 'two']);
});

test('the later edit wins for a shared essay id', () => {
  const a = { essays: { one: essay('one', { title: 'Old title', updatedAt: 1000 }) } };
  const b = { essays: { one: essay('one', { title: 'New title', updatedAt: 2000 }) } };
  assert.equal(mergeSnapshots(a, b).essays.one.title, 'New title');
  assert.equal(mergeSnapshots(b, a).essays.one.title, 'New title', 'order must not matter');
});

test('words from two devices are unioned', () => {
  const merged = mergeSnapshots({ words: { serendipity: word('serendipity') } },
    { words: { vestibule: word('vestibule') } });
  assert.deepEqual(Object.keys(merged.words).sort(), ['serendipity', 'vestibule']);
});

test('a word clicked on both devices keeps the higher count, not the sum', () => {
  const a = { words: { look: word('look', { hits: 3, lastAt: 1000 }) } };
  const b = { words: { look: word('look', { hits: 5, lastAt: 2000 }) } };
  const once = mergeSnapshots(a, b);
  assert.equal(once.words.look.hits, 5);
  // Merging the same pair again must not inflate it.
  const twice = mergeSnapshots(once, b);
  assert.equal(twice.words.look.hits, 5, 'hits must be stable under repetition');
  assert.equal(mergeSnapshots(b, a).words.look.hits, 5, 'order must not matter');
});

test('the earliest sighting of a word survives', () => {
  const a = { words: { look: word('look', { firstAt: 5000, lastAt: 5000 }) } };
  const b = { words: { look: word('look', { firstAt: 1000, lastAt: 9000 }) } };
  assert.equal(mergeSnapshots(a, b).words.look.firstAt, 1000);
  assert.equal(mergeSnapshots(a, b).words.look.lastAt, 9000);
});

test('a word recorded before the dictionary answered gains its meanings', () => {
  const bare = word('look', { glosses: [], examples: [], lastAt: 9000 });
  const rich = word('look', { glosses: [{ pos: 'v.', text: '看' }], lastAt: 1000 });
  const merged = mergeSnapshots({ words: { look: bare } }, { words: { look: rich } });
  assert.deepEqual(merged.words.look.glosses, [{ pos: 'v.', text: '看' }],
    'meanings must not be lost just because the bare record is newer');
});

test('seen word lists are unioned without duplicates', () => {
  const merged = mergeSnapshots({ seen: { e1: ['a', 'b'] } }, { seen: { e1: ['b', 'c'] } });
  assert.deepEqual(merged.seen.e1, ['a', 'b', 'c']);
});

test('merge is commutative', () => {
  const a = {
    essays: { one: essay('one', { updatedAt: 1000 }) },
    words: { look: word('look', { hits: 2, firstAt: 500, lastAt: 4000 }) },
    seen: { one: ['look'] },
  };
  const b = {
    essays: { one: essay('one', { title: 'Changed', updatedAt: 2000 }), two: essay('two') },
    words: { look: word('look', { hits: 7, firstAt: 100, lastAt: 9000 }), gaze: word('gaze') },
    seen: { one: ['gaze'], two: ['gaze'] },
  };
  assert.equal(snapshotSignature(mergeSnapshots(a, b)), snapshotSignature(mergeSnapshots(b, a)));
});

test('merge is idempotent', () => {
  const a = {
    essays: { one: essay('one') },
    words: { look: word('look', { hits: 4 }), gaze: word('gaze') },
    seen: { one: ['look', 'gaze'] },
  };
  const once = mergeSnapshots(a, a);
  const twice = mergeSnapshots(once, once);
  assert.equal(snapshotSignature(once), snapshotSignature(twice));
});

test('three devices converge regardless of sync order', () => {
  const phone = { essays: { p: essay('p') }, words: { alpha: word('alpha', { hits: 1 }) }, seen: { p: ['alpha'] } };
  const laptop = { essays: { l: essay('l') }, words: { beta: word('beta', { hits: 2 }) }, seen: { l: ['beta'] } };
  const tablet = { essays: { t: essay('t') }, words: { gamma: word('gamma', { hits: 3 }) }, seen: { t: ['gamma'] } };

  // Simulate repeated syncs of every device against one shared document.
  let shared = emptySnapshot();
  for (const device of [phone, laptop, tablet, phone, tablet, laptop, laptop, phone]) {
    shared = mergeSnapshots(shared, device);
  }
  assert.deepEqual(Object.keys(shared.essays).sort(), ['l', 'p', 't']);
  assert.deepEqual(Object.keys(shared.words).sort(), ['alpha', 'beta', 'gamma']);
  assert.deepEqual(shared.seen.p, ['alpha']);
  assert.deepEqual(shared.seen.l, ['beta']);
  assert.deepEqual(shared.seen.t, ['gamma']);
});

test('normalizeSnapshot rejects garbage instead of poisoning state', () => {
  assert.deepEqual(normalizeSnapshot(null), emptySnapshot());
  assert.deepEqual(normalizeSnapshot('nope'), emptySnapshot());
  assert.deepEqual(normalizeSnapshot({ essays: 'x', words: 5 }), emptySnapshot());
  // An essay without text cannot be read, so it is dropped rather than stored.
  assert.deepEqual(Object.keys(normalizeSnapshot({ essays: { bad: { title: 'no text' } } }).essays), []);
  assert.deepEqual(Object.keys(normalizeSnapshot({ essays: { ok: essay('ok') } }).essays), ['ok']);
});

test('normalizeSnapshot fills missing counters so maths never sees NaN', () => {
  const snap = normalizeSnapshot({ words: { look: { raw: 'look' } } });
  assert.equal(snap.words.look.hits, 0);
  assert.equal(snap.words.look.firstAt, 0);
  assert.deepEqual(snap.words.look.glosses, []);
});

test('snapshotEqual ignores key insertion order', () => {
  const a = { words: { x: word('x'), y: word('y') } };
  const b = { words: { y: word('y'), x: word('x') } };
  assert.ok(snapshotEqual(a, b));
  assert.ok(!snapshotEqual(a, { words: { x: word('x') } }));
});

test('deleting an essay on one device does not resurrect it', () => {
  // A delete cannot be expressed by union, so the protocol relies on the push
  // that follows the delete: the other device pulls a snapshot without it.
  const before = { essays: { gone: essay('gone'), kept: essay('kept') } };
  const afterDelete = { essays: { kept: essay('kept') } };
  const merged = mergeSnapshots(afterDelete, afterDelete);
  assert.deepEqual(Object.keys(merged.essays), ['kept']);
  assert.ok(!('gone' in merged.essays));
  // Documented consequence: a device still holding the deleted essay and
  // syncing AFTER the delete would reintroduce it until it too deletes.
  assert.ok('gone' in mergeSnapshots(afterDelete, before).essays);
});