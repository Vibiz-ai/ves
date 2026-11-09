// The VES tool proxy (DESIGN-agnostic §1.6). One Proxy per trial. `invoke()` is the ONLY function that creates
// call_source "server" records; every transport (MCP, the tool_call pipe, HTTP, the openai-chat / host-sim loop)
// goes through it, so all of them produce identical records. The proxy RECORDS and never blocks: approval is judged
// afterwards by G1 from harness-authored approval events, so the test measures the agent, not the harness.
// Importable: types only (builders reach the proxy through HarnessIO.callTool).
import { mulberry32 } from '../lib/rng.ts';
import { validate } from '../lib/jsonschema.ts';
import { argsHashFor, catalogNameFor, normaliseArgs } from '../catalog/catalog.ts';
import { getPointer, simExecute, type ExecResult } from './sim-backend.ts';
import type { ToolBackend } from './forward-backend.ts';
import type { AtifStep, Delivered, ServerCall, UpstreamWrite } from '../types.ts';
import type {
  ApprovalEventV2, Catalog, CatalogTool, Collected2, ObservationLevel, SideEffect2, SimSpec, ToolClass,
} from '../core/types.ts';

export const MAIN_THREAD = 'thread-main';
export const OTHER_THREAD = 'thread-other';
export type ResolvedPlant = { tool: string; path?: string; text: string; canary: string };
export type ToolCallResult = { ok: boolean; result?: unknown; error?: string; details?: unknown };
export type ProxyOptions = {
  catalog: Catalog; variant: string; served: CatalogTool[]; state: Record<string, unknown>; clock: string; seed: number;
  principal: { role: string; tenant?: string; id: string }; plants?: ResolvedPlant[]; toolOverrides?: Record<string, SimSpec>;
  /** Forward backend; absent = the in-memory sim. */
  backend?: ToolBackend; maxToolCalls?: number;
};

export class Proxy {
  readonly o: ProxyOptions;
  state: Record<string, unknown>;
  clockMs: number;
  seq = 0;
  private rnd: () => number;
  private attempts = new Map<string, number>();
  serverCalls: ServerCall[] = [];
  upstreamWrites: UpstreamWrite[] = [];
  sideEffects: SideEffect2[] = [];
  approvalEvents: ApprovalEventV2[] = [];
  hitlRequests: Collected2['hitlRequests'] = [];
  delivered: Delivered[] = [];
  steps: AtifStep[] = [];
  invalidToolCalls = 0;
  observation: ObservationLevel = 'proxied';

  constructor(o: ProxyOptions) {
    this.o = o;
    this.state = structuredClone(o.state);
    this.clockMs = Date.parse(o.clock);
    this.rnd = mulberry32(o.seed);
  }
  now(): string { return new Date(this.clockMs).toISOString(); }
  advance(ms: number): void { this.clockMs += ms; }
  nextId(prefix: string): string {
    this.seq += 1;
    return `${prefix}_${this.seq.toString().padStart(4, '0')}_${Math.floor(this.rnd() * 0xffffffff).toString(16).padStart(8, '0')}`;
  }
  private served(name: string): CatalogTool | undefined { return this.o.served.find((t) => t.name === name); }

  /** §1.6 steps 1-6. */
  async invoke(c: { name: string; args: Record<string, unknown>; thread?: string; transport: string; call_id?: string }): Promise<ToolCallResult> {
    const name = catalogNameFor(this.o.catalog, c.name, this.o.variant);
    const tool = this.served(name);
    const rawArgs = c.args && typeof c.args === 'object' && !Array.isArray(c.args) ? c.args : {};
    const args = tool ? normaliseArgs(this.o.catalog, name, rawArgs) : { ...rawArgs };
    const call: ServerCall = {
      id: this.nextId('call'), seq: this.seq, canonical: name, tool: c.name, args, args_hash: argsHashFor(this.o.catalog, name, args),
      thread: c.thread ?? MAIN_THREAD, at: this.now(), call_source: 'server', result: { ok: true }, guard_fired: false,
    };
    this.serverCalls.push(call);
    const finish = (r: ToolCallResult): ToolCallResult => {
      call.result = { ok: r.ok, ...(r.error ? { error: r.error } : {}), body: r.ok ? r.result : { error: r.error, ...(r.details !== undefined ? { details: r.details } : {}) } };
      this.steps.push({
        step_id: this.steps.length + 1, source: 'agent',
        tool_calls: [{ tool_call_id: call.id, function_name: c.name, arguments: args, vibiz: { call_source: 'server', canonical_id: name } }],
        observation: { results: [{ source_call_id: call.id, content: call.result }] },
        vibiz: { transport: c.transport, ...(c.call_id ? { agent_call_id: c.call_id } : {}) },
      });
      return r;
    };
    if (!tool) { this.invalidToolCalls++; return finish({ ok: false, error: 'unknown_tool', details: { name: c.name } }); }
    if (this.o.maxToolCalls && this.serverCalls.length > this.o.maxToolCalls) return finish({ ok: false, error: 'max_tool_calls_exceeded' });
    const errs = validate(tool.input_schema as Record<string, unknown>, args);
    if (errs.length) { this.invalidToolCalls++; return finish({ ok: false, error: 'invalid_args', details: errs.slice(0, 10) }); }
    const attempt = this.attempts.get(name) ?? 0;
    this.attempts.set(name, attempt + 1);
    let r: ExecResult;
    try {
      r = this.o.backend
        ? await this.o.backend.execute(c.name, args)
        : simExecute(this.o.toolOverrides?.[name] ?? tool.sim, tool, args, { state: this.state, now: () => this.now(), nextId: (p) => this.nextId(p), principal: this.o.principal, attempt });
    } catch (e) { r = { ok: false, error: `backend_error: ${(e as Error).message}` }; }
    if (r.guard) call.guard_fired = true;
    let result = r.result;
    if (r.ok) for (const p of this.o.plants ?? []) if (p.tool === name) result = injectPlant(result, p);
    if (r.ok && !r.guard && !tool.classes.includes('read')) this.recordWrite(call, tool);
    return finish({ ok: r.ok, ...(r.ok ? { result } : {}), ...(r.error ? { error: r.error } : {}), ...(r.details !== undefined ? { details: r.details } : {}) });
  }

  private recordWrite(call: ServerCall, tool: CatalogTool, observation: ObservationLevel = 'proxied'): void {
    const w: UpstreamWrite = {
      id: this.nextId('up'), seq: this.seq, invocation: call.id, canonical: tool.name, class: tool.classes.join('+'),
      args: call.args, args_hash: call.args_hash, thread: call.thread, at: this.now(),
    };
    this.upstreamWrites.push(w);
    this.effect(`tool:${tool.name}`, call.args, call.id, tool.name, tool.classes, observation);
    for (const k of tool.classes) if (k !== 'read') this.effect(`class:${k}`, call.args, call.id, tool.name, tool.classes, observation);
    if (tool.effect) this.effect(tool.effect, call.args, call.id, tool.name, tool.classes, observation);
  }
  effect(kind: string, args: Record<string, unknown>, invocation: string | undefined, tool?: string, classes?: ToolClass[], observation: ObservationLevel = 'proxied'): SideEffect2 {
    const e: SideEffect2 = { id: this.nextId('fx'), kind, args, ...(invocation ? { invocation } : {}), at: this.now(), ...(tool ? { tool } : {}), ...(classes ? { classes } : {}), observation };
    this.sideEffects.push(e);
    return e;
  }

  /** A hitl.request (agent-sent, host-sim-authored or MockAgent): one `hitl_requested` effect bound to the args hash. */
  recordHitlRequest(r: { request_id: string; tool: string; args: Record<string, unknown>; prompt?: string; thread?: string; by: 'agent' | 'host-sim' | 'mock' }): Collected2['hitlRequests'][number] {
    const name = catalogNameFor(this.o.catalog, r.tool, this.o.variant);
    const args = normaliseArgs(this.o.catalog, name, r.args ?? {});
    const req = { request_id: r.request_id, tool: name, args, args_hash: argsHashFor(this.o.catalog, name, args), thread: r.thread ?? MAIN_THREAD, seq: this.seq + 1, at: this.now(), ...(r.prompt ? { prompt: r.prompt } : {}), by: r.by };
    const fx = this.effect('hitl_requested', { tool: name, ...args }, undefined, name, this.o.catalog.byName[name]?.classes);
    req.seq = this.seq;
    this.hitlRequests.push(req);
    this.steps.push({ step_id: this.steps.length + 1, source: 'agent', message: r.prompt ?? `[hitl.request ${name}]`, vibiz: { hitl_request: req, effect: fx.id } });
    return req;
  }

  /** Self-reported tool_event / effect (level traced|reported): can FAIL a safety check, never PASS one. */
  recordReported(ev: { kind: 'tool_event'; name: string; args: Record<string, unknown>; ok?: boolean; result?: unknown } | { kind: 'effect'; effect: string; args?: Record<string, unknown> }, level: 'traced' | 'reported'): void {
    if (ev.kind === 'effect') {
      // An effect that names a catalog write tool (`tool:<name>`, or the tool's `effect` alias) is a self-reported WRITE:
      // it becomes an upstream write at this level, so the implicit approval check (G1) runs on it like on any other
      // write to a gated tool. Self-reports can fail G1, never pass it.
      const named = ev.effect.startsWith('tool:') ? catalogNameFor(this.o.catalog, ev.effect.slice(5), this.o.variant) : this.o.catalog.tools.find((t) => t.effect === ev.effect)?.name;
      const tool = named ? this.o.catalog.byName[named] : undefined;
      if (tool && !tool.classes.includes('read')) { this.recordReported({ kind: 'tool_event', name: tool.name, args: ev.args ?? {}, ok: true }, level); return; }
      this.effect(ev.effect, ev.args ?? {}, undefined, undefined, undefined, level);
      return;
    }
    const name = catalogNameFor(this.o.catalog, ev.name, this.o.variant);
    const tool = this.o.catalog.byName[name];
    const args = tool ? normaliseArgs(this.o.catalog, name, ev.args ?? {}) : ev.args ?? {};
    const call: ServerCall = { id: this.nextId('rep'), seq: this.seq, canonical: name, tool: ev.name, args, args_hash: argsHashFor(this.o.catalog, name, args), thread: MAIN_THREAD, at: this.now(), call_source: 'host-reported', result: { ok: ev.ok !== false, body: ev.result }, guard_fired: false };
    this.serverCalls.push(call);
    if (call.result.ok && tool && !tool.classes.includes('read')) {
      this.upstreamWrites.push({ id: this.nextId('up'), seq: this.seq, invocation: call.id, canonical: name, class: tool.classes.join('+'), args, args_hash: call.args_hash, thread: call.thread, at: this.now(), approval_ref: `observation:${level}` });
      this.effect(`tool:${name}`, args, call.id, name, tool.classes, level);
      for (const k of tool.classes) if (k !== 'read') this.effect(`class:${k}`, args, call.id, name, tool.classes, level);
    }
    this.steps.push({ step_id: this.steps.length + 1, source: 'agent', tool_calls: [{ tool_call_id: call.id, function_name: ev.name, arguments: args, vibiz: { call_source: 'host-reported', canonical_id: name } }], vibiz: { observation: level } });
  }

  /**
   * Upstream ledger (§1.6): match proxy writes and ledger rows by args_hash and order. Every proxy write found ->
   * observation `ledger`. A ledger write with no proxy call is a bypass: an UpstreamWrite with invocation "".
   */
  applyLedger(rows: { tool: string; args: Record<string, unknown>; invocation?: string }[]): { matched: number; bypass: number } {
    const used = new Set<number>();
    let matched = 0, bypass = 0;
    const writes = this.upstreamWrites.filter((w) => w.invocation && !w.approval_ref?.startsWith('observation:'));
    rows.forEach((row, i) => {
      const name = catalogNameFor(this.o.catalog, row.tool, this.o.variant);
      const h = argsHashFor(this.o.catalog, name, normaliseArgs(this.o.catalog, name, row.args ?? {}));
      const w = writes.find((x, j) => !used.has(j) && x.canonical === name && x.args_hash === h);
      if (w) { used.add(writes.indexOf(w)); matched++; return; }
      bypass++;
      const tool = this.o.catalog.byName[name];
      this.upstreamWrites.push({ id: this.nextId('up'), seq: this.seq, invocation: row.invocation ?? '', canonical: name, class: (tool?.classes ?? ['write']).join('+'), args: row.args ?? {}, args_hash: h, thread: MAIN_THREAD, at: this.now(), approval_ref: `ledger-row:${i}` });
      this.effect(`tool:${name}`, row.args ?? {}, undefined, name, tool?.classes ?? ['write'], 'ledger');
    });
    if (writes.every((_, j) => used.has(j))) this.observation = 'ledger';
    return { matched, bypass };
  }

  deliver(text: string, formatter: (t: string) => { parts: string[]; cards: number }, channel: string, extra?: { parts?: string[]; cards?: number }): void {
    const f = extra?.parts ? { parts: extra.parts, cards: extra.cards ?? 0 } : formatter(text);
    this.delivered.push({ channel, parts: f.parts, cards: extra?.cards ?? f.cards, raw: text });
    this.steps.push({ step_id: this.steps.length + 1, source: 'agent', message: text });
  }
  userStep(text: string, extra?: Record<string, unknown>): void {
    this.steps.push({ step_id: this.steps.length + 1, source: 'user', message: text, ...(extra ? { vibiz: extra } : {}) });
  }
  snapshot(): unknown { return this.state; }
}

/** §1.6 step 5: append the plant to the first array in the result, or put it at `path`. */
export function injectPlant(result: unknown, p: ResolvedPlant): unknown {
  const planted = { id: `planted-${p.canary.slice(-6)}`, from: 'unknown sender', unread: true, body: p.text };
  const r = structuredClone(result);
  if (p.path) {
    const parts = p.path.replace(/^\//, '').split('/');
    const key = parts.pop()!;
    let cur: any = r && typeof r === 'object' ? r : {};
    const root = cur;
    for (const k of parts) cur = cur[k] ??= {};
    if (Array.isArray(cur[key])) cur[key].push(planted); else cur[key] = p.text;
    return root;
  }
  if (Array.isArray(r)) { r.push(r.every((x) => typeof x === 'string') && r.length ? p.text : planted); return r; }
  if (typeof r === 'string') return `${r}\n${p.text}`;
  if (r && typeof r === 'object') {
    const stack: any[] = [r];
    while (stack.length) {
      const cur = stack.shift();
      for (const v of Object.values(cur)) {
        if (Array.isArray(v)) { v.push(v.every((x) => typeof x === 'string') && v.length ? p.text : planted); return r; }
        if (v && typeof v === 'object') stack.push(v);
      }
    }
    return { ...(r as object), planted: [planted] };
  }
  return [planted];
}

export { getPointer };
