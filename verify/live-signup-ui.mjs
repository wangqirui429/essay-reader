/**
 * The whole account path, on the published site, exactly as a reader walks it:
 * open Settings, create an account, import an essay, look a word up, sync.
 *
 * It writes screenshots to verify/shots/ and then removes the throwaway account
 * through the Supabase Management API, so running it leaves no trace in the
 * project.
 *
 * Usage: $env:SUPABASE_PAT='sbp_...'; node verify/live-signup-ui.mjs
 */

import { spawn } from 'node:child_process';
import path from 'node:path';
import fs from 'node:fs';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const SHOTS = path.join(here, 'shots');
const SITE = process.argv[2] || 'https://wangqirui429.github.io/essay-reader/';
const PROJECT = 'ejnrmtkcigjwbubcxbgy';
const PAT = process.env.SUPABASE_PAT;
const PORT = 9577;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const EMAIL = `viewer.${Date.now()}@example.com`;
const PASSWORD = 'reader-password-123';

const checks = [];
const check = (ok, label, detail = '') => {
  checks.push({ ok, label, detail });
  console.log(`${ok ? 'ok  ' : 'FAIL'} ${label}${detail ? ` — ${detail}` : ''}`);
};

/* ---------------------------------------------------------------- chrome --- */

const profile = path.join(process.env.TEMP, `er-live-ui-${Date.now()}`);
const proc = spawn('C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe', [
  '--headless=new', `--remote-debugging-port=${PORT}`, `--user-data-dir=${profile}`,
  '--no-first-run', '--no-default-browser-check', '--hide-scrollbars', 'about:blank',
], { stdio: 'ignore' });

let wsUrl = null;
for (let i = 0; i < 120 && !wsUrl; i += 1) {
  await sleep(250);
  try { wsUrl = (await (await fetch(`http://127.0.0.1:${PORT}/json/version`)).json()).webSocketDebuggerUrl; } catch { /* wait */ }
}
if (!wsUrl) throw new Error('Edge did not start');

const page = (await (await fetch(`http://127.0.0.1:${PORT}/json/list`)).json()).find((t) => t.type === 'page');
const ws = new WebSocket(page.webSocketDebuggerUrl);
await new Promise((res, rej) => {
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
const send = (method, params = {}, timeoutMs = 25000) => new Promise((resolve) => {
  const i = ++id;
  pending.set(i, resolve);
  ws.send(JSON.stringify({ id: i, method, params }));
  setTimeout(() => { if (pending.has(i)) { pending.delete(i); resolve({ timedOut: true }); } }, timeoutMs);
});
const evalJs = async (expression) => {
  const r = await send('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true });
  if (r?.timedOut) throw new Error('evaluate timed out');
  if (r.exceptionDetails) throw new Error(r.exceptionDetails.exception?.description || 'threw');
  return r.result?.value;
};
const waitFor = async (expression, label, timeoutMs = 25000) => {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try { if (await evalJs(expression)) return true; } catch { /* mid-navigation */ }
    await sleep(150);
  }
  throw new Error(`timed out waiting for ${label}`);
};
const shot = async (name) => {
  const r = await send('Page.captureScreenshot', { format: 'png' });
  if (!r?.data) throw new Error(`screenshot ${name} failed`);
  fs.writeFileSync(path.join(SHOTS, name), Buffer.from(r.data, 'base64'));
  console.log(`     shot ${name}`);
};

/** Run SQL through the Management API, so the throwaway row can be removed. */
async function sql(query) {
  const response = await fetch(`https://api.supabase.com/v1/projects/${PROJECT}/database/query`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${PAT}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ query }),
  });
  const text = await response.text();
  if (!response.ok) throw new Error(`sql ${response.status}: ${text.slice(0, 200)}`);
  return text;
}

await send('Page.enable');
await send('Runtime.enable');
await send('Emulation.setDeviceMetricsOverride', {
  width: 390, height: 844, deviceScaleFactor: 2, mobile: true,
});
await send('Emulation.setTouchEmulationEnabled', { enabled: true, maxTouchPoints: 5 });

try {
  fs.mkdirSync(SHOTS, { recursive: true });
  await send('Page.navigate', { url: SITE });
  await waitFor('document.readyState === "complete" && !!document.querySelector(".topbar")', 'site loads');
  await waitFor('document.getElementById("authForm") && document.getElementById("authForm").hidden === false', 'account panel boots', 30000);

  /* ------------------------------------------------- 1. the account card -- */
  await evalJs(`location.hash = '#/settings'`);
  await sleep(600);
  // The account card sits below appearance/language/dictionary, so scroll it to
  // the top of the viewport before taking the picture.
  await evalJs(`(() => {
    const card = document.getElementById('accountCard');
    window.scrollTo(0, card.getBoundingClientRect().top + window.scrollY - 12);
    return window.scrollY;
  })()`);
  await sleep(400);
  await shot('40-live-account-card.png');
  check(/账号与同步/.test(await evalJs('document.querySelector("#accountCard .set-card__title").textContent')), 'the live panel is the account card');

  /* -------------------------------------------------------- 2. sign up --- */
  await evalJs(`document.getElementById('btnAltMode').click()`);
  await sleep(200);
  check(/注册/.test(await evalJs('document.getElementById("btnSubmitAuth").textContent')), 'the button switches to "create an account"');

  await evalJs(`(() => {
    document.getElementById('authEmail').value = ${JSON.stringify(EMAIL)};
    document.getElementById('authPassword').value = ${JSON.stringify(PASSWORD)};
    document.getElementById('authForm').requestSubmit();
    return true;
  })()`);

  await waitFor('document.getElementById("accountSignedIn").hidden === false', 'signed in', 30000);
  await sleep(800);
  await evalJs(`(() => {
    const card = document.getElementById('accountCard');
    window.scrollTo(0, card.getBoundingClientRect().top + window.scrollY - 12);
    return window.scrollY;
  })()`);
  await sleep(400);
  await shot('41-live-signed-in.png');
  check(true, 'a real account is created from the live page');
  check(
    (await evalJs('document.getElementById("accountEmail").textContent')).trim() === EMAIL,
    'the panel shows the new account',
    await evalJs('document.getElementById("accountEmail").textContent'),
  );

  /* -------------------------------------- 3. an essay, a word, a sync ----- */
  await evalJs(`location.hash = '#/'`);
  await waitFor('!document.getElementById("impText").closest(".view").hidden', 'home view');
  await evalJs(`(() => {
    document.getElementById('impTitle').value = 'Live Sync Essay';
    document.getElementById('impText').value = 'Reading on a phone should feel the same as reading on paper.\\n\\nThe condemned man stepped aside to avoid a puddle, while the hangman waited beside the tall wooden gallows.';
    document.getElementById('impSave').click();
    return true;
  })()`);
  await waitFor('document.querySelectorAll("#essayBody .w").length > 0', 'essay opens', 30000);

  await evalJs(`(() => {
    const w = [...document.querySelectorAll('.w')].find(x => x.dataset.w === 'gallows');
    w.click();
    return true;
  })()`);
  await waitFor('!!document.querySelector(".card .card__zh")', 'meaning card', 30000);
  await sleep(400);
  await shot('42-live-card.png');

  await evalJs(`location.hash = '#/settings'`);
  await waitFor('document.getElementById("btnSyncNow").disabled === false', 'sync enabled');
  await evalJs(`document.getElementById('btnSyncNow').click()`);
  await waitFor('document.getElementById("syncState").textContent.includes("已同步")', 'sync completes', 30000);
  await sleep(500);
  await evalJs(`(() => {
    const card = document.getElementById('accountCard');
    window.scrollTo(0, card.getBoundingClientRect().top + window.scrollY - 12);
    return window.scrollY;
  })()`);
  await sleep(300);
  await shot('43-live-synced.png');
  check(true, 'the live page reports a completed sync');

  /* ---------------------------------------- 4. the cloud really has it ---- */
  const stored = await sql(`select data from essay_reader_state where data::text like '%Live Sync Essay%'`);
  check(/"Live Sync Essay"/.test(stored), 'the essay is stored in the cloud', stored.slice(0, 120));
  check(/gallows/.test(stored), 'the looked-up word is stored with it');

  /* ------------------------------------------------------------ summary -- */
  const passed = checks.filter((c) => c.ok).length;
  console.log(`\n${passed}/${checks.length} checks passed`);
  process.exitCode = passed === checks.length ? 0 : 1;
} finally {
  if (PAT) {
    try {
      const cleanup = await sql(`delete from auth.users where email = '${EMAIL}'`);
      console.log(`cleanup: ${EMAIL} removed (${String(cleanup).slice(0, 40)})`);
    } catch (err) {
      console.log(`cleanup failed: ${err.message}`);
    }
  } else {
    console.log('SUPABASE_PAT is not set; the throwaway account was NOT removed');
  }
  try { ws.close(); } catch { /* ignore */ }
  try { proc.kill('SIGTERM'); } catch { /* ignore */ }
  await sleep(600);
  try { if (proc.exitCode === null) proc.kill('SIGKILL'); } catch { /* ignore */ }
  try { fs.rmSync(profile, { recursive: true, force: true }); } catch { /* ignore */ }
}