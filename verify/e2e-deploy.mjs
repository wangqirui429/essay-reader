/**
 * Verify the built deployment package (dist/) served at a domain ROOT, which is
 * how Netlify / Vercel / Cloudflare Pages behave.
 *
 * Also asserts that no personal reading data is present in the package.
 *
 * Usage: node verify/e2e-deploy.mjs [baseUrl]
 */

import fs from 'node:fs';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const BASE = process.argv[2] || 'http://127.0.0.1:5199/';
const HERE = path.dirname(fileURLToPath(import.meta.url));
const OUT_DIR = path.join(HERE, 'shots');
const DIST = path.join(HERE, '..', 'dist');
const PORT = 9381;
const CJK = /[\u3400-\u4dbf\u4e00-\u9fff]/;

fs.mkdirSync(OUT_DIR, { recursive: true });
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const results = [];
const check = (name, ok, detail = '') => {
  results.push({ name, ok });
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? ` — ${detail}` : ''}`);
};

/* ------------------------------- package hygiene (before touching a browser) */

const personalFiles = [];
function scan(dir) {
  for (const name of fs.readdirSync(dir)) {
    const full = path.join(dir, name);
    if (fs.statSync(full).isDirectory()) scan(full);
    else if (/^[a-z']+-[a-z0-9]+\.json$/.test(name) && path.basename(path.dirname(full)) === 'cache') {
      personalFiles.push(full);
    }
  }
}
if (fs.existsSync(DIST)) scan(DIST);
check('package contains no saved word cache', personalFiles.length === 0, personalFiles.join(', ') || 'none');

const distFiles = [];
(function walk(dir) {
  for (const name of fs.readdirSync(dir)) {
    const full = path.join(dir, name);
    if (fs.statSync(full).isDirectory()) walk(full);
    else distFiles.push(full);
  }
})(DIST);
const distBytes = distFiles.reduce((s, f) => s + fs.statSync(f).size, 0);
check('package size is reasonable for mobile download', distBytes < 12 * 1024 * 1024, `${(distBytes / 1024 / 1024).toFixed(2)} MB in ${distFiles.length} files`);
check('host config files are present', ['_headers', '.nojekyll', 'vercel.json'].every((f) => fs.existsSync(path.join(DIST, f))));

/* ------------------------------------------------------------- browser run */

const exe = 'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe';
const profile = path.join(process.env.TEMP, `er-deploy-${Date.now()}`);
const proc = spawn(exe, ['--headless=new', `--remote-debugging-port=${PORT}`, `--user-data-dir=${profile}`, '--no-first-run', BASE], { stdio: 'ignore' });

let version = null;
for (let i = 0; i < 100 && !version; i += 1) {
  await sleep(300);
  try { version = await (await fetch(`http://127.0.0.1:${PORT}/json/version`)).json(); } catch { /* retry */ }
}
if (!version) { console.error('browser failed to start — is the dist server running?'); proc.kill(); process.exit(1); }

const page = (await (await fetch(`http://127.0.0.1:${PORT}/json/list`)).json()).find((t) => t.type === 'page');
const ws = new WebSocket(page.webSocketDebuggerUrl);
await new Promise((res, rej) => { ws.addEventListener('open', res, { once: true }); ws.addEventListener('error', rej, { once: true }); });

let id = 0;
const pending = new Map();
const problems = [];
const failures = [];
ws.addEventListener('message', (ev) => {
  const m = JSON.parse(ev.data);
  if (m.method === 'Runtime.exceptionThrown') {
    problems.push(m.params.exceptionDetails.exception?.description || m.params.exceptionDetails.text);
  }
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
await send('Emulation.setDeviceMetricsOverride', { width: 390, height: 844, deviceScaleFactor: 2, mobile: true });
await sleep(2600);

check('deployed app renders at the domain root', await evalJs(`!!document.querySelector('.brand') && getComputedStyle(document.body).backgroundColor !== 'rgba(0, 0, 0, 0)'`));

const sw = await evalJs(`(async () => {
  const reg = await navigator.serviceWorker.getRegistration();
  return { registered: !!reg, active: !!(reg && reg.active) };
})()`);
check('service worker installs on the host', sw.registered && sw.active, JSON.stringify(sw));

const dict = await evalJs(`(async () => {
  const { loadDictionary, lookupOffline, dictSize } = await import('./js/dict-offline.js');
  await loadDictionary();
  const hit = await lookupOffline('gallows');
  return { size: dictSize(), zh: hit?.entry?.glosses?.[0]?.text || '' };
})()`);
check('dictionary works on a phone viewport', dict.size > 1000 && CJK.test(dict.zh), `${dict.size} words, gallows -> ${dict.zh}`);

// Import and pin a word, exactly as a first-time visitor would
await evalJs(`(() => {
  document.getElementById('impTitle').value = 'Deploy Smoke Test';
  document.getElementById('impText').value = 'The hangman waited beside the gallows while the warders unbound the prisoner. A silence settled on the courtyard and nobody spoke.';
  document.getElementById('impSave').click();
})()`);
await sleep(900);

const tokenList = await evalJs(`[...document.querySelectorAll('.w')].map(w => w.dataset.w).join(',')`);
console.log('      tokens on the page:', tokenList);
await clickEl(`[...document.querySelectorAll('.w')].find(w => w.dataset.w === 'gallows')`);
await sleep(2400);

const card = await evalJs(`JSON.stringify([...document.querySelectorAll('.card')].map(c => ({
  word: c.querySelector('.card__word')?.textContent,
  zh: (c.querySelector('.card__zh')?.textContent || '').slice(0, 24)
})))`);
const parsed = JSON.parse(card);
check('a first-time visitor can pin a meaning', parsed.length === 1 && CJK.test(parsed[0].zh), card);

// The card must survive scrolling on a deployed build too
await evalJs(`window.scrollBy(0, 200)`);
await sleep(400);
await sleep(2000);
const stillThere = await evalJs(`document.querySelectorAll('.card').length`);
check('pinned meaning survives scroll and idle when deployed', stillThere === 1, `cards=${stillThere}`);

const shot = await send('Page.captureScreenshot', { format: 'png' });
fs.writeFileSync(path.join(OUT_DIR, '13-deployed-root.png'), Buffer.from(shot.data, 'base64'));

// Saved words were recorded in this browser only
await evalJs(`location.hash = '#/words'`);
await sleep(600);
const saved = await evalJs(`document.querySelectorAll('.wrow').length`);
check('saved words are stored per browser, not shipped', saved >= 1, `rows=${saved}`);

const real = failures.filter((u) => !u.includes('/api/'));
check('no 404s on the deployed build', real.length === 0, real.join(' | ') || 'none');

console.log(`\n${results.filter((r) => r.ok).length}/${results.length} checks passed`);
if (problems.length) {
  console.log('\nbrowser problems:');
  for (const p of problems) console.log('  ' + p);
}

ws.close();
proc.kill('SIGTERM');
await sleep(500);
try { if (proc.exitCode === null) proc.kill('SIGKILL'); } catch { /* ignore */ }
process.exit(results.every((r) => r.ok) && problems.length === 0 ? 0 : 1);
