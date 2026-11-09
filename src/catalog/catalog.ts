// Tool catalog (DESIGN-agnostic §2.3). IMPORTABLE by every package. Pure functions, no I/O.
//   read         no state change anywhere (exclusive: may not be combined with any other class)
//   write        changes state in the team's own system
//   spend        costs money or credits                         implies write
//   outward      reaches a person or system outside the team    implies write
//   destructive  irreversible delete or overwrite               implies write
//   gated        needs a human approval before it runs (G1)     implies write
// `gated` is entry.gated if set, else classes ∩ gate_classes ≠ ∅ (default spend/outward/destructive). Unreviewed
// (`review: "suggested"`) non-read tools are gated (conservative). gated:false on a default-gated class is a
// loosened bar (conformance "custom").
import { argsHash, sha256 } from '../lib/hash.ts';
import { canonicalJson } from '../lib/canonicalise.ts';
import type { Catalog, CatalogEntry, CatalogTool, JsonSchema, ToolClass, ToolSelector } from '../core/types.ts';

export const TOOL_CLASSES: readonly ToolClass[] = ['read', 'write', 'spend', 'outward', 'destructive', 'gated'];
export const DEFAULT_GATE_CLASSES: readonly ToolClass[] = ['spend', 'outward', 'destructive'];
export const TOOL_NAME_RE = /^[A-Za-z0-9_][A-Za-z0-9_.:/-]{0,127}$/;
const IMPLY_WRITE: readonly ToolClass[] = ['spend', 'outward', 'destructive', 'gated'];

export const riskOf = (classes: readonly ToolClass[]): number =>
  classes.includes('destructive') ? 4 : classes.includes('spend') ? 3 : classes.includes('outward') ? 2 : classes.includes('write') ? 1 : 0;

export type BuildCatalogResult = { catalog: Catalog; errors: string[] };

/** Variant pattern match ('*', 'x/*', exact), as v1 `surfaceMatches`. */
export function variantMatches(pattern: string, variant: string): boolean {
  if (pattern === '*') return true;
  if (pattern.endsWith('/*')) return variant.startsWith(pattern.slice(0, -1));
  return pattern === variant;
}

/**
 * Build the resolved catalog. `declared` supplies schemas for `schemas_from` = bridge|mcp|file (merged by name when
 * the entry has no input_schema). Errors are validation errors (`ves validate`); the catalog is still returned.
 */
export function buildCatalog(entries: CatalogEntry[], o: { gate_classes?: ToolClass[]; declared?: { name: string; description?: string; input_schema?: unknown; annotations?: CatalogEntry['annotations'] }[] } = {}): BuildCatalogResult {
  const gateClasses = [...(o.gate_classes ?? DEFAULT_GATE_CLASSES)];
  const errors: string[] = [];
  const loosened: string[] = [];
  const warnings: string[] = [];
  for (const c of DEFAULT_GATE_CLASSES) if (!gateClasses.includes(c)) loosened.push(`tools.gate_classes omits ${c}`);
  const declared = new Map((o.declared ?? []).map((d) => [d.name, d]));
  const seen = new Set<string>();
  const tools: CatalogTool[] = [];
  for (const e of entries) {
    if (!e || typeof e.name !== 'string' || !TOOL_NAME_RE.test(e.name)) { errors.push(`tools.catalog: invalid tool name ${JSON.stringify(e?.name)}`); continue; }
    if (seen.has(e.name)) { errors.push(`tools.catalog: duplicate tool ${e.name}`); continue; }
    seen.add(e.name);
    const raw = Array.isArray(e.classes) ? e.classes : [];
    const unknown = raw.filter((c) => !TOOL_CLASSES.includes(c));
    if (unknown.length) errors.push(`tools.catalog.${e.name}: unknown class(es) ${unknown.join(', ')}`);
    if (!raw.length) errors.push(`tools.catalog.${e.name}: classes must not be empty`);
    if (raw.includes('read') && raw.length > 1) errors.push(`tools.catalog.${e.name}: read must not be combined with another class (${raw.join(', ')})`);
    if (unknown.length || !raw.length || (raw.includes('read') && raw.length > 1)) continue; // invalid entries are reported, not served
    const set = new Set<ToolClass>(raw.filter((c) => TOOL_CLASSES.includes(c)));
    if (IMPLY_WRITE.some((c) => set.has(c))) set.add('write');
    const explicitGatedClass = set.has('gated');
    set.delete('gated');
    const classes = (['read', 'write', 'spend', 'outward', 'destructive'] as ToolClass[]).filter((c) => set.has(c));
    const isRead = classes.length === 1 && classes[0] === 'read';
    const byClass = classes.some((c) => gateClasses.includes(c));
    let gated: boolean; let reason: CatalogTool['gated_reason'];
    if (explicitGatedClass || e.gated === true) { gated = true; reason = 'explicit'; }
    else if (e.gated === false) {
      gated = false; reason = 'explicit-false';
      if (classes.some((c) => DEFAULT_GATE_CLASSES.includes(c))) loosened.push(`tools.${e.name}.gated=false`);
    } else if (byClass) { gated = true; reason = 'class'; }
    else if (e.review === 'suggested' && !isRead) { gated = true; reason = 'unreviewed'; }
    else { gated = false; reason = 'none'; }
    if (e.review === 'suggested') warnings.push(`tools.${e.name}: classes are suggested, not reviewed (set review: "confirmed")`);
    const d = declared.get(e.name);
    const input_schema = (e.input_schema ?? d?.input_schema ?? { type: 'object' }) as JsonSchema;
    tools.push({
      ...e, classes, gated, gated_reason: reason, input_schema,
      ...(e.description === undefined && d?.description ? { description: d.description } : {}),
      ...(e.annotations === undefined && d?.annotations ? { annotations: d.annotations } : {}),
      schema_sha256: sha256(canonicalJson(input_schema)), risk: riskOf(classes),
    });
  }
  tools.sort((a, b) => b.risk - a.risk || (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
  const byName: Record<string, CatalogTool> = Object.fromEntries(tools.map((t) => [t.name, t]));
  const catalog: Catalog = { tools, byName, gate_classes: gateClasses, sha256: sha256(canonicalJson({ gate_classes: gateClasses, tools })), loosened, warnings };
  return { catalog, errors };
}

/** A tool the catalog does not know: conservative write + gated (§1.6 step 1). */
export const UNKNOWN_CLASSES: ToolClass[] = ['write'];
export const isKnown = (cat: Catalog, name: string): boolean => !!cat.byName[name];
export const isGated = (cat: Catalog, name: string): boolean => cat.byName[name]?.gated ?? true;
export const classesOf = (cat: Catalog, name: string): ToolClass[] => cat.byName[name]?.classes ?? UNKNOWN_CLASSES;
export const isWrite = (cat: Catalog, name: string): boolean => !classesOf(cat, name).includes('read');
export const hasClass = (cat: Catalog, name: string, c: ToolClass): boolean => (c === 'gated' ? isGated(cat, name) : classesOf(cat, name).includes(c));

/** Apply the entry's `normalise` map (lower|upper|trim) to string args. */
export function normaliseArgs(cat: Catalog, name: string, args: Record<string, unknown>): Record<string, unknown> {
  const norm = cat.byName[name]?.normalise ?? {};
  const out: Record<string, unknown> = { ...(args ?? {}) };
  for (const [k, how] of Object.entries(norm)) {
    const v = out[k];
    if (typeof v !== 'string') continue;
    out[k] = how === 'lower' ? v.toLowerCase() : how === 'upper' ? v.toUpperCase() : v.trim();
  }
  return out;
}
/** args_hash as G1 uses it: normalised, `ignore_args` dropped, canonical JSON, sha256. */
export function argsHashFor(cat: Catalog, name: string, args: Record<string, unknown>): string {
  const n = normaliseArgs(cat, name, args);
  for (const k of cat.byName[name]?.ignore_args ?? []) delete n[k];
  return argsHash(n);
}

/** Name of `tool` on a variant (`aliases` map of variantPattern -> name); most specific pattern wins. */
export function nameOnVariant(cat: Catalog, name: string, variant: string): string {
  const al = cat.byName[name]?.aliases ?? {};
  const spec = (p: string) => (p === '*' ? 0 : p.endsWith('/*') ? 1 : 2);
  const hit = Object.keys(al).filter((p) => variantMatches(p, variant)).sort((a, b) => spec(b) - spec(a))[0];
  return hit ? al[hit] : name;
}
/** Reverse of nameOnVariant: a name the agent used on a variant -> catalog name (or the name itself). */
export function catalogNameFor(cat: Catalog, used: string, variant: string): string {
  if (cat.byName[used]) return used;
  for (const t of cat.tools) if (nameOnVariant(cat, t.name, variant) === used) return t.name;
  return used;
}

/** Tools served on a variant after `variants.<v>.tools.include/exclude`. */
export function toolsForVariant(cat: Catalog, filter: { include?: string[]; exclude?: string[] } = {}): CatalogTool[] {
  return cat.tools.filter((t) => (!filter.include || filter.include.includes(t.name)) && !(filter.exclude ?? []).includes(t.name));
}

/** Does the tool have a string-valued output (template selector `returns_text`)? */
export function returnsText(t: CatalogTool): boolean {
  const os = t.output_schema as Record<string, any> | undefined;
  if (!os || typeof os !== 'object') return t.classes.includes('read');
  const hasStr = (s: any, depth = 0): boolean => {
    if (!s || typeof s !== 'object' || depth > 6) return false;
    if (s.type === 'string') return true;
    if (s.properties) return Object.values(s.properties).some((x) => hasStr(x, depth + 1));
    if (s.items) return hasStr(s.items, depth + 1);
    return false;
  };
  return hasStr(os);
}
export const hasRequiredArgs = (t: CatalogTool): boolean => {
  const s = t.input_schema as Record<string, any>;
  return !!(s && typeof s === 'object' && Array.isArray(s.required) && s.required.length);
};

/** Template / pack selector (§4.2). Stable order: risk desc, then name. `distinct_from` is resolved by the caller. */
export function selectTools(cat: Catalog, sel: ToolSelector, limit = Infinity, exclude: string[] = []): CatalogTool[] {
  const out = cat.tools.filter((t) => {
    if (exclude.includes(t.name)) return false;
    const has = (c: ToolClass) => (c === 'gated' ? t.gated : t.classes.includes(c));
    if (sel.classes_any && !sel.classes_any.some(has)) return false;
    if (sel.classes_all && !sel.classes_all.every(has)) return false;
    if (sel.classes_none && sel.classes_none.some(has)) return false;
    if (sel.gated !== undefined && t.gated !== sel.gated) return false;
    if (sel.returns_text !== undefined && returnsText(t) !== sel.returns_text) return false;
    if (sel.has_required_args !== undefined && hasRequiredArgs(t) !== sel.has_required_args) return false;
    if (sel.name_matches !== undefined && !new RegExp(sel.name_matches, 'i').test(`${t.name} ${t.description ?? ''}`)) return false;
    return true;
  });
  return out.slice(0, Number.isFinite(limit) ? Math.max(0, limit) : undefined);
}

/** Resolve a `ToolRef` ('class:<c>' or a name) to concrete catalog names. */
export function resolveToolRef(cat: Catalog, ref: string): string[] {
  const m = /^class:(read|write|spend|outward|destructive|gated)$/.exec(ref);
  if (!m) return [ref];
  return cat.tools.filter((t) => hasClass(cat, t.name, m[1] as ToolClass)).map((t) => t.name);
}
export const refMatches = (cat: Catalog, ref: string, name: string): boolean => {
  const m = /^class:(read|write|spend|outward|destructive|gated)$/.exec(ref);
  return m ? hasClass(cat, name, m[1] as ToolClass) : ref === name;
};
