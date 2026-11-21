/**
 * The real thing: connect the published app to the real api.github.com with a
 * real token, let it create its gist, and check the essay actually lands there.
 *
 * Every other sync test uses a local double. This one spends real requests
 * against GitHub, on the deployed origin, which is the only way to be sure that
 * a first-time reader will not hit a wall.
 *
 * It deletes the gist it created and clears the browser session afterwards, so
 * the account is left exactly as it was found.
 *
 * Usage: $env:GH_TOKEN = (gh auth token); node verify/e2e-live-sync.mjs
 */

import { spawn } from 'node:child_process';
import path from 'node:path';
import fs from 'node:fs';

const URL_TO_TEST = process.argv[2] || 'https://wangqirui429.github.io/essay-reader/';
const TOKEN = process.env.GH_TOKEN;
if (!TOKEN) {
  console.error('GH_TOKEN is not set. Use: $env:GH_TOKEN = (gh auth token)');
  process.exit(1);
}

const PORT = 9551;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const API = 'https://api.github.com';
const HEADERS = {
  Accept: 'application/vnd.github+json',
  'X-GitHub-Api-Version': '2022-11-28',
  Authorization: `Bearer ${TOKEN}`,
  'Content-Type': 'application/json',
};

const results = [];
function check(ok, label, detail = '') {
  results.push({ ok, label, detail });
  console.log(`${ok ? 'ok  ' : 'FAIL'} ${label}${detail ? ` — ${detail}` : ''}`);
}

/* ------------------------------------------------------- github side helper */

async function gists() {
  const res = await fetch(`${API}/gists?per_page=100`, { headers: HEADERS });
  if (!res.ok) throw new Error(`listing gists failed: ${res.status}`);
  return res.json();
}

const created = new Set(); // gist ids this run is responsible for

/* ------------------------------------------------------------------- chrome */

const profile = path.join(process.env.TEMP, `er-live-sync-${Date.now()}`);
const exe = 'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe';
const proc = spawn(exe, ['--headless=new', `--remote-debugging-port=${PORT}`, `--user-data-dir=${profile}`, '--no-first-run', 'about:blank'], { stdio: 'ignore' });

let version = null;
for (let i = 0; i < 100 && !version; i += 1) {
  await sleep(300);
  try { version = await (await fetch(`http://127.0.0.1:${PORT}/json/version`)).json(); } catch { /* retry */ }
}
if (!version) { console.error('browser failed to start'); proc.kill(); process.exit(1); }

const page = (await (await fetch(`http://127.0.0.1:${PORT}/json/list`)).json()).find((t) => t.type === 'page');
const ws = new WebSocket(page.webSocketDebuggerUrl);
await new Promise((res) => ws.addEventListener('open', res, { once: true }));

let id = 0;
const pending = new Map();
const problems = [];
ws.addEventListener('message', (ev) => {
  const m = JSON.parse(ev.data);
  if (m.method === 'Runtime.exceptionThrown') problems.push(`exception: ${m.params.exceptionDetails.exception?.description || m.params.exceptionDetails.text}`);
  if (m.method === 'Network.loadingFailed' && !m.params.errorText.includes('ERR_ABORTED')) problems.push(`network: ${m.params.errorText}`);
  const job = pending.get(m.id);
  if (job) { pending.delete(m.id); job(m.result); }
});
const send = (method, params = {}) => new Promise((resolve) => {
  const i = ++id;
  pending.set(i, resolve);
  ws.send(JSON.stringify({ id: i, method, params }));
  setTimeout(() => { if (pending.has(i)) { pending.delete(i); resolve({ timedOut: true }); } }, 30000);
});
const evalJs = async (expr) => {
  const r = await send('Runtime.evaluate', { expression: expr, returnByValue: true, awaitPromise: true });
  if (r.exceptionDetails) throw new Error(r.exceptionDetails.exception?.description || 'threw');
  return r.result?.value;
};
const waitFor = async (expr, label, timeoutMs = 30000) => {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try { if (await evalJs(expr)) return Date.now(); } catch { /* mid-navigation */ }
    await sleep(200);
  }
  throw new Error(`timed out waiting for ${label}`);
};

try {
  await send('Page.enable');
  await send('Runtime.enable');
  await send('Network.enable');

  const before = (await gists()).length;
  console.log(`gists before this run: ${before}`);

  send('Page.navigate', { url: URL_TO_TEST });
  // The shelf is rendered by app.js, so it is a real boot signal; #impSave
  // exists in the markup before any handler is bound to it.
  await waitFor(`!!document.querySelector('.shelf__empty, #shelf .tile')`, 'app boot');
  await evalJs(`window.location.hash = '#/settings'`);
  await waitFor(`document.getElementById('authForm').hidden === false`, 'account panel ready');

  // Connect with the real token through the real form.
  await evalJs(`(() => {
    document.getElementById('authToken').value = ${JSON.stringify(TOKEN)};
    document.getElementById('authForm').requestSubmit
      ? document.getElementById('authForm').requestSubmit()
      : document.getElementById('btnSignIn').click();
    return true;
  })()`);

  await waitFor(`document.getElementById('accountSignedIn').hidden === false`, 'connected to github', 30000);
  check(true, 'the published app connects to api.github.com with a real token');

  const who = (await evalJs(`document.getElementById('accountEmail').textContent`)).trim();
  check(/^@\w+/.test(who), 'the panel shows the real account', who);

  await waitFor(`document.getElementById('syncState').textContent.length > 0`, 'a sync status line');
  await waitFor(`!!document.getElementById('syncState')`, 'status element');

  // Give the first sync a moment to create the gist.
  let list = [];
  const deadline = Date.now() + 45000;
  while (Date.now() < deadline) {
    list = (await gists()).filter((g) => g.description === 'Essay Reader sync');
    if (list.length > 0) break;
    await sleep(1000);
  }
  for (const g of list) created.add(g.id);
  check(list.length === 1, 'a real private gist named "Essay Reader sync" was created', `count=${list.length}`);
  if (list[0]) check(list[0].public === false, 'that gist is secret, not public');

  // Now put something in it and confirm it travels.
  await evalJs(`window.location.hash = '#/'`);
  await waitFor(`!document.getElementById('impText').closest('.view').hidden`, 'home view');
  await evalJs(`(() => {
    document.getElementById('impTitle').value = 'Live Sync Check';
    document.getElementById('impText').value = 'A paragraph written only to prove the live sync path works end to end.\\n\\nReading on one device and continuing on another should feel like one shelf, not two.';
    document.getElementById('impSave').click();
    return true;
  })()`);
  await waitFor(`document.querySelectorAll('#essayBody .w').length > 0`, 'essay opened');
  // Pick a real content word: the first token of the paragraph is an article,
  // and the dictionary has less to say about those.
  const clickedWord = await evalJs(`(() => {
    const w = [...document.querySelectorAll('#essayBody .w')].find((x) => x.textContent.trim().length >= 4)
      || document.querySelector('#essayBody .w');
    w.click();
    return w.textContent.trim();
  })()`);
  try {
    await waitFor(`!!document.querySelector('.card .card__zh')`, 'meaning card', 45000);
  } catch (err) {
    const state = await evalJs(`(() => {
      const card = document.querySelector('.card');
      return {
        cards: document.querySelectorAll('.card').length,
        cardClass: card ? card.className : null,
        cardText: card ? card.textContent.replace(/\\s+/g, ' ').trim().slice(0, 120) : null,
        zhCount: document.querySelectorAll('.card__zh').length,
        dictWords: window.__dictWords || null,
      };
    })()`);
    throw new Error(`${err.message} (word="${clickedWord}" state=${JSON.stringify(state)})`);
  }
  check(true, 'one tap on a word opens the meaning card on the live site', `word=${clickedWord}`);

  await evalJs(`window.location.hash = '#/settings'`);
  await waitFor(`!!document.getElementById('btnSyncNow')`, 'sync button');
  await evalJs(`document.getElementById('btnSyncNow').click()`);
  await waitFor(`document.getElementById('syncState').textContent.includes('已同步')`, 'sync finished', 45000);
  check(true, 'an explicit sync reports success on the live site');

  // Read the gist back from Node, so the browser is not grading its own work.
  const gistId = [...created][0];
  let body = null;
  if (gistId) {
    const res = await fetch(`${API}/gists/${gistId}`, { headers: HEADERS });
    check(res.ok, 'the gist can be read back with the REST API', `status=${res.status}`);
    if (res.ok) {
      const gist = await res.json();
      const raw = gist.files?.['essay-reader.json']?.content;
      check(!!raw, 'the gist holds essay-reader.json', raw ? `${raw.length} chars` : 'missing');
      try { body = JSON.parse(raw); } catch { body = null; }
      check(body?.app === 'essay-reader' && body?.version === 1, 'the file carries the expected envelope', JSON.stringify(body && { app: body.app, version: body.version }));
      const snap = body?.snapshot || body || {};
      const titles = Object.values(snap.essays || {}).map((e) => e.title);
      check(titles.includes('Live Sync Check'), 'the essay really reached GitHub', titles.join(', ') || 'none');
      check(Object.keys(snap.words || {}).length >= 1, 'the looked-up word really reached GitHub', Object.keys(snap.words || {}).join(', ') || 'none');
    }
  }

  // Disconnect in the browser, so the session is not left in the profile.
  if (await evalJs(`document.getElementById('accountSignedIn').hidden === false`)) {
    await evalJs(`document.getElementById('btnSignOut').click()`);
    await waitFor(`document.getElementById('authForm').hidden === false`, 'disconnected');
  }
  check(true, 'the app disconnects cleanly');

  const bad = problems.filter((p) => !/favicon/i.test(p));
  check(bad.length === 0, 'no runtime exceptions or failed requests', bad.slice(0, 3).join(' | '));

  const passed = results.filter((r) => r.ok).length;
  console.log(`\n${passed}/${results.length} checks passed`);
  process.exitCode = passed === results.length ? 0 : 1;
} catch (err) {
  console.error(`\nFAILED: ${err.message}`);
  process.exitCode = 1;
} finally {
  // Clean up: whatever this run created in the real account must not survive.
  for (const gid of created) {
    try {
      const res = await fetch(`${API}/gists/${gid}`, { method: 'DELETE', headers: HEADERS });
      console.log(`cleanup: deleted gist ${gid} -> ${res.status}`);
    } catch (err) {
      console.log(`cleanup FAILED for ${gid}: ${err.message}`);
    }
  }
  try {
    const after = (await gists()).length;
    console.log(`gists after this run: ${after}`);
  } catch { /* ignore */ }
  try { ws.close(); } catch { /* ignore */ }
  try { proc.kill(); } catch { /* ignore */ }
  await sleep(500);
  try { fs.rmSync(profile, { recursive: true, force: true }); } catch { /* ignore */ }
}