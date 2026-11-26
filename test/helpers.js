import { execFileSync, spawnSync } from 'node:child_process';
import { dirname } from 'node:path';
import { createHash } from 'node:crypto';
import { rmSync } from 'node:fs';
import { cp, lstat, mkdir, mkdtemp, readdir, readFile, readlink, realpath, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

/** True when a real semgrep binary is on PATH (semgrep-dependent tests skip otherwise). */
export const hasSemgrep = spawnSync('semgrep', ['--version']).status === 0;
export const semgrepVersionOnPath = hasSemgrep ? spawnSync('semgrep', ['--version'], { encoding: 'utf8' }).stdout.trim() : null;

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
/** Regenerate package-lock.json from package.json without network (file: deps only). */
export function relock(dir) {
  execFileSync('npm', ['install', '--package-lock-only', '--ignore-scripts', '--no-audit', '--no-fund', '--offline'], { cwd: dir, stdio: 'pipe' });
}

export async function makeTarget({ git = false, nodeModules = false, files = {}, relock: lock = false } = {}) {
  const dir = join(await tmpBase(), 'target');
  await cp(FIXTURE, dir, { recursive: true });
  await applyFiles(dir, files);
  if (lock) relock(dir);
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

/** Write files (string) or delete them (null) under dir. */
export async function applyFiles(dir, files) {
  for (const [rel, content] of Object.entries(files)) {
    const p = join(dir, rel);
    if (content === null) await rm(p, { force: true });
    else {
      await mkdir(dirname(p), { recursive: true });
      await writeFile(p, content);
    }
  }
}

/**
 * Build a real unified diff: copy the target to scratch, apply `files`
 * (string = write, null = delete), and ask git for the diff (renames are
 * detected, as with `git diff -M`). relock: regenerate package-lock.json.
 */
export async function makeDiff(target, files, { relock: lock = false } = {}) {
  const scratch = join(await tmpBase(), 'scratch');
  await cp(target, scratch, { recursive: true, filter: (s) => !s.split('/').includes('node_modules') && !s.endsWith('/.git') });
  const g = (...a) => execFileSync('git', ['-c', 'user.name=t', '-c', 'user.email=t@t', ...a], { cwd: scratch, encoding: 'utf8', stdio: 'pipe' });
  g('init', '-q');
  g('add', '-A');
  g('commit', '-qm', 'base');
  await applyFiles(scratch, files);
  if (lock) relock(scratch);
  g('add', '-A');
  return g('diff', '--cached', '--no-color');
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

/** Deterministic scripted model for the agent: responses in order (last repeats); records requests. */
export function scripted(responses) {
  const calls = [];
  const generate = async (req) => {
    calls.push(req);
    const r = responses[Math.min(calls.length - 1, responses.length - 1)];
    if (r instanceof Error) throw r;
    return typeof r === 'function' ? r(req, calls.length - 1) : r;
  };
  return { generate, calls };
}
