/**
 * Isolated clone of the target. Git repos get a detached `git worktree`
 * (checked out at HEAD); anything else, or a git repo whose worktree cannot be
 * created, gets a filtered directory copy (no node_modules, no .git).
 * `dispose()` always removes the worktree registration and the temp dir, and is
 * safe to call more than once. Removal never follows symlinks, so a symlinked
 * node_modules is unlinked, not deleted.
 */
import { cp, mkdtemp, realpath, rm, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, relative, resolve, sep } from 'node:path';
import { run } from './exec.js';

const SKIP = new Set(['node_modules', '.git']);

/**
 * @typedef {object} Clone
 * @property {string} dir  Clone working directory.
 * @property {string} root  Temp parent dir that dispose() removes.
 * @property {'worktree'|'copy'} kind
 * @property {string} source  Resolved original target path.
 * @property {() => Promise<void>} dispose
 */

/** @param {string} source */
async function isGitToplevel(source, timeoutMs) {
  const r = await run('git', ['rev-parse', '--show-toplevel'], { cwd: source, timeoutMs });
  if (r.code !== 0) return false;
  return (await realpath(r.stdout.trim())) === source;
}

/**
 * @param {string} target
 * @param {{tmpRoot?: string, gitTimeoutMs?: number}} [opts]
 * @returns {Promise<Clone>}
 */
export async function createClone(target, { tmpRoot = tmpdir(), gitTimeoutMs = 60_000 } = {}) {
  const source = await realpath(resolve(target));
  if (!(await stat(source)).isDirectory()) throw new Error(`Target is not a directory: ${source}`);

  const root = await mkdtemp(join(tmpRoot, 'twinagent-'));
  const dir = join(root, 'ws');
  /** @type {'worktree'|'copy'} */
  let kind = 'copy';
  let disposed = false;

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
    if (await isGitToplevel(source, gitTimeoutMs)) {
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
  } catch (err) {
    await dispose();
    throw err;
  }
  return { dir, root, kind, source, dispose };
}
