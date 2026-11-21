/**
 * Test the hypothesis: a card placed near the top of the screen has its ✕
 * covered by the sticky top bar / toolbar, which sit at a higher z-index.
 *
 * A reader scrolling a long essay would see exactly this: tapping ✕ does
 * nothing because the tap lands on the sticky bar instead, and scrolling a
 * little first makes it work — "sometimes it takes many taps".
 *
 * Usage: node verify/diag-close-occlusion.mjs [url]
 */

import { spawn } from 'node:child_process';
import path from 'node:path';
import fs from 'node:fs';

const URL_TO_TEST = process.argv[2] || 'http://127.0.0.1:5180/';
const PORT = 9581;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const profile = path.join(process.env.TEMP, `er-occl-${Date.now()}`);
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
  await sleep(45);
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

// A long essay so a word can sit high on the screen after scrolling.
const longEssay = Array.from({ length: 8 }, () =>
  'The condemned man stepped aside to avoid a puddle, while the hangman waited beside the gallows and nobody in the yard spoke a single word about it.'
).join('\n\n');

await evalJs(`(() => {
  document.getElementById('impTitle').value = 'Occlusion Test';
  document.getElementById('impText').value = ${JSON.stringify(`Occlusion\n\n${longEssay}`)};
  document.getElementById('impSave').click();
})()`);
for (let i = 0; i < 80; i += 1) {
  await sleep(200);
  if (await evalJs(`document.querySelectorAll('.w').length > 0`)) break;
}
await sleep(800);

/** Stacking order and geometry around a card's close button. */
const probe = async () => evalJs(`(() => {
  const card = document.querySelector('.card');
  if (!card) return { error: 'no card' };
  const btn = card.querySelector('.card__close');
  const r = btn.getBoundingClientRect();
  const cx = r.left + r.width / 2;
  const cy = r.top + r.height / 2;
  const atPoint = document.elementFromPoint(cx, cy);
  const topbar = document.querySelector('.topbar');
  const toolbar = document.querySelector('.reader__toolbar');
  return {
    btnRect: { top: Math.round(r.top), bottom: Math.round(r.bottom), left: Math.round(r.left) },
    cardRect: { top: Math.round(card.getBoundingClientRect().top), height: Math.round(card.getBoundingClientRect().height) },
    tapPoint: { x: Math.round(cx), y: Math.round(cy) },
    elementAtTapPoint: atPoint ? (String(atPoint.className || '') || atPoint.tagName) : 'null',
    tapHitsCloseButton: !!(atPoint && atPoint.closest && atPoint.closest('.card__close')),
    topbarBottom: topbar ? Math.round(topbar.getBoundingClientRect().bottom) : null,
    toolbarBottom: toolbar ? Math.round(toolbar.getBoundingClientRect().bottom) : null,
    topbarZ: topbar ? getComputedStyle(topbar).zIndex : null,
    toolbarZ: toolbar ? getComputedStyle(toolbar).zIndex : null,
    layerZ: (() => { const l = document.querySelector('.card-layer'); return l ? getComputedStyle(l).zIndex : null; })(),
    cardZ: getComputedStyle(card).zIndex
  };
})()`);

console.log('=== case 1: card opened where the browser puts it ===');
await evalJs(`(() => {
  const w = [...document.querySelectorAll('.w')][20];
  w.scrollIntoView({ block: 'center' });
  return true;
})()`);
await sleep(300);
const target = await evalJs(`(() => {
  const w = [...document.querySelectorAll('.w')][20];
  const r = w.getBoundingClientRect();
  return { x: r.left + r.width / 2, y: r.top + r.height / 2, key: w.dataset.w };
})()`);
await tap(target.x, target.y);
for (let i = 0; i < 60; i += 1) { await sleep(150); if (await evalJs(`!!document.querySelector('.card .card__zh')`)) break; }
console.log(JSON.stringify(await probe(), null, 1));

console.log('\n=== case 2: force a card up under the sticky bars ===');
// Simulate the moment a reader taps a word while the page is scrolled so the
// card lands high on screen: move the card up by script, then test the button.
const moved = await evalJs(`(() => {
  const card = document.querySelector('.card');
  if (!card) return 'no card';
  const top = parseFloat(card.style.top) || 0;
  card.style.top = (top - 320) + 'px';   // push it well under the sticky bars
  const btn = card.querySelector('.card__close');
  const r = btn.getBoundingClientRect();
  return { newBtnTop: Math.round(r.top), btnCenterY: Math.round(r.top + r.height / 2) };
})()`);
console.log('moved card:', JSON.stringify(moved));
const p2 = await probe();
console.log(JSON.stringify(p2, null, 1));

if (p2.tapHitsCloseButton === false) {
  console.log('\n>>> CONFIRMED: the tap at the close button lands on:', p2.elementAtTapPoint);
} else {
  console.log('\n>>> at this offset the button is still reachable');
}

console.log('\n=== case 3: tap it anyway and see whether it closes ===');
await tap(p2.tapPoint.x, p2.tapPoint.y);
await sleep(700);
const after = await evalJs(`document.querySelectorAll('.card').length`);
console.log(`cards after tapping ✕: ${after} ${after === 0 ? '(closed)' : '(STILL OPEN — the bug)'}`);

ws.close();
proc.kill('SIGTERM');
await sleep(500);
try { if (proc.exitCode === null) proc.kill('SIGKILL'); } catch { /* ignore */ }
try { fs.rmSync(profile, { recursive: true, force: true }); } catch { /* ignore */ }
