/**
 * Accounts: email and password, held by Supabase.
 *
 * The reader signs up with an email and a password they choose. Nothing about
 * the account is stored on this site — there is no server of ours — and the
 * password never reaches this code: it goes straight to the auth endpoint, and
 * what comes back is a short-lived access token plus a refresh token.
 *
 * Both tokens live in localStorage. That is the same place the reader's essays
 * already live, so it adds no new exposure: anyone who can read this storage
 * can already read every essay in it. "Sign out" clears them.
 *
 * The app is fully usable without an account. Nothing here runs until the
 * reader opens Settings and signs in.
 */

import { SUPABASE_URL, SUPABASE_ANON_KEY } from './supabase-config.js';

const SESSION_KEY = 'essay-reader:session';

/** Refresh a little before the token expires instead of after it fails. */
const REFRESH_SKEW_S = 60;
const REQUEST_TIMEOUT_MS = 20_000;

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
 * True when the build carries real project credentials.
 *
 * The point of this check is to catch the shipped placeholders, so a real
 * project must be https. The one exception is a loopback origin, which is how
 * verify/mock-supabase.mjs serves a stand-in API during tests: plain http is
 * refused for anything that is not 127.0.0.1 or localhost.
 */
export function hasConfig() {
  const url = String(SUPABASE_URL || '');
  const key = String(SUPABASE_ANON_KEY || '');
  if (key.length <= 40 || key.includes('YOUR-')) return false;
  if (/^https:\/\/[^/]+$/.test(url)) return true;
  return /^http:\/\/(127\.0\.0\.1|localhost)(:\d+)?$/.test(url);
}

/* ------------------------------------------------------------------ session */

let session = loadSession();
const listeners = new Set();

function loadSession() {
  try {
    const raw = localStorage.getItem(SESSION_KEY);
    if (!raw) return null;
    const parsed = JSON.parse(raw);
    if (!parsed || typeof parsed.access_token !== 'string' || !parsed.access_token) return null;
    if (!parsed.user?.id) return null;
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

/**
 * Store the session a GoTrue response carries.
 * @param {any} payload
 */
function adopt(payload) {
  const user = payload?.user;
  if (!user?.id || !payload.access_token) return null;
  const expiresIn = Number(payload.expires_in) || 3600;
  const next = {
    access_token: payload.access_token,
    refresh_token: payload.refresh_token || '',
    expires_at: Math.floor(Date.now() / 1000) + expiresIn,
    user: { id: String(user.id), email: String(user.email || '') },
  };
  saveSession(next);
  return next;
}

/** Subscribe to sign-in / sign-out. Returns an unsubscribe function. */
export function onAuthChange(fn) {
  listeners.add(fn);
  return () => listeners.delete(fn);
}

/**
 * The signed-in account, or null.
 * @returns {{id:string, email:string}|null}
 */
export function getUser() {
  if (!session?.user?.id) return null;
  return { id: session.user.id, email: session.user.email || '' };
}

export function isSignedIn() {
  return Boolean(getUser());
}

/** True when a token exists but its hour is up — a refresh is due. */
function needsRefresh() {
  if (!session) return false;
  return session.expires_at - REFRESH_SKEW_S <= Math.floor(Date.now() / 1000);
}

let refreshing = null;

/**
 * Why the last recovery link failed, so the panel can say something useful.
 * A used-up link and an unreachable auth host look identical to the reader
 * otherwise — both leave them on the sign-in form with no explanation.
 */
let recoveryFailure = '';

/** Read and clear the stored recovery failure code. */
export function takeRecoveryFailure() {
  const code = recoveryFailure;
  recoveryFailure = '';
  return code;
}

/**
 * The access token to send, refreshed first when it is close to expiry.
 * Returns null when the session is gone, in which case the caller treats the
 * request as "signed out" rather than as an error.
 */
export async function getAccessToken() {
  if (!session) return null;
  if (!needsRefresh()) return session.access_token;
  if (!session.refresh_token) return null;

  // Two callers hitting an expired hour at once share one refresh: GoTrue
  // rotates the refresh token, so a second concurrent attempt would fail.
  if (refreshing) return refreshing;

  refreshing = (async () => {
    try {
      const response = await request('/auth/v1/token?grant_type=refresh_token', {
        method: 'POST',
        body: JSON.stringify({ refresh_token: session.refresh_token }),
        anonymous: true,
      });
      if (!response.ok) {
        clearSession();
        return null;
      }
      const payload = await response.json().catch(() => null);
      return adopt(payload)?.access_token || null;
    } catch {
      // A network blip must not sign the reader out; the next attempt retries.
      return session?.access_token || null;
    } finally {
      refreshing = null;
    }
  })();

  return refreshing;
}

/* -------------------------------------------------------------------- http */

/**
 * One request against the project.
 * @param {string} path  starts with /
 * @param {{method?:string, body?:string, headers?:object, anonymous?:boolean, token?:string}} options
 */
async function request(path, options = {}) {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);
  const token = options.token || (options.anonymous ? '' : session?.access_token || '');
  const headers = {
    apikey: SUPABASE_ANON_KEY,
    ...(options.body ? { 'Content-Type': 'application/json' } : {}),
    ...(token ? { Authorization: `Bearer ${token}` } : {}),
    ...(options.headers || {}),
  };

  try {
    return await fetch(`${SUPABASE_URL}${path}`, {
      method: options.method || 'GET',
      headers,
      body: options.body,
      signal: controller.signal,
    });
  } catch (err) {
    const offline = typeof navigator !== 'undefined' && navigator.onLine === false;
    throw new AuthError(offline ? 'network' : 'network', err?.message || 'network error');
  } finally {
    clearTimeout(timeout);
  }
}

/** Turn a failed auth response into an AuthError the UI knows how to phrase. */
async function toAuthError(response) {
  let body = null;
  try { body = await response.json(); } catch { /* non-JSON error body */ }
  const raw = `${body?.error_code || ''} ${body?.error || ''} ${body?.msg || body?.message || ''}`.toLowerCase();

  if (response.status === 429 || raw.includes('rate limit')) return new AuthError('rate_limited', raw);
  if (raw.includes('invalid login') || raw.includes('invalid_grant')) return new AuthError('invalid_credentials', raw);
  if (raw.includes('not confirmed')) return new AuthError('email_not_confirmed', raw);
  // A recovery link or code that was already used, or simply too old.
  if (raw.includes('token has expired') || raw.includes('invalid or has expired')) return new AuthError('bad_code', raw);
  if (raw.includes('already registered') || raw.includes('already been registered')) return new AuthError('user_exists', raw);
  if (raw.includes('password') && (raw.includes('weak') || raw.includes('short') || raw.includes('6 characters'))) {
    return new AuthError('weak_password', raw);
  }
  if (raw.includes('invalid') && raw.includes('email')) return new AuthError('invalid_email', raw);
  if (response.status === 422) return new AuthError('invalid_email', raw);
  return new AuthError('unknown', `${raw} HTTP ${response.status}`.trim());
}

/* ------------------------------------------------------------------- calls */

function normalizeEmail(raw) {
  return String(raw || '').trim().toLowerCase();
}

/**
 * Create an account.
 * @returns {Promise<{needsConfirmation:boolean}>}
 */
export async function signUp(email, password) {
  if (!hasConfig()) throw new AuthError('no_config');
  const clean = normalizeEmail(email);
  if (!clean || !clean.includes('@')) throw new AuthError('invalid_email');
  if (String(password || '').length < 6) throw new AuthError('weak_password');

  const response = await request('/auth/v1/signup', {
    method: 'POST',
    anonymous: true,
    body: JSON.stringify({ email: clean, password }),
  });
  if (!response.ok) throw await toAuthError(response);

  const payload = await response.json().catch(() => null);
  if (payload?.access_token) {
    adopt(payload);
    return { needsConfirmation: false };
  }
  // Email confirmation is switched on in the project: no session until the
  // reader clicks the link in the mail.
  if (payload?.id || payload?.user?.id || payload?.email) return { needsConfirmation: true };
  throw new AuthError('unknown', 'signup returned no user');
}

/** Sign in with the password. */
export async function signIn(email, password) {
  if (!hasConfig()) throw new AuthError('no_config');
  const clean = normalizeEmail(email);
  if (!clean || !clean.includes('@')) throw new AuthError('invalid_email');
  if (!String(password || '')) throw new AuthError('invalid_credentials');

  const response = await request('/auth/v1/token?grant_type=password', {
    method: 'POST',
    anonymous: true,
    body: JSON.stringify({ email: clean, password }),
  });
  if (!response.ok) throw await toAuthError(response);

  const payload = await response.json().catch(() => null);
  if (!adopt(payload)) throw new AuthError('unknown', 'token response had no session');
  return getUser();
}

/** Sign out on the server (best effort) and forget the session here. */
export async function signOut() {
  const token = session?.access_token;
  saveSession(null);
  if (!token) return;
  try {
    await request('/auth/v1/logout', { method: 'POST', token });
  } catch {
    /* the local session is already gone; a failed logout changes nothing */
  }
}

/** Forget the session without a network call. */
export function clearSession() {
  saveSession(null);
}

/**
 * Ask the project to mail a reset link. The link brings the reader back to this
 * page with a recovery session in the URL fragment, which
 * `adoptRecoverySession()` picks up.
 */
export async function requestPasswordReset(email) {
  if (!hasConfig()) throw new AuthError('no_config');
  const clean = normalizeEmail(email);
  if (!clean || !clean.includes('@')) throw new AuthError('invalid_email');

  const redirect = `${location.origin}${location.pathname}`;
  const response = await request('/auth/v1/recover', {
    method: 'POST',
    anonymous: true,
    body: JSON.stringify({ email: clean, redirect_to: redirect }),
  });
  // An unknown address must not reveal whether it exists: GoTrue answers 200.
  if (!response.ok && response.status !== 404) throw await toAuthError(response);
}

/** Set a new password for the signed-in (or recovering) account. */
export async function updatePassword(password) {
  if (!hasConfig()) throw new AuthError('no_config');
  if (String(password || '').length < 6) throw new AuthError('weak_password');
  const token = await getAccessToken();
  if (!token) throw new AuthError('session_expired');

  const response = await request('/auth/v1/user', {
    method: 'PUT',
    token,
    body: JSON.stringify({ password }),
  });
  if (!response.ok) throw await toAuthError(response);
}

/**
 * Exchange a recovery token for a session.
 *
 * The mail links straight at this site with `#type=recovery&token_hash=…`,
 * and this call turns that one-time hash into a session. Doing the exchange
 * here rather than having the mail link point at the auth host means the first
 * hop the reader clicks is a page we control: a blocked or slow auth host can
 * then show a sentence in Chinese instead of the browser's own error page.
 */
async function exchangeRecoveryToken(tokenHash) {
  const response = await request('/auth/v1/verify', {
    method: 'POST',
    anonymous: true,
    body: JSON.stringify({ type: 'recovery', token_hash: tokenHash }),
  });
  if (!response.ok) throw await toAuthError(response);
  const payload = await response.json().catch(() => null);
  const next = adopt(payload);
  if (!next) throw new AuthError('session_expired');
  return next;
}

/**
 * Finish a recovery with the six-digit code from the mail instead of the link.
 *
 * Some mail clients open links in a browser that cannot reach the auth host,
 * and a code typed by hand always works. GoTrue accepts the numeric token for
 * the `recovery` type and answers with a session, the same as the link does.
 */
export async function verifyRecoveryCode(email, code) {
  if (!hasConfig()) throw new AuthError('no_config');
  const clean = normalizeEmail(email);
  const digits = String(code || '').replace(/\D/g, '');
  if (!clean || !clean.includes('@')) throw new AuthError('invalid_email');
  if (digits.length < 6) throw new AuthError('bad_code');

  const response = await request('/auth/v1/verify', {
    method: 'POST',
    anonymous: true,
    body: JSON.stringify({ type: 'recovery', email: clean, token: digits }),
  });
  if (!response.ok) throw await toAuthError(response);
  const payload = await response.json().catch(() => null);
  if (!adopt(payload)) throw new AuthError('bad_code');
}

/**
 * Read a recovery payload out of the URL.
 *
 * Two shapes are accepted, because the mail template and GoTrue both moved:
 *   #type=recovery&token_hash=…   the link we put in the mail (preferred)
 *   #access_token=…&type=recovery the old implicit-flow redirect
 *
 * The app routes on `location.hash` too, so this must run before the router
 * starts and the fragment must be cleared afterwards.
 *
 * @returns {Promise<boolean>} true when a recovery session was adopted.
 */
export async function adoptRecoverySession() {
  if (typeof location === 'undefined') return false;

  const stripTokens = () => {
    try {
      history.replaceState(null, '', `${location.pathname}${location.search}#/settings`);
    } catch { /* an older browser: leaving the fragment is cosmetic only */ }
  };

  const hash = String(location.hash || '');
  const search = String(location.search || '');

  // Shape 1: our own link, carrying a one-time token hash.
  const hashParams = new URLSearchParams(hash.replace(/^#/, ''));
  const searchParams = new URLSearchParams(search);
  const tokenHash = hashParams.get('token_hash') || searchParams.get('token_hash');
  const kind = hashParams.get('type') || searchParams.get('type');
  if (tokenHash && (!kind || kind === 'recovery')) {
    try {
      await exchangeRecoveryToken(tokenHash);
    } catch (err) {
      // A used or expired hash leaves the reader on the sign-in form, where
      // they can ask for a fresh mail; but they must be told why.
      recoveryFailure = err instanceof AuthError ? err.code : 'bad_code';
      stripTokens();
      return false;
    }
    stripTokens();
    return true;
  }

  // Shape 2: the older redirect that put the session in the fragment.
  if (!hash.includes('access_token=')) return false;

  const type = hashParams.get('type');
  const accessToken = hashParams.get('access_token');
  const refreshToken = hashParams.get('refresh_token') || '';
  if (!accessToken || (type && type !== 'recovery')) return false;

  // Ask the endpoint who this is; the fragment carries no user id.
  let payload = null;
  try {
    const response = await request('/auth/v1/user', { token: accessToken });
    if (response.ok) payload = await response.json().catch(() => null);
  } catch {
    return false;
  }
  if (!payload?.id) return false;

  saveSession({
    access_token: accessToken,
    refresh_token: refreshToken,
    expires_at: Math.floor(Date.now() / 1000) + 3600,
    user: { id: String(payload.id), email: String(payload.email || '') },
  });
  // Drop the tokens from the address bar and from history.
  stripTokens();
  return true;
}

export { SUPABASE_URL };