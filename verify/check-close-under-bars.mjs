/**
 * Reproduce the reported failure exactly: a word in the middle of the screen,
 * its card expanding UPWARD, with the ✕ sliding under the sticky toolbar.
 *
 * Before the fix the card layer sat under the sticky bars (z 40 vs 50/60), so
 * the ✕ could not be tapped at all. After it, the card must start below the
 * bars, and the ✕ must be tappable from wherever the card landed.
 *
 * Usage: node verify/check-close-under-bars.mjs [url]
 */

import { spawn } from 'node:child_process';
import path from 'node:path';
import fs from 'node:fs';
import { fileURLToPath } from 'node:url';

const URL_TO_TEST = process.argv[2] || 'http://127.0.0.1:5180/';
const HERE = path.dirname(fileURLToPath(import.meta.url));
const PORT = 9621;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const results = [];
const check = (name, ok, detail = '') => {
  results.push({ name, ok });
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? ` — ${detail}` : ''}`);
};

const profile = path.join(process.env.TEMP, `er-under-${Date.now()}`);
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

await evalJs(`(() => {
  document.getElementById('impTitle').value = '遮挡复现';
  document.getElementById('impText').value = 'A Hanging\\n\\n' + Array.from({length: 10}, (_, i) => 'Paragraph ' + (i+1) + '. Each cell measured about ten feet by ten and was quite bare within except for a plank bed and a pot of drinking water. In some of them brown silent men were squatting at the inner bars, with their blankets draped round them. These were the condemned men, due to be hanged within the next week or two, and none of them spoke about it at all.').join('\\n\\n');
  document.getElementById('impSave').click();
})()`);
for (let i = 0; i < 80; i += 1) {
  await sleep(200);
  if (await evalJs(`document.querySelectorAll('.w').length > 0`)) break;
}
await sleep(700);

// Open a card on a word, then scroll the word upward so its card expands
// into the top region — the exact arrangement from the screenshot.
const attempt = async (word) => {
  const exists = await evalJs(`!![...document.querySelectorAll('.w')].find(x => x.dataset.w === ${JSON.stringify(word)})`);
  if (!exists) throw new Error(`no word ${word}`);

  const placed = await evalJs(`(() => {
    const w = [...document.querySelectorAll('.w')].find(x => x.dataset.w === ${JSON.stringify(word)});
    w.scrollIntoView({ block: 'center' });
    window.scrollBy(0, 120);   // push the word up, close to the bars
    const r = w.getBoundingClientRect();
    return { y: Math.round(r.top), bottom: Math.round(r.bottom), x: r.left + r.width / 2, mid: r.top + r.height / 2 };
  })()`);
  console.log(`  word "${word}" at y=${placed.y}, tapping at ${Math.round(placed.mid)}`);

  await tap(placed.x, placed.mid);
  for (let i = 0; i < 80; i += 1) {
    await sleep(120);
    if (await evalJs(`!!document.querySelector('.card .card__zh')`)) break;
  }
  await sleep(400);
  return placed;
};

await attempt('plank');
const opened = await evalJs(`document.querySelectorAll('.card').length`);
console.log(`  cards open: ${opened}`);
if (!opened) {
  console.log('  (the tap toggled an existing card shut; opening again)');
  await sleep(400);
  await attempt('plank');
  await sleep(600);
}

const geometry = await evalJs(`(() => {
  const card = document.querySelector('.card');
  if (!card) return null;
  const btn = card.querySelector('.card__close');
  const cr = card.getBoundingClientRect();
  const br = btn.getBoundingClientRect();
  const topbar = document.querySelector('.topbar').getBoundingClientRect();
  const toolbar = document.querySelector('.reader__toolbar').getBoundingClientRect();
  const atPoint = document.elementFromPoint(br.left + br.width / 2, br.top + br.height / 2);
  return {
    cardTop: Math.round(cr.top),
    cardLayerZ: getComputedStyle(document.querySelector('.card-layer')).zIndex,
    topbarZ: getComputedStyle(document.querySelector('.topbar')).zIndex,
    toolbarZ: getComputedStyle(document.querySelector('.reader__toolbar')).zIndex,
    btnTop: Math.round(br.top),
    btnBottom: Math.round(br.bottom),
    btnVisibleTop: Math.round(Math.max(br.top, 0)),
    tapPointClear: !!(atPoint && atPoint.closest && atPoint.closest('.card__close')),
    whatIsAtPoint: atPoint ? (String(atPoint.className) || atPoint.tagName) : 'null',
    topbarBottom: Math.round(topbar.bottom),
    toolbarBottom: Math.round(toolbar.bottom)
  };
})()`);

console.log('\n--- geometry after opening ---');
console.log(JSON.stringify(geometry, null, 1));

check('card layer renders above the sticky bars', Number(geometry.cardLayerZ) > Number(geometry.topbarZ), `layer=${geometry.cardLayerZ} vs topbar=${geometry.topbarZ} toolbar=${geometry.toolbarZ}`);

if (geometry.cardTop < geometry.toolbarBottom) {
  console.log('  (card top is in the sticky-bar region — this is the case from the screenshot)');
}

check('the ✕ is inside the viewport', geometry.btnBottom > 0 && geometry.btnTop < 844, `btn ${geometry.btnTop}..${geometry.btnBottom}`);
check('the element under the ✕ is the ✕ itself (not a sticky bar)', geometry.tapPointClear === true, `found: ${geometry.whatIsAtPoint}`);

// Now actually tap the ✕.
const btnPos = await evalJs(`(() => {
  const b = document.querySelector('.card__close');
  const r = b.getBoundingClientRect();
  return { x: r.left + r.width / 2, y: r.top + r.height / 2 };
})()`);
await tap(btnPos.x, btnPos.y);
await sleep(800);
const closed = await evalJs(`document.querySelectorAll('.card').length === 0`);
check('tapping the ✕ closes the card first try', closed, closed ? 'closed' : 'STILL OPEN');

// Repeat with the word much higher on the screen.
console.log('\n--- second attempt, word closer to the top ---');
const pos2 = await attempt('condemned');
console.log(`  word placed at y=${pos2.y}`);
await sleep(600);

const geom2 = await evalJs(`(() => {
  const card = document.querySelector('.card');
  if (!card) return null;
  const btn = card.querySelector('.card__close');
  const cr = card.getBoundingClientRect();
  const br = btn.getBoundingClientRect();
  const atPoint = document.elementFromPoint(br.left + br.width / 2, br.top + br.height / 2);
  return {
    cardTop: Math.round(cr.top),
    cardBottom: Math.round(cr.bottom),
    btnTop: Math.round(br.top),
    tapPointClear: !!(atPoint && atPoint.closest && atPoint.closest('.card__close')),
    whatIsAtPoint: atPoint ? (String(atPoint.className) || atPoint.tagName) : 'null'
  };
})()`);
if (geom2) {
  console.log(JSON.stringify(geom2));
  check('second card: ✕ remains tappable near the top', geom2.tapPointClear === true, `found: ${geom2.whatIsAtPoint}`);
  const b2 = await evalJs(`(() => { const b = document.querySelector('.card__close'); const r = b.getBoundingClientRect(); return { x: r.left + r.width/2, y: r.top + r.height/2 }; })()`);
  await tap(b2.x, b2.y);
  await sleep(800);
  check('second card also closes first try', (await evalJs(`document.querySelectorAll('.card').length === 0`)), 'closed');
}

const shot = await send('Page.captureScreenshot', { format: 'png' });
if (shot?.data) {
  const dir = path.join(HERE, 'shots');
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, '26-under-bars.png'), Buffer.from(shot.data, 'base64'));
}

console.log(`\n${results.filter((r) => r.ok).length}/${results.length} checks passed`);
ws.close();
proc.kill('SIGTERM');
await sleep(500);
try { if (proc.exitCode === null) proc.kill('SIGKILL'); } catch { /* ignore */ }
try { fs.rmSync(profile, { recursive: true, force: true }); } catch { /* ignore */ }
process.exit(results.every((r) => r.ok) ? 0 : 1);
