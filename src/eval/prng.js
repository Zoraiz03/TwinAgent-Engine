/**
 * Seeded PRNG (mulberry32) and helpers. Every random choice in the evaluation
 * goes through this, so results are reproducible from a seed.
 */

/** @param {number} seed @returns {() => number} uniform in [0, 1) */
export function prng(seed) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** Derive an independent child seed (deterministic). */
export const childSeed = (seed, i) => (Math.imul(seed >>> 0, 2654435761) + Math.imul(i + 1, 40503)) >>> 0;

export const pick = (rnd, xs) => xs[Math.floor(rnd() * xs.length)];

/** Deterministic Fisher-Yates shuffle (returns a copy). */
export function shuffle(rnd, xs) {
  const a = [...xs];
  for (let i = a.length - 1; i > 0; i--) {
    const j = Math.floor(rnd() * (i + 1));
    [a[i], a[j]] = [a[j], a[i]];
  }
  return a;
}

/** Random lowercase hex string of length n. */
export const hex = (rnd, n) => Array.from({ length: n }, () => Math.floor(rnd() * 16).toString(16)).join('');
