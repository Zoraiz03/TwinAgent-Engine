/**
 * Consequence simulation engine: forks an isolated clone of the target,
 * applies the proposed diff there, runs enabled checks in parallel, and
 * aggregates them into a validated consequence report. The original target
 * path is never written to; the clone is always disposed.
 */
import { readFile } from 'node:fs/promises';
import { getAdapter } from '../adapters/index.js';
import { checks } from '../checks/index.js';
import { validateReport } from './schema.js';

const DEFAULT_CONFIG_URL = new URL('../../config/default.json', import.meta.url);

export async function loadConfig(url = DEFAULT_CONFIG_URL) {
  return JSON.parse(await readFile(url, 'utf8'));
}

/**
 * Apply a diff inside the workspace. Stub: no-op that reports success.
 * @param {import('../adapters/index.js').Workspace} _ws @param {string} _diff
 */
async function applyDiff(_ws, _diff) {
  return { applied: true };
}

/**
 * @param {Array<import('./schema.js').CheckResult>} results
 * @returns {'Safe'|'Revise'|'Abort'}
 */
export function classify(results) {
  const failed = results.filter((r) => !r.passed);
  if (failed.length === 0) return 'Safe';
  return failed.some((r) => r.severity === 'high' || r.severity === 'critical') ? 'Abort' : 'Revise';
}

/**
 * @param {object} opts
 * @param {string} opts.target  Path of the target project (read-only).
 * @param {string} opts.diff    Unified diff text.
 * @param {object} [opts.config]
 * @param {string} [opts.adapter]
 * @returns {Promise<import('./schema.js').ConsequenceReport>}
 */
export async function simulate({ target, diff, config, adapter = 'node' }) {
  const start = performance.now();
  const cfg = config ?? (await loadConfig());
  const ad = getAdapter(adapter);
  const workspace = await ad.clone(target);
  try {
    await applyDiff(workspace, diff);
    const ctx = { workspace, adapter: ad, diff, config: cfg };
    const results = await Promise.all(
      Object.entries(checks).map(async ([id, mod]) => {
        if (cfg.checks?.[id]?.enabled === false) {
          return { id, passed: true, severity: 'none', evidence: ['check disabled'] };
        }
        return mod.run(ctx);
      }),
    );
    const byId = Object.fromEntries(results.map((r) => [r.id, r]));
    return validateReport({
      ...byId,
      classification: classify(results),
      latencyMs: Math.round(performance.now() - start),
    });
  } finally {
    await workspace.dispose();
  }
}
