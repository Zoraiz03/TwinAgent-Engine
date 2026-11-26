import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { simulate } from '../src/engine/index.js';
import { CLEAN_DIFF, listDir, makeDiff, makeTarget, tmpBase } from './helpers.js';

const sim = async (target, diff, config) => {
  const tmpRoot = await tmpBase();
  const report = await simulate({ target, diff, tmpRoot, config });
  assert.deepEqual(await listDir(tmpRoot), [], 'baseline and clone dirs are cleaned up');
  return report;
};
const summary = (r) => r.psi1.evidence.find((e) => e.kind === 'test-summary').data;
const sleep = (ms) => new Promise((res) => setTimeout(res, ms));

test('clean diff: psi1 and psi3 pass and the report is Safe', async () => {
  const report = await sim(await makeTarget({ git: true }), CLEAN_DIFF);
  assert.equal(report.psi1.passed, true);
  assert.equal(report.psi3.passed, true);
  assert.equal(report.classification, 'Safe');
  assert.equal(summary(report).baselineTests.length, 3);
  assert.equal(summary(report).regressions.length, 0);
});

test('breaking a covered function fails psi1 on the right test; a direct import is high -> Abort', async () => {
  const target = await makeTarget({ git: true });
  const diff = await makeDiff(target, { 'src/math.js': 'export function add(a, b) {\n  return a - b;\n}\n' });
  const report = await sim(target, diff);
  assert.equal(report.psi1.passed, false);
  assert.deepEqual(summary(report).regressions.map((r) => [r.id, r.reason, r.severity]), [['test/math.test.js::add', 'failed', 'high']]);
  assert.equal(report.classification, 'Abort');
});

test('a regression in a test that only reaches the change indirectly is medium -> Revise', async () => {
  const target = await makeTarget({ git: true });
  const diff = await makeDiff(target, { 'src/format.js': 'export function shout(s) {\n  return s;\n}\n' });
  const report = await sim(target, diff);
  assert.deepEqual(summary(report).regressions.map((r) => [r.file, r.severity]), [['test/app.test.js', 'medium']]);
  assert.equal(report.psi1.severity, 'medium');
  assert.equal(report.classification, 'Revise');
});

test('a test already failing at baseline is not charged', async () => {
  const bad = "import { test } from 'node:test';\ntest('known bad', () => { throw new Error('old'); });\n";
  const target = await makeTarget({ git: true, files: { 'test/known-bad.test.js': bad } });
  const report = await sim(target, CLEAN_DIFF);
  assert.equal(summary(report).baselineTests.some((t) => t.status === 'fail'), true);
  assert.equal(report.psi1.passed, true);
  assert.equal(summary(report).regressions.length, 0);
  assert.equal(report.classification, 'Safe');
});

test('a new failing test is reported but does not fail psi1 by itself', async () => {
  const target = await makeTarget({ git: true });
  const bad = "import { test } from 'node:test';\ntest('fresh', () => { throw new Error('nope'); });\n";
  const report = await sim(target, await makeDiff(target, { 'test/fresh.test.js': bad }));
  assert.equal(report.psi1.passed, true);
  const e = report.psi1.evidence.find((x) => x.kind === 'new-test-failing');
  assert.equal(e.data.id, 'test/fresh.test.js::fresh');
  assert.equal(report.classification, 'Safe');
});

test('an infinite loop times out, fails psi1 as high, and the process tree is killed', async () => {
  const target = await makeTarget({ git: true });
  const pidFile = join(await tmpBase(), 'pid');
  const loop = `import { writeFileSync } from 'node:fs';\nexport function add(a, b) {\n  writeFileSync(${JSON.stringify(pidFile)}, String(process.pid));\n  while (true) {}\n}\n`;
  const diff = await makeDiff(target, { 'src/math.js': loop });
  const report = await sim(target, diff, { tests: { timeoutMs: 4000 } });
  assert.equal(report.psi1.passed, false);
  assert.equal(report.psi1.severity, 'high');
  assert.equal(report.psi1.evidence.some((e) => e.kind === 'timeout'), true);
  assert.equal(summary(report).regressions.every((r) => r.reason === 'timed-out'), true);
  assert.equal(report.classification, 'Abort');
  const pid = Number(await readFile(pidFile, 'utf8'));
  let alive = true;
  for (let i = 0; i < 20 && alive; i++) {
    try { process.kill(pid, 0); await sleep(100); } catch { alive = false; }
  }
  assert.equal(alive, false, 'looping test process is dead');
});

test('no tests in the target: passed but inconclusive', async () => {
  const pkg = JSON.stringify({ name: 'sample-app', version: '1.0.0', type: 'module' }, null, 2) + '\n';
  const target = await makeTarget({
    git: true,
    files: { 'package.json': pkg, 'test/math.test.js': null, 'test/greet.test.js': null, 'test/app.test.js': null },
  });
  const report = await sim(target, CLEAN_DIFF);
  assert.equal(report.psi1.passed, true);
  assert.equal(report.psi1.inconclusive, true);
  assert.equal(report.psi1.evidence[0].kind, 'no-tests-found');
  assert.equal(report.classification, 'Safe');
});

test('test subprocesses never see secrets from the parent environment', async () => {
  const probe = "import { test } from 'node:test';\nimport assert from 'node:assert/strict';\ntest('probe', () => assert.equal(process.env.TWIN_SECRET_TOKEN, undefined));\n";
  const target = await makeTarget({ git: true });
  const diff = await makeDiff(target, { 'test/probe.test.js': probe });
  process.env.TWIN_SECRET_TOKEN = 'hunter2';
  try {
    const hidden = await sim(target, diff);
    assert.equal(summary(hidden).afterTests.find((t) => t.id === 'test/probe.test.js::probe').status, 'pass');
    const allowed = await sim(target, diff, { env: { allow: ['TWIN_SECRET_TOKEN'] } });
    assert.equal(summary(allowed).afterTests.find((t) => t.id === 'test/probe.test.js::probe').status, 'fail');
  } finally {
    delete process.env.TWIN_SECRET_TOKEN;
  }
});

// ---- skipped tests and test tampering ----
const kinds = (r) => r.psi1.evidence.filter((e) => e.severity).map((e) => e.kind).sort();
const mathTest = (body) => `import { test } from 'node:test';\nimport assert from 'node:assert/strict';\nimport { add } from '../src/math.js';\n\n${body}`;
const TWO = mathTest("test('add', () => assert.equal(add(1, 2), 3));\ntest('add zero', () => assert.equal(add(0, 0), 0));\n");

test('adding .skip to a passing test fails psi1 (tampering + skipped)', async () => {
  const target = await makeTarget({ git: true });
  const diff = await makeDiff(target, { 'test/math.test.js': mathTest("test.skip('add', () => assert.equal(add(1, 2), 3));\n") });
  const report = await sim(target, diff);
  assert.equal(report.psi1.passed, false);
  assert.deepEqual(kinds(report), ['test-skipped', 'test-tampering']);
  assert.equal(report.psi1.evidence.find((e) => e.kind === 'test-skipped').severity, 'medium');
  assert.equal(report.psi1.evidence.find((e) => e.kind === 'test-tampering').severity, 'high');
  assert.equal(report.classification, 'Abort');
});

test('deleting a test file fails psi1', async () => {
  const target = await makeTarget({ git: true });
  const report = await sim(target, await makeDiff(target, { 'test/greet.test.js': null }));
  assert.equal(report.psi1.passed, false);
  assert.match(report.psi1.evidence.find((e) => e.kind === 'test-tampering').detail, /test file deleted: test\/greet\.test\.js/);
});

test('removing one test() from a file fails psi1', async () => {
  const target = await makeTarget({ git: true, files: { 'test/math.test.js': TWO } });
  const one = mathTest("test('add', () => assert.equal(add(1, 2), 3));\n");
  const report = await sim(target, await makeDiff(target, { 'test/math.test.js': one }));
  assert.equal(report.psi1.passed, false);
  assert.match(report.psi1.evidence.find((e) => e.kind === 'test-tampering').detail, /1 test case\(s\) removed/);
});

test('a test that was already skipped at baseline is not charged', async () => {
  const target = await makeTarget({ git: true, files: { 'test/math.test.js': mathTest("test('add', () => assert.equal(add(1, 2), 3));\ntest.skip('later', () => {});\n") } });
  const report = await sim(target, CLEAN_DIFF);
  assert.equal(summary(report).baselineTests.some((t) => t.status === 'skip'), true);
  assert.equal(report.psi1.passed, true);
  assert.deepEqual(kinds(report), []);
});

test('with tamperingDetection off only runner-based evidence applies', async () => {
  const target = await makeTarget({ git: true });
  const diff = await makeDiff(target, { 'test/math.test.js': mathTest("test.skip('add', () => assert.equal(add(1, 2), 3));\n") });
  const report = await sim(target, diff, { tests: { tamperingDetection: false } });
  assert.deepEqual(kinds(report), ['test-skipped']);
  const relaxed = await sim(target, diff, { tests: { tamperingDetection: false, skipIsRegression: false } });
  assert.equal(relaxed.psi1.passed, true);
});

test('skipping tests that are outside test files is not tampering', async () => {
  const target = await makeTarget({ git: true });
  const diff = await makeDiff(target, { 'src/math.js': 'export function add(a, b) {\n  return [a].concat(b).skip?.(0) ?? a + b;\n}\n' });
  assert.equal((await sim(target, diff)).psi1.evidence.some((e) => e.kind === 'test-tampering'), false);
});
