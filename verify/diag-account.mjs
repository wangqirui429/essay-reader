/**
 * Probe why the "sync not configured" note stays hidden on the live build.
 *
 * Prints the raw state of the three account blocks plus whether the sync
 * modules actually loaded, so the failure is attributed rather than guessed.
 *
 * Usage: node verify/diag-account.mjs [url]
 */

import { spawn } from 'node:child_process';
import path from 'node:path';

const URL_TO_TEST = process.argv[2] || 'https://wangqirui429.github.io/essay-reader/';
const PORT = 9553;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const profile = path.join(process.env.TEMP, `er-diagacct-${Date.now()}`);
const exe = 'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe';

const proc = spawn(
  exe,
  ['--headless=new', `--remote-debugging-port=${PORT}`, `--user-data-dir=${profile}`, '--no-first-run', 'about:blank'],
  { stdio: 'ignore' },
);

let version = null;
for (let i = 0; i < 100 && !version; i += 1) {
  await sleep(300);
  try {
    version = await (await fetch(`http://127.0.0.1:${PORT}/json/version`)).json();
  } catch {
    /* retry */
  }
}
if (!version) {
  console.error('browser failed to start');
  proc.kill();
  process.exit(1);
}

const page = (await (await fetch(`http://127.0.0.1:${PORT}/json/list`)).json()).find((t) => t.type === 'page');
const ws = new WebSocket(page.webSocketDebuggerUrl);
await new Promise((res, rej) => {
  ws.addEventListener('open', res, { once: true });
  ws.addEventListener('error', rej, { once: true });
});

let id = 0;
const pending = new Map();
const events = [];
ws.addEventListener('message', (ev) => {
  const m = JSON.parse(ev.data);
  if (m.method === 'Runtime.exceptionThrown') {
    events.push(`EXCEPTION ${m.params.exceptionDetails.exception?.description || m.params.exceptionDetails.text}`);
  }
  if (m.method === 'Runtime.consoleAPICalled') {
    events.push(`console.${m.params.type} ${m.params.args.map((a) => a.description || a.value).join(' ')}`);
  }
  const job = pending.get(m.id);
  if (job) {
    pending.delete(m.id);
    job(m.result);
  }
});
const send = (method, params = {}) =>
  new Promise((resolve) => {
    const i = ++id;
    pending.set(i, resolve);
    ws.send(JSON.stringify({ id: i, method, params }));
    setTimeout(() => {
      if (pending.has(i)) {
        pending.delete(i);
        resolve({ timedOut: true });
      }
    }, 20000);
  });

const evaluate = async (expr) => {
  const r = await send('Runtime.evaluate', { expression: expr, returnByValue: true, awaitPromise: true });
  if (r?.exceptionDetails) return `THREW: ${r.exceptionDetails.exception?.description || r.exceptionDetails.text}`;
  return r?.result?.value;
};

await send('Page.enable');
await send('Runtime.enable');
send('Page.navigate', { url: URL_TO_TEST });
await sleep(6000);
await send('Runtime.evaluate', { expression: `window.location.hash = '#/settings'` });
await sleep(1200);

console.log('--- module state ---');
console.log('sync exported:      ', await evaluate(`typeof window.__syncProbe`));
console.log('import account.js:  ', await evaluate(`import('./js/account.js').then(()=> 'loaded').catch(e => 'FAILED: ' + e.message)`));
console.log('import sync.js:     ', await evaluate(`import('./js/sync.js').then(m => 'loaded, keys=' + Object.keys(m).join(',')).catch(e => 'FAILED: ' + e.message)`));
console.log('import auth.js:     ', await evaluate(`import('./js/auth.js').then(m => 'loaded, configured=' + m.hasConfig()).catch(e => 'FAILED: ' + e.message)`));

console.log('\n--- element state ---');
const report = await evaluate(`JSON.stringify((() => {
  const pick = (sel) => {
    const el = document.querySelector(sel);
    if (!el) return { missing: true };
    const cs = getComputedStyle(el);
    return {
      hiddenProp: el.hidden,
      hasAttr: el.hasAttribute('hidden'),
      display: cs.display,
      offsetParent: el.offsetParent ? el.offsetParent.tagName + '.' + el.offsetParent.className : null,
      rect: (() => { const r = el.getBoundingClientRect(); return [Math.round(r.width), Math.round(r.height)]; })(),
      text: (el.textContent || '').trim().slice(0, 40),
    };
  };
  return {
    card: pick('#accountCard'),
    disabled: pick('#accountDisabled'),
    form: pick('#authForm'),
    signedIn: pick('#accountSignedIn'),
    syncState: pick('#syncState'),
  };
})())`);
console.log(report);

console.log('\n--- events ---');
for (const e of events.slice(0, 25)) console.log(' ', e);

ws.close();
proc.kill();