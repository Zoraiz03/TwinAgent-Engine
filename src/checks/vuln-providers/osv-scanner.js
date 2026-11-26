/**
 * "osv-scanner" provider: runs the osv-scanner binary against package-lock.json.
 * Tries the v2 CLI (`scan source`) first, then the v1 flag form. NOTE: written
 * against the documented JSON output; not exercised against a real binary in
 * this repo's tests.
 */
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { run } from '../../engine/exec.js';
import { ProviderUnavailableError } from './errors.js';

const CVSS = (score) => (score >= 9 ? 'critical' : score >= 7 ? 'high' : score >= 4 ? 'moderate' : 'low');
const LABEL = { CRITICAL: 'critical', HIGH: 'high', MODERATE: 'moderate', MEDIUM: 'moderate', LOW: 'low' };

export const osvScannerProvider = {
  name: 'osv-scanner',
  async scan(dir, { env, timeoutMs, config }) {
    const bin = config?.security?.osvScannerPath ?? 'osv-scanner';
    const lock = join(dir, 'package-lock.json');
    if (!existsSync(lock)) throw new ProviderUnavailableError('no package-lock.json for osv-scanner');
    let r = await run(bin, ['scan', 'source', '--format', 'json', '--lockfile', lock], { cwd: dir, env, timeoutMs });
    if (r.code === null) throw new ProviderUnavailableError(`${bin} not found or not runnable`);
    if (!r.stdout.trim().startsWith('{')) {
      r = await run(bin, ['--format', 'json', `--lockfile=${lock}`], { cwd: dir, env, timeoutMs });
    }
    let json;
    try {
      json = JSON.parse(r.stdout);
    } catch {
      throw new ProviderUnavailableError(`osv-scanner gave no JSON: ${r.stderr.trim().slice(-200)}`);
    }
    const out = [];
    for (const res of json.results ?? []) {
      for (const p of res.packages ?? []) {
        const maxScore = Math.max(0, ...(p.groups ?? []).map((g) => Number(g.max_severity) || 0));
        for (const v of p.vulnerabilities ?? []) {
          const label = LABEL[String(v.database_specific?.severity ?? '').toUpperCase()];
          out.push({
            advisoryId: v.id, package: p.package.name, version: p.package.version,
            severity: label ?? CVSS(maxScore), title: v.summary ?? '',
          });
        }
      }
    }
    return out;
  },
};
