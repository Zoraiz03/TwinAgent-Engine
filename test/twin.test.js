import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createGraph, addNode, addEdge, sync } from '../src/twin/index.js';

test('twin graph holds V, E, P and sync is a stub', async () => {
  const g = createGraph();
  addNode(g, 'a', { coverage: 0.9 });
  addNode(g, 'b');
  addEdge(g, 'a', 'b', 'imports');
  assert.equal(g.V.size, 2);
  assert.equal(g.E.length, 1);
  assert.equal(await sync(g, ''), g);
});
