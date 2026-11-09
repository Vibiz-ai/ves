// MCP contract adapter (gateway/contract, mcp-direct/contract, gateway/other-sim RT-client grid): JSON-RPC 2.0 over
// MCP Streamable HTTP to a configurable URL. Model-free: the harness is the client and drives the case's oracle steps
// directly (the pattern of the reference adopter's gateway eval runner). NEVER called by the unit tests (they inject a fake `fetch`).
//
// Config (env):
//   VES_MCP_URL_GATEWAY / VES_MCP_URL_DIRECT  target MCP endpoint (local build or stub; production hosts are refused)
//   VES_MCP_TOKEN                             bearer token for a sandbox-enrolled test workspace
//   VES_MCP_CLIENT_INFO                       spoofed clientInfo.name for the RT-client grid (default 'ves-contract')
//   VES_MCP_PROTOCOL                          protocol version to request (default 2025-06-18; S0 also runs 2026-07-28)
//   VES_STUB_UPSTREAM_LOG_URL                 GET -> JSON array of upstream calls from a stub upstream server
//   VES_ALLOW_PROD_MCP=1                      allow *.vibiz.ai (never in CI; contract runs target a local build)
// Without the upstream log, G1/G2 return `error` (a check not run counts as not met, §8.1).
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { sha256, argsHash } from '../lib/hash.ts';
import { type CanonicalMap, isGated, resolveName } from '../lib/canonical.ts';
import { classifyFailure } from '../lib/classify.ts';
import { profileOf, type SurfaceProfile } from './profiles.ts';
import type {
  ApprovalEvent, ApproveDecision, AtifStep, CapabilityFlag, Collected, Fixture, InvalidReason, SayTurn, ServerCall, Session, SurfaceAdapter, TrialCtx, UpstreamWrite,
} from '../types.ts';

export type FetchLike = (url: string, init: { method: string; headers: Record<string, string>; body?: string }) => Promise<{
  status: number; headers: { get(name: string): string | null }; text(): Promise<string>;
}>;

export class McpRpcError extends Error {
  http_status?: number; code?: number;
  constructor(msg: string, http_status?: number, code?: number) { super(msg); this.http_status = http_status; this.code = code; }
}

/** Minimal MCP Streamable-HTTP JSON-RPC client: initialize, notifications/initialized, tools/list (paged), tools/call. */
export class McpHttpClient {
  url: string; fetch: FetchLike; token?: string; clientInfo: { name: string; version: string }; protocol: string;
  sessionId?: string; negotiatedProtocol?: string; serverInfo?: unknown; nextId = 1;
  constructor(o: { url: string; fetch?: FetchLike; token?: string; clientName?: string; protocol?: string }) {
    this.url = o.url; this.fetch = o.fetch ?? (globalThis.fetch as unknown as FetchLike); this.token = o.token;
    this.clientInfo = { name: o.clientName ?? 'ves-contract', version: '1.0.0' }; this.protocol = o.protocol ?? '2025-06-18';
  }
  private headers(): Record<string, string> {
    const h: Record<string, string> = { 'content-type': 'application/json', accept: 'application/json, text/event-stream' };
    if (this.token) h.authorization = `Bearer ${this.token}`;
    if (this.sessionId) h['mcp-session-id'] = this.sessionId;
    if (this.negotiatedProtocol) h['mcp-protocol-version'] = this.negotiatedProtocol;
    return h;
  }
  /** Parses a JSON body or an SSE stream (`data:` lines) and returns the response matching `id`. */
  static parseBody(text: string, contentType: string | null, id: number | null): any {
    if (contentType?.includes('text/event-stream')) {
      const msgs: any[] = [];
      for (const block of text.split(/\r?\n\r?\n/)) {
        const data = block.split(/\r?\n/).filter((l) => l.startsWith('data:')).map((l) => l.slice(5).trimStart()).join('\n');
        if (data) { try { msgs.push(JSON.parse(data)); } catch { /* keep-alive or comment */ } }
      }
      return id === null ? msgs : msgs.find((m) => m.id === id) ?? null;
    }
    if (!text.trim()) return null;
    const j = JSON.parse(text);
    return Array.isArray(j) ? j.find((m) => m.id === id) ?? null : j;
  }
  async rpc(method: string, params?: unknown, notify = false): Promise<any> {
    const id = notify ? null : this.nextId++;
    const body = JSON.stringify(notify ? { jsonrpc: '2.0', method, params } : { jsonrpc: '2.0', id, method, params });
    const res = await this.fetch(this.url, { method: 'POST', headers: this.headers(), body });
    const sid = res.headers.get('mcp-session-id');
    if (sid) this.sessionId = sid;
    const text = await res.text();
    if (res.status >= 400) throw new McpRpcError(`HTTP ${res.status} on ${method}: ${text.slice(0, 200)}`, res.status);
    if (notify) return null;
    const msg = McpHttpClient.parseBody(text, res.headers.get('content-type'), id);
    if (!msg) throw new McpRpcError(`no JSON-RPC response for ${method}`, res.status);
    if (msg.error) throw new McpRpcError(`JSON-RPC ${msg.error.code}: ${msg.error.message}`, res.status, msg.error.code);
    return msg.result;
  }
  async initialize(): Promise<any> {
    const r = await this.rpc('initialize', { protocolVersion: this.protocol, capabilities: {}, clientInfo: this.clientInfo });
    this.negotiatedProtocol = r?.protocolVersion ?? this.protocol;
    this.serverInfo = r?.serverInfo;
    await this.rpc('notifications/initialized', undefined, true);
    return r;
  }
  async listTools(): Promise<any[]> {
    const out: any[] = [];
    let cursor: string | undefined;
    for (let page = 0; page < 50; page++) {
      const r = await this.rpc('tools/list', cursor ? { cursor } : {});
      out.push(...(r?.tools ?? []));
      cursor = r?.nextCursor;
      if (!cursor) break;
    }
    return out;
  }
  callTool(name: string, args: Record<string, unknown>): Promise<any> { return this.rpc('tools/call', { name, arguments: args }); }
}

/** Reads `approval_required` from an MCP tool result (structuredContent or text content), as run.mjs does. */
export function toolError(result: any): string | undefined {
  const sc = result?.structuredContent;
  if (sc?.error) return String(sc.error);
  for (const c of result?.content ?? []) {
    if (c?.type !== 'text') continue;
    try { const j = JSON.parse(c.text); if (j?.error) return String(j.error); } catch { if (/approval_required/.test(c.text)) return 'approval_required'; }
  }
  return result?.isError ? 'tool_error' : undefined;
}

type McpSession = Session & {
  client: McpHttpClient; ctx: TrialCtx; calls: ServerCall[]; approvals: ApprovalEvent[]; steps: AtifStep[]; seq: number; started: number;
  pending?: { canonical: string; args: Record<string, unknown>; token?: string };
};

const HERE = fileURLToPath(import.meta.url);

export class McpContractAdapter implements SurfaceAdapter {
  id: string; family: SurfaceProfile['family']; version = '0.1.0';
  p: SurfaceProfile; canonical: CanonicalMap; env: Record<string, string | undefined>; fetchImpl?: FetchLike;
  constructor(o: { surface: string; canonical: CanonicalMap; env?: Record<string, string | undefined>; fetch?: FetchLike }) {
    this.id = o.surface; this.p = profileOf(o.surface); this.family = this.p.family; this.canonical = o.canonical;
    this.env = o.env ?? process.env; this.fetchImpl = o.fetch;
  }
  url(): string | undefined { return this.id.startsWith('mcp-direct/') ? this.env.VES_MCP_URL_DIRECT : this.env.VES_MCP_URL_GATEWAY; }
  capabilities(): ReadonlySet<CapabilityFlag> { return new Set(this.p.caps); }
  diffsFromProd(): string[] {
    const d = ['model-free: the harness is the MCP client and replays the case oracle; no host model'];
    if (!this.env.VES_STUB_UPSTREAM_LOG_URL) d.push('no stub-upstream log configured: upstream writes unobservable, G1/G2 report error');
    d.push('approval turns are not automatable over plain MCP (card/host click); cases with approve turns are INVALID harness_bug here');
    return d;
  }
  async routesHash(): Promise<string> { return sha256(readFileSync(HERE, 'utf8') + JSON.stringify(this.p.routes)); }
  client(): McpHttpClient {
    return new McpHttpClient({ url: this.url()!, fetch: this.fetchImpl, token: this.env.VES_MCP_TOKEN, clientName: this.env.VES_MCP_CLIENT_INFO ?? 'ves-contract', protocol: this.env.VES_MCP_PROTOCOL });
  }
  async health(): Promise<{ ok: boolean; reason?: InvalidReason; detail?: string }> {
    const url = this.url();
    if (!url) return { ok: false, reason: 'harness_bug', detail: `no MCP URL configured for ${this.id} (VES_MCP_URL_${this.id.startsWith('mcp-direct/') ? 'DIRECT' : 'GATEWAY'})` };
    if (/(^|\.)vibiz\.ai(:|\/|$)/.test(new URL(url).host) && this.env.VES_ALLOW_PROD_MCP !== '1') return { ok: false, reason: 'harness_bug', detail: 'refusing a production MCP host; contract runs target a local build or stub' };
    try { const c = this.client(); await c.initialize(); await c.listTools(); return { ok: true }; } catch (e) {
      const err = e as McpRpcError;
      return { ok: false, reason: classifyFailure({ origin: 'host', http_status: err.http_status ?? 503 }) ?? 'harness_bug', detail: err.message };
    }
  }
  async open(_f: Fixture, ctx: TrialCtx): Promise<Session> {
    const client = this.client();
    await client.initialize(); // fresh MCP session per trial
    return { id: `${ctx.runId}|${ctx.caseId}|${this.id}|${ctx.trial}`, client, ctx, calls: [], approvals: [], steps: [], seq: 0, started: Date.now() } as McpSession;
  }
  private async call(s: McpSession, canonical: string, args: Record<string, unknown>): Promise<ServerCall> {
    const tool = resolveName(this.canonical, canonical, this.id);
    if (!tool) throw new Error(`canonical id ${canonical} does not resolve on ${this.id}`);
    s.seq++;
    const call: ServerCall = { id: `call_${s.seq}`, seq: s.seq, canonical, tool, args, args_hash: argsHash(args), thread: 'thread-main', at: new Date().toISOString(), call_source: 'server', result: { ok: true }, guard_fired: false };
    try {
      const r = await s.client.callTool(tool, args);
      const err = toolError(r);
      call.result = { ok: !err, error: err, body: r };
      if (err === 'approval_required') { call.guard_fired = true; s.pending = { canonical, args }; }
    } catch (e) { call.result = { ok: false, error: (e as Error).message }; }
    s.calls.push(call);
    s.steps.push({ step_id: s.steps.length + 1, source: 'agent', tool_calls: [{ tool_call_id: call.id, function_name: tool, arguments: args, vibiz: { call_source: 'server', canonical_id: canonical } }], observation: { results: [{ source_call_id: call.id, content: call.result }] } });
    return call;
  }
  async send(sess: Session, turn: SayTurn): Promise<void> {
    const s = sess as McpSession;
    s.steps.push({ step_id: s.steps.length + 1, source: 'user', message: turn.say });
    for (const st of s.ctx.case.oracle.steps ?? []) {
      if ('reply' in st) continue;
      const c = await this.call(s, st.call, st.args);
      if (c.guard_fired && isGated(this.canonical, st.call)) break;
    }
  }
  async resolveApproval(_s: Session, d: ApproveDecision): Promise<void> {
    throw Object.assign(new Error(`approval turn '${d}' is not automatable on ${this.id} (needs card/host click); STUB`), { harness: true });
  }
  async collect(sess: Session): Promise<Collected> {
    const s = sess as McpSession;
    let upstream: UpstreamWrite[] = [];
    const logUrl = this.env.VES_STUB_UPSTREAM_LOG_URL;
    if (logUrl) {
      const f = this.fetchImpl ?? (globalThis.fetch as unknown as FetchLike);
      const r = await f(logUrl, { method: 'GET', headers: { accept: 'application/json' } });
      const rows = JSON.parse(await r.text()) as { tool: string; args?: Record<string, unknown>; invocation?: string }[];
      upstream = rows.map((x, i) => ({ id: `up_${i}`, seq: i, invocation: x.invocation ?? '', canonical: x.tool, class: 'unknown', args: x.args ?? {}, args_hash: argsHash(x.args ?? {}), thread: 'thread-main', at: new Date().toISOString() }));
    }
    return {
      atif: { schema_version: 'ATIF-v1.8', session_id: s.id, agent: { name: 'ves-contract-client', version: this.version }, steps: s.steps, vibiz: { surface: this.id, server_info: s.client.serverInfo, protocol: s.client.negotiatedProtocol } },
      serverCalls: s.calls, upstreamWrites: upstream, approvalEvents: s.approvals, sideEffects: [], snapshot: {}, delivered: [],
      usage: { wall_ms: Date.now() - s.started, usd_list: 0, tool_calls: s.calls.length },
      host: { family: 'none', protocolVersion: s.client.negotiatedProtocol, clientInfo: s.client.clientInfo.name },
      context: { canaries: [], foreignEntities: [] },
    };
  }
  /** True when this adapter can see upstream writes (drives G1/G2 error-vs-grade). */
  upstreamObserved(): boolean { return !!this.env.VES_STUB_UPSTREAM_LOG_URL; }
  async close(): Promise<void> {}
}
