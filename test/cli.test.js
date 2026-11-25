import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { promisify } from 'node:util';
import { validateReport } from '../src/engine/schema.js';
import { CLEAN_DIFF, makeTarget } from './helpers.js';

const run = promisify(execFile);
const CLI = new URL('../bin/twinagent.js', import.meta.url).pathname;

test('CLI simulate prints a valid report JSON end to end', async () => {
  const target = await makeTarget();
  const diff = join(dirname(target), 'change.diff');
  await writeFile(diff, CLEAN_DIFF);
  const { stdout } = await run('node', [CLI, 'simulate', '--target', target, '--diff', diff]);
  const report = validateReport(JSON.parse(stdout));
  assert.equal(report.classification, 'Safe');
  assert.equal(report.applyResult.applied, true);
});

test('CLI without args exits non-zero', async () => {
  await assert.rejects(run('node', [CLI]), (e) => e.code === 2);
});
