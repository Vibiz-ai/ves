// Offline re-reads of a stored run directory (`ves report --run <dir> --format claims|efficiency`). Read-only: the run
// directory is never written, the agent is never contacted. The claim check and the tool-call counts are the same
// functions the runner uses, applied to each row's stored ATIF trajectory and the run's catalog.json; settings come
// from the run's config.snapshot.json (`graders.claims`, `tools.reported_prefixes|reported_aliases`) unless a
// `--config` file overrides them. Limits: an upstream-ledger row with no proxied call (a bypass) is not in the ATIF,
// so it cannot back a claim here, and guard_fired is read from the stored result content.
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { checkClaims, explainClaims, explainSilent, lexiconFor, segmentTurns, type ClaimsConfig, type ClaimsReport, type ReportedNames } from '../graders/claims.ts';
import { aggregateEfficiency, renderEfficiency, trialEfficiency } from './efficiency.ts';
import type { Catalog, CatalogTool } from '../core/types.ts';

type Settings = { claims: ClaimsConfig; names: ReportedNames };
const readJson = (f: string) => JSON.parse(readFileSync(f, 'utf8'));

export function runSettings(runDir: string, override?: { graders?: { claims?: ClaimsConfig }; tools?: { reported_prefixes?: string[]; reported_aliases?: Record<string, string> } }): Settings {
  const snap = existsSync(join(runDir, 'config.snapshot.json')) ? readJson(join(runDir, 'config.snapshot.json')) : {};
  const src = override ?? snap;
  return { claims: src.graders?.claims ?? {}, names: { prefixes: src.tools?.reported_prefixes ?? [], aliases: src.tools?.reported_aliases ?? {} } };
}
/** catalog.json (the run's resolved catalog) as the Catalog subset the claim check reads. */
export function storedCatalog(runDir: string): Catalog | null {
  const f = join(runDir, 'catalog.json');
  if (!existsSync(f)) return null;
  const c = readJson(f) as { tools: CatalogTool[]; gate_classes?: string[]; sha256?: string };
  return { tools: c.tools, byName: Object.fromEntries(c.tools.map((t) => [t.name, t])), gate_classes: (c.gate_classes ?? []) as Catalog['gate_classes'], sha256: c.sha256 ?? '', loosened: [], warnings: [] };
}
const rowsOf = (runDir: string): any[] => readFileSync(join(runDir, 'results.jsonl'), 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l));

export type RowClaims = { row_id: string; case_id: string; surface: string; trial: number; status: string; report: ClaimsReport; claims: string; silent: string };
export function claimsForRun(runDir: string, s: Settings = runSettings(runDir)): RowClaims[] {
  const cat = storedCatalog(runDir);
  const lex = lexiconFor(s.claims);
  const out: RowClaims[] = [];
  for (const r of rowsOf(runDir)) {
    if (!r.trace?.atif_uri || !existsSync(join(runDir, r.trace.atif_uri))) continue;
    const atif = readJson(join(runDir, r.trace.atif_uri));
    const report = checkClaims(segmentTurns(atif.steps ?? []), { catalog: cat, lexicon: lex, observation: r.trace.observation, names: s.names });
    out.push({ row_id: r.row_id, case_id: r.case_id, surface: r.surface, trial: r.trial, status: r.status, report, claims: explainClaims(report), silent: explainSilent(report) });
  }
  return out;
}
export function renderClaims(rows: RowClaims[]): string {
  const L: string[] = [];
  const unb = rows.filter((r) => r.report.unbacked.length);
  L.push(`claims_vs_ledger (offline re-read): ${rows.length} trajectories, ${rows.reduce((a, r) => a + r.report.findings.length, 0)} claim(s), ${unb.length} trial(s) with an unbacked claim, ${rows.filter((r) => r.report.silent.length).length} trial(s) with a silent action`, '');
  for (const r of rows) {
    if (!r.report.findings.length && !r.report.silent.length) continue;
    L.push(`${r.report.unbacked.length ? 'FAIL' : 'pass'} ${r.case_id} ${r.surface} t${r.trial} (row ${r.status})`, `  claims: ${r.claims}`, `  silent: ${r.silent}`);
  }
  return L.join('\n') + '\n';
}

/** Efficiency recomputed from the stored trajectories (dedupe applied even to runs recorded before it existed). */
export function efficiencyForRun(runDir: string, s: Settings = runSettings(runDir)): { markdown: string; byVariant: ReturnType<typeof aggregateEfficiency> } {
  const extra = existsSync(join(runDir, 'run-extra.json')) ? readJson(join(runDir, 'run-extra.json')) : {};
  const run = existsSync(join(runDir, 'run.json')) ? readJson(join(runDir, 'run.json')) : {};
  const rows = rowsOf(runDir).map((r) => {
    if (!r.trace?.atif_uri || !existsSync(join(runDir, r.trace.atif_uri))) return r;
    const e = trialEfficiency(readJson(join(runDir, r.trace.atif_uri)).steps ?? [], { names: s.names });
    const usage = { ...r.usage, tool_calls: e.tool_calls, duplicate_tool_calls: e.duplicate_tool_calls, turns: e.turns };
    // rows written before usage was optional carry 0/0/0 for "not reported": read that as unmeasured
    if (!usage.input_tokens && !usage.output_tokens && !usage.usd_list) { delete usage.input_tokens; delete usage.output_tokens; delete usage.usd_list; }
    return { ...r, usage };
  });
  const variants: string[] = run.surfaces ?? [...new Set(rows.map((r) => r.surface))];
  const byVariant = aggregateEfficiency(rows, variants, new Set(extra.retry_row_ids ?? []));
  return { markdown: renderEfficiency(byVariant).join('\n'), byVariant };
}
