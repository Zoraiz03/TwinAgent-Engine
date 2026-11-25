import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { rmSync } from 'node:fs';
import { cp, lstat, mkdir, mkdtemp, readdir, readFile, readlink, realpath, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

export const FIXTURE = new URL('./fixtures/sample-app', import.meta.url).pathname;

/** Fresh private temp dir (used as tmpRoot so leftover checks cannot race other tests). */
const made = [];
process.on('exit', () => made.forEach((d) => rmSync(d, { recursive: true, force: true })));
export async function tmpBase() {
  const d = await realpath(await mkdtemp(join(tmpdir(), 'twin-test-')));
  made.push(d);
  return d;
}

/**
 * Copy the fixture into a temp dir. Options: git (init + commit), nodeModules (fake dep).
 * @returns {Promise<string>} target path
 */
export async function makeTarget({ git = false, nodeModules = false } = {}) {
  const dir = join(await tmpBase(), 'target');
  await cp(FIXTURE, dir, { recursive: true });
  if (nodeModules) {
    await mkdir(join(dir, 'node_modules/dep'), { recursive: true });
    await writeFile(join(dir, 'node_modules/dep/index.js'), 'export default 1;\n');
  }
  if (git) {
    await writeFile(join(dir, '.gitignore'), 'node_modules\n');
    const g = (...a) => execFileSync('git', ['-c', 'user.name=t', '-c', 'user.email=t@t', ...a], { cwd: dir, stdio: 'pipe' });
    g('init', '-q');
    g('add', '-A');
    g('commit', '-qm', 'init');
  }
  return dir;
}

/** sha256 over every path, file content and symlink target in a tree (skips .git). */
export async function hashTree(dir) {
  const h = createHash('sha256');
  async function walk(d, rel) {
    for (const name of (await readdir(d)).sort()) {
      if (name === '.git') continue;
      const p = join(d, name);
      const r = `${rel}/${name}`;
      const st = await lstat(p);
      if (st.isSymbolicLink()) h.update(`L ${r} ${await readlink(p)}\n`);
      else if (st.isDirectory()) { h.update(`D ${r}\n`); await walk(p, r); }
      else h.update(`F ${r} ${st.mode} `).update(await readFile(p)).update('\n');
    }
  }
  await walk(dir, '');
  return h.digest('hex');
}

export const listDir = (d) => readdir(d);

/** `git worktree list --porcelain` entries for a repo. */
export function worktrees(repo) {
  return execFileSync('git', ['worktree', 'list', '--porcelain'], { cwd: repo, encoding: 'utf8' })
    .split('\n').filter((l) => l.startsWith('worktree '));
}

// ---- diffs against test/fixtures/sample-app ----
export const CLEAN_DIFF = `diff --git a/src/math.js b/src/math.js
--- a/src/math.js
+++ b/src/math.js
@@ -1,3 +1,3 @@
 export function add(a, b) {
-  return a + b;
+  return Number(a) + Number(b);
 }
`;

export const STALE_DIFF = `diff --git a/src/math.js b/src/math.js
--- a/src/math.js
+++ b/src/math.js
@@ -1,3 +1,3 @@
 export function add(a, b) {
-  return a - b;
+  return a * b;
 }
`;

export const MANIFEST_DIFF = `diff --git a/package.json b/package.json
--- a/package.json
+++ b/package.json
@@ -1,5 +1,6 @@
 {
   "name": "sample-app",
   "version": "1.0.0",
+  "description": "sample",
   "type": "module",
   "scripts": {
`;

const newFile = (path) => `diff --git a/${path} b/${path}
new file mode 100644
--- /dev/null
+++ b/${path}
@@ -0,0 +1 @@
+pwned
`;
export const TRAVERSAL_DIFF = newFile('../evil.txt');
export const GIT_DIFF = newFile('.git/hooks/post-checkout');
export const ABSOLUTE_DIFF = `--- /etc/hosts
+++ /etc/hosts
@@ -1 +1 @@
-a
+b
`;
