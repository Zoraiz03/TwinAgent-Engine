import { test } from 'node:test';
import assert from 'node:assert/strict';
import { analyzeDiff } from '../src/engine/apply.js';
import { ABSOLUTE_DIFF, CLEAN_DIFF, GIT_DIFF, MANIFEST_DIFF, TRAVERSAL_DIFF } from './helpers.js';

test('analyzeDiff counts files and lines', () => {
  assert.deepEqual(analyzeDiff(CLEAN_DIFF), { files: ['src/math.js'], added: 1, removed: 1 });
  assert.deepEqual(analyzeDiff(MANIFEST_DIFF), { files: ['package.json'], added: 1, removed: 0 });
});

test('analyzeDiff does not mistake "+++"/"---" content lines for headers', () => {
  const d = 'diff --git a/x b/x\n--- a/x\n+++ b/x\n@@ -1,2 +1,2 @@\n--- old\n+++ new\n ctx\n';
  assert.deepEqual(analyzeDiff(d), { files: ['x'], added: 1, removed: 1 });
});

test('analyzeDiff flags traversal, absolute paths, .git, and renames out of the clone', () => {
  assert.match(analyzeDiff(TRAVERSAL_DIFF).unsafe, /traversal/);
  assert.match(analyzeDiff(ABSOLUTE_DIFF).unsafe, /absolute/);
  assert.match(analyzeDiff(GIT_DIFF).unsafe, /\.git/);
  assert.match(analyzeDiff('diff --git a/x b/y\nrename from x\nrename to ../y\n').unsafe, /traversal/);
  assert.match(analyzeDiff('--- a//etc/passwd\n+++ b//etc/passwd\n').unsafe, /absolute/);
});
