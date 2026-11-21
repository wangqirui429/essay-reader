/**
 * Final proof for the public deployment: a visitor opens the site once, then
 * loses their connection entirely. Everything must still work.
 *
 * This is the scenario that decides whether the app replaces a computer: the
 * site is visited on Wi-Fi, then used on a train with no signal.
 *
 * Usage: node verify/e2e-live-offline.mjs [url]
 */

import fs from 'node:fs';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const URL_TO_TEST = process.argv[2] || 'https://wangqirui429.github.io/essay-reader/';
const HERE = path.dirname(fileURLToPath(import.meta.url));
const OUT_DIR = path.join(HERE, 'shots');
const PORT = 9395;
const CJK = /[\u3400-\u4dbf\u4e00-\u9fff]/;

fs.mkdirSync(OUT_DIR, { recursive: true });
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const results = [];
const check = (name, ok, detail = '') => {
  results.push({ name, ok });
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? ` — ${detail}` : ''}`);
};

const profile = path.join(process.env.TEMP, `er-liveoff-${Date.now()}`);
const exe = 'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe';
const proc = spawn(exe, ['--headless=new', `--remote-debugging-port=${PORT}`, `--user-data-dir=${profile}`, '--no-first-run', URL_TO_TEST], { stdio: 'ignore' });

let version = null;
for (let i = 0; i < 120 && !version; i += 1) {
  await sleep(300);
  try { version = await (await fetch(`http://127.0.0.1:${PORT}/json/version`)).json(); } catch { /* retry */ }
}
if (!version) { console.error('browser failed to start'); proc.kill(); process.exit(1); }

const page = (await (await fetch(`http://127.0.0.1:${PORT}/json/list`)).json()).find((t) => t.type === 'page');
const ws = new WebSocket(page.webSocketDebuggerUrl);
await new Promise((res, rej) => { ws.addEventListener('open', res, { once: true }); ws.addEventListener('error', rej, { once: true }); });

let id = 0;
const pending = new Map();
const problems = [];
ws.addEventListener('message', (ev) => {
  const m = JSON.parse(ev.data);
  if (m.method === 'Runtime.exceptionThrown') problems.push(m.params.exceptionDetails.exception?.description || m.params.exceptionDetails.text);
  const job = pending.get(m.id);
  if (job) { pending.delete(m.id); m.error ? job.rej(new Error(m.error.message)) : job.res(m.result); }
});
const send = (method, params = {}) => new Promise((res, rej) => { const i = ++id; pending.set(i, { res, rej }); ws.send(JSON.stringify({ id: i, method, params })); });
const evalJs = async (expr) => {
  const r = await send('Runtime.evaluate', { expression: expr, awaitPromise: true, returnByValue: true });
  if (r.exceptionDetails) throw new Error(r.exceptionDetails.exception?.description || 'eval threw');
  return r.result.value;
};
const clickEl = async (expr) => {
  const pos = await evalJs(`(() => {
    const el = ${expr};
    if (!el) return null;
    el.scrollIntoView({ block: 'center' });
    const r = el.getBoundingClientRect();
    return { x: r.left + r.width / 2, y: r.top + r.height / 2 };
  })()`);
  if (!pos) throw new Error(`element not found: ${expr}`);
  await send('Input.dispatchMouseEvent', { type: 'mousePressed', x: pos.x, y: pos.y, button: 'left', clickCount: 1 });
  await send('Input.dispatchMouseEvent', { type: 'mouseReleased', x: pos.x, y: pos.y, button: 'left', clickCount: 1 });
  return pos;
};

await send('Page.enable');
await send('Runtime.enable');
await send('Emulation.setDeviceMetricsOverride', { width: 414, height: 896, deviceScaleFactor: 2, mobile: true });
await sleep(4000);

/* ------------------------------ install the worker and let it cache the app */

const installed = await evalJs(`(async () => {
  const reg = await navigator.serviceWorker.getRegistration();
  if (!reg) return { ok: false };
  await navigator.serviceWorker.ready;
  // Give the install step time to store the shell and dictionary.
  await new Promise((r) => setTimeout(r, 8000));
  return { ok: !!reg.active };
})()`);
check('app installs for offline use on first visit', installed.ok === true);

await send('Page.reload');
await sleep(3500);
check('page is worker-controlled', await evalJs(`!!navigator.serviceWorker.controller`) === true);

/* ------------------------------------------------- cut the network for real */

await send('Network.enable');
await send('Network.emulateNetworkConditions', {
  offline: true,
  latency: 0,
  downloadThroughput: 0,
  uploadThroughput: 0,
});

// Prove the browser is offline using a URL that cannot be cached.
const offlineProven = await evalJs(`fetch('https://example.com/no-such-path-' + Date.now(), { cache: 'no-store' })
  .then(() => false).catch(() => true)`);
check('the browser is genuinely offline', offlineProven === true, `offline=${offlineProven}`);

/* ------------------------------------- a full cold start with no connection */

await send('Page.reload');
await sleep(4000);
const coldStart = await evalJs(`({
  brand: !!document.querySelector('.brand'),
  styled: getComputedStyle(document.body).backgroundColor !== 'rgba(0, 0, 0, 0)',
  cards: !!document.querySelector('.card-layer')
})`);
check('app starts from cache with no connection', coldStart.brand && coldStart.styled, JSON.stringify(coldStart));

/* --------------------------------------------- look up a word while offline */

const dictOffline = await evalJs(`(async () => {
  const { lookupOffline, dictSize } = await import('./js/dict-offline.js');
  const hit = await lookupOffline('reiterated');
  return { size: dictSize(), zh: hit?.entry?.glosses?.[0]?.text || '' };
})()`);
check('dictionary answers with no connection', CJK.test(dictOffline.zh), `${dictOffline.size} words — reiterated → ${dictOffline.zh}`);

await evalJs(`(() => {
  document.getElementById('impTitle').value = 'Offline Reading';
  document.getElementById('impText').value = 'The prisoner stepped aside to avoid the puddle, and the warders tightened their grip on his bound arms.';
  document.getElementById('impSave').click();
})()`);
await sleep(1000);

await clickEl(`[...document.querySelectorAll('.w')].find(w => w.dataset.w === 'puddle')`);
await sleep(2500);

const card = await evalJs(`JSON.stringify([...document.querySelectorAll('.card')].map(c => ({
  word: c.querySelector('.card__word')?.textContent,
  zh: (c.querySelector('.card__zh')?.textContent || '').slice(0, 26)
})))`);
const parsed = JSON.parse(card);
check('a word still pins its Chinese meaning offline', parsed.length === 1 && CJK.test(parsed[0].zh), card);

const shot = await send('Page.captureScreenshot', { format: 'png' });
fs.writeFileSync(path.join(OUT_DIR, '15-live-offline.png'), Buffer.from(shot.data, 'base64'));

/* --------------------------------------------- the pin survives everything */

await evalJs(`window.scrollBy(0, 200)`);
await sleep(400);
await sleep(2500);
const persists = await evalJs(`document.querySelectorAll('.card').length`);
check('the pinned meaning stays offline until cancelled', persists === 1, `cards=${persists}`);

await evalJs(`location.hash = '#/words'`);
await sleep(700);
const saved = await evalJs(`document.querySelectorAll('.wrow').length`);
check('saved words persist offline', saved >= 1, `rows=${saved}`);

console.log(`\n${results.filter((r) => r.ok).length}/${results.length} checks passed`);
if (problems.length) {
  console.log('\nbrowser problems:');
  for (const p of problems) console.log('  ' + p);
}

ws.close();
proc.kill('SIGTERM');
await sleep(500);
try { if (proc.exitCode === null) proc.kill('SIGKILL'); } catch { /* ignore */ }
try { fs.rmSync(profile, { recursive: true, force: true }); } catch { /* ignore */ }
process.exit(results.every((r) => r.ok) && problems.length === 0 ? 0 : 1);
