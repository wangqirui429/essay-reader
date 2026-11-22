/**
 * Follow a real recovery link end to end and print the redirect chain.
 *
 * The mail template uses {{ .ConfirmationURL }}, which points at the project's
 * /auth/v1/verify endpoint; that endpoint is supposed to bounce the reader to
 * the site with the session in the fragment. When a reader reports "404", this
 * shows which hop produced it.
 *
 * The link is generated with the service_role key, which is read from the
 * management API at run time and never written to disk.
 *
 * Usage:
 *   $env:SUPABASE_PAT='sbp_...'
 *   node verify/diag-link.mjs [email]
 */

import { spawn } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';

const EMAIL = process.argv[2] || '2908789149@qq.com';
const PROJECT = 'ejnrmtkcigjwbubcxbgy';
const URL_TO_TEST = 'https://wangqirui429.github.io/essay-reader/';
const PORT = 9566;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

if (!process.env.SUPABASE_PAT) throw new Error('SUPABASE_PAT is not set');

const keys = await fetch(`https://api.supabase.com/v1/projects/${PROJECT}/api-keys?reveal=true`, {
  headers: { Authorization: `Bearer ${process.env.SUPABASE_PAT}` },
}).then((r) => r.json());
const serviceKey = keys.find((k) => k.name === 'service_role')?.api_key;
const anonKey = keys.find((k) => k.name === 'anon')?.api_key;
if (!serviceKey) throw new Error('no service_role key');

const profile = path.join(process.env.TEMP, `er-link-${Date.now()}`);
const proc = spawn(
  'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe',
  ['--headless=new', `--remote-debugging-port=${PORT}`, `--user-data-dir=${profile}`, '--no-first-run', 'about:blank'],
  { stdio: 'ignore' },
);
let version = null;
for (let i = 0; i < 100 && !version; i += 1) {
  await sleep(300);
  try { version = await (await fetch(`http://127.0.0.1:${PORT}/json/version`)).json(); } catch { /* retry */ }
}
const page = (await (await fetch(`http://127.0.0.1:${PORT}/json/list`)).json()).find((t) => t.type === 'page');
const ws = new WebSocket(page.webSocketDebuggerUrl);
await new Promise((res) => ws.addEventListener('open', res, { once: true }));

let id = 0;
const pending = new Map();
const hops = [];
ws.addEventListener('message', (ev) => {
  const m = JSON.parse(ev.data);
  if (m.method === 'Network.requestWillBeSent') {
    const r = m.params;
    if (/supabase\.co\/auth\/v1\/verify|wangqirui429\.github\.io\/essay-reader/.test(r.request.url)) {
      hops.push(`-> ${r.request.method} ${r.request.url.slice(0, 110)}`);
      if (r.redirectResponse) hops.push(`   302 from ${r.redirectResponse.status}`);
    }
  }
  if (m.method === 'Network.responseReceived') {
    const r = m.params.response;
    if (/supabase\.co\/auth\/v1\/verify|wangqirui429\.github\.io\/essay-reader/.test(r.url)) {
      hops.push(`<- ${r.status} ${r.url.slice(0, 110)}`);
    }
  }
  if (m.method === 'Network.loadingFailed') {
    const r = m.params;
    if (/supabase\.co/.test(r.requestId)) hops.push(`xx failed ${r.errorText}`);
  }
  const job = pending.get(m.id);
  if (job) { pending.delete(m.id); job(m.result); }
});
const send = (method, params = {}) => new Promise((resolve) => {
  const i = ++id;
  pending.set(i, resolve);
  ws.send(JSON.stringify({ id: i, method, params }));
  setTimeout(() => { if (pending.has(i)) { pending.delete(i); resolve({ timedOut: true }); } }, 30000);
});
// awaitPromise matters here: the generate_link call is an async IIFE, and
// without it the reply is an empty object rather than the result.
const evaluate = async (expression) =>
  (await send('Runtime.evaluate', { expression, returnByValue: true, awaitPromise: true }))?.result?.value;

await send('Page.enable');
await send('Runtime.enable');
await send('Network.enable');

// The admin endpoints live on the project's own host, which the page can reach.
send('Page.navigate', { url: URL_TO_TEST }).catch(() => {});
await sleep(4000);

const generated = await evaluate(`(async () => {
  const response = await fetch('https://${PROJECT}.supabase.co/auth/v1/admin/generate_link', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      apikey: ${JSON.stringify(serviceKey)},
      Authorization: 'Bearer ' + ${JSON.stringify(serviceKey)},
      'x-client-info': 'essay-reader-diag'
    },
    body: JSON.stringify({ type: 'recovery', email: ${JSON.stringify(EMAIL)}, redirect_to: ${JSON.stringify(URL_TO_TEST)} })
  });
  const text = await response.text();
  // Keep the whole body: action_link sits after the user fields.
  return JSON.stringify({ status: response.status, body: text });
})()`);

console.log('generate_link status:', (() => {
  try { return JSON.parse(generated).status; } catch { return generated; }
})());
let link = null;
try {
  const parsed = JSON.parse(JSON.parse(generated).body);
  link = parsed.action_link || parsed.confirmationUrl || parsed.confirmation_url || null;
} catch { /* reported below */ }

if (!link) {
  console.log('no link returned; anon key length', (anonKey || '').length);
  ws.close();
  proc.kill();
  process.exit(1);
}

const safeLink = link.replace(/token=[^&]+/, 'token=<redacted>');
console.log('action_link:', safeLink.slice(0, 200));

console.log('\nfollowing the link…');
send('Page.navigate', { url: link }).catch(() => {});
await sleep(6000);

const finalUrl = await evaluate('location.href');
const finalTitle = await evaluate('document.title');
const bodyText = await evaluate('document.body ? document.body.innerText.slice(0, 200) : ""');
const hasRecoveryTokens = await evaluate("location.hash.includes('access_token=')");
const isRecovering = await evaluate("document.body.classList.contains('is-recovering')");

console.log('\n--- hops ---');
for (const hop of hops) console.log(hop);

console.log('\n--- result ---');
console.log('final url :', String(finalUrl).slice(0, 160));
console.log('title     :', finalTitle);
console.log('hash has access_token:', hasRecoveryTokens);
console.log('app in reset mode    :', isRecovering);
console.log('body start:', String(bodyText).replace(/\s+/g, ' ').slice(0, 160));

ws.close();
proc.kill();
try { fs.rmSync(profile, { recursive: true, force: true }); } catch { /* ignore */ }