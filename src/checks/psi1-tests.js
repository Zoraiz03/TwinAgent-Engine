/**
 * psi1 (tests): test suite integrity. Property: no test that passed at
 * baseline fails, goes missing, or times out after the diff.
 *
 * The same scope (config tests.scope: "related" | "full") and changed-file list
 * is run on the unmodified target (a throwaway clone, cached per target state)
 * and on the diff-applied clone. Pre-existing failures are not charged; new
 * tests that fail are reported but do not fail psi1 on their own. If no tests
 * exist for the scope the result is passed + inconclusive.
 * Severity: regression in a test file that directly imports a changed module =
 * high, other regressions = medium, timeout = high.
 */
import { cached, dropCached, withBaselineClone } from './baseline.js';
import { fileImports } from './import-graph.js';
import { buildResult } from './result.js';

const DEFAULT_TIMEOUT_MS = 120_000;

function baselineRun(ctx, files, timeoutMs, scope) {
  const key = `psi1|${ctx.stateKey}|${scope}|${[...(files ?? [])].sort().join(',')}`;
  const p = cached(key, () =>
    withBaselineClone(ctx, ({ dir, env }) => ctx.adapter.runTests(dir, { files, timeoutMs, env })),
  );
  // a timed-out baseline is not a trustworthy reference: do not keep it
  p.then((r) => { if (r.timedOut) dropCached(key); }, () => {});
  return p;
}

/**
 * @param {import('./index.js').CheckContext} ctx
 * @returns {Promise<import('../engine/schema.js').CheckResult>}
 */
export async function run(ctx) {
  const start = performance.now();
  const done = (evidence, extra = {}) =>
    buildResult('psi1', evidence, { ...extra, durationMs: Math.round(performance.now() - start) });

  const scope = ctx.config?.tests?.scope ?? 'related';
  const timeoutMs = ctx.config?.tests?.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const changed = ctx.applyResult.filesChanged;
  const files = scope === 'related' ? changed : undefined;

  const baseline = await baselineRun(ctx, files, timeoutMs, scope);
  if (baseline.timedOut) {
    return done(
      [{ kind: 'baseline-unavailable', detail: `baseline test run timed out after ${timeoutMs}ms`, files: [] }],
      { inconclusive: true },
    );
  }
  const after = await ctx.adapter.runTests(ctx.cloneDir, { files, timeoutMs, env: ctx.env });

  if (baseline.tests.length === 0 && after.tests.length === 0) {
    return done([{ kind: 'no-tests-found', detail: `no tests found for scope "${scope}"`, files: [] }], { inconclusive: true });
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
    let reason;
    if (now?.status === 'fail') reason = 'failed';
    else if (!now && after.timedOut) reason = 'timed-out';
    else if (!now) reason = 'missing';
    else continue; // now skipped: not a violation
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
    data: { baselineTests: baseline.tests, afterTests: after.tests, regressions },
  });
  return done(evidence);
}
