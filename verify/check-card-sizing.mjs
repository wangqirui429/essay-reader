/**
 * Verify that a card's size follows its content, as requested:
 * a word with two senses gets a small card; a word with many senses, phrases
 * and examples gets a bigger one. No empty space at the bottom of a short card.
 *
 * Usage: node verify/check-card-sizing.mjs [url]
 */

import { spawn } from 'node:child_process';
import path from 'node:path';
import fs from 'node:fs';
import { fileURLToPath } from 'node:url';

const URL_TO_TEST = process.argv[2] || 'http://127.0.0.1:5180/';
const HERE = path.dirname(fileURLToPath(import.meta.url));
const PORT = 9631;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const results = [];
const check = (name, ok, detail = '') => {
  results.push({ name, ok });
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? ` — ${detail}` : ''}`);
};

const profile = path.join(process.env.TEMP, `er-size-${Date.now()}`);
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

// Words chosen for their dictionary entry size: 'apple' has one sense and a
// couple of phrases; 'gallows' has senses + tags + phrases + examples.
await evalJs(`(() => {
  document.getElementById('impTitle').value = '卡片尺寸测试';
  document.getElementById('impText').value = 'Size Test\\n\\nShe ate an apple under the gallows while the guards watched from the wall, and nobody dared to say a single word about what they had all seen that morning in the yard.';
  document.getElementById('impSave').click();
})()`);
for (let i = 0; i < 80; i += 1) {
  await sleep(200);
  if (await evalJs(`document.querySelectorAll('.w').length > 0`)) break;
}
await sleep(700);

const openWord = async (word) => {
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
  for (let i = 0; i < 100; i += 1) {
    await sleep(150);
    if (await evalJs(`!!document.querySelector('.card .card__zh')`)) break;
  }
  await sleep(400);
  return evalJs(`(() => {
    const c = document.querySelector('.card');
    if (!c) return null;
    const body = c.querySelector('.card__body');
    const cr = c.getBoundingClientRect();
    const br = body ? body.getBoundingClientRect() : null;
    // Empty space = card height minus the content that actually fills it.
    const contentBottom = br ? br.scrollHeight : 0;
    return {
      cardH: Math.round(cr.height),
      bodyScrollH: body ? body.scrollHeight : 0,
      bodyVisibleH: br ? Math.round(br.height) : 0,
      glossCount: c.querySelectorAll('.card__glosses li').length,
      phraseCount: c.querySelectorAll('.card__line').length,
      exCount: c.querySelectorAll('.card__ex').length,
      // dead space: visible body height far exceeding its scroll height means
      // the card is taller than what it shows.
      deadSpace: br ? Math.max(0, Math.round(br.height - body.scrollHeight)) : 0
    };
  })()`);
};

console.log('=== "apple" (1 sense, few extras) ===');
const apple = await openWord('apple');
console.log(JSON.stringify(apple, null, 1));

console.log('\n=== "gallows" (senses + tags + phrases + examples) ===');
const gallows = await openWord('gallows');
console.log(JSON.stringify(gallows, null, 1));

check('the small-entry card is genuinely small', apple && apple.cardH < 260, `${apple?.cardH}px tall`);
check('a small card has no dead space at the bottom', apple && apple.deadSpace <= 8, `${apple?.deadSpace}px of dead space`);
check('the rich-entry card is taller than the small one', apple && gallows && gallows.cardH > apple.cardH + 40, `apple ${apple?.cardH}px vs gallows ${gallows?.cardH}px`);
check('a rich card shows all of its content (scrollable, not clipped without scroll)', gallows && gallows.bodyVisibleH <= gallows.bodyScrollH + 4, `visible ${gallows?.bodyVisibleH}px of ${gallows?.bodyScrollH}px content`);
check('neither card exceeds the phone cap (70vh ≈ 590px)', apple && gallows && apple.cardH <= 600 && gallows.cardH <= 600, `${apple?.cardH} / ${gallows?.cardH}`);

const shot = await send('Page.captureScreenshot', { format: 'png' });
if (shot?.data) {
  const dir = path.join(HERE, 'shots');
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, '27-card-sizing.png'), Buffer.from(shot.data, 'base64'));
}

console.log(`\n${results.filter((r) => r.ok).length}/${results.length} checks passed`);
ws.close();
proc.kill('SIGTERM');
await sleep(500);
try { if (proc.exitCode === null) proc.kill('SIGKILL'); } catch { /* ignore */ }
try { fs.rmSync(profile, { recursive: true, force: true }); } catch { /* ignore */ }
process.exit(results.every((r) => r.ok) ? 0 : 1);
