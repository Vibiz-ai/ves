// Case loading with schema dispatch (DESIGN-agnostic §3.6): each *.case.json is validated against the schema its
// `schema_version` names. case-1.schema.json is unchanged (byte-equal to STANDARD.md); v1 files keep their identity
// (__file, __sha256 of the original bytes), so suite_version for existing suites does not change.
import { readFileSync } from 'node:fs';
import { dirname, join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';
import { validate } from '../lib/jsonschema.ts';
import { sha256 } from '../lib/hash.ts';
import { listCaseFiles } from '../runner/load.ts';
import type { Case, LoadedCase } from '../types.ts';
import type { AnyLoadedCase, Case2, LoadedCase2, Tier } from '../core/types.ts';

const SCHEMAS = join(dirname(fileURLToPath(import.meta.url)), '..', '..', 'schemas');
const schemaCache = new Map<string, unknown>();
export function schema(name: 'case-1' | 'case-2' | 'pack-1' | 'result-1' | 'result-2' | 'run-1' | 'run-2' | 'config-1' | 'persona-1'): Record<string, unknown> {
  if (!schemaCache.has(name)) schemaCache.set(name, JSON.parse(readFileSync(join(SCHEMAS, `${name}.schema.json`), 'utf8')));
  return schemaCache.get(name) as Record<string, unknown>;
}

export const isV2 = (c: AnyLoadedCase | Case | Case2): c is LoadedCase2 => c.schema_version === 'ves-case/2';

export type DispatchLoadResult = { v1: LoadedCase[]; v2: LoadedCase2[]; errors: string[] };

/** Load every *.case.json under `dirs`, dispatching on schema_version. `relTo` makes __file relative (default repoRoot). */
export function loadCaseDirs(relTo: string, dirs: string[], o: { fixtureDirs?: string[] } = {}): DispatchLoadResult {
  const out: DispatchLoadResult = { v1: [], v2: [], errors: [] };
  for (const d of dirs) {
    for (const f of listCaseFiles(d)) {
      const raw = readFileSync(f);
      let obj: { schema_version?: string };
      try { obj = JSON.parse(raw.toString('utf8')); } catch (e) { out.errors.push(`${f}: invalid JSON: ${(e as Error).message}`); continue; }
      const rel = relative(relTo, f);
      if (obj.schema_version === 'ves-case/2') {
        const errs = validate(schema('case-2'), obj);
        if (errs.length) { out.errors.push(...errs.map((e) => `${rel}: ${e.path} ${e.message}`)); continue; }
        out.v2.push(Object.assign(obj as Case2, { __file: rel, __sha256: sha256(raw), __dir: dirname(f), __fixture_dirs: [d, ...(o.fixtureDirs ?? [])] }));
      } else if (obj.schema_version === 'ves-case/1') {
        const errs = validate(schema('case-1'), obj);
        if (errs.length) { out.errors.push(...errs.map((e) => `${rel}: ${e.path} ${e.message}`)); continue; }
        out.v1.push(Object.assign(obj as Case, { __file: rel, __sha256: sha256(raw) }));
      } else out.errors.push(`${rel}: unknown schema_version ${JSON.stringify(obj.schema_version)} (expected ves-case/1 or ves-case/2)`);
    }
  }
  return out;
}

/**
 * Single v2 case files (`ves run --extra-cases`, the PR head's added or changed cases when the suite comes from the
 * base worktree, §6.4). ves-case/1 files are refused here: they run with --profile vibiz.
 */
export function loadCaseFiles(relTo: string, files: string[], o: { fixtureDirs?: string[] } = {}): { v2: LoadedCase2[]; errors: string[] } {
  const out: { v2: LoadedCase2[]; errors: string[] } = { v2: [], errors: [] };
  for (const f of files) {
    let raw: Buffer;
    try { raw = readFileSync(f); } catch (e) { out.errors.push(`${f}: ${(e as Error).message}`); continue; }
    let obj: { schema_version?: string };
    try { obj = JSON.parse(raw.toString('utf8')); } catch (e) { out.errors.push(`${f}: invalid JSON: ${(e as Error).message}`); continue; }
    const rel = relative(relTo, f);
    if (obj.schema_version !== 'ves-case/2') { out.errors.push(`${rel}: --extra-cases takes ves-case/2 files (got ${JSON.stringify(obj.schema_version)})`); continue; }
    const errs = validate(schema('case-2'), obj);
    if (errs.length) { out.errors.push(...errs.map((e) => `${rel}: ${e.path} ${e.message}`)); continue; }
    out.v2.push(Object.assign(obj as Case2, { __file: rel, __sha256: sha256(raw), __dir: dirname(f), __fixture_dirs: [dirname(f), ...(o.fixtureDirs ?? [])] }));
  }
  return out;
}

/** §2.1 suite_version over v1 and v2 cases alike: sha256 of sorted (case_id, case_version, case_file_sha256). */
export function suiteVersionAny(cases: { id: string; version: number; __sha256: string }[]): string {
  const rows = cases.map((c) => [c.id, c.version, c.__sha256] as const).sort((a, b) => (a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : a[1] - b[1]));
  return sha256(JSON.stringify(rows));
}

/** Does a v2 case run at this tier (pack templates carry `tiers`)? */
export const inTier = (c: LoadedCase2, tier: Tier): boolean => !c.__tiers || c.__tiers.length === 0 || c.__tiers.includes(tier);
