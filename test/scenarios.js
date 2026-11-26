/**
 * Shared psi1 / psi3 scenario table. Every scenario runs in BOTH engine modes
 * ("plain": no twin, the ablation baseline; "twin": checks use T / T'), each
 * mode's report is checked, and the two verdicts (psi1 pass/fail, psi3
 * pass/fail, classification) must be identical.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { simulate } from '../src/engine/index.js';
import { CLEAN_DIFF, listDir, makeDiff, makeTarget, tmpBase } from './helpers.js';

export const MODES = ['plain', 'twin'];
export const summary = (r) => r.psi1.evidence.find((e) => e.kind === 'test-summary').data;
const sleep = (ms) => new Promise((res) => setTimeout(res, ms));
const failingKinds = (check) => check.evidence.filter((e) => e.severity).map((e) => e.kind).sort();
const verdict = (r) => ({ psi1: r.psi1?.passed, psi3: r.psi3?.passed, classification: r.classification });

/** Run a scenario in both modes, check each, and assert identical verdicts. */
export async function runScenario(s) {
  const ctx = await s.setup();
  const reports = {};
  for (const mode of MODES) {
    const tmpRoot = await tmpBase();
    const config = { ...(ctx.config ?? {}), twin: { enabled: mode === 'twin' } };
    const go = () => simulate({ target: ctx.target, diff: ctx.diff, tmpRoot, config });
    const report = s.around ? await s.around(go) : await go();
    assert.equal(report.twinMode, mode);
    assert.deepEqual(await listDir(tmpRoot), [], 'baseline and clone dirs are cleaned up');
    await s.check(report, mode, ctx);
    reports[mode] = report;
  }
  assert.deepEqual(verdict(reports.twin), verdict(reports.plain), 'twin and plain verdicts must match');
}

/** Register a table as node:test tests. */
export function registerScenarios(table) {
  for (const s of table) test(s.name, () => runScenario(s));
}

// ---------------------------------------------------------------- psi1 ----
const mathTest = (body) => `import { test } from 'node:test';\nimport assert from 'node:assert/strict';\nimport { add } from '../src/math.js';\n\n${body}`;
const ADD = "test('add', () => assert.equal(add(1, 2), 3));\n";
const SKIPPED_ADD = "test.skip('add', () => assert.equal(add(1, 2), 3));\n";
const gitTarget = (files) => makeTarget({ git: true, files });

export const psi1Scenarios = [
  {
    name: 'clean diff: psi1 and psi3 pass and the report is Safe',
    setup: async () => ({ target: await gitTarget(), diff: CLEAN_DIFF }),
    check: (r, mode) => {
      assert.equal(r.psi1.passed, true);
      assert.equal(r.psi3.passed, true);
      assert.equal(r.classification, 'Safe');
      // twin selection runs only the test that reaches src/math.js
      assert.equal(summary(r).baselineTests.length, mode === 'twin' ? 1 : 3);
      assert.equal(summary(r).selection.by, mode === 'twin' ? 'twin' : 'runner');
      assert.equal(summary(r).regressions.length, 0);
    },
  },
  {
    name: 'breaking a covered function fails psi1 on the right test; a direct import is high -> Abort',
    setup: async () => {
      const target = await gitTarget();
      return { target, diff: await makeDiff(target, { 'src/math.js': 'export function add(a, b) {\n  return a - b;\n}\n' }) };
    },
    check: (r) => {
      assert.equal(r.psi1.passed, false);
      assert.deepEqual(summary(r).regressions.map((x) => [x.id, x.reason, x.severity]), [['test/math.test.js::add', 'failed', 'high']]);
      assert.equal(r.classification, 'Abort');
    },
  },
  {
    name: 'a regression in a test that only reaches the change indirectly is medium -> Revise',
    setup: async () => {
      const target = await gitTarget();
      return { target, diff: await makeDiff(target, { 'src/format.js': 'export function shout(s) {\n  return s;\n}\n' }) };
    },
    check: (r) => {
      assert.deepEqual(summary(r).regressions.map((x) => [x.file, x.severity]), [['test/app.test.js', 'medium']]);
      assert.equal(r.psi1.severity, 'medium');
      assert.equal(r.classification, 'Revise');
    },
  },
  {
    name: 'a test already failing at baseline is not charged',
    setup: async () => ({
      target: await gitTarget({ 'test/known-bad.test.js': mathTest("test('known bad', () => assert.equal(add(1, 1), 3));\n") }),
      diff: CLEAN_DIFF,
    }),
    check: (r) => {
      assert.equal(summary(r).baselineTests.some((t) => t.status === 'fail'), true);
      assert.equal(r.psi1.passed, true);
      assert.equal(summary(r).regressions.length, 0);
      assert.equal(r.classification, 'Safe');
    },
  },
  {
    name: 'a new failing test is reported but does not fail psi1 by itself',
    setup: async () => {
      const target = await gitTarget();
      const bad = "import { test } from 'node:test';\ntest('fresh', () => { throw new Error('nope'); });\n";
      return { target, diff: await makeDiff(target, { 'test/fresh.test.js': bad }) };
    },
    check: (r) => {
      assert.equal(r.psi1.passed, true);
      assert.equal(r.psi1.evidence.find((x) => x.kind === 'new-test-failing').data.id, 'test/fresh.test.js::fresh');
      assert.equal(r.classification, 'Safe');
    },
  },
  {
    name: 'an infinite loop times out, fails psi1 as high, and the process tree is killed',
    setup: async () => {
      const target = await gitTarget();
      const pidFile = join(await tmpBase(), 'pid');
      const loop = `import { writeFileSync } from 'node:fs';\nexport function add(a, b) {\n  writeFileSync(${JSON.stringify(pidFile)}, String(process.pid));\n  while (true) {}\n}\n`;
      return { target, pidFile, diff: await makeDiff(target, { 'src/math.js': loop }), config: { tests: { timeoutMs: 4000 } } };
    },
    check: async (r, mode, ctx) => {
      assert.equal(r.psi1.passed, false);
      assert.equal(r.psi1.severity, 'high');
      assert.equal(r.psi1.evidence.some((e) => e.kind === 'timeout'), true);
      assert.equal(summary(r).regressions.every((x) => x.reason === 'timed-out'), true);
      assert.equal(r.classification, 'Abort');
      const pid = Number(await readFile(ctx.pidFile, 'utf8'));
      let alive = true;
      for (let i = 0; i < 20 && alive; i++) {
        try { process.kill(pid, 0); await sleep(100); } catch { alive = false; }
      }
      assert.equal(alive, false, 'looping test process is dead');
    },
  },
  {
    name: 'no tests in the target: passed but inconclusive',
    setup: async () => {
      const pkg = JSON.stringify({ name: 'sample-app', version: '1.0.0', type: 'module' }, null, 2) + '\n';
      return {
        target: await gitTarget({ 'package.json': pkg, 'test/math.test.js': null, 'test/greet.test.js': null, 'test/app.test.js': null }),
        diff: CLEAN_DIFF,
      };
    },
    check: (r) => {
      assert.equal(r.psi1.passed, true);
      assert.equal(r.psi1.inconclusive, true);
      assert.equal(r.psi1.evidence[0].kind, 'no-tests-found');
      assert.equal(r.classification, 'Safe');
    },
  },
  ...[[false, 'pass'], [true, 'fail']].map(([allow, status]) => ({
    name: `test subprocesses ${allow ? 'see an allowlisted variable' : 'never see secrets from the parent environment'}`,
    setup: async () => {
      const probe = "import { test } from 'node:test';\nimport assert from 'node:assert/strict';\ntest('probe', () => assert.equal(process.env.TWIN_SECRET_TOKEN, undefined));\n";
      const target = await gitTarget();
      return { target, diff: await makeDiff(target, { 'test/probe.test.js': probe }), config: allow ? { env: { allow: ['TWIN_SECRET_TOKEN'] } } : {} };
    },
    around: async (go) => {
      process.env.TWIN_SECRET_TOKEN = 'hunter2';
      try { return await go(); } finally { delete process.env.TWIN_SECRET_TOKEN; }
    },
    check: (r) => assert.equal(summary(r).afterTests.find((t) => t.id === 'test/probe.test.js::probe').status, status),
  })),
  {
    name: 'adding .skip to a passing test fails psi1 (tampering + skipped)',
    setup: async () => {
      const target = await gitTarget();
      return { target, diff: await makeDiff(target, { 'test/math.test.js': mathTest(SKIPPED_ADD) }) };
    },
    check: (r) => {
      assert.equal(r.psi1.passed, false);
      assert.deepEqual(failingKinds(r.psi1), ['test-skipped', 'test-tampering']);
      assert.equal(r.psi1.evidence.find((e) => e.kind === 'test-skipped').severity, 'medium');
      assert.equal(r.psi1.evidence.find((e) => e.kind === 'test-tampering').severity, 'high');
      assert.equal(r.classification, 'Abort');
    },
  },
  {
    name: 'deleting a test file fails psi1',
    setup: async () => {
      const target = await gitTarget();
      return { target, diff: await makeDiff(target, { 'test/greet.test.js': null }) };
    },
    check: (r) => {
      assert.equal(r.psi1.passed, false);
      const e = r.psi1.evidence.find((x) => x.kind === 'test-tampering');
      assert.match(e.detail, /test file deleted: test\/greet\.test\.js/);
      assert.equal(e.severity, 'high');
      assert.equal(summary(r).regressions.some((x) => x.id === 'test/greet.test.js::greet' && x.reason === 'missing'), true);
    },
  },
  {
    name: 'removing one test() from a file fails psi1 (case drop is medium tampering)',
    setup: async () => {
      const target = await gitTarget({ 'test/math.test.js': mathTest(ADD + "test('add zero', () => assert.equal(add(0, 0), 0));\n") });
      return { target, diff: await makeDiff(target, { 'test/math.test.js': mathTest(ADD) }) };
    },
    check: (r) => {
      assert.equal(r.psi1.passed, false);
      const e = r.psi1.evidence.find((x) => x.kind === 'test-tampering');
      assert.match(e.detail, /1 test case\(s\) removed/);
      assert.equal(e.severity, 'medium');
    },
  },
  {
    name: 'dropping an assertion alone is medium -> Revise; assertionDropSeverity can raise it',
    setup: async () => {
      const two = mathTest("test('add', () => {\n  assert.equal(add(1, 2), 3);\n  assert.equal(add(2, 2), 4);\n});\n");
      const target = await gitTarget({ 'test/math.test.js': two });
      return { target, diff: await makeDiff(target, { 'test/math.test.js': mathTest("test('add', () => {\n  assert.equal(add(1, 2), 3);\n});\n") }) };
    },
    check: async (r, mode, ctx) => {
      assert.deepEqual(failingKinds(r.psi1), ['test-tampering']);
      assert.equal(r.psi1.severity, 'medium');
      assert.equal(r.classification, 'Revise');
      const strict = await simulate({ target: ctx.target, diff: ctx.diff, tmpRoot: await tmpBase(), config: { twin: { enabled: mode === 'twin' }, tests: { assertionDropSeverity: 'high' } } });
      assert.equal(strict.classification, 'Abort');
    },
  },
  {
    name: 'a test that was already skipped at baseline is not charged',
    setup: async () => ({ target: await gitTarget({ 'test/math.test.js': mathTest(ADD + "test.skip('later', () => {});\n") }), diff: CLEAN_DIFF }),
    check: (r) => {
      assert.equal(summary(r).baselineTests.some((t) => t.status === 'skip'), true);
      assert.equal(r.psi1.passed, true);
      assert.deepEqual(failingKinds(r.psi1), []);
    },
  },
  ...[[{ tamperingDetection: false }, ['test-skipped']], [{ tamperingDetection: false, skipIsRegression: false }, []]].map(([tests, kinds]) => ({
    name: `with ${JSON.stringify(tests)} only runner-based evidence applies`,
    setup: async () => {
      const target = await gitTarget();
      return { target, diff: await makeDiff(target, { 'test/math.test.js': mathTest(SKIPPED_ADD) }), config: { tests } };
    },
    check: (r) => {
      assert.deepEqual(failingKinds(r.psi1), kinds);
      assert.equal(r.psi1.passed, kinds.length === 0);
    },
  })),
  {
    name: 'skip-like calls outside test files are not tampering',
    setup: async () => {
      const target = await gitTarget();
      return { target, diff: await makeDiff(target, { 'src/math.js': 'export function add(a, b) {\n  return [a].concat(b).skip?.(0) ?? a + b;\n}\n' }) };
    },
    check: (r) => assert.equal(r.psi1.evidence.some((e) => e.kind === 'test-tampering'), false),
  },
];

// ---------------------------------------------------------------- psi3 ----
const greet = (extra) => `${extra}export function greet(name) {\n  return \`hello \${name}\`;\n}\n`;
const psi3Kinds = (r) => r.psi3.evidence.filter((e) => e.severity).map((e) => [e.kind, e.severity]);
const greetDiff = (extra) => async () => {
  const target = await gitTarget();
  return { target, diff: await makeDiff(target, { 'src/greet.js': greet(extra) }) };
};

export const psi3Scenarios = [
  {
    name: 'importing a package that is not declared fails psi3 as high',
    setup: greetDiff("import pad from 'left-padz-xyz';\n"),
    check: (r) => {
      assert.deepEqual(psi3Kinds(r), [['undeclared-package', 'high']]);
      assert.equal(r.psi3.severity, 'high');
      assert.equal(r.classification, 'Abort');
    },
  },
  {
    name: 'node builtins and declared packages are fine',
    setup: greetDiff("import { join } from 'node:path';\nimport fs from 'fs/promises';\nexport const _ = [join, fs];\n"),
    check: (r) => assert.equal(r.psi3.passed, true),
  },
  {
    name: 'importing a relative file that does not exist fails psi3',
    setup: greetDiff("import './nope.js';\n"),
    check: (r) => assert.deepEqual(psi3Kinds(r), [['unresolved-import', 'medium']]),
  },
  {
    name: 'a new circular import fails psi3 (medium -> Revise)',
    setup: async () => {
      const target = await gitTarget();
      const diff = await makeDiff(target, {
        'src/math.js': "import './greet.js';\nexport function add(a, b) {\n  return a + b;\n}\n",
        'src/greet.js': greet("import './math.js';\n"),
      });
      return { target, diff };
    },
    check: (r) => {
      assert.deepEqual(psi3Kinds(r), [['new-cycle', 'medium']]);
      assert.deepEqual(r.psi3.evidence.find((e) => e.kind === 'new-cycle').files, ['src/greet.js', 'src/math.js']);
      assert.equal(r.psi1.passed, true);
      assert.equal(r.classification, 'Revise');
    },
  },
  {
    name: 'a cycle that already exists at baseline is not charged',
    setup: async () => {
      const target = await gitTarget({ 'src/a.js': "import './b.js';\nexport const a = 1;\n", 'src/b.js': "import './a.js';\nexport const b = 1;\n" });
      return { target, diff: await makeDiff(target, { 'src/a.js': "import './b.js';\nexport const a = 2;\n" }) };
    },
    check: (r) => {
      assert.equal(r.psi3.passed, true);
      assert.equal(r.classification, 'Safe');
    },
  },
  {
    name: 'a pre-existing unresolved import and pre-existing npm ls problems are not charged',
    setup: async () => {
      const pkg = JSON.stringify({ name: 'sample-app', version: '1.0.0', type: 'module', scripts: { test: 'node --test' }, dependencies: { ghost: '^1.0.0' } }, null, 2) + '\n';
      const target = await gitTarget({ 'package.json': pkg, 'src/greet.js': greet("import './old-gone.js';\n") });
      return { target, diff: await makeDiff(target, { 'src/math.js': 'export function add(a, b) {\n  return a + b + 0;\n}\n' }) };
    },
    check: (r) => assert.equal(r.psi3.passed, true, JSON.stringify(r.psi3.evidence)),
  },
  {
    name: 'dropping a required manifest field is flagged',
    setup: async () => {
      const target = await gitTarget();
      const pkg = JSON.stringify({ name: 'sample-app', type: 'module', scripts: { test: 'node --test' } }, null, 2) + '\n';
      return { target, diff: await makeDiff(target, { 'package.json': pkg }) };
    },
    check: (r) => {
      assert.equal(r.psi3.evidence.some((e) => e.kind === 'manifest-invalid' && /version/.test(e.detail)), true);
      assert.equal(r.psi3.severity, 'high');
    },
  },
  {
    name: 'deleting a module that others import is an unresolved import',
    setup: async () => {
      const target = await gitTarget();
      return { target, diff: await makeDiff(target, { 'src/format.js': null }) };
    },
    check: (r) => assert.deepEqual(psi3Kinds(r), [['unresolved-import', 'medium']]),
  },
  {
    name: 'clean diff passes psi3 with no failing evidence',
    setup: async () => ({ target: await gitTarget(), diff: CLEAN_DIFF }),
    check: (r) => assert.deepEqual(psi3Kinds(r), []),
  },
];
