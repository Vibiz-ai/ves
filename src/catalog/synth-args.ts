// synthArgs (DESIGN-agnostic §4.2): a deterministic, minimal valid instance of a tool's input schema. IMPORTABLE.
//   required properties only; enum/const -> first value; integer/number -> minimum, else 1 (clamped to maximum);
//   boolean -> false; string by format (email, uri, date-time = fixture clock, date), else "<prop>-<n>" padded to
//   minLength; arrays -> one item (or minItems); oneOf/anyOf -> first branch; allOf -> merged.
// The result is validated against the schema; if it is not valid the caller gets null (the binding is skipped).
import { validate } from '../lib/jsonschema.ts';

export type SynthHints = { clock?: string; prefer?: Record<string, unknown> };

const resolveRef = (root: any, ref: string): any => {
  if (!ref.startsWith('#/')) return {};
  let cur = root;
  for (const p of ref.slice(2).split('/')) cur = cur?.[p.replace(/~1/g, '/').replace(/~0/g, '~')];
  return cur ?? {};
};

function build(s: any, root: any, prop: string, n: number, hints: SynthHints, depth: number): unknown {
  if (depth > 8) return null;
  if (s === true || s === undefined || s === null) return `${prop}-${n}`;
  if (s.$ref) return build(resolveRef(root, s.$ref), root, prop, n, hints, depth + 1);
  if ('const' in s) return s.const;
  if (Array.isArray(s.enum) && s.enum.length) return s.enum[0];
  if (Array.isArray(s.oneOf) && s.oneOf.length) return build(s.oneOf[0], root, prop, n, hints, depth + 1);
  if (Array.isArray(s.anyOf) && s.anyOf.length) return build(s.anyOf[0], root, prop, n, hints, depth + 1);
  if (Array.isArray(s.allOf) && s.allOf.length) {
    const merged: any = { ...s, allOf: undefined, properties: { ...(s.properties ?? {}) }, required: [...(s.required ?? [])] };
    for (const sub of s.allOf) { const r = sub.$ref ? resolveRef(root, sub.$ref) : sub; Object.assign(merged.properties, r.properties ?? {}); merged.required.push(...(r.required ?? [])); if (r.type && !merged.type) merged.type = r.type; }
    delete merged.allOf;
    return build(merged, root, prop, n, hints, depth + 1);
  }
  const type = Array.isArray(s.type) ? (s.type.find((t: string) => t !== 'null') ?? s.type[0]) : s.type ?? (s.properties ? 'object' : 'string');
  switch (type) {
    case 'object': {
      const out: Record<string, unknown> = {};
      for (const k of (s.required ?? []) as string[]) {
        if (hints.prefer && depth === 0 && k in hints.prefer) { out[k] = hints.prefer[k]; continue; }
        out[k] = build(s.properties?.[k] ?? {}, root, k, n, hints, depth + 1);
      }
      return out;
    }
    case 'array': {
      const count = Math.max(1, typeof s.minItems === 'number' ? s.minItems : 1);
      return Array.from({ length: count }, (_, i) => build(Array.isArray(s.items) ? s.items[0] : s.items ?? {}, root, prop, n + i, hints, depth + 1));
    }
    case 'integer': case 'number': {
      let v = typeof s.minimum === 'number' ? s.minimum : typeof s.exclusiveMinimum === 'number' ? s.exclusiveMinimum + 1 : 1;
      if (typeof s.maximum === 'number' && v > s.maximum) v = s.maximum;
      return type === 'integer' ? Math.ceil(v) : v;
    }
    case 'boolean': return false;
    case 'null': return null;
    default: {
      const clock = hints.clock ?? '2026-01-05T09:00:00Z';
      let v: string;
      if (s.format === 'email') v = `ves.user+${n}@example.test`;
      else if (s.format === 'uri' || s.format === 'url') v = `https://example.test/${n}`;
      else if (s.format === 'date-time') v = clock;
      else if (s.format === 'date') v = clock.slice(0, 10);
      else if (s.format === 'uuid') v = `00000000-0000-4000-8000-${String(n).padStart(12, '0').slice(-12)}`;
      else v = `${prop}-${n}`;
      if (typeof s.minLength === 'number' && v.length < s.minLength) v = v.padEnd(s.minLength, 'x');
      if (typeof s.maxLength === 'number' && v.length > s.maxLength) v = v.slice(0, s.maxLength);
      return v;
    }
  }
}

/** Deterministic minimal valid args for `schema`, or null if the synthesised instance does not validate. */
export function synthArgs(schema: unknown, seed: number, hints: SynthHints = {}): Record<string, unknown> | null {
  const s: any = schema && typeof schema === 'object' ? schema : { type: 'object' };
  const n = Math.abs(Math.trunc(seed)) % 1000;
  const v = build(s.type === undefined && !s.properties ? { ...s, type: 'object' } : s, s, 'arg', n, hints, 0);
  if (!v || typeof v !== 'object' || Array.isArray(v)) return null;
  return validate(s, v).length ? null : (v as Record<string, unknown>);
}

/**
 * Different valid args (`args_alt`): another seed; if that gives identical args, mutate the first string field
 * (append "-alt"), else bump the first number. Null if nothing valid and different can be built.
 */
export function synthArgsAlt(schema: unknown, base: Record<string, unknown>, seed: number, hints: SynthHints = {}): Record<string, unknown> | null {
  const s: any = schema && typeof schema === 'object' ? schema : { type: 'object' };
  const same = (a: unknown) => JSON.stringify(a) === JSON.stringify(base);
  const other = synthArgs(s, seed + 1, hints);
  if (other && !same(other)) return other;
  const mut = structuredClone(base);
  const props = (s.properties ?? {}) as Record<string, any>;
  const keys = Object.keys(mut);
  for (const k of keys) if (typeof mut[k] === 'string' && !props[k]?.enum && !('const' in (props[k] ?? {})) && !props[k]?.format) { mut[k] = `${mut[k]}-alt`; if (!validate(s, mut).length) return mut; mut[k] = base[k]; }
  for (const k of keys) if (typeof mut[k] === 'number') { mut[k] = (mut[k] as number) + 1; if (!validate(s, mut).length) return mut; mut[k] = base[k]; }
  const optional = Object.keys(props).filter((k) => !keys.includes(k));
  for (const k of optional) { const v = build(props[k], s, k, Math.abs(seed) % 1000, hints, 1); const cand = { ...mut, [k]: v }; if (!validate(s, cand).length && !same(cand)) return cand; }
  return null;
}
