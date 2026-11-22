/**
 * The account panel in Settings: sign up, sign in, sync, sign out, and the
 * "set a new password" form a recovery link lands on.
 *
 * Kept out of app.js because it owns a self-contained state machine
 * (signed out → busy → signed in → syncing → synced/error → recovering) and
 * app.js is already the largest module in the app.
 *
 * All user-facing text goes through i18n; this file holds no literals that a
 * reader can see.
 */

import { t } from './i18n.js';
import {
  hasConfig, getUser, signIn, signUp, signOut, onAuthChange, AuthError,
  requestPasswordReset, updatePassword, verifyRecoveryCode, takeRecoveryFailure,
} from './auth.js';
import {
  getSyncStatus, onSyncStatus, initialSync, syncNow, startSyncWatcher,
  resetSync, cancelScheduledSync,
} from './sync.js';

const $ = (sel) => document.querySelector(sel);

let onDataChanged = () => {};
let mode = 'signin'; // 'signin' | 'signup'
/** True while the "type the six digits" form replaces the sign-in form. */
let showCode = false;

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

/** Show the correct panel for the current state. */
function renderAccount() {
  const user = getUser();
  const recovering = document.body.classList.contains('is-recovering');

  const form = $('#authForm');
  if (form) form.hidden = Boolean(user) || recovering || showCode;

  const codeForm = $('#codeForm');
  if (codeForm) codeForm.hidden = Boolean(user) || recovering || !showCode;

  const signedIn = $('#accountSignedIn');
  if (signedIn) signedIn.hidden = !user || recovering;

  const reset = $('#resetForm');
  if (reset) reset.hidden = !recovering;

  const syncBtn = $('#btnSyncNow');
  if (syncBtn) syncBtn.disabled = !user;
  const outBtn = $('#btnSignOut');
  if (outBtn) outBtn.disabled = !user;

  const submit = $('#btnSubmitAuth');
  if (submit && !submit.disabled) {
    submit.textContent = mode === 'signup' ? t('settings.signUp') : t('settings.signIn');
  }

  if (user) {
    const name = $('#accountEmail');
    if (name) name.textContent = user.email || '';
    renderSyncStatus();
  }
}

function showAuthError(message) {
  const el = $('#authError');
  if (!el) return;
  el.textContent = message || '';
  el.hidden = !message;
}

function showAuthInfo(message) {
  const el = $('#authInfo');
  if (!el) return;
  el.textContent = message || '';
  el.hidden = !message;
}

/** Disable the submit button while a request is in flight. */
function setBusy(busy, label) {
  const btn = $('#btnSubmitAuth');
  const alt = $('#btnAltMode');
  const forgot = $('#btnForgot');
  if (btn) {
    btn.disabled = busy;
    btn.textContent = busy ? label : (mode === 'signup' ? t('settings.signUp') : t('settings.signIn'));
  }
  if (alt) alt.disabled = busy;
  if (forgot) forgot.disabled = busy;
}

function readCredentials() {
  const email = String($('#authEmail')?.value || '').trim();
  const password = String($('#authPassword')?.value || '');
  if (!email) { showAuthError(t('auth.invalid_email')); return null; }
  if (password.length < 6) { showAuthError(t('auth.weak_password')); return null; }
  return { email, password };
}

/** Shared tail of a successful sign-in: pull the cloud copy and repaint. */
async function afterConnect() {
  showAuthError('');
  showAuthInfo('');
  renderAccount();
  const result = await initialSync();
  renderSyncStatus();
  if (result.ok && result.changed) onDataChanged();
  if (!result.ok && result.status === 'error') {
    showAuthError(t('sync.error', { msg: syncErrorText(result.error) }));
  }
}

async function handleSubmit(ev) {
  ev?.preventDefault?.();
  const creds = readCredentials();
  if (!creds) return;

  showAuthInfo('');
  const label = mode === 'signup' ? t('sync.signingUp') : t('sync.signingIn');
  setBusy(true, label);
  try {
    if (mode === 'signup') {
      const { needsConfirmation } = await signUp(creds.email, creds.password);
      const input = $('#authPassword');
      if (input) input.value = '';
      if (needsConfirmation) {
        showAuthInfo(t('account.checkEmail', { email: creds.email }));
        renderAccount();
      } else {
        await afterConnect();
      }
    } else {
      await signIn(creds.email, creds.password);
      const input = $('#authPassword');
      if (input) input.value = '';
      await afterConnect();
    }
  } catch (err) {
    showAuthError(describeAuthError(err));
  } finally {
    setBusy(false);
    renderAccount();
  }
}

/** Toggle between "sign in" and "create an account" on the same two fields. */
function toggleMode() {
  mode = mode === 'signup' ? 'signin' : 'signup';
  showAuthError('');
  showAuthInfo('');
  renderAccount();
}

async function handleForgot() {
  const email = String($('#authEmail')?.value || '').trim();
  if (!email) { showAuthError(t('auth.invalid_email')); return; }
  setBusy(true, t('sync.sending'));
  try {
    await requestPasswordReset(email);
    showAuthError('');
    showAuthInfo(t('account.resetSent', { email }));
  } catch (err) {
    showAuthError(describeAuthError(err));
  } finally {
    setBusy(false);
  }
}

/** Switch to the "type the six digits" form, keeping the address already typed. */
function showCodeForm() {
  showCode = true;
  const typed = String($('#authEmail')?.value || '').trim();
  const email = $('#codeEmail');
  if (email && typed && !email.value) email.value = typed;
  showAuthError('');
  showAuthInfo('');
  renderAccount();
  $('#codeValue')?.focus();
}

function hideCodeForm() {
  showCode = false;
  const err = $('#codeError');
  if (err) { err.textContent = ''; err.hidden = true; }
  renderAccount();
}

/** Exchange the mailed six-digit code for a recovery session. */
async function handleUseCode(ev) {
  ev?.preventDefault?.();
  const email = String($('#codeEmail')?.value || '').trim();
  const code = String($('#codeValue')?.value || '').trim();
  const err = $('#codeError');
  const fail = (message) => {
    if (!err) return;
    err.textContent = message;
    err.hidden = false;
  };

  if (!email) { fail(t('auth.invalid_email')); return; }
  if (code.replace(/\D/g, '').length < 6) { fail(t('auth.bad_code')); return; }

  const btn = $('#btnUseCode');
  if (btn) { btn.disabled = true; btn.textContent = t('sync.checking'); }
  try {
    await verifyRecoveryCode(email, code);
    const input = $('#codeValue');
    if (input) input.value = '';
    showCode = false;
    document.body.classList.add('is-recovering');
    showAuthError('');
    showAuthInfo('');
    renderAccount();
    $('#newPassword')?.focus();
  } catch (error) {
    fail(describeAuthError(error));
  } finally {
    if (btn) { btn.disabled = false; btn.textContent = t('settings.useCode'); }
  }
}

async function handleReset(ev) {
  ev?.preventDefault?.();
  const password = String($('#newPassword')?.value || '');
  const again = String($('#newPassword2')?.value || '');
  if (password.length < 6) { showAuthError(t('auth.weak_password')); return; }
  if (password !== again) { showAuthError(t('auth.password_mismatch')); return; }

  const btn = $('#btnSavePassword');
  if (btn) { btn.disabled = true; btn.textContent = t('sync.saving'); }
  try {
    await updatePassword(password);
    const input = $('#newPassword');
    if (input) input.value = '';
    const input2 = $('#newPassword2');
    if (input2) input2.value = '';
    document.body.classList.remove('is-recovering');
    showAuthError('');
    renderAccount();
    // afterConnect() clears both notices at its start, so the confirmation has
    // to be written after it — otherwise the reader saves a password and sees
    // nothing come back.
    await afterConnect();
    showAuthInfo(t('account.passwordUpdated'));
  } catch (err) {
    showAuthError(describeAuthError(err));
  } finally {
    if (btn) { btn.disabled = false; btn.textContent = t('settings.savePassword'); }
  }
}

async function handleSignOut() {
  cancelScheduledSync();
  resetSync();
  await signOut();
  renderAccount();
  showAuthError('');
  showAuthInfo('');
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
 * @param {{onDataChanged: () => void, recovering?: boolean}} options
 */
export function initAccount(options = {}) {
  onDataChanged = options.onDataChanged || (() => {});
  if (options.recovering) {
    document.body.classList.add('is-recovering');
    mode = 'signin';
  }

  renderAccount();

  $('#authForm')?.addEventListener('submit', handleSubmit);
  $('#btnAltMode')?.addEventListener('click', toggleMode);
  $('#btnForgot')?.addEventListener('click', handleForgot);
  $('#btnShowCode')?.addEventListener('click', showCodeForm);
  $('#btnCodeBack')?.addEventListener('click', hideCodeForm);
  $('#codeForm')?.addEventListener('submit', handleUseCode);
  $('#resetForm')?.addEventListener('submit', handleReset);
  $('#btnSignOut')?.addEventListener('click', handleSignOut);
  $('#btnSyncNow')?.addEventListener('click', handleSyncNow);

  onAuthChange(() => renderAccount());
  onSyncStatus(() => renderSyncStatus());

  // Keep "3 minutes ago" from going stale while the panel is open.
  setInterval(() => {
    if (getUser() && !$('#accountSignedIn')?.hidden) renderSyncStatus();
  }, 30_000);

  startSyncWatcher();

  if (!hasConfig()) {
    const note = $('#authConfigMissing');
    if (note) note.hidden = false;
    return;
  }

  // A recovery link that could not be exchanged: say why instead of silently
  // showing the sign-in form again.
  const failure = takeRecoveryFailure();
  if (failure) {
    const key = `auth.${failure}`;
    const message = t(key);
    showAuthError(message === key ? t('auth.bad_code') : message);
  }

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