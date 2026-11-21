/**
 * Find out WHY a tap that visibly lands still does nothing.
 *
 * A clean, motionless tap works in every test. A real finger does not behave
 * like that: it drifts a few pixels, and the browser may be waiting to see if a
 * second tap arrives (double-tap zoom). Both turn a tap into a scroll or a zoom,
 * and the click handler never runs — which is exactly "I tapped it and nothing
 * happened, so I tapped again".
 *
 * Usage: node verify/diag-taps.mjs [url]
 */

import { spawn } from 'node:child_process';
import path from 'node:path';
import fs from 'node:fs';

const URL_TO_TEST = process.argv[2] || 'http://127.0.0.1:5180/';
const PORT = 9551;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const profile = path.join(process.env.TEMP, `er-tapdiag-${Date.now()}`);
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

const touchStart = (x, y) => send('Input.dispatchTouchEvent', { type: 'touchStart', touchPoints: [{ x, y, radiusX: 12, radiusY: 12, force: 1, id: 1 }] });
const touchMove = (x, y) => send('Input.dispatchTouchEvent', { type: 'touchMove', touchPoints: [{ x, y, radiusX: 12, radiusY: 12, force: 1, id: 1 }] });
const touchEnd = () => send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] });

await send('Page.enable');
await send('Runtime.enable');
await send('Emulation.setDeviceMetricsOverride', { width: 390, height: 844, deviceScaleFactor: 3, mobile: true });
await send('Emulation.setTouchEmulationEnabled', { enabled: true, maxTouchPoints: 5 });

send('Page.navigate', { url: URL_TO_TEST });
for (let i = 0; i < 120; i += 1) {
  await sleep(250);
  try { if (await evalJs(`!!document.getElementById('impSave')`)) break; } catch { /* swap */ }
}

// Instrument: record what the page actually receives for each gesture.
await evalJs(`(() => {
  window.__events = [];
  const log = (type) => (e) => window.__events.push(type + (e.target?.className ? ':' + String(e.target.className).split(' ')[0] : ''));
  for (const type of ['touchstart','touchmove','touchend','pointerdown','pointerup','click']) {
    document.addEventListener(type, log(type), true);
  }
  window.__reset = () => { window.__events = []; };
  return true;
})()`);

await evalJs(`(() => {
  document.getElementById('impTitle').value = 'Tap Diagnosis';
  document.getElementById('impText').value = 'A Slow Walk\\n\\nThe condemned man stepped aside to avoid a puddle, while the hangman waited beside the gallows. Nobody spoke.\\n\\nThe warders tightened their grip on his bound arms and the rope hung still above them.';
  document.getElementById('impSave').click();
})()`);
for (let i = 0; i < 80; i += 1) {
  await sleep(200);
  if (await evalJs(`document.querySelectorAll('.w').length > 0`)) break;
}
await sleep(800);

const word = await evalJs(`(() => {
  const w = [...document.querySelectorAll('.w')].find(x => x.dataset.w === 'gallows');
  w.scrollIntoView({ block: 'center' });
  const r = w.getBoundingClientRect();
  return { x: r.left + r.width / 2, y: r.top + r.height / 2 };
})()`);

/* ---------------------------------------------------------------- case A --- */

// A perfectly still tap: the ideal case every automated test uses.
await evalJs('window.__reset()');
await touchStart(word.x, word.y);
await sleep(30);
await touchEnd();
await sleep(700);
const caseA = await evalJs(`({ events: window.__events.slice(), cards: document.querySelectorAll('.card').length })`);
console.log('A. still tap          ->', caseA.cards > 0 ? 'card OPENED' : 'no card');
console.log('   events:', caseA.events.join(', '));

// Close it before the next case.
await evalJs(`document.querySelector('.card__close')?.click()`);
await sleep(400);

/* ---------------------------------------------------------------- case B --- */

// A tap with the slight finger drift that real hands produce (~6px).
await evalJs('window.__reset()');
await touchStart(word.x, word.y);
await sleep(25);
await touchMove(word.x + 3, word.y + 2);
await touchMove(word.x + 5, word.y + 4);
await sleep(25);
await touchEnd();
await sleep(700);
const caseB = await evalJs(`({ events: window.__events.slice(), cards: document.querySelectorAll('.card').length, scrollY: Math.round(window.scrollY) })`);
console.log('B. tap with 6px drift ->', caseB.cards > 0 ? 'card OPENED' : 'NO CARD  <-- dropped');
console.log('   events:', caseB.events.join(', '));

await evalJs(`document.querySelector('.card__close')?.click()`);
await sleep(300);

/* ---------------------------------------------------------------- case C --- */

// Two quick taps: the first opens, the second must not zoom the page instead.
// With touch-action:auto the browser may treat this as double-tap-zoom.
const beforeZoom = await evalJs(`window.visualViewport ? window.visualViewport.scale : 1`);
await evalJs('window.__reset()');
await touchStart(word.x, word.y);
await sleep(30);
await touchEnd();
await sleep(120);                        // fast second tap, well under 300 ms
await touchStart(word.x, word.y);
await sleep(30);
await touchEnd();
await sleep(900);
const caseC = await evalJs(`({
  events: window.__events.slice(),
  cards: document.querySelectorAll('.card').length,
  scale: window.visualViewport ? window.visualViewport.scale : 1
})`);
console.log('C. two quick taps     -> cards:', caseC.cards, '| zoom scale:', caseC.scale, `(was ${beforeZoom})`);
console.log('   events:', caseC.events.join(', '));

/* ---------------------------------------------------------------- case D --- */

// Tap the card's own body: on a phone this is where "tapping the card" lands.
await evalJs(`document.querySelector('.card__close')?.click()`);
await sleep(300);
await touchStart(word.x, word.y);
await sleep(30);
await touchEnd();
for (let i = 0; i < 60; i += 1) {
  await sleep(150);
  if (await evalJs(`!!document.querySelector('.card .card__zh')`)) break;
}

const cardBody = await evalJs(`(() => {
  const c = document.querySelector('.card');
  if (!c) return null;
  const body = c.querySelector('.card__body') || c;
  const r = body.getBoundingClientRect();
  return { x: r.left + r.width / 2, y: r.top + Math.min(r.height / 2, 40) };
})()`);

if (cardBody) {
  await evalJs('window.__reset()');
  await touchStart(cardBody.x, cardBody.y);
  await sleep(30);
  await touchEnd();
  await sleep(600);
  const caseD = await evalJs(`({ events: window.__events.slice(), cards: document.querySelectorAll('.card').length })`);
  console.log('D. tap inside card    -> cards still:', caseD.cards, '(1 means it survived)');
  console.log('   events:', caseD.events.join(', '));
}

/* ---------------------------------------------------------------- summary --- */

const summary = await evalJs(`(() => {
  const w = [...document.querySelectorAll('.w')].find(x => x.dataset.w === 'gallows');
  const cs = getComputedStyle(w);
  const para = w.closest('.para');
  return {
    wordTouchAction: cs.touchAction,
    paraTouchAction: para ? getComputedStyle(para).touchAction : null,
    wordUserSelect: cs.userSelect || cs.webkitUserSelect,
    viewportMeta: document.querySelector('meta[name=viewport]')?.getAttribute('content') || '',
    canDoubleTapZoom: !/user-scalable\\s*=\\s*no|maximum-scale\\s*=\\s*1/.test(document.querySelector('meta[name=viewport]')?.getAttribute('content') || '')
  };
})()`);
console.log('\ncomputed:', JSON.stringify(summary, null, 1));

ws.close();
proc.kill('SIGTERM');
await sleep(500);
try { if (proc.exitCode === null) proc.kill('SIGKILL'); } catch { /* ignore */ }
try { fs.rmSync(profile, { recursive: true, force: true }); } catch { /* ignore */ }
