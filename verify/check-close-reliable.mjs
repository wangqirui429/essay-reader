/**
 * Verify the close button is reliable on a phone.
 *
 * The reported problem: the ✕ needs many taps before it works. Each check below
 * corresponds to a specific way that could happen.
 *
 * Usage: node verify/check-close-reliable.mjs [url]
 */

import { spawn } from 'node:child_process';
import path from 'node:path';
import fs from 'node:fs';

const URL_TO_TEST = process.argv[2] || 'http://127.0.0.1:5180/';
const PORT = 9601;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const results = [];
const check = (name, ok, detail = '') => {
  results.push({ name, ok });
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? ` — ${detail}` : ''}`);
};

const profile = path.join(process.env.TEMP, `er-closerel-${Date.now()}`);
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
  document.getElementById('impTitle').value = '闭合可靠性';
  document.getElementById('impText').value = 'A Slow Walk\\n\\nThe condemned man stepped aside to avoid a puddle, while the hangman waited beside the gallows. Nobody spoke about it at all.\\n\\nThe warders tightened their grip on his bound arms and the rope hung still above them today.';
  document.getElementById('impSave').click();
})()`);
for (let i = 0; i < 80; i += 1) {
  await sleep(200);
  if (await evalJs(`document.querySelectorAll('.w').length > 0`)) break;
}
await sleep(700);

const openWord = async (word = 'gallows') => {
  // Start from a clean slate so a previous card cannot make this a no-op.
  await evalJs(`(() => { document.querySelectorAll('.card__close').forEach(b => b.click()); return true; })()`);
  await sleep(350);

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
  await sleep(300);
  return pos;
};

/** Centre of the open card's ✕, or null when no card is showing. */
const closeButtonPos = () => evalJs(`(() => {
  const b = document.querySelector('.card__close');
  if (!b) return null;
  const r = b.getBoundingClientRect();
  return { x: r.left + r.width / 2, y: r.top + r.height / 2 };
})()`);

const closeIt = async () => {
  await evalJs(`(() => { document.querySelectorAll('.card__close').forEach(b => b.click()); return true; })()`);
  await sleep(400);
};

/* 1 — the button is big enough and positioned away from the words ------- */

await openWord();
const geom = await evalJs(`(() => {
  const card = document.querySelector('.card');
  const btn = card.querySelector('.card__close');
  const br = btn.getBoundingClientRect();
  const cr = card.getBoundingClientRect();
  const words = [...document.querySelectorAll('.card__word')];
  return {
    w: Math.round(br.width), h: Math.round(br.height),
    leftOffsetFromCard: Math.round(br.left - cr.left),
    isLeftmost: btn.getBoundingClientRect().left <= (card.querySelector('.card__word')?.getBoundingClientRect().left ?? 1e9),
    touchAction: getComputedStyle(btn).touchAction
  };
})()`);
check('close button is at least 46px square', geom.w >= 46 && geom.h >= 46, `${geom.w}x${geom.h}`);
check('close button sits at the card leading edge', geom.isLeftmost, `offset ${geom.leftOffsetFromCard}px from card left`);
check('close button uses touch-action: manipulation', geom.touchAction === 'manipulation', geom.touchAction);

/* 2 — the card does not change size or position as the entry loads ---- */

await closeIt();
await evalJs(`(() => {
  const w = [...document.querySelectorAll('.w')].find(x => x.dataset.w === 'puddle');
  w.scrollIntoView({ block: 'end' });
  return true;
})()`);
await sleep(300);

const before = await evalJs(`(() => {
  const w = [...document.querySelectorAll('.w')].find(x => x.dataset.w === 'puddle');
  const r = w.getBoundingClientRect();
  return { x: r.left + r.width / 2, y: r.top + r.height / 2 };
})()`);

// Sample the card geometry from the instant it opens.
await tap(before.x, before.y);
const samples = [];
for (let i = 0; i < 30; i += 1) {
  await sleep(80);
  const s = await evalJs(`(() => {
    const c = document.querySelector('.card');
    if (!c) return null;
    const b = c.querySelector('.card__close');
    const br = b ? b.getBoundingClientRect() : null;
    return { h: Math.round(c.getBoundingClientRect().height), btnTop: br ? Math.round(br.top) : null };
  })()`);
  if (s) samples.push(s);
  if (samples.length > 3 && await evalJs(`!!document.querySelector('.card .card__zh')`)) break;
}
const first = samples[0];
const last = samples[samples.length - 1];
const btnDrift = Math.abs((last?.btnTop ?? 0) - (first?.btnTop ?? 0));
check('the close button does not move while the entry loads', btnDrift <= 6, `drifted ${btnDrift}px over ${samples.length} samples`);

/* 3 — one tap on ✕ closes it, repeated ten times ---------------------- */

let allClosed = true;
const times = [];
for (let i = 0; i < 10; i += 1) {
  await openWord();
  const btnPos = await closeButtonPos();
  if (!btnPos) throw new Error('card did not open for the tap test');
  const t = Date.now();
  await tap(btnPos.x, btnPos.y);
  let closed = false;
  for (let j = 0; j < 25; j += 1) {
    await sleep(80);
    if (await evalJs(`document.querySelectorAll('.card').length === 0`)) { closed = true; break; }
  }
  times.push(Date.now() - t);
  if (!closed) allClosed = false;
  await sleep(200);
}
check('one tap on ✕ closes the card, every one of 10 tries', allClosed, `timings: ${times.join(', ')} ms`);

/* 4 — tapping the card's chrome also dismisses it --------------------- */

await openWord();
const chromePos = await evalJs(`(() => {
  const c = document.querySelector('.card');
  if (!c) return null;
  const head = c.querySelector('.card__head');
  if (!head) return null;
  const r = head.getBoundingClientRect();
  // the header area away from both buttons
  return { x: r.left + r.width * 0.45, y: r.top + r.height / 2 };
})()`);
if (chromePos) {
  await tap(chromePos.x, chromePos.y);
  await sleep(700);
}
check('a tap on the card header (not the ✕) also dismisses it', (await evalJs(`document.querySelectorAll('.card').length`)) === 0, chromePos ? 'closed' : 'card was not open');

/* 5 — the ✕ still works after scrolling the essay --------------------- */

await openWord();
await evalJs(`window.scrollBy(0, 120)`);
await sleep(400);
const afterScroll = await closeButtonPos();
if (!afterScroll) throw new Error('close button vanished after scroll');
await tap(afterScroll.x, afterScroll.y);
await sleep(700);
check('the ✕ still works after scrolling', (await evalJs(`document.querySelectorAll('.card').length`)) === 0, 'closed');

/* 6 — the card stays inside the viewport ----------------------------- */

await openWord();
const fits = await evalJs(`(() => {
  const c = document.querySelector('.card');
  const r = c.getBoundingClientRect();
  return { top: Math.round(r.top), bottom: Math.round(r.bottom), vh: window.innerHeight, inside: r.top >= 0 && r.bottom <= window.innerHeight + 1 };
})()`);
check('the card is fully on screen', fits.inside, JSON.stringify(fits));

const shot = await send('Page.captureScreenshot', { format: 'png' });
if (shot?.data) {
  const dir = path.join(path.dirname(new URL(import.meta.url).pathname.slice(1)), 'shots');
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, '25-close-button.png'), Buffer.from(shot.data, 'base64'));
}

console.log(`\n${results.filter((r) => r.ok).length}/${results.length} checks passed`);
ws.close();
proc.kill('SIGTERM');
await sleep(500);
try { if (proc.exitCode === null) proc.kill('SIGKILL'); } catch { /* ignore */ }
try { fs.rmSync(profile, { recursive: true, force: true }); } catch { /* ignore */ }
process.exit(results.every((r) => r.ok) ? 0 : 1);
