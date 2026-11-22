/**
 * Dictionary client with two modes.
 *
 * 1. Offline-first (default and always available): the bundled ECDICT-derived
 *    dictionary in ./dict-offline.js answers instantly with no server. This is
 *    what makes the app work as a static site on a phone.
 * 2. Online enrichment (optional): if an /api/dict proxy happens to be running
 *    (the desktop setup), its richer entries — common phrases, example
 *    sentences, Collins lines — are merged on top of the offline answer.
 *
 * The offline result is shown immediately, so a click never waits on the
 * network. The online extras arrive afterwards and only add detail.
 */

import { OFFLINE_GLOSSARY } from './glossary.js';
import { lookupOffline, loadDictionary, prefetchShards, isLoaded, dictSize } from './dict-offline.js';

/** Whether an /api/dict proxy answered at least once this session. */
let apiAvailable = null;
let apiProbed = null;

const sessionCache = new Map();

/** Warm the bundled dictionary ahead of the first click. */
export function warmUp() {
  return loadDictionary().catch(() => {});
}

/** Preload the dictionary shards one essay is likely to need. */
export function prepareEssay(text) {
  return loadDictionary()
    .then(() => prefetchShards(text))
    .catch(() => null);
}

/** Status block for the settings panel. */
export function dictionaryStatus() {
  return {
    ready: isLoaded(),
    entries: dictSize(),
    server: apiAvailable === true ? 'available' : apiAvailable === false ? 'not running' : 'unknown',
  };
}

/** Does a same-origin dictionary proxy exist? Cached after the first probe. */
async function probeApi() {
  if (apiAvailable !== null) return apiAvailable;
  if (apiProbed) return apiProbed;
  // Relative, so the app also works when hosted under a sub-path
  // (e.g. https://user.github.io/essay-reader/).
  apiProbed = fetch('api/health', { signal: AbortSignal.timeout(2500) })
    .then((res) => res.ok)
    .catch(() => false)
    .then((ok) => {
      apiAvailable = ok;
      apiProbed = null;
      return ok;
    });
  return apiProbed;
}

async function fetchFromApi(word) {
  try {
    const res = await fetch(`api/dict?q=${encodeURIComponent(word)}`, {
      signal: AbortSignal.timeout(6000),
    });
    if (!res.ok) return null;
    const json = await res.json();
    return json.entry || null;
  } catch {
    apiAvailable = false;
    return null;
  }
}

/** Turn a raw offline entry into a full UI entry. */
function normalize(entry) {
  return {
    word: entry.word,
    phonetics: entry.phonetics || { us: '', uk: '' },
    glosses: entry.glosses || [],
    phrases: entry.phrases || [],
    examples: entry.examples || [],
    exam: entry.exam || [],
    rank: entry.rank || 0,
    matchedFrom: entry.matchedFrom || null,
    source: entry.source || 'offline',
  };
}

/** Last-resort built-in glossary for words missing from the bundled data. */
function glossaryEntry(word) {
  const hit = OFFLINE_GLOSSARY[word.toLowerCase()];
  if (!hit) return null;
  return normalize({
    word,
    phonetics: { us: hit.ipa || '', uk: hit.ipa || '' },
    glosses: hit.glosses.map(([pos, text]) => ({ pos, text })),
    source: 'glossary',
  });
}

/**
 * Look up a word.
 *
 * Resolves as soon as the offline answer is ready. When a server proxy is
 * available, a second, richer result is delivered through `onEnrich` so the
 * card can upgrade itself in place.
 *
 * @param {string} word
 * @param {{ onEnrich?: (entry: object) => void }} [options]
 * @returns {Promise<{entry: object|null, source: string}>}
 */
export async function lookup(word, options = {}) {
  const key = String(word || '').replace(/[’']/g, "'").trim().toLowerCase();
  if (!key) return { entry: null, source: 'none' };

  if (sessionCache.has(key)) return { entry: sessionCache.get(key), source: sessionCache.get(key).source };

  // 1. Offline answer — instant, never blocked by the network.
  let result = null;
  try {
    result = await lookupOffline(key);
  } catch {
    result = null;
  }

  let entry = result?.entry || glossaryEntry(key);

  // The bundled dictionary is still streaming the chunk this word may live in.
  // Say so instead of claiming the word does not exist; the caller resolves it
  // once awaitDictionary() settles.
  if (!entry && result?.pending) return { entry: null, source: 'pending', pending: true };

  // 2. Optional online enrichment for phrases / examples.
  if (entry && options.onEnrich) {
    probeApi().then(async (ok) => {
      if (!ok) return;
      const rich = await fetchFromApi(key);
      if (!rich) return;
      const merged = normalize({
        ...entry,
        phonetics: { us: rich.phonetics?.us || entry.phonetics.us, uk: rich.phonetics?.uk || entry.phonetics.uk },
        glosses: entry.glosses?.length ? entry.glosses : rich.glosses || [],
        phrases: rich.phrases || [],
        examples: rich.examples || [],
        exam: entry.exam?.length ? entry.exam : rich.exam || [],
        source: 'offline+server',
      });
      sessionCache.set(key, merged);
      options.onEnrich(merged);
    });
  }

  if (!entry) return { entry: null, source: 'none' };

  // A missing bundled word may still exist in the server dictionary.
  if (!result && !entry) {
    const rich = await fetchFromApi(key);
    if (rich) {
      entry = normalize(rich);
      sessionCache.set(key, entry);
      return { entry, source: 'server' };
    }
  }

  sessionCache.set(key, entry);
  return { entry, source: entry.source };
}

/**
 * Look up many words at once (used to preload an essay's harder words).
 * Silent about failures.
 */
export function prefetch(words) {
  return Promise.all(words.slice(0, 30).map((w) => lookup(w).catch(() => null)));
}
