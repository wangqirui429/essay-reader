/**
 * Can the deployed app actually use Supabase from this network?
 *
 * Node's fetch is still reset for *.supabase.co, but the app runs in a browser,
 * and the browser resolves through its own resolver. So the only answer that
 * matters is the browser's. This drives a real Edge page loaded from the
 * deployed origin and performs the exact calls the app would make:
 * health, sign-up, insert, row-scoped select, anonymous select (RLS).
 *
 * The test user is removed through the Management API (api.supabase.com is
 * reachable from Node), so the project is left clean.
 *
 * Usage: $env:SUPABASE_PAT = 'sbp_...'; node verify/check-supabase-live.mjs
 */

import { spawn } from 'node:child_process';
import path from 'node:path';
import fs from 'node:fs';

const REF = 'ejnrmtkcigjwbubcxbgy';
const PAT = process.env.SUPABASE_PAT;
const ORIGIN = 'https://wangqirui429.github.io/essay-reader/';
const PORT = 9571;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

if (!PAT) {
  console.error('SUPABASE_PAT is not set');
  process.exit(1);
}

const mgmt = async (p, init = {}) => {
  const r = await fetch(`https://api.supabase.com${p}`, {
    ...init,
    headers: { Authorization: `Bearer ${PAT}`, 'Content-Type': 'application/json', ...(init.headers || {}) },
  });
  const text = await r.text();
  let body = null;
  try { body = JSON.parse(text); } catch { body = text; }
  return { status: r.status, body };
};

const sql = async (query) => {
  const r = await mgmt(`/v1/projects/${REF}/database/query`, { method: 'POST', body: JSON.stringify({ query }) });
  return r;
};

let pass = 0;
let fail = 0;
const check = (ok, label, detail = '') => {
  if (ok) { pass += 1; console.log(`  ok   ${label}${detail ? ` — ${detail}` : ''}`); }
  else { fail += 1; console.log(`  FAIL ${label}${detail ? ` — ${detail}` : ''}`); }
};

// --- 1. project facts, from Node (api.supabase.com is reachable) ----------
const keys = await mgmt(`/v1/projects/${REF}/api-keys`);
if (keys.status !== 200) { console.error(`cannot read keys: ${keys.status}`); process.exit(1); }
const anonKey = keys.body.find((k) => k.name === 'anon')?.api_key;
const serviceKey = keys.body.find((k) => k.name === 'service_role')?.api_key;
const projectUrl = `https://${REF}.supabase.co`;
console.log(`project ${REF}\n  url  ${projectUrl}\n  anon ${String(anonKey).slice(0, 12)}...\n`);

const schema = await sql(`
  select
    (select count(*) from information_schema.tables where table_schema='public' and table_name='essay_reader_state') as table_count,
    (select count(*) from pg_policies where schemaname='public' and tablename='essay_reader_state') as policy_count,
    (select relrowsecurity from pg_class where oid='public.essay_reader_state'::regclass) as rls
`);
check(schema.status === 201 || schema.status === 200, 'schema query works', JSON.stringify(schema.body?.[0] ?? schema.body));

// --- 2. the browser ------------------------------------------------------
const profile = path.join(process.env.TEMP, `er-sb-${Date.now()}`);
const exe = 'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe';
const proc = spawn(exe, ['--headless=new', `--remote-debugging-port=${PORT}`, `--user-data-dir=${profile}`, '--no-first-run', 'about:blank'], { stdio: 'ignore' });

let version = null;
for (let i = 0; i < 100 && !version; i += 1) {
  await sleep(300);
  try { version = await (await fetch(`http://127.0.0.1:${PORT}/json/version`)).json(); } catch { /* retry */ }
}
if (!version) { console.error('browser failed to start'); proc.kill(); process.exit(1); }
console.log(`browser ${version.Browser}\n`);

const page = (await (await fetch(`http://127.0.0.1:${PORT}/json/list`)).json()).find((t) => t.type === 'page');
const ws = new WebSocket(page.webSocketDebuggerUrl);
await new Promise((res) => ws.addEventListener('open', res, { once: true }));

let id = 0;
const pending = new Map();
ws.addEventListener('message', (ev) => {
  const m = JSON.parse(ev.data);
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
  const r = await send('Runtime.evaluate', { expression: expr, awaitPromise: true, returnByValue: true });
  if (r.timedOut) throw new Error('evaluate timed out');
  if (r.exceptionDetails) throw new Error(r.exceptionDetails.exception?.description || r.exceptionDetails.text || 'threw');
  return r.result?.value;
};

const email = `probe.${Date.now()}@example.com`;
const password = 'probe-password-123456';

try {
  await send('Page.enable');
  await send('Runtime.enable');
  await send('Page.navigate', { url: ORIGIN });
  await sleep(3000);

  // The page's origin is the deployed site, exactly like a real visit.
  const origin = await evalJs('location.origin + location.pathname');
  check(true, 'page loaded', origin);

  const health = await evalJs(`fetch(${JSON.stringify(`${projectUrl}/auth/v1/health`)})
    .then(r => r.text()).then(t => 'status-ok ' + t).catch(e => 'FAILED ' + e.message)`);
  check(health.startsWith('status-ok'), 'browser reaches /auth/v1/health', health.slice(0, 80));

  const signup = await evalJs(`fetch(${JSON.stringify(`${projectUrl}/auth/v1/signup`)}, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', apikey: ${JSON.stringify(anonKey)} },
      body: JSON.stringify({ email: ${JSON.stringify(email)}, password: ${JSON.stringify(password)} })
    }).then(r => r.text().then(t => ({ s: r.status, t }))).catch(e => ({ s: 0, t: 'FAILED ' + e.message }))
    .then(x => JSON.stringify(x))`);
  const signupData = JSON.parse(signup);
  check(signupData.s === 200, 'sign-up works', `HTTP ${signupData.s}`);
  let token = null;
  try { token = JSON.parse(signupData.t).access_token || null; } catch { /* ignore */ }
  check(!!token, 'sign-up returns a session (autoconfirm on)');

  if (token) {
    const uid = JSON.parse(signupData.t).user?.id;
    const payload = JSON.stringify({ essays: { probe: { title: 'probe' } }, seen: { gallows: 1 }, words: {} });

    const insert = await evalJs(`fetch(${JSON.stringify(`${projectUrl}/rest/v1/essay_reader_state`)}, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', apikey: ${JSON.stringify(anonKey)}, Authorization: 'Bearer ' + ${JSON.stringify(token)}, Prefer: 'resolution=merge-duplicates' },
        body: JSON.stringify({ user_id: ${JSON.stringify(uid)}, data: ${payload} })
      }).then(r => r.text().then(t => ({ s: r.status, t }))).catch(e => ({ s: 0, t: 'FAILED ' + e.message }))
      .then(x => JSON.stringify(x))`);
    const ins = JSON.parse(insert);
    check(ins.s === 201 || ins.s === 200, 'insert own row works', `HTTP ${ins.s} ${ins.s >= 400 ? ins.t.slice(0, 120) : ''}`);

    const own = await evalJs(`fetch(${JSON.stringify(`${projectUrl}/rest/v1/essay_reader_state?select=data,rev`)}, {
        headers: { apikey: ${JSON.stringify(anonKey)}, Authorization: 'Bearer ' + ${JSON.stringify(token)} }
      }).then(r => r.text().then(t => ({ s: r.status, t }))).catch(e => ({ s: 0, t: 'FAILED ' + e.message }))
      .then(x => JSON.stringify(x))`);
    const ownData = JSON.parse(own);
    check(ownData.s === 200, 'read own row works', `HTTP ${ownData.s}`);
    let rows = [];
    try { rows = JSON.parse(ownData.t); } catch { /* ignore */ }
    check(rows.length === 1, 'own row comes back', `${rows.length} row(s)`);
    // jsonb re-orders object keys (shortest first), so compare a canonical form.
    const canonical = (value) => {
      if (Array.isArray(value)) return value.map(canonical);
      if (value && typeof value === 'object') {
        return Object.fromEntries(Object.keys(value).sort().map((k) => [k, canonical(value[k])]));
      }
      return value;
    };
    check(
      JSON.stringify(canonical(rows[0]?.data)) === JSON.stringify(canonical(JSON.parse(payload))),
      'row content round-trips',
      JSON.stringify(rows[0]?.data ?? null).slice(0, 80),
    );

    const anon = await evalJs(`fetch(${JSON.stringify(`${projectUrl}/rest/v1/essay_reader_state?select=user_id`)}, {
        headers: { apikey: ${JSON.stringify(anonKey)} }
      }).then(r => r.text().then(t => ({ s: r.status, t }))).catch(e => ({ s: 0, t: 'FAILED ' + e.message }))
      .then(x => JSON.stringify(x))`);
    const anonData = JSON.parse(anon);
    let anonRows = [];
    try { anonRows = JSON.parse(anonData.t); } catch { /* ignore */ }
    check(anonData.s === 200 && anonRows.length === 0, 'anonymous visitor sees no rows (RLS)', `HTTP ${anonData.s}, ${anonRows.length} row(s)`);

    const signin = await evalJs(`fetch(${JSON.stringify(`${projectUrl}/auth/v1/token?grant_type=password`)}, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', apikey: ${JSON.stringify(anonKey)} },
        body: JSON.stringify({ email: ${JSON.stringify(email)}, password: ${JSON.stringify(password)} })
      }).then(r => r.text().then(t => ({ s: r.status, t }))).catch(e => ({ s: 0, t: 'FAILED ' + e.message }))
      .then(x => JSON.stringify(x))`);
    const si = JSON.parse(signin);
    check(si.s === 200 && !!JSON.parse(si.t).access_token, 'password sign-in works', `HTTP ${si.s}`);
  }
} catch (err) {
  console.error(`  FAIL harness: ${err.message}`);
  fail += 1;
} finally {
  try { ws.close(); } catch { /* ignore */ }
  try { proc.kill(); } catch { /* ignore */ }
  await sleep(300);
  try { fs.rmSync(profile, { recursive: true, force: true }); } catch { /* ignore */ }
}

// --- 3. cleanup through the Management API -------------------------------
const cleanup = await sql(`delete from auth.users where email = '${email}'`);
check(cleanup.status === 201 || cleanup.status === 200, 'test user removed', `HTTP ${cleanup.status}`);
const left = await sql(`select count(*)::int as n from auth.users`);
console.log(`  users now: ${JSON.stringify(left.body?.[0] ?? left.body)}`);

console.log(`\n${pass} passed, ${fail} failed`);
process.exitCode = fail ? 1 : 0;