/**
 * Capture the card with its redesigned close button on a phone-sized screen.
 * Usage: node verify/shot-close.mjs [url]
 */

import { spawn } from 'node:child_process';
import path from 'node:path';
import fs from 'node:fs';
import { fileURLToPath } from 'node:url';

const URL_TO_TEST = process.argv[2] || 'http://127.0.0.1:5180/';
const HERE = path.dirname(fileURLToPath(import.meta.url));
const PORT = 9611;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const profile = path.join(process.env.TEMP, `er-shot-${Date.now()}`);
const exe = 'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe';
const proc = spawn(exe, ['--headless=new', `--remote-debugging-port=${PORT}`, `--user-data-dir=${profile}`, '--no-first-run', 'about:blank'], { stdio: 'ignore' });

let version = null;
for (let i = 0; i < 80 && !version; i += 1) {
  await sleep(300);
  try { version = await (await fetch(`http://127.0.0.1:${PORT}/json/version`)).json(); } catch { /* retry */ }
}
if (!version) { console.error('browser failed'); proc.kill(); process.exit(1); }

const page = (await (await fetch(`http://127.0.0.1:${PORT}/json/list`)).json()).find((t) => t.type === 'page');
const ws = new WebSocket(page.webSocketDebuggerUrl);
await new Promise((res, rej) => { ws.addEventListener('open', res, { once: true }); ws.addEventListener('error', rej, { once: true }); });

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
  setTimeout(() => { if (pending.has(i)) { pending.delete(i); resolve({ timedOut: true }); } }, 15000);
});
const evalJs = async (expr) => {
  const r = await send('Runtime.evaluate', { expression: expr, awaitPromise: true, returnByValue: true });
  if (r?.timedOut) throw new Error('timed out');
  if (r.exceptionDetails) throw new Error(r.exceptionDetails.exception?.description || 'threw');
  return r.result.value;
};

await send('Page.enable');
await send('Emulation.setDeviceMetricsOverride', { width: 390, height: 844, deviceScaleFactor: 3, mobile: true });
send('Page.navigate', { url: URL_TO_TEST });
for (let i = 0; i < 100; i += 1) {
  await sleep(250);
  try { if (await evalJs(`!!document.getElementById('impSave')`)) break; } catch { /* swap */ }
}

await evalJs(`(() => {
  document.getElementById('impText').value = 'A Slow Walk\\n\\nThe condemned man stepped aside to avoid a puddle, while the hangman waited beside the gallows. Nobody spoke.\\n\\nThe warders tightened their grip on his bound arms and the rope hung still above them.';
  document.getElementById('impSave').click();
})()`);
for (let i = 0; i < 60; i += 1) {
  await sleep(200);
  if (await evalJs(`document.querySelectorAll('.w').length > 0`)) break;
}
await sleep(600);

const pos = await evalJs(`(() => {
  const w = [...document.querySelectorAll('.w')].find(x => x.dataset.w === 'gallows');
  w.scrollIntoView({ block: 'center' });
  const r = w.getBoundingClientRect();
  return { x: r.left + r.width / 2, y: r.top + r.height / 2 };
})()`);
await send('Input.dispatchTouchEvent', { type: 'touchStart', touchPoints: [{ x: pos.x, y: pos.y, radiusX: 12, radiusY: 12, force: 1, id: 1 }] });
await sleep(45);
await send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] });
for (let i = 0; i < 80; i += 1) {
  await sleep(150);
  if (await evalJs(`!!document.querySelector('.card .card__zh')`)) break;
}
await sleep(500);

const shot = await send('Page.captureScreenshot', { format: 'png' });
if (shot?.data) {
  const dir = path.join(HERE, 'shots');
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, '25-close-button.png'), Buffer.from(shot.data, 'base64'));
  console.log('shot saved');
}

ws.close();
proc.kill('SIGTERM');
await sleep(500);
try { if (proc.exitCode === null) proc.kill('SIGKILL'); } catch { /* ignore */ }
try { fs.rmSync(profile, { recursive: true, force: true }); } catch { /* ignore */ }
