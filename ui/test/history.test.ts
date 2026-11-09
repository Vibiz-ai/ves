import { test } from 'node:test';
import assert from 'node:assert/strict';
import { defaultPair, fromEntry, fromSummary, pass1Delta, prevComparable, pts, segments, trendSeries } from '../src/lib/history.ts';
import type { RunSummary, StoreEntry } from '../src/lib/types.ts';

const entry = (i: number, o: { branch?: string; suite?: string; tier?: string; web?: number; verdict?: string } = {}): StoreEntry => ({
  run_id: `r${i}`, seq: i, created: `2026-11-07T10:00:0${i}.000Z`, tier: o.tier ?? 'smoke', trigger: 'manual', verdict: o.verdict ?? 'PASS', decided_by: null,
  target: { sha: `${i}`.repeat(7), branch: o.branch ?? 'main', change_class: 0 }, suite_version: o.suite ?? 'S1', suite_label: o.suite === 'S2' ? 'v2' : 'v1', case_count: 4,
  variants: ['web'], surfaces: o.web === undefined ? {} : { web: { pass1: o.web, ci: [Math.max(0, o.web - 0.2), Math.min(1, o.web + 0.1)], n_cases: 4, k: 1, violations: 0, invalid: 0, skipped: 0 } },
});

test('trendSeries filters by branch/tier and marks a BREAK where suite_version changes', () => {
  const es = [entry(0, { web: 1 }), entry(1, { web: 0.75 }), entry(2, { web: 0.5, branch: 'feat' }), entry(3, { web: 1, suite: 'S2' }), entry(4, { web: 0.75, suite: 'S2' })];
  const all = trendSeries(es, 'web');
  assert.deepEqual(all.points.map((p) => p.run_id), ['r0', 'r1', 'r2', 'r3', 'r4']);
  assert.deepEqual(all.breaks, [{ index: 3, from: 'v1', to: 'v2' }]);
  const main = trendSeries(es, 'web', { branch: 'main' });
  assert.deepEqual(main.points.map((p) => p.run_id), ['r0', 'r1', 'r3', 'r4']);
  assert.deepEqual(main.breaks.map((b) => b.index), [2]);
  assert.deepEqual(segments(main.points, main.breaks).map((s) => s.map((p) => p.run_id)), [['r0', 'r1'], ['r3', 'r4']], 'a line never joins two suites');
  assert.equal(trendSeries(es, 'slack').points.length, 0);
});

test('prevComparable needs the same tier and suite and an earlier run; pass1Delta picks the largest move', () => {
  const es = [entry(0, { web: 1 }), entry(1, { web: 1, tier: 'release' }), entry(2, { web: 0.5, suite: 'S2' }), entry(3, { web: 0.75 })].map(fromEntry);
  assert.equal(prevComparable(es[3], es)?.id, 'r0');
  assert.equal(prevComparable(es[2], es), null);
  assert.equal(prevComparable(es[0], es), null);
  const d = pass1Delta(es[3], es[0]);
  assert.deepEqual(d.top, { surface: 'web', diff: -0.25 });
  // results-dir summaries (second precision) and store entries (ms) compare by time, not by string
  const sum = { id: 'x', created: '2026-11-07T10:00:05Z', tier: 'smoke', suite_version: 'S1', pass1: { web: { pass1: 1, n_cases: 4 } } } as unknown as RunSummary;
  assert.equal(prevComparable(fromSummary(sum), es)?.id, 'r3');
});

test('defaultPair: newest run on the current branch vs the newest earlier main run of its tier and suite', () => {
  const es = [entry(0, { web: 1 }), entry(1, { web: 1, branch: 'feat' }), entry(2, { web: 1, suite: 'S2' }), entry(3, { web: 1, branch: 'feat' })];
  assert.deepEqual(defaultPair(es, 'feat'), { base: 'r0', head: 'r3' });
  assert.deepEqual(defaultPair(es, null), { base: 'r0', head: 'r3' });
  assert.deepEqual(defaultPair(es, 'main'), { base: 'r0', head: 'r3' }, 'on main, head is simply the newest run');
  assert.deepEqual(defaultPair([], null), { base: null, head: null });
  assert.equal(pts(-0.25), '−25.0 pts');
  assert.equal(pts(0), '±0.0 pts');
});
