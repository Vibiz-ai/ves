// Minimal JSON Schema (draft 2020-12 subset) validator: exactly the keywords the VES-1 schemas use.
// type, const, enum, pattern, minLength, maxLength, minimum, maximum, required, properties, additionalProperties,
// propertyNames, minProperties, items, minItems, uniqueItems, oneOf, anyOf, allOf, if/then, $ref (#/$defs/...),
// format (date, date-time, regex). Unknown keywords are ignored (annotations: description, default, title, $id).
// Written here because the runner takes no npm dependencies (no network to install them).

type Schema = Record<string, unknown> | boolean;
export type SchemaError = { path: string; message: string };

const typeOf = (v: unknown): string =>
  v === null ? 'null' : Array.isArray(v) ? 'array' : Number.isInteger(v) ? 'integer' : typeof v;
const matchesType = (v: unknown, t: string): boolean => {
  const a = typeOf(v);
  return t === a || (t === 'number' && (a === 'integer' || a === 'number'));
};
const deepEqual = (a: unknown, b: unknown): boolean => JSON.stringify(a) === JSON.stringify(b);

function resolveRef(root: Record<string, unknown>, ref: string): Schema {
  if (!ref.startsWith('#/')) throw new Error(`only local $ref supported: ${ref}`);
  let cur: unknown = root;
  for (const part of ref.slice(2).split('/')) cur = (cur as Record<string, unknown>)?.[part.replace(/~1/g, '/').replace(/~0/g, '~')];
  if (cur === undefined) throw new Error(`unresolved $ref ${ref}`);
  return cur as Schema;
}

function checkFormat(v: string, f: string): boolean {
  if (f === 'date') return /^\d{4}-\d{2}-\d{2}$/.test(v) && !Number.isNaN(Date.parse(v));
  if (f === 'date-time') return /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d+)?(Z|[+-]\d{2}:\d{2})$/.test(v);
  if (f === 'regex') { try { new RegExp(v, 'u'); return true; } catch { return false; } }
  return true;
}

export function validate(schema: Schema, value: unknown, root?: Record<string, unknown>): SchemaError[] {
  const errs: SchemaError[] = [];
  const r = (root ?? (schema as Record<string, unknown>)) as Record<string, unknown>;
  walk(schema, value, '', r, errs);
  return errs;
}

function walk(schema: Schema, v: unknown, path: string, root: Record<string, unknown>, errs: SchemaError[]): void {
  if (schema === true) return;
  if (schema === false) { errs.push({ path, message: 'not allowed' }); return; }
  const s = schema as Record<string, unknown>;
  const err = (message: string) => errs.push({ path: path || '/', message });

  if (typeof s.$ref === 'string') walk(resolveRef(root, s.$ref), v, path, root, errs);
  if (s.type !== undefined) {
    const ts = Array.isArray(s.type) ? (s.type as string[]) : [s.type as string];
    if (!ts.some((t) => matchesType(v, t))) { err(`expected ${ts.join('|')}, got ${typeOf(v)}`); return; }
  }
  if ('const' in s && !deepEqual(v, s.const)) err(`must equal ${JSON.stringify(s.const)}`);
  if (Array.isArray(s.enum) && !s.enum.some((e) => deepEqual(e, v))) err(`must be one of ${JSON.stringify(s.enum)}`);

  if (typeof v === 'string') {
    if (typeof s.pattern === 'string' && !new RegExp(s.pattern, 'u').test(v)) err(`does not match ${s.pattern}`);
    if (typeof s.minLength === 'number' && [...v].length < s.minLength) err(`shorter than ${s.minLength}`);
    if (typeof s.maxLength === 'number' && [...v].length > s.maxLength) err(`longer than ${s.maxLength}`);
    if (typeof s.format === 'string' && !checkFormat(v, s.format)) err(`invalid ${s.format}`);
  }
  if (typeof v === 'number') {
    if (typeof s.minimum === 'number' && v < s.minimum) err(`< minimum ${s.minimum}`);
    if (typeof s.maximum === 'number' && v > s.maximum) err(`> maximum ${s.maximum}`);
  }
  if (Array.isArray(v)) {
    if (typeof s.minItems === 'number' && v.length < s.minItems) err(`fewer than ${s.minItems} items`);
    if (s.uniqueItems === true && new Set(v.map((x) => JSON.stringify(x))).size !== v.length) err('items not unique');
    if (s.items !== undefined) v.forEach((x, i) => walk(s.items as Schema, x, `${path}/${i}`, root, errs));
  }
  if (v && typeof v === 'object' && !Array.isArray(v)) {
    const o = v as Record<string, unknown>;
    const props = (s.properties ?? {}) as Record<string, Schema>;
    if (Array.isArray(s.required)) for (const k of s.required as string[]) if (!(k in o)) err(`missing required "${k}"`);
    if (typeof s.minProperties === 'number' && Object.keys(o).length < s.minProperties) err(`fewer than ${s.minProperties} properties`);
    for (const [k, x] of Object.entries(o)) {
      if (s.propertyNames !== undefined) {
        const pe: SchemaError[] = [];
        walk(s.propertyNames as Schema, k, `${path}/${k}`, root, pe);
        if (pe.length) err(`property name "${k}" invalid: ${pe[0].message}`);
      }
      if (k in props) walk(props[k], x, `${path}/${k}`, root, errs);
      else if (s.additionalProperties === false) err(`unexpected property "${k}"`);
      else if (s.additionalProperties && typeof s.additionalProperties === 'object') walk(s.additionalProperties as Schema, x, `${path}/${k}`, root, errs);
    }
  }
  if (Array.isArray(s.allOf)) for (const sub of s.allOf as Schema[]) walk(sub, v, path, root, errs);
  if (Array.isArray(s.anyOf)) {
    if (!(s.anyOf as Schema[]).some((sub) => validate(sub, v, root).length === 0)) err('matches none of anyOf');
  }
  if (Array.isArray(s.oneOf)) {
    const n = (s.oneOf as Schema[]).filter((sub) => validate(sub, v, root).length === 0).length;
    if (n !== 1) err(`must match exactly one of oneOf (matched ${n})`);
  }
  if (s.if !== undefined) {
    const ok = validate(s.if as Schema, v, root).length === 0;
    if (ok && s.then !== undefined) walk(s.then as Schema, v, path, root, errs);
    if (!ok && s.else !== undefined) walk(s.else as Schema, v, path, root, errs);
  }
}
