/**
 * Static import graph of a JS/TS source tree (shared by psi1 and psi3).
 * Imports are read with acorn (ESM import/export-from, dynamic import() and
 * require() with string literals). Files acorn cannot parse (TypeScript, JSX)
 * fall back to a regex scan. Nothing is executed and nothing touches the
 * network. Paths are POSIX-style and relative to the scanned root.
 *
 * Known limits: tsconfig/bundler path aliases are not resolved (specifiers
 * like "@/x" are ignored), and non-literal import() / require() are skipped.
 */
import { builtinModules } from 'node:module';
import { readdir, readFile, stat } from 'node:fs/promises';
import { join, posix } from 'node:path';
import * as acorn from 'acorn';

const SKIP_DIRS = new Set(['node_modules', '.git', 'coverage']);
export const SOURCE_EXT = ['.js', '.mjs', '.cjs', '.jsx', '.ts', '.tsx', '.mts', '.cts'];
const BUILTINS = new Set(builtinModules.map((m) => m.replace(/^node:/, '')));

/** @param {string} f */
export const isSource = (f) => SOURCE_EXT.some((e) => f.endsWith(e));

/**
 * Import specifiers in a source file.
 * @param {string} source
 * @returns {string[]}
 */
export function parseImports(source) {
  try {
    return walkAst(parseWithAcorn(source));
  } catch {
    return regexImports(source);
  }
}

function parseWithAcorn(source) {
  const opts = { ecmaVersion: 'latest', allowHashBang: true, allowReturnOutsideFunction: true };
  try {
    return acorn.parse(source, { ...opts, sourceType: 'module' });
  } catch {
    return acorn.parse(source, { ...opts, sourceType: 'script' });
  }
}

function walkAst(ast) {
  const out = [];
  const visit = (n) => {
    if (!n || typeof n.type !== 'string') return;
    if ((n.type === 'ImportDeclaration' || n.type === 'ExportAllDeclaration' ||
         (n.type === 'ExportNamedDeclaration' && n.source)) && typeof n.source?.value === 'string') {
      out.push(n.source.value);
    } else if (n.type === 'ImportExpression' && n.source.type === 'Literal' && typeof n.source.value === 'string') {
      out.push(n.source.value);
    } else if (n.type === 'CallExpression' && n.callee.type === 'Identifier' && n.callee.name === 'require' &&
               n.arguments[0]?.type === 'Literal' && typeof n.arguments[0].value === 'string') {
      out.push(n.arguments[0].value);
    }
    for (const [k, v] of Object.entries(n)) {
      if (k === 'type' || !v || typeof v !== 'object') continue;
      if (Array.isArray(v)) v.forEach(visit);
      else visit(v);
    }
  };
  visit(ast);
  return out;
}

function regexImports(source) {
  const text = source.replace(/\/\*[\s\S]*?\*\/|(^|[^:\\'"`])\/\/.*$/gm, '$1');
  const out = [];
  const patterns = [
    /\bimport\s+(?:type\s+)?(?:[\w*${}\s,]+?\s+from\s+)?['"]([^'"\n]+)['"]/g,
    /\bexport\s+(?:type\s+)?[\w*${}\s,]+?\s+from\s+['"]([^'"\n]+)['"]/g,
    /\bimport\(\s*['"]([^'"\n]+)['"]\s*\)/g,
    /\brequire\(\s*['"]([^'"\n]+)['"]\s*\)/g,
  ];
  for (const re of patterns) for (const m of text.matchAll(re)) out.push(m[1]);
  return out;
}

/** Package name for a bare specifier, or null if it is not a package (alias, builtin, #import). */
export function packageName(spec) {
  if (spec.startsWith('#') || spec.startsWith('node:')) return null;
  const m = /^(@[a-z0-9][\w.~-]*\/[a-z0-9][\w.~-]*|[a-z0-9][\w.~-]*)(\/.*)?$/i.exec(spec);
  if (!m) return null;
  if (BUILTINS.has(spec) || BUILTINS.has(m[1])) return null;
  return m[1];
}

async function exists(p) {
  try {
    return (await stat(p)).isFile();
  } catch {
    return false;
  }
}

/**
 * Resolve a relative specifier from `fromFile` to a root-relative file, or null.
 * @param {string} root @param {string} fromFile @param {string} spec
 */
export async function resolveRelative(root, fromFile, spec) {
  const base = posix.normalize(posix.join(posix.dirname(fromFile), spec));
  const stem = base.replace(/\.(m|c)?jsx?$/, ''); // TS style: './x.js' -> x.ts
  const candidates = [
    base,
    ...SOURCE_EXT.map((e) => base + e),
    ...SOURCE_EXT.map((e) => stem + e),
    ...SOURCE_EXT.map((e) => posix.join(base, `index${e}`)),
  ];
  for (const c of candidates) if (await exists(join(root, c))) return c;
  return null;
}

/** @param {string} root @returns {Promise<string[]>} */
export async function listSourceFiles(root) {
  const out = [];
  async function walk(dir, rel) {
    for (const e of await readdir(dir, { withFileTypes: true })) {
      if (SKIP_DIRS.has(e.name)) continue;
      const r = rel ? `${rel}/${e.name}` : e.name;
      if (e.isDirectory()) await walk(join(dir, e.name), r);
      else if (e.isFile() && isSource(e.name)) out.push(r);
    }
  }
  await walk(root, '');
  return out.sort();
}

/** Package names declared in package.json (plus the package itself). */
async function declaredPackages(root) {
  try {
    const pkg = JSON.parse(await readFile(join(root, 'package.json'), 'utf8'));
    const names = new Set([pkg.name].filter(Boolean));
    for (const f of ['dependencies', 'devDependencies', 'peerDependencies', 'optionalDependencies']) {
      Object.keys(pkg[f] ?? {}).forEach((n) => names.add(n));
    }
    return names;
  } catch {
    return new Set();
  }
}

/**
 * @typedef {object} ImportGraph
 * @property {Set<string>} files
 * @property {Map<string, Set<string>>} edges  file -> resolved internal imports
 * @property {Array<{file: string, specifier: string}>} unresolved  relative imports with no file
 * @property {Array<{file: string, pkg: string}>} undeclared  bare imports of undeclared packages
 */

/**
 * Resolved internal imports of one file (used to test "directly imports X").
 * @param {string} root @param {string} file @returns {Promise<Set<string>>}
 */
export async function fileImports(root, file) {
  const out = new Set();
  try {
    for (const spec of parseImports(await readFile(join(root, file), 'utf8'))) {
      if (!spec.startsWith('.')) continue;
      const r = await resolveRelative(root, file, spec);
      if (r) out.add(r);
    }
  } catch { /* unreadable or deleted file: no imports */ }
  return out;
}

/** @param {string} root @returns {Promise<ImportGraph>} */
export async function buildGraph(root) {
  const files = new Set(await listSourceFiles(root));
  const declared = await declaredPackages(root);
  const edges = new Map();
  const unresolved = [];
  const undeclared = [];
  for (const file of files) {
    const targets = new Set();
    edges.set(file, targets);
    let specs = [];
    try {
      specs = parseImports(await readFile(join(root, file), 'utf8'));
    } catch { /* unreadable: treat as no imports */ }
    for (const spec of new Set(specs)) {
      if (spec.startsWith('.')) {
        const r = await resolveRelative(root, file, spec);
        if (r) targets.add(r);
        else unresolved.push({ file, specifier: spec });
      } else {
        const pkg = packageName(spec);
        if (pkg && !declared.has(pkg)) undeclared.push({ file, pkg });
      }
    }
  }
  return { files, edges, unresolved, undeclared };
}

/**
 * Strongly connected components that form cycles (size > 1 or self-import).
 * @param {Map<string, Set<string>>} edges
 * @returns {string[][]} each cycle as a sorted file list
 */
export function findCycles(edges) {
  let index = 0;
  const idx = new Map();
  const low = new Map();
  const onStack = new Set();
  const stack = [];
  const cycles = [];
  const connect = (v) => {
    idx.set(v, index); low.set(v, index); index++;
    stack.push(v); onStack.add(v);
    for (const w of edges.get(v) ?? []) {
      if (!idx.has(w)) { connect(w); low.set(v, Math.min(low.get(v), low.get(w))); }
      else if (onStack.has(w)) low.set(v, Math.min(low.get(v), idx.get(w)));
    }
    if (low.get(v) === idx.get(v)) {
      const comp = [];
      let w;
      do { w = stack.pop(); onStack.delete(w); comp.push(w); } while (w !== v);
      if (comp.length > 1 || edges.get(v)?.has(v)) cycles.push(comp.sort());
    }
  };
  for (const v of edges.keys()) if (!idx.has(v)) connect(v);
  return cycles;
}

/** @param {Map<string, Set<string>>} edges */
export function reverseEdges(edges) {
  const rev = new Map();
  for (const [from, tos] of edges) for (const to of tos) {
    if (!rev.has(to)) rev.set(to, new Set());
    rev.get(to).add(from);
  }
  return rev;
}

/** Everything reachable from `seeds` (inclusive) following `edges`. */
export function reach(edges, seeds) {
  const seen = new Set(seeds);
  const queue = [...seeds];
  while (queue.length) {
    for (const n of edges.get(queue.pop()) ?? []) if (!seen.has(n)) { seen.add(n); queue.push(n); }
  }
  return seen;
}

