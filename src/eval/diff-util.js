/**
 * Build real unified diffs from file edits: copy the target to scratch, commit
 * it, apply the edits (string = write, null = delete), optionally regenerate
 * package-lock.json offline, and ask git for the diff (renames detected).
 * Also small helpers to run a target's tests / probes on a scratch copy, used
 * to validate injections by construction.
 */
import { cp, mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join, relative, sep } from 'node:path';
import { run } from '../engine/exec.js';

const GIT = ['-c', 'user.name=t', '-c', 'user.email=t@t', '-c', 'commit.gpgsign=false'];

async function git(cwd, args) {
  const r = await run('git', [...GIT, ...args], { cwd, timeoutMs: 60_000 });
  if (r.code !== 0) throw new Error(`git ${args[0]}: ${r.stderr.trim()}`);
  return r.stdout;
}

/** Copy target (no .git, no node_modules) into a fresh scratch git repo. */
export async function scratchCopy(target, tmpRoot = tmpdir()) {
  const root = await mkdtemp(join(tmpRoot, 'twinagent-scratch-'));
  const dir = join(root, 'w');
  await cp(target, dir, {
    recursive: true,
    filter: (src) => !relative(target, src).split(sep).some((s) => s === '.git' || s === 'node_modules'),
  });
  await git(dir, ['init', '-q']);
  await git(dir, ['add', '-A']);
  await git(dir, ['commit', '-q', '-m', 'base', '--allow-empty']);
  return { dir, dispose: () => rm(root, { recursive: true, force: true }) };
}

export async function applyEdits(dir, edits) {
  for (const [rel, content] of Object.entries(edits)) {
    const p = join(dir, rel);
    if (content === null) await rm(p, { force: true });
    else {
      await mkdir(dirname(p), { recursive: true });
      await writeFile(p, content);
    }
  }
}

export async function relockOffline(dir) {
  const r = await run('npm', ['install', '--package-lock-only', '--ignore-scripts', '--no-audit', '--no-fund', '--offline'], { cwd: dir, timeoutMs: 120_000 });
  if (r.code !== 0) throw new Error(`offline relock failed: ${r.stderr.trim().slice(-300)}`);
}

/** Diff of `edits` against `target`'s working tree. */
export async function diffFromEdits(target, edits, { relock = false, tmpRoot } = {}) {
  const s = await scratchCopy(target, tmpRoot);
  try {
    await applyEdits(s.dir, edits);
    if (relock) await relockOffline(s.dir);
    await git(s.dir, ['add', '-A']);
    return await git(s.dir, ['diff', '--cached', '--no-color', '-M']);
  } finally {
    await s.dispose();
  }
}
