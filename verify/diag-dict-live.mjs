/**
 * Diagnostic: is "paragraph" missing from the shipped dictionary, or was the
 * dictionary simply not loaded yet when the card was opened on the live site?
 *
 * Usage: node verify/diag-dict-live.mjs
 */

import { spawn } from 'node:child_process';
import path from 'node:path';
import fs from 'node:fs';

const URL_TO_TEST = process.argv[2] || 'https://wangqirui429.github.io/essay-reader/';
const PORT = 9553;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const profile = path.join(process.env.TEMP, `er-dict-${Date.now()}`);
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
const failures = [];
ws.addEventListener('message', (ev) => {
  const m = JSON.parse(ev.data);
  if (m.method === 'Network.loadingFailed') failures.push(`${m.params.errorText} ${m.params.requestId}`);
  if (m.method === 'Network.responseReceived' && /\/data\//.test(m.params.response.url)) {
    failures.push(`DATA ${m.params.response.status} ${m.params.response.url.split('/data/')[1]}`);
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
const evalJs = async (expr) => {
  const r = await send('Runtime.evaluate', { expression: expr, returnByValue: true, awaitPromise: true });
  if (r.exceptionDetails) return { error: r.exceptionDetails.exception?.description || 'threw' };
  return r.result?.value;
};

await send('Page.enable');
await send('Runtime.enable');
await send('Network.enable');

const t0 = Date.now();
send('Page.navigate', { url: URL_TO_TEST });

// Poll the module's own state instead of guessing at timings.
for (const at of [2000, 5000, 8000, 12000, 20000]) {
  while (Date.now() - t0 < at) await sleep(200);
  const state = await evalJs(`(async () => {
    try {
      const m = await import('./js/dict-offline.js');
      const now = Date.now();
      const started = performance.now();
      const r = await m.lookupOffline('paragraph');
      return {
        isLoaded: m.isLoaded(),
        inMemory: m.dictSize(),
        core: m.coreProgress(),
        lookupMs: Math.round(performance.now() - started),
        found: !!(r && r.entry),
        glosses: r && r.entry ? r.entry.glosses.map((g) => g.text).slice(0, 2) : null,
        at: now - ${t0} + Date.now() - now,
      };
    } catch (e) { return { error: String(e && e.message || e) }; }
  })()`);
  console.log(`t≈${at}ms: ${JSON.stringify(state)}`);
}

console.log('--- data requests');
for (const f of failures.slice(0, 30)) console.log(f);

ws.close();
proc.kill();
try { fs.rmSync(profile, { recursive: true, force: true }); } catch { /* ignore */ }