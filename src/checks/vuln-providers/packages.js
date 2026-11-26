/**
 * Installed-package discovery shared by vuln providers: reads package-lock.json
 * (v1 and v2/v3) and falls back to exact versions declared in package.json.
 */
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';

const readJson = (p) => readFile(p, 'utf8').then(JSON.parse, () => null);

/**
 * @param {string} dir
 * @returns {Promise<Map<string, Set<string>>>} package name -> versions
 */
export async function installedPackages(dir) {
  const out = new Map();
  const add = (name, version) => {
    if (!name || !/^\d/.test(version ?? '')) return;
    if (!out.has(name)) out.set(name, new Set());
    out.get(name).add(version);
  };
  const lock = await readJson(join(dir, 'package-lock.json'));
  const packages = lock?.packages ?? {};
  for (const [path, info] of Object.entries(packages)) {
    if (!path.includes('node_modules/')) continue;
    // linked (file:/workspace) deps carry their version on the link target entry
    const version = info.link ? packages[info.resolved]?.version : info.version;
    add(path.split('node_modules/').pop(), version);
  }
  const walkV1 = (deps) => {
    for (const [name, info] of Object.entries(deps ?? {})) { add(name, info.version); walkV1(info.dependencies); }
  };
  walkV1(lock?.dependencies);
  const pkg = await readJson(join(dir, 'package.json'));
  for (const field of ['dependencies', 'devDependencies', 'optionalDependencies']) {
    for (const [name, spec] of Object.entries(pkg?.[field] ?? {})) add(name, String(spec).replace(/^[\^~=v]+/, ''));
  }
  return out;
}
