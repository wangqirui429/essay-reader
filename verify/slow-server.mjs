/**
 * A static server for `public/` that can be slow on purpose.
 *
 * The dictionary ships as eight JSON files and a reader on a poor connection can
 * wait many seconds for them. Reproducing that locally is the only way to test
 * what a card does while the data is still in flight: a local server answers in
 * under a millisecond, which hides the whole class of bug.
 *
 * Usage: startSlowServer({ port, delay: { 'data/core-0.json': 6000 } })
 */

import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.join(HERE, '..', 'public');

const TYPES = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.png': 'image/png',
  '.svg': 'image/svg+xml',
  '.ico': 'image/x-icon',
  '.txt': 'text/plain; charset=utf-8',
  '.webmanifest': 'application/manifest+json',
};

/**
 * @param {{port: number, delays?: Array<{match: RegExp, ms: number}>}} options
 * @returns {Promise<{port: number, urls: string[], close: () => Promise<void>}>}
 */
export function startSlowServer({ port, delays = [] } = {}) {
  /** Requests that reached the server, in order: useful for asserting order. */
  const log = [];

  const server = http.createServer((req, res) => {
    let urlPath = '/';
    try {
      urlPath = decodeURIComponent(new URL(req.url, 'http://127.0.0.1').pathname);
    } catch {
      res.writeHead(400).end('bad request');
      return;
    }
    if (urlPath.endsWith('/')) urlPath += 'index.html';

    const rel = urlPath.replace(/^\/+/, '');
    const file = path.join(ROOT, rel);
    if (!file.startsWith(ROOT)) {
      res.writeHead(403).end('forbidden');
      return;
    }

    log.push(rel);
    const delay = delays.reduce((ms, d) => (d.match.test(rel) ? ms + d.ms : ms), 0);

    const send = () => {
      fs.readFile(file, (err, buf) => {
        if (err) {
          res.writeHead(404, { 'content-type': 'text/plain' }).end('not found');
          return;
        }
        res.writeHead(200, {
          'content-type': TYPES[path.extname(file)] || 'application/octet-stream',
          'cache-control': 'no-store',
        });
        res.end(buf);
      });
    };

    if (delay > 0) setTimeout(send, delay);
    else send();
  });

  return new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(port, '127.0.0.1', () => {
      const actual = server.address().port;
      resolve({
        port: actual,
        log,
        urls: [`http://127.0.0.1:${actual}/`],
        close: () => new Promise((done) => server.close(() => done())),
      });
    });
  });
}