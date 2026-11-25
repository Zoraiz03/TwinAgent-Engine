import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseJestJson, parseJunit } from '../src/adapters/test-output.js';
import { nodeNpmAdapter } from '../src/adapters/node-npm.js';
import { FIXTURE, makeTarget } from './helpers.js';

test('parseJestJson maps statuses and failed-to-run suites (jest and vitest share this format)', () => {
  const json = JSON.stringify({
    testResults: [
      { name: '/c/ws/test/a.test.js', status: 'failed', assertionResults: [
        { ancestorTitles: ['math'], title: 'adds', fullName: 'math adds', status: 'passed' },
        { ancestorTitles: ['math'], title: 'subs', fullName: 'math subs', status: 'failed' },
        { title: 'later', status: 'pending' },
        { title: 'dup', status: 'passed' }, { title: 'dup', status: 'passed' },
      ] },
      { name: '/c/ws/test/broken.test.js', status: 'failed', assertionResults: [] },
    ],
  });
  assert.deepEqual(parseJestJson(json, '/c/ws').map((t) => [t.id, t.status]), [
    ['test/a.test.js::math adds', 'pass'],
    ['test/a.test.js::math subs', 'fail'],
    ['test/a.test.js::later', 'skip'],
    ['test/a.test.js::dup', 'pass'],
    ['test/a.test.js::dup#2', 'pass'],
    ['test/broken.test.js', 'fail'],
  ]);
});

test('parseJunit handles nested suites, failures, skips and XML escapes', () => {
  const xml = `<?xml version="1.0"?><testsuites>
    <testsuite name="outer" tests="2">
      <testcase name="ok &amp; fine" file="/c/ws/test/x.test.js"/>
      <testcase name="bad" file="/c/ws/test/x.test.js"><failure message="boom">stack</failure></testcase>
    </testsuite>
    <testcase name="later" file="/c/ws/test/x.test.js"><skipped type="skipped"/></testcase>
  </testsuites>`;
  assert.deepEqual(parseJunit(xml, '/c/ws').map((t) => [t.id, t.status]), [
    ['test/x.test.js::outer > ok & fine', 'pass'],
    ['test/x.test.js::outer > bad', 'fail'],
    ['test/x.test.js::later', 'skip'],
  ]);
});

test('runTests (node:test) returns parsed results from a real run', async () => {
  const r = await nodeNpmAdapter.runTests(FIXTURE, { timeoutMs: 30000, env: { PATH: process.env.PATH, HOME: await makeTarget() } });
  assert.equal(r.ran, true);
  assert.equal(r.exitCode, 0);
  assert.deepEqual(r.tests.map((t) => [t.id, t.status]).sort(), [
    ['test/app.test.js::describe shouts the greeting', 'pass'],
    ['test/greet.test.js::greet', 'pass'],
    ['test/math.test.js::add', 'pass'],
  ]);
});

test('runTests: unknown runner falls back to file level via exit code; no script means ran:false', async () => {
  const fail = await makeTarget({ files: { 'package.json': JSON.stringify({ scripts: { test: 'exit 3' } }) } });
  const r = await nodeNpmAdapter.runTests(fail, { timeoutMs: 30000, env: { PATH: process.env.PATH, HOME: fail } });
  assert.deepEqual(r.tests, [{ id: 'npm test', file: 'package.json', status: 'fail' }]);
  const none = await makeTarget({ files: { 'package.json': '{}' } });
  assert.equal((await nodeNpmAdapter.runTests(none, {})).ran, false);
});
