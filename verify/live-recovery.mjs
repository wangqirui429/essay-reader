/**
 * The whole "forgot password" path, against the published site.
 *
 * Two shapes are exercised, because both are offered to the reader:
 *   1. the mailed link  ->  https://site/#type=recovery&token_hash=…
 *   2. the mailed code  ->  "我有验证码" in Settings
 *
 * The link is minted with the service_role key (read from the management API at
 * run time, never stored) and the token hash / six-digit code are taken from
 * the same response, so nothing is guessed.
 *
 * Usage:
 *   $env:SUPABASE_PAT='sbp_...'
 *   node verify/live-recovery.mjs
 */

import { spawn } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';

const PROJECT = 'ejnrmtkcigjwbubcxbgy';
const SITE = 'https://wangqirui429.github.io/essay-reader/';
const PORT = 9567;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

if (!process.env.SUPABASE_PAT) throw new Error('SUPABASE_PAT is not set');
const PAT = process.env.SUPABASE_PAT;

/* ------------------------------------------------------------------ backend */

async function projectKeys() {
  const response = await fetch(`https://api.supabase.com/v1/projects/${PROJECT}/api-keys?reveal=true`, {
    headers: { Authorization: `Bearer ${PAT}` },
  });
  if (!response.ok) throw new Error(`api-keys ${response.status}: ${await response.text()}`);
  const keys = await response.json();
  return {
    anon: keys.find((k) => k.name === 'anon').api_key,
    service: keys.find((k) => k.name === 'service_role').api_key,
  };
}

async function sql(query) {
  const response = await fetch(`https://api.supabase.com/v1/projects/${PROJECT}/database/query`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${PAT}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ query }),
  });
  const text = await response.text();
  if (!response.ok) throw new Error(`sql ${response.status}: ${text.slice(0, 200)}`);
  return text ? JSON.parse(text) : null;
}

const { anon, service } = await projectKeys();

/*
 * The project host answers ECONNRESET from Node on this network (the browser
 * resolves it through its own resolver and works). So account creation and link
 * minting run inside the page, not here; only the management API is called from
 * Node. The service key stays in memory and is never written or printed.
 */
async function inPage(expression) {
  return evaluate(expression);
}

async function createAccount(email, password) {
  const raw = await inPage(`(async () => {
    const response = await fetch('https://${PROJECT}.supabase.co/auth/v1/signup', {
      method: 'POST',
      headers: { apikey: ${JSON.stringify(anon)}, Authorization: 'Bearer ' + ${JSON.stringify(anon)},
        'Content-Type': 'application/json' },
      body: JSON.stringify({ email: ${JSON.stringify(email)}, password: ${JSON.stringify(password)} })
    });
    return response.status + ' ' + (await response.text()).slice(0, 300);
  })()`);
  if (!String(raw).startsWith('200')) throw new Error(`signup: ${raw}`);
  return raw;
}

async function mintRecovery(email) {
  const raw = await inPage(`(async () => {
    const response = await fetch('https://${PROJECT}.supabase.co/auth/v1/admin/generate_link', {
      method: 'POST',
      headers: { apikey: ${JSON.stringify(service)}, Authorization: 'Bearer ' + ${JSON.stringify(service)},
        'Content-Type': 'application/json' },
      body: JSON.stringify({ type: 'recovery', email: ${JSON.stringify(email)},
        redirect_to: ${JSON.stringify(SITE)} })
    });
    const text = await response.text();
    return response.status + '\\n' + text;
  })()`);
  const [status, ...rest] = String(raw).split('\n');
  if (status !== '200') throw new Error(`generate_link ${status}: ${rest.join('\n').slice(0, 200)}`);
  const parsed = JSON.parse(rest.join('\n'));
  return {
    tokenHash: parsed.hashed_token || String(parsed.action_link || '').match(/token=([^&]+)/)?.[1] || '',
    code: String(parsed.email_otp || '').replace(/\D/g, ''),
  };
}

/* ------------------------------------------------------------------ browser */

const profile = path.join(process.env.TEMP, `er-recovery-${Date.now()}`);
const browser = spawn(
  'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe',
  ['--headless=new', `--remote-debugging-port=${PORT}`, `--user-data-dir=${profile}`,
    '--no-first-run', '--disable-features=Translate', 'about:blank'],
  { stdio: 'ignore' },
);
let ready = null;
for (let i = 0; i < 120 && !ready; i += 1) {
  await sleep(250);
  try { ready = await (await fetch(`http://127.0.0.1:${PORT}/json/version`)).json(); } catch { /* retry */ }
}
if (!ready) throw new Error('browser never answered');

const target = (await (await fetch(`http://127.0.0.1:${PORT}/json/list`)).json()).find((t) => t.type === 'page');
const ws = new WebSocket(target.webSocketDebuggerUrl);
await new Promise((res) => ws.addEventListener('open', res, { once: true }));

let seq = 0;
const pending = new Map();
ws.addEventListener('message', (ev) => {
  const message = JSON.parse(ev.data);
  const job = pending.get(message.id);
  if (job) { pending.delete(message.id); job(message.result); }
});
const send = (method, params = {}) => new Promise((resolve) => {
  const id = ++seq;
  pending.set(id, resolve);
  ws.send(JSON.stringify({ id, method, params }));
  setTimeout(() => { if (pending.has(id)) { pending.delete(id); resolve({ timedOut: true }); } }, 40000);
});
const evaluate = async (expression) =>
  (await send('Runtime.evaluate', { expression, returnByValue: true, awaitPromise: true }))?.result?.value;

await send('Page.enable');
await send('Runtime.enable');

/** Poll a synchronous predicate until it is true. */
async function waitFor(expression, ms = 25000) {
  const until = Date.now() + ms;
  while (Date.now() < until) {
    if (await evaluate(`Boolean(${expression})`)) return true;
    await sleep(200);
  }
  return false;
}

/** Always load a fresh document: a different fragment alone is not a new load. */
let load = 0;
async function open(fragment) {
  load += 1;
  await send('Page.navigate', { url: `${SITE}?load=${load}${fragment || ''}` });
  await waitFor("document.readyState === 'complete'", 30000);
  await waitFor("document.getElementById('authForm') && document.getElementById('authForm').hidden === false"
    + " || document.body.classList.contains('is-recovering')", 30000);
}

const results = [];
const check = (name, pass, detail = '') => {
  results.push({ name, pass, detail });
  console.log(`${pass ? 'PASS' : 'FAIL'}  ${name}${detail ? ` — ${detail}` : ''}`);
};

function flow(title) {
  console.log(`\n## ${title}`);
}

const stamp = Date.now();
const linkEmail = `link.${stamp}@example.com`;
const codeEmail = `code.${stamp}@example.com`;
const firstPassword = 'FirstPass!42';
const newPassword = 'SecondPass!43';

try {
  /* ------------------------------------------------- 1. mailed link */
  flow('1. the mailed link');
  // The page has to exist first: account creation and link minting run in it.
  await open('');
  await createAccount(linkEmail, firstPassword);
  const { tokenHash } = await mintRecovery(linkEmail);
  check('a recovery token hash was minted', tokenHash.length > 10, `len ${tokenHash.length}`);

  await open(`#type=recovery&token_hash=${encodeURIComponent(tokenHash)}`);
  const adopted = await waitFor("document.body.classList.contains('is-recovering')", 20000);
  check('the link puts the app in reset mode', adopted);

  const session = await evaluate("localStorage.getItem('essay-reader:session') || ''");
  check('a recovery session was stored', String(session).includes('access_token'));
  const cleaned = await evaluate("location.hash === '#/settings'");
  check('the token is removed from the address bar', cleaned);

  const resetVisible = await evaluate("!document.getElementById('resetForm').hidden");
  check('the new-password form is shown', resetVisible);

  await evaluate(`(() => {
    document.getElementById('newPassword').value = ${JSON.stringify(newPassword)};
    document.getElementById('newPassword2').value = ${JSON.stringify(newPassword)};
    document.getElementById('resetForm').requestSubmit();
  })()`);
  const saved = await waitFor("[...document.querySelectorAll('.set-note')].some(n => n.textContent.includes('密码已更新'))", 20000);
  check('the new password is saved', saved);

  /* ------------------------------------- 2. the saved password works */
  flow('2. the new password really signs in');
  await evaluate(`(() => {
    document.getElementById('btnSignOut').click();
  })()`);
  await waitFor("document.getElementById('authForm').hidden === false", 15000);
  await evaluate(`(() => {
    document.getElementById('authEmail').value = ${JSON.stringify(linkEmail)};
    document.getElementById('authPassword').value = ${JSON.stringify(newPassword)};
    document.getElementById('authForm').requestSubmit();
  })()`);
  const signedIn = await waitFor("!document.getElementById('accountSignedIn').hidden", 25000);
  check('sign in with the new password works', signedIn);

  const shownEmail = await evaluate("document.getElementById('accountEmail').textContent");
  check('the panel names the account', shownEmail === linkEmail, shownEmail);

  await evaluate("document.getElementById('btnSignOut').click()");
  await waitFor("document.getElementById('authForm').hidden === false", 15000);
  await evaluate(`(() => {
    document.getElementById('authEmail').value = ${JSON.stringify(linkEmail)};
    document.getElementById('authPassword').value = ${JSON.stringify(firstPassword)};
    document.getElementById('authForm').requestSubmit();
  })()`);
  const rejected = await waitFor("document.getElementById('authError').textContent.length > 0", 25000);
  const rejectionText = await evaluate("document.getElementById('authError').textContent");
  check('the old password is refused', rejected, String(rejectionText));
  check('it is explained in Chinese', /不正确|太频繁|不对/.test(String(rejectionText)), String(rejectionText));

  /* ------------------------------------------------- 3. the mailed code */
  flow('3. the six-digit code');
  await createAccount(codeEmail, firstPassword);
  const minted = await mintRecovery(codeEmail);
  check('a six-digit code was minted', minted.code.length >= 6, `len ${minted.code.length}`);

  await open('');
  await evaluate("document.getElementById('btnShowCode').click()");
  const codeFormShown = await waitFor("!document.getElementById('codeForm').hidden", 8000);
  check('the code form opens', codeFormShown);
  const authHidden = await evaluate("document.getElementById('authForm').hidden === true");
  check('the sign-in form steps aside', authHidden);

  await evaluate(`(() => {
    document.getElementById('codeEmail').value = ${JSON.stringify(codeEmail)};
    document.getElementById('codeValue').value = ${JSON.stringify(minted.code)};
    document.getElementById('codeForm').requestSubmit();
  })()`);
  const codeAccepted = await waitFor("document.body.classList.contains('is-recovering')", 20000);
  check('the code puts the app in reset mode', codeAccepted);

  await evaluate(`(() => {
    document.getElementById('newPassword').value = ${JSON.stringify(newPassword)};
    document.getElementById('newPassword2').value = ${JSON.stringify(newPassword)};
    document.getElementById('resetForm').requestSubmit();
  })()`);
  const savedByCode = await waitFor("[...document.querySelectorAll('.set-note')].some(n => n.textContent.includes('密码已更新'))", 20000);
  check('the password is saved via the code path', savedByCode);

  /* ---------------------------------------------- 4. a bad code is explained */
  flow('4. a wrong code is explained in Chinese');
  await open('');
  await evaluate("document.getElementById('btnShowCode').click()");
  await waitFor("!document.getElementById('codeForm').hidden", 8000);
  await evaluate(`(() => {
    document.getElementById('codeEmail').value = ${JSON.stringify(codeEmail)};
    document.getElementById('codeValue').value = '000000';
    document.getElementById('codeForm').requestSubmit();
  })()`);
  const badCode = await waitFor("document.getElementById('codeError').textContent.length > 0", 20000);
  const badText = await evaluate("document.getElementById('codeError').textContent");
  check('a wrong code shows a sentence', badCode, badText);
  check('it is in Chinese', /验证码|过期|不对/.test(String(badText)), badText);

  /* ------------------------------------------------------------- 5. dead link */
  flow('5. a used-up link explains itself');
  // Sections 1–4 leave a real session behind; a dead link must be judged from
  // a signed-out browser, which is the state a reader arriving from mail is in.
  await evaluate("localStorage.removeItem('essay-reader:session')");
  await open('#type=recovery&token_hash=00000000000000000000000000000000000000000000000000000000');
  const explained = await waitFor("document.getElementById('authError').textContent.length > 0", 25000);
  const explainedText = await evaluate("document.getElementById('authError').textContent");
  check('an expired link says something', explained, String(explainedText));
  check('it is in Chinese', /验证码|过期|不对|网络|邮箱/.test(String(explainedText)), String(explainedText));
  const stillSignedOut = await evaluate("document.getElementById('accountSignedIn').hidden === true");
  check('the app does not pretend to be signed in', stillSignedOut);

  /* ------------------------------------------------------------- cleanup */
  flow('cleanup');
  const removed = await sql(`delete from auth.users where email like 'link.%@example.com' or email like 'code.%@example.com' returning email`);
  check('the throwaway accounts are gone', Array.isArray(removed) && removed.length >= 2, `${removed?.length ?? 0} removed`);
} finally {
  await sleep(200);
  ws.close();
  browser.kill();
  try { fs.rmSync(profile, { recursive: true, force: true }); } catch { /* ignore */ }
}

const passed = results.filter((r) => r.pass).length;
console.log(`\n${passed}/${results.length} checks passed`);
process.exit(passed === results.length ? 0 : 1);