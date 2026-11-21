/**
 * Reproduce "the ✕ close button does not respond; I tap it many times".
 *
 * Uses real touch events. For each attempt it records whether the tap reached
 * the button, whether a click event fired, and whether the card closed — so a
 * dropped tap can be told apart from a tap that never hit the button at all.
 *
 * Usage: node verify/diag-close.mjs [url]
 */

import { spawn } from 'node:child_process';
import path from 'node:path';
import fs from 'node:fs';

const URL_TO_TEST = process.argv[2] || 'http://127.0.0.1:5180/';
const PORT = 9571;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const profile = path.join(process.env.TEMP, `er-close-${Date.now()}`);
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
  document.getElementById('impTitle').value = 'Close Diagnosis';
  document.getElementById('impText').value = 'A Slow Walk\\n\\nThe condemned man stepped aside to avoid a puddle, while the hangman waited beside the gallows. Nobody spoke.\\n\\nThe warders tightened their grip on his bound arms and the rope hung still above them.';
  document.getElementById('impSave').click();
})()`);
for (let i = 0; i < 80; i += 1) {
  await sleep(200);
  if (await evalJs(`document.querySelectorAll('.w').length > 0`)) break;
}
await sleep(800);

// Record what the close button actually receives.
await evalJs(`(() => {
  window.__tapLog = [];
  document.addEventListener('click', (e) => {
    const hit = e.target.closest && e.target.closest('.card__close');
    window.__tapLog.push('click' + (hit ? ':close' : ':' + (e.target.className || e.target.tagName)));
  }, true);
  document.addEventListener('pointerdown', (e) => {
    const hit = e.target.closest && e.target.closest('.card__close');
    if (hit) window.__tapLog.push('pointerdown:close');
  }, true);
  document.addEventListener('touchend', (e) => {
    const t = document.elementFromPoint(
      (e.changedTouches && e.changedTouches[0] ? e.changedTouches[0].clientX : 0),
      (e.changedTouches && e.changedTouches[0] ? e.changedTouches[0].clientY : 0)
    );
    window.__tapLog.push('touchend@' + (t ? (t.className || t.tagName) : 'null'));
  }, true);
  window.__reset = () => { window.__tapLog = []; };
  return true;
})()`);

const wordPos = await evalJs(`(() => {
  const w = [...document.querySelectorAll('.w')].find(x => x.dataset.w === 'gallows');
  w.scrollIntoView({ block: 'center' });
  const r = w.getBoundingClientRect();
  return { x: r.left + r.width / 2, y: r.top + r.height / 2 };
})()`);

/* -------- attempt N: open the card, then tap the ✕ once, see what happens --- */

for (let attempt = 1; attempt <= 5; attempt += 1) {
  await tap(wordPos.x, wordPos.y);
  for (let i = 0; i < 60; i += 1) {
    await sleep(150);
    if (await evalJs(`!!document.querySelector('.card')`)) break;
  }
  // Let the meaning finish loading, as a real reader would before closing.
  for (let i = 0; i < 60; i += 1) {
    await sleep(150);
    if (await evalJs(`!!document.querySelector('.card .card__zh')`)) break;
  }

  const probe = await evalJs(`(() => {
    const btn = document.querySelector('.card__close');
    if (!btn) return { error: 'no close button' };
    const r = btn.getBoundingClientRect();
    const cx = r.left + r.width / 2, cy = r.top + r.height / 2;
    const atPoint = document.elementFromPoint(cx, cy);
    return {
      rect: { x: Math.round(r.left), y: Math.round(r.top), w: Math.round(r.width), h: Math.round(r.height) },
      cx: Math.round(cx), cy: Math.round(cy),
      hitElement: atPoint ? (atPoint.className || atPoint.tagName) : 'null',
      hitIsButton: !!(atPoint && atPoint.closest && atPoint.closest('.card__close')),
      inViewport: r.top >= 0 && r.bottom <= window.innerHeight && r.left >= 0 && r.right <= window.innerWidth,
      cardZ: getComputedStyle(document.querySelector('.card')).zIndex,
      overlayAbove: (() => {
        const cards = [...document.querySelectorAll('.card')];
        return cards.length;
      })()
    };
  })()`);

  await evalJs('window.__reset()');
  await tap(probe.cx, probe.cy);
  await sleep(700);

  const after = await evalJs(`({ cards: document.querySelectorAll('.card').length, log: window.__tapLog.slice() })`);

  console.log(`attempt ${attempt}:`);
  console.log(`  button rect ${JSON.stringify(probe.rect)} center ${probe.cx},${probe.cy}`);
  console.log(`  elementFromPoint: ${probe.hitElement} | is the button: ${probe.hitIsButton}`);
  console.log(`  fully in viewport: ${probe.inViewport} | cards on screen: ${probe.overlayAbove}`);
  console.log(`  events: ${after.log.join(', ') || '(none)'}`);
  console.log(`  card count after tap: ${after.cards}  ${after.cards === 0 ? 'CLOSED' : 'STILL OPEN  <-- the bug'}`);

  // Clean up for the next attempt.
  if (after.cards > 0) {
    await evalJs(`document.querySelectorAll('.card').forEach(c => c.remove()); window.__clear?.();`);
    await evalJs(`(() => { const b = document.querySelector('#btnClearCards'); if (b) b.click(); return true; })()`);
    await sleep(400);
    // Re-open through the app so state stays consistent.
    await evalJs(`(() => { const w = [...document.querySelectorAll('.w')].find(x => x.dataset.w === 'gallows'); if (w) w.classList.remove('w--open'); return true; })()`);
  }
  console.log('');
}

ws.close();
proc.kill('SIGTERM');
await sleep(500);
try { if (proc.exitCode === null) proc.kill('SIGKILL'); } catch { /* ignore */ }
try { fs.rmSync(profile, { recursive: true, force: true }); } catch { /* ignore */ }
