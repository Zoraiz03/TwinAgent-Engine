/**
 * Static pre-execution engine: the "static" baseline mode of the loop.
 * Same report shape as the consequence engine, but only static checks on a
 * clone, with no test execution, no dependency install and no twin:
 *   - the diff applies (rejected -> Abort, failed -> Revise, as in the engine);
 *   - syntax: every changed JS file parses (acorn, as `node --check` would);
 *   - import lint: unresolved relative imports and imports of undeclared
 *     packages in changed files, new vs the pre-diff tree (what ESLint's
 *     import/no-unresolved + no-extraneous-dependencies report);
 *   - the target's own ESLint, if configured and installed (new errors vs baseline);
 *   - the Semgrep part of psi2 (same rules and fingerprints as twinagent mode).
 * Mapping: Semgrep -> psi2; syntax / import lint / ESLint -> psi3; psi1 and
 * psi4 are reported as not run (passed, inconclusive).
 */
import { existsSync } from 'node:fs';
import { mkdir, readFile, readdir, realpath, symlink } from 'node:fs/promises';
import { join } from 'node:path';
import { pickAdapter, getAdapter } from '../adapters/index.js';
import { withBaselineClone } from '../checks/baseline.js';
import { semgrepPart } from '../checks/psi2-security.js';
import { buildResult } from '../checks/result.js';
import { buildGraph, isSource, parseWithAcorn } from '../twin/parse.js';
import { applyDiff } from './apply.js';
import { createClone } from './clone.js';
import { scrubbedEnv } from './env.js';
import { run } from './exec.js';
import { classify, loadConfig, mergeConfig } from './index.js';
import { validateReport } from './schema.js';

const ms = (t) => Math.round(performance.now() - t);
const JS = /\.[cm]?jsx?$/;
const notRun = (id, why) => ({ id, passed: true, severity: 'none', inconclusive: true, evidence: [{ kind: 'not-run', detail: why, files: [] }] });

async function eslintConfigured(dir) {
  const names = await readdir(dir).catch(() => []);
  return names.some((n) => /^eslint\.config\.[cm]?[jt]s$|^\.eslintrc(\..+)?$/.test(n)) && existsSync(join(dir, 'node_modules', '.bin', 'eslint'));
}

async function eslintMessages(dir, files, env) {
  if (!files.length) return new Map();
  const r = await run(join(dir, 'node_modules', '.bin', 'eslint'), ['--format', 'json', ...files], { cwd: dir, env, timeoutMs: 120_000 });
  const out = new Map();
  let json;
  try { json = JSON.parse(r.stdout); } catch { return out; }
  for (const f of json) {
    for (const m of f.messages ?? []) {
      if (m.severity !== 2) continue;
      const file = f.filePath.slice(dir.length + 1);
      const key = `${file}|${m.ruleId}|${m.message}`;
      out.set(key, { file, ruleId: m.ruleId, message: m.message, count: (out.get(key)?.count ?? 0) + 1 });
    }
  }
  return out;
}

/**
 * @param {{target: string, diff: string, config?: object, tmpRoot?: string, adapter?: any}} opts
 * @returns {Promise<{report: any, twin: null, twinPrime: null}>}
 */
export async function simulateStatic({ target, diff, config, tmpRoot, adapter }) {
  const start = performance.now();
  const cfg = mergeConfig(await loadConfig(), config);
  const ad = typeof adapter === 'object' ? adapter : adapter ? getAdapter(adapter) : pickAdapter(target);
  const timings = { cloneMs: 0, installMs: 0, applyMs: 0, twinBuildMs: 0, twinSyncMs: 0, checks: {} };
  let t = performance.now();
  const clone = await createClone(target, { tmpRoot });
  timings.cloneMs = ms(t);
  try {
    const baseGraph = await buildGraph(clone.dir); // pre-diff tree, for import-lint non-regression
    t = performance.now();
    const applyResult = await applyDiff(clone.dir, clone.kind, diff, { manifestFiles: ad.manifestFiles() });
    timings.applyMs = ms(t);
    const base = { applyResult, cloneKind: clone.kind, dirtyTarget: clone.dirty, twinMode: 'plain', timings };
    if (!applyResult.applied) {
      return { report: validateReport({ ...base, classification: applyResult.rejected ? 'Abort' : 'Revise', latencyMs: ms(start) }), twin: null, twinPrime: null };
    }
    const home = join(clone.root, 'home');
    await mkdir(home);
    const env = scrubbedEnv({ home, allow: cfg.env?.allow });
    const changed = applyResult.filesChanged.filter((f) => existsSync(join(clone.dir, f)));

    // psi3 (static): syntax, import lint, ESLint
    t = performance.now();
    const evidence3 = [];
    for (const f of changed.filter((x) => JS.test(x))) {
      try {
        parseWithAcorn(await readFile(join(clone.dir, f), 'utf8'));
      } catch (err) {
        evidence3.push({ kind: 'syntax-error', detail: `${f}: ${err.message}`, files: [f], severity: 'high' });
      }
    }
    const after = await buildGraph(clone.dir);
    const changedSet = new Set(changed);
    const baseUnres = new Set(baseGraph.unresolved.map((u) => `${u.file}|${u.specifier}`));
    const baseUndecl = new Set(baseGraph.undeclared.map((u) => `${u.file}|${u.pkg}`));
    for (const u of after.unresolved) {
      if (changedSet.has(u.file) && !baseUnres.has(`${u.file}|${u.specifier}`)) evidence3.push({ kind: 'lint-unresolved-import', detail: `${u.file} imports missing file "${u.specifier}"`, files: [u.file], severity: 'medium' });
    }
    for (const u of after.undeclared) {
      if (changedSet.has(u.file) && !baseUndecl.has(`${u.file}|${u.pkg}`)) evidence3.push({ kind: 'lint-undeclared-package', detail: `${u.file} imports undeclared package "${u.pkg}"`, files: [u.file], severity: 'high' });
    }
    if (await eslintConfigured(clone.source)) {
      if (!existsSync(join(clone.dir, 'node_modules'))) await symlink(await realpath(join(clone.source, 'node_modules')), join(clone.dir, 'node_modules'), 'dir');
      const lintFiles = changed.filter(isSource);
      const [afterLint, baseLint] = await Promise.all([
        eslintMessages(clone.dir, lintFiles, env),
        withBaselineClone({ targetPath: clone.source, tmpRoot, adapter: ad, config: cfg }, ({ dir, env: e }) => eslintMessages(dir, lintFiles.filter((f) => existsSync(join(dir, f))), e)),
      ]);
      for (const [k, m] of afterLint) {
        if (m.count > (baseLint.get(k)?.count ?? 0)) evidence3.push({ kind: 'lint-error', detail: `${m.file}: ${m.message} (${m.ruleId})`, files: [m.file], severity: 'medium' });
      }
    }
    const psi3 = { ...buildResult('psi3', evidence3), durationMs: ms(t) };
    timings.checks.psi3 = psi3.durationMs;

    // psi2 (static): Semgrep only (no dependency advisories: nothing is installed)
    t = performance.now();
    const ctx = { cloneDir: clone.dir, targetPath: clone.source, stateKey: clone.stateKey, tmpRoot, adapter: ad, applyResult, diff, config: cfg, env };
    const sg = await semgrepPart(ctx, cfg.security ?? {});
    const psi2Result = buildResult('psi2', sg.evidence, { tool: { semgrepVersion: sg.version, vulnProvider: null } });
    const psi2 = { ...psi2Result, inconclusive: Boolean(sg.unavailable) && psi2Result.passed, durationMs: ms(t) };
    timings.checks.psi2 = psi2.durationMs;

    const psi1 = notRun('psi1', 'static mode: tests are not executed');
    const psi4 = notRun('psi4', 'static mode: performance is not measured');
    const classification = classify([psi1, psi2, psi3, psi4], { blockingSeverity: cfg.engine?.blockingSeverity ?? 'low' });
    return { report: validateReport({ ...base, psi1, psi2, psi3, psi4, classification, latencyMs: ms(start) }), twin: null, twinPrime: null };
  } finally {
    await clone.dispose();
  }
}
