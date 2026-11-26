/**
 * Labeled fault-injection generator.
 *
 *   generate(target, { seed, n, categories }) -> Injection[]
 *   Injection = { id, category, expectedViolations, diff, seed, description,
 *                 psi4Pending, advisories }
 *
 * Labels hold BY CONSTRUCTION (see injectors/index.js): every candidate is
 * validated on a scratch copy before it is accepted (a covered mutant must
 * kill a baseline-passing test, an uncovered one must fail a runtime probe
 * while tests pass, pattern/dependency/benign injections must keep all tests
 * and probes passing). Everything is driven by a seeded PRNG: the same seed
 * and target state give identical output. Categories without a suitable site
 * are skipped with a reason (generateWithReport). The target is never written.
 */
import { existsSync, readFileSync } from 'node:fs';
import { realpath, symlink } from 'node:fs/promises';
import { join } from 'node:path';
import { pickAdapter } from '../adapters/index.js';
import { scrubbedEnv } from '../engine/env.js';
import { run } from '../engine/exec.js';
import { Twin } from '../twin/twin.js';
import { applyEdits, diffFromEdits, relockOffline, scratchCopy } from './diff-util.js';
import { CATEGORIES, INJECTORS } from './injectors/index.js';
import { childSeed, prng } from './prng.js';
import { loadTestbed } from './testbed.js';

export { CATEGORIES } from './injectors/index.js';

const MAX_CANDIDATES = 8;

/** Facts injectors choose sites from (twin graph + testbed probes). */
export async function analyzeTarget(dir, { adapter, config } = {}) {
  const ad = adapter ?? pickAdapter(dir);
  const twin = await Twin.build(dir, ad, config);
  const nodes = [...twin.nodes.entries()];
  const modules = nodes.filter(([, n]) => n.kind === 'module').map(([id]) => id).sort();
  const tests = nodes.filter(([, n]) => n.kind === 'test').map(([id]) => id).sort();
  const coveredModules = [...new Set([...twin.edges.values()].filter((e) => e.type === 'tests').map((e) => e.to))].sort();
  const reachedByTests = new Set([...tests, ...twin.forwardReachable(tests)]);
  const { probes } = await loadTestbed(dir);
  const entries = probes.flatMap((p) => (p.args ?? []).filter((a) => twin.specs.has(a)));
  const probed = new Set([...entries, ...twin.forwardReachable(entries)]);
  const uncoveredProbed = modules.filter((m) => probed.has(m) && !reachedByTests.has(m));
  const moduleSet = new Set(modules);
  const moduleEdges = [...twin.edges.values()].filter((e) => e.type === 'imports' && moduleSet.has(e.from) && moduleSet.has(e.to)).map(({ from, to }) => ({ from, to }))
    .sort((a, b) => `${a.from}|${a.to}`.localeCompare(`${b.from}|${b.to}`));
  return {
    dir, adapter: ad, twin, modules, tests, coveredModules, uncoveredProbed, moduleEdges, probes,
    framework: ad.testCommand(dir)?.framework ?? null,
    hasManifest: existsSync(join(dir, 'package.json')),
    read: (f) => readFileSync(join(dir, f), 'utf8'),
  };
}

async function runProbes(dir, probes, env) {
  const out = {};
  for (const p of probes) {
    const r = await run(p.cmd, p.args ?? [], { cwd: dir, env, timeoutMs: p.timeoutMs ?? 60_000 });
    out[p.name] = r.code === 0 && !r.timedOut && (!p.expectStdout || r.stdout.includes(p.expectStdout));
  }
  return out;
}

/** Run the target's tests and probes on a scratch copy with `edits` applied. */
async function behaviour(info, edits, { relock = false, tmpRoot } = {}) {
  const s = await scratchCopy(info.dir, tmpRoot);
  try {
    await applyEdits(s.dir, edits);
    if (relock) await relockOffline(s.dir);
    if (existsSync(join(info.dir, 'node_modules'))) await symlink(await realpath(join(info.dir, 'node_modules')), join(s.dir, 'node_modules'), 'dir');
    const env = scrubbedEnv({ home: join(s.dir, '..') });
    const tests = await info.adapter.runTests(s.dir, { timeoutMs: 60_000, env });
    return { tests: new Map(tests.tests.map((t) => [t.id, t.status])), timedOut: tests.timedOut, probes: await runProbes(s.dir, info.probes, env) };
  } finally {
    await s.dispose();
  }
}

function valid(kind, base, after) {
  const basePass = [...base.tests].filter(([, s]) => s === 'pass').map(([id]) => id);
  const testsStillPass = !after.timedOut && basePass.every((id) => after.tests.get(id) === 'pass');
  const probesStillPass = Object.entries(base.probes).every(([n, ok]) => !ok || after.probes[n]);
  if (kind === 'tests-fail') return after.timedOut || basePass.some((id) => after.tests.get(id) === 'fail');
  if (kind === 'probe-fail') return testsStillPass && !probesStillPass;
  if (kind === 'tests-pass') return testsStillPass && probesStillPass;
  return true;
}

/**
 * @param {string} target
 * @param {{seed: number, n: number, categories?: string[], tmpRoot?: string, config?: any}} opts
 * @returns {Promise<{injections: object[], skipped: Array<{category: string, reason: string}>}>}
 */
export async function generateWithReport(target, { seed, n, categories = CATEGORIES, tmpRoot, config } = {}) {
  for (const c of categories) if (!CATEGORIES.includes(c)) throw new Error(`unknown injection category "${c}"`);
  const info = await analyzeTarget(target, { config });
  const base = await behaviour(info, {}, { tmpRoot });
  const available = [...categories];
  const skipped = [];
  const injections = [];
  for (let i = 0, slot = 0; injections.length < n && available.length; slot++) {
    const category = available[slot % available.length];
    const injector = INJECTORS.find((x) => x.category === category);
    const s = childSeed(seed, i);
    const candidates = injector.candidates(info, prng(s)).slice(0, MAX_CANDIDATES);
    let chosen = null;
    for (const c of candidates) {
      if (injector.validate === 'none' || valid(injector.validate, base, await behaviour(info, c.edits, { relock: c.relock, tmpRoot }))) { chosen = c; break; }
    }
    if (!chosen) {
      available.splice(available.indexOf(category), 1);
      slot--;
      skipped.push({ category, reason: candidates.length ? `no candidate passed "${injector.validate}" validation (${candidates.length} tried)` : 'no suitable site in the target' });
      continue;
    }
    injections.push({
      id: `${category}-${String(i).padStart(3, '0')}`,
      category,
      expectedViolations: injector.expected,
      diff: await diffFromEdits(target, chosen.edits, { relock: chosen.relock, tmpRoot }),
      seed: s,
      description: chosen.description,
      psi4Pending: Boolean(injector.psi4Pending),
      advisories: chosen.advisories ?? [],
    });
    i++;
  }
  return { injections, skipped };
}

/** Deterministic labeled injections (see generateWithReport for skipped categories). */
export async function generate(target, opts) {
  return (await generateWithReport(target, opts)).injections;
}
