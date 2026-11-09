// Pure data-shaping helpers. No statistics are computed here: only grouping, counting and lookups.
// Anything that is a VES statistic (pass^k, Wilson CI, bootstrap deltas, bounds) is read from the
// run's files (gate.json, run-extra.json, card.md tables) and shown as-is.
import type { AtifStep, AtifToolCall, CatalogEntry, ResultRow, RunSummary, Score, TrialStatus, Verdict } from './types.ts';

export const VERDICTS: Verdict[] = ['PASS', 'BLOCK', 'INVALID', 'REPORT_ONLY'];

export function normVerdict(v: unknown): Verdict | null {
  if (typeof v !== 'string') return null;
  const u = v.trim().toUpperCase().replace(/[\s-]+/g, '_');
  return (VERDICTS as string[]).includes(u) ? (u as Verdict) : null;
}

export function verdictLabel(v: Verdict | null): string {
  return v === 'REPORT_ONLY' ? 'REPORT ONLY' : v ?? 'NO VERDICT';
}

export function normStatus(s: unknown): TrialStatus | null {
  return s === 'pass' || s === 'fail' || s === 'skip' || s === 'invalid' ? s : null;
}

/** Counts for the verdict filter chips. */
export function verdictCounts(runs: Pick<RunSummary, 'verdict'>[]): Record<'ALL' | Verdict, number> {
  const out = { ALL: runs.length, PASS: 0, BLOCK: 0, INVALID: 0, REPORT_ONLY: 0 } as Record<'ALL' | Verdict, number>;
  for (const r of runs) {
    const v = normVerdict(r.verdict);
    if (v) out[v]++;
  }
  return out;
}

export type Matrix = {
  caseIds: string[];
  surfaces: string[];
  cells: Record<string, Record<string, ResultRow[]>>;
};

/** Group trial rows into a case × surface matrix, trials sorted by index. */
export function buildMatrix(rows: ResultRow[], surfaceOrder?: string[]): Matrix {
  const cells: Matrix['cells'] = {};
  const seenSurfaces = new Set<string>();
  for (const r of rows) {
    const c = r.case_id ?? '(no case_id)';
    const s = r.surface ?? '(no surface)';
    seenSurfaces.add(s);
    (cells[c] ??= {});
    (cells[c][s] ??= []).push(r);
  }
  for (const bySurface of Object.values(cells)) {
    for (const list of Object.values(bySurface)) list.sort((a, b) => (a.trial ?? 0) - (b.trial ?? 0));
  }
  const order = surfaceOrder?.length ? surfaceOrder : [];
  const surfaces = [...order, ...[...seenSurfaces].filter((s) => !order.includes(s)).sort()];
  return { caseIds: Object.keys(cells).sort(), surfaces, cells };
}

export type StatusCounts = { pass: number; fail: number; skip: number; invalid: number; total: number };

export function countRows(rows: ResultRow[]): StatusCounts {
  const c: StatusCounts = { pass: 0, fail: 0, skip: 0, invalid: 0, total: rows.length };
  for (const r of rows) {
    const s = normStatus(r.status);
    if (s) c[s]++;
  }
  return c;
}

/** Counted, not a VES statistic: passing / (passing + failing) trials. Null when nothing was graded. */
export function trialPassRate(c: Pick<StatusCounts, 'pass' | 'fail'>): number | null {
  const n = c.pass + c.fail;
  return n ? c.pass / n : null;
}

export type SurfaceCount = StatusCounts & { surface: string; n_cases: number; trial_pass_rate: number | null };

export function surfaceCounts(rows: ResultRow[], surfaceOrder?: string[]): SurfaceCount[] {
  const by = new Map<string, ResultRow[]>();
  for (const s of surfaceOrder ?? []) by.set(s, []);
  for (const r of rows) {
    const s = r.surface ?? '(no surface)';
    if (!by.has(s)) by.set(s, []);
    by.get(s)!.push(r);
  }
  return [...by.entries()].map(([surface, list]) => {
    const c = countRows(list);
    const graded = new Set(list.filter((r) => r.status !== 'skip').map((r) => r.case_id));
    return { surface, ...c, n_cases: graded.size, trial_pass_rate: trialPassRate(c) };
  });
}

// v1 safety graders (STANDARD §8.2). v2 rows mark these with scores[].safety === true.
export const SAFETY_GRADERS = new Set(['approval_invariant', 'no_upstream_on_guard', 'injection_noncompliance', 'tenant_isolation']);

export function isSafetyScore(s: Score): boolean {
  if (typeof s.safety === 'boolean') return s.safety;
  return SAFETY_GRADERS.has(s.grader_id ?? '') || SAFETY_GRADERS.has((s.name ?? '').replace(/^ves\./, ''));
}

export function isFailingScore(s: Score): boolean {
  return s.label === 'fail' || s.label === 'error';
}

export type SafetyViolation = { row: ResultRow; score: Score };

/** Rows where a safety grader scored fail/error. Zero tolerance: every one is listed. */
export function safetyViolations(rows: ResultRow[]): SafetyViolation[] {
  const out: SafetyViolation[] = [];
  for (const row of rows) for (const score of row.scores ?? []) if (isSafetyScore(score) && isFailingScore(score)) out.push({ row, score });
  return out;
}

/** Split a `G-3 safety` style rule label into its id and its name. */
export function ruleId(rule: string | null | undefined): { id: string; name: string } {
  if (!rule) return { id: '', name: '' };
  const m = /^((?:G-\d+[a-z]?)|(?:V\s*§[\d.]+)|(?:§[\d.]+))\s*(.*)$/.exec(rule.trim());
  return m ? { id: m[1], name: m[2] } : { id: '', name: rule };
}

// ---- markdown tables inside card.md -------------------------------------------------------------

export type MdTable = { headers: string[]; rows: string[][] };

function splitRow(line: string): string[] {
  let s = line.trim();
  if (s.startsWith('|')) s = s.slice(1);
  if (s.endsWith('|')) s = s.slice(0, -1);
  return s.split('|').map((c) => c.trim());
}

/** First pipe table after the first heading whose text matches `heading`. */
export function findCardTable(card: string | null | undefined, heading: RegExp): MdTable | null {
  if (!card) return null;
  const lines = card.split('\n');
  let i = lines.findIndex((l) => /^#{1,6}\s/.test(l) && heading.test(l));
  if (i < 0) return null;
  for (i = i + 1; i < lines.length; i++) {
    if (/^#{1,6}\s/.test(lines[i])) return null;
    if (lines[i].trim().startsWith('|') && lines[i + 1] && /^\s*\|?\s*:?-{2,}/.test(lines[i + 1])) {
      const headers = splitRow(lines[i]);
      const rows: string[][] = [];
      for (let j = i + 2; j < lines.length && lines[j].trim().startsWith('|'); j++) rows.push(splitRow(lines[j]));
      return { headers, rows };
    }
  }
  return null;
}

export type CardSurfaceMetrics = { pass1: string | null; pass1Ci: string | null; passk: string | null; passAtK: string | null; k: string | null; nCases: string | null; latency: string | null };

/** Per-surface statistics exactly as the harness printed them in card.md ("Per-surface metrics"). */
export function cardSurfaceMetrics(card: string | null | undefined): Record<string, CardSurfaceMetrics> {
  const t = findCardTable(card, /per-surface/i);
  if (!t) return {};
  const col = (re: RegExp) => t.headers.findIndex((h) => re.test(h));
  const cs = col(/^surface$/i), cn = col(/n cases/i), ck = col(/^k$/i), c1 = col(/pass\^1/i), cK = col(/^pass\^k/i), cA = col(/pass@k/i), cL = col(/latency/i);
  const out: Record<string, CardSurfaceMetrics> = {};
  const get = (r: string[], i: number) => (i >= 0 && r[i] && r[i] !== 'n/a' ? r[i] : null);
  for (const r of t.rows) {
    const s = get(r, cs);
    if (!s) continue;
    const p1 = get(r, c1);
    const m = p1 ? /^([^[]+?)\s*(\[.*\])?$/.exec(p1) : null;
    out[s.replace(/`/g, '')] = { pass1: m ? m[1].trim() : p1, pass1Ci: m?.[2] ?? null, passk: get(r, cK), passAtK: get(r, cA), k: get(r, ck), nCases: get(r, cn), latency: get(r, cL) };
  }
  return out;
}

// ---- trajectories --------------------------------------------------------------------------------

const EXT_KEYS = ['vibiz', 'ves', 'extra', 'metadata'];

function extOf(o: Record<string, unknown>): Record<string, unknown>[] {
  return EXT_KEYS.map((k) => o[k]).filter((v): v is Record<string, unknown> => !!v && typeof v === 'object');
}

/** Classes for a tool call: explicit on the call (v2), else from the pack catalog via canonical id. */
export function toolClasses(call: AtifToolCall, catalog?: { gated_classes?: string[]; ids?: Record<string, CatalogEntry> } | null): { classes: string[]; gated: boolean; canonical: string | null } {
  const exts = extOf(call as Record<string, unknown>);
  const pick = (k: string) => {
    for (const e of [call as Record<string, unknown>, ...exts]) if (e[k] !== undefined) return e[k];
    return undefined;
  };
  const canonical = (pick('canonical_id') ?? pick('canonical') ?? null) as string | null;
  let classes: string[] = [];
  const explicit = pick('classes') ?? pick('class');
  if (Array.isArray(explicit)) classes = explicit.map(String);
  else if (typeof explicit === 'string') classes = [explicit];
  const entry = canonical ? catalog?.ids?.[canonical] : undefined;
  if (!classes.length && entry) classes = entry.classes ?? (entry.class ? [entry.class] : []);
  let gated = pick('gated') === true || (entry?.gated ?? false) === true;
  if (!gated && catalog?.gated_classes?.length) gated = classes.some((c) => catalog.gated_classes!.includes(c));
  return { classes: [...new Set(classes)], gated, canonical };
}

function seqOf(id: string): number | null {
  const m = /^[a-z]+_(\d+)_/i.exec(id);
  return m ? Number(m[1]) : null;
}

export type EvidenceHit = { ids: string[]; how: 'exact' | 'sequence' };

/**
 * Map grader evidence ids onto trajectory steps.
 *  - exact: the id is the step_id, or appears verbatim anywhere inside the step (tool_call_id, approval id, result id).
 *  - sequence: ids like `fx_0003_…` share the ledger sequence number with `call_0003_…` on a step.
 * Returns step index -> hit.
 */
export function evidenceSteps(steps: AtifStep[], evidence: string[], approvalEvents: { id?: string; seq?: number }[] = []): Map<number, EvidenceHit> {
  const hits = new Map<number, EvidenceHit>();
  const add = (i: number, id: string, how: EvidenceHit['how']) => {
    const h = hits.get(i);
    if (h) { if (!h.ids.includes(id)) h.ids.push(id); if (how === 'exact') h.how = 'exact'; }
    else hits.set(i, { ids: [id], how });
  };
  const texts = steps.map((s) => JSON.stringify(s));
  for (const id of evidence) {
    if (!id) continue;
    let found = false;
    steps.forEach((s, i) => {
      if (String(s.step_id) === id || id === `step:${s.step_id}` || texts[i].includes(`"${id}"`)) { add(i, id, 'exact'); found = true; }
    });
    const ap = approvalEvents.find((a) => a.id === id);
    if (!found && ap && typeof ap.seq === 'number') {
      const i = steps.findIndex((s) => Number(s.step_id) === ap.seq);
      if (i >= 0) { add(i, id, 'exact'); found = true; }
    }
    if (found) continue;
    const seq = seqOf(id);
    if (seq === null) continue;
    steps.forEach((s, i) => {
      for (const c of s.tool_calls ?? []) if (c.tool_call_id && seqOf(c.tool_call_id) === seq) add(i, id, 'sequence');
    });
  }
  return hits;
}

export function messageText(m: unknown): string {
  if (m === null || m === undefined) return '';
  if (typeof m === 'string') return m;
  if (Array.isArray(m)) return m.map((p) => (typeof p === 'string' ? p : typeof p?.text === 'string' ? p.text : JSON.stringify(p))).join('\n');
  if (typeof m === 'object' && typeof (m as { text?: unknown }).text === 'string') return (m as { text: string }).text;
  return JSON.stringify(m, null, 2);
}

// ---- search ----------------------------------------------------------------------------------------

export type SearchItem = { kind: 'run' | 'case' | 'page'; id: string; title: string; subtitle: string; href: string };

export function searchItems(items: SearchItem[], query: string, limit = 12): SearchItem[] {
  const q = query.trim().toLowerCase();
  if (!q) return items.slice(0, limit);
  const terms = q.split(/\s+/);
  const scored: { item: SearchItem; score: number }[] = [];
  for (const item of items) {
    const hay = `${item.title} ${item.subtitle} ${item.id}`.toLowerCase();
    if (!terms.every((t) => hay.includes(t))) continue;
    const score = (item.title.toLowerCase().startsWith(q) ? 0 : 1) + (item.id.toLowerCase().includes(q) ? 0 : 0.5) + hay.length / 1000;
    scored.push({ item, score });
  }
  return scored.sort((a, b) => a.score - b.score).slice(0, limit).map((x) => x.item);
}

/** Sum of usage.usd_list across run summaries (only runs whose rows carry usd_list). */
export function totalSpend(runs: Pick<RunSummary, 'usd_rows' | 'usd_actual' | 'usd_cap'>[]): { usd: number | null; cap: number | null } {
  let usd = 0, seen = false, cap = 0, capSeen = false;
  for (const r of runs) {
    const v = r.usd_rows ?? r.usd_actual;
    if (typeof v === 'number') { usd += v; seen = true; }
    if (typeof r.usd_cap === 'number') { cap += r.usd_cap; capSeen = true; }
  }
  return { usd: seen ? usd : null, cap: capSeen ? cap : null };
}
