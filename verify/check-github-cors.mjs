/**
 * Does the browser (not Node) let the deployed page talk to the GitHub API?
 *
 * A cross-origin request carrying an `Authorization` header is exactly what
 * sync does, and it only works if the API answers the preflight and allows the
 * header. Node is no proxy for this: it never sends a preflight.
 *
 * The token is read from the environment and never printed.
 * Usage: GH_TOKEN=... node verify/check-github-cors.mjs
 */

import { spawn } from 'node:child_process';
import path from 'node:path';

const PORT = 9568;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const profile = path.join(process.env.TEMP, `er-cors-${Date.now()}`);
const exe = 'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe';
const token = String(process.env.GH_TOKEN || '').trim();

if (!token) {
  console.error('GH_TOKEN is required');
  process.exit(1);
}

const proc = spawn(
  exe,
  ['--headless=new', `--remote-debugging-port=${PORT}`, `--user-data-dir=${profile}`, '--no-first-run', 'about:blank'],
  { stdio: 'ignore' },
);

let version = null;
for (let i = 0; i < 100 && !version; i += 1) {
  await sleep(300);
  try { version = await (await fetch(`http://127.0.0.1:${PORT}/json/version`)).json(); } catch { /* retry */ }
}
if (!version) { console.error('browser failed to start'); proc.kill(); process.exit(1); }

const page = (await (await fetch(`http://127.0.0.1:${PORT}/json/list`)).json()).find((t) => t.type === 'page');
const ws = new WebSocket(page.webSocketDebuggerUrl);
await new Promise((res, rej) => {
  ws.addEventListener('open', res, { once: true });
  ws.addEventListener('error', rej, { once: true });
});

let id = 0;
const pending = new Map();
ws.addEventListener('message', (ev) => {
  const m = JSON.parse(ev.data);
  const job = pending.get(m.id);
  if (job) { pending.delete(m.id); job(m.result); }
});
const send = (method, params = {}) => new Promise((resolve) => {
  const i = ++id;
  pending.set(i, resolve);
  ws.send(JSON.stringify({ id: i, method, params }));
  setTimeout(() => { if (pending.has(i)) { pending.delete(i); resolve({ timedOut: true }); } }, 30000);
});

await send('Page.enable');
await send('Runtime.enable');
await send('Page.navigate', { url: 'https://wangqirui429.github.io/essay-reader/' });
await sleep(3500);

const origin = await send('Runtime.evaluate', { expression: 'location.origin', returnByValue: true });
console.log('page origin:', origin?.result?.value, '\n');

const script = `(async () => {
  const H = { Authorization: 'Bearer ' + ${JSON.stringify(token)}, Accept: 'application/vnd.github+json' };
  const out = {};
  try {
    const r = await fetch('https://api.github.com/user', { headers: H });
    out.user = r.status;
    if (r.ok) { const j = await r.json(); out.login = j.login; }
  } catch (e) { out.user = 'THREW: ' + e.message; }
  try {
    const r = await fetch('https://api.github.com/gists?per_page=1', { headers: H });
    out.gists = r.status;
  } catch (e) { out.gists = 'THREW: ' + e.message; }
  try {
    const r = await fetch('https://api.github.com/gists', {
      method: 'POST',
      headers: { ...H, 'Content-Type': 'application/json' },
      body: JSON.stringify({ description: 'essay-reader cors probe', public: false, files: { 'essay-reader.json': { content: '{"probe":1}' } } }),
    });
    out.create = r.status;
    if (r.ok) { const g = await r.json(); out.gistId = g.id; }
  } catch (e) { out.create = 'THREW: ' + e.message; }
  if (out.gistId) {
    try {
      const r = await fetch('https://api.github.com/gists/' + out.gistId, { method: 'DELETE', headers: H });
      out.del = r.status;
    } catch (e) { out.del = 'THREW: ' + e.message; }
  }
  return JSON.stringify(out);
})()`;

const r = await send('Runtime.evaluate', { expression: script, awaitPromise: true, returnByValue: true });
console.log('result:', r?.result?.value ?? JSON.stringify(r));

ws.close();
proc.kill();