import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readdir, readFile } from 'node:fs/promises';
import { simulate, classify } from '../src/engine/index.js';
import { makeTarget } from './helpers.js';

test('simulate returns a Safe report and leaves the target untouched', async () => {
  const target = await makeTarget();
  const before = [await readdir(target), await readFile(`${target}/index.js`, 'utf8')];
  const report = await simulate({ target, diff: 'diff --git a/x b/x\n' });
  assert.equal(report.classification, 'Safe');
  assert.deepEqual([await readdir(target), await readFile(`${target}/index.js`, 'utf8')], before);
});

test('classify maps failures to Revise/Abort', () => {
  const r = (passed, severity) => ({ id: 'psi1', passed, severity, evidence: [] });
  assert.equal(classify([r(true, 'none')]), 'Safe');
  assert.equal(classify([r(false, 'low')]), 'Revise');
  assert.equal(classify([r(false, 'critical')]), 'Abort');
});
