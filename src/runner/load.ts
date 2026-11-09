// Suite loading, schema validation and the runner-enforced rules of §2.3 (outside the schema).
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';
import { validate } from '../lib/jsonschema.ts';
import { sha256 } from '../lib/hash.ts';
import { type CanonicalMap, resolveName, surfaceMatches } from '../lib/canonical.ts';
import { VIBIZ_PROFILE } from '../adapters/profiles.ts';
import type { Case, LoadedCase } from '../types.ts';

export function listCaseFiles(dir: string): string[] {
  const out: string[] = [];
  const walk = (d: string) => {
    for (const n of readdirSync(d).sort()) {
      const p = join(d, n);
      if (statSync(p).isDirectory()) walk(p);
      else if (n.endsWith('.case.json')) out.push(p);
    }
  };
  walk(dir);
  return out;
}

export type LoadResult = { cases: LoadedCase[]; errors: string[] };

export function loadCases(repoRoot: string, dirs: string[]): LoadResult {
  const schema = JSON.parse(readFileSync(join(repoRoot, 'schemas', 'case-1.schema.json'), 'utf8'));
  const cases: LoadedCase[] = [];
  const errors: string[] = [];
  for (const d of dirs) {
    for (const f of listCaseFiles(d)) {
      const raw = readFileSync(f);
      let obj: Case;
      try { obj = JSON.parse(raw.toString('utf8')); } catch (e) { errors.push(`${f}: invalid JSON: ${(e as Error).message}`); continue; }
      const errs = validate(schema, obj);
      if (errs.length) { errors.push(...errs.map((e) => `${relative(repoRoot, f)}: ${e.path} ${e.message}`)); continue; }
      cases.push(Object.assign(obj, { __file: relative(repoRoot, f), __sha256: sha256(raw) }));
    }
  }
  return { cases, errors };
}

/** §2.1: suite_version = sha256 of the sorted list of (case_id, case_version, case_file_sha256). */
export function suiteVersion(cases: LoadedCase[]): string {
  const rows = cases.map((c) => [c.id, c.version, c.__sha256] as const).sort((a, b) => (a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : a[1] - b[1]));
  return sha256(JSON.stringify(rows));
}

/** Interpretation (README): wildcards ('*', 'eve/*') cover the conversational channels only. eve/autopilot (no human,
 * wake/advance_clock inputs) and eve/web-ui (durability streams) run a case only when the case names them. */
const EXPLICIT_ONLY = new Set(VIBIZ_PROFILE.explicit_only);
export const appliesTo = (c: Case, surface: string): boolean =>
  EXPLICIT_ONLY.has(surface) ? c.surfaces.includes(surface) : c.surfaces.some((p) => surfaceMatches(p, surface));
export function overrideSkip(c: Case, surface: string): string | undefined {
  for (const [p, o] of Object.entries(c.overrides ?? {})) if (o.skip && surfaceMatches(p, surface)) return o.skip;
  return undefined;
}
export const toolsOf = (c: Case): string[] => [...new Set([
  ...(c.expect.calls ?? []).map((m) => m.tool), ...(c.expect.must_not_call ?? []), ...(c.expect.gated ?? []).map((g) => g.tool),
  ...(c.oracle.steps ?? []).flatMap((s) => ('call' in s ? [s.call] : [])),
])];

/** Runner rules (§2.3): admitted-judge gate, canonical resolution on every non-skipped surface, twins exist, unique ids. */
export function checkRunnerRules(
  cases: LoadedCase[], canonical: CanonicalMap, registry: { admitted: { dimension: string; version: string }[] },
  surfaces: string[], caps: (s: string) => ReadonlySet<string>,
): string[] {
  const errs: string[] = [];
  const ids = new Map<string, number>();
  for (const c of cases) ids.set(c.id, (ids.get(c.id) ?? 0) + 1);
  for (const [id, n] of ids) if (n > 1) errs.push(`duplicate case id ${id}`);
  for (const c of cases) {
    for (const g of c.graders) {
      if (g.id !== 'judge' || g.role !== 'gate') continue;
      const dims = (c.expect.judge ?? []).map((j) => j.rubric_ref.replace(/^.*\//, '').replace(/\.md$/, ''));
      const ok = dims.length > 0 && dims.every((d) => registry.admitted.some((a) => `${a.dimension}@${a.version}` === d));
      if (!ok) errs.push(`${c.id}: judge grader has role gate but ${dims.join(', ') || 'no dimension'} is not admitted in judges/registry.json`);
    }
    for (const t of toolsOf(c)) if (!canonical.ids[t]) errs.push(`${c.id}: canonical id ${t} not in packs/vibiz/catalog.v1.json`);
    for (const s of surfaces) {
      if (!appliesTo(c, s) || overrideSkip(c, s) || (c.requires ?? []).some((f) => !caps(s).has(f))) continue;
      for (const t of toolsOf(c)) if (canonical.ids[t] && !resolveName(canonical, t, s)) errs.push(`${c.id}: canonical id ${t} does not resolve on ${s} (add an override skip or a name)`);
    }
    if (c.twin && !ids.has(c.twin)) errs.push(`${c.id}: twin ${c.twin} not in the loaded suites`);
    if (c.provenance.source === 'migrated' && !c.provenance.source_ref) errs.push(`${c.id}: migrated case must cite source_ref`);
  }
  return errs;
}
