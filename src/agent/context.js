/**
 * Context builder for the agent: the repository file tree, the files named in
 * the task text, and their import neighbors (direct imports and importers,
 * from the twin graph), all within a total character budget
 * (agent.contextBudgetChars). Priority when the budget is tight: named files,
 * then neighbors, then the tree (which gets at most a quarter of the budget).
 * Cut content is marked with "[... truncated N chars]".
 */
import { readdir, readFile } from 'node:fs/promises';
import { basename, join } from 'node:path';
import { SKIP_DIRS } from '../twin/parse.js';

const MARK = (n) => `\n[... truncated ${n} chars]\n`;

async function walk(root) {
  const out = [];
  async function go(dir, rel) {
    for (const e of await readdir(dir, { withFileTypes: true })) {
      if (SKIP_DIRS.has(e.name)) continue;
      const r = rel ? `${rel}/${e.name}` : e.name;
      if (e.isDirectory()) await go(join(dir, e.name), r);
      else if (e.isFile()) out.push(r);
    }
  }
  await go(root, '');
  return out.sort();
}

const escape = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

/** Files the task text mentions, by full path or by unambiguous file name. */
export function namedFiles(task, files) {
  return files.filter((f) => task.includes(f) || new RegExp(`(^|[\\s'"\`(/])${escape(basename(f))}($|[\\s'"\`),.:;])`).test(task)).sort();
}

/** Direct import neighbors (both directions) of `files`, code nodes only. */
export function importNeighbors(twin, files) {
  if (!twin) return [];
  const named = new Set(files);
  const out = new Set();
  for (const e of twin.edges.values()) {
    if (e.type !== 'imports' || !twin.specs.has(e.to)) continue;
    if (named.has(e.from) && !named.has(e.to)) out.add(e.to);
    if (named.has(e.to) && !named.has(e.from)) out.add(e.from);
  }
  return [...out].sort();
}

function fit(text, budget) {
  if (text.length <= budget) return text;
  const marker = MARK(text.length - budget);
  return budget > marker.length ? text.slice(0, budget - marker.length) + marker : '';
}

/**
 * @param {{dir: string, task: string, twin?: any, budgetChars?: number}} opts
 * @returns {Promise<{text: string, named: string[], neighbors: string[], truncated: boolean}>}
 */
export async function buildContext({ dir, task, twin, budgetChars = 24_000 }) {
  const files = twin ? [...twin.files].sort() : await walk(dir);
  const named = namedFiles(task, files);
  const neighbors = importNeighbors(twin, named);

  const treeFull = `File tree:\n${files.join('\n')}\n`;
  const tree = fit(treeFull, Math.min(treeFull.length, Math.floor(budgetChars / 4)));
  let left = budgetChars - tree.length;
  let truncated = tree.length < treeFull.length;
  const blocks = [];
  for (const [role, f] of [...named.map((f) => ['named', f]), ...neighbors.map((f) => ['neighbor', f])]) {
    const body = await readFile(join(dir, f), 'utf8').catch(() => '');
    const full = `\n=== ${f} (${role === 'named' ? 'named in task' : 'import neighbor'}) ===\n${body}`;
    const omitted = `\n[omitted ${f}: context budget exhausted]\n`;
    if (left >= full.length) { blocks.push(full); left -= full.length; continue; }
    truncated = true;
    const part = fit(full, left);
    if (part) { blocks.push(part); left -= part.length; } else if (left >= omitted.length) { blocks.push(omitted); left -= omitted.length; }
  }
  const text = (tree + blocks.join('')).slice(0, budgetChars);
  return { text, named, neighbors, truncated };
}
