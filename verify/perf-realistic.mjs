/**
 * Measure the experience a real reader has, not a synthetic worst case.
 *
 * A synthetic test imports the dictionary module fresh and clicks instantly,
 * which no visitor does. A visitor loads the page, pastes an essay, reads for a
 * moment, and only then clicks a word. This script follows that path and reports
 * the delay between the click and the Chinese meaning appearing.
 *
 * Usage: node verify/perf-realistic.mjs [url] [dwellSeconds]
 */

import path from 'node:path';
import fs from 'node:fs';
import { spawn } from 'node:child_process';

const URL_TO_TEST = process.argv[2] || 'https://wangqirui429.github.io/essay-reader/';
const DWELL = Number(process.argv[3] || 8);
const PORT = 9431;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const results = [];
const check = (name, ok, detail = '') => {
  results.push({ name, ok });
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? ` — ${detail}` : ''}`);
};

const profile = path.join(process.env.TEMP, `er-real-${Date.now()}`);
const exe = 'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe';
// Start blank and navigate explicitly, so the emulation and the debugger are in
// place before the page's own scripts run.
const proc = spawn(exe, ['--headless=new', `--remote-debugging-port=${PORT}`, `--user-data-dir=${profile}`, '--no-first-run', '--disable-sync', 'about:blank'], { stdio: 'ignore' });

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
ws.addEventListener('message', (ev) => {
  const m = JSON.parse(ev.data);
  const job = pending.get(m.id);
  if (job) { pending.delete(m.id); m.error ? job.rej(new Error(m.error.message)) : job.res(m.result); }
});
const send = (method, params = {}) => new Promise((res, rej) => { const i = ++id; pending.set(i, { res, rej }); ws.send(JSON.stringify({ id: i, method, params })); });
const evalJs = async (expr) => {
  const r = await send('Runtime.evaluate', { expression: expr, awaitPromise: true, returnByValue: true });
  if (r.exceptionDetails) throw new Error(r.exceptionDetails.exception?.description || 'eval threw');
  return r.result.value;
};

await send('Page.enable');
await send('Runtime.enable');
await send('Emulation.setDeviceMetricsOverride', { width: 414, height: 896, deviceScaleFactor: 2, mobile: true });

const tPage = Date.now();
await send('Page.navigate', { url: URL_TO_TEST });
await sleep(4000);
console.log(`page loaded: ${Date.now() - tPage} ms\n`);

const appReady = await evalJs(`(async () => {
  for (let i = 0; i < 40; i++) {
    if (document.getElementById('impSave') && document.querySelector('.brand')) return true;
    await new Promise(r => setTimeout(r, 250));
  }
  return false;
})()`);
if (!appReady) {
  console.log('FAIL  the app never became interactive');
  ws.close();
  proc.kill();
  process.exit(1);
}

// The reader pastes an essay — this is the normal first action.
const importResult = await evalJs(`(() => {
  const text = document.getElementById('impText');
  const btn = document.getElementById('impSave');
  if (!text || !btn) return { error: 'import form missing', hash: location.hash };
  text.value = ${JSON.stringify(
    'A Slow Walk\n\nThe condemned man stepped aside to avoid a puddle, while the hangman waited beside the gallows. Nobody spoke.\n\nThe warders tightened their grip on his bound arms and the rope hung still above them.',
  )};
  document.getElementById('impTitle').value = 'Realistic Timing';
  btn.click();
  return { clicked: true, hashAfter: location.hash, status: document.getElementById('impStatus')?.textContent || '' };
})()`);
console.log(`import: ${JSON.stringify(importResult)}`);
await sleep(2000);

// Wait for the reader view to actually be populated. A cold first visit can be
// slow to fetch everything, so poll rather than assume.
const pageState = await evalJs(`(async () => {
  for (let i = 0; i < 60; i++) {
    const tokens = document.querySelectorAll('.w').length;
    if (tokens > 0) break;
    await new Promise(r => setTimeout(r, 250));
  }
  return {
    hash: location.hash,
    tokens: document.querySelectorAll('.w').length,
    paras: document.querySelectorAll('.para').length,
    title: document.getElementById('essayTitle')?.textContent || '',
    view: document.body.dataset.view
  };
})()`);
console.log(`page state: ${JSON.stringify(pageState)}\n`);

// They read for a while before touching a word.
console.log(`reader reads for ${DWELL}s...`);
await sleep(DWELL * 1000);

// Now the actual click, timed from press to Chinese text on screen.
const clickTiming = await evalJs(`(async () => {
  const word = [...document.querySelectorAll('.w')].find(w => w.dataset.w === 'gallows');
  if (!word) return { ms: -2, text: '', reason: 'word not found' };

  word.scrollIntoView({ block: 'center' });
  const r = word.getBoundingClientRect();
  const x = r.left + r.width / 2;
  const y = r.top + r.height / 2;

  const t0 = performance.now();
  for (const type of ['mousedown', 'mouseup', 'click']) {
    word.dispatchEvent(new MouseEvent(type, { bubbles: true, clientX: x, clientY: y }));
  }

  const cjk = /[\\u4e00-\\u9fff]/;
  for (let i = 0; i < 300; i++) {
    for (const card of document.querySelectorAll('.card')) {
      const zh = card.querySelector('.card__zh');
      if (zh && cjk.test(zh.textContent || '')) {
        return { ms: Math.round(performance.now() - t0), text: zh.textContent.slice(0, 28), shown: true };
      }
    }
    await new Promise(r => setTimeout(r, 50));
  }
  return { ms: -1, text: '', reason: 'timeout' };
})()`);

const firstMs = typeof clickTiming === 'object' ? clickTiming.ms : clickTiming;
console.log(`\nclick → Chinese meaning: ${firstMs} ms  "${clickTiming.text || ''}"`);

check('a word clicked after reading is answered quickly', firstMs >= 0 && firstMs <= 2000, `${firstMs} ms (target <= 2000)`);

// A second word, immediately after — should be instant.
const second = await evalJs(`(async () => {
  const word = [...document.querySelectorAll('.w')].find(w => w.dataset.w === 'puddle');
  if (!word) return { ms: -2, text: '', reason: 'word not found' };
  word.scrollIntoView({ block: 'center' });
  const r = word.getBoundingClientRect();
  const t0 = performance.now();
  for (const type of ['mousedown', 'mouseup', 'click']) {
    word.dispatchEvent(new MouseEvent(type, { bubbles: true, clientX: r.left + r.width/2, clientY: r.top + r.height/2 }));
  }
  const cjk = /[\\u4e00-\\u9fff]/;
  for (let i = 0; i < 200; i++) {
    for (const card of document.querySelectorAll('.card')) {
      const w = card.querySelector('.card__word');
      const zh = card.querySelector('.card__zh');
      if (w && w.textContent === 'puddle' && zh && cjk.test(zh.textContent || '')) {
        return { ms: Math.round(performance.now() - t0), text: zh.textContent.slice(0, 24) };
      }
    }
    await new Promise(r => setTimeout(r, 50));
  }
  return { ms: -1, text: '', reason: 'timeout' };
})()`);

const secondMs = typeof second === 'object' ? second.ms : second;
console.log(`second word: ${secondMs} ms  "${second.text || ''}"`);
check('a second word is answered quickly', secondMs >= 0 && secondMs <= 1500, `${secondMs} ms`);

// How much of the dictionary had arrived by the time of the first click?
const progress = await evalJs(`(async () => {
  const mod = await import('./js/dict-offline.js');
  return { words: mod.dictSize(), progress: mod.coreProgress ? mod.coreProgress() : null };
})()`);
console.log(`\ndictionary state at click time: ${progress.words} words, chunks ${JSON.stringify(progress.progress)}`);

console.log(`\n${results.filter((r) => r.ok).length}/${results.length} checks passed`);

ws.close();
proc.kill('SIGTERM');
await sleep(500);
try { if (proc.exitCode === null) proc.kill('SIGKILL'); } catch { /* ignore */ }
try { fs.rmSync(profile, { recursive: true, force: true }); } catch { /* ignore */ }
process.exit(results.every((r) => r.ok) ? 0 : 1);
