/**
 * GitHub-backed sign-in.
 *
 * The app has no server of its own, so it borrows one the reader already has:
 * their GitHub account. A personal access token with the `gist` scope is enough
 * to read and write a single private gist, and that gist is the sync store.
 *
 * Why a token and not a full OAuth app: the OAuth device flow needs a client id
 * registered under someone's account before it can be used, which is one more
 * signup step for the reader. A token is created on GitHub in a few seconds and
 * pasted once per device.
 *
 * The token is kept in localStorage. It is a credential, so the scope matters:
 * `gist` alone can create, read and delete gists and nothing else. It cannot
 * touch the reader's repositories, issues or account settings.
 */

const SESSION_KEY = 'essay-reader:session';
const API_ROOT = 'https://api.github.com';

/** An error the UI can translate. `code` maps to an i18n string. */
export class AuthError extends Error {
  constructor(code, detail) {
    super(detail || code);
    this.name = 'AuthError';
    this.code = code;
    this.detail = detail || '';
  }
}

/**
 * There is nothing to configure at build time any more: every reader brings
 * their own token. Kept as a function because the account panel asks.
 */
export function hasConfig() {
  return true;
}

/* ------------------------------------------------------------------ session */

let session = loadSession();
const listeners = new Set();

function loadSession() {
  try {
    const raw = localStorage.getItem(SESSION_KEY);
    if (!raw) return null;
    const parsed = JSON.parse(raw);
    if (!parsed || typeof parsed.token !== 'string' || !parsed.token) return null;
    return parsed;
  } catch {
    return null;
  }
}

function saveSession(next) {
  session = next;
  try {
    if (next) localStorage.setItem(SESSION_KEY, JSON.stringify(next));
    else localStorage.removeItem(SESSION_KEY);
  } catch {
    /* storage full or blocked: the session simply will not survive a reload */
  }
  for (const fn of listeners) {
    try { fn(getUser()); } catch { /* a broken listener must not break auth */ }
  }
}

/** Subscribe to sign-in / sign-out. Returns an unsubscribe function. */
export function onAuthChange(fn) {
  listeners.add(fn);
  return () => listeners.delete(fn);
}

/**
 * The connected account, or null.
 * @returns {{id:string, login:string, name:string}|null}
 */
export function getUser() {
  if (!session?.token || !session?.user?.login) return null;
  return {
    id: String(session.user.id || session.user.login),
    login: session.user.login,
    name: session.user.name || '',
  };
}

export function isSignedIn() {
  return Boolean(getUser());
}

/** The stored token, or null. Used by the sync layer for every request. */
export function getAccessToken() {
  return session?.token || null;
}

/* -------------------------------------------------------------------- http */

const BASE_HEADERS = {
  Accept: 'application/vnd.github+json',
  'X-GitHub-Api-Version': '2022-11-28',
};

/**
 * Strip the characters people pick up when copying a token out of a chat app
 * or a terminal: surrounding whitespace, quotes, and line breaks.
 */
export function normalizeToken(raw) {
  return String(raw || '')
    // Whitespace, plus the zero-width characters chat apps insert when a long
    // string is wrapped for display.
    .replace(/[\s\u200B-\u200D\uFEFF\u2060]/g, '')
    .replace(/^["'`]+|["'`]+$/g, '');
}

/** Turn a failed response into an AuthError the UI knows how to phrase. */
async function toAuthError(response) {
  let body = null;
  try { body = await response.json(); } catch { /* non-JSON error body */ }
  const raw = String(body?.message || '').toLowerCase();

  if (response.status === 401) return new AuthError('bad_token', raw);
  if (response.status === 403) {
    // GitHub reports a missing scope as 403 with this wording, and rate
    // limiting as 403 with a different one.
    if (raw.includes('scope') || raw.includes('permission') || raw.includes('forbidden')) {
      return new AuthError('bad_scope', raw);
    }
    return new AuthError('rate_limited', raw);
  }
  if (response.status === 429 || raw.includes('rate limit')) {
    return new AuthError('rate_limited', raw);
  }
  return new AuthError('unknown', raw || `HTTP ${response.status}`);
}

/* -------------------------------------------------------------------- calls */

/**
 * Connect an account with a personal access token.
 * @param {string} rawToken
 * @returns {Promise<{id:string, login:string, name:string}>}
 */
export async function signInWithToken(rawToken) {
  const token = normalizeToken(rawToken);
  if (!token) throw new AuthError('no_token');
  // Catch a paste that obviously is not a token before spending a request.
  if (token.length < 20 || /\s/.test(token)) throw new AuthError('bad_token');

  let response;
  try {
    response = await fetch(`${API_ROOT}/user`, {
      headers: { ...BASE_HEADERS, Authorization: `Bearer ${token}` },
    });
  } catch (err) {
    throw new AuthError('network', err.message);
  }

  if (!response.ok) throw await toAuthError(response);

  const payload = await response.json().catch(() => null);
  if (!payload?.login) throw new AuthError('bad_token');

  saveSession({
    token,
    user: { id: String(payload.id || payload.login), login: payload.login, name: payload.name || '' },
  });
  return getUser();
}

/**
 * Disconnect. Local only: the token stays valid on GitHub until the reader
 * revokes it there, which is the honest behaviour — this app never deletes
 * credentials it did not create.
 */
export function signOut() {
  saveSession(null);
}

/** Forget the session without a network call (used by tests). */
export function clearSession() {
  saveSession(null);
}

/** Where a new token is minted, pre-ticked with the scope this app needs. */
export function tokenCreateUrl() {
  return 'https://github.com/settings/tokens/new?scopes=gist&description=Essay%20Reader%20sync';
}

export { API_ROOT, BASE_HEADERS };