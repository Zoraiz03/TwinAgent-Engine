/**
 * Isolated clone of the target. A clean git repo gets a detached `git worktree`
 * (checked out at HEAD). Anything else gets a filtered directory copy (no
 * node_modules, no .git): non-git targets, git repos with uncommitted changes
 * (tracked or untracked, ignoring node_modules) so the clone reflects the real
 * working state, and repos whose worktree cannot be created.
 * `dispose()` always removes the worktree registration and the temp dir, and is
 * safe to call more than once. Removal never follows symlinks, so a symlinked
 * node_modules is unlinked, not deleted.
 */
import { cp, mkdtemp, realpath, rm, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, relative, resolve, sep } from 'node:path';
import { run } from './exec.js';
import { treeHash } from './state.js';

const SKIP = new Set(['node_modules', '.git']);

/**
 * @typedef {object} Clone
 * @property {string} dir  Clone working directory.
 * @property {string} root  Temp parent dir that dispose() removes.
 * @property {'worktree'|'copy'} kind
 * @property {string} source  Resolved original target path.
 * @property {boolean} dirty  Git target had uncommitted changes (copy used instead of a worktree).
 * @property {string|null} stateKey  Cache key for the target state (null if skipStateKey).
 * @property {() => Promise<void>} dispose
 */

/** @param {string} source */
async function isGitToplevel(source, timeoutMs) {
  const r = await run('git', ['rev-parse', '--show-toplevel'], { cwd: source, timeoutMs });
  if (r.code !== 0) return false;
  return (await realpath(r.stdout.trim())) === source;
}

/** Uncommitted changes, ignoring anything under node_modules. */
async function isDirty(source, timeoutMs) {
  const r = await run('git', ['status', '--porcelain', '--untracked-files=all'], { cwd: source, timeoutMs });
  if (r.code !== 0) return false;
  return r.stdout
    .split('\n')
    .filter(Boolean)
    .some((line) => !line.slice(3).split('/').includes('node_modules'));
}

/** HEAD for clean git, HEAD + tree hash for dirty git, tree hash otherwise. */
async function computeStateKey(source, isGit, timeoutMs) {
  const head = isGit ? await run('git', ['rev-parse', 'HEAD'], { cwd: source, timeoutMs }) : null;
  const sha = head?.code === 0 ? head.stdout.trim() : null;
  if (sha && !(await isDirty(source, timeoutMs))) return `git:${sha}`;
  return `${sha ? `git:${sha}+` : ''}tree:${await treeHash(source)}`;
}

/**
 * @param {string} target
 * @param {{tmpRoot?: string, gitTimeoutMs?: number, skipStateKey?: boolean}} [opts]
 * @returns {Promise<Clone>}
 */
export async function createClone(target, { tmpRoot = tmpdir(), gitTimeoutMs = 60_000, skipStateKey = false } = {}) {
  const source = await realpath(resolve(target));
  if (!(await stat(source)).isDirectory()) throw new Error(`Target is not a directory: ${source}`);

  const root = await mkdtemp(join(tmpRoot, 'twinagent-'));
  const dir = join(root, 'ws');
  /** @type {'worktree'|'copy'} */
  let kind = 'copy';
  let disposed = false;
  let dirty = false;
  /** @type {string|null} */
  let stateKey = null;

  const dispose = async () => {
    if (disposed) return;
    disposed = true;
    if (kind === 'worktree') {
      await run('git', ['worktree', 'remove', '--force', dir], { cwd: source, timeoutMs: gitTimeoutMs });
    }
    await rm(root, { recursive: true, force: true });
    if (kind === 'worktree') await run('git', ['worktree', 'prune'], { cwd: source, timeoutMs: gitTimeoutMs });
  };

  try {
    const isGit = await isGitToplevel(source, gitTimeoutMs);
    if (isGit) dirty = await isDirty(source, gitTimeoutMs);
    if (isGit && !dirty) {
      const r = await run('git', ['worktree', 'add', '--detach', dir, 'HEAD'], { cwd: source, timeoutMs: gitTimeoutMs });
      if (r.code === 0) kind = 'worktree';
      else {
        await rm(dir, { recursive: true, force: true });
        await run('git', ['worktree', 'prune'], { cwd: source, timeoutMs: gitTimeoutMs });
      }
    }
    if (kind === 'copy') {
      await cp(source, dir, {
        recursive: true,
        filter: (src) => !relative(source, src).split(sep).some((seg) => SKIP.has(seg)),
      });
    }
    if (!skipStateKey) stateKey = await computeStateKey(source, isGit, gitTimeoutMs);
  } catch (err) {
    await dispose();
    throw err;
  }
  return { dir, root, kind, source, dirty, stateKey, dispose };
}

/**
 * State key of a target without cloning it (same key the baselines and twin
 * cache use): HEAD for a clean git repo, HEAD + tree hash if dirty, tree hash otherwise.
 * @param {string} target
 */
export async function targetStateKey(target, { gitTimeoutMs = 60_000 } = {}) {
  const source = await realpath(resolve(target));
  return computeStateKey(source, await isGitToplevel(source, gitTimeoutMs), gitTimeoutMs);
}
