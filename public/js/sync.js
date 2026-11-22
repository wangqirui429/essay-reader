/**
 * Cloud sync: pull, merge, push — one row per account in Supabase.
 *
 * The local copy in localStorage is always authoritative for *reading*: the app
 * never waits for the network to show an essay or a word. Sync runs alongside,
 * and a failure is reported in the account panel without ever blocking the
 * reader.
 *
 * Every sync is the same three steps, on every device:
 *
 *   1. GET    the reader's row
 *   2. merge  with local state       (public/js/merge.js, commutative+idempotent)
 *   3. POST   the merged document    (only if it differs from what was stored)
 *
 * Because the merge is commutative and idempotent, this loop converges no
 * matter how many devices run it, in what order, or how often. There is no
 * "who wins" question and no vector clock to maintain.
 *
 * The row is keyed by the account's own id and row-level security keeps every
 * other account out of it, so there is no id to discover and no id to leak.
 */

import { AuthError, getAccessToken, getUser, hasConfig, isSignedIn } from './auth.js';
import { mergeSnapshots, normalizeSnapshot, snapshotEqual, snapshotSignature } from './merge.js';
import { getSyncSnapshot, applySyncSnapshot, onStateChange } from './state.js';
import { STATE_TABLE, SUPABASE_ANON_KEY, SUPABASE_URL } from './supabase-config.js';

const SYNC_DELAY_MS = 1500;
const REQUEST_TIMEOUT_MS = 20_000;

/**
 * A single document this large is already pathological — the largest realistic
 * collection (a thousand essays with every word looked up) is a few megabytes.
 * Refusing early keeps the failure legible instead of surfacing as a timeout.
 */
const MAX_PAYLOAD_BYTES = 8_000_000;

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

/* -------------------------------------------------------------------- http */

/**
 * One request against the row, authenticated as the signed-in reader.
 *
 * The token is fetched per call because it is refreshed lazily; when no token
 * can be obtained the session is gone and the caller is told so, rather than
 * being shown a generic error.
 */
async function apiFetch(path, options = {}) {
  const token = await getAccessToken();
  if (!token) {
    const err = new Error('signed out');
    err.code = 'session_expired';
    throw err;
  }
  const uid = getUser()?.id;
  if (!uid) {
    const err = new Error('signed out');
    err.code = 'session_expired';
    throw err;
  }

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);
  let response;
  try {
    response = await fetch(`${SUPABASE_URL}${path}`, {
      ...options,
      signal: controller.signal,
      headers: {
        apikey: SUPABASE_ANON_KEY,
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
    const err = new Error('rate limited');
    err.code = 'rate_limited';
    throw err;
  }
  return response;
}

/* ------------------------------------------------------------------- rows */

/** The reader's stored document, or null when nothing was saved yet. */
async function pull() {
  const uid = getUser()?.id;
  const path = `/rest/v1/${STATE_TABLE}?select=data,rev&user_id=eq.${encodeURIComponent(uid)}`;
  const response = await apiFetch(path);
  if (!response.ok) throw new Error(`read failed: HTTP ${response.status}`);

  const rows = await response.json().catch(() => null);
  if (!Array.isArray(rows) || rows.length === 0) return null;
  const row = rows[0];
  status.rev = Number(row?.rev) || 0;
  return normalizeSnapshot(row?.data);
}

/** Write the merged document, replacing whatever the row held. */
async function push(snapshot) {
  const uid = getUser()?.id;
  const body = JSON.stringify({ user_id: uid, data: snapshot });
  const bytes = new TextEncoder().encode(body).length;
  if (bytes > MAX_PAYLOAD_BYTES) {
    const err = new Error('the collection is too large to sync');
    err.code = 'too_large';
    throw err;
  }

  const response = await apiFetch(`/rest/v1/${STATE_TABLE}`, {
    method: 'POST',
    headers: {
      // Upsert: the row already exists on the second sync of any device.
      Prefer: 'resolution=merge-duplicates,return=minimal',
    },
    body,
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
      const remote = await pull();
      const remoteSnapshot = remote || normalizeSnapshot(null);

      const merged = mergeSnapshots(local, remoteSnapshot);
      const remoteMoved = !snapshotEqual(merged, remoteSnapshot);
      const localMoved = !snapshotEqual(merged, local);
      const signature = snapshotSignature(merged);

      const needsPush = options.force
        || remoteMoved
        || !remote
        || signature !== lastSyncedSignature;

      if (needsPush) {
        await push(merged);
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

export { AuthError };