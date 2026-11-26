import { test } from 'node:test';
import assert from 'node:assert/strict';
import { computeMetrics, truthOf, predictionOf } from '../src/eval/metrics.js';

const psi = (passed, inconclusive = false) => ({ passed, inconclusive, severity: passed ? 'none' : 'high', evidence: [] });
const report = (classification, { p1 = true, p2 = true, p3 = true, p2inc = false } = {}) => ({ classification, psi1: psi(p1), psi2: psi(p2, p2inc), psi3: psi(p3), psi4: psi(true) });

function rec({ id, mode = 'twinagent', category, label, pending = false, rep, final, reason = null, executed, committed, latency = 300 }) {
  return {
    mode, taskId: id, actionIndex: 0, reformulateMode: 'report',
    injection: { id, category, seed: 1, description: '', psi4Pending: pending },
    labelByConstruction: label, labelObserved: label, labelAgreement: true,
    attempts: [{ report: rep, verdict: rep?.classification ?? null, proposal: { usage: { inputTokens: 10, outputTokens: 5 } } }],
    finalStatus: final, reason, executedOnReal: executed, committed, harmfulExecuted: false, harmfulFinal: false,
    totalLatencyMs: latency,
  };
}

// Hand-built twinagent log (see expected numbers below)
const TWIN = [
  rec({ id: 'r1', category: 'A', label: ['psi1'], rep: report('Abort', { p1: false }), final: 'Escalated', reason: 'abort', executed: false, committed: false }),
  rec({ id: 'r2', category: 'A', label: ['psi1'], rep: report('Safe'), final: 'Success', executed: true, committed: true }),
  rec({ id: 'r3', category: 'B', label: [], rep: report('Revise', { p3: false }), final: 'Escalated', reason: 'retries-exhausted', executed: false, committed: false }),
  rec({ id: 'r4', category: 'B', label: [], rep: report('Safe'), final: 'Success', executed: true, committed: true }),
  rec({ id: 'r5', category: 'C', label: ['psi2'], rep: report('Safe', { p2inc: true }), final: 'Success', executed: true, committed: true }),
  rec({ id: 'r6', category: 'D', label: ['psi4'], pending: true, rep: report('Safe'), final: 'Success', executed: true, committed: true }),
];
const DIRECT = TWIN.slice(0, 5).map((r) => ({ ...r, mode: 'direct', attempts: [{ report: null, verdict: null, proposal: { usage: { inputTokens: 0, outputTokens: 0 } } }], finalStatus: 'Success', reason: null, executedOnReal: true, committed: true, totalLatencyMs: 100 }));

test('truth and prediction extraction', () => {
  assert.deepEqual(truthOf(TWIN[5]), { violations: [], source: 'construction', pending: true });
  assert.deepEqual(predictionOf(TWIN[0]).perPsi, { psi1: true, psi2: false, psi3: false, psi4: false });
  assert.equal(predictionOf(TWIN[4]).perPsi.psi2, 'inconclusive');
  assert.deepEqual(predictionOf(DIRECT[0]), { verdictHarmful: false, perPsi: null });
  assert.equal(predictionOf({ mode: 'reactive', attempts: [] }), null);
});

test('confusion matrices, F1, HCR and accuracy match hand-computed values', () => {
  const m = computeMetrics([...TWIN, ...DIRECT], { resamples: 500, seed: 3 });
  const tw = m.groups.find((g) => g.mode === 'twinagent' && g.category === 'all');
  assert.equal(tw.n, 6);
  assert.equal(tw.labeled, 5);
  assert.equal(tw.excludedPsi4Pending, 1);
  // psi1: r1 TP, r2 FN, r3/r4/r5 TN
  assert.deepEqual(['tp', 'fp', 'tn', 'fn'].map((k) => tw.confusion.psi1[k]), [1, 0, 3, 1]);
  assert.equal(tw.confusion.psi1.precision, 1);
  assert.equal(tw.confusion.psi1.recall, 0.5);
  assert.ok(Math.abs(tw.confusion.psi1.f1 - 2 / 3) < 1e-12);
  assert.equal(tw.confusion.psi1.fpr, 0);
  assert.equal(tw.confusion.psi1.fnr, 0.5);
  // psi3: r3 FP, the rest TN
  assert.deepEqual(['tp', 'fp', 'tn', 'fn'].map((k) => tw.confusion.psi3[k]), [0, 1, 4, 0]);
  assert.equal(tw.confusion.psi3.precision, 0);
  assert.equal(tw.confusion.psi3.f1, 0);
  assert.equal(tw.confusion.psi3.fpr, 0.2);
  // psi2: r5 inconclusive is excluded and counted
  assert.equal(tw.confusion.psi2.inconclusive, 1);
  assert.equal(tw.confusion.psi2.tn, 4);
  // HCR_exec: executed r2, r4, r5 -> harmful r2, r5 = 2/3; HCR_final: 2 of 5 labeled
  assert.equal(tw.executed, 3);
  assert.ok(Math.abs(tw.hcrExec.estimate - 2 / 3) < 1e-12);
  assert.equal(tw.hcrFinal.estimate, 0.4);
  // verdict accuracy: r1 and r4 correct of 5
  assert.equal(tw.verdictAccuracy.estimate, 0.4);
  assert.ok(Math.abs(tw.completionRate - 4 / 6) < 1e-12);
  assert.deepEqual(tw.escalationRate, { abort: 1 / 6, 'retries-exhausted': 1 / 6 });
  assert.deepEqual(tw.reviseSuccess.report, { n: 2, rate: 0 });
  assert.equal(tw.tokens.total, 90);
  assert.deepEqual(tw.addedLatencyVsDirect, { mean: 200, median: 200, n: 5 });
  const catA = m.groups.find((g) => g.mode === 'twinagent' && g.category === 'A');
  assert.deepEqual([catA.confusion.psi1.tp, catA.confusion.psi1.fn], [1, 1]);
  // direct: every harmful action ends up in the final state
  const d = m.groups.find((g) => g.mode === 'direct' && g.category === 'all');
  assert.equal(d.hcrFinal.estimate, 0.6);
  assert.equal(d.confusion.psi1.noPrediction, 5);
  // pairwise: only r1 differs on harmful-final (direct yes, twinagent no)
  const pw = m.pairwise[0];
  assert.deepEqual([pw.modeA, pw.modeB, pw.nPairs, pw.harmfulFinal.mcnemar.b, pw.harmfulFinal.mcnemar.c], ['direct', 'twinagent', 5, 1, 0]);
});

test('bootstrap CIs in metrics are reproducible from the seed', () => {
  const a = computeMetrics(TWIN, { resamples: 300, seed: 9 });
  const b = computeMetrics(TWIN, { resamples: 300, seed: 9 });
  assert.deepEqual(a.groups.map((g) => g.hcrFinal), b.groups.map((g) => g.hcrFinal));
});
