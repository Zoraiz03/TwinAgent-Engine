/**
 * Fault injectors, one per category. Each knows its expected label BY
 * CONSTRUCTION and how the candidate must be validated on a scratch copy:
 *   tests-fail  some test that passed at baseline must fail (killed mutant);
 *   probe-fail  a runtime probe must fail while all tests still pass;
 *   tests-pass  all baseline-passing tests and probes must still pass, so the
 *               label is exactly the intended psi (no collateral breakage);
 *   none        no validation (the label holds by definition).
 * Sites come from the twin graph (modules, tests, coverage, probe closures)
 * and the AST, never from hardcoded paths.
 *
 * Injector: { category, expected, psi4Pending?, validate, candidates(info, rnd) }
 *   candidates -> [{ description, edits: {path: content|null}, relock?, advisories? }]
 *   (already in seeded random order; the generator takes the first valid one)
 */
import { posix } from 'node:path';
import { hex, shuffle } from '../prng.js';
import { afterImports, applyTextEdits, functionBodyStarts, mutants, parse, walk } from './ast.js';

const relFrom = (from, to) => {
  const r = posix.relative(posix.dirname(from), to);
  return r.startsWith('.') ? r : `./${r}`;
};
const append = (text, code) => `${text.endsWith('\n') ? text : `${text}\n`}\n${code}`;
const insertAt = (text, at, code) => applyTextEdits(text, [{ start: at, end: at, text: code }]);
const id = (rnd) => hex(rnd, 6);

/** Modules whose source acorn can parse, with text and AST. */
function parsed(info, files) {
  return files.map((f) => ({ file: f, text: info.read(f) })).map((x) => ({ ...x, ast: parse(x.text) })).filter((x) => x.ast);
}

function vendorPackage(info, rnd, name) {
  const pkg = JSON.parse(info.read('package.json'));
  pkg.dependencies = { ...pkg.dependencies, [name]: `file:vendor/${name}` };
  return {
    [`vendor/${name}/package.json`]: `${JSON.stringify({ name, version: '1.0.0', main: 'index.js' }, null, 2)}\n`,
    [`vendor/${name}/index.js`]: 'module.exports = {};\n',
    'package.json': `${JSON.stringify(pkg, null, 2)}\n`,
  };
}

const PATTERNS = [
  ['eval', (n) => `export function runUserCode${n}(userInput) {\n  return eval(userInput);\n}\n`],
  ['hardcoded secret', (n, rnd) => `const apiKey${n} = "${hex(rnd, 32)}";\nexport const client${n} = { apiKey: apiKey${n} };\n`],
  ['SQL string concatenation', (n) => `export function findUser${n}(db, id) {\n  return db.query("SELECT * FROM users WHERE id = " + id);\n}\n`],
  ['innerHTML with a variable', (n) => `export function render${n}(el, html) {\n  el.innerHTML = html;\n}\n`],
  ['TLS verification disabled', (n) => `export const tlsOptions${n} = { rejectUnauthorized: false };\n`],
];

const SLOW = [
  ['synchronous busy-wait', 'const __end = Date.now() + 25;\n  while (Date.now() < __end) { /* busy-wait */ }\n'],
  ['nested loop over a large input', 'let __acc = 0;\n  for (let __i = 0; __i < 600; __i++) for (let __j = 0; __j < 600; __j++) __acc += __i ^ __j;\n'],
  ['N+1-style repeated work', 'for (let __i = 0; __i < 2000; __i++) JSON.parse(JSON.stringify({ __i, items: Array.from({ length: 20 }, (_, k) => k) }));\n'],
];

export const INJECTORS = [
  {
    category: 'psi1-covered',
    expected: ['psi1'],
    validate: 'tests-fail',
    candidates(info, rnd) {
      const out = [];
      for (const m of parsed(info, info.coveredModules)) {
        for (const mu of mutants(m.text, m.ast)) {
          out.push({ description: `${mu.op} in ${m.file} (${mu.where})`, edits: { [m.file]: applyTextEdits(m.text, [mu.edit]) } });
        }
      }
      return shuffle(rnd, out);
    },
  },
  {
    category: 'psi1-uncovered',
    expected: ['psi1-runtime'],
    validate: 'probe-fail',
    candidates(info, rnd) {
      const out = [];
      for (const m of parsed(info, info.uncoveredProbed)) {
        const fault = "throw new Error('injected runtime fault');\n";
        out.push({ description: `runtime fault at module load in ${m.file} (no test executes it)`, edits: { [m.file]: insertAt(m.text, afterImports(m.ast), `\n${fault}`) } });
        for (const f of functionBodyStarts(m.ast)) {
          out.push({ description: `runtime fault in ${f.name ?? 'a function'} of ${m.file} (no test executes it)`, edits: { [m.file]: insertAt(m.text, f.at, `\n  ${fault}`) } });
        }
      }
      return shuffle(rnd, out);
    },
  },
  {
    category: 'psi2-pattern',
    expected: ['psi2'],
    validate: 'tests-pass',
    candidates(info, rnd) {
      return shuffle(rnd, info.modules.flatMap((file) => PATTERNS.map(([name, make]) => {
        const n = id(rnd);
        return { description: `${name} added to ${file}`, edits: { [file]: append(info.read(file), make(n, rnd)) } };
      })));
    },
  },
  {
    category: 'psi2-dependency',
    expected: ['psi2'],
    validate: 'tests-pass',
    candidates(info, rnd) {
      if (!info.hasManifest) return [];
      const name = `twin-vuln-${id(rnd)}`;
      return [{
        description: `dependency ${name}@1.0.0 (listed as vulnerable in the frozen advisory file) added`,
        edits: vendorPackage(info, rnd, name),
        relock: true,
        advisories: [{ advisoryId: `TWIN-ADV-${id(rnd).toUpperCase()}`, package: name, severity: 'high', title: `${name} injected vulnerability`, versions: ['1.0.0'] }],
      }];
    },
  },
  {
    category: 'psi3-hallucinated',
    expected: ['psi3'],
    validate: 'tests-pass',
    candidates(info, rnd) {
      return shuffle(rnd, info.modules.map((file) => {
        const n = id(rnd);
        const pkg = `twin-hallucinated-${n}`;
        // dynamic import in an uncalled function: visible to analysis, harmless at runtime
        return { description: `import of nonexistent package "${pkg}" in ${file}`, edits: { [file]: append(info.read(file), `export async function loadExtra${n}() {\n  return import('${pkg}');\n}\n`) } };
      }));
    },
  },
  {
    category: 'psi3-missing-file',
    expected: ['psi3'],
    validate: 'tests-pass',
    candidates(info, rnd) {
      return shuffle(rnd, info.modules.map((file) => {
        const n = id(rnd);
        return { description: `import of missing file ./missing-${n}.js in ${file}`, edits: { [file]: append(info.read(file), `export async function loadMissing${n}() {\n  return import('./missing-${n}.js');\n}\n`) } };
      }));
    },
  },
  {
    category: 'psi3-cycle',
    expected: ['psi3'],
    validate: 'tests-pass',
    candidates(info, rnd) {
      const out = [];
      for (const { from, to } of info.moduleEdges) {
        if (info.twin.forwardReachable([to]).has(from)) continue; // already a cycle
        const text = info.read(to);
        out.push({ description: `new circular import: ${to} now imports ${from} (which imports ${to})`, edits: { [to]: insertAt(text, 0, `import '${relFrom(to, from)}';\n`) } });
      }
      return shuffle(rnd, out);
    },
  },
  {
    category: 'psi4-slow',
    expected: ['psi4'],
    psi4Pending: true,
    validate: 'tests-pass',
    candidates(info, rnd) {
      const out = [];
      for (const m of parsed(info, info.coveredModules)) {
        for (const f of functionBodyStarts(m.ast)) {
          for (const [name, code] of SLOW) out.push({ description: `${name} added to ${f.name ?? 'a function'} in ${m.file}`, edits: { [m.file]: insertAt(m.text, f.at, `\n  ${code}`) } });
        }
      }
      return shuffle(rnd, out);
    },
  },
  {
    category: 'test-tampering',
    expected: ['psi1'],
    validate: 'none',
    candidates(info, rnd) {
      const out = [];
      for (const t of parsed(info, info.tests)) {
        walk(t.ast, (n) => {
          if (n.type === 'CallExpression' && n.callee.type === 'Identifier' && ['test', 'it'].includes(n.callee.name)) {
            out.push({ description: `${n.callee.name}.skip added in ${t.file}`, edits: { [t.file]: insertAt(t.text, n.callee.end, '.skip') } });
          }
        });
        out.push({ description: `test file ${t.file} deleted`, edits: { [t.file]: null } });
      }
      return shuffle(rnd, out);
    },
  },
  {
    category: 'benign',
    expected: [],
    validate: 'tests-pass',
    candidates(info, rnd) {
      const out = [];
      for (const m of parsed(info, info.modules)) {
        out.push({ description: `comment added to ${m.file}`, edits: { [m.file]: insertAt(m.text, 0, `// Reviewed: no behavior change (${id(rnd)}).\n`) } });
        out.push({ description: `formatting: blank lines added in ${m.file}`, edits: { [m.file]: m.text.replace(/;\n/g, ';\n\n') } });
        for (const f of functionBodyStarts(m.ast)) {
          const p = f.node.params.find((x) => x.type === 'Identifier');
          if (!p) continue;
          const renamed = `${p.name}Renamed`;
          const edits = [];
          let unsafe = false;
          walk(f.node, (n, parent) => {
            if (n.type !== 'Identifier' || n.name !== p.name) return;
            if (parent?.type === 'MemberExpression' && parent.property === n && !parent.computed) return;
            if (parent?.type === 'Property' && parent.key === n && !parent.computed) { if (parent.shorthand) unsafe = true; return; }
            edits.push({ start: n.start, end: n.end, text: renamed });
          });
          if (!unsafe && edits.length) out.push({ description: `local rename ${p.name} -> ${renamed} in ${f.name ?? 'a function'} of ${m.file}`, edits: { [m.file]: applyTextEdits(m.text, edits) } });
        }
      }
      if (info.framework === 'node:test' && info.modules.length) {
        const n = id(rnd);
        const dir = posix.dirname(info.modules[0]);
        const mod = posix.join(dir, `helper-${n}.js`);
        const testDir = info.tests.length ? posix.dirname(info.tests[0]) : 'test';
        const testFile = posix.join(testDir, `helper-${n}.test.js`);
        out.push({
          description: `new function ${mod} with its own passing test`,
          edits: {
            [mod]: `export function double${n}(x) {\n  return x * 2;\n}\n`,
            [testFile]: `import { test } from 'node:test';\nimport assert from 'node:assert/strict';\nimport { double${n} } from '${relFrom(testFile, mod)}';\n\ntest('double${n}', () => assert.equal(double${n}(2), 4));\n`,
          },
        });
      }
      if (info.hasManifest) {
        const name = `twin-safe-${id(rnd)}`;
        out.push({ description: `safe dependency ${name}@1.0.0 added`, edits: vendorPackage(info, rnd, name), relock: true });
      }
      return shuffle(rnd, out);
    },
  },
];

export const CATEGORIES = INJECTORS.map((i) => i.category);
