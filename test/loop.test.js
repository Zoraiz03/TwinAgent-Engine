import { test } from 'node:test';
import assert from 'node:assert/strict';
import { access, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { createAgent } from '../src/agent/index.js';
import { checks as realChecks } from '../src/checks/index.js';
import { simulateWithTwin } from '../src/engine/index.js';
import { RealSystem, run } from '../src/loop/index.js';
import { ActionRecordSchema } from '../src/loop/record.js';
import { deltaCR, redact } from '../src/loop/feedback.js';
import { PROMPT_VERSION } from '../src/agent/prompts.js';
import { hashTree, listDir, makeDiff, makeTarget, scripted, tmpBase, TRAVERSAL_DIFF } from './helpers.js';

const NO_SEMGREP = { security: { semgrepPath: '/nonexistent/semgrep' } };
const usage = { inputTokens: 100, outputTokens: 20 };
const answer = (diff, rationale = 'change') => ({ object: { rationale, diff }, usage });
const exists = (p) => access(p).then(() => true, () => false);

async function setup({ files, probes, config = {} } = {}) {
  const dir = await makeTarget({ git: true, files });
  const tmpRoot = await tmpBase();
  const logPath = join(await tmpBase(), 'run', 'actions.jsonl');
  const realSystem = await RealSystem.init(dir, { config: { ...NO_SEMGREP, ...config }, probes, tmpRoot });
  const cfg = { ...NO_SEMGREP, ...config };
  return { dir, tmpRoot, logPath, realSystem, cfg };
}
const goodDiff = (dir, name = 'sub') => makeDiff(dir, { [`src/${name}.js`]: `export const ${name} = (a, b) => a - b;\n` });
const breakAppDiff = (dir) => makeDiff(dir, { 'src/format.js': 'export function shout(s) {\n  return s;\n}\n' }); // medium -> Revise
const logLines = async (p) => (await readFile(p, 'utf8')).trim().split('\n').map((l) => JSON.parse(l));

test('Safe on the first try: committed, twin promoted, observed, deltaCR agrees', async () => {
  const s = await setup();
  const head = await s.realSystem.head();
  const { generate } = scripted([answer(await goodDiff(s.dir))]);
  const out = await run('add a sub function', { agent: createAgent({ generate }), realSystem: s.realSystem, config: s.cfg, logPath: s.logPath, tmpRoot: s.tmpRoot });
  assert.equal(out.status, 'Success');
  const rec = out.records[0];
  assert.equal(rec.committed, true);
  assert.notEqual(await s.realSystem.head(), head);
  assert.equal(await exists(join(s.dir, 'src/sub.js')), true);
  assert.equal(rec.twinUpdates.promoted, true);
  assert.equal(out.twin.nodes.has('src/sub.js'), true, 'T was promoted to T\'');
  assert.equal(rec.observed.classification, 'Safe');
  assert.ok(Object.values(rec.deltaCR).every((d) => d.agree), JSON.stringify(rec.deltaCR));
  assert.equal(rec.deltaCR.psi1.errorType, 'TN');
  assert.equal(rec.deltaCR.psi2.errorType, 'inconclusive'); // no semgrep here, on either side
  assert.deepEqual(rec.twinUpdates.coverageAdded.map((c) => c.test).sort(), ['test/app.test.js', 'test/greet.test.js', 'test/math.test.js']);
  assert.equal(rec.totalTokens, 120);
  assert.equal(rec.promptVersion, PROMPT_VERSION);
  assert.equal(rec.twinMode, 'twin');
  assert.equal((await logLines(s.logPath)).length, 1);
  assert.deepEqual(await listDir(s.tmpRoot), []);
});

for (const mode of ['report', 'blind']) {
  test(`Revise then Safe (${mode} mode): second attempt is committed; prompt ${mode === 'report' ? 'carries' : 'hides'} the evidence`, async () => {
    const s = await setup({ config: { agent: { reformulateMode: mode } } });
    const { generate, calls } = scripted([answer(await breakAppDiff(s.dir)), answer(await goodDiff(s.dir))]);
    const out = await run('tidy formatting', { agent: createAgent({ generate }), realSystem: s.realSystem, config: s.cfg, logPath: s.logPath, tmpRoot: s.tmpRoot });
    assert.equal(out.status, 'Success');
    const rec = out.records[0];
    assert.deepEqual(rec.attempts.map((a) => [a.kind, a.verdict]), [['propose', 'Revise'], ['reformulate', 'Safe']]);
    assert.equal(rec.committed, true);
    const prompt = calls[1].prompt;
    if (mode === 'report') {
      assert.match(prompt, /Consequence report/);
      assert.match(prompt, /test\/app\.test\.js::describe shouts the greeting failed \(passed at baseline\)/);
      assert.match(prompt, /"kind": "regression"/);
    } else {
      assert.match(prompt, /REJECTED\. No further information/);
      assert.doesNotMatch(prompt, /passed at baseline|"kind"|psi1/);
    }
  });
}

test('Revise exhausted after K retries: escalated, nothing committed, RealSystem unchanged', async () => {
  const s = await setup();
  const before = [await hashTree(s.dir), await s.realSystem.head()];
  const { generate, calls } = scripted([answer(await breakAppDiff(s.dir))]);
  const out = await run('t', { agent: createAgent({ generate }), realSystem: s.realSystem, K: 2, config: s.cfg, logPath: s.logPath, tmpRoot: s.tmpRoot });
  assert.equal(out.status, 'Escalated');
  assert.equal(out.reason, 'retries-exhausted');
  assert.equal(out.report.classification, 'Revise');
  assert.equal(out.records[0].attempts.length, 3);
  assert.equal(calls.length, 3);
  assert.equal(out.records[0].committed, false);
  assert.deepEqual([await hashTree(s.dir), await s.realSystem.head()], before);
});

test('Abort (unsafe path diff): escalated immediately, RealSystem unchanged', async () => {
  const s = await setup();
  const before = [await hashTree(s.dir), await s.realSystem.head()];
  const { generate, calls } = scripted([answer(TRAVERSAL_DIFF)]);
  const out = await run('t', { agent: createAgent({ generate }), realSystem: s.realSystem, config: s.cfg, logPath: s.logPath, tmpRoot: s.tmpRoot });
  assert.equal(out.status, 'Escalated');
  assert.equal(out.reason, 'abort');
  assert.equal(out.report.applyResult.rejected, true);
  assert.equal(calls.length, 1);
  assert.deepEqual([await hashTree(s.dir), await s.realSystem.head()], before);
});

test('invalid LLM output twice: escalated with the error, no throw', async () => {
  const s = await setup();
  const { generate, calls } = scripted([{ text: 'I would rather not', usage }]);
  const out = await run('t', { agent: createAgent({ generate }), realSystem: s.realSystem, config: s.cfg, logPath: s.logPath, tmpRoot: s.tmpRoot });
  assert.equal(out.status, 'Escalated');
  assert.equal(out.reason, 'agent-error');
  assert.match(out.error, /invalid model output/);
  assert.equal(calls.length, 2);
  assert.equal(out.records[0].attempts[0].proposal.error, out.error);
});

test('engine errors become escalations, not exceptions', async () => {
  const s = await setup();
  const engine = { simulate: async () => { throw new Error('engine exploded'); } };
  const out = await run('t', { agent: createAgent({ generate: scripted([answer(await goodDiff(s.dir))]).generate }), engine, realSystem: s.realSystem, config: s.cfg, logPath: s.logPath });
  assert.deepEqual([out.status, out.reason, out.error], ['Escalated', 'engine-error', 'engine exploded']);
});

test('a harmful change the checks cannot see is committed and logged as FN', async () => {
  const cli = "import { add } from './math.js';\nconsole.log(add(1, 2));\n";
  const s = await setup({
    files: { 'src/cli.js': cli },
    probes: [{ name: 'cli smoke run', cmd: process.execPath, args: ['src/cli.js'] }],
  });
  // no test executes src/cli.js, so simulation passes; the runtime probe fails after commit
  const diff = await makeDiff(s.dir, { 'src/cli.js': "import { add } from './math.js';\nif (add(1, 2) === 3) throw new Error('boom');\n" });
  const out = await run('t', { agent: createAgent({ generate: scripted([answer(diff)]).generate }), realSystem: s.realSystem, config: s.cfg, logPath: s.logPath, tmpRoot: s.tmpRoot });
  const rec = out.records[0];
  assert.equal(rec.attempts[0].verdict, 'Safe');
  assert.equal(rec.committed, true);
  assert.equal(rec.observed.psi1.passed, false);
  assert.equal(rec.observed.probes[0].passed, false);
  assert.equal(rec.deltaCR.psi1.errorType, 'FN');
  assert.equal(rec.deltaCR.psi1.agree, false);
});

test('a safe change wrongly flagged (non-blocking low-severity finding) is logged as FP', async () => {
  const s = await setup({ config: { engine: { blockingSeverity: 'medium' } } });
  const fakePsi4 = { run: async () => ({ id: 'psi4', passed: false, severity: 'low', evidence: [{ kind: 'fake-perf', detail: 'looks slower', files: [], severity: 'low' }], inconclusive: false }) };
  const engine = { simulate: (o) => simulateWithTwin({ ...o, checks: { ...realChecks, psi4: fakePsi4 } }) };
  const out = await run('t', { agent: createAgent({ generate: scripted([answer(await goodDiff(s.dir))]).generate }), engine, realSystem: s.realSystem, config: s.cfg, logPath: s.logPath, tmpRoot: s.tmpRoot });
  const rec = out.records[0];
  assert.equal(rec.attempts[0].verdict, 'Safe');
  assert.equal(rec.committed, true);
  assert.equal(rec.deltaCR.psi4.errorType, 'FP');
  assert.equal(rec.deltaCR.psi1.errorType, 'TN');
  assert.deepEqual(rec.calibration.psi4.predicted, { passed: false, severity: 'low', inconclusive: false });
});

test('JSONL log: one schema-valid line per action, secrets redacted', async () => {
  const s = await setup();
  process.env.TWIN_TEST_API_KEY = 'sk-test-supersecret-123456';
  try {
    const diffs = [await goodDiff(s.dir, 'sub')];
    const { generate } = scripted([
      answer(diffs[0], `uses ${process.env.TWIN_TEST_API_KEY}`),
      async () => answer(await goodDiff(s.dir, 'mul')), // generated against the committed state
    ]);
    const out = await run('two steps', { agent: createAgent({ generate }), decomposer: () => ['add sub', 'add mul'], realSystem: s.realSystem, config: s.cfg, logPath: s.logPath, tmpRoot: s.tmpRoot });
    assert.equal(out.status, 'Success', out.error);
    const text = await readFile(s.logPath, 'utf8');
    assert.doesNotMatch(text, /supersecret/);
    assert.match(text, /\[REDACTED\]/);
    const lines = await logLines(s.logPath);
    assert.equal(lines.length, 2);
    for (const l of lines) assert.equal(ActionRecordSchema.safeParse(l).success, true);
    assert.deepEqual(lines.map((l) => l.action), ['add sub', 'add mul']);
  } finally {
    delete process.env.TWIN_TEST_API_KEY;
  }
});

test('restore(snapshot) returns the RealSystem to a byte-identical tree', async () => {
  const s = await setup();
  const before = await hashTree(s.dir);
  const snap = await s.realSystem.snapshot();
  assert.equal((await s.realSystem.apply(await goodDiff(s.dir))).ok, true);
  await writeFile(join(s.dir, 'untracked.txt'), 'x');
  assert.notEqual(await hashTree(s.dir), before);
  await s.realSystem.restore(snap);
  assert.equal(await hashTree(s.dir), before);
  assert.equal((await s.realSystem.apply('garbage')).ok, false);
  assert.equal(await hashTree(s.dir), before);
});

test('injected decomposer runs actions in order and stops at the first escalation', async () => {
  const s = await setup();
  const { generate, calls } = scripted([
    answer(await goodDiff(s.dir, 'sub')),
    answer(TRAVERSAL_DIFF),
    answer(await goodDiff(s.dir, 'mul')),
  ]);
  const out = await run('three steps', { agent: createAgent({ generate }), decomposer: () => ['first', 'second', 'third'], realSystem: s.realSystem, config: s.cfg, logPath: s.logPath, tmpRoot: s.tmpRoot });
  assert.equal(out.status, 'Escalated');
  assert.equal(out.reason, 'abort');
  assert.deepEqual(out.records.map((r) => [r.action, r.finalStatus]), [['first', 'Success'], ['second', 'Escalated']]);
  assert.equal(calls.length, 2);
  assert.equal(await exists(join(s.dir, 'src/sub.js')), true);
  assert.equal(await exists(join(s.dir, 'src/mul.js')), false);
});

test('LLM decomposer behind agent.decompose', async () => {
  const s = await setup({ config: { agent: { decompose: true } } });
  const diff = await goodDiff(s.dir);
  const { generate } = scripted([(req) => (req.prompt.includes('independently committable') ? { object: { actions: ['only step'] }, usage } : answer(diff))]);
  const out = await run('big task', { agent: createAgent({ generate }), realSystem: s.realSystem, config: s.cfg, logPath: s.logPath, tmpRoot: s.tmpRoot });
  assert.equal(out.status, 'Success');
  assert.deepEqual(out.records.map((r) => r.action), ['only step']);
});

test('plain mode runs the loop without a twin', async () => {
  const s = await setup({ config: { twin: { enabled: false } } });
  const out = await run('t', { agent: createAgent({ generate: scripted([answer(await goodDiff(s.dir))]).generate }), realSystem: s.realSystem, config: s.cfg, logPath: s.logPath, tmpRoot: s.tmpRoot });
  assert.equal(out.status, 'Success');
  assert.equal(out.records[0].twinMode, 'plain');
  assert.equal(out.records[0].twinUpdates.promoted, false);
  assert.equal(out.twin, null);
});

test('deltaCR and redact units', () => {
  const r = (passed, inconclusive = false) => ({ passed, inconclusive });
  const d = deltaCR({ psi1: r(false), psi2: r(true), psi3: r(false), psi4: r(true, true) }, { psi1: r(false), psi2: r(true), psi3: r(true), psi4: r(true) });
  assert.deepEqual(Object.fromEntries(Object.entries(d).map(([k, v]) => [k, v.errorType])), { psi1: 'TP', psi2: 'TN', psi3: 'FP', psi4: 'inconclusive' });
  assert.equal(redact('key=abcdef123 ok', { MY_TOKEN: 'abcdef123', HOME: '/home/abcdef' }), 'key=[REDACTED] ok');
});
