// Pack template expansion (DESIGN-agnostic §4.2). Deterministic and logic-free: a template names class SELECTORS,
// never tools; the expander binds them to the user's catalog and writes ves-case/2 cases. Identical inputs give
// identical bytes; any change to a bound tool's schema, intent or classes changes the case sha (and suite_version).
//
// Expressions ({{...}}): <b>.name .title .description .classes .intent .args .args_alt .args.<key>, seed, canary,
// canary2, foreign.entity[i], principal.tenant, options.<k>, pack.id, pack.version, twin:<template>.
// A string that is exactly "{{expr}}" is replaced by the typed value; inside longer strings non-strings are
// JSON.stringify'd. Unknown expressions are expansion errors; an unavailable value (no valid args) skips the binding.
import { existsSync, readFileSync } from 'node:fs';
import { isAbsolute, join } from 'node:path';
import { sha256 } from '../lib/hash.ts';
import { canonicalJson } from '../lib/canonicalise.ts';
import { validate } from '../lib/jsonschema.ts';
import { selectTools } from '../catalog/catalog.ts';
import { synthArgs, synthArgsAlt } from '../catalog/synth-args.ts';
import { resolveIntent } from './intents.ts';
import { schema } from './load.ts';
import type {
  Case2, Catalog, CatalogTool, ExpandCtx, IntentsLock, LoadedCase2, LoadedPack, ResolvedConfig, Tier, ToolSelector,
} from '../core/types.ts';

export type ExpandResult = {
  pack: string; version: string; cases: LoadedCase2[]; skipped?: string; errors: string[]; skippedBindings: string[];
  lowRealism: number; templates: number;
};

/** §4.2 seed rule: int(sha256("<pack>:<template>:<bindings>"),16) % 2**31. */
export const seedOf = (parts: string[]): number => Number(BigInt('0x' + sha256(parts.join(':'))) % 2147483648n);
/** `VES-CANARY-` + 10 hex of sha256("<seed>:<n>"). */
export const canaryOf = (seed: number, n: number): string => `VES-CANARY-${sha256(`${seed}:${n}`).slice(0, 10)}`;
const slug = (s: string) => s.toLowerCase().replace(/[^a-z0-9._-]+/g, '-').replace(/^-+|-+$/g, '');

export function describeSelector(sel: ToolSelector & { min?: number }): string {
  const bits: string[] = [];
  if (sel.gated === true) bits.push('gated');
  if (sel.gated === false) bits.push('non-gated');
  if (sel.classes_any) bits.push(sel.classes_any.join('|'));
  if (sel.classes_all) bits.push(sel.classes_all.join('+'));
  if (sel.classes_none) bits.push(`not ${sel.classes_none.join('|')}`);
  if (sel.returns_text) bits.push('text-returning');
  if (sel.has_required_args) bits.push('with required args');
  if (sel.name_matches) bits.push(`/${sel.name_matches}/`);
  return bits.join(' ') || 'any';
}

export type ExpandEnv = {
  catalog: Catalog; config: ResolvedConfig; intents: IntentsLock;
  /** Capabilities and role per variant in this run (requires.capabilities_any / variant_roles_any). */
  variants?: { name: string; role: string; capabilities: string[] }[];
};

/** Why a pack does not apply, or null. Never a silent pass, never a FAIL (§4.1). */
export function packSkipReason(p: LoadedPack, env: ExpandEnv): string | null {
  const r = p.manifest.requires ?? {};
  for (const sel of r.tools ?? []) {
    const min = sel.min ?? 1;
    const n = selectTools(env.catalog, sel).length;
    if (n < min) return sel.gated === true && Object.keys(sel).every((k) => k === 'gated' || k === 'min') ? 'no gated tools in catalog' : `needs ≥${min} ${describeSelector(sel)} tool(s), catalog has ${n}`;
  }
  const vs = env.variants ?? Object.values(env.config.variants).map((v) => ({ name: v.name, role: v.role, capabilities: v.capabilities }));
  if (r.variant_roles_any?.length && !vs.some((v) => r.variant_roles_any!.includes(v.role as never))) return `no ${r.variant_roles_any.join('|')} variant`;
  if (r.capabilities_any?.length && !vs.some((v) => r.capabilities_any!.some((c) => v.capabilities.includes(c)))) return `no variant has any of ${r.capabilities_any.join(', ')}`;
  if (r.profile && env.config.profile !== r.profile) return `profile ${r.profile} not enabled`;
  return null;
}

export type Binding = { key: string; tool: CatalogTool };
class Unavailable extends Error {}
/** The fixed clock every pack template expands with. */
export const PACK_CLOCK = '2026-01-05T09:00:00Z';
export const bindingString = (bs: Binding[]): string => bs.map((x) => `${x.key}=${x.tool.name}`).join(',');
/** Case id: `<pack>.<template>.<slug(bound names)>-<6 hex of "k=name,…">`, or `<pack>.<template>` with no bindings. */
export function caseIdOf(packId: string, template: string, bs: Binding[]): string {
  if (!bs.length) return `${packId}.${template}`;
  const base = `${packId}.${template}.${slug(bs.map((x) => x.tool.name).join('.'))}`.slice(0, 100).replace(/[-.]+$/, '');
  return `${base}-${sha256(bindingString(bs)).slice(0, 6)}`;
}
/**
 * Wrap an expanded case body (suite/safety from the manifest, owner, provenance, default fixture state + its sha).
 * provenance.source_ref records each bound tool's schema hash and classes, so a schema or class change always changes
 * the case sha (and suite_version), even when the synthesised args stay the same (§4.2).
 */
export function finishCase(p: Pick<LoadedPack, 'manifest' | 'dir'>, env: Pick<ExpandEnv, 'config'>, o: { template: string; version: number; file: string; bindings: Binding[]; body: Record<string, unknown> }): Case2 {
  const m = p.manifest;
  const fixture = { ...((o.body.fixture as Record<string, unknown>) ?? {}) };
  if (fixture.state === undefined) {
    const st = env.config.fixtures.state ?? (m.defaults?.state as string | undefined);
    if (st !== undefined) fixture.state = st;
  }
  if (typeof fixture.state === 'string' && fixture.state_sha256 === undefined) {
    const f = resolveFixturePath(fixture.state, [p.dir, env.config.dir]);
    if (f) fixture.state_sha256 = sha256(readFileSync(f));
  }
  const bs = o.bindings;
  return {
    schema_version: 'ves-case/2', id: caseIdOf(m.id, o.template, bs), version: o.version,
    ...(m.suite ? { suite: m.suite } : {}), ...(m.safety ? { safety: m.safety } : {}),
    ...(o.body as Partial<Case2>),
    fixture: fixture as Case2['fixture'],
    owner: (o.body.owner as string | undefined) ?? `pack:${m.id}`,
    provenance: {
      author: `${m.id}@${m.version}`, created: m.released, source: 'generated',
      source_ref: `${m.id}@${m.version}/${o.file}${bs.length ? `#${bs.map((b) => `${b.key}=${b.tool.name}@${b.tool.schema_sha256.slice(0, 12)}/${b.tool.classes.join('+')}${b.tool.gated ? '/gated' : ''}`).join(',')}` : ''}`,
      pack: { id: m.id, version: m.version, template: o.template, ...(bs.length ? { bindings: Object.fromEntries(bs.map((b) => [b.key, b.tool.name])) } : {}) },
    },
  } as Case2;
}

/** Expand one pack over a catalog. Pure apart from reading the pack's own fixture state file to hash it. */
export function expandPack(p: LoadedPack, env: ExpandEnv, options: Record<string, unknown> = {}): ExpandResult {
  const m = p.manifest;
  const res: ExpandResult = { pack: m.id, version: m.version, cases: [], errors: [], skippedBindings: [], lowRealism: 0, templates: p.templates.length };
  const skip = packSkipReason(p, env);
  if (skip) { res.skipped = skip; return res; }
  const opts: Record<string, unknown> = { ...(m.defaults ?? {}), ...options };
  for (const [k, sch] of Object.entries(m.options ?? {})) if (k in options) for (const e of validate(sch, options[k])) res.errors.push(`${m.id}: option ${k}${e.path === '/' ? '' : e.path} ${e.message}`);
  const principal = env.config.fixtures.principal;
  const foreign = foreignEntities(p, env.config);
  const clock = PACK_CLOCK;
  const tierOf = new Map<Case2, Tier[] | undefined>();

  const c_id = (template: string, bs: Binding[]): string => caseIdOf(m.id, template, bs);

  for (const { file, t } of p.templates) {
    const fe = t.for_each ?? {};
    const keys = Object.keys(fe).filter((k) => k !== 'limit');
    let limit = Infinity;
    const rawLimit = fe.limit ?? (m.defaults?.limit as number | undefined);
    if (typeof rawLimit === 'number') limit = rawLimit;
    else if (typeof rawLimit === 'string') {
      const mm = /^\{\{options\.([a-z_][a-z0-9_]*)\}\}$/i.exec(rawLimit);
      const v = mm ? opts[mm[1]] : Number(rawLimit);
      if (typeof v !== 'number' || !Number.isFinite(v)) { res.errors.push(`${m.id}/${file}: for_each.limit ${rawLimit} is not a number`); continue; }
      limit = v;
    }
    // cartesian product in key order, stable tool order, distinct_from respected. A binding is kept only when every
    // bound tool has usable args (intent args or synthesisable), THEN the product is capped at `limit`: capping first
    // would let a catalog whose first-ranked tool has an unsynthesisable schema silently lose the whole template.
    const hasArgs = (tool: CatalogTool): boolean => resolveIntent(tool, env.intents, () => synthArgs(tool.input_schema, 1, { clock })).args !== null;
    const combos: Binding[][] = [];
    const rec = (i: number, acc: Binding[]) => {
      if (combos.length >= limit) return;
      if (i === keys.length) {
        if (acc.every((b) => hasArgs(b.tool))) combos.push(acc);
        else res.skippedBindings.push(`${m.id}/${file} [${acc.map((x) => `${x.key}=${x.tool.name}`).join(',')}]: no valid args (add catalog examples or ves.intents.json)`);
        return;
      }
      const sel = fe[keys[i]] as ToolSelector;
      if (!sel || typeof sel !== 'object') { res.errors.push(`${m.id}/${file}: for_each.${keys[i]} must be a selector object`); return; }
      const excl = sel.distinct_from ? acc.filter((b) => b.key === sel.distinct_from).map((b) => b.tool.name) : [];
      for (const tool of selectTools(env.catalog, sel, Infinity, excl)) { rec(i + 1, [...acc, { key: keys[i], tool }]); if (combos.length >= limit) return; }
    };
    if (keys.length) rec(0, []); else combos.push([]);
    if (!combos.length) { res.skippedBindings.push(`${m.id}/${file}: no catalog tool matches ${keys.map((k) => `${k}: ${describeSelector(fe[k] as ToolSelector)}`).join(', ')}`); continue; }

    for (const bs of combos) {
      const bstr = bs.map((x) => `${x.key}=${x.tool.name}`).join(',');
      const seed = seedOf([m.id, t.template, bstr]);
      const cache = new Map<string, unknown>();
      let usedFallback = false;
      const toolVal = (b: Binding, field: string): unknown => {
        const key = `${b.key}.${field}`;
        if (cache.has(key)) return cache.get(key);
        const intent = () => {
          if (!cache.has(`${b.key}.__intent`)) cache.set(`${b.key}.__intent`, resolveIntent(b.tool, env.intents, () => synthArgs(b.tool.input_schema, seed, { clock })));
          return cache.get(`${b.key}.__intent`) as ReturnType<typeof resolveIntent>;
        };
        let v: unknown;
        if (field === 'name') v = b.tool.name;
        else if (field === 'title') v = b.tool.title ?? b.tool.name;
        else if (field === 'description') v = b.tool.description ?? '';
        else if (field === 'classes') v = [...b.tool.classes];
        else if (field === 'gated') v = b.tool.gated;
        else if (field === 'intent') { const i = intent(); if (i.source === 'fallback') usedFallback = true; v = i.say; }
        else if (field === 'args' || field.startsWith('args.')) {
          const args = intent().args ?? synthArgs(b.tool.input_schema, seed, { clock });
          if (!args) throw new Unavailable(`${b.tool.name}: no valid args can be synthesised from its input_schema`);
          v = field === 'args' ? args : args[field.slice(5)];
          if (v === undefined) throw new Unavailable(`${b.tool.name}: args has no ${field.slice(5)}`);
        } else if (field === 'args_alt') {
          const base = toolVal(b, 'args') as Record<string, unknown>;
          v = synthArgsAlt(b.tool.input_schema, base, seed, { clock });
          if (!v) throw new Unavailable(`${b.tool.name}: no different valid args (args_alt)`);
        } else throw new Error(`unknown expression {{${b.key}.${field}}}`);
        cache.set(key, v);
        return v;
      };
      const evalExpr = (expr: string): unknown => {
        const e = expr.trim();
        if (e === 'seed') return seed;
        if (e === 'canary') return canaryOf(seed, 1);
        if (e === 'canary2') return canaryOf(seed, 2);
        if (e === 'principal.tenant') return principal.tenant ?? 'default';
        if (e === 'pack.id') return m.id;
        if (e === 'pack.version') return m.version;
        let mm = /^foreign\.entity\[(\d+)\]$/.exec(e);
        if (mm) { const v = foreign[Number(mm[1])]; if (v === undefined) throw new Unavailable(`no foreign entity [${mm[1]}] (configure fixtures.tenants or the pack's foreign_tenant)`); return v; }
        mm = /^options\.([A-Za-z_][A-Za-z0-9_]*)$/.exec(e);
        if (mm) { if (!(mm[1] in opts)) throw new Error(`unknown option ${mm[1]}`); return opts[mm[1]]; }
        mm = /^twin:([a-z0-9][a-z0-9-]*)$/.exec(e);
        if (mm) return c_id(mm[1], bs);
        mm = /^([A-Za-z_][A-Za-z0-9_]*)\.(.+)$/.exec(e);
        if (mm) { const b = bs.find((x) => x.key === mm![1]); if (b) return toolVal(b, mm[2]); }
        throw new Error(`unknown expression {{${e}}}`);
      };
      const sub = (v: unknown): unknown => {
        if (typeof v === 'string') {
          const whole = /^\{\{([^{}]+)\}\}$/.exec(v);
          if (whole) return structuredClone(evalExpr(whole[1]));
          return v.replace(/\{\{([^{}]+)\}\}/g, (_, x: string) => { const r = evalExpr(x); return typeof r === 'string' ? r : JSON.stringify(r); });
        }
        if (Array.isArray(v)) return v.map(sub);
        // keys too: fixture.tool_overrides is keyed by tool name, e.g. {"{{tool.name}}": {"returns": …}}
        if (v && typeof v === 'object') return Object.fromEntries(Object.entries(v).map(([k, x]) => [k.includes('{{') ? String(sub(k)) : k, sub(x)]));
        return v;
      };
      let body: Record<string, unknown>;
      try { body = sub(t.case) as Record<string, unknown>; }
      catch (e) {
        if (e instanceof Unavailable) { res.skippedBindings.push(`${m.id}/${file} [${bstr}]: ${e.message}`); continue; }
        res.errors.push(`${m.id}/${file} [${bstr}]: ${(e as Error).message}`); continue;
      }
      if (usedFallback) res.lowRealism += 1;
      const id = c_id(t.template, bs);
      const c = finishCase(p, env, { template: t.template, version: t.version, file: `templates/${file}`, bindings: bs, body });
      const errs = validate(schema('case-2'), c);
      if (errs.length) { res.errors.push(...errs.map((e) => `${m.id}/${file} [${bstr}] -> ${id}: ${e.path} ${e.message}`)); continue; }
      res.cases.push(Object.assign(c, {
        __file: `${m.id}/templates/${file}#${bstr}`, __sha256: sha256(canonicalJson(c)), __dir: p.dir,
        __fixture_dirs: [p.dir, env.config.dir], ...(t.tiers ? { __tiers: t.tiers } : {}),
      }));
    }
  }
  if (p.module?.expand) {
    let extra: Case2[] = [];
    try { extra = p.module.expand(expandCtx(p, env, opts)); } catch (e) { res.errors.push(`${m.id}/pack.ts expand(): ${(e as Error).message}`); }
    // a module case may carry `__tiers` (template tiers) like a template expansion; anything else is all tiers
    for (const c of extra) { const tiers = (c as Case2 & { __tiers?: Tier[] }).__tiers; if (tiers) delete (c as Case2 & { __tiers?: Tier[] }).__tiers; tierOf.set(c, tiers); }
    for (const c of extra) {
      const errs = validate(schema('case-2'), c);
      if (errs.length) { res.errors.push(...errs.map((e) => `${m.id}/pack.ts -> ${c.id}: ${e.path} ${e.message}`)); continue; }
      const tiers = tierOf.get(c);
      res.cases.push(Object.assign(structuredClone(c), { __file: `${m.id}/pack.ts#${c.id}`, __sha256: sha256(canonicalJson(c)), __dir: p.dir, __fixture_dirs: [p.dir, env.config.dir], ...(tiers ? { __tiers: tiers } : {}) }));
    }
  }
  // never a silent pass (§4.1): a pack whose requirements are met but that binds nothing is an error, with the reasons
  if (!res.cases.length && !res.errors.length && (p.templates.length || p.module?.expand)) {
    res.errors.push(`${m.id}: no case could be expanded on this catalog (requirements met): ${[...new Set(res.skippedBindings)].slice(0, 6).join('; ') || 'no tool matches the template selectors'}`);
  }
  res.cases.sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
  const dup = res.cases.map((c) => c.id).filter((id, i, a) => a.indexOf(id) !== i);
  if (dup.length) res.errors.push(`${m.id}: duplicate expanded case ids ${[...new Set(dup)].join(', ')}`);
  return res;
}

/** The ExpandCtx handed to a PackModule (§7.3). */
export function expandCtx(p: LoadedPack, env: ExpandEnv, options: Record<string, unknown>): ExpandCtx {
  return {
    pack: p.manifest, options, catalog: env.catalog, config: env.config, intents: env.intents, seedOf,
    synthArgs: (s, seed) => synthArgs(s, seed), canary: canaryOf, select: (sel, limit) => selectTools(env.catalog, sel, limit),
  };
}

/** Foreign tenant entities: config fixtures.tenants (entities + entities_file), else the pack's defaults.foreign_tenant file. */
export function foreignEntities(p: LoadedPack | null, cfg: ResolvedConfig): string[] {
  const out: string[] = [];
  for (const t of cfg.fixtures.tenants ?? []) {
    out.push(...(t.entities ?? []));
    if (t.entities_file) { const f = resolveFixturePath(t.entities_file, [cfg.dir]); if (f) out.push(...(JSON.parse(readFileSync(f, 'utf8')).entities ?? [])); }
  }
  if (!out.length && p?.manifest.defaults?.foreign_tenant) {
    const f = resolveFixturePath(String(p.manifest.defaults.foreign_tenant), [p.dir]);
    if (f) out.push(...(JSON.parse(readFileSync(f, 'utf8')).entities ?? []));
  }
  return out;
}

/** Resolve a fixture path against an ordered list of directories (case dir, pack dir, config dir). */
export function resolveFixturePath(rel: string, dirs: string[]): string | null {
  if (isAbsolute(rel)) return existsSync(rel) ? rel : null;
  for (const d of dirs) { const f = join(d, rel); if (existsSync(f)) return f; }
  return null;
}
