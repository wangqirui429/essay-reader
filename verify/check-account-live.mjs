/**
 * Live check: the account panel works on the published site, against the real
 * Supabase project.
 *
 * This is the one verifier that talks to the real auth API rather than a local
 * double, so it is what proves the backend is reachable from a visitor's
 * browser at all. It submits deliberately wrong credentials: the reader must
 * see a plain Chinese explanation, not a dead form, a spinner that never ends,
 * or a console exception.
 *
 * Usage: node verify/check-account-live.mjs [url]
 */

import { spawn } from 'node:child_process';
import path from 'node:path';

const URL_TO_TEST = process.argv[2] || 'https://wangqirui429.github.io/essay-reader/';
const PORT = 9547;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const profile = path.join(process.env.TEMP, `er-acct-${Date.now()}`);
const exe = 'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe';

const proc = spawn(
  exe,
  ['--headless=new', `--remote-debugging-port=${PORT}`, `--user-data-dir=${profile}`, '--no-first-run', 'about:blank'],
  { stdio: 'ignore' },
);

let version = null;
for (let i = 0; i < 100 && !version; i += 1) {
  await sleep(300);
  try {
    version = await (await fetch(`http://127.0.0.1:${PORT}/json/version`)).json();
  } catch {
    /* retry */
  }
}
if (!version) {
  console.error('browser failed to start');
  proc.kill();
  process.exit(1);
}

const page = (await (await fetch(`http://127.0.0.1:${PORT}/json/list`)).json()).find((t) => t.type === 'page');
const ws = new WebSocket(page.webSocketDebuggerUrl);
await new Promise((res, rej) => {
  ws.addEventListener('open', res, { once: true });
  ws.addEventListener('error', rej, { once: true });
});

let id = 0;
const pending = new Map();
const problems = [];

ws.addEventListener('message', (ev) => {
  const m = JSON.parse(ev.data);
  if (m.method === 'Runtime.exceptionThrown') {
    const d = m.params.exceptionDetails;
    problems.push(`exception: ${d.exception?.description || d.text}`);
  }
  if (m.method === 'Log.entryAdded' && m.params.entry.level === 'error') {
    problems.push(`log error: ${m.params.entry.text}`);
  }
  if (m.method === 'Network.loadingFailed' && !m.params.errorText.includes('ERR_ABORTED')) {
    problems.push(`network: ${m.params.errorText} ${m.params.requestId}`);
  }
  const job = pending.get(m.id);
  if (job) {
    pending.delete(m.id);
    job(m.result);
  }
});

const send = (method, params = {}) =>
  new Promise((resolve) => {
    const i = ++id;
    pending.set(i, resolve);
    ws.send(JSON.stringify({ id: i, method, params }));
    setTimeout(() => {
      if (pending.has(i)) {
        pending.delete(i);
        resolve({ timedOut: true });
      }
    }, 25000);
  });

/** Evaluate and return the value, polling until it is non-null. */
async function evalJson(expr, tries = 20) {
  for (let i = 0; i < tries; i += 1) {
    const r = await send('Runtime.evaluate', { expression: expr, returnByValue: true, awaitPromise: false });
    if (r && r.result && r.result.value !== undefined && r.result.value !== null) return r.result.value;
    await sleep(300);
  }
  return null;
}

/** Poll an expression until it returns true, reporting how long it took. */
async function waitFor(expr, timeoutMs = 20000) {
  const started = Date.now();
  while (Date.now() - started < timeoutMs) {
    const r = await send('Runtime.evaluate', { expression: expr, returnByValue: true, awaitPromise: false });
    if (r?.result?.value === true) return Date.now() - started;
    await sleep(120);
  }
  return -1;
}

const results = [];
function check(ok, label, detail = '') {
  results.push({ ok, label, detail });
  console.log(`${ok ? 'ok  ' : 'FAIL'} ${label}${detail ? ` — ${detail}` : ''}`);
}

await send('Page.enable');
await send('Runtime.enable');
await send('Log.enable');
await send('Network.enable');

console.log(`opening ${URL_TO_TEST}`);
send('Page.navigate', { url: URL_TO_TEST });

// Wait for the app to actually boot rather than guessing at a fixed delay.
const booted = await evalJson(
  `document.querySelector('.topbar') ? 'shell' : null`,
);
check(booted !== null, 'the shell rendered', String(booted));

// Open settings through the app's own router.
await send('Runtime.evaluate', { expression: `window.location.hash = '#/settings'` });
const shownAfter = await waitFor(
  `(() => {
    const v = document.querySelector('[data-view-panel="settings"]');
    const card = document.querySelector('#accountCard');
    if (!v || !card) return false;
    if (v.hidden || getComputedStyle(v).display === 'none') return false;
    const r = card.getBoundingClientRect();
    return r.width > 0 && r.height > 0;
  })()`,
);
check(shownAfter >= 0, 'the settings view opened with an account card', shownAfter >= 0 ? `${shownAfter}ms` : 'timed out');

// The markup ships with #authForm hidden and the boot sequence reveals it, so
// the form being visible is the signal that initAccount has actually run and
// bound its handlers. Measuring before this point reads a pre-boot DOM and
// submits into a form nobody is listening to.
const bootFinished = await waitFor(`document.getElementById('authForm').hidden === false`, 20000);
check(bootFinished >= 0, 'the account panel finished booting', bootFinished >= 0 ? `${bootFinished}ms` : 'timed out');

const panel = await evalJson(`(() => {
  const card = document.querySelector('#accountCard');
  if (!card) return null;
  const form = document.querySelector('#authForm');
  const signedIn = document.querySelector('#accountSignedIn');
  const email = document.querySelector('#authEmail');
  const pass = document.querySelector('#authPassword');
  const submit = document.querySelector('#btnSubmitAuth');
  const alt = document.querySelector('#btnAltMode');
  const forgot = document.querySelector('#btnForgot');
  const missing = document.querySelector('#authConfigMissing');
  const reset = document.querySelector('#resetForm');
  const visible = (el) => {
    if (!el) return false;
    // Ask what is actually painted, not what the attribute says. A stylesheet
    // rule of equal specificity can leave a "hidden" element fully visible —
    // this check exists because that happened.
    const cs = getComputedStyle(el);
    if (cs.display === 'none' || cs.visibility === 'hidden') return false;
    const r = el.getBoundingClientRect();
    return r.width > 0 && r.height > 0;
  };
  return {
    cardVisible: visible(card),
    title: (card.querySelector('.set-card__title')?.textContent || '').trim(),
    formVisible: visible(form),
    formDisplay: form ? getComputedStyle(form).display : null,
    signedInVisible: visible(signedIn),
    signedInDisplay: signedIn ? getComputedStyle(signedIn).display : null,
    emailType: email ? email.type : null,
    emailAutocomplete: email ? email.getAttribute('autocomplete') : null,
    passType: pass ? pass.type : null,
    passAutocomplete: pass ? pass.getAttribute('autocomplete') : null,
    submitText: submit ? submit.textContent.trim() : null,
    submitType: submit ? submit.type : null,
    altText: alt ? alt.textContent.trim() : null,
    forgotText: forgot ? forgot.textContent.trim() : null,
    configMissingVisible: missing ? visible(missing) : null,
    resetVisible: reset ? visible(reset) : null,
    // The previous backend addressed the reader with a pasted token. None of
    // that vocabulary may survive in the panel.
    legacyTokenInput: !!document.querySelector('#authToken'),
    legacyWording: /令牌|github|gist/i.test(card.textContent || ''),
    cardText: (card.textContent || '').replace(/\\s+/g, ' ').trim().slice(0, 160),
  };
})()`);

check(panel !== null, 'the settings page carries an account card');
check(/账号/.test(panel?.title || ''), 'the card is titled in Chinese', panel?.title);
check(panel?.cardVisible === true, 'the account card is visible');
check(panel?.formVisible === true, 'the sign-in form is offered', `display=${panel?.formDisplay}`);
check(panel?.signedInVisible === false, 'no signed-in panel appears before signing in', `display=${panel?.signedInDisplay}`);
check(panel?.emailType === 'email', 'the account field is an email input', `type=${panel?.emailType}`);
check(panel?.passType === 'password', 'the password field is masked', `type=${panel?.passType} autocomplete=${panel?.passAutocomplete}`);
check(/登录/.test(panel?.submitText || ''), 'the submit button offers sign-in', panel?.submitText);
check(/注册/.test(panel?.altText || ''), 'a second button offers account creation', panel?.altText);
check(/忘记|找回|重置/.test(panel?.forgotText || ''), 'a password recovery entry point exists', panel?.forgotText);
check(panel?.configMissingVisible === false, 'the shipped build carries real project credentials');
check(panel?.resetVisible === false, 'the password reset form stays out of the way until a reset link is used');
check(panel?.legacyTokenInput === false && panel?.legacyWording === false, 'no leftover token wording survives the backend change', panel?.cardText);

// Wrong credentials must reach the real auth API and come back as Chinese.
// This is also the live proof that the API is reachable from here.
const probeEmail = `nobody-${Date.now()}@example.com`;
await send('Runtime.evaluate', {
  expression: `(() => {
    document.getElementById('authEmail').value = ${JSON.stringify(probeEmail)};
    document.getElementById('authPassword').value = 'definitely-not-the-password';
    const form = document.getElementById('authForm');
    form.requestSubmit ? form.requestSubmit() : document.getElementById('btnSubmitAuth').click();
    return true;
  })()`,
});

const errorShown = await waitFor(`(() => {
  const e = document.getElementById('authError');
  if (!e || e.hidden) return false;
  const r = e.getBoundingClientRect();
  return r.height > 0 && e.textContent.trim().length > 0;
})()`, 30000);
check(errorShown >= 0, 'wrong credentials are refused with a visible message', errorShown >= 0 ? `${errorShown}ms` : 'timed out');

const errText = await evalJson(`(document.getElementById('authError').textContent || '').trim()`);
check(/密码|邮箱|无效|过期|网络|连接|频繁/.test(errText || ''), 'the refusal is explained in Chinese', (errText || '').slice(0, 80));
check(
  await evalJson(`document.getElementById('accountSignedIn').hidden === true && document.getElementById('authForm').hidden === false`),
  'the app stays signed out after wrong credentials',
);

// The rest of the app must still work.
const restOfApp = await evalJson(`(() => {
  const nav = document.querySelector('.nav') || document.querySelector('nav');
  return { navText: (nav?.textContent || '').replace(/\\s+/g, ' ').trim() };
})()`);
check(/文章/.test(restOfApp?.navText || ''), 'navigation still renders in Chinese', restOfApp?.navText);

const realProblems = problems.filter((p) => !/favicon/i.test(p) && !/401|403|400/i.test(p));
check(realProblems.length === 0, 'no runtime exceptions or failed requests', realProblems.slice(0, 3).join(' | '));

const passed = results.filter((r) => r.ok).length;
console.log(`\n${passed}/${results.length} checks passed`);

ws.close();
proc.kill();
process.exit(passed === results.length ? 0 : 1);