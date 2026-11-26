/**
 * Write metrics to disk: results.json, per-metric CSV files and LaTeX tabular
 * snippets (tables/*.tex). Rounding is consistent everywhere: proportions and
 * rates 3 decimals, milliseconds 1 decimal, p-values 4 decimals ("<0.0001"
 * below that), effect sizes 3 decimals.
 */
import { mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';

const r3 = (x) => (x === null || x === undefined || Number.isNaN(x) ? '' : Number(x).toFixed(3));
const r1 = (x) => (x === null || x === undefined ? '' : Number(x).toFixed(1));
const rp = (p) => (p === null || p === undefined ? '' : p < 1e-4 ? '<0.0001' : Number(p).toFixed(4));
const csvCell = (v) => (/[",\n]/.test(String(v)) ? `"${String(v).replace(/"/g, '""')}"` : String(v));
const csv = (header, rows) => `${[header, ...rows].map((r) => r.map(csvCell).join(',')).join('\n')}\n`;
const tex = (s) => String(s).replace(/([&%$#_{}])/g, '\\$1').replace(/~/g, '\\textasciitilde{}');
const ciText = (m) => (m?.estimate === null || m?.estimate === undefined ? '--' : `${r3(m.estimate)} [${r3(m.lo)}, ${r3(m.hi)}]`);

function table(caption, cols, rows) {
  return [
    `% ${caption}`,
    `\\begin{tabular}{${cols.map((_, i) => (i < 2 ? 'l' : 'r')).join('')}}`,
    '\\toprule',
    `${cols.map(tex).join(' & ')} \\\\`,
    '\\midrule',
    ...rows.map((r) => `${r.map((c) => tex(c === '' ? '--' : c)).join(' & ')} \\\\`),
    '\\bottomrule',
    '\\end{tabular}',
    '',
  ].join('\n');
}

export async function writeOutputs(metrics, outDir, extra = {}) {
  await mkdir(join(outDir, 'tables'), { recursive: true });
  await writeFile(join(outDir, 'results.json'), `${JSON.stringify({ ...metrics, ...extra }, null, 2)}\n`);
  const g = metrics.groups;

  const ratesHeader = ['mode', 'category', 'n', 'labeled', 'executed', 'hcr_exec', 'hcr_exec_lo', 'hcr_exec_hi', 'hcr_final', 'hcr_final_lo', 'hcr_final_hi', 'verdict_accuracy', 'verdict_accuracy_lo', 'verdict_accuracy_hi', 'completion_rate', 'label_agreement', 'excluded_psi4_pending'];
  const ratesRows = g.map((x) => [x.mode, x.category, x.n, x.labeled, x.executed, r3(x.hcrExec.estimate), r3(x.hcrExec.lo), r3(x.hcrExec.hi), r3(x.hcrFinal.estimate), r3(x.hcrFinal.lo), r3(x.hcrFinal.hi), r3(x.verdictAccuracy.estimate), r3(x.verdictAccuracy.lo), r3(x.verdictAccuracy.hi), r3(x.completionRate), r3(x.labelAgreement.rate), x.excludedPsi4Pending]);
  const confHeader = ['mode', 'category', 'psi', 'tp', 'fp', 'tn', 'fn', 'inconclusive', 'no_prediction', 'precision', 'recall', 'f1', 'fpr', 'fnr'];
  const confRows = g.flatMap((x) => Object.entries(x.confusion).map(([psi, c]) => [x.mode, x.category, psi, c.tp, c.fp, c.tn, c.fn, c.inconclusive, c.noPrediction, r3(c.precision), r3(c.recall), r3(c.f1), r3(c.fpr), r3(c.fnr)]));
  const latHeader = ['mode', 'category', 'n', 'mean_ms', 'median_ms', 'p95_ms', 'added_vs_direct_mean_ms', 'tokens_total', 'tokens_per_action', 'cost_total', 'retries_mean'];
  const latRows = g.map((x) => [x.mode, x.category, x.n, r1(x.latency.mean), r1(x.latency.median), r1(x.latency.p95), r1(x.addedLatencyVsDirect?.mean), x.tokens.total, r1(x.tokens.meanPerAction), r3(x.cost.total), r3(x.retries.mean)]);
  const escRows = g.flatMap((x) => Object.entries(x.escalationRate).map(([reason, v]) => [x.mode, x.category, reason, r3(v)]));
  const revRows = g.flatMap((x) => Object.entries(x.reviseSuccess).map(([m, v]) => [x.mode, x.category, m, v.n, r3(v.rate)]));
  const pwHeader = ['mode_a', 'mode_b', 'n_pairs', 'hcr_final_a', 'hcr_final_b', 'mcnemar_b', 'mcnemar_c', 'mcnemar_p', 'mcnemar_method', 'cohen_h', 'odds_ratio', 'completion_mcnemar_p', 'latency_median_a_ms', 'latency_median_b_ms', 'wilcoxon_p', 'wilcoxon_method'];
  const pwRows = metrics.pairwise.map((p) => [p.modeA, p.modeB, p.nPairs, r3(p.harmfulFinal.rateA), r3(p.harmfulFinal.rateB), p.harmfulFinal.mcnemar.b, p.harmfulFinal.mcnemar.c, rp(p.harmfulFinal.mcnemar.p), p.harmfulFinal.mcnemar.method, r3(p.harmfulFinal.cohenH), r3(p.harmfulFinal.oddsRatio.or), rp(p.completion.mcnemar.p), r1(p.latency.medianA), r1(p.latency.medianB), rp(p.latency.wilcoxon.p), p.latency.wilcoxon.method]);

  const files = {
    'rates.csv': csv(ratesHeader, ratesRows),
    'confusion.csv': csv(confHeader, confRows),
    'latency.csv': csv(latHeader, latRows),
    'escalations.csv': csv(['mode', 'category', 'reason', 'rate'], escRows),
    'revise.csv': csv(['mode', 'category', 'reformulate_mode', 'n', 'success_rate'], revRows),
    'pairwise.csv': csv(pwHeader, pwRows),
  };
  const all = g.filter((x) => x.category === 'all');
  const tables = {
    'rates.tex': table('Harmful change rates and verdict accuracy (95% bootstrap CI)', ['Mode', 'n', 'HCR exec', 'HCR final', 'Verdict acc.', 'Completion'],
      all.map((x) => [x.mode, String(x.n), ciText(x.hcrExec), ciText(x.hcrFinal), ciText(x.verdictAccuracy), r3(x.completionRate)])),
    'confusion.tex': table('Per-check confusion (all categories)', ['Mode', 'Check', 'TP', 'FP', 'TN', 'FN', 'Prec.', 'Rec.', 'F1'],
      all.flatMap((x) => Object.entries(x.confusion).filter(([, c]) => c.tp + c.fp + c.tn + c.fn > 0).map(([psi, c]) => [x.mode, psi, c.tp, c.fp, c.tn, c.fn, r3(c.precision), r3(c.recall), r3(c.f1)].map(String)))),
    'latency.tex': table('Latency per action (ms)', ['Mode', 'n', 'Mean', 'Median', 'p95', 'Added vs direct'],
      all.map((x) => [x.mode, String(x.n), r1(x.latency.mean), r1(x.latency.median), r1(x.latency.p95), r1(x.addedLatencyVsDirect?.mean)])),
    'pairwise.tex': table('Paired comparisons (HCR final: McNemar, Cohen h; latency: Wilcoxon)', ['Mode A', 'Mode B', 'Pairs', 'McNemar p', 'Cohen h', 'Wilcoxon p'],
      metrics.pairwise.map((p) => [p.modeA, p.modeB, String(p.nPairs), rp(p.harmfulFinal.mcnemar.p), r3(p.harmfulFinal.cohenH), rp(p.latency.wilcoxon.p)])),
  };
  for (const [name, text] of Object.entries(files)) await writeFile(join(outDir, name), text);
  for (const [name, text] of Object.entries(tables)) await writeFile(join(outDir, 'tables', name), text);
  return { files: Object.keys(files), tables: Object.keys(tables).map((t) => `tables/${t}`) };
}
