/**
 * Baseline support shared by psi1 and psi3: a cache keyed by target state, and
 * a throwaway clone of the *unmodified* target to measure baselines in. The
 * original target is never mutated; baseline clones are disposed on exit.
 */
import { mkdir } from 'node:fs/promises';
import { join } from 'node:path';
import { createClone } from '../engine/clone.js';
import { scrubbedEnv } from '../engine/env.js';

const cache = new Map();

/**
 * Memoize an async computation (including in-flight ones). Failures are not cached.
 * @template T @param {string} key @param {() => Promise<T>} fn @returns {Promise<T>}
 */
export function cached(key, fn) {
  if (!cache.has(key)) {
    const p = fn().catch((err) => { cache.delete(key); throw err; });
    cache.set(key, p);
  }
  return cache.get(key);
}

export const dropCached = (key) => cache.delete(key);
export const clearBaselineCache = () => cache.clear();

/**
 * Run `fn` inside a fresh clone of the unmodified target, prepared the same way
 * as a no-manifest-change simulation (node_modules symlinked).
 * @template T
 * @param {{targetPath: string, tmpRoot?: string, adapter: any, config: any}} ctx
 * @param {(b: {dir: string, env: Record<string, string>, roots: string[]}) => Promise<T>} fn
 */
export async function withBaselineClone(ctx, fn) {
  const clone = await createClone(ctx.targetPath, { tmpRoot: ctx.tmpRoot, skipStateKey: true });
  try {
    const home = join(clone.root, 'home');
    await mkdir(home);
    const env = scrubbedEnv({ home, allow: ctx.config?.env?.allow });
    await ctx.adapter.prepare(clone.dir, {
      targetPath: clone.source,
      touchesManifest: false,
      installTimeoutMs: ctx.config?.install?.timeoutMs ?? 300_000,
      ignoreScripts: true,
      env,
    });
    return await fn({ dir: clone.dir, env, roots: [clone.dir, clone.source] });
  } finally {
    await clone.dispose();
  }
}
