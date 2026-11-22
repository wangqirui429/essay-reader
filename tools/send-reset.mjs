/**
 * Ask the live site to mail a password-reset link to one address.
 *
 * Used after the recovery template changed, so the reader has a mail whose link
 * points at this site (…/#type=recovery&token_hash=…) instead of the old
 * template that bounced through the project host.
 *
 * Usage:
 *   node tools/send-reset.mjs someone@example.com
 */

import { spawn } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';

const EMAIL = process.argv[2];
if (!EMAIL) {
  console.error('usage: node tools/send-reset.mjs <email>');
  process.exit(1);
}

const SITE = 'https://wangqirui429.github.io/essay-reader/';
const PORT = 9568;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const profile = path.join(process.env.TEMP, `er-reset-${Date.now()}`);
const browser = spawn(
  'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe',
  ['--headless=new', `--remote-debugging-port=${PORT}`, `--user-data-dir=${profile}`,
    '--no-first-run', 'about:blank'],
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

try {
  await send('Page.navigate', { url: `${SITE}?tool=reset` });
  // Wait for the app to be ready: the account panel is revealed by boot().
  for (let i = 0; i < 100; i += 1) {
    await sleep(400);
    const booted = await evaluate("Boolean(document.getElementById('authForm') && document.getElementById('authForm').hidden === false)");
    if (booted) break;
  }

  const result = await evaluate(`(async () => {
    const config = await import('./js/supabase-config.js');
    const response = await fetch(config.SUPABASE_URL + '/auth/v1/recover', {
      method: 'POST',
      headers: { apikey: config.SUPABASE_ANON_KEY, 'Content-Type': 'application/json' },
      body: JSON.stringify({ email: ${JSON.stringify(EMAIL)}, redirect_to: ${JSON.stringify(SITE)} })
    });
    return response.status + ' ' + (await response.text()).slice(0, 120);
  })()`);

  console.log('recover:', result);
  console.log(String(result).startsWith('200')
    ? 'a fresh reset mail was requested'
    : 'the request did not succeed');
} finally {
  ws.close();
  browser.kill();
  try { fs.rmSync(profile, { recursive: true, force: true }); } catch { /* ignore */ }
}