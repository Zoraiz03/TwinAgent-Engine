import { test } from 'node:test';
import assert from 'node:assert/strict';
import { lstat, mkdtemp, readlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { adapters, getAdapter, pickAdapter } from '../src/adapters/index.js';
import { nodeNpmAdapter } from '../src/adapters/node-npm.js';
import { FIXTURE, makeTarget, tmpBase } from './helpers.js';

test('registry picks node-npm for an npm project and throws otherwise', async () => {
  assert.ok(adapters.includes(nodeNpmAdapter));
  assert.equal(pickAdapter(FIXTURE), nodeNpmAdapter);
  assert.equal(getAdapter('node-npm'), nodeNpmAdapter);
  assert.throws(() => pickAdapter(tmpdir()), /No adapter/);
});

test('manifestFiles lists the npm manifests', () => {
  assert.deepEqual(nodeNpmAdapter.manifestFiles(), ['package.json', 'package-lock.json', 'npm-shrinkwrap.json']);
});

test('testCommand reads the test script and detects the framework', async () => {
  assert.deepEqual(nodeNpmAdapter.testCommand(FIXTURE), { cmd: 'npm', args: ['test'], cwd: FIXTURE, framework: 'node:test' });
  const dir = await mkdtemp(join(await tmpBase(), 'p-'));
  await writeFile(join(dir, 'package.json'), JSON.stringify({ scripts: { test: 'vitest run' }, devDependencies: { vitest: '^1' } }));
  assert.equal(nodeNpmAdapter.testCommand(dir).framework, 'vitest');
  await writeFile(join(dir, 'package.json'), JSON.stringify({ scripts: { test: 'jest' }, devDependencies: { jest: '^29' } }));
  assert.equal(nodeNpmAdapter.testCommand(dir).framework, 'jest');
  await writeFile(join(dir, 'package.json'), JSON.stringify({ scripts: { test: 'mocha' }, devDependencies: { mocha: '^10' } }));
  assert.equal(nodeNpmAdapter.testCommand(dir).framework, 'mocha');
  await writeFile(join(dir, 'package.json'), JSON.stringify({ scripts: { test: 'echo "Error: no test specified" && exit 1' } }));
  assert.equal(nodeNpmAdapter.testCommand(dir), null);
  await writeFile(join(dir, 'package.json'), JSON.stringify({ scripts: { test: 'node --test test/' } }));
  assert.equal(nodeNpmAdapter.testCommand(dir).framework, 'node:test');
});

test('prepare symlinks node_modules without a manifest change', async () => {
  const target = await makeTarget({ nodeModules: true });
  const clone = await mkdtemp(join(await tmpBase(), 'c-'));
  const r = await nodeNpmAdapter.prepare(clone, { targetPath: target, touchesManifest: false, installTimeoutMs: 1000 });
  assert.equal(r.strategy, 'symlink');
  assert.ok((await lstat(join(clone, 'node_modules'))).isSymbolicLink());
  assert.match(await readlink(join(clone, 'node_modules')), /target\/node_modules$/);
});
