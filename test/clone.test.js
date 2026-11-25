import { test } from 'node:test';
import assert from 'node:assert/strict';
import { stat } from 'node:fs/promises';
import { createClone } from '../src/engine/clone.js';
import { FIXTURE, listDir, makeTarget, tmpBase, worktrees } from './helpers.js';

test('git target gets a detached worktree that dispose() fully removes', async () => {
  const target = await makeTarget({ git: true, nodeModules: true });
  const tmpRoot = await tmpBase();
  const c = await createClone(target, { tmpRoot });
  assert.equal(c.kind, 'worktree');
  assert.equal(worktrees(target).length, 2);
  await stat(`${c.dir}/src/math.js`);
  await assert.rejects(stat(`${c.dir}/node_modules`));
  await c.dispose();
  await c.dispose(); // idempotent
  assert.equal(worktrees(target).length, 1);
  assert.deepEqual(await listDir(tmpRoot), []);
});

test('non-git target gets a filtered copy (no node_modules)', async () => {
  const target = await makeTarget({ nodeModules: true });
  const tmpRoot = await tmpBase();
  const c = await createClone(target, { tmpRoot });
  assert.equal(c.kind, 'copy');
  await stat(`${c.dir}/src/greet.js`);
  await assert.rejects(stat(`${c.dir}/node_modules`));
  await c.dispose();
  assert.deepEqual(await listDir(tmpRoot), []);
});

test('a subdirectory of a repo (not its toplevel) falls back to a copy', async () => {
  const c = await createClone(FIXTURE, { tmpRoot: await tmpBase() });
  assert.equal(c.kind, 'copy');
  await c.dispose();
});

test('non-directory target throws and leaves no temp dir', async () => {
  const tmpRoot = await tmpBase();
  await assert.rejects(createClone(`${FIXTURE}/package.json`, { tmpRoot }), /not a directory/);
  assert.deepEqual(await listDir(tmpRoot), []);
});
