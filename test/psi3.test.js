import { test } from 'node:test';
import assert from 'node:assert/strict';
import { simulate } from '../src/engine/index.js';
import { CLEAN_DIFF, listDir, makeDiff, makeTarget, tmpBase } from './helpers.js';

const sim = async (target, diff, config) => {
  const tmpRoot = await tmpBase();
  const report = await simulate({ target, diff, tmpRoot, config });
  assert.deepEqual(await listDir(tmpRoot), []);
  return report;
};
const kinds = (r) => r.psi3.evidence.filter((e) => e.severity).map((e) => [e.kind, e.severity]);
const greet = (extra) => `${extra}export function greet(name) {\n  return \`hello \${name}\`;\n}\n`;

test('importing a package that is not declared fails psi3 as high', async () => {
  const target = await makeTarget({ git: true });
  const diff = await makeDiff(target, { 'src/greet.js': greet("import pad from 'left-padz-xyz';\n") });
  const report = await sim(target, diff);
  assert.deepEqual(kinds(report), [['undeclared-package', 'high']]);
  assert.equal(report.psi3.severity, 'high');
  assert.equal(report.classification, 'Abort');
});

test('node builtins and declared packages are fine', async () => {
  const target = await makeTarget({ git: true });
  const diff = await makeDiff(target, { 'src/greet.js': greet("import { join } from 'node:path';\nimport fs from 'fs/promises';\nexport const _ = [join, fs];\n") });
  assert.equal((await sim(target, diff)).psi3.passed, true);
});

test('importing a relative file that does not exist fails psi3', async () => {
  const target = await makeTarget({ git: true });
  const diff = await makeDiff(target, { 'src/greet.js': greet("import './nope.js';\n") });
  const report = await sim(target, diff);
  assert.deepEqual(kinds(report), [['unresolved-import', 'medium']]);
});

test('a new circular import fails psi3 (medium -> Revise)', async () => {
  const target = await makeTarget({ git: true });
  const diff = await makeDiff(target, {
    'src/math.js': "import './greet.js';\nexport function add(a, b) {\n  return a + b;\n}\n",
    'src/greet.js': greet("import './math.js';\n"),
  });
  const report = await sim(target, diff);
  assert.deepEqual(kinds(report), [['new-cycle', 'medium']]);
  assert.deepEqual(report.psi3.evidence.find((e) => e.kind === 'new-cycle').files, ['src/greet.js', 'src/math.js']);
  assert.equal(report.psi1.passed, true);
  assert.equal(report.classification, 'Revise');
});

test('a cycle that already exists at baseline is not charged', async () => {
  const files = {
    'src/a.js': "import './b.js';\nexport const a = 1;\n",
    'src/b.js': "import './a.js';\nexport const b = 1;\n",
  };
  const target = await makeTarget({ git: true, files });
  const diff = await makeDiff(target, { 'src/a.js': "import './b.js';\nexport const a = 2;\n" });
  const report = await sim(target, diff);
  assert.equal(report.psi3.passed, true);
  assert.equal(report.classification, 'Safe');
});

test('a pre-existing unresolved import and pre-existing npm ls problems are not charged', async () => {
  const pkg = JSON.stringify({ name: 'sample-app', version: '1.0.0', type: 'module', scripts: { test: 'node --test' }, dependencies: { ghost: '^1.0.0' } }, null, 2) + '\n';
  const files = { 'package.json': pkg, 'src/greet.js': greet("import './old-gone.js';\n") };
  const target = await makeTarget({ git: true, files });
  const diff = await makeDiff(target, { 'src/math.js': 'export function add(a, b) {\n  return a + b + 0;\n}\n' });
  const report = await sim(target, diff);
  assert.equal(report.psi3.passed, true, JSON.stringify(report.psi3.evidence));
});

test('dropping a required manifest field is flagged', async () => {
  const target = await makeTarget({ git: true });
  const pkg = JSON.stringify({ name: 'sample-app', type: 'module', scripts: { test: 'node --test' } }, null, 2) + '\n';
  const report = await sim(target, await makeDiff(target, { 'package.json': pkg }));
  assert.equal(report.psi3.evidence.some((e) => e.kind === 'manifest-invalid' && /version/.test(e.detail)), true);
  assert.equal(report.psi3.severity, 'high');
});

test('clean diff passes psi3 with no failing evidence', async () => {
  const report = await sim(await makeTarget({ git: true }), CLEAN_DIFF);
  assert.deepEqual(kinds(report), []);
});
