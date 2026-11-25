import { test } from 'node:test';
import assert from 'node:assert/strict';
import { validateReport, CheckResultSchema } from '../src/engine/schema.js';

const ok = (id) => ({ id, passed: true, severity: 'none', evidence: [] });

test('schema accepts a valid report and rejects an invalid one', () => {
  const report = { psi1: ok('psi1'), psi2: ok('psi2'), psi3: ok('psi3'), psi4: ok('psi4'), classification: 'Safe', latencyMs: 1 };
  assert.deepEqual(validateReport(report), report);
  assert.throws(() => validateReport({ ...report, classification: 'Maybe' }));
  assert.equal(CheckResultSchema.safeParse({ id: 'psi9' }).success, false);
});
