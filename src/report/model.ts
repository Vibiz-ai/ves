// Card model (DESIGN-agnostic §7.4): one structured view of a run that every renderer uses (card.md here; the PR
// comment, job summary, JUnit and annotations in src/report/pr/** of the ci package). Built from the run directory
// alone, so `ves report` and `ves gate` never contact the agent. Works for v1 (Vibiz) and v2 runs.
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { clopperPearsonUpper, passHat1, passHatK, wilson } from '../lib/stats.ts';
import { isSafetyScore } from '../graders/index.ts';
import type { CardModel, ObservationLevel } from '../core/types.ts';
import type { Comparison } from '../lib/stats.ts';

const readJson = (f: string, d: unknown = null) => (existsSync(f) ? JSON.parse(readFileSync(f, 'utf8')) : d);

export function buildCardModel(runDir: string): CardModel {
  const m = readJson(join(runDir, 'run.json'));
  if (!m) throw new Error(`${runDir}: no run.json`);
  const g = readJson(join(runDir, 'gate.json'), {});
  const extra = readJson(join(runDir, 'run-extra.json'), {});
  const rows: any[] = existsSync(join(runDir, 'results.jsonl')) ? readFileSync(join(runDir, 'results.jsonl'), 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l)) : [];
  const retry = new Set<string>(extra.retry_row_ids ?? []);
  const cmps: Comparison[] = extra.comparisons ?? [];
  const v2 = m.schema_version === 'ves-run/2';
  const contract = new Set<string>(v2 ? Object.entries(m.connections ?? {}).filter(([, c]: any) => c.role === 'contract').map(([k]) => k) : (m.adapters ?? []).filter((a: any) => /contract/.test(a.surface)).map((a: any) => a.surface));
  const variants = (m.surfaces as string[]).map((name) => {
    const rs = rows.filter((r) => r.surface === name);
    const counted = rs.filter((r) => !retry.has(r.row_id) && r.status !== 'skip' && r.status !== 'invalid');
    const byCase = new Map<string, { case_id: string; c: number; n: number }>();
    for (const r of counted) { const x = byCase.get(r.case_id) ?? { case_id: r.case_id, c: 0, n: 0 }; x.n++; if (r.status === 'pass') x.c++; byCase.set(r.case_id, x); }
    const cc = [...byCase.values()];
    const k = m.k?.[name] ?? 1;
    const succ = cc.reduce((a, c) => a + c.c / c.n, 0);
    const [lo, hi] = wilson(succ, cc.length);
    const d = cmps.find((c) => c.surface === name && c.metric === 'pass^1');
    const badCases = new Set(rs.filter((r) => r.status !== 'invalid' && r.status !== 'skip' && r.scores.some((s: any) => isSafetyScore(s) && (s.label === 'fail' || s.label === 'error'))).map((r) => r.case_id));
    const safetyCases = new Set(rs.filter((r) => r.scores.some((s: any) => isSafetyScore(s))).map((r) => r.case_id));
    return {
      name, role: v2 ? m.connections?.[name]?.role ?? 'agent' : contract.has(name) ? 'contract' : 'agent',
      observation: (v2 ? m.observation?.[name] : 'proxied') as ObservationLevel, n_cases: cc.length, k,
      pass1: cc.length ? passHat1(cc) : 0, pass1_ci: [lo ?? 0, hi ?? 0] as [number, number],
      passk: cc.length && cc.every((x) => x.n >= k) ? passHatK(cc, k) : null,
      delta: d ? { diff: d.diff, ci: d.ci, reading: d.reading, powered: d.powered, mde: d.mde } : null,
      safety: { violations: rs.filter((r) => r.status !== 'invalid' && r.status !== 'skip').reduce((a, r) => a + r.scores.filter((s: any) => isSafetyScore(s) && (s.label === 'fail' || s.label === 'error')).length, 0), cp_upper: clopperPearsonUpper(badCases.size, safetyCases.size) ?? 0 },
      skipped: rs.filter((r) => r.status === 'skip').length, invalid: rs.filter((r) => r.status === 'invalid').length,
    };
  });
  const caseFiles: Record<string, string> = extra.case_files ?? {};
  const failures: CardModel['failures'] = [];
  for (const r of rows) {
    if (r.status !== 'fail') continue;
    for (const s of r.scores) {
      if (s.role !== 'gate' || s.label === 'pass') continue;
      const rule = isSafetyScore(s) ? 'G-3' : contract.has(r.surface) ? 'G-2' : m.tier === 'smoke' ? 'G-5' : 'G-6';
      failures.push({ row_id: r.row_id, case_id: r.case_id, case_file: caseFiles[r.case_id] ?? '', variant: r.surface, trial: r.trial, grader: s.grader_id, rule, explanation: s.explanation ?? '', evidence: s.evidence ?? [] });
    }
  }
  failures.sort((a, b) => (a.rule === b.rule ? 0 : a.rule === 'G-3' ? -1 : b.rule === 'G-3' ? 1 : a.rule < b.rule ? -1 : 1));
  const packs = v2 ? (m.packs ?? []).map((p: any) => ({ id: p.id, version: p.version, cases: p.cases, ...(p.skipped ? { skipped: p.skipped } : {}), low_realism_intents: p.low_realism_intents ?? 0 })) : [{ id: 'vibiz', version: '1.0.0', cases: m.suite?.case_count ?? 0, low_realism_intents: 0 }];
  const agentUsd = rows.reduce((a, r) => a + (r.usage?.usd_list ?? 0), 0);
  return {
    project: m.project ?? 'vibiz', run_id: m.run_id, sha: m.target.sha, tier: m.tier, trigger: m.trigger, change_class: m.target.change_class ?? 0,
    conformance: m.conformance ?? 'VES-1', loosened: m.loosened ?? [], verdict: g.verdict ?? m.verdict, would_be: g.would_be ?? g.verdict, decided_by: g.decided_by ?? null,
    rules: g.rules ?? [], variants, failures, packs, new_cases: m.new_cases ?? [],
    baseline: m.baseline ? { run_id: m.baseline.run_id, sha: m.baseline.sha, source: m.baseline.source } : m.comparator ? { run_id: m.comparator.run_id, sha: m.comparator.sha, source: 'path' } : null,
    cost: { usd: m.cost?.actual_usd ?? 0, agent_usd_reported: rows.some((r) => r.usage?.usd_list) ? agentUsd : null, wall_s: m.cost?.wall_s ?? 0 },
    diffs_from_prod: Object.fromEntries((m.adapters ?? []).map((a: any) => [a.surface, a.diffs_from_prod ?? []])),
    ...(extra.efficiency ? { efficiency: extra.efficiency } : {}),
  };
}
