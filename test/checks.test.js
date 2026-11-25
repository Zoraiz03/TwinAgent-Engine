import { test } from 'node:test';
import assert from 'node:assert/strict';
import { checks } from '../src/checks/index.js';
import { CheckResultSchema } from '../src/engine/schema.js';

test('each check returns a schema-valid, deterministic result', async () => {
  for (const [id, mod] of Object.entries(checks)) {
    const a = await mod.run({});
    const b = await mod.run({});
    assert.equal(a.id, id);
    assert.deepEqual(a, b);
    CheckResultSchema.parse(a);
  }
});
