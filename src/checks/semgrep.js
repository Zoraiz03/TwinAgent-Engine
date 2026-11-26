/**
 * Semgrep runner for psi2. Local rules only (no registry fetch), metrics off,
 * version check off, so runs are offline and reproducible. Findings are
 * fingerprinted WITHOUT line numbers: ruleId + file path + hash of the
 * whitespace-normalized matched code. Match text is read from the file by
 * byte offset because Semgrep reports "requires login" in `extra.lines` for
 * logged-out OSS runs.
 */
import { createHash } from 'node:crypto';
import { readdir, readFile, stat } from 'node:fs/promises';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { run } from '../engine/exec.js';

/** Rule pack shipped with the engine. */
export const DEFAULT_RULES = fileURLToPath(new URL('../../rules/semgrep/', import.meta.url));

const versions = new Map();

/**
 * Semgrep version string, or null when the binary is missing or unusable.
 * @param {string} bin @param {Record<string, string>} [env]
 */
export function semgrepVersion(bin, env) {
  if (!versions.has(bin)) {
    versions.set(bin, run(bin, ['--version'], { env, timeoutMs: 60_000 }).then((r) => {
      const v = r.stdout.trim().split('\n')[0];
      return r.code === 0 && v ? v : null;
    }));
  }
  return versions.get(bin);
}

/** Hash of all rule files under the given paths (cache-key ingredient). */
export async function hashRules(paths) {
  const h = createHash('sha256');
  const walk = async (p) => {
    const st = await stat(p).catch(() => null);
    if (!st) return;
    if (st.isDirectory()) {
      for (const n of (await readdir(p)).sort()) await walk(join(p, n));
    } else {
      h.update(p).update(await readFile(p));
    }
  };
  for (const p of paths) await walk(p);
  return h.digest('hex').slice(0, 16);
}

const normalize = (code) => code.replace(/\s+/g, ' ').trim();
const fingerprint = (ruleId, path, code) =>
  createHash('sha256').update(`${ruleId}\0${path}\0${normalize(code)}`).digest('hex').slice(0, 24);

const SEVERITY = { ERROR: 'high', WARNING: 'medium' }; // anything else is informational

/**
 * @typedef {object} Finding
 * @property {string} ruleId @property {string} path @property {string} message
 * @property {'high'|'medium'|undefined} severity @property {string} [cwe] @property {number} line
 */

/**
 * Scan `files` (relative to `dir`) and return findings keyed by fingerprint.
 * Identical matches in one file share a key, so counts are tracked.
 * @returns {Promise<Map<string, Finding[]>>}
 */
export async function runSemgrep(dir, files, { bin, rules, env, timeoutMs }) {
  const out = new Map();
  if (files.length === 0) return out;
  const args = [
    '--json', '--metrics=off', '--disable-version-check', '--no-rewrite-rule-ids', '--no-git-ignore',
    ...rules.flatMap((r) => ['--config', r]),
    ...files.map((f) => `./${f}`),
  ];
  const r = await run(bin, args, { cwd: dir, env, timeoutMs });
  if (r.timedOut) throw new Error(`semgrep timed out after ${timeoutMs}ms`);
  let json;
  try {
    json = JSON.parse(r.stdout);
  } catch {
    throw new Error(`semgrep produced no JSON (exit ${r.code}): ${r.stderr.trim().slice(-300)}`);
  }
  const fatal = (json.errors ?? []).filter((e) => e.type === 'SemgrepError' || /invalid|parse error/i.test(e.message ?? e.long_msg ?? ''));
  if (r.code >= 2 && (json.results ?? []).length === 0 && fatal.length) {
    throw new Error(`semgrep failed: ${fatal[0].message ?? fatal[0].long_msg}`.slice(0, 300));
  }
  const buffers = new Map();
  for (const m of json.results ?? []) {
    const path = m.path.replace(/^\.\//, '');
    if (!buffers.has(path)) buffers.set(path, await readFile(join(dir, path)).catch(() => null));
    const buf = buffers.get(path);
    const code = buf && m.start.offset !== undefined
      ? buf.subarray(m.start.offset, m.end.offset).toString('utf8')
      : String(m.extra?.lines ?? '');
    const cwe = [].concat(m.extra?.metadata?.cwe ?? [])[0];
    const key = fingerprint(m.check_id, path, code);
    if (!out.has(key)) out.set(key, []);
    out.get(key).push({
      ruleId: m.check_id,
      path,
      message: m.extra?.message ?? '',
      severity: SEVERITY[m.extra?.severity],
      cwe,
      line: m.start.line,
    });
  }
  return out;
}

/**
 * Findings present after but beyond what the baseline had (per fingerprint count).
 * @param {Map<string, Finding[]>} after @param {Map<string, Finding[]>} baseline
 * @returns {Finding[]}
 */
export function newFindings(after, baseline) {
  const out = [];
  for (const [key, items] of after) {
    const extra = items.length - (baseline.get(key)?.length ?? 0);
    if (extra > 0) out.push(...items.slice(-extra));
  }
  return out;
}
