// Hand-written run directories for the store / compare / history tests: small enough to check the numbers by hand.
// A trial status is 'pass' | 'fail' | 'invalid' | 'skip' | 'unsafe' (a fail with an approval_invariant violation).
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

export type CaseSpec = { id: string; version?: number } & Record<string, unknown>;
export type RunSpec = {
  run_id: string; suite: string; surfaces: string[]; cases: CaseSpec[];
  tier?: string; branch?: string; sha?: string; verdict?: string; decided_by?: string | null; k?: number; created_at?: string;
  cost_usd?: number; tokens?: number; extraFiles?: Record<string, string>; retry?: string[];
};

export function makeRun(root: string, s: RunSpec): string {
  const dir = join(root, s.run_id);
  mkdirSync(dir, { recursive: true });
  const suite = s.suite.length === 64 ? s.suite : s.suite.padEnd(64, '0');
  const rows: unknown[] = [];
  for (const c of s.cases) {
    const v = c.version ?? 1;
    for (const surf of s.surfaces) {
      const trials = (c[surf] as string[] | undefined) ?? [];
      trials.forEach((st, t) => {
        const status = st === 'unsafe' ? 'fail' : st;
        const scores = status === 'skip' || status === 'invalid' ? [] : [
          { name: 'ves.call_match', grader_id: 'call_match', grader_version: '1.0.0', kind: 'code', role: 'gate', value: status === 'pass' ? 1 : 0, label: status === 'pass' ? 'pass' : 'fail' },
          ...(st === 'unsafe' ? [{ name: 'ves.approval_invariant', grader_id: 'approval_invariant', grader_version: '1.0.0', kind: 'code', role: 'gate', value: 0, label: 'fail' }] : []),
        ];
        rows.push({
          schema_version: 'ves-result/1', row_id: `${s.run_id}|${c.id}@${v}|${surf}|${t}`, run_id: s.run_id, case_id: c.id, case_version: v, suite_version: suite,
          surface: surf, trial: t, seed: 1, status, ...(status === 'skip' ? { skip_reason: 'capability' } : {}), ...(status === 'invalid' ? { invalid_reason: 'infra_timeout' } : {}),
          scores, agent: { model: 'mock', commit: s.sha ?? 'abc1234' }, host: { family: 'vibiz' },
          trace: { atif_uri: `trajectories/${c.id}__${surf}__${t}.atif.json`, server_calls: 1 }, usage: { wall_ms: 1, input_tokens: s.tokens ?? 0, output_tokens: 0 },
          cache: { salt: `t${t}`, hit_ratio: 0 }, created_at: s.created_at ?? runIdIso(s.run_id),
        });
      });
    }
  }
  const k = Object.fromEntries(s.surfaces.map((x) => [x, s.k ?? 1]));
  writeFileSync(join(dir, 'run.json'), JSON.stringify({
    schema_version: 'ves-run/1', run_id: s.run_id, ves_version: '1.0.0', tier: s.tier ?? 'smoke', trigger: 'manual',
    target: { sha: s.sha ?? 'abc1234', ...(s.branch ? { branch: s.branch } : {}), deploy_targets: [], change_class: 0 },
    harness: { evals_sha: 'tree:x', package_version: '0.1.0' },
    suite: { ids: s.cases.map((c) => c.id).sort(), version: suite, case_count: s.cases.length, fixture_sha256s: ['f1'] },
    surfaces: s.surfaces, adapters: s.surfaces.map((x) => ({ surface: x, version: '1.0.0-mock', routes_sha256: 'r', diffs_from_prod: [] })),
    judge_config: { model: null, prompts: {} }, user_simulator: null, k, seeds: { bootstrap: 20261025 }, comparator: null,
    cost: { pool: 'smoke', estimate_point_usd: 0, estimate_high_usd: 0, actual_usd: s.cost_usd ?? 0, wall_s: 1 }, block_card: null, status: 'valid', invalid_row_share: 0, verdict: s.verdict ?? 'PASS',
  }, null, 2));
  writeFileSync(join(dir, 'results.jsonl'), rows.map((r) => JSON.stringify(r)).join('\n') + '\n');
  writeFileSync(join(dir, 'gate.json'), JSON.stringify({ schema_version: 'ves-gate/1', sha: s.sha ?? 'abc1234', change_class: 0, deploy_targets: [], verdict: s.verdict ?? 'PASS', would_be: s.verdict ?? 'PASS', decided_by: s.decided_by ?? null, rules: [], run_ids: [s.run_id], accepted_risks: [], override: null }));
  writeFileSync(join(dir, 'run-extra.json'), JSON.stringify({ retry_row_ids: s.retry ?? [], comparisons: null }));
  for (const [p, body] of Object.entries(s.extraFiles ?? {})) { mkdirSync(join(dir, p, '..'), { recursive: true }); writeFileSync(join(dir, p), body); }
  return dir;
}

export function runIdIso(id: string): string {
  const m = /^ves-(\d{4})(\d{2})(\d{2})T(\d{2})(\d{2})(\d{2})Z-/.exec(id);
  return m ? `${m[1]}-${m[2]}-${m[3]}T${m[4]}:${m[5]}:${m[6]}.000Z` : '2026-01-01T00:00:00.000Z';
}
