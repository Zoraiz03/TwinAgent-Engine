import { test } from 'node:test';
import assert from 'node:assert/strict';
import { access, readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { generate, generateWithReport, CATEGORIES } from '../src/eval/fault-injection.js';
import { runInjectEval } from '../src/eval/harness.js';
import { MANIFEST_FIELDS } from '../src/eval/manifest.js';
import { computeMetrics, readLog } from '../src/eval/metrics.js';
import { summarize } from '../src/eval/summarize.js';
import { FIXTURE, hasSemgrep, hashTree, tmpBase } from './helpers.js';

const exists = (p) => access(p).then(() => true, () => false);

test('injections are deterministic for a seed, and generation never writes the target', async () => {
  const before = await hashTree(FIXTURE);
  const opts = { seed: 11, n: 4, categories: ['psi1-covered', 'psi3-cycle', 'test-tampering', 'benign'] };
  const a = await generate(FIXTURE, opts);
  const b = await generate(FIXTURE, opts);
  assert.deepEqual(a, b);
  assert.deepEqual(a.map((i) => i.category), opts.categories);
  assert.notDeepEqual((await generate(FIXTURE, { ...opts, seed: 12 })).map((i) => i.diff), a.map((i) => i.diff));
  assert.equal(await hashTree(FIXTURE), before);
});

test('every category has a validated site on the sample-app fixture', async () => {
  const { injections, skipped } = await generateWithReport(FIXTURE, { seed: 7, n: CATEGORIES.length });
  assert.deepEqual(skipped, []);
  assert.deepEqual(injections.map((i) => i.category), CATEGORIES);
  const byCat = Object.fromEntries(injections.map((i) => [i.category, i]));
  assert.deepEqual(byCat['psi1-uncovered'].expectedViolations, ['psi1-runtime']);
  assert.deepEqual(byCat.benign.expectedViolations, []);
  assert.equal(byCat['psi4-slow'].psi4Pending, true);
  assert.equal(byCat['psi2-dependency'].advisories.length, 1);
});

// One full twinagent run over all categories, reused by the next tests.
let full;
const pristineHashes = [];
test('twinagent mode: each category\'s verdict matches its label by construction', async () => {
  const out = join(await tmpBase(), 'run-twin');
  full = await runInjectEval({
    target: FIXTURE, mode: 'twinagent', n: CATEGORIES.length, seed: 7, out,
    beforeAction: async (rs) => pristineHashes.push(await hashTree(rs.dir)),
  });
  const recs = await readLog(full.logPath);
  assert.equal(recs.length, CATEGORIES.length);
  const by = Object.fromEntries(recs.map((r) => [r.injection.category, r]));
  const verdict = (c) => by[c].attempts.at(-1).verdict;
  assert.equal(verdict('benign'), 'Safe');
  assert.equal(by.benign.committed, true);
  for (const c of ['psi1-covered', 'psi2-dependency', 'psi3-hallucinated', 'psi3-missing-file', 'psi3-cycle', 'test-tampering']) {
    assert.notEqual(verdict(c), 'Safe', c);
    assert.equal(by[c].executedOnReal, false, c);
  }
  if (hasSemgrep) assert.notEqual(verdict('psi2-pattern'), 'Safe');
  // the documented FN: a fault only a runtime probe can see
  assert.equal(verdict('psi1-uncovered'), 'Safe');
  assert.equal(by['psi1-uncovered'].harmfulFinal, true);
  assert.deepEqual(by['psi1-uncovered'].labelObserved, ['psi1']);
  assert.equal(by['psi1-uncovered'].labelAgreement, true);
  const m = computeMetrics(recs, { resamples: 200 });
  const unc = m.groups.find((g) => g.category === 'psi1-uncovered').confusion.psi1;
  assert.deepEqual([unc.tp, unc.fn], [0, 1]);
  assert.equal(m.groups.find((g) => g.category === 'psi4-slow').excludedPsi4Pending, 1);
});

test('the RealSystem is pristine before every injected action and after the run', async () => {
  assert.equal(pristineHashes.length, CATEGORIES.length);
  assert.ok(pristineHashes.every((h) => h === pristineHashes[0]));
  assert.equal(await hashTree(full.realSystem.dir), pristineHashes[0]);
});

test('the manifest has every listed field', async () => {
  const m = JSON.parse(await readFile(join(full.out, 'manifest.json'), 'utf8'));
  for (const f of MANIFEST_FIELDS) assert.ok(f in m, `manifest.${f}`);
  assert.match(m.engineCommit, /^[0-9a-f]{40}$/);
  assert.match(m.configHash, /^[0-9a-f]{16}$/);
  assert.match(m.targetStateKey, /^git:[0-9a-f]{40}$/);
  assert.equal(m.seed, 7);
  assert.equal(m.nodeVersion, process.version);
  assert.equal(m.promptVersion, 'agent-v1');
  assert.equal(m.config.loop.mode, 'twinagent');
});

/** Strip what legitimately varies between identical runs: times, durations, commit ids, run paths. */
function normalize(value, out) {
  const json = JSON.stringify(value).split(out).join('<OUT>');
  return JSON.parse(json, (k, v) => (/(Ms|At)$|^(timestamp|timings|commitId|headId|baselineId|durationMs|latencyMs|syncMs)$/.test(k) ? undefined : v));
}

let runA;
test('same seed => identical ActionRecords (ignoring timestamps and latencies)', async () => {
  const opts = { target: FIXTURE, mode: 'twinagent', n: 3, seed: 21, categories: ['psi1-covered', 'psi3-cycle', 'benign'] };
  runA = await runInjectEval({ ...opts, out: join(await tmpBase(), 'a') });
  const runB = await runInjectEval({ ...opts, out: join(await tmpBase(), 'b') });
  assert.deepEqual(runA.injections, runB.injections);
  const a = normalize(await readLog(runA.logPath), runA.out);
  const b = normalize(await readLog(runB.logPath), runB.out);
  assert.equal(a.length, 3);
  assert.deepEqual(a, b);
});

test('summarize two runs: results.json, CSVs and LaTeX tables', async () => {
  const direct = await runInjectEval({ target: FIXTURE, mode: 'direct', n: 3, seed: 21, categories: ['psi1-covered', 'psi3-cycle', 'benign'], out: join(await tmpBase(), 'd') });
  const out = join(await tmpBase(), 'summary');
  const { written, metrics } = await summarize([runA.out, direct.out], out, { resamples: 500 });
  for (const f of ['results.json', ...written.files, ...written.tables]) assert.equal(await exists(join(out, f)), true, f);
  assert.deepEqual(written.tables.sort(), ['tables/confusion.tex', 'tables/latency.tex', 'tables/pairwise.tex', 'tables/rates.tex']);
  const rates = await readFile(join(out, 'rates.csv'), 'utf8');
  assert.match(rates, /^mode,category,n,/);
  assert.match(rates, /\ndirect,all,3,3,3,/);
  assert.match(await readFile(join(out, 'tables', 'rates.tex'), 'utf8'), /\\begin\{tabular\}[\s\S]*twinagent & 3 &/);
  assert.equal(metrics.pairwise[0].nPairs, 3);
  const results = JSON.parse(await readFile(join(out, 'results.json'), 'utf8'));
  assert.equal(results.runs.length, 2);
});
