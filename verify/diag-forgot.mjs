/**
 * Why did "forgot password" not call the auth API? Signs in, signs out, fills
 * the email and clicks the button, then prints every auth request and whatever
 * the panel says.
 *
 * Usage: node verify/diag-forgot.mjs [email]
 */

import { spawn } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';

const EMAIL = process.argv[2] || '2908789149@qq.com';
const PASSWORD = process.argv[3] || 'Mail7wzkbv!9';
const URL_TO_TEST = 'https://wangqirui429.github.io/essay-reader/';
const PORT = 9558;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const profile = path.join(process.env.TEMP, `er-diag-${Date.now()}`);
const proc = spawn(
  'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe',
  ['--headless=new', `--remote-debugging-port=${PORT}`, `--user-data-dir=${profile}`, '--no-first-run', 'about:blank'],
  { stdio: 'ignore' },
);

let version = null;
for (let i = 0; i < 100 && !version; i += 1) {
  await sleep(300);
  try {
    version = await (await fetch(`http://127.0.0.1:${PORT}/json/version`)).json();
  } catch { /* retry */ }
}
const page = (await (await fetch(`http://127.0.0.1:${PORT}/json/list`)).json()).find((t) => t.type === 'page');
const ws = new WebSocket(page.webSocketDebuggerUrl);
await new Promise((res) => ws.addEventListener('open', res, { once: true }));

let id = 0;
const pending = new Map();
const log = [];
ws.addEventListener('message', (ev) => {
  const m = JSON.parse(ev.data);
  if (m.method === 'Network.requestWillBeSent' && m.params.request.url.includes('/auth/v1/')) {
    log.push(`-> ${m.params.request.method} ${m.params.request.url.split('?')[0]} body=${(m.params.request.postData || '').slice(0, 120)}`);
  }
  if (m.method === 'Network.responseReceived' && m.params.response.url.includes('/auth/v1/')) {
    log.push(`<- ${m.params.response.status} ${m.params.response.url.split('?')[0]}`);
  }
  if (m.method === 'Runtime.consoleAPICalled') {
    log.push(`console.${m.params.type}: ${m.params.args.map((a) => a.value ?? a.description ?? '').join(' ')}`);
  }
  const job = pending.get(m.id);
  if (job) { pending.delete(m.id); job(m.result); }
});
const send = (method, params = {}) => new Promise((resolve) => {
  const i = ++id;
  pending.set(i, resolve);
  ws.send(JSON.stringify({ id: i, method, params }));
  setTimeout(() => { if (pending.has(i)) { pending.delete(i); resolve({ timedOut: true }); } }, 25000);
});
const evaluate = async (expression) => (await send('Runtime.evaluate', { expression, returnByValue: true }))?.result?.value;
async function waitFor(expression, timeoutMs = 25000) {
  const started = Date.now();
  while (Date.now() - started < timeoutMs) {
    if ((await evaluate(expression)) === true) return Date.now() - started;
    await sleep(150);
  }
  return -1;
}

await send('Page.enable');
await send('Runtime.enable');
await send('Network.enable');

send('Page.navigate', { url: `${URL_TO_TEST}#/settings` }).catch(() => {});
await waitFor("!!document.getElementById('authForm') && document.getElementById('authForm').hidden === false", 40000);

const state = async (label) => {
  const snapshot = await evaluate(`JSON.stringify({
    formHidden: document.getElementById('authForm')?.hidden,
    signedInHidden: document.getElementById('accountSignedIn')?.hidden,
    formDisplay: getComputedStyle(document.getElementById('authForm')).display,
    signedInDisplay: getComputedStyle(document.getElementById('accountSignedIn')).display,
    email: document.getElementById('authEmail')?.value,
    error: document.getElementById('authError')?.textContent,
    info: document.getElementById('authInfo')?.textContent,
    forgotDisabled: document.getElementById('btnForgot')?.disabled,
    submitLabel: document.getElementById('btnSubmitAuth')?.textContent
  })`);
  console.log(label, snapshot);
};

await state('boot   ');
await evaluate(`(() => { const el = document.getElementById('authEmail'); el.focus(); el.value = ${JSON.stringify(EMAIL)}; el.dispatchEvent(new Event('input',{bubbles:true})); return true; })()`);
await evaluate(`(() => { const el = document.getElementById('authPassword'); el.focus(); el.value = ${JSON.stringify(PASSWORD)}; el.dispatchEvent(new Event('input',{bubbles:true})); return true; })()`);
await evaluate("document.getElementById('btnSubmitAuth').click()");
await waitFor("getComputedStyle(document.getElementById('accountSignedIn')).display !== 'none'", 20000);
await state('signedin');

await evaluate("document.getElementById('btnSignOut').click()");
await sleep(1200);
await state('signedout');

await evaluate(`(() => { const el = document.getElementById('authEmail'); el.focus(); el.value = ${JSON.stringify(EMAIL)}; el.dispatchEvent(new Event('input',{bubbles:true})); return true; })()`);
await state('filled  ');
await evaluate("document.getElementById('btnForgot').click()");
await sleep(4000);
await state('forgot  ');

console.log('\n--- auth traffic ---');
for (const line of log) console.log(line);

ws.close();
proc.kill();
try { fs.rmSync(profile, { recursive: true, force: true }); } catch { /* ignore */ }