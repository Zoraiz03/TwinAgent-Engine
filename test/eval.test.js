import { test } from 'node:test';
import assert from 'node:assert/strict';
import { faultInjection, baselines, metrics } from '../src/eval/index.js';

test('eval modules are placeholders', () => {
  for (const m of [faultInjection, baselines, metrics]) assert.equal(m.status, 'placeholder');
});
