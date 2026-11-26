import { test } from 'node:test';
import assert from 'node:assert/strict';
import { bootstrapCI, cohenH, erf, mcnemar, mcnemarPaired, mean, median, oddsRatio, quantile, wilcoxonSignedRank } from '../src/eval/stats.js';

const close = (a, b, tol = 1e-9) => assert.ok(Math.abs(a - b) <= tol * Math.max(1, Math.abs(b)), `${a} != ${b}`);

test('descriptive statistics', () => {
  assert.equal(mean([1, 2, 3, 4]), 2.5);
  assert.equal(median([5, 1, 3]), 3);
  assert.equal(median([1, 2, 3, 4]), 2.5);
  close(quantile([1, 2, 3, 4, 5, 6, 7, 8, 9, 10], 0.95), 9.55); // numpy.percentile(..., 95)
  close(erf(0.5), 0.5204998778130465);
  close(erf(3.5), 0.9999992569016276);
});

test('McNemar: exact binomial for few discordant pairs (b=10, c=2)', () => {
  const r = mcnemar(10, 2);
  assert.equal(r.method, 'exact');
  close(r.p, 158 / 4096); // 2 * (C(12,0)+C(12,1)+C(12,2)) / 2^12
  assert.equal(mcnemar(3, 3).p, 1);
  assert.deepEqual(mcnemarPaired([[true, false], [true, false], [false, true], [true, true]]).b, 2);
});

test('McNemar: continuity-corrected chi-square (Wikipedia example b=121, c=59)', () => {
  const r = mcnemar(121, 59);
  assert.equal(r.method, 'chi2-cc');
  close(r.statistic, 3721 / 180);
  close(r.p, 5.450094825427124e-6, 1e-6);
});

test('Wilcoxon signed-rank: Wikipedia example with ties (normal approximation)', () => {
  const x = [125, 115, 130, 140, 140, 115, 140, 125, 140, 135];
  const y = [110, 122, 125, 120, 140, 124, 123, 137, 135, 145];
  const r = wilcoxonSignedRank(x, y);
  assert.equal(r.n, 9);
  assert.equal(r.wPlus, 27);
  assert.equal(r.wMinus, 18);
  assert.equal(r.method, 'normal');
  close(r.z, 0.4742953333830018);
  close(r.p, 0.6352893188352069, 1e-8);
});

test('Wilcoxon signed-rank: exact distribution without ties', () => {
  const r = wilcoxonSignedRank([2, 3, 4, 5, 6], [1, 1, 1, 1, 1]);
  assert.equal(r.method, 'exact');
  assert.equal(r.statistic, 0);
  close(r.p, 2 / 32);
  // n=6, W- = 1 (one rank-1 negative): P(W <= 1) = 2/64 -> p = 4/64
  close(wilcoxonSignedRank([0, 2, 3, 4, 5, 6], [1, 0, 0, 0, 0, 0]).p, 4 / 64);
});

test('effect sizes', () => {
  close(cohenH(0.5, 0.2), 0.6435011087932846);
  const or = oddsRatio(10, 20, 30, 40); // (10*40)/(20*30)
  close(or.or, 2 / 3);
  assert.equal(or.corrected, false);
  close(oddsRatio(0, 10, 5, 5).or, (0.5 * 5.5) / (10.5 * 5.5));
});

test('bootstrap CI is reproducible from its seed and brackets the estimate', () => {
  const data = Array.from({ length: 40 }, (_, i) => (i % 4 === 0 ? 1 : 0));
  const a = bootstrapCI(data, mean, { seed: 42, resamples: 2000 });
  const b = bootstrapCI(data, mean, { seed: 42, resamples: 2000 });
  assert.deepEqual(a, b);
  assert.equal(a.estimate, 0.25);
  assert.ok(a.lo < 0.25 && a.hi > 0.25 && a.lo >= 0 && a.hi <= 1);
  assert.notDeepEqual(bootstrapCI(data, mean, { seed: 7, resamples: 2000 }), a);
});
