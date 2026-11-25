import { test } from 'node:test';
import assert from 'node:assert/strict';
import { runLoop } from '../src/loop/index.js';

const rep = (classification) => ({ classification });

function harness(classes) {
  const calls = [];
  let i = 0;
  return {
    calls,
    deps: {
      simulate: async () => rep(classes[Math.min(i++, classes.length - 1)]),
      reformulate: async (d) => { calls.push('reformulate'); return d + '+'; },
      commit: async () => { calls.push('commit'); },
      escalate: async () => { calls.push('escalate'); },
    },
  };
}

test('Safe commits; Revise retries then commits; Abort escalates; K exhausted escalates', async () => {
  let h = harness(['Safe']);
  assert.equal((await runLoop({ diff: 'd', K: 2, ...h.deps })).outcome, 'committed');
  h = harness(['Revise', 'Safe']);
  assert.equal((await runLoop({ diff: 'd', K: 2, ...h.deps })).attempts, 2);
  h = harness(['Abort']);
  assert.equal((await runLoop({ diff: 'd', K: 2, ...h.deps })).outcome, 'escalated');
  h = harness(['Revise']);
  const r = await runLoop({ diff: 'd', K: 2, ...h.deps });
  assert.equal(r.outcome, 'escalated');
  assert.equal(h.calls.filter((c) => c === 'reformulate').length, 2);
});
