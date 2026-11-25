import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { access, appendFile, mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { simulate } from '../src/engine/index.js';
import { scrubbedEnv } from '../src/engine/env.js';
import { listDir, makeDiff, makeTarget, tmpBase, MANIFEST_DIFF, hashTree } from './helpers.js';

const exists = (p) => access(p).then(() => true, () => false);

test('scrubbedEnv passes only PATH, HOME, NODE_ENV, CI and the allowlist', () => {
  const source = { PATH: '/bin', HOME: '/real', API_KEY: 'k', TOKEN: 't', KEEP: 'yes' };
  assert.deepEqual(scrubbedEnv({ home: '/tmp/h', allow: ['KEEP', 'MISSING', 'HOME'], source }), {
    PATH: '/bin', HOME: '/tmp/h', NODE_ENV: 'test', CI: 'true', KEEP: 'yes',
  });
});

test('install scripts are ignored by default and run only when install.ignoreScripts is false', async () => {
  const marker = join(await tmpBase(), 'ran-postinstall');
  const scripts = { test: 'node --test', postinstall: `node -e "require('fs').writeFileSync('${marker}','x')"` };
  const pkg = JSON.stringify({ name: 'sample-app', version: '1.0.0', type: 'module', scripts }, null, 2) + '\n';
  const target = await makeTarget({ git: true });
  const diff = await makeDiff(target, { 'package.json': pkg });

  const safe = await simulate({ target, diff, tmpRoot: await tmpBase() });
  assert.equal(safe.install.strategy, 'npm-ci');
  assert.equal(safe.install.ok, true, safe.install.error);
  assert.equal(await exists(marker), false);

  const unsafe = await simulate({ target, diff, tmpRoot: await tmpBase(), config: { install: { ignoreScripts: false } } });
  assert.equal(unsafe.install.ok, true, unsafe.install.error);
  assert.equal(await exists(marker), true);
});

test('a dirty git target is cloned by copy and a diff against the dirty content applies', async () => {
  const target = await makeTarget({ git: true });
  await writeFile(join(target, 'src/math.js'), 'export function add(a, b) {\n  return a + b + 0;\n}\n'); // uncommitted
  await writeFile(join(target, 'src/extra.js'), 'export const extra = 1;\n'); // untracked
  const before = await hashTree(target);
  const diff = await makeDiff(target, { 'src/math.js': 'export function add(a, b) {\n  return a + b + 1 - 1;\n}\n' });
  const tmpRoot = await tmpBase();
  const report = await simulate({ target, diff, tmpRoot });
  assert.equal(report.dirtyTarget, true);
  assert.equal(report.cloneKind, 'copy');
  assert.equal(report.applyResult.applied, true, report.applyResult.error);
  assert.equal(report.classification, 'Safe');
  assert.equal(await hashTree(target), before);
  assert.deepEqual(await listDir(tmpRoot), []);
});

test('the same diff against a clean checkout uses a worktree and is not dirty', async () => {
  const target = await makeTarget({ git: true, nodeModules: true });
  const report = await simulate({ target, diff: MANIFEST_DIFF, tmpRoot: await tmpBase() });
  assert.equal(report.dirtyTarget, false);
  assert.equal(report.cloneKind, 'worktree');
});

test('an untracked file makes the target dirty; an untracked node_modules does not', async () => {
  const diff = 'diff --git a/src/math.js b/src/math.js\n';
  const t1 = await makeTarget({ git: true });
  await appendFile(join(t1, 'README.md'), 'hi\n');
  assert.equal((await simulate({ target: t1, diff, tmpRoot: await tmpBase() })).dirtyTarget, true);

  const t2 = await makeTarget({ git: true });
  const git = (...a) => execFileSync('git', ['-c', 'user.name=t', '-c', 'user.email=t@t', ...a], { cwd: t2 });
  await writeFile(join(t2, '.gitignore'), '');
  git('commit', '-qam', 'stop ignoring node_modules');
  await mkdir(join(t2, 'node_modules/dep'), { recursive: true });
  await writeFile(join(t2, 'node_modules/dep/index.js'), 'x\n');
  assert.match(execFileSync('git', ['status', '--porcelain'], { cwd: t2, encoding: 'utf8' }), /node_modules/);
  assert.equal((await simulate({ target: t2, diff, tmpRoot: await tmpBase() })).dirtyTarget, false);
});
