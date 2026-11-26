/**
 * psi2 (security): the diff must not introduce vulnerability patterns or
 * vulnerable dependencies that are not already in the baseline (same
 * non-regression principle as psi3).
 *
 *  1. Semgrep, local rules only (rules/semgrep/ plus config security.semgrepRules),
 *     over the changed files after the diff vs the same files at baseline. A
 *     finding is new when its fingerprint (rule + path + normalized matched
 *     code, no line numbers) is not in the baseline. ERROR -> high, WARNING ->
 *     medium. Renames from the diff map baseline paths to new paths first.
 *     Missing binary -> inconclusive "semgrep-unavailable".
 *  2. Dependency advisories via a provider (security.vulnProvider: npm-audit |
 *     osv-scanner | fixture), only when the diff touches a manifest/lockfile.
 *     New advisories (id + package) fail: critical/high -> high, moderate ->
 *     medium, low -> low (only fails with security.failOnLow). Unavailable
 *     provider -> inconclusive "vuln-provider-unavailable".
 * config analysisScope "full" scans all source files and always runs the
 * dependency scan (ground-truth observation); default "diff" is diff-scoped.
 * Both parts run in parallel with the scrubbed environment. The result records
 * the semgrep version and provider in `tool` for reproducibility.
 */
import { readFile, stat } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { join } from 'node:path';
import { cached, withBaselineClone } from './baseline.js';
import { parseRenames } from './diff-scan.js';
import { buildResult } from './result.js';
import { listSourceFiles } from '../twin/parse.js';
import { DEFAULT_RULES, hashRules, newFindings, runSemgrep, semgrepVersion } from './semgrep.js';
import { getProvider, ProviderUnavailableError } from './vuln-providers/index.js';

const VULN_SEVERITY = { critical: 'high', high: 'high', moderate: 'medium', low: 'low' };

async function existingFiles(dir, files) {
  const out = [];
  for (const f of files) if ((await stat(join(dir, f)).catch(() => null))?.isFile()) out.push(f);
  return out;
}

/** Semgrep part of psi2 (also used by the static baseline engine). */
export async function semgrepPart(ctx, sec) {
  const bin = sec.semgrepPath ?? 'semgrep';
  const version = await semgrepVersion(bin, ctx.env);
  if (!version) {
    return { version: null, unavailable: true, evidence: [{ kind: 'semgrep-unavailable', detail: `semgrep binary "${bin}" not found or not runnable; static scan skipped`, files: [] }] };
  }
  const rules = [DEFAULT_RULES, ...(sec.semgrepRules ?? [])];
  const timeoutMs = ctx.config?.checks?.psi2?.timeoutMs ?? 60_000;
  const full = ctx.config?.analysisScope === 'full';
  const changed = ctx.applyResult.filesChanged;
  // analysisScope "full" (used by RealSystem.observe): scan every source file
  const targets = (dir) => (full ? listSourceFiles(dir) : existingFiles(dir, changed));
  try {
    const key = `psi2|semgrep|${ctx.stateKey}|${await hashRules(rules)}|${version}|${full ? '*' : [...changed].sort().join(',')}`;
    const [after, baseline] = await Promise.all([
      targets(ctx.cloneDir).then((files) => runSemgrep(ctx.cloneDir, files, { bin, rules, env: ctx.env, timeoutMs })),
      cached(key, () => withBaselineClone(ctx, async ({ dir, env }) =>
        runSemgrep(dir, await targets(dir), { bin, rules, env, timeoutMs }))),
    ]);
    const found = newFindings(after, baseline, parseRenames(ctx.diff ?? ''));
    return {
      version,
      unavailable: false,
      scanned: full ? 'all' : changed.length,
      evidence: found.map((f) => ({
        kind: 'semgrep-finding',
        detail: `${f.path}:${f.line} ${f.message}`.trim(),
        files: [f.path],
        severity: f.severity,
        ruleId: f.ruleId,
        ...(f.cwe ? { cwe: f.cwe } : {}),
      })),
    };
  } catch (err) {
    return { version, unavailable: true, evidence: [{ kind: 'semgrep-error', detail: err.message, files: [] }] };
  }
}

async function vulnPart(ctx, sec, providerName) {
  if (!ctx.applyResult.touchesManifest && ctx.config?.analysisScope !== 'full') return { evidence: [], ran: false };
  const provider = getProvider(providerName);
  const unavailable = (detail) => ({ unavailable: true, ran: true, evidence: [{ kind: 'vuln-provider-unavailable', detail, files: ['package.json'] }] });
  if (!provider) return unavailable(`unknown vuln provider "${providerName}"`);
  const opts = (env) => ({ env, timeoutMs: ctx.config?.checks?.psi2?.timeoutMs ?? 60_000, config: ctx.config });
  try {
    const fixtureHash = sec.vulnFixture
      ? createHash('sha256').update(await readFile(sec.vulnFixture).catch(() => '')).digest('hex').slice(0, 16)
      : '';
    const [after, baseline] = await Promise.all([
      provider.scan(ctx.cloneDir, opts(ctx.env)),
      cached(`psi2|vuln|${providerName}|${fixtureHash}|${ctx.stateKey}`, () =>
        withBaselineClone(ctx, ({ dir, env }) => provider.scan(dir, opts(env)))),
    ]);
    const known = new Set(baseline.map((a) => `${a.advisoryId}|${a.package}`));
    const evidence = [];
    for (const a of after) {
      if (known.has(`${a.advisoryId}|${a.package}`)) continue;
      const sev = VULN_SEVERITY[a.severity] ?? 'medium';
      const fails = sev !== 'low' || sec.failOnLow === true;
      evidence.push({
        kind: fails ? 'vulnerable-dependency' : 'vulnerable-dependency-low',
        detail: `${a.package}@${a.version}: ${a.advisoryId} ${a.title}`.trim(),
        files: ['package.json'],
        advisoryId: a.advisoryId,
        ...(fails ? { severity: sev } : {}),
      });
    }
    return { ran: true, evidence };
  } catch (err) {
    if (err instanceof ProviderUnavailableError) return unavailable(err.message);
    throw err;
  }
}

/**
 * @param {import('./index.js').CheckContext} ctx
 * @returns {Promise<import('../engine/schema.js').CheckResult>}
 */
export async function run(ctx) {
  const start = performance.now();
  const sec = ctx.config?.security ?? {};
  const providerName = sec.vulnProvider ?? 'npm-audit';
  const [sg, vu] = await Promise.all([semgrepPart(ctx, sec), vulnPart(ctx, sec, providerName)]);
  const evidence = [...sg.evidence, ...vu.evidence];
  evidence.push({
    kind: 'summary',
    detail: `static scan: ${sg.unavailable ? 'unavailable' : `${sg.scanned} file(s)`}; dependency scan: ${vu.ran ? providerName : 'skipped (no manifest change)'}`,
    files: [],
  });
  const result = buildResult('psi2', evidence, {
    durationMs: Math.round(performance.now() - start),
    tool: { semgrepVersion: sg.version, vulnProvider: providerName },
  });
  return { ...result, inconclusive: Boolean(sg.unavailable || vu.unavailable) && result.passed };
}
