/**
 * Publish the built app to the `gh-pages` branch through the GitHub API.
 *
 * GitHub Pages accepts a branch as its source, and this machine's git transport
 * cannot reach github.com, so the branch is assembled with the Git data API:
 * every file in `dist/` becomes a blob, the blobs become a tree, the tree
 * becomes a commit, and the branch points at that commit.
 *
 * The branch is created as an orphan (no shared history with `main`) because it
 * holds build output, not source.
 *
 * Usage: node tools/publish-gh-pages.mjs <owner/repo> [sourceDir]
 */

import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const [repoArg, srcArg] = process.argv.slice(2);
if (!repoArg) {
  console.error('usage: node tools/publish-gh-pages.mjs owner/repo [sourceDir]');
  process.exit(1);
}

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const SRC = path.resolve(srcArg || path.join(ROOT, 'dist'));
const BRANCH = 'gh-pages';

if (!fs.existsSync(path.join(SRC, 'index.html'))) {
  console.error(`no index.html in ${SRC} — run tools/build-deploy.mjs first`);
  process.exit(1);
}

function ghApi(method, endpoint, body) {
  const args = ['api', endpoint, '--method', method];
  if (body) args.push('--input', '-');
  else args.push('--silent');
  try {
    const out = execFileSync('gh', args, {
      input: body ? JSON.stringify(body) : undefined,
      encoding: 'utf8',
      maxBuffer: 128 * 1024 * 1024,
    });
    return out ? JSON.parse(out) : null;
  } catch (err) {
    const detail = (err.stdout || err.stderr || err.message || '').toString();
    throw new Error(`${method} ${endpoint}: ${detail.trim()}`);
  }
}

/* ------------------------------------------------------------ collect files */

const files = [];
(function walk(dir) {
  for (const name of fs.readdirSync(dir)) {
    const full = path.join(dir, name);
    const rel = path.relative(SRC, full).replace(/\\/g, '/');
    if (name === '.DS_Store' || name === 'Thumbs.db') continue;
    const stat = fs.statSync(full);
    if (stat.isDirectory()) walk(full);
    else files.push({ rel, full, size: stat.size });
  }
})(SRC);

const totalMb = (files.reduce((s, f) => s + f.size, 0) / 1024 / 1024).toFixed(2);
console.log(`publishing ${files.length} files (${totalMb} MB) to ${BRANCH}`);

/* ------------------------------------------------------------------ upload */

const blobs = [];
let done = 0;
for (const f of files) {
  const created = ghApi('POST', `repos/${repoArg}/git/blobs`, {
    content: fs.readFileSync(f.full).toString('base64'),
    encoding: 'base64',
  });
  blobs.push({ path: f.rel, mode: '100644', type: 'blob', sha: created.sha });
  done += 1;
  process.stdout.write(`\r  ${done}/${files.length} ${f.rel}`.padEnd(70));
}
process.stdout.write('\n');

const tree = ghApi('POST', `repos/${repoArg}/git/trees`, { tree: blobs });
console.log(`tree: ${tree.sha.slice(0, 7)}`);

const commit = ghApi('POST', `repos/${repoArg}/git/commits`, {
  message: `Publish site (${new Date().toISOString().slice(0, 16).replace('T', ' ')} UTC)`,
  tree: tree.sha,
  parents: [],
});
console.log(`commit: ${commit.sha.slice(0, 7)}`);

// Create the branch, or reset it if it is already there.
//
// The existing-branch case is checked first rather than discovered by letting a
// POST fail: `gh` prints "Reference already exists (HTTP 422)" to stderr before
// the exception is caught, and that noise reads like a failed publish even
// though the PATCH that follows succeeds.
let created = false;
let branchExists = false;
try {
  ghApi('GET', `repos/${repoArg}/git/ref/heads/${BRANCH}`);
  branchExists = true;
} catch {
  branchExists = false;
}

if (branchExists) {
  ghApi('PATCH', `repos/${repoArg}/git/refs/heads/${BRANCH}`, { sha: commit.sha, force: true });
} else {
  ghApi('POST', `repos/${repoArg}/git/refs`, { ref: `refs/heads/${BRANCH}`, sha: commit.sha });
  created = true;
}
console.log(`branch ${BRANCH} ${created ? 'created' : 'updated'}`);

console.log(`\ndone: https://github.com/${repoArg}/tree/${BRANCH}`);
