import { test } from 'node:test';
import assert from 'node:assert/strict';
import { resolveModel, complete } from '../src/llm/index.js';

test('llm interface exposes complete and fails clearly on a missing provider', async () => {
  assert.equal(typeof complete, 'function');
  await assert.rejects(resolveModel({ provider: 'no-such-provider', model: 'x' }), /not installed/);
});
