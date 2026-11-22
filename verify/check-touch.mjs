/**
 * Reproduce "I have to tap the card many times on a phone".
 *
 * Uses CDP touch emulation (Input.dispatchTouchEvent), not mouse events, because
 * the complaint is specific to touch. Two failure modes are measured:
 *
 *   1. Tapping a WORD with `touch` — does the card open first try?
 *   2. Tapping the card's CLOSE button — does it close first try?
 *
 * Usage: node verify/check-touch.mjs [url]
 */

import { spawn } from 'node:child_process';
import path from 'node:path';
import fs from 'node:fs';
import { fileURLToPath } from 'node:url';

const URL_TO_TEST = process.argv[2] || 'http://127.0.0.1:5180/';
const HERE = path.dirname(fileURLToPath(import.meta.url));
const PORT = 9541;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const results = [];
const check = (name, ok, detail = '') => {
  results.push({ name, ok });
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? ` — ${detail}` : ''}`);
};

const profile = path.join(process.env.TEMP, `er-touch-${Date.now()}`);
const exe = 'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe';
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
  if (r?.timedOut) throw new Error('evaluate timed out');
  if (r.exceptionDetails) throw new Error(r.exceptionDetails.exception?.description || 'threw');
  return r.result.value;
};

/** One finger tap, exactly as a phone sends it. */
async function tap(x, y) {
  await send('Input.dispatchTouchEvent', {
    type: 'touchStart',
    touchPoints: [{ x, y, radiusX: 12, radiusY: 12, force: 1, id: 1 }],
  });
  await sleep(40);
  await send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] });
}

async function tapSelector(selector) {
  const box = await evalJs(`(() => {
    const el = document.querySelector(${JSON.stringify(selector)});
    if (!el) return null;
    el.scrollIntoView({ block: 'center' });
    const r = el.getBoundingClientRect();
    return { x: r.left + r.width / 2, y: r.top + r.height / 2, w: Math.round(r.width), h: Math.round(r.height) };
  })()`);
  if (!box) throw new Error(`missing ${selector}`);
  await tap(box.x, box.y);
  return box;
}

await send('Page.enable');
await send('Runtime.enable');

// A phone: touch capability plus a small viewport. Both matter — the 300 ms
// tap delay only exists when the browser thinks a double-tap zoom is possible.
await send('Emulation.setDeviceMetricsOverride', { width: 390, height: 844, deviceScaleFactor: 3, mobile: true });
await send('Emulation.setTouchEmulationEnabled', { enabled: true, maxTouchPoints: 5 });

send('Page.navigate', { url: URL_TO_TEST });
for (let i = 0; i < 120; i += 1) {
  await sleep(250);
  try {
    if (await evalJs(`!!document.getElementById('impSave')`)) break;
  } catch { /* context swapping */ }
}

/* ------------------------------------------------------ import an essay --- */

await evalJs(`(() => {
  document.getElementById('impTitle').value = '触摸测试';
  document.getElementById('impText').value = 'A Slow Walk\\n\\nThe condemned man stepped aside to avoid a puddle, while the hangman waited beside the gallows. Nobody spoke.\\n\\nThe warders tightened their grip on his bound arms and the rope hung still above them.';
  document.getElementById('impSave').click();
})()`);
for (let i = 0; i < 80; i += 1) {
  await sleep(200);
  if (await evalJs(`document.querySelectorAll('.w').length > 0`)) break;
}

/* -------------------------------- how big is a word's touch target? ------- */

const targets = await evalJs(`(() => {
  const words = [...document.querySelectorAll('.w')].slice(0, 40);
  const sizes = words.map(w => { const r = w.getBoundingClientRect(); return { w: r.width, h: r.height }; });
  const small = sizes.filter(s => s.h < 24).length;
  const tiny = sizes.filter(s => s.w < 16).length;
  return {
    sampled: sizes.length,
    medianHeight: sizes.length ? Math.round(sizes.map(s => s.h).sort((a,b)=>a-b)[Math.floor(sizes.length/2)]) : 0,
    medianWidth: sizes.length ? Math.round(sizes.map(s => s.w).sort((a,b)=>a-b)[Math.floor(sizes.length/2)]) : 0,
    shorterThan24px: small,
    narrowerThan16px: tiny,
    touchAction: getComputedStyle(words[0]).touchAction,
    tapHighlight: getComputedStyle(words[0]).webkitTapHighlightColor
  };
})()`);
console.log('\nword target metrics:', JSON.stringify(targets));
check('a word is at least 24px tall to tap comfortably', targets.medianHeight >= 24, `median height ${targets.medianHeight}px, ${targets.shorterThan24px}/${targets.sampled} under 24px`);
check('words declare touch-action: manipulation (removes the double-tap wait)', targets.touchAction === 'manipulation', `touch-action=${targets.touchAction}`);

/* ------------------------------------------- tap a word once, does it open? */

const wordBox = await evalJs(`(() => {
  const w = [...document.querySelectorAll('.w')].find(x => x.dataset.w === 'gallows');
  w.scrollIntoView({ block: 'center' });
  const r = w.getBoundingClientRect();
  return { x: r.left + r.width / 2, y: r.top + r.height / 2, w: Math.round(r.width), h: Math.round(r.height) };
})()`);
console.log(`tapping the word "gallows" at ${Math.round(wordBox.x)},${Math.round(wordBox.y)} (${wordBox.w}x${wordBox.h})`);

const t0 = Date.now();
await tap(wordBox.x, wordBox.y);
let openedAfter = null;
for (let i = 0; i < 60; i += 1) {
  await sleep(100);
  if (await evalJs(`document.querySelectorAll('.card').length > 0`)) { openedAfter = Date.now() - t0; break; }
}
check('one tap on a word opens its card', openedAfter !== null, openedAfter === null ? 'never opened' : `${openedAfter} ms`);

// Let the meaning load.
for (let i = 0; i < 100; i += 1) {
  await sleep(150);
  if (await evalJs(`!!document.querySelector('.card .card__zh')`)) break;
}

/* ------------------------------------ tap the close button once, does it close? */

const closeInfo = await evalJs(`(() => {
  const btn = document.querySelector('.card__close');
  if (!btn) return null;
  const r = btn.getBoundingClientRect();
  return { x: r.left + r.width / 2, y: r.top + r.height / 2, w: Math.round(r.width), h: Math.round(r.height) };
})()`);
console.log(`tapping close at ${Math.round(closeInfo.x)},${Math.round(closeInfo.y)} (${closeInfo.w}x${closeInfo.h})`);
check('the close button meets the 44px touch-target guideline', closeInfo.w >= 44 && closeInfo.h >= 44, `${closeInfo.w}x${closeInfo.h}`);

await tap(closeInfo.x, closeInfo.y);
let closedAfter = null;
{
  const t = Date.now();
  for (let i = 0; i < 40; i += 1) {
    await sleep(100);
    if (await evalJs(`document.querySelectorAll('.card').length === 0`)) { closedAfter = Date.now() - t; break; }
  }
}
check('one tap on close removes the card', closedAfter !== null, closedAfter === null ? 'still open' : `${closedAfter} ms`);

/* --------------------- count how many taps it takes when aimed at the edge --- */

// A tap 3px inside the card's own edge is a realistic sloppy tap.
await tap(wordBox.x, wordBox.y);
for (let i = 0; i < 60; i += 1) {
  await sleep(100);
  if (await evalJs(`document.querySelectorAll('.card').length > 0`)) break;
}
await sleep(1200);

const edge = await evalJs(`(() => {
  const btn = document.querySelector('.card__close');
  if (!btn) return null;
  const r = btn.getBoundingClientRect();
  return { x: r.right - 3, y: r.top + r.height / 2 };
})()`);
await tap(edge.x, edge.y);
let edgeClosed = false;
for (let i = 0; i < 30; i += 1) {
  await sleep(100);
  if (await evalJs(`document.querySelectorAll('.card').length === 0`)) { edgeClosed = true; break; }
}
check('a slightly-off tap near the button edge still works', edgeClosed, edgeClosed ? 'closed' : 'missed');

/* ---------------------------------------------------------------- report --- */

const shot = await send('Page.captureScreenshot', { format: 'png' });
if (shot?.data) {
  const dir = path.join(HERE, 'shots');
  fs.mkdirSync(dir, { recursive: true });
  const file = path.join(dir, '24-touch-test.png');
  fs.writeFileSync(file, Buffer.from(shot.data, 'base64'));
  console.log(`\nscreenshot: ${file}`);
}

console.log(`\n${results.filter((r) => r.ok).length}/${results.length} checks passed`);
ws.close();
proc.kill('SIGTERM');
await sleep(500);
try { if (proc.exitCode === null) proc.kill('SIGKILL'); } catch { /* ignore */ }
try { fs.rmSync(profile, { recursive: true, force: true }); } catch { /* ignore */ }
process.exit(results.every((r) => r.ok) ? 0 : 1);
