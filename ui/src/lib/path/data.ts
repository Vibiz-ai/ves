// Loading trials for the path canvases from either source the server reads: the results dir (/api/runs) or the run
// store (/api/store/runs). A run present in both is read from the results dir. Read-only GETs only.
import { useEffect, useState } from 'react';
import { getJson } from '../api.ts';
import type { ResultRow, RowsResponse, RunsResponse, StoreRunsResponse, TrajectoryResponse } from '../types.ts';
import { buildPath, type PathContext, type PathGraph } from './model.ts';

export type TrialRef = { runId: string; rowId: string; store: boolean };
export type TrialListing = { ref: TrialRef; row: ResultRow; created: string | null };
export type LoadedTrial = TrialListing & { graph: PathGraph; traj: TrajectoryResponse; context: PathContext | null };

export const apiBase = (store: boolean) => (store ? '/api/store/runs' : '/api/runs');
/** The run id a row id starts with (`<run>|<case>@<v>|<surface>|<trial>`). */
export const runOfRow = (rowId: string) => rowId.split('|')[0] ?? '';

const memo = new Map<string, Promise<unknown>>();
function cached<T>(url: string): Promise<T> {
  let p = memo.get(url) as Promise<T> | undefined;
  if (!p) { p = getJson<T>(url); memo.set(url, p); p.catch(() => memo.delete(url)); if (memo.size > 400) memo.delete(memo.keys().next().value!); }
  return p;
}

export async function loadContext(ref: Pick<TrialRef, 'runId' | 'store'>, caseId: string | null | undefined): Promise<PathContext | null> {
  try { return await cached<PathContext>(`${apiBase(ref.store)}/${encodeURIComponent(ref.runId)}/context${caseId ? `?case=${encodeURIComponent(caseId)}` : ''}`); }
  catch { return null; }
}

export async function loadTrial(ref: TrialRef): Promise<LoadedTrial> {
  const base = `${apiBase(ref.store)}/${encodeURIComponent(ref.runId)}`;
  const rows = await cached<RowsResponse>(`${base}/rows`);
  const row = rows.rows.find((r) => r.row_id === ref.rowId);
  if (!row) throw new Error(`No row ${ref.rowId} in ${ref.runId}`);
  const [traj, context] = await Promise.all([cached<TrajectoryResponse>(`${base}/trajectory?row=${encodeURIComponent(ref.rowId)}`), loadContext(ref, row.case_id)]);
  return { ref, row, created: row.created_at ?? null, traj, context, graph: buildPath({ atif: traj.atif, row, context }) };
}

/** Where to read a run from: the results dir when it is there, else the store. */
export async function resolveRef(runId: string, rowId: string, preferStore = false): Promise<TrialRef> {
  if (preferStore) return { runId, rowId, store: true };
  try { const r = await cached<RunsResponse>('/api/runs'); if (r.runs.some((x) => x.id === runId)) return { runId, rowId, store: false }; } catch { /* fall through */ }
  return { runId, rowId, store: true };
}

/** Every trial of one case across the results dir and the store (deduplicated by run id), newest first. */
export async function listCaseTrials(caseId: string): Promise<TrialListing[]> {
  const runs = new Map<string, { store: boolean; created: string | null }>();
  try { for (const r of (await getJson<RunsResponse>('/api/runs')).runs) runs.set(r.id, { store: false, created: r.created }); } catch { /* no results dir */ }
  try { const s = await getJson<StoreRunsResponse>('/api/store/runs'); for (const e of s.entries ?? []) if (!runs.has(e.run_id)) runs.set(e.run_id, { store: true, created: e.created }); } catch { /* no store */ }
  const out: TrialListing[] = [];
  await Promise.all([...runs.entries()].map(async ([runId, info]) => {
    try {
      const rows = await cached<RowsResponse>(`${apiBase(info.store)}/${encodeURIComponent(runId)}/rows`);
      for (const row of rows.rows) if (row.case_id === caseId) out.push({ ref: { runId, rowId: row.row_id, store: info.store }, row, created: info.created ?? row.created_at ?? null });
    } catch { /* unreadable run: skipped */ }
  }));
  out.sort((a, b) => String(b.created ?? '').localeCompare(String(a.created ?? '')) || (a.row.trial ?? 0) - (b.row.trial ?? 0));
  return out;
}

export type Async<T> = { data: T | null; error: string | null; loading: boolean };
export function useAsync<T>(key: string | null, fn: () => Promise<T>): Async<T> {
  const [s, set] = useState<Async<T>>({ data: null, error: null, loading: !!key });
  useEffect(() => {
    if (!key) { set({ data: null, error: null, loading: false }); return; }
    let live = true;
    set({ data: null, error: null, loading: true });
    fn().then((data) => live && set({ data, error: null, loading: false }), (e: Error) => live && set({ data: null, error: String(e?.message ?? e), loading: false }));
    return () => { live = false; };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [key]);
  return s;
}
