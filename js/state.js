/**
 * Persistent state.
 *
 * Everything lives in localStorage under one namespace: the essays the user
 * imported, every word that was looked up, and a few reading settings. The
 * user imports all essays themselves — nothing is preloaded.
 */

const NS = 'essay-reader:v2';

const defaults = {
  /** id -> { id, title, text, words, source, addedAt } */
  essays: {},
  /** essayId -> [wordKey, ...] words clicked inside that essay */
  seen: {},
  /** key -> { key, raw, glosses, phonetics, examples, firstAt, lastAt, hits } */
  words: {},
  /** last opened essay */
  current: null,
  settings: {
    theme: 'paper',
    /** reader type size, px */
    fontSize: 20,
    /** measure line length for comfortable reading */
    measure: true,
  },
};

function clone(value) {
  return JSON.parse(JSON.stringify(value));
}

// Declared first, then filled: assigning inside the initialiser of
// `let state = loadState()` would hit the temporal dead zone.
let state;

/**
 * Listeners notified after every successful write to localStorage.
 *
 * Sync uses this to notice local edits without every call site having to
 * remember to announce them — a new call site that forgets would otherwise
 * silently stop syncing.
 */
const changeListeners = new Set();

/** Subscribe to state writes. Returns an unsubscribe function. */
export function onStateChange(fn) {
  changeListeners.add(fn);
  return () => changeListeners.delete(fn);
}

function notifyChanged() {
  for (const fn of changeListeners) {
    try { fn(); } catch { /* a broken listener must not break saving */ }
  }
}

/** Load from localStorage, merged over the defaults. */
export function loadState() {
  let stored = null;
  try {
    const raw = localStorage.getItem(NS);
    if (raw) stored = JSON.parse(raw);
  } catch (err) {
    console.warn('state: stored data unreadable, starting fresh', err);
  }
  const merged = clone(defaults);
  if (stored && typeof stored === 'object') {
    Object.assign(merged.essays, stored.essays || {});
    Object.assign(merged.seen, stored.seen || {});
    Object.assign(merged.words, stored.words || {});
    Object.assign(merged.settings, stored.settings || {});
    if (stored.current) merged.current = stored.current;
  }
  state = merged;
  return merged;
}

export function saveState() {
  try {
    localStorage.setItem(NS, JSON.stringify(state));
  } catch (err) {
    console.warn('state: could not persist', err);
  }
  notifyChanged();
}

export function getState() {
  return state;
}

export function getSetting(name) {
  return state.settings[name];
}

export function setSetting(name, value) {
  state.settings[name] = value;
  saveState();
  return value;
}

/* ------------------------------------------------------------------ essays */

export function listEssays() {
  return Object.values(state.essays).sort((a, b) => (b.addedAt || 0) - (a.addedAt || 0));
}

export function getEssay(id) {
  return state.essays[id] || null;
}

/** Add or replace one imported essay. Returns the stored record. */
export function putEssay(essay) {
  const existing = state.essays[essay.id] || {};
  const record = {
    ...existing,
    ...essay,
    addedAt: existing.addedAt || Date.now(),
    updatedAt: Date.now(),
  };
  state.essays[essay.id] = record;
  saveState();
  return record;
}

export function deleteEssay(id) {
  if (!state.essays[id]) return false;
  delete state.essays[id];
  delete state.seen[id];
  if (state.current === id) state.current = null;
  saveState();
  return true;
}

export function setCurrent(id) {
  state.current = id;
  saveState();
}

export function getCurrent() {
  return state.current ? state.essays[state.current] || null : null;
}

/* ------------------------------------------------------------------- words */

export function getWord(key) {
  return state.words[key];
}

export function listWords() {
  return Object.values(state.words).sort((a, b) => (b.lastAt || 0) - (a.lastAt || 0));
}

/** Remember a looked-up word together with its Chinese meaning. */
export function recordWord({ key, raw, entry }) {
  if (!key) return;
  const prev = state.words[key];
  state.words[key] = {
    key,
    raw: raw || prev?.raw || key,
    glosses: entry?.glosses?.length ? entry.glosses : prev?.glosses || [],
    phonetics: entry?.phonetics || prev?.phonetics || { us: '', uk: '' },
    examples: entry?.examples || prev?.examples || [],
    source: entry?.source || prev?.source || 'none',
    firstAt: prev?.firstAt || Date.now(),
    lastAt: Date.now(),
    hits: (prev?.hits || 0) + 1,
  };
  saveState();
}

export function forgetWord(key) {
  if (!state.words[key]) return false;
  delete state.words[key];
  for (const essayId of Object.keys(state.seen)) {
    state.seen[essayId] = state.seen[essayId].filter((w) => w !== key);
  }
  saveState();
  return true;
}

export function clearWords() {
  state.words = {};
  state.seen = {};
  saveState();
}

/** Mark a word as looked up inside one essay (drives the dotted underline). */
export function markSeen(essayId, key) {
  if (!essayId || !key) return;
  const list = state.seen[essayId] || [];
  if (!list.includes(key)) list.push(key);
  state.seen[essayId] = list;
  saveState();
}

export function seenKeysFor(essayId) {
  return new Set(state.seen[essayId] || []);
}

/* ------------------------------------------------------------------- stats */

/**
 * @returns {{essays:number, essayWords:number, lookedUp:number, totalClicks:number,
 *   byDay:Array<[string, number]>, newest:Array}}
 */
export function stats() {
  const words = Object.values(state.words);
  const byDayMap = new Map();
  let totalClicks = 0;
  for (const w of words) {
    totalClicks += w.hits || 1;
    const day = new Date(w.lastAt || w.firstAt || Date.now()).toISOString().slice(0, 10);
    byDayMap.set(day, (byDayMap.get(day) || 0) + 1);
  }
  const essayWords = Object.values(state.essays).reduce((sum, e) => sum + (e.words || 0), 0);
  return {
    essays: Object.keys(state.essays).length,
    essayWords,
    lookedUp: words.length,
    totalClicks,
    byDay: [...byDayMap.entries()].sort((a, b) => (a[0] < b[0] ? -1 : 1)),
    newest: [...words].sort((a, b) => (b.lastAt || 0) - (a.lastAt || 0)).slice(0, 6),
  };
}

/* ------------------------------------------------------------------- sync  */

/**
 * The part of the state that is shared between devices.
 *
 * `settings` and `current` are deliberately excluded: theme and font size are
 * per-device preferences, and "which essay is open" means nothing on another
 * machine. Syncing them would make a phone and a laptop fight over zoom.
 */
export function getSyncSnapshot() {
  return {
    essays: clone(state.essays),
    seen: clone(state.seen),
    words: clone(state.words),
  };
}

/**
 * Replace the shared part of the state with a merged snapshot from the cloud.
 *
 * Only the three shared sections are touched, so a sync can never overwrite
 * the font size or theme of the device it is running on. The open essay is
 * dropped if the cloud no longer has it, which happens when it was deleted on
 * another device.
 *
 * @param {{essays:object, seen:object, words:object}} snapshot
 * @returns {boolean} whether anything actually changed.
 */
export function applySyncSnapshot(snapshot) {
  if (!snapshot || typeof snapshot !== 'object') return false;

  const nextEssays = snapshot.essays && typeof snapshot.essays === 'object' ? snapshot.essays : {};
  const nextSeen = snapshot.seen && typeof snapshot.seen === 'object' ? snapshot.seen : {};
  const nextWords = snapshot.words && typeof snapshot.words === 'object' ? snapshot.words : {};

  const before = JSON.stringify([state.essays, state.seen, state.words]);
  const after = JSON.stringify([nextEssays, nextSeen, nextWords]);
  if (before === after) return false;

  state.essays = clone(nextEssays);
  state.seen = clone(nextSeen);
  state.words = clone(nextWords);
  if (state.current && !state.essays[state.current]) state.current = null;
  saveState();
  return true;
}

/* ----------------------------------------------------------------- backup  */

export function exportJson() {
  return JSON.stringify({ app: 'essay-reader', version: 2, exportedAt: new Date().toISOString(), data: state }, null, 2);
}

/** Restore a backup. Returns an error message or null on success. */
export function importJson(text) {
  let parsed;
  try {
    parsed = JSON.parse(text);
  } catch (err) {
    return `That file is not valid JSON: ${err.message}`;
  }
  const data = parsed?.data;
  if (!data || typeof data !== 'object' || !data.essays) {
    return 'That file does not look like an Essay Reader backup.';
  }
  const merged = clone(defaults);
  Object.assign(merged.essays, data.essays);
  Object.assign(merged.seen, data.seen || {});
  Object.assign(merged.words, data.words || {});
  Object.assign(merged.settings, data.settings || {});
  merged.current = data.current || null;
  state = merged;
  saveState();
  return null;
}

// Populate the store as soon as this module is imported. Called last so the
// function declarations above are all initialised.
loadState();
