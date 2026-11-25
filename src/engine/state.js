/**
 * Target state fingerprints, used as cache keys for baselines. A clean git
 * target is keyed by its HEAD commit; a dirty git target by HEAD plus a hash of
 * the working tree; a non-git target by a hash of its working tree alone.
 * node_modules and .git are excluded from the tree hash.
 */
import { createHash } from 'node:crypto';
import { lstat, readdir, readFile, readlink } from 'node:fs/promises';
import { join } from 'node:path';

const SKIP = new Set(['node_modules', '.git']);

/** @param {string} root @returns {Promise<string>} */
export async function treeHash(root) {
  const h = createHash('sha256');
  async function walk(dir, rel) {
    for (const name of (await readdir(dir)).sort()) {
      if (SKIP.has(name)) continue;
      const p = join(dir, name);
      const r = `${rel}/${name}`;
      const st = await lstat(p);
      if (st.isSymbolicLink()) h.update(`L ${r} ${await readlink(p)}\n`);
      else if (st.isDirectory()) { h.update(`D ${r}\n`); await walk(p, r); }
      else h.update(`F ${r} ${st.mode & 0o111} `).update(await readFile(p)).update('\n');
    }
  }
  await walk(root, '');
  return h.digest('hex');
}
