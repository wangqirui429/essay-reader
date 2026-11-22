/**
 * A miniature stand-in for the Supabase auth + REST API, for end-to-end testing.
 *
 * It implements only the endpoints `public/js/auth.js` and `public/js/sync.js`
 * actually call, and it serves the app itself so everything is one origin (no
 * CORS in the test; in production the API sends its own CORS headers).
 *
 * It rewrites `js/supabase-config.js` on the fly so `SUPABASE_URL` points at
 * this server instead of the real project. That one constant is the only change
 * the tested bundle carries — every other byte is the shipping code.
 *
 * Row-level security is simulated where it matters: a select is filtered to the
 * caller's own row, and a write to somebody else's row is refused. That is what
 * the tests need to prove the app never reads another account's data.
 *
 * This is a test double, not an implementation: passwords are plain strings,
 * tokens never expire unless asked to, and nothing here is hardened. Do not
 * reuse any of it in production.
 */

import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import crypto from 'node:crypto';

const here = path.dirname(fileURLToPath(import.meta.url));
const PUBLIC = path.join(here, '..', 'public');
const CONFIG_FILE = path.join(PUBLIC, 'js', 'supabase-config.js');

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.png': 'image/png',
  '.svg': 'image/svg+xml',
  '.txt': 'text/plain; charset=utf-8',
};

const ALLOW_HEADERS = 'authorization, apikey, content-type, accept, prefer';

export function startMockSupabase({ port = 5203, sessionTtl = 3600 } = {}) {
  /** email -> { id, email, password } */
  const users = new Map();
  /** access token -> { userId, expiresAt } */
  const tokens = new Map();
  /** refresh token -> userId */
  const refreshTokens = new Map();
  /** userId -> { data, rev } */
  const rows = new Map();
  /** every request, so a test can assert the app did not over-fetch */
  const log = [];
  /** addresses a reset mail was requested for */
  const recoveries = [];

  let ttl = sessionTtl;

  const cors = {
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Headers': ALLOW_HEADERS,
    'Access-Control-Allow-Methods': 'GET, POST, PUT, PATCH, DELETE, OPTIONS',
  };

  const json = (res, code, body) => {
    const text = JSON.stringify(body ?? null);
    res.writeHead(code, {
      'Content-Type': 'application/json; charset=utf-8',
      'Content-Length': Buffer.byteLength(text),
      ...cors,
    });
    res.end(text);
  };

  const issue = (user) => {
    const access = `at_${crypto.randomBytes(12).toString('hex')}`;
    const refresh = `rt_${crypto.randomBytes(12).toString('hex')}`;
    tokens.set(access, { userId: user.id, expiresAt: Math.floor(Date.now() / 1000) + ttl });
    refreshTokens.set(refresh, user.id);
    return {
      access_token: access,
      refresh_token: refresh,
      token_type: 'bearer',
      expires_in: ttl,
      expires_at: Math.floor(Date.now() / 1000) + ttl,
      user: { id: user.id, email: user.email, aud: 'authenticated', role: 'authenticated' },
    };
  };

  const bearer = (req) => String(req.headers.authorization || '').replace(/^Bearer\s+/i, '');

  const userFor = (req) => {
    const token = bearer(req);
    if (!token) return null;
    const record = tokens.get(token);
    if (!record) return null;
    if (record.expiresAt <= Math.floor(Date.now() / 1000)) return null;
    return [...users.values()].find((u) => u.id === record.userId) || null;
  };

  async function readBody(req) {
    const chunks = [];
    for await (const chunk of req) chunks.push(chunk);
    if (!chunks.length) return {};
    try { return JSON.parse(Buffer.concat(chunks).toString('utf8')); } catch { return {}; }
  }

  const byEmail = (email) => users.get(String(email || '').trim().toLowerCase()) || null;

  const server = http.createServer(async (req, res) => {
    let url;
    try { url = new URL(req.url, `http://127.0.0.1:${port}`); } catch {
      res.writeHead(400, cors); res.end(); return;
    }
    log.push({ method: req.method, path: url.pathname, query: url.search });

    if (req.method === 'OPTIONS') {
      res.writeHead(204, cors);
      res.end();
      return;
    }

    /* ------------------------------------------------------------------ auth */

    if (url.pathname === '/auth/v1/signup' && req.method === 'POST') {
      const body = await readBody(req);
      const email = String(body.email || '').trim().toLowerCase();
      const password = String(body.password || '');
      if (!email.includes('@')) { json(res, 400, { error_code: 'validation_failed', msg: 'invalid email' }); return; }
      if (password.length < 6) { json(res, 422, { error_code: 'weak_password', msg: 'Password should be at least 6 characters' }); return; }
      if (byEmail(email)) {
        json(res, 400, { error_code: 'user_already_exists', msg: 'User already registered' });
        return;
      }
      const user = { id: crypto.randomUUID(), email, password };
      users.set(email, user);
      json(res, 200, issue(user));
      return;
    }

    if (url.pathname === '/auth/v1/token' && req.method === 'POST') {
      const body = await readBody(req);
      const grant = url.searchParams.get('grant_type');

      if (grant === 'password') {
        const user = byEmail(body.email);
        if (!user || user.password !== String(body.password || '')) {
          json(res, 400, { error_code: 'invalid_grant', error: 'invalid_grant', msg: 'Invalid login credentials' });
          return;
        }
        json(res, 200, issue(user));
        return;
      }

      if (grant === 'refresh_token') {
        const userId = refreshTokens.get(String(body.refresh_token || ''));
        if (!userId) {
          json(res, 400, { error_code: 'refresh_token_not_found', msg: 'Invalid Refresh Token' });
          return;
        }
        // GoTrue rotates the refresh token on every use.
        refreshTokens.delete(String(body.refresh_token));
        const user = [...users.values()].find((u) => u.id === userId);
        if (!user) { json(res, 400, { error_code: 'user_not_found', msg: 'no user' }); return; }
        json(res, 200, issue(user));
        return;
      }

      json(res, 400, { error_code: 'unsupported_grant_type', msg: grant || 'missing grant' });
      return;
    }

    if (url.pathname === '/auth/v1/logout' && req.method === 'POST') {
      const token = bearer(req);
      if (token) tokens.delete(token);
      res.writeHead(204, cors);
      res.end();
      return;
    }

    if (url.pathname === '/auth/v1/user' && req.method === 'GET') {
      const user = userFor(req);
      if (!user) { json(res, 401, { error_code: 'bad_jwt', msg: 'invalid claim: missing sub claim' }); return; }
      json(res, 200, { id: user.id, email: user.email, aud: 'authenticated', role: 'authenticated' });
      return;
    }

    if (url.pathname === '/auth/v1/user' && req.method === 'PUT') {
      const user = userFor(req);
      if (!user) { json(res, 401, { error_code: 'bad_jwt', msg: 'invalid claim' }); return; }
      const body = await readBody(req);
      if (typeof body.password === 'string') {
        if (body.password.length < 6) {
          json(res, 422, { error_code: 'weak_password', msg: 'Password should be at least 6 characters' });
          return;
        }
        user.password = body.password;
      }
      if (typeof body.email === 'string' && body.email.includes('@')) {
        users.delete(user.email);
        user.email = body.email.trim().toLowerCase();
        users.set(user.email, user);
      }
      json(res, 200, { id: user.id, email: user.email });
      return;
    }

    if (url.pathname === '/auth/v1/recover' && req.method === 'POST') {
      const body = await readBody(req);
      const email = String(body.email || '').trim().toLowerCase();
      recoveries.push({ email, redirectTo: String(body.redirect_to || '') });
      // GoTrue answers 200 whether or not the address exists.
      json(res, 200, {});
      return;
    }

    /* ------------------------------------------------------------------ rest */

    if (url.pathname === '/rest/v1/essay_reader_state') {
      const user = userFor(req);
      if (!user) {
        json(res, 401, { code: '401', message: 'JWT expired or missing' });
        return;
      }

      if (req.method === 'GET') {
        // PostgREST filters by the URL, RLS filters by the token; both apply.
        const wanted = url.searchParams.get('user_id') || '';
        const eqMatch = wanted.match(/^eq\.(.+)$/);
        const requested = eqMatch ? decodeURIComponent(eqMatch[1]) : null;
        if (requested && requested !== user.id) { json(res, 200, []); return; }
        const row = rows.get(user.id);
        json(res, 200, row ? [{ data: row.data, rev: row.rev }] : []);
        return;
      }

      if (req.method === 'POST') {
        const body = await readBody(req);
        const payload = Array.isArray(body) ? body[0] : body;
        const target = String(payload?.user_id || '');
        if (target && target !== user.id) {
          // A row belonging to another account is invisible, exactly as RLS
          // makes it: the write simply does not land on their row.
          json(res, 403, { code: '42501', message: 'new row violates row-level security policy' });
          return;
        }
        const previous = rows.get(user.id);
        rows.set(user.id, { data: payload?.data ?? {}, rev: (previous?.rev || 0) + 1 });
        res.writeHead(201, { ...cors, 'Content-Type': 'application/json; charset=utf-8' });
        res.end();
        return;
      }
    }

    /* -------------------------------------------------------- app + override */

    if (url.pathname === '/js/supabase-config.js') {
      // Point the app at this server instead of the real project. Only the URL
      // constant changes; the rest of the module under test is byte-identical.
      const source = fs.readFileSync(CONFIG_FILE, 'utf8');
      const patched = source.replace(
        /export const SUPABASE_URL = 'https:\/\/[^']+';/,
        `export const SUPABASE_URL = 'http://127.0.0.1:${port}';`,
      );
      if (patched === source) {
        res.writeHead(500, { 'Content-Type': 'text/plain; charset=utf-8' });
        res.end('mock could not find SUPABASE_URL in public/js/supabase-config.js');
        return;
      }
      res.writeHead(200, { 'Content-Type': 'text/javascript; charset=utf-8', 'Cache-Control': 'no-store' });
      res.end(patched);
      return;
    }

    /* --------------------------------------------------------------- static */

    let rel = decodeURIComponent(url.pathname);
    if (rel === '/' || rel === '') rel = '/index.html';
    const file = path.join(PUBLIC, rel);
    if (!file.startsWith(PUBLIC)) { res.writeHead(403, cors); res.end(); return; }
    fs.readFile(file, (err, buf) => {
      if (err) { res.writeHead(404, cors); res.end('not found'); return; }
      res.writeHead(200, {
        'Content-Type': MIME[path.extname(file)] || 'application/octet-stream',
        'Cache-Control': 'no-store',
      });
      res.end(buf);
    });
  });

  return new Promise((resolve) => {
    server.listen(port, '127.0.0.1', () => {
      resolve({
        port,
        server,
        users,
        rows,
        tokens,
        recoveries,
        log,
        /** Create an account directly, without going through the UI. */
        addUser(email, password) {
          const user = { id: crypto.randomUUID(), email: String(email).toLowerCase(), password };
          users.set(user.email, user);
          return user;
        },
        /** Mint a session for an account (used to seed a second device). */
        sessionFor(email) {
          const user = byEmail(email);
          return user ? issue(user) : null;
        },
        /** Shorten sessions so the refresh path can be exercised. */
        setSessionTtl(seconds) { ttl = seconds; },
        /** Wipe everything between test phases. */
        reset() {
          users.clear();
          tokens.clear();
          refreshTokens.clear();
          rows.clear();
          recoveries.length = 0;
          log.length = 0;
          ttl = sessionTtl;
        },
        close() { return new Promise((r) => server.close(r)); },
      });
    });
  });
}

// Allow `node verify/mock-supabase.mjs` to run it standalone for manual poking.
if (process.argv[1] && process.argv[1].endsWith('mock-supabase.mjs')) {
  const port = Number(process.argv[2]) || 5203;
  const mock = await startMockSupabase({ port });
  mock.addUser('reader@example.com', 'password123');
  console.log(`mock Supabase on http://127.0.0.1:${mock.port}`);
  console.log('the app is served from the same origin with a rewritten SUPABASE_URL');
  console.log('account for manual testing: reader@example.com / password123');
}