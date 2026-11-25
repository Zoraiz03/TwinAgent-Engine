/**
 * psi3 (dependencies): does the dependency graph stay acyclic and fully
 * resolvable under the diff? Evaluated as a NON-REGRESSION against the
 * unmodified target: problems that already exist at baseline are not charged.
 *
 * Checks (each yields evidence entries):
 *   a. manifest validity: package.json parses, required fields intact (high)
 *   b. install outcome from ctx.install: failure/timeout (high)
 *   c. `npm ls --all --json` problems new vs baseline: missing, invalid,
 *      extraneous, peer conflicts, ERESOLVE (high)
 *   d. import graph vs baseline: new cycles (medium), unresolved relative
 *      imports (medium), imports of undeclared packages (high)
 * Import problems are only considered inside the node set: changed files plus
 * everything reachable from them and everything depending on them. The baseline
 * is built once per target state and filtered to the same node set.
 */
import { readFile, realpath } from 'node:fs/promises';
import { join } from 'node:path';
import { run as exec } from '../engine/exec.js';
import { cached, withBaselineClone } from './baseline.js';
import { buildGraph, findCycles, isSource, reach, reverseEdges } from './import-graph.js';
import { buildResult } from './result.js';

const REQUIRED_FIELDS = ['name', 'version'];

/** Problems reported by `npm ls`, normalised so clone paths do not differ between runs. */
async function npmProblems(dir, env, roots, timeoutMs) {
  const r = await exec('npm', ['ls', '--all', '--json'], { cwd: dir, env, timeoutMs });
  const all = [...new Set([...roots, ...(await Promise.all(roots.map((x) => realpath(x).catch(() => x))))])];
  const scrub = (s) => all.reduce((acc, root) => acc.split(root).join('<root>'), String(s)).replace(/\s+/g, ' ').trim();
  const problems = new Set();
  if (r.timedOut) return new Set(['npm ls timed out']);
  let tree;
  try {
    tree = JSON.parse(r.stdout);
  } catch {
    if (r.code !== 0) problems.add(`npm ls failed: ${scrub(r.stderr).slice(0, 200)}`);
    return problems;
  }
  const collect = (node) => {
    for (const p of node?.problems ?? []) problems.add(scrub(p));
    for (const [name, dep] of Object.entries(node?.dependencies ?? {})) {
      if (dep.missing) problems.add(`missing: ${name}@${scrub(dep.required ?? '')}`);
      collect(dep);
    }
  };
  collect(tree);
  if (tree.error?.summary) problems.add(`npm ls error: ${scrub(tree.error.summary)}`);
  return problems;
}

/** Baseline: import-graph facts and npm ls problems of the unmodified target. */
function baselineFor(ctx, timeoutMs) {
  return cached(`psi3|${ctx.stateKey}`, () =>
    withBaselineClone(ctx, async ({ dir, env, roots }) => {
      const graph = await buildGraph(dir);
      return { graph, npm: await npmProblems(dir, env, roots, timeoutMs) };
    }),
  );
}

async function readManifest(dir) {
  try {
    return { pkg: JSON.parse(await readFile(join(dir, 'package.json'), 'utf8')) };
  } catch (err) {
    return { error: err.message };
  }
}

async function manifestEvidence(ctx) {
  const [before, after] = await Promise.all([readManifest(ctx.targetPath), readManifest(ctx.cloneDir)]);
  const bad = (detail) => [{ kind: 'manifest-invalid', detail, files: ['package.json'], severity: 'high' }];
  if (after.error) return before.error ? [] : bad(`package.json no longer parses: ${after.error}`);
  const out = [];
  for (const f of REQUIRED_FIELDS) {
    if (before.pkg?.[f] !== undefined && after.pkg[f] === undefined) out.push(...bad(`package.json lost required field "${f}"`));
  }
  for (const f of ['dependencies', 'devDependencies', 'peerDependencies', 'scripts']) {
    const v = after.pkg[f];
    if (v !== undefined && (typeof v !== 'object' || v === null || Array.isArray(v))) out.push(...bad(`package.json field "${f}" must be an object`));
  }
  return out;
}

/** Node set: changed source files, what they reach, and what depends on them. */
function nodeSet(after, base, changed) {
  const seeds = changed.filter(isSource);
  return new Set([
    ...reach(after.edges, seeds),
    ...reach(reverseEdges(after.edges), seeds),
    ...reach(reverseEdges(base.edges), seeds), // dependents of files the diff deleted
  ]);
}

function importEvidence(after, base, nodes) {
  const inSet = (files) => files.every((f) => nodes.has(f));
  const out = [];

  const baseCycles = new Set(findCycles(base.edges).map((c) => c.join('|')));
  for (const cycle of findCycles(after.edges)) {
    if (inSet(cycle) && !baseCycles.has(cycle.join('|'))) {
      out.push({ kind: 'new-cycle', detail: `circular import: ${cycle.join(' <-> ')}`, files: cycle, severity: 'medium' });
    }
  }
  const baseUnresolved = new Set(base.unresolved.map((u) => `${u.file}|${u.specifier}`));
  for (const u of after.unresolved) {
    if (nodes.has(u.file) && !baseUnresolved.has(`${u.file}|${u.specifier}`)) {
      out.push({ kind: 'unresolved-import', detail: `${u.file} imports missing file "${u.specifier}"`, files: [u.file], severity: 'medium' });
    }
  }
  const baseUndeclared = new Set(base.undeclared.map((u) => `${u.file}|${u.pkg}`));
  for (const u of after.undeclared) {
    if (nodes.has(u.file) && !baseUndeclared.has(`${u.file}|${u.pkg}`)) {
      out.push({ kind: 'undeclared-package', detail: `${u.file} imports "${u.pkg}", which is not a declared dependency or builtin`, files: [u.file], severity: 'high' });
    }
  }
  return out;
}

/**
 * @param {import('./index.js').CheckContext} ctx
 * @returns {Promise<import('../engine/schema.js').CheckResult>}
 */
export async function run(ctx) {
  const start = performance.now();
  const timeoutMs = ctx.config?.checks?.psi3?.timeoutMs ?? 60_000;
  const evidence = [];

  evidence.push(...(await manifestEvidence(ctx)));

  if (!ctx.install.ok) {
    evidence.push({ kind: 'install-failed', detail: `install (${ctx.install.strategy}) failed: ${ctx.install.error ?? 'unknown error'}`, files: ['package.json'], severity: 'high' });
  }

  const baseline = await baselineFor(ctx, timeoutMs);

  if (ctx.install.ok) {
    const roots = [ctx.cloneDir, ctx.targetPath];
    const after = await npmProblems(ctx.cloneDir, ctx.env, roots, timeoutMs);
    for (const p of after) {
      if (!baseline.npm.has(p)) evidence.push({ kind: 'resolution-problem', detail: p, files: ['package.json'], severity: 'high' });
    }
  }

  const graph = await buildGraph(ctx.cloneDir);
  const nodes = ctx.applyResult.touchesManifest
    ? new Set([...graph.files, ...baseline.graph.files])
    : nodeSet(graph, baseline.graph, ctx.applyResult.filesChanged);
  evidence.push(...importEvidence(graph, baseline.graph, nodes));

  evidence.push({ kind: 'summary', detail: `analyzed ${nodes.size} files in the import node set`, files: [] });
  return buildResult('psi3', evidence, { durationMs: Math.round(performance.now() - start) });
}
