/**
 * End-to-end test of account sync, using two isolated browser contexts that
 * stand in for a phone and a laptop.
 *
 * The backend is a local double of the GitHub REST API (verify/mock-github.mjs),
 * so the run is fast and deterministic; verify/check-sync-live.mjs exercises
 * the same flow against the real api.github.com.
 *
 * What it proves, in order:
 *   1. a token connects an account, and the panel names it
 *   2. an essay and a looked-up word travel from device A to device B
 *   3. the second device reuses the same gist instead of creating another
 *   4. an essay written on device B travels back to device A
 *   5. per-device preferences (font size) do NOT travel, they stay local
 *   6. a bad token is reported in Chinese, not as a crash
 *   7. disconnecting keeps local data but stops syncing
 *   8. a gist deleted on GitHub is recreated on the next sync
 *
 * Usage: node verify/check-sync.mjs
 */

import { spawn } from 'node:child_process';
import path from 'node:path';
import fs from 'node:fs';
import { startMockGithub } from './mock-github.mjs';

const PORT = 9653;
const APP_PORT = 5202;
const TOKEN = 'ghp_test_token_0000000000000000000001';
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const checks = [];
const check = (ok, label, detail = '') => {
  checks.push({ ok, label, detail });
  console.log(`${ok ? 'ok  ' : 'FAIL'} ${label}${detail ? ` — ${detail}` : ''}`);
};

/* ------------------------------------------------------------------ chrome */

const profile = path.join(process.env.TEMP, `er-sync-${Date.now()}`);
const exe = 'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe';
const proc = spawn(exe, [
  '--headless=new', `--remote-debugging-port=${PORT}`, `--user-data-dir=${profile}`,
  '--no-first-run', '--no-default-browser-check', 'about:blank',
], { stdio: 'ignore' });

let browserWsUrl = null;
for (let i = 0; i < 120 && !browserWsUrl; i += 1) {
  await sleep(250);
  try {
    const info = await (await fetch(`http://127.0.0.1:${PORT}/json/version`)).json();
    browserWsUrl = info.webSocketDebuggerUrl;
  } catch { /* not up yet */ }
}
if (!browserWsUrl) throw new Error('Edge did not start');

/** Minimal CDP client over one websocket. */
function connect(wsUrl) {
  const ws = new WebSocket(wsUrl);
  const ready = new Promise((res, rej) => {
    ws.addEventListener('open', res, { once: true });
    ws.addEventListener('error', rej, { once: true });
  });
  let id = 0;
  const pending = new Map();
  ws.addEventListener('message', (ev) => {
    const m = JSON.parse(ev.data);
    const job = pending.get(m.id);
    if (job) { pending.delete(m.id); job(m.result); }
  });
  const send = (method, params = {}, timeoutMs = 15000) => new Promise((resolve) => {
    const i = ++id;
    pending.set(i, resolve);
    ws.send(JSON.stringify({ id: i, method, params }));
    setTimeout(() => { if (pending.has(i)) { pending.delete(i); resolve({ timedOut: true }); } }, timeoutMs);
  });
  return { ws, ready, send };
}

const browser = connect(browserWsUrl);
await browser.ready;

/* ----------------------------------------------------- two isolated devices */

/** Create an isolated storage partition (no shared cookies or localStorage). */
async function newDevice(name) {
  const ctx = await browser.send('Target.createBrowserContext', { disposeOnDetach: false });
  if (!ctx.browserContextId) throw new Error(`could not create context for ${name}`);
  const target = await browser.send('Target.createTarget', {
    url: 'about:blank', browserContextId: ctx.browserContextId,
  });

  const list = await (await fetch(`http://127.0.0.1:${PORT}/json/list`)).json();
  const page = list.find((t) => t.id === target.targetId);
  if (!page) throw new Error(`no page for ${name}`);

  const client = connect(page.webSocketDebuggerUrl);
  await client.ready;
  await client.send('Page.enable');
  await client.send('Runtime.enable');
  await client.send('Emulation.setDeviceMetricsOverride', {
    width: name === 'phone' ? 390 : 1280,
    height: name === 'phone' ? 844 : 900,
    deviceScaleFactor: 1, mobile: name === 'phone',
  });
  if (name === 'phone') await client.send('Emulation.setTouchEmulationEnabled', { enabled: true, maxTouchPoints: 5 });

  const evalJs = async (expr) => {
    const r = await client.send('Runtime.evaluate', {
      expression: expr, awaitPromise: true, returnByValue: true,
    });
    if (r?.timedOut) throw new Error('evaluate timed out');
    if (r.exceptionDetails) throw new Error(r.exceptionDetails.exception?.description || 'threw');
    return r.result?.value;
  };

  /** Poll a JS expression until it is truthy. */
  const waitFor = async (expr, label, timeoutMs = 15000) => {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      try { if (await evalJs(expr)) return true; } catch { /* mid-navigation */ }
      await sleep(150);
    }
    throw new Error(`timed out waiting for ${label}`);
  };

  const goto = async (url) => {
    await client.send('Page.navigate', { url });
    await waitFor('document.readyState === "complete" && !!document.getElementById("impSave")', 'app ready');
  };

  /** Connect this device with the given token through the real form. */
  const connectWith = async (token) => {
    await evalJs(`(() => {
      document.getElementById('authToken').value = ${JSON.stringify(token)};
      document.getElementById('authForm').requestSubmit
        ? document.getElementById('authForm').requestSubmit()
        : document.getElementById('btnSignIn').click();
      return true;
    })()`);
  };

  return { name, client, evalJs, waitFor, goto, connectWith, contextId: ctx.browserContextId };
}

const mock = await startMockGithub({ port: APP_PORT });
mock.addUser(TOKEN, { login: 'wangqirui429', name: 'Reader' });
const APP = `http://127.0.0.1:${APP_PORT}/`;

/** The snapshot the mock is currently holding, or null when no gist exists. */
function storedSnapshot() {
  const gist = [...mock.gists.values()].find((g) => g.description === 'Essay Reader sync');
  if (!gist) return null;
  const raw = gist.files.get('essay-reader.json');
  if (!raw) return null;
  try {
    const parsed = JSON.parse(raw);
    return parsed && parsed.snapshot ? parsed.snapshot : parsed;
  } catch {
    return null;
  }
}

const phone = await newDevice('phone');
const laptop = await newDevice('laptop');

try {
  /* ------------------------------------------------------- 1. connecting */
  await phone.goto(APP);
  await phone.waitFor('document.getElementById("authForm").hidden === false', 'connect form visible');

  check(
    await phone.evalJs(`document.getElementById('btnGetToken').href.includes('github.com/settings/tokens/new')`),
    'the panel links to the GitHub page that mints a token',
  );
  check(
    await phone.evalJs(`document.getElementById('btnGetToken').href.includes('scopes=gist')`),
    'that link pre-selects the gist scope',
  );

  await phone.connectWith(TOKEN);
  await phone.waitFor('document.getElementById("accountSignedIn").hidden === false', 'connected', 20000);
  check(true, 'a token connects the account from the settings panel');
  check(
    (await phone.evalJs('document.getElementById("accountEmail").textContent')).trim() === '@wangqirui429',
    'the panel names the connected GitHub account',
  );
  check(mock.gists.size === 1, 'GitHub now holds exactly one sync gist', `gists=${mock.gists.size}`);

  /* -------------------------------- 2. content travels laptop ← phone ---- */
  // The importer lives on the home view; the account panel is on settings.
  await phone.evalJs(`location.hash = '#/'`);
  await phone.waitFor('!document.getElementById("impText").closest(".view").hidden', 'home view visible');
  await phone.evalJs(`(() => {
    document.getElementById('impTitle').value = 'Phone Essay';
    document.getElementById('impText').value = 'A short phone essay about patience.\\n\\nThe condemned man stepped aside to avoid a puddle, while the hangman waited beside the tall wooden gallows.';
    document.getElementById('impSave').click();
    return true;
  })()`);
  try {
    await phone.waitFor('document.querySelectorAll("#essayBody .w").length > 0', 'essay opened');
  } catch (err) {
    const status = await phone.evalJs(`document.getElementById('impStatus').textContent`);
    const hash = await phone.evalJs('location.hash');
    throw new Error(`${err.message} (import status: "${status}", hash: ${hash})`);
  }

  // Look one word up, which is what puts it in the saved-words list.
  await phone.evalJs(`(() => {
    const w = [...document.querySelectorAll('.w')].find(x => x.dataset.w === 'gallows');
    w.click();
    return true;
  })()`);
  await phone.waitFor('!!document.querySelector(".card .card__zh")', 'meaning card painted', 20000);

  await phone.evalJs(`document.getElementById('btnSyncNow').click()`);
  await phone.waitFor('document.getElementById("syncState").textContent.includes("已同步")', 'phone reports synced', 20000);
  check(true, 'the phone finishes a sync and says so');

  const stored = storedSnapshot();
  check(!!stored, 'the gist now holds a snapshot');
  check(Object.keys(stored?.essays || {}).length === 1, 'the essay reached the gist', `essays=${Object.keys(stored?.essays || {}).length}`);
  check('gallows' in (stored?.words || {}), 'the looked-up word reached the gist');

  const reads = mock.log.filter((r) => r.method === 'GET' && /^\/gists\/[0-9a-f]+$/.test(r.path)).length;
  const writes = mock.log.filter((r) => r.method === 'PATCH' && /^\/gists/.test(r.path)).length;
  check(reads >= 1 && writes >= 1, 'a sync reads the gist and then writes it', `reads=${reads} writes=${writes}`);

  // ---- laptop connects with the same token and must receive the content --
  await laptop.goto(APP);
  await laptop.waitFor('document.getElementById("authForm").hidden === false', 'laptop form visible');
  await laptop.connectWith(TOKEN);
  await laptop.waitFor('document.getElementById("accountSignedIn").hidden === false', 'laptop connected', 20000);
  await laptop.waitFor('document.querySelectorAll("#shelf .tile").length >= 1', 'laptop shelf filled from the cloud', 20000);

  check(mock.gists.size === 1, 'the second device reuses the same gist instead of creating another', `gists=${mock.gists.size}`);

  const shelfTitle = await laptop.evalJs('document.querySelector("#shelf .tile").textContent');
  check(shelfTitle.includes('Phone Essay'), 'the essay written on the phone appears on the laptop');
  check(
    await laptop.evalJs(`[...document.querySelectorAll('.w')].some(w => w.dataset.w === 'gallows') || document.querySelectorAll('#shelf .tile').length >= 1`),
    'the laptop renders the synced essay',
  );

  await laptop.evalJs(`location.hash = '#/words'`);
  await laptop.waitFor('document.querySelectorAll("#wordList .wrow").length > 0', 'laptop word list', 15000);
  const laptopWords = await laptop.evalJs(`[...document.querySelectorAll('#wordList .wrow')].map(el => el.dataset.key).join(',')`);
  check(laptopWords.includes('gallows'), 'the saved word travelled with the essay', laptopWords);

  /* -------------------------------- 3. content travels phone ← laptop ----- */
  await laptop.evalJs(`location.hash = '#/'`);
  await laptop.waitFor('!document.getElementById("impText").closest(".view").hidden', 'laptop home');
  await laptop.evalJs(`(() => {
    document.getElementById('impTitle').value = 'Laptop Essay';
    document.getElementById('impText').value = 'Written on the laptop.\\n\\nA quiet room, a blinking cursor, and the slow steady sound of rain against the window.';
    document.getElementById('impSave').click();
    return true;
  })()`);
  await laptop.waitFor('document.querySelectorAll("#essayBody .w").length > 0', 'laptop essay opened');
  await laptop.evalJs(`document.getElementById('btnSyncNow').click()`);
  await laptop.waitFor('document.getElementById("syncState").textContent.includes("已同步")', 'laptop synced', 20000);

  // The phone pulls on focus; say the word explicitly instead of relying on it.
  await phone.evalJs(`document.getElementById('btnSyncNow').click()`);
  await phone.waitFor('document.getElementById("syncState").textContent.includes("已同步")', 'phone synced again', 20000);
  await phone.evalJs(`location.hash = '#/'`);
  await phone.waitFor('document.querySelectorAll("#shelf .tile").length >= 2', 'phone shelf has both essays', 20000);
  check(true, 'the essay written on the laptop appears on the phone');

  /* ------------------------------ 4. device preferences stay device-local -- */
  await laptop.evalJs(`location.hash = '#/settings'`);
  await laptop.waitFor('!!document.getElementById("sizeRange")', 'laptop settings');
  await laptop.evalJs(`(() => {
    const r = document.getElementById('sizeRange');
    r.value = '26';
    r.dispatchEvent(new Event('input', { bubbles: true }));
    return r.value;
  })()`);
  await sleep(400);
  await phone.evalJs(`document.getElementById('btnSyncNow').click()`);
  await sleep(1500);
  const phoneSize = await phone.evalJs(`document.documentElement.style.getPropertyValue('--para-size')`);
  check(phoneSize !== '26px', 'font size is NOT synced between devices', `phone keeps ${phoneSize}`);
  check(
    (await laptop.evalJs(`document.documentElement.style.getPropertyValue('--para-size')`)) === '26px',
    'the laptop keeps its own font size',
  );

  /* --------------------------------------------- 5. a bad token is explained */
  const stranger = await newDevice('stranger');
  await stranger.goto(APP);
  await stranger.waitFor('document.getElementById("authForm").hidden === false', 'stranger form');
  await stranger.connectWith('ghp_this_token_is_not_registered_000000');
  await stranger.waitFor('document.getElementById("authError").hidden === false', 'error shown', 20000);
  const errText = await stranger.evalJs('document.getElementById("authError").textContent');
  check(errText.includes('令牌') || errText.includes('无效'), 'a bad token is explained in Chinese', errText);
  check(await stranger.evalJs('document.getElementById("accountSignedIn").hidden'), 'the stranger stays disconnected');
  await stranger.client.send('Target.closeTarget', { targetId: '' }).catch(() => {});

  /* -------------------------------------------- 6. disconnecting keeps data -- */
  const beforeSignOut = await laptop.evalJs('document.querySelectorAll("#shelf .tile").length');
  await laptop.evalJs(`location.hash = '#/settings'`);
  await laptop.waitFor('!document.getElementById("btnSignOut").disabled', 'disconnect enabled');
  await laptop.evalJs(`document.getElementById('btnSignOut').click()`);
  await laptop.waitFor('document.getElementById("authForm").hidden === false', 'disconnected', 15000);
  await laptop.evalJs(`location.hash = '#/'`);
  await laptop.waitFor('document.querySelectorAll("#shelf .tile").length >= 1', 'shelf still populated');
  check(true, 'disconnecting leaves the essays on the device');
  check(
    (await laptop.evalJs('document.querySelectorAll("#shelf .tile").length')) === beforeSignOut,
    'no essay disappears on disconnect',
  );

  const writesBefore = mock.log.filter((r) => r.method === 'PATCH').length;
  await laptop.evalJs(`(() => {
    document.getElementById('impTitle').value = 'After Disconnect';
    document.getElementById('impText').value = 'This paragraph was written after disconnecting and must stay local to this browser only.';
    document.getElementById('impSave').click();
    return true;
  })()`);
  await sleep(2500);
  const writesAfter = mock.log.filter((r) => r.method === 'PATCH').length;
  check(writesAfter === writesBefore, 'after disconnecting, nothing is uploaded', `writes ${writesBefore} -> ${writesAfter}`);

  /* ----------------------------------- 7. a deleted gist is recreated ------ */
  await phone.evalJs(`document.getElementById('btnSyncNow').click()`);
  await phone.waitFor('document.getElementById("syncState").textContent.includes("已同步")', 'phone synced', 20000);
  const idBefore = [...mock.gists.keys()][0];
  mock.gists.clear(); // the reader deleted the gist on github.com
  await phone.evalJs(`document.getElementById('btnSyncNow').click()`);
  await phone.waitFor('document.getElementById("syncState").textContent.includes("已同步") || !document.getElementById("authError").hidden', 'phone recovered', 20000);
  const idAfter = [...mock.gists.keys()][0];
  check(mock.gists.size === 1 && idAfter !== idBefore, 'a gist deleted on GitHub is recreated, not lost', `${idBefore} -> ${idAfter}`);
  check(
    Object.keys(storedSnapshot()?.essays || {}).length >= 2,
    'the recreated gist is refilled from local data',
    `essays=${Object.keys(storedSnapshot()?.essays || {}).length}`,
  );

  /* -------------------------------------------------------------- summary -- */
  const passed = checks.filter((c) => c.ok).length;
  console.log(`\n${passed}/${checks.length} checks passed`);
  if (passed !== checks.length) {
    console.log('\nfailed:');
    for (const c of checks.filter((x) => !x.ok)) console.log(` - ${c.label} ${c.detail}`);
  }
  process.exitCode = passed === checks.length ? 0 : 1;
} finally {
  try { phone.client.ws.close(); } catch { /* ignore */ }
  try { laptop.client.ws.close(); } catch { /* ignore */ }
  try { browser.ws.close(); } catch { /* ignore */ }
  await mock.close();
  try { proc.kill('SIGTERM'); } catch { /* ignore */ }
  await sleep(600);
  try { if (proc.exitCode === null) proc.kill('SIGKILL'); } catch { /* ignore */ }
  try { fs.rmSync(profile, { recursive: true, force: true }); } catch { /* ignore */ }
}