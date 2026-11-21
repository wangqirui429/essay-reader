/**
 * Measure how quickly a word can be explained after a cold page load.
 *
 * The number that matters to a reader is not "when is the whole dictionary
 * here" but "how long after I click does the Chinese meaning appear". This
 * script measures exactly that, from a clean cache, over the real network.
 *
 * Usage: node verify/perf-cold-start.mjs [url]
 */

import path from 'node:path';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import fs from 'node:fs';

const URL_TO_TEST = process.argv[2] || 'http://127.0.0.1:5180/';
const HERE = path.dirname(fileURLToPath(import.meta.url));
const PORT = 9411;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const results = [];
const check = (name, ok, detail = '') => {
  results.push({ name, ok });
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? ` — ${detail}` : ''}`);
};

const profile = path.join(process.env.TEMP, `er-perf-${Date.now()}`);
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
await sleep(2000);

console.log(`measuring cold-start lookup latency on ${URL_TO_TEST}\n`);

// Time from calling the lookup to having a Chinese gloss, from a cold cache.
const perf = await evalJs(`(async () => {
  const mod = await import('./js/dict-offline.js');
  const t0 = performance.now();

  // A common word, asked immediately: this is the "first click" experience.
  const common = await mod.lookupOffline('sodden');
  const tCommon = performance.now() - t0;

  // A rarer word that lives outside the core chunks.
  const t1 = performance.now();
  const rare = await mod.lookupOffline('gallows');
  const tRare = performance.now() - t1;

  const t2 = performance.now();
  const unknown = await mod.lookupOffline('zzzznotaword');
  const tMiss = performance.now() - t2;

  await mod.loadDictionary();
  const tAll = performance.now() - t0;

  return {
    firstWordMs: Math.round(tCommon),
    firstWorldOk: !!common?.entry?.glosses?.length,
    rareMs: Math.round(tRare),
    rareOk: !!rare?.entry?.glosses?.length,
    missMs: Math.round(tMiss),
    missReturnedNull: unknown === null,
    fullLoadMs: Math.round(tAll),
    words: mod.dictSize(),
    progress: mod.coreProgress ? mod.coreProgress() : null,
  };
})()`);

console.log(JSON.stringify(perf, null, 1));

check('the first clicked word resolves', perf.firstWorldOk === true, `${perf.firstWordMs} ms`);
check('first click is fast enough to feel instant', perf.firstWordMs <= 4000, `${perf.firstWordMs} ms (target <= 4000)`);
check('a word outside the first chunk resolves', perf.rareOk === true, `${perf.rareMs} ms`);
check('a genuinely unknown word returns quickly', perf.missReturnedNull === true && perf.missMs <= 8000, `${perf.missMs} ms`);
check('the whole dictionary arrives in reasonable time', perf.fullLoadMs <= 30000, `${(perf.fullLoadMs / 1000).toFixed(1)} s`);

console.log(`\n${results.filter((r) => r.ok).length}/${results.length} checks passed`);

ws.close();
proc.kill('SIGTERM');
await sleep(500);
try { if (proc.exitCode === null) proc.kill('SIGKILL'); } catch { /* ignore */ }
try { fs.rmSync(profile, { recursive: true, force: true }); } catch { /* ignore */ }
process.exit(results.every((r) => r.ok) ? 0 : 1);
