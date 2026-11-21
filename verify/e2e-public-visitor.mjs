/**
 * Verify the public site works for a first-time visitor with NO GitHub account
 * and NO login of any kind — the actual question being "must other computers
 * sign in?".
 *
 * Uses a brand-new browser profile (no cookies, no session) and generous waits,
 * because a cold GitHub Pages cache can be slow on the first dictionary fetch.
 *
 * Usage: node verify/e2e-public-visitor.mjs [url]
 */

import fs from 'node:fs';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const URL_TO_TEST = process.argv[2] || 'https://wangqirui429.github.io/essay-reader/';
const HERE = path.dirname(fileURLToPath(import.meta.url));
const OUT_DIR = path.join(HERE, 'shots');
const PORT = 9401;
const CJK = /[\u3400-\u4dbf\u4e00-\u9fff]/;

fs.mkdirSync(OUT_DIR, { recursive: true });
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const results = [];
const check = (name, ok, detail = '') => {
  results.push({ name, ok });
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? ` — ${detail}` : ''}`);
};

const profile = path.join(process.env.TEMP, `er-visitor-${Date.now()}`);
const exe = 'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe';

// A clean profile: no logins, no cookies, nothing pre-installed.
const proc = spawn(exe, [
  '--headless=new',
  `--remote-debugging-port=${PORT}`,
  `--user-data-dir=${profile}`,
  '--no-first-run',
  '--no-default-browser-check',
  '--disable-sync',
  URL_TO_TEST,
], { stdio: 'ignore' });

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
await sleep(5000);

/* 1 — no account is involved: prove the browser holds no login state */
const anonymous = await evalJs(`({
  cookies: document.cookie.length,
  storageKeys: Object.keys(localStorage),
  loggedInHint: /sign in|log in/i.test(document.body.innerText) ? 'page shows a login prompt' : 'no login prompt'
})`);
check('opened anonymously, with no sign-in of any kind', anonymous.loggedInHint === 'no login prompt', JSON.stringify(anonymous));

/* 2 — the app renders */
const shell = await evalJs(`({
  brand: !!document.querySelector('.brand'),
  title: document.title,
  styled: getComputedStyle(document.body).backgroundColor
})`);
check('the page renders for a stranger', shell.brand && shell.styled !== 'rgba(0, 0, 0, 0)', `${shell.title}`);

/* 3 — dictionary loads, with a wait long enough for a cold cache */
const dict = await evalJs(`(async () => {
  const { loadDictionary, lookupOffline, dictSize } = await import('./js/dict-offline.js');
  const t0 = Date.now();
  await loadDictionary();
  const hit = await lookupOffline('sodden');
  return { size: dictSize(), ms: Date.now() - t0, zh: hit?.entry?.glosses?.[0]?.text || '' };
})()`);
check('dictionary downloads for a stranger', dict.size > 1000 && CJK.test(dict.zh), `${dict.size} words in ${(dict.ms / 1000).toFixed(1)}s`);

/* 4 — import and pin, waiting for the card to finish loading */
await evalJs(`(() => {
  document.getElementById('impTitle').value = 'Visitor Test';
  document.getElementById('impText').value = 'The condemned man stepped aside to avoid a puddle, while the hangman waited beside the gallows.';
  document.getElementById('impSave').click();
})()`);
await sleep(1200);

await clickEl(`[...document.querySelectorAll('.w')].find(w => w.dataset.w === 'gallows')`);
await evalJs(`(async () => {
  for (let i = 0; i < 60; i++) {
    const z = document.querySelector('.card .card__zh');
    if (z && z.textContent.trim()) return true;
    await new Promise(r => setTimeout(r, 500));
  }
  return false;
})()`);

const card = await evalJs(`JSON.stringify([...document.querySelectorAll('.card')].map(c => ({
  word: c.querySelector('.card__word')?.textContent,
  zh: (c.querySelector('.card__zh')?.textContent || '').slice(0, 26)
})))`);
const parsed = JSON.parse(card);
check('a stranger can pin a Chinese meaning', parsed.length === 1 && CJK.test(parsed[0].zh || ''), card);

/* 5 — the pin persists */
await evalJs(`window.scrollBy(0, 180)`);
await sleep(2500);
check('the meaning stays pinned', await evalJs(`document.querySelectorAll('.card').length`) === 1);

/* 6 — saved words are recorded */
await evalJs(`location.hash = '#/words'`);
await sleep(800);
check('words are saved for this visitor', await evalJs(`document.querySelectorAll('.wrow').length`) >= 1);

const shot = await send('Page.captureScreenshot', { format: 'png' });
fs.writeFileSync(path.join(OUT_DIR, '16-anonymous-visitor.png'), Buffer.from(shot.data, 'base64'));

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
