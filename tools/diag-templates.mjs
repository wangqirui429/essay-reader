/**
 * Show the auth email templates and the URL fields that decide where a reset
 * link points. Read-only.
 *
 * Usage: node tools/diag-templates.mjs
 */

const PROJECT = 'ejnrmtkcigjwbubcxbgy';
const PAT = process.env.SUPABASE_PAT;
if (!PAT) throw new Error('SUPABASE_PAT is not set');

const config = await fetch(`https://api.supabase.com/v1/projects/${PROJECT}/config/auth`, {
  headers: { Authorization: `Bearer ${PAT}` },
}).then((r) => r.json());

for (const [key, value] of Object.entries(config)) {
  if (!/mailer_templates|site_url|uri_allow/.test(key)) continue;
  if (value === null) continue;
  const text = String(value);
  console.log(`\n=== ${key} (${text.length} chars) ===`);
  console.log(text.slice(0, 1200));
}