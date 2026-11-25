#!/usr/bin/env node
/**
 * CLI entry: `twinagent simulate --target <path> --diff <file>`.
 * Reads the diff, runs the consequence simulation on an isolated clone of the
 * target, and prints the consequence report as JSON to stdout.
 */
import { readFile } from 'node:fs/promises';
import { parseArgs } from 'node:util';
import { simulate } from '../src/engine/index.js';

const USAGE = 'Usage: twinagent simulate --target <path> --diff <file>';

async function main(argv) {
  const { positionals, values } = parseArgs({
    args: argv,
    allowPositionals: true,
    options: { target: { type: 'string' }, diff: { type: 'string' } },
  });
  if (positionals[0] !== 'simulate' || !values.target || !values.diff) {
    console.error(USAGE);
    return 2;
  }
  const diff = await readFile(values.diff, 'utf8');
  const report = await simulate({ target: values.target, diff });
  console.log(JSON.stringify(report, null, 2));
  return 0;
}

main(process.argv.slice(2)).then(
  (code) => { process.exitCode = code; },
  (err) => { console.error(err.message); process.exitCode = 1; },
);
