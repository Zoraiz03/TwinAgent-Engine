import { test } from 'node:test';
import assert from 'node:assert/strict';
import { MockLanguageModelV4 } from 'ai/test';
import { z } from 'zod';
import { complete, createGenerate, resolveModel } from '../src/llm/index.js';

const mockModel = (text) => new MockLanguageModelV4({
  doGenerate: async () => ({
    content: [{ type: 'text', text }],
    finishReason: { unified: 'stop', raw: undefined },
    usage: { inputTokens: { total: 12, noCache: 12 }, outputTokens: { total: 7, text: 7 } },
    warnings: [],
  }),
});

test('createGenerate returns structured output and usage via the AI SDK (mock model, no network)', async () => {
  const generate = createGenerate({ model: mockModel('{"rationale":"r","diff":"d"}') });
  const out = await generate({ system: 's', prompt: 'p', schema: z.object({ rationale: z.string(), diff: z.string() }) });
  assert.deepEqual(out.object, { rationale: 'r', diff: 'd' });
  assert.deepEqual(out.usage, { inputTokens: 12, outputTokens: 7 });
});

test('createGenerate hands back raw text instead of throwing when output does not match the schema', async () => {
  const generate = createGenerate({ model: mockModel('not json at all') });
  const out = await generate({ system: 's', prompt: 'p', schema: z.object({ diff: z.string() }) });
  assert.equal(out.object, undefined);
  assert.equal(out.text, 'not json at all');
  assert.equal(await complete('hi', { model: mockModel('hello') }), 'hello');
});

test('a missing provider package fails clearly', async () => {
  await assert.rejects(resolveModel({ provider: 'no-such-provider', model: 'x' }), /not installed/);
});
