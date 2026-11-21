/**
 * Three-way-free merging of two sync snapshots.
 *
 * The sync protocol is "pull, merge, push", run on every device. That means
 * this function is called on every sync, in both orders on the two devices,
 * and sometimes twice in a row on the same device. Two properties make that
 * safe:
 *
 *   commutative — merge(a, b) equals merge(b, a) field by field
 *   idempotent  — merge(a, a) equals a
 *
 * Together they guarantee that any number of devices, syncing in any order
 * and any number of times, converge on the same snapshot. Every conflict rule
 * below is therefore expressed with max()/min()/"pick the later stamp", never
 * with "prefer the local one", because "local" differs on each device.
 *
 * Deliberately NOT synced: `settings` (theme, font size and line measure are
 * per-device preferences — a phone at 20 px and a laptop at 19 px should not
 * fight) and `current` (which essay is open is meaningless on another device).
 *
 * This module is pure: no browser globals, no network, no storage. That is
 * what lets `test/merge.test.js` exercise it directly under Node.
 */

/** The part of the app state that is shared between devices. */
export function emptySnapshot() {
  return { essays: {}, seen: {}, words: {} };
}

/**
 * Coerce whatever the server returned into a snapshot.
 * A corrupt or partial remote document must never poison local state.
 */
export function normalizeSnapshot(raw) {
  const snap = emptySnapshot();
  if (!raw || typeof raw !== 'object') return snap;

  if (raw.essays && typeof raw.essays === 'object') {
    for (const [id, essay] of Object.entries(raw.essays)) {
      if (!essay || typeof essay !== 'object') continue;
      if (typeof essay.text !== 'string') continue;
      snap.essays[id] = {
        id: essay.id || id,
        title: String(essay.title || 'Untitled'),
        text: essay.text,
        words: Number.isFinite(essay.words) ? essay.words : 0,
        source: essay.source || 'cloud',
        addedAt: Number.isFinite(essay.addedAt) ? essay.addedAt : 0,
        updatedAt: Number.isFinite(essay.updatedAt) ? essay.updatedAt : 0,
      };
    }
  }

  if (raw.words && typeof raw.words === 'object') {
    for (const [key, word] of Object.entries(raw.words)) {
      if (!word || typeof word !== 'object') continue;
      snap.words[key] = {
        key,
        raw: String(word.raw || key),
        glosses: Array.isArray(word.glosses) ? word.glosses : [],
        phonetics: word.phonetics || { us: '', uk: '' },
        examples: Array.isArray(word.examples) ? word.examples : [],
        source: word.source || 'none',
        firstAt: Number.isFinite(word.firstAt) ? word.firstAt : 0,
        lastAt: Number.isFinite(word.lastAt) ? word.lastAt : 0,
        hits: Number.isFinite(word.hits) ? word.hits : 0,
      };
    }
  }

  if (raw.seen && typeof raw.seen === 'object') {
    for (const [essayId, keys] of Object.entries(raw.seen)) {
      if (!Array.isArray(keys)) continue;
      const clean = keys.filter((k) => typeof k === 'string');
      if (clean.length) snap.seen[essayId] = clean;
    }
  }

  return snap;
}

/**
 * Pick whichever record was touched later. Ties are broken by comparing the
 * serialised records, which is deterministic, so the choice does not depend
 * on argument order.
 */
function pickLater(x, y, stampField) {
  const tx = Number(x[stampField]) || 0;
  const ty = Number(y[stampField]) || 0;
  if (tx > ty) return x;
  if (ty > tx) return y;
  return JSON.stringify(x) >= JSON.stringify(y) ? x : y;
}

/**
 * Merge two snapshots.
 * @returns {{essays:object, seen:object, words:object}}
 */
export function mergeSnapshots(a, b) {
  const left = normalizeSnapshot(a);
  const right = normalizeSnapshot(b);
  const merged = emptySnapshot();

  // ---- essays: union by id; the later edit wins for a shared id -----------
  for (const id of new Set([...Object.keys(left.essays), ...Object.keys(right.essays)])) {
    const l = left.essays[id];
    const r = right.essays[id];
    if (!l) merged.essays[id] = r;
    else if (!r) merged.essays[id] = l;
    else merged.essays[id] = pickLater(l, r, 'updatedAt');
  }

  // ---- words: union by key; counters combine so neither side loses clicks --
  for (const key of new Set([...Object.keys(left.words), ...Object.keys(right.words)])) {
    const l = left.words[key];
    const r = right.words[key];
    if (!l) { merged.words[key] = r; continue; }
    if (!r) { merged.words[key] = l; continue; }

    const base = pickLater(l, r, 'lastAt');
    merged.words[key] = {
      ...base,
      // max() rather than a sum: a sum would inflate the count on every sync
      // of the same record, while max() is stable under repetition.
      hits: Math.max(l.hits || 0, r.hits || 0),
      // Earliest sighting is a fact neither device can re-derive alone.
      firstAt: minPositive(l.firstAt, r.firstAt),
      lastAt: Math.max(l.lastAt || 0, r.lastAt || 0),
      // A record written before the dictionary answered has no glosses; the
      // one that has them is more useful, whichever is newer.
      glosses: base.glosses.length ? base.glosses : (l.glosses.length ? l.glosses : r.glosses),
      examples: base.examples.length ? base.examples : (l.examples.length ? l.examples : r.examples),
      phonetics: base.phonetics?.us || base.phonetics?.uk ? base.phonetics : (l.phonetics?.us ? l.phonetics : r.phonetics),
    };
  }

  // ---- seen: plain set union per essay -----------------------------------
  for (const essayId of new Set([...Object.keys(left.seen), ...Object.keys(right.seen)])) {
    const set = new Set([...(left.seen[essayId] || []), ...(right.seen[essayId] || [])]);
    if (set.size) merged.seen[essayId] = [...set].sort();
  }

  return merged;
}

function minPositive(x, y) {
  const a = Number(x) || 0;
  const b = Number(y) || 0;
  if (!a) return b;
  if (!b) return a;
  return Math.min(a, b);
}

/**
 * A stable string for a snapshot: keys sorted at every level, so two
 * snapshots with the same content produce the same signature regardless of
 * insertion order. Used to decide whether a push is necessary at all.
 */
export function snapshotSignature(snap) {
  const norm = normalizeSnapshot(snap);
  const sortKeys = (obj, pickOrder) => {
    const out = {};
    for (const key of Object.keys(obj).sort()) out[key] = pickOrder(obj[key]);
    return out;
  };
  return JSON.stringify({
    essays: sortKeys(norm.essays, (e) => [e.id, e.title, e.text, e.words, e.addedAt, e.updatedAt]),
    words: sortKeys(norm.words, (w) => [
      w.raw, w.hits, w.firstAt, w.lastAt, w.glosses.length, w.source,
    ]),
    seen: sortKeys(norm.seen, (s) => s),
  });
}

/** True when the two snapshots carry the same content. */
export function snapshotEqual(a, b) {
  return snapshotSignature(a) === snapshotSignature(b);
}

/** Small human-facing counts, shown in the account panel. */
export function snapshotCounts(snap) {
  const norm = normalizeSnapshot(snap);
  return {
    essays: Object.keys(norm.essays).length,
    words: Object.keys(norm.words).length,
  };
}