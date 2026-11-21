/**
 * Verify the 🔊 speak button.
 *
 * The reported bug: tapping 🔊 produced no sound. Two things had to be true and
 * only one was: the button was wired to speech, but the card's close handlers
 * also matched the header, so pointerup removed the card before the speak path
 * ran. These checks pin both halves down.
 *
 * Speech synthesis itself has no audio sink in headless Edge, so what is
 * verified is the contract: the handler runs, it hands a correct utterance to
 * the engine, and the card stays open.
 *
 * Usage: node verify/check-speak.mjs [url]
 */

import { spawn } from 'node:child_process';
import path from 'node:path';
import fs from 'node:fs';

const URL_TO_TEST = process.argv[2] || 'http://127.0.0.1:5180/';
const PORT = 9661;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const results = [];
const check = (name, ok, detail = '') => {
  results.push({ name, ok });
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? ` — ${detail}` : ''}`);
};

const profile = path.join(process.env.TEMP, `er-speak-${Date.now()}`);
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
const click = async (x, y) => {
  await send('Input.dispatchMouseEvent', { type: 'mouseMoved', x, y });
  await send('Input.dispatchMouseEvent', { type: 'mousePressed', x, y, button: 'left', clickCount: 1 });
  await send('Input.dispatchMouseEvent', { type: 'mouseReleased', x, y, button: 'left', clickCount: 1 });
};

await send('Page.enable');
await send('Runtime.enable');
await send('Emulation.setDeviceMetricsOverride', { width: 390, height: 844, deviceScaleFactor: 3, mobile: true });
await send('Emulation.setTouchEmulationEnabled', { enabled: true, maxTouchPoints: 5 });

send('Page.navigate', { url: URL_TO_TEST });
let ready = false;
for (let i = 0; i < 120 && !ready; i += 1) {
  await sleep(250);
  try { ready = await evalJs(`!!document.getElementById('impSave')`); } catch { /* swap */ }
}
if (!ready) throw new Error('page never became ready');

await evalJs(`(() => {
  document.getElementById('impTitle').value = '发音测试';
  document.getElementById('impText').value = 'A Slow Walk\\n\\nThe condemned man stepped aside to avoid a puddle, while the hangman waited beside the gallows. Nobody spoke about it.\\n\\nThe warders tightened their grip on his bound arms and the rope hung still above them.';
  document.getElementById('impSave').click();
})()`);
for (let i = 0; i < 80; i += 1) {
  await sleep(200);
  if (await evalJs(`document.querySelectorAll('.w').length > 0`)) break;
}
await sleep(700);

/** Record every utterance handed to the speech engine, and the card count. */
await evalJs(`(() => {
  window.__spoken = [];
  window.__result = [];
  const original = window.speechSynthesis.speak.bind(window.speechSynthesis);
  window.speechSynthesis.speak = (u) => {
    window.__spoken.push({ text: u.text, lang: u.lang, rate: u.rate, hasVoice: !!u.voice });
    // Do not actually synthesise: headless has no audio device.
    return undefined;
  };
  document.addEventListener('card:spoke', (e) => window.__result.push(e.detail?.status));
  return true;
})()`);

const openWord = async (word = 'gallows') => {
  await evalJs(`(() => { document.querySelectorAll('.card__close').forEach(b => b.click()); return true; })()`);
  await sleep(400);
  const pos = await evalJs(`(() => {
    const w = [...document.querySelectorAll('.w')].find(x => x.dataset.w === ${JSON.stringify(word)});
    if (!w) return null;
    w.scrollIntoView({ block: 'center' });
    const r = w.getBoundingClientRect();
    return { x: r.left + r.width / 2, y: r.top + r.height / 2 };
  })()`);
  if (!pos) throw new Error(`no word ${word}`);
  await tap(pos.x, pos.y);
  for (let i = 0; i < 80; i += 1) {
    await sleep(120);
    if (await evalJs(`!!document.querySelector('.card .card__zh')`)) break;
  }
  await sleep(350);
};

const speakBtnPos = () => evalJs(`(() => {
  const b = document.querySelector('.card__speak');
  if (!b) return null;
  const r = b.getBoundingClientRect();
  return { x: r.left + r.width / 2, y: r.top + r.height / 2, w: Math.round(r.width), h: Math.round(r.height) };
})()`);

/* 1 — the button exists, is big enough, and is not the close target ------- */

await openWord();
const btn = await speakBtnPos();
check('the 🔊 button is present in the card header', !!btn, btn ? `${btn.w}x${btn.h}` : 'missing');
check('the 🔊 button meets the 44px touch-target guideline', btn && btn.w >= 44 && btn.h >= 44, `${btn?.w}x${btn?.h}`);

/* 2 — tapping it speaks AND leaves the card open -------------------------- */

await evalJs(`window.__spoken = []; window.__result = [];`);
await tap(btn.x, btn.y);
await sleep(800);
const afterTap = await evalJs(`({ spoken: window.__spoken.slice(), results: window.__result.slice(), cards: document.querySelectorAll('.card').length })`);
console.log(`  touch tap -> spoken: ${JSON.stringify(afterTap.spoken)} | status: ${JSON.stringify(afterTap.results)} | cards: ${afterTap.cards}`);
check('a touch tap on 🔊 reaches the speech engine', afterTap.spoken.length >= 1, JSON.stringify(afterTap.spoken));
check('the utterance carries the word itself', afterTap.spoken[0]?.text === 'gallows', afterTap.spoken[0]?.text);
check('the utterance asks for English', /^en/.test(afterTap.spoken[0]?.lang || ''), afterTap.spoken[0]?.lang);
check('tapping 🔊 does NOT close the card', afterTap.cards === 1, `cards=${afterTap.cards}`);
check('exactly one utterance per tap (no triple-fire)', afterTap.spoken.length === 1, `${afterTap.spoken.length} utterances`);

/* 3 — a mouse click also speaks and does not close ----------------------- */

await evalJs(`window.__spoken = []; window.__result = [];`);
const btn2 = await speakBtnPos();
await click(btn2.x, btn2.y);
await sleep(700);
const afterClick = await evalJs(`({ spoken: window.__spoken.slice(), cards: document.querySelectorAll('.card').length })`);
check('a mouse click on 🔊 also speaks', afterClick.spoken.length >= 1, JSON.stringify(afterClick.spoken));
check('a mouse click on 🔊 does not close the card', afterClick.cards === 1, `cards=${afterClick.cards}`);

/* 4 — repeated taps keep working ----------------------------------------- */

let allSpoke = true;
for (let i = 0; i < 4; i += 1) {
  await evalJs(`window.__spoken = []`);
  const b = await speakBtnPos();
  if (!b) { allSpoke = false; break; }
  await tap(b.x, b.y);
  await sleep(500);
  const n = await evalJs(`({ spoken: window.__spoken.length, cards: document.querySelectorAll('.card').length })`);
  if (n.spoken < 1 || n.cards !== 1) allSpoke = false;
}
check('four further 🔊 taps all speak and keep the card open', allSpoke);

/* 5 — the ✕ still closes, so the two controls have not been confused ----- */

await tap(btn2.x, btn2.y); // speak once more
await sleep(300);
const closePos = await evalJs(`(() => {
  const b = document.querySelector('.card__close');
  if (!b) return null;
  const r = b.getBoundingClientRect();
  return { x: r.left + r.width / 2, y: r.top + r.height / 2 };
})()`);
await tap(closePos.x, closePos.y);
await sleep(700);
check('the ✕ still closes the card after using 🔊', (await evalJs(`document.querySelectorAll('.card').length`)) === 0);

/* 6 — a device with no English voice reports instead of staying silent --- */

await openWord();
await evalJs(`(() => {
  // Simulate the phone case: the API exists but there is no English voice.
  window.__origGetVoices = window.speechSynthesis.getVoices.bind(window.speechSynthesis);
  window.speechSynthesis.getVoices = () => [];
  return true;
})()`);
await evalJs(`window.__result = []`);
const b6 = await speakBtnPos();
await tap(b6.x, b6.y);
await sleep(600);
const noVoice = await evalJs(`({ results: window.__result.slice(), cards: document.querySelectorAll('.card').length })`);
check('with no English voice the app still attempts speech', noVoice.results.length >= 1, JSON.stringify(noVoice.results));
check('with no English voice the card stays open', noVoice.cards === 1, `cards=${noVoice.cards}`);

console.log(`\n${results.filter((r) => r.ok).length}/${results.length} checks passed`);
ws.close();
proc.kill('SIGTERM');
await sleep(500);
try { if (proc.exitCode === null) proc.kill('SIGKILL'); } catch { /* ignore */ }
try { fs.rmSync(profile, { recursive: true, force: true }); } catch { /* ignore */ }
process.exit(results.every((r) => r.ok) ? 0 : 1);