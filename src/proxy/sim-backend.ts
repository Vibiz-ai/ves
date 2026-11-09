// In-memory tool backend (DESIGN-agnostic §1.6 `sim` spec). Runs a tool's sim spec against the trial's JSON fixture
// state. Deterministic: ids come from the trial's seeded RNG, the clock is frozen. Writes are recorded, never
// rejected (v1 invariant 5); only an explicit `fail_first` / `fail_always` or a tenant mismatch returns an error.
import type { CatalogTool, SimSpec } from '../core/types.ts';

export type ExecCtx = {
  state: Record<string, unknown>; now: () => string; nextId: (prefix: string) => string;
  principal: { role: string; tenant?: string; id: string };
  /** How many times this tool was called before in this trial (fail_first). */
  attempt: number;
};
export type ExecResult = { ok: boolean; result?: unknown; error?: string; details?: unknown; guard?: boolean };

const unesc = (k: string) => k.replace(/~1/g, '/').replace(/~0/g, '~');
export function getPointer(doc: unknown, ptr: string): { found: boolean; value?: unknown } {
  if (ptr === '' || ptr === '/') return { found: true, value: doc };
  let cur: any = doc;
  for (const raw of ptr.replace(/^\//, '').split('/')) {
    const k = unesc(raw);
    if (cur === null || typeof cur !== 'object' || !(k in cur)) return { found: false };
    cur = cur[k];
  }
  return { found: true, value: cur };
}
function parentOf(doc: Record<string, unknown>, ptr: string, create: boolean): { parent: any; key: string } | null {
  const parts = ptr.replace(/^\//, '').split('/').map(unesc);
  const key = parts.pop()!;
  let cur: any = doc;
  for (const p of parts) {
    if (cur[p] === undefined || cur[p] === null || typeof cur[p] !== 'object') { if (!create) return null; cur[p] = {}; }
    cur = cur[p];
  }
  return { parent: cur, key };
}

/** `{{args.x}}`, `{{id}}`, `{{now}}`, `{{principal.tenant}}`, `{{principal.id}}`. Whole-value strings keep their type. */
export function renderTemplate(v: unknown, vars: Record<string, unknown>): unknown {
  const look = (expr: string): unknown => {
    let cur: any = vars;
    for (const p of expr.trim().split('.')) { if (cur === null || typeof cur !== 'object') return undefined; cur = cur[p]; }
    return cur;
  };
  if (typeof v === 'string') {
    const whole = /^\{\{([^{}]+)\}\}$/.exec(v);
    if (whole) return look(whole[1]);
    return v.replace(/\{\{([^{}]+)\}\}/g, (_, e: string) => { const r = look(e); return r === undefined ? '' : typeof r === 'string' ? r : JSON.stringify(r); });
  }
  if (Array.isArray(v)) return v.map((x) => renderTemplate(x, vars));
  if (v && typeof v === 'object') return Object.fromEntries(Object.entries(v).map(([k, x]) => [k, renderTemplate(x, vars)]));
  return v;
}

const looseEq = (a: unknown, b: unknown) => a === b || (a !== undefined && b !== undefined && String(a) === String(b));

export function simExecute(spec: SimSpec | undefined, tool: CatalogTool, args: Record<string, unknown>, ctx: ExecCtx): ExecResult {
  const isRead = tool.classes.includes('read');
  if (spec?.fail_always) return { ok: false, error: spec.fail_always.error, details: spec.fail_always.details };
  if (spec?.fail_first && ctx.attempt < spec.fail_first.times) return { ok: false, error: spec.fail_first.error, details: spec.fail_first.details };
  const id = ctx.nextId('obj');
  const vars = { args, id, now: ctx.now(), principal: ctx.principal };
  const ptr = (p: string) => String(renderTemplate(p, vars));
  const tenantOf = (row: unknown) => (spec?.tenant_key ? getPointer(row, spec.tenant_key).value : undefined);
  const mine = (row: unknown) => !spec?.tenant_key || looseEq(tenantOf(row), ctx.principal.tenant);
  const ret = (fallback: unknown) => (spec && 'returns' in spec ? renderTemplate(spec.returns, vars) : fallback);

  if (!spec || (!spec.read && !spec.append && !spec.set && !spec.delete && !('returns' in spec))) {
    if (isRead) return { ok: true, result: ret(getPointer(ctx.state, `/${tool.name.replace(/~/g, '~0').replace(/\//g, '~1')}`).value ?? []) };
    const ves = (ctx.state.ves ??= {}) as Record<string, unknown>;
    const writes = (ves.writes ??= []) as unknown[];
    writes.push({ tool: tool.name, args, at: ctx.now(), id });
    return { ok: true, result: ret({ ok: true, id }) };
  }
  if (spec.read) {
    const r = getPointer(ctx.state, ptr(spec.read));
    if (!r.found) return { ok: false, error: 'not_found', details: { pointer: ptr(spec.read) } };
    let v = structuredClone(r.value);
    if (Array.isArray(v)) {
      const where = spec.where ? (renderTemplate(spec.where, vars) as Record<string, unknown>) : null;
      v = v.filter((row) => mine(row) && (!where || Object.entries(where).every(([k, x]) => looseEq(getPointer(row, k.startsWith('/') ? k : `/${k}`).value, x))));
    } else if (v && typeof v === 'object' && spec.tenant_key && !mine(v)) {
      return { ok: false, error: 'forbidden', details: { status: 403, reason: 'record belongs to another tenant' } };
    }
    return { ok: true, result: 'returns' in spec ? renderTemplate(spec.returns, { ...vars, result: v }) : v };
  }
  if (spec.append) {
    const p = parentOf(ctx.state, ptr(spec.append), true)!;
    if (!Array.isArray(p.parent[p.key])) p.parent[p.key] = [];
    p.parent[p.key].push({ id, ...args, ...(ctx.principal.tenant && spec.tenant_key ? { [spec.tenant_key.replace(/^\//, '')]: ctx.principal.tenant } : {}), at: ctx.now() });
    return { ok: true, result: ret({ ok: true, id }) };
  }
  if (spec.set) {
    const p = parentOf(ctx.state, ptr(spec.set), true)!;
    p.parent[p.key] = renderTemplate(spec.value, vars);
    return { ok: true, result: ret({ ok: true }) };
  }
  if (spec.delete) {
    const p = parentOf(ctx.state, ptr(spec.delete), false);
    if (!p || !(p.key in p.parent)) return { ok: false, error: 'not_found', details: { pointer: ptr(spec.delete) } };
    if (Array.isArray(p.parent)) p.parent.splice(Number(p.key), 1); else delete p.parent[p.key];
    return { ok: true, result: ret({ ok: true }) };
  }
  return { ok: true, result: ret({ ok: true }) };
}
