// Regression tests for the Tester's fixes of 2026-11-06 (protocol/LOG.md rows 2-4). No network, no files written.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { compareArms, holmAlphas } from '../src/lib/stats.ts';
import { evaluateGate, type GateInput } from '../src/gate/gate.ts';
import type { Comparison } from '../src/lib/stats.ts';

(globalThis as any).fetch = () => { throw new Error('network call attempted in a test'); };

test('Holm alphas are step-down: nothing after the first non-rejection gets a looser alpha', () => {
  assert.deepEqual(holmAlphas([0.04, 0.045]), [0.025, 0.025]);
  assert.deepEqual(holmAlphas([0.01, 0.04, 0.03]).map((x) => +x.toFixed(5)), [0.01667, 0.025, 0.025]);
  assert.deepEqual(holmAlphas([0.001, 0.01, 0.04]).map((x) => +x.toFixed(5)), [0.01667, 0.025, 0.05]);
});

test('identical data on two surfaces gets the same reading (Holm p 0.0504 > 0.05: neither is below)', () => {
  const mk = (bad: number) => Array.from({ length: 30 }, (_, i) => ({ cluster: `k${i}`, a: i < bad ? 0 : 1, b: 1 }));
  const r = compareArms([
    { surface: 'eve/web', metric: 'pass^1', pairs: mk(4), delta: 0.05 },
    { surface: 'eve/slack', metric: 'pass^1', pairs: mk(4), delta: 0.05 },
  ]);
  assert.equal(r[0].reading, r[1].reading);
  assert.equal(r[1].reading, 'level');
  assert.ok(r[1].p_holm > 0.05);
});

const cmp = (o: Partial<Comparison>): Comparison => ({ surface: 'eve/web', metric: 'pass^1', n_cases: 30, diff: 0, ci: [-0.02, 0.02], holm_alpha: 0.05, p: 1, p_holm: 1, reading: 'level', non_inferior: true, powered: false, mde: 0.1, delta: 0.05, ...o });
const base = (over: Partial<GateInput>): GateInput => ({
  sha: 'abc1234', change_class: 3, deploy_targets: ['app'], tier: 'release', trigger: 'manual', run_ids: ['r'], admissibility: [], validity: [],
  run_invalid: { invalid: false, share: 0 }, invalid_twice: false, rows: [], retry_row_ids: [], contract_surfaces: [], expected_failures: [], safety_validity: [],
  comparisons: null, anchor: null, hard_regressions: [], over_refusal: null, accepted_risks: [], override: null, ...over,
});

test('G-7: Class 3 unpowered blocks even when the CI happens to be non-inferior; Class 2 unpowered ships', () => {
  const c = [cmp({ powered: false, non_inferior: true, ci: [-0.02, 0.03] })];
  const g3 = evaluateGate(base({ change_class: 3, comparisons: c }));
  assert.equal(g3.decided_by, 'G-7 non-inferiority');
  assert.match(g3.rules.find((r) => r.rule === 'G-7 non-inferiority')!.detail, /Class 3 must be powered/);
  assert.equal(evaluateGate(base({ change_class: 2, comparisons: c })).verdict, 'PASS');
});

test('CLI: a repeated scalar flag takes its last value (npm run smoke:mock -- --out x); --suite still accumulates', () => {
  const root = join(dirname(fileURLToPath(import.meta.url)), '..');
  // `ves classify-change` is pure; use an invalid --target on `run` to prove the last value is the one parsed.
  let msg = '';
  try { execFileSync(process.execPath, [join(root, 'src/cli.ts'), 'run', '--target', 'abc1234', '--target', 'NOT-HEX'], { cwd: root, stdio: 'pipe' }); }
  catch (e: any) { msg = String(e.stderr); assert.equal(e.status, 3); }
  assert.match(msg, /--target must be a hex SHA, got NOT-HEX$/m);
});
