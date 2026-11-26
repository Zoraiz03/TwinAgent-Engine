/**
 * Statistics for the evaluation, implemented in-house (no dependencies):
 * descriptive stats, seeded percentile bootstrap CIs, McNemar's test (exact
 * binomial for < 25 discordant pairs, else continuity-corrected chi-square),
 * Wilcoxon signed-rank (exact for n <= 30 without ties, else normal
 * approximation with tie and continuity correction), Cohen's h and odds ratio.
 */
import { prng } from './prng.js';

export const mean = (xs) => (xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : null);

/** Quantile with linear interpolation (R type 7 / numpy default). */
export function quantile(xs, q) {
  if (!xs.length) return null;
  const s = [...xs].sort((a, b) => a - b);
  const pos = (s.length - 1) * q;
  const lo = Math.floor(pos);
  return s[lo] + (s[Math.min(lo + 1, s.length - 1)] - s[lo]) * (pos - lo);
}
export const median = (xs) => quantile(xs, 0.5);

/** erf with ~1e-12 relative accuracy (series for small |x|, continued fraction for large). */
export function erf(x) {
  const ax = Math.abs(x);
  if (ax < 3) {
    let sum = ax;
    let term = ax;
    for (let n = 1; n < 200; n++) {
      term *= (-ax * ax) / n;
      const add = term / (2 * n + 1);
      sum += add;
      if (Math.abs(add) < 1e-17) break;
    }
    return Math.sign(x) * (2 / Math.sqrt(Math.PI)) * sum;
  }
  return Math.sign(x) * (1 - erfcLarge(ax));
}
function erfcLarge(x) {
  // Lentz continued fraction for erfc, x >= 3
  let f = x;
  let C = x;
  let D = 0;
  for (let n = 1; n < 200; n++) {
    const a = n / 2;
    D = x + a * D;
    D = 1 / D;
    C = x + a / C;
    const delta = C * D;
    f *= delta;
    if (Math.abs(delta - 1) < 1e-15) break;
  }
  return Math.exp(-x * x) / (f * Math.sqrt(Math.PI));
}
export const erfc = (x) => (Math.abs(x) >= 3 ? (x > 0 ? erfcLarge(x) : 2 - erfcLarge(-x)) : 1 - erf(x));
/** Two-sided p for a standard normal z. */
export const normalTwoSided = (z) => erfc(Math.abs(z) / Math.SQRT2);

/**
 * Percentile bootstrap CI.
 * @param {any[]} data  units to resample
 * @param {(sample: any[]) => number|null} stat
 * @param {{resamples?: number, seed?: number, alpha?: number}} [opts]
 */
export function bootstrapCI(data, stat, { resamples = 10_000, seed = 1, alpha = 0.05 } = {}) {
  const estimate = stat(data);
  if (!data.length || estimate === null) return { estimate, lo: null, hi: null, resamples, seed };
  const rnd = prng(seed);
  const values = [];
  const sample = new Array(data.length);
  for (let r = 0; r < resamples; r++) {
    for (let i = 0; i < data.length; i++) sample[i] = data[Math.floor(rnd() * data.length)];
    const v = stat(sample);
    if (v !== null && !Number.isNaN(v)) values.push(v);
  }
  return { estimate, lo: quantile(values, alpha / 2), hi: quantile(values, 1 - alpha / 2), resamples, seed };
}

function logChoose(n, k) {
  let s = 0;
  for (let i = 1; i <= k; i++) s += Math.log(n - k + i) - Math.log(i);
  return s;
}

/**
 * McNemar's test on discordant counts b (A yes, B no) and c (A no, B yes).
 * @returns {{b: number, c: number, n: number, statistic: number|null, p: number, method: 'exact'|'chi2-cc'}}
 */
export function mcnemar(b, c) {
  const n = b + c;
  if (n === 0) return { b, c, n, statistic: null, p: 1, method: 'exact' };
  if (n < 25) {
    let tail = 0;
    for (let k = 0; k <= Math.min(b, c); k++) tail += Math.exp(logChoose(n, k) - n * Math.LN2);
    return { b, c, n, statistic: null, p: Math.min(1, 2 * tail), method: 'exact' };
  }
  const statistic = (Math.abs(b - c) - 1) ** 2 / n;
  return { b, c, n, statistic, p: erfc(Math.sqrt(statistic / 2)), method: 'chi2-cc' };
}

/** McNemar from paired booleans [[a, b], ...]. */
export function mcnemarPaired(pairs) {
  let b = 0;
  let c = 0;
  for (const [x, y] of pairs) {
    if (x && !y) b++;
    else if (!x && y) c++;
  }
  return mcnemar(b, c);
}

/**
 * Wilcoxon signed-rank test for paired samples (zero differences dropped).
 * @returns {{n: number, wPlus: number, wMinus: number, statistic: number, z: number|null, p: number, method: 'exact'|'normal'}}
 */
export function wilcoxonSignedRank(x, y) {
  const d = x.map((v, i) => v - y[i]).filter((v) => v !== 0);
  const n = d.length;
  if (n === 0) return { n, wPlus: 0, wMinus: 0, statistic: 0, z: null, p: 1, method: 'exact' };
  const order = d.map((v, i) => ({ a: Math.abs(v), i })).sort((p, q) => p.a - q.a);
  const ranks = new Array(n);
  let ties = 0;
  for (let i = 0; i < n;) {
    let j = i;
    while (j + 1 < n && order[j + 1].a === order[i].a) j++;
    const r = (i + j + 2) / 2;
    for (let k = i; k <= j; k++) ranks[order[k].i] = r;
    const t = j - i + 1;
    if (t > 1) ties += t ** 3 - t;
    i = j + 1;
  }
  const wPlus = d.reduce((s, v, i) => s + (v > 0 ? ranks[i] : 0), 0);
  const wMinus = n * (n + 1) / 2 - wPlus;
  const statistic = Math.min(wPlus, wMinus);
  if (ties === 0 && n <= 30) {
    const max = n * (n + 1) / 2;
    const counts = new Array(max + 1).fill(0);
    counts[0] = 1;
    for (let k = 1; k <= n; k++) for (let s = max; s >= k; s--) counts[s] += counts[s - k];
    let tail = 0;
    for (let s = 0; s <= statistic; s++) tail += counts[s];
    return { n, wPlus, wMinus, statistic, z: null, p: Math.min(1, (2 * tail) / 2 ** n), method: 'exact' };
  }
  const mu = n * (n + 1) / 4;
  const sigma = Math.sqrt(n * (n + 1) * (2 * n + 1) / 24 - ties / 48);
  const z = (Math.abs(wPlus - mu) - 0.5) / sigma;
  return { n, wPlus, wMinus, statistic, z, p: Math.min(1, normalTwoSided(z)), method: 'normal' };
}

/** Cohen's h effect size between two proportions. */
export const cohenH = (p1, p2) => 2 * Math.asin(Math.sqrt(p1)) - 2 * Math.asin(Math.sqrt(p2));

/**
 * Odds ratio of a 2x2 table [[a, b], [c, d]] (rows = groups, cols = event yes/no),
 * with the Haldane-Anscombe 0.5 correction when a cell is zero, and a Woolf 95% CI.
 */
export function oddsRatio(a, b, c, d) {
  const corr = [a, b, c, d].some((v) => v === 0) ? 0.5 : 0;
  const [A, B, C, D] = [a + corr, b + corr, c + corr, d + corr];
  const or = (A * D) / (B * C);
  const se = Math.sqrt(1 / A + 1 / B + 1 / C + 1 / D);
  return { or, lo: Math.exp(Math.log(or) - 1.959964 * se), hi: Math.exp(Math.log(or) + 1.959964 * se), corrected: corr > 0 };
}
