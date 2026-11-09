// `ves compare` and `ves history`: run-to-run comparison over stored (or local) run directories.
// The statistics are the runner's own (src/runner/run.ts comparisonsVs -> src/lib/stats.ts compareArms: paired
// cluster bootstrap by case, 10,000 resamples, seed 20261025, Holm across surfaces, reading above/level/below per
// STANDARD §5.5). Nothing is re-implemented here; this module only pairs runs and lists what changed.
//
// HONESTY RULE: the aggregate comparison is refused unless both runs have the same suite_version (STANDARD §11.2:
// "cross-version comparison is refused"). Per-case flips are then listed only for cases whose case_version is the
// same in both runs; cases whose version changed are listed as such and never compared.
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { canonicalJson } from '../lib/canonicalise.ts';
import { caseCounts, comparisonsVs } from '../runner/run.ts';
import { passHat1, wilson } from '../lib/stats.ts';
import { isSafetyScore } from '../graders/index.ts';
import type { Comparison } from '../lib/stats.ts';

export const COMPARE_SCHEMA = 'ves-compare/1';
export const HISTORY_SCHEMA = 'ves-history/1';

export type RunInfo = {
  run_id: string; created: string | null; sha: string | null; branch: string | null; tier: string | null; trigger: string | null;
  suite_version: string | null; suite_label: string | null; verdict: string | null; decided_by: string | null; source: string;
};
export type CaseCell = { case_id: string; case_version: number; surface: string; status: 'pass' | 'fail' | 'invalid' | 'skip'; c: number; n: number; row_ids: string[]; row_id: string | null; failing_graders: string[] };
export type Flip = { kind: 'pass→fail' | 'fail→pass' | 'new' | 'removed' | 'unscored'; case_id: string; case_version: number; surface: string; base: CaseCell | null; head: CaseCell | null };
export type SurfaceCompare = {
  surface: string;
  base: { pass1: number; ci: [number, number]; n_cases: number; k: number };
  head: { pass1: number; ci: [number, number]; n_cases: number; k: number };
  pass1: (Pick<Comparison, 'diff' | 'ci' | 'holm_alpha' | 'p' | 'p_holm' | 'reading' | 'non_inferior' | 'powered' | 'mde' | 'delta'> & { n_pairs: number }) | null;
  other_metrics: Comparison[];
};
export type CompareResult = {
  schema_version: typeof COMPARE_SCHEMA;
  base: RunInfo; head: RunInfo;
  comparable: boolean;
  refused: null | { reason: string; detail: string[] };
  hygiene: string[];
  surfaces: SurfaceCompare[];
  only_in_base: string[]; only_in_head: string[];
  flips: Flip[];
  flip_counts: Record<Flip['kind'], number>;
  version_changed: { case_id: string; base_version: number; head_version: number; surfaces: string[] }[];
  safety: { base_violations: number; head_violations: number; new: string[]; fixed: string[]; persisting: string[] };
  cost: { base: CostInfo; head: CostInfo; delta: { actual_usd: number | null; agent_usd_reported: number | null; tokens: number; tokens_per_case: number | null } };
  notes: string[];
};
type CostInfo = { actual_usd: number | null; agent_usd_reported: number | null; tokens: number; tokens_per_case: number | null; wall_s: number | null };

const readJson = (f: string) => (existsSync(f) ? JSON.parse(readFileSync(f, 'utf8')) : null);

/** run.json + results.jsonl + retry ids, like the runner's loadRun, but an unparsable result line is skipped and
 * counted (a stored run is evidence as it is; one bad line must not hide the rest of it). */
export function loadRunTolerant(dir: string): { manifest: any; rows: any[]; retry: Set<string>; bad_lines: number } {
  const manifest = readJson(join(dir, 'run.json'));
  if (!manifest) throw new Error(`${dir}: no run.json`);
  let bad = 0;
  const rows = existsSync(join(dir, 'results.jsonl')) ? readFileSync(join(dir, 'results.jsonl'), 'utf8').split('\n').filter((l) => l.trim()).flatMap((l) => {
    try { const r = JSON.parse(l); return r && typeof r === 'object' ? [r] : (bad++, []); } catch { bad++; return []; }
  }) : [];
  const extra = readJson(join(dir, 'run-extra.json')) ?? {};
  return { manifest, rows, retry: new Set(extra.retry_row_ids ?? []), bad_lines: bad };
}

/** Case-level cells of one run: counted trials exclude smoke confirmation retries, skips and INVALID rows (as the card). */
export function caseCells(rows: any[], retry: Set<string>): Map<string, CaseCell> {
  const m = new Map<string, CaseCell & { _inv: number; _skip: number }>();
  for (const r of rows) {
    if (retry.has(r.row_id)) continue;
    const key = `${r.case_id}|${r.surface}`;
    const x = m.get(key) ?? { case_id: r.case_id, case_version: r.case_version, surface: r.surface, status: 'skip' as CaseCell['status'], c: 0, n: 0, row_ids: [] as string[], row_id: null as string | null, failing_graders: [] as string[], _inv: 0, _skip: 0 };
    x.row_ids.push(r.row_id);
    if (r.status === 'invalid') x._inv++;
    else if (r.status === 'skip') x._skip++;
    else {
      x.n++;
      if (r.status === 'pass') x.c++;
      else {
        if (!x.row_id) x.row_id = r.row_id;
        for (const s of r.scores ?? []) if (s.role === 'gate' && s.label !== 'pass' && !x.failing_graders.includes(s.grader_id)) x.failing_graders.push(s.grader_id);
      }
    }
    m.set(key, x);
  }
  const out = new Map<string, CaseCell>();
  for (const [k, x] of m) {
    const status = x.n ? (x.c === x.n ? 'pass' : 'fail') : x._inv ? 'invalid' : 'skip';
    const { _inv, _skip, ...cell } = x;
    void _inv; void _skip;
    out.set(k, { ...cell, status, row_id: cell.row_id ?? cell.row_ids[0] ?? null });
  }
  return out;
}

const scored = (c: CaseCell | null | undefined) => !!c && (c.status === 'pass' || c.status === 'fail');

/** `<case_id>@<version>|<surface>#<grader>` for every failing/erroring safety score on a counted row (G-3 semantics). */
export function safetyKeys(rows: any[]): Set<string> {
  const out = new Set<string>();
  for (const r of rows) {
    if (r.status === 'invalid' || r.status === 'skip') continue;
    for (const s of r.scores ?? []) if (isSafetyScore(s) && (s.label === 'fail' || s.label === 'error')) out.add(`${r.case_id}@${r.case_version}|${r.surface}#${s.grader_id}`);
  }
  return out;
}

export function parseSafetyKey(k: string): { case_id: string; case_version: number; surface: string; grader: string } | null {
  const m = /^(.*)@(\d+)\|(.*)#([^#]*)$/.exec(k);
  return m ? { case_id: m[1], case_version: Number(m[2]), surface: m[3], grader: m[4] } : null;
}

/** §5.5 comparator hygiene apart from suite_version (which refuses outright): reported, not refused. */
export function hygieneNotes(a: any, b: any): string[] {
  const e: string[] = [];
  if (a.tier !== b.tier) e.push(`tier differs (${a.tier} vs ${b.tier})`);
  if (JSON.stringify([...(a.suite?.fixture_sha256s ?? [])].sort()) !== JSON.stringify([...(b.suite?.fixture_sha256s ?? [])].sort())) e.push('fixture SHAs differ');
  const av = (m: any) => JSON.stringify((m.adapters ?? []).map((x: any) => [x.surface, x.version]).sort());
  if (av(a) !== av(b)) e.push('adapter versions differ');
  if (canonicalJson(a.judge_config ?? null) !== canonicalJson(b.judge_config ?? null)) e.push('judge config differs');
  if (canonicalJson(a.user_simulator ?? null) !== canonicalJson(b.user_simulator ?? null)) e.push('user-simulator config differs');
  if (canonicalJson(a.k ?? {}) !== canonicalJson(b.k ?? {})) e.push('k differs (pass^k is compared only where k is equal)');
  if (a.config_sha256 && b.config_sha256 && a.config_sha256 !== b.config_sha256) e.push('config_sha256 differs');
  return e;
}

function costOf(m: any, rows: any[], nCases: number): CostInfo {
  const tokens = rows.reduce((s, r) => s + (Number(r.usage?.input_tokens) || 0) + (Number(r.usage?.output_tokens) || 0), 0);
  const rep = rows.some((r) => typeof r.usage?.usd_list === 'number' && r.usage.usd_list > 0) ? rows.reduce((s, r) => s + (Number(r.usage?.usd_list) || 0), 0) : null;
  return { actual_usd: typeof m.cost?.actual_usd === 'number' ? m.cost.actual_usd : null, agent_usd_reported: rep, tokens, tokens_per_case: nCases ? tokens / nCases : null, wall_s: typeof m.cost?.wall_s === 'number' ? m.cost.wall_s : null };
}

export function runInfo(dir: string, extra: { source: string; branch?: string | null; created?: string | null; suite_label?: string | null }): RunInfo {
  const m = readJson(join(dir, 'run.json')) ?? {};
  const g = readJson(join(dir, 'gate.json')) ?? {};
  return {
    run_id: m.run_id, created: extra.created ?? null, sha: m.target?.sha ?? null, branch: extra.branch ?? m.target?.branch ?? null, tier: m.tier ?? null, trigger: m.trigger ?? null,
    suite_version: m.suite?.version ?? null, suite_label: extra.suite_label ?? null, verdict: g.verdict ?? m.verdict ?? null, decided_by: g.decided_by ?? null, source: extra.source,
  };
}

/** Compare head against base (Δ = head − base). Both are run directories (materialised from the store or local). */
export function compareRunDirs(baseDir: string, headDir: string, o: { base: Parameters<typeof runInfo>[1]; head: Parameters<typeof runInfo>[1]; variants?: string[]; bootstrapN?: number }): CompareResult {
  const A = loadRunTolerant(baseDir);
  const B = loadRunTolerant(headDir);
  const am = A.manifest, bm = B.manifest;
  const notes: string[] = [];
  if (A.bad_lines) notes.push(`base results.jsonl: ${A.bad_lines} unparsable line(s) skipped`);
  if (B.bad_lines) notes.push(`head results.jsonl: ${B.bad_lines} unparsable line(s) skipped`);
  const sameSuite = !!am.suite?.version && am.suite.version === bm.suite?.version;
  const refused = sameSuite ? null : {
    reason: 'suite_version differs: the two runs ran different case sets, so pass^1 and its CI are not comparable (STANDARD §5.5, §11.2: cross-version comparison is refused)',
    detail: [`base suite ${String(am.suite?.version ?? '?').slice(0, 12)} (${am.suite?.case_count ?? '?'} cases)`, `head suite ${String(bm.suite?.version ?? '?').slice(0, 12)} (${bm.suite?.case_count ?? '?'} cases)`, 'per-case flips below cover only cases whose case_version is identical in both runs'],
  };
  const keep = (s: string) => !o.variants?.length || o.variants.includes(s);
  const sa: string[] = (am.surfaces ?? []).filter(keep), sb: string[] = (bm.surfaces ?? []).filter(keep);
  const both = sb.filter((s) => sa.includes(s));

  // ---- per-surface pass^1 with the runner's paired bootstrap (only when the suite is the same)
  const surfaces: SurfaceCompare[] = [];
  if (!refused && both.length) {
    const kEq: Record<string, number> = {};
    for (const s of both) kEq[s] = (am.k?.[s] ?? 1) === (bm.k?.[s] ?? 1) ? (bm.k?.[s] ?? 1) : 1;
    const cmps = comparisonsVs(B.rows as never, B.retry, { rows: A.rows as never, retry: A.retry }, both, kEq, { bootstrapN: o.bootstrapN });
    // per-run pass^1 and Wilson CI exactly as the card computes them (src/report/model.ts)
    const side = (R: typeof A, m: any, s: string) => {
      const cc = caseCounts(R.rows, s, R.retry);
      const [lo, hi] = wilson(cc.reduce((a, c) => a + c.c / c.n, 0), cc.length);
      return { pass1: cc.length ? passHat1(cc) : 0, pass1_ci: [lo ?? 0, hi ?? 0] as [number, number], n_cases: cc.length, k: m.k?.[s] ?? 1 };
    };
    for (const s of both) {
      const va = side(A, am, s), vb = side(B, bm, s);
      const p1 = cmps.find((c) => c.surface === s && c.metric === 'pass^1');
      surfaces.push({
        surface: s,
        base: { pass1: va.pass1, ci: va.pass1_ci, n_cases: va.n_cases, k: va.k },
        head: { pass1: vb.pass1, ci: vb.pass1_ci, n_cases: vb.n_cases, k: vb.k },
        pass1: p1 ? { diff: p1.diff, ci: p1.ci, holm_alpha: p1.holm_alpha, p: p1.p, p_holm: p1.p_holm, reading: p1.reading, non_inferior: p1.non_inferior, powered: p1.powered, mde: p1.mde, delta: p1.delta, n_pairs: p1.n_cases } : null,
        other_metrics: cmps.filter((c) => c.surface === s && c.metric !== 'pass^1'),
      });
      if (!p1) notes.push(`${s}: no case was scored in both runs; no pass^1 comparison`);
    }
  }

  // ---- per-case flips (case version must match)
  const ca = caseCells(A.rows, A.retry), cb = caseCells(B.rows, B.retry);
  const flips: Flip[] = [];
  const vchanged = new Map<string, { case_id: string; base_version: number; head_version: number; surfaces: string[] }>();
  for (const s of [...new Set([...sa, ...sb])]) {
    const ids = new Set<string>();
    for (const c of [...ca.values(), ...cb.values()]) if (c.surface === s) ids.add(c.case_id);
    for (const id of [...ids].sort()) {
      const x = ca.get(`${id}|${s}`) ?? null, y = cb.get(`${id}|${s}`) ?? null;
      if (x && y && x.case_version !== y.case_version) {
        const v = vchanged.get(id) ?? { case_id: id, base_version: x.case_version, head_version: y.case_version, surfaces: [] };
        v.surfaces.push(s);
        vchanged.set(id, v);
        continue;
      }
      if (!sa.includes(s) || !sb.includes(s)) continue; // a whole surface added/removed: listed in only_in_*
      if (x && !y) { flips.push({ kind: 'removed', case_id: id, case_version: x.case_version, surface: s, base: x, head: null }); continue; }
      if (!x && y) { flips.push({ kind: 'new', case_id: id, case_version: y.case_version, surface: s, base: null, head: y }); continue; }
      if (!x || !y) continue;
      if (scored(x) && scored(y)) {
        if (x.status === 'pass' && y.status === 'fail') flips.push({ kind: 'pass→fail', case_id: id, case_version: y.case_version, surface: s, base: x, head: y });
        else if (x.status === 'fail' && y.status === 'pass') flips.push({ kind: 'fail→pass', case_id: id, case_version: y.case_version, surface: s, base: x, head: y });
      } else if (scored(x) !== scored(y)) flips.push({ kind: 'unscored', case_id: id, case_version: y.case_version, surface: s, base: x, head: y });
    }
  }
  const order: Flip['kind'][] = ['pass→fail', 'fail→pass', 'new', 'removed', 'unscored'];
  flips.sort((p, q) => order.indexOf(p.kind) - order.indexOf(q.kind) || (p.case_id < q.case_id ? -1 : p.case_id > q.case_id ? 1 : p.surface < q.surface ? -1 : 1));
  const flip_counts = Object.fromEntries(order.map((k) => [k, flips.filter((f) => f.kind === k).length])) as Record<Flip['kind'], number>;

  // ---- safety: new vs fixed (case-level keys, so k and trial numbering do not matter)
  const keepRow = (r: any) => keep(r.surface) && !A.retry.has(r.row_id) && !B.retry.has(r.row_id);
  const va = safetyKeys(A.rows.filter(keepRow)), vb = safetyKeys(B.rows.filter(keepRow));
  const newV = [...vb].filter((k) => !va.has(k)).sort();
  // fixed = the same case (same version) is scored in head and no longer violates; otherwise it is only "gone"
  const fixed = [...va].filter((k) => {
    if (vb.has(k)) return false;
    const p = parseSafetyKey(k);
    const h = p ? cb.get(`${p.case_id}|${p.surface}`) : undefined;
    return !!p && scored(h) && h!.case_version === p.case_version;
  }).sort();
  const gone = [...va].filter((k) => !vb.has(k) && !fixed.includes(k));
  if (gone.length) notes.push(`${gone.length} base safety violation(s) are not in head because the case was removed, changed version or was not scored; they are not counted as fixed`);

  const nA = new Set(A.rows.map((r: any) => r.case_id)).size, nB = new Set(B.rows.map((r: any) => r.case_id)).size;
  const cA = costOf(am, A.rows, nA), cB = costOf(bm, B.rows, nB);
  const sub = (x: number | null, y: number | null) => (x === null || y === null ? null : y - x);
  const hygiene = hygieneNotes(am, bm);
  if (hygiene.length && !refused) notes.push('comparator hygiene differences (§5.5) make this descriptive, not admissible as a gate reference');
  return {
    schema_version: COMPARE_SCHEMA,
    base: runInfo(baseDir, o.base), head: runInfo(headDir, o.head),
    comparable: !refused, refused, hygiene, surfaces,
    only_in_base: sa.filter((s) => !sb.includes(s)), only_in_head: sb.filter((s) => !sa.includes(s)),
    flips, flip_counts, version_changed: [...vchanged.values()],
    safety: { base_violations: va.size, head_violations: vb.size, new: newV, fixed, persisting: [...vb].filter((k) => va.has(k)).sort() },
    cost: { base: cA, head: cB, delta: { actual_usd: sub(cA.actual_usd, cB.actual_usd), agent_usd_reported: sub(cA.agent_usd_reported, cB.agent_usd_reported), tokens: cB.tokens - cA.tokens, tokens_per_case: sub(cA.tokens_per_case, cB.tokens_per_case) } },
    notes,
  };
}

// ---------------------------------------------------------------------------------------------- history

export type HistoryPoint = RunInfo & { seq: number; cells: CaseCell[]; version_break: { from: number; to: number } | null };
export type HistoryResult = { schema_version: typeof HISTORY_SCHEMA; case_id: string; variant: string | null; runs: HistoryPoint[]; versions: number[]; runs_scanned: number };

/** One case across runs (oldest first). `runs` is the caller's ordered list of {dir|rows, info}. */
export function caseHistory(caseId: string, runs: { info: RunInfo; seq: number; rows: any[]; retry: Set<string> }[], o: { variant?: string } = {}): HistoryResult {
  const out: HistoryPoint[] = [];
  let prevVersion: number | null = null;
  for (const r of runs) {
    const cells = [...caseCells(r.rows.filter((x) => x.case_id === caseId && (!o.variant || x.surface === o.variant)), r.retry).values()].sort((a, b) => (a.surface < b.surface ? -1 : 1));
    if (!cells.length) continue;
    const v = cells[0].case_version;
    out.push({ ...r.info, seq: r.seq, cells, version_break: prevVersion !== null && prevVersion !== v ? { from: prevVersion, to: v } : null });
    prevVersion = v;
  }
  return { schema_version: HISTORY_SCHEMA, case_id: caseId, variant: o.variant ?? null, runs: out, versions: [...new Set(out.map((p) => p.cells[0].case_version))], runs_scanned: runs.length };
}

/** Suite versions numbered v1, v2, ... in order of first appearance (the labels the dashboard uses for BREAK markers). */
export function suiteLabels(entries: { suite_version: string | null }[]): Map<string, string> {
  const m = new Map<string, string>();
  for (const e of entries) if (e.suite_version && !m.has(e.suite_version)) m.set(e.suite_version, `v${m.size + 1}`);
  return m;
}

// ---------------------------------------------------------------------------------------------- markdown

const pct = (x: number | null | undefined) => (x === null || x === undefined || !Number.isFinite(x) ? '—' : `${(x * 100).toFixed(1)}%`);
const pts = (x: number | null | undefined) => (x === null || x === undefined || !Number.isFinite(x) ? '—' : `${x > 0 ? '+' : x < 0 ? '−' : '±'}${Math.abs(x * 100).toFixed(1)} pts`);
const cell = (c: CaseCell | null) => (c ? `${c.status} ${c.c}/${c.n}` : '—');
const usd = (x: number | null) => (x === null ? '—' : `$${x.toFixed(4)}`);
const short = (s: string | null) => (s ? s.replace(/^tree:/, '').slice(0, 8) : '—');
const runLine = (r: RunInfo) => `\`${r.run_id}\` · ${r.branch ?? 'no branch'} · ${short(r.sha)} · ${r.tier ?? '?'} · suite ${short(r.suite_version)}${r.suite_label ? ` (${r.suite_label})` : ''} · **${r.verdict ?? '?'}**${r.decided_by ? ` (${r.decided_by})` : ''}`;

export function renderCompareMd(c: CompareResult): string {
  const L: string[] = [];
  L.push(`# Compare: head vs base`, '', `- base: ${runLine(c.base)}`, `- head: ${runLine(c.head)}`, '');
  if (c.refused) {
    L.push(`> **Aggregate comparison refused.** ${c.refused.reason}.`, ...c.refused.detail.map((d) => `> - ${d}`), '');
  } else {
    L.push('## Per surface: pass^1, Δ = head − base', '', 'Paired cluster bootstrap by case (10,000 resamples, seed 20261025), Holm-adjusted CI across surfaces; reading per STANDARD §5.5.', '');
    L.push('| surface | base pass^1 | head pass^1 | Δ | CI (Holm) | reading | pairs |', '|---|---|---|---|---|---|---|');
    for (const s of c.surfaces) {
      const d = s.pass1;
      L.push(`| ${s.surface} | ${pct(s.base.pass1)} (n=${s.base.n_cases}) | ${pct(s.head.pass1)} (n=${s.head.n_cases}) | ${d ? pts(d.diff) : '—'} | ${d ? `[${pts(d.ci[0])}, ${pts(d.ci[1])}]` : '—'} | **${d?.reading ?? '—'}** | ${d?.n_pairs ?? 0} |`);
    }
    for (const s of c.surfaces) for (const m of s.other_metrics) L.push(`- ${s.surface} ${m.metric}: Δ ${pts(m.diff)} [${pts(m.ci[0])}, ${pts(m.ci[1])}] → ${m.reading}`);
    L.push('');
  }
  if (c.only_in_base.length || c.only_in_head.length) L.push(`Surfaces only in base: ${c.only_in_base.join(', ') || '—'}; only in head: ${c.only_in_head.join(', ') || '—'}`, '');
  if (c.hygiene.length) L.push(`Comparator hygiene (§5.5): ${c.hygiene.join('; ')}`, '');
  const fc = c.flip_counts;
  L.push(`## Flipped cases (${c.flips.length})`, '', `pass→fail ${fc['pass→fail']} · fail→pass ${fc['fail→pass']} · new ${fc.new} · removed ${fc.removed} · unscored ${fc.unscored}`, '');
  if (c.flips.length) {
    L.push('| change | case | surface | base | head | failing graders |', '|---|---|---|---|---|---|');
    for (const f of c.flips) L.push(`| ${f.kind} | ${f.case_id}@${f.case_version} | ${f.surface} | ${cell(f.base)} | ${cell(f.head)} | ${(f.head?.failing_graders.length ? f.head.failing_graders : f.base?.failing_graders ?? []).join(', ') || '—'} |`);
    L.push('');
  }
  if (c.version_changed.length) L.push(`Not compared (case version changed): ${c.version_changed.map((v) => `${v.case_id} v${v.base_version}→v${v.head_version}`).join(', ')}`, '');
  L.push('## Safety', '', `violations: base ${c.safety.base_violations}, head ${c.safety.head_violations} · new ${c.safety.new.length} · fixed ${c.safety.fixed.length} · persisting ${c.safety.persisting.length}`);
  for (const k of c.safety.new) L.push(`- NEW ${k}`);
  for (const k of c.safety.fixed) L.push(`- fixed ${k}`);
  L.push('', '## Cost', '', '| | base | head | Δ |', '|---|---|---|---|');
  L.push(`| harness USD (run.json cost.actual_usd) | ${usd(c.cost.base.actual_usd)} | ${usd(c.cost.head.actual_usd)} | ${usd(c.cost.delta.actual_usd)} |`);
  L.push(`| agent-reported USD | ${usd(c.cost.base.agent_usd_reported)} | ${usd(c.cost.head.agent_usd_reported)} | ${usd(c.cost.delta.agent_usd_reported)} |`);
  L.push(`| tokens | ${c.cost.base.tokens} | ${c.cost.head.tokens} | ${c.cost.delta.tokens} |`);
  if (c.notes.length) L.push('', ...c.notes.map((n) => `- note: ${n}`));
  return L.join('\n') + '\n';
}

export function renderHistoryMd(h: HistoryResult): string {
  const L: string[] = [`# History: ${h.case_id}${h.variant ? ` on ${h.variant}` : ''}`, '', `${h.runs.length} of ${h.runs_scanned} stored run(s) contain this case · case versions seen: ${h.versions.map((v) => `v${v}`).join(', ') || '—'}`, ''];
  if (!h.runs.length) return L.join('\n') + '\n';
  const surfaces = [...new Set(h.runs.flatMap((r) => r.cells.map((c) => c.surface)))].sort();
  L.push(`| # | run | created | branch | sha | suite | verdict | ${surfaces.join(' | ')} |`, `|---|---|---|---|---|---|---|${surfaces.map(() => '---').join('|')}|`);
  for (const r of h.runs) {
    if (r.version_break) L.push(`| | **BREAK** case v${r.version_break.from}→v${r.version_break.to} | | | | | |${surfaces.map(() => ' ').join('|')}|`);
    const mark = (s: string) => { const c = r.cells.find((x) => x.surface === s); return c ? `${c.status === 'pass' ? '●' : c.status === 'fail' ? '✕' : '○'} ${c.status} ${c.c}/${c.n}` : '—'; };
    L.push(`| ${r.seq} | \`${r.run_id}\` | ${r.created ?? '—'} | ${r.branch ?? '—'} | ${short(r.sha)} | ${r.suite_label ?? short(r.suite_version)} | ${r.verdict ?? '—'} | ${surfaces.map(mark).join(' | ')} |`);
  }
  return L.join('\n') + '\n';
}
