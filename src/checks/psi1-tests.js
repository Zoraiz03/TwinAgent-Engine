/**
 * psi1 (tests): test suite integrity. Property: no test that passed at
 * baseline fails, goes missing, or times out after the diff.
 *
 * The same scope (config tests.scope: "related" | "full") and changed-file list
 * is run on the unmodified target (a throwaway clone, cached per target state)
 * and on the diff-applied clone. Pre-existing failures are not charged; new
 * tests that fail are reported but do not fail psi1 on their own. If no tests
 * exist for the scope the result is passed + inconclusive.
 * In twin mode, runners without a native related mode (node:test, plain npm
 * test) run only the tests the twin says are affected (see selectTests).
 * Severity: regression in a test file that directly imports a changed module =
 * high, other regressions = medium, timeout = high.
 *
 * Closing the "just disable the test" loophole:
 *   - a test that passed at baseline and is skipped/todo after is a regression
 *     (kind "test-skipped", medium) unless tests.skipIsRegression is false;
 *     tests already skipped at baseline are not charged.
 *   - test-tampering detection reads the diff itself (added .skip/xit/todo
 *     markers and deleted test files: high; fewer test cases or assertions:
 *     tests.assertionDropSeverity, default medium) and fails psi1 even if the
 *     remaining tests pass. Disable with
 *     tests.tamperingDetection = false.
 */
import { cached, dropCached, withBaselineClone } from './baseline.js';
import { detectTampering } from './diff-scan.js';
import { fileImports } from '../twin/parse.js';
import { buildResult } from './result.js';

const DEFAULT_TIMEOUT_MS = 120_000;

function baselineRun(ctx, files, testFiles, timeoutMs, scope) {
  const list = (xs) => (xs ? [...xs].sort().join(',') : '*');
  const key = `psi1|${ctx.stateKey}|${scope}|${list(files)}|${list(testFiles)}`;
  const p = cached(key, () =>
    withBaselineClone(ctx, ({ dir, env }) => ctx.adapter.runTests(dir, { files, testFiles, timeoutMs, env })),
  );
  // a timed-out baseline is not a trustworthy reference: do not keep it
  p.then((r) => { if (r.timedOut) dropCached(key); }, () => {});
  return p;
}

/**
 * Test selection. Returns { testFiles, testSelection }:
 *   "related": the runner's native related mode (jest/vitest), or twin
 *     selection (tests whose import closure in T or T' contains a changed file);
 *   "full-fallback": twin found no affected tests but the target has tests, so
 *     the full suite runs (conservative; tests.noAffectedFallback = "full");
 *   "full": scope "full", plain mode on a runner without a related mode, or a
 *     diff touching non-code files (manifests, config, data) whose impact
 *     imports cannot bound.
 * Inconclusive is only possible when the target truly has no tests, or when
 * tests.noAffectedFallback = "inconclusive".
 */
function selectTests(ctx, scope, changed) {
  const { twin, twinPrime } = ctx;
  if (scope !== 'related') return { testFiles: undefined, testSelection: 'full' };
  if (ctx.adapter.supportsRelated?.(ctx.cloneDir)) return { testFiles: undefined, testSelection: 'related' };
  if (!twin || !twinPrime) return { testFiles: undefined, testSelection: 'full' };
  if (ctx.applyResult.touchesManifest || !changed.every((f) => twin.specs.has(f) || twinPrime.specs.has(f))) {
    return { testFiles: undefined, testSelection: 'full' };
  }
  const affected = [...new Set([...twin.testsAffectedBy(changed), ...twinPrime.testsAffectedBy(changed)])].sort();
  if (affected.length) return { testFiles: affected, testSelection: 'related' };
  const hasTests = [twin, twinPrime].some((t) => [...t.nodes.values()].some((n) => n.kind === 'test'));
  if (!hasTests || ctx.config?.tests?.noAffectedFallback === 'inconclusive') return { testFiles: [], testSelection: 'related' };
  return { testFiles: undefined, testSelection: 'full-fallback' };
}

/**
 * @param {import('./index.js').CheckContext} ctx
 * @returns {Promise<import('../engine/schema.js').CheckResult>}
 */
export async function run(ctx) {
  const start = performance.now();
  const tampering = ctx.config?.tests?.tamperingDetection === false
    ? []
    : detectTampering(ctx.diff ?? '', { assertionDropSeverity: ctx.config?.tests?.assertionDropSeverity ?? 'medium' });
  const skipIsRegression = ctx.config?.tests?.skipIsRegression !== false;
  const done = (evidence, { inconclusive = false } = {}) => {
    const result = buildResult('psi1', [...tampering, ...evidence], { durationMs: Math.round(performance.now() - start) });
    return { ...result, inconclusive: inconclusive && result.passed };
  };

  const scope = ctx.config?.tests?.scope ?? 'related';
  const timeoutMs = ctx.config?.tests?.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const changed = ctx.applyResult.filesChanged;
  const files = scope === 'related' ? changed : undefined;
  const { testFiles, testSelection } = selectTests(ctx, scope, changed);

  const baseline = await baselineRun(ctx, files, testFiles, timeoutMs, scope);
  if (baseline.timedOut) {
    return done(
      [{ kind: 'baseline-unavailable', detail: `baseline test run timed out after ${timeoutMs}ms`, files: [] }],
      { inconclusive: true },
    );
  }
  const after = await ctx.adapter.runTests(ctx.cloneDir, { files, testFiles, timeoutMs, env: ctx.env });

  if (baseline.tests.length === 0 && after.tests.length === 0) {
    const detail = testFiles ? 'no tests are affected by the changed files (twin selection)' : `no tests found for scope "${scope}"`;
    return done([{ kind: 'no-tests-found', detail, files: [], data: { testSelection } }], { inconclusive: true });
  }

  const afterById = new Map(after.tests.map((t) => [t.id, t]));
  const baselineIds = new Set(baseline.tests.map((t) => t.id));
  const changedSet = new Set(changed);
  const directCache = new Map();
  const isDirect = async (file) => {
    if (!directCache.has(file)) {
      const imports = await fileImports(ctx.cloneDir, file);
      directCache.set(file, [...imports].some((f) => changedSet.has(f)) || changedSet.has(file));
    }
    return directCache.get(file);
  };

  const evidence = [];
  const regressions = [];
  for (const t of baseline.tests) {
    if (t.status !== 'pass') continue; // pre-existing failures / skips are not charged
    const now = afterById.get(t.id);
    if (now?.status === 'pass') continue;
    if (now?.status === 'skip') {
      if (!skipIsRegression) continue;
      regressions.push({ id: t.id, file: t.file, reason: 'skipped', severity: 'medium' });
      evidence.push({ kind: 'test-skipped', detail: `${t.id} is skipped (passed at baseline)`, files: [t.file], severity: 'medium', data: { id: t.id } });
      continue;
    }
    let reason;
    if (now?.status === 'fail') reason = 'failed';
    else if (!now && after.timedOut) reason = 'timed-out';
    else reason = 'missing';
    const severity = after.timedOut || (await isDirect(t.file)) ? 'high' : 'medium';
    regressions.push({ id: t.id, file: t.file, reason, severity });
    evidence.push({ kind: 'regression', detail: `${t.id} ${reason} (passed at baseline)`, files: [t.file], severity, data: { id: t.id, reason } });
  }
  if (after.timedOut) {
    evidence.push({ kind: 'timeout', detail: `test run exceeded ${timeoutMs}ms and was killed`, files: [], severity: 'high' });
  }
  for (const t of after.tests) {
    if (t.status === 'fail' && !baselineIds.has(t.id)) {
      evidence.push({ kind: 'new-test-failing', detail: `new test ${t.id} fails`, files: [t.file], data: { id: t.id } });
    }
  }
  evidence.push({
    kind: 'test-summary',
    detail: `${baseline.tests.length} baseline tests, ${after.tests.length} after, ${regressions.length} regressions`,
    files: [],
    data: { baselineTests: baseline.tests, afterTests: after.tests, regressions, testSelection, ...(testFiles ? { testFiles } : {}) },
  });
  return done(evidence);
}
