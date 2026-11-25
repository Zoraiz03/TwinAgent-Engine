import { test } from 'node:test';
import assert from 'node:assert/strict';
import { checks } from '../src/checks/index.js';
import { CheckResultSchema } from '../src/engine/schema.js';

test('stub checks (psi2, psi4) return schema-valid, deterministic results', async () => {
  for (const id of ['psi2', 'psi4']) {
    const mod = checks[id];
    const a = await mod.run({});
    const b = await mod.run({});
    assert.equal(a.id, id);
    assert.deepEqual(a, b);
    CheckResultSchema.parse(a);
  }
});
