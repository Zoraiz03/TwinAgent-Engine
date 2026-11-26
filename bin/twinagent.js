#!/usr/bin/env node
/**
 * CLI entry.
 *   twinagent simulate --target <path> --diff <file>
 *   twinagent eval inject --target <path> --mode <mode> --n <int> --seed <int> --out <dir> [--categories a,b]
 *   twinagent eval agent --target <path> --tasks <dir> --mode <mode> --out <dir> --yes [--provider p --model m]
 *   twinagent eval summarize <runDir...> --out <dir> [--resamples n] [--seed n]
 * Modes: twinagent | direct | reactive | static.
 */
import { readFile } from 'node:fs/promises';
import { parseArgs } from 'node:util';
import { simulate, loadConfig } from '../src/engine/index.js';

const USAGE = `Usage:
  twinagent simulate --target <path> --diff <file>
  twinagent eval inject --target <path> --mode <mode> --n <int> --seed <int> --out <dir> [--categories a,b]
  twinagent eval agent --target <path> --tasks <dir> --mode <mode> --out <dir> --yes [--provider <p>] [--model <m>]
  twinagent eval summarize <runDir...> --out <dir> [--resamples <int>] [--seed <int>]
modes: twinagent | direct | reactive | static`;

const OPTIONS = {
  target: { type: 'string' }, diff: { type: 'string' }, mode: { type: 'string' }, n: { type: 'string' },
  seed: { type: 'string' }, out: { type: 'string' }, categories: { type: 'string' }, tasks: { type: 'string' },
  yes: { type: 'boolean' }, provider: { type: 'string' }, model: { type: 'string' }, resamples: { type: 'string' },
};
const MODES = ['twinagent', 'direct', 'reactive', 'static'];
const int = (v, name) => {
  const n = Number(v);
  if (!Number.isInteger(n)) throw new Error(`--${name} must be an integer`);
  return n;
};
const fail = (msg) => { console.error(`${msg}\n\n${USAGE}`); return 2; };

async function main(argv) {
  const { positionals, values } = parseArgs({ args: argv, allowPositionals: true, options: OPTIONS });
  const [cmd, sub, ...rest] = positionals;

  if (cmd === 'simulate') {
    if (!values.target || !values.diff) return fail('simulate needs --target and --diff');
    const report = await simulate({ target: values.target, diff: await readFile(values.diff, 'utf8') });
    console.log(JSON.stringify(report, null, 2));
    return 0;
  }
  if (cmd !== 'eval') return fail('unknown command');

  if (sub === 'inject') {
    if (!values.target || !values.out || values.n === undefined || values.seed === undefined) return fail('eval inject needs --target, --n, --seed and --out');
    const mode = values.mode ?? 'twinagent';
    if (!MODES.includes(mode)) return fail(`unknown mode "${mode}"`);
    const { runInjectEval } = await import('../src/eval/harness.js');
    const r = await runInjectEval({
      target: values.target, mode, n: int(values.n, 'n'), seed: int(values.seed, 'seed'), out: values.out,
      categories: values.categories ? values.categories.split(',').map((s) => s.trim()).filter(Boolean) : undefined,
    });
    console.log(JSON.stringify({ out: r.out, actions: r.injections.length, skipped: r.skipped, log: r.logPath }, null, 2));
    return 0;
  }

  if (sub === 'agent') {
    if (!values.target || !values.tasks || !values.out) return fail('eval agent needs --target, --tasks and --out');
    if (!values.yes) return fail('eval agent calls a paid LLM API; re-run with --yes to confirm');
    const mode = values.mode ?? 'twinagent';
    if (!MODES.includes(mode)) return fail(`unknown mode "${mode}"`);
    const cfg = await loadConfig();
    const llm = { provider: values.provider ?? cfg.llm.provider, model: values.model ?? cfg.llm.model };
    const { createGenerate } = await import('../src/llm/index.js');
    const { runAgentEval } = await import('../src/eval/harness.js');
    const r = await runAgentEval({ target: values.target, tasksDir: values.tasks, mode, out: values.out, generate: createGenerate({ llm }), modelId: `${llm.provider}:${llm.model}` });
    console.log(JSON.stringify({ out: r.out, tasks: r.outcomes.length, log: r.logPath }, null, 2));
    return 0;
  }

  if (sub === 'summarize') {
    if (!rest.length || !values.out) return fail('eval summarize needs at least one run dir and --out');
    const { summarize } = await import('../src/eval/summarize.js');
    const { written } = await summarize(rest, values.out, {
      resamples: values.resamples ? int(values.resamples, 'resamples') : undefined,
      seed: values.seed ? int(values.seed, 'seed') : 1,
    });
    console.log(JSON.stringify({ out: values.out, files: ['results.json', ...written.files, ...written.tables] }, null, 2));
    return 0;
  }
  return fail('unknown eval subcommand');
}

main(process.argv.slice(2)).then(
  (code) => { process.exitCode = code; },
  (err) => { console.error(err.message); process.exitCode = 1; },
);
