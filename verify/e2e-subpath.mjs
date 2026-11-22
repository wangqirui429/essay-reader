/**
 * Verify the app works when hosted under a SUB-PATH, which is how GitHub Pages
 * project sites behave (https://user.github.io/essay-reader/).
 *
 * A sub-path deploy is the classic way a PWA white-screens: absolute asset
 * paths, a service worker whose scope misses the app, or a manifest start_url
 * pointing at the domain root. This suite serves public/ from /essay-reader/
 * and checks the install, the dictionary and the pinned cards.
 *
 * Usage: node verify/e2e-subpath.mjs
 */

import fs from 'node:fs';
import path from 'node:path';
import http from 'node:http';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const PUBLIC_DIR = path.join(HERE, '..', 'public');
const OUT_DIR = path.join(HERE, 'shots');
const SITE_PORT = Number(process.env.SITE_PORT || 5191);
const SUBPATH = '/essay-reader';
const BASE = `http://127.0.0.1:${SITE_PORT}${SUBPATH}/`;
const PORT = 9371;
const CJK = /[\u3400-\u4dbf\u4e00-\u9fff]/;

fs.mkdirSync(OUT_DIR, { recursive: true });
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.png': 'image/png',
  '.txt': 'text/plain; charset=utf-8',
  '.webmanifest': 'application/manifest+json',
};

/* --------------------------- serve public/ under a sub-path ---------------- */

const site = http.createServer((req, res) => {
  const urlPath = decodeURIComponent(new URL(req.url, 'http://localhost').pathname);
  if (!urlPath.startsWith(SUBPATH)) {
    res.writeHead(404, { 'Content-Type': 'text/plain' }).end('outside the app sub-path');
    return;
  }
  let rel = urlPath.slice(SUBPATH.length) || '/';
  if (rel === '/') rel = '/index.html';
  if (rel.startsWith('/api/')) {
    res.writeHead(404, { 'Content-Type': 'text/plain' }).end('no api');
    return;
  }
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
    res.writeHead(200, {
      'Content-Type': MIME[path.extname(file).toLowerCase()] || 'application/octet-stream',
      'Cache-Control': rel.endsWith('sw.js') ? 'no-cache' : 'public, max-age=300',
    }).end(buf);
  });
});

await new Promise((r) => site.listen(SITE_PORT, '127.0.0.1', r));
console.log(`serving public/ at ${BASE}\n`);

/* ------------------------------------ browser ---------------------------- */

const results = [];
const check = (name, ok, detail = '') => {
  results.push({ name, ok });
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? ` — ${detail}` : ''}`);
};

const exe = 'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe';
const profile = path.join(process.env.TEMP, `er-subpath-${Date.now()}`);
const proc = spawn(exe, ['--headless=new', `--remote-debugging-port=${PORT}`, `--user-data-dir=${profile}`, '--no-first-run', BASE], { stdio: 'ignore' });

let version = null;
for (let i = 0; i < 100 && !version; i += 1) {
  await sleep(300);
  try { version = await (await fetch(`http://127.0.0.1:${PORT}/json/version`)).json(); } catch { /* retry */ }
}
if (!version) { console.error('browser failed to start'); proc.kill(); site.close(); process.exit(1); }

const page = (await (await fetch(`http://127.0.0.1:${PORT}/json/list`)).json()).find((t) => t.type === 'page');
const ws = new WebSocket(page.webSocketDebuggerUrl);
await new Promise((res, rej) => { ws.addEventListener('open', res, { once: true }); ws.addEventListener('error', rej, { once: true }); });

let id = 0;
const pending = new Map();
const problems = [];
const failedRequests = [];
ws.addEventListener('message', (ev) => {
  const m = JSON.parse(ev.data);
  if (m.method === 'Runtime.exceptionThrown') {
    problems.push(m.params.exceptionDetails.exception?.description || m.params.exceptionDetails.text);
  }
  if (m.method === 'Network.responseReceived' && m.params.response.status >= 400) {
    failedRequests.push(`${m.params.response.status} ${m.params.response.url}`);
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
await sleep(2600);

/* 1 — the shell loaded at all (the classic white-screen check) */
const shell = await evalJs(`({
  hasBrand: !!document.querySelector('.brand'),
  cssApplied: getComputedStyle(document.body).backgroundColor !== 'rgba(0, 0, 0, 0)',
  jsRan: !!document.querySelector('.card-layer'),
  bodyBg: getComputedStyle(document.body).backgroundColor
})`);
check('app shell renders from a sub-path (no white screen)', shell.hasBrand && shell.cssApplied && shell.jsRan, JSON.stringify(shell));

/* 2 — service worker registers with the right scope */
const sw = await evalJs(`(async () => {
  const reg = await navigator.serviceWorker.getRegistration();
  if (!reg) return { registered: false };
  return { registered: true, scope: reg.scope, scopeUnderSubpath: reg.scope.includes('/essay-reader/') };
})()`);
check('service worker scope sits under the sub-path', sw.registered && sw.scopeUnderSubpath, JSON.stringify(sw));

/* 3 — manifest start_url resolves inside the sub-path */
const manifest = await evalJs(`fetch('manifest.json').then(r => r.json()).then(m => ({
  start_url: m.start_url,
  scope: m.scope,
  resolved: new URL(m.start_url, location.href).pathname,
  icons: (m.icons || []).length
}))`);
check('manifest start_url stays inside the sub-path', manifest.resolved.startsWith(`${SUBPATH}/`), JSON.stringify(manifest));

/* 4 — icons load with no 404s */
const icon = await evalJs(`fetch('icons/icon-192.png').then(r => r.ok ? 'ok' : 'status:' + r.status)`);
check('app icon loads', icon === 'ok', icon);

/* 5 — the dictionary loads (relative path, sub-path safe) */
const dict = await evalJs(`(async () => {
  const { loadDictionary, lookupOffline, dictSize } = await import('./js/dict-offline.js');
  await loadDictionary();
  const hit = await lookupOffline('sodden');
  return { size: dictSize(), zh: hit?.entry?.glosses?.[0]?.text || '' };
})()`);
check('bundled dictionary loads under the sub-path', dict.size > 1000 && CJK.test(dict.zh), `${dict.size} words, sodden -> ${dict.zh}`);

/* 6 — the sample essay fetches from the sub-path */
const sample = await evalJs(`fetch('samples/a-hanging.txt').then(r => r.ok ? r.text().then(t => t.length) : 'status:' + r.status)`);
check('sample essay loads under the sub-path', typeof sample === 'number' && sample > 5000, `${sample} bytes`);

/* 7 — import and click a word: the whole interaction works */
await evalJs(`(() => {
  document.getElementById('impTitle').value = 'Sub-path Test';
  document.getElementById('impText').value = 'The condemned man walked slowly past the sodden gravel, and nobody spoke about the gallows.';
  document.getElementById('impSave').click();
})()`);
await sleep(900);

await clickEl(`[...document.querySelectorAll('.w')].find(w => w.dataset.w === 'sodden')`);
await sleep(2200);

const card = await evalJs(`JSON.stringify([...document.querySelectorAll('.card')].map(c => ({
  word: c.querySelector('.card__word')?.textContent,
  zh: (c.querySelector('.card__zh')?.textContent || '').slice(0, 24)
})))`);
const parsed = JSON.parse(card);
check('clicking a word pins its Chinese meaning from the sub-path', parsed.length === 1 && CJK.test(parsed[0].zh), card);

const shot = await send('Page.captureScreenshot', { format: 'png' });
fs.writeFileSync(path.join(OUT_DIR, '12-subpath-deploy.png'), Buffer.from(shot.data, 'base64'));

/* 8 — reload under the worker: still works, still offline-capable */
await send('Page.reload');
await sleep(2800);
const reloaded = await evalJs(`({
  controlled: !!navigator.serviceWorker.controller,
  brand: !!document.querySelector('.brand'),
  essays: document.querySelectorAll('.tile').length
})`);
check('reload under the worker keeps the app intact', reloaded.brand && reloaded.controlled, JSON.stringify(reloaded));

/* 9 — no resource 404s anywhere in the run (excluding the deliberate /api probe) */
const real404s = failedRequests.filter((u) => !u.includes('/api/'));
check('no unexpected 404s under the sub-path', real404s.length === 0, real404s.join(' | ') || 'none');

console.log(`\n${results.filter((r) => r.ok).length}/${results.length} checks passed`);
if (problems.length) {
  console.log('\nbrowser problems:');
  for (const p of problems) console.log('  ' + p);
}

ws.close();
proc.kill('SIGTERM');
await sleep(500);
try { if (proc.exitCode === null) proc.kill('SIGKILL'); } catch { /* ignore */ }
site.close();
process.exit(results.every((r) => r.ok) && problems.length === 0 ? 0 : 1);
