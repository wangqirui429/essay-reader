/**
 * One-off diagnostic: why does signing up from the settings panel not land?
 * Prints the panel state, the error line, any console exception, and every
 * request the mock received.
 *
 * Usage: node verify/diag-signup.mjs
 */

import { spawn } from 'node:child_process';
import path from 'node:path';
import fs from 'node:fs';
import { startMockSupabase } from './mock-supabase.mjs';

const PORT = 9663;
const APP_PORT = 5213;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const profile = path.join(process.env.TEMP, `er-diag-${Date.now()}`);
const proc = spawn('C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe', [
  '--headless=new', `--remote-debugging-port=${PORT}`, `--user-data-dir=${profile}`,
  '--no-first-run', '--no-default-browser-check', 'about:blank',
], { stdio: 'ignore' });

let wsUrl = null;
for (let i = 0; i < 120 && !wsUrl; i += 1) {
  await sleep(250);
  try { wsUrl = (await (await fetch(`http://127.0.0.1:${PORT}/json/version`)).json()).webSocketDebuggerUrl; } catch { /* wait */ }
}
if (!wsUrl) throw new Error('Edge did not start');

const ws = new WebSocket(wsUrl);
await new Promise((res, rej) => { ws.addEventListener('open', res, { once: true }); ws.addEventListener('error', rej, { once: true }); });
let id = 0;
const pending = new Map();
const events = [];
ws.addEventListener('message', (ev) => {
  const m = JSON.parse(ev.data);
  if (m.method) { events.push(m); return; }
  const job = pending.get(m.id);
  if (job) { pending.delete(m.id); job(m.result); }
});
const send = (method, params = {}, timeoutMs = 15000) => new Promise((resolve) => {
  const i = ++id;
  pending.set(i, resolve);
  ws.send(JSON.stringify({ id: i, method, params }));
  setTimeout(() => { if (pending.has(i)) { pending.delete(i); resolve({ timedOut: true }); } }, timeoutMs);
});

const target = await send('Target.createTarget', { url: 'about:blank' });
const list = await (await fetch(`http://127.0.0.1:${PORT}/json/list`)).json();
const page = list.find((t) => t.id === target.targetId);
const pageWs = new WebSocket(page.webSocketDebuggerUrl);
await new Promise((res, rej) => { pageWs.addEventListener('open', res, { once: true }); pageWs.addEventListener('error', rej, { once: true }); });
const pagePending = new Map();
const pageEvents = [];
pageWs.addEventListener('message', (ev) => {
  const m = JSON.parse(ev.data);
  if (m.method) { pageEvents.push(m); return; }
  const job = pagePending.get(m.id);
  if (job) { pagePending.delete(m.id); job(m.result); }
});
const psend = (method, params = {}, timeoutMs = 15000) => new Promise((resolve) => {
  const i = ++id;
  pagePending.set(i, resolve);
  pageWs.send(JSON.stringify({ id: i, method, params }));
  setTimeout(() => { if (pagePending.has(i)) { pagePending.delete(i); resolve({ timedOut: true }); } }, timeoutMs);
});
const evalJs = async (expression) => {
  const r = await psend('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true });
  if (r?.exceptionDetails) return { error: r.exceptionDetails.exception?.description || 'threw' };
  return { value: r?.result?.value };
};

const mock = await startMockSupabase({ port: APP_PORT });

try {
  await psend('Page.enable');
  await psend('Runtime.enable');
  await psend('Log.enable');
  await psend('Page.navigate', { url: `http://127.0.0.1:${APP_PORT}/` });

  for (let i = 0; i < 80; i += 1) {
    const r = await evalJs(`document.getElementById('authForm') && document.getElementById('authForm').hidden === false`);
    if (r.value) break;
    await sleep(200);
  }

  console.log('config module: ', JSON.stringify(await evalJs(`import('./js/supabase-config.js').then(m => ({ url: m.SUPABASE_URL, table: m.STATE_TABLE })).catch(e => 'ERR ' + e.message)`)));
  console.log('before: ', JSON.stringify(await evalJs(`({
    formHidden: document.getElementById('authForm').hidden,
    submit: document.getElementById('btnSubmitAuth').textContent,
    configMissing: document.getElementById('authConfigMissing').hidden,
  })`)));

  await evalJs(`document.getElementById('btnAltMode').click()`);
  await sleep(200);
  console.log('after alt mode: ', JSON.stringify(await evalJs(`({
    submit: document.getElementById('btnSubmitAuth').textContent,
    formHidden: document.getElementById('authForm').hidden,
  })`)));

  await evalJs(`(() => {
    const form = document.getElementById('authForm');
    document.getElementById('authEmail').value = 'reader@example.com';
    document.getElementById('authPassword').value = 'password123';
    form.requestSubmit();
    return true;
  })()`);

  await sleep(4000);

  console.log('after submit: ', JSON.stringify(await evalJs(`({
    formHidden: document.getElementById('authForm').hidden,
    signedInHidden: document.getElementById('accountSignedIn').hidden,
    email: document.getElementById('accountEmail').textContent,
    error: document.getElementById('authError').textContent,
    errorHidden: document.getElementById('authError').hidden,
    info: document.getElementById('authInfo').textContent,
    submit: document.getElementById('btnSubmitAuth').textContent,
    session: localStorage.getItem('essay-reader:session'),
  })`), null, 2));

  console.log('mock requests:');
  for (const r of mock.log) console.log(`  ${r.method} ${r.path}${r.query}`);

  const consoleErrors = pageEvents
    .filter((e) => e.method === 'Runtime.consoleAPICalled' || e.method === 'Runtime.exceptionThrown' || e.method === 'Log.entryAdded')
    .map((e) => JSON.stringify(e.params).slice(0, 300));
  console.log('page events:');
  for (const line of consoleErrors.slice(-25)) console.log('  ' + line);
} finally {
  try { pageWs.close(); } catch { /* ignore */ }
  try { ws.close(); } catch { /* ignore */ }
  await mock.close();
  try { proc.kill('SIGTERM'); } catch { /* ignore */ }
  await sleep(500);
  try { if (proc.exitCode === null) proc.kill('SIGKILL'); } catch { /* ignore */ }
  try { fs.rmSync(profile, { recursive: true, force: true }); } catch { /* ignore */ }
}