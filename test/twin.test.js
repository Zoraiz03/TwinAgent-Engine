import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, rm, writeFile, readFile, readdir } from 'node:fs/promises';
import { dirname, join, posix } from 'node:path';
import { Twin, canonicalCycle, loadTwin, clearTwinCache } from '../src/twin/index.js';
import { nodeNpmAdapter } from '../src/adapters/node-npm.js';
import { simulate } from '../src/engine/index.js';
import { CLEAN_DIFF, FIXTURE, makeDiff, makeTarget, tmpBase } from './helpers.js';

const CONFIG = { twin: { services: { src: 'core' } } };
const build = (dir) => Twin.build(dir, nodeNpmAdapter, CONFIG);
/** Twin JSON without lastSyncedAt (the only field allowed to differ). */
const norm = (t) => {
  const j = t.toJSON();
  j.nodes = j.nodes.map(({ lastSyncedAt, ...rest }) => (void lastSyncedAt, rest));
  return j;
};

// ---- deterministic PRNG (mulberry32) ----
function prng(seed) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const PACKAGES = ['left-pad', 'lodash/fp', '@scope/util', 'node:fs', 'fs/promises', 'sample-app'];

async function codeFiles(dir) {
  const out = [];
  async function walk(d, rel) {
    for (const e of await readdir(d, { withFileTypes: true })) {
      const r = rel ? `${rel}/${e.name}` : e.name;
      if (e.isDirectory()) await walk(join(d, e.name), r);
      else if (/\.js$/.test(e.name)) out.push(r);
    }
  }
  await walk(dir, '');
  return out.sort();
}

function relSpec(from, to, rnd) {
  let s = posix.relative(posix.dirname(from), to);
  if (!s.startsWith('.')) s = `./${s}`;
  if (rnd() < 0.3) s = s.replace(/\.js$/, ''); // extensionless: exercises candidate resolution
  return s;
}

/** One random edit on disk; returns the changed paths. */
async function randomEdit(dir, rnd, n) {
  const pick = (xs) => xs[Math.floor(rnd() * xs.length)];
  const files = await codeFiles(dir);
  const imports = (from) => {
    const lines = [];
    const count = Math.floor(rnd() * 4);
    for (let i = 0; i < count; i++) {
      const r = rnd();
      if (r < 0.5 && files.length) lines.push(`import '${relSpec(from, pick(files), rnd)}';`);
      else if (r < 0.7) lines.push(`import '${relSpec(from, `src/gen/f${Math.floor(rnd() * (n + 3))}.js`, rnd)}';`); // may not exist yet
      else lines.push(`import '${pick(PACKAGES)}';`);
    }
    return `${lines.join('\n')}\nexport const v${n} = ${n};\n`;
  };
  const write = async (p, text) => { await mkdir(dirname(join(dir, p)), { recursive: true }); await writeFile(join(dir, p), text); };
  const op = rnd();
  if (op < 0.3 || files.length < 3) { // add a file (module, or sometimes a test)
    const p = rnd() < 0.2 ? `test/gen${n}.test.js` : `src/gen/f${n}.js`;
    await write(p, imports(p));
    return [p];
  }
  if (op < 0.45) { // delete a file
    const p = pick(files);
    await rm(join(dir, p));
    return [p];
  }
  if (op < 0.75) { // rewrite a file's imports
    const p = pick(files);
    await write(p, imports(p));
    return [p];
  }
  // add a package import, sometimes declaring it in package.json too
  const p = pick(files);
  const pkg = pick(PACKAGES);
  await writeFile(join(dir, p), `import '${pkg}';\n${await readFile(join(dir, p), 'utf8')}`);
  if (rnd() < 0.5 && !pkg.startsWith('node:') && !pkg.startsWith('fs')) {
    const manifest = JSON.parse(await readFile(join(dir, 'package.json'), 'utf8'));
    manifest.dependencies = { ...manifest.dependencies, [pkg.split('/').slice(0, pkg.startsWith('@') ? 2 : 1).join('/')]: '^1.0.0' };
    await writeFile(join(dir, 'package.json'), JSON.stringify(manifest, null, 2));
    return [p, 'package.json'];
  }
  return [p];
}

test('incremental applyChanges equals a full rebuild over 200 seeded random edits', async () => {
  let edits = 0;
  for (let seq = 0; seq < 20; seq++) {
    const rnd = prng(1000 + seq);
    const dir = await makeTarget();
    const twin = await build(dir);
    for (let step = 0; step < 10; step++, edits++) {
      const changed = await randomEdit(dir, rnd, seq * 100 + step);
      await twin.applyChanges(dir, changed);
      assert.deepEqual(norm(twin), norm(await build(dir)), `seq ${seq} step ${step} changed ${changed}`);
    }
  }
  assert.equal(edits, 200);
});

test('clone() is independent and JSON round-trips exactly', async () => {
  const t = await build(FIXTURE);
  const before = JSON.stringify(t.toJSON());
  const tp = t.clone();
  tp.ingestTelemetry([{ name: 'x', durationMs: 3, status: 'ok', attributes: { 'code.filepath': 'src/math.js' } }]);
  tp.nodes.get('src/greet.js').loc = 999;
  tp._addEdge('imports', 'src/math.js', 'src/greet.js');
  assert.equal(JSON.stringify(t.toJSON()), before);
  assert.deepEqual(Twin.fromJSON(JSON.parse(before)).toJSON(), t.toJSON());
});

test('model: node kinds, edges and properties on the fixture', async () => {
  const t = await build(FIXTURE);
  assert.deepEqual(t.stats().nodes, { config: 2, module: 5, service: 1, test: 3 });
  assert.deepEqual(t.stats().edges, { contains: 5, imports: 6, tests: 3 });
  const math = t.nodes.get('src/math.js');
  assert.equal(math.kind, 'module');
  assert.equal(math.loc, 3);
  assert.match(math.contentHash, /^[0-9a-f]{16}$/);
  assert.equal(math.telemetry, null);
  assert.match(t.nodes.get('package.json').configFingerprint, /^[0-9a-f]{16}$/);
});

test('reverseReachable and testsAffectedBy', async () => {
  const t = await build(FIXTURE);
  assert.deepEqual([...t.reverseReachable(['src/greet.js'])].sort(), ['src/cli.js', 'src/index.js', 'test/app.test.js', 'test/greet.test.js']);
  assert.deepEqual([...t.reverseReachable(['src/index.js'])].sort(), ['src/cli.js', 'test/app.test.js']);
  assert.deepEqual([...t.testsAffectedBy(['src/format.js'])], ['test/app.test.js']);
  assert.deepEqual([...t.testsAffectedBy(['src/math.js'])], ['test/math.test.js']);
  assert.deepEqual([...t.testsAffectedBy(['test/greet.test.js'])], ['test/greet.test.js']);
  assert.deepEqual([...t.testsAffectedBy(['README.md'])], []);
});

test('cycles are canonical regardless of start node', async () => {
  assert.deepEqual(canonicalCycle(['b', 'c', 'a']), canonicalCycle(['a', 'b', 'c']));
  assert.deepEqual(canonicalCycle(['c', 'a', 'b', 'c']), ['a', 'b', 'c']);
  const dir = await makeTarget({ files: {
    'src/a.js': "import './b.js';\n", 'src/b.js': "import './c.js';\n", 'src/c.js': "import './a.js';\n", 'src/self.js': "import './self.js';\n",
  } });
  const t = await build(dir);
  assert.deepEqual(t.findCycles(), [['src/a.js', 'src/b.js', 'src/c.js'], ['src/self.js']]);
  const again = await build(dir); // different insertion order cannot change the answer
  assert.deepEqual(again.findCycles(), t.findCycles());
});

test('unresolved imports and undeclared packages', async () => {
  const dir = await makeTarget({ files: { 'src/x.js': "import './missing.js';\nimport 'left-pad';\nimport 'node:fs';\nimport './math';\n" } });
  const t = await build(dir);
  assert.deepEqual(t.unresolvedImports(), [{ file: 'src/x.js', specifier: './missing.js' }]);
  assert.deepEqual(t.undeclaredPackages(), [{ file: 'src/x.js', pkg: 'left-pad' }]);
  assert.equal(t.edges.has('imports|src/x.js|src/math.js'), true);
});

test('telemetry ingestion: counts, error rate, buckets, p50 and p95', async () => {
  const t = await build(FIXTURE);
  const span = (durationMs, status = 'ok', attributes = { 'code.filepath': '/srv/app/src/math.js' }) => ({ name: 'add', durationMs, status, attributes });
  const spans = [
    ...Array.from({ length: 10 }, () => span(3)),
    ...Array.from({ length: 5 }, (_, i) => span(40, i < 2 ? 'error' : 'ok')),
    ...Array.from({ length: 4 }, () => span(200)),
    span(3000, 'error'),
    span(1, 'ok', { 'service.name': 'core' }),
    span(1, 'ok', { 'code.filepath': 'nowhere.js' }),
  ];
  assert.deepEqual(t.ingestTelemetry(spans), { matched: 21, unmatched: 1 });
  const tel = t.nodes.get('src/math.js').telemetry;
  assert.equal(tel.callCount, 20);
  assert.equal(tel.errorCount, 3);
  assert.equal(tel.errorCount / tel.callCount, 0.15);
  const counts = Object.fromEntries(tel.latencyBuckets.filter((b) => b.count).map((b) => [String(b.le), b.count]));
  assert.deepEqual(counts, { 5: 10, 50: 5, 250: 4, 5000: 1 });
  assert.equal(tel.p50, 5);
  assert.equal(tel.p95, 250);
  assert.equal(t.nodes.get('svc:core').telemetry.callCount, 1);
});

test('promote: T becomes the former T\'', async () => {
  const dir = await makeTarget();
  const t = await build(dir);
  const tp = t.clone();
  await writeFile(join(dir, 'src/extra.js'), "import './math.js';\n");
  await tp.applyChanges(dir, ['src/extra.js']);
  assert.notDeepEqual(norm(t), norm(tp));
  t.promote(tp);
  assert.deepEqual(t.toJSON(), tp.toJSON());
  tp.nodes.get('src/math.js').loc = -1; // still independent after promote
  assert.notEqual(t.nodes.get('src/math.js').loc, -1);
});

test('applyChanges touches only what changed', async () => {
  const dir = await makeTarget();
  const t = await build(dir);
  await writeFile(join(dir, 'src/math.js'), 'export function add(a, b) {\n  return b + a;\n}\n');
  assert.deepEqual({ ...(await t.applyChanges(dir, ['src/math.js'])), syncMs: 0 }, { nodesAdded: 0, nodesRemoved: 0, edgesAdded: 0, edgesRemoved: 0, syncMs: 0 });
  await writeFile(join(dir, 'src/extra.js'), "import './math.js';\n");
  const added = await t.applyChanges(dir, ['src/extra.js']);
  assert.deepEqual([added.nodesAdded, added.nodesRemoved, added.edgesAdded, added.edgesRemoved], [1, 0, 2, 0]); // imports + contains
  await rm(join(dir, 'src/greet.js'));
  const removed = await t.applyChanges(dir, ['src/greet.js']);
  // index->greet imports, greet.test->greet imports + tests, core->greet contains
  assert.deepEqual([removed.nodesAdded, removed.nodesRemoved, removed.edgesAdded, removed.edgesRemoved], [0, 1, 0, 4]);
  assert.equal(typeof removed.syncMs, 'number');
});

test('the engine reports twin mode, build and sync timings', async () => {
  const target = await makeTarget({ git: true });
  const twin = await simulate({ target, diff: CLEAN_DIFF, tmpRoot: await tmpBase() });
  assert.equal(twin.twinMode, 'twin');
  assert.equal(typeof twin.timings.twinBuildMs, 'number');
  assert.equal(typeof twin.timings.twinSyncMs, 'number');
  const plain = await simulate({ target, diff: CLEAN_DIFF, tmpRoot: await tmpBase(), config: { twin: { enabled: false } } });
  assert.equal(plain.twinMode, 'plain');
  assert.equal(plain.timings.twinBuildMs, 0);
  assert.equal(plain.timings.twinSyncMs, 0);
  const added = await simulate({ target, diff: await makeDiff(target, { 'src/new.js': "import './math.js';\n" }), tmpRoot: await tmpBase() });
  assert.equal(added.classification, 'Safe');
});

test('twin cache: memory per state key, optional disk persistence', async () => {
  clearTwinCache();
  const persistPath = await tmpBase();
  const opts = { stateKey: `test:${persistPath}`, dir: FIXTURE, adapter: nodeNpmAdapter, config: { twin: { persistPath } } };
  assert.equal((await loadTwin(opts)).source, 'built');
  assert.equal((await loadTwin(opts)).source, 'memory');
  assert.equal((await readdir(persistPath)).length, 1);
  clearTwinCache();
  const fromDisk = await loadTwin(opts);
  assert.equal(fromDisk.source, 'disk');
  assert.deepEqual(norm(fromDisk.twin), norm(await Twin.build(FIXTURE, nodeNpmAdapter, {})));
});
