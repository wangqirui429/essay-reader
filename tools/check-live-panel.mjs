/**
 * Confirm what the published site actually serves for the account panel.
 * Reads the files a visitor's browser would read and asserts the email+password
 * build is live (no token field, no GitHub wording, real project URL).
 *
 * Usage: node tools/check-live-panel.mjs [base]
 */

const base = (process.argv[2] || 'https://wangqirui429.github.io/essay-reader/').replace(/\/?$/, '/');
const stamp = Date.now();

async function get(path) {
  const response = await fetch(`${base}${path}?x=${stamp}`, { cache: 'no-store' });
  if (!response.ok) throw new Error(`${path} -> HTTP ${response.status}`);
  return response.text();
}

const html = await get('');
const sw = await get('sw.js');
const config = await get('js/supabase-config.js');
const auth = await get('js/auth.js');

const has = (haystack, needle) => haystack.includes(needle);
const rows = [
  ['index.html', 'carries an email field', has(html, 'id="authEmail"')],
  ['index.html', 'carries a password field', has(html, 'id="authPassword"')],
  ['index.html', 'carries the sign-in/sign-up toggle', has(html, 'id="btnAltMode"')],
  ['index.html', 'carries the password reset form', has(html, 'id="resetForm"')],
  ['index.html', 'dropped the token field', !has(html, 'id="authToken"')],
  ['index.html', 'dropped the GitHub token link', !has(html, 'id="btnGetToken"')],
  ['sw.js', 'precaches the config module', has(sw, './js/supabase-config.js')],
  ['js/supabase-config.js', 'points at a real project', /SUPABASE_URL = 'https:\/\/[a-z0-9]+\.supabase\.co'/.test(config)],
  ['js/supabase-config.js', 'carries a real anon key', /SUPABASE_ANON_KEY\s*=\s*'ey[A-Za-z0-9._-]{60,}'/.test(config)],
  ['js/auth.js', 'has password sign-in', has(auth, 'export async function signIn')],
  ['js/auth.js', 'has password reset', has(auth, 'export async function requestPasswordReset')],
  ['js/auth.js', 'has no GitHub token sign-in', !has(auth, 'signInWithToken')],
];

let failed = 0;
for (const [file, label, ok] of rows) {
  if (!ok) failed += 1;
  console.log(`${ok ? 'ok  ' : 'FAIL'} ${file}: ${label}`);
}

const version = (sw.match(/CACHE_VERSION = '([^']+)'/) || [])[1];
console.log(`\ncache version: ${version}`);
console.log(`${rows.length - failed}/${rows.length} checks passed`);
process.exit(failed ? 1 : 0);