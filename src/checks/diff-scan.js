/**
 * Diff-level test-tampering detection for psi1, independent of runner output.
 * Looks only at test files (test/, tests/, __tests__/, *.test.*, *.spec.*).
 * Flags: added skip/todo markers, a deleted test file, and a net decrease in
 * test cases (it/test calls) or assertions in a changed test file.
 */

const TEST_FILE = /(^|\/)(tests?|__tests__)\/|\.(test|spec)\.[cm]?[jt]sx?$/;
const SKIP_MARKERS = [
  /\.skip\(/, /\bx(it|describe|test)\(/, /\.todo\(/, /\{\s*skip\s*:\s*true\s*\}/, /\bskip\s*:\s*true\b/,
];
const TEST_CALL = /\b(?:it|test)(?:\.\w+)?\s*\(/g;
const ASSERTION = /\b(?:assert(?:\.\w+)*|expect)\s*\(/g;

export const isTestFile = (path) => TEST_FILE.test(path);

/**
 * Split a unified diff into per-file added/removed lines.
 * @param {string} diff
 * @returns {Array<{path: string, deleted: boolean, added: string[], removed: string[]}>}
 */
export function parseDiffFiles(diff) {
  const files = [];
  let cur = null;
  let inHunk = false;
  for (const line of diff.split('\n')) {
    let m;
    if (line.startsWith('diff --git ')) {
      cur = { path: '', deleted: false, added: [], removed: [] };
      files.push(cur);
      inHunk = false;
    } else if (!cur) {
      continue;
    } else if (!inHunk && (m = /^--- (?:a\/)?(.*)$/.exec(line)) && m[1] !== '/dev/null') {
      cur.path = cur.path || m[1];
    } else if (!inHunk && (m = /^\+\+\+ (?:b\/)?(.*)$/.exec(line))) {
      if (m[1] === '/dev/null') cur.deleted = true;
      else cur.path = m[1];
    } else if (line.startsWith('@@')) {
      inHunk = true;
    } else if (inHunk && line.startsWith('+')) {
      cur.added.push(line.slice(1));
    } else if (inHunk && line.startsWith('-')) {
      cur.removed.push(line.slice(1));
    }
  }
  return files.filter((f) => f.path);
}

const count = (lines, re) => lines.join('\n').match(re)?.length ?? 0;

/**
 * @param {string} diff
 * @returns {import('../engine/schema.js').Evidence[]}
 */
export function detectTampering(diff) {
  const out = [];
  const tamper = (detail, path) => out.push({ kind: 'test-tampering', detail, files: [path], severity: 'high' });
  for (const f of parseDiffFiles(diff).filter((x) => isTestFile(x.path))) {
    if (f.deleted) {
      tamper(`test file deleted: ${f.path}`, f.path);
      continue;
    }
    for (const line of f.added) {
      const marker = SKIP_MARKERS.find((re) => re.test(line));
      if (marker) tamper(`test disabled in ${f.path}: "${line.trim()}"`, f.path);
    }
    const cases = count(f.removed, TEST_CALL) - count(f.added, TEST_CALL);
    if (cases > 0) tamper(`${cases} test case(s) removed from ${f.path}`, f.path);
    const asserts = count(f.removed, ASSERTION) - count(f.added, ASSERTION);
    if (cases <= 0 && asserts > 0) tamper(`${asserts} assertion(s) removed from ${f.path}`, f.path);
  }
  return out;
}
