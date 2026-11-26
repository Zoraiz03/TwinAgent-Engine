/**
 * Twin cache: one T per target state key per process (same key as the psi1 /
 * psi3 baselines), optionally persisted to disk (config twin.persistPath).
 * Cached twins are shared: treat them as read-only and fork with clone().
 */
import { createHash } from 'node:crypto';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { Twin } from './twin.js';

const mem = new Map();

export const clearTwinCache = () => mem.clear();

/**
 * @param {{stateKey: string|null, dir: string, adapter: any, config: any}} opts
 * @returns {Promise<{twin: Twin, source: 'memory'|'disk'|'built'}>}
 */
export function loadTwin({ stateKey, dir, adapter, config }) {
  const build = async () => {
    const persist = config?.twin?.persistPath;
    const file = persist && stateKey ? join(persist, `${createHash('sha256').update(stateKey).digest('hex').slice(0, 24)}.json`) : null;
    if (file) {
      const json = await readFile(file, 'utf8').then(JSON.parse, () => null);
      if (json) return { twin: Twin.fromJSON(json), source: 'disk' };
    }
    const twin = await Twin.build(dir, adapter, config);
    if (file) {
      await mkdir(persist, { recursive: true });
      await writeFile(file, JSON.stringify(twin.toJSON()));
    }
    return { twin, source: 'built' };
  };
  if (!stateKey) return build();
  if (!mem.has(stateKey)) {
    const p = build();
    mem.set(stateKey, p.catch((err) => { mem.delete(stateKey); throw err; }));
    return p;
  }
  return mem.get(stateKey).then((r) => ({ twin: r.twin, source: 'memory' }));
}
