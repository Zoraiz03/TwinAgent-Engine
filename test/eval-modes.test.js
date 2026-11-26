import { test } from 'node:test';
import assert from 'node:assert/strict';
import { join } from 'node:path';
import { runInjectEval } from '../src/eval/harness.js';
import { readLog } from '../src/eval/metrics.js';
import { FIXTURE, hasSemgrep, hashTree, tmpBase } from './helpers.js';

const CATS = ['psi1-covered', 'psi3-hallucinated'];
async function runMode(mode, categories = CATS) {
  const hashes = [];
  const r = await runInjectEval({ target: FIXTURE, mode, n: categories.length, seed: 5, categories, out: join(await tmpBase(), mode), beforeAction: async (rs) => hashes.push(await hashTree(rs.dir)) });
  const recs = await readLog(r.logPath);
  return { r, hashes, by: Object.fromEntries(recs.map((x) => [x.injection.category, x])) };
}

test('direct commits harmful injections: harmfulFinal', async () => {
  const { by } = await runMode('direct');
  for (const c of CATS) {
    assert.equal(by[c].mode, 'direct');
    assert.equal(by[c].committed, true, c);
    assert.equal(by[c].executedOnReal, true, c);
    assert.equal(by[c].harmfulFinal, true, c);
    assert.equal(by[c].predictedViolations, null);
  }
});

test('reactive executes harmful changes, detects them and rolls back', async () => {
  const { r, by, hashes } = await runMode('reactive');
  for (const c of CATS) {
    assert.equal(by[c].executedOnReal, true, c);
    assert.equal(by[c].harmfulExecuted, true, c);
    assert.equal(by[c].harmfulFinal, false, c);
    assert.equal(by[c].committed, false, c);
    assert.equal(by[c].rollbacks, 1, c);
    assert.equal(by[c].reason, 'retries-exhausted');
  }
  assert.equal(await hashTree(r.realSystem.dir), hashes[0], 'rolled back to pristine');
});

test('static catches the hallucinated import but misses the covered behavior break', async () => {
  const { by } = await runMode('static');
  assert.equal(by['psi3-hallucinated'].attempts[0].verdict, 'Abort');
  assert.equal(by['psi3-hallucinated'].executedOnReal, false);
  assert.ok(by['psi3-hallucinated'].attempts[0].report.psi3.evidence.some((e) => e.kind === 'lint-undeclared-package'));
  assert.equal(by['psi1-covered'].attempts[0].verdict, 'Safe');
  assert.equal(by['psi1-covered'].harmfulFinal, true);
  assert.equal(by['psi1-covered'].attempts[0].report.psi1.inconclusive, true, 'static never runs tests');
});

test('static catches psi2 patterns via Semgrep', { skip: hasSemgrep ? false : 'semgrep binary not installed' }, async () => {
  const { by } = await runMode('static', ['psi2-pattern']);
  assert.notEqual(by['psi2-pattern'].attempts[0].verdict, 'Safe');
  assert.equal(by['psi2-pattern'].executedOnReal, false);
});

test('twinagent catches the covered behavior break before execution', async () => {
  const { by } = await runMode('twinagent');
  for (const c of CATS) {
    assert.notEqual(by[c].attempts[0].verdict, 'Safe', c);
    assert.equal(by[c].executedOnReal, false, c);
    assert.equal(by[c].harmfulExecuted, false, c);
  }
});
