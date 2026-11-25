/**
 * Target-project adapters: encapsulate how to clone, install, test and scan a
 * target codebase. All adapters operate on an isolated temp copy (a
 * "workspace"); they must never touch the original target path.
 */
import { cp, mkdtemp, rm, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

/**
 * @typedef {object} Workspace
 * @property {string} path  Absolute path of the isolated copy.
 * @property {string} source  Original target path (read-only, never written).
 * @property {() => Promise<void>} dispose  Remove the temp copy.
 */

/**
 * @typedef {object} Adapter
 * @property {string} name
 * @property {(target: string) => Promise<Workspace>} clone
 * @property {(ws: Workspace) => Promise<{ok: boolean}>} install
 * @property {(ws: Workspace) => Promise<{ok: boolean, passed: number, failed: number}>} test
 * @property {(ws: Workspace) => Promise<{findings: string[]}>} scan
 */

/**
 * Copy `target` into a fresh temp directory (skips node_modules).
 * @param {string} target
 * @returns {Promise<Workspace>}
 */
export async function cloneToTemp(target) {
  const source = resolve(target);
  if (!(await stat(source)).isDirectory()) throw new Error(`Target is not a directory: ${source}`);
  const root = await mkdtemp(join(tmpdir(), 'twinagent-'));
  const path = join(root, 'ws');
  await cp(source, path, {
    recursive: true,
    filter: (src) => !src.split('/').includes('node_modules'),
  });
  return { path, source, dispose: () => rm(root, { recursive: true, force: true }) };
}

/** Stub adapter for Node.js/Jest targets. Install/test/scan return fake results. */
/** @type {Adapter} */
export const nodeAdapter = {
  name: 'node',
  clone: cloneToTemp,
  async install() { return { ok: true }; },
  async test() { return { ok: true, passed: 0, failed: 0 }; },
  async scan() { return { findings: [] }; },
};

/** @returns {Adapter} */
export function getAdapter(name = 'node') {
  if (name !== 'node') throw new Error(`Unknown adapter: ${name}`);
  return nodeAdapter;
}
