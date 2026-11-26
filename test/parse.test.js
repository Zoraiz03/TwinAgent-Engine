import { test } from 'node:test';
import assert from 'node:assert/strict';
import { buildGraph, findCycles, packageName, parseImports, reach, reverseEdges, resolveRelative } from '../src/twin/parse.js';
import { FIXTURE, makeTarget } from './helpers.js';

test('parseImports reads ESM, CJS, dynamic and re-export specifiers', () => {
  const src = `
    import a from './a.js';
    import { b } from "pkg-b";
    export * from './c.js';
    export { d } from '@scope/d/sub';
    const e = require('./e');
    const f = await import('./f.js');
    // import x from 'commented'
    const dyn = require(name);
  `;
  assert.deepEqual(parseImports(src).sort(), ['./a.js', './c.js', './e', './f.js', '@scope/d/sub', 'pkg-b']);
});

test('parseImports falls back to a regex scan for TypeScript', () => {
  const ts = `import type { T } from './types';\nimport x from 'left-pad';\nexport const y: Array<number> = [];\n// import z from 'nope'\n`;
  assert.deepEqual(parseImports(ts).sort(), ['./types', 'left-pad']);
});

test('packageName handles scopes, subpaths, builtins, aliases', () => {
  assert.equal(packageName('lodash/fp'), 'lodash');
  assert.equal(packageName('@scope/pkg/deep'), '@scope/pkg');
  for (const s of ['fs', 'fs/promises', 'node:path', '#internal', '@/alias', '~/x']) assert.equal(packageName(s), null, s);
});

test('findCycles / reach', () => {
  const edges = new Map([['a', new Set(['b'])], ['b', new Set(['c'])], ['c', new Set(['a'])], ['d', new Set(['d'])], ['e', new Set(['a'])]]);
  assert.deepEqual(findCycles(edges).map((c) => c.join(',')).sort(), ['a,b,c', 'd']);
  assert.deepEqual([...reach(reverseEdges(edges), ['a'])].sort(), ['a', 'c', 'b', 'e'].sort());
});

test('buildGraph on the fixture resolves internal edges and finds nothing unresolved', async () => {
  const g = await buildGraph(FIXTURE);
  assert.deepEqual([...g.edges.get('src/index.js')].sort(), ['src/format.js', 'src/greet.js']);
  assert.deepEqual([g.unresolved, g.undeclared], [[], []]);
});

test('resolveRelative handles extensions, index files and TS-style .js specifiers', async () => {
  const dir = await makeTarget({ files: { 'src/lib/index.ts': 'export {}', 'src/t.ts': 'export {}' } });
  assert.equal(await resolveRelative(dir, 'src/index.js', './lib'), 'src/lib/index.ts');
  assert.equal(await resolveRelative(dir, 'src/index.js', './t.js'), 'src/t.ts');
  assert.equal(await resolveRelative(dir, 'src/index.js', './math'), 'src/math.js');
  assert.equal(await resolveRelative(dir, 'src/index.js', './nope'), null);
});
