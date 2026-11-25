import { test } from 'node:test';
import assert from 'node:assert/strict';
import { validateReport, CheckResultSchema } from '../src/engine/schema.js';

const ok = (id) => ({ id, passed: true, severity: 'none', evidence: [] });
const applyResult = { applied: true, filesChanged: [], addedLines: 0, removedLines: 0, touchesManifest: false };
const base = { applyResult, cloneKind: 'copy', classification: 'Safe', latencyMs: 1, timings: { cloneMs: 1, installMs: 0, applyMs: 1, checks: {} } };
const full = { ...base, psi1: ok('psi1'), psi2: ok('psi2'), psi3: ok('psi3'), psi4: ok('psi4') };

test('schema accepts a valid report and rejects an invalid one', () => {
  assert.deepEqual(validateReport(full), full);
  assert.throws(() => validateReport({ ...full, classification: 'Maybe' }));
  assert.equal(CheckResultSchema.safeParse({ id: 'psi9' }).success, false);
});

test('psi results are required only when the diff applied', () => {
  assert.throws(() => validateReport(base), /required when the diff applied/);
  const failed = { ...base, classification: 'Revise', applyResult: { ...applyResult, applied: false, error: 'x' } };
  assert.equal(validateReport(failed).applyResult.error, 'x');
});
