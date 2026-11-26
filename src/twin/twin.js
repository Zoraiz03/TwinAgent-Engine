/**
 * Software Digital Twin G = (V, E, P) of a target codebase.
 *
 * V (node kinds): "module" (source file), "test" (test file), "package"
 *   (external dependency, id "pkg:<name>"), "service" (from config
 *   twin.services { dir: name }, id "svc:<name>"), "config" (manifests and
 *   tool config files). A source file with a config name (eslint.config.js)
 *   is a "config" node that is still parsed for imports.
 * E (directed): "imports" (code -> code | package), "tests" (test -> module it
 *   imports directly), "contains" (service -> module), "dependsOn" (code ->
 *   declared package). An import of an undeclared package has an "imports"
 *   edge but no "dependsOn".
 * P (per node): { path, kind, contentHash, loc, lastSyncedAt,
 *   configFingerprint, telemetry }.
 *
 * Updates are incremental: applyChanges() re-reads only the changed paths,
 * re-resolves only imports whose resolution candidates were added/removed,
 * and patches edges by difference. Twin.build() is applyChanges() over every
 * file of an empty twin, so the two can be checked against each other.
 * Everything is JSON-serializable (toJSON / fromJSON); clone() is a deep copy.
 */
import { createHash } from 'node:crypto';
import { lstat, readdir, readFile } from 'node:fs/promises';
import { basename, join } from 'node:path';
import { candidates, findCycles, isSource, isTestFile, packageName, parseImports, SKIP_DIRS } from './parse.js';

const CONFIG_NAME = /^(tsconfig|jsconfig)(\..+)?\.json$|^\.(eslintrc|babelrc|prettierrc|npmrc|nvmrc)(\..*)?$|\.config\.[cm]?[jt]s$|^babel\.config\.json$/;
/** Fixed latency buckets (ms upper bounds); the last one is +Inf (serialized as null). */
export const LATENCY_BUCKETS = [5, 10, 25, 50, 100, 250, 500, 1000, 2500, 5000, Infinity];

const edgeKey = (type, from, to) => `${type}|${from}|${to}`;
const sha = (data) => createHash('sha256').update(data).digest('hex').slice(0, 16);
const pkgId = (name) => `pkg:${name}`;
const svcId = (name) => `svc:${name}`;
const sorted = (it) => [...it].sort();

function canonicalJson(v) {
  if (Array.isArray(v)) return `[${v.map(canonicalJson).join(',')}]`;
  if (v && typeof v === 'object') return `{${Object.keys(v).sort().map((k) => `${JSON.stringify(k)}:${canonicalJson(v[k])}`).join(',')}}`;
  return JSON.stringify(v);
}

/**
 * Rotate a cycle path so it starts at its smallest node: the same cycle found
 * from different start nodes compares equal.
 * @param {string[]} cycle
 */
export function canonicalCycle(cycle) {
  const ring = cycle.length > 1 && cycle[0] === cycle.at(-1) ? cycle.slice(0, -1) : cycle;
  const min = ring.indexOf([...ring].sort()[0]);
  return [...ring.slice(min), ...ring.slice(0, min)];
}

async function walkFiles(root) {
  const out = [];
  async function walk(dir, rel) {
    for (const e of await readdir(dir, { withFileTypes: true })) {
      if (SKIP_DIRS.has(e.name)) continue;
      const r = rel ? `${rel}/${e.name}` : e.name;
      if (e.isDirectory()) await walk(join(dir, e.name), r);
      else if (e.isFile()) out.push(r);
    }
  }
  await walk(root, '');
  return out.sort();
}

export class Twin {
  constructor({ manifestFiles = ['package.json'], services = {} } = {}) {
    /** @type {Map<string, any>} */ this.nodes = new Map();
    /** @type {Map<string, {type: string, from: string, to: string}>} */ this.edges = new Map();
    /** @type {Map<string, Set<string>>} */ this.out = new Map();
    /** @type {Map<string, Set<string>>} */ this.inn = new Map();
    /** All regular files (resolution universe). */ this.files = new Set();
    /** code file -> { relative, bare } import specifiers */ this.specs = new Map();
    /** code file -> unresolved relative specifiers */ this.unresolved = new Map();
    this.deps = new Set(); // declared dependency names (all dependency fields)
    this.selfName = null;
    this.manifestFiles = manifestFiles;
    this.services = services;
    this._delta = null;
  }

  /**
   * Build the twin of `dir` (read-only).
   * @param {string} dir @param {{manifestFiles?: () => string[]}} [adapter] @param {any} [config]
   */
  static async build(dir, adapter, config) {
    const twin = new Twin({ manifestFiles: adapter?.manifestFiles?.() ?? ['package.json'], services: config?.twin?.services ?? {} });
    await twin.applyChanges(dir, await walkFiles(dir));
    return twin;
  }

  // ---- primitive mutations (counted while a sync is running) ----
  _count(field) { if (this._delta) this._delta[field]++; }
  _addNode(id, props) { if (!this.nodes.has(id)) this._count('nodesAdded'); this.nodes.set(id, props); }
  _removeNode(id) {
    if (!this.nodes.has(id)) return;
    for (const k of [...(this.out.get(id) ?? []), ...(this.inn.get(id) ?? [])]) this._removeEdge(k);
    this.nodes.delete(id); this.out.delete(id); this.inn.delete(id);
    this._count('nodesRemoved');
  }
  _addEdge(type, from, to) {
    const k = edgeKey(type, from, to);
    if (this.edges.has(k)) return;
    this.edges.set(k, { type, from, to });
    if (!this.out.has(from)) this.out.set(from, new Set());
    if (!this.inn.has(to)) this.inn.set(to, new Set());
    this.out.get(from).add(k); this.inn.get(to).add(k);
    this._count('edgesAdded');
  }
  _removeEdge(k) {
    const e = this.edges.get(k);
    if (!e) return;
    this.edges.delete(k); this.out.get(e.from)?.delete(k); this.inn.get(e.to)?.delete(k);
    this._count('edgesRemoved');
  }

  _kindOf(path) {
    const name = basename(path);
    if (CONFIG_NAME.test(name) || this.manifestFiles.includes(name)) return 'config';
    if (!isSource(path)) return null;
    return isTestFile(path) ? 'test' : 'module';
  }

  async _syncFile(dir, path, now) {
    const kind = this._kindOf(path);
    if (!kind) return false;
    const buf = await readFile(join(dir, path));
    const text = buf.toString('utf8');
    let configFingerprint = null;
    if (kind === 'config') {
      try { configFingerprint = sha(canonicalJson(JSON.parse(text))); } catch { configFingerprint = sha(text.replace(/\s+/g, ' ').trim()); }
    }
    this._addNode(path, {
      path, kind, contentHash: sha(buf),
      loc: text === '' ? 0 : text.split('\n').length - (text.endsWith('\n') ? 1 : 0),
      lastSyncedAt: now, configFingerprint,
      telemetry: this.nodes.get(path)?.telemetry ?? null,
    });
    if (!isSource(path)) return false;
    const specs = new Set(parseImports(text));
    this.specs.set(path, {
      relative: sorted([...specs].filter((s) => s.startsWith('.'))),
      bare: sorted([...specs].filter((s) => !s.startsWith('.'))),
    });
    return true;
  }

  _dropFile(path) {
    this._removeNode(path);
    this.specs.delete(path);
    this.unresolved.delete(path);
  }

  async _readManifest(dir) {
    try {
      const pkg = JSON.parse(await readFile(join(dir, 'package.json'), 'utf8'));
      const deps = new Set();
      for (const f of ['dependencies', 'devDependencies', 'peerDependencies', 'optionalDependencies']) Object.keys(pkg[f] ?? {}).forEach((n) => deps.add(n));
      return { selfName: pkg.name ?? null, deps };
    } catch {
      return { selfName: null, deps: new Set() };
    }
  }

  _isDeclared(pkg) { return this.deps.has(pkg) || pkg === this.selfName; }

  _resolve(from, spec) {
    for (const c of candidates(from, spec)) if (this.files.has(c)) return c;
    return null;
  }

  _ensurePackage(name, now) {
    const id = pkgId(name);
    if (!this.nodes.has(id)) {
      this._addNode(id, { path: `node_modules/${name}`, kind: 'package', contentHash: null, loc: 0, lastSyncedAt: now, configFingerprint: null, telemetry: null });
    }
    return id;
  }

  /** Recompute one code file's outgoing imports/tests/dependsOn edges, patching by difference. */
  _relink(file, now) {
    const node = this.nodes.get(file);
    const { relative, bare } = this.specs.get(file);
    const want = new Map();
    const unres = [];
    for (const spec of relative) {
      const r = this._resolve(file, spec);
      if (!r) { unres.push(spec); continue; }
      if (!this.specs.has(r)) continue; // resolves to a non-code file (json etc.)
      want.set(edgeKey('imports', file, r), ['imports', file, r]);
      if (node.kind === 'test' && this.nodes.get(r)?.kind === 'module') want.set(edgeKey('tests', file, r), ['tests', file, r]);
    }
    for (const spec of bare) {
      const name = packageName(spec);
      if (!name) continue;
      const id = this._ensurePackage(name, now);
      want.set(edgeKey('imports', file, id), ['imports', file, id]);
      if (this._isDeclared(name)) want.set(edgeKey('dependsOn', file, id), ['dependsOn', file, id]);
    }
    for (const k of [...(this.out.get(file) ?? [])]) if (!want.has(k)) this._removeEdge(k);
    for (const [k, [t, f, to]] of want) if (!this.edges.has(k)) this._addEdge(t, f, to);
    if (unres.length) this.unresolved.set(file, unres);
    else this.unresolved.delete(file);
  }

  _syncPackages(now) {
    for (const name of this.deps) this._ensurePackage(name, now);
    for (const [id, n] of [...this.nodes]) {
      if (n.kind === 'package' && !this.deps.has(id.slice(4)) && !(this.inn.get(id)?.size)) this._removeNode(id);
    }
  }

  _syncServices(now) {
    for (const [dir, name] of Object.entries(this.services)) {
      const id = svcId(name);
      if (!this.nodes.has(id)) this._addNode(id, { path: dir, kind: 'service', contentHash: null, loc: 0, lastSyncedAt: now, configFingerprint: null, telemetry: null });
      const prefix = dir.replace(/\/$/, '') + '/';
      const want = new Set();
      for (const [nid, n] of this.nodes) if (n.kind === 'module' && nid.startsWith(prefix)) want.add(edgeKey('contains', id, nid));
      for (const k of [...(this.out.get(id) ?? [])]) if (!want.has(k)) this._removeEdge(k);
      for (const k of want) if (!this.edges.has(k)) this._addEdge('contains', id, k.split('|')[2]);
    }
  }

  /**
   * Incrementally sync the twin with `dir` after `changedFiles` changed
   * (added, edited or deleted; paths relative to dir).
   * @param {string} dir @param {string[]} changedFiles
   * @returns {Promise<{nodesAdded: number, nodesRemoved: number, edgesAdded: number, edgesRemoved: number, syncMs: number}>}
   */
  async applyChanges(dir, changedFiles) {
    const start = performance.now();
    const now = new Date().toISOString();
    this._delta = { nodesAdded: 0, nodesRemoved: 0, edgesAdded: 0, edgesRemoved: 0 };
    try {
      const paths = [...new Set(changedFiles.map((p) => p.replace(/^\.\//, '')))]
        .filter((p) => p && !p.split('/').some((seg) => SKIP_DIRS.has(seg)));
      const moved = new Set(); // paths that appeared or disappeared
      const affected = new Set();
      for (const p of paths) {
        const st = await lstat(join(dir, p)).catch(() => null);
        if (st?.isFile()) {
          if (!this.files.has(p)) { this.files.add(p); moved.add(p); }
          if (await this._syncFile(dir, p, now)) affected.add(p);
        } else {
          if (this.files.delete(p)) moved.add(p);
          this._dropFile(p);
        }
      }
      if (paths.includes('package.json')) {
        const m = await this._readManifest(dir);
        const changed = m.selfName !== this.selfName || m.deps.size !== this.deps.size || [...m.deps].some((d) => !this.deps.has(d));
        this.selfName = m.selfName;
        this.deps = m.deps;
        if (changed) for (const f of this.specs.keys()) affected.add(f);
      }
      if (moved.size) {
        for (const [f, s] of this.specs) {
          if (!affected.has(f) && s.relative.some((spec) => candidates(f, spec).some((c) => moved.has(c)))) affected.add(f);
        }
      }
      for (const f of affected) if (this.specs.has(f)) this._relink(f, now);
      this._syncPackages(now);
      this._syncServices(now);
      return { ...this._delta, syncMs: Math.round((performance.now() - start) * 100) / 100 };
    } finally {
      this._delta = null;
    }
  }

  // ---- queries ----
  _importAdj(reverse) {
    const adj = new Map();
    for (const e of this.edges.values()) {
      if (e.type !== 'imports' || !this.specs.has(e.to)) continue;
      const [a, b] = reverse ? [e.to, e.from] : [e.from, e.to];
      if (!adj.has(a)) adj.set(a, new Set());
      adj.get(a).add(b);
    }
    return adj;
  }

  _reach(files, reverse) {
    const adj = this._importAdj(reverse);
    const seen = new Set();
    const queue = [...files];
    while (queue.length) {
      for (const n of adj.get(queue.pop()) ?? []) if (!seen.has(n)) { seen.add(n); queue.push(n); }
    }
    return seen;
  }

  /** Code nodes that transitively import any of `files` (a seed is included only if it is on a cycle). */
  reverseReachable(files) { return this._reach(files, true); }

  /** Code nodes transitively imported by `files`. */
  forwardReachable(files) { return this._reach(files, false); }

  /** Test nodes whose import closure (including themselves) contains any of `files`. */
  testsAffectedBy(files) {
    const hit = new Set([...files, ...this.reverseReachable(files)]);
    return new Set([...hit].filter((id) => this.nodes.get(id)?.kind === 'test'));
  }

  /** Import cycles among code nodes, each as a sorted member list; list sorted. */
  findCycles() {
    return findCycles(this._importAdj(false)).sort((a, b) => a.join('|').localeCompare(b.join('|')));
  }

  /** @returns {Array<{file: string, specifier: string}>} */
  unresolvedImports() {
    return sorted(this.unresolved.keys()).flatMap((file) => this.unresolved.get(file).map((specifier) => ({ file, specifier })));
  }

  /** @returns {Array<{file: string, pkg: string}>} */
  undeclaredPackages() {
    const out = [];
    for (const e of this.edges.values()) {
      if (e.type === 'imports' && e.to.startsWith('pkg:') && !this.edges.has(edgeKey('dependsOn', e.from, e.to))) out.push({ file: e.from, pkg: e.to.slice(4) });
    }
    return out.sort((a, b) => `${a.file}|${a.pkg}`.localeCompare(`${b.file}|${b.pkg}`));
  }

  /** Graph facts in the shape psi3 consumes (same as parse.buildGraph). */
  toGraph() {
    return {
      files: new Set(this.specs.keys()),
      edges: new Map([...this.specs.keys()].map((f) => [f, new Set(this._importAdj(false).get(f) ?? [])])),
      unresolved: this.unresolvedImports(),
      undeclared: this.undeclaredPackages(),
    };
  }

  /**
   * Ingest OpenTelemetry-shaped spans: { name, durationMs, status: "ok"|"error",
   * attributes: { "code.filepath"?, "service.name"? } }. code.filepath may be
   * relative or absolute (matched by longest path suffix). Latency goes into
   * LATENCY_BUCKETS; p50/p95 are nearest-rank estimates from the histogram
   * (bucket upper bound; the +Inf bucket reports the max seen).
   * @returns {{matched: number, unmatched: number}}
   */
  ingestTelemetry(spans) {
    let matched = 0;
    let unmatched = 0;
    for (const span of spans) {
      const targets = [];
      const fp = span.attributes?.['code.filepath'];
      if (fp) {
        const norm = String(fp).replace(/\\/g, '/');
        const hit = [...this.nodes.keys()]
          .filter((id) => !id.includes(':') && (norm === id || norm.endsWith(`/${id}`)))
          .sort((a, b) => b.length - a.length)[0];
        if (hit) targets.push(hit);
      }
      const svc = span.attributes?.['service.name'];
      if (svc && this.nodes.has(svcId(svc))) targets.push(svcId(svc));
      if (!targets.length) { unmatched++; continue; }
      matched++;
      for (const id of targets) this._record(this.nodes.get(id), span);
    }
    return { matched, unmatched };
  }

  _record(node, span) {
    const t = node.telemetry ?? (node.telemetry = {
      callCount: 0, errorCount: 0,
      latencyBuckets: LATENCY_BUCKETS.map((le) => ({ le: le === Infinity ? null : le, count: 0 })),
      p50: null, p95: null, maxMs: 0,
    });
    const d = Number(span.durationMs) || 0;
    t.callCount++;
    if (span.status === 'error') t.errorCount++;
    t.maxMs = Math.max(t.maxMs, d);
    t.latencyBuckets[LATENCY_BUCKETS.findIndex((le) => d <= le)].count++;
    const pct = (q) => {
      const rank = Math.ceil(q * t.callCount);
      let cum = 0;
      for (const b of t.latencyBuckets) {
        cum += b.count;
        if (cum >= rank) return b.le ?? t.maxMs;
      }
      return t.maxMs;
    };
    t.p50 = pct(0.5);
    t.p95 = pct(0.95);
  }

  /** UpdateTwin: after a Safe commit, adopt T' as the new T. */
  promote(twinPrime) {
    Object.assign(this, twinPrime.clone());
    return this;
  }

  /** Node and edge counts per kind/type. */
  stats() {
    const nodes = {};
    const edges = {};
    for (const n of this.nodes.values()) nodes[n.kind] = (nodes[n.kind] ?? 0) + 1;
    for (const e of this.edges.values()) edges[e.type] = (edges[e.type] ?? 0) + 1;
    return { nodes, edges, totalNodes: this.nodes.size, totalEdges: this.edges.size };
  }

  toJSON() {
    return {
      version: 1,
      nodes: sorted(this.nodes.keys()).map((id) => ({ id, ...this.nodes.get(id) })),
      edges: sorted(this.edges.keys()).map((k) => this.edges.get(k)),
      index: {
        files: sorted(this.files),
        specs: Object.fromEntries(sorted(this.specs.keys()).map((f) => [f, this.specs.get(f)])),
        unresolved: Object.fromEntries(sorted(this.unresolved.keys()).map((f) => [f, this.unresolved.get(f)])),
        deps: sorted(this.deps),
        selfName: this.selfName,
        manifestFiles: this.manifestFiles,
        services: this.services,
      },
    };
  }

  static fromJSON(json) {
    const { index } = json;
    const twin = new Twin({ manifestFiles: index.manifestFiles, services: index.services });
    for (const { id, ...props } of json.nodes) twin.nodes.set(id, props);
    for (const e of json.edges) twin._addEdge(e.type, e.from, e.to);
    twin.files = new Set(index.files);
    twin.specs = new Map(Object.entries(index.specs));
    twin.unresolved = new Map(Object.entries(index.unresolved));
    twin.deps = new Set(index.deps);
    twin.selfName = index.selfName;
    return twin;
  }

  /** Independent deep copy (T' = clone(T)). */
  clone() {
    return Twin.fromJSON(JSON.parse(JSON.stringify(this.toJSON())));
  }
}
