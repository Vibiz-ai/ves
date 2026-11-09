// §2.6 results card (markdown). card.html (the extended bench viewer) is not implemented here: STUB.
import { isSafetyScore, SAFETY_GRADERS } from '../graders/index.ts';
import { clopperPearsonUpper, type CaseCounts, type Comparison, percentile, wilson } from '../lib/stats.ts';
import type { GateResult, SafetyValidity } from '../gate/gate.ts';
import { renderEfficiency, type VariantEfficiency } from './efficiency.ts';
import type { LoadedCase, ResultRow } from '../types.ts';

type SurfaceStats = { surface: string; k: number; cases: CaseCounts[]; n_cases: number; pass1: number; passk: number; passAtK: number; latency: number[] };
const pct = (x: number | null | undefined) => (x === null || x === undefined || !Number.isFinite(x) ? 'n/a' : `${(x * 100).toFixed(1)}%`);
const f3 = (x: number) => (Number.isFinite(x) ? x.toFixed(3) : 'n/a');

export function renderCard(x: {
  manifest: any; rows: ResultRow[]; stats: SurfaceStats[]; gate: GateResult; baseSummary: Record<string, any>; safetyValidity: SafetyValidity[];
  comparisons: Comparison[] | null; anchor: Comparison[] | null; cases: LoadedCase[]; retry: Set<string>; mode: string; quarantine: string[];
  /** v2 runs: per-variant efficiency (src/report/efficiency.ts); advisory, never gating. */
  efficiency?: Record<string, VariantEfficiency>;
}): string {
  const m = x.manifest;
  const L: string[] = [];
  const v2 = m.schema_version === 'ves-run/2';
  if (!v2) {
    L.push(`# VES-1 results card: ${m.run_id}`, '');
    if (x.mode === 'mock') L.push('> **MOCK RUN.** Every surface ran through the deterministic mock adapter. This card tests the harness, graders and gate; it is not evidence about Vibiz.', '');
  } else {
    L.push(`# VES results card: ${m.project} ${m.run_id}`, '');
    if (m.conformance === 'custom') L.push(`> **Not VES-1 conformant:** ${(m.loosened ?? []).join('; ')}. The verdict is still computed and binding for this repo.`, '');
    if (x.mode === 'mock') L.push('> **MOCK RUN.** Every variant ran on the MockAgent (oracle replay). This card tests the wiring, cases, packs and gate; it is not evidence about the agent.', '');
    if (m.report_only) L.push('> **REPORT ONLY.** This run cannot block (first run, fork PR or --report-only); `would_be` keeps the computed verdict.', '');
    for (const n of m.notes ?? []) L.push(`> Note: ${n}`);
    const obs = Object.entries(m.observation ?? {}).map(([k, v]) => `${k}=${v}`).join(', ');
    L.push(`- packs: ${(m.packs ?? []).map((p: any) => `${p.id}@${p.version} ${p.skipped ? `skipped (${p.skipped})` : `${p.cases} cases${p.low_realism_intents ? `, ${p.low_realism_intents} low-realism intents` : ''}`}`).join('; ') || 'none'}`);
    L.push(`- observation: ${obs}; catalog \`${String(m.catalog_sha256).slice(0, 12)}…\`; config \`${String(m.config_sha256).slice(0, 12)}…\`; harness source ${m.harness.source}`);
    if (m.new_cases?.length) L.push(`- new in this PR (advisory until merged): ${m.new_cases.join(', ')}`);
    if (m.trace_cases?.length) L.push(`- graded from recorded traces (no baseline arms replay them): ${m.trace_cases.length} case(s)`);
    L.push('');
    const nb = noBaselineNote(m, x.rows, x.comparisons, x.gate);
    if (nb) L.push(`> ${nb}`, '');
  }
  const alsoFired = x.gate.rules.filter((r) => r.status === 'fired' && r.rule !== x.gate.decided_by).map((r) => r.rule);
  L.push(`**Verdict: ${x.gate.verdict}**${x.gate.verdict !== x.gate.would_be ? ` (would be ${x.gate.would_be})` : ''}${x.gate.decided_by ? `, decided by ${x.gate.decided_by}` : ''}${alsoFired.length ? `; also fired: ${alsoFired.join(', ')}` : ''}`, '');
  L.push(`- tier \`${m.tier}\`, trigger \`${m.trigger}\`, target \`${m.target.sha}\`, change class ${m.target.change_class}, deploy targets ${m.target.deploy_targets.join(', ') || 'none'}`);
  L.push(`- suite_version \`${m.suite.version.slice(0, 16)}…\` (${m.suite.case_count} cases), run status \`${m.status}\`, INVALID rows ${pct(m.invalid_row_share)}`);
  L.push(`- cost: $${m.cost.actual_usd.toFixed(2)} list (pool ${m.cost.pool})${x.rows.some((r) => (r.usage as { usd_estimated?: boolean }).usd_estimated) ? ', agent cost partly estimated' : ''}; judge: ${m.judge_config.model ?? 'none (no admitted dimension, §4.4)'}`, '');

  // matrix
  const surfaces: string[] = m.surfaces;
  L.push(v2 ? '## Variant × case matrix' : '## Surface × case matrix', '', `| case | ${surfaces.join(' | ')} |`, `|---|${surfaces.map(() => '---').join('|')}|`);
  for (const c of [...x.cases].sort((a, b) => (a.id < b.id ? -1 : 1))) {
    const cells = surfaces.map((s) => {
      const rs = x.rows.filter((r) => r.case_id === c.id && r.surface === s);
      if (!rs.length) return '·';
      if (rs.every((r) => r.status === 'skip')) return `SKIP (${rs[0].skip_reason})`;
      const main = rs.filter((r) => !x.retry.has(r.row_id));
      const extra = rs.filter((r) => x.retry.has(r.row_id));
      const inv = main.filter((r) => r.status === 'invalid').length;
      const cell = `${main.filter((r) => r.status === 'pass').length}/${main.length - inv}${inv ? ` +${inv} INVALID` : ''}`;
      return extra.length ? `${cell} (retry ${extra.filter((r) => r.status === 'pass').length}/${extra.length})` : cell;
    });
    L.push(`| \`${c.id}\`${c.suite === 'safety' ? ' (safety)' : ''} | ${cells.join(' | ')} |`);
  }
  L.push('', 'Cells: passes/trials (skips and INVALID shown separately; skips are never averaged in).', '');

  // per-surface metrics
  L.push('## Per-surface metrics (never pooled)', '', '| surface | n cases | k | pass^1 [Wilson 95% over cases] | pass^k | pass@k (report only) | latency p50 / p95 ms |', '|---|---|---|---|---|---|---|');
  for (const s of x.stats) {
    const succ = s.cases.reduce((a, c) => a + c.c / c.n, 0);
    const [lo, hi] = wilson(succ, s.n_cases);
    L.push(`| ${s.surface} | ${s.n_cases} | ${s.k} | ${pct(s.pass1)} [${pct(lo)}, ${pct(hi)}] | ${pct(s.passk)} | ${pct(s.passAtK)} | ${percentile(s.latency, 50) ?? 'n/a'} / ${percentile(s.latency, 95) ?? 'n/a'} |`);
  }
  L.push('');

  const cmpTable = (title: string, cs: Comparison[] | null) => {
    L.push(`## ${title}`, '');
    if (!cs) { L.push('Not evaluated (no comparison run supplied).', ''); return; }
    L.push('| surface | metric | n cases | Δ | CI (Holm-adjusted) | reading | non-inferior (δ) | powered | MDE |', '|---|---|---|---|---|---|---|---|---|');
    for (const c of cs) L.push(`| ${c.surface} | ${c.metric} | ${c.n_cases} | ${f3(c.diff)} | [${f3(c.ci[0])}, ${f3(c.ci[1])}] α=${f3(c.holm_alpha)} | **${c.reading}** | ${c.non_inferior ? 'yes' : 'no'} (${c.delta}) | ${c.powered ? 'yes' : 'no'} | ${f3(c.mde)} |`);
    if (cs.some((c) => !c.powered)) L.push('', 'Unpowered tests: non-inferiority not demonstrable at this n (no A/A study yet; VH-06).');
    L.push('');
  };
  cmpTable('Δ vs reference (paired cluster bootstrap by case, 10,000 resamples, seed 20261025)', x.comparisons);
  cmpTable('Δ vs anchor', x.anchor);

  // safety
  L.push('## Safety (zero tolerance, per surface)', '', '| surface | grader | violations (rows) | violation-free cases | 95% one-sided case-level bound |', '|---|---|---|---|---|');
  // core safety graders in their v1 order, then pack safety graders (v1 cards are unchanged)
  const safetyIds = [...SAFETY_GRADERS as ReadonlySet<string>, ...[...new Set(x.rows.flatMap((r) => r.scores.filter((sc) => isSafetyScore(sc) && !SAFETY_GRADERS.has(sc.grader_id as never)).map((sc) => sc.grader_id)))].sort()];
  for (const s of surfaces) {
    for (const gid of safetyIds) {
      const rs = x.rows.filter((r) => r.surface === s && r.scores.some((sc) => sc.grader_id === gid));
      if (!rs.length) continue;
      const bad = rs.filter((r) => r.scores.some((sc) => sc.grader_id === gid && (sc.label === 'fail' || sc.label === 'error')));
      const caseIds = new Set(rs.map((r) => r.case_id));
      const badCases = new Set(bad.map((r) => r.case_id));
      const clean = caseIds.size - badCases.size;
      L.push(`| ${s} | ${gid} | ${bad.length} | ${clean}/${caseIds.size} | ${pct(clopperPearsonUpper(badCases.size, caseIds.size))} |`);
    }
  }
  L.push('', '| safety suite | surface | oracle-arm hit rate | do-nothing b-side passes | always-act a-side passes | valid |', '|---|---|---|---|---|---|');
  for (const v of x.safetyValidity) L.push(`| ${v.safety_suite} | ${v.surface} | ${v.oracle_hits}/${v.oracle_trials} (${pct(v.oracle_hit_rate)}) | ${v.trivial_b_pass}/${v.trivial_b_n} | ${v.always_act_a_pass}/${v.always_act_a_n} | ${v.ok ? 'yes' : 'NO: ' + v.reasons.join(', ')} |`);
  L.push('');

  L.push('## Baselines (§4.1 validity controls)', '', '| surface | oracle passes | trivial passes (units; twin pair = 1 unit) | trivial CP upper |', '|---|---|---|---|');
  for (const [s, b] of Object.entries(x.baseSummary)) L.push(`| ${s} | ${b.oracle_pass}/${b.oracle_n} | ${b.trivial_unit_pass}/${b.trivial_units} | ${pct(b.trivial_cp_upper)} |`);
  L.push('');

  // gate
  L.push('## Gate rules (§7.2, first fired decides)', '', '| rule | status | detail |', '|---|---|---|');
  for (const r of x.gate.rules) L.push(`| ${r.rule} | ${r.status === 'fired' ? `**FIRED → ${r.effect}**` : r.status} | ${r.detail.replace(/\|/g, '\\|')} |`);
  if (x.gate.override) L.push('', `Override: ${JSON.stringify(x.gate.override)}`);
  L.push('');

  if (x.efficiency) L.push(...renderEfficiency(x.efficiency));

  // cost & pins
  const used = x.rows.filter((r) => r.status !== 'skip');
  const tok = used.reduce((a, r) => a + (r.usage.input_tokens ?? 0) + (r.usage.output_tokens ?? 0), 0);
  const tc = used.reduce((a, r) => a + (r.usage.tool_calls ?? 0), 0);
  const itc = used.reduce((a, r) => a + (r.usage.invalid_tool_calls ?? 0), 0);
  const ff = used.reduce((a, r) => a + (r.usage.format_failures ?? 0), 0);
  L.push('## Cost and pinned set', '');
  const est = used.some((r) => (r.usage as { usd_estimated?: boolean }).usd_estimated) ? ' (agent cost partly estimated from tokens)' : '';
  L.push(`- tokens ${tok} total, $${m.cost.actual_usd.toFixed(4)} list${est}; invalid-tool-call rate ${tc ? pct(itc / tc) : 'n/a'}; format-failure rate ${used.length ? pct(ff / used.length) : 'n/a'}`);
  L.push(`- agent model: ${[...new Set(x.rows.map((r) => r.agent.model))].join(', ')}; prompt SHA: not reported; catalog SHA: not reported`);
  L.push(`- host families: ${[...new Set(x.rows.map((r) => r.host.family))].join(', ')}; protocol: ${[...new Set(x.rows.map((r) => r.host.protocol_version).filter(Boolean))].join(', ') || 'n/a'}`);
  L.push(`- judge: none; semconv commit: ${m.harness.semconv_commit}; conformance: ${m.harness.conformance_version}; harness: \`${m.harness.evals_sha}\` (${m.harness.package_version})`, '');
  L.push('## Declared differences from production', '');
  for (const a of m.adapters) for (const d of a.diffs_from_prod) L.push(`- \`${a.surface}\` (${a.version}): ${d}`);
  L.push('', `Accepted risks: ${x.gate.accepted_risks.length ? x.gate.accepted_risks.map((r) => `${r.surface}/${r.host_family}/${r.tool}/${r.path} (${r.signed_by})`).join('; ') : 'none'}. Quarantined cases: ${x.quarantine.join(', ') || 'none'}.`, '');
  L.push('## Known limitations', '', '- No judge dimension is admitted (§4.4); judge scores, if any, are advisory and not computed by this harness.',
    '- The infra classifier has not met VH-16; cached replay (§5.8) is not implemented (hit_ratio is always 0).',
    '- No A/A study exists, so every comparison is unpowered and the MDE is from this run\'s bootstrap SE.',
    '- card.html (extended bench viewer) is not produced; this markdown card is the only rendering.', '');
  return L.join('\n');
}

/**
 * VES-1 does not block on capability failures without a reference run (G-6/G-7 need a baseline). A first run on a
 * fresh repo can therefore PASS with many failing trials; say so on the card instead of letting "PASS" read as
 * "the agent is good". Wording only: the gate is unchanged.
 */
export function noBaselineNote(m: any, rows: { status: string; scores: { role: string; label: string; grader_id: string; safety?: boolean }[] }[], comparisons: unknown[] | null, gate: { verdict: string; would_be: string }): string | null {
  if (comparisons || (gate.verdict !== 'PASS' && gate.would_be !== 'PASS')) return null;
  const failed = rows.filter((r) => r.status === 'fail').length;
  const counted = rows.filter((r) => r.status === 'pass' || r.status === 'fail').length;
  if (!failed) return null;
  return `**PASS without a baseline.** Safety (G-3), contract (G-2) and suite validity held, but ${failed}/${counted} trial(s) failed a non-safety check and the regression rules G-6/G-7 were not evaluated (change class ${m.target?.change_class ?? '?'}, no reference run). Capability failures block only against a baseline: merge once to main so CI stores one (§6.4), or pass \`--baseline <run-dir>\`.`;
}
