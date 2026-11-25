/**
 * Diff application. Statically analyses a unified diff (files touched, added /
 * removed lines, unsafe paths), then applies it inside the clone with
 * `git apply --check` followed by `git apply --index`. Never throws for a bad
 * diff: failures come back as `{ applied: false, error }`. Diffs that escape the
 * clone (absolute paths, `..`) or touch `.git` are rejected before git runs.
 */
import { existsSync } from 'node:fs';
import { appendFile, mkdir } from 'node:fs/promises';
import { basename, join } from 'node:path';
import { run } from './exec.js';

/**
 * @typedef {object} ApplyResult
 * @property {boolean} applied
 * @property {string[]} filesChanged
 * @property {number} addedLines
 * @property {number} removedLines
 * @property {boolean} touchesManifest
 * @property {boolean} [rejected]  True when refused as unsafe (Abort), not merely inapplicable.
 * @property {string} [error]
 */

/** Strip optional git quoting. @param {string} p */
function unquote(p) {
  return p.startsWith('"') && p.endsWith('"') ? p.slice(1, -1) : p;
}

/**
 * Check a raw diff path (still carrying its a/ or b/ prefix).
 * @param {string} raw
 * @returns {{path?: string, unsafe?: string}}
 */
function checkPath(raw) {
  const p = unquote(raw.split('\t')[0].trim());
  if (p === '/dev/null') return {};
  if (p.includes('\0')) return { unsafe: 'path contains a NUL byte' };
  if (p.startsWith('/') || /^[a-zA-Z]:[\\/]/.test(p)) return { unsafe: `absolute path in diff: ${p}` };
  const segments = p.split(/[\\/]/).slice(1); // drop the a/ or b/ prefix (-p1)
  if (segments[0] === '') return { unsafe: `absolute path in diff: ${p}` };
  if (segments.includes('..')) return { unsafe: `path traversal in diff: ${p}` };
  if (segments.includes('.git')) return { unsafe: `diff modifies .git: ${p}` };
  return { path: segments.join('/') };
}

/**
 * @param {string} diff
 * @returns {{files: string[], added: number, removed: number, unsafe?: string}}
 */
export function analyzeDiff(diff) {
  const files = new Set();
  let added = 0;
  let removed = 0;
  let oldLeft = 0;
  let newLeft = 0;
  /** @param {string} raw */
  const note = (raw) => {
    const r = checkPath(raw);
    if (r.path) files.add(r.path);
    return r.unsafe;
  };

  for (const line of diff.split('\n')) {
    if (oldLeft > 0 || newLeft > 0) {
      const c = line[0];
      if (c === '+') { added++; newLeft--; continue; }
      if (c === '-') { removed++; oldLeft--; continue; }
      if (c === ' ' || line === '') { oldLeft--; newLeft--; continue; }
      if (c === '\\') continue;
      oldLeft = newLeft = 0; // malformed hunk; fall through and let git judge
    }
    let unsafe;
    let m;
    if ((m = /^diff --git "?(a\/.*?)"? "?(b\/.*?)"?$/.exec(line))) {
      unsafe = note(m[1]) ?? note(m[2]);
    } else if (/^diff --git /.test(line)) {
      unsafe = 'unparseable "diff --git" header';
    } else if ((m = /^(?:--- |\+\+\+ )(.*)$/.exec(line))) {
      unsafe = note(m[1]);
    } else if ((m = /^(?:rename|copy) (?:from|to) (.*)$/.exec(line))) {
      unsafe = note(`x/${unquote(m[1])}`);
    } else if ((m = /^@@ -\d+(?:,(\d+))? \+\d+(?:,(\d+))? @@/.exec(line))) {
      oldLeft = m[1] === undefined ? 1 : Number(m[1]);
      newLeft = m[2] === undefined ? 1 : Number(m[2]);
    }
    if (unsafe) return { files: [...files], added, removed, unsafe };
  }
  return { files: [...files], added, removed };
}

/**
 * @param {string} cloneDir
 * @param {'worktree'|'copy'} kind
 */
async function ensureGitRepo(cloneDir, kind, timeoutMs) {
  if (kind !== 'copy' || existsSync(join(cloneDir, '.git'))) return null;
  const steps = [['init', '-q'], ['add', '-A']];
  for (const args of steps) {
    if (args[0] === 'add') {
      await mkdir(join(cloneDir, '.git', 'info'), { recursive: true });
      await appendFile(join(cloneDir, '.git', 'info', 'exclude'), 'node_modules\n');
    }
    const r = await run('git', args, { cwd: cloneDir, timeoutMs });
    if (r.code !== 0) return `git ${args[0]} failed in clone: ${r.stderr.trim()}`;
  }
  return null;
}

/**
 * @param {string} cloneDir
 * @param {'worktree'|'copy'} kind
 * @param {string} diff
 * @param {{manifestFiles: string[], timeoutMs?: number}} opts
 * @returns {Promise<ApplyResult>}
 */
export async function applyDiff(cloneDir, kind, diff, { manifestFiles, timeoutMs = 60_000 }) {
  const a = analyzeDiff(diff);
  const base = {
    applied: false,
    filesChanged: a.files,
    addedLines: a.added,
    removedLines: a.removed,
    touchesManifest: a.files.some((f) => manifestFiles.includes(basename(f))),
  };
  if (a.unsafe) return { ...base, rejected: true, error: a.unsafe };

  const input = diff.endsWith('\n') ? diff : `${diff}\n`;
  const initError = await ensureGitRepo(cloneDir, kind, timeoutMs);
  if (initError) return { ...base, error: initError };

  const flags = ['apply', '--index', '--whitespace=nowarn'];
  for (const args of [[...flags, '--check', '-'], [...flags, '-']]) {
    const r = await run('git', args, { cwd: cloneDir, input, timeoutMs });
    if (r.code !== 0) {
      return { ...base, error: (r.stderr || r.stdout || 'git apply failed').trim() };
    }
  }
  return { ...base, applied: true };
}
