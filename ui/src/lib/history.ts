// Pure helpers for the History / Compare / Case timeline pages. Only trivial arithmetic on numbers the harness already
// computed (pass^1, Wilson CI and counts from the store index); every statistical comparison (bootstrap CI, Holm,
// above/level/below) comes from `ves compare --json` through /api/compare.
import type { RunSummary, StoreEntry } from './types.ts';

export type TrendPoint = {
  run_id: string; seq: number; pass1: number; lo: number; hi: number; n: number; verdict: string | null; decided_by: string | null;
  suite_version: string | null; suite_label: string | null; created: string | null; branch: string | null; sha: string | null; tier: string | null;
};
export type TrendBreak = { index: number; from: string; to: string };

/** One surface's pass^1 over runs (oldest first), with a break wherever the suite_version changes. */
export function trendSeries(entries: StoreEntry[], surface: string, f: { branch?: string | null; tier?: string | null } = {}): { points: TrendPoint[]; breaks: TrendBreak[] } {
  const points: TrendPoint[] = [];
  for (const e of entries) {
    if (f.branch && e.target.branch !== f.branch) continue;
    if (f.tier && e.tier !== f.tier) continue;
    const s = e.surfaces?.[surface];
    if (!s || !s.n_cases) continue;
    points.push({ run_id: e.run_id, seq: e.seq, pass1: s.pass1, lo: s.ci?.[0] ?? s.pass1, hi: s.ci?.[1] ?? s.pass1, n: s.n_cases, verdict: e.verdict, decided_by: e.decided_by, suite_version: e.suite_version, suite_label: e.suite_label, created: e.created, branch: e.target.branch, sha: e.target.sha, tier: e.tier });
  }
  const breaks: TrendBreak[] = [];
  for (let i = 1; i < points.length; i++) {
    if (points[i].suite_version !== points[i - 1].suite_version) breaks.push({ index: i, from: points[i - 1].suite_label ?? short(points[i - 1].suite_version), to: points[i].suite_label ?? short(points[i].suite_version) });
  }
  return { points, breaks };
}

/** Split a series at its breaks: a line or CI band never connects two suite versions. */
export function segments<T>(points: T[], breaks: { index: number }[]): T[][] {
  const cuts = [0, ...breaks.map((b) => b.index), points.length];
  const out: T[][] = [];
  for (let i = 0; i < cuts.length - 1; i++) if (cuts[i + 1] > cuts[i]) out.push(points.slice(cuts[i], cuts[i + 1]));
  return out;
}

export const short = (s: string | null | undefined): string => (s ? s.replace(/^tree:/, '').slice(0, 8) : '—');
export const uniq = <T,>(xs: (T | null | undefined)[]): T[] => [...new Set(xs.filter((x): x is T => x !== null && x !== undefined))];

/** `created` as epoch ms: results-dir summaries carry second precision, store entries millisecond precision. */
type Comparable = { id: string; created: number | null; tier: string | null; suite_version: string | null; pass1: Record<string, number> };
const ms = (iso: string | null | undefined): number | null => { const t = iso ? Date.parse(iso) : NaN; return Number.isFinite(t) ? t : null; };
export const fromSummary = (r: RunSummary): Comparable => ({ id: r.id, created: ms(r.created), tier: r.tier, suite_version: r.suite_version ?? null, pass1: Object.fromEntries(Object.entries(r.pass1 ?? {}).filter(([, v]) => v).map(([k, v]) => [k, v!.pass1])) });
export const fromEntry = (e: StoreEntry): Comparable => ({ id: e.run_id, created: ms(e.created), tier: e.tier, suite_version: e.suite_version, pass1: Object.fromEntries(Object.entries(e.surfaces ?? {}).filter(([, v]) => v.n_cases).map(([k, v]) => [k, v.pass1])) });

/** The newest run before `cur` with the same tier and suite_version (the only runs whose pass^1 may be compared). */
export function prevComparable(cur: Comparable, pool: Comparable[]): Comparable | null {
  if (!cur.suite_version || cur.created === null) return null;
  const c = pool.filter((p) => p.id !== cur.id && p.tier === cur.tier && p.suite_version === cur.suite_version && p.created !== null && p.created < cur.created!);
  c.sort((a, b) => a.created! - b.created!);
  return c[c.length - 1] ?? null;
}

/** Point delta of pass^1 per shared surface (no CI: the card says so) and the surface that moved most. */
export function pass1Delta(cur: Comparable, prev: Comparable): { per: { surface: string; diff: number }[]; top: { surface: string; diff: number } | null } {
  const per = Object.keys(cur.pass1).filter((s) => s in prev.pass1).map((s) => ({ surface: s, diff: cur.pass1[s] - prev.pass1[s] }));
  const top = per.reduce<{ surface: string; diff: number } | null>((m, x) => (!m || Math.abs(x.diff) > Math.abs(m.diff) ? x : m), null);
  return { per, top };
}

/** Default pair for Compare: head = newest run on the current branch (else newest run), base = newest main run of the
 * same tier before it, preferring the same suite_version. */
export function defaultPair(entries: StoreEntry[], currentBranch: string | null): { base: string | null; head: string | null } {
  if (!entries.length) return { base: null, head: null };
  const onBranch = currentBranch ? entries.filter((e) => e.target.branch === currentBranch && currentBranch !== 'main') : [];
  const head = (onBranch.length ? onBranch : entries)[(onBranch.length ? onBranch : entries).length - 1];
  const pool = entries.filter((e) => e.run_id !== head.run_id && e.tier === head.tier);
  const prefer = (xs: StoreEntry[], f: (e: StoreEntry) => boolean) => (xs.some(f) ? xs.filter(f) : xs);
  let cands = prefer(pool, (e) => e.target.branch === 'main');
  cands = prefer(cands, (e) => e.suite_version === head.suite_version);
  cands = prefer(cands, (e) => String(e.created ?? '') <= String(head.created ?? ''));
  return { base: cands[cands.length - 1]?.run_id ?? null, head: head.run_id };
}

export const pts = (x: number | null | undefined, digits = 1): string =>
  x === null || x === undefined || !Number.isFinite(x) ? '—' : `${x > 0 ? '+' : x < 0 ? '−' : '±'}${Math.abs(x * 100).toFixed(digits)} pts`;
