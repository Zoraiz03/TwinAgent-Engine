/**
 * "fixture" provider: a frozen advisory database read from a JSON file
 * (config security.vulnFixture). For tests and offline / reproducible
 * experiments. Format: an array (or { advisories: [...] }) of
 *   { advisoryId, package, severity, title, versions: ["1.0.0", ...] | "*" }
 * An advisory matches when the package is installed (lockfile, else exact
 * version in package.json) at a listed version.
 */
import { readFile } from 'node:fs/promises';
import { ProviderUnavailableError } from './errors.js';
import { installedPackages } from './packages.js';

export const fixtureProvider = {
  name: 'fixture',
  async scan(dir, { config }) {
    const path = config?.security?.vulnFixture;
    if (!path) throw new ProviderUnavailableError('security.vulnFixture is not set');
    let db;
    try {
      db = JSON.parse(await readFile(path, 'utf8'));
    } catch (err) {
      throw new ProviderUnavailableError(`cannot read vuln fixture ${path}: ${err.message}`);
    }
    const installed = await installedPackages(dir);
    const out = [];
    for (const adv of Array.isArray(db) ? db : db.advisories ?? []) {
      for (const version of installed.get(adv.package) ?? []) {
        if (adv.versions === '*' || adv.versions?.includes(version)) {
          out.push({ advisoryId: adv.advisoryId, package: adv.package, version, severity: adv.severity, title: adv.title ?? '' });
        }
      }
    }
    return out;
  },
};
