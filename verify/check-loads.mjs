/**
 * Is the new Chinese UI merely slow to settle, or genuinely broken?
 *
 * Loads the page the way a person would (a real browser window, no CDP tricks)
 * and reports what it sees, so the answer does not depend on the test harness.
 *
 * Usage: node verify/check-loads.mjs [url]
 */

import { spawn } from 'node:child_process';
import path from 'node:path';
import fs from 'node:fs';
import { fileURLToPath } from 'node:url';

const URL_TO_TEST = process.argv[2] || 'http://127.0.0.1:5180/';
const PORT = 9531;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const profile = path.join(process.env.TEMP, `er-loads-${Date.now()}`);
const exe = 'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe';

// Attach to a blank page first, then navigate under observation.
const proc = spawn(exe, ['--headless=new', `--remote-debugging-port=${PORT}`, `--user-data-dir=${profile}`, '--no-first-run', 'about:blank'], { stdio: 'ignore' });

let version = null;
for (let i = 0; i < 100 && !version; i += 1) {
  await sleep(300);
  try { version = await (await fetch(`http://127.0.0.1:${PORT}/json/version`)).json(); } catch { /* retry */ }
}
if (!version) { console.error('browser failed to start'); proc.kill(); process.exit(1); }

const page = (await (await fetch(`http://127.0.0.1:${PORT}/json/list`)).json()).find((t) => t.type === 'page');
const ws = new WebSocket(page.webSocketDebuggerUrl);
await new Promise((res, rej) => { ws.addEventListener('open', res, { once: true }); ws.addEventListener('error', rej, { once: true }); });

let id = 0;
const pending = new Map();
const log = [];
ws.addEventListener('message', (ev) => {
  const m = JSON.parse(ev.data);
  if (m.method === 'Page.loadEventFired') log.push('load event fired');
  if (m.method === 'Page.domContentEventFired') log.push('DOMContentLoaded');
  if (m.method === 'Runtime.exceptionThrown') {
    log.push(`EXCEPTION: ${m.params.exceptionDetails.exception?.description || m.params.exceptionDetails.text}`);
  }
  if (m.method === 'Runtime.consoleAPICalled') {
    log.push(`console.${m.params.type}: ${m.params.args.map((a) => a.description || a.value || a.type).join(' ')}`);
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

await send('Page.enable');
await send('Runtime.enable');

console.log(`opening ${URL_TO_TEST}`);
const t0 = Date.now();
send('Page.navigate', { url: URL_TO_TEST });
await sleep(6000);

// Now ask the page questions, one at a time, tolerating a dead context.
for (const [label, expr] of [
  ['readyState', 'document.readyState'],
  ['title', 'document.title'],
  ['lang', 'document.documentElement.lang'],
  ['brand', "document.querySelector('.brand__text')?.textContent || '(missing)'"],
  ['hero', "document.querySelector('.hero__title')?.textContent?.slice(0,20) || '(missing)'"],
  ['nav', "[...document.querySelectorAll('.nav a')].map(a=>a.textContent.trim()).join(' | ') || '(missing)'"],
  ['buttons', "[...document.querySelectorAll('#impSave, #impSample')].map(b=>b.textContent.trim()).join(' | ') || '(missing)'"],
  ['swControlled', "String(!!navigator.serviceWorker.controller)"],
  ['dictWords', "(async()=>{const m=await import('./js/dict-offline.js'); return m.dictSize()})()"],
]) {
  const t = Date.now();
  const res = await send('Runtime.evaluate', { expression: expr, awaitPromise: true, returnByValue: true });
  if (res.timedOut) {
    console.log(`  ${label.padEnd(14)} TIMED OUT (${Date.now() - t}ms)`);
  } else if (res.exceptionDetails) {
    console.log(`  ${label.padEnd(14)} THREW: ${res.exceptionDetails.exception?.description || res.exceptionDetails.text}`);
  } else {
    console.log(`  ${label.padEnd(14)} ${JSON.stringify(res.result.value)} (${Date.now() - t}ms)`);
  }
}

console.log(`\ntotal elapsed: ${((Date.now() - t0) / 1000).toFixed(1)}s`);
console.log('\nbrowser log:');
console.log(log.length ? log.join('\n') : '(empty)');

// A visual check that does not depend on CDP timing.
const shot = await send('Page.captureScreenshot', { format: 'png' });
if (shot?.data) {
  const here = path.dirname(fileURLToPath(import.meta.url));
  const out = path.join(here, 'shots', '23-loads-check.png');
  fs.mkdirSync(path.dirname(out), { recursive: true });
  fs.writeFileSync(out, Buffer.from(shot.data, 'base64'));
  console.log(`\nscreenshot: ${out}`);
}

ws.close();
proc.kill('SIGTERM');
await sleep(500);
try { if (proc.exitCode === null) proc.kill('SIGKILL'); } catch { /* ignore */ }
try { fs.rmSync(profile, { recursive: true, force: true }); } catch { /* ignore */ }
