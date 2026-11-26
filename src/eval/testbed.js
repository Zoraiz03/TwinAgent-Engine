/**
 * Testbed description read from an optional `twinagent.json` at the target
 * root: { probes: [{ name, cmd, args?, psi?, timeoutMs?, expectStdout? }] }.
 * Probes are runtime checks (e.g. a CLI smoke run) that stand in for
 * production signals no test can see; RealSystem.observe() runs them.
 */
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';

export async function loadTestbed(dir) {
  try {
    const json = JSON.parse(await readFile(join(dir, 'twinagent.json'), 'utf8'));
    return { probes: Array.isArray(json.probes) ? json.probes : [] };
  } catch {
    return { probes: [] };
  }
}
