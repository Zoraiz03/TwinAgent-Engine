import { test } from 'node:test';
import assert from 'node:assert/strict';
import { stat } from 'node:fs/promises';
import { getAdapter } from '../src/adapters/index.js';
import { makeTarget } from './helpers.js';

test('adapter clones into a separate temp dir and disposes it', async () => {
  const target = await makeTarget();
  const ad = getAdapter('node');
  const ws = await ad.clone(target);
  assert.notEqual(ws.path, target);
  await stat(`${ws.path}/index.js`);
  assert.equal((await ad.test(ws)).ok, true);
  await ws.dispose();
  await assert.rejects(stat(ws.path));
});
