import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { writeFile } from 'node:fs/promises';
import { promisify } from 'node:util';
import { validateReport } from '../src/engine/schema.js';
import { makeTarget } from './helpers.js';

const run = promisify(execFile);
const CLI = new URL('../bin/twinagent.js', import.meta.url).pathname;

test('CLI simulate prints a valid report JSON end to end', async () => {
  const target = await makeTarget();
  await writeFile(`${target}/../twin.diff`, 'diff --git a/x b/x\n');
  const { stdout } = await run('node', [CLI, 'simulate', '--target', target, '--diff', `${target}/../twin.diff`]);
  assert.equal(validateReport(JSON.parse(stdout)).classification, 'Safe');
});

test('CLI without args exits non-zero', async () => {
  await assert.rejects(run('node', [CLI]), (e) => e.code === 2);
});
