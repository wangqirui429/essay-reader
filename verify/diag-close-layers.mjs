/**
 * Instrument every layer of the close path on a phone-sized touch session.
 *
 * A tap on the ✕ has to survive four stages:
 *   1. touchstart/touchend reach the button          (touch layer)
 *   2. the browser synthesises a click                (browser layer)
 *   3. the click lands on the button, not a sibling   (hit-testing layer)
 *   4. the card's delegated handler runs and closes   (app layer)
 *
 * A failure at any stage looks identical to the reader — "the ✕ did nothing" —
 * so this records all four at once, over many taps, and reports the drops.
 *
 * Usage: node verify/diag-close-layers.mjs [url]
 */

import { spawn } from 'node:child_process';
import path from 'node:path';
import fs from 'node:fs';

const URL_TO_TEST = process.argv[2] || 'http://127.0.0.1:5180/';
const PORT = 9651;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const profile = path.join(process.env.TEMP, `er-layers-${Date.now()}`);
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
  await sleep(50);
  await send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] });
};

await send('Page.enable');
await send('Runtime.enable');
await send('Emulation.setDeviceMetricsOverride', { width: 390, height: 844, deviceScaleFactor: 3, mobile: true });
await send('Emulation.setTouchEmulationEnabled', { enabled: true, maxTouchPoints: 5 });

send('Page.navigate', { url: URL_TO_TEST });
let navReady = false;
for (let i = 0; i < 120 && !navReady; i += 1) {
  await sleep(250);
  try { navReady = await evalJs(`!!document.getElementById('impSave')`); } catch { /* swap */ }
}
if (!navReady) throw new Error('page never became ready');

await evalJs(`(() => {
  document.getElementById('impTitle').value = '层级诊断';
  document.getElementById('impText').value = 'A Slow Walk\\n\\nThe condemned man stepped aside to avoid a puddle, while the hangman waited beside the gallows. Nobody spoke about it.\\n\\nThe warders tightened their grip on his bound arms and the rope hung still above them.';
  document.getElementById('impSave').click();
})()`);
for (let i = 0; i < 80; i += 1) {
  await sleep(200);
  if (await evalJs(`document.querySelectorAll('.w').length > 0`)) break;
}
await sleep(700);

/* ------------------------------------------------------- full instrumentation */

await evalJs(`(() => {
  window.__trace = [];
  const stamp = (s) => window.__trace.push(s);
  // stage 1: touch events on the close button
  document.addEventListener('touchstart', (e) => {
    if (e.target.closest('.card__close')) stamp('1.touchstart@btn');
  }, true);
  document.addEventListener('touchend', (e) => {
    if (e.target.closest('.card__close')) stamp('1.touchend@btn');
  }, true);
  // stage 3: click and where it landed
  document.addEventListener('click', (e) => {
    const hit = e.target.closest('.card__close');
    stamp('2.click@' + (hit ? 'btn' : String(e.target.className || e.target.tagName).split(' ')[0]));
  }, true);
  // stage 4: the app handler actually closing
  const origRemove = Element.prototype.remove;
  document.addEventListener('cardclosing', () => stamp('4.appclosing'), true);
  window.__resetTrace = () => { window.__trace = []; };
  return true;
})()`);

/* ------------------------------------------------------- 20 tap repetitions */

let oneTapCloses = 0;
let zeroTaps = 0;
const drops = [];

for (let n = 1; n <= 20; n += 1) {
  // open a card on a fresh word each time
  const word = ['gallows', 'puddle', 'condemned', 'hangman', 'warders'][n % 5];
  const opened = await evalJs(`(async () => {
    const w = [...document.querySelectorAll('.w')].find(x => x.dataset.w === ${JSON.stringify(word)});
    if (!w) return false;
    document.querySelectorAll('.card__close').forEach(b => b.click());
    await new Promise(r => setTimeout(r, 300));
    w.scrollIntoView({ block: 'center' });
    const r = w.getBoundingClientRect();
    const t = { x: r.left + r.width / 2, y: r.top + r.height / 2 };
    window.__tapTarget = t;
    return true;
  })()`);
  if (!opened) continue;

  await evalJs(`(async () => {
    const w = window.__tapTarget;
    // dispatch touch on the word
    for (const type of ['touchStart','touchEnd']) {}
    return true;
  })()`);

  // tap the word through CDP
  const wt = await evalJs(`window.__tapTarget`);
  await tap(wt.x, wt.y);
  for (let i = 0; i < 60; i += 1) {
    await sleep(120);
    if (await evalJs(`!!document.querySelector('.card .card__zh')`)) break;
  }
  await sleep(250);

  const state = await evalJs(`(() => {
    const btn = document.querySelector('.card__close');
    if (!btn) return { error: 'no card' };
    const r = btn.getBoundingClientRect();
    const cx = r.left + r.width / 2;
    const cy = r.top + r.height / 2;
    const at = document.elementFromPoint(cx, cy);
    return {
      cx: Math.round(cx), cy: Math.round(cy),
      atPoint: at ? (String(at.className || '').split(' ')[0] || at.tagName) : 'null',
      hitIsBtn: !!(at && at.closest && at.closest('.card__close')),
      cardTop: Math.round(document.querySelector('.card').getBoundingClientRect().top),
      cardH: Math.round(document.querySelector('.card').getBoundingClientRect().height),
      btnVisible: r.top >= 0 && r.bottom <= window.innerHeight,
      scrollY: Math.round(window.scrollY)
    };
  })()`);

  if (state.error) { drops.push({ n, why: state.error }); continue; }

  await evalJs('window.__resetTrace()');
  await tap(state.cx, state.cy);
  await sleep(600);
  const after = await evalJs(`({ cards: document.querySelectorAll('.card').length, trace: window.__trace.slice() })`);

  if (after.cards === 0) {
    oneTapCloses += 1;
  } else {
    zeroTaps += 1;
    drops.push({ n, word, state, trace: after.trace });
    console.log(`tap ${n}: FAILED — btn@${state.cx},${state.cy} hit=${state.atPoint} visible=${state.btnVisible} cardTop=${state.cardTop} h=${state.cardH} trace=[${after.trace.join(' -> ')}]`);
  }

  // reset for the next round
  await sleep(200);
}

console.log(`\nsingle-tap close rate: ${oneTapCloses}/20`);
if (drops.length) {
  console.log(`\n${drops.length} failed taps:`);
  for (const d of drops) console.log(JSON.stringify(d).slice(0, 300));
} else {
  console.log('every ✕ tap closed on the first try — no drops recorded');
}

/* ------------------- then: rapid double-tap on ✕ (the impatient case) ------ */

console.log('\n=== rapid double-tap on ✕ ===');
await evalJs(`(async () => {
  const w = [...document.querySelectorAll('.w')].find(x => x.dataset.w === 'gallows');
  document.querySelectorAll('.card__close').forEach(b => b.click());
  await new Promise(r => setTimeout(r, 300));
  w.scrollIntoView({ block: 'center' });
  return true;
})()`);
await sleep(400);
const wt = await evalJs(`window.__tapTarget`);
await tap(wt.x, wt.y);
for (let i = 0; i < 60; i += 1) {
  await sleep(120);
  if (await evalJs(`!!document.querySelector('.card .card__zh')`)) break;
}
await sleep(300);
const btn2 = await evalJs(`(() => { const b = document.querySelector('.card__close'); const r = b.getBoundingClientRect(); return { x: r.left + r.width/2, y: r.top + r.height/2 }; })()`);
await tap(btn2.x, btn2.y);
await sleep(60);
await tap(btn2.x, btn2.y);   // 60 ms later: the impatient double
await sleep(800);
console.log('cards after a double-tap on ✕:', await evalJs(`document.querySelectorAll('.card').length`), '(0 means the first tap won)');

ws.close();
proc.kill('SIGTERM');
await sleep(500);
try { if (proc.exitCode === null) proc.kill('SIGKILL'); } catch { /* ignore */ }
try { fs.rmSync(profile, { recursive: true, force: true }); } catch { /* ignore */ }
