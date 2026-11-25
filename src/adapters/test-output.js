/**
 * Parsers that turn machine-readable test-runner output into the common
 * `{ id, file, status }` shape used by adapter.runTests().
 *   - jest `--json` and vitest `--reporter=json` (same Jest-style JSON)
 *   - node:test `--test-reporter=junit` (Node >= 20.10; no `tap` because it
 *     flattens away file names)
 * Test ids are `<file>::<describe > ... > test name>`; duplicates get `#n`.
 */
import { realpathSync } from 'node:fs';
import { relative } from 'node:path';

/** @typedef {{id: string, file: string, status: 'pass'|'fail'|'skip'}} TestResult */

function relPath(dir, p) {
  let real = dir;
  try { real = realpathSync(dir); } catch { /* keep dir */ }
  for (const base of [dir, real]) {
    const r = relative(base, p);
    if (!r.startsWith('..')) return r.split('\\').join('/');
  }
  return p;
}

/** @param {TestResult[]} tests */
function dedupe(tests) {
  const seen = new Map();
  for (const t of tests) {
    const n = (seen.get(t.id) ?? 0) + 1;
    seen.set(t.id, n);
    if (n > 1) t.id = `${t.id}#${n}`;
  }
  return tests;
}

/**
 * @param {string} text  Jest/Vitest JSON report.
 * @param {string} dir  Clone dir, used to make file paths relative.
 * @returns {TestResult[]}
 */
export function parseJestJson(text, dir) {
  const json = JSON.parse(text);
  const status = { passed: 'pass', failed: 'fail' };
  const tests = [];
  for (const suite of json.testResults ?? []) {
    const file = relPath(dir, suite.name);
    const cases = suite.assertionResults ?? [];
    if (cases.length === 0 && suite.status === 'failed') {
      tests.push({ id: file, file, status: 'fail' }); // suite failed to run (syntax error etc.)
    }
    for (const c of cases) {
      const name = c.fullName ?? [...(c.ancestorTitles ?? []), c.title].join(' ');
      tests.push({ id: `${file}::${name}`, file, status: status[c.status] ?? 'skip' });
    }
  }
  return dedupe(tests);
}

const unescapeXml = (s) =>
  s.replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&apos;/g, "'").replace(/&amp;/g, '&');

function attrs(str) {
  const out = {};
  for (const m of str.matchAll(/([\w:-]+)="([^"]*)"/g)) out[m[1]] = unescapeXml(m[2]);
  return out;
}

/**
 * @param {string} xml  node:test junit report.
 * @param {string} dir
 * @returns {TestResult[]}
 */
export function parseJunit(xml, dir) {
  const tests = [];
  const suites = [];
  let current = null;
  const tag = /<(\/?)(testsuite|testcase|failure|error|skipped)\b([^>]*?)(\/?)>/g;
  for (const m of xml.matchAll(tag)) {
    const [, closing, name, rest, selfClose] = m;
    if (name === 'testsuite') {
      if (closing) suites.pop();
      else if (!selfClose) suites.push(attrs(rest).name ?? '');
    } else if (name === 'testcase') {
      if (closing) {
        if (current) tests.push(current);
        current = null;
      } else {
        const a = attrs(rest);
        const file = a.file ? relPath(dir, a.file) : a.classname ?? '';
        const t = { id: `${file}::${[...suites, a.name].join(' > ')}`, file, status: 'pass' };
        if (selfClose) tests.push(t);
        else current = t;
      }
    } else if (current && !closing) {
      current.status = name === 'skipped' ? 'skip' : 'fail';
    }
  }
  return dedupe(tests);
}
