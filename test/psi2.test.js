import { test } from 'node:test';
import assert from 'node:assert/strict';
import { chmod, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { simulate } from '../src/engine/index.js';
import { CLEAN_DIFF, hasSemgrep, listDir, makeDiff, makeTarget, semgrepVersionOnPath, tmpBase } from './helpers.js';

const real = { skip: hasSemgrep ? false : 'semgrep binary not installed' };
const NO_SEMGREP = '/nonexistent/semgrep';

const sim = async (target, diff, config) => {
  const tmpRoot = await tmpBase();
  const report = await simulate({ target, diff, tmpRoot, config });
  assert.deepEqual(await listDir(tmpRoot), []);
  return report;
};
const failing = (r) => r.psi2.evidence.filter((e) => e.severity).map((e) => [e.kind, e.severity]);
const withGreet = (body) => `export function greet(name) {\n  return \`hello \${name}\`;\n}\n${body}`;

// ---- real semgrep ----
test('eval(userInput) fails psi2 as high', real, async () => {
  const target = await makeTarget({ git: true });
  const diff = await makeDiff(target, { 'src/greet.js': withGreet('export function run(userInput) {\n  return eval(userInput);\n}\n') });
  const report = await sim(target, diff);
  assert.equal(report.psi2.passed, false);
  assert.equal(report.psi2.severity, 'high');
  const e = report.psi2.evidence.find((x) => x.kind === 'semgrep-finding');
  assert.equal(e.ruleId, 'twinagent.js.eval');
  assert.match(e.cwe, /CWE-95/);
  assert.deepEqual(e.files, ['src/greet.js']);
  assert.equal(report.classification, 'Abort');
});

test('a hardcoded API key fails psi2', real, async () => {
  const target = await makeTarget({ git: true });
  const key = 'a1b2c3d4' + 'e5f6a7b8' + 'c9d0e1f2'; // built at runtime so no secret-looking literal is committed
  const diff = await makeDiff(target, { 'src/greet.js': withGreet(`const apiKey = "${key}";\nexport const k = apiKey;\n`) });
  const report = await sim(target, diff);
  assert.equal(report.psi2.passed, false);
  assert.equal(report.psi2.evidence.find((x) => x.kind === 'semgrep-finding').ruleId, 'twinagent.js.hardcoded-secret');
});

test('a pre-existing eval is not charged, and moving it does not make it new', real, async () => {
  const legacy = 'export function legacy(x) {\n  return eval(x);\n}\n';
  const target = await makeTarget({ git: true, files: { 'src/legacy.js': legacy } });
  const edited = await sim(target, await makeDiff(target, { 'src/legacy.js': legacy + 'export const note = 1;\n' }));
  assert.equal(edited.psi2.passed, true, JSON.stringify(edited.psi2.evidence));
  const moved = 'export const a = 1;\nexport const b = 2;\n\nexport function legacy(x) {\n  return   eval(x);\n}\n';
  const report = await sim(target, await makeDiff(target, { 'src/legacy.js': moved }));
  assert.equal(report.psi2.passed, true, JSON.stringify(report.psi2.evidence));
  assert.equal(report.classification, 'Safe');
});

test('a second identical eval in the same file is new', real, async () => {
  const legacy = 'export function legacy(x) {\n  return eval(x);\n}\n';
  const target = await makeTarget({ git: true, files: { 'src/legacy.js': legacy } });
  const report = await sim(target, await makeDiff(target, { 'src/legacy.js': legacy + legacy.replace('legacy', 'again') }));
  assert.equal(report.psi2.passed, false);
});

test('clean diff passes psi2 and records the semgrep version', real, async () => {
  const report = await sim(await makeTarget({ git: true }), CLEAN_DIFF);
  assert.equal(report.psi2.passed, true, JSON.stringify(report.psi2.evidence));
  assert.equal(report.psi2.inconclusive, false);
  assert.equal(report.psi2.tool.semgrepVersion, semgrepVersionOnPath);
  assert.equal(report.classification, 'Safe');
});

test('the shipped rules do not flag safe code', real, async () => {
  const safe = withGreet("import { exec } from 'node:child_process';\nexport function ok(db, el) {\n  exec('ls -la');\n  el.innerHTML = '<b>x</b>';\n  return db.query('SELECT 1 WHERE id = $1', [1]);\n}\n");
  const target = await makeTarget({ git: true });
  const report = await sim(target, await makeDiff(target, { 'src/greet.js': safe }));
  assert.equal(report.psi2.passed, true, JSON.stringify(report.psi2.evidence));
});

// ---- semgrep missing / fake binary (always run) ----
test('missing semgrep gives passed + inconclusive, never a crash', async () => {
  const report = await sim(await makeTarget({ git: true }), CLEAN_DIFF, { security: { semgrepPath: NO_SEMGREP } });
  assert.equal(report.psi2.passed, true);
  assert.equal(report.psi2.inconclusive, true);
  assert.equal(report.psi2.evidence[0].kind, 'semgrep-unavailable');
  assert.equal(report.psi2.tool.semgrepVersion, null);
  assert.equal(report.classification, 'Safe');
});

async function fakeSemgrep() {
  const bin = join(await tmpBase(), 'semgrep');
  await writeFile(bin, `#!/usr/bin/env node
const fs = require('fs');
const args = process.argv.slice(2);
if (args[0] === '--version') { console.log('9.9.9-fake'); process.exit(0); }
const results = [];
for (const f of args.filter((a) => a.startsWith('./'))) {
  const text = fs.readFileSync(f, 'utf8');
  const i = text.indexOf('eval(');
  if (i < 0) continue;
  const end = i + text.slice(i).indexOf(')') + 1;
  const line = text.slice(0, i).split('\\n').length;
  results.push({ check_id: 'fake.eval', path: f, start: { line, col: 1, offset: i }, end: { line, col: 2, offset: end },
    extra: { message: 'fake eval', severity: 'ERROR', metadata: { cwe: ['CWE-95'] } } });
}
console.log(JSON.stringify({ results, errors: [] }));
`);
  await chmod(bin, 0o755);
  return bin;
}

test('tool version is recorded and baseline/fingerprint logic works with a fake semgrep', async () => {
  const semgrepPath = await fakeSemgrep();
  const legacy = 'export function legacy(x) {\n  return eval(x);\n}\n';
  const target = await makeTarget({ git: true, files: { 'src/legacy.js': legacy } });
  const config = { security: { semgrepPath } };

  const moved = await sim(target, await makeDiff(target, { 'src/legacy.js': '// header\n\n' + legacy }), config);
  assert.equal(moved.psi2.tool.semgrepVersion, '9.9.9-fake');
  assert.equal(moved.psi2.passed, true, JSON.stringify(moved.psi2.evidence));
  assert.equal(moved.psi2.inconclusive, false);

  const added = await sim(target, await makeDiff(target, { 'src/greet.js': withGreet('export const f = (u) => eval(u);\n') }), config);
  assert.equal(added.psi2.passed, false);
  assert.deepEqual(failing(added), [['semgrep-finding', 'high']]);
  assert.equal(added.psi2.evidence.find((e) => e.kind === 'semgrep-finding').ruleId, 'fake.eval');
});

// ---- dependency advisories ----
async function advisoryDb(advisories) {
  const path = join(await tmpBase(), 'advisories.json');
  await writeFile(path, JSON.stringify(advisories));
  return path;
}
const pkgJson = (deps, extra = {}) => JSON.stringify({ name: 'sample-app', version: '1.0.0', type: 'module', scripts: { test: 'node --test' }, ...extra, dependencies: deps }, null, 2) + '\n';
const adv = (advisoryId, pkg, severity, version) => ({ advisoryId, package: pkg, severity, title: `${pkg} issue`, versions: [version] });

test('fixture provider: a new advisory introduced by the diff fails; baseline advisories are not charged', async () => {
  const vulnFixture = await advisoryDb([adv('ADV-OLD', 'old-lib', 'high', '2.0.0'), adv('ADV-NEW', 'new-lib', 'critical', '1.0.0')]);
  const config = { security: { semgrepPath: NO_SEMGREP, vulnProvider: 'fixture', vulnFixture } };
  const target = await makeTarget({ git: true, files: { 'package.json': pkgJson({ 'old-lib': '2.0.0' }) } });

  const report = await sim(target, await makeDiff(target, { 'package.json': pkgJson({ 'old-lib': '2.0.0', 'new-lib': '1.0.0' }) }), config);
  assert.equal(report.psi2.passed, false);
  assert.deepEqual(report.psi2.evidence.filter((e) => e.advisoryId).map((e) => [e.advisoryId, e.severity]), [['ADV-NEW', 'high']]);
  assert.equal(report.psi2.tool.vulnProvider, 'fixture');
  assert.equal(report.classification, 'Abort');

  const same = await sim(target, await makeDiff(target, { 'package.json': pkgJson({ 'old-lib': '2.0.0' }, { description: 'x' }) }), config);
  assert.equal(same.psi2.passed, true, JSON.stringify(same.psi2.evidence));
  assert.equal(same.psi2.evidence.some((e) => e.advisoryId), false);
});

test('advisory severity mapping: moderate -> medium; low only fails with failOnLow', async () => {
  const target = await makeTarget({ git: true });
  const withDep = await makeDiff(target, { 'package.json': pkgJson({ 'mod-lib': '1.0.0', 'low-lib': '1.0.0' }) });
  const vulnFixture = await advisoryDb([adv('ADV-MOD', 'mod-lib', 'moderate', '1.0.0'), adv('ADV-LOW', 'low-lib', 'low', '1.0.0')]);
  const base = { semgrepPath: NO_SEMGREP, vulnProvider: 'fixture', vulnFixture };

  const r1 = await sim(target, withDep, { security: base });
  assert.deepEqual(r1.psi2.evidence.filter((e) => e.advisoryId).map((e) => [e.advisoryId, e.severity ?? null]), [['ADV-MOD', 'medium'], ['ADV-LOW', null]]);
  assert.equal(r1.psi2.severity, 'medium'); // (overall classification is Abort here: psi3 flags the out-of-sync lockfile install)

  const lowOnly = await advisoryDb([adv('ADV-LOW', 'low-lib', 'low', '1.0.0')]);
  assert.equal((await sim(target, withDep, { security: { ...base, vulnFixture: lowOnly } })).psi2.passed, true);
  const strict = await sim(target, withDep, { security: { ...base, vulnFixture: lowOnly, failOnLow: true } });
  assert.deepEqual(failing(strict), [['vulnerable-dependency', 'low']]);
});

test('dependency scan only runs when a manifest changes', async () => {
  const vulnFixture = await advisoryDb([adv('ADV-X', 'sample-app', 'critical', '1.0.0')]);
  const report = await sim(await makeTarget({ git: true }), CLEAN_DIFF, { security: { semgrepPath: NO_SEMGREP, vulnProvider: 'fixture', vulnFixture } });
  assert.equal(report.psi2.evidence.some((e) => e.advisoryId), false);
  assert.match(report.psi2.evidence.find((e) => e.kind === 'summary').detail, /skipped/);
});

test('an unavailable or unknown vuln provider is inconclusive', async () => {
  const target = await makeTarget({ git: true });
  const diff = await makeDiff(target, { 'package.json': pkgJson({}, { description: 'x' }) });
  for (const security of [{ vulnProvider: 'fixture' }, { vulnProvider: 'no-such-provider' }, { vulnProvider: 'osv-scanner', osvScannerPath: '/nonexistent/osv' }]) {
    const report = await sim(target, diff, { security: { semgrepPath: NO_SEMGREP, ...security } });
    assert.equal(report.psi2.passed, true, security.vulnProvider);
    assert.equal(report.psi2.inconclusive, true);
    assert.equal(report.psi2.evidence.some((e) => e.kind === 'vuln-provider-unavailable'), true, security.vulnProvider);
  }
});

test('osv-scanner provider parses the JSON report (fake binary)', async () => {
  const bin = join(await tmpBase(), 'osv-scanner');
  await writeFile(bin, `#!/usr/bin/env node
const fs = require('fs');
const bad = fs.readFileSync('package.json', 'utf8').includes('new-lib');
const vulns = bad ? [{ id: 'GHSA-new', summary: 'bad', database_specific: { severity: 'HIGH' } }] : [];
console.log(JSON.stringify({ results: [{ packages: [{ package: { name: 'new-lib', version: '1.0.0' }, vulnerabilities: vulns, groups: [] }] }] }));
`);
  await chmod(bin, 0o755);
  const target = await makeTarget({ git: true });
  const diff = await makeDiff(target, { 'package.json': pkgJson({ 'new-lib': '1.0.0' }) });
  const report = await sim(target, diff, { security: { semgrepPath: NO_SEMGREP, vulnProvider: 'osv-scanner', osvScannerPath: bin } });
  assert.deepEqual(report.psi2.evidence.filter((e) => e.advisoryId).map((e) => [e.advisoryId, e.severity]), [['GHSA-new', 'high']]);
});
