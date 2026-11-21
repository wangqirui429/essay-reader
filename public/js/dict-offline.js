/**
 * Offline dictionary engine.
 *
 * The dictionary is split so a phone downloads as little as possible, and split
 * again into parallel chunks because the slow part of a cold load is per-request
 * latency, not bandwidth: six chunks in parallel finish in about a tenth of the
 * time it takes to fetch one large file after another.
 *
 *   data/core-0.json … core-5.json   ~19k everyday words, fetched concurrently
 *   data/shards/<a-z>.json          uncommon words, fetched by first letter
 *
 * Chunks are installed as they arrive, so clicking a word works as soon as the
 * chunk holding it lands — the app does not wait for the whole set.
 */

const CORE_CHUNKS = 6;
const coreUrl = (i) => `./data/core-${i}.json`;
const instantUrl = './data/instant.json';
const shardUrl = (letter) => `./data/shards/${letter}.json`;

const core = new Map();
const shards = new Map(); // letter -> Map | Promise
let coreLoading = null;
let coreReady = false;
let ready = false;
let instantReady = false;

/** How long a miss waits for the remaining chunks before answering. */
const LOOKUP_GRACE_MS = 2500;

/** Entries found for words that were first asked about before their chunk landed. */
const cacheShadow = new Map();

/** True once lookups can start (the instant tier has arrived). */
export function isLoaded() {
  return ready;
}

/**
 * True once every core chunk has arrived, so a miss is a real miss.
 *
 * This distinction matters: on a slow connection the six chunks can take half a
 * minute to arrive, and reporting "no such word" during that window is a lie
 * about the dictionary rather than a fact about the word.
 */
export function isComplete() {
  return coreReady;
}

/**
 * Resolves when the whole dictionary is in memory (or has failed to load).
 *
 * Cards opened while chunks are still streaming use this to fill themselves in
 * later, instead of making the reader tap the same word again.
 */
export function awaitDictionary() {
  loadDictionary();
  return coreLoading || Promise.resolve();
}

/** Whether the small "instant" tier is loaded yet, for status display. */
export function isInstantReady() {
  return instantReady;
}

/** Words currently in memory (core chunks that arrived, plus loaded shards). */
export function dictSize() {
  let n = core.size;
  for (const value of shards.values()) {
    if (value instanceof Map) n += value.size;
  }
  return n;
}

/** How many of the core chunks have arrived, for progress reporting. */
let coreChunksLoaded = 0;
export function coreProgress() {
  return { loaded: coreChunksLoaded, total: CORE_CHUNKS };
}

async function fetchJson(url) {
  const res = await fetch(url, { cache: 'force-cache' });
  if (!res.ok) throw new Error(`${url}: HTTP ${res.status}`);
  return res.json();
}

/**
 * Resolves as soon as the first core chunk is usable. Lookups wait on this,
 * never on the whole set — the reader should not sit and watch a progress bar
 * while five more chunks stream in.
 */
let firstChunkReady = null;
let resolveFirstChunk = null;
firstChunkReady = new Promise((resolve) => {
  resolveFirstChunk = resolve;
});

/**
 * Load the dictionary in two waves.
 *
 * Wave 1 is `instant.json`: the 2,000 most frequent words, about 64 KB
 * compressed, which lands in roughly a second even on a poor connection. It
 * covers the words a reader is most likely to click first, so the very first
 * card opens almost immediately.
 *
 * Wave 2 is the six core chunks, about 550 KB compressed, streamed in parallel
 * behind it. A word that arrives with wave 2 is answered without the reader
 * noticing, because they are still reading the first paragraph.
 */
export function loadDictionary() {
  if (coreReady) return Promise.resolve();
  if (coreLoading) return coreLoading;

  const install = (json) => {
    for (const [word, def] of Object.entries(json)) {
      if (!core.has(word)) core.set(word, def);
    }
  };

  const loadChunk = (i) =>
    fetchJson(coreUrl(i))
      .then((json) => {
        install(json);
        coreChunksLoaded += 1;
      })
      .catch((err) => {
        console.warn(`core chunk ${i} unavailable:`, err.message);
        coreChunksLoaded += 1;
      });

  // Wave 1: the small tier. Its arrival is what releases the first lookup.
  const instant = fetchJson(instantUrl)
    .then((json) => {
      install(json);
      instantReady = true;
    })
    .catch((err) => {
      console.warn('instant tier unavailable, falling back to the core:', err.message);
    })
    .finally(() => {
      if (!ready) {
        ready = true;
        resolveFirstChunk();
      }
    });

  // Wave 2: everything else, started immediately so it overlaps with wave 1.
  const rest = Promise.all(Array.from({ length: CORE_CHUNKS }, (_, i) => loadChunk(i)));

  coreLoading = Promise.all([instant, rest]).then(() => {
    coreReady = true;
    ready = true;
    resolveFirstChunk();
  });

  return coreLoading;
}

/** Load one letter shard, sharing concurrent requests. */
function loadShard(letter) {
  const existing = shards.get(letter);
  if (existing instanceof Map) return Promise.resolve(existing);
  if (existing) return existing;

  const promise = fetchJson(shardUrl(letter))
    .then((json) => {
      const map = new Map(Object.entries(json));
      shards.set(letter, map);
      return map;
    })
    .catch(() => {
      // A missing shard is normal (no words for that letter).
      const empty = new Map();
      shards.set(letter, empty);
      return empty;
    });

  shards.set(letter, promise);
  return promise;
}

/** Candidate spellings, simplest-last, for inflected forms the core may lack. */
export function stemCandidates(word) {
  const w = word.toLowerCase().replace(/[’]/g, "'");
  const out = [w];
  const push = (c) => {
    if (c.length >= 2 && !out.includes(c)) out.push(c);
  };
  if (w.endsWith("'s")) push(w.slice(0, -2));
  if (w.endsWith("s'")) push(w.slice(0, -2));
  if (w.endsWith('ies') && w.length > 4) push(`${w.slice(0, -3)}y`);
  if (w.endsWith('es') && w.length > 4) push(w.slice(0, -2));
  if (w.endsWith('s') && !/(ss|us|is)$/.test(w) && w.length > 3) push(w.slice(0, -1));
  if (w.endsWith('ing') && w.length > 5) {
    push(w.slice(0, -3));
    push(`${w.slice(0, -3)}e`);
    if (/([^aeiou])\1$/.test(w.slice(0, -3))) push(w.slice(0, -4));
  }
  if (w.endsWith('ed') && w.length > 4) {
    push(w.slice(0, -2));
    push(w.slice(0, -1));
    if (/([^aeiou])\1ed$/.test(w)) push(w.slice(0, -3));
  }
  if (w.endsWith('er') && w.length > 5) {
    push(w.slice(0, -2));
    push(w.slice(0, -1));
  }
  if (w.endsWith('est') && w.length > 6) push(w.slice(0, -3));
  if (w.endsWith('ly') && w.length > 5) push(w.slice(0, -2));
  return out.slice(0, 5);
}

/** Split a stored definition string into part-of-speech / sense pairs. */
export function splitSenses(text) {
  return String(text)
    .split('；')
    .map((chunk) => chunk.trim())
    .filter(Boolean)
    .map((chunk) => {
      const m = /^([a-z]{1,5}\.)\s*(.+)$/i.exec(chunk);
      if (m) return { pos: m[1].toLowerCase(), text: m[2].trim() };
      return { pos: '', text: chunk };
    })
    .filter((s) => s.text);
}

/** Build the UI entry from a stored definition. */
function toEntry(word, def, matchedFrom) {
  return {
    word,
    phonetics: { us: def.p || '', uk: def.p || '' },
    glosses: splitSenses(def.t),
    phrases: [],
    examples: [],
    exam: def.x || [],
    rank: def.f || 0,
    matchedFrom: matchedFrom || null,
    source: 'offline',
  };
}

/**
 * Look up one word offline.
 *
 * Waiting for all six chunks before answering a miss would make a typo or a
 * proper noun stall for half a minute, so a miss is retried against the chunks
 * that arrive within a short grace period and then reported honestly.
 *
 * @param {string} raw
 * @returns {Promise<{entry: object}|null>}
 */
export async function lookupOffline(raw) {
  const key = String(raw || '').replace(/[’']/g, "'").trim().toLowerCase();
  if (!key) return null;

  // Begin loading, then wait only for the FIRST chunk: that is enough to answer
  // most words, and waiting for all six is what made the first click feel slow.
  loadDictionary();
  await firstChunkReady;

  const findInCore = () => {
    for (const candidate of stemCandidates(key)) {
      const def = core.get(candidate);
      if (def) return { entry: toEntry(candidate, def, candidate === key ? null : def.l || candidate) };
    }
    return null;
  };

  // 1. Anything already in memory.
  const fast = findInCore();
  if (fast) return fast;

  // 2. The shard for this word's first letter. Fetching a shard can take as long
  //    as a whole core chunk on a slow link, so re-check the core afterwards:
  //    a chunk that arrived during this wait is just as good an answer, and
  //    skipping this re-check is what made a common word report "not found"
  //    seconds after its chunk had already been installed.
  const letter = /^[a-z]/.test(key) ? key[0] : '_';
  const shard = await loadShard(letter);
  for (const candidate of stemCandidates(key)) {
    const def = shard.get(candidate);
    if (def) return { entry: toEntry(candidate, def, candidate === key ? null : def.l || candidate) };
  }
  const afterShard = findInCore();
  if (afterShard) return afterShard;

  // 3. The word may live in a chunk that is still arriving. Wait for the
  //    remaining chunks, but only briefly — a reader asking about a word
  //    deserves a quick answer, even if that answer is "not found".
  if (!coreReady) {
    const settled = await Promise.race([
      loadDictionary().then(() => true),
      new Promise((resolve) => setTimeout(() => resolve(false), LOOKUP_GRACE_MS)),
    ]);
    if (settled) {
      const later = findInCore();
      if (later) return later;
    }
    // Still streaming. Do NOT answer "not found": the word may be sitting in a
    // chunk that lands a second later, and a reader who is told a common word
    // does not exist will believe the app is broken. Report that the answer is
    // still in flight; the card fills itself in when awaitDictionary() resolves.
    if (!settled) {
      loadDictionary().then(() => {
        const late = findInCore();
        if (late) cacheShadow.set(key, late.entry);
      }).catch(() => {});
      return { entry: null, pending: true };
    }
  }

  // A previous miss may have been resolved by a chunk that has since arrived.
  const shadow = cacheShadow.get(key);
  if (shadow) return { entry: shadow };

  return null;
}

/**
 * Preload what one essay needs, so a click while reading never waits.
 *
 * The essay's own words are the best predictor of what will be clicked, so
 * their letter shards are fetched in the background as soon as the page opens.
 * Because a shard covers a whole letter, a handful of requests usually covers
 * every unfamiliar word in a long article.
 *
 * @param {string} text essay body
 */
/**
 * Preload what one essay needs.
 *
 * Deliberately does nothing but keep loading the core. An aggressive version
 * fetched every letter shard the essay might need, and measurements showed it
 * made a real click *slower*: those downloads competed with the dictionary
 * chunks and with the word the reader was actually waiting on. The lazy path —
 * fetch the shard when a word from that letter is clicked — wins.
 *
 * @param {string} _text essay body (unused)
 */
export function prefetchShards(_text) {
  loadDictionary().catch(() => null);
  return Promise.resolve(null);
}
