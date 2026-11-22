/**
 * Point the project's auth mailer at QQ Mail's SMTP server.
 *
 * Supabase's built-in mailer is limited to a couple of messages an hour and is
 * routinely filed as spam, so password resets only become dependable once the
 * project sends through a real mailbox. QQ Mail works from mainland China
 * without a domain, which is why it is the default here.
 *
 * The credentials are read from the environment and never written to disk or
 * printed. The authorization code is NOT the mailbox password: generate it in
 * QQ Mail under 设置 → 账号 → POP3/IMAP/SMTP 服务.
 *
 * Usage:
 *   $env:SUPABASE_PAT='sbp_...'
 *   $env:QQ_SMTP_USER='123456789@qq.com'
 *   $env:QQ_SMTP_PASS='the 16-character authorization code'
 *   node tools/setup-smtp.mjs [--dry-run] [--clear]
 */

const PROJECT = 'ejnrmtkcigjwbubcxbgy';
const PAT = process.env.SUPABASE_PAT;
const USER = String(process.env.QQ_SMTP_USER || '').trim();
const PASS = String(process.env.QQ_SMTP_PASS || '').trim();
const DRY = process.argv.includes('--dry-run');
const CLEAR = process.argv.includes('--clear');
const SENDER_NAME = process.env.SMTP_SENDER_NAME || '英语作文阅读器';
// The default is 2 mails an hour, which would make even a two-person reset
// painful. With a real mailbox behind it, 30 an hour is still polite.
const EMAIL_RATE_LIMIT = 30;

if (!PAT) throw new Error('SUPABASE_PAT is not set');

const api = `https://api.supabase.com/v1/projects/${PROJECT}/config/auth`;

async function call(method, body) {
  const response = await fetch(api, {
    method,
    headers: { Authorization: `Bearer ${PAT}`, 'Content-Type': 'application/json' },
    body: body ? JSON.stringify(body) : undefined,
  });
  const text = await response.text();
  if (!response.ok) throw new Error(`${method} ${response.status}: ${text.slice(0, 400)}`);
  try { return JSON.parse(text); } catch { return text; }
}

/** Print a value without ever echoing a secret. */
const show = (label, value) => {
  if (value === null || value === undefined || value === '') {
    console.log(`  ${label}: (empty)`);
  } else if (/pass|secret|key/i.test(label)) {
    console.log(`  ${label}: ***set, ${String(value).length} characters***`);
  } else {
    console.log(`  ${label}: ${value}`);
  }
};

const FIELDS = ['smtp_host', 'smtp_port', 'smtp_user', 'smtp_admin_email', 'smtp_sender_name', 'rate_limit_email_sent'];

if (CLEAR) {
  // Supabase only clears a mailer field when it is sent as JSON null; an empty
  // string is rejected ("Invalid email address").
  await call('PATCH', {
    smtp_host: null, smtp_port: null, smtp_user: null, smtp_pass: null,
    smtp_admin_email: null, smtp_sender_name: null,
  });
  const after = await call('GET');
  console.log('mailer cleared');
  for (const field of FIELDS) show(field, after[field]);
  process.exit(0);
}

if (!USER || !PASS) throw new Error('set QQ_SMTP_USER and QQ_SMTP_PASS (or pass --clear)');
if (!USER.includes('@')) throw new Error(`QQ_SMTP_USER does not look like an email address: ${USER}`);
if (PASS.length < 8) throw new Error('the authorization code looks too short — QQ codes are 16 characters, and the mailbox password will not work');

const payload = {
  smtp_host: 'smtp.qq.com',
  smtp_port: '465',
  smtp_user: USER,
  smtp_pass: PASS,
  smtp_admin_email: USER,
  smtp_sender_name: SENDER_NAME,
  rate_limit_email_sent: EMAIL_RATE_LIMIT,
};

if (DRY) {
  console.log('would apply:');
  for (const field of FIELDS) show(field, payload[field]);
  process.exit(0);
}

await call('PATCH', payload);
const after = await call('GET');

console.log('mailer configured');
for (const field of FIELDS) show(field, after[field]);

const problems = [];
if (after.smtp_host !== 'smtp.qq.com') problems.push('smtp_host did not stick');
if (String(after.smtp_port) !== '465') problems.push('smtp_port did not stick');
if (after.smtp_admin_email !== USER) problems.push('smtp_admin_email did not stick');
if (after.smtp_pass === null || after.smtp_pass === '') problems.push('smtp_pass did not stick');

if (problems.length) {
  console.log('\nnot fully applied:');
  for (const p of problems) console.log(` - ${p}`);
  process.exit(1);
}

console.log('\nok: the project now sends auth mail as', `${SENDER_NAME} <${USER}>`);
console.log('next: trigger a password reset from the live site and check that the mail arrives');