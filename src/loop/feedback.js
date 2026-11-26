/**
 * Feedback and calibration (the loop's last step after a committed action).
 *
 * deltaCR: predicted (simulated report) vs observed (RealSystem.observe) per
 * psi. "Positive" means "predicted violation": TP = predicted and observed
 * violation, TN = neither, FP = predicted only, FN = observed only;
 * "inconclusive" when either side is inconclusive or missing.
 *
 * Twin updates named in the paper (kept deliberately simple):
 *   - refreshCoverage: record observed test -> module edges (tests that passed
 *     in the observed full run, joined with the twin's "tests" edges);
 *   - recalibrateTelemetry: feed spans from observe() into the twin;
 *   - psi4 calibration: store (predicted, observed) pairs only, for later
 *     regression-coefficient fitting.
 * Records are appended as JSONL (config eval.logPath, default
 * ./runs/<timestamp>/actions.jsonl), schema-validated, with secret-looking
 * environment values redacted.
 */
import { appendFile, mkdir } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { ActionRecordSchema } from './record.js';

const PSIS = ['psi1', 'psi2', 'psi3', 'psi4'];

/**
 * @param {any} predicted  consequence report of the committed attempt
 * @param {any} observed   observation report (or null)
 */
export function deltaCR(predicted, observed) {
  const out = {};
  for (const id of PSIS) {
    const p = predicted?.[id];
    const o = observed?.[id];
    const predictedPass = p ? p.passed : null;
    const observedPass = o ? o.passed : null;
    if (!p || !o || p.inconclusive || o.inconclusive) {
      out[id] = { predictedPass, observedPass, agree: predictedPass === observedPass, errorType: 'inconclusive' };
      continue;
    }
    const pv = !p.passed;
    const ov = !o.passed;
    out[id] = { predictedPass, observedPass, agree: pv === ov, errorType: pv ? (ov ? 'TP' : 'FP') : (ov ? 'FN' : 'TN') };
  }
  return out;
}

/** Record test -> module pairs seen passing in the observed full run. Returns newly added pairs. */
export function refreshCoverage(twin, observed) {
  if (!twin || !observed?.psi1) return [];
  const summary = observed.psi1.evidence.find((e) => e.kind === 'test-summary')?.data;
  const passingFiles = new Set((summary?.afterTests ?? []).filter((t) => t.status === 'pass').map((t) => t.file));
  const added = [];
  const now = new Date().toISOString();
  for (const e of twin.edges.values()) {
    if (e.type !== 'tests' || !passingFiles.has(e.from)) continue;
    const entry = (twin.coverage[e.from] ??= { modules: [], lastObservedPassAt: null });
    entry.lastObservedPassAt = now;
    if (!entry.modules.includes(e.to)) {
      entry.modules.push(e.to);
      entry.modules.sort();
      added.push({ test: e.from, module: e.to });
    }
  }
  return added;
}

/** Telemetry recalibration hook: ingest spans observed after the commit. */
export function recalibrateTelemetry(twin, spans) {
  if (!twin || !spans?.length) return { matched: 0, unmatched: 0 };
  return twin.ingestTelemetry(spans);
}

/** psi4 calibration pair (stored only; coefficients are fitted later). */
export function psi4Calibration(predicted, observed) {
  const pick = (c) => (c ? { passed: c.passed, severity: c.severity, inconclusive: c.inconclusive ?? false } : null);
  return { psi4: { predicted: pick(predicted?.psi4), observed: pick(observed?.psi4) } };
}

const SECRET_NAME = /(KEY|TOKEN|SECRET|PASSWORD|PASSWD|CREDENTIAL|AUTH)/i;

/** Replace values of secret-looking env vars (name matches, value >= 6 chars) in text. */
export function redact(text, env = process.env) {
  let out = text;
  for (const [name, value] of Object.entries(env)) {
    if (value && value.length >= 6 && SECRET_NAME.test(name)) out = out.split(value).join('[REDACTED]');
  }
  return out;
}

/** ./runs/<timestamp>/actions.jsonl relative to the working directory. */
export function defaultLogPath(now = new Date()) {
  return join(process.cwd(), 'runs', now.toISOString().replace(/[:.]/g, '-'), 'actions.jsonl');
}

/** Validate and append one ActionRecord as a JSONL line. */
export async function appendRecord(logPath, record) {
  ActionRecordSchema.parse(record);
  await mkdir(dirname(logPath), { recursive: true });
  await appendFile(logPath, `${redact(JSON.stringify(record))}\n`);
}
