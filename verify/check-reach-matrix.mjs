/**
 * Reachability of the candidate backends, measured in a real browser.
 *
 * curl uses the system resolver, which this network poisons for some hosts, and
 * the browser may resolve differently and negotiate TLS differently. Since the
 * app is a browser app, only the browser's answer decides anything.
 *
 * Usage: node verify/check-reach-matrix.mjs
 */

import { spawn } from 'node:child_process';
import path from 'node:path';

const PORT = 9567;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const profile = path.join(process.env.TEMP, `er-matrix-${Date.now()}`);
const exe = 'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe';

const TARGETS = [
  ['supabase project', 'https://ejnrmtkcigjwbubcxbgy.supabase.co/auth/v1/health'],
  ['supabase api', 'https://api.supabase.com/v1/projects'],
  ['github web', 'https://github.com'],
  ['github web (www)', 'https://github.com/settings/tokens'],
  ['github api', 'https://api.github.com'],
  ['gist web', 'https://gist.github.com'],
  ['appwrite cloud', 'https://cloud.appwrite.io/v1/health'],
  ['upstash console', 'https://console.upstash.com'],
  ['jsonbin', 'https://api.jsonbin.io/v3'],
  ['npoint', 'https://api.npoint.io'],
];

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
console.log('browser:', version.Browser, '\n');

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

await send('Page.enable');
await send('Runtime.enable');

// A real HTTPS origin, so mixed-content and CORS rules behave as they would
// for the deployed app.
await send('Page.navigate', { url: 'https://wangqirui429.github.io/essay-reader/' });
await sleep(3500);

for (const [label, url] of TARGETS) {
  // `no-cors` proves the network path works without requiring the target to
  // send CORS headers; a rejection means DNS/TLS/HTTP failed outright.
  const r = await send('Runtime.evaluate', {
    expression: `fetch(${JSON.stringify(url)}, { mode: 'no-cors', cache: 'no-store' })
      .then(() => 'reachable')
      .catch((e) => 'FAILED: ' + (e && e.message || e))`,
    awaitPromise: true,
    returnByValue: true,
  });
  const value = r?.result?.value ?? (r?.timedOut ? 'TIMEOUT' : 'unknown');
  console.log(`${String(value).padEnd(28)} ${label.padEnd(20)} ${url}`);
}

ws.close();
proc.kill();