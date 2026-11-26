/**
 * Evaluation layer: labeled fault injection, the inject/agent harness, run
 * manifests, metrics, statistics and report writers.
 */
export { generate, generateWithReport, CATEGORIES } from './fault-injection.js';
export { runInjectEval, runAgentEval } from './harness.js';
export { computeMetrics, readLog } from './metrics.js';
export { summarize } from './summarize.js';
export * as stats from './stats.js';
