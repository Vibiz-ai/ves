import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  wilson, clopperPearson, clopperPearsonUpper, zeroFailureBound, passHatKCase, passAtKCase, passHat1, passHatK, passAtK,
  pairedBootstrap, holm, mcnemarExact, compareArms, sampleSize, incBeta,
} from '../src/lib/stats.ts';

const close = (a: number, b: number, eps = 1e-3) => assert.ok(Math.abs(a - b) <= eps, `${a} !~ ${b}`);

test('Wilson interval matches reference values', () => {
  const [lo, hi] = wilson(0, 10) as [number, number];
  close(lo, 0); close(hi, 0.2775);
  const [l2, h2] = wilson(8, 10) as [number, number];
  close(l2, 0.4902); close(h2, 0.9433);
  assert.deepEqual(wilson(0, 0), [null, null]);
});

test('incomplete beta is exact enough', () => {
  close(incBeta(0.5, 2, 2), 0.5, 1e-9);
  close(incBeta(0.3, 1, 1), 0.3, 1e-9);
  close(incBeta(0.2, 2, 5), 0.34464, 1e-5);
});

test('Clopper-Pearson two-sided and one-sided', () => {
  const [lo, hi] = clopperPearson(5, 10) as [number, number];
  close(lo, 0.1871); close(hi, 0.8129);
  const [l0, h0] = clopperPearson(0, 20) as [number, number];
  assert.equal(l0, 0); close(h0, 1 - Math.pow(0.025, 1 / 20));
  close(clopperPearsonUpper(1, 30)!, 0.1500, 2e-3);
});

test('§5.4 zero-failure table reproduces', () => {
  const table: [number, number][] = [[20, 0.139], [30, 0.095], [60, 0.049], [120, 0.025], [299, 0.010]];
  for (const [n, want] of table) close(zeroFailureBound(n)!, want, 6e-4);
});

test('pass^k is the unbiased estimator C(c,k)/C(n,k)', () => {
  assert.equal(passHatKCase(4, 4, 2), 1);
  assert.equal(passHatKCase(1, 4, 2), 0);
  close(passHatKCase(3, 4, 2), 0.5, 1e-12);
  // unbiasedness: E over Binomial(n, p) of C(c,k)/C(n,k) equals p^k
  const n = 6, k = 3, p = 0.7;
  let e = 0;
  const choose = (a: number, b: number) => { let r = 1; for (let i = 0; i < b; i++) r = (r * (a - i)) / (i + 1); return r; };
  for (let c = 0; c <= n; c++) e += choose(n, c) * p ** c * (1 - p) ** (n - c) * passHatKCase(c, n, k);
  close(e, p ** k, 1e-12);
  assert.throws(() => passHatKCase(1, 1, 2), /n_i >= k/);
});

test('pass@k and suite aggregates over cases', () => {
  close(passAtKCase(1, 4, 2), 0.5, 1e-12);
  const cs = [{ case_id: 'a', c: 2, n: 2 }, { case_id: 'b', c: 1, n: 2 }, { case_id: 'c', c: 0, n: 0 }];
  close(passHat1(cs), 0.75, 1e-12); // c (n=0, all skipped) excluded
  close(passHatK(cs, 2), 0.5, 1e-12);
  close(passAtK(cs, 2), 1, 1e-12);
});

test('paired bootstrap is deterministic and centred', () => {
  const pairs = Array.from({ length: 12 }, (_, i) => ({ cluster: `c${i}`, a: i % 3 === 0 ? 0 : 1, b: 1 }));
  const r1 = pairedBootstrap(pairs, { n: 2000 })!;
  const r2 = pairedBootstrap(pairs, { n: 2000 })!;
  assert.deepEqual(r1.ci, r2.ci);
  close(r1.diff, -4 / 12, 1e-12);
  assert.ok(r1.ci[1] < 0, 'all-negative paired diffs give an upper bound below 0');
  const same = pairedBootstrap(pairs.map((p) => ({ ...p, a: p.b })), { n: 500 })!;
  assert.deepEqual(same.ci, [0, 0]);
  assert.equal(pairedBootstrap([]), null);
});

test('Holm and exact McNemar', () => {
  const adj = holm([0.01, 0.04, 0.03, null]);
  close(adj[0]!, 0.03, 1e-12); close(adj[2]!, 0.06, 1e-12); close(adj[1]!, 0.06, 1e-12); assert.equal(adj[3], null);
  close(mcnemarExact(0, 5), 0.0625, 1e-12);
  assert.equal(mcnemarExact(0, 0), 1);
});

test('§5.5 readings: below, level/non-inferior, powered flag, Holm across tests', () => {
  const mk = (n: number, bad: number) => Array.from({ length: n }, (_, i) => ({ cluster: `k${i}`, a: i < bad ? 0 : 1, b: 1 }));
  const [below, level] = compareArms([
    { surface: 'eve/web', metric: 'pass^1', pairs: mk(30, 15), delta: 0.05 },
    { surface: 'eve/slack', metric: 'pass^1', pairs: mk(30, 0), delta: 0.05 },
  ], { n: 3000, aaHalfWidth: { 'eve/slack|pass^1': 0.04 } });
  assert.equal(below.reading, 'below');
  assert.equal(below.powered, false);
  assert.equal(level.reading, 'level');
  assert.equal(level.non_inferior, true);
  assert.equal(level.powered, true);
  assert.ok(below.holm_alpha < level.holm_alpha || below.holm_alpha === 0.025);
});

test('§5.6 sample size with design effect', () => {
  assert.equal(sampleSize(0.3, 0.05, 1, 0), Math.ceil((2.8015852 ** 2 * 0.09) / 0.0025));
  assert.ok(sampleSize(0.3, 0.05, 2, 0.8) > sampleSize(0.3, 0.05, 1, 0));
});
