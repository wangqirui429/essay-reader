/**
 * Verify the fully offline / static deployment.
 *
 * The interesting claim is: no server logic is required for lookups. So this
 * suite serves the app from a throwaway static server, lets the service worker
 * cache it, then KILLS the server and reloads. Anything that still works is
 * genuinely running from the device.
 *
 * Usage: node verify/e2e-offline.mjs
 */

import fs from 'node:fs';
import path from 'node:path';
import http from 'node:http';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const SITE_PORT = Number(process.env.SITE_PORT || 5181);
const BASE = `http://127.0.0.1:${SITE_PORT}`;
const OUT_DIR = path.join(path.dirname(fileURLToPath(import.meta.url)), 'shots');
const PORT = 9361;
const CJK = /[\u3400-\u4dbf\u4e00-\u9fff]/;

const ESSAY = `A Quiet Discipline

Last winter I began writing three sentences every morning, before the phone could reach me. Three sentences is nothing, which is exactly why the habit survived a tired Tuesday and a distracted Thursday.

By spring the notebook had become a measuring instrument. Reading backwards, I could see when I had started to relax about my examinations: the sentences grew shorter, then stopped mentioning the day at all.

A habit is also a confession, written in the plainest possible ink.`;

fs.mkdirSync(OUT_DIR, { recursive: true });
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/* --------------------------------------------- throwaway static server --- */

const PUBLIC_DIR = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'public');
const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.png': 'image/png',
  '.webmanifest': 'application/manifest+json',
  '.txt': 'text/plain; charset=utf-8',
};

const site = http.createServer((req, res) => {
  const urlPath = decodeURIComponent(new URL(req.url, BASE).pathname);
  // Deliberately expose NO /api routes: this is the phone deployment.
  if (urlPath.startsWith('/api/')) {
    res.writeHead(404, { 'Content-Type': 'text/plain' }).end('no api on this deployment');
    return;
  }
  const rel = urlPath === '/' ? '/index.html' : urlPath;
  const file = path.join(PUBLIC_DIR, path.normalize(rel).replace(/^[/\\]+/, ''));
  if (!file.startsWith(PUBLIC_DIR)) {
    res.writeHead(403).end('forbidden');
    return;
  }
  fs.readFile(file, (err, buf) => {
    if (err) {
      fs.readFile(path.join(PUBLIC_DIR, 'index.html'), (e2, html) => {
        if (e2) { res.writeHead(404).end('not found'); return; }
        res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' }).end(html);
      });
      return;
    }
    res.writeHead(200, { 'Content-Type': MIME[path.extname(file).toLowerCase()] || 'application/octet-stream' }).end(buf);
  });
});

await new Promise((resolve) => site.listen(SITE_PORT, '127.0.0.1', resolve));
console.log(`static site on ${BASE} (no /api routes)\n`);

const exe = 'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe';
const profile = path.join(process.env.TEMP, `er-offline-${Date.now()}`);

const proc = spawn(exe, [
  '--headless=new',
  `--remote-debugging-port=${PORT}`,
  `--user-data-dir=${profile}`,
  '--no-first-run',
  '--no-default-browser-check',
  BASE,
], { stdio: 'ignore' });

const results = [];
const check = (name, ok, detail = '') => {
  results.push({ name, ok });
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? ` — ${detail}` : ''}`);
};

/** Resolve an element by expression, scroll it into view, click it for real. */
async function clickEl(expression) {
  const pos = await evalJs(`(() => {
    const el = ${expression};
    if (!el) return null;
    el.scrollIntoView({ block: 'center' });
    const r = el.getBoundingClientRect();
    return { x: r.left + r.width / 2, y: r.top + r.height / 2 };
  })()`);
  if (!pos) throw new Error(`element not found: ${expression}`);
  await send('Input.dispatchMouseEvent', { type: 'mousePressed', x: pos.x, y: pos.y, button: 'left', clickCount: 1 });
  await send('Input.dispatchMouseEvent', { type: 'mouseReleased', x: pos.x, y: pos.y, button: 'left', clickCount: 1 });
  return pos;
}

let version = null;
for (let i = 0; i < 100 && !version; i += 1) {
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
  if (m.method === 'Runtime.exceptionThrown') {
    problems.push(m.params.exceptionDetails.exception?.description || m.params.exceptionDetails.text);
  }
  const job = pending.get(m.id);
  if (job) { pending.delete(m.id); m.error ? job.rej(new Error(m.error.message)) : job.res(m.result); }
});
const send = (method, params = {}) => new Promise((res, rej) => { const i = ++id; pending.set(i, { res, rej }); ws.send(JSON.stringify({ id: i, method, params })); });
const evalJs = async (expression) => {
  const r = await send('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true });
  if (r.exceptionDetails) throw new Error(r.exceptionDetails.exception?.description || 'eval threw');
  return r.result.value;
};

await send('Page.enable');
await send('Runtime.enable');
await send('Network.enable');
await send('Emulation.setDeviceMetricsOverride', { width: 414, height: 896, deviceScaleFactor: 2, mobile: true });
await sleep(2500);

/* 1 — service worker takes control */
const sw = await evalJs(`(async () => {
  if (!('serviceWorker' in navigator)) return { supported: false };
  const reg = await navigator.serviceWorker.getRegistration();
  return { supported: true, registered: !!reg, active: !!(reg && reg.active), controlled: !!navigator.serviceWorker.controller };
})()`);
check('service worker registers and activates', sw.supported && sw.registered && sw.active, JSON.stringify(sw));

/* 2 — manifest and icons are reachable */
const assets = await evalJs(`Promise.all([
  fetch('./manifest.json').then(r => r.ok),
  fetch('./icons/icon-192.png').then(r => r.ok),
  fetch('./data/dict-core.json').then(r => r.ok),
  fetch('./data/shards/s.json').then(r => r.ok)
]).then(r => ({ manifest: r[0], icon: r[1], core: r[2], shard: r[3] }))`);
check('manifest, icons and dictionary files are served', assets.manifest && assets.icon && assets.core && assets.shard, JSON.stringify(assets));

/* 3 — import an essay on a phone-sized viewport */
await evalJs(`(() => {
  document.getElementById('impTitle').value = 'A Quiet Discipline';
  document.getElementById('impText').value = ${JSON.stringify(ESSAY)};
  document.getElementById('impSave').click();
})()`);
await sleep(1200);
const imported = await evalJs(`({
  tokens: document.querySelectorAll('.w').length,
  title: document.getElementById('essayTitle').textContent,
  overflow: document.documentElement.scrollWidth - window.innerWidth
})`);
check('essay imports on a phone viewport without overflow', imported.tokens > 60 && imported.overflow <= 1, JSON.stringify(imported));

/* 4 — wait for the worker to control this page, then reload under its control */
await evalJs(`navigator.serviceWorker.ready.then(() => true)`);
await send('Page.reload');
await sleep(2500);
const controlled = await evalJs(`!!navigator.serviceWorker.controller`);
check('page is controlled by the service worker after reload', controlled === true);

/* 5 — kill the server: from here on there is no origin at all */
await new Promise((resolve) => site.close(resolve));
console.log('server stopped — the origin is now unreachable\n');

// Ask for a path that cannot be in the service-worker cache. A live origin
// would answer with 404; a dead origin makes the worker return its own 504
// "offline" response, which is exactly the proof we want.
const reachable = await evalJs(`fetch('/alive-check-' + Date.now() + '.html', { cache: 'no-store' })
  .then((r) => 'answered:' + r.status)
  .catch(() => 'unreachable')`);
check('the page cannot reach the origin any more', reachable === 'answered:504' || reachable === 'unreachable', reachable);

// Extra proof: the socket is gone at the TCP level, not just from the page.
const tcpProbe = await fetch(`${BASE}/alive-check.html`, { cache: 'no-store' })
  .then((r) => `answered:${r.status}`)
  .catch(() => 'unreachable');
check('no HTTP listener remains on the site port', tcpProbe === 'unreachable', tcpProbe);

// Open the essay from the library using only the cached shell + cached data.
await evalJs(`location.hash = '#/'`);
await sleep(800);
const tileOk = await evalJs(`document.querySelectorAll('.tile').length`);
check('essay list is available with the server gone', tileOk >= 1, `tiles=${tileOk}`);

await clickEl(`document.querySelector('.tile button[data-act="open"]')`);
await sleep(1000);

const targets = ['notebook', 'confession', 'distracted'];
for (const word of targets) {
  const exists = await evalJs(`!![...document.querySelectorAll('.w')].find(w => w.dataset.w === ${JSON.stringify(word)})`);
  if (!exists) continue;
  await clickEl(`[...document.querySelectorAll('.w')].find(w => w.dataset.w === ${JSON.stringify(word)})`);
  await sleep(1800);
}

const offlineCards = await evalJs(`JSON.stringify([...document.querySelectorAll('.card')].map(c => ({
  word: c.querySelector('.card__word')?.textContent,
  zh: (c.querySelector('.card__zh')?.textContent || '').slice(0, 26),
  ipa: c.querySelector('.card__ipa')?.textContent || ''
})))`);
const parsed = JSON.parse(offlineCards);
const withChinese = parsed.filter((c) => CJK.test(c.zh || ''));
check('words resolve to Chinese meanings with NO server and NO network', withChinese.length >= 2, offlineCards);

const shot1 = await send('Page.captureScreenshot', { format: 'png' });
fs.writeFileSync(path.join(OUT_DIR, '10-offline-mobile.png'), Buffer.from(shot1.data, 'base64'));

/* 6 — a full cold start offline (new document, cache only) */
await send('Page.reload');
await sleep(3000);
const coldStart = await evalJs(`({
  loaded: !!document.querySelector('.brand'),
  cards: document.querySelectorAll('.card').length,
  view: document.body.dataset.view
})`);
check('app boots from cache with the server down', coldStart.loaded === true, JSON.stringify(coldStart));

await evalJs(`location.hash = '#/words'`);
await sleep(700);
const saved = await evalJs(`document.querySelectorAll('.wrow').length`);
check('saved words survive offline', saved >= 2, `rows=${saved}`);

/* 7 — settings reports the bundled dictionary */
await evalJs(`location.hash = '#/settings'`);
await sleep(1200);
const dictState = await evalJs(`({
  status: document.getElementById('netStatus').textContent,
  install: document.getElementById('installState').textContent
})`);
check('settings shows the bundled dictionary as ready', /entries/.test(dictState.status) && !/unreachable/i.test(dictState.status), dictState.status);
console.log('      install note:', dictState.install);

/* 8 — no Chinese leaked into the chrome, offline included */
const audit = await evalJs(`(() => {
  const allowed = ['.card', '.wrow', '.para', '.tile__excerpt'];
  const cjk = /[\\u4e00-\\u9fff]/;
  const out = [];
  const walker = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT);
  let n;
  while ((n = walker.nextNode())) {
    if (!cjk.test(n.nodeValue || '')) continue;
    let el = n.parentElement, ok = false;
    while (el && el !== document.body) {
      if (allowed.some(s => el.classList && el.classList.contains(s.slice(1)))) { ok = true; break; }
      el = el.parentElement;
    }
    if (!ok) out.push((n.nodeValue || '').trim().slice(0, 20));
  }
  return out;
})()`);
check('interface chrome stays English while offline', audit.length === 0, audit.join(' | '));

const shot2 = await send('Page.captureScreenshot', { format: 'png' });
fs.writeFileSync(path.join(OUT_DIR, '11-offline-settings.png'), Buffer.from(shot2.data, 'base64'));

console.log(`\n${results.filter((r) => r.ok).length}/${results.length} checks passed`);
if (problems.length) {
  console.log('\nbrowser problems:');
  for (const p of problems) console.log('  ' + p);
}

ws.close();
proc.kill('SIGTERM');
await sleep(600);
try { if (proc.exitCode === null) proc.kill('SIGKILL'); } catch { /* ignore */ }
try { site.close(); } catch { /* already closed */ }
process.exit(results.every((r) => r.ok) && problems.length === 0 ? 0 : 1);
