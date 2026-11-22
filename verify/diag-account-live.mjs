/**
 * One-off: why is #authForm still hidden on the live site?
 * Reports which bundle the page actually loaded (service worker vs network).
 */

import { spawn } from 'node:child_process';
import path from 'node:path';

const URL_TO_TEST = process.argv[2] || 'https://wangqirui429.github.io/essay-reader/';
const PORT = 9549;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const profile = path.join(process.env.TEMP, `er-diag-acct-${Date.now()}`);
const exe = 'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe';
const proc = spawn(exe, ['--headless=new', `--remote-debugging-port=${PORT}`, `--user-data-dir=${profile}`, '--no-first-run', 'about:blank'], { stdio: 'ignore' });

let version = null;
for (let i = 0; i < 100 && !version; i += 1) {
  await sleep(300);
  try { version = await (await fetch(`http://127.0.0.1:${PORT}/json/version`)).json(); } catch { /* retry */ }
}
const page = (await (await fetch(`http://127.0.0.1:${PORT}/json/list`)).json()).find((t) => t.type === 'page');
const ws = new WebSocket(page.webSocketDebuggerUrl);
await new Promise((res) => ws.addEventListener('open', res, { once: true }));

let id = 0;
const pending = new Map();
const events = [];
ws.addEventListener('message', (ev) => {
  const m = JSON.parse(ev.data);
  if (m.method === 'Runtime.exceptionThrown') events.push(`EXC ${m.params.exceptionDetails.exception?.description || m.params.exceptionDetails.text}`);
  if (m.method === 'Log.entryAdded') events.push(`LOG[${m.params.entry.level}] ${m.params.entry.text}`);
  if (m.method === 'Network.loadingFailed') events.push(`FAIL ${m.params.errorText} ${m.params.blockedReason || ''}`);
  if (m.method === 'Network.responseReceived' && /account|auth\.js|sync\.js|sw\.js/.test(m.params.response.url)) {
    events.push(`NET ${m.params.response.status} ${m.params.response.url}`);
  }
  const job = pending.get(m.id);
  if (job) { pending.delete(m.id); job(m.result); }
});
const send = (method, params = {}) => new Promise((resolve) => {
  const i = ++id;
  pending.set(i, resolve);
  ws.send(JSON.stringify({ id: i, method, params }));
  setTimeout(() => { if (pending.has(i)) { pending.delete(i); resolve({ timedOut: true }); } }, 20000);
});
const evalJson = async (expr) => {
  const r = await send('Runtime.evaluate', { expression: expr, returnByValue: true, awaitPromise: true });
  if (r.exceptionDetails) return { error: r.exceptionDetails.exception?.description };
  return r.result?.value;
};

await send('Page.enable');
await send('Runtime.enable');
await send('Log.enable');
await send('Network.enable');
send('Page.navigate', { url: URL_TO_TEST });
await sleep(9000);

console.log('--- state');
console.log(JSON.stringify(await evalJson(`(() => ({
  authFormHidden: document.getElementById('authForm')?.hidden,
  authFormDisplay: getComputedStyle(document.getElementById('authForm')).display,
  signedInHidden: document.getElementById('accountSignedIn')?.hidden,
  btnSignInText: document.getElementById('btnSignIn')?.textContent,
  swController: navigator.serviceWorker?.controller?.scriptURL || null,
  cacheKeys: null,
}))()`), null, 2));

console.log('--- what the page can import');
console.log(JSON.stringify(await evalJson(`(async () => {
  try {
    const m = await import('./js/account.js');
    const a = await import('./js/auth.js');
    return { accountExports: Object.keys(m), authExports: Object.keys(a), hasConfig: a.hasConfig(), user: a.getUser() };
  } catch (e) { return { importError: String(e && e.message || e) }; }
})()`), null, 2));

console.log('--- cached shell version');
console.log(JSON.stringify(await evalJson(`(async () => {
  const keys = await caches.keys();
  const out = {};
  for (const k of keys) {
    const c = await caches.open(k);
    const reqs = (await c.keys()).map(r => new URL(r.url).pathname);
    out[k] = reqs.filter(p => /account|auth\\.js|index\\.html/.test(p));
  }
  return out;
})()`), null, 2));

console.log('--- events');
for (const e of events.slice(0, 40)) console.log(e);

ws.close();
proc.kill();
try { (await import('node:fs')).rmSync(profile, { recursive: true, force: true }); } catch { /* ignore */ }