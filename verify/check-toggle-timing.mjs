/**
 * The guard that stops impatient double-taps from closing a card must not stop
 * a deliberate second tap from closing it.
 *
 * A reader who has read the meaning and wants the card gone taps the word
 * again — usually well after the guard window. Both behaviours are checked here
 * so a future tweak cannot trade one for the other.
 *
 * Usage: node verify/check-toggle-timing.mjs [url]
 */

import { spawn } from 'node:child_process';
import path from 'node:path';
import fs from 'node:fs';

const URL_TO_TEST = process.argv[2] || 'http://127.0.0.1:5180/';
const PORT = 9561;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const results = [];
const check = (name, ok, detail = '') => {
  results.push({ name, ok });
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? ` — ${detail}` : ''}`);
};

const profile = path.join(process.env.TEMP, `er-toggle-${Date.now()}`);
const exe = 'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe';
const proc = spawn(exe, ['--headless=new', `--remote-debugging-port=${PORT}`, `--user-data-dir=${profile}`, '--no-first-run', 'about:blank'], { stdio: 'ignore' });

let version = null;
for (let i = 0; i < 100 && !version; i += 1) {
  await sleep(300);
  try { version = await (await fetch(`http://127.0.0.1:${PORT}/json/version`)).json(); } catch { /* retry */ }
}
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
const send = (method, params = {}, timeoutMs = 20000) => new Promise((resolve) => {
  const i = ++id;
  pending.set(i, resolve);
  ws.send(JSON.stringify({ id: i, method, params }));
  setTimeout(() => { if (pending.has(i)) { pending.delete(i); resolve({ timedOut: true }); } }, timeoutMs);
});
const evalJs = async (expr) => {
  const r = await send('Runtime.evaluate', { expression: expr, awaitPromise: true, returnByValue: true });
  if (r?.timedOut) throw new Error('timed out');
  if (r.exceptionDetails) throw new Error(r.exceptionDetails.exception?.description || 'threw');
  return r.result.value;
};

const tap = async (x, y) => {
  await send('Input.dispatchTouchEvent', { type: 'touchStart', touchPoints: [{ x, y, radiusX: 12, radiusY: 12, force: 1, id: 1 }] });
  await sleep(35);
  await send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] });
};

await send('Page.enable');
await send('Runtime.enable');
await send('Emulation.setDeviceMetricsOverride', { width: 390, height: 844, deviceScaleFactor: 3, mobile: true });
await send('Emulation.setTouchEmulationEnabled', { enabled: true, maxTouchPoints: 5 });

send('Page.navigate', { url: URL_TO_TEST });
for (let i = 0; i < 120; i += 1) {
  await sleep(250);
  try { if (await evalJs(`!!document.getElementById('impSave')`)) break; } catch { /* swap */ }
}

await evalJs(`(() => {
  document.getElementById('impTitle').value = 'Toggle Timing';
  document.getElementById('impText').value = 'A Slow Walk\\n\\nThe condemned man stepped aside to avoid a puddle, while the hangman waited beside the gallows. Nobody spoke.\\n\\nThe warders tightened their grip on his bound arms and the rope hung still above them.';
  document.getElementById('impSave').click();
})()`);
for (let i = 0; i < 80; i += 1) {
  await sleep(200);
  if (await evalJs(`document.querySelectorAll('.w').length > 0`)) break;
}
await sleep(600);

const wordPos = await evalJs(`(() => {
  const w = [...document.querySelectorAll('.w')].find(x => x.dataset.w === 'gallows');
  w.scrollIntoView({ block: 'center' });
  const r = w.getBoundingClientRect();
  return { x: r.left + r.width / 2, y: r.top + r.height / 2 };
})()`);

const cardCount = () => evalJs(`document.querySelectorAll('.card').length`);

/* 1 — an impatient second tap keeps the card open */
await tap(wordPos.x, wordPos.y);
await sleep(250);
const afterFirst = await cardCount();
await tap(wordPos.x, wordPos.y);   // ~250 ms later: inside the guard window
await sleep(500);
const afterFastSecond = await cardCount();
check('a fast second tap does not close the card', afterFirst === 1 && afterFastSecond === 1, `${afterFirst} -> ${afterFastSecond}`);

/* 2 — a deliberate tap after reading does close it */
await sleep(1200);                 // past the guard window
await tap(wordPos.x, wordPos.y);
await sleep(600);
const afterDeliberate = await cardCount();
check('a deliberate second tap still closes the card', afterDeliberate === 0, `cards=${afterDeliberate}`);

/* 3 — the close button works immediately, with no guard */
await tap(wordPos.x, wordPos.y);
await sleep(400);
const reopened = await cardCount();
const closePos = await evalJs(`(() => {
  const b = document.querySelector('.card__close');
  if (!b) return null;
  const r = b.getBoundingClientRect();
  return { x: r.left + r.width / 2, y: r.top + r.height / 2 };
})()`);
await tap(closePos.x, closePos.y);
await sleep(400);
const afterCloseBtn = await cardCount();
check('the close button is not affected by the guard', reopened === 1 && afterCloseBtn === 0, `${reopened} -> ${afterCloseBtn}`);

/* 4 — three rapid taps leave exactly one card open, not none */
await tap(wordPos.x, wordPos.y);
await sleep(120);
await tap(wordPos.x, wordPos.y);
await sleep(120);
await tap(wordPos.x, wordPos.y);
await sleep(900);
const afterTriple = await cardCount();
check('three rapid taps leave the card open', afterTriple === 1, `cards=${afterTriple}`);

console.log(`\n${results.filter((r) => r.ok).length}/${results.length} checks passed`);
ws.close();
proc.kill('SIGTERM');
await sleep(500);
try { if (proc.exitCode === null) proc.kill('SIGKILL'); } catch { /* ignore */ }
try { fs.rmSync(profile, { recursive: true, force: true }); } catch { /* ignore */ }
process.exit(results.every((r) => r.ok) ? 0 : 1);
