// Persona library (VES-1 §2 persona input). A project keeps reusable people in `<config dir>/personas/<id>.persona.json`
// (`ves-persona/1`, schemas/persona-1.schema.json); a case names one with `input.persona.ref` and may override any field
// (goal, max_user_turns, opening, style, ...). An inline persona (`id` + `temperament` + `goal`) needs no library.
// Resolution is pure and offline. A case that uses a library persona gets the persona file's SHA folded into its
// `__sha256`, so editing the person changes suite_version like editing the case would. Persona text is data for the
// simulator prompt; nothing here interprets it.
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { join, relative } from 'node:path';
import { sha256 } from '../lib/hash.ts';
import { validate } from '../lib/jsonschema.ts';
import { schema } from './load.ts';
import type { CasePersona, LoadedCase2, PersonaFile, PersonaTemperament, ResolvedPersona } from '../core/types.ts';

export const PERSONA_SUFFIX = '.persona.json';
/** Used when neither the case nor the library sets max_user_turns. */
export const DEFAULT_MAX_USER_TURNS = 8;

export type PersonaLibrary = { dir: string; personas: Map<string, { p: PersonaFile; file: string; sha256: string }>; errors: string[] };

/** Load `<dir>/*.persona.json`. A missing dir is an empty library, not an error. */
export function loadPersonaLibrary(dir: string, relTo: string = dir): PersonaLibrary {
  const lib: PersonaLibrary = { dir, personas: new Map(), errors: [] };
  if (!existsSync(dir)) return lib;
  for (const f of readdirSync(dir).filter((n) => n.endsWith(PERSONA_SUFFIX)).sort()) {
    const path = join(dir, f);
    const rel = relative(relTo, path);
    const raw = readFileSync(path);
    let obj: PersonaFile;
    try { obj = JSON.parse(raw.toString('utf8')); } catch (e) { lib.errors.push(`${rel}: invalid JSON: ${(e as Error).message}`); continue; }
    const errs = validate(schema('persona-1'), obj);
    if (errs.length) { lib.errors.push(...errs.map((e) => `${rel}: ${e.path} ${e.message}`)); continue; }
    const stem = f.slice(0, -PERSONA_SUFFIX.length);
    if (obj.id !== stem) { lib.errors.push(`${rel}: id ${obj.id} must equal the file stem ${stem}`); continue; }
    lib.personas.set(obj.id, { p: obj, file: rel, sha256: sha256(raw) });
  }
  return lib;
}

const asList = (t: PersonaTemperament | PersonaTemperament[] | undefined): PersonaTemperament[] => (t === undefined ? [] : Array.isArray(t) ? [...t] : [t]);

/** Library entry (if any) + case fields -> the persona the simulator plays. Case fields win; `style` merges per key. */
export function resolvePersona(cp: CasePersona, lib: PersonaLibrary | null): { persona: ResolvedPersona | null; sha256: string | null; error?: string } {
  let base: PersonaFile | null = null;
  let sha: string | null = null;
  if (cp.ref) {
    const hit = lib?.personas.get(cp.ref);
    if (!hit) return { persona: null, sha256: null, error: `persona ref ${cp.ref} not found (looked in ${lib?.dir ?? 'no persona library'}; add personas/${cp.ref}${PERSONA_SUFFIX})` };
    base = hit.p; sha = hit.sha256;
  }
  const pick = <K extends keyof CasePersona>(k: K) => (cp[k] !== undefined ? cp[k] : (base as CasePersona | null)?.[k]);
  const temperament = asList(pick('temperament') as PersonaTemperament | PersonaTemperament[] | undefined);
  const goal = pick('goal') as string | undefined;
  const id = cp.id ?? cp.ref ?? base?.id;
  if (!id) return { persona: null, sha256: sha, error: 'persona needs an id or a ref' };
  if (!temperament.length) return { persona: null, sha256: sha, error: `persona ${id}: no temperament (set it in the case or the persona file)` };
  if (!goal?.trim()) return { persona: null, sha256: sha, error: `persona ${id}: no goal (set input.persona.goal in the case)` };
  const style = base?.style || cp.style ? { ...(base?.style ?? {}), ...(cp.style ?? {}) } : undefined;
  const opt = (k: 'name' | 'background' | 'opening') => { const v = pick(k) as string | undefined; return v ? { [k]: v } : {}; };
  const languages = pick('languages') as string[] | undefined;
  const persona: ResolvedPersona = {
    id, ...(cp.ref ? { ref: cp.ref } : {}), ...opt('name'), ...opt('background'), ...(languages?.length ? { languages: [...languages] } : {}),
    ...(style ? { style } : {}), ...opt('opening'), temperament, goal: goal.trim(), max_user_turns: (pick('max_user_turns') as number | undefined) ?? DEFAULT_MAX_USER_TURNS,
  };
  return { persona, sha256: sha };
}

/** The resolved persona of a loaded case (set by resolveCasePersonas), or null for a scripted case. */
export const personaOf = (c: LoadedCase2): ResolvedPersona | null => c.__persona ?? null;

/**
 * Resolve every persona case against the library: sets `__persona`, folds a library file's SHA into `__sha256`.
 * Returns errors (unknown ref, missing goal/temperament, a persona case that also replays a trace).
 */
export function resolveCasePersonas(cases: LoadedCase2[], lib: PersonaLibrary | null): string[] {
  const errs: string[] = [];
  for (const c of cases) {
    const cp = c.input.persona;
    if (!cp || personaOf(c)) continue;
    if (c.input.trace) { errs.push(`${c.id}: input.persona and input.trace cannot be combined (a recorded trace has no live agent to talk to)`); continue; }
    const r = resolvePersona(cp, lib);
    if (!r.persona) { errs.push(`${c.id}: ${r.error}`); continue; }
    Object.assign(c, { __persona: r.persona, ...(r.sha256 ? { __sha256: sha256(`${c.__sha256}|persona:${r.sha256}`) } : {}) });
  }
  return errs;
}
