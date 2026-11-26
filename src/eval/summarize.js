/**
 * Summarize one or more run directories (each with actions.jsonl and
 * manifest.json) into results.json, CSVs and LaTeX tables.
 */
import { join } from 'node:path';
import { loadConfig } from '../engine/index.js';
import { readManifest } from './manifest.js';
import { computeMetrics, readLog } from './metrics.js';
import { writeOutputs } from './report.js';

export async function summarize(runDirs, out, { resamples, seed = 1 } = {}) {
  const cfg = await loadConfig();
  const records = [];
  const runs = [];
  for (const dir of runDirs) {
    records.push(...(await readLog(join(dir, 'actions.jsonl'))));
    const m = await readManifest(dir).catch(() => null);
    runs.push({ dir, manifest: m && { evalType: m.evalType, mode: m.mode, seed: m.seed, configHash: m.configHash, engineCommit: m.engineCommit, modelId: m.modelId, targetStateKey: m.targetStateKey } });
  }
  const metrics = computeMetrics(records, { resamples: resamples ?? cfg.eval?.bootstrapResamples ?? 10_000, seed, pricing: cfg.eval?.pricing });
  const written = await writeOutputs(metrics, out, { runs });
  return { metrics, written };
}
