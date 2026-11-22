/**
 * Probe the project's log tables and print recent auth lines, so an SMTP
 * failure is visible instead of hidden behind GoTrue's 200.
 *
 * Usage: node tools/auth-logs.mjs
 */

const PROJECT = 'ejnrmtkcigjwbubcxbgy';
const PAT = process.env.SUPABASE_PAT;
if (!PAT) throw new Error('SUPABASE_PAT is not set');

const base = `https://api.supabase.com/v1/projects/${PROJECT}/analytics/endpoints/logs`;

async function query(sql) {
  const response = await fetch(`${base}?sql=${encodeURIComponent(sql)}`, {
    headers: { Authorization: `Bearer ${PAT}` },
  });
  const body = await response.json();
  return { status: response.status, body };
}

const candidates = [
  "select timestamp, event_message from logs where source_id = 'auth' order by timestamp desc limit 20",
  "select timestamp, event_message from logs order by timestamp desc limit 20",
  'select timestamp, event_message from auth_event_logs order by timestamp desc limit 20',
  "select timestamp, event_message from function_logs order by timestamp desc limit 5",
];

for (const sql of candidates) {
  const { status, body } = await query(sql);
  const rows = body?.result;
  if (Array.isArray(rows)) {
    console.log(`ok: ${sql}`);
    for (const row of rows) {
      console.log(`${row.timestamp}  ${String(row.event_message).slice(0, 200)}`);
    }
    process.exit(0);
  }
  console.log(`no: ${status} ${JSON.stringify(body).slice(0, 120)}`);
}

console.log('no log table answered');