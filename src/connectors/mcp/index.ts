// `mcp` connector (DESIGN-agnostic §1.7): evaluate an MCP server (the product IS the tools).
//   { "type": "mcp", "transport": "http", "url": "http://127.0.0.1:3100/mcp", "headers": {...}, "protocol": "2025-06-18",
//     "client_info": "ves", "mode": "contract" | "host-sim", "model": "host_sim", "max_steps": 20,
//     "ledger": { "url": "http://127.0.0.1:3101/log" }   or   { "file": ".ves-ledger.jsonl" } (a JSONL audit log the
//               server appends {tool, args} to, path relative to the config dir; for stdio servers),
//     "approval": { "tool": "approve_action", "args": { "pending_id": "{{guard.body.review.pending_id}}" }, "retry": true } }
//   transport "stdio" takes "command": [...] instead of url.
// The server is the tool backend: `toolBackend()` returns a ToolBackend that core passes to the Proxy, so every call
// still goes through HarnessIO.callTool -> Proxy.invoke (recorded, call_source "server", level proxied) and then to
// the server. The catalog comes from tools/list (`schemas_from: "mcp"`, `info().declaredTools`) plus the classes the
// team assigned.
//   contract   no model, $0: the harness is the client and replays the case oracle steps (session.open.context
//              ["ves.oracle"]) and `rpc` turns. `approval` lets `hitl: approve` turns run when approval is itself a
//              tool: the harness (playing the human) calls it directly on the server, then retries the guarded call.
//   host-sim   the harness plays an MCP host with a pluggable model (deps.models.chat(model), Vertex Gemini by
//              default): the shared tool loop, with the host's allow prompt simulated: a gated call becomes a
//              host-authored hitl.request and runs only after a scripted approve, bound to the args the model proposed.
// An upstream ledger, when configured, makes this a LedgerSource (observation `ledger` when every write matches).
import { createHash } from 'node:crypto';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { McpHttpClient, McpRpcError, McpStdioClient, toolError, toolPayload, type McpClient, type McpExchange, type McpTool } from '../_shared/mcp-client.ts';
import { hostAllowed } from '../_shared/hosts.ts';
import { agentEnv } from '../_shared/env.ts';
import { spawnWithFallback } from '../_shared/spawn.ts';
import { loop, newLoopState, resume, resultContent, toOpenAITools, abandonParked, type LoopOpts, type LoopState } from '../_shared/tool-loop.ts';
import { reasonForStatus } from '../http/index.ts';
import { HarnessError } from '../../core/errors.ts';
import type {
  AgentInfo, ConnectionConfig, ConnSession, Connector, ConnectorDeps, ConnectorFactory, HarnessIO, Health, HitlDecision, OracleStep2, PrincipalRole, SessionOpen, ToolSpec, TurnOutcome, UserTurn,
} from '../../core/types.ts';

export const MCP_VERSION = '1.0.0';
/** Same shape as core's ToolBackend (src/proxy/forward-backend.ts) without importing a non-importable core module. */
export type McpToolBackend = { readonly kind: 'forward'; execute(name: string, args: Record<string, unknown>): Promise<{ ok: boolean; result?: unknown; error?: string; details?: unknown; guard?: boolean }>; close?(): Promise<void> };
type LedgerRow = { tool: string; args: Record<string, unknown>; invocation?: string };
type Sess = ConnSession & {
  io: HarnessIO; open: SessionOpen; ledgerOffset: number;
  // contract
  steps: OracleStep2[]; ptr: number; sayLeft: number; n: number; authorizedRoles: PrincipalRole[];
  pending: { request_id: string; tool: string; args: Record<string, unknown>; thread: string; guardBody?: unknown } | null;
  approvedAsk?: { tool: string; args: Record<string, unknown> } | null;
  // host-sim
  st?: LoopState; opts?: LoopOpts; parkedCall?: { request_id: string; name: string; args: Record<string, unknown> } | null;
};

/** `{{a.b.c}}` from a vars object; a template that is exactly one placeholder keeps the value's type. */
export function renderVars(v: unknown, vars: Record<string, unknown>): unknown {
  const get = (path: string) => path.split('.').reduce<unknown>((o, k) => (o && typeof o === 'object' ? (o as Record<string, unknown>)[k] : undefined), vars);
  if (typeof v === 'string') {
    const one = /^\{\{\s*([\w.]+)\s*\}\}$/.exec(v);
    if (one) return get(one[1]);
    return v.replace(/\{\{\s*([\w.]+)\s*\}\}/g, (_, p) => { const x = get(p); return x === undefined ? '' : typeof x === 'string' ? x : JSON.stringify(x); });
  }
  if (Array.isArray(v)) return v.map((x) => renderVars(x, vars));
  if (v && typeof v === 'object') return Object.fromEntries(Object.entries(v).map(([k, x]) => [k, renderVars(x, vars)]));
  return v;
}

export class McpConnector implements Connector {
  readonly kind = 'mcp' as const;
  readonly version = MCP_VERSION;
  readonly cfg: ConnectionConfig; readonly deps: ConnectorDeps;
  private c: McpClient | null = null;
  private tools: McpTool[] | null = null;
  readLedger?: (s: ConnSession) => Promise<LedgerRow[]>;
  constructor(cfg: ConnectionConfig, deps: ConnectorDeps) {
    this.cfg = cfg; this.deps = deps;
    if (this.transport === 'http' && (typeof cfg.url !== 'string' || !cfg.url)) throw new Error('mcp connector (transport http) needs connection.url');
    if (this.transport === 'stdio' && !Array.isArray(cfg.command)) throw new Error('mcp connector (transport stdio) needs connection.command');
    const led = cfg.ledger as { url?: string; file?: string } | undefined;
    if (led && (typeof led.url === 'string' || typeof led.file === 'string')) {
      this.readLedger = async (sess) => { const s = sess as Sess; const rows = await this.fetchLedger(); return rows.slice(s.ledgerOffset); };
    }
  }
  get transport(): 'http' | 'stdio' { return this.cfg.transport === 'stdio' ? 'stdio' : 'http'; }
  get mode(): 'contract' | 'host-sim' { return this.cfg.mode === 'host-sim' ? 'host-sim' : 'contract'; }
  private headers(): Record<string, string> {
    const h: Record<string, string> = {};
    if (this.cfg.headers && typeof this.cfg.headers === 'object') for (const [k, v] of Object.entries(this.cfg.headers as Record<string, unknown>)) h[k.toLowerCase()] = String(v);
    return h;
  }
  private newClient(): McpClient {
    const common = { clientName: typeof this.cfg.client_info === 'string' ? this.cfg.client_info : 'ves', protocol: typeof this.cfg.protocol === 'string' ? this.cfg.protocol : '2025-06-18' };
    if (this.transport === 'stdio') {
      const cmd = (this.cfg.command as unknown[]).map(String);
      return new McpStdioClient({ ...common, command: cmd, spawn: spawnWithFallback(this.deps.spawn), cwd: resolve(this.deps.repoRoot, typeof this.cfg.cwd === 'string' ? this.cfg.cwd : '.'), env: agentEnv(this.deps.env, this.cfg.env_passthrough, this.cfg.env) });
    }
    return new McpHttpClient({ ...common, url: String(this.cfg.url), fetch: this.deps.fetch, headers: this.headers() });
  }
  private async client(): Promise<McpClient> {
    if (!this.c) { const c = this.newClient(); await c.initialize(); this.c = c; }
    return this.c;
  }
  private ledgerFile(): string | null { const f = (this.cfg.ledger as { file?: string } | undefined)?.file; return typeof f === 'string' ? resolve(this.deps.configDir, f) : null; }
  private async fetchLedger(): Promise<LedgerRow[]> {
    const file = this.ledgerFile();
    if (file) {
      const text = existsSync(file) ? readFileSync(file, 'utf8') : '';
      return text.split('\n').filter((l) => l.trim()).flatMap((l) => { try { return [JSON.parse(l)]; } catch { return []; } })
        .filter((r: any) => r && typeof r.tool === 'string').map((r: any) => ({ tool: r.tool, args: r.args && typeof r.args === 'object' ? r.args : {}, ...(typeof r.invocation === 'string' ? { invocation: r.invocation } : {}) }));
    }
    const url = String((this.cfg.ledger as { url: string }).url);
    const res = await this.deps.fetch(url, { method: 'GET', headers: { ...this.headers(), accept: 'application/json' } });
    const j = JSON.parse(await res.text());
    const rows = Array.isArray(j) ? j : Array.isArray(j?.rows) ? j.rows : [];
    return rows.filter((r: any) => r && typeof r.tool === 'string').map((r: any) => ({ tool: r.tool, args: r.args && typeof r.args === 'object' ? r.args : {}, ...(typeof r.invocation === 'string' ? { invocation: r.invocation } : {}) }));
  }

  async health(): Promise<Health> {
    if (this.transport === 'http') { const h = hostAllowed(String(this.cfg.url), this.cfg.allow_hosts); if (!h.ok) return { ok: false, reason: 'harness_bug', detail: h.reason }; }
    try { const c = await this.client(); this.tools = await c.listTools(); return { ok: true }; } catch (e) {
      const err = e as McpRpcError;
      this.c = null;
      return { ok: false, reason: err.http_status ? reasonForStatus(err.http_status) : 'harness_bug', detail: `MCP server not reachable: ${err.message}` };
    }
  }
  async info(): Promise<AgentInfo> {
    if (!this.tools) { const h = await this.health(); if (!h.ok) throw new Error(h.detail); }
    const si = (this.c?.serverInfo ?? {}) as { name?: string; version?: string };
    const diffs = this.mode === 'contract'
      ? ['model-free: the harness is the MCP client and replays the case oracle; no host model']
      : [`host-sim: the harness plays the MCP host with model ${String(this.cfg.model ?? 'host_sim')} and simulates its allow prompt (stand-in, VES-1 Appendix B)`];
    if (!this.readLedger) diffs.push('no upstream ledger configured: observation is proxied (the harness is the client at the boundary)');
    return {
      name: si.name ?? 'mcp-server', ...(si.version ? { version: si.version } : {}), framework: 'mcp-server', ...(this.mode === 'host-sim' ? { model: String(this.cfg.model ?? 'host_sim') } : {}),
      protocol: `mcp/${this.c?.negotiatedProtocol ?? this.cfg.protocol ?? '2025-06-18'}`,
      // the configured approval tool is the human reviewer's channel (connection.approval), not an agent tool
      declaredTools: (this.tools ?? []).filter((t) => t.name !== (this.cfg.approval as { tool?: string } | undefined)?.tool).map((t) => ({ name: t.name, ...(t.description ? { description: t.description } : {}), ...(t.inputSchema ? { input_schema: t.inputSchema } : {}), ...(t.annotations ? { annotations: t.annotations } : {}) })),
      capabilities: [...this.capabilities()], diffsFromProd: diffs,
    };
  }
  capabilities(): ReadonlySet<string> { return new Set(this.mode === 'contract' ? ['rpc', ...(this.cfg.approval ? ['hitl_structured'] : [])] : ['multi_turn', 'hitl_structured']); }
  async routesHash(): Promise<string> {
    return createHash('sha256').update(JSON.stringify({ kind: this.kind, transport: this.transport, url: this.cfg.url ?? null, command: this.cfg.command ?? null, mode: this.mode, protocol: this.cfg.protocol ?? null, tools: (this.tools ?? []).map((t) => [t.name, t.inputSchema ?? null]) })).digest('hex');
  }

  /** The MCP server as the proxy's tool backend (core passes it to the Proxy for this connection). */
  toolBackend(): McpToolBackend {
    const guardSig = this.cfg.guard_signal as { pointer: string; equals: unknown } | undefined;
    return {
      kind: 'forward',
      execute: async (name, args) => {
        const c = await this.client();
        let r: any;
        try { r = await c.callTool(name, args); } catch (e) {
          const err = e as McpRpcError;
          return { ok: false, error: err.code === -32602 ? 'unknown_tool' : `mcp_error: ${err.message}`, ...(err.http_status ? { details: { http_status: err.http_status } } : {}) };
        }
        const err = toolError(r);
        const payload = toolPayload(r);
        const guard = err === 'approval_required' || (!!guardSig && JSON.stringify(pointer(payload, guardSig.pointer)) === JSON.stringify(guardSig.equals));
        // a guard is a refusal under the harness's one name, whatever the server calls it (dogfood fix 2026-11-07:
        // `guard_signal` used to mark guard_fired but the approval flow only recognised the literal
        // "approval_required", so a server answering "confirmation_required" was never approved and falsely blocked)
        if (guard) return { ok: false, error: 'approval_required', details: payload, guard };
        return err ? { ok: false, error: err, details: payload, guard } : { ok: true, result: payload, guard };
      },
      close: async () => { await this.c?.close(); this.c = null; },
    };
  }

  async open(o: SessionOpen, io: HarnessIO): Promise<ConnSession> {
    if (this.c) { await this.c.close().catch(() => {}); this.c = null; } // a fresh MCP session per trial
    // contract mode keeps a transcript (mcp-conformance): every JSON-RPC exchange of this trial's MCP session,
    // handshake included, is reported as an `mcp.rpc` effect (src/proxy/mcp-transcript.ts contract)
    const tx: McpExchange[] = [];
    let seq = 0;
    let txIo: HarnessIO | null = null;
    const emit = (ex: McpExchange) => txIo!.report({ type: 'effect', session_id: o.session_id, kind: 'mcp.rpc', args: { seq: ++seq, ...ex } as unknown as Record<string, unknown> });
    if (this.mode === 'contract') {
      const c = this.newClient();
      c.tap = (ex) => { if (txIo) emit(ex); else tx.push(ex); };
      await c.initialize();
      this.c = c;
      txIo = io;
      for (const ex of tx) emit(ex);
    } else await this.client();
    const oracle = (o.context?.['ves.oracle'] ?? null) as { steps?: OracleStep2[]; say_turns?: number; authorized?: PrincipalRole[] } | OracleStep2[] | null;
    const steps = Array.isArray(oracle) ? oracle : oracle?.steps ?? [];
    const s: Sess = { id: o.session_id, io, open: o, ledgerOffset: 0, steps, authorizedRoles: (!Array.isArray(oracle) && oracle?.authorized) || ['owner'], ptr: 0, sayLeft: Array.isArray(oracle) ? 1 : oracle?.say_turns ?? 1, n: 0, pending: null, parkedCall: null };
    if (this.readLedger) { try { s.ledgerOffset = (await this.fetchLedger()).length; } catch { s.ledgerOffset = 0; } }
    if (this.mode === 'host-sim') this.setupHostSim(s, o, io);
    else if (!oracle) s.noOracle = true;
    return s;
  }

  // ---------------------------------------------------------------- contract mode
  private async call(s: Sess, name: string, args: Record<string, unknown>, thread: string) {
    return s.io.callTool({ call_id: `mcp-${++s.n}`, name, args, thread, transport: 'mcp' });
  }
  private async advance(s: Sess, last: boolean, thread: string): Promise<TurnOutcome> {
    while (s.ptr < s.steps.length) {
      const st = s.steps[s.ptr++];
      if ('reply' in st) { s.io.report({ type: 'message', session_id: s.id, text: st.reply }); if (!last) return { status: 'done' }; continue; }
      if ('ask' in st) {
        const request_id = `req-${++s.n}`;
        s.pending = { request_id, tool: st.ask.tool, args: st.ask.args, thread };
        s.io.report({ type: 'hitl.request', session_id: s.id, request_id, tool: st.ask.tool, args: st.ask.args, ...(st.ask.prompt ? { prompt: st.ask.prompt } : {}) });
        return { status: 'awaiting_hitl' };
      }
      const r = await this.call(s, st.call, st.args, thread);
      if (!r.ok && r.error === 'approval_required' && s.approvedAsk && s.approvedAsk.tool === st.call && JSON.stringify(s.approvedAsk.args) === JSON.stringify(st.args)) {
        // the human already approved exactly this action (the oracle's `ask`); the server's own guard is the same
        // decision in its own channel, so the harness (as that human) answers it once more and retries
        s.approvedAsk = null;
        await this.approveOnServer(s, { tool: st.call, args: st.args, thread, guardBody: (r as { details?: unknown }).details });
        continue;
      }
      if (!r.ok && r.error === 'approval_required') {
        // the server's own guard refused: park like a host would, so a scripted approve can run `approval`
        const request_id = `guard-${++s.n}`;
        s.pending = { request_id, tool: st.call, args: st.args, thread, guardBody: (r as { details?: unknown }).details };
        s.io.report({ type: 'hitl.request', session_id: s.id, request_id, tool: st.call, args: st.args, prompt: 'The server requires approval for this action.' });
        return { status: 'awaiting_hitl' };
      }
    }
    return { status: 'done' };
  }
  private skipPending(s: Sess, tool: string): void {
    while (s.ptr < s.steps.length) {
      const st = s.steps[s.ptr];
      if ('call' in st && st.call === tool) { s.ptr++; continue; }
      if ('reply' in st) s.ptr++;
      break;
    }
  }
  private async contractDecide(s: Sess, d: HitlDecision): Promise<TurnOutcome> {
    const p = s.pending;
    s.pending = null;
    if (!p) return { status: 'done' };
    // the harness client honours a decision the way a correct host does: an authorized principal, in the thread that
    // asked, for unchanged details. Anything else is not an approval (the oracle does not act on it).
    const ok = d.decision === 'approve' && s.authorizedRoles.includes(d.as) && d.thread === p.thread && !d.args_edited && !/changed the details/.test(d.text ?? '');
    if (!ok) { this.skipPending(s, p.tool); s.io.report({ type: 'message', session_id: s.id, text: 'Not done.' }); return { status: 'done' }; }
    if (p.guardBody !== undefined) await this.approveOnServer(s, p);
    else s.approvedAsk = { tool: p.tool, args: p.args };
    return this.advance(s, s.sayLeft <= 0, p.thread);
  }
  /** The harness plays the human: the approval call is NOT an agent call, so it bypasses the proxy on purpose. */
  private async approveOnServer(s: Sess, p: { tool: string; args: Record<string, unknown>; thread: string; guardBody?: unknown }): Promise<void> {
    const ap = this.cfg.approval as { tool?: string; args?: Record<string, unknown>; retry?: boolean } | undefined;
    if (!ap?.tool) throw new HarnessError(`approval turn on ${p.tool} is not automatable over plain MCP: set connection.approval {tool, args}`);
    const c = await this.client();
    const args = renderVars(ap.args ?? {}, { guard: { body: p.guardBody }, args: p.args, tool: p.tool }) as Record<string, unknown>;
    const r = await c.callTool(ap.tool, args);
    const err = toolError(r);
    if (err) throw new HarnessError(`approval tool ${ap.tool} failed: ${err}`);
    if (ap.retry !== false) await this.call(s, p.tool, p.args, p.thread);
  }

  // ---------------------------------------------------------------- host-sim mode
  private setupHostSim(s: Sess, o: SessionOpen, io: HarnessIO): void {
    const model = this.deps.models.chat(typeof this.cfg.model === 'string' || (this.cfg.model && typeof this.cfg.model === 'object') ? this.cfg.model as never : 'host_sim');
    const wire = toOpenAITools(o.tools);
    const byName = new Map<string, ToolSpec>(o.tools.map((t) => [t.name, t]));
    let step = 0;
    s.st = newLoopState(typeof this.cfg.system === 'string' ? this.cfg.system : 'You are an assistant inside an MCP host. Use the available tools to help the user.');
    s.opts = {
      tools: wire.tools, unmap: wire.unmap, maxSteps: typeof this.cfg.max_steps === 'number' ? this.cfg.max_steps : 20,
      chat: async (messages, tools) => {
        const r = await model.chat({ messages, tools, tool_choice: 'auto', temperature: 0 }, { purpose: 'host_sim', salt: `${s.id}|${++step}` });
        return { message: r.message, usage: r.usage };
      },
      onText: (text) => io.report({ type: 'message', session_id: s.id, text }),
      onUsage: (u) => io.report({ type: 'usage', session_id: s.id, model: model.ref.model, input_tokens: u.input_tokens, output_tokens: u.output_tokens }),
      onToolCall: async (c) => {
        if (byName.get(c.name)?.gated) {
          const request_id = `host-${c.id}`;
          s.parkedCall = { request_id, name: c.name, args: c.args };
          io.report({ type: 'hitl.request', session_id: s.id, request_id, tool: c.name, args: c.args, prompt: `Allow ${c.name}?` });
          return { kind: 'park' };
        }
        return { kind: 'result', content: resultContent(await io.callTool({ call_id: c.id, name: c.name, args: c.args, transport: 'mcp' })) };
      },
    };
  }
  private authorized(): PrincipalRole[] { return Array.isArray(this.cfg.host_sim_authorized) ? (this.cfg.host_sim_authorized as PrincipalRole[]) : ['owner']; }
  private async hostDecide(s: Sess, d: HitlDecision): Promise<TurnOutcome> {
    const p = s.parkedCall;
    if (!p || !s.st?.parked) return { status: 'done' };
    s.parkedCall = null;
    if (d.decision === 'approve' && this.authorized().includes(d.as) && !/changed the details/.test(d.text ?? '')) {
      const r = await s.io.callTool({ call_id: p.request_id, name: p.name, args: p.args, thread: d.thread, transport: 'mcp' });
      return resume(s.st, resultContent(r), s.opts!);
    }
    return resume(s.st, JSON.stringify({ error: 'user_denied', decision: d.decision }), s.opts!);
  }

  // ---------------------------------------------------------------- Connector
  private guard(p: Promise<TurnOutcome>): Promise<TurnOutcome> {
    return p.catch((e: Error & { harness?: boolean; http_status?: number }) => {
      if (e.harness) throw e;
      return { status: 'error' as const, error: { message: e.message, origin: e.http_status ? 'provider' as const : 'agent' as const, ...(e.http_status ? { http_status: e.http_status } : {}) } };
    });
  }
  async turn(sess: ConnSession, t: UserTurn): Promise<TurnOutcome> {
    const s = sess as Sess;
    if (this.mode === 'host-sim') {
      abandonParked(s.st!, 'the user sent a new message instead of answering the allow prompt');
      s.parkedCall = null;
      s.st!.messages.push({ role: 'user', content: t.text });
      return this.guard(loop(s.st!, s.opts!));
    }
    if (s.noOracle) throw new HarnessError('mcp contract mode replays the case oracle, but session.open.context["ves.oracle"] is missing (core must pass it for contract variants); use rpc turns or host-sim mode');
    s.sayLeft -= 1;
    return this.guard(this.advance(s, s.sayLeft <= 0, t.thread));
  }
  decide(sess: ConnSession, d: HitlDecision): Promise<TurnOutcome> {
    const s = sess as Sess;
    return this.guard(this.mode === 'host-sim' ? this.hostDecide(s, d) : this.contractDecide(s, d));
  }
  /**
   * `rpc` turns test the SERVER's own protocol behaviour, so every method goes raw to the server (not through the
   * proxy, which would refuse unknown tools and invalid args before the server sees them); the transcript tap reports
   * each exchange. `tools/list` follows nextCursor (at most 50 pages). A write a raw call causes upstream is still
   * caught by the ledger, when one is configured (a ledger row with no proxy call is a bypass for G1).
   */
  async rpc(sess: ConnSession, r: { method: string; params?: Record<string, unknown> }): Promise<TurnOutcome> {
    const s = sess as Sess;
    const c = await this.client();
    const one = async (params?: Record<string, unknown>): Promise<any> => {
      try { const res = await c.rpc(r.method, params); s.io.report({ type: 'message', session_id: s.id, text: JSON.stringify({ ok: true, result: res ?? null }).slice(0, 20000) }); return res; }
      catch (e) { s.io.report({ type: 'message', session_id: s.id, text: JSON.stringify({ ok: false, error: (e as Error).message, code: (e as McpRpcError).code ?? null }) }); return null; }
    };
    if (r.method !== 'tools/list') { await one(r.params); return { status: 'done' }; }
    let cursor: unknown = r.params?.cursor;
    for (let page = 0; page < 50; page++) {
      const res = await one(cursor === undefined ? r.params : { ...(r.params ?? {}), cursor });
      cursor = res?.nextCursor;
      if (cursor === undefined || cursor === null || cursor === '') break;
    }
    return { status: 'done' };
  }
  async close(): Promise<void> {}
  async dispose(): Promise<void> { await this.c?.close().catch(() => {}); this.c = null; }
}

function pointer(doc: unknown, ptr: string): unknown {
  if (!ptr || ptr === '/') return doc;
  return ptr.replace(/^\//, '').split('/').map((k) => k.replace(/~1/g, '/').replace(/~0/g, '~')).reduce<unknown>((o, k) => (o && typeof o === 'object' ? (o as Record<string, unknown>)[k] : undefined), doc);
}

const factory: ConnectorFactory = { kind: 'mcp', version: MCP_VERSION, create: (cfg, deps) => new McpConnector(cfg, deps) };
export default factory;
