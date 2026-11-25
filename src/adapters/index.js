/**
 * Target-project adapters. An adapter teaches the engine how to handle one kind
 * of target (Node/npm today). Adapters only ever operate on the isolated clone
 * directory; the single read of the original target is `detect` and the
 * node_modules symlink source in `prepare`.
 *
 * Contract (see TargetAdapter):
 *   detect(targetPath)        -> boolean   sync; does this adapter handle the target?
 *   prepare(cloneDir, ctx)    -> Promise<PrepareResult>
 *                                installs/links dependencies inside the clone.
 *                                ctx = { targetPath, touchesManifest, installTimeoutMs }.
 *                                Must not throw for an install failure: return ok:false.
 *   testCommand(cloneDir)     -> { cmd, args, cwd, framework? } | null   sync; null = no tests
 *   manifestFiles()           -> string[]  dependency manifest/lockfile basenames; a diff
 *                                touching any of them forces a real install.
 */
import { nodeNpmAdapter } from './node-npm.js';

/**
 * @typedef {object} PrepareResult
 * @property {'symlink'|'npm-ci'|'npm-install'|'none'} strategy
 * @property {boolean} ok
 * @property {number} durationMs
 * @property {string} [error]
 */

/**
 * @typedef {object} PrepareContext
 * @property {string} targetPath  Original target (read-only; symlink source).
 * @property {boolean} touchesManifest  The applied diff changed a manifest file.
 * @property {number} installTimeoutMs
 */

/**
 * @typedef {object} TargetAdapter
 * @property {string} name
 * @property {(targetPath: string) => boolean} detect
 * @property {(cloneDir: string, ctx: PrepareContext) => Promise<PrepareResult>} prepare
 * @property {(cloneDir: string) => ({cmd: string, args: string[], cwd: string, framework?: string|null})|null} testCommand
 * @property {() => string[]} manifestFiles
 */

/** Registry, checked in order by pickAdapter. */
export const adapters = [nodeNpmAdapter];

/**
 * Pick the first adapter whose detect() accepts the target.
 * @param {string} targetPath
 * @returns {TargetAdapter}
 */
export function pickAdapter(targetPath) {
  const found = adapters.find((a) => a.detect(targetPath));
  if (!found) throw new Error(`No adapter supports target: ${targetPath}`);
  return found;
}

/** @param {string} name @returns {TargetAdapter} */
export function getAdapter(name) {
  const found = adapters.find((a) => a.name === name);
  if (!found) throw new Error(`Unknown adapter: ${name}`);
  return found;
}
