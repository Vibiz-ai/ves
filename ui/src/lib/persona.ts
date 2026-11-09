// Persona cases: an AI user-simulator plays a synthetic person against the agent for several turns. Pure helpers:
// reading the row's `persona` block, the advisory `persona_outcome` score, the `vibiz.persona` tag on simulated user
// steps, and the by-persona table (persona × run or variant). Counting and means only; nothing here gates.
import type { AtifStep, Persona, PersonaGoalMet, ResultRow, Score, StepPersona } from './types.ts';

const isObj = (v: unknown): v is Record<string, unknown> => !!v && typeof v === 'object' && !Array.isArray(v);
const num = (v: unknown): number | null => (typeof v === 'number' && Number.isFinite(v) ? v : null);

/** The row's persona block, or null when this is not a persona trial. */
export function personaOf(row: ResultRow | null | undefined): Persona | null {
  const p = row?.persona;
  return isObj(p) ? (p as Persona) : null;
}

export const hasPersona = (rows: ResultRow[] | null | undefined): boolean => !!rows?.some((r) => personaOf(r));

/** Display name: the persona's name, else its id, else its library ref. */
export const personaLabel = (p: Persona | null | undefined): string => p?.name || p?.id || p?.ref || '(persona)';

/** Grouping key across trials: id, else ref, else name. */
export const personaKey = (p: Persona): string => p.id || p.ref || p.name || '(persona)';

export function isPersonaOutcomeScore(s: Score | null | undefined): boolean {
  if (!s) return false;
  return s.grader_id === 'persona_outcome' || (s.name ?? '').replace(/^ves\./, '') === 'persona_outcome';
}

export function personaOutcomeScore(row: ResultRow | null | undefined): Score | null {
  return row?.scores?.find(isPersonaOutcomeScore) ?? null;
}

const GOAL: PersonaGoalMet[] = ['yes', 'partly', 'no', 'unknown'];

/** goal_met from the outcome block, else read back from the persona_outcome score value (1 / 0.5 / 0). */
export function goalMet(row: ResultRow): PersonaGoalMet {
  const g = personaOf(row)?.outcome?.goal_met;
  if (typeof g === 'string' && (GOAL as string[]).includes(g)) return g as PersonaGoalMet;
  const v = num(personaOutcomeScore(row)?.value);
  return v === 1 ? 'yes' : v === 0.5 ? 'partly' : v === 0 ? 'no' : 'unknown';
}

/** Simulated user messages actually sent. */
export function userTurns(p: Persona): number | null {
  return num(p.user_turns) ?? num(p.metrics?.user_turns);
}

/** The `vibiz.persona` tag of a simulator-written user step (also read from the other extension keys). */
export function stepPersona(step: AtifStep | null | undefined): StepPersona | null {
  if (!step) return null;
  for (const k of ['vibiz', 'ves', 'extra', 'metadata']) {
    const e = (step as Record<string, unknown>)[k];
    if (isObj(e) && isObj(e.persona)) return e.persona as StepPersona;
  }
  return null;
}

/** Small label for a simulated user bubble: "opening · Inês" or "simulated · Inês". */
export function simulatedTag(sp: StepPersona, persona?: Persona | null): string {
  const who = persona && (!sp.id || persona.id === sp.id) ? personaLabel(persona) : sp.id || '(persona)';
  return `${sp.source === 'opening' ? 'opening' : 'simulated'} · ${who}`;
}

// ------------------------------------------------------------------------------------------- by-persona table

export type PersonaCell = {
  trials: number;
  yes: number; partly: number; no: number; unknown: number;
  /** yes / (yes + partly + no); null when nothing was judged. */
  goalShare: number | null;
  meanUserTurns: number | null;
  meanFrustration: number | null;
  meanToneFit: number | null;
  /** The trials behind the cell, in trial order (links to each conversation). */
  rows: { row_id: string; run_id?: string; trial?: number; status?: string; goal: PersonaGoalMet }[];
};
export type PersonaTableRow = { key: string; label: string; cells: Record<string, PersonaCell> };
export type PersonaTable = { columns: string[]; rows: PersonaTableRow[] };

const mean = (xs: number[]) => (xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : null);

function cellOf(rows: ResultRow[]): PersonaCell {
  const c = { yes: 0, partly: 0, no: 0, unknown: 0 };
  const turns: number[] = [], fr: number[] = [], tf: number[] = [];
  for (const r of rows) {
    const p = personaOf(r)!;
    c[goalMet(r)]++;
    const t = userTurns(p); if (t !== null) turns.push(t);
    const f = num(p.outcome?.frustration); if (f !== null) fr.push(f);
    const o = num(p.outcome?.tone_fit); if (o !== null) tf.push(o);
  }
  const judged = c.yes + c.partly + c.no;
  const list = [...rows].sort((a, b) => (a.trial ?? 0) - (b.trial ?? 0)).map((r) => ({ row_id: r.row_id, run_id: r.run_id, trial: r.trial, status: r.status, goal: goalMet(r) }));
  return { trials: rows.length, rows: list, ...c, goalShare: judged ? c.yes / judged : null, meanUserTurns: mean(turns), meanFrustration: mean(fr), meanToneFit: mean(tf) };
}

/**
 * Persona × column (variant within a run, or run across runs). Only rows carrying `persona` count; skipped trials are
 * left out. Columns keep `order` first, then any others seen, sorted.
 */
export function personaTable(rows: ResultRow[], columnOf: (r: ResultRow) => string, order: string[] = []): PersonaTable {
  const groups = new Map<string, { label: string; byCol: Map<string, ResultRow[]> }>();
  const seen = new Set<string>();
  for (const r of rows) {
    const p = personaOf(r);
    if (!p || r.status === 'skip') continue;
    const key = personaKey(p);
    const col = columnOf(r);
    seen.add(col);
    let g = groups.get(key);
    if (!g) { g = { label: personaLabel(p), byCol: new Map() }; groups.set(key, g); }
    if (!g.byCol.has(col)) g.byCol.set(col, []);
    g.byCol.get(col)!.push(r);
  }
  const columns = [...order.filter((c) => seen.has(c)), ...[...seen].filter((c) => !order.includes(c)).sort()];
  const out: PersonaTableRow[] = [...groups.entries()].sort(([a], [b]) => a.localeCompare(b)).map(([key, g]) => ({
    key, label: g.label, cells: Object.fromEntries([...g.byCol.entries()].map(([col, rs]) => [col, cellOf(rs)])),
  }));
  return { columns, rows: out };
}
