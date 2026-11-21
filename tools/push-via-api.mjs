/**
 * Push the repository contents to GitHub through the REST API.
 *
 * The git transport cannot reach github.com from this machine (the connection
 * is reset), while the HTTPS API used by `gh` works. This script therefore
 * uploads the source tree with the Contents API, committing everything as one
 * tree so the repository history starts clean.
 *
 * Usage: node tools/push-via-api.mjs <owner/repo> [branch] [sourceDir]
 */

import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const [repoArg, branch = 'main', srcArg] = process.argv.slice(2);
if (!repoArg) {
  console.error('usage: node tools/push-via-api.mjs owner/repo [branch] [sourceDir]');
  process.exit(1);
}

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const SRC = path.resolve(srcArg || ROOT);

/** Read a file from the working tree as base64. */
const b64 = (file) => fs.readFileSync(file).toString('base64');

/** Call gh as a simple REST client; it already holds a working token. */
function ghApi(method, endpoint, body) {
  const args = ['api', endpoint, '--method', method];
  if (body) {
    args.push('--input', '-');
  } else {
    args.push('--silent');
  }
  try {
    const out = execFileSync('gh', args, {
      input: body ? JSON.stringify(body) : undefined,
      encoding: 'utf8',
      maxBuffer: 64 * 1024 * 1024,
      // Capture stderr instead of inheriting it: a handled "reference already
      // exists" reply used to print as if the push had failed.
      stdio: ['pipe', 'pipe', 'pipe'],
    });
    return out ? JSON.parse(out) : null;
  } catch (err) {
    const detail = err.stdout || err.stderr || err.message;
    throw new Error(`${method} ${endpoint} failed: ${detail}`);
  }
}

/* ------------------------------------------------ bootstrap the repository */

// An empty repository has no commit, and the git data API refuses to create
// blobs in that state. The Contents API can create the very first commit, so
// seed it with the README (and a .gitignore, which is safe to include).
async function seedIfEmpty() {
  try {
    ghApi('GET', `repos/${repoArg}/contents/README.md?ref=${branch}`);
    return false; // already has content
  } catch {
    /* not there yet */
  }
  const seedPath = path.join(SRC, 'README.md');
  const body = {
    message: 'Initial commit',
    content: b64(seedPath),
    branch,
  };
  ghApi('PUT', `repos/${repoArg}/contents/README.md`, body);
  console.log('repository seeded with an initial commit');
  return true;
}

const seeded = await seedIfEmpty();

/* ------------------------------------------------------ which files to send */

const SKIP_DIRS = new Set(['.git', 'node_modules', 'dist', 'ref', 'verify/shots', 'src', '.github']);
const SKIP_FILES = new Set(['.DS_Store', 'Thumbs.db']);

// A token without the `workflow` scope cannot create .github/workflows files
// through the API. Set INCLUDE_WORKFLOWS=1 once the scope has been granted.
const INCLUDE_WORKFLOWS = process.env.INCLUDE_WORKFLOWS === '1';
if (INCLUDE_WORKFLOWS) SKIP_DIRS.delete('.github');

const files = [];
(function walk(dir) {
  for (const name of fs.readdirSync(dir)) {
    const full = path.join(dir, name);
    const rel = path.relative(SRC, full).replace(/\\/g, '/');
    if (SKIP_FILES.has(name)) continue;
    if (SKIP_DIRS.has(rel)) continue;
    const stat = fs.statSync(full);
    if (stat.isDirectory()) {
      if (name === 'shots' && rel.endsWith('verify/shots')) continue;
      walk(full);
    } else {
      files.push({ rel, full, size: stat.size });
    }
  }
})(SRC);

console.log(`source: ${SRC}`);
console.log(`files to upload: ${files.length}`);

/* ------------------------------------------------ one commit for everything */

// 1. Blobs
const blobs = [];
for (const f of files) {
  const created = ghApi('POST', `repos/${repoArg}/git/blobs`, {
    content: b64(f.full),
    encoding: 'base64',
  });
  blobs.push({ path: f.rel, mode: '100644', type: 'blob', sha: created.sha });
  process.stdout.write(`\r  blob ${blobs.length}/${files.length}`);
}
console.log('\nblobs uploaded');

// 2. Tree — built on top of the current branch tip so nothing is lost.
let baseTree = null;
try {
  const ref = ghApi('GET', `repos/${repoArg}/git/ref/heads/${branch}`);
  baseTree = ref.object.sha;
  const baseCommit = ghApi('GET', `repos/${repoArg}/git/commits/${baseTree}`);
  baseTree = baseCommit.tree.sha;
  console.log(`building on top of ${baseTree.slice(0, 7)}`);
} catch {
  console.log('no existing tree, creating a fresh one');
}

const treeBody = { tree: blobs };
if (baseTree) treeBody.base_tree = baseTree;
const tree = ghApi('POST', `repos/${repoArg}/git/trees`, treeBody);
console.log(`tree created: ${tree.sha}`);

// 3. Commit
const commit = ghApi('POST', `repos/${repoArg}/git/commits`, {
  message: 'Essay Reader: offline English essay reader with pinned Chinese meanings',
  tree: tree.sha,
});
console.log(`commit created: ${commit.sha}`);

// 4. Point the branch at the commit
if (seeded) {
  // The seeded commit exists; build on top of it so history stays linear only
  // if possible, otherwise force the branch to the new tree.
  try {
    ghApi('PATCH', `repos/${repoArg}/git/refs/heads/${branch}`, {
      sha: commit.sha,
      force: true,
    });
    console.log(`branch ${branch} updated (replacing the seed commit)`);
  } catch (err) {
    console.error('could not move the branch:', err.message);
    throw err;
  }
} else {
  // Ask whether the branch exists before choosing POST or PATCH. Attempting a
  // POST first and catching the 422 worked, but reported a scary error for a
  // perfectly normal update — the same shape of bug that once hid a missed
  // deploy, so the error path is gone rather than silenced.
  const exists = (() => {
    try {
      ghApi('GET', `repos/${repoArg}/git/ref/heads/${branch}`);
      return true;
    } catch {
      return false;
    }
  })();

  if (exists) {
    ghApi('PATCH', `repos/${repoArg}/git/refs/heads/${branch}`, {
      sha: commit.sha,
      force: true,
    });
    console.log(`branch ${branch} updated`);
  } else {
    ghApi('POST', `repos/${repoArg}/git/refs`, {
      ref: `refs/heads/${branch}`,
      sha: commit.sha,
    });
    console.log(`branch ${branch} created`);
  }
}

// 5. Make sure the branch is the default
try {
  ghApi('PATCH', `repos/${repoArg}`, { default_branch: branch });
} catch {
  /* optional */
}

console.log(`\ndone: https://github.com/${repoArg}/tree/${branch}`);
