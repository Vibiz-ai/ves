// IndexEntry for one run directory: the searchable summary kept next to the content-addressed files. Per-surface
// numbers come from the card model (src/report/model.ts), the same pass^1 / Wilson / safety counts the card shows.
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { buildCardModel } from '../report/model.ts';
import { caseCounts } from '../runner/run.ts';
import { passHat1, wilson } from '../lib/stats.ts';
import { isSafetyScore } from '../graders/index.ts';
import { INDEX_SCHEMA, type IndexEntry, type RunRecord, type SurfaceSummary } from './types.ts';

const readJson = (f: string) => (existsSync(f) ? JSON.parse(readFileSync(f, 'utf8')) : null);

/** ves-YYYYMMDDTHHMMSSZ-xxxxxxxx -> ISO timestamp, or null. */
export function createdFromRunId(id: string): string | null {
  const m = /^ves-(\d{4})(\d{2})(\d{2})T(\d{2})(\d{2})(\d{2})Z-/.exec(id ?? '');
  return m ? `${m[1]}-${m[2]}-${m[3]}T${m[4]}:${m[5]}:${m[6]}.000Z` : null;
}

export type BranchInfo = { branch: string | null; source: IndexEntry['branch_source'] };

export function buildIndexEntry(runDir: string, record: RunRecord, recordSha: string, o: { branch: BranchInfo; pushedAt: string }): IndexEntry {
  const m = readJson(join(runDir, 'run.json'));
  if (!m || typeof m !== 'object') throw new Error(`${runDir}: no run.json`);
  const rows: any[] = existsSync(join(runDir, 'results.jsonl'))
    ? readFileSync(join(runDir, 'results.jsonl'), 'utf8').split('\n').filter(Boolean).flatMap((l) => { try { return [JSON.parse(l)]; } catch { return []; } })
    : [];
  let model: ReturnType<typeof buildCardModel> | null = null;
  try { model = buildCardModel(runDir); } catch { model = null; }
  const surfaces: Record<string, SurfaceSummary> = {};
  for (const v of model?.variants ?? []) {
    surfaces[v.name] = { pass1: v.pass1, ci: v.pass1_ci, n_cases: v.n_cases, k: v.k, violations: v.safety.violations, invalid: v.invalid, skipped: v.skipped };
  }
  if (!model) {
    // the card model refuses a results.jsonl with an unparsable line; the same numbers from the parsable rows
    const extra = readJson(join(runDir, 'run-extra.json')) ?? {};
    const retry = new Set<string>(extra.retry_row_ids ?? []);
    for (const name of (Array.isArray(m.surfaces) ? m.surfaces : []) as string[]) {
      const cc = caseCounts(rows, name, retry);
      const [lo, hi] = wilson(cc.reduce((a, c) => a + c.c / c.n, 0), cc.length);
      const rs = rows.filter((r) => r.surface === name);
      const violations = rs.filter((r) => r.status !== 'invalid' && r.status !== 'skip').reduce((a, r) => a + (r.scores ?? []).filter((x: any) => isSafetyScore(x) && (x.label === 'fail' || x.label === 'error')).length, 0);
      surfaces[name] = { pass1: cc.length ? passHat1(cc) : 0, ci: [lo ?? 0, hi ?? 0], n_cases: cc.length, k: m.k?.[name] ?? 1, violations, invalid: rs.filter((r) => r.status === 'invalid').length, skipped: rs.filter((r) => r.status === 'skip').length };
    }
  }
  const gate = readJson(join(runDir, 'gate.json')) ?? {};
  const firstRow = rows.map((r) => r.created_at).filter((x) => typeof x === 'string').sort()[0] ?? null;
  const models = new Set<string>();
  for (const c of Object.values(m.connections ?? {}) as any[]) if (c?.agent?.model) models.add(String(c.agent.model));
  for (const r of rows) if (typeof r.agent?.model === 'string') models.add(r.agent.model);
  const hosts = new Set<string>(rows.map((r) => r.host?.family).filter((x) => typeof x === 'string'));
  const tokens = rows.reduce((a, r) => a + (Number(r.usage?.input_tokens) || 0) + (Number(r.usage?.output_tokens) || 0), 0);
  return {
    schema_version: INDEX_SCHEMA,
    run_id: record.run_id,
    created: firstRow ?? createdFromRunId(record.run_id),
    pushed_at: o.pushedAt,
    project: m.project ?? null,
    tier: m.tier ?? null,
    trigger: m.trigger ?? null,
    status: m.status ?? null,
    verdict: model?.verdict ?? gate.verdict ?? m.verdict ?? null,
    would_be: model?.would_be ?? gate.would_be ?? null,
    decided_by: model?.decided_by ?? gate.decided_by ?? null,
    target: { sha: m.target?.sha ?? null, branch: o.branch.branch, change_class: m.target?.change_class ?? null },
    branch_source: o.branch.source,
    suite_version: m.suite?.version ?? null,
    case_count: m.suite?.case_count ?? null,
    config_sha256: m.config_sha256 ?? null,
    catalog_sha256: m.catalog_sha256 ?? null,
    agent_models: [...models].sort(),
    host_families: [...hosts].sort(),
    variants: Array.isArray(m.surfaces) ? m.surfaces : Object.keys(surfaces),
    surfaces,
    cost: { actual_usd: typeof m.cost?.actual_usd === 'number' ? m.cost.actual_usd : null, agent_usd_reported: model?.cost.agent_usd_reported ?? null, tokens, wall_s: typeof m.cost?.wall_s === 'number' ? m.cost.wall_s : null },
    record_sha256: recordSha,
    tree_sha256: record.tree_sha256,
    files: record.files.length,
    bytes: record.files.reduce((a, f) => a + f.size, 0),
  };
}
