/**
 * Twin graph G=(V,E,P): V = code/dependency nodes, E = edges (imports, calls,
 * depends-on), P = behavior properties attached to nodes (e.g. test coverage,
 * latency baseline). Also holds sync logic that keeps the twin consistent with
 * the real codebase after a committed change. Stubbed: sync is a no-op.
 */

/**
 * @typedef {object} TwinGraph
 * @property {Map<string, Record<string, unknown>>} V  node id -> properties P
 * @property {Array<{from: string, to: string, kind: string}>} E
 */

/** @returns {TwinGraph} */
export function createGraph() {
  return { V: new Map(), E: [] };
}

/** @param {TwinGraph} g @param {string} id @param {Record<string, unknown>} [props] */
export function addNode(g, id, props = {}) {
  g.V.set(id, props);
  return g;
}

/** @param {TwinGraph} g @param {string} from @param {string} to @param {string} [kind] */
export function addEdge(g, from, to, kind = 'depends') {
  g.E.push({ from, to, kind });
  return g;
}

/**
 * Sync the twin with a diff. Stub: returns the graph unchanged.
 * @param {TwinGraph} g @param {string} _diff
 */
export async function sync(g, _diff) {
  return g;
}
