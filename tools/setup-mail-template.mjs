/**
 * Point the recovery mail at this site instead of the auth host.
 *
 * Why: the default template uses {{ .ConfirmationURL }}, whose first hop is
 * `<project>.supabase.co/auth/v1/verify`. That host was blocked on the reader's
 * network at one point and is blocked from Node here, and when the hop fails
 * the reader sees the browser's own error page with no explanation. With
 * {{ .TokenHash }} the link opens a page we control, and the app does the
 * one-time exchange itself (auth.js: exchangeRecoveryToken).
 *
 * The same mail also carries {{ .Token }}, the six digits a reader can type by
 * hand when a link will not open in their browser.
 *
 * Usage:
 *   $env:SUPABASE_PAT='sbp_...'
 *   node tools/setup-mail-template.mjs           # apply
 *   node tools/setup-mail-template.mjs --show    # print what is there now
 */

const PROJECT = 'ejnrmtkcigjwbubcxbgy';
const API = `https://api.supabase.com/v1/projects/${PROJECT}/config/auth`;

const PAT = process.env.SUPABASE_PAT;
if (!PAT) {
  console.error('SUPABASE_PAT is not set.');
  process.exit(1);
}

const headers = {
  Authorization: `Bearer ${PAT}`,
  'Content-Type': 'application/json',
};

const SUBJECT = '重置你的英语作文阅读器密码';

// Plain, readable HTML: one button, one manual code, one line saying what to
// do if it was not you. Kept short so it does not look like a phishing page.
const CONTENT = [
  '<h2>重置密码</h2>',
  '<p>我们收到了重置「英语作文阅读器」密码的请求。点下面的按钮就能设置一个新密码。</p>',
  '<p><a href="{{ .SiteURL }}#type=recovery&token_hash={{ .TokenHash }}"',
  ' style="display:inline-block;padding:12px 20px;background:#2f6f4f;color:#ffffff;',
  'border-radius:8px;text-decoration:none;font-weight:600">设置新密码</a></p>',
  '<p>按钮打不开也没关系：回到网站，在「设置 → 账号与同步」里点「我有验证码」，',
  '把下面这串数字填进去，一样可以设置新密码。</p>',
  '<p style="font-size:24px;letter-spacing:6px;font-weight:700">{{ .Token }}</p>',
  '<p>如果不是你发起的，忽略这封邮件就好，密码不会变。</p>',
].join('\n');

if (process.argv.includes('--show')) {
  const response = await fetch(API, { headers: { Authorization: `Bearer ${PAT}` } });
  if (!response.ok) {
    console.error('could not read config:', response.status, await response.text());
    process.exit(1);
  }
  const config = await response.json();
  console.log('subject:', config.mailer_subjects_recovery);
  console.log('content:\n' + config.mailer_templates_recovery_content);
  process.exit(0);
}

const payload = {
  // Subjects and bodies live under different key families in this API.
  mailer_subjects_recovery: SUBJECT,
  mailer_templates_recovery_content: CONTENT,
};

const applied = await fetch(API, { method: 'PATCH', headers, body: JSON.stringify(payload) });
if (!applied.ok) {
  console.error('PATCH failed:', applied.status, await applied.text());
  process.exit(1);
}

const check = await fetch(API, { headers: { Authorization: `Bearer ${PAT}` } });
const config = await check.json();
const subject = config.mailer_subjects_recovery || '';
const content = config.mailer_templates_recovery_content || '';
const usesTokenHash = content.includes('{{ .TokenHash }}');
const usesOurSite = content.includes('{{ .SiteURL }}');
const usesCode = content.includes('{{ .Token }}');
const usesOldLink = content.includes('{{ .ConfirmationURL }}');

console.log('subject      :', subject);
console.log('uses TokenHash:', usesTokenHash);
console.log('uses SiteURL  :', usesOurSite);
console.log('uses 6-digit  :', usesCode);
console.log('still ConfirmationURL:', usesOldLink);

if (!usesTokenHash || !usesOurSite || usesCode === false || usesOldLink) {
  console.error('template did not take the expected shape');
  process.exit(1);
}
console.log('\ntemplate applied');