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
 * Run Algorithm 1 for one task.
 * @param {string | {id?: string, text: string}} task
 * @param {object} deps
 * @param {ReturnType<import('../agent/index.js').createAgent>} deps.agent
 * @param {import('./real-system.js').RealSystem} deps.realSystem
 * @param {{simulate: typeof simulateWithTwin}} [deps.engine]  default: the real engine
 * @param {Twin} [deps.twin]  T; built from the RealSystem when omitted (twin mode)
 * @param {number} [deps.K]  max Revise retries (default config loop.maxRetries)
 * @param {object} [deps.config]  overrides merged over config/default.json
 * @param {(task: string) => Promise<string[]>|string[]} [deps.decomposer]
 * @param {string} [deps.logPath]  JSONL log (default config eval.logPath or ./runs/<ts>/actions.jsonl)
 * @param {string} [deps.tmpRoot]
 */
export async function run(task, { agent, realSystem, engine = { simulate: simulateWithTwin }, twin, K, config, decomposer, logPath, tmpRoot } = {}) {
  const cfg = mergeConfig(await loadConfig(), config);
  const maxRetries = K ?? cfg.loop?.maxRetries ?? 3;
  const twinMode = cfg.twin?.enabled === false ? 'plain' : 'twin';
  const taskText = typeof task === 'string' ? task : task.text;
  const taskId = (typeof task === 'object' && task.id) || sha(taskText).slice(0, 12);
  const log = logPath ?? cfg.eval?.logPath ?? defaultLogPath();
  const configHash = sha(canonical(cfg)).slice(0, 16);
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
    const rec = await runAction({ action, actionIndex, taskId, agent, engine, realSystem, cfg, maxRetries, T, twinMode, configHash, tmpRoot });
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

async function runAction({ action, actionIndex, taskId, agent, engine, realSystem, cfg, maxRetries, T, twinMode, configHash, tmpRoot }) {
  const start = performance.now();
  const attempts = [];
  let tokens = 0;
  let lastReport = null;
  const record = (fields) => ({
    record: {
      actionId: `${taskId}-${actionIndex}`,
      taskId,
      actionIndex,
      action,
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
      totalLatencyMs: since(start),
      totalTokens: tokens,
      promptVersion: PROMPT_VERSION,
      twinMode,
      configHash,
      timestamp: new Date().toISOString(),
      ...fields,
    },
    lastReport,
  });
  const escalate = (reason, error = null) => record({ finalStatus: 'Escalated', reason, error });

  let context;
  try {
    context = (await buildContext({ dir: realSystem.dir, task: action, twin: T, budgetChars: cfg.agent?.contextBudgetChars })).text;
  } catch (err) {
    return escalate('context-failed', errMsg(err));
  }

  let t = performance.now();
  let proposal = await agent.propose(action, context);
  let proposeMs = since(t);
  for (let retry = 0; ; retry++) {
    const kind = retry === 0 ? 'propose' : 'reformulate';
    tokens += (proposal?.usage?.inputTokens ?? 0) + (proposal?.usage?.outputTokens ?? 0);
    if (!proposal || proposal.error) {
      attempts.push({ index: retry, kind, proposal: proposalSummary(proposal), report: null, verdict: null, timings: { proposeMs, simulateMs: 0 } });
      return escalate('agent-error', proposal?.error ?? 'agent returned nothing');
    }

    t = performance.now();
    let sim;
    try {
      sim = await engine.simulate({ target: realSystem.dir, diff: proposal.diff, config: cfg, twin: T ?? undefined, tmpRoot });
    } catch (err) {
      attempts.push({ index: retry, kind, proposal: proposalSummary(proposal), report: null, verdict: null, timings: { proposeMs, simulateMs: since(t) } });
      return escalate('engine-error', errMsg(err));
    }
    const report = sim.report;
    lastReport = report;
    attempts.push({ index: retry, kind, proposal: proposalSummary(proposal), report, verdict: report.classification, timings: { proposeMs, simulateMs: since(t) } });

    if (report.classification === 'Abort') return escalate('abort');
    if (report.classification === 'Revise') {
      if (retry >= maxRetries) return escalate('retries-exhausted');
      t = performance.now();
      proposal = await agent.reformulate(action, proposal, report, cfg.agent?.reformulateMode ?? 'report', context);
      proposeMs = since(t);
      continue;
    }

    // Safe: commit to the RealSystem, observe ground truth, update the twin, feed back.
    let snap;
    try {
      snap = await realSystem.snapshot();
    } catch (err) {
      return escalate('commit-failed', errMsg(err));
    }
    const applied = await realSystem.apply(proposal.diff, `twinagent: ${action.slice(0, 60)}`);
    if (!applied.ok) {
      await realSystem.restore(snap).catch(() => {});
      return escalate('commit-failed', applied.error);
    }
    let observed = null;
    let observeError = null;
    try {
      observed = await realSystem.observe(snap);
    } catch (err) {
      observeError = errMsg(err);
    }
    let promoted = false;
    if (T && sim.twinPrime) {
      T.promote(sim.twinPrime);
      promoted = true;
    }
    const fields = {
      committed: true,
      commitId: applied.commit,
      observed,
      deltaCR: observed ? deltaCR(report, observed) : null,
      twinUpdates: {
        promoted,
        coverageAdded: refreshCoverage(T, observed),
        telemetry: recalibrateTelemetry(T, observed?.spans),
      },
      calibration: observed ? psi4Calibration(report, observed) : null,
    };
    if (!observed) return record({ ...fields, finalStatus: 'Escalated', reason: 'observe-failed', error: observeError });
    return record({ ...fields, finalStatus: 'Success' });
  }
}
