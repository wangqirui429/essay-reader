/**
 * Verify the LIVE public deployment (GitHub Pages) in a real browser.
 *
 * This is the check that actually matters for "another computer can open it":
 * it loads the public URL over the internet, pins a word's Chinese meaning, and
 * confirms the app is offline-capable from the public origin.
 *
 * Usage: node verify/e2e-live.mjs [url]
 */

import fs from 'node:fs';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const URL_TO_TEST = process.argv[2] || 'https://wangqirui429.github.io/essay-reader/';
const HERE = path.dirname(fileURLToPath(import.meta.url));
const OUT_DIR = path.join(HERE, 'shots');
const PORT = 9391;
const CJK = /[\u3400-\u4dbf\u4e00-\u9fff]/;

fs.mkdirSync(OUT_DIR, { recursive: true });
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const results = [];
const check = (name, ok, detail = '') => {
  results.push({ name, ok });
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? ` — ${detail}` : ''}`);
};

console.log(`testing the public deployment: ${URL_TO_TEST}\n`);

const exe = 'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe';
const profile = path.join(process.env.TEMP, `er-live-${Date.now()}`);
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
const failures = [];
ws.addEventListener('message', (ev) => {
  const m = JSON.parse(ev.data);
  if (m.method === 'Runtime.exceptionThrown') problems.push(m.params.exceptionDetails.exception?.description || m.params.exceptionDetails.text);
  if (m.method === 'Network.responseReceived' && m.params.response.status >= 400) {
    failures.push(`${m.params.response.status} ${new URL(m.params.response.url).pathname}`);
  }
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
await send('Network.enable');
await send('Emulation.setDeviceMetricsOverride', { width: 414, height: 896, deviceScaleFactor: 2, mobile: true });
await sleep(4000);

/* 1 — the public page loads and is styled */
const shell = await evalJs(`({
  brand: !!document.querySelector('.brand'),
  styled: getComputedStyle(document.body).backgroundColor,
  title: document.title,
  origin: location.origin,
  path: location.pathname
})`);
check('public site loads and renders', shell.brand && shell.styled !== 'rgba(0, 0, 0, 0)', `${shell.origin}${shell.path} | ${shell.title}`);

/* 2 — service worker takes over from the public origin.
   Registration is retried and awaited: on a first visit the worker's own
   install step also downloads the app shell, which can take a few seconds on
   a cold GitHub Pages cache. */
const sw = await evalJs(`(async () => {
  if (!('serviceWorker' in navigator)) return { supported: false };
  let reg = await navigator.serviceWorker.getRegistration();
  if (!reg) {
    // Wait for the page's own registration call to settle.
    await new Promise((r) => {
      const t = setInterval(async () => {
        const found = await navigator.serviceWorker.getRegistration();
        if (found) { clearInterval(t); r(); }
      }, 250);
      setTimeout(() => { clearInterval(t); r(); }, 20000);
    });
    reg = await navigator.serviceWorker.getRegistration();
  }
  if (!reg) return { registered: false };
  const ready = await Promise.race([
    navigator.serviceWorker.ready.then(() => true),
    new Promise((r) => setTimeout(() => r(false), 20000)),
  ]);
  return { registered: true, scope: reg.scope, active: !!reg.active, ready };
})()`);
check('service worker installs on the public origin', sw.registered && sw.active && sw.ready, JSON.stringify(sw));

/* 2b — the worker really controls a reloaded page (install-only is not enough) */
await send('Page.reload');
await sleep(3500);
const controlled = await evalJs(`!!navigator.serviceWorker.controller`);
check('the page is controlled by the worker after reload', controlled === true);

/* 3 — the dictionary downloads from the public host */
const dict = await evalJs(`(async () => {
  const t0 = Date.now();
  const { loadDictionary, lookupOffline, dictSize } = await import('./js/dict-offline.js');
  await loadDictionary();
  const hit = await lookupOffline('sodden');
  return { size: dictSize(), ms: Date.now() - t0, zh: hit?.entry?.glosses?.[0]?.text || '' };
})()`);
check('bundled dictionary loads over the internet', dict.size > 1000 && CJK.test(dict.zh), `${dict.size} words in ${dict.ms}ms — sodden → ${dict.zh}`);

/* 4 — sample essay is fetchable */
const sample = await evalJs(`fetch('samples/a-hanging.txt').then(r => r.ok ? r.text().then(t => t.length) : 'status:' + r.status)`);
check('sample essay is served publicly', typeof sample === 'number' && sample > 5000, `${sample} bytes`);

/* 5 — import and pin, as any visitor would */
await evalJs(`(() => {
  document.getElementById('impTitle').value = 'Live Deploy Test';
  document.getElementById('impText').value = 'The condemned man stepped aside to avoid a puddle, and the hangman waited beside the gallows.';
  document.getElementById('impSave').click();
})()`);
await sleep(1200);

await clickEl(`[...document.querySelectorAll('.w')].find(w => w.dataset.w === 'gallows')`);
await sleep(3000);

const card = await evalJs(`JSON.stringify([...document.querySelectorAll('.card')].map(c => ({
  word: c.querySelector('.card__word')?.textContent,
  zh: (c.querySelector('.card__zh')?.textContent || '').slice(0, 26),
  ipa: c.querySelector('.card__ipa')?.textContent || ''
})))`);
const parsed = JSON.parse(card);
check('a visitor can pin a Chinese meaning from the public site', parsed.length === 1 && CJK.test(parsed[0].zh), card);

/* 6 — the pinned meaning does not vanish */
await evalJs(`window.scrollBy(0, 220)`);
await sleep(400);
await sleep(2500);
const persists = await evalJs(`document.querySelectorAll('.card').length`);
check('pinned meaning stays until cancelled', persists === 1, `cards=${persists}`);

const shot = await send('Page.captureScreenshot', { format: 'png' });
fs.writeFileSync(path.join(OUT_DIR, '14-live-public.png'), Buffer.from(shot.data, 'base64'));

/* 7 — saved words recorded in this browser */
await evalJs(`location.hash = '#/words'`);
await sleep(800);
const saved = await evalJs(`document.querySelectorAll('.wrow').length`);
check('saved words recorded for this visitor', saved >= 1, `rows=${saved}`);

/* 8 — manifest is publicly reachable (install prompt prerequisite) */
const manifest = await evalJs(`fetch('manifest.json').then(r => r.json()).then(m => ({ name: m.name, icons: (m.icons||[]).length })).catch(() => null)`);
check('web app manifest is valid publicly', manifest && manifest.icons >= 3, JSON.stringify(manifest));

/* 9 — no 404s on the live site */
const real = failures.filter((u) => !u.includes('/api/'));
check('no missing resources on the live site', real.length === 0, real.join(' | ') || 'none');

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
