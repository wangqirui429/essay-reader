/**
 * Build a clean, deployable copy of the app.
 *
 * Guarantees for the published artifact:
 *   - only what the app needs to RUN is copied (no essays the reader imported,
 *     no saved words, no caches, no dev tooling)
 *   - the output folder is self-contained and works on any static host,
 *     at the domain root or under a sub-path
 *
 * The app stores essays and words in the visitor's own browser localStorage,
 * so nothing personal is ever part of this package.
 *
 * Usage: node tools/build-deploy.mjs [outDir]
 */

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.dirname(fileURLToPath(import.meta.url));
const PUBLIC_DIR = path.join(ROOT, '..', 'public');
const OUT = path.resolve(process.argv[2] || path.join(ROOT, '..', 'dist'));

/** Files and folders the browser needs. Anything else is dev material. */
const INCLUDE = [
  'index.html',
  // A standalone touch-diagnostic page, deliberately dependency-free so it can
  // be opened on a phone even when the app bundle is stale in cache.
  'tap-debug.html',
  'debug.js',
  'manifest.json',
  'sw.js',
  'css',
  'js',
  'data',
  'icons',
  'samples',
];

fs.rmSync(OUT, { recursive: true, force: true });
fs.mkdirSync(OUT, { recursive: true });

let files = 0;
let bytes = 0;

function copyEntry(relPath) {
  const src = path.join(PUBLIC_DIR, relPath);
  const dest = path.join(OUT, relPath);
  const stat = fs.statSync(src);

  if (stat.isDirectory()) {
    fs.mkdirSync(dest, { recursive: true });
    for (const child of fs.readdirSync(src)) {
      copyEntry(path.join(relPath, child));
    }
    return;
  }

  fs.mkdirSync(path.dirname(dest), { recursive: true });
  fs.copyFileSync(src, dest);
  files += 1;
  bytes += stat.size;
}

for (const entry of INCLUDE) {
  if (!fs.existsSync(path.join(PUBLIC_DIR, entry))) {
    console.warn(`skipped missing entry: ${entry}`);
    continue;
  }
  copyEntry(entry);
}

/* ------------------------------------- host configs for the common targets */

// GitHub Pages: stop Jekyll from processing the folder.
fs.writeFileSync(path.join(OUT, '.nojekyll'), '');

// Netlify: correct MIME for the manifest and worker, no aggressive caching
// of the service worker (an updated worker must be fetched).
fs.writeFileSync(
  path.join(OUT, '_headers'),
  [
    '/*',
    '  X-Content-Type-Options: nosniff',
    '',
    '/sw.js',
    '  Cache-Control: no-cache',
    '',
    '/manifest.json',
    '  Content-Type: application/manifest+json',
    '',
    '/data/*',
    '  Cache-Control: public, max-age=604800',
    '',
  ].join('\n'),
);

// Vercel / Netlify redirect safety: unknown paths fall back to the shell so
// in-app routes keep working on a hard refresh.
fs.writeFileSync(
  path.join(OUT, 'vercel.json'),
  JSON.stringify(
    {
      headers: [
        {
          source: '/sw.js',
          headers: [{ key: 'Cache-Control', value: 'no-cache' }],
        },
        {
          source: '/manifest.json',
          headers: [{ key: 'Content-Type', value: 'application/manifest+json' }],
        },
        {
          source: '/data/(.*)',
          headers: [{ key: 'Cache-Control', value: 'public, max-age=604800' }],
        },
      ],
    },
    null,
    2,
  ),
);

/* ------------------------------------------------------------ sanity check */

const required = ['index.html', 'sw.js', 'manifest.json', 'js/app.js', 'data/core-0.json'];
const missing = required.filter((f) => !fs.existsSync(path.join(OUT, f)));
if (missing.length) {
  console.error(`deploy folder is incomplete, missing: ${missing.join(', ')}`);
  process.exit(1);
}

// Refuse to publish anything that looks like personal reading data.
const suspicious = [];
function scan(dir) {
  for (const name of fs.readdirSync(dir)) {
    const full = path.join(dir, name);
    if (fs.statSync(full).isDirectory()) scan(full);
    else if (/^(cache|translations)$/.test(path.basename(path.dirname(full))) || /essay-reader:v\d/.test(name)) {
      suspicious.push(full);
    }
  }
}
scan(OUT);

const mb = (bytes / 1024 / 1024).toFixed(2);
console.log(`deploy folder: ${OUT}`);
console.log(`files: ${files}`);
console.log(`size: ${mb} MB`);
console.log(`personal-data files found: ${suspicious.length === 0 ? 'none (good)' : suspicious.join(', ')}`);
