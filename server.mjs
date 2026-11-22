/**
 * Essay Reader local server.
 *
 * Serves the static front-end from ./public and exposes a dictionary proxy so
 * the browser can reach an English -> Chinese dictionary without CORS problems.
 * Lookups are cached on disk, so words previously opened still explain offline.
 *
 * Routes:
 *   GET /api/health      -> { ok, cached }
 *   GET /api/dict?q=WORD -> normalized dictionary entry (Chinese glosses)
 *   GET /*               -> static file from ./public
 *
 * No third-party dependencies: run with `node server.mjs`.
 */

import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.dirname(fileURLToPath(import.meta.url));
const PUBLIC_DIR = path.join(ROOT, 'public');
const CACHE_DIR = path.join(ROOT, 'data', 'cache');

const PORT = Number(process.env.PORT || 5180);
const HOST = process.env.HOST || '127.0.0.1';

const UPSTREAM = (word) =>
  'https://dict.youdao.com/jsonapi_s?doctype=json&jsonversion=4&q=' + encodeURIComponent(word);

const UPSTREAM_HEADERS = {
  'User-Agent':
    'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Safari/537.36',
  Origin: 'https://dict.youdao.com',
  Referer: 'https://www.youdao.com/',
  Accept: 'application/json, text/plain, */*',
};

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.ico': 'image/x-icon',
  '.woff2': 'font/woff2',
  '.txt': 'text/plain; charset=utf-8',
};

fs.mkdirSync(CACHE_DIR, { recursive: true });

const memoryCache = new Map();

/**
 * Make sure the cache directory exists before using it. A cache folder can be
 * deleted while the server is running (cleaning up disk space, for instance);
 * that must never take the server down.
 */
function ensureCacheDir() {
  try {
    if (!fs.existsSync(CACHE_DIR)) fs.mkdirSync(CACHE_DIR, { recursive: true });
    return true;
  } catch {
    return false;
  }
}

/** Turn a request word into a safe cache file name. */
function cacheFile(word) {
  const safe = word.toLowerCase().replace(/[^a-z0-9'&\-]/g, '_').slice(0, 64) || 'empty';
  return path.join(CACHE_DIR, `${safe}-${simpleHash(word.toLowerCase())}.json`);
}

function simpleHash(str) {
  let h = 5381;
  for (let i = 0; i < str.length; i += 1) h = ((h << 5) + h + str.charCodeAt(i)) | 0;
  return (h >>> 0).toString(36);
}

/** Read a previously cached lookup from disk. */
function readDiskCache(word) {
  try {
    const file = cacheFile(word);
    if (!fs.existsSync(file)) return null;
    return JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch {
    return null;
  }
}

function writeDiskCache(word, payload) {
  try {
    if (!ensureCacheDir()) return;
    fs.writeFileSync(cacheFile(word), JSON.stringify(payload), 'utf8');
  } catch {
    /* cache writing is best effort */
  }
}

function asArray(value) {
  if (value == null) return [];
  return Array.isArray(value) ? value : [value];
}

function stripTags(text) {
  return String(text ?? '').replace(/<[^>]*>/g, '');
}

/**
 * Reduce the upstream payload into the compact shape the front-end uses.
 * Shape: { word, phonetics: { us, uk }, glosses: [{ pos, text }], phrases:
 * [{ text, translation }], examples: [{ en, zh }], source }
 */
export function normalizeEntry(word, json) {
  const ec = json?.ec ?? {};
  const ecWord = ec.word ?? {};
  const simpleWord = asArray(json?.simple?.word)[0] ?? {};

  const glosses = asArray(ecWord.trs)
    .map((t) => ({ pos: String(t.pos ?? '').trim(), text: stripTags(t.tran).trim() }))
    .filter((g) => g.text)
    .slice(0, 8);

  const phrases = asArray(json?.phrs?.phrs)
    .map((p) => ({
      text: String(p.headword ?? '').trim(),
      translation: stripTags(p.translation).trim(),
    }))
    .filter((p) => p.text && p.translation)
    .slice(0, 8);

  const web = asArray(json?.web_trans?.['web-translation'])
    .flatMap((item) =>
      asArray(item.trans).map((t) => ({
        text: String(item.key ?? '').trim(),
        translation: stripTags(t.value).trim(),
      })),
    )
    .filter((w) => w.translation)
    .slice(0, 6);

  const examples = [
    ...asArray(json?.blng_sents_part?.['sentence-pair']).map((s) => ({
      en: stripTags(s['sentence-eng']).trim(),
      zh: stripTags(s['sentence-translation']).trim(),
    })),
    ...asArray(json?.collins?.collins_entries?.[0]?.entries?.entry?.[0]?.tran_entry?.[0]?.pos_entry?.exam_sents?.sent).map(
      (s) => ({ en: stripTags(s.eng_sent).trim(), zh: stripTags(s.chn_sent).trim() }),
    ),
  ]
    .filter((e) => e.en && e.zh)
    .slice(0, 3);

  const collinsLines = asArray(json?.collins?.collins_entries?.[0]?.entries?.entry?.[0]?.tran_entry)
    .map((entry) => stripTags(entry?.tran ?? '').trim())
    .filter(Boolean)
    .slice(0, 3);

  const exam = asArray(ec.exam_type).map((t) => String(t).trim()).filter(Boolean);

  if (!glosses.length && !phrases.length && !web.length && !collinsLines.length) return null;

  return {
    word: String(json?.input ?? word).trim() || word,
    phonetics: {
      us: stripTags(ecWord.usphone ?? simpleWord.usphone ?? '').replace(/^\/|\/$/g, ''),
      uk: stripTags(ecWord.ukphone ?? simpleWord.ukphone ?? '').replace(/^\/|\/$/g, ''),
    },
    glosses,
    phrases,
    web,
    collins: collinsLines,
    examples,
    exam,
    source: 'youdao',
    at: Date.now(),
  };
}

/** Fetch one lookup from upstream with a hard timeout. */
async function fetchUpstream(word) {
  const res = await fetch(UPSTREAM(word), {
    headers: UPSTREAM_HEADERS,
    signal: AbortSignal.timeout(9000),
  });
  if (!res.ok) throw new Error(`upstream status ${res.status}`);
  const json = await res.json();
  return normalizeEntry(word, json);
}

/**
 * Dictionary lookup with three levels: memory -> upstream (then disk cache) ->
 * disk cache. The disk cache keeps the app usable with no network access.
 */
async function lookup(word) {
  const key = word.toLowerCase();
  if (memoryCache.has(key)) return { entry: memoryCache.get(key), from: 'memory' };

  try {
    const entry = await fetchUpstream(word);
    if (entry) {
      memoryCache.set(key, entry);
      writeDiskCache(key, entry);
      return { entry, from: 'network' };
    }
    throw new Error('empty upstream entry');
  } catch (err) {
    const cached = readDiskCache(word);
    if (cached) {
      memoryCache.set(key, cached);
      return { entry: cached, from: 'cache' };
    }
    throw err;
  }
}

function sendJson(res, status, obj) {
  const body = JSON.stringify(obj);
  res.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Content-Length': Buffer.byteLength(body),
    'Cache-Control': 'no-store',
  });
  res.end(body);
}

function serveStatic(req, res, urlPath) {
  // A malformed percent-escape ("/%ZZ") makes decodeURIComponent throw, which
  // would otherwise escape the request handler and strand the connection.
  let decoded;
  try {
    decoded = decodeURIComponent(urlPath);
  } catch {
    sendJson(res, 400, { error: 'bad_escape' });
    return;
  }

  let rel = decoded;
  if (rel === '/' || rel === '') rel = '/index.html';
  const target = path.join(PUBLIC_DIR, path.normalize(rel).replace(/^([/\\])+/, ''));
  if (!target.startsWith(PUBLIC_DIR)) {
    res.writeHead(403).end('Forbidden');
    return;
  }
  fs.stat(target, (err, stat) => {
    if (err || !stat.isFile()) {
      // Unknown non-API path: hand it to the SPA entry so deep links keep working.
      const fallback = path.join(PUBLIC_DIR, 'index.html');
      fs.readFile(fallback, (e2, buf) => {
        if (e2) {
          res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' }).end('Not found');
          return;
        }
        res.writeHead(200, { 'Content-Type': MIME['.html'] }).end(buf);
      });
      return;
    }
    const type = MIME[path.extname(target).toLowerCase()] || 'application/octet-stream';
    res.writeHead(200, { 'Content-Type': type, 'Content-Length': stat.size });
    const stream = fs.createReadStream(target);
    // A read error mid-stream must not take the process down.
    stream.on('error', () => {
      if (!res.headersSent) res.writeHead(500, { 'Content-Type': 'text/plain' });
      res.end();
    });
    stream.pipe(res);
  });
}

const server = http.createServer((req, res) => {
  // URL parsing must never throw out of this handler. A malformed request line
  // or a junk Host header makes `new URL` raise, and an exception here leaves
  // the socket hanging with no reply — the client waits until it times out.
  let url;
  try {
    url = new URL(req.url, `http://${req.headers.host || 'localhost'}`);
  } catch {
    sendJson(res, 400, { error: 'bad_request' });
    return;
  }

  if (url.pathname === '/api/health') {
    // Counting cache files must never be able to crash the server: the folder
    // may be missing if somebody cleaned up disk space while it was running.
    let files = 0;
    try {
      files = fs.readdirSync(CACHE_DIR).length;
    } catch {
      files = 0;
    }
    sendJson(res, 200, { ok: true, cached: memoryCache.size, files });
    return;
  }

  if (url.pathname === '/api/dict') {
    const raw = (url.searchParams.get('q') || '').trim();
    if (!raw) {
      sendJson(res, 400, { error: 'missing_query' });
      return;
    }
    if (raw.length > 64) {
      sendJson(res, 400, { error: 'query_too_long' });
      return;
    }
    lookup(raw)
      .then(({ entry, from }) => sendJson(res, 200, { word: raw, entry, from }))
      .catch((err) => {
        console.warn(`[dict] ${raw}: ${err.message}`);
        sendJson(res, 502, { word: raw, error: 'lookup_failed', detail: err.message });
      });
    return;
  }

  if (req.method !== 'GET' && req.method !== 'HEAD') {
    sendJson(res, 405, { error: 'method_not_allowed' });
    return;
  }

  serveStatic(req, res, url.pathname);
});

// A handler that throws synchronously would otherwise take the process down.
server.on('clientError', (err, socket) => {
  // Malformed HTTP, oversized headers, reset connections: answer politely and
  // close, rather than letting the socket linger.
  if (socket.writable) {
    socket.end('HTTP/1.1 400 Bad Request\r\nConnection: close\r\n\r\n');
  } else {
    socket.destroy();
  }
});

server.listen(PORT, HOST, () => {
  console.log(`Essay Reader running at http://${HOST}:${PORT}`);
  console.log(`Static root: ${PUBLIC_DIR}`);
  console.log(`Dictionary cache: ${CACHE_DIR}`);
});

// A single bad request must never take the whole app down for the reader.
process.on('uncaughtException', (err) => {
  console.error('[server] uncaught exception, continuing:', err.message);
});
process.on('unhandledRejection', (err) => {
  console.error('[server] unhandled rejection, continuing:', err?.message || err);
});
