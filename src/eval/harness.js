/**
 * Evaluation harness.
 *
 * inject: labeled injections are fed to the mode under test as the agent's
 *   proposal (no LLM, no reformulation: K = 0).
 * agent:  an LLM agent works on tasks from <tasks>/*.json ({ id, description,
 *   hints? }); reformulation allowed.
 *
 * The target is copied to <out>/work/real, which becomes the RealSystem; the
 * given target is never modified. Before each action the RealSystem is restored
 * to the pristine baseline snapshot (independent samples) unless
 * loop.persistState is true.
 *
 * Ground truth, recorded per action:
 *   labelByConstruction  the injection's expected violations (null for agent tasks);
 *   labelObserved        violations seen by RealSystem.observe() (full checks +
 *                        runtime probes). For injections this comes from an
 *                        oracle run of the injected diff on the real system,
 *                        so it exists even when the mode never executed it;
 *   labelAgreement       whether the two agree ("psi1-runtime" counts as psi1,
 *                        psi4 is ignored while psi4Pending).
 */
import { cp, mkdir, readdir, readFile, realpath, symlink, writeFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { join, relative, resolve, sep } from 'node:path';
import { createAgent } from '../agent/index.js';
import { PROMPT_VERSION } from '../agent/prompts.js';
import { loadConfig, mergeConfig } from '../engine/index.js';
import { RealSystem, run, violations } from '../loop/index.js';
import { generateWithReport } from './fault-injection.js';
import { buildManifest, writeManifest } from './manifest.js';
import { loadTestbed } from './testbed.js';

/** Normalize a label for comparison: psi1-runtime -> psi1; drop psi4 while pending. */
export function normalizeLabel(label, { psi4Pending = false } = {}) {
  if (!label) return label;
  return [...new Set(label.map((l) => (l === 'psi1-runtime' ? 'psi1' : l)))].filter((l) => !(psi4Pending && l === 'psi4')).sort();
}

const sameSet = (a, b) => a.length === b.length && a.every((x, i) => x === b[i]);

/** Copy the target into <out>/work/real (node_modules symlinked) and wrap it as a RealSystem. */
async function prepareRealSystem(target, out, cfg, tmpRoot) {
  const src = await realpath(resolve(target));
  const real = join(out, 'work', 'real');
  await mkdir(join(out, 'work'), { recursive: true });
  await cp(src, real, { recursive: true, filter: (p) => !relative(src, p).split(sep).some((s) => s === '.git' || s === 'node_modules') });
  if (existsSync(join(src, 'node_modules'))) await symlink(await realpath(join(src, 'node_modules')), join(real, 'node_modules'), 'dir');
  const { probes } = await loadTestbed(real);
  return RealSystem.init(real, { config: cfg, probes, tmpRoot });
}

/** Agent stand-in for inject mode: proposes the injected diff verbatim. */
function injectedAgent(inj) {
  const usage = { inputTokens: 0, outputTokens: 0 };
  return {
    propose: async () => ({ rationale: inj.description, diff: inj.diff, usage, promptVersion: PROMPT_VERSION }),
    reformulate: async () => ({ error: 'no reformulation in inject mode', usage, promptVersion: PROMPT_VERSION }),
  };
}

/**
 * @param {{target: string, mode: string, n: number, seed: number, out: string, categories?: string[], config?: object, tmpRoot?: string}} opts
 */
export async function runInjectEval({ target, mode, n, seed, out, categories, config = {}, tmpRoot }) {
  const startedAt = new Date().toISOString();
  await mkdir(out, { recursive: true });
  const advisoryPath = join(out, 'advisories.json');
  const logPath = join(out, 'actions.jsonl');
  const cfg = mergeConfig(await loadConfig(), mergeConfig(config, {
    loop: { mode },
    eval: { logPath },
    security: { vulnProvider: 'fixture', vulnFixture: advisoryPath },
  }));
  const realSystem = await prepareRealSystem(target, out, cfg, tmpRoot);
  const { injections, skipped } = await generateWithReport(realSystem.dir, { seed, n, categories, tmpRoot, config: cfg });
  await writeFile(advisoryPath, `${JSON.stringify(injections.flatMap((i) => i.advisories), null, 2)}\n`);
  await writeFile(join(out, 'injections.json'), `${JSON.stringify({ seed, skipped, injections }, null, 2)}\n`);

  const pristine = await realSystem.snapshot();
  const outcomes = [];
  for (const inj of injections) {
    if (!cfg.loop.persistState) await realSystem.restore(pristine);
    // oracle: what the real system shows when this exact diff is executed
    const snap = await realSystem.snapshot();
    const applied = await realSystem.apply(inj.diff, `oracle: ${inj.id}`);
    const labelObserved = applied.ok ? violations(await realSystem.observe(snap)) : null;
    await realSystem.restore(snap);

    const truth = normalizeLabel(inj.expectedViolations, inj);
    const observedNorm = labelObserved && normalizeLabel(labelObserved, inj);
    const result = await run({ id: inj.id, text: inj.description }, {
      agent: injectedAgent(inj),
      realSystem,
      K: 0,
      config: cfg,
      logPath,
      tmpRoot,
      annotate: () => ({
        injection: { id: inj.id, category: inj.category, seed: inj.seed, description: inj.description, psi4Pending: inj.psi4Pending },
        labelByConstruction: inj.expectedViolations,
        labelObserved,
        labelAgreement: observedNorm ? sameSet(truth, observedNorm) : null,
      }),
    });
    outcomes.push(result);
  }
  if (!cfg.loop.persistState) await realSystem.restore(pristine);
  const manifest = await buildManifest({
    evalType: 'inject', mode, config: cfg, seed, n, categories: categories ?? null, targetPath: realSystem.dir, modelId: 'none (injected diffs)', startedAt, skippedCategories: skipped,
  });
  await writeManifest(out, manifest);
  return { out, logPath, injections, skipped, manifest, outcomes, realSystem, pristine };
}

/**
 * @param {{target: string, tasksDir: string, mode: string, out: string, generate: Function, modelId: string, config?: object, tmpRoot?: string}} opts
 */
export async function runAgentEval({ target, tasksDir, mode, out, generate, modelId, config = {}, tmpRoot }) {
  const startedAt = new Date().toISOString();
  await mkdir(out, { recursive: true });
  const logPath = join(out, 'actions.jsonl');
  const cfg = mergeConfig(await loadConfig(), mergeConfig(config, { loop: { mode }, eval: { logPath } }));
  const realSystem = await prepareRealSystem(target, out, cfg, tmpRoot);
  const files = (await readdir(tasksDir)).filter((f) => f.endsWith('.json')).sort();
  const tasks = await Promise.all(files.map(async (f) => JSON.parse(await readFile(join(tasksDir, f), 'utf8'))));
  const agent = createAgent({ generate, config: cfg });
  const pristine = await realSystem.snapshot();
  const outcomes = [];
  for (const task of tasks) {
    if (!cfg.loop.persistState) await realSystem.restore(pristine);
    const text = task.hints ? `${task.description}\n\nHints:\n${[].concat(task.hints).join('\n')}` : task.description;
    outcomes.push(await run({ id: task.id, text }, {
      agent, realSystem, config: cfg, logPath, tmpRoot,
      annotate: (rec) => ({
        evalTaskId: task.id,
        injection: null,
        labelByConstruction: null,
        labelObserved: rec.executedOnReal && rec.observed ? violations(rec.observed) : null,
        labelAgreement: null,
      }),
    }));
  }
  if (!cfg.loop.persistState) await realSystem.restore(pristine);
  const manifest = await buildManifest({ evalType: 'agent', mode, config: cfg, targetPath: realSystem.dir, modelId, startedAt });
  await writeManifest(out, manifest);
  return { out, logPath, manifest, outcomes };
}
