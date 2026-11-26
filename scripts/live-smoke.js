#!/usr/bin/env node
/**
 * Live smoke test against a REAL LLM provider. Not part of `npm test`: it
 * spends money and needs network access.
 *
 *   TWINAGENT_PROVIDER=anthropic [TWINAGENT_MODEL=...] node scripts/live-smoke.js --yes
 *
 * Needs the provider package installed (npm i @ai-sdk/<provider>) and the
 * provider's standard API-key env var (e.g. ANTHROPIC_API_KEY); keys are read
 * only inside src/llm. Copies test/fixtures/sample-app to a temp dir, runs one
 * tiny task through the full loop (simulate -> commit -> observe), and prints
 * the ActionRecord. The run log goes to the temp dir, not the repo.
 */
import { cp, mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createAgent } from '../src/agent/index.js';
import { API_KEY_ENV, createGenerate } from '../src/llm/index.js';
import { RealSystem, run } from '../src/loop/index.js';

const DEFAULT_MODELS = { anthropic: 'claude-sonnet-5-5', openai: 'gpt-5', google: 'gemini-2.5-pro' };
const TASK = 'Add an exported function subtract(a, b) to src/math.js that returns a - b, and a node:test test for it in test/math.test.js.';

if (!process.argv.includes('--yes')) {
  console.error('live-smoke calls a paid LLM API. Re-run with --yes to confirm.');
  process.exit(2);
}
const provider = process.env.TWINAGENT_PROVIDER;
if (!provider) {
  console.error(`Set TWINAGENT_PROVIDER (one of: ${Object.keys(API_KEY_ENV).join(', ')}).`);
  process.exit(2);
}
const model = process.env.TWINAGENT_MODEL ?? DEFAULT_MODELS[provider];
if (!model) {
  console.error(`Set TWINAGENT_MODEL for provider "${provider}".`);
  process.exit(2);
}

const work = await mkdtemp(join(tmpdir(), 'twinagent-live-'));
try {
  const dir = join(work, 'sample-app');
  await cp(fileURLToPath(new URL('../test/fixtures/sample-app', import.meta.url)), dir, { recursive: true });
  const realSystem = await RealSystem.init(dir, { tmpRoot: work });
  const agent = createAgent({ generate: createGenerate({ llm: { provider, model } }) });
  const out = await run(TASK, { agent, realSystem, logPath: join(work, 'actions.jsonl'), tmpRoot: work });
  console.log(JSON.stringify({ status: out.status, reason: out.reason ?? null, error: out.error ?? null, records: out.records }, null, 2));
  process.exitCode = out.status === 'Success' ? 0 : 1;
} finally {
  await rm(work, { recursive: true, force: true });
}
