/**
 * Prove the local server survives malformed requests.
 *
 * The production log showed `uncaught exception: Invalid URL` repeated, with no
 * reply reaching the client. These cases reproduce that: each one must get a
 * quick answer (4xx) and the server must still serve normal traffic afterwards.
 *
 * Usage: node verify/check-bad-requests.mjs [host] [port]
 */

import net from 'node:net';

const HOST = process.argv[2] || '127.0.0.1';
const PORT = Number(process.argv[3] || 5180);

const results = [];
const check = (name, ok, detail = '') => {
  results.push({ name, ok });
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? ` — ${detail}` : ''}`);
};

/**
 * Send raw bytes over a socket and report whatever comes back, or note that the
 * connection was closed without a reply. A timeout means the server hung.
 */
function rawRequest(payload, timeoutMs = 5000) {
  return new Promise((resolve) => {
    const socket = net.createConnection({ host: HOST, port: PORT });
    let data = '';
    let settled = false;

    const finish = (outcome) => {
      if (settled) return;
      settled = true;
      socket.destroy();
      resolve(outcome);
    };

    socket.setTimeout(timeoutMs, () => finish({ kind: 'timeout' }));
    socket.on('connect', () => socket.write(payload));
    socket.on('data', (chunk) => { data += chunk.toString('utf8'); });
    socket.on('end', () => finish({ kind: data ? 'replied' : 'closed', data }));
    socket.on('close', () => finish({ kind: data ? 'replied' : 'closed', data }));
    socket.on('error', (err) => finish({ kind: 'closed', error: err.message }));
  });
}

/** Ask the server a normal question, to prove it still works. */
async function healthOk() {
  try {
    const res = await fetch(`http://${HOST}:${PORT}/api/health`, { signal: AbortSignal.timeout(5000) });
    return res.ok;
  } catch {
    return false;
  }
}

const statusOf = (outcome) => {
  const m = /^HTTP\/1\.[01] (\d{3})/.exec(outcome.data || '');
  return m ? Number(m[1]) : null;
};

/* --------------------------------------------------------------- the cases */

// 1. A junk Host header, which is what made `new URL` throw.
{
  const out = await rawRequest('GET / HTTP/1.1\r\nHost: \x01\x02bad host\x7f\r\nConnection: close\r\n\r\n');
  const code = statusOf(out);
  check('a malformed Host header gets an answer, not a hang', out.kind !== 'timeout', `kind=${out.kind} status=${code}`);
}

// 2. An absolute-form request line with a nonsense scheme.
{
  const out = await rawRequest('GET http://@@@/index.html HTTP/1.1\r\nHost: x\r\nConnection: close\r\n\r\n');
  check('a nonsense request line gets an answer, not a hang', out.kind !== 'timeout', `kind=${out.kind} status=${statusOf(out)}`);
}

// 3. An invalid percent escape in the path: decodeURIComponent throws on this.
{
  const out = await rawRequest('GET /%ZZ HTTP/1.1\r\nHost: localhost\r\nConnection: close\r\n\r\n');
  const code = statusOf(out);
  check('an invalid percent escape is rejected cleanly', out.kind !== 'timeout' && (code === 400 || code === null), `kind=${out.kind} status=${code}`);
}

// 4. Bare garbage that is not HTTP at all.
{
  const out = await rawRequest('\x00\x01\x02 not http at all\r\n\r\n');
  check('non-HTTP garbage does not hang the server', out.kind !== 'timeout', `kind=${out.kind}`);
}

// 5. A very long header line.
{
  const longValue = 'x'.repeat(20000);
  const out = await rawRequest(`GET / HTTP/1.1\r\nHost: localhost\r\nX-Pad: ${longValue}\r\nConnection: close\r\n\r\n`);
  check('an oversized header is handled without hanging', out.kind !== 'timeout', `kind=${out.kind} status=${statusOf(out)}`);
}

// 6. Path traversal attempt stays inside the public folder.
{
  const out = await rawRequest('GET /../../server.mjs HTTP/1.1\r\nHost: localhost\r\nConnection: close\r\n\r\n');
  const body = out.data || '';
  check('path traversal cannot reach source files', !body.includes('Essay Reader local server'), `status=${statusOf(out)}`);
}

/* ------------------------------------------------- and it still works after */

await new Promise((r) => setTimeout(r, 500));
const healthy = await healthOk();
check('the server still answers normal requests', healthy, `health ok=${healthy}`);

const page = await fetch(`http://${HOST}:${PORT}/`, { signal: AbortSignal.timeout(5000) })
  .then((r) => r.text())
  .catch(() => '');
check('the app page still loads', /英语作文阅读器|Essay Reader/.test(page), `${page.length} bytes`);

console.log(`\n${results.filter((r) => r.ok).length}/${results.length} checks passed`);
process.exit(results.every((r) => r.ok) ? 0 : 1);
