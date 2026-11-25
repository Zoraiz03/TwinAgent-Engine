/**
 * Consequence simulation engine. Pipeline:
 *   clone (worktree or filtered copy) -> apply diff -> prepare (symlink or real
 *   install, based on whether the diff touched a manifest) -> run checks in
 *   parallel -> aggregate -> dispose.
 * Apply runs before prepare so that a manifest-changing diff is installed from
 * its *new* manifest. The original target is never written to; the clone is
 * disposed in a finally block on success, failure, or thrown error.
 * A diff that fails to apply yields Revise; an unsafe diff yields Abort. In
 * both cases checks are skipped.
 */
import { readFile } from 'node:fs/promises';
import { pickAdapter, getAdapter } from '../adapters/index.js';
import { checks as defaultChecks } from '../checks/index.js';
import { applyDiff } from './apply.js';
import { createClone } from './clone.js';
import { validateReport } from './schema.js';

const DEFAULT_CONFIG_URL = new URL('../../config/default.json', import.meta.url);
const DEFAULT_INSTALL_TIMEOUT_MS = 300_000;

export async function loadConfig(url = DEFAULT_CONFIG_URL) {
  return JSON.parse(await readFile(url, 'utf8'));
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

const ms = (since) => Math.round(performance.now() - since);

/**
 * @param {object} opts
 * @param {string} opts.target  Path of the target project (read-only).
 * @param {string} opts.diff    Unified diff text.
 * @param {object} [opts.config]
 * @param {string|import('../adapters/index.js').TargetAdapter} [opts.adapter]  Name or instance; default: auto-detect.
 * @param {string} [opts.tmpRoot]  Where to create the clone (default: os tmpdir).
 * @param {Record<string, {run: (ctx: any) => Promise<any>}>} [opts.checks]  Check registry override (tests).
 * @returns {Promise<import('./schema.js').ConsequenceReport>}
 */
export async function simulate({ target, diff, config, adapter, tmpRoot, checks = defaultChecks }) {
  const start = performance.now();
  const cfg = config ?? (await loadConfig());
  const ad = typeof adapter === 'object' ? adapter : adapter ? getAdapter(adapter) : pickAdapter(target);
  const timings = { cloneMs: 0, installMs: 0, applyMs: 0, checks: {} };

  let t = performance.now();
  const clone = await createClone(target, { tmpRoot });
  timings.cloneMs = ms(t);
  try {
    t = performance.now();
    const applyResult = await applyDiff(clone.dir, clone.kind, diff, { manifestFiles: ad.manifestFiles() });
    timings.applyMs = ms(t);

    const base = { applyResult, cloneKind: clone.kind, timings };
    if (!applyResult.applied) {
      return validateReport({
        ...base,
        classification: applyResult.rejected ? 'Abort' : 'Revise',
        latencyMs: ms(start),
      });
    }

    const install = await ad.prepare(clone.dir, {
      targetPath: clone.source,
      touchesManifest: applyResult.touchesManifest,
      installTimeoutMs: cfg.install?.timeoutMs ?? DEFAULT_INSTALL_TIMEOUT_MS,
    });
    timings.installMs = install.durationMs;

    const ctx = { cloneDir: clone.dir, adapter: ad, applyResult, install, diff, config: cfg };
    const results = await Promise.all(
      Object.entries(checks).map(async ([id, mod]) => {
        if (cfg.checks?.[id]?.enabled === false) {
          return { id, passed: true, severity: 'none', evidence: ['check disabled'] };
        }
        const s = performance.now();
        const result = await mod.run(ctx);
        timings.checks[id] = ms(s);
        return result;
      }),
    );
    const byId = Object.fromEntries(results.map((r) => [r.id, r]));
    let classification = classify(results);
    if (!install.ok && classification === 'Safe') classification = 'Revise';
    return validateReport({ ...base, ...byId, install, classification, latencyMs: ms(start) });
  } finally {
    await clone.dispose();
  }
}
