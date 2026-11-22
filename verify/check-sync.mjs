/**
 * End-to-end test of account sync, using two isolated browser contexts that
 * stand in for a phone and a laptop.
 *
 * The backend is a local double of the Supabase auth + REST API
 * (verify/mock-supabase.mjs), so the run is fast and deterministic;
 * verify/check-supabase-live.mjs exercises the same endpoints against the real
 * project.
 *
 * What it proves, in order:
 *   1. an account can be created from the settings panel
 *   2. an essay and a looked-up word travel from device A to device B
 *   3. the second device signs in to the same account and receives them
 *   4. an essay written on device B travels back to device A
 *   5. per-device preferences (font size) do NOT travel, they stay local
 *   6. a wrong password is reported in Chinese, not as a crash
 *   7. two accounts never see each other's data
 *   8. signing out keeps local data but stops syncing
 *   9. a cloud copy wiped server-side is refilled from local data
 *
 * Usage: node verify/check-sync.mjs
 */

import { spawn } from 'node:child_process';
import path from 'node:path';
import fs from 'node:fs';
import { startMockSupabase } from './mock-supabase.mjs';

const PORT = 9653;
const APP_PORT = 5202;
const EMAIL = 'reader@example.com';
const PASSWORD = 'password123';
const OTHER_EMAIL = 'other@example.com';
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
    await waitFor('document.getElementById("authForm").hidden === false', 'account form visible');
  };

  /** Fill the two credential fields and submit the real form. */
  const submitCredentials = async (email, password) => {
    await evalJs(`(() => {
      const form = document.getElementById('authForm');
      document.getElementById('authEmail').value = ${JSON.stringify(email)};
      document.getElementById('authPassword').value = ${JSON.stringify(password)};
      form.requestSubmit ? form.requestSubmit() : document.getElementById('btnSubmitAuth').click();
      return true;
    })()`);
  };

  /** Switch the panel to "create an account" and submit. */
  const signUpAs = async (email, password) => {
    await evalJs(`document.getElementById('btnAltMode').click()`);
    await sleep(120);
    await submitCredentials(email, password);
  };

  const signInAs = async (email, password) => submitCredentials(email, password);

  /** Import an essay through the home view and wait for it to open. */
  const importEssay = async (title, text) => {
    await evalJs(`location.hash = '#/'`);
    await waitFor('!document.getElementById("impText").closest(".view").hidden', 'home view visible');
    await evalJs(`(() => {
      document.getElementById('impTitle').value = ${JSON.stringify(title)};
      document.getElementById('impText').value = ${JSON.stringify(text)};
      document.getElementById('impSave').click();
      return true;
    })()`);
    try {
      await waitFor('document.querySelectorAll("#essayBody .w").length > 0', `essay "${title}" opened`);
    } catch (err) {
      const status = await evalJs(`document.getElementById('impStatus').textContent`);
      const hash = await evalJs('location.hash');
      throw new Error(`${err.message} (import status: "${status}", hash: ${hash})`);
    }
  };

  /** Press "sync now" and wait until the panel reports success. */
  const syncNow = async () => {
    await evalJs(`location.hash = '#/settings'`);
    await waitFor('document.getElementById("btnSyncNow").disabled === false', 'sync button enabled');
    await evalJs(`document.getElementById('btnSyncNow').click()`);
    await waitFor(
      `document.getElementById("syncState").textContent.includes("已同步")`,
      'device reports synced',
      20000,
    );
  };

  return { name, client, evalJs, waitFor, goto, signUpAs, signInAs, importEssay, syncNow, contextId: ctx.browserContextId };
}

const mock = await startMockSupabase({ port: APP_PORT });
const APP = `http://127.0.0.1:${APP_PORT}/`;

/** The account record the mock holds for an address, or null. */
function userFor(email) {
  return [...mock.users.values()].find((u) => u.email === email) || null;
}

/** The snapshot stored in the cloud for an address, or null. */
function storedFor(email) {
  const user = userFor(email);
  if (!user) return null;
  const row = mock.rows.get(user.id);
  return row ? row.data : null;
}

const texts = {
  phone: 'A short phone essay about patience.\n\nThe condemned man stepped aside to avoid a puddle, while the hangman waited beside the tall wooden gallows.',
  laptop: 'Written on the laptop.\n\nA quiet room, a blinking cursor, and the slow steady sound of rain against the window.',
  other: 'A completely separate account.\n\nIts words must never appear on the first reader shelf, no matter how many times either side syncs.',
};

const phone = await newDevice('phone');
const laptop = await newDevice('laptop');
const other = await newDevice('other');

try {
  /* ------------------------------------------------- 1. creating an account */
  await phone.goto(APP);
  check(
    await phone.evalJs(`!!document.getElementById('authEmail') && !!document.getElementById('authPassword')`),
    'the account panel asks for an email and a password',
  );
  check(
    await phone.evalJs(`document.getElementById('authPassword').type === 'password'`),
    'the password field is masked',
  );

  await phone.signUpAs(EMAIL, PASSWORD);
  await phone.waitFor('document.getElementById("accountSignedIn").hidden === false', 'signed in after sign-up', 20000);
  check(true, 'an account can be created from the settings panel');
  check(
    (await phone.evalJs('document.getElementById("accountEmail").textContent')).trim() === EMAIL,
    'the panel names the signed-in account',
    await phone.evalJs('document.getElementById("accountEmail").textContent'),
  );
  check(!!userFor(EMAIL), 'the backend now holds the account');
  check(mock.rows.size === 1, 'exactly one cloud document exists', `rows=${mock.rows.size}`);

  /* --------------------------------- 2. content travels laptop ← phone ---- */
  await phone.importEssay('Phone Essay', texts.phone);

  // Look one word up, which is what puts it in the saved-words list.
  await phone.evalJs(`(() => {
    const w = [...document.querySelectorAll('.w')].find(x => x.dataset.w === 'gallows');
    w.click();
    return true;
  })()`);
  await phone.waitFor('!!document.querySelector(".card .card__zh")', 'meaning card painted', 20000);

  await phone.syncNow();
  check(true, 'the phone finishes a sync and says so');

  const stored = storedFor(EMAIL);
  check(!!stored, 'the cloud now holds a document');
  check(Object.keys(stored?.essays || {}).length === 1, 'the essay reached the cloud', `essays=${Object.keys(stored?.essays || {}).length}`);
  check('gallows' in (stored?.words || {}), 'the looked-up word reached the cloud');

  const reads = mock.log.filter((r) => r.method === 'GET' && r.path === '/rest/v1/essay_reader_state').length;
  const writes = mock.log.filter((r) => r.method === 'POST' && r.path === '/rest/v1/essay_reader_state').length;
  check(reads >= 1 && writes >= 1, 'a sync reads the document and then writes it', `reads=${reads} writes=${writes}`);

  // ---- laptop signs in to the same account and must receive the content --
  await laptop.goto(APP);
  await laptop.signInAs(EMAIL, PASSWORD);
  await laptop.waitFor('document.getElementById("accountSignedIn").hidden === false', 'laptop signed in', 20000);
  await laptop.waitFor('document.querySelectorAll("#shelf .tile").length >= 1', 'laptop shelf filled from the cloud', 20000);

  check(mock.rows.size === 1, 'the second device uses the same document, not a new one', `rows=${mock.rows.size}`);

  const shelfTitle = await laptop.evalJs('document.querySelector("#shelf .tile").textContent');
  check(shelfTitle.includes('Phone Essay'), 'the essay written on the phone appears on the laptop', shelfTitle.trim().slice(0, 40));

  await laptop.evalJs(`location.hash = '#/words'`);
  await laptop.waitFor('document.querySelectorAll("#wordList .wrow").length > 0', 'laptop word list', 15000);
  const laptopWords = await laptop.evalJs(`[...document.querySelectorAll('#wordList .wrow')].map(el => el.dataset.key).join(',')`);
  check(laptopWords.includes('gallows'), 'the saved word travelled with it', laptopWords);

  /* -------------------------------- 3. content travels phone ← laptop ----- */
  await laptop.importEssay('Laptop Essay', texts.laptop);
  await laptop.syncNow();

  await phone.syncNow();
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
  await phone.syncNow();
  await sleep(1200);
  const phoneSize = await phone.evalJs(`document.documentElement.style.getPropertyValue('--para-size')`);
  check(phoneSize !== '26px', 'font size is NOT synced between devices', `phone keeps ${phoneSize}`);
  check(
    (await laptop.evalJs(`document.documentElement.style.getPropertyValue('--para-size')`)) === '26px',
    'the laptop keeps its own font size',
  );

  /* ------------------------------------------ 5. a wrong password is explained */
  const stranger = await newDevice('stranger');
  await stranger.goto(APP);
  await stranger.signInAs(EMAIL, 'definitely-wrong-password');
  await stranger.waitFor('document.getElementById("authError").hidden === false', 'error shown', 20000);
  const errText = await stranger.evalJs('document.getElementById("authError").textContent');
  check(/密码|邮箱/.test(errText), 'a wrong password is explained in Chinese', errText);
  check(await stranger.evalJs('document.getElementById("accountSignedIn").hidden'), 'the stranger stays signed out');
  try { stranger.client.ws.close(); } catch { /* ignore */ }

  /* --------------------------------------- 6. two accounts stay separate ---- */
  await other.goto(APP);
  await other.signUpAs(OTHER_EMAIL, 'another-password');
  await other.waitFor('document.getElementById("accountSignedIn").hidden === false', 'second account signed in', 20000);
  await other.importEssay('Other Essay', texts.other);
  await other.syncNow();

  check(mock.rows.size === 2, 'each account gets its own document', `rows=${mock.rows.size}`);
  check(
    Object.keys(storedFor(OTHER_EMAIL)?.essays || {}).length === 1,
    'the second account stored only its own essay',
    `essays=${Object.keys(storedFor(OTHER_EMAIL)?.essays || {}).length}`,
  );
  check(
    !('gallows' in (storedFor(OTHER_EMAIL)?.words || {})),
    'the first account saved words did not leak into the second account',
  );

  await other.evalJs(`location.hash = '#/'`);
  await other.waitFor('document.querySelectorAll("#shelf .tile").length >= 1', 'other shelf');
  const otherShelf = await other.evalJs(`[...document.querySelectorAll('#shelf .tile')].map(t => t.textContent).join('|')`);
  check(!otherShelf.includes('Phone Essay'), 'the second account cannot see the first account shelf', otherShelf.trim().slice(0, 60));

  /* ------------------------------------------- 7. signing out keeps data --- */
  const beforeSignOut = await laptop.evalJs('document.querySelectorAll("#shelf .tile").length');
  await laptop.evalJs(`location.hash = '#/settings'`);
  await laptop.waitFor('document.getElementById("btnSignOut").disabled === false', 'sign out enabled');
  await laptop.evalJs(`document.getElementById('btnSignOut').click()`);
  await laptop.waitFor('document.getElementById("authForm").hidden === false', 'signed out', 15000);
  await laptop.evalJs(`location.hash = '#/'`);
  await laptop.waitFor('document.querySelectorAll("#shelf .tile").length >= 1', 'shelf still populated');
  check(true, 'signing out leaves the essays on the device');
  check(
    (await laptop.evalJs('document.querySelectorAll("#shelf .tile").length')) === beforeSignOut,
    'no essay disappears on sign out',
  );

  const writesBefore = mock.log.filter((r) => r.method === 'POST' && r.path === '/rest/v1/essay_reader_state').length;
  await laptop.evalJs(`(() => {
    document.getElementById('impTitle').value = 'After Sign Out';
    document.getElementById('impText').value = 'This paragraph was written after signing out and must stay local to this browser only, forever.';
    document.getElementById('impSave').click();
    return true;
  })()`);
  await sleep(2500);
  const writesAfter = mock.log.filter((r) => r.method === 'POST' && r.path === '/rest/v1/essay_reader_state').length;
  check(writesAfter === writesBefore, 'after signing out, nothing is uploaded', `writes ${writesBefore} -> ${writesAfter}`);

  /* ------------------------------- 8. a wiped cloud copy is refilled ------ */
  const essaysBefore = Object.keys(storedFor(EMAIL)?.essays || {}).length;
  mock.rows.clear(); // the row was dropped server-side
  await phone.syncNow();
  const refilled = Object.keys(storedFor(EMAIL)?.essays || {}).length;
  check(refilled >= essaysBefore, 'a cloud copy wiped server-side is refilled from local data', `${essaysBefore} -> ${refilled}`);
  check(
    'gallows' in (storedFor(EMAIL)?.words || {}),
    'the refilled copy still carries the saved words',
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
  for (const d of [phone, laptop, other]) { try { d.client.ws.close(); } catch { /* ignore */ } }
  try { browser.ws.close(); } catch { /* ignore */ }
  await mock.close();
  try { proc.kill('SIGTERM'); } catch { /* ignore */ }
  await sleep(600);
  try { if (proc.exitCode === null) proc.kill('SIGKILL'); } catch { /* ignore */ }
  try { fs.rmSync(profile, { recursive: true, force: true }); } catch { /* ignore */ }
}