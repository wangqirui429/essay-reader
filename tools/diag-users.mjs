/**
 * Print the accounts registered in the project, plus the current mailer config.
 * Read-only. Needs SUPABASE_PAT.
 */
const PROJECT = 'ejnrmtkcigjwbubcxbgy';
const PAT = process.env.SUPABASE_PAT;
if (!PAT) throw new Error('SUPABASE_PAT is not set');

const sql = 'select email, created_at, email_confirmed_at, last_sign_in_at from auth.users order by created_at';

const response = await fetch(`https://api.supabase.com/v1/projects/${PROJECT}/database/query`, {
  method: 'POST',
  headers: { Authorization: `Bearer ${PAT}`, 'Content-Type': 'application/json' },
  body: JSON.stringify({ query: sql }),
});

console.log('sql status:', response.status);
const rows = await response.json();
if (Array.isArray(rows)) {
  console.log(`users: ${rows.length}`);
  for (const row of rows) {
    console.log(` - ${row.email}  created ${row.created_at}  last sign-in ${row.last_sign_in_at || 'never'}`);
  }
} else {
  console.log(JSON.stringify(rows).slice(0, 500));
}

const config = await fetch(`https://api.supabase.com/v1/projects/${PROJECT}/config/auth`, {
  headers: { Authorization: `Bearer ${PAT}` },
}).then((r) => r.json());

console.log('\nmailer:');
for (const key of ['smtp_host', 'smtp_port', 'smtp_user', 'smtp_admin_email', 'smtp_sender_name', 'rate_limit_email_sent', 'mailer_autoconfirm']) {
  console.log(`  ${key}: ${config[key] === null ? '(empty)' : config[key]}`);
}