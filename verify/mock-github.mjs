/**
 * A miniature stand-in for the GitHub REST API, for end-to-end testing of sync.
 *
 * It implements only the endpoints `public/js/auth.js` and `public/js/sync.js`
 * actually call, and it serves the app itself so everything is one origin (no
 * CORS in the test; in production the API sends its own CORS headers).
 *
 * It rewrites `js/auth.js` on the fly so `API_ROOT` points at this server
 * instead of `https://api.github.com`. That one constant is the only change
 * the tested bundle carries.
 *
 * This is a test double, not an implementation: tokens are plain strings, never
 * expire, and any of them may be registered for any account. Do not reuse any
 * of it in production.
 */

import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import crypto from 'node:crypto';

const here = path.dirname(fileURLToPath(import.meta.url));
const PUBLIC = path.join(here, '..', 'public');
const AUTH_FILE = path.join(PUBLIC, 'js', 'auth.js');

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.png': 'image/png',
  '.svg': 'image/svg+xml',
  '.txt': 'text/plain; charset=utf-8',
};

const ALLOW_HEADERS = 'authorization, content-type, accept, x-github-api-version';

export function startMockGithub({ port = 5201 } = {}) {
  /** token string -> { id, login, name } */
  const tokens = new Map();
  /** gist id -> { id, description, public, ownerId, files: Map<name, content> } */
  const gists = new Map();
  /** every request, so a test can assert the app did not over-fetch */
  const log = [];

  const cors = {
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Headers': ALLOW_HEADERS,
    'Access-Control-Allow-Methods': 'GET, POST, PATCH, DELETE, OPTIONS',
  };

  const json = (res, code, body) => {
    const text = JSON.stringify(body);
    res.writeHead(code, {
      'Content-Type': 'application/json; charset=utf-8',
      'Content-Length': Buffer.byteLength(text),
      ...cors,
    });
    res.end(text);
  };

  const userFor = (req) => {
    const auth = String(req.headers.authorization || '').replace(/^Bearer\s+/i, '');
    return tokens.get(auth) || null;
  };

  /** The shape `GET /gists/:id` returns, with file contents inlined. */
  const shapeGist = (gist) => ({
    id: gist.id,
    description: gist.description,
    public: gist.public,
    files: Object.fromEntries(
      [...gist.files.entries()].map(([name, content]) => [name, {
        filename: name,
        size: Buffer.byteLength(content),
        truncated: false,
        content,
      }]),
    ),
  });

  /** The shape `GET /gists` returns: file names and sizes, no contents. */
  const shapeListItem = (gist) => ({
    id: gist.id,
    description: gist.description,
    public: gist.public,
    files: Object.fromEntries(
      [...gist.files.keys()].map((name) => [name, {
        filename: name,
        size: Buffer.byteLength(gist.files.get(name)),
        truncated: false,
      }]),
    ),
  });

  async function readBody(req) {
    const chunks = [];
    for await (const chunk of req) chunks.push(chunk);
    if (!chunks.length) return {};
    try { return JSON.parse(Buffer.concat(chunks).toString('utf8')); } catch { return {}; }
  }

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

    // ---------------------------------------------------------------- user
    if (url.pathname === '/user' && req.method === 'GET') {
      const user = userFor(req);
      if (!user) { json(res, 401, { message: 'Bad credentials' }); return; }
      json(res, 200, { id: user.id, login: user.login, name: user.name || '' });
      return;
    }

    // --------------------------------------------------------------- gists
    if (url.pathname === '/gists' && req.method === 'GET') {
      const user = userFor(req);
      if (!user) { json(res, 401, { message: 'Bad credentials' }); return; }
      const mine = [...gists.values()]
        .filter((g) => g.ownerId === user.id)
        .sort((a, b) => b.createdAt - a.createdAt)
        .map(shapeListItem);
      json(res, 200, mine);
      return;
    }

    if (url.pathname === '/gists' && req.method === 'POST') {
      const user = userFor(req);
      if (!user) { json(res, 401, { message: 'Bad credentials' }); return; }
      const body = await readBody(req);
      const files = new Map();
      for (const [name, file] of Object.entries(body.files || {})) {
        files.set(name, String(file?.content ?? ''));
      }
      const gist = {
        id: crypto.randomBytes(16).toString('hex'),
        description: String(body.description || ''),
        public: Boolean(body.public),
        ownerId: user.id,
        createdAt: Date.now(),
        files,
      };
      gists.set(gist.id, gist);
      json(res, 201, shapeGist(gist));
      return;
    }

    const gistMatch = url.pathname.match(/^\/gists\/([0-9a-f]+)$/);
    if (gistMatch) {
      const user = userFor(req);
      if (!user) { json(res, 401, { message: 'Bad credentials' }); return; }
      const gist = gists.get(gistMatch[1]);
      // A gist belonging to somebody else is indistinguishable from a missing
      // one, exactly as GitHub behaves.
      if (!gist || gist.ownerId !== user.id) { json(res, 404, { message: 'Not Found' }); return; }

      if (req.method === 'GET') { json(res, 200, shapeGist(gist)); return; }

      if (req.method === 'PATCH') {
        const body = await readBody(req);
        for (const [name, file] of Object.entries(body.files || {})) {
          if (file?.content === null) gist.files.delete(name);
          else if (file?.content !== undefined) gist.files.set(name, String(file.content));
        }
        if (typeof body.description === 'string') gist.description = body.description;
        gist.updatedAt = Date.now();
        json(res, 200, shapeGist(gist));
        return;
      }

      if (req.method === 'DELETE') {
        gists.delete(gist.id);
        res.writeHead(204, cors);
        res.end();
        return;
      }
    }

    // ------------------------------------------------------- app + override
    if (url.pathname === '/js/auth.js') {
      // Point the app at this server instead of api.github.com. Only the
      // constant changes; the rest of the module under test is byte-identical.
      const source = fs.readFileSync(AUTH_FILE, 'utf8');
      const patched = source.replace(
        /const API_ROOT = 'https:\/\/api\.github\.com';/,
        `const API_ROOT = 'http://127.0.0.1:${port}';`,
      );
      if (patched === source) {
        res.writeHead(500, { 'Content-Type': 'text/plain; charset=utf-8' });
        res.end('mock could not find API_ROOT in public/js/auth.js');
        return;
      }
      res.writeHead(200, { 'Content-Type': 'text/javascript; charset=utf-8', 'Cache-Control': 'no-store' });
      res.end(patched);
      return;
    }

    if (url.pathname.startsWith('/api/')) { json(res, 404, { ok: false, error: 'mock has no proxy' }); return; }

    // --------------------------------------------------------------- static
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
        tokens,
        gists,
        log,
        /** Register a token for an account. Returns the account it created. */
        addUser(token, { login = 'reader', name = '' } = {}) {
          const id = String(1000 + tokens.size);
          tokens.set(token, { id, login, name });
          return tokens.get(token);
        },
        /** The gists that currently exist, for assertions. */
        list() { return [...gists.values()].map(shapeListItem); },
        /** Wipe everything between test phases. */
        reset() { tokens.clear(); gists.clear(); log.length = 0; },
        close() { return new Promise((r) => server.close(r)); },
      });
    });
  });
}

// Allow `node verify/mock-github.mjs` to run it standalone for manual poking.
if (process.argv[1] && process.argv[1].endsWith('mock-github.mjs')) {
  const port = Number(process.argv[2]) || 5201;
  const mock = await startMockGithub({ port });
  mock.addUser('test-token');
  console.log(`mock GitHub on http://127.0.0.1:${mock.port}`);
  console.log('the app is served from the same origin with a rewritten API root');
  console.log('token for manual testing: test-token');
}