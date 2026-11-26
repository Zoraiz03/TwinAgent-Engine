/**
 * Agentic decision loop (paper Algorithm 1).
 *
 *   for each action a in decomposeTask(task):
 *     p <- agent.propose(a, context)
 *     repeat:
 *       R <- engine.simulate(p)            (clone of the RealSystem, twin T)
 *       Safe   -> realSystem.apply(p); O <- realSystem.observe();
 *                 T.promote(T'); feedback(deltaCR(R, O)); next action
 *       Abort  -> escalate
 *       Revise -> if retries == K: escalate; p <- agent.reformulate(a, p, R)
 *
 * Modes (config loop.mode) share the agent, prompts, K and RealSystem and
 * differ only in the safety mechanism:
 *   twinagent  simulate on a clone with the twin (above);
 *   static     static checks only on a clone (src/engine/static.js), then commit;
 *   direct     no safety: propose once, commit, observe;
 *   reactive   commit, observe; on an observed violation roll back (restore
 *              the snapshot) and reformulate from the OBSERVED evidence.
 * Every record carries executedOnReal, harmfulExecuted (an observed violation
 * after any execution, even if rolled back) and harmfulFinal (a violation
 * left in the final state).
 *
 * Escalation is a returned outcome ({ status: "Escalated", reason, report }),
 * never an exception: LLM, engine, apply and observation errors all become
 * escalations with the error recorded. Each action yields an ActionRecord
 * (src/loop/record.js) appended to the JSONL run log; the run stops at the
 * first escalated action.
 */
import { createHash } from 'node:crypto';
import { pickAdapter } from '../adapters/index.js';
import { buildContext } from '../agent/context.js';
import { PROMPT_VERSION } from '../agent/prompts.js';
import { loadConfig, mergeConfig, simulateWithTwin } from '../engine/index.js';
import { simulateStatic } from '../engine/static.js';
import { Twin } from '../twin/twin.js';
import { appendRecord, defaultLogPath, deltaCR, psi4Calibration, recalibrateTelemetry, refreshCoverage } from './feedback.js';

export { RealSystem } from './real-system.js';

const sha = (s) => createHash('sha256').update(s).digest('hex');
const canonical = (v) => (Array.isArray(v)
  ? `[${v.map(canonical).join(',')}]`
  : v && typeof v === 'object'
    ? `{${Object.keys(v).sort().map((k) => `${JSON.stringify(k)}:${canonical(v[k])}`).join(',')}}`
    : JSON.stringify(v));
const since = (t) => Math.round(performance.now() - t);
const errMsg = (e) => (e instanceof Error ? e.message : String(e));

/**
 * Split a task into ordered actions. Default: the task itself. An injected
 * decomposer wins; otherwise config agent.decompose=true asks the agent.
 * @returns {Promise<string[]>}
 */
export async function decomposeTask(task, { decomposer, agent, config, context = '' } = {}) {
  if (decomposer) return decomposer(task);
  if (config?.agent?.decompose && agent?.decompose) {
    const r = await agent.decompose(task, context);
    if (r.error) throw new Error(`decomposition failed: ${r.error}`);
    return r.actions;
  }
  return [task];
}

export const MODES = ['twinagent', 'direct', 'reactive', 'static'];
const PSIS = ['psi1', 'psi2', 'psi3', 'psi4'];

/** psi ids a report says are violated (failed and not inconclusive). */
export const violations = (report) => (report ? PSIS.filter((id) => report[id] && !report[id].passed && !report[id].inconclusive) : []);

/** Config hash without run-location settings (paths), so identical setups hash equal. */
export function configHash(cfg) {
  const c = JSON.parse(JSON.stringify(cfg));
  if (c.eval) delete c.eval.logPath;
  if (c.security) delete c.security.vulnFixture;
  if (c.twin) delete c.twin.persistPath;
  return sha(canonical(c)).slice(0, 16);
}

function proposalSummary(p) {
  return {
    diffHash: p?.diff ? sha(p.diff).slice(0, 16) : null,
    diffBytes: p?.diff ? Buffer.byteLength(p.diff) : 0,
    rationale: p?.rationale ?? null,
    usage: { inputTokens: p?.usage?.inputTokens ?? 0, outputTokens: p?.usage?.outputTokens ?? 0 },
    ...(p?.error ? { error: p.error } : {}),
  };
}

/**
 * Run one task through the decision loop.
 * @param {string | {id?: string, text: string}} task
 * @param {object} deps
 * @param {ReturnType<import('../agent/index.js').createAgent>} deps.agent
 * @param {import('./real-system.js').RealSystem} deps.realSystem
 * @param {{simulate: Function}} [deps.engine]  predictor for twinagent/static (default: engine / static engine)
 * @param {Twin} [deps.twin]  T; built from the RealSystem when omitted (twinagent mode)
 * @param {number} [deps.K]  max retries (default config loop.maxRetries)
 * @param {object} [deps.config]  overrides merged over config/default.json (loop.mode selects the mode)
 * @param {(task: string) => Promise<string[]>|string[]} [deps.decomposer]
 * @param {string} [deps.logPath]  JSONL log (default config eval.logPath or ./runs/<ts>/actions.jsonl)
 * @param {(record: object) => object|Promise<object>} [deps.annotate]  extra fields merged into each record before logging
 * @param {string} [deps.tmpRoot]
 */
export async function run(task, { agent, realSystem, engine, twin, K, config, decomposer, logPath, annotate, tmpRoot } = {}) {
  const cfg = mergeConfig(await loadConfig(), config);
  const mode = cfg.loop?.mode ?? 'twinagent';
  if (!MODES.includes(mode)) throw new Error(`unknown loop.mode "${mode}"`);
  const maxRetries = K ?? cfg.loop?.maxRetries ?? 3;
  const twinMode = mode === 'twinagent' && cfg.twin?.enabled !== false ? 'twin' : 'plain';
  const predictor = engine ?? (mode === 'static' ? { simulate: simulateStatic } : { simulate: simulateWithTwin });
  const taskText = typeof task === 'string' ? task : task.text;
  const taskId = (typeof task === 'object' && task.id) || sha(taskText).slice(0, 12);
  const log = logPath ?? cfg.eval?.logPath ?? defaultLogPath();
  const hash = configHash(cfg);
  const records = [];
  const logErrors = [];
  const escalate = (reason, error, report = null) => ({ status: 'Escalated', reason, error, report, records, logErrors, twin: T, logPath: log });

  let T = null;
  try {
    if (twinMode === 'twin') T = twin ?? (await Twin.build(realSystem.dir, pickAdapter(realSystem.dir), cfg));
  } catch (err) {
    return escalate('twin-build-failed', errMsg(err));
  }

  let actions;
  try {
    actions = await decomposeTask(taskText, { decomposer, agent, config: cfg });
  } catch (err) {
    return escalate('decompose-failed', errMsg(err));
  }

  for (const [actionIndex, action] of actions.entries()) {
    const rec = await runAction({ action, actionIndex, taskId, agent, predictor, realSystem, cfg, mode, maxRetries, T, twinMode, configHash: hash, tmpRoot });
    if (annotate) Object.assign(rec.record, await annotate(rec.record));
    records.push(rec.record);
    try {
      await appendRecord(log, rec.record);
    } catch (err) {
      logErrors.push(errMsg(err));
    }
    if (rec.record.finalStatus === 'Escalated') return escalate(rec.record.reason, rec.record.error, rec.lastReport);
  }
  return { status: 'Success', records, logErrors, twin: T, logPath: log };
}

async function runAction({ action, actionIndex, taskId, agent, predictor, realSystem, cfg, mode, maxRetries, T, twinMode, configHash: hash, tmpRoot }) {
  const start = performance.now();
  const reformulateMode = cfg.agent?.reformulateMode ?? 'report';
  const attempts = [];
  let tokens = 0;
  let lastReport = null;
  const safety = { executedOnReal: false, harmfulExecuted: false, harmfulFinal: false, rollbacks: 0 };
  let predictedViolations = null;
  const record = (fields) => ({
    record: {
      actionId: `${taskId}-${actionIndex}`,
      taskId,
      actionIndex,
      action,
      mode,
      attempts,
      finalStatus: 'Escalated',
      reason: null,
      error: null,
      committed: false,
      commitId: null,
      observed: null,
      deltaCR: null,
      twinUpdates: null,
      calibration: null,
      ...safety,
      predictedViolations,
      reformulateMode,
      totalLatencyMs: since(start),
      totalTokens: tokens,
      promptVersion: PROMPT_VERSION,
      twinMode,
      configHash: hash,
      timestamp: new Date().toISOString(),
      ...fields,
    },
    lastReport,
  });
  const escalate = (reason, error = null, extra = {}) => record({ finalStatus: 'Escalated', reason, error, ...extra });

  let context;
  try {
    context = (await buildContext({ dir: realSystem.dir, task: action, twin: T, budgetChars: cfg.agent?.contextBudgetChars })).text;
  } catch (err) {
    return escalate('context-failed', errMsg(err));
  }

  /** Commit to the RealSystem and observe; returns { ok, commit, observed, observeError, snap } or { ok: false, error }. */
  const commitAndObserve = async (diff) => {
    let snap;
    try {
      snap = await realSystem.snapshot();
    } catch (err) {
      return { ok: false, error: errMsg(err) };
    }
    const applied = await realSystem.apply(diff, `twinagent: ${action.slice(0, 60)}`);
    if (!applied.ok) {
      await realSystem.restore(snap).catch(() => {});
      return { ok: false, error: applied.error };
    }
    safety.executedOnReal = true;
    let observed = null;
    let observeError = null;
    try {
      observed = await realSystem.observe(snap);
    } catch (err) {
      observeError = errMsg(err);
    }
    if (violations(observed).length) safety.harmfulExecuted = true;
    return { ok: true, commit: applied.commit, observed, observeError, snap };
  };

  let t = performance.now();
  let proposal = await agent.propose(action, context);
  let proposeMs = since(t);
  for (let retry = 0; ; retry++) {
    const kind = retry === 0 ? 'propose' : 'reformulate';
    tokens += (proposal?.usage?.inputTokens ?? 0) + (proposal?.usage?.outputTokens ?? 0);
    const attempt = (report, verdict, simulateMs = 0) => attempts.push({ index: retry, kind, proposal: proposalSummary(proposal), report, verdict, timings: { proposeMs, simulateMs } });
    if (!proposal || proposal.error) {
      attempt(null, null);
      return escalate('agent-error', proposal?.error ?? 'agent returned nothing');
    }

    // ---- direct: no safety mechanism, commit what was proposed ----
    if (mode === 'direct') {
      attempt(null, null);
      const c = await commitAndObserve(proposal.diff);
      if (!c.ok) return escalate('commit-failed', c.error);
      safety.harmfulFinal = violations(c.observed).length > 0;
      return finish(c, null);
    }

    // ---- reactive: commit, observe, roll back on an observed violation ----
    if (mode === 'reactive') {
      const c = await commitAndObserve(proposal.diff);
      if (!c.ok) {
        attempt(null, null);
        return escalate('commit-failed', c.error);
      }
      if (!c.observed) {
        attempt(null, null);
        safety.harmfulFinal = false;
        return record({ committed: true, commitId: c.commit, finalStatus: 'Escalated', reason: 'observe-failed', error: c.observeError });
      }
      lastReport = c.observed;
      attempt(c.observed, c.observed.classification);
      if (violations(c.observed).length === 0) return finish(c, null);
      await realSystem.restore(c.snap); // rollback: the harm was already executed on the real system
      safety.rollbacks++;
      if (retry >= maxRetries) return escalate('retries-exhausted', null, { observed: c.observed });
      t = performance.now();
      proposal = await agent.reformulate(action, proposal, c.observed, reformulateMode, context);
      proposeMs = since(t);
      continue;
    }

    // ---- twinagent / static: predict on a clone before touching the real system ----
    t = performance.now();
    let sim;
    try {
      sim = await predictor.simulate({ target: realSystem.dir, diff: proposal.diff, config: cfg, twin: T ?? undefined, tmpRoot });
    } catch (err) {
      attempt(null, null, since(t));
      return escalate('engine-error', errMsg(err));
    }
    const report = sim.report;
    lastReport = report;
    predictedViolations = violations(report);
    attempt(report, report.classification, since(t));

    if (report.classification === 'Abort') return escalate('abort');
    if (report.classification === 'Revise') {
      if (retry >= maxRetries) return escalate('retries-exhausted');
      t = performance.now();
      proposal = await agent.reformulate(action, proposal, report, reformulateMode, context);
      proposeMs = since(t);
      continue;
    }

    const c = await commitAndObserve(proposal.diff);
    if (!c.ok) return escalate('commit-failed', c.error);
    safety.harmfulFinal = violations(c.observed).length > 0;
    let promoted = false;
    if (T && sim.twinPrime) {
      T.promote(sim.twinPrime);
      promoted = true;
    }
    return finish(c, report, promoted);
  }

  function finish(c, predicted, promoted = false) {
    const fields = {
      committed: true,
      commitId: c.commit,
      observed: c.observed,
      deltaCR: c.observed && predicted ? deltaCR(predicted, c.observed) : null,
      twinUpdates: {
        promoted,
        coverageAdded: refreshCoverage(T, c.observed),
        telemetry: recalibrateTelemetry(T, c.observed?.spans),
      },
      calibration: c.observed && predicted ? psi4Calibration(predicted, c.observed) : null,
    };
    if (!c.observed) return record({ ...fields, finalStatus: 'Escalated', reason: 'observe-failed', error: c.observeError });
    return record({ ...fields, finalStatus: 'Success' });
  }
}
