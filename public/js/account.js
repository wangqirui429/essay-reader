/**
 * The account panel in Settings: connect an account, sync now, disconnect.
 *
 * Kept out of app.js because it owns a self-contained state machine
 * (signed out → connecting → connected → syncing → synced/error) and app.js is
 * already the largest module in the app.
 *
 * All user-facing text goes through i18n; this file holds no literals that a
 * reader can see.
 */

import { getLang, t } from './i18n.js';
import {
  hasConfig, getUser, signInWithToken, signOut, onAuthChange, AuthError, tokenCreateUrl,
} from './auth.js';
import {
  getSyncStatus, onSyncStatus, initialSync, syncNow, startSyncWatcher,
  resetSync, cancelScheduledSync,
} from './sync.js';

const $ = (sel) => document.querySelector(sel);

let onDataChanged = () => {};

/** Map an AuthError code to a translated sentence. */
function describeAuthError(err) {
  const code = err instanceof AuthError ? err.code : 'unknown';
  const key = `auth.${code}`;
  const message = t(key, { msg: err?.detail || err?.message || '' });
  // t() returns the key itself when the string is missing; fall back to unknown.
  return message === key ? t('auth.unknown', { msg: err?.detail || err?.message || '' }) : message;
}

/** "刚刚" / "3 分钟前" — short enough to sit in a settings line. */
function relativeTime(ms) {
  if (!ms) return t('sync.never');
  const seconds = Math.round((Date.now() - ms) / 1000);
  if (seconds < 45) return t('time.justNow');
  const minutes = Math.round(seconds / 60);
  if (minutes < 60) return t('time.minutesAgo', { n: minutes });
  const hours = Math.round(minutes / 60);
  if (hours < 24) return t('time.hoursAgo', { n: hours });
  return t('time.daysAgo', { n: Math.round(hours / 24) });
}

function renderSyncStatus() {
  const el = $('#syncState');
  if (!el) return;
  const s = getSyncStatus();
  switch (s.state) {
    case 'syncing':
      el.textContent = t('sync.syncing');
      el.className = 'set-note';
      break;
    case 'synced':
      el.textContent = t('sync.syncedAgo', { when: relativeTime(s.lastSyncAt) });
      el.className = 'set-note set-note--ok';
      break;
    case 'offline':
      el.textContent = t('sync.offline');
      el.className = 'set-note set-note--warn';
      break;
    case 'expired':
      el.textContent = t('sync.expired');
      el.className = 'set-note set-note--err';
      break;
    case 'error':
      el.textContent = t('sync.error', { msg: syncErrorText(s.error) });
      el.className = 'set-note set-note--err';
      break;
    default:
      el.textContent = t('sync.never');
      el.className = 'set-note';
  }
}

/** Errors raised by the sync layer are English; phrase the common ones. */
function syncErrorText(raw) {
  const text = String(raw || '');
  if (text.includes('too large')) return t('sync.tooLarge');
  return text;
}

/** Show the correct panel for the current connection state. */
function renderAccount() {
  const user = getUser();

  const form = $('#authForm');
  if (form) form.hidden = Boolean(user);

  const signedIn = $('#accountSignedIn');
  if (signedIn) signedIn.hidden = !user;

  const syncBtn = $('#btnSyncNow');
  if (syncBtn) syncBtn.disabled = !user;
  const outBtn = $('#btnSignOut');
  if (outBtn) outBtn.disabled = !user;

  if (user) {
    const name = $('#accountEmail');
    if (name) name.textContent = `@${user.login}`;
    renderSyncStatus();
  }
}

function showAuthError(message) {
  const el = $('#authError');
  if (!el) return;
  el.textContent = message || '';
  el.hidden = !message;
}

/** Disable the connect button while a request is in flight. */
function setBusy(busy, label) {
  const btn = $('#btnSignIn');
  if (!btn) return;
  btn.disabled = busy;
  btn.textContent = busy ? label : t('settings.connect');
}

function readToken() {
  const input = $('#authToken');
  const token = String(input?.value || '').trim();
  if (!token) { showAuthError(t('auth.no_token')); return ''; }
  return token;
}

/** Shared tail of a successful connect: pull the cloud copy and repaint. */
async function afterConnect() {
  showAuthError('');
  renderAccount();
  const result = await initialSync();
  renderSyncStatus();
  if (result.ok && result.changed) onDataChanged();
  if (!result.ok && result.status === 'error') {
    showAuthError(t('sync.error', { msg: syncErrorText(result.error) }));
  }
}

async function handleConnect(ev) {
  ev?.preventDefault?.();
  const token = readToken();
  if (!token) return;

  setBusy(true, t('sync.connecting'));
  try {
    await signInWithToken(token);
    const input = $('#authToken');
    if (input) input.value = '';
    await afterConnect();
  } catch (err) {
    showAuthError(describeAuthError(err));
  } finally {
    setBusy(false);
    renderAccount();
  }
}

async function handleSignOut() {
  cancelScheduledSync();
  resetSync();
  signOut();
  renderAccount();
  showAuthError('');
  onDataChanged();
}

async function handleSyncNow() {
  const result = await syncNow({ force: true });
  renderSyncStatus();
  if (result.ok && result.changed) onDataChanged();
  if (!result.ok && result.status === 'error') {
    showAuthError(t('sync.error', { msg: syncErrorText(result.error) }));
  }
}

/**
 * Wire the account panel.
 * @param {{onDataChanged: () => void}} options
 */
export function initAccount(options = {}) {
  onDataChanged = options.onDataChanged || (() => {});

  // The link that mints a token, pre-filled with the one scope this app needs.
  const makeLink = $('#btnGetToken');
  if (makeLink) makeLink.href = tokenCreateUrl();

  renderAccount();

  $('#authForm')?.addEventListener('submit', handleConnect);
  $('#btnSignOut')?.addEventListener('click', handleSignOut);
  $('#btnSyncNow')?.addEventListener('click', handleSyncNow);

  onAuthChange(() => renderAccount());
  onSyncStatus(() => renderSyncStatus());

  // Keep "3 minutes ago" from going stale while the panel is open.
  setInterval(() => {
    if (getUser() && !$('#accountSignedIn')?.hidden) renderSyncStatus();
  }, 30_000);

  startSyncWatcher();

  if (!hasConfig()) return;

  // A returning visitor has a session in localStorage: reconcile quietly.
  if (getUser()) {
    initialSync().then((result) => {
      renderSyncStatus();
      if (result.ok && result.changed) onDataChanged();
    });
  }
}

/** Re-render the panel after a language switch. */
export function refreshAccountPanel() {
  renderAccount();
}

export { relativeTime };