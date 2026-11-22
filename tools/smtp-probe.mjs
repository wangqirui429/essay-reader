/**
 * Prove the QQ Mail SMTP credentials work, without sending anything.
 *
 * Opens a TLS connection to smtp.qq.com, greets, authenticates with AUTH LOGIN
 * and quits. A successful login means the authorization code, the sender
 * address and QQ's rules all line up, so any remaining problem is on the
 * Supabase side rather than in the credentials.
 *
 * Usage (secrets come from the environment, never from arguments):
 *   $env:QQ_SMTP_USER='...@qq.com'
 *   $env:QQ_SMTP_PASS='the 16-character authorization code'
 *   node tools/smtp-probe.mjs
 */

import tls from 'node:tls';

const USER = String(process.env.QQ_SMTP_USER || '').trim();
const PASS = String(process.env.QQ_SMTP_PASS || '').trim();
if (!USER || !PASS) throw new Error('set QQ_SMTP_USER and QQ_SMTP_PASS');

const socket = tls.connect({ host: 'smtp.qq.com', port: 465, servername: 'smtp.qq.com' });

const transcript = [];
let buffer = '';
let step = 0;

const fail = (message) => {
  console.error('FAIL', message);
  try { socket.destroy(); } catch { /* already gone */ }
  process.exit(1);
};

const timer = setTimeout(() => fail('timed out after 20 s'), 20000);

socket.on('error', (error) => fail(error.message));

socket.on('data', (chunk) => {
  buffer += chunk.toString('utf8');
  // SMTP replies end with "NNN <text>\r\n"; multi-line replies repeat the code.
  const lines = buffer.split('\r\n').filter(Boolean);
  const last = lines[lines.length - 1] || '';
  if (!/^\d{3} /.test(last)) return;
  buffer = '';
  transcript.push(last);

  const code = Number(last.slice(0, 3));
  if (code >= 400) fail(`server said: ${last}`);

  step += 1;
  if (step === 1) {
    socket.write('EHLO probe.local\r\n');
  } else if (step === 2) {
    socket.write('AUTH LOGIN\r\n');
  } else if (step === 3) {
    socket.write(`${Buffer.from(USER).toString('base64')}\r\n`);
  } else if (step === 4) {
    socket.write(`${Buffer.from(PASS).toString('base64')}\r\n`);
  } else if (step === 5) {
    clearTimeout(timer);
    console.log('ok: authenticated as', USER);
    for (const line of transcript) console.log(`  ${line}`);
    console.log('ok: the authorization code is valid and QQ accepts this sender');
    socket.write('QUIT\r\n');
    setTimeout(() => process.exit(0), 300);
  }
});

socket.on('close', () => {
  clearTimeout(timer);
  if (step < 5) fail(`connection closed early (step ${step})`);
});