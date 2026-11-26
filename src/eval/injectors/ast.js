/**
 * Small AST toolkit for injectors (acorn): parse, walk with parents, list
 * mutation sites, and apply text edits by offset.
 */
import * as acorn from 'acorn';

export function parse(source) {
  const opts = { ecmaVersion: 'latest', allowHashBang: true, allowReturnOutsideFunction: true };
  try {
    return acorn.parse(source, { ...opts, sourceType: 'module' });
  } catch {
    try { return acorn.parse(source, { ...opts, sourceType: 'script' }); } catch { return null; }
  }
}

/** Visit every node with its parent (depth-first, source order). */
export function walk(node, fn, parent = null) {
  if (!node || typeof node.type !== 'string') return;
  fn(node, parent);
  for (const [k, v] of Object.entries(node)) {
    if (k === 'type' || !v || typeof v !== 'object') continue;
    if (Array.isArray(v)) v.forEach((c) => walk(c, fn, node));
    else walk(v, fn, node);
  }
}

/** Apply non-overlapping edits [{start, end, text}] to source. */
export function applyTextEdits(source, edits) {
  let out = source;
  for (const e of [...edits].sort((a, b) => b.start - a.start)) out = out.slice(0, e.start) + e.text + out.slice(e.end);
  return out;
}

export const FUNCTION_TYPES = new Set(['FunctionDeclaration', 'FunctionExpression', 'ArrowFunctionExpression']);

/** Offset just inside the body of each block-bodied function. */
export function functionBodyStarts(ast) {
  const out = [];
  walk(ast, (n) => {
    if (FUNCTION_TYPES.has(n.type) && n.body?.type === 'BlockStatement') out.push({ at: n.body.start + 1, name: n.id?.name ?? null, node: n });
  });
  return out;
}

/** Offset after the last top-level import (0 if none). */
export function afterImports(ast) {
  const imports = ast.body.filter((s) => s.type === 'ImportDeclaration');
  return imports.length ? imports.at(-1).end : 0;
}

const FLIP = { '+': '-', '-': '+', '*': '/', '/': '*', '<': '>=', '>': '<=', '<=': '>', '>=': '<', '===': '!==', '!==': '===', '==': '!=', '!=': '==', '&&': '||', '||': '&&' };

/**
 * Behavior-changing mutants of a source file (classic mutation operators):
 * operator flip, remove return value, change constant, off-by-one, swap args.
 * @returns {Array<{op: string, edit: {start: number, end: number, text: string}, where: string}>}
 */
export function mutants(source, ast) {
  const out = [];
  const line = (pos) => source.slice(0, pos).split('\n').length;
  walk(ast, (n, parent) => {
    if ((n.type === 'BinaryExpression' || n.type === 'LogicalExpression') && FLIP[n.operator]) {
      const gap = source.slice(n.left.end, n.right.start);
      const i = gap.indexOf(n.operator);
      if (i >= 0) {
        const start = n.left.end + i;
        out.push({ op: 'operator-flip', edit: { start, end: start + n.operator.length, text: FLIP[n.operator] }, where: `line ${line(start)}: ${n.operator} -> ${FLIP[n.operator]}` });
        if (['<', '>', '<=', '>='].includes(n.operator)) {
          const obo = { '<': '<=', '<=': '<', '>': '>=', '>=': '>' }[n.operator];
          out.push({ op: 'off-by-one', edit: { start, end: start + n.operator.length, text: obo }, where: `line ${line(start)}: ${n.operator} -> ${obo}` });
        }
      }
    } else if (n.type === 'ReturnStatement' && n.argument) {
      out.push({ op: 'remove-return', edit: { start: n.argument.start, end: n.argument.end, text: 'undefined' }, where: `line ${line(n.start)}: return value removed` });
    } else if (n.type === 'Literal' && typeof n.value === 'number') {
      out.push({ op: 'change-constant', edit: { start: n.start, end: n.end, text: String(n.value * 10 + 7) }, where: `line ${line(n.start)}: ${n.raw} -> ${n.value * 10 + 7}` });
      out.push({ op: 'off-by-one', edit: { start: n.start, end: n.end, text: String(n.value + 1) }, where: `line ${line(n.start)}: ${n.raw} -> ${n.value + 1}` });
    } else if (n.type === 'Literal' && typeof n.value === 'string' && parent && !['ImportDeclaration', 'ExportNamedDeclaration', 'ExportAllDeclaration', 'ImportExpression'].includes(parent.type)
               && !(parent.type === 'ExpressionStatement' && parent.directive) && !(parent.type === 'Property' && parent.key === n)) {
      out.push({ op: 'change-constant', edit: { start: n.start, end: n.end, text: JSON.stringify(`${n.value}!`) }, where: `line ${line(n.start)}: string constant changed` });
    } else if (n.type === 'TemplateLiteral' && n.quasis.length && n.quasis[0].value.raw.length) {
      const q = n.quasis[0];
      out.push({ op: 'change-constant', edit: { start: q.start, end: q.start, text: 'x' }, where: `line ${line(q.start)}: template constant changed` });
    } else if ((n.type === 'CallExpression' || n.type === 'NewExpression') && n.arguments.length >= 2 && n.arguments.every((a) => a.type !== 'SpreadElement')) {
      const [a, b] = n.arguments;
      out.push({ op: 'swap-args', edit: { start: a.start, end: b.end, text: `${source.slice(b.start, b.end)}${source.slice(a.end, b.start)}${source.slice(a.start, a.end)}` }, where: `line ${line(a.start)}: first two arguments swapped` });
    }
  });
  return out;
}
