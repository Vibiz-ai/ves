// Path model: one trial (ATIF trajectory + its results row + the run's catalog/config/case) as a graph the canvas can
// draw. Pure and deterministic; no statistics, no model calls.
//
//  - Nodes, in execution order: user messages, agent replies (with text metrics), tool calls (classed from the catalog),
//    tool errors, approval requests, approval decisions, session boundaries / clock advances, and grader verdicts
//    attached to the step that caused them when that can be inferred.
//  - A host-reported call (the agent's own report, e.g. `eve.forget`) that matches a proxied call of the same turn is
//    the same call (as in the harness's dedupeCalls): one node, the proxied record wins. One with no proxied twin is a
//    `reportedOnly` node; when its name is a catalog tool it is also `unobserved` (the agent says it called a tool the
//    harness never saw reach the backend).
//  - Duplicates: same tool + same canonical args as an earlier call in the trial.
//  - Persona trials: user steps written by the user simulator (`vibiz.persona`) are not scripted case turns, so they
//    do not consume the case's `input.turns`; the number of user turns can differ from trial to trial. The advisory
//    persona_outcome read is drawn as a check but never marks a step failing.
import type { Atif, AtifStep, AtifToolCall, ResultRow, Score, StepPersona } from '../types.ts';
import { isPersonaOutcomeScore, stepPersona } from '../persona.ts';
import { channelLimit, replyMetrics, type ChannelLimit, type ReplyMetrics } from './metrics.ts';

export type CatalogTool = { name: string; classes: string[]; gated: boolean | null; risk: number | null };
export type PathContext = {
  id?: string;
  catalog: { gate_classes: string[]; tools: CatalogTool[] } | null;
  config: { reported_prefixes: string[]; reported_aliases: Record<string, string>; gate_classes: string[]; variants: Record<string, { format?: { max_chars?: number } | null }> } | null;
  case: { id: string; version: number | null; input: { turns?: Record<string, unknown>[] } | null; format?: { max_chars?: number } | null } | null;
};

export type NodeKind = 'user' | 'reply' | 'tool' | 'tool_error' | 'approval_request' | 'approval_decision' | 'boundary' | 'verdict';
export type ToolCls = 'read' | 'write' | 'outward' | 'spend' | 'destructive' | 'gated' | 'memory' | 'meta' | 'unknown';
export type Decision = 'approve' | 'reject' | 'timeout' | 'other';

export type ApprovalEvent = { id?: string; seq?: number; kind?: string; binding?: string; canonical?: string; principal?: string; thread?: string; at?: string; expires_at?: string; args_hash?: string };

export type ToolInfo = {
  name: string; wire: string[]; cls: ToolCls; classes: string[]; gated: boolean; inCatalog: boolean; guessed: boolean;
  source: 'server' | 'host-reported' | 'both'; reportedOnly: boolean; unobserved: boolean;
  callIds: string[]; args: unknown; reportedArgs?: unknown; result: unknown; ok: boolean; error: string | null;
};
export type VerdictInfo = {
  name: string; label: string; role: string | null; value: number | null | undefined; explanation: string; evidence: string[];
  safety: boolean; implicit: boolean; how: 'evidence' | 'explanation' | 'turn' | 'end'; targets: string[];
};

export type PathNode = {
  id: string;
  kind: NodeKind;
  /** Position in execution order; attachments (errors, verdicts) carry their target's order. */
  order: number;
  /** false for attachments that hang off another node (tool errors, verdicts). */
  sequential: boolean;
  turn: number;
  label: string;
  /** Exact signature for alignment: kind + tool + normalised-args hash (or text hash for user messages). */
  signature: string;
  /** Coarse signature: kind + tool name only (an aligned pair with differing args). */
  coarse: string;
  importance: number;
  stepIndex: number | null;
  stepId: string | number | null;
  seq: number | null;
  text?: string;
  metrics?: ReplyMetrics;
  tool?: ToolInfo;
  decision?: Decision;
  approvals?: ApprovalEvent[];
  /** approval_request: how it was inferred. */
  via?: 'hitl_request' | 'guard' | 'chat';
  boundary?: string;
  verdict?: VerdictInfo;
  attachTo?: string;
  verdicts: string[];
  failing: boolean;
  dupOf?: string;
  dupCount?: number;
  flags: string[];
  /** user / approval_decision written by the persona user-simulator. */
  persona?: StepPersona;
};
export type PathEdge = { from: string; to: string; kind: 'seq' | 'attach' };
export type TurnInfo = { index: number; label: string; user: string | null; decision?: Decision; boundary?: string; startOrder: number; endOrder: number };
export type PathGraph = {
  rowId: string | null; runId: string | null; caseId: string | null; caseVersion: number | null; surface: string | null; trial: number | null; status: string | null;
  nodes: PathNode[]; edges: PathEdge[]; turns: TurnInfo[]; limit: ChannelLimit;
  stats: { steps: number; toolNodes: number; duplicates: number; reportedOnly: number; unobserved: number; errors: number; actions: number; failingChecks: number; replies: number };
  notes: string[];
};

// ------------------------------------------------------------------------------------------------ helpers
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const ISO = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d+)?(Z|[+-]\d{2}:\d{2})$/;

/** Canonical JSON: sorted keys, generated ids and timestamps replaced, so the same call hashes the same across runs. */
export function stableArgs(v: unknown): string {
  const walk = (x: unknown): unknown => {
    if (Array.isArray(x)) return x.map(walk);
    if (x && typeof x === 'object') { const o: Record<string, unknown> = {}; for (const k of Object.keys(x).sort()) if ((x as Record<string, unknown>)[k] !== undefined) o[k] = walk((x as Record<string, unknown>)[k]); return o; }
    if (typeof x === 'string' && (UUID.test(x) || ISO.test(x))) return '<id>';
    return x;
  };
  return JSON.stringify(walk(v ?? {}));
}
/** FNV-1a, 32-bit, hex. */
export function hash(s: string): string {
  let h = 0x811c9dc5;
  for (let i = 0; i < s.length; i++) { h ^= s.charCodeAt(i); h = Math.imul(h, 0x01000193); }
  return (h >>> 0).toString(16).padStart(8, '0');
}
const seqOf = (id: string | undefined | null): number | null => { const m = /^[a-z]+_(\d+)_/i.exec(id ?? ''); return m ? Number(m[1]) : null; };
const ext = (o: unknown): Record<string, unknown> => {
  const out: Record<string, unknown> = {};
  if (o && typeof o === 'object') for (const k of ['vibiz', 'ves', 'extra', 'metadata']) { const v = (o as Record<string, unknown>)[k]; if (v && typeof v === 'object') Object.assign(out, v); }
  return out;
};
export function textOf(m: unknown): string {
  if (m == null) return '';
  if (typeof m === 'string') return m;
  if (Array.isArray(m)) return m.map((p) => (typeof p === 'string' ? p : typeof p?.text === 'string' ? p.text : '')).join('\n');
  if (typeof m === 'object' && typeof (m as { text?: unknown }).text === 'string') return (m as { text: string }).text;
  return JSON.stringify(m);
}
const contentOk = (c: unknown): { ok: boolean; error: string | null; guard: boolean } => {
  if (c && typeof c === 'object') {
    const o = c as { ok?: unknown; error?: unknown; body?: { approvalRequired?: unknown }; approvalRequired?: unknown };
    const guard = o.approvalRequired === true || o.body?.approvalRequired === true;
    if (o.ok === false || o.error) return { ok: false, error: o.error ? String(o.error) : 'error', guard };
    return { ok: true, error: null, guard };
  }
  return { ok: true, error: null, guard: false };
};
function argsCompatible(a: unknown, b: unknown): boolean {
  const x = (a ?? {}) as Record<string, unknown>, y = (b ?? {}) as Record<string, unknown>;
  for (const k of Object.keys(x)) if (k in y && stableArgs(x[k]) !== stableArgs(y[k])) return false;
  return true;
}

export const META_TOOLS = new Set(['find_tools', 'load_tools', 'search_tools', 'list_tools', 'tool_search']);
export const MEMORY_TOOL = /^(?:remember|forget|recall|memo_[a-z_]+|user_memory[a-z_]*)$/;

/** The colour class of a tool: memory and meta first (they explain behaviour), then the riskiest catalog class. */
export function toolClass(name: string, entry: CatalogTool | undefined, gateClasses: string[] = []): { cls: ToolCls; classes: string[]; gated: boolean; guessed: boolean } {
  const classes = entry?.classes ?? [];
  const gated = entry?.gated === true || classes.some((c) => gateClasses.includes(c));
  if (META_TOOLS.has(name)) return { cls: 'meta', classes, gated, guessed: false };
  if (MEMORY_TOOL.test(name)) return { cls: 'memory', classes, gated, guessed: false };
  for (const c of ['destructive', 'spend', 'outward'] as const) if (classes.includes(c)) return { cls: c, classes, gated, guessed: false };
  if (classes.includes('write')) return { cls: gated ? 'gated' : 'write', classes, gated, guessed: false };
  if (classes.includes('read')) return { cls: 'read', classes, gated, guessed: false };
  if (!entry && /^(?:get|list|read|search|fetch|lookup|find|own)_/.test(name)) return { cls: 'read', classes, gated, guessed: true };
  return { cls: 'unknown', classes, gated, guessed: !entry };
}
const IMPORTANCE: Record<ToolCls, number> = { destructive: 4, spend: 4, outward: 4, gated: 3, write: 3, memory: 3, read: 1.6, unknown: 1.4, meta: 1 };

const ID_RE = /\b(?:call|rep|up|fx|ap)_\d{3,}_[0-9a-f]{4,}\b/g;
const short = (s: string, n: number) => { const t = s.replace(/\s+/g, ' ').trim(); return t.length > n ? `${t.slice(0, n - 1)}…` : t; };
const decisionOf = (s: AtifStep): Decision | null => {
  const h = (ext(s).hitl_turn as { hitl?: unknown } | undefined)?.hitl;
  const raw = typeof h === 'string' ? h : /^\s*\[hitl:([a-z_]+)\]/i.exec(textOf(s.message))?.[1];
  if (!raw) return null;
  const r = raw.toLowerCase();
  return r === 'approve' || r === 'yes' ? 'approve' : r === 'reject' || r === 'no' || r === 'deny' ? 'reject' : r === 'timeout' || r === 'expire' ? 'timeout' : 'other';
};
const eventDecision = (kind: string | undefined): Decision => {
  const k = (kind ?? '').toLowerCase();
  return /yes|approv|grant|allow/.test(k) ? 'approve' : /no$|reject|deny|refus/.test(k) ? 'reject' : /timeout|expir/.test(k) ? 'timeout' : 'other';
};

type Rec = { stepIndex: number; step: AtifStep; call: AtifToolCall; source: 'server' | 'host-reported'; name: string; wire: string; seq: number | null; result: unknown; ok: boolean; error: string | null; guard: boolean; turn: number; mergedInto?: Rec; reported?: Rec };

// ------------------------------------------------------------------------------------------------ build
export type BuildInput = { atif: Atif | null | undefined; row?: ResultRow | null; context?: PathContext | null; approvalEvents?: ApprovalEvent[] };

export function buildPath({ atif, row, context }: BuildInput): PathGraph {
  const steps: AtifStep[] = Array.isArray(atif?.steps) ? atif!.steps : [];
  const cat = new Map((context?.catalog?.tools ?? []).map((t) => [t.name, t]));
  const gateClasses = context?.catalog?.gate_classes ?? context?.config?.gate_classes ?? [];
  const prefixes = context?.config?.reported_prefixes?.length ? context.config.reported_prefixes : ['eve.'];
  const aliases = context?.config?.reported_aliases ?? {};
  const surface = row?.surface ?? (ext(atif).variant as string | undefined) ?? null;
  const limit = channelLimit(surface, surface ? context?.config?.variants?.[surface]?.format : null, context?.case?.format);
  const notes: string[] = [];
  const atifExt = ext(atif);
  const events = (Array.isArray(atifExt.approval_events) ? atifExt.approval_events : []) as ApprovalEvent[];

  const stripName = (n: string) => { let x = n; for (const p of prefixes) if (p && x.startsWith(p)) { x = x.slice(p.length); break; } return x; };
  const reportedName = (n: string) => { const x = stripName(n); return aliases[x] ?? x; };

  // 1. turns and tool records
  let turn = 0;
  const recs: Rec[] = [];
  const turnOfStep: number[] = [];
  steps.forEach((s, i) => {
    if (s.source === 'user') turn++;
    turnOfStep[i] = turn;
    const results = new Map((s.observation?.results ?? []).map((r) => [r.source_call_id, r.content]));
    const calls = s.tool_calls ?? [];
    calls.forEach((c, j) => {
      const cx = ext(c);
      const source = cx.call_source === 'host-reported' ? 'host-reported' : 'server';
      const wire = String(c.function_name ?? '(unnamed)');
      const canonical = typeof cx.canonical_id === 'string' ? cx.canonical_id : wire;
      const name = source === 'host-reported' ? reportedName(canonical) : stripName(canonical);
      const content = results.get(c.tool_call_id) ?? (calls.length === 1 && s.observation?.results?.length === 1 ? s.observation.results[0].content : undefined);
      const r = content === undefined ? { ok: true, error: null, guard: false } : contentOk(content);
      recs.push({ stepIndex: i, step: s, call: c, source, name, wire, seq: seqOf(c.tool_call_id) ?? null, result: content, ok: r.ok, error: r.error, guard: r.guard, turn: turnOfStep[i] });
      void j;
    });
  });
  // 2. pair host-reported calls with their proxied twin (same turn, same name, compatible args)
  for (const h of recs.filter((r) => r.source === 'host-reported')) {
    const twin = recs.find((p) => p.source === 'server' && !p.reported && p.turn === h.turn && (p.name === h.name || p.name === stripName(h.wire)) && argsCompatible(h.call.arguments, p.call.arguments));
    if (twin) { twin.reported = h; h.mergedInto = twin; }
  }

  // 3. scripted case turns: clock advances / session boundaries sit between user turns
  const caseTurns = Array.isArray(context?.case?.input?.turns) ? context!.case!.input!.turns! : [];
  let ct = 0;
  const boundariesBeforeUser = (): string[] => {
    const out: string[] = [];
    while (ct < caseTurns.length) {
      const t = caseTurns[ct];
      if (t && ('say' in t || 'hitl' in t || 'wake' in t)) { ct++; break; }
      const [k, v] = Object.entries(t ?? {})[0] ?? ['turn', ''];
      if (v && typeof v === 'object') { ct++; continue; } // not a clock / session marker (e.g. a persona block)
      out.push(k === 'advance_clock' ? `clock +${String(v).replace(/^P/, '').toLowerCase()}` : k === 'new_session' || k === 'session' ? 'new session' : `${k}${v !== '' && v !== true ? ` ${String(v)}` : ''}`);
      ct++;
    }
    return out;
  };

  // 4. emit sequential nodes
  const nodes: PathNode[] = [];
  const byCall = new Map<string, PathNode>();
  let order = 0;
  const base = (kind: NodeKind, id: string, t: number, extra: Partial<PathNode>): PathNode => ({
    id, kind, order: order++, sequential: true, turn: t, label: '', signature: kind, coarse: kind, importance: 2, stepIndex: null, stepId: null, seq: null, verdicts: [], failing: false, flags: [], ...extra,
  });
  const turns: TurnInfo[] = [{ index: 0, label: 'Setup', user: null, startOrder: 0, endOrder: -1 }];
  const userSteps = steps.map((s, i) => (s.source === 'user' ? i : -1)).filter((i) => i >= 0);

  steps.forEach((s, i) => {
    const t = turnOfStep[i];
    const sx = ext(s);
    if (s.source === 'user') {
      const sp = stepPersona(s) ?? undefined;
      if (!sp) for (const b of boundariesBeforeUser()) nodes.push(base('boundary', `b${nodes.length}`, t, { label: b, boundary: b, signature: `boundary:${b}`, coarse: 'boundary', importance: 2.2, stepIndex: i }));
      const text = textOf(s.message);
      const d = decisionOf(s);
      const info: TurnInfo = { index: t, label: d ? `Turn ${t} · ${d}` : `Turn ${t}`, user: d ? null : text, decision: d ?? undefined, startOrder: order, endOrder: order };
      const prevB = nodes.length && nodes[nodes.length - 1].kind === 'boundary' ? nodes[nodes.length - 1].boundary : undefined;
      if (prevB) { info.boundary = prevB; nodes[nodes.length - 1].turn = t; info.startOrder = nodes[nodes.length - 1].order; }
      turns.push(info);
      if (d) nodes.push(base('approval_decision', `s${i}`, t, { label: d, decision: d, signature: `decision:${d}`, coarse: 'decision', importance: 3, stepIndex: i, stepId: s.step_id ?? null, text, persona: sp, flags: sp ? ['simulated'] : [] }));
      else nodes.push(base('user', `s${i}`, t, { label: short(text, 40), text, signature: `user:${hash(text.trim().toLowerCase())}`, coarse: 'user', importance: 2.4, stepIndex: i, stepId: s.step_id ?? null, persona: sp, flags: sp ? ['simulated'] : [] }));
      return;
    }
    const hr = sx.hitl_request as { tool?: string } | undefined;
    if (hr) nodes.push(base('approval_request', `s${i}-hr`, t, { label: `asks: ${hr.tool ?? 'approval'}`, via: 'hitl_request', signature: `approval_request:${hr.tool ?? ''}`, coarse: 'approval_request', importance: 3, stepIndex: i, stepId: s.step_id ?? null, text: textOf(s.message) }));
    for (const r of recs.filter((x) => x.stepIndex === i)) {
      if (r.mergedInto) continue; // drawn at its proxied twin
      const entry = cat.get(r.name);
      const k = toolClass(r.name, entry, gateClasses);
      const reportedOnly = r.source === 'host-reported';
      const unobserved = reportedOnly && !!entry && k.cls !== 'meta';
      const callIds = [r.call.tool_call_id, r.reported?.call.tool_call_id].filter((x): x is string => !!x);
      const info: ToolInfo = {
        name: r.name, wire: [r.wire, ...(r.reported ? [r.reported.wire] : [])], cls: k.cls, classes: k.classes, gated: k.gated, inCatalog: !!entry, guessed: k.guessed,
        source: r.reported ? 'both' : r.source, reportedOnly, unobserved, callIds, args: r.call.arguments ?? {}, reportedArgs: r.reported?.call.arguments, result: r.result, ok: r.ok, error: r.error,
      };
      const ah = hash(stableArgs(r.call.arguments));
      const n = base('tool', r.call.tool_call_id ?? `s${i}-c${nodes.length}`, t, {
        label: r.name, tool: info, signature: `${reportedOnly ? 'tool~' : 'tool'}:${r.name}:${ah}`, coarse: `${reportedOnly ? 'tool~' : 'tool'}:${r.name}`,
        importance: IMPORTANCE[k.cls] * (reportedOnly ? 0.85 : 1), stepIndex: i, stepId: s.step_id ?? null, seq: r.seq,
        flags: [...(unobserved ? ['unobserved'] : []), ...(reportedOnly ? ['reported-only'] : []), ...(k.gated ? ['gated'] : [])],
      });
      nodes.push(n);
      for (const id of callIds) byCall.set(id, n);
      if (r.guard) nodes.push(base('approval_request', `${n.id}-guard`, t, { label: `guard: ${r.name}`, via: 'guard', signature: `approval_request:${r.name}`, coarse: 'approval_request', importance: 3, stepIndex: i, seq: r.seq }));
    }
    const msg = textOf(s.message);
    if (msg && !(s.tool_calls?.length) && !hr) {
      const m = replyMetrics(msg, limit);
      nodes.push(base('reply', `s${i}`, t, { label: `reply · ${m.chars}ch`, text: msg, metrics: m, signature: 'reply', coarse: 'reply', importance: 3, stepIndex: i, stepId: s.step_id ?? null,
        flags: [...(m.overLimit ? ['over-limit'] : []), ...(m.claims.length ? ['claims'] : []), ...(m.questions ? ['asks'] : [])] }));
      // a reply right before an approve/reject turn, asking something, is the approval request of a chat channel
      const nextUser = userSteps.find((u) => u > i);
      const nextIsAgentReply = steps.slice(i + 1, nextUser ?? steps.length).some((x) => x.source !== 'user' && textOf(x.message) && !x.tool_calls?.length);
      if (nextUser !== undefined && decisionOf(steps[nextUser]) && !nextIsAgentReply && !nodes.some((x) => x.kind === 'approval_request' && x.turn === t)) {
        nodes.push(base('approval_request', `s${i}-ask`, t, { label: m.questions ? 'asks in chat' : 'awaits decision', via: 'chat', signature: 'approval_request:chat', coarse: 'approval_request', importance: 3, stepIndex: i, text: msg }));
      }
    }
  });
  for (const b of boundariesBeforeUser()) nodes.push(base('boundary', `b${nodes.length}`, turn, { label: b, boundary: b, signature: `boundary:${b}`, coarse: 'boundary', importance: 2.2 }));
  for (const ti of turns) {
    const own = nodes.filter((n) => n.turn === ti.index);
    if (own.length) { ti.startOrder = Math.min(ti.startOrder, own[0].order); ti.endOrder = own[own.length - 1].order; }
  }
  if (turns[0].endOrder < 0) turns.shift();

  // 5. ledger approval events: attach to the decision they record, else a node of their own at their ledger position
  const carried: number[] = [];
  let last = -1;
  for (const n of nodes) { if (n.seq !== null) last = n.seq; carried.push(last); }
  for (const ev of events) {
    const at = typeof ev.seq === 'number' ? nodes.findIndex((n) => n.seq !== null && n.seq > ev.seq!) : -1;
    const pos = at < 0 ? nodes.length : at;
    let host: PathNode | undefined;
    for (let j = pos - 1; j >= 0 && j >= pos - 4; j--) if (nodes[j].kind === 'approval_decision') { host = nodes[j]; break; }
    if (host) { (host.approvals ??= []).push(ev); continue; }
    const d = eventDecision(ev.kind);
    const t = nodes[pos - 1]?.turn ?? turn;
    const n: PathNode = { id: ev.id ?? `ap${pos}`, kind: 'approval_decision', order: 0, sequential: true, turn: t, label: `${ev.kind ?? 'approval'}`, decision: d, approvals: [ev], signature: `decision:${d}`, coarse: 'decision', importance: 3, stepIndex: null, stepId: null, seq: ev.seq ?? null, verdicts: [], failing: false, flags: ['ledger'] };
    nodes.splice(pos, 0, n);
  }
  nodes.forEach((n, i) => { n.order = i; });
  for (const ti of turns) { const own = nodes.filter((n) => n.turn === ti.index); if (own.length) { ti.startOrder = own[0].order; ti.endOrder = own[own.length - 1].order; } }

  // 6. duplicates
  const firstSeen = new Map<string, PathNode>();
  for (const n of nodes) {
    if (n.kind !== 'tool' || !n.tool) continue;
    const key = `${n.tool.name}|${stableArgs(n.tool.args)}`;
    const f = firstSeen.get(key);
    if (f) { n.dupOf = f.id; f.dupCount = (f.dupCount ?? 1) + 1; n.dupCount = f.dupCount; n.flags.push('duplicate'); }
    else firstSeen.set(key, n);
  }

  // 7. edges in execution order, then attachments
  const seqNodes = nodes.filter((n) => n.sequential);
  const edges: PathEdge[] = [];
  for (let i = 1; i < seqNodes.length; i++) edges.push({ from: seqNodes[i - 1].id, to: seqNodes[i].id, kind: 'seq' });
  const attachments: PathNode[] = [];
  for (const n of seqNodes) {
    if (n.kind === 'tool' && n.tool && !n.tool.ok) {
      const e: PathNode = { id: `${n.id}-err`, kind: 'tool_error', order: n.order, sequential: false, turn: n.turn, label: short(n.tool.error ?? 'error', 40), text: n.tool.error ?? 'error', signature: `error:${n.tool.name}`, coarse: 'error', importance: 2, stepIndex: n.stepIndex, stepId: n.stepId, seq: n.seq, attachTo: n.id, verdicts: [], failing: false, flags: [] };
      attachments.push(e);
      edges.push({ from: n.id, to: e.id, kind: 'attach' });
    }
  }

  // 8. grader verdicts
  const replies = seqNodes.filter((n) => n.kind === 'reply');
  const lastReplyOfTurn = (t: number) => [...replies].reverse().find((r) => r.turn === t);
  const findById = (id: string): PathNode | undefined => {
    const direct = byCall.get(id) ?? nodes.find((n) => n.id === id || n.approvals?.some((a) => a.id === id));
    if (direct) return direct;
    const sq = seqOf(id);
    if (sq === null) return undefined;
    // upstream writes (up_) and effects (fx_) follow the proxied call that caused them: the latest proxied
    // non-read call before that ledger position, else any proxied call
    const before = seqNodes.filter((n) => n.kind === 'tool' && n.tool && !n.tool.reportedOnly && n.seq !== null && n.seq < sq);
    const act = before.filter((n) => n.tool!.cls !== 'read' && n.tool!.cls !== 'meta');
    return (act.length ? act : before).sort((a, b) => b.seq! - a.seq!)[0];
  };
  const scores: Score[] = row?.scores ?? [];
  let failingChecks = 0;
  scores.forEach((sc, k) => {
    const label = sc.label ?? 'unknown';
    if (label !== 'pass' && label !== 'fail' && label !== 'error') return; // unscored / advisory-unknown: listed, not drawn
    const ev = (sc.evidence ?? []).filter(Boolean);
    const fromText = [...new Set((sc.explanation ?? '').match(ID_RE) ?? [])];
    let how: VerdictInfo['how'] = 'end';
    let targets: PathNode[] = [];
    if (ev.length) { targets = ev.map(findById).filter((x): x is PathNode => !!x); if (targets.length) how = 'evidence'; }
    if (!targets.length && fromText.length) { targets = fromText.map(findById).filter((x): x is PathNode => !!x); if (targets.length) how = 'explanation'; }
    if (!targets.length) {
      // a state check names a JSON pointer (/orgs/x/user_memory/caption_signoff): point at the calls whose args
      // name its last segment (the forget / remember that should have changed it)
      const segs = [...(sc.explanation ?? '').matchAll(/(?:^|\s)(\/[A-Za-z0-9_.~-]+(?:\/[A-Za-z0-9_.~-]+)+)/g)].map((m) => m[1].split('/').pop()!).filter((x) => x.length >= 4);
      const hits = seqNodes.filter((n) => n.kind === 'tool' && n.tool && n.tool.cls !== 'read' && segs.some((sg) => stableArgs(n.tool!.args).includes(`"${sg}"`)));
      if (hits.length) { targets = hits; how = 'explanation'; }
    }
    if (!targets.length) {
      const m = /\bturns?\s+(\d+)(?:\s*\.\.\s*(\d+))?/i.exec(sc.explanation ?? '');
      if (m) { const r = lastReplyOfTurn(Number(m[2] ?? m[1])); if (r) { targets = [r]; how = 'turn'; } }
    }
    if (!targets.length) { const r = replies[replies.length - 1] ?? seqNodes[seqNodes.length - 1]; if (r) targets = [r]; how = 'end'; }
    targets = [...new Set(targets)];
    const failing = (label === 'fail' || label === 'error') && !isPersonaOutcomeScore(sc);
    if (failing) failingChecks++;
    const name = (sc.name ?? sc.grader_id ?? `grader ${k}`).replace(/^ves\./, '');
    const v: PathNode = {
      id: `v${k}`, kind: 'verdict', order: targets[0]?.order ?? seqNodes.length, sequential: false, turn: targets[0]?.turn ?? turn, label: name,
      signature: `verdict:${name}:${label}`, coarse: `verdict:${name}`, importance: failing ? 2.6 : 1.6, stepIndex: null, stepId: null, seq: null, attachTo: targets[0]?.id,
      verdict: { name, label, role: sc.role ?? null, value: sc.value, explanation: sc.explanation ?? '', evidence: ev, safety: sc.safety === true, implicit: sc.implicit === true, how, targets: targets.map((x) => x.id) },
      verdicts: [], failing, flags: [],
    };
    attachments.push(v);
    for (const tg of targets) { tg.verdicts.push(v.id); if (failing) tg.failing = true; edges.push({ from: tg.id, to: v.id, kind: 'attach' }); }
  });
  if (!steps.length) notes.push('No trajectory steps recorded.');
  const all = [...nodes, ...attachments];
  const tools = nodes.filter((n) => n.kind === 'tool');
  return {
    rowId: row?.row_id ?? null, runId: row?.run_id ?? null, caseId: row?.case_id ?? context?.case?.id ?? null, caseVersion: row?.case_version ?? context?.case?.version ?? null,
    surface, trial: row?.trial ?? null, status: row?.status ?? null,
    nodes: all, edges, turns, limit,
    stats: {
      steps: steps.length, toolNodes: tools.length, duplicates: tools.filter((n) => n.dupOf).length, reportedOnly: tools.filter((n) => n.tool?.reportedOnly).length,
      unobserved: tools.filter((n) => n.tool?.unobserved).length, errors: attachments.filter((n) => n.kind === 'tool_error').length,
      actions: tools.filter((n) => n.tool && !n.tool.reportedOnly && ['write', 'gated', 'memory', 'outward', 'spend', 'destructive'].includes(n.tool.cls)).length,
      failingChecks, replies: replies.length,
    },
    notes,
  };
}

/** One line per sequential step, for the screen-reader / list alternative. */
export function describeNode(n: PathNode): string {
  switch (n.kind) {
    case 'user': return `${n.persona ? `Simulated user${n.persona.source === 'opening' ? ' (opening)' : ''}` : 'User'}: ${short(n.text ?? '', 140)}`;
    case 'reply': return `Agent reply (${n.metrics?.chars ?? 0} characters${n.metrics?.questions ? `, ${n.metrics.questions} question(s)` : ''}): ${short(n.text ?? '', 140)}`;
    case 'tool': {
      const t = n.tool!;
      return `Tool ${t.name} [${t.cls}]${t.reportedOnly ? ', reported by the agent only' : ''}${t.unobserved ? ' (never reached the backend)' : ''}${n.dupOf ? ', duplicate call' : ''}${t.ok ? '' : `, failed: ${t.error}`}`;
    }
    case 'tool_error': return `Tool error: ${n.text}`;
    case 'approval_request': return `Approval requested (${n.via === 'chat' ? 'asked in chat' : n.via === 'guard' ? 'tool guard fired' : 'structured request'})`;
    case 'approval_decision': return `Approval decision: ${n.decision}${n.approvals?.length ? ` (ledger ${n.approvals.map((a) => a.kind).join(', ')})` : ''}`;
    case 'boundary': return `Boundary: ${n.boundary}`;
    case 'verdict': return `Check ${n.verdict?.name}: ${n.verdict?.label}. ${n.verdict?.explanation ?? ''}`;
  }
}
