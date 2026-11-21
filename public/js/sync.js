/**
 * Cloud sync: pull, merge, push — over a private GitHub gist.
 *
 * The local copy in localStorage is always authoritative for *reading*: the app
 * never waits for the network to show an essay or a word. Sync runs alongside,
 * and a failure is reported in the account panel without ever blocking the
 * reader.
 *
 * Every sync is the same three steps, on every device:
 *
 *   1. GET    the gist file
 *   2. merge  with local state       (public/js/merge.js, commutative+idempotent)
 *   3. PATCH  the merged document    (only if it differs from what was stored)
 *
 * Because the merge is commutative and idempotent, this loop converges no
 * matter how many devices run it, in what order, or how often. There is no
 * "who wins" question and no vector clock to maintain.
 *
 * The gist is found by its description, so the reader can connect the same
 * account on a second device and land on the same store without being told an
 * id. The id is then remembered locally to save a round trip.
 */

import { getAccessToken, getUser, isSignedIn, hasConfig, API_ROOT, BASE_HEADERS, AuthError } from './auth.js';
import { emptySnapshot, mergeSnapshots, normalizeSnapshot, snapshotEqual, snapshotSignature } from './merge.js';
import { getSyncSnapshot, applySyncSnapshot, onStateChange } from './state.js';

const FILE_NAME = 'essay-reader.json';
const GIST_DESCRIPTION = 'Essay Reader sync';
const GIST_ID_KEY = 'essay-reader:gist-id';

const SYNC_DELAY_MS = 1500;
const REQUEST_TIMEOUT_MS = 20_000;

/**
 * GitHub accepts a gist payload far larger than this, but a file over 1 MB is
 * returned truncated by the API and would need the raw URL — a different host,
 * and one this network blocks. Staying under the limit keeps reads simple.
 */
const MAX_PAYLOAD_BYTES = 900_000;

/** @typedef {'signed_out'|'disabled'|'idle'|'syncing'|'synced'|'offline'|'error'|'expired'} SyncStatus */

const status = {
  state: /** @type {SyncStatus} */ ('signed_out'),
  lastSyncAt: 0,
  error: '',
  rev: 0,
};

const listeners = new Set();
let timer = null;
let inFlight = null;
let lastSyncedSignature = null;
let suppressWatch = false;

function emit() {
  for (const fn of listeners) {
    try { fn({ ...status }); } catch { /* a broken listener must not break sync */ }
  }
}

/** Subscribe to sync status changes. */
export function onSyncStatus(fn) {
  listeners.add(fn);
  return () => listeners.delete(fn);
}

export function getSyncStatus() {
  return { ...status };
}

function setStatus(next, error = '') {
  status.state = next;
  status.error = error;
  emit();
}

/* ----------------------------------------------------------------- gist id */

function readGistId() {
  try { return localStorage.getItem(GIST_ID_KEY) || ''; } catch { return ''; }
}

function rememberGistId(id) {
  try {
    if (id) localStorage.setItem(GIST_ID_KEY, id);
    else localStorage.removeItem(GIST_ID_KEY);
  } catch { /* storage blocked: the id is found again on the next sync */ }
}

/* -------------------------------------------------------------------- http */

async function apiFetch(path, options = {}) {
  const token = getAccessToken();
  if (!token) {
    const err = new AuthError('no_token');
    err.code = 'no_token';
    throw err;
  }

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);
  let response;
  try {
    response = await fetch(`${API_ROOT}${path}`, {
      ...options,
      signal: controller.signal,
      headers: {
        ...BASE_HEADERS,
        Authorization: `Bearer ${token}`,
        ...(options.body ? { 'Content-Type': 'application/json' } : {}),
        ...(options.headers || {}),
      },
    });
  } catch (err) {
    const offline = typeof navigator !== 'undefined' && navigator.onLine === false;
    const error = new Error(offline ? 'offline' : (err?.message || 'network error'));
    error.code = offline ? 'offline' : 'network';
    throw error;
  } finally {
    clearTimeout(timeout);
  }

  if (response.status === 401) {
    const err = new Error('token rejected');
    err.code = 'session_expired';
    throw err;
  }
  if (response.status === 403 || response.status === 429) {
    const err = new Error('rate limited or missing scope');
    err.code = 'rate_limited';
    throw err;
  }
  return response;
}

/** Read a gist by id. Returns the parsed snapshot, or null when it is gone. */
async function readGist(id) {
  const response = await apiFetch(`/gists/${id}`);
  if (response.status === 404) return null;
  if (!response.ok) throw new Error(`read failed: HTTP ${response.status}`);

  const gist = await response.json().catch(() => null);
  const file = gist?.files?.[FILE_NAME];
  if (!file) return { snapshot: emptySnapshot(), exists: false, gist };
  if (file.truncated) {
    const err = new Error('gist file is too large to read through the API');
    err.code = 'too_large';
    throw err;
  }

  // The API inlines `content` for files under 1 MB; when it is missing the
  // file is empty, which is the same as no data yet.
  if (typeof file.content !== 'string' || !file.content.trim()) {
    return { snapshot: emptySnapshot(), exists: false, gist };
  }
  try {
    const parsed = JSON.parse(file.content);
    // The file carries a small envelope so a future format change can be
    // detected; a bare snapshot is still accepted.
    const body = parsed && typeof parsed === 'object' && parsed.snapshot ? parsed.snapshot : parsed;
    return { snapshot: normalizeSnapshot(body), exists: true, gist };
  } catch {
    // A hand-edited or half-written file must not brick sync: start over from
    // local data, which the push that follows will rewrite.
    return { snapshot: emptySnapshot(), exists: false, gist };
  }
}

/** The exact bytes stored in the gist. */
function serializeSnapshot(snapshot) {
  return JSON.stringify({
    app: 'essay-reader',
    version: 1,
    savedAt: new Date().toISOString(),
    snapshot,
  });
}

/** The reader's sync gist, creating it on first use. */
async function ensureGist() {
  const known = readGistId();
  if (known) {
    const found = await readGist(known);
    if (found) return { id: known, ...found };
    rememberGistId(''); // deleted on GitHub: look for another
  }

  // The gist may already exist from another device.
  const listResponse = await apiFetch('/gists?per_page=100');
  if (listResponse.ok) {
    const gists = await listResponse.json().catch(() => []);
    const match = Array.isArray(gists)
      ? gists.find((g) => g?.description === GIST_DESCRIPTION && g?.files?.[FILE_NAME])
      : null;
    if (match?.id) {
      rememberGistId(match.id);
      const found = await readGist(match.id);
      if (found) return { id: match.id, ...found };
    }
  }

  const createResponse = await apiFetch('/gists', {
    method: 'POST',
    body: JSON.stringify({
      description: GIST_DESCRIPTION,
      public: false,
      files: { [FILE_NAME]: { content: serializeSnapshot(emptySnapshot()) } },
    }),
  });
  if (!createResponse.ok) throw new Error(`create failed: HTTP ${createResponse.status}`);

  const created = await createResponse.json().catch(() => null);
  if (!created?.id) throw new Error('create failed: no id');
  rememberGistId(created.id);
  return { id: created.id, snapshot: emptySnapshot(), exists: false };
}

/** Write the merged document into the gist. */
async function writeGist(id, snapshot) {
  const body = serializeSnapshot(snapshot);
  const bytes = new TextEncoder().encode(body).length;
  if (bytes > MAX_PAYLOAD_BYTES) {
    const err = new Error('the collection is too large to sync');
    err.code = 'too_large';
    throw err;
  }

  const response = await apiFetch(`/gists/${id}`, {
    method: 'PATCH',
    body: JSON.stringify({ files: { [FILE_NAME]: { content: body } } }),
  });
  if (!response.ok) throw new Error(`save failed: HTTP ${response.status}`);
}

/* ------------------------------------------------------------------- sync */

/**
 * Run one full sync now.
 * @param {{force?:boolean}} [options] force pushes even when content is unchanged.
 * @returns {Promise<{ok:boolean, status:string, changed:boolean, error?:string}>}
 */
export async function syncNow(options = {}) {
  if (!hasConfig()) { setStatus('disabled'); return { ok: false, status: 'disabled', changed: false }; }
  if (!isSignedIn()) { setStatus('signed_out'); return { ok: false, status: 'signed_out', changed: false }; }
  if (typeof navigator !== 'undefined' && navigator.onLine === false) {
    setStatus('offline');
    return { ok: false, status: 'offline', changed: false };
  }
  // Collapse concurrent triggers onto the run already happening.
  if (inFlight) return inFlight;

  inFlight = (async () => {
    setStatus('syncing');
    try {
      const local = getSyncSnapshot();
      const remote = await ensureGist();

      const merged = mergeSnapshots(local, remote.snapshot);
      const remoteMoved = !snapshotEqual(merged, remote.snapshot);
      const localMoved = !snapshotEqual(merged, local);
      const signature = snapshotSignature(merged);

      const needsPush = options.force
        || remoteMoved
        || !remote.exists
        || signature !== lastSyncedSignature;

      if (needsPush) {
        await writeGist(remote.id, merged);
        lastSyncedSignature = signature;
      }

      if (localMoved) {
        // Applying triggers saveState, which would schedule another sync; the
        // guard turns that into a no-op rather than a loop.
        suppressWatch = true;
        try { applySyncSnapshot(merged); } finally { suppressWatch = false; }
      }

      status.lastSyncAt = Date.now();
      setStatus('synced');
      return { ok: true, status: 'synced', changed: localMoved || remoteMoved };
    } catch (err) {
      if (err?.code === 'session_expired') {
        setStatus('expired', err.message);
        return { ok: false, status: 'expired', changed: false, error: err.message };
      }
      if (err?.code === 'too_large') {
        setStatus('error', err.message);
        return { ok: false, status: 'error', changed: false, error: err.message, code: 'too_large' };
      }
      if (err?.code === 'offline') {
        setStatus('offline');
        return { ok: false, status: 'offline', changed: false, error: err.message };
      }
      setStatus('error', err?.message || 'sync failed');
      return { ok: false, status: 'error', changed: false, error: err?.message };
    } finally {
      inFlight = null;
    }
  })();

  return inFlight;
}

/** Queue a sync shortly after the next local change. */
export function scheduleSync(delayMs = SYNC_DELAY_MS) {
  if (!isSignedIn()) return;
  if (timer) clearTimeout(timer);
  timer = setTimeout(() => {
    timer = null;
    syncNow();
  }, delayMs);
}

export function cancelScheduledSync() {
  if (timer) { clearTimeout(timer); timer = null; }
}

/**
 * Begin watching for local changes and for the tab regaining focus.
 * Safe to call more than once.
 */
export function startSyncWatcher() {
  onStateChange(() => {
    if (suppressWatch) return;
    if (!isSignedIn()) return;
    // Skip the push when nothing syncable actually changed (a theme flip, for
    // instance, is a device preference and never reaches the server).
    if (lastSyncedSignature && snapshotSignature(getSyncSnapshot()) === lastSyncedSignature) return;
    scheduleSync();
  });

  if (typeof document !== 'undefined') {
    document.addEventListener('visibilitychange', () => {
      if (document.visibilityState === 'visible') syncNow();
    });
  }
  if (typeof window !== 'undefined') {
    window.addEventListener('online', () => { if (isSignedIn()) syncNow(); });
    window.addEventListener('focus', () => { if (isSignedIn()) syncNow(); });
  }
}

/** Called on sign-in: reconcile immediately and remember what was pushed. */
export async function initialSync() {
  lastSyncedSignature = null;
  const result = await syncNow({ force: true });
  if (result.ok) lastSyncedSignature = snapshotSignature(getSyncSnapshot());
  return result;
}

/** Called on sign-out: stop pushing and forget the watermark. */
export function resetSync() {
  cancelScheduledSync();
  lastSyncedSignature = null;
  status.lastSyncAt = 0;
  status.rev = 0;
  status.error = '';
  setStatus(hasConfig() ? 'signed_out' : 'disabled');
}

/** Forget which gist this device uses (tests switch accounts). */
export function forgetGist() {
  rememberGistId('');
  lastSyncedSignature = null;
}