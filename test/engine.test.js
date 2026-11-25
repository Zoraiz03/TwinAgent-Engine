import { test } from 'node:test';
import assert from 'node:assert/strict';
import { rm, stat } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { simulate, classify } from '../src/engine/index.js';
import { nodeNpmAdapter } from '../src/adapters/node-npm.js';
import {
  ABSOLUTE_DIFF, CLEAN_DIFF, GIT_DIFF, MANIFEST_DIFF, STALE_DIFF, TRAVERSAL_DIFF,
  hashTree, listDir, makeTarget, tmpBase, worktrees,
} from './helpers.js';

for (const git of [true, false]) {
  test(`clean diff applies and the ${git ? 'git' : 'non-git'} target is byte-identical afterwards`, async () => {
    const target = await makeTarget({ git, nodeModules: true });
    const tmpRoot = await tmpBase();
    const before = await hashTree(target);
    const report = await simulate({ target, diff: CLEAN_DIFF, tmpRoot });
    assert.equal(report.classification, 'Safe');
    assert.equal(report.cloneKind, git ? 'worktree' : 'copy');
    assert.deepEqual(
      { ...report.applyResult },
      { applied: true, filesChanged: ['src/math.js'], addedLines: 1, removedLines: 1, touchesManifest: false },
    );
    assert.equal(report.install.strategy, 'symlink');
    assert.deepEqual(Object.keys(report.timings.checks).sort(), ['psi1', 'psi2', 'psi3', 'psi4']);
    assert.ok(report.latencyMs >= report.timings.cloneMs);
    assert.equal(await hashTree(target), before);
    assert.deepEqual(await listDir(tmpRoot), []);
    if (git) assert.equal(worktrees(target).length, 1);
  });
}

test('checks receive cloneDir with the diff applied, adapter and applyResult', async () => {
  const target = await makeTarget();
  let seen;
  const checks = { psi1: { run: async (ctx) => { seen = ctx; return { id: 'psi1', passed: true, severity: 'none', evidence: [] }; } } };
  await simulate({ target, diff: CLEAN_DIFF, tmpRoot: await tmpBase(), checks: { ...checks, ...Object.fromEntries(['psi2', 'psi3', 'psi4'].map((id) => [id, { run: async () => ({ id, passed: true, severity: 'none', evidence: [] }) }])) } });
  assert.equal(seen.adapter, nodeNpmAdapter);
  assert.equal(seen.applyResult.applied, true);
  assert.notEqual(seen.cloneDir, target);
});

test('a diff that does not apply yields Revise with the error and skips checks', async () => {
  const target = await makeTarget({ git: true });
  const tmpRoot = await tmpBase();
  const before = await hashTree(target);
  const report = await simulate({ target, diff: STALE_DIFF, tmpRoot });
  assert.equal(report.classification, 'Revise');
  assert.equal(report.applyResult.applied, false);
  assert.ok(report.applyResult.error.length > 0);
  assert.equal(report.psi1, undefined);
  assert.equal(report.install, undefined);
  assert.equal(await hashTree(target), before);
  assert.deepEqual(await listDir(tmpRoot), []);
});

test('an empty diff is Revise', async () => {
  const report = await simulate({ target: await makeTarget(), diff: '', tmpRoot: await tmpBase() });
  assert.equal(report.classification, 'Revise');
});

for (const [name, diff, reason] of [
  ['path traversal', TRAVERSAL_DIFF, /traversal/],
  ['absolute path', ABSOLUTE_DIFF, /absolute/],
  ['.git modification', GIT_DIFF, /\.git/],
]) {
  test(`unsafe diff (${name}) gives Abort and writes nothing outside the clone`, async () => {
    const target = await makeTarget({ git: true });
    const tmpRoot = await tmpBase();
    const report = await simulate({ target, diff, tmpRoot });
    assert.equal(report.classification, 'Abort');
    assert.equal(report.applyResult.rejected, true);
    assert.match(report.applyResult.error, reason);
    await assert.rejects(stat(join(dirname(tmpRoot), 'evil.txt')));
    await assert.rejects(stat(join(tmpRoot, 'evil.txt')));
    assert.deepEqual(await listDir(tmpRoot), []);
  });
}

test('a diff touching package.json runs npm ci in the clone instead of symlinking', async () => {
  const target = await makeTarget({ git: true, nodeModules: true });
  const tmpRoot = await tmpBase();
  const before = await hashTree(target);
  const report = await simulate({ target, diff: MANIFEST_DIFF, tmpRoot });
  assert.equal(report.applyResult.touchesManifest, true);
  assert.equal(report.install.strategy, 'npm-ci');
  assert.equal(report.install.ok, true, report.install.error);
  assert.equal(report.timings.installMs, report.install.durationMs);
  assert.equal(report.classification, 'Safe');
  assert.equal(await hashTree(target), before);
  assert.deepEqual(await listDir(tmpRoot), []);
});

test('without a lockfile the install path uses npm install', async () => {
  const target = await makeTarget();
  await rm(join(target, 'package-lock.json'));
  const report = await simulate({ target, diff: MANIFEST_DIFF, tmpRoot: await tmpBase() });
  assert.equal(report.install.strategy, 'npm-install');
  assert.equal(report.install.ok, true, report.install.error);
});

test('install timeout is recorded as a failure, gives Revise, and cleans up', async () => {
  const target = await makeTarget({ git: true });
  const tmpRoot = await tmpBase();
  const report = await simulate({ target, diff: MANIFEST_DIFF, tmpRoot, config: { install: { timeoutMs: 1 } } });
  assert.equal(report.install.ok, false);
  assert.match(report.install.error, /timed out/);
  assert.equal(report.classification, 'Revise');
  assert.deepEqual(await listDir(tmpRoot), []);
  assert.equal(worktrees(target).length, 1);
});

test('clone is removed when a check or the adapter throws', async () => {
  const target = await makeTarget({ git: true });
  const tmpRoot = await tmpBase();
  const boom = { run: async () => { throw new Error('check boom'); } };
  await assert.rejects(simulate({ target, diff: CLEAN_DIFF, tmpRoot, checks: { psi1: boom } }), /check boom/);
  assert.deepEqual(await listDir(tmpRoot), []);
  assert.equal(worktrees(target).length, 1);

  const adapter = { ...nodeNpmAdapter, prepare: async () => { throw new Error('prepare boom'); } };
  await assert.rejects(simulate({ target, diff: CLEAN_DIFF, tmpRoot, adapter }), /prepare boom/);
  assert.deepEqual(await listDir(tmpRoot), []);
  assert.equal(worktrees(target).length, 1);
});

test('classify maps failures to Revise/Abort', () => {
  const r = (passed, severity) => ({ id: 'psi1', passed, severity, evidence: [] });
  assert.equal(classify([r(true, 'none')]), 'Safe');
  assert.equal(classify([r(false, 'low')]), 'Revise');
  assert.equal(classify([r(false, 'critical')]), 'Abort');
});
