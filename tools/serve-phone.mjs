/**
 * Serve the built app over the local network so a phone can install it.
 *
 * This server exists only to hand the files over once: the app caches itself
 * with a service worker, so after the first visit it runs entirely on the
 * phone, even with this computer switched off.
 *
 * Usage: node tools/serve-phone.mjs [port]
 */

import http from 'node:http';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'public');
const PORT = Number(process.argv[2] || process.env.PORT || 8080);

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.png': 'image/png',
  '.svg': 'image/svg+xml',
  '.txt': 'text/plain; charset=utf-8',
  '.webmanifest': 'application/manifest+json',
};

/** Every non-internal IPv4 address this machine answers on. */
function localAddresses() {
  const out = [];
  for (const [name, list] of Object.entries(os.networkInterfaces())) {
    for (const net of list || []) {
      if (net.family === 'IPv4' && !net.internal) out.push({ name, address: net.address });
    }
  }
  return out;
}

const server = http.createServer((req, res) => {
  const urlPath = decodeURIComponent(new URL(req.url, 'http://localhost').pathname);
  const rel = urlPath === '/' ? '/index.html' : urlPath;

  // No API on this deployment: the app carries its own dictionary.
  if (urlPath.startsWith('/api/')) {
    res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' }).end('No API on this deployment.');
    return;
  }

  const file = path.join(ROOT, path.normalize(rel).replace(/^[/\\]+/, ''));
  if (!file.startsWith(ROOT)) {
    res.writeHead(403).end('Forbidden');
    return;
  }

  fs.readFile(file, (err, buf) => {
    if (err) {
      // Hash routes fall back to the app shell.
      fs.readFile(path.join(ROOT, 'index.html'), (e2, html) => {
        if (e2) {
          res.writeHead(404, { 'Content-Type': 'text/plain' }).end('Not found');
          return;
        }
        res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' }).end(html);
      });
      return;
    }
    res.writeHead(200, {
      'Content-Type': MIME[path.extname(file).toLowerCase()] || 'application/octet-stream',
      // The service worker must not be cached by the browser itself.
      'Cache-Control': rel === '/sw.js' ? 'no-cache' : 'public, max-age=600',
    }).end(buf);
  });
});

server.listen(PORT, '0.0.0.0', () => {
  const addrs = localAddresses();
  console.log('\n  Essay Reader is serving on port ' + PORT + '\n');
  if (!addrs.length) {
    console.log('  No Wi-Fi address found. Connect to Wi-Fi and run this again.\n');
  } else {
    console.log('  Open one of these on your phone:\n');
    for (const { name, address } of addrs) {
      console.log(`    http://${address}:${PORT}      (${name})`);
    }
    console.log('\n  Then: browser menu -> Add to Home Screen.');
    console.log('  After the first load it works with this computer off.\n');
  }
});
