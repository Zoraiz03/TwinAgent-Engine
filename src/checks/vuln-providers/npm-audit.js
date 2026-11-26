/**
 * "npm-audit" provider: runs `npm audit --json` in the clone. Needs registry
 * access; pass registry/proxy env vars through config env.allow if required.
 */
import { run } from '../../engine/exec.js';
import { ProviderUnavailableError } from './errors.js';
import { installedPackages } from './packages.js';

const ghsa = (url) => /GHSA-[\w-]+/i.exec(url ?? '')?.[0];

export const npmAuditProvider = {
  name: 'npm-audit',
  async scan(dir, { env, timeoutMs }) {
    const r = await run('npm', ['audit', '--json'], { cwd: dir, env, timeoutMs });
    if (r.timedOut) throw new ProviderUnavailableError('npm audit timed out');
    let json;
    try {
      json = JSON.parse(r.stdout);
    } catch {
      throw new ProviderUnavailableError(`npm audit gave no JSON: ${r.stderr.trim().slice(-200)}`);
    }
    if (json.error) throw new ProviderUnavailableError(`npm audit failed: ${json.error.summary ?? json.error.code}`);
    const installed = await installedPackages(dir);
    const seen = new Map();
    for (const vuln of Object.values(json.vulnerabilities ?? {})) {
      for (const via of vuln.via ?? []) {
        if (typeof via !== 'object') continue; // string = transitive pointer to another entry
        const advisoryId = ghsa(via.url) ?? String(via.source);
        const version = [...(installed.get(via.name) ?? [])][0] ?? 'unknown';
        seen.set(`${advisoryId}|${via.name}`, {
          advisoryId, package: via.name, version, severity: via.severity === 'info' ? 'low' : via.severity, title: via.title ?? '',
        });
      }
    }
    return [...seen.values()];
  },
};
