// canonical-ids.json resolver (§3.2): canonical id -> per-surface tool name, safety class, effect, arg normalisers.
import { readFileSync } from 'node:fs';
import type { SideEffectKind } from '../types.ts';

export type CanonicalEntry = {
  class: 'read' | 'draft' | 'generate' | 'memory' | 'spend' | 'publish' | 'send' | 'pause' | 'delete';
  effect?: SideEffectKind;
  names: Record<string, string>;
  normalise?: Record<string, 'lower' | 'upper' | 'trim'>;
  verified?: boolean;
  source?: string[];
};
export type CanonicalMap = { gated_classes: string[]; ids: Record<string, CanonicalEntry>; generated: boolean };

export const OUTWARD_EFFECTS: ReadonlySet<SideEffectKind> = new Set<SideEffectKind>([
  'post_scheduled', 'post_published', 'email_sent', 'dm_sent', 'ad_launched', 'budget_changed', 'ad_paused', 'deleted',
]);

export function loadCanonical(file: string): CanonicalMap {
  return JSON.parse(readFileSync(file, 'utf8')) as CanonicalMap;
}

/** Surface pattern match as used by case.surfaces, case.overrides and canonical names: '*', 'eve/*', or exact. */
export function surfaceMatches(pattern: string, surface: string): boolean {
  if (pattern === '*') return true;
  if (pattern.endsWith('/*')) return surface.startsWith(pattern.slice(0, -1));
  return pattern === surface;
}
const specificity = (p: string): number => (p === '*' ? 0 : p.endsWith('/*') ? 1 : 2);

export function resolveName(map: CanonicalMap, id: string, surface: string): string | null {
  const e = map.ids[id];
  if (!e) return null;
  const hits = Object.keys(e.names).filter((p) => surfaceMatches(p, surface)).sort((a, b) => specificity(b) - specificity(a));
  return hits.length ? e.names[hits[0]] : null;
}
export const classOf = (map: CanonicalMap, id: string): string => map.ids[id]?.class ?? 'unknown';
export const isGated = (map: CanonicalMap, id: string): boolean => map.gated_classes.includes(classOf(map, id));
export const isWrite = (map: CanonicalMap, id: string): boolean => classOf(map, id) !== 'read';

export function normaliseArgs(map: CanonicalMap, id: string, args: Record<string, unknown>): Record<string, unknown> {
  const norm = map.ids[id]?.normalise ?? {};
  const out: Record<string, unknown> = { ...args };
  for (const [k, how] of Object.entries(norm)) {
    const v = out[k];
    if (typeof v !== 'string') continue;
    out[k] = how === 'lower' ? v.toLowerCase() : how === 'upper' ? v.toUpperCase() : v.trim();
  }
  return out;
}

/** JSON-subset match: every key in `want` appears in `got` with a subset-equal value. */
export function subsetMatch(want: unknown, got: unknown): boolean {
  if (want === null || typeof want !== 'object') return JSON.stringify(want) === JSON.stringify(got);
  if (Array.isArray(want)) return Array.isArray(got) && want.every((w, i) => subsetMatch(w, got[i]));
  if (!got || typeof got !== 'object') return false;
  return Object.entries(want as Record<string, unknown>).every(([k, v]) => subsetMatch(v, (got as Record<string, unknown>)[k]));
}
