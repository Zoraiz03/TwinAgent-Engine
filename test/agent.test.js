import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createAgent, cleanDiff, summarizeReport, PROMPT_VERSION } from '../src/agent/index.js';
import { buildContext, namedFiles } from '../src/agent/context.js';
import { Twin } from '../src/twin/twin.js';
import { nodeNpmAdapter } from '../src/adapters/node-npm.js';
import { CLEAN_DIFF, FIXTURE, scripted } from './helpers.js';

const usage = { inputTokens: 10, outputTokens: 5 };

test('propose returns a validated proposal with usage and prompt version', async () => {
  const { generate, calls } = scripted([{ object: { rationale: 'fix add', diff: '```diff\n' + CLEAN_DIFF + '```' }, usage }]);
  const p = await createAgent({ generate }).propose('make add numeric', 'CTX');
  assert.equal(p.diff, CLEAN_DIFF);
  assert.equal(p.rationale, 'fix add');
  assert.deepEqual(p.usage, usage);
  assert.equal(p.promptVersion, PROMPT_VERSION);
  assert.match(calls[0].prompt, /make add numeric[\s\S]*CTX/);
  assert.ok(calls[0].schema, 'structured output schema is passed to the model');
});

test('JSON in fenced text is accepted', async () => {
  const text = '```json\n' + JSON.stringify({ rationale: 'r', diff: CLEAN_DIFF }) + '\n```';
  const p = await createAgent({ generate: scripted([{ text, usage }]).generate }).propose('t', '');
  assert.equal(p.diff, CLEAN_DIFF);
});

test('one invalid answer triggers a single repair prompt', async () => {
  const { generate, calls } = scripted([{ text: '{"rationale": "r"}', usage }, { object: { rationale: 'r', diff: CLEAN_DIFF }, usage }]);
  const p = await createAgent({ generate }).propose('t', '');
  assert.equal(p.error, undefined);
  assert.equal(calls.length, 2);
  assert.match(calls[1].prompt, /could not be used: invalid structure: diff/);
  assert.deepEqual(p.usage, { inputTokens: 20, outputTokens: 10 });
});

test('invalid twice, a non-diff, or a failing model call returns { error } without throwing', async () => {
  const bad = await createAgent({ generate: scripted([{ text: 'nope', usage }]).generate }).propose('t', '');
  assert.match(bad.error, /invalid model output after one repair attempt/);
  const notDiff = await createAgent({ generate: scripted([{ object: { rationale: 'r', diff: 'just change it' } }]).generate }).propose('t', '');
  assert.match(notDiff.error, /not a unified diff/);
  const boom = await createAgent({ generate: scripted([new Error('network down')]).generate }).propose('t', '');
  assert.match(boom.error, /llm call failed: network down/);
});

test('cleanDiff accepts git diffs (including pure renames) and rejects prose', () => {
  assert.equal(cleanDiff(CLEAN_DIFF), CLEAN_DIFF);
  assert.ok(cleanDiff('diff --git a/x b/y\nsimilarity index 100%\nrename from x\nrename to y\n'));
  assert.throws(() => cleanDiff('please edit math.js'), /not a unified diff/);
});

const REPORT = {
  classification: 'Revise',
  applyResult: { applied: true },
  psi1: { passed: false, severity: 'medium', evidence: [
    { kind: 'regression', detail: 'test/app.test.js::x failed (passed at baseline)', files: ['test/app.test.js'], severity: 'medium' },
    { kind: 'test-summary', detail: 'info only', files: [] },
  ] },
  psi2: { passed: true, severity: 'none', evidence: [] },
};

test('reformulate: "report" mode shows failing evidence, "blind" mode does not', async () => {
  const run = async (mode) => {
    const { generate, calls } = scripted([{ object: { rationale: 'r', diff: CLEAN_DIFF }, usage }]);
    await createAgent({ generate }).reformulate('task', { diff: 'PREVIOUS-DIFF' }, REPORT, mode, 'CTX');
    return calls[0].prompt;
  };
  const report = await run('report');
  assert.match(report, /passed at baseline/);
  assert.match(report, /"check": "psi1"/);
  assert.match(report, /PREVIOUS-DIFF/);
  assert.doesNotMatch(report, /info only/);
  const blind = await run('blind');
  assert.match(blind, /REJECTED/);
  assert.match(blind, /PREVIOUS-DIFF/);
  assert.doesNotMatch(blind, /passed at baseline|psi1|regression/);
});

test('summarizeReport includes apply errors', () => {
  const s = JSON.parse(summarizeReport({ classification: 'Revise', applyResult: { applied: false, error: 'patch does not apply' } }));
  assert.equal(s.applyError, 'patch does not apply');
  assert.deepEqual(s.failingChecks, []);
});

test('context: tree, named files and twin import neighbors', async () => {
  const twin = await Twin.build(FIXTURE, nodeNpmAdapter, {});
  const ctx = await buildContext({ dir: FIXTURE, task: 'Change greet.js to say hi', twin, budgetChars: 10_000 });
  assert.deepEqual(ctx.named, ['src/greet.js']);
  assert.deepEqual(ctx.neighbors, ['src/index.js', 'test/greet.test.js']);
  assert.match(ctx.text, /File tree:[\s\S]*src\/math\.js/);
  assert.match(ctx.text, /=== src\/greet\.js \(named in task\) ===\nexport function greet/);
  assert.match(ctx.text, /=== src\/index\.js \(import neighbor\) ===/);
  assert.equal(ctx.truncated, false);
  assert.deepEqual(namedFiles('see src/math.js and package.json', ['package.json', 'src/math.js', 'src/mathx.js']), ['package.json', 'src/math.js']);
});

test('context respects the character budget with truncation markers', async () => {
  const twin = await Twin.build(FIXTURE, nodeNpmAdapter, {});
  const ctx = await buildContext({ dir: FIXTURE, task: 'edit src/greet.js', twin, budgetChars: 260 });
  assert.ok(ctx.text.length <= 260, `length ${ctx.text.length}`);
  assert.equal(ctx.truncated, true);
  assert.match(ctx.text, /\[\.\.\. truncated \d+ chars\]|\[omitted /);
});
