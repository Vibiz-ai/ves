// VES-1 statistics (§5). Ported from an earlier research harness (not public), lib/metrics.mjs @ 27457782d3063ee1c04f0a77075fd61f03f1e7a8
// (wilson, pairedBootstrap cluster arm, mcnemarExact, holm, mulberry32). Deviation, logged in src/vendor/VENDORED.md:
// Clopper–Pearson uses an exact regularized incomplete beta (Lentz continued fraction) instead of the lab's
// 2000-step numeric integration, so bounds at n >= 100 are accurate to ~1e-10.
import { mulberry32 } from './rng.ts';

export const BOOTSTRAP_SEED = 20261025; // §5.3
export const BOOTSTRAP_N = 10000; // §5.3

/** Wilson score interval for k successes in n. Returns [lo, hi] or [null, null] for n = 0. */
export function wilson(k: number, n: number, z = 1.959963984540054): [number, number] | [null, null] {
  if (!n) return [null, null];
  const p = k / n;
  const d = 1 + (z * z) / n;
  const c = (p + (z * z) / (2 * n)) / d;
  const h = (z * Math.sqrt((p * (1 - p)) / n + (z * z) / (4 * n * n))) / d;
  return [Math.max(0, c - h), Math.min(1, c + h)];
}

function logGamma(x: number): number {
  // Lanczos approximation (g=7, n=9)
  const g = 7;
  const c = [0.99999999999980993, 676.5203681218851, -1259.1392167224028, 771.32342877765313, -176.61502916214059,
    12.507343278686905, -0.13857109526572012, 9.9843695780195716e-6, 1.5056327351493116e-7];
  if (x < 0.5) return Math.log(Math.PI / Math.sin(Math.PI * x)) - logGamma(1 - x);
  x -= 1;
  let a = c[0];
  const t = x + g + 0.5;
  for (let i = 1; i < g + 2; i++) a += c[i] / (x + i);
  return 0.5 * Math.log(2 * Math.PI) + (x + 0.5) * Math.log(t) - t + Math.log(a);
}

function betacf(a: number, b: number, x: number): number {
  const MAXIT = 300, EPS = 3e-14, FPMIN = 1e-300;
  const qab = a + b, qap = a + 1, qam = a - 1;
  let c = 1, d = 1 - (qab * x) / qap;
  if (Math.abs(d) < FPMIN) d = FPMIN;
  d = 1 / d;
  let h = d;
  for (let m = 1; m <= MAXIT; m++) {
    const m2 = 2 * m;
    let aa = (m * (b - m) * x) / ((qam + m2) * (a + m2));
    d = 1 + aa * d; if (Math.abs(d) < FPMIN) d = FPMIN;
    c = 1 + aa / c; if (Math.abs(c) < FPMIN) c = FPMIN;
    d = 1 / d; h *= d * c;
    aa = (-(a + m) * (qab + m) * x) / ((a + m2) * (qap + m2));
    d = 1 + aa * d; if (Math.abs(d) < FPMIN) d = FPMIN;
    c = 1 + aa / c; if (Math.abs(c) < FPMIN) c = FPMIN;
    d = 1 / d;
    const del = d * c;
    h *= del;
    if (Math.abs(del - 1) < EPS) break;
  }
  return h;
}

/** Regularized incomplete beta I_x(a, b). */
export function incBeta(x: number, a: number, b: number): number {
  if (x <= 0) return 0;
  if (x >= 1) return 1;
  const lbt = logGamma(a + b) - logGamma(a) - logGamma(b) + a * Math.log(x) + b * Math.log(1 - x);
  const bt = Math.exp(lbt);
  return x < (a + 1) / (a + b + 2) ? (bt * betacf(a, b, x)) / a : 1 - (bt * betacf(b, a, 1 - x)) / b;
}

function betaInv(p: number, a: number, b: number): number {
  let lo = 0, hi = 1;
  for (let i = 0; i < 100; i++) {
    const mid = (lo + hi) / 2;
    if (incBeta(mid, a, b) < p) lo = mid; else hi = mid;
  }
  return (lo + hi) / 2;
}

/** Two-sided exact Clopper–Pearson interval at level 1 - alpha. */
export function clopperPearson(k: number, n: number, alpha = 0.05): [number, number] | [null, null] {
  if (!n) return [null, null];
  return [k === 0 ? 0 : betaInv(alpha / 2, k, n - k + 1), k === n ? 1 : betaInv(1 - alpha / 2, k + 1, n - k)];
}
/** One-sided exact upper bound on a rate after k events in n (Clopper–Pearson). For k = 0: 1 - alpha^(1/n). */
export function clopperPearsonUpper(k: number, n: number, alpha = 0.05): number | null {
  if (!n) return null;
  if (k >= n) return 1;
  if (k === 0) return 1 - Math.pow(alpha, 1 / n);
  return betaInv(1 - alpha, k + 1, n - k);
}
/** §5.4 table: 95% one-sided upper bound on per-case violation rate with n violation-free cases. */
export const zeroFailureBound = (nCases: number, alpha = 0.05): number | null => clopperPearsonUpper(0, nCases, alpha);

/** Unbiased pass^k for one case: C(c,k)/C(n,k). Requires n >= k (§5.1). */
export function passHatKCase(c: number, n: number, k: number): number {
  if (!Number.isInteger(k) || k < 1) throw new Error(`k must be a positive integer, got ${k}`);
  if (n < k) throw new Error(`pass^k needs n_i >= k (n=${n}, k=${k})`);
  if (c < 0 || c > n) throw new Error(`bad counts c=${c} n=${n}`);
  let p = 1;
  for (let i = 0; i < k; i++) p *= (c - i) / (n - i);
  return Math.max(0, p);
}
/** Unbiased pass@k for one case: 1 - C(n-c,k)/C(n,k). Reported only, never gates. */
export function passAtKCase(c: number, n: number, k: number): number {
  if (n < k) throw new Error(`pass@k needs n_i >= k (n=${n}, k=${k})`);
  let q = 1;
  for (let i = 0; i < k; i++) q *= (n - c - i) / (n - i);
  return 1 - Math.max(0, q);
}

export type CaseCounts = { case_id: string; c: number; n: number };
const mean = (xs: number[]): number => (xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : NaN);

/** Mean over cases of c_i/n_i (§5.1 pass^1). Cases with n = 0 (all skipped/invalid) are excluded. */
export const passHat1 = (cs: CaseCounts[]): number => mean(cs.filter((x) => x.n > 0).map((x) => x.c / x.n));
export const passHatK = (cs: CaseCounts[], k: number): number => mean(cs.filter((x) => x.n > 0).map((x) => passHatKCase(x.c, x.n, k)));
export const passAtK = (cs: CaseCounts[], k: number): number => mean(cs.filter((x) => x.n > 0).map((x) => passAtKCase(x.c, x.n, k)));

export type Pair = { cluster: string; a: number; b: number }; // a = candidate, b = reference (per case)
export type BootResult = {
  n: number; clusters: number; diff: number; ci: [number, number]; boot_p: number; sd: number;
  draws: number[];
};

/** Paired cluster bootstrap (cluster = case; two-level resampling as in the lab's pairedBootstrap cluster arm).
 * Returns the point difference mean(a - b), the percentile CI at level 1 - alpha, a two-sided bootstrap p
 * (2 x the smaller tail mass at 0) and the bootstrap SD. */
export function pairedBootstrap(pairs: Pair[], opts: { n?: number; seed?: number; alpha?: number } = {}): BootResult | null {
  if (!pairs.length) return null;
  const n = opts.n ?? BOOTSTRAP_N, alpha = opts.alpha ?? 0.05;
  const rnd = mulberry32(opts.seed ?? BOOTSTRAP_SEED);
  const byC = new Map<string, Pair[]>();
  for (const p of pairs) byC.set(p.cluster, [...(byC.get(p.cluster) ?? []), p]);
  const clusters = [...byC.values()];
  const diff = (ps: Pair[]) => mean(ps.map((p) => p.a - p.b));
  const draws: number[] = [];
  for (let r = 0; r < n; r++) {
    const sample: Pair[] = [];
    for (let i = 0; i < clusters.length; i++) {
      const c = clusters[Math.floor(rnd() * clusters.length)];
      for (let j = 0; j < c.length; j++) sample.push(c[Math.floor(rnd() * c.length)]);
    }
    draws.push(diff(sample));
  }
  draws.sort((x, y) => x - y);
  const q = (p: number) => draws[Math.min(draws.length - 1, Math.max(0, Math.floor(p * draws.length)))];
  const le = draws.filter((x) => x <= 0).length / n;
  const ge = draws.filter((x) => x >= 0).length / n;
  const m = mean(draws);
  const sd = Math.sqrt(mean(draws.map((x) => (x - m) ** 2)));
  return { n: pairs.length, clusters: clusters.length, diff: diff(pairs), ci: [q(alpha / 2), q(1 - alpha / 2)], boot_p: Math.min(1, 2 * Math.min(le, ge)), sd, draws };
}
/** Percentile CI of a finished bootstrap at another level (used for Holm-adjusted CIs). */
export function bootCi(b: BootResult, alpha: number): [number, number] {
  const q = (p: number) => b.draws[Math.min(b.draws.length - 1, Math.max(0, Math.floor(p * b.draws.length)))];
  return [q(alpha / 2), q(1 - alpha / 2)];
}

/** Holm step-down adjusted p-values, input order kept; null stays null (lab metrics.mjs). */
export function holm(ps: (number | null)[]): (number | null)[] {
  const idx = ps.map((p, i) => [p, i] as [number | null, number]).filter(([p]) => p != null).sort((a, b) => (a[0] as number) - (b[0] as number));
  const out: (number | null)[] = ps.map(() => null);
  let run = 0;
  idx.forEach(([p, i], k) => {
    run = Math.max(run, Math.min(1, (idx.length - k) * (p as number)));
    out[i] = run;
  });
  return out;
}
/** Holm per-test alpha (step-down): the test at ascending-p rank r (0-based) of m gets alpha / (m - r) while every
 * earlier test was rejected; from the first non-rejection on, every later test keeps that rank's alpha, so no test
 * after the step-down stops can be rejected (Tester fix 2026-11-06, protocol/LOG.md). */
export function holmAlphas(ps: number[], alpha = 0.05): number[] {
  const m = ps.length;
  const order = ps.map((p, i) => [p, i]).sort((a, b) => a[0] - b[0]);
  const out = new Array(m).fill(alpha);
  let stopped: number | null = null;
  order.forEach(([p, i], r) => {
    const a = stopped ?? alpha / (m - r);
    out[i] = a;
    if (stopped === null && p > a) stopped = a;
  });
  return out;
}

function logChoose(n: number, k: number): number {
  let s = 0;
  for (let i = 1; i <= k; i++) s += Math.log(n - k + i) - Math.log(i);
  return s;
}
/** Exact two-sided McNemar on discordant counts b, c. */
export function mcnemarExact(b: number, c: number): number {
  const n = b + c;
  if (!n) return 1;
  const k = Math.min(b, c);
  let p = 0;
  for (let i = 0; i <= k; i++) p += Math.exp(logChoose(n, i) - n * Math.log(2));
  return Math.min(1, 2 * p);
}

export type Reading = 'above' | 'level' | 'below';
export type Comparison = {
  surface: string; metric: string; n_cases: number; diff: number; ci: [number, number]; holm_alpha: number;
  p: number; p_holm: number; reading: Reading; non_inferior: boolean; powered: boolean; mde: number; delta: number;
};

/** §5.5 regression decision for several (surface, metric) tests in one gate, Holm across all of them.
 * `aaHalfWidth` is the predicted CI half-width from the latest A/A study, keyed `${surface}|${metric}`;
 * without it a test is unpowered (no A/A study exists at VES-1.0). */
export function compareArms(
  tests: { surface: string; metric: string; pairs: Pair[]; delta: number }[],
  opts: { aaHalfWidth?: Record<string, number>; seed?: number; n?: number; alpha?: number } = {},
): Comparison[] {
  const alpha = opts.alpha ?? 0.05;
  const boots = tests.map((t) => pairedBootstrap(t.pairs, { seed: opts.seed, n: opts.n, alpha }));
  const ps = boots.map((b) => (b ? b.boot_p : 1));
  const adj = holm(ps);
  const alphas = holmAlphas(ps, alpha);
  return tests.map((t, i) => {
    const b = boots[i];
    if (!b) return { surface: t.surface, metric: t.metric, n_cases: 0, diff: NaN, ci: [NaN, NaN], holm_alpha: alphas[i], p: 1, p_holm: 1, reading: 'level', non_inferior: false, powered: false, mde: NaN, delta: t.delta };
    const ci = bootCi(b, alphas[i]);
    const reading: Reading = ci[1] < 0 ? 'below' : ci[0] > 0 ? 'above' : 'level';
    const hw = opts.aaHalfWidth?.[`${t.surface}|${t.metric}`];
    const powered = hw !== undefined && hw <= t.delta;
    // MDE at 80% power, two-sided alpha, from the bootstrap SE of this comparison (§5.6 formula with sigma = SE*sqrt(n)).
    const mde = (1.959963984540054 + 0.8416212335729143) * b.sd;
    return { surface: t.surface, metric: t.metric, n_cases: b.clusters, diff: b.diff, ci, holm_alpha: alphas[i], p: b.boot_p, p_holm: adj[i] ?? 1, reading, non_inferior: ci[0] > -t.delta, powered, mde, delta: t.delta };
  });
}

/** §5.6 sample size per arm: n = (z_a + z_b)^2 * sigma^2 * (1 + (k-1) ICC) / delta^2. */
export function sampleSize(sigma: number, delta: number, k = 1, icc = 0, zA = 1.959963984540054, zB = 0.8416212335729143): number {
  return Math.ceil(((zA + zB) ** 2 * sigma ** 2 * (1 + (k - 1) * icc)) / delta ** 2);
}

export function percentile(xs: number[], p: number): number | null {
  if (!xs.length) return null;
  const s = [...xs].sort((a, b) => a - b);
  const i = Math.min(s.length - 1, Math.max(0, Math.ceil((p / 100) * s.length) - 1));
  return s[i];
}
