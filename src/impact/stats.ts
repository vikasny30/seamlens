/** Wilson score interval for a binomial proportion (95% by default). Returns [low, high] in 0..1. */
export function wilson(k: number, n: number, z = 1.96): [number, number] {
  if (n === 0) return [0, 1];
  const p = k / n, z2 = z * z, d = 1 + z2 / n;
  const centre = (p + z2 / (2 * n)) / d;
  const half = (z * Math.sqrt((p * (1 - p)) / n + z2 / (4 * n * n))) / d;
  return [Math.max(0, centre - half), Math.min(1, centre + half)];
}

export function percentile(xs: number[], q: number): number {
  if (!xs.length) return 0;
  const s = [...xs].sort((a, b) => a - b);
  const idx = (s.length - 1) * q, lo = Math.floor(idx), hi = Math.ceil(idx);
  return s[lo] + (s[hi] - s[lo]) * (idx - lo);
}
export const median = (xs: number[]) => percentile(xs, 0.5);

export interface Rate { k: number; n: number; rate: number; lo: number; hi: number }
export const rate = (k: number, n: number): Rate => { const [lo, hi] = wilson(k, n); return { k, n, rate: n ? k / n : 0, lo, hi }; };
