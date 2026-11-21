/**
 * Test whether a card MOVES while it loads, which would swallow taps.
 *
 * The suspected sequence:
 *   1. Tap a word. A short "looking up…" card appears below the word.
 *   2. The reader starts moving a finger toward its ✕.
 *   3. The dictionary entry arrives, the card grows from ~60px to ~350px,
 *      `place()` re-decides there is no room below, and the card jumps ABOVE
 *      the word.
 *   4. The finger lands where the ✕ used to be — or on empty page — so no click
 *      reaches the button. The reader taps again. Sometimes several times.
 *
 * This script measures the card's position over time after opening, and whether
 * the close button moves while the entry is loading.
 *
 * Usage: node verify/diag-close-jump.mjs [url]
 */

import { spawn } from 'node:child_process';
import path from 'node:path';
import fs from 'node:fs';

const URL_TO_TEST = process.argv[2] || 'http://127.0.0.1:5180/';
const PORT = 9591;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const profile = path.join(process.env.TEMP, `er-jump-${Date.now()}`);
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

/** Press and hold without releasing, so we can see if the target moves. */
const touchDown = (x, y) => send('Input.dispatchTouchEvent', {
  type: 'touchStart',
  touchPoints: [{ x, y, radiusX: 12, radiusY: 12, force: 1, id: 1 }],
});
const touchUp = () => send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] });

await send('Page.enable');
await send('Runtime.enable');
await send('Emulation.setDeviceMetricsOverride', { width: 390, height: 844, deviceScaleFactor: 3, mobile: true });
await send('Emulation.setTouchEmulationEnabled', { enabled: true, maxTouchPoints: 5 });

send('Page.navigate', { url: URL_TO_TEST });
for (let i = 0; i < 120; i += 1) {
  await sleep(250);
  try { if (await evalJs(`!!document.getElementById('impSave')`)) break; } catch { /* swap */ }
}

// A fresh browser profile means the dictionary is not warm, which is the slow
// path the reader actually experiences. Do not warm it on purpose.
await evalJs(`(() => {
  document.getElementById('impTitle').value = 'Jump Test';
  document.getElementById('impText').value = 'A Slow Walk\\n\\nThe condemned man stepped aside to avoid a puddle, while the hangman waited beside the gallows. Nobody spoke about it at all.\\n\\nThe warders tightened their grip on his bound arms and the rope hung still above them.';
  document.getElementById('impSave').click();
})()`);
for (let i = 0; i < 80; i += 1) {
  await sleep(200);
  if (await evalJs(`document.querySelectorAll('.w').length > 0`)) break;
}
await sleep(600);

// Put the target word near the BOTTOM of the viewport. That is the arrangement
// where the card first fits below, then stops fitting once it grows.
const wordPos = await evalJs(`(() => {
  const w = [...document.querySelectorAll('.w')].find(x => x.dataset.w === 'gallows');
  w.scrollIntoView({ block: 'end' });
  const r = w.getBoundingClientRect();
  return { x: r.left + r.width / 2, y: r.top + r.height / 2, bottom: Math.round(r.bottom), vh: window.innerHeight };
})()`);
console.log(`word at y=${Math.round(wordPos.y)} (viewport height ${wordPos.vh}, word bottom ${wordPos.bottom})`);
console.log('the card must first appear below it, then grow, then possibly flip above.\n');

/* ---------------- sample the card geometry while it loads ---------------- */

await tap(wordPos.x, wordPos.y);

const samples = [];
for (let i = 0; i < 40; i += 1) {
  await sleep(100);
  const s = await evalJs(`(() => {
    const card = document.querySelector('.card');
    if (!card) return null;
    const btn = card.querySelector('.card__close');
    const cr = card.getBoundingClientRect();
    const br = btn ? btn.getBoundingClientRect() : null;
    return {
      t: Math.round(performance.now()),
      h: Math.round(cr.height),
      top: Math.round(cr.top),
      btnTop: br ? Math.round(br.top) : null,
      hasMeaning: !!card.querySelector('.card__zh')
    };
  })()`);
  if (s) samples.push(s);
  if (s?.hasMeaning && samples.length > 6) break;
}

const first = samples[0];
const last = samples[samples.length - 1];
console.log('first sample:', JSON.stringify(first));
console.log('last  sample:', JSON.stringify(last));

const heightGrowth = last.h - first.h;
const btnShift = Math.abs((last.btnTop ?? 0) - (first.btnTop ?? 0));
const cardFlipped = Math.sign(last.top - first.top) !== 0 && Math.abs(last.top - first.top) > 40;

console.log(`\nheight ${first.h}px -> ${last.h}px  (grew ${heightGrowth}px)`);
console.log(`close button top ${first.btnTop} -> ${last.btnTop}  (moved ${btnShift}px)`);
console.log(`card flipped to the other side: ${cardFlipped}`);

if (heightGrowth > 80 || btnShift > 40) {
  console.log('\n>>> CONFIRMED: the card resizes and moves while the entry loads.');
  console.log('    A finger already on the way to ✕ would land somewhere else.');
} else {
  console.log('\n>>> the card stayed put');
}

/* --------------- now the real failure: tap while it is still loading ------ */

console.log('\n=== tapping ✕ before the meaning arrives ===');
// Close whatever is open.
await evalJs(`(() => { document.querySelectorAll('.card__close').forEach(b => b.click()); return true; })()`);
await sleep(500);

// Open again and immediately aim at where the button was at that instant.
await tap(wordPos.x, wordPos.y);
await sleep(120);   // a quick, natural follow-up tap
const early = await evalJs(`(() => {
  const btn = document.querySelector('.card__close');
  if (!btn) return null;
  const r = btn.getBoundingClientRect();
  return { x: r.left + r.width / 2, y: r.top + r.height / 2 };
})()`);
if (early) {
  await tap(early.x, early.y);
  await sleep(900);
  const left = await evalJs(`document.querySelectorAll('.card').length`);
  console.log(`tapped ✕ at ${Math.round(early.x)},${Math.round(early.y)} shortly after opening`);
  console.log(`cards remaining: ${left}  ${left === 0 ? '(closed — fine)' : '(STILL OPEN — the tap was lost)'}`);
}

ws.close();
proc.kill('SIGTERM');
await sleep(500);
try { if (proc.exitCode === null) proc.kill('SIGKILL'); } catch { /* ignore */ }
try { fs.rmSync(profile, { recursive: true, force: true }); } catch { /* ignore */ }
